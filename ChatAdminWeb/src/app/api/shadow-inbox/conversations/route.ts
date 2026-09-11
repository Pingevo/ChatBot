// GET /api/shadow-inbox/conversations — list conversations ที่มี shadow_replies เท่านั้น
//
// แก้ปัญหา: tab History ในหน้า shadow-inbox เคยโหลด /admin/conversations?limit=10000
// แล้ว filter ใน frontend → timeout 30s และโหลดไม่ครบ
//
// วิธีใหม่: distinct conversation_id จาก shadow_replies (มี index) →
// lookup เฉพาะ conversations ที่มี shadow reply จริง → คืนในรูปแบบ Conversation[]
//
// ⚡ Pagination: ใช้ aggregation pipeline group by conversation_id, sort by max(created_at) desc
//   cursor = created_at ของ shadow reply ล่าสุดใน page ปัจจุบัน
//   pageSize = 200 (default)
//   คืน { rows: Conversation[], nextCursor: string|null, totalCount: number }
//
// ⛔ IRON RULE: ห้ามส่งข้อความจริง ห้ามเรียก platform API
// ⚡ force-dynamic — กัน Next.js cache GET response (กันข้อมูลเก่าค้างใน tab History)
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { Conversation } from "@/lib/types";
import type { ConversationDoc } from "@/backend/service/conversationService";
// ⚡ Phase 2J — shadow-inbox อ่าน assigned_to/status จาก test_status_conversation (test)
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { shadowReplyService } from "@/backend/service/shadowReplyService";
import { logAdminEvent } from "@/backend/service/adminLogService";

/**
 * ⚡ Paginated — ดึง conversation_ids จาก shadow_replies แบบหน้า ๆ
 *   ใช้ aggregation pipeline: group by conversation_id, sort by max(created_at) desc
 *   cursor = ISO string ของ created_at ล่าสุดใน page ปัจจุบัน
 *   คืน { ids: string[], nextCursor: string|null, totalCount: number }
 */
async function paginateShadowConvIds(opts: {
  adminId?: string;
  deletedOnly?: boolean;
  cursor?: string;     // ISO date string — ดึงที่ created_at < cursor
  pageSize?: number;   // default 200
}): Promise<{ ids: string[]; nextCursor: string | null; totalCount: number }> {
  const srColl = await getCollection<{ conversation_id: string; origin?: string; generated_by?: string; created_at: Date; bot_reply_text?: string; deleted_at?: Date }>(COLLECTIONS.shadowReplies);

  const matchFilter: Record<string, unknown> = {
    origin: "manual_conversation",
    bot_reply_text: { $nin: ["", null] },
  };
  if (opts.deletedOnly) {
    matchFilter.deleted_at = { $exists: true };
  } else {
    matchFilter.deleted_at = { $exists: false };
  }
  if (opts.adminId) matchFilter.generated_by = opts.adminId;

  const pageSize = Math.min(opts.pageSize || 200, 500);

  // ⚡ count total distinct conversation_ids (สำหรับ totalCount)
  const totalCountArr = await srColl.aggregate<{ count: number }>([
    { $match: matchFilter },
    { $group: { _id: "$conversation_id" } },
    { $count: "count" },
  ]).toArray();
  const totalCount = totalCountArr[0]?.count || 0;

  // ⚡ paginate — group by conversation_id, sort by max(created_at) desc
  const pipeline: Record<string, unknown>[] = [
    { $match: matchFilter },
    {
      $group: {
        _id: "$conversation_id",
        latest: { $max: "$created_at" },
      },
    },
    { $sort: { latest: -1 } },
  ];

  // cursor filter — ดึงที่ latest < cursor
  if (opts.cursor) {
    pipeline.push({ $match: { latest: { $lt: new Date(opts.cursor) } } });
  }

  // limit pageSize + 1 (เพื่อเช็ค hasMore)
  pipeline.push({ $limit: pageSize + 1 });

  const grouped = await srColl.aggregate<{ _id: string; latest: Date }>(pipeline).toArray();

  const hasMore = grouped.length > pageSize;
  const pageRows = hasMore ? grouped.slice(0, pageSize) : grouped;
  const ids = pageRows.map((r) => r._id);
  const nextCursor = hasMore && pageRows.length > 0
    ? pageRows[pageRows.length - 1].latest.toISOString()
    : null;

  return { ids, nextCursor, totalCount };
}

