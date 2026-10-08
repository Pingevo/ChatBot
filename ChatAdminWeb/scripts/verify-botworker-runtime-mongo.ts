// Botworker real-Mongo smoke harness — Part 3: loopback-only disposable Mongo.
//
// เมื่อได้รับอนุมัติ จะรัน production botworker services จริงบน
// isolated temp DB (`botworker_runtime_verify_<rand>`) บน loopback disposable
// Mongo ที่ส่งเข้ามาผ่าน BOTWORKER_VERIFY_MONGO_URI เท่านั้น — ไม่แตะ
// production/configured Mongo, ไม่เรียก Python/LLM/Shopee
//
// Fail-closed CLI:
//   default                                      → dry-run plan (no Mongo/env/import)
//   --apply                                      → refuse ถ้าไม่มี approval token
//   token + --apply                              → refuse ถ้าไม่มี loopback URI
//
// Import ordering (จำเป็น): explicit verify URI validate → strict-env
//   rebind จาก test-local constants เท่านั้น (ADMIN_MONGO_URI/DB,
//   ADMIN_JWT_SECRET, CHATBOT_INTERNAL_SECRET, CHATBOT_BASE_URL_SHOPEE —
//   ห้ามอ่าน env file หรือ fallback ไป configured env) → dynamic import
//   services → seed → scenarios → cleanup (production
//   config/mongoClient ผูก env ตอน module evaluation — ห้าม static import)
import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVAL_ENV = "BOTWORKER_REAL_MONGO_SMOKE";
export const APPROVAL_TOKEN = "I_UNDERSTAND_ISOLATED_DB_WRITES";
export const ID_PREFIX = "__verify_bw_runtime_";
export const VERIFY_URI_ENV = "BOTWORKER_VERIFY_MONGO_URI";
export const VERIFY_DB_PREFIX = "botworker_runtime_verify_";
export const MARKER_COLLECTION = "_verify_bw_runtime_marker";

const RAND_SUFFIX_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ── CLI ──────────────────────────────────────────────────────
export function parseArgs(argv: string[]): { apply: boolean } {
  const opts = { apply: false };
  for (const a of argv) {
    if (a === "--apply") opts.apply = true;
    else throw new Error(`unknown arg: ${a} (allowed: --apply)`);
  }
  return opts;
}

export function assertApplyApproved(env: NodeJS.ProcessEnv, apply: boolean): void {
  if (!apply) return;
  if (env[APPROVAL_ENV] !== APPROVAL_TOKEN) {
    throw new Error(
      `--apply refused: requires ${APPROVAL_ENV}=${APPROVAL_TOKEN} ` +
      `(isolated-DB writes acknowledgement; Part 2 only)`
    );
  }
}

// ── loopback-only Mongo URI (disposable local Mongo เท่านั้น — ห้าม production) ──
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function validateLoopbackMongoUri(uri: string): string {
  if (!uri.startsWith("mongodb://")) throw new Error("verify URI must use mongodb:// scheme");
  if (uri.includes("?")) throw new Error("verify URI must not carry query params (authSource/tls)");
  let u: URL;
  try { u = new URL(uri); } catch { throw new Error("malformed verify URI"); }
  if (u.username || u.password) throw new Error("verify URI must not contain credentials");
  if (!LOOPBACK_HOSTS.has(u.hostname)) throw new Error(`verify URI host must be loopback — got ${u.hostname || "<empty>"}`);
  if (!u.port) throw new Error("verify URI must carry an explicit port");
  if (u.port === "27017") throw new Error("verify URI must not use default/prod port 27017");
  return uri;
}

// ── isolated DB naming — harness constant, never derived from configured/prod ──
export function deriveIsolatedDbName(randSuffix: string): string {
  if (!RAND_SUFFIX_RE.test(randSuffix)) throw new Error(`invalid verify suffix: ${JSON.stringify(randSuffix)}`);
  const name = `${VERIFY_DB_PREFIX}${randSuffix}`;
  assertIsolatedDbName(name);
  return name;
}

export function assertIsolatedDbName(dbName: string): void {
  if (!dbName.startsWith(VERIFY_DB_PREFIX) || !RAND_SUFFIX_RE.test(dbName.slice(VERIFY_DB_PREFIX.length))) {
    throw new Error(`DB name does not match required pattern ${VERIFY_DB_PREFIX}<rand> — refuse`);
  }
}

