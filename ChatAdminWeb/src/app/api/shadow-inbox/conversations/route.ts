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
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { Conversation } from "@/lib/types";
import type { ConversationDoc } from "@/backend/service/conversationService";

/**
 * ดึง conversation_ids ที่มี shadow_replies จากการ generate ทั้งแชท
 * (origin = "manual_conversation" — เกิดจากกด Generate ทั้งหมด หรือสคริปต์ generate-all-shadow)
 * ไม่รวม worker (auto-pipeline) และ manual (Generate เองทีละข้อความ)
 *
 * distinct — ใช้ index { conversation_id: 1, created_at: -1 }
 * แล้ว lookup conversations ที่ตรงกันเท่านั้น
 */
async function listShadowConversations(): Promise<Conversation[]> {
  const srColl = await getCollection<{ conversation_id: string; origin?: string }>(COLLECTIONS.shadowReplies);
  const convColl = await getCollection<ConversationDoc>(COLLECTIONS.conversations);

  // distinct — เฉพาะ origin=manual_conversation และ bot ตอบจริง (bot_reply_text ไม่ว่าง)
  // กรอง record ที่ bot ตอบว่าง/ไม่ได้ตอบออก เพื่อกัน conversation ที่ bot ไม่เคยตอบโผล่ใน History
  const convIds = await srColl.distinct("conversation_id", {
    origin: "manual_conversation",
    bot_reply_text: { $nin: ["", null] },
  });
  if (convIds.length === 0) return [];

  // lookup เฉพาะ conversations ที่มี shadow reply — ใช้ $in
  const docs = await convColl
    .find(
      { conversation_id: { $in: convIds as string[] } },
      { sort: { last_message_timestamp: -1 } }
    )
    .toArray();

  // map เป็น Conversation shape (เหมือน conversations/route.ts)
  // แต่ไม่คำนวณ unanswered (shadow history ไม่จำเป็นต้องรู้)
  return docs.map((doc) => {
    let derivedStatus: Conversation["status"];
    if (doc.closed_at) {
      derivedStatus = "closed";
    } else if (doc.assigned_to) {
      derivedStatus = "open";
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
      item_ids: doc.item_ids || [],
      status: derivedStatus,
      topic: (doc.topic as Conversation["topic"]) || "general",
      last_message: doc.last_message_text,
      last_timestamp: doc.last_message_timestamp.toISOString(),
      unread: 0, // shadow ไม่นับ unanswered — ไม่จำเป็น
      assigned_to: doc.assigned_to,
      assigned_to_name: undefined,
    };
  });
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const conversations = await listShadowConversations();
  return json(conversations);
}
