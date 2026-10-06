// RED/PIN tests — bot-worker.ts enable-transition checkpoint (Part D design)
//
// ทดสอบ boundary ของ poll `since` ผ่าน child process จริงของ bot-worker.ts
// (modules leaf ถูก mock: config scripted, pollNewMessages = spy ที่ print since/found)
//
// คาดหวังหลัง fix (design — ห้าม implement จน review ผ่าน):
//   let enabledSince: Date | null = null;
//   disabled → enabledSince = null (reset)
//   rising edge → enabledSince = new Date() ครั้งเดียว
//   enabled ต่อเนื่อง → boundary เดิม
//   startup enabled → boundary ≈ boot (behavior เดิม)
//
// รัน: npx tsx --import ./test-botworker-enable-checkpoint-hooks.mjs scripts/test-botworker-enable-checkpoint.ts

import { spawn } from "node:child_process";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const CHILD = path.join(DIR, "test-botworker-enable-checkpoint-child.ts");

interface Ev { kind: string; [k: string]: string }

function runWorker(seq: number[], grace = 2, extra: Record<string, unknown> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", CHILD], {
      env: {
        ...process.env,
        BOTWORKER_TEST_SEQ: JSON.stringify({ seq, grace, interval_ms: 5, ...extra }),
      },
      cwd: DIR,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child timeout"));
    }, 20000);
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(out);
      else reject(new Error(`child exited ${code}\n${out.slice(-2000)}`));
    });
  });
}

function parse(out: string) {
  const polls: { since: Date; found: string[] }[] = [];
  const enables: Date[] = [];
  const cfgs: { enabled: boolean; at: Date }[] = [];
  let recovery = 0, waits = 0, cancels = 0;
  let startedAt: Date | null = null;
  for (const line of out.split("\n")) {
    const m = line.match(/EV POLL since=(\S+) found=\[([^\]]*)\]/);
    if (m) { polls.push({ since: new Date(m[1]), found: m[2] ? m[2].split(",") : [] }); continue; }
    const e = line.match(/EV ENABLE_AT (\S+) edge=(\d+)/);
    if (e) { enables.push(new Date(e[1])); continue; }
    const c = line.match(/EV CFG enabled=(\d) at=(\S+)/);
    if (c) { cfgs.push({ enabled: c[1] === "1", at: new Date(c[2]) }); continue; }
    if (line.includes("EV RECOVERY")) recovery++;
    if (line.includes("EV CANCEL_PENDING")) cancels++;
    if (line.includes("EV WAIT_TIMEOUT")) waits++;
    const s = line.match(/processing only messages after (\S+)/);
    if (s) startedAt = new Date(s[1]);
  }
  return { polls, enables, cfgs, recovery, waits, cancels, startedAt };
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

