// scripts/verify-botworker-parallel.ts
//
// Integration verify สำหรับ botworker parallel sandbox — เขียน/ลบเฉพาะ docs ที่ขึ้นต้น __verify_
// ครอบคลุม: isolation จาก ticket จริง, pending_assignment, backlog plan/commit, history priority
//
// รัน: npx tsx scripts/verify-botworker-parallel.ts
//
// ⚠️ เขียน synthetic docs (conversation_id ขึ้นต้น __verify_) ลง test collections ชั่วคราวแล้วลบออก
//    ไม่แตะข้อมูลจริง — ถ้า script ตายกลางทาง ให้ลบ doc ที่ขึ้นต้น __verify_ เอง

import "dotenv/config";
import { MongoClient } from "mongodb";
import { testStatusConversationService } from "../src/backend/service/testStatusConversationService";
import { statusConversationService } from "../src/backend/service/statusConversationService";
import { handoffService } from "../src/backend/service/handoffService";
import { buildPlan, commitPlan, listPending } from "../src/backend/service/backlogService";
import { getGroupedHistoryForBot } from "../src/backend/service/messageService";

const PREFIX = "__verify_bw_";
const CONV = `${PREFIX}conv1`;
const CONV2 = `${PREFIX}conv2`;
const CONV_HIST = `${PREFIX}hist`;
const SHOP = "__verify_shop__";
const PLATFORM = "shopee";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

