// ChatAccept service — track สถานะรับแชท/พัก ของ admin + เวลาทำงาน
//
// Data flow:
//   admin toggle รับแชท (true)  → startSession(accepting)
//   admin toggle พัก (false)     → startSession(paused) (close ก่อนหน้าถ้ามี)
//
// Session ปัจจุบัน = the latest open session for each admin
//   - state "accepting" → กำลังรับแชทอยู่
//   - state "paused"    → กำลังพักอยู่
//
// Stats วันนี้ = sum ของ duration แยกตาม state ตั้งแต่เทียงถึงปัจจุบัน
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";

export type AcceptState = "accepting" | "paused";

export interface ChatAcceptSessionDoc extends Document {
  session_id: string;
  admin_id: string;
  state: AcceptState;
  started_at: Date;
  ended_at?: Date;
  duration_ms?: number;         // กรอกตอน close session
  reason?: string;              // optional note
}

function genSessionId(): string {
  return "cas_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * ปิด session เปิดที่ยังไม่จบ ของ admin (ถ้ามี) — คำนวณ duration
 */
async function closeOpenSession(adminId: string): Promise<void> {
  const coll = await getCollection<ChatAcceptSessionDoc>(COLLECTIONS.chatAcceptSessions);
  const open = await coll.findOne({
    admin_id: adminId,
    ended_at: { $exists: false },
  });
  if (!open) return;
  const now = new Date();
  await coll.updateOne(
    { _id: open._id },
    { $set: { ended_at: now, duration_ms: now.getTime() - open.started_at.getTime() } }
  );
}

/**
 * Start a new session — ปิด session เดิมก่อน (ถ้ามี) แล้วเปิดใหม่
 * เรียกเมื่อ admin toggle รับแชท/พัก
 */
export async function startSession(
  adminId: string,
  state: AcceptState,
  reason?: string
): Promise<ChatAcceptSessionDoc> {
  await closeOpenSession(adminId);
  const coll = await getCollection<ChatAcceptSessionDoc>(COLLECTIONS.chatAcceptSessions);
  const doc: ChatAcceptSessionDoc = {
    session_id: genSessionId(),
    admin_id: adminId,
    state,
    started_at: new Date(),
    reason,
  };
  await coll.insertOne(doc);
  return doc;
}

/**
 * สถานะปัจจุบันของ admin — session ล่าสุดที่ยังเปิดอยู่ (ถ้ามี)
 */
export async function getCurrentState(
  adminId: string
): Promise<{ state: AcceptState; since: Date } | null> {
  const coll = await getCollection<ChatAcceptSessionDoc>(COLLECTIONS.chatAcceptSessions);
  const open = await coll.findOne({
    admin_id: adminId,
    ended_at: { $exists: false },
  }, { sort: { started_at: -1 } });
  if (!open) return null;
  return { state: open.state, since: open.started_at };
}

/**
 * สถานะปัจจุบันของหลาย admin พร้อมกัน — ใช้ใน Team page
 */
export async function getCurrentStates(
  adminIds: string[]
): Promise<Record<string, { state: AcceptState; since: Date } | null>> {
  if (adminIds.length === 0) return {};
  const coll = await getCollection<ChatAcceptSessionDoc>(COLLECTIONS.chatAcceptSessions);
  // หา session เปิดทั้งหมดของ admin เหล่านี้
  const openSessions = await coll
    .find({
      admin_id: { $in: adminIds },
      ended_at: { $exists: false },
    })
    .sort({ started_at: -1 })
    .toArray();
  // เอา session ล่าสุดของแต่ละ admin
  const result: Record<string, { state: AcceptState; since: Date } | null> = {};
  for (const id of adminIds) result[id] = null;
  for (const s of openSessions) {
    if (result[s.admin_id] === null) {
      result[s.admin_id] = { state: s.state, since: s.started_at };
    }
  }
  return result;
}

/**
 * Stats ของ admin วันนี้ (เที่ยงคืนถึงปัจจุบัน)
 * คืน: { accepting_ms, paused_ms, accepting_sessions, paused_sessions }
 */
export async function getTodayStats(
  adminId: string,
  now: Date = new Date()
): Promise<{
  accepting_ms: number;
  paused_ms: number;
  accepting_sessions: number;
  paused_sessions: number;
}> {
  const coll = await getCollection<ChatAcceptSessionDoc>(COLLECTIONS.chatAcceptSessions);
  // เที่ยงคืนของวันนี้ (tz local)
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const sessions = await coll
    .find({
      admin_id: adminId,
      started_at: { $gte: startOfDay },
    })
    .sort({ started_at: 1 })
    .toArray();

  let accepting_ms = 0;
  let paused_ms = 0;
  let accepting_sessions = 0;
  let paused_sessions = 0;

  for (const s of sessions) {
    const end = s.ended_at ?? now;
    const start = s.started_at < startOfDay ? startOfDay : s.started_at;
    const dur = Math.max(0, end.getTime() - start.getTime());
    if (s.state === "accepting") {
      accepting_ms += dur;
      accepting_sessions += 1;
    } else {
      paused_ms += dur;
      paused_sessions += 1;
    }
  }
  return { accepting_ms, paused_ms, accepting_sessions, paused_sessions };
}

/**
 * Stats ของหลาย admin วันนี้ — ใช้ใน Team page
 */
export async function getTodayStatsBatch(
  adminIds: string[],
  now: Date = new Date()
): Promise<Record<string, {
  accepting_ms: number;
  paused_ms: number;
  accepting_sessions: number;
  paused_sessions: number;
}>> {
  const result: Record<string, {
    accepting_ms: number;
    paused_ms: number;
    accepting_sessions: number;
    paused_sessions: number;
  }> = {};
  // batch fetch
  const coll = await getCollection<ChatAcceptSessionDoc>(COLLECTIONS.chatAcceptSessions);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const sessions = await coll
    .find({
      admin_id: { $in: adminIds },
      started_at: { $gte: startOfDay },
    })
    .sort({ started_at: 1 })
    .toArray();

  for (const id of adminIds) {
    result[id] = { accepting_ms: 0, paused_ms: 0, accepting_sessions: 0, paused_sessions: 0 };
  }
  for (const s of sessions) {
    const stat = result[s.admin_id];
    if (!stat) continue;
    const end = s.ended_at ?? now;
    const start = s.started_at < startOfDay ? startOfDay : s.started_at;
    const dur = Math.max(0, end.getTime() - start.getTime());
    if (s.state === "accepting") {
      stat.accepting_ms += dur;
      stat.accepting_sessions += 1;
    } else {
      stat.paused_ms += dur;
      stat.paused_sessions += 1;
    }
  }
  return result;
}

export const chatAcceptService = {
  startSession,
  closeOpenSession,
  getCurrentState,
  getCurrentStates,
  getTodayStats,
  getTodayStatsBatch,
};
