// Phase 6.4 — Rollout: สร้าง test workflow สำหรับ shop GodungIT + เปิด workflow_enabled
// รันด้วย: npx tsx --env-file=.env scripts/rollout-workflow.ts
//
// ทำ:
//   1. สร้าง test workflow (shop_ids=["GodungIT"] · priority สูง · enabled · published)
//   2. เปิด workflow_enabled=true ใน SystemConfig
//   3. พิมพ์สรุป workflow_id + วิธีทดสอบ
//
// ทดสอบจริง: ส่งข้อความ "สเปค" เข้า shop GodungIT → workflow engine ทำงาน
// ปิด: รัน scripts/rollback-workflow.ts หรือลบ workflow ใน UI

import { workflowService } from "../src/backend/service/workflowService";
import { getSystemConfig, updateSystemConfig } from "../src/backend/service/systemConfigService";
import type { WorkflowNode, WorkflowEdge } from "../src/backend/service/workflowService";

const TEST_SHOP_ID = "GodungIT";

async function main() {
  console.log(`\n=== Phase 6.4 — Rollout workflow for shop "${TEST_SHOP_ID}" ===\n`);

  // 1. สร้าง test workflow
  const nodes: WorkflowNode[] = [
    {
      node_id: "t1", type: "trigger", subtype: "message_received",
      config: { keywords: ["สเปค", "ราคา"] }, position: { x: 0, y: 0 },
    },
    {
      node_id: "a1", type: "action", subtype: "send_message",
      config: { text: "สวัสดีครับ — สนใจสั่งซื้อหรือดูรายละเอียดสินค้า?" },
      position: { x: 100, y: 0 },
    },
    {
      node_id: "w1", type: "wait", subtype: "wait_for_reply",
      config: {
        answer_type: "any",
        max_retries: 2,
        timeout_ms: 300000,
        retry_message: "กรุณาตอบว่าสนใจสั่งซื้อหรือดูรายละเอียดครับ",
      },
      position: { x: 200, y: 0 },
    },
    {
      node_id: "c1", type: "condition", subtype: "message_content",
      config: {
        source: "customer_reply",
        branches: [
          { branch_id: "buy", match_type: "contains_any", keywords: ["สั่งซื้อ", "ซื้อ", "สนใจ"], label: "สั่งซื้อ" },
          { branch_id: "ask", match_type: "contains_any", keywords: ["ดู", "รายละเอียด", "สเปค"], label: "ดู" },
        ],
        fallback_branch_id: "other",
      },
      position: { x: 300, y: 0 },
    },
    // buy branch
    {
      node_id: "lbl_buy", type: "action", subtype: "add_label",
      config: { label_ids: ["buy_intent"] },
      position: { x: 400, y: -80 },
    },
    {
      node_id: "a_buy", type: "action", subtype: "send_message",
      config: { text: "ขอบคุณครับ — แอดมินจะติดต่อกลับเพื่อสั่งซื้อครับ" },
      position: { x: 500, y: -80 },
    },
    // ask branch
    {
      node_id: "a_ask", type: "action", subtype: "send_message",
      config: { text: "นี่คือรายละเอียดสินค้าครับ — สอบถามเพิ่มเติมได้ครับ" },
      position: { x: 400, y: 0 },
    },
    // other branch
    {
      node_id: "a_other", type: "action", subtype: "send_message",
      config: { text: "อยากทราบข้อมูลเพิ่มเติมโปรดระบุครับ" },
      position: { x: 400, y: 80 },
    },
  ];

  const edges: WorkflowEdge[] = [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "a1" },
    { edge_id: "e2", source_node_id: "a1", target_node_id: "w1" },
    { edge_id: "e3", source_node_id: "w1", target_node_id: "c1", branch: "success" },
    { edge_id: "e4", source_node_id: "w1", target_node_id: "a_other", branch: "retry_exceeded" },
    { edge_id: "e5", source_node_id: "c1", target_node_id: "lbl_buy", branch: "buy" },
    { edge_id: "e6", source_node_id: "c1", target_node_id: "a_ask", branch: "ask" },
    { edge_id: "e7", source_node_id: "c1", target_node_id: "a_other", branch: "other" },
    { edge_id: "e8", source_node_id: "lbl_buy", target_node_id: "a_buy" },
  ];

  const doc = await workflowService.createWorkflow({
    name: "[ROLLOUT] GodungIT test flow",
    description: `Test workflow สำหรับ shop ${TEST_SHOP_ID} — trigger สเปค/ราคา → menu → wait → 3 branches (buy/ask/other)`,
    shopIds: [TEST_SHOP_ID],
    platforms: [],
    nodes,
    edges,
    enabled: true,
    status: "published",
    priority: 100,
    createdBy: "rollout-script",
  });

  console.log(`  ✅ สร้าง workflow: ${doc.workflow_id}`);
  console.log(`     name: ${doc.name}`);
  console.log(`     shop_ids: [${doc.shop_ids.join(", ")}]`);
  console.log(`     priority: ${doc.priority} · enabled: ${doc.enabled} · status: ${doc.status}`);

  // 2. เปิด workflow_enabled
  const before = await getSystemConfig();
  console.log(`\n  workflow_enabled ก่อน: ${before.workflow_enabled}`);
  await updateSystemConfig({ workflow_enabled: true }, "rollout-script");
  const after = await getSystemConfig();
  console.log(`  workflow_enabled หลัง: ${after.workflow_enabled} ✓`);

  // 3. สรุป
  console.log(`\n=== Rollout สำเร็จ ===`);
  console.log(`\n  วิธีทดสอบ:`);
  console.log(`    1. ส่งข้อความ "สเปค" หรือ "ราคา" เข้า shop ${TEST_SHOP_ID}`);
  console.log(`    2. บอทจะส่ง menu → รอ reply`);
  console.log(`    3. reply "สั่งซื้อ" → buy branch → add label + ส่งข้อความปิด`);
  console.log(`    4. reply "ดูรายละเอียด" → ask branch → ส่งรายละเอียด`);
  console.log(`    5. reply อย่างอื่น → other branch → ส่งข้อความถามเพิ่ม`);
  console.log(`\n  ปิด rollout:`);
  console.log(`    - ลบ workflow ใน UI: /workflows`);
  console.log(`    - หรือปิด workflow_enabled ใน System Config: /admin-config`);
  console.log(`\n  workflow_id: ${doc.workflow_id}`);
}

main().catch((err) => {
  console.error("Rollout error:", err);
  process.exit(1);
});
