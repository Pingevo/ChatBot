"use client";
// UnifiedDateRangePicker — ปุ่มเดียวที่มีทั้ง preset และปฏิทิน
// แทนที่ DateRangeSelector + CalendarDateRangePicker ที่แยกกัน
import { useState, useRef, useEffect } from "react";
import { DayPicker } from "react-day-picker";
import { th } from "date-fns/locale";
import { format } from "date-fns";
import { Calendar, ChevronDown } from "lucide-react";
import "react-day-picker/dist/style.css";

export type DateRangePreset = "daily" | "monthly" | "yearly" | "all" | "custom";

export interface DateRangeValue {
  preset: DateRangePreset;
  startDate: Date | null;
  endDate: Date | null;
}

interface Props {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  className?: string;
}

const PRESETS: { key: DateRangePreset; label: string; short: string }[] = [
  { key: "daily", label: "7 วันล่าสุด", short: "รายวัน" },
  { key: "monthly", label: "เดือนนี้", short: "รายเดือน" },
  { key: "yearly", label: "ปีนี้", short: "รายปี" },
  { key: "all", label: "ทั้งหมด", short: "ทั้งหมด" },
];

function getPresetRange(preset: DateRangePreset): { start: Date | null; end: Date | null } {
  const now = new Date();
  if (preset === "all") return { start: null, end: null };
  if (preset === "monthly") return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  if (preset === "yearly") return { start: new Date(now.getFullYear(), 0, 1), end: now };
  // daily
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  return { start, end: now };
}

function fmt(d: Date | null): string {
  if (!d) return "";
  return format(d, "dd/MM/yy");
}

function fmtISO(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** แปลง DateRangeValue เป็น params สำหรับ API */
export function rangeToParams(v: DateRangeValue): { range?: string; start_date?: string; end_date?: string } {
  if (v.preset === "custom" && v.startDate) {
    return {
      start_date: fmtISO(v.startDate),
      end_date: v.endDate ? fmtISO(v.endDate) : fmtISO(v.startDate),
    };
  }
  return { range: v.preset };
}

/** สร้าง label สั้นๆ สำหรับปุ่ม */
export function rangeLabel(v: DateRangeValue): string {
  const preset = PRESETS.find((p) => p.key === v.preset);
  if (v.preset === "custom" && v.startDate) {
    return v.endDate
      ? `${fmt(v.startDate)} - ${fmt(v.endDate)}`
      : `${fmt(v.startDate)}`;
  }
  return preset?.short || "รายวัน";
}

export function UnifiedDateRangePicker({ value, onChange, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"start" | "end">("start");
  const [tempStart, setTempStart] = useState<Date | null>(null);
  const [tempEnd, setTempEnd] = useState<Date | null>(null);
  const [activePreset, setActivePreset] = useState<DateRangePreset>(value.preset);
  const ref = useRef<HTMLDivElement>(null);

  // sync when opening
  useEffect(() => {
    if (open) {
      setTempStart(value.startDate);
      setTempEnd(value.endDate);
      setActivePreset(value.preset);
      setMode("start");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function selectPreset(preset: DateRangePreset) {
    setActivePreset(preset);
    setTempStart(null);
    setTempEnd(null);
    const { start, end } = getPresetRange(preset);
    onChange({ preset, startDate: start, endDate: end });
    setOpen(false);
  }

  function handleDaySelect(day: Date) {
    setActivePreset("custom");
    if (mode === "start") {
      setTempStart(day);
      if (tempEnd && day > tempEnd) setTempEnd(null);
      setMode("end");
    } else {
      if (tempStart && day >= tempStart) {
        setTempEnd(day);
        setMode("start");
      } else {
        setTempStart(day);
        setMode("end");
      }
    }
  }

  function handleApply() {
    if (tempStart) {
      onChange({
        preset: "custom",
        startDate: tempStart,
        endDate: tempEnd || tempStart,
      });
    }
    setOpen(false);
  }

  function handleClear() {
    setTempStart(null);
    setTempEnd(null);
    setActivePreset("daily");
    const { start, end } = getPresetRange("daily");
    onChange({ preset: "daily", startDate: start, endDate: end });
    setOpen(false);
  }

  const disabledDays = mode === "end" && tempStart ? { before: tempStart } : undefined;
  const displayLabel = rangeLabel(value);

  return (
    <div className={`relative ${className}`} ref={ref}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 h-9 px-3 rounded-lg bg-surface border border-border text-sm text-text hover:border-brand/40 transition-colors min-w-[120px]"
      >
        <Calendar size={15} className="text-text-muted shrink-0" />
        <span className="flex-1 text-left truncate">{displayLabel}</span>
        <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 bg-surface rounded-xl shadow-xl border border-border w-[380px] overflow-hidden">
          {/* Preset buttons row */}
          <div className="grid grid-cols-4 gap-1 p-3 border-b border-border bg-surface-2/50">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => selectPreset(p.key)}
                className={`px-2 py-2 text-xs font-medium rounded-md transition-all ${
                  activePreset === p.key
                    ? "bg-brand text-white shadow-sm"
                    : "bg-surface text-text-muted hover:text-text hover:bg-surface-2"
                }`}
              >
                {p.short}
              </button>
            ))}
          </div>

          {/* Calendar section */}
          <div className="p-3">
            {/* Start/End tabs */}
            <div className="flex gap-1 mb-3">
              <button
                onClick={() => setMode("start")}
                className={`flex-1 px-3 py-2 text-xs rounded-md transition-colors flex items-center justify-between ${
                  mode === "start" ? "bg-brand/10 text-brand font-medium border border-brand/30" : "bg-surface-2 text-text-muted border border-transparent"
                }`}
              >
                <span>วันเริ่ม</span>
                <span className={mode === "start" ? "text-brand" : "text-text-subtle"}>
                  {tempStart ? fmt(tempStart) : "—"}
                </span>
              </button>
              <button
                onClick={() => setMode("end")}
                className={`flex-1 px-3 py-2 text-xs rounded-md transition-colors flex items-center justify-between ${
                  mode === "end" ? "bg-brand/10 text-brand font-medium border border-brand/30" : "bg-surface-2 text-text-muted border border-transparent"
                }`}
              >
                <span>วันจบ</span>
                <span className={mode === "end" ? "text-brand" : "text-text-subtle"}>
                  {tempEnd ? fmt(tempEnd) : "—"}
                </span>
              </button>
            </div>

            {/* Calendar */}
            <div className="flex justify-center">
              <DayPicker
                mode="single"
                selected={mode === "start" ? tempStart || undefined : tempEnd || undefined}
                onSelect={(day) => day && handleDaySelect(day)}
                disabled={disabledDays}
                locale={th}
                startMonth={new Date(2020, 0)}
                endMonth={new Date(new Date().getFullYear() + 1, 11)}
                captionLayout="dropdown"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-between items-center mt-3 pt-3 border-t border-border">
              <button
                onClick={handleClear}
                className="px-3 py-1.5 text-xs text-text-muted hover:text-vibrant-coral rounded-md transition-colors"
              >
                รีเซ็ต
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setOpen(false)}
                  className="px-4 py-1.5 text-xs text-text-muted hover:text-text rounded-md bg-surface-2 transition-colors"
                >
                  ยกเลิก
                </button>
                <button
                  onClick={handleApply}
                  disabled={!tempStart}
                  className="px-4 py-1.5 text-xs text-white bg-brand rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-dark transition-colors"
                >
                  เลือกช่วงวันที่
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
