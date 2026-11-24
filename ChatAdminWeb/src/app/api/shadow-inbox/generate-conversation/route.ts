// POST /api/shadow-inbox/generate-conversation
// Generate shadow replies สำหรับทุก Q&A pair ใน conversation — แบบ sequential
//
// ลำดับ: คำถามเก่าสุด → bot ตอบ → history → คำถามถัดไป → bot ตอบ → ... จนจบ
// history ใช้คำตอบ bot เรา (ไม่ใช่ Zaapi)
//
// ⚡ Streaming — ส่งเป็น SSE (text/event-stream) ทีละคำตอบที่เสร็จ
//   event: progress  → { current, total }        (ก่อนเรียก bot แต่ละรอบ)
//   event: reply    → { shadow_reply: {...} }   (หลัง insert แต่ละ doc)
//   event: done      → { total, generation_batch_id }
//   event: error     → { message }               (ถ้า error)
//
// ⛔ ห้ามส่งข้อความจริง — เก็บใน shadow_replies เท่านั้น
// ⛔ ห้ามเรียก Shopee/TikTok/Lazada API
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { readJson } from "@/backend/lib/http";
import { shadowReplyService } from "@/backend/service/shadowReplyService";
import { getBotProductLimit, getChatEngine } from "@/backend/service/systemConfigService";
import { dispatchChatEngine } from "@/backend/service/botCallService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { serverConfig } from "@/backend/lib/config";
import type { Platform } from "@/backend/lib/safety";

// ⚡ ให้ route นี้รันได้นานขึ้น (default ของ platform มัก ~30s ไม่พอสำหรับ generate ทั้ง conversation)
export const maxDuration = 300; // 5 นาที

// ⚡ กัน Next.js ประมวลผล route นี้แบบ static — ต้องเป็น dynamic เสมอเพราะส่ง SSE
export const dynamic = "force-dynamic";

/**
 * ส่งคำถามเข้า engine กลางตาม chat_engine และเก็บผลใน shadow_replies
 * ไม่เรียก platform API และใช้ simulate mode เท่านั้น
 */
async function callOurBot(params: {
  platform: Platform;
  message: string;
  history: { role: "user" | "model"; text: string }[];
  shopId: string;
  shopName?: string;
  messageId?: string;
  conversationId?: string;  // ⚡ ส่ง conversation_id ให้ bot เพื่อบันทึก/ดึง anchor จาก timeline
  images?: string[];  // ⚡ ส่ง URL รูปให้ bot ใช้ Gemini vision อ่าน
}): Promise<{
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
  image_desc?: string;  // ⚡ A2 — vision description ของรูป current turn (cache กัน re-read)
  handoff_to_admin?: boolean;
  handoff_reason?: string;
  routing_decision?: unknown;
  chat_engine?: "legacy" | "v2" | "v3" | "v4";
}> {
  const { platform, message, history, shopId, shopName, conversationId, messageId, images } = params;
  const pythonPayload: Record<string, unknown> = { message, history, limit: await getBotProductLimit() };
  if (shopName) pythonPayload.shop = shopName;
  else if (shopId) pythonPayload.shop = shopId;
  if (conversationId) pythonPayload.conversation_id = `shadow:${conversationId}`;
  pythonPayload.simulate_assignment = true;
  if (images?.length) pythonPayload.images = images;
  const unsupported = platform === "shopee" ? undefined :
    `bot สำหรับ platform "${platform}" ยังไม่ deploy (URL=${serverConfig.chatbotBaseUrls[platform]}) — shadow-inbox รองรับเฉพาะ shopee`;
  const { chat_engine, data } = await dispatchChatEngine({
    platform,
    engine: await getChatEngine(),
    pythonPayload,
    pythonUnsupportedMessage: unsupported,
    timeoutMs: 90_000,
    v4Params: { platform, message, history, shopId, shopName, images, conversationId, messageId,
      simulate: true, testSource: "shadow" },
  });
  return {
    answer: data.answer || "(ไม่มีคำตอบ)",
    source: data.source,
    model: data.model,
    elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
    usage: data.usage,
    cost: typeof data.cost === "number" ? data.cost : undefined,
    products: data.products,
    image_desc: typeof data.image_desc === "string" ? data.image_desc : undefined,
    handoff_to_admin: data.handoff_to_admin === true || data.handoff_required === true, // ⚡ BUG-B — ส่งต่อให้ shadowReplyService เก็บ
    handoff_reason: typeof data.handoff_reason === "string" ? data.handoff_reason : undefined,
    routing_decision: data.routing_decision,
    chat_engine,
  };
}

/**
 * ⚡ SSE encoder — แปลง event + data เป็น SSE wire format
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 */
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) {
    // ⚡ auth fail ตอบเป็น SSE error ด้วย เพื่อให้ client parser จัดการได้
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(sseEvent("error", { message: "unauthorized" })));
        controller.close();
      },
    });
    return new Response(body, {
      status: 401,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  const body = await readJson<{ conversation_id: string; use_v2?: boolean; use_v3?: boolean }>(req);
  if (!body || !body.conversation_id) {
    const errBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(sseEvent("error", { message: "conversation_id is required" })));
        controller.close();
      },
    });
    return new Response(errBody, {
      status: 422,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // 🔒 coerce เพื่อป้องกัน NoSQL injection
  const conversationId = String(body.conversation_id);
  const chatEngine = await getChatEngine();
  const botCaller = callOurBot;

  // ⚡ SSE stream — ส่งทีละคำตอบที่เสร็จ ไม่ต้องรอครบทุก Q&A
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(sseEvent(event, data)));
        } catch {
          // controller อาจถูก close ไปแล้ว (client disconnect) → ไม่ต้อง throw
        }
      };

      try {
        console.log("[generate-conversation] start conv=", conversationId, "engine=", chatEngine);
        const docs = await shadowReplyService.generateConversation({
          conversationId,
          generatedBy: r.ctx.admin.admin_id,  // ⚡ Phase 3A — บันทึกใครกด Generate (KPI)
          chatEngine,  // ⚡ บันทึก engine ที่ใช้ใน shadow reply
          botCaller,
          onProgress: (current, total, pair) => {
            send("progress", { current, total, inbound_text: pair.inbound_text });
          },
          onReply: (doc, current, total) => {
            send("reply", { shadow_reply: doc, current, total });
          },
        });
        // ⚡ Phase 3B-6 — ดึง generation_batch_id ที่ service แท็กไว้ใน results
        const batchId = (docs as unknown as { batchId?: string }).batchId;

        // audit log
        await logAdminEvent({
          action_type: "shadow_reply.generate_conversation",
          actor: r.ctx.admin.admin_id,
          conversation_id: conversationId,
          metadata: {
            count: docs.length,
            delivered_to_platform: false,
            ...(batchId ? { generation_batch_id: batchId } : {}),
          },
        });

        console.log("[generate-conversation] done docs=", docs.length, "batch=", batchId);
        send("done", { total: docs.length, generation_batch_id: batchId });
      } catch (err) {
        const msg = (err as Error).message || "generate conversation shadow replies failed";
        console.error("[generate-conversation] ERROR:", msg, (err as Error).stack);
        send("error", { message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // ⚡ กัน proxy/CDN รวม buffer รอให้ครบก่อนส่งต่อ
      "X-Accel-Buffering": "no",
    },
  });
}
