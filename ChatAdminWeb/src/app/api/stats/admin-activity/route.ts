// GET /api/stats/admin-activity — "การทำงานของแอดมิน" — Zaapi-style overview
// charts, ranking cards, and per-admin performance table.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { auth } from "@/backend/service/authService";
import { shopService } from "@/backend/service/shopService";

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

  const [conversations, admins, shops] = await Promise.all([
    conversationService.listConversations({ limit: 5000 }),
    auth.listAdmins(),
    shopService.listShops(),
  ]);

  const adminMap = new Map(admins.map((a) => [a.admin_id, a]));
  const days = last7Days();
  const dayLabels = days.map(fmtDay);

  // Top handled admins (by assigned conversation count)
  const handledCounts = new Map<string, number>();
  for (const c of conversations) {
    if (c.assigned_to) handledCounts.set(c.assigned_to, (handledCounts.get(c.assigned_to) || 0) + 1);
  }
  const topAdmins = Array.from(handledCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => id);

  const conversationsByAdminPerDay = days.map((d, i) => {
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const row: Record<string, unknown> = { date: dayLabels[i] };
    for (const adminId of topAdmins) {
      const name = adminMap.get(adminId)?.name || adminId;
      row[name] = conversations.filter(
        (c) => c.assigned_to === adminId && new Date(c.created_at) >= d && new Date(c.created_at) < next
      ).length;
    }
    return row;
  });

  const individualPerformance = admins.map((a) => {
    const handled = conversations.filter((c) => c.assigned_to === a.admin_id);
    const resolved = handled.filter((c) => c.status === "resolved" || c.status === "bot").length;
    const unanswered = handled.filter((c) => c.status === "handoff" || c.status === "pending").length;
    return {
      admin_id: a.admin_id,
      name: a.name || a.username,
      role: a.role,
      conversations: handled.length,
      unanswered_12h: unanswered,
      response_rate_12h: handled.length ? Math.round((resolved / handled.length) * 1000) / 10 : 0,
      response_rate_10min: 0,
      avg_response_time_seconds: 0,
    };
  });

  const mostConversations = [...individualPerformance].sort((a, b) => b.conversations - a.conversations)[0];

  return json({
    has_real_data: conversations.length > 0,
    connected_shops: shops.length,
    date_range_label: `${fmtDay(days[0])} - ${fmtDay(days[6])}, ${new Date().getFullYear() + 543}`,
    compare_label: "7 วันที่แล้ว",
    conversations_by_admin_per_day: conversationsByAdminPerDay,
    admin_series_keys: topAdmins.map((id) => adminMap.get(id)?.name || id),
    rankings: {
      most_conversations: mostConversations && mostConversations.conversations > 0 ? mostConversations : null,
      least_responses: null,
      fastest_10min: null,
      fastest_overall: null,
    },
    individual_performance: individualPerformance,
  });
}
