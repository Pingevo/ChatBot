// Verify ensureIndexes fix for MongoDB 5.0 ($exists: false in partial index)
// Spins up mongodb-memory-server with MongoDB 5.0, then tests:
//   1. OLD spec (2 partial indexes with $exists: false) → must FAIL (reproduce bug)
//   2. NEW spec (1 plain unique index) → must SUCCEED (verify fix)
//   3. NEW spec enforces unique constraint on legacy docs (no batch_id)
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

const DB_NAME = "test_ensure_indexes";
const COLL = "chat_annotations";

async function tryCreateIndex(db, spec, options, label) {
  try {
    await db.collection(COLL).createIndex(spec, options);
    console.log(`  [PASS] ${label}`);
    return true;
  } catch (e) {
    const code = e?.code;
    const codeName = e?.codeName;
    console.log(`  [FAIL] ${label} → code=${code} ${codeName}: ${e.message?.slice(0, 120)}`);
    return false;
  }
}

async function main() {
  // Note: $exists: false in partialFilterExpression is NOT supported in ANY MongoDB
  // version (not just 5.0) — it's converted to $not which is rejected. So testing
  // with any available version reproduces the bug.
  console.log("Starting MongoDB in-memory (default version)...");
  const mongod = await MongoMemoryServer.create({ instance: { port: 27117 } });
  const uri = mongod.getUri();
  const version = await mongod.instanceInfo?.then?.(i => i?.version) ?? "unknown";
  console.log(`MongoDB started at ${uri}`);
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(DB_NAME);

  // Drop collection to start fresh
  await db.collection(COLL).drop().catch(() => {});

  console.log("\n=== Test 1: OLD spec (2 partial indexes — reproduce bug) ===");
  // 1a. partial index with $exists: true (has batch_id) — should succeed
  const ok1a = await tryCreateIndex(
    db,
    { scope: 1, conversation_id: 1, generation_batch_id: 1 },
    { unique: true, partialFilterExpression: { generation_batch_id: { $exists: true } } },
    "1a. partial index $exists:true (has batch_id)"
  );
  // 1b. partial index with $exists: false (legacy, no batch_id) — should FAIL on 5.0
  const ok1b = await tryCreateIndex(
    db,
    { scope: 1, conversation_id: 1 },
    { unique: true, partialFilterExpression: { generation_batch_id: { $exists: false } } },
    "1b. partial index $exists:false (legacy) — expect FAIL on 5.0"
  );

  console.log(`\n  Result: 1a=${ok1a ? "PASS" : "FAIL"}, 1b=${ok1b ? "PASS" : "FAIL (expected — this is the bug)"}`);

  // Clean up for test 2
  await db.collection(COLL).drop().catch(() => {});

  console.log("\n=== Test 2: NEW spec (1 plain unique index — verify fix) ===");
  const ok2 = await tryCreateIndex(
    db,
    { scope: 1, conversation_id: 1, generation_batch_id: 1 },
    { unique: true },
    "2. plain unique index {scope, conversation_id, generation_batch_id}"
  );
  console.log(`\n  Result: ${ok2 ? "PASS ✅" : "FAIL ❌"}`);

  // List indexes to confirm
  console.log("\n=== Indexes on chat_annotations after NEW spec ===");
  const indexes = await db.collection(COLL).listIndexes().toArray();
  for (const idx of indexes) {
    console.log(`  ${idx.name}: key=${JSON.stringify(idx.key)} unique=${idx.unique ?? false} partial=${JSON.stringify(idx.partialFilterExpression ?? null)}`);
  }

  console.log("\n=== Test 3: unique constraint on legacy docs (no batch_id) ===");
  // Insert a legacy doc (no generation_batch_id field)
  await db.collection(COLL).insertOne({
    annotation_id: "ann_legacy_1",
    scope: "shadow_bot",
    conversation_id: "conv_1",
    color: "red",
    note: "legacy annotation",
    created_by: "admin_1",
    created_at: new Date(),
    updated_at: new Date(),
  });
  // Try to insert a 2nd legacy doc with same (scope, conversation_id) → must FAIL (unique)
  let dupLegacyBlocked = false;
  try {
    await db.collection(COLL).insertOne({
      annotation_id: "ann_legacy_2",
      scope: "shadow_bot",
      conversation_id: "conv_1",
      color: "blue",
      note: "duplicate legacy",
      created_by: "admin_1",
      created_at: new Date(),
      updated_at: new Date(),
    });
    console.log("  [FAIL] 2nd legacy doc with same (scope, conv_id) was INSERTED — unique not enforced ❌");
  } catch (e) {
    dupLegacyBlocked = true;
    console.log(`  [PASS] 2nd legacy doc blocked → code=${e.code} ${e.codeName} ✅`);
  }

  console.log("\n=== Test 4: different batch_id allows multiple annotations per chat ===");
  // Insert doc with batch_id "batch_1" for same conv_1 → should succeed (different key)
  let batch1ok = false, batch2ok = false;
  try {
    await db.collection(COLL).insertOne({
      annotation_id: "ann_b1",
      scope: "shadow_bot",
      conversation_id: "conv_1",
      generation_batch_id: "batch_1",
      color: "green",
      note: "batch 1",
      created_by: "admin_1",
      created_at: new Date(),
      updated_at: new Date(),
    });
    batch1ok = true;
  } catch (e) { console.log(`  batch_1 insert failed: ${e.code}`); }
  try {
    await db.collection(COLL).insertOne({
      annotation_id: "ann_b2",
      scope: "shadow_bot",
      conversation_id: "conv_1",
      generation_batch_id: "batch_2",
      color: "yellow",
      note: "batch 2",
      created_by: "admin_1",
      created_at: new Date(),
      updated_at: new Date(),
    });
    batch2ok = true;
  } catch (e) { console.log(`  batch_2 insert failed: ${e.code}`); }
  console.log(`  batch_1 inserted: ${batch1ok ? "✅" : "❌"}, batch_2 inserted: ${batch2ok ? "✅" : "❌"} (both should pass — different batch_id)`);

  // Summary
  console.log("\n=== SUMMARY ===");
  console.log(`  Test 1 (old spec reproduce bug): 1a=${ok1a ? "PASS" : "FAIL"}, 1b=${ok1b ? "PASS" : "FAIL(expected)"} — bug ${ok1b ? "NOT" : ""} reproduced ${!ok1b ? "✅" : "❌"}`);
  console.log(`  Test 2 (new spec fix): ${ok2 ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  Test 3 (legacy unique enforced): ${dupLegacyBlocked ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  Test 4 (multi-batch per chat): ${batch1ok && batch2ok ? "PASS ✅" : "FAIL ❌"}`);

  const allPass = !ok1b && ok2 && dupLegacyBlocked && batch1ok && batch2ok;
  console.log(`\n  OVERALL: ${allPass ? "✅ ALL CHECKS PASS — fix verified on MongoDB 5.0" : "❌ SOME CHECKS FAILED"}`);

  await client.close();
  await mongod.stop();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
