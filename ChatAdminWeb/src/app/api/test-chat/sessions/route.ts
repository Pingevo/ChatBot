// GET /api/test-chat/sessions — list sessions; POST — create a session.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { testChatSessionService } from "@/backend/service/testChatSessionService";
import { testChatSessionErrorResponse } from "../session-response";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit == null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit)) return error("limit must be an integer", 422);
  try {
    return json(await testChatSessionService.list({
      adminId: auth.ctx.admin.admin_id,
      shop: url.searchParams.get("shop") || undefined,
      limit,
    }));
  } catch (cause) {
    return testChatSessionErrorResponse(cause);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const body = await readJson<{ shop?: string; title?: string | null }>(req);
  if (!body) return error("invalid body", 422);
  if (body.shop != null && typeof body.shop !== "string") return error("shop must be a string", 422);
  if (body.title != null && typeof body.title !== "string") return error("title must be a string", 422);
  try {
    return json(await testChatSessionService.create(body, {
      adminId: auth.ctx.admin.admin_id,
      adminName: auth.ctx.admin.name || "",
    }), 201);
  } catch (cause) {
    return testChatSessionErrorResponse(cause);
  }
}
