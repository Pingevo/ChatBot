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
import { useSharedConversations } from "@/lib/useSharedConversations";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { AnnotationDot, type Annotation } from "@/components/ui/AnnotationDot";
import { ShadowInboxList, type ShadowReplyListItem } from "@/components/shadow/ShadowInboxList";
import { ShadowReplyPanel, type ShadowReplyDetail } from "@/components/shadow/ShadowReplyPanel";
import { ShadowStatPanel, type ShadowStats } from "@/components/shadow/ShadowStatPanel";
import { ShadowConversationPanel } from "@/components/shadow/ShadowConversationPanel";
import { ChatList } from "@/components/chat/ChatList";
import { chatService } from "@/lib/services";
import { formatDateLabel } from "@/components/shadow/DateBanner";
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
  // ⚡ เกิน 7 วัน → แสดงวันที่ ภายใน 7 วัน → แสดงจำนวนวัน
  if (d > 7) return formatDateLabel(iso);
  return `${d} วัน`;
}

export default function ShadowInboxPage() {
  const { user } = useAuth();
  const canView = user?.role === "dev" || user?.role === "admin" || user?.role === "superadmin";
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
  // origin filter — "all" = ทั้งหมด, "roll" = batch generate, "history" = ประวัติ, "trash" = ถังขยะ
  // ⚡ Phase 3B-3 — เปลี่ยน "manual" (Generate ทีละข้อความ) → "roll" (batch generate ทั้งแชท)
  const [originFilter, setOriginFilter] = useState<"all" | "roll" | "history" | "trash">("all");
  // ⚡ Phase 3B-3 — roll config
  const [rollCount, setRollCount] = useState("10");
  const [rollOrder, setRollOrder] = useState<"recent" | "oldest">("recent");
  const [rollMode, setRollMode] = useState<"overwrite" | "resume">("overwrite");
  const [rollPlatform, setRollPlatform] = useState<Platform | "all">("all");
  const [rollProgress, setRollProgress] = useState<{ done: number; total: number; success: number; skipped: number; errors: number } | null>(null);
  const [rolling, setRolling] = useState(false);
  // ⚡ Phase 3B-1 — annotations (markup) for shadow-bot
  const [shadowAnnotations, setShadowAnnotations] = useState<Annotation[]>([]);
  const [shadowAnnotationsMap, setShadowAnnotationsMap] = useState<Map<string, Annotation>>(new Map());
  // ⚡ trash tab — soft-deleted shadow replies
  const [trashRows, setTrashRows] = useState<ShadowReplyListItem[]>([]);
  // ⚡ history tab — ดึง shadow_replies ทั้งหมด จัดกลุ่มตาม conversation
  const [historyReplies, setHistoryReplies] = useState<ShadowReplyListItem[]>([]);
  // ⚡ history conversations — ดึงเฉพาะที่มี shadow_replies (endpoint เฉพาะ) แทนโหลดทั้งหมด
  const [historyConversations, setHistoryConversations] = useState<Conversation[]>([]);

  // ⚡ tab "ทั้งหมด" — ใช้ ChatList เหมือน ticket inbox
  // ⚡ G-share — ใช้ shared conversation store (แชร์กับ tickets)
  // ⚡ server-side search — ส่ง q ไป API ให้ค้นที่ DB ทั้งหมด
  const [searchQuery, setSearchQuery] = useState("");
  const { conversations: sharedConvs, totalCount: sharedTotalCount, loading: sharedLoading } = useSharedConversations({
    assigned_to: "all",
    q: searchQuery || undefined,
    limit: 2000,
  });
  const [chatConversations, setChatConversations] = useState<Conversation[]>([]);
  const [chatTotalCount, setChatTotalCount] = useState<number>(0);
  // sync shared → local (เฉพาะตอน originFilter === "all")
  useEffect(() => {
    if (originFilter === "all") {
      setChatConversations(sharedConvs);
      setChatTotalCount(sharedTotalCount);
    }
  }, [sharedConvs, sharedTotalCount, originFilter]);
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
        // ⚡ G-share — ใช้ shared store แล้ว ไม่ต้อง fetch ซ้ำ
        //   (sync ทำใน useEffect ด้านบน)
        return;
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
        const _hSeen = new Set<string>();
        const _hConv = Array.isArray(convR.data) ? convR.data : [];
        setHistoryConversations(_hConv.filter((c) => { if (_hSeen.has(c.id)) return false; _hSeen.add(c.id); return true; }));
        // filter เฉพาะ rows ที่ bot_reply_text ไม่ว่าง — กัน conversation ที่ bot ไม่ได้ตอบโผล่ใน panel
        const allRows = repliesR.data.rows || [];
        setHistoryReplies(allRows.filter((r) => r.bot_reply_text && r.bot_reply_text.trim().length > 0));
      } else if (originFilter === "trash") {
        // "ถังขยะ" = ดึงเฉพาะที่ถูก soft delete
        // ⚡ Phase 3A-fix — เพิ่ม cache-buster
        const _bust = Date.now();
        const r = await api().get<{ rows: ShadowReplyListItem[] }>("/shadow-inbox", {
          params: { limit: "500", deleted: "1", _t: String(_bust) },
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        setTrashRows(r.data.rows || []);
      } else if (originFilter === "roll") {
        // ⚡ Phase 3B-3 — "roll" tab = config panel (ไม่โหลด list)
        return;
      } else {
        // ⚡ Phase 3B-3 — fallback (ไม่ควรถึงตรงนี้)
        setRows([]);
      }
    } catch (err) {
      catchError(err, "โหลดข้อมูลไม่สำเร็จ");
      // ⚡ G-share — ไม่ clear chatConversations เมื่อ originFilter === "all" (ใช้ shared store แล้ว)
      if (originFilter !== "all") {
        setRows([]);
        setChatConversations([]);
        setHistoryReplies([]);
        setHistoryConversations([]);
        setTrashRows([]);
      }
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
    if (detail?.conversation_id && originFilter === "roll") {
      loadConvStats(detail.conversation_id);
    }
  }, [detail?.conversation_id, detail?.shadow_reply_id, originFilter, loadConvStats]);

  // ⚡ Phase 3B-1 — load annotations for shadow-bot (history tab only)
  //   ⚡ Phase 3B-6 — annotation ผูก batch_id แล้ว แต่ conversation list ยังโชว์ dot
  //   โหลดทั้งหมด (ไม่ filter batch) แล้วเก็บอันล่าสุดต่อ conversation (เรียงตาม updated_at desc)
  const loadShadowAnnotations = useCallback(async () => {
    try {
      const convIds = historyConversations.map((c) => c.id).slice(0, 200);
      if (convIds.length === 0) {
        setShadowAnnotations([]);
        setShadowAnnotationsMap(new Map());
        return;
      }
      const r = await api().get<{ annotations: Annotation[] }>("/chat-annotations", {
        params: { scope: "shadow_bot", conversation_ids: convIds.join(",") },
      });
      const anns = r.data.annotations || [];
      setShadowAnnotations(anns);
      // ⚡ Phase 3B-6 — แชทหนึ่งอาจมีหลาย annotation (ต่างรอบ) → เก็บอันล่าสุดต่อ conversation
      //   API เรียง created_at desc อยู่แล้ว → ใช้ annotation แรกที่เจอต่อ conversation_id
      const map = new Map<string, Annotation>();
      for (const a of anns) {
        if (!map.has(a.conversation_id)) map.set(a.conversation_id, a);
      }
      setShadowAnnotationsMap(map);
    } catch {
      setShadowAnnotations([]);
      setShadowAnnotationsMap(new Map());
    }
  }, [historyConversations]);

  useEffect(() => {
    if (originFilter === "history" && canView) loadShadowAnnotations();
  }, [originFilter, canView, loadShadowAnnotations]);

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
      // ⚡ dedupe by id กัน duplicate key warning
      const seen = new Set<string>();
      const deduped = data.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      // เรียงใหม่ล่าสุดก่อน — เทสแชทเองจะได้เห็นบนสุด
      const sorted = [...deduped].sort((a, b) => {
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

  // ⚡ Phase 3B-5 — ลบรายแชทจาก history (soft delete ทุก shadow replies ใน conversation)
  async function handleDeleteHistoryConversation(conversationId: string) {
    const ok = await confirm.ask({
      title: "ลบแชทนี้จาก History?",
      message: "จะ soft delete shadow replies ทั้งหมดในแชทนี้ (กู้คืนได้จากถังขยะ)",
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api().delete(`/shadow-inbox/conversations?conversation_id=${encodeURIComponent(conversationId)}`);
      toast.success("ลบแล้ว");
      // รีเฟรช history list
      await load();
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
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

  // ── ⚡ Phase 3B-3 — Roll (batch generate ทั้งแชท) ──
  async function handleRoll() {
    const count = Math.max(1, Math.min(parseInt(rollCount, 10) || 10, 1000));
    setRollProgress({ done: 0, total: count, success: 0, skipped: 0, errors: 0 });
    setRolling(true);
    let success = 0;
    let skipped = 0;
    let errors = 0;
    try {
      // 1. ขอรายการ conversation_ids จาก batch_roll API
      const rollResp = await api().post("/shadow-inbox", {
        action: "batch_roll",
        count,
        order: rollOrder,
        mode: rollMode,
        platform: rollPlatform === "all" ? undefined : rollPlatform,
      }, { timeout: 30000 });
      const convIds: string[] = rollResp.data?.conversation_ids || [];
      skipped = rollResp.data?.skipped || 0;

      if (convIds.length === 0) {
        toast.info("ไม่มีแชทที่ต้อง generate (อาจถูก skip หมด)");
        setRollProgress(null);
        return;
      }

      setRollProgress({ done: 0, total: convIds.length, success: 0, skipped, errors: 0 });

      // 2. ไล่ generate ทั้งแชททีละอัน
      for (let i = 0; i < convIds.length; i++) {
        try {
          await api().post("/shadow-inbox/generate-conversation",
            { conversation_id: convIds[i] },
            { timeout: 300000 }
          );
          success++;
        } catch {
          errors++;
        }
        setRollProgress({ done: i + 1, total: convIds.length, success, skipped, errors });
        if (errors >= 3 && errors === i + 1) {
          toast.error("หยุด — error 3 ครั้งแรก");
          break;
        }
      }
      toast.success(`Roll เสร็จ: ${success} สำเร็จ, ${skipped} ข้าม, ${errors} error`);
      await load();
      await loadStats();
    } catch (err) {
      catchError(err, "Roll ไม่สำเร็จ");
    } finally {
      setRolling(false);
      setRollProgress(null);
    }
  }

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
            { key: "roll", label: "Roll" },
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
            onSearchChange={originFilter === "all" ? setSearchQuery : undefined}
            loading={sharedLoading}
            // ⚡ Phase 3B-6 — คืน annotation dot ใน conversation list (โชว์อันล่าสุดต่อแชท)
            //   mark รอบละเฉพาะทำใน ShadowConversationPanel (ต่อ batch selector) แทน
            annotationsMap={originFilter === "history" ? shadowAnnotationsMap : undefined}
            annotationsScope="shadow_bot"
            onAnnotationsChange={originFilter === "history" ? loadShadowAnnotations : undefined}
            onDeleteConversation={originFilter === "history" ? handleDeleteHistoryConversation : undefined}
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
        ) : originFilter === "roll" ? (
          /* ⚡ Phase 3B-3 — tab "Roll" — config panel สำหรับ batch generate ทั้งแชท */
          <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 space-y-4">
            <div className="flex items-center gap-2">
              <Zap size={16} className="text-brand" />
              <h2 className="text-sm font-bold text-text">Roll — Batch Generate</h2>
            </div>
            <p className="text-[11px] text-text-muted leading-relaxed">
              Generate shadow reply ทั้งแชทแบบ batch — เลือกจำนวนแชทที่ต้องการ,
              เลือกเรียงเก่า/ใหม่ก่อน, เลือกทับของเดิมหรือข้ามที่มีคนทำแล้ว
            </p>

            {/* Count */}
            <div className="space-y-1">
              <label className="text-[10px] text-text-muted font-medium">จำนวนแชท</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={rollCount}
                onChange={(e) => setRollCount(e.target.value)}
                className="w-full px-2 py-1.5 rounded-md bg-surface-2 border border-border text-text text-xs focus:outline-none focus:border-brand"
                placeholder="10"
              />
            </div>

            {/* Order */}
            <div className="space-y-1">
              <label className="text-[10px] text-text-muted font-medium">เรียงตาม</label>
              <div className="flex items-center gap-1">
                <button onClick={() => setRollOrder("recent")}
                  className={`flex-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    rollOrder === "recent" ? "bg-brand text-white" : "bg-surface-2 text-text-muted hover:text-text"
                  }`}>
                  ใหม่สุดก่อน
                </button>
                <button onClick={() => setRollOrder("oldest")}
                  className={`flex-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    rollOrder === "oldest" ? "bg-brand text-white" : "bg-surface-2 text-text-muted hover:text-text"
                  }`}>
                  เก่าสุดก่อน
                </button>
              </div>
            </div>

            {/* Mode */}
            <div className="space-y-1">
              <label className="text-[10px] text-text-muted font-medium">โหมด</label>
              <div className="flex items-center gap-1">
                <button onClick={() => setRollMode("overwrite")}
                  className={`flex-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    rollMode === "overwrite" ? "bg-brand text-white" : "bg-surface-2 text-text-muted hover:text-text"
                  }`}>
                  ทำใหม่ทับ
                </button>
                <button onClick={() => setRollMode("resume")}
                  className={`flex-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    rollMode === "resume" ? "bg-brand text-white" : "bg-surface-2 text-text-muted hover:text-text"
                  }`}>
                  ข้ามที่มีคนทำแล้ว
                </button>
              </div>
            </div>

            {/* Platform */}
            <div className="space-y-1">
              <label className="text-[10px] text-text-muted font-medium">แพลตฟอร์ม</label>
              <div className="flex items-center gap-1">
                {(["all", "shopee", "tiktok", "lazada"] as const).map((p) => (
                  <button key={p} onClick={() => setRollPlatform(p)}
                    className={`flex-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                      rollPlatform === p ? "bg-brand text-white" : "bg-surface-2 text-text-muted hover:text-text"
                    }`}>
                    {p === "all" ? "ทั้งหมด" : p}
                  </button>
                ))}
              </div>
            </div>

            {/* Roll button */}
            <button onClick={handleRoll} disabled={rolling}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand-dark disabled:opacity-50 transition-colors">
              {rolling ? <Loading size={12} /> : <Zap size={12} />}
              {rollProgress
                ? `Roll... ${rollProgress.done}/${rollProgress.total} (✓${rollProgress.success} ⏭${rollProgress.skipped} ✗${rollProgress.errors})`
                : `Roll Generate (${rollCount} แชท)`}
            </button>

            {/* Progress bar */}
            {rollProgress && (
              <div className="w-full h-1.5 bg-surface-2 rounded-full overflow-hidden">
                <div className="h-full bg-brand transition-all" style={{ width: `${(rollProgress.done / rollProgress.total) * 100}%` }} />
              </div>
            )}

            {/* Info */}
            <div className="text-[10px] text-text-subtle space-y-1 pt-2 border-t border-border">
              <p>• "ทำใหม่ทับ" = generate ใหม่ทั้งหมด ไม่สนว่าเคยมีคนทำไหม</p>
              <p>• "ข้ามที่มีคนทำแล้ว" = ข้ามแชทที่มี shadow reply (origin=manual_conversation) แล้ว ไปทำอันถัดไปจนครบจำนวน</p>
              <p>• ประวัติการ roll จะเก็บรวมใน tab History</p>
            </div>
          </div>
        ) : (
          /* fallback — ไม่ควรถึง */
          <div className="flex-1 flex items-center justify-center text-xs text-text-muted">—</div>
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
        ) : originFilter === "roll" ? (
          /* ⚡ Phase 3B-3 — tab "Roll" — แสดง placeholder (config อยู่ใน panel ซ้าย) */
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <Zap size={40} className="text-text-subtle mb-3" />
            <p className="text-sm text-text-muted">กำหนดค่า Roll ที่ panel ซ้ายแล้วกด "Roll Generate"</p>
            <p className="text-xs text-text-subtle mt-1">ผลลัพธ์จะปรากฏใน tab History</p>
          </div>
        ) : (
          /* fallback — แสดง ShadowReplyPanel (สำหรับ detail ที่เลือก) */
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
