// Bot Worker Service — Pipeline ประมวลผลข้อความใหม่
// 
// Flow:
//   แชทใหม่เข้า (messages_shp, role=user, direction=in)
//     → check trigger
//       → แมทช์ + bot_answer → เรียกบอท → เก็บใน shadow_replies (ดูใน Shadow Inbox)
//       → แมทช์ + handoff_admin → จ่ายงาน round-robin → เขียน assigned_to ลง conversations_shp
//       → ไม่แมทช์ → เรียกบอท → เก็บใน shadow_replies
//         → บอทส่งต่อ → จ่ายงาน round-robin
//
// ⚠️ SAFETY:
//   - อ่าน messages_shp / conversations_shp (READ-ONLY สำหรับเนื้อหาแชท)
//   - เขียน assigned_to ลง conversations_shp (พี่เขาให้เราใช้ test)
//   - คำตอบบอทเก็บใน shadow_replies (ไม่เขียนลง messages_shp — ไม่ปนกับแชทจริง)
//   - ไม่ call Shopee API
//   - ไม่ส่งข้อความจริงให้ลูกค้า
//   - ไม่ยุ่งกับ sellcenter
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { triggerService } from "./triggerService";
import { assignmentService } from "./assignmentService";
import { logAdminEvent } from "./adminLogService";
import { listMessages, getHistoryForBot, getGroupedHistoryForBot, toBotText, toBotImages, type MessageDoc } from "./messageService";
import { getConversation } from "./conversationService";
import { handoffService } from "./handoffService";
import { assertPlatformApiDisabled, type Platform } from "../lib/safety";
import type { ShadowReplyDoc } from "./shadowReplyService";
import { bufferService, type BufferConfig } from "./bufferService";
import { getSystemConfig } from "./systemConfigService";
// ⚡ callBot ย้ายไป botCallService (แก้ circular dependency กับ workflowEngine)
import { callBot } from "./botCallService";
// ⚡ Workflow engine (แบบ Zaapi Flow Builder) — ① resume ② priority ③ บอท
import { workflowEngine, type EngineResult, type DeliveredMessage } from "./workflowEngine";

// ─── Types ────────────────────────────────────────────────

export interface ChatProcessingDoc extends Document {
  message_id: string;           // id ของข้อความที่ประมวลผลแล้ว
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  status: "trigger_matched" | "bot_answered" | "handed_off" | "bot_failed" | "no_action" | "workflow_actioned" | "workflow_resumed";
  trigger_id?: string;
  trigger_action?: "bot_answer" | "handoff_admin";
  shadow_reply_id?: string;     // ref to shadow_replies
  assigned_to?: string;         // admin_id ที่ถูกจ่ายงาน (ถ้า handoff)
  assignment_mode?: string;
  error?: string;
  processed_at: Date;
}

// ─── Bot Caller — ย้ายไป botCallService.ts (re-export ผ่าน botWorkerService ด้านล่าง) ──

// ─── Check if message already processed ───────────────────

async function isProcessed(messageId: string): Promise<boolean> {
  const coll = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const existing = await coll.findOne({ message_id: messageId });
  return !!existing;
}

// ─── Mark processed ───────────────────────────────────────

async function markProcessed(doc: Partial<Omit<ChatProcessingDoc, "_id" | "processed_at">> & {
  message_id: string; conversation_id: string; shop_id: string; platform: Platform; status: ChatProcessingDoc["status"];
}): Promise<void> {
  const coll = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  await coll.insertOne({
    ...doc,
    processed_at: new Date(),
  } as ChatProcessingDoc);
}

// ─── Store bot reply in shadow_replies (NOT messages_shp) ──

