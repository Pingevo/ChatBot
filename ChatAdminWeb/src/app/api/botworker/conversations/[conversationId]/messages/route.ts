// GET /api/botworker/conversations/:conversationId/messages
// ดึงข้อความทั้งหมดใน conversation สำหรับหน้า /botworker
// merge 3 แหล่ง: user (messages_shp) + zaapi (messages_shp role=bot) + bot (shadow_replies)
// ส่งกลับเป็น unified list พร้อม field "source" บอกที่มา
//
// ⚡ parse raw_payload → message_type/media/products เหมือน /admin/conversations/:id/messages
//    ทำให้หน้า botworker แสดงรูป/สติกเกอร์/การ์ดสินค้า/การ์ดคำสั่งซื้อได้เหมือน /tickets
//
// ⛔ IRON RULE: ห้ามส่งข้อความจริง ห้ามเรียก platform API
// ⚡ force-dynamic — กัน Next.js cache
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { conversationService } from "@/backend/service/conversationService";
import { productService } from "@/backend/service/productService";
import { parseRawMessage, toProductCard } from "@/backend/service/messageMediaParser";
import type { Platform } from "@/backend/lib/safety";
import type { MessageType, MessageMedia, MessageTable, ProductCard } from "@/lib/types";

// ⚡ source label ใช้ค่าจาก COLLECTIONS (ไม่ hardcode) — กัน env เปลี่ยนแล้ว label ไม่ตรง
const MSG_SOURCE = COLLECTIONS.messages;     // "messages_shp" (จาก env)
const SHADOW_SOURCE = COLLECTIONS.shadowReplies; // "shadow_replies" (จาก env)

interface UnifiedMessage {
  id: string;
  role: "user" | "zaapi" | "bot" | "admin";
  text: string;
  timestamp: string;
  source: string;  // ⚡ เปลี่ยนจาก union เป็น string (ค่าจาก COLLECTIONS)
  // metadata
  admin_id?: string;
  admin_name?: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed_ms?: number;
  trigger_id?: string;
  mode?: string;
  origin?: string;
  image_desc?: string;
  images?: string[];
  // ⚡ rich media (parsed from raw_payload) — เหมือน /admin/conversations/:id/messages
  message_type?: MessageType;
  media?: MessageMedia;
  order_sn?: string;
  notification_text?: string;
  table?: MessageTable;
  bundle?: UnifiedMessage[];
  products?: ProductCard[];
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const url = new URL(req.url);
  const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
  const limitParam = parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Math.min(Math.max(limitParam, 1), 500);

  // ⚡ ดึง conversation เพื่อหา platform (สำหรับ product lookup)
  const conv = await conversationService.getConversation(conversationId);
  const convPlatform = platform || conv?.platform;

  // 1. ดึง user + zaapi + admin จาก messages_shp
  const msgColl = await getCollection<{
    message_id: string;
    conversation_id: string;
    role: string;
    text: string;
    platform: Platform;
    source?: string;
    actor?: string;
    created_timestamp: Date;
    image_desc?: string;
    raw_payload?: unknown;
  }>(COLLECTIONS.messages);

  const msgFilter: Record<string, unknown> = {
    conversation_id: conversationId,
    // ⚡ ดึง user + bot + admin (admin = zaapi ถ้าไม่มี actor, admin จริง ถ้ามี actor)
    role: { $in: ["user", "bot", "admin"] },
  };
  if (platform) msgFilter.platform = platform;

  const msgDocs = await msgColl
    .find(msgFilter)
    .sort({ created_timestamp: -1 })
    .limit(limit)
    .toArray();

  // 2. ดึง bot replies จาก shadow_replies
  const srColl = await getCollection<{
    shadow_reply_id: string;
    conversation_id: string;
    platform: Platform;
    bot_reply_text: string;
    bot_source?: string;
    bot_model?: string;
    bot_elapsed_ms?: number;
    trigger_id?: string;
    mode?: string;
    origin?: string;
    created_at: Date;
    deleted_at?: Date;
  }>(COLLECTIONS.shadowReplies);

