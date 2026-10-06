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
    created_timestamp: created,
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
  }
}

function reset() {
  mocks.resetState();
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
  const { state } = mocks;
  const runtime = mocks.botworkerRuntime;

  // ── A. polling / claim idempotency ─────────────────────────

  await test("A1 re-poll x100 while processing → single owner, one reply", async () => {
    state.callBotDelayMs = 200;
    seedInbound("m1", "conv_1");

    await svc.pollNewMessages();
    for (let i = 0; i < 99; i++) {
      await svc.pollNewMessages();
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

    await svc.pollNewMessages();
    await sleep(70); // flush เริ่มแล้ว — claim ของ m2 ยัง processing
    await svc.pollNewMessages();
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

    await svc.pollNewMessages();
    await sleep(30);
    await svc.pollNewMessages();
    await svc.pollNewMessages();
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

    await svc.pollNewMessages();
    await sleep(70);
    await svc.pollNewMessages();
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
        claim_id: CLAIM_ID(id), owner_id: runtime.ownerId, fencing_token: 1,
      });
    }

    const markStub = async () => {};
    const [r1, r2] = await Promise.all([
      buf.flushBuffer("conv_f", svc.processMessage, markStub),
      buf.flushBuffer("conv_f", svc.processMessage, markStub),
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

    await svc.pollNewMessages();
    await sleep(70);
    seedInbound("m10b", "conv_5", 11);
    await svc.pollNewMessages();
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

    await svc.pollNewMessages();
    await settle();

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — reply already persisted, reclaim must finalize claim without re-calling LLM`);
    const claims = claimDocs("m6");
    assert(claims.length === 1 && TERMINAL.has(claims[0].status), `claim finalized=${claims.map((d: any) => d.status)} want terminal`);
    assert(repliesFor("m6").length === 1, `replies(m6)=${repliesFor("m6").length} want 1 — must reuse existing reply`);
  });

  await test("C2 stale direct-claim → no recover while active, reclaim+process after expiry", async () => {
    seedInbound("m7", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("m7")); // lease active

    await svc.pollNewMessages();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — active lease must not be reprocessed`);

    claimDocs("m7")[0].lease_expires_at = new Date(Date.now() - 1000);
    state.callBotDelayMs = 10;
    await svc.pollNewMessages();
    await settle();

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — expired lease must reclaim and process`);
    const claims = claimDocs("m7");
    assert(claims.length === 1, `claim docs=${claims.length} want 1 — reclaim must UPDATE same _id`);
    assert(claims[0].attempt === 2, `attempt=${claims[0].attempt} want 2 (reclaim increments)`);
    assert(claims[0].fencing_token === 2, `fencing_token=${claims[0].fencing_token} want 2`);
    assert(claims[0].owner_id !== "worker-A", `owner must change on reclaim, got ${claims[0].owner_id}`);
    assert(TERMINAL.has(claims[0].status), `claim terminal, got ${claims[0].status}`);
  });

  await test("C3 stale worker fenced — terminal write with old owner/token matches nothing", async () => {
    seedInbound("m8", "conv_1");
    mocks.fakeColl("chat_processing").push(claimDoc("m8", { expired: true }));

    await svc.pollNewMessages();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);

    const coll = await mocks.getCollection("chat_processing");
    const res = await coll.updateOne(
      { _id: CLAIM_ID("m8"), owner_id: "worker-A", fencing_token: 1 },
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

    await svc.pollNewMessages();
    await settle();

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — attempt cap reached`);
    const claims = claimDocs("m10");
    assert(claims.length === 1 && claims[0].status === "bot_failed",
      `claim status=${claims[0]?.status} want bot_failed (attempts exhausted)`);

    // terminal → ห้าม recover อีก
    await svc.pollNewMessages();
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

    await svc.pollNewMessages();
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

    await svc.pollNewMessages();
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

    await svc.pollNewMessages();
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

    await svc.pollNewMessages();
    await settle();

    assert(state.calls.matchAndRun === 0, `matchAndRun=${state.calls.matchAndRun} want 0 — outcome recorded, no engine re-run`);
    assert(state.calls.handoffTest === 0, `handoffTest=${state.calls.handoffTest} want 0 — no re-assign`);
    const claims = claimDocs("d5");
    assert(claims.length === 1 && claims[0].status === "handed_off", `claim status=${claims[0]?.status} want handed_off`);
  });

  // ── E. outcome contract ทุก terminal branch (finding 3) ───

  await test("E1 bot answer → outcome bot_answered + 1 reply id", async () => {
    seedInbound("e1", "conv_1");
    await svc.pollNewMessages();
    await settle();
    const c = claimDocs("e1")[0];
    assert(c?.outcome_type === "bot_answered", `outcome_type=${c?.outcome_type} want bot_answered`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 1, `reply_ids want [1]`);
  });

  await test("E2 trigger bot_template → outcome trigger_matched + 1 reply id, no LLM", async () => {
    state.trigger = { trigger_id: "t_tpl", action: "bot_answer", bot_template: "canned reply" };
    seedInbound("e2", "conv_1");
    await svc.pollNewMessages();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 (template answers without LLM)`);
    const c = claimDocs("e2")[0];
    assert(c?.outcome_type === "trigger_matched", `outcome_type=${c?.outcome_type} want trigger_matched`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 1, `reply_ids want [1]`);
  });

  await test("E3 handoff → outcome handed_off + 0 reply ids + single side-effect record", async () => {
    state.trigger = { trigger_id: "t_ho", action: "handoff_admin" };
    seedInbound("e3", "conv_1");
    await svc.pollNewMessages();
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
    await svc.pollNewMessages();
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
    await svc.pollNewMessages();
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
    await svc.pollNewMessages();
    await settle();
    const c = claimDocs("e6")[0];
    assert(c?.outcome_type === "workflow_actioned", `outcome_type=${c?.outcome_type}`);
    assert(Array.isArray(c?.reply_ids) && c.reply_ids.length === 3, `reply_ids=${JSON.stringify(c?.reply_ids)} want [3]`);
  });

  await test("E7 bot error → outcome bot_failed, terminal, no auto-retry", async () => {
    state.callBotError = new Error("bot unavailable");
    seedInbound("e7", "conv_1");

    await svc.pollNewMessages();
    await settle();

    const claims = claimDocs("e7");
    assert(claims.length === 1, `claim docs=${claims.length} want 1`);
    assert(claims[0].status === "bot_failed", `status=${claims[0].status} want bot_failed`);
    assert(claims[0].outcome_type === "bot_failed", `outcome_type=${claims[0].outcome_type}`);

    state.callBotError = null;
    for (let i = 0; i < 3; i++) await svc.pollNewMessages();
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
  await test("G3 workflow crash before outcome → engine returns prior run (no re-assign)", async () => {
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

    await svc.pollNewMessages();
    await settle();

    const c = claimDocs("g3")[0];
    assert(c?.status === "handed_off", `claim status=${c?.status} want handed_off`);
    assert(state.calls.matchAndRun === 1, `matchAndRun calls=${state.calls.matchAndRun}`);
    assert(state.calls.workflowExec === 0, `workflowExec=${state.calls.workflowExec} want 0 — engine dedupe by operation_key`);
    assert(state.calls.handoffExec === 0, `handoffExec=${state.calls.handoffExec} want 0 — no re-assign`);
    assert(repliesFor("g3").length === 1, `replies(g3)=${repliesFor("g3").length} want 1 (idempotent re-persist)`);
    assert(c?.reply_ids?.[0] === WF_REPLY_ID("conv_1", ["g3"], 0), `reply_id=${c?.reply_ids?.[0]} want deterministic wf id`);
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

    await svc.pollNewMessages();
    await settle();

    const c = claimDocs("g4")[0];
    assert(c?.status === "workflow_resumed", `claim status=${c?.status} want workflow_resumed`);
    assert(c?.outcome_type === "workflow_resumed", `outcome_type=${c?.outcome_type}`);
    assert(c?.reply_ids?.length === 1 && c.reply_ids[0] === WF_REPLY_ID("conv_1", ["g4"], 0),
      `reply_ids=${JSON.stringify(c?.reply_ids)} want deterministic wf0`);
  });

  // G5. flush error → release lock + รักษา buffer rows (ข้อความไม่หาย)
  await test("G5 flush error releases lock and preserves buffer rows", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 40;
    state.conversationError = new Error("conversation service down");
    seedInbound("g5", "conv_e");

    await svc.pollNewMessages();
    await sleep(150);
    await settle(6);

    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.status === "buffered" && d.kind !== "conv_lock").length === 1,
      `buffered rows=${mocks.fakeColl("buffer_messages").length} want 1 preserved`);
    assert(lockDocs("conv_e").length === 0, `conv lock must be released on error, found ${lockDocs("conv_e").length}`);
    const c = claimDocs("g5")[0];
    assert(c && c.status === "processing", `claim status=${c?.status} want processing (recoverable, not lost)`);
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

    await svc.pollNewMessages();
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
  await test("H5 restart recovery → buffered batch processed as ONE batch before direct claims", async () => {
    state.config.bot_buffer_enabled = true;
    for (const id of ["h5a", "h5b", "h5c"]) {
      mocks.fakeColl("chat_processing").push(claimDoc(id, { conv: "conv_r", expired: true, batch: ["h5a", "h5b", "h5c"] }));
      mocks.fakeColl("buffer_messages").push({
        message_id: id, conversation_id: "conv_r", shop_id: "shop_1", platform: "shopee",
        text: `msg ${id}`, kind: "message", status: "buffered", received_at: new Date(),
        claim_id: CLAIM_ID(id), owner_id: "worker-A", fencing_token: 1,
      });
      seedInbound(id, "conv_r");
    }

    await svc.botWorkerService.recoverStaleBuffers();
    await settle();

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — 3 buffered msgs = ONE batch reply (direct-claim-first จะยิง 3)`);
    assert(repliesFor("h5a", "h5b", "h5c").length === 1, `batch reply=${repliesFor("h5a", "h5b", "h5c").length} want 1`);
    for (const id of ["h5a", "h5b", "h5c"]) {
      assert(TERMINAL.has(claimDocs(id)[0]?.status), `${id} claim must be terminal, got ${claimDocs(id)[0]?.status}`);
    }
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.status === "buffered").length === 0,
      `buffer rows must be deleted after batch finalize`);
  });

  // H6. flush ห้ามแย่ง active claim ของ owner อื่น — re-fence = expected owner/token หรือ expired เท่านั้น
  await test("H6 flush must not steal another owner's active claim", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("h6", { conv: "conv_f6", owner: "worker-B" })); // lease active
    mocks.fakeColl("buffer_messages").push({
      message_id: "h6", conversation_id: "conv_f6", shop_id: "shop_1", platform: "shopee",
      text: "msg", kind: "message", status: "buffered", received_at: new Date(),
      claim_id: CLAIM_ID("h6"), owner_id: "worker-B", fencing_token: 1,
    });

    const r = await buf.flushBuffer("conv_f6", svc.processMessage, async () => {});

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — foreign active claim must not join batch (${r.status})`);
    const c = claimDocs("h6")[0];
    assert(c.owner_id === "worker-B" && c.fencing_token === 1,
      `worker-B's claim must be untouched — got owner=${c.owner_id} fence=${c.fencing_token}`);
    const row = mocks.fakeColl("buffer_messages").find((d: any) => d.message_id === "h6");
    assert(row?.status === "buffered", `row must stay buffered for next round, got ${row?.status}`);
    assert(lockDocs("conv_f6").length === 0, `conv lock must be released`);
  });

  // H7. finalize ไม่สำเร็จครบ → ห้ามลบ rows (คืน buffered อย่างปลอดภัย)
  await test("H7 flush must not delete rows when finalize lost/partial", async () => {
    runtime.heartbeatMs = 25;
    runtime.claimLeaseMs = 5000;
    state.callBotDelayMs = 200;
    for (const id of ["h7a", "h7b"]) {
      mocks.fakeColl("chat_processing").push(claimDoc(id, { conv: "conv_h7", owner: runtime.ownerId }));
      mocks.fakeColl("buffer_messages").push({
        message_id: id, conversation_id: "conv_h7", shop_id: "shop_1", platform: "shopee",
        text: `msg ${id}`, kind: "message", status: "buffered", received_at: new Date(),
        claim_id: CLAIM_ID(id), owner_id: runtime.ownerId, fencing_token: 1,
      });
    }

    const run = buf.flushBuffer("conv_h7", svc.processMessage, async () => {});
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
    assert(rows.length === 2 && rows.every((d: any) => d.status === "buffered"),
      `rows must return buffered (not deleted) on lost finalize — got ${JSON.stringify(rows.map((d: any) => d.status))}`);
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

    await svc.pollNewMessages();
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

    await svc.pollNewMessages();
    await settle();

    const c = claimDocs("h9")[0];
    assert(c?.status === "bot_answered", `status=${c?.status} want bot_answered — valid slow response must not be bot_failed`);
  });

  // H10. flush error → schedule retry → ข้อความ process ภายหลัง (ไม่ใช่แค่ค้างอยู่)
  await test("H10 flush error schedules retry — message processed later", async () => {
    state.config.bot_buffer_enabled = true;
    state.config.bot_buffer_window_ms = 40;
    runtime.flushErrorRetryMs = 40;
    state.conversationError = new Error("conversation service down");
    seedInbound("h10", "conv_h10");

    await svc.pollNewMessages();
    await sleep(140);               // flush #1 fail แล้ว
    state.conversationError = null; // transient recovery
    await settle();

    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — retry must eventually process`);
    const c = claimDocs("h10")[0];
    assert(c && TERMINAL.has(c.status), `claim must be terminal after retry, got ${c?.status}`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.status === "buffered").length === 0,
      `buffer rows must be deleted after successful retry`);
  });

  // ── F. guard rails ─────────────────────────────────────────

  await test("F1 legacy terminal docs → backward-compat skip, no duplicate claim", async () => {
    mocks.fakeColl("chat_processing").push(
      { message_id: "legacy1", conversation_id: "conv_1", shop_id: "s1", platform: "shopee", status: "bot_answered", processed_at: new Date() },
      { message_id: "legacy1", conversation_id: "conv_1", shop_id: "s1", platform: "shopee", status: "bot_answered", processed_at: new Date() },
    );
    seedInbound("legacy1", "conv_1");

    await svc.pollNewMessages();
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

    await svc.botWorkerService.recoverStaleBuffers();

    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — disabled worker must not recover/flush`);
    assert(mocks.fakeColl("buffer_messages").filter((d: any) => d.status === "buffered").length === 1, `stale buffer flushed while disabled`);
    assert(claimDocs("m11").length === 0, `must not create claim while disabled`);
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
