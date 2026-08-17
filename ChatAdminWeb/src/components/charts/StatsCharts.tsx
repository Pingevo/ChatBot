// Reusable recharts-based chart components for the stats pages.
"use client";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts";

const BRAND = "#8b1e28";
const NAVY = "#0b2340";
const GREY_BLUE = "#7c93ad";
const PALETTE = [BRAND, NAVY, GREY_BLUE, "#c8912b", "#4a7a5a", "#5b6b8c"];

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
          contentStyle={{ borderRadius: 8, border: "1px solid #e3e6eb", fontSize: 12 }}
        />
        <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
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
          contentStyle={{ borderRadius: 8, border: "1px solid #e3e6eb", fontSize: 12 }}
        />
        <Bar dataKey={dataKey} fill={color} radius={[6, 6, 0, 0]} />
      </BarChart>
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
          <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e3e6eb", fontSize: 12 }} />
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
