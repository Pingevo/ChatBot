// GET /api/zaapi-kb — read-only view ของ Zaapi KB corpus (collection zaapi_kb)
//   ?mode=sources → group by source_id (name, accounts, doc counts)
//   ?mode=docs&source_id=X&skip=&limit= → docs ของ source (paginated)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection } from "@/backend/db/mongoClient";
import { safeRegexSearch } from "@/backend/lib/regexEscape";

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
    return json({
      docs: docs.map((d) => ({
        id: String(d._id),
        row_index: d.row_index,
        sheet: d.sheet,
        kind: d.kind,
        fields: d.fields || {},
        text: d.text || "",
        source_name: d.source_name,
        active: d.active !== false,
      })),
      total,
    });
  }

  return error("unknown mode", 400);
}
