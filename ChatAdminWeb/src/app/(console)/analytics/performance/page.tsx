"use client";
import { useEffect, useState } from "react";
import { Loading } from "@/components/ui/Loading";
import { statsService, type PerformanceStats } from "@/lib/services";
import {
  ConnectedChannelsHeader,
  KpiCard,
  DonutCenterChart,
  StackedChannelBarChart,
  MultiLineChart,
  Heatmap,
} from "@/components/charts/ZaapiStats";

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const CHANNEL_COLORS = ["#ee4d2d", "#111827", "#1a2e8c"];
const CHANNEL_KEYS = ["shopee", "tiktok", "lazada"];

const mockDays = Array.from({ length: 7 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - (6 - i));
  return d.toLocaleDateString("th-TH", { day: "2-digit", month: "short" });
});

function mockSpark(base: number, variance: number) {
  return mockDays.map((date) => ({ date, value: Math.max(0, Math.round(base + (Math.random() - 0.5) * variance)) }));
}

function mockChannelSeries(bases: number[]) {
  return mockDays.map((date) => {
    const row: Record<string, unknown> = { date };
    CHANNEL_KEYS.forEach((k, i) => {
      row[k] = Math.max(0, Math.round(bases[i] + (Math.random() - 0.5) * bases[i]));
    });
    return row;
  });
}

const mockPerformance: PerformanceStats = {
  has_real_data: false,
  connected_shops: 6,
  date_range_label: "ก.ค. 1-7, 2026",
  compare_label: "7 วันที่แล้ว",
  overview: {
    new_vs_existing: { new: 1, existing: 5 },
    conversations: { value: 6, spark: mockSpark(4, 4) },
    unanswered_12h: { value: 4, spark: mockSpark(3, 3) },
    response_rate_12h: { value: 63.6, spark: mockSpark(60, 30) },
    response_rate_10min: { value: 54.5, spark: mockSpark(50, 30) },
    avg_response_time_seconds: { value: 232, spark: mockSpark(200, 100) },
    messages_received: { value: 16, spark: mockSpark(10, 8) },
    messages_sent: { value: 30, spark: mockSpark(20, 12) },
  },
  insight: {
    customers_by_channel: mockChannelSeries([2, 1, 1]),
    unanswered_by_channel: mockChannelSeries([1, 1, 1]),
    response_rate_12h_by_channel: mockChannelSeries([60, 50, 70]),
    response_rate_10min_by_channel: mockChannelSeries([40, 30, 50]),
    avg_response_time_by_channel: mockChannelSeries([180, 220, 150]),
  },
  heatmap: {
    rows: ["0:00-3:00", "3:00-6:00", "6:00-9:00", "9:00-12:00", "12:00-15:00", "15:00-18:00", "18:00-21:00", "21:00-00:00"],
    cols: ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"],
    values: Array.from({ length: 8 }, () => Array.from({ length: 7 }, () => Math.round(Math.random() * 5))),
  },
};

