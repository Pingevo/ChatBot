// GET /api/assignment/backlog?source=ticket|botworker — list งานค้าง pending_assignment
// superadmin/dev only
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireSuperadmin } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { listPending, type BacklogSource } from "@/backend/service/backlogService";

export async function GET(req: NextRequest) {
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const source = (req.nextUrl.searchParams.get("source") || "ticket") as BacklogSource;
  if (source !== "ticket" && source !== "botworker") return error("source must be ticket|botworker", 422);

  const items = await listPending(source, 200);
  return json({ ok: true, source, total: items.length, items });
}
