// scripts/reset-assignment-state.ts
//
// Assignment/chat-state reset หลังจบทดสอบ — ล้างเฉพาะ state การทำงาน
// (assign/reassign/handoff/close/reopen/backlog/topic/pin/accept sessions/cursors)
// ทั้ง ticket จริงและ sandbox — เพื่อกลับสภาพ "เหมือนไม่เคยมีการ assign/ปิดแชท"
//
// PRESERVE (ห้ามแตะ — replay/generate artifacts + ข้อมูลจริง):
//   - shadow_replies, test_assignment, test_chat_sessions, test_chat_ratings
//   - admin_logs ที่เป็น generate/replay/rating (shadow_reply.*, test_assignment.*,
//     test_chat.rate, live_assignment.batch_replay, live_assignment.admin_reply)
//   - messages_shp (ข้อความลูกค้าจริง), master data (shops/workflows/triggers/products)
//
// ⚠️ SAFETY:
//   - default = dry-run (ไม่เขียน DB)
//   - reset จริงต้องใส่ --confirm --phrase=RESET_ASSIGNMENT_STATE
//   - backup docs ที่จะเปลี่ยนไป exports/maintenance/reset-assignment-<ts>/ ก่อนเสมอ
//   - ควรหยุด bot-worker ก่อนรัน reset จริง (กัน in-flight state เขียนซ้ำระหว่าง reset)
//
// วิธีรัน:
//   npx tsx scripts/reset-assignment-state.ts                                  # dry-run
//   npx tsx scripts/reset-assignment-state.ts --confirm --phrase=RESET_ASSIGNMENT_STATE
//
// ตัวเลือก:
//   --confirm                        ต้องใส่คู่กับ --phrase ถึงจะเขียนจริง
//   --phrase=RESET_ASSIGNMENT_STATE  confirm phrase (บังคับตรงตัว)
//   --accepting=keep|all-on|all-off  baseline is_accepting_chats ของ admins (default: keep)
//   --accept-sessions-hard           ลบ history chat_accept_sessions ทั้งหมด (default: แค่ปิด open sessions)
//   --no-backup                      ข้าม backup (อันตราย — ใช้เฉพาะตอนเทส script เอง)

import "dotenv/config";
import { MongoClient, type Db } from "mongodb";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const phrase = args.find((a) => a.startsWith("--phrase="))?.split("=")[1];
const acceptingMode = (args.find((a) => a.startsWith("--accepting="))?.split("=")[1] || "keep") as
  | "keep" | "all-on" | "all-off";
const acceptSessionsHard = args.includes("--accept-sessions-hard");
const noBackup = args.includes("--no-backup");
const DRY_RUN = !(confirmed && phrase === "RESET_ASSIGNMENT_STATE");

const CONFIRM_PHRASE = "RESET_ASSIGNMENT_STATE";

// admin_logs action_type ที่เป็น assignment/chat-state เท่านั้น
// PRESERVE: shadow_reply.*/test_assignment.*/test_chat.rate/live_assignment.batch_replay/
//   live_assignment.admin_reply = replay/generate/rating history — ห้ามลบ
// (ไม่รวม assignment.mode_change/shop_team_*/platform_team_* — audit ของ config ไม่ใช่ conversation state)
const ADMIN_LOG_SCOPE = [
  "chat_assigned",
  "chat_reassigned",
  "conversation.handoff",
  "conversation.status_change",
  "conversation.open",
  "conversation.close",
  "conversation.resolve",
  "conversation.set_topic",
  "conversation.set_item_ids",
  "conversation.pin",
  "conversation.unpin",
  "bot.handoff_to_admin",
  "agent.pause",
  "agent.resume",
  "agent_auto_paused",
  "chat_accept.start",
  "chat_accept.stop",
  "live_assignment.close_chat",
  "live_assignment.reopen_process",
  "backlog_commit",
];
const ADMIN_LOG_FILTER = { action_type: { $in: ADMIN_LOG_SCOPE } };

// workflow_runs scope: runs ที่ยัง active ทุกสถานะ + runs ที่เกิดจาก test/botworker
const WORKFLOW_RUN_FILTER = {
  $or: [
    { status: { $in: ["running", "waiting_for_reply", "waiting", "active", "paused"] } },
    { test_source: { $exists: true } },
  ],
};

