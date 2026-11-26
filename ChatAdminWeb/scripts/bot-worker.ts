// Bot Worker — Polling pipeline ประมวลผลข้อความใหม่
//
// รัน: npx tsx scripts/bot-worker.ts
//
// Flow:
//   ทุก N วินาที (อ่านจาก config) → poll messages_shp หาข้อความใหม่
//   → check config.bot_worker_enabled ถ้าปิด → ข้าม
//   → check trigger → bot answer หรือ handoff to admin (round-robin)
//   → เก็บผลลัพธ์ใน shadow_replies + chat_processing
//
// ⚠️ SAFETY:
//   - อ่าน messages_shp อย่างเดียว (READ-ONLY)
//   - เขียน assigned_to ลง conversations_shp (พี่เขาให้ test)
//   - คำตอบบอทเก็บใน shadow_replies (ไม่เขียน messages_shp)
//   - ไม่ call Shopee API
//   - ไม่ส่งข้อความจริง
//   - ไม่ยุ่งกับ sellcenter
import "dotenv/config";
import { botWorkerService } from "../src/backend/service/botWorkerService";
import { getSystemConfig } from "../src/backend/service/systemConfigService";

const DEFAULT_INTERVAL_MS = 1000;
// ⚡ Phase 2Q — ไม่ limit แล้ว — ดึงทั้งหมดที่เข้ามาใหม่ (buffer + concurrency limiter เป็นตัวคุม)

let running = true;
let shuttingDown = false;

