// Workflow service — CRUD สำหรับ collection `workflows` (แบบ Zaapi Flow Builder)
// ใช้ร่วมกับ workflowEngine.ts ที่รัน flow จริง
//
// โครงสร้าง: WorkflowDoc = node graph (nodes + edges) สำหรับ visual builder
//   - nodes: แต่ละ node มี type (trigger/condition/action/wait) + subtype + config + position
//   - edges: เชื่อม source_node_id → target_node_id (+ branch true/false สำหรับ condition)
//
// ⚠️ ห้าม hard delete — ใช้ soft delete (is_deleted) เหมือน triggerService
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "./systemConfigService";
import { logAdminEvent } from "./adminLogService";
import { pickAllowed } from "../lib/sanitizeFields";
import { validateWorkflowGraph } from "../../lib/workflow/graph";
import type {
  WorkflowTriggerFrequency, WorkflowFalseBranchPolicy, WorkflowStatus,
  WorkflowNode, WorkflowEdge,
} from "../../lib/workflow/graph";

// ─── Types ────────────────────────────────────────────────
// ⚡ pure graph types + validateWorkflowGraph ย้ายไป src/lib/workflow/graph.ts
//    (import ได้โดยไม่ชน env gate) — re-export ที่นี่เพื่อคง public API เดิม
export type {
  WorkflowTriggerFrequency, WorkflowFalseBranchPolicy, WorkflowStatus,
  WorkflowNodeType, WorkflowNode, WorkflowEdge,
  ConditionMatchType, ConditionBranch, MessageContentConfig,
  WaitAnswerType, WaitForReplyConfig, AddLabelConfig,
} from "../../lib/workflow/graph";
export {
  validateWorkflowGraph, isMultiBranchCondition, isPhase2WaitConfig,
  isPhase3AddLabelConfig, WAIT_BRANCH,
} from "../../lib/workflow/graph";

export interface WorkflowDoc extends Document {
  workflow_id: string;
  name: string;
  // ⚡ description — ตั้งตอนสร้าง แก้ได้ภายหลัง
  description?: string;
  enabled: boolean;

  // กรองว่า flow นี้ทำงานกับ channel ไหน ([] = ทั้งหมด)
  shop_ids: string[];
  platforms: Platform[];

  // trigger frequency (เหมือน Zaapi)
  trigger_frequency: WorkflowTriggerFrequency;

  // นโยบายตอน condition false
  false_branch_policy: WorkflowFalseBranchPolicy;

  // node graph (สำหรับ visual builder)
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];

  // ลำดับความสำคัญตอนหลาย flow ฮิตพร้อมกัน (สูง = มาก่อน)
  priority: number;

  version: number;
  status: WorkflowStatus;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  updated_by?: string;
  // Soft delete
  is_deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string;
  // Restore (หลัง soft delete)
  restored_at?: Date | null;
  restored_by?: string;
}

// ─── Helpers ──────────────────────────────────────────────

