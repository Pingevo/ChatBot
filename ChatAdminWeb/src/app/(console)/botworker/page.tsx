"use client";
// Bot Worker — หน้าตาเหมือน /tickets แต่:
//   - ซ้าย: ChatList (เดียวกับ tickets — ดึงจาก /admin/conversations)
//   - กลาง: BotWorkerChatPanel — แสดงแชท 3 สี (user/zaapi/bot) ไม่มี composer
//   - ขวา: ข้อมูล + ประวัติแชท (เหมือน tickets)
//
// ความแตกต่างจาก /tickets:
//   - ไม่มี composer (อ่านอย่างเดียว — botworker รันอัตโนมัติ)
//   - แสดง 3 สี: user (เทา) + zaapi (เขียว) + bot เรา (ฟ้า)
//   - ข้อความ bot มาจาก shadow_replies (ไม่ใช่ messages_shp)
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ArrowLeft, Info, X, PanelRightClose, PanelRightOpen, Bot, AlertCircle, Headset, RotateCcw, Lock, UserCog, ChevronDown } from "lucide-react";
import { ChatList } from "@/components/chat/ChatList";
import { InfoTab } from "@/components/chat/InfoTab";
import { ChatLogTab } from "@/components/chat/ChatLogTab";
import { ProductsTab } from "@/components/chat/ProductsTab";
import { CloseChatModal } from "@/components/chat/CloseChatModal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { MessageContent } from "@/components/chat/MessageContent";
import { DateBanner, dayKey } from "@/components/shadow/DateBanner";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { chatService } from "@/lib/services";
import { api } from "@/lib/apiClient";
import { usePolling } from "@/lib/usePolling";
import { useAuth } from "@/lib/authStore";
import { adminBubbleColor, ZAAPI_COLOR, BOT_COLOR } from "@/lib/bubbleColors";
import type { Conversation, ChatMessage, CloseHistoryRecord, AdminUser, ProblemCategory } from "@/lib/types";

type MobileView = "list" | "chat" | "info";

// ⚡ Phase 2T — unified message ที่ merge จาก messages_shp + shadow_replies
interface UnifiedMessage {
  id: string;
  role: "user" | "zaapi" | "bot" | "admin";
  text: string;
  timestamp: string;
  source: string;  // ⚡ ค่าจาก COLLECTIONS (ไม่ hardcode)
  admin_id?: string;
  admin_name?: string;
  products?: { item_id: string; name: string; price: number; image?: string }[];
  bot_source?: string;
  bot_model?: string;
  bot_elapsed_ms?: number;
  trigger_id?: string;
  mode?: string;
  origin?: string;
  image_desc?: string;
  // ⚡ rich media (parsed from raw_payload) — เหมือน /tickets
  message_type?: string;
  media?: { type: string; url?: string; thumb_url?: string; thumb_width?: number; thumb_height?: number; duration_seconds?: number };
  order_sn?: string;
  notification_text?: string;
  table?: { headers: string[]; rows: string[][] };
  bundle?: UnifiedMessage[];
}

