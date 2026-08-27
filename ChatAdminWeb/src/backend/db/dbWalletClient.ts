// dbWallet DB client (read-only) — เชื่อม dbWallet ผ่าน MONGO_URI
// ⚠️ READ-ONLY เสมอ — ห้ามเขียนลง dbWallet เด็ดขาด
// ใช้สำหรับ: อ่านสินค้า (ShpProducts / TiksProduct / OpenLazadaProducts)
//
// ป้องกันการเขียนด้วย ReadOnlyCollection wrapper — ถ้ามี code เรียก insert/update/delete
// จะ throw error ทันที เพื่อป้องกัน accident
import { MongoClient, type Db, type Collection, type Document } from "mongodb";

let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * ReadOnlyCollection — wrapper ที่ block write operations ทั้งหมด
 * เปิดเผยแค่ find, findOne, countDocuments, aggregate, distinct (อ่านเท่านั้น)
 */
export class ReadOnlyCollection<T extends Document = Document> {
  constructor(private readonly coll: Collection<T>) {}

  // ✅ Read operations — อนุญาต
  find(filter?: Record<string, unknown>) { return this.coll.find(filter as never); }
  findOne(filter: Record<string, unknown>) { return this.coll.findOne(filter as never); }
  findOneById(id: unknown) { return this.coll.findOne({ _id: id } as never); }
  countDocuments(filter: Record<string, unknown>) { return this.coll.countDocuments(filter as never); }
  estimatedDocumentCount() { return this.coll.estimatedDocumentCount(); }
  aggregate(pipeline: unknown[]) { return this.coll.aggregate(pipeline as never[]); }
  distinct(key: string, filter?: Record<string, unknown>) {
    return this.coll.distinct(key as never, filter as never);
  }

  // ❌ Write operations — block ทั้งหมด
  insertOne(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม insertOne ลง dbWallet"); }
  insertMany(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม insertMany ลง dbWallet"); }
  updateOne(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม updateOne ลง dbWallet"); }
  updateMany(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม updateMany ลง dbWallet"); }
  replaceOne(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม replaceOne ลง dbWallet"); }
  deleteOne(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม deleteOne ลง dbWallet"); }
  deleteMany(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม deleteMany ลง dbWallet"); }
  findOneAndUpdate(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม findOneAndUpdate ลง dbWallet"); }
  findOneAndReplace(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม findOneAndReplace ลง dbWallet"); }
  findOneAndDelete(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม findOneAndDelete ลง dbWallet"); }
  bulkWrite(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม bulkWrite ลง dbWallet"); }
  drop(): never { throw new Error("[dbWallet] READ-ONLY — ห้าม drop collection ใน dbWallet"); }
}

/**
 * เชื่อม dbWallet แบบ read-only
 * ใช้ MONGO_URI เป็น connection string
 * ใช้ MONGO_DB (default: dbWallet) เป็นชื่อ database
 */
export async function getDbWallet(): Promise<Db> {
  if (db && client) return db;

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI ไม่ถูกตั้งใน .env — ต้องตั้งค่า dbWallet read-only URI");
  }
  const dbName = process.env.MONGO_DB || "dbWallet";

  client = new MongoClient(uri, {
    // read-only preference — ไม่มี write concern
    readPreference: "secondaryPreferred",
  });

  await client.connect();
  db = client.db(dbName);
  return db;
}

/**
 * ดึง collection แบบ read-only — ใช้ ReadOnlyCollection wrapper
 * ทุก write operation จะ throw error
 */
export async function getDbWalletCollection<T extends Document = Document>(
  name: string
): Promise<ReadOnlyCollection<T>> {
  const database = await getDbWallet();
  return new ReadOnlyCollection<T>(database.collection<T>(name));
}

/** ปิด connection (ใช้ตอน shutdown เท่านั้น) */
export async function closeDbWallet(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