// ── cleanup guard (all three must hold before dropDatabase) ──
export function assertCleanupAllowed(t: {
  dbName: string;
  markerToken: string | null; expectedToken: string;
}): void {
  assertIsolatedDbName(t.dbName);                       // ชื่อตรง verify pattern เท่านั้น
  if (!t.markerToken) throw new Error("cleanup refused: marker document missing");
  if (t.markerToken !== t.expectedToken) throw new Error("cleanup refused: marker token mismatch");
}

// ── sanitized output ─────────────────────────────────────────
const SECRET_PATTERNS = [
  /mongodb(\+srv)?:\/\//i,
  /\bpassword\b\s*[:=]/i,
  /ADMIN_MONGO_(URI|USERNAME|PASSWORD)\s*=/i,
];
export function assertSanitizedOutput(text: string): void {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) throw new Error(`unsafe output — matched ${re}`);
  }
}

// ── error sanitizer — whitelist only: stage + error name + numeric code ──
// raw driver messages carry URI/DB-name/command docs — ห้าม log e.message ตรงๆ
export function sanitizeError(e: unknown, stage: string): string {
  const raw = e instanceof Error ? e.name : "";
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(raw) ? raw : "Error";
  const c = (e as { code?: unknown })?.code;
  const code = typeof c === "number" && Number.isFinite(c) ? ` code=${c}` : "";
  return `${stage}: ${name}${code}`;
}

// ── exit-code contract — single owner: runApply returns it, main() writes it ──
// cleanup failure ต้อง fail process เสมอ (temp DB ค้าง = ต้องให้คนตรวจ)
export function smokeExitCode(failedAssertions: number, cleanupFailed: boolean): number {
  return failedAssertions > 0 || cleanupFailed ? 1 : 0;
}

// ── scenario matrix (S1–S6) ──────────────────────────────────
export const SCENARIOS = [
  {
    id: "S1", name: "duplicate claim",
    goal: "processMessage เรียกพร้อมกัน 2 ครั้งบน inbound เดียว",
    expects: [
      "fake /chat called exactly once",
      "deterministic claim doc = 1 (botworker:claim:<mid>)",
      "claim terminal bot_answered; shadow reply = 1",
      "losing invocation → skip (no second bot call)",
      "no platform delivery",
    ],
  },
  {
    id: "S2", name: "buffer batch",
    goal: "2 inbound ใน conversation เดียวผ่าน production poll/buffer/flush",
    expects: [
      "bot call exactly once; request รวมทั้งสองข้อความ",
      "claims ทั้งสอง terminal",
      "reply deterministic ไม่ซ้ำ",
      "buffer rows deleted after finalize",
    ],
  },
  {
    id: "S3", name: "HTTP 429 one-shot",
    goal: "fake /chat คืน 429 — claim ต้องจบ ไม่ retry เพิ่มเอง",
    expects: [
      "claim terminal bot_failed",
      "call count = 1; re-invoke same message → still 1",
      "no phantom reply; no auto handoff/platform delivery",
    ],
  },
  {
    id: "S4", name: "new message after failed turn",
    goal: "หลัง S3 fail — ข้อความใหม่ต้องส่ง history ถูก",
    expects: [
      "failed inbound อยู่ใน history ครั้งเดียว",
      "ข้อความใหม่อยู่ใน body.message; ไม่ซ้ำใน history",
      "bot call เพิ่ม 1; claim ใหม่ terminal ปกติ",
    ],
  },
  {
    id: "S5", name: "stale recovery without evidence",
    goal: "expired processing claim + stale buffer row, ไม่มี outcome/reply",
    expects: [
      "fake /chat calls = 0 (finalize-only)",
      "claim terminal no_action, error=stale_at_recovery",
      "buffer row deleted on fenced finalize",
    ],
  },
  {
    id: "S6", name: "recovery with committed evidence",
    goal: "expired claim + row + outcome_type/persisted reply",
    expects: [
      "fake /chat calls = 0",
      "finalize-only; terminal preserves outcome_type",
      "reply count ไม่เพิ่ม; buffer row deleted",
    ],
  },
  {
    id: "S7", name: "concurrent absent acquire (worker-leadership)",
    goal: "2 owner IDs แย่ง singleton leader doc ที่หายไป — DB-level CAS จริง",
    expects: [
      "winner เพียงหนึ่งราย; loser คืน false",
      "botworker_state มี singleton doc เดียว",
      "owner_id = winner; fencing_token = 1",
      "fake /chat calls เพิ่ม = 0",
    ],
  },
  {
    id: "S8", name: "active renew + foreign rejection",
    goal: "winner renew lease สำเร็จ ขณะ loser active-lease admission ถูกปฏิเสธ",
    expects: [
      "winner renew สำเร็จ; owner_id เดิม; token ยัง 1",
      "lease_expires_at เพิ่มขึ้น",
      "loser คืน false; document ไม่ถูก loser แก้",
      "fake /chat calls เพิ่ม = 0",
    ],
  },
  {
    id: "S9", name: "expired concurrent takeover",
    goal: "lease หมดอายุ → owner ใหม่ 2 รายแย่ง takeover — fenced token +1 ครั้งเดียว",
    expects: [
      "takeover winner เพียงหนึ่งราย; อีกฝ่าย false",
      "singleton doc เดียว; owner_id = winner; token = 2 พอดี",
      "lease_expires_at อนาคต; stale owner (token 1) re-call → false",
      "fake /chat calls เพิ่ม = 0",
    ],
  },
] as const;

