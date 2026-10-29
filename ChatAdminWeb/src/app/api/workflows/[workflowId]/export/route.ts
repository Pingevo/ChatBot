// GET /api/workflows/[workflowId]/export — canonical-workflow/1 export (list card download)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { workflowService } from "@/backend/service/workflowService";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { workflowId } = await params;
  const pkg = await workflowService.getWorkflowCanonicalExport(workflowId);
  if (!pkg) return error("workflow not found", 404);
  return json(pkg);
}
