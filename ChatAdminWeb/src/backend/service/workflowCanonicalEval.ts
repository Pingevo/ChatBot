// Canonical (Zaapi-import) node evaluators — owner ของความหมาย canonical:
//   config.conditions[] → eval ทีละตัวตามลำดับ → branch "condition-index-i";
//   ไม่มีตัวผ่าน → "no-match" (ไม่มี edge = flow จบตาม walkGraph เดิม)
// external ids ถูก strip ออกจาก config ตอน import → executor resolve ผ่าน
//   workflow_bindings (node_id + field_path + kind → resolution.mappings.local_id)
// legacy evaluator ไม่แตะ — dispatch อยู่ใน evalCondition (workflowEngine.ts)
import { getCollection } from "../db/mongoClient";
import { COLLECTIONS } from "../db/mongoClient";
import { getShop } from "./shopService";
import * as statusConversationService from "./statusConversationService";
import { assignmentService } from "./assignmentService";
import { handoffService } from "./handoffService";
import type { WorkflowNode } from "./workflowService";

// ─── types ────────────────────────────────────────────────
export interface CanonicalCondition {
  operator: string;
  [k: string]: unknown;
}

export interface EvalMessage {
  conversation_id: string;
  shop_id: string;
  config_shop_key?: string;
  platform?: string;
  text?: string;
  images?: string[];
  testSource?: string;
}

export interface EvalResult { branch: string; error?: string }