// ── dry-run plan (sanitized — no URI/secret/prod name) ───────
export function renderDryRunPlan(): string {
  const lines = [
    "=== botworker real-Mongo smoke — DRY RUN ===",
    "",
    "isolation model (loopback-only disposable Mongo — Part 3):",
    `  mongo URI    : ${VERIFY_URI_ENV} — mongodb scheme + loopback host เท่านั้น (127.0.0.1/localhost/[::1], explicit port, ห้าม 27017, ห้าม credentials)`,
    `  temp DB      : ${VERIFY_DB_PREFIX}<random-16-hex> — harness constant, ไม่ derive จาก configured/prod DB`,
    `  marker       : ${MARKER_COLLECTION} doc {token:<random-16-hex>} — dropDatabase ต้องมี marker+token ตรง`,
    `  fake chatbot : http server บน 127.0.0.1 ephemeral port — CHATBOT_BASE_URL_SHOPEE ชี้มาก่อน import services`,
    `  IDs          : conversation/message/shop ทั้งหมด prefix ${ID_PREFIX}*`,
    `  indexes      : เฉพาะ buffer_messages.message_id unique sparse ใน temp DB — ไม่เรียก ensureIndexes`,
    `  cleanup      : finally → marker+token+name guards → dropDatabase temp DB เท่านั้น; close fake server เสมอ`,
    "",
    "scenarios (Part 2 --apply เท่านั้นที่ execute):",
    ...SCENARIOS.flatMap((s) => [`  ${s.id} ${s.name} — ${s.goal}`, ...s.expects.map((e) => `      - ${e}`)]),
    "",
    "apply gate:",
    `  ${APPROVAL_ENV}=${APPROVAL_TOKEN} \\`,
    `  ${VERIFY_URI_ENV}=mongodb-scheme://127.0.0.1:<port> \\`,
    `  npx tsx scripts/verify-botworker-runtime-mongo.ts --apply`,
    "  ไม่มี flag/token/loopback-URI → exit non-zero, Mongo connections=0, runtime imports=0",
  ];
  const out = lines.join("\n");
  assertSanitizedOutput(out);
  return out;
}

// ── apply path — ทุก side effect อยู่ใน runApply() เท่านั้น ──
type AnyDoc = Record<string, unknown>;

interface FakeChatbot {
  url: string;
  calls: { body: AnyDoc }[];
  setMode: (status: number, body: AnyDoc) => void;
  close: () => Promise<void>;
}
const SUCCESS_BODY = {
  answer: "synthetic bot answer", source: "synthetic_verify", model: "none",
  elapsed: 0, usage: { prompt: 0, output: 0, total: 0 }, cost: 0,
};

