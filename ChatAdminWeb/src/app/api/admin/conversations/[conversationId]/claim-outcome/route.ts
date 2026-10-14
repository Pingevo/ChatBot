// POST /api/admin/conversations/:id/claim-outcome — explicit admin claim outcome
// ⚡ Phase 2B.6 — episode-scoped terminal command (resolved|cancelled)
//   transport adapter เท่านั้น — Mongo/CAS/idempotency อยู่ใน
//   statusConversationService.applyClaimOutcome (owner เดียว)
//   แยกจาก close/resolve conversation — ordinary close ไม่จบ claim episode
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { statusConversationService } from "@/backend/service/statusConversationService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
// ⚡ G-fix — invalidate botworker cache ด้วย
async function invalidateBotworkerCache() {
  try {
    const mod = await import("@/app/api/botworker/conversations/route");
    if (typeof (mod as unknown as { invalidateBotworkerCache?: () => void }).invalidateBotworkerCache === "function") {
      (mod as unknown as { invalidateBotworkerCache: () => void }).invalidateBotworkerCache();
    }
  } catch { /* ignore */ }
}

const MAX_EPISODE_ID_LEN = 128;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = (await req.json().catch(() => null)) as {
    episode_id?: unknown;
    outcome?: unknown;
  } | null;
  // strict wire shape — outcome เป็น enum เท่านั้น ห้าม infer จาก free text
  const episodeId = body?.episode_id;
  const outcome = body?.outcome;
  if (
    !body
    || typeof episodeId !== "string"
    || episodeId.length === 0
    || episodeId.length > MAX_EPISODE_ID_LEN
    || (outcome !== "resolved" && outcome !== "cancelled")
  ) {
    return error("episode_id (string) + outcome (resolved|cancelled) required", 422);
  }

  try {
    const r2 = await statusConversationService.applyClaimOutcome(
      conversationId,
      { episodeId, outcome, actorId: r.ctx.admin.admin_id }
    );
    if (r2.result === "applied" || r2.result === "already_applied") {
      invalidateConversationsCache();
      invalidateBotworkerCache();
      // ⚡ คืน authoritative persisted outcome เสมอ — caller/UI ห้ามใช้
      //   outcome ที่ request เอง (conflicting retry ต้องเห็น terminal จริง)
      return json({ ok: true, result: r2.result, claim_outcome: r2.claimOutcome ?? null });
    }
    // stale/no-claim = conflict กับ resource state — ไม่ใช่ server error
    return json({ ok: false, result: r2.result }, r2.result === "invalid" ? 422 : 409);
  } catch {
    return error("claim outcome failed", 500);
  }
}
