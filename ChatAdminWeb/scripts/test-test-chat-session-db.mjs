import { ObjectId } from "mongodb";

export const COLLECTIONS = { testChatSessions: "test_chat_sessions" };
export const documents = [
  { _id: new ObjectId("000000000000000000000001"), shop: "Legacy", title: "แชทเดิม", messages: [], updated_at: new Date("2026-01-01T00:00:00Z") },
  { _id: new ObjectId("000000000000000000000002"), shop: "Other", title: "ของคนอื่น", messages: [], admin_id: "admin-b", updated_at: new Date("2026-01-02T00:00:00Z") },
  { _id: new ObjectId("000000000000000000000003"), shop: "Script", title: "shadow", messages: [], source: "script_test", updated_at: new Date("2026-01-03T00:00:00Z") },
];
export const logs = [];

function matches(doc, query) {
  if (query.shop !== undefined && doc.shop !== query.shop) return false;
  if (query._id && String(doc._id) !== String(query._id)) return false;
  if (query.$or && !query.$or.some((part) => {
    if (part.admin_id?.$exists === false) return !Object.hasOwn(doc, "admin_id");
    if (part.admin_id === null) return doc.admin_id === null;
    if (part.admin_id === "") return doc.admin_id === "";
    if (part.source === "script_test") return doc.source === "script_test";
    return doc.admin_id === part.admin_id;
  })) return false;
  if (query.action && doc.action !== query.action) return false;
  if (query.admin_id && doc.admin_id !== query.admin_id) return false;
  return true;
}

function collection(rows) {
  return {
    find(query = {}) {
      let found = rows.filter((doc) => matches(doc, query));
      const cursor = {
        sort(spec) { cursor.sortSpec = spec; return cursor; },
        limit(n) { cursor.limitValue = n; return cursor; },
        async toArray() {
          if (cursor.sortSpec) {
            const [[key, direction]] = Object.entries(cursor.sortSpec);
            found = found.sort((a, b) => (new Date(a[key]).getTime() - new Date(b[key]).getTime()) * direction);
          }
          return found.slice(0, cursor.limitValue ?? found.length);
        },
      };
      return cursor;
    },
    async findOne(query) { return rows.find((doc) => matches(doc, query)) || null; },
    async insertOne(doc) {
      const saved = { ...doc, _id: new ObjectId() };
      rows.push(saved);
      return { insertedId: saved._id };
    },
    async updateOne(query, update) {
      const doc = rows.find((row) => matches(row, query));
      if (!doc) return { matchedCount: 0 };
      Object.assign(doc, update.$set || {});
      for (const [key, value] of Object.entries(update.$push || {})) doc[key].push(value);
      return { matchedCount: 1 };
    },
    async deleteOne(query) {
      const index = rows.findIndex((doc) => matches(doc, query));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

const collections = {
  test_chat_sessions: collection(documents),
  test_chat_logs: collection(logs),
};

export async function getCollection(name) {
  const coll = collections[name];
  if (!coll) throw new Error(`unexpected_collection:${name}`);
  return coll;
}

