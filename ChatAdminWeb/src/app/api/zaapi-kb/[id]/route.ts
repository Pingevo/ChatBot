// PATCH /api/zaapi-kb/[id] — แก้ไข doc (fields/text/source_name/active toggle)
// DELETE /api/zaapi-kb/[id] — ลบ doc
import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection } from "@/backend/db/mongoClient";
import { logAdminEvent } from "@/backend/service/adminLogService";

const COLL = "zaapi_kb";
const EDITABLE = new Set(["fields", "text", "source_name", "active", "unscoped"]);

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;
  const { id } = await ctx.params;

  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return error("invalid id", 400);
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("invalid body", 400);
  }

  const set: Record<string, unknown> = {
    manual_edit: true,                       // mark ว่าโดนแก้ — importer ห้ามทับ
    edited_at: new Date().toISOString(),
    edited_by: r.ctx.admin.admin_id,
  };
  for (const k of Object.keys(body)) {
    if (!EDITABLE.has(k)) continue;
    if (k === "active" || k === "unscoped") set[k] = body[k] === true;
    else if (k === "fields") set[k] = typeof body[k] === "object" && body[k] ? body[k] : {};
    else set[k] = String(body[k] ?? "");
  }

  const coll = await getCollection(COLL);
  const res = await coll.updateOne({ _id: oid }, { $set: set });
  if (res.matchedCount === 0) return error("not found", 404);
  await logAdminEvent({
    action_type: "kb.update",
    actor: r.ctx.admin.admin_id,
    metadata: { corpus: "zaapi", id, keys: Object.keys(body).filter((k) => EDITABLE.has(k)) },
  });
  return json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;
  const { id } = await ctx.params;

  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return error("invalid id", 400);
  }
  const coll = await getCollection(COLL);
  const res = await coll.deleteOne({ _id: oid });
  if (res.deletedCount === 0) return error("not found", 404);
  await logAdminEvent({
    action_type: "kb.delete",
    actor: r.ctx.admin.admin_id,
    metadata: { corpus: "zaapi", id },
  });
  return json({ ok: true });
}