async function main() {
  const uri = process.env.ADMIN_MONGO_URI || "";
  if (!uri) throw new Error("ADMIN_MONGO_URI not set");
  const dbName = process.env.ADMIN_MONGO_DB || "chatbot_admin";
  const env = (k: string, d: string) => process.env[k] || d;
  const C = {
    statusConv: env("ADMIN_MONGO_COLLECTION_STATUS_CONVERSATION", "status_conversation"),
    testStatus: env("ADMIN_MONGO_COLLECTION_TEST_STATUS_CONVERSATION", "test_status_conversation"),
    conversations: env("ADMIN_MONGO_COLLECTION_CONVERSATIONS", "conversations"),
    messages: env("ADMIN_MONGO_COLLECTION_MESSAGES", "messages"),
    shadowReplies: env("ADMIN_MONGO_COLLECTION_SHADOW_REPLIES", "shadow_replies"),
    botworkerMessages: env("ADMIN_MONGO_COLLECTION_BOTWORKER_MESSAGES", "botworker_messages"),
    botworkerEvents: env("ADMIN_MONGO_COLLECTION_BOTWORKER_EVENTS", "botworker_events"),
    admins: env("ADMIN_MONGO_COLLECTION_ADMINS", "admins"),
    adminLogs: env("ADMIN_MONGO_COLLECTION_LOGS", "admin_logs"),
  };

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  // cleanup จากรอบก่อน (ถ้ามี)
  async function cleanup() {
    for (const c of [C.testStatus, C.statusConv, C.conversations, C.messages, C.shadowReplies, C.botworkerMessages, C.botworkerEvents]) {
      await db.collection(c).deleteMany({ conversation_id: { $regex: `^${PREFIX}` } }).catch(() => {});
    }
    await db.collection(C.botworkerEvents).deleteMany({ type: "backlog_commit", "metadata.idem_key": { $regex: `^${PREFIX}` } }).catch(() => {});
    await db.collection(C.adminLogs).deleteMany({ action_type: "backlog_commit", "metadata.idem_key": { $regex: `^${PREFIX}` } }).catch(() => {});
  }
  await cleanup();

  try {
    // หา admin จริง 1 คนใช้เป็น target
    const admin = await db.collection(C.admins).findOne({ role: "admin", active: { $ne: false } });
    if (!admin) throw new Error("no active admin found — cannot run assign tests");
    const adminId = admin.admin_id;
    console.log(`\nusing admin: ${adminId} (${admin.name || admin.username})`);

    // ── T1: manualTestAssign → test store เท่านั้น ─────────
    console.log("\n[T1] manualTestAssign → test store only");
    const ok = await testStatusConversationService.manualTestAssign(CONV, "botworker", adminId, null, "open");
    check("manualTestAssign returns true", ok === true);
    const meta = await testStatusConversationService.getTestStatus(CONV, "botworker");
    check("test doc assigned_to=admin + status=open", meta?.assigned_to === adminId && meta?.status === "open");
    const realDoc = await db.collection(C.statusConv).findOne({ conversation_id: CONV });
    check("status_conversation untouched (no doc)", !realDoc);
    const convDoc = await db.collection(C.conversations).findOne({ conversation_id: CONV });
    check("conversations untouched (no doc)", !convDoc);

    // ── T2: pending_assignment marker ──────────────────────
    console.log("\n[T2] pending_assignment marker (empty pool path)");
    await testStatusConversationService.setTestPendingAssignment(CONV2, "botworker", true, "no_available_admin");
    const meta2 = await testStatusConversationService.getTestStatus(CONV2, "botworker");
    check("pending_assignment=true + status=handoff + assigned_to=null",
      meta2?.pending_assignment === true && meta2?.status === "handoff" && !meta2?.assigned_to);
    const realDoc2 = await db.collection(C.statusConv).findOne({ conversation_id: CONV2 });
    check("status_conversation untouched", !realDoc2);

    // ── T3: backlog preview = no writes ────────────────────
    console.log("\n[T3] backlog preview does not write");
    const plan = await buildPlan({ source: "botworker", admin_ids: [adminId], mode: "round_robin_selected", limit: 10 });
    const stillPending = await testStatusConversationService.getTestStatus(CONV2, "botworker");
    check("preview returns plan for pending item", plan.assignments.some((a) => a.conversation_id === CONV2));
    check("preview left doc untouched (still pending)", stillPending?.pending_assignment === true && !stillPending?.assigned_to);

    // ── T4: backlog commit assigns + idempotent ────────────
    console.log("\n[T4] backlog commit assigns per selected pool");
    const res = await commitPlan(
      { source: "botworker", admin_ids: [adminId], mode: "round_robin_selected", limit: 10, idem_key: `${PREFIX}k1` },
      "verify-script"
    );
    check("commit applied >=1", res.applied >= 1, `applied=${res.applied}`);
    const afterCommit = await testStatusConversationService.getTestStatus(CONV2, "botworker");
    check("assigned_to=admin + status=open + pending cleared",
      afterCommit?.assigned_to === adminId && afterCommit?.status === "open" && afterCommit?.pending_assignment === false);
    const res2 = await commitPlan(
      { source: "botworker", admin_ids: [adminId], mode: "round_robin_selected", limit: 10, idem_key: `${PREFIX}k1` },
      "verify-script"
    );
    check("same idem_key → idempotent replay (no writes)", res2.idempotent_replay === true && res2.applied === 0);

    // ── T5: paused admin rejected from pool validation ─────
    console.log("\n[T5] pool validation");
    const { validateAdminPool } = await import("../src/backend/service/backlogService");
    const poolRes = await validateAdminPool([adminId, "__nonexistent__"]);
    check("valid admin passes", poolRes.ok.includes(adminId));
    check("nonexistent admin rejected", poolRes.rejected.some((r) => r.id === "__nonexistent__"));

    // ── T6: history priority (worker reply > admin sandbox > zaapi) ──
    console.log("\n[T6] getGroupedHistoryForBot priority");
    const now = Date.now();
    await db.collection(C.messages).insertMany([
      { message_id: `${PREFIX}u1`, conversation_id: CONV_HIST, platform: PLATFORM, role: "user", text: "คำถามทดสอบ", created_timestamp: new Date(now - 60000) },
      { message_id: `${PREFIX}z1`, conversation_id: CONV_HIST, platform: PLATFORM, role: "admin", direction: "out", text: "zaapi fallback reply", created_timestamp: new Date(now - 50000) },
      { message_id: `${PREFIX}u2`, conversation_id: CONV_HIST, platform: PLATFORM, role: "user", text: "คำถามที่สอง", created_timestamp: new Date(now - 40000) },
    ]);
    await db.collection(C.shadowReplies).insertMany([
      { conversation_id: CONV_HIST, platform: PLATFORM, inbound_message_id: `${PREFIX}u1`, bot_reply_text: "worker reply (should win)", origin: "worker", mode: "standalone", created_at: new Date(now - 55000) },
      { conversation_id: CONV_HIST, platform: PLATFORM, inbound_message_id: `${PREFIX}u2`, bot_reply_text: "shadowbot reply (must not leak)", origin: "manual", mode: "shadowbot", created_at: new Date(now - 35000) },
    ]);
    await db.collection(C.botworkerMessages).insertOne({
      message_id: `${PREFIX}bw1`, conversation_id: CONV_HIST, platform: PLATFORM, role: "admin",
      actor: adminId, actor_name: "VerifyAdmin", text: "admin sandbox reply", created_at: new Date(now - 30000),
    });

    const hist = await getGroupedHistoryForBot({ conversationId: CONV_HIST, platform: PLATFORM as never, includeSandboxAdmin: true });
    const modelTexts = hist.filter((h) => h.role === "model").map((h) => h.text);
    check("worker reply wins over zaapi for u1", modelTexts.includes("worker reply (should win)"), JSON.stringify(modelTexts));
    check("zaapi fallback used only when no worker reply", !modelTexts.includes("zaapi fallback reply") || modelTexts.indexOf("worker reply (should win)") >= 0);
    check("admin sandbox reply merged as model turn", modelTexts.includes("admin sandbox reply"));
    check("shadowbot/manual reply does NOT leak", !modelTexts.includes("shadowbot reply (must not leak)"));

    const histNoAdmin = await getGroupedHistoryForBot({ conversationId: CONV_HIST, platform: PLATFORM as never });
    check("without flag, admin sandbox reply absent", !histNoAdmin.some((h) => h.text === "admin sandbox reply"));

    // ── T7: handoffToAdminTest never writes real store ─────
    console.log("\n[T7] handoffToAdminTest isolation");
    await handoffService.handoffToAdminTest({
      conversationId: CONV, shopId: SHOP, platform: PLATFORM,
      reason: "verify", source: "botworker", assignedStatus: "open",
    });
    const realDoc3 = await db.collection(C.statusConv).findOne({ conversation_id: CONV });
    check("handoffToAdminTest did not touch status_conversation", !realDoc3);
    const metaAfter = await testStatusConversationService.getTestStatus(CONV, "botworker");
    check("test doc still consistent (assigned_to present — existing assignment kept)", !!metaAfter?.assigned_to);

    // ── listPending sanity ─────────────────────────────────
    console.log("\n[T8] listPending");
    const pend = await listPending("botworker", 50);
    check("no __verify_ docs remain pending (CONV2 committed)", !pend.some((p) => p.conversation_id === CONV2));

  } finally {
    await cleanup();
    await client.close();
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
