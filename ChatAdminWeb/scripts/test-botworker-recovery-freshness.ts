// test-botworker-recovery-freshness.ts — recovery = reconciliation-only (Phase 2D)
//
// รัน: npx tsx scripts/test-botworker-recovery-freshness.ts
//
// Contract (PART 6): recovery ต้องไม่ invoke provider เลย —
//   claim missing   → orphan row delete
//   claim terminal  → bot_failed: ต่ำกว่า cap → row dormant "failed" · cap → "quarantined"
//                     outcome อื่น → delete row (งานจบแล้ว)
//   claim processing → active lease → leave + deferred wake-up (reconcile รอบถัดไป)
//                      expired → claimMessage owner เดียว reconcile:
//                      evidence → finalize-only · ไม่มี → settle bot_failed dormant
//   dormant failed rows → ไม่แตะ — inbound ใหม่ distinct เท่านั้นที่ carry-forward
//
// ห้าม hardcode incident ids/conversations — synthetic docs เท่านั้น

import { register } from "node:module";
import { createHash } from "node:crypto";

register(new URL("./test-botworker-idempotency-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-botworker-idempotency-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mocks: Mocks;
let svc: Svc;
let seq = 0;
// ⚡ Phase 2D — required cycle-scope snapshot (fixtures ทั้งหมดอยู่ใน shop_1/shopee)
let SCOPE: import("../src/backend/service/botworkerRuntime").BotworkerCycleScope;

const CLAIM_ID = (mid: string) => `botworker:claim:${mid}`;
const BATCH_ID = (conv: string, ids: string[]) =>
  "botworker:batch:" +
  createHash("sha256").update(JSON.stringify(["shopee", "shop_1", conv, ...[...ids].sort()])).digest("hex").slice(0, 32);

const DAY = 24 * 3600 * 1000;
const YEAR = 365 * DAY;

function seedInbound(messageId: string, conversationId: string) {
  mocks.fakeColl("messages").push({
    message_id: messageId, conversation_id: conversationId, shop_id: "shop_1",
    platform: "shopee", role: "user", direction: "in", type: "text",
    text: `inbound ${messageId}`, created_timestamp: new Date(++seq),
  });
}

interface ClaimOpts {
  conv: string; batch: string[];
  owner?: string; token?: number; attempt?: number;
  expired?: boolean; leaseMs?: number;           // leaseMs>0 → active lease
  status?: string; outcome_type?: string; reply_ids?: string[];
}
function claimDoc(mid: string, o: ClaimOpts) {
  const now = Date.now();
  return {
    _id: CLAIM_ID(mid), message_id: mid, conversation_id: o.conv,
    shop_id: "shop_1", platform: "shopee", status: o.status || "processing",
    owner_id: o.owner || "worker-dead", fencing_token: o.token ?? 1, attempt: o.attempt ?? 1,
    claimed_at: new Date(now - 2000),
    lease_expires_at: o.leaseMs ? new Date(now + o.leaseMs) : new Date(now - 1000),
    batch_id: BATCH_ID(o.conv, o.batch), updated_at: new Date(now - 2000),
    ...(o.outcome_type ? { outcome_type: o.outcome_type } : {}),
    ...(o.reply_ids ? { reply_ids: o.reply_ids } : {}),
  };
}

function seedReplyEnvelope(mid: string, conv: string, batch: string[], outcome = "bot_answered") {
  const batchId = BATCH_ID(conv, batch);
  mocks.fakeColl("shadow_replies").push({
    _id: `botworker:reply:${batchId}`,
    conversation_id: conv, batch_id: batchId,
    inbound_message_ids: batch, inbound_message_id: batch[0],
    outcome_envelope: { outcome_type: outcome },
    origin: "worker", mode: "standalone",
  });
  return `botworker:reply:${batchId}`;
}

function bufferRow(mid: string, conv: string, opts: { status?: string; owner?: string; token?: number; receivedAgoMs?: number; msgCreated?: Date } = {}) {
  return {
    message_id: mid, conversation_id: conv, shop_id: "shop_1", platform: "shopee",
    text: `msg ${mid}`, kind: "message", status: opts.status || "buffered",
    received_at: new Date(Date.now() - (opts.receivedAgoMs ?? 2000)),
    // ⚡ admission proof — recovery classifier settles pre-cutoff ordinary rows
    //   as terminal no_action (not dormant); post-cutoff → dormant as before
    msg_created_at: opts.msgCreated ?? new Date(), admitted_edge: new Date(0),
    claim_id: CLAIM_ID(mid), owner_id: opts.owner || "worker-dead", fencing_token: opts.token ?? 1,
  };
}

async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    await svc.waitForInFlight(80).catch(() => {});
    await sleep(30);
    if (mocks.state.calls.botInFlight === 0) return;
  }
}

