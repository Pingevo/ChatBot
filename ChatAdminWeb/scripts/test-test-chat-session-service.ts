import { register } from "node:module";
register(new URL("./test-test-chat-session-hooks.mjs", import.meta.url));

const actorA = { adminId: "admin-a", adminName: "Admin A" };
const actorB = { adminId: "admin-b", adminName: "Admin B" };

async function main() {
  const { testChatSessionService: service } = await import("../src/backend/service/testChatSessionService");
  const db = await import("./test-test-chat-session-db.mjs");

  const created = await service.create({ shop: "Black Shark" }, actorA);
  if (!created.id || created.shop !== "Black Shark" || created.title !== "แชทใหม่") throw new Error("create response changed");
  let doc: any = db.documents.find((row: any) => String(row._id) === created.id);
  if (!doc || doc.admin_id !== actorA.adminId || doc.admin_name !== actorA.adminName || doc.messages.length !== 0) {
    throw new Error("create must persist the existing session schema and actor");
  }

  await service.create({ shop: "Shop B" }, actorB);
  const visible = await service.list({ adminId: actorA.adminId, limit: 200 });
  const visibleIds = new Set(visible.sessions.map((row: any) => row.id));
  if (!visibleIds.has(created.id) || !visibleIds.has("000000000000000000000001") ||
      !visibleIds.has("000000000000000000000003") || visibleIds.has("000000000000000000000002")) {
    throw new Error("list ownership must retain own, legacy, and script_test visibility");
  }

  const longTitle = `${"🙂".repeat(40)}x`;
  await service.addMessage(created.id, { role: "user", text: longTitle, stats: {}, images: ["/upload/a.jpg"] }, actorA);
  doc = db.documents.find((row: any) => String(row._id) === created.id);
  if (doc.title !== `${"🙂".repeat(40)}...` || doc.messages[0].images[0] !== "/upload/a.jpg") {
    throw new Error("message append must preserve media and Python code-point title behavior");
  }
  await service.addMessage(created.id, { role: "model", text: "ตอบ", stats: { cost: 2 } }, actorA);
  await service.update(created.id, { shop: "New Shop", title: "Renamed" }, actorA);
  await service.close(created.id, actorA);
  if (doc.shop !== "New Shop" || doc.title !== "Renamed" || doc.status !== "closed" || doc.closed_by !== actorA.adminId) {
    throw new Error("update and close fields changed");
  }
  await service.reopen(created.id, actorA);
  if (doc.status !== "open" || doc.closed_at !== null) throw new Error("reopen must clear closed_at");

  const ownLogs = await service.listLogs({ adminId: actorA.adminId, limit: 200 });
  const allLogs = await service.listLogs({ adminId: actorA.adminId, requestedAdminId: "all", limit: 200 });
  if (!ownLogs.logs.some((row: any) => row.action === "create_session" && row.admin_name === actorA.adminName) ||
      !ownLogs.logs.some((row: any) => row.action === "close_session") ||
      allLogs.logs.length <= ownLogs.logs.length) {
    throw new Error("action logs must preserve actor and all-scope behavior");
  }

  const removed = await service.remove(created.id, actorA);
  if (!removed.ok || db.documents.some((row: any) => String(row._id) === created.id)) throw new Error("delete failed");
  let invalidId = false;
  try { await service.get("bad-id"); } catch (error) { invalidId = (error as any).status === 400; }
  if (!invalidId) throw new Error("invalid ObjectId must return the existing 400 boundary");

  console.log("PASS Test Chat Mongo persistence, ownership, message/title/media, status, deletion, and action-log contracts");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
