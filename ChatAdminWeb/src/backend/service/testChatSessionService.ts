import { ObjectId } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";

export interface TestChatActor {
  adminId: string;
  adminName: string;
}

export interface TestChatMessageInput {
  role: string;
  text: string;
  timestamp?: string;
  stats?: Record<string, unknown>;
  images?: string[];
}

export class TestChatSessionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TestChatSessionError";
  }
}

function objectId(sessionId: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(sessionId)) {
    throw new TestChatSessionError(400, "invalid id format");
  }
  return new ObjectId(sessionId);
}

async function logAction(
  action: string,
  actor: TestChatActor,
  sessionId: string | null = null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const logs = await getCollection<Record<string, any>>("test_chat_logs");
    await logs.insertOne({
      action,
      session_id: sessionId,
      admin_id: actor.adminId || "anonymous",
      admin_name: actor.adminName || "anonymous",
      timestamp: new Date(),
      ...extra,
    });
  } catch {
    // Logging must not fail a Test Chat operation.
  }
}

function asIso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

async function findSession(sessionId: string) {
  const sessions = await getCollection<Record<string, any>>(COLLECTIONS.testChatSessions);
  const doc = await sessions.findOne({ _id: objectId(sessionId) }) as unknown as Record<string, any> | null;
  return { sessions, doc };
}

