// chatAnnotationService — markup dot + note สำหรับแชทใน test-assignment + shadow-bot
//
// ⚡ Phase 3B-1 — สร้างใหม่
//
// Document shape (chat_annotations collection):
//   {
//     _id: ObjectId,
//     annotation_id: string,        // unique id (uuid-like)
//     scope: "test_assignment" | "shadow_bot",  // แยกตามหน้า
//     conversation_id: string,      // แชทที่ mark ไว้
//     color: string,                // รหัสสี เช่น "red", "yellow", "green", "blue", "purple"
//     note: string,                 // โน้ตข้อความ (เคสที่เจอ)
//     created_by: string,           // admin_id ของคนที่ mark
//     created_at: Date,
//     updated_at: Date,
//     generation_batch_id?: string, // ⚡ Phase 3B-6 — ผูกกับรอบ generate (shadow_bot) ต่างรอบต่าง mark
//   }
//
// Visibility: admin ทั่วไปเห็น annotation ทั้งหมด (ร่วมกัน) เพราะเป็นการแชร์เคสที่เจอ
//   superadmin/dev ก็เห็นทั้งหมดเหมือนกัน
//
// ⚡ Phase 3B-6 — สำหรับ scope="shadow_bot" ใช้ generation_batch_id แยก mark ตามรอบ generate
// ⚡ Phase 3B-7 — สำหรับ scope="test_assignment" ใช้ generation_batch_id เก็บ replay_batch_id แยก mark ตามรอบ replay
//   (field ชื่อเดียวกันเพื่อความเรียบง่าย — ความหมายต่างกันตาม scope)
import { ObjectId } from "mongodb";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

export type AnnotationScope = "test_assignment" | "shadow_bot";

export interface ChatAnnotationDoc {
  _id?: ObjectId;
  annotation_id: string;
  scope: AnnotationScope;
  conversation_id: string;
  color: string;
  note: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  // ⚡ Phase 3B-5 — soft delete
  deleted_at?: Date;
  deleted_by?: string;
  // ⚡ Phase 3B-6 — ผูกกับรอบ generate (ใช้กับ scope="shadow_bot" เท่านั้น)
  generation_batch_id?: string;
}

export interface ChatAnnotation {
  annotation_id: string;
  scope: AnnotationScope;
  conversation_id: string;
  color: string;
  note: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  // ⚡ Phase 3B-6
  generation_batch_id?: string;
}

function genId(): string {
  return `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toClient(doc: ChatAnnotationDoc): ChatAnnotation {
  return {
    annotation_id: doc.annotation_id,
    scope: doc.scope,
    conversation_id: doc.conversation_id,
    color: doc.color,
    note: doc.note,
    created_by: doc.created_by,
    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at.toISOString(),
    ...(doc.generation_batch_id ? { generation_batch_id: doc.generation_batch_id } : {}),
  };
}

/** ดึง annotations ทั้งหมดของ scope + conversation_ids ที่สนใจ (ไม่รวมที่ถูก soft delete)
 *  ⚡ Phase 3B-6 — รองรับ filter ตาม generation_batch_id (สำหรับ scope="shadow_bot") */
export async function listAnnotations(opts: {
  scope: AnnotationScope;
  conversationIds?: string[];
  generationBatchIds?: string[];  // ⚡ Phase 3B-6 — filter ตาม batch (shadow_bot)
}): Promise<ChatAnnotation[]> {
  const coll = await getCollection<ChatAnnotationDoc>(COLLECTIONS.chatAnnotations);
  const filter: Record<string, unknown> = { scope: opts.scope, deleted_at: { $exists: false } };
  if (opts.conversationIds && opts.conversationIds.length > 0) {
    filter.conversation_id = { $in: opts.conversationIds };
  }
  if (opts.generationBatchIds && opts.generationBatchIds.length > 0) {
    filter.generation_batch_id = { $in: opts.generationBatchIds };
  }
  const docs = await coll.find(filter).sort({ created_at: -1 }).limit(1000).toArray();
  return docs.map(toClient);
}

/** ดึง annotation เดียว */
export async function getAnnotation(annotationId: string): Promise<ChatAnnotation | null> {
  const coll = await getCollection<ChatAnnotationDoc>(COLLECTIONS.chatAnnotations);
  const doc = await coll.findOne({ annotation_id: annotationId });
  return doc ? toClient(doc) : null;
}

/** สร้างหรืออัปเดต annotation (upsert ตาม scope + conversation_id [+ generation_batch_id ถ้ามี])
 *  ⚡ Phase 3B-6 — ถ้าส่ง generationBatchId มา → upsert key รวม batch_id ด้วย (ต่างรอบต่าง mark) */
export async function upsertAnnotation(opts: {
  scope: AnnotationScope;
  conversationId: string;
  color: string;
  note: string;
  createdBy: string;
  generationBatchId?: string;  // ⚡ Phase 3B-6 — ผูกกับรอบ generate (shadow_bot)
}): Promise<ChatAnnotation> {
  const coll = await getCollection<ChatAnnotationDoc>(COLLECTIONS.chatAnnotations);
  const now = new Date();
  // ⚡ Phase 3B-6 — upsert key รวม generation_batch_id ถ้ามี (ต่างรอบ = คนละ annotation)
  const filter: Record<string, unknown> = { scope: opts.scope, conversation_id: opts.conversationId };
  if (opts.generationBatchId) {
    filter.generation_batch_id = opts.generationBatchId;
  } else {
    // ถ้าไม่ส่ง batch_id มา → match เฉพาะ annotation ที่ไม่มี batch_id (legacy/test_assignment)
    filter.generation_batch_id = { $exists: false };
  }
  const existing = await coll.findOne(filter);
  if (existing) {
    await coll.updateOne(filter, {
      $set: {
        color: opts.color,
        note: opts.note,
        updated_by: opts.createdBy,
        updated_at: now,
      },
      // ⚡ Phase 3B-5 — ถ้าเคยถูก soft delete แล้ว upsert ใหม่ → กู้คืน
      $unset: { deleted_at: "", deleted_by: "" },
    });
    const updated = await coll.findOne(filter);
    if (updated) return toClient(updated);
  }
  const doc: ChatAnnotationDoc = {
    annotation_id: genId(),
    scope: opts.scope,
    conversation_id: opts.conversationId,
    color: opts.color,
    note: opts.note,
    created_by: opts.createdBy,
    created_at: now,
    updated_at: now,
    ...(opts.generationBatchId ? { generation_batch_id: opts.generationBatchId } : {}),
  };
  await coll.insertOne(doc);
  return toClient(doc);
}

/** ⚡ Phase 3B-5 — Soft delete annotation (ไม่ hard delete — เก็บประวัติ) */
export async function deleteAnnotation(
  annotationId: string,
  deletedBy?: string
): Promise<boolean> {
  const coll = await getCollection<ChatAnnotationDoc>(COLLECTIONS.chatAnnotations);
  const r = await coll.updateOne(
    { annotation_id: annotationId, deleted_at: { $exists: false } },
    {
      $set: {
        deleted_at: new Date(),
        deleted_by: deletedBy || "system",
        updated_at: new Date(),
      },
    }
  );
  return r.modifiedCount > 0;
}

export const chatAnnotationService = {
  listAnnotations,
  getAnnotation,
  upsertAnnotation,
  deleteAnnotation,
};
