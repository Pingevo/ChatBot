// GET /api/zaapi-kb/mapping — file manifest + saved mapping + shop list
// POST /api/zaapi-kb/mapping — upsert mapping ต่อไฟล์ลง zaapi_kb_mappings
import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireAuth, requirePageEdit } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection } from "@/backend/db/mongoClient";
import { logAdminEvent } from "@/backend/service/adminLogService";

const COLL = "zaapi_kb_mappings";
const CONTENT_TYPES = new Set(["product", "troubleshooting", "faq", "warranty"]);
const MANIFEST = path.join(process.cwd(), "data", "zaapi-kb-files-manifest.json");

async function loadManifest() {
  const raw = await readFile(MANIFEST, "utf8");
  return JSON.parse(raw) as { files: { file: string; name?: string; rows: number; sheets: Record<string, number>; shop_guess?: string; type_guess?: string }[] };
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const [manifest, saved, shopDocs] = await Promise.all([
    loadManifest(),
    getCollection<{ _id: string }>(COLL).then((c) => c.find({}).toArray()),
    getCollection<{ shopname?: string; platform?: string }>("shops")
      .then((c) => c.find({}, { projection: { shopname: 1, platform: 1 } }).toArray()),
  ]);
  const map: Record<string, unknown> = {};
  for (const s of saved) map[s._id] = s;
  const seen = new Set<string>();
  const shops = (shopDocs || [])
    .filter((s) => s.shopname && !seen.has(`${s.platform}|${s.shopname}`) && seen.add(`${s.platform}|${s.shopname}`))
    .map((s) => ({ name: s.shopname, platform: String(s.platform || "").toLowerCase() }))
    .sort((a, b) => a.platform.localeCompare(b.platform) || String(a.name).localeCompare(String(b.name)));
  return json({
    files: manifest.files,
    mapping: map,
    shops,
    types: [...CONTENT_TYPES],
  });
}

export async function POST(req: NextRequest) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null) as {
    file?: string; accounts?: string[]; platforms?: string[];
    content_type?: string; sheet_types?: Record<string, string>;
  } | null;
  if (!body?.file || typeof body.file !== "string") return error("file required", 422);
  const ct = String(body.content_type || "").trim();
  if (!CONTENT_TYPES.has(ct)) return error("content_type must be product|troubleshooting|faq|warranty", 422);
  const st = body.sheet_types || {};
  for (const [k, v] of Object.entries(st)) {
    if (!CONTENT_TYPES.has(String(v))) return error(`bad sheet_type for ${k}`, 422);
  }
  const accounts = Array.isArray(body.accounts) ? body.accounts.map(String).filter(Boolean) : [];
  const platforms = Array.isArray(body.platforms)
    ? body.platforms.map((p) => String(p).toLowerCase()).filter(Boolean) : ["shopee"];
  const actor = r.ctx.admin.admin_id;
  const doc = {
    accounts, platforms, content_type: ct,
    sheet_types: st,
    mapped_by: actor, mapped_at: new Date(),
  };
  const coll = await getCollection(COLL);
  await coll.updateOne({ _id: body.file } as never, { $set: doc }, { upsert: true });
  await logAdminEvent({
    action_type: "zaapi_kb.mapping_set", actor,
    metadata: { file: body.file, accounts, platforms, content_type: ct },
    ip: r.ctx.ip,
  });
  return json({ ok: true, file: body.file, ...doc });
}
