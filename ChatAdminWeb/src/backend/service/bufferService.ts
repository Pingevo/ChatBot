// Buffer Service — Message Buffering (Debounce) สำหรับ Bot Worker
//
// วัตถุประสงค์: รอให้ลูกค้าหยุดพิมพ์ X วินาที แล้วรวมทุกข้อความเป็น 1 query
// ส่งให้บอท 1 ครั้ง → ตอบ 1 คำตอบ (แทน fire-and-forget ที่ตอบทุกข้อความ)
//
// โครงสร้าง:
//   - buffer_messages collection — เก็บข้อความที่กำลัง buffer (DB-backed ไม่ใช่ memory)
//   - timer map (in-memory) — debounce timer per conversation_id
//   - ตอนเข้า buffer → insert ลง buffer_messages (ยังไม่ mark chat_processing)
//   - ตอน flush → รวมข้อความ → processMessage → mark chat_processing ปกติ → ลบจาก buffer_messages
//   - ตอน boot → recover stale buffers = reconcile-only (ไม่ flush — provider=0)
//   - flush technical failure → rows dormant "failed" → ข้อความใหม่ distinct ใน
//     conv เดียวกันเท่านั้นที่ carry-forward เข้า batch ใหม่ (ไม่มี retry timer)
//
// ⚠️ ปลอดภัย:
//   - ไม่ mark chat_processing ตอนเข้า buffer (กัน isProcessed ขัดกับ processMessage)
//   - ถ้า bot-worker restart ข้อความใน buffer_messages ยังอยู่ → reconcile ตอน boot
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";
import { getSystemConfig } from "./systemConfigService";
import type { Platform } from "./systemConfigService";
import {
  botworkerRuntime,
  claimIdFor,
  batchIdFor,
  convLockIdFor,
  withScope,
  resolveBotworkerScope,
  type BotworkerCycleScope,
  type ClaimContext,
} from "./botworkerRuntime";

// ─── Types ────────────────────────────────────────────────

export interface BufferMessageDoc extends Document {
  _id?: string;
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  received_at: Date;
  // ── claim ownership (claim ก่อน insert เสมอ) ──
  claim_id?: string;            // deterministic claim _id ของ message นี้
  owner_id?: string;
  fencing_token?: number;
  // ── batch transition fields ──
  kind?: string;                // "message" rows เท่านั้น — lock docs ใช้ kind:"conv_lock"
  // buffered = รอ debounce/flush · processing = batch flush กำลังทำ
  // failed = dormant (technical failure — ไม่ retry เอง; ข้อความใหม่ distinct
  //   ใน conv เดียวกันเท่านั้นที่ carry ต่อ) · quarantined = attempt cap หมด (terminal)
  status?: "buffered" | "processing" | "failed" | "quarantined";
  batch_id?: string;
  error?: string;               // technical failure class ของ dormant row
  failed_at?: Date;
  // ── delayed-execution admission proof (PART B correction) ──
  msg_created_at?: Date;        // inbound created_timestamp — flush revalidates > cutoff
  admitted_edge?: Date | null;  // global era edge ณ admission (resolve scope ตอน flush)
  carried?: boolean;            // carry-forward revive — bypass cutoff (wake = inbound ใหม่แล้ว)
}

// ─── Conversation lock doc (kind:"conv_lock" — query แยกจาก message rows) ──
interface ConvLockDoc extends Document {
  _id?: string;
  kind: "conv_lock";
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  status: "locked" | "released";
  owner_id: string;
  fencing_token: number;
  lease_expires_at: Date;
  updated_at: Date;
}

export interface BufferConfig {
  bufferEnabled: boolean;
  bufferWindowMs: number;
  bufferMaxMessages: number;
  // ⚡ Phase 1E — media-aware buffer: รอนานกว่า + รับได้มากกว่าเมื่อมีรูป/วิดีโอ
  bufferWindowMediaMs?: number;   // default = bufferWindowMs * 2
  bufferMaxMediaMessages?: number; // default = bufferMaxMessages * 2
}

// ─── Media detection (⚡ Phase 1E) ─────────────────────────
// ตรวจว่า message เป็นรูป/วิดีโอไหม — ใช้ raw_payload structure เดียวกับ messageMediaParser
// ไม่ import messageMediaParser เพื่อหลีกเลี่ยง circular dependency + ตรวจแบบง่ายๆ พอ

function hasMedia(rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== "object") return false;
  const raw = rawPayload as Record<string, unknown>;
  // ตรวจ message_type ที่ nested หรือ top-level
  const nested = (raw.data as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined;
  const msgType = (nested?.message_type as string) || (raw.message_type as string) || (raw.msg_type as string) || "";
  return msgType === "image" || msgType === "video" || msgType === "image_with_text";
}

