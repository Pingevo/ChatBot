// /api/kb/[id]
// PUT — update a KB entry (general_faq only for now)
// DELETE — delete a KB entry
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { knowledgeBaseService } from "@/backend/service/knowledgeBaseService";

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
  const ok = await knowledgeBaseService.updateGeneralFaq(
    id,
    {
      topic: body.topic,
      answer: body.answer,
      question_patterns: body.question_patterns,
      platform: body.platform,
    },
    r.ctx.admin.admin_id
  );
  if (!ok) return error("not found or not editable", 404);
  return json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;
  const { id } = await params;
  const ok = await knowledgeBaseService.deleteKbEntry(id);
  if (!ok) return error("not found", 404);
  return json({ ok: true });
}
