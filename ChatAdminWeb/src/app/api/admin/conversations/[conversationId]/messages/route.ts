// GET /api/admin/conversations/:id/messages — list messages in a conversation
// ⚠️ อ่านอย่างเดียว — ไม่ mark read บน platform ใดๆ
// รองรับ rich media: ดึงจาก raw_payload.data.content และ lookup product จาก dbWallet
//
// Query params:
//   limit  = จำนวนข้อความต่อ page (default 20, max 100)
//   before = ISO timestamp — ดึงข้อความก่อนเวลานี้ (cursor pagination, ใช้สำหรับ infinite scroll ขึ้นบน)
//   after  = ISO timestamp — ดึงข้อความหลังเวลานี้ (cursor pagination, ใช้สำหรับ infinite scroll ลงล่าง)
//   all    = "1" — ดึงทั้งหมด (ไม่ paginate, สำหรับกรณีพิเศษ)
//
// Response:
//   { messages: ChatMessage[], total: number, has_more: boolean, oldest?: string, newest?: string }
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { messageService } from "@/backend/service/messageService";
import { conversationService } from "@/backend/service/conversationService";
import { productService } from "@/backend/service/productService";
import { parseRawMessage, toProductCard } from "@/backend/service/messageMediaParser";
import { auth } from "@/backend/service/authService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { ChatMessage, ProductCard } from "@/lib/types";

const PAGE_SIZE = 20;
const MAX_PAGE = 100;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "1";
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const limitParam = parseInt(url.searchParams.get("limit") || String(PAGE_SIZE), 10);
  const limit = all ? 100000 : Math.min(Math.max(limitParam, 1), MAX_PAGE);

  // ตรวจว่า conversation มีอยู่จริง
  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  // ℹ️ Shared inbox model — admin ทุกคนอ่าน messages ได้

  // ดึง total count สำหรับแสดงใน UI
  const msgColl = await getCollection(COLLECTIONS.messages);
  const total = await msgColl.countDocuments({ conversation_id: conversationId });

  // ดึง messages ตาม cursor
  const docs = await messageService.listMessagesPaginated(conversationId, {
    platform: conv.platform,
    limit,
    before: before ? new Date(before) : undefined,
    after: after ? new Date(after) : undefined,
  });

  // 1. parse raw_payload → media/product_ref ทุก message
  const parsed = docs.map((d) => ({
    doc: d,
    parsed: parseRawMessage(d.raw_payload, d.text),
  }));

  // 2. รวบรวม item_ids ที่ต้อง lookup จาก product collection (item + variation_card)
  const itemIdsToLookup = new Set<string>();
  for (const { parsed: p } of parsed) {
    if (p.product_ref?.item_id) itemIdsToLookup.add(p.product_ref.item_id);
  }

  // 3. batch lookup products จาก dbWallet (read-only)
  const productMap = new Map<string, ProductCard>();
  if (itemIdsToLookup.size > 0) {
    try {
      const products = await productService.getProductsByIds({
        platform: conv.platform,
        itemIds: [...itemIdsToLookup],
      });
      for (const p of products) {
        const card = toProductCard(p as Record<string, unknown>, conv.platform);
        const id = String(p.item_id || p.itemid || "");
        if (id) productMap.set(id, card);
      }
    } catch (err) {
      console.warn("[messages] product lookup failed:", err instanceof Error ? err.message : err);
    }
  }

  // 3.5 batch lookup admin names
  const adminIds = new Set<string>();
  for (const { doc } of parsed) {
    if (doc.actor && doc.role === "admin") adminIds.add(doc.actor);
  }
  const adminNameMap = new Map<string, string>();
  if (adminIds.size > 0) {
    for (const aid of adminIds) {
      try {
        const a = await auth.getAdminById(aid);
        if (a) adminNameMap.set(aid, a.name || a.username || aid);
      } catch { /* ignore */ }
    }
  }

  // 4. derive replied status — ใช้ out timestamps จาก docs ใน page นี้
  //    (ถ้ามี out message หลังจาก user message = ตอบแล้ว)
  const outTimestamps = docs
    .filter((d) => d.direction === "out")
    .map((d) => d.created_timestamp.getTime())
    .sort((a, b) => a - b);

  const messages: ChatMessage[] = parsed.map(({ doc, parsed: p }) => {
    const products: ProductCard[] = (doc.products as ProductCard[] | undefined) || [];
    if (p.product_ref?.item_id) {
      const card = productMap.get(p.product_ref.item_id);
      if (card) products.push(card);
    }

    const msgTime = doc.created_timestamp.getTime();
    const replied = doc.role === "user" && doc.direction === "in"
      ? outTimestamps.some((t) => t > msgTime)
      : true;

    return {
      id: doc.message_id,
      role: doc.role,
      text: p.text || doc.text,
      timestamp: doc.created_timestamp.toISOString(),
      products: products.length > 0 ? products : undefined,
      source: doc.source,
      topic: doc.topic as ChatMessage["topic"] | undefined,
      tokens: doc.tokens,
      message_type: p.message_type,
      media: p.media,
      order_sn: p.order_sn,
      notification_text: p.notification_text,
      table: p.table,
      admin_id: doc.actor,
      admin_name: doc.actor ? adminNameMap.get(doc.actor) : undefined,
      replied,
    };
  });

  // ส่ง cursor info สำหรับ infinite scroll
  const oldestTs = docs.length > 0 ? docs[0].created_timestamp.toISOString() : undefined;
  const newestTs = docs.length > 0 ? docs[docs.length - 1].created_timestamp.toISOString() : undefined;
  const hasMore = !all && docs.length === limit;

  // ⚠️ เมื่อ all=1 ส่งเป็น array ตรงๆ (เพื่อรักษา backward compat กับ chatService.messages)
  // มิฉะนั้นส่งเป็น { messages, total, has_more, oldest, newest }
  if (all) return json(messages);
  return json({ messages, total, has_more: hasMore, oldest: oldestTs, newest: newestTs });
}
