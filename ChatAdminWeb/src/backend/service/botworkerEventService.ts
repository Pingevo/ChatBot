// botworkerEventService — event log ของ parallel sandbox (/botworker)
// ⚡ แยกจาก admin_logs — parallel run ไม่เขียน audit log จริงของ tickets
//   collection: botworker_events
//   key: event_id (gen) — query ด้วย conversation_id / type
import { getCollection, COLLECTIONS } from "../db/mongoClient";

export type BotworkerEventType =
  | "accept"          // แอดมินกดรับเรื่อง (self-assign)
  | "transfer"        // โยนงานให้แอดมินคนอื่น
  | "handoff"         // ส่งเข้า pool (round-robin)
  | "close"           // ปิดแชท
  | "reopen"          // เปิดแชทใหม่
  | "send"            // แอดมินตอบแชทใน sandbox
  | "bot_reply"       // บอทตอบ (shadow_replies)
  | "bot_handoff"     // บอท/Python handoff (trigger, empty answer, warranty claim)
  | "bot_error"       // บอทประมวลผลล้มเหลว
  | "workflow"        // workflow node side-effects (assign/label/close)
  | "backlog_assign"  // distributor จ่ายงานค้าง (per-ticket)
  | "backlog_commit"; // distributor commit batch (aggregate — ไม่ผูก conversation เดียว)

export interface BotworkerEventDoc {
  event_id: string;
  conversation_id?: string; // optional — events แบบ aggregate (เช่น backlog_commit) ไม่ผูก conversation เดียว
  type: BotworkerEventType;
  actor: string;              // admin_id | "bot-worker" | "workflow-engine" | "bot"
  shop_id?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
  created_at: Date;
}

function genEventId(): string {
  return "bwe_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** เขียน event ลง botworker_events — ไม่แตะ admin_logs จริง */
export async function logBotworkerEvent(opts: {
  conversation_id?: string;
  type: BotworkerEventType;
  actor: string;
  shop_id?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const coll = await getCollection<BotworkerEventDoc>(COLLECTIONS.botworkerEvents);
  const eventId = genEventId();
  await coll.insertOne({
    event_id: eventId,
    conversation_id: opts.conversation_id,
    type: opts.type,
    actor: opts.actor,
    shop_id: opts.shop_id,
    platform: opts.platform,
    metadata: opts.metadata,
    created_at: new Date(),
  });
  return eventId;
}

/** ดึง event ของ conversation (เก่า → ใหม่) — ใช้กับ ChatLogTab หน้า /botworker */
export async function listBotworkerEvents(
  conversationId: string,
  limit = 100
): Promise<BotworkerEventDoc[]> {
  const coll = await getCollection<BotworkerEventDoc>(COLLECTIONS.botworkerEvents);
  return coll
    .find({ conversation_id: conversationId })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray()
    .then((docs) => docs.reverse());
}

export const botworkerEventService = {
  logBotworkerEvent,
  listBotworkerEvents,
};
