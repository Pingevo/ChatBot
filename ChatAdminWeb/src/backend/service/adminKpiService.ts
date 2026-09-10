// adminKpiService — aggregate KPI ของแอดมิน จาก 3 ระบบ (test-chat, test-assignment, shadow-inbox)
//
// ⚡ Phase 3A — สร้างใหม่สำหรับหน้า /admin-review-kpi
//
// แหล่งข้อมูล:
//   1. test_chat_ratings — คะแนน/คอมเมนต์ของ test chat (rated_by, rated_at)
//   2. test_assignment   — replay + rate (replayed_by, conv_rated_by, message_ratings.*.rated_by)
//   3. shadow_replies    — generate + rate (generated_by, rated_by, star_rated_by, comment_by)
//   4. admin_logs        — audit log ทุก action (actor, action_type, timestamp)
//
// หลักการ:
//   - กรองตามช่วงเวลา (from/to) และ admin_id (optional)
//   - คืน KPI รวม + ราย admin + drill-down session/conversation
//   - shadow-inbox นับเฉพาะ manual (origin = manual/manual_conversation) ไม่นับ worker
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { auth } from "./authService";

export interface KpiDateRange {
  from?: Date;
  to?: Date;
}

export interface AdminKpiSummary {
  admin_id: string;
  username?: string;
  name?: string;
  role?: string;
  // ── test-chat ──
  test_chat_sessions_rated: number;       // session ที่ให้คะแนนอย่างน้อย 1 message
  test_chat_messages_rated: number;       // จำนวน message ที่ให้คะแนน
  test_chat_star_rated: number;           // ให้ดาว
  test_chat_avg_star: number;
  test_chat_good: number;
  test_chat_bad: number;
  test_chat_commented: number;            // มี comment
  // ── test-assignment ──
  test_assignment_replays: number;        // จำนวนครั้งที่กด replay
  test_assignment_msg_rated: number;      // rate per-message
  test_assignment_conv_rated: number;     // rate ทั้งแชท
  test_assignment_msg_commented: number;
  test_assignment_conv_commented: number;
  // ── shadow-inbox (manual เท่านั้น) ──
  shadow_generated: number;               // กด Generate (manual + manual_conversation)
  shadow_rated: number;                   // rate
  shadow_star_rated: number;
  shadow_commented: number;
}

export interface AdminKpiDrilldownSession {
  // test-chat session
  session_id: string;
  platform?: string;
  shop?: string;
  messages_rated: number;
  comments: number;
  avg_star: number;
  last_rated_at: Date;
}

export interface AdminKpiDrilldownReplay {
  // test-assignment replay
  conversation_id: string;
  shop_name?: string;
  platform?: string;
  total_messages: number;
  processed_messages: number;
  final_status: string;
  msg_rated: number;
  conv_star_rating?: number;
  conv_rating?: string;
  conv_comment?: string;
  replayed_at: Date;
}

