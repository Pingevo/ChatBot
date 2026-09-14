// Reusable recharts-based chart components for the stats pages.
"use client";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  ComposedChart,
} from "recharts";
import { DebouncedResponsiveContainer as ResponsiveContainer } from "./DebouncedResponsiveContainer";

const BRAND = "#8b1e28";
const NAVY = "#0b2340";
const GREY_BLUE = "#5a6b80";
const PALETTE = ["#8b1e28", "#b3253a", "#16a34a", "#d97706", "#7c3aed", "#0ea5e9"];

export function TrendLineChart({
  data,
  dataKey,
  xKey,
  color = BRAND,
  unit = "",
}: {
  data: Record<string, unknown>[];
  dataKey: string;
  xKey: string;
  color?: string;
  unit?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(value) => [`${value ?? 0}${unit}`, ""]}
          contentStyle={{ borderRadius: 10, border: "1px solid #e9edf2", fontSize: 12, boxShadow: "0 4px 12px -2px rgba(0,0,0,0.06)", padding: "6px 10px" }}
        />
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2.5}
          dot={{ r: 3 }}
          activeDot={{ r: 5 }}
          isAnimationActive
          animationDuration={600}
          animationEasing="ease-in-out"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function WeeklyBarChart({
  data,
  dataKey,
  xKey,
  color = "#4a7a5a",
  unit = "%",
}: {
  data: Record<string, unknown>[];
  dataKey: string;
  xKey: string;
  color?: string;
  unit?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(value) => [`${value ?? 0}${unit}`, ""]}
          contentStyle={{ borderRadius: 10, border: "1px solid #e9edf2", fontSize: 12, boxShadow: "0 4px 12px -2px rgba(0,0,0,0.06)", padding: "6px 10px" }}
        />
        <Bar dataKey={dataKey} fill={color} radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ⚡ ComboChart — กราฟแท่ง + เส้น (Bar + Line)
export function ComboBarLineChart({
  data,
  barKey,
  lineKey,
  xKey,
  barColor = BRAND,
  lineColor = GREY_BLUE,
  unit = "",
}: {
  data: Record<string, unknown>[];
  barKey: string;
  lineKey?: string;
  xKey: string;
  barColor?: string;
  lineColor?: string;
  unit?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(value) => [`${value ?? 0}${unit}`, ""]}
          contentStyle={{ borderRadius: 10, border: "1px solid #e9edf2", fontSize: 12, boxShadow: "0 4px 12px -2px rgba(0,0,0,0.06)", padding: "6px 10px" }}
        />
        <Bar
          dataKey={barKey}
          fill={barColor}
          radius={[6, 6, 0, 0]}
          barSize={32}
          isAnimationActive
          animationDuration={600}
          animationEasing="ease-in-out"
        />
        {lineKey && (
          <Line
            type="monotone"
            dataKey={lineKey}
            stroke={lineColor}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive
            animationDuration={800}
            animationEasing="ease-in-out"
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ⚡ SmartChart — เลือก bar หรือ line อัตโนมัติตามจำนวนจุด
//   1 จุด → กราฟแท่ง (bar)
//   2+ จุด → กราฟเส้น (line) พร้อม animation
export function SmartChart({
  data,
  dataKey,
  xKey,
  color = BRAND,
  unit = "",
}: {
  data: Record<string, unknown>[];
  dataKey: string;
  xKey: string;
  color?: string;
  unit?: string;
}) {
  const isSinglePoint = data.length <= 1;
  if (isSinglePoint) {
    return (
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
          <Tooltip
            formatter={(value) => [`${value ?? 0}${unit}`, ""]}
            contentStyle={{ borderRadius: 10, border: "1px solid #e9edf2", fontSize: 12, boxShadow: "0 4px 12px -2px rgba(0,0,0,0.06)", padding: "6px 10px" }}
          />
          <Bar
            dataKey={dataKey}
            fill={color}
            radius={[6, 6, 0, 0]}
            barSize={48}
            isAnimationActive
            animationDuration={600}
            animationEasing="ease-in-out"
          />
        </BarChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(value) => [`${value ?? 0}${unit}`, ""]}
          contentStyle={{ borderRadius: 10, border: "1px solid #e9edf2", fontSize: 12, boxShadow: "0 4px 12px -2px rgba(0,0,0,0.06)", padding: "6px 10px" }}
        />
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2.5}
          dot={{ r: 3 }}
          activeDot={{ r: 5 }}
          isAnimationActive
          animationDuration={800}
          animationEasing="ease-in-out"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TopicDonutChart({
  data,
}: {
  data: { topic: string; count: number }[];
}) {
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <div className="flex items-center gap-6">
      <ResponsiveContainer width={160} height={160}>
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="topic"
            innerRadius={45}
            outerRadius={70}
            paddingAngle={2}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #e9edf2", fontSize: 12, boxShadow: "0 4px 12px -2px rgba(0,0,0,0.06)", padding: "6px 10px" }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="space-y-1.5 flex-1 min-w-0">
        {data.map((d, i) => (
          <div key={d.topic} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="text-text truncate flex-1">{d.topic.replace(/_/g, " ")}</span>
            <span className="text-text-muted shrink-0">
              {total ? Math.round((d.count / total) * 100) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
