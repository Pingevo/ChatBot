// RateBox — UI ให้คะแนน bot reply แบบเดียวกันทั้ง 3 ที่
// (test-chat, shadow generate, shadow history)
//
// Layout:
//   ┌──────────────────────────────────────┐
//   │ ให้คะแนน: ★★★☆☆  4★                  │
//   │ ตอบ: [Good 👍] [Bad 👎]               │
//   │ 💬 คอมเมนต์                          │
//   │ ┌────────────────────────────────┐  │
//   │ │ textarea                       │  │
//   │ └────────────────────────────────┘  │
//   │ [บันทึก] [ยกเลิก]                    │
//   └──────────────────────────────────────┘
"use client";
import { useState, useEffect } from "react";
import { Star, MessageCircle, Save } from "lucide-react";

export interface RateBoxProps {
  starRating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
  onStar: (star: number) => void;
  onRate: (rating: "good" | "bad" | "unrated") => void;
  onComment: (comment: string) => void;
  /** compact = ขนาดเล็กสำหรับ panel แคบ */
  compact?: boolean;
}

export function RateBox({
  starRating,
  rating,
  comment,
  onStar,
  onRate,
  onComment,
  compact = false,
}: RateBoxProps) {
  const [showComment, setShowComment] = useState(false);
  const [draft, setDraft] = useState(comment || "");

  useEffect(() => { setDraft(comment || ""); }, [comment]);

  const starSize = compact ? 12 : 14;
  const padCls = compact ? "p-2 space-y-1.5" : "p-2.5 space-y-2";
  const textCls = compact ? "text-[9px]" : "text-[10px]";

  return (
    <div className={`mt-2 ${padCls} bg-surface-3/60 border border-border/60 rounded-lg`}>
      {/* Star rating row */}
      <div className="flex items-center gap-1.5">
        <span className={`${textCls} text-text-muted shrink-0`}>ให้คะแนน:</span>
        {[1, 2, 3, 4, 5].map((s) => (
          <button
            key={s}
            onClick={() => onStar(starRating === s ? 0 : s)}
            className="transition-transform hover:scale-110"
            title={`${s} ดาว`}
          >
            <Star
              size={starSize}
              className={
                (starRating ?? 0) >= s
                  ? "text-yellow-400 fill-yellow-400"
                  : "text-text-muted"
              }
            />
          </button>
        ))}
        {starRating != null && starRating > 0 && (
          <span className={`${textCls} text-yellow-500 font-medium ml-1`}>
            {starRating}★
          </span>
        )}
      </div>

      {/* Good / Bad */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`${textCls} text-text-muted shrink-0`}>ตอบ:</span>
        {([
          { rt: "good" as const, label: "Good 👍", color: "text-green-600", bg: "bg-green-50 border-green-300" },
          { rt: "bad" as const, label: "Bad 👎", color: "text-red-600", bg: "bg-red-50 border-red-300" },
        ]).map((c) => (
          <button
            key={c.rt}
            onClick={() => onRate(rating === c.rt ? "unrated" : c.rt)}
            className={`${textCls} px-2 py-0.5 rounded border transition-colors ${
              rating === c.rt
                ? `${c.bg} ${c.color} font-medium`
                : "border-border text-text-muted hover:bg-surface-2"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Comment */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className={`${textCls} text-text-muted inline-flex items-center gap-1`}>
            <MessageCircle size={10} /> คอมเมนต์
          </span>
          {comment && !showComment && (
            <button
              onClick={() => { setDraft(comment); setShowComment(true); }}
              className={`${textCls} text-brand hover:underline`}
            >
              แก้ไข
            </button>
          )}
        </div>
        {showComment ? (
          <div className="space-y-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="บอทตอบดี/ไม่ดี มีปัญหายังไง..."
              rows={compact ? 2 : 3}
              className="w-full text-xs text-text bg-surface border border-border rounded-md px-2 py-1.5 resize-y focus:outline-none focus:ring-1 focus:ring-brand"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => { onComment(draft.trim()); setShowComment(false); }}
                className={`inline-flex items-center gap-1 ${textCls} px-2 py-1 rounded-md bg-brand text-white hover:bg-brand/90`}
              >
                <Save size={10} /> บันทึก
              </button>
              <button
                onClick={() => { setDraft(comment || ""); setShowComment(false); }}
                className={`${textCls} px-2 py-1 rounded-md border border-border text-text-muted hover:bg-surface-2`}
              >
                ยกเลิก
              </button>
            </div>
          </div>
        ) : comment ? (
          <div className="text-xs text-text bg-surface border border-border rounded-md px-2 py-1.5 whitespace-pre-wrap italic">
            {comment}
          </div>
        ) : (
          <button
            onClick={() => { setDraft(""); setShowComment(true); }}
            className={`${textCls} text-text-muted hover:text-brand`}
          >
            + เพิ่มคอมเมนต์
          </button>
        )}
      </div>
    </div>
  );
}
