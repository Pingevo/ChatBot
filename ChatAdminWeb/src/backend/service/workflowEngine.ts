// Workflow Engine — รัน flow + resume + eval condition + ทำ action
// (แบบ Zaapi Flow Builder — อ้างอิง workflow-planner.md)
//
// Pipeline ที่เสียบใน processMessage:
//   ① Active Flow Resume (เสมอ ไม่สน priority)
//   ② Priority (workflow_first / trigger_first / both)
//   ③ บอท (เหมือนเดิม — engine ไม่แตะ pipeline ของบอท)
//
// ⚠️ SAFETY:
//   - ไม่ call platform API (Shopee/TikTok/Lazada) ใดๆ
//   - คำตอบ/ข้อความที่ flow ส่ง → ส่งกลับให้ caller เป็น delivered[]
//     worker path: caller เก็บลง shadow_replies / test chat path: caller ส่งกลับ client render
//   - send_http ผ่าน isSafeFetchUrl (SSRF guard) เหมือน systemConfigService
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { getSystemConfig, type Platform } from "./systemConfigService";
import { workflowService, type WorkflowDoc, type WorkflowNode, isMultiBranchCondition, type ConditionBranch, isPhase2WaitConfig, type WaitForReplyConfig, WAIT_BRANCH, isPhase3AddLabelConfig } from "./workflowService";
import { callBot } from "./botCallService";
import { getConversation, closeConversation, type ProblemCategory } from "./conversationService";
import { resolveTemplate, type TemplateVars } from "./templateService";
import { getHistoryForBot } from "./messageService";
import { handoffService } from "./handoffService";
import { getCustomer } from "./customerService";
import { logAdminEvent } from "./adminLogService";
import { isSafeFetchUrl } from "../lib/urlSafety";

// ─── Types ────────────────────────────────────────────────

export interface WorkflowRunDoc extends Document {
  run_id: string;
  workflow_id: string;
  workflow_version: number;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  customer_id?: string;

  status: "running" | "waiting_for_reply" | "completed" | "cancelled" | "errored";
  current_node_id: string;        // node ที่กำลังอยู่ / รออยู่
  waiting_for?: "next_message";

  // ⚡ Phase 2 — wait_for_reply retry/timeout state
  wait_retry_count?: number;      // จำนวนครั้งที่ถามซ้ำ (reset ทุกครั้งที่เข้า wait node ใหม่)
  wait_started_at?: Date;         // เวลาที่เริ่มรอล่าสุด (สำหรับ per-node timeout)
  wait_node_id?: string;          // wait node ที่กำลังรออยู่ (สำหรับ background checker)

  // ตัวแปรสะสมระหว่าง node (เช่น bot_answer, customer_reply, _jumps)
  context: Record<string, unknown>;

  // ผลลัพธ์สุดท้าย
  outcome?: "actioned" | "no_match" | "condition_false" | "error" | "timeout" | "cancelled_by_admin" | "retry_exceeded" | "no_reply";

  started_at: Date;
  updated_at: Date;
  completed_at?: Date;
  error?: string;
}

export interface EngineMessage {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  customer_id?: string;
  // history สำหรับ let_ai_respond — ถ้าไม่ส่งมา engine ดึงเองจาก messages (worker path)
  history?: { role: "user" | "model"; text: string }[];
}

export interface DeliveredMessage {
  text: string;
  source: string;    // "workflow.send_message" | "workflow.let_ai_respond" | "workflow.stay_retry"
  node_id: string;
}

export interface EngineResult {
  status: "actioned" | "resumed" | "no_match" | "exit_to_bot" | "exit_drop" | "error";
  detail: string;
  delivered: DeliveredMessage[];
  run_id?: string;
  workflow_id?: string;
  handoff?: { agentId: string | null; reason: string };
}

// ─── Constants ─────────────────────────────────────────────

// กัน infinite loop จาก jump_to / graph พัง — จบที่ 50 steps
const MAX_ENGINE_STEPS = 50;
const DEFAULT_STAY_RETRY_MESSAGE = "รบกวนพิมพ์ตอบตามหัวข้อที่ถามนะคะ เพื่อให้เราช่วยได้ถูกต้องค่ะ";

function genRunId(): string {
  return "wfr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── Run CRUD helpers ─────────────────────────────────────

async function getRunsCollection() {
  return getCollection<WorkflowRunDoc>(COLLECTIONS.workflowRuns);
}

async function updateRun(runId: string, fields: Partial<WorkflowRunDoc>): Promise<void> {
  const coll = await getRunsCollection();
  await coll.updateOne(
    { run_id: runId },
    { $set: { ...fields, updated_at: new Date() } }
  );
}

// ─── ① Active Flow Resume ─────────────────────────────────

/**
 * หา run ที่กำลังรัน/รอ reply ของ conversation นี้
 * - ถ้า run รอ reply เกิน workflow_run_timeout_ms → cancel (outcome: timeout) → return null
 * - Admin รับแชทแล้ว → caller เรียก cancelActiveRuns ก่อน (ดู processMessage integration)
 */
export async function getActiveRun(conversationId: string): Promise<WorkflowRunDoc | null> {
  const coll = await getRunsCollection();
  const run = await coll.findOne({
    conversation_id: conversationId,
    status: { $in: ["running", "waiting_for_reply"] },
  });

  if (!run) return null;

  // Timeout check — flow รอ reply เกิน workflow_run_timeout_ms → cancel อัตโนมัติ
  const config = await getSystemConfig();
  const timeoutMs = config.workflow_run_timeout_ms || 1800000;
  const ageMs = Date.now() - run.updated_at.getTime();
  if (ageMs > timeoutMs) {
    await updateRun(run.run_id, {
      status: "cancelled",
      outcome: "timeout",
      completed_at: new Date(),
      error: `run timed out after ${Math.floor(ageMs / 1000)}s (limit ${Math.floor(timeoutMs / 1000)}s)`,
    });
    await logAdminEvent({
      action_type: "workflow.run_timeout",
      actor: "workflow-engine",
      conversation_id: conversationId,
      metadata: { run_id: run.run_id, workflow_id: run.workflow_id, age_ms: ageMs },
    });
    return null;
  }

  return run;
}

/** Cancel run ที่กำลังรัน/รอ reply ทั้งหมดของ conversation — ใช้ตอน admin รับแชท */
export async function cancelActiveRuns(conversationId: string, reason: string): Promise<number> {
  const coll = await getRunsCollection();
  const result = await coll.updateMany(
    {
      conversation_id: conversationId,
      status: { $in: ["running", "waiting_for_reply"] },
    },
    {
      $set: {
        status: "cancelled",
        outcome: "cancelled_by_admin",
        completed_at: new Date(),
        error: reason,
        updated_at: new Date(),
      },
    }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "workflow.run_cancelled",
      actor: "workflow-engine",
      conversation_id: conversationId,
      metadata: { reason, cancelled_count: result.modifiedCount },
    });
  }
  return result.modifiedCount;
}

