// POST /api/zaapi-kb/import?op=preview|apply|rollback — Zaapi file-based KB
//   binary-safe passthrough → FastAPI /zaapi-kb/import/* (proxy เดิมใช้
//   req.text() — ทำ xlsx bytes เสีย จึงแยก route ที่ส่ง ArrayBuffer ตรง)
//   body: multipart/form-data (file + filename + accounts + platforms)
//   op=rollback ใช้ ?file=<name> ไม่ต้องมี body
import { NextRequest } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";

export async function POST(req: NextRequest) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "preview";
  if (!["preview", "apply", "rollback", "sweep"].includes(op))
    return error("invalid op", 400);

  const upstream = serverConfig.chatbotBaseUrls.shopee.replace(/\/$/, "");
  const headers = new Headers();
  headers.set("X-Internal-Secret", serverConfig.chatbotInternalSecret);
  headers.set("X-Admin-Id", r.ctx.admin.admin_id);
  headers.set("X-Admin-Name", encodeURIComponent(r.ctx.admin.name || ""));

  let target = "";
  let body: BodyInit | undefined;
  if (op === "rollback") {
    target = `${upstream}/zaapi-kb/import/rollback${url.search}`;
  } else if (op === "sweep") {
    target = `${upstream}/zaapi-kb/import/sweep`;
  } else {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof Blob)) return error("file required", 400);
    const name = String(form.get("filename") || (file as File).name || "");
    const params = new URLSearchParams({
      filename: name,
      accounts: String(form.get("accounts") || ""),
      platforms: String(form.get("platforms") || ""),
      content_type: String(form.get("content_type") || ""),
      sheet_types: String(form.get("sheet_types") || ""),
    });
    target = `${upstream}/zaapi-kb/import/${op}?${params}`;
    body = await file.arrayBuffer();
    headers.set("Content-Type", "application/octet-stream");
  }

  const res = await fetch(target, { method: "POST", headers, body });
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
}