// ดึง image URLs จาก raw_payload (เหมือน toBotImages แต่ inline เพื่อหลีกเลี่ยง circular dep)
function extractMediaUrls(rawPayload: unknown): string[] {
  if (!rawPayload || typeof rawPayload !== "object") return [];
  const raw = rawPayload as Record<string, unknown>;
  const nested = (raw.data as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined;
  const inner = (nested?.content as Record<string, unknown> | undefined) || (raw.content as Record<string, unknown> | undefined) || {};
  const msgType = (nested?.message_type as string) || (raw.message_type as string) || (raw.msg_type as string) || "";
  if (msgType === "image") {
    // ⚡ Shopee chat image schema: content.url (ไม่ใช่ image_url)
    //    เหมือน messageMediaParser.ts case "image" ที่ใช้ c.url
    const url = (inner.url as string) || (inner.image_url as string) || (((inner.image_url_list as string[]) || [])[0]);
    return url ? [url] : [];
  }
  if (msgType === "image_with_text") {
    // image_with_text ใช้ image_url (ต่างจาก image ธรรมดา)
    const url = (inner.image_url as string) || (((inner.image_url_list as string[]) || [])[0]);
    return url ? [url] : [];
  }
  if (msgType === "video") {
    const url = (inner.video_url as string) || "";
    return url ? [url] : [];
  }
  return [];
}

// ─── In-memory timer map (per exact tuple) ───────────────
// timer อยู่ใน memory (ไม่ใช่ DB) — ถ้า restart หาย แต่ recover ตอน boot ช่วยได้
// ⚡ key = convLockIdFor(platform, shop_id, conversation_id) — tuple เดียวกับ
//   lock/batch/rows เสมอ (conversation_id เดียวข้าม shop/platform ห้ามชนกัน)
const bufferTimers = new Map<string, NodeJS.Timeout>();

// ─── Insert message into buffer_messages collection ───────

async function insertToBuffer(msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  created_timestamp?: Date;
  admitted_edge?: Date | null;
  claimContext?: ClaimContext;
}): Promise<"inserted" | "duplicate"> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  try {
    await coll.insertOne({
      message_id: msg.message_id,
      conversation_id: msg.conversation_id,
      shop_id: msg.shop_id,
      platform: msg.platform,
      text: msg.text,
      raw_payload: msg.raw_payload,
      received_at: new Date(),
      // ⚡ admission proof — flush boundary เช็ค msg_created_at > current cutoff
      msg_created_at: msg.created_timestamp,
      admitted_edge: msg.admitted_edge ?? null,
      // ⚡ claim ก่อนเข้า buffer เสมอ — row ถือ ClaimContext ไปให้ batch processor
      kind: "message",
      status: "buffered",
      claim_id: msg.claimContext?.claim_id,
      owner_id: msg.claimContext?.owner_id,
      fencing_token: msg.claimContext?.fencing_token,
    });
    return "inserted";
  } catch (e) {
    // row มีอยู่แล้ว (re-poll ขณะ claim processing) → ไม่ re-buffer ซ้ำ
    // ⚡ duplicate ต้องแยกจาก new activity — caller ห้าม re-arm debounce จาก insert ซ้ำ
    if ((e as { code?: number }).code === 11000) return "duplicate";
    throw e;
  }
}

// ─── Get buffered messages for an exact tuple ─────────────
// อ่านเฉพาะ message rows (status buffered) ของ (platform, shop_id, conversation_id)
// เท่านั้น — ห้ามดูด lock docs เข้า batch ห้ามข้าม shop/platform

async function getBufferedMessages(
  platform: Platform,
  shopId: string,
  conversationId: string
): Promise<BufferMessageDoc[]> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  return coll
    .find({ conversation_id: conversationId, shop_id: shopId, platform, status: "buffered", kind: { $ne: "conv_lock" } })
    .sort({ received_at: 1 })
    .toArray();
}

// ─── Delete only exact batch member rows ──────────────────
// ⚡ row identity = message_id (unique ใน buffer_messages) — ไม่พึ่ง _id

async function deleteBatchRows(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  await coll.deleteMany({ message_id: { $in: messageIds }, kind: { $ne: "conv_lock" } });
}

// ─── Conversation-level batch lock ─────────────────────────
// deterministic _id ผูก platform+shop+conv → E11000 = flusher อื่นชนะแล้ว
// expired lease → reclaim ด้วย fenced update บน doc เดิม

async function acquireConvLock(
  platform: Platform,
  shopId: string,
  conversationId: string
): Promise<{ lockId: string; fencingToken: number } | null> {
  const coll = await getCollection<ConvLockDoc>(COLLECTIONS.bufferMessages);
  const lockId = convLockIdFor(platform, shopId, conversationId);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + botworkerRuntime.claimLeaseMs);
  try {
    await coll.insertOne({
      _id: lockId,
      kind: "conv_lock",
      conversation_id: conversationId,
      shop_id: shopId,
      platform,
      status: "locked",
      owner_id: botworkerRuntime.ownerId,
      fencing_token: 1,
      lease_expires_at: leaseUntil,
      updated_at: now,
    } as ConvLockDoc);
    return { lockId, fencingToken: 1 };
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  // lock มีอยู่ → reclaim เฉพาะเมื่อ lease หมดอายุ (active lease = flusher อื่นทำงานอยู่)
  // ⚡ returnDocument:"after" — caller ต้องถือ token ใหม่ ไม่ใช่ snapshot ก่อน update
  const reclaimed = await coll.findOneAndUpdate(
    { _id: lockId, status: "locked", lease_expires_at: { $lt: now } },
    {
      $set: { owner_id: botworkerRuntime.ownerId, lease_expires_at: leaseUntil, updated_at: now },
      $inc: { fencing_token: 1 },
    },
    { returnDocument: "after" }
  );
  if (!reclaimed) return null;
  return { lockId, fencingToken: reclaimed.fencing_token };
}

async function releaseConvLock(lockId: string, fencingToken: number): Promise<void> {
  const coll = await getCollection<ConvLockDoc>(COLLECTIONS.bufferMessages);
  // fenced release — stale owner ลบ lock ของ owner ใหม่ไม่ได้
  await coll.deleteMany({ _id: lockId, owner_id: botworkerRuntime.ownerId, fencing_token: fencingToken });
}

// ─── Clear timer for an exact tuple ───────────────────────

function clearTimer(tupleKey: string): void {
  const timer = bufferTimers.get(tupleKey);
  if (timer) {
    clearTimeout(timer);
    bufferTimers.delete(tupleKey);
  }
}

// ⚡ timer-launched flush ไม่มี parent promise ใน inFlight — track ไว้ให้ shutdown
//   drain (waitForInFlight) รอจนจบ; clear ใน finally-equivalent เสมอ (ไม่ใช่ queue/scheduler)
const activeFlushes = new Set<Promise<unknown>>();

// ⚡ NO autonomous flush timers — lock contention และ foreign-claim ไม่มี retry/
//   recheck loop: lock loser skip เปล่า (winner hand-off arm debounce ให้ leftover
//   rows หลัง release); foreign lease expiry → recovery reconcile ไม่ใช่ re-exec

