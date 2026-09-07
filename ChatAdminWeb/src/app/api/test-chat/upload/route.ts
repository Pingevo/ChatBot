// POST /api/test-chat/upload — อัปโหลดรูป/วิดีโอสำหรับ test chat
// รับ multipart/form-data field "file" → เก็บใน Mongo test_chat_uploads → คืน URL
// URL ที่คืนใช้ส่งให้ bot ผ่าน buffer/flush ได้ (bot ดึงผ่าน /api/test-chat/uploads/[id])
//
// ⚡ Phase 1F — ทำให้ test chat ส่งรูปจริงให้ bot ได้ (ไม่ใช่แค่ placeholder [รูปภาพ])
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { ObjectId } from "mongodb";

// ขนาดสูงสุด 20MB (รองรับวิดีโอสั้น)
const MAX_SIZE = 20 * 1024 * 1024;
// ประเภทไฟล์ที่อนุญาต
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
]);

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  // อ่าน multipart form
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return error("invalid form data", 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return error("file is required (multipart field 'file')", 422);
  }

  // ตรวจขนาด
  if (file.size > MAX_SIZE) {
    return error(`file too large (max ${MAX_SIZE / 1024 / 1024}MB)`, 413);
  }

  // ตรวจประเภท
  const contentType = file.type || "";
  if (!ALLOWED_TYPES.has(contentType)) {
    return error(`unsupported file type: ${contentType || "unknown"}`, 415);
  }

  // อ่านเป็น buffer
  const buf = Buffer.from(await file.arrayBuffer());

  // เก็บใน Mongo
  const coll = await getCollection(COLLECTIONS.testChatUploads);
  const doc = {
    _id: new ObjectId(),
    filename: file.name || "upload",
    contentType,
    size: buf.length,
    data: buf,
    uploaded_by: r.ctx.admin.admin_id,
    uploaded_at: new Date(),
  };
  await coll.insertOne(doc);

  // คืน URL สำหรับส่งให้ bot
  const uploadId = doc._id.toString();
  // URL สัมพันธ์กับ origin ของ admin — client จะแปลงเป็น absolute URL เอง
  // (bot ดึงผ่าน HTTP ได้จาก admin origin)
  return json({
    status: "ok",
    upload_id: uploadId,
    url: `/api/test-chat/uploads/${uploadId}`,
    content_type: contentType,
    size: buf.length,
    filename: file.name,
  });
}