export interface AdminKpiDrilldownShadow {
  // shadow reply ที่ admin นี้ generate
  shadow_reply_id: string;
  conversation_id: string;
  shop_id: string;
  platform: string;
  origin: string;
  bot_source?: string;
  rating?: string;
  star_rating?: number;
  has_comment: boolean;
  created_at: Date;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function dateFilter(field: string, range: KpiDateRange): Record<string, unknown> | undefined {
  if (!range.from && !range.to) return undefined;
  const cond: Record<string, unknown> = {};
  if (range.from) cond.$gte = range.from;
  if (range.to) cond.$lte = range.to;
  return { [field]: cond };
}

async function buildAdminNameMap(): Promise<Map<string, { username: string; name: string; role: string }>> {
  const admins = await auth.listAdmins();
  const map = new Map<string, { username: string; name: string; role: string }>();
  for (const a of admins) {
    map.set(a.admin_id, { username: a.username, name: a.name, role: a.role });
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// KPI รวมตาม admin — สำหรับตารางหลักใน dashboard
// ─────────────────────────────────────────────────────────────

export async function getAdminKpiSummary(
  range: KpiDateRange,
  adminId?: string
): Promise<AdminKpiSummary[]> {
  const nameMap = await buildAdminNameMap();
  const results = new Map<string, AdminKpiSummary>();

  function ensure(adminId: string): AdminKpiSummary {
    let r = results.get(adminId);
    if (!r) {
      const info = nameMap.get(adminId);
      r = {
        admin_id: adminId,
        username: info?.username,
        name: info?.name,
        role: info?.role,
        test_chat_sessions_rated: 0,
        test_chat_messages_rated: 0,
        test_chat_star_rated: 0,
        test_chat_avg_star: 0,
        test_chat_good: 0,
        test_chat_bad: 0,
        test_chat_commented: 0,
        test_assignment_replays: 0,
        test_assignment_msg_rated: 0,
        test_assignment_conv_rated: 0,
        test_assignment_msg_commented: 0,
        test_assignment_conv_commented: 0,
        shadow_generated: 0,
        shadow_rated: 0,
        shadow_star_rated: 0,
        shadow_commented: 0,
      };
      results.set(adminId, r);
    }
    return r;
  }

  // ── 1. test_chat_ratings ──
  const tcrColl = await getCollection<{
    session_id: string;
    msg_index: number;
    rated_by: string;
    rated_at: Date;
    star_rating?: number;
    rating?: string;
    comment?: string;
  }>(COLLECTIONS.testChatRatings);
  const tcrFilter: Record<string, unknown> = {};
  if (adminId) tcrFilter.rated_by = adminId;
  const tcrDate = dateFilter("rated_at", range);
  if (tcrDate) Object.assign(tcrFilter, tcrDate);
  const tcrDocs = await tcrColl.find(tcrFilter).sort({ rated_at: -1 }).limit(10000).toArray();

  const tcrSessions = new Set<string>();
  let tcrStarSum = 0;
  for (const d of tcrDocs) {
    if (!d.rated_by) continue;
    const r = ensure(d.rated_by);
    r.test_chat_messages_rated++;
    tcrSessions.add(`${d.rated_by}:${d.session_id}`);
    if (d.star_rating != null && d.star_rating > 0) {
      r.test_chat_star_rated++;
      tcrStarSum += d.star_rating;
    }
    if (d.rating === "good") r.test_chat_good++;
    else if (d.rating === "bad") r.test_chat_bad++;
    if (d.comment && d.comment.trim()) r.test_chat_commented++;
  }
  // sessions_rated = นับ session ที่ unique ต่อ admin
  for (const r of results.values()) {
    r.test_chat_sessions_rated = 0;
  }
  for (const key of tcrSessions) {
    const [aid] = key.split(":");
    if (aid) {
      const r = ensure(aid);
      r.test_chat_sessions_rated++;
    }
  }
  // avg_star คำนวณทีหลัง
  for (const r of results.values()) {
    if (r.test_chat_star_rated > 0) {
      // ต้องคำนวณใหม่เพราะ tcrStarSum รวมทุกคน — แยก admin
    }
  }
  // คำนวณ avg_star แยกต่อ admin
  const tcrStarByAdmin = new Map<string, { sum: number; count: number }>();
  for (const d of tcrDocs) {
    if (!d.rated_by || d.star_rating == null || d.star_rating <= 0) continue;
    const cur = tcrStarByAdmin.get(d.rated_by) || { sum: 0, count: 0 };
    cur.sum += d.star_rating;
    cur.count++;
    tcrStarByAdmin.set(d.rated_by, cur);
  }
  for (const [aid, v] of tcrStarByAdmin) {
    const r = ensure(aid);
    r.test_chat_avg_star = v.count > 0 ? Math.round((v.sum / v.count) * 100) / 100 : 0;
  }

  // ── 2. test_assignment ──
  const taColl = await getCollection<{
    conversation_id: string;
    replayed_by?: string;
    replayed_at?: Date;
    conv_rated_by?: string;
    conv_rated_at?: Date;
    conv_star_rating?: number;
    conv_rating?: string;
    conv_comment?: string;
    message_ratings?: Record<string, { rated_by?: string; rated_at?: Date; star_rating?: number; rating?: string; comment?: string }>;
    created_at: Date;
    updated_at: Date;
  }>(COLLECTIONS.testAssignment);
  const taFilter: Record<string, unknown> = {};
  // กรองตาม updated_at (replay ล่าสุด) — ถ้ามี range
  const taDate = dateFilter("updated_at", range);
  if (taDate) Object.assign(taFilter, taDate);
  const taDocs = await taColl.find(taFilter).sort({ updated_at: -1 }).limit(10000).toArray();

  for (const d of taDocs) {
    // replay count
    if (d.replayed_by && d.replayed_at) {
      const inRange = (!range.from || d.replayed_at >= range.from) && (!range.to || d.replayed_at <= range.to);
      if (inRange && (!adminId || d.replayed_by === adminId)) {
        const r = ensure(d.replayed_by);
        r.test_assignment_replays++;
      }
    }
    // conversation rating
    if (d.conv_rated_by && d.conv_rated_at) {
      const inRange = (!range.from || d.conv_rated_at >= range.from) && (!range.to || d.conv_rated_at <= range.to);
      if (inRange && (!adminId || d.conv_rated_by === adminId)) {
        const r = ensure(d.conv_rated_by);
        r.test_assignment_conv_rated++;
        if (d.conv_comment && d.conv_comment.trim()) r.test_assignment_conv_commented++;
      }
    }
    // per-message ratings
    if (d.message_ratings) {
      for (const mr of Object.values(d.message_ratings)) {
        if (!mr.rated_by || !mr.rated_at) continue;
        const inRange = (!range.from || mr.rated_at >= range.from) && (!range.to || mr.rated_at <= range.to);
        if (!inRange) continue;
        if (adminId && mr.rated_by !== adminId) continue;
        const r = ensure(mr.rated_by);
        r.test_assignment_msg_rated++;
        if (mr.comment && mr.comment.trim()) r.test_assignment_msg_commented++;
      }
    }
  }

  // ── 3. shadow_replies (manual เท่านั้น) ──
  const srColl = await getCollection<{
    shadow_reply_id: string;
    conversation_id: string;
    shop_id: string;
    platform: string;
    origin?: string;
    generated_by?: string;
    created_at: Date;
    rating?: string;
    rated_by?: string;
    rated_at?: Date;
    star_rating?: number;
    star_rated_by?: string;
    star_rated_at?: Date;
    comment?: string;
    comment_by?: string;
    comment_at?: Date;
  }>(COLLECTIONS.shadowReplies);
  const srFilter: Record<string, unknown> = {
    origin: { $in: ["manual", "manual_conversation"] },  // ไม่นับ worker
    deleted_at: { $exists: false },
  };
  const srDate = dateFilter("created_at", range);
  if (srDate) Object.assign(srFilter, srDate);
  const srDocs = await srColl.find(srFilter).sort({ created_at: -1 }).limit(10000).toArray();

  for (const d of srDocs) {
    // generate count
    if (d.generated_by) {
      if (!adminId || d.generated_by === adminId) {
        const r = ensure(d.generated_by);
        r.shadow_generated++;
      }
    }
    // rate (good/bad)
    if (d.rated_by && d.rated_at) {
      const inRange = (!range.from || d.rated_at >= range.from) && (!range.to || d.rated_at <= range.to);
      if (inRange && (!adminId || d.rated_by === adminId)) {
        const r = ensure(d.rated_by);
        r.shadow_rated++;
      }
    }
    // star rate
    if (d.star_rated_by && d.star_rated_at) {
      const inRange = (!range.from || d.star_rated_at >= range.from) && (!range.to || d.star_rated_at <= range.to);
      if (inRange && (!adminId || d.star_rated_by === adminId)) {
        const r = ensure(d.star_rated_by);
        r.shadow_star_rated++;
      }
    }
    // comment
    if (d.comment_by && d.comment_at) {
      const inRange = (!range.from || d.comment_at >= range.from) && (!range.to || d.comment_at <= range.to);
      if (inRange && (!adminId || d.comment_by === adminId)) {
        const r = ensure(d.comment_by);
        r.shadow_commented++;
      }
    }
  }

  return Array.from(results.values()).sort((a, b) => {
    // sort ตาม total activity รวม
    const aTotal = a.test_chat_messages_rated + a.test_assignment_replays + a.shadow_generated;
    const bTotal = b.test_chat_messages_rated + b.test_assignment_replays + b.shadow_generated;
    return bTotal - aTotal;
  });
}

// ─────────────────────────────────────────────────────────────
// Drill-down — รายละเอียดตาม admin
// ─────────────────────────────────────────────────────────────

export async function getTestChatSessionsByAdmin(
  adminId: string,
  range: KpiDateRange
): Promise<AdminKpiDrilldownSession[]> {
  const coll = await getCollection<{
    session_id: string;
    msg_index: number;
    platform?: string;
    shop?: string;
    rated_by: string;
    rated_at: Date;
    star_rating?: number;
    rating?: string;
    comment?: string;
  }>(COLLECTIONS.testChatRatings);
  const filter: Record<string, unknown> = { rated_by: adminId };
  const date = dateFilter("rated_at", range);
  if (date) Object.assign(filter, date);
  const docs = await coll.find(filter).sort({ rated_at: -1 }).limit(5000).toArray();

  // group by session_id
  const map = new Map<string, AdminKpiDrilldownSession>();
  for (const d of docs) {
    const existing = map.get(d.session_id);
    if (existing) {
      existing.messages_rated++;
      if (d.comment && d.comment.trim()) existing.comments++;
      if (d.star_rating != null && d.star_rating > 0) {
        // recalc avg below
      }
      if (d.rated_at > existing.last_rated_at) existing.last_rated_at = d.rated_at;
    } else {
      map.set(d.session_id, {
        session_id: d.session_id,
        platform: d.platform,
        shop: d.shop,
        messages_rated: 1,
        comments: d.comment && d.comment.trim() ? 1 : 0,
        avg_star: 0,
        last_rated_at: d.rated_at,
      });
    }
  }
  // calc avg star per session
  const starBySession = new Map<string, { sum: number; count: number }>();
  for (const d of docs) {
    if (d.star_rating == null || d.star_rating <= 0) continue;
    const cur = starBySession.get(d.session_id) || { sum: 0, count: 0 };
    cur.sum += d.star_rating;
    cur.count++;
    starBySession.set(d.session_id, cur);
  }
  for (const [sid, v] of starBySession) {
    const s = map.get(sid);
    if (s) s.avg_star = v.count > 0 ? Math.round((v.sum / v.count) * 100) / 100 : 0;
  }
  return Array.from(map.values()).sort((a, b) => b.last_rated_at.getTime() - a.last_rated_at.getTime());
}

export async function getTestAssignmentReplaysByAdmin(
  adminId: string,
  range: KpiDateRange
): Promise<AdminKpiDrilldownReplay[]> {
  const coll = await getCollection<{
    conversation_id: string;
    shop_name?: string;
    platform?: string;
    total_messages: number;
    processed_messages: number;
    final_status: string;
    replayed_by?: string;
    replayed_at?: Date;
    conv_star_rating?: number;
    conv_rating?: string;
    conv_comment?: string;
    message_ratings?: Record<string, unknown>;
    updated_at: Date;
  }>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = { replayed_by: adminId };
  const date = dateFilter("replayed_at", range);
  if (date) Object.assign(filter, date);
  const docs = await coll.find(filter).sort({ replayed_at: -1 }).limit(1000).toArray();

  return docs.map((d) => ({
    conversation_id: d.conversation_id,
    shop_name: d.shop_name,
    platform: d.platform,
    total_messages: d.total_messages,
    processed_messages: d.processed_messages,
    final_status: d.final_status,
    msg_rated: d.message_ratings ? Object.keys(d.message_ratings).length : 0,
    conv_star_rating: d.conv_star_rating,
    conv_rating: d.conv_rating,
    conv_comment: d.conv_comment,
    replayed_at: d.replayed_at || d.updated_at,
  }));
}

export async function getShadowRepliesByAdmin(
  adminId: string,
  range: KpiDateRange
): Promise<AdminKpiDrilldownShadow[]> {
  const coll = await getCollection<{
    shadow_reply_id: string;
    conversation_id: string;
    shop_id: string;
    platform: string;
    origin?: string;
    generated_by?: string;
    created_at: Date;
    bot_source?: string;
    rating?: string;
    star_rating?: number;
    comment?: string;
  }>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = {
    generated_by: adminId,
    origin: { $in: ["manual", "manual_conversation"] },
    deleted_at: { $exists: false },
  };
  const date = dateFilter("created_at", range);
  if (date) Object.assign(filter, date);
  const docs = await coll.find(filter).sort({ created_at: -1 }).limit(1000).toArray();

  return docs.map((d) => ({
    shadow_reply_id: d.shadow_reply_id,
    conversation_id: d.conversation_id,
    shop_id: d.shop_id,
    platform: d.platform,
    origin: d.origin || "manual",
    bot_source: d.bot_source,
    rating: d.rating,
    star_rating: d.star_rating,
    has_comment: !!(d.comment && d.comment.trim()),
    created_at: d.created_at,
  }));
}

export const adminKpiService = {
  getAdminKpiSummary,
  getTestChatSessionsByAdmin,
  getTestAssignmentReplaysByAdmin,
  getShadowRepliesByAdmin,
};
