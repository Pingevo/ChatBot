"use client";
import { useState, useRef, useEffect, FormEvent } from "react";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";
import { Badge } from "@/components/ui/Badge";
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
} from "lucide-react";
import type { Platform } from "@/lib/types";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { RateBox } from "@/components/shadow/RateBox";

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
}

/* ---- markdown → HTML (port จากเดิม) ---- */
function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function inlineFmt(s: string): string {
  s = s.replace(
    /!\[([\s\S]*?)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, alt, url) =>
      `<img src="${url}" alt="${escapeHtml(alt)}" onerror="this.remove()" /><div class="img-caption">${escapeHtml(alt)}</div>`
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
  const [limit, setLimit] = useState(10);
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [lastProducts, setLastProducts] = useState<Product[]>([]);
  const [totals, setTotals] = useState<{ turns: number; elapsed: number; prompt: number; output: number; total: number; cost: number; wsTurns: number; wsCost: number; wsTokens: number }>({
    turns: 0, elapsed: 0, prompt: 0, output: 0, total: 0, cost: 0, wsTurns: 0, wsCost: 0, wsTokens: 0,
  });
  const [copyAllLabel, setCopyAllLabel] = useState("คัดลอกแชททั้งหมด");
  const historyRef = useRef<{ role: "user" | "model"; text: string }[]>([]);
  const msgsRef = useRef<HTMLDivElement>(null);
  // ── Right panel tab + all-sessions stats ──
  const [rightTab, setRightTab] = useState<"session" | "all">("session");
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

  // ── Session management ──
  const [sessions, setSessions] = useState<{ id: string; shop: string; title: string; message_count: number; updated_at?: string; created_at?: string }[]>([]);
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
      const r = await fetch(`/api/chatbot/shopee/test-chat/sessions?limit=200`);
      if (r.ok) {
        const d = await r.json();
        setSessions(d.sessions || []);
      }
    } catch {}
  }

  async function createSession() {
    // ⚡ อนุญาตให้สร้าง session โดยไม่ต้องเลือกร้าน — เลือกทีหลังได้
    try {
      const r = await fetch("/api/chatbot/shopee/test-chat/sessions", {
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
    } catch {}
  }

  async function loadSession(id: string) {
    try {
      const r = await fetch(`/api/chatbot/shopee/test-chat/sessions/${id}`);
      if (!r.ok) return;
      const d = await r.json();
      setCurrentSessionId(id);
      setShop(d.shop || "");
      const loadedMsgs: Msg[] = [];
      let hist: { role: "user" | "model"; text: string }[] = [];
      let tot = { turns: 0, elapsed: 0, prompt: 0, output: 0, total: 0, cost: 0, wsTurns: 0, wsCost: 0, wsTokens: 0 };
      for (const m of d.messages || []) {
        const msgIdx = loadedMsgs.length;  // track array index in session
        if (m.role === "user") {
          loadedMsgs.push({ id: msgIdCounter++, role: "user", html: escapeHtml(m.text), raw: m.text, sessionMsgIndex: msgIdx });
          hist.push({ role: "user", text: m.text });
        } else if (m.role === "model") {
          loadedMsgs.push({
            id: msgIdCounter++,
            role: "bot",
            html: formatAnswer(m.text),
            raw: m.text,
            stats: m.stats || {},
            sessionMsgIndex: msgIdx,
          });
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
    } catch {}
  }

  async function deleteSession(id: string) {
    if (!confirm("ลบแชทนี้?")) return;
    try {
      await fetch(`/api/chatbot/shopee/test-chat/sessions/${id}`, { method: "DELETE" });
      if (currentSessionId === id) {
        setCurrentSessionId(null);
        setMessages([{ id: msgIdCounter++, role: "sys", html: `พิมพ์คำถามด้านล่างเพื่อทดสอบบอท${meta.label}` }]);
        historyRef.current = [];
      }
      await loadSessions();
    } catch {}
  }

  async function saveMessageToSession(role: "user" | "model", text: string, stats?: MsgStats) {
    if (!currentSessionId) return;
    try {
      // คำนวณ index ของ message ใหม่ใน array (ก่อน push)
      const msgIndex = messages.filter(m => m.role !== "sys").length;
      await fetch(`/api/chatbot/shopee/test-chat/sessions/${currentSessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: currentSessionId,
          message: { role, text, stats: stats || {} },
        }),
      });
      // track sessionMsgIndex ใน local state
      setMessages(prev => prev.map(m =>
        m.role !== "sys" && !m.sessionMsgIndex ? { ...m, sessionMsgIndex: msgIndex } : m
      ));
      loadSessions(); // refresh sidebar
    } catch {}
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
    } catch {}
  }

  // ── Load all-sessions stats (จาก Next.js) ──
  async function loadAllStats() {
    try {
      const r = await fetch(`/api/test-chat-ratings?mode=stats`);
      if (r.ok) setAllStats(await r.json());
    } catch {}
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
    } catch {}
  }

  // ⚡ อัปเดต shop ของ session ใน DB (เมื่อผู้ใช้เปลี่ยนร้านในแชทที่มีอยู่)
  async function updateSessionShop(sessionId: string, newShop: string) {
    try {
      await fetch(`/api/chatbot/shopee/test-chat/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: newShop }),
      });
      loadSessions(); // refresh sidebar
    } catch {}
  }

  // ⚡ อัปเดต title ของ session ใน DB (แก้ชื่อแชท)
  async function updateSessionTitle(sessionId: string, newTitle: string) {
    try {
      await fetch(`/api/chatbot/shopee/test-chat/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
      loadSessions(); // refresh sidebar
    } catch {}
  }

  useEffect(() => {
    fetch("/api/chatbot/shops")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setShops(d.shops || []))
      .catch(() => setShops([]));
    loadSessions();
    loadAllStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    } catch {}
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setSending(true);

    const userMsg: Msg = { id: msgIdCounter++, role: "user", html: escapeHtml(message) };
    const spinnerMsg: Msg = { id: msgIdCounter++, role: "bot", html: '<span class="tc-spinner"></span>กำลังคิด...' };
    setMessages((prev) => [...prev, userMsg, spinnerMsg]);
    const priorHistory = historyRef.current.slice(-10).map((h) => ({ role: h.role, text: h.text }));
    historyRef.current.push({ role: "user", text: message });
    saveMessageToSession("user", message);

    try {
      const payload: Record<string, unknown> = { message, limit, history: priorHistory };
      if (shop) payload.shop = shop;
      const r = await fetch("/api/chatbot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const errText = `เกิดข้อผิดพลาด (${r.status}): ${j.detail || j.error || r.statusText || "ไม่ทราบสาเหตุ"}`;
        setMessages((prev) =>
          prev.map((m) => (m.id === spinnerMsg.id ? { ...m, html: `<span style="color:#f87171">${escapeHtml(errText)}</span>` } : m))
        );
        return;
      }
      const answerText = j.answer || "(ไม่มีคำตอบ)";
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
      // segment แรก → แทนที่ spinnerMsg (มี stats + products + feedback)
      // segment ถัดไป → เพิ่มเป็น message ใหม่ (สืบต่อจาก segment แรก)
      setMessages((prev) => {
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === spinnerMsg.id);
        if (idx === -1) return prev;
        // แทนที่ spinner ด้วย segment แรก (พร้อม stats + products + feedback)
        next[idx] = {
          ...next[idx],
          html: formatAnswer(bubbles[0]),
          raw: bubbles[0],
          products: j.products || [],
          stats,
        };
        // เพิ่ม segment ถัดไปเป็น bubble ใหม่ (stats/products อยู่ที่ segment แรก ไม่ซ้ำ)
        const extraMsgs: Msg[] = bubbles.slice(1).map((seg) => ({
          id: msgIdCounter++,
          role: "bot",
          html: formatAnswer(seg),
          raw: seg,
        }));
        next.splice(idx + 1, 0, ...extraMsgs);
        return next;
      });
      // save bot response to session
      saveMessageToSession("model", answerText, stats);
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === spinnerMsg.id ? { ...m, html: '<span style="color:#f87171">เกิดข้อผิดพลาดในการเชื่อมต่อ server</span>' } : m
        )
      );
    } finally {
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
              <h1 className="text-base font-semibold text-text truncate">ทดสอบบอท — {meta.label}</h1>
              <div className="text-xs text-text-muted flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-text-subtle inline-block" />
                ยังไม่เชื่อมต่อ
              </div>
            </div>
          </div>
        </div>

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
          border: 1px solid var(--border, #e2e8f0); background: var(--surface-2, #f1f5f9);
          color: var(--muted, #64748b); font-size: 11px; cursor: pointer;
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
          border: 1px solid var(--border, #e2e8f0); background: var(--surface-2, #f1f5f9);
          color: var(--muted, #64748b); font-size: 13px; cursor: pointer; line-height: 1;
        }
        .tc-msg .stats {
          margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border, #e2e8f0);
          font-size: 11px; color: var(--muted, #64748b); display: flex; flex-wrap: wrap; gap: 4px 10px;
          font-variant-numeric: tabular-nums;
        }
        .tc-msg .stats .pill {
          padding: 1px 6px; border-radius: 6px; background: var(--surface-2, #f1f5f9);
          border: 1px solid var(--border, #e2e8f0); white-space: nowrap;
        }
        .tc-msg .stats .pill.cost { color: #34d399; border-color: rgba(52,211,153,0.3); background: rgba(52,211,153,0.06); }
        .tc-msg .stats .pill.time { color: var(--brand, #087e8b); border-color: rgba(8,126,139,0.3); background: rgba(8,126,139,0.06); }
        .tc-msg .stats .pill.model { color: var(--muted, #64748b); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
        .tc-msg .stats .pill.intent { color: #a78bfa; border-color: rgba(167,139,250,0.3); background: rgba(167,139,250,0.06); }
        .tc-msg .stats .pill.timing { color: #fbbf24; border-color: rgba(251,191,36,0.3); background: rgba(251,191,36,0.06); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
        .tc-msg .stats .pill.device { color: #60a5fa; border-color: rgba(96,165,250,0.3); background: rgba(96,165,250,0.06); }
        .tc-msg .stats .pill.websearch { color: #10b981; border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.08); font-weight: 600; }
        .tc-msg .stats .pill.websearch-reason { color: #f97316; border-color: rgba(249,115,22,0.3); background: rgba(249,115,22,0.06); font-size: 10px; }
        .tc-msg .stats .pill.muted { color: #6b7280; border-color: rgba(107,114,128,0.2); background: rgba(107,114,128,0.04); opacity: 0.6; }
        .tc-msg .stats .pill.step-detail { font-size: 10px; padding: 2px 6px; background: rgba(99,102,241,0.08); border-color: rgba(99,102,241,0.2); color: #4f46e5; }
        .tc-msg.bot.web-search-bubble {
          background: linear-gradient(135deg, rgba(16,185,129,0.08), rgba(52,211,153,0.04)) !important;
          border-color: rgba(16,185,129,0.35) !important;
          border-left: 3px solid #10b981 !important;
        }
        .tc-msg .web-search-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 8px; border-radius: 6px; margin-bottom: 6px;
          background: rgba(16,185,129,0.12); color: #059669;
          font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
        }
        .tc-msg .stats .debug-row { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
        .tc-msg .stats .debug-label { font-size: 9px; color: var(--muted, #64748b); text-transform: uppercase; letter-spacing: 0.05em; margin-right: 2px; }
        .tc-msg img { max-width: 100%; max-height: 220px; object-fit: contain; border-radius: 10px; margin: 8px 0 4px; background: var(--surface-2, #f1f5f9); display: block; }
        .tc-msg .img-caption { font-size: 11px; color: var(--muted, #64748b); margin-bottom: 8px; }
        .tc-msg .table-wrap { overflow-x: auto; max-width: 100%; margin: 10px 0 14px; border: 1px solid var(--border, #e2e8f0); border-radius: 10px; -webkit-overflow-scrolling: touch; }
        .tc-msg table { width: 100%; max-width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; background: var(--surface-2, #f1f5f9); table-layout: fixed; }
        .tc-msg table thead th { background: var(--surface-2, #f1f5f9); color: var(--text, #0f172a); font-weight: 600; text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border, #e2e8f0); word-break: break-word; overflow: hidden; text-overflow: ellipsis; }
        .tc-msg table tbody td { padding: 7px 10px; border-bottom: 1px solid var(--border, #e2e8f0); vertical-align: top; word-break: break-word; overflow: hidden; text-overflow: ellipsis; }
        .tc-msg table tbody tr:last-child td { border-bottom: 0; }
        .tc-msg table tbody tr:nth-child(even) td { background: rgba(0,0,0,0.02); }
        .tc-msg table .price { color: #34d399; font-weight: 600; }
        .tc-msg table .warranty { color: #fbbf24; }
        .tc-msg ul, .tc-msg ol { margin: 6px 0 6px 18px; padding: 0; }
        .tc-msg li { margin: 2px 0; }
        .tc-msg p { margin: 4px 0; }
        .tc-spinner {
          width: 14px; height: 14px; border: 2px solid var(--muted, #64748b);
          border-top-color: var(--brand, #087e8b); border-radius: 50%;
          animation: tc-spin 0.8s linear infinite; display: inline-block; vertical-align: middle; margin-right: 6px;
        }
        @keyframes tc-spin { to { transform: rotate(360deg); } }
        @media (max-width: 768px) {
          .tc-msg .feedback-btns { opacity: 1; }
          .tc-msg .copy-btn { opacity: 1; }
        }
      `}</style>

      <div className="h-full min-h-0 flex flex-col bg-surface">
        {/* Header — platform themed */}
        <div className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-border bg-surface shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${meta.gradient} flex items-center justify-center shrink-0 shadow-sm`}>
              <PlatformIcon platform={platform} size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-text truncate">ทดสอบบอท — {meta.label}</h1>
              <div className="text-xs text-text-muted flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-brand inline-block" />
                Gemini + MongoDB · เชื่อมต่อแล้ว
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button
                onClick={copyAllChat}
                className="inline-flex items-center gap-1.5 px-3 h-8 text-xs rounded-lg border border-border bg-surface-2 text-text-muted hover:text-text hover:bg-surface-3 transition-colors"
                title="คัดลอกแชททั้งหมด พร้อม stats"
              >
                <Copy size={14} /> {copyAllLabel}
              </button>
            )}
            <button
              onClick={() => setLogPanelOpen((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 h-8 text-xs rounded-lg border border-border ${logPanelOpen ? "bg-brand/10 text-brand border-brand/30" : "bg-surface-2 text-text-muted"}`}
              title="เปิด/ปิด log panel"
            >
              <Terminal size={14} /> Log
            </button>
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden inline-flex items-center gap-1.5 px-3 h-8 text-xs rounded-lg border border-border bg-surface-2 text-text-muted"
            >
              <Settings2 size={14} /> ตั้งค่า
            </button>
          </div>
        </div>

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
                    onClick={() => loadSession(s.id)}
                    className={`group flex items-center justify-between px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-surface-2 ${currentSessionId === s.id ? "bg-brand/5 border-l-2 border-l-brand" : ""}`}
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
                        <div className="text-xs font-medium text-text truncate">{s.title || "ไม่มีชื่อ"}</div>
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
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                        className="text-text-muted hover:text-red-500 p-1"
                        title="ลบ"
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
              {messages.map((m) => (
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
                              m.stats.steps.map((s, i) => (
                                <span key={i} className="pill step-detail" title={`${s.model} · in:${s.tokens_in} out:${s.tokens_out} · ${s.time_s}s · ฿${s.cost_thb}`}>
                                  <strong>{s.name}</strong> · {s.model.split("/").pop()} · in:{s.tokens_in} out:{s.tokens_out} · {s.time_s}s · ฿{s.cost_thb}
                                </span>
                              ))
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
                          onClick={() => sendFeedback(m.raw!, "up")}
                        >
                          <ThumbsUp size={12} />
                        </button>
                        <button
                          title="ตอบไม่ดี"
                          onClick={() => sendFeedback(m.raw!, "down")}
                        >
                          <ThumbsDown size={12} />
                        </button>
                      </div>

                      {/* ── RateBox — ใช้ component ร่วมกับ shadow panels ── */}
                      {m.sessionMsgIndex != null && (
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
                    <span dangerouslySetInnerHTML={{ __html: m.html }} />
                  )}
                </div>
              ))}
            </div>

            {/* Composer */}
            <div className="flex gap-2 p-3 border-t border-border bg-surface shrink-0">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="พิมพ์คำถามที่นี่... (Enter ส่ง · Shift+Enter ขึ้นบรรทัด)"
                disabled={sending}
                className="flex-1 resize-none h-14 px-3 py-2.5 rounded-xl border border-border bg-surface-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
              />
              <Button onClick={() => send()} disabled={sending || !input.trim()} className="self-end">
                {sending ? <Loading size={16} /> : <Send size={16} />}
                <span className="hidden sm:inline">ส่ง</span>
              </Button>
            </div>
          </section>

          {/* ── Log Panel — แสดง detail แต่ละ process ── */}
          {logPanelOpen && (
            <aside className="hidden lg:flex w-96 shrink-0 flex-col border-l border-border bg-surface overflow-y-auto">
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-border sticky top-0 bg-surface z-10">
                <span className="text-xs font-semibold text-text-muted">Log / Process Detail</span>
                <button onClick={() => setLogPanelOpen(false)} className="text-text-muted hover:text-text p-1">
                  <X size={14} />
                </button>
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

                {/* Per-message log */}
                {messages.filter((m) => m.role === "bot" && m.stats).map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-lg border p-2.5 cursor-pointer hover:border-brand/40 ${selectedLogMsg?.id === m.id ? "border-brand bg-brand/5" : "border-border bg-surface-2"}`}
                    onClick={() => setSelectedLogMsg(selectedLogMsg?.id === m.id ? null : m)}
                  >
                    <div className="text-xs font-medium mb-1 truncate">{m.raw?.slice(0, 60) || "(bot)"}</div>
                    <div className="flex flex-wrap gap-1 text-[10px]">
                      <span className="px-1.5 py-0.5 rounded bg-surface-3">⏱ {fmtElapsed(m.stats!.elapsed)}</span>
                      <span className="px-1.5 py-0.5 rounded bg-surface-3">🎯 {m.stats!.intent?.intent || "—"}</span>
                      {m.stats!.web_search_used && <span className="px-1.5 py-0.5 rounded bg-brand/10 text-brand">🔍 search</span>}
                    </div>
                    {selectedLogMsg?.id === m.id && m.stats!.steps && (
                      <div className="mt-2 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
                        {m.stats!.steps.map((s, i) => (
                          <div key={i} className="text-[10px] rounded bg-surface-3 p-2 border border-border/50">
                            {/* Step header */}
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-text">{s.name}</span>
                              <span className="text-text-muted">{s.model}</span>
                            </div>
                            <div className="text-text-muted mt-0.5">
                              tokens: in={s.tokens_in} out={s.tokens_out} · {s.time_s}s · ${s.cost_usd.toFixed(6)} (฿{s.cost_thb})
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
                ))}
                {messages.filter((m) => m.role === "bot" && m.stats).length === 0 && (
                  <div className="text-xs text-text-muted text-center py-4">ยังไม่มี log — ส่งคำถามเพื่อเริ่ม</div>
                )}
              </div>
            </aside>
          )}

          {/* Sidebar — settings + products context */}
          <aside
            className={`bg-surface overflow-y-auto p-4 shrink-0 lg:w-80 lg:min-h-0 ${
              sidebarOpen
                ? "fixed inset-y-0 right-0 z-50 w-80 max-w-[85vw] shadow-xl lg:static lg:shadow-none"
                : "hidden lg:block"
            }`}
          >
            {sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(false)}
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
                ]).map((t) => {
                  const active = rightTab === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setRightTab(t.id)}
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
                        <div className="text-sm font-semibold text-emerald-500 tabular-nums">{fmtCost(totals.cost)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">ต้นทุน THB</div>
                        <div className="text-sm font-semibold text-emerald-500 tabular-nums">{fmtTHB(totals.cost)}</div>
                      </div>
                    </div>
                    {totals.wsTurns > 0 && (
                      <div className="mt-2 pt-2 border-t border-border/60">
                        <div className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold mb-1">🔍 Web Search</div>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <div className="text-[10px] text-text-muted">ครั้ง</div>
                            <div className="text-sm font-semibold text-emerald-600">{totals.wsTurns}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-muted">Tokens</div>
                            <div className="text-sm font-semibold text-text">{fmtTokens(totals.wsTokens)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-muted">ค่าใช้จ่าย</div>
                            <div className="text-sm font-semibold text-emerald-600">{fmtCost(totals.wsCost)}</div>
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
                          <div className="text-sm font-semibold text-emerald-500">{allStats.web_search_calls}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">Handoff</div>
                          <div className="text-sm font-semibold text-amber-500">{allStats.handoff_count}</div>
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
                          <div className="text-sm font-semibold text-emerald-500">${"$"}{allStats.total_cost_usd.toFixed(4)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">ราคารวม THB</div>
                          <div className="text-sm font-semibold text-emerald-500">฿{(allStats.total_cost_usd * 36).toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted">เฉลี่ย/ข้อ USD</div>
                          <div className="text-sm font-semibold text-emerald-500">${"$"}{allStats.avg_cost_usd.toFixed(6)}</div>
                        </div>
                      </div>
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
                className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
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
                className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
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
                      <span className="text-emerald-500">{formatPrice(p.price)}</span>
                      {warrantyText(p.warranty) && (
                        <span className="text-amber-500">🛡️ {escapeHtml(warrantyText(p.warranty))}</span>
                      )}
                    </div>
                    {p.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt="" className="w-full max-h-28 object-contain mt-2 rounded bg-surface" onError={(e) => e.currentTarget.remove()} />
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

        {/* Mobile backdrop */}
        {sidebarOpen && <div className="lg:hidden fixed inset-0 bg-black/40 z-40" onClick={() => setSidebarOpen(false)} />}
      </div>
    </>
  );
}
