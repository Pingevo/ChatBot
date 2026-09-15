"use client";
// ⚡ Phase 3B-6 — Admin Chat Result (chat layout แบบ shadow-bot)
// หน้าสำหรับ dev ดูผลลัพธ์: แอดมินคนไหน คอมเมนต์/ให้คะแนนอะไร คำตอบบอทเป็นยังไง
// layout: list ซ้าย (conversations) + panel ขวา (Q&A pairs + rating + comment)
import { useEffect, useState, useMemo, useCallback } from "react";
import { useAuth } from "@/lib/authStore";
import { canAccessPage } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { chatService } from "@/lib/services";
import { toast, useToastError } from "@/components/ui/Toast";
import { Loading } from "@/components/ui/Loading";
import { Badge } from "@/components/ui/Badge";
import { MessageContent } from "@/components/chat/MessageContent";
import { splitAnswerSegments } from "@/lib/answerSegments";
import type { ChatMessage } from "@/lib/types";
import {
  MessageSquare, Star, Search, Filter, ChevronDown, ChevronRight,
  User, Bot, ShieldCheck, ArrowLeft, Info,
} from "lucide-react";

interface ConversationItem {
  conversation_id: string;
  scope: "test_assignment" | "shadow_bot" | "test_chat";
  admin_id: string;
  platform?: string;
  shop_name?: string;
  to_name?: string;
  total: number;
  rated: number;
  commented: number;
  good: number;
  bad: number;
  starSum: number;
  starCount: number;
  last_rated_at?: string;
  // ⚡ Phase 3B-8 — batch id (test_assignment=replay_batch_id, shadow_bot=generation_batch_id)
  batch_id?: string;
}

interface DetailItem {
  scope: "test_assignment" | "shadow_bot" | "test_chat";
  admin_id: string;
  conversation_id: string;
  message_id?: string;
  user_text?: string;
  bot_reply?: string;
  bot_source?: string;
  star_rating?: number;
  rating?: string;
  comment?: string;
  rated_at?: string;
  created_at?: string;
  platform?: string;
  shop_name?: string;
  to_name?: string;
  // ⚡ Phase 3B-8
  batch_id?: string;
}

interface AdminInfo {
  admin_id: string;
  name: string;
  username: string;
  role: string;
}

const SCOPE_LABELS: Record<string, string> = {
  test_assignment: "ทดสอบจ่ายงาน",
  shadow_bot: "Shadow Bot",
  test_chat: "ทดสอบแชท",
};

const SCOPE_COLORS: Record<string, string> = {
  test_assignment: "bg-info/10 text-info-dark",
  shadow_bot: "bg-purple-100 text-purple-700",
  test_chat: "bg-success/10 text-success-dark",
};

const SCOPE_DOT_COLORS: Record<string, string> = {
  test_assignment: "#3b82f6",
  shadow_bot: "#a855f7",
  test_chat: "#22c55e",
};

const RATING_COLORS: Record<string, string> = {
  good: "bg-success/10 text-success-dark",
  bad: "bg-error-soft text-error-dark",
  unrated: "bg-gray-100 text-gray-500",
};

const platformColors: Record<string, string> = {
  shopee: "#ee4d2d",
  lazada: "#0f146d",
  tiktok: "#000000",
};

function timeAgo(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "เมื่อสักครู่";
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ชม.ที่แล้ว`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} วันที่แล้ว`;
  return d.toLocaleDateString("th-TH");
}

