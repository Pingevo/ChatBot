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
//   - ตอน boot → recover stale buffers (flush เลย ไม่รอ)
//
// ⚠️ ปลอดภัย:
//   - ไม่ mark chat_processing ตอนเข้า buffer (กัน isProcessed ขัดกับ processMessage)
//   - ถ้า bot-worker restart ข้อความใน buffer_messages ยังอยู่ → recover ตอน boot
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
  status?: "buffered" | "processing";
  batch_id?: string;
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

// ─── In-memory timer map (per conversation) ───────────────
// timer อยู่ใน memory (ไม่ใช่ DB) — ถ้า restart หาย แต่ recover ตอน boot ช่วยได้
const bufferTimers = new Map<string, NodeJS.Timeout>();

// ─── Insert message into buffer_messages collection ───────

async function insertToBuffer(msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  claimContext?: ClaimContext;
}): Promise<void> {
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
      // ⚡ claim ก่อนเข้า buffer เสมอ — row ถือ ClaimContext ไปให้ batch processor
      kind: "message",
      status: "buffered",
      claim_id: msg.claimContext?.claim_id,
      owner_id: msg.claimContext?.owner_id,
      fencing_token: msg.claimContext?.fencing_token,
    });
  } catch (e) {
    // row มีอยู่แล้ว (re-poll ขณะ claim processing) → ไม่ re-buffer ซ้ำ
    if ((e as { code?: number }).code === 11000) return;
    throw e;
  }
}

// ─── Get buffered messages for a conversation ─────────────
// อ่านเฉพาะ message rows (status buffered) — ห้ามดูด lock docs เข้า batch

async function getBufferedMessages(conversationId: string): Promise<BufferMessageDoc[]> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  return coll
    .find({ conversation_id: conversationId, status: "buffered", kind: { $ne: "conv_lock" } })
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
  conversationId: string,
  shopId: string,
  platform: Platform
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

// ─── Clear timer for a conversation ───────────────────────

function clearTimer(conversationId: string): void {
  const timer = bufferTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    bufferTimers.delete(conversationId);
  }
}

// ⚡ timer-launched flush ไม่มี parent promise ใน inFlight — track ไว้ให้ shutdown
//   drain (waitForInFlight) รอจนจบ; clear ใน finally-equivalent เสมอ (ไม่ใช่ queue/scheduler)
const activeFlushes = new Set<Promise<unknown>>();

// retry timer สำหรับ flush ที่แพ้ lock / error — ข้อความไม่หาย รอ batch ถัดไป
// ⚡ cadence ต่างกัน: lock contention = 50ms (winner ปล่อยเร็ว) /
//    flush error หรือ finalize ไม่ครบ = flushErrorRetryMs (backoff)
const flushRetryTimers = new Map<string, NodeJS.Timeout>();
const LOCK_RETRY_MS = 50;

function scheduleFlushRetry(
  conversationId: string,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn,
  delayMs: number = botworkerRuntime.flushErrorRetryMs,
  signal?: AbortSignal
): void {
  // ⚡ retry scheduling คือ side-effect boundary — cancelled run ห้ามฝาก timer ไว้
  if (signal?.aborted) return;
  if (flushRetryTimers.has(conversationId)) return;
  flushRetryTimers.set(
    conversationId,
    setTimeout(() => {
      flushRetryTimers.delete(conversationId);
      // ⚡ callback ต้องถือ signal เดิม — abort ที่มาหลัง timer fired ต้องถึง flush นี้ด้วย
      trackedFlush(conversationId, processMessage, markProcessed, signal).catch((err) =>
        console.error(`[buffer] retry flush error for ${conversationId}:`, err)
      );
    }, delayMs)
  );
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
// error → rows กลับ buffered + release lock — ข้อความไม่หาย

type ProcessMessageFn = (msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  images?: string[];  // ⚡ Phase 1F — image URLs รวมจากทุก message ใน buffer
  claimContext?: ClaimContext;
}) => Promise<{ status: string; detail: string; finalized: boolean; lost: boolean }>;

type MarkProcessedFn = (doc: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  status: "trigger_matched" | "bot_answered" | "handed_off" | "bot_failed" | "no_action" | "workflow_actioned" | "workflow_resumed" | "processing";
}) => Promise<void>;

