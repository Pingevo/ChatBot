// Bot performance analysis — read-only over BotWorker replies (shadow_replies origin worker/workflow) + botworker_events.
// loadRows: one row per bot reply with per-answer review outcome, edit %, reasons and reviewer timing (Bangkok dates).
// getBotPerformanceSummary: KPI / series / distributions / per-reviewer / per-shop over date+shop scope.
// getBotPerformanceItems: filtered + paginated rows with linked event timeline. exportBotPerformance: CSV / JSONL.
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { ShadowReplyDoc } from "./shadowReplyService";
import type { BotworkerEventDoc } from "./botworkerEventService";
import { editPercent } from "@/lib/textDiff";

export type PerfGroup = "day" | "week" | "month";
export type PerfOutcome = "approved" | "edited" | "rejected" | "pending" | "none";
export type PerfHandoff = "none" | "requested" | "approved" | "rejected" | "pending";

export interface PerfScope { from: string; to: string; shopId?: string }
export interface PerfFilters extends PerfScope {
  outcome?: PerfOutcome;
  handoff?: PerfHandoff;
  reviewer?: string;
  minEditPct?: number;
  q?: string;
}

const MAX_ROWS = 20_000;
const EXPORT_LIMIT = 5_000;
const DAY_MS = 86_400_000;
const BKK_OFFSET_MS = 7 * 3_600_000;

function bangkokStart(date: string): Date {
  return new Date(`${date}T00:00:00.000+07:00`);
}

function bangkokDay(at: Date): string {
  return new Date(at.getTime() + BKK_OFFSET_MS).toISOString().slice(0, 10);
}

function bucketOf(at: Date, group: PerfGroup): string {
  const day = bangkokDay(at);
  if (group === "month") return day.slice(0, 7);
  if (group === "day") return day;
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function topCounts(values: string[], limit = 10): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value.trim().replace(/\s+/g, " ");
    if (label) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, count]) => ({ label, count }));
}

function scopeRange(scope: PerfScope): { start: Date; end: Date } {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(scope.from) || !datePattern.test(scope.to)) throw new Error("invalid_date_range");
  const start = bangkokStart(scope.from);
  const end = new Date(bangkokStart(scope.to).getTime() + DAY_MS);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error("invalid_date_range");
  if (end.getTime() - start.getTime() > 5 * 366 * DAY_MS) throw new Error("date_range_too_large");
  return { start, end };
}

function toRow(doc: ShadowReplyDoc) {
  const createdAt = new Date(doc.created_at);
  const bubbles = (doc.review_bubbles || []).map((bubble) => {
    const finalText = bubble.approved_text ?? bubble.edited_text ?? bubble.original_text;
    const outboundText = bubble.delivery?.outbound_text ??
      (["live_sent", "live_unknown"].includes(bubble.delivery?.state || "") ? finalText : undefined);
    const decidedAt = bubble.decided_at ? new Date(bubble.decided_at) : null;
    return {
      bubble_id: bubble.bubble_id,
      original_text: bubble.original_text,
      final_text: finalText,
      decision: bubble.decision,
      edit_pct: bubble.decision === "edited_approved" ? editPercent(bubble.original_text, finalText) : 0,
      decided_by: bubble.decided_by,
      decided_by_name: bubble.decided_by_name,
      decided_at: decidedAt,
      review_minutes: decidedAt ? Math.max(0, (decidedAt.getTime() - createdAt.getTime()) / 60_000) : null,
      rejection_category: bubble.rejection_category,
      rejection_reason: bubble.rejection_reason,
      edit_history: bubble.edit_history,
      delivery_state: bubble.delivery?.state || "not_requested",
      outbound_text: outboundText,
      card_item_id: bubble.card?.item_id,
      card_delivery_state: bubble.card?.delivery?.state || "not_requested",
    };
  });
  const decisions = bubbles.map((b) => b.decision);
  const outcome: PerfOutcome = !bubbles.length ? "none"
    : decisions.includes("pending") ? "pending"
    : decisions.includes("rejected") ? "rejected"
    : decisions.includes("edited_approved") ? "edited" : "approved";
  const review = doc.handoff_review;
  const handoff: PerfHandoff = !doc.bot_handoff_required ? "none"
    : review?.status === "approved" ? "approved"
    : review?.status === "rejected" ? "rejected"
    : review ? "pending" : "requested";
  const reviewers = [...new Set([...bubbles.map((b) => b.decided_by_name || b.decided_by), review?.reviewed_by_name || review?.reviewed_by].filter(Boolean) as string[])];
  const reviewMinutes = bubbles.map((b) => b.review_minutes).filter((v): v is number => v !== null);
  return {
    reply_id: doc.shadow_reply_id,
    conversation_id: doc.conversation_id,
    shop_id: doc.shop_id,
    origin: doc.origin,
    chat_engine: (doc as { chat_engine?: string }).chat_engine,
    created_at: createdAt,
    inbound_text: doc.inbound_text || "",
    bot_reply_text: doc.bot_reply_text || "",
    outcome,
    handoff,
    handoff_reason: doc.bot_handoff_reason || doc.bot_handoff_category || "",
    handoff_explanation: doc.bot_handoff_explanation || "",
    handoff_reviewed_by: review?.reviewed_by_name || review?.reviewed_by,
    handoff_reviewed_at: review?.reviewed_at ? new Date(review.reviewed_at) : null,
    handoff_rejection_category: review?.rejection_category || "",
    handoff_rejection_reason: review?.rejection_reason || "",
    handoff_assigned_to: review?.selected_admin_name || review?.selected_admin_id || "",
    needs_human: handoff === "approved" || outcome === "edited" || outcome === "rejected",
    max_edit_pct: Math.max(0, ...bubbles.map((b) => b.edit_pct)),
    review_minutes: reviewMinutes.length ? Math.max(...reviewMinutes) : null,
    reviewers,
    admin_reasons: [
      ...bubbles.flatMap((b) => b.rejection_reason ? [`${b.rejection_category ? `${b.rejection_category}: ` : ""}${b.rejection_reason}`] : []),
      ...(review?.rejection_reason ? [`${review.rejection_category ? `${review.rejection_category}: ` : ""}${review.rejection_reason}`] : []),
    ],
    bubbles,
  };
}
export type PerfRow = ReturnType<typeof toRow>;

