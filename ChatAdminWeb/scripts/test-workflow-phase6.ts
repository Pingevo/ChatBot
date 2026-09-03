// Unit test — Phase 6: Testing / Rollout
// รันด้วย: npx tsx --env-file=.env scripts/test-workflow-phase6.ts
//
// ทดสอบ:
//   1. validateWaitAnswer — answer_type any/number/custom_keywords + edge cases
//   2. validateWorkflowGraph — Phase 2 wait branch validation (success/retry_exceeded/no_reply)
//      + max_retries/timeout_ms/answer_type validation + custom_keywords required
//   3. evalMultiBranchCondition — edge cases (empty branches, fallback missing, source variants)
//   4. matchBranch — case-insensitive + whitespace + unicode
//   5. isPhase2WaitConfig — type guard edge cases
//   6. resolveTemplate — Phase 4 variable interpolation edge cases
//
// ⚠️ ไม่ต้องเชื่อม MongoDB — ทดสอบ pure functions เท่านั้น
// resumeFlow เป็น async ที่เชื่อม MongoDB → ไม่ทดสอบในนี้ (ทดสอบใน e2e แทน)

import {
  validateWorkflowGraph,
  isMultiBranchCondition,
  isPhase2WaitConfig,
  isPhase3AddLabelConfig,
  WAIT_BRANCH,
  type WorkflowNode,
  type WorkflowEdge,
  type ConditionBranch,
} from "../src/backend/service/workflowService";
import {
  matchBranch,
  evalMultiBranchCondition,
  validateWaitAnswer,
  type EngineMessage,
} from "../src/backend/service/workflowEngine";
import {
  resolveTemplate,
  hasTemplateVariables,
  extractTemplateVariables,
} from "../src/backend/service/templateService";

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

// ─── 1. validateWaitAnswer ─────────────────────────────────

console.log("\n=== 1. validateWaitAnswer (Phase 2) ===");

assert(validateWaitAnswer("สวัสดี", { answer_type: "any", max_retries: 3, timeout_ms: 60000 }) === true, "any: ข้อความอะไรก็ได้ → true");
assert(validateWaitAnswer("", { answer_type: "any", max_retries: 3, timeout_ms: 60000 }) === false, "any: ว่าง → false");
assert(validateWaitAnswer("   ", { answer_type: "any", max_retries: 3, timeout_ms: 60000 }) === false, "any: ว่างเว้นวรรค → false");
assert(validateWaitAnswer("123", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === true, "number: 123 → true");
assert(validateWaitAnswer("12.50", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === true, "number: ทศนิยม → true");
assert(validateWaitAnswer("12,50", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === true, "number: จุลภาคไทย → true");
assert(validateWaitAnswer("1 2 3", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === true, "number: มีเว้นวรรค → true (trim spaces)");
assert(validateWaitAnswer("abc", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === false, "number: ตัวอักษร → false");
assert(validateWaitAnswer("12abc", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === false, "number: ผสมตัวอักษร → false");
assert(validateWaitAnswer("", { answer_type: "number", max_retries: 3, timeout_ms: 60000 }) === false, "number: ว่าง → false");

assert(validateWaitAnswer("ใช่", { answer_type: "custom_keywords", custom_keywords: ["ใช่", "ตกลง"], max_retries: 3, timeout_ms: 60000 }) === true, "custom_keywords: มีคำตรง → true");
assert(validateWaitAnswer("ไม่", { answer_type: "custom_keywords", custom_keywords: ["ใช่", "ตกลง"], max_retries: 3, timeout_ms: 60000 }) === false, "custom_keywords: ไม่มีคำตรง → false");
assert(validateWaitAnswer("ใช่ครับ", { answer_type: "custom_keywords", custom_keywords: ["ใช่"], max_retries: 3, timeout_ms: 60000 }) === true, "custom_keywords: contains → true");
assert(validateWaitAnswer("อะไรก็ได้", { answer_type: "custom_keywords", custom_keywords: [], max_retries: 3, timeout_ms: 60000 }) === true, "custom_keywords: ว่าง → อะไรก็ได้ → true");
assert(validateWaitAnswer("ใช่", { answer_type: "custom_keywords", max_retries: 3, timeout_ms: 60000 } as never) === true, "custom_keywords: ไม่มี custom_keywords → อะไรก็ได้ → true");
assert(validateWaitAnswer("YES", { answer_type: "custom_keywords", custom_keywords: ["yes"], max_retries: 3, timeout_ms: 60000 }) === true, "custom_keywords: case-insensitive → true");
assert(validateWaitAnswer("  ใช่  ", { answer_type: "custom_keywords", custom_keywords: ["ใช่"], max_retries: 3, timeout_ms: 60000 }) === true, "custom_keywords: trim whitespace → true");

// ─── 2. validateWorkflowGraph — Phase 2 wait branch validation ──

console.log("\n=== 2. validateWorkflowGraph (Phase 2 wait branches) ===");

const triggerNode: WorkflowNode = {
  node_id: "t1", type: "trigger", subtype: "message_received",
  config: { keywords: ["สเปค"] }, position: { x: 0, y: 0 },
};

const waitNodeP2: WorkflowNode = {
  node_id: "w1", type: "wait", subtype: "wait_for_reply",
  config: {
    answer_type: "any",
    max_retries: 3,
    timeout_ms: 60000,
    retry_message: "กรุณาตอบใหม่",
  },
  position: { x: 100, y: 0 },
};

const actionNode: WorkflowNode = {
  node_id: "a1", type: "action", subtype: "send_message",
  config: { text: "hello" }, position: { x: 200, y: 0 },
};

// valid — มี success/retry_exceeded/no_reply ครบ
const validWaitGraph = validateWorkflowGraph({
  nodes: [triggerNode, waitNodeP2, actionNode, { ...actionNode, node_id: "a2" }, { ...actionNode, node_id: "a3" }],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "w1" },
    { edge_id: "e2", source_node_id: "w1", target_node_id: "a1", branch: WAIT_BRANCH.SUCCESS },
    { edge_id: "e3", source_node_id: "w1", target_node_id: "a2", branch: WAIT_BRANCH.RETRY_EXCEEDED },
    { edge_id: "e4", source_node_id: "w1", target_node_id: "a3", branch: WAIT_BRANCH.NO_REPLY },
  ],
});
assert(validWaitGraph.ok, "wait P2: มี success/retry_exceeded/no_reply ครบ → valid");

// valid — มีแค่ success (optional branches)
const partialWaitGraph = validateWorkflowGraph({
  nodes: [triggerNode, waitNodeP2, actionNode],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "w1" },
    { edge_id: "e2", source_node_id: "w1", target_node_id: "a1", branch: WAIT_BRANCH.SUCCESS },
  ],
});
assert(partialWaitGraph.ok, "wait P2: มีแค่ success → valid (optional branches)");

// valid — ไม่มี edge จาก wait เลย (engine จบ flow ได้)
const noEdgeWaitGraph = validateWorkflowGraph({
  nodes: [triggerNode, waitNodeP2],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "w1" }],
});
assert(noEdgeWaitGraph.ok, "wait P2: ไม่มี wait edge → valid (engine จบ flow)");

