// API: /api/chat-annotations
//
// ⚡ Phase 3B-1 — markup dot + note สำหรับ test-assignment + shadow-bot
// ⚡ Phase 3B-6 — รองรับ generation_batch_id (shadow_bot) แยก mark ตามรอบ generate
// ⚡ Phase 3B-7 — รองรับ generation_batch_id (test_assignment) เก็บ replay_batch_id แยก mark ตามรอบ replay
//
// GET /api/chat-annotations?scope=test_assignment&conversation_ids=id1,id2,id3
//   → ดึง annotations ของ scope + conversation_ids ที่สนใจ
// GET /api/chat-annotations?scope=shadow_bot&generation_batch_ids=bid1,bid2
//   → ⚡ Phase 3B-6 — ดึง annotations ตาม batch (shadow_bot)
// GET /api/chat-annotations?scope=test_assignment&generation_batch_ids=bid1,bid2
//   → ⚡ Phase 3B-7 — ดึง annotations ตาม replay batch (test_assignment)
//
// POST /api/chat-annotations
//   body: { scope, conversation_id, color, note, generation_batch_id? }
//   → สร้างหรืออัปเดต annotation (upsert ตาม scope + conversation_id [+ batch_id])
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { chatAnnotationService, type AnnotationScope } from "@/backend/service/chatAnnotationService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export const dynamic = "force-dynamic";

const VALID_SCOPES: AnnotationScope[] = ["test_assignment", "shadow_bot"];
const VALID_COLORS = ["red", "yellow", "green", "blue", "purple", "orange", "pink", "gray"];

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") || "") as AnnotationScope;
  if (!VALID_SCOPES.includes(scope)) return error("invalid scope", 422);

  const convIdsParam = url.searchParams.get("conversation_ids") || "";
  const conversationIds = convIdsParam
    ? convIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  // ⚡ Phase 3B-6/3B-7 — filter ตาม generation_batch_id (shadow_bot=test_batch, test_assignment=replay_batch)
  const batchIdsParam = url.searchParams.get("generation_batch_ids") || "";
  const generationBatchIds = batchIdsParam
    ? batchIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const annotations = await chatAnnotationService.listAnnotations({ scope, conversationIds, generationBatchIds });
  return json({ annotations });
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    scope: string;
    conversation_id: string;
    color: string;
    note: string;
    generation_batch_id?: string;  // ⚡ Phase 3B-6/3B-7 — ผูกกับรอบ (shadow_bot=generate, test_assignment=replay)
  }>(req);

  if (!body) return error("body required", 422);
  if (!VALID_SCOPES.includes(body.scope as AnnotationScope)) return error("invalid scope", 422);
  if (!body.conversation_id) return error("conversation_id required", 422);
  if (!VALID_COLORS.includes(body.color)) return error(`invalid color (must be one of: ${VALID_COLORS.join(", ")})`, 422);

  const annotation = await chatAnnotationService.upsertAnnotation({
    scope: body.scope as AnnotationScope,
    conversationId: String(body.conversation_id),
    color: String(body.color),
    note: String(body.note || ""),
    createdBy: r.ctx.admin.admin_id,
    generationBatchId: body.generation_batch_id ? String(body.generation_batch_id) : undefined,
  });

  // ⚡ Phase 3B-1 — audit log: สร้าง/แก้ไข annotation
  await logAdminEvent({
    action_type: "chat_annotation.upsert",
    actor: r.ctx.admin.admin_id,
    conversation_id: String(body.conversation_id),
    metadata: {
      scope: body.scope,
      color: body.color,
      note: String(body.note || ""),
      annotation_id: annotation.annotation_id,
      is_new: annotation.created_at === annotation.updated_at,
      ...(body.generation_batch_id ? { generation_batch_id: String(body.generation_batch_id) } : {}),
    },
  });

  return json({ annotation });
}
