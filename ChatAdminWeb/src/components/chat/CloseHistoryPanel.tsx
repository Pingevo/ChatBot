"use client";
// CloseHistoryPanel — แสดงประวัติการปิด/เปิดแชท ทางขวาของหน้า tickets
import { History, RotateCcw, CheckCircle2, MessageSquare } from "lucide-react";
import type { CloseHistoryRecord, ProblemCategory } from "@/lib/types";

const CATEGORY_LABELS: Record<ProblemCategory, string> = {
  shipping: "การจัดส่ง",
  product: "สินค้า",
  payment: "การชำระเงิน",
  return_refund: "คืนสินค้า/คืนเงิน",
  warranty: "รับประกัน",
  account: "บัญชี/ล็อกอิน",
  promotion: "โปรโมชั่น/ส่วนลด",
  other: "อื่นๆ",
};

interface Props {
  history: CloseHistoryRecord[];
}

export function CloseHistoryPanel({ history }: Props) {
  if (history.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-surface-2 flex items-center justify-center mb-3">
          <History size={20} className="text-text-subtle" />
        </div>
        <p className="text-sm font-medium text-text">ยังไม่มีประวัติปิดแชท</p>
        <p className="text-xs text-text-muted mt-1">
          เมื่อแอดมินปิดแชท ประวัติจะแสดงที่นี่
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <History size={16} className="text-text-muted" />
        <h3 className="text-sm font-semibold text-text">
          ประวัติปิด/เปิดแชท ({history.length})
        </h3>
      </div>

      {history.map((rec, idx) => {
        const isReopened = !!rec.reopened_at;
        const isLatest = idx === 0;
        return (
          <div
            key={rec.record_id}
            className={`rounded-xl border p-3.5 space-y-2.5 ${
              isLatest
                ? "border-brand/30 bg-brand/5"
                : "border-border bg-surface"
            }`}
          >
            {/* Header — sequence + status badge */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-surface-2 text-text-muted">
                  ครั้งที่ {rec.sequence}
                </span>
                {isReopened ? (
                  <span className="inline-flex items-center gap-1 text-xs text-deep-space">
                    <RotateCcw size={11} /> เปิดใหม่แล้ว
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                    <CheckCircle2 size={11} /> ปิดอยู่
                  </span>
                )}
              </div>
              <span className="text-[11px] text-text-subtle">
                {new Date(rec.closed_at).toLocaleString("th-TH", {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            </div>

            {/* Category */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">ประเภท:</span>
              <span className="text-xs font-medium px-2 py-0.5 rounded bg-pale-sky-soft text-deep-space">
                {CATEGORY_LABELS[rec.category] || rec.category}
              </span>
            </div>

            {/* Reason */}
            <div>
              <div className="text-xs text-text-muted mb-0.5">เหตุผล</div>
              <div className="text-sm text-text">{rec.reason}</div>
            </div>

            {/* Resolution */}
            <div>
              <div className="text-xs text-text-muted mb-0.5">วิธีการแก้ไข</div>
              <div className="text-sm text-text">{rec.resolution}</div>
            </div>

            {/* Note */}
            {rec.note && (
              <div>
                <div className="text-xs text-text-muted mb-0.5">หมายเหตุ</div>
                <div className="text-sm text-text-muted italic">{rec.note}</div>
              </div>
            )}

            {/* Reopen info */}
            {isReopened && (
              <div className="pt-2 border-t border-border/60 flex items-start gap-2">
                <MessageSquare size={12} className="text-brand mt-0.5 shrink-0" />
                <div className="text-xs">
                  <span className="text-text-muted">เปิดใหม่โดย </span>
                  <span className="font-medium text-text">
                    {rec.reopened_by === "bot" ? "บอท (ส่งต่อแอดมิน)" : rec.reopened_by}
                  </span>
                  <span className="text-text-subtle">
                    {" · "}
                    {new Date(rec.reopened_at!).toLocaleString("th-TH", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </span>
                  {rec.reopen_reason && (
                    <div className="text-text-muted mt-0.5">{rec.reopen_reason}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