async function main() {
  console.log("=== bot-worker enable-checkpoint tests ===\n");

  // ── S1: boot disabled → ไม่ poll / ไม่ recovery / ไม่ workflow ──
  {
    const out = await runWorker([0, 0, 0], 2);
    const r = parse(out);
    check("S1 boot-disabled: no polls", r.polls.length === 0, `polls=${r.polls.length}`);
    check("S1 boot-disabled: no recovery", r.recovery === 0, `recovery=${r.recovery}`);
    check("S1 boot-disabled: no wait_timeout", r.waits === 0, `waits=${r.waits}`);
  }

  // ── S2: boot enabled → recovery once + boundary ≈ boot ──
  {
    const out = await runWorker([1, 1], 2);
    const r = parse(out);
    check("S2 boot-enabled: recovery ran once", r.recovery === 1, `recovery=${r.recovery}`);
    check("S2 boot-enabled: polls happened", r.polls.length >= 1, `polls=${r.polls.length}`);
    check(
      "S2 boot-enabled: boundary ≈ boot (within 3s)",
      !!r.startedAt && r.polls.length > 0 &&
        r.polls[0].since.getTime() - r.startedAt.getTime() < 3000,
      r.polls[0] ? `since=${r.polls[0].since.toISOString()} boot=${r.startedAt?.toISOString()}` : "no polls"
    );
  }

  // ── S3: off→on→off→on → rising edge checkpoint ──
  {
    // bootCfg off → 2 disabled cycles → 2 enabled → 1 disabled → enabled (grace)
    const out = await runWorker([0, 0, 0, 1, 1, 0, 1, 1], 3);
    const r = parse(out);
    const allFound = r.polls.flatMap((p) => p.found);

    check("S3 two enable edges seen", r.enables.length === 2, `edges=${r.enables.length}`);
    // ⚡ rising edge ทุกครั้งต้องเรียก recovery (ไม่ใช่เฉพาะ boot) — boot disabled → recovery = edges
    check(
      "S3 [RED] every rising edge invokes recovery (2 edges → 2 recoveries)",
      r.recovery === 2,
      `recovery=${r.recovery}`
    );
    // ⚡ falling edge ต้องยกเลิก pending timers — marker จาก clearPendingWork (mock)
    //   (shutdown path เรียกเดียวกัน → count = falling edges + shutdown)
    check(
      "S3 [RED] falling edge cancels pending work",
      r.cancels >= 1,
      `cancels=${r.cancels}`
    );
    check(
      "S3 [RED] messages during disabled window never polled (m_gap)",
      allFound.every((id) => !id.startsWith("m_gap")),
      `found=${allFound.join(",")}`
    );
    check(
      "S3 [RED] re-enable produces NEW boundary (since_era2 > since_era1)",
      r.enables.length === 2 &&
        r.polls.some((p) => p.since > r.enables[0]) &&
        r.polls.filter((p) => p.since > r.enables[0]).every((p) => r.polls.indexOf(p) >= 0) &&
        new Set(r.polls.map((p) => p.since.getTime())).size >= 2 &&
        [...r.polls].sort((a, b) => a.since.getTime() - b.since.getTime()).at(-1)!.since > r.enables[0],
      `sinces=${r.polls.map((p) => p.since.toISOString()).join(" | ")}`
    );
    check(
      "S3 post-enable message polled in each era (m_post found)",
      allFound.includes("m_post_1") && allFound.includes("m_post_2"),
      `found=${allFound.join(",")}`
    );
    // enabled ต่อเนื่องต้องไม่เลื่อน boundary — group polls by stream order:
    //   polls ก่อน ENABLE_AT#2 = era1, หลัง = era2 (boundary อาจเท่ากับ enable ts ใน ms เดียวกัน)
    const evStream = out.split("\n").filter((l) => l.startsWith("EV POLL") || l.startsWith("EV ENABLE_AT"));
    let seenEdges = 0;
    const eraPolls: Date[][] = [[], []];
    for (const l of evStream) {
      if (l.startsWith("EV ENABLE_AT")) seenEdges++;
      else {
        const m = l.match(/since=(\S+)/);
        if (m && seenEdges >= 1) eraPolls[Math.min(seenEdges - 1, 1)].push(new Date(m[1]));
      }
    }
    const sameWithin = (arr: Date[]) => new Set(arr.map((d) => d.getTime())).size <= 1;
    check(
      "S3 continuous-enabled does not move boundary (per era)",
      eraPolls.every((arr) => arr.length === 0 || sameWithin(arr)),
      `era sizes=${eraPolls.map((a) => a.length).join("/")} sinces=${[...new Set(r.polls.map((p) => p.since.toISOString()))].join("|")}`
    );
    // boundary ต่อ era ต้อง ≥ edge ของ era นั้น (enabledSince ตั้งหลัง CFG enable)
    check(
      "S3 era boundary ≥ its enable edge",
      eraPolls.every((arr, i) => arr.every((s) => s.getTime() >= r.enables[i].getTime() - 5)),
      `enables=${r.enables.map((e) => e.toISOString()).join("|")}`
    );
    // polls only happen while enabled: every POLL must follow a CFG enabled=1
    // with no CFG enabled=0 in between (stream order check)
    const stream = out.split("\n").filter((l) => l.startsWith("EV CFG") || l.startsWith("EV POLL"));
    let enabledNow = false, pollWhileDisabled = 0;
    for (const l of stream) {
      if (l.startsWith("EV CFG")) enabledNow = l.includes("enabled=1");
      else if (!enabledNow) pollWhileDisabled++;
    }
    check("S3 no poll while disabled", pollWhileDisabled === 0, `count=${pollWhileDisabled}`);
  }

  // ── S4: boot-enabled — inbound ที่เข้าระหว่าง startup recovery ต้องถูก poll ──
  //   boundary ต้องถูก capture ทันทีที่ boot config enabled ก่อน recovery (Finding 1)
  {
    const out = await runWorker([1, 1], 2, { recovery_delay_ms: 25 });
    const r = parse(out);
    const allFound = r.polls.flatMap((p) => p.found);
    check("S4 boot-enabled: recovery ran once", r.recovery === 1, `recovery=${r.recovery}`);
    check("S4 mid-recovery inbound injected", out.includes("EV REC_INJECTED"), "no inject marker");
    check(
      "S4 [RED] mid-recovery inbound is polled (boundary captured BEFORE recovery)",
      allFound.includes("m_rec_1"),
      `found=${allFound.join(",")} since=${r.polls[0]?.since.toISOString()}`
    );
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
