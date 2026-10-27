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
import {
  stableFingerprint, provenanceSnapshot,
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
  getWorkflowImportDetail,
  validateWorkflowGraph,
};
