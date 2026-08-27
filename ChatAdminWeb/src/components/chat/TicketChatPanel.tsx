// TicketChatPanel — middle column: ticket metadata bar + chat history + composer (Zaapi-style)
// This replaces the old ChatWindow for the /tickets route, combining ticket fields and chat.
"use client";
import { useState, useRef, useEffect, FormEvent } from "react";
import {
  Send,
  Bot,
  Headset,
  AlertCircle,
  Sparkles,
  ChevronDown,
  User,
  CheckCircle2,
  Hash,
  Zap,
  RotateCcw,
  Lock,
  UserCog,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { quickReplyService, type QuickReplyRow } from "@/lib/services";
import type { Conversation, ChatMessage, Topic } from "@/lib/types";
import { MessageContent } from "./MessageContent";

// ─── label maps ────────────────────────────────────────────────────────────────

const statusLabels: Record<string, string> = {
  open: "เปิด",
  in_progress: "กำลังทำ",
  resolved: "เสร็จแล้ว",
  closed: "ปิดแล้ว",
};

const statusTone: Record<string, "brand" | "coral" | "neutral" | "pale"> = {
  open: "coral",
  in_progress: "brand",
  resolved: "neutral",
  closed: "pale",
};

const priorityLabels: Record<string, string> = {
  urgent: "ด่วนมาก",
  high: "ด่วน",
  medium: "ปานกลาง",
  low: "ปกติ",
};

const topicLabels: Record<Topic, string> = {
  product_inquiry: "สอบถามสินค้า",
  product_compare: "เปรียบเทียบสินค้า",
  usage_help: "การใช้งาน",
  claim: "เคลม",
  warranty: "รับประกัน",
  problem_report: "แจ้งปัญหา",
  tax_invoice: "ใบกำกับภาษี",
  shipping: "จัดส่ง",
  general: "ทั่วไป",
  handoff: "ส่งแอดมิน",
};

const resolutionOptions = [
  "ส่งสินค้าทดแทน",
  "คืนเงิน",
  "ให้คูปอง",
  "แจ้งทีมซ่อม",
  "ไม่ดำเนินการ",
  "อื่นๆ",
];

// ─── Dropdown ──────────────────────────────────────────────────────────────────

interface DropdownProps {
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}

function InlineDropdown({ label, value, options, onChange }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-surface-2 border border-border hover:bg-pale-sky-soft hover:border-brand/40 transition-colors min-w-[80px]"
      >
        <span className="text-text-muted text-[10px] whitespace-nowrap">{label}:</span>
        <span className="text-text font-medium truncate max-w-[100px]">
          {selected?.label ?? "เลือก"}
        </span>
        <ChevronDown size={10} className="text-text-subtle shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-44 bg-surface rounded-lg shadow-xl border border-border py-1 text-sm max-h-52 overflow-y-auto">
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`w-full flex items-center justify-between px-3 py-1.5 hover:bg-surface-2 text-left transition-colors ${
                o.value === value ? "text-brand font-medium" : "text-text"
              }`}
            >
              {o.label}
              {o.value === value && <CheckCircle2 size={12} className="text-brand shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const isAdmin = msg.role === "admin";
  const isBot = msg.role === "bot";
  const isSystem = msg.role === "system";

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <span className="text-[11px] text-text-subtle bg-surface-2 px-3 py-1 rounded-full">
          {msg.text}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex gap-2.5 ${isUser ? "justify-start" : "justify-end"} animate-fade-in`}>
      {isUser && <Avatar name="User" size={32} className="mt-1 shrink-0" />}
      <div className={`max-w-[70%] ${isUser ? "" : "flex flex-col items-end"}`}>
        {/* แสดงชื่อ admin ถ้าเป็น admin message */}
        {isAdmin && msg.admin_name && (
          <div className="text-[10px] text-text-muted mb-0.5 pr-1">{msg.admin_name}</div>
        )}
        <div
          className={`rounded-2xl px-3.5 py-2 text-sm ${
            isUser
              ? "bg-surface border border-border text-text rounded-tl-sm"
              : isAdmin
              ? "bg-deep-space text-white rounded-tr-sm"
              : "bg-brand text-white rounded-tr-sm"
          }`}
        >
          <MessageContent msg={msg} variant={isUser ? "user" : "out"} />
        </div>

        <div className="flex items-center gap-1.5 mt-1 text-[10px] text-text-subtle">
          {isBot && <Bot size={10} />}
          {isAdmin && <Headset size={10} />}
          <span>{new Date(msg.timestamp).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}</span>
          {msg.source && <span className="opacity-60">· {msg.source}</span>}
        </div>
      </div>
      {!isUser && !isSystem && (
        <div
          className={`mt-1 w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
            isAdmin ? "bg-deep-space" : "bg-brand"
          }`}
        >
          {isAdmin ? <Headset size={16} className="text-white" /> : <Bot size={16} className="text-white" />}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TransferDropdown — โยนแชทให้ admin คนอื่น                            */
/* ------------------------------------------------------------------ */

interface AdminRow {
  admin_id: string;
  name: string;
  username: string;
  role: string;
  active: boolean;
}

function TransferDropdown({
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
      // กรองเฉพาะ role=admin และ active
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
                  a.admin_id === currentAdminId ? "opacity-50 cursor-default" : ""
                }`}
              >
                <span className="text-text truncate">{a.name || a.username}</span>
                {a.admin_id === currentAdminId && (
                  <span className="text-[10px] text-brand shrink-0">ปัจจุบัน</span>
                )}
              </button>
            ))}
            {admins.length === 0 && !loading && (
              <div className="px-3 py-3 text-xs text-text-muted text-center">ไม่มีแอดมิน</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

interface Props {
  conversation: Conversation | null;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onHandoff: () => void;
  onResolve: () => void;
  onReopen?: () => void;
  onTransfer?: (newAdminId: string) => void;
  onSuggestProduct?: () => void;
  onTicketChange: (patch: Partial<Conversation>) => void;
  sending: boolean;
}

export function TicketChatPanel({
  conversation,
  messages,
  onSend,
  onHandoff,
  onResolve,
  onReopen,
  onTransfer,
  onSuggestProduct,
  onTicketChange,
  sending,
}: Props) {
  const [text, setText] = useState("");
  const [quickReplies, setQuickReplies] = useState<QuickReplyRow[]>([]);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // track ว่า user อยู่ใกล้ล่างไหม — ถ้าไม่ใช่ (กำลังเลื่อนขึ้นอ่าน) จะไม่ auto-scroll
  const wasNearBottomRef = useRef(true);
  // track conversation id เพื่อบังคับ scroll ลงล่างเมื่อเปลี่ยน conversation
  const prevConvIdRef = useRef<string | null>(null);

  // ⚡ scroll logic รวมใน effect เดียว — แก้ปัญหาลำดับการรัน
  //    - เปลี่ยน conversation → บังคับ scroll ลงล่าง (เปิดแชทมาเห็นข้อความล่าสุด)
  //    - ข้อความใหม่เข้า → scroll ลงเฉพาะเมื่อ user อยู่ใกล้ล่างอยู่แล้ว
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const convId = conversation?.id ?? null;
    const isConvChange = convId !== prevConvIdRef.current;
    if (isConvChange) {
      prevConvIdRef.current = convId;
      wasNearBottomRef.current = true;
      // รอให้ DOM render ก่อน (messages อาจยังโหลดอยู่) — double rAF เพื่อให้แน่ใจ
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el2 = scrollRef.current;
          if (el2) el2.scrollTop = el2.scrollHeight;
        });
      });
      return;
    }
    // ไม่ใช่ conversation change — เช็คว่า user อยู่ใกล้ล่างไหม แล้ว scroll ถ้าใช่
    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, conversation?.id]);

  // track scroll position ของ user (เพื่อรู้ว่ากำลังอ่านข้อความเก่าอยู่ไหม)
  // ⚠️ ต้องรันหลัง effect scroll เสมอ — ใช้ setTimeout เพื่อให้แน่ใจ
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const convId = conversation?.id ?? null;
    // ข้ามการ track เมื่อเพิ่งเปลี่ยน conversation (ปล่อยให้ effect scroll ทำงานก่อน)
    if (convId === prevConvIdRef.current && wasNearBottomRef.current) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasNearBottomRef.current = distFromBottom < 80;
  }, [messages, conversation?.id]);

  // โหลด quick replies ของ admin คนนี้ (เฉพาะที่ enabled, กรองตาม platform/shop ของแชทปัจจุบัน)
  useEffect(() => {
    const params: { enabled_only: string; platform?: string; shop_id?: string } = { enabled_only: "1" };
    if (conversation?.platform) params.platform = conversation.platform;
    if (conversation?.shop_id) params.shop_id = conversation.shop_id;
    quickReplyService.list(params)
      .then(setQuickReplies)
      .catch(() => setQuickReplies([]));
  }, [conversation?.platform, conversation?.shop_id]);

  function handleQuickReply(qr: QuickReplyRow) {
    setText(qr.body);
    setShowQuickReplies(false);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || sending) return;
    onSend(text.trim());
    setText("");
  }

  if (!conversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-muted bg-bg">
        <div className="w-16 h-16 rounded-full bg-surface-2 flex items-center justify-center mb-3">
          <User size={32} className="text-text-subtle" />
        </div>
        <p className="font-medium text-text">เลือกบทสนทนาเพื่อดูรายละเอียด</p>
        <p className="text-sm mt-1 text-text-muted">แชทและข้อมูลตั๋วจะแสดงที่นี่</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg">
      {/* ── Header (topbar) — สะอาด, เหลือแค่สิ่งจำเป็น ── */}
      <div className="px-4 py-2.5 border-b border-border bg-surface shrink-0">
        <div className="flex items-center gap-3">
          <Avatar name={conversation.customer_name} src={conversation.customer_avatar} size={34} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text truncate">{conversation.customer_name}</span>
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
            <TransferDropdown
              currentAdminId={conversation.assigned_to}
              onSelect={onTransfer}
            />
          )}

          {conversation.status === "bot" && (
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
            <Button size="sm" onClick={onResolve} className="shrink-0">
              <Lock size={14} /> ปิดสนทนา
            </Button>
          )}
        </div>
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center text-sm text-text-muted py-8">ยังไม่มีข้อความในบทสนทนานี้</div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}
      </div>

      {/* ── Composer ── */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-border bg-surface shrink-0">
        {/* Quick replies dropdown */}
        {quickReplies.length > 0 && (
          <div className="relative mb-2">
            <button
              type="button"
              onClick={() => setShowQuickReplies(!showQuickReplies)}
              className="flex items-center gap-1.5 text-xs text-brand hover:text-brand/80 font-medium"
            >
              <Zap size={12} />
              คำตอบเร็ว ({quickReplies.length})
              <ChevronDown size={12} className={showQuickReplies ? "rotate-180" : ""} />
            </button>
            {showQuickReplies && (
              <div className="absolute bottom-full left-0 mb-1 w-full max-w-md max-h-64 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg z-20">
                {quickReplies.map((qr) => (
                  <button
                    key={qr.quick_reply_id}
                    type="button"
                    onClick={() => handleQuickReply(qr)}
                    className="w-full text-left px-3 py-2 hover:bg-surface-2 border-b border-border last:border-0"
                  >
                    <div className="text-xs font-medium text-text">{qr.title}</div>
                    <div className="text-xs text-text-muted line-clamp-1">{qr.body}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as FormEvent);
              }
            }}
            placeholder="พิมพ์ข้อความตอบลูกค้า..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand max-h-32"
          />
          <Button type="submit" size="icon" disabled={!text.trim() || sending}>
            <Send size={16} />
          </Button>
        </div>
        {conversation.status === "handoff" && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-vibrant-coral">
            <AlertCircle size={12} />
            แชทนี้อยู่ในมือแอดมิน — บอทจะไม่ตอบอัตโนมัติ
          </div>
        )}
      </form>
    </div>
  );
}
