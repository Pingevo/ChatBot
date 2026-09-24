// backlogService — pending assignment distributor (Part G)
// ใช้กับ 2 store: ticket จริง (status_conversation) + botworker (test_status_conversation[botworker])
// preview = คำนวณแผนอย่างเดียวไม่เขียน DB; commit = re-run planner + atomic assign ทีละตัว
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { statusConversationService } from "./statusConversationService";
import { testStatusConversationService } from "./testStatusConversationService";
import { logAdminEvent } from "./adminLogService";
import { logBotworkerEvent } from "./botworkerEventService";
import { auth } from "./authService";

export type BacklogSource = "ticket" | "botworker";
export type BacklogMode = "round_robin_selected" | "least_loaded_selected" | "manual_quota";

export interface BacklogItem {
  conversation_id: string;
  shop_id?: string;
  platform?: string;
  assignment_reason?: string;
  pending_since?: Date;
}

export interface BacklogPlanInput {
  source: BacklogSource;
  admin_ids: string[];
  mode: BacklogMode;
  limit?: number;
  quotas?: Record<string, number>;
}

export interface BacklogPlan {
  total_pending: number;
  planned: number;
  skipped: number;
  assignments: { conversation_id: string; admin_id: string }[];
  per_admin: Record<string, number>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const PENDING_FILTER = {
  pending_assignment: true,
  $or: [{ assigned_to: null }, { assigned_to: { $exists: false } }],
};

/** list pending items ของ source (เรียงเก่าก่อน — งานค้างนานสุดควรได้ก่อน) */
export async function listPending(source: BacklogSource, limit = 200): Promise<BacklogItem[]> {
  if (source === "botworker") {
    const c = await getCollection(COLLECTIONS.testStatusConversation);
    const docs = await c
      .find({ ...PENDING_FILTER, source: "botworker" })
      .sort({ updated_at: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({
      conversation_id: d.conversation_id,
      shop_id: d.shop_id,
      platform: d.platform,
      assignment_reason: d.assignment_reason,
      pending_since: d.updated_at,
    }));
  }
  const c = await getCollection(COLLECTIONS.statusConversation);
  const docs = await c.find(PENDING_FILTER).sort({ updated_at: 1 }).limit(limit).toArray();
  return docs.map((d) => ({
    conversation_id: d.conversation_id,
    shop_id: d.shop_id,
    platform: d.platform,
    assignment_reason: d.assignment_reason,
    pending_since: d.updated_at,
  }));
}

/** นับงานเปิดปัจจุบันของ admin แต่ละคน (สำหรับ least_loaded) — นับจาก store เดียวกับ source */
async function countOpenLoad(source: BacklogSource, adminIds: string[]): Promise<Record<string, number>> {
  const load: Record<string, number> = Object.fromEntries(adminIds.map((id) => [id, 0]));
  const filter = { assigned_to: { $in: adminIds }, status: { $in: ["open", "handoff"] } };
  const collName = source === "botworker" ? COLLECTIONS.testStatusConversation : COLLECTIONS.statusConversation;
  const c = await getCollection(collName);
  const extra = source === "botworker" ? { source: "botworker" } : {};
  const rows = await c
    .aggregate([{ $match: { ...filter, ...extra } }, { $group: { _id: "$assigned_to", n: { $sum: 1 } } }])
    .toArray();
  for (const r of rows) load[r._id] = r.n;
  return load;
}

/** validate admin pool — เฉพาะ active + role=admin (superadmin เลือกเองได้แม้พักรับแชท ตาม plan ข้อ 2) */
export async function validateAdminPool(adminIds: string[]): Promise<{ ok: string[]; rejected: { id: string; reason: string }[] }> {
  const ok: string[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const id of adminIds) {
    const a = await auth.getAdminById(id);
    if (!a) rejected.push({ id, reason: "not found" });
    else if (a.role !== "admin") rejected.push({ id, reason: "role must be admin" });
    else if (a.active === false) rejected.push({ id, reason: "inactive" });
    else ok.push(id);
  }
  return { ok, rejected };
}

/** คำนวณแผนจ่ายงาน — pure (ไม่เขียน DB) ใช้ได้ทั้ง preview และ commit */
export async function buildPlan(input: BacklogPlanInput): Promise<BacklogPlan> {
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const pending = await listPending(input.source, MAX_LIMIT);
  const total = pending.length;
  const targets = pending.slice(0, limit);
  const admins = input.admin_ids;
  const assignments: { conversation_id: string; admin_id: string }[] = [];
  const perAdmin: Record<string, number> = Object.fromEntries(admins.map((id) => [id, 0]));

  if (admins.length === 0 || targets.length === 0) {
    return { total_pending: total, planned: 0, skipped: total, assignments, per_admin: perAdmin };
  }

  if (input.mode === "manual_quota") {
    // quota ต่อคน — เติมตามลำดับ admin_ids จน quota หมด
    const quotas = input.quotas || {};
    let idx = 0;
    for (const adminId of admins) {
      const q = Math.max(0, Math.floor(quotas[adminId] ?? 0));
      for (let i = 0; i < q && idx < targets.length; i++, idx++) {
        assignments.push({ conversation_id: targets[idx].conversation_id, admin_id: adminId });
        perAdmin[adminId]++;
      }
    }
  } else if (input.mode === "least_loaded_selected") {
    // งานน้อยสุดได้ก่อน — tie → ตามลำดับ admin_ids
    const load = await countOpenLoad(input.source, admins);
    const order = [...admins].sort((a, b) => load[a] - load[b] || admins.indexOf(a) - admins.indexOf(b));
    let rr = 0;
    for (const t of targets) {
      const adminId = order[rr % order.length];
      assignments.push({ conversation_id: t.conversation_id, admin_id: adminId });
      perAdmin[adminId]++;
      load[adminId]++;
      // re-sort เพื่อให้คนงานน้อยสุดอยู่หัวเสมอ
      order.sort((a, b) => load[a] - load[b] || admins.indexOf(a) - admins.indexOf(b));
      rr = 0; // เอาหัวคิวเสมอหลัง sort
    }
  } else {
    // round_robin_selected — วนตามลำดับ admin_ids
    for (let i = 0; i < targets.length; i++) {
      const adminId = admins[i % admins.length];
      assignments.push({ conversation_id: targets[i].conversation_id, admin_id: adminId });
      perAdmin[adminId]++;
    }
  }

  return { total_pending: total, planned: assignments.length, skipped: total - assignments.length, assignments, per_admin: perAdmin };
}

/** commit แผน — re-run planner + atomic assign ทีละตัว (re-check pending กัน race) + idem_key กันซ้ำ */
export async function commitPlan(
  input: BacklogPlanInput & { idem_key: string },
  actor: string
): Promise<{ ok: boolean; applied: number; skipped_race: number; idempotent_replay?: boolean; plan: BacklogPlan }> {
  const logsColl = input.source === "botworker" ? COLLECTIONS.botworkerEvents : COLLECTIONS.adminLogs;
  const logs = await getCollection(logsColl);
  const dupe = await logs.findOne(
    input.source === "botworker"
      ? { type: "backlog_commit", "metadata.idem_key": input.idem_key }
      : { action_type: "backlog_commit", "metadata.idem_key": input.idem_key }
  );
  if (dupe) {
    return { ok: true, applied: 0, skipped_race: 0, idempotent_replay: true, plan: { total_pending: 0, planned: 0, skipped: 0, assignments: [], per_admin: {} } };
  }

  const plan = await buildPlan(input);
  let applied = 0;
  let skippedRace = 0;
  for (const a of plan.assignments) {
    const ok =
      input.source === "botworker"
        ? await testStatusConversationService.assignPendingTestTicket(a.conversation_id, "botworker", a.admin_id)
        : await statusConversationService.assignPendingTicket(a.conversation_id, a.admin_id, actor);
    if (ok) applied++;
    else skippedRace++;
  }

  const meta = { idem_key: input.idem_key, mode: input.mode, admin_ids: input.admin_ids, applied, skipped_race: skippedRace, total_pending: plan.total_pending };
  if (input.source === "botworker") {
    await logBotworkerEvent({ type: "backlog_commit", actor, metadata: meta });
  } else {
    await logAdminEvent({ action_type: "backlog_commit", actor, metadata: meta });
  }

  return { ok: true, applied, skipped_race: skippedRace, plan };
}
