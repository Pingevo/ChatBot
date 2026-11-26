// reviewService — owner เดียวของ per-bubble human review บน shadow_replies
//
// Contract (plan 2026-11-09):
//   - review_bubbles freeze ตอน draft insert (builder เดียว — ใช้ร่วม storeBotReply
//     และ storeWorkflowDelivered); bot_reply_text ต้นฉบับไม่แตะ
//   - decision: pending | approved | edited_approved | rejected
//   - delivery: mock by default; scoped Shopee states are persisted for approved sends.
//   - ordering: approve/send ได้เมื่อทุก bubble ก่อนหน้า rejected หรือส่งยืนยันแล้ว
//   - legacy draft ไม่มี review_bubbles → แสดงได้ แต่ review ไม่ได้ (ห้ามแปลงย้อนหลัง)
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { BOTWORKER_REVIEW_REASON_CATEGORIES, type BotWorkerReviewReasonCategory } from "@/lib/types";
import { insertDeterministicEvent } from "./botworkerEventService";
import type { ShadowReplyDoc, ShadowReviewBubbleDoc } from "./shadowReplyService";
import { assignmentService } from "./assignmentService";
import { handoffService } from "./handoffService";

export const MAX_EDIT_LEN = 2000; // bounded input จนกว่า provider capability จะรู้จริง

export type BubbleDecision = "pending" | "approved" | "edited_approved" | "rejected";
export type DeliveryState = "not_requested" | "not_sent_switch_off" | "mock_sent" | "mock_failed" | "live_sending" | "live_sent" | "live_failed" | "live_unknown";

export interface MockReceipt {
  provider: "mock";
  delivered: false;
  request_id: string;
}

export interface ShopeeReceipt {
  provider: "shopee";
  delivered: true;
  request_id: string;
  provider_message_id?: string;
}

export interface BubbleDelivery {
  state: DeliveryState;
  request_id?: string;
  outbound_text?: string;
  receipt?: MockReceipt | ShopeeReceipt;
  error?: string;
}

export interface ReviewCard {
  item_id: string;
  delivery: BubbleDelivery;
}

export interface ReviewBubble extends ShadowReviewBubbleDoc {
  bubble_id: string;
  ordinal: number;
  original_text: string;
  edited_text?: string;
  decision: BubbleDecision;
  decided_by?: string;
  decided_by_name?: string;
  decided_at?: Date;
  approved_text?: string;
  rejection_category?: BotWorkerReviewReasonCategory;
  rejection_reason?: string;
  edit_history?: { before_text: string; after_text: string; reason_category?: BotWorkerReviewReasonCategory; reason_text?: string; actor: string; actor_name: string; at: Date }[];
  delivery: BubbleDelivery;
  card?: ReviewCard;
  // Keep the approved text in approved_text; delivery status remains separate.
}

export function buildReviewBubbles(replyId: string, answer: string): ReviewBubble[] {
  return splitAnswerSegments(answer).map((seg, i) => ({
    bubble_id: `${replyId}:b${i}`,
    ordinal: i,
    original_text: seg,
    decision: "pending",
    delivery: { state: "not_requested" },
  }));
}

export type ReviewAction = "save" | "approve" | "save_and_approve" | "reject" | "send_card";

export interface ReviewOutcome {
  ok: boolean;
  code?: string;          // 409 conflict / 403 forbidden / 422 invalid / 404 not_found
  message?: string;
  bubble?: ReviewBubble;
  updated_at?: Date;
  reply_id?: string;
}

// ── helpers ────────────────────────────────────────────────

function bubbleSettled(b: ReviewBubble): boolean {
  return b.decision === "rejected" || b.delivery.state === "mock_sent" || b.delivery.state === "live_sent" || b.delivery.state === "not_sent_switch_off";
}

/** earlier bubbles ทุกอันต้อง settled (rejected หรือ mock_sent) ก่อน bubble i ส่งได้ */
function sendGateError(bubbles: ReviewBubble[], i: number): string | null {
  for (let j = 0; j < i; j++) {
    if (!bubbleSettled(bubbles[j])) {
      return `bubble ${j} not settled (decision=${bubbles[j].decision}, delivery=${bubbles[j].delivery.state})`;
    }
  }
  return null;
}

// ⚡ deterministic op identity — retry ด้วย operation_id เดิมคืน outcome เดิม
const reviewOpId = (operationId: string) => `reviewop:${operationId}`;
const mockSendEventId = (replyId: string, bubbleId: string, part: "text" | "product_card") =>
  `mocksend:${replyId}:${bubbleId}:${part}`;

interface DocLike extends ShadowReplyDoc {
  review_bubbles?: ReviewBubble[];
}

async function loadReply(replyId: string, conversationId: string): Promise<DocLike | null> {
  const coll = await getCollection<DocLike>(COLLECTIONS.shadowReplies);
  return coll.findOne({ shadow_reply_id: replyId, conversation_id: conversationId, deleted_at: { $exists: false } } as never);
}

