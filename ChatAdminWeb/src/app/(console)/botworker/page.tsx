"use client";
// Bot Worker — parallel sandbox ของ /tickets (state แยกผ่าน test_status_conversation[botworker]):
//   - ซ้าย: ChatList (เดียวกับ tickets — ดึงจาก /botworker/conversations)
//   - กลาง: BotWorkerChatPanel — แสดงแชท 4 สี (user/zaapi/admin/bot) + composer
//   - ขวา: ข้อมูล + ประวัติแชท (เหมือน tickets)
//
// ความแตกต่างจาก /tickets:
//   - ทุก action (รับเรื่อง/โยนงาน/ตอบ/ปิด/เปิด) เขียน test store เท่านั้น — ไม่แตะ ticket จริง
//   - admin reply เก็บใน botworker_messages (ไม่ส่ง Shopee ไม่เขียน messages_shp)
//   - แสดง 4 สี: user (เทา) + zaapi (เขียว) + admin (สี profile) + bot เรา (ฟ้า)
//   - ข้อความ bot มาจาก shadow_replies (ไม่ใช่ messages_shp)
import { SelectField } from "@/components/ui/SelectField";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ArrowLeft, Info, X, PanelRightClose, PanelRightOpen, Bot, AlertCircle, Headset, RotateCcw, Lock, UserCog, ChevronDown } from "lucide-react";
import { ChatList } from "@/components/chat/ChatList";
import { InfoTab } from "@/components/chat/InfoTab";
import { ChatLogTab } from "@/components/chat/ChatLogTab";
import { ProductsTab } from "@/components/chat/ProductsTab";
import { CloseChatModal } from "@/components/chat/CloseChatModal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToastError } from "@/components/ui/Toast";
import { Avatar } from "@/components/ui/Avatar";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { MessageContent } from "@/components/chat/MessageContent";
import { DateBanner, dayKey } from "@/components/shadow/DateBanner";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { mergeBubbleResult } from "@/lib/reviewUi";
import { chatService } from "@/lib/services";
import { api } from "@/lib/apiClient";
import { usePolling } from "@/lib/usePolling";
import { useAuth } from "@/lib/authStore";
import { adminBubbleColor, adminBubbleTextColor, ZAAPI_COLOR, BOT_COLOR } from "@/lib/bubbleColors";
import type { Conversation, ChatMessage, CloseHistoryRecord, AdminUser, ProblemCategory } from "@/lib/types";

type MobileView = "list" | "chat" | "info";

