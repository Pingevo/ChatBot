// POST /api/test-chat/dispatch — single orchestration entry สำหรับ Test Chat
// body: { session_id, input_mode?, message?, shop?, platform?, history?, limit?, images?, ticket_state? }
//   input_mode: "direct" (default — ใช้ body.message ไม่แตะ buffer)
//             | "buffered" (ใช้ snapshot rows; body.message = combined เดิมของ client — ไม่นับซ้ำ)
//
// ⚡ Phase 9 — precedence อยู่ใน owner เดียวกับ bot-worker
//   (workflowEngine.runInboundDispatch): active resume → new match → trigger → bot
//   client เรียกครั้งเดียวแล้ว render typed result — ห้าม sequence เอง
//   side effects: test store / buffer / simulate handoff เท่านั้น — ไม่แตะ production
//
// flow:
//   1. input_mode="buffered" → read snapshot rows (ยังไม่ลบ) → รวมเป็น 1 turn
//      "direct" → body.message (+images) เท่านั้น
//   2. runInboundDispatch(engineMsg, text, leaves) — owner ตัดสิน path เดียว
//   3. leaf ตั้ง consumed เมื่อ terminal-consume → ลบเฉพาะ snapshot message_ids
//      (in_flight/bot_error/exception → rows คงไว้ retry ได้)
//   4. คืน typed JSON ให้ client render
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { serverConfig } from "@/backend/lib/config";
import {
  shouldUseChatV2,
  shouldUseChatV3,
  getBotProductLimit,
  type Platform,
} from "@/backend/service/systemConfigService";
import { workflowEngine } from "@/backend/service/workflowEngine";
import { handoffService } from "@/backend/service/handoffService";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    session_id?: string;
    input_mode?: string;
    message?: string;
    shop?: string;
    platform?: string;
    history?: { role: "user" | "model"; text: string }[];
    limit?: number;
    images?: string[];
    ticket_state?: string;
  }>(req);

  if (!body?.session_id) return error("session_id is required", 422);

  // ⚡ Phase 9 review — explicit input mode (ห้าม infer จาก rows/prose/timing)
  const inputMode = body.input_mode ?? "direct";
  if (inputMode !== "direct" && inputMode !== "buffered") {
    return error("input_mode must be 'direct' or 'buffered'", 422);
  }

  const sessionId = String(body.session_id);
  const shop = body.shop ? String(body.shop) : "";
  const platform: Platform = (String(body.platform || "shopee") as Platform);
  const history = body.history || [];
  const limit = body.limit || (await getBotProductLimit());

  // ── 1. input source — explicit mode; buffered = snapshot rows (ยังไม่ลบ) ──
  const coll = await getCollection(COLLECTIONS.bufferMessages);
  let msgs: Record<string, any>[] = [];
  let combinedText = "";
  const allImages: string[] = [];
  const addImgs = (imgs: unknown) => {
    if (!Array.isArray(imgs)) return;
    for (const u of imgs) if (u && !allImages.includes(u as string)) allImages.push(u as string);
  };

  if (inputMode === "buffered") {
    msgs = await coll
      .find({ conversation_id: sessionId })
      .sort({ received_at: 1 })
      .toArray();
    // ใช้ space แทน \n เพื่อให้ RAG/LLM อ่านเป็นประโยคเดียว;
    // body.message = combined เดิมจาก client — ห้ามนับซ้ำ
    combinedText = msgs.map((m) => m.text).join(" ");
    for (const m of msgs) addImgs((m.raw_payload as Record<string, unknown> | undefined)?.images);
  } else {
    combinedText = String(body.message || "");
  }
  addImgs(body.images);

  const messageIds = msgs.map((m) => m.message_id);
  if (!combinedText.trim() && allImages.length === 0) {
    return json({ status: "empty", detail: "no input" });
  }

  // URL สัมพันธ์ → absolute (Python/engine fetch รูปผ่าน HTTP ได้)
  const origin = new URL(req.url).origin;
  const absImages = allImages.map((u) => (u.startsWith("http") ? u : `${origin}${u}`));

  // ── bot leaf — Python /chat (payload เดียวกับ /api/chatbot/chat + flush เดิม) ──
  const callTestBot = async (): Promise<{ ok: boolean; body: Record<string, unknown>; httpStatus?: number }> => {
    const baseUrl = serverConfig.chatbotBaseUrls[platform] || serverConfig.chatbotBaseUrls.shopee;
    const url = baseUrl.replace(/\/$/, "") + "/chat";
    const payload: Record<string, unknown> = { message: combinedText, limit, history };
    if (shop) payload.shop = shop;
    payload.conversation_id = sessionId;
    payload.simulate_assignment = true;
    if (body.ticket_state) payload.ticket_state = body.ticket_state;
    if (absImages.length > 0) payload.images = absImages;
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
        return {
          ok: false,
          httpStatus: resp.status,
          body: { error: errBody.detail || errBody.error || `bot returned ${resp.status}` },
        };
      }
      const data = await resp.json();
      return {
        ok: true,
        body: {
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
          image_desc: data.image_desc,
        },
      };
    } catch {
      return { ok: false, httpStatus: 502, body: { error: "chatbot service unreachable" } };
    }
  };

  // ── 2. shared dispatch owner — เหมือน bot-worker เป๊ะ (leaves = render/test-store เท่านั้น) ──
  const engineMsg = {
    message_id: `testwf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: sessionId,
    shop_id: shop,
    config_shop_key: shop,
    platform,
    text: combinedText,
    history,
    ...(absImages.length > 0 ? { images: absImages } : {}),
  };

  const bufferInfo = {
    combined_message: combinedText,
    message_count: msgs.length,
    message_ids: messageIds,
  };

  // consumed = terminal-consume เท่านั้น — in_flight/bot_error/exception คง rows
  let consumed = false;
  const result = await workflowEngine.runInboundDispatch(engineMsg, combinedText, {
    workflowInFlight: (res) =>
      json({ status: "in_flight", ...bufferInfo, detail: res.detail }),
    workflowError: (res) => {
      consumed = true; // recoverable:false = bot_failed-equivalent — terminal
      return json({ status: "workflow_error", ...bufferInfo, detail: res.detail });
    },
    workflowHandled: (res) => {
      consumed = true;
      return json({
        status: res.status === "resumed" ? "workflow_resumed" : "workflow_actioned",
        messages: res.delivered,
        handoff: res.handoff || null,
        detail: res.detail,
        run_id: res.run_id,
        workflow_id: res.workflow_id,
      });
    },
    workflowExitDrop: (res) => {
      consumed = true; // ทิ้งโดยเจตนา — terminal
      return json({ status: "exit_drop", ...bufferInfo, detail: res.detail });
    },
    triggerMatched: async (trigger) => {
      if (trigger.action === "handoff_admin") {
        // simulate handoff — test_status_conversation เท่านั้น (ไม่แตะ production)
        const h = await handoffService.handoffToAdminTest({
          conversationId: sessionId,
          shopId: shop,
          platform,
          reason: trigger.name,
          source: "test_chat",
        });
        consumed = true;
        return json({
          status: "trigger_handoff",
          trigger: { name: trigger.name, action: trigger.action },
          assigned_to: h.assignedTo,
          assigned_to_name: h.assignedToName,
          assignment_reason: h.assignmentReason,
          reopened: h.reopened,
        });
      }
      if (trigger.bot_template) {
        consumed = true;
        return json({
          status: "trigger_template",
          trigger: { name: trigger.name, action: trigger.action },
          template_text: trigger.bot_template,
        });
      }
      const bot = await callTestBot();
      if (!bot.ok) {
        return json({ status: "bot_error", ...bufferInfo, ...bot.body }, bot.httpStatus || 500);
      }
      consumed = true;
      return json({
        status: "trigger_bot_answer",
        trigger: { name: trigger.name, action: trigger.action },
        ...bufferInfo,
        ...bot.body,
      });
    },
    botFallback: async () => {
      const bot = await callTestBot();
      if (!bot.ok) {
        return json({ status: "bot_error", ...bufferInfo, ...bot.body }, bot.httpStatus || 500);
      }
      consumed = true;
      return json({ status: "bot_answered", ...bufferInfo, ...bot.body });
    },
  });

  // ── 3. snapshot cleanup — เฉพาะ consumed terminal; delete ด้วย snapshot
  //    message_ids เท่านั้น (row ที่ insert หลัง snapshot ต้องรอด)
  if (consumed && messageIds.length > 0) {
    await coll.deleteMany({ conversation_id: sessionId, message_id: { $in: messageIds } });
  }
  return result;
}
