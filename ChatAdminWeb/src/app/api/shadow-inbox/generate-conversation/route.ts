// POST /api/shadow-inbox/generate-conversation
// Generate shadow replies สำหรับทุก Q&A pair ใน conversation — แบบ sequential
//
// ลำดับ: คำถามเก่าสุด → bot ตอบ → history → คำถามถัดไป → bot ตอบ → ... จนจบ
// history ใช้คำตอบ bot เรา (ไม่ใช่ Zaapi)
//
// ⛔ ห้ามส่งข้อความจริง — เก็บใน shadow_replies เท่านั้น
// ⛔ ห้ามเรียก Shopee/TikTok/Lazada API
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { shadowReplyService } from "@/backend/service/shadowReplyService";
import { shouldUseChatV2 } from "@/backend/service/systemConfigService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { serverConfig } from "@/backend/lib/config";
import type { Platform } from "@/backend/lib/safety";

// ⚡ ให้ route นี้รันได้นานขึ้น (default ของ platform มัก ~30s ไม่พอสำหรับ generate ทั้ง conversation)
export const maxDuration = 300; // 5 นาที

/**
 * เรียก bot ของเราผ่าน proxy (เหมือน test-chat)
 * ไม่ได้เรียก platform API — เรียก Python chatbot service ของเราเท่านั้น
 */
async function callOurBot(params: {
  platform: Platform;
  message: string;
  history: { role: "user" | "model"; text: string }[];
  shopId: string;
  shopName?: string;
  use_v2?: boolean;
}): Promise<{
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
}> {
  const { platform, message, history, shopId, shopName, use_v2 } = params;
  const upstream = serverConfig.chatbotBaseUrls[platform].replace(/\/$/, "");
  const url = `${upstream}/chat`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Secret": serverConfig.chatbotInternalSecret,
  };

  const body: Record<string, unknown> = { message, history, limit: 5 };
  if (shopName) body.shop = shopName;
  else if (shopId) body.shop = shopId;
  // ⚡ chat_v2 — ส่ง use_v2 เพื่อบังคับใช้ chat_v2 (replay test)
  if (use_v2) body.use_v2 = true;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // ⚡ timeout 90 วิต่อครั้ง — กันค้างถ้า LLM ช้า
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`bot call failed (${resp.status}): ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  return {
    answer: data.answer || "(ไม่มีคำตอบ)",
    source: data.source,
    model: data.model,
    elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
    usage: data.usage,
    cost: typeof data.cost === "number" ? data.cost : undefined,
    products: data.products,
  };
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ conversation_id: string; use_v2?: boolean }>(req);
  if (!body || !body.conversation_id) {
    return error("conversation_id is required", 422);
  }

  // 🔒 coerce เพื่อป้องกัน NoSQL injection
  const conversationId = String(body.conversation_id);
  // ⚡ chat_engine — อ่านจาก SystemConfig (หน้า config ควบคุม)
  //    ถ้า body ส่ง use_v2 มา explicit → override config
  const configUseV2 = await shouldUseChatV2();
  const useV2 = body.use_v2 === true || (body.use_v2 === undefined && configUseV2);
  const chatEngine = useV2 ? "v2" : "legacy";
  const botCaller = useV2
    ? (p: Parameters<typeof callOurBot>[0]) => callOurBot({ ...p, use_v2: true })
    : callOurBot;

  try {
    console.log("[generate-conversation] start conv=", conversationId, "engine=", chatEngine);
    const docs = await shadowReplyService.generateConversation({
      conversationId,
      generatedBy: r.ctx.admin.admin_id,  // ⚡ Phase 3A — บันทึกใครกด Generate (KPI)
      chatEngine,  // ⚡ บันทึก engine ที่ใช้ใน shadow reply
      botCaller,
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
    return json({ shadow_replies: docs, total: docs.length, generation_batch_id: batchId });
  } catch (err) {
    const msg = (err as Error).message || "generate conversation shadow replies failed";
    console.error("[generate-conversation] ERROR:", msg, (err as Error).stack);
    return error(msg, 500);
  }
}