export default function BotWorkerPage() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  // ⚡ pagination — head (200 newest, poll 3s) + tail (load more on scroll)
  const [tail, setTail] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // ⚡ server-side search — ส่ง q ไป API ให้ค้นที่ DB ทั้งหมด
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("list");
  const [closeHistory, setCloseHistory] = useState<CloseHistoryRecord[]>([]);
  const [rightTab, setRightTab] = useState<"info" | "chatlog" | "products">("info");
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [chatFilter, setChatFilter] = useState<string>("all");
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  // ⚡ D1-D3 — เพิ่ม close/reopen/handoff/transfer/accept เหมือน ticket
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closing, setClosing] = useState(false);
  const [acceptingChats, setAcceptingChats] = useState<boolean>(user?.is_accepting_chats ?? true);
  const [togglingAccept, setTogglingAccept] = useState(false);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  // โหลด admins list
  useEffect(() => {
    if (user?.role === "admin") return;
    api().get<{ users: AdminUser[]; canEdit: boolean }>("/users/list").then((r) => {
      setAdmins(r.data.users || []);
    }).catch(() => setAdmins([]));
  }, [user?.role]);

  // โหลด conversations (head — 200 ล่าสุด, poll 3 วิ)
  const loadConversations = useCallback(async () => {
    setLoadingConversations(true);
    try {
      const r = await api().get<{ rows: Conversation[]; total_count: number; has_more?: boolean; cursor?: string | null }>(
        "/botworker/conversations",
        { params: { limit: "200", include_count: "true", ...(searchQuery ? { q: searchQuery } : {}) }, timeout: 45000 }
      );
      const rows = r.data.rows || [];
      const total = r.data.total_count || rows.length;
      const seen = new Set<string>();
      const deduped = rows.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      setConversations(deduped);
      setTotalCount(total);
      setHasMore(r.data.has_more ?? false);
      setCursor(r.data.cursor ?? null);
      // ⚡ reset tail เมื่อ head โหลดใหม่ (search เปลี่ยน หรือ filter เปลี่ยน)
      setTail([]);
    } catch (err) {
      console.error("load conversations failed", err);
      // ⚡ G-fix — ไม่ clear conversations เดิมเวลา poll ล้มเหลว (กันหน้าว่าง)
    } finally {
      setLoadingConversations(false);
    }
  }, [searchQuery]);

  // ⚡ loadMore — โหลด page ถัดไป (tail) ตอน scroll ใกล้ล่าง
  const loadMore = useCallback(async () => {
    if (!cursor || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api().get<{ rows: Conversation[]; has_more?: boolean; cursor?: string | null }>(
        "/botworker/conversations",
        { params: { limit: "200", cursor, ...(searchQuery ? { q: searchQuery } : {}) }, timeout: 45000 }
      );
      const rows = r.data.rows || [];
      const existingIds = new Set([...conversations.map((c) => c.id), ...tail.map((c) => c.id)]);
      const newRows = rows.filter((c) => {
        if (existingIds.has(c.id)) return false;
        existingIds.add(c.id);
        return true;
      });
      setTail((prev) => [...prev, ...newRows]);
      setHasMore(r.data.has_more ?? false);
      setCursor(r.data.cursor ?? null);
    } catch (err) {
      console.error("load more failed", err);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, hasMore, loadingMore, conversations, tail, searchQuery]);

  // ⚡ combined conversations = head + tail (deduped)
  const allConversations = useMemo(() => {
    const seen = new Set<string>();
    const result: Conversation[] = [];
    for (const c of [...conversations, ...tail]) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        result.push(c);
      }
    }
    return result;
  }, [conversations, tail]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // ⚡ G-fix — poll 3 วิ (เท่า tickets) เพราะดึงแชท
  usePolling(loadConversations, 3000);

  // ⚡ Phase 2T — โหลด unified messages (user + zaapi + bot) จาก API ใหม่
  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    setLoadingMessages(true);
    api()
      .get<{ messages: UnifiedMessage[]; total: number }>(
        `/botworker/conversations/${selectedId}/messages`,
        { params: { limit: "200" }, timeout: 30000 }
      )
      .then((r) => {
        const seen = new Set<string>();
        setMessages((r.data.messages || []).filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        }));
      })
      .catch((err) => {
        console.error("load messages failed", err);
        setMessages([]);
      })
      .finally(() => setLoadingMessages(false));
  }, [selectedId]);

  // ⚡ G-fix — message poll 3 วิ + timeout 30s กันล็อค
  usePolling(
    useCallback(async () => {
      if (!selectedId) return;
      try {
        const r = await api().get<{ messages: UnifiedMessage[]; total: number }>(
          `/botworker/conversations/${selectedId}/messages`,
          { params: { limit: "200" }, timeout: 30000 }
        );
        const seen = new Set<string>();
        setMessages((r.data.messages || []).filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        }));
      } catch {
        // ignore — keep existing messages
      }
    }, [selectedId]),
    3000,
    { enabled: !!selectedId }
  );

  // Load close history
  useEffect(() => {
    if (!selectedId) { setCloseHistory([]); return; }
    chatService
      .closeHistory(selectedId)
      .then((d) => setCloseHistory(d.history || []))
      .catch(() => setCloseHistory([]));
  }, [selectedId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileView("chat");
  }, []);

  const handleBack = useCallback(() => {
    setMobileView("list");
    setSelectedId(null);
  }, []);

  // แปลง UnifiedMessage → ChatMessage สำหรับ InfoTab/ChatLogTab/ProductsTab
  const chatMessagesForTabs: ChatMessage[] = messages.map((m) => ({
    id: m.id,
    role: m.role === "user" ? "user" : m.role === "admin" ? "admin" : "bot",
    text: m.text,
    timestamp: m.timestamp,
    source: m.source,
    admin_id: m.admin_id,
    admin_name: m.admin_name,
    products: m.products,
    // ⚡ rich media fields
    message_type: m.message_type as ChatMessage["message_type"],
    media: m.media as ChatMessage["media"],
    order_sn: m.order_sn,
    notification_text: m.notification_text,
    table: m.table as ChatMessage["table"],
  }));

  // ⚡ D1-D3 — handlers เหมือน ticket (close/reopen/handoff/transfer/accept)
  const handleResolve = useCallback(() => {
    if (!selectedId) return;
    setShowCloseModal(true);
  }, [selectedId]);

  const handleClose = useCallback(
    async (data: { reason: string; category: ProblemCategory; resolution: string; note?: string }) => {
      if (!selectedId) return;
      setClosing(true);
      try {
        await chatService.close(selectedId, data);
        setConversations((prev) =>
          prev.map((c) => (c.id === selectedId ? { ...c, status: "closed" as never } : c))
        );
        setShowCloseModal(false);
        const d = await chatService.closeHistory(selectedId);
        setCloseHistory(d.history || []);
      } catch {
        // ignore — keep modal open
      } finally {
        setClosing(false);
      }
    },
    [selectedId]
  );

  const handleReopen = useCallback(async () => {
    if (!selectedId) return;
    try {
      await chatService.reopen(selectedId, "แอดมินเปิดแชทใหม่ (botworker)");
      setConversations((prev) =>
        prev.map((c) => (c.id === selectedId ? { ...c, status: "handoff" as never } : c))
      );
      const d = await chatService.closeHistory(selectedId);
      setCloseHistory(d.history || []);
    } catch {
      // ignore
    }
  }, [selectedId]);

  const handleHandoff = useCallback(() => {
    if (!selectedId) return;
    chatService.handoff(selectedId).catch(() => { });
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedId ? { ...c, status: "handoff" } : c))
    );
  }, [selectedId]);

  const handleTransfer = useCallback(async (newAdminId: string) => {
    if (!selectedId) return;
    try {
      await api().post("/assignment/reassign", {
        conversation_id: selectedId,
        new_admin_id: newAdminId,
        reason: "โยนแชทจากหน้า botworker",
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedId ? { ...c, assigned_to: newAdminId } : c
        )
      );
    } catch {
      // ignore
    }
  }, [selectedId]);

  const handleToggleAccepting = useCallback(async () => {
    setTogglingAccept(true);
    try {
      const r = await chatService.setAcceptingChats(!acceptingChats);
      setAcceptingChats(r.is_accepting_chats);
    } catch (err) {
      console.error("toggle accepting failed", err);
    } finally {
      setTogglingAccept(false);
    }
  }, [acceptingChats]);

  return (
    <div className="h-full flex">
      {/* ── Panel ซ้าย: ChatList (เหมือน tickets) ── */}
      <div className={`${mobileView === "list" ? "flex" : "hidden"} md:flex h-full flex-col w-full md:w-80 shrink-0 border-r border-border`}>
        <ChatList
          conversations={allConversations}
          selectedId={selectedId}
          onSelect={handleSelect}
          admins={admins}
          chatFilter={chatFilter}
          onChatFilterChange={setChatFilter}
          acceptingChats={acceptingChats}
          onToggleAccepting={handleToggleAccepting}
          togglingAccept={togglingAccept}
          totalCount={totalCount}
          onSearchChange={setSearchQuery}
          loading={loadingConversations}
          loadMore={loadMore}
          hasMore={hasMore}
          loadingMore={loadingMore}
        />
      </div>

      {/* ── Panel กลาง: BotWorkerChatPanel (3 สี ไม่มี composer) ── */}
      <div className={`${mobileView === "chat" ? "flex" : "hidden"} md:flex flex-1 h-full min-w-0 relative`}>
        {/* Mobile back button */}
        <button
          onClick={handleBack}
          className="md:hidden absolute top-3 left-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
          title="กลับ"
        >
          <ArrowLeft size={16} className="text-text" />
        </button>
        {/* Mobile info button */}
        {selected && (
          <button
            onClick={() => setMobileView("info")}
            className="md:hidden absolute top-3 right-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
            title="รายละเอียด"
          >
            <Info size={16} className="text-text" />
          </button>
        )}
        <BotWorkerChatPanel
          conversation={selected}
          messages={messages}
          loading={loadingMessages}
          onHandoff={handleHandoff}
          onResolve={handleResolve}
          onReopen={handleReopen}
          onTransfer={handleTransfer}
          admins={admins}
        />
      </div>

      {/* ── Panel ขวา: ข้อมูล / ประวัติแชท / สินค้า (เหมือน tickets) ── */}
      {selected && (
        <>
          <div
            className={`${mobileView === "info" ? "flex" : "hidden"} ${rightCollapsed ? "md:hidden" : "md:flex"} h-full transition-[width] duration-200 ease-in-out`}
          >
            <div className="relative h-full flex flex-col w-[340px] border-l border-border bg-surface">
              <button
                onClick={() => setMobileView("chat")}
                className="md:hidden absolute top-3 left-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
                title="กลับ"
              >
                <ArrowLeft size={16} className="text-text" />
              </button>

              {/* Tab switcher */}
              <div className="flex border-b border-border shrink-0">
                <button
                  onClick={() => setRightTab("info")}
                  className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "info" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"}`}
                >
                  ข้อมูล
                </button>
                <button
                  onClick={() => setRightTab("chatlog")}
                  className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "chatlog" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"}`}
                >
                  ประวัติแชท
                </button>
                <button
                  onClick={() => setRightTab("products")}
                  className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "products" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"}`}
                >
                  สินค้า
                </button>
                <button
                  onClick={() => setRightCollapsed(true)}
                  className="px-2 text-text-muted hover:text-text transition-colors shrink-0"
                  title="ซ่อน panel"
                >
                  <PanelRightClose size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-hidden">
                {rightTab === "info" && (
                  <InfoTab
                    conversation={selected}
                    messages={chatMessagesForTabs}
                    closeHistory={closeHistory}
                    onSuggestProduct={() => {}}
                    onCreateTicket={() => {}}
                    onSendCode={() => {}}
                  />
                )}
                {rightTab === "chatlog" && (
                  <ChatLogTab messages={chatMessagesForTabs} />
                )}
                {rightTab === "products" && (
                  <ProductsTab
                    conversation={selected}
                    onSendProduct={() => {}}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Expand button เมื่อ collapsed */}
          {rightCollapsed && (
            <button
              onClick={() => setRightCollapsed(false)}
              className="hidden md:flex absolute right-0 top-1/2 -translate-y-1/2 z-10 w-6 h-12 bg-surface border border-border rounded-l-lg items-center justify-center hover:bg-surface-2 transition-colors"
              title="แสดง panel"
            >
              <PanelRightOpen size={16} className="text-text-muted" />
            </button>
          )}
        </>
      )}

      {/* ⚡ D1-D3 — Close Chat Modal (เหมือน ticket) */}
      {showCloseModal && selected && (
        <CloseChatModal
          conversation={selected}
          onClose={() => setShowCloseModal(false)}
          onSubmit={handleClose}
          loading={closing}
        />
      )}
    </div>
  );
}

