"use client";
import { useEffect, useState, useCallback } from "react";
import { Loading } from "@/components/ui/Loading";
import { statsService, type LiveStats } from "@/lib/services";
import { ConnectedChannelsHeader, DonutCenterChart, avatarColor } from "@/components/charts/ZaapiStats";
import { Info } from "lucide-react";

const mockLive: LiveStats = {
  has_real_data: false,
  connected_shops: 6,
  open_total: 8,
  open_assigned: 5,
  open_unassigned: 3,
  unanswered_total: 0,
  unanswered_threshold_minutes: 10,
  workload_by_admin: [
    { admin_id: "__unassigned__", name: "ยังไม่ได้มอบหมาย", count: 3 },
    { admin_id: "a1", name: "Toey", count: 1 },
    { admin_id: "a2", name: "Dunkin", count: 1 },
    { admin_id: "a3", name: "Chris", count: 1 },
    { admin_id: "a4", name: "Trung", count: 1 },
    { admin_id: "a5", name: "Looppad", count: 1 },
  ],
  breakdown_by_connection: [
    { name: "TrendHaven Official", value: 1 },
    { name: "TrendHaven Support", value: 1 },
    { name: "TrendHaven Thailand", value: 1 },
    { name: "TrendHaven Store", value: 1 },
    { name: "Business Support", value: 1 },
  ],
  generated_at: new Date().toISOString(),
};

const DONUT_COLORS = ["#3b82c4", "#e0578a", "#4a9d6f", "#f0a13a", "#8b5fbf", "#c8912b"];

export default function LiveStatsPage() {
  const [data, setData] = useState<LiveStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);
  const [secondsAgo, setSecondsAgo] = useState(0);

  const load = useCallback(() => {
    statsService
      .live()
      .then((d) => {
        if (d.has_real_data) {
          setData(d);
          setUsingMock(false);
        } else {
          setData(mockLive);
          setUsingMock(true);
        }
        setSecondsAgo(0);
      })
      .catch(() => {
        setData(mockLive);
        setUsingMock(true);
        setSecondsAgo(0);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const refreshInterval = setInterval(load, 30000);
    const tickInterval = setInterval(() => setSecondsAgo((s) => s + 1), 1000);
    return () => {
      clearInterval(refreshInterval);
      clearInterval(tickInterval);
    };
  }, [load]);

  if (loading) return <div className="flex justify-center py-12"><Loading size={28} /></div>;
  if (!data) return null;

  const maxWorkload = Math.max(...data.workload_by_admin.map((w) => w.count), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-text">ข้อมูลสด</h2>
        <a href="#" className="text-xs text-brand flex items-center gap-1 hover:underline">
          <Info size={13} /> แนะนำการใช้งาน
        </a>
      </div>
      <p className="text-sm text-text-muted -mt-3">ภาพรวมทีมที่เปิดอยู่แบบเรียลไทม์</p>

      <ConnectedChannelsHeader
        connectedCount={data.connected_shops}
        live
        lastUpdatedSeconds={secondsAgo}
        onRefresh={load}
      />
      {usingMock && <p className="text-xs text-text-subtle">ตัวอย่างข้อมูล (ยังไม่มีข้อมูลจริง)</p>}

      {/* Two big stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center gap-1 mb-2">
            <span className="text-sm text-text-muted">ทักทักที่เปิดอยู่ทั้งหมด</span>
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
            <span className="text-sm text-text-muted">ทักทักที่ยังไม่ได้ตอบกลับ</span>
            <Info size={12} className="text-text-subtle" />
          </div>
          <div className="text-3xl font-bold text-vibrant-coral mb-2">{data.unanswered_total}</div>
          <div className="text-xs text-text-muted">
            รอการตอบกลับนานกว่า {data.unanswered_threshold_minutes} นาที
          </div>
        </div>
      </div>

      {/* Two panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-text">ทักทักที่เปิดอยู่ตามเจ้าหน้าที่</h3>
          <p className="text-xs text-text-subtle mb-4">ภาระงานปัจจุบัน เรียงตามทักทักที่ใช้งานอยู่</p>
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
          <h3 className="text-sm font-semibold text-text">ทักทักที่เปิดอยู่ตามการเชื่อมต่อ</h3>
          <p className="text-xs text-text-subtle mb-4">การกระจายตามการเชื่อมต่อ</p>
          {data.breakdown_by_connection.length === 0 ? (
            <p className="text-sm text-text-muted py-8 text-center">ยังไม่มีข้อมูล</p>
          ) : (
            <DonutCenterChart
              data={data.breakdown_by_connection}
              centerLabel={`${data.open_total} ทักทักที่เปิดอยู่`}
              colors={DONUT_COLORS}
            />
          )}
        </div>
      </div>
    </div>
  );
}
