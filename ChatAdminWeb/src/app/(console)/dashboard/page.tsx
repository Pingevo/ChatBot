"use client";
import { useEffect, useState, useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { MessageSquare, Bot, Headset, Clock, LayoutDashboard } from "lucide-react";
import { statsService } from "@/lib/services";
import { TrendLineChart } from "@/components/charts/StatsCharts";
import { UnifiedDateRangePicker, rangeToParams, type DateRangeValue } from "@/components/ui/UnifiedDateRangePicker";
import { DashboardSkeleton } from "@/components/ui/StatsSkeleton";
import type { DashboardStats } from "@/lib/types";

const platformColors: Record<string, string> = {
  shopee: "#ee4d2d",
  tiktok: "#111827",
  lazada: "#1a2e8c",
};

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRangeValue>({
    preset: "daily",
    startDate: null,
    endDate: null,
  });
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(() => rangeToParams(dateRange), [dateRange]);

  useEffect(() => {
    setLoading(true);
    statsService
      .dashboard(params)
      .then((d) => {
        setStats(d);
        setError(null);
      })
      .catch((e) => setError(e?.message || "โหลดข้อมูลไม่สำเร็จ"))
      .finally(() => setLoading(false));
  }, [params]);

  if (loading && !stats) return <DashboardSkeleton />;
  if (error && !stats) return <EmptyState icon={MessageSquare} title="โหลดข้อมูลไม่สำเร็จ" description={error} />;
  if (!stats) return <EmptyState icon={MessageSquare} title="ไม่มีข้อมูล" />;

  const resolveRate = stats.total_conversations
    ? (((stats.bot_answered ?? stats.bot_resolved ?? 0) / stats.total_conversations) * 100).toFixed(1)
    : "0";

  return (
    <div className="h-full overflow-y-auto">
      {/* Header — navbar แบบ shops/team */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <LayoutDashboard size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">แดชบอร์ด</h1>
              <p className="text-xs text-text-muted">
                ภาพรวมการทำงานของระบบทั้งหมด
                {!stats.has_real_data && <span className="text-text-subtle"> · ยังไม่มีข้อมูลจริง</span>}
              </p>
            </div>
          </div>
          <UnifiedDateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      <div className="p-4 md:p-6">

      {/* Overlay skeleton เมื่อกำลังโหลดข้อมูลใหม่ แต่ยังเก็บ layout เดิมไว้ */}
      <div className={loading ? "opacity-50 pointer-events-none transition-opacity" : "transition-opacity"}>
        {/* KPI cards — 5 การ์์หลัก */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-text-muted">แชททั้งหมด</span>
              <MessageSquare size={16} className="text-deep-space" />
            </div>
            <div className="text-2xl font-bold text-text">{stats.total_conversations.toLocaleString()}</div>
            <div className="text-[10px] text-text-subtle mt-1">conversation ทั้งหมดในช่วงเวลา</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-text-muted">บอทตอบ</span>
              <Bot size={16} className="text-brand" />
            </div>
            <div className="text-2xl font-bold text-brand">{(stats.bot_answered ?? 0).toLocaleString()}</div>
            <div className="text-[10px] text-text-subtle mt-1">บอทกำลังตอบ ยังไม่ส่งแอดมิน</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-text-muted">กำลังตอบอยู่</span>
              <span className="w-2 h-2 rounded-full bg-vibrant-coral animate-pulse-soft" />
            </div>
            <div className="text-2xl font-bold text-text">{(stats.with_admin ?? stats.active_now ?? 0).toLocaleString()}</div>
            <div className="text-[10px] text-text-subtle mt-1">ส่งแอดมินแล้ว รอตอบ</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-text-muted">ปิดแล้ว</span>
              <Headset size={16} className="text-vibrant-coral" />
            </div>
            <div className="text-2xl font-bold text-vibrant-coral">{(stats.closed ?? 0).toLocaleString()}</div>
            <div className="text-[10px] text-text-subtle mt-1">แอดมินปิดแชทแล้ว</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-text-muted">เวลาตอบเฉลี่ย</span>
              <Clock size={16} className="text-text-muted" />
            </div>
            <div className="text-2xl font-bold text-text">
              {stats.avg_response_time > 0 ? `${stats.avg_response_time}s` : "—"}
            </div>
            <div className="text-[10px] text-text-subtle mt-1">diff ลูกค้าถาม → ตอบ</div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <Card className="p-4">
            <h3 className="font-semibold text-text mb-2">แชทรายวัน (7 วัน)</h3>
            <TrendLineChart data={stats.daily_trend} dataKey="count" xKey="date" color="#8b1e28" unit=" แชท" />
          </Card>

          <Card className="p-4">
            <h3 className="font-semibold text-text mb-4">แยกตามแพลตฟอร์ม</h3>
            <div className="space-y-3">
              {stats.platform_breakdown.length === 0 ? (
                <p className="text-sm text-text-subtle">ยังไม่มีข้อมูล</p>
              ) : (
                stats.platform_breakdown.map((p) => {
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
                })
              )}
            </div>
          </Card>
        </div>

        <Card className="p-4">
          <h3 className="font-semibold text-text mb-4">แยกตามหัวข้อ</h3>
          <div className="flex flex-wrap gap-2">
            {stats.topic_breakdown.length === 0 ? (
              <p className="text-sm text-text-subtle">ยังไม่มีข้อมูล</p>
            ) : (
              stats.topic_breakdown.map((t) => (
                <span
                  key={t.topic}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 text-sm text-text"
                >
                  <span className="capitalize">{t.topic.replace(/_/g, " ")}</span>
                  <span className="font-semibold text-brand">{t.count}</span>
                </span>
              ))
            )}
          </div>
        </Card>
      </div>
      </div>
    </div>
  );
}
