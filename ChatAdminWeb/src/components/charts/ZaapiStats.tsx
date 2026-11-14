// Shared components for the Zaapi-style analytics pages (ข้อมูลสด,
// ภาพรวม Performance, การทำงานของแอดมิน).
"use client";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, LineChart, Line } from "recharts";
import { DebouncedResponsiveContainer as ResponsiveContainer } from "./DebouncedResponsiveContainer";
import { Info, RefreshCw } from "lucide-react";
import type { Platform } from "@/lib/types";
import type { CSSProperties } from "react";

/* ---- Connected channels header (platform icons + live status + refresh) ---- */

const platformDots: Record<Platform, string> = {
  shopee: "#ee4d2d",
  tiktok: "var(--color-platform-tiktok-contrast)",
  lazada: "var(--color-platform-lazada-contrast)",
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
    <div className="analytics-connected-strip flex items-center justify-between flex-wrap gap-3 py-3">
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
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse-soft" />
            สด
            {lastUpdatedSeconds !== undefined && <span className="hidden md:inline">· อัปเดตล่าสุด {lastUpdatedSeconds} วินาทีที่แล้ว</span>}
          </div>
        )}
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="phone-refresh-control w-8 h-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-text-muted transition-colors"
            title="รีเฟรช"
            aria-label="รีเฟรช"
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
          <span className={`text-xs font-medium ${positive ? "text-success" : "text-vibrant-coral"}`}>
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
    <>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--color-chart-axis)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: "var(--color-chart-axis)" }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e3e6eb", fontSize: 12 }} />
          {seriesKeys.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="a" fill={colors[i % colors.length]} radius={i === seriesKeys.length - 1 ? [4, 4, 0, 0] : undefined} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <MobileChartData data={data} seriesKeys={seriesKeys} title="ดูตัวเลขแยกตามวัน" />
    </>
  );
}

/* ---- Multi-line chart per channel ---- */
export function MultiLineChart({
  data,
  seriesKeys,
  colors,
  unit = "",
  seriesLabels,
}: {
  data: Record<string, unknown>[];
  seriesKeys: string[];
  colors: string[];
  unit?: string;
  seriesLabels?: Record<string, string>;
}) {
  return (
    <>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--color-chart-axis)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: "var(--color-chart-axis)" }} axisLine={false} tickLine={false} />
          <Tooltip formatter={(v) => [`${v ?? 0}${unit}`, ""]} contentStyle={{ borderRadius: 8, border: "1px solid #e3e6eb", fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {seriesKeys.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} name={seriesLabels?.[k] || k} stroke={colors[i % colors.length]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <MobileChartData data={data} seriesKeys={seriesKeys} seriesLabels={seriesLabels} unit={unit} title="ดูตัวเลขแยกตามวัน" />
    </>
  );
}

function MobileChartData({
  data,
  seriesKeys,
  seriesLabels,
  unit = "",
  title,
}: {
  data: Record<string, unknown>[];
  seriesKeys: string[];
  seriesLabels?: Record<string, string>;
  unit?: string;
  title: string;
}) {
  if (data.length === 0) return null;
  return (
    <details className="mobile-chart-data mobile-only mt-3 border-t border-border-subtle pt-2">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-navy">{title}</summary>
      <div className="space-y-2 pt-1">
        {data.map((point, index) => (
          <div key={String(point.date ?? index)} className="rounded-lg bg-surface-1 px-3 py-2">
            <p className="mb-1.5 text-xs font-semibold text-text">{String(point.date ?? `รายการ ${index + 1}`)}</p>
            <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-1.5">
              {seriesKeys.map((key) => (
                <div key={key} className="min-w-0">
                  <dt className="truncate text-[11px] leading-4 text-text-muted" title={seriesLabels?.[key] || key}>
                    {seriesLabels?.[key] || key}
                  </dt>
                  <dd className="text-xs font-semibold tabular-nums text-text">
                    {String(point[key] ?? 0)}{unit}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </details>
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
    <div className="phone-heatmap overflow-x-auto">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `100px repeat(${cols.length}, minmax(0, 1fr))`,
          "--heatmap-columns": cols.length,
        } as CSSProperties}
      >
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
                className="phone-heatmap-cell h-6 m-0.5 rounded"
                style={{ background: colorFor(values[ri]?.[ci] ?? 0) }}
                title={`${r} · ${c}: ${values[ri]?.[ci] ?? 0}`}
                aria-label={`${r} · ${c}: ${values[ri]?.[ci] ?? 0}`}
              />
            ))}
          </div>
        ))}
      </div>
      <details className="mobile-only mt-3 border-t border-border-subtle pt-2">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-navy">ดูตัวเลขแยกตามช่วงเวลา</summary>
        <div className="space-y-1 pt-1">
          {rows.map((row, rowIndex) => (
            <div key={row} className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2 py-1 text-[11px]">
              <span className="text-text-muted">{row}</span>
              <div className="grid min-w-0" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
                {cols.map((col, colIndex) => (
                  <span key={col} className="text-center tabular-nums text-text" aria-label={`${col}: ${values[rowIndex]?.[colIndex] ?? 0}`}>
                    {values[rowIndex]?.[colIndex] ?? 0}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>
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
