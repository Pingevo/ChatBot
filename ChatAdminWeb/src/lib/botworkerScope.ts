// ⚡ Phase 2D — botworker admission scope meta + effective-state helper (shared)
//   GET /api/shops แนบ `bot_worker` meta → /shops page + drawer ใช้คำนวณ label
//   เดียวกัน (ห้ามคำนวณ effective state ซ้ำสองที่)

export interface BotWorkerMeta {
  global: boolean;
  platforms: { shopee: boolean; tiktok: boolean; lazada: boolean };
  implemented: string[];
}

export type BotWorkerBlocker =
  "unavailable" | "global_off" | "no_backend" | "platform_off" | "shop_off" | null;

/**
 * effective admission state ของ shop — ตามลำดับ gate:
 *   meta โหลดไม่ได้ → global OFF → platform ยังไม่มี backend → platform OFF
 *   → shop OFF → ON
 *   (missing field = OFF — fail-closed เหมือน backend)
 *   `code` = blocker เชิง semantics (UI ตัดสิน display จาก code — ห้ามเทียบ reason string)
 *   `unavailable` ≠ `global_off` — meta ที่หายไปคือ backend unavailable ไม่ใช่
 *   admin ปิดทั้งระบบ (ต้องไม่แสดงเหมือน deliberate off)
 */
export function botWorkerEffective(
  shop: { platform: string; bot_worker_enabled?: boolean },
  meta: BotWorkerMeta | null
): { on: boolean; reason: string; code: BotWorkerBlocker } {
  if (!meta) return { on: false, reason: "สถานะบอทโหลดไม่ได้", code: "unavailable" };
  if (meta.global !== true) return { on: false, reason: "ปิดทั้งระบบ", code: "global_off" };
  if (!meta.implemented.includes(shop.platform)) return { on: false, reason: "platform ยังไม่มี backend", code: "no_backend" };
  if (meta.platforms[shop.platform as keyof BotWorkerMeta["platforms"]] !== true)
    return { on: false, reason: "platform ปิดอยู่", code: "platform_off" };
  if (shop.bot_worker_enabled !== true) return { on: false, reason: "ร้านนี้ปิดอยู่", code: "shop_off" };
  return { on: true, reason: "", code: null };
}
