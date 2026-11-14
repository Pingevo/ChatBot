// Shared filter picker: anchored popover for pointer input, contained dialog for touch.
"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import { SelectOptions, type SelectOption } from "./SelectOptions";

interface FilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  labelPrefix?: string;
  className?: string;
}

export function _getFilterDialogTabStops(buttons: Iterable<HTMLButtonElement>): HTMLButtonElement[] {
  return Array.from(buttons).filter((button) => !button.disabled && button.tabIndex >= 0);
}

export function FilterSelect({ value, onChange, options, labelPrefix, className = "" }: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const [touchLayout, setTouchLayout] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selectedLabel = options.find((option) => option.value === value)?.label || value;

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const choose = useCallback((option: SelectOption) => {
    onChange(option.value);
    close();
  }, [close, onChange]);

  useEffect(() => {
    setHost(document.body);
    const media = window.matchMedia("(max-width: 767.98px), (pointer: coarse) and (max-width: 1279.98px)");
    const update = () => setTouchLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open || touchLayout) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, touchLayout, close]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  const optionsList = (
    <SelectOptions
      id={listId}
      label={labelPrefix ? labelPrefix.replace(/[:\s]+$/, "") : "ตัวเลือก"}
      value={value}
      options={options}
      labelPrefix={labelPrefix}
      onSelect={choose}
      onEscape={close}
    />
  );

  return (
    <div ref={ref} className={`filter-select relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        className={`filter-select-trigger ${touchLayout ? "is-touch" : ""} ${open ? "is-open" : ""}`}
      >
        <span className="truncate">{labelPrefix ? `${labelPrefix}${selectedLabel}` : selectedLabel}</span>
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && touchLayout && host ? createPortal(
        <div className="filter-select-overlay" onPointerDown={(event) => event.target === event.currentTarget && close()}>
          <section
            className="filter-select-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={labelPrefix ? labelPrefix.replace(/[:\s]+$/, "") : "เลือกตัวกรอง"}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusable = _getFilterDialogTabStops(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <header className="filter-select-dialog-header">
              <div className="min-w-0">
                <p className="filter-select-dialog-eyebrow">ตัวกรอง</p>
                <h2 className="truncate">{labelPrefix ? labelPrefix.replace(/[:\s]+$/, "") : "เลือกตัวเลือก"}</h2>
              </div>
              <button type="button" className="filter-select-close" onClick={close} aria-label="ปิดตัวเลือก">
                <X size={17} />
              </button>
            </header>
            <div className="filter-select-options">{optionsList}</div>
          </section>
        </div>,
        host
      ) : open && (
        <div className="filter-select-popover">
          {optionsList}
        </div>
      )}
    </div>
  );
}