  const srFilter: Record<string, unknown> = {
    conversation_id: conversationId,
    deleted_at: { $exists: false },
    bot_reply_text: { $nin: ["", null] },
  };
  if (platform) srFilter.platform = platform;

  const srDocs = await srColl
    .find(srFilter)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();

  // ⚡ 3. parse raw_payload → message_type/media/product_ref สำหรับ user + zaapi + admin messages
  //    เหมือน /admin/conversations/:id/messages ทุกขั้นตอน
  const parsedMsgs = msgDocs.map((d) => ({
    doc: d,
    parsed: parseRawMessage(d.raw_payload, d.text),
  }));

  // ⚡ 3.1 fetch sub-messages สำหรับ bundle_message ที่มี bundle_message_ids
  //    (Shopee bundle_message ส่ง message_id strings มา ต้อง fetch จาก DB แล้ว parse)
  const allBundleIds: string[] = [];
  for (const { parsed: p } of parsedMsgs) {
    if (p.bundle_message_ids && p.bundle_message_ids.length > 0) {
      allBundleIds.push(...p.bundle_message_ids);
    }
  }
  if (allBundleIds.length > 0) {
    const subDocs = await msgColl
      .find({ message_id: { $in: allBundleIds } })
      .toArray();
    const subDocMap = new Map(subDocs.map((d) => [d.message_id, d]));
    for (const { parsed: p } of parsedMsgs) {
      if (p.bundle_message_ids && p.bundle_message_ids.length > 0) {
        p.bundle = p.bundle_message_ids
          .map((mid) => {
            const sd = subDocMap.get(mid);
            if (!sd) return undefined;
            return parseRawMessage(sd.raw_payload, sd.text);
          })
          .filter((x): x is NonNullable<typeof x> => x !== undefined);
      }
    }
  }

  // ⚡ 3.5 batch lookup admin names (เหมือน /admin/conversations/:id/messages)
  const adminIds = new Set<string>();
  for (const { doc } of parsedMsgs) {
    if (doc.actor && doc.role === "admin") adminIds.add(doc.actor);
  }
  const adminNameMap = new Map<string, string>();
  if (adminIds.size > 0) {
    try {
      const { auth } = await import("@/backend/service/authService");
      for (const aid of adminIds) {
        const admin = await auth.getAdminById(aid);
        if (admin?.name) adminNameMap.set(aid, admin.name);
      }
    } catch {
      // skip — admin names optional
    }
  }

  // ⚡ 4. รวบรวม item_ids ที่ต้อง lookup จาก product collection (item + variation_card + bundle sub-messages)
  const itemIdsToLookup = new Set<string>();
  for (const { parsed: p } of parsedMsgs) {
    if (p.product_ref?.item_id) itemIdsToLookup.add(p.product_ref.item_id);
    // ⚡ bundle sub-messages อาจมี product_ref ด้วย
    if (p.bundle) {
      for (const sub of p.bundle) {
        if (sub.product_ref?.item_id) itemIdsToLookup.add(sub.product_ref.item_id);
      }
    }
  }

  // ⚡ 5. batch lookup products จาก dbWallet (read-only) — เหมือน admin route
  const productMap = new Map<string, ProductCard>();
  if (itemIdsToLookup.size > 0 && convPlatform) {
    try {
      const products = await productService.getProductsByIds({
        platform: convPlatform,
        itemIds: [...itemIdsToLookup],
      });
      for (const p of products) {
        const card = toProductCard(p as Record<string, unknown>, convPlatform);
        const id = String(p.item_id || p.itemid || "");
        if (id) productMap.set(id, card);
      }
    } catch (err) {
      console.warn("[botworker-messages] product lookup failed:", err instanceof Error ? err.message : err);
    }
  }

  // 6. merge เป็น unified list
  const unified: UnifiedMessage[] = [];

