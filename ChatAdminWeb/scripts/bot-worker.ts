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
import { workflowEngine } from "../src/backend/service/workflowEngine";

const DEFAULT_INTERVAL_MS = 1000;
// ⚡ Phase 2Q — ไม่ limit แล้ว — ดึงทั้งหมดที่เข้ามาใหม่ (buffer + concurrency limiter เป็นตัวคุม)

let running = true;
let shuttingDown = false;

// Graceful shutdown — หยุด poll ใหม่ แต่รอที่กำลังทำอยู่เสร็จ
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[bot-worker] shutting down... waiting for in-flight messages");
  running = false;
  // เคลียร์ pending work ทั้งหมด (buffer/retry/deferred-recovery timers)
  //   — ข้อความใน buffer_messages ยังอยู่ → recover ตอน enable edge ถัดไป
  botWorkerService.clearPendingWork();
  await botWorkerService.waitForInFlight(10000);
  console.log("[bot-worker] stopped.");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  // ⚡ enable-transition checkpoint — poll boundary = เวลาที่เห็น worker เปิด (rising edge)
  //   ปิด→เปิด = boundary ใหม่; backlog ช่วงปิดไม่ถูก admit เข้า poll
  let enabledSince: Date | null = null;
  console.log("[bot-worker] starting...");
  console.log("[bot-worker] ⚡ FIRE-AND-FORGET: แต่ละข้อความยิงไปบอทแยกอิสระ ไม่รอคิว ไม่รอ batch");
  console.log("[bot-worker] ⚠️ READ-ONLY messages_shp → writes to shadow_replies + chat_processing");
  console.log("[bot-worker] ⚠️ No Shopee API calls. No real message delivery.");

  // ⚡ enabled gate ก่อน recovery — worker ปิดต้องไม่ flush/recover อะไรเลย
  const bootConfig = await getSystemConfig();
  if (bootConfig.bot_worker_enabled) {
    // ⚡ capture enable edge ก่อน recovery — inbound ที่เข้าระหว่าง recovery ต้องถูก poll
    //   (ถ้าตั้งใน loop หลัง recovery → created_timestamp < boundary → หลุดทั้ง era)
    enabledSince = new Date();
    console.log(`[bot-worker] ⚡ enable edge — processing only messages after ${enabledSince.toISOString()}`);
    // Recover stale buffers จาก buffer_messages collection (ถ้ามี)
    // กรณี bot-worker restart ขณะมีข้อความค้างใน buffer
    try {
      const recovered = await botWorkerService.recoverStaleBuffers();
      if (recovered.recovered > 0) {
        console.log(`[bot-worker] recovered ${recovered.recovered} stale buffer conversations`);
      }
    } catch (err) {
      console.error("[bot-worker] buffer recovery error:", err instanceof Error ? err.message : err);
    }
  } else {
    console.log("[bot-worker] bot_worker_enabled=false → skip startup recovery");
  }

  let cycle = 0;
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
          console.log(`[bot-worker] cycle ${cycle}: bot_worker_enabled=false → paused`);
        }
      } else {
        if (!enabledSince) {
          // ⚡ rising edge — capture boundary ก่อน recovery เสมอ
          //   (inbound ที่เข้าระหว่าง recovery ต้องอยู่หลัง boundary ของ era นี้)
          enabledSince = new Date();
          console.log(`[bot-worker] ⚡ enable edge — processing only messages after ${enabledSince.toISOString()}`);
          try {
            const recovered = await botWorkerService.recoverStaleBuffers();
            if (recovered.recovered > 0) {
              console.log(`[bot-worker] recovered ${recovered.recovered} stale buffer conversations`);
            }
          } catch (err) {
            console.error("[bot-worker] enable-edge recovery error:", err instanceof Error ? err.message : err);
          }
        }
        const interval = config.bot_worker_interval_ms || DEFAULT_INTERVAL_MS;
        const result = await botWorkerService.pollNewMessages(enabledSince);

        if (result.processed > 0) {
          console.log(`[bot-worker] cycle ${cycle}: found=${result.found} fired=${result.processed} (fire-and-forget)`);
        }

        // ⚡ Phase 2 — เช็ค wait_for_reply timeout (ทุก cycle ถ้า workflow เปิด)
        if (config.workflow_enabled) {
          try {
            const timedOut = await workflowEngine.checkWaitTimeouts();
            if (timedOut > 0) {
              console.log(`[bot-worker] cycle ${cycle}: wait_timeout processed=${timedOut}`);
            }
          } catch (err) {
            console.error(`[bot-worker] cycle ${cycle}: wait_timeout error:`, err instanceof Error ? err.message : err);
          }
        }

        // รอตาม interval ที่ตั้งใน config — ไม่รอให้ batch เสร็จ แต่ละข้อความทำงานของมันอยู่แล้ว
        if (running) {
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
        continue;
      }
    } catch (err) {
      console.error(`[bot-worker] cycle ${cycle} error:`, err instanceof Error ? err.message : err);
    }

    // รอ default interval กรณีปิด worker หรือ error
    if (running) {
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_INTERVAL_MS));
    }
  }

  // ถ้าออกจากลูปเพราะ running=false แต่ไม่ใช่ signal → รอ in-flight ด้วย
  if (!shuttingDown) {
    await botWorkerService.waitForInFlight(10000);
    console.log("[bot-worker] stopped.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[bot-worker] fatal:", err);
  process.exit(1);
});
