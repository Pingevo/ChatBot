// liveAssignmentService — จ่ายงานจริงให้แอดมิน + จำลอง flow เต็มรูปแบบ
//
// ใช้ร่วมกับ test_assignment collection (เหมือน test-assignment)
// แต่เพิ่ม:
//   - admin_reply: บันทึกคำตอบแอดมิน
//   - close_chat: ปิดแชท + เช็คคำถามเหลือ + reopen + เข้า flow ใหม่
//   - batch_replay: รัน 500 conversation ผ่าน flow
//
// การจ่ายงานใช้ handoffToAdminTest (admin เดิมก่อน → round-robin)
// ไม่ส่งข้อความจริงไป platform (simulation only)
import { ObjectId } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "../lib/safety";
import { testStatusConversationService } from "./testStatusConversationService";
import { handoffService } from "./handoffService";
import { triggerService } from "./triggerService";
import { logAdminEvent } from "./adminLogService";
import { serverConfig } from "../lib/config";
import { parseRawMessage, toProductCard } from "./messageMediaParser";
import { productService } from "./productService";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LiveQaItem {
  index: number;
  message_id: string;
  user_text: string;
  // rich media ของ user message
  user_message_type?: string;
  user_media?: { type: string; url?: string; thumb_url?: string; duration?: number };
  user_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  user_order_sn?: string;
  user_notification_text?: string;
  user_table?: { headers?: string[]; rows?: string[][] };
  user_bundle?: {
    message_type: string;
    text: string;
    media?: { type: string; url?: string; thumb_url?: string };
    product_ref?: { item_id: string };
    products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  }[];
  // trigger
  trigger_name?: string;
  trigger_action?: string;
  // bot reply
  bot_reply?: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed?: number;
  bot_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  bot_intent?: unknown;
  bot_retrieval_info?: unknown;
  bot_web_search_used?: boolean;
  bot_web_search_reason?: string;
  // admin reply (เพิ่มใหม่)
  admin_reply?: string;
  admin_reply_at?: Date;
  admin_reply_by?: string;
  // status
  status: "bot_answered" | "trigger_matched" | "handed_off" | "no_agent" | "error" | "admin_replied" | "closed";
  assigned_to?: string | null;
  detail: string;
  // reopen tracking
  reopened?: boolean;
  reopen_reason?: string;
}

export interface LiveAssignmentDoc {
  _id?: ObjectId;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  shop_name?: string;
  to_name?: string;
  qa: LiveQaItem[];
  total_messages: number;
  processed_messages: number;
  final_status: string;
  assigned_to?: string | null;
  stopped_at_handoff: boolean;
  mock_status: "open" | "closed";
  // close tracking
  closed_at?: Date;
  closed_by?: string;
  close_count?: number;
  close_reason?: string;
  close_category?: string;
  close_resolution?: string;
  close_note?: string;
  // batch tracking
  batch_id?: string;
  // audit
  replayed_by?: string;
  replayed_at?: Date;
  created_at: Date;
  updated_at: Date;
}

// ─── Bot call helper ──────────────────────────────────────────────────────────

async function callBot(params: {
  platform: Platform;
  message: string;
  history: { role: "user" | "model"; text: string }[];
  shopId: string;
  shopName?: string;
  itemId?: string;
}): Promise<{
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  products?: unknown[];
  intent?: unknown;
  retrieval_info?: unknown;
  web_search_used?: boolean;
  web_search_reason?: string;
  handoff_to_admin?: boolean;
  handoff_reason?: string;
}> {
  const { platform, message, history, shopId, shopName, itemId } = params;
  const upstream = serverConfig.chatbotBaseUrls[platform].replace(/\/$/, "");
  const url = `${upstream}/chat`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Secret": serverConfig.chatbotInternalSecret,
  };
  const body: Record<string, unknown> = { message, history, limit: 5 };
  if (shopName) body.shop = shopName;
  else if (shopId) body.shop = shopId;
  if (itemId) body.item_id = itemId;

  const MAX_429_RETRIES = 3;
  const RATE_LIMIT_WAIT_MS = 60_000;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      if (resp.status === 429) {
        if (attempt < MAX_429_RETRIES) {
          await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
          continue;
        }
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`bot ${resp.status}: ${txt.slice(0, 200)}`);
      }
      return await resp.json();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr.message.includes("429") && attempt < MAX_429_RETRIES) continue;
      if (attempt < MAX_429_RETRIES && !lastErr.message.includes("429")) {
        // retry once on network error
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
    }
  }
  throw lastErr || new Error("bot call failed");
}