function genWorkflowId(): string {
  return "wf_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── CRUD ─────────────────────────────────────────────────

export async function createWorkflow(opts: {
  name: string;
  description?: string;
  shopIds?: string[];
  platforms?: Platform[];
  triggerFrequency?: WorkflowTriggerFrequency;
  falseBranchPolicy?: WorkflowFalseBranchPolicy;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  priority?: number;
  enabled?: boolean;
  status?: WorkflowStatus;
  createdBy: string;
}): Promise<WorkflowDoc> {
  const nodes = opts.nodes || [];
  const edges = opts.edges || [];
  const graph = validateWorkflowGraph({ nodes, edges });
  if (!graph.ok) {
    throw new Error("workflow graph invalid: " + graph.errors.join("; "));
  }

  const coll = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  const now = new Date();
  const doc: WorkflowDoc = {
    workflow_id: genWorkflowId(),
    name: opts.name,
    description: opts.description,
    enabled: opts.enabled ?? false,
    shop_ids: opts.shopIds || [],
    platforms: opts.platforms || [],
    trigger_frequency: opts.triggerFrequency || "every_time",
    false_branch_policy: opts.falseBranchPolicy || "exit_to_bot",
    nodes,
    edges,
    priority: opts.priority ?? 0,
    version: 1,
    status: opts.status || "draft",
    created_by: opts.createdBy,
    created_at: now,
    updated_at: now,
  };
  await coll.insertOne(doc);
  await logAdminEvent({
    action_type: "workflow.create",
    actor: opts.createdBy,
    metadata: { workflow_id: doc.workflow_id, name: doc.name, node_count: doc.nodes.length },
  });
  return doc;
}

export async function listWorkflows(opts: {
  shopId?: string;
  platform?: Platform;
  enabledOnly?: boolean;
  publishedOnly?: boolean;
} = {}): Promise<WorkflowDoc[]> {
  const coll = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  const filter: Record<string, unknown> = { is_deleted: { $ne: true } };

  // เหมือน triggerService — shop_ids/platforms ว่าง = ทุก channel
  const andConditions: Record<string, unknown>[] = [];
  if (opts.shopId) {
    andConditions.push({ $or: [{ shop_ids: opts.shopId }, { shop_ids: { $size: 0 } }] });
  }
  if (opts.platform) {
    andConditions.push({ $or: [{ platforms: opts.platform }, { platforms: { $size: 0 } }] });
  }
  if (andConditions.length > 0) filter.$and = andConditions;
  if (opts.enabledOnly) filter.enabled = true;
  if (opts.publishedOnly) filter.status = "published";

  return coll.find(filter).sort({ priority: -1, created_at: -1 }).toArray();
}

export async function getWorkflow(workflowId: string): Promise<WorkflowDoc | null> {
  const coll = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  return coll.findOne({ workflow_id: workflowId, is_deleted: { $ne: true } });
}

export async function updateWorkflow(
  workflowId: string,
  fields: Partial<
    Pick<WorkflowDoc,
      | "name" | "description" | "shop_ids" | "platforms" | "trigger_frequency" | "false_branch_policy"
      | "nodes" | "edges" | "priority" | "enabled" | "status"
    >
  >,
  updatedBy?: string
): Promise<boolean> {
  // ถ้าแก้ graph → validate ก่อน
  if (fields.nodes || fields.edges) {
    const current = await getWorkflow(workflowId);
    if (!current) return false;
    const graph = validateWorkflowGraph({
      nodes: fields.nodes || current.nodes,
      edges: fields.edges || current.edges,
    });
    if (!graph.ok) {
      throw new Error("workflow graph invalid: " + graph.errors.join("; "));
    }
  }

  const coll = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  // 🔒 allowlist fields (defense-in-depth — route กรองแล้ว)
  const WORKFLOW_UPDATE_ALLOWLIST = [
    "name", "description", "shop_ids", "platforms", "trigger_frequency", "false_branch_policy",
    "nodes", "edges", "priority", "enabled", "status",
  ] as const;
  const safeFields = pickAllowed(fields as Record<string, unknown>, WORKFLOW_UPDATE_ALLOWLIST);

  // ⚡ เก็บค่าเดิมเพื่อ log ว่าเปลี่ยนจากอะไรเป็นอะไร
  const before = await coll.findOne({ workflow_id: workflowId, is_deleted: { $ne: true } });

  const result = await coll.updateOne(
    { workflow_id: workflowId, is_deleted: { $ne: true } },
    { $set: { ...safeFields, updated_at: new Date(), updated_by: updatedBy }, $inc: { version: 1 } }
  );
  if (result.modifiedCount > 0) {
    // ⚡ log แบบ before→after แต่ละ field ที่เปลี่ยน
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (before) {
      for (const key of Object.keys(safeFields)) {
        const oldVal = (before as Record<string, unknown>)[key];
        const newVal = safeFields[key];
        // ไม่ log ถ้าค่าเดียวกัน (JSON.stringify เปรียบเทียบ deep equal)
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes[key] = { from: oldVal, to: newVal };
        }
      }
    }
    await logAdminEvent({
      action_type: "workflow.update",
      actor: updatedBy || "system",
      metadata: {
        workflow_id: workflowId,
        workflow_name: before?.name || "(unknown)",
        fields: Object.keys(safeFields),
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      },
    });
  }
  return result.modifiedCount > 0;
}

export async function toggleWorkflow(workflowId: string, enabled: boolean, updatedBy?: string): Promise<boolean> {
  const coll = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  // ⚡ เก็บค่าเดิมเพื่อ log
  const before = await coll.findOne({ workflow_id: workflowId, is_deleted: { $ne: true } });
  const result = await coll.updateOne(
    { workflow_id: workflowId, is_deleted: { $ne: true } },
    { $set: { enabled, updated_at: new Date(), updated_by: updatedBy }, $inc: { version: 1 } }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "workflow.toggle",
      actor: updatedBy || "system",
      metadata: {
        workflow_id: workflowId,
        workflow_name: before?.name || "(unknown)",
        enabled,
        previous_enabled: before?.enabled,
      },
    });
  }
  return result.modifiedCount > 0;
}

export async function deleteWorkflow(workflowId: string, deletedBy?: string): Promise<boolean> {
  const coll = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  // ⚡ เก็บค่าเดิมเพื่อ log ชื่อ flow
  const before = await coll.findOne({ workflow_id: workflowId, is_deleted: { $ne: true } });
  // Soft delete — never hard delete
  const result = await coll.updateOne(
    { workflow_id: workflowId, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, deleted_at: new Date(), deleted_by: deletedBy, enabled: false }, $inc: { version: 1 } }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "workflow.delete",
      actor: deletedBy || "system",
      metadata: {
        workflow_id: workflowId,
        workflow_name: before?.name || "(unknown)",
        soft_delete: true,
        previous_enabled: before?.enabled,
      },
    });
  }
  return result.modifiedCount > 0;
}

// ⚡ restore — กู้คืน workflow ที่ถูก soft delete
export async function restoreWorkflow(workflowId: string, restoredBy?: string): Promise<boolean> {
  const coll = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  const before = await coll.findOne({ workflow_id: workflowId, is_deleted: true });
  if (!before) return false; // ไม่มีหรือไม่ได้ถูกลบ
  const result = await coll.updateOne(
    { workflow_id: workflowId, is_deleted: true },
    { $set: { is_deleted: false, deleted_at: null as unknown as undefined, deleted_by: null as unknown as undefined, restored_at: new Date(), restored_by: restoredBy, updated_at: new Date(), updated_by: restoredBy }, $inc: { version: 1 } }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "workflow.restore",
      actor: restoredBy || "system",
      metadata: {
        workflow_id: workflowId,
        workflow_name: before.name || "(unknown)",
        restored: true,
      },
    });
  }
  return result.modifiedCount > 0;
}

export const workflowService = {
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  toggleWorkflow,
  deleteWorkflow,
  restoreWorkflow,
  validateWorkflowGraph,
};
