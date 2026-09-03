// Field sanitization helpers — ป้องกัน mass assignment ใน service layer
//
// ใช้สำหรับกรอง field ก่อน spread เข้า MongoDB $set
// ป้องกัน caller ใหม่ที่ไม่ได้กรอง field เอง

/**
 * กรอง object เฉพาะ keys ที่อนุญาตเท่านั้น
 * - ตัด keys ที่ขึ้นต้นด้วย $ (ป้องกัน MongoDB operator injection)
 * - ตัด keys ที่มี . (ป้องกัน nested path injection)
 * - เก็บเฉพาะ keys ใน allowlist
 */
export function pickAllowed<T extends Record<string, unknown>>(
  obj: T,
  allowlist: readonly string[]
): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const key of allowlist) {
    if (key in obj) {
      // 🔒 ป้องกัน operator/path injection
      if (key.startsWith("$") || key.includes(".")) continue;
      const value = obj[key];
      if (value !== undefined) {
        result[key] = value;
      }
    }
  }
  return result as Partial<T>;
}

/**
 * ตรวจว่า object มี keys ที่ไม่ปลอดภัย (ขึ้นต้นด้วย $ หรือมี .)
 * คืน true ถ้าพบ keys ที่ไม่ปลอดภัย
 */
export function hasUnsafeKeys(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") || key.includes(".")) return true;
  }
  return false;
}
