"use client";
// ⚡ Phase 3A — Admin Review KPI Dashboard
// แสดง KPI ของแอดมินแต่ละคน (test-chat, test-assignment, shadow-inbox)
// เฉพาะ dev/superadmin เข้าได้
import { useEffect, useState, useMemo, useCallback, Fragment } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { UnifiedDateRangePicker, rangeToParams, type DateRangeValue } from "@/components/ui/UnifiedDateRangePicker";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/lib/authStore";
import { BarChart3, Bot, FlaskConical, TestTube2, Star, MessageSquare, RefreshCw, ChevronDown, ChevronRight, User } from "lucide-react";

interface KpiSummary {
  admin_id: string;
  username?: string;
  name?: string;
  role?: string;
  test_chat_sessions_rated: number;
  test_chat_messages_rated: number;
  test_chat_star_rated: number;
  test_chat_avg_star: number;
  test_chat_good: number;
  test_chat_bad: number;
  test_chat_commented: number;
  test_assignment_replays: number;
  test_assignment_msg_rated: number;
  test_assignment_conv_rated: number;
  test_assignment_msg_commented: number;
  test_assignment_conv_commented: number;
  shadow_generated: number;
  shadow_rated: number;
  shadow_star_rated: number;
  shadow_commented: number;
}

interface DrilldownSession {
  session_id: string;
  platform?: string;
  shop?: string;
  messages_rated: number;
  comments: number;
  avg_star: number;
  last_rated_at: string;
}

interface DrilldownReplay {
  conversation_id: string;
  shop_name?: string;
  platform?: string;
  total_messages: number;
  processed_messages: number;
  final_status: string;
  msg_rated: number;
  conv_star_rating?: number;
  conv_rating?: string;
  conv_comment?: string;
  replayed_at: string;
}

interface DrilldownShadow {
  shadow_reply_id: string;
  conversation_id: string;
  shop_id: string;
  platform: string;
  origin: string;
  bot_source?: string;
  rating?: string;
  star_rating?: number;
  has_comment: boolean;
  created_at: string;
}

const roleLabel: Record<string, string> = {
  superadmin: "SuperAdmin",
  admin: "Admin",
  dev: "Dev",
};

const roleColor: Record<string, string> = {
  superadmin: "bg-brand/20 text-brand",
  dev: "bg-brand/20 text-brand",
  admin: "bg-surface-subtle text-text-muted",
};

function fmtDate(s: string): string {
  if (!s) return "—";
  try {
    const d = new Date(s);
    return d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return s;
  }
}

