"use client";
// Replay Compare — เปรียบเทียบ Bot เรา vs Zaapi/Admin จาก replay_compare.py
// Layout 3 คอลัมน์: list | chat comparison | analysis summary
import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { MessageContent } from "@/components/chat/MessageContent";
import { DateBanner, dayKey, formatDateLabel } from "@/components/shadow/DateBanner";
import { imageViewer } from "@/components/ui/ImageViewer";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { toast, useToastError } from "@/components/ui/Toast";
import {
  RefreshCw, PlayCircle, Bot, User, Store, Search,
  CheckCircle, XCircle, AlertCircle, BarChart3,
  ChevronRight, ChevronLeft, Copy, Check, FileText,
  Scale, ThumbsUp, ThumbsDown, Meh, AlertTriangle,
  Inbox, ListFilter, History, HelpCircle,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import type { Conversation, Platform, ChatMessage } from "@/lib/types";
import { useSharedConversations } from "@/lib/useSharedConversations";

// ─── Types ────────────────────────────────────────────────

// ⚡ Fallback helpers — ดึง message_type/item_id/order_sn จาก text ถ้าไม่มี field ตรง
// (สำหรับไฟล์ replay เก่าที่ยังไม่มี user_message_type)
function inferMessageType(text: string): string | undefined {
  if (!text) return undefined;
  if (/\[variation_card\]|\[ตัวเลือกสินค้า\]/i.test(text)) return "variation_card";
  if (/\[item\]|\[itemid\]|\[สินค้า\]/i.test(text)) return "item";
  if (/\[order\]|\[คำสั่งซื้อ\]/i.test(text)) return "order";
  if (/\[รูปภาพ\]|\[image\]/i.test(text)) return "image";
  if (/\[วิดิโอ\]|\[วิดีโอ\]|\[video\]/i.test(text)) return "video";
  if (/\[sticker\]|\[สติกเกอร์\]/i.test(text)) return "sticker";
  if (/\[notification\]|\[แจ้งเตือน\]/i.test(text)) return "notification";
  if (/\[faq_liveagent\]|\[โอนเจ้าหน้าที่\]/i.test(text)) return "faq_liveagent";
  if (/\[bundle/i.test(text)) return "bundle_message";
  return undefined;
}
function inferItemId(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/\[item[^\]]*\]|\[สินค้า[^\]]*\]|\[variation_card[^\]]*\]/i);
  if (!m) return undefined;
  const idM = text.match(/(\d{6,})/);
  return idM?.[1];
}
function inferOrderSn(text: string): string | undefined {
  if (!text) return undefined;
  if (!/\[order\]|\[คำสั่งซื้อ\]/i.test(text)) return undefined;
  const m = text.match(/(\d{8,})/);
  return m?.[1];
}

interface QaItem {
  i: number;
  user_text: string;
  item_id?: string;
  trigger?: string;
  trigger_action?: string;
  zaapi_text: string;
  zaapi_role?: string;
  zaapi_source?: string;
  bot_answer: string;
  bot_source?: string;
  bot_ws?: boolean;
  bot_handoff?: boolean;
  bot_error?: string;
  status: string;
  // user message rich media
  user_message_type?: string;
  user_media?: { type: string; url?: string; thumb_url?: string };
  user_parsed?: {
    message_type: string;
    text: string;
    item_id?: string;
    order_sn?: string;
    notification_text?: string;
  };
  // ⚡ product cards สำหรับแสดงในหน้าเว็บ (lookup จาก dbWallet ใน replay_compare.py)
  user_products?: { item_id: string; name: string; price?: number; image?: string; url?: string; shop?: string }[];
  // debug info
  bot_log?: string;
  bot_intent?: unknown;
  bot_retrieval_info?: unknown;
  bot_routing?: unknown;
  bot_product_names?: string[];
  bot_products_count?: number;
  bot_timing?: unknown;
}

interface ReplayConv {
  conv_id: string;
  shop_name?: string;
  shop_id?: string;
  qa: QaItem[];
  n_user: number;
  n_out: number;
  skipped_system?: number;
  handoff_stopped?: boolean;
  skipped?: string;
}

interface LlmJudgment {
  conv_id: string;
  q_i: number;
  verdict: "bot_better" | "zaapi_better" | "both_good" | "both_bad" | "judge_error";
  reason: string;
  bot_problems?: string[];
  bot_fixes?: string[];
  side_effects?: string;
  bot_strengths?: string[];
}

interface Analysis {
  total_conversations: number;
  total_qa: number;
  bot_answered: number;
  bot_errors: number;
  bot_handoffs: number;
  web_search_used: number;
  triggers_matched: number;
  skipped_system: number;
  handoff_stopped: number;
  both_answered: number;
  bot_only: number;
  zaapi_only: number;
  bot_short: number;
  bot_long: number;
  zaapi_short: number;
  zaapi_long: number;
  bot_has_link: number;
  bot_no_link: number;
  bot_external_link: number;
  zaapi_has_link: number;
  avg_bot_len: number;
  avg_zaapi_len: number;
  sources: Record<string, number>;
  issues: string[];
  good: string[];
  llm_judgments: LlmJudgment[];
}

interface ReplayData {
  generated_at: string;
  bot_url: string;
  limit: number;
  oldest: boolean;
  shop_filter?: string;
  status?: "running" | "done" | "error";
  progress?: { current: number; total: number };
  analysis: Analysis;
  conversations: ReplayConv[];
}

interface FileInfo {
  path: string;
  size: number;
  mtime: string;
}

// ⚡ Mobile/Tablet (<lg) — single-panel navigation: list | chat | stat
type MobileView = "list" | "chat" | "stat";

// ─── Helpers ──────────────────────────────────────────────

const verdictIcon = {
  bot_better: <ThumbsUp className="w-4 h-4 text-success-soft" />,
  zaapi_better: <ThumbsDown className="w-4 h-4 text-error-soft" />,
  both_good: <CheckCircle className="w-4 h-4 text-warning" />,
  both_bad: <XCircle className="w-4 h-4 text-text-muted" />,
  judge_error: <AlertCircle className="w-4 h-4 text-warning" />,
};

const verdictLabel = {
  bot_better: "Bot ดีกว่า",
  zaapi_better: "Zaapi ดีกว่า",
  both_good: "ทั้งคู่ดี",
  both_bad: "ทั้งคู่แย่",
  judge_error: "ตัดสินไม่ได้",
};

const verdictColor = {
  bot_better: "bg-success/10 text-success-dark border-success/20",
  zaapi_better: "bg-error/10 text-error border-error/20",
  both_good: "bg-warning/10 text-warning border-warning/20",
  both_bad: "bg-surface-2 text-text-muted border-border",
  judge_error: "bg-warning-soft text-warning border-warning",
};

