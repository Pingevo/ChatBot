// Page registry — single source of truth สำหรับ permission matrix
// หน้าใหม่ → เพิ่ม entry ที่นี่บรรทัดเดียว → ขึ้นในตารางสิทธิ์ (/roles) อัตโนมัติ
//
// ⚠️ "role-admin" ไม่อยู่ใน list นี้โดยตั้งใจ — สิทธิ์ของมัน hardcode dev-only
//    ใน roles.ts + authorize.ts เสมอ กันเคส matrix ถูกแก้จนไม่มีใครเข้า /roles ได้

export type AccessLevel = "none" | "read" | "edit";

export interface PageDef {
  key: string;
  label: string;
  group: string;
}

export const PAGES: PageDef[] = [
  // main
  { key: "dashboard", label: "แดชบอร์ด", group: "หลัก" },
  { key: "analytics", label: "วิเคราะห์", group: "หลัก" },
  { key: "ticket", label: "ทิกเก็ต", group: "หลัก" },
  // process
  { key: "trigger", label: "ทริกเกอร์", group: "กระบวนการ" },
  { key: "workflow", label: "เวิร์กโฟลว์", group: "กระบวนการ" },
  { key: "quickreply", label: "ข้อความด่วน", group: "กระบวนการ" },
  { key: "kb", label: "ฐานความรู้", group: "กระบวนการ" },
  { key: "persona", label: "เพอร์โซน่า", group: "กระบวนการ" },
  { key: "shop-setting", label: "ตั้งค่าร้าน", group: "กระบวนการ" },
  // bot-testing
  { key: "testchat", label: "ทดสอบบอท", group: "การทดสอบบอท" },
  { key: "shadow-inbox", label: "กล่องเงา", group: "การทดสอบบอท" },
  { key: "botworker", label: "เครื่องบอท", group: "การทดสอบบอท" },
  { key: "test-assignment", label: "ทดสอบจ่ายงาน", group: "การทดสอบบอท" },
  { key: "live-assignment", label: "จ่ายงานสด", group: "การทดสอบบอท" },
  { key: "replay-compare", label: "เปรียบเทียบรีเพลย์", group: "การทดสอบบอท" },
  { key: "test-result", label: "ผลการทดสอบ", group: "การทดสอบบอท" },
  { key: "admin-review-kpi", label: "KPI รีวิวแอดมิน", group: "การทดสอบบอท" },
  { key: "admin-chat-result", label: "ผลแชทแอดมิน", group: "การทดสอบบอท" },
  { key: "test-chat-result", label: "ผลทดสอบแชท", group: "การทดสอบบอท" },
  // management
  { key: "shop", label: "ร้านค้า", group: "จัดการ" },
  { key: "customer", label: "รายชื่อลูกค้า", group: "จัดการ" },
  { key: "team", label: "ทีม & มอบหมาย", group: "จัดการ" },
  { key: "user", label: "จัดการผู้ใช้", group: "จัดการ" },
  // config
  { key: "admin-config", label: "ตั้งค่าแอดมิน", group: "ตั้งค่า" },
  { key: "config", label: "ตั้งค่าระบบ", group: "ตั้งค่า" },
  { key: "llm", label: "LLM & API Keys", group: "ตั้งค่า" },
  { key: "log", label: "บันทึกระบบ", group: "ตั้งค่า" },
];

export const PAGE_KEYS = PAGES.map((p) => p.key);

/** builtin roles — ลบไม่ได้; "dev" คือ super-role ที่เข้า /roles ได้เสมอ */
export const BUILTIN_ROLES = ["admin", "superadmin", "dev"] as const;
export const SUPER_ROLE = "dev";
export const ROLE_ADMIN_PAGE = "role-admin";

/** matrix เริ่มต้น — ค่าเดิมที่เคย hardcode; ใช้เป็น fallback + seed doc แรก */
export const DEFAULT_PERMISSIONS: Record<string, Record<string, AccessLevel>> = {
  dashboard:          { admin: "none", superadmin: "edit", dev: "edit" },
  analytics:          { admin: "none", superadmin: "edit", dev: "edit" },
  ticket:             { admin: "edit", superadmin: "edit", dev: "edit" },
  trigger:            { admin: "read", superadmin: "edit", dev: "edit" },
  workflow:           { admin: "read", superadmin: "edit", dev: "edit" },
  quickreply:         { admin: "edit", superadmin: "edit", dev: "edit" },
  kb:                 { admin: "read", superadmin: "edit", dev: "edit" },
  persona:            { admin: "read", superadmin: "edit", dev: "edit" },
  "shop-setting":     { admin: "read", superadmin: "edit", dev: "edit" },
  testchat:           { admin: "edit", superadmin: "edit", dev: "edit" },
  "shadow-inbox":     { admin: "edit", superadmin: "edit", dev: "edit" },
  botworker:          { admin: "read", superadmin: "read", dev: "edit" },
  "test-assignment":  { admin: "edit", superadmin: "edit", dev: "edit" },
  "live-assignment":  { admin: "edit", superadmin: "edit", dev: "edit" },
  "replay-compare":   { admin: "read", superadmin: "read", dev: "edit" },
  "test-result":      { admin: "read", superadmin: "read", dev: "edit" },
  "admin-review-kpi": { admin: "none", superadmin: "edit", dev: "edit" },
  "admin-chat-result": { admin: "none", superadmin: "none", dev: "edit" },
  "test-chat-result": { admin: "none", superadmin: "none", dev: "edit" },
  shop:               { admin: "read", superadmin: "edit", dev: "edit" },
  customer:           { admin: "read", superadmin: "edit", dev: "edit" },
  team:               { admin: "read", superadmin: "edit", dev: "edit" },
  user:               { admin: "none", superadmin: "edit", dev: "edit" },
  "admin-config":     { admin: "read", superadmin: "edit", dev: "edit" },
  config:             { admin: "none", superadmin: "none", dev: "edit" },
  llm:                { admin: "none", superadmin: "none", dev: "edit" },
  log:                { admin: "none", superadmin: "none", dev: "edit" },
};

/** สิทธิ์ของ page+role — dev ได้ edit เสมอ (กันล็อกตัวเอง), หน้าที่ไม่มีใน matrix → dev:edit อื่นๆ:none */
export function resolveAccess(
  matrix: Record<string, Record<string, AccessLevel>>,
  page: string,
  role: string
): AccessLevel {
  if (role === SUPER_ROLE) return "edit";
  if (page === ROLE_ADMIN_PAGE) return "none"; // หลุดมาถึงตรงนี้ = ไม่ใช่ dev → ห้าม
  return matrix[page]?.[role] ?? "none";
}
