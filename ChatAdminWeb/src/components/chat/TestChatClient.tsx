"use client";
import React, { useState, useRef, useEffect, FormEvent } from "react";
import Link from "next/link";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";
import { Badge } from "@/components/ui/Badge";
import { toast } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import {
  Send,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  Settings2,
  X,
  RotateCcw,
  Package,
  Plus,
  Trash2,
  Terminal,
  Pencil,
  Search,
  ArrowUpDown,
  Star,
  MessageCircle,
  Save,
  BarChart3,
  Paperclip,
  Film,
  History,
  Clock,
} from "lucide-react";
import type { Platform } from "@/lib/types";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { RateBox } from "@/components/shadow/RateBox";
import { imageViewer } from "@/components/ui/ImageViewer";
import { quickReplyService, type QuickReplyRow } from "@/lib/services";
import { DateBanner, dayKey } from "@/components/shadow/DateBanner";
import { api } from "@/lib/apiClient";

interface Product {
  item_id?: string;
  name?: string;
  price?: { min?: number; max?: number; currency?: string } | number;
  shop?: string;
  brand?: string;
  image_url?: string;
  short_link?: string;
  warranty?: { type?: string; duration?: string };
  [k: string]: unknown;
}

interface MsgStats {
  elapsed?: number;
  usage?: { prompt?: number; output?: number; total?: number };
  cost?: number;
  model?: string;
  source?: string;
  intent?: {
    intent?: string;
    product_type?: string | null;
    charger_subtype?: string | null;
    target_device?: string | null;
    needs_description?: boolean;
    confidence?: number;
  };
  timing?: { pass1?: number; retrieval?: number; llm?: number; llm2?: number; total?: number; web_search?: number };
  retrieval_info?: { path?: string; product_count?: number; fallback_used?: boolean };
  web_search_used?: boolean;
  web_search_reason?: string;
  web_search_model?: string;
  steps?: StepInfo[];
  handoff_to_admin?: boolean;
  handoff_reason?: string;
  routing_decision?: {
    path?: string;
    reason?: string;
    trigger_matched?: string | null;
    shop_settings_action?: string | null;
    assigned_admin?: string | null;
    assigned_admin_name?: string | null;
    handoff_reason?: string | null;
  };
  // rating fields (admin ให้คะแนน)
  star_rating?: number;
  comment?: string;
  rating?: "good" | "bad" | "unrated";
}

interface StepInfo {
  name: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  time_s: number;
  cost_usd: number;
  cost_thb: number;
  detail?: Record<string, unknown>;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

interface Msg {
  id: number;
  role: "user" | "bot" | "sys";
  html: string;
  raw?: string;
  products?: Product[];
  stats?: MsgStats;
  sessionMsgIndex?: number;  // index ใน messages array ของ session (สำหรับ rate API)
  isGroupLast?: boolean;     // bubble สุดท้ายของกลุ่ม bot answer → RateBox แสดงที่นี่เท่านั้น
  timestamp?: string;        // ⚡ ISO timestamp — สำหรับ date separator (เหมือน LINE)
}

/* ---- markdown → HTML (port จากเดิม) ---- */
function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/* ---- format log stats เป็น text สำหรับ copy ---- */
function formatLogForCopy(stats: MsgStats, rawText: string): string {
  const lines: string[] = [];
  lines.push("=== Bot Answer Log ===");
  lines.push(`Text: ${rawText.slice(0, 200)}`);
  lines.push("");
  lines.push(`Elapsed: ${stats.elapsed ?? "—"}s`);
  lines.push(`Model: ${stats.model || "—"}`);
  lines.push(`Source: ${stats.source || "—"}`);
  lines.push(`Cost: $${stats.cost?.toFixed(6) ?? "—"} (฿${stats.cost ? (stats.cost * 36).toFixed(2) : "—"})`);
  if (stats.usage) {
    lines.push(`Tokens: in=${stats.usage.prompt ?? 0} out=${stats.usage.output ?? 0} total=${stats.usage.total ?? 0}`);
  }
  if (stats.intent) {
    lines.push(`Intent: ${stats.intent.intent || "—"} (confidence: ${stats.intent.confidence ?? "—"})`);
    if (stats.intent.product_type) lines.push(`  product_type: ${stats.intent.product_type}`);
    if (stats.intent.charger_subtype) lines.push(`  charger_subtype: ${stats.intent.charger_subtype}`);
    if (stats.intent.target_device) lines.push(`  target_device: ${stats.intent.target_device}`);
  }
  if (stats.timing) {
    lines.push(`Timing: pass1=${stats.timing.pass1 ?? "—"}s retrieval=${stats.timing.retrieval ?? "—"}s llm=${stats.timing.llm ?? "—"}s llm2=${stats.timing.llm2 ?? "—"}s total=${stats.timing.total ?? "—"}s`);
  }
  if (stats.web_search_used) {
    lines.push(`Web search: used (reason: ${stats.web_search_reason || "—"}, model: ${stats.web_search_model || "—"})`);
  }
  if (stats.retrieval_info) {
    lines.push(`Retrieval: path=${stats.retrieval_info.path || "—"} products=${stats.retrieval_info.product_count ?? 0} fallback=${stats.retrieval_info.fallback_used ?? false}`);
  }
  if (stats.handoff_to_admin) {
    lines.push(`Handoff: ${stats.handoff_reason || "—"}`);
  }
  if (stats.routing_decision) {
    lines.push(`Routing: path=${stats.routing_decision.path || "—"} reason=${stats.routing_decision.reason || "—"}`);
  }
  if (stats.steps && stats.steps.length > 0) {
    lines.push("");
    lines.push("=== Steps ===");
    stats.steps.forEach((s, i) => {
      lines.push(`[${i + 1}] ${s.name} (${s.model})`);
      lines.push(`  tokens: in=${s.tokens_in} out=${s.tokens_out} · ${s.time_s}s · $${s.cost_usd.toFixed(6)} (฿${s.cost_thb})`);
      if (s.input && Object.keys(s.input).length > 0) {
        lines.push(`  input: ${JSON.stringify(s.input)}`);
      }
      if (s.output && Object.keys(s.output).length > 0) {
        lines.push(`  output: ${JSON.stringify(s.output)}`);
      }
    });
  }
  lines.push("");
  lines.push(`Copied at: ${new Date().toLocaleString("th-TH")}`);
  return lines.join("\n");
}

function inlineFmt(s: string): string {
  // Escape HTML first to prevent XSS, then apply markdown formatting
  s = escapeHtml(s);
  s = s.replace(
    /!\[([\s\S]*?)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, alt, url) =>
      `<img src="${url}" alt="${alt}" onerror="this.remove()" /><div class="img-caption">${alt}</div>`
  );
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\[\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>');
  return s;
}

function formatAnswer(src: string): string {
  const lines = String(src).split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;

  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const parseTable = (startIdx: number): { html: string; nextIdx: number } | null => {
    const sep = lines[startIdx + 1] || "";
    if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(sep) || sep.split("|").filter((x) => x.trim()).length < 1) return null;
    const rows: string[] = [];
    let j = startIdx + 2;
    while (j < lines.length) {
      const ln = lines[j];
      if (!ln.trim().startsWith("|") && !/\|/.test(ln)) break;
      if (!ln.trim()) break;
      rows.push(ln);
      j++;
    }
    if (!rows.length) return null;
    const splitRow = (r: string) =>
      r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    const headers = splitRow(lines[startIdx]);
    const body = rows.map(splitRow);
    let html = '<div class="table-wrap"><table><thead><tr>';
    headers.forEach((h) => (html += `<th>${inlineFmt(h)}</th>`));
    html += "</tr></thead><tbody>";
    body.forEach((row) => {
      html += "<tr>";
      row.forEach((cell, idx) => {
        const h = (headers[idx] || "").toLowerCase();
        let cls = "";
        if (/ราคา|price|฿/.test(h)) cls = ' class="price"';
        else if (/รับประกัน|warranty|ประกัน/.test(h)) cls = ' class="warranty"';
        html += `<td${cls}>${inlineFmt(cell)}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    return { html, nextIdx: j };
  };

  while (i < lines.length) {
    const ln = lines[i];

    if (ln.trim().startsWith("|") && i + 1 < lines.length) {
      const t = parseTable(i);
      if (t) {
        flushList();
        out.push(t.html);
        i = t.nextIdx;
        continue;
      }
    }

    if (/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/.test(ln.trim())) {
      flushList();
      out.push(`<div>${inlineFmt(ln.trim())}</div>`);
      i++;
      continue;
    }

    const ulMatch = ln.match(/^\s*[-*•]\s+(.*)$/);
    const olMatch = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ulMatch) {
      if (listType !== "ul") {
        flushList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inlineFmt(ulMatch[1])}</li>`);
      i++;
      continue;
    }
    if (olMatch) {
      if (listType !== "ol") {
        flushList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inlineFmt(olMatch[1])}</li>`);
      i++;
      continue;
    }

    flushList();
    if (ln.trim()) out.push(`<p>${inlineFmt(ln)}</p>`);
    i++;
  }
  flushList();
  return out.join("");
}

function formatPrice(p: Product["price"]): string {
  if (!p) return "—";
  if (typeof p === "number") return `💰 ${p.toLocaleString()} THB`;
  const min = p.min;
  const max = p.max;
  const cur = p.currency || "THB";
  if (min != null && max != null && min !== max) return `💰 ${min}–${max} ${cur}`;
  if (min != null) return `💰 ${min} ${cur}`;
  if (max != null) return `💰 ${max} ${cur}`;
  return "—";
}

function warrantyText(w: Product["warranty"]): string {
  if (!w) return "";
  return [w.type, w.duration].filter(Boolean).join(" · ");
}

let msgIdCounter = 0;

function fmtElapsed(s?: number): string {
  if (s == null) return "—";
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  return `${s.toFixed(2)} s`;
}
function fmtTokens(n?: number): string {
  if (!n) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function fmtCost(usd?: number): string {
  if (usd == null || usd === 0) return "—";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}
function fmtTHB(usd?: number): string {
  if (usd == null || usd === 0) return "—";
  const thb = usd * 36;
  if (thb < 1) return `฿${thb.toFixed(4)}`;
  return `฿${thb.toFixed(2)}`;
}

const platformMeta: Record<Platform, { label: string; accent: string; accentSoft: string; ring: string; gradient: string; available: boolean }> = {
  shopee: {
    label: "Shopee",
    accent: "text-shopee",
    accentSoft: "bg-shopee-soft",
    ring: "focus:ring-shopee/40",
    gradient: "from-shopee to-[#ee4d2d]",
    available: true,
  },
  tiktok: {
    label: "TikTok Shop",
    accent: "text-tiktok",
    accentSoft: "bg-tiktok-soft",
    ring: "focus:ring-tiktok/40",
    gradient: "from-tiktok to-[#161823]",
    available: false,
  },
  lazada: {
    label: "Lazada",
    accent: "text-lazada",
    accentSoft: "bg-lazada-soft",
    ring: "focus:ring-lazada/40",
    gradient: "from-lazada to-[#0f146d]",
    available: false,
  },
};

// ⚡ Platform switcher — มือถือ/tablet เข้าถึง lazada/tiktok ไม่ได้เพราะอยู่ใน sidebar submenu
//   แสดงเฉพาะ <lg (desktop ใช้ sidebar submenu อยู่แล้ว)
function PlatformSwitcher({ platform }: { platform: Platform }) {
  const platforms: Platform[] = ["shopee", "tiktok", "lazada"];
  return (
    <div className="lg:hidden flex items-center gap-1 px-4 py-1.5 border-b border-border bg-surface-2 shrink-0">
      {platforms.map((p) => {
        const m = platformMeta[p];
        const active = p === platform;
        return (
          <Link
            key={p}
            href={`/test-chat/${p}`}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              active
                ? "bg-surface text-text shadow-sm border border-border"
                : "text-text-muted hover:text-text"
            }`}
          >
            <PlatformIcon platform={p} size={12} />
            {m.label}
          </Link>
        );
      })}
    </div>
  );
}

