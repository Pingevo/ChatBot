"use client";
import { useEffect, useState } from "react";
import { Loading } from "@/components/ui/Loading";
import { statsService, type AdminActivityStats } from "@/lib/services";
import {
  ConnectedChannelsHeader,
  RankingCard,
  MultiLineChart,
  avatarColor,
} from "@/components/charts/ZaapiStats";
import { ChevronDown } from "lucide-react";

const mockDays = Array.from({ length: 7 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - (6 - i));
  return d.toLocaleDateString("th-TH", { day: "2-digit", month: "short" });
});

const mockAdminNames = ["Toey", "Dunkin", "Chris", "Trung", "Looppad"];
const mockColors = ["#3b82c4", "#e0578a", "#4a9d6f", "#f0a13a", "#8b5fbf"];

function mockSeries() {
  return mockDays.map((date) => {
    const row: Record<string, unknown> = { date };
    mockAdminNames.forEach((n) => {
      row[n] = Math.round(Math.random() * 5);
    });
    return row;
  });
}

const mockActivity: AdminActivityStats = {
  has_real_data: false,
  connected_shops: 6,
  date_range_label: "ก.ค. 1-7, 2026",
  compare_label: "7 วันที่แล้ว",
  conversations_by_admin_per_day: mockSeries(),
  admin_series_keys: mockAdminNames,
  rankings: {
    most_conversations: {
      admin_id: "a1",
      name: "Toey",
      role: "admin",
      conversations: 3,
      unanswered_12h: 0,
      response_rate_12h: 100,
      response_rate_10min: 100,
      avg_response_time_seconds: 0,
    },
    least_responses: {
      admin_id: "a5",
      name: "Looppad",
      role: "admin",
      conversations: 1,
      unanswered_12h: 0,
      response_rate_12h: 100,
      response_rate_10min: 0,
      avg_response_time_seconds: 0,
    },
    fastest_10min: {
      admin_id: "a1",
      name: "Toey",
      role: "admin",
      conversations: 3,
      unanswered_12h: 0,
      response_rate_12h: 100,
      response_rate_10min: 100,
      avg_response_time_seconds: 0,
    },
    fastest_overall: {
      admin_id: "a1",
      name: "Toey",
      role: "admin",
      conversations: 3,
      unanswered_12h: 0,
      response_rate_12h: 100,
      response_rate_10min: 100,
      avg_response_time_seconds: 0,
    },
  },
  individual_performance: mockAdminNames.map((n, i) => ({
    admin_id: `a${i + 1}`,
    name: n,
    role: "admin",
    conversations: 3 - (i % 3),
    unanswered_12h: i === 1 ? 1 : 0,
    response_rate_12h: 100 - i * 10,
    response_rate_10min: 100 - i * 20,
    avg_response_time_seconds: i * 60,
  })),
};

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
  const [usingMock, setUsingMock] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    statsService
      .adminActivity()
      .then((d) => {
        if (d.has_real_data) {
          setData(d);
          setUsingMock(false);
        } else {
          setData(mockActivity);
          setUsingMock(true);
        }
      })
      .catch(() => {
        setData(mockActivity);
        setUsingMock(true);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-12"><Loading size={28} /></div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-text">การทำงานของแอดมิน</h2>
      </div>

      <ConnectedChannelsHeader
        connectedCount={data.connected_shops}
        dateRangeLabel={data.date_range_label}
        compareLabel={data.compare_label}
      />
      {usingMock && <p className="text-xs text-text-subtle -mt-2">ตัวอย่างข้อมูล (ยังไม่มีข้อมูลจริง)</p>}

      {/* ---- Ranking cards ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
      <div className="bg-surface rounded-xl border border-border p-4">
        <h3 className="text-sm font-semibold text-text mb-3">จำนวนการสนทนาของแต่ละเจ้าหน้าที่</h3>
        <MultiLineChart
          data={data.conversations_by_admin_per_day}
          seriesKeys={data.admin_series_keys}
          colors={mockColors}
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
                    <div className="px-4 pb-4 pt-1 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
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
  );
}
