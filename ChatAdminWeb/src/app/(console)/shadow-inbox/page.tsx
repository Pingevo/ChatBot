"use client";
// Shadow Inbox — split layout แบบ tickets
// ซ้าย: ShadowInboxList (list + filter)
// กลาง: ShadowReplyPanel (เปรียบเทียบ + ให้คะแนน) หรือ ChatPanel (เมื่อ tab "ทั้งหมด")
// ขวา: ShadowStatPanel (stats + win rate)
//
// ⛔ ห้ามส่งข้อความจริง — เก็บใน shadow_replies เท่านั้น
// ⛔ ห้ามเรียก Shopee API
// เฉพาะ dev เท่านั้น
import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Info, PanelRightClose, PanelRightOpen, Zap, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { ShieldCheck, FlaskConical, Search, ChevronDown } from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { api } from "@/lib/apiClient";
import { usePolling } from "@/lib/usePolling";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { ShadowInboxList, type ShadowReplyListItem } from "@/components/shadow/ShadowInboxList";
import { ShadowReplyPanel, type ShadowReplyDetail } from "@/components/shadow/ShadowReplyPanel";
import { ShadowStatPanel, type ShadowStats } from "@/components/shadow/ShadowStatPanel";
import { ShadowConversationPanel } from "@/components/shadow/ShadowConversationPanel";
import { ChatList } from "@/components/chat/ChatList";
import { chatService } from "@/lib/services";
import type { Platform, Conversation, ChatMessage, AdminUser } from "@/lib/types";

type MobileView = "list" | "chat" | "stat";

interface ConversationOption {
  id: string;
  platform: Platform;
  shop_name: string;
  customer_name: string;
  last_message: string;
  last_timestamp: string;
  unread: number;
  status: string;
}

const platformLabels: Record<Platform, string> = {
  shopee: "Shopee",
  tiktok: "TikTok",
  lazada: "Lazada",
};

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "เมื่อสักครู่";
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชม.`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} วัน`;
  const mo = Math.floor(d / 30);
  return `${mo} เดือน`;
}

