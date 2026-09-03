// GET /api/admin-config — ดึงค่าที่ admin แก้ได้ (buffer config + อนาคตเพิ่มได้)
// PUT /api/admin-config — อัปเดตค่าที่ admin แก้ได้ (requireEditor — admin/superadmin/dev)
//
// ต่างจาก /api/config (requireSuperadmin):
//   /api/config        = system config (dev/superadmin เท่านั้น — สวิตช์อันตราย, bot URLs, polling)
//   /api/admin-config  = admin config (admin ขึ้นไป — buffer, และ settings ที่ปลอดภัยอื่นๆ)
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { systemConfigService, ADMIN_CONFIGURABLE_KEYS } from "@/backend/service/systemConfigService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function GET(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const config = await systemConfigService.getAdminConfig();
  return json({
    config,
    editableKeys: ADMIN_CONFIGURABLE_KEYS,
  });
}

export async function PUT(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return error("invalid body");

  // กรองเฉพาะ keys ที่ admin แก้ได้ (ป้องกันส่ง field อันตรายมา)
  const allowedSet = new Set<string>(ADMIN_CONFIGURABLE_KEYS);
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowedSet.has(key)) {
      // ตรวจค่าเบื้องต้น
  if (key === "bot_buffer_window_ms" || key === "bot_buffer_max_messages") {
        const num = Number(value);
        if (isNaN(num) || num < 1) {
          return error(`Field "${key}" must be a positive number`, 400);
        }
        if (key === "bot_buffer_window_ms" && (num < 1000 || num > 30000)) {
          return error(`Field "${key}" must be between 1000 and 30000`, 400);
        }
        if (key === "bot_buffer_max_messages" && (num < 1 || num > 20)) {
          return error(`Field "${key}" must be between 1 and 20`, 400);
        }
        filtered[key] = num;
      } else if (key === "bot_buffer_enabled") {
        filtered[key] = Boolean(value);
      } else {
        filtered[key] = value;
      }
    }
  }

  if (Object.keys(filtered).length === 0) {
    return error("no valid fields to update", 400);
  }

  const updatedBy = r.ctx.admin.username || r.ctx.admin.email || "admin";
  const updated = await systemConfigService.updateAdminConfig(filtered, updatedBy);

  await logAdminEvent({
    action_type: "admin_config.update",
    actor: r.ctx.admin.admin_id,
    metadata: { changes: filtered, updated_by: updatedBy },
  });

  return json({ ok: true, config: updated });
}