// ─── Dormant failed state ─────────────────────────────────
// claim doc lite (หลีกเลี่ยง circular import กับ botWorkerService —
//   ใช้เฉพาะ status/attempt/fencing เพื่อ carry-gate)
interface ClaimDocLite {
  _id?: string;
  status?: string;
  attempt?: number;
  fencing_token?: number;
  error?: string;
  owner_id?: string;
  lease_expires_at?: Date;
  claimed_at?: Date;
  updated_at?: Date;
  processed_at?: Date;
  outcome_type?: string;
}

/** technical flush failure → rows dormant (retain payload สำหรับ carry-forward) */
async function markRowsFailed(coll: Awaited<ReturnType<typeof getCollection<BufferMessageDoc>>>, messageIds: string[], error: string): Promise<void> {
  if (messageIds.length === 0) return;
  await coll.updateMany(
    { message_id: { $in: messageIds }, kind: { $ne: "conv_lock" } },
    { $set: { status: "failed", error, failed_at: new Date() } }
  );
}

/** dormant batch = claim+row settle หน่วยเดียว — member claims ที่ยังของเรา →
 *   bot_failed (fenced CAS บน owner/token ที่ re-fence ไว้; foreign/stolen CAS miss)
 *   → carry-forward ใช้ได้ทันที ไม่ต้องรอ lease expiry + recovery */
async function settleOwnedClaimsFailed(
  procColl: Awaited<ReturnType<typeof getCollection<ClaimDocLite>>>,
  claimedIds: string[],
  fencingMap: Record<string, number>,
  error: string
): Promise<void> {
  const now = new Date();
  for (const claimId of claimedIds) {
    await procColl.updateOne(
      { _id: claimId, owner_id: botworkerRuntime.ownerId, fencing_token: fencingMap[claimId], status: "processing" },
      { $set: { status: "bot_failed", outcome_type: "bot_failed", error, processed_at: now, updated_at: now } }
    );
  }
}

/**
 * carry-forward owner เดียว — distinct new inbound (admitted) ใน exact
 *   (platform, shop_id, conversation_id) เดียวกันเท่านั้นที่ปลุก dormant failed batch:
 *   revive claim bot_failed→processing (fenced CAS + attempt++) แล้ว CAS row→buffered
 *   claim เกิน maxClaimAttempts → quarantined (ไม่ carry ตลอดกาล)
 *   caller: bufferOrProcess เท่านั้น — poll/recovery/timer ไม่เรียก
 */
async function carryDormantRows(msg: {
  conversation_id: string;
  shop_id: string;
  platform: Platform;
}): Promise<number> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  const procColl = await getCollection<ClaimDocLite>(COLLECTIONS.chatProcessing);
  const rows = await coll
    .find({
      conversation_id: msg.conversation_id,
      shop_id: msg.shop_id,
      platform: msg.platform,
      status: "failed",
      kind: { $ne: "conv_lock" },
    })
    .toArray();
  let carried = 0;
  for (const row of rows) {
    const claimId = row.claim_id || claimIdFor(row.message_id);
    const claim = await procColl.findOne({ _id: claimId });
    if (!claim || claim.status !== "bot_failed") continue; // claim state อื่น = recovery owns
    if ((claim.attempt || 1) >= botworkerRuntime.maxClaimAttempts) {
      await coll.updateOne(
        { message_id: row.message_id, status: "failed" },
        { $set: { status: "quarantined" } }
      );
      continue;
    }
    // revive — fenced บน token ที่ observe; CAS lost = carrier อื่นชนะแล้ว
    const now = new Date();
    const ref = await procColl.findOneAndUpdate(
      { _id: claimId, status: "bot_failed", fencing_token: claim.fencing_token },
      {
        $set: {
          status: "processing",
          owner_id: botworkerRuntime.ownerId,
          lease_expires_at: new Date(now.getTime() + botworkerRuntime.claimLeaseMs),
          claimed_at: now,
          updated_at: now,
        },
        $inc: { fencing_token: 1, attempt: 1 },
        $unset: { outcome_type: "", error: "", processed_at: "" },
      },
      { returnDocument: "after" }
    );
    if (!ref) continue;
    // row กลับเข้า batch — เฉพาะ CAS บน failed เท่านั้น (identity เดิม)
    // ⚡ carried=true — dormant row ที่ distinct inbound ปลุกแล้ว bypass cutoff
    //   check ตอน flush (wake-up gate คือ inbound ใหม่ ไม่ใช่ created_timestamp เดิม)
    const upd = await coll.updateOne(
      { message_id: row.message_id, status: "failed", kind: { $ne: "conv_lock" } },
      {
        $set: {
          status: "buffered",
          owner_id: botworkerRuntime.ownerId,
          fencing_token: ref.fencing_token,
          carried: true,
        },
        $unset: { error: "", failed_at: "", batch_id: "" },
      }
    );
    if (upd.matchedCount === 1) carried++;
  }
  return carried;
}

// ─── Flush buffer — conv lock → per-row CAS → process → member delete ──
//
// รับ processMessage function จาก botWorkerService (avoid circular dependency)
// และ markProcessed function สำหรับ mark ข้อความที่เหลือ
//
// ลำดับ (single owner + crash recovery):
//   acquire conv lock (E11000/lease-active = loser → รอ batch ถัดไป)
//   → CAS rows buffered→processing ทีละ row (member set = exact ids)
//   → re-fence member claims ให้ owner/token เดียวกัน (batch ctx)
//   → processClaimedMessage(combined, ctx) — core ไม่ claim ซ้ำ
//   → core finalize member claims (fenced) → ลบเฉพาะ member rows
//   → release lock ใน finally (fenced)
// technical failure → rows dormant "failed" (retained สำหรับ carry-forward)
//   + release lock — ไม่มี autonomous retry

