// API: /api/chat-annotations/[annotationId]
//
// ⚡ Phase 3B-1 — delete annotation
//
// DELETE /api/chat-annotations/[annotationId]
//   → soft delete annotation (เก็บประวัติ — กู้คืนได้)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { chatAnnotationService } from "@/backend/service/chatAnnotationService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ annotationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { annotationId } = await params;
  const ok = await chatAnnotationService.deleteAnnotation(annotationId, r.ctx.admin.admin_id);
  if (!ok) return error("annotation not found", 404);

  // ⚡ Phase 3B-1 — audit log: ลบ annotation (soft delete)
  await logAdminEvent({
    action_type: "chat_annotation.delete",
    actor: r.ctx.admin.admin_id,
    metadata: {
      annotation_id: annotationId,
      soft_delete: true,
    },
  });

  return json({ ok: true, soft_deleted: true });
}
