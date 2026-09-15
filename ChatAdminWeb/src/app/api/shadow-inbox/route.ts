// GET  /api/shadow-inbox       — list shadow replies (+ optional filter by platform/shop/rating)
// GET  /api/shadow-inbox?stats=1 — สรุปคะแนน bot vs zaapi (+ star + comment)
// GET  /api/shadow-inbox?stats=1&conversation_id=xxx — สถิติเฉพาะ conversation นั้น
// POST /api/shadow-inbox       — generate shadow reply for a conversation (เก็บใน shadow_replies ไม่ส่งจริง)
// DELETE /api/shadow-inbox?clear_all=1 — ล้างข้อมูล shadow replies ทั้งหมด
//
// ⛔ IRON RULE: ห้ามส่งข้อความจริงให้ลูกค้า
// ⛔ ห้ามเรียก Shopee/TikTok/Lazada API
// bot ถูกเรียกผ่าน /api/chatbot/[platform]/chat (proxy ไป Python service)
// ผลลัพธ์เก็บใน `shadow_replies` collection เท่านั้น
// ⚡ force-dynamic — กัน Next.js cache GET response (กันข้อมูลเก่าค้าง)
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { shadowReplyService } from "@/backend/service/shadowReplyService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { serverConfig } from "@/backend/lib/config";
import { shouldUseChatV2, shouldUseChatV3, getBotProductLimit } from "@/backend/service/systemConfigService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { Platform } from "@/backend/lib/safety";

/**
 * เรียก bot ของเราผ่าน proxy (เหมือน test-chat)
 * ไม่ได้เรียก platform API — เรียก Python chatbot service ของเราเท่านั้น
 * ⚡ A2 — รองรับ images (current turn) + คืน image_desc ให้ caller cache
 */
