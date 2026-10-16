// test-botworker-idempotency.ts — RED tests: botworker message idempotency
//
// รัน: npx tsx scripts/test-botworker-idempotency.ts
//
// ทุก test วิ่งบน fake Mongo ใน memory (mock ที่ module boundary — hooks.mjs)
// ไม่มี Mongo/LLM/network จริง
//
// ── Guarantee ที่ assert (finalized contract) ──
//   ✅ single concurrent owner     — claim/flush พร้อมกันมี owner เดียว (E11000 loser)
//   ✅ crash recovery              — lease หมดอายุ → reclaim claim เดิม (fencing++)
//   ✅ exactly-one persisted reply — reply persist idempotently ก่อน finalize claim
//   ❌ ไม่สัญญา exactly-once LLM/side-effect — crash หลัง remote รับ req ก่อน
//      outcome recorded → reclaimer อาจ re-execute ได้ (crash window เท่านั้น)
//
// ── ClaimContext ──
//   {claim_id, owner_id, fencing_token, lease_expires_at}
//   poll → buffer row → batch processor; core ที่รับ ctx ห้าม claim ซ้ำ
//   processMessage = thin wrapper: claim → processClaimedMessage(msg, ctx)
//
// ── Identity (canonical sha256, collision-safe) ──
//   claim    : chat_processing._id = "botworker:claim:<message_id>"
//   conv lock: buffer_messages._id = "botworker:convlock:" + sha256([platform,shop,conv])[:32]
//              field kind:"conv_lock" — buffer queries filter status:"buffered" เสมอ ไม่อ่านเป็น message
//   batch_id : "botworker:batch:" + sha256(JSON.stringify([platform,shop,conv,...sortedIds]))[:32]
//   reply    : shadow_replies._id  = "botworker:reply:<batch_id>"  (workflow: ":wf<i>")
//   fencing  : ทุก write/release หลัง claim filter {_id, owner_id, fencing_token}
//   claim doc: status, owner_id, fencing_token, lease_expires_at, attempt,
//              batch_id, outcome_type, reply_ids[], side_effects[], updated_at
//   timing   : botworkerRuntime constants (claimLeaseMs/heartbeatMs/botCallTimeoutMs/
//              ownerId/maxClaimAttempts) — module boundary ไม่ใช่ SystemConfig

import { register } from "node:module";
import { createHash } from "node:crypto";

// ⚡ ต้อง register ก่อน import service — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-botworker-idempotency-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-botworker-idempotency-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");
type Buf = typeof import("../src/backend/service/bufferService");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
let mocks: Mocks;
let svc: Svc;
let buf: Buf;
// ⚡ Phase 2D — required cycle-scope snapshot (fixtures: shop_1/s/s1 — shopee)
let SCOPE: import("../src/backend/service/botworkerRuntime").BotworkerCycleScope;

const CLAIM_ID = (mid: string) => `botworker:claim:${mid}`;
const CONV_LOCK_ID = (conv: string, platform = "shopee", shop = "shop_1") =>
  "botworker:convlock:" +
  createHash("sha256").update(JSON.stringify([platform, shop, conv])).digest("hex").slice(0, 32);
const BATCH_ID = (conv: string, ids: string[], platform = "shopee", shop = "shop_1") =>
  "botworker:batch:" +
  createHash("sha256").update(JSON.stringify([platform, shop, conv, ...[...ids].sort()])).digest("hex").slice(0, 32);
const REPLY_ID = (conv: string, ids: string[]) => `botworker:reply:${BATCH_ID(conv, ids)}`;
const WF_REPLY_ID = (conv: string, ids: string[], i: number) => `${REPLY_ID(conv, ids)}:wf${i}`;

const TERMINAL = new Set([
  "trigger_matched", "bot_answered", "handed_off", "bot_failed",
  "no_action", "workflow_actioned", "workflow_resumed",
]);

function seedInbound(messageId: string, conversationId: string, created = ++seq) {
  mocks.fakeColl("messages").push({
    message_id: messageId,
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform: "shopee",
    role: "user",
    direction: "in",
    type: "text",
    text: `inbound ${messageId}`,
    // ⚡ Date เสมอ — admission proof (msg_created_at > pair cutoff) ใช้ Date เปรียบเทียบ
    created_timestamp: new Date(created),
  });
}

function msgDoc(messageId: string, conversationId: string) {
  return {
    message_id: messageId,
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform: "shopee" as const,
    role: "user",
    direction: "in",
    type: "text",
    text: `inbound ${messageId}`,
    created_timestamp: 1,
  };
}

interface ClaimSeedOpts {
  expired?: boolean;
  owner?: string;
  batch?: string[];
  conv?: string;
  attempt?: number;
  outcome_type?: string;
  reply_ids?: string[];
  side_effects?: Record<string, unknown>[];
}

function claimDoc(messageId: string, opts: ClaimSeedOpts = {}) {
  const now = Date.now();
  const conv = opts.conv || "conv_1";
  const ids = opts.batch || [messageId];
  return {
    _id: CLAIM_ID(messageId),
    message_id: messageId,
    conversation_id: conv,
    shop_id: "shop_1",
    platform: "shopee",
    status: "processing",
    owner_id: opts.owner || "worker-A",
    fencing_token: opts.attempt || 1,
    attempt: opts.attempt || 1,
    claimed_at: new Date(now - 2000),
    lease_expires_at: new Date(now + (opts.expired ? -1000 : 3600000)),
    batch_id: BATCH_ID(conv, ids),
    ...(opts.outcome_type ? { outcome_type: opts.outcome_type } : {}),
    ...(opts.reply_ids ? { reply_ids: opts.reply_ids } : {}),
    ...(opts.side_effects ? { side_effects: opts.side_effects } : {}),
    updated_at: new Date(now - 2000),
  };
}

function convLockDoc(conv: string, opts: { expired?: boolean; owner?: string } = {}) {
  const now = Date.now();
  return {
    _id: CONV_LOCK_ID(conv),
    kind: "conv_lock",
    conversation_id: conv,
    shop_id: "shop_1",
    platform: "shopee",
    status: "locked",
    owner_id: opts.owner || "worker-A",
    fencing_token: 1,
    lease_expires_at: new Date(now + (opts.expired ? -1000 : 3600000)),
    updated_at: new Date(now - 2000),
  };
}

/** settle ทั้ง inFlight work, buffer flush timer และ bot call ที่ยังทำงาน */
async function settle(rounds = 40) {
  let quiet = 0;
  for (let i = 0; i < rounds; i++) {
    await svc.waitForInFlight(80).catch(() => {});
    await sleep(40);
    const buffered = mocks.fakeColl("buffer_messages").filter((d: any) => d.status === "buffered").length;
    if (buffered === 0 && mocks.state.calls.botInFlight === 0) {
      quiet++;
      if (quiet >= 2) return;
    } else {
      quiet = 0;
    }
  }
}

function claimDocs(messageId: string) {
  // claim records ใหม่ (deterministic _id) — ไม่นับ legacy ObjectId docs
  return mocks.fakeColl("chat_processing").filter((d: any) => d._id === CLAIM_ID(messageId));
}

function lockDocs(conv: string) {
  return mocks.fakeColl("buffer_messages").filter((d: any) => d._id === CONV_LOCK_ID(conv));
}

function repliesFor(...ids: string[]) {
  return mocks.fakeColl("shadow_replies").filter((d: any) => {
    const set: string[] = d.inbound_message_ids || (d.inbound_message_id ? [d.inbound_message_id] : []);
    return ids.every((id) => set.includes(id));
  });
}

const results: { name: string; ok: boolean; err?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  reset();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  } finally {
    // BW-2 — module-level timers (leadership heartbeat / debounce / retry /
    //   deferred recovery) ต้องไม่รั่วข้าม test — clearPendingWork คือ lifecycle
    //   stop owner เดียว (ห้ามพึ่ง resetState เพื่อหยุด timer)
    svc.botWorkerService.clearPendingWork();
  }
}

