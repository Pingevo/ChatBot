// GET /api/system/chat-engine — expose only the selected engine and tool capability.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getChatEngine } from "@/backend/service/systemConfigService";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const chat_engine = await getChatEngine();
  return json({ chat_engine, python_tools_available: chat_engine !== "v4" });
}