async function callOurBot(params: {
  platform: Platform;
  message: string;
  history: { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[];
  shopId: string;
  shopName?: string;
  images?: string[];
  conversationId?: string;  // ⚡ ส่ง conversation_id ให้ bot เพื่อบันทึก/ดึง anchor จาก timeline
  use_v2?: boolean;
  use_v3?: boolean;
}): Promise<{
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
  image_desc?: string;
  handoff_to_admin?: boolean;
  handoff_reason?: string;
  routing_decision?: unknown;
}> {
  const { platform, message, history, shopId, shopName, images, conversationId, use_v2, use_v3 } = params;
  // ใช้ platform-specific bot URL (shopee/tiktok/lazada แยกกัน)
  const upstream = serverConfig.chatbotBaseUrls[platform].replace(/\/$/, "");
  const url = `${upstream}/chat`;

  // ⚡ BUG-G guard — fail fast สำหรับ platform ที่ไม่มี bot deploy
  //   tiktok/lazada bot ยังเป็น placeholder (chatbot/tiktokchat/, chatbot/lazadachat/)
  //   docker-compose ใช้ profiles จึงไม่ start ตาม default → fetch จะ timeout 50s
  //   คืน error ที่อ่านรู้เรื่องแทน เพื่อกันเสียเวลา + สับสน
  if (platform !== "shopee") {
    throw new Error(
      `bot สำหรับ platform "${platform}" ยังไม่ได้ deploy (URL=${upstream}) — ` +
      `shadow-inbox รองรับเฉพาะ shopee ในขณะนี้`
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Secret": serverConfig.chatbotInternalSecret,
  };

  // ⚠️ Python bot รับ field "shop" (ชื่อร้าน) ไม่ใช่ "shop_id" (ตัวเลข)
  // ถ้ามี shopName ใช้เป็นหลัก ถ้าไม่มี fallback เป็น shopId
  const body: Record<string, unknown> = { message, history, limit: await getBotProductLimit() };
  if (shopName) body.shop = shopName;
  else if (shopId) body.shop = shopId;
  // ⚡ A2 — ส่ง current-turn images ให้ bot (ถ้ามี)
  if (images && images.length > 0) body.images = images;
  // ⚡ ส่ง conversation_id ให้ bot เพื่อบันทึก/ดึง anchor จาก timeline
  if (conversationId) body.conversation_id = conversationId;
  // ⚡ chat_v3 — ส่ง use_v3 เพื่อบังคับใช้ chatbotv3 (มี priority เหนือ v2)
  if (use_v3) body.use_v3 = true;
  // ⚡ chat_v2 — ส่ง use_v2 เพื่อบังคับใช้ chat_v2 (replay test) — ไม่ส่งถ้า v3
  else if (use_v2) body.use_v2 = true;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`bot call failed (${resp.status}): ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  return {
    answer: data.answer || "(ไม่มีคำตอบ)",
    source: data.source,
    model: data.model,
    elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
    usage: data.usage,
    cost: typeof data.cost === "number" ? data.cost : undefined,
    products: data.products,
    image_desc: data.image_desc, // ⚡ A2 — คืน image_desc ให้ caller cache
    handoff_to_admin: data.handoff_to_admin === true, // ⚡ BUG-B — ส่งต่อให้ shadowReplyService เก็บ
    handoff_reason: typeof data.handoff_reason === "string" ? data.handoff_reason : undefined,
    routing_decision: data.routing_decision,
  };
}

// GET — list shadow replies หรือ stats (dev เท่านั้น)
export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const stats = url.searchParams.get("stats") === "1";

  if (stats) {
    const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
    const shopId = url.searchParams.get("shop_id") || undefined;
    const conversationId = url.searchParams.get("conversation_id") || undefined;
    const result = await shadowReplyService.stats({ platform, shopId, conversationId });
    return json({ stats: result });
  }

  // ⚡ Phase 3B-6 — endpoint ดึง distinct generation batches ของ conversation
  //   GET /api/shadow-inbox?batches=1&conversation_id=xxx
  //   คืน { batches: [{ generation_batch_id, conversation_id, created_at, count, generated_by, origin }] }
  const batches = url.searchParams.get("batches") === "1";
  if (batches) {
    const conversationId = url.searchParams.get("conversation_id") || undefined;
    if (!conversationId) return error("conversation_id required for batches", 422);
    const result = await shadowReplyService.listGenerationBatches(conversationId);
    return json({ batches: result, total: result.length });
  }

  const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
  const shopId = url.searchParams.get("shop_id") || undefined;
  const conversationId = url.searchParams.get("conversation_id") || undefined;
  const rating = (url.searchParams.get("rating") || undefined) as
    | "good"
    | "bad"
    | "unrated"
    | undefined;
  const origin = (url.searchParams.get("origin") || undefined) as "worker" | "manual" | "manual_conversation" | undefined;
  // ⚡ Phase 2R — filter ตาม mode (standalone/shadowbot/ticket)
  const mode = (url.searchParams.get("mode") || undefined) as "standalone" | "shadowbot" | "ticket" | undefined;
  // ⚡ Phase 3B-6 — filter ตามรอบ generate
  const generationBatchId = url.searchParams.get("generation_batch_id") || undefined;
  const deleted = url.searchParams.get("deleted") === "1"; // ⚡ ดึงเฉพาะที่ถูก soft delete
  const limitParam = parseInt(url.searchParams.get("limit") || "100", 10);
  const limit = Math.min(Math.max(limitParam, 1), 500);

  // ⚡ Phase 2R — ถ้ามี mode → filter เพิ่ม โดยใช้ list() แล้ว filter ใน JS (service ยังไม่รองรับ mode)
  // ⚡ Phase 3A — visibility: admin ทั่วไปเห็นเฉพาะ shadow reply ที่ตัวเอง Generate ไว้
  // superadmin/dev เห็นทั้งหมด
  const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
  let rows = await shadowReplyService.list({
    platform, shopId, conversationId, rating, origin,
    generatedBy: isSuperadmin ? undefined : r.ctx.admin.admin_id,
    generationBatchId,  // ⚡ Phase 3B-6
    limit, includeDeleted: deleted, deletedOnly: deleted,
  });
  if (mode) {
    rows = rows.filter((r) => (r as { mode?: string }).mode === mode);
  }
  return json({ rows, total: rows.length });
}

// POST — generate shadow reply for a conversation (dev เท่านั้น)
export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    conversation_id: string;
    inbound_message_id?: string;
    // ⚡ Phase 3B-3 — batch roll
    action?: "batch_roll";
    count?: number;
    order?: "recent" | "oldest";
    mode?: "overwrite" | "resume";
    platform?: string;
    // ⚡ chat_v2 — บังคับใช้ chat_v2 (สำหรับ replay test)
    use_v2?: boolean;
    // ⚡ chat_v3 — บังคับใช้ chatbotv3 (สำหรับ replay test)
    use_v3?: boolean;
  }>(req);

  if (!body) return error("body required", 422);

  // ── ⚡ Phase 3B-3 — batch roll: คืนรายการ conversation_ids ที่จะ generate ──
  if (body.action === "batch_roll") {
    const count = Math.min(Math.max(parseInt(String(body.count ?? "10"), 10) || 10, 1), 1000);
    const order = (body.order as "recent" | "oldest") || "recent";
    const mode = (body.mode as "overwrite" | "resume") || "overwrite";
    const platformFilter = body.platform ? String(body.platform) : undefined;
    const adminId = r.ctx.admin.admin_id;

    // ดึง conversations (เรียงตาม last_message_timestamp)
    const convColl = await getCollection<{
      conversation_id: string; platform: string; last_message_timestamp?: Date;
    }>(COLLECTIONS.conversations);
    const convFilter: Record<string, unknown> = {};
    if (platformFilter) convFilter.platform = platformFilter;
    const allConvs = await convColl
      .find(convFilter)
      .sort({ last_message_timestamp: order === "oldest" ? 1 : -1 })
      .limit(count * 3)
      .project({ conversation_id: 1 })
      .toArray();

    if (allConvs.length === 0) {
      return json({ conversation_ids: [], total: 0, skipped: 0 });
    }

    let skipped = 0;
    let conversationIds: string[] = [];

    if (mode === "resume") {
      // ⚡ Phase 3B-3 — ข้ามเฉพาะแชทที่ admin คนนี้เคย generate แล้ว (ไม่ใช่ของทุกคน)
      const shadowColl = await getCollection<{
        conversation_id: string; origin: string; generated_by?: string;
      }>(COLLECTIONS.shadowReplies);
      const myGeneratedConvIds = await shadowColl
        .find({ origin: "manual_conversation", generated_by: adminId })
        .project({ conversation_id: 1 })
        .toArray();
      const myDoneSet = new Set(myGeneratedConvIds.map((x) => x.conversation_id));

      for (const c of allConvs) {
        if (conversationIds.length >= count) break;
        if (myDoneSet.has(c.conversation_id)) {
          skipped++;
          continue;
        }
        conversationIds.push(c.conversation_id);
      }
    } else {
      conversationIds = allConvs.slice(0, count).map((c) => c.conversation_id);
    }

    await logAdminEvent({
      action_type: "shadow_reply.batch_roll",
      actor: adminId,
      metadata: { count: conversationIds.length, order, mode, platform: platformFilter, skipped },
    });

    return json({
      conversation_ids: conversationIds,
      total: conversationIds.length,
      skipped,
      order,
      mode,
    });
  }

  // ── normal generate (single message) ──
  if (!body.conversation_id) {
    return error("conversation_id is required", 422);
  }

  // 🔒 coerce เพื่อป้องกัน NoSQL injection
  const conversationId = String(body.conversation_id);
  const inboundMessageId = body.inbound_message_id != null ? String(body.inbound_message_id) : undefined;

  // ⚡ chat_engine — อ่านจาก SystemConfig (หน้า config ควบคุม)
  //    ถ้า body ส่ง use_v2/use_v3 มา explicit → override config
  //    v3 มี priority เหนือ v2
  const configUseV2 = await shouldUseChatV2();
  const configUseV3 = await shouldUseChatV3();
  const useV3 = body.use_v3 === true || (body.use_v3 === undefined && configUseV3);
  const useV2 = !useV3 && (body.use_v2 === true || (body.use_v2 === undefined && configUseV2));
  const chatEngine = useV3 ? "v3" : useV2 ? "v2" : "legacy";
  const botCaller = useV3
    ? (p: Parameters<typeof callOurBot>[0]) => callOurBot({ ...p, use_v3: true })
    : useV2
    ? (p: Parameters<typeof callOurBot>[0]) => callOurBot({ ...p, use_v2: true })
    : callOurBot;

  try {
    const doc = await shadowReplyService.generate({
      conversationId,
      inboundMessageId,
      generatedBy: r.ctx.admin.admin_id,  // ⚡ Phase 3A — บันทึกใครกด Generate (KPI)
      chatEngine,  // ⚡ บันทึก engine ที่ใช้ใน shadow reply
      botCaller,
    });

    // audit log — บันทึกว่า admin สั่ง generate shadow reply
    await logAdminEvent({
      action_type: "shadow_reply.generate",
      actor: r.ctx.admin.admin_id,
      conversation_id: conversationId,
      shop_id: doc.shop_id,
      metadata: {
        shadow_reply_id: doc.shadow_reply_id,
        platform: doc.platform,
        inbound_message_id: doc.inbound_message_id,
        bot_source: doc.bot_source,
        has_zaapi_reply: !!doc.zaapi_reply_text,
        delivered_to_platform: false, // ⛔ never delivered
      },
    });

    return json({ shadow_reply: doc });
  } catch (err) {
    const msg = (err as Error).message || "generate shadow reply failed";
    return error(msg, 500);
  }
}

// DELETE — clear all shadow replies (dev เท่านั้น)
// ใช้ตอนอยากเริ่มใหม่ ล้างข้อมูลทั้งหมด
export async function DELETE(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const clearAll = url.searchParams.get("clear_all") === "1";
  if (!clearAll) {
    return error("use clear_all=1 to clear all shadow replies", 422);
  }

  const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
  const shopId = url.searchParams.get("shop_id") || undefined;

  const result = await shadowReplyService.clearAll({
    platform,
    shopId,
    deletedBy: r.ctx.admin.admin_id,
    reason: "clear_all",
  });

  await logAdminEvent({
    action_type: "shadow_reply.clear_all",
    actor: r.ctx.admin.admin_id,
    metadata: {
      soft_deleted_count: result.softDeletedCount,
      platform,
      shop_id: shopId,
    },
  });

  return json({ ok: true, soft_deleted_count: result.softDeletedCount });
}

// POST ?action=restore_all — restore ทั้งหมดที่ถูก soft delete
export async function PUT(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (action !== "restore_all") {
    return error("use action=restore_all to restore all soft-deleted shadow replies", 422);
  }

  const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
  const shopId = (url.searchParams.get("shop_id") || undefined);

  const result = await shadowReplyService.restoreAll({ platform, shopId });

  await logAdminEvent({
    action_type: "shadow_reply.restore_all",
    actor: r.ctx.admin.admin_id,
    metadata: {
      restored_count: result.restoredCount,
      platform,
      shop_id: shopId,
    },
  });

  return json({ ok: true, restored_count: result.restoredCount });
}
