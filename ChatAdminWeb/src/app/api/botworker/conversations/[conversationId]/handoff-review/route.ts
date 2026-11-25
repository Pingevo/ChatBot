// GET/POST /api/botworker/conversations/:id/handoff-review — BotWorker page access
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { applyHandoffReviewAction, getHandoffReviewPreview } from "@/backend/service/reviewService";

const CODE_STATUS: Record<string, number> = {
  not_found: 404, forbidden: 403, invalid: 422, conflict: 409,
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const access = await requirePageAccess(req, "botworker");
  if (!access.ok) return access.response;
  const { conversationId } = await params;
  const url = new URL(req.url);
  const replyId = url.searchParams.get("reply_id") || "";
  if (!replyId) return error("reply_id required", 422);
  const result = await getHandoffReviewPreview({ conversationId, replyId, expectedMessageId: url.searchParams.get("message_id") || undefined });
  if (!result.ok) return json({ ok: false, message: result.message }, CODE_STATUS[result.code || "conflict"] || 409);
  return json({ ok: true, handoff_review: result.handoff_review, candidates: result.candidates || [], updated_at: result.updated_at });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const access = await requirePageAccess(req, "botworker");
  if (!access.ok) return access.response;
  const { conversationId } = await params;
  const body = await readJson<{
    reply_id?: string; action?: string; selected_admin_id?: string; rejection_reason?: string;
    operation_id?: string; updated_at?: string;
  }>(req);
  if (!body?.reply_id || !body.action || !body.operation_id) return error("reply_id, action, operation_id required", 422);
  if (body.action !== "approve" && body.action !== "reject") return error("action must be approve/reject", 422);
  if (body.action === "approve" && !body.selected_admin_id) return error("selected_admin_id required", 422);
  if (body.action === "reject" && !body.rejection_reason?.trim()) return error("rejection_reason required", 422);
  const result = await applyHandoffReviewAction({
    conversationId, replyId: body.reply_id, action: body.action,
    selectedAdminId: body.selected_admin_id, rejectionReason: body.rejection_reason,
    operationId: body.operation_id, expectedUpdatedAt: body.updated_at,
    actor: access.ctx.admin.admin_id,
    actorName: access.ctx.admin.name || access.ctx.admin.username || access.ctx.admin.admin_id,
  });
  if (!result.ok) return json({ ok: false, message: result.message, handoff_review: result.handoff_review }, CODE_STATUS[result.code || "conflict"] || 409);
  return json({ ok: true, handoff_review: result.handoff_review, updated_at: result.updated_at });
}
