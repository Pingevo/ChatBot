// GET /api/zaapi-kb/files — registry files + readiness (file-based Zaapi KB)
//   passthrough → FastAPI /zaapi-kb/files (JSON เท่านั้น — ไม่มี binary)
import { NextRequest } from "next/server";
import { requireAuth, requirePageEdit } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const upstream = serverConfig.chatbotBaseUrls.shopee.replace(/\/$/, "");
  const res = await fetch(`${upstream}/zaapi-kb/files`, {
    headers: { "X-Internal-Secret": serverConfig.chatbotInternalSecret },
  });
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
}

// POST /api/zaapi-kb/files?file=<name>&enabled=<bool> — toggle visibility
//   passthrough → FastAPI /zaapi-kb/files/toggle (swap active_*↔disabled_*)
export async function POST(req: NextRequest) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;
  const url = new URL(req.url);
  const upstream = serverConfig.chatbotBaseUrls.shopee.replace(/\/$/, "");
  const res = await fetch(`${upstream}/zaapi-kb/files/toggle${url.search}`, {
    method: "POST",
    headers: {
      "X-Internal-Secret": serverConfig.chatbotInternalSecret,
      "X-Admin-Id": r.ctx.admin.admin_id,
      "X-Admin-Name": encodeURIComponent(r.ctx.admin.name || ""),
    },
  });
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
}