function genShadowReplyId(): string {
  return "sr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function storeBotReply(opts: {
  messageId: string;
  messageText: string;
  conversationId: string;
  shopId: string;
  platform: Platform;
  botResp: Awaited<ReturnType<typeof callBot>>;
  triggerId?: string;
}): Promise<string> {
  const shadowReplyId = genShadowReplyId();
  const now = new Date();

  // หา Zaapi/sellcenter reply สำหรับ inbound message นี้ (ถ้ามี)
  const messages = await listMessages(opts.conversationId, { platform: opts.platform, limit: 50 });
  const inboundMsg = messages.find((m) => m.message_id === opts.messageId);
  const zaapiReply = inboundMsg
    ? messages.find(
        (m) =>
          m.direction === "out" &&
          m.role !== "user" &&
          m.source !== "admin" &&
          m.created_timestamp > inboundMsg.created_timestamp
      )
    : undefined;

  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  await coll.insertOne({
    shadow_reply_id: shadowReplyId,
    conversation_id: opts.conversationId,
    shop_id: opts.shopId,
    platform: opts.platform,
    inbound_message_id: opts.messageId,
    inbound_text: opts.messageText,
    bot_reply_text: opts.botResp.answer,
    bot_source: opts.botResp.source,
    bot_model: opts.botResp.model,
    bot_elapsed_ms: opts.botResp.elapsed,
    bot_tokens: opts.botResp.usage,
    bot_cost_usd: opts.botResp.cost,
    bot_cost_thb: opts.botResp.cost ? opts.botResp.cost * 36 : undefined,
    bot_products: opts.botResp.products,
    zaapi_reply_text: zaapiReply?.text,
    zaapi_reply_message_id: zaapiReply?.message_id,
    rating: "unrated",
    origin: "worker",  // สร้างจาก worker (auto pipeline)
    mode: "standalone",  // ⚡ Phase 2R — โหมด standalone (botworker รันอัตโนมัติ)
    trigger_id: opts.triggerId,
    chat_engine: opts.botResp.chat_engine || "legacy", // ⚡ บันทึก engine ที่ใช้
    created_at: now,
    updated_at: now,
  });

  // ⚡ Phase 1A multimodal — เก็บ image_desc ที่ vision pass สกัดได้ ลงใน inbound message doc
  //    ทำให้ turn ถัดไปส่ง image_desc ใน history → bot ไม่ต้องอ่านรูปซ้ำ
  if (opts.botResp.image_desc) {
    const msgColl = await getCollection<MessageDoc>(COLLECTIONS.messages);
    await msgColl.updateOne(
      { message_id: opts.messageId },
      { $set: { image_desc: opts.botResp.image_desc } },
    );
  }

  return shadowReplyId;
}

// ─── Store workflow delivered messages in shadow_replies ──
// เหมือน storeBotReply แต่ origin="workflow" — 1 delivered message = 1 shadow reply
// ⚠️ inbound_message_id มี unique index — หลาย delivered ต่อ inbound เดียว → ต่อท้าย suffix __wf<N>
async function storeWorkflowDelivered(opts: {
  messageId: string;
  messageText: string;
  conversationId: string;
  shopId: string;
  platform: Platform;
  delivered: DeliveredMessage[];
  workflowId: string;
}): Promise<string[]> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const ids: string[] = [];
  const now = new Date();
  for (let i = 0; i < opts.delivered.length; i++) {
    const d = opts.delivered[i];
    const shadowReplyId = genShadowReplyId();
    await coll.insertOne({
      shadow_reply_id: shadowReplyId,
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      platform: opts.platform,
      inbound_message_id: `${opts.messageId}__wf${i}`,
      inbound_text: opts.messageText,
      bot_reply_text: d.text,
      bot_source: d.source,
      rating: "unrated",
      origin: "workflow",  // สร้างจาก workflow engine (Flow Builder)
      mode: "standalone",  // ⚡ Phase 2R — โหมด standalone (worker path)
      chat_engine: "legacy", // ⚡ workflow ยังใช้ legacy path (ไม่ผ่าน callBot)
      created_at: now,
      updated_at: now,
    } as ShadowReplyDoc);
    ids.push(shadowReplyId);
  }
  return ids;
}

