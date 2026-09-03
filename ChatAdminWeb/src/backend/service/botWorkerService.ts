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
import { listMessages, getHistoryForBot, toBotText } from "./messageService";
import { getConversation, reopenConversation } from "./conversationService";
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
    trigger_id: opts.triggerId,
    created_at: now,
    updated_at: now,
  });

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
  });
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
}): Promise<{ status: string; detail: string }> {
  // 1. ตรวจซ้ำ — ถ้าประมวลผลแล้ว ข้าม
  if (await isProcessed(msg.message_id)) {
    return { status: "skip", detail: "already processed" };
  }

  // ⛔ Safety guard — กันเรียก platform API โดยไม่ตั้งใจ
  assertPlatformApiDisabled(msg.platform, "send");
  assertPlatformApiDisabled(msg.platform, "read");

  // ดึง shop_name จาก conversation — Python bot ต้องการชื่อร้าน (ไม่ใช่ shop_id ตัวเลข)
  // เพื่อกรองสินค้าเฉพาะร้านที่ลูกค้าทักเข้ามา
  const conv = await getConversation(msg.conversation_id);
  const shopName = conv?.shop_name || undefined;

  // ── Guard: จ่ายงานเฉพาะแอดมิน + ตรวจสถานะ conversation ──
  // 1. ถ้ามี assigned_to และ status เปิดอยู่ (ไม่ใช่ closed/resolved) → ข้าม (ปล่อยให้แอดมินตอบ)
  // 2. ถ้า status === closed/resolved → reopen + เคลียร์ assigned_to + ประมวลผลปกติ
  // 3. ถ้าไม่มี assigned_to → ประมวลผลปกติ
  if (conv) {
    const isClosed = conv.status === "closed" || conv.status === "resolved";
    if (conv.assigned_to && !isClosed) {
      // ⚡ Workflow guard — admin รับแชทแล้ว → flow ที่รอ reply ต้อง cancel อัตโนมัติ (planner ข้อ 3)
      await workflowEngine.cancelActiveRuns(
        msg.conversation_id,
        `admin ${conv.assigned_to} กำลังดูแชท — cancel flow ที่รอ reply`
      );
      // แอดมินกำลังดูแชทอยู่ → ข้าม (ปล่อยให้แอดมินตอบ)
      await markProcessed({
        message_id: msg.message_id,
        conversation_id: msg.conversation_id,
        shop_id: msg.shop_id,
        platform: msg.platform,
        status: "no_action",
      });
      return { status: "skip_assigned", detail: `conversation has assigned_to=${conv.assigned_to} (open) — skip` };
    }
    if (isClosed) {
      // conversation ปิดแล้ว → reopen + เคลียร์ assigned_to เพื่อให้ pipeline ทำงาน
      await reopenConversation({
        conversationId: msg.conversation_id,
        reopenedBy: "bot-worker",
        reopenReason: "ลูกค้าทักกลับมา — reopen เพื่อประมวลผล",
      });
      // เคลียร์ assigned_to เก่า
      const convColl = await getCollection<{ assigned_to: string | null }>(COLLECTIONS.conversations);
      await convColl.updateOne(
        { conversation_id: msg.conversation_id },
        { $set: { assigned_to: null } }
      );
    }
  }

  // ⚠️ Enrich text สำหรับ rich-media messages (item card, order card, ...)
  // ถ้าลูกค้าแชร์การ์ดสินค้า `text` จะเป็น placeholder "[item]" แต่ raw_payload มี item_id
  // แปลงเป็น tag "[สินค้า: <item_id>]" ที่ Python bot เข้าใจ ก่อนส่งให้ trigger/bot
  const botText = toBotText(msg);

  // ⚡ Workflow engine (แบบ Zaapi Flow Builder) — อ้างอิง workflow-planner.md
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
      const history = await getHistoryForBot({
        conversationId: msg.conversation_id,
        platform: msg.platform,
        maxMessages: 10,
      });
      const botResp = await callBot({
        platform: msg.platform,
        message: botText,
        shopId: msg.shop_id,
        shopName,
        history,
      });
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
    const history = await getHistoryForBot({
      conversationId: msg.conversation_id,
      platform: msg.platform,
      maxMessages: 10,
    });
    const botResp = await callBot({
      platform: msg.platform,
      message: botText,
      shopId: msg.shop_id,
      shopName,
      history,
    });

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

// track in-flight promises (เก็บไว้สำหรับ graceful shutdown เท่านั้น — ไม่ await ในลูป)
const inFlight = new Set<Promise<void>>();

export async function pollNewMessages(limit = 20): Promise<{
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
  // ดึง raw_payload มาด้วย — สำหรับ rich-media messages (item card, order card, ...)
  // ที่ text เป็น placeholder "[item]" ต้องใช้ raw_payload แปลงเป็น tag [สินค้า: <item_id>]
  const docs = await coll
    .find({ role: "user", direction: "in" })
    .sort({ created_timestamp: -1 })
    .limit(limit)
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
