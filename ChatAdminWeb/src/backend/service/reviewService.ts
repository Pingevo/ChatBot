// reviewService — owner เดียวของ per-bubble human review บน shadow_replies
//
// Contract (plan 2026-11-09):
//   - review_bubbles freeze ตอน draft insert (builder เดียว — ใช้ร่วม storeBotReply
//     และ storeWorkflowDelivered); bot_reply_text ต้นฉบับไม่แตะ
//   - decision: pending | approved | edited_approved | rejected
//   - delivery: not_requested | mock_sent | mock_failed — receipt provider="mock",
//     delivered=false เสมอ; ไม่มี sent_text ในทุกกรณี (field absent)
//   - ordering: approve/send ได้เมื่อทุก bubble ก่อนหน้า rejected หรือ mock_sent
//   - legacy draft ไม่มี review_bubbles → แสดงได้ แต่ review ไม่ได้ (ห้ามแปลงย้อนหลัง)
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { splitAnswerSegments } from "@/lib/answerSegments";
import { insertDeterministicEvent } from "./botworkerEventService";
import type { ShadowReplyDoc } from "./shadowReplyService";

export const MAX_EDIT_LEN = 2000; // bounded input จนกว่า provider capability จะรู้จริง

export type BubbleDecision = "pending" | "approved" | "edited_approved" | "rejected";
export type DeliveryState = "not_requested" | "mock_sent" | "mock_failed";

export interface MockReceipt {
  provider: "mock";
  delivered: false;
  request_id: string;
}

export interface BubbleDelivery {
  state: DeliveryState;
  request_id?: string;
  receipt?: MockReceipt;
  error?: string;
}

export interface ReviewCard {
  item_id: string;
  delivery: BubbleDelivery;
}

