// Pagination — responsive page navigation
"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  maxButtons?: number;
}

export function Pagination({ page, totalPages, onChange, maxButtons = 7 }: Props) {
  if (totalPages <= 1) return null;

  const pages: (number | "...")[] = [];
  if (totalPages <= maxButtons) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    const half = Math.floor(maxButtons / 2);
    const start = Math.max(1, page - half);
    const end = Math.min(totalPages, page + half);
    if (start > 1) {
      pages.push(1);
      if (start > 2) pages.push("...");
    }
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages) {
      if (end < totalPages - 1) pages.push("...");
      pages.push(totalPages);
    }
  }

  const btnBase = "min-w-[32px] h-8 px-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center";
  const btnActive = "bg-accent text-white shadow-sm";
  const btnIdle = "bg-surface text-text-muted hover:bg-surface-2 hover:text-text border border-border";
  const btnDisabled = "bg-surface-1 text-text-subtle opacity-40 cursor-not-allowed border border-border";

  return (
    <div className="flex items-center justify-center gap-1.5 py-3">
      <button
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className={`${btnBase} ${page <= 1 ? btnDisabled : btnIdle}`}
        aria-label="ก่อนหน้า"
      >
        <ChevronLeft size={14} />
      </button>
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`e${i}`} className="text-text-subtle text-xs px-1">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={`${btnBase} ${p === page ? btnActive : btnIdle}`}
            aria-current={p === page ? "page" : undefined}
            aria-label={`หน้า ${p}${p === page ? " (หน้าปัจจุบัน)" : ""}`}
          >
            {p}
          </button>
        )
      )}
      <button
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className={`${btnBase} ${page >= totalPages ? btnDisabled : btnIdle}`}
        aria-label="ถัดไป"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
