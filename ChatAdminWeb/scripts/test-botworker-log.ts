// test-botworker-log.ts — Thai worker log text + repeat suppression
// รัน: npx tsx scripts/test-botworker-log.ts
import { workerResultText, createWorkerLogger } from "../src/backend/service/botworkerLog";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}\n     got: ${JSON.stringify(got)}`); }
}

const t = workerResultText;
check("buffered new", t("buffered", "buffered (1 msgs, text window 7000ms)") === "รับข้อความแล้ว (รวม 1 ข้อความ) — รออีก 7 วินาทีเผื่อลูกค้าพิมพ์ต่อ", t("buffered", "buffered (1 msgs, text window 7000ms)"));
check("buffered media", t("buffered", "buffered (3 msgs, media window 14000ms)").includes("รูป/วิดีโอ"), t("buffered", "buffered (3 msgs, media window 14000ms)"));
check("duplicate waiting", t("buffered", "duplicate — not admitted, debounce unchanged") === "รับไว้แล้ว — กำลังรอครบเวลาเพื่อรวมข้อความ");
check("restored debounce", t("buffered", "duplicate — restored missing debounce (1500ms remaining)") === "รับไว้แล้ว — ตั้งเวลารอใหม่ เหลือ 2 วินาที", t("buffered", "duplicate — restored missing debounce (1500ms remaining)"));
check("claim self", t("skip", "claim in-flight (self)") === "กำลังส่งเข้าบอทอยู่ (รอผล)");
check("skip assigned explains admin", (() => {
  const s = t("buffer_flushed", "flushed 1 msgs → skip_assigned: test store: status=open assigned_to=adm_x — skip");
  return s.includes("ส่งรวม 1 ข้อความ") && s.includes("แอดมินรับแชทนี้อยู่") && s.includes("adm_x") && s.includes("ปิดแชท");
})(), t("buffer_flushed", "flushed 1 msgs → skip_assigned: test store: status=open assigned_to=adm_x — skip"));
check("bot answered", t("buffer_flushed", "flushed 2 msgs → bot_answered: ok").includes("บอทร่างคำตอบแล้ว"), t("buffer_flushed", "flushed 2 msgs → bot_answered: ok"));
check("unknown keeps raw detail", t("weird_status", "some detail") === "weird_status — some detail", t("weird_status", "some detail"));
check("known status unknown detail keeps raw", t("bot_failed", "timeout 30s") === "บอทตอบไม่สำเร็จ — timeout 30s", t("bot_failed", "timeout 30s"));

const lines: string[] = [];
const log = createWorkerLogger((line) => lines.push(line), 3);
log("shp_msg_1", "buffered", "duplicate — not admitted, debounce unchanged");
log("shp_msg_1", "buffered", "duplicate — not admitted, debounce unchanged");
log("shp_msg_1", "skip", "claim in-flight (self)");
log("shp_msg_1", "skip", "claim in-flight (self)");
log("shp_msg_2", "skip", "claim in-flight (self)");
check("repeat suppressed per message", lines.length === 3, lines);
check("line shape", lines[0].startsWith("  [worker] shp_msg_1 → "), lines[0]);
log("shp_msg_3", "skip", "x"); log("shp_msg_4", "skip", "x"); log("shp_msg_1", "skip", "claim in-flight (self)");
check("memory bounded (oldest evicted → may reprint)", lines.length === 6, lines.length);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
