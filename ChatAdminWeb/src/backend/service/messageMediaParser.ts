// Parse raw_payload ของ messages_shp → ข้อมูล rich media สำหรับแสดงในแชท
// Schema ของ Shopee mirror (raw_payload.data.content):
//   message_type: text | image | video | item | variation_card | sticker | order | notification | image_with_text
//   content: { ... } — ข้อมูลเฉพาะแต่ละ type
//
// ⚠️ SAFETY: อ่านเฉพาะที่ mirror มาให้แล้ว ไม่ call Shopee API
import type { MessageType, MessageMedia, MessageTable, ProductCard } from "@/lib/types";
import type { Platform } from "./conversationService";

interface RawContent {
  message_type?: string;
  content?: Record<string, unknown>;
}

interface RawPayload {
  data?: { content?: RawContent };
}

// Shopee image host — thumb_url ใน raw_payload อาจเป็นแค่ hash ต้อง prepend
const SHOPEE_IMAGE_HOST = "https://img.sp.mms.shopee.sg/";

function normalizeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  // เป็น hash — prepend host
  return SHOPEE_IMAGE_HOST + url;
}

export interface ParsedMessage {
  message_type: MessageType;
  text: string;              // text ที่จะแสดง (อาจเป็นคำอธิบายแทน media)
  media?: MessageMedia;
  product_ref?: { item_id: string; shop_id?: string }; // สำหรับ item/variation_card — ต้อง lookup จาก product collection
  order_sn?: string;
  notification_text?: string;
  table?: MessageTable;
}

/**
 * Parse raw_payload ของ message → ParsedMessage (ยังไม่ได้ lookup product)
 * สำหรับ item/variation_card จะได้ product_ref กลับมา แล้ว caller ต้องไป lookup เอง
 */
export function parseRawMessage(
  rawPayload: unknown,
  fallbackText: string
): ParsedMessage {
  const raw = rawPayload as RawPayload | undefined;
  const content = raw?.data?.content;
  const msgType = (content?.message_type || "unknown") as MessageType;
  const inner = content?.content || {};

  switch (msgType) {
    case "text": {
      const text = String((inner as any).text || fallbackText || "");
      return { message_type: "text", text };
    }

    case "image": {
      const c = inner as any;
      return {
        message_type: "image",
        text: fallbackText || "(รูปภาพ)",
        media: {
          type: "image",
          url: normalizeImageUrl(c.url),
          thumb_url: normalizeImageUrl(c.thumb_url),
          thumb_width: c.thumb_width,
          thumb_height: c.thumb_height,
        },
      };
    }

    case "video": {
      const c = inner as any;
      return {
        message_type: "video",
        text: fallbackText || "(วิดีโอ)",
        media: {
          type: "video",
          url: c.video_url,
          thumb_url: normalizeImageUrl(c.thumb_url),
          thumb_width: c.thumb_width,
          thumb_height: c.thumb_height,
          duration_seconds: c.duration_seconds,
        },
      };
    }

    case "image_with_text": {
      const c = inner as any;
      return {
        message_type: "image_with_text",
        text: String(c.text || ""),
        media: {
          type: "image",
          url: normalizeImageUrl(c.image_url),
          thumb_url: normalizeImageUrl(c.thumb_url),
          thumb_width: c.thumb_width,
          thumb_height: c.thumb_height,
        },
      };
    }

    case "item": {
      const c = inner as any;
      const itemId = String(c.item_id || "");
      return {
        message_type: "item",
        text: fallbackText || "(สินค้า)",
        product_ref: { item_id: itemId, shop_id: c.shop_id ? String(c.shop_id) : undefined },
      };
    }

    case "variation_card": {
      const c = inner as any;
      const itemId = String(c.product_id || c.item_id || "");
      // พยายามดึงข้อมูลตารางจาก item_card_v2 (ถ้ามี)
      let table: MessageTable | undefined;
      const card = c.item_card_v2;
      if (card && card.display_price) {
        const dp = card.display_price;
        table = {
          headers: ["ราคา", "ส่วนลด"],
          rows: [[
            String(dp.discount_price || "-"),
            String(dp.discount_text?.text || dp.discount || "-"),
          ]],
        };
      }
      return {
        message_type: "variation_card",
        text: fallbackText || "(สินค้าพร้อมตัวเลือก)",
        product_ref: { item_id: itemId, shop_id: c.shop_id ? String(c.shop_id) : undefined },
        table,
      };
    }

    case "order": {
      const c = inner as any;
      return {
        message_type: "order",
        text: fallbackText || "(คำสั่งซื้อ)",
        order_sn: String(c.order_sn || ""),
      };
    }

    case "sticker": {
      const c = inner as any;
      return {
        message_type: "sticker",
        text: `(สติกเกอร์ ${c.sticker_id || ""})`,
      };
    }

    case "notification": {
      const c = inner as any;
      return {
        message_type: "notification",
        text: fallbackText || "",
        notification_text: String(c.notification_for_receiver || c.notification_for_sender || ""),
      };
    }

    default:
      return { message_type: msgType, text: fallbackText || `(ข้อความประเภท ${msgType})` };
  }
}

/**
 * แปลง ProductDoc (จาก dbWallet) → ProductCard สำหรับ UI
 * รองรับ schema ต่างกันของ Shopee/TikTok/Lazada
 */
export function toProductCard(
  doc: Record<string, unknown>,
  platform: Platform
): ProductCard {
  const itemId = String(doc.item_id || doc.itemid || "");
  const name = String(
    doc.name || doc.item_name || doc.product_name || doc.title || "(ไม่มีชื่อสินค้า)"
  );

  // ดึงรูป — schema ต่างกัน
  let image: string | undefined;
  const images = doc.images as any;
  if (typeof images === "string") {
    image = images;
  } else if (Array.isArray(images)) {
    image = images[0];
  } else if (images && typeof images === "object") {
    // Shopee: { image_id_list: [...] } หรือ { image_url_list: [...] }
    const list = images.image_url_list || images.image_id_list;
    if (Array.isArray(list) && list.length > 0) {
      image = normalizeImageUrl(String(list[0]));
    }
  }
  if (!image && doc.image_url) image = String(doc.image_url);
  if (!image && doc.image) image = String(doc.image);

  // ดึง URL
  let url: string | undefined;
  if (typeof doc.short_link === "string") url = doc.short_link;
  else if (typeof doc.url === "string") url = doc.url;
  else if (typeof doc.product_link === "string") url = doc.product_link;
  else if (itemId) {
    // fallback — สร้าง link ตาม platform (เป็น link เว็บ ไม่ใช่ API call)
    if (platform === "shopee") url = `https://shopee.co.th/product/${doc.shopid || doc.shop_id || ""}/${itemId}`;
  }

  // ดึงราคา
  const price = Number(doc.price || doc.new_check_price || doc.gen_price || 0);

  // ดึงชื่อร้าน
  const shop = String(doc.shopname || doc.shop_name || "");

  return { item_id: itemId, name, price, image, shop, url };
}
