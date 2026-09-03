// Template Service — Phase 4: Variable Interpolation
//
// แทนที่ {{variable}} ในข้อความด้วยค่าจริงจาก context
// ⚡ pure function — ไม่ยิง DB เอง · caller ดึงข้อมูลมาก่อนแล้ว pass เป็น vars
//
// ตัวแปรที่รองรับ (เพิ่มได้ในอนาคต):
//   {{customerName}}      — ชื่อลูกค้า (จาก customer.name หรือ conversation.to_name)
//   {{shopName}}          — ชื่อร้าน (จาก conversation.shop_name)
//   {{integrationName}}   — platform (shopee/tiktok/lazada)
//   {{botAnswer}}         — คำตอบบอทล่าสุด (จาก context.bot_answer)
//   {{customerReply}}     — ข้อความตอบล่าสุดของลูกค้า (จาก context.customer_reply)
//   {{initialMessage}}    — ข้อความแรกที่ลูกค้าทักเข้ามา (จาก context.initial_message)
//   {{conversationId}}    — conversation ID
//   {{shopId}}            — shop ID
//   {{platform}}          — platform (shopee/tiktok/lazada)
//
// Usage:
//   const vars = await prepareTemplateVars(msg, context);
//   const resolved = resolveTemplate(node.config.text, vars);

/** dict ของตัวแปรที่ใช้แทนใน template */
export type TemplateVars = Record<string, string | undefined>;

/** regex จับ {{variableName}} — รองรับช่องว่างรอบชื่อ {{ varName }} */
const TEMPLATE_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** รายชื่อตัวแปรที่รองรับ — ใช้สำหรับ autocomplete ใน UI */
export const SUPPORTED_TEMPLATE_VARS: { name: string; description: string }[] = [
  { name: "customerName", description: "ชื่อลูกค้า" },
  { name: "shopName", description: "ชื่อร้าน" },
  { name: "integrationName", description: "แพลตฟอร์ม (shopee/tiktok/lazada)" },
  { name: "botAnswer", description: "คำตอบบอทล่าสุด" },
  { name: "customerReply", description: "ข้อความตอบล่าสุดของลูกค้า" },
  { name: "initialMessage", description: "ข้อความแรกที่ลูกค้าทักเข้ามา" },
  { name: "conversationId", description: "Conversation ID" },
  { name: "shopId", description: "Shop ID" },
  { name: "platform", description: "Platform (shopee/tiktok/lazada)" },
];

/**
 * แทนที่ {{variable}} ใน text ด้วยค่าจาก vars
 * - ถ้า var ไม่มีใน vars หรือเป็น undefined → แทนด้วยค่าว่าง
 * - ถ้า var ไม่รู้จัก (ไม่ใช่ตัวแปรที่รองรับ) → ก็แทนด้วยค่าว่าง (กัน leak)
 * - case-insensitive ชื่อตัวแปร
 */
export function resolveTemplate(text: string, vars: TemplateVars): string {
  if (!text) return "";
  if (typeof text !== "string") return String(text);

  // สร้าง lookup case-insensitive
  const lowerVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string") lowerVars[k.toLowerCase()] = v;
  }

  return text.replace(TEMPLATE_REGEX, (match, varName: string) => {
    const lower = String(varName || "").toLowerCase();
    const value = lowerVars[lower];
    return value !== undefined ? value : "";
  });
}

/** ตรวจว่า text มี {{variable}} หรือไม่ — ใช้ใน UI เพื่อ show preview */
export function hasTemplateVariables(text: string): boolean {
  if (!text) return false;
  return TEMPLATE_REGEX.test(text);
}

/** ดึงชื่อตัวแปรทั้งหมดที่อยู่ใน text — ใช้ใน UI สำหรับ highlight */
export function extractTemplateVariables(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(TEMPLATE_REGEX.source, "g");
  while ((match = re.exec(text)) !== null) {
    found.add(match[1]);
  }
  return Array.from(found);
}
