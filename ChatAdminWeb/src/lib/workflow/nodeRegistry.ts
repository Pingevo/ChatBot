// Canonical Node Registry — single owner of workflow node metadata.
// Consumed by: palette rendering, platform filtering, inspector schema,
// import validation, publish-readiness validation and export mapping.
// No env, no Mongo, no React — safe for client/server/script use.

import type { WorkflowNode, WorkflowEdge, WorkflowNodeType } from "./graph";
import { isMultiBranchCondition, isPhase2WaitConfig } from "./graph";

// ─── Platform scope ───────────────────────────────────────
// Local runtime Platform = shopee|tiktok|lazada (systemConfigService).
// Zaapi programme scope adds facebook + line. This union is the registry-level
// platform vocabulary; it does NOT change runtime platform behaviour.
export type WorkflowPlatform = "shopee" | "tiktok" | "lazada" | "facebook" | "line";
export const WORKFLOW_PLATFORMS: WorkflowPlatform[] = ["facebook", "line", "tiktok", "shopee", "lazada"];
export const LOCAL_ENGINE_PLATFORMS: WorkflowPlatform[] = ["shopee", "tiktok", "lazada"];

export type NodeAvailability = "supported" | "requires_adapter" | "unavailable";
export type NodeFamily = "trigger" | "condition" | "action" | "utility";
export type IdempotencyClass = "read_only" | "deterministic" | "side_effecting" | "waiting";

export interface PlatformAvailability {
  state: NodeAvailability;
  reason?: string;
}

export interface NodeHandleDefinition {
  id: string;               // deterministic handle/branch id ("default", "condition-index-0", …)
  label?: string;
  /** ถ้ามี — จำนวน handle ขยายตาม config (เช่น "conditions" = ตามจำนวนเงื่อนไข) */
  dynamic?: "conditions" | "branches" | "buttons" | "paths";
}

export interface ConfigFieldDef {
  key: string;
  type: "string" | "string[]" | "number" | "boolean" | "select" | "branches" | "json" | "duration_ms";
  label?: string;
  enum?: string[];
  required?: boolean;
}

export interface ConfigSchema {
  fields: ConfigFieldDef[];
}

export type PlatformCapabilityRequirement =
  | "messaging.read" | "messaging.send" | "messaging.template"
  | "ticket.assign" | "ticket.label" | "ticket.note" | "ticket.close" | "ticket.field" | "ticket.read"
  | "review.read" | "review.reply" | "marketplace.order.read" | "marketplace.voucher"
  | "webhook.inbound" | "http.outbound" | "ai.respond" | "ai.sentiment"
  | "shopify.events" | "email.send" | "conversation.search";

export interface CanonicalNodeDefinition {
  type: string;                          // canonical type (= local subtype ถ้ามี executor)
  version: number;
  family: NodeFamily;
  label: string;
  description: string;
  configSchema: ConfigSchema;
  inputs: NodeHandleDefinition[];
  outputs: NodeHandleDefinition[];
  supportedPlatforms: WorkflowPlatform[];
  capabilities: PlatformCapabilityRequirement[];
  runtimeExecutor: string | null;        // เช่น "workflowEngine.performAction" — null = ยังไม่มี executor
  idempotencyClass: IdempotencyClass;
  availability: NodeAvailability;        // overall (best) state
  platformAvailability: Partial<Record<WorkflowPlatform, PlatformAvailability>>;
  /** Zaapi node `type` strings ที่ map เข้า canonical นี้ (import aliases) */
  zaapiTypes?: string[];
  /** editor node type (WorkflowNodeType) ที่ใช้ render บน canvas */
  editorType: WorkflowNodeType;
  icon?: string;                         // lucide icon name (display metadata)
}

// ─── Builders ─────────────────────────────────────────────
const IN = [{ id: "in" }];
const OUT = [{ id: "default" }];
const NO_MATCH = { id: "no-match" };

