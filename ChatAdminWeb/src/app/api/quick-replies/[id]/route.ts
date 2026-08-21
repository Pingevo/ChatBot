// /api/quick-replies/[id]
// PUT — update a quick reply (เจ้าของเท่านั้น)
// DELETE — soft delete a quick reply (เจ้าของเท่านั้น)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { quickReplyService } from "@/backend/service/quickReplyService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { id } = await params;

  // ตรวจว่าเป็นเจ้าของ quick reply นี้จริง
  const coll = await getCollection<{ admin_id: string; is_deleted?: boolean }>(COLLECTIONS.quickReplies);
  const existing = await coll.findOne({ quick_reply_id: id, is_deleted: { $ne: true } });
  if (!existing) return error("not found", 404);
  if (existing.admin_id !== r.ctx.admin.admin_id) {
    return error("forbidden — แก้ได้เฉพาะ quick reply ของตัวเอง", 403);
  }

  const body = await readJson<{
    category?: string;
    title?: string;
    body?: string;
    platforms?: string[];
    shop_ids?: string[];
    enabled?: boolean;
    sort_order?: number;
  }>(req);

  const ok = await quickReplyService.updateQuickReply(id, {
    category: body?.category,
    title: body?.title,
    body: body?.body,
    platforms: body?.platforms,
    shop_ids: body?.shop_ids,
    enabled: body?.enabled,
    sort_order: body?.sort_order,
  }, r.ctx.admin.admin_id);

  if (!ok) return error("failed to update", 500);
  return json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { id } = await params;

  // ตรวจว่าเป็นเจ้าของ quick reply นี้จริง
  const coll = await getCollection<{ admin_id: string; is_deleted?: boolean }>(COLLECTIONS.quickReplies);
  const existing = await coll.findOne({ quick_reply_id: id, is_deleted: { $ne: true } });
  if (!existing) return error("not found", 404);
  if (existing.admin_id !== r.ctx.admin.admin_id) {
    return error("forbidden — ลบได้เฉพาะ quick reply ของตัวเอง", 403);
  }

  const ok = await quickReplyService.deleteQuickReply(id, r.ctx.admin.admin_id);
  if (!ok) return error("failed to delete", 500);
  return json({ ok: true });
}
