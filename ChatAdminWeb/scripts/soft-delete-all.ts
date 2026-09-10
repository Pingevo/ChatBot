// ⚡ One-shot script — soft delete ข้อมูลทั้งหมดใน shadow_replies, test_assignment, test_chat_sessions, test_chat_ratings
//   รัน: npx tsx scripts/soft-delete-all.ts
//   ⚠️ ลบแล้วหลังใช้
import { config } from "dotenv";
config({ path: ".env" });

import { MongoClient } from "mongodb";

function required(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v || fallback;
}

function buildAdminMongoUri(): string {
  const directUri = process.env.ADMIN_MONGO_URI?.trim();
  if (directUri) return directUri;
  const host = required("ADMIN_MONGO_HOST", "127.0.0.1:27017");
  const username = process.env.ADMIN_MONGO_USERNAME?.trim() || "";
  const password = process.env.ADMIN_MONGO_PASSWORD?.trim() || "";
  const authSource = required("ADMIN_MONGO_AUTH_SOURCE", "admin");
  const tls = (process.env.ADMIN_MONGO_TLS?.trim().toLowerCase() || "false") === "true";
  const params = new URLSearchParams();
  params.set("authSource", authSource);
  params.set("tls", String(tls));
  const creds = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  return `mongodb://${creds}${host}/?${params.toString()}`;
}

const URI = buildAdminMongoUri();
const DB_NAME = required("ADMIN_MONGO_DB", "chatbot_admin");

const COLLECTIONS_TO_CLEAR = [
  { name: required("ADMIN_MONGO_COLLECTION_SHADOW_REPLIES", "shadow_replies"), label: "shadow_replies" },
  { name: required("ADMIN_MONGO_COLLECTION_TEST_ASSIGNMENT", "test_assignment"), label: "test_assignment" },
  { name: required("ADMIN_MONGO_COLLECTION_TEST_CHAT_SESSIONS", "test_chat_sessions"), label: "test_chat_sessions" },
  { name: required("ADMIN_MONGO_COLLECTION_TEST_CHAT_RATINGS", "test_chat_ratings"), label: "test_chat_ratings" },
];

async function main() {
  console.log(`Connecting to ${DB_NAME}...`);
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(DB_NAME);

  const now = new Date();
  let totalModified = 0;

  for (const { name, label } of COLLECTIONS_TO_CLEAR) {
    const coll = db.collection(name);
    const count = await coll.countDocuments({ deleted_at: { $exists: false } });
    console.log(`  ${label} (${name}): ${count} docs to soft-delete`);

    if (count === 0) {
      console.log(`    → skip (already all deleted)`);
      continue;
    }

    const result = await coll.updateMany(
      { deleted_at: { $exists: false } },
      {
        $set: {
          deleted_at: now,
          deleted_by: "manual_cleanup",
          delete_reason: "clear_all_phase3b",
          updated_at: now,
        },
      }
    );
    console.log(`    → soft-deleted ${result.modifiedCount} docs`);
    totalModified += result.modifiedCount;
  }

  console.log(`\nDone. Total soft-deleted: ${totalModified} docs`);
  await client.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
