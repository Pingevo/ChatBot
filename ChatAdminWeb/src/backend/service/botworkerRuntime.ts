// Botworker runtime constants — claim coordinator boundary
//
// ค่าเหล่านี้เป็น internal production constants — ไม่ใช่ SystemConfig/UI/env
// เหตุผล: lease/heartbeat/timeout คือ correctness invariant ของ claim protocol
// ไม่ใช่ tuning knob ที่ admin ควรปรับ (ปรับผิด = duplicate processing)
//
// Guarantee: single concurrent owner + crash recovery + exactly-one persisted reply
// (ไม่สัญญา exactly-once LLM call — process ตายหลัง remote รับ request
//  ก่อน local persist → reclaimer อาจยิงซ้ำใน crash window เท่านั้น)
import { createHash, randomUUID } from "node:crypto";
import { BOTWORKER_BACKENDS, type Platform } from "../lib/safety";
import type { SystemConfigDoc } from "./systemConfigService";
import { getCollection, COLLECTIONS } from "../db/mongoClient";

// ─── Phase 2D — platform/shop admission scope (fail-closed) ──
// eligible ⟺ global bot_worker_enabled AND platform enabled AND exact
//   (platform, shop_id) shop.bot_worker_enabled — snapshot เดียวต่อ cycle/pass:
//   resolve 1 ครั้งที่ caller → ส่งลงทุก bot-invoking entry (required, ไม่มี fallback)
//
// ⚡ Shop Context — pair = shop entity เดียว แบก identity ทั้งสาม domain:
//   shop_id          = transportShopId — messages/conversations/claims/buffer/
//                      shadow_replies domain (platform-issued id เสมอ)
//   config_shop_key  = shops.shop_id ของ admin — domain ของ workflow/trigger/
//                      assignment config records (อาจเป็น name-fallback เก่า)
//   shopname         = catalog key — Python /chat `shop`, persona/settings domain
//   resolveBotworkerScope แมพ row→transport ผ่าน conversations evidence เท่านั้น
//   (canonical id หรือ (platform,shopname)→id แบบ 1:1; missing/ambiguous → ตัดทิ้ง)
export interface BotworkerScopePair {
  platform: string;
  shop_id: string;
  config_shop_key: string;
  shopname: string;
  // ⚡ effective enable cutoff = max(global edge, platform_enabled_at, shop_enabled_at)
  //   — resolver คำนวณครั้งเดียว; ทุก admission ใช้ค่านี้ (strict >)
  cutoff: Date;
}

// ⚡ context ที่ไหลผ่าน poll → buffer → claim → dispatcher — attach ที่ msg envelope;
//   REQUIRED ทั้งสอง field — caller ที่ขาด ctx = contract violation (fail closed)
export interface ShopMessageContext {
  config_shop_key: string;
  shopname: string; // ⚡ required — shops row owns it; ไม่มี name = resolve context ไม่ได้ → row ถูกตัดใน resolver
}

export interface BotworkerCycleScope {
  config: SystemConfigDoc;
  pairs: BotworkerScopePair[];
  // in-memory global enable edge — worker owner เดียว (bot-worker.ts) ส่งเข้ามา;
  //   เปิดครั้งแรก/เปิดใหม่ตลอด = edge ใหม่ → cutoff ใหม่ → งานเก่าไม่เข้า
  global_enabled_since: Date | null;
}

/**
 * scope → Mongo filter (pair-exact, grouped ต่อ platform)
 *   pairs ว่าง/platform ไม่มี backend → deny-all `{shop_id:{$in:[]}}` — valid Mongo
 *   match 0 เสมอ; ห้ามคืน null (caller เผลอ omit filter = unscoped query)
 *
 * tsField — ชื่อ timestamp field ของ collection นั้น (เช่น created_timestamp/
 *   received_at/claimed_at/wait_started_at): filter กลายเป็น per-pair
 *   {platform, shop_id, [tsField]:{$gt:pair.cutoff}} — admission cutoff อยู่ใน
 *   owner เดียวกัน ไม่ใช่ guard แยกแต่ละ path
 */
