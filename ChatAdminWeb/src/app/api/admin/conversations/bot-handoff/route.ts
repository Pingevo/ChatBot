// POST /api/admin/conversations/bot-handoff
// บอทเรียก endpoint นี้เมื่อถึงจุดส่งต่อแอดมิน (warranty claim flow)
// ทำ 3 อย่าง:
//   1. handoff conversation ให้แอดมิน (auto-assign round-robin)
//   2. บันทึก claim info ลง conversation metadata
//   3. log admin event
//
// ⚠️ ใช้ internal secret auth (X-Internal-Secret) ไม่ต้อง admin login
// เพราะบอทเป็น internal service ไม่ใช่ user
import { NextRequest } from "next/server";
import { json, error, readJson } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";
import { handoffService } from "@/backend/service/handoffService";
import { conversationService } from "@/backend/service/conversationService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

export const dynamic = "force-dynamic";

interface BotHandoffBody {
  conversation_id: string;
  shop_id?: string;
  platform?: string;
  reason?: string;
  claim?: {
    customer_name?: string;
    customer_phone?: string;
    order_id?: string;
    claim_topic?: string;
    product_name?: string;
    warranty_status?: "in_warranty" | "out_of_warranty";
    purchase_date?: string;
    warranty_months?: number;
    expiry_date?: string;
  };
}

export async function POST(req: NextRequest) {
  // Auth: internal secret (บอทเป็น internal service)
  const secret = req.headers.get("x-internal-secret");
  if (!secret || secret !== serverConfig.chatbotInternalSecret) {
    return error("unauthorized — internal secret required", 401);
  }

  const body = await readJson<BotHandoffBody>(req);
  if (!body || !body.conversation_id) {
    return error("conversation_id is required", 422);
  }

  const { conversation_id, reason, claim } = body;

  // ดึง conversation เพื่อหา shop_id/platform
  const conv = await conversationService.getConversation(conversation_id);
  if (!conv) {
    return error("conversation not found", 404);
  }

  // 1. Handoff ให้แอดมิน (assign คืน admin เดิมก่อน ถ้าไม่มี → round-robin)
  const result = await handoffService.handoffToAdmin({
    conversationId: conversation_id,
    shopId: conv.shop_id,
    platform: conv.platform,
    reason: reason || "warranty claim — bot handoff",
  });

  // 2. บันทึก claim info ลง conversation metadata
  if (claim && Object.keys(claim).length > 0) {
    try {
      const coll = await getCollection<{ conversation_id: string; bot_claim_info?: unknown }>(
        COLLECTIONS.conversations
      );
      await coll.updateOne(
        { conversation_id },
        {
          $set: {
            bot_claim_info: claim,
            bot_handoff_at: new Date(),
            bot_handoff_reason: reason || "warranty_claim",
          },
        }
      );
    } catch (e) {
      // ไม่ fatal — log แล้วทำต่อ
      console.error("[bot-handoff] failed to save claim info:", e);
    }
  }

  // 3. Log admin event
  await logAdminEvent({
    action_type: "conversation.handoff",
    actor: "bot",
    conversation_id,
    metadata: {
      assigned_to: result.assignedTo,
      assigned_to_name: result.assignedToName,
      reopened: result.reopened,
      reason,
      assignment_reason: result.assignmentReason,
      claim,
    },
  });

  invalidateConversationsCache();

  // 4. ส่งแจ้งเตือน (best-effort — ถ้ามี notification service)
  // TODO: เชื่อมกับ notification service (telegram/line/email) ถ้ามี
  // ตอนนี้ log ไว้ก่อน
  console.log(`[bot-handoff] conversation=${conversation_id} assigned_to=${result.assignedTo} (${result.assignedToName}) reason=${reason} assignment_reason=${result.assignmentReason}`);

  return json({
    ok: true,
    assigned_to: result.assignedTo,
    assigned_to_name: result.assignedToName,
    reopened: result.reopened,
    assignment_reason: result.assignmentReason,
  });
}
