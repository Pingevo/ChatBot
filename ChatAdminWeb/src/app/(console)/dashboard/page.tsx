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
import { DashboardCompanion } from "@/components/dashboard/DashboardCompanion";
import { DashboardMotion } from "@/components/dashboard/DashboardMotion";

// ⚡ สี platform — ตรงกับ --color-platform-* ใน globals.css
const platformColors: Record<string, string> = {
  shopee: "#ee4d2d",
  tiktok: "#fe2c55",
  lazada: "var(--color-platform-lazada-contrast)",
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

  const messagesReceived = stats.messages_received ?? 0;
  const messagesSent = stats.messages_sent ?? 0;
  const messageTotal = messagesReceived + messagesSent;
  const replyRatio = messagesReceived > 0 ? (messagesSent / messagesReceived) * 100 : null;
  const replyRatioScale = Math.max(200, replyRatio ?? 0);
  const replyRatioFill = replyRatio === null ? 0 : (replyRatio / replyRatioScale) * 100;
  const replyRatioTarget = (100 / replyRatioScale) * 100;
  const platformScale = Math.max(1, ...stats.platform_breakdown.map((platform) => platform.count));

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
      actions={<div className="dashboard-desktop-actions"><UnifiedDateRangePicker value={dateRange} onChange={setDateRange} /></div>}
      contentClassName="p-4 md:p-6"
    >
      {/* Overlay skeleton เมื่อกำลังโหลดข้อมูลใหม่ แต่ยังเก็บ layout เดิมไว้ */}
      <div className={loading ? "opacity-50 pointer-events-none transition-opacity" : "transition-opacity"}>
        <DashboardMotion>
        <div className="mobile-only dashboard-mobile-view">
          <section className="dashboard-mobile-hero" data-dashboard-mobile-reveal aria-labelledby="dashboard-mobile-total-title">
            <div className="dashboard-mobile-hero-copy">
              <div className="dashboard-mobile-hero-heading">
                <h2 id="dashboard-mobile-total-title">แชททั้งหมด</h2>
                <UnifiedDateRangePicker value={dateRange} onChange={setDateRange} className="dashboard-mobile-range" />
              </div>
              <p className="dashboard-mobile-total tabular-nums">{stats.total_conversations.toLocaleString()}</p>
              <p className="dashboard-mobile-hero-caption">บทสนทนาในช่วงเวลาที่เลือก</p>
            </div>
            <DashboardCompanion />
          </section>

          <section className="dashboard-mobile-status" aria-label="สถานะแชทในช่วงเวลาที่เลือก" data-dashboard-mobile-reveal>
            <dl>
              <div>
                <dt><span className="dashboard-status-mark dashboard-status-bot"><Bot size={14} aria-hidden="true" /></span>บอทตอบ</dt>
                <dd className="text-accent">{(stats.bot_answered ?? 0).toLocaleString()}</dd>
              </div>
              <div>
                <dt><span className="dashboard-status-mark dashboard-status-active" aria-hidden="true" />กำลังตอบอยู่</dt>
                <dd>{(stats.with_admin ?? stats.active_now ?? 0).toLocaleString()}</dd>
              </div>
              <div>
                <dt><span className="dashboard-status-mark dashboard-status-closed"><Headset size={14} aria-hidden="true" /></span>ปิดแล้ว</dt>
                <dd className="text-success">{(stats.closed ?? 0).toLocaleString()}</dd>
              </div>
              <div>
                <dt><span className="dashboard-status-mark dashboard-status-time"><Clock size={14} aria-hidden="true" /></span>เวลาตอบเฉลี่ย</dt>
                <dd>{stats.avg_response_time > 0 ? formatDuration(stats.avg_response_time) : "—"}</dd>
              </div>
            </dl>
          </section>

          <section className="dashboard-mobile-messages" aria-labelledby="dashboard-mobile-message-title" data-dashboard-mobile-reveal>
            <div className="dashboard-message-section-heading">
              <h2 id="dashboard-mobile-message-title">ข้อความ</h2>
              <span>{messageTotal.toLocaleString()} ข้อความรวม</span>
            </div>
            <dl className="dashboard-message-metrics">
              <div className="dashboard-message-metric dashboard-message-metric-inbound">
                <dt>รับเข้า</dt>
                <dd>{messagesReceived.toLocaleString()}</dd>
              </div>
              <div className="dashboard-message-metric dashboard-message-metric-outbound">
                <dt>ตอบกลับ</dt>
                <dd>{messagesSent.toLocaleString()}</dd>
              </div>
            </dl>
            <div className="dashboard-message-total-progress">
              <div><span>อัตราตอบกลับต่อรับเข้า</span><b>{replyRatio === null ? "—" : `${Math.round(replyRatio)}%`}</b></div>
              <small className="dashboard-message-ratio-note">100% = ตอบกลับเท่าข้อความรับเข้า</small>
              <div className="dashboard-message-meter" role="meter" aria-label="อัตราตอบกลับต่อข้อความที่ได้รับ" aria-valuemin={0} aria-valuemax={replyRatioScale} aria-valuenow={replyRatio ?? 0} aria-valuetext={replyRatio === null ? "ไม่มีข้อความที่ได้รับ" : `${Math.round(replyRatio)} เปอร์เซ็นต์`}>
                <span style={{ width: `${replyRatioFill}%` }} />
                <i aria-hidden="true" style={{ left: `${replyRatioTarget}%` }} />
              </div>
            </div>
            <div className="dashboard-platform-chart-block">
              <h3>แพลตฟอร์ม</h3>
              {stats.platform_breakdown.length === 0 ? <p>ยังไม่มีข้อมูล</p> : (
                <dl className="dashboard-platform-chart">
                  {stats.platform_breakdown.map((platform) => {
                    const percent = (platform.count / platformScale) * 100;
                    return (
                      <div className="dashboard-platform-chart-row" key={platform.platform}>
                        <dt><span>{platform.platform}</span><b>{platform.count.toLocaleString()}</b></dt>
                        <dd className="dashboard-platform-bar" role="meter" aria-label={`${platform.platform} ${platform.count.toLocaleString()}`} aria-valuemin={0} aria-valuemax={platformScale} aria-valuenow={platform.count}>
                          <span style={{ width: `${percent}%`, background: platformColors[platform.platform] || "#8b1e28" }} />
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          </section>

          <section className="dashboard-mobile-trend" aria-labelledby="dashboard-mobile-trend-title" data-dashboard-mobile-reveal>
            <div className="dashboard-mobile-section-heading">
              <h2 id="dashboard-mobile-trend-title">
                {dateRange.preset === "daily" ? "แชทรายวัน" :
                 dateRange.preset === "weekly" ? "แชทรายสัปดาห์" :
                 dateRange.preset === "monthly" ? "แชทรายเดือน" :
                 dateRange.preset === "yearly" ? "แชทรายปี" :
                 dateRange.preset === "custom" ? "แชทตามช่วงที่เลือก" : "แชททั้งหมด"}
              </h2>
              <span>แนวโน้ม</span>
            </div>
            <SmartChart data={stats.daily_trend} dataKey="count" xKey="date" color="#8b1e28" unit=" แชท" />
            <details className="dashboard-mobile-data-disclosure">
              <summary>ดูตัวเลขรายช่วง</summary>
              <dl>
                {stats.daily_trend.map((point) => (
                  <div key={String(point.date)}>
                    <dt>{String(point.date)}</dt>
                    <dd>{Number(point.count ?? 0).toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </section>

          <section className="dashboard-mobile-breakdowns" aria-label="แยกตามหัวข้อ" data-dashboard-mobile-reveal>
            <div>
              <h2>หัวข้อ</h2>
              {stats.topic_breakdown.length === 0 ? <p>ยังไม่มีข้อมูล</p> : (
                <dl className="dashboard-mobile-topic-list">
                  {stats.topic_breakdown.map((topic) => (
                    <div key={topic.topic}>
                      <dt>{topic.topic.replace(/_/g, " ")}</dt>
                      <dd>{topic.count.toLocaleString()}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </section>
        </div>

        <div className="dashboard-desktop-view">
        <section className="dashboard-desktop-overview" data-dashboard-reveal aria-labelledby="dashboard-desktop-overview-title">
          <div className="dashboard-desktop-focus">
            <div className="dashboard-desktop-focus-copy">
              <span className="dashboard-desktop-eyebrow">ภาพรวมการทำงาน</span>
              <h2 id="dashboard-desktop-overview-title">แชททั้งหมด</h2>
              <p className="dashboard-desktop-total tabular-nums">{stats.total_conversations.toLocaleString()}</p>
              <span className="dashboard-desktop-caption">บทสนทนาในช่วงเวลาที่เลือก</span>
            </div>
            <DashboardCompanion />
          </div>
          <dl className="dashboard-desktop-status" aria-label="สถานะการตอบแชท">
            <div>
              <dt><span className="dashboard-status-mark dashboard-status-bot"><Bot size={13} aria-hidden="true" /></span>บอทตอบ</dt>
              <dd className="text-accent tabular-nums">{(stats.bot_answered ?? 0).toLocaleString()}</dd>
              <small>ยังไม่ส่งแอดมิน</small>
            </div>
            <div>
              <dt><span className="dashboard-status-mark dashboard-status-active" aria-hidden="true" />กำลังตอบอยู่</dt>
              <dd className="tabular-nums">{(stats.with_admin ?? stats.active_now ?? 0).toLocaleString()}</dd>
              <small>รอแอดมินตอบ</small>
            </div>
            <div>
              <dt><span className="dashboard-status-mark dashboard-status-closed"><Headset size={13} aria-hidden="true" /></span>ปิดแล้ว</dt>
              <dd className="text-success tabular-nums">{(stats.closed ?? 0).toLocaleString()}</dd>
              <small>ปิดแชทแล้ว</small>
            </div>
            <div>
              <dt><span className="dashboard-status-mark dashboard-status-time"><Clock size={13} aria-hidden="true" /></span>เวลาตอบเฉลี่ย</dt>
              <dd className="tabular-nums">{stats.avg_response_time > 0 ? formatDuration(stats.avg_response_time) : "—"}</dd>
              <small>ต่อข้อความ</small>
            </div>
          </dl>
        </section>

        <div className="dashboard-chart-grid grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4 mb-6">
          <Card data-dashboard-reveal className="dashboard-chart-card p-4">
            <h3 className="font-semibold text-text mb-3 tracking-tight">
              {dateRange.preset === "daily" ? "แชทรายวัน" :
               dateRange.preset === "weekly" ? "แชทรายสัปดาห์ (7 วัน)" :
               dateRange.preset === "monthly" ? "แชทรายเดือน" :
               dateRange.preset === "yearly" ? "แชทรายปี" :
               dateRange.preset === "custom" ? "แชทตามช่วงที่เลือก" : "แชททั้งหมด"}
            </h3>
            <SmartChart data={stats.daily_trend} dataKey="count" xKey="date" color="#8b1e28" unit=" แชท" />
            <div className="mobile-only mt-3 border-t border-border-subtle pt-3" aria-label="สรุปข้อมูลแนวโน้ม">
              <p className="mb-2 text-xs font-semibold text-text-muted">จำนวนแชทตามช่วง</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {stats.daily_trend.map((point) => (
                  <div key={String(point.date)} className="flex min-w-0 justify-between gap-2 text-xs">
                    <dt className="min-w-0 text-text-muted break-words">{String(point.date)}</dt>
                    <dd className="shrink-0 font-semibold tabular-nums text-text">{Number(point.count ?? 0).toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Card>

          <Card data-dashboard-reveal className="dashboard-chart-card dashboard-message-platform-card p-4">
            <div className="dashboard-message-section-heading">
              <h3>ข้อความ</h3>
              <span>{messageTotal.toLocaleString()} ข้อความรวม</span>
            </div>
            <dl className="dashboard-message-metrics">
              <div className="dashboard-message-metric dashboard-message-metric-inbound"><dt>รับเข้า</dt><dd>{messagesReceived.toLocaleString()}</dd></div>
              <div className="dashboard-message-metric dashboard-message-metric-outbound"><dt>ตอบกลับ</dt><dd>{messagesSent.toLocaleString()}</dd></div>
            </dl>
            <div className="dashboard-message-total-progress">
              <div><span>อัตราตอบกลับต่อรับเข้า</span><b>{replyRatio === null ? "—" : `${Math.round(replyRatio)}%`}</b></div>
              <small className="dashboard-message-ratio-note">100% = ตอบกลับเท่าข้อความรับเข้า</small>
              <div className="dashboard-message-meter" role="meter" aria-label="อัตราตอบกลับต่อข้อความที่ได้รับ" aria-valuemin={0} aria-valuemax={replyRatioScale} aria-valuenow={replyRatio ?? 0} aria-valuetext={replyRatio === null ? "ไม่มีข้อความที่ได้รับ" : `${Math.round(replyRatio)} เปอร์เซ็นต์`}>
                <span style={{ width: `${replyRatioFill}%` }} />
                <i aria-hidden="true" style={{ left: `${replyRatioTarget}%` }} />
              </div>
            </div>
            <div className="dashboard-platform-chart-block">
              <h4>แพลตฟอร์ม</h4>
              {stats.platform_breakdown.length === 0 ? <p className="text-sm text-text-subtle">ยังไม่มีข้อมูล</p> : (
                <dl className="dashboard-platform-chart">
                  {stats.platform_breakdown.map((platform) => {
                    const percent = (platform.count / platformScale) * 100;
                    return (
                      <div className="dashboard-platform-chart-row" key={platform.platform}>
                        <dt><span>{platform.platform}</span><b>{platform.count.toLocaleString()}</b></dt>
                        <dd className="dashboard-platform-bar" role="meter" aria-label={`${platform.platform} ${platform.count.toLocaleString()}`} aria-valuemin={0} aria-valuemax={platformScale} aria-valuenow={platform.count}>
                          <span style={{ width: `${percent}%`, background: platformColors[platform.platform] || "#8b1e28" }} />
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          </Card>
        </div>

        <Card data-dashboard-reveal className="dashboard-chart-card dashboard-topics p-4">
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
        </DashboardMotion>
      </div>
    </PageShell>
  );
}
