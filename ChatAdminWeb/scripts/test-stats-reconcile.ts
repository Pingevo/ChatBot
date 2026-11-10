// test-stats-reconcile.ts — R5 numeric reconcile: analytics bucketed numbers vs Mongo source truth
// read-only — countDocuments/aggregate เท่านั้น ไม่เขียน
//
// invariant ที่พิสูจน์ต่อเคส:
//   naive countDocuments(bounds) == Mongo-side $group bucket sum == JS-side keyOf sum
//   และทุก doc ใน range ลง slot ของ series ครบ (lost=0)
// ครอบ field จริงที่ routes ใช้: conversations.created_at / messages.created_timestamp /
//   conversations.last_message_timestamp (dashboard convPerDay)
// รัน: npx tsx scripts/test-stats-reconcile.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { getCollection, COLLECTIONS } from "../src/backend/db/mongoClient";
import {
  parseStatsRange, statsSeries, statsBucketId, statsAggKey,
} from "../src/backend/lib/statsRange";

type Case = { name: string; coll: string; field: string; range: string; start?: string; end?: string };

const CASES: Case[] = [
  // performance route: conv.created_at + msg.created_at ทุก grain
  { name: "conv.created_at daily",    coll: COLLECTIONS.conversations, field: "created_at", range: "daily" },
  { name: "conv.created_at weekly",   coll: COLLECTIONS.conversations, field: "created_at", range: "weekly" },
  { name: "conv.created_at monthly",  coll: COLLECTIONS.conversations, field: "created_at", range: "monthly" },
  { name: "conv.created_at yearly",   coll: COLLECTIONS.conversations, field: "created_at", range: "yearly" },
  { name: "conv.created_at all",      coll: COLLECTIONS.conversations, field: "created_at", range: "all" },
  { name: "conv.created_at custom",   coll: COLLECTIONS.conversations, field: "created_at", range: "custom", start: "2026-11-01", end: "2026-11-07" },
  // dashboard convPerDay equivalent: last_message_timestamp day grain
  { name: "conv.last_msg_ts weekly",  coll: COLLECTIONS.conversations, field: "last_message_timestamp", range: "weekly" },
  { name: "conv.last_msg_ts daily",   coll: COLLECTIONS.conversations, field: "last_message_timestamp", range: "daily" },
  // messages: weekly+monthly bounds (doc จำนวนมาก — เฉพาะช่วง bounded)
  { name: "msg.created_ts weekly",    coll: COLLECTIONS.messages, field: "created_timestamp", range: "weekly" },
  { name: "msg.created_ts monthly",   coll: COLLECTIONS.messages, field: "created_timestamp", range: "monthly" },
];

async function main() {
  let pass = 0;
  for (const c of CASES) {
    const { start, end } = parseStatsRange(c.range, c.start, c.end);
    const series = statsSeries(c.range, start, end);
    const coll = await getCollection(c.coll);

    const bounds: Record<string, unknown> = {};
    if (start) bounds.$gte = start;
    if (end) bounds.$lt = end;
    const naive = await coll.countDocuments(Object.keys(bounds).length ? { [c.field]: bounds } : {});

    // Mongo-side bucket (path ของ performance/dashboard aggregation)
    const bucketId = statsBucketId(`$${c.field}`, series.grain);
    const agg = await coll.aggregate<{ _id: Record<string, number>; n: number }>([
      { $match: Object.keys(bounds).length ? { [c.field]: bounds } : {} },
      { $group: { _id: bucketId, n: { $sum: 1 } } },
    ]).toArray();
    let mongoSum = 0, mongoLost = 0;
    const slotKeys = new Set(series.slots.map((s) => s.key));
    const isAll = c.range === "all"; // all → slots derive จาก data เอง ไม่มี fixed key
    for (const d of agg) {
      mongoSum += d.n;
      const key = statsAggKey(d._id, series.grain);
      if (!isAll && slotKeys.size && !slotKeys.has(key)) mongoLost += d.n;
    }

    // JS-side bucket (path ของ admin-activity) — project เฉพาะ field + keyOf
    let jsSum = 0, jsLost = 0;
    const jsMap = new Map<string, number>();
    const cursor = coll.find(
      Object.keys(bounds).length ? { [c.field]: bounds } : {},
      { projection: { [c.field]: 1, _id: 0 } },
    );
    for await (const doc of cursor) {
      const v = (doc as Record<string, unknown>)[c.field];
      if (!(v instanceof Date)) continue; // doc ขาด field → ไม่เข้า naive เช่นกัน ($match กรองออกเหมือนกัน)
      jsSum++;
      const key = series.keyOf(v);
      if (isAll) { jsMap.set(key, (jsMap.get(key) || 0) + 1); continue; }
      if (slotKeys.size && !slotKeys.has(key)) jsLost++;
      else jsMap.set(key, (jsMap.get(key) || 0) + 1);
    }

    assert(mongoSum === naive, `${c.name}: mongoSum ${mongoSum} != naive ${naive}`);
    assert(jsSum === naive, `${c.name}: jsSum ${jsSum} != naive ${naive} (missing/non-date fields diverge)`);
    assert(mongoLost === 0, `${c.name}: ${mongoLost} docs ลงนอก slot (Mongo-side)`);
    assert(jsLost === 0, `${c.name}: ${jsLost} docs ลงนอก slot (JS-side)`);
    console.log(`PASS ${c.name} — naive=${naive} mongo=${mongoSum} js=${jsSum} grain=${series.grain} slots=${series.slots.length || "data-years"}`);
    pass++;
  }
  console.log(`\n${pass}/${CASES.length} reconcile cases passed`);
  process.exit(0);
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
