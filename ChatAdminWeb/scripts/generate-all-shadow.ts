// scripts/generate-all-shadow.ts
//
// ลูป generate shadow replies สำหรับทุก conversation ที่มี user inbound messages
// ใช้ฟังก์ชันเดิม (generateConversationShadowReplies) — safety guards ทำงานเหมือนกัน
//
// ⛔ ห้ามส่งข้อความจริง — เก็บใน shadow_replies เท่านั้น
// ⛔ ห้ามเรียก Shopee/TikTok/Lazada API
// ⛔ ไม่แก้ original data (messages_shp, conversations_shp)
//
// วิธีรัน:
//   npx tsx scripts/generate-all-shadow.ts
//
// หยุดกลางทาง: Ctrl+C — รันใหม่ได้ จะข้าม conversation ที่ทำแล้วอัตโนมัติ
//
// ตัวเลือก:
//   --limit=N       จำกัดจำนวน conversation (เช่น --limit=100)
//   --platform=X    เฉพาะ platform (shopee, tiktok, lazada)
//   --dry-run       ดูจำนวนที่จะทำโดยไม่เรียก bot
//   --skip-done     ข้าม conversation ที่มี shadow_replies แล้ว (default: true)

import "dotenv/config";
import { MongoClient } from "mongodb";
import { shadowReplyService } from "../src/backend/service/shadowReplyService";
import { listConversations } from "../src/backend/service/conversationService";
import { listMessages } from "../src/backend/service/messageService";
import { serverConfig } from "../src/backend/lib/config";
import { assertPlatformApiDisabled } from "../src/backend/lib/safety";
import type { Platform } from "../src/backend/lib/safety";

// ── parse args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : undefined;
};
const dryRun = args.includes("--dry-run");
const limitArg = getArg("limit");
const platformArg = getArg("platform") as Platform | undefined;
const maxConversations = limitArg ? parseInt(limitArg, 10) : undefined;

// ── callOurBot — เรียก Python bot ผ่าน HTTP (เหมือน generate-conversation route) ──
// ⚡ มี retry สำหรับ 429 (rate limit) — รอแล้วลองใหม่
async function callOurBot(params: {
  platform: Platform;
  message: string;
  history: { role: "user" | "model"; text: string }[];
  shopId: string;
  shopName?: string;
}): Promise<{
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
}> {
  const { platform, message, history, shopId, shopName } = params;
  const upstream = serverConfig.chatbotBaseUrls[platform].replace(/\/$/, "");
  const url = `${upstream}/chat`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Secret": serverConfig.chatbotInternalSecret,
  };

  const body: Record<string, unknown> = { message, history, limit: 5 };
  if (shopName) body.shop = shopName;
  else if (shopId) body.shop = shopId;

  // ⚡ retry สำหรับ 429 — รอ 5, 10, 20, 40 วินาที (รวม 4 ครั้ง)
  const retryDelays = [5_000, 10_000, 20_000, 40_000];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });

      if (resp.status === 429 && attempt < retryDelays.length) {
        // rate limit — รอแล้วลองใหม่ (key ถัดไปจะถูกหมุนโดย Python bot อัตโนมัติ)
        const wait = retryDelays[attempt] / 1000;
        console.log(`\n      ⏳ 429 rate limit — รอ ${wait}s แล้วลองใหม่ (attempt ${attempt + 1}/${retryDelays.length})`);
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        continue;
      }

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`bot call failed (${resp.status}): ${txt.slice(0, 200)}`);
      }

      const data = await resp.json();
      return {
        answer: data.answer || "(ไม่มีคำตอบ)",
        source: data.source,
        model: data.model,
        elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
        usage: data.usage,
        cost: typeof data.cost === "number" ? data.cost : undefined,
        products: data.products,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // ถ้าเป็น network error หรือ timeout — ลองใหม่ได้
      const isRetryable = lastError.message.includes("fetch failed")
        || lastError.message.includes("timeout")
        || lastError.message.includes("aborted");
      if (isRetryable && attempt < retryDelays.length) {
        const wait = retryDelays[attempt] / 1000;
        console.log(`\n      ⏳ ${lastError.message.slice(0, 60)} — รอ ${wait}s แล้วลองใหม่`);
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error("bot call failed after retries");
}

// ── helper: หา conversation ที่ยังไม่ได้ generate ──
async function getAlreadyGeneratedConvIds(): Promise<Set<string>> {
  const uri = process.env.ADMIN_MONGO_URI || "";
  if (!uri) throw new Error("ADMIN_MONGO_URI not set");
  const dbName = process.env.ADMIN_MONGO_DB || "chatbot";
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const collName = process.env.ADMIN_MONGO_COLLECTION_SHADOW_REPLIES || "shadow_replies";
    const distinct = await db.collection(collName).distinct("conversation_id", {});
    return new Set(distinct as string[]);
  } finally {
    await client.close();
  }
}

