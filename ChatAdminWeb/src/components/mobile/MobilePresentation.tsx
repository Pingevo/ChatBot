"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { AlertCircle, CheckCircle2, ChevronDown, Info, RotateCcw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useFocusTrap } from "@/lib/useKeyboardShortcuts";
import { ModalLayer } from "@/components/ui/ModalLayer";

type Tone = "info" | "success" | "warning" | "error";

const toneStyles: Record<Tone, { icon: typeof Info; className: string; label: string }> = {
  info: { icon: Info, className: "border-navy/20 bg-info-soft text-navy", label: "ข้อมูล" },
  success: { icon: CheckCircle2, className: "border-success/25 bg-success-soft text-success-dark", label: "สำเร็จ" },
  warning: { icon: TriangleAlert, className: "border-warning/30 bg-warning-soft text-warning-dark", label: "คำเตือน" },
  error: { icon: AlertCircle, className: "border-error/25 bg-error-soft text-error", label: "เกิดข้อผิดพลาด" },
};

export function MobileCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`mobile-card p-4 ${className}`}>{children}</section>;
}

export function MobileDataCard({
  title,
  subtitle,
  rows,
  actions,
  previewCount = 2,
  details,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  rows: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
  previewCount?: number;
  details?: ReactNode;
}) {
  return (
    <MobileInfoCard title={title} subtitle={subtitle} rows={rows} previewCount={previewCount} details={details} cardActions={actions} />
  );
}

