// API: /api/test-chat-ratings
//
// GET  /api/test-chat-ratings?session_id=...   → ดึง ratings ของ session นั้น
// GET  /api/test-chat-ratings?mode=stats       → สถิติรวมทุก session
// POST /api/test-chat-ratings                  → rate (upsert)
import { NextRequest } from "next/server";
import { testChatRatingService } from "@/backend/service/testChatRatingService";
import { requireDev } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { logAdminEvent } from "@/backend/service/adminLogService";
import type { Platform } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const r = await requireDev(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  const sessionId = url.searchParams.get("session_id");

  try {
    if (mode === "stats") {
      const stats = await testChatRatingService.stats();
      return json(stats);
    }
    if (sessionId) {
      const ratings = await testChatRatingService.listBySession(sessionId);
      return json({ ratings });
    }
    return error("ต้องระบุ ?session_id=... หรือ ?mode=stats", 422);
  } catch (e) {
    return error(`failed: ${e}`, 500);
  }
}

export async function POST(req: NextRequest) {
  const r = await requireDev(req);
  if (!r.ok) return r.response;

  const body = await req.json().catch(() => null);
  if (!body || !body.session_id || body.msg_index == null) {
    return error("session_id + msg_index required", 422);
  }

  const platform = (body.platform || "shopee") as Platform;
  const ok = await testChatRatingService.rate({
    sessionId: body.session_id,
    msgIndex: Number(body.msg_index),
    platform,
    shop: body.shop || "",
    starRating: body.star_rating != null ? Number(body.star_rating) : undefined,
    rating: body.rating,
    comment: body.comment,
    msgTextPreview: body.msg_text_preview,
    msgStats: body.msg_stats,
    ratedBy: r.ctx.admin.admin_id,
  });

  if (!ok) return error("rate failed", 500);

  await logAdminEvent({
    action_type: "test_chat.rate",
    actor: r.ctx.admin.admin_id,
    metadata: {
      session_id: body.session_id,
      msg_index: body.msg_index,
      star_rating: body.star_rating,
      rating: body.rating,
      comment_preview: (body.comment || "").slice(0, 120),
    },
  });

  return json({ ok: true });
}
