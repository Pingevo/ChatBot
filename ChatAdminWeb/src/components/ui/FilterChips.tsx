// FilterChips — shows active filters as removable chips.
// Helps reduce cognitive load on filter-dense pages by making active state visible.
"use client";
import { X } from "lucide-react";

export interface FilterChip {
  /** Unique key for this filter (e.g. "platform", "status") */
  key: string;
  /** Human-readable label (e.g. "แพลตฟอร์ม: Shopee") */
  label: string;
  /** Called when the chip's X is clicked; should reset this filter to default */
  onRemove: () => void;
}

interface FilterChipsProps {
  chips: FilterChip[];
  /** Optional "ล้างทั้งหมด" action; shown when there are 2+ chips */
  onClearAll?: () => void;
}

export function FilterChips({ chips, onClearAll }: FilterChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {chips.map((chip) => (
        <button
          key={chip.key}
          onClick={chip.onRemove}
          className="inline-flex items-center gap-1 h-6 px-2 text-xs rounded-full bg-brand/10 text-brand hover:bg-brand/15 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          aria-label={`ลบตัวกรอง ${chip.label}`}
        >
          <span className="truncate max-w-[160px]">{chip.label}</span>
          <X size={11} className="shrink-0" />
        </button>
      ))}
      {onClearAll && chips.length >= 2 && (
        <button
          onClick={onClearAll}
          className="inline-flex items-center h-6 px-2 text-xs text-text-muted hover:text-vibrant-coral transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded-full"
        >
          ล้างทั้งหมด
        </button>
      )}
    </div>
  );
}
