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
import type { Platform } from "@/backend/lib/safety";

/**
 * เรียก bot ของเราผ่าน proxy (เหมือน test-chat)
 * ไม่ได้เรียก platform API — เรียก Python chatbot service ของเราเท่านั้น
 */
async function callOurBot(params: {
  platform: Platform;
  message: string;
  history: { role: "user" | "model"; text: string }[];
  shopId: string;
  shopName?: string;
}): Promise<{
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
}> {
  const { platform, message, history, shopId, shopName } = params;
  // ใช้ platform-specific bot URL (shopee/tiktok/lazada แยกกัน)
  const upstream = serverConfig.chatbotBaseUrls[platform].replace(/\/$/, "");
  const url = `${upstream}/chat`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Secret": serverConfig.chatbotInternalSecret,
  };

  // ⚠️ Python bot รับ field "shop" (ชื่อร้าน) ไม่ใช่ "shop_id" (ตัวเลข)
  // ถ้ามี shopName ใช้เป็นหลัก ถ้าไม่มี fallback เป็น shopId
  const body: Record<string, unknown> = { message, history, limit: 5 };
  if (shopName) body.shop = shopName;
  else if (shopId) body.shop = shopId;

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

  const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
  const shopId = url.searchParams.get("shop_id") || undefined;
  const conversationId = url.searchParams.get("conversation_id") || undefined;
  const rating = (url.searchParams.get("rating") || undefined) as
    | "good"
    | "bad"
    | "unrated"
    | undefined;
  const origin = (url.searchParams.get("origin") || undefined) as "worker" | "manual" | "manual_conversation" | undefined;
  const deleted = url.searchParams.get("deleted") === "1"; // ⚡ ดึงเฉพาะที่ถูก soft delete
  const limitParam = parseInt(url.searchParams.get("limit") || "100", 10);
  const limit = Math.min(Math.max(limitParam, 1), 500);

  const rows = await shadowReplyService.list({ platform, shopId, conversationId, rating, origin, limit, includeDeleted: deleted, deletedOnly: deleted });
  return json({ rows, total: rows.length });
}

// POST — generate shadow reply for a conversation (dev เท่านั้น)
export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    conversation_id: string;
    inbound_message_id?: string;
  }>(req);

  if (!body || !body.conversation_id) {
    return error("conversation_id is required", 422);
  }

  // 🔒 coerce เพื่อป้องกัน NoSQL injection
  const conversationId = String(body.conversation_id);
  const inboundMessageId = body.inbound_message_id != null ? String(body.inbound_message_id) : undefined;

  try {
    const doc = await shadowReplyService.generate({
      conversationId,
      inboundMessageId,
      botCaller: callOurBot,
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
