"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { statsService, type LiveStats } from "@/lib/services";
import { ConnectedChannelsHeader, DonutCenterChart, avatarColor } from "@/components/charts/ZaapiStats";
import { Info } from "lucide-react";
import { UnifiedDateRangePicker, rangeToParams, type DateRangeValue } from "@/components/ui/UnifiedDateRangePicker";
import { LiveSkeleton } from "@/components/ui/StatsSkeleton";

const DONUT_COLORS = ["#3b82c4", "#e0578a", "#4a9d6f", "#f0a13a", "#8b5fbf", "#c8912b"];

export default function LiveStatsPage() {
  const [data, setData] = useState<LiveStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [dateRange, setDateRange] = useState<DateRangeValue>({
    preset: "daily",
    startDate: null,
    endDate: null,
  });

  const params = useMemo(() => rangeToParams(dateRange), [dateRange]);

  const load = useCallback(() => {
    statsService
      .live(params)
      .then((d) => {
        setData(d);
        setError(null);
        setSecondsAgo(0);
      })
      .catch((e) => {
        setError(e?.message || "โหลดข้อมูลไม่สำเร็จ");
        setSecondsAgo(0);
      })
      .finally(() => setLoading(false));
  }, [params]);

  useEffect(() => {
    load();
    const refreshInterval = setInterval(load, 30000);
    const tickInterval = setInterval(() => setSecondsAgo((s) => s + 1), 1000);
    return () => {
      clearInterval(refreshInterval);
      clearInterval(tickInterval);
    };
  }, [load]);

  if (loading && !data) return <LiveSkeleton />;
  if (error && !data) return <EmptyState icon={undefined as never} title="โหลดข้อมูลไม่สำเร็จ" description={error} />;
  if (!data) return null;

  const maxWorkload = Math.max(...data.workload_by_admin.map((w) => w.count), 1);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-text">ข้อมูลสด</h2>
        <div className="flex items-center gap-3">
          <UnifiedDateRangePicker value={dateRange} onChange={setDateRange} />
          <a href="#" className="text-xs text-brand flex items-center gap-1 hover:underline">
            <Info size={13} /> แนะนำการใช้งาน
          </a>
        </div>
      </div>
      <p className="text-sm text-text-muted -mt-3">ภาพรวมทีมที่เปิดอยู่แบบเรียลไทม์</p>

      <ConnectedChannelsHeader
        connectedCount={data.connected_shops}
        live
        lastUpdatedSeconds={secondsAgo}
        onRefresh={load}
      />
      {!data.has_real_data && <p className="text-xs text-text-subtle">ยังไม่มีข้อมูลจริง</p>}

      <div className={loading ? "opacity-50 pointer-events-none transition-opacity" : "transition-opacity"}>

      {/* Two big stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center gap-1 mb-2">
            <span className="text-sm text-text-muted">แชทที่เปิดอยู่ทั้งหมด</span>
            <Info size={12} className="text-text-subtle" />
          </div>
          <div className="text-3xl font-bold text-text mb-2">{data.open_total}</div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-emerald-600 font-medium">มอบหมายแล้ว {data.open_assigned}</span>
            <span className="text-text-muted">ยังไม่ได้มอบหมาย {data.open_unassigned}</span>
          </div>
        </div>
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center gap-1 mb-2">
            <span className="text-sm text-text-muted">แชทที่ยังไม่ได้ตอบกลับ</span>
            <Info size={12} className="text-text-subtle" />
          </div>
          <div className="text-3xl font-bold text-vibrant-coral mb-2">{data.unanswered_total}</div>
          <div className="text-xs text-text-muted">
            รอการตอบกลับนานกว่า {data.unanswered_threshold_minutes} นาที
          </div>
        </div>
      </div>

      {/* Closed chats card */}
      <div className="bg-surface rounded-xl border border-border p-5 mt-1">
        <div className="flex items-center gap-1 mb-2">
          <span className="text-sm text-text-muted">แชทที่ปิดไปแล้ว</span>
        </div>
        <div className="text-3xl font-bold text-text mb-3">{data.closed_total}</div>
        {/* Breakdown by status */}
        {data.breakdown_by_status.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {data.breakdown_by_status.map((s) => (
              <span
                key={s.status}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 text-sm text-text"
              >
                <span className="capitalize">{s.status}</span>
                <span className="font-semibold text-brand">{s.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Two panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-text">แชทที่เปิดอยู่ตามเจ้าหน้าที่</h3>
          <p className="text-xs text-text-subtle mb-4">ภาระงานปัจจุบัน เรียงตามแชทที่ใช้งานอยู่</p>
          <div className="space-y-3">
            {data.workload_by_admin.map((w) => (
              <div key={w.admin_id} className="flex items-center gap-3">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                  style={{ background: w.admin_id === "__unassigned__" ? "#98a2b3" : avatarColor(w.name) }}
                >
                  {w.admin_id === "__unassigned__" ? "?" : w.name.slice(0, 1)}
                </div>
                <span className="text-sm text-text w-32 truncate shrink-0">{w.name}</span>
                <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full"
                    style={{ width: `${(w.count / maxWorkload) * 100}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-text w-4 text-right shrink-0">{w.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-text">แชทที่เปิดอยู่ตามการเชื่อมต่อ</h3>
          <p className="text-xs text-text-subtle mb-4">การกระจายตามการเชื่อมต่อ</p>
          {data.breakdown_by_connection.length === 0 ? (
            <p className="text-sm text-text-muted py-8 text-center">ยังไม่มีข้อมูล</p>
          ) : (
            <DonutCenterChart
              data={data.breakdown_by_connection}
              centerLabel={`${data.open_total} แชทที่เปิดอยู่`}
              colors={DONUT_COLORS}
            />
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
