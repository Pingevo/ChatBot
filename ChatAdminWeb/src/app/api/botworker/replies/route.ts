// GET /api/botworker/replies — ดึง shadow_replies ที่ mode=standalone (botworker รันอัตโนมัติ)
//
// ใช้สำหรับหน้า /botworker — ดูคำตอบที่ botworker generate ขึ้นมา
// แยกจาก /shadow-inbox (mode=shadowbot) เพื่อความชัดเจน
//
// Query params:
//   - platform = shopee|tiktok|lazada
//   - shop_id = เฉพาะร้าน
//   - conversation_id = เฉพาะ conversation
//   - limit = จำนวนสูงสุด (default 200, max 500)
//
// ⛔ IRON RULE: ห้ามส่งข้อความจริง ห้ามเรียก platform API
// ⚡ force-dynamic — กัน Next.js cache GET response
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { ShadowReplyDoc } from "@/backend/service/shadowReplyService";
import type { Platform } from "@/backend/lib/safety";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
  const shopId = url.searchParams.get("shop_id") || undefined;
  const conversationId = url.searchParams.get("conversation_id") || undefined;
  const limitParam = parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Math.min(Math.max(limitParam, 1), 500);

  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = {
    mode: "standalone",  // ⚡ Phase 2R — เฉพาะ botworker
    deleted_at: { $exists: false },  // ไม่เอาที่ถูก soft delete
  };
  if (platform) filter.platform = platform;
  if (shopId) filter.shop_id = shopId;
  if (conversationId) filter.conversation_id = conversationId;

  const rows = await coll
    .find(filter)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();

  return json({ rows, total: rows.length });
}
