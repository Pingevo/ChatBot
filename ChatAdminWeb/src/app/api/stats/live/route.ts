// GET /api/stats/live — "ข้อมูลสด" — real-time-ish snapshot widgets
// (Zaapi-style: open conversations, unanswered, workload by admin, breakdown
// by shop connection).
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { auth } from "@/backend/service/authService";
import { shopService } from "@/backend/service/shopService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const [openConvos, admins, shops] = await Promise.all([
    conversationService.listConversations({ limit: 2000 }),
    auth.listAdmins(),
    shopService.listShops(),
  ]);

  const open = openConvos.filter((c) => c.status === "bot" || c.status === "handoff" || c.status === "pending");
  const assigned = open.filter((c) => !!c.assigned_to);
  const unassigned = open.filter((c) => !c.assigned_to);

  const UNANSWERED_MINUTES = 10;
  const now = Date.now();
  const unanswered = open.filter(
    (c) => c.status !== "resolved" && now - new Date(c.last_message_timestamp).getTime() > UNANSWERED_MINUTES * 60_000
  );

  const adminMap = new Map(admins.map((a) => [a.admin_id, a]));
  const workloadCounts = new Map<string, number>();
  for (const c of open) {
    const key = c.assigned_to || "__unassigned__";
    workloadCounts.set(key, (workloadCounts.get(key) || 0) + 1);
  }
  const workload = Array.from(workloadCounts.entries())
    .map(([adminId, count]) => ({
      admin_id: adminId,
      name: adminId === "__unassigned__" ? "ยังไม่ได้มอบหมาย" : adminMap.get(adminId)?.name || adminId,
      count,
    }))
    .sort((a, b) => b.count - a.count);

  const shopCounts = new Map<string, number>();
  for (const c of open) {
    shopCounts.set(c.shop_name, (shopCounts.get(c.shop_name) || 0) + 1);
  }
  const byConnection = Array.from(shopCounts.entries()).map(([name, count]) => ({ name, value: count }));

  return json({
    has_real_data: open.length > 0,
    connected_shops: shops.length,
    open_total: open.length,
    open_assigned: assigned.length,
    open_unassigned: unassigned.length,
    unanswered_total: unanswered.length,
    unanswered_threshold_minutes: UNANSWERED_MINUTES,
    workload_by_admin: workload,
    breakdown_by_connection: byConnection,
    generated_at: new Date().toISOString(),
  });
}
