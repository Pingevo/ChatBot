// FilterSelect — shared custom dropdown for filter bars
// ⚡ ใช้ custom dropdown แทน native <select> เพื่อควบคุมทิศทาง — เปิดลงล่างเสมอ
// ใช้: <FilterSelect value={x} onChange={setX} labelPrefix="สถานะ: " options={[{value:"all",label:"ทั้งหมด"},...]} />
"use client";
import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";

interface FilterSelectOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: FilterSelectOption[];
  /** Optional label prefix shown before the selected option (e.g. "สถานะ: ") */
  labelPrefix?: string;
  className?: string;
}

export function FilterSelect({
  value,
  onChange,
  options,
  labelPrefix,
  className = "",
}: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const selectedLabel = options.find((o) => o.value === value)?.label || "";

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`h-8 px-2.5 rounded-lg border border-border bg-surface text-text text-xs focus:outline-none focus:ring-2 focus:ring-brand/40 cursor-pointer flex items-center gap-1.5 transition-colors hover:border-brand/40 ${open ? "border-brand/40" : ""}`}
      >
        <span className="truncate">
          {labelPrefix ? `${labelPrefix}${selectedLabel}` : selectedLabel}
        </span>
        <ChevronDown size={11} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute top-full left-0 mt-1 min-w-full bg-surface border border-border rounded-lg shadow-lg z-50 py-0.5 max-h-60 overflow-y-auto"
        >
          {options.map((opt) => {
            const sel = opt.value === value;
            return (
              <button
                key={opt.value}
                role="option"
                aria-selected={sel}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-1.5 hover:bg-surface-2 transition-colors ${sel ? "text-brand font-medium" : "text-text"}`}
              >
                {sel && <Check size={11} className="shrink-0" />}
                <span className={`truncate ${sel ? "" : "pl-[15px]"}`}>
                  {labelPrefix ? `${labelPrefix}${opt.label}` : opt.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
