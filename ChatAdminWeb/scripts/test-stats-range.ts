// test-stats-range.ts — contract tests: canonical stats range/series (R5)
//
// รัน: npx tsx scripts/test-stats-range.ts
//
// Contract ที่ assert:
//   daily   = วันนี้ 00:00 local → now  (ตาม label picker "วันนี้")
//   weekly  = 7 วันล่าสุด (00:00 local −6 วัน → now)
//   monthly = วันที่ 1 เดือนนี้ → now
//   yearly  = 1 ม.ค. ปีนี้ → now
//   all     = null bounds
//   custom  = "YYYY-MM-DD" parse เป็น local midnight (ไม่ใช่ UTC)
//             end default = start day 23:59:59.999
//   series  : grain/slots derive จาก bounds ไม่ใช่ชื่อ range
//             ≤8 วัน→day slots, ≤62→day, >62→month, all→year (slots จาก data)
//   keyOf   : ผลิต key เดียวกับ slot ที่วันนั้นตกอยู่

import {
  parseStatsRange,
  getStatsBounds,
  statsSeries,
} from "../src/backend/lib/statsRange";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
function isoLocal(d: Date | null): string {
  if (!d) return "null";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const now = new Date();

// ── bounds ──
{
  const { start, end } = getStatsBounds("daily");
  const expect = new Date(now); expect.setHours(0, 0, 0, 0);
  ok(start?.getTime() === expect.getTime(), "daily start=today 00:00", isoLocal(start));
  ok(end !== null && Math.abs(end.getTime() - now.getTime()) < 5000, "daily end=now");
}
{
  const { start } = getStatsBounds("weekly");
  const expect = new Date(now); expect.setHours(0, 0, 0, 0); expect.setDate(expect.getDate() - 6);
  ok(start?.getTime() === expect.getTime(), "weekly start=−6d 00:00", isoLocal(start));
}
{
  const { start } = getStatsBounds("monthly");
  ok(start?.getDate() === 1 && start.getHours() === 0, "monthly start=day1", isoLocal(start));
}
{
  const { start } = getStatsBounds("yearly");
  ok(start?.getMonth() === 0 && start.getDate() === 1, "yearly start=Jan1", isoLocal(start));
}
{
  const { start, end } = getStatsBounds("all");
  ok(start === null && end === null, "all=null bounds");
}
{
  // custom — ต้องเป็น local midnight ไม่ใช่ UTC (server tz +07 → UTC parse จะหลุดวัน)
  const { start, end } = parseStatsRange("daily", "2026-10-05", "2026-10-08");
  ok(isoLocal(start) === "2026-10-05 00:00:00", "custom start local", isoLocal(start));
  ok(isoLocal(end) === "2026-10-08 23:59:59", "custom end local", isoLocal(end));
}
{
  const { start, end } = parseStatsRange("daily", "2026-10-05", null);
  ok(isoLocal(start) === "2026-10-05 00:00:00" && isoLocal(end) === "2026-10-05 23:59:59",
    "custom single day", `${isoLocal(start)} → ${isoLocal(end)}`);
}
{
  // unknown range → default daily semantics
  const { start } = getStatsBounds("bogus");
  const expect = new Date(now); expect.setHours(0, 0, 0, 0);
  ok(start?.getTime() === expect.getTime(), "unknown→daily");
}

// ── series (slots derive จาก bounds) ──
{
  const { start, end } = getStatsBounds("daily");
  const s = statsSeries("daily", start, end);
  ok(s.grain === "day" && s.slots.length === 1, "daily→1 day slot", `${s.slots.length}`);
  ok(s.keyOf(now) === s.slots[0].key, "daily keyOf=slot", `${s.keyOf(now)} vs ${s.slots[0].key}`);
}
{
  const { start, end } = getStatsBounds("weekly");
  const s = statsSeries("weekly", start, end);
  ok(s.grain === "day" && s.slots.length === 7, "weekly→7 day slots", `${s.slots.length}`);
  // slot สุดท้าย = วันนี้
  ok(s.keyOf(now) === s.slots[s.slots.length - 1].key, "weekly last slot=today");
}
{
  const { start, end } = getStatsBounds("monthly");
  const s = statsSeries("monthly", start, end);
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  ok(s.grain === "day" && s.slots.length === dim, "monthly→day slots=daysInMonth",
    `${s.slots.length} vs ${dim}`);
}
{
  const { start, end } = getStatsBounds("yearly");
  const s = statsSeries("yearly", start, end);
  ok(s.grain === "month" && s.slots.length === 12, "yearly→12 month slots", `${s.slots.length}`);
}
{
  const s = statsSeries("all", null, null);
  ok(s.grain === "year" && s.slots.length === 0, "all→year grain, data-driven slots");
}
{
  const { start, end } = parseStatsRange("daily", "2026-10-05", "2026-10-09");
  const s = statsSeries("daily", start, end);
  ok(s.grain === "day" && s.slots.length === 5, "custom 5d→5 slots", `${s.slots.length}`);
  ok(s.slots[0].key === "2026-10-5", "custom slot0 key", s.slots[0].key);
  ok(s.keyOf(new Date(2026, 9, 7, 15, 30)) === "2026-10-7", "keyOf mid day");
}
{
  // custom > 62 วัน → month grain
  const { start, end } = parseStatsRange("daily", "2026-01-01", "2026-04-30");
  const s = statsSeries("daily", start, end);
  ok(s.grain === "month" && s.slots.length === 4, "custom 120d→4 month slots", `${s.slots.length}`);
  ok(s.slots[0].key === "2026-1" && s.slots[3].key === "2026-4",
    "month slot keys", `${s.slots[0].key}..${s.slots[3].key}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