// ─── ② Match + Run ─────────────────────────────────────────

/** เช็ค trigger_frequency — เคยรันจบแล้วไหม */
async function checkTriggerFrequency(workflow: WorkflowDoc, msg: EngineMessage): Promise<boolean> {
  if (workflow.trigger_frequency === "every_time") return true;

  const coll = await getRunsCollection();
  const completedFilter: Record<string, unknown> = {
    workflow_id: workflow.workflow_id,
    status: "completed",
  };
  if (workflow.trigger_frequency === "once_per_conversation") {
    completedFilter.conversation_id = msg.conversation_id;
  } else if (workflow.trigger_frequency === "once_per_customer") {
    // ไม่มี customer_id (เช่น test chat) → fallback เป็น per-conversation
    completedFilter.conversation_id = msg.conversation_id;
    if (msg.customer_id) completedFilter.customer_id = msg.customer_id;
  }
  const existing = await coll.findOne(completedFilter);
  return !existing; // ยังไม่เคยจบ → รันได้
}

/** แมทช์ trigger node ของ workflow กับข้อความ (substring เหมือน triggerService) */
function matchTriggerNode(node: WorkflowNode, text: string): boolean {
  const keywords = Array.isArray(node.config.keywords) ? (node.config.keywords as string[]) : [];
  if (keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => typeof k === "string" && k.trim().length > 0 && lower.includes(k.toLowerCase()));
}

/**
 * หา workflow ที่แมทช์ (enabled + published + shop/platform + keyword) แล้วรัน
 * หลาย flow ฮิตพร้อมกัน → เรียงตาม priority แล้ว created_at (listWorkflows sort แล้ว)
 */
export async function matchAndRun(msg: EngineMessage): Promise<EngineResult> {
  const config = await getSystemConfig();
  if (!config.workflow_enabled) {
    return { status: "no_match", detail: "workflow engine disabled", delivered: [] };
  }

  const workflows = await workflowService.listWorkflows({
    shopId: msg.shop_id,
    platform: msg.platform,
    enabledOnly: true,
    publishedOnly: true,
  });

  for (const wf of workflows) {
    const triggerNode = wf.nodes.find((n) => n.type === "trigger");
    if (!triggerNode) continue;
    if (!matchTriggerNode(triggerNode, msg.text)) continue;

    // ผ่าน keyword → เช็ค trigger_frequency
    if (!(await checkTriggerFrequency(wf, msg))) continue;

    // สร้าง run แล้วเริ่มเดิน graph
    const run = await createRun(wf, msg);
    return runFlow(wf, run, msg);
  }

  return { status: "no_match", detail: "no workflow matched", delivered: [] };
}

async function createRun(workflow: WorkflowDoc, msg: EngineMessage): Promise<WorkflowRunDoc> {
  const coll = await getRunsCollection();
  const now = new Date();
  const run: WorkflowRunDoc = {
    run_id: genRunId(),
    workflow_id: workflow.workflow_id,
    workflow_version: workflow.version,
    conversation_id: msg.conversation_id,
    shop_id: msg.shop_id,
    platform: msg.platform,
    customer_id: msg.customer_id,
    status: "running",
    current_node_id: "",
    context: {},
    started_at: now,
    updated_at: now,
  };
  await coll.insertOne(run);
  return run;
}

// ─── Graph walking ─────────────────────────────────────────

function nextNodeIds(workflow: WorkflowDoc, nodeId: string, branch?: string): string[] {
  return workflow.edges
    .filter((e) => e.source_node_id === nodeId && (branch === undefined || e.branch === branch))
    .map((e) => e.target_node_id);
}

