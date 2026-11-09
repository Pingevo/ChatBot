// POST /api/botworker/conversations/:id/review — per-bubble human review (mock send)
// body: { reply_id, bubble_id, action, edited_text?, card_item_id?, operation_id, updated_at? }
//   action: save | approve | save_and_approve | reject | send_card
// ⛔ mock only — ไม่ยิง Shopee, ไม่เขียน messages_shp; identity ทั้งหมด server-derived
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getSystemConfig } from "@/backend/service/systemConfigService";
import { applyReviewAction, type ReviewAction } from "@/backend/service/reviewService";
import { sendMockPart } from "@/backend/service/mockSendService";

const ACTIONS: ReviewAction[] = ["save", "approve", "save_and_approve", "reject", "send_card"];
const CODE_STATUS: Record<string, number> = {
  not_found: 404, forbidden: 403, invalid: 422, conflict: 409,
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{
    reply_id?: string; bubble_id?: string; action?: string;
    edited_text?: string; card_item_id?: string;
    operation_id?: string; updated_at?: string;
  }>(req);
  if (!body?.reply_id || !body.bubble_id || !body.action || !body.operation_id) {
    return error("reply_id, bubble_id, action, operation_id required", 422);
  }
  if (!ACTIONS.includes(body.action as ReviewAction)) {
    return error(`action must be one of ${ACTIONS.join("/")}`, 422);
  }

  const config = await getSystemConfig();
  const designatedAdminId = config.bot_review_admin_id;
  const designatedShopId = config.bot_review_shop_id;
  if (!designatedAdminId || !designatedShopId) {
    return error("human review pilot not configured", 403);
  }

  const outcome = await applyReviewAction({
    conversationId,
    replyId: body.reply_id,
    bubbleId: body.bubble_id,
    action: body.action as ReviewAction,
    editedText: body.edited_text,
    cardItemId: body.card_item_id,
    operationId: body.operation_id,
    actor: r.ctx.admin.admin_id,
    designatedAdminId,
    designatedShopId,
    expectedUpdatedAt: body.updated_at,
    mockSender: sendMockPart,
  });

  if (!outcome.ok) {
    return json({ ok: false, message: outcome.message, bubble: outcome.bubble }, CODE_STATUS[outcome.code || "conflict"] || 409);
  }
  return json({ ok: true, bubble: outcome.bubble, updated_at: outcome.updated_at, reply_id: outcome.reply_id });
}
