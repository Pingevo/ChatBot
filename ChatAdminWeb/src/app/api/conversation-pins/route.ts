import { NextRequest } from "next/server";
import { requirePageAccess, requirePageEdit, roleCanEdit } from "@/backend/middleware/authorize";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { statusConversationService } from "@/backend/service/statusConversationService";
import { json, error, readJson } from "@/backend/lib/http";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
import { invalidateBotworkerCache } from "@/backend/service/botworkerConversationCache";

export const dynamic = "force-dynamic";

type Scope = "tickets" | "botworker";

export async function GET(req: NextRequest) {
  const scope = new URL(req.url).searchParams.get("scope") as Scope;
  if (scope !== "tickets" && scope !== "botworker") return error("invalid scope", 422);
  const auth = await requirePageAccess(req, scope === "tickets" ? "ticket" : "botworker");
  if (!auth.ok) return auth.response;
  const me = auth.ctx.admin.admin_id;
  const channels = auth.ctx.admin.role === "superadmin" || auth.ctx.admin.role === "dev" || !auth.ctx.admin.channels_access?.length
    ? null : auth.ctx.admin.channels_access;
  const statuses = await getCollection(COLLECTIONS.statusConversation);
  const rows = await statuses.aggregate<{ conversation_id: string; pin_global: boolean; pin_personal: boolean }>([
    { $match: { $or: [{ pinned: true }, { pinned_by_admin_ids: me }] } },
    { $lookup: { from: COLLECTIONS.conversations, localField: "conversation_id", foreignField: "conversation_id", as: "conversation" } },
    { $unwind: "$conversation" },
    ...(channels ? [{ $match: { "conversation.platform": { $in: channels } } }] : []),
    { $project: { conversation_id: 1, pin_global: { $eq: ["$pinned", true] },
      pin_personal: { $in: [me, { $ifNull: ["$pinned_by_admin_ids", []] }] } } },
  ]).toArray();
  const can_pin = await roleCanEdit(auth.ctx.admin.role, scope === "tickets" ? "ticket" : "botworker");
  return json({ rows, can_pin });
}

export async function PATCH(req: NextRequest) {
  const body = await readJson<{ scope?: Scope; conversation_id?: string; visibility?: "private" | "everyone"; pinned?: boolean }>(req);
  if (!body || (body.scope !== "tickets" && body.scope !== "botworker") ||
      typeof body.conversation_id !== "string" || !body.conversation_id ||
      (body.visibility !== "private" && body.visibility !== "everyone") || typeof body.pinned !== "boolean") {
    return error("invalid pin request", 422);
  }
  const auth = await requirePageEdit(req, body.scope === "tickets" ? "ticket" : "botworker");
  if (!auth.ok) return auth.response;
  const conversations = await getCollection<{ conversation_id: string; platform: string }>(COLLECTIONS.conversations);
  const conversation = await conversations.findOne({ conversation_id: body.conversation_id }, { projection: { platform: 1 } });
  if (!conversation) return error("conversation not found", 404);
  const admin = auth.ctx.admin;
  const channels = admin.channels_access || [];
  if (admin.role !== "superadmin" && admin.role !== "dev" && channels.length && !channels.includes(conversation.platform)) {
    return error("forbidden conversation channel", 403);
  }
  await statusConversationService.setConversationPin(body.conversation_id, admin.admin_id, body.visibility, body.pinned);
  invalidateConversationsCache();
  invalidateBotworkerCache();
  return json({ ok: true });
}
