// Product service — ดึงสินค้าจาก dbWallet (read-only)
// collection ตาม platform:
//   shopee  → ShpProducts      (SHP_PRODUCTS_COLLECTION)
//   tiktok  → TiksProduct      (TIKTOK_PRODUCTS_COLLECTION)
//   lazada  → OpenLazadaProducts (LAZADA_PRODUCTS_COLLECTION)
//
// ⚠️ READ-ONLY เสมอ — ใช้สำหรับแสดงในแชทเท่านั้น ห้ามเขียน
import type { Document } from "mongodb";
import { getDbWalletCollection } from "../db/dbWalletClient";
import { safeRegexSearch } from "../lib/regexEscape";
import type { Platform } from "./conversationService";

export interface ProductDoc extends Document {
  itemid?: string;
  item_id?: string;
  shopid?: string;
  shop_id?: string;
  shopname?: string;
  shop_name?: string;
  name?: string;
  item_name?: string;
  product_name?: string;
  title?: string;
  price?: number;
  new_check_price?: number;
  gen_price?: number;
  stock?: number;
  total_stock?: number;
  brand?: string | { original_brand_name?: string };
  cat_name?: string;
  description?: string;
  description_info?: { extended_description?: { field_list?: { type?: string; text?: string }[] } };
  field_list?: unknown[];
  attribute_list?: unknown[];
  warranty?: unknown;
  condition?: string;
  weight?: number;
  dimension?: unknown;
  item_status?: string;
  model?: {
    model_id?: string | number;
    model_name?: string;
    model_sku?: string;
    model_status?: string;
    price_info?: { current_price?: number }[];
    stock_info_v2?: Record<string, unknown>;
  }[];
  tier_variation?: unknown[];
  stock_info_v2?: Record<string, unknown>;
  image?: unknown;
  images?: string[];
  image_url?: string;
  url?: string;
  short_link?: string;
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

function numericStock(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function shopeeStock(source: Record<string, unknown>, includeListingFallback: boolean): number | null {
  const stockInfo = source.stock_info_v2 && typeof source.stock_info_v2 === "object"
    ? source.stock_info_v2 as Record<string, unknown>
    : {};
  const summary = stockInfo.summary_info && typeof stockInfo.summary_info === "object"
    ? stockInfo.summary_info as Record<string, unknown>
    : {};
  if (numericStock(summary.total_available_stock)) return summary.total_available_stock;

  const shopeeStockRows = Array.isArray(stockInfo.shopee_stock) ? stockInfo.shopee_stock : [];
  const shopeeStocks = shopeeStockRows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && numericStock((row as Record<string, unknown>).stock))
    .map((row) => row.stock as number);
  if (shopeeStocks.length > 0) return shopeeStocks.reduce((sum, stock) => sum + stock, 0);

  const sellerStockRows = Array.isArray(stockInfo.seller_stock) ? stockInfo.seller_stock : [];
  const sellerStocks = sellerStockRows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object"
      && (row as Record<string, unknown>).if_saleable !== false
      && numericStock((row as Record<string, unknown>).stock))
    .map((row) => row.stock as number);
  if (sellerStocks.length > 0) return sellerStocks.reduce((sum, stock) => sum + stock, 0);

  if (!includeListingFallback) return null;
  const fallback = source.stock !== undefined ? source.stock : source.total_stock;
  if (numericStock(fallback)) return fallback;
  return null;
}

