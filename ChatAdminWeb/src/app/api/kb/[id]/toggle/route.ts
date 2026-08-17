// PATCH /api/kb/[id]/toggle — enable/disable a KB entry
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { knowledgeBaseService } from "@/backend/service/knowledgeBaseService";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;
  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return error("invalid body", 400);
  }
  if (typeof body?.active !== "boolean") return error("active (boolean) is required", 400);
  const ok = await knowledgeBaseService.toggleKbActive(id, body.active);
  if (!ok) return error("not found", 404);
  return json({ ok: true });
}