// ── applyReviewAction — conditional update owner เดียว ────
//
// opts.actor/admin/shop มาจาก server (auth + persisted doc) เท่านั้น —
// ห้ามเชื่อ identity/ข้อความทั้งชุดจาก browser
export async function applyReviewAction(opts: {
  conversationId: string;
  replyId: string;
  bubbleId: string;
  action: ReviewAction;
  editedText?: string;
  cardItemId?: string;
  operationId: string;
  actor: string;              // admin_id จาก session
  actorName: string;
  liveSendEnabled: boolean;
  reasonCategory?: string;
  reasonText?: string;
  rejectionCategory?: string;
  rejectionReason?: string;
  expectedUpdatedAt?: string; // optimistic version จาก client (ISO) — optional
  mockSender: (part: {
    eventId: string; replyId: string; bubbleId: string;
    part: "text" | "product_card"; text?: string; item_id?: string;
    conversationId: string; shopId: string; platform: string;
    actor: string; inboundMessageId?: string;
  }) => Promise<MockReceipt>;
  liveSender?: (part: {
    eventId: string; replyId: string; bubbleId: string;
    part: "text" | "product_card"; text?: string; item_id?: string;
    conversationId: string; shopId: string; platform: string;
    actor: string; inboundMessageId?: string;
  }) => Promise<BubbleDelivery>;
}): Promise<ReviewOutcome> {
  const doc = await loadReply(opts.replyId, opts.conversationId);
  if (!doc) return { ok: false, code: "not_found", message: "reply not found" };
  const bubbles = doc.review_bubbles;
  if (!Array.isArray(bubbles) || bubbles.length === 0) {
    return { ok: false, code: "conflict", message: "draft has no review_bubbles (legacy or empty draft — not approvable)" };
  }
  const i = bubbles.findIndex((b) => b.bubble_id === opts.bubbleId);
  if (i < 0) return { ok: false, code: "not_found", message: "bubble not found" };

  // ⚡ optimistic version — client ส่ง updated_at ที่เห็นตอน render; ต่าง = draft เปลี่ยนแล้ว
  if (opts.expectedUpdatedAt !== undefined) {
    const exp = new Date(opts.expectedUpdatedAt);
    if (Number.isNaN(exp.getTime()) || !doc.updated_at || exp.getTime() !== new Date(doc.updated_at).getTime()) {
      return { ok: false, code: "conflict", message: "stale draft version — refresh before retry" };
    }
  }

  // ⚡ op dedupe — deterministic reviewop event; request binding ผูกกับ op id
  //   op id เดิม + request identity ต่าง (actor/shop/conv/reply/bubble/action/payload)
  //   → reject ก่อน transition/mock ทุกอย่าง
  const opKey = reviewOpId(opts.operationId);
  const requestBinding = {
    actor: opts.actor,
    conversation_id: opts.conversationId,
    reply_id: opts.replyId,
    bubble_id: opts.bubbleId,
    action: opts.action,
    edited_text: opts.editedText ?? null,
    card_item_id: opts.cardItemId ?? null,
    ...((opts.action === "save" || opts.action === "save_and_approve") ? {
      reason_category: opts.reasonCategory ?? null,
      reason_text: opts.reasonText ?? null,
    } : {}),
    ...(opts.action === "reject" ? { rejection_category: opts.rejectionCategory ?? null } : {}),
    rejection_reason: opts.rejectionReason ?? null,
  };
  const opInsert = await insertDeterministicEvent({
    _id: opKey,
    event_id: opKey,
    conversation_id: opts.conversationId,
    type: "review_op",
    actor: opts.actor,
    shop_id: doc.shop_id,
    platform: doc.platform,
    metadata: { request: requestBinding, actor_name: opts.actorName, status: "in_progress" },
    created_at: new Date(),
  });
  if (opInsert === "exists") {
    const existing = await getCollection<{ metadata?: { outcome?: ReviewOutcome; request?: typeof requestBinding } }>(COLLECTIONS.botworkerEvents)
      .then((c) => c.findOne({ _id: opKey } as never));
    const prevReq = existing?.metadata?.request;
    if (!prevReq || JSON.stringify(prevReq) !== JSON.stringify(requestBinding)) {
      return { ok: false, code: "conflict", message: "operation_id reused with different request — rejected without state change" };
    }
    const prev = existing?.metadata?.outcome;
    if (prev) return prev;
    // in_progress ค้าง + request ตรง → ทำต่อ: CAS/mock insert ด้านล่าง idempotent อยู่แล้ว
  }

  const coll = await getCollection<DocLike>(COLLECTIONS.shadowReplies);
  const now = new Date();
  let auditDetails: Record<string, unknown> = {};
  const finish = async (outcome: ReviewOutcome): Promise<ReviewOutcome> => {
    // บันทึก outcome ลง op doc — CAS บน in_progress: finisher แรกชนะเท่านั้น
    // (same-opId concurrent execution → outcome ของผู้แพ้ห้ามทับของผู้ชนะ)
    await getCollection(COLLECTIONS.botworkerEvents).then((c) =>
      c.updateOne({ _id: opKey, "metadata.status": "in_progress" } as never, { $set: {
        "metadata.outcome": outcome, "metadata.audit_details": auditDetails,
        "metadata.actor_name": opts.actorName, "metadata.status": "done",
      } })
    );
    await insertDeterministicEvent({
      _id: `reviewaction:${opts.operationId}`,
      event_id: `reviewaction:${opts.operationId}`,
      conversation_id: opts.conversationId,
      type: "review_action",
      actor: opts.actor,
      shop_id: doc.shop_id,
      platform: doc.platform,
      metadata: {
        actor_name: opts.actorName,
        action: opts.action,
        reply_id: opts.replyId,
        bubble_id: opts.bubbleId,
        request: requestBinding,
        outcome: { ok: outcome.ok, code: outcome.code, delivery_state: outcome.bubble?.delivery.state },
        ...auditDetails,
      },
      created_at: now,
    });
    return outcome;
  };

  // ⚡ conflict responses ต้องคืน state ที่ persisted จริง ไม่ใช่ next[] ที่ CAS แพ้
  const persistedBubble = async (): Promise<ReviewBubble | undefined> => {
    const fresh = await coll.findOne({ _id: doc._id } as never);
    return fresh?.review_bubbles?.[i];
  };

  const deliver = async (part: {
    eventId: string; replyId: string; bubbleId: string;
    part: "text" | "product_card"; text?: string; item_id?: string;
    conversationId: string; shopId: string; platform: string;
    actor: string; inboundMessageId?: string;
  }): Promise<BubbleDelivery> => {
    if (part.platform === "shopee" && !opts.liveSendEnabled) {
      return { state: "not_sent_switch_off", request_id: part.eventId, error: "live_send_switch_off" };
    }
    if (opts.liveSender) {
      try {
        const delivery = await opts.liveSender(part);
        return part.platform === "shopee" && part.part === "text" && part.text !== undefined
          ? { ...delivery, outbound_text: part.text } : delivery;
      } catch {
        return {
          state: "live_unknown", request_id: part.eventId, error: "delivery_unknown",
          ...(part.platform === "shopee" && part.part === "text" && part.text !== undefined ? { outbound_text: part.text } : {}),
        };
      }
    }
    if (part.platform === "shopee") {
      return { state: "live_failed", request_id: part.eventId, error: "live_sender_unavailable" };
    }
    try {
      const receipt = await opts.mockSender(part);
      return { state: "mock_sent", request_id: part.eventId, receipt };
    } catch {
      return { state: "mock_failed", error: "mock_send_failed" };
    }
  };

  const baseFilter: Record<string, unknown> = {
    _id: doc._id,
    [`review_bubbles.${i}.decision`]: "pending",
    updated_at: doc.updated_at,
  };

  const bubble = bubbles[i];
  auditDetails = { original_text: bubble.original_text, previous_edited_text: bubble.edited_text };
  if (doc.bot_handoff_required && opts.action === "reject") {
    return finish({ ok: false, code: "conflict", message: "handoff drafts must be rejected through the handoff review action" });
  }
  if (bubble.card?.delivery.state === "live_sending" || bubble.card?.delivery.state === "live_unknown") {
    return finish({ ok: false, code: "conflict", message: "card delivery is unconfirmed; verify the Shopee chat before changing this bubble" });
  }

  // ── reject ──
  if (opts.action === "reject") {
    const rejectionCategory = opts.rejectionCategory;
    const rejectionReason = String(opts.rejectionReason ?? "").trim();
    if (!BOTWORKER_REVIEW_REASON_CATEGORIES.includes(rejectionCategory as BotWorkerReviewReasonCategory)) {
      return finish({ ok: false, code: "invalid", message: "rejection_category is invalid" });
    }
    if (!rejectionReason) return finish({ ok: false, code: "invalid", message: "rejection_reason is required" });
    if (rejectionReason.length > 1000) return finish({ ok: false, code: "invalid", message: "rejection_reason exceeds 1000 chars" });
    // ⚡ bubble ที่ส่ง card mock ไปแล้วห้าม reject — outbound event เกิดแล้ว ต้องคง record
    if (bubble.card && (["mock_sent", "live_sending", "live_sent", "live_unknown"] as DeliveryState[]).includes(bubble.card.delivery.state)) {
      return finish({ ok: false, code: "conflict", message: "card already sent — cannot reject bubble" });
    }
    const next = bubbles.slice();
    next[i] = { ...bubble, decision: "rejected", decided_by: opts.actor, decided_by_name: opts.actorName,
      decided_at: now, rejection_category: rejectionCategory as BotWorkerReviewReasonCategory, rejection_reason: rejectionReason };
    auditDetails = { ...auditDetails, rejection_category: rejectionCategory, rejection_reason: rejectionReason,
      rejected_text: bubble.edited_text ?? bubble.original_text };
    const res = await coll.updateOne(baseFilter, { $set: { review_bubbles: next, updated_at: now } });
    if (res.matchedCount !== 1) return finish({ ok: false, code: "conflict", message: "bubble already decided or stale draft" });
    return finish({ ok: true, bubble: next[i], updated_at: now, reply_id: opts.replyId });
  }

  // ── save (keep pending) ──
  if (opts.action === "save") {
    const text = (opts.editedText ?? "").trim();
    if (!text) return finish({ ok: false, code: "invalid", message: "edited text is empty" });
    if (text.length > MAX_EDIT_LEN) return finish({ ok: false, code: "invalid", message: `edited text exceeds ${MAX_EDIT_LEN} chars` });
    const reasonText = String(opts.reasonText ?? "").trim();
    if (!BOTWORKER_REVIEW_REASON_CATEGORIES.includes(opts.reasonCategory as BotWorkerReviewReasonCategory)) {
      return finish({ ok: false, code: "invalid", message: "reason_category is invalid" });
    }
    if (!reasonText) return finish({ ok: false, code: "invalid", message: "reason_text is required" });
    if (reasonText.length > 1000) return finish({ ok: false, code: "invalid", message: "reason_text exceeds 1000 chars" });
    const next = bubbles.slice();
    next[i] = { ...bubble, edited_text: text, edit_history: [...(bubble.edit_history || []), {
      before_text: bubble.edited_text ?? bubble.original_text, after_text: text,
      reason_category: opts.reasonCategory as BotWorkerReviewReasonCategory, reason_text: reasonText,
      actor: opts.actor, actor_name: opts.actorName, at: now,
    }] };
    auditDetails = { ...auditDetails, edited_text: text, reason_category: opts.reasonCategory, reason_text: reasonText };
    const res = await coll.updateOne(baseFilter, { $set: { review_bubbles: next, updated_at: now } });
    if (res.matchedCount !== 1) return finish({ ok: false, code: "conflict", message: "bubble already decided or stale draft" });
    return finish({ ok: true, bubble: next[i], updated_at: now, reply_id: opts.replyId });
  }

  // ── send_card — typed product_card mock request ──
  // ⚡ ordering: CAS card intent (item verified + delivery not_requested) ก่อน
  //   mock เสมอ → การ์ดที่ log = การ์ดที่ CAS ยืนยัน; crash หลัง CAS → retry path
  if (opts.action === "send_card") {
    const cardItemId = String(opts.cardItemId ?? "").trim();
    if (!cardItemId) return finish({ ok: false, code: "invalid", message: "card_item_id is required" });
    const gate = sendGateError(bubbles, i);
    if (gate) return finish({ ok: false, code: "conflict", message: `out of order: ${gate}` });
    // ⚡ decided boundary — bubble ที่ถูก reject แล้วห้ามออก card request
    //   (UI ซ่อนปุ่มไม่พอ — API ต้องปิดเอง); pending/approved ทำ card ได้ตาม gate
    if (bubble.decision === "rejected") {
      return finish({ ok: false, code: "conflict", message: "rejected bubble cannot send card" });
    }
    if (bubble.card && (["mock_sent", "live_sending", "live_sent", "live_unknown"] as DeliveryState[]).includes(bubble.card.delivery.state)) {
      return finish({ ok: false, code: "conflict", message: "card already sent" });
    }
    // ⚡ verify item identity จาก bot_products record เดิมเท่านั้น — ห้ามเดาจากข้อความ/URL
    const products = Array.isArray(doc.bot_products) ? doc.bot_products : [];
    const entry = products.find((p) => {
      const r = p as Record<string, unknown>;
      return String(r.item_id ?? r.itemid ?? "") === cardItemId;
    }) as Record<string, unknown> | undefined;
    if (!entry) return finish({ ok: false, code: "invalid", message: "item not in persisted bot_products — cannot verify card identity" });
    const itemId = String(entry.item_id ?? entry.itemid);
    // ⚡ shop verify — product card จริงจาก Python ใช้ "shop" (shopname) เทียบกับ
    //   conv.shop_name; synthetic/legacy entry ใช้ shop_id/shopid เทียบ doc.shop_id
    const entryShop = String(entry.shop ?? "");
    const entryShopId = String(entry.shop_id ?? entry.shopid ?? "");
    let shopVerified = false;
    if (entryShop) {
      const conv = await getCollection<Record<string, unknown>>(COLLECTIONS.conversations)
        .then((c) => c.findOne({ conversation_id: opts.conversationId } as never));
      shopVerified = !!conv && String(conv.shop_name ?? "") === entryShop;
    } else if (entryShopId) {
      shopVerified = entryShopId === String(doc.shop_id);
    }
    if (!shopVerified) {
      return finish({ ok: false, code: "invalid", message: "product shop association unverifiable — card blocked" });
    }
    // CAS#1 — card intent + delivery not_requested (ต่าง item → item mismatch = conflict)
    const cardFilter: Record<string, unknown> = {
      _id: doc._id,
      updated_at: doc.updated_at,
      $or: [
        { [`review_bubbles.${i}.card`]: { $exists: false } },
        { [`review_bubbles.${i}.card.item_id`]: itemId, [`review_bubbles.${i}.card.delivery.state`]: { $in: ["not_requested", "not_sent_switch_off", "mock_failed", "live_failed"] } },
      ],
    };
    const intentState: DeliveryState = opts.liveSender && doc.platform === "shopee" ? "live_sending" : "not_requested";
    const intentBubbles = bubbles.slice();
    intentBubbles[i] = { ...bubble, card: { item_id: itemId, delivery: { state: intentState } } };
    const intentRes = await coll.updateOne(cardFilter, { $set: { review_bubbles: intentBubbles, updated_at: now } });
    if (intentRes.matchedCount !== 1) {
      return finish({ ok: false, code: "conflict", message: "stale draft or conflicting card intent — rejected before any request" });
    }
    const eventId = mockSendEventId(opts.replyId, opts.bubbleId, "product_card");
    const delivery = await deliver({
      eventId, replyId: opts.replyId, bubbleId: opts.bubbleId,
      part: "product_card", item_id: itemId,
      conversationId: opts.conversationId, shopId: String(doc.shop_id),
      platform: doc.platform, actor: opts.actor,
      inboundMessageId: doc.inbound_message_id,
    });
    const next = intentBubbles.slice();
    next[i] = { ...intentBubbles[i], card: { item_id: itemId, delivery } };
    const res = await coll.updateOne(
      { _id: doc._id, [`review_bubbles.${i}.card.delivery.state`]: intentState, updated_at: now },
      { $set: { review_bubbles: next, updated_at: new Date() } });
    if (res.matchedCount !== 1) {
      // delivery CAS miss — mock request อาจมีอยู่แล้ว (deterministic id) → conflict honest
      return finish({ ok: false, code: "conflict", message: `card delivery CAS lost (delivery=${delivery.state}) — verify state before retry`, bubble: await persistedBubble() });
    }
    if (delivery.state === "mock_failed" || delivery.state === "live_failed" || delivery.state === "live_unknown") {
      return finish({ ok: false, code: "conflict", message: delivery.state === "live_unknown" ? "Shopee delivery unconfirmed; verify before retry" : "message delivery failed", bubble: next[i] });
    }
    return finish({ ok: true, bubble: next[i], reply_id: opts.replyId });
  }

  // ── approve / save_and_approve ──
  // ⚡ validate text ก่อน gate สำหรับ pending bubble (decided bubble → resume path ใช้ persisted text)
  let approvedText = bubble.edited_text ?? bubble.original_text;
  let decision: BubbleDecision = bubble.edited_text ? "edited_approved" : "approved";
  let editedTextSet: string | undefined;
  if (opts.action === "save_and_approve" && bubble.decision === "pending") {
    const text = (opts.editedText ?? "").trim();
    if (!text) return finish({ ok: false, code: "invalid", message: "edited text is empty" });
    if (text.length > MAX_EDIT_LEN) return finish({ ok: false, code: "invalid", message: `edited text exceeds ${MAX_EDIT_LEN} chars` });
    const reasonText = String(opts.reasonText ?? "").trim();
    if (!BOTWORKER_REVIEW_REASON_CATEGORIES.includes(opts.reasonCategory as BotWorkerReviewReasonCategory)) {
      return finish({ ok: false, code: "invalid", message: "reason_category is invalid" });
    }
    if (!reasonText) return finish({ ok: false, code: "invalid", message: "reason_text is required" });
    if (reasonText.length > 1000) return finish({ ok: false, code: "invalid", message: "reason_text exceeds 1000 chars" });
    approvedText = text;
    decision = "edited_approved";
    editedTextSet = text;
  }
  const gate = sendGateError(bubbles, i);
  if (gate) return finish({ ok: false, code: "conflict", message: `out of order: ${gate}` });

  // Retry/resume uses the persisted approved text; unknown live delivery is never retried.
  if ((opts.action === "approve" || opts.action === "save_and_approve") && bubble.delivery.state === "live_unknown") {
    return finish({ ok: false, code: "conflict", message: "Shopee delivery unconfirmed; verify the chat before retry", bubble });
  }
  if ((opts.action === "approve" || opts.action === "save_and_approve") &&
      (bubble.decision === "approved" || bubble.decision === "edited_approved") &&
      bubble.delivery.state !== "mock_sent" && bubble.delivery.state !== "live_sent") {
    const persistedText = bubble.approved_text ?? bubble.edited_text ?? bubble.original_text;
    auditDetails = { ...auditDetails, approved_text: persistedText, decision: bubble.decision };
    const eventId = mockSendEventId(opts.replyId, opts.bubbleId, "text");
    const delivery = await deliver({
      eventId, replyId: opts.replyId, bubbleId: opts.bubbleId,
      part: "text", text: persistedText,
      conversationId: opts.conversationId, shopId: String(doc.shop_id),
      platform: doc.platform, actor: opts.actor,
      inboundMessageId: doc.inbound_message_id,
    });
    const next = bubbles.slice();
    next[i] = { ...bubble, delivery };
    const res = await coll.updateOne(
      { _id: doc._id, [`review_bubbles.${i}.delivery.state`]: { $in: ["not_requested", "not_sent_switch_off", "mock_failed", "live_failed"] }, [`review_bubbles.${i}.approved_text`]: persistedText, updated_at: doc.updated_at },
      { $set: { review_bubbles: next, updated_at: new Date() } });
    if (res.matchedCount !== 1) return finish({ ok: false, code: "conflict", message: "stale draft during retry — verify state" });
    if (delivery.state === "mock_failed" || delivery.state === "live_failed" || delivery.state === "live_unknown") {
      return finish({ ok: false, code: "conflict", message: delivery.state === "live_unknown" ? "Shopee delivery unconfirmed; verify before retry" : "message delivery failed", bubble: next[i] });
    }
    return finish({ ok: true, bubble: next[i], reply_id: opts.replyId });
  }

  // ⚡ ordering invariant: decision CAS ชนะก่อน mock request เสมอ —
  //   ข้อความที่ log = approved_text ที่ persisted จริง (loser ออกก่อน mock)
  // CAS#1 — pending → decided + approved_text (delivery คง not_requested)
  const decidedBubbles = bubbles.slice();
  auditDetails = { ...auditDetails, approved_text: approvedText, decision,
    ...(editedTextSet !== undefined ? { reason_category: opts.reasonCategory, reason_text: opts.reasonText?.trim() } : {}) };
  decidedBubbles[i] = {
    ...bubble,
    ...(editedTextSet !== undefined ? { edited_text: editedTextSet } : {}),
    ...(editedTextSet !== undefined ? { edit_history: [...(bubble.edit_history || []), {
      before_text: bubble.edited_text ?? bubble.original_text, after_text: editedTextSet,
      reason_category: opts.reasonCategory as BotWorkerReviewReasonCategory, reason_text: opts.reasonText?.trim(),
      actor: opts.actor, actor_name: opts.actorName, at: now,
    }] } : {}),
    decision,
    decided_by: opts.actor,
    decided_by_name: opts.actorName,
    decided_at: now,
    approved_text: approvedText,
    delivery: bubble.delivery.state === "mock_failed" || bubble.delivery.state === "live_failed" ? { state: "not_requested" } : bubble.delivery,
  };
  const decideRes = await coll.updateOne(baseFilter, { $set: { review_bubbles: decidedBubbles, updated_at: now } });
  if (decideRes.matchedCount !== 1) {
    return finish({ ok: false, code: "conflict", message: "bubble already decided or stale draft — rejected before any mock request" });
  }
  // mock — ใช้ persisted approved_text ของผู้ชนะเท่านั้น
  const eventId = mockSendEventId(opts.replyId, opts.bubbleId, "text");
  const delivery = await deliver({
    eventId, replyId: opts.replyId, bubbleId: opts.bubbleId,
    part: "text", text: approvedText,
    conversationId: opts.conversationId, shopId: String(doc.shop_id),
    platform: doc.platform, actor: opts.actor,
    inboundMessageId: doc.inbound_message_id,
  });
  // CAS#2 — delivery not_requested → outcome (retry path ด้านบน recover ได้เสมอ)
  const next = decidedBubbles.slice();
  next[i] = { ...decidedBubbles[i], delivery };
  const res = await coll.updateOne(
    { _id: doc._id, [`review_bubbles.${i}.delivery.state`]: "not_requested", updated_at: now },
    { $set: { review_bubbles: next, updated_at: new Date() } });
  if (res.matchedCount !== 1) {
    return finish({ ok: false, code: "conflict", message: `delivery CAS lost after decision (delivery=${delivery.state}) — verify state before retry`, bubble: await persistedBubble() });
  }
  if (delivery.state === "mock_failed" || delivery.state === "live_failed" || delivery.state === "live_unknown") {
    return finish({ ok: false, code: "conflict", message: delivery.state === "live_unknown" ? "Shopee delivery unconfirmed; verify before retry" : "message delivery failed", bubble: next[i] });
  }
  return finish({ ok: true, bubble: next[i], reply_id: opts.replyId });
}

