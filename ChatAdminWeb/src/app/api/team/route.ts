// GET /api/team — รายชื่อ agent พร้อม workload + สถานะ
// ใช้ข้อมูลจาก admins + conversations (aggregate ใน memory เพราะขนาดเล็ก)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";
import { conversationService } from "@/backend/service/conversationService";
import { assignmentService } from "@/backend/service/assignmentService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const [admins, openConvos, mode, shopTeamRows] = await Promise.all([
    auth.listAdmins(),
    conversationService.listConversations({ limit: 5000 }),
    assignmentService.getActiveAssignmentConfig(),
    (async () => {
      const coll = await getCollection(COLLECTIONS.shopTeamAssignments);
      return coll.find({ is_active: true }).toArray();
    })(),
  ]);

  // นับ workload ต่อ admin
  const workloadMap = new Map<string, { open: number; bot: number; handoff: number; pending: number }>();
  for (const c of openConvos) {
    if (!c.assigned_to) continue;
    const w = workloadMap.get(c.assigned_to) || { open: 0, bot: 0, handoff: 0, pending: 0 };
    w.open += 1;
    if (c.status === "bot") w.bot += 1;
    if (c.status === "handoff") w.handoff += 1;
    if (c.status === "pending") w.pending += 1;
    workloadMap.set(c.assigned_to, w);
  }

  // หา shop ที่ agent รับผิดชอบ
  const shopTeamMap = new Map<string, string[]>();
  for (const row of shopTeamRows) {
    const arr = shopTeamMap.get(row.admin_id) || [];
    arr.push(row.shop_id);
    shopTeamMap.set(row.admin_id, arr);
  }

  const agents = admins.map((a) => ({
    admin_id: a.admin_id,
    name: a.name,
    username: a.username,
    role: a.role,
    active: a.active,
    is_active_agent: (a as unknown as Record<string, unknown>).is_active_agent !== false,
    // ⚠️ เฉพาะ role=admin เท่านั้นที่ถูกจ่ายแชท — superadmin และ dev ไม่ถูกจ่าย
    assignable: a.role === "admin",
    workload: workloadMap.get(a.admin_id) || { open: 0, bot: 0, handoff: 0, pending: 0 },
    assigned_shops: shopTeamMap.get(a.admin_id) || [],
  }));

  return json({
    mode,
    agents,
    total_agents: agents.length,
    active_agents: agents.filter((a) => a.is_active_agent).length,
    assignable_agents: agents.filter((a) => a.assignable).length,
    total_open_conversations: openConvos.filter((c) => c.assigned_to).length,
    unassigned: openConvos.filter((c) => !c.assigned_to && c.status !== "resolved").length,
  });
}