// ⚡ review — per-bubble contract (ตรง reviewService.ts)
interface ReviewBubble {
  bubble_id: string;
  ordinal: number;
  original_text: string;
  edited_text?: string;
  decision: "pending" | "approved" | "edited_approved" | "rejected";
  decided_by?: string;
  decided_at?: string;
  approved_text?: string;
  delivery: { state: "not_requested" | "mock_sent" | "mock_failed"; request_id?: string; receipt?: { provider: string; delivered: boolean }; error?: string };
  card?: { item_id: string; delivery: { state: string; error?: string } };
}

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
  bubble_color?: string; // ⚡ สี bubble ที่ admin เลือก (จาก botworker_messages)
  bot_products?: { item_id?: string; itemid?: string; name?: string; price?: number; image?: string; shop?: string; shop_id?: string; shopid?: string }[]; // ⚡ review — card attach
  review_bubbles?: ReviewBubble[]; // ⚡ review — frozen per-bubble state (absent = legacy draft)
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
  const { catchError } = useToastError();
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
  const [canReview, setCanReview] = useState(false); // ⚡ designated review admin+shop (server-derived)
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
    }).catch((e) => {
      catchError(e, "โหลดรายชื่อแอดมินไม่สำเร็จ");
      setAdmins([]);
    });
  }, [user?.role]);

  // โหลด conversations (head — 200 ล่าสุด, poll 3 วิ)
  const loadConversations = useCallback(async () => {
    setLoadingConversations(true);
    try {
      const r = await api().get<{ rows: Conversation[]; total_count: number; has_more?: boolean; cursor?: string | null }>(
        "/botworker/conversations",
        { params: { limit: "200", include_count: "true", assigned_to: chatFilter, ...(searchQuery ? { q: searchQuery } : {}) }, timeout: 45000 }
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
  }, [searchQuery, chatFilter]);

  // ⚡ loadMore — โหลด page ถัดไป (tail) ตอน scroll ใกล้ล่าง
  const loadMore = useCallback(async () => {
    if (!cursor || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api().get<{ rows: Conversation[]; has_more?: boolean; cursor?: string | null }>(
        "/botworker/conversations",
        { params: { limit: "200", cursor, assigned_to: chatFilter, ...(searchQuery ? { q: searchQuery } : {}) }, timeout: 45000 }
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
  }, [cursor, hasMore, loadingMore, conversations, tail, searchQuery, chatFilter]);

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

  // ⚡ poll เดียวทำ initial load + refresh — immediate ยิงตอน mount/restart
  //   restartKey=loadConversations → searchQuery/chatFilter เปลี่ยน = effect เดิม refire
  //   (กัน overlap ระหว่าง initial fetch กับ poll tick — เหลือ mechanism เดียว)
  usePolling(loadConversations, 3000, { immediate: true, restartKey: loadConversations });

  // ⚡ Phase 2T — messages: clear ตอนเลือก/ยกเลิก conv (non-fetch effect)
  //   fetch เดียวอยู่ใน usePolling — immediate+restartKey=selectedId
  useEffect(() => {
    setMessages([]);
    setLoadingMessages(!!selectedId);
  }, [selectedId]);

  // ⚡ G-fix — message poll 3 วิ + timeout 30s กันล็อค (initial load อยู่ในนี้แล้ว)
  usePolling(
    useCallback(async () => {
      if (!selectedId) return;
      try {
        const r = await api().get<{ messages: UnifiedMessage[]; total: number; can_review?: boolean }>(
          `/botworker/conversations/${selectedId}/messages`,
          { params: { limit: "200" }, timeout: 30000 }
        );
        setCanReview(r.data.can_review === true);
        const seen = new Set<string>();
        setMessages((r.data.messages || []).filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        }));
      } catch {
        // ignore — keep existing messages
      } finally {
        setLoadingMessages(false);
      }
    }, [selectedId]),
    3000,
    { enabled: !!selectedId, immediate: true, restartKey: selectedId }
  );

  // ⚡ Load close history จาก test store (botworker) — แยกจาก ticket จริง
  const loadBwCloseHistory = useCallback(async (id: string) => {
    try {
      const r = await api().get<{ close_history: CloseHistoryRecord[] }>(`/botworker/conversations/${id}/close-history`);
      setCloseHistory(r.data.close_history || []);
    } catch {
      setCloseHistory([]);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) { setCloseHistory([]); return; }
    loadBwCloseHistory(selectedId);
  }, [selectedId, loadBwCloseHistory]);

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

  // ⚡ ปิดแชทใน sandbox — เขียน test_status_conversation เท่านั้น ไม่แตะ ticket จริง
  const handleClose = useCallback(
    async (data: { reason: string; category: ProblemCategory; resolution: string; note?: string }) => {
      if (!selectedId) return;
      setClosing(true);
      try {
        await api().post(`/botworker/conversations/${selectedId}/close`, data);
        setConversations((prev) =>
          prev.map((c) => (c.id === selectedId ? { ...c, status: "closed" as never } : c))
        );
        setShowCloseModal(false);
        await loadBwCloseHistory(selectedId);
      } catch (e) {
        catchError(e, "ปิดแชทไม่สำเร็จ");
      } finally {
        setClosing(false);
      }
    },
    [selectedId, loadBwCloseHistory]
  );

  // ⚡ เปิดแชทใหม่ใน sandbox — เขียน test store เท่านั้น
  const handleReopen = useCallback(async () => {
    if (!selectedId) return;
    try {
      const r = await api().post<{ status?: string }>(`/botworker/conversations/${selectedId}/reopen`, {
        reason: "แอดมินเปิดแชทใหม่ (botworker)",
      });
      setConversations((prev) =>
        prev.map((c) => (c.id === selectedId ? { ...c, status: (r.data.status || "open") as never } : c))
      );
      await loadBwCloseHistory(selectedId);
    } catch (e) {
      catchError(e, "เปิดแชทใหม่ไม่สำเร็จ");
    }
  }, [selectedId, loadBwCloseHistory]);

  // ⚡ "รับเรื่อง" = self-assign ใน sandbox — เขียน test store, worker จะ skip แชทนี้
  const handleHandoff = useCallback(async () => {
    if (!selectedId) return;
    try {
      const r = await api().post<{ status?: string; assigned_to?: string; assigned_to_name?: string }>(
        `/botworker/conversations/${selectedId}/accept`,
        {}
      );
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedId
            ? { ...c, status: (r.data.status || "open") as never, assigned_to: r.data.assigned_to, assigned_to_name: r.data.assigned_to_name }
            : c
        )
      );
    } catch (e) {
      catchError(e, "รับเรื่องไม่สำเร็จ — อาจมีแอดมินคนอื่นรับไปแล้ว");
    }
  }, [selectedId]);

  // ⚡ โยนแชทให้ admin อื่นใน sandbox — เขียน test store เท่านั้น
  const handleTransfer = useCallback(async (newAdminId: string) => {
    if (!selectedId) return;
    try {
      const r = await api().post<{ status?: string; assigned_to?: string; assigned_to_name?: string }>(
        `/botworker/conversations/${selectedId}/transfer`,
        { admin_id: newAdminId }
      );
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedId
            ? { ...c, assigned_to: r.data.assigned_to, assigned_to_name: r.data.assigned_to_name, status: (r.data.status || "open") as never }
            : c
        )
      );
    } catch (e) {
      catchError(e, "โยนแชทไม่สำเร็จ");
    }
  }, [selectedId]);

  // ⚡ admin ตอบแชทใน sandbox — เขียน botworker_messages เท่านั้น ไม่ส่ง Shopee/messages_shp
  const handleSend = useCallback(async (text: string) => {
    if (!selectedId || !text.trim()) return;
    try {
      const r = await api().post<{ message?: UnifiedMessage; conflict?: boolean; assigned_to?: string }>(
        `/botworker/conversations/${selectedId}/send`,
        { text: text.trim() }
      );
      if (r.data.message) {
        setMessages((prev) => (prev.some((m) => m.id === r.data.message!.id) ? prev : [...prev, r.data.message!]));
      }
    } catch (e) {
      catchError(e, "ส่งข้อความไม่สำเร็จ");
      throw e;
    }
  }, [selectedId]);

  // ⚡ review action — POST /review; server คืน bubble ใหม่ → patch message state
  // ⚡ op id reuse ต่อ (bubble,action,payload) — retry เจตนาเดิมได้ replay guarantee จาก server
  const opIdsRef = useRef<Map<string, string>>(new Map());
  const handleReviewAction = useCallback(async (msgId: string, bubbleId: string, action: string, extra: Record<string, unknown> = {}) => {
    if (!selectedId) return;
    const opKey = `${msgId}:${bubbleId}:${action}:${JSON.stringify(extra)}`;
    let opId = opIdsRef.current.get(opKey);
    if (!opId) {
      opId = `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      opIdsRef.current.set(opKey, opId);
    }
    try {
      const r = await api().post<{ ok: boolean; message?: string; bubble?: ReviewBubble }>(
        `/botworker/conversations/${selectedId}/review`,
        { reply_id: msgId, bubble_id: bubbleId, action, operation_id: opId, ...extra }
      );
      const data = r.data as { ok?: boolean; message?: string; bubble?: ReviewBubble; detail?: string };
      if (!data.ok && !data.bubble) throw new Error(data.message || data.detail || "review action failed");
      if (data.bubble) {
        setMessages((prev) => mergeBubbleResult(prev, msgId, data.bubble!));
      }
      if (!data.ok) throw new Error(data.message || "review action failed");
      opIdsRef.current.delete(opKey);
    } catch (e) {
      // network/transport error → เก็บ op id ไว้ retry เจตนาเดิม; app-level 409/422 เปลี่ยนเจตนาแล้ว → ล้าง
      if (e instanceof Error && !/failed|conflict|invalid/i.test(e.message)) throw e;
      opIdsRef.current.delete(opKey);
      throw e;
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
    <div className="relative h-full min-w-0 flex overflow-hidden">
      {/* ── Panel ซ้าย: ChatList (เหมือน tickets) ── */}
      <div className={`${mobileView === "list" ? "flex" : "hidden"} 2xl:flex h-full min-w-0 flex-col w-full 2xl:w-80 shrink-0 border-r border-border`}>
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
      <div className={`${mobileView === "chat" ? "flex" : "hidden"} 2xl:flex flex-1 h-full min-w-0 relative`}>
        <BotWorkerChatPanel
          conversation={selected}
          messages={messages}
          loading={loadingMessages}
          onHandoff={handleHandoff}
          onResolve={handleResolve}
          onReopen={handleReopen}
          onTransfer={handleTransfer}
          onSend={handleSend}
          admins={admins}
          canReview={canReview}
          onReviewAction={handleReviewAction}
          onBack={handleBack}
          onInfo={selected ? () => setMobileView("info") : undefined}
        />
      </div>

      {/* ── Panel ขวา: ข้อมูล / ประวัติแชท / สินค้า (เหมือน tickets) ── */}
      {selected && (
        <>
          <div
            className={`${mobileView === "info" ? "flex" : "hidden"} ${rightCollapsed ? "2xl:hidden" : "2xl:flex"} h-full w-full 2xl:w-auto transition-[width] duration-200 ease-in-out`}
          >
            <div className="relative h-full flex flex-col w-full 2xl:w-[340px] border-l border-border bg-surface">
              <button
                onClick={() => setMobileView("chat")}
                className="2xl:hidden absolute top-3 left-3 z-10 w-11 h-11 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
                title="กลับ"
                aria-label="กลับ"
              >
                <ArrowLeft size={16} className="text-text" />
              </button>

              {/* Tab switcher */}
              <div className="flex border-b border-border shrink-0">
                <button
                  onClick={() => setRightTab("info")}
                  className={`min-h-11 2xl:min-h-0 flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "info" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"}`}
                >
                  ข้อมูล
                </button>
                <button
                  onClick={() => setRightTab("chatlog")}
                  className={`min-h-11 2xl:min-h-0 flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "chatlog" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"}`}
                >
                  ประวัติแชท
                </button>
                <button
                  onClick={() => setRightTab("products")}
                  className={`min-h-11 2xl:min-h-0 flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "products" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"}`}
                >
                  สินค้า
                </button>
                <button
                  onClick={() => setRightCollapsed(true)}
                  className="hidden 2xl:block px-2 text-text-muted hover:text-text transition-colors shrink-0"
                  title="ซ่อน panel"
                  aria-label="ซ่อน panel"
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
              className="hidden 2xl:flex absolute right-0 top-1/2 -translate-y-1/2 z-10 w-6 h-12 bg-surface border border-border rounded-l-lg items-center justify-center hover:bg-surface-2 transition-colors"
              title="แสดง panel"
              aria-label="แสดง panel"
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
  onSend?: (text: string) => Promise<void>;
  admins?: AdminUser[];
  canReview?: boolean;
  onReviewAction?: (msgId: string, bubbleId: string, action: string, extra?: Record<string, unknown>) => Promise<void>;
  // ⚡ mobile nav — back/info เข้า header แทนปุ่มลอย (เดิมทับ avatar/ปุ่มปิดสนทนา)
  onBack?: () => void;
  onInfo?: () => void;
}

function BotWorkerChatPanel({ conversation, messages, loading, onHandoff, onResolve, onReopen, onTransfer, onSend, admins = [], canReview, onReviewAction, onBack, onInfo }: BotWorkerChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
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
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 relative">
        {onBack && (
          <button
            onClick={onBack}
            title="กลับ"
            aria-label="กลับ"
            className="2xl:hidden absolute top-3 left-3 w-11 h-11 rounded-lg border border-border bg-surface flex items-center justify-center text-text hover:bg-surface-2 transition-colors"
          >
            <ArrowLeft size={17} />
          </button>
        )}
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
      {/* ── Header (topbar) — มือถือแยก 2 แถว (nav+identity / actions) desktop แถวเดียว ── */}
      <div className="px-3 2xl:px-4 py-2.5 border-b border-border bg-surface shrink-0">
        <div className="flex flex-wrap 2xl:flex-nowrap items-center gap-x-2 2xl:gap-x-3 gap-y-2">
          {/* Mobile back — เข้า flow header ไม่ทับ avatar */}
          {onBack && (
            <button
              onClick={onBack}
              title="กลับ"
              aria-label="กลับ"
              className="2xl:hidden -ml-1 w-11 h-11 rounded-lg border border-border bg-surface flex items-center justify-center shrink-0 text-text hover:bg-surface-2 transition-colors"
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <Avatar name={conversation.customer_name} src={conversation.customer_avatar} size={34} className="shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text truncate">{conversation.customer_name || conversation.id}</span>
              <PlatformIcon platform={conversation.platform} size={16} />
            </div>
            <div className="text-[11px] text-text-muted truncate">{conversation.shop_name}</div>
          </div>

          {/* Mobile info — เข้า flow header ไม่ทับปุ่ม action */}
          {onInfo && (
            <button
              onClick={onInfo}
              title="รายละเอียด"
              aria-label="รายละเอียด"
              className="2xl:hidden w-11 h-11 rounded-lg border border-border bg-surface flex items-center justify-center shrink-0 text-text-muted hover:bg-surface-2 transition-colors"
            >
              <Info size={17} />
            </button>
          )}

          {/* Controls — มือถือขึ้นแถวใหม่เต็มกว้าง (basis-full) / desktop ต่อท้ายแถวเดียว */}
          <div className="flex items-center gap-2 2xl:gap-3 basis-full 2xl:basis-auto shrink-0">
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
              <Button size="sm" variant="outline" onClick={onHandoff} className="shrink-0 ml-auto 2xl:ml-0">
                <Headset size={14} /> รับเรื่อง
              </Button>
            )}
            {conversation.status === "closed" ? (
              onReopen && (
                <Button size="sm" variant="outline" onClick={onReopen} className="shrink-0 ml-auto 2xl:ml-0">
                  <RotateCcw size={14} /> เปิดแชทใหม่
                </Button>
              )
            ) : (
              onResolve && (
                <Button size="sm" onClick={onResolve} className="shrink-0 ml-auto 2xl:ml-0">
                  <Lock size={14} /> ปิดสนทนา
                </Button>
              )
            )}
          </div>
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
                  <UnifiedBubble msg={msg} customerName={conversation?.customer_name} customerAvatar={conversation?.customer_avatar} canReview={canReview} onReviewAction={onReviewAction} />
                </React.Fragment>
              );
            })}

            {/* Safety notice */}
            <div className="flex items-start gap-2 rounded-lg bg-success/5 border border-success/15 p-3 mt-4">
              <AlertCircle size={14} className="text-success-dark flex-shrink-0 mt-0.5" />
              <div className="text-[11px] text-text-muted leading-relaxed">
                <span className="text-success-dark font-medium">ปลอดภัย:</span> คำตอบ bot (ฟ้า) เก็บใน shadow_replies
                ไม่ส่งถึงลูกค้า ไม่ยิง Shopee API — zaapi (เขียว) คือข้อความจริงที่ sellcenter dump มา
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Composer — admin ตอบใน sandbox (เขียน botworker_messages, ไม่ส่ง Shopee) ── */}
      {onSend && conversation.status !== "closed" && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.trim() || sending) return;
            setSending(true);
            try {
              await onSend(draft);
              setDraft("");
            } finally {
              setSending(false);
            }
          }}
          className="p-3 border-t border-border bg-surface shrink-0"
        >
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="ตอบแชทใน sandbox... (Enter ส่ง · Shift+Enter ขึ้นบรรทัด) — ไม่ส่งถึงลูกค้าจริง"
              rows={2}
              className="flex-1 resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <Button type="submit" size="sm" disabled={!draft.trim() || sending} className="shrink-0">
              {sending ? "กำลังส่ง..." : "ส่ง"}
            </Button>
          </div>
          {conversation.status === "bot" && (
            <div className="text-[10px] text-text-subtle mt-1.5">
              การตอบจะ assign แชทนี้ให้คุณใน sandbox — บอทจะหยุดตอบจนกว่าจะปิด/เปิดแชทใหม่
            </div>
          )}
        </form>
      )}
    </div>
  );
}