function timeAgo(iso?: string): string {
  if (!iso) return "—";
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

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Page ─────────────────────────────────────────────────

export default function ReplayComparePage() {
  const { catchError } = useToastError();
  const [data, setData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [selectedConvIdx, setSelectedConvIdx] = useState(0);
  const [selectedQIdx, setSelectedQIdx] = useState(0);
  const [showDebug, setShowDebug] = useState(false);
  const [copied, setCopied] = useState(false);
  const [limitInput, setLimitInput] = useState("50");

  // ⚡ mobile/tablet (<lg) — แสดงทีละ panel: list → chat → stat (เดสก์ท็อป lg+ แสดง 3 คอลัมน์)
  const [mobileView, setMobileView] = useState<MobileView>("list");

  // ⚡ 3 tabs: inbox (เลือกแชทใหม่) | history (แชทที่เคย replay แล้ว) | files (ไฟล์ batch)
  const [mode, setModeState] = useState<"inbox" | "history" | "files">("inbox");
  // ⚡ wrapper: เคลียร์ center panel ทุกครั้งที่สลับ tab
  const setMode = useCallback((m: "inbox" | "history" | "files") => {
    setModeState(m);
    setData(null);
    setPreviewConv(null);
    setPreviewMessages([]);
    setSelectedInboxId(null);
    setSelectedConvIdx(0);
    setSelectedQIdx(0);
    setMobileView("list"); // ⚡ mobile — สลับ tab แล้วกลับไปที่ list
  }, []);
  // ⚡ G-share — ใช้ shared conversation store (เหมือน ticket inbox / shadow inbox)
  //   pagination: 50 newest + load more on scroll → ไม่ค้างเหมือน limit:10000 เดิม
  const [inboxSearch, setInboxSearch] = useState("");
  const [inboxPlatform, setInboxPlatform] = useState<"all" | Platform>("all");
  const [inboxShop, setInboxShop] = useState<string>("");
  const {
    conversations: sharedInboxConvs,
    totalCount: inboxTotalCount,
    loading: inboxLoading,
    loadMore: inboxLoadMore,
    hasMore: inboxHasMore,
    loadingMore: inboxLoadingMore,
  } = useSharedConversations({
    assigned_to: "all",
    q: inboxSearch || undefined,
    pageSize: 50,
  });
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);
  const [replayConvRunning, setReplayConvRunning] = useState(false);
  // ⚡ preview messages ก่อนเรียก replay
  const [previewConv, setPreviewConv] = useState<Conversation | null>(null);
  const [previewMessages, setPreviewMessages] = useState<ChatMessage[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  // shops ที่มีใน inbox (extract จาก conversations ที่โหลดมา)
  const [inboxShops, setInboxShops] = useState<string[]>([]);

  // ⚡ History — แชทที่เคย replay ผ่าน inbox แล้ว (ดึงจากไฟล์ replay_conv_*.json)
  // เก็บเป็น list ของ { conv_id, shop_name, file_path, generated_at, qa_count, status }
  interface HistoryItem {
    conv_id: string;
    shop_name?: string;
    file_path: string;
    generated_at?: string;
    qa_count: number;
    status?: string;
    customer_name?: string;
  }
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historySearch, setHistorySearch] = useState("");

  const loadData = useCallback(async (file?: string) => {
    setLoading(true);
    try {
      const params = file ? { file } : {};
      const resp = await api().get("/replay-compare", { params, validateStatus: () => true, timeout: 60000 });
      if (resp.status === 404 || resp.data?.error === "file_not_found") {
        setData(null);
        // ไม่ toast error — แค่แสดง empty state
        if (file) toast.info("ยังไม่มีไฟล์ผล — รอ script รันเสร็จ หรือกด Run");
      } else {
        setData(resp.data);
        setSelectedConvIdx(0);
        setSelectedQIdx(0);
      }
    } catch (e: any) {
      catchError(e, "โหลดข้อมูล replay ไม่ได้");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  const loadFiles = useCallback(async () => {
    try {
      const resp = await api().get("/replay-compare", { params: { files: "1" }, timeout: 60000 });
      setFiles(resp.data?.files || []);
    } catch {
      // silent
    }
  }, []);

  // ⚡ โหลด data เฉพาะตอนอยู่ tab files หรือ history — ไม่โหลดตอน inbox
  useEffect(() => {
    if (mode === "files") {
      loadData();
      loadFiles();
    }
  }, [loadData, loadFiles, mode]);

  // ⚡ shops สำหรับ filter — extract จาก shared conversations (เหมือน ticket inbox)
  useEffect(() => {
    const shops = Array.from(new Set(sharedInboxConvs.map(c => c.shop_name).filter(Boolean))) as string[];
    setInboxShops(shops.sort());
  }, [sharedInboxConvs]);

  // ⚡ เคลียร์ center panel ตอนเข้าหน้า (mount) — กันของเก่าค้าง
  useEffect(() => {
    setData(null);
    setPreviewConv(null);
    setPreviewMessages([]);
    setSelectedInboxId(null);
    setSelectedConvIdx(0);
    setSelectedQIdx(0);
  }, []);

  // ⚡ โหลด history — แชทที่เคย replay ผ่าน inbox แล้ว
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await api().get<{ history: HistoryItem[] }>("/replay-compare", {
        params: { history: "1" },
        timeout: 60000,
      });
      setHistoryItems(r.data?.history || []);
    } catch (err) {
      catchError(err, "โหลด history ไม่สำเร็จ");
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
      setHistoryLoaded(true);
    }
  }, [catchError]);

  // ⚡ โหลด history ตอนเข้า tab history — ใช้ historyLoaded กันวนลูป
  useEffect(() => {
    if (mode === "history" && !historyLoaded && !historyLoading) {
      loadHistory();
    }
  }, [mode, historyLoaded, historyLoading, loadHistory]);

  // ⚡ โหลด preview messages ของ conversation (ก่อนตัดสินใจ replay)
  const loadPreview = useCallback(async (conv: Conversation) => {
    setPreviewConv(conv);
    setSelectedInboxId(conv.id);
    setPreviewMessages([]);
    setPreviewLoading(true);
    // ⚡ เคลียร์ผล replay เก่า เพื่อให้ preview แสดง
    setData(null);
    setSelectedConvIdx(0);
    setSelectedQIdx(0);
    try {
      const resp = await api().get(`/admin/conversations/${conv.id}/messages`, {
        params: { all: "1" },
        validateStatus: () => true,
        timeout: 60000,
      });
      console.log("[PREVIEW] conv.id=", conv.id, "status=", resp.status, "data type=", Array.isArray(resp.data) ? "array" : "object");
      // ⚡ API ส่งกลับ array ตรงๆ ถ้า all=1, หรือ { messages: [...] } ถ้าไม่ใช่
      const msgs = Array.isArray(resp.data) ? resp.data : resp.data?.messages;
      if (msgs && msgs.length > 0) {
        setPreviewMessages(msgs);
      } else if (resp.data?.error) {
        toast.error(resp.data.error);
      } else {
        console.warn("[PREVIEW] no messages, resp=", resp.data);
      }
    } catch (e: any) {
      catchError(e, "โหลดข้อความไม่สำเร็จ");
    } finally {
      setPreviewLoading(false);
    }
  }, [catchError]);

  // ⚡ รัน replay แค่ conversation เดียว
  const runReplayConv = useCallback(async (convId: string, shopName?: string) => {
    setSelectedInboxId(convId);
    setReplayConvRunning(true);
    setData(null);
    try {
      const resp = await api().post("/replay-compare", {
        action: "run_conv",
        conversation_id: convId,
        shop: shopName,
      }, { validateStatus: () => true, timeout: 60000 });

      if (resp.data?.alreadyRunning) {
        toast.info(`มี replay script รันอยู่แล้ว (PID: ${resp.data.pid}) — รอให้เสร็จก่อน`);
        return;
      }

      const savePath = resp.data?.savePath;
      toast.success(`เริ่ม replay แชท ${convId.slice(-8)} (PID: ${resp.data?.pid})`);

      // โพลไฟล์ทุก 5 วินาที — single conv เร็วกว่า batch
      const poll = setInterval(async () => {
        if (!savePath) { clearInterval(poll); return; }
        try {
          const r = await api().get("/replay-compare", {
            params: { file: savePath },
            validateStatus: () => true,
            timeout: 60000,
          });
          if (r.data && !r.data?.error) {
            setData(r.data);
            setPreviewConv(null); // ⚡ เคลียร์ preview เมื่อมีผลแล้ว
            setSelectedConvIdx(0);
            setSelectedQIdx(0);
            if (r.data?.status === "done") {
              clearInterval(poll);
              setReplayConvRunning(false);
              const nConv = r.data.conversations?.length || 0;
              toast.success(`รันเสร็จ! ${nConv} แชท, ${r.data.analysis?.total_qa || 0} Q&A`);
              // ⚡ reload history เพื่อให้แชทใหม่ขึ้นใน tab History
              setHistoryLoaded(false);
              loadHistory();
            }
          }
        } catch {
          // ยังไม่มีไฟล์
        }
      }, 5000);

      // timeout 5 นาที — กัน poll ค้าง
      setTimeout(() => { clearInterval(poll); setReplayConvRunning(false); }, 300_000);
    } catch (e: any) {
      catchError(e, "รัน replay แชทไม่ได้");
      setReplayConvRunning(false);
    }
  }, [catchError, loadHistory]);

  const runReplay = useCallback(async () => {
    setRunning(true);
    try {
      const limit = parseInt(limitInput) || 50;
      const resp = await api().post("/replay-compare", {
        action: "run",
        limit,
        oldest: true,
      }, { validateStatus: () => true, timeout: 60000 });

      // ⚡ ถ้ามี script รันอยู่แล้ว → ไม่รันซ้อน
      if (resp.data?.alreadyRunning) {
        toast.info(`มี replay script รันอยู่แล้ว (PID: ${resp.data.pid}) — ไม่รันซ้อน`);
        setRunning(true);
        // โพลไฟล์ที่มีอยู่
        const poll = setInterval(async () => {
          await loadData();
          if (data?.status === "done") {
            clearInterval(poll);
            setRunning(false);
          }
        }, 10000);
        return;
      }

      const savePath = resp.data?.savePath;
      toast.success(`เริ่มรัน replay ${limit} แชทเก่าสุด (PID: ${resp.data?.pid})`);
      setSelectedFile(savePath || "");

      // ⚡ โพลไฟล์ทุก 10 วินาที — ดู progress จาก status ใน JSON
      const poll = setInterval(async () => {
        if (!savePath) { clearInterval(poll); return; }
        try {
          const r = await api().get("/replay-compare", {
            params: { file: savePath },
            validateStatus: () => true,
            timeout: 60000,
          });
          if (r.data && !r.data?.error) {
            setData(r.data);
            setSelectedConvIdx(0);
            setSelectedQIdx(0);
            if (r.data?.status === "done") {
              clearInterval(poll);
              setRunning(false);
              toast.success(`รันเสร็จ! ${r.data.conversations?.length || 0} แชท`);
            }
          }
        } catch {
          // ยังไม่มีไฟล์
        }
      }, 10000);
    } catch (e: any) {
      catchError(e, "รัน replay ไม่ได้");
      setRunning(false);
    }
  }, [limitInput, catchError, loadData, data]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }, []);

  // ─── Derived ─────────────────────────────────────────────
  const convs = data?.conversations || [];
  const selectedConv = convs[selectedConvIdx];
  const selectedQa = selectedConv?.qa?.[selectedQIdx];
  const analysis = data?.analysis;

  // ⚡ Filter inbox conversations ตาม platform + shop (search ส่งไป server แล้วผ่าน useSharedConversations)
  const filteredInbox = (sharedInboxConvs as Conversation[]).filter(c => {
    if (inboxPlatform !== "all" && c.platform !== inboxPlatform) return false;
    if (inboxShop && c.shop_name !== inboxShop) return false;
    return true;
  });

  // ⚡ Filter history items ตาม search
  const filteredHistory = historyItems.filter(h => {
    if (!historySearch) return true;
    const q = historySearch.toLowerCase();
    return (
      (h.conv_id || "").toLowerCase().includes(q) ||
      (h.shop_name || "").toLowerCase().includes(q)
    );
  });

  // หา judgment ของ Q&A ที่เลือก — match conv_id เต็ม หรือ fallback ด้วย prefix 12 ตัว
  const selectedJudgment = analysis?.llm_judgments?.find(
    j => (j.conv_id === selectedConv?.conv_id ||
          j.conv_id === selectedConv?.conv_id?.slice(0, 12) ||
          j.conv_id?.slice(0, 12) === selectedConv?.conv_id?.slice(0, 12))
        && j.q_i === selectedQa?.i
  );

  // ⚡ mobile/tablet header — ชื่อ + platform ของแชทที่กำลังดู (preview หรือผล replay)
  const mobileHeaderConv: { name: string; platform?: Platform } | null = previewConv
    ? {
        name: previewConv.customer_name || previewConv.shop_name || previewConv.id?.slice(-12) || "แชท",
        platform: previewConv.platform,
      }
    : selectedConv
      ? (() => {
          // ⚡ replay conv ไม่มี platform — หาจาก inbox/history ที่ conv_id ตรงกัน
          const matched = (sharedInboxConvs as Conversation[]).find(
            c => c.id === selectedConv.conv_id || c.id?.slice(0, 16) === selectedConv.conv_id
          );
          const hist = historyItems.find(
            h => h.conv_id === selectedConv.conv_id || h.conv_id?.slice(0, 16) === selectedConv.conv_id
          );
          return {
            name: matched?.customer_name || hist?.customer_name || selectedConv.shop_name || selectedConv.conv_id?.slice(-12) || "แชท",
            platform: matched?.platform,
          };
        })()
      : null;

  // ⚡ กอปทั้งแชท — ทุกข้อความ + รีวิว LLM judge
  const copyEntireChat = useCallback(async () => {
    if (!selectedConv || !analysis) return;
    const lines: string[] = [];
    lines.push(`=== Replay Compare — ${selectedConv.shop_name} ===`);
    lines.push(`conversation_id: ${selectedConv.conv_id}`);
    lines.push(`shop: ${selectedConv.shop_name}`);
    lines.push(`turns: ${selectedConv.qa?.length || 0}`);
    if (selectedConv.handoff_stopped) lines.push(`หยุดที่: handoff`);
    lines.push("");
    for (const q of selectedConv.qa || []) {
      const mt = q.user_message_type || inferMessageType(q.user_text) || "text";
      lines.push(`─── Q${q.i} ───`);
      lines.push(`[ลูกค้า] (${mt}) ${q.user_text}`);
      if (q.item_id) lines.push(`  📦 item_id: ${q.item_id}`);
      if (q.zaapi_text) {
        lines.push(`[Zaapi/Admin (${q.zaapi_role || "?"})] ${q.zaapi_text}`);
      }
      if (q.bot_answer) {
        lines.push(`[Bot] ${q.bot_answer}`);
        if (q.bot_source) lines.push(`  source: ${q.bot_source}`);
        if (q.bot_ws) lines.push(`  🔍 web search`);
        if (q.bot_handoff) lines.push(`  ⚠️ handoff to admin`);
      }
      if (q.bot_error) lines.push(`  ❌ error: ${q.bot_error}`);
      const j = analysis.llm_judgments?.find(
        x => (x.conv_id === selectedConv.conv_id ||
              x.conv_id === selectedConv.conv_id?.slice(0, 12) ||
              x.conv_id?.slice(0, 12) === selectedConv.conv_id?.slice(0, 12))
              && x.q_i === q.i
      );
      if (j) {
        lines.push(`[รีวิว] ${j.verdict}`);
        lines.push(`  เหตุผล: ${j.reason}`);
        if (j.bot_problems?.length) {
          lines.push(`  ⚠️ ปัญหา Bot:`);
          for (const p of j.bot_problems) lines.push(`    - ${p}`);
        }
        if (j.bot_strengths?.length) {
          lines.push(`  ✅ จุดแข็ง Bot:`);
          for (const s of j.bot_strengths) lines.push(`    - ${s}`);
        }
        if (j.bot_fixes?.length) {
          lines.push(`  🔧 วิธีแก้:`);
          for (const f of j.bot_fixes) lines.push(`    - ${f}`);
        }
        if (j.side_effects) lines.push(`  💥 side effects: ${j.side_effects}`);
      }
      lines.push("");
    }
    await copyText(lines.join("\n"));
  }, [selectedConv, analysis, copyText]);

  // ─── Render ──────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Header — 2 rows: title+tabs / status+actions */}
      <div className="border-b border-border bg-surface">
        {/* Row 1: title + tabs */}
        <div className="flex items-center justify-between px-4 pt-3 overflow-x-auto">
          <div className="flex items-center gap-3 shrink-0">
            <Scale className="w-5 h-5 text-info" />
            <div className="flex items-center gap-1.5">
              <h1 className="text-lg font-semibold">เปรียบเทียบรีเพลย์</h1>
              <Link
                href="/help#replay-compare"
                className="text-text-subtle hover:text-brand transition-colors"
                aria-label="วิธีใช้งานเปรียบเทียบรีเพลย์"
              >
                <HelpCircle size={14} />
              </Link>
            </div>
            {/* ⚡ 3 tabs: เลือกแชท (inbox) | History | ไฟล์ผล (files) */}
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={() => setMode("inbox")}
                className={`px-2.5 py-1 text-xs rounded font-medium transition ${
                  mode === "inbox" ? "bg-info/10 text-info-dark" : "text-text-muted hover:bg-surface-2"
                }`}
              >
                <Inbox className="w-3.5 h-3.5 inline mr-1" />เลือกแชท
              </button>
              <button
                onClick={() => setMode("history")}
                className={`px-2.5 py-1 text-xs rounded font-medium transition ${
                  mode === "history" ? "bg-info/10 text-info-dark" : "text-text-muted hover:bg-surface-2"
                }`}
              >
                <History className="w-3.5 h-3.5 inline mr-1" />ประวัติ
                {historyItems.length > 0 && (
                  <span className="ml-1 text-[10px] text-text-subtle">({historyItems.length})</span>
                )}
              </button>
              <button
                onClick={() => setMode("files")}
                className={`px-2.5 py-1 text-xs rounded font-medium transition ${
                  mode === "files" ? "bg-info/10 text-info-dark" : "text-text-muted hover:bg-surface-2"
                }`}
              >
                <FileText className="w-3.5 h-3.5 inline mr-1" />ไฟล์ผล
              </button>
            </div>
          </div>
        </div>
        {/* Row 2: status pills + actions */}
        <div className="flex items-center justify-between flex-wrap gap-2 px-4 pb-2 pt-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            {mode === "files" && (
              <Badge tone="neutral">{convs.length} แชท</Badge>
            )}
            {mode === "inbox" && sharedInboxConvs.length > 0 && (
              <Badge tone="neutral">{inboxTotalCount || sharedInboxConvs.length} แชท</Badge>
            )}
            {mode === "history" && historyItems.length > 0 && (
              <Badge tone="neutral">{historyItems.length} แชท</Badge>
            )}
            {data?.generated_at && (
              <span className="text-xs text-text-muted">
                สร้างเมื่อ {timeAgo(data.generated_at)}
              </span>
            )}
            {data?.status === "running" && data?.progress && (
              <span className="text-xs text-info-dark font-medium">
                🔄 {data.progress.current}/{data.progress.total} แชท
              </span>
            )}
            {data?.status === "done" && (
              <span className="text-xs text-success font-medium">✓ เสร็จ</span>
            )}
            {replayConvRunning && (
              <span className="text-xs text-info-dark font-medium animate-pulse">
                🔄 กำลัง replay แชท...
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {mode === "files" && (
              <>
                <input
                  type="number"
                  value={limitInput}
                  onChange={e => setLimitInput(e.target.value)}
                  className="w-20 px-2 py-1 text-sm border rounded"
                  placeholder="50"
                  min={1}
                  max={500}
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={runReplay}
                  disabled={running}
                >
                  {running ? (
                    <><RefreshCw className="w-4 h-4 animate-spin" /> กำลังรัน...</>
                  ) : (
                    <><PlayCircle className="w-4 h-4" /> รัน {limitInput} แชทแรก</>
                  )}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (mode === "history") { setHistoryLoaded(false); loadHistory(); }
                else { loadData(selectedFile || undefined); loadFiles(); }
              }}
              disabled={mode === "files" ? loading : mode === "history" ? historyLoading : inboxLoading}
            >
              <RefreshCw className={`w-4 h-4 ${
                mode === "files" ? (loading ? "animate-spin" : "") :
                mode === "history" ? (historyLoading ? "animate-spin" : "") :
                (inboxLoading ? "animate-spin" : "")
              }`} />
              รีเฟรช
            </Button>
          </div>
        </div>
      </div>

      {/* File selector */}
      {files.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-surface-2 text-xs">
          <FileText className="w-3.5 h-3.5 text-text-subtle" />
          <span className="text-text-muted">ไฟล์:</span>
          <select
            value={selectedFile}
            onChange={e => { setSelectedFile(e.target.value); loadData(e.target.value); }}
            className="px-2 py-1 border rounded text-xs min-w-0 flex-1 lg:flex-none"
          >
            <option value="">ล่าสุด (default)</option>
            {files.map(f => (
              <option key={f.path} value={f.path}>
                {f.path.split("/").pop()} ({fmtSize(f.size)}, {timeAgo(f.mtime)})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Main 3-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Conversation list — inbox หรือ files แล้วแต่ mode */}
        <div
          className={`${mobileView === "list" ? "flex" : "hidden"} lg:flex w-full lg:w-72 shrink-0 border-r overflow-y-auto bg-white flex-col`}
          onScroll={mode === "inbox" ? (e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
              if (inboxHasMore && !inboxLoadingMore && inboxLoadMore) {
                inboxLoadMore();
              }
            }
          } : undefined}
        >
          {mode === "inbox" ? (
            <>
              {/* ⚡ Inbox picker — search + filter + list จาก /admin/conversations */}
              <div className="sticky top-0 z-10 bg-white border-b px-2 py-2 space-y-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-text-subtle absolute left-2 top-2" />
                  <input
                    value={inboxSearch}
                    onChange={e => setInboxSearch(e.target.value)}
                    placeholder="ค้นหา ชื่อ/ข้อความ/conv_id..."
                    className="w-full pl-7 pr-2 py-1.5 text-xs border rounded"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <select
                    value={inboxPlatform}
                    onChange={e => setInboxPlatform(e.target.value as "all" | Platform)}
                    className="flex-1 px-1.5 py-1 text-xs border rounded"
                  >
                    <option value="all">ทุกแพลตฟอร์ม</option>
                    <option value="shopee">Shopee</option>
                    <option value="tiktok">TikTok</option>
                    <option value="lazada">Lazada</option>
                  </select>
                  <select
                    value={inboxShop}
                    onChange={e => setInboxShop(e.target.value)}
                    className="flex-1 px-1.5 py-1 text-xs border rounded"
                  >
                    <option value="">ทุกร้าน</option>
                    {inboxShops.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between text-[10px] text-text-subtle">
                  <span>{filteredInbox.length}{inboxTotalCount ? ` จาก ${inboxTotalCount}` : ""}</span>
                  {inboxLoading && <RefreshCw className="w-3 h-3 animate-spin" />}
                </div>
              </div>

              {inboxLoading && filteredInbox.length === 0 && (
                <div className="p-4"><Loading /></div>
              )}
              {!inboxLoading && filteredInbox.length === 0 && (
                <EmptyState
                  icon={Inbox}
                  title="ไม่มีแชท"
                  description="ลองเปลี่ยน filter หรือกด Refresh"
                />
              )}
              <div className="divide-y">
                {filteredInbox.map((c) => {
                  const isSelected = selectedInboxId === c.id;
                  const hasReplay = convs.some(rc => rc.conv_id === c.id || rc.conv_id === c.id.slice(0, 16));
                  return (
                    <button
                      key={c.id}
                      onClick={() => { loadPreview(c); setMobileView("chat"); }}
                      disabled={replayConvRunning}
                      className={`w-full text-left px-3 py-2 hover:bg-surface-2 transition disabled:opacity-50 ${
                        isSelected ? "bg-info/5 border-l-2 border-info" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-text truncate">
                          {c.customer_name || c.id.slice(-8)}
                        </span>
                        <span className="text-[10px] text-text-subtle">
                          {c.last_timestamp ? timeAgo(c.last_timestamp) : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Store className="w-3 h-3 text-text-subtle" />
                        <span className="text-xs text-text-muted truncate">{c.shop_name || "?"}</span>
                        {c.platform && (
                          <span className="text-[10px] text-text-subtle ml-auto">{c.platform}</span>
                        )}
                      </div>
                      <div className="text-[11px] text-text-muted truncate mt-0.5">
                        {c.last_message || "(ไม่มีข้อความ)"}
                      </div>
                      {isSelected && replayConvRunning && (
                        <div className="text-[10px] text-info-dark mt-1 animate-pulse">กำลัง replay...</div>
                      )}
                      {isSelected && !replayConvRunning && hasReplay && (
                        <div className="text-[10px] text-success mt-1">✓ มีผลแล้ว</div>
                      )}
                    </button>
                  );
                })}
                {inboxLoadingMore && (
                  <div className="p-2 text-center text-[10px] text-text-subtle flex items-center justify-center gap-1">
                    <RefreshCw className="w-3 h-3 animate-spin" /> กำลังโหลดเพิ่ม...
                  </div>
                )}
                {!inboxLoadingMore && !inboxHasMore && filteredInbox.length > 0 && (
                  <div className="p-2 text-center text-[10px] text-text-subtle">โหลดครบแล้ว</div>
                )}
              </div>
            </>
          ) : mode === "history" ? (
            <>
              {/* ⚡ History — แชทที่เคย replay ผ่าน inbox แล้ว */}
              <div className="sticky top-0 z-10 bg-white border-b px-2 py-2 space-y-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-text-subtle absolute left-2 top-2" />
                  <input
                    value={historySearch}
                    onChange={e => setHistorySearch(e.target.value)}
                    placeholder="ค้นหา conv_id/ร้าน..."
                    className="w-full pl-7 pr-2 py-1.5 text-xs border rounded"
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-text-subtle">
                  <span>{filteredHistory.length} จาก {historyItems.length}</span>
                  {historyLoading && <RefreshCw className="w-3 h-3 animate-spin" />}
                </div>
              </div>

              {historyLoading && historyItems.length === 0 && (
                <div className="p-4"><Loading /></div>
              )}
              {!historyLoading && filteredHistory.length === 0 && (
                <EmptyState
                  icon={History}
                  title="ยังไม่มี history"
                  description="ไป tab 'เลือกแชท' แล้วกด replay แชท — ผลจะเก็บที่นี่"
                />
              )}
              <div className="divide-y">
                {filteredHistory.map((h) => {
                  const isSelected = selectedInboxId === h.conv_id;
                  return (
                    <button
                      key={h.file_path}
                      onClick={() => {
                        // ⚡ โหลดไฟล์ replay ของแชทนี้ขึ้นมาแสดง
                        setSelectedInboxId(h.conv_id);
                        loadData(h.file_path);
                        setMobileView("chat");
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-surface-2 transition ${
                        isSelected ? "bg-info/5 border-l-2 border-info" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-text-muted truncate">
                          {h.conv_id?.slice(-12)}
                        </span>
                        <span className="text-[10px] text-text-subtle">
                          {h.generated_at ? timeAgo(h.generated_at) : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Store className="w-3 h-3 text-text-subtle" />
                        <span className="text-xs text-text-muted truncate">{h.shop_name || "?"}</span>
                        <span className="text-[10px] text-text-subtle ml-auto">{h.qa_count}Q</span>
                      </div>
                      {h.status === "running" && (
                        <div className="text-[10px] text-info-dark mt-0.5 animate-pulse">กำลังรัน...</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {/* ⚡ Files mode — list จาก replay JSON (เดิม) */}
              {loading && <Loading />}
              {!loading && convs.length === 0 && (
                <EmptyState
                  icon={Scale}
                  title="ยังไม่มีข้อมูล"
                  description="กด Run เพื่อเริ่ม replay"
                />
              )}
              <div className="divide-y">
                {convs.map((c, idx) => {
                  const convJudgments = analysis?.llm_judgments?.filter(j =>
                    j.conv_id === c.conv_id ||
                    j.conv_id === c.conv_id?.slice(0, 12) ||
                    j.conv_id?.slice(0, 12) === c.conv_id?.slice(0, 12)
                  ) || [];
                  const botBetter = convJudgments.filter(j => j.verdict === "bot_better").length;
                  const zaapiBetter = convJudgments.filter(j => j.verdict === "zaapi_better").length;
                  return (
                    <button
                      key={c.conv_id}
                      onClick={() => { setSelectedConvIdx(idx); setSelectedQIdx(0); setMobileView("chat"); }}
                      className={`w-full text-left px-3 py-2 hover:bg-surface-2 transition ${
                        idx === selectedConvIdx ? "bg-info/5 border-l-2 border-info" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-text-muted truncate">
                          {c.conv_id?.slice(0, 16)}
                        </span>
                        <span className="text-xs text-text-subtle">{c.qa?.length || 0}Q</span>
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <Store className="w-3 h-3 text-text-subtle" />
                        <span className="text-xs text-text-muted truncate">{c.shop_name || "?"}</span>
                      </div>
                      {(botBetter > 0 || zaapiBetter > 0) && (
                        <div className="flex items-center gap-2 mt-1 text-xs">
                          <span className="text-success">🟢{botBetter}</span>
                          <span className="text-error">🔴{zaapiBetter}</span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Center: Chat comparison */}
        <div className={`${mobileView === "chat" ? "block" : "hidden"} lg:block flex-1 min-w-0 overflow-y-auto bg-surface-2`}>
          {/* ⚡ Mobile/Tablet (<lg) header — back "<" + ชื่อแชท/platform + ปุ่มสถิติ */}
          <div className="lg:hidden sticky top-0 z-10 flex items-center justify-between gap-1 px-2 py-2 bg-surface/95 backdrop-blur border-b border-border">
            <button
              onClick={() => setMobileView("list")}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text transition-colors shrink-0"
              title="กลับ"
              aria-label="กลับ"
            >
              <ChevronLeft size={18} />
            </button>
            <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-center">
              {mobileHeaderConv ? (
                <>
                  <span className="w-5 h-5 rounded-md bg-brand/10 flex items-center justify-center shrink-0">
                    {mobileHeaderConv.platform ? (
                      <span className="text-[10px] font-bold text-brand">
                        {mobileHeaderConv.platform[0]?.toUpperCase()}
                      </span>
                    ) : (
                      <Store className="w-3 h-3 text-brand" />
                    )}
                  </span>
                  <span className="text-xs font-semibold text-text truncate">{mobileHeaderConv.name}</span>
                </>
              ) : (
                <span className="text-xs text-text-muted">เปรียบเทียบรีเพลย์</span>
              )}
            </div>
            <button
              onClick={() => setMobileView("stat")}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text transition-colors shrink-0"
              title="สถิติ"
              aria-label="สถิติ"
            >
              <BarChart3 size={16} />
            </button>
          </div>
          {/* ⚡ Preview panel — ก่อน replay แสดงข้อความต้นฉบับให้ดูก่อน */}
          {previewConv && !selectedConv && (
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2 bg-white rounded-lg border p-3">
                <div>
                  <h2 className="font-semibold text-sm">
                    {previewConv.shop_name} · {previewConv.id?.slice(-12)}
                  </h2>
                  <span className="text-xs text-text-muted">
                    {previewConv.customer_name || "ไม่ระบุชื่อ"} · {previewConv.platform || "?"}
                  </span>
                </div>
                <Button
                  size="sm"
                  onClick={() => runReplayConv(previewConv.id, previewConv.shop_name)}
                  disabled={replayConvRunning}
                >
                  <PlayCircle className="w-4 h-4 mr-1" />
                  {replayConvRunning ? "กำลัง replay..." : "รัน Replay Compare"}
                </Button>
              </div>
              {previewLoading && <Loading />}
              {!previewLoading && previewMessages.length === 0 && (
                <EmptyState
                  icon={Bot}
                  title="ไม่มีข้อความ"
                  description="ไม่สามารถโหลดข้อความของแชทนี้ได้"
                />
              )}
              {!previewLoading && previewMessages.length > 0 && (
                <div className="bg-white rounded-lg border p-3 space-y-2 max-h-[60vh] overflow-y-auto">
                  <div className="text-xs text-text-subtle mb-2">
                    {previewMessages.length} ข้อความ · ตรวจดูก่อน แล้วกด "รัน Replay Compare"
                  </div>
                  {previewMessages.map((m, i) => {
                    // ⚡ Date separator — แทรก DateBanner เมื่อวันเปลี่ยน (เหมือน LINE)
                    const dk = dayKey(m.timestamp);
                    const showDate = i === 0 || dk !== dayKey(previewMessages[i - 1].timestamp);
                    return (
                    <React.Fragment key={i}>
                      {showDate && <DateBanner timestamp={m.timestamp} compact onlyToday />}
                      <div
                        className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                            m.role === "user"
                              ? "bg-pale-sky/20 text-text"
                              : "bg-success text-white"
                          }`}
                        >
                          <div className={`text-[10px] mb-0.5 ${m.role === "user" ? "text-text-muted" : "text-success-soft"}`}>
                            {m.role === "user" ? (
                              <><User className="w-3 h-3 inline mr-1" />ลูกค้า</>
                            ) : (
                              <><Bot className="w-3 h-3 inline mr-1" />{m.admin_name || m.source || "บอท/แอดมิน"}</>
                            )}
                          </div>
                          <MessageContent msg={m} variant={m.role === "user" ? "user" : "out"} />
                        </div>
                      </div>
                    </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {!previewConv && !selectedConv && !loading && (
            <EmptyState
              icon={Bot}
              title="เลือกแชทจาก list"
              description="คลิกแชททางซ้ายเพื่อดูข้อความ แล้วกดรัน Replay Compare"
            />
          )}
          {selectedConv && (
            <div className="p-4 space-y-4">
              {/* Conv header */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <h2 className="font-semibold text-sm">
                    {selectedConv.shop_name} · {selectedConv.conv_id?.slice(0, 20)}
                  </h2>
                  <span className="text-xs text-text-muted">
                    {selectedConv.qa?.length || 0} คำถาม
                    {selectedConv.handoff_stopped && " · หยุดที่ handoff"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {/* ⚡ กอปทั้งแชท */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={copyEntireChat}
                    title="คัดลอกทั้งแชท + รีวิว"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    กอปทั้งแชท
                  </Button>
                </div>
                {/* Q navigator */}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedQIdx(Math.max(0, selectedQIdx - 1))}
                    disabled={selectedQIdx === 0}
                    title="คำถามก่อนหน้า" aria-label="คำถามก่อนหน้า"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-xs text-text-muted">
                    Q{selectedQIdx + 1}/{selectedConv.qa?.length || 0}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedQIdx(Math.min((selectedConv.qa?.length || 1) - 1, selectedQIdx + 1))}
                    disabled={selectedQIdx >= (selectedConv.qa?.length || 1) - 1}
                    title="คำถามถัดไป" aria-label="คำถามถัดไป"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Q&A comparison */}
              {selectedQa && (
                <div className="space-y-3">
                  {/* User question */}
                  <Card className="p-3 bg-info/5 border-info/20">
                    <div className="flex items-start gap-2">
                      <User className="w-4 h-4 text-info mt-0.5" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-info-dark">ลูกค้า</span>
                          {/* ⚡ แสดง message type badge — ใช้ field ตรง หรือ fallback ดึงจาก text */}
                          {(() => {
                            const mt = selectedQa.user_message_type || inferMessageType(selectedQa.user_text);
                            if (!mt || mt === "text") return null;
                            const tone =
                              mt === "item" || mt === "variation_card" ? "brand" :
                              mt === "order" ? "coral" :
                              mt === "image" || mt === "video" ? "pale" :
                              mt === "notification" ? "deep" :
                              "neutral";
                            const label =
                              mt === "item" ? "📦 สินค้า" :
                              mt === "variation_card" ? "📦 ตัวเลือกสินค้า" :
                              mt === "order" ? "🛒 คำสั่งซื้อ" :
                              mt === "image" ? "🖼️ รูปภาพ" :
                              mt === "video" ? "🎥 วิดีโอ" :
                              mt === "sticker" ? "😊 สติกเกอร์" :
                              mt === "notification" ? "🔔 แจ้งเตือน" :
                              mt === "faq_liveagent" ? "🎧 โอนเจ้าหน้าที่" :
                              mt === "bundle_message" ? "📦 Bundle" :
                              mt;
                            return <Badge tone={tone}>{label}</Badge>;
                          })()}
                          {selectedQa.item_id && (
                            <Badge tone="brand" className="mt-0">item: {selectedQa.item_id}</Badge>
                          )}
                        </div>
                        <div className="text-sm whitespace-pre-wrap">{selectedQa.user_text}</div>
                        {/* ⚡ Phase 1F — แสดงรูป/วิดีโอจริงถ้ามี user_media */}
                        {selectedQa.user_media?.url && (
                          <div className="mt-2">
                            {selectedQa.user_media.type === "video" ? (
                              <div
                                className="relative cursor-pointer rounded-lg overflow-hidden group inline-block"
                                onClick={() => imageViewer.show(selectedQa.user_media!.url!, { type: "video", alt: "วิดีโอ" })}
                              >
                                <video
                                  src={selectedQa.user_media.url}
                                  poster={selectedQa.user_media.thumb_url}
                                  className="rounded-lg max-w-[240px] max-h-[240px]"
                                  preload="metadata"
                                />
                                <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                  <span className="text-white text-xs bg-black/60 px-2 py-1 rounded">▶ กดดู</span>
                                </div>
                              </div>
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={selectedQa.user_media.url}
                                alt="รูปที่ลูกค้าส่ง"
                                className="rounded-lg max-w-[240px] max-h-[240px] object-cover cursor-pointer hover:opacity-80 transition-opacity"
                                loading="lazy"
                                onClick={() => imageViewer.show(selectedQa.user_media!.url!, { type: "image", alt: "รูปที่ลูกค้าส่ง" })}
                              />
                            )}
                          </div>
                        )}
                        {/* ⚡ แสดง product card จริง (รูป/ชื่อ/ราคา) ถ้ามี user_products จาก replay_compare.py */}
                        {selectedQa.user_products && selectedQa.user_products.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {selectedQa.user_products.map((p, idx) => (
                              <div key={idx} className="flex gap-2 bg-white border border-info/20 rounded-lg p-2 max-w-xs">
                                {p.image && (
                                  <img
                                    src={p.image}
                                    alt={p.name}
                                    className="w-14 h-14 object-cover rounded shrink-0"
                                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                  />
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs font-medium text-text line-clamp-2">{p.name}</div>
                                  {p.price != null && (
                                    <div className="text-xs text-warning font-semibold mt-0.5">฿{p.price}</div>
                                  )}
                                  <div className="text-[10px] text-text-subtle mt-0.5">
                                    item: {p.item_id}{p.shop ? ` · ${p.shop}` : ""}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {/* ⚡ แสดง item_id / order_sn จาก parsed หรือ fallback ดึงจาก text */}
                          {(() => {
                            const itemId = selectedQa.user_parsed?.item_id || selectedQa.item_id || inferItemId(selectedQa.user_text);
                            const orderSn = selectedQa.user_parsed?.order_sn || inferOrderSn(selectedQa.user_text);
                            const notif = selectedQa.user_parsed?.notification_text;
                            return (
                              <>
                                {itemId && !selectedQa.item_id && !selectedQa.user_products && (
                                  <div className="mt-1 text-xs text-text-muted">📦 item_id: {itemId}</div>
                                )}
                                {orderSn && (
                                  <div className="mt-1 text-xs text-text-muted">🛒 order: {orderSn}</div>
                                )}
                                {notif && (
                                  <div className="mt-1 text-xs text-text-muted italic">🔔 {notif}</div>
                                )}
                              </>
                            );
                          })()}
                      </div>
                    </div>
                  </Card>

                  {/* Zaapi answer */}
                  <Card className="p-3">
                    <div className="flex items-start gap-2">
                      <div className="w-4 h-4 rounded-full bg-brand mt-0.5 flex items-center justify-center">
                        <span className="text-[8px] text-white font-bold">Z</span>
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-brand">
                            Zaapi/Admin ({selectedQa.zaapi_role || "?"})
                          </span>
                          {selectedQa.zaapi_source && (
                            <Badge tone="neutral">{selectedQa.zaapi_source}</Badge>
                          )}
                          <span className="text-xs text-text-subtle">{selectedQa.zaapi_text?.length || 0}c</span>
                          <button
                            onClick={() => copyText(selectedQa.zaapi_text)}
                            className="ml-auto text-text-subtle hover:text-text-muted"
                            title="คัดลอกคำตอบ Zaapi/Admin"
                            aria-label="คัดลอกคำตอบ Zaapi/Admin"
                          >
                            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        <div className="text-sm whitespace-pre-wrap">
                          {selectedQa.zaapi_text || <span className="text-text-subtle italic">(ไม่มีคำตอบ)</span>}
                        </div>
                      </div>
                    </div>
                  </Card>

                  {/* Bot answer */}
                  <Card className="p-3">
                    <div className="flex items-start gap-2">
                      <Bot className="w-4 h-4 text-success-soft mt-0.5" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-success-dark">Bot เรา</span>
                          {selectedQa.bot_source && (
                            <Badge tone="neutral">{selectedQa.bot_source}</Badge>
                          )}
                          {selectedQa.bot_ws && (
                            <Badge tone="coral">🔍 web search</Badge>
                          )}
                          {selectedQa.bot_handoff && (
                            <Badge tone="red">⚠️ handoff</Badge>
                          )}
                          {selectedQa.bot_error && (
                            <Badge tone="red">error</Badge>
                          )}
                          <span className="text-xs text-text-subtle">{selectedQa.bot_answer?.length || 0}c</span>
                          <button
                            onClick={() => copyText(selectedQa.bot_answer)}
                            className="ml-auto text-text-subtle hover:text-text-muted"
                            title="คัดลอกคำตอบ Bot เรา"
                            aria-label="คัดลอกคำตอบ Bot เรา"
                          >
                            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        {selectedQa.bot_error ? (
                          <div className="text-sm text-error">{selectedQa.bot_error}</div>
                        ) : (
                          <div className="text-sm whitespace-pre-wrap">
                            {selectedQa.bot_answer || <span className="text-text-subtle italic">(ไม่มีคำตอบ)</span>}
                          </div>
                        )}
                        {/* Products */}
                        {selectedQa.bot_product_names && selectedQa.bot_product_names.length > 0 && (
                          <div className="mt-2 text-xs text-text-muted">
                            📦 {selectedQa.bot_products_count} สินค้า: {selectedQa.bot_product_names.slice(0, 3).join(", ")}
                          </div>
                        )}
                      </div>
                    </div>
                  </Card>

                  {/* LLM Judge verdict */}
                  {selectedJudgment && (
                    <Card className={`p-3 border-2 ${verdictColor[selectedJudgment.verdict] || ""}`}>
                      <div className="flex items-center gap-2 mb-2">
                        {verdictIcon[selectedJudgment.verdict]}
                        <span className="font-semibold text-sm">
                          {verdictLabel[selectedJudgment.verdict] || selectedJudgment.verdict}
                        </span>
                        <Scale className="w-4 h-4 ml-auto text-text-subtle" />
                      </div>
                      <div className="text-sm mb-2">
                        <span className="font-semibold">เหตุผล: </span>
                        {selectedJudgment.reason}
                      </div>
                      {selectedJudgment.bot_problems && selectedJudgment.bot_problems.length > 0 && (
                        <div className="mb-2">
                          <div className="text-xs font-semibold text-error mb-1">⚠️ ปัญหาของ Bot:</div>
                          <ul className="text-sm space-y-1">
                            {selectedJudgment.bot_problems.map((p, i) => (
                              <li key={i} className="ml-4 list-disc">{p}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {selectedJudgment.bot_strengths && selectedJudgment.bot_strengths.length > 0 && (
                        <div className="mb-2">
                          <div className="text-xs font-semibold text-success mb-1">✅ จุดแข็งของ Bot:</div>
                          <ul className="text-sm space-y-1">
                            {selectedJudgment.bot_strengths.map((s, i) => (
                              <li key={i} className="ml-4 list-disc">{s}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {selectedJudgment.bot_fixes && selectedJudgment.bot_fixes.length > 0 && (
                        <div className="mb-2">
                          <div className="text-xs font-semibold text-info-dark mb-1">🔧 วิธีแก้:</div>
                          <ul className="text-sm space-y-1">
                            {selectedJudgment.bot_fixes.map((f, i) => (
                              <li key={i} className="ml-4 list-disc">{f}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {selectedJudgment.side_effects && (
                        <div className="text-xs text-text-muted italic">
                          💡 ผลกระทบ: {selectedJudgment.side_effects}
                        </div>
                      )}
                    </Card>
                  )}

                  {/* Debug info toggle */}
                  <div>
                    <button
                      onClick={() => setShowDebug(!showDebug)}
                      className="text-xs text-text-muted hover:text-text-muted flex items-center gap-1"
                    >
                      <BarChart3 className="w-3.5 h-3.5" />
                      {showDebug ? "ซ่อน" : "แสดง"} debug info (log/intent/retrieval)
                    </button>
                    {showDebug && (
                      <div className="mt-2 space-y-2">
                        {selectedQa.bot_log && (
                          <pre className="text-xs bg-gray-900 text-success-soft p-2 rounded overflow-x-auto max-h-48">
                            {selectedQa.bot_log}
                          </pre>
                        )}
                        {!!selectedQa.bot_intent && typeof selectedQa.bot_intent === "object" && Object.keys(selectedQa.bot_intent as object).length > 0 && (
                          <div className="text-xs">
                            <span className="font-semibold">Intent: </span>
                            <pre className="bg-surface-2 p-2 rounded mt-1">
                              {JSON.stringify(selectedQa.bot_intent, null, 2) as string}
                            </pre>
                          </div>
                        )}
                        {!!selectedQa.bot_retrieval_info && typeof selectedQa.bot_retrieval_info === "object" && Object.keys(selectedQa.bot_retrieval_info as object).length > 0 && (
                          <div className="text-xs">
                            <span className="font-semibold">Retrieval: </span>
                            <pre className="bg-surface-2 p-2 rounded mt-1">
                              {JSON.stringify(selectedQa.bot_retrieval_info, null, 2) as string}
                            </pre>
                          </div>
                        )}
                        {!!selectedQa.bot_routing && (
                          <div className="text-xs">
                            <span className="font-semibold">Routing: </span>
                            <pre className="bg-surface-2 p-2 rounded mt-1">
                              {JSON.stringify(selectedQa.bot_routing, null, 2) as string}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Analysis summary */}
        <div className={`${mobileView === "stat" ? "flex" : "hidden"} lg:flex flex-col w-full lg:w-80 shrink-0 border-l bg-white`}>
          {/* ⚡ Mobile/Tablet (<lg) header — back ไปที่หน้าเปรียบเทียบ */}
          <div className="lg:hidden flex items-center gap-1 px-2 py-2.5 border-b border-border shrink-0">
            <button
              onClick={() => setMobileView("chat")}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text transition-colors"
              title="กลับ"
              aria-label="กลับ"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-xs font-semibold text-text">สถิติและวิเคราะห์</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!analysis && <EmptyState icon={BarChart3} title="ยังไม่มี analysis" />}
          {analysis && (
            <>
              {/* Stats */}
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
                  <BarChart3 className="w-4 h-4" /> สถิติรวม
                </h3>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Conversations</span>
                    <span className="font-semibold">{analysis.total_conversations}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Q&A turns</span>
                    <span className="font-semibold">{analysis.total_qa}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Bot answered</span>
                    <span className="font-semibold text-success">{analysis.bot_answered}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Bot errors</span>
                    <span className="font-semibold text-error">{analysis.bot_errors}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Handoffs</span>
                    <span className="font-semibold text-warning">{analysis.bot_handoffs}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Web search</span>
                    <span className="font-semibold">{analysis.web_search_used}</span>
                  </div>
                </div>
              </div>

              {/* Comparison */}
              <div>
                <h3 className="text-sm font-semibold mb-2">เปรียบเทียบ</h3>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Both answered</span>
                    <span className="font-semibold">{analysis.both_answered}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Bot only</span>
                    <span className="font-semibold text-success">{analysis.bot_only}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Zaapi only</span>
                    <span className="font-semibold text-error">{analysis.zaapi_only}</span>
                  </div>
                </div>
              </div>

              {/* Length */}
              <div>
                <h3 className="text-sm font-semibold mb-2">ความยาว</h3>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Bot avg</span>
                    <span className="font-semibold">{analysis.avg_bot_len}c</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Bot short (&lt;80)</span>
                    <span className="text-warning">{analysis.bot_short}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Bot long (&gt;1500)</span>
                    <span className="text-warning">{analysis.bot_long}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Zaapi avg</span>
                    <span className="font-semibold">{analysis.avg_zaapi_len}c</span>
                  </div>
                </div>
              </div>

              {/* Links */}
              <div>
                <h3 className="text-sm font-semibold mb-2">ลิงก์</h3>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Bot has link</span>
                    <span className="font-semibold">{analysis.bot_has_link}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Bot no link</span>
                    <span className="text-warning">{analysis.bot_no_link}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">External link</span>
                    <span className="text-error">{analysis.bot_external_link}</span>
                  </div>
                </div>
              </div>

              {/* Sources */}
              {analysis.sources && Object.keys(analysis.sources).length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">Sources</h3>
                  <div className="space-y-1 text-xs">
                    {Object.entries(analysis.sources).sort((a, b) => b[1] - a[1]).map(([src, n]) => (
                      <div key={src} className="flex justify-between">
                        <span className="text-text-muted">{src}</span>
                        <span className="font-semibold">{n}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* LLM Judge distribution */}
              {analysis.llm_judgments && analysis.llm_judgments.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
                    <Scale className="w-4 h-4" /> LLM Judge
                  </h3>
                  <div className="space-y-1 text-xs">
                    {(["bot_better", "zaapi_better", "both_good", "both_bad", "judge_error"] as const).map(v => {
                      const n = analysis.llm_judgments.filter(j => j.verdict === v).length;
                      if (n === 0) return null;
                      return (
                        <div key={v} className="flex items-center justify-between">
                          <span className="flex items-center gap-1">
                            {verdictIcon[v]}
                            <span className="text-text-muted">{verdictLabel[v]}</span>
                          </span>
                          <span className="font-semibold">{n}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Good */}
              {analysis.good && analysis.good.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-success-dark">✅ จุดดี</h3>
                  <ul className="text-xs space-y-1">
                    {analysis.good.slice(0, 10).map((g, i) => (
                      <li key={i} className="ml-3 list-disc text-text-muted">{g}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Issues */}
              {analysis.issues && analysis.issues.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2 text-error">
                    ⚠️ ปัญหา ({analysis.issues.length})
                  </h3>
                  <ul className="text-xs space-y-1 max-h-64 overflow-y-auto">
                    {analysis.issues.slice(0, 20).map((iss, i) => (
                      <li key={i} className="ml-3 list-disc text-text-muted">{iss}</li>
                    ))}
                    {analysis.issues.length > 20 && (
                      <li className="text-text-subtle italic">... และอีก {analysis.issues.length - 20} ข้อ</li>
                    )}
                  </ul>
                </div>
              )}
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
