// responseStats.ts — response metrics บน "customer turn" (event population เดียวกัน)
//
// measurement unit = customer turn (run ของ user msgs ต่อเนื่อง)
//   - turn_ts = user msg สุดท้ายของ run; turn เข้า period เมื่อ turn_ts ∈ [start,end)
//   - fetch เฉพาะ [start,end); open turn resolve ผ่าน probe bounded
//     [end, end+GRACE) — report freeze หลัง grace (post-grace events ไม่ถูกอ่าน)
//   - reply ปิด turn ได้ครั้งเดียว (first qualifying response); user msg ต่อ run ได้
//   → numerator/denominator มาจาก population เดียวกันเสมอ (rate ≤100 โดย contract)
import type { Collection, Document } from "mongodb";

// ⚡ domain policy (user-approved Option B): post-end events ใน [end, end+24h)
//   เท่านั้นที่ resolve open turn — หลัง grace period report freeze
//   owner เดียว = ไฟล์นี้ (ไม่ใช่ env/config/flag)
export const RESPONSE_ATTRIBUTION_GRACE_MS = 24 * 60 * 60 * 1000;
// ⚡ probe batch bound — index-served {conversation_id,created_timestamp} per element;
//   500 ids/batch ~ lookup ขนาดหน้าเดียวของ list route, ไม่ใช่ N+1 (1 query pair/batch)
export const RESPONSE_PROBE_BATCH_SIZE = 500;

interface MsgRow {
  conversation_id: string;
  role: string;
  created_timestamp: Date;
  actor?: string;
}

export interface ResponseStats {
  /** เฉลี่ยวินาทีของ first response ต่อ turn (เฉพาะ turn ที่ตอบแล้ว) */
  avgResponseSeconds: number;
  /** eligible customer turns ใน period (turn_ts ∈ [start,end), รวมที่ยังไม่ตอบ) */
  totalTurns: number;
  /** turns ที่มี qualifying response แล้ว (แม้ reply จะหลัง end) */
  answeredTurns: number;
  /** answeredTurns ที่ first response ≤10 นาที */
  within10minTurns: number;
  /** per-admin breakdown ตาม first-reply actor (historical responder) */
  perAdmin: Map<string, { avgSeconds: number; within10min: number; total: number }>;
}

/**
 * @param msgColl   messages collection
 * @param start     ต้น period (optional) — fetch bound: อ่านเฉพาะ msgs ≥ start
 * @param end       ปลาย period (optional) — attribution + probe bound
 *                  (turn ที่ turn_ts < end นับใน period นี้; open turn resolve ได้เฉพาะ
 *                  events ใน [end, end+24h) — หลังนั้น freeze unanswered)
 * @param adminOnly ถ้า true ให้เฉพาะ role=admin เป็น qualifying response
 *                  (สำหรับ endpoint ที่ติด label "ตอบกลับของแอดมิน")
 */