// invalid — branch ผิด (ghost branch)
const ghostBranchGraph = validateWorkflowGraph({
  nodes: [triggerNode, waitNodeP2, actionNode],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "w1" },
    { edge_id: "e2", source_node_id: "w1", target_node_id: "a1", branch: "invalid_branch" },
  ],
});
assert(!ghostBranchGraph.ok && ghostBranchGraph.errors.some((e) => e.includes("invalid_branch")), "wait P2: ghost branch → reject");

// invalid — max_retries < 0
const negRetryGraph = validateWorkflowGraph({
  nodes: [triggerNode, { ...waitNodeP2, config: { ...waitNodeP2.config, max_retries: -1 } }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "w1" }],
});
assert(!negRetryGraph.ok && negRetryGraph.errors.some((e) => e.includes("max_retries")), "wait P2: max_retries < 0 → reject");

// invalid — timeout_ms = 0
const zeroTimeoutGraph = validateWorkflowGraph({
  nodes: [triggerNode, { ...waitNodeP2, config: { ...waitNodeP2.config, timeout_ms: 0 } }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "w1" }],
});
assert(!zeroTimeoutGraph.ok && zeroTimeoutGraph.errors.some((e) => e.includes("timeout_ms")), "wait P2: timeout_ms = 0 → reject");

// invalid — answer_type ผิด
const badAnswerTypeGraph = validateWorkflowGraph({
  nodes: [triggerNode, { ...waitNodeP2, config: { ...waitNodeP2.config, answer_type: "invalid" } }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "w1" }],
});
assert(!badAnswerTypeGraph.ok && badAnswerTypeGraph.errors.some((e) => e.includes("answer_type")), "wait P2: answer_type ผิด → reject");

// invalid — custom_keywords ว่างเมื่อ answer_type=custom_keywords
const emptyCkGraph = validateWorkflowGraph({
  nodes: [triggerNode, { ...waitNodeP2, config: { ...waitNodeP2.config, answer_type: "custom_keywords", custom_keywords: [] } }],
  edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "w1" }],
});
assert(!emptyCkGraph.ok && emptyCkGraph.errors.some((e) => e.includes("custom_keywords")), "wait P2: custom_keywords ว่าง → reject");

