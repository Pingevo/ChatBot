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
  simulate?: boolean; // ⚡ simulate mode — เก็บลง test_chat_sessions ไม่กระทบ conversations
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

  const { conversation_id, reason, claim, simulate } = body;

  // ⚡ Simulate mode — จำลองการจ่ายงานโดยไม่กระทบ conversations จริง
  // เก็บประวัติ assign ลง test_chat_sessions เท่านั้น
  if (simulate) {
    return await simulateHandoff(conversation_id, body.shop_id, body.platform, reason, claim);
  }

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

// ── Simulate handoff — จำลองการจ่ายงานโดยไม่กระทบ conversations จริง ──
// เก็บประวัติ assign ลง test_chat_sessions เท่านั้น
// ใช้ session_id ของ test chat เป็น conversation_id
async function simulateHandoff(
  sessionId: string,
  shopId?: string,
  platform?: string,
  reason?: string,
  claim?: BotHandoffBody["claim"]
) {
  const { ObjectId } = await import("mongodb");
  type TestChatSessionDoc = {
    _id: typeof ObjectId.prototype;
    assigned_to?: string | null;
    assigned_to_name?: string | null;
    assignment_reason?: string | null;
    assignment_history?: unknown[];
  };
  const adminDb = await getCollection<TestChatSessionDoc>("test_chat_sessions" as never);

  // หา admin ที่จะรับงาน — ใช้ logic เดียวกับ handoffService แต่ไม่เขียน conversations
  // Step 1: เช็ค assigned_to เดิมใน session
  const session = await adminDb.findOne({ _id: new ObjectId(sessionId) as never });
  let assignedTo: string | null = session?.assigned_to || null;
  let assignmentReason = "unknown";

  // Step 2: ถ้าไม่มี → round-robin (เรียก assignmentService แบบ dry-run)
  if (!assignedTo) {
    try {
      const { assignmentService } = await import("@/backend/service/assignmentService");
      const agentId = await assignmentService.autoAssignConversation({
        conversation_id: `sim_${sessionId}`, // ใช้ prefix sim_ เพื่อไม่ให้ชนกับของจริง
        shop_id: shopId || "",
        platform: platform || "shopee",
        assigned_to: null,
      });
      if (agentId) {
        assignedTo = agentId;
        assignmentReason = "round_robin: ไม่มี admin เดิม → จ่ายคิว (simulate)";
      }
    } catch (e) {
      console.error("[bot-handoff:simulate] autoAssign failed:", e);
    }
  } else {
    assignmentReason = "existing_assignment: มี admin ดูแลอยู่แล้ว (simulate)";
  }

  // ดึงชื่อ admin
  let assignedToName: string | null = null;
  if (assignedTo) {
    try {
      const adminColl = await getCollection<{ admin_id: string; name: string }>(COLLECTIONS.admins);
      const admin = await adminColl.findOne({ admin_id: assignedTo });
      assignedToName = admin?.name || null;
    } catch { /* ignore */ }
  }

  // บันทึกลง test_chat_sessions — เก็บ assigned_to + assignment_history
  const historyEntry = {
    assigned_to: assignedTo,
    assigned_to_name: assignedToName,
    reason: reason || "simulate handoff",
    assignment_reason: assignmentReason,
    timestamp: new Date(),
    claim: claim || null,
  };
  await adminDb.updateOne(
    { _id: new ObjectId(sessionId) as never },
    {
      $set: { assigned_to: assignedTo, assigned_to_name: assignedToName, assignment_reason: assignmentReason, updated_at: new Date() } as never,
      $push: { assignment_history: historyEntry } as never,
    }
  );

  await logAdminEvent({
    action_type: "conversation.handoff" as never,
    actor: "bot",
    conversation_id: sessionId,
    metadata: {
      assigned_to: assignedTo,
      assigned_to_name: assignedToName,
      reason,
      assignment_reason: assignmentReason,
      simulate: true,
      claim,
    },
  });

  console.log(`[bot-handoff:simulate] session=${sessionId} assigned_to=${assignedTo} (${assignedToName}) reason=${reason}`);

  return json({
    ok: true,
    simulate: true,
    assigned_to: assignedTo,
    assigned_to_name: assignedToName,
    reopened: false,
    assignment_reason: assignmentReason,
  });
}
