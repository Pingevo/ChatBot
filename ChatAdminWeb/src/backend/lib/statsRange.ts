/**
 * statsRange — canonical time-window contract เดียวของ analytics pages (R5).
 * semantics ตรงกับ UnifiedDateRangePicker label:
 *   daily="วันนี้" 00:00→now · weekly="7 วันล่าสุด" · monthly=ต้นเดือน→now
 *   yearly=ต้นปี→now · all=null bounds · custom=local-midnight parse "YYYY-MM-DD"
 * ทุก parse เป็น local timezone ของ server (ไม่ใช่ UTC midnight)
 */
export type StatsRange = { start: Date | null; end: Date | null };

export function getStatsBounds(range: string): StatsRange {
  const now = new Date();
  if (range === "all") return { start: null, end: null };
  if (range === "monthly") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  }
  if (range === "yearly") {
    return { start: new Date(now.getFullYear(), 0, 1), end: now };
  }
  if (range === "weekly") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return { start, end: now };
  }
  // daily (default) — วันนี้ 00:00 → ตอนนี้
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return { start, end: now };
}

export function parseStatsRange(
  range: string,
  customStart: string | null,
  customEnd: string | null,
): StatsRange {
  if (customStart) {
    const [sy, sm, sd] = customStart.split("-").map(Number);
    const [ey, em, ed] = customEnd
      ? customEnd.split("-").map(Number)
      : [sy, sm, sd];
    return {
      start: new Date(sy, sm - 1, sd, 0, 0, 0, 0),
      end: new Date(ey, em - 1, ed, 23, 59, 59, 999),
    };
  }
  return getStatsBounds(range);
}

// ── chart series contract ──
// slots/keyOf derive จาก bounds จริง (ไม่ใช่ชื่อ range) — แก้ bug custom range
// หลุดไป bucket ผิด + daily 1 วัน / weekly 7 วัน / custom N วัน อัตโนมัติ
export type StatsGrain = "day" | "month" | "year";
export interface StatsSlot { key: string; label: string }
export interface StatsSeries {
  grain: StatsGrain;
  slots: StatsSlot[]; // all → [] (route เติมจาก data years)
  keyOf: (d: Date) => string; // bucket key เดียวกับ slot.key
}

export function statsSeries(range: string, start: Date | null, end: Date | null): StatsSeries {
  if (!start || !end) {
    return { grain: "year", slots: [], keyOf: (d) => `${d.getFullYear()}` };
  }
  // monthly/yearly = full-period slots (เดือนเต็ม/ปีเต็ม — วัน/เดือนอนาคต = 0)
  if (range === "monthly") {
    const dim = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const slots: StatsSlot[] = [];
    for (let i = 1; i <= dim; i++) {
      slots.push({ key: `${start.getFullYear()}-${start.getMonth() + 1}-${i}`, label: String(i) });
    }
    return {
      grain: "day", slots,
      keyOf: (x) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`,
    };
  }
  if (range === "yearly") {
    const slots: StatsSlot[] = [];
    for (let i = 0; i < 12; i++) {
      const m = new Date(start.getFullYear(), i, 1);
      slots.push({ key: `${m.getFullYear()}-${i + 1}`, label: m.toLocaleDateString("th-TH", { month: "short" }) });
    }
    return {
      grain: "month", slots,
      keyOf: (x) => `${x.getFullYear()}-${x.getMonth() + 1}`,
    };
  }
  const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
  if (spanDays <= 62) {
    const slots: StatsSlot[] = [];
    const small = spanDays <= 8;
    const d = new Date(start); d.setHours(0, 0, 0, 0);
    const last = new Date(end); last.setHours(0, 0, 0, 0);
    while (d <= last) {
      const label = small
        ? d.toLocaleDateString("th-TH", { weekday: "short", day: "numeric" })
        : d.toLocaleDateString("th-TH", { day: "numeric", month: "short" });
      slots.push({ key: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, label });
      d.setDate(d.getDate() + 1);
    }
    return {
      grain: "day", slots,
      keyOf: (x) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`,
    };
  }
  // month grain (>62 วัน หรือ yearly)
  const slots: StatsSlot[] = [];
  const sameYear = start.getFullYear() === end.getFullYear();
  const m = new Date(start.getFullYear(), start.getMonth(), 1);
  const lastM = new Date(end.getFullYear(), end.getMonth(), 1);
  while (m <= lastM) {
    slots.push({
      key: `${m.getFullYear()}-${m.getMonth() + 1}`,
      label: m.toLocaleDateString("th-TH", sameYear ? { month: "short" } : { month: "short", year: "2-digit" }),
    });
    m.setMonth(m.getMonth() + 1);
  }
  return {
    grain: "month", slots,
    keyOf: (x) => `${x.getFullYear()}-${x.getMonth() + 1}`,
  };
}

// ── Mongo $group helpers — Bangkok timezone (contract เดียวกับ dashboard) ──
export function statsBucketId(field: string, grain: StatsGrain): Record<string, unknown> {
  const tz = "Asia/Bangkok";
  if (grain === "day") return {
    y: { $year: { date: field, timezone: tz } },
    m: { $month: { date: field, timezone: tz } },
    d: { $dayOfMonth: { date: field, timezone: tz } },
  };
  if (grain === "month") return {
    y: { $year: { date: field, timezone: tz } },
    m: { $month: { date: field, timezone: tz } },
  };
  return { y: { $year: { date: field, timezone: tz } } };
}

export function statsAggKey(id: { y?: number; m?: number; d?: number }, grain: StatsGrain): string {
  if (grain === "day") return `${id.y}-${id.m}-${id.d}`;
  if (grain === "month") return `${id.y}-${id.m}`;
  return `${id.y}`;
}

// ── display labels ──
function fmtDay(d: Date): string {
  return d.toLocaleDateString("th-TH", { day: "2-digit", month: "short" });
}

export function statsRangeLabel(
  range: string, start: Date | null, end: Date | null, slotCount: number,
): string {
  if (!start || !end) return "ทั้งหมด";
  if (range === "monthly") {
    return start.toLocaleDateString("th-TH", { month: "long", year: "numeric" });
  }
  if (range === "yearly") return `${start.getFullYear() + 543}`;
  if (slotCount <= 1) return `${fmtDay(start)}, ${start.getFullYear() + 543}`;
  return `${fmtDay(start)} - ${fmtDay(end)}, ${end.getFullYear() + 543}`;
}

export function statsCompareLabel(range: string): string {
  switch (range) {
    case "daily": return "เมื่อวาน";
    case "weekly": return "7 วันที่แล้ว";
    case "monthly": return "เดือนที่แล้ว";
    case "yearly": return "ปีที่แล้ว";
    case "all": return "ทั้งหมด";
    default: return "ช่วงก่อนหน้า";
  }
}
