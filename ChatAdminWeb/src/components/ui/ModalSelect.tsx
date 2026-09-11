// ModalSelect — custom dropdown for use inside modals with overflow-y-auto
// ⚡ ใช้ position: fixed + getBoundingClientRect เพื่อไม่ถูกตัดจาก overflow ของ modal
// ใช้: <ModalSelect value={x} onChange={setX} options={[{value:"all",label:"ทั้งหมด"},...]} />
"use client";
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { ChevronDown, Check } from "lucide-react";

interface ModalSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface ModalSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: ModalSelectOption[];
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Full width (default true) — set false for compact inline */
  fullWidth?: boolean;
}

export function ModalSelect({
  value,
  onChange,
  options,
  id,
  disabled = false,
  className = "",
  fullWidth = true,
}: ModalSelectProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  // calculate menu position relative to viewport (fixed positioning)
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setMenuStyle({
      position: "fixed",
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    });
  }, [open]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      // check if click is inside the menu (which is fixed, not a child of btnRef)
      const menu = document.getElementById(`${id || "modal-select"}-menu`);
      if (menu?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, id]);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // recalc position on scroll/resize
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const recalc = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      setMenuStyle({
        position: "fixed",
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
      });
    };
    window.addEventListener("scroll", recalc, true);
    window.addEventListener("resize", recalc);
    return () => {
      window.removeEventListener("scroll", recalc, true);
      window.removeEventListener("resize", recalc);
    };
  }, [open]);

  const selectedLabel = options.find((o) => o.value === value)?.label || "";

  return (
    <>
      <button
        ref={btnRef}
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`${fullWidth ? "w-full" : ""} mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 flex items-center justify-between gap-2 transition-colors disabled:opacity-60 ${open ? "border-brand/40" : ""} ${className}`}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          id={`${id || "modal-select"}-menu`}
          role="listbox"
          style={menuStyle}
          className="bg-surface border border-border rounded-lg shadow-lg py-0.5 max-h-60 overflow-y-auto"
        >
          {options.map((opt) => {
            const sel = opt.value === value;
            return (
              <button
                key={opt.value}
                role="option"
                aria-selected={sel}
                disabled={opt.disabled}
                onClick={() => { if (!opt.disabled) { onChange(opt.value); setOpen(false); } }}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${sel ? "text-brand font-medium" : "text-text"} ${opt.disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-surface-2"}`}
              >
                {sel && <Check size={14} className="shrink-0" />}
                <span className={`truncate ${sel ? "" : "pl-[18px]"}`}>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
