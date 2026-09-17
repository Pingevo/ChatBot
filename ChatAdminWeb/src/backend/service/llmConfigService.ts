// LLM runtime config — key pool + models ที่ Python bot อ่านเอง (TTL ~10s)
// เก็บใน system_configs doc { config_key: "llm_config" }
// ⚠️ keys เก็บ plaintext ใน DB (bot ต้องใช้จริง) — GET คืน masked เท่านั้น
import { createHash } from "crypto";
import { getCollection, COLLECTIONS } from "../db/mongoClient";

const CONFIG_KEY = "llm_config";

export const MODEL_ROLES = ["chat", "vision", "intent", "openrouter_search"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface LlmConfigDoc {
  config_key: string;
  keys: string[];
  models: Partial<Record<ModelRole, string>>;
  updated_by?: string;
  updated_at?: Date;
}

export interface MaskedKey {
  index: number;
  sha256: string; // 8 hex — คู่กับ startup log ของ bot ([KEYS] key[i] = sha256:...)
  tail: string;   // 4 ตัวท้าย — ให้ dev ระบุได้ว่า key ไหน
}

function mask(k: string, index: number): MaskedKey {
  return {
    index,
    sha256: createHash("sha256").update(k).digest("hex").slice(0, 8),
    tail: k.slice(-4),
  };
}

export async function getLlmConfig(): Promise<LlmConfigDoc> {
  const coll = await getCollection<LlmConfigDoc>(COLLECTIONS.systemConfigs);
  const doc = await coll.findOne({ config_key: CONFIG_KEY });
  return doc ?? { config_key: CONFIG_KEY, keys: [], models: {} };
}

/** GET — masked keys เท่านั้น (ไม่ส่ง key จริงออก API) */
export async function getLlmConfigMasked(): Promise<{
  keys: MaskedKey[];
  models: Partial<Record<ModelRole, string>>;
  updated_by?: string;
  updated_at?: Date;
}> {
  const doc = await getLlmConfig();
  return {
    keys: doc.keys.map(mask),
    models: doc.models ?? {},
    updated_by: doc.updated_by,
    updated_at: doc.updated_at,
  };
}

/**
 * PUT — ops-based: add_keys / remove_sha256 / models (merge per role)
 * key จริงไม่เคยออก API — ลบด้วย sha256 prefix
 * models: เฉพาะ role ที่รู้จัก, string ไม่ว่าง
 */
export async function updateLlmConfig(
  updates: {
    add_keys?: string[];
    remove_sha256?: string[];
    models?: Partial<Record<ModelRole, string>>;
  },
  updatedBy: string
): Promise<void> {
  const coll = await getCollection<LlmConfigDoc>(COLLECTIONS.systemConfigs);
  const doc = await getLlmConfig();
  const $set: Record<string, unknown> = {
    updated_by: updatedBy,
    updated_at: new Date(),
  };
  if (updates.add_keys !== undefined || updates.remove_sha256 !== undefined) {
    const removeSet = new Set(updates.remove_sha256 ?? []);
    let keys = doc.keys.filter(
      (k) => !removeSet.has(createHash("sha256").update(k).digest("hex").slice(0, 8))
    );
    const added = (updates.add_keys ?? [])
      .filter((k): k is string => typeof k === "string" && k.trim().length > 10)
      .map((k) => k.trim());
    keys = [...new Set([...keys, ...added])];
    $set.keys = keys;
  }
  if (updates.models !== undefined) {
    const models: Partial<Record<ModelRole, string>> = { ...(doc.models ?? {}) };
    for (const role of MODEL_ROLES) {
      const m = updates.models[role];
      if (typeof m === "string") models[role] = m.trim(); // ว่าง = ลบ override → env fallback
    }
    $set.models = models;
  }
  await coll.updateOne({ config_key: CONFIG_KEY }, { $set }, { upsert: true });
}