// ─── BotWorkerChatPanel — แชท 3 สี ไม่มี composer ──────────────

interface BotWorkerChatPanelProps {
  conversation: Conversation | null;
  messages: UnifiedMessage[];
  loading: boolean;
  // ⚡ D1-D3 — action buttons เหมือน ticket
  onHandoff?: () => void;
  onResolve?: () => void;
  onReopen?: () => void;
  onTransfer?: (newAdminId: string) => void;
  admins?: AdminUser[];
}

function BotWorkerChatPanel({ conversation, messages, loading, onHandoff, onResolve, onReopen, onTransfer, admins = [] }: BotWorkerChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // ⚡ track ว่า user อยู่ใกล้ล่างไหม — ถ้าไม่ใช่ (กำลังเลื่อนขึ้นอ่าน) จะไม่ auto-scroll
  const wasNearBottomRef = useRef(true);
  const prevConvIdRef = useRef<string | null>(null);

  // ⚡ track scroll position จาก onScroll handler จริง (ไม่ใช่ effect หลัง re-render)
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasNearBottomRef.current = distFromBottom < 80;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const convId = conversation?.id ?? null;
    const isConvChange = convId !== prevConvIdRef.current;
    if (isConvChange) {
      prevConvIdRef.current = convId;
      wasNearBottomRef.current = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      });
      return;
    }
    // ไม่ใช่ conversation change — scroll ลงล่างเฉพาะเมื่อ user อยู่ใกล้ล่างอยู่แล้ว
    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, conversation?.id]);

  if (!conversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <Bot size={48} className="text-text-subtle mb-3" />
        <p className="text-sm text-text-muted">เลือกแชทจากรายการด้านซ้าย</p>
        <p className="text-[11px] text-text-subtle mt-1">
          จะแสดงแชท 4 สี — user (เทา) · zaapi (เขียว) · admin (แดง) · bot เรา (น้ำเงิน)
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* ── Header (topbar) — เหมือน /tickets ทุกประการ ── */}
      <div className="px-4 py-2.5 border-b border-border bg-surface shrink-0">
        <div className="flex items-center gap-3">
          <Avatar name={conversation.customer_name} src={conversation.customer_avatar} size={34} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text truncate">{conversation.customer_name || conversation.id}</span>
              <PlatformIcon platform={conversation.platform} size={16} />
            </div>
            <div className="text-[11px] text-text-muted truncate">{conversation.shop_name}</div>
          </div>

          {/* Admin responsible — แสดงว่าใครรับผิดชอบ (หรือ "บอท") */}
          <div className="flex items-center gap-1.5 text-xs text-text-muted shrink-0">
            <Headset size={12} />
            <span>
              {conversation.status === "bot"
                ? "บอทตอบ"
                : conversation.assigned_to
                  ? (conversation.assigned_to_name || conversation.assigned_to.slice(0, 8))
                  : "—"}
            </span>
          </div>

          {/* Transfer dropdown — โยนแชทให้ admin คนอื่น */}
          {onTransfer && conversation.status !== "bot" && (
            <BotWorkerTransferDropdown currentAdminId={conversation.assigned_to} onSelect={onTransfer} />
          )}

          {conversation.status === "bot" && onHandoff && (
            <Button size="sm" variant="outline" onClick={onHandoff} className="shrink-0">
              <Headset size={14} /> รับเรื่อง
            </Button>
          )}
          {conversation.status === "closed" ? (
            onReopen && (
              <Button size="sm" variant="outline" onClick={onReopen} className="shrink-0">
                <RotateCcw size={14} /> เปิดแชทใหม่
              </Button>
            )
          ) : (
            onResolve && (
              <Button size="sm" onClick={onResolve} className="shrink-0">
                <Lock size={14} /> ปิดสนทนา
              </Button>
            )
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-text-muted text-sm">
            กำลังโหลด...
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Bot size={32} className="text-text-subtle mb-2" />
            <p className="text-xs text-text-muted">ยังไม่มีข้อความใน conversation นี้</p>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => {
              // ⚡ Date separator — แทรก DateBanner เมื่อวันเปลี่ยน (เหมือน LINE)
              const dk = dayKey(msg.timestamp);
              const showDate = i === 0 || dk !== dayKey(messages[i - 1].timestamp);
              return (
                <React.Fragment key={msg.id}>
                  {showDate && <DateBanner timestamp={msg.timestamp} onlyToday />}
                  <UnifiedBubble msg={msg} customerName={conversation?.customer_name} customerAvatar={conversation?.customer_avatar} />
                </React.Fragment>
              );
            })}

            {/* Safety notice */}
            <div className="flex items-start gap-2 rounded-lg bg-green-500/5 border border-green-500/15 p-3 mt-4">
              <AlertCircle size={14} className="text-green-400 flex-shrink-0 mt-0.5" />
              <div className="text-[11px] text-text-muted leading-relaxed">
                <span className="text-green-400 font-medium">ปลอดภัย:</span> คำตอบ bot (ฟ้า) เก็บใน shadow_replies
                ไม่ส่งถึงลูกค้า ไม่ยิง Shopee API — zaapi (เขียว) คือข้อความจริงที่ sellcenter dump มา
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── UnifiedBubble — message bubble 3 สี ───────────────────────

