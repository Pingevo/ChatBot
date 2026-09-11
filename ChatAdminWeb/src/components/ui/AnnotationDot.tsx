"use client";
// AnnotationDot — วงกลมสี + note popup สำหรับ mark แชทใน inbox
//
// ⚡ Phase 3B-1
//
// Layout:
//   [●]  ← วงกลมสี (ถ้ามี annotation)
//   คลิก → popup เลือกสี + โน้ต + บันทึก/ลบ
//
// ใช้ใน: test-assignment inbox, shadow-bot inbox
import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/ui/Toast";
import { useToastError } from "@/components/ui/Toast";
import { Check, Trash2, X } from "lucide-react";

export interface Annotation {
  annotation_id: string;
  scope: "test_assignment" | "shadow_bot";
  conversation_id: string;
  color: string;
  note: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  generation_batch_id?: string;  // ⚡ Phase 3B-6 — ผูกกับรอบ generate (shadow_bot)
}

const COLORS: { key: string; label: string; hex: string }[] = [
  { key: "red", label: "เคสเสีย", hex: "#ef4444" },
  { key: "yellow", label: "ระวัง", hex: "#eab308" },
  { key: "green", label: "ผ่าน", hex: "#22c55e" },
  { key: "blue", label: "ดูเพิ่ม", hex: "#3b82f6" },
  { key: "purple", label: "พิเศษ", hex: "#a855f7" },
  { key: "orange", label: "ติดตาม", hex: "#f97316" },
  { key: "pink", label: "สงสัย", hex: "#ec4899" },
  { key: "gray", label: "ทั่วไป", hex: "#6b7280" },
];

const colorHexMap = new Map(COLORS.map((c) => [c.key, c.hex]));

interface Props {
  scope: "test_assignment" | "shadow_bot";
  conversationId: string;
  annotation?: Annotation;
  onChange: () => void;  // callback ให้ parent reload annotations
  size?: number;
  generationBatchId?: string;  // ⚡ Phase 3B-6 — ผูกกับรอบ generate (shadow_bot) ต่างรอบต่าง mark
}

export function AnnotationDot({ scope, conversationId, annotation, onChange, size = 12, generationBatchId }: Props) {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState(annotation?.color || "");
  const [note, setNote] = useState(annotation?.note || "");
  const [saving, setSaving] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const { catchError } = useToastError();

  // sync state เมื่อ annotation เปลี่ยน
  useEffect(() => {
    setColor(annotation?.color || "");
    setNote(annotation?.note || "");
  }, [annotation?.annotation_id, annotation?.color, annotation?.note]);

  // ปิด popup เมื่อคลิกนอก
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  async function handleSave() {
    if (!color) {
      toast.error("เลือกสีก่อน");
      return;
    }
    setSaving(true);
    try {
      await api().post("/chat-annotations", {
        scope,
        conversation_id: conversationId,
        color,
        note: note.trim(),
        ...(generationBatchId ? { generation_batch_id: generationBatchId } : {}),
      });
      toast.success("บันทึก markup แล้ว");
      setOpen(false);
      onChange();
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!annotation?.annotation_id) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await api().delete(`/chat-annotations/${annotation.annotation_id}`);
      toast.success("ลบ markup แล้ว");
      setOpen(false);
      onChange();
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  const currentHex = annotation ? colorHexMap.get(annotation.color) : null;

  return (
    <div className="relative" ref={popupRef}>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            setOpen(!open);
          }
        }}
        title={annotation?.note || "เพิ่ม markup"}
        className="transition-transform hover:scale-125 cursor-pointer inline-flex"
      >
        {currentHex ? (
          <span
            className="inline-block rounded-full border border-white/30 shadow-sm"
            style={{ width: size, height: size, backgroundColor: currentHex }}
          />
        ) : (
          <span
            className="inline-block rounded-full border border-border bg-surface-2"
            style={{ width: size, height: size }}
          />
        )}
      </span>

      {open && (
        <div
          className="absolute z-50 right-0 top-full mt-1 w-64 bg-surface border border-border rounded-lg shadow-lg p-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-text">Mark แชท</span>
            <button
              onClick={() => setOpen(false)}
              title="ปิด" aria-label="ปิด"
              className="text-text-muted hover:text-text"
            >
              <X size={14} />
            </button>
          </div>

          {/* Color picker */}
          <div className="grid grid-cols-4 gap-1.5 mb-2">
            {COLORS.map((c) => (
              <button
                key={c.key}
                onClick={() => setColor(c.key)}
                title={c.label}
                className={`flex flex-col items-center gap-0.5 p-1 rounded transition-colors ${
                  color === c.key ? "bg-surface-2 ring-1 ring-brand" : "hover:bg-surface-2"
                }`}
              >
                <span
                  className="inline-block rounded-full border border-black/10"
                  style={{ width: 14, height: 14, backgroundColor: c.hex }}
                />
                <span className="text-[9px] text-text-muted">{c.label}</span>
              </button>
            ))}
          </div>

          {/* Note */}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="เคสที่เจอ เช่น บอทตอบผิดรุ่น, วนลูป, ส่งต่อแอดมินผิดจังหวะ..."
            rows={3}
            className="w-full text-xs text-text bg-surface border border-border rounded-md px-2 py-1.5 resize-y focus:outline-none focus:ring-1 focus:ring-brand mb-2"
            autoFocus
          />

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !color}
              className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded-md bg-brand text-white hover:bg-brand/90 disabled:opacity-50"
            >
              <Check size={12} /> {annotation ? "อัปเดต" : "บันทึก"}
            </button>
            {annotation && (
              <button
                onClick={handleDelete}
                disabled={saving}
                className="inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded-md border border-error/30 text-error hover:bg-error/5 disabled:opacity-50"
                title="ลบ markup"
                aria-label="ลบ markup"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
