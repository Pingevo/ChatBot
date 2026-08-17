// Knowledge Base service — binds to the EXISTING `knowledge_base` collection
// (already has 1,039 real documents: product_spec entries imported from
// adminbase Excel files, plus general_faq policy entries). We extend this
// collection rather than creating a new one.
//
// Two document shapes (distinguished by `type`):
//   - "general_faq": rich-text policy/FAQ entries (topic, answer, ...)
//   - "product_spec": structured per-product spec entries (brand, model, ...)
import { Document, ObjectId } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "./conversationService";

export type KbType = "general_faq" | "product_spec";

export interface KbGeneralFaqDoc extends Document {
  _id?: ObjectId;
  type: "general_faq";
  topic: string;
  question_patterns?: string[];
  answer: string;
  applies_to_brands?: string[];
  applies_to_categories?: string[];
  platform?: Platform | "all"; // scope — new optional field, absent = all
  active: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string;
  version: number;
}

export interface KbProductSpecDoc extends Document {
  _id?: ObjectId;
  type: "product_spec";
  brand?: string;
  model?: string;
  category?: string;
  category_id?: string;
  highlights?: string;
  description?: string;
  box_contents?: string;
  warranty_period?: string;
  warranty_note?: string;
  notes?: string;
  weight?: string;
  dimensions?: string;
  specs?: Record<string, unknown>;
  extra_fields?: Record<string, unknown>;
  platform?: Platform | "all";
  source_file?: string;
  source_row?: number;
  source_sheet?: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string;
}

export async function listKbEntries(opts: {
  type?: KbType;
  search?: string;
  activeOnly?: boolean;
  limit?: number;
  skip?: number;
} = {}): Promise<Document[]> {
  const coll = await getCollection(COLLECTIONS.knowledgeBase);
  const filter: Record<string, unknown> = {};
  if (opts.type) filter.type = opts.type;
  if (opts.activeOnly) filter.active = { $ne: false };
  if (opts.search) {
    filter.$or = [
      { topic: { $regex: opts.search, $options: "i" } },
      { answer: { $regex: opts.search, $options: "i" } },
      { brand: { $regex: opts.search, $options: "i" } },
      { model: { $regex: opts.search, $options: "i" } },
    ];
  }
  return coll
    .find(filter)
    .sort({ updated_at: -1 })
    .skip(opts.skip || 0)
    .limit(opts.limit || 50)
    .toArray();
}

export async function countKbEntries(type?: KbType): Promise<number> {
  const coll = await getCollection(COLLECTIONS.knowledgeBase);
  return coll.countDocuments(type ? { type } : {});
}

export async function getKbEntry(id: string): Promise<Document | null> {
  const coll = await getCollection(COLLECTIONS.knowledgeBase);
  return coll.findOne({ _id: new ObjectId(id) });
}

export async function createGeneralFaq(opts: {
  topic: string;
  answer: string;
  questionPatterns?: string[];
  platform?: Platform | "all";
  createdBy: string;
}): Promise<KbGeneralFaqDoc> {
  const coll = await getCollection<KbGeneralFaqDoc>(COLLECTIONS.knowledgeBase);
  const now = new Date();
  const doc: KbGeneralFaqDoc = {
    type: "general_faq",
    topic: opts.topic,
    question_patterns: opts.questionPatterns || [],
    answer: opts.answer,
    applies_to_brands: [],
    applies_to_categories: [],
    platform: opts.platform || "all",
    active: true,
    created_at: now,
    updated_at: now,
    updated_by: opts.createdBy,
    version: 1,
  };
  const result = await coll.insertOne(doc);
  doc._id = result.insertedId;
  return doc;
}

export async function updateGeneralFaq(
  id: string,
  fields: Partial<Pick<KbGeneralFaqDoc, "topic" | "answer" | "question_patterns" | "platform">>,
  updatedBy: string
): Promise<boolean> {
  const coll = await getCollection<KbGeneralFaqDoc>(COLLECTIONS.knowledgeBase);
  const result = await coll.updateOne(
    { _id: new ObjectId(id), type: "general_faq" },
    { $set: { ...fields, updated_at: new Date(), updated_by: updatedBy }, $inc: { version: 1 } }
  );
  return result.modifiedCount > 0;
}

/** Upsert product_spec entries from parsed Excel rows (same shape as
 * scripts/import_adminbase.py). Matches by source_file + source_row so
 * re-uploading the same file updates rather than duplicates. */
export async function upsertProductSpecFromExcelRow(
  row: Partial<KbProductSpecDoc>,
  updatedBy: string
): Promise<void> {
  const coll = await getCollection<KbProductSpecDoc>(COLLECTIONS.knowledgeBase);
  const now = new Date();
  await coll.updateOne(
    { type: "product_spec", source_file: row.source_file, source_row: row.source_row },
    {
      $set: { ...row, type: "product_spec", updated_at: now, updated_by: updatedBy },
      $setOnInsert: { created_at: now, active: true },
    },
    { upsert: true }
  );
}

export async function toggleKbActive(id: string, active: boolean): Promise<boolean> {
  const coll = await getCollection(COLLECTIONS.knowledgeBase);
  const result = await coll.updateOne({ _id: new ObjectId(id) }, { $set: { active } });
  return result.modifiedCount > 0;
}

export async function deleteKbEntry(id: string): Promise<boolean> {
  const coll = await getCollection(COLLECTIONS.knowledgeBase);
  const result = await coll.deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount > 0;
}

export const knowledgeBaseService = {
  listKbEntries,
  countKbEntries,
  getKbEntry,
  createGeneralFaq,
  updateGeneralFaq,
  upsertProductSpecFromExcelRow,
  toggleKbActive,
  deleteKbEntry,
};
