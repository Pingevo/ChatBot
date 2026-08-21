"use client";
// CloseChatModal — modal สำหรับปิดแชท บังคับกรอก reason/category/resolution/note
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";
import type { Conversation, ProblemCategory } from "@/lib/types";

const CATEGORIES: { value: ProblemCategory; label: string }[] = [
  { value: "shipping", label: "การจัดส่ง" },
  { value: "product", label: "สินค้า" },
  { value: "payment", label: "การชำระเงิน" },
  { value: "return_refund", label: "คืนสินค้า/คืนเงิน" },
  { value: "warranty", label: "รับประกัน" },
  { value: "account", label: "บัญชี/ล็อกอิน" },
  { value: "promotion", label: "โปรโมชั่น/ส่วนลด" },
  { value: "other", label: "อื่นๆ" },
];

interface Props {
  conversation: Conversation;
  onClose: () => void;
  onSubmit: (data: { reason: string; category: ProblemCategory; resolution: string; note?: string }) => void;
  loading: boolean;
}

export function CloseChatModal({ conversation, onClose, onSubmit, loading }: Props) {
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<ProblemCategory | "">("");
  const [resolution, setResolution] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  const canSubmit = reason.trim() && category && resolution.trim();

  function handleSubmit() {
    setTouched(true);
    if (!canSubmit) return;
    onSubmit({
      reason: reason.trim(),
      category: category as ProblemCategory,
      resolution: resolution.trim(),
      note: note.trim() || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-surface z-10">
          <div>
            <h2 className="text-base font-semibold text-text">ปิดแชท</h2>
            <p className="text-xs text-text-muted mt-0.5">{conversation.customer_name} — {conversation.shop_name}</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* เหตุผล */}
          <div>
            <label className="block text-sm font-medium text-text mb-1.5">
              เหตุผลที่ปิดแชท <span className="text-vibrant-coral">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="เช่น แจ้งเลขพัสดุแล้ว ลูกค้าได้รับสินค้าแล้ว"
              rows={2}
              className={`w-full rounded-lg border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30 ${
                touched && !reason.trim() ? "border-vibrant-coral" : "border-border"
              }`}
            />
            {touched && !reason.trim() && (
              <p className="text-xs text-vibrant-coral mt-1">กรุณาระบุเหตุผล</p>
            )}
          </div>

          {/* ประเภทปัญหา */}
          <div>
            <label className="block text-sm font-medium text-text mb-1.5">
              ประเภทปัญหา <span className="text-vibrant-coral">*</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setCategory(c.value)}
                  className={`h-9 rounded-lg border text-sm transition-colors ${
                    category === c.value
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border text-text-muted hover:border-brand/40"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {touched && !category && (
              <p className="text-xs text-vibrant-coral mt-1">กรุณาเลือกประเภทปัญหา</p>
            )}
          </div>

          {/* วิธีการแก้ไข */}
          <div>
            <label className="block text-sm font-medium text-text mb-1.5">
              วิธีการแก้ไข <span className="text-vibrant-coral">*</span>
            </label>
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="เช่น ตรวจสอบกับทางขนส่งแล้ว พัสดุอยู่ระหว่างจัดส่ง"
              rows={3}
              className={`w-full rounded-lg border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30 ${
                touched && !resolution.trim() ? "border-vibrant-coral" : "border-border"
              }`}
            />
            {touched && !resolution.trim() && (
              <p className="text-xs text-vibrant-coral mt-1">กรุณาระบุวิธีการแก้ไข</p>
            )}
          </div>

          {/* หมายเหตุ */}
          <div>
            <label className="block text-sm font-medium text-text mb-1.5">
              หมายเหตุ <span className="text-text-subtle font-normal">(ไม่บังคับ)</span>
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="ข้อมูลเพิ่มเติมที่ต้องการบันทึก"
              rows={2}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>

          <div className="bg-pale-sky-soft rounded-lg px-3 py-2 text-xs text-text-muted">
            ข้อมูลที่กรอกจะถูกบันทึกเป็นประวัติ — แอดมินคนถัดไปจะเห็นเมื่อลูกค้าทักกลับมา
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="ghost" className="flex-1" onClick={onClose} disabled={loading}>
              ยกเลิก
            </Button>
            <Button className="flex-1" onClick={handleSubmit} disabled={loading || !canSubmit}>
              {loading ? <Loading size={16} /> : "ปิดแชท"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
