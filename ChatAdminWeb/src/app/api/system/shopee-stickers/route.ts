import { NextRequest } from "next/server";
import { requireAuth, roleCanAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";

export const dynamic = "force-dynamic";

const BASE = "https://deo.shopeemobile.com/shopee/shopee-sticker-live-th";
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const EXT = /^(png|webp|gif|jpe?g)$/i;

type Pack = { pid: string; name: string };
type Sticker = { sid: string; url: string };

async function _catalogJson(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}/${path}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("catalog_unavailable");
  const raw = await response.text();
  if (raw.length > 2_000_000) throw new Error("catalog_too_large");
  return JSON.parse(raw) as unknown;
}

function _packs(value: unknown): Pack[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { packs?: unknown }).packs)) return [];
  const rows = (value as { packs: unknown[] }).packs;
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const pid = String(item.pid ?? "");
    const regions = item.reg;
    if (!ID.test(pid) || !Array.isArray(regions) || !regions.some((r) => String(r).toUpperCase() === "TH")) return [];
    return [{ pid, name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : pid }];
  });
}

function _stickers(value: unknown, pid: string): Sticker[] {
  const found = new Map<string, Sticker>();
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    const row = node as Record<string, unknown>;
    const sid = String(row.sid ?? row.sticker_id ?? "");
    const ext = String(row.ext ?? row.extension ?? "").toLowerCase();
    if (ID.test(sid) && EXT.test(ext) && !found.has(sid)) {
      found.set(sid, { sid, url: `${BASE}/packs/${pid}/${sid}@1x.${ext}` });
    }
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...found.values()].slice(0, 300);
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const role = auth.ctx.admin.role;
  if (!(await roleCanAccess(role, "ticket")) && !(await roleCanAccess(role, "botworker"))) {
    return error("forbidden", 403);
  }
  try {
    const packs = _packs(await _catalogJson("manifest.json"));
    const pid = req.nextUrl.searchParams.get("pack_id");
    if (!pid) return json({ packs });
    if (!ID.test(pid) || !packs.some((pack) => pack.pid === pid)) return error("unknown sticker pack", 422);
    const stickers = _stickers(await _catalogJson(`packs/${pid}/${pid}.json`), pid);
    return json({ stickers });
  } catch {
    return error("โหลดรายการสติกเกอร์ไม่ได้ กรุณาลองใหม่ภายหลัง", 503);
  }
}
