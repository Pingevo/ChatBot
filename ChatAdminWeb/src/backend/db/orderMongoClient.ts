import { MongoClient, type Collection, type Document } from "mongodb";

let orderClientPromise: Promise<MongoClient> | null = null;

export async function getOrderCollection<T extends Document = Document>(): Promise<Collection<T>> {
  const uri = process.env.ORDER_URI_MONGO?.trim();
  if (!uri) throw new Error("ORDER_URI_MONGO not configured");

  if (!orderClientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    orderClientPromise = client.connect().catch((error) => {
      orderClientPromise = null;
      throw error;
    });
  }

  const client = await orderClientPromise;
  return client.db(process.env.ORDER_DB || "dbWallet")
    .collection<T>(process.env.ORDER_COLLECTION || "ShpOrders");
}
