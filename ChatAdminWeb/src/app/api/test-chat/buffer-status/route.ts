// GET /api/test-chat/buffer-status?session_id=xxx
// คืน: { buffer_enabled, buffer_window_ms, buffer_max_messages, buffered_count, buffered_messages }
//
// ใช้สำหรับ:
//   - ตอนเปิดหน้า test chat → เช็คว่า buffer เปิดอยู่ไหม + window_ms เท่าไหร่
//   - ตอนกำลัง buffer → เช็คว่ามี messages ค้างกี่ข้อความ
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { getSystemConfig } from "@/backend/service/systemConfigService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");

  // อ่าน buffer config จาก system config
  const sysConfig = await getSystemConfig();

  // ถ้าไม่มี session_id → คืนแค่ config
  if (!sessionId) {
    return json({
      buffer_enabled: sysConfig.bot_buffer_enabled,
      buffer_window_ms: sysConfig.bot_buffer_window_ms,
      buffer_max_messages: sysConfig.bot_buffer_max_messages,
    });
  }

  // มี session_id → คืน config + buffered messages
  const coll = await getCollection(COLLECTIONS.bufferMessages);
  const buffered = await coll
    .find({ conversation_id: sessionId })
    .sort({ received_at: 1 })
    .toArray();

  return json({
    buffer_enabled: sysConfig.bot_buffer_enabled,
    buffer_window_ms: sysConfig.bot_buffer_window_ms,
    buffer_max_messages: sysConfig.bot_buffer_max_messages,
    buffered_count: buffered.length,
    should_flush: buffered.length >= sysConfig.bot_buffer_max_messages,
    buffered_messages: buffered.map((m) => ({
      message_id: m.message_id,
      text: m.text,
      received_at: m.received_at,
    })),
  });
}
