// ShadowConversationPanel — แสดงทั้งแชทแบบ 2 คอลัมน์
// ซ้าย: user + Zaapi/sellcenter (จากประวัติจริง)
// ขวา: user + Bot ของเรา (generate ใหม่ หรือจาก shadow_replies ที่มีแล้ว)
//
// ⛔ ห้ามส่งข้อความจริง — เก็บใน shadow_replies เท่านั้น
// ⛔ ห้ามเรียก Shopee API
"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";
import {
  Bot, FlaskConical, Zap, User, ShieldCheck,
  CheckCircle2, XCircle, MinusCircle, AlertTriangle,
  Cpu, Clock, ArrowDown, History,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { MessageContent } from "@/components/chat/MessageContent";
import type { Platform, ChatMessage, Conversation, ProductCard } from "@/lib/types";

// ── Q&A pair: ข้อความลูกค้า + คำตอบจาก Zaapi (จากประวัติจริง) ──
interface QAPair {
  inbound: ChatMessage;
  zaapiReply: ChatMessage | null;
  // bot response ของเรา (generate แล้ว)
  botReply?: {
    text: string;
    source?: string;
    model?: string;
    elapsed?: number;
    tokens?: { prompt: number; output: number; total: number };
    products?: ProductCard[];
    shadow_reply_id?: string;
    rating?: "better" | "worse" | "tie" | "unrated";
  };
}

interface Props {
  conversation: Conversation | null;
  messages: ChatMessage[];
  loadingMessages: boolean;
  // History tab — shadow replies ที่เคย generate แล้ว (จะ map เข้า botReply อัตโนมัติ)
  historyReplies?: Array<{
    shadow_reply_id: string;
    inbound_message_id?: string;
    inbound_text: string;
    bot_reply_text: string;
    bot_source?: string;
    bot_model?: string;
    bot_elapsed_ms?: number;
    bot_tokens?: { prompt: number; output: number; total: number };
    bot_products?: ProductCard[];
    rating?: "better" | "worse" | "tie" | "unrated";
    origin?: string;
  }>;
}

const platformLabels: Record<Platform, string> = {
  shopee: "Shopee",
  tiktok: "TikTok",
  lazada: "Lazada",
};

/**
 * แปลง messages เป็น Q&A pairs
 * - แต่ละ user message (direction=in) = คำถาม
 * - หา out message ถัดไป (role bot/admin, source != admin) = คำตอบ Zaapi
 */
function parseQAPairs(messages: ChatMessage[]): QAPair[] {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const pairs: QAPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.role === "user") {
      // หา out message ถัดไปที่เป็น zaapi/bot (ไม่ใช่ admin พิมพ์เอง)
      let zaapiReply: ChatMessage | null = null;
      for (let j = i + 1; j < sorted.length; j++) {
        const next = sorted[j];
        if (next.role === "user") break; // เจอคำถามใหม่ → หยุด
        if (next.role === "bot" || (next.role === "admin" && next.source !== "admin")) {
          zaapiReply = next;
          break;
        }
      }
      pairs.push({ inbound: m, zaapiReply });
    }
  }
  return pairs;
}

