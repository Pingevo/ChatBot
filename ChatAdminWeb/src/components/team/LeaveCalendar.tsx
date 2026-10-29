"use client";

// LeaveCalendar — ปฏิทินวันลาของทีม (view-only)
// 2 มุมมอง: roster (คน×วัน ทั้งแผนก) และ month calendar (chip ชื่อคนที่ลาในแต่ละวัน)
// ตอนนี้ใช้ mock leave records — เปลี่ยนเป็น fetch จากระบบกลางงานภายหลัง
import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, LayoutGrid, ListChecks, Clock } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

export type LeaveType = "sick" | "personal" | "vacation" | "holiday";

export interface LeaveRecord {
  adminId: string;
  startDate: string; // ISO yyyy-mm-dd
  endDate: string;
  type: LeaveType;
  note?: string;
}

export interface LeaveCalendarAgent {
  admin_id: string;
  name: string;
}

// เวลาทำการร้าน — ตรงกับ business_hours ที่ workflow จะใช้; วันทำงานจริงจะมาจาก API ระบบกลาง
const BUSINESS_HOURS = "09:30–17:30";
const WORKING_DAYS = [0, 1, 2, 3, 4, 5, 6]; // 0=อาทิตย์ …ทำงานทุกวัน (mock — API จะส่งวันทำงานจริง)

const LEAVE_META: Record<LeaveType, { label: string; cell: string; chip: string; dot: string }> = {
  sick: { label: "ลาป่วย", cell: "bg-red-500/80", chip: "bg-red-500/15 text-red-600", dot: "bg-red-500" },
  personal: { label: "ลากิจ", cell: "bg-amber-400/80", chip: "bg-amber-400/20 text-amber-700", dot: "bg-amber-400" },
  vacation: { label: "พักร้อน", cell: "bg-sky-500/80", chip: "bg-sky-500/15 text-sky-600", dot: "bg-sky-500" },
  holiday: { label: "วันหยุดนักขัตฤกษ์", cell: "bg-emerald-500/80", chip: "bg-emerald-500/15 text-emerald-700", dot: "bg-emerald-500" },
};

