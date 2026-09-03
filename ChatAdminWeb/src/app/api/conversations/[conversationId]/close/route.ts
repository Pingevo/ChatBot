// POST /api/conversations/[conversationId]/close — ปิดแชท
// body: { reason, category, resolution, note? }
// บังคับกรอก reason, category, resolution — note ไม่บังคับ
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import type { ProblemCategory } from "@/backend/service/conversationService";

const VALID_CATEGORIES: ProblemCategory[] = [
  "shipping", "product", "payment", "return_refund",
  "warranty", "account", "promotion", "other",
];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{
    reason?: string;
    category?: string;
    resolution?: string;
    note?: string;
  }>(req);

  if (!body?.reason?.trim()) return error("กรุณาระบุเหตุผลที่ปิดแชท", 422);
  if (!body?.category) return error("กรุณาเลือกประเภทปัญหา", 422);
  if (!VALID_CATEGORIES.includes(body.category as ProblemCategory)) {
    return error(`ประเภทปัญหาไม่ถูกต้อง — ต้องเป็น: ${VALID_CATEGORIES.join(", ")}`, 422);
  }
  if (!body?.resolution?.trim()) return error("กรุณาระบุวิธีการแก้ไข", 422);

  // ℹ️ Shared inbox — admin ทุกคน close ได้
  const ok = await conversationService.closeConversation({
    conversationId,
    closedBy: r.ctx.admin.admin_id,
    reason: body.reason.trim(),
    category: body.category as ProblemCategory,
    resolution: body.resolution.trim(),
    note: body.note?.trim() || undefined,
  });

  if (!ok) return error("ไม่พบแชท หรือไม่สามารถปิดได้", 404);
  return json({ ok: true });
}
