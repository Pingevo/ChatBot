"use client";
import { useEffect, useState, useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageShell } from "@/components/ui/PageShell";
import { MessageSquare, Bot, Headset, Clock, LayoutDashboard } from "lucide-react";
import { statsService } from "@/lib/services";
import { TrendLineChart, WeeklyBarChart, ComboBarLineChart, SmartChart } from "@/components/charts/StatsCharts";
import { UnifiedDateRangePicker, rangeToParams, type DateRangeValue } from "@/components/ui/UnifiedDateRangePicker";
import { DashboardSkeleton } from "@/components/ui/StatsSkeleton";
import type { DashboardStats } from "@/lib/types";

// ⚡ สี platform — ตรงกับ --color-platform-* ใน globals.css
const platformColors: Record<string, string> = {
  shopee: "#ee4d2d",
  tiktok: "#fe2c55",
  lazada: "#0f146d",
};

// ⚡ แปลงวินาที → "X ชม Y นาที Z วิ" หรือ "Y นาที Z วิ" หรือ "Z วิ"
function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} ชม`);
  if (m > 0) parts.push(`${m} นาที`);
  if (s > 0 || parts.length === 0) parts.push(`${s} วิ`);
  return parts.join(" ");
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRangeValue>({
    preset: "weekly",
    startDate: null,
    endDate: null,
  });
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(() => {
    const p = rangeToParams(dateRange);
    // ⚡ cache-busting — ป้องกัน browser/Next.js cache ค้าง
    return { ...p, _t: Date.now() };
  }, [dateRange]);

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
    <PageShell
      icon={LayoutDashboard}
      title="แดชบอร์ด"
      helpHref="/help#dashboard"
      subtitle={
        <>
          ภาพรวมการทำงานของระบบทั้งหมด
          {!stats.has_real_data && <span className="text-text-subtle"> · ยังไม่มีข้อมูลจริง</span>}
        </>
      }
      actions={<UnifiedDateRangePicker value={dateRange} onChange={setDateRange} />}
      contentClassName="p-4 md:p-6"
    >
      {/* Overlay skeleton เมื่อกำลังโหลดข้อมูลใหม่ แต่ยังเก็บ layout เดิมไว้ */}
      <div className={loading ? "opacity-50 pointer-events-none transition-opacity" : "transition-opacity"}>
        {/* KPI cards — 5 การ์ดหลัก */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-4 mb-6">
          <Card className="p-4 hover:shadow-[var(--shadow-md)] transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-text-muted">แชททั้งหมด</span>
              <div className="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center">
                <MessageSquare size={15} className="text-text-muted" />
              </div>
            </div>
            <div className="text-2xl font-bold text-text tabular-nums tracking-tight">{stats.total_conversations.toLocaleString()}</div>
            <div className="text-[11px] text-text-subtle mt-1">conversation ทั้งหมดในช่วงเวลา</div>
          </Card>
          <Card className="p-4 hover:shadow-[var(--shadow-md)] transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-text-muted">บอทตอบ</span>
              <div className="w-8 h-8 rounded-lg bg-accent-soft flex items-center justify-center">
                <Bot size={15} className="text-accent" />
              </div>
            </div>
            <div className="text-2xl font-bold text-accent tabular-nums tracking-tight">{(stats.bot_answered ?? 0).toLocaleString()}</div>
            <div className="text-[11px] text-text-subtle mt-1">บอทกำลังตอบ ยังไม่ส่งแอดมิน</div>
          </Card>
          <Card className="p-4 hover:shadow-[var(--shadow-md)] transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-text-muted">กำลังตอบอยู่</span>
              <div className="w-8 h-8 rounded-lg bg-warning-soft flex items-center justify-center">
                <span className="w-2 h-2 rounded-full bg-warning animate-pulse-soft" />
              </div>
            </div>
            <div className="text-2xl font-bold text-text tabular-nums tracking-tight">{(stats.with_admin ?? stats.active_now ?? 0).toLocaleString()}</div>
            <div className="text-[11px] text-text-subtle mt-1">ส่งแอดมินแล้ว รอตอบ</div>
          </Card>
          <Card className="p-4 hover:shadow-[var(--shadow-md)] transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-text-muted">ปิดแล้ว</span>
              <div className="w-8 h-8 rounded-lg bg-success-soft flex items-center justify-center">
                <Headset size={15} className="text-success" />
              </div>
            </div>
            <div className="text-2xl font-bold text-success tabular-nums tracking-tight">{(stats.closed ?? 0).toLocaleString()}</div>
            <div className="text-[11px] text-text-subtle mt-1">แอดมินปิดแชทแล้ว</div>
          </Card>
          <Card className="p-4 hover:shadow-[var(--shadow-md)] transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-text-muted">เวลาตอบเฉลี่ย</span>
              <div className="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center">
                <Clock size={15} className="text-text-muted" />
              </div>
            </div>
            <div className="text-2xl font-bold text-text tabular-nums tracking-tight">
              {stats.avg_response_time > 0 ? formatDuration(stats.avg_response_time) : "—"}
            </div>
            <div className="text-[11px] text-text-subtle mt-1">เฉลี่ย ลูกค้าถาม → ตอบ ต่อ message</div>
          </Card>
        </div>

        {/* ⚡ Message stats — ข้อความเข้า/ออก */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4 mb-6">
          <Card className="p-4 hover:shadow-[var(--shadow-md)] transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-text-muted">ข้อความเข้า (ลูกค้าส่ง)</span>
              <div className="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center">
                <MessageSquare size={15} className="text-text-muted" />
              </div>
            </div>
            <div className="text-2xl font-bold text-text tabular-nums tracking-tight">{(stats.messages_received ?? 0).toLocaleString()}</div>
            <div className="text-[11px] text-text-subtle mt-1">message ที่ลูกค้าส่งเข้ามาในช่วงเวลานี้</div>
          </Card>
          <Card className="p-4 hover:shadow-[var(--shadow-md)] transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-text-muted">ข้อความตอบกลับ (บอท/แอดมิน)</span>
              <div className="w-8 h-8 rounded-lg bg-accent-soft flex items-center justify-center">
                <Bot size={15} className="text-accent" />
              </div>
            </div>
            <div className="text-2xl font-bold text-accent tabular-nums tracking-tight">{(stats.messages_sent ?? 0).toLocaleString()}</div>
            <div className="text-[11px] text-text-subtle mt-1">message ที่บอท/แอดมินตอบกลับในช่วงเวลานี้</div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4 mb-6">
          <Card className="p-4">
            <h3 className="font-semibold text-text mb-3 tracking-tight">
              {dateRange.preset === "daily" ? "แชทรายวัน" :
               dateRange.preset === "weekly" ? "แชทรายสัปดาห์ (7 วัน)" :
               dateRange.preset === "monthly" ? "แชทรายเดือน" :
               dateRange.preset === "yearly" ? "แชทรายปี" :
               dateRange.preset === "custom" ? "แชทตามช่วงที่เลือก" : "แชททั้งหมด"}
            </h3>
            <SmartChart data={stats.daily_trend} dataKey="count" xKey="date" color="#8b1e28" unit=" แชท" />
          </Card>

          <Card className="p-4">
            <h3 className="font-semibold text-text mb-4 tracking-tight">แยกตามแพลตฟอร์ม</h3>
            <div className="space-y-3">
              {stats.platform_breakdown.length === 0 ? (
                <p className="text-sm text-text-subtle">ยังไม่มีข้อมูล</p>
              ) : (
                stats.platform_breakdown.map((p) => {
                  const pct = stats.total_conversations ? (p.count / stats.total_conversations) * 100 : 0;
                  return (
                    <div key={p.platform}>
                      <div className="flex justify-between text-sm mb-1.5">
                        <span className="capitalize text-text font-medium">{p.platform}</span>
                        <span className="text-text-muted tabular-nums">{p.count}</span>
                      </div>
                      <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
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
          <h3 className="font-semibold text-text mb-4 tracking-tight">แยกตามหัวข้อ</h3>
          <div className="flex flex-wrap gap-2">
            {stats.topic_breakdown.length === 0 ? (
              <p className="text-sm text-text-subtle">ยังไม่มีข้อมูล</p>
            ) : (
              stats.topic_breakdown.map((t) => (
                <span
                  key={t.topic}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-1 border border-border text-sm text-text hover:border-accent/30 hover:bg-accent-soft/50 transition-colors"
                >
                  <span className="capitalize">{t.topic.replace(/_/g, " ")}</span>
                  <span className="font-semibold text-accent tabular-nums">{t.count}</span>
                </span>
              ))
            )}
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
