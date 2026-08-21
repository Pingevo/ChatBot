// Auth logic — server-side only.
// Handles: login, signup, reset, session, logout, admin CRUD.
import { Document } from "mongodb";
import { getCollection, COLLECTIONS, ensureIndexes } from "../db/mongoClient";
import { hashPassword, verifyPassword } from "../lib/password";
import {
  createSessionToken,
  verifySessionToken,
  createAuthToken,
  verifyAuthToken,
  hashToken,
} from "../lib/jwt";
import { serverConfig, MAX_FAILED_LOGIN, LOCK_MINUTES } from "../lib/config";

export interface AdminDoc extends Document {
  admin_id: string;
  email: string;
  username: string;
  name: string;
  role: "superadmin" | "admin" | "dev";
  password_hash: string;
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

// ---- Lockout ----

export function isLocked(admin: AdminDoc): boolean {
  if (!admin.locked_until) return false;
  return new Date(admin.locked_until).getTime() > Date.now();
}

export async function recordLoginFailure(adminId: string): Promise<{ locked: boolean }> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const admin = await coll.findOne({ admin_id: adminId });
  const count = (admin?.failed_login_count || 0) + 1;
  const locked = count >= MAX_FAILED_LOGIN;
  await coll.updateOne(
    { admin_id: adminId },
    {
      $set: {
        failed_login_count: count,
        locked_until: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    }
  );
  return { locked };
}

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
  password: string;
  name?: string;
  role?: "superadmin" | "admin" | "dev";
  createdBy?: string;
}): Promise<AdminDoc> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const passwordHash = await hashPassword(opts.password);
  const doc: AdminDoc = {
    admin_id: genAdminId(),
    email: opts.email.toLowerCase(),
    username: opts.username,
    name: opts.name || "",
    role: opts.role || "admin",
    password_hash: passwordHash,
    active: true,
    channels_access: [],
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    created_at: new Date(),
    created_by: opts.createdBy || "system",
  };
  await coll.insertOne(doc);
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

export async function storeAuthToken(
  token: string,
  purpose: "signup" | "reset_password",
  email: string,
  exp: number,
  adminId?: string
): Promise<void> {
  const coll = await getCollection(COLLECTIONS.authTokens);
  await coll.insertOne({
    token_hash: hashToken(token),
    purpose,
    email,
    admin_id: adminId,
    expires_at: new Date(exp * 1000),
    used: false,
    created_at: new Date(),
  });
}

export async function consumeAuthToken(
  token: string
): Promise<{ purpose: string; email: string; admin_id?: string } | null> {
  const payload = await verifyAuthToken(token);
  if (!payload) return null;
  const coll = await getCollection(COLLECTIONS.authTokens);
  const doc = await coll.findOne({ token_hash: hashToken(token) });
  if (!doc) return null;
  if (doc.used) return null;
  await coll.updateOne({ token_hash: hashToken(token) }, { $set: { used: true, used_at: new Date() } });
  return { purpose: payload.purpose, email: payload.email, admin_id: payload.admin_id };
}

// ---- Password update ----

export async function updatePassword(adminId: string, newPassword: string): Promise<boolean> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const hash = await hashPassword(newPassword);
  const result = await coll.updateOne({ admin_id: adminId }, { $set: { password_hash: hash } });
  return result.modifiedCount > 0;
}

// ---- User Management ----

export async function listAdmins(): Promise<SafeAdmin[]> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const docs = await coll.find({ is_deleted: { $ne: true } }, { projection: { password_hash: 0 } }).toArray();
  return docs.map(safeAdmin);
}

export async function toggleAdminActive(adminId: string, active: boolean): Promise<boolean> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const result = await coll.updateOne({ admin_id: adminId }, { $set: { active } });
  return result.modifiedCount > 0;
}

export async function updateAdminRole(adminId: string, role: "superadmin" | "admin" | "dev"): Promise<boolean> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  const result = await coll.updateOne({ admin_id: adminId }, { $set: { role } });
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
  return result.modifiedCount > 0;
}

export async function deleteAdmin(adminId: string, deletedBy?: string): Promise<boolean> {
  const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
  // Soft delete — never hard delete
  const result = await coll.updateOne(
    { admin_id: adminId, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, deleted_at: new Date(), deleted_by: deletedBy, active: false } }
  );
  return result.modifiedCount > 0;
}

// ---- OTP (self-service password change confirmation) ----
// Reuses the existing `auth_tokens` collection (purpose: "self_password_change")
// instead of a new collection. Unlike the JWT-based signup/reset tokens, this
// flow is a short numeric code the admin types in manually, so lookup is by
// admin_id + hashed code rather than by verifying a JWT.

function genOtpCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

const OTP_EXPIRES_MINUTES = 10;

export async function createSelfOtp(adminId: string, email: string): Promise<string> {
  const coll = await getCollection(COLLECTIONS.authTokens);
  const code = genOtpCode();
  const exp = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60_000);
  // Invalidate any previous unused OTPs for this admin/purpose first.
  await coll.updateMany(
    { admin_id: adminId, purpose: "self_password_change", used: false },
    { $set: { used: true, used_at: new Date() } }
  );
  await coll.insertOne({
    purpose: "self_password_change",
    admin_id: adminId,
    email,
    otp_code_hash: hashToken(code),
    expires_at: exp,
    used: false,
    created_at: new Date(),
  });
  return code;
}

export async function verifySelfOtp(adminId: string, code: string): Promise<boolean> {
  const coll = await getCollection(COLLECTIONS.authTokens);
  const doc = await coll.findOne({
    admin_id: adminId,
    purpose: "self_password_change",
    used: false,
    otp_code_hash: hashToken(code),
    expires_at: { $gt: new Date() },
  });
  if (!doc) return false;
  await coll.updateOne({ _id: doc._id }, { $set: { used: true, used_at: new Date() } });
  return true;
}

// ---- Admin-initiated password reset (superadmin resets another admin) ----
// Sends a reset link to the TARGET admin's own email (reuses the existing
// reset_password token flow) rather than an OTP to the acting superadmin.

export async function createResetLinkForAdmin(
  targetAdminId: string
): Promise<{ token: string; email: string } | null> {
  const target = await getAdminById(targetAdminId);
  if (!target) return null;
  const { token, exp } = await createAuthToken("reset_password", target.email, target.admin_id);
  await storeAuthToken(token, "reset_password", target.email, exp, target.admin_id);
  return { token, email: target.email };
}

// ---- Public API ----

export const auth = {
  safeAdmin,
  getAdminByEmail,
  getAdminByUsername,
  getAdminById,
  isLocked,
  recordLoginFailure,
  recordLoginSuccess,
  createAdmin,
  createSessionToken,
  createSession,
  getSession,
  revokeSession,
  revokeAllSessions,
  updateSessionActivity,
  createAuthToken,
  storeAuthToken,
  consumeAuthToken,
  updatePassword,
  verifyPassword,
  ensureIndexes,
  listAdmins,
  toggleAdminActive,
  updateAdminRole,
  updateAdminProfile,
  deleteAdmin,
  createSelfOtp,
  verifySelfOtp,
  createResetLinkForAdmin,
};

export { serverConfig };