export interface HandoffReviewOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  handoff_review?: ShadowReplyDoc["handoff_review"];
  candidates?: Awaited<ReturnType<typeof assignmentService.previewHandoffCandidates>>;
  updated_at?: Date;
}

export async function getHandoffReviewPreview(opts: {
  conversationId: string;
  replyId: string;
  expectedMessageId?: string;
}): Promise<HandoffReviewOutcome> {
  const doc = await loadReply(opts.replyId, opts.conversationId);
  if (!doc) return { ok: false, code: "not_found", message: "handoff reply not found" };
  if (doc.origin !== "worker" || !doc.bot_handoff_required || !doc.handoff_review) {
    return { ok: false, code: "conflict", message: "reply has no reviewer handoff request" };
  }
  if ((doc.upstream_conversation_id && doc.upstream_conversation_id !== opts.conversationId) ||
      (doc.upstream_message_id && !doc.inbound_message_ids?.includes(doc.upstream_message_id) && doc.upstream_message_id !== doc.inbound_message_id)) {
    return { ok: false, code: "conflict", message: "upstream handoff identity does not match this conversation turn" };
  }
  if (opts.expectedMessageId && opts.expectedMessageId !== doc.inbound_message_id && opts.expectedMessageId !== doc.upstream_message_id) {
    return { ok: false, code: "conflict", message: "handoff reply is not attached to the selected inbound message" };
  }
  const candidates = doc.handoff_review.status === "pending" || doc.handoff_review.status === "approving"
    ? await assignmentService.previewHandoffCandidates({ shop_id: String(doc.shop_id), platform: doc.platform }, "botworker", opts.conversationId)
    : [];
  return {
    ok: true,
    handoff_review: doc.handoff_review,
    candidates,
    updated_at: doc.updated_at,
  };
}

