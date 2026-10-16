// GET /api/config — ดึง SystemConfig ปัจจุบัน (สวิตช์อันตรายเสมอ false จาก SAFETY)
// PUT /api/config — อัปเดตสวิตช์ปลอดภัย (mock_mode, shadow_bot, polling, bot URLs) เท่านั้น
//   สวิตช์อันตราย (live_read/send/mark_read/pin/poll — ทุก platform) ไม่สามารถเปลี่ยนได้
import { NextRequest } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { systemConfigService } from "@/backend/service/systemConfigService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { SAFETY, BOTWORKER_BACKENDS, type Platform } from "@/backend/lib/safety";
import { isSafeFetchUrl } from "@/backend/lib/urlSafety";

export async function GET(req: NextRequest) {
  // 🔒 จำกัดเฉพาะ dev — config มี infrastructure metadata ที่ไม่ควรเปิดให้ admin/superadmin ทั่วไป
  const r = await requirePageEdit(req, "config");
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
  const r = await requirePageEdit(req, "config"); // dev only
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

  // ⚡ Workflow engine — validate priority + timeout ก่อนบันทึก
  if ("workflow_priority" in body && !["workflow_first", "trigger_first", "both"].includes(String(body.workflow_priority))) {
    return error("workflow_priority must be workflow_first | trigger_first | both", 422);
  }
  if ("workflow_run_timeout_ms" in body) {
    const t = Number(body.workflow_run_timeout_ms);
    if (!Number.isFinite(t) || t < 60000 || t > 86400000) {
      return error("workflow_run_timeout_ms must be between 60000 (1 min) and 86400000 (24 h)", 422);
    }
  }
  // ⚡ Phase 8 — validate llm_context_limit (10-50)
  if ("llm_context_limit" in body) {
    const l = Number(body.llm_context_limit);
    if (!Number.isFinite(l) || l < 10 || l > 50) {
      return error("llm_context_limit must be between 10 and 50", 422);
    }
  }
  // ⚡ Task 5B3-D — grouped retrieval flags ต้องเป็น boolean เท่านั้น
  for (const key of ["grouped_retrieval_shadow_enabled", "grouped_retrieval_selection_enabled"]) {
    if (key in body && typeof body[key] !== "boolean") {
      return error(`${key} must be a boolean`, 422);
    }
  }

  // ⚡ Phase 2D — bot_worker_platforms CAS: object ของ boolean ต่อ platform เท่านั้น
  //   + expected_bot_worker_platforms บังคับ (optimistic CAS เหมือน shop toggle):
  //   write filter บน persisted===expected (missing ≡ false) — stale caller → 409
  //   zero write/zero audit; เปิดได้เฉพาะ BOTWORKER_BACKENDS (422 ก่อน write เสมอ)
  if ("bot_worker_platforms" in body) {
    const v = body.bot_worker_platforms;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      return error("bot_worker_platforms must be an object of { platform: boolean }", 422);
    }
    const exp = body.expected_bot_worker_platforms;
    if (exp === null || typeof exp !== "object" || Array.isArray(exp)) {
      return error("expected_bot_worker_platforms must be an object of { platform: boolean }", 400);
    }
    const known: Platform[] = ["shopee", "tiktok", "lazada"];
    const entries = Object.entries(v as Record<string, unknown>);
    // ⚡ single-command contract — >1 platform key = partial-commit risk
    //   (key1 commit แล้ว key2 409 → half-applied + zero audit); fields อื่น
    //   ในคำสั่งเดียวกัน ห้ามถูก drop เงียบๆ — reject ทั้งก้อนก่อน CAS เลย
    const extraKeys = Object.keys(body).filter(
      (k) => k !== "bot_worker_platforms" && k !== "expected_bot_worker_platforms"
    );
    if (extraKeys.length > 0) {
      return error(`bot_worker_platforms is a single-command payload — do not combine with: ${extraKeys.join(",")}`, 422);
    }
    if (entries.length !== 1) {
      return error("bot_worker_platforms accepts exactly one platform key per request", 422);
    }
    for (const [k, val] of entries) {
      if (!known.includes(k as Platform)) {
        return error(`bot_worker_platforms.${k} — unknown platform`, 422);
      }
      if (typeof val !== "boolean") {
        return error(`bot_worker_platforms.${k} must be boolean`, 422);
      }
      const expVal = (exp as Record<string, unknown>)[k];
      if (typeof expVal !== "boolean") {
        return error(`expected_bot_worker_platforms.${k} must be a boolean`, 400);
      }
      if (val === true && !(BOTWORKER_BACKENDS as readonly string[]).includes(k)) {
        return error(`bot_worker_platforms.${k} — chatbot backend is not implemented`, 422);
      }
    }
    // validated → per-key CAS (owner เดียวใน systemConfigService) — ไม่มี retry
    const updatedBy = r.ctx.admin.username || r.ctx.admin.email || 'admin';
    const changed: string[] = [];
    for (const [k, val] of entries) {
      const res = await systemConfigService.setBotWorkerPlatformEnabled(
        k, val as boolean, (exp as Record<string, boolean>)[k], updatedBy);
      if (!res.applied) {
        return error(
          `bot_worker_platforms.${k} changed by another admin — current=${res.current}`,
          409
        );
      }
      if (res.changed) changed.push(k);
    }
    if (changed.length) {
      await logAdminEvent({
        action_type: "config.update",
        actor: r.ctx.admin.admin_id,
        metadata: { changes: { bot_worker_platforms: v }, changed_platforms: changed, updated_by: updatedBy },
      });
    }
    return json({ ok: true, config: await systemConfigService.getSystemConfig(true) });
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
