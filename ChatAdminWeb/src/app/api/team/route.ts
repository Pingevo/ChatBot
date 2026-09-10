// GET /api/team — รายชื่อ agent พร้อม workload + สถานะ + ร้าน/แพลตฟอร์มที่ดูแล
// ⚡ อ่าน workload จาก status_conversation (admin-owned — ไม่โดน dump ทับ)
// ⚡ รวม shop_team + platform_team พร้อม shop names ใน response
// ⚡ รองรับ start_date/end_date สำหรับ historical stats จาก admin_logs
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";
import { conversationService } from "@/backend/service/conversationService";
import { assignmentService } from "@/backend/service/assignmentService";
import { shopService } from "@/backend/service/shopService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { ConversationStatus } from "@/backend/service/conversationService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  const range = url.searchParams.get("range") || "daily";

  // คำนวณ date bounds สำหรับ historical stats
  let histStart: Date | null = null;
  let histEnd: Date | null = null;
  if (startDate) {
    histStart = new Date(startDate);
    histStart.setHours(0, 0, 0, 0);
    histEnd = endDate ? new Date(endDate) : new Date(histStart);
    histEnd.setHours(23, 59, 59, 999);
  } else if (range === "monthly") {
    histStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    histEnd = new Date();
  } else if (range === "yearly") {
    histStart = new Date(new Date().getFullYear(), 0, 1);
    histEnd = new Date();
  } else if (range === "all") {
    histStart = null;
    histEnd = null;
  } else {
    // daily — วันนี้
    histStart = new Date();
    histStart.setHours(0, 0, 0, 0);
    histEnd = new Date();
    histEnd.setHours(23, 59, 59, 999);
  }

  const [admins, openConvos, mode, shopTeamRows, platformTeamRows, shops, statusMetas, histAgg] = await Promise.all([
    auth.listAdmins(),
    conversationService.listConversations({ limit: 5000 }),
    assignmentService.getActiveAssignmentConfig(),
    (async () => {
      const coll = await getCollection(COLLECTIONS.shopTeamAssignments);
      return coll.find({ is_active: true }).toArray();
    })(),
    (async () => {
      const coll = await getCollection(COLLECTIONS.platformTeamAssignments);
      return coll.find({ is_active: true }).toArray();
    })(),
    shopService.listShops(),
    // ⚡ ดึง status_conversation ทั้งหมด (admin-owned — ไม่โดน dump ทับ)
    (async () => {
      const coll = await getCollection<{ conversation_id: string; assigned_to?: string | null; status?: ConversationStatus; closed_at?: Date | null; closed_by?: string }>(COLLECTIONS.statusConversation);
      return coll.find({}).toArray();
    })(),
    // ⚡ historical stats จาก admin_logs ตาม date range
    (async () => {
      const coll = await getCollection<{ admin_id?: string; actor?: string; target_admin_id?: string; action_type: string; timestamp: Date }>(COLLECTIONS.adminLogs);
      const match: Record<string, unknown> = {
        action_type: {
          $in: [
            "chat_assigned", "chat_reassigned",
            "conversation.close", "conversation.open",
            "conversation.handoff", "conversation.resolve",
            "conversation.reply",
          ],
        },
      };
      if (histStart || histEnd) {
        const ts: Record<string, unknown> = {};
        if (histStart) ts.$gte = histStart;
        if (histEnd) ts.$lt = histEnd;
        match.timestamp = ts;
      }
      const agg = await coll.aggregate<{ _id: string; assigned: number; closed: number; reopened: number; handoff: number; replied: number; resolved: number }>([
        { $match: match },
        {
          $group: {
            _id: { $ifNull: ["$target_admin_id", "$actor"] },
            assigned: { $sum: { $cond: [{ $in: ["$action_type", ["chat_assigned", "chat_reassigned"]] }, 1, 0] } },
            closed: { $sum: { $cond: [{ $eq: ["$action_type", "conversation.close"] }, 1, 0] } },
            reopened: { $sum: { $cond: [{ $eq: ["$action_type", "conversation.open"] }, 1, 0] } },
            handoff: { $sum: { $cond: [{ $eq: ["$action_type", "conversation.handoff"] }, 1, 0] } },
            replied: { $sum: { $cond: [{ $eq: ["$action_type", "conversation.reply"] }, 1, 0] } },
            resolved: { $sum: { $cond: [{ $eq: ["$action_type", "conversation.resolve"] }, 1, 0] } },
          },
        },
      ]).toArray();
      return new Map(agg.map((a) => [a._id || "", a]));
    })(),
  ]);

  // ⚡ สร้าง map: conversation_id → status_meta (จาก status_conversation — admin-owned)
  const statusMap = new Map<string, { assigned_to?: string | null; status?: ConversationStatus; closed_at?: Date | null; closed_by?: string }>();
  for (const m of statusMetas) {
    statusMap.set(m.conversation_id, m);
  }

  // ⚡ นับ workload ต่อ admin จาก status_conversation (ไม่ใช่ conversations ที่โดน dump ทับ)
  //    ใช้ status จาก status_conversation ถ้ามี ไม่งั่ว fallback ไป conversations
  //    ⚡ workload ของแอดมิน = แชทที่ assigned ให้แอดมิน (ไม่นับ bot — bot แปลว่าบอทกำลังตอบ ไม่ใช่งานแอดมิน)
  //       - all = ทุกแชทที่ assigned ให้แอดมิน (open + handoff + closed)
  //       - active = open + handoff (รอตอบ หรือ ตอบแล้วยังไม่ปิด)
  //       - closed = ปิดแล้ว
  const workloadMap = new Map<string, { all: number; active: number; closed: number }>();
  for (const c of openConvos) {
    const meta = statusMap.get(c.conversation_id);
    const assignedTo = meta?.assigned_to ?? c.assigned_to;
    const status = meta?.status ?? c.status;
    if (!assignedTo) continue;
    // ⚡ status=bot แปลว่าบอทกำลังตอบ — assigned_to ควรเป็น null แต่กันไว้
    if (status === "bot") continue;
    const w = workloadMap.get(assignedTo) || { all: 0, active: 0, closed: 0 };
    w.all += 1;
    if (status === "closed") {
      w.closed += 1;
    } else {
      // open, handoff, resolved, pending → ถือว่า active (รอตอบหรือตอบแล้วยังไม่ปิด)
      w.active += 1;
    }
    workloadMap.set(assignedTo, w);
  }

  // หา shop ที่ agent รับผิดชอบ (พร้อม shop names)
  const shopMap = new Map<string, { shop_id: string; shopname: string; platform: string }>();
  for (const s of shops) {
    shopMap.set(s.shop_id, { shop_id: s.shop_id, shopname: s.shopname, platform: s.platform });
  }
  const shopTeamMap = new Map<string, { shop_id: string; shopname: string; platform: string }[]>();
  for (const row of shopTeamRows) {
    const shop = shopMap.get(row.shop_id);
    if (!shop) continue;
    const arr = shopTeamMap.get(row.admin_id) || [];
    arr.push(shop);
    shopTeamMap.set(row.admin_id, arr);
  }

  // หา platform ที่ agent รับผิดชอบ
  const platformTeamMap = new Map<string, string[]>();
  for (const row of platformTeamRows) {
    const arr = platformTeamMap.get(row.admin_id) || [];
    arr.push(row.platform);
    platformTeamMap.set(row.admin_id, arr);
  }

  const agents = admins.map((a) => {
    const hist = histAgg.get(a.admin_id);
    return {
      admin_id: a.admin_id,
      name: a.name,
      username: a.username,
      role: a.role,
      active: a.active,
      is_active_agent: (a as unknown as Record<string, unknown>).is_active_agent !== false,
      assignable: a.role === "admin",
      workload: workloadMap.get(a.admin_id) || { all: 0, active: 0, closed: 0 },
      assigned_shops: (shopTeamMap.get(a.admin_id) || []).map((s) => s.shopname),
      assigned_shops_detail: shopTeamMap.get(a.admin_id) || [],
      assigned_platforms: platformTeamMap.get(a.admin_id) || [],
      // ⚡ historical stats ตาม date range
      history: hist ? {
        assigned: hist.assigned,
        closed: hist.closed,
        reopened: hist.reopened,
        handoff: hist.handoff,
        replied: hist.replied,
        resolved: hist.resolved,
      } : { assigned: 0, closed: 0, reopened: 0, handoff: 0, replied: 0, resolved: 0 },
    };
  });

  return json({
    mode,
    agents,
    total_agents: agents.length,
    active_agents: agents.filter((a) => a.is_active_agent).length,
    assignable_agents: agents.filter((a) => a.assignable).length,
    total_open_conversations: openConvos.filter((c) => {
      const meta = statusMap.get(c.conversation_id);
      return meta?.assigned_to ?? c.assigned_to;
    }).length,
    unassigned: openConvos.filter((c) => {
      const meta = statusMap.get(c.conversation_id);
      const assigned = meta?.assigned_to ?? c.assigned_to;
      const status = meta?.status ?? c.status;
      return !assigned && status !== "resolved" && status !== "closed";
    }).length,
    // ⚡ date range info
    date_range: {
      start: histStart?.toISOString() || null,
      end: histEnd?.toISOString() || null,
      range,
    },
  });
}
