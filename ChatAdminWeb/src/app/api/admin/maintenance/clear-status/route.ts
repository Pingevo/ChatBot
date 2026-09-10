// POST /api/admin/maintenance/clear-status — ล้าง status/assigned_to/close_count
// ⚠️ one-shot maintenance route — ลบหลังใช้
//   body: { confirm: "yes" }
//   ล้าง:
//     - status_conversation: status, assigned_to, close_count, closed_at, closed_by
//     - test_status_conversation: status, assigned_to, close_count
import { NextRequest } from "next/server";
import { requireSuperadmin } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { logAdminEvent } from "@/backend/service/adminLogService";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ confirm?: string }>(req);
  if (body?.confirm !== "yes") {
    return error('require confirm: "yes" in body', 400);
  }

  const results: Record<string, unknown> = {};

  // B1 — status_conversation (ticket)
  try {
    const coll = await getCollection(COLLECTIONS.statusConversation);
    const before = await coll.countDocuments({ status: { $exists: true } });
    const res = await coll.updateMany(
      {},
      { $unset: { status: "", assigned_to: "", close_count: "", closed_at: "", closed_by: "" } }
    );
    const after = await coll.countDocuments({ status: { $exists: true } });
    results.status_conversation = {
      matched: res.matchedCount,
      modified: res.modifiedCount,
      had_status_before: before,
      has_status_after: after,
    };
  } catch (e) {
    results.status_conversation = { error: String(e) };
  }

  // B2 — test_status_conversation (test pages)
  try {
    const coll = await getCollection(COLLECTIONS.testStatusConversation);
    const before = await coll.countDocuments({ status: { $exists: true } });
    const res = await coll.updateMany(
      {},
      { $unset: { status: "", assigned_to: "", close_count: "" } }
    );
    const after = await coll.countDocuments({ status: { $exists: true } });
    results.test_status_conversation = {
      matched: res.matchedCount,
      modified: res.modifiedCount,
      had_status_before: before,
      has_status_after: after,
    };
  } catch (e) {
    results.test_status_conversation = { error: String(e) };
  }

  // ⚡ G1 — log maintenance clear-status (destructive operation)
  await logAdminEvent({
    action_type: "admin.maintenance.clear_status",
    actor: r.ctx.admin.admin_id,
    metadata: results,
    ip: r.ctx.ip,
  });

  return json({ ok: true, results });
}