export function MobileInfoCard({
  title,
  subtitle,
  rows = [],
  previewCount = 1,
  leading,
  summary,
  details,
  cardActions,
  modalActions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  rows?: Array<{ label: string; value: ReactNode }>;
  previewCount?: number;
  leading?: ReactNode;
  summary?: ReactNode;
  details?: ReactNode;
  cardActions?: ReactNode;
  modalActions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const detailsId = useId();
  const visibleCount = Math.min(Math.max(previewCount, 0), rows.length);

  const renderedRows = showAll ? rows : rows.slice(0, visibleCount);
  return (
    <>
      <section className="mobile-info-card min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          className="flex min-h-14 w-full items-center gap-3 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          onClick={() => { setShowAll(false); setOpen((value) => !value); }}
          aria-label={`${open ? "ซ่อน" : "ดู"}ข้อมูล ${typeof title === "string" ? title : "รายการนี้"}`}
        >
          {leading && <span className="shrink-0">{leading}</span>}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold leading-5 text-text">{title}</span>
            {subtitle && <span className="mt-0.5 block truncate text-xs leading-4 text-text-muted">{subtitle}</span>}
            {summary && <span className="mt-1.5 block">{summary}</span>}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent">
            {open ? "ซ่อนข้อมูล" : "ดูข้อมูล"}
            <ChevronDown size={15} aria-hidden="true" className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          </span>
        </button>
        {cardActions && <div className="border-t border-border-subtle px-3 py-2">{cardActions}</div>}
        {open && (
          <div id={detailsId} className="mobile-info-details border-t border-border-subtle px-3 py-3">
            {renderedRows.length > 0 && (
              <dl className="divide-y divide-border-subtle">
                {renderedRows.map((row) => (
                  <div key={row.label} className="grid min-w-0 grid-cols-[minmax(5rem,0.75fr)_minmax(0,1.25fr)] gap-3 py-2.5 first:pt-0 last:pb-0">
                    <dt className="text-xs font-medium leading-5 text-text-subtle">{row.label}</dt>
                    <dd className="min-w-0 break-words text-right text-sm leading-5 text-text">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {showAll && details && <div className="mt-3 border-t border-border-subtle pt-3">{details}</div>}
            {!showAll && (rows.length > visibleCount || details) && (
              <button
                type="button"
                className="mt-3 min-h-10 w-full rounded-lg px-3 text-sm font-semibold text-accent transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => setShowAll(true)}
              >
                ข้อมูลเต็ม
              </button>
            )}
            {showAll && (rows.length > visibleCount || details) && (
              <button
                type="button"
                className="mt-3 min-h-10 w-full rounded-lg px-3 text-sm font-medium text-text-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => setShowAll(false)}
              >
                ย่อข้อมูล
              </button>
            )}
            {modalActions && <footer className="mt-3 border-t border-border-subtle pt-3">{modalActions}</footer>}
          </div>
        )}
      </section>
    </>
  );
}

export function MobileDataTable({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tables = wrapperRef.current?.querySelectorAll("table");
    if (!tables) return;
    for (const table of tables) {
      const headerRow = table.querySelector("thead tr:last-child");
      const labels = Array.from(headerRow?.querySelectorAll("th") ?? []).map((cell) => cell.textContent?.trim() ?? "");
      for (const row of table.querySelectorAll("tbody tr")) {
        Array.from(row.children).forEach((cell, index) => {
          if (cell instanceof HTMLTableCellElement && labels[index] && !cell.dataset.mobileLabel) {
            cell.dataset.mobileLabel = labels[index];
          }
        });
      }
    }
  }, [children]);

  return <div ref={wrapperRef} className={`mobile-data-table min-w-0 ${className}`}>{children}</div>;
}

export function MobileAlert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const style = toneStyles[tone];
  const Icon = style.icon;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex min-w-0 items-start gap-3 rounded-xl border p-3 ${style.className}`}>
      <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-5">{title}</p>
        {children && <div className="mt-1 text-sm leading-5">{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

export function MobileButton({
  children,
  className = "",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button className={`mobile-button min-h-12 ${className}`} {...props}>
      {children}
    </Button>
  );
}

export function MobileFormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  const errorId = `${id}-mobile-error`;
  const hintId = `${id}-mobile-hint`;
  return (
    <div className="mobile-form-field min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold text-text">{label}</label>
      {children}
      {hint && !error && <p id={hintId} className="text-xs leading-5 text-text-muted">{hint}</p>}
      {error && <p id={errorId} className="flex items-start gap-1.5 text-sm leading-5 text-error"><AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />{error}</p>}
    </div>
  );
}

export function MobileFilterPanel({
  title = "ตัวกรอง",
  selectedCount = 0,
  children,
  onApply,
  onReset,
}: {
  title?: string;
  selectedCount?: number;
  children: ReactNode;
  onApply?: () => void;
  onReset?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <section className="mobile-filter-panel rounded-xl border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-12 w-full items-center gap-2 px-4 text-left text-sm font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="flex-1">{title}</span>
        {selectedCount > 0 && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">{selectedCount} เลือก</span>}
        <ChevronDown size={17} aria-hidden="true" className={`text-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id={contentId} className="border-t border-border p-4">
          <div className="grid min-w-0 gap-3">{children}</div>
          <div className="mt-4 flex justify-end gap-2">
            {onReset && <MobileButton type="button" variant="outline" onClick={onReset}><RotateCcw size={16} />ล้าง</MobileButton>}
            {onApply && <MobileButton type="button" onClick={onApply}>ใช้ตัวกรอง</MobileButton>}
          </div>
        </div>
      )}
    </section>
  );
}

export function MobileSheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const ref = useFocusTrap<HTMLDivElement>(open);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <ModalLayer
      presentation="workspace"
      className="mobile-sheet-overlay fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      onBack={onClose}
    >
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="mobile-sheet flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold leading-6 text-text">{title}</h2>
          <button type="button" onClick={onClose} aria-label="ปิดหน้าต่าง" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="mobile-workspace-body min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="shrink-0 border-t border-border bg-surface px-4 py-3">{footer}</footer>}
      </section>
    </ModalLayer>
  );
}

export function MobileChartCard({
  title,
  summary,
  children,
  rows,
}: {
  title: string;
  summary: string;
  children: ReactNode;
  rows?: Array<{ label: string; value: string }>;
}) {
  const titleId = useId();
  return (
    <section className="mobile-chart-card p-4" aria-labelledby={titleId}>
      <h2 id={titleId} className="text-sm font-semibold text-text">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-text-muted">{summary}</p>
      <div className="mt-3 min-w-0">{children}</div>
      {rows && rows.length > 0 && (
        <ul className="mt-3 divide-y divide-border-subtle" aria-label={`${title}: ค่าข้อมูล`}>
          {rows.map((row) => <li key={row.label} className="flex items-start justify-between gap-3 py-2 text-sm"><span className="text-text-muted">{row.label}</span><span className="font-semibold tabular-nums text-text">{row.value}</span></li>)}
        </ul>
      )}
    </section>
  );
}

export function MobileEmptyState({
  title,
  description,
  action,
  mascot = false,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  mascot?: boolean;
}) {
  return (
    <div className="mobile-empty-state flex flex-col items-center px-5 py-10 text-center">
      {mascot && <Image src="/mascot/cat-girl-pixel.png" width={96} height={96} alt="" aria-hidden="true" className="mb-3 h-24 w-24 object-contain [image-rendering:pixelated]" />}
      <h2 className="text-base font-semibold text-text">{title}</h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-text-muted">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