// valid — legacy wait edge (ไม่มี branch) ยังอนุญาต
const legacyWaitGraph = validateWorkflowGraph({
  nodes: [triggerNode, waitNodeP2, actionNode],
  edges: [
    { edge_id: "e1", source_node_id: "t1", target_node_id: "w1" },
    { edge_id: "e2", source_node_id: "w1", target_node_id: "a1" }, // ไม่มี branch
  ],
});
assert(legacyWaitGraph.ok, "wait P2: legacy edge (ไม่มี branch) → valid");

// ─── 3. evalMultiBranchCondition — edge cases ──────────────

console.log("\n=== 3. evalMultiBranchCondition (edge cases) ===");

const baseMsg: EngineMessage = {
  message_id: "m1", conversation_id: "conv1", shop_id: "shop1", platform: "shopee", text: "",
};

// empty branches → fallback
const emptyBranchesNode: WorkflowNode = {
  node_id: "c1", type: "condition", subtype: "message_content",
  config: { source: "customer_reply", branches: [], fallback_branch_id: "fb" },
  position: { x: 0, y: 0 },
};
assertEqual(
  evalMultiBranchCondition(emptyBranchesNode, baseMsg, { customer_reply: "อะไรก็ได้" }).branch,
  "fb",
  "empty branches → fallback"
);

// ไม่มี fallback_branch_id → isMultiBranchCondition ไม่ผ่าน → คืน "false"
const noFallbackNode: WorkflowNode = {
  node_id: "c2", type: "condition", subtype: "message_content",
  config: { source: "customer_reply", branches: [
    { branch_id: "b1", match_type: "contains_any", keywords: ["ซื้อ"] },
  ] },
  position: { x: 0, y: 0 },
};
assertEqual(
  evalMultiBranchCondition(noFallbackNode, baseMsg, { customer_reply: "ไม่เกี่ยว" }).branch,
  "false",
  "ไม่มี fallback_branch_id → type guard ไม่ผ่าน → branch='false'"
);

// source = customer_reply แต่ไม่มี context → ใช้ msg.text
const sourceNode: WorkflowNode = {
  node_id: "c3", type: "condition", subtype: "message_content",
  config: { source: "customer_reply", branches: [
    { branch_id: "b1", match_type: "contains_any", keywords: ["สเปค"] },
  ], fallback_branch_id: "fb" },
  position: { x: 0, y: 0 },
};
assertEqual(
  evalMultiBranchCondition(sourceNode, { ...baseMsg, text: "อยากรู้สเปค" }, {}).branch,
  "b1",
  "source=customer_reply ไม่มี context → ใช้ msg.text"
);

// source = initial_message แต่ไม่มี context → ใช้ msg.text
const initSourceNode: WorkflowNode = {
  ...sourceNode,
  config: { source: "initial_message", branches: [
    { branch_id: "b1", match_type: "contains_any", keywords: ["สเปค"] },
  ], fallback_branch_id: "fb" } as Record<string, unknown>,
};
assertEqual(
  evalMultiBranchCondition(initSourceNode, { ...baseMsg, text: "อยากรู้สเปค" }, {}).branch,
  "b1",
  "source=initial_message ไม่มี context → ใช้ msg.text"
);

// ─── 4. matchBranch — case-insensitive + whitespace ────────

console.log("\n=== 4. matchBranch (case + whitespace) ===");

const branchCI: ConditionBranch = { branch_id: "b1", match_type: "contains_any", keywords: ["YES", "OK"] };
// ⚠️ matchBranch รับ lowerText — caller ต้อง .toLowerCase() ก่อน (เหมือนใน evalMultiBranchCondition)
assert(matchBranch("yes", branchCI) === true, "contains_any: case-insensitive (yes vs YES) → true");
assert(matchBranch("yes".toLowerCase(), branchCI) === true, "contains_any: lowercase caller → true");
assert(matchBranch("ok", branchCI) === true, "contains_any: lowercase (ok vs OK) → true");
assert(matchBranch("ok".toLowerCase(), branchCI) === true, "contains_any: exact lowercase → true");
assert(matchBranch("no", branchCI) === false, "contains_any: ไม่ตรง → false");

const branchAll: ConditionBranch = { branch_id: "b2", match_type: "contains_all", keywords: ["สั่งซื้อ", "หัวชาร์จ"] };
assert(matchBranch("อยากสั่งซื้อหัวชาร์จ", branchAll) === true, "contains_all: มีครบ → true");
assert(matchBranch("อยากสั่งซื้อ", branchAll) === false, "contains_all: มีไม่ครบ → false");

const branchEq: ConditionBranch = { branch_id: "b3", match_type: "equals", keywords: ["ใช่"] };
assert(matchBranch("ใช่", branchEq) === true, "equals: ตรงเป๊ะ → true");
assert(matchBranch("ใช่ครับ", branchEq) === false, "equals: มีคำเพิ่ม → false");