function reset() {
  mocks.resetState();
  // หยุด lifecycle ของ test ก่อนหน้าที่อาจค้าง timer ไว้ (pre-clean, idempotent)
  svc.botWorkerService.clearPendingWork();
  mocks.state.config.bot_worker_enabled = true;
  mocks.state.config.bot_buffer_enabled = false;
  mocks.state.config.bot_buffer_window_ms = 60;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  mocks = await import("./test-botworker-idempotency-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  buf = await import("../src/backend/service/bufferService");
  SCOPE = {
    config: mocks.state.config as never,
    global_enabled_since: new Date(0),
    pairs: [
      { platform: "shopee", shop_id: "shop_1", cutoff: new Date(0) },
      { platform: "shopee", shop_id: "s", cutoff: new Date(0) },
      { platform: "shopee", shop_id: "s1", cutoff: new Date(0) },
    ],
  };
  const { state } = mocks;
  const runtime = mocks.botworkerRuntime;

  // ── A. polling / claim idempotency ─────────────────────────

  await test("A1 re-poll x100 while processing → single owner, one reply", async () => {
    state.callBotDelayMs = 200;
    seedInbound("m1", "conv_1");

    await svc.pollNewMessages(SCOPE);
    for (let i = 0; i < 99; i++) {
      await svc.pollNewMessages(SCOPE);
      await sleep(1);
    }
    await settle();

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
    assert(repliesFor("m1").length === 1, `replies(m1)=${repliesFor("m1").length} want 1`);
    const claims = claimDocs("m1");
    assert(claims.length === 1, `claim docs for m1=${claims.length} want 1 (deterministic _id claim)`);
    assert(TERMINAL.has(claims[0].status), `claim must be terminal, got ${claims[0].status}`);
    assert(claims[0].outcome_type === "bot_answered", `outcome_type=${claims[0].outcome_type} want bot_answered`);
    assert(Array.isArray(claims[0].reply_ids) && claims[0].reply_ids.length === 1, `reply_ids=${JSON.stringify(claims[0].reply_ids)} want [1 id]`);
  });

  await test("A2 buffered flush + slow bot → batch ownership, no re-buffer", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 40;
    state.callBotDelayMs = 150;
    seedInbound("m2", "conv_1");

    await svc.pollNewMessages(SCOPE);
    await sleep(70); // flush เริ่มแล้ว — claim ของ m2 ยัง processing
    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
    assert(repliesFor("m2").length === 1, `replies(m2)=${repliesFor("m2").length} want 1`);
    const claims = claimDocs("m2");
    assert(claims.length === 1 && TERMINAL.has(claims[0].status), `m2 claim terminal=${claims.map((d: any) => d.status)}`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.status === "buffered").length === 0,
      `buffer rows must be completed after finalize, left=${mocks.fakeColl("buffer_messages").length}`);
  });

  await test("A3 buffer off → duplicate poll still single owner", async () => {
    state.callBotDelayMs = 150;
    seedInbound("m3", "conv_1");

    await svc.pollNewMessages(SCOPE);
    await sleep(30);
    await svc.pollNewMessages(SCOPE);
    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
    assert(claimDocs("m3").length === 1, `claim docs=${claimDocs("m3").length} want 1`);
  });

  await test("A4 multi-message batch → one reply, every member claim terminal", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 40;
    state.callBotDelayMs = 150;
    seedInbound("m4a", "conv_2", 10);
    seedInbound("m4b", "conv_2", 20);
    seedInbound("m4c", "conv_2", 30);

    await svc.pollNewMessages(SCOPE);
    await sleep(70);
    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 batch reply`);
    for (const id of ["m4a", "m4b", "m4c"]) {
      const claims = claimDocs(id);
      assert(claims.length === 1 && TERMINAL.has(claims[0].status), `${id}: claim terminal=${claims.map((d: any) => d.status)}`);
      assert(claims[0].batch_id === BATCH_ID("conv_2", ["m4a", "m4b", "m4c"]), `${id} batch_id must equal canonical batch id`);
    }
    assert(repliesFor("m4a", "m4b", "m4c").length === 1, `batch reply=${repliesFor("m4a", "m4b", "m4c").length} want 1`);
    assert(state.calls.shadowReply === 1, `shadowReply inserts=${state.calls.shadowReply} want 1`);
  });

  await test("A5 concurrent claim → E11000 loser, single owner", async () => {
    state.callBotDelayMs = 100;
    const m1 = msgDoc("m5", "conv_1");
    const m2 = msgDoc("m5", "conv_1");

    const [r1, r2] = await Promise.all([svc.processMessage(m1), svc.processMessage(m2)]);

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — both proceeded (no deterministic-_id claim/E11000)`);
    const answered = [r1.status, r2.status].filter((s) => s === "bot_answered").length;
    assert(answered === 1, `bot_answered=${answered} want 1 — loser must skip before LLM (got ${r1.status}/${r2.status})`);
    assert(claimDocs("m5").length === 1, `claim docs=${claimDocs("m5").length} want 1`);
  });

  // ── B. conversation-level batch lock (finding 1+3) ────────

  // B1. flush พร้อมกัน — conv lock (E11000) ให้ owner เดียว
  //     rows ที่ถูก preclaim ต้องถูก process โดย flusher ที่ชนะ lock เท่านั้น
  await test("B1 concurrent flush same conversation → single batch owner", async () => {
    state.callBotDelayMs = 100;
    for (const id of ["f1a", "f1b"]) {
      // claim ถูกสร้างตอนเข้า buffer แล้ว (owner = worker นี้ — flusher ที่ชนะ lock re-fence)
      mocks.fakeColl("chat_processing").push(claimDoc(id, { conv: "conv_f", batch: ["f1a", "f1b"], owner: runtime.ownerId }));
      // ⚡ row เก็บ expected claim owner/token — re-fence filter ใช้คู่นี้ + expired lease เท่านั้น
      mocks.fakeColl("buffer_messages").push({
        message_id: id, conversation_id: "conv_f", shop_id: "shop_1", platform: "shopee",
        text: `msg ${id}`, status: "buffered", received_at: new Date(), kind: "message",
        msg_created_at: new Date(), admitted_edge: new Date(0),
        claim_id: CLAIM_ID(id), owner_id: runtime.ownerId, fencing_token: 1,
      });
    }

    const markStub = async () => {};
    const [r1, r2] = await Promise.all([
      buf.flushBuffer("shopee", "shop_1", "conv_f", svc.processMessage, markStub),
      buf.flushBuffer("shopee", "shop_1", "conv_f", svc.processMessage, markStub),
    ]);

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — conv-level lock must allow one flusher (${r1.status}/${r2.status})`);
    assert(repliesFor("f1a", "f1b").length === 1, `batch reply=${repliesFor("f1a", "f1b").length} want 1`);
    // loser flush ต้องแพ้ — ไม่ใช่ทั้งคู่ buffer_flushed
    const flushed = [r1.status, r2.status].filter((s) => s === "buffer_flushed").length;
    assert(flushed === 1, `buffer_flushed=${flushed} want 1 — loser must lose the lock`);
  });

  // B2. lock lifecycle — acquire/release/reclaim/stale-release
  await test("B2 conv lock lifecycle — acquire, release, expired reclaim, stale fenced", async () => {
    const lockId = CONV_LOCK_ID("conv_l");
    const coll = await mocks.getCollection("buffer_messages");

    // acquire + release success (round-trip ผ่าน contract filter เดียวกัน)
    await coll.insertOne(convLockDoc("conv_l"));
    const dup = await coll.insertOne(convLockDoc("conv_l")).then(() => "ok").catch((e) => e.code);
    assert(dup === 11000, `second acquire on same _id must E11000, got ${dup}`);

    const released = await coll.updateOne(
      { _id: lockId, owner_id: "worker-A", fencing_token: 1 },
      { $set: { status: "released" } }
    );
    assert(released.matchedCount === 1, `release by owner must match, got ${released.matchedCount}`);

    // stale owner release must NOT match (fencing filter)
    await coll.insertOne({ ...convLockDoc("conv_l2"), owner_id: "worker-B", fencing_token: 5 });
    const stale = await coll.updateOne(
      { _id: CONV_LOCK_ID("conv_l2"), owner_id: "worker-A", fencing_token: 1 },
      { $set: { status: "released" } }
    );
    assert(stale.matchedCount === 0, `stale owner release matched=${stale.matchedCount} want 0`);

    // expired reclaim → update doc เดิม owner/fencing ใหม่
    const reclaimed = await coll.updateOne(
      { _id: CONV_LOCK_ID("conv_l2"), status: "locked", lease_expires_at: { $lt: new Date() } },
      { $set: { owner_id: "worker-B2", lease_expires_at: new Date(Date.now() + 60000) }, $inc: { fencing_token: 1 } }
    );
    // seed ใส่ lease ยังไม่หมด → stale reclaim ต้องไม่ match
    assert(reclaimed.matchedCount === 0, `reclaim of active lease matched=${reclaimed.matchedCount} want 0`);
    await coll.updateOne({ _id: CONV_LOCK_ID("conv_l2") }, { $set: { lease_expires_at: new Date(Date.now() - 1000) } });
    const reclaimed2 = await coll.updateOne(
      { _id: CONV_LOCK_ID("conv_l2"), status: "locked", lease_expires_at: { $lt: new Date() } },
      { $set: { owner_id: "worker-B2", lease_expires_at: new Date(Date.now() + 60000) }, $inc: { fencing_token: 1 } }
    );
    assert(reclaimed2.matchedCount === 1, `expired lock reclaim matched=${reclaimed2.matchedCount} want 1`);
  });

  // B3. buffer query ห้ามอ่าน lock doc เป็น message
  await test("B3 lock doc never read as buffer message (kind/status separation)", async () => {
    mocks.fakeColl("buffer_messages").push(convLockDoc("conv_x"));
    mocks.fakeColl("buffer_messages").push({
      message_id: "bx1", conversation_id: "conv_x", shop_id: "shop_1", platform: "shopee",
      text: "real buffered", status: "buffered", received_at: new Date(),
      msg_created_at: new Date(), admitted_edge: new Date(0),
    });
    const coll = await mocks.getCollection("buffer_messages");
    const rows = await coll.find({ conversation_id: "conv_x", status: "buffered" }).toArray();
    assert(rows.length === 1 && rows[0].message_id === "bx1",
      `buffered query returned ${rows.length} rows — lock doc must not leak into message queries`);
  });

  // B4. ข้อความใหม่ระหว่าง batch ช้า → เข้า batch ถัดไป ไม่รวม batch เก่า
  await test("B4 new message during active batch → next batch, not merged", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 40;
    state.callBotDelayMs = 200;
    seedInbound("m10a", "conv_5", 10);

    await svc.pollNewMessages(SCOPE);
    await sleep(70);
    seedInbound("m10b", "conv_5", 11);
    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(repliesFor("m10a", "m10b").length === 0,
      `reply covering both m10a+m10b found — new msg merged into old batch`);
    assert(repliesFor("m10a").length === 1, `reply(m10a)=${repliesFor("m10a").length} want 1`);
    assert(repliesFor("m10b").length === 1, `reply(m10b)=${repliesFor("m10b").length} want 1`);
    assert(state.calls.callBot === 2, `callBot=${state.calls.callBot} want 2 (one per batch)`);
    for (const id of ["m10a", "m10b"]) {
      const claims = claimDocs(id);
      assert(claims.length === 1 && TERMINAL.has(claims[0].status), `${id} claim terminal`);
    }
  });

  // ── C. crash / lease / fencing recovery ────────────────────

  await test("C1 crash after reply persist → recovery finalizes without LLM", async () => {
    seedInbound("m6", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("m6", { expired: true }));
    mocks.fakeColl("shadow_replies").push({
      _id: REPLY_ID("conv_1", ["m6"]),
      shadow_reply_id: REPLY_ID("conv_1", ["m6"]),
      conversation_id: "conv_1",
      shop_id: "shop_1",
      platform: "shopee",
      inbound_message_id: "m6",
      inbound_message_ids: ["m6"],
      inbound_text: "inbound m6",
      bot_reply_text: "already persisted",
      created_at: new Date(),
    });

    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — reply already persisted, reclaim must finalize claim without re-calling LLM`);
    const claims = claimDocs("m6");
    assert(claims.length === 1 && TERMINAL.has(claims[0].status), `claim finalized=${claims.map((d: any) => d.status)} want terminal`);
    assert(repliesFor("m6").length === 1, `replies(m6)=${repliesFor("m6").length} want 1 — must reuse existing reply`);
  });

  // ⚡ Phase 2D — reconcile-only: expired lease settles dormant (provider=0),
  //   ไม่มี reclaim+re-execution — inbound ใหม่ distinct เท่านั้นที่ carry ต่อ
  await test("C2 stale direct-claim → no recover while active, dormant reconcile after expiry", async () => {
    seedInbound("m7", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("m7")); // lease active

    await svc.pollNewMessages(SCOPE);
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — active lease must not be reprocessed`);

    claimDocs("m7")[0].lease_expires_at = new Date(Date.now() - 1000);
    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — expired lease reconciles, never re-executes`);
    const claims = claimDocs("m7");
    assert(claims.length === 1, `claim docs=${claims.length} want 1 — settle must UPDATE same _id`);
    assert(claims[0].status === "bot_failed", `claim status=${claims[0].status} want bot_failed (dormant settle)`);
    assert(claims[0].error === "interrupted_before_durable_outcome", `error=${claims[0].error}`);
    assert(claims[0].attempt === 1 && claims[0].fencing_token === 1,
      `settle must not re-fence — attempt=${claims[0].attempt} fence=${claims[0].fencing_token}`);
    assert(claims[0].owner_id === "worker-A", `settle keeps last owner (no reclaim), got ${claims[0].owner_id}`);
  });

  await test("C3 expired claim settles dormant — stale foreign-owner write matches nothing", async () => {
    seedInbound("m8", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("m8", { expired: true }));

    await svc.pollNewMessages(SCOPE);
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — reconcile-only`);
    assert(claimDocs("m8")[0].status === "bot_failed", `settled dormant, got ${claimDocs("m8")[0].status}`);

    // writer ที่คิดว่าตัวเอง reclaim ได้ (owner/token อื่น) → fenced out เสมอ
    const coll = await mocks.getCollection("chat_processing");
    const res = await coll.updateOne(
      { _id: CLAIM_ID("m8"), owner_id: "worker-B", fencing_token: 2 },
      { $set: { status: "bot_answered" } }
    );
    assert(res.matchedCount === 0, `stale finalize matched=${res.matchedCount} want 0 — terminal writes must filter _id+owner_id+fencing_token`);
  });

  // C4. LLM delay > lease → heartbeat ขยาย lease → ไม่มี reclaim กลางคัน
  //     timing ผ่าน botworkerRuntime boundary (constants — ไม่ใช่ SystemConfig/processMessage opts)
  await test("C4 long LLM + heartbeat → lease extended, no mid-flight reclaim", async () => {
    runtime.claimLeaseMs = 120;
    runtime.heartbeatMs = 30;
    state.callBotDelayMs = 350;
    seedInbound("m9", "conv_1");

    const running = svc.processMessage(msgDoc("m9", "conv_1"));
    await sleep(200);                        // เกิน lease แรก — heartbeat ต้องขยาย
    const reclaim = await svc.processMessage(msgDoc("m9", "conv_1"));
    await running;

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — heartbeat must extend lease while bot call in flight`);
    const claim = claimDocs("m9")[0];
    assert(claim && TERMINAL.has(claim.status), `claim terminal, got ${claim?.status}`);
    assert(claim.attempt === 1, `attempt=${claim?.attempt} want 1 — must not have been reclaimed mid-flight (reclaim.status=${reclaim.status})`);
  });

  // C5. attempt cap → bot_failed terminal (ไม่วน reclaim ไม่สิ้นสุด)
  await test("C5 attempt cap reached → bot_failed terminal, no more reclaim", async () => {
    seedInbound("m10", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("m10", { expired: true, attempt: runtime.maxClaimAttempts }));

    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — attempt cap reached`);
    const claims = claimDocs("m10");
    assert(claims.length === 1 && claims[0].status === "bot_failed",
      `claim status=${claims[0]?.status} want bot_failed (attempts exhausted)`);

    // terminal → ห้าม recover อีก
    await svc.pollNewMessages(SCOPE);
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — terminal must never refire`);
  });

  // C6. bot HTTP timeout → AbortSignal ตัด call → bot_failed terminal
  //     + heartbeat ต้อง cleanup (lease ไม่ถูก extend หลังตาย)
  await test("C6 bot call timeout → AbortError → bot_failed + heartbeat cleaned", async () => {
    runtime.botCallTimeoutMs = 50;
    runtime.heartbeatMs = 20;
    runtime.claimLeaseMs = 500;
    state.callBotHang = true;
    seedInbound("m11", "conv_1");

    await svc.pollNewMessages(SCOPE);
    await settle();

    const claims = claimDocs("m11");
    assert(claims.length === 1, `claim docs=${claims.length} want 1`);
    assert(claims[0].status === "bot_failed", `status=${claims[0].status} want bot_failed after timeout`);
    assert(/timeout|abort/i.test(claims[0].error || ""), `error=${claims[0].error} want timeout/abort`);

    // heartbeat cleanup — lease_expires_at ต้องไม่ถูก extend หลัง settle
    const l1 = claims[0].lease_expires_at;
    await sleep(60); // > heartbeatMs
    const l2 = claimDocs("m11")[0].lease_expires_at;
    assert(String(l1) === String(l2), `lease extended after terminal — heartbeat not cleaned up`);
  });

  // ── D. crash-with-side-effect recovery (finding 4) ────────
  // side effect สำเร็จ + outcome recorded แล้ว crash ก่อน finalize
  // → recovery ต้อง finalize โดยไม่ re-execute side effect / ไม่ insert reply ซ้ำ

  await test("D3 trigger handoff done → crash → recovery finalizes without re-handoff", async () => {
    seedInbound("d3", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("d3", {
      expired: true,
      outcome_type: "handed_off",
      reply_ids: [],
      side_effects: [{ type: "handoff", ref: "admin_1", at: new Date() }],
    }));

    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.handoffTest === 0, `handoffTest=${state.calls.handoffTest} want 0 — outcome recorded, must not re-execute`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const claims = claimDocs("d3");
    assert(claims.length === 1 && claims[0].status === "handed_off", `claim status=${claims[0]?.status} want handed_off (finalize only)`);
  });

  await test("D4 workflow replies persisted → crash → recovery finalizes without engine re-run", async () => {
    state.config.workflow_enabled = true;
    seedInbound("d4", "conv_1");
    const batch = ["d4"];
    mocks.fakeColl("chat_processing").push(claimDoc("d4", { expired: true, batch }));
    // workflow replies persist แล้ว (deterministic wf ids) ก่อน owner ตาย
    for (let i = 0; i < 2; i++) {
      mocks.fakeColl("shadow_replies").push({
        _id: WF_REPLY_ID("conv_1", batch, i),
        shadow_reply_id: WF_REPLY_ID("conv_1", batch, i),
        conversation_id: "conv_1",
        shop_id: "shop_1",
        platform: "shopee",
        inbound_message_id: "d4",
        inbound_message_ids: batch,
        inbound_text: "inbound d4",
        bot_reply_text: `wf delivered ${i}`,
        origin: "workflow",
        created_at: new Date(),
      });
    }

    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.matchAndRun === 0, `matchAndRun=${state.calls.matchAndRun} want 0 — replies persisted, must not re-run workflow`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assert(repliesFor("d4").length === 2, `replies(d4)=${repliesFor("d4").length} want 2 — must not insert duplicates`);
    const claims = claimDocs("d4");
    assert(claims.length === 1 && TERMINAL.has(claims[0].status), `claim finalized=${claims.map((d: any) => d.status)}`);
  });

  await test("D5 workflow handoff done → crash → recovery finalizes without re-assign", async () => {
    state.config.workflow_enabled = true;
    seedInbound("d5", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("d5", {
      expired: true,
      outcome_type: "handed_off",
      reply_ids: [WF_REPLY_ID("conv_1", ["d5"], 0)],
      side_effects: [{ type: "workflow_handoff", workflow_id: "wf1", ref: "admin_9", at: new Date() }],
    }));
    mocks.fakeColl("shadow_replies").push({
      _id: WF_REPLY_ID("conv_1", ["d5"], 0),
      shadow_reply_id: WF_REPLY_ID("conv_1", ["d5"], 0),
      conversation_id: "conv_1", shop_id: "shop_1", platform: "shopee",
      inbound_message_id: "d5", inbound_message_ids: ["d5"],
      inbound_text: "inbound d5", bot_reply_text: "wf handoff msg",
      origin: "workflow", created_at: new Date(),
    });

    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.matchAndRun === 0, `matchAndRun=${state.calls.matchAndRun} want 0 — outcome recorded, no engine re-run`);
    assert(state.calls.handoffTest === 0, `handoffTest=${state.calls.handoffTest} want 0 — no re-assign`);
    const claims = claimDocs("d5");
    assert(claims.length === 1 && claims[0].status === "handed_off", `claim status=${claims[0]?.status} want handed_off`);
  });

  // ── E. outcome contract ทุก terminal branch (finding 3) ───

  await test("E1 bot answer → outcome bot_answered + 1 reply id", async () => {
    seedInbound("e1", "conv_1");
    await svc.pollNewMessages(SCOPE);
    await settle();
    const c = claimDocs("e1")[0];
    assert(c?.outcome_type === "bot_answered", `outcome_type=${c?.outcome_type} want bot_answered`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 1, `reply_ids want [1]`);
  });

  await test("E2 trigger bot_template → outcome trigger_matched + 1 reply id, no LLM", async () => {
    state.trigger = { trigger_id: "t_tpl", action: "bot_answer", bot_template: "canned reply" };
    seedInbound("e2", "conv_1");
    await svc.pollNewMessages(SCOPE);
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 (template answers without LLM)`);
    const c = claimDocs("e2")[0];
    assert(c?.outcome_type === "trigger_matched", `outcome_type=${c?.outcome_type} want trigger_matched`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 1, `reply_ids want [1]`);
  });

  await test("E3 handoff → outcome handed_off + 0 reply ids + single side-effect record", async () => {
    state.trigger = { trigger_id: "t_ho", action: "handoff_admin" };
    seedInbound("e3", "conv_1");
    await svc.pollNewMessages(SCOPE);
    await settle();
    const c = claimDocs("e3")[0];
    assert(c?.outcome_type === "handed_off", `outcome_type=${c?.outcome_type} want handed_off`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 0, `reply_ids want []`);
    assert(state.calls.handoffTest === 1, `handoffTest=${state.calls.handoffTest} want 1`);
    assert(Array.isArray(c?.side_effects) && c.side_effects.some((s: any) => s.type === "handoff"),
      `claim must record handoff side-effect for recovery, got ${JSON.stringify(c?.side_effects)}`);
  });

  await test("E4 assigned/open conversation → outcome no_action + 0 reply ids", async () => {
    state.testStatus = { status: "open", assigned_to: "admin_1" };
    seedInbound("e4", "conv_1");
    await svc.pollNewMessages(SCOPE);
    await settle();
    const c = claimDocs("e4")[0];
    assert(c?.outcome_type === "no_action", `outcome_type=${c?.outcome_type} want no_action`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 0, `reply_ids want []`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
  });

  await test("E5 workflow single delivery → outcome workflow_actioned + 1 reply id", async () => {
    state.config.workflow_enabled = true;
    state.workflowResult = { status: "actioned", workflow_id: "wf1", detail: "ok", delivered: [{ text: "wf msg", source: "workflow" }] };
    seedInbound("e5", "conv_1");
    await svc.pollNewMessages(SCOPE);
    await settle();
    const c = claimDocs("e5")[0];
    assert(c?.outcome_type === "workflow_actioned", `outcome_type=${c?.outcome_type} want workflow_actioned`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 1, `reply_ids=${JSON.stringify(c?.reply_ids)} want [1]`);
    // delivered reply ต้องใช้ deterministic id (recovery dedupe อาศัย _id)
    const reply = mocks.fakeColl("shadow_replies").find((d: any) => d._id === WF_REPLY_ID("conv_1", ["e5"], 0));
    assert(!!reply, `workflow reply _id must be deterministic ${WF_REPLY_ID("conv_1", ["e5"], 0)} — random ids break crash-recovery dedupe`);
  });

  await test("E6 workflow multiple deliveries → N reply ids (not forced single)", async () => {
    state.config.workflow_enabled = true;
    state.workflowResult = {
      status: "actioned", workflow_id: "wf1", detail: "ok",
      delivered: [{ text: "a", source: "workflow" }, { text: "b", source: "workflow" }, { text: "c", source: "workflow" }],
    };
    seedInbound("e6", "conv_1");
    await svc.pollNewMessages(SCOPE);
    await settle();
    const c = claimDocs("e6")[0];
    assert(c?.outcome_type === "workflow_actioned", `outcome_type=${c?.outcome_type}`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 3, `reply_ids=${JSON.stringify(c?.reply_ids)} want [3]`);
  });

  await test("E7 bot error → outcome bot_failed, terminal, no auto-retry", async () => {
    state.callBotError = new Error("bot unavailable");
    seedInbound("e7", "conv_1");

    await svc.pollNewMessages(SCOPE);
    await settle();

    const claims = claimDocs("e7");
    assert(claims.length === 1, `claim docs=${claims.length} want 1`);
    assert(claims[0].status === "bot_failed", `status=${claims[0].status} want bot_failed`);
    assert(claims[0].outcome_type === "bot_failed", `outcome_type=${claims[0].outcome_type}`);

    state.callBotError = null;
    for (let i = 0; i < 3; i++) await svc.pollNewMessages(SCOPE);
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — bot_failed terminal, no auto-retry`);
  });

  // ── G. Part 1B implementation tests (เพิ่มระหว่าง impl) ────

  // G1. heartbeat เจอ claim ถูก reclaim กลางคัน → lost → ห้าม persist/finalize
  await test("G1 lost heartbeat ownership → stale worker must not persist/finalize", async () => {
    runtime.heartbeatMs = 25;
    runtime.claimLeaseMs = 5000;
    state.callBotDelayMs = 250;
    seedInbound("g1", "conv_1");

    const running = svc.processMessage(msgDoc("g1", "conv_1"));
    await sleep(60);
    // จำลอง owner อื่น reclaim ระหว่าง bot call — เปลี่ยน owner/fencing ของ doc
    await (await mocks.getCollection("chat_processing")).updateOne(
      { _id: CLAIM_ID("g1") },
      { $set: { owner_id: "worker-B", fencing_token: 9, lease_expires_at: new Date(Date.now() + 60000) } }
    );
    await running;

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
    assert(repliesFor("g1").length === 0, `replies(g1)=${repliesFor("g1").length} want 0 — lost ownership ห้าม persist reply`);
    const claim = claimDocs("g1")[0];
    assert(claim.status === "processing", `claim status=${claim.status} want processing — stale worker ห้าม finalize`);
    assert(claim.owner_id === "worker-B" && claim.fencing_token === 9,
      `claim owner=${claim.owner_id} fencing=${claim.fencing_token} must stay the reclaiming owner's`);
  });

  // G2. handoff owner contract — pending op + committed assignment → reconstruct, no re-exec
  //     (crash หลัง assignment commit ก่อน operation result write)
  //     ทดสอบที่ owner boundary ตรงๆ — full pipeline จะถูก assigned-guard ดักก่อนถึง handoff
  await test("G2 handoff owner: pending op + committed assignment → reconstruct without re-exec", async () => {
    const opKey = `botworker:op:${CLAIM_ID("g2")}:handoff`;
    // crash window จริง: op doc ค้าง pending (ไม่มี result) + assignment commit แล้วแยกกัน
    mocks.fakeColl("botworker_events").push({ _id: opKey, status: "pending", created_at: new Date() });
    mocks.fakeColl("test_status_conversation").push({
      conversation_id: "conv_1", source: "botworker", status: "open",
      assigned_to: "admin_1", assignment_reason: "pre-crash assign", updated_at: new Date(),
    });

    const r = await mocks.handoffService.handoffToAdminTest({
      conversationId: "conv_1", source: "botworker", operationKey: opKey,
    });

    assert(r.assignedTo === "admin_1", `assignedTo=${r.assignedTo} want admin_1 — reconstruct from committed assignment`);
    assert(state.calls.handoffExec === 0, `handoffExec=${state.calls.handoffExec} want 0 — pending+committed ห้าม exec ซ้ำ`);
    const op = mocks.fakeColl("botworker_events").find((d: any) => d._id === opKey);
    assert(op?.status === "done" && op?.result?.assignedTo === "admin_1",
      `op doc must be completed with recovered result, got ${JSON.stringify(op)}`);
  });

  // G3. workflow handoff: engine assign สำเร็จแล้ว crash ก่อน outcome record
  //     → recovery เรียก matchAndRun ด้วย op key เดิม → engine คืน run result เดิม
  // ⚡ Phase 2D — reconcile-only: run doc ไม่ใช่ durable reply evidence ของ claim
  //   → settle bot_failed dormant (provider=0, engine ไม่ถูก consult ระหว่าง reconcile)
  await test("G3 workflow crash before durable outcome → reconcile dormant (no resume)", async () => {
    state.config.workflow_enabled = true;
    seedInbound("g3", "conv_1");
    const wfOpKey = `botworker:op:${CLAIM_ID("g3")}:workflow`;
    // crash ก่อน claim outcome — engine run commit แล้ว + result snapshot บน run doc
    state.workflowResult = { status: "actioned", workflow_id: "wf1" }; // match context
    mocks.fakeColl("workflow_runs").push({
      _id: `wfr_${createHash("sha256").update(`${wfOpKey}:wf1`).digest("hex").slice(0, 20)}`,
      run_id: `wfr_${createHash("sha256").update(`${wfOpKey}:wf1`).digest("hex").slice(0, 20)}`,
      workflow_id: "wf1", conversation_id: "conv_1", shop_id: "shop_1", platform: "shopee",
      operation_key: wfOpKey, status: "completed",
      result: {
        status: "actioned", detail: "wf handoff",
        delivered: [{ text: "wf msg", source: "workflow", node_id: "a1" }],
        handoff: { agentId: "admin_9", reason: "pre-crash assign" },
      },
      started_at: new Date(), updated_at: new Date(),
    });
    mocks.fakeColl("chat_processing").push(claimDoc("g3", { expired: true }));

    await svc.pollNewMessages(SCOPE);
    await settle();

    const c = claimDocs("g3")[0];
    assert(c?.status === "bot_failed", `claim status=${c?.status} want bot_failed — interrupted before durable claim outcome`);
    assert(state.calls.matchAndRun === 0, `matchAndRun calls=${state.calls.matchAndRun} want 0 — reconcile must not consult engine`);
    assert(state.calls.workflowExec === 0, `workflowExec=${state.calls.workflowExec} want 0 — no re-exec`);
    assert(state.calls.handoffExec === 0, `handoffExec=${state.calls.handoffExec} want 0 — no re-assign`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — reconcile provider=0`);
    assert(repliesFor("g3").length === 0, `replies(g3)=${repliesFor("g3").length} want 0 — no reply fabrication`);
  });

  // G4. workflow_resumed outcome — resume path เก็บ outcome + deterministic reply
  await test("G4 workflow resume → outcome workflow_resumed + reply ids", async () => {
    state.config.workflow_enabled = true;
    // run doc จริงใน workflow_runs — getActiveRun อ่านจาก store (ไม่ใช่ state.activeRun)
    mocks.fakeColl("workflow_runs").push({
      run_id: "wfr_g4", workflow_id: "wf1", conversation_id: "conv_1",
      shop_id: "shop_1", platform: "shopee", status: "waiting_for_reply",
      current_node_id: "w1", context: {}, started_at: new Date(), updated_at: new Date(),
    });
    state.resumeResult = {
      status: "resumed", detail: "resumed", workflow_id: "wf1",
      delivered: [{ text: "resume msg", source: "workflow" }],
    };
    seedInbound("g4", "conv_1");

    await svc.pollNewMessages(SCOPE);
    await settle();

    const c = claimDocs("g4")[0];
    assert(c?.status === "workflow_resumed", `claim status=${c?.status} want workflow_resumed`);
    assert(c?.outcome_type === "workflow_resumed", `outcome_type=${c?.outcome_type}`);
    assert(c?.reply_ids?.length === 1 && c.reply_ids[0] === WF_REPLY_ID("conv_1", ["g4"], 0),
      `reply_ids=${JSON.stringify(c?.reply_ids)} want deterministic wf0`);
  });

  // G5. flush error → release lock + รักษา buffer rows เป็น dormant failed (ข้อความไม่หาย)
  await test("G5 flush error releases lock and retains dormant failed rows", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 40;
    state.conversationError = new Error("conversation service down");
    seedInbound("g5", "conv_e");

    await svc.pollNewMessages(SCOPE);
    await sleep(150);
    await settle(6);

    const rows = mocks.fakeColl("buffer_messages").filter((d: any) => d.kind !== "conv_lock");
    assert(rows.length === 1 && rows[0].status === "failed",
      `row must be retained as dormant failed — got ${JSON.stringify(rows.map((d: any) => d.status))}`);
    assert(typeof rows[0].error === "string" && rows[0].failed_at instanceof Date,
      "dormant row must record error + failed_at");
    assert(lockDocs("conv_e").length === 0, `conv lock must be released on error, found ${lockDocs("conv_e").length}`);
    const c = claimDocs("g5")[0];
    assert(c && c.status === "bot_failed", `claim status=${c?.status} want bot_failed — technical error finalizes dormant`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — conversation fetch fails before provider`);
  });

  // ── H. runtime hardening (code-review findings) ───────────

  // H1. FakeMongo ต้องตรง Mongo จริง: default = BEFORE doc, "after" opt-in เท่านั้น
  await test("H1 fake findOneAndUpdate honors before/after semantics", async () => {
    const coll = await mocks.getCollection("chat_processing");
    await coll.insertOne({ _id: "h1", message_id: "h1", conversation_id: "c", shop_id: "s", platform: "shopee", status: "processing", fencing_token: 1 });

    const before = await coll.findOneAndUpdate({ _id: "h1" }, { $inc: { fencing_token: 1 } });
    assert(before?.fencing_token === 1, `default must return BEFORE doc (fencing=1), got ${before?.fencing_token} — Mongo จริงคืน before`);

    const after = await coll.findOneAndUpdate({ _id: "h1" }, { $inc: { fencing_token: 1 } }, { returnDocument: "after" });
    assert(after?.fencing_token === 3, `returnDocument:"after" must return updated doc (fencing=3), got ${after?.fencing_token}`);

    const upDef = await coll.findOneAndUpdate({ _id: "h1_new" }, { $set: { status: "processing" } }, { upsert: true });
    assert(upDef === null, `upsert default must return null (no before doc), got ${JSON.stringify(upDef)}`);
    const upAfter = await coll.findOneAndUpdate({ _id: "h1_new2" }, { $set: { status: "processing" } }, { upsert: true, returnDocument: "after" });
    assert(upAfter?._id === "h1_new2" && upAfter.status === "processing", `upsert+"after" must return inserted doc`);
  });

  // H2. attempt-cap CAS — ห้าม terminal claim ที่ owner อื่นเพิ่ง reclaim ระหว่าง read→update
  await test("H2 attempt-cap update must not terminalize another worker's fresh reclaim", async () => {
    seedInbound("h2", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("h2", { expired: true, attempt: runtime.maxClaimAttempts }));
    const claimId = CLAIM_ID("h2");
    // interleave: หลัง claimMessage อ่าน expired doc → worker-B reclaim ก่อน cap-update
    state.updateOneHook = async (coll: string, filter: any) => {
      if (coll !== "chat_processing" || filter?._id !== claimId) return;
      state.updateOneHook = null; // once — จำลอง race ระหว่าง read→cap update
      const doc = mocks.fakeColl("chat_processing").find((d: any) => d._id === claimId);
      Object.assign(doc, { owner_id: "worker-B", fencing_token: 7, lease_expires_at: new Date(Date.now() + 60000) });
    };

    await svc.pollNewMessages(SCOPE);
    await settle();

    const c = claimDocs("h2")[0];
    assert(c.owner_id === "worker-B" && c.fencing_token === 7 && c.status === "processing",
      `claim must stay worker-B's fresh reclaim — got owner=${c.owner_id} fence=${c.fencing_token} status=${c.status} (cap-update matched a doc it didn't own)`);
  });

  // H3. handoff owner: pending op + NO committed assignment → exec ครั้งเดียว (crashed ก่อน assign)
  await test("H3 handoff owner: pending op + no committed assignment → executes once", async () => {
    const opKey = `botworker:op:${CLAIM_ID("h3")}:handoff`;
    mocks.fakeColl("botworker_events").push({ _id: opKey, status: "pending", created_at: new Date() });
    state.handoffResult = { assignedTo: "admin_2", assignedToName: "A2", reopened: false, assignmentReason: "rr" };

    const r = await mocks.handoffService.handoffToAdminTest({ conversationId: "conv_h3", source: "botworker", operationKey: opKey });
    assert(r.assignedTo === "admin_2", `assignedTo=${r.assignedTo} want admin_2`);
    assert(state.calls.handoffExec === 1, `handoffExec=${state.calls.handoffExec} want 1 — pending without commit = safe single exec`);

    const r2 = await mocks.handoffService.handoffToAdminTest({ conversationId: "conv_h3", source: "botworker", operationKey: opKey });
    assert(r2.assignedTo === "admin_2" && state.calls.handoffExec === 1, `second call must dedupe via op doc result`);
  });

  // H4. concurrent matchAndRun ด้วย operation_key เดียว → run doc เดียว + exec เดียว
  //     (mock ใช้ workflow_runs docs + deterministic run_id + lease — ไม่ใช่ opResults map)
  await test("H4 concurrent matchAndRun same op key → single run doc, single exec", async () => {
    state.workflowResult = { status: "actioned", workflow_id: "wf1", detail: "ok", delivered: [{ text: "m", source: "workflow" }] };
    const opKey = "botworker:op:botworker:claim:h4:workflow";
    const msg = { message_id: "h4", conversation_id: "conv_1", shop_id: "shop_1", platform: "shopee" as const, text: "hi", operation_key: opKey };

    const [r1, r2] = await Promise.all([
      mocks.workflowEngine.matchAndRun(msg),
      mocks.workflowEngine.matchAndRun(msg),
    ]);

    assert(state.calls.workflowExec === 1, `workflowExec=${state.calls.workflowExec} want 1 — concurrent same-key must share one run`);
    assert(r1.run_id === r2.run_id, `run_id must be deterministic+identical (${r1.run_id} vs ${r2.run_id})`);
    assert(mocks.fakeColl("workflow_runs").filter((d: any) => d.run_id === r1.run_id).length === 1, `run docs must be 1`);
  });

  // H5. restart recovery: 3 buffered msgs → batch เดียว (buffered recovery ก่อน direct claims)
  // ⚡ Phase 2D — reconcile-only: expired buffered batch → claims bot_failed +
  //   rows dormant failed (payload retained) — provider=0 เสมอใน recovery
  await test("H5 restart recovery → expired buffered batch settles dormant (provider=0)", async () => {
    state.config.bot_buffer_enabled = true;
    for (const id of ["h5a", "h5b", "h5c"]) {
      mocks.fakeColl("chat_processing").push(claimDoc(id, { conv: "conv_r", expired: true, batch: ["h5a", "h5b", "h5c"] }));
      mocks.fakeColl("buffer_messages").push({
        message_id: id, conversation_id: "conv_r", shop_id: "shop_1", platform: "shopee",
        text: `msg ${id}`, kind: "message", status: "buffered", received_at: new Date(),
        msg_created_at: new Date(), admitted_edge: new Date(0),
        claim_id: CLAIM_ID(id), owner_id: "worker-A", fencing_token: 1,
      });
      seedInbound(id, "conv_r");
    }

    await svc.botWorkerService.recoverStaleBuffers(SCOPE);
    await settle();

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — recovery must not execute provider work`);
    for (const id of ["h5a", "h5b", "h5c"]) {
      const c = claimDocs(id)[0];
      assert(c?.status === "bot_failed", `${id} claim → bot_failed dormant, got ${c?.status}`);
    }
    const rows = mocks.fakeColl("buffer_messages").filter((d: any) => d.kind !== "conv_lock");
    assert(rows.length === 3 && rows.every((d: any) => d.status === "failed"),
      `rows retained as dormant failed for carry-forward — got ${JSON.stringify(rows.map((d: any) => d.status))}`);
  });

  // H6. flush ห้ามแย่ง active claim ของ owner อื่น — re-fence = expected owner/token หรือ expired เท่านั้น
  await test("H6 flush must not steal another owner's active claim", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("h6", { conv: "conv_f6", owner: "worker-B" })); // lease active
    mocks.fakeColl("buffer_messages").push({
      message_id: "h6", conversation_id: "conv_f6", shop_id: "shop_1", platform: "shopee",
      text: "msg", kind: "message", status: "buffered", received_at: new Date(),
      msg_created_at: new Date(), admitted_edge: new Date(0),
      claim_id: CLAIM_ID("h6"), owner_id: "worker-B", fencing_token: 1,
    });

    const r = await buf.flushBuffer("shopee", "shop_1", "conv_f6", svc.processMessage, async () => {});

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — foreign active claim must not join batch (${r.status})`);
    const c = claimDocs("h6")[0];
    assert(c.owner_id === "worker-B" && c.fencing_token === 1,
      `worker-B's claim must be untouched — got owner=${c.owner_id} fence=${c.fencing_token}`);
    const row = mocks.fakeColl("buffer_messages").find((d: any) => d.message_id === "h6");
    assert(row?.status === "buffered", `row must stay buffered for next round, got ${row?.status}`);
    assert(lockDocs("conv_f6").length === 0, `conv lock must be released`);
  });

  // H7. finalize ไม่สำเร็จครบ (ownership stolen) → rows dormant failed (payload retained)
  //   — claims คง processing ของ owner ใหม่ → recovery reconcile เมื่อ lease หมด
  await test("H7 flush interrupted by lost ownership → rows dormant failed (payload retained)", async () => {
    runtime.heartbeatMs = 25;
    runtime.claimLeaseMs = 5000;
    state.callBotDelayMs = 200;
    for (const id of ["h7a", "h7b"]) {
      mocks.fakeColl("chat_processing").push(claimDoc(id, { conv: "conv_h7", owner: runtime.ownerId }));
      mocks.fakeColl("buffer_messages").push({
        message_id: id, conversation_id: "conv_h7", shop_id: "shop_1", platform: "shopee",
        text: `msg ${id}`, kind: "message", status: "buffered", received_at: new Date(),
        msg_created_at: new Date(), admitted_edge: new Date(0),
        claim_id: CLAIM_ID(id), owner_id: runtime.ownerId, fencing_token: 1,
      });
    }

    const run = buf.flushBuffer("shopee", "shop_1", "conv_h7", svc.processMessage, async () => {});
    await sleep(60);
    // worker-B steal member claims กลาง bot call → heartbeat detect lost → ห้าม persist/finalize
    await (await mocks.getCollection("chat_processing")).updateMany(
      { _id: { $in: [CLAIM_ID("h7a"), CLAIM_ID("h7b")] } },
      { $set: { owner_id: "worker-B", fencing_token: 9, lease_expires_at: new Date(Date.now() + 60000) } }
    );
    await run;

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot}`);
    assert(repliesFor("h7a", "h7b").length === 0, `lost ownership → must not persist reply`);
    const rows = mocks.fakeColl("buffer_messages").filter((d: any) => String(d.message_id || "").startsWith("h7"));
    assert(rows.length === 2 && rows.every((d: any) => d.status === "failed"),
      `rows must go dormant failed (not deleted) on interrupted finalize — got ${JSON.stringify(rows.map((d: any) => d.status))}`);
  });

  // H8. recovery อ่าน outcome envelope จาก reply doc — ห้ามเดา outcome จากชื่อ reply
  await test("H8 recovery reads outcome envelope from reply doc — no name guessing", async () => {
    seedInbound("h8", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("h8", { expired: true }));
    mocks.fakeColl("shadow_replies").push({
      _id: REPLY_ID("conv_1", ["h8"]), shadow_reply_id: REPLY_ID("conv_1", ["h8"]),
      conversation_id: "conv_1", shop_id: "shop_1", platform: "shopee",
      inbound_message_id: "h8", inbound_message_ids: ["h8"],
      inbound_text: "inbound h8", bot_reply_text: "template answer",
      outcome_envelope: { outcome_type: "trigger_matched", trigger_id: "t_tpl1" },
      created_at: new Date(),
    });

    await svc.pollNewMessages(SCOPE);
    await settle();

    const c = claimDocs("h8")[0];
    assert(c?.status === "trigger_matched", `status=${c?.status} want trigger_matched — envelope drives outcome, not reply-name guess`);
    assert(c?.trigger_id === "t_tpl1", `trigger_id=${c?.trigger_id} want t_tpl1 (envelope metadata)`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
  });

  // H9a. timeout ห้ามตัด valid latency — audit: liveAssignmentService ใช้ 90s + 429 retry 60s
  await test("H9a timeout >= existing 90s norm + lease headroom", async () => {
    assert(runtime.botCallTimeoutMs >= 90_000,
      `botCallTimeoutMs=${runtime.botCallTimeoutMs} < 90s — cuts valid latency vs liveAssignmentService 90s timeout`);
    assert(runtime.claimLeaseMs > runtime.botCallTimeoutMs + 30_000,
      `claimLeaseMs=${runtime.claimLeaseMs} must exceed timeout ${runtime.botCallTimeoutMs} + finalize headroom`);
  });

  // H9b. fake clock scaled: valid response ~70s (ของเก่า timeout 60s ตัด) → ต้อง bot_answered
  await test("H9b valid response slower than old 60s cap → still bot_answered (scaled clock)", async () => {
    // scale 100x: timeout 90s→900ms, lease 150s→1500ms, heartbeat 500ms, response 700ms (≈70s > old 60s cap)
    runtime.botCallTimeoutMs = 900;
    runtime.claimLeaseMs = 1500;
    runtime.heartbeatMs = 500;
    state.callBotDelayMs = 700;
    seedInbound("h9", "conv_1");

    await svc.pollNewMessages(SCOPE);
    await settle();

    const c = claimDocs("h9")[0];
    assert(c?.status === "bot_answered", `status=${c?.status} want bot_answered — valid slow response must not be bot_failed`);
  });

  // H10. flush error → dormant failed (ไม่มี autonomous retry); distinct new inbound
  //   ใน conv เดียวกัน → carry-forward → one combined flush
  await test("H10 flush error → dormant failed; new distinct inbound carries forward once", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 40;
    state.conversationError = new Error("conversation service down");
    seedInbound("h10", "conv_h10");

    await svc.pollNewMessages(SCOPE);
    await sleep(140);               // flush #1 fail → dormant
    await settle();

    const row = mocks.fakeColl("buffer_messages").find((d: any) => d.message_id === "h10");
    assert(row?.status === "failed", `row must be dormant failed after flush error, got ${row?.status}`);
    const callsAfterFail = state.calls.callBot;
    await sleep(120); // เกิน retry-era เดิม — ห้ามมี provider call เพิ่มเอง (no autonomous retry)
    assert(state.calls.callBot === callsAfterFail,
      `callBot must not grow without new inbound, got ${state.calls.callBot}`);

    // distinct new inbound ใน conv เดียวกัน → carry-forward → one combined flush
    state.conversationError = null; // transient recovered
    seedInbound("h10b", "conv_h10");
    await svc.pollNewMessages(SCOPE);
    await sleep(140);
    await settle();

    assert(state.calls.callBot === callsAfterFail + 1,
      `callBot=${state.calls.callBot} want ${callsAfterFail + 1} — one combined attempt only`);
    const cOld = claimDocs("h10")[0];
    const cNew = claimDocs("h10b")[0];
    assert(TERMINAL.has(cOld?.status) && TERMINAL.has(cNew?.status),
      `old+new claims terminal after combined flush, got ${cOld?.status}/${cNew?.status}`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.kind !== "conv_lock").length === 0,
      `buffer rows must be deleted after successful combined flush`);
  });

  // ── F. guard rails ─────────────────────────────────────────

  await test("F1 legacy terminal docs → backward-compat skip, no duplicate claim", async () => {
    mocks.fakeColl("chat_processing").push(
      { message_id: "legacy1", conversation_id: "conv_1", shop_id: "s1", platform: "shopee", status: "bot_answered", processed_at: new Date() },
      { message_id: "legacy1", conversation_id: "conv_1", shop_id: "s1", platform: "shopee", status: "bot_answered", processed_at: new Date() },
    );
    seedInbound("legacy1", "conv_1");

    await svc.pollNewMessages(SCOPE);
    await settle();

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — legacy terminal doc means processed`);
    assert(claimDocs("legacy1").length === 0, `must not create new claim for already-terminal message`);
  });

  await test("F2 disabled worker → startup does not recover/flush/process", async () => {
    state.config.bot_worker_enabled = false;
    mocks.fakeColl("buffer_messages").push({
      message_id: "m11",
      conversation_id: "conv_9",
      shop_id: "shop_1",
      platform: "shopee",
      type: "text",
      text: "stale buffered msg",
      status: "buffered",
      received_at: new Date(Date.now() - 86400000),
    });

    await svc.botWorkerService.recoverStaleBuffers(SCOPE);

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — disabled worker must not recover/flush`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.status === "buffered").length === 1, `stale buffer flushed while disabled`);
    assert(claimDocs("m11").length === 0, `must not create claim while disabled`);
  });

  // ── L. duplicate-poll debounce livelock (BW-1 incident root) ─────────
  //   chain: poll → claim(processing,self,lease-active)→claimed →
  //   bufferOrProcess → insertToBuffer E11000 swallowed → timer RE-ARMED
  //   poll 1s < window 7s → timer ไม่มีวันครบ → flush ไม่ยิง → ข้อความค้าง

  // R1+R6: duplicate re-polls must not extend the first-admitted deadline;
  //   flush fires on the ORIGINAL deadline — bot call ≤ 1 across N dups
  await test("L1 duplicate re-poll during debounce must not extend deadline → flush once, callBot<=1", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 100;
    state.callBotDelayMs = 20;
    seedInbound("mL1", "conv_l1");

    await svc.pollNewMessages(SCOPE);          // t≈0: insert + arm (deadline ≈100ms)
    for (let i = 0; i < 3; i++) {
      await sleep(30);                    // t≈30/60/90 — each before deadline
      await svc.pollNewMessages(SCOPE);        // duplicate → claim claimed → bufferOrProcess
    }
    await sleep(50);                      // t≈140 — original deadline (100) past; buggy extension (~190) not yet
    // BUG: each dup re-armed → deadline ~190 → flush not fired yet → callBot=0
    assert(state.calls.callBot >= 1, `callBot=${state.calls.callBot} want >=1 by original deadline — duplicate polls extended it`);
    await sleep(140);                     // let any late flush land
    await settle();

    // BUG: each dup re-armed → deadline pushed to ~155+ → flush starved → callBot=0
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — duplicate polls must not starve/extend the debounce`);
    assert(repliesFor("mL1").length === 1, `replies=${repliesFor("mL1").length} want 1`);
    const claims = claimDocs("mL1");
    assert(claims.length === 1 && TERMINAL.has(claims[0].status), `claim terminal=${claims.map((d: any) => d.status)}`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.status === "buffered").length === 0,
      "buffer rows must be consumed");
  });

  // R2: distinct new message re-arms legitimately; duplicates after must NOT extend again
  await test("L2 distinct message extends debounce; later duplicates must not extend again", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 200;
    state.callBotDelayMs = 20;
    seedInbound("mL2a", "conv_l2");

    await svc.pollNewMessages(SCOPE);              // t≈0 → deadline ≈200
    await sleep(60);
    seedInbound("mL2b", "conv_l2");
    await svc.pollNewMessages(SCOPE);              // t≈60: DISTINCT → legit re-arm → deadline ≈260
    await sleep(60);
    await svc.pollNewMessages(SCOPE);              // t≈120: dup a+b → must NOT re-arm
    await sleep(60);
    await svc.pollNewMessages(SCOPE);              // t≈180: dup a+b → must NOT re-arm
    await sleep(130);                         // t≈310 — legit deadline (260) past; buggy (380) not

    // BUG: dups re-armed to ~210 → callBot still 0 here
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — flush must fire on the last DISTINCT admit, not last duplicate`);
    await settle();
    for (const id of ["mL2a", "mL2b"]) {
      const c = claimDocs(id);
      assert(c.length === 1 && TERMINAL.has(c[0].status), `${id} claim terminal`);
      assert(c[0].batch_id === BATCH_ID("conv_l2", ["mL2a", "mL2b"]), `${id} batch_id=${c[0].batch_id} want joint batch`);
    }
    assert(repliesFor("mL2a", "mL2b").length === 1, `batch reply want 1`);
  });

  // R3: insert contract — duplicate admit must be distinguishable (not new activity)
  await test("L3 bufferOrProcess duplicate → recognized contract, no second row", async () => {
    state.config.bot_buffer_enabled = true;
    const cfg = {
      bufferEnabled: true, bufferWindowMs: 500, bufferMaxMessages: 10,
      bufferWindowMediaMs: 500, bufferMaxMediaMessages: 20,
    };
    const m = { message_id: "mL3", conversation_id: "conv_l3", shop_id: "shop_1", platform: "shopee" as const, text: "hi", created_timestamp: new Date(), admitted_edge: new Date(0) as Date | null };
    const markStub = async () => {};

    const r1 = await buf.bufferOrProcess(m, cfg, svc.processMessage, markStub);
    const r2 = await buf.bufferOrProcess(m, cfg, svc.processMessage, markStub);

    assert(r1.status === "buffered", `first insert status=${r1.status}`);
    // contract: duplicate must NOT look like fresh activity — caller-visible signal
    assert(/dup/i.test(r2.detail), `duplicate admit must be recognizable, got detail="${r2.detail}"`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.message_id === "mL3").length === 1,
      "duplicate must not create a second row");
    buf.clearAllBufferTimers();               // pending debounce — release before next test
  });

  // R7: an insert can succeed before the following buffer read fails. The next
  // duplicate poll must restore an execution path without extending the original deadline.
  await test("L4 duplicate without an active timer repairs the original debounce deadline", async () => {
    state.config.bot_buffer_enabled = true;
    const cfg = {
      bufferEnabled: true, bufferWindowMs: 300, bufferMaxMessages: 10,
      bufferWindowMediaMs: 300, bufferMaxMediaMessages: 20,
    };
    const m = {
      message_id: "mL4", conversation_id: "conv_l4", shop_id: "shop_1",
      platform: "shopee" as const, text: "repair timer",
      created_timestamp: new Date(), admitted_edge: new Date(0) as Date | null,
      claimContext: {
        claim_id: CLAIM_ID("mL4"), claim_ids: [CLAIM_ID("mL4")],
        owner_id: runtime.ownerId, fencing_token: 1,
        lease_expires_at: new Date(Date.now() + 60_000),
        batch_id: BATCH_ID("conv_l4", ["mL4"]), message_ids: ["mL4"], lost: false,
      },
    };
    const markStub = async () => {};
    let processCalls = 0;
    const processStub = async () => {
      processCalls++;
      return { status: "bot_answered", detail: "mocked", finalized: true, lost: false };
    };
    mocks.fakeColl("chat_processing").push(claimDoc("mL4", {
      conv: "conv_l4", owner: runtime.ownerId,
    }));
    let failFirstBufferRead = true;
    state.findHook = async (name: string) => {
      if (name === "buffer_messages" && failFirstBufferRead) {
        failFirstBufferRead = false;
        throw new Error("simulated read failure after insert");
      }
    };

    let firstFailed = false;
    try {
      await buf.bufferOrProcess(m, cfg, processStub, markStub);
    } catch (e: any) {
      firstFailed = /simulated read failure/.test(e?.message || String(e));
    }
    assert(firstFailed, "first call must fail after the row was inserted");
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.message_id === "mL4").length === 1,
      "inserted row must survive the transient read failure");

    state.findHook = null;
    await sleep(120);
    const repaired = await buf.bufferOrProcess(m, cfg, processStub, markStub);
    assert(/dup/i.test(repaired.detail), `repair must remain duplicate-aware, got ${repaired.detail}`);

    // intermediate checkpoint ≈t340: original deadline (received_at+300) ผ่านแล้ว
    // แต่ incorrect full-window re-arm (t120+300=420) ยังไม่ถึง — ห้าม settle() ก่อน
    //   เพราะ settle รอจนงานหมด → อาจข้าม fresh deadline ไปแล้ว
    await sleep(220);
    assert(processCalls === 1,
      `processCalls=${processCalls} @t≈340 want 1 — flush ต้องยิงที่ original deadline ไม่ใช่ fresh re-arm (fresh≈420)`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.message_id === "mL4").length === 0,
      "row must be consumed by original deadline");

    // รอข้าม fresh deadline (≈t420) — ต้องไม่มี processing ซ้ำ
    await sleep(140);
    await settle();
    assert(processCalls === 1, `processCalls=${processCalls} after fresh deadline want exactly 1 — no duplicate processing`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.message_id === "mL4").length === 0,
      "repaired row must stay consumed");
  });

  // ── M. single-active-worker ownership (BW-2 contract) ────────
  // contract artifact: leader lease doc (singleton) in botworker_state —
  //   { _id:"botworker:leader", owner_id, fencing_token, lease_expires_at }
  //   vocabulary reuses claim protocol (owner/token/lease CAS) — no config/env
  // coordinator seam (proposed, DB-level tests pin it with explicit ownerId):
  //   svc.botWorkerService.ensureLeadership(ownerId?): Promise<boolean>
  //     absent→insert token=1 · mine→renew (token unchanged) · foreign+active→false
  //     expired→takeover CAS {_id,owner,token,lease<now} $inc token (once)
  //   svc.botWorkerService.checkWaitTimeouts(): gated wrapper (loser → 0)
  //   clearPendingWork: cancels heartbeat lifecycle → lease lapses naturally
  //
  // two-instance honesty rules (this suite):
  //   • DB-level tests pass ownerId explicitly — NO global rebind mid-test
  //   • integration tests rebind botworkerRuntime.ownerId ONLY after settle()
  //     (no in-flight work of the previous owner may be pending at flip time)
  //   • fake Mongo resolves owner_id dynamically per op (= separate processes
  //     sharing one DB); assertions stay on DB-observable outcomes + op counters

  const LEADER_COLL = mocks.COLLECTIONS.botworkerState; // parity — ห้าม hardcode collection string
  const LEADER_ID = "botworker:leader";
  const leaderDocs = () => mocks.fakeColl(LEADER_COLL).filter((d: any) => d._id === LEADER_ID);
  // returns LeaderCtx {owner_id, fencing_token} | false — truthy = admitted
  const ensureLeadership = (owner: string): Promise<any> => {
    const fn = (svc.botWorkerService as any).ensureLeadership;
    if (typeof fn !== "function")
      throw new Error("ensureLeadership(ownerId) not implemented — coordinator contract missing");
    return fn.call(svc.botWorkerService, owner);
  };
  function seedLeader(owner: string, opts: { expired?: boolean; token?: number } = {}) {
    const now = Date.now();
    mocks.fakeColl(LEADER_COLL).push({
      _id: LEADER_ID,
      owner_id: owner,
      fencing_token: opts.token ?? 1,
      lease_expires_at: new Date(now + (opts.expired ? -1000 : 60000)),
      updated_at: new Date(now - 1000),
    });
  }
  function bufferRowDoc(messageId: string, conv: string, opts: { owner?: string; token?: number } = {}) {
    return {
      _id: `buf_${messageId}`,
      kind: "message",
      message_id: messageId,
      conversation_id: conv,
      shop_id: "shop_1",
      platform: "shopee",
      text: `buffered ${messageId}`,
      status: "buffered",
      claim_id: CLAIM_ID(messageId),
      owner_id: opts.owner || "worker-A",
      fencing_token: opts.token ?? 1,
      received_at: new Date(),
      msg_created_at: new Date(),
      admitted_edge: new Date(0),
      updated_at: new Date(),
    };
  }
  // per-collection op counters via existing fake-Mongo onQuery seam
  //   loser may touch ONLY botworker_state — nothing else
  const READ_OPS = new Set(["find", "findOne", "countDocuments", "distinct", "aggregate", "estimatedDocumentCount"]);
  function countOps() {
    const reads: Record<string, number> = {};
    const writes: Record<string, number> = {};
    state.onQuery = (coll: string, op: string) => {
      const bucket = READ_OPS.has(op) ? reads : writes;
      bucket[coll] = (bucket[coll] || 0) + 1;
    };
    return {
      reads, writes,
      touched: () => [...new Set([...Object.keys(reads), ...Object.keys(writes)])],
      stop: () => { state.onQuery = null; },
    };
  }

  // ── DB-level coordinator contract (explicit ownerId — no global rebind) ──

  await test("M0a concurrent absent acquire → exactly one winner, singleton doc", async () => {
    const [a, b] = await Promise.all([ensureLeadership("worker-A"), ensureLeadership("worker-B")]);
    assert((a ? 1 : 0) + (b ? 1 : 0) === 1, `exactly one winner required — got A=${a} B=${b}`);
    const leaders = leaderDocs();
    assert(leaders.length === 1, `singleton leader doc required, got ${leaders.length}`);
    const winner = a ? "worker-A" : "worker-B";
    assert(leaders[0].owner_id === winner && leaders[0].fencing_token === 1,
      `leader doc must be winner with token 1 — got ${leaders[0].owner_id}/${leaders[0].fencing_token}`);
  });

  await test("M0b leader renew before expiry → same owner/token, expiry extends to ~now+leaseMs", async () => {
    // seed lease ACTIVE but shorter than leaderLeaseMs (contract: 5000ms) —
    //   renew ต้องต่ออายุเป็น ~now+leaderLeaseMs ไม่ใช่คงเดิม/ไม่ใช่เพิ่ม token
    const now = Date.now();
    mocks.fakeColl(LEADER_COLL).push({
      _id: LEADER_ID, owner_id: "worker-A", fencing_token: 7,
      lease_expires_at: new Date(now + 1000), updated_at: new Date(now - 1000),
    });
    const oldExpiry = now + 1000;
    const t0 = Date.now();
    const ok = await ensureLeadership("worker-A");
    const l = leaderDocs()[0];
    assert(ok !== false && ok?.owner_id === "worker-A", "active self lease must return LeaderCtx");
    assert(l?.owner_id === "worker-A" && l?.fencing_token === 7,
      `renew must keep owner/token — got ${l?.owner_id}/${l?.fencing_token}`);
    const newExpiry = l?.lease_expires_at?.getTime() || 0;
    assert(newExpiry > oldExpiry, `renew must extend expiry — ${newExpiry} <= ${oldExpiry}`);
    const expected = t0 + mocks.botworkerRuntime.leaderLeaseMs;
    assert(Math.abs(newExpiry - expected) < 2000,
      `renew expiry must be ≈now+leaderLeaseMs(${mocks.botworkerRuntime.leaderLeaseMs}) — got ${newExpiry}, expected ~${expected}`);
  });

  await test("M0c expired lease → takeover CAS bumps fencing_token exactly once", async () => {
    seedLeader("worker-A", { expired: true, token: 7 });
    const ok = await ensureLeadership("worker-B");
    const l = leaderDocs()[0];
    assert(ok !== false && ok?.fencing_token === 8, "expired lease must be acquirable — ctx token should be takeover value");
    assert(l?.owner_id === "worker-B" && l?.fencing_token === 8,
      `takeover must bump token once — got ${l?.owner_id}/${l?.fencing_token} want worker-B/8`);
    const again = await ensureLeadership("worker-A");
    assert(again === false, "loser of takeover must stay fenced while B active");
  });



  await test("M0f no renewal (heartbeat dead) → lease lapses → takeover once", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 80;
    await ensureLeadership("worker-A");
    await sleep(140); // no beats — lease dead
    const ok = await ensureLeadership("worker-B");
    const l = leaderDocs()[0];
    assert(ok !== false && l?.owner_id === "worker-B" && l?.fencing_token === 2,
      `lapsed lease must transfer once — got ${ok} ${l?.owner_id}/${l?.fencing_token}`);
  });

  // ── integration entry points (global ownerId rebind ONLY after settle) ──

  // sequential active-leader/loser integration — A drained before B runs
  //   (concurrency จริงของ absent-acquire อยู่ที่ M0a Promise.all เท่านั้น)
  await test("M1 active-leader/loser integration — B poll quiet, touches only botworker_state", async () => {
    seedInbound("m_M1", "conv_M1");
    mocks.botworkerRuntime.ownerId = "worker-A";
    const rA = await svc.pollNewMessages(SCOPE);
    await settle(); // drain all A work BEFORE flipping owner — no pending work at rebind
    assert(rA.found >= 1, `leader poll must see inbound, got ${rA.found}`);
    mocks.botworkerRuntime.ownerId = "worker-B";
    const ops = countOps();
    const rB = await svc.pollNewMessages(SCOPE);
    ops.stop();
    assert(rB.found === 0 && rB.processed === 0,
      `loser poll must do zero work — got found=${rB.found} processed=${rB.processed}`);
    const foreign = ops.touched().filter((c) => c !== LEADER_COLL);
    assert(foreign.length === 0, `loser may touch only ${LEADER_COLL} — touched ${foreign}`);
    assert(leaderDocs()[0]?.owner_id === "worker-A", "loser must not overwrite active leader");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 (leader only)`);
  });

  await test("M2 loser recovery → 0 recovered, 0 writes to claims/buffer, 0 bot calls", async () => {
    seedLeader("worker-A");
    mocks.fakeColl("chat_processing").push(claimDoc("m_M2", { owner: "worker-A", expired: true, conv: "conv_M2" }));
    mocks.fakeColl("buffer_messages").push(bufferRowDoc("m_M2", "conv_M2"));
    mocks.botworkerRuntime.ownerId = "worker-B";
    const ops = countOps();
    const rec = await svc.botWorkerService.recoverStaleBuffers(SCOPE);
    ops.stop();
    await settle();
    assert(rec.recovered === 0, `loser recovery must recover 0, got ${rec.recovered}`);
    const claim = mocks.fakeColl("chat_processing").find((d: any) => d._id === CLAIM_ID("m_M2"));
    assert(claim?.owner_id === "worker-A", `loser must not reclaim foreign claim — owner=${claim?.owner_id}`);
    assert(mocks.fakeColl("buffer_messages").some((d: any) => d.message_id === "m_M2"),
      "loser must not consume foreign buffer row");
    assert(state.calls.callBot === 0, `loser callBot=${state.calls.callBot} want 0`);
    const foreignWrites = Object.keys(ops.writes).filter((c) => c !== LEADER_COLL);
    assert(foreignWrites.length === 0, `loser must write nothing outside ${LEADER_COLL} — wrote ${foreignWrites}`);
  });

  await test("M3 loser full cycle (poll + recovery + wait-timeout) → only botworker_state ops", async () => {
    seedLeader("worker-A", { token: 7 });
    seedInbound("m_M3", "conv_M3");
    mocks.botworkerRuntime.ownerId = "worker-B";
    const ops = countOps();
    const r = await svc.pollNewMessages(SCOPE);
    const rec = await svc.botWorkerService.recoverStaleBuffers(SCOPE);
    // workflow timeout path is part of worker work — gated wrapper on the service surface
    const wt = await (svc.botWorkerService as any).checkWaitTimeouts?.();
    ops.stop();
    await settle();
    assert(r.found === 0 && r.processed === 0, `loser poll quiet — got ${r.found}/${r.processed}`);
    assert(rec.recovered === 0, `loser recovery quiet — got ${rec.recovered}`);
    assert(typeof wt === "number" && wt === 0, `loser wait-timeout must return 0, got ${wt}`);
    assert(state.calls.checkWaitTimeouts === 0,
      `inner timeout engine must not run for loser — ran ${state.calls.checkWaitTimeouts}x`);
    const foreign = ops.touched().filter((c) => c !== LEADER_COLL);
    assert(foreign.length === 0,
      `loser must not query messages/chat_processing/buffer_messages/workflow_runs — touched ${foreign}`);
    const l = leaderDocs()[0];
    assert(l?.owner_id === "worker-A" && l?.fencing_token === 7,
      `active leader doc must be untouched — got ${l?.owner_id}/${l?.fencing_token}`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
  });

  await test("M4 expired leader lease → B takeover once, stale A fenced out of new claims", async () => {
    seedLeader("worker-A", { expired: true, token: 7 });
    seedInbound("m_M4", "conv_M4");
    mocks.botworkerRuntime.ownerId = "worker-B";
    const rB = await svc.pollNewMessages(SCOPE);
    await settle();
    const l = leaderDocs()[0];
    assert(l?.owner_id === "worker-B" && l?.fencing_token === 8,
      `expired lease must transfer once — got ${l?.owner_id}/${l?.fencing_token} want worker-B/8`);
    assert(rB.found >= 1, `new leader must work, got found=${rB.found}`);
    seedInbound("m_M4b", "conv_M4");
    mocks.botworkerRuntime.ownerId = "worker-A"; // flip only after settle — B drained
    const rA = await svc.pollNewMessages(SCOPE);
    await settle();
    assert(rA.found === 0 && rA.processed === 0,
      `stale leader must be fenced — got found=${rA.found} processed=${rA.processed}`);
    assert(claimDocs("m_M4b").length === 0, `stale leader must not write claims`);
  });

  await test("M5 leader lost mid-era → re-poll quiet, no new claims, in-flight work intact", async () => {
    mocks.botworkerRuntime.ownerId = "worker-A";
    seedInbound("m_M5", "conv_M5");
    await svc.pollNewMessages(SCOPE);
    await settle();
    assert(leaderDocs()[0]?.owner_id === "worker-A", "A must hold leadership first");
    // B wins takeover (external CAS) — A's next cycle must see foreign lease and stop
    const stale = leaderDocs()[0];
    stale.owner_id = "worker-B"; stale.fencing_token = 2;
    stale.lease_expires_at = new Date(Date.now() + 60000);
    seedInbound("m_M5b", "conv_M5");
    const rA2 = await svc.pollNewMessages(SCOPE);
    await settle();
    assert(rA2.found === 0 && rA2.processed === 0,
      `stale leader re-poll must be quiet — got ${rA2.found}/${rA2.processed}`);
    assert(claimDocs("m_M5b").length === 0, "stale leader must not claim new inbound");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 (A's era work only)`);
  });

  await test("M6 leader lease lapses while process alive → same owner re-acquires once", async () => {
    mocks.botworkerRuntime.ownerId = "worker-A";
    seedInbound("m_M6", "conv_M6");
    await svc.pollNewMessages(SCOPE);
    await settle();
    const l = leaderDocs()[0];
    assert(l?.owner_id === "worker-A", "A must be leader");
    l.lease_expires_at = new Date(Date.now() - 1); // lease lapses between cycles
    seedInbound("m_M6b", "conv_M6");
    const rA2 = await svc.pollNewMessages(SCOPE);
    await settle();
    assert(rA2.found >= 1, `same-owner re-acquire must resume work, got found=${rA2.found}`);
    const l2 = leaderDocs()[0];
    assert(l2?.owner_id === "worker-A" && l2?.fencing_token === 2,
      `re-acquire must bump token once — got ${l2?.owner_id}/${l2?.fencing_token} want worker-A/2`);
  });

  await test("M7 in-flight claimed work survives leader loss; new work refused", async () => {
    state.callBotDelayMs = 120;
    mocks.botworkerRuntime.ownerId = "worker-A";
    seedInbound("m_M7", "conv_M7");
    await svc.pollNewMessages(SCOPE); // fires claim + in-flight bot call under A leadership
    const stale = leaderDocs()[0];
    assert(stale?.owner_id === "worker-A", "A must be leader before loss");
    stale.owner_id = "worker-B"; stale.fencing_token = 2; // external takeover mid-call
    stale.lease_expires_at = new Date(Date.now() + 60000);
    seedInbound("m_M7b", "conv_M7");
    const rA2 = await svc.pollNewMessages(SCOPE); // A may still be mid-call — must not start new work
    assert(rA2.found === 0, `leader-lost poll must refuse new work — found=${rA2.found}`);
    assert(claimDocs("m_M7b").length === 0, "no new claims after leadership loss");
    await settle();
    // in-flight claim work is owned by message-claim fencing — allowed to finalize once
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 (in-flight completes, not killed)`);
    assert(repliesFor("m_M7").length === 1, "in-flight reply must persist exactly once");
  });

  await test("M8 disable/shutdown cancels heartbeat → lease lapses → takeover once", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 80;
    mocks.botworkerRuntime.ownerId = "worker-A";
    await svc.pollNewMessages(SCOPE); // acquires leadership + arms heartbeat
    assert(leaderDocs()[0]?.owner_id === "worker-A", "A must hold leadership");
    svc.botWorkerService.clearPendingWork(); // falling edge / shutdown — heartbeat must die
    await sleep(140); // lease would be renewed if heartbeat survived
    const ok = await ensureLeadership("worker-B");
    const l = leaderDocs()[0];
    assert(ok !== false && l?.owner_id === "worker-B" && l?.fencing_token === 2,
      `dead heartbeat → lease lapses → takeover once — got ${ok} ${l?.owner_id}/${l?.fencing_token}`);
  });

  // ── harness meta + lifecycle pins ────────────────────────────

  await test("M-INT op instrumentation meta-test — per-event op→bucket classification", async () => {
    const coll = await mocks.getCollection("meta_probe");
    // exact contract — assert per-event observed bucket === expected (ไม่ใช่แค่ผลรวม
    //   เพราะ read/write สลับกันอย่างละหนึ่งอาจทำผลรวมผ่านได้)
    const BUCKETS: Record<string, "read" | "write"> = {
      find: "read", findOne: "read", countDocuments: "read", distinct: "read",
      aggregate: "read", estimatedDocumentCount: "read",
      insertOne: "write", updateOne: "write", updateMany: "write",
      findOneAndUpdate: "write", deleteOne: "write", deleteMany: "write",
    };
    const seen = new Set<string>();
    const observed: Record<string, string> = {};
    state.onQuery = (c: string, op: string) => {
      if (c !== "meta_probe") return;
      seen.add(op);
      observed[op] = READ_OPS.has(op) ? "read" : "write";
    };
    await coll.findOne({}); await coll.find({}).toArray();
    await coll.insertOne({ _id: "p1", x: 1 });
    await coll.insertMany([{ _id: "p2", x: 2 }]); // delegates → นับเป็น insertOne
    await coll.updateOne({ _id: "p1" }, { $set: { x: 2 } });
    await coll.updateMany({}, { $set: { y: 1 } });
    await coll.findOneAndUpdate({ _id: "p1" }, { $set: { z: 1 } });
    await coll.countDocuments({});
    await coll.distinct("x");
    await coll.estimatedDocumentCount();
    try { coll.aggregate(); } catch { /* unsupported in fake — attempt still counted */ }
    await coll.deleteOne({ _id: "p2" });
    await coll.deleteMany({});
    state.onQuery = null;
    for (const op of Object.keys(BUCKETS)) {
      assert(seen.has(op), `onQuery must fire for ${op} — saw [${[...seen].join(",")}]`);
      assert(observed[op] === BUCKETS[op],
        `op ${op} classified as ${observed[op]}, want ${BUCKETS[op]}`);
    }
  });

  // automatic heartbeat — real recovery path: stale claim + buffer row enter
  //   recoverStaleBuffers; a work-collection query is blocked > leaderLeaseMs so
  //   the process-owned heartbeat (armed on acquisition inside the recovery gate,
  //   NOT by this test) must renew the lease while recovery is still running
  await test("M9 automatic heartbeat — blocked recovery >lease keeps A, renews without test", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 80;
    mocks.botworkerRuntime.leaderHeartbeatMs = 20; // ~12 beats inside the 260ms block (≥3× margin)
    mocks.botworkerRuntime.ownerId = "worker-A";
    mocks.fakeColl("chat_processing").push(claimDoc("m_M9", { owner: "worker-A", expired: true, conv: "conv_M9" }));
    mocks.fakeColl("buffer_messages").push(bufferRowDoc("m_M9", "conv_M9"));
    // block the FIRST work-collection find inside recovery — heartbeat renewals
    //   (findOne/updateOne on LEADER_COLL) are unaffected by findHook
    let blocked = true;
    state.findHook = async (coll: string) => {
      if (blocked && coll !== LEADER_COLL) await sleep(260);
    };
    const recoveryDone = svc.botWorkerService.recoverStaleBuffers(SCOPE);
    await sleep(150); // mid-block — recovery still running, leaseMs(80) already passed
    const lMid = leaderDocs()[0];
    assert(lMid?.owner_id === "worker-A" && lMid?.fencing_token === 1,
      `mid-recovery leader must be A token 1 — got ${lMid?.owner_id}/${lMid?.fencing_token} (heartbeat did not auto-renew)`);
    assert((await ensureLeadership("worker-B")) === false,
      "B must stay fenced while A's heartbeat renews during blocked recovery");
    blocked = false;
    const rec = await recoveryDone;
    await settle();
    // ⚡ reconcile-only — expired claim settles dormant (provider=0, ไม่มี re-execution)
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — recovery must not execute`);
    const claims = claimDocs("m_M9");
    assert(claims.length === 1, `single claim doc — got ${claims.length}`);
    assert(claims[0].status === "bot_failed", `claim → bot_failed dormant, got ${claims[0].status}`);
    assert(claims[0].owner_id === "worker-A", `settle keeps last owner, got ${claims[0].owner_id}`);
    const row = mocks.fakeColl("buffer_messages").find((d: any) => d.message_id === "m_M9");
    assert(row?.status === "failed", `row → dormant failed, got ${row?.status}`);
    const l = leaderDocs()[0];
    assert(l?.owner_id === "worker-A" && l?.fencing_token === 1,
      `post-recovery leader must stay A token 1 — got ${l?.owner_id}/${l?.fencing_token}`);
  });

  await test("M10 heartbeat CAS-loss race — B takeover mid-renew → A stops, next admission scans nothing", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 60;
    mocks.botworkerRuntime.leaderHeartbeatMs = 15;
    mocks.botworkerRuntime.ownerId = "worker-A";
    await svc.pollNewMessages(SCOPE); // acquire + arm heartbeat
    assert(leaderDocs()[0]?.owner_id === "worker-A", "A must hold leadership");
    // inject B takeover precisely inside A's next renewal write (CAS filter now stale)
    let injected = false;
    const flip = (coll: string) => {
      if (injected || coll !== LEADER_COLL) return;
      injected = true;
      const d = leaderDocs()[0];
      if (d) { d.owner_id = "worker-B"; d.fencing_token = 2; d.lease_expires_at = new Date(Date.now() + 60000); }
    };
    state.updateOneHook = async (coll: string) => flip(coll);
    state.findOneAndUpdateHook = async (coll: string) => flip(coll);
    await sleep(120); // several beats at 15ms — A's renew must CAS-miss then stop
    state.updateOneHook = null; state.findOneAndUpdateHook = null;
    // heartbeat must be dead after loss — snapshot writes then verify silence
    const ops = countOps();
    await sleep(80); // >5× heartbeatMs — surviving heartbeat would keep writing
    const postLossWrites = ops.writes[LEADER_COLL] || 0;
    seedInbound("m_M10", "conv_M10");
    const rA = await svc.pollNewMessages(SCOPE);
    await settle();
    ops.stop();
    assert(postLossWrites === 0, `heartbeat must die on CAS loss — ${postLossWrites} renewal writes after loss`);
    assert(rA.found === 0, `post-loss admission must be quiet — found=${rA.found}`);
    const foreign = ops.touched().filter((c) => c !== LEADER_COLL);
    assert(foreign.length === 0, `post-loss admission must scan no work collections — touched ${foreign}`);
    assert(leaderDocs()[0]?.owner_id === "worker-B", "B's takeover doc must not be overwritten by stale A");
  });

  await test("M11 lifecycle cleanup — clearPendingWork kills heartbeat, zero post-cleanup writes", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 120;
    mocks.botworkerRuntime.leaderHeartbeatMs = 20;
    mocks.botworkerRuntime.ownerId = "worker-A";
    await svc.pollNewMessages(SCOPE); // acquires + arms heartbeat
    assert(leaderDocs()[0]?.owner_id === "worker-A", "A must hold leadership");
    svc.botWorkerService.clearPendingWork(); // disable/shutdown — heartbeat dies NOW
    const ops = countOps();
    await sleep(100); // >4× heartbeatMs — any surviving beat would write botworker_state
    ops.stop();
    assert((ops.writes[LEADER_COLL] || 0) === 0,
      `no renewal writes after cleanup — got ${ops.writes[LEADER_COLL]}`);
  });

  // ── BW-2 lifecycle review-fix: heartbeat renew-verb / timeout drain / same-process race ──

  // F1 — heartbeat renews ONLY the ctx captured at admission {owner_id, fencing_token};
  //   it must never takeover/reacquire — takeover is an admission-time operation
  await test("M12a heartbeat renew blocked → lease lapse + B takeover → stale heartbeat cannot renew/takeover", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 80;
    mocks.botworkerRuntime.leaderHeartbeatMs = 20;
    mocks.botworkerRuntime.ownerId = "worker-A";
    await svc.pollNewMessages(SCOPE); // acquire + arm ctx{worker-A,1}
    assert(leaderDocs()[0]?.owner_id === "worker-A", "A must be leader");
    // flag-gated block: renew's leadership findOne waits on `gate` while blockNew;
    //   blockNew=false lets OTHER (B's admission) findOne calls pass immediately
    let blockNew = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    state.findOneHook = async (coll: string) => { if (blockNew && coll === LEADER_COLL) await gate; };
    await sleep(60);  // ≥1 heartbeat beat is blocked inside its leadership findOne
    await sleep(120); // A's lease(80) lapses while its renew is blocked
    blockNew = false; // B's admission findOne must pass NOW (A's stays parked on gate)
    assert((await ensureLeadership("worker-B")) !== false, "B must take over lapsed lease");
    const tokB = leaderDocs()[0].fencing_token;
    release();
    state.findOneHook = null;
    const ops = countOps();
    await sleep(80); // >4× heartbeat — any surviving stale-ctx renewer would write
    ops.stop();
    const l = leaderDocs()[0];
    assert(l?.owner_id === "worker-B" && l?.fencing_token === tokB,
      `stale heartbeat must not renew/takeover B's lease — got ${l?.owner_id}/${l?.fencing_token}`);
    assert((ops.writes[LEADER_COLL] || 0) === 0,
      `post-release writes from stale heartbeat must be zero — got ${ops.writes[LEADER_COLL]}`);
  });

  await test("M12b stale heartbeat vs expired foreign lease → heartbeat must NOT reacquire (takeover = admission only)", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 60;
    mocks.botworkerRuntime.leaderHeartbeatMs = 15;
    mocks.botworkerRuntime.ownerId = "worker-A";
    await svc.pollNewMessages(SCOPE);
    assert(leaderDocs()[0]?.owner_id === "worker-A", "A must be leader");
    let blockNew = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    state.findOneHook = async (coll: string) => { if (blockNew && coll === LEADER_COLL) await gate; };
    await sleep(35);   // a heartbeat renew is blocked inside findOne
    await sleep(100);  // A's lease(60) lapses during the block
    blockNew = false;
    assert((await ensureLeadership("worker-B")) !== false, "B must take over lapsed lease");
    await sleep(90);   // B's lease(60) lapses too — doc is now expired FOREIGN
    release();         // A's stale renew resumes onto an expired foreign doc
    await sleep(60);
    state.findOneHook = null;
    const l = leaderDocs()[0];
    assert(l?.owner_id === "worker-B",
      `heartbeat is renew-only — stale beat must never takeover; got owner=${l?.owner_id}`);
  });

  await test("M12c clearPendingWork mid-heartbeat-op → zero post-cleanup renewal writes", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 90;
    mocks.botworkerRuntime.leaderHeartbeatMs = 20;
    mocks.botworkerRuntime.ownerId = "worker-A";
    await svc.pollNewMessages(SCOPE);
    let blockNew = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    state.findOneHook = async (coll: string) => { if (blockNew && coll === LEADER_COLL) await gate; };
    await sleep(45); // a heartbeat renew is blocked inside its findOne
    svc.botWorkerService.clearPendingWork(); // cleanup mid-op — heartbeat ctx invalidated
    blockNew = false; release();             // stale renew resumes post-cleanup
    const ops = countOps();
    await sleep(80); // >4× heartbeat — surviving renewal would write botworker_state
    ops.stop();
    assert((ops.writes[LEADER_COLL] || 0) === 0,
      `no renewal write may succeed after cleanup — got ${ops.writes[LEADER_COLL]}`);
  });

  // F2 — checkWaitTimeouts is top-level worker work: era-cancel + drain lifecycle
  await test("M13 checkWaitTimeouts blocked at gate + clearPendingWork → engine skipped, no heartbeat, drain waits", async () => {
    mocks.botworkerRuntime.leaderHeartbeatMs = 20;
    mocks.botworkerRuntime.ownerId = "worker-A";
    let blockNew = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    state.findOneHook = async (coll: string) => { if (blockNew && coll === LEADER_COLL) await gate; };
    const op = svc.botWorkerService.checkWaitTimeouts(SCOPE); // blocks inside leadership lookup
    await sleep(40);
    let drained = false;
    const drain = svc.botWorkerService.waitForInFlight(2000).then(() => { drained = true; });
    await sleep(40);
    assert(!drained, "waitForInFlight must wait the gated timeout op");
    svc.botWorkerService.clearPendingWork(); // era abort while admission still blocked
    blockNew = false; release();
    const wt = await op;
    await drain;
    assert(wt === 0, `aborted-era timeout op must return 0, got ${wt}`);
    assert(state.calls.checkWaitTimeouts === 0,
      `inner workflowEngine.checkWaitTimeouts must not run after abort — ran ${state.calls.checkWaitTimeouts}x`);
    assert(drained, "drain must complete once op resolves");
    const ops = countOps();
    await sleep(80); // >4× heartbeat — armed heartbeat would keep renewing
    ops.stop();
    assert((ops.writes[LEADER_COLL] || 0) === 0,
      `heartbeat must not stay armed after era abort — ${ops.writes[LEADER_COLL]} renewal writes`);
  });

  // F3 — same-process concurrent admission: two entries race an absent leader doc;
  //   the E11000 loser must re-read (bounded) and recognise its own process's lease
  await test("M14 same-process concurrent admission (poll+recovery) → one doc/token1, heartbeat survives", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 70;
    mocks.botworkerRuntime.leaderHeartbeatMs = 20;
    mocks.botworkerRuntime.ownerId = "worker-A";
    seedInbound("m_M14", "conv_M14");
    const [r, rec] = await Promise.all([
      svc.pollNewMessages(SCOPE),
      svc.botWorkerService.recoverStaleBuffers(SCOPE),
    ]);
    await settle();
    const leaders = leaderDocs();
    assert(leaders.length === 1 && leaders[0].owner_id === "worker-A" && leaders[0].fencing_token === 1,
      `single leader doc A/token1 — got ${leaders.length} docs ${leaders[0]?.owner_id}/${leaders[0]?.fencing_token}`);
    assert(r.found >= 1, `poll must admit — found=${r.found}`);
    assert(typeof rec.recovered === "number" && rec.recovered >= 0, "recovery must admit (not rejected)");
    await sleep(110); // >5× heartbeat — surviving heartbeat keeps lease ahead of now
    assert((leaderDocs()[0].lease_expires_at?.getTime() || 0) > Date.now(),
      "heartbeat must survive concurrent same-owner admission — lease lapsed");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — no duplicate work`);
  });

  // ── BW-2 final admission-race correction ────────────────────

  // F1 — `now` ต้องจับหลัง await findOne: lease อาจหมดระหว่าง DB read —
  //   stale clock ทำ renew ด้วย token เดิม + เขียน expiry ที่หมดไปแล้ว
  await test("M15 stale admission clock — leader findOne blocked past lease → expired admission must takeover (token+1) or return false", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 60;
    mocks.botworkerRuntime.ownerId = "worker-A";
    seedLeader("worker-A", { token: 5 });
    leaderDocs()[0].lease_expires_at = new Date(Date.now() + 60); // short lease — dies mid-read
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    state.findOneHook = async (coll: string) => {
      if (first && coll === LEADER_COLL) { first = false; await gate; } // park ONLY this read
    };
    const p = ensureLeadership("worker-A"); // its findOne is parked
    await sleep(140);                        // lease(60) lapses inside the blocked read
    release();
    const ok = await p;
    state.findOneHook = null;
    const l = leaderDocs()[0];
    // stale-clock renew would return ctx{token5} and write lease measured from
    //   pre-read time — already expired; contract: takeover (token 6) or false
    assert(ok === false || (l?.owner_id === "worker-A" && l?.fencing_token === 6),
      `expired-at-read lease must takeover token+1 or return false — got ok=${JSON.stringify(ok)} doc=${l?.owner_id}/${l?.fencing_token}`);
    if (ok !== false) {
      assert((l?.lease_expires_at?.getTime() || 0) > Date.now(),
        "new lease_expires_at must be computed from post-read time — got an already-dead lease");
    }
  });

  // F2 — `!ctx → stopLeaderHeartbeat()` lets a STALE loser wipe a ctx that a newer
  //   admission installed meanwhile: parked B-view admission resumes false AFTER
  //   the process re-acquired — its loss must not kill the armed heartbeat
  await test("M16 stale admission result must not kill newer ctx — loser resolves after re-arm, heartbeat keeps renewing", async () => {
    mocks.botworkerRuntime.leaderLeaseMs = 150;
    mocks.botworkerRuntime.leaderHeartbeatMs = 20;
    mocks.botworkerRuntime.ownerId = "worker-A";
    seedInbound("m_M16", "conv_M16");
    await svc.pollNewMessages(SCOPE); // A acquires ctx{A,1} + arms heartbeat
    await settle();
    assert(leaderDocs()[0]?.owner_id === "worker-A", "A must be leader");
    // op1 = stale admission under a foreign view — parks at the leader findOne
    mocks.botworkerRuntime.ownerId = "worker-B";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    state.findOneHook = async (coll: string) => {
      if (first && coll === LEADER_COLL) { first = false; await gate; }
    };
    const op1 = svc.pollNewMessages(SCOPE); // B-view admission parks inside ensureLeadership
    await sleep(50);                   // op1 parked; A's heartbeat keeps renewing meanwhile
    // same-process NEWER admission refreshes leaderCtx to a new {A,1} object
    mocks.botworkerRuntime.ownerId = "worker-A";
    const rec = await svc.botWorkerService.recoverStaleBuffers(SCOPE);
    assert(rec.recovered === 0, `no seeded work — recovery just re-arms ctx, got ${rec.recovered}`);
    release();                         // op1 resumes → reads {A,1} → foreign(B) → false
    const r1 = await op1;
    state.findOneHook = null;
    await settle();
    assert(r1.found === 0, `stale loser must stay quiet — found=${r1.found}`);
    const ops = countOps();
    await sleep(120); // >5× heartbeat — if op1's stale false killed the heartbeat, lease lapses
    ops.stop();
    const l = leaderDocs()[0];
    assert(l?.owner_id === "worker-A" && l?.fencing_token === 1,
      `newer ctx must survive stale false — got ${l?.owner_id}/${l?.fencing_token}`);
    assert((l?.lease_expires_at?.getTime() || 0) > Date.now(),
      "heartbeat must keep renewing after stale false — lease lapsed");
    assert((ops.writes[LEADER_COLL] || 0) > 0,
      "armed heartbeat must still be renewing — zero renewal writes observed");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — no duplicate work`);
  });

  // Task 4 — network trap proof: owner = test-botworker-idempotency-mocks.mjs
  //   (installed before production imports — fetch/http/https/socket must throw)
  await test("T0 network trap active — fetch/http/socket escape must fail fast", async () => {
    let hit = "";
    try { await fetch("http://127.0.0.1:1/blocked"); } catch (e: any) { if (/test-net-trap/.test(e?.message)) hit = "fetch"; }
    assert(hit === "fetch", "global fetch must be trapped");
    try { (await import("node:http")).request("http://127.0.0.1:1/x"); } catch (e: any) { if (/test-net-trap/.test(e?.message)) hit += ",http"; }
    assert(hit === "fetch,http", "http.request must be trapped");
    try { (await import("node:https")).request("https://127.0.0.1:1/x"); } catch (e: any) { if (/test-net-trap/.test(e?.message)) hit += ",https"; }
    assert(hit === "fetch,http,https", "https.request must be trapped");
    try { (await import("node:net")).connect({ host: "127.0.0.1", port: 1 }); } catch (e: any) { if (/test-net-trap/.test(e?.message)) hit += ",net"; }
    assert(hit === "fetch,http,https,net", "net.connect must be trapped");
    // net.Socket path แยกจาก net.connect — Socket.connect ต้องโดน trap เช่นกัน
    try { new (await import("node:net")).Socket().connect({ host: "127.0.0.1", port: 1 }); } catch (e: any) { if (/test-net-trap/.test(e?.message)) hit += ",socket"; }
    assert(hit === "fetch,http,https,net,socket", "Socket.connect must be trapped");
  });

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${pass} passed, ${fail} failed (of ${results.length})`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
