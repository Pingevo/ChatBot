// ⚡ สี bubble กลาง — ใช้ร่วมระหว่าง ChatWindow, TicketChatPanel, Botworker
//    admin ปัจจุบัน (จาก authStore) → ใช้สีที่ตั้งใน profile (bubble_color)
//    admin อื่น → แยกสีตาม palette (โทนเข้ม contrast กับขาว)

// palette สำหรับ admin อื่น (ไม่ใช่ admin ปัจจุบัน) — ทุกสีเข้ม contrast กับขาว
const ADMIN_PALETTE = [
  "#0d3b4a", // navy
  "#4a0d4a", // ม่วงเข้ม
  "#3b0d4a", // ม่วงน้ำเงินเข้ม
  "#0d4a2a", // เขียวเข้ม
  "#4a0d0d", // แดงน้ำตาลเข้ม
  "#3b0d4a", // ม่วงน้ำเงินเข้ม
  "#4a3b0d", // ทองเข้ม
  "#0d4a4a", // teal เข้ม
];

const DEFAULT_ADMIN_COLOR = "#560C0E"; // แดงเข้ม — default ถ้าไม่ได้ตั้ง

/**
 * คำนวณสี bubble ของ admin ตาม admin_id
 * - ถ้าเป็น admin ปัจจุบัน (myAdminId) → ใช้ myBubbleColor หรือ default
 * - ถ้าเป็น admin อื่น → hash admin_id → palette
 */
export function adminBubbleColor(
  adminId: string | undefined,
  myAdminId?: string,
  myBubbleColor?: string,
): string {
  if (!adminId) return DEFAULT_ADMIN_COLOR;
  if (myAdminId && adminId === myAdminId) {
    return myBubbleColor || DEFAULT_ADMIN_COLOR;
  }
  const hash = Math.abs([...adminId].reduce((a, c) => a + c.charCodeAt(0), 0));
  return ADMIN_PALETTE[hash % ADMIN_PALETTE.length];
}

// สีคงที่สำหรับแต่ละฝั่ง
export const ZAAPI_COLOR = "#11302e"; // เขียวเข้มมาก
export const BOT_COLOR = "#0b2340"; // navy (sidebar)
export const ADMIN_COLOR = DEFAULT_ADMIN_COLOR; // แดงเข้ม (default/fallback)