// ─── Save / Get ───────────────────────────────────────────────────────────────

export async function saveLiveAssignment(opts: {
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  shop_name?: string;
  to_name?: string;
  qa: LiveQaItem[];
  total_messages: number;
  processed_messages: number;
  final_status: string;
  assigned_to?: string | null;
  stopped_at_handoff: boolean;
  mock_status?: "open" | "closed";
  replayed_by?: string;
  batch_id?: string;
}): Promise<LiveAssignmentDoc | null> {
  const coll = await getCollection<LiveAssignmentDoc>(COLLECTIONS.testAssignment);
  const now = new Date();

  const mockStatus: "open" | "closed" =
    opts.mock_status !== undefined
      ? opts.mock_status
      : opts.final_status === "bot_answered" && !opts.stopped_at_handoff ? "closed" : "open";

  const filter: Record<string, unknown> = { conversation_id: opts.conversation_id };
  if (opts.replayed_by) filter.replayed_by = opts.replayed_by;

  const result = await coll.findOneAndUpdate(
    filter,
    {
      $set: {
        shop_id: opts.shop_id,
        platform: opts.platform,
        shop_name: opts.shop_name,
        to_name: opts.to_name,
        qa: opts.qa,
        total_messages: opts.total_messages,
        processed_messages: opts.processed_messages,
        final_status: opts.final_status,
        assigned_to: opts.assigned_to ?? null,
        stopped_at_handoff: opts.stopped_at_handoff,
        mock_status: mockStatus,
        replayed_by: opts.replayed_by ?? undefined,
        replayed_at: now,
        batch_id: opts.batch_id ?? undefined,
        updated_at: now,
      },
      $setOnInsert: {
        conversation_id: opts.conversation_id,
        created_at: now,
      },
    },
    { returnDocument: "after", upsert: true }
  );
  return result || null;
}

export async function getLiveAssignment(
  conversationId: string,
  replayedBy?: string
): Promise<LiveAssignmentDoc | null> {
  const coll = await getCollection<LiveAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = {
    conversation_id: conversationId,
    deleted_at: { $exists: false },
  };
  if (replayedBy) filter.replayed_by = replayedBy;
  return coll.findOne(filter);
}

export async function listLiveAssignments(opts?: {
  platform?: Platform;
  finalStatus?: string;
  mockStatus?: "open" | "closed";
  assignedTo?: string;
  replayedBy?: string;
  batchId?: string;
  limit?: number;
}): Promise<LiveAssignmentDoc[]> {
  const coll = await getCollection<LiveAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = { deleted_at: { $exists: false } };
  if (opts?.platform) filter.platform = opts.platform;
  if (opts?.finalStatus) filter.final_status = opts.finalStatus;
  if (opts?.mockStatus) filter.mock_status = opts.mockStatus;
  if (opts?.assignedTo) filter.assigned_to = opts.assignedTo;
  if (opts?.replayedBy) filter.replayed_by = opts.replayedBy;
  if (opts?.batchId) filter.batch_id = opts.batchId;
  const limit = opts?.limit || 500;
  return coll.find(filter).sort({ updated_at: -1 }).limit(limit).toArray();
}

// ─── Admin reply ──────────────────────────────────────────────────────────────