export function buildScopeFilter(pairs: BotworkerScopePair[], tsField?: string): Record<string, unknown> {
  const byPlatform = new Map<string, BotworkerScopePair[]>();
  for (const p of pairs) {
    if (!(BOTWORKER_BACKENDS as readonly string[]).includes(p.platform)) continue;
    const arr = byPlatform.get(p.platform) ?? [];
    arr.push(p);
    byPlatform.set(p.platform, arr);
  }
  if (byPlatform.size === 0) return { shop_id: { $in: [] } };
  const ors: Record<string, unknown>[] = [];
  for (const [platform, ps] of byPlatform) {
    if (tsField) for (const p of ps) ors.push({ platform, shop_id: p.shop_id, [tsField]: { $gt: p.cutoff } });
    else ors.push({ platform, shop_id: { $in: ps.map((p) => p.shop_id) } });
  }
  return { $or: ors };
}

/**
 * ผนวก scope เข้า query เดิมแบบไม่ทับ operator — {$and:[base, scopeFilter]}
 *   base ที่มี $or/$and/เงื่อนไขเดิมคงรูปทั้งหมด (ห้าม object-spread merge)
 */
export function withScope(base: Record<string, unknown>, scope: BotworkerCycleScope, tsField?: string): Record<string, unknown> {
  return { $and: [base, buildScopeFilter(scope.pairs, tsField)] };
}

/**
 * scope resolver owner เดียว — อ่าน config+shops+conv evidence 1 ครั้ง → snapshot
 *   pairs ที่ใช้ได้ทั้ง cycle (poll/recovery) และ delayed-execution boundary (flush):
 *   eligible ⟺ global ON ∧ platform ON(มี edge) ∧ shop ON(มี edge);
 *   pair.cutoff = max(global edge, platform_enabled_at, shop_enabled_at) — strict >
 *   switch ON แต่ timestamp ขาด → fail-closed (ไม่ใส่ pair)
 *
 * ⚡ transport resolution — shops.shop_id เก่าอาจเป็น name-fallback (sync writer bug):
 *   1. row.shop_id มีอยู่ใน conv transport ids ของ platform นั้น → canonical (ใช้ตรง)
 *   2. else (platform, row.shopname) map → transport id เดียว → ใช้ id นั้น
 *   3. missing / multi-id → exclude row (fail-closed — ไม่เดา ไม่เขียนกลับ)
 *   4. row ไม่มี shopname → exclude (mandatory ctx contract — /chat ต้องการ catalog key)
 *   evidence = conversations (distinct platform|shop_id|shop_name) — 1 aggregate/resolve,
 *   $match bounded ด้วย enabled-shop identities เท่านั้น (0 enabled rows → 0 conv query)
 */
