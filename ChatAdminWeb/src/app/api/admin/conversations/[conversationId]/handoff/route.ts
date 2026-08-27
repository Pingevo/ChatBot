// POST /api/admin/conversations/:id/handoff — hand off conversation to admin pool
// ใช้ handoffService — จะ assign ให้ admin คนถัดไป (round-robin)
// ถ้า conversation ปิดอยู่ → reopen อัตโนมัติ + assign ใหม่
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { handoffService } from "@/backend/service/handoffService";
import { conversationService } from "@/backend/service/conversationService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const result = await handoffService.handoffToAdmin({
    conversationId,
    platform: conv.platform,
    shopId: conv.shop_id,
    reason: "manual handoff from admin UI",
  });

  invalidateConversationsCache();
  return json({ ok: true, ...result });
}
