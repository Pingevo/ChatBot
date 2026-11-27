import assert from "node:assert/strict";
import Module from "node:module";

const updateCalls = [];
const fakeCollection = {
  async updateOne(filter, update) {
    updateCalls.push({ filter, update });
    return { modifiedCount: 1 };
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith("authService.ts")) {
    if (request === "../db/mongoClient") return { getCollection: async () => fakeCollection, COLLECTIONS: { admins: "admins" } };
    if (request === "../lib/password") return { hashPassword: async () => "hash" };
    if (request === "../lib/jwt") return {};
    if (request === "../lib/config") return { serverConfig: {} };
    if (request === "./adminLogService") return { logAdminEvent: async () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { auth } = await import("../src/backend/service/authService.ts");
const admin = {
  admin_id: "adm_test",
  email: "admin@example.test",
  username: "admin",
  name: "Admin",
  role: "admin",
  active: true,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
};
assert.equal(auth.safeAdmin(admin).notification_preferences, undefined, "team user responses do not expose another admin's preferences");
assert.deepEqual(auth.safeAdmin(admin, { includeNotificationPreferences: true }).notification_preferences, {
  newTicket: true,
  handoff: true,
  unanswered: true,
});

const preferences = { newTicket: false, handoff: true, unanswered: false };
assert.equal(await auth.updateAdminProfile("adm_test", { notification_preferences: preferences }), true);
assert.deepEqual(updateCalls[0], {
  filter: { admin_id: "adm_test" },
  update: { $set: { notification_preferences: preferences } },
});

console.log("Notification preference persistence: 2 cases passed");