/** จัดการผล workflow แบบเดียวกันทั้ง resume และ match ใหม่ — deliver + mark + return shape */
async function settleWorkflowResult(
  msg: { message_id: string; conversation_id: string; shop_id: string; platform: Platform },
  botText: string,
  wfResult: EngineResult,
  statusLabel: "workflow_actioned" | "workflow_resumed"
): Promise<{ status: string; detail: string }> {
  // เก็บ delivered ลง shadow_replies (worker path — ไม่ส่งจริงเหมือนเดิม)
  const shadowReplyIds = await storeWorkflowDelivered({
    messageId: msg.message_id,
    messageText: botText,
    conversationId: msg.conversation_id,
    shopId: msg.shop_id,
    platform: msg.platform,
    delivered: wfResult.delivered,
    workflowId: wfResult.workflow_id || "",
  });

  if (wfResult.handoff) {
    // assign_ticket action → จ่ายงานแล้ว (engine ทำแล้ว) — แค่ mark + log
    await markProcessed({
      message_id: msg.message_id,
      conversation_id: msg.conversation_id,
      shop_id: msg.shop_id,
      platform: msg.platform,
      status: "handed_off",
      assigned_to: wfResult.handoff.agentId || undefined,
    });
    await logAdminEvent({
      action_type: "bot.reply",
      actor: "bot-worker",
      conversation_id: msg.conversation_id,
      metadata: {
        workflow_id: wfResult.workflow_id,
        assigned_to: wfResult.handoff.agentId,
        delivered_to_platform: false,
      },
    });
    return { status: "workflow_handed_off", detail: `${wfResult.detail} → ${wfResult.handoff.agentId || "no agent"}` };
  }

  await markProcessed({
    message_id: msg.message_id,
    conversation_id: msg.conversation_id,
    shop_id: msg.shop_id,
    platform: msg.platform,
    status: statusLabel,
  });
  await logAdminEvent({
    action_type: "bot.reply",
    actor: "bot-worker",
    conversation_id: msg.conversation_id,
    metadata: {
      workflow_id: wfResult.workflow_id,
      shadow_reply_ids: shadowReplyIds,
      delivered_to_platform: false,
    },
  });
  return { status: statusLabel, detail: wfResult.detail };
}

// ─── Pick next agent — ใช้ handoffService เพื่อหา admin เดิมก่อน round-robin ──
// ลำดับ:
//   1. ถ้ามี assigned_to อยู่แล้ว → ใช้คนเดิม
//   2. ถ้าไม่มี → หา admin คนสุดท้ายที่เคยตอบ (getLastReplyAdmin)
//   3. ถ้าไม่มี → round-robin (autoAssignConversation)
//   4. ถ้า conversation ปิดอยู่ → reopen ก่อน
//
// ⚡ Phase 2V — เขียนผลลัพธ์ลง test_status_conversation (source=botworker)
//   ไม่ใช่ status_conversation เพื่อไม่ให้กระทบ /tickets
async function pickAgent(
  shopId: string,
  platform: Platform,
  conversationId: string,
  reason?: string
): Promise<{ agentId: string | null; mode: string }> {
  const mode = await assignmentService.getActiveAssignmentConfig();
  const result = await handoffService.handoffToAdmin({
    conversationId,
    shopId,
    platform,
    reason: reason || "bot-worker handoff",
    source: "botworker",
  });
  // ⚡ Phase 2V — mirror ผลลัพธ์ลง test_status_conversation (source=botworker)
  //   เพื่อให้ /botworker UI เห็น status/assigned_to โดยไม่กระทบ /tickets
  try {
    const { testStatusConversationService } = await import("./testStatusConversationService");
    await testStatusConversationService.updateTestStatus(
      conversationId,
      "botworker",
      "handoff",
      result.assignedTo || undefined
    );
  } catch {
    // ignore — ไม่วิกฤตถ้า mirror ล้มเหลว
  }
  return { agentId: result.assignedTo, mode };
}

// ─── Process one message ──────────────────────────────────

