// Workflow service — CRUD สำหรับ collection `workflows` (แบบ Zaapi Flow Builder)
// ใช้ร่วมกับ workflowEngine.ts ที่รัน flow จริง
//
// โครงสร้าง: WorkflowDoc = node graph (nodes + edges) สำหรับ visual builder
//   - nodes: แต่ละ node มี type (trigger/condition/action/wait) + subtype + config + position
//   - edges: เชื่อม source_node_id → target_node_id (+ branch true/false สำหรับ condition)
//
// ⚠️ ห้าม hard delete — ใช้ soft delete (is_deleted) เหมือน triggerService
import { createHash } from "node:crypto";
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "./systemConfigService";
import { logAdminEvent } from "./adminLogService";
import { pickAllowed } from "../lib/sanitizeFields";
import { validateWorkflowGraph } from "../../lib/workflow/graph";
import {
  stableFingerprint, provenanceSnapshot, canonicalJson,
  type BatchImportReport, type BindingRequirement, type CanonicalDraft,
} from "../../lib/workflow/zaapiImport";
import { validateCanonicalDraft, publishReadiness, LOCAL_ENGINE_PLATFORMS } from "../../lib/workflow/nodeRegistry";
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
  // ⚡ Import provenance — มีเฉพาะ flow ที่ import จาก external (zaapi)
  current_version_id?: string;   // pointer → workflow_versions ล่าสุด
  import?: {
    source: "zaapi" | "canonical";
    source_workflow_id: string;
    batch_id: string;
  };
}

