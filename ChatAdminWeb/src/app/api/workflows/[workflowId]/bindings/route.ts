// GET  /api/workflows/[workflowId]/bindings — binding-resolution read view (display data)
// POST /api/workflows/[workflowId]/bindings — save direct-resolution batch
//   thin layer: auth → service owner → HTTP status map (zero Mongo in this file)
import { NextRequest } from "next/server";
import { requireAuth, requirePageEdit } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { workflowService } from "@/backend/service/workflowService";
import type { BindingResolutionRequest } from "@/backend/service/workflowService";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { workflowId } = await params;
  const view = await workflowService.getBindingResolutionView(workflowId);
  if (!view) return error("workflow not found", 404);
  return json(view);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const r = await requirePageEdit(req, "workflow");
  if (!r.ok) return r.response;
  const { workflowId } = await params;

  const body = await readJson<BindingResolutionRequest>(req);
  if (!body) return error("invalid body", 400);

  try {
    const res = await workflowService.saveBindingResolutionBatch(workflowId, body, r.ctx.admin.admin_id);
    if (res.not_found) return error("workflow not found", 404);
    if (res.conflict) {
      return json({ detail: `version conflict — current is v${res.current_version}, reload before editing`,
        current_version: res.current_version, current_version_id: res.current_version_id }, 409);
    }
    if (res.validation) return error(res.validation, 422);
    return json(res);
  } catch (err) {
    return error(`binding resolution failed: ${(err as Error).message}`, 500);
  }
}