/** เดิน graph จาก current node — ทำ action/eval condition จนเจอ wait หรือจบ */
async function walkGraph(
  workflow: WorkflowDoc,
  run: WorkflowRunDoc,
  msg: EngineMessage,
  startNodeId: string
): Promise<EngineResult> {
  const delivered: DeliveredMessage[] = [];
  const context: Record<string, unknown> = { ...run.context };
  let currentNodeId = startNodeId;
  let steps = 0;
  let handoff: { agentId: string | null; reason: string } | undefined;

  while (currentNodeId && steps < MAX_ENGINE_STEPS) {
    steps++;
    const node = workflow.nodes.find((n) => n.node_id === currentNodeId);
    if (!node) {
      // Graph พัง — อ้าง node ที่ไม่มีอยู่
      await failRun(run, `node ${currentNodeId} not found in workflow`);
      return { status: "error", detail: `node ${currentNodeId} not found`, delivered, run_id: run.run_id, workflow_id: workflow.workflow_id };
    }

    // ── trigger node → ไป node ถัดไปตาม edge ──
    if (node.type === "trigger") {
      const next = nextNodeIds(workflow, node.node_id);
      if (next.length === 0) {
        return await completeRun(workflow, run, context, delivered, "actioned", "trigger node has no outgoing edge — flow ends");
      }
      currentNodeId = next[0];
      continue;
    }

    // ── action node → ทำ action → ไป node ถัดไป ──
    if (node.type === "action") {
      const actionResult = await performAction(workflow, run, node, msg, context, delivered);
      if (actionResult.handoff) handoff = actionResult.handoff;
      if (actionResult.stop) {
        // action สั่งจบ flow (close_ticket / assign แล้วจบ)
        return await completeRun(workflow, run, context, delivered, "actioned", `stopped at action ${node.subtype}`, handoff);
      }
      // ⚡ jump_to — action ตั้ง context._jump_target → กระโดดไป node นั้น (วนกลับได้)
      const jumpTarget = context._jump_target;
      if (typeof jumpTarget === "string" && jumpTarget) {
        delete context._jump_target;
        currentNodeId = jumpTarget;
        continue;
      }
      const next = nextNodeIds(workflow, node.node_id);
      if (next.length === 0) {
        return await completeRun(workflow, run, context, delivered, "actioned", `action ${node.subtype} done — flow ends`, handoff);
      }
      currentNodeId = next[0];
      continue;
    }

    // ── condition node → eval → ไปตาม branch ──
    // ⚡ Phase 1: branch เป็น generic string (รองรับ multi-branch + legacy true/false)
    if (node.type === "condition") {
      const condResult = await evalCondition(workflow, node, msg, context);
      if (condResult.error) {
        await failRun(run, `condition ${node.subtype} error: ${condResult.error}`);
        return { status: "error", detail: condResult.error, delivered, run_id: run.run_id, workflow_id: workflow.workflow_id };
      }

      const branch = condResult.branch;
      const branchTargets = nextNodeIds(workflow, node.node_id, branch);

      if (branchTargets.length > 0) {
        currentNodeId = branchTargets[0];
        continue;
      }

      // ⚡ ไม่มี edge ของ branch ที่ match:
      //   - legacy "false" และไม่มี false edge → ใช้ false_branch_policy
      //   - multi-branch หรือ legacy "true" ไม่มี edge → จบ flow (graph ไม่สมบูรณ์)
      if (branch === "false") {
        return await handleFalseBranch(workflow, run, node, msg, context, delivered);
      }
      return await completeRun(workflow, run, context, delivered, "condition_false", `condition branch "${branch}" has no outgoing edge from ${node.node_id}`);
    }

    // ── wait node → หยุด รอลูกค้าพิมพ์ต่อ ──
    if (node.type === "wait" && node.subtype === "wait_for_reply") {
      const now = new Date();
      // ⚡ Phase 2: ถ้ามี Phase 2 config → เก็บ wait state เพิ่ม (retry_count, started_at, node_id)
      if (isPhase2WaitConfig(node.config)) {
        await updateRun(run.run_id, {
          status: "waiting_for_reply",
          current_node_id: node.node_id,
          waiting_for: "next_message",
          context,
          wait_retry_count: 0,
          wait_started_at: now,
          wait_node_id: node.node_id,
        });
      } else {
        // legacy — รอ reply เดียว + global timeout
        await updateRun(run.run_id, {
          status: "waiting_for_reply",
          current_node_id: node.node_id,
          waiting_for: "next_message",
          context,
        });
      }
      return {
        status: "actioned",
        detail: `waiting for reply at node ${node.node_id}`,
        delivered,
        run_id: run.run_id,
        workflow_id: workflow.workflow_id,
        handoff,
      };
    }

    // unknown node type → จบ
    await failRun(run, `unknown node type ${node.type}/${node.subtype}`);
    return { status: "error", detail: `unknown node type ${node.type}`, delivered, run_id: run.run_id, workflow_id: workflow.workflow_id };
  }

  // เกิน MAX_ENGINE_STEPS — กัน infinite loop (jump_to วนไม่รู้จบ)
  await failRun(run, `exceeded ${MAX_ENGINE_STEPS} steps — possible jump_to loop`);
  return { status: "error", detail: "max steps exceeded", delivered, run_id: run.run_id, workflow_id: workflow.workflow_id };
}

// ─── runFlow / resumeFlow ──────────────────────────────────

/** เริ่มเดิน graph จาก trigger node */
async function runFlow(workflow: WorkflowDoc, run: WorkflowRunDoc, msg: EngineMessage): Promise<EngineResult> {
  const triggerNode = workflow.nodes.find((n) => n.type === "trigger");
  if (!triggerNode) {
    await failRun(run, "workflow has no trigger node");
    return { status: "error", detail: "no trigger node", delivered: [], run_id: run.run_id, workflow_id: workflow.workflow_id };
  }
  // เก็บข้อความตั้งต้นลง context
  const context = { ...run.context, initial_message: msg.text };
  await updateRun(run.run_id, { context });
  run.context = context;
  return walkGraph(workflow, run, msg, triggerNode.node_id);
}

/**
 * Resume flow จาก wait node — ลูกค้าพิมพ์ต่อ
 * ป้อนข้อความใหม่เข้า context.customer_reply แล้วเดินต่อจาก node ถัดไปของ wait
 */