// ─── Import persistence doc types ─────────────────────────
export interface WorkflowVersionDoc extends Document {
  version_id: string;
  workflow_id: string;
  version_seq: number;                 // monotonic ต่อ workflow — เท่ากับ workflows.version
  schema_version: "canonical-workflow/1";
  name: string;
  description?: string;
  shop_ids?: string[];
  trigger_frequency?: WorkflowTriggerFrequency;
  false_branch_policy?: WorkflowFalseBranchPolicy;
  priority?: number;
  platforms: Platform[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  handle_labels: Record<string, Record<string, string>>;
  source_ref: CanonicalDraft["sourceRef"];
  import_batch_id?: string;
  fingerprint: string;                 // content fingerprint ของ version นี้
  created_at: Date;
  created_by: string;
}

export interface WorkflowImportBatchDoc extends Document {
  batch_id: string;
  source: "zaapi" | "canonical";
  source_fingerprint: string;
  flow_count: number;
  node_count: number;
  edge_count: number;
  bindings_total: number;
  synthesized_edges: number;
  unresolved_step_refs: number;
  mismatched_step_refs: number;
  warnings: string[];
  conflicts: unknown[];
  status: "in_progress" | "applied" | "failed";
  workflow_ids: string[];
  claim_token?: string | null;
  claim_expires_at?: Date | null;
  last_error?: string;
  created_at: Date;
  created_by: string;
  applied_at?: Date;
}

export interface WorkflowRawSnapshotDoc extends Document {
  snapshot_id: string;
  workflow_id: string;
  version_id: string;
  source_workflow_id: string;   // zaapi workflowId — audit/rebind identity
  source_version_id: string;
  source_status: string;
  fingerprint: string;
  raw: unknown;                 // sanitized provenance — credentials masked, external ids kept for rebind
  created_at: Date;
}

export type BindingStatus = "unresolved" | "resolved" | "invalid";
export interface WorkflowBindingDoc extends Document {
  binding_id: string;
  workflow_id: string;
  version_id: string;
  node_id: string;              // local zn_* id
  field_path: string;
  kind: string;
  count: number;
  source_ref: string;           // path ใน raw snapshot
  source_values: unknown[];     // external ids (rebind data) — credentials ไม่เข้า (raw mask แล้ว)
  status: BindingStatus;
  resolution?: {                // server-computed resolution state (R1 Task 1: direct only)
    mappings: ResolutionMapping[];
    conflict?: string;          // overlap conflict marker (Task 5)
  };
  created_at: Date;
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

// Activation invariant (owner เดียวใน mutation path นี้) — imported workflow
// (มี `import` provenance) ห้าม enabled:true / status:"published" จน publish
// readiness ผ่าน (unresolved bindings=0 + blockers=0 จาก detail surface เดิม)
// legacy workflow ไม่มี provenance → พฤติกรรมเดิม ไม่โดน gate
async function _assertActivationAllowed(
  workflowId: string,
  before: WorkflowDoc,
  fields: { enabled?: unknown; status?: unknown },
): Promise<void> {
  if (fields.enabled !== true && fields.status !== "published") return;
  if (!before.import) return;
  const detail = await getWorkflowImportDetail(workflowId);
  const validationOk = !!detail && detail.unresolved_bindings === 0 && detail.publish_blockers.length === 0;
  // publishReadiness = foundation gate owner — runtimeActivation=false → imported block ทุกตัวรอบนี้
  const ready = validationOk && publishReadiness({
    ok: validationOk, errors: detail?.publish_blockers ?? [],
    unsupportedNodes: [], blockedNodes: [], unresolvedBindings: [],
  }).canPublish;
  if (!ready) {
    throw new Error(
      `imported workflow activation blocked: ${detail?.unresolved_bindings ?? "?"} unresolved bindings, ` +
      `${detail?.publish_blockers.length ?? "?"} publish blockers, foundation gate not open — resolve before enabling/publishing`
    );
  }
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
  // imported workflow: version-owned fields ต้องผ่าน CAS (saveWorkflowDraft+expected_version)
  // — non-CAS path เขียนโดยไม่มี immutable version doc = history bypass
  // enabled/status = activation state (ผ่าน invariant เดิม); ทุก allowed field อื่น = version-owned
  if (before?.import && Object.keys(safeFields).some((k) => k !== "enabled" && k !== "status")) {
    throw Object.assign(
      new Error("imported workflow: version-owned fields require expected_version (CAS saveWorkflowDraft)"),
      { code: "CAS_REQUIRED" }
    );
  }
  if (before) await _assertActivationAllowed(workflowId, before, safeFields);

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
  if (before) await _assertActivationAllowed(workflowId, before, { enabled });
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

// ─── Import persistence (Zaapi canonical → disabled draft) ─
// Consume BatchImportReport จาก zaapiImport preview — batch ต้อง ok + ไม่มี
// unsupported types ไม่งั้น reject ก่อนเขียนอะไรเลย. deterministic ids +
// idempotent findOne→insert (fake Mongo ไม่มี multi-doc tx) — re-apply ปลอดภัย
// enabled:false / status:"draft" เสมอ — ไม่มี auto-publish/runtime activation

function _shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** resolve "nodes[srcId].data.<path>" ใน raw snapshot → external id values (สำหรับ binding.source_values) */
function _resolveRawPath(raw: unknown, ref: string): unknown[] {
  const m = /^nodes\[([^\]]+)\]\.data\.(.+)$/.exec(ref);
  if (!m || !raw || typeof raw !== "object") return [];
  const nodes = (raw as { nodes?: { id?: string; data?: Record<string, unknown> }[] }).nodes || [];
  const node = nodes.find((n) => n.id === m[1]);
  let cur: unknown = node?.data;
  for (const seg of m[2].replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (cur == null || typeof cur !== "object") return [];
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur == null) return [];
  return Array.isArray(cur) ? cur : [cur];
}

export interface ApplyImportResult {
  ok: boolean;
  already_applied?: boolean;
  batch_id: string;
  workflow_ids: string[];
  flow_count: number;
  node_count: number;
  edge_count: number;
  bindings_total: number;
  warnings: string[];
  conflicts: unknown[];
}

function _impErr(msg: string, code: "IMPORT_INVALID" | "IMPORT_IN_PROGRESS"): Error {
  return Object.assign(new Error(msg), { code });
}

const IMPORT_CLAIM_LEASE_MS = 60_000;

// fencing + renewal — stale claimant (takeover) ห้าม mutate workflow/pointer
// ทุก mutable boundary = atomic validate+renew: token เดิมที่ยังครอง ownership
// (lease หมดอายุแต่ไม่ถูก takeover → renew ต่อ; token เปลี่ยน → fenced)
async function _assertImportClaim(
  batches: Awaited<ReturnType<typeof getCollection<WorkflowImportBatchDoc>>>,
  batchId: string, claim: string,
): Promise<void> {
  const r = await batches.updateOne(
    { batch_id: batchId, claim_token: claim, status: "in_progress" },
    { $set: { claim_expires_at: new Date(Date.now() + IMPORT_CLAIM_LEASE_MS) } }
  );
  if (r.matchedCount === 0) {
    throw _impErr(`import batch ${batchId} claim lost — fenced before workflow mutation`, "IMPORT_IN_PROGRESS");
  }
}

// completeness gate — "artifacts ของ batch นี้ครบ" แยกจาก "batch นี้ current"
// ตรวจ version(import_batch_id+fingerprint)/snapshot/bindings ของ batch ตัวเอง
// เท่านั้น — ไม่ผูก workflow.current_version_id (historical replay ผ่านได้
// โดยไม่ repoint)
async function _batchComplete(
  batch: BatchImportReport, batchId: string,
  workflows: Awaited<ReturnType<typeof getCollection<WorkflowDoc>>>,
  versions: Awaited<ReturnType<typeof getCollection<WorkflowVersionDoc>>>,
  snapshots: Awaited<ReturnType<typeof getCollection<WorkflowRawSnapshotDoc>>>,
  bindings: Awaited<ReturnType<typeof getCollection<WorkflowBindingDoc>>>,
): Promise<string[] | null | "corrupt"> {
  const workflowIds: string[] = [];
  for (const report of batch.reports) {
    const wfId = "wf_imp_" + _shortHash(report.draft.sourceRef.workflowId || report.flowKeyHash);
    const wf = await workflows.findOne({ workflow_id: wfId, is_deleted: { $ne: true } });
    if (!wf) return null;
    const version = await versions.findOne({ workflow_id: wfId, fingerprint: report.fingerprint, import_batch_id: batchId });
    if (!version) return null;
    const snap = await snapshots.findOne({ workflow_id: wfId, version_id: version.version_id });
    if (!snap) return null;
    // bindings: exact set equality — expected deterministic ids เท่านั้น
    // missing → reconcile ได้; extra/corrupt identity → fail closed (operator inspect)
    const expected = new Set(
      report.draft.bindings.map((b) => "wb_" + _shortHash(`${version.version_id}:${b.node_id}:${b.field_path}:${b.kind}`))
    );
    const persisted = await bindings.find({ workflow_id: wfId, version_id: version.version_id }).toArray();
    const persistedIds = new Set(persisted.map((b) => b.binding_id));
    for (const e of expected) if (!persistedIds.has(e)) return null;
    // duplicate rows (Set collapse) / unexpected ids → corrupt (fail closed)
    if (persisted.length !== persistedIds.size || persistedIds.size !== expected.size) return "corrupt";
    workflowIds.push(wfId);
  }
  return workflowIds;
}

export async function applyImportBatch(batch: BatchImportReport, actor: string): Promise<ApplyImportResult> {
  // fail closed: malformed graph / dangling+mismatched step refs / unsupported types → zero writes
  if (!batch.ok) throw _impErr("import batch invalid: flow report ไม่ผ่าน (structural/step-ref anomalies)", "IMPORT_INVALID");
  if (batch.unsupportedTypes.length > 0) {
    throw _impErr("import batch invalid: unsupported node types " + batch.unsupportedTypes.map((u) => u.type).join(","), "IMPORT_INVALID");
  }

  const batchFp = stableFingerprint({
    source: "zaapi",
    flows: batch.reports.map((r) => `${r.draft.sourceRef.workflowId}|${r.fingerprint}`),
  });
  const batchId = "wib_" + _shortHash(batchFp);

  const batches = await getCollection<WorkflowImportBatchDoc>(COLLECTIONS.workflowImportBatches);
  const workflows = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  const versions = await getCollection<WorkflowVersionDoc>(COLLECTIONS.workflowVersions);
  const snapshots = await getCollection<WorkflowRawSnapshotDoc>(COLLECTIONS.workflowRawSnapshots);
  const bindings = await getCollection<WorkflowBindingDoc>(COLLECTIONS.workflowBindings);
  const now = new Date();
  // claim token+lease — single applier; lease หมดอายุ = claimant ตาย → takeover ได้
  const claim = `c_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  const claimExpiry = new Date(now.getTime() + IMPORT_CLAIM_LEASE_MS);

  const existing = await batches.findOne({ batch_id: batchId });
  if (existing) {
    if (existing.source_fingerprint !== batchFp) throw _impErr(`import batch conflict: ${batchId} fingerprint mismatch`, "IMPORT_INVALID");
    // applied + artifacts ครบเท่านั้นที่ตอบ already_applied (ไม่ผูก current pointer)
    if (existing.status === "applied") {
      const doneIds = await _batchComplete(batch, batchId, workflows, versions, snapshots, bindings);
      if (doneIds === "corrupt") {
        throw _impErr(`import batch ${batchId}: unexpected binding identity — fail closed for operator inspection`, "IMPORT_INVALID");
      }
      if (doneIds) {
        return {
          ok: true, already_applied: true, batch_id: batchId,
          workflow_ids: doneIds, flow_count: existing.flow_count,
          node_count: existing.node_count, edge_count: existing.edge_count,
          bindings_total: existing.bindings_total, warnings: existing.warnings, conflicts: existing.conflicts,
        };
      }
      // applied แต่ incomplete → reconcile artifacts ด้วย claim เดียวกัน
    }
    // acquire — lease null/หมดอายุเท่านั้น (stale claimant = dead worker → takeover)
    const claimed = await batches.updateOne(
      { batch_id: batchId, $or: [{ claim_expires_at: null }, { claim_expires_at: { $lte: now } }] },
      { $set: { claim_token: claim, claim_expires_at: claimExpiry, status: "in_progress" } }
    );
    if (claimed.matchedCount === 0) {
      throw _impErr(`import batch ${batchId} apply already in progress`, "IMPORT_IN_PROGRESS");
    }
  } else {
    // fresh batch — insert พร้อม claim เป็น atomic record เดียว
    const batchDoc: WorkflowImportBatchDoc = {
      batch_id: batchId, source: "zaapi", source_fingerprint: batchFp,
      flow_count: batch.flowCount, node_count: batch.nodeCount, edge_count: batch.edgeCount,
      bindings_total: batch.bindingsTotal,
      synthesized_edges: batch.reports.reduce((s, r) => s + r.stepRefs.synthesized, 0),
      unresolved_step_refs: batch.reports.reduce((s, r) => s + r.unresolvedStepRefs.length, 0),
      mismatched_step_refs: batch.reports.reduce((s, r) => s + r.stepRefs.mismatched, 0),
      warnings: batch.reports.flatMap((r) => r.warnings),
      conflicts: batch.conflicts,
      status: "in_progress", workflow_ids: [],
      claim_token: claim, claim_expires_at: claimExpiry,
      created_at: now, created_by: actor,
    };
    try {
      await batches.insertOne(batchDoc);
    } catch (e) {
      // E11000 — caller อื่น insert ก่อน → มัน claim อยู่ → in-progress conflict
      if ((e as { code?: number }).code === 11000) {
        throw _impErr(`import batch ${batchId} apply already in progress`, "IMPORT_IN_PROGRESS");
      }
      throw e;
    }
  }

  const workflowIds: string[] = [];
  try {

    for (const report of batch.reports) {
      const d = report.draft;
      const srcWfId = d.sourceRef.workflowId;
      const wfId = "wf_imp_" + _shortHash(srcWfId || report.flowKeyHash);

      const existingWf = await workflows.findOne({ workflow_id: wfId, is_deleted: { $ne: true } });
      if (existingWf && existingWf.import && existingWf.import.source_workflow_id !== srcWfId) {
        throw _impErr(`import conflict: ${wfId} belongs to source ${existingWf.import.source_workflow_id}`, "IMPORT_INVALID");
      }

      // per-flow idempotency — version fingerprint เดิม → reuse (ไม่ bump/re-point)
      // resume: version อาจมีแล้วจาก crashed attempt — snapshot/bindings ต้อง verify แยก
      const dupVersion = await versions.findOne({ workflow_id: wfId, fingerprint: report.fingerprint });
      const seq = dupVersion?.version_seq ?? (existingWf?.version ?? 0) + 1;
      const versionId = dupVersion?.version_id ?? "wv_" + _shortHash(`${wfId}:${seq}:${report.fingerprint}`);
      if (!dupVersion) {
        await versions.insertOne({
          version_id: versionId, workflow_id: wfId, version_seq: seq,
          schema_version: "canonical-workflow/1",
          // platforms: intersect กับ local-engine platforms — facebook/line ของ zaapi เก็บใน raw provenance
          name: d.name, platforms: d.platforms.filter((p) => (LOCAL_ENGINE_PLATFORMS as string[]).includes(p)) as Platform[], nodes: d.nodes, edges: d.edges,
          handle_labels: d.handleLabels, source_ref: d.sourceRef,
          import_batch_id: batchId, fingerprint: report.fingerprint,
          created_at: now, created_by: actor,
        });
      }

      const snapshotId = "wrs_" + _shortHash(`${wfId}:${versionId}`);
      if (!(await snapshots.findOne({ snapshot_id: snapshotId }))) {
        await snapshots.insertOne({
          snapshot_id: snapshotId,
          workflow_id: wfId, version_id: versionId,
          source_workflow_id: srcWfId, source_version_id: d.sourceRef.loadedVersionId,
          source_status: d.sourceRef.sourceStatus,
          fingerprint: d.sourceRef.fingerprint, raw: d.raw ?? null,
          created_at: now,
        });
      }

      for (const b of d.bindings) {
        const bindingId = "wb_" + _shortHash(`${versionId}:${b.node_id}:${b.field_path}:${b.kind}`);
        if (await bindings.findOne({ binding_id: bindingId })) continue; // resume — เขียนแล้ว
        await bindings.insertOne({
          binding_id: bindingId,
          workflow_id: wfId, version_id: versionId,
          node_id: b.node_id, field_path: b.field_path, kind: b.kind, count: b.count,
          source_ref: b.source_ref, source_values: _resolveRawPath(d.raw, b.source_ref),
          status: "unresolved", created_at: now,
        });
      }

      if (!existingWf) {
        await _assertImportClaim(batches, batchId, claim); // fence ก่อน mutable write
        await workflows.insertOne({
          workflow_id: wfId, name: d.name, enabled: false,
          shop_ids: [], platforms: d.platforms.filter((p) => (LOCAL_ENGINE_PLATFORMS as string[]).includes(p)) as Platform[],
          trigger_frequency: "every_time", false_branch_policy: "exit_to_bot",
          nodes: d.nodes, edges: d.edges, priority: 0,
          version: 1, status: "draft",
          created_by: actor, created_at: now, updated_at: now,
          current_version_id: versionId,
          import: { source: "zaapi", source_workflow_id: srcWfId, batch_id: batchId },
        });
      } else {
        // repoint เฉพาะเมื่อ revision ใหม่กว่า current — historical reconcile ไม่ repoint
        const curVer = existingWf.current_version_id
          ? await versions.findOne({ version_id: existingWf.current_version_id })
          : null;
        const curSeq = curVer?.version_seq ?? 0;
        if (existingWf.current_version_id !== versionId && seq > curSeq) {
          // force disabled/draft ใน update เดียวกับ graph/pointer flip —
          // imported revision ห้ามเปลี่ยน graph ของ workflow ที่ยัง active
          await _assertImportClaim(batches, batchId, claim); // fence ก่อน repoint
          await workflows.updateOne(
            { workflow_id: wfId, is_deleted: { $ne: true } },
            { $set: {
              name: d.name, nodes: d.nodes, edges: d.edges,
              platforms: d.platforms.filter((p) => (LOCAL_ENGINE_PLATFORMS as string[]).includes(p)) as Platform[],
              current_version_id: versionId,
              enabled: false, status: "draft",
              import: { source: "zaapi", source_workflow_id: srcWfId, batch_id: batchId },
              updated_at: now, updated_by: actor,
            }, $inc: { version: 1 } }
          );
        }
      }
      workflowIds.push(wfId);
    }

    // completeness gate — finalize เฉพาะเมื่อ artifacts ของ batch ครบจริง
    const completeIds = await _batchComplete(batch, batchId, workflows, versions, snapshots, bindings);
    if (completeIds === "corrupt") {
      throw _impErr(`import batch ${batchId}: unexpected binding identity — fail closed for operator inspection`, "IMPORT_INVALID");
    }
    if (!completeIds) {
      throw _impErr(`import batch ${batchId} incomplete: missing records after apply loop`, "IMPORT_INVALID");
    }
    // fencing — claim_token ใน filter: stale claimant finalize ไม่ได้
    const finalized = await batches.updateOne(
      { batch_id: batchId, claim_token: claim },
      { $set: { status: "applied", workflow_ids: completeIds, applied_at: new Date(), claim_token: null, claim_expires_at: null } }
    );
    if (finalized.matchedCount === 0) {
      throw _impErr(`import batch ${batchId} claim lost — another applier took over`, "IMPORT_IN_PROGRESS");
    }
  } catch (e) {
    // recoverable state — retry payload เดิมซ่อมต่อได้ (deterministic ids)
    // release เฉพาะเมื่อยังถือ claim (fencing — stale claimant ปล่อยไม่ได้)
    try {
      await batches.updateOne(
        { batch_id: batchId, claim_token: claim },
        { $set: { status: "failed", last_error: (e as Error).message, claim_token: null, claim_expires_at: null } }
      );
    } catch { /* batch doc อาจเขียนไม่ได้ — อย่ากลืน error เดิม */ }
    throw e;
  }

  // audit หลัง commit — audit fail ไม่ทำให้ client เข้าใจว่า import ไม่สำเร็จ
  try {
    await logAdminEvent({
      action_type: "workflow.import_apply", actor,
      metadata: { batch_id: batchId, flow_count: batch.flowCount, node_count: batch.nodeCount, bindings_total: batch.bindingsTotal, workflow_ids: workflowIds },
    });
  } catch { /* post-commit audit failure — commit สำเร็จแล้ว */ }
  return {
    ok: true, batch_id: batchId, workflow_ids: workflowIds,
    flow_count: batch.flowCount, node_count: batch.nodeCount, edge_count: batch.edgeCount,
    bindings_total: batch.bindingsTotal,
    warnings: batch.reports.flatMap((r) => r.warnings), conflicts: batch.conflicts,
  };
}

// ─── CAS save (optimistic concurrency) ────────────────────
// expectedVersion ต้องตรง workflows.version ปัจจุบัน — ไม่ตรง = conflict (ไม่
// เขียนทับ). Commit point = updateOne เดียวที่พริก fields+version+pointer พร้อมกัน
// — immutable version doc + carried bindings เขียนก่อน (deterministic ids →
// retry payload เดิม resume ได้ idempotent). enabled/status ผ่าน CAS ได้สำหรับ
// legacy workflow; imported → activation invariant เดียวกับ update/toggle
export interface CasSaveResult {
  ok: boolean;
  conflict?: boolean;
  not_found?: boolean;
  version?: number;
  version_id?: string;
  current_version?: number;
}

const CAS_SAVE_ALLOWLIST = [
  "name", "description", "shop_ids", "platforms", "trigger_frequency",
  "false_branch_policy", "nodes", "edges", "priority", "enabled", "status",
] as const;

export async function saveWorkflowDraft(
  workflowId: string,
  fields: Partial<Pick<WorkflowDoc,
    "name" | "description" | "shop_ids" | "platforms" | "trigger_frequency" |
    "false_branch_policy" | "nodes" | "edges" | "priority" | "enabled" | "status">>,
  expectedVersion: number,
  actor: string,
): Promise<CasSaveResult> {
  const coll = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  const before = await coll.findOne({ workflow_id: workflowId, is_deleted: { $ne: true } });
  if (!before) return { ok: false, not_found: true };
  if (before.version !== expectedVersion) {
    return { ok: false, conflict: true, current_version: before.version };
  }
  const unknown = Object.keys(fields).filter((k) => !(CAS_SAVE_ALLOWLIST as readonly string[]).includes(k));
  if (unknown.length > 0) throw new Error("unsupported fields: " + unknown.join(","));
  const safeFields = pickAllowed(fields as Record<string, unknown>, CAS_SAVE_ALLOWLIST);
  await _assertActivationAllowed(workflowId, before, safeFields);
  const mergedNodes = (safeFields.nodes as WorkflowNode[] | undefined) ?? before.nodes;
  const mergedEdges = (safeFields.edges as WorkflowEdge[] | undefined) ?? before.edges;
  const graph = validateWorkflowGraph({ nodes: mergedNodes, edges: mergedEdges });
  if (!graph.ok) throw new Error("workflow graph invalid: " + graph.errors.join("; "));

  // canonical version payload — field ที่ version owner รับผิดชอบทั้งหมด
  // (activation state: enabled/status/is_deleted ไม่อยู่ version history)
  const payload = {
    name: (safeFields.name as string | undefined) ?? before.name,
    description: (safeFields.description as string | undefined) ?? before.description,
    shop_ids: (safeFields.shop_ids as string[] | undefined) ?? before.shop_ids,
    platforms: (safeFields.platforms as Platform[] | undefined) ?? before.platforms,
    trigger_frequency: (safeFields.trigger_frequency as WorkflowTriggerFrequency | undefined) ?? before.trigger_frequency,
    false_branch_policy: (safeFields.false_branch_policy as WorkflowFalseBranchPolicy | undefined) ?? before.false_branch_policy,
    priority: (safeFields.priority as number | undefined) ?? before.priority,
    nodes: mergedNodes, edges: mergedEdges, handle_labels: {},
  };
  const payloadFp = stableFingerprint(payload);
  const now = new Date();
  const versions = await getCollection<WorkflowVersionDoc>(COLLECTIONS.workflowVersions);

  // 1) immutable version doc — deterministic id จาก payload เดียวกัน
  //    seq collision (orphan จาก crash / payload ต่าง) → bump seq จนหา slot ว่าง
  //    — orphan ไม่ขวาง payload ใหม่ถาวร
  let seq = expectedVersion + 1;
  let versionId = "wv_" + _shortHash(`${workflowId}:${seq}:${payloadFp}`);
  for (;;) {
    const clash = await versions.findOne({ workflow_id: workflowId, version_seq: seq });
    if (!clash) break;
    if (clash.fingerprint === payloadFp) { versionId = clash.version_id; break; } // resume — artifact เดิม
    seq += 1;
    versionId = "wv_" + _shortHash(`${workflowId}:${seq}:${payloadFp}`);
  }
  if (!(await versions.findOne({ version_id: versionId }))) {
    await versions.insertOne({
      version_id: versionId, workflow_id: workflowId, version_seq: seq,
      schema_version: "canonical-workflow/1",
      ...payload,
      source_ref: before.import ? { workflowId: before.import.source_workflow_id, loadedVersionId: "", versionStatuses: [], sourceStatus: "", fingerprint: "" } : { workflowId: "", loadedVersionId: "", versionStatuses: [], sourceStatus: "", fingerprint: "" },
      import_batch_id: before.import?.batch_id,
      fingerprint: payloadFp,
      created_at: now, created_by: actor,
    });
  }

  // 2) bindings carry-forward เฉพาะ node ที่ยังอยู่ — node ถูกลบไม่ clone
  //    (historical version เก็บ binding เดิม immutable อยู่แล้ว)
  if (before.current_version_id) {
    const bindings = await getCollection<WorkflowBindingDoc>(COLLECTIONS.workflowBindings);
    const prev = await bindings.find({ workflow_id: workflowId, version_id: before.current_version_id }).toArray();
    const surviving = new Set(mergedNodes.map((n) => n.node_id));
    for (const b of prev.filter((x) => surviving.has(x.node_id))) {
      const bindingId = "wb_" + _shortHash(`${versionId}:${b.node_id}:${b.field_path}:${b.kind}`);
      if (await bindings.findOne({ binding_id: bindingId })) continue; // resume
      await bindings.insertOne({
        ...b,
        _id: undefined as never,
        binding_id: bindingId,
        version_id: versionId,
        created_at: now,
      });
    }
  }

  // 3) commit point — fields+version+pointer พริกใน updateOne เดียว
  //    `$set version:seq` (ไม่ใช่ $inc) — orphan seq-skip ต้องสะท้อนใน counter
  //    crash ก่อนหน้านี้ = orphan immutable docs เท่านั้น, runtime state เดิม
  const result = await coll.updateOne(
    { workflow_id: workflowId, is_deleted: { $ne: true }, version: expectedVersion },
    { $set: { ...safeFields, current_version_id: versionId, version: seq, updated_at: new Date(), updated_by: actor } }
  );
  if (result.matchedCount === 0) {
    return { ok: false, conflict: true, current_version: before.version };
  }

  // audit หลัง commit — audit fail ไม่กลืน commit
  try {
    await logAdminEvent({
      action_type: "workflow.cas_save", actor,
      metadata: { workflow_id: workflowId, version: seq, fields: Object.keys(safeFields) },
    });
  } catch { /* post-commit audit failure — commit สำเร็จแล้ว */ }
  return { ok: true, version: seq, version_id: versionId };
}

// ─── Binding resolution (direct) ──────────────────────────
// saveBindingResolutionBatch — client ส่งเฉพาะ (binding_id, source_index) → local_id
// server เป็นเจ้าของ identity ทั้งหมด: binding docs + source_values โหลดจาก DB,
// source_fp = sha256(canonicalJson(source_value)) คำนวณฝั่ง server — client-
// supplied source identity ถูก reject (forbidden keys ทุกระดับ).
// Commit = updateOne เดียว (pointer+version+derived scope พร้อมกัน) หลัง immutable
// version doc + version-scoped bindings เขียน (deterministic ids → retry/E11000
// idempotent). audit หลัง commit เท่านั้น. repeat:true → exact same-kind sibling
// expansion ใน version เดียวกัน (canonicalJson equality เท่านั้น — ไม่มี fuzzy)
export interface ResolutionMapping {
  source_index: number;
  source_fp: string;            // sha256 hex — server-computed จาก source_values
  local_id: string;
  platform?: Platform;          // account kind เท่านั้น
  shop_id?: string;             // account kind เท่านั้น
  state: "valid" | "invalid";
  resolved_by: string;
  resolved_at: Date;
  invalidated_at?: Date;
  invalid_reason?: string;
  via: "direct" | "repeat";
  carried?: boolean;            // carried forward จาก version ก่อน (Task 4)
}

export interface BindingResolutionRequest {
  workflow_id: string;          // ต้องตรง route param
  expected_version: number;
  version_id: string;           // current_version_id ที่ client อ้าง
  proposed: {
    binding_id: string;
    repeat?: boolean;           // Task 2 — expand target ไป exact same-kind siblings
    mappings: { source_index: number; local_id: string; platform?: Platform; shop_id?: string }[];
  }[];
}

export interface BindingResolutionResult {
  ok: boolean;
  conflict?: boolean;
  not_found?: boolean;
  validation?: string;
  current_version?: number;
  current_version_id?: string;
  version?: number;
  version_id?: string;
  resolved?: number;
  unresolved?: number;
  invalid?: number;
  repeated?: { binding_id: string; source_index: number }[];
  publish_blockers?: string[];
  overlap_conflicts?: string[];
}

// Task 7 (route) consumes — type ถูกกำหนดใน Task 1 เพื่อ freeze contract
export interface BindingResolutionView {
  workflow_id: string;
  version_id: string;
  bindings: {
    binding_id: string;
    node_id: string;
    field_path: string;
    kind: string;
    count: number;
    status: BindingStatus;
    requirement_fp: string;
    sources: { source_index: number; display_value: string; resolved?: ResolutionMapping }[];
    conflict?: string;
  }[];
}

export async function saveBindingResolutionBatch(
  workflowId: string,
  request: BindingResolutionRequest,
  actor: string,
): Promise<BindingResolutionResult> {
  const workflows = await getCollection<WorkflowDoc>(COLLECTIONS.workflows);
  const versions = await getCollection<WorkflowVersionDoc>(COLLECTIONS.workflowVersions);
  const bindings = await getCollection<WorkflowBindingDoc>(COLLECTIONS.workflowBindings);
  const now = new Date();
  const req = request as unknown as Record<string, unknown> | null;

  // 1) strict-shape — forbidden client keys ทุกระดับ (source identity server เท่านั้น)
  if (!req || typeof req !== "object") return { ok: false, validation: "request must be an object" };
  const forbiddenKeys = ["node_id", "field_path", "kind", "source_value", "source_fp",
    "source_values", "requirement_fp", "display_value", "sources"];
  const scan: unknown[] = [req];
  while (scan.length) {
    const cur = scan.pop();
    if (Array.isArray(cur)) { scan.push(...cur); continue; }
    if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
        if (forbiddenKeys.includes(k)) {
          return { ok: false, validation: `forbidden client key: ${k} — source identity is server-loaded` };
        }
        scan.push(v);
      }
    }
  }
  // allowed keys ต่อระดับ — unknown key ใดๆ reject (whitelist, ไม่ใช่แค่ blacklist)
  const allowedTop = ["workflow_id", "expected_version", "version_id", "proposed"];
  const allowedProposal = ["binding_id", "repeat", "mappings"];
  const allowedMapping = ["source_index", "local_id", "platform", "shop_id"];
  for (const k of Object.keys(req)) {
    if (!allowedTop.includes(k)) return { ok: false, validation: `unknown request key: ${k}` };
  }
  if (typeof req.workflow_id !== "string" || req.workflow_id !== workflowId) {
    return { ok: false, validation: "workflow_id mismatch — route/body identity differs" };
  }
  if (!Number.isInteger(req.expected_version) || (req.expected_version as number) < 0) {
    return { ok: false, validation: "expected_version must be a non-negative integer" };
  }
  if (typeof req.version_id !== "string" || !req.version_id.trim()) return { ok: false, validation: "version_id required" };
  if (!Array.isArray(req.proposed) || req.proposed.length === 0) {
    return { ok: false, validation: "proposed must be a non-empty array" };
  }
  const seenBinding = new Set<string>();
  const seenIndex = new Set<string>();
  for (const p of req.proposed as Record<string, unknown>[]) {
    if (!p || typeof p !== "object") return { ok: false, validation: "proposal must be an object" };
    for (const k of Object.keys(p)) {
      if (!allowedProposal.includes(k)) return { ok: false, validation: `unknown proposal key: ${k}` };
    }
    if (typeof p.binding_id !== "string" || !p.binding_id.trim()) return { ok: false, validation: "proposal binding_id required" };
    if (seenBinding.has(p.binding_id)) return { ok: false, validation: `duplicate binding_id: ${p.binding_id}` };
    seenBinding.add(p.binding_id);
    if (p.repeat !== undefined && typeof p.repeat !== "boolean") return { ok: false, validation: "repeat must be a boolean" };
    if (!Array.isArray(p.mappings) || p.mappings.length === 0) {
      return { ok: false, validation: `proposal ${p.binding_id}: mappings must be a non-empty array` };
    }
    for (const m of p.mappings as Record<string, unknown>[]) {
      if (!m || typeof m !== "object") return { ok: false, validation: "mapping must be an object" };
      for (const k of Object.keys(m)) {
        if (!allowedMapping.includes(k)) return { ok: false, validation: `unknown mapping key: ${k}` };
      }
      if (!Number.isInteger(m.source_index) || (m.source_index as number) < 0) {
        return { ok: false, validation: `proposal ${p.binding_id}: source_index must be a non-negative integer` };
      }
      const mapKey = `${p.binding_id}:${m.source_index}`;
      if (seenIndex.has(mapKey)) return { ok: false, validation: `duplicate (binding_id, source_index): ${mapKey}` };
      seenIndex.add(mapKey);
      if (typeof m.local_id !== "string" || !m.local_id.trim()) return { ok: false, validation: `proposal ${p.binding_id}: local_id required` };
      if (m.platform !== undefined && (typeof m.platform !== "string" || !(LOCAL_ENGINE_PLATFORMS as string[]).includes(m.platform))) {
        return { ok: false, validation: `proposal ${p.binding_id}: platform must be one of ${LOCAL_ENGINE_PLATFORMS.join(", ")}` };
      }
      if (m.shop_id !== undefined && (typeof m.shop_id !== "string" || !m.shop_id.trim())) {
        return { ok: false, validation: `proposal ${p.binding_id}: shop_id must be a non-empty string` };
      }
    }
  }
  const proposed = req.proposed as BindingResolutionRequest["proposed"];
  const expected = req.expected_version as number;

  // 2) load workflow + imported provenance — resolution มีเฉพาะ imported artifacts
  const wf = await workflows.findOne({ workflow_id: workflowId, is_deleted: { $ne: true } });
  if (!wf) return { ok: false, not_found: true };
  if (!wf.import) return { ok: false, validation: "workflow is not an imported artifact — binding resolution unsupported" };

  // 3) stale pointer pre-checks — conflict (zero writes)
  if (wf.version !== expected) return { ok: false, conflict: true, current_version: wf.version };
  if (wf.current_version_id !== req.version_id) {
    return { ok: false, conflict: true, current_version_id: wf.current_version_id };
  }
  const curVersion = await versions.findOne({ version_id: req.version_id });
  if (!curVersion) throw new Error(`current version doc ${req.version_id} missing — cannot resolve bindings`);

  // 4) server-owned binding docs — scoped ด้วย {workflow_id, version_id}; id จาก
  //    client ต้องอยู่ใน set นี้เท่านั้น (binding ของ workflow/version อื่น reject)
  const versionBindings = (await bindings.find({ workflow_id: workflowId, version_id: req.version_id }).toArray())
    .sort((a, b) => `${a.node_id}|${a.field_path}|${a.kind}|${a.binding_id}` < `${b.node_id}|${b.field_path}|${b.kind}|${b.binding_id}` ? -1 : 1);
  // persisted invariants — corrupt server-owned doc → fail closed ก่อน mapping เสมอ
  for (const b of versionBindings) {
    if (!Number.isInteger(b.count) || b.count < 0 || !Array.isArray(b.source_values)
      || b.source_values.length !== b.count || !b.binding_id || !b.node_id || !b.field_path || !b.kind
      || !b.version_id || b.workflow_id !== workflowId || b.version_id !== req.version_id) {
      throw new Error(`binding ${b.binding_id}: corrupt persisted binding`);
    }
    if (b.status !== "unresolved" && b.status !== "resolved" && b.status !== "invalid") {
      throw new Error(`binding ${b.binding_id}: corrupt persisted — status ${String(b.status)} outside enum`);
    }
    const storedIdx = new Set<number>();
    for (const m of b.resolution?.mappings ?? []) {
      if (!Number.isInteger(m.source_index) || m.source_index < 0 || m.source_index >= b.source_values.length
        || storedIdx.has(m.source_index)
        || m.source_fp !== createHash("sha256").update(canonicalJson(b.source_values[m.source_index])).digest("hex")) {
        throw new Error(`binding ${b.binding_id}: corrupt persisted resolution`);
      }
      storedIdx.add(m.source_index);
      const mm = m as unknown as Record<string, unknown>;
      if (typeof mm.local_id !== "string" || mm.local_id.trim() === ""
        || (mm.state !== "valid" && mm.state !== "invalid")
        || (mm.via !== "direct" && mm.via !== "repeat")
        || typeof mm.resolved_by !== "string" || mm.resolved_by.trim() === ""
        || !(mm.resolved_at instanceof Date) || Number.isNaN(mm.resolved_at.getTime())
        || (mm.invalidated_at !== undefined && !(mm.invalidated_at instanceof Date))
        || (mm.invalid_reason !== undefined && (typeof mm.invalid_reason !== "string" || mm.invalid_reason.trim() === ""))) {
        throw new Error(`binding ${b.binding_id}: corrupt persisted resolution mapping`);
      }
      if (b.kind === "account") {
        if (typeof mm.platform !== "string" || !(LOCAL_ENGINE_PLATFORMS as readonly string[]).includes(mm.platform)
          || typeof mm.shop_id !== "string" || mm.shop_id.trim() === "" || mm.local_id !== mm.shop_id) {
          throw new Error(`binding ${b.binding_id}: corrupt persisted account mapping scope`);
        }
      } else if (mm.platform !== undefined || mm.shop_id !== undefined) {
        throw new Error(`binding ${b.binding_id}: corrupt persisted — scope fields on non-account mapping`);
      }
    }
    if (b.status === "resolved" && (b.resolution?.mappings ?? []).filter((m) => m.state === "valid").length !== b.count) {
      throw new Error(`binding ${b.binding_id}: corrupt persisted — resolved without complete valid coverage`);
    }
  }
  const bindingById = new Map(versionBindings.map((b) => [b.binding_id, b]));
  for (const p of proposed) {
    if (!bindingById.has(p.binding_id)) {
      return { ok: false, validation: `binding ${p.binding_id} not in this workflow/version scope` };
    }
  }
  const proposedIds = new Set(proposed.map((p) => p.binding_id));

  // 5) bounds + coverage — proposed ต้องครบทุก source_index ของ binding
  //    worklist เดียวรวม proposed (invalid → reject) + carried (re-validate inline)
  const targetWork: { b: WorkflowBindingDoc; m: { source_index: number; local_id: string; platform?: Platform; shop_id?: string }; carried?: ResolutionMapping }[] = [];
  for (const p of proposed) {
    const b = bindingById.get(p.binding_id)!;
    const srcVals = Array.isArray(b.source_values) ? b.source_values : [];
    const covered = new Set<number>();
    for (const m of p.mappings) {
      if (m.source_index >= srcVals.length) {
        return { ok: false, validation: `binding ${p.binding_id}: source_index ${m.source_index} out of bounds (${srcVals.length} sources)` };
      }
      covered.add(m.source_index);
      targetWork.push({ b, m });
    }
    if (covered.size !== b.count) {
      return { ok: false, validation: `binding ${p.binding_id}: partial mapping — ${covered.size}/${b.count} source indexes covered` };
    }
  }
  // carried mappings (non-proposed bindings ที่ resolved ไว้ก่อน) — deep copy แล้ว
  // re-validate target ใน switch เดียวกัน — target หาย → state:"invalid" ติดไป version ใหม่
  const carriedMaps = new Map<string, ResolutionMapping[]>();
  for (const b of versionBindings) {
    if (proposedIds.has(b.binding_id) || !b.resolution?.mappings?.length) continue;
    const copies = b.resolution.mappings.map((m) => {
      const c = { ...m } as unknown as Record<string, unknown>;
      for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
      return c as unknown as ResolutionMapping;
    }).sort((x, y) => x.source_index - y.source_index);
    carriedMaps.set(b.binding_id, copies);
    for (const cm of copies) targetWork.push({ b, m: cm, carried: cm });
  }
  // repeat expansion — proposal repeat:true: exact same-kind sibling ใน version
  // เดียวกันเท่านั้น (canonicalJson deep equality — ไม่มี substring/keyword/regex,
  // ไม่ cross-kind, ไม่ infer scope); target ใช้ค่า confirm ของ proposal เดิม,
  // repeat mapping เข้า typed switch เดียวกัน (ไม่ bypass target existence)
  const repeatApplied = new Map<string, ResolutionMapping[]>();
  const repeated: { binding_id: string; source_index: number }[] = [];
  for (const p of proposed) {
    if (p.repeat !== true) continue;
    const b = bindingById.get(p.binding_id)!;
    for (const m of p.mappings) {
      const srcCj = canonicalJson(b.source_values[m.source_index]);
      for (const sb of versionBindings) {
        if (sb.binding_id === b.binding_id || sb.kind !== b.kind) continue;
        for (let i = 0; i < sb.source_values.length; i++) {
          if (canonicalJson(sb.source_values[i]) !== srcCj) continue;
          const sibProposal = proposed.find((q) => q.binding_id === sb.binding_id);
          if (sibProposal) {
            const pm = sibProposal.mappings.find((q) => q.source_index === i)!;
            if (pm.local_id !== m.local_id || pm.platform !== m.platform || pm.shop_id !== m.shop_id) {
              return { ok: false, validation: `binding ${sb.binding_id}: repeat conflicts with proposed mapping at source_index ${i}` };
            }
            continue;
          }
          const prev = (repeatApplied.get(sb.binding_id) ?? []).find((r) => r.source_index === i);
          if (prev) {
            if (prev.local_id !== m.local_id || prev.platform !== m.platform || prev.shop_id !== m.shop_id) {
              return { ok: false, validation: `binding ${sb.binding_id}: repeat conflict at source_index ${i} — proposals map the same source to different targets` };
            }
            continue;
          }
          const rm: ResolutionMapping = {
            source_index: i,
            source_fp: createHash("sha256").update(canonicalJson(sb.source_values[i])).digest("hex"),
            local_id: m.local_id,
            ...(m.platform !== undefined ? { platform: m.platform } : {}),
            ...(m.shop_id !== undefined ? { shop_id: m.shop_id } : {}),
            state: "valid",
            resolved_by: actor,
            resolved_at: now,
            via: "repeat",
          };
          targetWork.push({ b: sb, m: rm });
          const bucket = repeatApplied.get(sb.binding_id);
          if (bucket) bucket.push(rm); else repeatApplied.set(sb.binding_id, [rm]);
        }
      }
    }
  }

  // 6) typed switch — local-target existence ตาม kind (account scope fields ใช้ได้
  //    เฉพาะ account) — proposed invalid → reject; carried invalid → mark state
  const shops = await getCollection<{ shop_id: string; platform: string }>(COLLECTIONS.shops);
  const admins = await getCollection<{ admin_id: string; active?: boolean }>(COLLECTIONS.admins);
  const conversations = await getCollection(COLLECTIONS.conversations);
  let labelSet: Set<string> | null = null;
  for (const w of targetWork) {
    let targetOk = false;
    let targetErr = "";
    if (w.b.kind !== "account" && (w.m.platform !== undefined || w.m.shop_id !== undefined)) {
      targetErr = `binding ${w.b.binding_id}: platform/shop_id scope fields only valid on account kind`;
    } else switch (w.b.kind) {
      case "account":
        if (w.m.platform === undefined || w.m.shop_id === undefined) {
          targetErr = `binding ${w.b.binding_id}: account mapping requires platform + shop_id`;
        } else if (w.m.local_id !== w.m.shop_id) {
          targetErr = `binding ${w.b.binding_id}: account local_id must equal shop_id`;
        } else if (!(await shops.findOne({ shop_id: w.m.shop_id, platform: w.m.platform }))) {
          targetErr = `binding ${w.b.binding_id}: account target ${w.m.shop_id}@${w.m.platform} not found in shops`;
        } else targetOk = true;
        break;
      case "label":
        if (!labelSet) labelSet = new Set(((await conversations.distinct("labels", {})) as unknown[]).flat() as string[]);
        targetOk = labelSet.has(w.m.local_id);
        if (!targetOk) targetErr = `binding ${w.b.binding_id}: label ${w.m.local_id} not in conversations.labels`;
        break;
      case "user": {
        const adm = await admins.findOne({ admin_id: w.m.local_id });
        targetOk = adm != null && adm.active !== false;
        if (!targetOk) targetErr = `binding ${w.b.binding_id}: user ${w.m.local_id} ${adm == null ? "not found" : "inactive"}`;
        break;
      }
      case "team":
        targetErr = `binding ${w.b.binding_id}: unresolvable — team has no local identity in R1`;
        break;
      case "ticket_field":
      case "url":
        targetErr = `binding ${w.b.binding_id}: unresolvable — ${w.b.kind} target kind unsupported`;
        break;
      default:
        targetErr = `binding ${w.b.binding_id}: unresolvable — unsupported kind ${w.b.kind}`;
    }
    if (w.carried) {
      w.carried.state = targetOk ? "valid" : "invalid";
      if (!targetOk) {
        w.carried.invalidated_at = w.carried.invalidated_at ?? now;
        w.carried.invalid_reason = w.carried.invalid_reason ?? "local target missing";
      } else {
        delete w.carried.invalidated_at;
        delete w.carried.invalid_reason;
      }
    } else if (!targetOk) {
      return { ok: false, validation: targetErr };
    }
  }

  // 7) complete resolution state ต่อ binding — deterministic (timestamps ไม่อยู่ใน fp input)
  const resolutionByBinding = new Map<string, { status: BindingStatus; mappings: ResolutionMapping[]; conflict?: string }>();
  for (const p of proposed) {
    const b = bindingById.get(p.binding_id)!;
    const srcVals = Array.isArray(b.source_values) ? b.source_values : [];
    resolutionByBinding.set(b.binding_id, {
      status: "resolved",
      mappings: [...p.mappings].sort((x, y) => x.source_index - y.source_index).map((m) => ({
        source_index: m.source_index,
        source_fp: createHash("sha256").update(canonicalJson(srcVals[m.source_index])).digest("hex"),
        local_id: m.local_id,
        ...(m.platform !== undefined ? { platform: m.platform } : {}),
        ...(m.shop_id !== undefined ? { shop_id: m.shop_id } : {}),
        state: "valid",
        resolved_by: actor,
        resolved_at: now,
        via: "direct",
      })),
    });
  }
  for (const b of versionBindings) {
    if (proposedIds.has(b.binding_id)) continue;
    const carried = carriedMaps.get(b.binding_id);
    const rms = repeatApplied.get(b.binding_id);
    if (!carried?.length && !rms?.length) {
      resolutionByBinding.set(b.binding_id, { status: b.status,
        mappings: (b.resolution?.mappings ?? []).map((m) => {
          const c = { ...m } as unknown as Record<string, unknown>;
          for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
          return c as unknown as ResolutionMapping;
        }),
        conflict: b.resolution?.conflict });
      continue;
    }
    if (!rms?.length) {
      resolutionByBinding.set(b.binding_id, {
        status: carried!.some((m) => m.state === "invalid") ? "invalid" : b.status,
        mappings: carried!,
        conflict: b.resolution?.conflict,
      });
      continue;
    }
    // repeat merge — existing ที่ index เดียวกัน: valid+target เดียวกัน = no-op;
    // ต่างหรือ invalid → fail closed (explicit direct proposal เท่านั้นที่แก้ได้)
    const merged = [...(carried ?? [])];
    for (const rm of rms) {
      const ex = merged.find((m) => m.source_index === rm.source_index);
      if (ex === undefined) {
        merged.push(rm);
        repeated.push({ binding_id: b.binding_id, source_index: rm.source_index });
        continue;
      }
      if (ex.state === "valid" && ex.local_id === rm.local_id
        && ex.platform === rm.platform && ex.shop_id === rm.shop_id) continue;
      return { ok: false, validation: `binding ${b.binding_id}: repeat conflicts with existing mapping at source_index ${rm.source_index} — requires explicit direct proposal` };
    }
    merged.sort((x, y) => x.source_index - y.source_index);
    resolutionByBinding.set(b.binding_id, {
      status: merged.some((m) => m.state === "invalid") ? "invalid"
        : (merged.length === b.count && merged.every((m) => m.state === "valid") ? "resolved" : b.status),
      mappings: merged,
      conflict: b.resolution?.conflict,
    });
  }

  // 8) derive scope — valid account mappings เท่านั้น (blocker semantics = Task 3)
  const derivedPlatforms = [...new Set([...resolutionByBinding.values()]
    .flatMap((r) => r.mappings.filter((m) => m.state === "valid" && m.platform != null).map((m) => m.platform as Platform)))].sort();
  const derivedShopIds = [...new Set([...resolutionByBinding.values()]
    .flatMap((r) => r.mappings.filter((m) => m.state === "valid" && m.shop_id != null).map((m) => m.shop_id as string)))].sort();

  // 9) version payload = canonical graph เดิม + derived scope + complete resolution —
  //    fingerprint ครอบคลุม resolution → retry deterministic
  // versionPayload ต้องมี BSON-safe shape เดียว — undefined-valued keys ถูก BSON drop
  // (edges[].branch, description ฯลฯ) → JSON round-trip strip เพื่อให้ fp/expected projection
  // เสถียรไม่ว่า curVersion จะผ่าน BSON serialize มาแล้วหรือยัง (payload = plain JSON, ไม่มี Date)
  const versionPayloadRaw = {
    name: curVersion.name, description: curVersion.description,
    shop_ids: derivedShopIds, platforms: derivedPlatforms,
    trigger_frequency: curVersion.trigger_frequency, false_branch_policy: curVersion.false_branch_policy,
    priority: curVersion.priority,
    nodes: curVersion.nodes, edges: curVersion.edges, handle_labels: curVersion.handle_labels,
  };
  const versionPayload = JSON.parse(JSON.stringify(versionPayloadRaw)) as typeof versionPayloadRaw;
  const fpIn = {
    ...versionPayload,
    resolution: versionBindings.map((b) => {
      const r = resolutionByBinding.get(b.binding_id)!;
      return {
        node_id: b.node_id, field_path: b.field_path, kind: b.kind, status: r.status,
        mappings: r.mappings.map((m) => ({ source_index: m.source_index, source_fp: m.source_fp,
          local_id: m.local_id,
          ...(m.platform !== undefined ? { platform: m.platform } : {}),
          ...(m.shop_id !== undefined ? { shop_id: m.shop_id } : {}),
          state: m.state, via: m.via,
          ...(m.carried !== undefined ? { carried: m.carried } : {}) })),
      };
    }),
  };
  const fp = stableFingerprint(fpIn);

  // 10) version artifact verify-or-insert — E11000 ไม่ใช่หลักฐานว่า artifact เดิมถูก:
  //     ทุก reuse path ต้องรีอ่าน + เทียบ canonical payload จริง (volatile fields
  //     normalized เป็น "x") — id mismatch/seq-foreign/phantom → fail closed
  let seq = expected + 1;
  let versionId = "";
  let expectedProj = "";
  for (;;) {
    versionId = "wv_" + _shortHash(`${workflowId}:${seq}:${fp}`);
    expectedProj = canonicalJson(JSON.parse(JSON.stringify({ _id: "x", created_at: "x", created_by: "x",
      version_id: versionId, workflow_id: workflowId, version_seq: seq,
      schema_version: "canonical-workflow/1", ...versionPayload,
      source_ref: curVersion.source_ref, import_batch_id: curVersion.import_batch_id, fingerprint: fp })));
    const candidates = await versions.find({ $or: [
      { version_id: versionId }, { workflow_id: workflowId, version_seq: seq } ] }).toArray();
    let verified = false;
    let seqTaken = false;
    for (const cand of candidates) {
      const same = canonicalJson(JSON.parse(JSON.stringify({ ...cand, _id: "x" as never, created_at: "x" as never, created_by: "x" }))) === expectedProj;
      if (cand.version_id === versionId) {
        if (!same) throw new Error(`version_id ${versionId} holds mismatched artifact — corrupt deterministic identity`);
        verified = true;
      } else seqTaken = true; // seq ถูกยึดด้วย payload อื่น → bump
    }
    if (verified) break;
    if (seqTaken) { seq += 1; continue; }
    try {
      await versions.insertOne({ version_id: versionId, workflow_id: workflowId, version_seq: seq,
        schema_version: "canonical-workflow/1", ...versionPayload,
        ...(curVersion.source_ref !== undefined ? { source_ref: curVersion.source_ref } : {}),
        ...(curVersion.import_batch_id !== undefined ? { import_batch_id: curVersion.import_batch_id } : {}),
        fingerprint: fp, created_at: now, created_by: actor } as WorkflowVersionDoc);
      break;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      // E11000: reread ทั้งสองกุญแจ — exact artifact → reuse; seq collision → bump;
      // ไม่มี artifact ที่อธิบายได้ → throw (fail closed)
      const after = await versions.find({ $or: [
        { version_id: versionId }, { workflow_id: workflowId, version_seq: seq } ] }).toArray();
      let explained = false;
      for (const cand of after) {
        const same = canonicalJson(JSON.parse(JSON.stringify({ ...cand, _id: "x" as never, created_at: "x" as never, created_by: "x" }))) === expectedProj;
        if (cand.version_id === versionId) {
          if (!same) throw new Error(`version_id ${versionId} holds mismatched artifact — corrupt deterministic identity`);
          explained = true;
        } else seqTaken = true;
      }
      if (explained) break;
      if (seqTaken) { seq += 1; continue; }
      throw e;
    }
  }
  // post-land multiplicity gate — app-level detection เท่านั้น (ไม่แทน atomic unique index):
  // ต้องมี doc เดียวถือ (workflow_id,version_seq) และ doc เดียวถือ version_id ซึ่งเป็น
  // artifact เดียวกันตาม canonical payload — divergence → fail closed ก่อน binding/pointer CAS
  const seqOwners = await versions.find({ workflow_id: workflowId, version_seq: seq }).toArray();
  const idOwners = await versions.find({ version_id: versionId }).toArray();
  const ownerProjs = [seqOwners[0], idOwners[0]].map((c) => c == null ? "<missing>"
    : canonicalJson(JSON.parse(JSON.stringify({ ...c, _id: "x" as never, created_at: "x" as never, created_by: "x" }))));
  if (seqOwners.length !== 1 || idOwners.length !== 1
    || seqOwners[0].version_id !== versionId || idOwners[0].version_seq !== seq
    || ownerProjs[0] !== expectedProj || ownerProjs[1] !== expectedProj) {
    throw new Error(`version artifact multiplicity at (workflow_id=${workflowId}, version_seq=${seq})/version_id=${versionId} — refusing commit (app-level gate; production unique indexes still required)`);
  }

  // 11) expected binding set — deterministic id; reuse เฉพาะเมื่อ canonical payload
  //     ตรงทุก field (timestamps/actor normalized) — mismatch/extra/missing → fail closed
  const expectedBindings = versionBindings.map((b) => {
    const r = resolutionByBinding.get(b.binding_id)!;
    const doc = {
      ...b, _id: undefined as never,
      binding_id: "wb_" + _shortHash(`${versionId}:${b.node_id}:${b.field_path}:${b.kind}`),
      version_id: versionId, status: r.status, created_at: now,
    } as WorkflowBindingDoc;
    if (r.mappings.length || r.conflict) {
      doc.resolution = { mappings: r.mappings, ...(r.conflict ? { conflict: r.conflict } : {}) };
    } else delete doc.resolution;
    // canonical persisted shape — undefined-valued keys ห้ามถูกเขียน (BSON drop → shape เบี้ยว)
    const dd = doc as unknown as Record<string, unknown>;
    for (const k of Object.keys(dd)) if (dd[k] === undefined) delete dd[k];
    return doc;
  });
  const expectedBindProj = new Map<string, string>();
  for (const exp of expectedBindings) {
    expectedBindProj.set(exp.binding_id, canonicalJson(JSON.parse(JSON.stringify({ ...exp, _id: "x" as never, created_at: "x" as never,
      resolution: exp.resolution ? { ...exp.resolution, mappings: exp.resolution.mappings.map((m) => ({
        ...m, resolved_by: "x", resolved_at: "x" as never, invalidated_at: "x" as never })) } : undefined }))));
  }
  for (const exp of expectedBindings) {
    const expProj = expectedBindProj.get(exp.binding_id)!;
    const existing = await bindings.findOne({ binding_id: exp.binding_id });
    if (existing) {
      if (canonicalJson(JSON.parse(JSON.stringify({ ...existing, _id: "x" as never, created_at: "x" as never,
          resolution: existing.resolution ? { ...existing.resolution, mappings: existing.resolution.mappings.map((m) => ({
            ...m, resolved_by: "x", resolved_at: "x" as never, invalidated_at: "x" as never })) } : undefined }))) !== expProj) {
        throw new Error(`binding ${exp.binding_id} holds mismatched artifact — corrupt deterministic identity`);
      }
      continue;
    }
    try {
      await bindings.insertOne(exp);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      const again = await bindings.findOne({ binding_id: exp.binding_id });
      if (!again || canonicalJson(JSON.parse(JSON.stringify({ ...again, _id: "x" as never, created_at: "x" as never,
          resolution: again.resolution ? { ...again.resolution, mappings: again.resolution.mappings.map((m) => ({
            ...m, resolved_by: "x", resolved_at: "x" as never, invalidated_at: "x" as never })) } : undefined }))) !== expProj) {
        throw new Error(`binding ${exp.binding_id}: E11000 without matching artifact — corrupt deterministic identity`);
      }
    }
  }
  // exact-set gate — persisted rows ใน scope {workflow_id, version_id} ต้องเท่ากับ
  // expected set พอดี: ครบทุก id, ไม่มี dup, ไม่มี extra, payload ตรง — ก่อน pointer CAS เสมอ
  const persistedBinds = await bindings.find({ workflow_id: workflowId, version_id: versionId }).toArray();
  const expectedBindIds = new Set(expectedBindings.map((d) => d.binding_id));
  const seenBindIds = new Set<string>();
  for (const d of persistedBinds) {
    if (!expectedBindIds.has(d.binding_id)) throw new Error(`binding ${d.binding_id}: unexpected row in resolved version scope`);
    if (seenBindIds.has(d.binding_id)) throw new Error(`binding ${d.binding_id}: duplicate rows in resolved version scope`);
    seenBindIds.add(d.binding_id);
    if (canonicalJson(JSON.parse(JSON.stringify({ ...d, _id: "x" as never, created_at: "x" as never,
        resolution: d.resolution ? { ...d.resolution, mappings: d.resolution.mappings.map((m) => ({
          ...m, resolved_by: "x", resolved_at: "x" as never, invalidated_at: "x" as never })) } : undefined })))
      !== expectedBindProj.get(d.binding_id)) {
      throw new Error(`binding ${d.binding_id}: persisted payload diverges from expected`);
    }
  }
  if (seenBindIds.size !== expectedBindIds.size) {
    throw new Error(`binding set incomplete — ${seenBindIds.size}/${expectedBindIds.size} persisted`);
  }

  // 12) commit — pointer+version+derived scope ใน updateOne เดียว (half-update ไม่มี)
  const commit = await workflows.updateOne(
    { workflow_id: workflowId, is_deleted: { $ne: true }, version: expected },
    { $set: {
      current_version_id: versionId, version: seq,
      enabled: false, status: "draft",
      platforms: derivedPlatforms, shop_ids: derivedShopIds,
      updated_at: new Date(), updated_by: actor,
    } }
  );
  if (commit.matchedCount === 0) {
    // reread ครั้งเดียว — รายงาน winner จริง ไม่ใช่ค่าที่จับก่อน race; ไม่ auto-retry CAS
    const fresh = await workflows.findOne({ workflow_id: workflowId, is_deleted: { $ne: true } });
    return { ok: false, conflict: true,
      current_version: fresh?.version ?? wf.version, current_version_id: fresh?.current_version_id ?? wf.current_version_id };
  }

  // 13) audit หลัง commit เท่านั้น — audit fail ไม่กลืน commit
  let resolved = 0, unresolved = 0, invalid = 0;
  for (const r of resolutionByBinding.values()) {
    if (r.status === "resolved") resolved++;
    else if (r.status === "invalid") invalid++;
    else unresolved++;
  }
  repeated.sort((x, y) => x.binding_id === y.binding_id
    ? x.source_index - y.source_index : (x.binding_id < y.binding_id ? -1 : 1));
  try {
    await logAdminEvent({
      action_type: "workflow.binding_resolve", actor,
      metadata: { workflow_id: workflowId, version_id: versionId, seq,
        resolved, unresolved, invalid, repeated: repeated.length, overlap: [],
        platforms: derivedPlatforms, shop_ids: derivedShopIds },
    });
  } catch { /* post-commit audit failure — commit สำเร็จแล้ว */ }
  return { ok: true, version: seq, version_id: versionId,
    resolved, unresolved, invalid, repeated, publish_blockers: [], overlap_conflicts: [] };
}

// ─── Import detail surface (UI read model) ────────────────
export interface WorkflowImportDetail {
  workflow_id: string;
  name: string;
  source: "zaapi" | "canonical" | null;
  source_ref: CanonicalDraft["sourceRef"] | null;
  current_version_id: string | null;
  version_seq: number | null;
  import_batch_id: string | null;
  fingerprint: string | null;
  bindings: { node_id: string; field_path: string; kind: string; count: number; status: BindingStatus }[];
  unresolved_bindings: number;
  publish_blockers: string[];
}

export async function getWorkflowImportDetail(workflowId: string): Promise<WorkflowImportDetail | null> {
  const wf = await getWorkflow(workflowId);
  if (!wf) return null;
  const versions = await getCollection<WorkflowVersionDoc>(COLLECTIONS.workflowVersions);
  const version = wf.current_version_id
    ? await versions.findOne({ version_id: wf.current_version_id })
    : null;
  const bindings = await getCollection<WorkflowBindingDoc>(COLLECTIONS.workflowBindings);
  const binds = version ? await bindings.find({ workflow_id: workflowId, version_id: version.version_id }).toArray() : [];
  const capability = validateCanonicalDraft(
    version?.nodes || wf.nodes, version?.edges || wf.edges, wf.platforms || [],
    binds.map((b) => ({ node_id: b.node_id, kind: b.kind })),
  );
  return {
    workflow_id: wf.workflow_id, name: wf.name,
    source: wf.import?.source ?? null,
    source_ref: version?.source_ref ?? null,
    current_version_id: version?.version_id ?? null,
    version_seq: version?.version_seq ?? null,
    import_batch_id: version?.import_batch_id ?? wf.import?.batch_id ?? null,
    fingerprint: version?.fingerprint ?? null,
    bindings: binds.map((b) => ({ node_id: b.node_id, field_path: b.field_path, kind: b.kind, count: b.count, status: b.status })),
    unresolved_bindings: binds.filter((b) => b.status === "unresolved").length,
    publish_blockers: capability.errors,
  };
}

export const workflowService = {
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  toggleWorkflow,
  deleteWorkflow,
  restoreWorkflow,
  applyImportBatch,
  saveWorkflowDraft,
  saveBindingResolutionBatch,
  getWorkflowImportDetail,
  validateWorkflowGraph,
};