type DayKey = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";
const DAY_KEYS: DayKey[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const UNIT_MS: Record<string, number> = {
  seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000,
};

export function hasCanonicalConditions(config: unknown): boolean {
  return !!config && typeof config === "object" && Array.isArray((config as { conditions?: unknown }).conditions);
}

// ─── schedule eval (shared: business_hours per-shop + event_time schedule) ─
// shape เดียวกับ Zaapi: { DAY: [{start,end}] } นาทีจากเที่ยงคืน + timezone
export type TimeSchedule = Partial<Record<DayKey, { start: number; end: number }[]>>;

export function minuteInTz(now: Date, timezone: string): { day: DayKey; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const day = ({ Sun: "SUN", Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT" } as Record<string, DayKey>)[get("weekday")] || "SUN";
  const hour = parseInt(get("hour"), 10) % 24;
  return { day, minute: hour * 60 + parseInt(get("minute"), 10) };
}

export function isWithinSchedule(now: Date, schedule: TimeSchedule, timezone: string): boolean {
  const { day, minute } = minuteInTz(now, timezone);
  for (const w of schedule[day] || []) {
    if (minute >= w.start && minute < w.end) return true;
  }
  return false;
}

// ─── business hours: per-shop config (Zaapi เก็บนอก flow — เราเก็บบน shop doc) ─
export interface BusinessHoursConfig { timezone: string; schedule: TimeSchedule }

export async function isWithinOfficeHours(msg: EvalMessage, now = new Date()): Promise<boolean> {
  const shop = await getShop(msg.shop_id);
  const bh = shop?.business_hours as BusinessHoursConfig | undefined;
  if (!bh || typeof bh.timezone !== "string" || !bh.schedule) {
    throw new Error(`shop ${msg.shop_id}: ไม่มี business_hours config — ตั้งเวลาทำการก่อน activate flow`);
  }
  return isWithinSchedule(now, bh.schedule, bh.timezone);
}

// ─── customer_waiting_time / last_interaction — อ่าน messages collection ──
interface MessageTsDoc { direction?: string; created_timestamp?: Date }

export async function customerWaitingMs(conversationId: string, now = new Date()): Promise<number> {
  const coll = await getCollection<MessageTsDoc>(COLLECTIONS.messages);
  const lastIn = await coll.findOne(
    { conversation_id: conversationId, direction: "in" },
    { sort: { created_timestamp: -1 } },
  );
  if (!lastIn?.created_timestamp) return 0;
  const outAfter = await coll.findOne(
    { conversation_id: conversationId, direction: "out", created_timestamp: { $gt: lastIn.created_timestamp } } as never,
    { sort: { created_timestamp: -1 }, projection: { _id: 1 } },
  );
  if (outAfter) return 0; // มี staff/bot ตอบแล้ว → ไม่ได้รอ
  return Math.max(0, now.getTime() - lastIn.created_timestamp.getTime());
}

export async function lastInteractionMs(conversationId: string, now = new Date()): Promise<number> {
  const coll = await getCollection<MessageTsDoc>(COLLECTIONS.messages);
  const lastIn = await coll.findOne(
    { conversation_id: conversationId, direction: "in" },
    { sort: { created_timestamp: -1 } },
  );
  if (!lastIn?.created_timestamp) return Number.MAX_SAFE_INTEGER; // ไม่เคยมี interaction → greater_than true เสมอ
  return Math.max(0, now.getTime() - lastIn.created_timestamp.getTime());
}

// ─── bound ids — resolve external identity ผ่าน workflow_bindings ─────────
interface BindingRow {
  resolution?: { mappings?: { local_id?: string; state?: string }[] };
}

export async function boundLocalIds(
  workflowId: string, versionId: string | undefined,
  nodeId: string, fieldPath: string, kind: string,
): Promise<string[]> {
  if (!versionId) return [];
  const coll = await getCollection<BindingRow>(COLLECTIONS.workflowBindings);
  const row = await coll.findOne({ workflow_id: workflowId, version_id: versionId, node_id: nodeId, field_path: fieldPath, kind } as never);
  const maps = row?.resolution?.mappings || [];
  return maps.filter((m) => m.state === "valid" && typeof m.local_id === "string").map((m) => m.local_id as string);
}

// ─── per-condition predicate ──────────────────────────────
function durationMs(v: unknown): number {
  const d = v as { unit?: string; value?: number } | undefined;
  const ms = UNIT_MS[String(d?.unit || "")];
  return ms ? Number(d?.value || 0) * ms : NaN;
}

async function evalCanonicalCondition(
  node: WorkflowNode, cond: CanonicalCondition, index: number,
  msg: EvalMessage, workflowId: string, versionId: string | undefined, now: Date,
): Promise<boolean> {
  const op = String(cond.operator || "");
  switch (node.subtype) {
    case "business_hours": {
      const within = await isWithinOfficeHours(msg, now);
      if (op === "within_office_hours") return within;
      if (op === "outside_office_hours") return !within;
      throw new Error(`business_hours: unknown operator "${op}"`);
    }
    case "event_time": {
      const cfg = node.config as { schedule?: TimeSchedule; eventTimeZone?: string };
      if (!cfg.schedule || typeof cfg.eventTimeZone !== "string") {
        throw new Error(`event_time node ${node.node_id}: ไม่มี schedule/eventTimeZone`);
      }
      const within = isWithinSchedule(now, cfg.schedule, cfg.eventTimeZone);
      if (op === "within_time_range") return within;
      if (op === "outside_time_range") return !within;
      throw new Error(`event_time: unknown operator "${op}"`);
    }
    case "customer_waiting_time": {
      if (op !== "greater_than") throw new Error(`customer_waiting_time: unknown operator "${op}"`);
      const ms = await customerWaitingMs(msg.conversation_id, now);
      const threshold = durationMs(cond.customerWaitingTime);
      if (Number.isNaN(threshold)) throw new Error(`customer_waiting_time node ${node.node_id}: invalid customerWaitingTime`);
      return ms > threshold;
    }
    case "last_interaction": {
      if (op !== "greater_than") throw new Error(`last_interaction: unknown operator "${op}"`);
      const ms = await lastInteractionMs(msg.conversation_id, now);
      const threshold = durationMs(cond.lastInteraction);
      if (Number.isNaN(threshold)) throw new Error(`last_interaction node ${node.node_id}: invalid lastInteraction`);
      return ms > threshold;
    }
    case "assignee": {
      // Zaapi conversation_assignee — assigneeUserId ถูก strip → resolve ผ่าน binding
      if (op !== "equals") throw new Error(`assignee: unknown operator "${op}"`);
      const ids = await boundLocalIds(workflowId, versionId, node.node_id, `conditions[${index}].assigneeUserId`, "user");
      if (ids.length === 0) return false; // binding ยังไม่ resolve → fail closed (ไม่ match)
      const meta = await statusConversationService.getMeta(msg.conversation_id);
      return !!meta?.assigned_to && ids.includes(meta.assigned_to);
    }
    case "message_content": {
      // Zaapi msgType: text → text operators; image/video → media-type check (equals เท่านั้น)
      const mt = String(cond.msgType || "text");
      const texts = Array.isArray(cond.text) ? (cond.text as unknown[]).map(String) : [];
      if (mt === "image" || mt === "video") {
        if (op !== "equals") throw new Error(`message_content ${mt}: unknown operator "${op}"`);
        const imgs = msg.images || [];
        const isVideo = (u: string) => /\.(mp4|mov|webm|m4v|avi)([?#]|$)/i.test(u);
        return mt === "video" ? imgs.some(isVideo) : imgs.length > 0 && !imgs.every(isVideo);
      }
      if (mt !== "text") throw new Error(`message_content: unknown msgType "${mt}"`);
      const body = String(msg.text || "");
      if (op === "contains_one_of") {
        const lower = body.toLowerCase();
        return texts.some((k) => k.trim().length > 0 && lower.includes(k.toLowerCase()));
      }
      if (op === "equals") {
        const trimmed = body.trim().toLowerCase();
        return texts.some((k) => trimmed === k.trim().toLowerCase());
      }
      throw new Error(`message_content: unknown operator "${op}"`);
    }
    case "label": {
      // Zaapi label condition — labelIds strip → binding
      //   contains_one_of = มี label อันใดอันหนึ่ง; equals = มีครบทุกตัวที่ระบุ
      const ids = await boundLocalIds(workflowId, versionId, node.node_id, `conditions[${index}].labelIds`, "label");
      if (ids.length === 0) return false; // binding unresolved → fail closed
      const conv = await getCollection<{ labels?: string[] }>(COLLECTIONS.conversations);
      const doc = await conv.findOne({ conversation_id: msg.conversation_id } as never);
      const have = new Set(doc?.labels || []);
      if (op === "contains_one_of") return ids.some((l) => have.has(l));
      if (op === "equals") return ids.every((l) => have.has(l));
      throw new Error(`label: unknown operator "${op}"`);
    }
    default:
      throw new Error(`canonical condition subtype "${node.subtype}" ยังไม่มี evaluator`);
  }
}

// ─── main entry — eval conditions[] ตามลำดับ ──────────────
export async function evalCanonicalConditions(
  node: WorkflowNode, msg: EvalMessage,
  workflowId: string, versionId: string | undefined, now = new Date(),
): Promise<EvalResult> {
  const conditions = (node.config as { conditions?: CanonicalCondition[] }).conditions || [];
  for (let i = 0; i < conditions.length; i++) {
    if (await evalCanonicalCondition(node, conditions[i], i, msg, workflowId, versionId, now)) {
      return { branch: `condition-index-${i}` };
    }
  }
  return { branch: "no-match" };
}

// ─── canonical assign — Zaapi chat_assign (config.action.assignment) ────
// pool: bound userIds → กลุ่ม admin ที่ bind ไว้; teamIds → แอดมินทั้งหมดในระบบ
//   (user ยืนยัน semantics: Zaapi team = all admins — ใช้ global pool เดิม)
// round-robin: cursor แยกต่อ node (`zaapi:<wf>:<node>`) = lastAssignedUsersIndex
//   ของ Zaapi — cursor ของระบบเก่าไม่ย้ายมา เริ่มนับใหม่ในระบบเรา
export function hasCanonicalAssignment(config: unknown): boolean {
  const a = (config as { action?: { assignment?: unknown } } | undefined)?.action?.assignment;
  return !!a && typeof a === "object";
}

export type CanonicalAssignPick =
  | { pick: string; mode: "user_pool" | "all_admins" | "last_ticket_handler" }
  | { pick: null; mode: "no_eligible_agent" }
  | { skip: "all_out_of_hours" }
  | { error: string };

export async function pickCanonicalAssignee(
  node: WorkflowNode, msg: EvalMessage,
  workflowId: string, versionId: string | undefined,
  now = new Date(),
): Promise<CanonicalAssignPick> {
  const asg = (node.config as {
    action?: { assignment?: {
      assignWhenAllOoh?: boolean; assignToLastTicketHandledBy?: boolean;
      teamIds?: unknown[]; userIds?: unknown[];
    } };
  }).action?.assignment || {};

  // assignWhenAllOoh === false → ร้านนอกเวลาทำการ → ไม่ assign แต่เดิน flow ต่อ
  //   (business_hours missing → isWithinOfficeHours throw → fail closed เหมือน evaluator)
  if (asg.assignWhenAllOoh === false && !(await isWithinOfficeHours(msg, now))) {
    return { skip: "all_out_of_hours" };
  }

  const userIds = await boundLocalIds(
    workflowId, versionId, node.node_id, "action.assignment.userIds", "user");
  const teamIds = await boundLocalIds(
    workflowId, versionId, node.node_id, "action.assignment.teamIds", "team");

  let pool: string[];
  let mode: "user_pool" | "all_admins";
  if (userIds.length > 0) {
    pool = userIds; mode = "user_pool";
  } else if (teamIds.length > 0) {
    // Zaapi team = แอดมินทั้งหมด — binding resolve เป็น "all_admins" แล้วเท่านั้น
    //   (fail-closed เหมือน userIds — unresolved → error ไม่ใช่เดา pool)
    //   buildPool equal_global คืน ordered admin ids ชุดเดียวกัน
    //   (poolKey ของ buildPool ไม่ใช้ — cursor ต้องแยกต่อ node ไม่แชร์กับ source อื่น)
    const built = await assignmentService.buildPool(
      "equal_global", { shop_id: msg.shop_id, platform: msg.platform || "" }, "zaapi");
    pool = built.orderedAgentIds; mode = "all_admins";
  } else {
    return { error: `assign node ${node.node_id}: ไม่มี bound userIds/teamIds — resolve bindings ก่อน` };
  }
  if (pool.length === 0) return { pick: null, mode: "no_eligible_agent" };

  // assignToLastTicketHandledBy → คนที่เคยตอบ ticket นี้ล่าสุด ถ้ายังอยู่ใน pool
  if (asg.assignToLastTicketHandledBy === true) {
    const last = await handoffService.getLastReplyAdmin(msg.conversation_id);
    if (last && pool.includes(last)) return { pick: last, mode: "last_ticket_handler" };
  }

  const sel = await assignmentService.reserveNextAgent(`zaapi:${workflowId}:${node.node_id}`, pool);
  if (sel.result === "reserved") return { pick: sel.agentId, mode };
  if (sel.result === "contention") return { error: "reservation_contention" };
  return { pick: null, mode: "no_eligible_agent" };
}

// ─── canonical trigger match — Zaapi inbound triggers ───────────────────
// message_received: ยิงทุกข้อความเข้า (ไม่มี keyword gate เหมือน legacy)
//   account scope: accountIds (strip → binding kind=account → local_id=shop_id)
//     binding row มีแต่ยังไม่ resolve → fail closed (ไม่ match)
//     ไม่มี binding row → source ไม่ได้จำกัด account → ทุก account match
//   triggerOncePerConversation: ยิงครั้งเดียวต่อ conversation (run เก่าสถานะใดก็นับ)
//   triggerOncePerOpen: ยิงครั้งเดียวต่อ open episode — episode boundary =
//     close_history ล่าสุด (run ที่เกิดหลัง close ล่าสุด = episode ปัจจุบัน)
// subtypes อื่น (label_added/marketplace/...) ไม่ใช่ inbound-message trigger → false
export const CANONICAL_INBOUND_TRIGGERS = new Set(["message_received"]);

export async function canonicalTriggerMatches(
  triggerNode: WorkflowNode, msg: EvalMessage,
  workflowId: string, versionId: string | undefined,
): Promise<boolean> {
  if (!CANONICAL_INBOUND_TRIGGERS.has(String(triggerNode.subtype))) return false;

  // account scope — binding row มีอยู่ไหม (source มี accountIds → requirement ถูกสร้าง)
  const bindColl = await getCollection<BindingRow & { count?: number }>(COLLECTIONS.workflowBindings);
  const acctReq = versionId
    ? await bindColl.findOne({ workflow_id: workflowId, version_id: versionId, node_id: triggerNode.node_id, field_path: "accountIds", kind: "account" } as never)
    : null;
  if (acctReq) {
    const ids = await boundLocalIds(workflowId, versionId, triggerNode.node_id, "accountIds", "account");
    if (ids.length === 0) return false; // resolve ยังไม่เสร็จ → fail closed
    if (!ids.includes(msg.shop_id)) return false;
  }

  const cfg = triggerNode.config as {
    triggerOncePerConversation?: boolean; triggerOncePerOpen?: boolean;
  } | undefined;
  const runs = await getCollection<{ workflow_id: string; conversation_id: string; started_at: Date }>(COLLECTIONS.workflowRuns);
  if (cfg?.triggerOncePerConversation === true) {
    const prior = await runs.findOne({ workflow_id: workflowId, conversation_id: msg.conversation_id } as never);
    if (prior) return false;
  }
  if (cfg?.triggerOncePerOpen === true) {
    const closeHist = await getCollection<{ conversation_id: string; closed_at: Date }>(COLLECTIONS.closeHistory);
    const lastClose = await closeHist.findOne({ conversation_id: msg.conversation_id } as never, { sort: { closed_at: -1 } });
    const filter: Record<string, unknown> = { workflow_id: workflowId, conversation_id: msg.conversation_id };
    if (lastClose?.closed_at) filter.started_at = { $gt: lastClose.closed_at };
    const prior = await runs.findOne(filter as never);
    if (prior) return false;
  }
  return true;
}
