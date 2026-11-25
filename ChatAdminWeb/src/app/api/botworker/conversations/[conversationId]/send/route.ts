// POST /api/botworker/conversations/:id/send — sandbox admin note or explicitly enabled Shopee reply
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { conversationService } from "@/backend/service/conversationService";
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { logBotworkerEvent } from "@/backend/service/botworkerEventService";
import { sendShopeeMessage, isShopeeConsoleSendEnabled, outboundMessageId, readShopeeOutboundInput } from "@/backend/service/shopeeOutboundService";
import { BW_SOURCE, getBwMeta, invalidateBotworkerCache } from "../../../_shared";
import type { MessageMedia, MessageType } from "@/lib/types";

function genBwMessageId(): string {
  return "bw_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function deliveryMessage(code: string): string {
  if (code === "delivery_unknown") return "ยังยืนยันผลส่งจาก Shopee ไม่ได้ กรุณาตรวจสอบแชทก่อนส่งซ้ำ";
  if (code === "live_send_disabled") return "ปิดสวิตช์ส่งจริงอยู่ — ไม่มีการส่งไป Shopee";
  if (code === "item_shop_mismatch") return "สินค้านี้ไม่ตรงกับร้านของบทสนทนา จึงยกเลิกการส่ง";
  return "Shopee ไม่ยืนยันการส่งข้อความ กรุณาตรวจสอบรายละเอียดก่อนลองใหม่";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const auth = await requirePageAccess(req, "botworker");
  if (!auth.ok) return auth.response;

  const { conversationId } = await params;
  let parsed: Awaited<ReturnType<typeof readShopeeOutboundInput>>;
  try {
    parsed = await readShopeeOutboundInput(req);
  } catch (e) {
    const code = e instanceof Error ? e.message : "invalid_body";
    return error(code === "invalid_body" || code === "unsupported_message_type" ? code : "invalid message input", 422);
  }
  const { requestId, input, force } = parsed;
  if (input.type === "text" && !input.text?.trim()) return error("text is required", 422);

  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const me = auth.ctx.admin.admin_id;
  const meta = await getBwMeta(conversationId);
  const assignedToOther = meta?.assigned_to && meta.assigned_to !== me;
  if (assignedToOther && !force) {
    return json({ ok: false, conflict: true, assigned_to: meta!.assigned_to, message: "conversation assigned to another admin" }, 409);
  }

  const liveEnabled = await isShopeeConsoleSendEnabled();
  const expectedMode = req.headers.get("x-shopee-send-mode");
  if (conv.platform === "shopee" && expectedMode !== (liveEnabled ? "on" : "off")) {
    return error("สถานะสวิตช์ส่งจริงเปลี่ยนแล้ว กรุณารีเฟรชหน้าก่อนส่ง", 409);
  }
  let liveResult: Awaited<ReturnType<typeof sendShopeeMessage>> | null = null;
  if (liveEnabled && conv.platform === "shopee") {
    liveResult = await sendShopeeMessage({ conversationId, requestId, input });
    if (liveResult.state !== "sent") {
      const status = liveResult.state === "unknown" ? 409 : liveResult.code === "live_send_disabled" ? 423 : 502;
      return error(deliveryMessage(liveResult.state === "unknown" ? liveResult.code : liveResult.code), status);
    }
  } else if (input.type !== "text") {
    return error("สื่อส่งได้เมื่อเปิดสวิตช์และเลือกบทสนทนา Shopee เท่านั้น", 423);
  }

  // Admin reply = claim; write the sandbox status only after a live send is confirmed.
  if (meta?.assigned_to !== me) {
    await testStatusConversationService.manualTestAssign(conversationId, BW_SOURCE, me, meta?.assigned_to, "open");
  } else if (meta?.status !== "open") {
    await testStatusConversationService.updateTestStatus(conversationId, BW_SOURCE, "open");
  }

  const admin = auth.ctx.admin;
  const coll = await getCollection<{
    _id?: string; message_id: string; conversation_id: string; shop_id: string; platform: string;
    role: string; actor: string; actor_name: string; bubble_color?: string; text: string;
    products?: { item_id: string; name: string; price: number; image?: string; shop?: string }[];
    message_type?: MessageType; media?: MessageMedia; delivery_status?: "sent" | "internal";
    provider_message_id?: string; created_at: Date;
  }>(COLLECTIONS.botworkerMessages);
  const live = liveResult?.state === "sent";
  const messageId = live ? outboundMessageId(requestId) : genBwMessageId();
  const messageType: MessageType | undefined = liveResult?.state === "sent"
    ? liveResult.type === "item" ? "item" : liveResult.type
    : undefined;
  const media: MessageMedia | undefined = liveResult?.state === "sent" && liveResult.media
    ? { type: liveResult.type === "video" ? "video" : "image", url: liveResult.media.url, thumb_url: liveResult.media.thumb_url }
    : undefined;
  const doc = {
    ...(live ? { _id: messageId } : {}),
    message_id: messageId,
    conversation_id: conversationId,
    shop_id: conv.shop_id,
    platform: conv.platform,
    role: "admin" as const,
    actor: me,
    actor_name: admin.name || admin.username || me,
    bubble_color: admin.bubble_color,
    text: liveResult?.state === "sent" ? liveResult.text : input.text!.trim(),
    products: liveResult?.state === "sent" ? liveResult.products : undefined,
    message_type: messageType,
    media,
    delivery_status: live ? "sent" as const : "internal" as const,
    provider_message_id: liveResult?.state === "sent" ? liveResult.providerMessageId : undefined,
    created_at: new Date(),
  };
  if (live) {
    await coll.updateOne({ _id: messageId }, { $setOnInsert: doc }, { upsert: true });
  } else {
    await coll.insertOne(doc);
  }
  const stored = live ? await coll.findOne({ _id: messageId }) : doc;
  if (!stored) return error("message record unavailable after confirmed delivery; retry with the same request", 503);

  await logBotworkerEvent({
    conversation_id: conversationId,
    type: "send",
    actor: me,
    shop_id: conv.shop_id,
    platform: conv.platform,
    metadata: {
      message_id: stored.message_id,
      message_type: messageType || "text",
      delivery_status: live ? "sent" : "internal",
      delivered_to_platform: live,
      provider_message_id: liveResult?.state === "sent" ? liveResult.providerMessageId : undefined,
      ...(live ? {} : { text_preview: stored.text.slice(0, 100) }),
      forced_override: force && !!assignedToOther,
    },
  });

  await invalidateBotworkerCache();
  return json({
    ok: true,
    delivery_status: live ? "sent" : "internal",
    message: {
      id: stored.message_id,
      role: "admin",
      text: stored.text,
      timestamp: stored.created_at.toISOString(),
      source: COLLECTIONS.botworkerMessages,
      admin_id: me,
      admin_name: stored.actor_name,
      bubble_color: stored.bubble_color,
      products: stored.products,
      message_type: stored.message_type,
      media: stored.media,
      delivery_status: stored.delivery_status,
      provider_message_id: stored.provider_message_id,
    },
  });
}
