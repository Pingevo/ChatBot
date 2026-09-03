// Test Assignment API — ทดสอบการจ่ายงานกับ conversation จริงจาก DB
//
// GET  /api/test-assignment?list=1&limit=500&platform=shopee
//   → list recent conversations (เหมือน shadow-inbox)
//
// GET  /api/test-assignment?conv_detail=1&conversation_id=xxx
//   → ดึงแชทเต็ม (user + zaapi + bot) + replay result + ratings
//
// GET  /api/test-assignment?stats=1
//   → สถิติรวม
//
// GET  /api/test-assignment (default)
//   → สถานะระบบ: config + agents + assignment mode
//
// POST /api/test-assignment
//   body: { action: "replay_conversation", conversation_id }
//   → replay ทุก user message ผ่าน pipeline → บันทึกลง test_assignment collection
//
// POST /api/test-assignment
//   body: { action: "rate_message", conversation_id, message_id, star_rating?, rating?, comment? }
//   → ให้คะแนนรายคำตอบ
//
// POST /api/test-assignment
//   body: { action: "rate_conversation", conversation_id, star_rating?, rating?, comment? }
//   → ให้คะแนนทั้งแชท (ใหม่)
//
// POST /api/test-assignment
//   body: { action: "toggle_worker", enabled: boolean }
export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { getSystemConfig, updateSystemConfig } from "@/backend/service/systemConfigService";
import { assignmentService } from "@/backend/service/assignmentService";
import { handoffService } from "@/backend/service/handoffService";
import { triggerService } from "@/backend/service/triggerService";
import { testAssignmentService } from "@/backend/service/testAssignmentService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { parseRawMessage, toProductCard } from "@/backend/service/messageMediaParser";
import { productService } from "@/backend/service/productService";
import { serverConfig } from "@/backend/lib/config";
import type { Platform } from "@/backend/lib/safety";

// ─── Helpers ──────────────────────────────────────────────

async function callBot(params: {
  platform: Platform;
  message: string;
  history: { role: "user" | "model"; text: string }[];
  shopId: string;
  shopName?: string;
  itemId?: string;  // ⚡ item_id จากการ์ดสินค้าที่ลูกค้าแชร์
}): Promise<{
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
  intent?: unknown;
  retrieval_info?: unknown;
  web_search_used?: boolean;
  web_search_reason?: string;
  // ⚡ handoff fields จาก bot (tax_invoice, warranty claim, etc.)
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
  // ⚡ ส่ง item_id ถ้าลูกค้าแชร์การ์ดสินค้ามาในแชท
  if (itemId) body.item_id = itemId;

  // ⚡ 429 retry: รอ 60 วิ แล้วยิงใหม่ — สูงสุด 3 ครั้ง ถ้าเกินให้ throw
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
          // รอ 60 วิ แล้วยิงใหม่
          await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
          continue;
        }
        throw new Error(`bot 429 rate limit — ลอง ${MAX_429_RETRIES} ครั้งแล้ว ยกเลิก`);
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`bot call failed (${resp.status}): ${txt.slice(0, 200)}`);
      }
      const data = await resp.json();
      return {
        answer: data.answer || "",
        source: data.source,
        model: data.model,
        elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
        usage: data.usage,
        cost: typeof data.cost === "number" ? data.cost : undefined,
        products: data.products,
        intent: data.intent,
        retrieval_info: data.retrieval_info,
        web_search_used: data.web_search_used === true,
        web_search_reason: data.web_search_reason,
        // ⚡ handoff fields
        handoff_to_admin: data.handoff_to_admin === true,
        handoff_reason: data.handoff_reason,
      };
    } catch (err) {
      // ถ้า error เป็น 429-related → retry
      if (err instanceof Error && err.message.includes("429") && attempt < MAX_429_RETRIES) {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
        continue;
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      throw lastErr;
    }
  }
  throw lastErr || new Error("bot call failed — unknown");
}