export interface ReviewBubble {
  bubble_id: string;
  ordinal: number;
  original_text: string;
  edited_text?: string;
  decision: BubbleDecision;
  decided_by?: string;
  decided_at?: Date;
  approved_text?: string;
  delivery: BubbleDelivery;
  card?: ReviewCard;
  // ⚠️ ห้ามเพิ่ม sent_text — reserved สำหรับ provider จริงใน phase ที่แยกอนุมัติ
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
  return b.decision === "rejected" || b.delivery.state === "mock_sent";
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
  inbound_message_ids?: string[];
  batch_id?: string;
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
  designatedAdminId: string;  // จาก system_config (server-derived)
  designatedShopId: string;
  expectedUpdatedAt?: string; // optimistic version จาก client (ISO) — optional
  mockSender: (part: {
    eventId: string; replyId: string; bubbleId: string;
    part: "text" | "product_card"; text?: string; item_id?: string;
    conversationId: string; shopId: string; platform: string;
    actor: string; inboundMessageId?: string;
  }) => Promise<MockReceipt>;
}): Promise<ReviewOutcome> {
  const doc = await loadReply(opts.replyId, opts.conversationId);
  if (!doc) return { ok: false, code: "not_found", message: "reply not found" };
  // shop/actor fence — persisted doc เท่านั้น
  if (doc.shop_id !== opts.designatedShopId) return { ok: false, code: "forbidden", message: "shop outside pilot scope" };
  if (opts.actor !== opts.designatedAdminId) return { ok: false, code: "forbidden", message: "not the designated review admin" };
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
    shop_id: String(doc.shop_id),
    conversation_id: opts.conversationId,
    reply_id: opts.replyId,
    bubble_id: opts.bubbleId,
    action: opts.action,
    edited_text: opts.editedText ?? null,
    card_item_id: opts.cardItemId ?? null,
  };
  const opInsert = await insertDeterministicEvent({
    _id: opKey,
    event_id: opKey,
    conversation_id: opts.conversationId,
    type: "review_op",
    actor: opts.actor,
    shop_id: doc.shop_id,
    platform: doc.platform,
    metadata: { request: requestBinding, status: "in_progress" },
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
  const finish = async (outcome: ReviewOutcome): Promise<ReviewOutcome> => {
    // บันทึก outcome ลง op doc — CAS บน in_progress: finisher แรกชนะเท่านั้น
    // (same-opId concurrent execution → outcome ของผู้แพ้ห้ามทับของผู้ชนะ)
    await getCollection(COLLECTIONS.botworkerEvents).then((c) =>
      c.updateOne({ _id: opKey, "metadata.status": "in_progress" } as never, { $set: { "metadata.outcome": outcome, "metadata.status": "done" } })
    );
    return outcome;
  };

  // ⚡ conflict responses ต้องคืน state ที่ persisted จริง ไม่ใช่ next[] ที่ CAS แพ้
  const persistedBubble = async (): Promise<ReviewBubble | undefined> => {
    const fresh = await coll.findOne({ _id: doc._id } as never);
    return fresh?.review_bubbles?.[i];
  };

  const baseFilter: Record<string, unknown> = {
    _id: doc._id,
    [`review_bubbles.${i}.decision`]: "pending",
    updated_at: doc.updated_at,
  };

  const bubble = bubbles[i];

  // ── reject ──
  if (opts.action === "reject") {
    // ⚡ bubble ที่ส่ง card mock ไปแล้วห้าม reject — outbound event เกิดแล้ว ต้องคง record
    if (bubble.card?.delivery.state === "mock_sent") {
      return finish({ ok: false, code: "conflict", message: "card already mock-sent — cannot reject bubble" });
    }
    const next = bubbles.slice();
    next[i] = { ...bubble, decision: "rejected", decided_by: opts.actor, decided_at: now };
    const res = await coll.updateOne(baseFilter, { $set: { review_bubbles: next, updated_at: now } });
    if (res.matchedCount !== 1) return finish({ ok: false, code: "conflict", message: "bubble already decided or stale draft" });
    return finish({ ok: true, bubble: next[i], updated_at: now, reply_id: opts.replyId });
  }

  // ── save (keep pending) ──
  if (opts.action === "save") {
    const text = (opts.editedText ?? "").trim();
    if (!text) return finish({ ok: false, code: "invalid", message: "edited text is empty" });
    if (text.length > MAX_EDIT_LEN) return finish({ ok: false, code: "invalid", message: `edited text exceeds ${MAX_EDIT_LEN} chars` });
    const next = bubbles.slice();
    next[i] = { ...bubble, edited_text: text };
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
    if (bubble.card?.delivery.state === "mock_sent") {
      return finish({ ok: false, code: "conflict", message: "card already mock-sent" });
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
        { [`review_bubbles.${i}.card.item_id`]: itemId, [`review_bubbles.${i}.card.delivery.state`]: { $in: ["not_requested", "mock_failed"] } },
      ],
    };
    const intentBubbles = bubbles.slice();
    intentBubbles[i] = { ...bubble, card: { item_id: itemId, delivery: { state: "not_requested" } } };
    const intentRes = await coll.updateOne(cardFilter, { $set: { review_bubbles: intentBubbles, updated_at: now } });
    if (intentRes.matchedCount !== 1) {
      return finish({ ok: false, code: "conflict", message: "stale draft or conflicting card intent — rejected before any request" });
    }
    const eventId = mockSendEventId(opts.replyId, opts.bubbleId, "product_card");
    let delivery: BubbleDelivery;
    try {
      const receipt = await opts.mockSender({
        eventId, replyId: opts.replyId, bubbleId: opts.bubbleId,
        part: "product_card", item_id: itemId,
        conversationId: opts.conversationId, shopId: String(doc.shop_id),
        platform: doc.platform, actor: opts.actor,
        inboundMessageId: doc.inbound_message_id,
      });
      delivery = { state: "mock_sent", request_id: eventId, receipt };
    } catch (e) {
      delivery = { state: "mock_failed", error: String(e) };
    }
    const next = intentBubbles.slice();
    next[i] = { ...intentBubbles[i], card: { item_id: itemId, delivery } };
    const res = await coll.updateOne(
      { _id: doc._id, [`review_bubbles.${i}.card.delivery.state`]: "not_requested", updated_at: now },
      { $set: { review_bubbles: next, updated_at: new Date() } });
    if (res.matchedCount !== 1) {
      // delivery CAS miss — mock request อาจมีอยู่แล้ว (deterministic id) → conflict honest
      return finish({ ok: false, code: "conflict", message: `card delivery CAS lost (delivery=${delivery.state}) — verify state before retry`, bubble: await persistedBubble() });
    }
    if (delivery.state === "mock_failed") {
      return finish({ ok: false, code: "conflict", message: `mock send failed: ${delivery.error}`, bubble: next[i] });
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
    approvedText = text;
    decision = "edited_approved";
    editedTextSet = text;
  }
  const gate = sendGateError(bubbles, i);
  if (gate) return finish({ ok: false, code: "conflict", message: `out of order: ${gate}` });

  // ⚡ retry/resume — bubble ตัดสินแล้ว แต่ delivery ยังไม่ mock_sent
  //   (crash หลัง decision CAS หรือ mock_failed) → ยิง mock ด้วย persisted
  //   approved_text เสมอ — ห้ามเดาจาก request ใหม่ ห้ามเปลี่ยน decision
  if ((opts.action === "approve" || opts.action === "save_and_approve") &&
      (bubble.decision === "approved" || bubble.decision === "edited_approved") &&
      bubble.delivery.state !== "mock_sent") {
    const persistedText = bubble.approved_text ?? bubble.edited_text ?? bubble.original_text;
    const eventId = mockSendEventId(opts.replyId, opts.bubbleId, "text");
    let delivery: BubbleDelivery;
    try {
      const receipt = await opts.mockSender({
        eventId, replyId: opts.replyId, bubbleId: opts.bubbleId,
        part: "text", text: persistedText,
        conversationId: opts.conversationId, shopId: String(doc.shop_id),
        platform: doc.platform, actor: opts.actor,
        inboundMessageId: doc.inbound_message_id,
      });
      delivery = { state: "mock_sent", request_id: eventId, receipt };
    } catch (e) {
      delivery = { state: "mock_failed", error: String(e) };
    }
    const next = bubbles.slice();
    next[i] = { ...bubble, delivery };
    const res = await coll.updateOne(
      { _id: doc._id, [`review_bubbles.${i}.delivery.state`]: { $in: ["not_requested", "mock_failed"] }, [`review_bubbles.${i}.approved_text`]: persistedText, updated_at: doc.updated_at },
      { $set: { review_bubbles: next, updated_at: new Date() } });
    if (res.matchedCount !== 1) return finish({ ok: false, code: "conflict", message: "stale draft during retry — verify state" });
    if (delivery.state === "mock_failed") return finish({ ok: false, code: "conflict", message: `mock send failed: ${delivery.error}`, bubble: next[i] });
    return finish({ ok: true, bubble: next[i], reply_id: opts.replyId });
  }

  // ⚡ ordering invariant: decision CAS ชนะก่อน mock request เสมอ —
  //   ข้อความที่ log = approved_text ที่ persisted จริง (loser ออกก่อน mock)
  // CAS#1 — pending → decided + approved_text (delivery คง not_requested)
  const decidedBubbles = bubbles.slice();
  decidedBubbles[i] = {
    ...bubble,
    ...(editedTextSet !== undefined ? { edited_text: editedTextSet } : {}),
    decision,
    decided_by: opts.actor,
    decided_at: now,
    approved_text: approvedText,
    delivery: bubble.delivery.state === "mock_failed" ? { state: "not_requested" } : bubble.delivery,
  };
  const decideRes = await coll.updateOne(baseFilter, { $set: { review_bubbles: decidedBubbles, updated_at: now } });
  if (decideRes.matchedCount !== 1) {
    return finish({ ok: false, code: "conflict", message: "bubble already decided or stale draft — rejected before any mock request" });
  }
  // mock — ใช้ persisted approved_text ของผู้ชนะเท่านั้น
  const eventId = mockSendEventId(opts.replyId, opts.bubbleId, "text");
  let delivery: BubbleDelivery;
  try {
    const receipt = await opts.mockSender({
      eventId, replyId: opts.replyId, bubbleId: opts.bubbleId,
      part: "text", text: approvedText,
      conversationId: opts.conversationId, shopId: String(doc.shop_id),
      platform: doc.platform, actor: opts.actor,
      inboundMessageId: doc.inbound_message_id,
    });
    delivery = { state: "mock_sent", request_id: eventId, receipt };
  } catch (e) {
    delivery = { state: "mock_failed", error: String(e) };
  }
  // CAS#2 — delivery not_requested → outcome (retry path ด้านบน recover ได้เสมอ)
  const next = decidedBubbles.slice();
  next[i] = { ...decidedBubbles[i], delivery };
  const res = await coll.updateOne(
    { _id: doc._id, [`review_bubbles.${i}.delivery.state`]: "not_requested", updated_at: now },
    { $set: { review_bubbles: next, updated_at: new Date() } });
  if (res.matchedCount !== 1) {
    return finish({ ok: false, code: "conflict", message: `delivery CAS lost after decision (delivery=${delivery.state}) — verify state before retry`, bubble: await persistedBubble() });
  }
  if (delivery.state === "mock_failed") {
    return finish({ ok: false, code: "conflict", message: `mock send failed: ${delivery.error}`, bubble: next[i] });
  }
  return finish({ ok: true, bubble: next[i], reply_id: opts.replyId });
}
