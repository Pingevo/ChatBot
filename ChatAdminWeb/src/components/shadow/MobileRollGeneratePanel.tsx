"use client";

import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  Clock3,
  Minus,
  Plus,
  Sparkles,
  Zap,
} from "lucide-react";
import type { Platform } from "@/lib/types";
import styles from "./MobileRollGeneratePanel.module.css";

type RollPlatform = Platform | "all";
type RollOrder = "recent" | "oldest";
type RollMode = "overwrite" | "resume";
type RollProgress = { done: number; total: number; success: number; skipped: number; errors: number };

interface Props {
  count: string;
  onCountChange: (value: string) => void;
  order: RollOrder;
  onOrderChange: (value: RollOrder) => void;
  mode: RollMode;
  onModeChange: (value: RollMode) => void;
  platform: RollPlatform;
  onPlatformChange: (value: RollPlatform) => void;
  progress: RollProgress | null;
  rolling: boolean;
  onStart: () => void;
}

const platformOptions: { value: RollPlatform; label: string }[] = [
  { value: "all", label: "ทุกแพลตฟอร์ม" },
  { value: "shopee", label: "Shopee" },
  { value: "tiktok", label: "TikTok" },
  { value: "lazada", label: "Lazada" },
];

export function MobileRollGeneratePanel({
  count,
  onCountChange,
  order,
  onOrderChange,
  mode,
  onModeChange,
  platform,
  onPlatformChange,
  progress,
  rolling,
  onStart,
}: Props) {
  const countLabel = count || "0";
  const platformLabel = platformOptions.find((item) => item.value === platform)?.label ?? "ทุกแพลตฟอร์ม";
  const orderLabel = order === "recent" ? "ใหม่ก่อน" : "เก่าก่อน";
  const modeLabel = mode === "overwrite" ? "ทำใหม่ทับ" : "ข้ามรายการเดิม";
  const progressPercent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <section className={`${styles.shell} flex min-h-0 flex-1 flex-col md:hidden`} aria-labelledby="mobile-roll-title">
      <div className={`${styles.scrollArea} min-h-0 flex-1 overflow-y-auto overscroll-contain`}>
        <header className={`${styles.hero} relative overflow-hidden px-4 pb-4 pt-5`}>
          <span className={styles.ambientGlow} aria-hidden="true" />
          <div className="relative flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-brand">
                <span className={styles.liveDot} aria-hidden="true" />
                Shadow bot <span className="text-text-subtle">/</span> batch
              </div>
              <h2 id="mobile-roll-title" className="text-[19px] font-semibold leading-tight tracking-[-0.025em] text-text">
                Generate หลายแชท
              </h2>
              <p className="mt-1 max-w-[34ch] text-[12px] leading-[1.55] text-text-muted">
                เลือกขอบเขต แล้วให้บอทสร้างคำตอบเป็นชุด
              </p>
            </div>
            <span className="mt-1 inline-flex shrink-0 items-center gap-1 rounded-full border border-brand/15 bg-brand/5 px-2.5 py-1.5 text-[10px] font-medium text-brand">
              <Sparkles size={12} aria-hidden="true" />
              ไม่ส่งจริง
            </span>
          </div>
        </header>

        <div className="space-y-3 px-4 pb-4">
          <section className={`${styles.fieldGroup} rounded-2xl border border-border bg-surface p-3.5`} aria-labelledby="mobile-roll-platform-label">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 id="mobile-roll-platform-label" className="text-[12px] font-semibold text-text">แพลตฟอร์ม</h3>
              <span className="text-[10px] text-text-subtle">01</span>
            </div>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="เลือกแพลตฟอร์ม">
              {platformOptions.map((item) => {
                const selected = platform === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onPlatformChange(item.value)}
                    className={`${styles.choice} flex min-h-11 items-center justify-between gap-2 rounded-xl border px-3 text-left text-[12px] font-medium ${
                      selected
                        ? `${styles.selectedChoice} border-brand/35 bg-brand/5 text-brand`
                        : "border-border bg-surface text-text-muted"
                    }`}
                  >
                    <span className="truncate">{item.label}</span>
                    {selected ? <Check size={15} className="shrink-0" aria-hidden="true" /> : <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </section>

          <section className={`${styles.fieldGroup} rounded-2xl border border-border bg-surface p-3.5`} aria-labelledby="mobile-roll-count-label">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 id="mobile-roll-count-label" className="text-[12px] font-semibold text-text">จำนวนแชท</h3>
              <span className="text-[10px] text-text-subtle">02</span>
            </div>
            <div className="flex min-h-[54px] items-center rounded-xl border border-border bg-surface-1 p-1 focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/20">
              <button
                type="button"
                disabled={Number.parseInt(count, 10) <= 1}
                onClick={() => {
                  const current = Number.parseInt(count, 10);
                  onCountChange(String(Math.max(1, (Number.isFinite(current) ? current : 1) - 1)));
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 active:scale-95 disabled:opacity-40"
                aria-label="ลดจำนวนแชท"
              >
                <Minus size={16} />
              </button>
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                inputMode="numeric"
                value={count}
                onChange={(event) => onCountChange(event.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent text-center text-[20px] font-semibold tabular-nums text-text outline-none focus:ring-0"
                aria-label="จำนวนแชทที่ต้องการ Generate"
                placeholder="10"
              />
              <button
                type="button"
                disabled={Number.parseInt(count, 10) >= 1000}
                onClick={() => {
                  const current = Number.parseInt(count, 10);
                  onCountChange(String(Math.min(1000, (Number.isFinite(current) ? current : 0) + 1)));
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 active:scale-95 disabled:opacity-40"
                aria-label="เพิ่มจำนวนแชท"
              >
                <Plus size={16} />
              </button>
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-text-subtle">เลือกได้สูงสุด 1,000 แชท</p>
          </section>

          <section className={`${styles.fieldGroup} rounded-2xl border border-border bg-surface p-3.5`} aria-labelledby="mobile-roll-order-label">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 id="mobile-roll-order-label" className="text-[12px] font-semibold text-text">เริ่มจากแชทไหน</h3>
              <span className="text-[10px] text-text-subtle">03</span>
            </div>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="เรียงลำดับแชท">
              <button
                type="button"
                aria-pressed={order === "recent"}
                onClick={() => onOrderChange("recent")}
                className={`${styles.choice} ${order === "recent" ? styles.selectedChoice : ""} flex min-h-[58px] items-center gap-2 rounded-xl border px-3 text-left ${order === "recent" ? "border-brand/35 bg-brand/5 text-brand" : "border-border bg-surface text-text-muted"}`}
              >
                <Clock3 size={16} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0"><span className="block text-[12px] font-semibold">ใหม่สุดก่อน</span><span className="mt-0.5 block text-[10px] opacity-75">เริ่มจากรายการใหม่</span></span>
              </button>
              <button
                type="button"
                aria-pressed={order === "oldest"}
                onClick={() => onOrderChange("oldest")}
                className={`${styles.choice} ${order === "oldest" ? styles.selectedChoice : ""} flex min-h-[58px] items-center gap-2 rounded-xl border px-3 text-left ${order === "oldest" ? "border-brand/35 bg-brand/5 text-brand" : "border-border bg-surface text-text-muted"}`}
              >
                <ArrowUpNarrowWide size={16} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0"><span className="block text-[12px] font-semibold">เก่าสุดก่อน</span><span className="mt-0.5 block text-[10px] opacity-75">เริ่มจากรายการเก่า</span></span>
              </button>
            </div>
          </section>

          <section className={`${styles.fieldGroup} rounded-2xl border border-border bg-surface p-3.5`} aria-labelledby="mobile-roll-mode-label">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 id="mobile-roll-mode-label" className="text-[12px] font-semibold text-text">จัดการคำตอบเดิม</h3>
              <span className="text-[10px] text-text-subtle">04</span>
            </div>
            <div className="space-y-2" role="group" aria-label="เลือกวิธีจัดการคำตอบที่มีอยู่">
              <button
                type="button"
                aria-pressed={mode === "overwrite"}
                onClick={() => onModeChange("overwrite")}
                className={`${styles.choice} ${mode === "overwrite" ? styles.selectedChoice : ""} flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border px-3 text-left ${mode === "overwrite" ? "border-brand/35 bg-brand/5 text-brand" : "border-border bg-surface text-text"}`}
              >
                <span><span className="block text-[12px] font-semibold">ทำใหม่ทับ</span><span className="mt-0.5 block text-[10px] leading-4 text-text-muted">Generate ใหม่ทุกแชทที่เลือก</span></span>
                {mode === "overwrite" ? <Check size={16} className="shrink-0" aria-hidden="true" /> : <span className="h-4 w-4 shrink-0 rounded-full border border-border" aria-hidden="true" />}
              </button>
              <button
                type="button"
                aria-pressed={mode === "resume"}
                onClick={() => onModeChange("resume")}
                className={`${styles.choice} ${mode === "resume" ? styles.selectedChoice : ""} flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border px-3 text-left ${mode === "resume" ? "border-brand/35 bg-brand/5 text-brand" : "border-border bg-surface text-text"}`}
              >
                <span><span className="block text-[12px] font-semibold">ข้ามรายการเดิม</span><span className="mt-0.5 block text-[10px] leading-4 text-text-muted">ข้ามแชทที่ Generate ไว้แล้ว</span></span>
                {mode === "resume" ? <Check size={16} className="shrink-0" aria-hidden="true" /> : <span className="h-4 w-4 shrink-0 rounded-full border border-border" aria-hidden="true" />}
              </button>
            </div>
          </section>

          <section className={`${styles.summary} rounded-2xl border border-brand/15 px-3.5 py-3`} aria-label="สรุปการตั้งค่า">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand">
              <ArrowDownWideNarrow size={13} aria-hidden="true" />
              สรุปงาน
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] font-medium leading-5 text-text">
              <span>{countLabel} แชท</span><span className="text-text-subtle">·</span><span>{platformLabel}</span><span className="text-text-subtle">·</span><span>{orderLabel}</span><span className="text-text-subtle">·</span><span>{modeLabel}</span>
            </p>
          </section>

          <details className={`${styles.help} rounded-xl px-1 py-1`}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium text-text-muted [&::-webkit-details-marker]:hidden">
              <span>ดูวิธีทำงาน</span>
              <ChevronDown size={14} className={styles.helpChevron} aria-hidden="true" />
            </summary>
            <div className="space-y-1.5 pb-2 pr-2 text-[11px] leading-[1.6] text-text-muted">
              <p><strong className="font-semibold text-text">ทำใหม่ทับ:</strong> Generate ใหม่โดยไม่สนว่ามีคนทำแชทนั้นไว้แล้วหรือไม่</p>
              <p><strong className="font-semibold text-text">ข้ามรายการเดิม:</strong> ข้ามแชทที่มีผล Generate ทั้งแชทแล้วไปทำแชทถัดไปจนครบจำนวน</p>
              <p>ผลลัพธ์จะอยู่ใน History และไม่ส่งข้อความถึงลูกค้า</p>
            </div>
          </details>
        </div>
      </div>

      <footer className={`${styles.actionBar} shrink-0 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-2.5`}>
        {rolling && progress && (
          <div className="mb-2.5" role="status" aria-live="polite">
            <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-text-muted">
              <span>กำลังสร้าง {progress.done}/{progress.total} แชท</span>
              <span className="tabular-nums">สำเร็จ {progress.success} · ข้าม {progress.skipped} · ผิดพลาด {progress.errors}</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-label="ความคืบหน้า Generate"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onStart}
          disabled={rolling}
          className={`${styles.startButton} flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 text-[13px] font-semibold text-white shadow-sm transition-all hover:bg-brand-dark active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-75`}
        >
          <Zap size={16} aria-hidden="true" />
          {rolling ? "กำลัง Generate…" : `Roll Generate · ${countLabel} แชท`}
        </button>
      </footer>
    </section>
  );
}
