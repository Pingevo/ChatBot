// GET /api/team — รายชื่อ agent พร้อม workload + สถานะ + ร้าน/แพลตฟอร์มที่ดูแล
// ⚡ อ่าน workload จาก status_conversation (admin-owned — ไม่โดน dump ทับ)
// ⚡ รวม shop_team + platform_team พร้อม shop names ใน response
// ⚡ รองรับ start_date/end_date สำหรับ historical stats จาก admin_logs
// ⚡ Optimized: ใช้ $lookup aggregation คำนวณ workload ใน DB แทนการโหลด 5000 docs เข้า memory
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";
import { assignmentService } from "@/backend/service/assignmentService";
import { shopService } from "@/backend/service/shopService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { ConversationStatus, ConversationDoc } from "@/backend/service/conversationService";

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

  // ⚡ Optimized: คำนวณ workload จาก status_conversation โดยตรง (collection เล็ก — เก็บเฉพาะที่แอดมินแตะ)
  //   - ไม่ต้อง $lookup join 142230 conversations (ช้า + กิน memory)
  //   - status_conversation เป็น admin-owned (ไม่โดน dump ทับ) → source of truth สำหรับ assigned_to/status
  //   - มี index ที่ assigned_to แล้ว → aggregation เร็ว
  const workloadAggPromise = (async () => {
    const coll = await getCollection<{
      conversation_id: string;
      assigned_to?: string | null;
      status?: ConversationStatus;
    }>(COLLECTIONS.statusConversation);
    const agg = await coll.aggregate<{
      _id: string;
      all: number;
      active: number;
      closed: number;
    }>([
      {
        $match: {
          assigned_to: { $exists: true, $nin: [null, ""] },
          status: { $ne: "bot" },
        },
      },
      {
        $group: {
          _id: "$assigned_to",
          all: { $sum: 1 },
          active: { $sum: { $cond: [{ $ne: ["$status", "closed"] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
        },
      },
    ]).toArray();
    return new Map(agg.map((a) => [a._id, { all: a.all, active: a.active, closed: a.closed }]));
  })();

  const [admins, workloadMap, mode, shopTeamRows, platformTeamRows, shops, histAgg, realCounts] = await Promise.all([
    auth.listAdmins(),
    workloadAggPromise,
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
    // ⚡ real counts จาก DB aggregation (ไม่จำกัด limit 5000)
    //   - total = ทั้งหมดใน conversations_shp
    //   - assigned = มี assigned_to ที่ไม่ใช่ null
    //   - unassigned = ไม่มี assigned_to + ไม่ใช่ closed/resolved
    //   - unassigned_handoff = ไม่มี assigned_to + status=handoff (รอแอดมินรับจริง)
    //   - unassigned_open = ไม่มี assigned_to + status=open (บอทตอบอยู่หรือยังไม่มีคนตอบ)
    (async () => {
      const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
      const notAssigned = { $or: [{ assigned_to: { $type: 10 } }, { assigned_to: { $exists: false } }] } as Record<string, unknown>;
      const [total, assigned, unassigned, unassignedHandoff, unassignedOpen] = await Promise.all([
        coll.countDocuments({}),
        coll.countDocuments({ assigned_to: { $type: 2 } }),
        coll.countDocuments({ ...notAssigned, status: { $nin: ["resolved", "closed"] } }),
        coll.countDocuments({ ...notAssigned, status: "handoff" }),
        coll.countDocuments({ ...notAssigned, status: "open" }),
      ]);
      return { total, assigned, unassigned, unassignedHandoff, unassignedOpen };
    })(),
  ]);

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
    // ⚡ ใช้ real counts จาก DB aggregation (ไม่จำกัด limit 5000)
    total_open_conversations: realCounts.assigned,
    unassigned: realCounts.unassigned,
    // ⚡ แยกย่อย: handoff (รอแอดมินรับจริง) vs open (บอทตอบอยู่/ยังไม่มีคนตอบ)
    unassigned_handoff: realCounts.unassignedHandoff,
    unassigned_open: realCounts.unassignedOpen,
    total_conversations: realCounts.total,
    // ⚡ date range info
    date_range: {
      start: histStart?.toISOString() || null,
      end: histEnd?.toISOString() || null,
      range,
    },
  });
}
