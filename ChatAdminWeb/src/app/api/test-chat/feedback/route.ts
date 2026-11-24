// POST /api/test-chat/feedback — keep Test Chat feedback best-effort and non-persistent.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const body = await readJson<{ answer?: string; rating?: string }>(req);
  if (!body || typeof body.answer !== "string" || typeof body.rating !== "string") {
    return error("answer and rating are required", 422);
  }
  const rating = ["up", "down", "clear"].includes(body.rating) ? body.rating : "unknown";
  if (rating !== "clear") {
    console.info(`[FEEDBACK] admin=${auth.ctx.admin.admin_id} rating=${rating} answer='${body.answer.slice(0, 80)}...'`);
  }
  return json({ status: "ok", rating });
}
