// test-botworker-recovery-freshness.ts — boot-recovery per-row freshness gate (Incident Closure)
//
// รัน: npx tsx scripts/test-botworker-recovery-freshness.ts
//
// ปัญหา (audit จริง): recoverStaleBuffers flush ทุก buffered row ไม่ดูอายุ,
//   recoverStaleClaims reclaim ทุก expired claim ไม่ดูอายุ —
//   pre-boot/disabled-era backlog auto-flush ตอน enable (เหตุการณ์จริง)
//
// Policy (per-row, minimal — implemented + pinned ที่นี่):
//   FRESH_MS = max(bufferWindowMs, bufferWindowMediaMs) + claimLeaseMs + 60s grace
//   row fresh ⟺ received_at valid Date ใน window  AND  claim ที่ผูก fresh
//             (claim.claimed_at valid Date ใน window; claim missing/terminal → ไม่ fresh)
//   stale row → CAS claim → no_action/outcome_type=no_action/error=stale_at_recovery
//               → CAS สำเร็จแล้วค่อย delete buffer row (claim = audit evidence)
//               → logAdminEvent (count + hash-safe metadata)
//   mixed conv → recover เฉพาะ fresh member IDs (stale ถูกกำจัดก่อน flush — ไม่มี
//               buffer status ใหม่ ไม่แตะ schema)
//   fresh path ทั้งหมดเหมือนเดิม
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

const CLAIM_ID = (mid: string) => `botworker:claim:${mid}`;
const BATCH_ID = (conv: string, ids: string[]) =>
  "botworker:batch:" +
  createHash("sha256").update(JSON.stringify(["shopee", "shop_1", conv, ...[...ids].sort()])).digest("hex").slice(0, 32);

const DAY = 24 * 3600 * 1000;
const MIN = 60 * 1000;

function seedInbound(messageId: string, conversationId: string) {
  mocks.fakeColl("messages").push({
    message_id: messageId, conversation_id: conversationId, shop_id: "shop_1",
    platform: "shopee", role: "user", direction: "in", type: "text",
    text: `inbound ${messageId}`, created_timestamp: ++seq,
  });
}