// ─── GET ──────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const list = url.searchParams.get("list") === "1";
  const convDetail = url.searchParams.get("conv_detail") === "1";
  const stats = url.searchParams.get("stats") === "1";

  try {
    // ── stats ──
    if (stats) {
      const s = await testAssignmentService.stats();
      return json(s);
    }

    // ── conversation detail (full chat + replay result + ratings) ──
    if (convDetail) {
      const conversationId = url.searchParams.get("conversation_id");
      if (!conversationId) return error("conversation_id required", 422);

      // ดึง messages เต็ม (ทั้ง in + out)
      const msgColl = await getCollection<{
        message_id: string; conversation_id: string; role: string; direction: string;
        text: string; source?: string; admin_id?: string; created_timestamp: Date;
        raw_payload?: unknown;
      }>(COLLECTIONS.messages);
      const messages = await msgColl
        .find({ conversation_id: conversationId })
        .sort({ created_timestamp: 1 })
        .limit(100)
        .toArray();

      // ดึง replay result + ratings
      const replay = await testAssignmentService.getTestAssignment(conversationId);

      // ดึง conversation info
      const convColl = await getCollection<{
        conversation_id: string; shop_id: string; platform: string;
        shop_name?: string; to_name?: string; assigned_to: string | null; status: string;
      }>(COLLECTIONS.conversations);
      const conv = await convColl.findOne({ conversation_id: conversationId });

      // parse raw_payload + batch lookup products (เหมือน messages API ปกติ)
      // ⚡ เรียก parseRawMessage เสมอ แม้ไม่มี raw_payload — parser เช็ค placeholder จาก text ได้
      const parsedMsgs = messages.map((m) => ({
        doc: m,
        parsed: parseRawMessage(m.raw_payload, m.text),
      }));
      const itemIdsToLookup = new Set<string>();
      for (const { parsed: p } of parsedMsgs) {
        if (p?.product_ref?.item_id) itemIdsToLookup.add(p.product_ref.item_id);
      }
      const productMap = new Map<string, unknown>();
      if (itemIdsToLookup.size > 0 && conv) {
        try {
          const products = await productService.getProductsByIds({
            platform: conv.platform as Platform,
            itemIds: [...itemIdsToLookup],
          });
          for (const p of products) {
            const id = String((p as Record<string, unknown>).item_id || (p as Record<string, unknown>).itemid || "");
            if (id) productMap.set(id, p);
          }
        } catch { /* ignore */ }
      }

      return json({
        conversation: conv ? {
          conversation_id: conv.conversation_id,
          shop_id: conv.shop_id,
          platform: conv.platform,
          shop_name: conv.shop_name,
          to_name: conv.to_name,
          assigned_to: conv.assigned_to,
          status: conv.status,
        } : null,
        messages: parsedMsgs.map(({ doc, parsed: p }) => {
          const products: unknown[] = [];
          if (p?.product_ref?.item_id) {
            const prod = productMap.get(p.product_ref.item_id);
            if (prod && conv) {
              const card = toProductCard(prod as Record<string, unknown>, conv.platform as Platform);
              products.push(card);
            }
          }
          return {
            message_id: doc.message_id,
            id: doc.message_id,
            role: doc.role,
            direction: doc.direction,
            text: p?.text || doc.text,
            source: doc.source,
            admin_id: doc.admin_id,
            timestamp: doc.created_timestamp,
            // rich media (parsed)
            message_type: p?.message_type,
            media: p?.media,
            order_sn: p?.order_sn,
            notification_text: p?.notification_text,
            table: p?.table,
            products: products.length > 0 ? products : undefined,
          };
        }),
        replay: replay,
      });
    }

    // ── list conversations ──
    if (list) {
      const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
      // ⚡ ปลด cap 100 → รับสูงสุด 10000 (ให้ user ใส่เอง)
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10), 1), 10000);
      const order = url.searchParams.get("order") || "recent"; // recent | oldest

      const coll = await getCollection<{
        conversation_id: string; shop_id: string; platform: string;
        status: string; assigned_to: string | null; last_message_timestamp?: Date;
        to_name?: string; shop_name?: string;
      }>(COLLECTIONS.conversations);
      const filter: Record<string, unknown> = {};
      if (platform) filter.platform = platform;
      const convs = await coll
        .find(filter)
        .sort({ last_message_timestamp: order === "oldest" ? 1 : -1 })
        .limit(limit)
        .toArray();

      // ดึง replay results ทั้งหมดเพื่อ join
      const convIds = convs.map((c) => c.conversation_id);
      const replayColl = await getCollection<{
        conversation_id: string; final_status: string; assigned_to?: string | null;
        mock_status: string; conv_star_rating?: number; conv_rating?: string;
      }>(COLLECTIONS.testAssignment);
      const replays = await replayColl
        .find({ conversation_id: { $in: convIds } })
        .toArray();
      const replayMap = new Map(replays.map((r) => [r.conversation_id, r]));

      return json({
        rows: convs.map((c) => {
          const replay = replayMap.get(c.conversation_id);
          return {
            id: c.conversation_id,
            conversation_id: c.conversation_id,
            shop_id: c.shop_id,
            platform: c.platform,
            status: c.status,
            assigned_to: c.assigned_to,
            to_name: c.to_name,
            shop_name: c.shop_name,
            last_message_timestamp: c.last_message_timestamp,
            // replay info
            replay_status: replay?.final_status,
            replay_assigned_to: replay?.assigned_to,
            mock_status: replay?.mock_status,
            conv_star_rating: replay?.conv_star_rating,
            conv_rating: replay?.conv_rating,
          };
        }),
        total: convs.length,
      });
    }

    // ── default: status ──
    const config = await getSystemConfig();
    const mode = await assignmentService.getActiveAssignmentConfig();
    const adminsColl = await getCollection<{
      admin_id: string; name: string; username: string; role: string;
      is_accepting_chats?: boolean; active?: boolean;
    }>(COLLECTIONS.admins);
    const agents = await adminsColl.find({}).sort({ name: 1 }).toArray();

    return json({
      config: {
        bot_worker_enabled: config.bot_worker_enabled,
        bot_worker_interval_ms: config.bot_worker_interval_ms,
        shopee_bot_url: config.shopee_bot_url,
      },
      assignment_mode: mode,
      agents: agents.map((a) => ({
        admin_id: a.admin_id,
        name: a.name,
        username: a.username,
        role: a.role,
        is_accepting_chats: a.is_accepting_chats !== false,
        active: a.active !== false,
      })),
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : "failed", 500);
  }
}

