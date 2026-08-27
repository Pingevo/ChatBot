// ShadowReplyPanel — middle column: side-by-side comparison
// ซ้าย: ลูกค้าถาม + Zaapi/admin ตอบ
// ขวา: ลูกค้าถาม + Bot ของเราตอบ
// ล่าง: rating buttons + metadata
"use client";
import { Badge } from "@/components/ui/Badge";
import {
  MessageSquare, Bot, FlaskConical, Trash2,
  CheckCircle2, XCircle, MinusCircle, AlertTriangle,
  ShieldCheck, Zap, Clock, Cpu, User,
} from "lucide-react";
import type { Platform, ChatMessage, ProductCard } from "@/lib/types";
import { MessageContent } from "@/components/chat/MessageContent";

export interface ShadowReplyDetail {
  shadow_reply_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  inbound_message_id: string;
  inbound_text: string;
  bot_reply_text: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed_ms?: number;
  bot_tokens?: { prompt: number; output: number; total: number };
  bot_cost_usd?: number;
  bot_cost_thb?: number;
  bot_products?: ProductCard[];
  zaapi_reply_text?: string;
  zaapi_reply_message_id?: string;
  rating?: "better" | "worse" | "tie" | "unrated";
  rated_by?: string;
  rated_at?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  // enriched — ข้อความ inbound พร้อม media (จาก GET /api/shadow-inbox/:id)
  inbound_message?: ChatMessage;
}

interface Props {
  reply: ShadowReplyDetail | null;
  onRate: (id: string, rating: "better" | "worse" | "tie" | "unrated") => void;
  onDelete: (id: string) => void;
  ratingId: string | null;
}

const platformLabels: Record<Platform, string> = {
  shopee: "Shopee",
  tiktok: "TikTok",
  lazada: "Lazada",
};