export const testChatSessionService = {
  async list(input: { adminId: string; shop?: string; limit: number }) {
    const sessions = await getCollection<Record<string, any>>(COLLECTIONS.testChatSessions);
    const query: Record<string, unknown> = {};
    if (input.shop) query.shop = input.shop;
    if (input.adminId) {
      query.$or = [
        { admin_id: input.adminId },
        { admin_id: { $exists: false } },
        { admin_id: null },
        { admin_id: "" },
        { source: "script_test" },
      ];
    }
    const cursor = sessions.find(query).sort({ updated_at: -1 }).limit(input.limit);
    const rows = await cursor.toArray() as Record<string, any>[];
    return {
      sessions: rows.map((doc) => ({
        id: String(doc._id),
        shop: doc.shop || "",
        title: doc.title || "ไม่มีชื่อ",
        message_count: Array.isArray(doc.messages) ? doc.messages.length : 0,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        admin_id: doc.admin_id || "",
        admin_name: doc.admin_name || "",
        source: doc.source || "",
        script_test: doc.script_test || false,
      })),
    };
  },

  async create(input: { shop?: string; title?: string | null }, actor: TestChatActor) {
    const sessions = await getCollection<Record<string, any>>(COLLECTIONS.testChatSessions);
    const now = new Date();
    const doc = {
      shop: input.shop || "",
      title: input.title || "แชทใหม่",
      messages: [],
      created_at: now,
      updated_at: now,
      admin_id: actor.adminId || "anonymous",
      admin_name: actor.adminName || "anonymous",
    };
    const result = await sessions.insertOne(doc);
    const id = String(result.insertedId);
    await logAction("create_session", actor, id, { shop: doc.shop, title: doc.title });
    return { id, shop: doc.shop, title: doc.title };
  },

  async get(sessionId: string) {
    const { doc } = await findSession(sessionId);
    if (!doc) throw new TestChatSessionError(404, "session not found");
    const result: Record<string, any> = { ...doc, id: String(doc._id) };
    delete result._id;
    for (const key of ["created_at", "updated_at"]) result[key] = asIso(result[key]);
    return result;
  },

  async addMessage(sessionId: string, input: TestChatMessageInput, actor: TestChatActor) {
    const oid = objectId(sessionId);
    const sessions = await getCollection<Record<string, any>>(COLLECTIONS.testChatSessions);
    const now = new Date();
    const message = {
      role: input.role,
      text: input.text,
      timestamp: input.timestamp || now.toISOString(),
      stats: input.stats || {},
      images: input.images || [],
    };
    const result = await sessions.updateOne(
      { _id: oid },
      { $push: { messages: message }, $set: { updated_at: now } } as any,
    );
    if (result.matchedCount === 0) throw new TestChatSessionError(404, "session not found");

    const { doc } = await findSession(sessionId);
    if (input.role === "user" && doc?.title === "แชทใหม่") {
      const chars = Array.from(input.text);
      const title = chars.slice(0, 40).join("") + (chars.length > 40 ? "..." : "");
      await sessions.updateOne({ _id: oid }, { $set: { title } });
    }
    await logAction("add_message", actor, sessionId, {
      role: input.role,
      text_preview: input.text.slice(0, 120),
      shop: doc?.shop || "",
    });
    return { ok: true };
  },

  async remove(sessionId: string, actor: TestChatActor) {
    const oid = objectId(sessionId);
    const sessions = await getCollection<Record<string, any>>(COLLECTIONS.testChatSessions);
    const doc = await sessions.findOne({ _id: oid }) as Record<string, any> | null;
    const result = await sessions.deleteOne({ _id: oid });
    if (result.deletedCount === 0) throw new TestChatSessionError(404, "session not found");
    await logAction("delete_session", actor, sessionId, {
      shop: doc?.shop || "",
      title: doc?.title || "",
      message_count: Array.isArray(doc?.messages) ? doc.messages.length : 0,
    });
    return { ok: true };
  },

  async update(sessionId: string, input: { shop?: string; title?: string }, actor: TestChatActor) {
    const oid = objectId(sessionId);
    const sessions = await getCollection<Record<string, any>>(COLLECTIONS.testChatSessions);
    const old = await sessions.findOne({ _id: oid }) as Record<string, any> | null;
    const fields: Record<string, unknown> = { updated_at: new Date() };
    if (input.shop !== undefined) fields.shop = String(input.shop).slice(0, 100);
    if (input.title !== undefined) fields.title = String(input.title).slice(0, 200);
    const result = await sessions.updateOne({ _id: oid }, { $set: fields });
    if (result.matchedCount === 0) throw new TestChatSessionError(404, "session not found");
    await logAction("update_session", actor, sessionId, {
      old_shop: old?.shop || "",
      new_shop: input.shop,
      old_title: old?.title || "",
      new_title: input.title,
    });
    return { ok: true, shop: input.shop, title: input.title };
  },

  async close(sessionId: string, actor: TestChatActor) {
    const oid = objectId(sessionId);
    const now = new Date();
    const sessions = await getCollection(COLLECTIONS.testChatSessions);
    const result = await sessions.updateOne({ _id: oid }, { $set: {
      status: "closed", closed_at: now, closed_by: actor.adminId || "test_chat_user", updated_at: now,
    } });
    if (result.matchedCount === 0) throw new TestChatSessionError(404, "session not found");
    await logAction("close_session", actor, sessionId, { status: "closed" });
    return { ok: true, status: "closed", closed_at: now.toISOString() };
  },

  async reopen(sessionId: string, actor: TestChatActor) {
    const oid = objectId(sessionId);
    const sessions = await getCollection(COLLECTIONS.testChatSessions);
    const result = await sessions.updateOne({ _id: oid }, { $set: {
      status: "open", closed_at: null, updated_at: new Date(),
    } });
    if (result.matchedCount === 0) throw new TestChatSessionError(404, "session not found");
    await logAction("reopen_session", actor, sessionId, { status: "open" });
    return { ok: true, status: "open" };
  },

  async listLogs(input: { adminId: string; requestedAdminId?: string; action?: string; limit: number }) {
    const logs = await getCollection<Record<string, any>>("test_chat_logs");
    const query: Record<string, unknown> = {};
    if (input.action) query.action = input.action;
    const adminId = input.requestedAdminId || input.adminId;
    if (adminId && adminId !== "all") query.admin_id = adminId;
    const rows = await logs.find(query).sort({ timestamp: -1 }).limit(input.limit).toArray() as Record<string, any>[];
    return {
      logs: rows.map((doc) => {
        const result: Record<string, any> = { ...doc, id: String(doc._id) };
        delete result._id;
        if (result.timestamp instanceof Date) result.timestamp = result.timestamp.toISOString();
        return result;
      }),
      count: rows.length,
    };
  },
};
