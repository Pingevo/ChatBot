// /api/persona/[id]
// GET    — ดึง persona ตาม id
// PATCH  — toggle enabled หรือแก้ notes
// DELETE — ลบ persona (hard delete — chatbot จะ fallback ไปใช้ "ชื่อร้าน" เดิม)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { personaService } from "@/backend/service/personaService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { id } = await params;

  const coll = await getCollection(COLLECTIONS.shopPersonas);
  const doc = await coll.findOne({ persona_id: id, is_deleted: { $ne: true } });
  if (!doc) return error("not found", 404);
  return json(doc);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { id } = await params;

  const body = await readJson<{
    enabled?: boolean;
    notes?: string;
    bot_name?: string; // อนุญาตให้แก้ bot_name ผ่าน PATCH ได้ด้วย
  }>(req);

  // ตรวจว่ามี persona นี้จริง (ไม่ใช่ soft-deleted)
  const coll = await getCollection<{ bot_name?: string; enabled?: boolean; notes?: string; shopname?: string; platform?: string }>(
    COLLECTIONS.shopPersonas
  );
  const existing = await coll.findOne({ persona_id: id, is_deleted: { $ne: true } });
  if (!existing) return error("not found", 404);

  // toggle enabled
  if (typeof body?.enabled === "boolean" && body.notes === undefined && body.bot_name === undefined) {
    const ok = await personaService.togglePersona(id, body.enabled, r.ctx.admin.admin_id);
    if (!ok) return error("failed to toggle", 500);
    return json({ ok: true, enabled: body.enabled });
  }

  // แก้ bot_name หรือ notes — upsert ใหม่ผ่าน service (ใช้ shopname+platform เป็น key)
  if (body?.bot_name !== undefined || body?.notes !== undefined) {
    if (!existing.shopname || !existing.platform) {
      return error("persona missing shopname/platform — cannot update", 500);
    }
    const updated = await personaService.upsertPersona({
      shopname: existing.shopname,
      platform: existing.platform as "shopee" | "tiktok" | "lazada",
      botName: body?.bot_name ?? existing.bot_name ?? "",
      enabled: body?.enabled ?? existing.enabled,
      notes: body?.notes ?? existing.notes,
      updatedBy: r.ctx.admin.admin_id,
    });
    return json(updated);
  }

  return error("nothing to update", 400);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { id } = await params;

  const ok = await personaService.deletePersona(id, r.ctx.admin.admin_id);
  if (!ok) return error("not found or already deleted", 404);
  return json({ ok: true });
}
