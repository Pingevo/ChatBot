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
const BATCH_LIMIT = 20;

let running = true;
let shuttingDown = false;

// Graceful shutdown — หยุด poll ใหม่ แต่รอที่กำลังทำอยู่เสร็จ
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[bot-worker] shutting down... waiting for in-flight messages");
  running = false;
  await botWorkerService.waitForInFlight(10000);
  console.log("[bot-worker] stopped.");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  console.log("[bot-worker] starting...");
  console.log("[bot-worker] ⚡ FIRE-AND-FORGET: แต่ละข้อความยิงไปบอทแยกอิสระ ไม่รอคิว ไม่รอ batch");
  console.log("[bot-worker] ⚠️ READ-ONLY messages_shp → writes to shadow_replies + chat_processing");
  console.log("[bot-worker] ⚠️ No Shopee API calls. No real message delivery.");

  let cycle = 0;
  while (running) {
    try {
      cycle++;

      // อ่าน config ทุกรอบ — ถ้าปิด ก็ข้าม
      const config = await getSystemConfig();
      if (!config.bot_worker_enabled) {
        if (cycle === 1 || cycle % 30 === 0) {
          console.log(`[bot-worker] cycle ${cycle}: bot_worker_enabled=false → paused`);
        }
      } else {
        const interval = config.bot_worker_interval_ms || DEFAULT_INTERVAL_MS;
        const result = await botWorkerService.pollNewMessages(BATCH_LIMIT);

        if (result.processed > 0) {
          console.log(`[bot-worker] cycle ${cycle}: found=${result.found} fired=${result.processed} (fire-and-forget)`);
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
