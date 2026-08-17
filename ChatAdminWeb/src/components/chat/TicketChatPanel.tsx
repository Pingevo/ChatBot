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
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { Conversation, ChatMessage, Topic } from "@/lib/types";

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
        <div
          className={`rounded-2xl px-3.5 py-2 text-sm ${
            isUser
              ? "bg-surface border border-border text-text rounded-tl-sm"
              : isAdmin
              ? "bg-deep-space text-white rounded-tr-sm"
              : "bg-brand text-white rounded-tr-sm"
          }`}
        >
          {msg.text}
        </div>

        {msg.products && msg.products.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {msg.products.slice(0, 3).map((p) => (
              <div
                key={p.item_id}
                className={`flex items-center gap-2 rounded-lg p-2 text-xs ${
                  isUser ? "bg-surface-2" : "bg-white/10"
                }`}
              >
                {p.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image} alt={p.name} className="w-10 h-10 rounded object-cover" />
                )}
                <div className="min-w-0">
                  <div className={`truncate font-medium ${isUser ? "text-text" : "text-white"}`}>
                    {p.name}
                  </div>
                  <div className={isUser ? "text-text-muted" : "text-white/70"}>
                    ฿{p.price.toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

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

// ─── Main component ────────────────────────────────────────────────────────────

interface Props {
  conversation: Conversation | null;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onHandoff: () => void;
  onResolve: () => void;
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
  onSuggestProduct,
  onTicketChange,
  sending,
}: Props) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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

  const topicOptions = (Object.entries(topicLabels) as [Topic, string][]).map(([k, v]) => ({
    value: k,
    label: v,
  }));
  const statusOptions = Object.entries(statusLabels).map(([k, v]) => ({ value: k, label: v }));
  const priorityOptions = Object.entries(priorityLabels).map(([k, v]) => ({ value: k, label: v }));
  const resOptions = resolutionOptions.map((r) => ({ value: r, label: r }));

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg">
      {/* ── Header ── */}
      <div className="px-4 py-2.5 border-b border-border bg-surface shrink-0">
        {/* Row 1: customer + actions */}
        <div className="flex items-center gap-3 mb-2.5">
          <Avatar name={conversation.customer_name} src={conversation.customer_avatar} size={34} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text truncate">{conversation.customer_name}</span>
              <PlatformIcon platform={conversation.platform} size={16} />
            </div>
            <div className="text-[11px] text-text-muted truncate">{conversation.shop_name}</div>
          </div>

          {conversation.ticket_id && (
            <div className="flex items-center gap-1 text-[11px] text-text-muted bg-surface-2 border border-border rounded-md px-2 py-1 shrink-0">
              <Hash size={10} />
              <span className="font-mono">{conversation.ticket_id}</span>
            </div>
          )}

          {conversation.ticket_status && (
            <Badge tone={statusTone[conversation.ticket_status]}>
              {statusLabels[conversation.ticket_status]}
            </Badge>
          )}

          {conversation.status === "bot" && (
            <Button size="sm" variant="outline" onClick={onHandoff}>
              <Headset size={14} /> รับเรื่อง
            </Button>
          )}
          <Button size="sm" onClick={onResolve} className="shrink-0">
            ✓ ปิดสนทนา
          </Button>
        </div>

        {/* Row 2: inline ticket field dropdowns */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <InlineDropdown
            label="สถานะ"
            value={conversation.ticket_status}
            options={statusOptions}
            onChange={(v) => onTicketChange({ ticket_status: v as Conversation["ticket_status"] })}
          />
          <InlineDropdown
            label="ความสำคัญ"
            value={conversation.ticket_priority}
            options={priorityOptions}
            onChange={(v) => onTicketChange({ ticket_priority: v as Conversation["ticket_priority"] })}
          />
          <InlineDropdown
            label="ประเภทปัญหา"
            value={conversation.ticket_issue_type}
            options={topicOptions}
            onChange={(v) => onTicketChange({ ticket_issue_type: v as Topic })}
          />
          <InlineDropdown
            label="Resolution"
            value={conversation.ticket_resolution}
            options={resOptions}
            onChange={(v) => onTicketChange({ ticket_resolution: v })}
          />

          {onSuggestProduct && (
            <button
              onClick={onSuggestProduct}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-pale-sky-soft border border-pale-sky text-brand hover:bg-brand/10 transition-colors ml-auto"
            >
              <Sparkles size={12} /> แนะนำสินค้า
            </button>
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