// ⚡ trackedFlush — timer callback (debounce/retry) launch flush แบบไม่มี parent promise;
//   promise ต้องอยู่ใน activeFlushes เพื่อให้ shutdown drain รอ — clear เมื่อ settle เสมอ
//   (immediate flush / recovery flush มี parent อยู่แล้ว — inFlight p / recoveryInFlight)
function trackedFlush(
  conversationId: string,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn,
  signal?: AbortSignal
): Promise<{ status: string; detail: string }> {
  const p = flushBuffer(conversationId, processMessage, markProcessed, signal);
  activeFlushes.add(p);
  p.then(() => activeFlushes.delete(p), () => activeFlushes.delete(p));
  return p;
}

export async function flushBuffer(
  conversationId: string,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn,
  signal?: AbortSignal
): Promise<{ status: string; detail: string }> {
  // ล้าง timer
  clearTimer(conversationId);

  // ⚡ enabled boundary — debounce/retry/recovery callers ยิง flush เองได้ทุกเมื่อ
  //   ห้ามอาศัย main-loop gate อย่างเดียว: worker ปิด → ห้าม transition row →processing ใหม่
  const cfg = await getSystemConfig();
  if (!cfg.bot_worker_enabled) {
    return { status: "skip", detail: "worker disabled" };
  }

  // ดึงข้อความที่ buffer อยู่ (message rows เท่านั้น — lock docs ไม่ปน)
  const candidates = await getBufferedMessages(conversationId);
  if (candidates.length === 0) {
    return { status: "skip", detail: "no buffered messages" };
  }

  // ⚡ recovery abort — lock acquire คือ batch-transition boundary →
  //   cancelled run ห้ามเริ่ม transition (rows ยัง buffered → edge ถัดไปกู้ได้)
  if (signal?.aborted) {
    return { status: "skip", detail: "recovery aborted" };
  }

  // ── conv lock: flusher เดียวต่อ conversation ──
  const first = candidates[0];
  const lock = await acquireConvLock(conversationId, first.shop_id, first.platform);
  if (!lock) {
    // แพ้ lock → ข้อความค้าง buffered รอ batch ถัดไป (retry สั้น — winner ปล่อยเร็ว)
    scheduleFlushRetry(conversationId, processMessage, markProcessed, LOCK_RETRY_MS, signal);
    return { status: "skip", detail: "conv lock held by another flusher" };
  }

  // ── member selection: CAS buffered→processing ทีละ row ──
  //   ข้อความใหม่ที่เข้ามาหลังจุดนี้อยู่ buffered → batch ถัดไป (ไม่ดูดเข้ามา)
  //   ⚡ row identity = message_id (unique) — docs ที่ seed/push อาจไม่มี _id
  const memberIds: string[] = [];
  const rows: BufferMessageDoc[] = [];
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  try {
    for (const row of candidates) {
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

    // ── re-fence member claims — expected owner/token ของ row หรือ expired เท่านั้น ──
    //   ⚡ ห้ามแย่ง active claim ของ owner อื่น: match เฉพาะ (a) claim ยังเป็นของเรา
    //      ด้วย token ที่ row บันทึก (idempotent re-flush) หรือ (b) lease หมดแล้ว
    //   ⚡ claim fencing เป็น per-claim sequence ($inc) — ห้ามใช้ conv-lock token
    const procColl = await getCollection<Document & { _id?: string; status?: string }>(COLLECTIONS.chatProcessing);
    const now = new Date();
    const claimedIds: string[] = [];
    const claimedMsgIds: string[] = [];
    const fencingMap: Record<string, number> = {};
    let retryableLeft = false; // มี row ที่ยัง retry ได้ (foreign active claim) → ต้อง schedule retry
    for (const row of rows) {
      const claimId = row.claim_id || claimIdFor(row.message_id);
      const ref = await procColl.findOneAndUpdate(
        {
          _id: claimId,
          status: "processing",
          $or: [
            { owner_id: botworkerRuntime.ownerId, fencing_token: row.fencing_token },
            { lease_expires_at: { $lt: now } },
          ],
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
        fencingMap[claimId] = ref.fencing_token;
        // row ถือ expected identity ใหม่ → retry/next flush re-fence ได้ถูกต้อง
        await coll.updateOne(
          { message_id: row.message_id, kind: { $ne: "conv_lock" } },
          { $set: { owner_id: botworkerRuntime.ownerId, fencing_token: ref.fencing_token } }
        );
        continue;
      }
      // re-fence ไม่ผ่าน → แยกสาเหตุด้วย claim doc จริง (ห้ามตีรวนเป็น buffered ทุกกรณี):
      //   claim terminal/missing → settle message ตาม outcome ของ claim + ลบ row (ห้ามกลับ buffered)
      //   claim processing ของ owner อื่น active → คง buffered รอ owner finalize/lease หมด
      const claimDoc = await procColl.findOne({ _id: claimId });
      if (!claimDoc || claimDoc.status !== "processing") {
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
        retryableLeft = true;
      }
    }
    if (claimedIds.length === 0) {
      // ⚡ retryable rows ค้าง (foreign active) → ต้องมี retry เสมอ ไม่งั้นข้อความค้างตลอด
      if (retryableLeft) scheduleFlushRetry(conversationId, processMessage, markProcessed, undefined, signal);
      return { status: "skip", detail: "no owned claims in batch" };
    }

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
      });

      // ⚡ finalization contract — ลบ rows เฉพาะเมื่อ finalize ครบทุก member claim
      //   partial/lost → คืน buffered (claims ยัง processing → lease หมด → recovery)
      if (result.finalized) {
        await deleteBatchRows(claimedMsgIds);
      } else {
        await coll.updateMany(
          { message_id: { $in: claimedMsgIds }, kind: { $ne: "conv_lock" } },
          { $set: { status: "buffered" }, $unset: { batch_id: "" } }
        );
        scheduleFlushRetry(conversationId, processMessage, markProcessed, undefined, signal);
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
      // error → rows กลับ buffered (ข้อความไม่หาย) + schedule retry —
      //   claims ยัง owner/token เดิม → retry re-fence ผ่าน expected-owner ได้ทันที
      //   (ไม่ต้องรอ lease หมด) — ถ้า retry พังต่อเนื่อง lease หมด → recovery
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[buffer] flush error for ${conversationId}:`, errorMsg);
      await coll.updateMany(
        { message_id: { $in: claimedMsgIds }, kind: { $ne: "conv_lock" } },
        { $set: { status: "buffered" }, $unset: { batch_id: "" } }
      );
      scheduleFlushRetry(conversationId, processMessage, markProcessed, undefined, signal);
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
    claimContext?: ClaimContext; // ⚡ claim ก่อนเข้า buffer เสมอ — row ถือ ctx
  },
  config: BufferConfig,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn,
  // ⚡ enabled-era signal — debounce/retry callback ลูกต้องถือ signal เดียวกัน;
  //   ไม่ส่งมา (caller เก่า/recovery-less path) → signal-less เหมือนเดิม
  signal?: AbortSignal
): Promise<{ status: string; detail: string }> {
  // ⚡ era aborted — ห้ามเขียน buffer row / arm timer / launch flush ใหม่ใน cancelled era
  if (signal?.aborted) return { status: "skip", detail: "era aborted" };

  // ถ้าปิด buffer → ประมวลผลทันที (เหมือนเดิม)
  if (!config.bufferEnabled) {
    return processMessage(msg);
  }

  const convId = msg.conversation_id;

  // เพิ่มเข้า buffer_messages collection
  await insertToBuffer(msg);

  // ดึงจำนวนข้อความที่ buffer อยู่ใน conversation นี้
  const buffered = await getBufferedMessages(convId);

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
    return flushBuffer(convId, processMessage, markProcessed, signal);
  }

  // รีเซ็ต timer (debounce) — ใช้ window ตาม media
  clearTimer(convId);
  bufferTimers.set(
    convId,
    setTimeout(() => {
      // ⚡ cancelled era — callback ที่ fired ก่อน abort แต่ยังไม่ process → ออกเงียบ
      if (signal?.aborted) return;
      trackedFlush(convId, processMessage, markProcessed, signal).catch((err) =>
        console.error(`[buffer] timer flush error for ${convId}:`, err)
      );
    }, effectiveWindowMs)
  );

  return {
    status: "buffered",
    detail: `buffered (${buffered.length} msgs, ${hasAnyMedia ? "media" : "text"} window ${effectiveWindowMs}ms)`,
  };
}

// ─── Recover stale buffers ตอน boot ───────────────────────
// ถ้า bot-worker restart ขณะมีข้อความค้างใน buffer_messages
// → flush เลย (ไม่รอ timer เพราะ timer หายแล้ว)

export async function recoverStaleBuffers(
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn,
  // ⚡ row classifier (botWorkerService เป็น owner — claim/evidence/freshness/CAS)
  //   "fresh" → เข้า batch flush ปกติ · "delete" → row ถูก settle แล้ว ลบทิ้ง · "leave" → ปล่อยไว้
  classifyRow?: (row: BufferMessageDoc) => Promise<"fresh" | "delete" | "leave">,
  // ⚡ recovery cancellation — AbortSignal จาก owner เดียว (botWorkerService);
  //   flush ที่ launch ด้วย signal นี้ตรวจก่อน batch transition/processMessage
  signal?: AbortSignal
): Promise<{ recovered: number; conversations: string[] }> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);

  // หา conversation ที่มีข้อความค้าง (เฉพาะ buffered message rows — ไม่เอา lock docs)
  let staleConvIds: string[];
  if (classifyRow) {
    // per-row evidence/freshness gate — stale/orphan rows ถูกกำจัดก่อน flush
    //   → ห้ามถูกดูดเข้า batch ของ conversation เดียวกัน
    //   ⚡ รวม status:"processing" (crash-leftover mid-flush) — classifier ตัดสิน owner จาก claim
    const rows = await coll
      .find({ status: { $in: ["buffered", "processing"] }, kind: { $ne: "conv_lock" } })
      .toArray();
    const fresh = new Set<string>();
    for (const row of rows) {
      const d = await classifyRow(row);
      if (d === "fresh") fresh.add(row.conversation_id);
      else if (d === "delete") {
        // ⚡ exact-identity delete — row ถูกแทนด้วย identity ใหม่หลัง classify → ห้ามลบ (TOCTOU)
        await coll.deleteOne({
          message_id: row.message_id,
          claim_id: row.claim_id,
          status: row.status,
          owner_id: row.owner_id,
          fencing_token: row.fencing_token,
          kind: { $ne: "conv_lock" },
        });
      }
    }
    staleConvIds = [...fresh];
  } else {
    staleConvIds = await coll.distinct("conversation_id", { status: "buffered", kind: { $ne: "conv_lock" } });
  }
  if (staleConvIds.length === 0) {
    return { recovered: 0, conversations: [] };
  }

  console.log(`[buffer] recovering ${staleConvIds.length} stale conversations from buffer_messages`);

  const conversations: string[] = [];
  for (const convId of staleConvIds) {
    try {
      await flushBuffer(convId, processMessage, markProcessed, signal);
      conversations.push(convId);
    } catch (err) {
      console.error(`[buffer] recovery error for ${convId}:`, err);
    }
  }

  // audit write เป็น side-effect — cancelled run ไม่เขียน recovery event ต่อ
  if (!signal?.aborted) {
    await logAdminEvent({
      action_type: "bot.buffer_recover",
      actor: "bot-worker",
      metadata: {
        recovered_conversations: conversations.length,
        conversation_ids: conversations,
      },
    });
  }

  return { recovered: conversations.length, conversations };
}

// ─── Clear all timers (สำหรับ graceful shutdown) ──────────

export function clearAllBufferTimers(): void {
  for (const [convId, timer] of bufferTimers.entries()) {
    clearTimeout(timer);
  }
  bufferTimers.clear();
  // flush-retry timers เป็น pending work เหมือนกัน — falling edge/shutdown ต้องยกเลิกรวม
  for (const [convId, timer] of flushRetryTimers.entries()) {
    clearTimeout(timer);
  }
  flushRetryTimers.clear();
}

export const bufferService = {
  bufferOrProcess,
  flushBuffer,
  recoverStaleBuffers,
  clearAllBufferTimers,
  activeFlushes,
};