export async function resumeFlow(run: WorkflowRunDoc, msg: EngineMessage): Promise<EngineResult> {
  const workflow = await workflowService.getWorkflow(run.workflow_id);
  if (!workflow) {
    await failRun(run, "workflow deleted while run active");
    return { status: "error", detail: "workflow not found", delivered: [], run_id: run.run_id };
  }

  // ป้อนข้อความใหม่เข้า context
  const context = { ...run.context, customer_reply: msg.text };
  await updateRun(run.run_id, { status: "running", context, waiting_for: undefined });
  run.context = context;

  const waitNode = workflow.nodes.find((n) => n.node_id === run.current_node_id);
  if (!waitNode || waitNode.type !== "wait") {
    // current_node_id ไม่ใช่ wait node (ข้อมูลพัง) → จบ run
    await failRun(run, `current node ${run.current_node_id} is not a wait node`);
    return { status: "error", detail: "cannot resume — not at wait node", delivered: [], run_id: run.run_id };
  }

  // ⚡ Phase 2: ถ้า wait node มี Phase 2 config → validate answer_type → success/retry/exceeded
  if (isPhase2WaitConfig(waitNode.config)) {
    return resumePhase2Wait(workflow, run, waitNode, msg, context);
  }

  // legacy — เดินต่อจาก node ถัดไปของ wait
  const next = nextNodeIds(workflow, waitNode.node_id);
  if (next.length === 0) {
    return await completeRun(workflow, run, context, [], "actioned", "wait node has no outgoing edge — flow ends");
  }
  const result = await walkGraph(workflow, { ...run, context }, msg, next[0]);
  return { ...result, status: result.status === "actioned" ? "resumed" : result.status };
}

// ─── Phase 2 — wait_for_reply resume with retry/timeout ──

/** validate คำตอบตาม answer_type */
export function validateWaitAnswer(text: string, cfg: WaitForReplyConfig): boolean {
  const t = text.trim();
  if (!t) return false;
  switch (cfg.answer_type) {
    case "any":
      return true; // อะไรก็ได้
    case "number": {
      // ต้องเป็นตัวเลข (อนุญาตจุดทศนิยม + จุลภาคไทย)
      return /^[0-9]+([.,][0-9]+)?$/.test(t.replace(/\s/g, ""));
    }
    case "custom_keywords": {
      const kws = (cfg.custom_keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean);
      if (kws.length === 0) return true; // ไม่กำหนด keyword → อะไรก็ได้
      const lower = t.toLowerCase();
      return kws.some((k) => lower.includes(k));
    }
    default:
      return true;
  }
}

/** resume Phase 2 wait — validate answer → success / retry / retry_exceeded */
async function resumePhase2Wait(
  workflow: WorkflowDoc,
  run: WorkflowRunDoc,
  waitNode: WorkflowNode,
  msg: EngineMessage,
  context: Record<string, unknown>
): Promise<EngineResult> {
  const cfg = waitNode.config as unknown as WaitForReplyConfig;
  const maxRetries = Math.max(0, Number(cfg.max_retries ?? 3));
  const currentRetry = Number(run.wait_retry_count || 0);
  const delivered: DeliveredMessage[] = [];

  // validate คำตอบ
  const isValid = validateWaitAnswer(msg.text, cfg);

  if (isValid) {
    // ✅ ผ่าน → branch "success" → เดินต่อ
    const next = nextNodeIds(workflow, waitNode.node_id, WAIT_BRANCH.SUCCESS);
    // ล้าง wait state
    await updateRun(run.run_id, {
      wait_retry_count: 0,
      wait_started_at: undefined,
      wait_node_id: undefined,
    });
    if (next.length === 0) {
      // ไม่มี success edge → ใช้ edge เดี่ยว (legacy compat) หรือจบ
      const fallback = nextNodeIds(workflow, waitNode.node_id);
      if (fallback.length === 0) {
        return await completeRun(workflow, run, context, delivered, "actioned", "wait success but no outgoing edge — flow ends");
      }
      const result = await walkGraph(workflow, { ...run, context }, msg, fallback[0]);
      return { ...result, status: result.status === "actioned" ? "resumed" : result.status };
    }
    const result = await walkGraph(workflow, { ...run, context }, msg, next[0]);
    return { ...result, status: result.status === "actioned" ? "resumed" : result.status };
  }

  // ❌ ไม่ผ่าน → เช็ค retry
  if (currentRetry < maxRetries) {
    // ยังเหลือ retry → ส่ง retry_message + คง waiting_for_reply
    const retryText = (typeof cfg.retry_message === "string" && cfg.retry_message.trim())
      ? cfg.retry_message
      : DEFAULT_STAY_RETRY_MESSAGE;
    delivered.push({ text: retryText, source: "workflow.wait_retry", node_id: waitNode.node_id });
    await updateRun(run.run_id, {
      status: "waiting_for_reply",
      waiting_for: "next_message",
      wait_retry_count: currentRetry + 1,
      wait_started_at: new Date(), // reset timeout clock
      context,
    });
    await logAdminEvent({
      action_type: "workflow.wait_retry",
      actor: "workflow-engine",
      conversation_id: run.conversation_id,
      metadata: { run_id: run.run_id, workflow_id: workflow.workflow_id, retry_count: currentRetry + 1, max_retries: maxRetries },
    });
    return {
      status: "resumed",
      detail: `wait retry ${currentRetry + 1}/${maxRetries} — answer invalid, asking again`,
      delivered,
      run_id: run.run_id,
      workflow_id: workflow.workflow_id,
    };
  }

  // ❌ retry ครบแล้ว → branch "retry_exceeded"
  await updateRun(run.run_id, {
    wait_retry_count: 0,
    wait_started_at: undefined,
    wait_node_id: undefined,
  });
  const exceededNext = nextNodeIds(workflow, waitNode.node_id, WAIT_BRANCH.RETRY_EXCEEDED);
  if (exceededNext.length > 0) {
    const result = await walkGraph(workflow, { ...run, context }, msg, exceededNext[0]);
    return { ...result, status: result.status === "actioned" ? "resumed" : result.status };
  }
  // ไม่มี retry_exceeded edge → จบ flow
  return await completeRun(workflow, run, context, delivered, "retry_exceeded", `wait retry exceeded ${maxRetries} — no retry_exceeded edge, flow ends`);
}

