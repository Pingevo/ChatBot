// scripts/clear-shadow-replies.ts
//
// เคลียร์ shadow_replies ทั้งหมด (manual + manual_conversation + worker)
// ใช้ก่อนรัน generate-all-shadow เพื่อเริ่มใหม่สะอาด
//
// วิธีรัน:
//   npx tsx scripts/clear-shadow-replies.ts
//
// ตัวเลือก:
//   --confirm   ยืนยันลบจริง (ไม่ใส่จะ dry run)
//   --origin=X  ลบเฉพาะ origin (manual, manual_conversation, worker)

import "dotenv/config";
import { MongoClient } from "mongodb";

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const originArg = args.find((a) => a.startsWith("--origin="))?.split("=")[1];

async function main() {
  const uri = process.env.ADMIN_MONGO_URI || "";
  if (!uri) throw new Error("ADMIN_MONGO_URI not set");
  const dbName = process.env.ADMIN_MONGO_DB || "chatbot";
  const collName = process.env.ADMIN_MONGO_COLLECTION_SHADOW_REPLIES || "shadow_replies";

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const coll = db.collection(collName);

  // นับก่อน
  const filter: Record<string, unknown> = {};
  if (originArg) filter.origin = originArg;

  const total = await coll.countDocuments(filter);
  const byOrigin = await coll.aggregate([
    { $match: filter },
    { $group: { _id: "$origin", count: { $sum: 1 } } },
  ]).toArray();

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Clear Shadow Replies                                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`Collection: ${collName}`);
  console.log(`Total: ${total} documents`);
  for (const r of byOrigin) {
    console.log(`  origin=${r._id}: ${r.count}`);
  }
  console.log("");

  if (!confirmed) {
    console.log("⚠️  Dry run — ไม่ได้ลบจริง");
    console.log("   ถ้าจะลบจริง ใส่ --confirm");
    console.log("");
    console.log("   ตัวอย่าง:");
    console.log("   npx tsx scripts/clear-shadow-replies.ts --confirm");
    console.log("   npx tsx scripts/clear-shadow-replies.ts --confirm --origin=manual");
    await client.close();
    return;
  }

  // ลบจริง
  console.log("→ กำลังลบ...");
  const result = await coll.deleteMany(filter);
  console.log(`✅ ลบแล้ว: ${result.deletedCount} documents`);

  // นับอีกครั้งเพื่อยืนยัน
  const remaining = await coll.countDocuments({});
  console.log(`  เหลือ: ${remaining} documents`);
  console.log("");
  await client.close();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
