// GET /api/admin/conversations/:id/orders — ดึงประวัติคำสั่งซื้อของลูกค้า
// เชื่อม customer_id ใน conversation กับ buyer_user_id ใน order collection (dbWallet)
import { NextRequest } from "next/server";
import { MongoClient } from "mongodb";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";

// Order DB connection (read-only, lazy singleton)
let _orderClient: MongoClient | null = null;

function getOrderClient(): MongoClient {
  if (_orderClient) return _orderClient;
  const uri = process.env.ORDER_URI_MONGO?.trim();
  if (!uri) throw new Error("ORDER_URI_MONGO not configured");
  _orderClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  return _orderClient;
}

// Order status mapping (Thai)
const ORDER_STATUS_TH: Record<string, string> = {
  UNPAID: "ยังไม่ชำระเงิน",
  READY_TO_SHIP: "พร้อมจัดส่ง",
  PROCESSED: "กำลังเตรียมจัดส่ง",
  SHIPPED: "จัดส่งแล้ว",
  TO_CONFIRM_RECEIVE: "รอยืนยันรับสินค้า",
  COMPLETED: "สำเร็จแล้ว",
  CANCELLED: "ยกเลิกแล้ว",
  TO_RETURN: "รอคืนสินค้า/คืนเงิน",
  RETRY_SHIP: "กำลังจัดส่งใหม่",
};

function formatCreateTime(ts: unknown): string {
  if (!ts || typeof ts !== "number") return "—";
  try {
    const dt = new Date(ts * 1000);
    const months = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    return `${dt.getDate()} ${months[dt.getMonth() + 1]} ${dt.getFullYear() + 543}`;
  } catch {
    return String(ts);
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const doc = await conversationService.getConversation(conversationId);
  if (!doc) return error("conversation not found", 404);

  const customerId = doc.customer_id;
  if (!customerId) return json({ orders: [], customer_id: null, total: 0 });

  // buyer_user_id ใน order เป็น number — แปลง customer_id (string) เป็น number
  const buyerUserId = Number(customerId);
  if (!Number.isFinite(buyerUserId) || buyerUserId <= 0) {
    return json({ orders: [], customer_id: customerId, total: 0, note: "customer_id ไม่ใช่ตัวเลขที่ใช้ได้" });
  }

  try {
    const client = getOrderClient();
    await client.connect();
    const db = client.db(process.env.ORDER_DB || "dbWallet");
    const coll = db.collection(process.env.ORDER_COLLECTION || "ShpOrders");

    // ดึง orders ล่าสุด 50 รายการ
    const docs = await coll
      .find(
        { buyer_user_id: buyerUserId },
        {
          projection: {
            order_sn: 1,
            order_status: 1,
            create_time: 1,
            shopname: 1,
            shipping_carrier: 1,
            item_list: { $slice: 10 },
            package_list: { $slice: 1 },
          },
        }
      )
      .sort({ create_time: -1 })
      .limit(50)
      .toArray();

    const orders = docs.map((d) => {
      const items = (d.item_list || []).map((i: Record<string, unknown>) => ({
        name: (i.item_name as string) || (i.model_name as string) || "",
        model_name: (i.model_name as string) || "",
        quantity: Number(i.model_quantity_purchased) || 1,
      }));
      const pkg = (d.package_list || [])[0] as Record<string, unknown> | undefined;
      return {
        order_sn: d.order_sn,
        order_status: ORDER_STATUS_TH[(d.order_status as string) || ""] || d.order_status || "—",
        order_status_raw: d.order_status || "",
        create_time: formatCreateTime(d.create_time),
        shopname: d.shopname || "",
        shipping_carrier: d.shipping_carrier || (pkg?.shipping_carrier as string) || "",
        items,
        item_count: items.length,
        total_quantity: items.reduce((s: number, i: { quantity: number }) => s + i.quantity, 0),
      };
    });

    return json({ orders, customer_id: customerId, total: orders.length });
  } catch (e) {
    console.error("[orders] error:", e);
    return error("ไม่สามารถดึงข้อมูลคำสั่งซื้อได้", 500);
  }
}
