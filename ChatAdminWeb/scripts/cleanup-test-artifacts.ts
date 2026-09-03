// Cleanup — ลบ test artifacts ทั้งหมดจาก DB (e2e + rollout)
// รันด้วย: npx tsx --env-file=.env scripts/cleanup-test-artifacts.ts
import { workflowService } from "../src/backend/service/workflowService";
import { getCollection, COLLECTIONS } from "../src/backend/db/mongoClient";

async function main() {
  console.log("=== Cleanup test artifacts ===\n");

  // 1. ลบ test workflows (e2e + rollout) — hard delete เพราะเป็น test data
  const flows = await workflowService.listWorkflows({});
  const testFlows = flows.filter(
    (f) =>
      f.name.startsWith("[E2E TEST]") ||
      f.name.startsWith("[ROLLOUT]") ||
      f.created_by === "test_e2e" ||
      f.created_by === "rollout-script"
  );
  // รวมถึงที่ถูก soft delete แล้ว
  const coll = await getCollection<{ workflow_id: string; name: string; created_by?: string }>(COLLECTIONS.workflows);
  const allTestFlows = await coll.find({
    $or: [
      { name: { $regex: "^\\[E2E TEST\\]" } },
      { name: { $regex: "^\\[ROLLOUT\\]" } },
      { created_by: { $in: ["test_e2e", "rollout-script"] } },
    ],
  }).toArray();
  console.log(`พบ test workflows: ${allTestFlows.length}`);
  for (const f of allTestFlows) {
    await coll.deleteOne({ workflow_id: f.workflow_id });
    console.log(`  ลบ: ${f.workflow_id} ${f.name}`);
  }

  // 2. ลบ test workflow_runs
  const runsColl = await getCollection<{ conversation_id: string; run_id: string }>(COLLECTIONS.workflowRuns);
  const testRuns = await runsColl.find({
    $or: [
      { conversation_id: { $regex: "^test_e2e_" } },
      { "context.shop_id": "test_e2e_shop" },
    ],
  }).toArray();
  console.log(`\nพบ test runs: ${testRuns.length}`);
  if (testRuns.length > 0) {
    await runsColl.deleteMany({
      $or: [
        { conversation_id: { $regex: "^test_e2e_" } },
        { "context.shop_id": "test_e2e_shop" },
      ],
    });
    console.log("  ลบครบ");
  }

  // 3. ลบ test admin logs
  const logsColl = await getCollection<{ actor: string; action_type: string }>(COLLECTIONS.adminLogs);
  const testLogs = await logsColl.find({
    actor: { $in: ["test_e2e", "rollout-script", "rollback-script"] },
  }).toArray();
  console.log(`\nพบ test logs: ${testLogs.length}`);
  if (testLogs.length > 0) {
    await logsColl.deleteMany({
      actor: { $in: ["test_e2e", "rollout-script", "rollback-script"] },
    });
    console.log("  ลบครบ");
  }

  console.log("\n=== สรุป ===");
  console.log(`test workflows ลบ: ${allTestFlows.length}`);
  console.log(`test runs ลบ: ${testRuns.length}`);
  console.log(`test logs ลบ: ${testLogs.length}`);
}

main().catch((err) => {
  console.error("Cleanup error:", err);
  process.exit(1);
});
