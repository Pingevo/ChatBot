// GET /api/admin/conversations/:id — get one conversation
// ⚠️ อ่านอย่างเดียว — ไม่ mark read ไม่ยิง platform API
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { statusConversationService } from "@/backend/service/statusConversationService";
import type { Conversation } from "@/lib/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const doc = await conversationService.getConversation(conversationId);
  if (!doc) return error("conversation not found", 404);

  // ℹ️ Shared inbox model — admin ทุกคนเห็น conversation ได้
  // channels_access filter ทำที่ list route แล้ว

  // ownership/admin fields อ่านจาก meta เท่านั้น
  //   (raw doc เป็น display fields ของ dump เท่านั้น)
  const meta = await statusConversationService.getMeta(conversationId);

  const conv: Conversation = {
    id: doc.conversation_id,
    platform: doc.platform,
    shop_id: doc.shop_id,
    shop_name: doc.shop_name,
    customer_id: doc.customer_id,
    customer_name: doc.to_name,
    customer_avatar: doc.customer_avatar,
    item_ids: meta?.item_ids || doc.item_ids || [],
    status: (meta?.status as Conversation["status"]) || "bot",
    topic: ((meta?.topic as Conversation["topic"]) || (doc.topic as Conversation["topic"]) || "general"),
    last_message: doc.last_message_text,
    last_timestamp: doc.last_message_timestamp.toISOString(),
    unread: doc.unread_count,
    assigned_to: meta?.assigned_to || undefined,
  };

  return json(conv);
}
