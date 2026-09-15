"use client";
// ⚡ Phase 3B-6 — Test Chat Result (dev-only)
// ดูผลลัพธ์ test chat session: ใครถามอะไร บอทตอบยังไง รีวิว/คอมเมนต์อะไร
// layout: list ซ้าย (sessions) + panel ขวา (chat bubbles + rating + comment)
// ⚡ Phase 3B-7 — multi-bubble (|||), image lightbox, ขยายตัวอักษร, comments ชัดเจน
import { useEffect, useState, useMemo, useCallback, type ReactNode } from "react";
import { useAuth } from "@/lib/authStore";
import { canAccessPage } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { useToastError } from "@/components/ui/Toast";
import { Loading } from "@/components/ui/Loading";
import { MessageContent } from "@/components/chat/MessageContent";
import type { ChatMessage } from "@/lib/types";
import {
  MessageSquare, Star, Search, User, Bot, ShieldCheck,
  Eye, EyeOff, ArrowLeft, X, ZoomIn,
} from "lucide-react";

/* ── markdown inline renderer (เหมือน MessageContent) ──
 *   รองรับ: ![alt](url) → <img>, [text](url) → <a>, **bold** → <strong>
 *   ใช้สำหรับ bot answer ที่เป็น markdown (เช่น [สั่งซื้อ](https://...))
 */
function renderMarkdownInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\))|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*(.+?)\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined && match[3]) {
      // ![alt](url) → <img> (click to zoom)
      nodes.push(
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`img-${key++}`}
          src={match[3]}
          alt={match[2] || "รูปภาพ"}
          className="rounded-lg max-w-[200px] max-h-[200px] object-cover my-1 cursor-pointer hover:opacity-80 transition-opacity"
          loading="lazy"
          onClick={() => {
            // ⚡ เปิด lightbox แทน imageViewer (ไม่มีในหน้านี้)
            const event = new CustomEvent("test-chat-result-lightbox", { detail: match![3] });
            window.dispatchEvent(event);
          }}
        />
      );
    } else if (match[5] && match[6]) {
      // [text](url) → <a>
      nodes.push(
        <a
          key={`a-${key++}`}
          href={match[6]}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:opacity-80"
        >
          {match[5]}
        </a>
      );
    } else if (match[8]) {
      // **bold** → <strong>
      nodes.push(<strong key={`b-${key++}`}>{match[8]}</strong>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : [text];
}

interface SessionItem {
  session_id: string;
  shop: string;
  title: string;
  admin_id: string;
  admin_name: string;
  message_count: number;
  created_at?: string;
  updated_at?: string;
  total_rated: number;
  good: number;
  bad: number;
  commented: number;
  star_sum: number;
  star_count: number;
  last_rated_at?: string;
}

interface SessionMessage {
  role: string;
  text: string;
  timestamp?: string;
  stats?: Record<string, unknown>;
  images?: string[];
}

// ⚡ แปลง SessionMessage → ChatMessage สำหรับ MessageContent
//   - ถ้ามี images → message_type: "image_with_text" (text + รูป)
//   - ถ้าไม่มี images → message_type: "text"
function sessionMsgToChatMsg(m: SessionMessage, index: number): ChatMessage {
  const hasImages = m.images && m.images.length > 0;
  return {
    id: `session_msg_${index}`,
    role: m.role === "user" ? "user" : "bot",
    text: m.text || "",
    timestamp: m.timestamp || new Date().toISOString(),
    // ⚡ ถ้ามี images → ใช้ message_type: "image_with_text" + media (รูปแรก)
    //   สำหรับรูปเพิ่มเติม → แสดงใต้ text (MessageContent รองรับ media เดียว)
    //   แต่ test-chat-result ใช้ lightbox ของตัวเอง → แสดงรูปแรกใน MessageContent + รูปที่เหลือใน lightbox
    message_type: hasImages ? "image_with_text" : "text",
    media: hasImages ? { type: "image", url: m.images![0] } : undefined,
  };
}

interface SessionRating {
  msg_index: number;
  star_rating?: number;
  rating?: string;
  comment?: string;
  rated_by?: string;
  rated_at?: string;
}

interface SessionDetail {
  session_id: string;
  shop: string;
  title: string;
  admin_id: string;
  admin_name: string;
  created_at?: string;
  updated_at?: string;
  messages: SessionMessage[];
  ratings: SessionRating[];
}

interface AdminInfo {
  admin_id: string;
  name: string;
  username: string;
  role: string;
}

const RATING_COLORS: Record<string, string> = {
  good: "bg-success/10 text-success-dark",
  bad: "bg-error-soft text-error-dark",
  unrated: "bg-gray-100 text-gray-500",
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

export default function TestChatResultPage() {
  const user = useAuth((s) => s.user);
  const canView = canAccessPage(user, "test-chat-result");
  const { catchError } = useToastError();

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [admins, setAdmins] = useState<AdminInfo[]>([]);

  // filters
  const [adminFilter, setAdminFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  // selected session + detail
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showFullBot, setShowFullBot] = useState<Set<string>>(new Set());

  // mobile view
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");

  // ⚡ Phase 3B-7 — image lightbox
  const [lightbox, setLightbox] = useState<string | null>(null);

  // ⚡ Phase 3B-7 — รับ event จาก renderMarkdownInline (กรณีคลิกรูปใน bot text)
  useEffect(() => {
    function onLightbox(e: Event) {
      const url = (e as CustomEvent<string>).detail;
      if (typeof url === "string") setLightbox(url);
    }
    window.addEventListener("test-chat-result-lightbox", onLightbox as EventListener);
    return () => window.removeEventListener("test-chat-result-lightbox", onLightbox as EventListener);
  }, []);

  // ESC to close lightbox
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setLightbox(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const loadAdmins = useCallback(async () => {
    try {
      const r = await api().get<{ users: AdminInfo[] }>("/users/list");
      setAdmins(r.data.users || []);
    } catch {
      setAdmins([]);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: "2000" };
      if (adminFilter !== "all") params.admin_id = adminFilter;
      const r = await api().get<{ sessions: SessionItem[]; total: number }>("/test-chat-result", { params });
      setSessions(r.data.sessions || []);
    } catch (err) {
      catchError(err, "โหลดข้อมูลไม่สำเร็จ");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [adminFilter, catchError]);

  const loadDetail = useCallback(async (sid: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await api().get<SessionDetail>("/test-chat-result", { params: { session_id: sid } });
      setDetail(r.data);
    } catch (err) {
      catchError(err, "โหลดรายละเอียดไม่สำเร็จ");
      setDetail(null);
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

  const adminMap = useMemo(() => {
    const m = new Map<string, AdminInfo>();
    for (const a of admins) m.set(a.admin_id, a);
    return m;
  }, [admins]);

  function adminName(id: string): string {
    if (!id) return "—";
    const a = adminMap.get(id);
    return a ? (a.name || a.username || id.slice(0, 8)) : id.slice(0, 8);
  }

  // filtered sessions (client-side search)
  const filtered = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter((s) =>
      s.title.toLowerCase().includes(q) ||
      s.shop.toLowerCase().includes(q) ||
      s.session_id.toLowerCase().includes(q) ||
      adminName(s.admin_id).toLowerCase().includes(q)
    );
  }, [sessions, search, adminMap]);

  // build rating map by msg_index
  const ratingMap = useMemo(() => {
    const m = new Map<number, SessionRating>();
    if (detail?.ratings) {
      for (const rt of detail.ratings) m.set(rt.msg_index, rt);
    }
    return m;
  }, [detail]);

  function toggleFullBot(key: string) {
    setShowFullBot((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleSelect(s: SessionItem) {
    setSelectedId(s.session_id);
    setMobileView("chat");
    loadDetail(s.session_id);
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
              <h1 className="text-lg font-bold text-text">Test Chat Result</h1>
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
      {/* ── Panel ซ้าย: Session List ── */}
      <div className={`${mobileView === "list" ? "flex" : "hidden"} md:flex h-full flex-col w-full md:w-80 min-w-0 shrink-0 border-r border-border overflow-hidden relative`}>
        {/* Header */}
        <div className="px-3 py-3 border-b border-border bg-surface shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-success/15 flex items-center justify-center">
              <MessageSquare size={14} className="text-success" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-bold text-text">Test Chat Result</h1>
              <p className="text-[10px] text-text-muted truncate">ผลลัพธ์ test chat session แยกตามแอดมิน</p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-1 flex-wrap mb-2">
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
              placeholder="ค้นหา: ชื่อ session, ร้าน, แอดมิน..."
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-surface-2 border border-border rounded-md text-text focus:outline-none focus:border-brand"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8"><Loading size={24} /></div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted">
              ไม่มี session — ลองเปลี่ยน filter
            </div>
          ) : (
            <ul className="divide-y divide-border/50">
              {filtered.map((s) => {
                const isSelected = selectedId === s.session_id;
                return (
                  <li key={s.session_id}>
                    <button
                      onClick={() => handleSelect(s)}
                      className={`w-full text-left px-3 py-2.5 transition-colors ${
                        isSelected
                          ? "bg-brand/20 border-l-2 border-brand"
                          : "hover:bg-surface-2"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-success" />
                        <span className="text-xs font-medium text-text truncate flex-1">
                          {s.title || "ไม่มีชื่อ"}
                        </span>
                      </div>
                      <div className="text-[10px] text-text-muted truncate flex items-center gap-1.5">
                        <span>{adminName(s.admin_id)}</span>
                        {s.shop && <span>· {s.shop}</span>}
                        <span>· {timeAgo(s.updated_at || s.created_at)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[9px]">
                        <span className="text-text-muted">{s.message_count} ข้อความ</span>
                        {s.total_rated > 0 && (
                          <>
                            <span className="text-text-muted">· {s.total_rated} rated</span>
                            <span className="text-success">✓{s.good}</span>
                            <span className="text-error">✗{s.bad}</span>
                          </>
                        )}
                        {s.star_count > 0 && (
                          <span className="text-warning">★{(s.star_sum / s.star_count).toFixed(1)}</span>
                        )}
                        {s.commented > 0 && <span>💬{s.commented}</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
              {filtered.length > 200 && (
                <li className="text-center text-[9px] text-text-subtle py-2">
                  แสดง 200 จาก {filtered.length} session
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {/* ── Panel ขวา: Chat bubbles + rating ── */}
      <div className={`${mobileView === "chat" ? "flex" : "hidden"} md:flex flex-1 h-full min-w-0 relative overflow-hidden`}>
        {/* Mobile back button */}
        <button
          onClick={() => setMobileView("list")}
          className="md:hidden absolute top-3 left-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
          title="กลับ"
          aria-label="กลับ"
        >
          <ArrowLeft size={16} className="text-text" />
        </button>

        {!selectedId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <MessageSquare size={40} className="text-text-subtle mb-3" />
            <p className="text-sm text-text-muted">เลือก session จากรายการด้านซ้าย</p>
            <p className="text-xs text-text-subtle mt-1">เพื่อดูแชท + rating + comment</p>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loading size={32} />
          </div>
        ) : !detail ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <p className="text-sm text-text-muted">ไม่พบ session</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col h-full">
            {/* Header */}
            <div className="px-4 py-3 border-b border-border bg-surface shrink-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-success/10 text-success-dark">
                  Test Chat
                </span>
                <span className="text-sm font-bold text-text truncate">
                  {detail.title || "ไม่มีชื่อ"}
                </span>
              </div>
              <div className="text-[10px] text-text-subtle font-mono truncate">
                {detail.session_id}
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-text-muted">
                <span>{adminName(detail.admin_id)}</span>
                {detail.shop && <span>· {detail.shop}</span>}
                <span>· {detail.messages.length} ข้อความ</span>
                {detail.ratings.length > 0 && <span>· {detail.ratings.length} rated</span>}
              </div>
            </div>

            {/* Chat bubbles */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {detail.messages.length === 0 ? (
                <div className="text-center py-8 text-sm text-text-muted">
                  ไม่มีข้อความใน session นี้
                </div>
              ) : (
                detail.messages.map((m, i) => {
                  const isUser = m.role === "user";
                  const rating = ratingMap.get(i);
                  const hasRating = rating && ((rating.star_rating != null && rating.star_rating > 0) || (rating.rating && rating.rating !== "unrated") || (rating.comment && rating.comment.trim()));
                  const stats = m.stats || {};
                  const source = stats.source as string | undefined;
                  const model = stats.model as string | undefined;
                  const elapsed = stats.elapsed as number | undefined;
                  // ⚡ Phase 3B-7 — split bot text ด้วย ||| สำหรับ multi-bubble
                  //   กรอง segment ที่เป็น whitespace ออก (กัน bubble ว่าง)
                  const botSegments = !isUser
                    ? splitAnswerSegments(m.text).filter((s) => s.trim().length > 0)
                    : [];
                  return (
                    <div key={i} className="space-y-2">
                      {i > 0 && <div className="border-t border-border/30" />}

                      {isUser ? (
                        /* ── ลูกค้า/admin ถาม (ซ้าย) ── */
                        <div className="flex gap-2">
                          <div className="w-8 h-8 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                            <User size={14} className="text-text-muted" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-text-subtle mb-1">
                              ถาม · #{i + 1}
                              {m.timestamp && (
                                <span className="ml-2">
                                  {new Date(m.timestamp).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                                </span>
                              )}
                            </div>
                            {/* ⚡ ใช้ MessageContent สำหรับ render rich content (text + image + รองรับ tag อื่นๆ) */}
                            {(m.text || (m.images && m.images.length > 0)) && (
                              <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-3 py-2 text-sm text-text max-w-[85%] w-fit">
                                <MessageContent msg={sessionMsgToChatMsg(m, i)} variant="user" />
                              </div>
                            )}
                            {/* ⚡ Phase 3B-7 — images ขนาดใหญ่ + กดเปิด lightbox (รูปที่ 2-N ที่ไม่อยู่ใน MessageContent) */}
                            {m.images && m.images.length > 1 && (
                              <div className="flex gap-2 mt-2 flex-wrap">
                                {m.images.slice(1).map((img, j) => (
                                  <button
                                    key={j}
                                    onClick={() => setLightbox(img)}
                                    className="relative group rounded-lg overflow-hidden border border-border hover:border-brand transition-colors"
                                    title="กดเพื่อขยาย"
                                    aria-label={`ขยายรูปที่ ${j + 2}`}
                                  >
                                    <img
                                      src={img}
                                      alt={`รูป ${j + 2}`}
                                      className="w-28 h-28 object-cover"
                                    />
                                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                                      <ZoomIn size={18} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        /* ── บอทตอบ (ขวา) — multi-bubble ด้วย ||| ── */
                        <div className="flex gap-2 flex-row-reverse">
                          <div className="w-8 h-8 rounded-full bg-brand/15 flex items-center justify-center shrink-0">
                            <Bot size={14} className="text-brand" />
                          </div>
                          <div className="flex-1 min-w-0 flex flex-col items-end gap-2">
                            <div className="text-xs text-text-subtle mb-1 text-right">
                              Bot ของเรา
                              {source && <span className="ml-1 text-text-subtle">[{source}]</span>}
                              {model && <span className="ml-1 text-text-subtle">· {model}</span>}
                              {elapsed != null && <span className="ml-1 text-text-subtle">· {elapsed}s</span>}
                            </div>
                            {/* ⚡ Phase 3B-7 — multi-bubble: แยก segment ด้วย ||| */}
                            {botSegments.map((seg, si) => {
                              const segKey = `${i}-seg-${si}`;
                              const isFullSeg = showFullBot.has(segKey);
                              const segText = isFullSeg ? seg : (seg.length > 400 ? seg.slice(0, 400) + "..." : seg);
                              return (
                                <div key={si} className="space-y-0.5 flex flex-col items-end">
                                  <div className="bg-brand text-white rounded-lg rounded-tr-sm px-3 py-2 text-sm max-w-[85%] w-fit">
                                    <MessageContent
                                      msg={{
                                        id: `bot_${i}_${si}`,
                                        role: "bot",
                                        text: segText,
                                        timestamp: m.timestamp || new Date().toISOString(),
                                      }}
                                      variant="out"
                                    />
                                  </div>
                                  {seg.length > 400 && (
                                    <button
                                      onClick={() => toggleFullBot(segKey)}
                                      className="text-xs text-brand hover:underline inline-flex items-center gap-0.5"
                                    >
                                      {isFullSeg ? <><EyeOff size={11} /> ย่อ</> : <><Eye size={11} /> ดูเต็ม</>}
                                    </button>
                                  )}
                                </div>
                              );
                            })}

                            {/* Rating + comment (ใต้ bubble บอท) */}
                            {hasRating && (
                              <div className="flex items-center gap-2 flex-wrap justify-end mt-1 max-w-[85%]">
                                {rating!.star_rating != null && rating!.star_rating > 0 && (
                                  <div className="flex items-center gap-0.5 bg-surface-2 rounded-full px-2 py-0.5">
                                    {[1, 2, 3, 4, 5].map((s) => (
                                      <Star
                                        key={s}
                                        size={12}
                                        className={rating!.star_rating! >= s ? "text-warning fill-warning" : "text-text-subtle"}
                                      />
                                    ))}
                                    <span className="text-xs text-text-muted ml-1">{rating!.star_rating}</span>
                                  </div>
                                )}
                                {rating!.rating && rating!.rating !== "unrated" && (
                                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RATING_COLORS[rating!.rating] || ""}`}>
                                    {rating!.rating === "good" ? "✓ ดี" : rating!.rating === "bad" ? "✗ ไม่ดี" : rating!.rating}
                                  </span>
                                )}
                                {rating!.comment && rating!.comment.trim() && (
                                  <div className="flex items-start gap-1.5 min-w-0 bg-surface-2 rounded-md px-2.5 py-1.5 max-w-full w-full">
                                    <MessageSquare size={12} className="text-text-muted shrink-0 mt-0.5" />
                                    <span className="text-xs text-text-muted italic" title={rating!.comment}>
                                      "{rating!.comment}"
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
              )}
            </div>
          </div>
        )}

        {/* ⚡ Phase 3B-7 — Image Lightbox */}
        {lightbox && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={() => setLightbox(null)}
          >
            <button
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
              onClick={() => setLightbox(null)}
              title="ปิด"
              aria-label="ปิด"
            >
              <X size={20} />
            </button>
            <img
              src={lightbox}
              alt="รูปขยาย"
              className="max-w-full max-h-full object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    </div>
  );
}
