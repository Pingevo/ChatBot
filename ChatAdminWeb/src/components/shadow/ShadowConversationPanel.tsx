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
  CheckCircle2, XCircle, AlertTriangle,
  Cpu, Clock, ArrowDown, History, Copy, Check,
  Star, MessageCircle, Save,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { MessageContent } from "@/components/chat/MessageContent";
import { RateBox } from "@/components/shadow/RateBox";
import { DateBanner, dayKey, formatDateTimeLabel } from "@/components/shadow/DateBanner";
import type { Platform, ChatMessage, Conversation, ProductCard } from "@/lib/types";
import { splitAnswerSegments } from "@/lib/answerSegments";

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
    routing_decision?: {
      path?: string;
      reason?: string;
      trigger_matched?: string | null;
      shop_settings_action?: string | null;
      assigned_admin?: string | null;
      handoff_reason?: string | null;
    };
    handoff_to_admin?: boolean;
    handoff_reason?: string;
    rating?: "good" | "bad" | "unrated";
    star_rating?: number;
    comment?: string;
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
    rating?: "good" | "bad" | "unrated";
    star_rating?: number;
    comment?: string;
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
  const [copiedSide, setCopiedSide] = useState<"zaapi" | "bot" | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ⚡ Copy chat — แยกฝั่ง zaapi หรือ bot
  // side="zaapi" → ลูกค้า + Zaapi reply
  // side="bot"   → ลูกค้า + Bot เรา reply
  const copyChat = useCallback(async (side: "zaapi" | "bot") => {
    if (pairs.length === 0 || !conversation) return;
    const label = side === "zaapi" ? "Zaapi" : "Bot เรา";
    const lines: string[] = [];
    lines.push(`# ${label} Chat — ${conversation.customer_name || "(ไม่มีชื่อ)"}`);
    lines.push(`Platform: ${conversation.platform} · ${pairs.length} คำถาม`);
    lines.push("");
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      lines.push(`── Q${i + 1} ──`);
      lines.push(`ลูกค้า: ${p.inbound.text || ""}`);
      if (side === "zaapi" && p.zaapiReply?.text) {
        lines.push(`Zaapi: ${p.zaapiReply.text}`);
      }
      if (side === "bot" && p.botReply?.text) {
        lines.push(`Bot เรา: ${p.botReply.text}`);
      }
      lines.push("");
    }
    const text = lines.join("\n");
    // fallback: textarea + execCommand (ใช้ได้ทุก context แม้ clipboard permission ถูกปฏิเสธ)
    const copyViaTextarea = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (!ok) throw new Error("execCommand copy failed");
    };
    try {
      // ลอง Clipboard API ก่อน (ถ้ามี permission)
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // permission denied → fallback
          copyViaTextarea();
        }
      } else {
        copyViaTextarea();
      }
      setCopiedSide(side);
      setTimeout(() => setCopiedSide(null), 2000);
      toast.success(`คัดลอกแชท${label}แล้ว`);
    } catch (e) {
      toast.error(`คัดลอกไม่สำเร็จ: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }, [pairs, conversation]);

  // แปลง messages → Q&A pairs (แล้ว merge historyReplies ถ้ามี)
  // ⚡ tab History (historyReplies ถูกส่งมา) — filter เฉพาะ Q&A ที่ bot เราตอบแล้ว
  //    ไม่ใช่ทุกข้อความใน conversation — เปรียบเทียบเฉพาะส่วนที่ bot เราตอบจริง
  //    ถ้า historyReplies เป็น array ว่าง (bot ไม่เคยตอบใน conversation นี้) → setPairs([])
  //    ไม่ใช่ setPairs(basePairs) ซึ่งจะแสดงทุกข้อความรวมข้อความใหม่ที่ bot ยังไม่ตอบ
  useEffect(() => {
    const basePairs = parseQAPairs(messages);
    if (Array.isArray(historyReplies)) {
      // tab History — merge + filter เฉพาะ pair ที่มี botReply (bot เราตอบแล้ว)
      const replyMap = new Map(historyReplies.map((r) => [r.inbound_message_id, r]));
      const merged = basePairs
        .map((pair) => {
          const sr = replyMap.get(pair.inbound.id);
          if (!sr) return null; // bot เรายังไม่ได้ตอบ → ตัดออก
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
              star_rating: sr.star_rating,
              comment: sr.comment,
              routing_decision: (sr as any).bot_routing_decision,
              handoff_to_admin: (sr as any).bot_handoff_to_admin,
              handoff_reason: (sr as any).bot_handoff_reason,
            },
          } as QAPair;
        })
        .filter((p): p is QAPair => p !== null);
      setPairs(merged);
    } else {
      // tab "ทั้งหมด" — แสดงทุก Q&A pair (สำหรับ generate)
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
      const resp = await api().post<{ shadow_reply: { shadow_reply_id: string; bot_reply_text: string; bot_source?: string; bot_model?: string; bot_elapsed_ms?: number; bot_tokens?: { prompt: number; output: number; total: number }; bot_products?: ProductCard[]; bot_routing_decision?: any; bot_handoff_to_admin?: boolean; bot_handoff_reason?: string } }>("/shadow-inbox", {
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
            routing_decision: sr.bot_routing_decision,
            handoff_to_admin: sr.bot_handoff_to_admin,
            handoff_reason: sr.bot_handoff_reason,
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
              routing_decision: (sr as any).bot_routing_decision,
              handoff_to_admin: (sr as any).bot_handoff_to_admin,
              handoff_reason: (sr as any).bot_handoff_reason,
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

  // Rate a bot reply (good/bad)
  const handleRate = useCallback(async (idx: number, rating: "good" | "bad" | "unrated") => {
    const pair = pairs[idx];
    if (!pair?.botReply?.shadow_reply_id) return;
    try {
      await api().patch(`/shadow-inbox/${pair.botReply.shadow_reply_id}`, { rating });
      setPairs((prev) => {
        const next = [...prev];
        if (next[idx]?.botReply) {
          next[idx] = { ...next[idx], botReply: { ...next[idx].botReply!, rating } };
        }
        return next;
      });
      toast.success(`ให้คะแนน "${rating}" แล้ว`);
    } catch (err) {
      catchError(err, "ให้คะแนนไม่สำเร็จ");
    }
  }, [pairs, catchError]);

  // Star rating
  const handleStar = useCallback(async (idx: number, star: number) => {
    const pair = pairs[idx];
    if (!pair?.botReply?.shadow_reply_id) return;
    try {
      const currentRating = pair.botReply.rating || "unrated";
      await api().patch(`/shadow-inbox/${pair.botReply.shadow_reply_id}`, {
        rating: currentRating,
        star_rating: star,
      });
      setPairs((prev) => {
        const next = [...prev];
        if (next[idx]?.botReply) {
          next[idx] = { ...next[idx], botReply: { ...next[idx].botReply!, star_rating: star } };
        }
        return next;
      });
    } catch (err) {
      catchError(err, "ให้ดาวไม่สำเร็จ");
    }
  }, [pairs, catchError]);

  // Comment
  const handleComment = useCallback(async (idx: number, comment: string) => {
    const pair = pairs[idx];
    if (!pair?.botReply?.shadow_reply_id) return;
    try {
      const currentRating = pair.botReply.rating || "unrated";
      await api().patch(`/shadow-inbox/${pair.botReply.shadow_reply_id}`, {
        rating: currentRating,
        comment,
      });
      setPairs((prev) => {
        const next = [...prev];
        if (next[idx]?.botReply) {
          next[idx] = { ...next[idx], botReply: { ...next[idx].botReply!, comment } };
        }
        return next;
      });
      toast.success(comment ? "บันทึกคอมเมนต์แล้ว" : "ล้างคอมเมนต์แล้ว");
    } catch (err) {
      catchError(err, "บันทึกคอมเมนต์ไม่สำเร็จ");
    }
  }, [pairs, catchError]);

  if (!conversation) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-center px-6">
        <FlaskConical size={40} className="text-text-subtle mb-3" />
        <p className="text-sm text-text-muted">เลือก conversation จากรายการด้านซ้าย</p>
        <p className="text-xs text-text-subtle mt-1">ระบบจะแสดงทั้งแชทแบบเปรียบเทียบ 2 ฝั่ง</p>
      </div>
    );
  }

  if (loadingMessages) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <Loading size={32} />
      </div>
    );
  }

  const ratingConfig = {
    good: { label: "Good", icon: CheckCircle2, color: "text-green-600", bg: "bg-green-50", border: "border-green-200" },
    bad: { label: "Bad", icon: XCircle, color: "text-red-600", bg: "bg-red-50", border: "border-red-200" },
    unrated: { label: "ยังไม่ให้คะแนน", icon: AlertTriangle, color: "text-yellow-600", bg: "bg-yellow-50", border: "border-yellow-200" },
  };

  return (
    <div className="w-full h-full flex flex-col bg-bg overflow-hidden min-w-0">
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
      {/* ⚡ ใช้ basis-0 + flex-1 เพื่อให้ 2 คอลัมน์มีขนาดเท่ากัน ไม่ขยายตามเนื้อหา */}
      <div ref={scrollRef} className="flex-1 flex min-h-0 overflow-hidden">
        {/* ── ฝั่งซ้าย: Zaapi / sellcenter (จากประวัติจริง) ── */}
        <div className="flex-1 basis-0 flex flex-col border-r border-border min-w-0 overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-surface-2 shrink-0">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-md bg-deep-space/10 flex items-center justify-center">
                  <Bot size={10} className="text-deep-space" />
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-text">Zaapi / sellcenter</div>
                  <div className="text-[9px] text-text-subtle">บอทเดิมที่ใช้งานอยู่</div>
                </div>
              </div>
              <button
                onClick={() => copyChat("zaapi")}
                disabled={pairs.length === 0}
                title="คัดลอกแชทฝั่ง Zaapi"
                className="w-6 h-6 rounded-md flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {copiedSide === "zaapi" ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {pairs.length === 0 ? (
              <div className="text-center text-xs text-text-muted py-8">ไม่มีคำถามในแชทนี้</div>
            ) : (
              pairs.map((pair, idx) => {
                const prevPair = idx > 0 ? pairs[idx - 1] : null;
                const showDateBanner = !prevPair || dayKey(prevPair.inbound.timestamp) !== dayKey(pair.inbound.timestamp);
                return (
                <div key={idx} className="space-y-2">
                  {showDateBanner && <DateBanner timestamp={pair.inbound.timestamp} compact />}
                  {idx > 0 && !showDateBanner && <div className="border-t border-border/50 pt-2" />}
                  {/* Customer message */}
                  <div className="flex gap-1.5">
                    <div className="w-5 h-5 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                      <User size={10} className="text-text-muted" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[9px] text-text-subtle mb-0.5">ลูกค้า · #{idx + 1} · {formatDateTimeLabel(pair.inbound.timestamp)}</div>
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
                    <div className="flex-1 min-w-0 flex flex-col items-end gap-1">
                      <div className="text-[9px] text-text-subtle mb-0.5 text-right">Zaapi ตอบ</div>
                      {pair.zaapiReply ? (
                        (() => {
                          // ⚡ Multi-bubble — split ||| เป็นหลาย bubble (ถ้ามี)
                          const segs = splitAnswerSegments(pair.zaapiReply.text);
                          // ถ้าไม่มี text segment แต่มี media/products (เช่น image/item) → แสดง 1 bubble
                          const bubbles = segs.length > 0 ? segs : [""];
                          return bubbles.map((seg, i) => (
                            <div
                              key={i}
                              className="bg-deep-space text-white rounded-lg rounded-tr-sm px-2.5 py-1.5 max-w-full overflow-hidden"
                            >
                              <MessageContent
                                msg={{
                                  ...pair.zaapiReply!,
                                  text: seg,
                                  // products/table แสดงที่ segment สุดท้ายเท่านั้น (กันซ้ำ)
                                  products: i === bubbles.length - 1 ? pair.zaapiReply!.products : undefined,
                                  table: i === bubbles.length - 1 ? pair.zaapiReply!.table : undefined,
                                }}
                                variant="out"
                              />
                            </div>
                          ));
                        })()
                      ) : (
                        <div className="bg-surface-2 border border-dashed border-border rounded-lg rounded-tr-sm px-2.5 py-1.5">
                          <p className="text-[11px] text-text-subtle italic">ไม่มีคำตอบจาก Zaapi</p>
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

        {/* ── ฝั่งขวา: Bot ของเรา ── */}
        <div className="flex-1 basis-0 flex flex-col min-w-0 overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-brand/5 shrink-0">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-md bg-brand/15 flex items-center justify-center">
                  <FlaskConical size={10} className="text-brand" />
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-text">Bot ของเรา</div>
                  <div className="text-[9px] text-text-subtle">บอทใหม่ที่กำลังพัฒนา</div>
                </div>
              </div>
              <button
                onClick={() => copyChat("bot")}
                disabled={pairs.length === 0}
                title="คัดลอกแชทฝั่ง Bot เรา"
                className="w-6 h-6 rounded-md flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {copiedSide === "bot" ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
              </button>
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
                const prevPair = idx > 0 ? pairs[idx - 1] : null;
                const showDateBanner = !prevPair || dayKey(prevPair.inbound.timestamp) !== dayKey(pair.inbound.timestamp);
                return (
                  <div key={idx} className="space-y-2">
                    {showDateBanner && <DateBanner timestamp={pair.inbound.timestamp} compact />}
                    {idx > 0 && !showDateBanner && <div className="border-t border-border/50 pt-2" />}
                    {/* Customer message (เดียวกัน) */}
                    <div className="flex gap-1.5">
                      <div className="w-5 h-5 rounded-full bg-surface-2 border border-border flex items-center justify-center shrink-0">
                        <User size={10} className="text-text-muted" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[9px] text-text-subtle mb-0.5">ลูกค้า · #{idx + 1} · {formatDateTimeLabel(pair.inbound.timestamp)}</div>
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
                      <div className="flex-1 min-w-0 flex flex-col items-end gap-1.5">
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
                            {(() => {
                              // ⚡ Multi-bubble — split ||| เป็นหลาย bubble (ถ้ามี)
                              const segs = splitAnswerSegments(pair.botReply.text);
                              // ถ้าไม่มี text segment แต่มี products → แสดง 1 bubble สำหรับ products
                              const bubbles = segs.length > 0 ? segs : [""];
                              return bubbles.map((seg, i) => (
                                <div key={i} className="bg-brand text-white rounded-lg rounded-tr-sm px-2.5 py-1.5 max-w-full overflow-hidden">
                                  <MessageContent
                                    msg={{
                                      id: pair.botReply!.shadow_reply_id || `bot_${idx}_${i}`,
                                      role: "bot",
                                      text: seg,
                                      timestamp: pair.inbound.timestamp,
                                      // products แสดงที่ segment สุดท้ายเท่านั้น (กันซ้ำ)
                                      products: i === bubbles.length - 1 ? pair.botReply!.products : undefined,
                                    }}
                                    variant="out"
                                  />
                                  {/* metadata — แสดงที่ segment สุดท้ายเท่านั้น */}
                                  {i === bubbles.length - 1 && (
                                    <div className="mt-1.5 pt-1 border-t border-white/20 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[8px] text-white/70 leading-tight">
                                      {pair.botReply!.model && (
                                        <span className="inline-flex items-center gap-0.5"><Cpu size={7} />{pair.botReply!.model}</span>
                                      )}
                                      {pair.botReply!.source && (
                                        <span className="inline-flex items-center gap-0.5"><Zap size={7} />{pair.botReply!.source}</span>
                                      )}
                                      {pair.botReply!.elapsed != null && (
                                        <span className="inline-flex items-center gap-0.5"><Clock size={7} />{pair.botReply!.elapsed}s</span>
                                      )}
                                      {pair.botReply!.tokens && (
                                        <span>tokens {pair.botReply!.tokens.total}</span>
                                      )}
                                    </div>
                                  )}
                                  {/* ── Routing decision ── */}
                                  {i === bubbles.length - 1 && pair.botReply!.routing_decision?.path && (
                                    <div className="mt-1 pt-0.5 border-t border-white/20 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[8px] leading-tight">
                                      <span className={pair.botReply!.routing_decision.path === "handoff" ? "text-amber-300 font-medium" : "text-emerald-300 font-medium"}>
                                        {pair.botReply!.routing_decision.path === "handoff" ? "🔀 Handoff" : "🤖 Bot"}
                                      </span>
                                      {pair.botReply!.routing_decision.reason && (
                                        <span className="text-white/60" title={pair.botReply!.routing_decision.reason}>
                                          {pair.botReply!.routing_decision.reason.length > 60
                                            ? pair.botReply!.routing_decision.reason.slice(0, 60) + "..."
                                            : pair.botReply!.routing_decision.reason}
                                        </span>
                                      )}
                                      {pair.botReply!.routing_decision.assigned_admin && (
                                        <span className="text-sky-300">👤 {pair.botReply!.routing_decision.assigned_admin}</span>
                                      )}
                                      {pair.botReply!.handoff_to_admin && (
                                        <span className="text-amber-300">📤 {pair.botReply!.handoff_reason || "handoff"}</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ));
                            })()}
                            {/* Rating UI — ใช้ RateBox แบบเดียวกับ test-chat */}
                            <div className="w-full self-stretch">
                              <RateBox
                                starRating={pair.botReply?.star_rating}
                                rating={rating}
                                comment={pair.botReply?.comment}
                                onStar={(v) => handleStar(idx, v)}
                                onRate={(rt) => handleRate(idx, rt)}
                                onComment={(text) => handleComment(idx, text)}
                              />
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

