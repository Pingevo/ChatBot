"use client";
// Live Assignment — จ่ายงานจริงให้แอดมิน + จำลอง flow เต็มรูปแบบ
// UI/UX เหมือน /tickets ทุกอย่าง — ใช้ components เดียวกัน (ChatList, TicketChatPanel, InfoTab, ChatLogTab, ProductsTab, CloseChatModal)
// ข้อมูลจาก test_assignment collection (เหมือน test-assignment แต่เพิ่ม admin_reply + close + reopen)
// เพิ่ม: ปุ่ม "จ่ายงาน N chat" ด้านบน ChatList
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ArrowLeft, Info, PanelRightClose, PanelRightOpen, Zap } from "lucide-react";
import { ChatList } from "@/components/chat/ChatList";
import { TicketChatPanel } from "@/components/chat/TicketChatPanel";
import { InfoTab } from "@/components/chat/InfoTab";
import { ChatLogTab } from "@/components/chat/ChatLogTab";
import { ProductsTab } from "@/components/chat/ProductsTab";
import { CloseChatModal } from "@/components/chat/CloseChatModal";
import { Button } from "@/components/ui/Button";
import { toast, useToastError } from "@/components/ui/Toast";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/lib/authStore";
import { usePolling } from "@/lib/usePolling";
import type { Conversation, ChatMessage, CloseHistoryRecord, ProblemCategory, AdminUser, Platform } from "@/lib/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveQaItem {
  index: number;
  message_id: string;
  user_text: string;
  user_message_type?: string;
  user_media?: { type: string; url?: string; thumb_url?: string };
  user_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  user_order_sn?: string;
  user_notification_text?: string;
  user_table?: { headers?: string[]; rows?: string[][] };
  user_bundle?: { message_type: string; text: string; media?: { type: string; url?: string; thumb_url?: string }; product_ref?: { item_id: string }; products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[] }[];
  trigger_name?: string;
  trigger_action?: string;
  bot_reply?: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed?: number;
  bot_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  bot_intent?: unknown;
  bot_retrieval_info?: unknown;
  bot_web_search_used?: boolean;
  bot_web_search_reason?: string;
  admin_reply?: string;
  admin_reply_at?: string;
  admin_reply_by?: string;
  status: "bot_answered" | "trigger_matched" | "handed_off" | "no_agent" | "error" | "admin_replied" | "closed";
  assigned_to?: string | null;
  detail: string;
  reopened?: boolean;
  reopen_reason?: string;
}

interface LiveAssignmentDoc {
  _id?: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  shop_name?: string;
  to_name?: string;
  qa: LiveQaItem[];
  total_messages: number;
  processed_messages: number;
  final_status: string;
  assigned_to?: string | null;
  stopped_at_handoff: boolean;
  mock_status: "open" | "closed";
  closed_at?: string;
  closed_by?: string;
  close_count?: number;
  close_reason?: string;
  close_category?: string;
  close_resolution?: string;
  close_note?: string;
  batch_id?: string;
  replayed_by?: string;
  replayed_at?: string;
  created_at: string;
  updated_at: string;
}

interface BatchProgress {
  done: number;
  total: number;
  handedOff: number;
  botAnswered: number;
  errors: number;
  skipped: number;
}

type MobileView = "list" | "chat" | "info";
type ChatFilter = "me" | "all" | string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// แปลง LiveAssignmentDoc → Conversation (เพื่อส่งเข้า ChatList/TicketChatPanel)
function liveDocToConversation(doc: LiveAssignmentDoc): Conversation {
  // current state มาจาก state fields เท่านั้น — final_status คือ replay verdict (แสดงแยกเป็น replay_verdict)
  const status =
    doc.mock_status === "closed" ? "closed"
    : doc.assigned_to || doc.stopped_at_handoff ? "handoff"
    : "bot";

  // หา last message จาก qa
  const lastQa = doc.qa && doc.qa.length > 0 ? doc.qa[doc.qa.length - 1] : null;
  const lastMessage = lastQa
    ? (lastQa.admin_reply || lastQa.bot_reply || lastQa.user_text || "")
    : "";

  return {
    id: doc.conversation_id,
    platform: doc.platform,
    shop_id: doc.shop_id,
    shop_name: doc.shop_name || doc.shop_id,
    customer_id: "",
    customer_name: doc.to_name || doc.conversation_id.slice(0, 12),
    status: status as never,
    topic: "general",
    last_message: lastMessage,
    last_timestamp: doc.updated_at || doc.created_at,
    unread: 0,
    assigned_to: doc.assigned_to || undefined,
    assigned_to_name: undefined,
    replay_verdict: doc.final_status || undefined,
  };
}

