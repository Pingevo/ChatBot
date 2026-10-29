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
