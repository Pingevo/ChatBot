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

// ─── Types ────────────────────────────────────────────────

export type WorkflowTriggerFrequency = "once_per_customer" | "once_per_conversation" | "every_time";
export type WorkflowFalseBranchPolicy = "exit_to_bot" | "exit_drop" | "stay_retry";
export type WorkflowStatus = "draft" | "published";

export type WorkflowNodeType = "trigger" | "condition" | "action" | "wait";

export interface WorkflowNode {
  node_id: string;
  type: WorkflowNodeType;
  subtype: string;         // ดูตารางใน workflow-planner.md
  config: Record<string, unknown>;
  position: { x: number; y: number }; // สำหรับ canvas
}

export interface WorkflowEdge {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  branch?: string; // ⚡ generic string — รองรับทั้ง legacy "true"/"false" และ multi-branch branch_id
}

// ─── Multi-branch Condition (Phase 1 — Zaapi pattern) ─────
// ⚡ backward compatible: condition node subtype message_content
//    - เก่า: config = { mode, text, retry_message } → engine ประเมิน true/false
//    - ใหม่: config = { source, branches[], fallback_branch_id } → engine ประเมิน branch_id
//    engine ตรวจ Array.isArray(config.branches) เพื่อแยกว่าเป็น multi-branch หรือ legacy
export type ConditionMatchType = "contains_any" | "contains_all" | "equals";

export interface ConditionBranch {
  branch_id: string;         // "b1","b2"... ใช้เป็น edge.branch ด้วย
  match_type: ConditionMatchType;
  keywords: string[];
  label?: string;            // แสดงบน UI เช่น "สั่งซื้อสินค้า"
}

export interface MessageContentConfig {
  source: "customer_reply" | "initial_message";
  branches: ConditionBranch[];
  fallback_branch_id: string; // ถ้าไม่ตรงเงื่อนไขเลย → ใช้ branch นี้
}

/** type guard: config เป็น multi-branch หรือไม่ */
export function isMultiBranchCondition(config: unknown): config is MessageContentConfig {
  return !!config && typeof config === "object"
    && Array.isArray((config as MessageContentConfig).branches)
    && typeof (config as MessageContentConfig).fallback_branch_id === "string";
}

// ─── Phase 2 — Wait for Reply (retry + timeout + 3-branch) ─
// ⚡ backward compatible: wait_for_reply node
//    - เก่า: config = { timeout_ms? } → รอ reply เดียว + global timeout
//    - ใหม่: config = { answer_type, max_retries, retry_message?, timeout_ms } → retry + 3 branch
//    engine ตรวจ config.answer_type !== undefined เพื่อแยกว่าเป็น Phase 2 หรือ legacy
export type WaitAnswerType = "any" | "number" | "custom_keywords";

export interface WaitForReplyConfig {
  answer_type: WaitAnswerType;
  max_retries: number;      // ถามซ้ำได้กี่ครั้ง (default 3)
  retry_message?: string;   // ข้อความถามซ้ำ (ถ้าไม่ระบุ ใช้ default)
  timeout_ms: number;       // per-node timeout (ms) — ถ้าเกิน → branch "no_reply"
  custom_keywords?: string[]; // สำหรับ answer_type = "custom_keywords" — คำที่ถือว่าเป็นคำตอบที่ถูก
}

/** type guard: config เป็น Phase 2 wait (มี answer_type) หรือ legacy */
export function isPhase2WaitConfig(config: unknown): config is WaitForReplyConfig {
  return !!config && typeof config === "object"
    && typeof (config as WaitForReplyConfig).answer_type === "string";
}

/** 3 branch ที่ออกจาก wait node (Phase 2) */
export const WAIT_BRANCH = {
  SUCCESS: "success",
  RETRY_EXCEEDED: "retry_exceeded",
  NO_REPLY: "no_reply",
} as const;