export async function resolveBotworkerScope(
  config: SystemConfigDoc,
  globalEnabledSince: Date | null
): Promise<BotworkerCycleScope> {
  const empty: BotworkerCycleScope = { config, pairs: [], global_enabled_since: globalEnabledSince };
  if (config.bot_worker_enabled !== true || !(globalEnabledSince instanceof Date)) return empty;
  const platformAt = config.bot_worker_platform_enabled_at ?? {};
  const enabled = BOTWORKER_BACKENDS.filter(
    (p) => config.bot_worker_platforms?.[p] === true && platformAt[p] instanceof Date
  );
  if (!enabled.length) return empty;
  const shopsColl = await getCollection<{
    platform: Platform; shop_id: string; shopname?: string;
    bot_worker_enabled?: boolean; bot_worker_enabled_at?: Date | null;
  }>(COLLECTIONS.shops);
  const rows = await shopsColl.find(
    { platform: { $in: enabled.slice() }, bot_worker_enabled: true },
    { projection: { platform: 1, shop_id: 1, shopname: 1, bot_worker_enabled_at: 1 } }
  ).toArray();
  // ⚡ ไม่มี enabled row → scope ว่างโดยไม่แตะ conversations (mapping query เดียว/pass)
  if (!rows.length) return empty;
  // ⚡ bounded $match — conversations evidence เฉพาะ identity ของ enabled rows เท่านั้น
  //   (ห้าม platform-wide scan): canonical candidates ใช้ {platform,shop_id} compound
  //   index; name candidates ใช้ partial index {platform,shop_name,shop_id} ที่ declare
  //   ใน mongoClient.ts — ⚠️ production creation/verify = operator approval gate
  //   แยกต่างหาก (declaration = code เท่านั้น)
  const matchOr: Record<string, unknown>[] = [];
  for (const p of enabled) {
    const ids = [...new Set(rows.filter((r) => r.platform === p).map((r) => r.shop_id))];
    const names = [...new Set(rows
      .filter((r) => r.platform === p && typeof r.shopname === "string" && r.shopname)
      .map((r) => r.shopname as string))];
    if (ids.length) matchOr.push({ platform: p, shop_id: { $in: ids } });
    // ⚡ eq term ต่อ name (ไม่ใช่ $in) — partial index {platform,shop_name,shop_id}
    //   ใช้ได้เฉพาะเมื่อ query prove `shop_name > ""` ได้; eq บนค่าคงที่ imply ได้
    //   แต่ $in อาจไม่ (planner ไม่ prove implication) — shape นี้ index-compatible
    for (const n of names) matchOr.push({ platform: p, shop_name: n });
  }
  if (!matchOr.length) return empty;
  const convColl = await getCollection<{
    platform?: string; shop_id?: string; shop_name?: string;
  }>(COLLECTIONS.conversations);
  const groups = await convColl.aggregate<{ _id: { p?: unknown; id?: unknown; n?: unknown } }>([
    { $match: { $or: matchOr } },
    { $group: { _id: { p: "$platform", id: "$shop_id", n: "$shop_name" } } },
  ]).toArray();
  const idsByPlatform = new Map<string, Set<string>>();
  const idsByName = new Map<string, Set<string>>();
  for (const g of groups) {
    const p = g._id?.p; const id = g._id?.id; const n = g._id?.n;
    if (typeof p !== "string" || typeof id !== "string" || !id) continue;
    let ids = idsByPlatform.get(p);
    if (!ids) idsByPlatform.set(p, (ids = new Set()));
    ids.add(id);
    if (typeof n === "string" && n) {
      const key = `${p}|${n}`;
      let s = idsByName.get(key);
      if (!s) idsByName.set(key, (s = new Set()));
      s.add(id);
    }
  }
  const pairs: BotworkerScopePair[] = [];
  for (const r of rows) {
    if (!(r.bot_worker_enabled_at instanceof Date)) continue;
    // ⚡ mandatory context — row ไม่มี shopname = catalog key ขาด → /chat routing
    //   ทำไม่ได้ → ตัดทิ้ง (ShopMessageContext.shopname เป็น required ตาม contract)
    const name = typeof r.shopname === "string" && r.shopname ? r.shopname : null;
    if (!name) continue;
    let transportId: string | undefined;
    if (idsByPlatform.get(r.platform)?.has(r.shop_id)) transportId = r.shop_id;
    else {
      const s = idsByName.get(`${r.platform}|${name}`);
      if (s && s.size === 1) transportId = [...s][0];
    }
    if (!transportId) continue; // missing/ambiguous transport evidence → fail closed
    const pAt = platformAt[r.platform] as Date;
    pairs.push({
      platform: r.platform,
      shop_id: transportId,
      config_shop_key: r.shop_id,
      shopname: name,
      cutoff: new Date(Math.max(globalEnabledSince.getTime(), pAt.getTime(), r.bot_worker_enabled_at.getTime())),
    });
  }
  return { config, pairs, global_enabled_since: globalEnabledSince };
}

