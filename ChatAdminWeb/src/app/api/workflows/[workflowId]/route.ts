// GET    /api/workflows/[workflowId] — get one workflow (nodes + edges สำหรับ canvas editor)
// PATCH  /api/workflows/[workflowId] — update workflow (name/settings/graph)
// DELETE /api/workflows/[workflowId] — soft delete
import { NextRequest } from "next/server";
import { requireAuth, requirePageEdit } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { workflowService } from "@/backend/service/workflowService";
import type { Platform } from "@/backend/service/conversationService";
import type {
  WorkflowTriggerFrequency, WorkflowFalseBranchPolicy, WorkflowStatus,
  WorkflowNode, WorkflowEdge,
} from "@/backend/service/workflowService";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { workflowId } = await params;
  const workflow = await workflowService.getWorkflow(workflowId);
  if (!workflow) return error("workflow not found", 404);
  const importDetail = await workflowService.getWorkflowImportDetail(workflowId);
  return json({ workflow, import_detail: importDetail });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const r = await requirePageEdit(req, "workflow");
  if (!r.ok) return r.response;
  const { workflowId } = await params;

  const body = await readJson<{
    name?: string;
    description?: string;
    shop_ids?: string[];
    platforms?: Platform[];
    trigger_frequency?: WorkflowTriggerFrequency;
    false_branch_policy?: WorkflowFalseBranchPolicy;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
    priority?: number;
    enabled?: boolean;
    status?: WorkflowStatus;
    expected_version?: number;
  }>(req);

  if (!body) return error("invalid body", 400);

  // validate enum fields
  if (body.trigger_frequency && !["once_per_customer", "once_per_conversation", "every_time"].includes(body.trigger_frequency)) {
    return error("trigger_frequency must be once_per_customer | once_per_conversation | every_time", 422);
  }
  if (body.false_branch_policy && !["exit_to_bot", "exit_drop", "stay_retry"].includes(body.false_branch_policy)) {
    return error("false_branch_policy must be exit_to_bot | exit_drop | stay_retry", 422);
  }
  if (body.status && !["draft", "published"].includes(body.status)) {
    return error("status must be draft or published", 422);
  }

  const fields: Record<string, unknown> = {};
  if (body.name !== undefined) fields.name = body.name;
  if (body.description !== undefined) fields.description = body.description;
  if (body.shop_ids !== undefined) fields.shop_ids = body.shop_ids;
  if (body.platforms !== undefined) fields.platforms = body.platforms;
  if (body.trigger_frequency !== undefined) fields.trigger_frequency = body.trigger_frequency;
  if (body.false_branch_policy !== undefined) fields.false_branch_policy = body.false_branch_policy;
  if (body.nodes !== undefined) fields.nodes = body.nodes;
  if (body.edges !== undefined) fields.edges = body.edges;
  if (body.priority !== undefined) fields.priority = body.priority;
  if (body.enabled !== undefined) fields.enabled = body.enabled;
  if (body.status !== undefined) fields.status = body.status;

  if (Object.keys(fields).length === 0) return error("no fields to update", 422);

  try {
    // CAS path — editor ส่ง expected_version (version ตอนโหลด) → stale = 409 conflict
    if (body.expected_version !== undefined) {
      const cas = await workflowService.saveWorkflowDraft(workflowId, fields as never, body.expected_version, r.ctx.admin.admin_id);
      if (cas.not_found) return error("workflow not found", 404);
      if (cas.conflict) return error(`version conflict — current is v${cas.current_version}, reload before editing`, 409);
      return json({ ok: true, version: cas.version, version_id: cas.version_id });
    }
    const ok = await workflowService.updateWorkflow(workflowId, fields as never, r.ctx.admin.admin_id);
    if (!ok) return error("workflow not found or no changes", 404);
    return json({ ok: true });
  } catch (err) {
    const e = err as Error & { code?: string };
    // imported + version-owned fields without CAS → explicit 422 (not 404)
    if (e.code === "CAS_REQUIRED") return error(e.message, 422);
    // graph validation fail → 422 พร้อม errors
    return error(e.message, 422);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const r = await requirePageEdit(req, "workflow");
  if (!r.ok) return r.response;
  const { workflowId } = await params;

  const ok = await workflowService.deleteWorkflow(workflowId, r.ctx.admin.admin_id);
  if (!ok) return error("workflow not found", 404);
  return json({ ok: true });
}
