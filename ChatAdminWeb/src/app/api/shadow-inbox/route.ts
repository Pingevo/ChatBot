// GET  /api/shadow-inbox       — list shadow replies (+ optional filter by platform/shop/rating)
// GET  /api/shadow-inbox?stats=1 — สรุปคะแนน bot vs zaapi
// POST /api/shadow-inbox       — generate shadow reply for a conversation (เก็บใน shadow_replies ไม่ส่งจริง)
//
// ⛔ IRON RULE: ห้ามส่งข้อความจริงให้ลูกค้า
// ⛔ ห้ามเรียก Shopee/TikTok/Lazada API
// bot ถูกเรียกผ่าน /api/chatbot/[platform]/chat (proxy ไป Python service)
// ผลลัพธ์เก็บใน `shadow_replies` collection เท่านั้น
import { NextRequest } from "next/server";
import { requireAuth, requireDev } from "@/backend/middleware/authorize";
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
  const r = await requireDev(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const stats = url.searchParams.get("stats") === "1";

  if (stats) {
    const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
    const shopId = url.searchParams.get("shop_id") || undefined;
    const result = await shadowReplyService.stats({ platform, shopId });
    return json({ stats: result });
  }

  const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
  const shopId = url.searchParams.get("shop_id") || undefined;
  const conversationId = url.searchParams.get("conversation_id") || undefined;
  const rating = (url.searchParams.get("rating") || undefined) as
    | "better"
    | "worse"
    | "tie"
    | "unrated"
    | undefined;
  const origin = (url.searchParams.get("origin") || undefined) as "worker" | "manual" | "manual_conversation" | undefined;
  const limitParam = parseInt(url.searchParams.get("limit") || "100", 10);
  const limit = Math.min(Math.max(limitParam, 1), 500);

  const rows = await shadowReplyService.list({ platform, shopId, conversationId, rating, origin, limit });
  return json({ rows, total: rows.length });
}

// POST — generate shadow reply for a conversation (dev เท่านั้น)
export async function POST(req: NextRequest) {
  const r = await requireDev(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    conversation_id: string;
    inbound_message_id?: string;
  }>(req);

  if (!body || !body.conversation_id) {
    return error("conversation_id is required", 422);
  }

  try {
    const doc = await shadowReplyService.generate({
      conversationId: body.conversation_id,
      inboundMessageId: body.inbound_message_id,
      botCaller: callOurBot,
    });

    // audit log — บันทึกว่า admin สั่ง generate shadow reply
    await logAdminEvent({
      action_type: "shadow_reply.generate",
      actor: r.ctx.admin.admin_id,
      conversation_id: body.conversation_id,
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