export default function ShadowInboxPage() {
  const { user } = useAuth();
  const canView = user?.role === "dev";
  const { catchError } = useToastError();

  const [rows, setRows] = useState<ShadowReplyListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShadowReplyDetail | null>(null);
  const [stats, setStats] = useState<ShadowStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [ratingId, setRatingId] = useState<string | null>(null);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("list");
  // origin filter — "all" = ทั้งหมด, "manual" = Generate เอง, "history" = ประวัติ bot ตอบ
  const [originFilter, setOriginFilter] = useState<"all" | "manual" | "history">("all");
  // ⚡ history tab — ดึง shadow_replies ทั้งหมด จัดกลุ่มตาม conversation
  const [historyReplies, setHistoryReplies] = useState<ShadowReplyListItem[]>([]);

  // ⚡ tab "ทั้งหมด" — ใช้ ChatList เหมือน ticket inbox
  const [chatConversations, setChatConversations] = useState<Conversation[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [loadingChatMessages, setLoadingChatMessages] = useState(false);

  // Generate dialog
  const [showGenDd, setShowGenDd] = useState(false);
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [convSearch, setConvSearch] = useState("");
  const [convPlatform, setConvPlatform] = useState<"all" | Platform>("all");
  const [genConvId, setGenConvId] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(false);

  const load = useCallback(async () => {
    try {
      if (originFilter === "all") {
        // "ทั้งหมด" = ดึงจาก ticket inbox (conversations) เหมือนหน้า ticket
        const r = await api().get<Conversation[]>("/admin/conversations", {
          params: { assigned_to: "all", limit: 10000 },
        });
        const data = Array.isArray(r.data) ? r.data : ((r.data as unknown as { rows?: Conversation[] }).rows || []);
        setChatConversations(data);
      } else if (originFilter === "history") {
        // "History" = ดึง shadow_replies ทั้งหมด (ทุก origin) จัดกลุ่มตาม conversation
        const params: Record<string, string> = { limit: "500" };
        const r = await api().get<{ rows: ShadowReplyListItem[] }>("/shadow-inbox", { params });
        setHistoryReplies(r.data.rows || []);
      } else {
        // "Generate เอง" = ดึงจาก shadow_replies (origin=manual เท่านั้น ไม่รวม manual_conversation)
        const params: Record<string, string> = { limit: "500", origin: "manual" };
        const r = await api().get<{ rows: ShadowReplyListItem[] }>("/shadow-inbox", { params });
        setRows(r.data.rows || []);
      }
    } catch (err) {
      catchError(err, "โหลดข้อมูลไม่สำเร็จ");
      setRows([]);
      setChatConversations([]);
      setHistoryReplies([]);
    } finally {
      setLoading(false);
    }
  }, [catchError, originFilter]);

  const loadStats = useCallback(async () => {
    try {
      const r = await api().get<{ stats: ShadowStats }>("/shadow-inbox?stats=1");
      setStats(r.data.stats);
    } catch {
      setStats(null);
    }
  }, []);

  // load detail when selectedId changes
  const loadDetail = useCallback(async (id: string) => {
    if (originFilter === "all" || originFilter === "history") {
      // tab "ทั้งหมด" และ "History" — โหลด chat messages เหมือน ticket inbox
      setLoadingChatMessages(true);
      try {
        const msgs = await chatService.messages(id);
        setChatMessages(msgs);
      } catch (err) {
        catchError(err, "โหลดข้อความไม่สำเร็จ");
        setChatMessages([]);
      } finally {
        setLoadingChatMessages(false);
      }
    } else {
      // tab "Generate เอง" — โหลด shadow reply detail
      setLoadingDetail(true);
      try {
        const r = await api().get<{ shadow_reply: ShadowReplyDetail }>(`/shadow-inbox/${id}`);
        setDetail(r.data.shadow_reply);
      } catch (err) {
        catchError(err, "โหลดรายละเอียดไม่สำเร็จ");
        setDetail(null);
      } finally {
        setLoadingDetail(false);
      }
    }
  }, [catchError, originFilter]);

  useEffect(() => {
    if (canView) { load(); loadStats(); }
    else setLoading(false);
  }, [canView, load, loadStats]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else {
      setDetail(null);
      setChatMessages([]);
    }
  }, [selectedId, loadDetail]);

  // Polling — ลด rate เพื่อลดการกระพริบ
  usePolling(load, 10000, { enabled: canView });
  usePolling(loadStats, 30000, { enabled: canView });

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileView("chat");
  }, []);

  const handleBack = useCallback(() => {
    setMobileView("list");
  }, []);

  async function loadConversations() {
    setLoadingConvs(true);
    try {
      const r = await api().get<ConversationOption[]>("/admin/conversations", { params: { limit: 100 } });
      const data = Array.isArray(r.data) ? r.data : ((r.data as unknown as { rows?: ConversationOption[] }).rows || []);
      // เรียงใหม่ล่าสุดก่อน — เทสแชทเองจะได้เห็นบนสุด
      const sorted = [...data].sort((a, b) => {
        const ta = a.last_timestamp ? new Date(a.last_timestamp).getTime() : 0;
        const tb = b.last_timestamp ? new Date(b.last_timestamp).getTime() : 0;
        return tb - ta;
      });
      setConversations(sorted);
    } catch {
      setConversations([]);
    } finally {
      setLoadingConvs(false);
    }
  }

  async function handleGenerate() {
    if (!genConvId) {
      toast.warning("เลือก conversation ก่อน");
      return;
    }
    const ok = await confirm.ask({
      title: "Generate shadow reply?",
      message: "ระบบจะเรียก bot ของเราเพื่อตอบข้อความล่าสุด — ผลลัพธ์เก็บใน shadow_replies ไม่ส่งจริง",
      confirmText: "Generate",
    });
    if (!ok) return;
    setGenerating(true);
    try {
      const resp = await api().post<{ shadow_reply: { shadow_reply_id: string } }>("/shadow-inbox", { conversation_id: genConvId });
      toast.success("Generate shadow reply แล้ว");
      setShowGenDd(false);
      setGenConvId("");
      // auto-select shadow reply ใหม่ทันที — ไม่ต้องรอ load
      if (resp.data?.shadow_reply?.shadow_reply_id) {
        setSelectedId(resp.data.shadow_reply.shadow_reply_id);
        setMobileView("chat");
      }
      // refresh list + stats แบบ background
      load();
      loadStats();
    } catch (err) {
      catchError(err, "Generate ไม่สำเร็จ");
    } finally {
      setGenerating(false);
    }
  }

  async function handleRate(id: string, rating: "better" | "worse" | "tie" | "unrated") {
    setRatingId(id);
    try {
      await api().patch(`/shadow-inbox/${id}`, { rating });
      toast.success(`ให้คะแนน "${rating}" แล้ว`);
      // update detail + list locally
      if (detail && detail.shadow_reply_id === id) {
        setDetail({ ...detail, rating });
      }
      setRows((prev) => prev.map((r) => r.shadow_reply_id === id ? { ...r, rating } : r));
      await loadStats();
    } catch (err) {
      catchError(err, "ให้คะแนนไม่สำเร็จ");
    } finally {
      setRatingId(null);
    }
  }

  async function handleDelete(id: string) {
    const ok = await confirm.ask({
      title: "ลบ shadow reply?",
      message: "ลบรายการเปรียบเทียบนี้ — ไม่สามารถกู้คืนได้",
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api().delete(`/shadow-inbox/${id}`);
      toast.success("ลบ shadow reply แล้ว");
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      await load();
      await loadStats();
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    }
  }

  const filteredConvs = conversations.filter((c) => {
    if (convPlatform !== "all" && c.platform !== convPlatform) return false;
    if (!convSearch) return true;
    const q = convSearch.toLowerCase();
    return (
      c.id.toLowerCase().includes(q) ||
      c.shop_name.toLowerCase().includes(q) ||
      c.customer_name.toLowerCase().includes(q) ||
      (c.last_message || "").toLowerCase().includes(q)
    );
  });

  // Access control
  if (!canView) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-vibrant-coral/15 flex items-center justify-center">
              <ShieldCheck size={20} className="text-vibrant-coral" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">Shadow Inbox</h1>
              <p className="text-xs text-text-muted">สำหรับ Dev เท่านั้น</p>
            </div>
          </div>
        </div>
        <div className="p-12 text-center">
          <ShieldCheck size={40} className="mx-auto mb-3 text-text-subtle" />
          <p className="text-sm text-text-muted">คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* ── Panel ซ้าย: Shadow Inbox List ── */}
      <div className={`${mobileView === "list" ? "flex" : "hidden"} md:flex h-full flex-col w-full md:w-72 shrink-0 border-r border-border`}>
        {/* Origin filter tabs — ทั้งหมด / Generate เอง / History */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-surface-2">
          {([
            { key: "all", label: "ทั้งหมด" },
            { key: "manual", label: "Generate เอง" },
            { key: "history", label: "History" },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setOriginFilter(t.key);
                setSelectedId(null);
                setDetail(null);
                setChatMessages([]);
                setLoading(true);
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                originFilter === t.key
                  ? "bg-brand text-white"
                  : "bg-surface text-text-muted hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {originFilter === "all" || originFilter === "history" ? (
          /* ⚡ tab "ทั้งหมด" และ "History" — ใช้ ChatList เหมือน ticket inbox */
          <ChatList
            conversations={
              originFilter === "history"
                ? chatConversations.filter((c) =>
                    historyReplies.some((r) => r.conversation_id === c.id)
                  )
                : chatConversations
            }
            selectedId={selectedId}
            onSelect={handleSelect}
            admins={[]}
            onChatFilterChange={() => {}}
          />
        ) : (
          /* tab "Generate เอง" — ใช้ ShadowInboxList เหมือนเดิม */
          <ShadowInboxList
            rows={rows}
            selectedId={selectedId}
            onSelect={handleSelect}
            loading={loading}
            total={rows.length}
            headerExtra={
              <div className="relative">
                <Button
                  size="sm"
                  onClick={() => {
                    setShowGenDd(!showGenDd);
                    if (!showGenDd && conversations.length === 0) loadConversations();
                  }}
                >
                  <Zap size={12} /> Generate
                </Button>
                {showGenDd && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setShowGenDd(false)} />
                    <div className="absolute right-0 top-full mt-1 w-80 bg-surface border border-border rounded-lg shadow-lg z-40 p-3">
                      <div className="text-xs font-semibold text-text-muted mb-2">เลือก conversation เพื่อ generate</div>
                      {/* Search */}
                      <div className="relative mb-2">
                        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
                        <input
                          type="text"
                          value={convSearch}
                          onChange={(e) => setConvSearch(e.target.value)}
                          placeholder="ค้นหาชื่อ / ร้าน / ข้อความ..."
                          className="w-full h-8 pl-8 pr-3 rounded-lg border border-border bg-surface-2 text-xs focus:outline-none focus:ring-2 focus:ring-brand/40"
                        />
                      </div>
                      {/* Platform filter tabs */}
                      <div className="flex items-center gap-1 mb-2">
                        {(["all", "shopee", "tiktok", "lazada"] as const).map((p) => (
                          <button
                            key={p}
                            onClick={() => setConvPlatform(p)}
                            className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                              convPlatform === p
                                ? "bg-brand text-white"
                                : "bg-surface-2 text-text-muted hover:text-text"
                            }`}
                          >
                            {p === "all" ? "ทั้งหมด" : platformLabels[p]}
                          </button>
                        ))}
                      </div>
                      {/* List */}
                      <div className="max-h-72 overflow-y-auto space-y-1">
                        {loadingConvs ? (
                          <div className="flex justify-center py-4"><Loading size={16} /></div>
                        ) : filteredConvs.length === 0 ? (
                          <div className="text-xs text-text-subtle text-center py-4">ไม่พบ conversation</div>
                        ) : (
                          filteredConvs.map((c) => {
                            const isSelected = genConvId === c.id;
                            const hasUnread = (c.unread || 0) > 0;
                            return (
                              <button
                                key={c.id}
                                onClick={() => setGenConvId(c.id)}
                                className={`w-full text-left p-2 rounded-lg text-xs transition-colors ${
                                  isSelected ? "bg-brand/10 border border-brand/30" : "hover:bg-surface-2 border border-transparent"
                                }`}
                              >
                                {/* Row 1: platform + customer name + time + unread dot */}
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[10px] font-medium text-text-muted shrink-0">{platformLabels[c.platform]}</span>
                                  <span className="font-medium text-text truncate flex-1">{c.customer_name || "(ไม่มีชื่อ)"}</span>
                                  {hasUnread && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-vibrant-coral shrink-0" title={`${c.unread} ข้อความใหม่`} />
                                  )}
                                  {c.last_timestamp && (
                                    <span className="text-[10px] text-text-subtle shrink-0">{timeAgoShort(c.last_timestamp)}</span>
                                  )}
                                </div>
                                {/* Row 2: shop name */}
                                <div className="text-text-muted mt-0.5 truncate">{c.shop_name || "-"}</div>
                                {/* Row 3: last message preview */}
                                {c.last_message && (
                                  <div className="text-text-subtle mt-0.5 truncate italic">"{c.last_message}"</div>
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>
                      <div className="flex gap-2 mt-2 pt-2 border-t border-border">
                        <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowGenDd(false)}>ยกเลิก</Button>
                        <Button size="sm" className="flex-1" disabled={!genConvId || generating} onClick={handleGenerate}>
                          {generating ? <Loading size={12} /> : <Zap size={12} />} Generate
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            }
          />
        )}
      </div>

      {/* ── Panel กลาง ── */}
      <div className={`${mobileView === "chat" ? "flex" : "hidden"} md:flex flex-1 h-full min-w-0 relative`}>
        {/* Mobile back button */}
        <button
          onClick={handleBack}
          className="md:hidden absolute top-3 left-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
          title="กลับ"
        >
          <ArrowLeft size={16} className="text-text" />
        </button>
        {/* Mobile stat button */}
        <button
          onClick={() => setMobileView("stat")}
          className="md:hidden absolute top-3 right-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
          title="สถิติ"
        >
          <Info size={16} className="text-text" />
        </button>

        {originFilter === "all" || originFilter === "history" ? (
          /* ⚡ tab "ทั้งหมด" และ "History" — แสดงทั้งแชทแบบ 2 คอลัมน์ (user/zaapi + user/bot เรา) */
          <ShadowConversationPanel
            conversation={
              (originFilter === "history"
                ? chatConversations.find((c) => c.id === selectedId && historyReplies.some((r) => r.conversation_id === c.id))
                : chatConversations.find((c) => c.id === selectedId)) ?? null
            }
            messages={chatMessages}
            loadingMessages={loadingChatMessages}
            historyReplies={originFilter === "history" ? historyReplies.filter((r) => r.conversation_id === selectedId) : undefined}
          />
        ) : (
          /* tab "Generate เอง" — แสดง ShadowReplyPanel */
          loadingDetail ? (
            <div className="flex-1 flex items-center justify-center">
              <Loading size={32} />
            </div>
          ) : (
            <ShadowReplyPanel
              reply={detail}
              onRate={handleRate}
              onDelete={handleDelete}
              ratingId={ratingId}
            />
          )
        )}
      </div>

      {/* ── Panel ขวา: Stats ── */}
      <div className={`${mobileView === "stat" ? "flex" : "hidden"} ${rightCollapsed ? "md:hidden" : "md:flex"} h-full shrink-0`}>
        <div className="relative h-full flex flex-col w-full md:w-[300px] border-l border-border bg-surface">
          {/* Mobile back button */}
          <button
            onClick={() => setMobileView("chat")}
            className="md:hidden absolute top-3 left-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
            title="กลับ"
          >
            <ArrowLeft size={16} className="text-text" />
          </button>

          {/* Collapse button (desktop) */}
          <button
            onClick={() => setRightCollapsed(true)}
            className="hidden md:flex absolute top-3 right-3 z-10 w-7 h-7 rounded-md text-text-muted hover:text-text hover:bg-surface-2 items-center justify-center transition-colors"
            title="ซ่อน panel"
          >
            <PanelRightClose size={14} />
          </button>

          <ShadowStatPanel stats={stats} />
        </div>
      </div>

      {/* Expand button (desktop, when collapsed) */}
      {rightCollapsed && (
        <button
          onClick={() => setRightCollapsed(false)}
          className="hidden md:flex absolute right-0 top-1/2 -translate-y-1/2 z-10 w-7 h-14 bg-surface border border-border rounded-l-lg items-center justify-center shadow-sm hover:bg-surface-2 transition-colors"
          title="แสดง panel"
        >
          <PanelRightOpen size={14} className="text-text-muted" />
        </button>
      )}
    </div>
  );
}