// แปลง qa → ChatMessage[] (เหมือน tickets ใช้กับ TicketChatPanel)
function qaToMessages(doc: LiveAssignmentDoc): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  if (!doc.qa) return msgs;
  for (const qa of doc.qa) {
    // user message
    msgs.push({
      id: `u_${qa.message_id}`,
      role: "user",
      text: qa.user_text,
      timestamp: new Date().toISOString(),
      message_type: qa.user_message_type as never,
      media: qa.user_media as never,
      products: qa.user_products as never,
      order_sn: qa.user_order_sn,
      notification_text: qa.user_notification_text,
      table: qa.user_table as never,
      bundle: qa.user_bundle as never,
    });
    // bot reply — ⚡ โชว์แค่ข้อความที่บอทตอบ ไม่ render item cards (bot_products = context ให้ llm2)
    if (qa.bot_reply) {
      msgs.push({
        id: `b_${qa.message_id}`,
        role: "bot",
        text: qa.bot_reply,
        timestamp: new Date().toISOString(),
        source: qa.bot_source,
      });
    }
    // admin reply
    if (qa.admin_reply) {
      msgs.push({
        id: `a_${qa.message_id}`,
        role: "admin",
        text: qa.admin_reply,
        timestamp: qa.admin_reply_at || new Date().toISOString(),
        admin_id: qa.admin_reply_by,
      });
    }
  }
  return msgs;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LiveAssignmentPage() {
  const { user } = useAuth();
  const me = user?.admin_id ?? "";
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [docs, setDocs] = useState<LiveAssignmentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  // ⚡ pagination — head (200 newest, poll 5s) + tail (load more on scroll)
  const [tailDocs, setTailDocs] = useState<LiveAssignmentDoc[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("list");
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeHistory, setCloseHistory] = useState<CloseHistoryRecord[]>([]);
  const [rightTab, setRightTab] = useState<"info" | "chatlog" | "products">("info");
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [acceptingChats, setAcceptingChats] = useState<boolean>(user?.is_accepting_chats ?? true);
  const [togglingAccept, setTogglingAccept] = useState(false);
  const [conflictPopup, setConflictPopup] = useState<{ assignedTo: string; text: string } | null>(null);
  const { catchError } = useToastError();

  // Batch controls
  const [batchCount, setBatchCount] = useState(500);
  const [batchMode, setBatchMode] = useState<"overwrite" | "resume">("overwrite");
  const [batchPlatform, setBatchPlatform] = useState<"all" | Platform>("all");
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);

  // แปลง docs + tailDocs → Conversation[] สำหรับ ChatList
  // ⚡ dedupe by conversation_id — test_assignment เก็บ 1 doc ต่อ (conversation_id, replayed_by)
  //   ถ้าหลายแอดมิน replay แชทเดียวกันจะมี conversation_id ซ้ำ → ใช้ doc ล่าสุด (updated_at มากสุด)
  const conversations = useMemo(() => {
    const seen = new Map<string, LiveAssignmentDoc>();
    for (const d of [...docs, ...tailDocs]) {
      const existing = seen.get(d.conversation_id);
      if (!existing || new Date(d.updated_at) > new Date(existing.updated_at)) {
        seen.set(d.conversation_id, d);
      }
    }
    return Array.from(seen.values()).map(liveDocToConversation);
  }, [docs, tailDocs]);
  const selected = conversations.find((c) => c.id === selectedId) ?? null;
  const selectedDoc = docs.find((d) => d.conversation_id === selectedId) ?? null;

  // ── Load admins list ──
  useEffect(() => {
    if (user?.role === "admin") return;
    api().get<{ users: AdminUser[]; canEdit: boolean }>("/users/list").then((r) => {
      setAdmins(r.data.users || []);
    }).catch((e) => {
      catchError(e, "โหลดรายชื่อแอดมินไม่สำเร็จ");
      setAdmins([]);
    });
  }, [user?.role]);

  // ── Load list (head — 200 ล่าสุด) ──
  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { list: "1", limit: "200", include_count: "true", assigned_to: chatFilter };
      if (batchPlatform !== "all") params.platform = batchPlatform;
      const r = await api().get<{ conversations: LiveAssignmentDoc[]; total: number; has_more?: boolean; cursor?: string | null }>("/live-assignment", { params });
      setDocs(r.data.conversations || []);
      setHasMore(r.data.has_more ?? false);
      setCursor(r.data.cursor ?? null);
      setTailDocs([]); // ⚡ reset tail เมื่อ head โหลดใหม่
    } catch (err) {
      console.error("load list failed", err);
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [batchPlatform, chatFilter]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // ⚡ loadMore — โหลด page ถัดไป (tail) ตอน scroll ใกล้ล่าง
  const loadMore = useCallback(async () => {
    if (!cursor || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const params: Record<string, string> = { list: "1", limit: "200", cursor, assigned_to: chatFilter };
      if (batchPlatform !== "all") params.platform = batchPlatform;
      const r = await api().get<{ conversations: LiveAssignmentDoc[]; has_more?: boolean; cursor?: string | null }>("/live-assignment", { params });
      const newDocs = r.data.conversations || [];
      const existingIds = new Set([...docs.map((d) => d.conversation_id), ...tailDocs.map((d) => d.conversation_id)]);
      const deduped = newDocs.filter((d) => {
        if (existingIds.has(d.conversation_id)) return false;
        existingIds.add(d.conversation_id);
        return true;
      });
      setTailDocs((prev) => [...prev, ...deduped]);
      setHasMore(r.data.has_more ?? false);
      setCursor(r.data.cursor ?? null);
    } catch (err) {
      console.error("load more failed", err);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, hasMore, loadingMore, docs, tailDocs, batchPlatform, chatFilter]);

  // ── Poll list (head only — ไม่กระทบ tail) ──
  usePolling(
    useCallback(async () => {
      try {
        const params: Record<string, string> = { list: "1", limit: "200", include_count: "true", assigned_to: chatFilter };
        if (batchPlatform !== "all") params.platform = batchPlatform;
        const r = await api().get<{ conversations: LiveAssignmentDoc[]; total: number; has_more?: boolean; cursor?: string | null }>("/live-assignment", { params });
        setDocs(r.data.conversations || []);
        setHasMore(r.data.has_more ?? false);
        setCursor(r.data.cursor ?? null);
      } catch {
        // ignore
      }
    }, [batchPlatform, chatFilter]),
    5000,
    { enabled: !batchRunning }
  );

  // ── Load detail (messages) ──
  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    setLoadingMessages(true);
    api()
      .get<{ replay: LiveAssignmentDoc; messages: ChatMessage[] }>(
        `/live-assignment?conv_detail=1&conversation_id=${encodeURIComponent(selectedId)}`
      )
      .then((r) => {
        const doc = r.data.replay;
        if (doc) {
          setMessages(qaToMessages(doc));
        } else {
          setMessages([]);
        }
      })
      .catch((err) => {
        console.error("load detail failed", err);
        setMessages([]);
      })
      .finally(() => setLoadingMessages(false));
  }, [selectedId]);

  // ── Handlers (เหมือน tickets) ──
  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileView("chat");
  }, []);

  const handleBack = useCallback(() => {
    setMobileView("list");
    setSelectedId(null);
  }, []);

  // Send admin reply
  const sendInternal = useCallback(
    async (text: string, force: boolean) => {
      if (!selectedId) return false;
      try {
        await api().post("/live-assignment", {
          action: "admin_reply",
          conversation_id: selectedId,
          text,
        });
        // reload detail
        const r = await api().get<{ replay: LiveAssignmentDoc; messages: ChatMessage[] }>(
          `/live-assignment?conv_detail=1&conversation_id=${encodeURIComponent(selectedId)}`
        );
        if (r.data.replay) {
          setMessages(qaToMessages(r.data.replay));
        }
        await loadList();
        return true;
      } catch (err) {
        console.error("send failed", err);
        return false;
      }
    },
    [selectedId, loadList]
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!selectedId) return;
      setSending(true);
      try {
        await sendInternal(text, false);
        toast.success("ส่งคำตอบแล้ว");
      } catch {
        // ignore
      } finally {
        setSending(false);
      }
    },
    [selectedId, sendInternal]
  );

  const handleHandoff = useCallback(() => {
    if (!selectedId) return;
    // handoff ผ่าน live-assignment ไม่มี action นี้แยก — ใช้การ replay ใหม่
    toast.info("Handoff ผ่านการ replay อัตโนมัติ");
  }, [selectedId]);

  const handleResolve = useCallback(() => {
    if (!selectedId) return;
    setShowCloseModal(true);
  }, [selectedId]);

  const handleClose = useCallback(
    async (data: { reason: string; category: ProblemCategory; resolution: string; note?: string }) => {
      if (!selectedId) return;
      setClosing(true);
      try {
        const r = await api().post<{
          ok: boolean;
          closed: boolean;
          reopened: boolean;
          new_qa?: LiveQaItem[];
          final_status?: string;
        }>("/live-assignment", {
          action: "close_chat",
          conversation_id: selectedId,
          ...data,
        });
        setShowCloseModal(false);
        if (r.data.reopened) {
          toast.success(`ปิดแชทแล้ว — ระบบ reopen อัตโนมัติ (${r.data.new_qa?.length || 0} คำถามใหม่)`);
        } else {
          toast.success("ปิดแชทแล้ว");
        }
        await loadList();
        // reload detail
        if (selectedId) {
          const dr = await api().get<{ replay: LiveAssignmentDoc; messages: ChatMessage[] }>(
            `/live-assignment?conv_detail=1&conversation_id=${encodeURIComponent(selectedId)}`
          );
          if (dr.data.replay) {
            setMessages(qaToMessages(dr.data.replay));
          }
        }
      } catch (err) {
        console.error("close failed", err);
        toast.error("ปิดแชทไม่สำเร็จ");
      } finally {
        setClosing(false);
      }
    },
    [selectedId, loadList]
  );

  const handleReopen = useCallback(async () => {
    if (!selectedId) return;
    // ⚡ เรียก closeChat API — มันจะ close → เช็คข้อความเหลือ → reopen → ประมวลผลผ่านบอท
    //   ใช้ตอนแชทถูก auto-close (bot ตอบโดยไม่ handoff) แล้วมีข้อความใหม่เข้ามา
    setClosing(true);
    try {
      const r = await api().post<{
        ok: boolean;
        closed: boolean;
        reopened: boolean;
        new_qa?: LiveQaItem[];
        final_status?: string;
      }>("/live-assignment", {
        action: "close_chat",
        conversation_id: selectedId,
        reason: "reopen เพื่อประมวลผลข้อความใหม่",
      });
      if (r.data.reopened) {
        toast.success(`เปิดแชทใหม่ — ระบบประมวลผล ${r.data.new_qa?.length || 0} ข้อความใหม่`);
      } else {
        toast.info("ไม่มีข้อความใหม่ให้ประมวลผล");
      }
      await loadList();
      // reload detail
      if (selectedId) {
        const dr = await api().get<{ replay: LiveAssignmentDoc; messages: ChatMessage[] }>(
          `/live-assignment?conv_detail=1&conversation_id=${encodeURIComponent(selectedId)}`
        );
        if (dr.data.replay) {
          setMessages(qaToMessages(dr.data.replay));
        }
      }
    } catch (err) {
      console.error("reopen failed", err);
      toast.error("เปิดแชทใหม่ไม่สำเร็จ");
    } finally {
      setClosing(false);
    }
  }, [selectedId, loadList]);

  const handleTransfer = useCallback(async (newAdminId: string) => {
    if (!selectedId) return;
    try {
      await api().post("/assignment/reassign", {
        conversation_id: selectedId,
        new_admin_id: newAdminId,
        reason: "โยนแชทจากหน้า Live Assignment",
      });
      toast.success("โยนแชทแล้ว");
      await loadList();
    } catch {
      // ignore
    }
  }, [selectedId, loadList]);

  const handleToggleAccepting = useCallback(async () => {
    setTogglingAccept(true);
    try {
      const r = await api().patch<{ ok: boolean; is_accepting_chats: boolean }>("/profile/accepting-chats", {
        is_accepting_chats: !acceptingChats,
      });
      setAcceptingChats(r.data.is_accepting_chats);
    } catch (err) {
      console.error("toggle accepting failed", err);
    } finally {
      setTogglingAccept(false);
    }
  }, [acceptingChats]);

  const handleTicketChange = useCallback(
    (patch: Partial<Conversation>) => {
      // live-assignment ไม่ได้เก็บ ticket metadata แยก — ไม่ต้องทำอะไร
    },
    []
  );

  const handleSuggestProduct = useCallback(() => {
    if (!selectedId) return;
    const suggestion: ChatMessage = {
      id: `sugg_${Date.now()}`,
      role: "admin",
      text: "แนะนำสินค้าแนะนำเพิ่มเติมค่ะ",
      timestamp: new Date().toISOString(),
      products: [{ item_id: "item_rec", name: "สินค้าแนะนำ", price: 999 }],
    };
    setMessages((prev) => [...prev, suggestion]);
  }, [selectedId]);

  const handleSendCode = useCallback(() => {
    if (!selectedId) return;
    const code: ChatMessage = {
      id: `code_${Date.now()}`,
      role: "admin",
      text: "รหัสยืนยันของคุณคือ 123456 (หมดอายุใน 10 นาที)",
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, code]);
  }, [selectedId]);

  // ── Batch replay ──
  const handleBatchReplay = useCallback(async () => {
    if (batchRunning) return;
    setBatchRunning(true);
    setBatchProgress({ done: 0, total: 0, handedOff: 0, botAnswered: 0, errors: 0, skipped: 0 });
    try {
      const rollResp = await api().post<{
        conversation_ids: string[];
        total: number;
        skipped: number;
      }>("/live-assignment", {
        action: "batch_replay",
        count: batchCount,
        order: "recent",
        mode: batchMode,
        platform: batchPlatform === "all" ? undefined : batchPlatform,
      }, { timeout: 30000 });

      const convIds = rollResp.data.conversation_ids;
      if (convIds.length === 0) {
        toast.error("ไม่มี conversation สำหรับ replay");
        return;
      }

      setBatchProgress({ done: 0, total: convIds.length, handedOff: 0, botAnswered: 0, errors: 0, skipped: 0 });

      let handedOff = 0;
      let botAnswered = 0;
      let errors = 0;
      let skipped = 0;

      for (let i = 0; i < convIds.length; i++) {
        try {
          const resp = await api().post<{ ok: boolean; final_status?: string }>(
            "/live-assignment",
            {
              action: "replay_conversation",
              conversation_id: convIds[i],
              mode: batchMode,
            },
            { timeout: 300000 }
          );
          if (resp.data?.ok) {
            if (resp.data.final_status === "handed_off" || resp.data.final_status === "no_agent") {
              handedOff++;
            } else if (resp.data.final_status === "bot_answered" || resp.data.final_status === "trigger_matched") {
              botAnswered++;
            } else if (resp.data.final_status === "skipped") {
              skipped++;
            }
          }
        } catch {
          errors++;
        }
        setBatchProgress({ done: i + 1, total: convIds.length, handedOff, botAnswered, errors, skipped });
        if (errors >= 3 && errors === i + 1) {
          toast.error("หยุด — error 3 ครั้งแรก");
          break;
        }
      }

      toast.success(`เสร็จ: ${convIds.length} conversation, ${handedOff} handoff, ${botAnswered} bot, ${skipped} ข้าม, ${errors} error`);
      await loadList();
    } catch (err) {
      console.error("batch replay failed", err);
      toast.error("Batch replay ไม่สำเร็จ");
    } finally {
      setBatchRunning(false);
      setBatchProgress(null);
    }
  }, [batchCount, batchMode, batchPlatform, batchRunning, loadList]);

  return (
    <div className="h-full flex flex-col">
      {/* ── Batch controls bar (ด้านบนสุด — เหนือ panel 3 คอลัมน์) ── */}
      <div className="shrink-0 px-4 py-3 border-b border-border bg-surface">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Label + icon */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-brand/10 flex items-center justify-center">
              <Zap size={14} className="text-brand" />
            </div>
            <span className="text-sm font-semibold text-text">จ่ายงานสด</span>
          </div>
          {/* Divider */}
          <div className="hidden sm:block w-px h-6 bg-border" />
          {/* Controls group */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              <span>จำนวน</span>
              <input
                type="number"
                value={batchCount}
                onChange={(e) => setBatchCount(Math.min(Math.max(parseInt(e.target.value) || 1, 1), 1000))}
                disabled={batchRunning}
                className="w-20 h-8 text-xs rounded-lg border border-border bg-surface-2 px-2 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand/40 text-text"
                placeholder="500"
              />
            </label>
            <select
              value={batchPlatform}
              onChange={(e) => setBatchPlatform(e.target.value as "all" | Platform)}
              disabled={batchRunning}
              className="h-8 text-xs rounded-lg border border-border bg-surface-2 px-2 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand/40 text-text"
            >
              <option value="all">ทุก platform</option>
              <option value="shopee">Shopee</option>
              <option value="tiktok">TikTok</option>
              <option value="lazada">Lazada</option>
            </select>
            <select
              value={batchMode}
              onChange={(e) => setBatchMode(e.target.value as "overwrite" | "resume")}
              disabled={batchRunning}
              className="h-8 text-xs rounded-lg border border-border bg-surface-2 px-2 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand/40 text-text"
            >
              <option value="overwrite">ทำใหม่</option>
              <option value="resume">resume</option>
            </select>
            <Button size="sm" onClick={handleBatchReplay} disabled={batchRunning}>
              <Zap size={14} />
              {batchRunning ? `กำลังรัน...` : `จ่ายงาน ${batchCount} chat`}
            </Button>
          </div>
        </div>
        {/* Progress bar — แยกบรรทัด ไม่รวมกับ controls */}
        {batchProgress && (
          <div className="mt-2 flex items-center gap-3 text-[11px] text-text-muted flex-wrap">
            <span className="font-medium">{Math.round((batchProgress.done / Math.max(batchProgress.total, 1)) * 100)}%</span>
            <span className="text-text-muted">({batchProgress.done}/{batchProgress.total})</span>
            <div className="flex-1 min-w-[100px] h-1.5 rounded-full bg-surface-3 overflow-hidden">
              <div
                className="h-full rounded-full bg-brand transition-all duration-300"
                style={{ width: `${(batchProgress.done / Math.max(batchProgress.total, 1)) * 100}%` }}
              />
            </div>
            <span className="text-success">Bot: {batchProgress.botAnswered}</span>
            <span className="text-vibrant-coral">Handoff: {batchProgress.handedOff}</span>
            <span className="text-text-muted">Skip: {batchProgress.skipped}</span>
            <span className="text-error">Err: {batchProgress.errors}</span>
          </div>
        )}
      </div>

      {/* ── 3-column layout (เหมือน tickets) ── */}
      <div className="flex-1 flex min-h-0">
        {/* ── Panel ซ้าย: ChatList ── */}
        <div className={`${mobileView === "list" ? "flex" : "hidden"} lg:flex h-full flex-col w-full lg:w-80 shrink-0 border-r border-border`}>
          <ChatList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={handleSelect}
            admins={admins}
            chatFilter={chatFilter}
            onChatFilterChange={setChatFilter}
            acceptingChats={acceptingChats}
            onToggleAccepting={handleToggleAccepting}
            togglingAccept={togglingAccept}
            totalCount={conversations.length}
            onSearchChange={setSearchQuery}
            loading={loading}
            loadMore={loadMore}
            hasMore={hasMore}
            loadingMore={loadingMore}
          />
        </div>

        {/* ── Panel กลาง: TicketChatPanel ── */}
        <div className={`${mobileView === "chat" ? "flex" : "hidden"} lg:flex flex-1 h-full min-w-0 relative`}>
          <button
            onClick={handleBack}
            className="lg:hidden absolute top-3 left-3 z-10 w-9 h-9 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
            title="กลับ"
            aria-label="กลับ"
          >
            <ArrowLeft size={16} className="text-text" />
          </button>
          {selected && (
            <button
              onClick={() => setMobileView("info")}
              className="lg:hidden absolute top-3 right-3 z-10 w-9 h-9 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
              title="รายละเอียด"
              aria-label="รายละเอียด"
            >
              <Info size={16} className="text-text" />
            </button>
          )}
          <TicketChatPanel
            conversation={selected}
            messages={messages}
            onSend={handleSend}
            onHandoff={handleHandoff}
            onResolve={handleResolve}
            onReopen={handleReopen}
            onTransfer={handleTransfer}
            onSuggestProduct={handleSuggestProduct}
            onTicketChange={handleTicketChange}
            sending={sending}
            reopening={closing}
          />
        </div>

        {/* ── Panel ขวา: Info / ChatLog / Products ── */}
        {selected && (
          <>
            <div
              className={`${mobileView === "info" ? "flex" : "hidden"} ${rightCollapsed ? "lg:hidden" : "lg:flex"} h-full w-full lg:w-auto transition-[width] duration-200 ease-in-out`}
            >
              <div className="relative h-full flex flex-col w-full lg:w-[340px] border-l border-border bg-surface">
                <button
                  onClick={() => setMobileView("chat")}
                  className="lg:hidden absolute top-3 left-3 z-10 w-9 h-9 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
                  title="กลับ"
                  aria-label="กลับ"
                >
                  <ArrowLeft size={16} className="text-text" />
                </button>

                {/* Tab switcher — 3 tabs (เหมือน tickets) */}
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
                    aria-label="ซ่อน panel"
                  >
                    <PanelRightClose size={16} />
                  </button>
                </div>

                <div className="flex-1 overflow-hidden">
                  {rightTab === "info" && (
                    <InfoTab
                      conversation={selected}
                      messages={messages}
                      closeHistory={closeHistory}
                      onSuggestProduct={handleSuggestProduct}
                      onCreateTicket={() => { }}
                      onSendCode={handleSendCode}
                    />
                  )}
                  {rightTab === "chatlog" && (
                    <ChatLogTab messages={messages} />
                  )}
                  {rightTab === "products" && (
                    <ProductsTab
                      conversation={selected}
                      onSendProduct={(product) => {
                        const itemId = String(product.itemid || product.item_id || product.id || "");
                        const name = String(product.name || product.item_name || product.title || product.product_name || "สินค้า");
                        const price = Number(product.price || product.new_check_price || product.gen_price || 0);
                        let image: string | undefined;
                        if (Array.isArray(product.images) && product.images.length > 0) {
                          const f = String(product.images[0]);
                          image = f.startsWith("http") ? f : undefined;
                        } else if (product.images && typeof product.images === "object" && !Array.isArray(product.images)) {
                          const list = (product.images as any).image_url_list || (product.images as any).image_id_list;
                          if (Array.isArray(list) && list.length > 0) {
                            const first = String(list[0]);
                            image = first.startsWith("http") ? first : "https://cf.shopee.co.th/file/" + first;
                          }
                        } else if (Array.isArray(product.main_images) && product.main_images.length > 0) {
                          const mi = product.main_images[0];
                          if (mi?.thumb_urls?.length) image = mi.thumb_urls[0];
                          else if (mi?.url) image = mi.url;
                        } else if (typeof product.image_url === "string") {
                          image = product.image_url;
                        } else if (typeof product.image === "string") {
                          image = product.image;
                        }
                        let url: string | undefined;
                        for (const c of [product.short_link, product.url, product.product_link]) {
                          if (typeof c === "string" && c.startsWith("http")) { url = c; break; }
                        }
                        const shop = product.shopname || selected.shop_name;
                        const msg: ChatMessage = {
                          id: `prod_${Date.now()}`,
                          role: "admin",
                          text: `แนะนำสินค้า: ${name}`,
                          timestamp: new Date().toISOString(),
                          products: [{ item_id: itemId, name, price, image, shop, url }],
                        };
                        setMessages((prev) => [...prev, msg]);
                      }}
                    />
                  )}
                </div>
              </div>
            </div>

            {rightCollapsed && (
              <button
                onClick={() => setRightCollapsed(false)}
                className="hidden lg:flex absolute top-1/2 right-0 -translate-y-1/2 z-20 w-7 h-16 bg-surface border border-border rounded-l-lg items-center justify-center hover:bg-surface-2 transition-colors shadow-sm"
                title="แสดง panel"
                aria-label="แสดง panel"
              >
                <PanelRightOpen size={16} className="text-text-muted" />
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Close Chat Modal ── */}
      {showCloseModal && selected && (
        <CloseChatModal
          conversation={selected}
          onClose={() => setShowCloseModal(false)}
          onSubmit={handleClose}
          loading={closing}
        />
      )}

      {/* ── Conflict popup (เหมือน tickets) ── */}
      {conflictPopup && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="live-assign-modal-title" className="bg-surface rounded-xl border border-border p-5 max-w-md w-full shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-warning/15 flex items-center justify-center flex-shrink-0">
                <Info size={16} className="text-warning" />
              </div>
              <h3 id="live-assign-modal-title" className="text-sm font-semibold text-text">แชทนี้ assign ให้แอดมินคนอื่น</h3>
            </div>
            <p className="text-xs text-text-muted mb-4">
              แชทนี้ถูก assign ให้ {conflictPopup.assignedTo} ต้องการตอบทับหรือไม่?
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConflictPopup(null)}>ยกเลิก</Button>
              <Button size="sm" onClick={() => setConflictPopup(null)}>ตอบทับ</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
