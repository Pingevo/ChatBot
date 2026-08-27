// Admin activity log service — extends the existing `admin_logs` collection
// (previously scoped to ticket_id + admin_id + timestamp only) to also record
// general admin actions (trigger/KB/user management/etc.), needed for the
// "การทำงานของแอดมิน" statistics page. `ticket_id` is now optional.
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";

export type AdminActionType =
  | "login"
  | "logout"
  | "trigger.create"
  | "trigger.update"
  | "trigger.delete"
  | "trigger.toggle"
  | "kb.create"
  | "kb.update"
  | "kb.delete"
  | "kb.toggle"
  | "kb.import_excel"
  | "user.create"
  | "user.update"
  | "user.delete"
  | "user.toggle_active"
  | "user.reset_password"
  | "ticket.create"
  | "ticket.update"
  | "ticket.delete"
  | "conversation.reply"
  | "conversation.handoff"
  | "conversation.resolve"
  // Phase 0 — assignment events (adapted from ChatBotPDigg AuditLog)
  | "chat_assigned"
  | "chat_reassigned"
  | "conversation.open"
  | "conversation.close"
  | "agent.pause"
  | "agent.resume"
  | "agent_auto_paused"
  | "sla.alert"
  | "sla.reassign"
  // Phase 3 — config & team management events
  | "config.update"
  | "config.shop_toggle"
  | "config.test_integration"
  | "assignment.mode_change"
  | "assignment.shop_team_add"
  | "assignment.shop_team_remove"
  | "assignment.platform_team_add"
  | "assignment.platform_team_remove"
  // Chat events
  | "bot.reply"
  | "bot.handoff_to_admin"
  | "admin.reply"
  | "conversation.status_change"
  // Quick reply events
  | "quick_reply.create"
  | "quick_reply.update"
  | "quick_reply.delete"
  | "quick_reply.use"
  // Phase 7 — data writer + bot processing logs
  | "data_writer.message_received"
  | "data_writer.conversation_upserted"
  | "data_writer.duplicate_message"
  | "bot.process_started"
  | "bot.process_completed"
  | "bot.process_failed"
  | "bot.guard_violation"
  | "bot.idempotency_skip"
  | "platform_api.blocked"
  // Shadow inbox — bot vs zaapi comparison (never sent to platform)
  | "shadow_reply.generate"
  | "shadow_reply.generate_conversation"
  | "shadow_reply.rate"
  | "shadow_reply.delete"
  // Chat accept/pause — admin เปิด/ปิดรับแชท
  | "chat_accept.start"
  | "chat_accept.stop";

export interface AdminLogDoc extends Document {
  admin_id: string;
  action_type: AdminActionType;
  ticket_id?: string;
  meta?: Record<string, unknown>;
  ip?: string;
  timestamp: Date;
  // Phase 0 — extended fields for assignment/audit events
  actor?: string;
  target_admin_id?: string | null;
  conversation_id?: string;
  shop_id?: string;
  metadata?: Record<string, unknown>;
}

