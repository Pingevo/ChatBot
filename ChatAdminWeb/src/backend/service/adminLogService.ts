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
  | "conversation.resolve";

export interface AdminLogDoc extends Document {
  admin_id: string;
  action_type: AdminActionType;
  ticket_id?: string;
  meta?: Record<string, unknown>;
  ip?: string;
  timestamp: Date;
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
  listAdminLogs,
  getAdminActivitySummary,
};
