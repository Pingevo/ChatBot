// /api/kb/[id]
// PUT — update a KB entry (general_faq only for now)
// DELETE — delete a KB entry
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { knowledgeBaseService } from "@/backend/service/knowledgeBaseService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;
  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return error("invalid body", 400);
  }
  const ok = await knowledgeBaseService.updateKbEntry(
    id,
    {
      topic: body.topic,
      answer: body.answer,
      question_patterns: body.question_patterns,
      platform: body.platform,
      // product_spec fields — passed through if present
      brand: body.brand,
      model: body.model,
      category: body.category,
      highlights: body.highlights,
      description: body.description,
      warranty_period: body.warranty_period,
    },
    r.ctx.admin.admin_id
  );
  if (!ok) return error("not found or not editable", 404);
  await logAdminEvent({
    action_type: "kb.update",
    actor: r.ctx.admin.admin_id,
    metadata: { kb_id: id, changes: body },
  });
  return json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;
  const { id } = await params;
  const ok = await knowledgeBaseService.deleteKbEntry(id, r.ctx.admin.admin_id);
  if (!ok) return error("not found", 404);
  await logAdminEvent({
    action_type: "kb.delete",
    actor: r.ctx.admin.admin_id,
    metadata: { kb_id: id },
  });
  return json({ ok: true });
}
