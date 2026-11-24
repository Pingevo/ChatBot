// GET /api/zaapi-kb/export?file=<name> — export active revision → file bytes (xlsx/txt ตามชนิดต้นทาง)
//   passthrough → FastAPI /zaapi-kb/export (stream binary ตรง — ไม่ผ่าน
//   req.text() proxy)
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { serverConfig } from "@/backend/lib/config";
import { getChatEngine } from "@/backend/service/systemConfigService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  if (await getChatEngine() === "v4") return NextResponse.json({ error: "python_engine_required" }, { status: 409 });

  const upstream = serverConfig.chatbotBaseUrls.shopee.replace(/\/$/, "");
  const url = new URL(req.url);
  const pkg = url.searchParams.get("package") === "true";
  url.searchParams.delete("package");
  const res = await fetch(`${upstream}/zaapi-kb/export${pkg ? "-package" : ""}${url.search}`, {
    headers: { "X-Internal-Secret": serverConfig.chatbotInternalSecret },
  });
  return new NextResponse(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition": res.headers.get("Content-Disposition") || "",
    },
  });
}