// fields ที่ unset ใน status_conversation (ticket จริง) — ตาม plan Part H ข้อ 3
// + admin-owned state (topic/item_ids/pinned) เพื่อให้เหมือนไม่เคยทดลองจริง
const STATUS_UNSET = {
  assigned_to: "", assigned_at: "", assignment_mode_used: "", assignment_reason: "",
  status: "", closed_at: "", closed_by: "", close_count: "", close_history: "",
  pending_assignment: "",
  topic: "", item_ids: "", pinned: "",
};
// fields ที่ unset ใน conversations — bot handoff/claim + legacy assignment residue
//   (assigned_to/assigned_at/assigned_to_name/assignment_reason/status คือ admin action residue
//    ที่ probe พบเป็น admin_temp_* + status:"handoff" — ไม่ใช่ master field ของ sellcenter)
//   ⚠️ unset "status" เฉพาะ docs ที่มี assignment residue เท่านั้น (filter ไม่รวม status-only docs
//      เพราะ status บน conversations_shp อาจเป็น master field จาก dump — ยังไม่ชัด)
const CONV_UNSET = {
  bot_claim_info: "", bot_handoff_at: "", bot_handoff_reason: "",
  assigned_to: "", assigned_at: "", assigned_to_name: "", assignment_reason: "",
  status: "",
};
const CONV_UNSET_FILTER = {
  $or: [
    { bot_claim_info: { $exists: true } },
    { bot_handoff_at: { $exists: true } },
    { bot_handoff_reason: { $exists: true } },
    { assigned_to: { $exists: true } },
    { assigned_at: { $exists: true } },
    { assigned_to_name: { $exists: true } },
    { assignment_reason: { $exists: true } },
  ],
};

// test_assignment state fields ที่ unset (preserve qa/messages/bot_reply/ratings/replay metadata)
//   — docs ถูกเก็บไว้ทั้งหมด เคลียร์เฉพาะ admin action state ที่ restore ดึงกลับมา
const TEST_ASSIGN_UNSET = {
  assigned_to: "", assigned_at: "", assigned_to_name: "",
  mock_status: "",
  closed_at: "", closed_by: "", close_count: "",
  close_reason: "", close_category: "", close_resolution: "", close_note: "",
  reopened: "", reopened_at: "", reopened_by: "", reopen_reason: "",
  stopped_at_handoff: "", pending_assignment: "",
};
const TEST_ASSIGN_FILTER = {
  $or: Object.keys(TEST_ASSIGN_UNSET).map((f) => ({ [f]: { $exists: true } })),
};
// status_conversation docs ที่มี state ต้อง reset (ครอบทุก field ใน STATUS_UNSET)
const STATUS_FILTER = {
  $or: Object.keys(STATUS_UNSET).map((f) => ({ [f]: { $exists: true } })),
};

interface CountReport { coll: string; action: string; matched: number }

async function count(db: Db, coll: string, filter: object): Promise<number> {
  try {
    return await db.collection(coll).countDocuments(filter);
  } catch {
    return 0; // collection ไม่มี → ข้าม
  }
}

async function backupColl(db: Db, dir: string, coll: string, filter: object, suffix = ""): Promise<number> {
  const docs = await db.collection(coll).find(filter).toArray();
  if (docs.length === 0) return 0;
  writeFileSync(join(dir, `${coll}${suffix}.json`), JSON.stringify(docs, null, 2));
  return docs.length;
}

