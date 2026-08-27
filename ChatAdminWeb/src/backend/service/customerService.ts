// Customer service — mirrors schema on `customers_shp`:
// customer_id, platform, conversations[], shops[], last_active_at, created_at
// (พี่เขา mirror จาก sellcenter — field อาจไม่มี name/buyer_id)
// name ของลูกค้าดึงจาก conversations_shp.to_name (join ตอน list)
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "./conversationService";

export interface CustomerDoc extends Document {
  platform: Platform;
  buyer_id: string;          // mapped from customer_id
  customer_id?: string;      // raw field from sellcenter mirror
  name: string;              // from conversations_shp.to_name — fallback to customer_id
  avatar?: string;
  last_active_at: Date;
  created_at: Date;
  conversations?: string[];
  shops?: string[];
}

// Raw doc shape from customers_shp (sellcenter mirror)
interface RawCustomerDoc extends Document {
  platform: Platform;
  customer_id: string;
  name?: string;
  avatar?: string;
  last_active_at: Date;
  created_at: Date;
  conversations?: string[];
  shops?: string[];
}

// Map raw doc → CustomerDoc (กัน field ขาด)
function mapCustomer(raw: RawCustomerDoc, nameFromConv?: string): CustomerDoc {
  return {
    ...raw,
    buyer_id: raw.buyer_id || raw.customer_id || String(raw._id),
    customer_id: raw.customer_id,
    name: raw.name || nameFromConv || raw.customer_id || "(ไม่มีชื่อ)",
  } as CustomerDoc;
}

export async function upsertCustomer(opts: {
  platform: Platform;
  buyerId: string;
  name: string;
  avatar?: string;
}): Promise<CustomerDoc> {
  const coll = await getCollection<CustomerDoc>(COLLECTIONS.customers);
  const now = new Date();
  await coll.updateOne(
    { platform: opts.platform, buyer_id: opts.buyerId },
    {
      $set: { name: opts.name, avatar: opts.avatar, last_active_at: now },
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  );
  return (await coll.findOne({ platform: opts.platform, buyer_id: opts.buyerId }))!;
}

export async function getCustomer(platform: Platform, buyerId: string): Promise<CustomerDoc | null> {
  const coll = await getCollection<RawCustomerDoc>(COLLECTIONS.customers);
  // หาทั้ง buyer_id และ customer_id (กัน schema ไม่ตรง)
  const raw = await coll.findOne({
    $or: [
      { platform, buyer_id: buyerId },
      { platform, customer_id: buyerId },
    ],
  });
  if (!raw) return null;
  // ดึง name จาก conversations_shp.to_name
  let nameFromConv: string | undefined;
  try {
    const convColl = await getCollection<{ to_name?: string; customer_id?: string }>("conversations_shp");
    const conv = await convColl.findOne({ customer_id: raw.customer_id, platform });
    nameFromConv = conv?.to_name;
  } catch { /* ignore */ }
  return mapCustomer(raw, nameFromConv);
}

/**
 * List customers with search, platform filter, sorting and pagination.
 * ดึง name จาก conversations_shp.to_name ผ่าน $lookup
 */
export async function listCustomers(opts: {
  platform?: Platform;
  search?: string;
  sortBy?: "name" | "last_active_at" | "created_at";
  sortDir?: 1 | -1;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ rows: CustomerDoc[]; total: number }> {
  const coll = await getCollection<RawCustomerDoc>(COLLECTIONS.customers);
  const filter: Record<string, unknown> = {};
  if (opts.platform) filter.platform = opts.platform;
  if (opts.search) {
    filter.$or = [
      { name: { $regex: opts.search, $options: "i" } },
      { buyer_id: { $regex: opts.search, $options: "i" } },
      { customer_id: { $regex: opts.search, $options: "i" } },
    ];
  }
  const sortBy = opts.sortBy || "last_active_at";
  const sortDir = opts.sortDir || -1;
  const page = Math.max(1, opts.page || 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));

  // ใช้ aggregate + $lookup conversations_shp เพื่อดึง to_name เป็น name ลูกค้า
  const pipeline: any[] = [
    { $match: filter },
    {
      $lookup: {
        from: "conversations_shp",
        let: { cid: "$customer_id", plat: "$platform" },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ["$customer_id", "$$cid"] },
            { $eq: ["$platform", "$$plat"] },
          ] } } },
          { $project: { to_name: 1, _id: 0 } },
        ],
        as: "convs",
      },
    },
    {
      $addFields: {
        customer_name: {
          $ifNull: [
            { $arrayElemAt: ["$convs.to_name", 0] },
            "$name",
          ],
        },
      },
    },
    { $unset: "convs" },
  ];

  // sort + paginate
  const sortField = sortBy === "name" ? "customer_name" : sortBy;
  pipeline.push({ $sort: { [sortField]: sortDir } });

  // total count (ก่อน paginate)
  const countPipeline = [...pipeline, { $count: "total" }];
  const countResult = await coll.aggregate(countPipeline).toArray();
  const total = countResult[0]?.total || 0;

  pipeline.push(
    { $skip: (page - 1) * pageSize },
    { $limit: pageSize }
  );

  const rawRows = await coll.aggregate(pipeline).toArray();
  const rows = rawRows.map((r: any) => mapCustomer(r as RawCustomerDoc, r.customer_name));
  return { rows, total };
}

export const customerService = {
  upsertCustomer,
  getCustomer,
  listCustomers,
};
