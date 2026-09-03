// GET  /api/workflows — list workflows (multi-platform/shop aware)
// POST /api/workflows — create new workflow (Flow Builder)
//
// ⚡ Workflow engine (แบบ Zaapi Flow Builder) — อ้างอิง workflow-planner.md
// Graph validation อยู่ใน workflowService.validateWorkflowGraph (service ตรวจซ้ำอีกชั้น)
import { NextRequest } from "next/server";
import { requireAuth, requireEditor } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { workflowService } from "@/backend/service/workflowService";
import type { Platform } from "@/backend/service/conversationService";
import type {
  WorkflowTriggerFrequency, WorkflowFalseBranchPolicy, WorkflowStatus,
  WorkflowNode, WorkflowEdge,
} from "@/backend/service/workflowService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const shopId = url.searchParams.get("shop_id") || undefined;
  const platform = (url.searchParams.get("platform") as Platform | null) || undefined;
  const enabledOnly = url.searchParams.get("enabled_only") === "true";
  const publishedOnly = url.searchParams.get("published_only") === "true";

  const workflows = await workflowService.listWorkflows({ shopId, platform, enabledOnly, publishedOnly });
  return json({ rows: workflows, total: workflows.length });
}

export async function POST(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

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
  }>(req);

  if (!body || !body.name || !body.name.trim()) return error("name is required", 422);
  // ⚡ nodes/edges ว่างได้ — สร้าง draft shell จาก modal แล้ววาด graph ใน editor
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];
  if (body.trigger_frequency && !["once_per_customer", "once_per_conversation", "every_time"].includes(body.trigger_frequency)) {
    return error("trigger_frequency must be once_per_customer | once_per_conversation | every_time", 422);
  }
  if (body.false_branch_policy && !["exit_to_bot", "exit_drop", "stay_retry"].includes(body.false_branch_policy)) {
    return error("false_branch_policy must be exit_to_bot | exit_drop | stay_retry", 422);
  }
  if (body.status && !["draft", "published"].includes(body.status)) {
    return error("status must be draft or published", 422);
  }

  try {
    const doc = await workflowService.createWorkflow({
      name: body.name.trim(),
      description: body.description?.trim() || undefined,
      shopIds: body.shop_ids || [],
      platforms: body.platforms || [],
      triggerFrequency: body.trigger_frequency,
      falseBranchPolicy: body.false_branch_policy,
      nodes,
      edges,
      priority: body.priority,
      enabled: body.enabled ?? false,
      status: body.status || "draft",
      createdBy: r.ctx.admin.admin_id,
    });
    return json({ workflow: doc });
  } catch (err) {
    // graph validation fail → 422 พร้อม errors
    return error((err as Error).message, 422);
  }
}