// Graceful shutdown — หยุด poll ใหม่ แต่รอที่กำลังทำอยู่เสร็จ
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[bot-worker] กำลังปิด... รอข้อความที่ส่งเข้าบอทอยู่ให้เสร็จก่อน");
  running = false;
  // เคลียร์ pending work ทั้งหมด (buffer/retry/deferred-recovery timers)
  //   — ข้อความใน buffer_messages ยังอยู่ → recover ตอน enable edge ถัดไป
  botWorkerService.clearPendingWork();
  await botWorkerService.waitForInFlight(10000);
  console.log("[bot-worker] ปิดแล้ว");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  // ⚡ enable-transition checkpoint — poll boundary = เวลาที่เห็น worker เปิด (rising edge)
  //   ปิด→เปิด = boundary ใหม่; backlog ช่วงปิดไม่ถูก admit เข้า poll
  let enabledSince: Date | null = null;
  console.log("[bot-worker] กำลังเริ่ม...");
  // ⚡ S4 — ensure indexes ก่อน Mongo-dependent work เสมอ (worker อาจขึ้นก่อน
  //   Next instrumentation → unique index buffer_messages ยังไม่มี → re-poll insert ซ้ำ)
  try {
    const { ensureIndexes } = await import("../src/backend/db/mongoClient");
    await ensureIndexes();
  } catch (e) {
    console.warn("[bot-worker] สร้าง index ใน DB ไม่สำเร็จ (ทำงานต่อได้ ไม่กระทบการตอบ):", (e as Error).message);
  }
  console.log("[bot-worker] แต่ละข้อความลูกค้าถูกส่งเข้าบอทแยกกัน ไม่ต้องรอคิว");
  console.log("[bot-worker] อ่านแชทจาก messages_shp อย่างเดียว — คำตอบบอทเป็นร่างใน shadow_replies รอแอดมินตรวจ");
  console.log("[bot-worker] worker ไม่ส่งข้อความถึงลูกค้าเอง — ส่งจริงเฉพาะตอนแอดมินอนุมัติในหน้า Bot Worker และเปิดสวิตช์ส่งจริง");

  // ⚡ enabled gate ก่อน recovery — worker ปิดต้องไม่ flush/recover อะไรเลย
  const bootConfig = await getSystemConfig();
  if (bootConfig.bot_worker_enabled) {
    // ⚡ capture enable edge ก่อน resolve/recovery — inbound ที่เข้าระหว่าง recovery
    //   ต้องถูก poll; edge = global cutoff ที่ scope resolver ใช้สร้าง pair cutoff
    enabledSince = new Date();
    console.log(`[bot-worker] สวิตช์ Bot Worker เปิดแล้ว — ทำเฉพาะข้อความลูกค้าหลัง ${enabledSince.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} (${enabledSince.toISOString()})`);
    // Recover stale buffers จาก buffer_messages collection (ถ้ามี)
    // กรณี bot-worker restart ขณะมีข้อความค้างใน buffer
    // ⚡ reconcile-only — finalize durable evidence / settle dormant; provider=0
    try {
      const recovered = await botWorkerService.recoverStaleBuffers(
        await botWorkerService.resolveBotworkerScope(bootConfig, enabledSince)
      );
      if (recovered.recovered > 0) {
        console.log(`[bot-worker] เคลียร์ข้อความค้างจากรอบก่อน ${recovered.recovered} รายการ`);
      }
    } catch (err) {
      console.error("[bot-worker] เคลียร์ข้อความค้างไม่สำเร็จ:", err instanceof Error ? err.message : err);
    }
  } else {
    console.log("[bot-worker] สวิตช์ Bot Worker ปิดอยู่ — ยังไม่ทำงาน (เปิดได้ที่หน้าตั้งค่า)");
  }

  let cycle = 0;
  let lastPollLine = "";
  while (running) {
    try {
      cycle++;

      // อ่าน config ทุกรอบ — ถ้าปิด ก็ข้าม
      const config = await getSystemConfig();
      if (!config.bot_worker_enabled) {
        // ⚡ falling edge — ยกเลิก pending timers (buffer/retry/deferred) ครั้งเดียว
        //   งานค้างใน DB ไม่หาย — rising edge ถัดไป recovery เอาต่อ
        if (enabledSince) botWorkerService.clearPendingWork();
        enabledSince = null;
        if (cycle === 1 || cycle % 30 === 0) {
          console.log(`[bot-worker] รอบ ${cycle}: สวิตช์ Bot Worker ปิดอยู่ — หยุดรอ`);
        }
      } else {
        // ⚡ rising edge — capture boundary ก่อน scope resolve เสมอ:
        //   edge คือ global cutoff — resolver ต้องเห็นค่านี้ก่อนสร้าง pair cutoff
        const justRose = !enabledSince;
        if (justRose) {
          enabledSince = new Date();
          console.log(`[bot-worker] สวิตช์ Bot Worker เปิดแล้ว — ทำเฉพาะข้อความลูกค้าหลัง ${enabledSince.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} (${enabledSince.toISOString()})`);
        }
        // ⚡ Phase 2D — resolve admission scope ครั้งเดียวต่อ cycle จาก config
        //   snapshot เดียวกัน → poll/recovery/timeout-resume กิน scope เดียวกันเสมอ
        const scope = await botWorkerService.resolveBotworkerScope(config, enabledSince);
        if (justRose) {
          // ⚡ reconcile-only — settle evidence/dormant; provider=0
          try {
            const recovered = await botWorkerService.recoverStaleBuffers(scope);
            if (recovered.recovered > 0) {
              console.log(`[bot-worker] เคลียร์ข้อความค้างจากรอบก่อน ${recovered.recovered} รายการ`);
            }
          } catch (err) {
            console.error("[bot-worker] เคลียร์ข้อความค้างตอนเปิดสวิตช์ไม่สำเร็จ:", err instanceof Error ? err.message : err);
          }
        }
        const interval = config.bot_worker_interval_ms || DEFAULT_INTERVAL_MS;
        const result = await botWorkerService.pollNewMessages(scope);

        const pollLine = `เจอข้อความลูกค้าที่ยังไม่จบ ${result.found} ข้อความ · ส่งไปทำต่อ ${result.processed}`;
        if (result.processed > 0 && pollLine !== lastPollLine) console.log(`[bot-worker] รอบ ${cycle}: ${pollLine}`);
        lastPollLine = result.processed > 0 ? pollLine : "";

        // ⚡ Phase 2 — เช็ค wait_for_reply timeout (ทุก cycle ถ้า workflow เปิด)
        if (config.workflow_enabled) {
          try {
            const timedOut = await botWorkerService.checkWaitTimeouts(scope);
            if (timedOut > 0) {
              console.log(`[bot-worker] รอบ ${cycle}: workflow ที่รอลูกค้าตอบหมดเวลา ${timedOut} รายการ`);
            }
          } catch (err) {
            console.error(`[bot-worker] รอบ ${cycle}: เช็ค workflow หมดเวลาไม่สำเร็จ:`, err instanceof Error ? err.message : err);
          }
          // ⚡ Zaapi delay timers — ปลุก run ที่ resume_at ถึงแล้ว (ทุก cycle)
          try {
            const timers = await botWorkerService.sweepDueTimerRuns(scope);
            if (timers.resumed > 0 || timers.errors.length > 0) {
              console.log(`[bot-worker] รอบ ${cycle}: workflow ที่ตั้งเวลาไว้ถึงเวลา ${timers.due} · ทำต่อแล้ว ${timers.resumed} · ผิดพลาด ${timers.errors.length}`);
            }
          } catch (err) {
            console.error(`[bot-worker] รอบ ${cycle}: ปลุก workflow ที่ตั้งเวลาไว้ไม่สำเร็จ:`, err instanceof Error ? err.message : err);
          }
        }

        // รอตาม interval ที่ตั้งใน config — ไม่รอให้ batch เสร็จ แต่ละข้อความทำงานของมันอยู่แล้ว
        if (running) {
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
        continue;
      }
    } catch (err) {
      console.error(`[bot-worker] รอบ ${cycle} ผิดพลาด:`, err instanceof Error ? err.message : err);
    }

    // รอ default interval กรณีปิด worker หรือ error
    if (running) {
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_INTERVAL_MS));
    }
  }

  // ถ้าออกจากลูปเพราะ running=false แต่ไม่ใช่ signal → รอ in-flight ด้วย
  if (!shuttingDown) {
    await botWorkerService.waitForInFlight(10000);
    console.log("[bot-worker] ปิดแล้ว");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[bot-worker] หยุดทำงานเพราะผิดพลาดร้ายแรง:", err);
  process.exit(1);
});
