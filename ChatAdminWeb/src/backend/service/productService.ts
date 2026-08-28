// Product service — ดึงสินค้าจาก dbWallet (read-only)
// collection ตาม platform:
//   shopee  → ShpProducts      (SHP_PRODUCTS_COLLECTION)
//   tiktok  → TiksProduct      (TIKTOK_PRODUCTS_COLLECTION)
//   lazada  → OpenLazadaProducts (LAZADA_PRODUCTS_COLLECTION)
//
// ⚠️ READ-ONLY เสมอ — ใช้สำหรับแสดงในแชทเท่านั้น ห้ามเขียน
import type { Document } from "mongodb";
import { getDbWalletCollection } from "../db/dbWalletClient";
import type { Platform } from "./conversationService";

export interface ProductDoc extends Document {
  itemid?: string;
  item_id?: string;
  shopid?: string;
  shop_id?: string;
  name?: string;
  product_name?: string;
  price?: number;
  stock?: number;
  images?: string[];
  image_url?: string;
  url?: string;
  product_link?: string;
  status?: string;
}

const COLLECTION_MAP: Record<Platform, string> = {
  shopee: process.env.SHP_PRODUCTS_COLLECTION || "ShpProducts",
  tiktok: process.env.TIKTOK_PRODUCTS_COLLECTION || "TiksProduct",
  lazada: process.env.LAZADA_PRODUCTS_COLLECTION || "OpenLazadaProducts",
};

/**
 * แปลง item_id (string) → array ของค่าที่เป็นไปได้ทั้ง string และ number
 *
 * item_id ใน ShpProducts อาจเก็บเป็น number (int/long/double) ไม่ใช่ string
 * MongoDB เปรียบเทียบแบบ type-strict → query ด้วย string "46051234150"
 * จะไม่ match number 46051234150 ใน DB
 * ต้อง query ด้วยทั้ง string และ number (เหมือนฝั่ง Python ที่ลอง int + float)
 */
function itemIdVariants(itemId: string): (string | number)[] {
  const variants: (string | number)[] = [itemId];
  const n = Number(itemId);
  if (!Number.isNaN(n) && Number.isFinite(n)) {
    variants.push(n);
  }
  return variants;
}

/**
 * ดึงสินค้าของร้าน — กรองตาม shop_id, shop_name หรือ shopname และ platform
 * รองรับ search (ค้นหาจาก name)
 * ⚠️ Product collections ใช้ `shopname` (string) ไม่ใช่ shop_id (number)
 *    ดังนั้นต้องกรองด้วย shop_name ถ้ามี
 */
export async function listProducts(opts: {
  platform: Platform;
  shopId?: string;
  shopName?: string;
  search?: string;
  limit?: number;
  skip?: number;
}): Promise<{ products: ProductDoc[]; total: number }> {
  const coll = await getDbWalletCollection<ProductDoc>(COLLECTION_MAP[opts.platform]);

  const filter: Record<string, unknown> = {};
  const andClauses: Record<string, unknown>[] = [];
  if (opts.shopName) {
    // กรองด้วย shopname (string) — ใช้กับทุก platform
    andClauses.push({
      $or: [
        { shopname: opts.shopName },
        { shop_name: opts.shopName },
      ],
    });
  } else if (opts.shopId) {
    // fallback: ลอง shopid และ shop_id (schema อาจต่างกัน)
    andClauses.push({
      $or: [{ shopid: opts.shopId }, { shop_id: opts.shopId }],
    });
  }
  if (opts.search) {
    andClauses.push({
      $or: [
        { name: { $regex: opts.search, $options: "i" } },
        { product_name: { $regex: opts.search, $options: "i" } },
        { item_name: { $regex: opts.search, $options: "i" } },
      ],
    });
  }
  if (andClauses.length > 0) {
    filter.$and = andClauses;
  }

  const limit = opts.limit || 50;
  const skip = opts.skip || 0;

  const [products, total] = await Promise.all([
    coll.find(filter).skip(skip).limit(limit).toArray(),
    coll.countDocuments(filter),
  ]);

  return { products, total };
}

/**
 * ดึงสินค้าเดียวตาม itemid
 */
export async function getProduct(opts: {
  platform: Platform;
  itemId: string;
}): Promise<ProductDoc | null> {
  const coll = await getDbWalletCollection<ProductDoc>(COLLECTION_MAP[opts.platform]);
  const variants = itemIdVariants(opts.itemId);

  return coll.findOne({
    $or: [
      { itemid: { $in: variants } },
      { item_id: { $in: variants } },
    ],
  });
}

/**
 * ดึงสินค้าหลายชิ้นตาม itemids (ใช้ตอนแสดง "สินค้าที่ถูกพูดถึง")
 */
export async function getProductsByIds(opts: {
  platform: Platform;
  itemIds: string[];
}): Promise<ProductDoc[]> {
  if (opts.itemIds.length === 0) return [];
  const coll = await getDbWalletCollection<ProductDoc>(COLLECTION_MAP[opts.platform]);

  // รวบรวมทุก variant (string + number) ของทุก item_id
  // เพราะ item_id ใน DB อาจเก็บเป็น number ไม่ใช่ string
  const allVariants: (string | number)[] = [];
  for (const id of opts.itemIds) {
    allVariants.push(...itemIdVariants(id));
  }

  const docs = await coll
    .find({
      $or: [
        { itemid: { $in: allVariants } },
        { item_id: { $in: allVariants } },
      ],
    })
    .toArray();

  return docs;
}

/**
 * ดึงรายชื่อร้านค้าทั้งหมดใน platform (distinct shopid + shop_name)
 * ใช้สำหรับ filter dropdown ใน chat list
 */
export async function listShopsByPlatform(platform: Platform): Promise<
  { shop_id: string; shop_name?: string; product_count: number }[]
> {
  const coll = await getDbWalletCollection<ProductDoc>(COLLECTION_MAP[platform]);

  // aggregate distinct shopid + count
  const pipeline = [
    {
      $group: {
        _id: { $ifNull: ["$shopid", "$shop_id"] },
        shop_name: { $first: { $ifNull: ["$shop_name", "$shopname"] } },
        product_count: { $sum: 1 },
      },
    },
    { $match: { _id: { $nin: [null, ""] } } },
    { $sort: { shop_name: 1 } },
  ];

  const results = await coll.aggregate(pipeline).toArray();
  return results.map((r) => ({
    shop_id: String(r._id),
    shop_name: r.shop_name ? String(r.shop_name) : undefined,
    product_count: r.product_count,
  }));
}

export const productService = {
  listProducts,
  getProduct,
  getProductsByIds,
  listShopsByPlatform,
};
