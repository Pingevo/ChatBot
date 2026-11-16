// /api/zaapi-kb/bind — subject-binding editor proxy → FastAPI
//   GET  ?file=<name>          → /zaapi-kb/bind-preview (columns+samples, 0 writes)
//   POST ?file=<name> {subject_bindings} → /zaapi-kb/bind (apply rev ใหม่)
import { NextRequest } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";

async function upstream() {
  return serverConfig.chatbotBaseUrls.shopee.replace(/\/$/, "");
}

export async function GET(req: NextRequest) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;
  const url = new URL(req.url);
  const file = url.searchParams.get("file") || "";
  if (!file) return json({ detail: "file required" }, 400);
  const res = await fetch(
    `${await upstream()}/zaapi-kb/bind-preview?file=${encodeURIComponent(file)}`,
    { headers: { "X-Internal-Secret": serverConfig.chatbotInternalSecret } });
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
}

export async function POST(req: NextRequest) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;
  const url = new URL(req.url);
  const file = url.searchParams.get("file") || "";
  const body = await req.json().catch(() => null);
  if (!file || !body || typeof body.subject_bindings !== "object"
      || body.subject_bindings === null)
    return json({ detail: "file + subject_bindings object required" }, 400);
  const params = new URLSearchParams({
    file,
    subject_bindings: JSON.stringify(body.subject_bindings),
  });
  const headers = new Headers();
  headers.set("X-Internal-Secret", serverConfig.chatbotInternalSecret);
  headers.set("X-Admin-Id", r.ctx.admin.admin_id);
  headers.set("X-Admin-Name", encodeURIComponent(r.ctx.admin.name || ""));
  const res = await fetch(`${await upstream()}/zaapi-kb/bind?${params}`,
    { method: "POST", headers });
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
}