export async function logAdminAction(opts: {
  adminId: string;
  actionType: AdminActionType;
  ticketId?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  const coll = await getCollection<AdminLogDoc>(COLLECTIONS.adminLogs);
  await coll.insertOne({
    admin_id: opts.adminId,
    action_type: opts.actionType,
    ticket_id: opts.ticketId,
    meta: opts.meta || {},
    ip: opts.ip,
    timestamp: new Date(),
  });
}

/**
 * Log assignment/audit events — adapted from ChatBotPDigg AuditLog
 * ใช้สำหรับเหตุการณ์ที่ actor อาจเป็น "system" ไม่ใช่ admin เสมอ
 * (เช่น auto-assignment, SLA timeout, agent auto-pause)
 */
export async function logAdminEvent(opts: {
  action_type: AdminActionType;
  actor: string;
  target_admin_id?: string | null;
  conversation_id?: string;
  shop_id?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  const coll = await getCollection<AdminLogDoc>(COLLECTIONS.adminLogs);
  await coll.insertOne({
    admin_id: opts.actor === "system" ? "system" : opts.actor,
    action_type: opts.action_type,
    actor: opts.actor,
    target_admin_id: opts.target_admin_id,
    conversation_id: opts.conversation_id,
    shop_id: opts.shop_id,
    metadata: opts.metadata || {},
    ip: opts.ip,
    timestamp: new Date(),
  });
}

/**
 * Phase 7 — log bot processing events
 * ใช้เมื่อ bot pipeline ทำงาน (process_started/completed/failed)
 * รักษา identity: platform, conversation_id, shop_id
 */
export async function logBotEvent(opts: {
  action_type:
    | "bot.process_started"
    | "bot.process_completed"
    | "bot.process_failed"
    | "bot.guard_violation"
    | "bot.idempotency_skip"
    | "platform_api.blocked";
  conversation_id: string;
  shop_id: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await logAdminEvent({
    action_type: opts.action_type,
    actor: "system",
    conversation_id: opts.conversation_id,
    shop_id: opts.shop_id,
    metadata: opts.metadata,
  });
}

/**
 * Phase 7 — log data writer events (sellcenter เขียนลง DB)
 */
export async function logDataWriterEvent(opts: {
  action_type:
    | "data_writer.message_received"
    | "data_writer.conversation_upserted"
    | "data_writer.duplicate_message";
  conversation_id?: string;
  shop_id?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await logAdminEvent({
    action_type: opts.action_type,
    actor: "system",
    conversation_id: opts.conversation_id,
    shop_id: opts.shop_id,
    metadata: opts.metadata,
  });
}

export async function listAdminLogs(opts: {
  adminId?: string;
  actionType?: AdminActionType;
  since?: Date;
  limit?: number;
} = {}): Promise<AdminLogDoc[]> {
  const coll = await getCollection<AdminLogDoc>(COLLECTIONS.adminLogs);
  const filter: Record<string, unknown> = {};
  if (opts.adminId) filter.admin_id = opts.adminId;
  if (opts.actionType) filter.action_type = opts.actionType;
  if (opts.since) filter.timestamp = { $gte: opts.since };
  return coll
    .find(filter)
    .sort({ timestamp: -1 })
    .limit(opts.limit || 200)
    .toArray();
}

/**
 * Phase 7.10 — list logs + join username/name จาก admins collection
 * สำหรับ log viewer ที่ต้องแสดงชื่อคน ไม่ใช่แค่ admin_id
 */
export async function listAdminLogsExtended(opts: {
  adminId?: string;
  actionType?: AdminActionType | string;
  since?: Date;
  limit?: number;
} = {}): Promise<(AdminLogDoc & { username?: string; name?: string })[]> {
  const coll = await getCollection<AdminLogDoc>(COLLECTIONS.adminLogs);
  const filter: Record<string, unknown> = {};
  if (opts.adminId) filter.admin_id = opts.adminId;
  if (opts.actionType) filter.action_type = opts.actionType;
  if (opts.since) filter.timestamp = { $gte: opts.since };
  const pipeline = [
    { $match: filter },
    { $sort: { timestamp: -1 } },
    { $limit: opts.limit || 200 },
    {
      $lookup: {
        from: "admins",
        localField: "admin_id",
        foreignField: "admin_id",
        as: "_admin",
      },
    },
    {
      $addFields: {
        username: { $arrayElemAt: ["$_admin.username", 0] },
        name: { $arrayElemAt: ["$_admin.name", 0] },
      },
    },
    { $project: { _admin: 0 } },
  ];
  return coll.aggregate<AdminLogDoc & { username?: string; name?: string }>(pipeline).toArray();
}

/** Aggregate action counts per admin — powers the "การทำงานของแอดมิน" page. */
export async function getAdminActivitySummary(
  since?: Date
): Promise<{ admin_id: string; total_actions: number; by_type: Record<string, number>; last_action_at: Date }[]> {
  const coll = await getCollection<AdminLogDoc>(COLLECTIONS.adminLogs);
  const match: Record<string, unknown> = since ? { timestamp: { $gte: since } } : {};
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { admin_id: "$admin_id", action_type: "$action_type" },
        count: { $sum: 1 },
        last_action_at: { $max: "$timestamp" },
      },
    },
    {
      $group: {
        _id: "$_id.admin_id",
        total_actions: { $sum: "$count" },
        by_type: { $push: { k: "$_id.action_type", v: "$count" } },
        last_action_at: { $max: "$last_action_at" },
      },
    },
    { $sort: { total_actions: -1 as const } },
  ];
  const results = await coll.aggregate(pipeline).toArray();
  return results.map((r) => ({
    admin_id: r._id as string,
    total_actions: r.total_actions,
    by_type: Object.fromEntries((r.by_type as { k: string; v: number }[]).map((x) => [x.k, x.v])),
    last_action_at: r.last_action_at,
  }));
}

export const adminLogService = {
  logAdminAction,
  logAdminEvent,
  logBotEvent,
  logDataWriterEvent,
  listAdminLogs,
  listAdminLogsExtended,
  getAdminActivitySummary,
};
