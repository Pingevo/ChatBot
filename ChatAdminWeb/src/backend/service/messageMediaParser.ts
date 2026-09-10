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
  // ⚡ Shopee bundle_message เก็บ source_content ที่ raw.data.content.source_content
  source_content?: Record<string, unknown> | null;
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
// ⚡ Shopee product image host — image_id_list ใน dbWallet ใช้ CDN คนละตัวกับ message media
//    เหมือน Python _first_image_url: https://cf.shopee.co.th/file/{hash}
const SHOPEE_PRODUCT_IMAGE_HOST = "https://cf.shopee.co.th/file/";

function normalizeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  // เป็น hash — prepend host
  return SHOPEE_IMAGE_HOST + url;
}

// ⚡ สำหรับ product image จาก dbWallet — ใช้ CDN ของ Shopee Thailand (มี /file/ ใน path)
function normalizeProductImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  // เป็น hash — prepend product image host
  return SHOPEE_PRODUCT_IMAGE_HOST + url;
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
  // ⚡ bundle_message — ถ้า source_content ว่าง แต่มี messages array (message_id strings)
  //    API route จะ fetch sub-messages จาก DB ด้วย IDs เหล่านี้ แล้ว parse เป็น bundle field
  bundle_message_ids?: string[];
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
  // ⚡ normalize alias — Shopee บางครั้งส่งชื่อ tag ต่างจากที่เราใช้:
  //   item_card → item, picture → image, faq_liveagents → faq_liveagent
  const _rawMsgType = (
    nestedContent?.message_type
    || raw?.message_type
    || raw?.msg_type
    || "unknown"
  ) as string;
  const msgType = (
    _rawMsgType === "item_card" ? "item"
    : _rawMsgType === "picture" ? "image"
    : _rawMsgType === "faq_liveagents" ? "faq_liveagent"
    : _rawMsgType
  ) as MessageType;
  const inner = nestedContent?.content || raw?.content || {};

  // ⚡ ลองอนุมานจาก fallbackText ก่อนเสมอ
  //    placeholder เช่น "[รูปภาพ]", "[item]", "[วิดีโอ]" บอกชนิดข้อความ
  //    ทำก่อน switch เพราะบาง message มี message_type="text" แต่จริงๆ เป็น [item]
  //    (data writer อาจใส่ placeholder แทน raw media)
  const ft = fallbackText.trim();
  // ⚡ ใช้ includes แทน ^ เพื่อ match ทุกที่ใน text (ไม่จำเป็นต้องขึ้นต้น)
  if (/\[รูปภาพ\]|\[image\]|\[picture\]/i.test(ft)) {
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
  } else if (/\[item\]|\[itemid\]|\[item_card\]|\[สินค้า\]/i.test(ft)) {
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
    // ⚡ ถ้า msgType === "sticker" → ไป switch case เพื่อดึง URL จาก raw_payload
    //    ถ้าไม่ใช่ → พยายามดู raw_payload อยู่ดี (Shopee บางทีส่ง msg_type ผิด)
    if (msgType !== "sticker") {
      // ⚡ พยายามดึง URL จาก inner content แม้ msgType ไม่ใช่ sticker
      const c = (inner as any) || {};
      const nestedSticker = c.sticker && typeof c.sticker === "object" ? c.sticker : null;
      let tryUrl = normalizeImageUrl(
        c.url || c.image_url || c.sticker_url || c.sticker_image_url ||
        c.image || c.pic || c.file_url ||
        (nestedSticker as any)?.url || (nestedSticker as any)?.image_url
      );
      // ⚡ fallback — สร้าง URL จาก sticker_id + sticker_package_id ถ้าไม่มี URL ตรงๆ
      if (!tryUrl && c.sticker_id && c.sticker_package_id) {
        tryUrl = `https://deo.shopeemobile.com/shopee/shopee-sticker-live-th/packs/${c.sticker_package_id}/${c.sticker_id}@1x.png`;
      }
      if (tryUrl) {
        // มี URL → ส่งเป็น sticker พร้อมรูป
        const tryThumb = normalizeImageUrl(
          c.thumb_url || c.thumbnail_url || c.sticker_thumb_url ||
          (nestedSticker as any)?.thumb_url
        );
        return {
          message_type: "sticker",
          text: `(สติกเกอร์${c.sticker_id ? ` ${c.sticker_id}` : ""})`,
          media: {
            type: "image" as const,
            url: tryUrl,
            thumb_url: tryThumb,
            thumb_width: c.width || c.thumb_width,
            thumb_height: c.height || c.thumb_height,
          },
        };
      }
      return { message_type: "sticker", text: fallbackText || "(สติกเกอร์)" };
    }
    // ไป switch case ข้างล่าง (มี URL จาก raw_payload)
  } else if (/\[notification\]|\[แจ้งเตือน\]/i.test(ft)) {
    return { message_type: "notification", text: fallbackText || "", notification_text: "" };
  } else if (/\[faq_liveagent\]|\[faq_liveagents\]|\[โอนเจ้าหน้าที่\]/i.test(ft)) {
    // ⚡ faq_liveagent placeholder — แสดงเป็น system-style "โอนไปยังเจ้าหน้าที่"
    return {
      message_type: "faq_liveagent" as MessageType,
      text: fallbackText || "(โอนไปยังเจ้าหน้าที่)",
      notification_text: fallbackText || "โอนไปยังเจ้าหน้าที่",
    };
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
      // ⚡ Shopee sticker raw_payload มีหลาย schema:
      //   - url / image_url / sticker_url / sticker_image_url — URL รูปสติกเกอร์เต็ม
      //   - thumb_url / thumbnail_url — thumbnail (อาจเป็น hash ต้อง normalize)
      //   - image / pic / file_url — field อื่นที่ Shopee อาจใช้
      //   - sticker.{url,image_url} — nested object
      //   - width / height — ขนาด
      //   - sticker_id — ID ของสติกเกอร์
      //   - sticker_package_id — package ID (ใช้สร้าง URL ถ้าไม่มี image_url)
      const nestedSticker = c.sticker && typeof c.sticker === "object" ? c.sticker : null;
      let stickerUrl = normalizeImageUrl(
        c.url || c.image_url || c.sticker_url || c.sticker_image_url ||
        c.image || c.pic || c.file_url ||
        (nestedSticker as any)?.url || (nestedSticker as any)?.image_url
      );
      // ⚡ fallback — ถ้าไม่มี URL แต่มี sticker_id + sticker_package_id → สร้าง URL จาก pattern
      //    pattern: https://deo.shopeemobile.com/shopee/shopee-sticker-live-th/packs/{package_id}/{sticker_id}@1x.png
      //    (เห็นจากของจริง: shogi_oct_2023/0001@1x.png)
      if (!stickerUrl && c.sticker_id && c.sticker_package_id) {
        stickerUrl = `https://deo.shopeemobile.com/shopee/shopee-sticker-live-th/packs/${c.sticker_package_id}/${c.sticker_id}@1x.png`;
      }
      const stickerThumb = normalizeImageUrl(
        c.thumb_url || c.thumbnail_url || c.sticker_thumb_url ||
        (nestedSticker as any)?.thumb_url
      );
      return {
        message_type: "sticker",
        text: `(สติกเกอร์${c.sticker_id ? ` ${c.sticker_id}` : ""})`,
        media: stickerUrl ? {
          type: "image" as const,
          url: stickerUrl,
          thumb_url: stickerThumb,
          thumb_width: c.width || c.thumb_width,
          thumb_height: c.height || c.thumb_height,
        } : undefined,
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
      // ⚡ อ่าน item_id จาก source_content — ลองหลายตำแหน่ง:
      //    1. raw.source_content (top level)
      //    2. raw.data.source_content
      //    3. nestedContent.source_content (= raw.data.content.source_content) ← พบจริงใน DB
      //    4. inner.source_content (= raw.data.content.content.source_content)
      const rawAny = raw as any;
      const sourceContent = rawAny?.source_content
        || rawAny?.data?.source_content
        || nestedContent?.source_content
        || c?.source_content;
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
      // ⚡ ถ้าไม่มี item_id แต่มี messages array (message_id strings) →
      //    เก็บ IDs ไว้ให้ API route fetch sub-messages จาก DB แล้ว parse เป็น bundle
      const subMessageIds = c?.messages;
      if (Array.isArray(subMessageIds) && subMessageIds.length > 0) {
        return {
          message_type: "bundle_message" as MessageType,
          text: fallbackText && fallbackText !== "[bundle_message]"
            ? fallbackText
            : `Bundle (${subMessageIds.length} ข้อความ)`,
          bundle_message_ids: subMessageIds.map(String),
        };
      }
      // ไม่มี item_id และไม่มี messages → แสดงเป็น placeholder
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

  // ดึงรูป — schema ต่างกันของแต่ละ platform
  // ⚡ Shopee dbWallet: doc.image.image_id_list = ["hash1", "hash2"] (singular "image")
  //    Python bot ใช้ https://cf.shopee.co.th/file/{hash} — ต้องใช้ host + path เดียวกัน
  let image: string | undefined;
  const imagesField = doc.images as any;
  const imageField = doc.image as any;
  if (typeof imagesField === "string") {
    image = normalizeProductImageUrl(imagesField);
  } else if (Array.isArray(imagesField)) {
    image = normalizeProductImageUrl(String(imagesField[0] || ""));
  } else if (imagesField && typeof imagesField === "object") {
    // Shopee: { image_id_list: [...] } หรือ { image_url_list: [...] }
    const list = imagesField.image_url_list || imagesField.image_id_list;
    if (Array.isArray(list) && list.length > 0) {
      image = normalizeProductImageUrl(String(list[0]));
    }
  }
  // ⚡ Shopee dbWallet ใช้ doc.image (singular) มี image_id_list ข้างใน — เหมือน Python _first_image_url
  if (!image && imageField && typeof imageField === "object") {
    const list = imageField.image_url_list || imageField.image_id_list;
    if (Array.isArray(list) && list.length > 0) {
      image = normalizeProductImageUrl(String(list[0]));
    }
  }
  if (!image && doc.image_url) image = normalizeProductImageUrl(String(doc.image_url));
  if (!image && doc.image && typeof doc.image === "string") image = normalizeProductImageUrl(String(doc.image));

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
