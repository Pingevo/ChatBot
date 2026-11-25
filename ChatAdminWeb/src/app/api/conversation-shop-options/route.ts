import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { json, error } from "@/backend/lib/http";

export const dynamic = "force-dynamic";

type ConversationShop = {
  _id: { platform: string; shop_id: string | number };
  names: (string | null)[];
};

type DirectoryShop = {
  platform: string;
  shop_id: string | number;
  shopname?: string;
};

export async function GET(req: NextRequest) {
  const scope = new URL(req.url).searchParams.get("scope");
  if (scope !== "tickets" && scope !== "botworker") return error("invalid scope", 422);
  const auth = await requirePageAccess(req, scope === "tickets" ? "ticket" : "botworker");
  if (!auth.ok) return auth.response;
  const admin = auth.ctx.admin;
  const channels = admin.role === "superadmin" || admin.role === "dev" || !admin.channels_access?.length
    ? null : admin.channels_access;
  const conversations = await getCollection(COLLECTIONS.conversations);
  const shops = await conversations.aggregate<ConversationShop>([
    { $match: { shop_id: { $exists: true, $nin: [null, ""] },
      ...(channels ? { platform: { $in: channels } } : {}) } },
    { $group: { _id: { platform: "$platform", shop_id: "$shop_id" }, names: { $addToSet: "$shop_name" } } },
    { $sort: { "_id.platform": 1, "_id.shop_id": 1 } },
  ]).toArray();

  const platforms = [...new Set(shops.map((shop) => shop._id.platform))];
  const shopDirectory = await getCollection<DirectoryShop>(COLLECTIONS.shops);
  const registered = platforms.length ? await shopDirectory.find({ platform: { $in: platforms } },
    { projection: { platform: 1, shop_id: 1, shopname: 1 } }).toArray() : [];
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const shop of registered) {
    const name = typeof shop.shopname === "string" ? shop.shopname.trim() : "";
    if (!name) continue;
    const platform = String(shop.platform || "");
    const id = String(shop.shop_id ?? "").trim();
    if (id && name !== id) byId.set(`${platform}|${id}`, name);
    byName.set(`${platform}|${name.toLocaleLowerCase("th")}`, name);
  }

  return json({ rows: shops.map((shop) => {
    const platform = shop._id.platform;
    const id = String(shop._id.shop_id).trim();
    const conversationNames = (shop.names || [])
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.trim())
      .filter(Boolean);
    const registeredName = byId.get(`${platform}|${id}`)
      || conversationNames.map((name) => byName.get(`${platform}|${name.toLocaleLowerCase("th")}`)).find(Boolean);
    const conversationName = conversationNames.find((name) => name !== id);
    return {
      platform,
      shop_id: id,
      shopname: registeredName || conversationName || "ไม่ทราบชื่อร้าน",
    };
  }) });
}
