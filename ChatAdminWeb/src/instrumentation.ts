// ⚡ instrumentation.ts — Next.js 16 file convention
//   register() ถูกเรียกครั้งเดียวตอน server instance เริ่ม ก่อนรับ request
//   ใช้สำหรับ ensure MongoDB indexes ที่โค้ดเรา define ไว้ใน ensureIndexes()
//   (ก่อนหน้านี้ ensureIndexes ไม่ถูกเรียกเลย → index ที่ define ไว้ไม่ถูกสร้าง)
export async function register() {
  // รันเฉพาะ Node.js runtime (ไม่ใช่ edge)
  if (process.env.NEXT_RUNTIME === "edge") return;
  try {
    const { ensureIndexes } = await import("./backend/db/mongoClient");
    await ensureIndexes();
    // eslint-disable-next-line no-console
    console.log("[instrumentation] MongoDB indexes ensured");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[instrumentation] ensureIndexes failed:", err);
  }
}
