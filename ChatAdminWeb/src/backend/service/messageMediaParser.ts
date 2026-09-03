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
  // fallback schemas (บาง message อาจเก็บตรงๆ ไม่ nested ใน data.content)
  message_type?: string;
  content?: Record<string, unknown>;
  msg_type?: string;
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
  // ⚡ bundle_message — มี sub-messages หลายตัว (Shopee bundle)
  bundle?: ParsedMessage[];
}

/**
 * Normalize item_id ให้เป็น canonical int string (ไม่มี .0 ต่อท้าย)
 * Shopee ส่ง item_id มาเป็น float เช่น 47615436122.0 → แปลงเป็น "47615436122"
 * รองรับ: number, string, float, int, string ที่มี .0 ต่อท้าย
 */
export function normalizeItemId(id: unknown): string {
  if (id === null || id === undefined || id === "") return "";
  // ถ้าเป็น number → แปลงเป็น int ก่อน (ตัด .0)
  if (typeof id === "number") {
    return String(Math.trunc(id));
  }
  // ถ้าเป็น string → ลอง parse เป็น number แล้วตัดทศนิยม
  const s = String(id).trim();
  if (s === "") return "";
  // รูปแบบ "47615436122.0" → ตัด .0 ออก
  if (/^\d+\.\d+$/.test(s)) {
    const n = parseFloat(s);
    if (!isNaN(n)) return String(Math.trunc(n));
  }
  // รูปแบบ "47615436122" → คืนเดิม
  return s;
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
  // ⚡ ลองหา message_type จากหลาย schema
  //   1. raw_payload.data.content.message_type (schema หลัก)
  //   2. raw_payload.message_type (schema fallback)
  //   3. raw_payload.msg_type (schema fallback 2)
  const nestedContent = raw?.data?.content;
  const msgType = (
    nestedContent?.message_type
    || raw?.message_type
    || raw?.msg_type
    || "unknown"
  ) as MessageType;
  const inner = nestedContent?.content || raw?.content || {};

  // ⚡ ลองอนุมานจาก fallbackText ก่อนเสมอ
  //    placeholder เช่น "[รูปภาพ]", "[item]", "[วิดีโอ]" บอกชนิดข้อความ
  //    ทำก่อน switch เพราะบาง message มี message_type="text" แต่จริงๆ เป็น [item]
  //    (data writer อาจใส่ placeholder แทน raw media)
  const ft = fallbackText.trim();
  // ⚡ ใช้ includes แทน ^ เพื่อ match ทุกที่ใน text (ไม่จำเป็นต้องขึ้นต้น)
  if (/\[รูปภาพ\]|\[image\]/i.test(ft)) {
    if (msgType === "image") {
      // ไป switch case ข้างล่าง (มี url จาก raw_payload)
    } else {
      return { message_type: "image", text: fallbackText || "(รูปภาพ)" };
    }
  } else if (/\[วิดิโอ\]|\[วิดีโอ\]|\[video\]/i.test(ft)) {
    if (msgType === "video") {
      // ไป switch case
    } else {
      return { message_type: "video", text: fallbackText || "(วิดีโอ)" };
    }
  } else if (/\[item\]|\[itemid\]|\[สินค้า\]/i.test(ft)) {
    const idMatch = ft.match(/(\d{6,})/);
    if (msgType === "item" || msgType === "variation_card") {
      // ไป switch case (มี product_ref จาก raw_payload)
    } else {
      return {
        message_type: "item",
        text: fallbackText || "(สินค้า)",
        product_ref: idMatch ? { item_id: idMatch[1] } : undefined,
      };
    }
  } else if (/\[order\]|\[คำสั่งซื้อ\]/i.test(ft)) {
    if (msgType === "order") {
      // ไป switch case
    } else {
      const snMatch = ft.match(/(\d{8,})/);
      return {
        message_type: "order",
        text: fallbackText || "(คำสั่งซื้อ)",
        order_sn: snMatch ? snMatch[1] : "",
      };
    }
  } else if (/\[sticker\]|\[สติกเกอร์\]/i.test(ft)) {
    return { message_type: "sticker", text: fallbackText || "(สติกเกอร์)" };
  } else if (/\[notification\]|\[แจ้งเตือน\]/i.test(ft)) {
    return { message_type: "notification", text: fallbackText || "", notification_text: "" };
  } else if (/\[variation_card\]|\[ตัวเลือกสินค้า\]/i.test(ft)) {
    if (msgType === "variation_card") {
      // ไป switch case
    } else {
      const idMatch = ft.match(/(\d{6,})/);
      return {
        message_type: "variation_card",
        text: fallbackText || "(สินค้าพร้อมตัวเลือก)",
        product_ref: idMatch ? { item_id: idMatch[1] } : undefined,
      };
    }
  }

  // ถ้า msgType เป็น unknown และไม่ match placeholder → text ปกติ
  if (msgType === "unknown") {
    return { message_type: "text", text: fallbackText };
  }

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
      const itemId = normalizeItemId(c.item_id);
      return {
        message_type: "item",
        text: fallbackText || "(สินค้า)",
        product_ref: { item_id: itemId, shop_id: c.shop_id ? String(c.shop_id) : undefined },
      };
    }

    case "variation_card": {
      const c = inner as any;
      const itemId = normalizeItemId(c.product_id || c.item_id);
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

    // faq_liveagent — Shopee ส่งตอนโอนจากบอทไปคน (Live Agent) หรือตอนแสดง FAQ
    // แสดงเป็น notification style แทน text ดิบๆ ที่เป็น "[faq_liveagent]"
    case "faq_liveagent": {
      const c = inner as any;
      const faqText = String(
        c.faq_text || c.text || c.message || fallbackText || ""
      );
      return {
        message_type: "faq_liveagent",
        text: faqText || "(โอนไปยังเจ้าหน้าที่)",
        notification_text: faqText || "โอนไปยังเจ้าหน้าที่",
      };
    }

    // ⚡ bundle_message — Shopee ส่งมาเมื่อลูกค้าแชร์สินค้าหลายชิ้นพร้อมกัน
    // raw_payload.content.messages = array ของ message_id strings (ไม่ใช่ sub-message objects)
    // raw_payload.source_content.item_id = item_id ของสินค้าหลักใน bundle
    // เรา extract item_id จาก source_content แล้ว treat เหมือน item card
    case "bundle_message":
    case "bundle_deal": {
      const c = inner as any;
      // อ่าน item_id จาก source_content (อยู่ใน raw_payload ไม่ใช่ content)
      const rawAny = raw as any;
      const sourceContent = rawAny?.source_content || rawAny?.data?.source_content;
      const itemId = sourceContent?.item_id
        ? normalizeItemId(sourceContent.item_id)
        : c.item_id ? normalizeItemId(c.item_id) : "";
      if (itemId) {
        return {
          message_type: "item" as MessageType,
          text: fallbackText || "(สินค้า)",
          product_ref: { item_id: itemId },
        };
      }
      // ไม่มี item_id → แสดงเป็น placeholder
      return { message_type: "text", text: fallbackText || "(bundle)" };
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