// ─── UnifiedBubble — message bubble 3 สี ───────────────────────

import { useRef } from "react";
import { User, Zap, Bot as BotIcon } from "lucide-react";

function UnifiedBubble({ msg, customerName, customerAvatar, canReview, onReviewAction }: { msg: UnifiedMessage; customerName?: string; customerAvatar?: string; canReview?: boolean; onReviewAction?: (msgId: string, bubbleId: string, action: string, extra?: Record<string, unknown>) => Promise<void> }) {
  const isUser = msg.role === "user";
  const isZaapi = msg.role === "zaapi";
  const isBot = msg.role === "bot";
  const isAdmin = msg.role === "admin";
  // ⚡ สี admin — ใช้ bubble_color ที่บันทึกตอนส่ง (botworker_messages) ก่อน แล้ว fallback สี profile ปัจจุบัน
  const myAdminId = useAuth((s) => s.user?.admin_id);
  const myBubbleColor = useAuth((s) => s.user?.bubble_color);
  const adminColor = msg.bubble_color || adminBubbleColor(msg.admin_id, myAdminId, myBubbleColor);

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
        {isBot && Array.isArray(msg.review_bubbles) ? (
          // ⚡ review mode — 1 persisted bubble = 1 UI bubble + controls ตาม decision
          <ReviewBubbleList msg={msg} canReview={!!canReview} onAction={onReviewAction} toChatMsg={toChatMsg} bubbleClass={bubbleClass} />
        ) : (
          segmentMsgs.map((segMsg, i) => (
            <div key={i} className={`rounded-2xl px-3.5 py-2 text-sm ${bubbleClass} ${isAdmin ? "admin-bubble-contrast" : ""}`} style={isZaapi ? { backgroundColor: ZAAPI_COLOR } : isBot ? { backgroundColor: BOT_COLOR } : isAdmin ? { backgroundColor: adminColor, color: adminBubbleTextColor(adminColor) } : undefined}>
              <MessageContent msg={toChatMsg(segMsg)} variant={isUser ? "user" : "out"} />
            </div>
          ))
        )}
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
        <div className={`mt-1 w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${avatarClass} ${isAdmin ? "admin-bubble-contrast" : ""}`} style={isZaapi ? { backgroundColor: ZAAPI_COLOR } : isBot ? { backgroundColor: BOT_COLOR } : isAdmin ? { backgroundColor: adminColor, color: adminBubbleTextColor(adminColor) } : undefined}>
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
  is_accepting_chats?: boolean; // ⚡ eligibility — พักรับแชทไม่ให้โยน
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
      // กรองเฉพาะ role=admin + active + เปิดรับแชทอยู่ (พักรับแชทไม่แสดง)
      const list = (data.users || []).filter(
        (u: AdminRow) => u.role === "admin" && u.active && u.is_accepting_chats !== false
      );
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
            {admins.length === 0 && !loading && (
              <div className="px-3 py-3 text-xs text-text-muted text-center">ไม่มีแอดมินที่เปิดรับแชท</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── ReviewBubbleList — per-bubble review controls (mock send) ───
// ⚡ pending: อนุมัติส่ง / แก้ไข / ไม่อนุมัติส่ง (+ card attach)
//    editing: บันทึก / บันทึกและส่ง / ยกเลิก (inline ใน bubble นั้น)
//    decided: read-only — แสดง original/saved edit/decision/actor/mock outcome
//    mock_sent ต้อง label "จำลองส่งเท่านั้น — ลูกค้ายังไม่ได้รับ" เสมอ
function ReviewBubbleList({
  msg, canReview, onAction, toChatMsg, bubbleClass,
}: {
  msg: UnifiedMessage;
  canReview: boolean;
  onAction?: (msgId: string, bubbleId: string, action: string, extra?: Record<string, unknown>) => Promise<void>;
  toChatMsg: (m: UnifiedMessage) => ChatMessage;
  bubbleClass: string;
}) {
  const bubbles = msg.review_bubbles || [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ bubbleId: string; message: string } | null>(null);

  const settled = (b: ReviewBubble) => b.decision === "rejected" || b.delivery.state === "mock_sent";
  const gateOk = (i: number) => bubbles.slice(0, i).every(settled);

  async function act(bubbleId: string, action: string, extra?: Record<string, unknown>): Promise<boolean> {
    if (!onAction) return false;
    setBusy(true); setErr(null);
    try { await onAction(msg.id, bubbleId, action, extra); return true; }
    catch (e) { setErr({ bubbleId, message: e instanceof Error ? e.message : "action failed" }); return false; }
    finally { setBusy(false); }
  }

  const products = (msg.bot_products || []).map((p, i) => ({
    key: String(p.item_id ?? p.itemid ?? `no-id-${i}`),
    item_id: String(p.item_id ?? p.itemid ?? ""),
    name: p.name || "(ไม่มีชื่อ)",
    verifiable: !!p.item_id && !!(p.shop || p.shop_id || p.shopid), // server verify จริง — UI แค่ hint
  })).filter((p) => p.item_id);

  return (
    <>
      {bubbles.map((b, i) => {
        const decided = b.decision !== "pending";
        const sendable = canReview && !decided && gateOk(i);
        const editing = editingId === b.bubble_id;
        return (
          <div key={b.bubble_id} className={`rounded-2xl px-3.5 py-2 text-sm ${bubbleClass}`} style={{ backgroundColor: BOT_COLOR }}>
            {/* original vs saved edit */}
            {b.edited_text && b.edited_text !== b.original_text && (
              <div className="text-[10px] opacity-70 border-b border-white/20 pb-1 mb-1">
                <span className="line-through">{b.original_text}</span>
              </div>
            )}
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                className="w-full resize-none rounded-md border border-white/30 bg-white/10 px-2 py-1 text-sm text-white placeholder:text-white/50 focus:outline-none"
              />
            ) : (
              <MessageContent msg={toChatMsg({ ...msg, text: b.edited_text ?? b.original_text })} variant="out" />
            )}

            {/* status line */}
            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-white/70">
              <span>
                {b.decision === "pending" && "รอตรวจ"}
                {b.decision === "approved" && "อนุมัติแล้ว"}
                {b.decision === "edited_approved" && "อนุมัติ (แก้ไขแล้ว)"}
                {b.decision === "rejected" && "ไม่อนุมัติ"}
              </span>
              {b.decided_by && <span>· {b.decided_by}</span>}
              {b.decided_at && <span>· {new Date(b.decided_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}</span>}
              {b.delivery.state === "mock_sent" && (
                <span className="ml-1 rounded bg-white/15 px-1.5 py-0.5 font-medium text-yellow-200">
                  จำลองส่งเท่านั้น — ลูกค้ายังไม่ได้รับ
                </span>
              )}
              {b.delivery.state === "mock_failed" && (
                <span className="ml-1 rounded bg-red-500/30 px-1.5 py-0.5">จำลองส่งล้มเหลว</span>
              )}
              {b.card && (
                <span className="ml-1 rounded bg-white/15 px-1.5 py-0.5">
                  card:{b.card.item_id} {b.card.delivery.state === "mock_sent" ? "(จำลอง)" : "(ล้มเหลว)"}
                </span>
              )}
            </div>

            {/* controls */}
            {canReview && !decided && !editing && (
              <div className="flex items-center gap-1.5 mt-2">
                <button
                  disabled={!sendable || busy}
                  onClick={() => act(b.bubble_id, "approve")}
                  className="rounded-md bg-white/20 hover:bg-white/30 disabled:opacity-40 px-2 py-1 text-[11px] font-medium"
                  title={!gateOk(i) ? "ต้องตัดสินบับเบิ้ลก่อนหน้าก่อน" : ""}
                >อนุมัติส่ง</button>
                <button
                  disabled={busy}
                  onClick={() => { setEditingId(b.bubble_id); setDraft(b.edited_text ?? b.original_text); }}
                  className="rounded-md bg-white/15 hover:bg-white/25 disabled:opacity-40 px-2 py-1 text-[11px]"
                >แก้ไข</button>
                <button
                  disabled={busy}
                  onClick={() => act(b.bubble_id, "reject")}
                  className="rounded-md bg-red-500/40 hover:bg-red-500/60 disabled:opacity-40 px-2 py-1 text-[11px]"
                >ไม่อนุมัติส่ง</button>
                {b.delivery.state === "mock_failed" && (
                  <button
                    disabled={!sendable || busy}
                    onClick={() => act(b.bubble_id, "approve")}
                    className="rounded-md bg-yellow-500/40 hover:bg-yellow-500/60 disabled:opacity-40 px-2 py-1 text-[11px]"
                  >ลองส่งใหม่</button>
                )}
                {products.length > 0 && (
                  <SelectField
                    disabled={!sendable || busy}
                    defaultValue=""
                    onChange={(e) => { if (e.target.value) act(b.bubble_id, "send_card", { card_item_id: e.target.value }); e.target.value = ""; }}
                    className="rounded-md bg-white/15 px-1.5 py-1 text-[11px] text-white disabled:opacity-40"
                  >
                    <option value="" disabled>+ การ์ดสินค้า</option>
                    {products.map((p) => (
                      <option key={p.key} value={p.item_id} disabled={!p.verifiable} className="text-black">
                        {p.name} ({p.item_id}){p.verifiable ? "" : " — ยืนยัน shop ไม่ได้"}
                      </option>
                    ))}
                  </SelectField>
                )}
              </div>
            )}
            {canReview && editing && (
              <div className="flex items-center gap-1.5 mt-2">
                <button
                  disabled={busy || !draft.trim()}
                  onClick={async () => { if (await act(b.bubble_id, "save", { edited_text: draft })) setEditingId(null); }}
                  className="rounded-md bg-white/20 hover:bg-white/30 disabled:opacity-40 px-2 py-1 text-[11px] font-medium"
                >บันทึก</button>
                <button
                  disabled={!sendable || busy || !draft.trim()}
                  onClick={async () => { if (await act(b.bubble_id, "save_and_approve", { edited_text: draft })) setEditingId(null); }}
                  className="rounded-md bg-green-500/40 hover:bg-green-500/60 disabled:opacity-40 px-2 py-1 text-[11px] font-medium"
                  title={!gateOk(i) ? "ต้องตัดสินบับเบิ้ลก่อนหน้าก่อน" : ""}
                >บันทึกและส่ง</button>
                <button
                  disabled={busy}
                  onClick={() => { setEditingId(null); setDraft(b.edited_text ?? b.original_text); }}
                  className="rounded-md bg-white/15 hover:bg-white/25 disabled:opacity-40 px-2 py-1 text-[11px]"
                >ยกเลิก</button>
              </div>
            )}
            {/* decided + mock_failed → ปุ่มลองส่งใหม่ (อยู่นอก pending block — bubble ตัดสินแล้ว) */}
            {canReview && decided && b.delivery.state === "mock_failed" && (
              <div className="flex items-center gap-1.5 mt-2">
                <button
                  disabled={!gateOk(i) || busy}
                  onClick={() => act(b.bubble_id, "approve")}
                  className="rounded-md bg-yellow-500/40 hover:bg-yellow-500/60 disabled:opacity-40 px-2 py-1 text-[11px]"
                  title={!gateOk(i) ? "ต้องตัดสินบับเบิ้ลก่อนหน้าก่อน" : ""}
                >ลองส่งใหม่</button>
              </div>
            )}
            {err && err.bubbleId === b.bubble_id && <div className="text-[10px] text-red-200 mt-1">{err.message}</div>}
          </div>
        );
      })}
    </>
  );
}
