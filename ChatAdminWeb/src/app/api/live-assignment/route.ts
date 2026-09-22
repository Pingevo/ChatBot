// Live Assignment API — จ่ายงานจริงให้แอดมิน + จำลอง flow เต็มรูปแบบ
//
// GET  /api/live-assignment?list=1&limit=500&platform=shopee
//   → list live assignment docs (conversations ที่ replay แล้ว)
//
// GET  /api/live-assignment?conv_detail=1&conversation_id=xxx
//   → ดึงรายละเอียดแชท + qa + messages
//
// GET  /api/live-assignment?stats=1
//   → สถิติรวม
//
// POST /api/live-assignment
//   body: { action: "batch_replay", count, order, mode, platform }
//   → ดึง conversation IDs สำหรับ batch replay
//
// POST /api/live-assignment
//   body: { action: "replay_conversation", conversation_id }
//   → replay ทีละ conversation
//
// POST /api/live-assignment
//   body: { action: "admin_reply", conversation_id, text }
//   → แอดมินตอบลูกค้า
//
// POST /api/live-assignment
//   body: { action: "close_chat", conversation_id, reason, category, resolution, note }
//   → ปิดแชท + เช็คคำถามเหลือ + reopen + flow
export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { liveAssignmentService } from "@/backend/service/liveAssignmentService";
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { parseRawMessage, toProductCard } from "@/backend/service/messageMediaParser";
import { productService } from "@/backend/service/productService";
import type { Platform } from "@/backend/lib/safety";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const list = url.searchParams.get("list");
  const convDetail = url.searchParams.get("conv_detail");
  const stats = url.searchParams.get("stats");

  try {
    // ── list ──
    if (list === "1") {
      const platform = url.searchParams.get("platform") as Platform | null;
      const finalStatus = url.searchParams.get("final_status") || undefined;
      const mockStatus = url.searchParams.get("mock_status") as "open" | "closed" | null;
      // ⚡ assigned_to: "me" → admin_id ตัวเอง · "all"/ไม่ส่ง → ไม่ filter · "unassigned" → งานที่ยังไม่มีผู้รับ
      const assignedToParam = url.searchParams.get("assigned_to") || "all";
      const assignedTo =
        assignedToParam === "all" ? undefined
        : assignedToParam === "me" ? r.ctx.admin.admin_id
        : assignedToParam;
      const cursorParam = url.searchParams.get("cursor") || undefined;
      const includeCount = url.searchParams.get("include_count") === "true";
      const limit = parseInt(url.searchParams.get("limit") || "200", 10);

      // ⚡ parse cursor (updated_at|conversation_id)
      let parsedCursor: { ts: Date; id: string } | undefined;
      if (cursorParam) {
        const sepIdx = cursorParam.indexOf("|");
        if (sepIdx > 0) {
          const tsStr = cursorParam.substring(0, sepIdx);
          const idStr = cursorParam.substring(sepIdx + 1);
          const ts = new Date(tsStr);
          if (!isNaN(ts.getTime()) && idStr) parsedCursor = { ts, id: idStr };
        }
      }

      const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const replayedBy = isSuperadmin ? undefined : r.ctx.admin.admin_id;

      const docs = await liveAssignmentService.listLiveAssignments({
        platform: platform || undefined,
        finalStatus,
        mockStatus: mockStatus || undefined,
        assignedTo,
        replayedBy,
        limit,
        cursor: parsedCursor,
      });

      // ⚡ hasMore + cursor สำหรับ pagination
      //   fallback created_at — บาง writer (เช่น push_unit_reg_to_admin) ไม่ใส่ updated_at
      const hasMore = docs.length === limit;
      const lastDoc = docs[docs.length - 1];
      const lastTs = lastDoc?.updated_at ?? lastDoc?.created_at;
      const nextCursor = lastTs
        ? `${lastTs.toISOString()}|${lastDoc.conversation_id}`
        : null;

      if (includeCount) {
        return json({ conversations: docs, total: docs.length, has_more: hasMore, cursor: nextCursor });
      }
      return json({ conversations: docs, total: docs.length });
    }

    // ── conv_detail ──
    if (convDetail === "1") {
      const conversationId = url.searchParams.get("conversation_id");
      if (!conversationId) return error("conversation_id required", 422);

      const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const replayedBy = isSuperadmin ? undefined : r.ctx.admin.admin_id;

      const doc = await liveAssignmentService.getLiveAssignment(conversationId, replayedBy);
      if (!doc) return error("not found", 404);

      // ดึง messages จริงจาก DB (เหมือน test-assignment)
      const msgColl = await getCollection<{
        message_id: string;
        conversation_id: string;
        role: string;
        direction?: string;
        text?: string;
        sender?: string;
        raw_payload?: unknown;
        created_timestamp: Date;
      }>(COLLECTIONS.messages);

      const messages = await msgColl
        .find({ conversation_id: conversationId })
        .sort({ created_timestamp: 1 })
        .limit(200)
        .toArray();

      // ⚡ ดึง conversation เพื่อหา platform สำหรับ product lookup
      const convColl = await getCollection<{
        conversation_id: string; platform: string; shop_name?: string; to_name?: string;
      }>(COLLECTIONS.conversations);
      const conv = await convColl.findOne({ conversation_id: conversationId });
      const convPlatform = (conv?.platform || "shopee") as Platform;

      // ⚡ parse raw_payload ทุก message เสมอ (แม้ไม่มี raw_payload — parser infer จาก placeholder text)
      const parsedMsgs = messages.map((m) => ({
        doc: m,
        parsed: parseRawMessage(m.raw_payload, m.text || ""),
      }));

      // ⚡ batch lookup products สำหรับ item/variation_card (เหมือน admin/conversations API)
      const itemIdsToLookup = new Set<string>();
      for (const { parsed: p } of parsedMsgs) {
        if (p?.product_ref?.item_id) itemIdsToLookup.add(p.product_ref.item_id);
      }
      const productMap = new Map<string, unknown>();
      if (itemIdsToLookup.size > 0) {
        try {
          const products = await productService.getProductsByIds({
            platform: convPlatform,
            itemIds: [...itemIdsToLookup],
          });
          for (const p of products) {
            const id = String((p as Record<string, unknown>).item_id || (p as Record<string, unknown>).itemid || "");
            if (id) productMap.set(id, p);
          }
        } catch { /* ignore product lookup errors */ }
      }

      // แปลงเป็น ChatMessage format
      const chatMessages = parsedMsgs.map(({ doc: m, parsed: p }) => {
        const isUser = m.role === "user";
        const isAdmin = m.role === "admin" || (m.sender && m.sender !== "bot" && m.sender !== "zaapi" && m.role !== "user");
        const isBot = m.role === "bot" || m.sender === "bot";
        // const isZaapi = m.sender === "zaapi" || (m.role === "admin" && !m.sender);

        // ⚡ ดึง products จาก product lookup สำหรับ item/variation_card
        const products: unknown[] = [];
        if (p?.product_ref?.item_id) {
          const prod = productMap.get(p.product_ref.item_id);
          if (prod) {
            products.push(toProductCard(prod as Record<string, unknown>, convPlatform));
          }
        }

        return {
          id: m.message_id,
          role: isUser ? "user" : isBot ? "bot" : isAdmin ? "admin" : "system",
          text: p?.text || m.text || "",
          timestamp: m.created_timestamp?.toISOString() || new Date().toISOString(),
          admin_id: isAdmin ? m.sender : undefined,
          message_type: p?.message_type,
          media: p?.media,
          order_sn: p?.order_sn,
          notification_text: p?.notification_text,
          table: p?.table,
          bundle: p?.bundle,
          products: products.length > 0 ? products : undefined,
        };
      });

      return json({
        replay: doc,
        messages: chatMessages,
      });
    }

    // ── stats ──
    if (stats === "1") {
      const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const replayedBy = isSuperadmin ? undefined : r.ctx.admin.admin_id;
      const s = await liveAssignmentService.getLiveAssignmentStats({ replayedBy });
      return json(s);
    }

    return error("missing parameter: list | conv_detail | stats", 422);
  } catch (err) {
    return error(err instanceof Error ? err.message : "failed", 500);
  }
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<Record<string, unknown>>(req);
  if (!body || !body.action) return error("action required", 422);

  try {
    // ── batch_replay — ดึง conversation IDs ──
    if (body.action === "batch_replay") {
      const count = Math.min(Math.max(parseInt(String(body.count ?? "10"), 10) || 10, 1), 1000);
      const order = (body.order as "recent" | "oldest") || "recent";
      const mode = (body.mode as "overwrite" | "resume") || "overwrite";
      const platformFilter = body.platform ? String(body.platform) : undefined;

      const adminId = r.ctx.admin.admin_id;

      const convColl = await getCollection<{
        conversation_id: string; shop_id: string; platform: string;
        last_message_timestamp?: Date;
      }>(COLLECTIONS.conversations);
      const convFilter: Record<string, unknown> = {};
      if (platformFilter) convFilter.platform = platformFilter;
      const allConvs = await convColl
        .find(convFilter)
        .sort({ last_message_timestamp: order === "oldest" ? 1 : -1 })
        .limit(count * 3)
        .project({ conversation_id: 1 })
        .toArray();

      if (allConvs.length === 0) {
        return json({ conversation_ids: [], total: 0, skipped: 0 });
      }

      let skipped = 0;
      let conversationIds: string[] = [];

      if (mode === "resume") {
        const replayColl = await getCollection<{
          conversation_id: string; replayed_by?: string;
          final_status: string; stopped_at_handoff: boolean;
        }>(COLLECTIONS.testAssignment);
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
        conversationIds = allConvs.slice(0, count).map((c) => c.conversation_id);
      }

      await logAdminEvent({
        action_type: "live_assignment.batch_replay",
        actor: adminId,
        metadata: {
          count: conversationIds.length,
          order,
          mode,
          platform: platformFilter,
          skipped,
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

    // ── replay_conversation — replay ทีละ conversation ──
    if (body.action === "replay_conversation") {
      const conversationId = String(body.conversation_id ?? "");
      if (!conversationId) return error("conversation_id required", 422);

      const adminId = r.ctx.admin.admin_id;

      // ดึง conversation info
      const convColl = await getCollection<{
        conversation_id: string; shop_id: string; platform: string;
        shop_name?: string; to_name?: string;
      }>(COLLECTIONS.conversations);
      const conv = await convColl.findOne({ conversation_id: conversationId });
      if (!conv) return error("conversation not found", 404);

      const platform = conv.platform as Platform;
      const shopId = conv.shop_id;
      const shopName = conv.shop_name;
      const toName = conv.to_name;

      // reset test status
      await testStatusConversationService.updateTestStatus(
        conversationId,
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
        .find({ conversation_id: conversationId, role: "user", direction: "in" })
        .sort({ created_timestamp: 1 })
        .limit(30)
        .toArray();

      if (messages.length === 0) {
        return error("no user messages", 422);
      }

      // parse user messages — เรียก parseRawMessage เสมอ (แม้ไม่มี raw_payload — parser infer จาก placeholder text)
      const userParsedMap = new Map<string, Record<string, unknown>>();
      for (const msg of messages) {
        try {
          const p = parseRawMessage(msg.raw_payload, msg.text || "");
          const products: unknown[] = [];
          if (p?.product_ref?.item_id) {
            const prod = await productService.getProduct({ platform, itemId: p.product_ref.item_id });
            if (prod && conv) {
              const card = toProductCard(prod as Record<string, unknown>, platform);
              products.push(card);
            }
          }
          userParsedMap.set(msg.message_id, {
            user_message_type: p?.message_type,
            user_media: p?.media,
            user_products: products.length > 0 ? products : undefined,
            user_order_sn: p?.order_sn,
            user_notification_text: p?.notification_text,
            user_table: p?.table,
          });
        } catch {
          // ignore
        }
      }

      // replay ผ่าน flow (เรียก service batchReplay สำหรับ 1 conversation)
      const result = await liveAssignmentService.batchReplay({
        conversationIds: [conversationId],
        replayedBy: adminId,
        mode: (body.mode as "overwrite" | "resume") || "overwrite",
      });

      const r0 = result.results[0];
      if (!r0 || !r0.ok) {
        return error(r0?.error || "replay failed", 500);
      }

      return json({
        ok: true,
        conversation_id: conversationId,
        final_status: r0.final_status,
      });
    }

    // ── admin_reply — แอดมินตอบลูกค้า ──
    if (body.action === "admin_reply") {
      const conversationId = String(body.conversation_id ?? "");
      const text = String(body.text ?? "");
      if (!conversationId) return error("conversation_id required", 422);
      if (!text.trim()) return error("text required", 422);

      const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const replayedBy = isSuperadmin ? undefined : r.ctx.admin.admin_id;

      const result = await liveAssignmentService.adminReply({
        conversationId,
        text,
        adminId: r.ctx.admin.admin_id,
        replayedBy,
      });

      if (!result.ok) return error(result.error || "reply failed", 422);

      return json({ ok: true, doc: result.doc });
    }

    // ── close_chat — ปิดแชท + reopen + flow ──
    if (body.action === "close_chat") {
      const conversationId = String(body.conversation_id ?? "");
      if (!conversationId) return error("conversation_id required", 422);

      const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
      const replayedBy = isSuperadmin ? undefined : r.ctx.admin.admin_id;

      const result = await liveAssignmentService.closeChat({
        conversationId,
        adminId: r.ctx.admin.admin_id,
        reason: String(body.reason || ""),
        category: String(body.category || ""),
        resolution: String(body.resolution || ""),
        note: body.note ? String(body.note) : undefined,
        replayedBy,
      });

      if (!result.ok) return error(result.error || "close failed", 422);

      return json({
        ok: true,
        closed: result.closed,
        reopened: result.reopened,
        new_qa: result.newQa,
        final_status: result.finalStatus,
        assigned_to: result.assignedTo,
      });
    }

    return error("unknown action: batch_replay | replay_conversation | admin_reply | close_chat", 422);
  } catch (err) {
    return error(err instanceof Error ? err.message : "failed", 500);
  }
}
