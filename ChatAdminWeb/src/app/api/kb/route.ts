// GET /api/kb — list knowledge base entries
// POST /api/kb — create a general_faq entry
import { NextRequest } from "next/server";
import { requireAuth, requireEditor } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { knowledgeBaseService, type KbType } from "@/backend/service/knowledgeBaseService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const type = (url.searchParams.get("type") as KbType | null) ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const activeOnly = url.searchParams.get("active_only") === "1";
  const limit = parseInt(url.searchParams.get("limit") || "100", 10);
  const skip = parseInt(url.searchParams.get("skip") || "0", 10);

  const [rows, total] = await Promise.all([
    knowledgeBaseService.listKbEntries({ type, search, activeOnly, limit, skip }),
    knowledgeBaseService.countKbEntries(type),
  ]);

  return json({ rows, total });
}

export async function POST(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return error("invalid body", 400);
  }
  if (!body?.topic || !body?.answer) return error("topic and answer are required", 400);

  const doc = await knowledgeBaseService.createGeneralFaq({
    topic: body.topic,
    answer: body.answer,
    questionPatterns: body.question_patterns || [],
    platform: body.platform || "all",
    createdBy: r.ctx.admin.admin_id,
  });
  await logAdminEvent({
    action_type: "kb.create",
    actor: r.ctx.admin.admin_id,
    metadata: { kb_id: doc.kb_id, topic: body.topic, platform: body.platform || "all" },
  });
  return json(doc, 201);
}