// ─── POST ─────────────────────────────────────────────────

interface ReplayQa {
  index: number;
  message_id: string;
  user_text: string;
  // rich media ของ user message (เหมือนฝั่งซ้าย)
  user_message_type?: string;
  user_media?: { type: string; url?: string; thumb_url?: string; duration?: number };
  user_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  user_order_sn?: string;
  user_notification_text?: string;
  user_table?: { headers?: string[]; rows?: string[][] };
  // ⚡ bundle_message — sub-messages หลายตัว
  user_bundle?: {
    message_type: string;
    text: string;
    media?: { type: string; url?: string; thumb_url?: string };
    product_ref?: { item_id: string };
    products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  }[];
  // bot reply
  trigger_name?: string;
  trigger_action?: string;
  bot_reply?: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed?: number;
  // ⚡ bot products (item cards ที่บอทแนะนำ)
  bot_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  // ⚡ pipeline info — intent/rag/llm2/search counts
  bot_intent?: unknown;
  bot_retrieval_info?: unknown;
  bot_web_search_used?: boolean;
  bot_web_search_reason?: string;
  status: "bot_answered" | "trigger_matched" | "handed_off" | "no_agent" | "error";
  assigned_to?: string | null;
  detail: string;
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<Record<string, unknown>>(req);
  if (!body || !body.action) return error("action required", 422);