export async function processMessage(msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  images?: string[];  // ⚡ Phase 1F — image URLs รวมจาก buffer flush
}): Promise<{ status: string; detail: string }> {
  // 1. ตรวจซ้ำ — ถ้าประมวลผลแล้ว ข้าม
  if (await isProcessed(msg.message_id)) {
    return { status: "skip", detail: "already processed" };
  }

  // ⛔ Safety guard — กันเรียก platform API โดยไม่ตั้งใจ
  assertPlatformApiDisabled(msg.platform, "send");
  assertPlatformApiDisabled(msg.platform, "read");

  // ⚡ Phase 2Q — อัปเดต concurrency limit จาก config (admin ปรับได้ใน /admin-config)
  try {
    const sysConfig = await getSystemConfig();
    currentConcurrencyLimit = sysConfig.bot_concurrency_limit || 50;
  } catch {
    // ถ้าอ่าน config ไม่ได้ → ใช้ค่าเดิม
  }

  // ดึง shop_name จาก conversation — Python bot ต้องการชื่อร้าน (ไม่ใช่ shop_id ตัวเลข)
  // เพื่อกรองสินค้าเฉพาะร้านที่ลูกค้าทักเข้ามา
  const conv = await getConversation(msg.conversation_id);
  const shopName = conv?.shop_name || undefined;

  // ── Guard: จ่ายงานเฉพาะแอดมิน + ตรวจสถานะ conversation ──
  // ⚡ Phase 2V — แยก collection ระหว่าง botworker กับ ticket
  //   อ่าน: status_conversation (read-only — เช็ค admin จริงกำลังตอบไหม)
  //   เขียน: test_status_conversation source="botworker" (handoff/reopen/status)
  //   ทำให้ botworker ไม่กระทบ /tickets เลย
  //
  // 1. ถ้ามี assigned_to และ status เปิดอยู่ (handoff) → ข้าม (ปล่อยให้แอดมินตอบ)
  // 2. ถ้า status === closed → reopen ใน test_status_conversation + ประมวลผลปกติ
  // 3. ถ้าไม่มี assigned_to (status=bot) → ประมวลผลปกติ
  if (conv) {
    const { statusConversationService } = await import("./statusConversationService");
    const { testStatusConversationService } = await import("./testStatusConversationService");
    // ⚡ Phase 2V — อ่านจาก status_conversation (จริง) เพื่อเช็ค admin จริง
    const meta = await statusConversationService.getMeta(msg.conversation_id);
    const effectiveStatus = meta?.status || "bot";
    const effectiveAssignedTo = meta?.assigned_to || null;
    const isClosed = effectiveStatus === "closed" || effectiveStatus === "resolved";
    if (effectiveAssignedTo && !isClosed) {
      // ⚡ Workflow guard — admin รับแชทแล้ว → flow ที่รอ reply ต้อง cancel อัตโนมัติ (planner ข้อ 3)
      await workflowEngine.cancelActiveRuns(
        msg.conversation_id,
        `admin ${effectiveAssignedTo} กำลังดูแชท — cancel flow ที่รอ reply`
      );
      // แอดมินกำลังดูแชทอยู่ → ข้าม (ปล่อยให้แอดมินตอบ)
      await markProcessed({
        message_id: msg.message_id,
        conversation_id: msg.conversation_id,
        shop_id: msg.shop_id,
        platform: msg.platform,
        status: "no_action",
      });
      return { status: "skip_assigned", detail: `conversation has assigned_to=${effectiveAssignedTo} (handoff) — skip` };
    }
    if (isClosed) {
      // ⚡ Phase 2V — reopen ใน test_status_conversation (source=botworker) ไม่ใช่ status_conversation
      //   ไม่กระทบ /tickets — ticket จริงยังปิดอยู่
      await testStatusConversationService.updateTestStatus(
        msg.conversation_id,
        "botworker",
        "bot",
        undefined  // clear assigned_to
      );
    }
  }

  // ⚠️ Enrich text สำหรับ rich-media messages (item card, order card, ...)
  // ถ้าลูกค้าแชร์การ์ดสินค้า `text` จะเป็น placeholder "[item]" แต่ raw_payload มี item_id
  // แปลงเป็น tag "[สินค้า: <item_id>]" ที่ Python bot เข้าใจ ก่อนส่งให้ trigger/bot
  const botText = toBotText(msg);
  // ⚡ Phase 1A multimodal — ดึง URL รูปจาก raw_payload ส่งให้ bot ใน field images
  // ⚡ Phase 1F — ถ้ามี msg.images (จาก buffer flush รวมหลายรูป) ให้ใช้แทน toBotImages
  const botImages = msg.images && msg.images.length > 0 ? msg.images : toBotImages(msg);

  // ⚡ Workflow engine (แบบ Zaapi Flow Builder) — อ้างอิง docs/plans/workflow-planner.md
  // ① Active Flow Resume (เสมอ ไม่สน priority) — แชทนี้มี flow ที่กำลังรอ reply อยู่ไหม?
  //    มี → ส่งข้อความเข้า flow เดิม (resume) → จบ
  // ② Priority (workflow_first default) — workflow ก่อน trigger
  //    workflow_first: workflow ฮิต → จบ / ไม่ฮิต → trigger → บอท
  //    both: workflow ฮิต → deliver แล้วไป trigger ต่อ (⚠️ ตอบซ้ำได้ — planner เตือนแล้ว)
  //    trigger_first: ตรวจหลัง trigger ไม่ match (ดูด้านล่าง)
  // ③ บอท — เหมือนเดิม ไม่แตะ
  const wfConfig = await getSystemConfig();
  const engineMsg = {
    message_id: msg.message_id,
    conversation_id: msg.conversation_id,
    shop_id: msg.shop_id,
    platform: msg.platform,
    text: botText,
    customer_id: conv?.customer_id,
    // ⚡ ส่ง media URLs (image/video) เข้า engine ด้วย — EngineMessage ไม่มี raw_payload
    //    ทำให้ toBotImages(engineMsg) ใน let_ai_respond คืน [] → ทิ้ง video URL
    ...(botImages.length > 0 ? { images: botImages } : {}),
  };

  if (wfConfig.workflow_enabled) {
    // ① Active Flow Resume — flow รอ reply อยู่ → ข้อความใหม่เข้า flow ก่อนเสมอ
    const activeRun = await workflowEngine.getActiveRun(msg.conversation_id);
    if (activeRun) {
      const wfResult = await workflowEngine.resumeFlow(activeRun, engineMsg);
      if (wfResult.status === "error") {
        // resume พัง → ข้อความนี้ตกไป trigger/bot ตามปกติ (ไม่ทิ้งลูกค้า)
        console.error(`[worker] workflow resume error: ${wfResult.detail}`);
      } else {
        return settleWorkflowResult(msg, botText, wfResult, "workflow_resumed");
      }
    }

    // ② workflow_first / both — ลอง match workflow ก่อน trigger
    if (wfConfig.workflow_priority === "workflow_first" || wfConfig.workflow_priority === "both") {
      const wfResult = await workflowEngine.matchAndRun(engineMsg);
      if (wfResult.status === "actioned" || wfResult.status === "resumed") {
        if (wfConfig.workflow_priority === "workflow_first") {
          return settleWorkflowResult(msg, botText, wfResult, "workflow_actioned");
        }
        // both → deliver แล้วไป trigger ต่อ (ตอบซ้ำได้ — ไม่แนะนำ แต่ planner ให้เลือกได้)
        await storeWorkflowDelivered({
          messageId: msg.message_id,
          messageText: botText,
          conversationId: msg.conversation_id,
          shopId: msg.shop_id,
          platform: msg.platform,
          delivered: wfResult.delivered,
          workflowId: wfResult.workflow_id || "",
        });
        // ไม่ return — ไป trigger ต่อ
      } else if (wfResult.status === "exit_drop") {
        // condition false + exit_drop → cancel flow + ทิ้งข้อความ
        await markProcessed({
          message_id: msg.message_id,
          conversation_id: msg.conversation_id,
          shop_id: msg.shop_id,
          platform: msg.platform,
          status: "no_action",
        });
        return { status: "workflow_exit_drop", detail: wfResult.detail };
      }
      // exit_to_bot / no_match / error → fall through ไป trigger → บอท (ตาม pipeline ปกติ)
    }
  }

  try {
    // 2. Check trigger
    const trigger = await triggerService.matchTrigger(msg.text, {
      shopId: msg.shop_id,
      platform: msg.platform,
    });

    if (trigger) {
      // ── แมทช์ trigger ──
      if (trigger.action === "handoff_admin") {
        // ส่งให้แอดมิน — round-robin
        const { agentId, mode } = await pickAgent(msg.shop_id, msg.platform, msg.conversation_id);
        await markProcessed({
          message_id: msg.message_id,
          conversation_id: msg.conversation_id,
          shop_id: msg.shop_id,
          platform: msg.platform,
          status: "handed_off",
          trigger_id: trigger.trigger_id,
          trigger_action: "handoff_admin",
          assigned_to: agentId || undefined,
          assignment_mode: mode,
        });
        await logAdminEvent({
          action_type: "bot.handoff_to_admin",
          actor: "bot-worker",
          conversation_id: msg.conversation_id,
          metadata: { trigger_id: trigger.trigger_id, assigned_to: agentId, delivered_to_platform: false },
        });
        return { status: "handed_off", detail: `trigger→handoff→${agentId || "no agent"}` };
      }

      // trigger.action === "bot_answer" → เรียกบอท → เก็บใน shadow_replies
      // ⚡ grouped history — รวม user messages ติดกันเป็น 1 turn + fallback Zaapi
      const history = await getGroupedHistoryForBot({
        conversationId: msg.conversation_id,
        platform: msg.platform,
        maxTurns: 10,
      });
      // ⚡ Phase 2Q — acquire concurrency slot ก่อนยิงบอท
      await acquireBotSlot();
      let botResp;
      try {
        botResp = await callBot({
          platform: msg.platform,
          message: botText,
          shopId: msg.shop_id,
          shopName,
          history,
          ...(botImages.length > 0 ? { images: botImages } : {}),
          // ⚡ Phase 2A — ส่ง conversationId (production path, simulate=false)
          conversationId: msg.conversation_id,
          simulate: false,
        });
      } finally {
        releaseBotSlot();
      }
      const shadowReplyId = await storeBotReply({
        messageId: msg.message_id,
        messageText: botText,
        conversationId: msg.conversation_id,
        shopId: msg.shop_id,
        platform: msg.platform,
        botResp,
        triggerId: trigger.trigger_id,
      });
      await markProcessed({
        message_id: msg.message_id,
        conversation_id: msg.conversation_id,
        shop_id: msg.shop_id,
        platform: msg.platform,
        status: "trigger_matched",
        trigger_id: trigger.trigger_id,
        trigger_action: "bot_answer",
        shadow_reply_id: shadowReplyId,
      });
      await logAdminEvent({
        action_type: "bot.reply",
        actor: "bot-worker",
        conversation_id: msg.conversation_id,
        metadata: { trigger_id: trigger.trigger_id, shadow_reply_id: shadowReplyId, delivered_to_platform: false },
      });
      return { status: "trigger_matched", detail: `trigger→bot_answer→${shadowReplyId}` };
    }

    // ⚡ trigger_first — trigger ไม่ match → ลอง workflow ก่อนไปบอท (planner ②)
    if (wfConfig.workflow_enabled && wfConfig.workflow_priority === "trigger_first") {
      const wfResult = await workflowEngine.matchAndRun(engineMsg);
      if (wfResult.status === "actioned" || wfResult.status === "resumed") {
        return settleWorkflowResult(msg, botText, wfResult, "workflow_actioned");
      }
      if (wfResult.status === "exit_drop") {
        await markProcessed({
          message_id: msg.message_id,
          conversation_id: msg.conversation_id,
          shop_id: msg.shop_id,
          platform: msg.platform,
          status: "no_action",
        });
        return { status: "workflow_exit_drop", detail: wfResult.detail };
      }
      // exit_to_bot / no_match / error → ไปบอท (fall through)
    }

    // ── ไม่แมทช์ trigger → ส่งให้บอทตอบ → เก็บใน shadow_replies ──
    // ⚡ grouped history — รวม user messages ติดกันเป็น 1 turn + fallback Zaapi
    const history = await getGroupedHistoryForBot({
      conversationId: msg.conversation_id,
      platform: msg.platform,
      maxTurns: 10,
    });
    // ⚡ Phase 2Q — acquire concurrency slot ก่อนยิงบอท
    await acquireBotSlot();
    let botResp;
    try {
      botResp = await callBot({
        platform: msg.platform,
        message: botText,
        shopId: msg.shop_id,
        shopName,
        history,
        ...(botImages.length > 0 ? { images: botImages } : {}),
        // ⚡ Phase 2A — ส่ง conversationId (production path, simulate=false)
        conversationId: msg.conversation_id,
        simulate: false,
      });
    } finally {
      releaseBotSlot();
    }

    if (!botResp.answer || botResp.answer.trim() === "") {
      // บอทตอบไม่ได้ → ส่งต่อแอดมิน
      const { agentId, mode } = await pickAgent(msg.shop_id, msg.platform, msg.conversation_id);
      await markProcessed({
        message_id: msg.message_id,
        conversation_id: msg.conversation_id,
        shop_id: msg.shop_id,
        platform: msg.platform,
        status: "handed_off",
        assigned_to: agentId || undefined,
        assignment_mode: mode,
      });
      await logAdminEvent({
        action_type: "bot.handoff_to_admin",
        actor: "bot-worker",
        conversation_id: msg.conversation_id,
        metadata: { reason: "bot empty answer", assigned_to: agentId, delivered_to_platform: false },
      });
      return { status: "handed_off", detail: `no trigger→bot empty→handoff→${agentId || "no agent"}` };
    }

    // บอทตอบได้ → เก็บใน shadow_replies (ไม่เขียน messages_shp)
    const shadowReplyId = await storeBotReply({
      messageId: msg.message_id,
      messageText: botText,
      conversationId: msg.conversation_id,
      shopId: msg.shop_id,
      platform: msg.platform,
      botResp,
    });
    await markProcessed({
      message_id: msg.message_id,
      conversation_id: msg.conversation_id,
      shop_id: msg.shop_id,
      platform: msg.platform,
      status: "bot_answered",
      shadow_reply_id: shadowReplyId,
    });
    await logAdminEvent({
      action_type: "bot.reply",
      actor: "bot-worker",
      conversation_id: msg.conversation_id,
      metadata: { shadow_reply_id: shadowReplyId, delivered_to_platform: false },
    });
    return { status: "bot_answered", detail: `no trigger→bot→${shadowReplyId}` };

  } catch (err) {
    // บอท error → บันทึก error
    const errorMsg = err instanceof Error ? err.message : String(err);
    await markProcessed({
      message_id: msg.message_id,
      conversation_id: msg.conversation_id,
      shop_id: msg.shop_id,
      platform: msg.platform,
      status: "bot_failed",
      error: errorMsg,
    });
    await logAdminEvent({
      action_type: "bot.process_failed",
      actor: "bot-worker",
      conversation_id: msg.conversation_id,
      metadata: { error: errorMsg },
    });
    return { status: "bot_failed", detail: errorMsg };
  }
}

