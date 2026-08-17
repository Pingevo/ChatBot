// ChatWindow — middle column: message bubbles + composer (Zaapi-style)
"use client";
import { useState, useRef, useEffect, FormEvent } from "react";
import { Send, Bot, User, Headset, AlertCircle, Sparkles, Ticket, MoreHorizontal } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { Conversation, ChatMessage, Topic } from "@/lib/types";

interface Props {
  conversation: Conversation | null;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onHandoff: () => void;
  onResolve: () => void;
  onSuggestProduct?: () => void;
  onCreateTicket?: () => void;
  sending: boolean;
}

const topicLabels: Record<Topic, string> = {
  product_inquiry: "สินค้า",
  product_compare: "เปรียบเทียบ",
  usage_help: "การใช้งาน",
  claim: "เคลม",
  warranty: "รับประกัน",
  problem_report: "แจ้งปัญหา",
  tax_invoice: "ใบกำกับภาษี",
  shipping: "จัดส่ง",
  general: "ทั่วไป",
  handoff: "ส่งแอดมิน",
};

const topicTones: Record<Topic, "brand" | "coral" | "pale" | "neutral" | "red"> = {
  product_inquiry: "brand",
  product_compare: "brand",
  usage_help: "pale",
  claim: "coral",
  warranty: "coral",
  problem_report: "red",
  tax_invoice: "pale",
  shipping: "neutral",
  general: "neutral",
  handoff: "coral",
};

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

        {/* Product cards */}
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

        {/* Meta */}
        <div className={`flex items-center gap-1.5 mt-1 text-[10px] text-text-subtle`}>
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

export function ChatWindow({
  conversation,
  messages,
  onSend,
  onHandoff,
  onResolve,
  onSuggestProduct,
  onCreateTicket,
  sending,
}: Props) {
  const [text, setText] = useState("");
  const [showActions, setShowActions] = useState(false);
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
        <p className="font-medium text-text">เลือกแชทเพื่อเริ่มตอบ</p>
        <p className="text-sm mt-1">แชทจาก Shopee, TikTok, Lazada รวมที่นี่</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg">
      {/* Chat header */}
      <div className="h-14 px-4 border-b border-border glass flex items-center gap-3 shrink-0">
        <Avatar name={conversation.customer_name} src={conversation.customer_avatar} size={36} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-text truncate">{conversation.customer_name}</span>
            <PlatformIcon platform={conversation.platform} size={18} />
          </div>
          <div className="text-xs text-text-muted truncate">{conversation.shop_name}</div>
        </div>
        <Badge tone={topicTones[conversation.topic]}>{topicLabels[conversation.topic]}</Badge>
        {conversation.status === "bot" && (
          <Button size="sm" variant="outline" onClick={onHandoff}>
            <Headset size={14} /> รับเรื่อง
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onResolve}>
          ปิด
        </Button>
        {/* Quick actions menu */}
        <div className="relative">
          <button
            onClick={() => setShowActions((v) => !v)}
            className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center"
            title="การกระทำ"
          >
            <MoreHorizontal size={16} className="text-text-muted" />
          </button>
          {showActions && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
              <div className="absolute right-0 top-9 z-20 w-44 bg-surface rounded-lg shadow-lg border border-border py-1 text-sm">
                <button
                  onClick={() => { setShowActions(false); onSuggestProduct?.(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-2 text-text"
                >
                  <Sparkles size={14} className="text-brand" /> แนะนำสินค้า
                </button>
                <button
                  onClick={() => { setShowActions(false); onCreateTicket?.(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-2 text-text"
                >
                  <Ticket size={14} className="text-coral" /> สร้างตั๋ว
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center text-sm text-text-muted py-8">ยังไม่มีข้อความ</div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}
      </div>

      {/* Composer */}
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
