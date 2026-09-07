// Bot call service — แยก callBot ออกจาก botWorkerService
// เหตุผล: workflowEngine ต้องเรียก callBot (action let_ai_respond)
// และ botWorkerService.processMessage ต้องเรียก workflowEngine
// ถ้าทั้งคู่ import กันตรงๆ จะเกิด circular dependency → แยก callBot เป็น module ตรงกลาง
import { serverConfig } from "../lib/config";
import type { Platform } from "./systemConfigService";
import { getCollection, COLLECTIONS } from "../db/mongoClient";

export interface BotCallParams {
  platform: Platform;
  message: string;
  shopId: string;
  shopName?: string;
  // ⚡ Phase 1A multimodal — history อาจมี images + image_desc ของ turn ก่อนหน้า
  history: { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[];
  // ⚡ Phase 1A multimodal — URL รูปที่ลูกค้าส่งใน turn นี้
  images?: string[];
  // ⚡ Phase 2A — state-driven handoff: conversation_id + simulate flag
  //    ถ้ามี → ดึง status จาก DB แล้วส่ง ticket_state ให้บอท
  conversationId?: string;
  simulate?: boolean;
}

export interface BotCallResponse {
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
  // ⚡ Phase 1A multimodal — description ที่สกัดจากรูปใน turn นี้
  //    caller เก็บไว้ใน message doc เพื่อส่งกลับใน history ของ turn ถัดไป
  image_desc?: string;
}

/**
 * ⚡ Phase 2A — ดึง ticket state จาก DB
 *   simulate=true → ดึงจาก test_chat_sessions (mock)
 *   simulate=false → ดึงจาก conversations (จริง)
 *   คืน "open" | "closed" | "handoff" | "resolved" | "pending" | null
 */
async function resolveTicketState(
  conversationId: string | undefined,
  simulate: boolean | undefined
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    if (simulate) {
      // test chat — ดึงจาก test_chat_sessions
      const { ObjectId } = await import("mongodb");
      const coll = await getCollection<{ _id: typeof ObjectId.prototype; status?: string }>(COLLECTIONS.testChatSessions);
      const doc = await coll.findOne({ _id: new ObjectId(conversationId) });
      return doc?.status || null;
    }
    // production — ดึงจาก conversations
    const coll = await getCollection<{ conversation_id: string; status?: string }>(COLLECTIONS.conversations);
    const doc = await coll.findOne({ conversation_id: conversationId });
    return doc?.status || null;
  } catch (e) {
    console.error("[botCallService] resolveTicketState failed:", e);
    return null;
  }
}

/** เรียก Python bot ตรง (server-to-server ใช้ x-internal-secret — ไม่ใช้ cookie) */
export async function callBot(params: BotCallParams): Promise<BotCallResponse> {
  const baseUrl = serverConfig.chatbotBaseUrls[params.platform] || serverConfig.chatbotBaseUrls.shopee;
  const url = baseUrl.replace(/\/$/, "") + "/chat";
  // ⚡ Phase 2A — ดึง ticket_state จาก DB
  const ticketState = await resolveTicketState(params.conversationId, params.simulate);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": serverConfig.chatbotInternalSecret,
    },
    body: JSON.stringify({
      message: params.message,
      // ⚠️ Python bot รับ field "shop" (ชื่อร้าน) ไม่ใช่ "shop_id" (ตัวเลข)
      // ถ้าไม่มี shopName ใช้ shopId เป็น fallback (อาจไม่กรองร้านได้)
      shop: params.shopName || params.shopId,
      history: params.history,
      // ⚡ Phase 1A multimodal — ส่ง URL รูปให้ bot ใช้ Gemini vision อ่าน
      ...(params.images && params.images.length > 0 ? { images: params.images } : {}),
      // ⚡ Phase 2A — ส่ง ticket_state ให้บอทใช้ตัดสินใจ post-handoff
      ...(ticketState ? { ticket_state: ticketState } : {}),
      // ⚡ Phase 2A — ส่ง conversation_id + simulate ให้บอท (สำหรับ handoff API)
      ...(params.conversationId ? { conversation_id: params.conversationId } : {}),
      ...(params.simulate ? { simulate_assignment: true } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`bot call failed: ${resp.status}`);
  const data = await resp.json();
  return {
    answer: data.answer || "",
    source: data.source,
    model: data.model,
    elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
    usage: data.usage,
    cost: typeof data.cost === "number" ? data.cost : undefined,
    products: data.products,
    image_desc: typeof data.image_desc === "string" ? data.image_desc : undefined,
  };
}
