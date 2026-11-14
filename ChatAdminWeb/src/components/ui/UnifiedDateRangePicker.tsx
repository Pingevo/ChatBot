"use client";
// UnifiedDateRangePicker — ปุ่มเดียวที่มีทั้ง preset และปฏิทิน
// แทนที่ DateRangeSelector + CalendarDateRangePicker ที่แยกกัน
import { useState, useRef, useEffect, useLayoutEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { DayPicker } from "react-day-picker";
import { th } from "date-fns/locale";
import { format } from "date-fns";
import { Calendar, ChevronDown, X } from "lucide-react";
import { ModalLayer } from "@/components/ui/ModalLayer";
import { useFocusTrap } from "@/lib/useKeyboardShortcuts";
import "react-day-picker/dist/style.css";

export type DateRangePreset = "daily" | "weekly" | "monthly" | "yearly" | "all" | "custom";

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
  { key: "daily", label: "วันนี้", short: "วันนี้" },
  { key: "weekly", label: "7 วันล่าสุด", short: "สัปดาห์" },
  { key: "monthly", label: "เดือนนี้", short: "เดือน" },
  { key: "yearly", label: "ปีนี้", short: "ปี" },
  { key: "all", label: "ทั้งหมด", short: "ทั้งหมด" },
];

function getPresetRange(preset: DateRangePreset): { start: Date | null; end: Date | null } {
  const now = new Date();
  if (preset === "all") return { start: null, end: null };
  if (preset === "monthly") return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  if (preset === "yearly") return { start: new Date(now.getFullYear(), 0, 1), end: now };
  if (preset === "weekly") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return { start, end: now };
  }
  // daily — วันนี้ 00:00 - 23:59
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function fmt(d: Date | null): string {
  if (!d) return "";
  return format(d, "dd/MM/yy");
}

