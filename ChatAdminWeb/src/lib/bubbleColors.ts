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

export function adminBubbleTextColor(color: string): string {
  const match = /^#([\da-f]{6})$/i.exec(color.trim());
  if (!match) return "var(--color-text)";
  const channels = [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const navyLuminance = 0.015;
  const navyContrast = (luminance + 0.05) / (navyLuminance + 0.05);
  return whiteContrast >= navyContrast ? "#ffffff" : "#0b2340";
}

export function adminBubbleStyle(color: string): { backgroundColor: string; color: string } {
  return { backgroundColor: color, color: adminBubbleTextColor(color) };
}

// สีคงที่สำหรับแต่ละฝั่ง
export const ZAAPI_COLOR = "#11302e"; // เขียวเข้มมาก
export const BOT_COLOR = "#0b2340"; // navy (sidebar)
export const ADMIN_COLOR = DEFAULT_ADMIN_COLOR; // แดงเข้ม (default/fallback)