async function startFakeChatbot(): Promise<FakeChatbot> {
  const http = await import("node:http");
  const calls: { body: AnyDoc }[] = [];
  let mode: { status: number; body: AnyDoc } = { status: 200, body: SUCCESS_BODY };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      let body: AnyDoc = {};
      try { body = JSON.parse(data); } catch { /* keep {} */ }
      calls.push({ body }); // body เท่านั้น — ไม่เก็บ headers (x-internal-secret)
      res.writeHead(mode.status, { "content-type": "application/json" });
      res.end(JSON.stringify(mode.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setMode: (status, body) => { mode = { status, body }; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any; // production services — typed via dynamic import in runApply
interface RunCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  COLLECTIONS: Record<string, string>;
  svc: Svc;
  fake: FakeChatbot;
  results: { id: string; ok: boolean; detail: string }[];
}
function expect(ctx: RunCtx, id: string, name: string, cond: boolean, detail = "") {
  ctx.results.push({ id, ok: cond, detail: cond ? name : `${name} — ${detail}` });
}

async function seedInbound(ctx: RunCtx, mid: string, conv: string, text: string, at: Date) {
  await ctx.db.collection(ctx.COLLECTIONS.messages).insertOne({
    message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`,
    platform: "shopee", role: "user", direction: "in", text,
    created_timestamp: at, raw_payload: { synthetic: true },
  });
}

// S1 — duplicate claim
async function s1(ctx: RunCtx) {
  const conv = `${ID_PREFIX}conv_s1`, mid = `${ID_PREFIX}s1_m1`;
  const n0 = ctx.fake.calls.length;
  await seedInbound(ctx, mid, conv, `${ID_PREFIX}s1 hello`, new Date());
  const msg = { message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`, platform: "shopee", text: `${ID_PREFIX}s1 hello` };
  const [a, b] = await Promise.all([ctx.svc.processMessage({ ...msg }), ctx.svc.processMessage({ ...msg })]);
  const claims = await ctx.db.collection(ctx.COLLECTIONS.chatProcessing).find({ message_id: mid }).toArray();
  const replies = await ctx.db.collection(ctx.COLLECTIONS.shadowReplies).find({ conversation_id: conv }).toArray();
  expect(ctx, "S1", "bot called once", ctx.fake.calls.length - n0 === 1, `calls=${ctx.fake.calls.length - n0}`);
  expect(ctx, "S1", "one claim doc", claims.length === 1, `claims=${claims.length}`);
  expect(ctx, "S1", "claim terminal bot_answered", claims[0]?.status === "bot_answered", `status=${claims[0]?.status}`);
  expect(ctx, "S1", "one shadow reply", replies.length === 1, `replies=${replies.length}`);
  expect(ctx, "S1", "loser skip/no-double-work", [a.status, b.status].includes("skip") || a.status === b.status, `statuses=${a.status},${b.status}`);
}

// S2 — buffer batch via production poll path
async function s2(ctx: RunCtx) {
  const conv = `${ID_PREFIX}conv_s2`, m1 = `${ID_PREFIX}s2_m1`, m2 = `${ID_PREFIX}s2_m2`;
  const since = new Date();
  const n0 = ctx.fake.calls.length;
  await sleep(5);
  await seedInbound(ctx, m1, conv, `${ID_PREFIX}s2 first`, new Date());
  await seedInbound(ctx, m2, conv, `${ID_PREFIX}s2 second`, new Date());
  await ctx.svc.pollNewMessages(since);
  await ctx.svc.waitForInFlight(10000);
  await sleep(500); // debounce window 150ms + flush margin
  await ctx.svc.waitForInFlight(10000);
  const blob = JSON.stringify(ctx.fake.calls[n0]?.body ?? {});
  const claims = await ctx.db.collection(ctx.COLLECTIONS.chatProcessing).find({ message_id: { $in: [m1, m2] } }).toArray();
  const rows = await ctx.db.collection(ctx.COLLECTIONS.bufferMessages).find({ conversation_id: conv, kind: "message" }).toArray();
  const replies = await ctx.db.collection(ctx.COLLECTIONS.shadowReplies).find({ conversation_id: conv }).toArray();
  expect(ctx, "S2", "bot called once", ctx.fake.calls.length - n0 === 1, `calls=${ctx.fake.calls.length - n0}`);
  expect(ctx, "S2", "request merged both texts", blob.includes("s2 first") && blob.includes("s2 second"));
  expect(ctx, "S2", "both claims terminal", claims.length === 2 && claims.every((c: AnyDoc) => c.status !== "processing"), `statuses=${claims.map((c: AnyDoc) => c.status)}`);
  expect(ctx, "S2", "one reply", replies.length === 1, `replies=${replies.length}`);
  expect(ctx, "S2", "buffer rows deleted", rows.length === 0, `rows=${rows.length}`);
}

// S3 — HTTP 429 one-shot (+ S4 ต่อเนื่อง conv เดียวกัน)
async function s3(ctx: RunCtx): Promise<{ conv: string; mid: string; oldText: string }> {
  const conv = `${ID_PREFIX}conv_s34`, mid = `${ID_PREFIX}s3_m1`;
  const oldText = `${ID_PREFIX}s3 old-turn text`;
  const n0 = ctx.fake.calls.length;
  await seedInbound(ctx, mid, conv, oldText, new Date(Date.now() - 60000));
  ctx.fake.setMode(429, { error: "rate_limited" });
  const r = await ctx.svc.processMessage({ message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`, platform: "shopee", text: oldText });
  ctx.fake.setMode(200, SUCCESS_BODY);
  const claim = await ctx.db.collection(ctx.COLLECTIONS.chatProcessing).findOne({ message_id: mid });
  const replies = await ctx.db.collection(ctx.COLLECTIONS.shadowReplies).find({ conversation_id: conv }).toArray();
  const callsAfterFail = ctx.fake.calls.length - n0;
  await ctx.svc.processMessage({ message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`, platform: "shopee", text: oldText });
  expect(ctx, "S3", "claim terminal bot_failed", claim?.status === "bot_failed", `status=${claim?.status} r=${r.status}`);
  expect(ctx, "S3", "call count stays 1 after re-invoke", callsAfterFail === 1 && ctx.fake.calls.length - n0 === 1, `calls=${ctx.fake.calls.length - n0}`);
  expect(ctx, "S3", "no phantom reply", replies.length === 0, `replies=${replies.length}`);
  const handoff = await ctx.db.collection(ctx.COLLECTIONS.testStatusConversation).findOne({ conversation_id: conv, status: "handoff" });
  expect(ctx, "S3", "no auto handoff", !handoff);
  return { conv, mid, oldText };
}

// S4 — new message after failed turn (history correctness)
async function s4(ctx: RunCtx, p: { conv: string; mid: string; oldText: string }) {
  const mid2 = `${ID_PREFIX}s4_m2`, newText = `${ID_PREFIX}s4 new-turn text`;
  const n0 = ctx.fake.calls.length;
  await seedInbound(ctx, mid2, p.conv, newText, new Date());
  await ctx.svc.processMessage({ message_id: mid2, conversation_id: p.conv, shop_id: `${ID_PREFIX}shop`, platform: "shopee", text: newText });
  const body = ctx.fake.calls[n0]?.body as AnyDoc | undefined;
  const hist = JSON.stringify(body?.history ?? []);
  const claim = await ctx.db.collection(ctx.COLLECTIONS.chatProcessing).findOne({ message_id: mid2 });
  expect(ctx, "S4", "bot called once more", ctx.fake.calls.length - n0 === 1, `calls=${ctx.fake.calls.length - n0}`);
  expect(ctx, "S4", "current message = new text", body?.message === newText, `message=${body?.message}`);
  const oldInHist = (hist.match(/s3 old-turn text/g) || []).length;
  expect(ctx, "S4", "failed inbound in history once", oldInHist === 1, `count=${oldInHist}`);
  expect(ctx, "S4", "new text not duplicated in history", !hist.includes("s4 new-turn text"));
  expect(ctx, "S4", "new claim terminal", claim?.status === "bot_answered", `status=${claim?.status}`);
}

// S5 — stale recovery without evidence
async function s5(ctx: RunCtx) {
  const conv = `${ID_PREFIX}conv_s5`, mid = `${ID_PREFIX}s5_m1`;
  const claimId = `botworker:claim:${mid}`;
  const past = new Date(Date.now() - 3600_000);
  const n0 = ctx.fake.calls.length;
  await ctx.db.collection(ctx.COLLECTIONS.chatProcessing).insertOne({
    _id: claimId, message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`,
    platform: "shopee", status: "processing", owner_id: `${ID_PREFIX}dead_owner`,
    fencing_token: 1, attempt: 1, lease_expires_at: past, claimed_at: past, processed_at: past,
  });
  await ctx.db.collection(ctx.COLLECTIONS.bufferMessages).insertOne({
    message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`, platform: "shopee",
    text: `${ID_PREFIX}s5 stale`, raw_payload: { synthetic: true }, received_at: past,
    kind: "message", status: "buffered", claim_id: claimId,
    owner_id: `${ID_PREFIX}dead_owner`, fencing_token: 1,
  });
  await ctx.svc.recoverStaleBuffers();
  await ctx.svc.waitForInFlight(10000);
  const claim = await ctx.db.collection(ctx.COLLECTIONS.chatProcessing).findOne({ _id: claimId });
  const rows = await ctx.db.collection(ctx.COLLECTIONS.bufferMessages).find({ conversation_id: conv, kind: "message" }).toArray();
  expect(ctx, "S5", "no bot call", ctx.fake.calls.length - n0 === 0, `calls=${ctx.fake.calls.length - n0}`);
  expect(ctx, "S5", "claim terminal no_action", claim?.status === "no_action", `status=${claim?.status}`);
  expect(ctx, "S5", "error=stale_at_recovery", claim?.error === "stale_at_recovery", `error=${claim?.error}`);
  expect(ctx, "S5", "buffer row deleted", rows.length === 0, `rows=${rows.length}`);
}

// S6 — recovery with committed evidence
async function s6(ctx: RunCtx) {
  const conv = `${ID_PREFIX}conv_s6`, mid = `${ID_PREFIX}s6_m1`;
  const claimId = `botworker:claim:${mid}`, rid = `${ID_PREFIX}s6_reply`;
  const past = new Date(Date.now() - 3600_000);
  const n0 = ctx.fake.calls.length;
  await ctx.db.collection(ctx.COLLECTIONS.chatProcessing).insertOne({
    _id: claimId, message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`,
    platform: "shopee", status: "processing", owner_id: `${ID_PREFIX}dead_owner`,
    fencing_token: 1, attempt: 1, lease_expires_at: past, claimed_at: past, processed_at: past,
    outcome_type: "bot_answered", reply_ids: [rid], shadow_reply_id: rid,
  });
  await ctx.db.collection(ctx.COLLECTIONS.shadowReplies).insertOne({
    _id: rid, inbound_message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`,
    platform: "shopee", answer: "synthetic persisted reply", source: "synthetic_verify",
    created_at: past,
  });
  await ctx.db.collection(ctx.COLLECTIONS.bufferMessages).insertOne({
    message_id: mid, conversation_id: conv, shop_id: `${ID_PREFIX}shop`, platform: "shopee",
    text: `${ID_PREFIX}s6 stale`, raw_payload: { synthetic: true }, received_at: past,
    kind: "message", status: "buffered", claim_id: claimId,
    owner_id: `${ID_PREFIX}dead_owner`, fencing_token: 1,
  });
  await ctx.svc.recoverStaleBuffers();
  await ctx.svc.waitForInFlight(10000);
  const claim = await ctx.db.collection(ctx.COLLECTIONS.chatProcessing).findOne({ _id: claimId });
  const replies = await ctx.db.collection(ctx.COLLECTIONS.shadowReplies).find({ conversation_id: conv }).toArray();
  const rows = await ctx.db.collection(ctx.COLLECTIONS.bufferMessages).find({ conversation_id: conv, kind: "message" }).toArray();
  expect(ctx, "S6", "no bot call", ctx.fake.calls.length - n0 === 0, `calls=${ctx.fake.calls.length - n0}`);
  expect(ctx, "S6", "terminal preserves outcome_type", claim?.status === "bot_answered", `status=${claim?.status}`);
  expect(ctx, "S6", "reply count unchanged", replies.length === 1, `replies=${replies.length}`);
  expect(ctx, "S6", "buffer row deleted", rows.length === 0, `rows=${rows.length}`);
}

// verify-only fixed values — NOT secrets; injected so strict requiredStrict()
// envs never fall back to real environment/config (no env file is ever read)
const VERIFY_ONLY_JWT_SECRET = "verify-only-jwt-nonsecret";
const VERIFY_ONLY_INTERNAL_SECRET = "verify-only-internal-nonsecret";

// S7 — concurrent absent acquire: DB-level worker-leadership race (BW-2)
// uses ensureLeadership(explicitOwnerId) directly — process-global owner ไม่ถูก rebind
async function s7(ctx: RunCtx): Promise<{ winner: string; loser: string }> {
  const A = `${ID_PREFIX}worker_A`, B = `${ID_PREFIX}worker_B`;
  const n0 = ctx.fake.calls.length;
  const state = ctx.db.collection(ctx.COLLECTIONS.botworkerState);
  await state.deleteOne({ _id: "botworker:leader" }); // temp DB singleton only
  const [ra, rb] = await Promise.all([ctx.svc.ensureLeadership(A), ctx.svc.ensureLeadership(B)]);
  const docs = await state.find({ _id: "botworker:leader" }).toArray();
  const doc = docs[0];
  const winners = [ra && A, rb && B].filter(Boolean);
  const winner = (ra ? A : B) as string;
  const loser = winner === A ? B : A;
  expect(ctx, "S7", "exactly one winner, loser false", winners.length === 1 && (winner === A ? rb === false : ra === false), `ra=${!!ra} rb=${!!rb}`);
  expect(ctx, "S7", "singleton leader doc = 1", docs.length === 1, `docs=${docs.length}`);
  expect(ctx, "S7", "doc owner = winner", doc?.owner_id === winner, `owner=${doc?.owner_id}`);
  expect(ctx, "S7", "fencing_token = 1", doc?.fencing_token === 1, `token=${doc?.fencing_token}`);
  expect(ctx, "S7", "no fake /chat calls", ctx.fake.calls.length - n0 === 0, `calls=${ctx.fake.calls.length - n0}`);
  return { winner, loser };
}

// S8 — active renew (same owner, token unchanged) + foreign rejection while active
async function s8(ctx: RunCtx, p: { winner: string; loser: string }) {
  const n0 = ctx.fake.calls.length;
  const state = ctx.db.collection(ctx.COLLECTIONS.botworkerState);
  const before = await state.findOne({ _id: "botworker:leader" });
  const renew = await ctx.svc.ensureLeadership(p.winner);
  const afterRenew = await state.findOne({ _id: "botworker:leader" });
  const foreign = await ctx.svc.ensureLeadership(p.loser);
  const afterLoser = await state.findOne({ _id: "botworker:leader" });
  expect(ctx, "S8", "winner renew returns ctx", !!renew, `renew=${!!renew}`);
  expect(ctx, "S8", "owner_id unchanged", afterRenew?.owner_id === p.winner, `owner=${afterRenew?.owner_id}`);
  expect(ctx, "S8", "fencing_token still 1", afterRenew?.fencing_token === 1, `token=${afterRenew?.fencing_token}`);
  expect(ctx, "S8", "lease_expires_at increased",
    !!before && !!afterRenew && new Date(afterRenew.lease_expires_at).getTime() > new Date(before.lease_expires_at).getTime(),
    `${before?.lease_expires_at} -> ${afterRenew?.lease_expires_at}`);
  expect(ctx, "S8", "foreign loser returns false", foreign === false, `foreign=${!!foreign}`);
  expect(ctx, "S8", "loser did not modify doc",
    !!afterLoser && afterLoser.owner_id === afterRenew?.owner_id
      && afterLoser.fencing_token === afterRenew?.fencing_token
      && new Date(afterLoser.lease_expires_at).getTime() === new Date(afterRenew.lease_expires_at).getTime());
  expect(ctx, "S8", "no fake /chat calls", ctx.fake.calls.length - n0 === 0, `calls=${ctx.fake.calls.length - n0}`);
}

// S9 — expired concurrent takeover: fenced $inc token exactly once; stale owner refused
async function s9(ctx: RunCtx, p: { winner: string }) {
  const C = `${ID_PREFIX}worker_C`, D = `${ID_PREFIX}worker_D`;
  const n0 = ctx.fake.calls.length;
  const state = ctx.db.collection(ctx.COLLECTIONS.botworkerState);
  const snap = await state.findOne({ _id: "botworker:leader" });
  // expire the winner's lease with a fenced update (CAS on observed owner+token)
  const exp = await state.updateOne(
    { _id: "botworker:leader", owner_id: snap?.owner_id, fencing_token: snap?.fencing_token },
    { $set: { lease_expires_at: new Date(Date.now() - 1000), updated_at: new Date(Date.now() - 1000) } },
  );
  expect(ctx, "S9", "fenced expire applied", exp.matchedCount === 1, `matched=${exp.matchedCount}`);
  const [rc, rd] = await Promise.all([ctx.svc.ensureLeadership(C), ctx.svc.ensureLeadership(D)]);
  const winner2 = rc ? C : D;
  const docs = await state.find({ _id: "botworker:leader" }).toArray();
  const doc = docs[0];
  const stale = await ctx.svc.ensureLeadership(p.winner);
  expect(ctx, "S9", "exactly one takeover winner, other false", [rc, rd].filter(Boolean).length === 1, `rc=${!!rc} rd=${!!rd}`);
  expect(ctx, "S9", "singleton doc still 1", docs.length === 1, `docs=${docs.length}`);
  expect(ctx, "S9", "owner_id = takeover winner", doc?.owner_id === winner2, `owner=${doc?.owner_id}`);
  expect(ctx, "S9", "fencing_token = 2 exactly", doc?.fencing_token === 2, `token=${doc?.fencing_token}`);
  expect(ctx, "S9", "lease_expires_at in future", !!doc && new Date(doc.lease_expires_at).getTime() > Date.now());
  expect(ctx, "S9", "stale owner (token 1) refused", stale === false, `stale=${!!stale}`);
  expect(ctx, "S9", "no fake /chat calls", ctx.fake.calls.length - n0 === 0, `calls=${ctx.fake.calls.length - n0}`);
}

async function runApply(): Promise<number> {
  // 1) explicit verify URI from process env ONLY — missing/invalid → refuse
  //    before any env rebind or production import
  const uri = validateLoopbackMongoUri(process.env[VERIFY_URI_ENV] || "");
  const suffix = randomBytes(8).toString("hex");
  const dbName = deriveIsolatedDbName(suffix);

  // 2) rebind ALL strict runtime env from test-local constants BEFORE importing
  //    any production module (config binds at import) — never from env file
  process.env.ADMIN_MONGO_URI = uri;
  process.env.ADMIN_MONGO_DB = dbName;
  process.env.ADMIN_JWT_SECRET = VERIFY_ONLY_JWT_SECRET;
  process.env.CHATBOT_INTERNAL_SECRET = VERIFY_ONLY_INTERNAL_SECRET;
  const fake = await startFakeChatbot();
  process.env.CHATBOT_BASE_URL_SHOPEE = fake.url;

  const markerToken = randomBytes(16).toString("hex");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;
  let failedAssertions = 0;
  let cleanupFailed = false;
  try {
    // 3) dynamic imports — singletons bind temp DB + fake URL
    const mongo = await import("../src/backend/db/mongoClient");
    const { botWorkerService } = await import("../src/backend/service/botWorkerService");
    db = await mongo.getDb();
    const ctx: RunCtx = {
      db, COLLECTIONS: mongo.COLLECTIONS as Record<string, string>,
      svc: botWorkerService, fake, results: [],
    };

    // 4) seed: marker first, temp-DB config, minimal index (never ensureIndexes)
    await db.collection(MARKER_COLLECTION).insertOne({ token: markerToken, purpose: ID_PREFIX, created_at: new Date() });
    await db.collection(ctx.COLLECTIONS.bufferMessages).createIndex({ message_id: 1 }, { unique: true, sparse: true });
    await db.collection(ctx.COLLECTIONS.systemConfigs).insertOne({
      config_key: "main_config",
      bot_worker_enabled: true,          // temp DB only — production flag stays false
      bot_buffer_enabled: true,
      bot_buffer_window_ms: 150, bot_buffer_max_messages: 5,
      bot_buffer_window_media_ms: 300, bot_buffer_max_media_messages: 10,
    });

    // 5) scenarios (S3→S4 share a conversation)
    await s1(ctx);
    await s2(ctx);
    const s3state = await s3(ctx);
    await s4(ctx, s3state);
    await s5(ctx);
    await s6(ctx);
    const s7state = await s7(ctx);
    await s8(ctx, s7state);
    await s9(ctx, s7state);
    await botWorkerService.clearPendingWork();

    // 6) report (sanitized)
    const lines = ["=== botworker real-Mongo smoke — RESULTS ==="];
    for (const r of ctx.results) lines.push(`${r.ok ? "PASS" : "FAIL"} ${r.id} ${r.detail}`);
    failedAssertions = ctx.results.filter((r) => !r.ok).length;
    lines.push(`=== ${ctx.results.length - failedAssertions} passed, ${failedAssertions} failed ===`);
    const out = lines.join("\n");
    assertSanitizedOutput(out);
    console.log(out);
  } finally {
    // 7) cleanup: close fake server + guarded dropDatabase (marker+token+name)
    //    ห้าม return ที่นี่ — cleanup failure ต้องส่งกลับผ่าน smokeExitCode
    try {
      await fake.close();
    } catch (e) {
      cleanupFailed = true;
      console.error(`[verify] fake server close failed: ${sanitizeError(e, "server-close")}`);
    }
    if (db) {
      try {
        const marker = await db.collection(MARKER_COLLECTION).findOne({});
        assertCleanupAllowed({ dbName, markerToken: marker?.token ?? null, expectedToken: markerToken });
        const dropped = await db.dropDatabase();
        if (dropped !== true) throw new Error("dropDatabase returned not-true");
        console.log(`[verify] verification DB dropped (${VERIFY_DB_PREFIX}<rand>)`);
      } catch (e) {
        cleanupFailed = true;
        console.error(`[verify] cleanup refused/failed — temp DB left for inspection: ${sanitizeError(e, "cleanup")}`);
      } finally {
        // singleton client จาก getDb() ต้องปิดเสมอ — ไม่งั้น process ไม่จบ
        try {
          await db.client.close();
        } catch (e) {
          cleanupFailed = true;
          console.error(`[verify] mongo client close failed: ${sanitizeError(e, "client-close")}`);
        }
      }
    }
  }
  return smokeExitCode(failedAssertions, cleanupFailed);
}

async function main(): Promise<number> {
  const { apply } = parseArgs(process.argv.slice(2));
  if (!apply) {
    console.log(renderDryRunPlan());
    return 0;
  }
  assertApplyApproved(process.env, true);
  return runApply();
}

// main-guard: run only when invoked directly (import = pure, no side effects)
const invokedAs = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (invokedAs === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(`[verify] refused/failed: ${sanitizeError(e, "run")}`); process.exitCode = 1; });
}