export const botworkerRuntime = {
  // lease ต้อง > botCallTimeoutMs + headroom สำหรับ finalize
  claimLeaseMs: 150000,
  // heartbeat ตื่นทุก lease/3 — fencing filter ทำให้ stale worker renew ไม่ติด
  heartbeatMs: 50000,
  // bounded HTTP timeout สำหรับ external bot call — ต้อง < claimLeaseMs
  // ⚡ audit: liveAssignmentService ใช้ AbortSignal.timeout(90_000) กับ endpoint เดียวกัน
  //    + 429-retry 60s waits → valid latency ถึง 90s+ — timeout ต่ำกว่านี้ตัดคำตอบจริง
  botCallTimeoutMs: 90000,
  // owner identity unique ต่อ process boot — stale owner จาก process เก่า
  // เขียนทับไม่ได้เพราะ fencing_token เปลี่ยนทุก reclaim
  ownerId: `worker-${process.pid}-${randomUUID()}`,
  // ⚡ BW-2 — worker leadership lease (single active worker ต่อ production scope)
  //   อัตราส่วน lease/heartbeat เหมือน claim protocol (lease ≈ 3× heartbeat)
  //   heartbeat ต้อง < lease; takeover latency หลัง leader ตาย ≤ leaderLeaseMs
  leaderLeaseMs: 15000,
  leaderHeartbeatMs: 5000,
  // attempt cap — reclaim เกินนี้ → bot_failed terminal (กันวนไม่สิ้นสุด)
  maxClaimAttempts: 3,
};

// ─── Canonical identities (sha256, bounded, collision-safe) ──
// pure functions — ใช้ร่วมกัน botWorkerService + bufferService (กัน circular dep)
//
//   claim    : chat_processing._id = "botworker:claim:<message_id>"
//   conv lock: buffer_messages._id = "botworker:convlock:" + sha256([platform,shop,conv])[:32]
//   batch_id : "botworker:batch:" + sha256([platform,shop,conv,...sortedIds])[:32]
//   reply    : shadow_replies._id  = "botworker:reply:<batch_id>"   (workflow: ":wf<i>")
//   op       : "botworker:op:<claim_id>:<kind>" — side-effect idempotency key

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

export const claimIdFor = (messageId: string) => `botworker:claim:${messageId}`;

export function batchIdFor(platform: string, shopId: string, conversationId: string, messageIds: string[]): string {
  const canon = JSON.stringify([platform, shopId, conversationId, ...[...messageIds].sort()]);
  return "botworker:batch:" + sha256hex(canon).slice(0, 32);
}

export function convLockIdFor(platform: string, shopId: string, conversationId: string): string {
  return "botworker:convlock:" + sha256hex(JSON.stringify([platform, shopId, conversationId])).slice(0, 32);
}

export const replyIdFor = (batchId: string) => `botworker:reply:${batchId}`;
export const wfReplyId = (batchId: string, i: number) => `botworker:reply:${batchId}:wf${i}`;
export const opIdFor = (claimId: string, kind: string) => `botworker:op:${claimId}:${kind}`;

// ─── ClaimContext — poll → buffer row → batch processor ────
// processor ที่รับ ctx ห้าม claim ซ้ำ; direct process = claim → core
// อยู่ใน module นี้เพราะ botWorkerService + bufferService ใช้ร่วมกัน (กัน circular dep)

export interface ClaimContext {
  claim_id: string;             // _id ของ claim doc หลัก (first member)
  claim_ids: string[];          // claim ids ทุก member ของ batch (direct = 1)
  owner_id: string;
  fencing_token: number;        // shared token (direct claim); batch → ดู fencing_map
  // ⚡ per-claim fencing ของ batch — claim fencing และ conv-lock fencing เป็น
  //   sequence อิสระ (ห้าม share token อัตโนมัติ); finalize/heartbeat filter ทีละ claim
  fencing_map?: Record<string, number>;
  lease_expires_at: Date;
  batch_id: string;
  message_ids: string[];        // inbound member ids (sorted)
  lock_id?: string;             // conv lock _id (buffered batch เท่านั้น)
  lock_fencing_token?: number;  // conv lock token — แยกจาก claim fencing (release เท่านั้นที่ใช้)
  lost: boolean;                // heartbeat detected ownership loss → ห้าม persist/finalize
}