// ─── false_branch_policy ───────────────────────────────────

async function handleFalseBranch(
  workflow: WorkflowDoc,
  run: WorkflowRunDoc,
  node: WorkflowNode,
  msg: EngineMessage,
  context: Record<string, unknown>,
  delivered: DeliveredMessage[]
): Promise<EngineResult> {
  const policy = workflow.false_branch_policy || "exit_to_bot";

  if (policy === "exit_to_bot") {
    // cancel flow → ข้อความนี้ไป trigger/bot (caller ทำต่อ)
    await updateRun(run.run_id, {
      status: "cancelled",
      outcome: "condition_false",
      completed_at: new Date(),
      context,
    });
    return {
      status: "exit_to_bot",
      detail: `condition ${node.subtype} false → exit_to_bot (message goes to trigger/bot)`,
      delivered,
      run_id: run.run_id,
      workflow_id: workflow.workflow_id,
    };
  }

  if (policy === "exit_drop") {
    // cancel flow → ทิ้งข้อความ (บังคับให้ลูกค้าพิมพ์ใหม่)
    await updateRun(run.run_id, {
      status: "cancelled",
      outcome: "condition_false",
      completed_at: new Date(),
      context,
    });
    return {
      status: "exit_drop",
      detail: `condition ${node.subtype} false → exit_drop`,
      delivered,
      run_id: run.run_id,
      workflow_id: workflow.workflow_id,
    };
  }

  // stay_retry — ส่ง fixed msg → กลับ wait_for_reply
  const retryText =
    (typeof node.config.retry_message === "string" && node.config.retry_message.trim().length > 0
      ? node.config.retry_message
      : DEFAULT_STAY_RETRY_MESSAGE);
  delivered.push({ text: retryText, source: "workflow.stay_retry", node_id: node.node_id });
  const waitNode = workflow.nodes.find((n) => n.type === "wait" && n.subtype === "wait_for_reply");
  if (!waitNode) {
    // ไม่มี wait node ใน flow → fallback จบ flow แบบ condition_false
    await updateRun(run.run_id, {
      status: "cancelled",
      outcome: "condition_false",
      completed_at: new Date(),
      context,
    });
    return {
      status: "exit_to_bot",
      detail: "stay_retry but no wait node in flow → exit_to_bot",
      delivered,
      run_id: run.run_id,
      workflow_id: workflow.workflow_id,
    };
  }
  await updateRun(run.run_id, {
    status: "waiting_for_reply",
    current_node_id: waitNode.node_id,
    waiting_for: "next_message",
    context,
  });
  return {
    status: "actioned",
    detail: `condition false → stay_retry (back to wait ${waitNode.node_id})`,
    delivered,
    run_id: run.run_id,
    workflow_id: workflow.workflow_id,
  };
}

// ─── Run lifecycle helpers ─────────────────────────────────

async function completeRun(
  workflow: WorkflowDoc,
  run: WorkflowRunDoc,
  context: Record<string, unknown>,
  delivered: DeliveredMessage[],
  outcome: "actioned" | "condition_false" | "retry_exceeded" | "no_reply",
  detail: string,
  handoff?: { agentId: string | null; reason: string }
): Promise<EngineResult> {
  await updateRun(run.run_id, {
    status: "completed",
    outcome,
    completed_at: new Date(),
    context,
  });
  await logAdminEvent({
    action_type: "workflow.run_completed",
    actor: "workflow-engine",
    conversation_id: run.conversation_id,
    metadata: {
      run_id: run.run_id,
      workflow_id: workflow.workflow_id,
      outcome,
      delivered_count: delivered.length,
    },
  });
  return {
    status: "actioned",
    detail,
    delivered,
    run_id: run.run_id,
    workflow_id: workflow.workflow_id,
    handoff,
  };
}

async function failRun(run: WorkflowRunDoc, error: string): Promise<void> {
  await updateRun(run.run_id, {
    status: "errored",
    outcome: "error",
    completed_at: new Date(),
    error,
  });
  await logAdminEvent({
    action_type: "workflow.run_errored",
    actor: "workflow-engine",
    conversation_id: run.conversation_id,
    metadata: { run_id: run.run_id, workflow_id: run.workflow_id, error },
  });
}

// ─── Condition evaluation ──────────────────────────────────
// ⚡ Phase 1: คืน branch: string แทน value: boolean
//   - multi-branch message_content → คืน branch_id ที่ match หรือ fallback_branch_id
//   - legacy binary (conversation_status, business_hours, ...) → คืน "true" / "false"
//   walkGraph ใช้ branch นี้หา edge แบบ generic (edge.branch === branch)

async function evalCondition(
  workflow: WorkflowDoc,
  node: WorkflowNode,
  msg: EngineMessage,
  context: Record<string, unknown>
): Promise<{ branch: string; error?: string }> {
  try {
    // ⚡ multi-branch message_content (Zaapi pattern)
    if (node.subtype === "message_content" && isMultiBranchCondition(node.config)) {
      return evalMultiBranchCondition(node, msg, context);
    }

    // legacy binary conditions → คืน "true" / "false"
    const value = await evalLegacyCondition(node, msg, context);
    return { branch: value ? "true" : "false" };
  } catch (err) {
    return { branch: "false", error: (err as Error).message };
  }
}

/** multi-branch message_content — ไล่แต่ละ branch ตามลำดับ คืน branch_id แรกที่ match */
export function evalMultiBranchCondition(
  node: WorkflowNode,
  msg: EngineMessage,
  context: Record<string, unknown>
): { branch: string; error?: string } {
  // type guard อีกครั้งเพื่อ narrow type ภายใน function
  if (!isMultiBranchCondition(node.config)) {
    return { branch: "false", error: "config is not multi-branch" };
  }
  const cfg = node.config;
  // เลือก source ของข้อความ — default = customer_reply (ตอน resume) → initial_message → msg.text
  const source = cfg.source === "initial_message" ? "initial_message" : "customer_reply";
  const latestText = String(
    source === "initial_message"
      ? (context.initial_message || msg.text || "")
      : (context.customer_reply || context.initial_message || msg.text || "")
  );
  const lower = latestText.toLowerCase();

  for (const b of cfg.branches) {
    if (matchBranch(lower, b)) return { branch: b.branch_id };
  }
  return { branch: cfg.fallback_branch_id };
}

