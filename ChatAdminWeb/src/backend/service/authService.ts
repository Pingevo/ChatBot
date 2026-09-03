// Auth logic — server-side only.
// Handles: SSO login, session, logout, admin CRUD.
// ⚠️ ระบบใช้ SSO ขององค์กร — ไม่มี signin/signup/reset/OTP ผ่าน API ของเราอีกต่อไม
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { hashPassword } from "../lib/password";
import {
  createSessionToken,
  verifySessionToken,
  hashToken,
} from "../lib/jwt";
import { serverConfig } from "../lib/config";
import { logAdminEvent } from "./adminLogService";

export interface AdminDoc extends Document {
  admin_id: string;
  email: string;
  username: string;
  name: string;
  role: "superadmin" | "admin" | "dev";
  password_hash?: string;  // SSO-only — ไม่จำเป็นแล้ว แต่เก็บไว้สำหรับ admin เก่า
  active: boolean;
  // Phase 7.9 — admin เปิด/ปิดสถานะรับแชทของตัวเอง (ลาหยุด, พัก)
  is_accepting_chats?: boolean;
  channels_access?: string[];
  failed_login_count?: number;
  locked_until?: Date | null;
  last_login_at?: Date | null;
  last_login_ip?: string;
  created_at: Date;
  created_by?: string;
  // Soft delete
  is_deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string;
}

export interface SafeAdmin {
  admin_id: string;
  email: string;
  username: string;
  name: string;
  role: "superadmin" | "admin" | "dev";
  channels_access: string[];
  active: boolean;
  is_accepting_chats?: boolean;
  last_login_at: string | null;
  created_at: string;
}

function safeAdmin(admin: AdminDoc): SafeAdmin {
  return {
    admin_id: admin.admin_id,
    email: admin.email,
    username: admin.username,
    name: admin.name,
    role: admin.role,
    channels_access: admin.channels_access || [],
    active: admin.active ?? true,
    is_accepting_chats: admin.is_accepting_chats ?? true,
    last_login_at: admin.last_login_at ? admin.last_login_at.toISOString() : null,
    created_at: admin.created_at ? admin.created_at.toISOString() : "",
  };
}

function genAdminId(): string {
  return "adm_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

// ---- Lookups ----

export async function getAdminByEmail(email: string): Promise<AdminDoc | null> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  return coll.findOne({ email: email.toLowerCase(), is_deleted: { $ne: true } });
}

export async function getAdminByUsername(username: string): Promise<AdminDoc | null> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  return coll.findOne({ username, is_deleted: { $ne: true } });
}

export async function getAdminById(adminId: string): Promise<AdminDoc | null> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  return coll.findOne({ admin_id: adminId });
}

// ---- Login tracking (SSO only — no password login) ----

export async function recordLoginSuccess(adminId: string, ip: string): Promise<void> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  await coll.updateOne(
    { admin_id: adminId },
    {
      $set: {
        failed_login_count: 0,
        locked_until: null,
        last_login_at: new Date(),
        last_login_ip: ip,
      },
    }
  );
}

// ---- Admin creation ----

export async function createAdmin(opts: {
  email: string;
  username: string;
  password?: string;  // SSO-only — ไม่จำเป็น แต่ SSO callback ยังส่ง random password มา (จะ unset ทีหลัง)
  name?: string;
  role?: "superadmin" | "admin" | "dev";
  createdBy?: string;
}): Promise<AdminDoc> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const passwordHash = opts.password ? await hashPassword(opts.password) : undefined;
  const doc: AdminDoc = {
    admin_id: genAdminId(),
    email: opts.email.toLowerCase(),
    username: opts.username,
    name: opts.name || "",
    role: opts.role || "admin",
    ...(passwordHash ? { password_hash: passwordHash } : {}),
    active: true,
    channels_access: [],
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    created_at: new Date(),
    created_by: opts.createdBy || "system",
  };
  await coll.insertOne(doc);
  await logAdminEvent({
    action_type: "user.create",
    actor: opts.createdBy || "system",
    metadata: { new_admin_id: doc.admin_id, username: doc.username, role: doc.role },
  });
  return doc;
}

