// responseStats.ts — คำนวณ response time stats แบบ in-memory แทน $lookup self-join
// ที่ช้ามาก (O(N²)) บน messages collection 4400+ docs
//
// วิธี: fetch user + admin/bot messages ในช่วงเวลาที่สนใจมาทั้งหมด
//       sort ตาม conversation_id + created_timestamp
//       แล้ว walk through หา "previous user message" สำหรับแต่ละ reply ใน JS
//       (O(N log N) สำหรับ sort + O(N) สำหรับ walk)
import type { Collection, Document } from "mongodb";

interface MsgRow {
  conversation_id: string;
  role: string;
  created_timestamp: Date;
  actor?: string;
}

export interface ResponseStats {
  avgResponseSeconds: number;
  replyWithin10min: number;
  /** per-admin breakdown (ถ้ามี actor field) */
  perAdmin: Map<string, { avgSeconds: number; within10min: number; total: number }>;
}

/**
 * คำนวณ avg response time + จำนวน reply ภายใน 10 นาที
 * โดยไม่ใช้ $lookup (ซึ่งช้ามาก)
 *
 * @param msgColl   messages collection
 * @param start     วันที่เริ่มต้น (optional)
 * @param end       วันที่สิ้นสุด (optional)
 * @param adminOnly ถ้า true กรองเฉพาะ role=admin (สำหรับ admin-activity)
 */
export async function computeResponseStats(
  msgColl: Collection<Document>,
  opts: { start?: Date | null; end?: Date | null; adminOnly?: boolean }
): Promise<ResponseStats> {
  const { start, end, adminOnly = false } = opts;

  const tsFilter: Record<string, unknown> = {};
  if (start) tsFilter.$gte = start;
  if (end) tsFilter.$lt = end;

  const replyRole = adminOnly ? "admin" : { $in: ["bot", "admin"] };

  // fetch user + reply messages ในช่วงเวลาที่สนใจ — ใช้ 2 queries แทน $lookup
  const [userDocs, replyDocs] = await Promise.all([
    msgColl
      .find({ role: "user", ...(Object.keys(tsFilter).length ? { created_timestamp: tsFilter } : {}) })
      .project({ conversation_id: 1, role: 1, created_timestamp: 1, _id: 0 })
      .toArray(),
    msgColl
      .find({ role: replyRole, ...(Object.keys(tsFilter).length ? { created_timestamp: tsFilter } : {}) })
      .project({ conversation_id: 1, role: 1, created_timestamp: 1, actor: 1, _id: 0 })
      .toArray(),
  ]);

  const userMsgs = userDocs as unknown as MsgRow[];
  const replyMsgs = replyDocs as unknown as MsgRow[];

  // group user messages by conversation_id
  const userByConv = new Map<string, Date[]>();
  for (const u of userMsgs) {
    const arr = userByConv.get(u.conversation_id);
    if (arr) arr.push(u.created_timestamp);
    else userByConv.set(u.conversation_id, [u.created_timestamp]);
  }
  // sort each conversation's user messages ascending
  for (const arr of userByConv.values()) arr.sort((a, b) => a.getTime() - b.getTime());

  // walk through replies — binary search for the latest user msg before this reply
  let totalDiff = 0;
  let count = 0;
  let within10min = 0;
  const perAdmin = new Map<string, { sum: number; count: number; within10min: number }>();

  for (const r of replyMsgs) {
    const userTimes = userByConv.get(r.conversation_id);
    if (!userTimes || userTimes.length === 0) continue;

    // binary search: หา user message ล่าสุดที่ timestamp < reply timestamp
    const replyTs = r.created_timestamp.getTime();
    let lo = 0;
    let hi = userTimes.length - 1;
    let found: Date | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (userTimes[mid].getTime() < replyTs) {
        found = userTimes[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (!found) continue;

    const diffSec = (replyTs - found.getTime()) / 1000;
    totalDiff += diffSec;
    count++;
    if (diffSec <= 600) within10min++;

    // per-admin breakdown
    if (r.actor) {
      const a = perAdmin.get(r.actor) || { sum: 0, count: 0, within10min: 0 };
      a.sum += diffSec;
      a.count++;
      if (diffSec <= 600) a.within10min++;
      perAdmin.set(r.actor, a);
    }
  }

  const avgResponseSeconds = count > 0 ? totalDiff / count : 0;

  const perAdminResult = new Map<string, { avgSeconds: number; within10min: number; total: number }>();
  for (const [adminId, a] of perAdmin) {
    perAdminResult.set(adminId, {
      avgSeconds: a.count > 0 ? a.sum / a.count : 0,
      within10min: a.within10min,
      total: a.count,
    });
  }

  return { avgResponseSeconds, replyWithin10min: within10min, perAdmin: perAdminResult };
}