export async function computeResponseStats(
  msgColl: Collection<Document>,
  opts: { start?: Date | null; end?: Date | null; adminOnly?: boolean }
): Promise<ResponseStats> {
  const { start, end, adminOnly = false } = opts;

  // bounded fetch — อ่านเฉพาะ [start,end); turn ที่ค้างถึง end resolve ด้วย
  // batched probe [end, graceEnd) ไม่ใช่อ่านทุก msg ถึงปัจจุบัน
  const range: Record<string, Date> = {};
  if (start) range.$gte = start;
  if (end) range.$lt = end;
  const tsFilter = Object.keys(range).length ? { created_timestamp: range } : {};
  const replyRole = adminOnly ? "admin" : { $in: ["bot", "admin"] };
  const proj = { conversation_id: 1, created_timestamp: 1, actor: 1, _id: 0 };

  const [userDocs, replyDocs] = await Promise.all([
    msgColl.find({ role: "user", ...tsFilter }).project(proj).toArray(),
    msgColl.find({ role: replyRole, ...tsFilter }).project(proj).toArray(),
  ]);
  const userMsgs = userDocs as unknown as MsgRow[];
  const replyMsgs = replyDocs as unknown as MsgRow[];

  type Ev = { ts: number; isUser: boolean; actor?: string };
  const eventsByConv = new Map<string, Ev[]>();
  const push = (convId: string, ev: Ev) => {
    const arr = eventsByConv.get(convId);
    if (arr) arr.push(ev);
    else eventsByConv.set(convId, [ev]);
  };
  for (const u of userMsgs) push(u.conversation_id, { ts: u.created_timestamp.getTime(), isUser: true });
  for (const r of replyMsgs) push(r.conversation_id, { ts: r.created_timestamp.getTime(), isUser: false, actor: r.actor });

  let totalDiff = 0;
  let totalTurns = 0;
  let answeredTurns = 0;
  let within10minTurns = 0;
  const perAdmin = new Map<string, { sum: number; count: number; within10min: number }>();
  const openRuns: { conv: string; turnTs: number }[] = [];

  const closeTurn = (replyTs: number, turnTs: number, actor?: string) => {
    totalTurns++;
    answeredTurns++;
    const diffSec = (replyTs - turnTs) / 1000;
    totalDiff += diffSec;
    if (diffSec <= 600) within10minTurns++;
    if (actor) {
      const a = perAdmin.get(actor) || { sum: 0, count: 0, within10min: 0 };
      a.sum += diffSec;
      a.count++;
      if (diffSec <= 600) a.within10min++;
      perAdmin.set(actor, a);
    }
  };

  for (const [conv, events] of eventsByConv) {
    // tie-break: user ก่อน reply ที่ ts เดียวกัน (turn ยังไม่ปิดจนกว่า user run จบ)
    events.sort((a, b) => a.ts - b.ts || (a.isUser === b.isUser ? 0 : a.isUser ? -1 : 1));
    let turnTs = -1;
    for (const ev of events) {
      if (ev.isUser) {
        turnTs = ev.ts; // user msg ต่อเนื่อง = extend run เดิม (turn_ts = user ล่าสุด)
        continue;
      }
      if (turnTs < 0) continue; // reply ก่อน user msg แรกที่เห็น — turn ของ period ก่อนหน้า
      const ts = turnTs;
      turnTs = -1; // first qualifying reply ปิด turn — reply ถัดไปไม่ถูกนับ
      closeTurn(ev.ts, ts, ev.actor);
    }
    // run ค้างถึง end → หนึ่ง turn; resolve ผลด้วย post-end probe (≤ open convs)
    if (turnTs >= 0) {
      if (end) openRuns.push({ conv, turnTs });
      else totalTurns++;
    }
  }

  // open-run resolution — first post-end event ต่อ conv ภายใน grace [end, end+24h):
  //   user ก่อน/เท่ากัน reply → run ต่อ → turn ย้าย period ถัดไป (ไม่นับ period นี้)
  //   reply ก่อน/ไม่มี user → ปิด turn นี้ด้วย reply นั้น; ไม่มี event → ค้าง unanswered
  //   events ≥ graceEnd ไม่ถูก fetch เลย → historical period freeze หลัง grace
  if (end && openRuns.length > 0) {
    const graceEnd = new Date(end.getTime() + RESPONSE_ATTRIBUTION_GRACE_MS);
    for (let i = 0; i < openRuns.length; i += RESPONSE_PROBE_BATCH_SIZE) {
      const batch = openRuns.slice(i, i + RESPONSE_PROBE_BATCH_SIZE);
      const probeBase = {
        conversation_id: { $in: batch.map((o) => o.conv) },
        created_timestamp: { $gte: end, $lt: graceEnd },
      };
      const [firstUsers, firstReplies] = await Promise.all([
        msgColl.aggregate<{ _id: string; ts: Date }>([
          { $match: { ...probeBase, role: "user" } },
          { $group: { _id: "$conversation_id", ts: { $min: "$created_timestamp" } } },
        ]).toArray(),
        msgColl.aggregate<{ _id: string; ts: Date; actor?: string }>([
          { $match: { ...probeBase, role: replyRole } },
          { $sort: { created_timestamp: 1 } },
          { $group: { _id: "$conversation_id", ts: { $first: "$created_timestamp" }, actor: { $first: "$actor" } } },
        ]).toArray(),
      ]);
      const userById = new Map(firstUsers.map((r) => [r._id, r.ts.getTime()]));
      const replyById = new Map(firstReplies.map((r) => [r._id, r]));
      for (const o of batch) {
        const uT = userById.get(o.conv);
        const r = replyById.get(o.conv);
        if (uT !== undefined && (!r || uT <= r.ts.getTime())) continue; // user ก่อน/เท่ากัน → run ต่อ → ย้าย period
        if (r) closeTurn(r.ts.getTime(), o.turnTs, r.actor);
        else totalTurns++;
      }
    }
  }

  const perAdminResult = new Map<string, { avgSeconds: number; within10min: number; total: number }>();
  for (const [adminId, a] of perAdmin) {
    perAdminResult.set(adminId, {
      avgSeconds: a.count > 0 ? a.sum / a.count : 0,
      within10min: a.within10min,
      total: a.count,
    });
  }

  return {
    avgResponseSeconds: answeredTurns > 0 ? totalDiff / answeredTurns : 0,
    totalTurns,
    answeredTurns,
    within10minTurns,
    perAdmin: perAdminResult,
  };
}
