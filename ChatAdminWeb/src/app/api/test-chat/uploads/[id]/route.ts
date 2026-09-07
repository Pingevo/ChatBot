// GET /api/test-chat/uploads/[id] — serve ไฟล์ที่อัปโหลดกลับ (สำหรับ bot ดึง URL)
// ⚡ Phase 1F — bot ดึงรูปจาก URL นี้ผ่าน HTTP (Part.from_bytes หลัง download)
import { NextRequest, NextResponse } from "next/server";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { ObjectId } from "mongodb";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id || !/^[a-f0-9]{24}$/i.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const coll = await getCollection(COLLECTIONS.testChatUploads);
    const doc = await coll.findOne({ _id: new ObjectId(id) });
    if (!doc) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // doc.data อาจเป็น Buffer หรือ BSON Binary — แปลงเป็น Buffer ก่อน
    const raw = doc.data as unknown;
    let buf: Buffer;
    if (Buffer.isBuffer(raw)) {
      buf = raw;
    } else if (raw instanceof Uint8Array) {
      buf = Buffer.from(raw);
    } else if (raw && typeof raw === "object" && "buffer" in (raw as Record<string, unknown>)) {
      // BSON Binary object — มี .buffer
      buf = Buffer.from((raw as { buffer: Uint8Array }).buffer);
    } else {
      buf = Buffer.from(raw as Uint8Array);
    }
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": (doc.contentType as string) || "application/octet-stream",
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[test-chat/uploads] error:", msg);
    return NextResponse.json({ error: "internal error", detail: msg }, { status: 500 });
  }
}
