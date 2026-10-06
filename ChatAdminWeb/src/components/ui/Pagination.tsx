// Pagination — responsive page navigation
"use client";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface Props {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  maxButtons?: number;
  showBoundaryButtons?: boolean;
  responsive?: boolean;
}

// windowed page list สำหรับ responsive clusters — numbered entries รวม ≤ maxN เสมอ
// (เลข 1/หน้าสุดท้ายนับรวมใน maxN; "..." ไม่นับ) — ต่างจาก algorithm เดิมที่ใช้กับ
// non-responsive path (default เดิมห้ามเปลี่ยน — หน้า shops/contacts/knowledge ใช้อยู่)
function windowPages(totalPages: number, page: number, maxN: number): (number | "...")[] {
  if (totalPages <= maxN) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const inner = maxN - 2;
  const half = Math.floor(inner / 2);
  let s = page - half;
  let e = s + inner - 1;
  if (s < 2) { s = 2; e = Math.min(totalPages - 1, s + inner - 1); }
  if (e > totalPages - 1) { e = totalPages - 1; s = Math.max(2, e - inner + 1); }
  const out: (number | "...")[] = [1];
  if (s > 2) out.push("...");
  for (let i = s; i <= e; i++) out.push(i);
  if (e < totalPages - 1) out.push("...");
  out.push(totalPages);
  return out;
}

export function Pagination({ page, totalPages, onChange, maxButtons = 7, showBoundaryButtons = false, responsive = false }: Props) {
  if (totalPages <= 1) return null;

  const btnBase = "min-w-[32px] h-8 px-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center"
    + (responsive ? " max-md:min-w-[40px] max-md:h-10" : "");
  const btnActive = "bg-accent text-white shadow-sm";
  const btnIdle = "bg-surface text-text-muted hover:bg-surface-2 hover:text-text border border-border";
  const btnDisabled = "bg-surface-1 text-text-subtle opacity-40 cursor-not-allowed border border-border";

  const numBtn = (p: number | "...", i: number) =>
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
    );

  // default path — algorithm เดิม (maxButtons = ขนาด window รอบ page; boundary 1/last แถม)
  const pages: (number | "...")[] = [];
  if (!responsive) {
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
  }

  return (
    <div className={`flex items-center justify-center gap-1.5 py-3 ${responsive ? "flex-wrap" : ""}`}>
      {showBoundaryButtons && (
        <button
          onClick={() => onChange(1)}
          disabled={page <= 1}
          className={`${btnBase} ${page <= 1 ? btnDisabled : btnIdle}`}
          aria-label="หน้าแรก"
          title="หน้าแรก"
        >
          <ChevronsLeft size={14} />
        </button>
      )}
      <button
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className={`${btnBase} ${page <= 1 ? btnDisabled : btnIdle}`}
        aria-label="ก่อนหน้า"
        title="ก่อนหน้า"
      >
        <ChevronLeft size={14} />
      </button>
      {responsive ? (
        <>
          {/* numbered clusters — CSS สลับตามขนาดจอ ไม่ใช้ JS listener
              phone <md ≤3 · tablet md–lg ≤5 · desktop lg+ ≤maxButtons */}
          <span className="flex md:hidden items-center gap-1.5">
            {windowPages(totalPages, page, 3).map(numBtn)}
          </span>
          <span className="hidden md:flex lg:hidden items-center gap-1.5">
            {windowPages(totalPages, page, 5).map(numBtn)}
          </span>
          <span className="hidden lg:flex items-center gap-1.5">
            {windowPages(totalPages, page, maxButtons).map(numBtn)}
          </span>
        </>
      ) : (
        pages.map(numBtn)
      )}
      <button
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className={`${btnBase} ${page >= totalPages ? btnDisabled : btnIdle}`}
        aria-label="ถัดไป"
        title="ถัดไป"
      >
        <ChevronRight size={14} />
      </button>
      {showBoundaryButtons && (
        <button
          onClick={() => onChange(totalPages)}
          disabled={page >= totalPages}
          className={`${btnBase} ${page >= totalPages ? btnDisabled : btnIdle}`}
          aria-label="หน้าสุดท้าย"
          title="หน้าสุดท้าย"
        >
          <ChevronsRight size={14} />
        </button>
      )}
    </div>
  );
}