// ---- Sessions ----

export async function createSession(
  token: string,
  adminId: string,
  exp: number,
  ip: string
): Promise<void> {
  const coll = await getCollection(COLLECTIONS.sessions);
  await coll.insertOne({
    token_hash: hashToken(token),
    admin_id: adminId,
    created_at: new Date(),
    expires_at: new Date(exp * 1000),
    last_activity_at: new Date(),
    ip,
    revoked: false,
  });
}

export async function getSession(token: string): Promise<{ admin_id: string } | null> {
  const payload = await verifySessionToken(token);
  if (!payload) return null;
  const coll = await getCollection(COLLECTIONS.sessions);
  const doc = await coll.findOne({ token_hash: hashToken(token) });
  if (!doc) return null;
  if (doc.revoked) return null;
  return { admin_id: payload.admin_id };
}

export async function revokeSession(token: string): Promise<boolean> {
  const coll = await getCollection(COLLECTIONS.sessions);
  const result = await coll.updateOne(
    { token_hash: hashToken(token), revoked: false },
    { $set: { revoked: true, revoked_at: new Date() } }
  );
  return result.modifiedCount > 0;
}

export async function revokeAllSessions(adminId: string): Promise<number> {
  const coll = await getCollection(COLLECTIONS.sessions);
  const result = await coll.updateMany(
    { admin_id: adminId, revoked: false },
    { $set: { revoked: true, revoked_at: new Date() } }
  );
  return result.modifiedCount;
}

export async function updateSessionActivity(token: string): Promise<void> {
  const coll = await getCollection(COLLECTIONS.sessions);
  await coll.updateOne(
    { token_hash: hashToken(token) },
    { $set: { last_activity_at: new Date() } }
  );
}

// ---- Auth tokens (signup / reset) ----

// ---- User Management ----

export async function listAdmins(): Promise<SafeAdmin[]> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const docs = await coll.find({ is_deleted: { $ne: true } }, { projection: { password_hash: 0 } }).toArray();
  return docs.map(safeAdmin);
}

export async function toggleAdminActive(adminId: string, active: boolean): Promise<boolean> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const result = await coll.updateOne({ admin_id: adminId }, { $set: { active } });
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "user.toggle_active",
      actor: adminId,
      metadata: { active },
    });
  }
  return result.modifiedCount > 0;
}

export async function updateAdminProfile(
  adminId: string,
  fields: { name?: string; username?: string; channels_access?: string[]; is_accepting_chats?: boolean }
): Promise<boolean> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const update: Record<string, unknown> = {};
  if (fields.name !== undefined) update.name = fields.name;
  if (fields.username !== undefined) update.username = fields.username;
  if (fields.channels_access !== undefined) update.channels_access = fields.channels_access;
  if (fields.is_accepting_chats !== undefined) update.is_accepting_chats = fields.is_accepting_chats;
  if (Object.keys(update).length === 0) return false;
  const result = await coll.updateOne({ admin_id: adminId }, { $set: update });
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "user.update",
      actor: adminId,
      metadata: { fields: update },
    });
  }
  return result.modifiedCount > 0;
}

export async function deleteAdmin(adminId: string, deletedBy?: string): Promise<boolean> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  // Soft delete — never hard delete
  const result = await coll.updateOne(
    { admin_id: adminId, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, deleted_at: new Date(), deleted_by: deletedBy, active: false } }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "user.delete",
      actor: deletedBy || "system",
      metadata: { deleted_admin_id: adminId, soft_delete: true },
    });
  }
  return result.modifiedCount > 0;
}

// ---- Public API ----

export const auth = {
  safeAdmin,
  getAdminByEmail,
  getAdminByUsername,
  getAdminById,
  recordLoginSuccess,
  createAdmin,
  createSessionToken,
  createSession,
  getSession,
  revokeSession,
  revokeAllSessions,
  updateSessionActivity,
  listAdmins,
  toggleAdminActive,
  updateAdminProfile,
  deleteAdmin,
};

export { serverConfig };
