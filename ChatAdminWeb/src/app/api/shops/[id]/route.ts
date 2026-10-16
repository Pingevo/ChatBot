// PATCH /api/shops/[id] — update shop (toggle connected / bot_worker_enabled)
import { NextRequest } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { shopService } from "@/backend/service/shopService";
import { BOTWORKER_BACKENDS } from "@/backend/lib/safety";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePageEdit(req, "shop");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await readJson<{
    connected?: boolean;
    bot_worker_enabled?: boolean;
    expected_bot_worker_enabled?: boolean;
  }>(req).catch(() => null);
  const hasConnected = body !== null && "connected" in body;
  const hasBotWorker = body !== null && "bot_worker_enabled" in body;
  if (!body || (!hasConnected && !hasBotWorker)) {
    return error("connected or bot_worker_enabled (boolean) is required", 400);
  }
  // ⚡ Phase 2D CAS — one request = one command: ไม่มี production caller
  //   ส่งสอง field พร้อมกัน → reject mixed command ก่อน write (ลบ partial-write path)
  if (hasConnected && hasBotWorker) {
    return error("send either connected or bot_worker_enabled per request", 422);
  }
  if (hasConnected && typeof body.connected !== "boolean") {
    return error("connected must be boolean", 400);
  }
  if (hasBotWorker && typeof body.bot_worker_enabled !== "boolean") {
    return error("bot_worker_enabled must be boolean", 400);
  }
  // ⚡ Phase 2D CAS — caller ต้องส่ง persisted value ที่มันเห็น (missing field ≡ false)
  if (hasBotWorker && typeof body.expected_bot_worker_enabled !== "boolean") {
    return error("expected_bot_worker_enabled (boolean) is required", 400);
  }
  const shop = await shopService.getShop(id);
  if (!shop) return error("shop not found", 404);
  // ⚡ Phase 2D — เปิด botworker ได้เฉพาะ platform ที่มี chatbot backend
  //   (BOTWORKER_BACKENDS เดียวกับ scope resolver); ปิด flag เดิมได้เสมอ;
  //   reject ก่อน write ทุก field → zero write/zero audit เมื่อ invalid
  if (hasBotWorker && body.bot_worker_enabled === true &&
      !(BOTWORKER_BACKENDS as readonly string[]).includes(shop.platform)) {
    return error("bot_worker is not available for this platform", 422);
  }

  // ⚡ Phase 2D — เขียนทีละ field ผ่าน service owner เดียวกัน; audit ต่อ field
  //   (config.shop_toggle — metadata.field บอกชัดว่า flag ไหนเปลี่ยน)
  if (hasConnected) {
    await shopService.setShopConnected(id, body.connected!);
    // ⚡ G1 — log shop connected toggle
    await logAdminEvent({
      action_type: "config.shop_toggle",
      actor: r.ctx.admin.admin_id,
      shop_id: id,
      metadata: { field: "connected", value: body.connected, platform: shop.platform },
      ip: r.ctx.ip,
    });
  }
  if (hasBotWorker) {
    // ⚡ Phase 2D CAS — atomic updateOne เดียว (match = persisted===expected
    //   + platform fence ตอน enable); miss → re-read ครั้งเดียว classify:
    //   shop หาย = 404 / enable บน platform ที่เพิ่งกลายเป็น unsupported = 422 /
    //   อื่นๆ = 409 stale state — ไม่ retry, UI reload authoritative rows เอง
    const matched = await shopService.setShopBotWorker(
      id,
      body.bot_worker_enabled!,
      body.expected_bot_worker_enabled!
    );
    if (!matched) {
      const cur = await shopService.getShop(id);
      if (!cur) return error("shop not found", 404);
      if (body.bot_worker_enabled === true &&
          !(BOTWORKER_BACKENDS as readonly string[]).includes(cur.platform)) {
        return error("bot_worker is not available for this platform", 422);
      }
      return error("shop botworker state changed; reload and try again", 409);
    }
    await logAdminEvent({
      action_type: "config.shop_toggle",
      actor: r.ctx.admin.admin_id,
      shop_id: id,
      metadata: { field: "bot_worker_enabled", value: body.bot_worker_enabled, platform: shop.platform },
      ip: r.ctx.ip,
    });
  }
  return json({ ok: true });
}