const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const THAI_DAYS_SHORT = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function dateKey(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function daysInMonth(y: number, m: number) {
  return new Date(y, m + 1, 0).getDate();
}

/** สร้าง mock leave จากรายชื่อ agent จริง — deterministic ตาม index (เปลี่ยนเป็น API ทีหลัง) */
function buildMockLeaves(agents: LeaveCalendarAgent[], year: number, month: number): LeaveRecord[] {
  const dim = daysInMonth(year, month);
  const day = (d: number) => dateKey(year, month, Math.min(Math.max(d, 1), dim));
  const types: LeaveType[] = ["sick", "vacation", "personal"];
  return agents.slice(0, Math.min(4, agents.length)).map((a, i) => {
    const start = 3 + i * 6; // spread across the month
    const len = i % 2 === 0 ? 2 : 4;
    return {
      adminId: a.admin_id,
      startDate: day(start),
      endDate: day(start + len - 1),
      type: types[i % types.length],
      note: "(mock)",
    };
  });
}

function leaveOn(leaves: LeaveRecord[], adminId: string, key: string): LeaveRecord | undefined {
  return leaves.find((l) => l.adminId === adminId && key >= l.startDate && key <= l.endDate);
}

export function LeaveCalendar({ agents }: { agents: LeaveCalendarAgent[] }) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [mode, setMode] = useState<"roster" | "month">("roster");
  const todayKey = dateKey(now.getFullYear(), now.getMonth(), now.getDate());

  const leaves = useMemo(() => buildMockLeaves(agents, cursor.y, cursor.m), [agents, cursor.y, cursor.m]);
  const dim = daysInMonth(cursor.y, cursor.m);
  const days = Array.from({ length: dim }, (_, i) => i + 1);
  const firstWeekday = new Date(cursor.y, cursor.m, 1).getDay();

  const shift = (n: number) =>
    setCursor((c) => {
      const d = new Date(c.y, c.m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  const onLeaveToday = agents.filter((a) => leaveOn(leaves, a.admin_id, todayKey));

  return (
    <Card className="overflow-hidden">
      {/* header */}
      <div className="px-3 sm:px-4 py-3 border-b border-border flex flex-wrap items-center gap-x-2 gap-y-2">
        <CalendarDays size={14} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text">ปฏิทินวันลา</h2>
        <Badge tone="neutral">{THAI_MONTHS[cursor.m]} {cursor.y + 543}</Badge>
        {onLeaveToday.length > 0 && (
          <Badge tone="coral">วันนี้ลา {onLeaveToday.length} คน</Badge>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          <div className="flex items-center rounded-lg border border-border overflow-hidden">
            <button onClick={() => setMode("roster")} title="มุมมองทั้งแผนก (คน×วัน)" className={`px-2 py-1.5 ${mode === "roster" ? "bg-brand text-white" : "text-text-muted hover:bg-surface-2"}`}><ListChecks size={13} /></button>
            <button onClick={() => setMode("month")} title="มุมมองปฏิทินเดือน" className={`px-2 py-1.5 ${mode === "month" ? "bg-brand text-white" : "text-text-muted hover:bg-surface-2"}`}><LayoutGrid size={13} /></button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => shift(-1)}><ChevronLeft size={14} /></Button>
          <Button variant="ghost" size="sm" onClick={() => setCursor({ y: now.getFullYear(), m: now.getMonth() })}>เดือนนี้</Button>
          <Button variant="ghost" size="sm" onClick={() => shift(1)}><ChevronRight size={14} /></Button>
        </div>
      </div>

      {/* business hours + legend */}
      <div className="px-3 sm:px-4 py-2 border-b border-border flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-text-muted">
        <span className="flex items-center gap-1"><Clock size={11} /> เวลาทำการ {BUSINESS_HOURS} · {WORKING_DAYS.length === 7 ? "ทุกวัน" : `${WORKING_DAYS.length} วัน/สัปดาห์`}</span>
        <span className="flex items-center gap-3">
          {Object.entries(LEAVE_META).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${v.dot}`} />{v.label}</span>
          ))}
        </span>
        <span className="text-text-subtle">คนที่ลา = ปิดรับงาน handoff อัตโนมัติ</span>
      </div>

      {agents.length === 0 ? (
        <div className="p-8 text-center text-sm text-text-muted">ยังไม่มี agent</div>
      ) : mode === "roster" ? (
        /* === Roster: แถว=คน × คอลัมน์=วัน === */
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-surface-2/60">
                <th className="sticky left-0 z-10 bg-surface-2/95 backdrop-blur px-3 py-2 text-left font-medium text-text-muted min-w-[140px] border-b border-border">Agent</th>
                {days.map((d) => {
                  const wd = new Date(cursor.y, cursor.m, d).getDay();
                  const isToday = dateKey(cursor.y, cursor.m, d) === todayKey;
                  const working = WORKING_DAYS.includes(wd);
                  return (
                    <th key={d} className={`px-0.5 py-1.5 font-medium min-w-[26px] border-b border-border ${isToday ? "bg-brand/15 text-brand" : working ? "text-text-muted" : "text-text-subtle/50"}`}>
                      <div className="leading-tight">{d}</div>
                      <div className="text-[9px] font-normal">{THAI_DAYS_SHORT[wd]}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const offToday = !!leaveOn(leaves, a.admin_id, todayKey);
                return (
                  <tr key={a.admin_id} className="border-b border-border/60 last:border-0 hover:bg-surface-2/40">
                    <td className="sticky left-0 z-10 bg-surface px-3 py-1.5 whitespace-nowrap border-r border-border/60">
                      <span className="font-medium text-text">{a.name}</span>
                      {offToday && <span className="ml-1.5 text-[9px] font-semibold text-error">ลา — ปิดรับงาน</span>}
                    </td>
                    {days.map((d) => {
                      const key = dateKey(cursor.y, cursor.m, d);
                      const l = leaveOn(leaves, a.admin_id, key);
                      const wd = new Date(cursor.y, cursor.m, d).getDay();
                      const working = WORKING_DAYS.includes(wd);
                      return (
                        <td key={d} className={`p-0.5 text-center ${key === todayKey ? "bg-brand/10" : ""}`} title={l ? `${LEAVE_META[l.type].label}${l.note ? ` ${l.note}` : ""}` : ""}>
                          <div className={`h-6 rounded-sm ${l ? LEAVE_META[l.type].cell : working ? "" : "bg-surface-2/50"}`} />
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
          <div className="grid grid-cols-7 gap-1">
            {THAI_DAYS_SHORT.map((d, i) => (
              <div key={i} className={`text-center text-[11px] font-semibold py-1 ${WORKING_DAYS.includes(i) ? "text-text-muted" : "text-text-subtle/60"}`}>{d}</div>
            ))}
            {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
            {days.map((d) => {
              const key = dateKey(cursor.y, cursor.m, d);
              const onLeave = agents
                .map((a) => ({ a, l: leaveOn(leaves, a.admin_id, key) }))
                .filter((x) => x.l);
              const isToday = key === todayKey;
              return (
                <div key={d} className={`min-h-[68px] rounded-lg border p-1 ${isToday ? "border-brand bg-brand/5" : "border-border/60"}`}>
                  <div className={`text-[11px] font-medium mb-0.5 ${isToday ? "text-brand" : "text-text-muted"}`}>{d}</div>
                  <div className="space-y-0.5">
                    {onLeave.slice(0, 3).map(({ a, l }) => (
                      <div key={a.admin_id} title={LEAVE_META[l!.type].label} className={`truncate rounded px-1 py-0.5 text-[10px] font-medium ${LEAVE_META[l!.type].chip}`}>
                        {a.name}
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
