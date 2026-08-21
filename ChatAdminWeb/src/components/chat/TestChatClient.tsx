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
} from "lucide-react";
import type { Platform } from "@/lib/types";

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
}

interface Msg {
  id: number;
  role: "user" | "bot" | "sys";
  html: string;
  raw?: string;
  products?: Product[];
  stats?: MsgStats;
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
  const [lastProducts, setLastProducts] = useState<Product[]>([]);
  const [totals, setTotals] = useState<{ turns: number; elapsed: number; prompt: number; output: number; total: number; cost: number }>({
    turns: 0, elapsed: 0, prompt: 0, output: 0, total: 0, cost: 0,
  });
  const historyRef = useRef<{ role: "user" | "model"; text: string }[]>([]);
  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/chatbot/shops")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setShops(d.shops || []))
      .catch(() => setShops([]));
  }, []);

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
      const html = formatAnswer(answerText);
      historyRef.current.push({ role: "model", text: answerText });
      setLastProducts(j.products || []);
      const stats: MsgStats = {
        elapsed: typeof j.elapsed === "number" ? j.elapsed : undefined,
        usage: j.usage || undefined,
        cost: typeof j.cost === "number" ? j.cost : undefined,
        model: j.model,
        source: j.source,
      };
      setTotals((t) => ({
        turns: t.turns + 1,
        elapsed: t.elapsed + (stats.elapsed || 0),
        prompt: t.prompt + (stats.usage?.prompt || 0),
        output: t.output + (stats.usage?.output || 0),
        total: t.total + (stats.usage?.total || 0),
        cost: t.cost + (stats.cost || 0),
      }));
      setMessages((prev) =>
        prev.map((m) =>
          m.id === spinnerMsg.id ? { ...m, html, raw: answerText, products: j.products || [], stats } : m
        )
      );
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

  // Platform ที่ยังไม่มีบอทของจริง — โชว์สถานะ "ยังไม่เชื่อมต่อ" ไม่ยิง API
  if (!meta.available) {
    return (
      <div className="h-full flex flex-col bg-surface">
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
          opacity: 0; transition: opacity .15s;
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
        .tc-msg img { max-width: 100%; max-height: 220px; object-fit: contain; border-radius: 10px; margin: 8px 0 4px; background: var(--surface-2, #f1f5f9); display: block; }
        .tc-msg .img-caption { font-size: 11px; color: var(--muted, #64748b); margin-bottom: 8px; }
        .tc-msg .table-wrap { overflow-x: auto; max-width: 100%; margin: 10px 0 14px; border: 1px solid var(--border, #e2e8f0); border-radius: 10px; -webkit-overflow-scrolling: touch; }
        .tc-msg table { width: 100%; max-width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; background: var(--surface-2, #f1f5f9); table-layout: fixed; }
        .tc-msg table thead th { background: var(--surface-2, #f1f5f9); color: var(--text, #0f172a); font-weight: 600; text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border, #e2e8f0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

      <div className="h-full flex flex-col bg-surface">
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
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden inline-flex items-center gap-1.5 px-3 h-8 text-xs rounded-lg border border-border bg-surface-2 text-text-muted"
          >
            <Settings2 size={14} /> ตั้งค่า
          </button>
        </div>

        {/* Main grid */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_320px]">
          {/* Chat column */}
          <section className="flex flex-col min-h-0 border-r border-border">
            <div ref={msgsRef} className="flex-1 overflow-y-auto p-4 md:p-5 flex flex-col gap-3">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`tc-msg relative max-w-[min(88%,680px)] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words overflow-hidden ${
                    m.role === "user"
                      ? "self-end bg-brand text-white rounded-br-md"
                      : m.role === "bot"
                      ? "self-start bg-surface-2 border border-border rounded-bl-md max-w-[min(92%,720px)]"
                      : "self-center bg-transparent text-text-muted text-xs"
                  }`}
                >
                  {m.role === "bot" && m.raw ? (
                    <>
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

          {/* Sidebar — settings + products context */}
          <aside
            className={`bg-surface overflow-y-auto p-4 ${
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

            {/* Session stats */}
            <div className={`rounded-xl border border-border p-3 mb-4 bg-gradient-to-br from-surface-2 to-brand-soft/30`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] uppercase tracking-wide text-text-muted font-semibold">
                  สถิติเซสชัน ({totals.turns} รอบ)
                </h3>
                {totals.turns > 0 && (
                  <button
                    onClick={() => setTotals({ turns: 0, elapsed: 0, prompt: 0, output: 0, total: 0, cost: 0 })}
                    className="text-text-muted hover:text-text"
                    title="รีเซ็ต"
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-text-muted">เวลารวม</div>
                  <div className="text-sm font-semibold text-brand tabular-nums">{fmtElapsed(totals.elapsed)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">Tokens รวม</div>
                  <div className="text-sm font-semibold text-text tabular-nums">{fmtTokens(totals.total)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">Prompt</div>
                  <div className="text-sm font-semibold text-text tabular-nums">{fmtTokens(totals.prompt)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">Output</div>
                  <div className="text-sm font-semibold text-text tabular-nums">{fmtTokens(totals.output)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">ต้นทุน (USD)</div>
                  <div className="text-sm font-semibold text-emerald-500 tabular-nums">{fmtCost(totals.cost)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted">ต้นทุน (~THB)</div>
                  <div className="text-sm font-semibold text-emerald-500 tabular-nums">{fmtTHB(totals.cost)}</div>
                </div>
              </div>
            </div>

            {/* Settings */}
            <div className="mb-4">
              <label className="block text-xs text-text-muted mb-1">ร้านในเครือ (ถ้ารู้)</label>
              <select
                value={shop}
                onChange={(e) => setShop(e.target.value)}
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
