// GET /api/shadow-inbox/conversations — list conversations ที่มี shadow_replies เท่านั้น
//
// แก้ปัญหา: tab History ในหน้า shadow-inbox เคยโหลด /admin/conversations?limit=10000
// แล้ว filter ใน frontend → timeout 30s และโหลดไม่ครบ
//
// วิธีใหม่: distinct conversation_id จาก shadow_replies (มี index) →
// lookup เฉพาะ conversations ที่มี shadow reply จริง → คืนในรูปแบบ Conversation[]
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

/**
 * ดึง conversation_ids ที่มี shadow_replies จากการ generate ทั้งแชท
 * (origin = "manual_conversation" — เกิดจากกด Generate ทั้งหมด หรือสคริปต์ generate-all-shadow)
 * ไม่รวม worker (auto-pipeline) และ manual (Generate เองทีละข้อความ)
 *
 * distinct — ใช้ index { conversation_id: 1, created_at: -1 }
 * แล้ว lookup conversations ที่ตรงกันเท่านั้น
 */
async function listShadowConversations(adminId?: string): Promise<Conversation[]> {
  const srColl = await getCollection<{ conversation_id: string; origin?: string; generated_by?: string }>(COLLECTIONS.shadowReplies);
  const convColl = await getCollection<ConversationDoc>(COLLECTIONS.conversations);

  // distinct — เฉพาะ origin=manual_conversation และ bot ตอบจริง (bot_reply_text ไม่ว่าง)
  // กรอง record ที่ bot ตอบว่าง/ไม่ได้ตอบออก เพื่อกัน conversation ที่ bot ไม่เคยตอบโผล่ใน History
  // ⚡ Phase 3A — ถ้ามี adminId → กรองเฉพาะที่ admin คนนี้ Generate (visibility)
  // ⚡ Phase 3B-7 — กรอง shadow replies ที่ถูก soft delete ออก (กัน history โผล่ของที่ลบแล้ว)
  const distinctFilter: Record<string, unknown> = {
    origin: "manual_conversation",
    bot_reply_text: { $nin: ["", null] },
    deleted_at: { $exists: false },
  };
  if (adminId) distinctFilter.generated_by = adminId;
  const convIds = await srColl.distinct("conversation_id", distinctFilter);
  if (convIds.length === 0) return [];

  // lookup เฉพาะ conversations ที่มี shadow reply — ใช้ $in
  const docs = await convColl
    .find(
      { conversation_id: { $in: convIds as string[] } },
      { sort: { last_message_timestamp: -1 } }
    )
    .toArray();

  // ⚡ dedupe by conversation_id — DB อาจมี doc ซ้ำ (same conversation_id)
  const _seen = new Set<string>();
  const _deduped = docs.filter((d) => {
    if (_seen.has(d.conversation_id)) return false;
    _seen.add(d.conversation_id);
    return true;
  });

  // map เป็น Conversation shape (เหมือน conversations/route.ts)
  // แต่ไม่คำนวณ unanswered (shadow history ไม่จำเป็นต้องรู้)
  // ⚡ Phase 2J — อ่าน status/assigned_to จาก test_status_conversation (shadow = test)
  const _convIds = _deduped.map((d) => d.conversation_id);
  const _testMetaMap = await testStatusConversationService.getTestStatusMap(_convIds, "shadowbot");

  return _deduped.map((doc) => {
    const testMeta = _testMetaMap.get(doc.conversation_id);
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
      unread: 0, // shadow ไม่นับ unanswered — ไม่จำเป็น
      assigned_to: effectiveAssignedTo || undefined,
      assigned_to_name: undefined,
    };
  });
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  // ⚡ Phase 3A — visibility: admin ทั่วไปเห็นเฉพาะ conversation ที่ตัวเอง Generate ไว้
  // superadmin/dev เห็นทั้งหมด
  const isSuperadmin = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
  const conversations = await listShadowConversations(isSuperadmin ? undefined : r.ctx.admin.admin_id);
  return json(conversations);
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
