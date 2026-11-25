// POST /api/botworker/conversations/:id/review — per-bubble human review
// body: { reply_id, bubble_id, action, edited_text?, card_item_id?, operation_id, updated_at? }
//   action: save | approve | save_and_approve | reject | send_card
// Live Shopee delivery is available only through the scoped config switch; identity is server-derived.
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { applyReviewAction, type ReviewAction } from "@/backend/service/reviewService";
import { sendMockPart } from "@/backend/service/mockSendService";
import { conversationService } from "@/backend/service/conversationService";
import { isShopeeConsoleSendEnabled, outboundMessageId, sendShopeeMessage } from "@/backend/service/shopeeOutboundService";

const ACTIONS: ReviewAction[] = ["save", "approve", "save_and_approve", "reject", "send_card"];
const CODE_STATUS: Record<string, number> = {
  not_found: 404, forbidden: 403, invalid: 422, conflict: 409,
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requirePageAccess(req, "botworker");
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{
    reply_id?: string; bubble_id?: string; action?: string;
    edited_text?: string; card_item_id?: string;
    operation_id?: string; updated_at?: string; rejection_reason?: string;
  }>(req);
  if (!body?.reply_id || !body.bubble_id || !body.action || !body.operation_id) {
    return error("reply_id, bubble_id, action, operation_id required", 422);
  }
  if (!ACTIONS.includes(body.action as ReviewAction)) {
    return error(`action must be one of ${ACTIONS.join("/")}`, 422);
  }

  if (body.action === "reject" && !body.rejection_reason?.trim()) {
    return error("rejection_reason required when rejecting", 422);
  }

  const liveSendEnabled = await isShopeeConsoleSendEnabled();
  const expectedMode = req.headers.get("x-shopee-send-mode");
  const actionCanSend = body.action === "approve" || body.action === "save_and_approve" || body.action === "send_card";
  if (actionCanSend) {
    const conversation = await conversationService.getConversation(conversationId);
    if (conversation?.platform === "shopee" && expectedMode !== (liveSendEnabled ? "on" : "off")) {
      return error("สถานะสวิตช์ส่งจริงเปลี่ยนแล้ว กรุณารีเฟรชหน้าก่อนอนุมัติ", 409);
    }
  }
  const liveSender = liveSendEnabled ? async (part: {
    eventId: string; replyId: string; bubbleId: string;
    part: "text" | "product_card"; text?: string; item_id?: string;
    conversationId: string; shopId: string; platform: string;
    actor: string; inboundMessageId?: string;
  }) => {
    if (part.platform !== "shopee") {
      const receipt = await sendMockPart(part);
      return { state: "mock_sent" as const, request_id: part.eventId, receipt };
    }
    const input = part.part === "product_card"
      ? { type: "item" as const, itemId: part.item_id }
      : { type: "text" as const, text: part.text };
    try {
      const result = await sendShopeeMessage({ conversationId: part.conversationId, requestId: outboundMessageId(part.eventId), input });
      if (result.state === "sent") {
        return {
          state: "live_sent" as const,
          request_id: part.eventId,
          receipt: { provider: "shopee" as const, delivered: true as const, request_id: part.eventId, provider_message_id: result.providerMessageId },
        };
      }
      return {
        state: result.state === "unknown" ? "live_unknown" as const : "live_failed" as const,
        request_id: part.eventId,
        error: result.state === "unknown" ? "delivery_unknown" : result.code,
      };
    } catch {
      return { state: "live_unknown" as const, request_id: part.eventId, error: "delivery_unknown" };
    }
  } : undefined;

  const outcome = await applyReviewAction({
    conversationId,
    replyId: body.reply_id,
    bubbleId: body.bubble_id,
    action: body.action as ReviewAction,
    editedText: body.edited_text,
    cardItemId: body.card_item_id,
    operationId: body.operation_id,
    actor: r.ctx.admin.admin_id,
    actorName: r.ctx.admin.name || r.ctx.admin.username || r.ctx.admin.admin_id,
    liveSendEnabled,
    rejectionReason: body.rejection_reason,
    expectedUpdatedAt: body.updated_at,
    mockSender: sendMockPart,
    liveSender,
  });

  if (!outcome.ok) {
    return json({ ok: false, message: outcome.message, bubble: outcome.bubble }, CODE_STATUS[outcome.code || "conflict"] || 409);
  }
  return json({ ok: true, bubble: outcome.bubble, updated_at: outcome.updated_at, reply_id: outcome.reply_id });
}