export async function adminReply(opts: {
  conversationId: string;
  text: string;
  adminId: string;
  replayedBy?: string;
}): Promise<{ ok: boolean; doc?: LiveAssignmentDoc | null; error?: string }> {
  const { conversationId, text, adminId, replayedBy } = opts;
  if (!text.trim()) return { ok: false, error: "text required" };

  const doc = await getLiveAssignment(conversationId, replayedBy);
  if (!doc) return { ok: false, error: "conversation not found" };

  // หา qa entry ล่าสุดที่ status = handed_off หรือ no_agent
  const qa = [...(doc.qa || [])];
  const lastHandoffIdx = [...qa].reverse().findIndex(
    (q) => q.status === "handed_off" || q.status === "no_agent"
  );
  if (lastHandoffIdx < 0) {
    return { ok: false, error: "no handoff entry to reply to" };
  }
  const actualIdx = qa.length - 1 - lastHandoffIdx;
  qa[actualIdx] = {
    ...qa[actualIdx],
    admin_reply: text,
    admin_reply_at: new Date(),
    admin_reply_by: adminId,
    status: "admin_replied",
  };

  const coll = await getCollection<LiveAssignmentDoc>(COLLECTIONS.testAssignment);
  const now = new Date();
  const filter: Record<string, unknown> = { conversation_id: conversationId };
  if (replayedBy) filter.replayed_by = replayedBy;

  const result = await coll.findOneAndUpdate(
    filter,
    {
      $set: {
        qa,
        final_status: "admin_replied",
        assigned_to: adminId,
        updated_at: now,
      },
    },
    { returnDocument: "after" }
  );

  // audit log
  await logAdminEvent({
    action_type: "live_assignment.admin_reply",
    actor: adminId,
    conversation_id: conversationId,
    metadata: { text: text.slice(0, 200) },
  });

  return { ok: true, doc: result };
}

// ─── Close chat + reopen + flow ───────────────────────────────────────────────

