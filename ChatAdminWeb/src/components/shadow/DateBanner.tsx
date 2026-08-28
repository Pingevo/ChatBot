// DateBanner — แสดงวันที่คั่นแชท แบบ LINE
// "วันนี้" / "เมื่อวาน" / "2 ม.ค. 2568" / "15 มี.ค. 2567"
"use client";

const TH_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * ส่งคืน label สั้นสำหรับวันที่
 * - วันนี้ → "วันนี้"
 * - เมื่อวาน → "เมื่อวาน"
 * - อื่นๆ → "15 มี.ค. 2568"
 */
export function formatDateLabel(ts: string | Date, now: Date = new Date()): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  const today = startOfDay(now);
  const target = startOfDay(d);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return "วันนี้";
  if (diffDays === 1) return "เมื่อวาน";
  const buddhistYear = d.getFullYear() + 543;
  return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${buddhistYear}`;
}

/**
 * ส่งคืนเวลาเต็ม พร้อมวัน — "15 มี.ค. 2568 · 14:30"
 */
export function formatDateTimeLabel(ts: string | Date): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  const dateLabel = formatDateLabel(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${dateLabel} · ${hh}:${mm}`;
}

/**
 * ส่งคืน key ของวัน (YYYY-MM-DD) — ใช้ group messages ตามวัน
 */
export function dayKey(ts: string | Date): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return startOfDay(d).toISOString().slice(0, 10);
}

interface DateBannerProps {
  timestamp: string | Date;
  /** compact = ขนาดเล็ก */
  compact?: boolean;
}

export function DateBanner({ timestamp, compact = false }: DateBannerProps) {
  const label = formatDateLabel(timestamp);
  const sizeCls = compact ? "text-[9px] py-0.5 px-2" : "text-[10px] py-1 px-2.5";
  return (
    <div className="flex items-center justify-center my-2 sticky top-0 z-10">
      <span className={`${sizeCls} bg-surface-2/90 backdrop-blur-sm text-text-muted rounded-full border border-border/60 shadow-sm font-medium`}>
        {label}
      </span>
    </div>
  );
}