const ratingConfig = {
  better: { label: "Bot ดีกว่า", icon: CheckCircle2, color: "text-green-600", bg: "bg-green-50", border: "border-green-200" },
  worse: { label: "Bot แย่กว่า", icon: XCircle, color: "text-red-600", bg: "bg-red-50", border: "border-red-200" },
  tie: { label: "เสมอ", icon: MinusCircle, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-200" },
  unrated: { label: "ยังไม่ให้คะแนน", icon: AlertTriangle, color: "text-yellow-600", bg: "bg-yellow-50", border: "border-yellow-200" },
};

export function ShadowReplyPanel({ reply, onRate, onDelete, ratingId }: Props) {
  if (!reply) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <FlaskConical size={40} className="text-text-subtle mb-3" />
        <p className="text-sm text-text-muted">เลือก shadow reply จากรายการด้านซ้าย</p>
        <p className="text-xs text-text-subtle mt-1">หรือกด Generate เพื่อสร้างใหม่</p>
      </div>
    );
  }

  const rating = reply.rating || "unrated";
  const rc = ratingConfig[rating];
  const RatingIcon = rc.icon;

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-surface shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge tone={reply.platform === "shopee" ? "brand" : reply.platform === "tiktok" ? "pale" : "neutral"}>
              {platformLabels[reply.platform]}
            </Badge>
            <span className="text-xs text-text-muted">{reply.shop_id}</span>
            <span className="text-xs text-text-subtle">·</span>
            <code className="text-[10px] text-text-subtle">{reply.conversation_id.slice(0, 24)}</code>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${rc.bg} ${rc.border} border ${rc.color}`}>
              <RatingIcon size={12} /> {rc.label}
            </span>
            <button
              onClick={() => onDelete(reply.shadow_reply_id)}
              className="w-7 h-7 rounded-md flex items-center justify-center text-text-subtle hover:bg-red-50 hover:text-red-600 transition-colors"
              title="ลบ"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        {/* Safety banner */}
        <div className="mt-2 flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-md px-2 py-1 text-[10px] text-green-800">
          <ShieldCheck size={11} className="text-green-600 shrink-0" />
          <span>ปลอดภัย: ไม่ส่งจริง · ไม่อ่านจริง · เก็บใน DB เราเท่านั้น</span>
        </div>
      </div>

      {/* Side-by-side comparison — 2 ส่วน: Zaapi/user + user/bot เรา */}
      <div className="flex-1 overflow-hidden flex">
        {/* ── ฝั่งซ้าย: Zaapi / admin ── */}
        <div className="flex-1 flex flex-col border-r border-border min-w-0">
          {/* Column header */}
          <div className="px-4 py-2.5 border-b border-border bg-surface-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="w-6 h-6 rounded-md bg-deep-space/10 flex items-center justify-center">
                <Bot size={12} className="text-deep-space" />
              </div>
              <div>
                <div className="text-xs font-semibold text-text">Zaapi / sellcenter</div>
                <div className="text-[10px] text-text-subtle">บอทเดิมที่ใช้งานอยู่</div>
              </div>
            </div>
          </div>

          {/* Chat scroll area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Customer message */}
            <div className="flex gap-2">
              <div className="w-7 h-7 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                <User size={13} className="text-text-muted" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-text-subtle mb-0.5">ลูกค้า</div>
                <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-3 py-2">
                  {reply.inbound_message ? (
                    <MessageContent msg={reply.inbound_message} variant="user" />
                  ) : (
                    <p className="text-sm text-text whitespace-pre-wrap">{reply.inbound_text}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Zaapi reply */}
            <div className="flex gap-2 flex-row-reverse">
              <div className="w-7 h-7 rounded-full bg-deep-space/10 flex items-center justify-center shrink-0">
                <Bot size={13} className="text-deep-space" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-text-subtle mb-0.5 text-right">Zaapi ตอบ</div>
                {reply.zaapi_reply_text ? (
                  <div className="bg-deep-space text-white rounded-lg rounded-tr-sm px-3 py-2">
                    <p className="text-sm whitespace-pre-wrap">{reply.zaapi_reply_text}</p>
                  </div>
                ) : (
                  <div className="bg-surface-2 border border-dashed border-border rounded-lg rounded-tr-sm px-3 py-2">
                    <p className="text-xs text-text-subtle italic">ไม่มีคำตอบจาก Zaapi</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── ฝั่งขวา: Bot ของเรา ── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Column header */}
          <div className="px-4 py-2.5 border-b border-border bg-brand/5 shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="w-6 h-6 rounded-md bg-brand/15 flex items-center justify-center">
                <FlaskConical size={12} className="text-brand" />
              </div>
              <div>
                <div className="text-xs font-semibold text-text">Bot ของเรา</div>
                <div className="text-[10px] text-text-subtle">บอทใหม่ที่กำลังพัฒนา</div>
              </div>
            </div>
          </div>

          {/* Chat scroll area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Customer message (เดียวกัน) */}
            <div className="flex gap-2">
              <div className="w-7 h-7 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                <User size={13} className="text-text-muted" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-text-subtle mb-0.5">ลูกค้า</div>
                <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-3 py-2">
                  {reply.inbound_message ? (
                    <MessageContent msg={reply.inbound_message} variant="user" />
                  ) : (
                    <p className="text-sm text-text whitespace-pre-wrap">{reply.inbound_text}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Our bot reply */}
            <div className="flex gap-2 flex-row-reverse">
              <div className="w-7 h-7 rounded-full bg-brand/15 flex items-center justify-center shrink-0">
                <FlaskConical size={13} className="text-brand" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-text-subtle mb-0.5 text-right">Bot ตอบ</div>
                <div className="bg-brand text-white rounded-lg rounded-tr-sm px-3 py-2">
                  <MessageContent
                    msg={{
                      id: reply.shadow_reply_id,
                      role: "bot",
                      text: reply.bot_reply_text,
                      timestamp: reply.created_at,
                      products: reply.bot_products,
                    }}
                    variant="out"
                  />
                  {/* inline metadata — ตัวเล็กใต้ข้อความ */}
                  <div className="mt-2 pt-1.5 border-t border-white/20 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-white/70 leading-tight">
                    {reply.bot_model && (
                      <span className="inline-flex items-center gap-0.5"><Cpu size={8} />{reply.bot_model}</span>
                    )}
                    {reply.bot_source && (
                      <span className="inline-flex items-center gap-0.5"><Zap size={8} />{reply.bot_source}</span>
                    )}
                    {reply.bot_elapsed_ms != null && (
                      <span className="inline-flex items-center gap-0.5"><Clock size={8} />{reply.bot_elapsed_ms}s</span>
                    )}
                    {reply.bot_tokens && (
                      <span>tokens {reply.bot_tokens.total} (in {reply.bot_tokens.prompt} · out {reply.bot_tokens.output})</span>
                    )}
                    {reply.bot_cost_usd != null && reply.bot_cost_usd > 0 && (
                      <span className="text-green-700 font-medium">
                        ${reply.bot_cost_usd.toFixed(6)} ≈ ฿{reply.bot_cost_thb ? reply.bot_cost_thb.toFixed(4) : (reply.bot_cost_usd * 36).toFixed(4)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Rating footer */}
      <div className="px-4 py-3 border-t border-border bg-surface shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-text-muted mr-1">ให้คะแนน:</span>
          {(["better", "tie", "worse", "unrated"] as const).map((rt) => {
            const cfg = ratingConfig[rt];
            const Icon = cfg.icon;
            const isActive = rating === rt;
            return (
              <button
                key={rt}
                onClick={() => onRate(reply.shadow_reply_id, rt)}
                disabled={ratingId === reply.shadow_reply_id}
                className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                  isActive
                    ? `${cfg.bg} ${cfg.border} ${cfg.color} font-medium`
                    : "border-border text-text-muted hover:bg-surface-2"
                }`}
              >
                <Icon size={12} /> {cfg.label}
              </button>
            );
          })}
          <span className="ml-auto text-[10px] text-text-subtle">
            {new Date(reply.created_at).toLocaleString("th-TH")}
          </span>
        </div>
      </div>
    </div>
  );
}
