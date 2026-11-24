// GET /api/test-chat/logs — Test Chat action history.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { testChatSessionService } from "@/backend/service/testChatSessionService";
import { testChatSessionErrorResponse } from "../session-response";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit == null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit)) return error("limit must be an integer", 422);
  try {
    return json(await testChatSessionService.listLogs({
      adminId: auth.ctx.admin.admin_id,
      requestedAdminId: url.searchParams.get("admin_id") || undefined,
      action: url.searchParams.get("action") || undefined,
      limit,
    }));
  } catch (cause) {
    return testChatSessionErrorResponse(cause);
  }
}
