// LLM runtime config — key pool + models ที่ Python bot อ่านเอง (TTL ~10s)
// เก็บใน system_configs doc { config_key: "llm_config" }
// keys เข้ารหัส AES-256-GCM ก่อนลง DB (format enc:v1:iv:tag:ct hex) — master key จาก env
// LLM_MASTER_KEY (64-hex หรือ passphrase→sha256) — bot ถอดด้วย key เดียวกัน
// ไม่มี master key → เก็บ plaintext เหมือนเดิม (backward compat)
// key entry: {name, value, enabled} — enabled=false = อยู่ใน list แต่ bot ไม่หยิบไปหมุน
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "crypto";
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
export type KeySource = "env" | "db" | "single";
export type Provider = "gemini" | "openrouter";

export const KEY_POOL_FIELD: Record<KeyPool, "keys" | "openrouter_keys"> = {
  gemini: "keys",
  openrouter: "openrouter_keys",
};
export const KEY_POOL_ENV: Record<KeyPool, string> = {
  gemini: "GEMINI_API_KEY_1..n / GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export interface LlmConfigDoc {
  config_key: string;
  keys: (string | KeyEntry)[];            // gemini pool — string = legacy shape
  openrouter_keys?: (string | KeyEntry)[]; // openrouter pool (web_search fallback)
  /** แหล่ง key ต่อ pool: env = .env เท่านั้น · db = list ในเอกสารนี้ · single = single_keys[pool] */
  key_source?: Partial<Record<KeyPool, KeySource>>;
  /** key เดี่ยวเก็บบน mongo (plaintext — bot ต้องใช้จริง) ใช้เมื่อ source="single" */
  single_keys?: Partial<Record<KeyPool, string>>;
  /** provider ต่อ role — "openrouter" = route ผ่าน OpenRouter ด้วย model เดิม (google/...) */
  providers?: Partial<Record<ModelRole, Provider>>;
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

/* ---- AES-256-GCM at-rest encryption (enc:v1:iv:tag:ct hex) ---- */

const _ENC_PREFIX = "enc:v1:";

function _masterKey(): Buffer | null {
  const raw = (process.env.LLM_MASTER_KEY || "").trim();
  if (!raw) return null;
  return /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : createHash("sha256").update(raw).digest();
}

/** encrypt → enc:v1:... — ไม่มี master key → คืน plaintext เดิม */
function encSecret(v: string): string {
  const key = _masterKey();
  if (!key) return v;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(v, "utf8"), c.final()]);
  return `${_ENC_PREFIX}${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

/** decrypt enc:v1:... → plaintext — plaintext เดิมคืนตรงๆ, ถอดไม่ได้ (no key/bad data) → "" */
function decSecret(v: string): string {
  if (!v.startsWith(_ENC_PREFIX)) return v;
  const key = _masterKey();
  if (!key) return "";
  try {
    const [iv, tag, ct] = v.slice(_ENC_PREFIX.length).split(":").map((h) => Buffer.from(h, "hex"));
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

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
  key_source: Record<KeyPool, KeySource>;
  single_keys: Record<KeyPool, { sha256: string; tail: string } | null>;
  providers: Partial<Record<ModelRole, Provider>>;
  models: Partial<Record<ModelRole, string>>;
  model_roles: string[]; // registry + role เพิ่มเติมที่มีใน doc (future role ขึ้นอัตโนมัติ)
  updated_by?: string;
  updated_at?: Date;
}> {
  const doc = await getLlmConfig();
  const maskList = (list: (string | KeyEntry)[] | undefined, prefix: string): MaskedKey[] =>
    normKeys(list, prefix).map((k, i) => {
      const plain = decSecret(k.value); // fingerprint คำนวณจาก key จริงเสมอ (คู่ bot log)
      return {
        index: i + 1,
        sha256: plain ? sha8(plain) : "enc-only",
        tail: plain ? plain.slice(-4) : "????",
        name: k.name,
        enabled: k.enabled,
      };
    });
  const maskSingle = (v: string | undefined) => {
    const p = v?.trim() ? decSecret(v.trim()) : "";
    return p ? { sha256: sha8(p), tail: p.slice(-4) } : null;
  };
  const roles = [...new Set([
    ...MODEL_ROLES,
    ...Object.keys(doc.models ?? {}),
    ...Object.keys(doc.providers ?? {}),
  ])];
  return {
    keys: maskList(doc.keys, "GEMINI_API_KEY"),
    openrouter_keys: maskList(doc.openrouter_keys, "OPENROUTER_API_KEY"),
    key_source: {
      gemini: doc.key_source?.gemini ?? "db",
      openrouter: doc.key_source?.openrouter ?? "db",
    },
    single_keys: {
      gemini: maskSingle(doc.single_keys?.gemini),
      openrouter: maskSingle(doc.single_keys?.openrouter),
    },
    providers: doc.providers ?? {},
    models: doc.models ?? {},
    model_roles: roles,
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
    set_source?: { pool: KeyPool; source: KeySource };
    set_single?: { pool: KeyPool; value: string };
    providers?: Partial<Record<string, Provider>>;
    set_all_providers?: Provider;
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
    // ทำงานบน plaintext เสมอ — เขียนกลับด้วย encSecret (migrate plaintext เก่าเป็น enc อัตโนมัติ)
    let keys = normKeys(doc[poolField], namePrefix).map((k) => ({
      ...k, value: decSecret(k.value),
    })).filter((k) => k.value);
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
    $set[poolField] = keys.map((k) => ({ ...k, value: encSecret(k.value) }));
  }

  // ---- key source (env | db | single) ----
  if (updates.set_source !== undefined) {
    const { pool, source } = updates.set_source;
    if (KEY_POOL_FIELD[pool] && ["env", "db", "single"].includes(source)) {
      $set[`key_source.${pool}`] = source;
    }
  }

  // ---- single key (encrypt ก่อนลง DB — mask ตอน GET) ----
  if (updates.set_single !== undefined) {
    const { pool, value } = updates.set_single;
    if (KEY_POOL_FIELD[pool] && typeof value === "string") {
      const v = value.trim();
      $set[`single_keys.${pool}`] = v ? encSecret(v) : null;
    }
  }

  // ---- providers per role ----
  if (updates.set_all_providers !== undefined) {
    if (["gemini", "openrouter"].includes(updates.set_all_providers)) {
      for (const role of MODEL_ROLES) {
        if (role === "openrouter_search") continue; // role นี้เป็น openrouter อยู่แล้ว
        $set[`providers.${role}`] = updates.set_all_providers;
      }
    }
  }
  if (updates.providers !== undefined) {
    for (const [role, p] of Object.entries(updates.providers)) {
      if (role === "openrouter_search") continue;
      if (p === "gemini" || p === "openrouter") $set[`providers.${role}`] = p;
      else if (!p) $set[`providers.${role}`] = "gemini"; // null/"" = กลับ default
    }
  }

  if (updates.models !== undefined) {
    const models: Partial<Record<ModelRole, string>> = { ...(doc.models ?? {}) };
    // รับ role ที่รู้จัก + role ใหม่ที่ client ส่งมา (future roles ขึ้นอัตโนมัติ)
    for (const [role, mRaw] of Object.entries(updates.models)) {
      if (typeof mRaw !== "string") continue;
      let m = mRaw.trim();
      // openrouter_search ต้องลงท้าย :online เสมอ (OpenRouter web-search plugin)
      if (role === "openrouter_search" && m && !m.endsWith(":online")) m += ":online";
      models[role as ModelRole] = m;
    }
    $set.models = models;
  }
  await coll.updateOne({ config_key: CONFIG_KEY }, { $set }, { upsert: true });
}

/* ------------------------------------------------------------------ */
/* Live model lists — ดึงจาก provider API จริง, cache 10 นาที          */
/* ------------------------------------------------------------------ */

const GEMINI_MODELS_FALLBACK = [
  "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.5-pro",
  "gemini-3.1-flash-lite", "gemini-3.1-flash", "gemini-3.1-pro",
  "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash",
];
const OPENROUTER_MODELS_FALLBACK = [
  "google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash", "google/gemini-2.0-flash-001",
  "openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.5",
];

let _modelsCache: { gemini: string[]; openrouter: string[]; live: boolean; ts: number } | null = null;
const _MODELS_TTL = 10 * 60_000;

/** หา key สำหรับเรียก provider list API — doc first (enabled) → env ของ web process */
async function _anyKey(pool: KeyPool, envNames: string[]): Promise<string> {
  try {
    const doc = await getLlmConfig();
    const k = decSecret(normKeys(doc[KEY_POOL_FIELD[pool]]).find((x) => x.enabled)?.value ?? "");
    if (k) return k;
  } catch { /* fallthrough */ }
  for (const n of envNames) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return "";
}

export async function getAvailableModels(): Promise<{
  gemini: string[]; openrouter: string[]; live: boolean;
}> {
  if (_modelsCache && Date.now() - _modelsCache.ts < _MODELS_TTL) {
    const { ts, ...rest } = _modelsCache;
    return rest;
  }
  let gemini = GEMINI_MODELS_FALLBACK;
  let openrouter = OPENROUTER_MODELS_FALLBACK;
  let live = false;

  // Gemini — list models ที่ generateContent ได้ (ต้องมี key)
  try {
    const key = await _anyKey("gemini", [
      "GEMINI_API_KEY", ...Array.from({ length: 9 }, (_, i) => `GEMINI_API_KEY_${i + 1}`),
    ]);
    if (key) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (r.ok) {
        const data = await r.json();
        const ids = (data.models ?? [])
          .filter((m: { supportedGenerationMethods?: string[] }) =>
            m.supportedGenerationMethods?.includes("generateContent"))
          .map((m: { name: string }) => m.name.replace(/^models\//, ""))
          .filter((id: string) => id.startsWith("gemini"));
        if (ids.length) { gemini = ids; live = true; }
      }
    }
  } catch { /* fallback */ }

  // OpenRouter — public catalog
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const data = await r.json();
      const ids = (data.data ?? []).map((m: { id: string }) => m.id).filter(Boolean);
      if (ids.length) { openrouter = ids; live = true; }
    }
  } catch { /* fallback */ }

  _modelsCache = { gemini, openrouter, live, ts: Date.now() };
  return { gemini, openrouter, live };
}
