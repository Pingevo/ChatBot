"use client";

// LeaveCalendar — ปฏิทินวันลาของทีม (view-only)
// 2 มุมมอง: roster (คน×วัน ทั้งแผนก) และ month calendar (chip ชื่อคนที่ลาในแต่ละวัน)
// รองรับลาเต็มวันและลาบางช่วงเวลา (startTime/endTime) — คนลา = ปิดรับงาน handoff เฉพาะช่วงนั้น
// ตอนนี้ใช้ mock leave records — เปลี่ยนเป็น fetch จากระบบกลางงานภายหลัง
import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, LayoutGrid, Rows3, Clock, CircleSlash } from "lucide-react";
import { Card } from "@/components/ui/Card";

export type LeaveType = "sick" | "personal" | "vacation" | "holiday";

export interface LeaveRecord {
  adminId: string;
  startDate: string; // ISO yyyy-mm-dd (inclusive)
  endDate: string;
  type: LeaveType;
  /** ลาบางช่วงเวลา — ถ้าไม่ใส่ = ลาเต็มวัน */
  startTime?: string; // "HH:mm"
  endTime?: string;   // "HH:mm"
  note?: string;
}

export interface LeaveCalendarAgent {
  admin_id: string;
  name: string;
}

/** สถานะรับงานของ admin ณ เวลาหนึ่ง — off=ลาเต็มวัน, partial=อยู่ในช่วงลา (หรือมีลาบางช่วงวันนี้), working=รับงานได้ */
export type LeaveStatusNow =
  | { status: "off"; record: LeaveRecord }
  | { status: "partial"; record: LeaveRecord; window: string }
  | { status: "working"; record?: LeaveRecord };

export function leaveStatusNow(leaves: LeaveRecord[], adminId: string, now: Date): LeaveStatusNow {
  const key = dateKey(now.getFullYear(), now.getMonth(), now.getDate());
  const rec = leaves.find((l) => l.adminId === adminId && key >= l.startDate && key <= l.endDate);
  if (!rec) return { status: "working" };
  if (!rec.startTime || !rec.endTime) return { status: "off", record: rec };
  const cur = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const inWindow = cur >= rec.startTime && cur < rec.endTime;
  return inWindow
    ? { status: "partial", record: rec, window: `${rec.startTime}–${rec.endTime}` }
    : { status: "working", record: rec };
}

// เวลาทำการร้าน — ตรงกับ business_hours ที่ workflow จะใช้; วันทำงานจริงจะมาจาก API ระบบกลาง
const BUSINESS_HOURS = "09:30–17:30";
const WORKING_DAYS = [0, 1, 2, 3, 4, 5, 6]; // 0=อาทิตย์ …ทำงานทุกวัน (mock — API จะส่งวันทำงานจริง)

const TYPE_HEX: Record<LeaveType, string> = {
  sick: "#f43f5e",
  personal: "#f59e0b",
  vacation: "#0ea5e9",
  holiday: "#10b981",
};
const LEAVE_META: Record<LeaveType, { label: string; hex: string; chip: string; dot: string }> = {
  sick: { label: "ลาป่วย", hex: TYPE_HEX.sick, chip: "bg-rose-500/10 text-rose-700 ring-rose-500/25", dot: "bg-rose-500" },
  personal: { label: "ลากิจ", hex: TYPE_HEX.personal, chip: "bg-amber-400/10 text-amber-700 ring-amber-500/25", dot: "bg-amber-400" },
  vacation: { label: "พักร้อน", hex: TYPE_HEX.vacation, chip: "bg-sky-500/10 text-sky-700 ring-sky-500/25", dot: "bg-sky-500" },
  holiday: { label: "วันหยุด", hex: TYPE_HEX.holiday, chip: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25", dot: "bg-emerald-500" },
};

const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const THAI_DAYS_SHORT = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function dateKey(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function daysInMonth(y: number, m: number) {
  return new Date(y, m + 1, 0).getDate();
}
function isPartial(l: LeaveRecord) {
  return !!(l.startTime && l.endTime);
}
function leaveOn(leaves: LeaveRecord[], adminId: string, key: string): LeaveRecord | undefined {
  return leaves.find((l) => l.adminId === adminId && key >= l.startDate && key <= l.endDate);
}
function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay()); // เริ่มวันอาทิตย์
  return x;
}

