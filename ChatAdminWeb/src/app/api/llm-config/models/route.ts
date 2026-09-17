// GET /api/llm-config/models — list model สดจาก provider APIs (dev only)
// cache ฝั่ง service 10 นาที — fallback list ถ้า provider ล่ม
import { NextRequest, NextResponse } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { getAvailableModels } from "@/backend/service/llmConfigService";

export async function GET(req: NextRequest) {
  const r = await requirePageEdit(req, "llm"); // dev only
  if (!r.ok) return r.response;
  const data = await getAvailableModels();
  return NextResponse.json({ ok: true, ...data });
}
