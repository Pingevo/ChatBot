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
function initialOf(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

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

/** รวมวันลาติดกันเป็น span bar (สำหรับ roster row) */
interface LeaveSpan { leave: LeaveRecord; startDay: number; endDay: number }
function spansFor(leaves: LeaveRecord[], adminId: string, year: number, month: number, dim: number): LeaveSpan[] {
  const first = dateKey(year, month, 1), last = dateKey(year, month, dim);
  const spans: LeaveSpan[] = [];
  for (const l of leaves.filter((x) => x.adminId === adminId && x.endDate >= first && x.startDate <= last)) {
    const s = Math.max(1, Number(l.startDate.slice(8, 10)) || 1);
    const e = Math.min(dim, Number(l.endDate.slice(8, 10)) || dim);
    const clampS = l.startDate < first ? 1 : s;
    spans.push({ leave: l, startDay: clampS, endDay: e });
  }
  return spans.sort((a, b) => a.startDay - b.startDay);
}

export function LeaveCalendar({ agents }: { agents: LeaveCalendarAgent[] }) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [mode, setMode] = useState<"roster" | "month">("roster");
  const todayKey = dateKey(now.getFullYear(), now.getMonth(), now.getDate());

  const leaves = useMemo(() => buildMockLeaves(agents, cursor.y, cursor.m, todayKey), [agents, cursor.y, cursor.m, todayKey]);
  const dim = daysInMonth(cursor.y, cursor.m);
  const days = Array.from({ length: dim }, (_, i) => i + 1);
  const firstWeekday = new Date(cursor.y, cursor.m, 1).getDay();

  const shift = (n: number) =>
    setCursor((c) => {
      const d = new Date(c.y, c.m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  const statuses = useMemo(() => {
    const map = new Map<string, LeaveStatusNow>();
    for (const a of agents) map.set(a.admin_id, leaveStatusNow(leaves, a.admin_id, now));
    return map;
  }, [agents, leaves]);
  const offCount = [...statuses.values()].filter((s) => s.status !== "working").length;
  const monthLeaveCount = leaves.length;

  const cellW = 30; // px ต่อวันใน roster

  return (
    <Card className="overflow-hidden">
      {/* header */}
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-border">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div>
            <div className="flex items-center gap-2">
              <CalendarDays size={16} className="text-brand" />
              <h2 className="text-base font-bold text-text tracking-tight">{THAI_MONTHS[cursor.m]} {cursor.y + 543}</h2>
            </div>
            <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted">
              <span className="flex items-center gap-1"><Clock size={11} /> ทำการ {BUSINESS_HOURS} · {WORKING_DAYS.length === 7 ? "ทุกวัน" : `${WORKING_DAYS.length} วัน/สัปดาห์`}</span>
              {offCount > 0 && <span className="flex items-center gap-1 text-error font-medium"><CircleSlash size={11} /> วันนี้ลา {offCount} คน</span>}
              <span className="hidden sm:inline text-text-subtle">{monthLeaveCount} รายการลาในเดือนนี้</span>
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
              <button onClick={() => shift(-1)} className="px-2 py-1.5 text-text-muted hover:text-text transition-colors" aria-label="เดือนก่อน"><ChevronLeft size={15} /></button>
              <button onClick={() => setCursor({ y: now.getFullYear(), m: now.getMonth() })} className="px-2.5 py-1.5 text-[11px] font-medium text-text-muted hover:text-text border-x border-border transition-colors">เดือนนี้</button>
              <button onClick={() => shift(1)} className="px-2 py-1.5 text-text-muted hover:text-text transition-colors" aria-label="เดือนถัดไป"><ChevronRight size={15} /></button>
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
        /* === Roster: แถว=คน × คอลัมน์=วัน, leave bar เป็น span เดียว === */
        <div className="overflow-x-auto">
          <table className="border-collapse table-fixed text-xs" style={{ minWidth: 200 + dim * cellW }}>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-surface px-4 py-2 text-left font-medium text-text-muted min-w-[190px] border-b border-border shadow-[1px_0_0_0_var(--color-border)]">Agent</th>
                {days.map((d) => {
                  const wd = new Date(cursor.y, cursor.m, d).getDay();
                  const isToday = dateKey(cursor.y, cursor.m, d) === todayKey;
                  const working = WORKING_DAYS.includes(wd);
                  return (
                    <th key={d} style={{ width: cellW }} className={`py-1.5 font-medium border-b border-border ${isToday ? "bg-brand/10" : working ? "" : "bg-surface-2/40"}`}>
                      <div className={`leading-tight ${isToday ? "text-brand font-bold" : working ? "text-text-muted" : "text-text-subtle/40"}`}>{d}</div>
                      <div className={`text-[8.5px] font-normal ${isToday ? "text-brand/80" : "text-text-subtle/60"}`}>{THAI_DAYS_SHORT[wd]}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const st = statuses.get(a.admin_id);
                const spans = spansFor(leaves, a.admin_id, cursor.y, cursor.m, dim);
                const spanByStart = new Map(spans.map((s) => [s.startDay, s]));
                const covered = new Set<number>();
                for (const s of spans) for (let d = s.startDay; d <= s.endDay; d++) covered.add(d);
                return (
                  <tr key={a.admin_id} className="border-b border-border/50 last:border-0 hover:bg-surface-2/30 transition-colors">
                    <td className="sticky left-0 z-10 bg-surface px-4 py-2 border-r border-border/60 shadow-[1px_0_0_0_var(--color-border)]">
                      <div className="flex items-center gap-2.5">
                        <span className="w-7 h-7 rounded-full bg-brand/10 text-brand text-[11px] font-bold flex items-center justify-center shrink-0">{initialOf(a.name)}</span>
                        <div className="min-w-0">
                          <div className="font-medium text-text truncate leading-tight">{a.name}</div>
                          {st && st.status !== "working" ? (
                            <div className="text-[9.5px] font-medium text-error leading-tight mt-0.5">
                              {st.status === "off" ? `ลา${LEAVE_META[st.record.type].label} — ปิดรับงาน` : `ลา ${st.window} — ปิดรับงานช่วงนี้`}
                            </div>
                          ) : st?.record ? (
                            <div className="text-[9.5px] text-text-subtle leading-tight mt-0.5">ลา {st.record.startTime}–{st.record.endTime} · รับงานแล้ว</div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    {days.map((d) => {
                      const key = dateKey(cursor.y, cursor.m, d);
                      const isToday = key === todayKey;
                      const wd = new Date(cursor.y, cursor.m, d).getDay();
                      const working = WORKING_DAYS.includes(wd);
                      const span = spanByStart.get(d);
                      return (
                        <td key={d} className={`p-[3px] ${isToday ? "bg-brand/10" : working ? "" : "bg-surface-2/30"}`}>
                          {span ? (
                            <div
                              title={`${LEAVE_META[span.leave.type].label}${isPartial(span.leave) ? ` ${span.leave.startTime}–${span.leave.endTime}` : " เต็มวัน"}${span.leave.note ? ` · ${span.leave.note}` : ""}`}
                              className="h-6 rounded-md flex items-center justify-center px-1.5 overflow-hidden"
                              style={{
                                width: span.endDay - span.startDay + 1 > 1 ? `calc(${(span.endDay - span.startDay + 1) * 100}% + ${(span.endDay - span.startDay) * 6}px)` : "100%",
                                background: LEAVE_META[span.leave.type].hex,
                              }}
                            >
                              {span.endDay > span.startDay ? (
                                <span className="text-[9px] font-bold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.3)] whitespace-nowrap">
                                  {LEAVE_META[span.leave.type].label}{isPartial(span.leave) ? ` ${span.leave.startTime}–${span.leave.endTime}` : ""}
                                </span>
                              ) : isPartial(span.leave) ? (
                                <Clock size={11} className="text-white" />
                              ) : null}
                            </div>
                          ) : (
                            <div className="h-6" />
                          )}
                        </td>
                      );
                    })}
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