async function loadRows(scope: PerfScope): Promise<{ rows: PerfRow[]; truncated: boolean }> {
  const { start, end } = scopeRange(scope);
  const replies = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const match: Record<string, unknown> = {
    origin: { $in: ["worker", "workflow"] }, deleted_at: { $exists: false }, created_at: { $gte: start, $lt: end },
  };
  if (scope.shopId) match.shop_id = scope.shopId;
  const docs = await replies.find(match).sort({ created_at: -1, _id: -1 }).limit(MAX_ROWS + 1).toArray();
  return { rows: docs.slice(0, MAX_ROWS).map(toRow), truncated: docs.length > MAX_ROWS };
}

function applyFilters(rows: PerfRow[], filters: PerfFilters): PerfRow[] {
  const q = filters.q?.trim().toLowerCase();
  return rows.filter((row) =>
    (!filters.outcome || row.outcome === filters.outcome)
    && (!filters.handoff || (filters.handoff === "requested" ? row.handoff !== "none" : row.handoff === filters.handoff))
    && (!filters.reviewer || row.reviewers.includes(filters.reviewer))
    && (!filters.minEditPct || row.max_edit_pct >= filters.minEditPct)
    && (!q || [row.inbound_text, row.bot_reply_text, row.conversation_id, ...row.admin_reasons, ...row.bubbles.map((b) => b.final_text)]
      .some((text) => text.toLowerCase().includes(q))));
}