interface ClaimOpts {
  conv: string; batch: string[]; claimedAgoMs?: number | null;
  outcome_type?: string; reply_ids?: string[]; status?: string;
}
function claimDoc(mid: string, o: ClaimOpts) {
  const now = Date.now();
  return {
    _id: CLAIM_ID(mid), message_id: mid, conversation_id: o.conv,
    shop_id: "shop_1", platform: "shopee", status: o.status || "processing",
    owner_id: "worker-dead", fencing_token: 1, attempt: 1,
    ...(o.claimedAgoMs === null ? {} : { claimed_at: new Date(now - (o.claimedAgoMs ?? 0)) }),
    lease_expires_at: new Date(now - 1000),            // expired → stale-claim path
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

function bufferRow(mid: string, conv: string, receivedAgoMs: number | null) {
  return {
    message_id: mid, conversation_id: conv, shop_id: "shop_1", platform: "shopee",
    text: `msg ${mid}`, kind: "message", status: "buffered",
    ...(receivedAgoMs === null ? {} : { received_at: new Date(Date.now() - receivedAgoMs) }),
    claim_id: CLAIM_ID(mid), owner_id: "worker-dead", fencing_token: 1,
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
    // module-level pending timers (buffer/retry/deferred) ห้ามรั่วข้าม test
    try { (svc.botWorkerService as any).clearPendingWork?.(); } catch {}
    // drain in-flight poll p's — fire-and-forget claim/process chains ต้องไม่ข้าม resetState
    try { await svc.botWorkerService.waitForInFlight?.(2000); } catch {}
  }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
function assertStaleSettled(mid: string, conv: string) {
  const c = claimOf(mid);
  assert(c?.status === "no_action" && c?.outcome_type === "no_action" && c?.error === "stale_at_recovery",
    `${mid} claim must settle no_action+stale_at_recovery, got status=${c?.status} outcome=${c?.outcome_type} err=${c?.error}`);
  assert(bufRows(conv).every((r: any) => r.message_id !== mid), `${mid} buffer row must be deleted after claim terminal`);
}

async function main() {
  mocks = await import("./test-botworker-idempotency-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  const { state } = mocks;

  // R1 [RED] — stale batch (24h): no bot, claims→no_action, rows deleted
  await test("R1 stale batch → quarantine (claim terminal + row delete), no bot", async () => {
    for (const id of ["s1a", "s1b", "s1c"]) {
      mocks.fakeColl("chat_processing").push(claimDoc(id, { conv: "conv_s", batch: ["s1a", "s1b", "s1c"], claimedAgoMs: DAY }));
      mocks.fakeColl("buffer_messages").push(bufferRow(id, "conv_s", DAY));
      seedInbound(id, "conv_s");
    }
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    for (const id of ["s1a", "s1b", "s1c"]) assertStaleSettled(id, "conv_s");
    assert(state.events.some((e: any) => e.admin && /quarantine|stale/i.test(e.action_type || "")),
      "admin event for stale quarantine must be logged");
  });

  // R2 [pin] — fresh batch recovers as ONE batch (unchanged)
  await test("R2 fresh batch recovers as ONE batch", async () => {
    for (const id of ["f1a", "f1b", "f1c"]) {
      mocks.fakeColl("chat_processing").push(claimDoc(id, { conv: "conv_f", batch: ["f1a", "f1b", "f1c"], claimedAgoMs: 5000 }));
      mocks.fakeColl("buffer_messages").push(bufferRow(id, "conv_f", 2000));
      seedInbound(id, "conv_f");
    }
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — fresh batch`);
    assert(bufRows("conv_f").length === 0, "fresh rows finalized/deleted");
  });

  // R3 [RED] — stale direct claim (no buffer row) → no_action, no bot
  await test("R3 stale direct claim → no_action terminal, no bot", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("d1", { conv: "conv_d", batch: ["d1"], claimedAgoMs: DAY }));
    seedInbound("d1", "conv_d");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("d1");
    assert(c?.status === "no_action" && c?.error === "stale_at_recovery",
      `want no_action+stale_at_recovery, got ${c?.status}/${c?.error}`);
  });

  // R4 [pin] — fresh direct claim (60s, lease expired) still resumes
  await test("R4 fresh direct claim still recovers", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("d2", { conv: "conv_d2", batch: ["d2"], claimedAgoMs: MIN }));
    seedInbound("d2", "conv_d2");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
  });

  // R5 [RED] — mixed conv: stale row+claim + fresh row+claim → batch = fresh only
  await test("R5 mixed conv → recover ONLY fresh member IDs", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("mx_f", { conv: "conv_mx", batch: ["mx_f"], claimedAgoMs: 5000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("mx_f", "conv_mx", 2000));
    seedInbound("mx_f", "conv_mx");
    mocks.fakeColl("chat_processing").push(claimDoc("mx_s", { conv: "conv_mx", batch: ["mx_s"], claimedAgoMs: DAY }));
    mocks.fakeColl("buffer_messages").push(bufferRow("mx_s", "conv_mx", DAY));
    seedInbound("mx_s", "conv_mx");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — only fresh member`);
    const ids = replyInboundIds("conv_mx");
    assert(ids.length === 1 && ids[0] === "mx_f",
      `batch must contain only fresh IDs, got inbound=[${ids.join(",")}]`);
    assertStaleSettled("mx_s", "conv_mx");
    assert(bufRows("conv_mx").length === 0, "all rows gone (fresh finalized + stale deleted)");
  });

  // R6 [RED] — missing received_at → unprovable → stale
  await test("R6 row missing received_at → no bot (stale)", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("nr1", { conv: "conv_nr", batch: ["nr1"], claimedAgoMs: 5000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("nr1", "conv_nr", null));
    seedInbound("nr1", "conv_nr");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assertStaleSettled("nr1", "conv_nr");
  });

  // R7 [RED] — fresh row + claim missing claimed_at → no bot
  await test("R7 fresh row + claim missing claimed_at → no bot", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("nc1", { conv: "conv_nc", batch: ["nc1"], claimedAgoMs: null }));
    mocks.fakeColl("buffer_messages").push(bufferRow("nc1", "conv_nc", 2000));
    seedInbound("nc1", "conv_nc");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assertStaleSettled("nc1", "conv_nc");
  });

  // R8 [RED] — fresh row + stale claim → no bot
  await test("R8 fresh row + stale claim → no bot", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("fs1", { conv: "conv_fs", batch: ["fs1"], claimedAgoMs: DAY }));
    mocks.fakeColl("buffer_messages").push(bufferRow("fs1", "conv_fs", 2000));
    seedInbound("fs1", "conv_fs");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assertStaleSettled("fs1", "conv_fs");
  });

  // R9 [RED] — stale row + fresh claim → no bot
  await test("R9 stale row + fresh claim → no bot", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("sf1", { conv: "conv_sf", batch: ["sf1"], claimedAgoMs: 5000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("sf1", "conv_sf", DAY));
    seedInbound("sf1", "conv_sf");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assertStaleSettled("sf1", "conv_sf");
  });

  // R10 [pin] — stale direct claim + outcome_type → finalize ORIGINAL outcome (evidence > freshness)
  await test("R10 stale direct claim + outcome_type → finalize original, no bot", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("ev1", { conv: "conv_ev", batch: ["ev1"], claimedAgoMs: DAY, outcome_type: "bot_answered", reply_ids: ["r1"] }));
    seedInbound("ev1", "conv_ev");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("ev1");
    assert(c?.status === "bot_answered", `must finalize ORIGINAL outcome bot_answered, got ${c?.status} (not no_action)`);
  });

  // R11 [pin] — stale direct claim + persisted reply envelope → finalize from envelope
  await test("R11 stale claim + persisted reply envelope → finalize, no bot", async () => {
    const rid = seedReplyEnvelope("ev2", "conv_ev2", ["ev2"]);
    mocks.fakeColl("chat_processing").push(claimDoc("ev2", { conv: "conv_ev2", batch: ["ev2"], claimedAgoMs: DAY }));
    seedInbound("ev2", "conv_ev2");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("ev2");
    assert(c?.status === "bot_answered" && (c?.reply_ids || []).includes(rid),
      `must finalize from reply envelope, got ${c?.status} replies=${JSON.stringify(c?.reply_ids)}`);
  });

  // R12 [RED] — buffered row + processing claim WITH committed outcome → finalize-only, no batch entry
  await test("R12 stale buffered row + committed-outcome claim → finalize + delete row, no bot", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("ev3", { conv: "conv_ev3", batch: ["ev3"], claimedAgoMs: DAY, outcome_type: "bot_answered", reply_ids: ["r3"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("ev3", "conv_ev3", DAY));
    seedInbound("ev3", "conv_ev3");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — committed evidence must never re-execute`);
    const c = claimOf("ev3");
    assert(c?.status === "bot_answered", `must finalize original outcome, got ${c?.status}`);
    assert(bufRows("conv_ev3").length === 0, "row must be deleted after finalize");
  });

  // R13 — terminal claim + leftover buffer row → delete row, no bot, no new processing
  await test("R13 terminal claim + leftover buffer row → delete row, no bot", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("t1", { conv: "conv_t", batch: ["t1"], claimedAgoMs: DAY, status: "bot_answered" }));
    mocks.fakeColl("buffer_messages").push(bufferRow("t1", "conv_t", DAY));
    seedInbound("t1", "conv_t");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assert(bufRows("conv_t").length === 0, "leftover row must be deleted (claim already terminal)");
    const c = claimOf("t1");
    assert(c?.status === "bot_answered", `terminal claim untouched, got ${c?.status}`);
  });

  // R14 — missing claim + buffer row → delete row + audit event, NO new claim doc
  await test("R14 missing claim + buffer row → delete row + audit event, no new doc", async () => {
    mocks.fakeColl("buffer_messages").push(bufferRow("or1", "conv_or", DAY));
    seedInbound("or1", "conv_or");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assert(bufRows("conv_or").length === 0, "orphan row must be deleted");
    assert(!claimOf("or1"), "must NOT create a new chat_processing doc for orphan row");
    assert(state.events.some((e: any) => e.admin && /quarantine|orphan|stale/i.test(e.action_type || "")),
      "admin audit event for orphan row must be logged");
  });

  // R15 — CAS lost (concurrent owner finalized between read and CAS) → re-read พิสูจน์
  //   claim terminal → row เป็น leftover ของ winner → delete (exact-identity CAS)
  await test("R15 quarantine CAS lost → claim terminal verified → row deleted, no bot", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("cs1", { conv: "conv_cs", batch: ["cs1"], claimedAgoMs: DAY }));
    mocks.fakeColl("buffer_messages").push(bufferRow("cs1", "conv_cs", DAY));
    seedInbound("cs1", "conv_cs");
    // concurrent finalizer: quarantine CAS (error=stale_at_recovery) เข้ามาก่อน → flip claim terminal ก่อน CAS ทำงาน
    (state as any).updateOneHook = async (coll: string, _f: unknown, update: any) => {
      if (coll === "chat_processing" && update?.$set?.error === "stale_at_recovery") {
        const d = claimOf("cs1");
        if (d && d.status === "processing") d.status = "bot_answered";
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    assert(claimOf("cs1")?.status === "bot_answered", "concurrent winner's terminal state preserved");
    assert(bufRows("conv_cs").length === 0,
      `claim terminal → leftover row must be deleted via exact-identity CAS, got ${bufRows("conv_cs").length} rows`);
  });

  // R16 [RED] — stale direct claim + outcome_type + NO inbound → finalize ORIGINAL outcome
  //   (evidence ต้องมาก่อน inbound lookup — inbound หายห้ามทับเป็น bot_failed)
  await test("R16 stale claim + outcome_type + NO inbound → finalize original, no bot", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("nx1", { conv: "conv_nx", batch: ["nx1"], claimedAgoMs: DAY, outcome_type: "bot_answered", reply_ids: ["rx1"] }));
    // ไม่ seedInbound — inbound doc หายไปแล้ว
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("nx1");
    assert(c?.status === "bot_answered",
      `must finalize ORIGINAL outcome bot_answered, got ${c?.status} (bot_failed/stale_at_recovery = regression)`);
  });

  // R17 [RED] — stale direct claim + persisted reply envelope + NO inbound → finalize envelope
  await test("R17 stale claim + persisted reply + NO inbound → finalize envelope, no bot", async () => {
    const rid = seedReplyEnvelope("nx2", "conv_nx2", ["nx2"]);
    mocks.fakeColl("chat_processing").push(claimDoc("nx2", { conv: "conv_nx2", batch: ["nx2"], claimedAgoMs: DAY }));
    // ไม่ seedInbound
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("nx2");
    assert(c?.status === "bot_answered" && (c?.reply_ids || []).includes(rid),
      `must finalize from envelope, got ${c?.status} replies=${JSON.stringify(c?.reply_ids)}`);
  });

  // R18 [pin] — fresh direct claim + no evidence + NO inbound → bot_failed (behavior เดิม)
  await test("R18 fresh claim + no evidence + NO inbound → bot_failed (unchanged)", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("nx3", { conv: "conv_nx3", batch: ["nx3"], claimedAgoMs: MIN }));
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("nx3");
    assert(c?.status === "bot_failed" && c?.error === "inbound message missing at recovery",
      `want bot_failed/inbound missing, got ${c?.status}/${c?.error}`);
  });

  // R19 [RED] — audit accuracy: evidence_finalized นับทั้ง buffered (P3) และ direct path
  await test("R19 evidence_finalized metadata counts buffered + direct paths", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("fa1", { conv: "conv_fa", batch: ["fa1"], claimedAgoMs: DAY, outcome_type: "bot_answered", reply_ids: ["ra1"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("fa1", "conv_fa", DAY));
    mocks.fakeColl("chat_processing").push(
      claimDoc("fa2", { conv: "conv_fa2", batch: ["fa2"], claimedAgoMs: DAY, outcome_type: "bot_answered", reply_ids: ["ra2"] }));
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const evt: any = state.events.find((e: any) => e.admin && e.action_type === "bot.recovery_quarantine");
    assert(!!evt, "bot.recovery_quarantine audit event must fire");
    assert(evt.metadata?.evidence_finalized === 2,
      `evidence_finalized must count buffered(1)+direct(1), got ${evt?.metadata?.evidence_finalized}`);
  });

  // ── R20–R23: liveness — evidence พบใน read แรก แต่ claimMessage คืน "claimed"
  //   (reply_ids มีแต่ไม่มี outcome_type/persisted reply → reclaim แล้วเจอ evidence หาย)
  //   ctx ใหม่ (fencing/lease หลัง reclaim) ต้องถูกใช้ต่อ — ห้ามใช้ snapshot token เก่า

  // R20 [RED] — stale claim, evidence หายหลัง reclaim, no inbound → no_action + ไม่ค้าง processing
  await test("R20 stale claim, evidence gone after reclaim, no inbound → no_action terminal", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("la1", { conv: "conv_la", batch: ["la1"], claimedAgoMs: DAY, reply_ids: ["ghost_r"] }));
    // ไม่ seedInbound — inbound หาย
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("la1");
    assert(c?.status === "no_action" && c?.error === "stale_at_recovery",
      `must settle no_action+stale_at_recovery via ownedCtx fence, got ${c?.status}/${c?.error} — claim must NOT stay processing`);
  });

  // R21 [RED] — fresh claim, evidence หายหลัง reclaim, inbound missing → bot_failed + ไม่ค้าง
  await test("R21 fresh claim, evidence gone after reclaim, no inbound → bot_failed terminal", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("lb1", { conv: "conv_lb", batch: ["lb1"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("lb1");
    assert(c?.status === "bot_failed" && c?.error === "inbound message missing at recovery",
      `must finalize bot_failed via ownedCtx fence (lease active after reclaim → expired-lease filter misses), got ${c?.status}/${c?.error}`);
  });

  // R22 [pin/RED] — fresh claim, evidence หายหลัง reclaim, inbound exists → process ด้วย reclaimed ctx
  await test("R22 fresh claim, evidence gone after reclaim, inbound exists → process once, terminal", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("lc1", { conv: "conv_lc", batch: ["lc1"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    seedInbound("lc1", "conv_lc");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — reclaimed ctx processes inbound`);
    const c = claimOf("lc1");
    assert(c?.status !== "processing", `claim must reach terminal, got ${c?.status}`);
    assert(c?.fencing_token === 2, `reclaim happened exactly once (fencing 1→2), got ${c?.fencing_token}`);
  });

  // R23 [pin] — concurrent winner ทำ terminal หลัง reclaim → ห้ามทับ + stats ห้ามนับ
  await test("R23 fencing loss after reclaim → no terminal overwrite, no overcount", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("ld1", { conv: "conv_ld", batch: ["ld1"], claimedAgoMs: DAY, reply_ids: ["ghost_r"] }));
    let flipped = false;
    // concurrent winner: หลัง reclaim (fencing 1→2) แต่ก่อน stale-settle → flip terminal+owner
    (state as any).findOneHook = async (coll: string) => {
      const d = claimOf("ld1");
      if (!flipped && coll === "shadow_replies" && d?.fencing_token === 2 && d?.status === "processing") {
        d.status = "bot_answered"; d.owner_id = "worker-other"; d.fencing_token = 9;
        flipped = true;
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(flipped, "concurrent flip must have happened post-reclaim");
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("ld1");
    assert(c?.status === "bot_answered" && c?.owner_id === "worker-other" && c?.fencing_token === 9,
      `concurrent winner must not be overwritten, got ${c?.status}/${c?.owner_id}/f${c?.fencing_token}`);
    const evt: any = state.events.find((e: any) => e.admin && e.action_type === "bot.recovery_quarantine");
    assert(!evt || evt.metadata?.stale_claims === 0,
      `lost CAS must not count as stale, got stale_claims=${evt?.metadata?.stale_claims}`);
  });

  // ── R24–R27: buffered claimed-evidence liveness — classifier ได้ "claimed"
  //   (evidence read-1 = reply_ids ghost, claimMessage re-read ไม่เจอ → reclaim คืน ctx ใหม่)
  //   res.ctx ต้องถูกใช้ต่อ — ห้าม "leave" ทิ้ง row+claim ค้างข้าม restart

  // R24 [RED] — stale buffered claim + ghost reply_ids → claimed → stale → no_action + delete row
  await test("R24 stale buffered claim, claimed-after-evidence → no_action + row deleted", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("ba1", { conv: "conv_ba", batch: ["ba1"], claimedAgoMs: DAY, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("ba1", "conv_ba", DAY));
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("ba1");
    assert(c?.status === "no_action" && c?.error === "stale_at_recovery",
      `must settle no_action via res.ctx fence, got ${c?.status}/${c?.error} — must NOT stay processing`);
    assert(bufRows("conv_ba").length === 0, "buffer row must be deleted after successful finalize");
    const evt: any = state.events.find((e: any) => e.admin && e.action_type === "bot.recovery_quarantine");
    assert(evt?.metadata?.stale_claims === 1, `stale_claims must count 1, got ${evt?.metadata?.stale_claims}`);
  });

  // R25 [RED] — fresh buffered claim + ghost → claimed → sync row fencing → batch flush once
  await test("R25 fresh buffered claim, claimed-after-evidence → row fencing synced → processed once", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("bb1", { conv: "conv_bb", batch: ["bb1"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("bb1", "conv_bb", 2000));
    seedInbound("bb1", "conv_bb");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — synced row must flush`);
    const c = claimOf("bb1");
    assert(c?.status !== "processing", `claim must be terminal, got ${c?.status}`);
    assert(bufRows("conv_bb").length === 0, "row must be consumed by flush");
    assert(c?.fencing_token === 3,
      `reclaim(1→2) + flushBuffer re-fence(2→3) per contract, got ${c?.fencing_token}`);
    const ids = replyInboundIds("conv_bb");
    assert(ids.filter((x: string) => x === "bb1").length === 1, `exactly one reply for bb1, got ${JSON.stringify(ids)}`);
  });

  // R26 [pin] — concurrent winner flip หลัง reclaim → fenced finalize miss → leave, no overwrite
  await test("R26 buffered post-reclaim fencing loss → no overwrite, no overcount", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("bc1", { conv: "conv_bc", batch: ["bc1"], claimedAgoMs: DAY, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("bc1", "conv_bc", DAY));
    let flipped = false;
    (state as any).findOneHook = async (coll: string) => {
      const d = claimOf("bc1");
      if (!flipped && coll === "shadow_replies" && d?.fencing_token === 2 && d?.status === "processing") {
        d.status = "bot_answered"; d.owner_id = "worker-other"; d.fencing_token = 9;
        flipped = true;
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(flipped, "concurrent flip must fire post-reclaim");
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    const c = claimOf("bc1");
    assert(c?.status === "bot_answered" && c?.owner_id === "worker-other" && c?.fencing_token === 9,
      `concurrent winner must be preserved, got ${c?.status}/${c?.owner_id}/f${c?.fencing_token}`);
    const evt: any = state.events.find((e: any) => e.admin && e.action_type === "bot.recovery_quarantine");
    assert(!evt || evt.metadata?.stale_claims === 0,
      `lost finalize must not count stale, got ${evt?.metadata?.stale_claims}`);
  });

  // R27 [RED→fixed] — row status flip (buffered→processing) ก่อน sync, owner/token เดิม
  //   → reconcile: claim ยังเป็น ownedCtx + row identity เดิม → repair → flush → terminal
  //   (ก่อนแก้: row=processing + claim=processing owned by us, ไม่มี timer — stuck ถาวร)
  await test("R27 row status flip before sync (same owner/token) → repair → flush once, terminal", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("bd1", { conv: "conv_bd", batch: ["bd1"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("bd1", "conv_bd", 2000));
    seedInbound("bd1", "conv_bd");
    // status flip เท่านั้น — owner_id/fencing_token ของ row คงเดิม (transient grab, claim fencing authoritative)
    (state as any).updateOneHook = async (coll: string, _f: unknown, update: any) => {
      if (coll === "buffer_messages" && update?.$set?.fencing_token === 2) {
        const r = bufRows("conv_bd")[0];
        if (r && r.status === "buffered") r.status = "processing";
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — repaired row must flush`);
    const c = claimOf("bd1");
    assert(c?.status !== "processing", `claim must reach terminal, got ${c?.status} — no orphaned processing`);
    assert(bufRows("conv_bd").length === 0, "row must be consumed (no row=processing + claim=processing stuck)");
  });

  // R28 [RED] — seeded crash-leftover: row status=processing + expired claim + fresh ts
  //   → recovery must enumerate processing rows, normalize, process exactly once
  await test("R28 seeded processing row + expired claim → normalize + process once + terminal", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("pz1", { conv: "conv_pz", batch: ["pz1"], claimedAgoMs: MIN }));
    const row = bufferRow("pz1", "conv_pz", 2000) as any;
    row.status = "processing"; // crash-leftover — flush ตายกลาง batch
    mocks.fakeColl("buffer_messages").push(row);
    seedInbound("pz1", "conv_pz");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — leftover row must recover`);
    const c = claimOf("pz1");
    assert(c?.status !== "processing", `claim terminal, got ${c?.status}`);
    assert(bufRows("conv_pz").length === 0, "row must be deleted after flush");
    const ids = replyInboundIds("conv_pz");
    assert(ids.filter((x: string) => x === "pz1").length === 1, `exactly one reply, got ${JSON.stringify(ids)}`);
  });

  // R29 [pin] — row buffered แต่ owner/fencing เปลี่ยนเป็น foreign + claim เปลี่ยนเจ้าของก่อน sync
  //   → stale classifier CAS ห้ามเขียนทับ → leave (concurrent winner ถือ claim+row)
  //   ⚡ winner ต้อง renew lease ด้วยเสมอ (reclaim จริง set lease ใหม่) — owner/token เปลี่ยนแต่
  //     lease หมด = winner ตายแล้ว → กลายเป็น reclaimable ไม่ใช่ foreign-active
  await test("R29 row+claim owner changed before sync → no overwrite, concurrent winner kept", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("bd2", { conv: "conv_bd2", batch: ["bd2"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("bd2", "conv_bd2", 2000));
    seedInbound("bd2", "conv_bd2");
    let flipped = false;
    (state as any).findOneHook = async (coll: string) => {
      const d = claimOf("bd2");
      if (!flipped && coll === "shadow_replies" && d?.fencing_token === 2 && d?.status === "processing") {
        // concurrent winner: reclaim claim เอง (lease ใหม่ตาม contract) + ถือ row
        //   ⚡ lease ยาว (1h) — defer wake-up จะถูก schedule แต่ไม่ยิงกลาง suite
        d.owner_id = "worker-other"; d.fencing_token = 9;
        d.lease_expires_at = new Date(Date.now() + 3600_000);
        const r = bufRows("conv_bd2")[0];
        if (r) { r.owner_id = "worker-other"; r.fencing_token = 7; }
        flipped = true;
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(flipped, "concurrent flip must fire post-reclaim");
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — foreign owner must not flush`);
    const c = claimOf("bd2");
    assert(c?.owner_id === "worker-other" && c?.fencing_token === 9 && c?.status === "processing",
      `claim stays with concurrent winner, got ${c?.status}/${c?.owner_id}/f${c?.fencing_token}`);
    const r = bufRows("conv_bd2")[0];
    assert(r?.owner_id === "worker-other" && r?.fencing_token === 7,
      `row identity must not be overwritten by stale snapshot, got ${r?.owner_id}/f${r?.fencing_token}`);
  });

  // R30 [RED] — row หายหลัง reclaim แต่ claim ยังเป็นของ ownedCtx → restore deterministic membership
  await test("R30 row vanished after reclaim, claim ours → restore row → flush once, terminal", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("bd3", { conv: "conv_bd3", batch: ["bd3"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("bd3", "conv_bd3", 2000));
    seedInbound("bd3", "conv_bd3");
    let vanished = false;
    (state as any).findOneHook = async (coll: string) => {
      const d = claimOf("bd3");
      if (!vanished && coll === "shadow_replies" && d?.fencing_token === 2 && d?.status === "processing") {
        const arr = mocks.fakeColl("buffer_messages");
        const i = arr.findIndex((x: any) => x.message_id === "bd3");
        if (i >= 0) arr.splice(i, 1);
        vanished = true;
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(vanished, "row must have vanished post-reclaim");
    assert(state.calls.callBot === 1,
      `callBot=${state.calls.callBot} want 1 — claim ours → deterministic requeue (restore buffer row)`);
    const c = claimOf("bd3");
    assert(c?.status !== "processing", `claim must reach terminal, got ${c?.status} — must not sit ownerless`);
    assert(bufRows("conv_bd3").length === 0, "restored row consumed by flush");
  });

  // ── R31–R35: final liveness — deferred wake-up, shared reconcile, exact delete ──

  // R31 [RED] — boot ขณะ foreign claim ยังมี lease active → defer + wake-up หลัง expiry
  //   ภายใน worker era เดิม (ไม่ busy-loop, ไม่ต้อง restart) → process exactly once
  await test("R31 active lease from dead process → defer → wake after expiry → process once", async () => {
    const c = claimDoc("lz1", { conv: "conv_lz", batch: ["lz1"], claimedAgoMs: 2000 });
    c.owner_id = "worker-old";
    c.lease_expires_at = new Date(Date.now() + 150);
    mocks.fakeColl("chat_processing").push(c);
    mocks.fakeColl("buffer_messages").push(bufferRow("lz1", "conv_lz", 1500));
    seedInbound("lz1", "conv_lz");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — lease active ห้าม process`);
    const c0 = claimOf("lz1");
    assert(c0?.status === "processing" && c0?.owner_id === "worker-old",
      `claim ต้องคงเจ้าของเดิมระหว่าง lease active, got ${c0?.status}/${c0?.owner_id}`);
    assert(bufRows("conv_lz").length === 1, "row ต้องยังอยู่ (leave+defer ไม่ใช่ delete)");
    await sleep(900); // lease 150ms + wake-up margin — recovery ต้องกลับมาเองใน era เดิม
    await settle();
    assert(state.calls.callBot === 1,
      `callBot=${state.calls.callBot} want 1 — deferred wake-up ต้อง recover โดยไม่ restart`);
    const c1 = claimOf("lz1");
    assert(c1?.status !== "processing", `claim terminal, got ${c1?.status}`);
    assert(bufRows("conv_lz").length === 0, "row consumed");
    assert(replyInboundIds("conv_lz").filter((x: string) => x === "lz1").length === 1, "exactly one reply");
  });

  // R32 [RED] — P4 no-evidence processing row + normalize CAS miss (owner/token เดิม)
  //   → shared reconcile ต้อง establish ctx + repair → flush → terminal exactly once
  await test("R32 P4 processing row normalize CAS miss (same owner/token) → reconcile → terminal once", async () => {
    mocks.fakeColl("chat_processing").push(claimDoc("pz2", { conv: "conv_pz2", batch: ["pz2"], claimedAgoMs: MIN }));
    const row = bufferRow("pz2", "conv_pz2", 2000) as any;
    row.status = "processing"; // crash-leftover mid-flush
    mocks.fakeColl("buffer_messages").push(row);
    seedInbound("pz2", "conv_pz2");
    (state as any).updateOneHook = async (coll: string, _f: unknown, update: any) => {
      // normalize CAS (status-only $set) → flip status ก่อน apply → miss (owner/token คงเดิม)
      if (coll === "buffer_messages" && update?.$set?.status === "buffered" && update?.$set?.fencing_token === undefined) {
        const r = bufRows("conv_pz2")[0];
        if (r && r.status === "processing") r.status = "buffered";
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — reconcile ต้อง normalize แล้ว flush`);
    const c = claimOf("pz2");
    assert(c?.status !== "processing", `claim terminal, got ${c?.status}`);
    assert(bufRows("conv_pz2").length === 0, "row consumed — ห้ามค้าง row+claim processing");
  });

  // R33 [RED] — claim ยังเป็น ownedCtx แต่ row owner/token เปลี่ยน → claim authority
  //   → fenced repair ด้วย identity ปัจจุบันของ row (ห้ามสรุป foreign winner จาก row อย่างเดียว)
  await test("R33 claim still ownedCtx, row owner/token changed → claim-authority repair → flush once", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("bd4", { conv: "conv_bd4", batch: ["bd4"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("bd4", "conv_bd4", 2000));
    seedInbound("bd4", "conv_bd4");
    let flipped = false;
    (state as any).findOneHook = async (coll: string) => {
      const d = claimOf("bd4");
      if (!flipped && coll === "shadow_replies" && d?.fencing_token === 2 && d?.status === "processing") {
        const r = bufRows("conv_bd4")[0];
        if (r) { r.owner_id = "worker-x"; r.fencing_token = 9; } // row ถูกแตะ แต่ claim ยังของเรา
        flipped = true;
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(flipped, "row flip must fire post-reclaim");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — claim authority ต้อง repair row`);
    const c = claimOf("bd4");
    assert(c?.status !== "processing", `claim terminal, got ${c?.status}`);
    assert(bufRows("conv_bd4").length === 0, "row consumed");
  });

  // R34 [RED] — delete disposition TOCTOU: row ถูกแทนด้วย identity ใหม่หลัง classify
  //   → deleteOne ต้อง CAS exact identity (message_id+claim_id+status+owner+fencing) → ห้ามลบ row ใหม่
  await test("R34 delete disposition TOCTOU → exact-identity CAS must not delete replaced row", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("dd1", { conv: "conv_dd", batch: ["dd1"], claimedAgoMs: MIN, status: "no_action" }));
    mocks.fakeColl("buffer_messages").push(bufferRow("dd1", "conv_dd", 2000));
    (state as any).deleteOneHook = async (coll: string) => {
      if (coll === "buffer_messages") {
        const r = bufRows("conv_dd")[0];
        if (r && r.owner_id === "worker-dead") { r.owner_id = "worker-new"; r.fencing_token = 9; }
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    const r = bufRows("conv_dd")[0];
    assert(r && r.owner_id === "worker-new" && r.fencing_token === 9,
      `replaced row must survive — delete ต้อง match exact identity เท่านั้น, got ${JSON.stringify(r)}`);
  });

  // R35a [RED] — reconcile exhausted + settle สำเร็จ → return delete + ลบ row ใน recovery เดียว
  await test("R35a reconcile exhausted, settle succeeds → delete row same round, claim terminal", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("ex1", { conv: "conv_ex", batch: ["ex1"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("ex1", "conv_ex", 2000));
    seedInbound("ex1", "conv_ex");
    (state as any).updateOneHook = async (coll: string, _f: unknown, update: any) => {
      // row fencing churn ทุก fenced-CAS → sync/repair miss ตลอด (claim ยังของเรา)
      if (coll === "buffer_messages" && update?.$set?.fencing_token !== undefined) {
        const r = bufRows("conv_ex")[0];
        if (r) r.fencing_token += 10;
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    const c = claimOf("ex1");
    assert(c?.status === "no_action" && c?.error === "stale_at_recovery",
      `claim settle terminal, got ${c?.status}/${c?.error}`);
    assert(bufRows("conv_ex").length === 0, "settle สำเร็จต้องลบ row ใน recovery เดียว — ห้าม leave ทิ้ง");
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
  });

  // R35b [RED] — reconcile exhausted + settle CAS miss → re-read พิสูจน์ foreign winner ก่อน leave
  await test("R35b settle CAS miss → re-read proves foreign winner → leave, no overwrite", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("ex2", { conv: "conv_ex2", batch: ["ex2"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("ex2", "conv_ex2", 2000));
    seedInbound("ex2", "conv_ex2");
    let tries = 0;
    (state as any).updateOneHook = async (coll: string, _f: unknown, update: any) => {
      if (coll === "buffer_messages" && update?.$set?.fencing_token !== undefined) {
        tries++;
        const r = bufRows("conv_ex2")[0];
        if (r) r.fencing_token += 10;
        if (tries === 4) {
          // reconcile ครบ bound → claim flip เป็น foreign ก่อน settle finalize
          const c = claimOf("ex2");
          if (c) { c.owner_id = "worker-other"; c.fencing_token = 9; }
        }
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    const c = claimOf("ex2");
    assert(c?.owner_id === "worker-other" && c?.fencing_token === 9 && c?.status === "processing",
      `claim must stay with concurrent winner, got ${c?.status}/${c?.owner_id}/f${c?.fencing_token}`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
  });

  // ── R36–R40: recovery lifecycle closure — edge transitions, timer cancel, batch ownership ──

  // R36 [RED] — disable ระหว่าง deferred wait: falling edge ต้องยกเลิก deferred timer;
  //   timer ยิงขณะปิดห้าม process; rising edge ใน process เดิม recover งานค้าง once
  await test("R36 disable during deferred wait → falling-edge cancel → rising-edge recovery once", async () => {
    const c = claimDoc("dz1", { conv: "conv_dz", batch: ["dz1"], claimedAgoMs: 2000 });
    c.owner_id = "worker-old";
    c.lease_expires_at = new Date(Date.now() + 250);
    mocks.fakeColl("chat_processing").push(c);
    mocks.fakeColl("buffer_messages").push(bufferRow("dz1", "conv_dz", 1500));
    seedInbound("dz1", "conv_dz");
    await svc.botWorkerService.recoverStaleBuffers(); // defer → timer ~lease+250
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} — lease active ห้าม process`);
    // falling edge — bot-worker calls clearPendingWork() (required export)
    mocks.state.config.bot_worker_enabled = false;
    (svc.botWorkerService as any).clearPendingWork();
    await sleep(800); // deferred window ผ่านแล้ว — timer (ถ้ารอด) ยิงขณะ disabled → ห้ามทำงาน
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} while disabled must stay 0`);
    const cMid = claimOf("dz1");
    assert(cMid?.status === "processing" && cMid?.owner_id === "worker-old",
      `claim must stay parked while disabled, got ${cMid?.status}/${cMid?.owner_id}`);
    assert(bufRows("conv_dz").length === 1, "row must survive disabled window");
    // rising edge ใน process เดิม — recovery ต้องเอางานค้างออก exactly once (ไม่ restart)
    mocks.state.config.bot_worker_enabled = true;
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — rising edge recovers once`);
    assert(claimOf("dz1")?.status !== "processing", `claim terminal, got ${claimOf("dz1")?.status}`);
    assert(bufRows("conv_dz").length === 0, "row consumed");
    assert(replyInboundIds("conv_dz").length === 1, "exactly one reply");
  });

  // R37 [RED] — deferred recovery ยิงระหว่าง same-owner in-flight batch:
  //   callBot คง 1 · row/fencing/lock ห้ามถูกแตะ · ห้าม flush retry ทุก 50ms · ปล่อยแล้ว terminal once
  await test("R37 deferred recovery during in-flight batch → untouched, terminal once", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("w1", { conv: "conv_w1", batch: ["w1"], claimedAgoMs: MIN }));
    mocks.fakeColl("buffer_messages").push(bufferRow("w1", "conv_w1", 2000));
    seedInbound("w1", "conv_w1");
    // conv_w2 — foreign claim + committed evidence, lease 400ms → defer → finalize-only เมื่อหมด
    const c2 = claimDoc("w2", { conv: "conv_w2", batch: ["w2"], claimedAgoMs: MIN,
      outcome_type: "bot_answered", reply_ids: ["r_w2"] });
    c2.owner_id = "worker-old";
    c2.lease_expires_at = new Date(Date.now() + 400);
    mocks.fakeColl("chat_processing").push(c2);
    mocks.fakeColl("buffer_messages").push(bufferRow("w2", "conv_w2", 2000));
    // นับ conv-lock reclaim attempts — retry spin ทุก 50ms จะเห็นตรงนี้
    let lockAttempts = 0;
    (state as any).findOneAndUpdateHook = async (coll: string, filter: any) => {
      if (coll === "buffer_messages" && typeof filter?._id === "string" && filter._id.includes("convlock")) lockAttempts++;
    };
    state.callBotDelayMs = 1200;
    const p1 = svc.botWorkerService.recoverStaleBuffers(); // conv_w1 flush → callBot held
    await sleep(300);
    assert(state.calls.botInFlight === 1, "batch must be in-flight");
    const p2 = svc.botWorkerService.recoverStaleBuffers(); // deferred wake-up fires mid-batch
    await sleep(150);
    const rMid = bufRows("conv_w1")[0];
    assert(rMid && rMid.status === "processing",
      `in-flight row must stay "processing" — recovery ห้าม normalize/แตะ, got ${rMid?.status}`);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 (held)`);
    assert(state.calls.botInFlight === 1, "batch still in-flight");
    await p1; await p2; await settle();
    assert(state.calls.callBot === 1,
      `callBot=${state.calls.callBot} want 1 — conv_w2 = finalize-only (committed evidence, no LLM)`);
    assert(lockAttempts <= 2,
      `lock reclaim attempts=${lockAttempts} — flush-retry spin (50ms) on in-flight conv forbidden`);
    assert(claimOf("w1")?.status !== "processing" && claimOf("w2")?.status !== "processing",
      "both claims terminal");
    assert(bufRows("conv_w1").length === 0 && bufRows("conv_w2").length === 0, "rows consumed");
    assert(replyInboundIds("conv_w1").length === 1, "one reply for batch");
  });

  // R38 [RED] — multi-message batch: ctx.claim_ids ≥2 → activeClaims ต้องครอบทุก claim
  //   recovery ขณะ batch in-flight ห้ามแตะ member ใดเลย
  await test("R38 multi-message batch in-flight → activeClaims covers all → recovery leaves all", async () => {
    for (const id of ["q1", "q2"]) {
      mocks.fakeColl("chat_processing").push(
        claimDoc(id, { conv: "conv_qb", batch: ["q1", "q2"], claimedAgoMs: MIN }));
      mocks.fakeColl("buffer_messages").push(bufferRow(id, "conv_qb", 2000));
      seedInbound(id, "conv_qb");
    }
    state.callBotDelayMs = 1200;
    const p1 = svc.botWorkerService.recoverStaleBuffers(); // batch flush → callBot held
    await sleep(250);
    assert(state.calls.botInFlight === 1, "batch must be in-flight");
    const f1 = claimOf("q1")?.fencing_token, f2 = claimOf("q2")?.fencing_token;
    const p2 = svc.botWorkerService.recoverStaleBuffers(); // concurrent pass mid-batch
    await sleep(150);
    const statuses = bufRows("conv_qb").map((r: any) => `${r.message_id}:${r.status}`);
    assert(statuses.length === 2 && statuses.every((s: string) => s.endsWith(":processing")),
      `recovery must not touch in-flight batch rows, got ${statuses.join(",")}`);
    assert(claimOf("q1")?.fencing_token === f1 && claimOf("q2")?.fencing_token === f2,
      "claim fencing must not change mid-flight (member q2 must be in activeClaims too)");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
    await p1; await p2; await settle();
    assert(claimOf("q1")?.status !== "processing" && claimOf("q2")?.status !== "processing",
      "both members terminal");
    assert(bufRows("conv_qb").length === 0, "rows consumed");
    const replies = replyInboundIds("conv_qb");
    assert(replies.filter((x: string) => x === "q1").length === 1 &&
           replies.filter((x: string) => x === "q2").length === 1,
      "one batch reply covering both members");
  });

  // R39 [RED] — stale-CAS loss leaves claim foreign + lease expired → ห้าม bare leave;
  //   ต้อง bounded wake-up → reclaim/settle → terminal exactly once ไม่ต้อง restart
  await test("R39 expired foreign claim after CAS race → bounded wake-up → terminal once", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("bd5", { conv: "conv_bd5", batch: ["bd5"], claimedAgoMs: DAY }));
    mocks.fakeColl("buffer_messages").push(bufferRow("bd5", "conv_bd5", DAY));
    seedInbound("bd5", "conv_bd5");
    // stale-CAS (fencing filter) แพ้ — concurrent worker แย่ง owner ไปแต่ตายก่อน renew lease
    (state as any).updateOneHook = async (coll: string, _f: any, update: any) => {
      if (coll === "chat_processing" && update?.$set?.error === "stale_at_recovery") {
        const d = claimOf("bd5");
        if (d?.status === "processing") { d.owner_id = "worker-z"; d.fencing_token = 88; }
        // lease_expires_at คง expired — winner crashed before renewing
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} — CAS lost, no process yet`);
    const c0 = claimOf("bd5");
    assert(c0?.status === "processing" && c0?.owner_id === "worker-z",
      `claim must show foreign expired owner, got ${c0?.status}/${c0?.owner_id}`);
    // bare leave = claim ค้างถึง restart — ต้องมี immediate bounded wake-up
    let recoveryFinds = 0;
    (state as any).onQuery = (coll: string, op: string) => {
      if (coll === "buffer_messages" && op === "find") recoveryFinds++;
    };
    await sleep(900);
    assert(recoveryFinds > 0, "no wake-up scheduled — expired-foreign leave has no execution path");
    await settle();
    const c = claimOf("bd5");
    assert(c?.status !== "processing",
      `claim must reach terminal without restart (bounded reclaim path), got ${c?.status}/${c?.owner_id}`);
    assert(bufRows("conv_bd5").length === 0, "row consumed — no ownerless processing leftovers");
  });

  // R40 [RED] — dynamic disable safety: buffer timer + flush-retry timer pending;
  //   toggle off → timers ยิงแล้ว callBot=0 + ไม่มี transition →processing ใหม่;
  //   toggle on → recovery/process exactly once
  await test("R40 dynamic disable → pending timers gated/cancelled → enable recovers once", async () => {
    mocks.botworkerRuntime.claimLeaseMs = 400;
    mocks.state.config.bot_buffer_window_ms = 250;
    // conv_dy1 — poll สร้าง claim + buffered row + debounce timer (pending buffer timer)
    seedInbound("dy1", "conv_dy1");
    await svc.botWorkerService.pollNewMessages(new Date(0));
    for (let i = 0; i < 100 && !claimOf("dy1"); i++) await sleep(10); // claim ต้องมีก่อน mutate
    // ⚡ claim ต้องเป็น foreign+ACTIVE ก่อน debounce(250) ยิง — waitForInFlight/settle drain
    //   timer-launched flush แล้ว → flush ที่ fire ใน settle ต้องเจอ foreign claim active
    //   (lease เดิม +400ms หมดก่อน timer ยิงได้ — test env timer starve → ต้องต่อ lease
    //   ให้ deterministic แล้วค่อย expire ตอน re-enable = foreign worker lease lapsed)
    const dyc = claimOf("dy1")!;
    dyc.owner_id = "worker-old";
    dyc.lease_expires_at = new Date(Date.now() + 30000);
    await settle(); // debounce flush fired mid-settle → re-fence miss (foreign+active) → row กลับ buffered
    assert(bufRows("conv_dy1").length === 1, "dy1 must be buffered with debounce pending");
    // conv_dy2 — expired claim + buffered row + conv_lock held by other worker (flushRetry pending)
    mocks.fakeColl("chat_processing").push(
      claimDoc("dy2", { conv: "conv_dy2", batch: ["dy2"], claimedAgoMs: 2000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("dy2", "conv_dy2", 2000));
    seedInbound("dy2", "conv_dy2");
    mocks.fakeColl("buffer_messages").push({
      _id: mocks.convLockIdFor("shopee", "shop_1", "conv_dy2"),
      kind: "conv_lock", conversation_id: "conv_dy2", shop_id: "shop_1", platform: "shopee",
      status: "locked", owner_id: "worker-x", fencing_token: 1,
      lease_expires_at: new Date(Date.now() + 350), updated_at: new Date(),
    });
    // enabled pass: dy1 → foreign+active → defer; dy2 → flush → lock fail → flushRetry pending
    await svc.botWorkerService.recoverStaleBuffers();
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} — nothing processed yet`);
    // ── toggle off — arm transition counter (ห้ามมี status→processing ใหม่ระหว่างปิด) ──
    let procTransitions = 0;
    (state as any).updateOneHook = async (coll: string, _f: any, update: any) => {
      if (coll === "buffer_messages" && update?.$set?.status === "processing") procTransitions++;
    };
    mocks.state.config.bot_worker_enabled = false;
    await sleep(320); // flushRetry(50ms) + debounce(250ms) ยิงขณะ disabled — gate ต้องกัน
    (svc.botWorkerService as any).clearPendingWork?.(); // falling-edge cancel (deferred timer + rest)
    await sleep(450); // deferred window (~650ms) ผ่าน — timer ไฟแล้ว/ถูกยกเลิก
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} — disabled window must be silent`);
    assert(procTransitions === 0,
      `${procTransitions} rows transitioned to processing while disabled — timer safety boundary broken`);
    assert(bufRows("conv_dy1").length === 1 && bufRows("conv_dy2").length === 1,
      "rows must stay buffered through disabled window");
    // ── toggle on — recovery/process exactly once ตาม policy ──
    mocks.state.config.bot_worker_enabled = true;
    dyc.lease_expires_at = new Date(Date.now() - 1); // foreign lease lapsed ระหว่าง disabled window → recovery reclaim ได้
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 2,
      `callBot=${state.calls.callBot} want 2 — dy1 (claim lease หมด) + dy2 (lock หมด) each once`);
    assert(claimOf("dy1")?.status !== "processing" && claimOf("dy2")?.status !== "processing",
      "both claims terminal");
    assert(bufRows("conv_dy1").length === 0 && bufRows("conv_dy2").length === 0, "rows consumed");
    assert(replyInboundIds("conv_dy1").length === 1 && replyInboundIds("conv_dy2").length === 1,
      "one reply each");
  });

  // ── R41–R43: lifecycle review-fix — mid-pass disable epoch, shutdown drain, bounded leave ──

  // R41 [RED] — disable กลาง recovery pass → claims phase ห้ามเริ่ม/launch processMessage
  //   (single owner: AbortController ใน clearPendingWork — checkpoint ก่อน side-effect boundary, ไม่ใช่ guard ทุก branch)
  await test("R41 mid-pass disable → epoch checkpoint skips claims phase → recoverable next edge", async () => {
    // direct stale claim (ไม่มี buffer row) + fresh claimed_at → processable โดย claims phase
    mocks.fakeColl("chat_processing").push(
      claimDoc("da1", { conv: "conv_da", batch: ["da1"], claimedAgoMs: 2000 }));
    seedInbound("da1", "conv_da");
    // flip disabled กลาง pass — buffer enumeration find เป็นจุดแรกที่ต้องเจอ
    let flipped = false;
    (state as any).onQuery = (coll: string, op: string) => {
      if (!flipped && coll === "buffer_messages" && op === "find") {
        flipped = true;
        mocks.state.config.bot_worker_enabled = false;
        (svc.botWorkerService as any).clearPendingWork?.(); // falling edge → epoch++
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(flipped, "mid-pass disable flip must fire");
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — claims phase must not launch processMessage after disable`);
    const c0 = claimOf("da1");
    assert(c0?.status === "processing" && c0?.owner_id === "worker-dead",
      `claim must stay recoverable (processing@dead), got ${c0?.status}/${c0?.owner_id}`);
    // rising edge ถัดไป → reclaim+process once (ไม่ต้อง restart)
    mocks.state.config.bot_worker_enabled = true;
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — edge recovery resumes`);
    assert(claimOf("da1")?.status !== "processing", `claim terminal, got ${claimOf("da1")?.status}`);
  });

  // R42 [RED] — shutdown drain ต้องรอ recovery pass: waitForInFlight คืนหลัง recovery จบ
  //   และไม่มีงานใหม่ถูก launch หลัง wait (clearPendingWork → epoch abort)
  await test("R42 shutdown: clearPendingWork+waitForInFlight waits recovery → no work after return", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("dr1", { conv: "conv_dr", batch: ["dr1"], claimedAgoMs: 2000 }));
    seedInbound("dr1", "conv_dr");
    state.queryDelayMs = 300; // recovery pass ยาวพอให้ wait เริ่มกลาง pass
    const rec = svc.botWorkerService.recoverStaleBuffers();
    await sleep(80); // pass in-flight แล้ว
    let recDone = false;
    rec.then(() => { recDone = true; });
    (svc.botWorkerService as any).clearPendingWork();   // shutdown step 1 — epoch abort
    await svc.botWorkerService.waitForInFlight(3000);   // step 2 — must cover recovery pass
    const atReturn = state.calls.callBot;
    assert(recDone, "waitForInFlight returned while recovery pass still running");
    await rec; await settle();
    assert(atReturn === state.calls.callBot,
      `work launched after drain returned (callBot ${atReturn}→${state.calls.callBot}) — recovery escaped shutdown`);
  });

  // R43 [RED] — reconcile settle tail: finalizeClaims miss ×2 ขณะ claim ยัง processing
  //   → bare "leave" เดิมไม่มี wake-up; ต้อง defer bounded → รอบถัดไป terminalize
  await test("R43 settle finalize double-miss → bounded wake-up → terminal next round", async () => {
    mocks.botworkerRuntime.claimLeaseMs = 400; // wake-up สั้นพอสำหรับ suite
    mocks.fakeColl("chat_processing").push(
      claimDoc("fx1", { conv: "conv_fx", batch: ["fx1"], claimedAgoMs: MIN, reply_ids: ["ghost_r"] }));
    mocks.fakeColl("buffer_messages").push(bufferRow("fx1", "conv_fx", 2000));
    seedInbound("fx1", "conv_fx");
    // row-fencing churn ทุก repair CAS → reconcile ครบ 3 รอบ → เข้า settle tail
    (state as any).updateOneHook = async (coll: string, _f: any, update: any) => {
      if (coll === "buffer_messages" && update?.$set?.fencing_token !== undefined) {
        const r = bufRows("conv_fx")[0];
        if (r) r.fencing_token += 10;
      }
    };
    // finalizeClaims (updateMany) veto ×2 — doc ยังตรง ctx แต่ CAS miss (transient churn)
    let finMisses = 0;
    (state as any).updateManyHook = async (coll: string, _f: any, update: any) => {
      if (coll === "chat_processing" && update?.$set?.error === "stale_at_recovery" && finMisses < 2) {
        finMisses++;
        return "skip";
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(finMisses === 2, `finalize misses=${finMisses} — settle tail must be exhausted`);
    const c0 = claimOf("fx1");
    assert(c0?.status === "processing",
      `claim left processing by exhausted settle, got ${JSON.stringify(c0)} callBot=${state.calls.callBot} rows=${bufRows("conv_fx").length}`);
    // bounded wake-up: defer timer (~lease 400 + 250) → pass ถัดไปต้อง terminalize
    await sleep(1100);
    await settle();
    const c = claimOf("fx1");
    assert(c?.status !== "processing",
      `claim must terminalize on bounded wake-up, got ${c?.status} — bare leave had no path`);
    assert(bufRows("conv_fx").length === 0, "row must be consumed/deleted after wake-up");
  });

  // ── R44–R47: cancellation contract — AbortSignal เป็น owner เดียวตลอด recovery chain ──
  //   epoch เดิมตรวจเฉพาะหัว loop/ระหว่าง phase — abort กลาง await chain ยัง launch งานได้

  // R44 [RED] — abort ระหว่าง async inbound lookup (หลัง loop-top) → ห้าม claim/launch
  await test("R44 abort during direct-claim inbound lookup → no launch, recoverable, no phantom rerun", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("dc1", { conv: "conv_dc", batch: ["dc1"], claimedAgoMs: 2000 }));
    seedInbound("dc1", "conv_dc");
    let fired = false;
    (state as any).findOneHook = async (coll: string, filter: any) => {
      if (!fired && coll === "messages" && filter?.message_id === "dc1") {
        fired = true;
        (svc.botWorkerService as any).clearPendingWork(); // shutdown abort — config ยัง enabled
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(fired, "abort must fire mid-lookup");
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — aborted pass must not claim/launch processMessage`);
    const c0 = claimOf("dc1");
    assert(c0?.status === "processing" && c0?.owner_id === "worker-dead",
      `claim must stay recoverable (untouched), got ${c0?.status}/${c0?.owner_id}`);
    await sleep(400); // deferred timer/log ห้ามสร้าง recovery ใหม่หลัง cancel
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} — phantom rerun processed claim after cancel`);
    // rising edge ถัดไปต้องกู้ + process exactly once (ไม่ต้อง restart)
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — next run processes once`);
    assert(claimOf("dc1")?.status !== "processing", `claim terminal, got ${claimOf("dc1")?.status}`);
  });

  // R45 [RED] — abort ระหว่าง buffered classifier DB await → ห้ามเข้า flushBuffer
  //   (config bot_worker_enabled ยัง true — shutdown ไม่ใช่ toggle-off; enabled gate เดิมจับไม่ได้)
  await test("R45 abort during buffered classify → no flush/process, row+claim recoverable", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("cb1", { conv: "conv_cb", batch: ["cb1"], claimedAgoMs: 2000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("cb1", "conv_cb", 2000));
    seedInbound("cb1", "conv_cb");
    let fired = false;
    (state as any).findOneHook = async (coll: string, filter: any) => {
      if (!fired && coll === "chat_processing" && filter?._id === CLAIM_ID("cb1")) {
        fired = true;
        (svc.botWorkerService as any).clearPendingWork(); // abort กลาง classifier await
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(fired, "abort must fire inside classifier");
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — aborted recovery must not reach flushBuffer`);
    assert(bufRows("conv_cb").length === 1, "row must remain (recoverable, not deleted)");
    const c0 = claimOf("cb1");
    assert(c0?.status === "processing", `claim must stay processing, got ${c0?.status}`);
    await sleep(400);
    assert(state.calls.callBot === 0, "no flush-retry/deferred rerun may process after abort");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — next run flushes once`);
    assert(bufRows("conv_cb").length === 0, "row consumed by next-run flush");
  });

  // R46 [RED] — abort หลัง conv lock + member CAS, กลาง re-fence → ห้าม processMessage
  //   finally ต้อง release conv_lock; row/claim กู้ได้ ไม่กลาย permanent processing
  await test("R46 abort after lock+re-fence → no callBot, conv lock released, next run once", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("cx1", { conv: "conv_cx", batch: ["cx1"], claimedAgoMs: 2000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("cx1", "conv_cx", 2000));
    seedInbound("cx1", "conv_cx");
    let fired = false;
    (state as any).findOneAndUpdateHook = async (coll: string, filter: any) => {
      // re-fence CAS ของ flushBuffer — filter = {_id: claimId, status:"processing", $or:[...]}
      if (!fired && coll === "chat_processing" && filter?._id === CLAIM_ID("cx1") && filter?.$or) {
        fired = true;
        (svc.botWorkerService as any).clearPendingWork(); // abort หลัง lock, กลาง re-fence CAS
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(fired, "abort must fire at re-fence boundary");
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — abort before processMessage boundary`);
    const locks = mocks.fakeColl("buffer_messages").filter((d: any) => d.kind === "conv_lock");
    assert(locks.length === 0, `conv_lock must be released in finally, got ${locks.length}`);
    const c0 = claimOf("cx1");
    assert(c0?.status === "processing", `claim recoverable (processing), got ${c0?.status}`);
    assert(bufRows("conv_cx").length === 1, "row must remain recoverable");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — next run processes once`);
    assert(bufRows("conv_cx").length === 0, "row deleted after terminal");
  });

  // R47 — normal regression: no abort → direct + buffered each process once;
  //   flushBuffer โดยตรง (normal caller, ไม่ส่ง signal) ต้องทำงานเดิม
  await test("R47 no-abort regression — recovery once + signal-less flushBuffer works", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("nm1", { conv: "conv_nm", batch: ["nm1"], claimedAgoMs: 2000 }));
    seedInbound("nm1", "conv_nm");
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `direct recovery callBot=${state.calls.callBot} want 1`);
    // normal path — flushBuffer โดยไม่มี recovery signal (debounce/timer caller เหมือน production)
    mocks.fakeColl("chat_processing").push(
      claimDoc("nm2", { conv: "conv_nm2", batch: ["nm2"], claimedAgoMs: 2000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("nm2", "conv_nm2", 2000));
    seedInbound("nm2", "conv_nm2");
    const bufferService = await import("../src/backend/service/bufferService");
    await bufferService.flushBuffer(
      "conv_nm2",
      svc.botWorkerService.processMessage,
      async () => {}
    );
    await settle();
    assert(state.calls.callBot === 2,
      `callBot=${state.calls.callBot} want 2 — signal-less flush must process normally`);
  });

  // ── R48–R50: final review — signal leak ใน retry callback + recoveryAgain ชุบ aborted era
  //   + claimMessage ตรวจก่อน read เท่านั้น (write boundaries ยังเปิด) ──

  // R48 [RED] — retry timer callback ทำ signal หลุด: callback เริ่มก่อน abort แล้วค้างใน
  //   read → abort ไม่ถึง flush → LLM หลัง shutdown
  await test("R48 retry callback must carry aborted signal — no flush after clearPendingWork", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rt1", { conv: "conv_rt", batch: ["rt1"], claimedAgoMs: 2000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("rt1", "conv_rt", 2000));
    seedInbound("rt1", "conv_rt");
    // foreign ACTIVE conv_lock → recovery flush แพ้ lock → scheduleFlushRetry(50ms, signal)
    mocks.fakeColl("buffer_messages").push({
      _id: mocks.convLockIdFor("shopee", "shop_1", "conv_rt"),
      kind: "conv_lock", conversation_id: "conv_rt", shop_id: "shop_1", platform: "shopee",
      status: "locked", owner_id: "worker-x", fencing_token: 1,
      lease_expires_at: new Date(Date.now() + 30_000), updated_at: new Date(),
    });
    await svc.botWorkerService.recoverStaleBuffers(); // pass จบ — retry timer pending
    assert(state.calls.callBot === 0, "lock held — nothing processed yet");
    // retry timer(50ms) fires → flush เริ่ม → stall ใน getBufferedMessages (find.toArray delay)
    (state as any).queryDelayMs = 400;
    // ถอน foreign lock — retry flush ต้อง acquire ได้ถ้า abort ไม่ถึง
    const li = mocks.fakeColl("buffer_messages").findIndex((d: any) => d.kind === "conv_lock");
    mocks.fakeColl("buffer_messages").splice(li, 1);
    await sleep(90); // callback กำลังค้างใน read await
    (svc.botWorkerService as any).clearPendingWork(); // shutdown — config ยัง enabled
    (state as any).queryDelayMs = 0;
    await sleep(500); // stalled flush จบ + retry window ผ่าน
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — retry callback must observe the aborted signal`);
    assert(bufRows("conv_rt").length === 1, "row recoverable");
    assert(claimOf("rt1")?.status === "processing", "claim recoverable");
    // explicit recovery รอบใหม่ตอบ exactly once
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — rerun processes once`);
  });

  // R49 [RED] — caller มาระหว่าง aborted run → recoveryAgain=true →
  //   aborted pass continue → iteration ใหม่ + controller ใหม่ → recovery ฟื้นหลัง shutdown
  await test("R49 post-abort caller must not resurrect cancelled era — outer run ends", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("ra1", { conv: "conv_ra", batch: ["ra1"], claimedAgoMs: 2000 }));
    seedInbound("ra1", "conv_ra");
    let releaseClaims!: () => void;
    const gate = new Promise<void>((r) => { releaseClaims = r; });
    (state as any).findOneHook = async (coll: string, filter: any) => {
      // hold pass กลาง claims-phase inbound lookup — recoveryAbort ยังชี้ run นี้
      if (coll === "messages" && filter?.message_id === "ra1") await gate;
    };
    const passP = svc.botWorkerService.recoverStaleBuffers();
    await sleep(60); // pass ค้างใน claims-phase findOne
    (svc.botWorkerService as any).clearPendingWork(); // abort + recoveryAgain=false
    const joinP = svc.botWorkerService.recoverStaleBuffers(); // post-abort joiner → recoveryAgain=true
    releaseClaims();
    await passP; await joinP; await settle();
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — queued rerun in dead era must not start a new pass`);
    // run เดิม drain จบแล้ว — explicit recovery ใหม่ต้อง process exactly once
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — next run processes once`);
  });

  // R50 [RED] — claimMessage ตรวจ signal ก่อน ownership read เท่านั้น:
  //   abort ระหว่าง findOne → โค้ดยัง reclaim ($inc attempt/fencing) หรือ terminalize ได้
  await test("R50 abort inside claimMessage read → no reclaim/attempt/terminalize write", async () => {
    mocks.fakeColl("chat_processing").push(
      claimDoc("rm1", { conv: "conv_rm", batch: ["rm1"], claimedAgoMs: 2000 }));
    seedInbound("rm1", "conv_rm");
    let fired = false;
    (state as any).findOneHook = async (coll: string, filter: any) => {
      // claimMessage อ่าน claim doc — abort กลาง await นี้
      if (!fired && coll === "chat_processing" && filter?._id === CLAIM_ID("rm1")) {
        fired = true;
        (svc.botWorkerService as any).clearPendingWork();
      }
    };
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(fired, "abort must fire inside claimMessage ownership read");
    const c = claimOf("rm1")!;
    assert(c.owner_id === "worker-dead" && c.fencing_token === 1 && (c.attempt ?? 1) === 1,
      `claim mutated after abort — owner=${c.owner_id} f=${c.fencing_token} attempt=${c.attempt} ` +
      `(reclaim/attempt-cap/insert must not run)`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0`);
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — rerun reclaims+processes`);
  });

  // ── R51: controller lifetime — owner ต้องยาวกว่า child work ──
  //   retry callback จาก pass A ถือ signal A; pass B สร้าง controller ใหม่ →
  //   clearPendingWork abort เฉพาะ B → retry A รอด → flush/LLM หลัง shutdown
  await test("R51 recovery retry from older pass shares era signal and stops on shutdown", async () => {
    // conv A: expired claim + buffered row + inbound + foreign ACTIVE conv_lock
    //   → pass A flush แพ้ lock → scheduleFlushRetry(50ms, signalA) → pass A จบ
    mocks.fakeColl("chat_processing").push(
      claimDoc("ra51", { conv: "conv_ra51", batch: ["ra51"], claimedAgoMs: 2000 }));
    mocks.fakeColl("buffer_messages").push(bufferRow("ra51", "conv_ra51", 2000));
    seedInbound("ra51", "conv_ra51");
    mocks.fakeColl("buffer_messages").push({
      _id: mocks.convLockIdFor("shopee", "shop_1", "conv_ra51"),
      kind: "conv_lock", conversation_id: "conv_ra51", shop_id: "shop_1", platform: "shopee",
      status: "locked", owner_id: "worker-x", fencing_token: 1,
      lease_expires_at: new Date(Date.now() + 30_000), updated_at: new Date(),
    });
    await svc.botWorkerService.recoverStaleBuffers(); // pass A จบ — retry(50ms) armed
    assert(state.calls.callBot === 0, "lock foreign — nothing processed yet");

    // pass B ต้อง in-flight → stall classify ของ row A ที่ claim findOne (gateB)
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => { releaseB = r; });
    (state as any).findOneHook = async (coll: string, filter: any) => {
      if (coll === "chat_processing" && filter?._id === CLAIM_ID("ra51")) await gateB;
    };
    const passB = svc.botWorkerService.recoverStaleBuffers();
    // retry A จะ fire ~50ms — stall read ของมันด้วย queryDelayMs
    (state as any).queryDelayMs = 400;
    await sleep(80); // retry A fired + ค้างใน getBufferedMessages; pass B ค้างใน gateB
    // ถอน foreign lock — retry A ต้อง acquire ได้ถ้า abort ไม่ถึง signal A
    const li = mocks.fakeColl("buffer_messages").findIndex((d: any) => d.kind === "conv_lock");
    mocks.fakeColl("buffer_messages").splice(li, 1);
    // shutdown — config ยัง enabled; abort ต้องถึงทั้ง retry A (era เดียวกัน) และ pass B
    (svc.botWorkerService as any).clearPendingWork();
    releaseB();
    (state as any).queryDelayMs = 0;
    await passB; await settle(); await sleep(500); // ให้ stalled flush + retry window ผ่าน
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — retry จาก pass เก่าต้อง share era signal เดียวกัน`);
    assert(bufRows("conv_ra51").length === 1, "row recoverable");
    assert(claimOf("ra51")?.status === "processing", "claim recoverable");
    assert(replyInboundIds("conv_ra51").length === 0, "no reply after abort");
    // cancelled work drain แล้ว — explicit recovery ใหม่สร้าง era ใหม่ → process exactly once
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — new era processes once`);
    assert(replyInboundIds("conv_ra51").length === 1, "exactly one reply");
  });

  // ── N1–N5: normal debounce/flush-retry shutdown lifecycle ──
  //   timer-launched flush ไม่มี signal และ promise ไม่อยู่ใน drain →
  //   callback ที่ fire ก่อน shutdown สามารถ callBot/สร้าง retry หลัง clearPendingWork
  await test("N1 debounce callback started pre-shutdown dies quietly, stays recoverable", async () => {
    mocks.state.config.bot_buffer_window_ms = 60;
    seedInbound("n1", "conv_n1");
    // ⚡ abort กลาง async read ของ debounce flush — deterministic: bufferOrProcess's
    //   getBufferedMessages = find#1 → debounce(60) fires → flush's getBufferedMessages = find#2
    //   → hook stalls read 300ms + abort ใน issue tick เดียวกัน → continuation เจอ aborted
    let finds = 0;
    (state as any).onQuery = (coll: string, op: string) => {
      if (coll === "buffer_messages" && op === "find" && ++finds === 2) {
        (state as any).queryDelayMs = 300; // hold read เปิดข้าม abort
        (svc.botWorkerService as any).clearPendingWork(); // shutdown — config ยัง enabled
      }
    };
    await svc.botWorkerService.pollNewMessages(new Date(0)); // claim + insert row + arm debounce(60)
    for (let i = 0; i < 200 && finds < 2; i++) await sleep(10);
    assert(finds === 2, "debounce flush ต้องเริ่มแล้วและค้างใน buffer read");
    (state as any).queryDelayMs = 0;
    await sleep(500); // stalled read resolve หลัง abort → flush ต้องออกเงียบ
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — fired debounce callback ต้องตายด้วย era abort`);
    assert(replyInboundIds("conv_n1").length === 0, "no reply after abort");
    assert(bufRows("conv_n1").length === 1, "row still buffered → recoverable");
    assert(claimOf("n1")?.status === "processing", "claim recoverable");
    mocks.fakeColl("chat_processing").forEach((d: any) => {
      d.lease_expires_at = new Date(Date.now() - 1000); // จำลอง lease หมด → era ใหม่ reclaim ได้
    });
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — new era processes once`);
    assert(replyInboundIds("conv_n1").length === 1, "exactly one reply");
  });

  await test("N2 normal retry callback started pre-shutdown dies quietly, no new timer", async () => {
    mocks.state.config.bot_buffer_window_ms = 60;
    seedInbound("n2", "conv_n2");
    mocks.fakeColl("buffer_messages").push({ // foreign ACTIVE lock → debounce flush แพ้ → retry(50)
      _id: mocks.convLockIdFor("shopee", "shop_1", "conv_n2"),
      kind: "conv_lock", conversation_id: "conv_n2", shop_id: "shop_1", platform: "shopee",
      status: "locked", owner_id: "worker-x", fencing_token: 1,
      lease_expires_at: new Date(Date.now() + 30_000), updated_at: new Date(),
    });
    await svc.botWorkerService.pollNewMessages(new Date(0));
    for (let i = 0; i < 100 && bufRows("conv_n2").length === 0; i++) await sleep(10);
    assert(bufRows("conv_n2").length === 1, "row buffered + debounce armed");
    await sleep(140); // debounce flush(~60) แพ้ lock → retry(50ms) armed — NORMAL path (ไม่ใช่ recovery)
    (state as any).queryDelayMs = 400; // stall read ของ retry callback
    await sleep(80); // retry fired → flushBuffer ค้างใน getBufferedMessages
    // ถอน foreign lock — retry ต้อง acquire ได้ถ้า abort ไม่ถึง
    const li = mocks.fakeColl("buffer_messages").findIndex((d: any) => d.kind === "conv_lock");
    mocks.fakeColl("buffer_messages").splice(li, 1);
    let postAbortFinds = 0;
    (svc.botWorkerService as any).clearPendingWork();
    (state as any).onQuery = (coll: string, op: string) => {
      if (coll === "buffer_messages" && op === "find") postAbortFinds++;
    };
    (state as any).queryDelayMs = 0;
    await sleep(500); // retry window + stalled read ผ่าน
    assert(state.calls.callBot === 0,
      `callBot=${state.calls.callBot} want 0 — normal retry callback ต้องถือ era signal`);
    assert(postAbortFinds === 0, `postAbortFinds=${postAbortFinds} want 0 — ห้ามมี retry/timer ยิงหลัง shutdown`);
    assert(replyInboundIds("conv_n2").length === 0, "no reply after abort");
    mocks.fakeColl("chat_processing").forEach((d: any) => {
      d.lease_expires_at = new Date(Date.now() - 1000);
    });
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — new era processes once`);
  });

  await test("N3 already-started timer flush drains before shutdown returns", async () => {
    mocks.state.config.bot_buffer_window_ms = 60;
    (state as any).callBotDelayMs = 500;
    seedInbound("n3", "conv_n3");
    await svc.botWorkerService.pollNewMessages(new Date(0));
    for (let i = 0; i < 100 && bufRows("conv_n3").length === 0; i++) await sleep(10);
    for (let i = 0; i < 100 && state.calls.botInFlight === 0; i++) await sleep(10); // debounce → flush → callBot ค้าง
    assert(state.calls.botInFlight === 1, "callBot in-flight จาก timer-launched flush");
    (svc.botWorkerService as any).clearPendingWork();
    let drained = false;
    const w = svc.botWorkerService.waitForInFlight(3000).then(() => { drained = true; });
    await sleep(150); // callBot ยังค้าง — drain ห้าม return
    assert(!drained, "waitForInFlight returned while timer-launched flush still processing");
    await w; // callBot จบ → finalize → drain ออก
    assert(drained, "drain completes after callBot finishes");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
    assert(replyInboundIds("conv_n3").length === 1, "exactly one reply — finalize ครั้งเดียว");
  });

  await test("N4 in-flight flush error after shutdown schedules no new retry", async () => {
    // N3 ทิ้ง zombie flush ไว้ (timer-launched flush ไม่ถูก drain — pre-fix) — รอให้จบก่อน
    await sleep(800);
    mocks.state.config.bot_buffer_max_messages = 1; // immediate flush path — flush อยู่ใน poll's in-flight promise
    mocks.botworkerRuntime.flushErrorRetryMs = 120; // retry window สั้นพอให้สังเกต zombie
    mocks.botworkerRuntime.heartbeatMs = 60_000; // ห้าม heartbeat กลาง callBot → reply persist ก่อน finalize miss
    (state as any).callBotDelayMs = 300;
    seedInbound("n4", "conv_n4");
    await svc.botWorkerService.pollNewMessages(new Date(0)); // claim → bufferOrProcess → flushBuffer inline (era signal)
    for (let i = 0; i < 100 && state.calls.botInFlight === 0; i++) await sleep(10);
    assert(state.calls.botInFlight === 1, "flush เริ่มแล้ว — callBot ค้างใน processMessage");
    // partial finalize post-shutdown: fencing bump → finalize CAS miss → finalized=false → retry path
    claimOf("n4")!.fencing_token += 1;
    (svc.botWorkerService as any).clearPendingWork(); // abort ขณะ processMessage ทำงานอยู่
    let postAbortFinds = 0;
    (state as any).onQuery = (coll: string, op: string, filter: any) => {
      if (coll === "buffer_messages" && op === "find" && filter?.conversation_id === "conv_n4") postAbortFinds++;
    };
    await svc.botWorkerService.waitForInFlight(3000); // drain in-flight flush (finalize miss → buffer_error)
    await sleep(300); // ผ่าน retry window — cancelled era ต้องไม่มี timer ยิงเพิ่ม
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — started work finishes`);
    assert(postAbortFinds === 0,
      `postAbortFinds=${postAbortFinds} want 0 — cancelled era ห้ามฝาก retry timer ใหม่`);
    // row revert กลับ buffered + claim ยัง processing (finalize miss) → recoverable
    mocks.fakeColl("chat_processing").forEach((d: any) => {
      d.lease_expires_at = new Date(Date.now() - 1000);
    });
    await svc.botWorkerService.recoverStaleBuffers();
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — persisted reply → finalize-only`);
    assert(replyInboundIds("conv_n4").length === 1, "exactly one reply");
    assert(bufRows("conv_n4").length === 0, "row cleaned by next-era recovery");
  });

  await test("N5 normal regression — debounce merge + immediate max flush unchanged", async () => {
    mocks.state.config.bot_buffer_window_ms = 80;
    seedInbound("n5a", "conv_n5a");
    seedInbound("n5b", "conv_n5a");
    await svc.botWorkerService.pollNewMessages(new Date(0));
    for (let i = 0; i < 100 && bufRows("conv_n5a").length < 2; i++) await sleep(10);
    await sleep(140); // debounce รวม 2 ข้อความ → 1 flush
    await settle();
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — debounce merge เป็น batch เดียว`);
    assert(replyInboundIds("conv_n5a").length === 2, "reply covers both inbound ids");
    mocks.state.config.bot_buffer_max_messages = 1; // immediate path
    seedInbound("n5c", "conv_n5c");
    await svc.botWorkerService.pollNewMessages(new Date(0));
    await settle();
    assert(state.calls.callBot === 2, `callBot=${state.calls.callBot} want 2 — max-message flush ทันที`);
    assert(replyInboundIds("conv_n5c").length === 1, "second conv replied once");
  });

  // N6 [RED] — shutdown ขณะ parent poll กำลังรอ inbound Mongo query:
  //   poll ต้องถือ era signal เดิมตั้งแต่ก่อน await แรก + promise ต้องอยู่ใน drain
  //   หลัง query จบ → boundary เห็น aborted → ไม่สร้าง era ใหม่ ไม่ claim/buffer/bot
  await test("N6 shutdown mid-poll Mongo wait → drain waits parent, no new era work", async () => {
    seedInbound("n6", "conv_n6");
    let findIssued = false;
    let releaseFind: (() => void) | undefined;
    const gate = new Promise<void>((r) => (releaseFind = r));
    (state as any).onQuery = (coll: string, op: string) => {
      if (coll === "messages" && op === "find") findIssued = true;
    };
    (state as any).findHook = async (coll: string) => {
      if (coll === "messages") await gate; // stall เฉพาะ inbound find ของ poll — deterministic latch
    };
    try {
      const pollP = svc.botWorkerService.pollNewMessages(new Date(0));
      for (let i = 0; i < 200 && !findIssued; i++) await sleep(10);
      assert(findIssued, "poll must be mid inbound find when shutdown lands");
      svc.botWorkerService.clearPendingWork(); // shutdown ขณะ poll ยังรอ Mongo
      let drainReturned = false;
      const drainP = svc.botWorkerService.waitForInFlight(10000).then(() => { drainReturned = true; });
      await sleep(60);
      const drainEarly = drainReturned; // capture verdict ก่อนปล่อย latch เสมอ
      (state as any).findHook = null;
      releaseFind!();
      const res = await pollP;
      await drainP;
      assert(!drainEarly, "waitForInFlight returned while parent poll still mid-query");
      assert(res.processed === 0, `processed=${res.processed} — aborted era must kick nothing`);
      assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} want 0 — no post-shutdown LLM`);
      assert(claimOf("n6") === undefined, "no claim doc may be created post-shutdown");
      assert(bufRows("conv_n6").length === 0, "no buffer row may be created post-shutdown");
      assert(replyInboundIds("conv_n6").length === 0, "no shadow reply post-shutdown");
    } finally {
      (state as any).findHook = null;
      releaseFind?.();
    }
  });

  // N7 — explicit next era: poll หลัง shutdown ต้องเริ่ม era ใหม่และทำงานครบ once
  await test("N7 explicit next era after shutdown → poll processes once", async () => {
    mocks.state.config.bot_buffer_window_ms = 60;
    seedInbound("n7", "conv_n7");
    const res = await svc.botWorkerService.pollNewMessages(new Date(0)); // era ใหม่ชัดเจน (eraAbort เดิม aborted จาก N6)
    assert(res.processed === 1, `processed=${res.processed} want 1 — explicit poll must kick`);
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
