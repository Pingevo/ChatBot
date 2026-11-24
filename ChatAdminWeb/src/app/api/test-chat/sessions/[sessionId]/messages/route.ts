// POST /api/test-chat/sessions/:sessionId/messages — append one message.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { testChatSessionService } from "@/backend/service/testChatSessionService";
import { testChatSessionErrorResponse } from "../../../session-response";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const body = await readJson<{ message?: {
    role?: string; text?: string; timestamp?: string;
    stats?: Record<string, unknown>; images?: string[];
  } }>(req);
  if (!body?.message || typeof body.message.role !== "string" || typeof body.message.text !== "string") {
    return error("message.role and message.text are required", 422);
  }
  if (body.message.images != null && (!Array.isArray(body.message.images) || body.message.images.some((image) => typeof image !== "string"))) {
    return error("message.images must be a string array", 422);
  }
  try {
    const { sessionId } = await context.params;
    return json(await testChatSessionService.addMessage(sessionId, body.message as {
      role: string; text: string; timestamp?: string; stats?: Record<string, unknown>; images?: string[];
    }, {
      adminId: auth.ctx.admin.admin_id,
      adminName: auth.ctx.admin.name || "",
    }));
  } catch (cause) {
    return testChatSessionErrorResponse(cause);
  }
}
