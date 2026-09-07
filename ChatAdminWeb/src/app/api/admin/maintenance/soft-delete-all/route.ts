// POST /api/admin/maintenance/soft-delete-all — soft delete ข้อมูลทั้งหมด
// ⚠️ one-shot maintenance route — ลบหลังใช้
//   body: { confirm: "yes" }
//   soft delete: shadow_replies, test_assignment, test_chat_sessions, test_chat_ratings
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
    return error("confirm: 'yes' required", 400);
  }

  const now = new Date();
  const results: Array<{ collection: string; softDeleted: number }> = [];

  const targets = [
    { coll: COLLECTIONS.shadowReplies, label: "shadow_replies" },
    { coll: COLLECTIONS.testAssignment, label: "test_assignment" },
    { coll: COLLECTIONS.testChatSessions, label: "test_chat_sessions" },
    { coll: COLLECTIONS.testChatRatings, label: "test_chat_ratings" },
  ];

  for (const { coll, label } of targets) {
    const collection = await getCollection(coll);
    const result = await collection.updateMany(
      { deleted_at: { $exists: false } },
      {
        $set: {
          deleted_at: now,
          deleted_by: r.ctx.admin.admin_id,
          delete_reason: "clear_all_phase3b",
          updated_at: now,
        },
      }
    );
    results.push({ collection: label, softDeleted: result.modifiedCount });
  }

  await logAdminEvent({
    action_type: "shadow_reply.clear_all" as never,
    actor: r.ctx.admin.admin_id,
    metadata: { results, reason: "clear_all_phase3b" },
  });

  return json({ ok: true, results });
}
