// POST /api/admin/conversations/bot-handoff
// บอทเรียก endpoint นี้เมื่อถึงจุดส่งต่อแอดมิน (warranty claim flow)
// ทำ 3 อย่าง:
//   1. handoff conversation ให้แอดมิน (auto-assign round-robin)
//   2. บันทึก claim info ลง conversation metadata
//   3. log admin event
//
// ⚠️ ใช้ internal secret auth (X-Internal-Secret) ไม่ต้อง admin login
// เพราะบอทเป็น internal service ไม่ใช่ user
import { NextRequest } from "next/server";
import { json, error, readJson } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";
import { handoffService, handoffOutcomeHttpStatus, type HandoffOutcome } from "@/backend/service/handoffService";
import { conversationService } from "@/backend/service/conversationService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
// ⚡ G-fix — invalidate botworker cache ด้วย
async function invalidateBotworkerCache() {
  try {
    const mod = await import("@/app/api/botworker/conversations/route");
    if (typeof (mod as unknown as { invalidateBotworkerCache?: () => void }).invalidateBotworkerCache === "function") {
      (mod as unknown as { invalidateBotworkerCache: () => void }).invalidateBotworkerCache();
    }
  } catch { /* ignore */ }
}
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
// ⚡ Phase 2J — simulate mode ใช้ test_status_conversation แทน test_chat_sessions
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";

export const dynamic = "force-dynamic";

interface BotHandoffBody {
  conversation_id: string;
  shop_id?: string;
  platform?: string;
  reason?: string;
  simulate?: boolean; // ⚡ simulate mode — เก็บลง test_chat_sessions ไม่กระทบ conversations
  test_source?: string; // ⚡ parallel sandbox — "botworker" ฯลฯ → เขียน test_status_conversation[source]
  claim?: {
    customer_name?: string;
    customer_phone?: string;
    order_id?: string;
    claim_topic?: string;
    product_name?: string;
    warranty_status?: "in_warranty" | "out_of_warranty";
    purchase_date?: string;
    warranty_months?: number;
    expiry_date?: string;
  };
}

