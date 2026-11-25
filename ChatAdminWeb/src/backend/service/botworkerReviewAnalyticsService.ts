import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { ShadowReplyDoc } from "./shadowReplyService";
import type { BotworkerEventDoc } from "./botworkerEventService";

export type ReviewAnalysisGroup = "day" | "month" | "year";

function bangkokStart(date: string): Date {
  return new Date(`${date}T00:00:00.000+07:00`);
}

function groupFormat(group: ReviewAnalysisGroup): string {
  return group === "year" ? "%Y" : group === "month" ? "%Y-%m" : "%Y-%m-%d";
}

export async function getBotworkerReviewAnalysis(opts: {
  from: string;
  to: string;
  group: ReviewAnalysisGroup;
  page?: number;
  pageSize?: number;
}) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(opts.from) || !datePattern.test(opts.to)) throw new Error("invalid_date_range");
  const start = bangkokStart(opts.from);
  const end = new Date(bangkokStart(opts.to).getTime() + 86_400_000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error("invalid_date_range");
  if (end.getTime() - start.getTime() > 5 * 366 * 86_400_000) throw new Error("date_range_too_large");

  const page = Math.max(1, Math.min(500, Math.floor(opts.page || 1)));
  const pageSize = Math.max(10, Math.min(100, Math.floor(opts.pageSize || 25)));
  const match = { origin: { $in: ["worker", "workflow"] as const }, deleted_at: { $exists: false }, created_at: { $gte: start, $lt: end } };
  const replies = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const events = await getCollection<BotworkerEventDoc>(COLLECTIONS.botworkerEvents);
  const fmt = groupFormat(opts.group);
  const baseStages = [
    { $match: match },
    { $project: {
      bucket: { $dateToString: { format: fmt, date: "$created_at", timezone: "Asia/Bangkok" } },
      shadow_reply_id: 1, bot_handoff_required: 1, handoff_review: 1, review_bubbles: 1,
    } },
  ];
  const [replyAgg, bubbleAgg, total] = await Promise.all([
    replies.aggregate<Record<string, unknown>>([
      ...baseStages,
      { $group: {
        _id: "$bucket",
        drafts: { $sum: 1 },
        handoff_requested: { $sum: { $cond: [{ $eq: ["$bot_handoff_required", true] }, 1, 0] } },
        handoff_pending: { $sum: { $cond: [{ $eq: ["$handoff_review.status", "pending"] }, 1, 0] } },
        handoff_approved: { $sum: { $cond: [{ $eq: ["$handoff_review.status", "approved"] }, 1, 0] } },
        handoff_rejected: { $sum: { $cond: [{ $eq: ["$handoff_review.status", "rejected"] }, 1, 0] } },
      } }, { $sort: { _id: 1 } },
    ]).toArray(),
    replies.aggregate<Record<string, unknown>>([
      ...baseStages,
      { $unwind: "$review_bubbles" },
      { $group: {
        _id: "$bucket",
        bubbles: { $sum: 1 },
        pending: { $sum: { $cond: [{ $eq: ["$review_bubbles.decision", "pending"] }, 1, 0] } },
        approved: { $sum: { $cond: [{ $eq: ["$review_bubbles.decision", "approved"] }, 1, 0] } },
        edited_approved: { $sum: { $cond: [{ $eq: ["$review_bubbles.decision", "edited_approved"] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ["$review_bubbles.decision", "rejected"] }, 1, 0] } },
        live_sent: { $sum: { $cond: [{ $eq: ["$review_bubbles.delivery.state", "live_sent"] }, 1, 0] } },
        not_sent_switch_off: { $sum: { $cond: [{ $eq: ["$review_bubbles.delivery.state", "not_sent_switch_off"] }, 1, 0] } },
        mock_sent: { $sum: { $cond: [{ $eq: ["$review_bubbles.delivery.state", "mock_sent"] }, 1, 0] } },
        failed_or_unknown: { $sum: { $cond: [{ $in: ["$review_bubbles.delivery.state", ["mock_failed", "live_failed", "live_unknown"]] }, 1, 0] } },
      } }, { $sort: { _id: 1 } },
    ]).toArray(),
    replies.countDocuments(match),
  ]);
  const byBucket = new Map<string, Record<string, number | string>>();
  for (const row of replyAgg) {
    const bucket = String(row._id);
    byBucket.set(bucket, {
      period: bucket,
      drafts: Number(row.drafts || 0),
      handoff_requested: Number(row.handoff_requested || 0),
      handoff_pending: Number(row.handoff_pending || 0),
      handoff_approved: Number(row.handoff_approved || 0),
      handoff_rejected: Number(row.handoff_rejected || 0),
    });
  }
  for (const row of bubbleAgg) {
    const bucket = String(row._id);
    const existing = byBucket.get(bucket) || { period: bucket, drafts: 0, handoff_requested: 0, handoff_pending: 0, handoff_approved: 0, handoff_rejected: 0 };
    for (const key of ["bubbles", "pending", "approved", "edited_approved", "rejected", "live_sent", "not_sent_switch_off", "mock_sent", "failed_or_unknown"]) {
      existing[key] = Number(row[key] || 0);
    }
    byBucket.set(bucket, existing);
  }
  const series = [...byBucket.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));

  const rows = await replies.find(match).sort({ created_at: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
  const replyIds = rows.map((row) => row.shadow_reply_id).filter(Boolean);
  const eventRows = replyIds.length
    ? await events.find({
        $or: [
          { "metadata.reply_id": { $in: replyIds } },
          { "metadata.shadow_reply_id": { $in: replyIds } },
          { "metadata.request.reply_id": { $in: replyIds } },
        ],
      }).sort({ created_at: 1 }).toArray()
    : [];
  const timelineByReply = new Map<string, BotworkerEventDoc[]>();
  for (const event of eventRows) {
    const request = event.metadata?.request as Record<string, unknown> | undefined;
    const replyId = String(event.metadata?.reply_id || event.metadata?.shadow_reply_id || request?.reply_id || "");
    if (!replyId || !replyIds.includes(replyId)) continue;
    const list = timelineByReply.get(replyId) || [];
    list.push(event);
    timelineByReply.set(replyId, list);
  }
  const items = rows.map((row) => ({
    reply_id: row.shadow_reply_id,
    conversation_id: row.conversation_id,
    shop_id: row.shop_id,
    created_at: row.created_at,
    inbound_text: row.inbound_text || "",
    bot_reply_text: row.bot_reply_text || "",
    bot_source: row.bot_source,
    chat_engine: row.chat_engine,
    bot_handoff_required: row.bot_handoff_required === true,
    handoff_reason: row.bot_handoff_reason || row.bot_handoff_category,
    handoff_explanation: row.bot_handoff_explanation,
    handoff_review: row.handoff_review,
    review_bubbles: (row.review_bubbles || []).map((bubble) => ({
      bubble_id: bubble.bubble_id,
      original_text: bubble.original_text,
      edited_text: bubble.edited_text,
      approved_text: bubble.approved_text,
      decision: bubble.decision,
      decided_by: bubble.decided_by,
      decided_by_name: bubble.decided_by_name,
      decided_at: bubble.decided_at,
      rejection_reason: bubble.rejection_reason,
      edit_history: bubble.edit_history,
      delivery: bubble.delivery,
    })),
    timeline: (() => {
      const events = timelineByReply.get(row.shadow_reply_id) || [];
      const unique = new Map<string, BotworkerEventDoc>();
      for (const event of events) {
        const eventId = String(event.event_id || "");
        const operationId = event.type === "review_op" ? eventId.replace(/^reviewop:/, "")
          : event.type === "review_action" ? eventId.replace(/^reviewaction:/, "") : "";
        const key = operationId ? `review:${operationId}` : eventId;
        const current = unique.get(key);
        if (!current || event.type === "review_action") unique.set(key, event);
      }
      return [...unique.values()].map((event) => ({
        type: event.type === "review_op" ? "review_action" : event.type,
        actor: event.actor, actor_name: event.metadata?.actor_name || event.metadata?.reviewer_name,
        created_at: event.created_at,
        metadata: {
          ...event.metadata,
          action: event.metadata?.action || (event.metadata?.request as Record<string, unknown> | undefined)?.action,
          op_status: event.type === "review_op" ? event.metadata?.status : undefined,
        },
      }));
    })(),
  }));
  return { series, items, page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize), timezone: "Asia/Bangkok" };
}
