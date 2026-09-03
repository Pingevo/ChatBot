// scripts/clear-shadow-replies.ts
//
// เคลียร์ shadow_replies ทั้งหมด (manual + manual_conversation + worker)
// ใช้ก่อนรัน generate-all-shadow เพื่อเริ่มใหม่สะอาด
//
// ⚠️ Soft delete — ไม่ลบจริง แค่ mark deleted_at + deleted_by
//   ถ้าต้องการลบจริง (hard delete) ใช้ --hard (ไม่แนะนำ)
//
// วิธีรัน:
//   npx tsx scripts/clear-shadow-replies.ts
//
// ตัวเลือก:
//   --confirm   ยืนยันลบจริง (ไม่ใส่จะ dry run)
//   --origin=X  ลบเฉพาะ origin (manual, manual_conversation, worker)
//   --hard      ลบจริง (hard delete — ไม่แนะนำ ใช้ความเสี่ยงเอง)

import "dotenv/config";
import { MongoClient } from "mongodb";

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const hardDelete = args.includes("--hard");
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

  // นับก่อน (เฉพาะที่ยังไม่ถูก soft delete)
  const filter: Record<string, unknown> = { deleted_at: { $exists: false } };
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
  console.log(`Mode: ${hardDelete ? "⚠️ HARD DELETE" : "soft delete (mark deleted_at)"}`);
  console.log(`Total: ${total} documents (not yet soft-deleted)`);
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
    console.log("   npx tsx scripts/clear-shadow-replies.ts --confirm --hard (⚠️ ลบจริง ไม่แนะนำ)");
    await client.close();
    return;
  }

  // ลบ
  console.log(`→ กำลัง${hardDelete ? "ลบจริง" : "soft delete"}...`);
  if (hardDelete) {
    const result = await coll.deleteMany(filter);
    console.log(`✅ ลบจริงแล้ว: ${result.deletedCount} documents`);
  } else {
    const result = await coll.updateMany(filter, {
      $set: { deleted_at: new Date(), deleted_by: "script:clear-shadow-replies" },
    });
    console.log(`✅ Soft delete แล้ว: ${result.modifiedCount} documents (mark deleted_at)`);
  }

  // นับอีกครั้งเพื่อยืนยัน
  const remaining = await coll.countDocuments({ deleted_at: { $exists: false } });
  console.log(`  เหลือ (not soft-deleted): ${remaining} documents`);
  console.log("");
  await client.close();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
