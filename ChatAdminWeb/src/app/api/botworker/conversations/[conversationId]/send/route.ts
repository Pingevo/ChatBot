// POST /api/botworker/conversations/:id/send — แอดมินตอบแชทใน parallel sandbox
// body: { text, force? }
// → insert botworker_messages (role=admin) — ไม่ส่ง Shopee ไม่เขียน messages_shp
//   ข้อความนี้เข้า sandbox bot history (getGroupedHistoryForBot includeSandboxAdmin)
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { conversationService } from "@/backend/service/conversationService";
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { logBotworkerEvent } from "@/backend/service/botworkerEventService";
import { assertPlatformApiDisabled } from "@/backend/lib/safety";
import { BW_SOURCE, getBwMeta, invalidateBotworkerCache } from "../../../_shared";

function genBwMessageId(): string {
  return "bw_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{ text?: string; force?: boolean }>(req);
  if (!body || !body.text || !body.text.trim()) {
    return error("text is required", 422);
  }
  const text = body.text.trim();
  const force = body.force === true;

  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  // ⛔ Iron Rule guard — parallel ไม่ยิง platform API
  assertPlatformApiDisabled(conv.platform, "send");

  // conflict check เหมือน ticket send — assigned ให้คนอื่น → 409 (force ข้ามได้)
  const me = r.ctx.admin.admin_id;
  const meta = await getBwMeta(conversationId);
  const assignedToOther = meta?.assigned_to && meta.assigned_to !== me;
  if (assignedToOther && !force) {
    return json({
      ok: false,
      conflict: true,
      assigned_to: meta!.assigned_to,
      message: "conversation assigned to another admin",
    }, 409);
  }

  // ⚡ admin reply = claim — ตั้ง status=open + assigned_to=me → worker guard จะ skip แชทนี้
  // (บอทหยุดตอบจนกว่าจะ reopen/ปล่อยกลับ bot)
  if (meta?.assigned_to !== me) {
    await testStatusConversationService.manualTestAssign(conversationId, BW_SOURCE, me, meta?.assigned_to, "open");
  } else if (meta?.status !== "open") {
    await testStatusConversationService.updateTestStatus(conversationId, BW_SOURCE, "open");
  }

  const admin = r.ctx.admin;
  const coll = await getCollection(COLLECTIONS.botworkerMessages);
  const doc = {
    message_id: genBwMessageId(),
    conversation_id: conversationId,
    shop_id: conv.shop_id,
    platform: conv.platform,
    role: "admin" as const,
    actor: me,
    actor_name: admin.name || admin.username || me,
    bubble_color: admin.bubble_color,
    text,
    created_at: new Date(),
  };
  await coll.insertOne(doc);

  await logBotworkerEvent({
    conversation_id: conversationId,
    type: "send",
    actor: me,
    shop_id: conv.shop_id,
    platform: conv.platform,
    metadata: {
      message_id: doc.message_id,
      text_preview: text.slice(0, 100),
      forced_override: force && !!assignedToOther,
    },
  });

  await invalidateBotworkerCache();
  return json({
    ok: true,
    message: {
      id: doc.message_id,
      role: "admin",
      text: doc.text,
      timestamp: doc.created_at.toISOString(),
      source: COLLECTIONS.botworkerMessages,
      admin_id: me,
      admin_name: doc.actor_name,
      bubble_color: doc.bubble_color,
    },
  });
}
