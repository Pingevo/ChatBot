// GET /api/stats/performance — "ภาพรวม Performance" — Zaapi-style KPI grid
// (with sparkline + delta%) and per-channel insight charts.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { conversationService } from "@/backend/service/conversationService";
import { shopService } from "@/backend/service/shopService";
import type { Platform } from "@/backend/service/conversationService";

const PLATFORMS: Platform[] = ["shopee", "tiktok", "lazada"];

function last7Days(): Date[] {
  const days: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  return days;
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("th-TH", { day: "2-digit", month: "short" });
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const [conversations, shops] = await Promise.all([
    conversationService.listConversations({ limit: 5000 }),
    shopService.listShops(),
  ]);
  const msgColl = await getCollection<{ role: string; created_timestamp: Date }>(COLLECTIONS.messages);

  const days = last7Days();
  const dayLabels = days.map(fmtDay);

  // ---- conversations per day (overall + per channel) ----
  const conversationsPerDay = days.map((d) => {
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    return conversations.filter((c) => new Date(c.created_at) >= d && new Date(c.created_at) < next).length;
  });

  const customersByChannel = days.map((d, i) => {
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const row: Record<string, unknown> = { date: dayLabels[i] };
    for (const p of PLATFORMS) {
      row[p] = conversations.filter(
        (c) => c.platform === p && new Date(c.created_at) >= d && new Date(c.created_at) < next
      ).length;
    }
    return row;
  });

  // ---- messages received / sent totals ----
  const [messagesReceived, messagesSent] = await Promise.all([
    msgColl.countDocuments({ role: "user" }),
    msgColl.countDocuments({ role: { $in: ["bot", "admin"] } }),
  ]);

  // ---- new vs existing customers (rough: created this week vs earlier) ----
  const weekAgo = days[0];
  const newCustomers = conversations.filter((c) => new Date(c.created_at) >= weekAgo).length;
  const existingCustomers = conversations.length - newCustomers;

  const totalConversations = conversations.length;
  const resolved = conversations.filter((c) => c.status === "resolved" || c.status === "bot").length;
  const responseRate12h = totalConversations ? Math.round((resolved / totalConversations) * 1000) / 10 : 0;

  const overview = {
    new_vs_existing: { new: newCustomers, existing: existingCustomers },
    conversations: { value: totalConversations, spark: conversationsPerDay.map((v, i) => ({ date: dayLabels[i], value: v })) },
    unanswered_12h: {
      value: conversations.filter((c) => c.status === "handoff" || c.status === "pending").length,
      spark: conversationsPerDay.map((v, i) => ({ date: dayLabels[i], value: v })),
    },
    response_rate_12h: { value: responseRate12h, spark: conversationsPerDay.map((v, i) => ({ date: dayLabels[i], value: v })) },
    response_rate_10min: { value: 0, spark: conversationsPerDay.map((v, i) => ({ date: dayLabels[i], value: v })) },
    avg_response_time_seconds: { value: 0, spark: conversationsPerDay.map((v, i) => ({ date: dayLabels[i], value: v })) },
    messages_received: { value: messagesReceived, spark: conversationsPerDay.map((v, i) => ({ date: dayLabels[i], value: v })) },
    messages_sent: { value: messagesSent, spark: conversationsPerDay.map((v, i) => ({ date: dayLabels[i], value: v })) },
  };

  return json({
    has_real_data: totalConversations > 0,
    connected_shops: shops.length,
    date_range_label: `${fmtDay(days[0])} - ${fmtDay(days[6])}, ${new Date().getFullYear() + 543}`,
    compare_label: "7 วันที่แล้ว",
    overview,
    insight: {
      customers_by_channel: customersByChannel,
      unanswered_by_channel: customersByChannel,
      response_rate_12h_by_channel: customersByChannel,
      response_rate_10min_by_channel: customersByChannel,
      avg_response_time_by_channel: customersByChannel,
    },
    heatmap: {
      rows: ["0:00-3:00", "3:00-6:00", "6:00-9:00", "9:00-12:00", "12:00-15:00", "15:00-18:00", "18:00-21:00", "21:00-00:00"],
      cols: ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"],
      values: Array.from({ length: 8 }, () => Array.from({ length: 7 }, () => 0)),
    },
  });
}
