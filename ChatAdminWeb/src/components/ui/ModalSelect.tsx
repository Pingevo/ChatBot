// ModalSelect — custom dropdown for use inside modals with overflow-y-auto
// ⚡ ใช้ position: fixed + getBoundingClientRect เพื่อไม่ถูกตัดจาก overflow ของ modal
// ใช้: <ModalSelect value={x} onChange={setX} options={[{value:"all",label:"ทั้งหมด"},...]} />
"use client";
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from "react";
import { ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import { SelectOptions } from "./SelectOptions";

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
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const generatedId = useId();
  const selectId = id || generatedId;

  useEffect(() => setPortalHost(document.body), []);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => btnRef.current?.focus());
  }, []);

  const updateMenuPosition = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(Math.max(rect.width, 176), window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
    const below = Math.max(0, window.innerHeight - rect.bottom - margin);
    const above = Math.max(0, rect.top - margin);
    const openAbove = below < Math.min(240, above);
    const maxHeight = Math.min(280, openAbove ? above : below);
    setMenuStyle({
      position: "fixed",
      top: openAbove ? Math.max(margin, rect.top - maxHeight - 4) : rect.bottom + 4,
      left,
      width,
      maxHeight,
      zIndex: 9999,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) updateMenuPosition();
  }, [open, updateMenuPosition]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      // check if click is inside the menu (which is fixed, not a child of btnRef)
      const menu = document.getElementById(`${selectId}-menu`);
      if (menu?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [open, selectId, close]);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", updateMenuPosition, true);
    window.addEventListener("resize", updateMenuPosition);
    return () => {
      window.removeEventListener("scroll", updateMenuPosition, true);
      window.removeEventListener("resize", updateMenuPosition);
    };
  }, [open, updateMenuPosition]);

  const selectedLabel = options.find((o) => o.value === value)?.label || "";

  return (
    <>
      <button
        ref={btnRef}
        id={selectId}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${selectId}-options`}
        className={`${fullWidth ? "w-full" : ""} mt-1 filter-select-trigger ${open ? "is-open" : ""} ${className}`}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && portalHost && createPortal(
        <div
          id={`${selectId}-menu`}
          style={menuStyle}
          className="filter-select-popover"
        >
          <SelectOptions
            id={`${selectId}-options`}
            label="ตัวเลือก"
            value={value}
            options={options}
            onSelect={(option) => { onChange(option.value); close(); }}
            onEscape={close}
          />
        </div>,
        portalHost
      )}
    </>
  );
}
