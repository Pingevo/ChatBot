// Admin activity log service — extends the existing `admin_logs` collection
// (previously scoped to ticket_id + admin_id + timestamp only) to also record
// general admin actions (trigger/KB/user management/etc.), needed for the
// "การทำงานของแอดมิน" statistics page. `ticket_id` is now optional.
import { createHash } from "node:crypto";
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { safeRegexSearch } from "../lib/regexEscape";

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
  | "user.assign_role"
  | "user.reset_password"
  | "ticket.create"
  | "ticket.update"
  | "ticket.delete"
  | "conversation.reply"
  | "conversation.handoff"
  | "conversation.resolve"
  | "conversation.claim_outcome"
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
  | "admin_config.update"
  | "admin.maintenance.clear_status"
  | "bot.buffer_flush"
  | "bot.buffer_recover"
  | "bot.recovery_quarantine"
  // ⚡ Workflow engine (แบบ Zaapi Flow Builder)
  | "workflow.create"
  | "workflow.update"
  | "workflow.delete"
  | "workflow.restore"
  | "workflow.toggle"
  | "workflow.import_apply"
  | "workflow.cas_save"
  | "workflow.run_completed"
  | "workflow.run_errored"
  | "workflow.run_timeout"
  | "workflow.run_cancelled"
  | "workflow.assign_ticket"
  | "workflow.add_label"
  | "workflow.add_note"
  | "workflow.send_http_blocked"
  | "workflow.resume"
  | "workflow.wait_retry"
  | "workflow.wait_no_reply"
  | "shadow_reply.generate"
  | "shadow_reply.generate_conversation"
  | "shadow_reply.batch_roll"
  | "shadow_reply.rate"
  | "shadow_reply.clear_all"
  | "shadow_reply.delete"
  | "shadow_reply.delete_conversation"
  | "shadow_reply.restore"
  | "shadow_reply.restore_all"
  | "shadow_reply.restore_conversation"
  | "assignment.platform_team_add"
  | "assignment.platform_team_remove"
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
  | "shadow_reply.batch_roll"
  | "shadow_reply.rate"
  | "shadow_reply.delete"
  | "shadow_reply.delete_conversation"
  | "shadow_reply.clear_all"
  | "shadow_reply.restore"
  | "shadow_reply.restore_all"
  | "shadow_reply.restore_conversation"
  | "test_chat.rate"
  | "test_assignment.rate_message"
  | "test_assignment.rate_conversation"
  | "test_assignment.replay"
  | "test_assignment.batch_roll"
  | "test_assignment.soft_delete"
  | "test_assignment.restore"
  | "test_assignment.batch_roll"
  | "test_assignment.soft_delete"
  | "test_assignment.restore"
  // Live assignment — จ่ายงานจริง + admin reply + close + reopen
  | "live_assignment.batch_replay"
  | "live_assignment.admin_reply"
  | "live_assignment.close_chat"
  | "live_assignment.reopen_process"
  // Phase 3B-1 — chat annotations (markup dot + note)
  | "chat_annotation.upsert"
  | "chat_annotation.delete"
  // Phase 3 — per-shop bot persona management
  | "shop_persona.create"
  | "shop_persona.update"
  | "shop_persona.delete"
  | "shop_persona.toggle"
  // Phase 10 — per-shop behavior settings (faq_liveagent, etc.)
  | "shop_settings.create"
  | "shop_settings.update"
  | "shop_settings.delete"
  // Chat accept/pause — admin เปิด/ปิดรับแชท
  | "chat_accept.start"
  | "chat_accept.stop"
  // ⚡ backlog distributor — commit batch จ่ายงานค้าง
  | "backlog_commit"
  // ⚡ Phase 2M — conversation metadata changes (ใครทำอะไร)
  | "conversation.set_topic"
  | "conversation.set_item_ids"
  | "conversation.pin"
  | "conversation.unpin";

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
  // ⚡ eventId — deterministic dedupe identity (inbound lifecycle audit):
  //   _id = "adminlog:event:" + sha256([action, conversation_id, eventId])[:32]
  //   E11000 + matching stored identity → already-logged (idempotent converge)
  //   E11000 + mismatched identity / non-E11000 → throw (never blindly swallowed)
  //   no eventId → auto _id + identical legacy behavior (no extra read)
  eventId?: string;
}): Promise<void> {
  const coll = await getCollection<AdminLogDoc>(COLLECTIONS.adminLogs);
  const doc: AdminLogDoc = {
    admin_id: opts.actor === "system" ? "system" : opts.actor,
    action_type: opts.action_type,
    actor: opts.actor,
    target_admin_id: opts.target_admin_id,
    conversation_id: opts.conversation_id,
    shop_id: opts.shop_id,
    metadata: opts.eventId
      ? { ...(opts.metadata || {}), message_id: opts.eventId }
      : opts.metadata || {},
    ip: opts.ip,
    timestamp: new Date(),
  };
  if (opts.eventId) {
    doc._id = "adminlog:event:" + createHash("sha256")
      .update(JSON.stringify([opts.action_type, opts.conversation_id ?? "", opts.eventId]))
      .digest("hex").slice(0, 32) as AdminLogDoc["_id"];
  }
  try {
    await coll.insertOne(doc);
  } catch (e) {
    if ((e as { code?: number })?.code !== 11000 || !opts.eventId) throw e;
    const existing = await coll.findOne({ _id: doc._id } as Document);
    const same = !!existing
      && existing.action_type === doc.action_type
      && (existing.conversation_id ?? "") === (doc.conversation_id ?? "")
      && existing.metadata?.message_id === opts.eventId;
    if (!same) throw e;
  }
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
 *
 * pagination owner เดียวของ /logs — caller ส่ง page/pageSize (+ server filters)
 * ได้ {rows,page,pageSize,total,totalPages} กลับ
 *
 * pipeline order: $match(base+search) → $sort → $facet
 * — $lookup ต้องอยู่ใน facet.rows หลัง $skip/$limit เสมอ — join เฉพาะ rows ที่แสดง
 *   (ห้าม join ก่อน paginate: poll หน้า 1 ทุก 5s จะ join admins ทั้ง collection ต่อ request)
 * — search ครอบ joined username/name → resolve admin_ids ผ่าน find() 1 query แล้ว
 *   fold เข้า $or ของ base $match (raw log fields + admin_id $in) ก่อน sort
 * — $facet นับ total ใน pipeline เดียวกัน (ห้าม countDocuments แยก filter คนละชุด)
 */
export async function listAdminLogsExtended(opts: {
  adminId?: string;
  actionType?: AdminActionType | string;
  actionTypes?: string[];
  since?: Date;
  search?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<{
  rows: (AdminLogDoc & { username?: string; name?: string })[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}> {
  const coll = await getCollection<AdminLogDoc>(COLLECTIONS.adminLogs);
  const p = opts.page ?? 1;
  const ps = opts.pageSize ?? 100;
  const page = Math.max(Number.isFinite(p) ? Math.floor(p) : 1, 1);
  const pageSize = Math.min(Math.max(Number.isFinite(ps) ? Math.floor(ps) : 100, 1), 100);
  const filter: Record<string, unknown> = {};
  if (opts.adminId) filter.admin_id = opts.adminId;
  if (opts.actionType) filter.action_type = opts.actionType;
  else if (opts.actionTypes?.length) filter.action_type = { $in: opts.actionTypes };
  if (opts.since) filter.timestamp = { $gte: opts.since };
  const q = safeRegexSearch(opts.search);
  if (q) {
    // username/name อยู่ใน admins — resolve admin_ids ด้วย regex เดียวกัน (≤1 query)
    const adminsColl = await getCollection<{ admin_id: string }>(COLLECTIONS.admins);
    const rx = { $regex: q, $options: "i" };
    const matched = await adminsColl
      .find({ $or: [{ username: rx }, { name: rx }] }, { projection: { admin_id: 1 } })
      .toArray();
    filter.$or = [
      ...["action_type", "admin_id", "conversation_id", "shop_id", "ticket_id", "target_admin_id"].map((f) => ({ [f]: rx })),
      ...(matched.length ? [{ admin_id: { $in: matched.map((a) => a.admin_id) } }] : []),
    ];
  }
  const pipeline = [
    { $match: filter },
    { $sort: { timestamp: -1 as const, _id: -1 as const } },
    {
      $facet: {
        // paginate ก่อน join — $lookup เห็นเฉพาะ rows ของหน้านี้
        rows: [
          { $skip: (page - 1) * pageSize },
          { $limit: pageSize },
          {
            $lookup: {
              from: COLLECTIONS.admins,
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
        ],
        meta: [{ $count: "count" }],
      },
    },
  ];
  const [result] = await coll
    .aggregate<{ rows: (AdminLogDoc & { username?: string; name?: string })[]; meta: { count: number }[] }>(pipeline)
    .toArray();
  const total = result?.meta?.[0]?.count ?? 0;
  return { rows: result?.rows ?? [], page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
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