/** platform map helper — scope ทั้งหมด = requires_adapter เว้นระบุ */
function allScope(state: NodeAvailability, reason?: string): Record<WorkflowPlatform, PlatformAvailability> {
  const m = {} as Record<WorkflowPlatform, PlatformAvailability>;
  for (const p of WORKFLOW_PLATFORMS) m[p] = { state, reason };
  return m;
}
/** local executor: supported บน platform ที่ engine รันได้จริง, requires_adapter บน facebook/line */
function localPlatforms(): Record<WorkflowPlatform, PlatformAvailability> {
  const m = allScope("requires_adapter", "ยังไม่มี channel adapter สำหรับ platform นี้");
  for (const p of LOCAL_ENGINE_PLATFORMS) m[p] = { state: "supported" };
  return m;
}
/** marketplace/review: requires_adapter บน shopee/lazada, unavailable ที่อื่น */
function marketplacePlatforms(): Record<WorkflowPlatform, PlatformAvailability> {
  const m = allScope("unavailable", "marketplace node ใช้ได้เฉพาะ Shopee/Lazada");
  m.shopee = { state: "requires_adapter", reason: "ยังไม่มี marketplace adapter" };
  m.lazada = { state: "requires_adapter", reason: "ยังไม่มี marketplace adapter" };
  return m;
}
function unavailableAll(reason: string): Record<WorkflowPlatform, PlatformAvailability> {
  return allScope("unavailable", reason);
}

function def(partial: Omit<CanonicalNodeDefinition, "version" | "inputs" | "editorType">
  & { version?: number; inputs?: NodeHandleDefinition[]; editorType?: WorkflowNodeType }): CanonicalNodeDefinition {
  return { version: 1, inputs: IN, editorType: partial.family === "trigger" ? "trigger" : partial.family === "condition" ? "condition" : partial.family === "utility" ? "wait" : "action", ...partial };
}

// ─── Registry ─────────────────────────────────────────────
// canonical type → definition. `zaapiTypes` = import aliases (Zaapi type strings).
/** condition builder — dynamic outputs condition-index-N + no-match */
const dynCond = (d: Omit<CanonicalNodeDefinition, "version" | "inputs" | "editorType" | "outputs"> & { outputs?: NodeHandleDefinition[] }) =>
  def({ outputs: [{ id: "condition-index-*", dynamic: "conditions" }, NO_MATCH], ...d });