// ─── 5. isPhase2WaitConfig — type guard edge cases ─────────

console.log("\n=== 5. isPhase2WaitConfig (type guard) ===");

assert(isPhase2WaitConfig({ answer_type: "any", max_retries: 3, timeout_ms: 60000 }) === true, "มี answer_type → true");
assert(isPhase2WaitConfig({ answer_type: "number", max_retries: 0, timeout_ms: 1000 }) === true, "answer_type=number → true");
assert(isPhase2WaitConfig({ answer_type: "custom_keywords", custom_keywords: ["a"], max_retries: 1, timeout_ms: 5000 }) === true, "answer_type=custom_keywords → true");
assert(isPhase2WaitConfig({}) === false, "object ว่าง → false");
assert(isPhase2WaitConfig(null) === false, "null → false");
assert(isPhase2WaitConfig(undefined) === false, "undefined → false");
assert(isPhase2WaitConfig({ max_retries: 3 }) === false, "ไม่มี answer_type → false");
assert(isPhase2WaitConfig({ answer_type: 123 }) === false, "answer_type ไม่ใช่ string → false");

// ─── 6. resolveTemplate — Phase 4 edge cases ───────────────

console.log("\n=== 6. resolveTemplate (Phase 4 edge cases) ===");

assertEqual(
  resolveTemplate("สวัสดี {{customerName}}", { customerName: "คุณสมชาย" }),
  "สวัสดี คุณสมชาย",
  "resolve: แทนตัวแปรเดียว"
);
assertEqual(
  resolveTemplate("{{customerName}} สนใจ {{productName}}", { customerName: "คุณสม", productName: "หัวชาร์จ" }),
  "คุณสม สนใจ หัวชาร์จ",
  "resolve: หลายตัวแปร"
);
assertEqual(
  resolveTemplate("ไม่มีตัวแปร", {}),
  "ไม่มีตัวแปร",
  "resolve: ไม่มี {{}} → คืนเดิม"
);
assertEqual(
  resolveTemplate("สวัสดี {{unknownVar}}", {}),
  "สวัสดี ",
  "resolve: var ไม่รู้จัก → แทนค่าว่าง"
);
assertEqual(
  resolveTemplate("", { customerName: "a" }),
  "",
  "resolve: text ว่าง → ว่าง"
);
assertEqual(
  resolveTemplate("{{customerName}}", { customerName: "" }),
  "",
  "resolve: var เป็นค่าว่าง → ว่าง"
);
assertEqual(
  resolveTemplate("{{CustomerName}}", { customername: "a" }),
  "a",
  "resolve: case-insensitive"
);
assertEqual(
  resolveTemplate("ราคา {{price}} บาท", { price: "299" }),
  "ราคา 299 บาท",
  "resolve: ตัวเลขเป็น string"
);

// hasTemplateVariables + extractTemplateVariables
assert(hasTemplateVariables("{{name}}") === true, "hasTemplate: มี → true");
assert(hasTemplateVariables("no vars") === false, "hasTemplate: ไม่มี → false");
assert(hasTemplateVariables("") === false, "hasTemplate: ว่าง → false");
assertEqual(
  extractTemplateVariables("{{a}} {{b}} {{a}}"),
  ["a", "b"],
  "extract: dedupe + ดึงชื่อทั้งหมด"
);
assertEqual(
  extractTemplateVariables("no vars"),
  [],
  "extract: ไม่มี → []"
);

// ─── 7. isPhase3AddLabelConfig + isMultiBranchCondition ────

console.log("\n=== 7. isPhase3AddLabelConfig + isMultiBranchCondition ===");

assert(isPhase3AddLabelConfig({ label_ids: ["l1", "l2"] }) === true, "addLabel: มี label_ids → true");
assert(isPhase3AddLabelConfig({ label_ids: [] }) === true, "addLabel: label_ids ว่าง → true");
assert(isPhase3AddLabelConfig({ label: "old" }) === false, "addLabel: legacy { label } → false");
assert(isPhase3AddLabelConfig({}) === false, "addLabel: ว่าง → false");
assert(isPhase3AddLabelConfig(null) === false, "addLabel: null → false");

assert(isMultiBranchCondition({
  source: "customer_reply",
  branches: [{ branch_id: "b1", match_type: "contains_any", keywords: ["a"] }],
  fallback_branch_id: "fb",
}) === true, "multiBranch: ครบ → true");
assert(isMultiBranchCondition({ branches: [] }) === false, "multiBranch: ไม่มี branches → false");
assert(isMultiBranchCondition({}) === false, "multiBranch: ว่าง → false");
assert(isMultiBranchCondition(null) === false, "multiBranch: null → false");

// ─── Summary ───────────────────────────────────────────────

console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  process.exit(1);
}
