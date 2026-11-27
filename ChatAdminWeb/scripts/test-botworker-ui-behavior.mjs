import assert from "node:assert/strict";
import { findNotificationEvents } from "../src/lib/notificationMonitor.ts";

const enabled = { newTicket: true, handoff: true, unanswered: true };
const monitorStartedAt = Date.parse("2026-11-27T04:00:00.000Z");
const current = [
  { id: "new-1", created_at: "2026-11-27T04:01:00.000Z", last_timestamp: "2026-11-27T04:01:00.000Z", status: "bot", unread: 0 },
  { id: "handoff-1", created_at: "2026-11-26T12:00:00.000Z", last_timestamp: "2026-11-27T04:01:00.000Z", status: "handoff", unread: 1 },
  { id: "stale-1", created_at: "2026-11-26T12:00:00.000Z", last_timestamp: "2026-11-27T03:20:00.000Z", status: "bot", unread: 2 },
];
const previous = new Map([
  ["admin:handoff-1", { id: "handoff-1", status: "bot", unread: 1, last_timestamp: "2026-11-27T03:59:00.000Z" }],
  ["admin:stale-1", { id: "stale-1", status: "bot", unread: 1, last_timestamp: "2026-11-27T03:20:00.000Z" }],
]);
const events = findNotificationEvents({
  rows: current.map((row) => ({ ...row, source: "admin" })),
  previous,
  preferences: enabled,
  now: Date.parse("2026-11-27T04:01:00.000Z"),
  monitorStartedAt,
});
assert.deepEqual(events.map((event) => event.type), ["new_ticket", "handoff", "unanswered"]);
assert.deepEqual(new Set(events.map((event) => event.key)), new Set([
  "new_ticket:admin:new-1",
  "handoff:admin:handoff-1:2026-11-27T04:01:00.000Z",
  "unanswered:admin:stale-1:2026-11-27T03:20:00.000Z",
]));

const disabled = findNotificationEvents({
  rows: current.map((row) => ({ ...row, source: "admin" })),
  previous,
  preferences: { newTicket: false, handoff: false, unanswered: false },
  now: Date.parse("2026-11-27T04:01:00.000Z"),
  monitorStartedAt,
});
assert.equal(disabled.length, 0, "disabled notification preferences suppress toasts");

console.log("BotWorker UI notification behavior: 2 cases passed");
