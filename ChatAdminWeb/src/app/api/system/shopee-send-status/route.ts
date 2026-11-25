import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { isShopeeConsoleSendEnabled } from "@/backend/service/shopeeOutboundService";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return json({ enabled: await isShopeeConsoleSendEnabled() });
}
