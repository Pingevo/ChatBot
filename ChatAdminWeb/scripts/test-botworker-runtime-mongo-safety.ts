// Safety contract for verify-botworker-runtime-mongo.ts (Part 1 — harness gate)
//
// ทดสอบ boundary นิรภัยของ harness ก่อนอนุญาต --apply:
//   - default = dry-run (no Mongo / no port / no runtime import / no .env)
//   - --apply ต้อง token ตรงเท่านั้น
//   - temp DB name ต้องเป็น botworker_runtime_verify_<rand> (harness constant, ไม่ derive จาก prod)
//   - explicit BOTWORKER_VERIFY_MONGO_URI ต้อง valid ก่อน dotenv/runtime import เสมอ
//   - cleanup ต้องมี marker token ตรงกันเท่านั้น
//   - output ห้ามมี URI/secret
//   - scenario plan S1–S10 ครบ
//   - ห้ามอ้างอิง verify-botworker-parallel.ts
//
// ไฟล์นี้ pure: ไม่ connect Mongo, ไม่ bind port, ไม่ load .env, ไม่ import serverConfig
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const harnessPath = resolve(here, "verify-botworker-runtime-mongo.ts");

  // ── capability: harness module must exist + import side-effect free ──
  let src: string | null = null;
  try { src = readFileSync(harnessPath, "utf8"); } catch { src = null; }
  check("harness file exists", src !== null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any = null;
  if (src) {
    try {
      H = await import(harnessPath); // ต้อง import ได้โดยไม่ connect/bind/load env
      check("harness module imports side-effect free (no throw)", true);
    } catch (e) {
      check("harness module imports side-effect free (no throw)", false, String(e));
    }
  }

  // ── top-level import scan ──
  if (src) {
    const topImports = [...src.matchAll(/^import\s+(?!type\b)([^'";\n]*?)\s+from\s+["']([^"']+)["']/gm)]
      .map((m) => m[2])
      .concat([...src.matchAll(/^import\s+["']([^"']+)["']/gm)].map((m) => m[1]));
    const forbidden = topImports.filter((m) => !m.startsWith("node:"));
    check("no top-level non-node imports (dotenv/mongodb/runtime modules)", forbidden.length === 0, `found=${JSON.stringify(forbidden)}`);

    const FORBIDDEN_MODS = [
      "botWorkerService", "bufferService", "mongoClient", "systemConfigService",
      "serverConfig", "lib/config", "workflowEngine", "handoffService",
      "verify-botworker-parallel", "dotenv", "mongodb",
    ];
    const hits = FORBIDDEN_MODS.filter((m) => new RegExp(`^import.*${m}`, "m").test(src!));
    check("no top-level import of production runtime modules", hits.length === 0, `found=${JSON.stringify(hits)}`);
    check("verify-botworker-parallel never referenced", !src.includes("verify-botworker-parallel"));
    check("no ensureIndexes call", !/await\s+ensureIndexes\s*\(/.test(src));
  }

  // ── CLI gate ──
  if (H) {
    check("parseArgs([]) → dry-run default", H.parseArgs([]).apply === false);
    check("parseArgs(['--apply']) → apply", H.parseArgs(["--apply"]).apply === true);
    check("parseArgs rejects unknown args", throws(() => H.parseArgs(["--bogus"])));

    check("--apply without token → refuse", throws(() => H.assertApplyApproved({}, true)));
    check("--apply wrong token → refuse", throws(() => H.assertApplyApproved({ [H.APPROVAL_ENV]: "yes" }, true)));
    check("--apply right token → ok", !throws(() => H.assertApplyApproved({ [H.APPROVAL_ENV]: H.APPROVAL_TOKEN }, true)));
    check("dry-run never requires token", !throws(() => H.assertApplyApproved({}, false)));
  }

  // ── loopback-only Mongo URI contract (Part 3) ──
  if (H) {
    check("VERIFY_URI_ENV exported", H.VERIFY_URI_ENV === "BOTWORKER_VERIFY_MONGO_URI");
    check("validateLoopbackMongoUri exists", typeof H.validateLoopbackMongoUri === "function");
    check("accept mongodb://127.0.0.1:27018", typeof H.validateLoopbackMongoUri === "function" && H.validateLoopbackMongoUri("mongodb://127.0.0.1:27018") === "mongodb://127.0.0.1:27018");
    check("accept localhost", typeof H.validateLoopbackMongoUri === "function" && !throws(() => H.validateLoopbackMongoUri("mongodb://localhost:27018")));
    check("accept [::1]", typeof H.validateLoopbackMongoUri === "function" && !throws(() => H.validateLoopbackMongoUri("mongodb://[::1]:27018")));
    check("reject mongodb+srv://", typeof H.validateLoopbackMongoUri === "function" && throws(() => H.validateLoopbackMongoUri("mongodb+srv://cluster.example/")));
    check("reject non-loopback host", typeof H.validateLoopbackMongoUri === "function" && throws(() => H.validateLoopbackMongoUri("mongodb://10.0.0.5:27018")));
    check("reject credentials in URI", typeof H.validateLoopbackMongoUri === "function" && throws(() => H.validateLoopbackMongoUri("mongodb://user:pass@127.0.0.1:27018")));
    check("reject URI without port", typeof H.validateLoopbackMongoUri === "function" && throws(() => H.validateLoopbackMongoUri("mongodb://127.0.0.1")));
    check("reject port 27017", typeof H.validateLoopbackMongoUri === "function" && throws(() => H.validateLoopbackMongoUri("mongodb://127.0.0.1:27017")));
    check("reject malformed URI", typeof H.validateLoopbackMongoUri === "function" && throws(() => H.validateLoopbackMongoUri("not-a-uri")));
    check("reject empty URI", typeof H.validateLoopbackMongoUri === "function" && throws(() => H.validateLoopbackMongoUri("")));
    check("reject URI with query params", typeof H.validateLoopbackMongoUri === "function" && throws(() => H.validateLoopbackMongoUri("mongodb://127.0.0.1:27018/?authSource=admin")));
  }

  // ── isolated DB name contract — harness constant, never prod-derived ──
  if (H) {
    const good = `${H.VERIFY_DB_PREFIX}abc12345`;
    check("deriveIsolatedDbName uses harness constant prefix (no prod arg)", typeof H.deriveIsolatedDbName === "function" && H.deriveIsolatedDbName("abc12345") === good);
    check("derive: invalid rand charset → refuse", typeof H.deriveIsolatedDbName === "function" && throws(() => H.deriveIsolatedDbName("bad.rand")));
    check("derive: empty rand → refuse", typeof H.deriveIsolatedDbName === "function" && throws(() => H.deriveIsolatedDbName("")));
    check("isolated name valid → accept", typeof H.assertIsolatedDbName === "function" && !throws(() => H.assertIsolatedDbName(good)));
    check("isolated name missing prefix → refuse", typeof H.assertIsolatedDbName === "function" && throws(() => H.assertIsolatedDbName("chatbot_admin_abc12345")));
    check("prod-looking name → refuse", typeof H.assertIsolatedDbName === "function" && throws(() => H.assertIsolatedDbName("chatbot_admin")));
    check("unrelated db name → refuse", typeof H.assertIsolatedDbName === "function" && throws(() => H.assertIsolatedDbName("totally_other_db")));
    check("prefix without rand → refuse", typeof H.assertIsolatedDbName === "function" && throws(() => H.assertIsolatedDbName(H.VERIFY_DB_PREFIX)));
  }

  // ── cleanup guard ──
  if (H) {
    const db = `${H.VERIFY_DB_PREFIX}deadbeef99`;
    const ok = { dbName: db, markerToken: "tok123", expectedToken: "tok123" };
    check("cleanup allowed when all guards hold", !throws(() => H.assertCleanupAllowed(ok)));
    check("cleanup: marker missing → refuse", throws(() => H.assertCleanupAllowed({ ...ok, markerToken: null })));
    check("cleanup: marker token mismatch → refuse", throws(() => H.assertCleanupAllowed({ ...ok, markerToken: "other" })));
    check("cleanup: unrelated db → refuse", throws(() => H.assertCleanupAllowed({ ...ok, dbName: "prod_db" })));
  }

  // ── error sanitizer — whitelist fields only (name+code+stage) ──
  if (H) {
    const mongoish = Object.assign(new Error("not authorized on chatbot_admin to execute {insert...}"), { name: "MongoNotAuthorizedError", code: 13 });
    const s = typeof H.sanitizeError === "function" ? H.sanitizeError(mongoish, "seed") : "__missing__";
    check("sanitizer returns stage+name+code", s.includes("seed") && s.includes("MongoNotAuthorizedError") && s.includes("13"), `got=${s}`);
    check("sanitizer strips raw message/URI/db-name", !s.includes("not authorized") && !s.includes("chatbot_admin") && !/mongodb(\+srv)?:\/\//i.test(s), `got=${s}`);
    const plain = typeof H.sanitizeError === "function" ? H.sanitizeError(new Error("boom"), "cleanup") : "__missing__";
    check("sanitizer handles plain Error without code", plain.includes("cleanup") && plain.includes("Error") && !plain.includes("boom"), `got=${plain}`);

    // strict whitelist (final correction): name regex-gated, numeric-finite code only
    const se = (e: unknown) => typeof H.sanitizeError === "function" ? H.sanitizeError(e, "stage") : "__missing__";
    check("name MongoServerError kept", se(Object.assign(new Error("x"), { name: "MongoServerError" })).includes("MongoServerError"));
    check("malicious name → fallback Error", se(Object.assign(new Error("x"), { name: "mongodb://evil\nleak chatbot_admin" })) === "stage: Error");
    check("name with spaces → fallback Error", se(Object.assign(new Error("x"), { name: "Mongo Auth Error" })) === "stage: Error");
    check("name with uri-chars → fallback", se(Object.assign(new Error("x"), { name: "Error://127.0.0.1" })) === "stage: Error");
    check("numeric code 13 shown", se(Object.assign(new Error("x"), { code: 13 })).includes("code=13"));
    check("string code not shown", se(Object.assign(new Error("x"), { code: "ABC-123" })) === "stage: Error");
    check("NaN code not shown", !se(Object.assign(new Error("x"), { code: NaN })).includes("code="));
    check("Infinity code not shown", !se(Object.assign(new Error("x"), { code: Infinity })).includes("code="));
    check("object code not shown", !se(Object.assign(new Error("x"), { code: { leak: "chatbot_admin" } })).includes("code="));
    const nonErr = se({ name: "mongodb://x.y", code: "s", message: "secret" });
    check("non-Error thrown → Error fallback, nothing leaks", nonErr === "stage: Error", `got=${nonErr}`);
  }

  // ── sanitized output ──
  if (H) {
    const plan = H.renderDryRunPlan();
    check("dry-run plan renders", typeof plan === "string" && plan.length > 0);
    check("dry-run plan passes own sanitizer", !throws(() => H.assertSanitizedOutput(plan)));
    check("plan shows no mongo URI", !/mongodb(\+srv)?:\/\//i.test(plan));
    check("sanitizer rejects mongo URI", throws(() => H.assertSanitizedOutput("connect mongodb+srv://u:p@h/db")));
    check("sanitizer rejects password leak", throws(() => H.assertSanitizedOutput("ADMIN_MONGO_PASSWORD=hunter2")));
  }

  // ── exit-code contract — cleanup failure must fail the process ──
  if (H) {
    const code = (f: number, c: boolean) => {
      try { return H.smokeExitCode(f, c); } catch { return "__missing__"; }
    };
    check("exit: pass + clean cleanup → 0", code(0, false) === 0);
    check("exit: failed assertions → 1", code(1, false) === 1);
    check("exit: cleanup failure alone → 1", code(0, true) === 1);
    check("exit: fail + cleanup failure → 1", code(1, true) === 1);
  }
  if (src) {
    // runApply must return the code — .then() is the sole exitCode writer (then+catch = 2)
    check("runApply returns via smokeExitCode", /return\s+smokeExitCode\(/.test(src));
    const exitWrites = (src.match(/process\.exitCode\s*=/g) || []).length;
    check("process.exitCode written only at main boundary (then+catch)", exitWrites === 2, `count=${exitWrites}`);
    const runApplyBody = src.slice(src.indexOf("async function runApply"), src.indexOf("async function main"));
    check("runApply never writes process.exitCode / process.exit",
      !/process\.exit(Code)?\b/.test(runApplyBody));
    check("cleanup failure logged but temp DB kept for inspection",
      /cleanup refused\/failed/.test(src) || /cleanup/.test(runApplyBody));

    // ── MongoClient lifecycle — singleton client ต้องปิดใน nested finally ──
    check("db.client.close() attempted in cleanup", /await\s+db\.client\.close\(\)/.test(runApplyBody));
    const closeIdx = runApplyBody.indexOf("db.client.close()");
    const dropIdx = runApplyBody.indexOf("dropDatabase()");
    const between = closeIdx > dropIdx ? runApplyBody.slice(dropIdx, closeIdx) : "";
    check("client.close lives inside a finally after dropDatabase", /finally/.test(between), `dropIdx=${dropIdx} closeIdx=${closeIdx}`);
    check("dropDatabase() return value checked", /const\s+\w+\s*=\s*await\s+db\.dropDatabase\(\)/.test(runApplyBody));
    check("dropDatabase !== true → cleanup error", /!==\s*true/.test(runApplyBody.slice(dropIdx, closeIdx > 0 ? closeIdx : undefined)) || /!==\s*true/.test(runApplyBody));
    check("cleanupFailed=true on both drop-fail and close-fail", (runApplyBody.match(/cleanupFailed\s*=\s*true/g) || []).length >= 3,
      `count=${(runApplyBody.match(/cleanupFailed\s*=\s*true/g) || []).length}`);

    // ── Part 3 source pins: loopback env, no prod-derive, sanitized errors ──
    check("reads BOTWORKER_VERIFY_MONGO_URI from env", /process\.env\.BOTWORKER_VERIFY_MONGO_URI|process\.env\[VERIFY_URI_ENV\]/.test(runApplyBody));
    check("sets ADMIN_MONGO_URI to validated loopback before imports", /process\.env\.ADMIN_MONGO_URI\s*=/.test(runApplyBody));
    check("sets ADMIN_MONGO_DB to harness-constant verify name", /process\.env\.ADMIN_MONGO_DB\s*=/.test(runApplyBody));
    check("never derives verify DB from configured/prod name", !/deriveIsolatedDbName\(prodDb|prodDbName/.test(runApplyBody));
    check("raw e.message never logged in runApply (sanitizeError only)", !/console\.error\([^)]*e\.message/.test(runApplyBody));
    check("sanitizeError used for error paths", (runApplyBody.match(/sanitizeError\(/g) || []).length >= 3,
      `count=${(runApplyBody.match(/sanitizeError\(/g) || []).length}`);
    check("sanitizeError stage args are callsite constants", !/sanitizeError\([^,]+,(?!\s*[`'"])/.test(runApplyBody));

    // ── env isolation: apply path must never touch dotfiles/env loaders ──
    check("no dotenv anywhere in harness source", !/dotenv/i.test(src));
    check("runApply never imports dotenv", !/import\(["']dotenv/.test(runApplyBody));
    check("no env-file reads (readFile/readFileSync on dotfiles)", !/readFile(Sync)?\([^)]*\.\s*env/.test(src));
    check("no config/env-file path resolution (resolvePath on dotfiles)", !/resolvePath\([^)]*\.\s*env/.test(src));

    // ── strict runtime vars must be test-local constants, set BEFORE imports ──
    check("ADMIN_JWT_SECRET assigned fixed verify value", /process\.env\.ADMIN_JWT_SECRET\s*=\s*(["'`][^"'`]+["'`]|VERIFY_ONLY_\w+)/.test(runApplyBody));
    check("CHATBOT_INTERNAL_SECRET assigned fixed verify value", /process\.env\.CHATBOT_INTERNAL_SECRET\s*=\s*(["'`][^"'`]+["'`]|VERIFY_ONLY_\w+)/.test(runApplyBody));
    check("VERIFY_ONLY_* consts are fixed non-secret literals", (src.match(/const VERIFY_ONLY_\w+\s*=\s*"verify-only[^"]*"/g) || []).length >= 2);
    check("CHATBOT_BASE_URL_SHOPEE assigned from fake server", /process\.env\.CHATBOT_BASE_URL_SHOPEE\s*=\s*fake\.url/.test(runApplyBody));
    const iImport = runApplyBody.indexOf('import("../src/backend/');
    for (const v of ["ADMIN_MONGO_URI", "ADMIN_MONGO_DB", "ADMIN_JWT_SECRET", "CHATBOT_INTERNAL_SECRET", "CHATBOT_BASE_URL_SHOPEE"]) {
      const i = runApplyBody.indexOf(`process.env.${v} =`);
      check(`env ${v} set before any production import`, i !== -1 && iImport !== -1 && i < iImport, `set=${i} import=${iImport}`);
    }
    check("no env-var passthrough for strict secrets", !/process\.env\.(ADMIN_JWT_SECRET|CHATBOT_INTERNAL_SECRET)\s*=\s*process\.env/.test(runApplyBody));

    // ── ordering: explicit URI read → validate → rebind → fake → import ──
    const iEnvRead = runApplyBody.search(/process\.env(\[VERIFY_URI_ENV\]|\.BOTWORKER_VERIFY_MONGO_URI)/);
    const iValidate = runApplyBody.indexOf("validateLoopbackMongoUri(");
    const iRebind = runApplyBody.indexOf("process.env.ADMIN_MONGO_URI");
    // env read may sit inside the validate() call args — contract = both precede any rebind
    check("explicit env read before any rebind", iEnvRead !== -1 && iRebind !== -1 && iEnvRead < iRebind,
      `env=${iEnvRead} rebind=${iRebind}`);
    check("URI validated before ADMIN_MONGO_URI rebind", iValidate !== -1 && iRebind !== -1 && iValidate < iRebind,
      `validate=${iValidate} rebind=${iRebind}`);
    check("rebind before fake server / runtime imports", iRebind !== -1 && iRebind < runApplyBody.indexOf("startFakeChatbot("));
  }

  // ── scenario matrix ──
  if (H) {
    const ids = H.SCENARIOS.map((s: { id: string }) => s.id);
    check("scenario plan covers S1–S10", JSON.stringify(ids) === JSON.stringify(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]), `got=${JSON.stringify(ids)}`);
    for (const s of H.SCENARIOS) {
      check(`scenario ${s.id} has expects`, Array.isArray(s.expects) && s.expects.length > 0);
    }
  }

  // ── S8–S10 real-Mongo leadership race contract ──
  if (src) {
    check("harness calls svc.ensureLeadership (DB-level CAS verb)", /svc\.ensureLeadership\(/.test(src));
    check("leadership scenarios use COLLECTIONS.botworkerState", /COLLECTIONS\.botworkerState/.test(src));
    const iS8 = src.indexOf("async function s8");
    const iRun = src.indexOf("async function runApply");
    check("s8/s9/s10 functions exist between s7 and runApply", iS8 !== -1 && iRun !== -1 && iS8 < iRun
      && src.indexOf("async function s9", iS8) !== -1 && src.indexOf("async function s10", iS8) !== -1);
    const leadBodies = iS8 !== -1 && iRun !== -1 ? src.slice(iS8, iRun) : "";
    check("S8–S10 concurrency via Promise.all (no sleep picks winner)",
      (leadBodies.match(/Promise\.all\(/g) || []).length >= 2
      && !/await\s+sleep\(/.test(leadBodies));
    check("S8–S10 never invoke message-work paths (no fake /chat reachability)",
      !/svc\.(processMessage|pollNewMessages|recoverStale|checkWaitTimeouts)/.test(leadBodies));
    check("S8–S10 owner IDs carry harness verify prefix", /ID_PREFIX`?\}?\s*worker_|`\$\{ID_PREFIX\}worker/.test(leadBodies));
    check("S8–S10 assert zero fake-call delta", (leadBodies.match(/fake\.calls\.length\s*-\s*n0\s*={2,3}\s*0/g) || []).length >= 3);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
