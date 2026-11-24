// POST /api/test-chat/sessions/:sessionId/reopen — reopen the simulated ticket.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { testChatSessionService } from "@/backend/service/testChatSessionService";
import { testChatSessionErrorResponse } from "../../../session-response";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  try {
    const { sessionId } = await context.params;
    return json(await testChatSessionService.reopen(sessionId, {
      adminId: auth.ctx.admin.admin_id,
      adminName: auth.ctx.admin.name || "",
    }));
  } catch (cause) {
    return testChatSessionErrorResponse(cause);
  }
}
