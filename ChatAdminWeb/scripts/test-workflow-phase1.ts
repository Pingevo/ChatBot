// Unit test — Phase 1: multi-branch condition
// รันด้วย: npx tsx scripts/test-workflow-phase1.ts
//
// ทดสอบ:
//   1. matchBranch — contains_any / contains_all / equals / keywords ว่าง
//   2. evalMultiBranchCondition — match แรก / fallback / source selection
//   3. validateWorkflowGraph — multi-branch valid / branch_id ซ้ำ / fallback ชน / ghost branch edge
//   4. isMultiBranchCondition — type guard
//
// ⚠️ ไม่ต้องเชื่อม MongoDB — ทดสอบ pure functions เท่านั้น

import {
  validateWorkflowGraph,
  isMultiBranchCondition,
  isPhase2WaitConfig,
  isPhase3AddLabelConfig,
  WAIT_BRANCH,
  type WorkflowNode,
  type ConditionBranch,
} from "../src/backend/service/workflowService";
import { matchBranch, evalMultiBranchCondition, validateWaitAnswer, type EngineMessage } from "../src/backend/service/workflowEngine";
import { resolveTemplate, hasTemplateVariables, extractTemplateVariables } from "../src/backend/service/templateService";

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.error(`  ❌ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── 1. matchBranch ───────────────────────────────────────

console.log("\n=== 1. matchBranch ===");

const branchAny: ConditionBranch = { branch_id: "b1", match_type: "contains_any", keywords: ["สั่งซื้อ", "ซื้อ"] };
const branchAll: ConditionBranch = { branch_id: "b2", match_type: "contains_all", keywords: ["สั่งซื้อ", "หัวชาร์จ"] };
const branchEq: ConditionBranch = { branch_id: "b3", match_type: "equals", keywords: ["ใช่"] };
const branchEmpty: ConditionBranch = { branch_id: "b4", match_type: "contains_any", keywords: [] };

assert(matchBranch("อยากสั่งซื้อหัวชาร์จ", branchAny) === true, "contains_any: มีคำหนึ่ง → true");
assert(matchBranch("ไม่สนใจ", branchAny) === false, "contains_any: ไม่มีคำไหนเลย → false");
assert(matchBranch("อยากสั่งซื้อหัวชาร์จ", branchAll) === true, "contains_all: มีครบทุกคำ → true");
assert(matchBranch("อยากสั่งซื้อ", branchAll) === false, "contains_all: มีไม่ครบ → false");
assert(matchBranch("ใช่", branchEq) === true, "equals: ตรงเป๊ะ → true");
assert(matchBranch("ใช่ครับ", branchEq) === false, "equals: ไม่ตรง → false");
assert(matchBranch("อะไรก็ได้", branchEmpty) === false, "keywords ว่าง → false (ไม่ match)");
assert(matchBranch("สั่งซื้อ", { ...branchAny, keywords: ["สั่งซื้อ"] }) === true, "contains_any: 1 keyword ตรง → true");

// ─── 2. evalMultiBranchCondition ──────────────────────────

console.log("\n=== 2. evalMultiBranchCondition ===");

const multiNode: WorkflowNode = {
  node_id: "c1",
  type: "condition",
  subtype: "message_content",
  config: {
    source: "customer_reply",
    branches: [
      { branch_id: "buy", match_type: "contains_any", keywords: ["สั่งซื้อ", "ซื้อ"], label: "สั่งซื้อ" },
      { branch_id: "ask", match_type: "contains_any", keywords: ["สเปค", "ราคา"], label: "ถาม" },
    ],
    fallback_branch_id: "other",
  },
  position: { x: 0, y: 0 },
};

const baseMsg: EngineMessage = {
  message_id: "m1",
  conversation_id: "conv1",
  shop_id: "shop1",
  platform: "shopee",
  text: "สเปคหัวชาร์จ",
};

// match แรก (buy)
assertEqual(
  evalMultiBranchCondition(multiNode, baseMsg, { customer_reply: "อยากสั่งซื้อ" }).branch,
  "buy",
  "multi-branch: match แรก (buy)"
);

// match ที่สอง (ask)
assertEqual(
  evalMultiBranchCondition(multiNode, baseMsg, { customer_reply: "อยากรู้สเปค" }).branch,
  "ask",
  "multi-branch: match ที่สอง (ask)"
);

// ไม่ตรงเลย → fallback
assertEqual(
  evalMultiBranchCondition(multiNode, baseMsg, { customer_reply: "ไม่สนใจ" }).branch,
  "other",
  "multi-branch: ไม่ตรงเลย → fallback"
);

// source = initial_message → ใช้ initial_message จาก context ไม่ใช่ customer_reply
const sourceNode: WorkflowNode = {
  ...multiNode,
  config: { ...(multiNode.config as Record<string, unknown>), source: "initial_message" } as Record<string, unknown>,
};
assertEqual(
  evalMultiBranchCondition(sourceNode, baseMsg, { customer_reply: "สั่งซื้อ", initial_message: "สเปค" }).branch,
  "ask",
  "multi-branch: source=initial_message → ใช้ initial_message"
);

// ไม่มี context เลย → fallback ใช้ msg.text
assertEqual(
  evalMultiBranchCondition(multiNode, baseMsg, {}).branch,
  "ask",
  "multi-branch: ไม่มี context → ใช้ msg.text (สเปค → ask)"
);

// ─── 3. validateWorkflowGraph — multi-branch ──────────────

console.log("\n=== 3. validateWorkflowGraph (multi-branch) ===");

const triggerNode: WorkflowNode = {
  node_id: "t1",
  type: "trigger",
  subtype: "message_received",
  config: { keywords: ["สเปค"] },
  position: { x: 0, y: 0 },
};

const condNode: WorkflowNode = {
  node_id: "c1",
  type: "condition",
  subtype: "message_content",
  config: {
    source: "customer_reply",
    branches: [
      { branch_id: "b1", match_type: "contains_any", keywords: ["ซื้อ"], label: "ซื้อ" },
      { branch_id: "b2", match_type: "contains_any", keywords: ["ดู"], label: "ดู" },
    ],
    fallback_branch_id: "fb",
  },
  position: { x: 100, y: 0 },
};

// valid multi-branch
const actionNode1: WorkflowNode = { node_id: "n1", type: "action", subtype: "send_message", config: { text: "a" }, position: { x: 200, y: 0 } };
const actionNode2: WorkflowNode = { node_id: "n2", type: "action", subtype: "send_message", config: { text: "b" }, position: { x: 200, y: 80 } };
const actionNode3: WorkflowNode = { node_id: "n3", type: "action", subtype: "send_message", config: { text: "c" }, position: { x: 200, y: 160 } };
const validGraph = validateWorkflowGraph({
  nodes: [triggerNode, condNode, actionNode1, actionNode2, actionNode3],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "c1" },
    { edge_id: "e2", source_node_id: "c1", target_node_id: "n1", branch: "b1" },
    { edge_id: "e3", source_node_id: "c1", target_node_id: "n2", branch: "b2" },
    { edge_id: "e4", source_node_id: "c1", target_node_id: "n3", branch: "fb" },
  ],
});
assert(validGraph.ok, "valid multi-branch graph (3 edges ตรง branch)");

// branch_id ซ้ำ
const dupBranchGraph = validateWorkflowGraph({
  nodes: [triggerNode, {
    ...condNode,
    config: {
      source: "customer_reply",
      branches: [
        { branch_id: "b1", match_type: "contains_any", keywords: ["ซื้อ"] },
        { branch_id: "b1", match_type: "contains_any", keywords: ["ดู"] },
      ],
      fallback_branch_id: "fb",
    },
  }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "c1" }],
});
assert(!dupBranchGraph.ok && dupBranchGraph.errors.some((e) => e.includes("ซ้ำ")), "branch_id ซ้ำ → reject");

// fallback ชนกับ branch_id
const fallbackClashGraph = validateWorkflowGraph({
  nodes: [triggerNode, {
    ...condNode,
    config: {
      source: "customer_reply",
      branches: [{ branch_id: "b1", match_type: "contains_any", keywords: ["ซื้อ"] }],
      fallback_branch_id: "b1",
    },
  }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "c1" }],
});
assert(!fallbackClashGraph.ok && fallbackClashGraph.errors.some((e) => e.includes("fallback")), "fallback ตรง branch_id → reject");

// edge อ้าง branch ที่ไม่มี
const ghostBranchGraph = validateWorkflowGraph({
  nodes: [triggerNode, condNode],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "c1" },
    { edge_id: "e2", source_node_id: "c1", target_node_id: "n1", branch: "ghost" },
  ],
});
assert(!ghostBranchGraph.ok && ghostBranchGraph.errors.some((e) => e.includes("ghost")), "edge อ้าง ghost branch → reject");

// branch ไม่มี keywords
const emptyKwGraph = validateWorkflowGraph({
  nodes: [triggerNode, {
    ...condNode,
    config: {
      source: "customer_reply",
      branches: [{ branch_id: "b1", match_type: "contains_any", keywords: [] }],
      fallback_branch_id: "fb",
    },
  }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "c1" }],
});
assert(!emptyKwGraph.ok && emptyKwGraph.errors.some((e) => e.includes("keywords")), "branch ไม่มี keywords → reject");

// legacy binary ยังผ่าน
const legacyNode: WorkflowNode = {
  node_id: "c1",
  type: "condition",
  subtype: "message_content",
  config: { mode: "contains", text: "สั่งซื้อ" },
  position: { x: 100, y: 0 },
};
const legacyGraph = validateWorkflowGraph({
  nodes: [triggerNode, legacyNode, actionNode1, actionNode2],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "c1" },
    { edge_id: "e2", source_node_id: "c1", target_node_id: "n1", branch: "true" },
    { edge_id: "e3", source_node_id: "c1", target_node_id: "n2", branch: "false" },
  ],
});
assert(legacyGraph.ok, "legacy binary condition ยังผ่าน (backward compat)");

// ─── 4. isMultiBranchCondition ────────────────────────────

console.log("\n=== 4. isMultiBranchCondition (type guard) ===");

assert(isMultiBranchCondition({ branches: [], fallback_branch_id: "fb" }) === true, "มี branches + fallback → true");
assert(isMultiBranchCondition({ mode: "contains", text: "x" }) === false, "legacy config → false");
assert(isMultiBranchCondition(undefined) === false, "undefined → false");
assert(isMultiBranchCondition(null) === false, "null → false");
assert(isMultiBranchCondition({ branches: "not array" }) === false, "branches ไม่ใช่ array → false");
assert(isMultiBranchCondition({ branches: [] }) === false, "มี branches แต่ไม่มี fallback → false");

// ─── 5. validateWaitAnswer (Phase 2) ──────────────────────

console.log("\n=== 5. validateWaitAnswer (Phase 2) ===");

assert(validateWaitAnswer("สวัสดี", { answer_type: "any", max_retries: 3, timeout_ms: 60000 }) === true, "any: อะไรก็ได้ → true");
assert(validateWaitAnswer("", { answer_type: "any", max_retries: 3, timeout_ms: 60000 }) === false, "any: ว่าง → false");
assert(validateWaitAnswer("  ", { answer_type: "any", max_retries: 3, timeout_ms: 60000 }) === false, "any: ช่องว่าง → false");
assert(validateWaitAnswer("42", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === true, "number: 42 → true");
assert(validateWaitAnswer("3.14", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === true, "number: 3.14 → true");
assert(validateWaitAnswer("3,14", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === true, "number: 3,14 (จุลภาคไทย) → true");
assert(validateWaitAnswer("abc", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === false, "number: abc → false");
assert(validateWaitAnswer("ใช่", { answer_type: "custom_keywords", max_retries: 3, timeout_ms: 60000, custom_keywords: ["ใช่", "ตกลง"] }) === true, "custom_keywords: ใช่ → true");
assert(validateWaitAnswer("ตกลงครับ", { answer_type: "custom_keywords", max_retries: 3, timeout_ms: 60000, custom_keywords: ["ใช่", "ตกลง"] }) === true, "custom_keywords: ตกลงครับ (contains) → true");
assert(validateWaitAnswer("ไม่", { answer_type: "custom_keywords", max_retries: 3, timeout_ms: 60000, custom_keywords: ["ใช่", "ตกลง"] }) === false, "custom_keywords: ไม่ → false");
assert(validateWaitAnswer("อะไรก็ได้", { answer_type: "custom_keywords", max_retries: 3, timeout_ms: 60000, custom_keywords: [] }) === true, "custom_keywords: ไม่กำหนด keyword → true (อะไรก็ได้)");

// ─── 6. isPhase2WaitConfig (type guard) ───────────────────

console.log("\n=== 6. isPhase2WaitConfig (type guard) ===");

assert(isPhase2WaitConfig({ answer_type: "any", max_retries: 3, timeout_ms: 60000 }) === true, "มี answer_type → true");
assert(isPhase2WaitConfig({ timeout_ms: 60000 }) === false, "legacy (ไม่มี answer_type) → false");
assert(isPhase2WaitConfig(undefined) === false, "undefined → false");
assert(isPhase2WaitConfig(null) === false, "null → false");

// ─── 7. validateWorkflowGraph — wait node Phase 2 ─────────

console.log("\n=== 7. validateWorkflowGraph (wait node Phase 2) ===");

const waitNodePhase2: WorkflowNode = {
  node_id: "w1",
  type: "wait",
  subtype: "wait_for_reply",
  config: { answer_type: "any", max_retries: 3, retry_message: "รบกวนพิมพ์ใหม่นะคะ", timeout_ms: 3600000 },
  position: { x: 100, y: 100 },
};

// valid Phase 2 wait — 3 edges ตรง branch
const validWaitGraph = validateWorkflowGraph({
  nodes: [triggerNode, waitNodePhase2, actionNode1, actionNode2, actionNode3],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "w1" },
    { edge_id: "e2", source_node_id: "w1", target_node_id: "n1", branch: WAIT_BRANCH.SUCCESS },
    { edge_id: "e3", source_node_id: "w1", target_node_id: "n2", branch: WAIT_BRANCH.RETRY_EXCEEDED },
    { edge_id: "e4", source_node_id: "w1", target_node_id: "n3", branch: WAIT_BRANCH.NO_REPLY },
  ],
});
assert(validWaitGraph.ok, "valid Phase 2 wait (3 edges ตรง branch)");

// valid Phase 2 wait — มีแค่ success edge (optional branch)
const partialWaitGraph = validateWorkflowGraph({
  nodes: [triggerNode, waitNodePhase2, actionNode1],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "w1" },
    { edge_id: "e2", source_node_id: "w1", target_node_id: "n1", branch: WAIT_BRANCH.SUCCESS },
  ],
});
assert(partialWaitGraph.ok, "valid Phase 2 wait (มีแค่ success edge — optional branch)");

// invalid: ghost branch
const ghostWaitGraph = validateWorkflowGraph({
  nodes: [triggerNode, waitNodePhase2],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "w1" },
    { edge_id: "e2", source_node_id: "w1", target_node_id: "n1", branch: "ghost" },
  ],
});
assert(!ghostWaitGraph.ok && ghostWaitGraph.errors.some((e) => e.includes("ghost")), "wait: edge อ้าง ghost branch → reject");

// invalid: max_retries < 0
const badRetriesGraph = validateWorkflowGraph({
  nodes: [triggerNode, { ...waitNodePhase2, config: { ...waitNodePhase2.config, max_retries: -1 } }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "w1" }],
});
assert(!badRetriesGraph.ok && badRetriesGraph.errors.some((e) => e.includes("max_retries")), "wait: max_retries < 0 → reject");

// invalid: timeout_ms = 0
const badTimeoutGraph = validateWorkflowGraph({
  nodes: [triggerNode, { ...waitNodePhase2, config: { ...waitNodePhase2.config, timeout_ms: 0 } }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "w1" }],
});
assert(!badTimeoutGraph.ok && badTimeoutGraph.errors.some((e) => e.includes("timeout_ms")), "wait: timeout_ms = 0 → reject");

// invalid: custom_keywords ไม่มี keywords
const badCustomKwGraph = validateWorkflowGraph({
  nodes: [triggerNode, { ...waitNodePhase2, config: { answer_type: "custom_keywords", max_retries: 3, timeout_ms: 60000, custom_keywords: [] } }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "w1" }],
});
assert(!badCustomKwGraph.ok && badCustomKwGraph.errors.some((e) => e.includes("custom_keywords")), "wait: custom_keywords ไม่มี keywords → reject");

// legacy wait ยังผ่าน
const legacyWaitNode: WorkflowNode = {
  node_id: "w1",
  type: "wait",
  subtype: "wait_for_reply",
  config: { timeout_ms: 300000 },
  position: { x: 100, y: 100 },
};
const legacyWaitGraph = validateWorkflowGraph({
  nodes: [triggerNode, legacyWaitNode, actionNode1],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "w1" },
    { edge_id: "e2", source_node_id: "w1", target_node_id: "n1" },
  ],
});
assert(legacyWaitGraph.ok, "legacy wait (ไม่มี answer_type) ยังผ่าน (backward compat)");

// ─── 8. isPhase3AddLabelConfig (type guard) ───────────────

console.log("\n=== 8. isPhase3AddLabelConfig (type guard) ===");

assert(isPhase3AddLabelConfig({ label_ids: ["a", "b"] }) === true, "มี label_ids array → true");
assert(isPhase3AddLabelConfig({ label_ids: [] }) === true, "label_ids ว่าง → true (ยังเป็น Phase 3)");
assert(isPhase3AddLabelConfig({ label: "สนใจซื้อ" }) === false, "legacy { label } → false");
assert(isPhase3AddLabelConfig(undefined) === false, "undefined → false");
assert(isPhase3AddLabelConfig(null) === false, "null → false");
assert(isPhase3AddLabelConfig({ label_ids: "not array" }) === false, "label_ids ไม่ใช่ array → false");

// ─── 9. resolveTemplate (Phase 4) ─────────────────────────

console.log("\n=== 9. resolveTemplate (Phase 4) ===");

assertEqual(
  resolveTemplate("สวัสดี {{customerName}}", { customerName: "คุณสมชาย" }),
  "สวัสดี คุณสมชาย",
  "resolve: แทน {{customerName}} ด้วยค่าจริง"
);

assertEqual(
  resolveTemplate("ร้าน {{shopName}} แพลตฟอร์ม {{integrationName}}", { shopName: "ร้านชาร์จ", integrationName: "shopee" }),
  "ร้าน ร้านชาร์จ แพลตฟอร์ม shopee",
  "resolve: หลายตัวแปร"
);

assertEqual(
  resolveTemplate("คำตอบบอท: {{botAnswer}}", { botAnswer: "หัวชาร์จ 65W" }),
  "คำตอบบอท: หัวชาร์จ 65W",
  "resolve: botAnswer"
);

assertEqual(
  resolveTemplate("สวัสดี {{customerName}}", {}),
  "สวัสดี ",
  "resolve: var ไม่มีค่า → แทนด้วยค่าว่าง"
);

assertEqual(
  resolveTemplate("สวัสดี {{ unknownVar }}", {}),
  "สวัสดี ",
  "resolve: var ไม่รู้จัก + มีช่องว่าง → แทนด้วยค่าว่าง"
);

assertEqual(
  resolveTemplate("{{customerName}}{{shopName}}", { customerName: "A", shopName: "B" }),
  "AB",
  "resolve: ติดกันไม่มีช่องว่าง"
);

assertEqual(
  resolveTemplate("ไม่มีตัวแปรเลย", { customerName: "A" }),
  "ไม่มีตัวแปรเลย",
  "resolve: ไม่มี {{}} → คืนเดิม"
);

assertEqual(resolveTemplate("", { customerName: "A" }), "", "resolve: text ว่าง → ว่าง");
assertEqual(resolveTemplate("{{customerName}}", { customerName: "" }), "", "resolve: var เป็นค่าว่าง → ว่าง");

// case-insensitive
assertEqual(
  resolveTemplate("{{CustomerName}}", { customername: "คุณบอย" }),
  "คุณบอย",
  "resolve: case-insensitive (CustomerName → customername)"
);

// ─── 10. hasTemplateVariables + extractTemplateVariables ──

console.log("\n=== 10. hasTemplateVariables + extractTemplateVariables ===");

assert(hasTemplateVariables("สวัสดี {{customerName}}") === true, "hasTemplate: มี {{}} → true");
assert(hasTemplateVariables("ไม่มีตัวแปร") === false, "hasTemplate: ไม่มี → false");
assert(hasTemplateVariables("") === false, "hasTemplate: ว่าง → false");

assertEqual(
  extractTemplateVariables("สวัสดี {{customerName}} ร้าน {{shopName}}"),
  ["customerName", "shopName"],
  "extract: ดึงชื่อตัวแปรทั้งหมด"
);

assertEqual(
  extractTemplateVariables("ไม่มีตัวแปร"),
  [],
  "extract: ไม่มี → []"
);

assertEqual(
  extractTemplateVariables("{{customerName}} {{customerName}}"),
  ["customerName"],
  "extract: ซ้ำ → dedupe"
);

// ─── Summary ──────────────────────────────────────────────

console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  process.exit(1);
}