/** match keyword ตาม match_type */
export function matchBranch(lowerText: string, b: ConditionBranch): boolean {
  const kws = (b.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  if (kws.length === 0) return false;
  if (b.match_type === "contains_all") return kws.every((k) => lowerText.includes(k));
  if (b.match_type === "equals") return lowerText === kws[0];
  return kws.some((k) => lowerText.includes(k)); // contains_any (default)
}

/** legacy binary condition — คืน boolean (true/false) */
async function evalLegacyCondition(
  node: WorkflowNode,
  msg: EngineMessage,
  context: Record<string, unknown>
): Promise<boolean> {
  switch (node.subtype) {
    case "message_content": {
      // legacy binary: config = { mode, text }
      const latestText = String(context.customer_reply || context.initial_message || msg.text || "");
      const mode = String(node.config.mode || "contains");
      const text = String(node.config.text || "").toLowerCase();
      const lower = latestText.toLowerCase();
      if (mode === "equals") return lower === text;
      if (mode === "not_contains") return !lower.includes(text);
      return lower.includes(text); // contains (default)
    }

    case "conversation_status": {
      const conv = await getConversation(msg.conversation_id);
      if (!conv) return false;
      const wantStatus = String(node.config.status || "open");
      const isOpen = conv.status !== "closed" && conv.status !== "resolved";
      return wantStatus === "open" ? isOpen : !isOpen;
    }

    case "business_hours": {
      const startHour = Number(node.config.start_hour ?? 9);
      const endHour = Number(node.config.end_hour ?? 18);
      const timezone = String(node.config.timezone || "Asia/Bangkok");
      const now = new Date();
      const hourStr = now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: timezone });
      const hour = parseInt(hourStr, 10);
      if (startHour <= endHour) return hour >= startHour && hour < endHour;
      return hour >= startHour || hour < endHour;
    }

    case "new_vs_returning": {
      if (!msg.customer_id) return true;
      const customer = await getCustomer(msg.platform, msg.customer_id);
      if (!customer || !customer.last_active_at) return true;
      return false;
    }

    case "assignee": {
      const conv = await getConversation(msg.conversation_id);
      if (!conv) return false;
      const wantAdmin = node.config.admin_id ? String(node.config.admin_id) : null;
      if (wantAdmin) return conv.assigned_to === wantAdmin;
      return !!conv.assigned_to;
    }

    default:
      return false;
  }
}

// ─── Action execution ──────────────────────────────────────

// ─── Phase 4 — Template variable preparation ──────────────
// ⚡ ดึงข้อมูล customer/conversation ครั้งเดียว รวมเป็น vars dict
//    ส่งต่อให้ resolveTemplate (pure function ไม่ยิง DB)
//    ถ้าไม่มีข้อมูล → var เป็น undefined → resolveTemplate แทนด้วยค่าว่าง

async function prepareTemplateVars(
  msg: EngineMessage,
  context: Record<string, unknown>
): Promise<TemplateVars> {
  const vars: TemplateVars = {
    // จาก context (มีอยู่แล้ว — ไม่ต้อง query)
    botAnswer: typeof context.bot_answer === "string" ? context.bot_answer : undefined,
    customerReply: typeof context.customer_reply === "string" ? context.customer_reply : undefined,
    initialMessage: typeof context.initial_message === "string" ? context.initial_message : undefined,
    // จาก msg
    conversationId: msg.conversation_id,
    shopId: msg.shop_id,
    platform: msg.platform,
    integrationName: msg.platform, // alias
  };

  // ดึง customer name + shop name ครั้งเดียว (parallel)
  try {
    const [conv, customer] = await Promise.all([
      getConversation(msg.conversation_id),
      msg.customer_id ? getCustomer(msg.platform, msg.customer_id) : Promise.resolve(null),
    ]);

    if (conv) {
      vars.shopName = conv.shop_name;
      // to_name เป็น customer display name ใน conversation
      if (!vars.customerName && conv.to_name) {
        vars.customerName = conv.to_name;
      }
    }
    if (customer && customer.name) {
      vars.customerName = customer.name;
    }
  } catch {
    // ถ้า query ไม่ได้ → vars ที่ไม่มีค่าจะถูกแทนด้วยค่าว่างใน resolveTemplate
  }

  return vars;
}

