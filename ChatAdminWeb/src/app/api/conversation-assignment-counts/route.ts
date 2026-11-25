import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { json, error } from "@/backend/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const scope = new URL(req.url).searchParams.get("scope");
  if (scope !== "tickets" && scope !== "botworker") return error("invalid scope", 422);
  const auth = await requirePageAccess(req, scope === "tickets" ? "ticket" : "botworker");
  if (!auth.ok) return auth.response;

  const admin = auth.ctx.admin;
  const channels = admin.role === "superadmin" || admin.role === "dev" || !admin.channels_access?.length
    ? null : admin.channels_access;
  const conversations = await getCollection(COLLECTIONS.conversations);
  const visible = channels ? { platform: { $in: channels } } : {};
  const total = await conversations.countDocuments(visible);
  const metadata = await getCollection(scope === "tickets"
    ? COLLECTIONS.statusConversation : COLLECTIONS.testStatusConversation);
  const rows = await metadata.aggregate<{ _id: string | null; count: number }>([
    { $match: {
      ...(scope === "botworker" ? { source: "botworker" } : {}),
      status: { $in: ["handoff", "open", "pending"] },
    } },
    { $lookup: { from: COLLECTIONS.conversations, localField: "conversation_id", foreignField: "conversation_id", as: "conversation" } },
    { $unwind: "$conversation" },
    ...(channels ? [{ $match: { "conversation.platform": { $in: channels } } }] : []),
    { $group: { _id: "$assigned_to", count: { $sum: 1 } } },
  ]).toArray();
  const by_admin: Record<string, number> = {};
  let pending = 0;
  for (const row of rows) {
    if (row._id) by_admin[row._id] = row.count;
    else pending += row.count;
  }
  return json({ total, pending, by_admin });
}