function fmtISO(d: Date): string {
  // ⚡ ใช้ local date ไม่ใช่ UTC — กัน off-by-one ใน timezone ที่เป็น +7
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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
  const [phoneLayout, setPhoneLayout] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [desktopPanelStyle, setDesktopPanelStyle] = useState<CSSProperties>({
    position: "fixed",
    top: 0,
    left: 0,
    zIndex: 125,
    visibility: "hidden",
  });
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(open && phoneLayout);

  useEffect(() => {
    setHost(document.body);
    const media = window.matchMedia("(max-width: 767px), (pointer: coarse) and (max-width: 1279.98px)");
    const update = () => setPhoneLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    if (open && !phoneLayout) document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, [open, phoneLayout]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || phoneLayout || !host) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;

      const anchor = trigger.getBoundingClientRect();
      if (anchor.bottom <= 0 || anchor.top >= window.innerHeight) {
        setOpen(false);
        return;
      }

      const margin = 12;
      const maxHeight = Math.max(120, window.innerHeight - margin * 2);
      const panelRect = panel.getBoundingClientRect();
      const width = Math.min(panelRect.width, window.innerWidth - margin * 2);
      const height = Math.min(panel.scrollHeight, maxHeight);
      const top = Math.max(margin, Math.min(anchor.bottom + 8, window.innerHeight - height - margin));
      const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));

      setDesktopPanelStyle({
        position: "fixed",
        top,
        left,
        width,
        maxHeight,
        overflowY: "auto",
        zIndex: 125,
        visibility: "visible",
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, phoneLayout, host, tempStart, tempEnd, activePreset, mode]);

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

  // ⚡ range สำหรับ DayPicker mode="range" — ใช้ highlight ช่วง
  const rangeSelected = tempStart && tempEnd
    ? { from: tempStart, to: tempEnd }
    : tempStart
    ? { from: tempStart, to: tempStart }
    : undefined;

  function handleRangeSelect(range: { from?: Date | undefined; to?: Date | undefined } | undefined) {
    if (!range) {
      setTempStart(null);
      setTempEnd(null);
      return;
    }
    setActivePreset("custom");
    setTempStart(range.from || null);
    setTempEnd(range.to || null);
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

  const displayLabel = rangeLabel(value);
  const pickerPanel = (
    <div
      ref={phoneLayout ? dialogRef : panelRef}
      role="dialog"
      aria-modal={phoneLayout || undefined}
      aria-label="เลือกช่วงวันที่"
      tabIndex={phoneLayout ? -1 : undefined}
      className={phoneLayout
        ? "mobile-date-range-panel flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        : "w-[380px] max-w-[calc(100vw-1.5rem)] overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-surface shadow-xl"}
      style={phoneLayout ? undefined : desktopPanelStyle}
      onClick={(event) => event.stopPropagation()}
    >
      {phoneLayout && (
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text">ช่วงวันที่</h2>
            <p className="mt-0.5 truncate text-xs text-text-muted">{displayLabel}</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="ปิดตัวเลือกวันที่"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
      )}

      <div className="grid grid-cols-5 gap-1 border-b border-border bg-surface-2/50 p-2.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            onClick={() => selectPreset(preset.key)}
            className={`min-h-10 rounded-lg px-1 py-2 text-[11px] font-medium transition-colors sm:text-xs ${
              activePreset === preset.key
                ? "bg-brand text-white shadow-sm"
                : "bg-surface text-text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {phoneLayout && preset.key === "weekly" ? "7 วัน" : preset.short}
          </button>
        ))}
      </div>

      <div className={`mobile-date-range-content min-h-0 ${phoneLayout ? "mobile-workspace-body flex-1 overflow-y-auto overscroll-contain p-2" : "p-3"}`}>
        <div className="mb-2.5 flex gap-1.5">
          <button
            type="button"
            onClick={() => setMode("start")}
            className={`flex min-h-10 flex-1 items-center justify-between gap-2 rounded-lg border px-2.5 text-xs transition-colors ${
              mode === "start" ? "border-brand/30 bg-brand/10 font-medium text-brand" : "border-transparent bg-surface-2 text-text-muted"
            }`}
          >
            <span>วันเริ่ม</span>
            <span>{tempStart ? fmt(tempStart) : "—"}</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("end")}
            className={`flex min-h-10 flex-1 items-center justify-between gap-2 rounded-lg border px-2.5 text-xs transition-colors ${
              mode === "end" ? "border-brand/30 bg-brand/10 font-medium text-brand" : "border-transparent bg-surface-2 text-text-muted"
            }`}
          >
            <span>วันจบ</span>
            <span>{tempEnd ? fmt(tempEnd) : "—"}</span>
          </button>
        </div>

        {tempStart && (
          <div className="mb-2 rounded-lg border border-brand/20 bg-brand/10 px-3 py-2 text-xs text-text">
            <span className="text-text-muted">ช่วงที่เลือก: </span>
            <span className="font-medium text-brand">{fmt(tempStart)}</span>
            {tempEnd && tempEnd.getTime() !== tempStart.getTime() && (
              <>
                <span className="text-text-muted"> ถึง </span>
                <span className="font-medium text-brand">{fmt(tempEnd)}</span>
              </>
            )}
            {tempEnd && <span className="ml-2 text-text-subtle">({Math.round((tempEnd.getTime() - tempStart.getTime()) / 86400000) + 1} วัน)</span>}
          </div>
        )}

        <div className="flex justify-center">
          <DayPicker
            mode="range"
            selected={rangeSelected}
            onSelect={handleRangeSelect}
            numberOfMonths={1}
            locale={th}
            startMonth={new Date(2020, 0)}
            endMonth={new Date(new Date().getFullYear() + 1, 11)}
            captionLayout="dropdown"
          />
        </div>

      </div>

      <div className="mobile-workspace-actions mt-2 flex items-center justify-between gap-2 border-t border-border px-3 pt-2.5">
          <button
            type="button"
            onClick={handleClear}
            className="min-h-10 rounded-lg px-2.5 text-xs text-text-muted transition-colors hover:bg-error/5 hover:text-vibrant-coral"
          >
            รีเซ็ต
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="min-h-10 rounded-lg bg-surface-2 px-3 text-xs text-text-muted transition-colors hover:text-text"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!tempStart}
              className="min-h-10 rounded-lg bg-brand px-3 text-xs font-medium text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              เลือกช่วงวันที่
            </button>
          </div>
      </div>
    </div>
  );

  return (
    <div className={`relative ${className}`} ref={ref}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-2 h-9 px-3 rounded-lg bg-surface border border-border text-sm text-text hover:border-brand/40 transition-colors min-w-[120px]"
      >
        <Calendar size={15} className="text-text-muted shrink-0" />
        <span className="flex-1 text-left truncate">{displayLabel}</span>
        <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        phoneLayout ? (
          <ModalLayer presentation="sheet" className="mobile-date-range-overlay fixed inset-0 z-[120] flex items-end justify-center bg-black/45" onClick={() => setOpen(false)} onBack={() => setOpen(false)}>
            {pickerPanel}
          </ModalLayer>
        ) : host ? createPortal(pickerPanel, host) : null
      )}
    </div>
  );
}
