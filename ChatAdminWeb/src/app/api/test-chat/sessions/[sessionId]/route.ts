// GET, PUT, DELETE /api/test-chat/sessions/:sessionId.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { testChatSessionService } from "@/backend/service/testChatSessionService";
import { testChatSessionErrorResponse } from "../../session-response";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  try {
    const { sessionId } = await context.params;
    return json(await testChatSessionService.get(sessionId));
  } catch (cause) {
    return testChatSessionErrorResponse(cause);
  }
}

export async function PUT(req: NextRequest, context: RouteContext) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const body = await readJson<{ shop?: string; title?: string }>(req);
  if (!body) return error("invalid body", 422);
  if (body.shop != null && typeof body.shop !== "string") return error("shop must be a string", 422);
  if (body.title != null && typeof body.title !== "string") return error("title must be a string", 422);
  try {
    const { sessionId } = await context.params;
    return json(await testChatSessionService.update(sessionId, body, {
      adminId: auth.ctx.admin.admin_id,
      adminName: auth.ctx.admin.name || "",
    }));
  } catch (cause) {
    return testChatSessionErrorResponse(cause);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  try {
    const { sessionId } = await context.params;
    return json(await testChatSessionService.remove(sessionId, {
      adminId: auth.ctx.admin.admin_id,
      adminName: auth.ctx.admin.name || "",
    }));
  } catch (cause) {
    return testChatSessionErrorResponse(cause);
  }
}