export function TestChatClient({ platform }: { platform: Platform }) {
  const meta = platformMeta[platform];
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: msgIdCounter++,
      role: "sys",
      html: `พิมพ์คำถามด้านล่างเพื่อทดสอบบอท${meta.label} เช่น "กล้อง IMILAB รุ่นไหนรับประกันศูนย์ไทย 1 ปี" หรือ "เปรียบเทียบหูฟัง QKZ กับ QCY งบ 500-1500"`,
    },
  ]);
  const [input, setInput] = useState("");
  const [shop, setShop] = useState("");
  const [shops, setShops] = useState<string[]>([]);
  // ⚡ Phase 2E — quick replies (floating chips above text box)
  const [quickReplies, setQuickReplies] = useState<QuickReplyRow[]>([]);
  const [limit, setLimit] = useState(10);
  // ⚡ ดึง llm_context_limit จาก config เป็น default (แทน hardcode 10)
  useEffect(() => {
    (async () => {
      try {
        const res = await api().get<{ config: { llm_context_limit?: number } }>("/config");
        if (res.data?.config?.llm_context_limit) {
          setLimit(res.data.config.llm_context_limit);
        }
      } catch { /* ignore — ใช้ default 10 */ }
    })();
  }, []);
  const [sending, setSending] = useState(false);
  // ⚡ handoff state — หลังส่งต่อแอดมิน บอทจะไม่ตอบจนกว่าจะกด "ปิดแชท"
  const [handedOff, setHandedOff] = useState(false);
  const [assignedAdmin, setAssignedAdmin] = useState<string | null>(null);
  const [assignedAdminName, setAssignedAdminName] = useState<string | null>(null);
  const [assignmentReason, setAssignmentReason] = useState<string | null>(null);
  // ⚡ Phase 2A — session status จาก DB (open|closed) ส่งให้บอทเป็น ticket_state
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [logViewMode, setLogViewMode] = useState<"grouped" | "all">("grouped");
  const [lastProducts, setLastProducts] = useState<Product[]>([]);
  const [totals, setTotals] = useState<{ turns: number; elapsed: number; prompt: number; output: number; total: number; cost: number; wsTurns: number; wsCost: number; wsTokens: number }>({
    turns: 0, elapsed: 0, prompt: 0, output: 0, total: 0, cost: 0, wsTurns: 0, wsCost: 0, wsTokens: 0,
  });
  const [copyAllLabel, setCopyAllLabel] = useState("คัดลอกแชททั้งหมด");
  // ⚡ A2 — เพิ่ม image_desc ใน history เพื่อให้ bot ใช้ cached description ไม่ re-read รูปเก่า
  const historyRef = useRef<{ role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[]>([]);
  const msgsRef = useRef<HTMLDivElement>(null);
  // ── Buffer mode state — ใช้ระบบ buffer เหมือนลูกค้าจริง ──
  const [bufferConfig, setBufferConfig] = useState<{ enabled: boolean; window_ms: number; max_messages: number } | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferedCount, setBufferedCount] = useState(0);
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferedMessagesRef = useRef<string[]>([]); // messages ที่กำลัง buffer (ยังไม่ส่ง bot)
  const bufferedImagesRef = useRef<string[]>([]); // ⚡ Phase 1F — images ที่กำลัง buffer
  const bufferSpinnerIdRef = useRef<number | null>(null); // id ของ spinner msg ใน UI
  // ── Right panel tab + all-sessions stats ──
  const [rightTab, setRightTab] = useState<"session" | "all" | "logs">("session");
  const [allStats, setAllStats] = useState<{
    total_ratings: number;
    good: number;
    bad: number;
    unrated: number;
    star_rated: number;
    avg_star: number;
    commented: number;
    total_cost_usd: number;
    avg_cost_usd: number;
    total_tokens: number;
    avg_tokens: number;
    avg_elapsed: number;
    intent_calls: number;
    web_search_calls: number;
    handoff_count: number;
  } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentMsgId, setCommentMsgId] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // ⚡ Phase 1F — image upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingImages, setPendingImages] = useState<{ url: string; type: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);

  // ── Session management ──
  const [sessions, setSessions] = useState<{ id: string; shop: string; title: string; message_count: number; updated_at?: string; created_at?: string; source?: string; script_test?: boolean }[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [selectedLogMsg, setSelectedLogMsg] = useState<Msg | null>(null);
  // ⚡ sidebar filter/sort state
  const [filterShop, setFilterShop] = useState<string>(""); // "" = ทุกร้าน
  const [filterSearch, setFilterSearch] = useState<string>("");
  const [sortBy, setSortBy] = useState<"updated" | "messages" | "created">("updated");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");

  async function loadSessions() {
    try {
      // ⚡ โหลดทุกร้านเสมอ — filter ทำใน frontend เพื่อให้เห็น history ทั้งหมด
      const r = await fetch(`/api/chatbot/${platform}/test-chat/sessions?limit=200`);
      if (r.ok) {
        const d = await r.json();
        setSessions(d.sessions || []);
      }
    } catch {
      toast.error("โหลดรายการแชทไม่สำเร็จ");
    }
  }

  async function createSession() {
    // ⚡ อนุญาตให้สร้าง session โดยไม่ต้องเลือกร้าน — เลือกทีหลังได้
    try {
      const r = await fetch(`/api/chatbot/${platform}/test-chat/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: shop || "" }),
      });
      if (r.ok) {
        const d = await r.json();
        setCurrentSessionId(d.id);
        setMessages([{
          id: msgIdCounter++,
          role: "sys",
          html: `พิมพ์คำถามด้านล่างเพื่อทดสอบบอท${meta.label}`,
        }]);
        historyRef.current = [];
        setTotals({ turns: 0, elapsed: 0, prompt: 0, output: 0, total: 0, cost: 0, wsTurns: 0, wsCost: 0, wsTokens: 0 });
        await loadSessions();
      }
    } catch {
      toast.error("ไม่สามารถสร้างแชทได้");
    }
  }

  async function loadSession(id: string) {
    try {
      const r = await fetch(`/api/chatbot/${platform}/test-chat/sessions/${id}`);
      if (!r.ok) return;
      const d = await r.json();
      setCurrentSessionId(id);
      setShop(d.shop || "");
      // ⚡ reset handoff state เมื่อเปลี่ยน session
      setHandedOff(false);
      setAssignedAdmin(null);
      setAssignedAdminName(null);
      setAssignmentReason(null);
      setSessionStatus(null);
      // ⚡ เคลียร์ buffer state เมื่อเปลี่ยน session (กันข้อความ session เก่า ปน session ใหม่)
      if (bufferTimerRef.current) {
        clearTimeout(bufferTimerRef.current);
        bufferTimerRef.current = null;
      }
      bufferedMessagesRef.current = [];
      bufferedImagesRef.current = [];  // ⚡ Phase 1F
      bufferSpinnerIdRef.current = null;
      setIsBuffering(false);
      setBufferedCount(0);
      // ⚡ ถ้า session มี assigned_to อยู่แล้ว → ตั้ง handedOff
      if (d.assigned_to) {
        setHandedOff(true);
        setAssignedAdmin(d.assigned_to);
        setAssignedAdminName(d.assigned_to_name || null);
        setAssignmentReason(d.assignment_reason || null);
      }
      // ⚡ Phase 2A — เก็บ session status จาก DB (open|closed)
      setSessionStatus(d.status || null);
      const loadedMsgs: Msg[] = [];
      // ⚡ A2 — hist รวม image_desc ด้วย (ถ้ามีใน session)
      let hist: { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[] = [];
      let tot = { turns: 0, elapsed: 0, prompt: 0, output: 0, total: 0, cost: 0, wsTurns: 0, wsCost: 0, wsTokens: 0 };
      for (const m of d.messages || []) {
        const msgIdx = loadedMsgs.length;  // track array index in session
        if (m.role === "user") {
          // ⚡ Phase 1F — render รูปจาก m.images ตอน reload (ไม่ใช่ escapeHtml ทั้งหมด)
          const userImages: string[] = Array.isArray(m.images) ? m.images : [];
          const imageHtml = userImages.length > 0
            ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${userImages.map((url) =>
                url.match(/\.(mp4|webm|mov)$/i)
                  ? `<div style="position:relative;width:80px;height:80px;border-radius:6px;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center"><span style="font-size:24px">🎬</span></div>`
                  : `<img src="${escapeHtml(url)}" alt="รูปที่ส่ง" onerror="this.remove()" style="width:80px;height:80px;object-fit:cover;border-radius:6px" />`
              ).join("")}</div>`
            : "";
          loadedMsgs.push({ id: msgIdCounter++, role: "user", html: escapeHtml(m.text) + imageHtml, raw: m.text, sessionMsgIndex: msgIdx, timestamp: m.created_at || m.timestamp });
          hist.push({
            role: "user",
            text: m.text,
            ...(userImages.length > 0 ? { images: userImages } : {}),
            ...(m.image_desc ? { image_desc: String(m.image_desc) } : {}),
          });
        } else if (m.role === "model") {
          // ⚡ Multi-bubble — split คำตอบด้วย ||| เหมือนตอนส่งใหม่
          const segments = splitAnswerSegments(m.text);
          const bubbles = segments.length > 0 ? segments : [m.text];
          const groupStats = m.stats || {};
          // segment แรก → มี stats (สำหรับ stats panel)
          loadedMsgs.push({
            id: msgIdCounter++,
            role: "bot",
            html: formatAnswer(bubbles[0]),
            raw: bubbles[0],
            stats: groupStats,
            timestamp: m.created_at || m.timestamp,
          });
          // segment ถัดไป → bubble ใหม่ (ไม่มี stats ซ้ำ)
          for (let si = 1; si < bubbles.length; si++) {
            const isLast = si === bubbles.length - 1;
            loadedMsgs.push({
              id: msgIdCounter++,
              role: "bot",
              html: formatAnswer(bubbles[si]),
              raw: bubbles[si],
              timestamp: m.created_at || m.timestamp,
              // ⚡ segment สุดท้าย → มี sessionMsgIndex + stats (สำหรับ RateBox)
              ...(isLast ? { isGroupLast: true, sessionMsgIndex: msgIdx, stats: groupStats } : {}),
            });
          }
          // ⚡ ถ้ามี segment เดียว → มันคือ first และ last พร้อมกัน
          if (bubbles.length === 1) {
            loadedMsgs[loadedMsgs.length - 1].isGroupLast = true;
            loadedMsgs[loadedMsgs.length - 1].sessionMsgIndex = msgIdx;
          }
          hist.push({ role: "model", text: m.text });
          const s = m.stats || {};
          tot.turns++;
          tot.elapsed += s.elapsed || 0;
          tot.prompt += s.usage?.prompt || 0;
          tot.output += s.usage?.output || 0;
          tot.total += s.usage?.total || 0;
          tot.cost += s.cost || 0;
          if (s.web_search_used) { tot.wsTurns++; tot.wsCost += s.cost || 0; tot.wsTokens += s.usage?.total || 0; }
        }
      }
      historyRef.current = hist;
      setMessages(loadedMsgs.length > 0 ? loadedMsgs : [{
        id: msgIdCounter++, role: "sys", html: `พิมพ์คำถามด้านล่างเพื่อทดสอบบอท${meta.label}`,
      }]);
      setTotals(tot);
      // ⚡ โหลด ratings จาก Next.js admin mongo แล้ว merge เข้า messages
      loadSessionRatings(id);
    } catch {
      toast.error("โหลดแชทไม่สำเร็จ");
    }
  }

  async function deleteSession(id: string) {
    if (!(await confirm.ask({ title: "ลบแชทนี้?", message: "ลบประวัติแชททดสอบถาวร", variant: "danger", confirmText: "ลบ" }))) return;
    try {
      await fetch(`/api/chatbot/${platform}/test-chat/sessions/${id}`, { method: "DELETE" });
      if (currentSessionId === id) {
        setCurrentSessionId(null);
        setMessages([{ id: msgIdCounter++, role: "sys", html: `พิมพ์คำถามด้านล่างเพื่อทดสอบบอท${meta.label}` }]);
        historyRef.current = [];
      }
      await loadSessions();
    } catch {
      toast.error("ลบแชทไม่สำเร็จ");
    }
  }

  async function saveMessageToSession(role: "user" | "model", text: string, stats?: MsgStats, images?: string[]) {
    if (!currentSessionId) return;
    try {
      // คำนวณ index ของ message ใหม่ใน array (ก่อน push)
      const msgIndex = messages.filter(m => m.role !== "sys").length;
      await fetch(`/api/chatbot/${platform}/test-chat/sessions/${currentSessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: currentSessionId,
          message: { role, text, stats: stats || {}, ...(images && images.length > 0 ? { images } : {}) },
        }),
      });
      // track sessionMsgIndex ใน local state — เฉพาะ groupLast (bubble สุดท้ายของกลุ่ม)
      setMessages(prev => prev.map(m =>
        m.role === "bot" && m.isGroupLast && !m.sessionMsgIndex ? { ...m, sessionMsgIndex: msgIndex } : m
      ));
      loadSessions(); // refresh sidebar
    } catch {
      toast.error("บันทึกข้อความไม่สำเร็จ");
    }
  }

  // ── Rate a bot message (star + comment + rating) ──
  // ⚡ เก็บใน Next.js admin mongo (test_chat_ratings) — ไม่ยุ่งกับ Python
  async function rateMessage(msgId: number, opts: { star?: number; comment?: string; rating?: "good" | "bad" | "unrated" }) {
    const msg = messages.find(m => m.id === msgId);
    if (!msg || !currentSessionId || msg.sessionMsgIndex == null) return;
    try {
      const s = msg.stats || {};
      await fetch(`/api/test-chat-ratings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: currentSessionId,
          msg_index: msg.sessionMsgIndex,
          platform: platform,
          shop: shop || "",
          star_rating: opts.star,
          rating: opts.rating,
          comment: opts.comment,
          msg_text_preview: (msg.raw || "").slice(0, 200),
          msg_stats: {
            elapsed: s.elapsed,
            cost: s.cost,
            tokens_total: s.usage?.total,
            tokens_prompt: s.usage?.prompt,
            tokens_output: s.usage?.output,
            model: s.model,
            source: s.source,
            intent: s.intent?.intent,
            web_search_used: s.web_search_used,
            handoff_to_admin: s.handoff_to_admin,
          },
        }),
      });
      // update local state
      setMessages(prev => prev.map(m =>
        m.id === msgId ? {
          ...m,
          stats: {
            ...m.stats,
            star_rating: opts.star !== undefined ? opts.star : m.stats?.star_rating,
            comment: opts.comment !== undefined ? opts.comment : m.stats?.comment,
            rating: opts.rating !== undefined ? opts.rating : m.stats?.rating,
          }
        } : m
      ));
      loadAllStats();
    } catch {
      toast.error("บันทึกคะแนนไม่สำเร็จ");
    }
  }

  // ── Load all-sessions stats (จาก Next.js) ──
  async function loadAllStats() {
    try {
      const r = await fetch(`/api/test-chat-ratings?mode=stats`);
      if (r.ok) setAllStats(await r.json());
    } catch {
      toast.error("โหลดสถิติไม่สำเร็จ");
    }
  }

  // ── Load test chat action logs (จาก Python ผ่าน proxy) ──
  // ⚡ Phase 3 — ประวัติการใช้งาน: ใคร ทำอะไร แชทไหน เมื่อไหร่
  const [actionLogs, setActionLogs] = useState<Array<{
    id: string;
    action: string;
    session_id: string | null;
    admin_id: string;
    admin_name: string;
    shop?: string;
    timestamp: string;
    role?: string;
    text_preview?: string;
    title?: string;
    [k: string]: unknown;
  }>>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsScope, setLogsScope] = useState<"me" | "all">("me");

  async function loadActionLogs() {
    setLogsLoading(true);
    try {
      const scope = logsScope === "all" ? "all" : "";
      const url = `/api/chatbot/${platform}/test-chat/logs?limit=200${scope ? `&admin_id=${scope}` : ""}`;
      const r = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        setActionLogs(d.logs || []);
      }
    } catch {
      toast.error("โหลด log ไม่สำเร็จ");
    } finally {
      setLogsLoading(false);
    }
  }

  // ── Load ratings ของ session นี้ แล้ว merge เข้า messages ──
  async function loadSessionRatings(sessionId: string) {
    try {
      const r = await fetch(`/api/test-chat-ratings?session_id=${sessionId}`);
      if (!r.ok) return;
      const d = await r.json();
      const ratings: Array<{
        msg_index: number;
        star_rating?: number;
        rating?: "good" | "bad" | "unrated";
        comment?: string;
      }> = d.ratings || [];
      const byIdx = new Map(ratings.map(rt => [rt.msg_index, rt]));
      setMessages(prev => prev.map(m => {
        if (m.sessionMsgIndex == null) return m;
        const rt = byIdx.get(m.sessionMsgIndex);
        if (!rt) return m;
        return {
          ...m,
          stats: {
            ...m.stats,
            star_rating: rt.star_rating ?? m.stats?.star_rating,
            rating: rt.rating ?? m.stats?.rating,
            comment: rt.comment ?? m.stats?.comment,
          },
        };
      }));
    } catch {
      toast.error("โหลดคะแนนไม่สำเร็จ");
    }
  }

  // ⚡ อัปเดต shop ของ session ใน DB (เมื่อผู้ใช้เปลี่ยนร้านในแชทที่มีอยู่)
  async function updateSessionShop(sessionId: string, newShop: string) {
    try {
      await fetch(`/api/chatbot/${platform}/test-chat/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: newShop }),
      });
      loadSessions(); // refresh sidebar
    } catch {
      toast.error("อัปเดตร้านไม่สำเร็จ");
    }
  }

  // ⚡ อัปเดต title ของ session ใน DB (แก้ชื่อแชท)
  async function updateSessionTitle(sessionId: string, newTitle: string) {
    try {
      await fetch(`/api/chatbot/${platform}/test-chat/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
      loadSessions(); // refresh sidebar
    } catch {
      toast.error("อัปเดตชื่อแชทไม่สำเร็จ");
    }
  }

  useEffect(() => {
    fetch("/api/chatbot/shops")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setShops(d.shops || []))
      .catch(() => setShops([]));
    loadSessions();
    loadAllStats();
    // ⚡ โหลด buffer config จาก system config
    fetch("/api/test-chat/buffer-status")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setBufferConfig({ enabled: d.buffer_enabled, window_ms: d.buffer_window_ms, max_messages: d.buffer_max_messages }))
      .catch(() => setBufferConfig({ enabled: false, window_ms: 6000, max_messages: 5 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⚡ Phase 2E — โหลด quick replies เมื่อ shop เปลี่ยน (กรองตาม platform + shop + enabled)
  useEffect(() => {
    if (!shop) { setQuickReplies([]); return; }
    quickReplyService.list({ platform, shop_id: shop, enabled_only: "1" })
      .then((rows) => setQuickReplies(rows))
      .catch(() => setQuickReplies([]));
  }, [shop]);

  // ⚡ ไม่ต้อง reload sessions เมื่อเปลี่ยนร้าน — โหลดทุกร้านแล้ว ใช้ filter ใน frontend

  useEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [messages]);

  function sendFeedback(answerText: string, rating: "up" | "down" | "clear") {
    try {
      fetch("/api/chatbot/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: answerText.slice(0, 500), rating }),
      }).catch(() => {});
    } catch {
      toast.error("ส่งฟีดแบ็กไม่สำเร็จ");
    }
  }

  // ⚡ Phase 1F — image upload handler
  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch("/api/test-chat/upload", { method: "POST", body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) {
          toast.error(j.error || `อัปโหลดล้มเหลว (${r.status})`);
          continue;
        }
        setPendingImages((prev) => [...prev, { url: j.url, type: j.content_type || "image/jpeg", name: j.filename || "upload" }]);
      }
    } catch (err) {
      toast.error("อัปโหลดล้มเหลว — กรุณาลองใหม่");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removePendingImage(idx: number) {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
  }

  async function send(e?: FormEvent, overrideMessage?: string) {
    e?.preventDefault();
    const message = (overrideMessage ?? input).trim();
    const images = [...pendingImages];
    if ((!message && images.length === 0) || sending) return;
    // ⚡ ถ้า handedOff แล้ว — บอทไม่ตอบ ให้กดปุ่มปิดแชทก่อน
    if (handedOff) {
      toast.info("แชทถูกส่งต่อแอดมินแล้ว — กด 'ปิดแชท (ให้บอทตอบต่อ)' เพื่อคุยกับบอทอีกครั้ง");
      return;
    }
    setInput("");
    setPendingImages([]);
    // ⚡ reset textarea height หลังส่ง
    if (inputRef.current) inputRef.current.style.height = "auto";

    // ⚡ Phase 1F — สร้าง user message bubble (รวมรูป preview)
    const imagePreviewHtml = images.length > 0
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${images.map((img) =>
          img.type.startsWith("video/")
            ? `<div style="position:relative;width:80px;height:80px;border-radius:6px;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center"><span style="font-size:24px">🎬</span></div>`
            : `<img src="${escapeHtml(img.url)}" alt="รูปที่ส่ง" onerror="this.remove()" style="width:80px;height:80px;object-fit:cover;border-radius:6px" />`
        ).join("")}</div>`
      : "";
    const userMsg: Msg = {
      id: msgIdCounter++,
      role: "user",
      html: (message ? escapeHtml(message) : "") + imagePreviewHtml,
      timestamp: new Date().toISOString(),
    };

    // ⚡ Buffer mode — ใช้ระบบ buffer เหมือนลูกค้าจริง
    // ถ้า buffer เปิดอยู่และมี session → เข้า buffer flow (ไม่ส่ง bot ทันที)
    // ⚡ สำคัญ: buffer mode ไม่ล็อค input — ให้พิมพ์ต่อได้เลย
    if (bufferConfig?.enabled && currentSessionId) {
      // เก็บ message ไว้ใน buffer ref (ยังไม่ push ลง historyRef — จะใส่ combined ตอน flush)
      bufferedMessagesRef.current.push(message);
      // ⚡ Phase 1F — เก็บ images ด้วย
      if (images.length > 0) {
        const origin = window.location.origin;
        for (const img of images) {
          const absUrl = img.url.startsWith("http") ? img.url : `${origin}${img.url}`;
          if (!bufferedImagesRef.current.includes(absUrl)) bufferedImagesRef.current.push(absUrl);
        }
      }
      // ⚡ Phase 1F — save พร้อม images (สำหรับ reload)
      const savedImages = images.length > 0
        ? images.map((img) => img.url.startsWith("http") ? img.url : `${window.location.origin}${img.url}`)
        : undefined;
      saveMessageToSession("user", message, undefined, savedImages);

      // ⚡ แทรก user msg ก่อน spinner (ถ้ามี) — ไม่งั้น b2 จะไปอยู่หลัง spinner
      // ตอนสด: [b1, spinner, b2] ← ผิด → แก้เป็น [b1, b2, spinner] ← ถูก
      const spinnerId = bufferSpinnerIdRef.current;
      if (spinnerId !== null) {
        setMessages((prev) => {
          const spinnerIdx = prev.findIndex((m) => m.id === spinnerId);
          if (spinnerIdx === -1) return [...prev, userMsg];
          const next = [...prev];
          next.splice(spinnerIdx, 0, userMsg);
          return next;
        });
      } else {
        setMessages((prev) => [...prev, userMsg]);
      }

      // สร้าง/อัปเดต buffering indicator
      if (bufferSpinnerIdRef.current === null) {
        const bufMsg: Msg = {
          id: msgIdCounter++,
          role: "bot",
          html: `<div style="color:var(--color-info);font-size:13px">⏳ <span class="tc-spinner"></span>กำลัง buffer ข้อความ... (1 ข้อความ)</div>`,
          timestamp: new Date().toISOString(),
        };
        bufferSpinnerIdRef.current = bufMsg.id;
        setMessages((prev) => [...prev, bufMsg]);
      } else {
        const count = bufferedMessagesRef.current.length;
        setMessages((prev) => prev.map((m) => m.id === bufferSpinnerIdRef.current ? {
          ...m,
          html: `<div style="color:var(--color-info);font-size:13px">⏳ <span class="tc-spinner"></span>กำลัง buffer ข้อความ... (${count} ข้อความ)</div>`,
        } : m));
      }

      // ส่งไป buffer endpoint
      try {
        const br = await fetch("/api/test-chat/buffer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: currentSessionId,
            message,
            shop,
            platform,
            images: images.map((i) => i.url),  // ⚡ Phase 1F — ส่ง image URLs
            media_types: images.map((i) => i.type),  // ⚡ content types สำหรับ detect video (upload URL ไม่มี extension)
          }),
        });
        const bj = await br.json().catch(() => ({}));

        if (bj.status === "buffer_disabled") {
          // buffer ถูกปิดระหว่างทาง → flush ทันที
          await flushBuffer();
          return;
        }

        setBufferedCount(bj.buffered_count || bufferedMessagesRef.current.length);
        setIsBuffering(true);

        // ถ้าครบ max → flush ทันที
        if (bj.should_flush) {
          await flushBuffer();
          return;
        }

        // รีเซ็ต debounce timer
        if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
        bufferTimerRef.current = setTimeout(() => {
          flushBuffer();
        }, bufferConfig.window_ms);

        // ⚡ ไม่ setSending(false) เพราะไม่ได้ set true ใน buffer mode
        // input ไม่ถูกล็อค → พิมพ์ต่อได้เลย
      } catch (err) {
        console.error("[buffer] send error:", err);
        await flushBuffer();
      }
      return;
    }

    // ── Normal flow (ไม่มี buffer) — ส่ง bot ทันทีเหมือนเดิม ──
    setSending(true); // ⚡ ล็อค input เฉพาะ normal mode (รอ bot ตอบ)
    // ⚡ แสดง user message ทันทีก่อนสร้าง spinner — ไม่งั้นต้องรีเฟรชหน้าถึงจะเห็น
    setMessages((prev) => [...prev, userMsg]);
    const spinnerMsg: Msg = { id: msgIdCounter++, role: "bot", html: '<span class="tc-spinner"></span>กำลังคิด...', timestamp: new Date().toISOString() };
    setMessages((prev) => [...prev, spinnerMsg]);
    // ⚡ A2 — ส่ง image_desc ใน history ด้วย เพื่อให้ bot ใช้ cached description ไม่ re-read รูปเก่า
    const priorHistory = historyRef.current.slice(-10).map((h) => ({
      role: h.role,
      text: h.text,
      ...(h.images ? { images: h.images } : {}),
      ...(h.image_desc ? { image_desc: h.image_desc } : {}),
    }));
    historyRef.current.push({ role: "user", text: message, ...(images.length > 0 ? { images: images.map((i) => i.url.startsWith("http") ? i.url : `${window.location.origin}${i.url}`) } : {}) });
    // ⚡ Phase 1F — save พร้อม images (สำหรับ reload)
    const directImages = images.length > 0
      ? images.map((i) => i.url.startsWith("http") ? i.url : `${window.location.origin}${i.url}`)
      : undefined;
    saveMessageToSession("user", message, undefined, directImages);

    try {
      // ⚡ Step 1: Check trigger ก่อน (เหมือน bot-worker)
      let triggerMatched: { name: string; action: string; bot_template?: string; topic?: string } | null = null;
      try {
        const tr = await fetch("/api/triggers/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, shop_id: shop, platform }),
        });
        const tj = await tr.json().catch(() => ({}));
        console.log("[TRIGGER-CHECK] response:", tr.status, tj);
        if (tj?.matched && tj?.trigger) {
          triggerMatched = tj.trigger;
          toast.info(`⚡ trigger: ${tj.trigger.name} → ${tj.trigger.action}`);
        }
      } catch (err) {
        console.error("[TRIGGER-CHECK] error:", err);
      }

      // ⚡ Step 2: ถ้า trigger action = handoff_admin → ส่งต่อแอดมินเลย ไม่เรียก bot
      if (triggerMatched && triggerMatched.action === "handoff_admin") {
        // เรียก handoff API (simulate mode)
        let adminName = "";
        let assignReason = triggerMatched.name;
        if (currentSessionId) {
          try {
            const hr = await fetch("/api/admin/conversations/bot-handoff", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                conversation_id: currentSessionId,
                shop_id: shop,
                platform,
                reason: triggerMatched.name,
                simulate: true,
              }),
            });
            const hj = await hr.json().catch(() => ({}));
            if (hj?.assigned_to_name) adminName = hj.assigned_to_name;
            if (hj?.assignment_reason) assignReason = hj.assignment_reason;
          } catch (e) { console.error("[HANDOFF] admin fetch failed:", e); }
        }
        const handoffText = `🔀 ส่งต่อแอดมิน${adminName ? `: ${adminName}` : ""}\nเหตุผล: ${assignReason}`;
        setHandedOff(true);
        setAssignedAdmin(null);
        setAssignedAdminName(adminName || null);
        setAssignmentReason(assignReason);
        toast.success(handoffText);
        setMessages((prev) =>
          prev.map((m) => (m.id === spinnerMsg.id ? {
            ...m,
            html: `<div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:8px;padding:8px 12px;color:var(--color-info);font-size:13px">⚡ trigger: ${escapeHtml(triggerMatched!.name)} → 🔀 ส่งต่อแอดมิน${adminName ? `: <b>${escapeHtml(adminName)}</b>` : ""}<br><span style="font-size:11px;opacity:0.7">เหตุผล: ${escapeHtml(assignReason)}</span></div>`,
            stats: {
              source: "trigger_handoff",
              handoff_to_admin: true,
              handoff_reason: assignReason,
              routing_decision: { path: "handoff", trigger_matched: triggerMatched.name, assigned_admin_name: adminName },
            } as MsgStats,
            isGroupLast: true,
          } : m))
        );
        historyRef.current.push({ role: "model", text: handoffText });
        saveMessageToSession("model", handoffText);
        setSending(false);
        return;
      }

      // ⚡ Step 3: ถ้า trigger action = bot_answer และมี bot_template → ใช้ template ตอบเลย ไม่เรียก bot
      if (triggerMatched && triggerMatched.action === "bot_answer" && triggerMatched.bot_template) {
        const templateText = triggerMatched.bot_template;
        const segments = splitAnswerSegments(templateText);
        const bubbles = segments.length > 0 ? segments : [templateText];
        historyRef.current.push({ role: "model", text: templateText });
        const stats: MsgStats = {
          source: "trigger_bot_answer",
          routing_decision: { path: "bot_reply", trigger_matched: triggerMatched.name },
        };
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((m) => m.id === spinnerMsg.id);
          if (idx === -1) return prev;
          next[idx] = {
            ...next[idx],
            html: formatAnswer(bubbles[0]),
            raw: bubbles[0],
            stats,
            ...(bubbles.length === 1 ? { isGroupLast: true } : {}),
          };
          const extraMsgs: Msg[] = bubbles.slice(1).map((seg, si) => ({
            id: msgIdCounter++,
            role: "bot",
            html: formatAnswer(seg),
            raw: seg,
            stats,
            ...(si === bubbles.length - 2 ? { isGroupLast: true } : {}),
          }));
          return [...next, ...extraMsgs];
        });
        saveMessageToSession("model", templateText, stats);
        setSending(false);
        return;
      }

      // ⚡ Step 4: ปกติ — ส่งให้ bot
      const payload: Record<string, unknown> = { message, limit, history: priorHistory };
      if (shop) payload.shop = shop;
      // ⚡ ส่ง conversation_id (ใช้ session_id) + simulate_assignment เพื่อจำลองการจ่ายงาน
      if (currentSessionId) {
        payload.conversation_id = currentSessionId;
        payload.simulate_assignment = true;
      }
      // ⚡ Phase 2A — ส่ง ticket_state ให้บอท (state-driven handoff reset)
      if (sessionStatus) {
        payload.ticket_state = sessionStatus;
      }
      // ⚡ Phase 1F — ส่ง images ให้ bot (แปลง URL สัมพันธ์เป็น absolute)
      if (images.length > 0) {
        const origin = window.location.origin;
        payload.images = images.map((i) => (i.url.startsWith("http") ? i.url : `${origin}${i.url}`));
      }
      const r = await fetch("/api/chatbot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const errText = `เกิดข้อผิดพลาด (${r.status}): ${j.detail || j.error || r.statusText || "ไม่ทราบสาเหตุ"}`;
        setMessages((prev) =>
          prev.map((m) => (m.id === spinnerMsg.id ? { ...m, html: `<span style="color:var(--color-error-soft)">${escapeHtml(errText)}</span>` } : m))
        );
        return;
      }
      const answerText = j.answer || "(ไม่มีคำตอบ)";
      // ⚡ A2 — cache image_desc ที่ bot คืนกลับมา ลง history entry ล่าสุด (user message)
      //   ทำให้ turn ถัดไปส่ง image_desc ใน history → bot ไม่ต้อง re-read รูปซ้ำ
      if (j.image_desc && historyRef.current.length > 0) {
        const lastIdx = historyRef.current.length - 1;
        if (historyRef.current[lastIdx].role === "user") {
          historyRef.current[lastIdx].image_desc = String(j.image_desc);
        }
      }
      // ⚡ Multi-bubble — bot แบ่งคำตอบด้วย ||| (หรือ answer_segments จาก Python)
      // split เป็นหลาย segment แล้วสร้างหลาย message (แทนที่ spinnerMsg ด้วย segment แรก + เพิ่มที่เหลือ)
      const segments: string[] = Array.isArray(j.answer_segments) && j.answer_segments.length > 0
        ? j.answer_segments.map((s: string) => String(s).trim()).filter((s: string) => s.length > 0)
        : splitAnswerSegments(answerText);
      const bubbles = segments.length > 0 ? segments : [answerText];
      historyRef.current.push({ role: "model", text: answerText });
      setLastProducts(j.products || []);
      const stats: MsgStats = {
        elapsed: typeof j.elapsed === "number" ? j.elapsed : undefined,
        usage: j.usage || undefined,
        cost: typeof j.cost === "number" ? j.cost : undefined,
        model: j.model,
        source: j.source,
        intent: j.intent || undefined,
        timing: j.timing || undefined,
        retrieval_info: j.retrieval_info || undefined,
        web_search_used: j.web_search_used === true,
        web_search_reason: j.web_search_reason || undefined,
        web_search_model: j.web_search_model || undefined,
        steps: Array.isArray(j.steps) ? j.steps : undefined,
        handoff_to_admin: j.handoff_to_admin === true,
        handoff_reason: j.handoff_reason || undefined,
        routing_decision: j.routing_decision || undefined,
      };
      // ⚡ เด้ง toast แจ้ง handoff + ตั้ง handedOff state
      if (stats.handoff_to_admin) {
        const adminName = (stats.routing_decision?.assigned_admin_name as string) || (stats.routing_decision?.assigned_admin as string) || null;
        const reason = stats.handoff_reason || "unknown";
        setHandedOff(true);
        setAssignedAdmin(stats.routing_decision?.assigned_admin as string || null);
        setAssignedAdminName(adminName);
        setAssignmentReason(reason);
        toast.success(`🔀 ส่งต่อแอดมิน${adminName ? `: ${adminName}` : ""}\nเหตุผล: ${reason}`);
      } else if (stats.routing_decision?.trigger_matched) {
        toast.info(`⚡ trigger: ${stats.routing_decision.trigger_matched}`);
      }
      setTotals((t) => ({
        turns: t.turns + 1,
        elapsed: t.elapsed + (stats.elapsed || 0),
        prompt: t.prompt + (stats.usage?.prompt || 0),
        output: t.output + (stats.usage?.output || 0),
        total: t.total + (stats.usage?.total || 0),
        cost: t.cost + (stats.cost || 0),
        wsTurns: t.wsTurns + (stats.web_search_used ? 1 : 0),
        wsCost: t.wsCost + (stats.web_search_used ? (stats.cost || 0) : 0),
        wsTokens: t.wsTokens + (stats.web_search_used ? (stats.usage?.total || 0) : 0),
      }));
      // segment แรก → แทนที่ spinnerMsg (มี stats + products สำหรับ stats panel)
      // segment สุดท้าย → มี sessionMsgIndex + isGroupLast (สำหรับ RateBox)
      setMessages((prev) => {
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === spinnerMsg.id);
        if (idx === -1) return prev;
        // แทนที่ spinner ด้วย segment แรก (พร้อม stats + products)
        next[idx] = {
          ...next[idx],
          html: formatAnswer(bubbles[0]),
          raw: bubbles[0],
          products: j.products || [],
          stats,
          // ⚡ ถ้ามี segment เดียว → เป็น first และ last พร้อมกัน
          ...(bubbles.length === 1 ? { isGroupLast: true } : {}),
        };
        // เพิ่ม segment ถัดไปเป็น bubble ใหม่
        const extraMsgs: Msg[] = bubbles.slice(1).map((seg, si) => {
          const isLast = si === bubbles.length - 2; // si เริ่มจาก 0 สำหรับ segment 1
          return {
            id: msgIdCounter++,
            role: "bot",
            html: formatAnswer(seg),
            raw: seg,
            // ⚡ segment สุดท้าย → มี stats + isGroupLast (สำหรับ RateBox)
            ...(isLast ? { isGroupLast: true, stats } : {}),
          } as Msg;
        });
        next.splice(idx + 1, 0, ...extraMsgs);
        return next;
      });
      // save bot response to session
      saveMessageToSession("model", answerText, stats);
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === spinnerMsg.id ? { ...m, html: '<span style="color:var(--color-error-soft)">เกิดข้อผิดพลาดในการเชื่อมต่อ server</span>' } : m
        )
      );
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  // ── Flush buffer — รวมข้อความที่ buffer ไว้ → ส่ง bot → แสดงคำตอบ ──
  async function flushBuffer() {
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }

    const spinnerId = bufferSpinnerIdRef.current;
    const msgs = bufferedMessagesRef.current;
    if (msgs.length === 0) {
      if (spinnerId !== null) {
        setMessages((prev) => prev.filter((m) => m.id !== spinnerId));
      }
      bufferSpinnerIdRef.current = null;
      setIsBuffering(false);
      setBufferedCount(0);
      setSending(false);
      return;
    }

    const combinedText = msgs.join(" ");
    const flushedImages = [...bufferedImagesRef.current];  // ⚡ เก็บก่อน clear
    bufferedMessagesRef.current = [];
    bufferedImagesRef.current = [];  // ⚡ Phase 1F — clear หลัง flush
    setSending(true);

    // เปลี่ยน spinner เป็น "กำลังคิด..."
    if (spinnerId !== null) {
      setMessages((prev) => prev.map((m) => m.id === spinnerId ? {
        ...m,
        html: `<span class="tc-spinner"></span>กำลังคิด... (รวม ${msgs.length} ข้อความ)`,
      } : m));
    }

    // ⚡ A2 — ส่ง image_desc ใน history ด้วย เพื่อให้ bot ใช้ cached description ไม่ re-read รูปเก่า
    const priorHistory = historyRef.current.slice(-10).map((h) => ({
      role: h.role,
      text: h.text,
      ...(h.images ? { images: h.images } : {}),
      ...(h.image_desc ? { image_desc: h.image_desc } : {}),
    }));

    // ⚡ Workflow step helper — เรียก workflow engine (เหมือน bot-worker ①②) แล้วจัดการผล
    // phase "entry" = จุดเริ่ม (resume + workflow_first/both) / "after_trigger" = trigger ไม่ match (trigger_first)
    // return true = workflow จัดการแล้ว (จบ flow นี้) / false = ไป trigger/bot ตามเดิม
    const runWorkflowStep = async (phase: "entry" | "after_trigger"): Promise<boolean> => {
      try {
        const wsRes = await fetch("/api/test-chat/workflow-step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: currentSessionId,
            message: combinedText,
            shop,
            platform,
            history: priorHistory,
            phase,
          }),
        });
        const ws = await wsRes.json().catch(() => ({}));

        if (ws.status === "workflow_actioned" || ws.status === "workflow_resumed") {
          const flowMsgs: { text: string; source: string }[] = Array.isArray(ws.messages) ? ws.messages : [];
          // ⚡ workflow handoff (assign_ticket action) → แสดงสถานะส่งต่อ
          if (ws.handoff && ws.handoff.agentId) {
            const agentName = ws.handoff.agentId;
            const handoffReason = ws.handoff.reason || "workflow assign_ticket";
            setHandedOff(true);
            setAssignedAdminName(agentName);
            setAssignmentReason(handoffReason);
            toast.success(`🔀 workflow จ่ายงานให้: ${agentName}`);
          }
          // render delivered messages ของ flow (แบบเดียวกับ template — split + format)
          historyRef.current.push({ role: "user", text: combinedText, ...(bufferedImagesRef.current.length > 0 ? { images: [...bufferedImagesRef.current] } : {}) });
          if (flowMsgs.length === 0) {
            // flow ทำ action แต่ไม่มี message (เช่น assign อย่างเดียว) → แสดง status box
            historyRef.current.push({ role: "model", text: `⚙️ workflow: ${ws.detail}` });
            setMessages((prev) => prev.map((m) => m.id === spinnerId ? {
              ...m,
              html: `<div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:8px;padding:8px 12px;color:var(--color-info);font-size:13px">🔀 workflow: ${escapeHtml(ws.detail || "")}</div>`,
              stats: { source: "workflow_action" } as MsgStats,
              isGroupLast: true,
            } : m));
            saveMessageToSession("model", `⚙️ workflow: ${ws.detail}`);
          } else {
            for (const fm of flowMsgs) historyRef.current.push({ role: "model", text: fm.text });
            let firstRendered = false;
            setMessages((prev) => {
              let next = [...prev];
              for (const fm of flowMsgs) {
                const segs = splitAnswerSegments(fm.text);
                const bubbles = segs.length > 0 ? segs : [fm.text];
                const stats: MsgStats = { source: fm.source || "workflow" };
                if (!firstRendered) {
                  // message แรก → แทนที่ spinner
                  const idx = next.findIndex((m) => m.id === spinnerId);
                  if (idx !== -1) {
                    next[idx] = { ...next[idx], html: formatAnswer(bubbles[0]), raw: bubbles[0], stats, ...(bubbles.length === 1 ? { isGroupLast: true } : {}) };
                    firstRendered = true;
                  }
                  const extraMsgs: Msg[] = bubbles.slice(1).map((seg, si) => ({
                    id: msgIdCounter++, role: "bot", html: formatAnswer(seg), raw: seg, stats,
                    ...(si === bubbles.length - 2 ? { isGroupLast: true } : {}),
                  }));
                  next = [...next, ...extraMsgs];
                } else {
                  const extraMsgs: Msg[] = bubbles.map((seg, si) => ({
                    id: msgIdCounter++, role: "bot", html: formatAnswer(seg), raw: seg, stats,
                    ...(si === bubbles.length - 1 ? { isGroupLast: true } : {}),
                  }));
                  next = [...next, ...extraMsgs];
                }
              }
              // ถ้า spinner ยังไม่ถูกแทนที่ (firstRendered=false ไม่ได้เกิด) → ลบทิ้ง
              if (!firstRendered && spinnerId !== null) next = next.filter((m) => m.id !== spinnerId);
              return next;
            });
            for (const fm of flowMsgs) saveMessageToSession("model", fm.text);
          }
          toast.info(`🔀 workflow: ${ws.detail}`);
          bufferSpinnerIdRef.current = null;
          setIsBuffering(false);
          setBufferedCount(0);
          setSending(false);
          return true; // workflow จัดการแล้ว — ไม่ไป trigger/bot
        }

        if (ws.status === "exit_drop") {
          // flow cancel + ทิ้งข้อความ → แสดง hint แล้วจบ (ลูกค้าต้องพิมพ์ใหม่)
          setMessages((prev) => prev.map((m) => m.id === spinnerId ? {
            ...m,
            html: `<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:8px 12px;color:var(--color-error);font-size:13px">⛔ workflow: condition ไม่ผ่าน (exit_drop) — รบกวนพิมพ์ใหม่อีกครั้งนะคะ</div>`,
            isGroupLast: true,
          } : m));
          toast.info(`⛔ workflow exit_drop: ${ws.detail}`);
          bufferSpinnerIdRef.current = null;
          setIsBuffering(false);
          setBufferedCount(0);
          setSending(false);
          return true;
        }

        // no_workflow → ไป trigger/bot ตามเดิม
        return false;
      } catch (err) {
        console.error("[WORKFLOW-STEP] error:", err);
        return false; // fail-safe → ไป trigger/bot ตามเดิม
      }
    };

    try {
      // ⚡ ① Workflow step (entry) — resume active flow + workflow_first/both priority
      // server เป็นคนตัดสิน priority (trigger_first จะตอบ no_workflow ทันทีใน phase entry)
      if (await runWorkflowStep("entry")) return;

      // ⚡ Check trigger บน combined message (เหมือน bot-worker ตอน flush)
      let triggerMatched: { name: string; action: string; bot_template?: string; topic?: string } | null = null;
      try {
        const tr = await fetch("/api/triggers/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: combinedText, shop_id: shop, platform }),
        });
        const tj = await tr.json().catch(() => ({}));
        if (tj?.matched && tj?.trigger) {
          triggerMatched = tj.trigger;
          toast.info(`⚡ trigger: ${tj.trigger.name} → ${tj.trigger.action} (จาก ${msgs.length} ข้อความรวม)`);
        }
      } catch (err) {
        console.error("[TRIGGER-CHECK] error:", err);
      }

      // ⚡ trigger handoff_admin → ส่งต่อแอดมิน
      if (triggerMatched && triggerMatched.action === "handoff_admin") {
        let adminName = "";
        let assignReason = triggerMatched.name;
        if (currentSessionId) {
          try {
            const hr = await fetch("/api/admin/conversations/bot-handoff", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                conversation_id: currentSessionId,
                shop_id: shop,
                platform,
                reason: triggerMatched.name,
                simulate: true,
              }),
            });
            const hj = await hr.json().catch(() => ({}));
            if (hj?.assigned_to_name) adminName = hj.assigned_to_name;
            if (hj?.assignment_reason) assignReason = hj.assignment_reason;
          } catch (e) { console.error("[HANDOFF] admin fetch failed:", e); }
        }
        const handoffText = `🔀 ส่งต่อแอดมิน${adminName ? `: ${adminName}` : ""}\nเหตุผล: ${assignReason}`;
        setHandedOff(true);
        setAssignedAdmin(null);
        setAssignedAdminName(adminName || null);
        setAssignmentReason(assignReason);
        toast.success(handoffText);
        historyRef.current.push({ role: "user", text: combinedText, ...(bufferedImagesRef.current.length > 0 ? { images: [...bufferedImagesRef.current] } : {}) });
        historyRef.current.push({ role: "model", text: handoffText });
        // ⚡ ไม่ save combinedText ซ้ำ — b1, b2 ถูก save ไปแล้วตอนพิมพ์ (saveMessageToSession ใน buffer flow)
        saveMessageToSession("model", handoffText);
        setMessages((prev) => prev.map((m) => m.id === spinnerId ? {
          ...m,
          html: `<div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:8px;padding:8px 12px;color:var(--color-info);font-size:13px">⚡ trigger: ${escapeHtml(triggerMatched!.name)} → 🔀 ส่งต่อแอดมิน${adminName ? `: <b>${escapeHtml(adminName)}</b>` : ""}<br><span style="font-size:11px;opacity:0.7">เหตุผล: ${escapeHtml(assignReason)}</span><br><span style="font-size:11px;opacity:0.5">รวมจาก ${msgs.length} ข้อความ</span></div>`,
          stats: {
            source: "trigger_handoff",
            handoff_to_admin: true,
            handoff_reason: assignReason,
            routing_decision: { path: "handoff", trigger_matched: triggerMatched.name, assigned_admin_name: adminName },
          } as MsgStats,
          isGroupLast: true,
        } : m));
        bufferSpinnerIdRef.current = null;
        setIsBuffering(false);
        setBufferedCount(0);
        setSending(false);
        return;
      }

      // ⚡ trigger bot_answer + bot_template → ใช้ template
      if (triggerMatched && triggerMatched.action === "bot_answer" && triggerMatched.bot_template) {
        const templateText = triggerMatched.bot_template;
        const segments = splitAnswerSegments(templateText);
        const bubbles = segments.length > 0 ? segments : [templateText];
        historyRef.current.push({ role: "user", text: combinedText, ...(bufferedImagesRef.current.length > 0 ? { images: [...bufferedImagesRef.current] } : {}) });
        historyRef.current.push({ role: "model", text: templateText });
        const stats: MsgStats = {
          source: "trigger_bot_answer",
          routing_decision: { path: "bot_reply", trigger_matched: triggerMatched.name },
        };
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((m) => m.id === spinnerId);
          if (idx === -1) return prev;
          next[idx] = {
            ...next[idx],
            html: formatAnswer(bubbles[0]),
            raw: bubbles[0],
            stats,
            ...(bubbles.length === 1 ? { isGroupLast: true } : {}),
          };
          const extraMsgs: Msg[] = bubbles.slice(1).map((seg, si) => ({
            id: msgIdCounter++,
            role: "bot",
            html: formatAnswer(seg),
            raw: seg,
            stats,
            ...(si === bubbles.length - 2 ? { isGroupLast: true } : {}),
          }));
          return [...next, ...extraMsgs];
        });
        // ⚡ ไม่ save combinedText ซ้ำ — b1, b2 ถูก save ไปแล้วตอนพิมพ์
        saveMessageToSession("model", templateText, stats);
        bufferSpinnerIdRef.current = null;
        setIsBuffering(false);
        setBufferedCount(0);
        setSending(false);
        return;
      }

      // ⚡ ② Workflow step (after_trigger) — trigger ไม่ match → ลอง workflow ก่อนบอท (trigger_first)
      if (await runWorkflowStep("after_trigger")) return;

      // ⚡ ไม่ match trigger → flush ผ่าน API (ส่ง combined ไป bot)
      const fr = await fetch("/api/test-chat/flush", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: currentSessionId,
          shop,
          platform,
          history: priorHistory,
          limit,
        }),
      });
      const fj = await fr.json().catch(() => ({}));

      if (fj.status === "empty") {
        if (spinnerId !== null) setMessages((prev) => prev.filter((m) => m.id !== spinnerId));
        bufferSpinnerIdRef.current = null;
        setIsBuffering(false);
        setBufferedCount(0);
        setSending(false);
        return;
      }

      if (fj.status === "bot_error") {
        const errText = `เกิดข้อผิดพลาด: ${fj.error || "ไม่ทราบสาเหตุ"}`;
        setMessages((prev) => prev.map((m) => m.id === spinnerId ? {
          ...m, html: `<span style="color:var(--color-error-soft)">${escapeHtml(errText)}</span>`,
        } : m));
        bufferSpinnerIdRef.current = null;
        setIsBuffering(false);
        setBufferedCount(0);
        setSending(false);
        return;
      }

      // ⚡ ประมวลผล bot response (เหมือน normal flow)
      const answerText = fj.answer || "(ไม่มีคำตอบ)";
      const segments: string[] = Array.isArray(fj.answer_segments) && fj.answer_segments.length > 0
        ? fj.answer_segments.map((s: string) => String(s).trim()).filter((s: string) => s.length > 0)
        : splitAnswerSegments(answerText);
      const bubbles = segments.length > 0 ? segments : [answerText];
      // ⚡ A2 — push user พร้อม images แล้ว cache image_desc หลัง bot ตอบ
      historyRef.current.push({ role: "user", text: combinedText, ...(bufferedImagesRef.current.length > 0 ? { images: [...bufferedImagesRef.current] } : {}) });
      if (fj.image_desc && historyRef.current.length > 0) {
        const lastIdx = historyRef.current.length - 1;
        if (historyRef.current[lastIdx].role === "user") {
          historyRef.current[lastIdx].image_desc = String(fj.image_desc);
        }
      }
      historyRef.current.push({ role: "model", text: answerText });
      setLastProducts(fj.products || []);
      const stats: MsgStats = {
        elapsed: typeof fj.elapsed === "number" ? fj.elapsed : undefined,
        usage: fj.usage || undefined,
        cost: typeof fj.cost === "number" ? fj.cost : undefined,
        model: fj.model,
        source: fj.source,
        intent: fj.intent || undefined,
        timing: fj.timing || undefined,
        retrieval_info: fj.retrieval_info || undefined,
        web_search_used: fj.web_search_used === true,
        web_search_reason: fj.web_search_reason || undefined,
        web_search_model: fj.web_search_model || undefined,
        // ⚡ เพิ่ม buffer_flush step ที่จุดเริ่มต้นของ steps (แสดงว่า merge อะไรบ้าง)
        steps: Array.isArray(fj.steps) ? [
          {
            name: "buffer_flush",
            model: "",
            tokens_in: 0,
            tokens_out: 0,
            time_s: 0,
            cost_usd: 0,
            cost_thb: 0,
            input: {
              message_count: fj.message_count || 0,
              combined_message: (fj.combined_message || "").slice(0, 500),
              message_ids: fj.message_ids || [],
            },
            output: null,
          },
          ...fj.steps,
        ] : undefined,
        handoff_to_admin: fj.handoff_to_admin === true,
        handoff_reason: fj.handoff_reason || undefined,
        routing_decision: fj.routing_decision || undefined,
      };
      if (stats.handoff_to_admin) {
        const adminName = (stats.routing_decision?.assigned_admin_name as string) || (stats.routing_decision?.assigned_admin as string) || null;
        const reason = stats.handoff_reason || "unknown";
        setHandedOff(true);
        setAssignedAdmin(stats.routing_decision?.assigned_admin as string || null);
        setAssignedAdminName(adminName);
        setAssignmentReason(reason);
        toast.success(`🔀 ส่งต่อแอดมิน${adminName ? `: ${adminName}` : ""}\nเหตุผล: ${reason}`);
      } else if (stats.routing_decision?.trigger_matched) {
        toast.info(`⚡ trigger: ${stats.routing_decision.trigger_matched}`);
      }
      setTotals((t) => ({
        turns: t.turns + 1,
        elapsed: t.elapsed + (stats.elapsed || 0),
        prompt: t.prompt + (stats.usage?.prompt || 0),
        output: t.output + (stats.usage?.output || 0),
        total: t.total + (stats.usage?.total || 0),
        cost: t.cost + (stats.cost || 0),
        wsTurns: t.wsTurns + (stats.web_search_used ? 1 : 0),
        wsCost: t.wsCost + (stats.web_search_used ? (stats.cost || 0) : 0),
        wsTokens: t.wsTokens + (stats.web_search_used ? (stats.usage?.total || 0) : 0),
      }));
      setMessages((prev) => {
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === spinnerId);
        if (idx === -1) return prev;
        next[idx] = {
          ...next[idx],
          html: formatAnswer(bubbles[0]),
          raw: bubbles[0],
          products: fj.products || [],
          stats,
          ...(bubbles.length === 1 ? { isGroupLast: true } : {}),
        };
        const extraMsgs: Msg[] = bubbles.slice(1).map((seg, si) => {
          const isLast = si === bubbles.length - 2;
          return {
            id: msgIdCounter++,
            role: "bot",
            html: formatAnswer(seg),
            raw: seg,
            ...(isLast ? { isGroupLast: true, stats } : {}),
          } as Msg;
        });
        next.splice(idx + 1, 0, ...extraMsgs);
        return next;
      });
      // ⚡ ไม่ save combinedText ซ้ำ — b1, b2 ถูก save ไปแล้วตอนพิมพ์
      saveMessageToSession("model", answerText, stats);
    } catch {
      setMessages((prev) => prev.map((m) =>
        m.id === spinnerId ? { ...m, html: '<span style="color:var(--color-error-soft)">เกิดข้อผิดพลาดในการเชื่อมต่อ server</span>' } : m
      ));
    } finally {
      bufferSpinnerIdRef.current = null;
      setIsBuffering(false);
      setBufferedCount(0);
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function copyText(text: string, btn: HTMLButtonElement) {
    const done = () => {
      btn.textContent = "คัดลอกแล้ว ✓";
      setTimeout(() => { btn.textContent = "คัดลอก"; }, 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch {}
        document.body.removeChild(ta);
      });
    }
  }

  function copyAllChat() {
    const lines: string[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        lines.push(`👤 ลูกค้า: ${m.raw || m.html}`);
      } else if (m.role === "bot") {
        lines.push(`🤖 บอท: ${m.raw || m.html}`);
        if (m.stats) {
          const parts: string[] = [];
          if (m.stats.source) parts.push(`source=${m.stats.source}`);
          if (m.stats.elapsed != null) parts.push(`time=${m.stats.elapsed}s`);
          if (m.stats.usage?.total) parts.push(`tokens=${m.stats.usage.total}`);
          if (m.stats.cost) parts.push(`cost=$${m.stats.cost}`);
          if (m.stats.web_search_used) parts.push(`web_search=${m.stats.web_search_reason || "yes"}`);
          // Pipeline summary
          const pipeline: string[] = [];
          if (m.stats.intent?.intent) pipeline.push("Intent");
          if (m.stats.timing?.llm != null) pipeline.push("LLM1");
          if (m.stats.web_search_used) pipeline.push("Search");
          if (m.stats.timing?.llm2 != null) pipeline.push("LLM2");
          if (pipeline.length) parts.push(`pipeline=${pipeline.join("→")}`);
          if (parts.length) lines.push(`   📊 ${parts.join(" | ")}`);
        }
      }
      lines.push("");
    }
    const text = lines.join("\n").trim();
    const done = () => {
      setCopyAllLabel("คัดลอกแล้ว ✓");
      setTimeout(() => setCopyAllLabel("คัดลอกแชททั้งหมด"), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch {}
        document.body.removeChild(ta);
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch {}
      document.body.removeChild(ta);
    }
  }

  // Platform ที่ยังไม่มีบอทของจริง — โชว์สถานะ "ยังไม่เชื่อมต่อ" ไม่ยิง API
  if (!meta.available) {
    return (
      <div className="h-full min-h-0 flex flex-col bg-surface">
        <div className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-border bg-surface shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${meta.gradient} flex items-center justify-center shrink-0 shadow-sm opacity-60`}>
              <PlatformIcon platform={platform} size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-brand truncate">ทดสอบบอท — {meta.label}</h1>
              <div className="text-xs text-text-muted flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-text-subtle inline-block" />
                ยังไม่เชื่อมต่อ
              </div>
            </div>
          </div>
        </div>
        <PlatformSwitcher platform={platform} />

        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center max-w-sm">
            <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${meta.gradient} flex items-center justify-center mx-auto mb-4 opacity-40`}>
              <PlatformIcon platform={platform} size={28} />
            </div>
            <h2 className="text-lg font-semibold text-text mb-2">บอท {meta.label} ยังไม่พร้อม</h2>
            <p className="text-sm text-text-muted mb-1">
              บอทสำหรับ {meta.label} ยังไม่ได้เชื่อมต่อในขณะนี้
            </p>
            <p className="text-xs text-text-subtle">
              ระบบจะเปิดใช้งานเมื่อบอท {meta.label} พร้อม (port แยกตามแพลตฟอร์ม)
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{`
        .tc-msg a { color: var(--brand, #087e8b); }
        .tc-msg.user a { color: #fff; text-decoration: underline; }
        .tc-msg .copy-btn {
          position: absolute; top: 6px; right: 6px;
          padding: 3px 8px; border-radius: 6px;
          border: 1px solid var(--color-border, #e3e6eb); background: var(--color-surface-2, #f1f3f6);
          color: var(--color-text-muted, #64748b); font-size: 11px; cursor: pointer;
          opacity: 0.5; transition: opacity .15s;
        }
        .tc-msg.bot:hover .copy-btn { opacity: 1; }
        .tc-msg .feedback-btns {
          position: absolute; bottom: 6px; right: 6px;
          display: flex; gap: 4px; opacity: 0; transition: opacity .15s;
        }
        .tc-msg.bot:hover .feedback-btns { opacity: 1; }
        .tc-msg .feedback-btns button {
          padding: 3px 7px; border-radius: 6px;
          border: 1px solid var(--color-border, #e3e6eb); background: var(--color-surface-2, #f1f3f6);
          color: var(--color-text-muted, #64748b); font-size: 13px; cursor: pointer; line-height: 1;
        }
        .tc-msg .stats {
          margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--color-border, #e3e6eb);
          font-size: 11px; color: var(--color-text-muted, #64748b); display: flex; flex-wrap: wrap; gap: 4px 10px;
          font-variant-numeric: tabular-nums;
        }
        .tc-msg .stats .pill {
          padding: 1px 6px; border-radius: 6px; background: var(--color-surface-2, #f1f3f6);
          border: 1px solid var(--color-border, #e3e6eb); white-space: nowrap;
        }
        .tc-msg .stats .pill.cost { color: var(--color-success-soft); border-color: rgba(52,211,153,0.3); background: rgba(52,211,153,0.06); }
        .tc-msg .stats .pill.time { color: var(--brand, #087e8b); border-color: rgba(8,126,139,0.3); background: rgba(8,126,139,0.06); }
        .tc-msg .stats .pill.model { color: var(--color-text-muted, #64748b); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
        .tc-msg .stats .pill.intent { color: var(--color-purple); border-color: rgba(167,139,250,0.3); background: rgba(167,139,250,0.06); }
        .tc-msg .stats .pill.timing { color: var(--color-warning); border-color: rgba(251,191,36,0.3); background: rgba(251,191,36,0.06); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
        .tc-msg .stats .pill.device { color: var(--color-info-soft); border-color: rgba(96,165,250,0.3); background: rgba(96,165,250,0.06); }
        .tc-msg .stats .pill.websearch { color: var(--color-success); border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.08); font-weight: 600; }
        .tc-msg .stats .pill.websearch-reason { color: var(--color-orange); border-color: rgba(249,115,22,0.3); background: rgba(249,115,22,0.06); font-size: 10px; }
        .tc-msg .stats .pill.muted { color: var(--color-muted); border-color: rgba(107,114,128,0.2); background: rgba(107,114,128,0.04); opacity: 0.6; }
        .tc-msg .stats .pill.step-detail { font-size: 10px; padding: 2px 6px; background: rgba(99,102,241,0.08); border-color: rgba(99,102,241,0.2); color: var(--color-info-dark); }
        .tc-msg.bot.web-search-bubble {
          background: linear-gradient(135deg, rgba(16,185,129,0.08), rgba(52,211,153,0.04)) !important;
          border-color: rgba(16,185,129,0.35) !important;
        }
        .tc-msg .web-search-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 8px; border-radius: 6px; margin-bottom: 6px;
          background: rgba(16,185,129,0.12); color: var(--color-success-dark);
          font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
        }
        .tc-msg .stats .debug-row { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
        .tc-msg .stats .debug-label { font-size: 9px; color: var(--color-text-muted, #64748b); text-transform: uppercase; letter-spacing: 0.05em; margin-right: 2px; }
        .tc-msg img { max-width: 100%; max-height: 220px; object-fit: contain; border-radius: 10px; margin: 8px 0 4px; background: var(--color-surface-2, #f1f3f6); display: block; }
        .tc-msg .img-caption { font-size: 11px; color: var(--color-text-muted, #64748b); margin-bottom: 8px; }
        .tc-msg .table-wrap { overflow-x: auto; max-width: 100%; margin: 10px 0 14px; border: 1px solid var(--color-border, #e3e6eb); border-radius: 10px; -webkit-overflow-scrolling: touch; }
        .tc-msg table { width: 100%; max-width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; background: var(--color-surface-2, #f1f3f6); table-layout: fixed; }
        .tc-msg table thead th { background: var(--color-surface-2, #f1f3f6); color: var(--color-text, #101828); font-weight: 600; text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--color-border, #e3e6eb); word-break: break-word; overflow: hidden; text-overflow: ellipsis; }
        .tc-msg table tbody td { padding: 7px 10px; border-bottom: 1px solid var(--color-border, #e3e6eb); vertical-align: top; word-break: break-word; overflow: hidden; text-overflow: ellipsis; }
        .tc-msg table tbody tr:last-child td { border-bottom: 0; }
        .tc-msg table tbody tr:nth-child(even) td { background: rgba(0,0,0,0.02); }
        .tc-msg table .price { color: var(--color-success-soft); font-weight: 600; }
        .tc-msg table .warranty { color: var(--color-warning); }
        .tc-msg ul, .tc-msg ol { margin: 6px 0 6px 18px; padding: 0; }
        .tc-msg li { margin: 2px 0; }
        .tc-msg p { margin: 4px 0; }
        .tc-spinner {
          width: 14px; height: 14px; border: 2px solid var(--color-text-muted, #64748b);
          border-top-color: var(--brand, #087e8b); border-radius: 50%;
          animation: tc-spin 0.8s linear infinite; display: inline-block; vertical-align: middle; margin-right: 6px;
        }
        @keyframes tc-spin { to { transform: rotate(360deg); } }
        @media (max-width: 1279px) {
          .tc-msg .feedback-btns { opacity: 1; }
          .tc-msg .copy-btn { display: none; }
        }
      `}</style>

      <div className="h-full min-h-0 flex flex-col bg-surface">
        {/* Header — platform themed */}
        <div className="flex items-center justify-between px-4 lg:px-6 py-2.5 border-b border-border bg-surface shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-9 h-9 lg:w-10 xl:h-10 rounded-xl bg-gradient-to-br ${meta.gradient} flex items-center justify-center shrink-0 shadow-sm`}>
              <PlatformIcon platform={platform} size={18} />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm xl:text-base font-semibold text-brand truncate">ทดสอบบอท — {meta.label}</h1>
              <div className="text-[11px] xl:text-xs text-text-muted flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-brand inline-block" />
                Gemini + MongoDB · เชื่อมต่อแล้ว
              </div>
            </div>
          </div>
          {/* Action buttons — icon group */}
          <div className="flex items-center gap-1.5">
            {/* History button — mobile/tablet เท่านั้น */}
            <button
              onClick={() => setSessionListOpen(true)}
              className="lg:hidden inline-flex items-center justify-center w-8 h-8 text-xs rounded-lg border border-border bg-surface-2 text-text-muted hover:text-text hover:bg-surface-3 transition-colors"
              title="ประวัติแชท"
              aria-label="ประวัติแชท"
            >
              <Clock size={14} />
            </button>
            {messages.length > 0 && (
              <button
                onClick={copyAllChat}
                className="inline-flex items-center justify-center w-8 h-8 lg:w-auto lg:px-3 text-xs rounded-lg border border-border bg-surface-2 text-text-muted hover:text-text hover:bg-surface-3 transition-colors"
                title="คัดลอกแชททั้งหมด พร้อม stats"
                aria-label="คัดลอกแชททั้งหมด"
              >
                <Copy size={14} />
                <span className="hidden lg:inline ml-1.5">{copyAllLabel}</span>
              </button>
            )}
            <button
              onClick={() => setLogPanelOpen((v) => !v)}
              className={`inline-flex items-center justify-center w-8 h-8 lg:w-auto lg:px-3 text-xs rounded-lg border transition-colors ${
                logPanelOpen
                  ? "bg-brand/10 text-brand border-brand/30"
                  : "bg-surface-2 text-text-muted border-border hover:text-text hover:bg-surface-3"
              }`}
              title="เปิด/ปิด log panel"
              aria-label="เปิด/ปิด log panel"
            >
              <Terminal size={14} />
              <span className="hidden lg:inline ml-1.5">Log</span>
            </button>
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden inline-flex items-center justify-center w-8 h-8 text-xs rounded-lg border border-border bg-surface-2 text-text-muted hover:text-text hover:bg-surface-3 transition-colors"
              title="ตั้งค่า"
              aria-label="ตั้งค่า"
            >
              <Settings2 size={14} />
            </button>
          </div>
        </div>
        <PlatformSwitcher platform={platform} />

        {/* Main layout — 3 panel: history | chat | log */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          {/* ── Chat History sidebar (with filter + sort + edit title) ── */}
          <aside className="hidden lg:flex w-72 shrink-0 flex-col border-r border-border bg-surface">
            {/* Header + New button */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
              <span className="text-xs font-semibold text-text-muted">ประวัติแชท</span>
              <button
                onClick={createSession}
                className="inline-flex items-center gap-1 px-2 h-7 text-xs rounded-lg bg-brand text-white hover:bg-brand/90"
                title="สร้างแชทใหม่"
              >
                <Plus size={12} /> ใหม่
              </button>
            </div>

            {/* Filter bar — search + shop filter + sort */}
            <div className="px-2.5 py-2 border-b border-border space-y-1.5">
              {/* Search input */}
              <div className="relative">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-subtle" />
                <input
                  type="text"
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                  placeholder="ค้นหาชื่อแชท..."
                  className="w-full h-7 pl-7 pr-2 text-[11px] rounded-md border border-border bg-surface-2 focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
              </div>
              {/* Shop filter + sort row */}
              <div className="flex items-center gap-1">
                <select
                  value={filterShop}
                  onChange={(e) => setFilterShop(e.target.value)}
                  className="flex-1 h-7 px-1.5 text-[10px] rounded-md border border-border bg-surface-2 focus:outline-none"
                  title="กรองตามร้าน"
                >
                  <option value="">ทุกร้าน</option>
                  {shops.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  className="flex-1 h-7 px-1.5 text-[10px] rounded-md border border-border bg-surface-2 focus:outline-none"
                  title="เรียงตาม"
                >
                  <option value="updated">ใหม่กว่า</option>
                  <option value="created">สร้างล่าสุด</option>
                  <option value="messages">จำนวนข้อความ</option>
                </select>
                <button
                  onClick={() => setSortDir((d) => d === "desc" ? "asc" : "desc")}
                  className="h-7 w-7 flex items-center justify-center rounded-md border border-border bg-surface-2 hover:bg-surface text-text-muted"
                  title={sortDir === "desc" ? "มาก→น้อย" : "น้อย→มาก"}
                  aria-label={sortDir === "desc" ? "มาก→น้อย" : "น้อย→มาก"}
                >
                  <ArrowUpDown size={11} />
                </button>
              </div>
            </div>

            {/* Session list — filtered + sorted */}
            <div className="flex-1 overflow-y-auto">
              {(() => {
                // ⚡ filter + sort ใน frontend
                let filtered = sessions;
                if (filterShop) {
                  filtered = filtered.filter((s) => s.shop === filterShop);
                }
                if (filterSearch.trim()) {
                  const q = filterSearch.toLowerCase();
                  filtered = filtered.filter((s) =>
                    (s.title || "").toLowerCase().includes(q) ||
                    (s.shop || "").toLowerCase().includes(q)
                  );
                }
                const sorted = [...filtered].sort((a, b) => {
                  let cmp = 0;
                  if (sortBy === "messages") {
                    cmp = a.message_count - b.message_count;
                  } else if (sortBy === "created") {
                    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
                    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
                    cmp = ta - tb;
                  } else {
                    // updated
                    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
                    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
                    cmp = ta - tb;
                  }
                  return sortDir === "desc" ? -cmp : cmp;
                });
                if (sorted.length === 0) {
                  return <div className="p-3 text-xs text-text-muted">{sessions.length === 0 ? 'ยังไม่มีแชท — กด "ใหม่" เพื่อสร้าง' : "ไม่พบแชทที่ตรง filter"}</div>;
                }
                return sorted.map((s) => (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => loadSession(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        loadSession(s.id);
                      }
                    }}
                    className={`group flex items-center justify-between px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${currentSessionId === s.id ? "bg-brand/5 border-l-2 border-l-brand" : ""}`}
                  >
                    <div className="min-w-0 flex-1">
                      {editingSessionId === s.id ? (
                        /* ⚡ Inline edit title */
                        <input
                          type="text"
                          value={editingTitle}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const v = editingTitle.trim();
                              if (v) {
                                updateSessionTitle(s.id, v);
                                if (currentSessionId === s.id) {
                                  // อัปเดต title ใน state ถ้าเป็น session ปัจจุบัน
                                }
                              }
                              setEditingSessionId(null);
                            } else if (e.key === "Escape") {
                              setEditingSessionId(null);
                            }
                          }}
                          onBlur={() => {
                            const v = editingTitle.trim();
                            if (v && v !== s.title) updateSessionTitle(s.id, v);
                            setEditingSessionId(null);
                          }}
                          className="w-full h-6 px-1.5 text-xs rounded border border-brand/40 bg-surface focus:outline-none focus:ring-1 focus:ring-brand/40"
                        />
                      ) : (
                        <div className="text-xs font-medium text-text truncate">
                          {s.source === "script_test" && (
                            <span className="inline-block mr-1 px-1 py-0.5 text-[9px] rounded bg-warning-soft text-warning-dark border border-warning/30 align-middle">🧪 Script</span>
                          )}
                          {s.title || "ไม่มีชื่อ"}
                        </div>
                      )}
                      <div className="text-[10px] text-text-muted truncate">
                        {s.shop || "—"} · {s.message_count} ข้อความ
                        {s.updated_at && (
                          <span className="opacity-60"> · {new Date(s.updated_at).toLocaleDateString("th-TH", { day: "2-digit", month: "short" })}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingSessionId(s.id);
                          setEditingTitle(s.title || "");
                        }}
                        className="text-text-muted hover:text-brand p-1"
                        title="แก้ชื่อ"
                        aria-label="แก้ชื่อ"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                        className="text-text-muted hover:text-red-500 p-1"
                        title="ลบ"
                        aria-label="ลบ"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ));
              })()}
            </div>
          </aside>

          {/* ── Chat column ── */}
          <section className="flex-1 min-h-0 flex flex-col border-r border-border">
            <div ref={msgsRef} className="flex-1 min-h-0 overflow-y-auto p-4 md:p-5 flex flex-col gap-3">
              {messages.map((m, _i) => {
                // ⚡ Date separator — แทรก DateBanner เมื่อวันเปลี่ยน (เหมือน LINE)
                const _ts = m.timestamp || new Date().toISOString();
                const _dk = dayKey(_ts);
                const _prevTs = messages[_i - 1]?.timestamp || new Date().toISOString();
                const _showDate = _i === 0 || _dk !== dayKey(_prevTs);
                return (
                <React.Fragment key={m.id}>
                {_showDate && <DateBanner timestamp={_ts} onlyToday />}
                <div
                  key={m.id}
                  className={`tc-msg relative max-w-[min(88%,680px)] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words overflow-hidden shrink-0 ${
                    m.role === "user"
                      ? "self-end bg-brand text-white rounded-br-md"
                      : m.role === "bot"
                      ? `self-start bg-surface-2 border border-border rounded-bl-md max-w-[min(92%,720px)]${m.stats?.web_search_used ? " web-search-bubble" : ""}`
                      : "self-center bg-transparent text-text-muted text-xs"
                  }`}
                >
                  {m.role === "bot" && m.raw ? (
                    <>
                      {m.stats?.web_search_used && (
                        <div className="web-search-badge">🔍 Google Search (OpenRouter)</div>
                      )}
                      <span dangerouslySetInnerHTML={{ __html: m.html }} />
                      {m.stats && (m.stats.elapsed != null || m.stats.usage?.total || m.stats.cost) && (
                        <div className="stats">
                          <span className="pill time">⏱ {fmtElapsed(m.stats.elapsed)}</span>
                          <span className="pill">
                            Tokens: {fmtTokens(m.stats.usage?.total)}{" "}
                            <span style={{ opacity: 0.6 }}>
                              ({fmtTokens(m.stats.usage?.prompt)}↑ {fmtTokens(m.stats.usage?.output)}↓)
                            </span>
                          </span>
                          <span className="pill cost">💰 {fmtCost(m.stats.cost)} · {fmtTHB(m.stats.cost)}</span>
                          {m.stats.model && <span className="pill model">{escapeHtml(m.stats.model)}</span>}
                          {m.stats.source && <span className="pill model">{escapeHtml(m.stats.source)}</span>}
                          {m.stats.intent?.intent && (
                            <span className="pill intent">🎯 {escapeHtml(m.stats.intent.intent)}{m.stats.intent.confidence != null ? ` (${(m.stats.intent.confidence * 100).toFixed(0)}%)` : ""}</span>
                          )}
                          {m.stats.intent?.target_device && (
                            <span className="pill device">📱 {escapeHtml(m.stats.intent.target_device)}</span>
                          )}
                          {m.stats.intent?.product_type && (
                            <span className="pill device">📦 {escapeHtml(m.stats.intent.product_type)}{m.stats.intent.charger_subtype ? `/${escapeHtml(m.stats.intent.charger_subtype)}` : ""}</span>
                          )}
                          {/* Pipeline: แสดง step ที่ใช้ พร้อม model/tokens/time/cost */}
                          <div className="debug-row">
                            <span className="debug-label">Pipeline:</span>
                            {m.stats.steps && m.stats.steps.length > 0 ? (
                              m.stats.steps.map((s, i) => {
                                const inputStr = s.input ? `\n📥 Input: ${JSON.stringify(s.input).slice(0, 200)}` : "";
                                const outputStr = s.output ? `\n📤 Output: ${JSON.stringify(s.output).slice(0, 200)}` : "";
                                const tooltip = `${s.model || ""} · in:${s.tokens_in} out:${s.tokens_out} · ${s.time_s}s · ฿${s.cost_thb}${inputStr}${outputStr}`;
                                return (
                                  <span key={i} className="pill step-detail" title={tooltip}>
                                    <strong>{s.name}</strong>{s.model ? ` · ${s.model.split("/").pop()}` : ""} · in:{s.tokens_in} out:{s.tokens_out} · {s.time_s}s · ฿{s.cost_thb}
                                  </span>
                                );
                              })
                            ) : (
                              <>
                                <span className={`pill ${m.stats.intent?.intent ? "intent" : "muted"}`}>
                                  {m.stats.intent?.intent ? "✅ Intent" : "⏭ Intent"}
                                </span>
                                <span className={`pill ${m.stats.timing?.llm != null ? "timing" : "muted"}`}>
                                  {m.stats.timing?.llm != null ? "✅ LLM2" : "⏭ LLM2"}
                                </span>
                                <span className={`pill ${m.stats.web_search_used ? "websearch" : "muted"}`}>
                                  {m.stats.web_search_used ? "✅ Search" : "⏭ Search"}
                                </span>
                                <span className={`pill ${m.stats.timing?.llm2 != null ? "timing" : "muted"}`}>
                                  {m.stats.timing?.llm2 != null ? "✅ LLM2(search)" : "⏭ LLM2(search)"}
                                </span>
                              </>
                            )}
                          </div>
                          {m.stats.timing && (m.stats.timing.pass1 != null || m.stats.timing.total != null) && (
                            <div className="debug-row">
                              <span className="debug-label">Timing:</span>
                              {m.stats.timing.pass1 != null && <span className="pill timing">Pass1: {m.stats.timing.pass1}s</span>}
                              {m.stats.timing.retrieval != null && <span className="pill timing">RAG: {m.stats.timing.retrieval}s</span>}
                              {m.stats.timing.llm != null && <span className="pill timing">LLM1: {m.stats.timing.llm}s</span>}
                              {m.stats.timing.llm2 != null && <span className="pill timing">LLM2: {m.stats.timing.llm2}s</span>}
                              {m.stats.timing.total != null && <span className="pill timing">Total: {m.stats.timing.total}s</span>}
                            </div>
                          )}
                          {m.stats.intent?.needs_description != null && (
                            <div className="debug-row">
                              <span className="debug-label">Flags:</span>
                              <span className="pill model">desc: {m.stats.intent.needs_description ? "✓" : "✗"}</span>
                            </div>
                          )}
                          {m.stats.web_search_used && (
                            <div className="debug-row">
                              <span className="debug-label">Web Search:</span>
                              <span className="pill websearch">🔍 OpenRouter</span>
                              {m.stats.web_search_model && <span className="pill model">{escapeHtml(m.stats.web_search_model)}</span>}
                              {m.stats.web_search_reason && <span className="pill websearch-reason">⚠ {escapeHtml(m.stats.web_search_reason)}</span>}
                              {m.stats.timing?.web_search != null && <span className="pill timing">Search: {m.stats.timing.web_search}s</span>}
                              {m.stats.usage?.total != null && <span className="pill">Tokens: {fmtTokens(m.stats.usage.total)}</span>}
                              <span className="pill cost">💰 {fmtCost(m.stats.cost)} · {fmtTHB(m.stats.cost)}</span>
                            </div>
                          )}
                          {/* ── Routing Decision ── */}
                          {m.stats.routing_decision && m.stats.routing_decision.path && (
                            <div className="debug-row">
                              <span className="debug-label">Routing:</span>
                              <span className={`pill ${m.stats.routing_decision.path === "handoff" ? "websearch-reason" : "intent"}`}>
                                {m.stats.routing_decision.path === "handoff" ? "🔀 Handoff" : "🤖 Bot Reply"}
                              </span>
                              {m.stats.routing_decision.reason && (
                                <span className="pill model" title={escapeHtml(m.stats.routing_decision.reason)}>
                                  {escapeHtml(m.stats.routing_decision.reason)}
                                </span>
                              )}
                              {m.stats.routing_decision.trigger_matched && (
                                <span className="pill websearch-reason">
                                  ⚡ trigger: {escapeHtml(m.stats.routing_decision.trigger_matched)}
                                </span>
                              )}
                              {m.stats.routing_decision.shop_settings_action && (
                                <span className="pill websearch-reason">
                                  ⚙ shop_settings: {escapeHtml(m.stats.routing_decision.shop_settings_action)}
                                </span>
                              )}
                              {m.stats.routing_decision.assigned_admin && (
                                <span className="pill intent">
                                  👤 assigned: {escapeHtml(m.stats.routing_decision.assigned_admin)}
                                </span>
                              )}
                              {m.stats.handoff_to_admin && (
                                <span className="pill websearch-reason">
                                  📤 handoff_reason: {escapeHtml(m.stats.handoff_reason || "unknown")}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      <button className="copy-btn" onClick={(e) => copyText(m.raw!, e.currentTarget)}>
                        คัดลอก
                      </button>
                      <div className="feedback-btns">
                        <button
                          title="ตอบดี"
                          aria-label="ตอบดี"
                          onClick={() => sendFeedback(m.raw!, "up")}
                        >
                          <ThumbsUp size={12} />
                        </button>
                        <button
                          title="ตอบไม่ดี"
                          aria-label="ตอบไม่ดี"
                          onClick={() => sendFeedback(m.raw!, "down")}
                        >
                          <ThumbsDown size={12} />
                        </button>
                      </div>

                      {/* ── RateBox — แสดงเฉพาะ bubble สุดท้ายของกลุ่ม bot answer ── */}
                      {m.isGroupLast && m.sessionMsgIndex != null && (
                        <RateBox
                          starRating={m.stats?.star_rating}
                          rating={m.stats?.rating}
                          comment={m.stats?.comment}
                          onStar={(v) => rateMessage(m.id, { star: v })}
                          onRate={(rt) => rateMessage(m.id, { rating: rt })}
                          onComment={(text) => rateMessage(m.id, { comment: text })}
                        />
                      )}
                    </>
                  ) : (
                    <span
                      dangerouslySetInnerHTML={{ __html: m.html }}
                      onClick={(e) => {
                        // ⚡ Phase 1F — กดที่รูปแล้วเปิด imageViewer
                        const target = e.target as HTMLElement;
                        if (target.tagName === "IMG") {
                          const src = (target as HTMLImageElement).src;
                          if (src) imageViewer.show(src, { type: "image", alt: "รูปที่ส่ง" });
                        }
                      }}
                      style={{ cursor: m.html.includes("img") ? "pointer" : undefined }}
                    />
                  )}
                </div>
                </React.Fragment>
                );
              })}
            </div>

            {/* Composer */}
            <div className="flex flex-col gap-2 p-3 border-t border-border bg-surface shrink-0">
              {/* ⚡ Handoff banner + ปุ่มปิดแชท */}
              {handedOff && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/30">
                  <div className="flex items-center gap-2 text-xs text-warning min-w-0">
                    <span className="shrink-0">🔀</span>
                    <span className="truncate">
                      ส่งต่อแอดมินแล้ว{assignedAdminName ? `: ${assignedAdminName}` : ""} — บอทจะไม่ตอบจนกว่าจะปิดแชท
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      // ⚡ Phase 2A — เรียก API ปิดแชท (state-driven) ไม่ใช่แค่ client toggle
                      if (currentSessionId) {
                        try {
                          await fetch(`/api/chatbot/${platform}/test-chat/sessions/${currentSessionId}/close`, {
                            method: "POST",
                          });
                        } catch (e) {
                          console.error("[close-chat] failed:", e);
                        }
                      }
                      setHandedOff(false);
                      setAssignedAdmin(null);
                      setAssignedAdminName(null);
                      setAssignmentReason(null);
                      setSessionStatus("closed"); // ⚡ Phase 2A — อัปเดต session status
                      toast.success("ปิดแชทแล้ว — บอทตอบได้ต่อ");
                    }}
                    className="shrink-0 text-xs"
                  >
                    ปิดแชท (ให้บอทตอบต่อ)
                  </Button>
                </div>
              )}
              {/* ⚡ Phase 2E — quick replies floating chips (เหนือ textarea) — กดแล้วส่งเลย */}
              {quickReplies.length > 0 && !handedOff && (
                <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
                  {quickReplies.map((qr) => (
                    <button
                      key={qr.quick_reply_id}
                      type="button"
                      onClick={() => send(undefined, qr.body)}
                      title={qr.body}
                      className="px-2.5 py-1 rounded-full border border-brand/30 bg-brand/5 text-xs text-brand hover:bg-brand/10 hover:border-brand/50 transition-colors whitespace-nowrap max-w-[160px] truncate"
                    >
                      {qr.title}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
              {/* ⚡ Phase 1F — hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                onChange={handleFileSelect}
                className="hidden"
              />
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // ⚡ auto-expand — ขยายตามจำนวนบรรทัด (ไม่ scroll) สูงสุด 120px
                  const ta = e.target;
                  ta.style.height = "auto";
                  ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder={handedOff ? "แชทถูกส่งต่อแอดมิน — กดปุ่มปิดแชทก่อน" : "พิมพ์คำถามที่นี่... (Enter ส่ง · Shift+Enter ขึ้นบรรทัด)"}
                disabled={sending || handedOff}
                className="flex-1 resize-none min-h-[56px] max-h-[120px] px-3 py-2.5 rounded-xl border border-border bg-surface-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-60 overflow-hidden"
              />
              {/* ⚡ Phase 1F — upload button */}
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={sending || handedOff || uploading}
                title="แนบรูป/วิดีโอ"
                aria-label="แนบรูป/วิดีโอ"
                className="self-end"
              >
                {uploading ? <Loading size={16} /> : <Paperclip size={16} />}
              </Button>
              <Button onClick={() => send()} disabled={sending || (!input.trim() && pendingImages.length === 0) || handedOff} className="self-end">
                {sending ? <Loading size={16} /> : <Send size={16} />}
                <span className="hidden sm:inline">ส่ง</span>
              </Button>
              </div>
              {/* ⚡ Phase 1F — pending image previews */}
              {pendingImages.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {pendingImages.map((img, idx) => (
                    <div key={idx} className="relative group">
                      {img.type.startsWith("video/") ? (
                        <div className="w-16 h-16 rounded-lg bg-black flex items-center justify-center border border-border">
                          <Film size={20} className="text-white/70" />
                        </div>
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img.url} alt="รูปที่ส่ง" onError={(e) => e.currentTarget.remove()} className="w-16 h-16 object-cover rounded-lg border border-border" />
                      )}
                      <button
                        onClick={() => removePendingImage(idx)}
                        className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        title="ลบ"
                        aria-label="ลบรูปนี้"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* ── Log Panel — แสดง detail แต่ละ process ──
              Desktop (xl+): sidebar ขวา
              Mobile/Tablet (<xl): overlay จากขวา */}
          {logPanelOpen && (
            <>
              {/* Mobile/Tablet backdrop */}
              <div className="lg:hidden fixed inset-0 bg-black/50 z-40" onClick={() => setLogPanelOpen(false)} />
              <aside className={`
                flex flex-col border-l border-border bg-surface overflow-y-auto
                lg:w-96 lg:static
                fixed inset-y-0 right-0 z-50 w-80 max-w-[85vw] shadow-xl lg:shadow-none
              `}>
                <div className="flex items-center justify-between px-3 py-2.5 border-b border-border sticky top-0 bg-surface z-10">
                  <span className="text-xs font-semibold text-text-muted">Log / Process Detail</span>
                  <div className="flex items-center gap-1">
                    {/* Copy all logs button */}
                  <button
                    onClick={() => {
                      const botMsgs = messages.filter((m) => m.role === "bot" && m.stats);
                      if (botMsgs.length === 0) {
                        toast.error("ยังไม่มี log ใน session นี้");
                        return;
                      }
                      // รวม log ทุกคำถามเป็น text เดียว (รวม input/output ที่ปิดอยู่)
                      const allLogs = botMsgs.map((m, i) => {
                        const header = `\n${"=".repeat(60)}\n[${i + 1}/${botMsgs.length}] Question log\n${"=".repeat(60)}`;
                        return header + "\n" + formatLogForCopy(m.stats!, m.raw || "");
                      }).join("\n");
                      const fullText = `=== Session Log (all ${botMsgs.length} questions) ===\nShop: ${shop || "—"}\nSession: ${currentSessionId || "—"}\nDate: ${new Date().toLocaleString("th-TH")}\n\n${allLogs}`;
                      navigator.clipboard.writeText(fullText).then(() => {
                        toast.success(`คัดลอก log ทั้งหมด ${botMsgs.length} คำถาม แล้ว`);
                      }).catch(() => toast.error("คัดลอกไม่สำเร็จ"));
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border border-border bg-surface-2 text-text-muted hover:text-brand hover:border-brand/40 transition-colors"
                    title="คัดลอก log ทุกคำถามใน session นี้ (รวม input/output)"
                  >
                    <Copy size={11} /> กอปทั้งหมด
                  </button>
                  {/* Toggle: grouped (รายคำถาม) vs all (ทั้งหมด) */}
                  <div className="flex items-center rounded-lg border border-border overflow-hidden">
                    <button
                      onClick={() => setLogViewMode("grouped")}
                      className={`px-2 py-1 text-[10px] font-medium transition-colors ${
                        logViewMode === "grouped" ? "bg-brand/10 text-brand" : "bg-surface-2 text-text-muted hover:text-text"
                      }`}
                      title="รวมหลาย bubble เป็น 1 entry ต่อคำถาม"
                    >
                      รายคำถาม
                    </button>
                    <button
                      onClick={() => setLogViewMode("all")}
                      className={`px-2 py-1 text-[10px] font-medium transition-colors ${
                        logViewMode === "all" ? "bg-brand/10 text-brand" : "bg-surface-2 text-text-muted hover:text-text"
                      }`}
                      title="แสดงทุก bubble แยกกัน"
                    >
                      ทั้งหมด
                    </button>
                  </div>
                  <button onClick={() => setLogPanelOpen(false)} title="ปิด log" aria-label="ปิด log" className="text-text-muted hover:text-text p-1">
                    <X size={14} />
                  </button>
                </div>
              </div>
              <div className="p-3 flex flex-col gap-3">
                {/* Session stats */}
                <div className="rounded-lg border border-border bg-surface-2 p-3">
                  <div className="text-xs font-semibold mb-2">📊 สถิติ session</div>
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <div>คำถาม: <strong>{totals.turns}</strong></div>
                    <div>เวลารวม: <strong>{totals.elapsed.toFixed(1)}s</strong></div>
                    <div>Tokens: <strong>{fmtTokens(totals.total)}</strong></div>
                    <div>↑{fmtTokens(totals.prompt)} ↓{fmtTokens(totals.output)}</div>
                    <div>ต้นทุน: <strong>${totals.cost.toFixed(4)}</strong></div>
                    <div>≈ ฿{(totals.cost * 36).toFixed(2)}</div>
                    <div>Web search: <strong>{totals.wsTurns}</strong> ครั้ง</div>
                    <div>Context: <strong>{lastProducts.length}</strong> ชิ้น</div>
                  </div>
                </div>

                {/* Per-message log — grouped (รายคำถาม) หรือ all (ทั้งหมด) */}
                {(() => {
                  // Group consecutive bot messages (1 คำตอบบอท = 1 กลุ่ม อาจมีหลาย bubble)
                  const botGroups: Msg[][] = [];
                  let curGroup: Msg[] = [];
                  for (const m of messages) {
                    if (m.role === "bot") {
                      curGroup.push(m);
                    } else {
                      if (curGroup.length > 0) { botGroups.push(curGroup); curGroup = []; }
                    }
                  }
                  if (curGroup.length > 0) botGroups.push(curGroup);

                  // grouped mode: 1 entry ต่อกลุ่ม (ใช้ stats ของ bubble แรกที่มี stats)
                  // all mode: ทุก bubble ที่มี stats แสดงแยก
                  const logEntries: { msg: Msg; bubbleCount: number; groupIdx: number }[] = 
                    logViewMode === "grouped"
                      ? botGroups.map((g, gi) => ({
                          msg: g.find((m) => m.stats) || g[0],
                          bubbleCount: g.length,
                          groupIdx: gi,
                        })).filter((e) => e.msg && e.msg.stats)
                      : messages
                          .filter((m) => m.role === "bot" && m.stats)
                          .map((m, i) => ({ msg: m, bubbleCount: 1, groupIdx: i }));

                  if (logEntries.length === 0) {
                    return (
                      <div className="text-xs text-text-muted text-center py-4">ยังไม่มี log — ส่งคำถามเพื่อเริ่ม</div>
                    );
                  }

                  return logEntries.map(({ msg: m, bubbleCount, groupIdx }) => (
                    <div
                      key={m.id}
                      role="button"
                      tabIndex={0}
                      className={`rounded-lg border p-2.5 cursor-pointer hover:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${selectedLogMsg?.id === m.id ? "border-brand bg-brand/5" : "border-border bg-surface-2"}`}
                      onClick={() => setSelectedLogMsg(selectedLogMsg?.id === m.id ? null : m)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedLogMsg(selectedLogMsg?.id === m.id ? null : m);
                        }
                      }}
                    >
                      <div className="text-xs font-medium mb-1 truncate">
                        {m.raw?.slice(0, 60) || "(bot)"}
                        {bubbleCount > 1 && (
                          <span className="ml-1.5 text-[9px] text-brand bg-brand/10 px-1 py-0.5 rounded">
                            {bubbleCount} bubbles
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1 text-[10px]">
                        <span className="px-1.5 py-0.5 rounded bg-surface-3">⏱ {fmtElapsed(m.stats!.elapsed)}</span>
                        <span className="px-1.5 py-0.5 rounded bg-surface-3">🎯 {m.stats!.intent?.intent || "—"}</span>
                        {m.stats!.web_search_used && <span className="px-1.5 py-0.5 rounded bg-brand/10 text-brand">🔍 search</span>}
                      </div>
                      {selectedLogMsg?.id === m.id && m.stats!.steps && (
                        <div className="mt-2 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
                          {/* Copy log button */}
                          <div className="flex justify-end">
                            <button
                              onClick={() => {
                                const logText = formatLogForCopy(m.stats!, m.raw || "");
                                navigator.clipboard.writeText(logText).then(() => {
                                  toast.success("คัดลอก log แล้ว");
                                }).catch(() => toast.error("คัดลอกไม่สำเร็จ"));
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-border bg-surface-2 text-text-muted hover:text-text hover:border-brand/40 transition-colors"
                              title="คัดลอก log ทั้งหมด"
                            >
                              <Copy size={11} /> คัดลอก log
                            </button>
                          </div>
                          {m.stats!.steps.map((s, i) => (
                            <div key={i} className="text-[10px] rounded bg-surface-3 p-2 border border-border/50">
                              {/* Step header */}
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-text">{s.name}</span>
                                <span className="text-text-muted">{s.model}</span>
                              </div>
                              <div className="text-text-muted mt-0.5">
                                tokens: in={s.tokens_in ?? 0} out={s.tokens_out ?? 0} · {s.time_s ?? 0}s · ${(s.cost_usd ?? 0).toFixed(6)} (฿{s.cost_thb ?? 0})
                              </div>
                              {/* Input — collapsible */}
                              {s.input && Object.keys(s.input).length > 0 && (
                                <details className="mt-1.5">
                                  <summary className="cursor-pointer text-text-muted hover:text-text select-none">📥 Input</summary>
                                  <pre className="mt-1 text-[9px] text-text-muted whitespace-pre-wrap break-all max-h-40 overflow-y-auto bg-surface rounded p-1.5">
                                    {JSON.stringify(s.input, null, 1)}
                                  </pre>
                                </details>
                              )}
                              {/* Output — collapsible */}
                              {s.output && Object.keys(s.output).length > 0 && (
                                <details className="mt-1">
                                  <summary className="cursor-pointer text-text-muted hover:text-text select-none">📤 Output</summary>
                                  <pre className="mt-1 text-[9px] text-text-muted whitespace-pre-wrap break-all max-h-40 overflow-y-auto bg-surface rounded p-1.5">
                                    {JSON.stringify(s.output, null, 1)}
                                  </pre>
                                </details>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ));
                })()}
              </div>
            </aside>
            </>
          )}

          {/* Sidebar — settings + products context */}
          <aside
            className={`bg-surface overflow-y-auto p-4 shrink-0 lg:w-80 ${
              sidebarOpen
                ? "fixed inset-y-0 right-0 z-50 w-80 max-w-[85vw] shadow-xl lg:static lg:shadow-none"
                : "hidden lg:block"
            }`}
          >
            {sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(false)}
                title="ปิด sidebar" aria-label="ปิด sidebar"
                className="lg:hidden absolute top-3 right-3 w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center"
              >
                <X size={16} className="text-text-muted" />
              </button>
            )}

            {/* ── Tab menu: Session Stats | All Sessions Stats ── */}
            <div className="mb-4">
              {/* Tab buttons */}
              <div className="flex items-center gap-1 mb-3 border-b border-border">
                {([
                  { id: "session" as const, label: "Session", icon: BarChart3 },
                  { id: "all" as const, label: "All Sessions", icon: BarChart3 },
                  { id: "logs" as const, label: "ประวัติ", icon: History },
                ]).map((t) => {
                  const active = rightTab === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => {
                        setRightTab(t.id);
                        if (t.id === "logs" && actionLogs.length === 0) loadActionLogs();
                      }}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                        active
                          ? "border-brand text-brand"
                          : "border-transparent text-text-muted hover:text-text"
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {/* ── Tab: Session Stats (สถิติ session นี้เท่านั้น) ── */}
              {rightTab === "session" && (
                <div className="space-y-3">
                  {/* จำนวนคำถาม/คำตอบ */}
                  <div className="rounded-lg border border-border bg-surface-2 p-3">
                    <div className="text-xs font-semibold text-text mb-2">📊 การถามตอบ</div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="text-[10px] text-text-muted">คำถาม</div>
                        <div className="text-sm font-semibold text-text">
                          {messages.filter(m => m.role === "user").length}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">คำตอบบอท</div>
                        <div className="text-sm font-semibold text-text">
                          {messages.filter(m => m.role === "bot" && m.stats).length}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* คะแนนรวม session นี้ */}
                  <div className="rounded-lg border border-border bg-surface-2 p-3">
                    <div className="text-xs font-semibold text-text mb-2">⭐ คะแนน session นี้</div>
                    {(() => {
                      const botMsgs = messages.filter(m => m.role === "bot" && m.stats);
                      const starRated = botMsgs.filter(m => m.stats?.star_rating != null && m.stats.star_rating > 0);
                      const starSum = starRated.reduce((s, m) => s + (m.stats?.star_rating || 0), 0);
                      const avgStar = starRated.length > 0 ? starSum / starRated.length : 0;
                      const good = botMsgs.filter(m => m.stats?.rating === "good").length;
                      const bad = botMsgs.filter(m => m.stats?.rating === "bad").length;
                      const unrated = botMsgs.filter(m => !m.stats?.rating || m.stats?.rating === "unrated").length;
                      const commented = botMsgs.filter(m => m.stats?.comment).length;
                      return (
                        <div className="space-y-2 text-xs">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <div className="text-[10px] text-text-muted">ดาวเฉลี่ย</div>
                              <div className="text-sm font-semibold text-yellow-500">
                                {starRated.length > 0 ? `${avgStar.toFixed(1)}★` : "—"}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] text-text-muted">ให้ดาว</div>
                              <div className="text-sm font-semibold text-yellow-500">{starRated.length} ข้อ</div>
                            </div>
                          </div>
                          <div className="pt-2 border-t border-border/60">
                            <div className="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1.5">👍👎 ตอบดี/ไม่ดี</div>
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <div className="text-[10px] text-text-muted">Good</div>
                                <div className="text-sm font-semibold text-green-500">{good}</div>
                              </div>
                              <div>
                                <div className="text-[10px] text-text-muted">Bad</div>
                                <div className="text-sm font-semibold text-red-500">{bad}</div>
                              </div>
                              <div>
                                <div className="text-[10px] text-text-muted">ยังไม่ให้</div>
                                <div className="text-sm font-semibold text-text-muted">{unrated}</div>
                              </div>
                            </div>
                            <div className="mt-1 text-[10px] text-text-muted">
                              คอมเมนต์: {commented} ข้อ
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* เวลา + Token + ราคา */}
                  <div className="rounded-lg border border-border bg-surface-2 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-text">💰 ต้นทุน & เวลา</span>
                      {totals.turns > 0 && (
                        <button
                          onClick={() => setTotals({ turns: 0, elapsed: 0, prompt: 0, output: 0, total: 0, cost: 0, wsTurns: 0, wsCost: 0, wsTokens: 0 })}
                          className="text-text-muted hover:text-text"
                          title="รีเซ็ต"
                          aria-label="รีเซ็ต"
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="text-[10px] text-text-muted">เวลารวม</div>
                        <div className="text-sm font-semibold text-brand tabular-nums">{fmtElapsed(totals.elapsed)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">Tokens รวม</div>
                        <div className="text-sm font-semibold text-text tabular-nums">{fmtTokens(totals.total)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">Prompt (in)</div>
                        <div className="text-sm font-semibold text-text tabular-nums">{fmtTokens(totals.prompt)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">Output (out)</div>
                        <div className="text-sm font-semibold text-text tabular-nums">{fmtTokens(totals.output)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">ต้นทุน USD</div>
                        <div className="text-sm font-semibold text-success tabular-nums">{fmtCost(totals.cost)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">ต้นทุน THB</div>
                        <div className="text-sm font-semibold text-success tabular-nums">{fmtTHB(totals.cost)}</div>
                      </div>
                    </div>
                    {totals.wsTurns > 0 && (
                      <div className="mt-2 pt-2 border-t border-border/60">
                        <div className="text-[10px] uppercase tracking-wide text-success font-semibold mb-1">🔍 Web Search</div>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <div className="text-[10px] text-text-muted">ครั้ง</div>
                            <div className="text-sm font-semibold text-success">{totals.wsTurns}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-muted">Tokens</div>
                            <div className="text-sm font-semibold text-text">{fmtTokens(totals.wsTokens)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-muted">ค่าใช้จ่าย</div>
                            <div className="text-sm font-semibold text-success">{fmtCost(totals.wsCost)}</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── Tab: All Sessions Stats (สถิติรวมทุก session) ── */}
              {rightTab === "all" && (
                <div className="space-y-3">
                  {/* การถามตอบรวม */}
                  <div className="rounded-lg border border-border bg-surface-2 p-3">
                    <div className="text-xs font-semibold text-text mb-2">📊 คำถาม/คำตอบ (ทุก session)</div>
                    {allStats ? (
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-[10px] text-text-muted">คำตอบทั้งหมด</div>
                          <div className="text-sm font-semibold text-text">{allStats.total_ratings}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">คอมเมนต์</div>
                          <div className="text-sm font-semibold text-text">{allStats.commented} ข้อ</div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-text-muted text-center py-3">กำลังโหลด...</div>
                    )}
                  </div>

                  {/* คะแนน rating — good/bad/unrated */}
                  {allStats && (
                    <div className="rounded-lg border border-border bg-surface-2 p-3">
                      <div className="text-xs font-semibold text-text mb-2">👍👎 การให้คะแนนคำตอบ</div>
                      <div className="space-y-2 text-xs">
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <div className="text-[10px] text-text-muted">Good</div>
                            <div className="text-sm font-semibold text-green-500">{allStats.good}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-muted">Bad</div>
                            <div className="text-sm font-semibold text-red-500">{allStats.bad}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-muted">ยังไม่ให้</div>
                            <div className="text-sm font-semibold text-text-muted">{allStats.unrated}</div>
                          </div>
                        </div>
                        <div className="pt-2 border-t border-border/60">
                          <div className="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1.5">⭐ ดาว</div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <div className="text-[10px] text-text-muted">ดาวเฉลี่ย</div>
                              <div className="text-sm font-semibold text-yellow-500">
                                {allStats.star_rated > 0 ? `${"$"}{allStats.avg_star}★` : "—"}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] text-text-muted">ให้ดาว</div>
                              <div className="text-sm font-semibold text-yellow-500">{allStats.star_rated} ข้อ</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Pipeline calls — intent / search / handoff */}
                  {allStats && (
                    <div className="rounded-lg border border-border bg-surface-2 p-3">
                      <div className="text-xs font-semibold text-text mb-2">⚙️ Pipeline calls</div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <div className="text-[10px] text-text-muted">Intent</div>
                          <div className="text-sm font-semibold text-brand">{allStats.intent_calls}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">Web Search</div>
                          <div className="text-sm font-semibold text-success">{allStats.web_search_calls}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">Handoff</div>
                          <div className="text-sm font-semibold text-warning">{allStats.handoff_count}</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ต้นทุน + เวลา + token */}
                  {allStats && (
                    <div className="rounded-lg border border-border bg-surface-2 p-3">
                      <div className="text-xs font-semibold text-text mb-2">💰 ราคา · ⏱ เวลา · 🧮 Token</div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-[10px] text-text-muted">เวลาเฉลี่ย/ข้อ</div>
                          <div className="text-sm font-semibold text-brand">{allStats.avg_elapsed}s</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">Token เฉลี่ย/ข้อ</div>
                          <div className="text-sm font-semibold text-text">{fmtTokens(allStats.avg_tokens)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">Token รวม</div>
                          <div className="text-sm font-semibold text-text">{fmtTokens(allStats.total_tokens)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">ราคารวม USD</div>
                          <div className="text-sm font-semibold text-success">${"$"}{allStats.total_cost_usd.toFixed(4)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">ราคารวม THB</div>
                          <div className="text-sm font-semibold text-success">฿{(allStats.total_cost_usd * 36).toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">เฉลี่ย/ข้อ USD</div>
                          <div className="text-sm font-semibold text-success">${"$"}{allStats.avg_cost_usd.toFixed(6)}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab: Logs (ประวัติการใช้งาน — ใคร ทำอะไร แชทไหน) ── */}
              {rightTab === "logs" && (
                <div className="space-y-3">
                  {/* Scope toggle + refresh */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center rounded-lg border border-border bg-surface-2 p-0.5">
                      <button
                        onClick={() => { setLogsScope("me"); setTimeout(loadActionLogs, 0); }}
                        className={`h-6 px-2 rounded-md text-[10px] transition-colors ${logsScope === "me" ? "bg-brand text-white" : "text-text-muted hover:text-text"}`}
                      >
                        ฉัน
                      </button>
                      <button
                        onClick={() => { setLogsScope("all"); setTimeout(loadActionLogs, 0); }}
                        className={`h-6 px-2 rounded-md text-[10px] transition-colors ${logsScope === "all" ? "bg-brand text-white" : "text-text-muted hover:text-text"}`}
                      >
                        ทุกคน
                      </button>
                    </div>
                    <button
                      onClick={loadActionLogs}
                      className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10px] border border-border text-text-muted hover:text-text hover:bg-surface-2"
                    >
                      <RotateCcw size={11} /> รีเฟรช
                    </button>
                    {logsLoading && <span className="text-[10px] text-text-muted">กำลังโหลด...</span>}
                  </div>

                  {/* Log list */}
                  {actionLogs.length === 0 ? (
                    <div className="text-center py-6 text-xs text-text-muted">
                      {logsLoading ? "กำลังโหลด..." : "ยังไม่มีประวัติ"}
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-[60vh] overflow-y-auto pr-1">
                      {actionLogs.map((log) => {
                        const actionLabel: Record<string, string> = {
                          create_session: "สร้างแชท",
                          add_message: "ส่งข้อความ",
                          delete_session: "ลบแชท",
                          update_session: "แก้ไขแชท",
                          close_session: "ปิดแชท",
                          reopen_session: "เปิดแชทใหม่",
                        };
                        const label = actionLabel[log.action] || log.action;
                        const time = (() => {
                          try {
                            return new Date(log.timestamp).toLocaleString("th-TH", {
                              day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                            });
                          } catch { return log.timestamp; }
                        })();
                        return (
                          <div key={log.id} className="rounded-md border border-border bg-surface-2 p-2 text-[11px]">
                            <div className="flex items-center justify-between gap-2 mb-0.5">
                              <span className="font-medium text-text">{label}</span>
                              <span className="text-text-subtle font-mono text-[10px]">{time}</span>
                            </div>
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-text-muted text-[10px]">
                              <span>👤 {log.admin_name || log.admin_id || "—"}</span>
                              {log.shop && <span>🏪 {log.shop}</span>}
                              {log.session_id && (
                                <span className="font-mono text-text-subtle">
                                  #{log.session_id.slice(-6)}
                                </span>
                              )}
                            </div>
                            {log.text_preview && (
                              <div className="mt-1 text-text-muted text-[10px] truncate">
                                {log.role === "user" ? "❓ " : log.role === "model" ? "🤖 " : ""}
                                {log.text_preview}
                              </div>
                            )}
                            {log.title && log.action === "create_session" && (
                              <div className="mt-1 text-text-muted text-[10px] truncate">
                                ชื่อ: {log.title}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Settings */}
            <div className="mb-4">
              <label className="block text-xs text-text-muted mb-1">ร้านในเครือ (ถ้ารู้)</label>
              <select
                value={shop}
                onChange={(e) => {
                  const newShop = e.target.value;
                  setShop(newShop);
                  // ⚡ ถ้ามี session อยู่ → อัปเดต shop ใน DB ด้วย
                  if (currentSessionId) {
                    updateSessionShop(currentSessionId, newShop);
                  }
                }}
                className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              >
                <option value="">— ทุกร้าน —</option>
                {shops.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-xs text-text-muted mb-1">จำนวนสินค้าใน context</label>
              <input
                type="number"
                min={1}
                max={50}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
                className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
            </div>

            {/* Products context */}
            <div className="flex items-center gap-1.5 mb-2">
              <Package size={13} className="text-text-muted" />
              <h2 className="text-xs uppercase tracking-wide text-text-muted font-semibold">สินค้าที่ใช้ตอบ</h2>
            </div>
            <div className="flex flex-col gap-2">
              {lastProducts.length === 0 ? (
                <div className="text-xs text-text-subtle">ยังไม่มี — ลองถามอะไรดู</div>
              ) : (
                lastProducts.map((p, i) => (
                  <div key={p.item_id || i} className="bg-surface-2 border border-border rounded-lg p-2.5 text-xs">
                    <div className="font-semibold text-text mb-1">{escapeHtml(p.name || "(ไม่มีชื่อ)")}</div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-text-muted">
                      <span>🏷️ {escapeHtml(p.brand || "—")}</span>
                      <span>🏪 {escapeHtml(p.shop || "—")}</span>
                      <span className="text-success">{formatPrice(p.price)}</span>
                      {warrantyText(p.warranty) && (
                        <span className="text-warning">🛡️ {escapeHtml(warrantyText(p.warranty))}</span>
                      )}
                    </div>
                    {p.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt={p.name || "รูปสินค้า"} className="w-full max-h-28 object-contain mt-2 rounded bg-surface" onError={(e) => e.currentTarget.remove()} />
                    )}
                    {p.short_link && (
                      <a href={p.short_link} target="_blank" rel="noopener noreferrer" className="block mt-1.5 text-brand hover:underline truncate">
                        {escapeHtml(p.short_link)}
                      </a>
                    )}
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>

        {/* Mobile backdrop — settings sidebar */}
        {sidebarOpen && <div className="lg:hidden fixed inset-0 bg-black/40 z-40" onClick={() => setSidebarOpen(false)} />}

        {/* Session list drawer — mobile/tablet */}
        {sessionListOpen && (
          <>
            <div className="lg:hidden fixed inset-0 bg-black/40 z-40" onClick={() => setSessionListOpen(false)} />
            <div className="lg:hidden fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-surface shadow-xl flex flex-col overflow-hidden animate-slide-in">
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
                <span className="text-xs font-semibold text-text-muted">ประวัติแชท</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { createSession(); setSessionListOpen(false); }}
                    className="inline-flex items-center gap-1 px-2 h-7 text-xs rounded-lg bg-brand text-white hover:bg-brand/90"
                    title="สร้างแชทใหม่"
                  >
                    <Plus size={12} /> ใหม่
                  </button>
                  <button
                    onClick={() => setSessionListOpen(false)}
                    title="ปิด" aria-label="ปิด"
                    className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center"
                  >
                    <X size={16} className="text-text-muted" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {/* Session list items — render same as sidebar */}
                {sessions.length === 0 ? (
                  <div className="text-center text-xs text-text-muted py-8">ไม่มีแชททดสอบ</div>
                ) : (
                  sessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => { loadSession(s.id); setSessionListOpen(false); }}
                      className={`w-full text-left px-3 py-2.5 border-b border-border/50 hover:bg-surface-2 transition-colors ${
                        s.id === currentSessionId ? "bg-brand/5 border-l-2 border-l-brand" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-text truncate">{s.title || "แชททดสอบ"}</span>
                        <span className="text-[10px] text-text-subtle shrink-0">{s.updated_at ? new Date(s.updated_at).toLocaleDateString("th-TH", { month: "short", day: "numeric" }) : ""}</span>
                      </div>
                      <div className="text-[10px] text-text-muted mt-0.5 truncate">{s.shop || "—"}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
