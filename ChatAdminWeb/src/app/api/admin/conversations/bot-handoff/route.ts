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
import { handoffService } from "@/backend/service/handoffService";
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
    return json({
      ok: true,
      simulate: true,
      test_source: testSource,
      assigned_to: result.assignedTo,
      assigned_to_name: result.assignedToName,
      reopened: result.reopened,
      assignment_reason: result.assignmentReason,
    });
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
    return json({
      ok: true,
      simulate: true,
      assigned_to: result.assignedTo,
      assigned_to_name: result.assignedToName,
      reopened: result.reopened,
      assignment_reason: result.assignmentReason,
    });
  }

  // ดึง conversation เพื่อหา shop_id/platform
  const conv = await conversationService.getConversation(conversation_id);
  if (!conv) {
    return error("conversation not found", 404);
  }

  // 1. Handoff ให้แอดมิน (assign คืน admin เดิมก่อน ถ้าไม่มี → round-robin)
  const result = await handoffService.handoffToAdmin({
    conversationId: conversation_id,
    shopId: conv.shop_id,
    platform: conv.platform,
    reason: reason || "warranty claim — bot handoff",
  });

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

  // 3. Log admin event
  await logAdminEvent({
    action_type: "conversation.handoff",
    actor: "bot",
    conversation_id,
    metadata: {
      assigned_to: result.assignedTo,
      assigned_to_name: result.assignedToName,
      reopened: result.reopened,
      reason,
      assignment_reason: result.assignmentReason,
      claim,
    },
  });

  invalidateConversationsCache();
  invalidateBotworkerCache();

  // 4. ส่งแจ้งเตือน (best-effort — ถ้ามี notification service)
  // TODO: เชื่อมกับ notification service (telegram/line/email) ถ้ามี
  // ตอนนี้ log ไว้ก่อน
  // 🔒 ไม่ log PII (assigned_to_name, reason) ไปยัง stdout — audit log ใน DB พอแล้ว
  console.log(`[bot-handoff] conversation=${conversation_id} assigned_to=${result.assignedTo} assignment_reason=${result.assignmentReason}`);

  return json({
    ok: true,
    assigned_to: result.assignedTo,
    assigned_to_name: result.assignedToName,
    reopened: result.reopened,
    assignment_reason: result.assignmentReason,
  });
}

// ── Simulate handoff — จำลองการจ่ายงานโดยไม่กระทบ conversations จริง ──
// เก็บประวัติ assign ลง test_chat_sessions เท่านั้น
// ใช้ session_id ของ test chat เป็น conversation_id
async function simulateHandoff(
  sessionId: string,
  shopId?: string,
  platform?: string,
  reason?: string,
  claim?: BotHandoffBody["claim"]
) {
  const { ObjectId } = await import("mongodb");
  type TestChatSessionDoc = {
    _id: typeof ObjectId.prototype;
    assigned_to?: string | null;
    assigned_to_name?: string | null;
    assignment_reason?: string | null;
    assignment_history?: unknown[];
  };
  const adminDb = await getCollection<TestChatSessionDoc>(COLLECTIONS.testChatSessions);

  // หา admin ที่จะรับงาน — ใช้ logic เดียวกับ handoffService แต่ไม่เขียน conversations
  // Step 1: เช็ค assigned_to เดิมใน session
  const session = await adminDb.findOne({ _id: new ObjectId(sessionId) as never });
  let assignedTo: string | null = session?.assigned_to || null;
  let assignmentReason = "unknown";

  // Step 2: ถ้าไม่มี → round-robin (เรียก pickNextAgent โดยตรง ไม่ผ่าน autoAssignConversation)
  // ⚡ Phase 2D — แก้ bug: เดิมเรียก autoAssignConversation({ conversation_id: "sim_xxx" })
  //   แต่ sim_xxx ไม่มีใน conversations → findOneAndUpdate ล้มเหลว → คืน null
  //   แต่ pickNextAgent ขยับ cursor ไปแล้ว → replay ครั้งถัดไปได้ admin คนใหม่ทุกครั้ง
  //   แก้: เรียก pickNextAgent โดยตรง + เก็บใน test_chat_sessions (ไม่ต้อง atomic update conversations)
  if (!assignedTo) {
    try {
      const { assignmentService } = await import("@/backend/service/assignmentService");
      const mode = await assignmentService.getActiveAssignmentConfig();
      const { poolKey, orderedAgentIds } = await assignmentService.buildPool(
        mode,
        { shop_id: shopId || "", platform: platform || "shopee" },
        "test_chat"
      );
      if (orderedAgentIds.length > 0) {
        const agentId = await assignmentService.pickNextAgent(poolKey, orderedAgentIds);
        if (agentId) {
          assignedTo = agentId;
          assignmentReason = "round_robin: ไม่มี admin เดิม → จ่ายคิว (simulate)";
        }
      }
    } catch (e) {
      console.error("[bot-handoff:simulate] pickNextAgent failed:", e);
    }
  } else {
    assignmentReason = "existing_assignment: มี admin ดูแลอยู่แล้ว (simulate)";
  }

  // ดึงชื่อ admin
  let assignedToName: string | null = null;
  if (assignedTo) {
    try {
      const adminColl = await getCollection<{ admin_id: string; name: string }>(COLLECTIONS.admins);
      const admin = await adminColl.findOne({ admin_id: assignedTo });
      assignedToName = admin?.name || null;
    } catch { /* ignore */ }
  }

  // บันทึกลง test_chat_sessions — เก็บ assigned_to + assignment_history
  const historyEntry = {
    assigned_to: assignedTo,
    assigned_to_name: assignedToName,
    reason: reason || "simulate handoff",
    assignment_reason: assignmentReason,
    timestamp: new Date(),
    claim: claim || null,
  };
  await adminDb.updateOne(
    { _id: new ObjectId(sessionId) as never },
    {
      $set: { assigned_to: assignedTo, assigned_to_name: assignedToName, assignment_reason: assignmentReason, updated_at: new Date() } as never,
      $push: { assignment_history: historyEntry } as never,
    }
  );

  await logAdminEvent({
    action_type: "conversation.handoff" as never,
    actor: "bot",
    conversation_id: sessionId,
    metadata: {
      assigned_to: assignedTo,
      assigned_to_name: assignedToName,
      reason,
      assignment_reason: assignmentReason,
      simulate: true,
      claim,
    },
  });

  // 🔒 ไม่ log PII (assigned_to_name, reason) ไปยัง stdout
  console.log(`[bot-handoff:simulate] session=${sessionId} assigned_to=${assignedTo}`);

  return json({
    ok: true,
    simulate: true,
    assigned_to: assignedTo,
    assigned_to_name: assignedToName,
    reopened: false,
    assignment_reason: assignmentReason,
  });
}