/**
 * lookup conversations by ids + map เป็น Conversation shape
 */
async function lookupConversations(convIds: string[]): Promise<Conversation[]> {
  if (convIds.length === 0) return [];
  const convColl = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const docs = await convColl
    .find({ conversation_id: { $in: convIds } })
    .toArray();

  // dedupe by conversation_id
  const seen = new Set<string>();
  const deduped = docs.filter((d) => {
    if (seen.has(d.conversation_id)) return false;
    seen.add(d.conversation_id);
    return true;
  });

  // ⚡ Phase 2J — อ่าน status/assigned_to จาก test_status_conversation
  const convIdList = deduped.map((d) => d.conversation_id);
  const testMetaMap = await testStatusConversationService.getTestStatusMap(convIdList, "shadowbot");

  return deduped.map((doc) => {
    const testMeta = testMetaMap.get(doc.conversation_id);
    const effectiveAssignedTo = testMeta?.assigned_to || doc.assigned_to || null;
    let derivedStatus: Conversation["status"];
    if (testMeta?.status) {
      derivedStatus = testMeta.status as Conversation["status"];
    } else if (doc.closed_at) {
      derivedStatus = "closed";
    } else if (effectiveAssignedTo) {
      derivedStatus = "handoff";
    } else {
      derivedStatus = "bot";
    }
    return {
      id: doc.conversation_id,
      platform: doc.platform,
      shop_id: doc.shop_id,
      shop_name: doc.shop_name,
      customer_id: doc.customer_id,
      customer_name: doc.to_name,
      customer_avatar: doc.customer_avatar,
      item_ids: testMeta?.item_ids || doc.item_ids || [],
      status: derivedStatus,
      topic: ((testMeta?.topic as Conversation["topic"]) || (doc.topic as Conversation["topic"]) || "general"),
      last_message: doc.last_message_text,
      last_timestamp: doc.last_message_timestamp.toISOString(),
      unread: 0,
      assigned_to: effectiveAssignedTo || undefined,
      assigned_to_name: undefined,
    };
  });
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const deleted = url.searchParams.get("deleted") === "1";
  const cursor = url.searchParams.get("cursor") || undefined;
  const pageSizeParam = parseInt(url.searchParams.get("pageSize") || "200", 10);
  const pageSize = Math.min(Math.max(pageSizeParam, 1), 500);

  // ⚡ Phase 3A — visibility: admin ทั่วไปเห็นเฉพาะ conversation ที่ตัวเอง Generate ไว้
  // superadmin/dev เห็นทั้งหมด
  const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
  const adminId = isSuperadmin ? undefined : r.ctx.admin.admin_id;

  // ⚡ paginate — ดึง conversation_ids แบบหน้า ๆ
  const { ids, nextCursor, totalCount } = await paginateShadowConvIds({
    adminId,
    deletedOnly: deleted,
    cursor,
    pageSize,
  });

  // lookup conversations for this page only
  const conversations = await lookupConversations(ids);

  return json({ rows: conversations, nextCursor, totalCount });
}

// ⚡ Phase 3B-5 — DELETE /api/shadow-inbox/conversations?conversation_id=xxx
//   soft delete ทุก shadow replies ใน conversation นั้น (ใช้ใน history tab)
export async function DELETE(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id");
  if (!conversationId) return error("conversation_id required", 422);

  const result = await shadowReplyService.deleteByConversation(
    conversationId,
    r.ctx.admin.admin_id,
    "delete_from_history"
  );
  return json({ ok: true, soft_deleted_count: result.softDeletedCount });
}

// ⚡ PUT /api/shadow-inbox/conversations?conversation_id=xxx&action=restore
//   restore ทุก shadow replies ใน conversation นั้น (ใช้ใน trash tab — restore per conversation)
export async function PUT(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id");
  const action = url.searchParams.get("action");
  if (!conversationId) return error("conversation_id required", 422);
  if (action !== "restore") return error("use action=restore to restore a conversation", 422);

  const result = await shadowReplyService.restoreByConversation(conversationId);

  await logAdminEvent({
    action_type: "shadow_reply.restore_conversation",
    actor: r.ctx.admin.admin_id,
    conversation_id: conversationId,
    metadata: { restored_count: result.restoredCount },
  });

  return json({ ok: true, restored_count: result.restoredCount });
}