async function main() {
  const uri = process.env.ADMIN_MONGO_URI || "";
  if (!uri) throw new Error("ADMIN_MONGO_URI not set");
  const dbName = process.env.ADMIN_MONGO_DB || "chatbot_admin";

  const env = (k: string, d: string) => process.env[k] || d;
  const C = {
    statusConversation: env("ADMIN_MONGO_COLLECTION_STATUS_CONVERSATION", "status_conversation"),
    testStatusConversation: env("ADMIN_MONGO_COLLECTION_TEST_STATUS_CONVERSATION", "test_status_conversation"),
    conversations: env("ADMIN_MONGO_COLLECTION_CONVERSATIONS", "conversations"),
    assignmentCursors: env("ADMIN_MONGO_COLLECTION_ASSIGNMENT_CURSORS", "assignment_cursors"),
    chatAcceptSessions: env("ADMIN_MONGO_COLLECTION_CHAT_ACCEPT_SESSIONS", "chat_accept_sessions"),
    closeHistory: env("ADMIN_MONGO_COLLECTION_CLOSE_HISTORY", "close_history"),
    admins: env("ADMIN_MONGO_COLLECTION_ADMINS", "admins"),
    adminLogs: env("ADMIN_MONGO_COLLECTION_LOGS", "admin_logs"),
    shadowReplies: env("ADMIN_MONGO_COLLECTION_SHADOW_REPLIES", "shadow_replies"),
    testChatSessions: env("ADMIN_MONGO_COLLECTION_TEST_CHAT_SESSIONS", "test_chat_sessions"),
    testChatRatings: env("ADMIN_MONGO_COLLECTION_TEST_CHAT_RATINGS", "test_chat_ratings"),
    testAssignment: env("ADMIN_MONGO_COLLECTION_TEST_ASSIGNMENT", "test_assignment"),
    workflowRuns: env("ADMIN_MONGO_COLLECTION_WORKFLOW_RUNS", "workflow_runs"),
    botworkerMessages: env("ADMIN_MONGO_COLLECTION_BOTWORKER_MESSAGES", "botworker_messages"),
    botworkerEvents: env("ADMIN_MONGO_COLLECTION_BOTWORKER_EVENTS", "botworker_events"),
    chatProcessing: env("ADMIN_MONGO_COLLECTION_CHAT_PROCESSING", "chat_processing"),
    bufferMessages: env("ADMIN_MONGO_COLLECTION_BUFFER_MESSAGES", "buffer_messages"),
  };

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  try {
    const report: CountReport[] = [];
    const p = async (coll: string, action: string, filter: object) =>
      report.push({ coll, action, matched: await count(db, coll, filter) });

    // ── Dry-run count (หรือ count ก่อน backup) ──────────────
    // เฉพาะ assignment/chat-state — replay/generate artifacts ไม่เข้า scope
    await p(C.statusConversation, "unset assign/close/admin fields", STATUS_FILTER);
    await p(C.conversations, "unset bot handoff + legacy assigned/status", CONV_UNSET_FILTER);
    await p(C.testAssignment, "unset state fields (preserve QA)", TEST_ASSIGN_FILTER);
    await p(C.assignmentCursors, "delete all cursors", {});
    await p(
      C.chatAcceptSessions,
      acceptSessionsHard ? "DELETE all sessions (hard)" : "close open sessions",
      acceptSessionsHard ? {} : { ended_at: { $exists: false } }
    );
    await p(C.testStatusConversation, "delete all test status docs", {});
    await p(C.workflowRuns, "delete active/test runs", WORKFLOW_RUN_FILTER);
    await p(C.botworkerMessages, "delete", {});
    await p(C.botworkerEvents, "delete", {});
    await p(C.chatProcessing, "delete runtime state", {});
    await p(C.bufferMessages, "delete runtime state", {});
    await p(C.adminLogs, "delete assignment/chat-state logs", ADMIN_LOG_FILTER);
    await p(C.closeHistory, "delete close_history docs", {});
    if (acceptingMode !== "keep") {
      await p(C.admins, `set is_accepting_chats=${acceptingMode === "all-on"}`, { role: "admin" });
    }

    // ── PRESERVE counts (read-only — แสดงว่า replay/generate artifacts จะถูกเก็บไว้) ──
    //   test_assignment อยู่ใน reset scope ด้วย (unset state fields) — แต่ docs เก็บครบ
    const preserved: [string, number][] = [
      [C.shadowReplies, await count(db, C.shadowReplies, {})],
      [C.testChatSessions, await count(db, C.testChatSessions, {})],
      [C.testChatRatings, await count(db, C.testChatRatings, {})],
    ];

    console.log(`\n=== ${DRY_RUN ? "DRY-RUN (ไม่เขียน DB)" : "RESET จริง"} — assignment/chat-state reset ===`);
    for (const r of report) console.log(`  ${r.coll.padEnd(28)} ${r.action.padEnd(40)} → ${r.matched} docs`);
    if (acceptingMode === "keep") console.log(`  ${C.admins.padEnd(28)} is_accepting_chats                        → keep (ไม่แตะ)`);
    console.log("\n  ── PRESERVE (replay/generate artifacts — เก็บไว้ทั้งหมด) ──");
    for (const [coll, n] of preserved) console.log(`  ${coll.padEnd(28)} ${"เก็บไว้ (ไม่แตะ)".padEnd(40)} → ${n} docs`);
    console.log("");

    if (DRY_RUN) {
      if (confirmed) console.log(`⚠️  --confirm ใส่มาแล้วแต่ phrase ไม่ตรง — ต้องเป็น --phrase=${CONFIRM_PHRASE}`);
      else console.log("ใส่ --confirm --phrase=RESET_ASSIGNMENT_STATE เพื่อรันจริง (backup ก่อนอัตโนมัติ)");
      return;
    }

    // ── Warnings ก่อน reset จริง ────────────────────────────
    console.log("⚠️  ควรหยุด bot-worker ก่อน reset จริง — ถ้า worker ยังรันอยู่ in-flight state อาจเขียนกลับระหว่าง reset");
    if (noBackup) {
      console.log("⚠️⚠️  --no-backup: จะลบ/แก้ state โดยไม่มี backup — ไม่มีทาง rollback!");
    }

    // ── Backup ก่อน reset ──────────────────────────────────
    if (!noBackup) {
      const dir = join(process.cwd(), "..", "exports", "maintenance", `reset-assignment-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(dir, { recursive: true });
      let total = 0;
      total += await backupColl(db, dir, C.statusConversation, STATUS_FILTER);
      total += await backupColl(db, dir, C.conversations, CONV_UNSET_FILTER, ".assignment_fields");
      total += await backupColl(db, dir, C.testAssignment, TEST_ASSIGN_FILTER, ".state_fields");
      total += await backupColl(db, dir, C.testStatusConversation, {});
      total += await backupColl(db, dir, C.assignmentCursors, {});
      total += await backupColl(db, dir, C.chatAcceptSessions, acceptSessionsHard ? {} : { ended_at: { $exists: false } });
      total += await backupColl(db, dir, C.adminLogs, ADMIN_LOG_FILTER);
      total += await backupColl(db, dir, C.closeHistory, {});
      total += await backupColl(db, dir, C.workflowRuns, WORKFLOW_RUN_FILTER);
      total += await backupColl(db, dir, C.botworkerMessages, {});
      total += await backupColl(db, dir, C.botworkerEvents, {});
      total += await backupColl(db, dir, C.chatProcessing, {});
      total += await backupColl(db, dir, C.bufferMessages, {});
      if (acceptingMode !== "keep") {
        total += await backupColl(db, dir, C.admins, { role: "admin" });
      }
      console.log(`✓ backup ${total} docs → ${dir}`);
    }

    // ── Reset จริง ─────────────────────────────────────────
    const now = new Date();
    await db.collection(C.statusConversation).updateMany(STATUS_FILTER, { $unset: STATUS_UNSET });
    await db.collection(C.conversations).updateMany(CONV_UNSET_FILTER, { $unset: CONV_UNSET });
    await db.collection(C.testAssignment).updateMany(TEST_ASSIGN_FILTER, { $unset: TEST_ASSIGN_UNSET });
    await db.collection(C.assignmentCursors).deleteMany({});
    if (acceptSessionsHard) {
      await db.collection(C.chatAcceptSessions).deleteMany({});
    } else {
      await db.collection(C.chatAcceptSessions).updateMany(
        { ended_at: { $exists: false } },
        { $set: { ended_at: now, end_reason: "reset-assignment-state" } }
      );
    }
    await db.collection(C.testStatusConversation).deleteMany({});
    await db.collection(C.workflowRuns).deleteMany(WORKFLOW_RUN_FILTER);
    await db.collection(C.botworkerMessages).deleteMany({});
    await db.collection(C.botworkerEvents).deleteMany({});
    await db.collection(C.chatProcessing).deleteMany({});
    await db.collection(C.bufferMessages).deleteMany({});
    await db.collection(C.adminLogs).deleteMany(ADMIN_LOG_FILTER);
    await db.collection(C.closeHistory).deleteMany({});
    if (acceptingMode !== "keep") {
      await db.collection(C.admins).updateMany({ role: "admin" }, { $set: { is_accepting_chats: acceptingMode === "all-on" } });
    }

    // ── Post-reset verification — เช็กเฉพาะ assignment/chat-state fields
    //   (preserved collections: shadow_replies/test_assignment/test_chat_*
    //    ไม่เช็ก=0 — นั่นคือสิ่งที่ตั้งใจเก็บไว้)
    const checks: [string, number][] = [
      ["statusConversation.assigned_to", await count(db, C.statusConversation, { assigned_to: { $exists: true, $ne: null } })],
      ["statusConversation.assigned_at", await count(db, C.statusConversation, { assigned_at: { $exists: true } })],
      ["statusConversation.assignment_reason", await count(db, C.statusConversation, { assignment_reason: { $exists: true } })],
      ["statusConversation.status", await count(db, C.statusConversation, { status: { $exists: true } })],
      ["statusConversation.closed_at", await count(db, C.statusConversation, { closed_at: { $exists: true } })],
      ["statusConversation.pending_assignment", await count(db, C.statusConversation, { pending_assignment: true })],
      ["statusConversation.close_history", await count(db, C.statusConversation, { close_history: { $exists: true } })],
      ["statusConversation.topic", await count(db, C.statusConversation, { topic: { $exists: true } })],
      ["statusConversation.item_ids", await count(db, C.statusConversation, { item_ids: { $exists: true } })],
      ["statusConversation.pinned", await count(db, C.statusConversation, { pinned: { $exists: true } })],
      ["conversations.assignment/handoff fields", await count(db, C.conversations, CONV_UNSET_FILTER)],
      ["testAssignment.assigned_to", await count(db, C.testAssignment, { assigned_to: { $exists: true } })],
      ["testAssignment.mock_status", await count(db, C.testAssignment, { mock_status: { $exists: true } })],
      ["testAssignment.stopped_at_handoff", await count(db, C.testAssignment, { stopped_at_handoff: { $exists: true } })],
      ["testAssignment.close state", await count(db, C.testAssignment, { $or: [{ closed_at: { $exists: true } }, { close_reason: { $exists: true } }] })],
      ["testStatusConversation docs", await count(db, C.testStatusConversation, {})],
      ["assignmentCursors docs", await count(db, C.assignmentCursors, {})],
      ["botworkerMessages docs", await count(db, C.botworkerMessages, {})],
      ["botworkerEvents docs", await count(db, C.botworkerEvents, {})],
      ["workflowRuns active/test", await count(db, C.workflowRuns, WORKFLOW_RUN_FILTER)],
      ["chatProcessing docs", await count(db, C.chatProcessing, {})],
      ["bufferMessages docs", await count(db, C.bufferMessages, {})],
      ["adminLogs scoped docs", await count(db, C.adminLogs, ADMIN_LOG_FILTER)],
      ["closeHistory docs", await count(db, C.closeHistory, {})],
      ["chatAcceptSessions open", await count(db, C.chatAcceptSessions, { ended_at: { $exists: false } })],
      ...(acceptSessionsHard
        ? [["chatAcceptSessions docs (hard)", await count(db, C.chatAcceptSessions, {})] as [string, number]]
        : []),
    ];
    console.log("\n=== post-reset verification ===");
    let dirty = false;
    for (const [label, v] of checks) {
      if (v > 0) dirty = true;
      console.log(`  ${v === 0 ? "✓" : "✗"} ${label}: ${v}`);
    }
    // preserved artifacts — docs ต้องยังอยู่ (unset เฉพาะ state fields, ไม่ลบ doc)
    const preservedDocs = await count(db, C.testAssignment, {});
    console.log(`\n  ℹ test_assignment docs preserved: ${preservedDocs} (QA/replay history คงอยู่)`);
    if (dirty) {
      console.log("\n⚠️ ยังมี state ค้าง — ตรวจรายการ ✗ ข้างบน");
      process.exitCode = 1;
    } else {
      console.log("\n✓ reset สมบูรณ์ — ไม่มี assignment/chat-state ค้าง (replay/generate artifacts ถูก preserve)");
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
