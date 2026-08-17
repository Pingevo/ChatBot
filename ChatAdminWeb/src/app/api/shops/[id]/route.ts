// PATCH /api/shops/[id] — update shop (toggle connected)
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { shopService } from "@/backend/service/shopService";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await readJson<{ connected?: boolean }>(req).catch(() => null);
  if (!body || typeof body.connected !== "boolean") {
    return error("connected (boolean) is required", 400);
  }
  const ok = await shopService.setShopConnected(id, body.connected);
  if (!ok) return error("shop not found", 404);
  return json({ ok: true });
}
