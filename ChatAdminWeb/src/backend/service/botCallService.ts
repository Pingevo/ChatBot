// Bot call service — แยก callBot ออกจาก botWorkerService
// เหตุผล: workflowEngine ต้องเรียก callBot (action let_ai_respond)
// และ botWorkerService.processMessage ต้องเรียก workflowEngine
// ถ้าทั้งคู่ import กันตรงๆ จะเกิด circular dependency → แยก callBot เป็น module ตรงกลาง
import { serverConfig } from "../lib/config";
import type { Platform } from "./systemConfigService";

export interface BotCallParams {
  platform: Platform;
  message: string;
  shopId: string;
  shopName?: string;
  history: { role: "user" | "model"; text: string }[];
}

export interface BotCallResponse {
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
}

/** เรียก Python bot ตรง (server-to-server ใช้ x-internal-secret — ไม่ใช้ cookie) */
export async function callBot(params: BotCallParams): Promise<BotCallResponse> {
  const baseUrl = serverConfig.chatbotBaseUrls[params.platform] || serverConfig.chatbotBaseUrls.shopee;
  const url = baseUrl.replace(/\/$/, "") + "/chat";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": serverConfig.chatbotInternalSecret,
    },
    body: JSON.stringify({
      message: params.message,
      // ⚠️ Python bot รับ field "shop" (ชื่อร้าน) ไม่ใช่ "shop_id" (ตัวเลข)
      // ถ้าไม่มี shopName ใช้ shopId เป็น fallback (อาจไม่กรองร้านได้)
      shop: params.shopName || params.shopId,
      history: params.history,
    }),
  });
  if (!resp.ok) throw new Error(`bot call failed: ${resp.status}`);
  const data = await resp.json();
  return {
    answer: data.answer || "",
    source: data.source,
    model: data.model,
    elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
    usage: data.usage,
    cost: typeof data.cost === "number" ? data.cost : undefined,
    products: data.products,
  };
}