/** สีประจำตัว agent (header chip) — หมุนตาม index */
const AGENT_COLORS = ["#0ea5e9", "#f43f5e", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

/** สร้าง mock leave จากรายชื่อ agent จริง — deterministic ตาม index (เปลี่ยนเป็น API ทีหลัง) */
function buildMockLeaves(agents: LeaveCalendarAgent[], year: number, month: number, todayKeyStr: string): LeaveRecord[] {
  const dim = daysInMonth(year, month);
  const day = (d: number) => dateKey(year, month, Math.min(Math.max(d, 1), dim));
  const out: LeaveRecord[] = [];
  const pick = (i: number) => agents[i % agents.length];
  if (agents.length === 0) return out;
  // เต็มวันหลายวัน
  out.push({ adminId: pick(0).admin_id, startDate: day(4), endDate: day(7), type: "vacation" });
  if (agents.length > 1) out.push({ adminId: pick(1).admin_id, startDate: day(20), endDate: day(21), type: "sick" });
  // บางช่วงเวลา
  if (agents.length > 2) out.push({ adminId: pick(2).admin_id, startDate: day(12), endDate: day(12), type: "personal", startTime: "09:30", endTime: "12:30", note: "ครึ่งเช้า" });
  if (agents.length > 3) out.push({ adminId: pick(3).admin_id, startDate: day(26), endDate: day(26), type: "sick", startTime: "15:00", endTime: "16:00", note: "พบแพทย์ 1 ชม." });
  // วันนี้ (ถ้าอยู่ในเดือนที่ดู) — ตัวอย่างลาบางช่วงวันนี้
  const todayInMonth = todayKeyStr.startsWith(`${year}-${String(month + 1).padStart(2, "0")}`);
  if (todayInMonth && agents.length > 1) {
    out.push({ adminId: pick(1).admin_id, startDate: todayKeyStr, endDate: todayKeyStr, type: "personal", startTime: "09:30", endTime: "11:30", note: "ลา 2 ชม." });
  }
  return out;
}

export function LeaveCalendar({ agents }: { agents: LeaveCalendarAgent[] }) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [mode, setMode] = useState<"roster" | "month">("roster");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(now));
  const todayKey = dateKey(now.getFullYear(), now.getMonth(), now.getDate());

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; }),
    [weekStart],
  );

  // mock leave ต้องครอบทุกเดือนที่แสดง (สัปดาห์อาจข้ามเดือน)
  const monthPairs = useMemo(() => {
    const src = mode === "roster" ? weekDays.map((d) => ({ y: d.getFullYear(), m: d.getMonth() })) : [cursor];
    const seen = new Map<string, { y: number; m: number }>();
    for (const p of src) seen.set(`${p.y}-${p.m}`, p);
    return [...seen.values()];
  }, [mode, weekDays, cursor]);
  const leaves = useMemo(
    () => monthPairs.flatMap(({ y, m }) => buildMockLeaves(agents, y, m, todayKey)),
    [agents, monthPairs, todayKey],
  );

  const dim = daysInMonth(cursor.y, cursor.m);
  const days = Array.from({ length: dim }, (_, i) => i + 1);
  const firstWeekday = new Date(cursor.y, cursor.m, 1).getDay();

  const shift = (n: number) =>
    mode === "roster"
      ? setWeekStart((w) => { const d = new Date(w); d.setDate(d.getDate() + n * 7); return d; })
      : setCursor((c) => { const d = new Date(c.y, c.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const reset = () => (mode === "roster" ? setWeekStart(startOfWeek(now)) : setCursor({ y: now.getFullYear(), m: now.getMonth() }));

  const statuses = useMemo(() => {
    const map = new Map<string, LeaveStatusNow>();
    for (const a of agents) map.set(a.admin_id, leaveStatusNow(leaves, a.admin_id, now));
    return map;
  }, [agents, leaves]);
  const offCount = [...statuses.values()].filter((s) => s.status !== "working").length;

  const fmtDay = (d: Date) => `${d.getDate()} ${THAI_MONTHS[d.getMonth()]}`;
  const periodLabel =
    mode === "roster"
      ? `${fmtDay(weekDays[0])} – ${fmtDay(weekDays[6])} ${weekDays[6].getFullYear() + 543}`
      : `${THAI_MONTHS[cursor.m]} ${cursor.y + 543}`;

  return (
    <Card className="overflow-hidden">
      {/* header */}
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-border">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div>
            <div className="flex items-center gap-2">
              <CalendarDays size={16} className="text-brand" />
              <h2 className="text-base font-bold text-text tracking-tight">{periodLabel}</h2>
            </div>
            <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted">
              <span className="flex items-center gap-1"><Clock size={11} /> ทำการ {BUSINESS_HOURS} · {WORKING_DAYS.length === 7 ? "ทุกวัน" : `${WORKING_DAYS.length} วัน/สัปดาห์`}</span>
              {offCount > 0 && <span className="flex items-center gap-1 text-error font-medium"><CircleSlash size={11} /> วันนี้ลา {offCount} คน</span>}
              <span className="hidden sm:inline text-text-subtle">{leaves.length} รายการลาในช่วงนี้</span>
            </div>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <div className="flex items-center rounded-lg border border-border bg-surface-2/60 p-0.5">
              <button onClick={() => setMode("roster")} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${mode === "roster" ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text"}`}>
                <Rows3 size={12} /> ทั้งแผนก
              </button>
              <button onClick={() => setMode("month")} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${mode === "month" ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text"}`}>
                <LayoutGrid size={12} /> ปฏิทิน
              </button>
            </div>
            <div className="flex items-center rounded-lg border border-border bg-surface">
              <button onClick={() => shift(-1)} className="px-2 py-1.5 text-text-muted hover:text-text transition-colors" aria-label="ช่วงก่อน"><ChevronLeft size={15} /></button>
              <button onClick={reset} className="px-2.5 py-1.5 text-[11px] font-medium text-text-muted hover:text-text border-x border-border transition-colors">{mode === "roster" ? "สัปดาห์นี้" : "เดือนนี้"}</button>
              <button onClick={() => shift(1)} className="px-2 py-1.5 text-text-muted hover:text-text transition-colors" aria-label="ช่วงถัดไป"><ChevronRight size={15} /></button>
            </div>
          </div>
        </div>
        {/* legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2.5 text-[10.5px] text-text-muted">
          {Object.entries(LEAVE_META).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${v.dot}`} />{v.label}</span>
          ))}
          <span className="text-text-subtle">แถบที่มีเวลา = ลาบางช่วง ปิดรับงานเฉพาะช่วงนั้น</span>
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="p-10 text-center text-sm text-text-muted">ยังไม่มี agent</div>
      ) : mode === "roster" ? (
        /* === Week grid: แถว=วัน (7 วัน) × คอลัมน์=คน + หมายเหตุ === */
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs" style={{ minWidth: 90 + agents.length * 140 + 200 }}>
            <thead>
              <tr className="border-b border-border">
                <th className="sticky left-0 z-10 bg-surface w-[64px] min-w-[64px] border-r border-border/60" />
                {agents.map((a, i) => {
                  const st = statuses.get(a.admin_id);
                  const color = AGENT_COLORS[i % AGENT_COLORS.length];
                  return (
                    <th key={a.admin_id} className="px-1.5 py-2 align-top min-w-[128px] font-normal">
                      <div className="rounded-lg px-2.5 py-1.5 text-white text-[11px] font-semibold truncate shadow-sm" style={{ background: color }}>{a.name}</div>
                      {st && st.status !== "working" ? (
                        <div className="mt-1 text-[9px] font-medium text-error text-center leading-tight">
                          {st.status === "off" ? "ลา — ปิดรับงาน" : `ลา ${st.window} นี้`}
                        </div>
                      ) : st?.record ? (
                        <div className="mt-1 text-[9px] text-text-subtle text-center leading-tight">รับงานแล้ว</div>
                      ) : null}
                    </th>
                  );
                })}
                <th className="px-3 py-2 text-left text-[11px] font-medium text-text-muted min-w-[180px]">หมายเหตุ</th>
              </tr>
            </thead>
            <tbody>
              {weekDays.map((d) => {
                const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
                const wd = d.getDay();
                const working = WORKING_DAYS.includes(wd);
                const isToday = key === todayKey;
                const dayLeaves = leaves.filter((l) => key >= l.startDate && key <= l.endDate);
                const notes = [...new Set(dayLeaves.map((l) => l.note).filter(Boolean))];
                return (
                  <tr key={key} className={`border-b border-border/50 last:border-0 ${isToday ? "bg-brand/5" : ""}`}>
                    <td className={`sticky left-0 z-10 px-2 py-2 align-top border-r border-border/60 ${isToday ? "bg-brand/10" : "bg-surface"}`}>
                      <div className={`text-[9px] font-semibold tracking-wider ${isToday ? "text-brand" : working ? "text-text-muted" : "text-text-subtle/50"}`}>{THAI_DAYS_SHORT[wd]}</div>
                      <div className={`text-lg font-bold leading-tight ${isToday ? "text-brand" : working ? "text-text" : "text-text-subtle/50"}`}>{d.getDate()}</div>
                    </td>
                    {agents.map((a) => {
                      const ls = dayLeaves.filter((l) => l.adminId === a.admin_id);
                      return (
                        <td key={a.admin_id} className="px-1.5 py-1.5 align-top">
                          <div className="space-y-1 min-h-[40px]">
                            {ls.map((l) => (
                              <div
                                key={`${l.adminId}-${l.startDate}-${l.type}`}
                                title={`${LEAVE_META[l.type].label}${isPartial(l) ? ` ${l.startTime}–${l.endTime}` : " เต็มวัน"}${l.note ? ` · ${l.note}` : ""}`}
                                className="rounded-md px-2 py-1 text-[10px] font-semibold text-white leading-tight shadow-sm"
                                style={{ background: LEAVE_META[l.type].hex }}
                              >
                                {LEAVE_META[l.type].label}
                                {isPartial(l) && <span className="block font-normal opacity-90">{l.startTime}–{l.endTime}</span>}
                              </div>
                            ))}
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 align-top text-[10.5px] text-text-muted leading-snug">
                      {notes.length ? notes.join(" · ") : <span className="text-text-subtle/50">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* === Month calendar: chip ชื่อคนที่ลาในแต่ละวัน === */
        <div className="p-3 sm:p-4">
          <div className="grid grid-cols-7 gap-1.5">
            {THAI_DAYS_SHORT.map((d, i) => (
              <div key={i} className={`text-center text-[10.5px] font-semibold py-1 ${WORKING_DAYS.includes(i) ? "text-text-muted" : "text-text-subtle/50"}`}>{d}</div>
            ))}
            {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
            {days.map((d) => {
              const key = dateKey(cursor.y, cursor.m, d);
              const wd = new Date(cursor.y, cursor.m, d).getDay();
              const working = WORKING_DAYS.includes(wd);
              const onLeave = agents
                .map((a) => ({ a, l: leaveOn(leaves, a.admin_id, key) }))
                .filter((x) => x.l);
              const isToday = key === todayKey;
              return (
                <div key={d} className={`min-h-[76px] rounded-xl border p-1.5 transition-colors ${isToday ? "border-brand/60 bg-brand/5 shadow-[0_0_0_3px_var(--color-accent-soft)]" : working ? "border-border/70 bg-surface hover:border-border" : "border-border/40 bg-surface-2/40"}`}>
                  <div className={`w-5 h-5 mb-1 flex items-center justify-center rounded-full text-[11px] font-semibold ${isToday ? "bg-brand text-white" : working ? "text-text" : "text-text-subtle/50"}`}>{d}</div>
                  <div className="space-y-1">
                    {onLeave.slice(0, 3).map(({ a, l }) => (
                      <div key={a.admin_id} title={`${LEAVE_META[l!.type].label}${isPartial(l!) ? ` ${l!.startTime}–${l!.endTime}` : " เต็มวัน"}${l!.note ? ` · ${l!.note}` : ""}`}
                        className={`flex items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${LEAVE_META[l!.type].chip}`}>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${LEAVE_META[l!.type].dot}`} />
                        <span className="truncate">{a.name}{isPartial(l!) ? ` ${l!.startTime}–${l!.endTime}` : ""}</span>
                      </div>
                    ))}
                    {onLeave.length > 3 && <div className="text-[9px] text-text-subtle px-1">+{onLeave.length - 3} อีก</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
