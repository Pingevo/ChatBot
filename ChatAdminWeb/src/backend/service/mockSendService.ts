// mockSendService — mock Shopee transport seam (provider="mock" เท่านั้น)
//
// ⛔ ไฟล์นี้ห้ามมี: Shopee URL, credential lookup, HTTP client, live flag —
//   เป็น seam สำหรับ adapter จริงในอนาคต (phase แยกอนุมัติ)
// Contract:
//   - 1 approved text bubble = 1 mock request; product card = typed part แยก
//   - request log = deterministic botworker_events doc (_id จาก caller)
//     → retry/crash-safe: unique insert เดิม = request เดิม ไม่ซ้ำ
//   - receipt { provider:"mock", delivered:false, request_id } เสมอ —
//     ไม่เคยอ้าง customer delivery
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { insertDeterministicEvent } from "./botworkerEventService";
import type { MockReceipt } from "./reviewService";

export async function sendMockPart(part: {
  eventId: string;             // deterministic _id — "mocksend:<replyId>:<bubbleId>:<part>"
  replyId: string;
  bubbleId: string;
  part: "text" | "product_card";
  text?: string;
  item_id?: string;
  conversationId: string;
  shopId: string;
  platform: string;
  actor: string;
  inboundMessageId?: string;
}): Promise<MockReceipt> {
  const inserted = await insertDeterministicEvent({
    _id: part.eventId,
    event_id: part.eventId,
    conversation_id: part.conversationId,
    type: "mock_send",
    actor: part.actor,
    shop_id: part.shopId,
    platform: part.platform,
    metadata: {
      reply_id: part.replyId,
      bubble_id: part.bubbleId,
      send_part: part.part,
      ...(part.part === "text" ? { text: part.text } : { item_id: part.item_id }),
      ...(part.inboundMessageId ? { reply_to_message_id: part.inboundMessageId } : {}),
      provider: "mock",
      delivered: false,
    },
    created_at: new Date(),
  });
  if (inserted === "exists") {
    // retry หลัง crash — อ่าน receipt เดิมกลับ ไม่สร้าง request ที่สอง
    // ⚡ ต้องตรวจ payload ด้วย — event id เดิมแต่เนื้อต่าง = bug/forgery ห้ามนิ่งผ่าน
    const existing = await getCollection<{ metadata?: { provider?: string; send_part?: string; text?: string; item_id?: string } }>(COLLECTIONS.botworkerEvents)
      .then((c) => c.findOne({ _id: part.eventId } as never));
    if (!existing) throw new Error("mock request log missing after E11000");
    const md = existing.metadata ?? {};
    const payloadMatches =
      md.provider === "mock" &&
      md.send_part === part.part &&
      (part.part === "text" ? md.text === part.text : md.item_id === part.item_id);
    if (!payloadMatches) throw new Error("mock event exists with different payload — refusing to reuse receipt");
  }
  return { provider: "mock", delivered: false, request_id: part.eventId };
}