export async function applyHandoffReviewAction(opts: {
  conversationId: string;
  replyId: string;
  action: "approve" | "reject";
  selectedAdminId?: string;
  rejectionCategory?: string;
  rejectionReason?: string;
  operationId: string;
  actor: string;
  actorName: string;
  expectedUpdatedAt?: string;
}): Promise<HandoffReviewOutcome> {
  const doc = await loadReply(opts.replyId, opts.conversationId);
  if (!doc) return { ok: false, code: "not_found", message: "handoff reply not found" };
  if (doc.origin !== "worker" || !doc.bot_handoff_required || !doc.handoff_review) {
    return { ok: false, code: "conflict", message: "reply has no reviewer handoff request" };
  }
  if ((doc.upstream_conversation_id && doc.upstream_conversation_id !== opts.conversationId) ||
      (doc.upstream_message_id && !doc.inbound_message_ids?.includes(doc.upstream_message_id) && doc.upstream_message_id !== doc.inbound_message_id)) {
    return { ok: false, code: "conflict", message: "upstream handoff identity does not match the stored inbound turn" };
  }
  const resumesSameAssignment = opts.action === "approve" && doc.handoff_review.status === "approving" &&
    doc.handoff_review.assignment_operation_key === `${opts.replyId}:${opts.operationId}`;
  if (opts.expectedUpdatedAt && !resumesSameAssignment) {
    const expected = new Date(opts.expectedUpdatedAt).getTime();
    if (!Number.isFinite(expected) || expected !== new Date(doc.updated_at).getTime()) {
      return { ok: false, code: "conflict", message: "stale handoff review — refresh before retry" };
    }
  }
  const rejectionCategory = opts.rejectionCategory;
  const reason = String(opts.rejectionReason ?? "").trim();
  if (opts.action === "reject" && !BOTWORKER_REVIEW_REASON_CATEGORIES.includes(rejectionCategory as BotWorkerReviewReasonCategory)) {
    return { ok: false, code: "invalid", message: "rejection_category is invalid" };
  }
  if (opts.action === "reject" && !reason) return { ok: false, code: "invalid", message: "rejection_reason is required" };
  if (reason.length > 1000) return { ok: false, code: "invalid", message: "rejection_reason exceeds 1000 chars" };
  if (opts.action === "approve" && !opts.selectedAdminId) return { ok: false, code: "invalid", message: "selected_admin_id is required" };

  const opKey = `handoffreviewop:${opts.operationId}`;
  const request = {
    action: opts.action,
    actor: opts.actor,
    conversation_id: opts.conversationId,
    reply_id: opts.replyId,
    selected_admin_id: opts.selectedAdminId ?? null,
    ...(opts.action === "reject" ? { rejection_category: rejectionCategory ?? null } : {}),
    rejection_reason: opts.action === "reject" ? reason : null,
  };
  const insert = await insertDeterministicEvent({
    _id: opKey, event_id: opKey, conversation_id: opts.conversationId, type: "review_op",
    actor: opts.actor, shop_id: doc.shop_id, platform: doc.platform,
    metadata: { request, actor_name: opts.actorName, status: "in_progress" }, created_at: new Date(),
  });
  if (insert === "exists") {
    const previous = await getCollection<{ metadata?: { request?: typeof request; outcome?: HandoffReviewOutcome } }>(COLLECTIONS.botworkerEvents)
      .then((coll) => coll.findOne({ _id: opKey } as never));
    if (!previous?.metadata?.request || JSON.stringify(previous.metadata.request) !== JSON.stringify(request)) {
      return { ok: false, code: "conflict", message: "operation_id reused with a different handoff decision" };
    }
    if (previous.metadata.outcome) return previous.metadata.outcome;
  }

  const coll = await getCollection<DocLike>(COLLECTIONS.shadowReplies);
  const now = new Date();
  const finish = async (outcome: HandoffReviewOutcome, audit: Record<string, unknown> = {}) => {
    await getCollection(COLLECTIONS.botworkerEvents).then((events) => events.updateOne(
      { _id: opKey, "metadata.status": "in_progress" } as never,
      { $set: { "metadata.status": "done", "metadata.outcome": outcome,
        "metadata.audit_details": audit, "metadata.actor_name": opts.actorName } }
    ));
    await insertDeterministicEvent({
      _id: `reviewaction:${opts.operationId}`, event_id: `reviewaction:${opts.operationId}`,
      conversation_id: opts.conversationId, type: "review_action", actor: opts.actor,
      shop_id: doc.shop_id, platform: doc.platform,
      metadata: { action: `handoff_${opts.action}`, actor_name: opts.actorName, reply_id: opts.replyId,
        request, outcome: { ok: outcome.ok, code: outcome.code }, ...audit }, created_at: now,
    });
    return outcome;
  };

  if (opts.action === "reject") {
    const nextReview = { ...doc.handoff_review, status: "rejected" as const, reviewed_by: opts.actor,
      reviewed_by_name: opts.actorName, reviewed_at: now,
      rejection_category: rejectionCategory as BotWorkerReviewReasonCategory, rejection_reason: reason };
    const res = await coll.updateOne({ _id: doc._id, updated_at: doc.updated_at, "handoff_review.status": "pending" },
      { $set: { handoff_review: nextReview, updated_at: now } });
    if (res.matchedCount !== 1) return finish({ ok: false, code: "conflict", message: "handoff already reviewed or stale" });
    return finish({ ok: true, handoff_review: nextReview, updated_at: now }, {
      rejection_category: rejectionCategory, rejection_reason: reason,
      answer: doc.bot_reply_text, handoff_reason: doc.bot_handoff_reason, handoff_explanation: doc.bot_handoff_explanation });
  }

  const candidates = await assignmentService.previewHandoffCandidates({ shop_id: String(doc.shop_id), platform: doc.platform }, "botworker", opts.conversationId);
  const candidate = candidates.find((item) => item.admin_id === opts.selectedAdminId);
  if (!candidate) {
    if (doc.handoff_review.status === "approving" && resumesSameAssignment) {
      await coll.updateOne({ _id: doc._id, "handoff_review.status": "approving",
        "handoff_review.assignment_operation_id": opts.operationId },
        { $set: { "handoff_review.status": "pending", "handoff_review.last_error": "selected admin is not currently online and eligible", updated_at: new Date() } });
    }
    return finish({ ok: false, code: "conflict", message: "selected admin is not currently online and eligible" }, { selected_admin_id: opts.selectedAdminId });
  }

  const existingReview = doc.handoff_review;
  if (existingReview.status === "pending") {
    const approving = { ...existingReview, status: "approving" as const, selected_admin_id: candidate.admin_id,
      selected_admin_name: candidate.name, reviewed_by: opts.actor, reviewed_by_name: opts.actorName,
      assignment_operation_id: opts.operationId, assignment_operation_key: `${opts.replyId}:${opts.operationId}` };
    const claim = await coll.updateOne({ _id: doc._id, updated_at: doc.updated_at, "handoff_review.status": "pending" },
      { $set: { handoff_review: approving, updated_at: now } });
    if (claim.matchedCount !== 1) return finish({ ok: false, code: "conflict", message: "handoff already reviewed or stale" });
  } else if (existingReview.status !== "approving" || existingReview.assignment_operation_key !== `${opts.replyId}:${opts.operationId}` || existingReview.selected_admin_id !== candidate.admin_id) {
    return finish({ ok: false, code: "conflict", message: "another handoff decision is in progress or already completed" });
  }

  const operationKey = `botworker-handoff-review:${opts.replyId}:${opts.operationId}`;
  const assignment = await handoffService.handoffToAdminTest({
    conversationId: opts.conversationId, shopId: String(doc.shop_id), platform: doc.platform,
    reason: doc.bot_handoff_reason || doc.bot_handoff_category || "bot_requested_handoff",
    source: "botworker", assignedStatus: "open", selectedAdminId: candidate.admin_id,
    reserveSelectedRoundRobin: candidate.suggestion_reason === "round_robin", operationKey,
  });
  if (assignment.in_flight) return { ok: false, code: "conflict", message: "handoff assignment is in progress; retry with the same operation id" };
  if (assignment.error || assignment.assignedTo !== candidate.admin_id) {
    const fresh = await loadReply(opts.replyId, opts.conversationId);
    if (fresh?.handoff_review?.status === "approving" && fresh.handoff_review.assignment_operation_key === `${opts.replyId}:${opts.operationId}`) {
      await coll.updateOne({ _id: fresh._id, "handoff_review.status": "approving", "handoff_review.assignment_operation_key": `${opts.replyId}:${opts.operationId}` },
        { $set: { "handoff_review.status": "pending", "handoff_review.last_error": assignment.assignmentReason, updated_at: new Date() } });
    }
    return finish({ ok: false, code: "conflict", message: "selected admin became unavailable; choose an online admin and retry" },
      { selected_admin_id: candidate.admin_id, assignment_reason: assignment.assignmentReason });
  }

  const completed = { ...doc.handoff_review, status: "approved" as const, reviewed_by: opts.actor,
    reviewed_by_name: opts.actorName, reviewed_at: new Date(), selected_admin_id: assignment.assignedTo,
    selected_admin_name: assignment.assignedToName || candidate.name, assignment_reason: assignment.assignmentReason,
    assignment_operation_key: operationKey };
  const saved = await coll.updateOne({ _id: doc._id, "handoff_review.status": "approving",
    "handoff_review.assignment_operation_key": `${opts.replyId}:${opts.operationId}` },
    { $set: { handoff_review: completed, updated_at: new Date() } });
  if (saved.matchedCount !== 1) {
    const current = await loadReply(opts.replyId, opts.conversationId);
    if (current?.handoff_review?.status !== "approved" || current.handoff_review.selected_admin_id !== assignment.assignedTo) {
      return finish({ ok: false, code: "conflict", message: "assignment committed but review state needs reconciliation" }, { assigned_to: assignment.assignedTo });
    }
  }
  await insertDeterministicEvent({
    _id: `handoffreview:${opts.replyId}:${opts.operationId}`, event_id: `handoffreview:${opts.replyId}:${opts.operationId}`,
    conversation_id: opts.conversationId, type: "handoff", actor: opts.actor, shop_id: doc.shop_id, platform: doc.platform,
    metadata: { reply_id: opts.replyId, reason: doc.bot_handoff_reason, explanation: doc.bot_handoff_explanation,
      assigned_to: assignment.assignedTo, assigned_to_name: assignment.assignedToName || candidate.name,
      reviewer_id: opts.actor, reviewer_name: opts.actorName, assignment_reason: assignment.assignmentReason,
      delivered_to_platform: false }, created_at: new Date(),
  });
  return finish({ ok: true, handoff_review: completed, updated_at: new Date() }, {
    answer: doc.bot_reply_text, handoff_reason: doc.bot_handoff_reason,
    handoff_explanation: doc.bot_handoff_explanation, selected_admin_id: assignment.assignedTo,
    selected_admin_name: assignment.assignedToName || candidate.name,
  });
}
