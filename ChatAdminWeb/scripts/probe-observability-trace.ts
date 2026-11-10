// probe-observability-trace.ts — R5 end-to-end trace: turn lifecycle จริงล่าสุด → ทุก stage ต้องมีร่องรอย
// read-only — print chain ว่า stage ไหน log ขาด
// รัน: npx tsx scripts/probe-observability-trace.ts
import "dotenv/config";
import { getCollection, COLLECTIONS } from "../src/backend/db/mongoClient";

async function main() {
  // 1) shadow reply ล่าสุด — turn ที่บอทตอบจริง
  const shadowColl = await getCollection("shadow_replies");
  const s = (await shadowColl.find({}, { sort: { created_at: -1 }, limit: 1 }).next()) as Record<string, unknown> | null;
  console.log("=== shadow_reply ล่าสุด ===");
  if (!s) { console.log("ไม่มี shadow doc"); process.exit(0); }
  console.log(`  id=${s.shadow_reply_id} origin=${s.origin} conv=${s.conversation_id} at=${s.created_at}`);
  console.log(`  bot_products=${Array.isArray(s.bot_products) ? `${s.bot_products.length} items` : "absent"} inbound_ids=${JSON.stringify(s.inbound_message_ids ?? "absent")}`);
  const convId = s.conversation_id as string;
  const reqId = s.request_id as string | undefined;

  // 2) inbound message ต้นทาง
  const msgs = await getCollection(COLLECTIONS.messages);
  const inbound = await msgs.find({ conversation_id: convId, direction: "in" }, { sort: { created_timestamp: -1 }, limit: 1 }).next();
  console.log(`  inbound msg: ${inbound ? `found ${(inbound as Record<string, unknown>).message_id}` : "MISSING"}`);

  // 3) processing/buffer events
  const events = await getCollection("botworker_events");
  console.log(`  botworker_events(conv): ${await events.countDocuments({ conversation_id: convId })}`);

  // 4) ai_usage correlation — enriched docs มี request_id/conv_id (schema เก่าไม่มี — prod ก่อน deploy)
  const usage = await getCollection("ai_usage");
  const byReq = reqId ? await usage.countDocuments({ request_id: reqId }) : 0;
  const byConv = await usage.countDocuments({ conv_id: convId });
  const enriched = await usage.countDocuments({ path: { $exists: true } });
  const total = await usage.estimatedDocumentCount();
  console.log(`  ai_usage: req match=${byReq} conv match=${byConv} | enriched=${enriched}/${total} (schema ใหม่เขียนหลัง bot restart)`);

  // 5) review lifecycle → admin_logs (field จริง: action_type/timestamp/metadata.shadow_reply_id)
  const logs = await getCollection("admin_logs");
  const shadowLogs = await logs.find({ "metadata.shadow_reply_id": s.shadow_reply_id }).toArray();
  console.log(`  admin_logs(reply): ${shadowLogs.length} actions=${JSON.stringify(shadowLogs.map((l) => (l as Record<string, unknown>).action_type))}`);
  const convLogs = await logs.countDocuments({ conversation_id: convId });
  console.log(`  admin_logs(conv): ${convLogs}`);

  // 6) delivery record (pilot = mock_sent delivered:false เสมอ)
  const mockSent = await getCollection("mock_sent");
  const sent = await mockSent.find({ shadow_reply_id: s.shadow_reply_id }).toArray();
  console.log(`  mock_sent: ${sent.length} delivered=${JSON.stringify(sent.map((d) => (d as Record<string, unknown>).delivered))}`);

  // 7) lifecycle reconcile — per-bubble: decided bubble ↔ review_op, mock_sent ↔ mock_send
  //   review lifecycle อยู่ใน botworker_events (ไม่ใช่ admin_logs): reviewService เป็นคนเขียน
  type Ev = { metadata?: { request?: { bubble_id?: string }; bubble_id?: string } };
  const bubbles = Array.isArray(s.review_bubbles)
    ? (s.review_bubbles as { bubble_id: string; decision?: string; delivery?: { state?: string } }[])
    : [];
  const ops = (await events.find({ type: "review_op", "metadata.request.reply_id": s.shadow_reply_id }).toArray()) as Ev[];
  const sends = (await events.find({ type: "mock_send", "metadata.reply_id": s.shadow_reply_id }).toArray()) as Ev[];
  const opBubbles = new Set(ops.map((e) => e.metadata?.request?.bubble_id).filter(Boolean));
  const sendBubbles = new Set(sends.map((e) => e.metadata?.bubble_id).filter(Boolean));
  let missingOp = 0, missingSend = 0;
  for (const b of bubbles) {
    if (b.decision && b.decision !== "pending" && !opBubbles.has(b.bubble_id)) missingOp++;
    if (b.delivery?.state === "mock_sent" && !sendBubbles.has(b.bubble_id)) missingSend++;
  }
  console.log(`  lifecycle reconcile: bubbles=${bubbles.length} review_op=${ops.length} mock_send=${sends.length}`);
  console.log(`    gaps: decided-no-op=${missingOp} mock_sent-no-event=${missingSend}`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
