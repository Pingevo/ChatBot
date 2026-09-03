// GET /api/labels — list labels ที่มีในระบบ (สำหรับ TagPicker ใน workflow)
//
// ในตอนนี้ระบบยังไม่มี label master collection → distinct จาก conversations.labels
// ในอนาคตถ้าสร้าง labels collection แล้ว ให้เปลี่ยนไปอ่านจาก collection นั้นแทน
//
// ⚠️ อ่านอย่างเดียว ไม่เขียนอะไร
// Auth: requireAuth (ทุก role ดูได้)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  try {
    const coll = await getCollection<{ labels?: string[] }>(COLLECTIONS.conversations);

    // distinct ค่า labels จากทุก conversation — ใช้ MongoDB distinct command
    const labels = await coll.distinct("labels", {});

    // filter + sort
    const cleanLabels = (labels as unknown[])
      .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
      .map((l) => l.trim())
      .filter((l, idx, arr) => arr.indexOf(l) === idx) // dedupe
      .sort((a, b) => a.localeCompare(b, "th"));

    return json({ labels: cleanLabels });
  } catch (err) {
    return json({ error: "Failed to fetch labels", detail: (err as Error).message }, 500);
  }
}
