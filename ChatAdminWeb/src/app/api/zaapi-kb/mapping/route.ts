// GET /api/zaapi-kb/mapping — file manifest + saved mapping + shop list
//   (shops มี shop_id สำหรับสร้าง shop_scopes ตอน import — scope-first contract)
import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection } from "@/backend/db/mongoClient";

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
    getCollection<{ shopname?: string; platform?: string; shop_id?: string | number }>("shops")
      .then((c) => c.find({}, { projection: { shopname: 1, platform: 1, shop_id: 1 } }).toArray()),
  ]);
  const map: Record<string, unknown> = {};
  for (const s of saved) map[s._id] = s;
  const seen = new Set<string>();
  const shops = (shopDocs || [])
    .filter((s) => s.shopname && s.shop_id != null && String(s.shop_id).trim()
      && !seen.has(`${s.platform}|${s.shop_id}`) && seen.add(`${s.platform}|${s.shop_id}`))
    .map((s) => ({
      name: s.shopname,
      platform: String(s.platform || "").toLowerCase(),
      shop_id: String(s.shop_id),
    }))
    .sort((a, b) => a.platform.localeCompare(b.platform) || String(a.name).localeCompare(String(b.name)));
  return json({
    files: manifest.files,
    mapping: map,
    shops,
    types: [...CONTENT_TYPES],
  });
}
