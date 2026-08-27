"use client";
import { useEffect, useState, useMemo } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { statsService, type AdminActivityStats } from "@/lib/services";
import {
  ConnectedChannelsHeader,
  RankingCard,
  MultiLineChart,
  avatarColor,
} from "@/components/charts/ZaapiStats";
import { ChevronDown } from "lucide-react";
import { UnifiedDateRangePicker, rangeToParams, type DateRangeValue } from "@/components/ui/UnifiedDateRangePicker";
import { AnalyticsSkeleton } from "@/components/ui/StatsSkeleton";

const roleTone: Record<string, string> = {
  superadmin: "bg-deep-space text-white",
  admin: "bg-surface-2 text-text-muted",
  dev: "bg-surface-2 text-text-muted",
};

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function AdminActivityPage() {
  const [data, setData] = useState<AdminActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeValue>({
    preset: "daily",
    startDate: null,
    endDate: null,
  });

  const params = useMemo(() => rangeToParams(dateRange), [dateRange]);

  useEffect(() => {
    setLoading(true);
    statsService
      .adminActivity(params)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e?.message || "โหลดข้อมูลไม่สำเร็จ"))
      .finally(() => setLoading(false));
  }, [params]);

  if (loading && !data) return <AnalyticsSkeleton />;
  if (error && !data) return <EmptyState icon={undefined as never} title="โหลดข้อมูลไม่สำเร็จ" description={error} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-text">การทำงานของแอดมิน</h2>
        <UnifiedDateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      <ConnectedChannelsHeader connectedCount={data.connected_shops} />
      {!data.has_real_data && <p className="text-xs text-text-subtle -mt-2">ยังไม่มีข้อมูลจริง</p>}

      <div className={loading ? "opacity-50 pointer-events-none transition-opacity" : "transition-opacity"}>

      {/* ---- Ranking cards ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <RankingCard
          title="จำนวนการสนทนาสูงสุด"
          name={data.rankings.most_conversations?.name ?? null}
          role={data.rankings.most_conversations?.role}
          value={data.rankings.most_conversations?.conversations ?? 0}
        />
        <RankingCard
          title="จำนวนการสนทนาที่ไม่ได้ตอบกลับน้อยที่สุด"
          name={data.rankings.least_responses?.name ?? null}
          role={data.rankings.least_responses?.role}
          value={data.rankings.least_responses?.unanswered_12h ?? 0}
        />
        <RankingCard
          title="อัตราการตอบกลับภายใน 10 นาทีเร็วที่สุด"
          name={data.rankings.fastest_10min?.name ?? null}
          role={data.rankings.fastest_10min?.role}
          value={`${data.rankings.fastest_10min?.response_rate_10min ?? 0}%`}
        />
        <RankingCard
          title="ระยะเวลาการตอบกลับเฉลี่ยเร็วที่สุด"
          name={data.rankings.fastest_overall?.name ?? null}
          role={data.rankings.fastest_overall?.role}
          value={fmtDuration(data.rankings.fastest_overall?.avg_response_time_seconds ?? 0)}
        />
      </div>

      {/* ---- Conversations by admin chart ---- */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <h3 className="text-sm font-semibold text-text mb-4">จำนวนการสนทนาของแต่ละเจ้าหน้าที่</h3>
        <MultiLineChart
          data={data.conversations_by_admin_per_day}
          seriesKeys={data.admin_series_keys}
          colors={["#3b82c4", "#e0578a", "#4a9d6f", "#f0a13a", "#8b5fbf", "#c8912b", "#ee4d2d", "#111827"]}
        />
      </div>

      {/* ---- Individual performance table ---- */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-text">ประสิทธิภาพรายบุคคล</h3>
        </div>
        {data.individual_performance.length === 0 ? (
          <p className="text-sm text-text-muted py-8 text-center">ยังไม่มีข้อมูล</p>
        ) : (
          <div className="divide-y divide-border">
            {data.individual_performance.map((row) => {
              const isOpen = expanded === row.admin_id;
              return (
                <div key={row.admin_id}>
                  <button
                    onClick={() => setExpanded(isOpen ? null : row.admin_id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors text-left"
                  >
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                      style={{ background: avatarColor(row.name) }}
                    >
                      {row.name.slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text truncate">{row.name}</div>
                      <span className={`inline-block mt-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-md ${roleTone[row.role] || roleTone.admin}`}>
                        {row.role}
                      </span>
                    </div>
                    <div className="hidden sm:block text-right shrink-0 w-24">
                      <div className="text-sm font-semibold text-text">{row.conversations}</div>
                      <div className="text-[10px] text-text-subtle">การสนทนา</div>
                    </div>
                    <div className="hidden md:block text-right shrink-0 w-24">
                      <div className="text-sm font-semibold text-text">{row.response_rate_12h}%</div>
                      <div className="text-[10px] text-text-subtle">ตอบ 12 ชม.</div>
                    </div>
                    <ChevronDown
                      size={14}
                      className={`text-text-subtle transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 pt-2 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-[10px] text-text-subtle">การสนทนา</div>
                        <div className="font-medium text-text">{row.conversations}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-subtle">ไม่ตอบ 12 ชม.</div>
                        <div className="font-medium text-text">{row.unanswered_12h}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-subtle">ตอบ 12 ชม.</div>
                        <div className="font-medium text-text">{row.response_rate_12h}%</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-subtle">ตอบ 10 นาที</div>
                        <div className="font-medium text-text">{row.response_rate_10min}%</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-subtle">เวลาตอบเฉลี่ย</div>
                        <div className="font-medium text-text">{fmtDuration(row.avg_response_time_seconds)}</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
