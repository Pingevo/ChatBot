// Shared components for the Zaapi-style analytics pages (ข้อมูลสด,
// ภาพรวม Performance, การทำงานของแอดมิน).
"use client";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, LineChart, Line } from "recharts";
import { DebouncedResponsiveContainer as ResponsiveContainer } from "./DebouncedResponsiveContainer";
import { Info, RefreshCw } from "lucide-react";
import type { Platform } from "@/lib/types";

/* ---- Connected channels header (platform icons + live status + refresh) ---- */

const platformDots: Record<Platform, string> = {
  shopee: "#ee4d2d",
  tiktok: "#111827",
  lazada: "#1a2e8c",
};

export function ConnectedChannelsHeader({
  connectedCount,
  live = false,
  lastUpdatedSeconds,
  onRefresh,
}: {
  connectedCount: number;
  live?: boolean;
  lastUpdatedSeconds?: number;
  onRefresh?: () => void;
}) {
  const platforms: Platform[] = ["shopee", "tiktok", "lazada"];
  return (
    <div className="flex items-center justify-between flex-wrap gap-3 py-3">
      <div className="flex items-center gap-2">
        <div className="flex -space-x-1.5">
          {platforms.map((p) => (
            <div
              key={p}
              className="w-6 h-6 rounded-full border-2 border-surface flex items-center justify-center text-white text-[9px] font-bold"
              style={{ background: platformDots[p] }}
              title={p}
            >
              {p[0].toUpperCase()}
            </div>
          ))}
        </div>
        <span className="text-sm text-text-muted">{connectedCount} บัญชีที่เชื่อมต่อ</span>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {live && (
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-soft" />
            สด
            {lastUpdatedSeconds !== undefined && <span>· อัปเดตล่าสุด {lastUpdatedSeconds} วินาทีที่แล้ว</span>}
          </div>
        )}
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="w-8 h-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-text-muted transition-colors"
            title="รีเฟรช"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ---- Tiny info tooltip icon (visual only) ---- */
export function InfoHint({ label }: { label?: string }) {
  return <Info size={12} className="text-text-subtle inline-block ml-1" aria-label={label} />;
}

/* ---- Sparkline — tiny trend chart for KPI cards ---- */
export function Sparkline({ data, dataKey, color = "#8b1e28" }: { data: Record<string, unknown>[]; dataKey: string; color?: string }) {
  return (
    <ResponsiveContainer width="100%" height={40}>
      <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`spark-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#spark-${dataKey})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ---- KPI card with delta badge + sparkline ---- */
export function KpiCard({
  title,
  value,
  deltaPct,
  sparklineData,
  sparklineKey = "value",
  compareLabel = "7 วันที่แล้ว - 7 วันก่อนหน้า",
  color = "#8b1e28",
}: {
  title: string;
  value: string;
  deltaPct?: number;
  sparklineData?: Record<string, unknown>[];
  sparklineKey?: string;
  compareLabel?: string;
  color?: string;
}) {
  const positive = (deltaPct ?? 0) >= 0;
  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-text-muted">{title}</span>
        <Info size={12} className="text-text-subtle" />
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-xl font-bold text-text">{value}</span>
        {deltaPct !== undefined && (
          <span className={`text-xs font-medium ${positive ? "text-emerald-600" : "text-vibrant-coral"}`}>
            {positive ? "+" : ""}
            {deltaPct.toFixed(2)}%
          </span>
        )}
      </div>
      {sparklineData && sparklineData.length > 0 && (
        <>
          <Sparkline data={sparklineData} dataKey={sparklineKey} color={color} />
          <div className="text-[10px] text-text-subtle mt-1">{compareLabel}</div>
        </>
      )}
    </div>
  );
}

/* ---- Donut with center label ---- */
import { PieChart, Pie, Cell } from "recharts";
import { memo } from "react";

// Smooth ease-out cubic for the entry sweep animation.
const EASE_OUT_CUBIC = "cubic-bezier(0.22, 1, 0.36, 1)";

function DonutCenterChartImpl({
  data,
  centerLabel,
  colors,
}: {
  data: { name: string; value: number }[];
  centerLabel: string;
  colors: string[];
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: 140, height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={42}
              outerRadius={62}
              paddingAngle={2}
              isAnimationActive
              animationDuration={900}
              animationEasing={EASE_OUT_CUBIC}
              animationBegin={0}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={colors[i % colors.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-lg font-bold text-text">{total}</span>
        </div>
      </div>
      <div className="space-y-1.5 flex-1 min-w-0">
        <div className="text-xs text-text-subtle mb-1">{centerLabel}</div>
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colors[i % colors.length] }} />
            <span className="text-text truncate flex-1">{d.name}</span>
            <span className="text-text-muted shrink-0">
              {d.value} {total ? Math.round((d.value / total) * 100) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Memoized so parent re-renders (e.g. the 1s "seconds ago" tick on the live
// stats page) do NOT retrigger the pie's entry animation, which was the cause
// of the stutter while spinning.
export const DonutCenterChart = memo(DonutCenterChartImpl);

/* ---- Stacked bar by channel (daily) ---- */
export function StackedChannelBarChart({
  data,
  seriesKeys,
  colors,
}: {
  data: Record<string, unknown>[];
  seriesKeys: string[];
  colors: string[];
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: "#98a2b3" }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e3e6eb", fontSize: 12 }} />
        {seriesKeys.map((k, i) => (
          <Bar key={k} dataKey={k} stackId="a" fill={colors[i % colors.length]} radius={i === seriesKeys.length - 1 ? [4, 4, 0, 0] : undefined} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---- Multi-line chart per channel ---- */
export function MultiLineChart({
  data,
  seriesKeys,
  colors,
  unit = "",
}: {
  data: Record<string, unknown>[];
  seriesKeys: string[];
  colors: string[];
  unit?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <Tooltip formatter={(v) => [`${v ?? 0}${unit}`, ""]} contentStyle={{ borderRadius: 8, border: "1px solid #e3e6eb", fontSize: 12 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {seriesKeys.map((k, i) => (
          <Line key={k} type="monotone" dataKey={k} stroke={colors[i % colors.length]} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* ---- Heatmap grid (day x time-slot) ---- */
export function Heatmap({
  rows,
  cols,
  values,
  maxValue,
}: {
  rows: string[]; // time slots
  cols: string[]; // days
  values: number[][]; // [row][col]
  maxValue: number;
}) {
  function colorFor(v: number): string {
    if (v <= 0) return "transparent";
    const intensity = Math.min(1, v / (maxValue || 1));
    const alpha = 0.15 + intensity * 0.7;
    return `rgba(139, 30, 40, ${alpha})`;
  }
  return (
    <div className="overflow-x-auto">
      <div className="grid" style={{ gridTemplateColumns: `100px repeat(${cols.length}, 1fr)` }}>
        <div />
        {cols.map((c) => (
          <div key={c} className="text-center text-[10px] text-text-subtle pb-1">
            {c}
          </div>
        ))}
        {rows.map((r, ri) => (
          <div key={r} className="contents">
            <div className="text-[10px] text-text-subtle pr-2 py-1 whitespace-nowrap flex items-center">{r}</div>
            {cols.map((c, ci) => (
              <div
                key={c}
                className="h-6 m-0.5 rounded"
                style={{ background: colorFor(values[ri]?.[ci] ?? 0) }}
                title={`${r} · ${c}: ${values[ri]?.[ci] ?? 0}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Ranking card ---- */
const AVATAR_COLORS = ["#e0578a", "#f0a13a", "#3b82c4", "#4a9d6f", "#8b5fbf"];
function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function RankingCard({
  title,
  name,
  role,
  value,
}: {
  title: string;
  name: string | null;
  role?: string;
  value: number | string;
}) {
  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="flex items-center gap-1 mb-3">
        <span className="text-xs text-text-muted">{title}</span>
        <Info size={11} className="text-text-subtle" />
      </div>
      {name ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
              style={{ background: avatarColor(name) }}
            >
              {name.slice(0, 1)}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-text truncate">{name}</div>
              {role && <div className="text-[10px] text-text-subtle truncate">{role}</div>}
            </div>
          </div>
          <span className="text-lg font-bold text-text shrink-0">{value}</span>
        </div>
      ) : (
        <div className="text-sm text-text-subtle py-1.5">ไม่มีข้อมูล</div>
      )}
    </div>
  );
}

export { avatarColor };