export default function PerformanceStatsPage() {
  const [data, setData] = useState<PerformanceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    statsService
      .performance()
      .then((d) => {
        if (d.has_real_data) {
          setData(d);
          setUsingMock(false);
        } else {
          setData(mockPerformance);
          setUsingMock(true);
        }
      })
      .catch(() => {
        setData(mockPerformance);
        setUsingMock(true);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-12"><Loading size={28} /></div>;
  if (!data) return null;

  const maxHeat = Math.max(...data.heatmap.values.flat(), 1);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-text">ภาพรวม Performance</h2>
      </div>

      <ConnectedChannelsHeader
        connectedCount={data.connected_shops}
        dateRangeLabel={data.date_range_label}
        compareLabel={data.compare_label}
      />
      {usingMock && <p className="text-xs text-text-subtle -mt-2">ตัวอย่างข้อมูล (ยังไม่มีข้อมูลจริง)</p>}

      {/* ---- Overview KPI grid ---- */}
      <div>
        <h3 className="text-sm font-semibold text-text mb-3">ภาพรวม</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="bg-surface rounded-xl border border-border p-4">
            <div className="flex items-center gap-1 mb-2">
              <span className="text-xs text-text-muted">จำนวนลูกค้าใหม่ vs ลูกค้าปัจจุบัน</span>
            </div>
            <DonutCenterChart
              data={[
                { name: "ลูกค้าใหม่", value: data.overview.new_vs_existing.new },
                { name: "ลูกค้าเก่า", value: data.overview.new_vs_existing.existing },
              ]}
              centerLabel=""
              colors={["#3b82c4", "#c8912b"]}
            />
          </div>
          <KpiCard title="จำนวนการสนทนาลูกค้า" value={String(data.overview.conversations.value)} sparklineData={data.overview.conversations.spark} deltaPct={100} />
          <KpiCard title="จำนวนการสนทนาที่ไม่ได้ตอบกลับภายใน 12 ชั่วโมง" value={String(data.overview.unanswered_12h.value)} sparklineData={data.overview.unanswered_12h.spark} />
          <KpiCard title="อัตราการตอบกลับภายใน 12 ชั่วโมง" value={`${data.overview.response_rate_12h.value}%`} sparklineData={data.overview.response_rate_12h.spark} deltaPct={-36.36} />
          <KpiCard title="อัตราการตอบกลับภายใน 10 นาที" value={`${data.overview.response_rate_10min.value}%`} sparklineData={data.overview.response_rate_10min.spark} deltaPct={9.09} />
          <KpiCard title="ระยะเวลาการตอบกลับเฉลี่ย" value={fmtDuration(data.overview.avg_response_time_seconds.value)} sparklineData={data.overview.avg_response_time_seconds.spark} deltaPct={-97.53} />
          <KpiCard title="จำนวนข้อความที่ได้รับ" value={String(data.overview.messages_received.value)} sparklineData={data.overview.messages_received.spark} deltaPct={128.57} />
          <KpiCard title="จำนวนข้อความที่ส่งออกไป" value={String(data.overview.messages_sent.value)} sparklineData={data.overview.messages_sent.spark} deltaPct={114.29} />
        </div>
      </div>

      {/* ---- Insight charts ---- */}
      <div>
        <h3 className="text-sm font-semibold text-text mb-3">อินไซต์</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-surface rounded-xl border border-border p-4">
            <h4 className="text-xs font-medium text-text mb-2">จำนวนลูกค้าของแต่ละช่องทาง</h4>
            <StackedChannelBarChart data={data.insight.customers_by_channel} seriesKeys={CHANNEL_KEYS} colors={CHANNEL_COLORS} />
          </div>
          <div className="bg-surface rounded-xl border border-border p-4">
            <h4 className="text-xs font-medium text-text mb-2">จำนวนการสนทนาที่ไม่ได้ตอบกลับภายใน 12 ชั่วโมงของแต่ละช่องทาง</h4>
            <StackedChannelBarChart data={data.insight.unanswered_by_channel} seriesKeys={CHANNEL_KEYS} colors={CHANNEL_COLORS} />
          </div>
          <div className="bg-surface rounded-xl border border-border p-4">
            <h4 className="text-xs font-medium text-text mb-2">อัตราการตอบกลับภายใน 12 ชั่วโมง</h4>
            <MultiLineChart data={data.insight.response_rate_12h_by_channel} seriesKeys={CHANNEL_KEYS} colors={CHANNEL_COLORS} unit="%" />
          </div>
          <div className="bg-surface rounded-xl border border-border p-4">
            <h4 className="text-xs font-medium text-text mb-2">อัตราการตอบกลับภายใน 10 นาที</h4>
            <MultiLineChart data={data.insight.response_rate_10min_by_channel} seriesKeys={CHANNEL_KEYS} colors={CHANNEL_COLORS} unit="%" />
          </div>
          <div className="bg-surface rounded-xl border border-border p-4">
            <h4 className="text-xs font-medium text-text mb-2">ระยะเวลาการตอบกลับเฉลี่ย</h4>
            <MultiLineChart data={data.insight.avg_response_time_by_channel} seriesKeys={CHANNEL_KEYS} colors={CHANNEL_COLORS} unit="s" />
          </div>
          <div className="bg-surface rounded-xl border border-border p-4">
            <h4 className="text-xs font-medium text-text mb-2">ปริมาณลูกค้าในแต่ละช่วงเวลาต่อวัน</h4>
            <Heatmap rows={data.heatmap.rows} cols={data.heatmap.cols} values={data.heatmap.values} maxValue={maxHeat} />
          </div>
        </div>
        <p className="text-[11px] text-text-subtle mt-3">
          คำนวณจากการตอบกลับของแอดมินบนระบบเท่านั้น ข้อมูลอาจมีความแตกต่างจากช่องทางอื่น
        </p>
      </div>
    </div>
  );
}
