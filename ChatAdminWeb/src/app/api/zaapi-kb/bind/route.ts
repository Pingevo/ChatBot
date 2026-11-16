// /api/zaapi-kb/bind — subject-binding editor proxy → FastAPI
//   GET  ?file=<name>[&rows=N] → /zaapi-kb/bind-preview (columns+samples; rows>0 +grid/text, 0 writes)
//   POST ?file=<name> {subject_bindings} → /zaapi-kb/bind (apply rev ใหม่)
//   POST ?file=<name> {patches|text}     → /zaapi-kb/edit-source (แก้ cell/text → rev ใหม่)
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
  const rows = url.searchParams.get("rows") || "";
  const res = await fetch(
    `${await upstream()}/zaapi-kb/bind-preview?file=${encodeURIComponent(file)}${rows ? `&rows=${encodeURIComponent(rows)}` : ""}`,
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
  if (!file || !body || typeof body !== "object")
    return json({ detail: "file + JSON body required" }, 400);
  const headers = new Headers();
  headers.set("X-Internal-Secret", serverConfig.chatbotInternalSecret);
  headers.set("X-Admin-Id", r.ctx.admin.admin_id);
  headers.set("X-Admin-Name", encodeURIComponent(r.ctx.admin.name || ""));
  // edit-source path: patches (xlsx cell patch) หรือ text (.txt)
  if (body.patches !== undefined || body.text !== undefined) {
    headers.set("Content-Type", "application/json");
    const res = await fetch(
      `${await upstream()}/zaapi-kb/edit-source?file=${encodeURIComponent(file)}`,
      { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return json(data, res.status);
  }
  if (typeof body.subject_bindings !== "object" || body.subject_bindings === null)
    return json({ detail: "subject_bindings object required" }, 400);
  const params = new URLSearchParams({
    file,
    subject_bindings: JSON.stringify(body.subject_bindings),
  });
  const res = await fetch(`${await upstream()}/zaapi-kb/bind?${params}`,
    { method: "POST", headers });
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
}
