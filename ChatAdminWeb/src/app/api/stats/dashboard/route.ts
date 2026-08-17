// GET /api/stats/dashboard — top-line KPI cards + daily trend + platform/topic breakdown.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { ticketService } from "@/backend/service/ticketService";
import { messageService } from "@/backend/service/messageService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const conversations = await conversationService.listConversations({ limit: 5000 });
  const tickets = await ticketService.listTickets({ limit: 5000 });

  const total = conversations.length;
  const activeNow = conversations.filter((c) => c.status === "bot" || c.status === "pending").length;
  const botResolved = conversations.filter((c) => c.status === "resolved").length;
  const handoffCount = conversations.filter((c) => c.status === "handoff").length;

  const platformCounts: Record<string, number> = {};
  for (const c of conversations) {
    platformCounts[c.platform] = (platformCounts[c.platform] || 0) + 1;
  }

  const topicCounts: Record<string, number> = {};
  for (const c of conversations) {
    if (c.topic) topicCounts[c.topic] = (topicCounts[c.topic] || 0) + 1;
  }
  for (const t of tickets) {
    if (t.topic) topicCounts[t.topic] = (topicCounts[t.topic] || 0) + 1;
  }

  // Daily trend — last 7 days, count of conversations created per day.
  const days: { date: string; count: number }[] = [];
  const msgColl = await getCollection(COLLECTIONS.messages);
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const count = await msgColl.countDocuments({
      created_timestamp: { $gte: dayStart, $lt: dayEnd },
      role: "user",
    });
    days.push({
      date: dayStart.toLocaleDateString("th-TH", { weekday: "short" }),
      count,
    });
  }

  const hasRealData = total > 0;

  return json({
    has_real_data: hasRealData,
    total_conversations: total,
    active_now: activeNow,
    bot_resolved: botResolved,
    handoff_count: handoffCount,
    avg_response_time: 0,
    platform_breakdown: Object.entries(platformCounts).map(([platform, count]) => ({ platform, count })),
    topic_breakdown: Object.entries(topicCounts).map(([topic, count]) => ({ topic, count })),
    daily_trend: days,
  });
}