export default function AdminChatResultPage() {
  const user = useAuth((s) => s.user);
  const canView = canAccessPage(user, "admin-chat-result");
  const { catchError } = useToastError();

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [admins, setAdmins] = useState<AdminInfo[]>([]);
  const [adminsLoading, setAdminsLoading] = useState(false);

  // filters
  const [adminFilter, setAdminFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  // selected conversation + detail
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  // ⚡ Phase 3B-8 — batch id ของ row ที่เลือก (แยก batch กัน)
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  // ⚡ full messages from messages collection — สำหรับ rich content (image/video/sticker/item card/variation card)
  const [fullMessages, setFullMessages] = useState<ChatMessage[]>([]);
  // (showFullBot/toggleFullBot ถูกลบแล้ว — แสดงเต็มเสมอ)

  // mobile view
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");

  const loadAdmins = useCallback(async () => {
    setAdminsLoading(true);
    try {
      const r = await api().get<{ users: AdminInfo[] }>("/users/list");
      setAdmins(r.data.users || []);
    } catch {
      setAdmins([]);
    } finally {
      setAdminsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: "500" };
      if (adminFilter !== "all") params.admin_id = adminFilter;
      if (scopeFilter !== "all") params.scope = scopeFilter;
      const r = await api().get<{ conversations: ConversationItem[]; total: number }>("/admin-chat-result", { params });
      setConversations(r.data.conversations || []);
    } catch (err) {
      catchError(err, "โหลดข้อมูลไม่สำเร็จ");
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }, [adminFilter, scopeFilter, catchError]);

  const loadDetail = useCallback(async (convId: string, scope: string, batchId?: string) => {
    setDetailLoading(true);
    setDetail([]);
    setFullMessages([]);
    try {
      // ⚡ ไม่กรองด้วย admin_id ตอนโหลด detail — แสดงทุก Q&A ใน conversation นั้น
      //   (หน้านี้ dev-only เห็นทุกอย่างได้)
      // ⚡ Phase 3B-8 — ส่ง batch_id เพื่อกรอง items ตาม batch ที่เลือก
      const params: Record<string, string> = { conversation_id: convId, scope };
      if (batchId) params.batch_id = batchId;
      // ⚡ โหลด rating items + full messages แบบ parallel
      // full messages มี rich content (image/video/sticker/item card/variation card)
      // โหลดเฉพาะ shadow_bot + test_assignment (test_chat มี messages ใน session เอง)
      const fetches: Promise<unknown>[] = [
        api().get<{ items: DetailItem[] }>("/admin-chat-result", { params }),
      ];
      if (scope === "shadow_bot" || scope === "test_assignment") {
        fetches.push(
          chatService.messages(convId).catch(() => [] as ChatMessage[])
        );
      }
      const [itemsRes, msgsRes] = await Promise.all(fetches);
      // ⚡ axios ส่ง AxiosResponse ต้องเข้า .data ก่อน
      const itemsData = (itemsRes as { data?: { items?: DetailItem[] }; items?: DetailItem[] }).data?.items || (itemsRes as { items?: DetailItem[] }).items || [];
      setDetail(itemsData);
      if (Array.isArray(msgsRes)) {
        setFullMessages(msgsRes as ChatMessage[]);
      }
    } catch (err) {
      catchError(err, "โหลดรายละเอียดไม่สำเร็จ");
      setDetail([]);
    } finally {
      setDetailLoading(false);
    }
  }, [catchError]);

  useEffect(() => {
    if (canView) {
      loadAdmins();
      load();
    }
  }, [canView, loadAdmins, load]);

  // group by admin (for stats)
  const adminMap = useMemo(() => {
    const m = new Map<string, AdminInfo>();
    for (const a of admins) m.set(a.admin_id, a);
    return m;
  }, [admins]);

  const adminStats = useMemo(() => {
    const m = new Map<string, { total: number; rated: number; commented: number; good: number; bad: number; starSum: number; starCount: number }>();
    for (const c of conversations) {
      if (!c.admin_id) continue;
      const s = m.get(c.admin_id) || { total: 0, rated: 0, commented: 0, good: 0, bad: 0, starSum: 0, starCount: 0 };
      s.total += c.total;
      s.rated += c.rated;
      s.good += c.good;
      s.bad += c.bad;
      s.commented += c.commented;
      s.starSum += c.starSum;
      s.starCount += c.starCount;
      m.set(c.admin_id, s);
    }
    return m;
  }, [conversations]);

  // filtered conversations (client-side search)
  const filtered = useMemo(() => {
    if (!search) return conversations;
    const q = search.toLowerCase();
    return conversations.filter((c) =>
      c.conversation_id.toLowerCase().includes(q) ||
      (c.shop_name || "").toLowerCase().includes(q) ||
      (c.to_name || "").toLowerCase().includes(q) ||
      (adminName(c.admin_id)).toLowerCase().includes(q)
    );
  }, [conversations, search, adminMap]);

  // ⚡ map message_id → ChatMessage (สำหรับ rich content rendering)
  const messageMap = useMemo(() => {
    const m = new Map<string, ChatMessage>();
    for (const msg of fullMessages) {
      if (msg.id) m.set(msg.id, msg);
    }
    return m;
  }, [fullMessages]);

  function adminName(id: string): string {
    const a = adminMap.get(id);
    return a ? (a.name || a.username || id.slice(0, 8)) : id.slice(0, 8);
  }

  function handleSelect(c: ConversationItem) {
    setSelectedId(c.conversation_id);
    setSelectedScope(c.scope);
    setSelectedBatchId(c.batch_id || null);  // ⚡ Phase 3B-8
    setMobileView("chat");
    loadDetail(c.conversation_id, c.scope, c.batch_id);
  }

  if (!canView) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-vibrant-coral/15 flex items-center justify-center">
              <ShieldCheck size={20} className="text-vibrant-coral" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">Admin Chat Result</h1>
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
    <div className="h-full flex overflow-hidden">
      {/* ── Panel ซ้าย: Conversation List ── */}
      <div className={`${mobileView === "list" ? "flex" : "hidden"} md:flex h-full flex-col w-full md:w-80 min-w-0 shrink-0 border-r border-border overflow-hidden relative`}>
        {/* Header */}
        <div className="px-3 py-3 border-b border-border bg-surface shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-brand/15 flex items-center justify-center">
              <MessageSquare size={14} className="text-brand" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-bold text-text">Admin Chat Result</h1>
              <p className="text-[10px] text-text-muted truncate">ผลลัพธ์ rating/comment แยกตามแอดมิน</p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-1 flex-wrap mb-2">
            {/* Admin filter */}
            <select
              value={adminFilter}
              onChange={(e) => setAdminFilter(e.target.value)}
              className="text-[10px] px-1.5 py-1 rounded-md border border-border bg-surface-2 text-text focus:outline-none focus:border-brand"
            >
              <option value="all">ทุกแอดมิน</option>
              {admins.map((a) => (
                <option key={a.admin_id} value={a.admin_id}>
                  {a.name || a.username} ({a.role})
                </option>
              ))}
            </select>

            {/* Scope filter */}
            <select
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value)}
              className="text-[10px] px-1.5 py-1 rounded-md border border-border bg-surface-2 text-text focus:outline-none focus:border-brand"
            >
              <option value="all">ทุกระบบ</option>
              <option value="test_assignment">ทดสอบจ่ายงาน</option>
              <option value="shadow_bot">Shadow Bot</option>
              <option value="test_chat">ทดสอบแชท</option>
            </select>

            {/* Refresh */}
            <button
              onClick={load}
              disabled={loading}
              className="text-[10px] px-2 py-1 rounded-md border border-border bg-surface-2 text-text hover:bg-surface-3 disabled:opacity-50"
            >
              {loading ? <Loading size={10} /> : "รีเฟรช"}
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหา: แชท, ร้าน, แอดมิน..."
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-surface-2 border border-border rounded-md text-text focus:outline-none focus:border-brand"
            />
          </div>
        </div>

        {/* Stats per admin (compact) */}
        {adminFilter === "all" && conversations.length > 0 && (
          <div className="px-3 py-2 border-b border-border bg-surface-2/50 shrink-0 max-h-32 overflow-y-auto">
            <div className="text-[9px] font-semibold text-text-muted uppercase tracking-wider mb-1">
              สรุป ({adminStats.size} แอดมิน)
            </div>
            <div className="flex flex-wrap gap-1">
              {[...adminStats.entries()].slice(0, 10).map(([adminId, s]) => (
                <button
                  key={adminId}
                  onClick={() => setAdminFilter(adminId)}
                  className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface border border-border text-text-muted hover:text-text hover:border-brand"
                  title={`${adminName(adminId)}: ${s.total} รายการ, ✓${s.good} ✗${s.bad}, 💬${s.commented}`}
                >
                  {adminName(adminId)} · {s.total}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8"><Loading size={24} /></div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted">
              ไม่มีข้อมูล — ลองเปลี่ยน filter
            </div>
          ) : (
            <ul className="divide-y divide-border/50">
              {filtered.map((c, i) => {
                const key = `${c.scope}-${c.conversation_id}-${c.admin_id}-${c.batch_id || ""}-${i}`;
                const isSelected = selectedId === c.conversation_id && selectedScope === c.scope && selectedBatchId === (c.batch_id || null);
                return (
                  <li key={key}>
                    <button
                      onClick={() => handleSelect(c)}
                      className={`w-full text-left px-3 py-2.5 transition-colors ${
                        isSelected
                          ? "bg-pale-sky-soft border-l-2 border-l-brand"
                          : "hover:bg-surface-2"
                      }`}
                    >
                      {/* Row 1: ชื่อลูกค้า + scope badge + เวลา */}
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {c.platform && (
                            <span
                              className="inline-block w-2 h-2 rounded-full shrink-0"
                              style={{ background: platformColors[c.platform] || "#888" }}
                              title={c.platform}
                            />
                          )}
                          <span className="text-sm font-medium text-text truncate">
                            {c.to_name || "ไม่ระบุชื่อ"}
                          </span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${SCOPE_COLORS[c.scope] || ""}`}>
                            {SCOPE_LABELS[c.scope] || c.scope}
                          </span>
                        </div>
                        {c.last_rated_at && (
                          <span className="text-[10px] text-text-subtle shrink-0">
                            {new Date(c.last_rated_at).toLocaleDateString("th-TH", { day: "2-digit", month: "short" })}
                          </span>
                        )}
                      </div>
                      {/* Row 2: ชื่อร้าน + batch label */}
                      {c.shop_name && (
                        <div className="text-[11px] text-text-muted truncate flex items-center gap-1">
                          <span className="truncate">{c.shop_name}</span>
                          {c.batch_id && (
                            <span className="text-[9px] text-text-subtle shrink-0 font-mono" title={c.batch_id}>
                              · {c.batch_id.slice(-8)}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Row 3: แอดมิน + รายการ + รีวิว */}
                      <div className="flex items-center gap-2 mt-1 text-xs flex-wrap">
                        <span className="text-text-muted truncate">โดย {adminName(c.admin_id)}</span>
                        <span className="text-text-subtle">· {c.total} รายการ</span>
                        {c.rated > 0 && (
                          <span className="text-success">✓{c.good} ✗{c.bad}</span>
                        )}
                        {c.starCount > 0 && (
                          <span className="text-warning">★{(c.starSum / c.starCount).toFixed(1)}</span>
                        )}
                        {c.commented > 0 && <span className="text-text-muted">💬{c.commented}</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
              {filtered.length > 200 && (
                <li className="text-center text-xs text-text-subtle py-2">
                  แสดง 200 จาก {filtered.length} conversation
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {/* ── Panel ขวา: Detail (Q&A pairs + rating + comment) ── */}
      <div className={`${mobileView === "chat" ? "flex" : "hidden"} md:flex flex-1 h-full min-w-0 relative overflow-hidden`}>
        {/* Mobile back button */}
        <button
          onClick={() => setMobileView("list")}
          className="md:hidden absolute top-3 left-3 z-10 w-9 h-9 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
          title="กลับ"
          aria-label="กลับ"
        >
          <ArrowLeft size={16} className="text-text" />
        </button>

        {!selectedId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <MessageSquare size={40} className="text-text-subtle mb-3" />
            <p className="text-sm text-text-muted">เลือก conversation จากรายการด้านซ้าย</p>
            <p className="text-xs text-text-subtle mt-1">เพื่อดู Q&A pairs + rating + comment</p>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loading size={32} />
          </div>
        ) : (
          <div className="flex-1 flex flex-col h-full">
            {/* Header */}
            <div className="px-4 py-3 border-b border-border bg-surface shrink-0">
              <div className="flex items-center gap-2 mb-1">
                {selectedScope && (
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SCOPE_COLORS[selectedScope] || ""}`}>
                    {SCOPE_LABELS[selectedScope] || selectedScope}
                  </span>
                )}
                <span className="text-base font-bold text-text truncate">
                  {detail[0]?.to_name || detail[0]?.shop_name || selectedId.slice(0, 16)}
                </span>
              </div>
              <div className="text-xs text-text-subtle font-mono truncate">
                {selectedId}
                {selectedBatchId && (
                  <span className="ml-2 text-text-subtle" title={selectedBatchId}>
                    · batch: {selectedBatchId.slice(-8)}
                  </span>
                )}
              </div>
              {detail.length > 0 && (
                <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                  <span>{detail.length} รายการ</span>
                  <span>· {adminName(detail[0]?.admin_id || "")}</span>
                  {detail[0]?.platform && (
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{ background: platformColors[detail[0].platform] || "#888" }}
                    />
                  )}
                  {detail[0]?.shop_name && <span>· {detail[0].shop_name}</span>}
                </div>
              )}
            </div>

            {/* Chat bubbles — ซ้าย: ลูกค้า / ขวา: บอท (เหมือน shadow-bot) */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {detail.length === 0 && fullMessages.length === 0 ? (
                <div className="text-center py-8 text-sm text-text-muted">
                  ไม่มีรายการใน conversation นี้
                </div>
              ) : detail.length > 0 ? (
                /* ⚡ มี detail items → render จาก detail (มี bot_reply ของ bot เรา ไม่ใช่ Zaapi)
                   และหา rich content จาก fullMessages เฉพาะ user messages */
                detail.map((d, i) => {
                  const key = `${d.message_id || ""}-${i}`;
                  const hasRating = (d.star_rating != null && d.star_rating > 0) || (d.rating && d.rating !== "unrated") || (d.comment && d.comment.trim());
                  // ⚡ หา full message สำหรับ user message (rich content: image/video/sticker/item card)
                  const userFullMsg = d.message_id ? messageMap.get(d.message_id) : undefined;
                  // ⚡ split bot reply ด้วย ||| สำหรับ multi-bubble (ใช้ bot_reply ของ bot เรา)
                  const botSegments = d.bot_reply ? splitAnswerSegments(d.bot_reply) : [];

                  return (
                    <div key={key} className="space-y-2">
                      {i > 0 && <div className="border-t border-border/30" />}

                      {/* ── ลูกค้า (ซ้าย) — ใช้ rich content จาก fullMessages ถ้ามี ── */}
                      {d.user_text && (
                        <div className="flex gap-2 justify-start">
                          <div className="w-8 h-8 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                            <User size={14} className="text-text-muted" />
                          </div>
                          <div className="min-w-0 max-w-[80%]">
                            <div className="text-xs text-text-subtle mb-1">
                              ลูกค้า · #{i + 1}
                              {d.rated_at && (
                                <span className="ml-2">
                                  {new Date(d.rated_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                                </span>
                              )}
                            </div>
                            {userFullMsg ? (
                              <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-3 py-2 text-sm w-fit max-w-full">
                                <MessageContent msg={userFullMsg} variant="user" />
                              </div>
                            ) : (
                              <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-3 py-2 text-sm text-text whitespace-pre-wrap break-words w-fit max-w-full">
                                {d.user_text}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* ── บอท (ขวา) — ใช้ bot_reply ของ bot เรา (ไม่ใช่ Zaapi) + MessageContent ── */}
                      {botSegments.length > 0 && (
                        <div className="flex gap-2 flex-row-reverse">
                          <div className="w-8 h-8 rounded-full bg-brand/15 flex items-center justify-center shrink-0">
                            <Bot size={14} className="text-brand" />
                          </div>
                          <div className="flex-1 min-w-0 flex flex-col items-end gap-1">
                            <div className="text-xs text-text-subtle mb-1 text-right">
                              Bot ของเรา
                              {d.bot_source && <span className="ml-1 text-text-subtle">[{d.bot_source}]</span>}
                            </div>
                            {botSegments.map((seg, si) => (
                              <div key={si} className="bg-brand text-white rounded-lg rounded-tr-sm px-3 py-2 text-sm max-w-[85%] overflow-hidden">
                                <MessageContent
                                  msg={{
                                    id: d.message_id || `bot_${i}_${si}`,
                                    role: "bot",
                                    text: seg,
                                    timestamp: d.rated_at || d.created_at || new Date().toISOString(),
                                  }}
                                  variant="out"
                                />
                              </div>
                            ))}

                            {/* Rating + comment (ใต้ bubble บอท) */}
                            {hasRating && (
                              <div className="flex items-center gap-2 flex-wrap justify-end mt-1 max-w-full">
                                {d.star_rating != null && d.star_rating > 0 && (
                                  <div className="flex items-center gap-0.5 bg-surface-2 rounded-full px-2 py-0.5">
                                    {[1, 2, 3, 4, 5].map((s) => (
                                      <Star
                                        key={s}
                                        size={12}
                                        className={d.star_rating! >= s ? "text-warning fill-warning" : "text-text-subtle"}
                                      />
                                    ))}
                                    <span className="text-xs text-text-muted ml-1">{d.star_rating}</span>
                                  </div>
                                )}
                                {d.rating && d.rating !== "unrated" && (
                                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RATING_COLORS[d.rating] || ""}`}>
                                    {d.rating === "good" ? "✓ ดี" : d.rating === "bad" ? "✗ ไม่ดี" : d.rating}
                                  </span>
                                )}
                                {d.comment && d.comment.trim() && (
                                  <div className="flex items-start gap-1 min-w-0 bg-surface-2 rounded-md px-2 py-1 max-w-full">
                                    <MessageSquare size={11} className="text-text-muted shrink-0 mt-0.5" />
                                    <span className="text-xs text-text-muted italic" title={d.comment}>
                                      "{d.comment}"
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                /* ⚡ fallback: detail ว่างแต่มี fullMessages → render จาก messages collection
                   (conversation ยังไม่มี rating/bot reply แต่มีแชทของลูกค้า) */
                fullMessages.map((msg, i) => {
                  const key = `msg-${msg.id || i}`;
                  const isUser = msg.role === "user";
                  const botSegments = !isUser ? splitAnswerSegments(msg.text) : [];

                  return (
                    <div key={key} className="space-y-2">
                      {i > 0 && <div className="border-t border-border/30" />}

                      {/* ── ลูกค้า (ซ้าย) ── */}
                      {isUser && (
                        <div className="flex gap-2 justify-start">
                          <div className="w-8 h-8 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                            <User size={14} className="text-text-muted" />
                          </div>
                          <div className="min-w-0 max-w-[80%]">
                            <div className="text-xs text-text-subtle mb-1">
                              ลูกค้า · #{i + 1}
                              {msg.timestamp && (
                                <span className="ml-2">
                                  {new Date(msg.timestamp).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                                </span>
                              )}
                            </div>
                            <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-3 py-2 text-sm w-fit max-w-full">
                              <MessageContent msg={msg} variant="user" />
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ── บอท (ขวา) — โชว์คำตอบจาก messages collection ── */}
                      {!isUser && botSegments.length > 0 && (
                        <div className="flex gap-2 flex-row-reverse">
                          <div className="w-8 h-8 rounded-full bg-brand/15 flex items-center justify-center shrink-0">
                            <Bot size={14} className="text-brand" />
                          </div>
                          <div className="flex-1 min-w-0 flex flex-col items-end gap-1">
                            <div className="text-xs text-text-subtle mb-1 text-right">
                              Bot
                              {msg.source && <span className="ml-1 text-text-subtle">[{msg.source}]</span>}
                            </div>
                            {botSegments.map((seg, si) => (
                              <div key={si} className="bg-brand text-white rounded-lg rounded-tr-sm px-3 py-2 text-sm max-w-[85%] overflow-hidden">
                                <MessageContent
                                  msg={{
                                    ...msg,
                                    text: seg,
                                    products: si === botSegments.length - 1 ? msg.products : undefined,
                                    table: si === botSegments.length - 1 ? msg.table : undefined,
                                  }}
                                  variant="out"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
