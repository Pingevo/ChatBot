// GET /api/assignment/config — ดึงโหมด assignment ปัจจุบัน
// PUT /api/assignment/config — เปลี่ยนโหมด (equal_global | equal_per_shop | equal_per_platform)
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { assignmentService, type AssignmentMode } from "@/backend/service/assignmentService";
import { logAdminEvent } from "@/backend/service/adminLogService";

const VALID_MODES: AssignmentMode[] = ["equal_global", "equal_per_shop", "equal_per_platform"];

export async function GET(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const mode = await assignmentService.getActiveAssignmentConfig();
  return json({ mode });
}

export async function PUT(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ mode?: string }>(req);
  if (!body?.mode) return error("mode is required");
  if (!VALID_MODES.includes(body.mode as AssignmentMode)) {
    return error(`mode must be one of: ${VALID_MODES.join(", ")}`);
  }

  const updatedBy = r.ctx.admin.username || r.ctx.admin.email || "admin";
  await assignmentService.setAssignmentMode(body.mode as AssignmentMode, updatedBy);

  await logAdminEvent({
    action_type: "assignment.mode_change",
    actor: r.ctx.admin.admin_id,
    metadata: { new_mode: body.mode, updated_by: updatedBy },
  });

  return json({ ok: true, mode: body.mode });
}