// ─── Phase 3 — Add Label: Tag Picker ──────────────────────
// ⚡ backward compatible: add_label node
//    - เก่า: config = { label: string } → ติด label เดียว
//    - ใหม่: config = { label_ids: string[] } → ติดหลาย label (chip picker)
//    engine ตรวจ Array.isArray(config.label_ids) เพื่อแยก
export interface AddLabelConfig {
  label_ids: string[];   // label ที่เลือกจาก TagPicker
}

/** type guard: config เป็น Phase 3 add_label (มี label_ids array) หรือ legacy */
export function isPhase3AddLabelConfig(config: unknown): config is AddLabelConfig {
  return !!config && typeof config === "object"
    && Array.isArray((config as AddLabelConfig).label_ids);
}

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

/** ตรวจ node graph พื้นฐานก่อน save — กัน graph พังทำ engine ลูปไม่รู้จบ
 *  ⚡ graph ว่างทั้งคู่ (nodes=[] + edges=[]) = draft shell ที่สร้างจาก modal → อนุญาต */
export function validateWorkflowGraph(doc: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const nodeIds = new Set(doc.nodes.map((n) => n.node_id));

  // ⚡ draft shell — ยังไม่มี node เลย = อนุญาต (user จะวาดใน editor)
  if (doc.nodes.length === 0 && doc.edges.length === 0) {
    return { ok: true, errors: [] };
  }
  if (doc.nodes.length === 0 && doc.edges.length > 0) {
    errors.push("มี edges แต่ไม่มี nodes");
  }

  // node_id ห้ามซ้ำ
  if (nodeIds.size !== doc.nodes.length) {
    errors.push("node_id ซ้ำกันใน graph");
  }

  // ต้องมี trigger node แค่ 1 ตัว (จุดเริ่ม flow)
  const triggerNodes = doc.nodes.filter((n) => n.type === "trigger");
  if (triggerNodes.length === 0) errors.push("ต้องมี trigger node อย่างน้อย 1 ตัว");
  if (triggerNodes.length > 1) errors.push("มี trigger node ได้แค่ 1 ตัว (จุดเริ่ม flow)");

  // edge ต้องอ้าง node ที่มีอยู่จริง
  for (const e of doc.edges) {
    if (!nodeIds.has(e.source_node_id)) errors.push(`edge ${e.edge_id}: source ${e.source_node_id} ไม่มีอยู่`);
    if (!nodeIds.has(e.target_node_id)) errors.push(`edge ${e.edge_id}: target ${e.target_node_id} ไม่มีอยู่`);
  }

  // trigger node ต้องมี edge ออก
  for (const t of triggerNodes) {
    const hasOut = doc.edges.some((e) => e.source_node_id === t.node_id);
    if (!hasOut) errors.push(`trigger node ${t.node_id} ไม่มี edge ออก`);
  }

  // ⚡ Phase 1 — multi-branch condition validation
  // สำหรับ condition node subtype message_content ที่ใช้ multi-branch config
  // legacy binary (mode/text) ไม่ต้อง validate เพิ่ม เพราะ engine ยังรองรับ
  for (const n of doc.nodes) {
    if (n.type !== "condition" || n.subtype !== "message_content") continue;
    if (!isMultiBranchCondition(n.config)) continue;

    const cfg = n.config;
    const branchIds = new Set<string>();
    for (const b of cfg.branches) {
      if (!b.branch_id || !b.branch_id.trim()) {
        errors.push(`condition ${n.node_id}: branch_id ห้ามว่าง`);
        continue;
      }
      if (branchIds.has(b.branch_id)) {
        errors.push(`condition ${n.node_id}: branch_id "${b.branch_id}" ซ้ำกัน`);
      }
      branchIds.add(b.branch_id);
      if (!Array.isArray(b.keywords) || b.keywords.length === 0) {
        errors.push(`condition ${n.node_id}: branch "${b.branch_id}" ต้องมี keywords อย่างน้อย 1 คำ`);
      }
      if (!["contains_any", "contains_all", "equals"].includes(b.match_type)) {
        errors.push(`condition ${n.node_id}: branch "${b.branch_id}" match_type ไม่ถูกต้อง`);
      }
    }
    // fallback_branch_id ต้องไม่ตรงกับ branch_id ใดๆ
    if (!cfg.fallback_branch_id || !cfg.fallback_branch_id.trim()) {
      errors.push(`condition ${n.node_id}: fallback_branch_id ห้ามว่าง`);
    } else if (branchIds.has(cfg.fallback_branch_id)) {
      errors.push(`condition ${n.node_id}: fallback_branch_id "${cfg.fallback_branch_id}" ต้องไม่ตรงกับ branch_id ใดๆ`);
    }

    // edge ที่ออกจาก condition node นี้ ต้องมี branch ตรงกับ branch_id หรือ fallback_branch_id
    const validBranches = new Set([...branchIds, cfg.fallback_branch_id]);
    for (const e of doc.edges) {
      if (e.source_node_id !== n.node_id) continue;
      if (e.branch === undefined || e.branch === "") {
        errors.push(`edge ${e.edge_id}: ออกจาก multi-branch condition ${n.node_id} แต่ไม่มี branch`);
        continue;
      }
      if (!validBranches.has(e.branch)) {
        errors.push(`edge ${e.edge_id}: branch "${e.branch}" ไม่มีใน condition ${n.node_id}`);
      }
    }
  }

  // ⚡ Phase 2 — wait_for_reply node validation
  // ถ้า wait node มี Phase 2 config (answer_type) → edge ต้องเป็น success/retry_exceeded/no_reply
  // ทั้ง 3 branch optional — ถ้าไม่มี edge ของ branch นั้น engine จบ flow ด้วย outcome นั้น
  // แต่ถ้ามี edge ที่อ้าง branch อื่นที่ไม่ใช่ 3 ตัวนี้ → reject (กัน ghost branch)
  for (const n of doc.nodes) {
    if (n.type !== "wait" || n.subtype !== "wait_for_reply") continue;
    if (!isPhase2WaitConfig(n.config)) continue;

    const validWaitBranches: Set<string> = new Set([WAIT_BRANCH.SUCCESS, WAIT_BRANCH.RETRY_EXCEEDED, WAIT_BRANCH.NO_REPLY]);
    for (const e of doc.edges) {
      if (e.source_node_id !== n.node_id) continue;
      if (e.branch === undefined || e.branch === "") {
        // legacy wait edge (ไม่มี branch) — ยังอนุญาต เพราะ engine ใช้เป็น fallback ถ้าไม่มี success edge
        continue;
      }
      if (!validWaitBranches.has(e.branch)) {
        errors.push(`edge ${e.edge_id}: wait node ${n.node_id} branch "${e.branch}" ไม่ถูกต้อง — ต้องเป็น success/retry_exceeded/no_reply`);
      }
    }

    // max_retries ต้อง >= 0
    const maxRetries = Number(n.config.max_retries);
    if (isNaN(maxRetries) || maxRetries < 0) {
      errors.push(`wait node ${n.node_id}: max_retries ต้องเป็นตัวเลข >= 0`);
    }
    // timeout_ms ต้อง > 0
    const timeoutMs = Number(n.config.timeout_ms);
    if (isNaN(timeoutMs) || timeoutMs <= 0) {
      errors.push(`wait node ${n.node_id}: timeout_ms ต้องเป็นตัวเลข > 0`);
    }
    // answer_type ต้องถูกต้อง
    if (!["any", "number", "custom_keywords"].includes(n.config.answer_type)) {
      errors.push(`wait node ${n.node_id}: answer_type ไม่ถูกต้อง — ต้องเป็น any/number/custom_keywords`);
    }
    // ถ้า answer_type = custom_keywords → ต้องมี custom_keywords >= 1
    if (n.config.answer_type === "custom_keywords") {
      const kws = n.config.custom_keywords;
      if (!Array.isArray(kws) || kws.length === 0) {
        errors.push(`wait node ${n.node_id}: answer_type=custom_keywords ต้องมี custom_keywords >= 1`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
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