type ProcessMessageFn = (msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  images?: string[];  // ⚡ Phase 1F — image URLs รวมจากทุก message ใน buffer
  claimContext?: ClaimContext;
  // ⚡ era/kill-switch signal — forward เข้า claim signal ของ processMessage
  //   (queued outbound ต้องออกเมื่อ era ตาย — claimed work ห้ามเริ่ม provider call ใหม่)
}, signal?: AbortSignal) => Promise<{ status: string; detail: string; finalized: boolean; lost: boolean }>;

type MarkProcessedFn = (doc: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  status: "trigger_matched" | "bot_answered" | "handed_off" | "bot_failed" | "no_action" | "workflow_actioned" | "workflow_resumed" | "processing";
}) => Promise<void>;

// ⚡ trackedFlush — timer callback (debounce) launch flush แบบไม่มี parent promise;
//   promise ต้องอยู่ใน activeFlushes เพื่อให้ shutdown drain รอ — clear เมื่อ settle เสมอ
//   (immediate flush / recovery flush มี parent อยู่แล้ว — inFlight p / recoveryInFlight)
function trackedFlush(
  platform: Platform,
  shopId: string,
  conversationId: string,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn,
  signal?: AbortSignal
): Promise<{ status: string; detail: string }> {
  const p = flushBuffer(platform, shopId, conversationId, processMessage, markProcessed, signal);
  activeFlushes.add(p);
  p.then(() => activeFlushes.delete(p), () => activeFlushes.delete(p));
  return p;
}

/** scope-superseded ordinary buffered row → terminal settle (PART B):
 *   fenced CAS claim → no_action (หน่วยเดียว) + markProcessed + delete row —
 *   ไม่ใช่ technical failure → ห้ามกลายเป็น dormant (ไม่ carryable);
 *   foreign-active claim → leave ให้ owner/recovery จัดการเอง */
async function settleScopeRejectedRow(
  row: BufferMessageDoc,
  markProcessed: MarkProcessedFn
): Promise<void> {
  const procColl = await getCollection<ClaimDocLite>(COLLECTIONS.chatProcessing);
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  const claimId = row.claim_id || claimIdFor(row.message_id);
  const now = new Date();
  const upd = await procColl.updateOne(
    { _id: claimId, status: "processing", owner_id: row.owner_id, fencing_token: row.fencing_token },
    { $set: { status: "no_action", outcome_type: "no_action", error: "scope_superseded", processed_at: now, updated_at: now } }
  );
  if (upd.matchedCount === 1) {
    await markProcessed({
      message_id: row.message_id, conversation_id: row.conversation_id,
      shop_id: row.shop_id, platform: row.platform, status: "no_action",
    });
    await coll.deleteOne({ message_id: row.message_id, kind: { $ne: "conv_lock" } });
    return;
  }
  const c = await procColl.findOne({ _id: claimId });
  if (c?.status === "processing") return; // foreign-active → owner/recovery owns
  if (!c) {
    await markProcessed({
      message_id: row.message_id, conversation_id: row.conversation_id,
      shop_id: row.shop_id, platform: row.platform, status: "no_action",
    });
  }
  await coll.deleteOne({ message_id: row.message_id, kind: { $ne: "conv_lock" } });
}

