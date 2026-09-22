// _shared.ts — helpers ร่วมสำหรับ botworker sandbox routes
// ⚡ parallel sandbox — ทุก route ภายใต้ /api/botworker เขียน test_status_conversation
//   (source="botworker") + botworker_messages + botworker_events เท่านั้น
//   ห้ามเขียน status_conversation / conversations / messages_shp / admin_logs จริง
import { testStatusConversationService, type TestStatusConversationDoc } from "@/backend/service/testStatusConversationService";

export const BW_SOURCE = "botworker" as const;

/** invalidate in-memory cache ของ GET /api/botworker/conversations (dynamic import กัน circular dep) */
export async function invalidateBotworkerCache() {
  try {
    const mod = await import("@/app/api/botworker/conversations/route");
    if (typeof (mod as unknown as { invalidateBotworkerCache?: () => void }).invalidateBotworkerCache === "function") {
      (mod as unknown as { invalidateBotworkerCache: () => void }).invalidateBotworkerCache();
    }
  } catch { /* ignore */ }
}

/** ดึง test doc ของ conversation ใน botworker sandbox (อาจไม่มี → undefined) */
export async function getBwMeta(conversationId: string): Promise<TestStatusConversationDoc | null> {
  return testStatusConversationService.getTestStatus(conversationId, BW_SOURCE);
}
