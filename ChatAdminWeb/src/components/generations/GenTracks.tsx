"use client";
// Fleet view — 4 หลอด (3 daily + 1 weekly ล่าสุด) หลอดละสีตามสถานะ
// แมว pixel อยู่ที่ตำแหน่ง progress ของแต่ละ gen (เดิน = building, ยืนสุดหลอด = เสร็จ)
import React from "react";
import { PixelCat } from "./BuildProgressCat";

type Run = {
  _id: string; build_kind?: string; status: string;
  current_step?: string;
  steps?: Record<string, { status: string; percent?: number | null } | null>;
};

const SLOT_ORDER = 9; // จำนวน step ใน pipeline (สำหรับ overall%)

const TUBE: Record<string, { bar: string; label: string }> = {
  active:    { bar: "bg-gradient-to-r from-emerald-400 to-emerald-500", label: "ใช้งานอยู่" },
  published: { bar: "bg-gradient-to-r from-green-400 to-green-500",     label: "เสร็จ/พร้อม" },
  building:  { bar: "bg-gradient-to-r from-blue-400 to-sky-500",        label: "กำลัง build" },
  pending:   { bar: "bg-gradient-to-r from-amber-300 to-amber-500",     label: "รอ accept" },
  failed:    { bar: "bg-gradient-to-r from-red-400 to-red-600",         label: "พัง" },
  discarded: { bar: "bg-gradient-to-r from-gray-300 to-gray-400",       label: "ถูกทิ้ง" },
  empty:     { bar: "", label: "ช่องว่าง" },
};

function overall(run: Run): number {
  if (run.status !== "building") return 100;
  const steps = run.steps || {};
  const keys = Object.keys(steps);
  if (!keys.length) return 0;
  return Math.round(keys.reduce((a, s) =>
    a + (steps[s]?.status === "done" ? 100 : (steps[s]?.percent ?? 0)), 0)
    / SLOT_ORDER);
}

function Lane({ run, active, slot }: {
  run?: Run; active?: string; slot: "daily" | "weekly";
}) {
  const status = !run ? "empty"
    : active === run._id ? "active" : run.status;
  const t = TUBE[status] || TUBE.discarded;
  const pct = run ? Math.min(100, Math.max(4, overall(run))) : 0;
  const building = run?.status === "building";
  return (
    <div className="flex items-center gap-2">
      <span className={`w-14 text-[10px] text-right shrink-0 ${
        slot === "weekly" ? "text-violet-500 font-semibold" : "text-muted"}`}>
        {slot === "weekly" ? "weekly" : "daily"}
      </span>
      <div className="relative flex-1 h-8">
        {/* หลอด */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-3 rounded-full bg-border/40 overflow-hidden">
          {run && (
            <div className={`h-full rounded-full ${t.bar} ${
                  building ? "animate-pulse" : ""} transition-all duration-700`}
                 style={{ width: `${pct}%` }} />
          )}
        </div>
        {/* แมวอยู่ตำแหน่ง progress */}
        {run && (
          <div className="absolute -top-1 transition-all duration-700 ease-in-out"
               style={{ left: `clamp(0px, calc(${pct}% - 32px), calc(100% - 64px))` }}>
            <PixelCat walking={!!building} />
          </div>
        )}
      </div>
      <div className="w-52 shrink-0 text-[10px] text-muted truncate">
        {run
          ? <><code className="text-text">{run._id.slice(1, 16)}</code> · {t.label}
             {building && ` ${pct}%`}</>
          : "—"}
      </div>
    </div>
  );
}

/** 4 หลอด: daily ×3 + weekly ×1 ล่าสุด (เรียงใหม่สุดก่อน) */
export function GenTracks({ runs, active }: { runs: Run[]; active?: string }) {
  const sorted = [...runs].sort((a, b) =>
    (b._id || "").localeCompare(a._id || ""));
  const dailies = sorted.filter((r) => r.build_kind !== "weekly").slice(0, 3);
  const weeklies = sorted.filter((r) => r.build_kind === "weekly").slice(0, 1);
  const dailySlots: (Run | undefined)[] = [...dailies];
  while (dailySlots.length < 3) dailySlots.push(undefined);
  const weeklySlot = weeklies[0];
  return (
    <div className="border border-border rounded-xl p-3 bg-surface space-y-1.5">
      {dailySlots.map((r, i) => (
        <Lane key={r?._id || `d${i}`} run={r} active={active} slot="daily" />
      ))}
      <Lane run={weeklySlot} active={active} slot="weekly" />
    </div>
  );
}
