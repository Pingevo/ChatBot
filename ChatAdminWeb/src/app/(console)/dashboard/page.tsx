"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { MessageSquare, Bot, Headset, Clock } from "lucide-react";
import { statsService } from "@/lib/services";
import { TrendLineChart } from "@/components/charts/StatsCharts";
import type { DashboardStats } from "@/lib/types";

const mockStats: DashboardStats = {
  total_conversations: 1248,
  active_now: 23,
  bot_resolved: 986,
  handoff_count: 262,
  avg_response_time: 2.4,
  platform_breakdown: [
    { platform: "shopee", count: 820 },
    { platform: "tiktok", count: 280 },
    { platform: "lazada", count: 148 },
  ],
  topic_breakdown: [
    { topic: "product_inquiry", count: 540 },
    { topic: "warranty", count: 180 },
    { topic: "shipping", count: 160 },
    { topic: "claim", count: 120 },
    { topic: "problem_report", count: 90 },
    { topic: "tax_invoice", count: 60 },
  ],
  daily_trend: Array.from({ length: 7 }, (_, i) => ({
    date: new Date(Date.now() - (6 - i) * 86400000).toLocaleDateString("th-TH", { weekday: "short" }),
    count: 120 + Math.floor(Math.random() * 80),
  })),
};

const platformColors: Record<string, string> = {
  shopee: "#ee4d2d",
  tiktok: "#111827",
  lazada: "#1a2e8c",
};

type Period = "daily" | "monthly" | "yearly";

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>("daily");
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    statsService
      .dashboard()
      .then((d) => {
        if (d.has_real_data) {
          setStats(d);
          setUsingMock(false);
        } else {
          setStats(mockStats);
          setUsingMock(true);
        }
      })
      .catch(() => {
        setStats(mockStats);
        setUsingMock(true);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="h-full flex items-center justify-center"><Loading size={32} /></div>;
  if (!stats) return <EmptyState icon={MessageSquare} title="ไม่มีข้อมูล" />;

  const resolveRate = stats.total_conversations
    ? ((stats.bot_resolved / stats.total_conversations) * 100).toFixed(1)
    : "0";

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-text mb-1">แดชบอร์ด</h1>
          <p className="text-sm text-text-muted">
            ภาพรวมการทำงานของระบบทั้งหมด
            {usingMock && <span className="text-text-subtle"> · ตัวอย่างข้อมูล (ยังไม่มีข้อมูลจริง)</span>}
          </p>
        </div>
        <div className="flex gap-1 bg-surface-2 rounded-lg p-1">
          {([
            ["daily", "รายวัน"],
            ["monthly", "รายเดือน"],
            ["yearly", "รายปี"],
          ] as [Period, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                period === key ? "bg-brand text-white shadow-sm" : "text-text-muted hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-text-muted">แชททั้งหมด</span>
            <MessageSquare size={16} className="text-deep-space" />
          </div>
          <div className="text-2xl font-bold text-text">{stats.total_conversations.toLocaleString()}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-text-muted">กำลังตอบอยู่</span>
            <span className="w-2 h-2 rounded-full bg-vibrant-coral animate-pulse-soft" />
          </div>
          <div className="text-2xl font-bold text-text">{stats.active_now}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-text-muted">บอทตอบ</span>
            <Bot size={16} className="text-brand" />
          </div>
          <div className="text-2xl font-bold text-brand">{stats.bot_resolved.toLocaleString()}</div>
          <div className="text-xs text-text-muted mt-1">อัตราแก้ไข {resolveRate}%</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-text-muted">ส่งแอดมิน</span>
            <Headset size={16} className="text-vibrant-coral" />
          </div>
          <div className="text-2xl font-bold text-vibrant-coral">{stats.handoff_count}</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Daily trend */}
        <Card className="p-4">
          <h3 className="font-semibold text-text mb-2">แชทรายวัน (7 วัน)</h3>
          <TrendLineChart data={stats.daily_trend} dataKey="count" xKey="date" color="#8b1e28" unit=" แชท" />
        </Card>

        {/* Platform breakdown */}
        <Card className="p-4">
          <h3 className="font-semibold text-text mb-4">แยกตามแพลตฟอร์ม</h3>
          <div className="space-y-3">
            {stats.platform_breakdown.map((p) => {
              const pct = stats.total_conversations ? (p.count / stats.total_conversations) * 100 : 0;
              return (
                <div key={p.platform}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="capitalize text-text">{p.platform}</span>
                    <span className="text-text-muted">{p.count}</span>
                  </div>
                  <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, background: platformColors[p.platform] || "#8b1e28" }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Topic breakdown */}
      <Card className="p-4">
        <h3 className="font-semibold text-text mb-4">แยกตามหัวข้อ</h3>
        <div className="flex flex-wrap gap-2">
          {stats.topic_breakdown.map((t) => (
            <span
              key={t.topic}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 text-sm text-text"
            >
              <span className="capitalize">{t.topic.replace(/_/g, " ")}</span>
              <span className="font-semibold text-brand">{t.count}</span>
            </span>
          ))}
        </div>
      </Card>

      <div className="mt-4 flex items-center gap-2 text-xs text-text-muted">
        <Clock size={12} />
        เวลาตอบเฉลี่ย: {stats.avg_response_time} วินาที
      </div>
    </div>
  );
}