export default function AdminKpiPage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<KpiSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeValue>({
    preset: "weekly",
    startDate: null,
    endDate: null,
  });
  const [expandedAdmin, setExpandedAdmin] = useState<string | null>(null);
  const [drilldownTab, setDrilldownTab] = useState<"test_chat" | "test_assignment" | "shadow">("test_chat");
  const [drilldownData, setDrilldownData] = useState<{
    sessions?: DrilldownSession[];
    replays?: DrilldownReplay[];
    shadows?: DrilldownShadow[];
  }>({});
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  const params = useMemo(() => {
    const p = rangeToParams(dateRange);
    return { ...p, _t: Date.now() };
  }, [dateRange]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api().get("/admin-review-kpi", { params });
      setSummary(r.data?.summary || []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail || e?.message || "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const loadDrilldown = useCallback(async (adminId: string, tab: "test_chat" | "test_assignment" | "shadow") => {
    setDrilldownLoading(true);
    setDrilldownData({});
    try {
      const r = await api().get("/admin-review-kpi", {
        params: { ...params, admin_id: adminId, drilldown: tab },
      });
      setDrilldownData(r.data || {});
    } catch {
      setDrilldownData({});
    } finally {
      setDrilldownLoading(false);
    }
  }, [params]);

  function toggleAdmin(adminId: string) {
    if (expandedAdmin === adminId) {
      setExpandedAdmin(null);
      return;
    }
    setExpandedAdmin(adminId);
    setDrilldownTab("test_chat");
    loadDrilldown(adminId, "test_chat");
  }

  function switchTab(tab: "test_chat" | "test_assignment" | "shadow") {
    setDrilldownTab(tab);
    if (expandedAdmin) loadDrilldown(expandedAdmin, tab);
  }

  // ตัวเลขรวมทุก admin
  const totals = useMemo(() => {
    return summary.reduce(
      (acc, s) => ({
        test_chat_messages: acc.test_chat_messages + s.test_chat_messages_rated,
        test_assignment_replays: acc.test_assignment_replays + s.test_assignment_replays,
        shadow_generated: acc.shadow_generated + s.shadow_generated,
        total_comments: acc.total_comments + s.test_chat_commented + s.test_assignment_msg_commented + s.test_assignment_conv_commented + s.shadow_commented,
      }),
      { test_chat_messages: 0, test_assignment_replays: 0, shadow_generated: 0, total_comments: 0 }
    );
  }, [summary]);

  if (loading && summary.length === 0) return <Loading />;
  if (error && summary.length === 0) return <EmptyState icon={BarChart3} title="โหลดข้อมูลไม่สำเร็จ" description={error} />;

  return (
    <PageShell
      icon={BarChart3}
      title="KPI แอดมิน"
      subtitle={
        <>
          สถิติการทดสอบบอทและรีวิวของแอดมินแต่ละคน
          <span className="ml-2 text-text-subtle">· dev/superadmin เท่านั้น</span>
        </>
      }
      actions={
        <>
          <UnifiedDateRangePicker value={dateRange} onChange={setDateRange} />
          <button
            onClick={loadSummary}
            className="p-2 rounded-md text-text-muted hover:bg-surface-subtle hover:text-text transition-colors"
            title="รีเฟรช"
            aria-label="รีเฟรช"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </>
      }
      contentClassName=""
    >

      {/* Summary cards */}
      <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-text-muted text-xs mb-1">
            <Bot size={14} /> ทดสอบแชท
          </div>
          <div className="text-2xl font-bold text-text">{totals.test_chat_messages}</div>
          <div className="text-[11px] text-text-subtle">คำตอบที่ให้คะแนน</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-text-muted text-xs mb-1">
            <TestTube2 size={14} /> ทดสอบจ่ายงาน
          </div>
          <div className="text-2xl font-bold text-text">{totals.test_assignment_replays}</div>
          <div className="text-[11px] text-text-subtle">ครั้งที่กดรีเพลย์</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-text-muted text-xs mb-1">
            <FlaskConical size={14} /> Shadow Inbox
          </div>
          <div className="text-2xl font-bold text-text">{totals.shadow_generated}</div>
          <div className="text-[11px] text-text-subtle">ครั้งที่กด Generate (manual)</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-text-muted text-xs mb-1">
            <MessageSquare size={14} /> คอมเมนต์รวม
          </div>
          <div className="text-2xl font-bold text-text">{totals.total_comments}</div>
          <div className="text-[11px] text-text-subtle">จากทุกระบบ</div>
        </Card>
      </div>

      {/* Admin table */}
      <div className="px-6 pb-6">
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-surface-subtle">
            <h2 className="text-sm font-semibold text-text">รายการแอดมิน ({summary.length})</h2>
            <p className="text-[11px] text-text-subtle">กดที่แถวเพื่อดูรายละเอียด</p>
          </div>
          {summary.length === 0 ? (
            <EmptyState icon={User} title="ไม่มีข้อมูล" description="ยังไม่มี activity ในช่วงเวลาที่เลือก" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-subtle/50 text-text-muted text-xs">
                  {/* Group header row — แบ่ง 3 ระบบ */}
                  <tr>
                    <th rowSpan={2} className="text-left px-3 py-2 font-medium border-r border-border">แอดมิน</th>
                    <th colSpan={5} className="text-center px-2 py-1.5 font-semibold text-brand bg-brand/5 border-r border-border">ทดสอบแชท</th>
                    <th colSpan={4} className="text-center px-2 py-1.5 font-semibold text-brand bg-brand/5 border-r border-border">ทดสอบจ่ายงาน</th>
                    <th colSpan={3} className="text-center px-2 py-1.5 font-semibold text-brand bg-brand/5">Shadow Inbox</th>
                  </tr>
                  <tr>
                    {/* ทดสอบแชท */}
                    <th className="text-center px-2 py-2 font-medium">เซสชันที่รีวิว</th>
                    <th className="text-center px-2 py-2 font-medium">คำตอบที่ให้คะแนน</th>
                    <th className="text-center px-2 py-2 font-medium">ดาวเฉลี่ย</th>
                    <th className="text-center px-2 py-2 font-medium">ดี / ไม่ดี</th>
                    <th className="text-center px-2 py-2 font-medium">คอมเมนต์</th>
                    {/* ทดสอบจ่ายงาน */}
                    <th className="text-center px-2 py-2 font-medium">กดรีเพลย์</th>
                    <th className="text-center px-2 py-2 font-medium">ให้คะแนนคำตอบ</th>
                    <th className="text-center px-2 py-2 font-medium">ให้คะแนนทั้งแชท</th>
                    <th className="text-center px-2 py-2 font-medium">คอมเมนต์</th>
                    {/* Shadow Inbox */}
                    <th className="text-center px-2 py-2 font-medium">กด Generate</th>
                    <th className="text-center px-2 py-2 font-medium">ให้คะแนน</th>
                    <th className="text-center px-2 py-2 font-medium">คอมเมนต์</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((s) => {
                    const expanded = expandedAdmin === s.admin_id;
                    const taComments = s.test_assignment_msg_commented + s.test_assignment_conv_commented;
                    return (
                      <Fragment key={s.admin_id}>
                        <tr
                          onClick={() => toggleAdmin(s.admin_id)}
                          className={`border-t border-border cursor-pointer hover:bg-surface-subtle/50 transition-colors ${expanded ? "bg-brand/5" : ""}`}
                        >
                          <td className="px-3 py-2 border-r border-border">
                            <div className="flex items-center gap-2">
                              {expanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                              <div>
                                <div className="font-medium text-text">{s.name || s.username || s.admin_id}</div>
                                <div className="flex items-center gap-1.5 text-[11px] text-text-subtle">
                                  {s.role && (
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${roleColor[s.role] || ""}`}>
                                      {roleLabel[s.role] || s.role}
                                    </span>
                                  )}
                                  <span>{s.admin_id}</span>
                                </div>
                              </div>
                            </div>
                          </td>
                          {/* ทดสอบแชท */}
                          <td className="text-center px-2 py-2 text-text">{s.test_chat_sessions_rated || "—"}</td>
                          <td className="text-center px-2 py-2 text-text">{s.test_chat_messages_rated || "—"}</td>
                          <td className="text-center px-2 py-2">
                            {s.test_chat_avg_star > 0 ? (
                              <span className="inline-flex items-center gap-0.5 text-warning">
                                <Star size={12} className="fill-current" />
                                {s.test_chat_avg_star}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="text-center px-2 py-2 text-xs">
                            <span className="text-success">{s.test_chat_good}</span>
                            <span className="text-text-subtle">/</span>
                            <span className="text-error">{s.test_chat_bad}</span>
                          </td>
                          <td className="text-center px-2 py-2 text-text">{s.test_chat_commented || "—"}</td>
                          {/* ทดสอบจ่ายงาน */}
                          <td className="text-center px-2 py-2 text-text">{s.test_assignment_replays || "—"}</td>
                          <td className="text-center px-2 py-2 text-text">{s.test_assignment_msg_rated || "—"}</td>
                          <td className="text-center px-2 py-2 text-text">{s.test_assignment_conv_rated || "—"}</td>
                          <td className="text-center px-2 py-2 text-text">{taComments || "—"}</td>
                          {/* Shadow Inbox */}
                          <td className="text-center px-2 py-2 text-text">{s.shadow_generated || "—"}</td>
                          <td className="text-center px-2 py-2 text-text">{(s.shadow_rated + s.shadow_star_rated) || "—"}</td>
                          <td className="text-center px-2 py-2 text-text">{s.shadow_commented || "—"}</td>
                        </tr>
                        {expanded && (
                          <tr key={`${s.admin_id}-detail`} className="bg-surface-subtle/30">
                            <td colSpan={13} className="px-4 py-3">
                              {/* Tab buttons */}
                              <div className="flex items-center gap-1 mb-3">
                                {([
                                  { key: "test_chat", label: "เซสชันทดสอบแชท", icon: Bot },
                                  { key: "test_assignment", label: "การรีเพลย์ทดสอบจ่ายงาน", icon: TestTube2 },
                                  { key: "shadow", label: "การ Generate Shadow", icon: FlaskConical },
                                ] as const).map((t) => (
                                  <button
                                    key={t.key}
                                    onClick={() => switchTab(t.key)}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                      drilldownTab === t.key
                                        ? "bg-brand text-white"
                                        : "bg-surface text-text-muted hover:bg-surface-subtle"
                                    }`}
                                  >
                                    <t.icon size={12} />
                                    {t.label}
                                  </button>
                                ))}
                              </div>

                              {drilldownLoading ? (
                                <Loading />
                              ) : drilldownTab === "test_chat" ? (
                                <DrilldownSessionsTable sessions={drilldownData.sessions || []} />
                              ) : drilldownTab === "test_assignment" ? (
                                <DrilldownReplaysTable replays={drilldownData.replays || []} />
                              ) : (
                                <DrilldownShadowsTable shadows={drilldownData.shadows || []} />
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}

// ─────────────────────────────────────────────────────────────
// Drill-down tables
// ─────────────────────────────────────────────────────────────

function DrilldownSessionsTable({ sessions }: { sessions: DrilldownSession[] }) {
  if (sessions.length === 0) return <EmptyState icon={Bot} title="ไม่มีเซสชัน" description="ยังไม่ได้ให้คะแนนทดสอบแชทในช่วงเวลานี้" />;
  return (
    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="text-text-muted text-xs sticky top-0 bg-surface">
          <tr>
            <th className="text-left px-3 py-2 font-medium">รหัสเซสชัน</th>
            <th className="text-left px-2 py-2 font-medium">แพลตฟอร์ม</th>
            <th className="text-left px-2 py-2 font-medium">ร้านค้า</th>
            <th className="text-center px-2 py-2 font-medium">คำตอบที่ให้คะแนน</th>
            <th className="text-center px-2 py-2 font-medium">ดาวเฉลี่ย</th>
            <th className="text-center px-2 py-2 font-medium">คอมเมนต์</th>
            <th className="text-left px-2 py-2 font-medium">ให้คะแนนล่าสุด</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.session_id} className="border-t border-border">
              <td className="px-3 py-2 font-mono text-xs text-text">{s.session_id.slice(-12)}</td>
              <td className="px-2 py-2 text-text">{s.platform || "—"}</td>
              <td className="px-2 py-2 text-text">{s.shop || "—"}</td>
              <td className="text-center px-2 py-2 text-text">{s.messages_rated}</td>
              <td className="text-center px-2 py-2">
                {s.avg_star > 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-warning">
                    <Star size={12} className="fill-current" />
                    {s.avg_star}
                  </span>
                ) : "—"}
              </td>
              <td className="text-center px-2 py-2 text-text">{s.comments || "—"}</td>
              <td className="px-2 py-2 text-xs text-text-muted">{fmtDate(s.last_rated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DrilldownReplaysTable({ replays }: { replays: DrilldownReplay[] }) {
  if (replays.length === 0) return <EmptyState icon={TestTube2} title="ไม่มีการรีเพลย์" description="ยังไม่ได้กดรีเพลย์ในช่วงเวลานี้" />;
  return (
    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="text-text-muted text-xs sticky top-0 bg-surface">
          <tr>
            <th className="text-left px-3 py-2 font-medium">รหัสแชท</th>
            <th className="text-left px-2 py-2 font-medium">ร้านค้า</th>
            <th className="text-left px-2 py-2 font-medium">แพลตฟอร์ม</th>
            <th className="text-center px-2 py-2 font-medium">ประมวลผล / ทั้งหมด</th>
            <th className="text-center px-2 py-2 font-medium">ให้คะแนน</th>
            <th className="text-center px-2 py-2 font-medium">ดาว</th>
            <th className="text-left px-2 py-2 font-medium">สถานะ</th>
            <th className="text-left px-2 py-2 font-medium">คอมเมนต์</th>
            <th className="text-left px-2 py-2 font-medium">กดรีเพลย์เมื่อ</th>
          </tr>
        </thead>
        <tbody>
          {replays.map((r) => (
            <tr key={r.conversation_id} className="border-t border-border">
              <td className="px-3 py-2 font-mono text-xs text-text">{r.conversation_id.slice(-12)}</td>
              <td className="px-2 py-2 text-text">{r.shop_name || "—"}</td>
              <td className="px-2 py-2 text-text">{r.platform || "—"}</td>
              <td className="text-center px-2 py-2 text-text">{r.processed_messages}/{r.total_messages}</td>
              <td className="text-center px-2 py-2 text-text">{r.msg_rated}</td>
              <td className="text-center px-2 py-2">
                {r.conv_star_rating != null ? (
                  <span className="inline-flex items-center gap-0.5 text-warning">
                    <Star size={12} className="fill-current" />
                    {r.conv_star_rating}
                  </span>
                ) : "—"}
              </td>
              <td className="px-2 py-2 text-xs">
                <span className={`px-1.5 py-0.5 rounded ${
                  r.final_status === "bot_answered" ? "bg-success-soft text-success-dark" :
                  r.final_status === "handed_off" ? "bg-warning-soft text-warning-dark" :
                  "bg-surface-subtle text-text-muted"
                }`}>
                  {r.final_status}
                </span>
              </td>
              <td className="px-2 py-2 text-xs text-text-muted max-w-xs truncate" title={r.conv_comment || ""}>
                {r.conv_comment || "—"}
              </td>
              <td className="px-2 py-2 text-xs text-text-muted">{fmtDate(r.replayed_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DrilldownShadowsTable({ shadows }: { shadows: DrilldownShadow[] }) {
  if (shadows.length === 0) return <EmptyState icon={FlaskConical} title="ไม่มี Shadow Reply" description="ยังไม่ได้ Generate ในช่วงเวลานี้" />;
  return (
    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="text-text-muted text-xs sticky top-0 bg-surface">
          <tr>
            <th className="text-left px-3 py-2 font-medium">รหัส Shadow</th>
            <th className="text-left px-2 py-2 font-medium">รหัสแชท</th>
            <th className="text-left px-2 py-2 font-medium">แพลตฟอร์ม</th>
            <th className="text-left px-2 py-2 font-medium">ประเภท</th>
            <th className="text-left px-2 py-2 font-medium">แหล่งบอท</th>
            <th className="text-center px-2 py-2 font-medium">คะแนน</th>
            <th className="text-center px-2 py-2 font-medium">ดาว</th>
            <th className="text-center px-2 py-2 font-medium">คอมเมนต์</th>
            <th className="text-left px-2 py-2 font-medium">สร้างเมื่อ</th>
          </tr>
        </thead>
        <tbody>
          {shadows.map((s) => (
            <tr key={s.shadow_reply_id} className="border-t border-border">
              <td className="px-3 py-2 font-mono text-xs text-text">{s.shadow_reply_id.slice(-12)}</td>
              <td className="px-2 py-2 font-mono text-xs text-text">{s.conversation_id.slice(-12)}</td>
              <td className="px-2 py-2 text-text">{s.platform}</td>
              <td className="px-2 py-2 text-xs text-text-muted">
                {s.origin === "manual_conversation" ? "Generate ทั้งแชท" : "Generate ทีละข้อความ"}
              </td>
              <td className="px-2 py-2 text-xs text-text-muted">{s.bot_source || "—"}</td>
              <td className="text-center px-2 py-2 text-xs">
                {s.rating ? (
                  <span className={
                    s.rating === "good" ? "text-success" :
                    s.rating === "bad" ? "text-error" :
                    "text-text-subtle"
                  }>{s.rating === "good" ? "ดี" : s.rating === "bad" ? "ไม่ดี" : s.rating}</span>
                ) : "—"}
              </td>
              <td className="text-center px-2 py-2">
                {s.star_rating != null ? (
                  <span className="inline-flex items-center gap-0.5 text-warning">
                    <Star size={12} className="fill-current" />
                    {s.star_rating}
                  </span>
                ) : "—"}
              </td>
              <td className="text-center px-2 py-2 text-text">{s.has_comment ? "✓" : "—"}</td>
              <td className="px-2 py-2 text-xs text-text-muted">{fmtDate(s.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
