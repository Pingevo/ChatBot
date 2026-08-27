"use client";
import { useEffect, useRef } from "react";

/**
 * usePolling — poll function ทุกๆ interval เมื่อ tab active
 * หยุด polling อัตโนมัติเมื่อ:
 *   - tab ไม่ visible (document.hidden)
 *   - component unmount
 *
 * ใช้ recursive setTimeout (ไม่ใช่ setInterval) เพื่อป้องกัน requests ซ้อนทับ
 * — ถ้า request ก่อนหน้ายังไม่จบ จะรอจนจบแล้วค่อยเริ่มตัวถัดไป
 * ป้องกัน main thread ค้างจาก state updates ซ้อนทับ
 *
 * ⚠️ ไม่ใช้สำหรับยิง platform API — ใช้กับ admin DB routes เท่านั้น
 */
export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  options?: { enabled?: boolean }
): void {
  const enabled = options?.enabled ?? true;
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    let running = false;

    const run = async () => {
      if (!active || running) return;
      if (typeof document !== "undefined" && document.hidden) return;
      running = true;
      try {
        await fnRef.current();
      } catch (err) {
        console.error("usePolling: error", err);
      } finally {
        running = false;
      }
    };

    const scheduleNext = () => {
      if (!active) return;
      timer = setTimeout(async () => {
        await run();
        if (active) scheduleNext();
      }, intervalMs);
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (timer) { clearTimeout(timer); timer = null; }
      } else {
        if (!timer) {
          run(); // refresh ทันทีเมื่อกลับมา active
          scheduleNext();
        }
      }
    };

    scheduleNext();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      active = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [enabled, intervalMs]);
}