const bufRows = (conv: string) =>
  mocks.fakeColl("buffer_messages").filter((d: any) => d.conversation_id === conv && d.kind !== "conv_lock");
const claimOf = (mid: string) =>
  mocks.fakeColl("chat_processing").find((d: any) => d._id === CLAIM_ID(mid));
const replyInboundIds = (conv: string) =>
  mocks.fakeColl("shadow_replies")
    .filter((d: any) => d.conversation_id === conv)
    .flatMap((d: any) => d.inbound_message_ids || (d.inbound_message_id ? [d.inbound_message_id] : []));

const results: { name: string; ok: boolean; err?: string }[] = [];
async function test(name: string, fn: () => Promise<void>) {
  mocks.resetState();
  mocks.state.config.bot_worker_enabled = true;
  mocks.state.config.bot_buffer_enabled = true;
  mocks.state.config.bot_buffer_window_ms = 7000;
  mocks.state.config.bot_buffer_window_media_ms = 7000;
  mocks.state.config.bot_buffer_max_messages = 10;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  } finally {
    try { (svc.botWorkerService as any).clearPendingWork?.(); } catch {}
    try { await svc.botWorkerService.waitForInFlight?.(2000); } catch {}
  }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
const recover = () => svc.botWorkerService.recoverStaleBuffers(SCOPE);

