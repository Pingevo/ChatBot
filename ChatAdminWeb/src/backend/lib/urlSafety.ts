// URL safety helpers — ป้องกัน SSRF
// ตรวจสอบว่า URL เป็น http/https และไม่ชี้ไปยัง private/internal network

/**
 * ตรวจสอบว่า URL ปลอดภัยสำหรับ server-side fetch
 * - ต้องเป็น http หรือ https เท่านั้น
 * - ห้ามชี้ไปยัง private IP, localhost, link-local (169.254.x.x), หรือ metadata endpoints
 *
 * ใช้สำหรับ config ที่ superadmin ตั้งค่าได้ (เช่น shopee_bot_url)
 * ป้องกัน SSRF ผ่านการตั้งค่า URL แล้วยิง testIntegration
 */
export function isSafeFetchUrl(rawUrl: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL format" };
  }

  // ต้องเป็น http หรือ https เท่านั้น
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `protocol "${parsed.protocol}" not allowed — only http/https` };
  }

  const host = parsed.hostname.toLowerCase();

  // ห้าม localhost และ variants
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") {
    return { ok: false, reason: "localhost is not allowed" };
  }

  // ห้าม link-local / metadata service (169.254.169.254, 169.254.x.x)
  if (host.startsWith("169.254.")) {
    return { ok: false, reason: "link-local addresses are not allowed" };
  }

  // ห้าม private IP ranges
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
  const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number) as unknown as number[];
    if (a === 10) return { ok: false, reason: "private IP range 10.x.x.x not allowed" };
    if (a === 127) return { ok: false, reason: "loopback IP 127.x.x.x not allowed" };
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: "private IP range 172.16-31.x.x not allowed" };
    if (a === 192 && b === 168) return { ok: false, reason: "private IP range 192.168.x.x not allowed" };
    if (a === 0) return { ok: false, reason: "0.x.x.x not allowed" };
  }

  // ห้าม IPv6 loopback แบบเต็ม [::1]
  if (host === "[::1]" || host === "::1") {
    return { ok: false, reason: "IPv6 loopback not allowed" };
  }

  return { ok: true };
}

/**
 * ตรวจสอบ URL และ throw Error ถ้าไม่ปลอดภัย
 * ใช้สำหรับจุดที่ต้องการ fail-fast
 */
export function assertSafeFetchUrl(rawUrl: string, field?: string): void {
  const result = isSafeFetchUrl(rawUrl);
  if (!result.ok) {
    const label = field ? ` (${field})` : "";
    throw new Error(`unsafe URL${label}: ${result.reason}`);
  }
}
