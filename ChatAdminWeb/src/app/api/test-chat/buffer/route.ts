// POST /api/test-chat/buffer — เพิ่ม message เข้า buffer_messages (สำหรับ test chat)
// body: { session_id, message, shop, platform }
// คืน: { status: "buffered", buffered_count, buffer_config }
//
// ⚠️ ไม่ได้ส่งให้ bot ทันที — client ต้องเรียก /api/test-chat/flush เพื่อ flush
// (เหมือนลูกค้าจริงที่ข้อความเข้า buffer ก่อน แล้ว bot worker ถึง flush)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { getSystemConfig } from "@/backend/service/systemConfigService";
import type { Platform } from "@/backend/service/systemConfigService";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    session_id?: string;
    message?: string;
    shop?: string;
    platform?: string;
  }>(req);

  if (!body?.session_id) return error("session_id is required", 422);
  if (!body?.message?.trim()) return error("message is required", 422);

  const sessionId = String(body.session_id);
  const message = String(body.message);
  const shop = body.shop ? String(body.shop) : "";
  const platform: Platform = (String(body.platform || "shopee") as Platform);

  // อ่าน buffer config จาก system config
  const sysConfig = await getSystemConfig();
  if (!sysConfig.bot_buffer_enabled) {
    // ถ้าปิด buffer → บอก client ให้ส่งตรงไป bot เลย
    return json({
      status: "buffer_disabled",
      buffer_config: {
        enabled: false,
        window_ms: sysConfig.bot_buffer_window_ms,
        max_messages: sysConfig.bot_buffer_max_messages,
      },
    });
  }

  // สร้าง message_id สำหรับ test chat buffer
  const messageId = `testbuf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // insert ลง buffer_messages (ใช้ session_id เป็น conversation_id)
  const coll = await getCollection(COLLECTIONS.bufferMessages);
  await coll.insertOne({
    message_id: messageId,
    conversation_id: sessionId,
    shop_id: shop,
    platform,
    text: message,
    raw_payload: { source: "test_chat", session_id: sessionId },
    received_at: new Date(),
  });

  // นับจำนวน messages ใน buffer ของ session นี้
  const buffered = await coll.find({ conversation_id: sessionId }).sort({ received_at: 1 }).toArray();

  // ถ้าครบ max → บอก client ให้ flush ทันที
  const shouldFlush = buffered.length >= sysConfig.bot_buffer_max_messages;

  return json({
    status: shouldFlush ? "buffer_full" : "buffered",
    buffered_count: buffered.length,
    should_flush: shouldFlush,
    buffer_config: {
      enabled: true,
      window_ms: sysConfig.bot_buffer_window_ms,
      max_messages: sysConfig.bot_buffer_max_messages,
    },
    message_id: messageId,
  });
}
