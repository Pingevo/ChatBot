"use client";
// Test Assignment — ทดสอบการจ่ายงาน (layout เหมือน shadow-inbox)
// ซ้าย: list + filter (search/platform/rating/status)
// กลาง: chat full (user/zaapi/bot) + RateBox ใต้ bubble bot + conversation rating ใน panel per chat
// ขวา: ShadowStatPanel-like stats
import { useState, useEffect, useCallback, useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { RateBox } from "@/components/shadow/RateBox";
import { MessageContent } from "@/components/chat/MessageContent";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { toast, useToastError } from "@/components/ui/Toast";
import {
  FlaskConical, RefreshCw, Zap, Users, Activity,
  CheckCircle, XCircle, AlertCircle, ChevronDown,
  Store, Bot, User, Star, Search, BarChart3,
  PlayCircle, PauseCircle, MessageSquare, Clock,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { api } from "@/lib/apiClient";
import { usePolling } from "@/lib/usePolling";
import type { Platform } from "@/lib/types";

// ─── Types ────────────────────────────────────────────────

interface ConvRow {
  id: string;
  conversation_id: string;
  shop_id: string;
  platform: string;
  status: string;
  assigned_to: string | null;
  to_name?: string;
  shop_name?: string;
  last_message_timestamp?: string;
  replay_status?: string;
  replay_assigned_to?: string | null;
  mock_status?: string;
  conv_star_rating?: number;
  conv_rating?: string;
}

interface AgentInfo {
  admin_id: string;
  name: string;
  username: string;
  role: string;
  is_accepting_chats: boolean;
  active: boolean;
}

interface StatusData {
  config: { bot_worker_enabled: boolean; bot_worker_interval_ms: number; shopee_bot_url: string; };
  assignment_mode: string;
  agents: AgentInfo[];
}

interface ChatMessage {
  message_id: string;
  id: string;
  role: string;
  direction: string;
  text: string;
  source?: string;
  admin_id?: string;
  timestamp: string;
  // rich media (parsed from raw_payload)
  message_type?: string;
  media?: { type: string; url?: string; thumbnail_url?: string; duration?: number };
  order_sn?: string;
  notification_text?: string;
  table?: { headers?: string[]; rows?: string[][] };
  products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
}

interface QaItem {
  index: number;
  message_id: string;
  user_text: string;
  // rich media ของ user message
  user_message_type?: string;
  user_media?: { type: string; url?: string; thumb_url?: string; duration?: number };
  user_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  user_order_sn?: string;
  user_notification_text?: string;
  user_table?: { headers?: string[]; rows?: string[][] };
  // bot reply
  trigger_name?: string;
  trigger_action?: string;
  bot_reply?: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed?: number;
  status: "bot_answered" | "trigger_matched" | "handed_off" | "no_agent" | "error";
  assigned_to?: string | null;
  detail: string;
}

interface MessageRating {
  star_rating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
}

interface ReplayResult {
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  shop_name?: string;
  to_name?: string;
  qa: QaItem[];
  total_messages: number;
  processed_messages: number;
  final_status: string;
  assigned_to?: string | null;
  stopped_at_handoff: boolean;
  mock_status?: "open" | "closed";
  message_ratings?: Record<string, MessageRating>;
  conv_star_rating?: number;
  conv_rating?: "good" | "bad" | "unrated";
  conv_comment?: string;
}

interface ConvDetail {
  conversation: {
    conversation_id: string; shop_id: string; platform: string;
    shop_name?: string; to_name?: string; assigned_to: string | null; status: string;
  } | null;
  messages: ChatMessage[];
  replay: ReplayResult | null;
}

interface Stats {
  total: number;
  bot_answered: number;
  handed_off: number;
  no_agent: number;
  error: number;
  open: number;
  closed: number;
  conv_star_rated: number;
  conv_avg_star: number;
  conv_good: number;
  conv_bad: number;
  msg_star_rated: number;
  msg_avg_star: number;
  msg_good: number;
  msg_bad: number;
}

// ─── Constants ────────────────────────────────────────────

const platformLabels: Record<string, string> = { shopee: "Shopee", tiktok: "TikTok", lazada: "Lazada" };
const platformColors: Record<string, string> = { shopee: "#ee4d2d", tiktok: "#111827", lazada: "#1a2e8c" };
const modeLabels: Record<string, string> = { equal_global: "Global", equal_per_shop: "Per Shop", equal_per_platform: "Per Platform" };

type StatusFilter = "all" | "bot" | "admin" | "handoff" | "closed" | "error";
type PlatformFilter = "all" | Platform;
type SortOption = "recent" | "oldest" | "platform";

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "เมื่อสักครู่";
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชม.`;
  const d = Math.floor(h / 24);
  return `${d} วัน`;
}

// ─── Page ─────────────────────────────────────────────────

export default function TestAssignmentPage() {
  const { catchError } = useToastError();
  const [replayOrder, setReplayOrder] = useState<"recent" | "oldest">("recent");
  const [convs, setConvs] = useState<ConvRow[]>([]);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConvDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; handedOff: number; errors: number } | null>(null);

  // ── Load list + status ──
  const loadList = useCallback(async () => {
    try {
      const [convRes, statusRes] = await Promise.all([
        api().get<{ rows: ConvRow[]; total: number }>("/test-assignment", { params: { list: "1", limit: "100", order: replayOrder } }),
        api().get<StatusData>("/test-assignment"),
      ]);
      setConvs(convRes.data.rows || []);
      setStatus(statusRes.data);
    } catch (err) {
      catchError(err, "โหลดไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError, replayOrder]);

  const loadStats = useCallback(async () => {
    try {
      const r = await api().get<Stats>("/test-assignment", { params: { stats: "1" } });
      setStats(r.data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadStats(); }, [loadStats]);
  usePolling(loadStats, 10000);

  // ── Load detail ──
  const loadDetail = useCallback(async (convId: string) => {
    setSelectedId(convId);
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await api().get<ConvDetail>("/test-assignment", { params: { conv_detail: "1", conversation_id: convId } });
      setDetail(r.data);
    } catch (err) {
      catchError(err, "โหลดแชทไม่สำเร็จ");
    } finally {
      setDetailLoading(false);
    }
  }, [catchError]);

  // ── Replay ──
  async function handleReplay(convId: string) {
    setReplaying(true);
    try {
      await api().post("/test-assignment", { action: "replay_conversation", conversation_id: convId });
      toast.success("Replay สำเร็จ");
      await loadDetail(convId);
      await loadList();
      await loadStats();
    } catch (err) {
      catchError(err, "Replay ไม่สำเร็จ");
    } finally {
      setReplaying(false);
    }
  }

  // ── Batch replay (100 max) ──
  async function handleBatchReplay() {
    if (convs.length === 0) { toast.error("ไม่มี conversation"); return; }
    setBatchProgress({ done: 0, total: convs.length, handedOff: 0, errors: 0 });
    setReplaying(true);
    let handedOff = 0;
    let errors = 0;
    try {
      for (let i = 0; i < convs.length; i++) {
        try {
          await api().post("/test-assignment", { action: "replay_conversation", conversation_id: convs[i].conversation_id }, { timeout: 300000 });
          if (convs[i]) handedOff++; // approximate
        } catch {
          errors++;
        }
        setBatchProgress({ done: i + 1, total: convs.length, handedOff, errors });
        if (errors >= 3 && errors === i + 1) {
          toast.error("หยุด — error 3 ครั้งแรก");
          break;
        }
      }
      toast.success(`เสร็จ: ${convs.length} conversation, ${handedOff} สำเร็จ, ${errors} error`);
      await loadList();
      await loadStats();
    } catch (err) {
      catchError(err, "Batch replay ไม่สำเร็จ");
    } finally {
      setReplaying(false);
      setBatchProgress(null);
    }
  }

  // ── Rate message ──
  async function handleRateMessage(messageId: string, field: "star" | "rating" | "comment", value: number | string) {
    if (!selectedId) return;
    const body: Record<string, unknown> = { action: "rate_message", conversation_id: selectedId, message_id: messageId };
    if (field === "star") body.star_rating = value;
    if (field === "rating") body.rating = value;
    if (field === "comment") body.comment = value;
    try {
      await api().post("/test-assignment", body);
      await loadDetail(selectedId);
      await loadStats();
    } catch (err) {
      catchError(err, "บันทึกคะแนนไม่สำเร็จ");
    }
  }

  // ── Rate conversation ──
  async function handleRateConversation(field: "star" | "rating" | "comment", value: number | string) {
    if (!selectedId) return;
    const body: Record<string, unknown> = { action: "rate_conversation", conversation_id: selectedId };
    if (field === "star") body.star_rating = value;
    if (field === "rating") body.rating = value;
    if (field === "comment") body.comment = value;
    try {
      await api().post("/test-assignment", body);
      await loadDetail(selectedId);
      await loadList();
      await loadStats();
    } catch (err) {
      catchError(err, "บันทึกคะแนนไม่สำเร็จ");
    }
  }

  const acceptingAgents = status?.agents.filter((a) => a.is_accepting_chats && a.active) || [];
  const replay = detail?.replay;
  const msgRatings = replay?.message_ratings || {};

  // ── Inbox filters ──
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [showPlatformDd, setShowPlatformDd] = useState(false);
  const [showStatusDd, setShowStatusDd] = useState(false);
  const [showSortDd, setShowSortDd] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [statTab, setStatTab] = useState<"per_chat" | "all_history" | "replay">("per_chat");

  const filteredConvs = useMemo(() => {
    let result = convs;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) =>
        (c.to_name || "").toLowerCase().includes(q) ||
        (c.shop_name || "").toLowerCase().includes(q) ||
        (c.conversation_id || "").toLowerCase().includes(q) ||
        (c.shop_id || "").toLowerCase().includes(q)
      );
    }
    if (platformFilter !== "all") {
      result = result.filter((c) => c.platform === platformFilter);
    }
    if (statusFilter !== "all") {
      result = result.filter((c) => {
        if (statusFilter === "bot") return c.replay_status === "bot_answered";
        if (statusFilter === "admin") return c.replay_assigned_to != null;
        if (statusFilter === "handoff") return c.replay_status === "handed_off" || c.replay_status === "no_agent";
        if (statusFilter === "closed") return c.mock_status === "closed";
        if (statusFilter === "error") return c.replay_status === "error";
        return true;
      });
    }
    const sorted = [...result];
    if (sortBy === "recent") {
      sorted.sort((a, b) => new Date(b.last_message_timestamp || 0).getTime() - new Date(a.last_message_timestamp || 0).getTime());
    } else if (sortBy === "oldest") {
      sorted.sort((a, b) => new Date(a.last_message_timestamp || 0).getTime() - new Date(b.last_message_timestamp || 0).getTime());
    } else if (sortBy === "platform") {
      sorted.sort((a, b) => a.platform.localeCompare(b.platform));
    }
    return sorted;
  }, [convs, search, platformFilter, statusFilter, sortBy]);

  function StatusBadge({ c }: { c: ConvRow }) {
    if (c.mock_status === "closed") return <Badge tone="neutral">closed</Badge>;
    if (c.replay_assigned_to) return <Badge tone="brand">admin</Badge>;
    if (c.replay_status === "bot_answered") return <Badge tone="pale">bot</Badge>;
    if (c.replay_status === "handed_off" || c.replay_status === "no_agent") return <Badge tone="coral">handoff</Badge>;
    if (c.replay_status === "error") return <Badge tone="coral">error</Badge>;
    return <Badge tone="neutral">—</Badge>;
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* ── Panel ซ้าย: Inbox list (เหมือน ShadowInboxList) ── */}
      <div className="h-full flex flex-col w-80 min-w-0 shrink-0 border-r border-border overflow-hidden">
        {/* Header */}
        <div className="px-3 py-3 border-b border-border bg-surface shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <FlaskConical size={16} className="text-brand" />
            <h1 className="text-sm font-bold text-text">ทดสอบจ่ายงาน</h1>
            <Badge tone="brand" className="ml-auto">{filteredConvs.length}</Badge>
          </div>

          {/* Search */}
          <div className="relative mb-2">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหา..."
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-surface-2 border border-border rounded-md text-text focus:outline-none focus:border-brand"
            />
          </div>

          {/* Filters */}
          <div className="flex items-center gap-1 flex-wrap">
            {/* Platform */}
            <div className="relative">
              <button onClick={() => { setShowPlatformDd(!showPlatformDd); setShowStatusDd(false); setShowSortDd(false); }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] bg-surface-2 text-text-muted hover:text-text">
                {platformFilter === "all" ? "แพลตฟอร์ม" : platformLabels[platformFilter]}
                <ChevronDown size={10} />
              </button>
              {showPlatformDd && (
                <div className="absolute z-20 top-full mt-1 left-0 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[120px]">
                  {(["all", "shopee", "tiktok", "lazada"] as const).map((p) => (
                    <button key={p} onClick={() => { setPlatformFilter(p); setShowPlatformDd(false); }}
                      className={`w-full text-left px-2.5 py-1 text-[11px] hover:bg-surface-2 ${platformFilter === p ? "text-brand font-medium" : "text-text"}`}>
                      {p === "all" ? "ทั้งหมด" : platformLabels[p]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Status */}
            <div className="relative">
              <button onClick={() => { setShowStatusDd(!showStatusDd); setShowPlatformDd(false); setShowSortDd(false); }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] bg-surface-2 text-text-muted hover:text-text">
                {statusFilter === "all" ? "สถานะ" : statusFilter}
                <ChevronDown size={10} />
              </button>
              {showStatusDd && (
                <div className="absolute z-20 top-full mt-1 left-0 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[100px]">
                  {([
                    { k: "all", l: "ทั้งหมด" },
                    { k: "bot", l: "Bot ตอบ" },
                    { k: "admin", l: "Admin" },
                    { k: "handoff", l: "Handoff" },
                    { k: "closed", l: "Closed" },
                    { k: "error", l: "Error" },
                  ] as const).map((s) => (
                    <button key={s.k} onClick={() => { setStatusFilter(s.k); setShowStatusDd(false); }}
                      className={`w-full text-left px-2.5 py-1 text-[11px] hover:bg-surface-2 ${statusFilter === s.k ? "text-brand font-medium" : "text-text"}`}>
                      {s.l}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Sort */}
            <div className="relative">
              <button onClick={() => { setShowSortDd(!showSortDd); setShowPlatformDd(false); setShowStatusDd(false); }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] bg-surface-2 text-text-muted hover:text-text">
                {sortBy === "recent" ? "ใหม่สุด" : sortBy === "oldest" ? "เก่าสุด" : "platform"}
                <ChevronDown size={10} />
              </button>
              {showSortDd && (
                <div className="absolute z-20 top-full mt-1 left-0 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[100px]">
                  {([
                    { k: "recent", l: "ใหม่สุด" },
                    { k: "oldest", l: "เก่าสุด" },
                    { k: "platform", l: "แพลตฟอร์ม" },
                  ] as const).map((s) => (
                    <button key={s.k} onClick={() => { setSortBy(s.k); setShowSortDd(false); }}
                      className={`w-full text-left px-2.5 py-1 text-[11px] hover:bg-surface-2 ${sortBy === s.k ? "text-brand font-medium" : "text-text"}`}>
                      {s.l}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Batch replay button + order toggle */}
        <div className="px-3 py-2 border-b border-border bg-surface-2/50 shrink-0 space-y-2">
          {/* Order toggle */}
          <div className="flex items-center gap-1 text-[10px]">
            <span className="text-text-muted shrink-0">เลือก:</span>
            <button onClick={() => setReplayOrder("recent")}
              className={`px-2 py-0.5 rounded-md font-medium transition-colors ${
                replayOrder === "recent" ? "bg-brand text-white" : "bg-surface text-text-muted hover:text-text"
              }`}>
              100 ใหม่สุด
            </button>
            <button onClick={() => setReplayOrder("oldest")}
              className={`px-2 py-0.5 rounded-md font-medium transition-colors ${
                replayOrder === "oldest" ? "bg-brand text-white" : "bg-surface text-text-muted hover:text-text"
              }`}>
              100 เก่าสุด
            </button>
          </div>
          {/* Replay button */}
          <button onClick={handleBatchReplay} disabled={replaying || filteredConvs.length === 0}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand-dark disabled:opacity-50 transition-colors">
            {replaying ? <Loading size={12} /> : <Zap size={12} />}
            {batchProgress
              ? `replay... ${batchProgress.done}/${batchProgress.total} (✓${batchProgress.handedOff} ✗${batchProgress.errors})`
              : `Replay ทั้งหมด (${filteredConvs.length})`}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8"><Loading size={24} /></div>
          ) : filteredConvs.length === 0 ? (
            <div className="py-8"><EmptyState icon={FlaskConical} title="ไม่มี conversation" /></div>
          ) : (
            <ul className="divide-y divide-border/50">
              {filteredConvs.map((c, i) => (
                <li key={`${c.conversation_id}-${i}`}>
                  <button onClick={() => loadDetail(c.conversation_id)}
                    className={`w-full text-left px-3 py-2.5 transition-colors ${
                      selectedId === c.conversation_id
                        ? "bg-brand/20 border-l-2 border-brand"
                        : "hover:bg-surface-2"
                    }`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: platformColors[c.platform] || "#888" }} />
                      <span className="text-xs font-medium text-text truncate flex-1">{c.to_name || c.conversation_id}</span>
                      <StatusBadge c={c} />
                    </div>
                    <div className="text-[10px] text-text-muted truncate">
                      {c.shop_name || c.shop_id} · {timeAgo(c.last_message_timestamp)}
                    </div>
                    {c.conv_star_rating != null && c.conv_star_rating > 0 && (
                      <div className="flex items-center gap-0.5 mt-0.5">
                        {[1,2,3,4,5].map((s) => (
                          <Star key={s} size={8} className={c.conv_star_rating! >= s ? "text-yellow-400 fill-yellow-400" : "text-text-subtle"} />
                        ))}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Panel กลาง: Chat (เหมือน ShadowReplyPanel + ChatList) ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-surface flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Activity size={16} className="text-text-muted shrink-0" />
            <h2 className="text-sm font-semibold text-text truncate">
              {detail?.conversation ? `${detail.conversation.to_name || detail.conversation.conversation_id}` : "เลือก conversation"}
            </h2>
            {replay && (
              <Badge tone={replay.final_status === "handed_off" ? "coral" : replay.final_status === "bot_answered" ? "brand" : "neutral"}>
                {replay.final_status}
              </Badge>
            )}
            {replay?.mock_status === "closed" && <Badge tone="neutral">closed</Badge>}
            {replay?.assigned_to && <Badge tone="brand">→ {replay.assigned_to}</Badge>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {selectedId && (
              <Button size="sm" variant="outline" onClick={() => handleReplay(selectedId)} disabled={replaying}>
                {replaying ? <Loading size={12} /> : <RefreshCw size={12} />} Replay
              </Button>
            )}
            <button onClick={() => setRightCollapsed(!rightCollapsed)} className="p-1.5 rounded-md hover:bg-surface-2 text-text-muted">
              {rightCollapsed ? <ChevronDown size={14} className="rotate-90" /> : <ChevronDown size={14} className="-rotate-90" />}
            </button>
          </div>
        </div>

        {/* Content — full width เหมือน shadow-inbox */}
        <div className="flex-1 overflow-y-auto">
          {!selectedId && (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <FlaskConical size={48} className="text-text-subtle mb-3" />
              <p className="text-sm text-text-muted">เลือก conversation จากซ้าย</p>
              <p className="text-xs text-text-subtle mt-1">หรือกด Replay ทั้งหมด (100 conversation ล่าสุด)</p>
            </div>
          )}

          {selectedId && detailLoading && (
            <div className="h-full flex flex-col items-center justify-center">
              <Loading size={32} />
              <p className="text-sm text-text-muted mt-3">กำลังโหลดแชท...</p>
            </div>
          )}

          {selectedId && detail && !detailLoading && (
            <div className="h-full flex flex-col">
              {/* ── Info bar + summary (shrink-0, อยู่ด้านบน) ── */}
              <div className="shrink-0 px-4 py-3 border-b border-border bg-surface space-y-2">
                {detail.conversation && (
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <Store size={12} />
                    <span className="font-medium text-text">{detail.conversation.shop_name || detail.conversation.shop_id}</span>
                    <span className="text-text-subtle">·</span>
                    <span>{platformLabels[detail.conversation.platform] || detail.conversation.platform}</span>
                    {detail.conversation.assigned_to && <Badge tone="brand" className="ml-auto">DB: {detail.conversation.assigned_to}</Badge>}
                  </div>
                )}
                {replay && (
                  <div className="grid grid-cols-4 gap-2">
                    <Card className="p-2 text-center">
                      <div className="text-[10px] text-text-muted">Q&A</div>
                      <div className="text-sm font-bold text-text">{replay.processed_messages}/{replay.total_messages}</div>
                    </Card>
                    <Card className="p-2 text-center">
                      <div className="text-[10px] text-text-muted">จ่ายให้</div>
                      <div className="text-sm font-bold text-brand truncate">{replay.assigned_to || "—"}</div>
                    </Card>
                    <Card className="p-2 text-center">
                      <div className="text-[10px] text-text-muted">สถานะ</div>
                      <div className="text-sm font-bold">{replay.mock_status === "closed" ? "closed" : "open"}</div>
                    </Card>
                    <Card className="p-2 text-center">
                      <div className="text-[10px] text-text-muted">ดาวทั้งแชท</div>
                      <div className="text-sm font-bold">{replay.conv_star_rating || "—"}</div>
                    </Card>
                  </div>
                )}
              </div>

              {/* ── 2 คอลัมน์เต็มจอ (flex-1) ── */}

              {/* ── Side-by-side: ซ้าย=user/zaapi (แชทจริง) | ขวา=user/bot (replay) ── เต็มจอ */}
              {(detail.messages.length > 0 || (replay && replay.qa.length > 0)) && (
                <div className="flex-1 flex min-h-0 overflow-hidden">
                  {/* ── ฝั่งซ้าย: Zaapi / admin / user (แชทจริง DB) ── */}
                  <div className="flex-1 flex flex-col border-r border-border min-w-0">
                    <div className="px-3 py-2 border-b border-border bg-surface-2 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <div className="w-6 h-6 rounded-md bg-deep-space/10 flex items-center justify-center">
                          <Bot size={12} className="text-deep-space" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-text">Zaapi / Admin</div>
                          <div className="text-[10px] text-text-subtle">แชทจริงใน DB</div>
                        </div>
                      </div>
                    </div>
                    <div className="flex-1 p-3 space-y-2 overflow-y-auto">
                      {detail.messages.length === 0 ? (
                        <div className="text-xs text-text-subtle italic py-4 text-center">ไม่มีข้อความใน DB</div>
                      ) : (
                        detail.messages.map((m, i) => {
                          const isUser = m.direction === "in";
                          const isAdmin = m.source === "admin";
                          const isBot = m.source && m.source !== "admin" && m.direction === "out";
                          // admin = พื้นเข้ม (variant=out, text-white)
                          // zaapi/bot อื่น = พื้นอ่อน (variant=user, text-text)
                          const isDarkBubble = isAdmin;
                          return (
                            <div key={`${m.message_id}-${i}`} className={`flex ${isUser ? "justify-start" : "justify-end"}`}>
                              <div className="max-w-[85%]">
                                <div className="text-[9px] text-text-subtle mb-0.5 px-1 flex items-center gap-1">
                                  {isUser ? <><User size={8} /> ลูกค้า</> : isAdmin ? <><Users size={8} /> Admin{m.admin_id ? ` · ${m.admin_id}` : ""}</> : isBot ? <><Bot size={8} /> Bot{m.source ? ` · ${m.source}` : ""}</> : "ร้าน"}
                                </div>
                                <div className={`rounded-lg px-3 py-2 text-sm ${
                                  isUser ? "bg-surface border border-border" : isDarkBubble ? "bg-deep-space" : "bg-surface-2 border border-border"
                                }`}>
                                  <MessageContent msg={m as never} variant={isDarkBubble ? "out" : "user"} />
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* ── ฝั่งขวา: Bot ของเรา (replay) ── */}
                  <div className="flex-1 flex flex-col min-w-0">
                    <div className="px-3 py-2 border-b border-border bg-brand/5 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <div className="w-6 h-6 rounded-md bg-brand/15 flex items-center justify-center">
                          <FlaskConical size={12} className="text-brand" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-text">Bot ของเรา (Replay)</div>
                          <div className="text-[10px] text-text-subtle">trigger → bot → handoff</div>
                        </div>
                      </div>
                    </div>
                    <div className="flex-1 p-3 space-y-3 overflow-y-auto">
                      {!replay || replay.qa.length === 0 ? (
                        <div className="text-xs text-text-subtle italic py-4 text-center">
                          ยังไม่ได้ replay — กดปุ่ม Replay ด้านบน
                        </div>
                      ) : (
                        replay.qa.map((qa, i) => {
                          const mr = msgRatings[qa.message_id] || {};
                          return (
                            <div key={`${qa.message_id}-${i}`} className="space-y-2">
                              {/* User question (เหมือนฝั่งซ้าย) */}
                              <div className="flex justify-start">
                                <div className="max-w-[85%]">
                                  <div className="text-[9px] text-text-subtle mb-0.5 px-1 flex items-center gap-1">
                                    <User size={8} /> ลูกค้า · Q{qa.index + 1}
                                  </div>
                                  <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-3 py-2 text-sm text-text">
                                    {qa.user_message_type || qa.user_media || qa.user_products ? (
                                      <MessageContent
                                        msg={{
                                          id: qa.message_id,
                                          role: "user",
                                          text: qa.user_text,
                                          timestamp: "",
                                          message_type: qa.user_message_type as never,
                                          media: qa.user_media as never,
                                          products: qa.user_products as never,
                                          order_sn: qa.user_order_sn,
                                          notification_text: qa.user_notification_text,
                                          table: qa.user_table as never,
                                        }}
                                        variant="user"
                                      />
                                    ) : (
                                      <span className="whitespace-pre-wrap">{qa.user_text}</span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {/* Trigger badge */}
                              {qa.trigger_name && (
                                <div className="flex items-center gap-1.5 text-[10px] px-1">
                                  <Zap size={10} className="text-brand" />
                                  <span className="text-brand font-medium">trigger: {qa.trigger_name}</span>
                                  <span className="text-text-subtle">→ {qa.trigger_action}</span>
                                </div>
                              )}

                              {/* Bot reply or handoff */}
                              <div className="flex justify-end">
                                <div className="max-w-[85%] w-full">
                                  <div className="text-[9px] text-text-subtle mb-0.5 px-1 text-right flex items-center gap-1 justify-end">
                                    {qa.status === "handed_off" || qa.status === "no_agent" ? (
                                      <><Users size={8} /> ระบบ</>
                                    ) : (
                                      <><Bot size={8} /> บอท{qa.bot_model && ` · ${qa.bot_model}`}{qa.bot_elapsed != null && ` · ${qa.bot_elapsed}ms`}</>
                                    )}
                                  </div>
                                  {qa.bot_reply ? (
                                    <>
                                      {/* ⚡ Multi-bubble: split ด้วย ||| เหมือน TicketChatPanel
                                          แต่ละ segment = 1 bubble, RateBox อยู่หลัง segment สุดท้าย */}
                                      {(() => {
                                        const segments = splitAnswerSegments(qa.bot_reply);
                                        return segments.map((seg, i) => (
                                          <div
                                            key={i}
                                            className="bg-brand text-white rounded-lg rounded-tr-sm px-3 py-2 text-sm whitespace-pre-wrap"
                                          >
                                            {seg}
                                          </div>
                                        ));
                                      })()}
                                      {/* RateBox ใต้ bubble ของ bot (เหมือน shadow reply) */}
                                      <RateBox
                                        starRating={mr.star_rating}
                                        rating={mr.rating as "good" | "bad" | "unrated" | undefined}
                                        comment={mr.comment}
                                        onStar={(s) => handleRateMessage(qa.message_id, "star", s)}
                                        onRate={(rt) => handleRateMessage(qa.message_id, "rating", rt)}
                                        onComment={(c) => handleRateMessage(qa.message_id, "comment", c)}
                                      />
                                    </>
                                  ) : qa.status === "handed_off" ? (
                                    <div className="bg-brand/10 border border-brand/30 rounded-lg px-3 py-2 text-sm">
                                      <div className="font-medium text-brand">→ จ่ายงานให้ {qa.assigned_to}</div>
                                      <div className="text-[11px] text-text-muted mt-0.5">{qa.detail}</div>
                                    </div>
                                  ) : qa.status === "no_agent" ? (
                                    <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-sm">
                                      <div className="font-medium text-yellow-600">ไม่มี agent ว่าง</div>
                                      <div className="text-[11px] text-text-muted mt-0.5">{qa.detail}</div>
                                    </div>
                                  ) : qa.status === "error" ? (
                                    <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-500">{qa.detail}</div>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Panel ขวา: Stats (เหมือน ShadowStatPanel — tab: Per Chat / All History / Replay) ── */}
      {!rightCollapsed && (
        <div className="hidden md:flex h-full shrink-0 overflow-hidden w-72 border-l border-border">
          <div className="h-full flex flex-col w-full overflow-hidden">
            {/* Tab menu */}
            <div className="px-3 py-2 border-b border-border bg-surface shrink-0">
              <div className="flex items-center gap-1">
                {([
                  { k: "per_chat", l: "Per Chat" },
                  { k: "all_history", l: "All History" },
                  { k: "replay", l: "Replay" },
                ] as const).map((t) => (
                  <button key={t.k} onClick={() => setStatTab(t.k)}
                    className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                      statTab === t.k ? "bg-brand text-white" : "bg-surface-2 text-text-muted hover:text-text"
                    }`}>
                    {t.l}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {/* ── Tab: Per Chat — คะแนนทั้งแชทของ conversation ที่เลือก ── */}
              {statTab === "per_chat" && (
                <>
                  {!selectedId || !replay ? (
                    <div className="text-center py-8 text-xs text-text-subtle">เลือก conversation ก่อน</div>
                  ) : (
                    <>
                      {/* Conversation rating (ทั้งแชท) */}
                      <Card className="p-3">
                        <div className="text-[10px] text-text-muted mb-2 font-medium">ให้คะแนนทั้งแชท</div>
                        <RateBox
                          starRating={replay.conv_star_rating}
                          rating={replay.conv_rating}
                          comment={replay.conv_comment}
                          onStar={(s) => handleRateConversation("star", s)}
                          onRate={(rt) => handleRateConversation("rating", rt)}
                          onComment={(c) => handleRateConversation("comment", c)}
                        />
                      </Card>

                      {/* Per-chat stats */}
                      <Card className="p-3">
                        <div className="text-[10px] text-text-muted mb-2 font-medium">สถานะแชทนี้</div>
                        <div className="space-y-1.5 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-text-muted">Q&A</span>
                            <span className="font-bold">{replay.processed_messages}/{replay.total_messages}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-text-muted">สถานะ</span>
                            <Badge tone={replay.final_status === "handed_off" ? "coral" : "brand"}>{replay.final_status}</Badge>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-text-muted">Mock status</span>
                            <span className="font-bold">{replay.mock_status}</span>
                          </div>
                          {replay.assigned_to && (
                            <div className="flex items-center justify-between">
                              <span className="text-text-muted">จ่ายให้</span>
                              <span className="text-brand font-bold">{replay.assigned_to}</span>
                            </div>
                          )}
                          {replay.stopped_at_handoff && (
                            <div className="text-[10px] text-coral mt-1">หยุดที่ handoff</div>
                          )}
                        </div>
                      </Card>
                    </>
                  )}
                </>
              )}

              {/* ── Tab: All History — สถิติรวมทั้งหมด ── */}
              {statTab === "all_history" && (
                <>
                  {/* System config */}
                  <Card className="p-3">
                    <div className="text-[10px] text-text-muted mb-2 font-medium">ระบบ</div>
                    <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">Bot Worker</span>
                    {status?.config.bot_worker_enabled ? (
                      <span className="flex items-center gap-1 text-green-500"><CheckCircle size={12} /> เปิด</span>
                    ) : (
                      <span className="flex items-center gap-1 text-text-subtle"><XCircle size={12} /> ปิด</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">โหมดจ่ายงาน</span>
                    <span className="text-text font-medium">{status ? modeLabels[status.assignment_mode] : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted">Agent รับแชท</span>
                    <span className="text-text font-medium">{acceptingAgents.length}/{status?.agents.length || 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted flex items-center gap-1"><Clock size={10} /> Interval</span>
                    <span className="text-text font-medium">{status?.config.bot_worker_interval_ms || "—"}ms</span>
                  </div>
                </div>
              </Card>

              {/* Replay results */}
              {stats && (
                <Card className="p-3">
                  <div className="text-[10px] text-text-muted mb-2 font-medium">ผล Replay</div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">ทั้งหมด</span>
                      <span className="text-text font-bold">{stats.total}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-green-500"><Bot size={10} /> บอทตอบ</span>
                      <span className="text-green-500 font-bold">{stats.bot_answered}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-brand"><Users size={10} /> Handoff</span>
                      <span className="text-brand font-bold">{stats.handed_off}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">ไม่มี agent</span>
                      <span className="font-bold">{stats.no_agent}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-red-500"><AlertCircle size={10} /> Error</span>
                      <span className="text-red-500 font-bold">{stats.error}</span>
                    </div>
                    <div className="border-t border-border/50 pt-1.5 mt-1.5 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-text-muted">Open</span>
                        <span className="font-bold">{stats.open}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-text-muted">Closed (mock)</span>
                        <span className="font-bold">{stats.closed}</span>
                      </div>
                    </div>
                  </div>
                </Card>
              )}

              {/* Conversation ratings (per-chat) */}
              {stats && (
                <Card className="p-3">
                  <div className="text-[10px] text-text-muted mb-2 font-medium">คะแนนทั้งแชท</div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center gap-1">
                      {[1,2,3,4,5].map((s) => (
                        <Star key={s} size={10} className={stats.conv_avg_star >= s ? "text-yellow-400 fill-yellow-400" : "text-text-subtle"} />
                      ))}
                      <span className="text-text font-bold ml-1">{stats.conv_avg_star || "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-green-600">Good</span>
                      <span className="font-bold">{stats.conv_good}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-red-600">Bad</span>
                      <span className="font-bold">{stats.conv_bad}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">ให้ดาว</span>
                      <span className="font-bold">{stats.conv_star_rated}</span>
                    </div>
                  </div>
                </Card>
              )}

              {/* Per-message ratings */}
              {stats && (
                <Card className="p-3">
                  <div className="text-[10px] text-text-muted mb-2 font-medium">คะแนนรายคำตอบ</div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center gap-1">
                      {[1,2,3,4,5].map((s) => (
                        <Star key={s} size={10} className={stats.msg_avg_star >= s ? "text-yellow-400 fill-yellow-400" : "text-text-subtle"} />
                      ))}
                      <span className="text-text font-bold ml-1">{stats.msg_avg_star || "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-green-600">Good</span>
                      <span className="font-bold">{stats.msg_good}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-red-600">Bad</span>
                      <span className="font-bold">{stats.msg_bad}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">ให้ดาว</span>
                      <span className="font-bold">{stats.msg_star_rated}</span>
                    </div>
                  </div>
                </Card>
              )}

                  {/* Agents list */}
                  <Card className="p-3">
                    <div className="text-[10px] text-text-muted mb-2 font-medium">Agents</div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {status?.agents.map((a, i) => (
                        <div key={`${a.admin_id}-${i}`} className="flex items-center gap-2 text-xs">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium shrink-0 ${
                            a.is_accepting_chats && a.active ? "bg-brand/15 text-brand" : "bg-surface-2 text-text-subtle"
                          }`}>
                            {a.name?.charAt(0).toUpperCase() || "?"}
                          </div>
                          <span className="text-text truncate flex-1">{a.name || a.username}</span>
                          {a.is_accepting_chats ? (
                            <PlayCircle size={10} className="text-green-500 shrink-0" />
                          ) : (
                            <PauseCircle size={10} className="text-text-subtle shrink-0" />
                          )}
                        </div>
                      )) || <span className="text-[10px] text-text-subtle">ไม่มี agent</span>}
                    </div>
                  </Card>
                </>
              )}

              {/* ── Tab: Replay — ผล replay ทั้งหมด + agent info ── */}
              {statTab === "replay" && (
                <>
                  {/* Replay results */}
                  {stats && (
                    <Card className="p-3">
                      <div className="text-[10px] text-text-muted mb-2 font-medium">ผล Replay</div>
                      <div className="space-y-1.5 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-text-muted">ทั้งหมด</span>
                          <span className="text-text font-bold">{stats.total}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1 text-green-500"><Bot size={10} /> บอทตอบ</span>
                          <span className="text-green-500 font-bold">{stats.bot_answered}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1 text-brand"><Users size={10} /> Handoff</span>
                          <span className="text-brand font-bold">{stats.handed_off}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-text-muted">ไม่มี agent</span>
                          <span className="font-bold">{stats.no_agent}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1 text-red-500"><AlertCircle size={10} /> Error</span>
                          <span className="text-red-500 font-bold">{stats.error}</span>
                        </div>
                        <div className="border-t border-border/50 pt-1.5 mt-1.5 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-text-muted">Open</span>
                            <span className="font-bold">{stats.open}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-text-muted">Closed (mock)</span>
                            <span className="font-bold">{stats.closed}</span>
                          </div>
                        </div>
                      </div>
                    </Card>
                  )}

                  {/* System config */}
                  <Card className="p-3">
                    <div className="text-[10px] text-text-muted mb-2 font-medium">ระบบ</div>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-text-muted">Bot Worker</span>
                        {status?.config.bot_worker_enabled ? (
                          <span className="flex items-center gap-1 text-green-500"><CheckCircle size={12} /> เปิด</span>
                        ) : (
                          <span className="flex items-center gap-1 text-text-subtle"><XCircle size={12} /> ปิด</span>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-text-muted">โหมดจ่ายงาน</span>
                        <span className="text-text font-medium">{status ? modeLabels[status.assignment_mode] : "—"}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-text-muted">Agent รับแชท</span>
                        <span className="text-text font-medium">{acceptingAgents.length}/{status?.agents.length || 0}</span>
                      </div>
                    </div>
                  </Card>

                  {/* Agents */}
                  <Card className="p-3">
                    <div className="text-[10px] text-text-muted mb-2 font-medium">Agents</div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {status?.agents.map((a, i) => (
                        <div key={`${a.admin_id}-${i}`} className="flex items-center gap-2 text-xs">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium shrink-0 ${
                            a.is_accepting_chats && a.active ? "bg-brand/15 text-brand" : "bg-surface-2 text-text-subtle"
                          }`}>
                            {a.name?.charAt(0).toUpperCase() || "?"}
                          </div>
                          <span className="text-text truncate flex-1">{a.name || a.username}</span>
                          {a.is_accepting_chats ? (
                            <PlayCircle size={10} className="text-green-500 shrink-0" />
                          ) : (
                            <PauseCircle size={10} className="text-text-subtle shrink-0" />
                          )}
                        </div>
                      )) || <span className="text-[10px] text-text-subtle">ไม่มี agent</span>}
                    </div>
                  </Card>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