// ─── Poll for new messages ────────────────────────────────
// FIRE-AND-FORGET: แต่ละข้อความยิงไปประมวลผลแยกอิสระ ไม่รอคิว ไม่รอ batch
//   10 คำถามเข้าพร้อมกัน → ยิง 10 reqs ไปบอทพร้อมกัน → บอทตอบทีละคำตอบเสร็จก่อนก็ตอบก่อน
//   ไม่ใช่นั่งรอคำถามแรกเสร็จถึงเริ่มคำถามสอง และไม่ใช่รอทั้ง 10 เสร็จถึงส่งคำตอบ
//
// ⚡ Phase 2Q — Concurrency limiter (semaphore pattern)
//   ถ้า buffer เปิด → 500 ข้อความเข้ามา → buffer รวมเป็น 200 context → flush พร้อมกัน
//   ถ้าไม่จำกัด → ยิงบอท 200 reqs พร้อมกัน → Python bot โอเวอร์โหลด
//   ใช้ bot_concurrency_limit จาก config (admin ปรับได้ใน /admin-config, default 50)
let activeBotCalls = 0;
let currentConcurrencyLimit = 50;
const botCallQueue: Array<() => void> = [];

async function acquireBotSlot(): Promise<void> {
  // ⚡ Phase 2Q — อ่าน limit จาก config ทุกครั้ง (admin อาจเปลี่ยนได้)
  if (activeBotCalls < currentConcurrencyLimit) {
    activeBotCalls++;
    return;
  }
  await new Promise<void>((resolve) => {
    botCallQueue.push(() => {
      activeBotCalls++;
      resolve();
    });
  });
}