export function ShadowConversationPanel({ conversation, messages, loadingMessages, historyReplies }: Props) {
  const { catchError } = useToastError();
  const [pairs, setPairs] = useState<QAPair[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generatingIdx, setGeneratingIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // แปลง messages → Q&A pairs (แล้ว merge historyReplies ถ้ามี)
  useEffect(() => {
    const basePairs = parseQAPairs(messages);
    if (historyReplies && historyReplies.length > 0) {
      const replyMap = new Map(historyReplies.map((r) => [r.inbound_message_id, r]));
      setPairs(basePairs.map((pair) => {
        const sr = replyMap.get(pair.inbound.id);
        if (!sr) return pair;
        return {
          ...pair,
          botReply: {
            text: sr.bot_reply_text,
            source: sr.bot_source,
            model: sr.bot_model,
            elapsed: sr.bot_elapsed_ms,
            tokens: sr.bot_tokens,
            products: sr.bot_products,
            shadow_reply_id: sr.shadow_reply_id,
            rating: sr.rating || "unrated",
          },
        };
      }));
    } else {
      setPairs(basePairs);
    }
  }, [messages, historyReplies]);

  // scroll ลงล่างสุดเมื่อโหลด conversation ใหม่
  const prevConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    const convId = conversation?.id ?? null;
    if (convId !== prevConvIdRef.current) {
      prevConvIdRef.current = convId;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      });
    }
  }, [conversation?.id, pairs]);

  // Generate bot reply สำหรับ Q&A pair ที่ index นั้น
  const generateOne = useCallback(async (idx: number) => {
    if (!conversation) return;
    const pair = pairs[idx];
    if (!pair) return;
    setGeneratingIdx(idx);
    try {
      const resp = await api().post<{ shadow_reply: { shadow_reply_id: string; bot_reply_text: string; bot_source?: string; bot_model?: string; bot_elapsed_ms?: number; bot_tokens?: { prompt: number; output: number; total: number }; bot_products?: ProductCard[] } }>("/shadow-inbox", {
        conversation_id: conversation.id,
        inbound_message_id: pair.inbound.id,
      });
      const sr = resp.data.shadow_reply;
      setPairs((prev) => {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          botReply: {
            text: sr.bot_reply_text,
            source: sr.bot_source,
            model: sr.bot_model,
            elapsed: sr.bot_elapsed_ms,
            tokens: sr.bot_tokens,
            products: sr.bot_products,
            shadow_reply_id: sr.shadow_reply_id,
            rating: "unrated",
          },
        };
        return next;
      });
    } catch (err) {
      catchError(err, `Generate ไม่สำเร็จ (ข้อความที่ ${idx + 1})`);
    } finally {
      setGeneratingIdx(null);
    }
  }, [conversation, pairs, catchError]);

  // Generate ทุก Q&A pair — เรียก endpoint ใหม่ที่ generate ทั้ง conversation
  // โดยใช้คำตอบ bot เราเป็น history (ไม่ใช่ Zaapi)
  const generateAll = useCallback(async () => {
    if (!conversation || pairs.length === 0) return;
    const ok = await confirm.ask({
      title: "Generate ทุกข้อความ?",
      message: `ระบบจะเรียก bot ของเราสำหรับ ${pairs.length} ข้อความ — เรียงจากเก่าสุดไปใหม่สุด แต่ละคำตอบจะใช้เป็น history สำหรับคำถามถัดไป อาจใช้เวลาสักครู่ ผลลัพธ์เก็บใน shadow_replies ไม่ส่งจริง`,
      confirmText: "Generate ทั้งหมด",
    });
    if (!ok) return;
    setGenerating(true);
    try {
      const resp = await api().post<{
        shadow_replies: Array<{
          shadow_reply_id: string;
          inbound_message_id: string;
          bot_reply_text: string;
          bot_source?: string;
          bot_model?: string;
          bot_elapsed_ms?: number;
          bot_tokens?: { prompt: number; output: number; total: number };
          bot_products?: ProductCard[];
        }>;
        total: number;
      }>("/shadow-inbox/generate-conversation", {
        conversation_id: conversation.id,
      }, {
        // ⚡ generate ทั้ง conversation อาจใช้เวลานาน (เรียก bot ทีละข้อความ)
        // ตั้ง timeout 5 นาที กัน axios ตัดก่อน backend ทำเสร็จ
        timeout: 300_000,
      });

      // map ผลลัพธ์กลับเข้า pairs (จับคู่ด้วย inbound_message_id)
      const replyMap = new Map(resp.data.shadow_replies.map((sr) => [sr.inbound_message_id, sr]));
      setPairs((prev) =>
        prev.map((pair) => {
          const sr = replyMap.get(pair.inbound.id);
          if (!sr) return pair;
          return {
            ...pair,
            botReply: {
              text: sr.bot_reply_text,
              source: sr.bot_source,
              model: sr.bot_model,
              elapsed: sr.bot_elapsed_ms,
              tokens: sr.bot_tokens,
              products: sr.bot_products,
              shadow_reply_id: sr.shadow_reply_id,
              rating: "unrated" as const,
            },
          };
        })
      );
      toast.success(`Generate ครบ ${resp.data.total} ข้อความแล้ว`);
    } catch (err) {
      catchError(err, "Generate ทั้งหมดไม่สำเร็จ");
    } finally {
      setGenerating(false);
    }
  }, [conversation, pairs, confirm, catchError]);

  // Rate a bot reply
  const handleRate = useCallback(async (idx: number, rating: "better" | "worse" | "tie" | "unrated") => {
    const pair = pairs[idx];
    if (!pair?.botReply?.shadow_reply_id) return;
    try {
      await api().patch(`/shadow-inbox/${pair.botReply.shadow_reply_id}/rating`, { rating });
      setPairs((prev) => {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          botReply: { ...next[idx].botReply!, rating },
        };
        return next;
      });
    } catch (err) {
      catchError(err, "ให้คะแนนไม่สำเร็จ");
    }
  }, [pairs, catchError]);

  if (!conversation) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <FlaskConical size={40} className="text-text-subtle mb-3" />
        <p className="text-sm text-text-muted">เลือก conversation จากรายการด้านซ้าย</p>
        <p className="text-xs text-text-subtle mt-1">ระบบจะแสดงทั้งแชทแบบเปรียบเทียบ 2 ฝั่ง</p>
      </div>
    );
  }

  if (loadingMessages) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loading size={32} />
      </div>
    );
  }

  const ratingConfig = {
    better: { label: "Bot ดีกว่า", icon: CheckCircle2, color: "text-green-600", bg: "bg-green-50", border: "border-green-200" },
    worse: { label: "Bot แย่กว่า", icon: XCircle, color: "text-red-600", bg: "bg-red-50", border: "border-red-200" },
    tie: { label: "เสมอ", icon: MinusCircle, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-200" },
    unrated: { label: "ยังไม่ให้คะแนน", icon: AlertTriangle, color: "text-yellow-600", bg: "bg-yellow-50", border: "border-yellow-200" },
  };

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-surface shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge tone={conversation.platform === "shopee" ? "brand" : conversation.platform === "tiktok" ? "pale" : "neutral"}>
              {platformLabels[conversation.platform]}
            </Badge>
            <span className="text-sm font-medium text-text truncate">{conversation.customer_name || "(ไม่มีชื่อ)"}</span>
            <span className="text-xs text-text-subtle">· {pairs.length} คำถาม</span>
          </div>
          <div className="flex items-center gap-2">
            {historyReplies ? (
              <Badge tone="pale">
                <History size={11} className="mr-1" /> History
              </Badge>
            ) : (
              <Button
                size="sm"
                disabled={generating || pairs.length === 0}
                onClick={generateAll}
              >
                {generating ? <Loading size={12} /> : <Zap size={12} />} Generate ทั้งหมด
              </Button>
            )}
          </div>
        </div>
        {/* Safety banner */}
        <div className="mt-2 flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-md px-2 py-1 text-[10px] text-green-800">
          <ShieldCheck size={11} className="text-green-600 shrink-0" />
          <span>ปลอดภัย: ไม่ส่งจริง · ไม่อ่านจริง · เก็บใน DB เราเท่านั้น</span>
        </div>
      </div>

      {/* Side-by-side comparison — 2 ส่วน แต่ละคอลัมน์ scroll เอง */}
      <div ref={scrollRef} className="flex-1 flex min-h-0">
        {/* ── ฝั่งซ้าย: Zaapi / sellcenter (จากประวัติจริง) ── */}
        <div className="flex-1 flex flex-col border-r border-border min-w-0 overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-surface-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-md bg-deep-space/10 flex items-center justify-center">
                <Bot size={10} className="text-deep-space" />
              </div>
              <div>
                <div className="text-[11px] font-semibold text-text">Zaapi / sellcenter</div>
                <div className="text-[9px] text-text-subtle">บอทเดิมที่ใช้งานอยู่</div>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {pairs.length === 0 ? (
              <div className="text-center text-xs text-text-muted py-8">ไม่มีคำถามในแชทนี้</div>
            ) : (
              pairs.map((pair, idx) => (
                <div key={idx} className="space-y-2">
                  {idx > 0 && <div className="border-t border-border/50 pt-2" />}
                  {/* Customer message */}
                  <div className="flex gap-1.5">
                    <div className="w-5 h-5 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                      <User size={10} className="text-text-muted" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[9px] text-text-subtle mb-0.5">ลูกค้า · #{idx + 1}</div>
                      <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-2.5 py-1.5">
                        <MessageContent msg={pair.inbound} variant="user" />
                      </div>
                    </div>
                  </div>
                  {/* Zaapi reply */}
                  <div className="flex gap-1.5 flex-row-reverse">
                    <div className="w-5 h-5 rounded-full bg-deep-space/10 flex items-center justify-center shrink-0">
                      <Bot size={10} className="text-deep-space" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[9px] text-text-subtle mb-0.5 text-right">Zaapi ตอบ</div>
                      {pair.zaapiReply ? (
                        <div className="bg-deep-space text-white rounded-lg rounded-tr-sm px-2.5 py-1.5">
                          <MessageContent msg={pair.zaapiReply} variant="out" />
                        </div>
                      ) : (
                        <div className="bg-surface-2 border border-dashed border-border rounded-lg rounded-tr-sm px-2.5 py-1.5">
                          <p className="text-[11px] text-text-subtle italic">ไม่มีคำตอบจาก Zaapi</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── ฝั่งขวา: Bot ของเรา ── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-brand/5 shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-md bg-brand/15 flex items-center justify-center">
                <FlaskConical size={10} className="text-brand" />
              </div>
              <div>
                <div className="text-[11px] font-semibold text-text">Bot ของเรา</div>
                <div className="text-[9px] text-text-subtle">บอทใหม่ที่กำลังพัฒนา</div>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {pairs.length === 0 ? (
              <div className="text-center text-xs text-text-muted py-8">ไม่มีคำถามในแชทนี้</div>
            ) : (
              pairs.map((pair, idx) => {
                const isGeneratingThis = generatingIdx === idx;
                const rating = pair.botReply?.rating || "unrated";
                const rc = ratingConfig[rating];
                const RatingIcon = rc.icon;
                return (
                  <div key={idx} className="space-y-2">
                    {idx > 0 && <div className="border-t border-border/50 pt-2" />}
                    {/* Customer message (เดียวกัน) */}
                    <div className="flex gap-1.5">
                      <div className="w-5 h-5 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                        <User size={10} className="text-text-muted" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[9px] text-text-subtle mb-0.5">ลูกค้า · #{idx + 1}</div>
                        <div className="bg-surface border border-border rounded-lg rounded-tl-sm px-2.5 py-1.5">
                          <MessageContent msg={pair.inbound} variant="user" />
                        </div>
                      </div>
                    </div>
                    {/* Our bot reply */}
                    <div className="flex gap-1.5 flex-row-reverse">
                      <div className="w-5 h-5 rounded-full bg-brand/15 flex items-center justify-center shrink-0">
                        <FlaskConical size={10} className="text-brand" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[9px] text-text-subtle mb-0.5 text-right">
                          Bot ตอบ
                          {pair.botReply && (
                            <span className={`ml-1.5 inline-flex items-center gap-0.5 ${rc.color}`}>
                              <RatingIcon size={8} /> {rc.label}
                            </span>
                          )}
                        </div>
                        {isGeneratingThis ? (
                          <div className="bg-brand/10 border border-brand/20 rounded-lg rounded-tr-sm px-2.5 py-2 flex items-center gap-1.5">
                            <Loading size={10} />
                            <span className="text-[11px] text-brand">กำลัง generate...</span>
                          </div>
                        ) : pair.botReply ? (
                          <>
                            <div className="bg-brand text-white rounded-lg rounded-tr-sm px-2.5 py-1.5">
                              <MessageContent
                                msg={{
                                  id: pair.botReply.shadow_reply_id || `bot_${idx}`,
                                  role: "bot",
                                  text: pair.botReply.text,
                                  timestamp: pair.inbound.timestamp,
                                  products: pair.botReply.products,
                                }}
                                variant="out"
                              />
                              {/* metadata */}
                              <div className="mt-1.5 pt-1 border-t border-white/20 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[8px] text-white/70 leading-tight">
                                {pair.botReply.model && (
                                  <span className="inline-flex items-center gap-0.5"><Cpu size={7} />{pair.botReply.model}</span>
                                )}
                                {pair.botReply.source && (
                                  <span className="inline-flex items-center gap-0.5"><Zap size={7} />{pair.botReply.source}</span>
                                )}
                                {pair.botReply.elapsed != null && (
                                  <span className="inline-flex items-center gap-0.5"><Clock size={7} />{pair.botReply.elapsed}s</span>
                                )}
                                {pair.botReply.tokens && (
                                  <span>tokens {pair.botReply.tokens.total}</span>
                                )}
                              </div>
                            </div>
                            {/* Rating buttons */}
                            <div className="mt-1 flex items-center gap-0.5 flex-wrap">
                              {(["better", "tie", "worse"] as const).map((rt) => {
                                const cfg = ratingConfig[rt];
                                const Icon = cfg.icon;
                                const isActive = rating === rt;
                                return (
                                  <button
                                    key={rt}
                                    onClick={() => handleRate(idx, rt)}
                                    className={`inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-md border transition-colors ${
                                      isActive
                                        ? `${cfg.bg} ${cfg.border} ${cfg.color} font-medium`
                                        : "border-border text-text-muted hover:bg-surface-2"
                                    }`}
                                  >
                                    <Icon size={8} /> {cfg.label}
                                  </button>
                                );
                              })}
                            </div>
                          </>
                        ) : (
                          <div className="bg-surface-2 border border-dashed border-brand/30 rounded-lg rounded-tr-sm px-2.5 py-1.5">
                            <button
                              onClick={() => generateOne(idx)}
                              disabled={generating}
                              className="text-[11px] text-brand hover:text-brand/80 font-medium inline-flex items-center gap-1"
                            >
                              <Zap size={9} /> Generate คำตอบ
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