function isSellableShopeeProduct(product: ProductDoc): boolean {
  const status = String(product.item_status || product.status || "").toUpperCase();
  if (status !== "NORMAL") return false;

  const models = Array.isArray(product.model) ? product.model : [];
  if (models.length > 0) {
    const activeModels = models.filter((model) => String(model.model_status || "").toUpperCase() === "MODEL_NORMAL");
    if (activeModels.length === 0) return false;
    let stockKnown = false;
    let totalStock = 0;
    for (const model of activeModels) {
      const stock = shopeeStock(model, false);
      if (stock !== null) {
        stockKnown = true;
        totalStock += stock;
      }
    }
    return stockKnown && totalStock > 0;
  }

  const stock = shopeeStock(product, true);
  return stock !== null && stock > 0;
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
    // 🔒 escape regex
    const safeSearch = safeRegexSearch(opts.search);
    if (safeSearch) {
      andClauses.push({
        $or: [
          { name: { $regex: safeSearch, $options: "i" } },
          { product_name: { $regex: safeSearch, $options: "i" } },
          { item_name: { $regex: safeSearch, $options: "i" } },
        ],
      });
    }
  }
  if (andClauses.length > 0) {
    filter.$and = andClauses;
  }

  const limit = opts.limit || 50;
  const skip = opts.skip || 0;
  const rows = await coll.find(filter).project({
    itemid: 1, item_id: 1, id: 1,
    name: 1, item_name: 1, product_name: 1, title: 1,
    price: 1, new_check_price: 1, gen_price: 1,
    images: 1, image: 1, image_url: 1, main_images: 1,
    url: 1, short_link: 1, product_link: 1,
    shopid: 1, shop_id: 1, shopname: 1, shop_name: 1,
    item_status: 1, status: 1, stock: 1, total_stock: 1,
    stock_info_v2: 1, "model.model_status": 1, "model.stock_info_v2": 1,
  }).toArray();
  const sellable = opts.platform === "shopee" ? rows.filter(isSellableShopeeProduct) : rows;

  return { products: sellable.slice(skip, skip + limit), total: sellable.length };
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

/** ดึง field รายละเอียดที่ใช้ใน modal โดยไม่อ่าน embedding หรือ field อื่นทั้ง document */
export async function getProductDetails(opts: {
  platform: Platform;
  itemId: string;
}): Promise<ProductDoc | null> {
  const coll = await getDbWalletCollection<ProductDoc>(COLLECTION_MAP[opts.platform]);
  const variants = itemIdVariants(opts.itemId);

  return coll
    .find({
      $or: [
        { itemid: { $in: variants } },
        { item_id: { $in: variants } },
      ],
    })
    .project({
        _id: 0,
        itemid: 1, item_id: 1,
        name: 1, item_name: 1, product_name: 1, title: 1,
        price: 1, new_check_price: 1, gen_price: 1,
        url: 1, short_link: 1, product_link: 1,
        shopid: 1, shop_id: 1, shopname: 1, shop_name: 1,
        description: 1, "description_info.extended_description.field_list": 1,
        field_list: 1, attribute_list: 1,
        brand: 1, cat_name: 1, item_status: 1, status: 1,
        stock: 1, total_stock: 1, warranty: 1, condition: 1, weight: 1, dimension: 1,
        "model.model_id": 1, "model.model_name": 1, "model.model_sku": 1,
        "model.model_status": 1, "model.price_info.current_price": 1,
        "model.stock_info_v2.summary_info.total_available_stock": 1, tier_variation: 1,
    })
    .limit(1)
    .next();
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

  // ⚡ projection — ดึงเฉพาะ field ที่ toProductCard ใช้ (item_id/name/price/image/url/shop)
  //   ตัด field ใหญ่ๆ ใน product doc (description/specs/embedding) — caller ทุกตัวใช้แค่ card fields
  const docs = await coll
    .find({
      $or: [
        { itemid: { $in: allVariants } },
        { item_id: { $in: allVariants } },
      ],
    })
    .project({
      item_id: 1, itemid: 1,
      name: 1, item_name: 1, product_name: 1, title: 1,
      images: 1, image: 1, image_url: 1,
      short_link: 1, url: 1, product_link: 1,
      price: 1, new_check_price: 1, gen_price: 1,
      shopid: 1, shop_id: 1, shopname: 1, shop_name: 1,
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

/** รายชื่อ shopname ตาม catalog contract เดิมจาก Python GET /shops. */
export async function listCatalogShopNames(platform: Platform = "shopee"): Promise<string[]> {
  const coll = await getDbWalletCollection<ProductDoc>(COLLECTION_MAP[platform]);
  const names = await coll.distinct("shopname");
  return (names as string[]).sort();
}

export const productService = {
  listProducts,
  getProduct,
  getProductDetails,
  getProductsByIds,
  listShopsByPlatform,
  listCatalogShopNames,
};