async function performAction(
  workflow: WorkflowDoc,
  run: WorkflowRunDoc,
  node: WorkflowNode,
  msg: EngineMessage,
  context: Record<string, unknown>,
  delivered: DeliveredMessage[]
): Promise<{ stop?: boolean; handoff?: { agentId: string | null; reason: string } }> {
  const cfg = node.config || {};

  switch (node.subtype) {
    case "send_message": {
      // ⚡ Phase 4: resolve {{variable}} ก่อนส่ง
      const rawText = String(cfg.text || "");
      if (rawText) {
        const vars = await prepareTemplateVars(msg, context);
        const resolved = resolveTemplate(rawText, vars);
        delivered.push({ text: resolved, source: "workflow.send_message", node_id: node.node_id });
      }
      return {};
    }

    case "let_ai_respond": {
      // เรียกบอทตอบ → คำตอบเก็บใน context.bot_answer → ส่งต่อลูกค้า
      // ⚡ planner หลักการ: หลัง let_ai_respond → fixed follow-up ทำได้ทันทีเพราะ bot_answer อยู่ใน context
      const conv = await getConversation(msg.conversation_id);
      const shopName = conv?.shop_name || undefined;
      const history = msg.history || await getHistoryForBot({
        conversationId: msg.conversation_id,
        platform: msg.platform,
        maxMessages: 10,
      });
      const promptPrefix = typeof cfg.prompt === "string" && cfg.prompt.trim().length > 0 ? cfg.prompt.trim() + "\n" : "";
      const botResp = await callBot({
        platform: msg.platform,
        message: promptPrefix + msg.text,
        shopId: msg.shop_id,
        shopName,
        history,
      });
      context.bot_answer = botResp.answer;
      context.bot_source = botResp.source;
      context.bot_model = botResp.model;
      context.bot_products = botResp.products;
      if (botResp.answer) {
        delivered.push({ text: botResp.answer, source: "workflow.let_ai_respond", node_id: node.node_id });
      }
      return {};
    }

    case "assign_ticket": {
      // จ่ายงาน — ระบุ admin_id → assign ตรง / ไม่ระบุ → handoffService (คนเดิม → round-robin)
      const reason = String(cfg.reason || `workflow ${workflow.name}`);
      const wantAdmin = cfg.admin_id ? String(cfg.admin_id) : null;

      if (wantAdmin) {
        // assign ตรงแบบ (เหมือน Zaapi ที่เลือกคนได้)
        const coll = await getCollection<{ assigned_to: string | null }>(COLLECTIONS.conversations);
        await coll.updateOne(
          { conversation_id: msg.conversation_id },
          { $set: { assigned_to: wantAdmin, updated_at: new Date() } }
        );
        await logAdminEvent({
          action_type: "workflow.assign_ticket",
          actor: "workflow-engine",
          conversation_id: msg.conversation_id,
          metadata: { run_id: run.run_id, workflow_id: workflow.workflow_id, assigned_to: wantAdmin, direct: true },
        });
        return { handoff: { agentId: wantAdmin, reason } };
      }

      // auto — ใช้ handoffService (คนเดิม → last-reply → round-robin)
      const result = await handoffService.handoffToAdmin({
        conversationId: msg.conversation_id,
        shopId: msg.shop_id,
        platform: msg.platform,
        reason,
      });
      await logAdminEvent({
        action_type: "workflow.assign_ticket",
        actor: "workflow-engine",
        conversation_id: msg.conversation_id,
        metadata: { run_id: run.run_id, workflow_id: workflow.workflow_id, assigned_to: result.assignedTo, mode: "auto" },
      });
      return { handoff: { agentId: result.assignedTo, reason } };
    }

    case "add_label": {
      // ⚡ Phase 3: รองรับทั้ง legacy { label: string } และ { label_ids: string[] }
      const coll = await getCollection<{ labels?: string[] }>(COLLECTIONS.conversations);
      const labelsToAdd: string[] = [];

      if (isPhase3AddLabelConfig(cfg)) {
        // Phase 3 — label_ids array
        for (const lid of cfg.label_ids) {
          const trimmed = String(lid || "").trim();
          if (trimmed) labelsToAdd.push(trimmed);
        }
      } else {
        // legacy — single label string
        const label = String(cfg.label || "").trim();
        if (label) labelsToAdd.push(label);
      }

      if (labelsToAdd.length > 0) {
        // $addToSet แต่ละ label — ใช้ $each ทีเดียว (atomic)
        await coll.updateOne(
          { conversation_id: msg.conversation_id },
          { $addToSet: { labels: { $each: labelsToAdd } }, $set: { updated_at: new Date() } }
        );
        await logAdminEvent({
          action_type: "workflow.add_label",
          actor: "workflow-engine",
          conversation_id: msg.conversation_id,
          metadata: { run_id: run.run_id, workflow_id: workflow.workflow_id, labels: labelsToAdd },
        });
      }
      return {};
    }

    case "close_ticket": {
      // ปิดแชท — ใช้ conversationService.closeConversation (มี close_history + audit ในตัว)
      const closed = await closeConversation({
        conversationId: msg.conversation_id,
        closedBy: "workflow-engine",
        reason: String(cfg.reason || `workflow ${workflow.name}`),
        category: (String(cfg.category || "other") as ProblemCategory),
        resolution: String(cfg.resolution || "workflow auto-close"),
        note: cfg.note ? String(cfg.note) : undefined,
      });
      if (!closed) return {}; // test chat ไม่มี conv → ข้ามเงียบๆ (ไม่ fail flow)
      return { stop: true };
    }

    case "add_note": {
      // เพิ่ม note — เก็บใน admin_logs (audit trail)
      const text = String(cfg.text || "");
      if (text) {
        await logAdminEvent({
          action_type: "workflow.add_note",
          actor: "workflow-engine",
          conversation_id: msg.conversation_id,
          metadata: { run_id: run.run_id, workflow_id: workflow.workflow_id, note: text },
        });
      }
      return {};
    }

    case "send_http": {
      // webhook out — 🔒 SSRF guard ผ่าน isSafeFetchUrl เหมือน systemConfigService
      const url = String(cfg.url || "");
      const method = String(cfg.method || "POST").toUpperCase();
      if (!url) return {};
      const safe = isSafeFetchUrl(url);
      if (!safe.ok) {
        await logAdminEvent({
          action_type: "workflow.send_http_blocked",
          actor: "workflow-engine",
          conversation_id: msg.conversation_id,
          metadata: { run_id: run.run_id, url, reason: safe.reason },
        });
        return {}; // URL ไม่ปลอดภัย → ข้าม action (ไม่ fail flow ทั้งอัน)
      }
      try {
        const resp = await fetch(url, {
          method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
          headers: { "Content-Type": "application/json" },
          body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(cfg.body ?? {}),
          signal: AbortSignal.timeout(5000),
        });
        context[`http_${node.node_id}_status`] = resp.status;
      } catch (err) {
        context[`http_${node.node_id}_error`] = (err as Error).message;
      }
      return {};
    }

    case "jump_to": {
      // วนกลับ — เปลี่ยน node ถัดไปเป็น target (walkGraph รับ via context hack ด้านล่าง)
      // ⚠️ จริงๆ jump ทำงานใน walkGraph ผ่าน edge ปกติ — jump_to ใช้วิธี set context flag
      const target = String(cfg.target_node_id || "");
      const maxJumps = Number(cfg.max_jumps ?? 3);
      const jumps = Number(context._jumps || 0) + 1;
      context._jumps = jumps;
      if (jumps > maxJumps || !target || !workflow.nodes.some((n) => n.node_id === target)) {
        return {}; // เกิน max_jumps หรือ target ไม่มี → ไป node ถัดไปตาม edge ปกติ
      }
      context._jump_target = target;
      return {};
    }

    default:
      return {};
  }
}

