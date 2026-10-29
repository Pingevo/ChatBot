// GET /api/zaapi-kb — imported Zaapi KB corpus (collection zaapi_kb)
//   ?mode=sources → group by source_id (name, accounts, doc counts)
//   ?mode=docs&source_id=X → docs ของ source
//   ?mode=list&q&platform&active&sort&skip&limit → flat list + filter + paginate (card view)
// POST /api/zaapi-kb — สร้าง doc ใหม่ (manual entry — unscoped ใช้ได้ทุกร้าน)
import { NextRequest } from "next/server";
import { requireAuth, requirePageEdit } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection } from "@/backend/db/mongoClient";
import { safeRegexSearch } from "@/backend/lib/regexEscape";
import { logAdminEvent } from "@/backend/service/adminLogService";

const COLL = "zaapi_kb";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "sources";
  const coll = await getCollection(COLL);

  if (mode === "sources") {
    const q = url.searchParams.get("q")?.trim() || "";
    const match: Record<string, unknown> = {};
    if (q) match.source_name = { $regex: safeRegexSearch(q), $options: "i" };
    const sources = await coll
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: "$source_id",
            source_name: { $first: "$source_name" },
            accounts: { $first: "$accounts" },
            version_id: { $first: "$version_id" },
            zaapi_updated_at: { $first: "$zaapi_updated_at" },
            docs: { $sum: 1 },
            active_docs: { $sum: { $cond: [{ $ne: ["$active", false] }, 1, 0] } },
          },
        },
        { $sort: { source_name: 1 } },
      ])
      .toArray();
    return json({
      sources: sources.map((s) => ({
        source_id: s._id,
        source_name: s.source_name,
        accounts: s.accounts || [],
        version_id: s.version_id,
        zaapi_updated_at: s.zaapi_updated_at,
        docs: s.docs,
        active_docs: s.active_docs,
      })),
    });
  }

  if (mode === "docs") {
    const sourceId = url.searchParams.get("source_id") || "";
    if (!sourceId) return error("source_id required", 400);
    const skip = Math.max(0, parseInt(url.searchParams.get("skip") || "0", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "30", 10)));
    const filter = { source_id: sourceId };
    const [docs, total] = await Promise.all([
      coll
        .find(filter, {
          projection: {
            row_index: 1, sheet: 1, kind: 1, fields: 1, text: 1,
            source_name: 1, active: 1,
          },
        })
        .sort({ row_index: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      coll.countDocuments(filter),
    ]);
    return json({ docs: docs.map(_docRow), total });
  }

  if (mode === "list") {
    const q = url.searchParams.get("q")?.trim() || "";
    const platform = url.searchParams.get("platform") || "";
    const active = url.searchParams.get("active") || "";
    const sort = url.searchParams.get("sort") || "recent";
    const skip = Math.max(0, parseInt(url.searchParams.get("skip") || "0", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "24", 10)));

    const filter: Record<string, unknown> = {};
    if (q) {
      const rx = { $regex: safeRegexSearch(q), $options: "i" };
      filter.$or = [{ text: rx }, { source_name: rx }];
    }
    if (platform) filter["accounts.platform"] = platform;
    if (active === "active") filter.active = { $ne: false };
    else if (active === "inactive") filter.active = false;

    const sortSpec: Record<string, 1 | -1> =
      sort === "name" ? { source_name: 1, row_index: 1 }
      : sort === "oldest" ? { imported_at: 1 }
      : { imported_at: -1 };

    const [docs, total] = await Promise.all([
      coll
        .find(filter, {
          projection: {
            row_index: 1, sheet: 1, kind: 1, fields: 1, text: 1,
            source_name: 1, source_id: 1, accounts: 1, unscoped: 1,
            active: 1, manual_edit: 1, zaapi_updated_at: 1, imported_at: 1,
          },
        })
        .sort(sortSpec)
        .skip(skip)
        .limit(limit)
        .toArray(),
      coll.countDocuments(filter),
    ]);
    return json({
      docs: docs.map((d) => ({
        ..._docRow(d),
        source_id: d.source_id,
        accounts: d.accounts || [],
        unscoped: d.unscoped === true,
        manual_edit: d.manual_edit === true,
        updated_at: d.zaapi_updated_at || d.imported_at,
      })),
      total,
    });
  }

  return error("unknown mode", 400);
}

function _docRow(d: Record<string, unknown>) {
  return {
    id: String(d._id),
    row_index: d.row_index,
    sheet: d.sheet,
    kind: d.kind,
    fields: d.fields || {},
    text: d.text || "",
    source_name: d.source_name,
    active: d.active !== false,
  };
}

export async function POST(req: NextRequest) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return error("invalid body", 400);
  }
  const text = String(body?.text || "").trim();
  const fields = (body?.fields && typeof body.fields === "object") ? body.fields : {};
  if (!text && Object.keys(fields).length === 0)
    return error("text or fields required", 400);

  const now = new Date().toISOString();
  const sourceId = String(body.source_id || "manual");
  const doc = {
    source_id: sourceId,
    source_name: String(body.source_name || "เพิ่มเอง").trim(),
    kind: "manual",
    row_index: Number.isFinite(body.row_index) ? body.row_index : 0,
    fields,
    text: text || Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n"),
    // เพิ่มในกลุ่มเดิม → inherit accounts ของ source (scope เดียวกัน)
    // สร้าง manual ทั่วไป → unscoped ใช้ได้ทุกร้าน
    accounts: Array.isArray(body.accounts) ? body.accounts : [],
    unscoped: body.unscoped === false ? false : sourceId === "manual",
    manual_edit: true,         // กัน importer ลบ/ทับ
    active: true,
    imported_at: now,
    created_by: r.ctx.admin.admin_id,
  };
  const coll = await getCollection(COLL);
  const res = await coll.insertOne(doc);
  await logAdminEvent({
    action_type: "kb.create",
    actor: r.ctx.admin.admin_id,
    metadata: { corpus: "zaapi", id: String(res.insertedId), source_name: doc.source_name },
  });
  return json({ id: String(res.insertedId) }, 201);
}
