// GET /api/zaapi-kb/import-log — audit log ของ apply/rollback/sweep
//   ?file=<filename> (optional), ?limit=<n> → proxy FastAPI /zaapi-kb/import-log
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const upstream = serverConfig.chatbotBaseUrls.shopee.replace(/\/$/, "");
  const qs = new URL(req.url).searchParams;
  const params = new URLSearchParams();
  if (qs.get("file")) params.set("file", qs.get("file")!);
  if (qs.get("limit")) params.set("limit", qs.get("limit")!);
  const res = await fetch(`${upstream}/zaapi-kb/import-log?${params}`, {
    headers: { "X-Internal-Secret": serverConfig.chatbotInternalSecret },
  });
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
}