export async function flushBuffer(
  platform: Platform,
  shopId: string,
  conversationId: string,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn,
  signal?: AbortSignal
): Promise<{ status: string; detail: string }> {
  const tupleKey = convLockIdFor(platform, shopId, conversationId);
  // ล้าง timer ของ tuple นี้
  clearTimer(tupleKey);

  // ดึงข้อความที่ buffer อยู่ของ tuple เดียวเท่านั้น (message rows — lock docs ไม่ปน)
  const candidates = await getBufferedMessages(platform, shopId, conversationId);
  if (candidates.length === 0) {
    return { status: "skip", detail: "no buffered messages" };
  }

  // ⚡ recovery abort — lock acquire คือ batch-transition boundary →
  //   cancelled run ห้ามเริ่ม transition (rows ยัง buffered → edge ถัดไปกู้ได้)
  if (signal?.aborted) {
    return { status: "skip", detail: "recovery aborted" };
  }

  // ── delayed-execution admission owner เดียว (PART B) ──
  //   debounce work อาจอายุยาวกว่า cycle snapshot — resolve สวิตช์จริงปัจจุบัน
  //   ครั้งเดียวที่นี่: global+platform+exact shop ต้องยังเปิด และ row ต้อง
  //   admit ภายใต้ current effective cutoff (msg_created_at > pair.cutoff)
  //   carried dormant rows bypass cutoff เท่านั้น — wake gate คือ inbound ใหม่แล้ว
  //   superseded ordinary rows → settle no_action terminal (ไม่ใช่ dormant)
  const cfg = await getSystemConfig(true);
  // ⚡ sentinel -1 — edge epoch(0) เป็น Date ที่ valid แต่ falsy; row ที่ไม่มี
  //   admitted_edge เลย (legacy/manual seed) → null → resolver fail-closed ทั้ง batch
  const edgeMs = candidates.reduce((m, r) => Math.max(m, r.admitted_edge?.getTime() ?? -1), -1);
  const scope = await resolveBotworkerScope(cfg, edgeMs >= 0 ? new Date(edgeMs) : null);
  const pair = scope.pairs.find((p) => p.platform === platform && p.shop_id === shopId);
  const eligible: BufferMessageDoc[] = [];
  for (const row of candidates) {
    const admissible = pair !== undefined &&
      (row.carried === true ||
        (row.msg_created_at instanceof Date && row.msg_created_at.getTime() > pair.cutoff.getTime()));
    if (admissible) {
      eligible.push(row);
    } else {
      await settleScopeRejectedRow(row, markProcessed);
    }
  }
  if (eligible.length === 0) {
    return { status: "skip", detail: "scope superseded before flush — rows settled terminal" };
  }

  // ── conv lock: flusher เดียวต่อ tuple ──
  //   แพ้ lock → skip เปล่า — winner จบ flush แล้ว arm debounce ให้ leftover
  //   rows เอง (hand-off ใน finally — ไม่มี lock/lease polling timer เลย)
  const first = eligible[0];
  const lock = await acquireConvLock(platform, shopId, conversationId);
  if (!lock) {
    return { status: "skip", detail: "conv lock held by another flusher" };
  }

  // ── member selection: CAS buffered→processing ทีละ row ──
  //   ข้อความใหม่ที่เข้ามาหลังจุดนี้อยู่ buffered → batch ถัดไป (ไม่ดูดเข้ามา)
  //   ⚡ row identity = message_id (unique) — docs ที่ seed/push อาจไม่มี _id
  const memberIds: string[] = [];
  const rows: BufferMessageDoc[] = [];
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  let ownsBatch = false; // ⚡ hand-off arm เฉพาะ flusher ที่ชนะ batch จริง — foreign-only leftovers ไม่ arm (กัน no-op flush loop)
  try {
    for (const row of eligible) {
      const cas = await coll.updateOne(
        { message_id: row.message_id, kind: { $ne: "conv_lock" }, status: "buffered" },
        { $set: { status: "processing" } }
      );
      if (cas.matchedCount === 1) {
        memberIds.push(row.message_id);
        rows.push(row);
      }
    }
    if (memberIds.length === 0) {
      return { status: "skip", detail: "no rows claimed (all transitioned)" };
    }

    // ── re-fence member claims — owner/token ที่ row บันทึกเท่านั้น ──
    //   ⚡ expired/foreign claim ห้ามถูก re-fence เป็นงานใหม่ — lease expiry ไม่ใช่
    //      execution trigger: owner ที่ตายไร้ evidence → recovery reconcile dormant
    //   ⚡ claim fencing เป็น per-claim sequence ($inc) — ห้ามใช้ conv-lock token
    const procColl = await getCollection<ClaimDocLite>(COLLECTIONS.chatProcessing);
    const now = new Date();
    const claimedIds: string[] = [];
    const claimedMsgIds: string[] = [];
    const fencingMap: Record<string, number> = {};
    for (const row of rows) {
      const claimId = row.claim_id || claimIdFor(row.message_id);
      // ⚡ re-fence เฉพาะ claim ที่เราเป็น owner อยู่แล้ว — foreign-owned claim
      //   (row.owner_id ต่างจากเรา) ห้ามถูกแตะ: active lease = งานของ owner นั้น,
      //   expired = recovery reconcile dormant เท่านั้น (ไม่ใช่ execution trigger)
      const ref = await procColl.findOneAndUpdate(
        {
          _id: claimId,
          status: "processing",
          owner_id: botworkerRuntime.ownerId,
          fencing_token: row.fencing_token,
        },
        {
          $set: {
            owner_id: botworkerRuntime.ownerId,
            lease_expires_at: new Date(Date.now() + botworkerRuntime.claimLeaseMs),
            updated_at: now,
          },
          $inc: { fencing_token: 1 },
        },
        { returnDocument: "after" }
      );
      if (ref) {
        claimedIds.push(claimId);
        claimedMsgIds.push(row.message_id);
        fencingMap[claimId] = ref.fencing_token ?? 0;
        // row ถือ expected identity ใหม่ → retry/next flush re-fence ได้ถูกต้อง
        await coll.updateOne(
          { message_id: row.message_id, kind: { $ne: "conv_lock" } },
          { $set: { owner_id: botworkerRuntime.ownerId, fencing_token: ref.fencing_token } }
        );
        continue;
      }
      // re-fence ไม่ผ่าน → แยกสาเหตุด้วย claim doc จริง (ห้ามตีรวนเป็น buffered ทุกกรณี):
      //   bot_failed → dormant failed/quarantined (payload retained — ห้ามลบ)
      //   terminal อื่น/missing → settle message ตาม outcome ของ claim + ลบ row (ห้ามกลับ buffered)
      //   claim processing ของ owner อื่น active → คง buffered รอ owner finalize/lease หมด
      //   ⚡ ไม่มี recheck — owner ตายไร้ evidence → recovery reconcile dormant เท่านั้น
      const claimDoc = await procColl.findOne({ _id: claimId });
      if (claimDoc?.status === "bot_failed") {
        const capped = (claimDoc.attempt ?? 1) >= botworkerRuntime.maxClaimAttempts;
        await coll.updateOne(
          { message_id: row.message_id, kind: { $ne: "conv_lock" } },
          {
            $set: capped
              ? { status: "quarantined" }
              : { status: "failed", error: claimDoc.error ?? "bot_failed", failed_at: new Date() },
          }
        );
      } else if (!claimDoc || claimDoc.status !== "processing") {
        await markProcessed({
          message_id: row.message_id,
          conversation_id: row.conversation_id,
          shop_id: row.shop_id,
          platform: row.platform,
          status: (claimDoc?.status as Parameters<MarkProcessedFn>[0]["status"]) || "bot_failed",
        });
        await coll.deleteOne({ message_id: row.message_id, kind: { $ne: "conv_lock" } });
      } else {
        await coll.updateOne(
          { message_id: row.message_id, kind: { $ne: "conv_lock" } },
          { $set: { status: "buffered" }, $unset: { batch_id: "" } }
        );
      }
    }
    if (claimedIds.length === 0) {
      return { status: "skip", detail: "no owned claims in batch" };
    }
    ownsBatch = true;

    // ⚡ batch_id canonical = sorted OWNED member ids — recompute หลังรู้ set จริง
    const realBatchId = batchIdFor(first.platform, first.shop_id, conversationId, claimedMsgIds);
    for (const claimId of claimedIds) {
      await procColl.updateOne(
        { _id: claimId, owner_id: botworkerRuntime.ownerId, fencing_token: fencingMap[claimId] },
        { $set: { batch_id: realBatchId } }
      );
    }
    await coll.updateMany(
      { message_id: { $in: claimedMsgIds }, kind: { $ne: "conv_lock" } },
      { $set: { batch_id: realBatchId } }
    );

    const ctx: ClaimContext = {
      claim_id: claimIdFor(claimedMsgIds[0]),
      claim_ids: claimedIds,
      owner_id: botworkerRuntime.ownerId,
      fencing_token: lock.fencingToken,
      fencing_map: fencingMap,
      lease_expires_at: new Date(Date.now() + botworkerRuntime.claimLeaseMs),
      batch_id: realBatchId,
      message_ids: [...claimedMsgIds].sort(),
      lock_id: lock.lockId,
      lock_fencing_token: lock.fencingToken,
      lost: false,
    };

    // รวมข้อความทั้งหมดเป็น 1 query — ใช้ space แทน \n เพื่อให้ RAG/LLM อ่านเป็นประโยคเดียว
    const combinedText = rows
      .filter((r) => claimedMsgIds.includes(r.message_id))
      .map((m) => m.text)
      .join(" ");
    const firstMsg = rows.find((r) => r.message_id === claimedMsgIds[0])!;

    // ⚡ Phase 1E/1F — รวม images จากทุก message (ไม่ใช่แค่ firstMsg)
    const allImages: string[] = [];
    for (const m of rows) {
      if (!claimedMsgIds.includes(m.message_id)) continue;
      const urls = extractMediaUrls(m.raw_payload);
      for (const u of urls) {
        if (!allImages.includes(u)) allImages.push(u);
      }
    }

    // ⚡ recovery abort — processMessage คือ LLM boundary: cancelled run ห้าม launch
    //   member rows ถูก CAS →processing แล้ว → revert กลับ buffered (claims คง owner/lease
    //   ใหม่ → กู้ผ่าน re-fence/lease-expiry ได้ edge ถัดไป) — lock ปล่อยใน finally
    if (signal?.aborted) {
      await coll.updateMany(
        { message_id: { $in: claimedMsgIds }, kind: { $ne: "conv_lock" } },
        { $set: { status: "buffered" }, $unset: { batch_id: "" } }
      );
      return { status: "skip", detail: "recovery aborted" };
    }

    try {
      // ประมวลผลเป็น 1 message — processor ได้ ctx จึงไม่ claim ซ้ำ
      const result = await processMessage({
        message_id: firstMsg.message_id,
        conversation_id: firstMsg.conversation_id,
        shop_id: firstMsg.shop_id,
        platform: firstMsg.platform,
        text: combinedText,
        raw_payload: firstMsg.raw_payload,
        images: allImages.length > 0 ? allImages : undefined,
        claimContext: ctx,
      }, signal);

      // ⚡ finalization contract — ลบ rows เฉพาะเมื่อ finalize ครบทุก member claim
      //   ด้วย outcome ปกติ; technical failure (bot_failed finalized) → dormant failed
      //   interrupted (partial/lost/cancelled) → dormant failed + settle owned claims
      //   เข้าหน่วยเดียวกัน (foreign-owned CAS miss — recovery reconcile เมื่อ lease หมด)
      //   — ไม่มี retry timer ทั้งคู่
      if (result.finalized && result.status === "bot_failed") {
        await markRowsFailed(coll, claimedMsgIds, result.detail);
      } else if (result.finalized) {
        await deleteBatchRows(claimedMsgIds);
      } else {
        await markRowsFailed(coll, claimedMsgIds, `interrupted: ${result.detail}`);
        await settleOwnedClaimsFailed(procColl, claimedIds, fencingMap, `interrupted: ${result.detail}`);
      }

      await logAdminEvent({
        action_type: "bot.buffer_flush",
        actor: "bot-worker",
        metadata: {
          conversation_id: conversationId,
          message_count: claimedMsgIds.length,
          combined_text_length: combinedText.length,
          result_status: result.status,
          batch_id: realBatchId,
        },
      });

      return {
        status: "buffer_flushed",
        detail: `flushed ${claimedMsgIds.length} msgs → ${result.status}`,
      };
    } catch (err) {
      // error → dormant failed (payload retained) — ไม่มี retry อัตโนมัติ;
      //   owned member claims settle bot_failed หน่วยเดียวกัน (fenced CAS)
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[buffer] flush error for ${conversationId}:`, errorMsg);
      await markRowsFailed(coll, claimedMsgIds, errorMsg);
      await settleOwnedClaimsFailed(procColl, claimedIds, fencingMap, errorMsg);
      await logAdminEvent({
        action_type: "bot.buffer_flush",
        actor: "bot-worker",
        metadata: {
          conversation_id: conversationId,
          message_count: claimedMsgIds.length,
          error: errorMsg,
        },
      });
      return { status: "buffer_error", detail: errorMsg };
    }
  } finally {
    // fenced release — owner/token เดิมเท่านั้น
    await releaseConvLock(lock.lockId, lock.fencingToken);
    // ⚡ liveness hand-off (ไม่ใช่ retry) — rows ที่ insert ระหว่าง flush นี้
    //   bufferOrProcess ของมัน arm debounce เอง แต่ถ้า timer fire ตอน lock ยังถือ
    //   อยู่ → flush นั้น skip เปล่าและ timer ตาย → winner (เรา) arm ให้ leftover
    //   หลัง release — debounce ปกติ ไม่ใช่ lease polling ของ foreign claim
    if (ownsBatch && !signal?.aborted) {
      const leftovers = await getBufferedMessages(platform, shopId, conversationId).catch(() => []);
      if (leftovers.length > 0 && !bufferTimers.has(tupleKey)) {
        const hasMediaRow = leftovers.some((r) => hasMedia(r.raw_payload));
        const win = hasMediaRow
          ? (cfg.bot_buffer_window_media_ms ?? (cfg.bot_buffer_window_ms ?? 0) * 2)
          : (cfg.bot_buffer_window_ms ?? 0);
        const latest = Math.max(...leftovers.map((r) => new Date(r.received_at).getTime()).filter(Number.isFinite));
        const delay = Math.max(0, (Number.isFinite(latest) ? latest : Date.now()) + win - Date.now());
        bufferTimers.set(
          tupleKey,
          setTimeout(() => {
            if (signal?.aborted) return;
            trackedFlush(platform, shopId, conversationId, processMessage, markProcessed, signal).catch((err) =>
              console.error(`[buffer] hand-off flush error for ${conversationId}:`, err)
            );
          }, delay)
        );
      }
    }
  }
}

// ─── Buffer or Process — ตัดสินใจว่าจะ buffer หรือ process ทันที ──

export async function bufferOrProcess(
  msg: {
    message_id: string;
    conversation_id: string;
    shop_id: string;
    platform: Platform;
    text: string;
    raw_payload?: unknown;
    // ⚡ admission proof — row persist ไว้ให้ flush boundary revalidate scope/cutoff
    created_timestamp?: Date;
    admitted_edge?: Date | null;
    claimContext?: ClaimContext; // ⚡ claim ก่อนเข้า buffer เสมอ — row ถือ ctx
  },
  config: BufferConfig,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn,
  // ⚡ enabled-era signal — debounce callback ลูกต้องถือ signal เดียวกัน;
  //   ไม่ส่งมา (caller เก่า/recovery-less path) → signal-less เหมือนเดิม
  signal?: AbortSignal
): Promise<{ status: string; detail: string }> {
  // ⚡ era aborted — ห้ามเขียน buffer row / arm timer / launch flush ใหม่ใน cancelled era
  if (signal?.aborted) return { status: "skip", detail: "era aborted" };

  const convId = msg.conversation_id;
  // ⚡ tuple identity เดียวทุก boundary — lock/timer/batch/rows แยกตาม
  //   (platform, shop_id, conversation_id) เต็ม ห้าม key ด้วย conversation_id เดียว
  const tupleKey = convLockIdFor(msg.platform, msg.shop_id, convId);

  // ถ้าปิด buffer → ประมวลผลทันที (เหมือนเดิม) — era signal forward เข้า claim
  if (!config.bufferEnabled) {
    // ⚡ carry-forward — distinct new inbound ใน conv เดียวกันปลุก dormant failed batch:
    //   revive rows เข้า buffered แล้ว flush ทันที = combined attempt เดียว (ไม่มี debounce)
    const carried = await carryDormantRows(msg);
    if (carried > 0) {
      await insertToBuffer(msg);
      return flushBuffer(msg.platform, msg.shop_id, convId, processMessage, markProcessed, signal);
    }
    try {
      const res = await processMessage(msg, signal);
      // ⚡ technical failure → persist dormant row (payload retained — inbound ถัดไป carry ต่อ)
      if (res.status === "bot_failed") {
        await persistDormantRow(msg, res.detail);
      }
      return res;
    } catch (err) {
      // infra throw ก่อน inner error boundary (เช่น conversation fetch) →
      //   retain payload เช่นเดียวกัน (cancelled era ห้ามเขียน — recovery settle แทน)
      if (!signal?.aborted) {
        await persistDormantRow(msg, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }

  // เพิ่มเข้า buffer_messages collection — duplicate = ไม่มี activity ใหม่:
  //   ห้าม re-arm debounce จาก re-poll ของ message เดิม (poll interval < window
  //   ทำ timer ไม่มีวันครบ → flush ไม่ยิง → livelock) — timer ของ insert แรกยังเดิน
  const admitted = await insertToBuffer(msg);
  if (admitted === "duplicate" && bufferTimers.has(tupleKey)) {
    return { status: "buffered", detail: "duplicate — not admitted, debounce unchanged" };
  }

  // ⚡ distinct new inbound เท่านั้นที่ปลุก dormant failed batch (PART 5) —
  //   duplicate/re-poll/conv อื่น/pre-cutoff ไม่ปลุก; carried rows เข้า batch เดียวกัน
  if (admitted === "inserted") {
    await carryDormantRows(msg);
  }

  // ดึงจำนวนข้อความที่ buffer อยู่ใน tuple นี้เท่านั้น
  const buffered = await getBufferedMessages(msg.platform, msg.shop_id, convId);
  if (admitted === "duplicate" && buffered.length === 0) {
    return { status: "buffered", detail: "duplicate — batch already processing" };
  }

  // ⚡ Phase 1E — ตรวจว่ามี media (รูป/วิดีโอ) ใน buffer ไหม
  //    ถ้ามี → ใช้ window นานกว่า + max มากกว่า (ลูกค้ามักส่งหลายรูปติดกัน)
  const hasAnyMedia = buffered.some((m) => hasMedia(m.raw_payload));
  const mediaWindowMs = config.bufferWindowMediaMs ?? config.bufferWindowMs * 2;
  const mediaMaxMessages = config.bufferMaxMediaMessages ?? config.bufferMaxMessages * 2;
  const effectiveWindowMs = hasAnyMedia ? mediaWindowMs : config.bufferWindowMs;
  const effectiveMaxMessages = hasAnyMedia ? mediaMaxMessages : config.bufferMaxMessages;

  // ⚡ abort ระหว่าง buffer write — ห้าม arm timer / launch flush ใน cancelled era
  //   (row คง buffered → edge/rising recovery ถัดไปกู้ได้)
  if (signal?.aborted) return { status: "skip", detail: "era aborted" };

  // ถ้าครบ max → flush ทันที ไม่รอ
  if (buffered.length >= effectiveMaxMessages) {
    return flushBuffer(msg.platform, msg.shop_id, convId, processMessage, markProcessed, signal);
  }

  // รีเซ็ต timer เฉพาะ new activity; duplicate ที่ไม่มี timer ซ่อมจาก deadline
  // เดิมของแถวล่าสุด เพื่อไม่ให้ transient error ทำ row ค้างหรือยืด debounce ใหม่
  const latestReceivedAt = Math.max(
    ...buffered.map((row) => new Date(row.received_at).getTime()).filter(Number.isFinite)
  );
  const timerDelayMs = admitted === "duplicate"
    ? (Number.isFinite(latestReceivedAt)
        ? Math.max(0, latestReceivedAt + effectiveWindowMs - Date.now())
        : 0)
    : effectiveWindowMs;
  clearTimer(tupleKey);
  bufferTimers.set(
    tupleKey,
    setTimeout(() => {
      // ⚡ cancelled era — callback ที่ fired ก่อน abort แต่ยังไม่ process → ออกเงียบ
      if (signal?.aborted) return;
      trackedFlush(msg.platform, msg.shop_id, convId, processMessage, markProcessed, signal).catch((err) =>
        console.error(`[buffer] timer flush error for ${convId}:`, err)
      );
    }, timerDelayMs)
  );

  return {
    status: "buffered",
    detail: admitted === "duplicate"
      ? `duplicate — restored missing debounce (${timerDelayMs}ms remaining)`
      : `buffered (${buffered.length} msgs, ${hasAnyMedia ? "media" : "text"} window ${effectiveWindowMs}ms)`,
  };
}

// ─── Dormant row persistence (unbuffered technical failure) ──
// เก็บ payload + claim identity ไว้ให้ inbound ถัดไป carry ต่อ — upsert ตาม
// message_id เดิม (ห้าม fabricate identity ใหม่)

async function persistDormantRow(
  msg: {
    message_id: string;
    conversation_id: string;
    shop_id: string;
    platform: Platform;
    text: string;
    raw_payload?: unknown;
    created_timestamp?: Date;
    admitted_edge?: Date | null;
    claimContext?: ClaimContext;
  },
  error: string
): Promise<void> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  await coll.updateOne(
    { message_id: msg.message_id, kind: { $ne: "conv_lock" } },
    {
      $set: {
        conversation_id: msg.conversation_id,
        shop_id: msg.shop_id,
        platform: msg.platform,
        text: msg.text,
        raw_payload: msg.raw_payload,
        msg_created_at: msg.created_timestamp,
        admitted_edge: msg.admitted_edge ?? null,
        kind: "message",
        status: "failed",
        error,
        failed_at: new Date(),
        claim_id: msg.claimContext?.claim_id ?? claimIdFor(msg.message_id),
        owner_id: msg.claimContext?.owner_id ?? botworkerRuntime.ownerId,
        fencing_token: msg.claimContext?.fencing_token,
      },
      $setOnInsert: { received_at: new Date() },
    },
    { upsert: true }
  );
}

// ─── Recover stale buffers ตอน boot/restart/rising-edge ────
// ⚡ reconciliation-only (provider=0): scan rows ใน scope → classifier
//   (claim authority owner ใน botWorkerService) ตัดสิน delete/leave —
//   ไม่มี flush/processMessage ที่นี่; dormant failed rows คงอยู่จนกว่า
//   distinct new inbound จะ carry ต่อ (PART 5/6 contract)

export async function recoverStaleBuffers(
  // ⚡ row classifier (botWorkerService เป็น owner — claim/evidence/CAS)
  //   "delete" → ลบ row ด้วย exact-identity CAS · "leave" → ปล่อย/อัปเดตเองแล้ว
  classifyRow: (row: BufferMessageDoc) => Promise<"delete" | "leave">,
  // ⚡ recovery cancellation — AbortSignal จาก owner เดียว (botWorkerService)
  signal: AbortSignal | undefined,
  // ⚡ Phase 2D — admission scope snapshot ของ pass (REQUIRED — ทุก recovery
  //   enumeration ต้อง scoped; disabled (platform,shop) rows ไม่ถูก scan/แก้ไขเลย)
  scope: BotworkerCycleScope
): Promise<{ recovered: number; conversations: string[] }> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);

  // สแกนทุก row state ที่ต้อง reconcile (buffered/processing/failed — ไม่เอา lock/quarantined)
  const rows = await coll
    .find(withScope({ status: { $in: ["buffered", "processing", "failed"] }, kind: { $ne: "conv_lock" } }, scope))
    .toArray();

  let settled = 0;
  const conversations = new Set<string>();
  for (const row of rows) {
    if (signal?.aborted) break;
    const d = await classifyRow(row);
    conversations.add(row.conversation_id);
    if (d === "delete") {
      // ⚡ exact-identity delete — row ถูกแทนด้วย identity ใหม่หลัง classify → ห้ามลบ (TOCTOU)
      const del = await coll.deleteOne({
        message_id: row.message_id,
        claim_id: row.claim_id,
        status: row.status,
        owner_id: row.owner_id,
        fencing_token: row.fencing_token,
        kind: { $ne: "conv_lock" },
      });
      if (del.deletedCount === 1) settled++;
    }
  }
  if (rows.length === 0) {
    return { recovered: 0, conversations: [] };
  }
  console.log(`[buffer] reconciled ${settled} stale rows across ${conversations.size} conversations`);

  // audit write เป็น side-effect — cancelled run ไม่เขียน recovery event ต่อ
  if (!signal?.aborted) {
    await logAdminEvent({
      action_type: "bot.buffer_recover",
      actor: "bot-worker",
      metadata: {
        reconciled_rows: settled,
        conversation_ids: [...conversations],
      },
    });
  }

  return { recovered: settled, conversations: [...conversations] };
}

// ─── Clear all timers (สำหรับ graceful shutdown) ──────────

export function clearAllBufferTimers(): void {
  for (const [, timer] of bufferTimers.entries()) {
    clearTimeout(timer);
  }
  bufferTimers.clear();
}

export const bufferService = {
  bufferOrProcess,
  flushBuffer,
  recoverStaleBuffers,
  clearAllBufferTimers,
  activeFlushes,
};