export const NODE_REGISTRY: readonly CanonicalNodeDefinition[] = [
  // ── Triggers ──
  def({ type: "message_received", family: "trigger", label: "Message Received", description: "เริ่ม flow เมื่อลูกค้าส่งข้อความเข้ามา", outputs: OUT, zaapiTypes: ["message_received"], icon: "MessageSquare",
    configSchema: { fields: [{ key: "trigger_once_per_conversation", type: "boolean" }, { key: "trigger_once_per_open", type: "boolean" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["messaging.read"], runtimeExecutor: "workflowEngine.matchAndRun", idempotencyClass: "read_only", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "label_added", family: "trigger", label: "Label Added", description: "เริ่ม flow เมื่อใส่ label ให้ ticket", outputs: OUT, zaapiTypes: ["label_added"], icon: "Tag",
    configSchema: { fields: [{ key: "label_ids", type: "string[]", required: true }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.label"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ไม่มี local trigger สำหรับ label events") }),
  def({ type: "label_removed", family: "trigger", label: "Label Removed", description: "เริ่ม flow เมื่อลบ label ออกจาก ticket", outputs: OUT, zaapiTypes: ["label_removed"], icon: "Tag",
    configSchema: { fields: [{ key: "label_ids", type: "string[]", required: true }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.label"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ไม่มี local trigger สำหรับ label events") }),
  def({ type: "line_friend_added", family: "trigger", label: "LINE Friend Added", description: "เริ่ม flow เมื่อมีคนเพิ่ม LINE OA เป็นเพื่อน", outputs: OUT, icon: "UserPlus",
    configSchema: { fields: [] },
    supportedPlatforms: ["line"], capabilities: ["messaging.read"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter",
    platformAvailability: { ...unavailableAll("เฉพาะ LINE"), line: { state: "requires_adapter", reason: "ยังไม่มี LINE adapter" } } }),
  def({ type: "data_collection_form_filled", family: "trigger", label: "Data Collection Form Filled", description: "เริ่ม flow เมื่อลูกค้ากรอกฟอร์มเสร็จ", outputs: OUT, icon: "ClipboardList",
    configSchema: { fields: [] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["messaging.read"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี form adapter") }),
  def({ type: "incoming_webhook", family: "trigger", label: "Incoming Webhook", description: "เริ่ม flow เมื่อระบบภายนอก POST เข้ามา", outputs: OUT, icon: "Webhook",
    configSchema: { fields: [{ key: "sample_json", type: "json" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["webhook.inbound"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี inbound webhook endpoint") }),
  // Shopify triggers (out of scope platform)
  ...["shopify_order_created", "shopify_order_fulfilled", "shopify_order_cancelled", "shopify_checkout_abandoned", "shopify_new_customer"].map((t) =>
    def({ type: t, family: "trigger", label: t.replace(/_/g, " "), description: "Shopify trigger — ต้องเชื่อม Shopify", outputs: OUT, icon: "ShoppingBag",
      configSchema: { fields: [] },
      supportedPlatforms: [], capabilities: ["shopify.events"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "unavailable", platformAvailability: unavailableAll("Shopify ไม่อยู่ใน platform scope") })),
  // Marketplace triggers (Shopee/Lazada)
  ...([["marketplace_review_added", "Marketplace Review Added"], ["marketplace_order_created", "Marketplace Order Created"], ["marketplace_order_shipped", "Marketplace Order Shipped"], ["marketplace_order_delivered", "Marketplace Order Delivered"], ["marketplace_order_delayed", "Marketplace Order Delayed"], ["marketplace_payment_reminder", "Marketplace Payment Reminder"], ["marketplace_order_cancelled", "Marketplace Order Cancelled"], ["marketplace_return_refund_requested", "Marketplace Return/Refund Requested"], ["marketplace_order_delivery_failed", "Marketplace Delivery Failed"], ["marketplace_order_confirm_receipt", "Marketplace Confirm Receipt"], ["marketplace_product_interest", "Marketplace Product Interest"]] as [string, string][]).map(([t, label]) =>
    def({ type: t, family: "trigger", label, description: "เริ่ม flow จาก marketplace event", outputs: OUT, zaapiTypes: [t], icon: "Store",
      configSchema: { fields: [{ key: "scope", type: "json" }, { key: "delay_ms", type: "duration_ms" }] },
      supportedPlatforms: ["shopee", "lazada"], capabilities: ["marketplace.order.read"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: marketplacePlatforms() })),
  // ── Conditions ── (dynamic outputs: condition-index-N + no-match หรือ local branches)
  dynCond({ type: "message_content", family: "condition", label: "Message Content", description: "ตรวจเนื้อหาข้อความล่าสุด", zaapiTypes: ["message_content"], icon: "FileText",
    configSchema: { fields: [{ key: "mode", type: "select", enum: ["contains", "equals", "not_contains"] }, { key: "text", type: "string" }, { key: "branches", type: "branches" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["messaging.read"], runtimeExecutor: "workflowEngine.evalMultiBranchCondition", idempotencyClass: "read_only", availability: "supported", platformAvailability: localPlatforms() }),
  dynCond({ type: "conversation_status", family: "condition", label: "Conversation Status", description: "ตรวจว่า ticket เปิดหรือปิด", icon: "Activity",
    configSchema: { fields: [{ key: "status", type: "select", enum: ["open", "closed"] }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.read"], runtimeExecutor: "workflowEngine.evalCondition", idempotencyClass: "read_only", availability: "supported", platformAvailability: localPlatforms() }),
  dynCond({ type: "business_hours", family: "condition", label: "Business Hours", description: "แยกเส้นทางตามเวลาทำการ", zaapiTypes: ["business_hours"], icon: "Clock",
    configSchema: { fields: [{ key: "conditions", type: "json" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.read"], runtimeExecutor: "workflowEngine.evalCondition", idempotencyClass: "read_only", availability: "supported", platformAvailability: localPlatforms() }),
  dynCond({ type: "new_vs_returning", family: "condition", label: "New vs Returning Customer", description: "แยกลูกค้าใหม่/ลูกค้าเดิม", icon: "Users",
    configSchema: { fields: [] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.read"], runtimeExecutor: "workflowEngine.evalCondition", idempotencyClass: "read_only", availability: "supported", platformAvailability: localPlatforms() }),
  dynCond({ type: "assignee", family: "condition", label: "Conversation Assignee", description: "ตรวจว่า ticket ถูกมอบหมายให้ใคร", zaapiTypes: ["conversation_assignee"], icon: "UserCheck",
    configSchema: { fields: [{ key: "assignee", type: "string" }, { key: "conditions", type: "json" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.read"], runtimeExecutor: "workflowEngine.evalCondition", idempotencyClass: "read_only", availability: "supported", platformAvailability: localPlatforms() }),
  dynCond({ type: "message_language", family: "condition", label: "Message Language", description: "ตรวจภาษาของข้อความขาเข้า", icon: "Languages",
    configSchema: { fields: [{ key: "languages", type: "string[]" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["messaging.read"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี language detection executor") }),
  dynCond({ type: "label", family: "condition", label: "Label", description: "ตรวจว่า ticket มี/ไม่มี label", zaapiTypes: ["label"], icon: "Tag",
    configSchema: { fields: [{ key: "conditions", type: "json" }, { key: "label_ids", type: "string[]" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.label", "ticket.read"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี label condition executor") }),
  dynCond({ type: "last_interaction", family: "condition", label: "Last Interaction", description: "เวลาผ่านไปนับจากข้อความล่าสุดของลูกค้า", zaapiTypes: ["last_interaction"], icon: "Timer",
    configSchema: { fields: [{ key: "conditions", type: "json" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.read"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี executor") }),
  dynCond({ type: "customer_waiting_time", family: "condition", label: "Customer Waiting Time", description: "ลูกค้ารอคำตอบนานเท่าไร", zaapiTypes: ["customer_waiting_time"], icon: "Hourglass",
    configSchema: { fields: [{ key: "conditions", type: "json" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.read"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี executor") }),
  dynCond({ type: "event_time", family: "condition", label: "Event Time", description: "ตรวจช่วงเวลาของ event", zaapiTypes: ["event_time"], icon: "CalendarClock",
    configSchema: { fields: [{ key: "conditions", type: "json" }, { key: "schedule", type: "json" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.read"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี executor") }),
  ...["shopify_order_amount", "shopify_order_products", "shopify_order_tags"].map((t) =>
    dynCond({ type: t, family: "condition", label: t.replace(/_/g, " "), description: "Shopify condition", icon: "ShoppingBag",
      configSchema: { fields: [{ key: "conditions", type: "json" }] },
      supportedPlatforms: [], capabilities: ["shopify.events"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "unavailable", platformAvailability: unavailableAll("Shopify ไม่อยู่ใน platform scope") })),
  ...([["review_rating", "Review Rating", ["review.read"]], ["ai_review_sentiment", "AI Review Sentiment", ["ai.sentiment", "review.read"]], ["ai_review_intent", "AI Review Intent Detection", ["ai.sentiment", "review.read"]], ["marketplace_products", "Marketplace Products", ["marketplace.order.read"]], ["marketplace_order_cancellation_reason", "Marketplace Cancellation Reason", ["marketplace.order.read"]], ["marketplace_order_return_refund_reason", "Marketplace Return/Refund Reason", ["marketplace.order.read"]]] as [string, string, PlatformCapabilityRequirement[]][]).map(([t, label, caps]) =>
    dynCond({ type: t, family: "condition", label: label as string, description: "marketplace/review condition", zaapiTypes: [t], icon: "Star",
      configSchema: { fields: [{ key: "conditions", type: "json" }] },
      supportedPlatforms: ["shopee", "lazada"], capabilities: caps as PlatformCapabilityRequirement[], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: marketplacePlatforms() })),
  // ── Actions ──
  def({ type: "send_message", family: "action", label: "Send Message", description: "ส่งข้อความในช่องทางเดิม", outputs: OUT, zaapiTypes: ["send_message"], icon: "Send",
    configSchema: { fields: [{ key: "text", type: "string", required: true }, { key: "content_type", type: "select", enum: ["text", "image", "video", "file", "carousel", "button_template"] }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["messaging.send"], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "side_effecting", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "send_button_template", family: "action", label: "Send Button Template", description: "ส่งข้อความพร้อมปุ่มให้กด", outputs: [{ id: "btn-template-condition-index-*", dynamic: "buttons" }, { id: "btn-template-expired" }, { id: "btn-template-none-selected" }], zaapiTypes: ["send_button_template"], icon: "MousePointerClick",
    configSchema: { fields: [{ key: "text", type: "string" }, { key: "buttons", type: "json" }, { key: "expire_ms", type: "duration_ms" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["messaging.template"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี button-template executor") }),
  def({ type: "send_whatsapp_template", family: "action", label: "Send WhatsApp Template", description: "ส่ง WhatsApp template ที่อนุมัติแล้ว", outputs: OUT, icon: "MessageCircle",
    configSchema: { fields: [{ key: "template_id", type: "string" }] },
    supportedPlatforms: [], capabilities: ["messaging.template"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "unavailable", platformAvailability: unavailableAll("WhatsApp ไม่อยู่ใน platform scope") }),
  def({ type: "send_email", family: "action", label: "Send Email", description: "ส่งอีเมลจากบัญชีที่เชื่อมไว้", outputs: OUT, icon: "Mail",
    configSchema: { fields: [{ key: "to", type: "string" }, { key: "subject", type: "string" }, { key: "body", type: "string" }] },
    supportedPlatforms: [], capabilities: ["email.send"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "unavailable", platformAvailability: unavailableAll("ยังไม่มี email connector") }),
  def({ type: "send_marketplace_private_reply", family: "action", label: "Send Marketplace Private Reply", description: "ส่ง DM ตอบรีวิว/คำถามบน marketplace", outputs: OUT, icon: "MessageSquare",
    configSchema: { fields: [{ key: "text", type: "string" }] },
    supportedPlatforms: ["shopee", "lazada"], capabilities: ["review.reply"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: marketplacePlatforms() }),
  def({ type: "send_marketplace_order_card", family: "action", label: "Send Marketplace Order Card", description: "ส่งการ์ดสรุปคำสั่งซื้อ", outputs: OUT, zaapiTypes: ["send_marketplace_order_card"], icon: "CreditCard",
    configSchema: { fields: [{ key: "order_ref", type: "string" }] },
    supportedPlatforms: ["shopee", "lazada"], capabilities: ["marketplace.order.read", "messaging.send"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: marketplacePlatforms() }),
  def({ type: "send_marketplace_voucher", family: "action", label: "Send Marketplace Voucher", description: "ส่ง voucher code ให้ผู้ซื้อ", outputs: OUT, icon: "Ticket",
    configSchema: { fields: [{ key: "voucher", type: "string" }] },
    supportedPlatforms: ["shopee", "lazada"], capabilities: ["marketplace.voucher"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: marketplacePlatforms() }),
  def({ type: "assign_ticket", family: "action", label: "Assign Ticket", description: "มอบหมาย ticket ให้ agent/team", outputs: OUT, zaapiTypes: ["chat_assign"], icon: "UserPlus",
    configSchema: { fields: [{ key: "assignee", type: "string" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.assign"], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "side_effecting", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "unassign_ticket", family: "action", label: "Unassign Ticket", description: "ยกเลิกการมอบหมาย ticket", outputs: OUT, zaapiTypes: ["chat_unassign"], icon: "UserMinus",
    configSchema: { fields: [] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.assign"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "local engine ยังไม่มี unassign action") }),
  def({ type: "add_label", family: "action", label: "Add Label", description: "ใส่ label ให้ ticket", outputs: OUT, zaapiTypes: ["add_label"], icon: "Tag",
    configSchema: { fields: [{ key: "label", type: "string" }, { key: "label_ids", type: "string[]" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.label"], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "side_effecting", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "remove_label", family: "action", label: "Remove Label", description: "ลบ label ออกจาก ticket", outputs: OUT, zaapiTypes: ["remove_label"], icon: "Tag",
    configSchema: { fields: [{ key: "label", type: "string" }, { key: "label_ids", type: "string[]" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.label"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "local engine ยังไม่มี remove_label action") }),
  def({ type: "close_ticket", family: "action", label: "Close Ticket", description: "ปิด ticket (resolve)", outputs: OUT, zaapiTypes: ["close_chat"], icon: "CheckCircle",
    configSchema: { fields: [] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.close"], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "side_effecting", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "mark_ticket_follow_up", family: "action", label: "Mark Ticket as Follow-up", description: "ทำเครื่องหมาย ticket เพื่อติดตามต่อ", outputs: OUT, icon: "Flag",
    configSchema: { fields: [] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.field"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี executor") }),
  def({ type: "add_note", family: "action", label: "Add Note to Ticket", description: "เพิ่มโน้ตภายในใน ticket", outputs: OUT, icon: "StickyNote",
    configSchema: { fields: [{ key: "note", type: "string", required: true }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.note"], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "side_effecting", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "mark_as_spam", family: "action", label: "Mark as Spam", description: "ย้าย ticket ไปกล่องสแปม", outputs: OUT, icon: "ShieldAlert",
    configSchema: { fields: [] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.field"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี executor") }),
  def({ type: "reply_to_review", family: "action", label: "Reply to Review", description: "ตอบรีวิวแบบสาธารณะ", outputs: OUT, zaapiTypes: ["reply_to_review"], icon: "Star",
    configSchema: { fields: [{ key: "text", type: "string" }] },
    supportedPlatforms: ["shopee", "lazada"], capabilities: ["review.reply"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: marketplacePlatforms() }),
  def({ type: "mark_review_as_follow_up", family: "action", label: "Mark Review as Follow-up", description: "ทำเครื่องหมายรีวิวเพื่อติดตามต่อ", outputs: OUT, zaapiTypes: ["mark_review_as_follow_up"], icon: "Flag",
    configSchema: { fields: [] },
    supportedPlatforms: ["shopee", "lazada"], capabilities: ["review.read"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: marketplacePlatforms() }),
  def({ type: "add_note_to_review", family: "action", label: "Add Note to Review", description: "เพิ่มโน้ตภายในให้รีวิว", outputs: OUT, zaapiTypes: ["add_note_to_review"], icon: "StickyNote",
    configSchema: { fields: [{ key: "text", type: "string" }] },
    supportedPlatforms: ["shopee", "lazada"], capabilities: ["review.read"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: marketplacePlatforms() }),
  def({ type: "let_ai_respond", family: "action", label: "Let AI Respond", description: "ส่งต่อการสนทนาให้ AI", outputs: [{ id: "ai-chatbot-escalate" }, { id: "ai-chatbot-timeout" }], zaapiTypes: ["chatbot"], icon: "Bot",
    configSchema: { fields: [{ key: "knowledge_scope", type: "string[]" }, { key: "timeout_ms", type: "duration_ms" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ai.respond"], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "side_effecting", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "send_http", family: "action", label: "Send HTTP Request", description: "ส่ง HTTP request ไประบบภายนอก", outputs: OUT, icon: "Globe",
    configSchema: { fields: [{ key: "method", type: "select", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, { key: "url", type: "string", required: true }, { key: "headers", type: "json" }, { key: "body", type: "json" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["http.outbound"], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "side_effecting", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "jump_to", family: "action", label: "Jump To", description: "วนกลับไปขั้นตอนก่อนหน้า", outputs: OUT, zaapiTypes: ["jump_to"], icon: "CornerUpLeft",
    configSchema: { fields: [{ key: "max_jumps", type: "number" }, { key: "target_node_id", type: "string" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: [], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "deterministic", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "set_ticket_field", family: "action", label: "Set Ticket Field", description: "ตั้งค่า field ของ ticket", outputs: OUT, zaapiTypes: ["set_ticket_field"], icon: "SlidersHorizontal",
    configSchema: { fields: [{ key: "field", type: "string" }, { key: "value", type: "string" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["ticket.field"], runtimeExecutor: null, idempotencyClass: "side_effecting", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี executor") }),
  // ── Utility ──
  def({ type: "wait_for_reply", family: "utility", label: "Wait for Reply", description: "หยุด flow รอลูกค้าตอบ", outputs: [{ id: "wfr-success" }, { id: "wfr-no-respond" }], zaapiTypes: ["wfr"], icon: "Timer",
    configSchema: { fields: [{ key: "answer_type", type: "select", enum: ["any", "number", "custom_keywords"] }, { key: "max_retries", type: "number" }, { key: "timeout_ms", type: "duration_ms" }, { key: "custom_keywords", type: "string[]" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["messaging.read"], runtimeExecutor: "workflowEngine.performAction", idempotencyClass: "waiting", availability: "supported", platformAvailability: localPlatforms() }),
  def({ type: "delay", family: "utility", label: "Delay", description: "หยุด flow ตามเวลาที่กำหนดแล้วทำต่อ", outputs: OUT, zaapiTypes: ["delay"], icon: "Clock",
    configSchema: { fields: [{ key: "delay_ms", type: "duration_ms", required: true }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: [], runtimeExecutor: null, idempotencyClass: "waiting", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "local engine ยังไม่มี fixed-delay node") }),
  def({ type: "randomizer", family: "utility", label: "Randomizer", description: "สุ่มแบ่งเส้นทางตามน้ำหนัก %", outputs: [{ id: "randomizer-path-*", dynamic: "paths" }], zaapiTypes: ["randomizer"], icon: "Shuffle",
    configSchema: { fields: [{ key: "paths", type: "json" }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: [], runtimeExecutor: null, idempotencyClass: "deterministic", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี executor") }),
  def({ type: "search_conversation", family: "utility", label: "Search Conversation", description: "ค้นหา ticket ที่มีอยู่แล้ว", outputs: [{ id: "found" }, { id: "not-found" }], icon: "Search",
    configSchema: { fields: [{ key: "search_by", type: "select", enum: ["conversation_id", "email", "phone"] }] },
    supportedPlatforms: WORKFLOW_PLATFORMS, capabilities: ["conversation.search"], runtimeExecutor: null, idempotencyClass: "read_only", availability: "requires_adapter", platformAvailability: allScope("requires_adapter", "ยังไม่มี executor") }),
];

// ─── Lookups ──────────────────────────────────────────────
const byType = new Map<string, CanonicalNodeDefinition>();
const byZaapi = new Map<string, CanonicalNodeDefinition>();
export const REGISTRY_ERRORS: string[] = [];
for (const d of NODE_REGISTRY) {
  if (byType.has(d.type)) REGISTRY_ERRORS.push(`duplicate node type "${d.type}"`);
  byType.set(d.type, d);
  for (const z of d.zaapiTypes || []) {
    if (byZaapi.has(z)) REGISTRY_ERRORS.push(`duplicate zaapiType "${z}" (${byZaapi.get(z)!.type} vs ${d.type})`);
    byZaapi.set(z, d);
  }
}

export function getNodeDef(type: string): CanonicalNodeDefinition | undefined {
  return byType.get(type);
}
/** resolve Zaapi node type → canonical def (undefined = unsupported import evidence) */
export function getDefByZaapiType(zaapiType: string): CanonicalNodeDefinition | undefined {
  return byZaapi.get(zaapiType) || byType.get(zaapiType);
}
export function listByFamily(family: NodeFamily): CanonicalNodeDefinition[] {
  return NODE_REGISTRY.filter((d) => d.family === family);
}
export function nodeAvailabilityFor(d: CanonicalNodeDefinition, platform: WorkflowPlatform): PlatformAvailability {
  return d.platformAvailability[platform] || { state: d.availability };
}
export function availabilityBadge(state: NodeAvailability): string {
  switch (state) {
    case "supported": return "Supported";
    case "requires_adapter": return "Requires adapter";
    case "unavailable": return "Unavailable";
  }
}

// ─── Deterministic handle resolution ──────────────────────
// Zaapi sourceHandle vocab: condition-index-N, no-match, ai-chatbot-escalate/
// timeout, wfr-success/wfr-no-respond, btn-template-*, randomizer-path-N.
export function resolveOutputHandles(d: CanonicalNodeDefinition, config: Record<string, unknown>): NodeHandleDefinition[] {
  const out: NodeHandleDefinition[] = [];
  for (const h of d.outputs) {
    if (!h.dynamic) { out.push(h); continue; }
    if (h.dynamic === "conditions") {
      // zaapi conditions[] → condition-index-0..N-1 ; local multi-branch → branch ids
      const conds = Array.isArray(config.conditions) ? config.conditions : null;
      if (conds) {
        conds.forEach((_, i) => out.push({ id: `condition-index-${i}` }));
      } else if (isMultiBranchCondition(config)) {
        for (const b of config.branches) out.push({ id: b.branch_id });
        out.push({ id: config.fallback_branch_id });
      } else {
        out.push({ id: "true" }, { id: "false" });
      }
    } else if (h.dynamic === "buttons") {
      // local: config.buttons · zaapi: config.action.buttonTemplate.buttons
      const btns = Array.isArray(config.buttons) ? config.buttons
        : ((config.action as { buttonTemplate?: { buttons?: unknown[] } } | undefined)?.buttonTemplate?.buttons ?? []);
      btns.forEach((_, i) => out.push({ id: `btn-template-condition-index-${i}` }));
    } else if (h.dynamic === "paths") {
      const paths = Array.isArray(config.paths) ? config.paths
        : Array.isArray((config.randomizer as { paths?: unknown[] } | undefined)?.paths) ? (config.randomizer as { paths: unknown[] }).paths : [];
      paths.forEach((_, i) => out.push({ id: `randomizer-path-${i}` }));
    }
  }
  // local wait_for_reply Phase 2 config → success/retry_exceeded/no_reply
  if (d.type === "wait_for_reply" && isPhase2WaitConfig(config)) {
    return [{ id: "success" }, { id: "retry_exceeded" }, { id: "no_reply" }];
  }
  return out;
}

// ─── Publish-readiness validation (capability layer) ──────
// ใช้กับ canonical draft — structural checks ทำโดย validateWorkflowGraph (owner เดิม)
export interface NodeIssue { node_id: string; type: string; reason: string; }
export interface DraftValidation {
  ok: boolean;                    // publish-ready
  errors: string[];               // structural + capability errors (block publish)
  unsupportedNodes: NodeIssue[];  // registry lookup miss
  blockedNodes: NodeIssue[];      // requires_adapter/unavailable/missing executor
  unresolvedBindings: { node_id: string; kind: string }[];
}

export function validateCanonicalDraft(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  platforms: WorkflowPlatform[],
  bindings: { node_id: string; kind: string }[] = [],
): DraftValidation {
  const errors: string[] = [];
  const unsupported: NodeIssue[] = [];
  const blocked: NodeIssue[] = [];
  for (const n of nodes) {
    const d = getNodeDef(n.subtype);
    if (!d) {
      unsupported.push({ node_id: n.node_id, type: n.subtype, reason: "node type ไม่มีใน registry" });
      continue;
    }
    if (d.availability === "unavailable") {
      blocked.push({ node_id: n.node_id, type: n.subtype, reason: "node ไม่พร้อมใช้ในระบบนี้" });
      continue;
    }
    if (!d.runtimeExecutor) {
      blocked.push({ node_id: n.node_id, type: n.subtype, reason: "ยังไม่มี runtime executor (requires adapter)" });
      continue;
    }
    for (const p of platforms) {
      const av = nodeAvailabilityFor(d, p);
      if (av.state !== "supported") {
        blocked.push({ node_id: n.node_id, type: n.subtype, reason: `platform ${p}: ${av.reason || av.state}` });
        break;
      }
    }
  }
  if (unsupported.length) errors.push(`${unsupported.length} node type ไม่รองรับ`);
  if (blocked.length) errors.push(`${blocked.length} node ไม่พร้อม publish`);
  if (bindings.length) errors.push(`${bindings.length} external binding ยังไม่ resolve`);
  return { ok: errors.length === 0, errors, unsupportedNodes: unsupported, blockedNodes: blocked, unresolvedBindings: bindings };
}

// ─── Foundation runtime gates ─────────────────────────────
// Foundation round: persistence writes + runtime activation are OUT OF SCOPE.
// Even a fully supported draft stays disabled for save/publish this round.
export const FOUNDATION_GATES = { persistence: false, runtimeActivation: false } as const;
export function publishReadiness(validation: DraftValidation): { canPublish: boolean; reason: string } {
  if (!FOUNDATION_GATES.persistence || !FOUNDATION_GATES.runtimeActivation) {
    return { canPublish: false, reason: "persistence/runtime activation ยังไม่อยู่ใน scope ของ foundation round" };
  }
  if (!validation.ok) return { canPublish: false, reason: validation.errors.join("; ") };
  return { canPublish: true, reason: "" };
}