export async function closeChat(opts: {
  conversationId: string;
  adminId: string;
  reason?: string;
  category?: string;
  resolution?: string;
  note?: string;
  replayedBy?: string;
}): Promise<{
  ok: boolean;
  closed: boolean;
  reopened: boolean;
  newQa?: LiveQaItem[];
  finalStatus?: string;
  assignedTo?: string | null;
  error?: string;
}> {
  const { conversationId, adminId, replayedBy } = opts;

  const doc = await getLiveAssignment(conversationId, replayedBy);
  if (!doc) return { ok: false, closed: false, reopened: false, error: "conversation not found" };

  // 1. ปิดแชท
  const coll = await getCollection<LiveAssignmentDoc>(COLLECTIONS.testAssignment);
  const now = new Date();
  const filter: Record<string, unknown> = { conversation_id: conversationId };
  if (replayedBy) filter.replayed_by = replayedBy;

  const closeCount = (doc.close_count || 0) + 1;
  await coll.updateOne(
    filter,
    {
      $set: {
        mock_status: "closed",
        closed_at: now,
        closed_by: adminId,
        close_count: closeCount,
        close_reason: opts.reason,
        close_category: opts.category,
        close_resolution: opts.resolution,
        close_note: opts.note,
        updated_at: now,
      },
    }
  );

  // อัปเดต test_status_conversation
  await testStatusConversationService.closeTestConversation(
    conversationId,
    "test_assignment",
    adminId
  );

  // audit
  await logAdminEvent({
    action_type: "live_assignment.close_chat",
    actor: adminId,
    conversation_id: conversationId,
    metadata: {
      reason: opts.reason,
      category: opts.category,
      close_count: closeCount,
    },
  });

  // 2. เช็คมีคำถามเหลือไหม
  const msgColl = await getCollection<{
    message_id: string;
    conversation_id: string;
    role: string;
    direction?: string;
    text?: string;
    raw_payload?: unknown;
    created_timestamp: Date;
    sender?: string;
  }>(COLLECTIONS.messages);

  const allUserMsgs = await msgColl
    .find({ conversation_id: conversationId, role: "user", direction: "in" })
    .sort({ created_timestamp: 1 })
    .limit(100)
    .toArray();

  const processedCount = doc.processed_messages || 0;
  const remainingMsgs = allUserMsgs.slice(processedCount);

  if (remainingMsgs.length === 0) {
    // ไม่มีคำถามเหลือ → ปิดจบ
    return { ok: true, closed: true, reopened: false, finalStatus: "closed" };
  }

  // 3. Reopen + ประมวลผลข้อความที่เหลือผ่าน flow
  await testStatusConversationService.reopenTestConversation(
    conversationId,
    "test_assignment",
    undefined // reset assigned_to → ให้ flow จ่ายใหม่
  );

  await coll.updateOne(filter, {
    $set: { mock_status: "open", updated_at: new Date() },
  });

  // 4. ประมวลผลข้อความที่เหลือ
  const qa = [...(doc.qa || [])];
  // สร้าง history จาก qa เดิม + admin reply
  const history: { role: "user" | "model"; text: string }[] = [];
  for (const q of qa) {
    history.push({ role: "user", text: q.user_text });
    if (q.bot_reply) history.push({ role: "model", text: q.bot_reply });
    else if (q.admin_reply) history.push({ role: "model", text: q.admin_reply });
  }

  let finalStatus = "closed";
  let assignedTo: string | null = null;
  let stopped = false;

  // ดึงข้อมูล user parsed (เหมือน replay_conversation)
  const userParsedMap = new Map<string, {
    user_message_type?: string;
    user_media?: { type: string; url?: string; thumb_url?: string };
    user_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
    user_order_sn?: string;
    user_notification_text?: string;
    user_table?: { headers?: string[]; rows?: string[][] };
    user_bundle?: LiveQaItem["user_bundle"];
  }>();

  // parse user messages (เหมือน test-assignment route)
  const convColl = await getCollection<{
    conversation_id: string; shop_id: string; platform: string; shop_name?: string;
    to_name?: string;
  }>(COLLECTIONS.conversations);
  const conv = await convColl.findOne({ conversation_id: conversationId });
  const platform = (doc.platform || conv?.platform || "shopee") as Platform;
  const shopId = doc.shop_id || conv?.shop_id || "";
  const shopName = doc.shop_name || conv?.shop_name;
  const toName = doc.to_name || conv?.to_name;

  // parse remaining messages
  for (const msg of remainingMsgs) {
    const raw = msg.raw_payload;
    if (raw && typeof raw === "object") {
      try {
        const p = parseRawMessage(raw, msg.text || "");
        // ดึง products ของ user message
        const products: { item_id: string; name: string; price?: number; image?: string; url?: string }[] = [];
        if (p?.product_ref?.item_id) {
          const prod = await productService.getProduct({ platform, itemId: p.product_ref.item_id });
          if (prod && conv) {
            const card = toProductCard(prod as Record<string, unknown>, platform);
            products.push(card);
          }
        }
        let userBundle: LiveQaItem["user_bundle"];
        if (p?.bundle && p.bundle.length > 0) {
          const bundleItems = await Promise.all(p.bundle.map(async (sub) => {
            const subProducts: unknown[] = [];
            if (sub.product_ref?.item_id) {
              const prod = await productService.getProduct({ platform, itemId: sub.product_ref.item_id });
              if (prod && conv) {
                subProducts.push(toProductCard(prod as Record<string, unknown>, platform));
              }
            }
            return {
              message_type: String(sub.message_type || "text"),
              text: sub.text || "",
              media: sub.media as { type: string; url?: string; thumb_url?: string } | undefined,
              product_ref: sub.product_ref,
              products: subProducts.length > 0 ? (subProducts as LiveQaItem["user_products"]) : undefined,
            };
          }));
          userBundle = bundleItems;
        }
        userParsedMap.set(msg.message_id, {
          user_message_type: p?.message_type,
          user_media: p?.media as { type: string; url?: string; thumb_url?: string } | undefined,
          user_products: products.length > 0 ? products : undefined,
          user_order_sn: p?.order_sn,
          user_notification_text: p?.notification_text,
          user_table: p?.table as { headers?: string[]; rows?: string[][] } | undefined,
          user_bundle: userBundle,
        });
      } catch {
        // ignore parse error
      }
    }
  }

  for (let i = 0; i < remainingMsgs.length && !stopped; i++) {
    const msg = remainingMsgs[i];
    const userText = msg.text || "(empty)";
    const qaIndex = processedCount + i;

    try {
      // 1. check trigger
      const trigger = await triggerService.matchTrigger(userText, {
        shopId,
        platform,
      });

      if (trigger && trigger.action === "handoff_admin") {
        const handoff = await handoffService.handoffToAdminTest({
          source: "test_assignment",
          conversationId: conversationId,
          shopId,
          platform,
          reason: `trigger "${trigger.name}"`,
        });
        const agentId = handoff.assignedTo;
        qa.push({
          index: qaIndex,
          message_id: msg.message_id,
          user_text: userText,
          ...userParsedMap.get(msg.message_id),
          trigger_name: trigger.name,
          trigger_action: "handoff_admin",
          status: agentId ? "handed_off" : "no_agent",
          assigned_to: agentId,
          detail: `trigger "${trigger.name}" → ${handoff.assignmentReason} → ${agentId || "no agent available"}`,
          reopened: true,
          reopen_reason: "post-close reopen",
        });
        assignedTo = agentId;
        finalStatus = agentId ? "handed_off" : "no_agent";
        stopped = true;
        break;
      }

      // 2. call bot
      const userParsedInfo = userParsedMap.get(msg.message_id);
      const userItemId = userParsedInfo?.user_products && Array.isArray(userParsedInfo.user_products) && userParsedInfo.user_products.length > 0
        ? String((userParsedInfo.user_products[0] as Record<string, unknown>).item_id || "")
        : undefined;
      const botResp = await callBot({
        platform,
        message: userText,
        shopId,
        shopName,
        history,
        itemId: userItemId,
      });

      if (!botResp.answer || botResp.answer.trim() === "") {
        // bot ตอบไม่ได้ → handoff
        const handoff = await handoffService.handoffToAdminTest({
          source: "test_assignment",
          conversationId: conversationId,
          shopId,
          platform,
          reason: "bot ตอบไม่ได้",
        });
        const agentId = handoff.assignedTo;
        qa.push({
          index: qaIndex,
          message_id: msg.message_id,
          user_text: userText,
          ...userParsedMap.get(msg.message_id),
          trigger_name: trigger?.name,
          trigger_action: trigger?.action,
          status: agentId ? "handed_off" : "no_agent",
          assigned_to: agentId,
          detail: `bot ตอบไม่ได้ → ${handoff.assignmentReason} → ${agentId || "no agent"}`,
          reopened: true,
          reopen_reason: "post-close reopen",
        });
        assignedTo = agentId;
        finalStatus = agentId ? "handed_off" : "no_agent";
        stopped = true;
        break;
      }

      // bot ตอบได้ → สะสม history
      history.push({ role: "user", text: userText });
      history.push({ role: "model", text: botResp.answer });

      if (botResp.handoff_to_admin) {
        const handoff = await handoffService.handoffToAdminTest({
          source: "test_assignment",
          conversationId: conversationId,
          shopId,
          platform,
          reason: botResp.handoff_reason || "bot handoff",
        });
        const agentId = handoff.assignedTo;
        qa.push({
          index: qaIndex,
          message_id: msg.message_id,
          user_text: userText,
          ...userParsedMap.get(msg.message_id),
          trigger_name: trigger?.name,
          trigger_action: trigger?.action,
          bot_reply: botResp.answer,
          bot_source: botResp.source,
          bot_model: botResp.model,
          bot_elapsed: botResp.elapsed,
          bot_products: (botResp.products as { item_id: string; name: string; price?: number; image?: string; url?: string }[]) || [],
          bot_intent: botResp.intent,
          bot_retrieval_info: botResp.retrieval_info,
          bot_web_search_used: botResp.web_search_used,
          bot_web_search_reason: botResp.web_search_reason,
          status: agentId ? "handed_off" : "no_agent",
          assigned_to: agentId,
          detail: `bot handoff (${botResp.handoff_reason || "unknown"}) → ${handoff.assignmentReason} → ${agentId || "no agent"}`,
          reopened: true,
          reopen_reason: "post-close reopen",
        });
        assignedTo = agentId;
        finalStatus = agentId ? "handed_off" : "no_agent";
        stopped = true;
        break;
      }

      qa.push({
        index: qaIndex,
        message_id: msg.message_id,
        user_text: userText,
        ...userParsedMap.get(msg.message_id),
        trigger_name: trigger?.name,
        trigger_action: trigger?.action,
        bot_reply: botResp.answer,
        bot_source: botResp.source,
        bot_model: botResp.model,
        bot_elapsed: botResp.elapsed,
        bot_products: (botResp.products as { item_id: string; name: string; price?: number; image?: string; url?: string }[]) || [],
        bot_intent: botResp.intent,
        bot_retrieval_info: botResp.retrieval_info,
        bot_web_search_used: botResp.web_search_used,
        bot_web_search_reason: botResp.web_search_reason,
        status: trigger ? "trigger_matched" : "bot_answered",
        detail: trigger ? `trigger "${trigger.name}" → bot ตอบ` : "bot ตอบปกติ",
        reopened: true,
        reopen_reason: "post-close reopen",
      });
    } catch (err) {
      qa.push({
        index: qaIndex,
        message_id: msg.message_id,
        user_text: userText,
        ...userParsedMap.get(msg.message_id),
        status: "error",
        detail: `error: ${err instanceof Error ? err.message : String(err)}`,
        reopened: true,
        reopen_reason: "post-close reopen",
      });
      finalStatus = "error";
      stopped = true;
    }
  }

  // 5. บันทึกผลลัพธ์
  const newProcessedCount = processedCount + remainingMsgs.length;
  const mockStatus: "open" | "closed" =
    finalStatus === "bot_answered" && !stopped ? "closed" : "open";

  await coll.updateOne(filter, {
    $set: {
      qa,
      processed_messages: newProcessedCount,
      final_status: finalStatus,
      assigned_to: assignedTo,
      stopped_at_handoff: stopped,
      mock_status: mockStatus,
      updated_at: new Date(),
    },
  });

  // audit
  await logAdminEvent({
    action_type: "live_assignment.reopen_process",
    actor: adminId,
    conversation_id: conversationId,
    metadata: {
      remaining_messages: remainingMsgs.length,
      processed: newProcessedCount,
      final_status: finalStatus,
    },
  });

  return {
    ok: true,
    closed: true,
    reopened: remainingMsgs.length > 0,
    newQa: qa.slice(processedCount),
    finalStatus,
    assignedTo,
  };
}