async function main() {
  mocks = await import("./test-botworker-idempotency-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  const { state } = mocks;
  SCOPE = { config: mocks.state.config as never, global_enabled_since: new Date(0), pairs: [{ platform: "shopee", shop_id: "shop_1", cutoff: new Date(0) }] };

  // ═══ RC — reconcile matrix (provider=0 เสมอ) ═══

  // RC1 — expired buffered claim + ไม่มี evidence → settle dormant หน่วยเดียว
  await test("RC1 expired buffered claim no evidence → claim bot_failed + row dormant failed", async () => {
    for (const id of ["rc1a", "rc1b", "rc1c"]) {
      mocks.fakeColl("chat_processing").push(claimDoc(id, { conv: "conv_rc1", batch: ["rc1a", "rc1b", "rc1c"] }));
      mocks.fakeColl("buffer_messages").push(bufferRow(id, "conv_rc1"));
      seedInbound(id, "conv_rc1");
    }
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — recovery must not execute`);
    for (const id of ["rc1a", "rc1b", "rc1c"]) {
      const c = claimOf(id);
      assert(c?.status === "bot_failed", `${id} claim → bot_failed, got ${c?.status}`);
      assert(c?.error === "interrupted_before_durable_outcome", `${id} error=${c?.error}`);
      assert(c?.owner_id === "worker-dead" && c?.fencing_token === 1,
        `${id} settle must not re-fence — owner=${c?.owner_id} f=${c?.fencing_token}`);
    }
    const rows = bufRows("conv_rc1");
    assert(rows.length === 3 && rows.every((r: any) => r.status === "failed"),
      `rows → dormant failed (payload retained), got ${JSON.stringify(rows.map((r: any) => r.status))}`);
  });

  // RC2 — expired claim + persisted outcome_type → finalize-only + row deleted
  await test("RC2 expired claim + outcome_type → finalize-only, row deleted", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rc2", { conv: "conv_rc2", batch: ["rc2"], outcome_type: "bot_answered", reply_ids: ["r_x"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc2", "conv_rc2"));
    seedInbound("rc2", "conv_rc2");
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("rc2");
    assert(c?.status === "bot_answered", `claim → bot_answered (recorded outcome), got ${c?.status}`);
    assert(bufRows("conv_rc2").length === 0, "row deleted after finalize-only");
  });

  // RC3 — expired claim + persisted reply (envelope) → finalize-only via envelope
  await test("RC3 expired claim + persisted reply → finalize via outcome envelope", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("rc3", { conv: "conv_rc3", batch: ["rc3"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc3", "conv_rc3"));
    seedReplyEnvelope("rc3", "conv_rc3", ["rc3"], "trigger_matched");
    seedInbound("rc3", "conv_rc3");
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — reply persisted → no LLM`);
    const c = claimOf("rc3");
    assert(c?.status === "trigger_matched", `claim → trigger_matched (envelope), got ${c?.status}`);
    assert(c?.reply_ids?.length === 1, `reply_ids=${JSON.stringify(c?.reply_ids)} want [persisted id]`);
    assert(bufRows("conv_rc3").length === 0, "row deleted after finalize");
  });

  // RC4 — expired claim เกิน attempt cap → bot_failed + row quarantined
  await test("RC4 expired claim at attempt cap → bot_failed + row quarantined", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rc4", { conv: "conv_rc4", batch: ["rc4"], attempt: mocks.botworkerRuntime.maxClaimAttempts }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc4", "conv_rc4"));
    seedInbound("rc4", "conv_rc4");
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assert(claimOf("rc4")?.status === "bot_failed", `claim → bot_failed, got ${claimOf("rc4")?.status}`);
    const row = bufRows("conv_rc4")[0];
    assert(row?.status === "quarantined", `row → quarantined (cap exhausted), got ${row?.status}`);
  });

  // RC5 — active foreign lease → untouched + deferred pass reconcile หลัง expiry
  await test("RC5 active foreign lease → untouched; deferred pass settles after expiry", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rc5", { conv: "conv_rc5", batch: ["rc5"], leaseMs: 400 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc5", "conv_rc5"));
    seedInbound("rc5", "conv_rc5");
    await recover();
    await settle();
    const c0 = claimOf("rc5");
    assert(c0?.status === "processing" && c0?.owner_id === "worker-dead",
      `active lease must be untouched, got ${c0?.status}/${c0?.owner_id}`);
    assert(bufRows("conv_rc5").length === 1 && bufRows("conv_rc5")[0].status === "buffered",
      "row stays buffered while lease active");
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    // deferred wake-up (~lease 400 + slack) → reconcile รอบถัดไป settle dormant
    await sleep(1200);
    await settle();
    const c = claimOf("rc5");
    assert(c?.status === "bot_failed", `deferred pass must settle dormant, got ${c?.status}`);
    assert(bufRows("conv_rc5")[0]?.status === "failed",
      `row → dormant failed after deferred reconcile, got ${bufRows("conv_rc5")[0]?.status}`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — deferred pass is reconcile-only`);
  });

  // RC6 — orphan row (claim missing) → delete
  await test("RC6 orphan buffer row (no claim) → deleted", async () => {
    mocks.fakeColl("buffer_messages").push(bufferRow("rc6", "conv_rc6"));
    seedInbound("rc6", "conv_rc6");
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assert(bufRows("conv_rc6").length === 0, "orphan row must be deleted");
  });

  // RC7 — terminal claim + leftover row → row deleted
  await test("RC7 terminal claim + leftover row → row deleted", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rc7", { conv: "conv_rc7", batch: ["rc7"], status: "bot_answered" }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc7", "conv_rc7"));
    seedInbound("rc7", "conv_rc7");
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assert(bufRows("conv_rc7").length === 0, "leftover row must be deleted — work already terminal");
    assert(claimOf("rc7")?.status === "bot_answered", "terminal claim untouched");
  });

  // RC8 — dormant failed (bot_failed claim + failed row) → ไม่แตะ
  await test("RC8 dormant failed batch → left untouched, provider=0", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rc8", { conv: "conv_rc8", batch: ["rc8"], status: "bot_failed" }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc8", "conv_rc8", { status: "failed" }));
    seedInbound("rc8", "conv_rc8");
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — dormant batch must not wake`);
    assert(bufRows("conv_rc8")[0]?.status === "failed", "dormant row stays failed");
    assert(claimOf("rc8")?.status === "bot_failed", "dormant claim stays bot_failed");
  });

  // RC9 — quarantined row → ไม่แตะ
  await test("RC9 quarantined row → left untouched", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rc9", { conv: "conv_rc9", batch: ["rc9"], status: "bot_failed", attempt: 5 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc9", "conv_rc9", { status: "quarantined" }));
    seedInbound("rc9", "conv_rc9");
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assert(bufRows("conv_rc9")[0]?.status === "quarantined", "quarantined row stays terminal");
  });

  // RC10 — self-owned active lease (ไม่ใช่ in-flight) → untouched (defer)
  await test("RC10 self-owned active lease → untouched while lease alive", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rc10", { conv: "conv_rc10", batch: ["rc10"], owner: mocks.botworkerRuntime.ownerId, leaseMs: 30000 }));
    mocks.fakeColl("buffer_messages").push(
      bufferRow("rc10", "conv_rc10", { owner: mocks.botworkerRuntime.ownerId }));
    seedInbound("rc10", "conv_rc10");
    await recover();
    await settle();
    const c = claimOf("rc10");
    assert(c?.status === "processing", `active self lease must be left, got ${c?.status}`);
    assert(bufRows("conv_rc10")[0]?.status === "buffered", "row stays buffered");
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
  });

  // RC11 — expired direct claim (ไม่มี row) → settle bot_failed
  await test("RC11 expired direct claim no row → settle bot_failed", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("rc11", { conv: "conv_rc11", batch: ["rc11"] }));
    seedInbound("rc11", "conv_rc11");
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("rc11");
    assert(c?.status === "bot_failed" && c?.error === "interrupted_before_durable_outcome",
      `claim → bot_failed dormant, got ${c?.status}/${c?.error}`);
  });

  // RC12 — settle CAS lost (foreign ชนะกลาง classify) → ไม่เขียนทับ
  await test("RC12 settle CAS lost → no overwrite, foreign winner kept", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("rc12", { conv: "conv_rc12", batch: ["rc12"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc12", "conv_rc12"));
    seedInbound("rc12", "conv_rc12");
    let flipped = false;
    (state as any).findOneHook = async (coll: string, filter: any) => {
      // claimMessage อ่าน doc แล้ว → foreign ชนะก่อน settle CAS
      if (!flipped && coll === "chat_processing" && filter?._id === CLAIM_ID("rc12")) {
        flipped = true;
        const d = claimOf("rc12")!;
        d.owner_id = "worker-B"; d.fencing_token = 9;
        d.lease_expires_at = new Date(Date.now() + 60000);
      }
    };
    await recover();
    await settle();
    const c = claimOf("rc12");
    assert(c?.owner_id === "worker-B" && c?.fencing_token === 9,
      `foreign winner must not be overwritten, got ${c?.owner_id}/${c?.fencing_token}`);
    assert(c?.status === "processing", `foreign claim stays processing, got ${c?.status}`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
  });

  // RC13 — x20 repeated passes → provider=0, stable idempotent
  await test("RC13 x20 repeated recovery → provider=0, state stable", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("rc13", { conv: "conv_rc13", batch: ["rc13"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc13", "conv_rc13"));
    seedInbound("rc13", "conv_rc13");
    for (let i = 0; i < 20; i++) await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 across 20 passes`);
    assert(claimOf("rc13")?.status === "bot_failed", "claim dormant");
    assert(bufRows("conv_rc13")[0]?.status === "failed", "row dormant failed");
    // pass ที่ 21 — state ไม่เปลี่ยน (idempotent)
    const before = JSON.stringify({ c: claimOf("rc13"), r: bufRows("conv_rc13") });
    await recover();
    assert(JSON.stringify({ c: claimOf("rc13"), r: bufRows("conv_rc13") }) === before,
      "repeated pass must be state-stable");
  });

  // RC14 — out-of-scope shop → ไม่ถูก scan/แตะ
  await test("RC14 out-of-scope shop rows → not scanned or mutated", async () => {
    mocks.fakeColl("chat_processing").push({
      ...claimDoc("rc14", { conv: "conv_rc14", batch: ["rc14"] }), shop_id: "shop_out",
    });
    mocks.fakeColl("buffer_messages").push({
      ...bufferRow("rc14", "conv_rc14"), shop_id: "shop_out",
    });
    await recover();
    await settle();
    const c = claimOf("rc14");
    assert(c?.status === "processing" && c?.owner_id === "worker-dead",
      `out-of-scope claim must be untouched, got ${c?.status}`);
    assert(bufRows("conv_rc14")[0]?.status === "buffered", "out-of-scope row untouched");
  });

  // RC15 — one-year historical state → dormant settle, provider=0
  await test("RC15 one-year-old claims+rows → dormant settle, provider=0", async () => {
    for (const id of ["h1", "h2"]) {
      mocks.fakeColl("chat_processing").push({
        ...claimDoc(id, { conv: "conv_hist", batch: ["h1", "h2"] }),
        claimed_at: new Date(Date.now() - YEAR),
        lease_expires_at: new Date(Date.now() - YEAR),
      });
      mocks.fakeColl("buffer_messages").push(bufferRow(id, "conv_hist", { receivedAgoMs: YEAR }));
      seedInbound(id, "conv_hist");
    }
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — historical must not execute`);
    assert(bufRows("conv_hist").every((r: any) => r.status === "failed"), "historical rows → dormant failed");
    assert(claimOf("h1")?.status === "bot_failed" && claimOf("h2")?.status === "bot_failed",
      "historical claims → bot_failed dormant");
  });

  // RC16 — in-flight real work → recovery ไม่แตะ → work completes once
  await test("RC16 recovery during in-flight batch → untouched, completes once", async () => {
    mocks.state.config.bot_buffer_max_messages = 1; // immediate flush
    (state as any).callBotDelayMs = 300;
    seedInbound("rc16", "conv_rc16");
    await svc.botWorkerService.pollNewMessages(SCOPE);
    for (let i = 0; i < 100 && state.calls.botInFlight === 0; i++) await sleep(10);
    assert(state.calls.botInFlight === 1, "in-flight provider call must be running");
    await recover(); // recovery กลาง in-flight — ต้องไม่แตะ
    await svc.botWorkerService.waitForInFlight(3000);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — no duplicate from recovery`);
    assert(claimOf("rc16")?.status !== "processing", `claim terminal, got ${claimOf("rc16")?.status}`);
    assert(replyInboundIds("conv_rc16").length === 1, "exactly one reply");
  });

  // RC17 — global disabled scope → pass ข้ามทั้งหมด
  await test("RC17 disabled global → pass scans nothing", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("rc17", { conv: "conv_rc17", batch: ["rc17"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rc17", "conv_rc17"));
    seedInbound("rc17", "conv_rc17");
    const offScope = { ...SCOPE, config: { ...mocks.state.config, bot_worker_enabled: false } as never };
    await svc.botWorkerService.recoverStaleBuffers(offScope);
    await settle();
    assert(claimOf("rc17")?.status === "processing", "disabled era must not touch claims");
    assert(bufRows("conv_rc17")[0]?.status === "buffered", "disabled era must not touch rows");
  });

  // RC18 — reconcile ไม่ทิ้ง in-flight residue → drain returns promptly
  await test("RC18 reconcile leaves no in-flight residue — drain returns promptly", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("rc18", { conv: "conv_rc18", batch: ["rc18"] }));
    seedInbound("rc18", "conv_rc18");
    await recover();
    await settle();
    assert(claimOf("rc18")?.status === "bot_failed", "claim dormant");
    const t0 = Date.now();
    await svc.botWorkerService.waitForInFlight(1000);
    const elapsed = Date.now() - t0;
    assert(elapsed < 500, `drain must return promptly after reconcile (took ${elapsed}ms)`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
  });

  // ═══ ERA — abort/cancellation contract ═══

  // E1 — abort กลาง classify → ห้าม write; work คง recoverable → pass ถัดไป settle
  await test("E1 abort mid-classify → no writes, recoverable, next pass settles dormant", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("e1", { conv: "conv_e1", batch: ["e1"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("e1", "conv_e1"));
    seedInbound("e1", "conv_e1");
    let fired = false;
    (state as any).findOneHook = async (coll: string, filter: any) => {
      if (!fired && coll === "chat_processing" && filter?._id === CLAIM_ID("e1")) {
        fired = true;
        (svc.botWorkerService as any).clearPendingWork();
      }
    };
    await recover();
    await settle();
    assert(fired, "abort must fire inside classifier");
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c0 = claimOf("e1");
    assert(c0?.status === "processing" && c0?.owner_id === "worker-dead",
      `claim must stay recoverable (untouched), got ${c0?.status}`);
    await sleep(300); // cancelled era ห้ามฝาก deferred/timer rerun
    assert(state.calls.callBot === 0, "no phantom work after abort");
    // pass ใหม่ (era ใหม่) → reconcile → dormant
    await recover();
    await settle();
    assert(claimOf("e1")?.status === "bot_failed", `next pass settles dormant, got ${claimOf("e1")?.status}`);
    assert(bufRows("conv_e1")[0]?.status === "failed", "row dormant failed");
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — reconcile provider=0`);
  });

  // E2 — abort กลาง claimMessage read → settle CAS ห้ามยิง
  await test("E2 abort inside claimMessage read → no settle/reclaim write", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("e2", { conv: "conv_e2", batch: ["e2"] }));
    seedInbound("e2", "conv_e2");
    let fired = false;
    (state as any).findOneHook = async (coll: string, filter: any) => {
      if (!fired && coll === "chat_processing" && filter?._id === CLAIM_ID("e2")) {
        fired = true;
        (svc.botWorkerService as any).clearPendingWork();
      }
    };
    await recover();
    await settle();
    assert(fired, "abort must fire inside claimMessage ownership read");
    const c = claimOf("e2")!;
    assert(c.owner_id === "worker-dead" && c.fencing_token === 1 && (c.attempt ?? 1) === 1 && c.status === "processing",
      `claim mutated after abort — owner=${c.owner_id} f=${c.fencing_token} attempt=${c.attempt} status=${c.status}`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    await recover();
    await settle();
    assert(claimOf("e2")?.status === "bot_failed", `next pass settles dormant, got ${claimOf("e2")?.status}`);
  });

  // E3 — caller join ระหว่าง aborted run → ห้ามชุบ cancelled era
  await test("E3 post-abort joiner must not resurrect cancelled era", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("e3", { conv: "conv_e3", batch: ["e3"] }));
    seedInbound("e3", "conv_e3");
    let releaseFind!: () => void;
    const gate = new Promise<void>((r) => { releaseFind = r; });
    (state as any).findOneHook = async (coll: string, filter: any) => {
      if (coll === "chat_processing" && filter?._id === CLAIM_ID("e3")) await gate;
    };
    const passP = recover();
    await sleep(60); // pass ค้างใน claim findOne
    (svc.botWorkerService as any).clearPendingWork();
    const joinP = recover(); // joiner ตอน era ตาย → ห้ามชุบ
    releaseFind();
    await passP; await joinP; await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    await sleep(300);
    assert(state.calls.callBot === 0, "queued rerun in dead era must not start a new pass");
    // era ใหม่ explicit → settle dormant
    await recover();
    await settle();
    assert(claimOf("e3")?.status === "bot_failed", `new era settles dormant, got ${claimOf("e3")?.status}`);
  });

  // E4 — clearPendingWork ยกเลิก deferred timer → ห้ามมี pass ซ่อนมาภายหลัง
  await test("E4 shutdown cancels deferred wake-up — no hidden reconcile pass", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("e4", { conv: "conv_e4", batch: ["e4"], leaseMs: 300 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("e4", "conv_e4"));
    seedInbound("e4", "conv_e4");
    await recover(); // pass defer ~lease 300 + slack
    const c0 = claimOf("e4");
    assert(c0?.status === "processing", "active lease → deferred wake-up armed");
    (svc.botWorkerService as any).clearPendingWork(); // shutdown — cancel deferred
    await sleep(1000); // เกิน defer window — timer ถูกยกเลิก → ห้าม settle เอง
    const c = claimOf("e4");
    assert(c?.status === "processing",
      `cancelled deferred pass must not settle — got ${c?.status}`);
    assert(bufRows("conv_e4")[0]?.status === "buffered", "row untouched after cancelled defer");
  });

  // E5 — disabled config ใน scope snapshot → pass ข้ามทั้งหมด
  await test("E5 disabled era config → recovery pass is a no-op", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("e5", { conv: "conv_e5", batch: ["e5"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("e5", "conv_e5"));
    mocks.state.config.bot_worker_enabled = false;
    await recover();
    await settle();
    assert(claimOf("e5")?.status === "processing", "disabled era must not touch claims");
    assert(bufRows("conv_e5")[0]?.status === "buffered", "disabled era must not touch rows");
  });

  // ═══ N — normal lifecycle (shutdown/drain/next-era) ═══

  // N1 — debounce flush ที่ fire ก่อน shutdown ตายเงียบ → row/claim recoverable →
  //   pass ถัดไป settle dormant (ไม่ใช่ process)
  await test("N1 debounce callback dies quietly post-shutdown → next pass reconciles dormant", async () => {
    mocks.state.config.bot_buffer_window_ms = 60;
    seedInbound("n1", "conv_n1");
    let finds = 0;
    (state as any).onQuery = (coll: string, op: string) => {
      if (coll === "buffer_messages" && op === "find" && ++finds === 2) {
        (state as any).queryDelayMs = 300;
        (svc.botWorkerService as any).clearPendingWork();
      }
    };
    await svc.botWorkerService.pollNewMessages(SCOPE);
    for (let i = 0; i < 200 && finds < 2; i++) await sleep(10);
    assert(finds === 2, "debounce flush ต้องเริ่มแล้วและค้างใน buffer read");
    (state as any).queryDelayMs = 0;
    await sleep(500);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — fired callback dies with era`);
    assert(replyInboundIds("conv_n1").length === 0, "no reply after abort");
    // claim ยัง processing → expire → next pass settle dormant
    mocks.fakeColl("chat_processing").forEach((d: any) => {
      d.lease_expires_at = new Date(Date.now() - 1000);
    });
    await recover();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — reconcile provider=0`);
    assert(claimOf("n1")?.status === "bot_failed", `claim → dormant, got ${claimOf("n1")?.status}`);
    assert(bufRows("conv_n1")[0]?.status === "failed", "row → dormant failed");
  });

  // N2 — normal retry callback (lock-held recheck) ตายเงียบหลัง shutdown
  await test("N2 lock-recheck callback started pre-shutdown dies quietly, no new timer", async () => {
    mocks.state.config.bot_buffer_window_ms = 60;
    seedInbound("n2", "conv_n2");
    mocks.fakeColl("buffer_messages").push({ // foreign ACTIVE lock → flush แพ้ → recheck armed
      _id: mocks.convLockIdFor("shopee", "shop_1", "conv_n2"),
      kind: "conv_lock", conversation_id: "conv_n2", shop_id: "shop_1", platform: "shopee",
      status: "locked", owner_id: "worker-x", fencing_token: 1,
      lease_expires_at: new Date(Date.now() + 30_000), updated_at: new Date(),
    });
    await svc.botWorkerService.pollNewMessages(SCOPE);
    for (let i = 0; i < 100 && bufRows("conv_n2").length === 0; i++) await sleep(10);
    assert(bufRows("conv_n2").length === 1, "row buffered + debounce armed");
    await sleep(140); // debounce flush(~60) แพ้ lock → recheck(50ms) armed
    (state as any).queryDelayMs = 400;
    await sleep(80); // recheck fired → ค้างใน read
    const li = mocks.fakeColl("buffer_messages").findIndex((d: any) => d.kind === "conv_lock");
    mocks.fakeColl("buffer_messages").splice(li, 1);
    let postAbortFinds = 0;
    (svc.botWorkerService as any).clearPendingWork();
    (state as any).onQuery = (coll: string, op: string) => {
      if (coll === "buffer_messages" && op === "find") postAbortFinds++;
    };
    (state as any).queryDelayMs = 0;
    await sleep(500);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — recheck must carry era signal`);
    assert(postAbortFinds === 0, `postAbortFinds=${postAbortFinds} want 0 — ห้ามมี timer ยิงหลัง shutdown`);
    assert(replyInboundIds("conv_n2").length === 0, "no reply after abort");
  });

  // N3 — timer-launched flush ที่เริ่มแล้วต้อง drain ก่อน shutdown จบ
  await test("N3 already-started timer flush drains before shutdown returns", async () => {
    mocks.state.config.bot_buffer_window_ms = 60;
    (state as any).callBotDelayMs = 500;
    seedInbound("n3", "conv_n3");
    await svc.botWorkerService.pollNewMessages(SCOPE);
    for (let i = 0; i < 100 && bufRows("conv_n3").length === 0; i++) await sleep(10);
    for (let i = 0; i < 100 && state.calls.botInFlight === 0; i++) await sleep(10);
    assert(state.calls.botInFlight === 1, "callBot in-flight จาก timer-launched flush");
    (svc.botWorkerService as any).clearPendingWork();
    let drained = false;
    const w = svc.botWorkerService.waitForInFlight(3000).then(() => { drained = true; });
    await sleep(150);
    assert(!drained, "waitForInFlight returned while timer-launched flush still processing");
    await w;
    assert(drained, "drain completes after callBot finishes");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
    assert(replyInboundIds("conv_n3").length === 1, "exactly one reply — finalize ครั้งเดียว");
  });

  // N4 — flush ที่เริ่มแล้ว finalize miss หลัง shutdown → ไม่มี retry ใหม่;
  //   persisted reply → pass ถัดไป finalize-only (provider=0)
  await test("N4 post-shutdown finalize-miss → no zombie retry; reply → finalize-only next pass", async () => {
    mocks.state.config.bot_buffer_max_messages = 1;
    mocks.botworkerRuntime.heartbeatMs = 60_000;
    (state as any).callBotDelayMs = 300;
    seedInbound("n4", "conv_n4");
    await svc.botWorkerService.pollNewMessages(SCOPE);
    for (let i = 0; i < 100 && state.calls.botInFlight === 0; i++) await sleep(10);
    assert(state.calls.botInFlight === 1, "flush เริ่มแล้ว — callBot ค้าง");
    claimOf("n4")!.fencing_token += 1; // partial finalize post-shutdown → CAS miss
    (svc.botWorkerService as any).clearPendingWork();
    let postAbortFinds = 0;
    (state as any).onQuery = (coll: string, op: string, filter: any) => {
      if (coll === "buffer_messages" && op === "find" && filter?.conversation_id === "conv_n4") postAbortFinds++;
    };
    await svc.botWorkerService.waitForInFlight(3000);
    await sleep(300);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — started work finishes`);
    assert(postAbortFinds === 0, `postAbortFinds=${postAbortFinds} want 0 — cancelled era ห้ามฝาก retry timer`);
    // persisted reply → expire lease → pass ถัดไป finalize-only + row deleted
    mocks.fakeColl("chat_processing").forEach((d: any) => {
      d.lease_expires_at = new Date(Date.now() - 1000);
    });
    await recover();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — persisted reply → finalize-only`);
    assert(replyInboundIds("conv_n4").length === 1, "exactly one reply");
    assert(claimOf("n4")?.status !== "processing", `claim finalized, got ${claimOf("n4")?.status}`);
    assert(bufRows("conv_n4").length === 0, "row cleaned by next-era recovery");
  });

  // N5 — normal regression: debounce merge + immediate max flush ไม่เปลี่ยน
  await test("N5 normal regression — debounce merge + immediate max flush unchanged", async () => {
    mocks.state.config.bot_buffer_window_ms = 80;
    seedInbound("n5a", "conv_n5a");
    seedInbound("n5b", "conv_n5a");
    await svc.botWorkerService.pollNewMessages(SCOPE);
    for (let i = 0; i < 100 && bufRows("conv_n5a").length < 2; i++) await sleep(10);
    await sleep(140);
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — debounce merge เป็น batch เดียว`);
    assert(replyInboundIds("conv_n5a").length === 2, "reply covers both inbound ids");
    mocks.state.config.bot_buffer_max_messages = 1;
    seedInbound("n5c", "conv_n5c");
    await svc.botWorkerService.pollNewMessages(SCOPE);
    await settle();
    assert(state.calls.callBot === 2, `callBot=${state.calls.callBot} want 2 — max-message flush ทันที`);
    assert(replyInboundIds("conv_n5c").length === 1, "second conv replied once");
  });

  // N6 — shutdown กลาง poll Mongo wait → drain รอ parent; ไม่มี post-shutdown writes
  await test("N6 shutdown mid-poll Mongo wait → drain waits parent, no new era work", async () => {
    seedInbound("n6", "conv_n6");
    let findIssued = false;
    let releaseFind: (() => void) | undefined;
    const gate = new Promise<void>((r) => (releaseFind = r));
    (state as any).onQuery = (coll: string, op: string) => {
      if (coll === "messages" && op === "find") findIssued = true;
    };
    (state as any).findHook = async (coll: string) => {
      if (coll === "messages") await gate;
    };
    try {
      const pollP = svc.botWorkerService.pollNewMessages(SCOPE);
      for (let i = 0; i < 200 && !findIssued; i++) await sleep(10);
      assert(findIssued, "poll must be mid inbound find when shutdown lands");
      svc.botWorkerService.clearPendingWork();
      let drainReturned = false;
      const drainP = svc.botWorkerService.waitForInFlight(10000).then(() => { drainReturned = true; });
      await sleep(60);
      const drainEarly = drainReturned;
      (state as any).findHook = null;
      releaseFind!();
      const res = await pollP;
      await drainP;
      assert(!drainEarly, "waitForInFlight returned while parent poll still mid-query");
      assert(res.processed === 0, `processed=${res.processed} — aborted era must kick nothing`);
      assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
      assert(claimOf("n6") === undefined, "no claim doc may be created post-shutdown");
      assert(bufRows("conv_n6").length === 0, "no buffer row may be created post-shutdown");
      assert(replyInboundIds("conv_n6").length === 0, "no shadow reply post-shutdown");
    } finally {
      (state as any).findHook = null;
      releaseFind?.();
    }
  });

  // N7 — explicit next era: poll หลัง shutdown ต้องทำงานครบ once
  await test("N7 explicit next era after shutdown → poll processes once", async () => {
    mocks.state.config.bot_buffer_window_ms = 60;
    seedInbound("n7", "conv_n7");
    const res = await svc.botWorkerService.pollNewMessages(SCOPE);
    assert(res.processed === 1, `processed=${res.processed} want 1 — explicit poll must kick`);
    for (let i = 0; i < 100 && state.calls.callBot === 0; i++) await sleep(10);
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
    assert(replyInboundIds("conv_n7").length === 1, "one reply");
    assert(claimOf("n7") !== undefined && claimOf("n7")!.status !== "processing", "claim terminal");
    assert(bufRows("conv_n7").length === 0, "row consumed");
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} passed ===`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
