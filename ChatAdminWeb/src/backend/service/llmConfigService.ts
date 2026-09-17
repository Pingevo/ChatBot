// LLM runtime config — key pool + models ที่ Python bot อ่านเอง (TTL ~10s)
// เก็บใน system_configs doc { config_key: "llm_config" }
// ⚠️ keys เก็บ plaintext ใน DB (bot ต้องใช้จริง) — GET คืน masked เท่านั้น
// key entry: {name, value, enabled} — enabled=false = อยู่ใน list แต่ bot ไม่หยิบไปหมุน
import { createHash } from "crypto";
import { getCollection, COLLECTIONS } from "../db/mongoClient";

const CONFIG_KEY = "llm_config";

export const MODEL_ROLES = ["chat", "vision", "intent", "openrouter_search"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface KeyEntry {
  name: string;
  value: string;
  enabled: boolean;
}

export type KeyPool = "gemini" | "openrouter";

export const KEY_POOL_FIELD: Record<KeyPool, "keys" | "openrouter_keys"> = {
  gemini: "keys",
  openrouter: "openrouter_keys",
};

export interface LlmConfigDoc {
  config_key: string;
  keys: (string | KeyEntry)[];            // gemini pool — string = legacy shape
  openrouter_keys?: (string | KeyEntry)[]; // openrouter pool (web_search fallback)
  models: Partial<Record<ModelRole, string>>;
  updated_by?: string;
  updated_at?: Date;
}

export interface MaskedKey {
  index: number;
  sha256: string; // 8 hex — คู่กับ startup log ของ bot ([KEYS] key[i] = sha256:...)
  tail: string;   // 4 ตัวท้าย — ให้ dev ระบุได้ว่า key ไหน
  name: string;
  enabled: boolean;
}

const sha8 = (v: string) =>
  createHash("sha256").update(v).digest("hex").slice(0, 8);

/** legacy string keys → KeyEntry (name อัตโนมัติ {PREFIX}_n, enabled) */
export function normKeys(
  keys: (string | KeyEntry)[] | undefined,
  prefix = "GEMINI_API_KEY"
): KeyEntry[] {
  return (keys ?? []).flatMap((k, i) => {
    if (typeof k === "string") {
      const v = k.trim();
      return v ? [{ name: `${prefix}_${i + 1}`, value: v, enabled: true }] : [];
    }
    if (k && typeof k === "object" && typeof k.value === "string" && k.value.trim()) {
      return [{
        name: String(k.name || `${prefix}_${i + 1}`).slice(0, 60),
        value: k.value.trim(),
        enabled: k.enabled !== false,
      }];
    }
    return [];
  });
}

export async function getLlmConfig(): Promise<LlmConfigDoc> {
  const coll = await getCollection<LlmConfigDoc>(COLLECTIONS.systemConfigs);
  const doc = await coll.findOne({ config_key: CONFIG_KEY });
  return doc ?? { config_key: CONFIG_KEY, keys: [], models: {} };
}

/** GET — masked keys เท่านั้น (ไม่ส่ง key จริงออก API) */
export async function getLlmConfigMasked(): Promise<{
  keys: MaskedKey[];
  openrouter_keys: MaskedKey[];
  models: Partial<Record<ModelRole, string>>;
  updated_by?: string;
  updated_at?: Date;
}> {
  const doc = await getLlmConfig();
  const maskList = (list: (string | KeyEntry)[] | undefined, prefix: string): MaskedKey[] =>
    normKeys(list, prefix).map((k, i) => ({
      index: i + 1,
      sha256: sha8(k.value),
      tail: k.value.slice(-4),
      name: k.name,
      enabled: k.enabled,
    }));
  return {
    keys: maskList(doc.keys, "GEMINI_API_KEY"),
    openrouter_keys: maskList(doc.openrouter_keys, "OPENROUTER_API_KEY"),
    models: doc.models ?? {},
    updated_by: doc.updated_by,
    updated_at: doc.updated_at,
  };
}

/**
 * PUT — ops-based (key จริงไม่เคยออก API — อ้างด้วย sha256 prefix):
 *   add_keys:     (string | {name?, value})[]
 *   remove_sha256: string[]
 *   set_enabled:  {sha256, enabled}[]
 *   rename:       {sha256, name}[]
 *   models:       merge per role (string ว่าง = ลบ override → env fallback)
 */
export async function updateLlmConfig(
  updates: {
    pool?: KeyPool; // "gemini" (default) | "openrouter"
    add_keys?: (string | { name?: string; value?: string })[];
    remove_sha256?: string[];
    set_enabled?: { sha256: string; enabled: boolean }[];
    rename?: { sha256: string; name: string }[];
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

  const poolField = KEY_POOL_FIELD[updates.pool ?? "gemini"];
  const namePrefix = updates.pool === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY";
  const touchesKeys =
    updates.add_keys !== undefined || updates.remove_sha256 !== undefined ||
    updates.set_enabled !== undefined || updates.rename !== undefined;
  if (touchesKeys) {
    let keys = normKeys(doc[poolField], namePrefix);
    const removeSet = new Set(updates.remove_sha256 ?? []);
    if (removeSet.size) keys = keys.filter((k) => !removeSet.has(sha8(k.value)));

    for (const op of updates.set_enabled ?? []) {
      const k = keys.find((k) => sha8(k.value) === op.sha256);
      if (k) k.enabled = op.enabled === true;
    }
    for (const op of updates.rename ?? []) {
      const k = keys.find((k) => sha8(k.value) === op.sha256);
      if (k && typeof op.name === "string" && op.name.trim())
        k.name = op.name.trim().slice(0, 60);
    }

    for (const raw of updates.add_keys ?? []) {
      const value = typeof raw === "string" ? raw.trim() : String(raw?.value ?? "").trim();
      if (value.length <= 10) continue;
      if (keys.some((k) => k.value === value)) continue; // กัน key ซ้ำ
      const name =
        (typeof raw === "object" ? String(raw?.name ?? "").trim() : "") ||
        `${namePrefix}_${keys.length + 1}`;
      keys.push({ name: name.slice(0, 60), value, enabled: true });
    }
    $set[poolField] = keys;
  }

  if (updates.models !== undefined) {
    const models: Partial<Record<ModelRole, string>> = { ...(doc.models ?? {}) };
    for (const role of MODEL_ROLES) {
      const m = updates.models[role];
      if (typeof m === "string") models[role] = m.trim();
    }
    $set.models = models;
  }
  await coll.updateOne({ config_key: CONFIG_KEY }, { $set }, { upsert: true });
}