  for (const { doc: d, parsed: p } of parsedMsgs) {
    if (d.role === "user") {
      // ⚡ รวม products จาก product_ref lookup
      const products: ProductCard[] = [];
      if (p.product_ref?.item_id) {
        const card = productMap.get(p.product_ref.item_id);
        if (card) products.push(card);
      }
      unified.push({
        id: d.message_id,
        role: "user",
        text: p.text || d.text || "",
        timestamp: d.created_timestamp.toISOString(),
        source: MSG_SOURCE,
        image_desc: d.image_desc,
        // ⚡ rich media fields
        message_type: p.message_type,
        media: p.media,
        order_sn: p.order_sn,
        notification_text: p.notification_text,
        table: p.table,
        products: products.length > 0 ? products : undefined,
        // ⚡ bundle_message — แปลง sub-messages เป็น UnifiedMessage[] ส่งไป frontend
        bundle: p.bundle && p.bundle.length > 0
          ? p.bundle.map((sub, si) => {
              const subProducts: ProductCard[] = [];
              if (sub.product_ref?.item_id) {
                const card = productMap.get(sub.product_ref.item_id);
                if (card) subProducts.push(card);
              }
              return {
                id: `${d.message_id}_bundle_${si}`,
                role: "user" as const,
                text: sub.text || "",
                timestamp: d.created_timestamp.toISOString(),
                source: MSG_SOURCE,
                message_type: sub.message_type,
                media: sub.media,
                order_sn: sub.order_sn,
                notification_text: sub.notification_text,
                table: sub.table,
                products: subProducts.length > 0 ? subProducts : undefined,
              } as UnifiedMessage;
            })
          : undefined,
      });
    } else if (d.role === "bot") {
      // role=bot ใน messages_shp = Zaapi reply (sellcenter dump)
      // ⚡ Zaapi reply ก็ parse raw_payload เหมือนกัน — อาจมีรูป/สติกเกอร์ที่ zaapi ส่ง
      unified.push({
        id: d.message_id,
        role: "zaapi",
        text: p.text || d.text || "",
        timestamp: d.created_timestamp.toISOString(),
        source: MSG_SOURCE,
        // ⚡ rich media fields (zaapi อาจส่งรูป/สติกเกอร์ได้)
        message_type: p.message_type,
        media: p.media,
        order_sn: p.order_sn,
        notification_text: p.notification_text,
        table: p.table,
      });
    } else if (d.role === "admin") {
      // ⚡ admin จริง (มี actor) vs Zaapi (ไม่มี actor)
      if (d.actor) {
        // admin จริง — แอดมินเคยตอบในแชทนี้
        unified.push({
          id: d.message_id,
          role: "admin",
          text: p.text || d.text || "",
          timestamp: d.created_timestamp.toISOString(),
          source: MSG_SOURCE,
          admin_id: d.actor,
          admin_name: adminNameMap.get(d.actor),
          message_type: p.message_type,
          media: p.media,
          order_sn: p.order_sn,
          notification_text: p.notification_text,
          table: p.table,
        });
      } else {
        // Zaapi — role=admin ไม่มี actor = outbound จาก sellcenter
        unified.push({
          id: d.message_id,
          role: "zaapi",
          text: p.text || d.text || "",
          timestamp: d.created_timestamp.toISOString(),
          source: MSG_SOURCE,
          message_type: p.message_type,
          media: p.media,
          order_sn: p.order_sn,
          notification_text: p.notification_text,
          table: p.table,
        });
      }
    }
  }

  for (const d of srDocs) {
    unified.push({
      id: d.shadow_reply_id,
      role: "bot",
      text: d.bot_reply_text,
      timestamp: d.created_at.toISOString(),
      source: SHADOW_SOURCE,
      bot_source: d.bot_source,
      bot_model: d.bot_model,
      bot_elapsed_ms: d.bot_elapsed_ms,
      trigger_id: d.trigger_id,
      mode: d.mode,
      origin: d.origin,
    });
  }

  // 7. เรียงเก่า → ใหม่
  unified.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return json({ messages: unified, total: unified.length });
}
