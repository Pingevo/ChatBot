// POST /api/test-chat/flush — flush buffer สำหรับ test chat session
// body: { session_id, shop, platform, history?, limit? }
// คืน: { status: "flushed", combined_message, answer, ...bot_response }
//
// Flow:
//   1. ดึง messages ทั้งหมดจาก buffer_messages ที่ conversation_id = session_id
//   2. รวมเป็น 1 message (join \n)
//   3. ลบออกจาก buffer_messages
//   4. ส่ง combined message ไป Python bot (ผ่าน chatbot proxy logic)
//   5. คืน bot response กลับ client
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { serverConfig } from "@/backend/lib/config";
import { shouldUseChatV2, shouldUseChatV3, getBotProductLimit } from "@/backend/service/systemConfigService";
import type { Platform } from "@/backend/service/systemConfigService";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    session_id?: string;
    shop?: string;
    platform?: string;
    history?: { role: "user" | "model"; text: string }[];
    limit?: number;
    conversation_id?: string;
    simulate_assignment?: boolean;
  }>(req);

  if (!body?.session_id) return error("session_id is required", 422);

  const sessionId = String(body.session_id);
  const shop = body.shop ? String(body.shop) : "";
  const platform: Platform = (String(body.platform || "shopee") as Platform);
  const history = body.history || [];
  const limit = body.limit || (await getBotProductLimit());

  // 1. ดึง messages จาก buffer_messages
  const coll = await getCollection(COLLECTIONS.bufferMessages);
  const msgs = await coll
    .find({ conversation_id: sessionId })
    .sort({ received_at: 1 })
    .toArray();

  if (msgs.length === 0) {
    return json({ status: "empty", detail: "no buffered messages" });
  }

  // 2. รวมเป็น 1 message — ใช้ space แทน \n เพื่อให้ RAG/LLM อ่านเป็นประโยคเดียว
  const combinedText = msgs.map((m) => m.text).join(" ");
  const messageIds = msgs.map((m) => m.message_id);

  // ⚡ Phase 1F — รวม images จากทุก message (จาก raw_payload.images)
  const allImages: string[] = [];
  for (const m of msgs) {
    const rp = m.raw_payload as Record<string, unknown> | undefined;
    const imgs = Array.isArray(rp?.images) ? (rp!.images as string[]) : [];
    for (const u of imgs) {
      if (u && !allImages.includes(u)) allImages.push(u);
    }
  }

  // 3. ลบออกจาก buffer_messages
  await coll.deleteMany({ conversation_id: sessionId });

  // 4. ส่งไป Python bot (เหมือนที่ /api/chatbot/chat ทำ)
  const baseUrl = serverConfig.chatbotBaseUrls[platform] || serverConfig.chatbotBaseUrls.shopee;
  const url = baseUrl.replace(/\/$/, "") + "/chat";

  const payload: Record<string, unknown> = {
    message: combinedText,
    limit,
    history,
  };
  if (shop) payload.shop = shop;
  // ส่ง conversation_id (ใช้ session_id) + simulate_assignment เหมือน test chat ปกติ
  payload.conversation_id = sessionId;
  payload.simulate_assignment = true;
  // ⚡ Phase 1F — ส่ง images ให้ bot (URL สัมพันธ์ → แปลงเป็น absolute)
  if (allImages.length > 0) {
    // แปลง URL สัมพันธ์เป็น absolute (bot ดึง HTTP ได้)
    const origin = new URL(req.url).origin;
    payload.images = allImages.map((u) => (u.startsWith("http") ? u : `${origin}${u}`));
  }
  // ⚡ chat_engine — อ่านจาก SystemConfig (หน้า config ควบคุม) — v3 มี priority เหนือ v2
  const useV3 = await shouldUseChatV3();
  const useV2 = !useV3 && await shouldUseChatV2();
  if (useV3) payload.use_v3 = true;
  else if (useV2) payload.use_v2 = true;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": serverConfig.chatbotInternalSecret,
        "X-Admin-Id": r.ctx.admin.admin_id,
        "X-Admin-Name": encodeURIComponent(r.ctx.admin.name || ""),
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      return json({
        status: "bot_error",
        combined_message: combinedText,
        message_count: msgs.length,
        message_ids: messageIds,
        error: errBody.detail || errBody.error || `bot returned ${resp.status}`,
      }, resp.status);
    }

    const data = await resp.json();

    // 5. คืน bot response + ข้อมูล buffer
    return json({
      status: "flushed",
      combined_message: combinedText,
      message_count: msgs.length,
      message_ids: messageIds,
      // bot response (เหมือน /api/chatbot/chat คืน)
      answer: data.answer || "",
      answer_segments: data.answer_segments,
      products: data.products || [],
      elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
      usage: data.usage,
      cost: typeof data.cost === "number" ? data.cost : undefined,
      model: data.model,
      source: data.source,
      intent: data.intent,
      timing: data.timing,
      retrieval_info: data.retrieval_info,
      web_search_used: data.web_search_used === true,
      web_search_reason: data.web_search_reason,
      web_search_model: data.web_search_model,
      steps: data.steps,
      handoff_to_admin: data.handoff_to_admin === true,
      handoff_reason: data.handoff_reason,
      routing_decision: data.routing_decision,
    });
  } catch (err) {
    const msg = (err as Error).message || "chatbot unreachable";
    console.error("[test-chat/flush] bot call error:", msg);
    return json({
      status: "bot_error",
      combined_message: combinedText,
      message_count: msgs.length,
      message_ids: messageIds,
      error: "chatbot service unreachable",
    }, 502);
  }
}