export async function getBotPerformanceSummary(scope: PerfScope & { group: PerfGroup }) {
  const { rows, truncated } = await loadRows(scope);
  const bubbles = rows.flatMap((row) => row.bubbles.map((bubble) => ({ ...bubble, row })));
  const decided = bubbles.filter((b) => b.decision !== "pending");
  const count = (decision: string) => bubbles.filter((b) => b.decision === decision).length;
  const edited = bubbles.filter((b) => b.decision === "edited_approved");
  const conversations = new Set(rows.map((r) => r.conversation_id));
  const humanConversations = new Set(rows.filter((r) => r.needs_human).map((r) => r.conversation_id));
  const handoffRows = rows.filter((r) => r.handoff !== "none");
  const handoffDecided = handoffRows.filter((r) => r.handoff === "approved" || r.handoff === "rejected");
  const reviewMinutes = decided.map((b) => b.review_minutes).filter((v): v is number => v !== null);

  const series = new Map<string, { period: string; replies: number; human: number; approved: number; edited: number; rejected: number; pending: number }>();
  for (const row of rows) {
    const period = bucketOf(row.created_at, scope.group);
    const entry = series.get(period) || { period, replies: 0, human: 0, approved: 0, edited: 0, rejected: 0, pending: 0 };
    entry.replies++;
    if (row.needs_human) entry.human++;
    for (const b of row.bubbles) {
      if (b.decision === "approved") entry.approved++;
      else if (b.decision === "edited_approved") entry.edited++;
      else if (b.decision === "rejected") entry.rejected++;
      else entry.pending++;
    }
    series.set(period, entry);
  }

  const reviewerMap = new Map<string, { name: string; decided: number; approved: number; edited: number; rejected: number; minutes: number[]; handoffs_reviewed: number; handoffs_received: number }>();
  const reviewerEntry = (name: string) => {
    const entry = reviewerMap.get(name) || { name, decided: 0, approved: 0, edited: 0, rejected: 0, minutes: [], handoffs_reviewed: 0, handoffs_received: 0 };
    reviewerMap.set(name, entry);
    return entry;
  };
  for (const b of decided) {
    const entry = reviewerEntry(b.decided_by_name || b.decided_by || "ไม่ระบุ");
    entry.decided++;
    if (b.decision === "approved") entry.approved++;
    if (b.decision === "edited_approved") entry.edited++;
    if (b.decision === "rejected") entry.rejected++;
    if (b.review_minutes !== null) entry.minutes.push(b.review_minutes);
  }
  for (const row of handoffDecided) {
    if (row.handoff_reviewed_by) reviewerEntry(row.handoff_reviewed_by).handoffs_reviewed++;
    if (row.handoff === "approved" && row.handoff_assigned_to) reviewerEntry(row.handoff_assigned_to).handoffs_received++;
  }

  const shopMap = new Map<string, PerfRow[]>();
  for (const row of rows) shopMap.set(row.shop_id, [...(shopMap.get(row.shop_id) || []), row]);

  return {
    truncated,
    timezone: "Asia/Bangkok",
    kpi: {
      replies: rows.length,
      conversations: conversations.size,
      bubbles: bubbles.length,
      decided: decided.length,
      approved: count("approved"),
      edited: edited.length,
      rejected: count("rejected"),
      pending: count("pending"),
      pass_rate: pct(count("approved"), decided.length),
      edited_rate: pct(edited.length, decided.length),
      rejected_rate: pct(count("rejected"), decided.length),
      avg_edit_pct: edited.length ? Math.round(edited.reduce((s, b) => s + b.edit_pct, 0) / edited.length * 10) / 10 : 0,
      human_replies: rows.filter((r) => r.needs_human).length,
      human_reply_rate: pct(rows.filter((r) => r.needs_human).length, rows.length),
      human_conversations: humanConversations.size,
      human_conversation_rate: pct(humanConversations.size, conversations.size),
      handoff_requested: handoffRows.length,
      handoff_rate: pct(handoffRows.length, rows.length),
      handoff_approved: handoffRows.filter((r) => r.handoff === "approved").length,
      handoff_rejected: handoffRows.filter((r) => r.handoff === "rejected").length,
      handoff_pending: handoffRows.length - handoffDecided.length,
      handoff_agree_rate: pct(handoffRows.filter((r) => r.handoff === "approved").length, handoffDecided.length),
      median_review_minutes: median(reviewMinutes),
      live_sent: bubbles.filter((b) => b.delivery_state === "live_sent").length,
      switch_off: bubbles.filter((b) => b.delivery_state === "not_sent_switch_off").length,
      delivery_failed: bubbles.filter((b) => ["live_failed", "live_unknown", "mock_failed"].includes(b.delivery_state)).length,
    },
    series: [...series.values()].sort((a, b) => a.period.localeCompare(b.period)).map((entry) => {
      const reviewed = entry.approved + entry.edited + entry.rejected;
      return { ...entry, pass_rate: pct(entry.approved, reviewed), human_rate: pct(entry.human, entry.replies) };
    }),
    edit_buckets: [["0–10%", 0, 10], ["10–30%", 10, 30], ["30–60%", 30, 60], ["60%+", 60, Infinity]].map(([label, min, max]) => ({
      label: label as string,
      count: edited.filter((b) => b.edit_pct >= (min as number) && b.edit_pct < (max as number)).length,
    })),
    rejection_reasons: topCounts(rows.flatMap((r) => r.admin_reasons)),
    handoff_reasons: topCounts(handoffRows.map((r) => r.handoff_reason || "ไม่ระบุ")),
    by_reviewer: [...reviewerMap.values()].map(({ minutes, ...entry }) => ({
      ...entry, pass_rate: pct(entry.approved, entry.decided), median_review_minutes: median(minutes),
    })).sort((a, b) => b.decided - a.decided),
    by_shop: [...shopMap.entries()].map(([shop_id, shopRows]) => {
      const shopBubbles = shopRows.flatMap((r) => r.bubbles).filter((b) => b.decision !== "pending");
      return {
        shop_id,
        replies: shopRows.length,
        conversations: new Set(shopRows.map((r) => r.conversation_id)).size,
        pass_rate: pct(shopBubbles.filter((b) => b.decision === "approved").length, shopBubbles.length),
        human_rate: pct(shopRows.filter((r) => r.needs_human).length, shopRows.length),
      };
    }).sort((a, b) => b.replies - a.replies),
    reviewers: [...new Set(rows.flatMap((r) => r.reviewers))].sort(),
    shops: [...shopMap.keys()].sort(),
  };
}

