// ⛔ IRON RULES — กฎเหล็กของโปรเจกต์นี้ (Phase 7 — รองรับ 3 platform)
// ห้ามเปลี่ยนค่าเหล่านี้เป็น true เด็ดขาด — การเปลี่ยนจะทำให้ระบบยิง platform API จริง
// ซึ่งอาจทำให้เกิดการส่งข้อความจริงให้ลูกค้า, ทำเครื่องหมายอ่านแล้วจริง, หรือปักหมุดจริง
// ส่งผลกระทบต่อ production ของ sellcenter และ Zaapi ทันที
//
// ค่าเหล่านี้ hard-coded เป็น false เสมอ ไม่อ่านจาก environment variable
// ป้องกัน copy-paste .env ผิดแบบที่เคยเกิดขึ้น (2026-08-18)
//
// ถ้าต้องการเปิดใช้จริงในอนาคต ต้อง:
// 1. ได้รับอนุญาตจากผู้ดูแลระบบ
// 2. แก้ไฟล์นี้โดยตรง (ไม่ใช่ผ่าน env หรือ UI)
// 3. ทำ shadow bot testing จนมั่นใจก่อนเปิด live

export type Platform = "shopee" | "tiktok" | "lazada";

export const SAFETY = {
  // === Shopee — ห้ามยิง Shopee API ทุก endpoint ===
  shopeeLiveRead: false,      // get_conversation_list, get_message, get_one_conversation
  shopeeLiveSend: false,      // send_message, send_autoreply_message
  shopeeLiveMarkRead: false,  // read_conversation, unread_conversation
  shopeeLivePin: false,       // pin_conversation, unpin_conversation
  shopeePoll: false,          // pollWorker (poll Shopee API)

  // === TikTok — เผื่ออนาคต (ยังไม่มี code แต่วางไว้กันพลาด) ===
  tiktokLiveSend: false,
  tiktokLiveRead: false,

  // === Lazada — เผื่ออนาคต ===
  lazadaLiveSend: false,
  lazadaLiveRead: false,

  // === กันเปลี่ยน callback URL ที่ลงทะเบียนกับ platform ===
  shopeeChangeCallbackUrl: false,
} as const;

// Type สำหรับเช็ค compile-time ว่าค่าเป็น false เสมอ
export type SafetyFlags = typeof SAFETY;

const PLATFORM_FLAGS = {
  shopee: { send: SAFETY.shopeeLiveSend, read: SAFETY.shopeeLiveRead },
  tiktok: { send: SAFETY.tiktokLiveSend, read: SAFETY.tiktokLiveRead },
  lazada: { send: SAFETY.lazadaLiveSend, read: SAFETY.lazadaLiveRead },
} as const;

const PLATFORM_PREFIX = {
  shopee: "shp_",
  tiktok: "tt_",
  lazada: "lz_",
} as const;

/**
 * Guard — เรียกทุกครั้งก่อนยิง platform API (send/read/mark_read/pin)
 * ถ้ามีคนเปลี่ยนค่าเป็น true โดยไม่ตั้งใจ จะ throw ทันที
 */
export function assertPlatformApiDisabled(
  platform: Platform,
  operation: "send" | "read" | "mark_read" | "pin" | "poll"
): void {
  const flags = PLATFORM_FLAGS[platform];
  const blocked =
    (operation === "send" && flags.send) ||
    (operation === "read" && flags.read) ||
    (operation === "mark_read" && flags.read) ||
    (operation === "pin" && flags.read) ||
    (operation === "poll" && platform === "shopee" && SAFETY.shopeePoll);
  if (blocked) {
    throw new Error(
      `BLOCKED: ${platform} ${operation} disabled by Iron Rule. ` +
      `If you see this error, check src/backend/lib/safety.ts — safety switches must remain false.`
    );
  }
}

/**
 * Guard — กัน bot ตอบข้าม platform
 * เช็คว่า message platform ตรงกับ bot platform ที่กำลังประมวลผล
 */
export function assertPlatformMatch(
  msgPlatform: string,
  botPlatform: Platform
): void {
  if (msgPlatform !== botPlatform) {
    throw new Error(
      `BLOCKED: platform mismatch — ${botPlatform} bot ไม่รับ ${msgPlatform} message. ` +
      `เช็คว่ามีการลืม filter platform ใน query หรือไม่`
    );
  }
}

/**
 * Guard — กัน conversation_id ผิด platform
 * ทุก conversation_id ต้องมี prefix ตาม platform:
 *   shopee → shp_
 *   tiktok → tt_
 *   lazada → lz_
 */
export function assertConversationIdPrefix(
  convId: string,
  platform: Platform
): void {
  const prefix = PLATFORM_PREFIX[platform];
  if (!convId || !convId.startsWith(prefix)) {
    throw new Error(
      `BLOCKED: ${platform} bot ไม่รับ conversation_id "${convId}" ` +
      `(ต้องขึ้นต้นด้วย "${prefix}"). ` +
      `เช็คว่ามีการ hardcode id ผิด หรือลืมใส่ prefix หรือไม่`
    );
  }
}

/**
 * Guard — รวมสำหรับ bot reply pipeline
 * ตรวจทั้ง platform match + conversation_id prefix พร้อมกัน
 */
export function assertBotReplyContext(opts: {
  msgPlatform: string;
  botPlatform: Platform;
  conversationId: string;
}): void {
  assertPlatformMatch(opts.msgPlatform, opts.botPlatform);
  assertConversationIdPrefix(opts.conversationId, opts.botPlatform);
}

/**
 * เช็คว่าอยู่ใน mock mode หรือไม่ (สำหรับทดสอบโดยไม่ยิง API จริง)
 */
export function isMockMode(): boolean {
  return process.env.MOCK_MODE_ENABLED === 'true';
}

/**
 * เช็คว่าเปิด shadow bot หรือไม่
 * shadow bot = bot generate reply แต่เก็บใน shadow_replies (ไม่ส่งจริง)
 */
export function isShadowBotEnabled(): boolean {
  return process.env.SHADOW_BOT_ENABLED === 'true';
}
