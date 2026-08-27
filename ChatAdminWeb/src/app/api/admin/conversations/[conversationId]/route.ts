// GET /api/admin/conversations/:id — get one conversation
// ⚠️ อ่านอย่างเดียว — ไม่ mark read ไม่ยิง platform API
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
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

  const conv: Conversation = {
    id: doc.conversation_id,
    platform: doc.platform,
    shop_id: doc.shop_id,
    shop_name: doc.shop_name,
    customer_id: doc.customer_id,
    customer_name: doc.to_name,
    customer_avatar: doc.customer_avatar,
    item_ids: doc.item_ids || [],
    status: doc.status,
    topic: (doc.topic as Conversation["topic"]) || "general",
    last_message: doc.last_message_text,
    last_timestamp: doc.last_message_timestamp.toISOString(),
    unread: doc.unread_count,
    assigned_to: doc.assigned_to,
  };

  return json(conv);
}
