// POST /api/workflows/[workflowId]/restore — กู้คืน workflow ที่ถูก soft delete
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { workflowService } from "@/backend/service/workflowService";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;
  const { workflowId } = await params;

  const ok = await workflowService.restoreWorkflow(workflowId, r.ctx.admin.admin_id);
  if (!ok) return error("workflow not found or not deleted", 404);
  return json({ ok: true });
}
