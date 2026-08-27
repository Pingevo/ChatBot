// Sync shops — ดึงร้านค้าทั้งหมดจาก 3 product collections ของ dbWallet
//   shopee  → ShpProducts
//   tiktok  → TikProducts
//   lazada  → OpenLazadaProducts
// และเสริมด้วยข้อมูลจาก conversations_shp (conversation_count)
// แล้ว upsert ลง shops collection ใน chatbot db
//
// รัน: npx tsx scripts/sync-shops.ts
//
// ⚠️ SAFETY:
//   - อ่าน dbWallet (READ-ONLY) และ conversations_shp (READ-ONLY)
//   - เขียนเฉพาะ shops collection ใน chatbot db ของเรา
//   - ไม่ call Shopee/TikTok/Lazada API
//   - ไม่ยุ่งกับ sellcenter
import "dotenv/config";
import { MongoClient } from "mongodb";

const CHATBOT_URI = process.env.ADMIN_MONGO_URI!;
const DBWALLET_URI = process.env.MONGO_URI!;
const CHATBOT_DB = process.env.ADMIN_MONGO_DB || "chatbot";
const DBWALLET_DB = process.env.MONGO_DB || "dbWallet";

const PRODUCT_COLLECTIONS: Record<string, string> = {
  shopee: process.env.SHP_PRODUCTS_COLLECTION || "ShpProducts",
  tiktok: process.env.TIKTOK_PRODUCTS_COLLECTION || "TikProducts",
  lazada: process.env.LAZADA_PRODUCTS_COLLECTION || "OpenLazadaProducts",
};

interface ShopRow {
  shopname: string;
  platform: string;
  product_count: number;
}

async function readShopsFromProducts(db: import("mongodb").Db): Promise<ShopRow[]> {
  const all: ShopRow[] = [];
  for (const [platform, collName] of Object.entries(PRODUCT_COLLECTIONS)) {
    try {
      console.log(`[sync-shops] reading ${platform} from ${collName}...`);
      const agg = await db.collection(collName).aggregate([
        { $group: { _id: "$shopname", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray();
      for (const r of agg) {
        if (r._id) {
          all.push({ shopname: String(r._id), platform, product_count: r.count });
        }
      }
      console.log(`[sync-shops]   ${platform}: ${agg.filter(r => r._id).length} shops, ${agg.reduce((s,r) => s + (r.count||0), 0)} products`);
    } catch (err) {
      console.warn(`[sync-shops]   ${platform}: cannot read — ${err instanceof Error ? err.message : err}`);
    }
  }
  return all;
}

async function main() {
  console.log("[sync-shops] starting...");
  const chatbotClient = new MongoClient(CHATBOT_URI, { serverSelectionTimeoutMS: 8000 });
  const dbwalletClient = new MongoClient(DBWALLET_URI, { serverSelectionTimeoutMS: 8000 });

  try {
    await chatbotClient.connect();
    await dbwalletClient.connect();
    const chatbotDb = chatbotClient.db(CHATBOT_DB);
    const dbwalletDb = dbwalletClient.db(DBWALLET_DB);

    // 1. ดึงร้านจาก product collections (ทุกร้าน ไม่จำกัดแค่ที่มี conversation)
    const productShops = await readShopsFromProducts(dbwalletDb);
    console.log(`[sync-shops] total shops from products: ${productShops.length}`);

    // 2. ดึง conversation_count จาก conversations_shp (เสริม)
    console.log("[sync-shops] reading conversation counts from conversations_shp...");
    const convCounts = new Map<string, number>();
    try {
      const convAgg = await chatbotDb.collection("conversations_shp").aggregate([
        { $group: { _id: { shop_id: "$shop_id", shop_name: "$shop_name" }, count: { $sum: 1 } } },
      ]).toArray();
      for (const r of convAgg) {
        const shopname = String(r._id?.shop_name || "");
        if (shopname) convCounts.set(shopname, r.count);
      }
      console.log(`[sync-shops]   conversation counts for ${convCounts.size} shops`);
    } catch (err) {
      console.warn("[sync-shops]   cannot read conversations_shp:", err instanceof Error ? err.message : err);
    }

    // 3. Upsert ลง shops collection
    // ⚠️ ใช้ shopname + platform เป็น key หลัก (product collections มีแค่ shopname ไม่มี shop_id)
    //    ถ้ามี row เดิมที่มี shop_id จริง (จาก conversations_shp) ให้ update แทน insert ใหม่
    //    ถ้าไม่มี row เดิม ใช้ shopname เป็น shop_id (fallback)
    console.log("[sync-shops] upserting into shops collection...");
    const shopsColl = chatbotDb.collection("shops");
    let inserted = 0;
    let updated = 0;
    const now = new Date();

    // ดึง shop_id จริงจาก conversations_shp (map โดย platform + shopname — กันข้าม platform)
    const convShopIds = new Map<string, string>();
    try {
      const convRows = await chatbotDb.collection("conversations_shp").aggregate([
        { $group: { _id: { platform: "$platform", shop_name: "$shop_name", shop_id: "$shop_id" } } },
        { $match: { "_id.shop_name": { $ne: null }, "_id.shop_id": { $ne: null } } },
      ]).toArray();
      for (const r of convRows) {
        if (r._id?.platform && r._id?.shop_name && r._id?.shop_id) {
          // key = platform|shopname — กัน shopee shop_id หลุดไป tiktok/lazada
          convShopIds.set(`${r._id.platform}|${r._id.shop_name}`, String(r._id.shop_id));
        }
      }
      console.log(`[sync-shops]   shop_id map from conversations_shp: ${convShopIds.size} entries`);
    } catch (err) {
      console.warn("[sync-shops]   cannot read shop_id map:", err instanceof Error ? err.message : err);
    }

    for (const s of productShops) {
      const convCount = convCounts.get(s.shopname) || 0;
      // ใช้ shop_id จริงจาก conversations_shp (match platform + shopname) — ไม่งั้น fallback เป็น shopname
      const realShopId = convShopIds.get(`${s.platform}|${s.shopname}`) || s.shopname;

      // upsert โดย match ที่ shopname + platform (กันซ้ำ)
      // ถ้ามี row เดิมที่มี shop_id จริง จะ update product_count/conversation_count
      // ถ้าไม่มี จะ insert ใหม่ด้วย shop_id จริง (หรือ shopname ถ้าไม่มี)
      const result = await shopsColl.updateOne(
        { shopname: s.shopname, platform: s.platform },
        {
          $set: {
            shop_id: realShopId,
            shopname: s.shopname,
            platform: s.platform,
            product_count: s.product_count,
            conversation_count: convCount,
            updated_at: now,
          },
          $setOnInsert: {
            created_at: now,
            connected: true,
            enabled_for_chat: true,
            disabled_by_user: false,
            status: "active",
            last_sync_at: null,
            last_polled_at: null,
          },
        },
        { upsert: true }
      );
      if (result.upsertedCount > 0) inserted++;
      else if (result.modifiedCount > 0) updated++;
    }

    console.log(`[sync-shops] done. inserted=${inserted} updated=${updated} total=${productShops.length}`);

    // 4. แสดงผล
    const finalShops = await shopsColl.find({}).sort({ product_count: -1 }).limit(15).toArray();
    console.log("\n[sync-shops] sample shops:");
    for (const s of finalShops) {
      console.log(`  ${s.platform} | ${s.shopname} | products=${s.product_count} conv=${s.conversation_count}`);
    }
  } catch (err) {
    console.error("[sync-shops] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await chatbotClient.close();
    await dbwalletClient.close();
  }
}

main();
