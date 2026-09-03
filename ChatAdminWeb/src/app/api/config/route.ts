// GET /api/config — ดึง SystemConfig ปัจจุบัน (สวิตช์อันตรายเสมอ false จาก SAFETY)
// PUT /api/config — อัปเดตสวิตช์ปลอดภัย (mock_mode, shadow_bot, polling, bot URLs) เท่านั้น
//   สวิตช์อันตราย (live_read/send/mark_read/pin/poll — ทุก platform) ไม่สามารถเปลี่ยนได้
import { NextRequest } from "next/server";
import { requireSuperadmin } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { systemConfigService } from "@/backend/service/systemConfigService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { SAFETY } from "@/backend/lib/safety";
import { isSafeFetchUrl } from "@/backend/lib/urlSafety";

export async function GET(req: NextRequest) {
  // 🔒 จำกัดเฉพาะ superadmin/dev — config มี infrastructure metadata ที่ไม่ควรเปิดให้ admin ทั่วไป
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const config = await systemConfigService.getSystemConfig(true);

  // ข้อมูล env (ไม่เปิดเผย secret)
  const envInfo = {
    has_dbwallet_mongo: !!process.env.MONGO_URI,
    mongo_db: process.env.MONGO_DB || 'dbWallet',
    has_shopee_partner_key: !!process.env.SHOPEE_PARTNER_KEY,
    shopee_partner_id: process.env.SHOPEE_PARTNER_ID || '(not set)',
    mock_mode_enabled: process.env.MOCK_MODE_ENABLED === 'true',
    shadow_bot_enabled: process.env.SHADOW_BOT_ENABLED === 'true',
  };

  return json({
    config,
    safety: SAFETY,
    envInfo,
    // แจ้งชัดเจนว่าสวิตช์อันตรายล็อคไว้ (รองรับ 3 platform)
    lockedSwitches: [
      'shopee_live_read_enabled',
      'shopee_live_send_enabled',
      'shopee_live_mark_read_enabled',
      'shopee_live_pin_enabled',
      'shopee_poll_enabled',
      'tiktok_live_send_enabled',
      'tiktok_live_read_enabled',
      'lazada_live_send_enabled',
      'lazada_live_read_enabled',
    ],
  });
}

export async function PUT(req: NextRequest) {
  const r = await requireSuperadmin(req); // superadmin or dev only — admin is read-only
  if (!r.ok) return r.response;

  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return error("invalid body");

  // ป้องกัน: ถ้ามีคนส่งสวิตช์อันตรายมา ปฏิเสธทันที (ทุก platform)
  const dangerousKeys = [
    'shopee_live_read_enabled',
    'shopee_live_send_enabled',
    'shopee_live_mark_read_enabled',
    'shopee_live_pin_enabled',
    'shopee_poll_enabled',
    'tiktok_live_send_enabled',
    'tiktok_live_read_enabled',
    'lazada_live_send_enabled',
    'lazada_live_read_enabled',
  ];
  for (const key of dangerousKeys) {
    if (key in body) {
      return error(
        `Field "${key}" is locked by Iron Rule and cannot be modified. ` +
        `Safety switches for platform API are permanently disabled.`,
        403
      );
    }
  }

  // 🔒 SSRF protection — ตรวจสอบ URL fields ที่ server จะ fetch
  const urlFields = ["shopee_bot_url", "tiktok_bot_url", "lazada_bot_url"];
  for (const key of urlFields) {
    if (key in body && typeof body[key] === "string" && body[key]) {
      const check = isSafeFetchUrl(body[key] as string);
      if (!check.ok) {
        return error(`Field "${key}" rejected: ${check.reason}`, 400);
      }
    }
  }

  const updatedBy = r.ctx.admin.username || r.ctx.admin.email || 'admin';
  const updated = await systemConfigService.updateSystemConfig(body, updatedBy);

  // Log config change
  await logAdminEvent({
    action_type: "config.update",
    actor: r.ctx.admin.admin_id,
    metadata: { changes: body, updated_by: updatedBy },
  });

  return json({ ok: true, config: updated });
}
