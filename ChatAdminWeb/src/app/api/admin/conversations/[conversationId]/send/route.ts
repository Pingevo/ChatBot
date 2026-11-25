// POST /api/admin/conversations/:id/send — internal note or explicitly enabled Shopee reply
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { messageService } from "@/backend/service/messageService";
import { conversationService } from "@/backend/service/conversationService";
import { statusConversationService } from "@/backend/service/statusConversationService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { auth } from "@/backend/service/authService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
import { sendShopeeMessage, isShopeeConsoleSendEnabled, outboundMessageId, readShopeeOutboundInput } from "@/backend/service/shopeeOutboundService";
import type { ChatMessage, MessageMedia, MessageType } from "@/lib/types";

async function invalidateBotworkerCache() {
  try {
    const mod = await import("@/app/api/botworker/conversations/route");
    if (typeof (mod as unknown as { invalidateBotworkerCache?: () => void }).invalidateBotworkerCache === "function") {
      (mod as unknown as { invalidateBotworkerCache: () => void }).invalidateBotworkerCache();
    }
  } catch { /* ignore */ }
}

const INPUT_ERRORS = new Set(["invalid_body", "unsupported_message_type"]);

function deliveryMessage(code: string): string {
  if (code === "delivery_unknown") return "ยังยืนยันผลส่งจาก Shopee ไม่ได้ กรุณาตรวจสอบแชทก่อนส่งซ้ำ";
  if (code === "live_send_disabled") return "ปิดสวิตช์ส่งจริงอยู่ — ไม่มีการส่งไป Shopee";
  if (code === "item_shop_mismatch") return "สินค้านี้ไม่ตรงกับร้านของบทสนทนา จึงยกเลิกการส่ง";
  return "Shopee ไม่ยืนยันการส่งข้อความ กรุณาตรวจสอบรายละเอียดก่อนลองใหม่";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const authResult = await requirePageAccess(req, "ticket");
  if (!authResult.ok) return authResult.response;

  const { conversationId } = await params;
  let parsed: Awaited<ReturnType<typeof readShopeeOutboundInput>>;
  try {
    parsed = await readShopeeOutboundInput(req);
  } catch (e) {
    const code = e instanceof Error ? e.message : "invalid_body";
    return error(INPUT_ERRORS.has(code) ? code : "invalid message input", 422);
  }
  const { requestId, input, force } = parsed;
  if (input.type === "text" && !input.text?.trim()) return error("text is required", 422);

  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const me = authResult.ctx.admin.admin_id;
  const meta = await statusConversationService.getMeta(conversationId);
  const currentAssignee = meta?.assigned_to || null;
  const assignedToOther = currentAssignee && currentAssignee !== me;
  if (assignedToOther && !force) {
    return json({ ok: false, conflict: true, assigned_to: currentAssignee, message: "conversation assigned to another admin" }, 409);
  }

  const liveEnabled = await isShopeeConsoleSendEnabled();
  const expectedMode = req.headers.get("x-shopee-send-mode");
  if (conv.platform === "shopee" && expectedMode !== (liveEnabled ? "on" : "off")) {
    return error("สถานะสวิตช์ส่งจริงเปลี่ยนแล้ว กรุณารีเฟรชหน้าก่อนส่ง", 409);
  }
  if (liveEnabled && conv.platform === "shopee") {
    const result = await sendShopeeMessage({ conversationId, requestId, input });
    if (result.state !== "sent") {
      const status = result.state === "unknown" ? 409 : result.code === "live_send_disabled" ? 423 : 502;
      return error(deliveryMessage(result.state === "unknown" ? result.code : result.code), status);
    }

    const messageType: MessageType = result.type === "item" ? "item" : result.type;
    const media: MessageMedia | undefined = result.media
      ? { type: result.type === "video" ? "video" : "image", url: result.media.url, thumb_url: result.media.thumb_url }
      : undefined;
    const id = outboundMessageId(requestId);
    const doc = await messageService.addMessage({
      conversationId,
      shopId: conv.shop_id,
      platform: conv.platform,
      role: "admin",
      direction: "out",
      text: result.text,
      products: result.products,
      source: "admin",
      actor: me,
      documentId: id,
      messageId: id,
      messageType,
      media,
      rawPayload: result.type === "sticker"
        ? { message_type: "sticker", content: { sticker_id: input.type === "sticker" ? input.stickerId : "", sticker_package_id: input.type === "sticker" ? input.stickerPackageId : "" } }
        : result.type === "item"
          ? { message_type: "item", content: { item_id: input.type === "item" ? input.itemId : "" } }
          : undefined,
      deliveryStatus: "sent",
      providerMessageId: result.providerMessageId,
    });
    await logAdminEvent({
      action_type: "admin.reply",
      actor: me,
      conversation_id: conversationId,
      shop_id: conv.shop_id,
      metadata: {
        platform: conv.platform,
        message_id: doc.message_id,
        message_type: result.type,
        delivery_status: "sent",
        delivered_to_platform: true,
        provider_message_id: result.providerMessageId,
        assigned_to: currentAssignee,
        forced_override: force && !!assignedToOther,
      },
    });
    const adminDoc = await auth.getAdminById(me);
    const message: ChatMessage = {
      id: doc.message_id,
      role: doc.role,
      text: doc.text,
      timestamp: doc.created_timestamp.toISOString(),
      source: doc.source,
      admin_id: me,
      admin_name: adminDoc?.name || adminDoc?.username || me,
      products: doc.products,
      message_type: doc.message_type,
      media: doc.media,
      delivery_status: doc.delivery_status,
      provider_message_id: doc.provider_message_id,
    };
    invalidateConversationsCache();
    await invalidateBotworkerCache();
    return json({ ok: true, message, delivery_status: "sent" });
  }

  if (input.type !== "text") return error("สื่อส่งได้เมื่อเปิดสวิตช์และเลือกบทสนทนา Shopee เท่านั้น", 423);

  // When live sending is off, preserve the existing Tickets behavior: save an internal admin note only.
  const text = input.text!.trim();
  const doc = await messageService.addMessage({
    conversationId,
    shopId: conv.shop_id,
    platform: conv.platform,
    role: "admin",
    direction: "out",
    text,
    source: "admin",
    actor: me,
    deliveryStatus: "internal",
  });
  await logAdminEvent({
    action_type: "admin.reply",
    actor: me,
    conversation_id: conversationId,
    shop_id: conv.shop_id,
    metadata: {
      platform: conv.platform,
      message_id: doc.message_id,
      text_preview: text.slice(0, 100),
      delivery_status: "internal",
      delivered_to_platform: false,
      assigned_to: currentAssignee,
      reply_as_assigned_owner: !assignedToOther,
      forced_override: force && !!assignedToOther,
    },
  });
  const adminDoc = await auth.getAdminById(me);
  const message: ChatMessage = {
    id: doc.message_id,
    role: doc.role,
    text: doc.text,
    timestamp: doc.created_timestamp.toISOString(),
    source: doc.source,
    admin_id: me,
    admin_name: adminDoc?.name || adminDoc?.username || me,
    delivery_status: "internal",
  };
  invalidateConversationsCache();
  await invalidateBotworkerCache();
  return json({ ok: true, message, assigned_to: currentAssignee, delivery_status: "internal" });
}
