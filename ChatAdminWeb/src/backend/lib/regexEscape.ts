// Regex escape helper — ป้องกัน $regex injection / ReDoS
//
// ใช้สำหรับ escape user-supplied search string ก่อนส่งเข้า MongoDB $regex
// ป้องกัน metacharacters (., *, +, [, ], etc.) จากถูกตีความเป็น regex

/**
 * Escape regex metacharacters ใน string
 * ใช้สำหรับสร้าง literal search ใน MongoDB $regex
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * สร้าง safe regex search string พร้อม truncate ความยาว
 * - escape metacharacters
 * - truncate ถ้าเกิน maxLength (ป้องกัน ReDoS จาก string ยาวเกินไป)
 */
export function safeRegexSearch(s: string | undefined | null, maxLength = 100): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const truncated = trimmed.slice(0, maxLength);
  return escapeRegex(truncated);
}
