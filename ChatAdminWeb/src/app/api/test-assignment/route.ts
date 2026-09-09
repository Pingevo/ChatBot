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
import { getSystemConfig, updateSystemConfig, shouldUseChatV2 } from "@/backend/service/systemConfigService";
import { assignmentService } from "@/backend/service/assignmentService";
import { handoffService } from "@/backend/service/handoffService";
// ⚡ Phase 2J — test-assignment ใช้ test version (เก็บใน test_status_conversation ไม่ใช่ status_conversation จริง)
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { triggerService } from "@/backend/service/triggerService";
import { testAssignmentService } from "@/backend/service/testAssignmentService";
import type { TestAssignmentDoc } from "@/backend/service/testAssignmentService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { parseRawMessage, toProductCard } from "@/backend/service/messageMediaParser";
import { productService } from "@/backend/service/productService";
import { serverConfig } from "@/backend/lib/config";
import type { Platform } from "@/backend/lib/safety";
import { toBotText, toBotImages } from "@/backend/service/messageService";

// ─── Helpers ──────────────────────────────────────────────

async function callBot(params: {
  platform: Platform;
  message: string;
  history: { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[];
  shopId: string;
  shopName?: string;
  itemId?: string;  // ⚡ item_id จากการ์ดสินค้าที่ลูกค้าแชร์
  orderSn?: string;  // ⚡ Phase 3C — order_sn จากการ์ดคำสั่งซื้อที่ลูกค้าแชร์
  images?: string[];  // ⚡ Phase 1A — URL รูป/วิดีโอที่ลูกค้าส่ง (ส่งให้ bot vision pass)
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
  // ⚡ chat_engine — บันทึกว่าคำตอบนี้ใช้ engine ไหน
  chat_engine?: "legacy" | "v2";
}> {
  const { platform, message, history, shopId, shopName, itemId, orderSn, images } = params;
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
  // ⚡ Phase 3C — ส่ง order_sn ถ้าลูกค้าแชร์การ์ดคำสั่งซื้อมาในแชท
  if (orderSn) body.order_sn = orderSn;
  // ⚡ Phase 1A — ส่ง URL รูป/วิดีโอให้ bot ใช้ Gemini vision อ่าน
  if (images && images.length > 0) body.images = images;
  // ⚡ chat_engine — อ่านจาก SystemConfig (หน้า config ควบคุม)
  const useV2 = await shouldUseChatV2();
  if (useV2) body.use_v2 = true;

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
        // ⚡ chat_engine — บันทึก engine ที่ใช้
        chat_engine: useV2 ? "v2" : "legacy",
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
      // ⚡ Phase 3B-7 — รองรับ replay_batch_id (ถ้าไม่ส่ง → คืนล่าสุด)
      const replayBatchId = url.searchParams.get("replay_batch_id") || undefined;

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
      // ⚡ Phase 3B-4 — ส่ง admin_id เพื่อกรอง doc ของ admin คนนี้
      //   superadmin/dev ไม่ส่ง → ดึง doc ล่าสุด (ไม่กรอง)
      // ⚡ Phase 3B-7 — ส่ง replay_batch_id ถ้ามี (กรองเฉพาะรอบ)
      const isSuperadminDetail = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const replay = await testAssignmentService.getTestAssignment(
        conversationId,
        isSuperadminDetail ? undefined : r.ctx.admin.admin_id,
        replayBatchId
      );

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
    // ⚡ Phase 3B-5 — "All" tab = แค่ chat list เหมือน inbox (ไม่กรอง replayed_by, ไม่ join replay status)
    //   replay status อยู่ใน History tab เท่านั้น
    if (list) {
      const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
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

      // ⚡ Phase 3B-5 — ไม่ join replay status แล้ว (All tab = แค่ chat list)
      return json({
        rows: convs.map((c) => ({
          id: c.conversation_id,
          conversation_id: c.conversation_id,
          shop_id: c.shop_id,
          platform: c.platform,
          status: c.status,
          assigned_to: c.assigned_to,
          to_name: c.to_name,
          shop_name: c.shop_name,
          last_message_timestamp: c.last_message_timestamp,
        })),
        total: convs.length,
      });
    }

    // ── ⚡ Phase 3B-7 — replay batches list (batch selector) ──
    if (url.searchParams.get("batches") === "1") {
      const conversationId = url.searchParams.get("conversation_id");
      if (!conversationId) return error("conversation_id required", 422);
      const isSuperadminB = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const batches = await testAssignmentService.listReplayBatches({
        conversationId,
        replayedBy: isSuperadminB ? undefined : r.ctx.admin.admin_id,
      });
      return json({ batches });
    }

    // ── ⚡ Phase 3B-2 — history by admin ──
    if (url.searchParams.get("history") === "1") {
      const adminId = url.searchParams.get("admin_id") || r.ctx.admin.admin_id;
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "500", 10), 1), 1000);
      const docs = await testAssignmentService.listHistoryByAdmin({ adminId, limit });
      // ⚡ Phase 3B-7 — แชทหนึ่งอาจมีหลายรอบ → dedupe เก็บล่าสุดต่อ conversation_id
      //   (docs เรียง replayed_at desc อยู่แล้ว → ใช้อันแรกที่เจอต่อ conversation_id)
      const seen = new Set<string>();
      const rows = [];
      for (const d of docs) {
        if (seen.has(d.conversation_id)) continue;
        seen.add(d.conversation_id);
        rows.push({
          conversation_id: d.conversation_id,
          shop_id: d.shop_id,
          platform: d.platform,
          shop_name: d.shop_name,
          to_name: d.to_name,
          final_status: d.final_status,
          replayed_by: d.replayed_by,
          replayed_at: d.replayed_at,
          replay_batch_id: d.replay_batch_id,  // ⚡ Phase 3B-7
          total_messages: d.total_messages,
          processed_messages: d.processed_messages,
          stopped_at_handoff: d.stopped_at_handoff,
          conv_star_rating: d.conv_star_rating,
          conv_rating: d.conv_rating,
          conv_comment: d.conv_comment,
        });
      }
      return json({ rows, total: rows.length });
    }

    // ── ⚡ Phase 3B-2 — deleted list ──
    if (url.searchParams.get("deleted") === "1") {
      const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const adminId = isSuperadmin ? (url.searchParams.get("admin_id") || undefined) : r.ctx.admin.admin_id;
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "500", 10), 1), 1000);
      const docs = await testAssignmentService.listDeleted({ adminId, limit });
      return json({
        rows: docs.map((d) => ({
          conversation_id: d.conversation_id,
          shop_id: d.shop_id,
          platform: d.platform,
          shop_name: d.shop_name,
          to_name: d.to_name,
          final_status: d.final_status,
          replayed_by: d.replayed_by,
          replayed_at: d.replayed_at,
          deleted_at: d.deleted_at,
          deleted_by: d.deleted_by,
          delete_reason: d.delete_reason,
        })),
        total: docs.length,
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
  // ⚡ chat_engine — บันทึกว่าคำตอบนี้ใช้ engine ไหน (legacy / v2)
  chat_engine?: "legacy" | "v2";
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

    // ── ⚡ Phase 3B-2 — soft delete replay result ──
    if (body.action === "soft_delete") {
      const conversationId = String(body.conversation_id ?? "");
      if (!conversationId) return error("conversation_id required", 422);
      const ok = await testAssignmentService.softDelete({
        conversationId,
        deletedBy: r.ctx.admin.admin_id,
        reason: body.reason ? String(body.reason) : undefined,
        replayedBy: r.ctx.admin.admin_id,  // ⚡ Phase 3B-4 — กรอง doc ของ admin คนนี้
        replayBatchId: body.replay_batch_id ? String(body.replay_batch_id) : undefined,  // ⚡ Phase 3B-7
      });
      if (!ok) return error("not found", 404);
      await logAdminEvent({
        action_type: "test_assignment.soft_delete",
        actor: r.ctx.admin.admin_id,
        conversation_id: conversationId,
        metadata: { reason: body.reason || "" },
      });
      return json({ ok: true });
    }

    // ── ⚡ Phase 3B-2 — restore soft-deleted replay ──
    if (body.action === "restore") {
      const conversationId = String(body.conversation_id ?? "");
      if (!conversationId) return error("conversation_id required", 422);
      const ok = await testAssignmentService.restore(
        conversationId,
        r.ctx.admin.admin_id,
        body.replay_batch_id ? String(body.replay_batch_id) : undefined  // ⚡ Phase 3B-7
      );
      if (!ok) return error("not found", 404);
      await logAdminEvent({
        action_type: "test_assignment.restore",
        actor: r.ctx.admin.admin_id,
        conversation_id: conversationId,
      });
      return json({ ok: true });
    }

    // ── ⚡ Phase 3B-2 — batch roll: คืนรายการ conversation_ids ที่จะ replay ──
    //   frontend จะไล่เรียก replay_conversation ทีละอัน
    //   params:
    //     count: จำนวนแชทที่ต้องการ (default 10)
    //     order: "recent" | "oldest" (default "recent")
    //     mode: "overwrite" | "resume" (default "overwrite")
    //       - overwrite = ทำใหม่ทับ
    //       - resume = ข้ามแชทที่ตัวเองเคย replay แล้ว (bot_answered ไม่ handoff)
    //     platform: กรองตาม platform (optional)
    if (body.action === "batch_roll") {
      const count = Math.min(Math.max(parseInt(String(body.count ?? "10"), 10) || 10, 1), 1000);
      const order = (body.order as "recent" | "oldest") || "recent";
      const mode = (body.mode as "overwrite" | "resume") || "overwrite";
      const platformFilter = body.platform ? String(body.platform) : undefined;

      const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const adminId = r.ctx.admin.admin_id;

      // ดึง conversations (เรียงตาม last_message_timestamp)
      const convColl = await getCollection<{
        conversation_id: string; shop_id: string; platform: string;
        last_message_timestamp?: Date;
      }>(COLLECTIONS.conversations);
      const convFilter: Record<string, unknown> = {};
      if (platformFilter) convFilter.platform = platformFilter;
      const allConvs = await convColl
        .find(convFilter)
        .sort({ last_message_timestamp: order === "oldest" ? 1 : -1 })
        .limit(count * 3) // ดึงเผื่อไว้ เพราะบางอันอาจถูก skip
        .project({ conversation_id: 1 })
        .toArray();

      if (allConvs.length === 0) {
        return json({ conversation_ids: [], total: 0, skipped: 0 });
      }

      // ถ้า mode = "resume" → กรองออกแชทที่ตัวเองเคย replay แล้ว (bot_answered ไม่ handoff)
      let skipped = 0;
      let conversationIds: string[] = [];

      if (mode === "resume") {
        const replayColl = await getCollection<{
          conversation_id: string; replayed_by?: string;
          final_status: string; stopped_at_handoff: boolean;
        }>(COLLECTIONS.testAssignment);
        // ดึง replay results ของ admin คนนี้ที่ complete แล้ว
        const myReplays = await replayColl
          .find({
            replayed_by: adminId,
            final_status: "bot_answered",
            stopped_at_handoff: false,
            deleted_at: { $exists: false },
          })
          .project({ conversation_id: 1 })
          .toArray();
        const myDoneConvIds = new Set(myReplays.map((x) => x.conversation_id));

        for (const c of allConvs) {
          if (conversationIds.length >= count) break;
          if (myDoneConvIds.has(c.conversation_id)) {
            skipped++;
            continue;
          }
          conversationIds.push(c.conversation_id);
        }
      } else {
        // overwrite mode → ไม่ skip
        conversationIds = allConvs.slice(0, count).map((c) => c.conversation_id);
      }

      // ⚡ Phase 3A — visibility: admin ทั่วไปเห็นเฉพาะที่ตัวเอง replay ไว้ในหน้า list
      //   แต่ใน batch roll mode "overwrite" → อนุญาตให้ replay แชทใหม่ได้ (เพราะจะสร้าง ownership ใหม่)
      //   ใน mode "resume" → ข้ามเฉพาะของตัวเอง (ตามที่ user เลือก)

      await logAdminEvent({
        action_type: "test_assignment.batch_roll",
        actor: adminId,
        metadata: {
          count: conversationIds.length,
          order,
          mode,
          platform: platformFilter,
          skipped,
          is_superadmin: isSuperadmin,
        },
      });

      return json({
        conversation_ids: conversationIds,
        total: conversationIds.length,
        skipped,
        order,
        mode,
      });
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
        replayedBy: r.ctx.admin.admin_id,  // ⚡ Phase 3B-4 — กรอง doc ของ admin คนนี้
        replayBatchId: body.replay_batch_id ? String(body.replay_batch_id) : undefined,  // ⚡ Phase 3B-7
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
        replayedBy: r.ctx.admin.admin_id,  // ⚡ Phase 3B-4 — กรอง doc ของ admin คนนี้
        replayBatchId: body.replay_batch_id ? String(body.replay_batch_id) : undefined,  // ⚡ Phase 3B-7
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

      // ⚡ Phase 2J — เคลียร์ test_status_conversation ของ conversation นี้ก่อน replay
      //   กัน assigned_to เดิมจาก replay ครั้งก่อนติดมา
      await testStatusConversationService.updateTestStatus(
        conversation_id,
        "test_assignment",
        "bot",
        undefined,
        undefined
      );

      // ⚡ mode: "overwrite" (default) = ทำใหม่ทับ, "resume" = ข้ามถ้ามี result ครบแล้ว
      const mode = (body.mode as "overwrite" | "resume") || "overwrite";

      // ⚡ resume mode: เช็คว่ามี replay result ครบแล้ว (bot_answered, ไม่ handoff) → ข้าม
      // ⚡ Phase 3B-4 — เช็คเฉพาะ doc ของ admin คนนี้ (ไม่ใช่ของทุกคน)
      if (mode === "resume") {
        const existing = await testAssignmentService.getTestAssignment(conversation_id, r.ctx.admin.admin_id);
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

      const history: { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[] = [];

      for (let i = 0; i < messages.length && !stopped; i++) {
        const msg = messages[i];
        // ⚡ ใช้ toBotText แปลง rich media → tag ส่งบอท (เหมือน shadowbot/botworker)
        //   เช่น [item] → [สินค้า: 12345], [order] → [order: ABC123]
        //   ส่วน user_text ใน QA ยังเก็บ msg.text ดิบไว้สำหรับ display (MessageContent จัดการเอง)
        const botText = toBotText(msg);
        const userImages = toBotImages(msg);
        const userText = msg.text || "(empty)";

        try {
          // 1. check trigger — ใช้ botText (แปลง rich media เป็น tag แล้ว) เพื่อ match คำจริง
          const trigger = await triggerService.matchTrigger(botText, {
            shopId,
            platform,
          });

          if (trigger && trigger.action === "handoff_admin") {
            // trigger → handoff (ใช้ handoffService: หา admin เดิมก่อน round-robin)
            const handoff = await handoffService.handoffToAdminTest({
              source: "test_assignment",
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
          const userOrderSn = userParsedInfo?.user_order_sn || undefined;  // ⚡ Phase 3C
          const botResp = await callBot({
            platform,
            message: botText,
            shopId,
            shopName,
            history,
            itemId: userItemId,
            orderSn: userOrderSn,  // ⚡ Phase 3C
            images: userImages.length > 0 ? userImages : undefined,  // ⚡ Phase 1A
          });

          if (!botResp.answer || botResp.answer.trim() === "") {
            // bot ตอบไม่ได้ → handoff
            const handoff = await handoffService.handoffToAdminTest({
              source: "test_assignment",
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

          // bot ตอบได้ → สะสม history (ใช้ botText + images เหมือนของจริง)
          history.push({ role: "user", text: botText, ...(userImages.length > 0 ? { images: userImages } : {}) });
          history.push({ role: "model", text: botResp.answer });

          // ⚡ เช็ค handoff_to_admin จาก bot (tax_invoice, warranty claim, etc.)
          // ถ้า bot บอกให้ handoff → หยุด replay ที่นี่
          if (botResp.handoff_to_admin) {
            const handoff = await handoffService.handoffToAdminTest({
              source: "test_assignment",
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
              chat_engine: botResp.chat_engine || "legacy",
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
            chat_engine: botResp.chat_engine || "legacy",
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
        replayedBy: r.ctx.admin.admin_id,  // ⚡ Phase 3A — บันทึกใครกด replay
      });

      // ⚡ Phase 3A — audit log สำหรับ replay (KPI)
      await logAdminEvent({
        action_type: "test_assignment.replay",
        actor: r.ctx.admin.admin_id,
        conversation_id,
        metadata: {
          shop_id: shopId,
          platform,
          total_messages: messages.length,
          processed_messages: qa.length,
          final_status: finalStatus,
          stopped_at_handoff: stopped,
        },
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
        // ⚡ Phase 3B-7 — ส่ง replay_batch_id กลับไป UI
        replay_batch_id: (saved as TestAssignmentDoc & { batchId?: string })?.batchId || saved?.replay_batch_id,
      });
    }

    return error("unknown action: replay_conversation | rate_message | rate_conversation | toggle_worker | soft_delete | restore", 422);
  } catch (err) {
    return error(err instanceof Error ? err.message : "failed", 500);
  }
}