// ─── Phase 2 — Background timeout checker ─────────────────
// ⚡ เรียกจาก bot-worker loop (ทุก cycle) เช็ค run ที่รอเกิน per-node timeout
//    → branch "no_reply" หรือ จบ flow ถ้าไม่มี no_reply edge
//    ใช้ index { status: 1 } และ { updated_at: -1 } ที่มีอยู่แล้ว
//    query: status=waiting_for_reply + wait_started_at มี + wait_started_at < now - timeout
//    ⚠️ race-safe: ใช้ $set status=running ก่อนเดิน graph (เหมือน resumeFlow)

export async function checkWaitTimeouts(): Promise<number> {
  const config = await getSystemConfig();
  if (!config.workflow_enabled) return 0;

  const coll = await getRunsCollection();
  const now = new Date();

  // หา run ที่รอเกิน per-node timeout — ใช้ wait_started_at (Phase 2)
  // ถ้าไม่มี wait_started_at (legacy) → ใช้ updated_at แทน + global workflow_run_timeout_ms
  const globalTimeoutMs = config.workflow_run_timeout_ms || 1800000;

  // query run ที่ status=waiting_for_reply และมี wait_started_at
  const candidates = await coll.find({
    status: "waiting_for_reply",
    wait_started_at: { $exists: true, $type: "date" },
  }).toArray();

  let processed = 0;
  for (const run of candidates) {
    if (!run.wait_started_at) continue;
    const ageMs = now.getTime() - run.wait_started_at.getTime();

    // หา wait node เพื่ออ่าน per-node timeout_ms
    const workflow = await workflowService.getWorkflow(run.workflow_id);
    if (!workflow) {
      // workflow ถูกลบ → cancel run
      await updateRun(run.run_id, { status: "cancelled", outcome: "cancelled_by_admin", completed_at: now, error: "workflow deleted" });
      continue;
    }
    const waitNode = workflow.nodes.find((n) => n.node_id === run.current_node_id && n.type === "wait");
    if (!waitNode || !isPhase2WaitConfig(waitNode.config)) continue;

    const cfg = waitNode.config as unknown as WaitForReplyConfig;
    const perNodeTimeout = Math.max(1000, Number(cfg.timeout_ms || 0));
    if (ageMs < perNodeTimeout) continue; // ยังไม่เกิน timeout

    // เกิน timeout → branch "no_reply"
    processed++;
    try {
      await processWaitTimeout(workflow, run);
    } catch (err) {
      await failRun(run, `wait timeout processing error: ${(err as Error).message}`);
    }
  }

  // legacy run (ไม่มี wait_started_at) → ใช้ getActiveRun ที่มีอยู่แล้วเช็ค global timeout
  // (getActiveRun ถูกเรียกตอน message เข้า ไม่ต้องเช็คตรงนี้)

  if (processed > 0) {
    await logAdminEvent({
      action_type: "workflow.wait_no_reply",
      actor: "workflow-engine",
      metadata: { processed, checked: candidates.length },
    });
  }
  return processed;
}

/** ประมวลผล wait timeout — branch "no_reply" หรือ จบ flow */
async function processWaitTimeout(workflow: WorkflowDoc, run: WorkflowRunDoc): Promise<void> {
  // ทำเครื่องหมายว่ากำลังประมวลผล (race-safe — กัน resume ซ้อน)
  await updateRun(run.run_id, { status: "running", waiting_for: undefined });

  const waitNode = workflow.nodes.find((n) => n.node_id === run.current_node_id);
  if (!waitNode) {
    await failRun(run, "wait node not found during timeout processing");
    return;
  }

  const noReplyNext = nextNodeIds(workflow, waitNode.node_id, WAIT_BRANCH.NO_REPLY);
  const delivered: DeliveredMessage[] = [];

  // ล้าง wait state
  await updateRun(run.run_id, {
    wait_retry_count: 0,
    wait_started_at: undefined,
    wait_node_id: undefined,
  });

  if (noReplyNext.length > 0) {
    // เดินตาม no_reply branch
    const dummyMsg: EngineMessage = {
      message_id: `timeout_${run.run_id}`,
      conversation_id: run.conversation_id,
      shop_id: run.shop_id,
      platform: run.platform,
      customer_id: run.customer_id,
      text: "",
    };
    await walkGraph(workflow, { ...run, context: { ...run.context, customer_reply: "" } }, dummyMsg, noReplyNext[0]);
  } else {
    // ไม่มี no_reply edge → จบ flow ด้วย outcome=no_reply
    await completeRun(workflow, run, run.context, delivered, "no_reply", `wait timeout (${run.wait_started_at?.toISOString()}) — no no_reply edge, flow ends`);
  }
}

export const workflowEngine = {
  getActiveRun,
  cancelActiveRuns,
  matchAndRun,
  resumeFlow,
  checkWaitTimeouts,
  validateWaitAnswer,
};