import { useRef } from "react";
import { User, Zap, Bot as BotIcon } from "lucide-react";

function UnifiedBubble({ msg, customerName, customerAvatar }: { msg: UnifiedMessage; customerName?: string; customerAvatar?: string }) {
  const isUser = msg.role === "user";
  const isZaapi = msg.role === "zaapi";
  const isBot = msg.role === "bot";
  const isAdmin = msg.role === "admin";
  // ⚡ ดึง admin_id + bubble_color ปัจจุบันจาก authStore — admin ปัจจุบัน → ใช้สีที่ตั้งใน profile
  const myAdminId = useAuth((s) => s.user?.admin_id);
  const myBubbleColor = useAuth((s) => s.user?.bubble_color);
  const adminColor = adminBubbleColor(msg.admin_id, myAdminId, myBubbleColor);

  // Multi-bubble support (bot แบ่งคำตอบด้วย |||)
  const segments = !isUser ? splitAnswerSegments(msg.text) : [msg.text];
  const hasMulti = segments.length > 1;

  const segmentMsgs = hasMulti
    ? segments.map((seg, i) => ({
        ...msg,
        text: seg,
        products: i === segments.length - 1 ? msg.products : undefined,
      }))
    : [msg];

  // สี
  let bubbleClass = "";
  let avatarClass = "";
  let icon = null;
  let label = "";

  if (isUser) {
    bubbleClass = "bg-surface border border-border text-text rounded-tl-sm";
    avatarClass = "";
    icon = <User size={16} className="text-text-muted" />;
    label = "user";
  } else if (isZaapi) {
    // ⚡ zaapi: #11302e (เขียวเข้มมาก), ขาว text
    bubbleClass = "text-white rounded-tr-sm";
    avatarClass = "";
    icon = <Zap size={16} className="text-white" />;
    label = "zaapi";
  } else if (isAdmin) {
    // ⚡ admin: สีที่ตั้งใน profile (default #560C0E แดงเข้ม), ขาว text
    bubbleClass = "text-white rounded-tr-sm";
    avatarClass = "";
    icon = <Headset size={16} className="text-white" />;
    label = msg.admin_name || "admin";
  } else if (isBot) {
    // ⚡ bot: #0b2340 (sidebar navy), ขาว text
    bubbleClass = "text-white rounded-tr-sm";
    avatarClass = "";
    icon = <BotIcon size={16} className="text-white" />;
    label = "bot";
  }

  // สร้าง ChatMessage สำหรับ MessageContent
  const toChatMsg = (m: UnifiedMessage): ChatMessage => ({
    id: m.id,
    role: m.role === "user" ? "user" : m.role === "admin" ? "admin" : "bot",
    text: m.text,
    timestamp: m.timestamp,
    admin_id: m.admin_id,
    admin_name: m.admin_name,
    products: m.products,
    // ⚡ ส่ง rich media fields ไป MessageContent ให้แสดงรูป/สติกเกอร์/การ์ดสินค้าได้
    message_type: m.message_type as ChatMessage["message_type"],
    media: m.media as ChatMessage["media"],
    order_sn: m.order_sn,
    notification_text: m.notification_text,
    table: m.table as ChatMessage["table"],
    // ⚡ bundle_message — ส่ง sub-messages ไป MessageContent ให้แสดง bundle ได้
    bundle: m.bundle as ChatMessage["bundle"],
  });

  return (
    <div className={`flex gap-2.5 ${isUser ? "justify-start" : "justify-end"} animate-fade-in`}>
      {isUser && <Avatar name={customerName || "User"} src={customerAvatar} size={32} className="mt-1 shrink-0" />}
      <div className={`max-w-[70%] ${isUser ? "" : "flex flex-col items-end gap-1"}`}>
        {/* Label */}
        {(isZaapi || isBot || isAdmin) && (
          <div className="text-[10px] text-text-muted mb-0.5 pr-1 flex items-center gap-1">
            {icon}
            <span>{label}</span>
            {isBot && msg.bot_model && <span className="opacity-60">· {msg.bot_model}</span>}
            {isBot && msg.trigger_id && <Badge tone="neutral" className="text-[8px]">trigger</Badge>}
          </div>
        )}
        {segmentMsgs.map((segMsg, i) => (
          <div key={i} className={`rounded-2xl px-3.5 py-2 text-sm ${bubbleClass}`} style={isZaapi ? { backgroundColor: ZAAPI_COLOR } : isBot ? { backgroundColor: BOT_COLOR } : isAdmin ? { backgroundColor: adminColor } : undefined}>
            <MessageContent msg={toChatMsg(segMsg)} variant={isUser ? "user" : "out"} />
          </div>
        ))}
        {/* Timestamp + metadata */}
        <div className="flex items-center gap-1.5 mt-1 text-[10px] text-text-subtle">
          {isBot && <BotIcon size={10} />}
          {isZaapi && <Zap size={10} />}
          {isAdmin && <Headset size={10} />}
          <span>{new Date(msg.timestamp).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}</span>
          {isBot && msg.bot_elapsed_ms != null && (
            <span className="opacity-60">
              · {msg.bot_elapsed_ms < 1000 ? `${msg.bot_elapsed_ms}ms` : `${(msg.bot_elapsed_ms / 1000).toFixed(1)}s`}
            </span>
          )}
          {isBot && msg.bot_source && <span className="opacity-60">· {msg.bot_source}</span>}
          {isZaapi && <span className="opacity-60">· sellcenter</span>}
        </div>
      </div>
      {!isUser && (
        <div className={`mt-1 w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${avatarClass}`} style={isZaapi ? { backgroundColor: ZAAPI_COLOR } : isBot ? { backgroundColor: BOT_COLOR } : isAdmin ? { backgroundColor: adminColor } : undefined}>
          {isZaapi ? <Zap size={16} className="text-white" /> : isAdmin ? <Headset size={16} className="text-white" /> : <BotIcon size={16} className="text-white" />}
        </div>
      )}
    </div>
  );
}