// ── helper: นับ user inbound messages ใน conversation ──
async function countUserInbound(conversationId: string, platform: Platform): Promise<number> {
  const msgs = await listMessages(conversationId, { platform, limit: 500 });
  return msgs.filter((m) => m.role === "user" && m.direction === "in").length;
}

// ── main ────────────────────────────────────────────────────
async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Shadow Bot — Generate All Conversations                 ║");
  console.log("║  ⛔ ไม่ส่งจริง · ไม่อ่านจริง · เก็บใน shadow_replies เท่านั้น  ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");

  // 1. โหลด conversations ทั้งหมด
  console.log("→ โหลด conversations ทั้งหมด...");
  const allConvs = await listConversations({
    platform: platformArg,
    limit: 100000,
  });
  console.log(`  พบ ${allConvs.length} conversations${platformArg ? ` (${platformArg})` : ""}`);

  // 2. หา conversations ที่ generate แล้ว
  console.log("→ เช็ค conversations ที่ generate แล้ว...");
  const doneIds = await getAlreadyGeneratedConvIds();
  console.log(`  ทำแล้ว: ${doneIds.size} conversations`);

  // 3. กรองเฉพาะที่ยังไม่ได้ทำ และมี user inbound
  const todo = allConvs.filter((c) => !doneIds.has(c.conversation_id));
  console.log(`  ยังไม่ได้ทำ: ${todo.length} conversations`);

  if (maxConversations && maxConversations > 0) {
    const sliced = todo.slice(0, maxConversations);
    console.log(`  จำกัด: ${sliced.length} conversations (--limit=${maxConversations})`);
    if (dryRun) {
      console.log("");
      console.log("→ Dry run — นับ user inbound messages แต่ละ conversation...");
      let totalQ = 0;
      for (let i = 0; i < sliced.length; i++) {
        const c = sliced[i];
        const qCount = await countUserInbound(c.conversation_id, c.platform);
        totalQ += qCount;
        if (i % 50 === 0 || i === sliced.length - 1) {
          console.log(`  [${i + 1}/${sliced.length}] ${c.conversation_id} — ${qCount} คำถาม | รวม: ${totalQ}`);
        }
      }
      console.log("");
      console.log("=== สรุป Dry Run ===");
      console.log(`Conversations ที่จะทำ: ${sliced.length}`);
      console.log(`คำถามทั้งหมด: ${totalQ}`);
      console.log(`ประเมินเวลา: ${(totalQ * 2.42 / 60).toFixed(0)} นาที (${(totalQ * 2.42 / 3600).toFixed(1)} ชม.)`);
      console.log(`ประเมิน cost: $${(totalQ * 0.00218).toFixed(2)} (฿${(totalQ * 0.00218 * 36).toFixed(0)})`);
      return;
    }
  }

  const finalTodo = maxConversations ? todo.slice(0, maxConversations) : todo;

  if (finalTodo.length === 0) {
    console.log("");
    console.log("✅ ทำครบแล้ว — ไม่มี conversation ที่ต้อง generate");
    return;
  }

  console.log("");
  console.log(`→ เริ่ม generate ${finalTodo.length} conversations`);
  console.log(`  ประเมินเวลา: ~${(finalTodo.length * 5 * 2.42 / 60).toFixed(0)} นาที (เฉลี่ย 5 คำถาม/conv)`);
  console.log(`  กด Ctrl+C เพื่อหยุด — รันใหม่ได้ จะข้ามที่ทำแล้ว`);
  console.log("");

  // 4. ลูป generate ทีละ conversation
  let convDone = 0;
  let totalReplies = 0;
  let totalCostUsd = 0;
  let totalErrors = 0;
  const startTime = Date.now();

  // ⚡ จัดการ Ctrl+C แบบสวยงาม
  let stopped = false;
  const handleStop = () => {
    if (stopped) {
      console.log("\n\n⚠️  บังคับหยุด — ข้อมูลที่บันทึกแล้วปลอดภัย");
      process.exit(1);
    }
    stopped = true;
    console.log("\n\n⏸  กำลังหยุด... (กด Ctrl+C อีกครั้งเพื่อบังคับหยุด)");
  };
  process.on("SIGINT", handleStop);

  for (let i = 0; i < finalTodo.length; i++) {
    if (stopped) {
      console.log("\n⏸  หยุดตามคำสั่ง — ข้อมูลที่บันทึกแล้วปลอดภัย");
      break;
    }

    const conv = finalTodo[i];
    const convStart = Date.now();

    try {
      // ⛔ Safety guard — เหมือนทุกครั้ง
      assertPlatformApiDisabled(conv.platform, "send");
      assertPlatformApiDisabled(conv.platform, "read");

      // เช็คว่ามี user inbound กี่ข้อความ
      const qCount = await countUserInbound(conv.conversation_id, conv.platform);
      if (qCount === 0) {
        console.log(`  [${i + 1}/${finalTodo.length}] ${conv.conversation_id} — ข้าม (ไม่มีคำถาม)`);
        convDone++;
        continue;
      }

      process.stdout.write(`  [${i + 1}/${finalTodo.length}] ${conv.conversation_id} (${qCount}Q) ... `);

      // เรียกฟังก์ชันเดิม — safety guards ทำงานข้างใน
      const docs = await shadowReplyService.generateConversation({
        conversationId: conv.conversation_id,
        botCaller: callOurBot,
      });

      const elapsed = ((Date.now() - convStart) / 1000).toFixed(1);
      const cost = docs.reduce((s, d) => s + (d.bot_cost_usd || 0), 0);
      totalReplies += docs.length;
      totalCostUsd += cost;
      convDone++;

      console.log(`✅ ${docs.length} replies | ${elapsed}s | $${cost.toFixed(4)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const elapsed = ((Date.now() - convStart) / 1000).toFixed(1);
      totalErrors++;
      console.log(`❌ ${elapsed}s | ${msg.slice(0, 120)}`);
    }

    // โชว์สรุปทุก 10 conversations
    if ((i + 1) % 10 === 0) {
      const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const avgPerConv = (parseFloat(totalElapsed) / convDone).toFixed(1);
      const remaining = (parseFloat(avgPerConv) * (finalTodo.length - convDone) / 60).toFixed(0);
      console.log("");
      console.log(`  ── Progress: ${convDone}/${finalTodo.length} convs | ${totalReplies} replies | ${totalErrors} errors | ${totalElapsed}s | ~${remaining}min left ──`);
      console.log("");
    }
  }

  // 5. สรุป
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  เสร็จสิ้น                                                ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Conversations ที่ทำ: ${convDone}/${finalTodo.length}`);
  console.log(`  Shadow replies ทั้งหมด: ${totalReplies}`);
  console.log(`  Errors: ${totalErrors}`);
  console.log(`  เวลาที่ใช้: ${totalElapsed}s (${(parseFloat(totalElapsed) / 60).toFixed(1)} นาที)`);
  console.log(`  Cost รวม: $${totalCostUsd.toFixed(4)} (฿${(totalCostUsd * 36).toFixed(2)})`);
  console.log("");
  console.log(`  → ดูผลได้ที่หน้า Shadow Inbox → tab History`);
  console.log("");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
