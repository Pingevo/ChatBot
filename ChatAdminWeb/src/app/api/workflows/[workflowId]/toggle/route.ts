// POST /api/workflows/[workflowId]/toggle — enable/disable workflow
// body: { enabled: boolean }
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { workflowService } from "@/backend/service/workflowService";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;
  const { workflowId } = await params;

  const body = await readJson<{ enabled?: boolean }>(req);
  if (!body || typeof body.enabled !== "boolean") {
    return error("enabled (boolean) is required", 422);
  }

  const ok = await workflowService.toggleWorkflow(workflowId, body.enabled, r.ctx.admin.admin_id);
  if (!ok) return error("workflow not found", 404);
  return json({ ok: true, enabled: body.enabled });
}