function releaseBotSlot(): void {
  activeBotCalls--;
  const next = botCallQueue.shift();
  if (next) next();
}

// track in-flight promises (เก็บไว้สำหรับ graceful shutdown เท่านั้น — ไม่ await ในลูป)
const inFlight = new Set<Promise<void>>();

export async function pollNewMessages(since?: Date): Promise<{
  found: number;
  processed: number;
  results: { message_id: string; status: string; detail: string }[];
}> {
  const coll = await getCollection<{
    message_id: string; conversation_id: string; shop_id: string;
    platform: Platform; role: string; direction: string; text: string;
    raw_payload?: unknown;
  }>(COLLECTIONS.messages);

  // หาข้อความใหม่: role=user, direction=in, เรียงใหม่ล่าสุดก่อน
  // ⚡ Phase 2P — ถ้ามี since → ประมวลผลเฉพาะข้อความที่เข้ามาหลัง since (กันประมวลผลข้อความเก่าตอนเปิดครั้งแรก)
  // ⚡ Phase 2Q — ไม่ limit แล้ว — ดึงทั้งหมดที่เข้ามาใหม่ (buffer เป็นตัวคุมปริมาณจริง)
  // ดึง raw_payload มาด้วย — สำหรับ rich-media messages (item card, order card, ...)
  // ที่ text เป็น placeholder "[item]" ต้องใช้ raw_payload แปลงเป็น tag [สินค้า: <item_id>]
  const query: Record<string, unknown> = { role: "user", direction: "in" };
  if (since) {
    query.created_timestamp = { $gt: since };
  }
  const docs = await coll
    .find(query)
    .sort({ created_timestamp: -1 })
    .toArray();

  // ตัดที่ประมวลผลแล้วก่อน (อ่าน id ทั้งหมดครั้งเดียว — ลด round-trip)
  const ids = docs.map((d) => d.message_id);
  const procColl = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const already = new Set(
    (await procColl.find({ message_id: { $in: ids } }, { projection: { message_id: 1 } }).toArray())
      .map((d) => d.message_id)
  );

  // อ่าน buffer config จาก system config
  const sysConfig = await getSystemConfig();
  const bufferConfig: BufferConfig = {
    bufferEnabled: sysConfig.bot_buffer_enabled,
    bufferWindowMs: sysConfig.bot_buffer_window_ms,
    bufferMaxMessages: sysConfig.bot_buffer_max_messages,
    bufferWindowMediaMs: sysConfig.bot_buffer_window_media_ms,
    bufferMaxMediaMessages: sysConfig.bot_buffer_max_media_messages,
  };

  const results: { message_id: string; status: string; detail: string }[] = [];
  let kicked = 0;

  for (const doc of docs) {
    if (already.has(doc.message_id)) {
      results.push({ message_id: doc.message_id, status: "skip", detail: "already processed" });
      continue;
    }

    // ⚡ FIRE-AND-FORGET — ยิงไปเลย ไม่ await
    // ถ้าเปิด buffer → bufferOrProcess จะ insert ลง buffer_messages + ตั้ง timer
    // ถ้าปิด buffer → bufferOrProcess เรียก processMessage ทันที (เหมือนเดิม)
    const p = (async () => {
      try {
        const result = await bufferService.bufferOrProcess(
          {
            message_id: doc.message_id,
            conversation_id: doc.conversation_id,
            shop_id: doc.shop_id,
            platform: doc.platform,
            text: doc.text,
            raw_payload: doc.raw_payload,
          },
          bufferConfig,
          processMessage,
          markProcessed
        );
        console.log(`  [worker] ${doc.message_id.slice(0, 20)}... → ${result.status}: ${result.detail}`);
      } catch (err) {
        console.error(`  [worker] ${doc.message_id.slice(0, 20)}... → error:`, err instanceof Error ? err.message : err);
      }
    })();

    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    kicked++;
    results.push({ message_id: doc.message_id, status: "fired", detail: "kicked off (fire-and-forget)" });
  }

  return { found: docs.length, processed: kicked, results };
}

// รอให้ทุก promise ที่กำลังทำงานอยู่เสร็จ (ใช้ตอน graceful shutdown)
export async function waitForInFlight(timeoutMs = 10000): Promise<void> {
  if (inFlight.size === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }
}

export const botWorkerService = {
  processMessage,
  pollNewMessages,
  callBot,
  isProcessed,
  waitForInFlight,
  recoverStaleBuffers: () => bufferService.recoverStaleBuffers(processMessage, markProcessed),
  clearAllBufferTimers: bufferService.clearAllBufferTimers,
};