/* ---------- TransferDropdown — เหมือน /tickets ---------- */

interface AdminRow {
  admin_id: string;
  name?: string;
  username?: string;
  role: string;
  active: boolean;
}

function BotWorkerTransferDropdown({
  currentAdminId,
  onSelect,
}: {
  currentAdminId?: string;
  onSelect: (adminId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadAdmins() {
    setLoading(true);
    try {
      const r = await fetch("/api/users/list");
      const data = await r.json();
      const list = (data.users || []).filter((u: AdminRow) => u.role === "admin" && u.active);
      setAdmins(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  function handleClick() {
    if (!open) loadAdmins();
    setOpen(!open);
  }

  const current = admins.find((a) => a.admin_id === currentAdminId);

  return (
    <div className="relative shrink-0">
      <button
        onClick={handleClick}
        className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text transition-colors"
        title="โยนแชทให้แอดมินคนอื่น"
      >
        <UserCog size={12} />
        <span className="hidden sm:inline">{current ? current.name || current.username : "โยนแชท"}</span>
        <ChevronDown size={10} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 w-56 bg-surface border border-border rounded-lg shadow-lg z-40 max-h-64 overflow-y-auto">
            <div className="px-3 py-2 text-[11px] font-semibold uppercase text-text-muted border-b border-border">
              {loading ? "กำลังโหลด..." : "เลือกแอดมิน"}
            </div>
            {admins.map((a) => (
              <button
                key={a.admin_id}
                onClick={() => {
                  onSelect(a.admin_id);
                  setOpen(false);
                }}
                disabled={a.admin_id === currentAdminId}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-2 transition-colors flex items-center justify-between gap-2 ${
                  a.admin_id === currentAdminId ? "opacity-50 cursor-not-allowed" : "text-text"
                }`}
              >
                <span>{a.name || a.username}</span>
                {a.admin_id === currentAdminId && <span className="text-[10px] text-text-muted">ปัจจุบัน</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