async function timelines(replyIds: string[]) {
  const byReply = new Map<string, BotworkerEventDoc[]>();
  if (!replyIds.length) return byReply;
  const events = await getCollection<BotworkerEventDoc>(COLLECTIONS.botworkerEvents);
  const rows = await events.find({
    $or: [
      { "metadata.reply_id": { $in: replyIds } },
      { "metadata.shadow_reply_id": { $in: replyIds } },
      { "metadata.request.reply_id": { $in: replyIds } },
    ],
  }).sort({ created_at: 1 }).toArray();
  for (const event of rows) {
    const request = event.metadata?.request as Record<string, unknown> | undefined;
    const replyId = String(event.metadata?.reply_id || event.metadata?.shadow_reply_id || request?.reply_id || "");
    if (replyIds.includes(replyId)) byReply.set(replyId, [...(byReply.get(replyId) || []), event]);
  }
  return byReply;
}

function toTimeline(events: BotworkerEventDoc[]) {
  // review_op and review_action describe the same operation; keep one per operation (prefer review_action).
  const unique = new Map<string, BotworkerEventDoc>();
  for (const event of events) {
    const eventId = String(event.event_id || "");
    const operationId = event.type === "review_op" ? eventId.replace(/^reviewop:/, "")
      : event.type === "review_action" ? eventId.replace(/^reviewaction:/, "") : "";
    const key = operationId ? `review:${operationId}` : eventId;
    if (!unique.has(key) || event.type === "review_action") unique.set(key, event);
  }
  return [...unique.values()].map((event) => ({
    type: event.type === "review_op" ? "review_action" : event.type,
    actor: event.actor,
    actor_name: (event.metadata?.actor_name || event.metadata?.reviewer_name) as string | undefined,
    created_at: event.created_at,
    action: (event.metadata?.action || (event.metadata?.request as Record<string, unknown> | undefined)?.action) as string | undefined,
    rejection_category: event.metadata?.rejection_category as string | undefined,
    rejection_reason: event.metadata?.rejection_reason as string | undefined,
    assigned_to_name: event.metadata?.assigned_to_name as string | undefined,
  }));
}

export async function getBotPerformanceItems(filters: PerfFilters & { page?: number; pageSize?: number }) {
  const { rows, truncated } = await loadRows(filters);
  const filtered = applyFilters(rows, filters);
  const pageSize = Math.max(10, Math.min(100, Math.floor(filters.pageSize || 25)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.max(1, Math.min(totalPages, Math.floor(filters.page || 1)));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const byReply = await timelines(pageRows.map((r) => r.reply_id));
  return {
    items: pageRows.map((row) => ({ ...row, timeline: toTimeline(byReply.get(row.reply_id) || []) })),
    page, page_size: pageSize, total: filtered.length, total_pages: totalPages, truncated,
  };
}

function csvCell(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function exportBotPerformance(filters: PerfFilters, format: "csv" | "jsonl"): Promise<{ body: string; truncated: boolean }> {
  const { rows, truncated } = await loadRows(filters);
  const filtered = applyFilters(rows, filters);
  const out = filtered.slice(0, EXPORT_LIMIT);
  const isTruncated = truncated || filtered.length > EXPORT_LIMIT;
  if (format === "jsonl") return { body: out.map((row) => JSON.stringify(row)).join("\n"), truncated: isTruncated };
  const header = ["created_at", "shop_id", "conversation_id", "reply_id", "inbound_text", "bot_reply_text", "final_text", "outbound_text", "delivery_state", "outcome", "max_edit_pct",
    "admin_reasons", "handoff", "handoff_reason", "handoff_explanation", "handoff_assigned_to", "reviewers", "review_minutes"];
  const lines = out.map((row) => [
    row.created_at, row.shop_id, row.conversation_id, row.reply_id, row.inbound_text, row.bot_reply_text,
    row.bubbles.map((b) => b.final_text).join("\n---\n"), row.bubbles.map((b) => b.outbound_text ?? "").join("\n---\n"),
    row.bubbles.map((b) => b.delivery_state).join("\n---\n"), row.outcome, row.max_edit_pct, row.admin_reasons.join(" | "),
    row.handoff, row.handoff_reason, row.handoff_explanation, row.handoff_assigned_to, row.reviewers.join(" | "),
    row.review_minutes === null ? "" : Math.round(row.review_minutes),
  ].map(csvCell).join(","));
  return { body: "\uFEFF" + [header.join(","), ...lines].join("\n"), truncated: isTruncated };
}