// ─── Batch replay ─────────────────────────────────────────────────────────────

export async function batchReplay(opts: {
  conversationIds: string[];
  replayedBy: string;
  mode?: "overwrite" | "resume";
}): Promise<{
  results: { conversation_id: string; ok: boolean; final_status?: string; error?: string }[];
  total: number;
  success: number;
  errors: number;
}> {
  const { conversationIds, replayedBy, mode = "overwrite" } = opts;
  const results: { conversation_id: string; ok: boolean; final_status?: string; error?: string }[] = [];
  let success = 0;
  let errors = 0;

  for (const convId of conversationIds) {
    try {
      // ดึง conversation info
      const convColl = await getCollection<{
        conversation_id: string;
        shop_id: string;
        platform: string;
        shop_name?: string;
        to_name?: string;
      }>(COLLECTIONS.conversations);
      const conv = await convColl.findOne({ conversation_id: convId });
      if (!conv) {
        results.push({ conversation_id: convId, ok: false, error: "conversation not found" });
        errors++;
        continue;
      }

      const platform = conv.platform as Platform;
      const shopId = conv.shop_id;
      const shopName = conv.shop_name;
      const toName = conv.to_name;

      // resume mode → skip ที่ replay แล้ว
      if (mode === "resume") {
        const existing = await getLiveAssignment(convId, replayedBy);
        if (existing && existing.final_status === "bot_answered" && !existing.stopped_at_handoff) {
          results.push({ conversation_id: convId, ok: true, final_status: "skipped" });
          success++;
          continue;
        }
      }

      // reset test status
      await testStatusConversationService.updateTestStatus(
        convId,
        "test_assignment",
        "bot",
        undefined,
        undefined
      );

      // ดึง user messages
      const msgColl = await getCollection<{
        message_id: string;
        conversation_id: string;
        role: string;
        direction?: string;
        text?: string;
        raw_payload?: unknown;
        created_timestamp: Date;
      }>(COLLECTIONS.messages);

      const messages = await msgColl
        .find({ conversation_id: convId, role: "user", direction: "in" })
        .sort({ created_timestamp: 1 })
        .limit(30)
        .toArray();

      if (messages.length === 0) {
        results.push({ conversation_id: convId, ok: false, error: "no user messages" });
        errors++;
        continue;
      }

      // parse user messages
      const userParsedMap = new Map<string, {
        user_message_type?: string;
        user_media?: { type: string; url?: string; thumb_url?: string };
        user_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
        user_order_sn?: string;
        user_notification_text?: string;
        user_table?: { headers?: string[]; rows?: string[][] };
        user_bundle?: LiveQaItem["user_bundle"];
      }>();

      for (const msg of messages) {
        const raw = msg.raw_payload;
        if (raw && typeof raw === "object") {
          try {
            const p = parseRawMessage(raw, msg.text || "");
            const products: { item_id: string; name: string; price?: number; image?: string; url?: string }[] = [];
            if (p?.product_ref?.item_id) {
              const prod = await productService.getProduct({ platform, itemId: p.product_ref.item_id });
              if (prod && conv) {
                const card = toProductCard(prod as Record<string, unknown>, platform);
                products.push(card);
              }
            }
            let userBundle: LiveQaItem["user_bundle"];
            if (p?.bundle && p.bundle.length > 0) {
              const bundleItems = await Promise.all(p.bundle.map(async (sub) => {
                const subProducts: unknown[] = [];
                if (sub.product_ref?.item_id) {
                  const prod = await productService.getProduct({ platform, itemId: sub.product_ref.item_id });
                  if (prod && conv) {
                    subProducts.push(toProductCard(prod as Record<string, unknown>, platform));
                  }
                }
                return {
                  message_type: String(sub.message_type || "text"),
                  text: sub.text || "",
                  media: sub.media as { type: string; url?: string; thumb_url?: string } | undefined,
                  product_ref: sub.product_ref,
                  products: subProducts.length > 0 ? (subProducts as LiveQaItem["user_products"]) : undefined,
                };
              }));
              userBundle = bundleItems;
            }
            userParsedMap.set(msg.message_id, {
              user_message_type: p?.message_type,
              user_media: p?.media as { type: string; url?: string; thumb_url?: string } | undefined,
              user_products: products.length > 0 ? products : undefined,
              user_order_sn: p?.order_sn,
              user_notification_text: p?.notification_text,
              user_table: p?.table as { headers?: string[]; rows?: string[][] } | undefined,
              user_bundle: userBundle,
            });
          } catch {
            // ignore
          }
        }
      }

      // replay
      const qa: LiveQaItem[] = [];
      let finalStatus = "bot_answered";
      let assignedTo: string | null = null;
      let stopped = false;
      const history: { role: "user" | "model"; text: string }[] = [];

      for (let i = 0; i < messages.length && !stopped; i++) {
        const msg = messages[i];
        const userText = msg.text || "(empty)";

        try {
          const trigger = await triggerService.matchTrigger(userText, {
            shopId,
            platform,
          });

          if (trigger && trigger.action === "handoff_admin") {
            const handoff = await handoffService.handoffToAdminTest({
              source: "test_assignment",
              conversationId: convId,
              shopId,
              platform,
              reason: `trigger "${trigger.name}"`,
            });
            const agentId = handoff.assignedTo;
            qa.push({
              index: i,
              message_id: msg.message_id,
              user_text: userText,
              ...userParsedMap.get(msg.message_id),
              trigger_name: trigger.name,
              trigger_action: "handoff_admin",
              status: agentId ? "handed_off" : "no_agent",
              assigned_to: agentId,
              detail: `trigger "${trigger.name}" → ${handoff.assignmentReason} → ${agentId || "no agent available"}`,
            });
            assignedTo = agentId;
            finalStatus = agentId ? "handed_off" : "no_agent";
            stopped = true;
            break;
          }

          const userParsedInfo = userParsedMap.get(msg.message_id);
          const userItemId = userParsedInfo?.user_products && Array.isArray(userParsedInfo.user_products) && userParsedInfo.user_products.length > 0
            ? String((userParsedInfo.user_products[0] as Record<string, unknown>).item_id || "")
            : undefined;
          const botResp = await callBot({
            platform,
            message: userText,
            shopId,
            shopName,
            history,
            itemId: userItemId,
          });

          if (!botResp.answer || botResp.answer.trim() === "") {
            const handoff = await handoffService.handoffToAdminTest({
              source: "test_assignment",
              conversationId: convId,
              shopId,
              platform,
              reason: "bot ตอบไม่ได้",
            });
            const agentId = handoff.assignedTo;
            qa.push({
              index: i,
              message_id: msg.message_id,
              user_text: userText,
              ...userParsedMap.get(msg.message_id),
              trigger_name: trigger?.name,
              trigger_action: trigger?.action,
              status: agentId ? "handed_off" : "no_agent",
              assigned_to: agentId,
              detail: `bot ตอบไม่ได้ → ${handoff.assignmentReason} → ${agentId || "no agent"}`,
            });
            assignedTo = agentId;
            finalStatus = agentId ? "handed_off" : "no_agent";
            stopped = true;
            break;
          }

          history.push({ role: "user", text: userText });
          history.push({ role: "model", text: botResp.answer });

          if (botResp.handoff_to_admin) {
            const handoff = await handoffService.handoffToAdminTest({
              source: "test_assignment",
              conversationId: convId,
              shopId,
              platform,
              reason: botResp.handoff_reason || "bot handoff",
            });
            const agentId = handoff.assignedTo;
            qa.push({
              index: i,
              message_id: msg.message_id,
              user_text: userText,
              ...userParsedMap.get(msg.message_id),
              trigger_name: trigger?.name,
              trigger_action: trigger?.action,
              bot_reply: botResp.answer,
              bot_source: botResp.source,
              bot_model: botResp.model,
              bot_elapsed: botResp.elapsed,
              bot_products: (botResp.products as { item_id: string; name: string; price?: number; image?: string; url?: string }[]) || [],
              bot_intent: botResp.intent,
              bot_retrieval_info: botResp.retrieval_info,
              bot_web_search_used: botResp.web_search_used,
              bot_web_search_reason: botResp.web_search_reason,
              status: agentId ? "handed_off" : "no_agent",
              assigned_to: agentId,
              detail: `bot handoff (${botResp.handoff_reason || "unknown"}) → ${handoff.assignmentReason} → ${agentId || "no agent"}`,
            });
            assignedTo = agentId;
            finalStatus = agentId ? "handed_off" : "no_agent";
            stopped = true;
            break;
          }

          qa.push({
            index: i,
            message_id: msg.message_id,
            user_text: userText,
            ...userParsedMap.get(msg.message_id),
            trigger_name: trigger?.name,
            trigger_action: trigger?.action,
            bot_reply: botResp.answer,
            bot_source: botResp.source,
            bot_model: botResp.model,
            bot_elapsed: botResp.elapsed,
            bot_products: (botResp.products as { item_id: string; name: string; price?: number; image?: string; url?: string }[]) || [],
            bot_intent: botResp.intent,
            bot_retrieval_info: botResp.retrieval_info,
            bot_web_search_used: botResp.web_search_used,
            bot_web_search_reason: botResp.web_search_reason,
            status: trigger ? "trigger_matched" : "bot_answered",
            detail: trigger ? `trigger "${trigger.name}" → bot ตอบ` : "bot ตอบปกติ",
          });
        } catch (err) {
          qa.push({
            index: i,
            message_id: msg.message_id,
            user_text: userText,
            ...userParsedMap.get(msg.message_id),
            status: "error",
            detail: `error: ${err instanceof Error ? err.message : String(err)}`,
          });
          finalStatus = "error";
          stopped = true;
        }
      }

      // บันทึก
      await saveLiveAssignment({
        conversation_id: convId,
        shop_id: shopId,
        platform,
        shop_name: shopName,
        to_name: toName,
        qa,
        total_messages: messages.length,
        processed_messages: qa.length,
        final_status: finalStatus,
        assigned_to: assignedTo,
        stopped_at_handoff: stopped,
        replayed_by: replayedBy,
      });

      results.push({ conversation_id: convId, ok: true, final_status: finalStatus });
      success++;
    } catch (err) {
      results.push({
        conversation_id: convId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
    }
  }

  return { results, total: conversationIds.length, success, errors };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getLiveAssignmentStats(opts?: {
  replayedBy?: string;
}): Promise<{
  total: number;
  bot_answered: number;
  handed_off: number;
  admin_replied: number;
  closed: number;
  open: number;
  error: number;
}> {
  const coll = await getCollection<LiveAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = { deleted_at: { $exists: false } };
  if (opts?.replayedBy) filter.replayed_by = opts.replayedBy;
  const docs = await coll.find(filter).sort({ updated_at: -1 }).limit(5000).toArray();

  let botAnswered = 0, handedOff = 0, adminReplied = 0, closed = 0, open = 0, errorCount = 0;
  for (const d of docs) {
    if (d.final_status === "bot_answered") botAnswered++;
    else if (d.final_status === "handed_off") handedOff++;
    else if (d.final_status === "admin_replied") adminReplied++;
    else if (d.final_status === "error") errorCount++;
    if (d.mock_status === "closed") closed++;
    else open++;
  }

  return {
    total: docs.length,
    bot_answered: botAnswered,
    handed_off: handedOff,
    admin_replied: adminReplied,
    closed,
    open,
    error: errorCount,
  };
}

export const liveAssignmentService = {
  saveLiveAssignment,
  getLiveAssignment,
  listLiveAssignments,
  adminReply,
  closeChat,
  batchReplay,
  getLiveAssignmentStats,
};
