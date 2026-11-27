import type { NotificationPreferences } from "./types";

export interface NotificationConversation {
  id: string;
  source: "admin" | "botworker";
  created_at?: string;
  last_timestamp: string;
  status: string;
  unread: number;
}

export interface NotificationEvent {
  key: string;
  type: "new_ticket" | "handoff" | "unanswered";
  message: string;
}

type PreviousConversation = Pick<NotificationConversation, "id" | "status" | "unread" | "last_timestamp">;

function isHumanOwned(status: string): boolean {
  return status === "handoff" || status === "open" || status === "pending";
}

export function findNotificationEvents(input: {
  rows: NotificationConversation[];
  previous: Map<string, PreviousConversation>;
  preferences: NotificationPreferences;
  now: number;
  monitorStartedAt: number;
}): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  const overdueAt = input.now - 30 * 60 * 1000;

  for (const row of input.rows) {
    const rowKey = `${row.source}:${row.id}`;
    const previous = input.previous.get(rowKey);
    const createdAt = row.created_at ? Date.parse(row.created_at) : Number.NaN;
    if (input.preferences.newTicket && !previous && Number.isFinite(createdAt)
      && createdAt >= input.monitorStartedAt && createdAt <= input.now) {
      events.push({ key: `new_ticket:${rowKey}`, type: "new_ticket", message: "มีแชทใหม่เข้ามา" });
    }

    if (input.preferences.handoff && previous && !isHumanOwned(previous.status) && isHumanOwned(row.status)) {
      events.push({
        key: `handoff:${rowKey}:${row.last_timestamp}`,
        type: "handoff",
        message: "บอทส่งแชทให้แอดมินแล้ว",
      });
    }

    const lastMessageAt = Date.parse(row.last_timestamp);
    const previousMessageAt = previous ? Date.parse(previous.last_timestamp) : Number.NaN;
    if (input.preferences.unanswered && row.unread > 0 && Number.isFinite(lastMessageAt) && lastMessageAt <= overdueAt
      && (!previous || previous.unread === 0 || row.unread > previous.unread
        || previous.last_timestamp !== row.last_timestamp
        || (Number.isFinite(previousMessageAt) && previousMessageAt > overdueAt))) {
      events.push({
        key: `unanswered:${rowKey}:${row.last_timestamp}`,
        type: "unanswered",
        message: "มีแชทที่ยังไม่ได้ตอบเกิน 30 นาที",
      });
    }
  }

  return events;
}
