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
import { ArrowLeft, Info, PanelRightClose, PanelRightOpen, Zap, RefreshCw, Trash2 } from "lucide-react";
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
  const [convStats, setConvStats] = useState<ShadowStats | null>(null);
  const [loadingConvStats, setLoadingConvStats] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [ratingId, setRatingId] = useState<string | null>(null);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("list");
  // origin filter — "all" = ทั้งหมด, "manual" = Generate เอง, "history" = ประวัติ bot ตอบ, "trash" = ถังขยะ
  const [originFilter, setOriginFilter] = useState<"all" | "manual" | "history" | "trash">("all");
  // ⚡ trash tab — soft-deleted shadow replies
  const [trashRows, setTrashRows] = useState<ShadowReplyListItem[]>([]);
  // ⚡ history tab — ดึง shadow_replies ทั้งหมด จัดกลุ่มตาม conversation
  const [historyReplies, setHistoryReplies] = useState<ShadowReplyListItem[]>([]);
  // ⚡ history conversations — ดึงเฉพาะที่มี shadow_replies (endpoint เฉพาะ) แทนโหลดทั้งหมด
  const [historyConversations, setHistoryConversations] = useState<Conversation[]>([]);

  // ⚡ tab "ทั้งหมด" — ใช้ ChatList เหมือน ticket inbox
  const [chatConversations, setChatConversations] = useState<Conversation[]>([]);
  const [chatTotalCount, setChatTotalCount] = useState<number>(0);
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
        // ⚡ ใช้ limit 2000 (default ของ backend) แทน 10000 — กัน timeout 30s
        // ถ้าต้องการดูเก่ากว่านั้นให้ scroll ใน ChatList (filter/sort ทำใน frontend)
        // ⚡ include_count=true เพื่อขอ total_count จริงจาก DB
        const r = await api().get<{ rows: Conversation[]; total_count: number } | Conversation[]>("/admin/conversations", {
          params: { assigned_to: "all", limit: 2000, include_count: "true" },
          // ⚡ ตั้ง timeout 45s กัน axios ตัดก่อน backend ทำเสร็จ
          timeout: 45000,
        });
        const data = Array.isArray(r.data) ? r.data : ((r.data as { rows?: Conversation[] }).rows || []);
        setChatConversations(data);
        setChatTotalCount(Array.isArray(r.data) ? data.length : (r.data as { total_count?: number }).total_count || data.length);
      } else if (originFilter === "history") {
        // "History" = ดึง conversations ที่ถูก generate ทั้งแชท (origin=manual_conversation)
        // + ดึง shadow_replies origin=manual_conversation เพื่อ map เข้า panel
        // แยก fetch แบบ parallel เพื่อความเร็ว
        // ⚡ cache-buster timestamp กัน browser/Next.js cache ข้อมูลเก่า
        const _bust = Date.now();
        const [convR, repliesR] = await Promise.all([
          api().get<Conversation[]>("/shadow-inbox/conversations", {
            timeout: 30000,
            headers: { "Cache-Control": "no-cache, no-store, must-revalidate", "X-Bust": String(_bust) },
            params: { _t: _bust },
          }),
          api().get<{ rows: ShadowReplyListItem[] }>("/shadow-inbox", {
            params: { limit: "500", origin: "manual_conversation", _t: _bust },
            timeout: 30000,
            headers: { "Cache-Control": "no-cache, no-store, must-revalidate", "X-Bust": String(_bust) },
          }),
        ]);
        setHistoryConversations(Array.isArray(convR.data) ? convR.data : []);
        // filter เฉพาะ rows ที่ bot_reply_text ไม่ว่าง — กัน conversation ที่ bot ไม่ได้ตอบโผล่ใน panel
        const allRows = repliesR.data.rows || [];
        setHistoryReplies(allRows.filter((r) => r.bot_reply_text && r.bot_reply_text.trim().length > 0));
      } else if (originFilter === "trash") {
        // "ถังขยะ" = ดึงเฉพาะที่ถูก soft delete
        const r = await api().get<{ rows: ShadowReplyListItem[] }>("/shadow-inbox", {
          params: { limit: "500", deleted: "1" },
        });
        setTrashRows(r.data.rows || []);
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
      setHistoryConversations([]);
      setTrashRows([]);
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

  // load per-conversation stats — สถิติเฉพาะ conversation ที่เลือก
  const loadConvStats = useCallback(async (conversationId: string | null) => {
    if (!conversationId) {
      setConvStats(null);
      return;
    }
    setLoadingConvStats(true);
    try {
      const r = await api().get<{ stats: ShadowStats }>(`/shadow-inbox?stats=1&conversation_id=${encodeURIComponent(conversationId)}`);
      setConvStats(r.data.stats);
    } catch {
      setConvStats(null);
    } finally {
      setLoadingConvStats(false);
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
    if (selectedId) {
      loadDetail(selectedId);
      // หา conversation_id จาก context — ใช้สำหรับ per-conv stats
      // tab "Generate เอง": ใช้ detail.conversation_id (หลัง load)
      // tab "ทั้งหมด"/"History": ใช้ selectedId เป็น conversation_id โดยตรง
      if (originFilter === "all" || originFilter === "history") {
        loadConvStats(selectedId);
      } else {
        // ใน tab manual — ต้องรอ detail load เสร็จก่อน (ดู useEffect ด้านล่าง)
        loadConvStats(null);
      }
    } else {
      setDetail(null);
      setChatMessages([]);
      setConvStats(null);
    }
  }, [selectedId, loadDetail, loadConvStats, originFilter]);

  // เมื่อ detail โหลดเสร็จ (tab manual) → โหลด per-conv stats
  useEffect(() => {
    if (detail?.conversation_id && originFilter === "manual") {
      loadConvStats(detail.conversation_id);
    }
  }, [detail?.conversation_id, detail?.shadow_reply_id, originFilter, loadConvStats]);

  // Polling — ลด rate เพื่อลด timeout/กระพริบ
  // ⚡ tab History โหลดหนัก → poll ช้ากว่า tab อื่น (20s vs 10s)
  usePolling(load, originFilter === "history" ? 20000 : 10000, { enabled: canView });
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

  async function handleRate(id: string, rating: "good" | "bad" | "unrated") {
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
      if (detail?.conversation_id) await loadConvStats(detail.conversation_id);
    } catch (err) {
      catchError(err, "ให้คะแนนไม่สำเร็จ");
    } finally {
      setRatingId(null);
    }
  }

  async function handleStar(id: string, star: number) {
    setRatingId(id);
    try {
      // ถ้ายังไม่มี rating → default เป็น "unrated" (เพื่อให้ PATCH ผ่าน)
      const currentRating = detail?.rating || "unrated";
      await api().patch(`/shadow-inbox/${id}`, { rating: currentRating, star_rating: star });
      toast.success(star > 0 ? `ให้ดาว ${star} ดาว` : "ล้างดาวแล้ว");
      if (detail && detail.shadow_reply_id === id) {
        setDetail({ ...detail, star_rating: star });
      }
      await loadStats();
      if (detail?.conversation_id) await loadConvStats(detail.conversation_id);
    } catch (err) {
      catchError(err, "ให้ดาวไม่สำเร็จ");
    } finally {
      setRatingId(null);
    }
  }

  async function handleComment(id: string, comment: string) {
    setRatingId(id);
    try {
      const currentRating = detail?.rating || "unrated";
      await api().patch(`/shadow-inbox/${id}`, { rating: currentRating, comment });
      toast.success(comment ? "บันทึกคอมเมนต์แล้ว" : "ล้างคอมเมนต์แล้ว");
      if (detail && detail.shadow_reply_id === id) {
        setDetail({ ...detail, comment });
      }
      await loadStats();
      if (detail?.conversation_id) await loadConvStats(detail.conversation_id);
    } catch (err) {
      catchError(err, "บันทึกคอมเมนต์ไม่สำเร็จ");
    } finally {
      setRatingId(null);
    }
  }

  async function handleClearAll() {
    const ok = await confirm.ask({
      title: "ล้างข้อมูล Shadow Replies ทั้งหมด?",
      message: "จะ soft delete shadow replies ที่บอทเคยตอบทั้งหมด (เก็บประวัติ สามารถ restore ได้) — ไม่ได้ลบถาวร",
      confirmText: "ล้างทั้งหมด",
      variant: "danger",
    });
    if (!ok) return;
    setClearingAll(true);
    try {
      const r = await api().delete<{ soft_deleted_count: number }>("/shadow-inbox?clear_all=1");
      toast.success(`ล้างข้อมูลแล้ว (${r.data.soft_deleted_count} รายการ — soft delete)`);
      setSelectedId(null);
      setDetail(null);
      setRows([]);
      setHistoryReplies([]);
      setConvStats(null);
      await load();
      await loadStats();
    } catch (err) {
      catchError(err, "ล้างข้อมูลไม่สำเร็จ");
    } finally {
      setClearingAll(false);
    }
  }

  async function handleDelete(id: string) {
    const ok = await confirm.ask({
      title: "ลบ shadow reply?",
      message: "รายการนี้จะถูก soft delete (เก็บประวัติ สามารถ restore ได้) — ไม่ได้ลบถาวร",
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api().delete(`/shadow-inbox/${id}`);
      toast.success("ลบ shadow reply แล้ว (soft delete)");
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

  // ⚡ restore ทีละรายการ
  async function handleRestore(id: string) {
    try {
      await api().post(`/shadow-inbox/${id}?action=restore`);
      toast.success("กู้คืนแล้ว");
      setTrashRows((prev) => prev.filter((r) => r.shadow_reply_id !== id));
      await loadStats();
    } catch (err) {
      catchError(err, "กู้คืนไม่สำเร็จ");
    }
  }

  // ⚡ restore ทั้งหมด
  async function handleRestoreAll() {
    const ok = await confirm.ask({
      title: "กู้คืนทั้งหมด?",
      message: `จะกู้คืน shadow replies ที่ถูก soft delete ทั้งหมด (${trashRows.length} รายการ)`,
      confirmText: "กู้คืนทั้งหมด",
      variant: "primary",
    });
    if (!ok) return;
    try {
      const r = await api().put<{ restored_count: number }>("/shadow-inbox?action=restore_all");
      toast.success(`กู้คืนแล้ว ${r.data.restored_count} รายการ`);
      setTrashRows([]);
      await loadStats();
    } catch (err) {
      catchError(err, "กู้คืนทั้งหมดไม่สำเร็จ");
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
    <div className="h-full flex overflow-hidden">
      {/* ── Panel ซ้าย: Shadow Inbox List ── */}
      <div className={`${mobileView === "list" ? "flex" : "hidden"} md:flex h-full flex-col w-full md:w-72 min-w-0 shrink-0 border-r border-border overflow-hidden relative`}>
        {/* Origin filter tabs — ทั้งหมด / Message / History / ถังขยะ */}
        <div className="grid grid-cols-4 gap-0 border-b border-border bg-surface-2 shrink-0">
          {([
            { key: "all", label: "ทั้งหมด" },
            { key: "manual", label: "Message" },
            { key: "history", label: "History" },
            { key: "trash", label: "ถังขยะ" },
          ] as const).map((t) => {
            const active = originFilter === t.key;
            return (
              <button
                key={t.key}
                onClick={() => {
                  setOriginFilter(t.key);
                  setSelectedId(null);
                  setDetail(null);
                  setChatMessages([]);
                  setLoading(true);
                }}
                className={`flex items-center justify-center px-1 py-2 text-[10px] font-medium transition-colors border-b-2 whitespace-nowrap ${
                  active
                    ? "border-brand text-brand bg-surface"
                    : "border-transparent text-text-muted hover:text-text hover:bg-surface"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {originFilter === "all" || originFilter === "history" ? (
          /* ⚡ tab "ทั้งหมด" และ "History" — ใช้ ChatList เหมือน ticket inbox */
          <ChatList
            conversations={
              originFilter === "history"
                ? historyConversations
                : chatConversations
            }
            selectedId={selectedId}
            onSelect={handleSelect}
            admins={[]}
            onChatFilterChange={() => {}}
            totalCount={originFilter === "all" ? chatTotalCount : undefined}
          />
        ) : originFilter === "trash" ? (
          /* ⚡ tab "ถังขยะ" — แสดงรายการที่ถูก soft delete + ปุ่ม restore */
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-border bg-surface-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-text-muted">
                {trashRows.length} รายการ (soft delete)
              </span>
              {trashRows.length > 0 && (
                <button
                  onClick={handleRestoreAll}
                  className="text-[10px] px-2 py-1 rounded-md bg-green-600 text-white hover:bg-green-700 font-medium"
                >
                  ↩ กู้คืนทั้งหมด
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="text-center text-xs text-text-muted py-8">กำลังโหลด...</div>
              ) : trashRows.length === 0 ? (
                <div className="text-center text-xs text-text-muted py-8">ไม่มีรายการในถังขยะ</div>
              ) : (
                <ul className="divide-y divide-border">
                  {trashRows.map((r) => (
                    <li key={r.shadow_reply_id} className="px-3 py-2 hover:bg-surface-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] text-text-subtle truncate">
                            {r.platform} · {r.shop_id}
                          </div>
                          <div className="text-xs text-text truncate mt-0.5">
                            {r.inbound_text?.slice(0, 60) || "(ไม่มีข้อความ)"}
                          </div>
                          <div className="text-[9px] text-text-subtle mt-0.5">
                            ลบเมื่อ {r.deleted_at ? new Date(r.deleted_at).toLocaleString("th-TH") : "-"}
                          </div>
                        </div>
                        <button
                          onClick={() => handleRestore(r.shadow_reply_id)}
                          className="text-[10px] px-2 py-1 rounded-md border border-green-300 text-green-700 hover:bg-green-50 shrink-0"
                        >
                          ↩ กู้คืน
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
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
      <div className={`${mobileView === "chat" ? "flex" : "hidden"} md:flex flex-1 h-full min-w-0 relative overflow-hidden`}>
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
                ? historyConversations.find((c) => c.id === selectedId)
                : chatConversations.find((c) => c.id === selectedId)) ?? null
            }
            messages={chatMessages}
            loadingMessages={loadingChatMessages}
            historyReplies={originFilter === "history" ? historyReplies.filter((r) => r.conversation_id === selectedId) : undefined}
          />
        ) : originFilter === "trash" ? (
          /* ⚡ tab "ถังขยะ" — แสดงข้อความว่าง ไม่มี panel */
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <Trash2 size={40} className="text-text-subtle mb-3" />
            <p className="text-sm text-text-muted">เลือกรายการจากถังขยะด้านซ้ายเพื่อดูรายละเอียด</p>
            <p className="text-xs text-text-subtle mt-1">หรือกด "กู้คืนทั้งหมด" เพื่อ restore รายการทั้งหมด</p>
          </div>
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
              onStar={handleStar}
              onComment={handleComment}
              onDelete={handleDelete}
              ratingId={ratingId}
            />
          )
        )}
      </div>

      {/* ── Panel ขวา: Stats ── */}
      <div className={`${mobileView === "stat" ? "flex" : "hidden"} ${rightCollapsed ? "md:hidden" : "md:flex"} h-full shrink-0 overflow-hidden`}>
        <div className="relative h-full flex flex-col w-full md:w-[300px] min-w-0 border-l border-border bg-surface overflow-hidden">
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

          {/* Clear all button */}
          <button
            onClick={handleClearAll}
            disabled={clearingAll}
            className="hidden md:flex absolute top-3 right-12 z-10 h-7 px-2 rounded-md text-text-muted hover:text-red-600 hover:bg-red-50 items-center justify-center gap-1 transition-colors text-[10px] disabled:opacity-50"
            title="ล้างข้อมูล shadow replies ทั้งหมด"
          >
            {clearingAll ? <Loading size={10} /> : <Trash2 size={11} />}
            ล้าง
          </button>

          {/* Stats panel with tab: Per Chat | All History */}
          <div className="flex-1 min-h-0">
            <ShadowStatPanel
              stats={stats}
              convStats={convStats}
              title="สถิติ"
            />
          </div>
        </div>
      </div>

      {/* Expand button ขวา (desktop, when collapsed) */}
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