  try {
    // ── toggle worker ──
    if (body.action === "toggle_worker") {
      const enabled = !!body.enabled;
      await updateSystemConfig({ bot_worker_enabled: enabled }, r.ctx.admin.admin_id);
      return json({ ok: true, bot_worker_enabled: enabled });
    }

    // ── rate message ──
    if (body.action === "rate_message") {
      // 🔒 coerce เพื่อป้องกัน NoSQL injection
      const conversationId = String(body.conversation_id ?? "");
      const messageId = String(body.message_id ?? "");
      if (!conversationId || !messageId) return error("conversation_id + message_id required", 422);
      const ok = await testAssignmentService.rateMessage({
        conversationId,
        messageId,
        starRating: body.star_rating != null ? Number(body.star_rating) : undefined,
        rating: body.rating as "good" | "bad" | "unrated" | undefined,
        comment: body.comment as string | undefined,
        ratedBy: r.ctx.admin.admin_id,
      });
      await logAdminEvent({
        action_type: "test_assignment.rate_message",
        actor: r.ctx.admin.admin_id,
        metadata: { conversation_id: conversationId, message_id: messageId, star_rating: body.star_rating, rating: body.rating },
      });
      return json({ ok });
    }

    // ── rate conversation (ใหม่ — ทั้งแชท) ──
    if (body.action === "rate_conversation") {
      // 🔒 coerce เพื่อป้องกัน NoSQL injection
      const conversationId = String(body.conversation_id ?? "");
      if (!conversationId) return error("conversation_id required", 422);
      const ok = await testAssignmentService.rateConversation({
        conversationId,
        starRating: body.star_rating != null ? Number(body.star_rating) : undefined,
        rating: body.rating as "good" | "bad" | "unrated" | undefined,
        comment: body.comment as string | undefined,
        ratedBy: r.ctx.admin.admin_id,
      });
      await logAdminEvent({
        action_type: "test_assignment.rate_conversation",
        actor: r.ctx.admin.admin_id,
        metadata: { conversation_id: conversationId, star_rating: body.star_rating, rating: body.rating, comment_preview: ((body.comment as string) || "").slice(0, 120) },
      });
      return json({ ok });
    }

    // ── replay conversation ──
    if (body.action === "replay_conversation") {
      // 🔒 coerce เพื่อป้องกัน NoSQL injection
      const conversation_id = String(body.conversation_id ?? "");
      if (!conversation_id) return error("conversation_id required", 422);

      // ⚡ mode: "overwrite" (default) = ทำใหม่ทับ, "resume" = ข้ามถ้ามี result ครบแล้ว
      const mode = (body.mode as "overwrite" | "resume") || "overwrite";

      // ⚡ resume mode: เช็คว่ามี replay result ครบแล้ว (bot_answered, ไม่ handoff) → ข้าม
      if (mode === "resume") {
        const existing = await testAssignmentService.getTestAssignment(conversation_id);
        if (existing && existing.final_status === "bot_answered" && !existing.stopped_at_handoff) {
          return json({
            ok: true,
            conversation_id,
            skipped: true,
            reason: "already replayed (bot_answered) — skipped in resume mode",
            qa: existing.qa,
            total_messages: existing.total_messages,
            processed_messages: existing.processed_messages,
            final_status: existing.final_status,
            assigned_to: existing.assigned_to ?? null,
            stopped_at_handoff: existing.stopped_at_handoff,
          });
        }
      }

      // ดึง user messages (oldest first)
      const msgColl = await getCollection<{
        message_id: string; conversation_id: string; shop_id: string;
        platform: Platform; role: string; direction: string; text: string;
        created_timestamp: Date; raw_payload?: unknown;
      }>(COLLECTIONS.messages);
      const messages = await msgColl
        .find({ conversation_id, role: "user", direction: "in" })
        .sort({ created_timestamp: 1 })
        .limit(30)
        .toArray();

      if (messages.length === 0) {
        return json({
          ok: true,
          conversation_id,
          qa: [],
          final_status: "no_messages",
          assigned_to: null,
          message: "ไม่มี user message ใน conversation นี้",
        });
      }

      // ดึง conversation info
      const convColl = await getCollection<{
        conversation_id: string; shop_id: string; platform: string;
        shop_name?: string; to_name?: string; assigned_to: string | null;
      }>(COLLECTIONS.conversations);
      const conv = await convColl.findOne({ conversation_id: conversation_id });
      const shopId = conv?.shop_id || messages[0].shop_id;
      const platform = (conv?.platform || messages[0].platform) as Platform;
      const shopName = conv?.shop_name;
      const toName = conv?.to_name;

      // ⚡ Parse user messages rich media + batch lookup products (เหมือนฝั่งซ้าย)
      const userParsed = messages.map((m) => ({
        doc: m,
        parsed: parseRawMessage(m.raw_payload, m.text),
      }));
      const userItemIds = new Set<string>();
      for (const { parsed: p } of userParsed) {
        if (p?.product_ref?.item_id) userItemIds.add(p.product_ref.item_id);
      }
      const userProductMap = new Map<string, unknown>();
      if (userItemIds.size > 0 && conv) {
        try {
          const products = await productService.getProductsByIds({
            platform: platform as Platform,
            itemIds: [...userItemIds],
          });
          for (const p of products) {
            const id = String((p as Record<string, unknown>).item_id || (p as Record<string, unknown>).itemid || "");
            if (id) userProductMap.set(id, p);
          }
        } catch { /* ignore */ }
      }
      // map message_id → parsed info (key ตรงกับ ReplayQa interface: user_*)
      const userParsedMap = new Map<string, Omit<ReplayQa, "index" | "message_id" | "user_text" | "trigger_name" | "trigger_action" | "bot_reply" | "bot_source" | "bot_model" | "bot_elapsed" | "status" | "assigned_to" | "detail">>();
      for (const { doc, parsed: p } of userParsed) {
        const products: unknown[] = [];
        if (p?.product_ref?.item_id) {
          const prod = userProductMap.get(p.product_ref.item_id);
          if (prod && conv) {
            const card = toProductCard(prod as Record<string, unknown>, platform as Platform);
            products.push(card);
          }
        }
        // ⚡ แปลง bundle sub-messages → ส่งไป frontend
        let userBundle: ReplayQa["user_bundle"];
        if (p?.bundle && p.bundle.length > 0) {
          userBundle = p.bundle.map((sub) => {
            const subProducts: unknown[] = [];
            if (sub.product_ref?.item_id) {
              const prod = userProductMap.get(sub.product_ref.item_id);
              if (prod && conv) {
                subProducts.push(toProductCard(prod as Record<string, unknown>, platform as Platform));
              }
            }
            return {
              message_type: String(sub.message_type || "text"),
              text: sub.text || "",
              media: sub.media as { type: string; url?: string; thumb_url?: string } | undefined,
              product_ref: sub.product_ref,
              products: subProducts.length > 0 ? (subProducts as ReplayQa["user_products"]) : undefined,
            };
          });
        }
        userParsedMap.set(doc.message_id, {
          user_message_type: p?.message_type,
          user_media: p?.media as ReplayQa["user_media"],
          user_products: products.length > 0 ? (products as ReplayQa["user_products"]) : undefined,
          user_order_sn: p?.order_sn,
          user_notification_text: p?.notification_text,
          user_table: p?.table as ReplayQa["user_table"],
          user_bundle: userBundle,
        });
      }

      const qa: ReplayQa[] = [];
      let finalStatus = "bot_answered";
      let assignedTo: string | null = null;
      let stopped = false;

      const history: { role: "user" | "model"; text: string }[] = [];

      for (let i = 0; i < messages.length && !stopped; i++) {
        const msg = messages[i];
        const userText = msg.text || "(empty)";

        try {
          // 1. check trigger
          const trigger = await triggerService.matchTrigger(userText, {
            shopId,
            platform,
          });

          if (trigger && trigger.action === "handoff_admin") {
            // trigger → handoff (ใช้ handoffService: หา admin เดิมก่อน round-robin)
            const handoff = await handoffService.handoffToAdmin({
              conversationId: conversation_id,
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

          // 2. call bot
          // ⚡ ส่ง item_id ถ้าลูกค้าแชร์การ์ดสินค้ามาในแชท
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
            const handoff = await handoffService.handoffToAdmin({
              conversationId: conversation_id,
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

          // bot ตอบได้ → สะสม history
          history.push({ role: "user", text: userText });
          history.push({ role: "model", text: botResp.answer });

          // ⚡ เช็ค handoff_to_admin จาก bot (tax_invoice, warranty claim, etc.)
          // ถ้า bot บอกให้ handoff → หยุด replay ที่นี่
          if (botResp.handoff_to_admin) {
            const handoff = await handoffService.handoffToAdmin({
              conversationId: conversation_id,
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

      // ── บันทึกลง test_assignment collection ──
      const saved = await testAssignmentService.saveReplayResult({
        conversation_id,
        shop_id: shopId,
        platform,
        shop_name: shopName,
        to_name: toName,
        qa: qa as never,
        total_messages: messages.length,
        processed_messages: qa.length,
        final_status: finalStatus,
        assigned_to: assignedTo,
        stopped_at_handoff: stopped,
      });

      return json({
        ok: true,
        conversation_id,
        shop_id: shopId,
        platform,
        shop_name: shopName,
        qa,
        total_messages: messages.length,
        processed_messages: qa.length,
        final_status: finalStatus,
        assigned_to: assignedTo,
        stopped_at_handoff: stopped,
        mock_status: saved?.mock_status,
        saved_id: saved?._id?.toString(),
      });
    }

    return error("unknown action: replay_conversation | rate_message | rate_conversation | toggle_worker", 422);
  } catch (err) {
    return error(err instanceof Error ? err.message : "failed", 500);
  }
}
