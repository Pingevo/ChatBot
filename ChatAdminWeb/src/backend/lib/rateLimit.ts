// Lightweight in-memory rate limiter for Edge middleware.
//
// ⚠️ Limitations:
//   - In-memory per-instance — ไม่ sync ข้าม instance/replica
//   - สำหรับ production ขนาดใหญ่ควรใช้ Redis/Upstash KV
//   - แต่เพียงพอสำหรับป้องกัน brute-force พื้นฐานและ DoS เบื้องต้น
//
// ใช้ sliding window แบบง่าย — นับ request ในช่วงเวลาที่กำหนด

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

interface RateLimitOptions {
  /** จำนวน request สูงสุดต่อ window */
  limit: number;
  /** ระยะเวลา window ใน milliseconds */
  windowMs: number;
}

interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * ตรวจสอบ rate limit สำหรับ key (มักเป็น IP + path)
 * คืนค่า ok=true ถ้ายังไม่เกิน limit, ok=false ถ้าเกิน
 */
export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    // สร้าง bucket ใหม่
    const bucket: Bucket = { count: 1, resetAt: now + opts.windowMs };
    buckets.set(key, bucket);
    return { ok: true, limit: opts.limit, remaining: opts.limit - 1, resetAt: bucket.resetAt };
  }

  existing.count++;
  const remaining = Math.max(0, opts.limit - existing.count);
  const ok = existing.count <= opts.limit;
  return { ok, limit: opts.limit, remaining, resetAt: existing.resetAt };
}

/**
 * ทำความสะอาด bucket ที่หมดอายุ — เรียกเป็นครั้งคราวเพื่อป้องกัน memory leak
 */
export function cleanupRateLimitBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

/**
 * สร้าง rate limit key จาก request — ใช้ IP + path
 */
export function rateLimitKey(req: { headers: Headers; nextUrl: { pathname: string } }): string {
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff ? xff.split(",")[0].trim() : (req.headers.get("x-real-ip") || "unknown");
  return `${ip}:${req.nextUrl.pathname}`;
}