export async function POST(req: NextRequest) {
  // Auth: internal secret (บอทเป็น internal service)
  const secret = req.headers.get("x-internal-secret");
  if (!secret || secret !== serverConfig.chatbotInternalSecret) {
    return error("unauthorized — internal secret required", 401);
  }

  // 🔒 IP allowlist (optional) — ถ้าตั้ง BOT_HANDOFF_ALLOWED_IPS จะกรองเฉพาะ IP ที่อนุญาต
  // รูปแบบ: comma-separated, เช่น "127.0.0.1,10.0.0.5,::1"
  // ถ้าไม่ตั้ง = อนุญาตทุก IP (backward compat — ใช้ secret อย่างเดียว)
  const allowedIps = process.env.BOT_HANDOFF_ALLOWED_IPS;
  if (allowedIps) {
    const xff = req.headers.get("x-forwarded-for");
    const xri = req.headers.get("x-real-ip");
    const clientIp = (xff ? xff.split(",")[0].trim() : xri || "").trim();
    const allowlist = allowedIps.split(",").map((ip) => ip.trim()).filter(Boolean);
    if (!allowlist.includes(clientIp)) {
      console.warn(`[bot-handoff] rejected IP: ${clientIp || "(unknown)"}`);
      return error("unauthorized — IP not allowed", 401);
    }
  }

  const body = await readJson<BotHandoffBody>(req);
  if (!body || !body.conversation_id) {
    return error("conversation_id is required", 422);
  }

  // 🔒 ป้องกัน NoSQL injection — coerce ค่าจาก body เป็น string เสมอ
  const conversation_id = String(body.conversation_id);
  const reason = body.reason != null ? String(body.reason) : undefined;
  const claim = body.claim;
  const simulate = body.simulate === true;
  const shopId = body.shop_id != null ? String(body.shop_id) : undefined;
  const platform = body.platform != null ? String(body.platform) : undefined;

  // ⚡ botworker parallel — test_source ระบุ sandbox source ของ test_status_conversation
  //   validate ให้เป็น TestSource ที่รู้จักเท่านั้น (กันเขียน source แปลก)
  const TEST_SOURCES = ["botworker", "test_chat", "shadowbot", "replay_compare", "test_assignment"] as const;
  type TestSource = (typeof TEST_SOURCES)[number];
  const testSource: TestSource | undefined =
    body.test_source && (TEST_SOURCES as readonly string[]).includes(body.test_source)
      ? (body.test_source as TestSource)
      : undefined;
  if (body.test_source && !testSource) {
    return error(`invalid test_source: ${body.test_source}`, 422);
  }

  // ⚡ uniform typed truth — test/simulate paths ต้องคืน outcome เดียวกับ production
  //   (Python อ่าน outcome.state เท่านั้น ไม่ derive จาก ok/compat fields)
  //   in_flight = claim/op พิสูจน์ไม่ได้ → failed retryable (503) ไม่ใช่ queued โกหก
  const testOutcome = (r: {
    assignedTo: string | null; assignedToName: string | null;
    reopened: boolean; assignmentReason: string; in_flight?: boolean;
  }): HandoffOutcome =>
    r.in_flight
      ? { state: "failed", assigned_to: null, assigned_to_name: null, persisted: false,
          reason: r.assignmentReason, error_code: "in_flight", reopened: false,
          emit_incomplete: false }
      : r.assignedTo
        ? { state: "assigned", assigned_to: r.assignedTo, assigned_to_name: r.assignedToName,
            persisted: true, reason: r.assignmentReason, error_code: null,
            reopened: r.reopened, emit_incomplete: false }
        : { state: "queued", assigned_to: null, assigned_to_name: null,
            persisted: true, reason: "no_available_admin", error_code: null,
            reopened: r.reopened, emit_incomplete: false };

  // ⚡ parallel sandbox path — test_source มี → เขียน test_status_conversation[source] เท่านั้น
  //   ไม่แตะ status_conversation/conversations จริง; claim → bot_claim_info บน test doc
  if (testSource) {
    const result = await handoffService.handoffToAdminTest({
      conversationId: conversation_id,
      shopId: shopId || "",
      platform: platform || "shopee",
      reason: reason || "sandbox handoff",
      source: testSource,
      assignedStatus: testSource === "botworker" ? "open" : "handoff",
    });
    // ⚡ classify outcome ก่อน side effects — failed/in_flight ต้อง return non-2xx
    //   ก่อนเขียน claim metadata / success audit / cache invalidation
    const tOutcome = testOutcome(result);
    const tBody = {
      ok: tOutcome.state !== "failed",
      simulate: true,
      test_source: testSource,
      outcome: tOutcome,
      assigned_to: result.assignedTo,
      assigned_to_name: result.assignedToName,
      reopened: result.reopened,
      assignment_reason: result.assignmentReason,
    };
    if (tOutcome.state === "failed") {
      return json(tBody, handoffOutcomeHttpStatus(tOutcome));
    }
    // claim info → bot_claim_info บน test doc (แทน test_chat_sessions/conversations)
    if (claim && Object.keys(claim).length > 0) {
      try {
        const coll = await getCollection<{ conversation_id: string; source: string }>(COLLECTIONS.testStatusConversation);
        await coll.updateOne(
          { conversation_id, source: testSource },
          { $set: { bot_claim_info: claim, bot_handoff_at: new Date(), bot_handoff_reason: reason || "warranty_claim", updated_at: new Date() } },
          { upsert: true }
        );
      } catch (e) {
        console.error("[bot-handoff:test] failed to save claim info:", e);
      }
    }
    // log — botworker source → botworker_events; source อื่น → admin_logs (เดิม)
    if (testSource === "botworker") {
      const { logBotworkerEvent } = await import("@/backend/service/botworkerEventService");
      await logBotworkerEvent({
        conversation_id,
        type: "bot_handoff",
        actor: "bot",
        shop_id: shopId,
        platform,
        metadata: { assigned_to: result.assignedTo, reason, assignment_reason: result.assignmentReason, claim },
      });
    } else {
      await logAdminEvent({
        action_type: "conversation.handoff",
        actor: "bot",
        conversation_id,
        metadata: { assigned_to: result.assignedTo, reason, assignment_reason: result.assignmentReason, test_source: testSource, claim },
      });
    }
    invalidateBotworkerCache();
    return json(tBody, handoffOutcomeHttpStatus(tOutcome));
  }

  // ⚡ Phase 2J — Simulate mode ใช้ test_status_conversation (ไม่กระทบ status_conversation จริง)
  //   ใช้ round-robin จริง (cursor ขยับจริง) แต่เก็บใน test_status_conversation
  if (simulate) {
    const result = await handoffService.handoffToAdminTest({
      conversationId: conversation_id,
      shopId: shopId || "",
      platform: platform || "shopee",
      reason: reason || "simulate handoff",
      source: "test_chat",
    });
    // ⚡ classify outcome ก่อน side effects — failed/in_flight return non-2xx ก่อน claim write
    const sOutcome = testOutcome(result);
    const sBody = {
      ok: sOutcome.state !== "failed",
      simulate: true,
      outcome: sOutcome,
      assigned_to: result.assignedTo,
      assigned_to_name: result.assignedToName,
      reopened: result.reopened,
      assignment_reason: result.assignmentReason,
    };
    if (sOutcome.state === "failed") {
      return json(sBody, handoffOutcomeHttpStatus(sOutcome));
    }
    // เก็บ claim info ลง test_chat_sessions เหมือนเดิม (ถ้ามี)
    if (claim && Object.keys(claim).length > 0) {
      try {
        const { ObjectId } = await import("mongodb");
        type TestChatSessionClaimDoc = { _id: typeof ObjectId.prototype; bot_claim_info?: unknown; bot_handoff_at?: Date };
        const sessionColl = await getCollection<TestChatSessionClaimDoc>(COLLECTIONS.testChatSessions);
        await sessionColl.updateOne(
          { _id: new ObjectId(conversation_id) as never },
          { $set: { bot_claim_info: claim, bot_handoff_at: new Date() } as never }
        );
      } catch { /* ignore */ }
    }
    return json(sBody, handoffOutcomeHttpStatus(sOutcome));
  }

  // ดึง conversation เพื่อหา shop_id/platform
  const conv = await conversationService.getConversation(conversation_id);
  if (!conv) {
    return error("conversation not found", 404);
  }

  // 1. Handoff ให้แอดมิน — typed outcome จาก persisted state เท่านั้น
  //    (assigned|queued|failed — caller ห้าม derive success จาก ok:true)
  const outcome = await handoffService.handoffToAdmin({
    conversationId: conversation_id,
    shopId: conv.shop_id,
    platform: conv.platform,
    reason: reason || "warranty claim — bot handoff",
  });

  // ⚡ failed/emit_incomplete ห้าม 2xx — Python transport ต้องเห็น retryable signal
  const httpStatus = handoffOutcomeHttpStatus(outcome);
  const respBody = {
    ok: httpStatus < 300,
    // ⚡ Phase 2B.2 — authoritative typed outcome (persisted state เท่านั้น)
    outcome,
    // compat fields — derive จาก outcome (Phase 2B.3 จะให้ Python อ่าน outcome โดยตรง)
    assigned_to: outcome.assigned_to,
    assigned_to_name: outcome.assigned_to_name,
    reopened: outcome.reopened,
    assignment_reason: outcome.reason,
  };

  // ⚡ failed → non-2xx ก่อน success metadata/cache side effects
  //   (claim/handoff fields สื่อว่า handoff สำเร็จ — emit_incomplete ownership
  //    persisted แล้วจึงเดิน path นี้ได้: claim metadata refresh ซ้ำได้อย่างปลอดภัยตอน retry)
  if (outcome.state === "failed") {
    return json(respBody, httpStatus);
  }

  // 2. บันทึก claim info ลง conversation metadata
  if (claim && Object.keys(claim).length > 0) {
    try {
      const coll = await getCollection<{ conversation_id: string; bot_claim_info?: unknown }>(
        COLLECTIONS.conversations
      );
      await coll.updateOne(
        { conversation_id },
        {
          $set: {
            bot_claim_info: claim,
            // last write/refresh time ของ claim metadata — ไม่ใช่ ownership authority
            bot_handoff_at: new Date(),
            bot_handoff_reason: reason || "warranty_claim",
          },
        }
      );
    } catch (e) {
      // ไม่ fatal — log แล้วทำต่อ
      console.error("[bot-handoff] failed to save claim info:", e);
    }
  }

  // audit = handoffService owner เดียว (committed outcomes เท่านั้น) — route ไม่ log ซ้ำ

  invalidateConversationsCache();
  invalidateBotworkerCache();

  // ส่งแจ้งเตือน (best-effort — ถ้ามี notification service)
  // TODO: เชื่อมกับ notification service (telegram/line/email) ถ้ามี
  // ตอนนี้ log ไว้ก่อน
  // 🔒 ไม่ log PII (assigned_to_name, reason) ไปยัง stdout — audit log ใน DB พอแล้ว
  console.log(`[bot-handoff] conversation=${conversation_id} outcome=${outcome.state} assigned_to=${outcome.assigned_to} reason=${outcome.reason}`);

  return json(respBody, httpStatus);
}
