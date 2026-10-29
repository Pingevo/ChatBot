// Bot Worker Service — Pipeline ประมวลผลข้อความใหม่
// 
// Flow:
//   แชทใหม่เข้า (messages_shp, role=user, direction=in)
//     → check trigger
//       → แมทช์ + bot_answer → เรียกบอท → เก็บใน shadow_replies (ดูใน Shadow Inbox)
//       → แมทช์ + handoff_admin → จ่ายงาน round-robin → เขียน assigned_to ลง conversations_shp
//       → ไม่แมทช์ → เรียกบอท → เก็บใน shadow_replies
//         → บอทส่งต่อ → จ่ายงาน round-robin
//
// ⚠️ SAFETY:
//   - อ่าน messages_shp / conversations_shp (READ-ONLY สำหรับเนื้อหาแชท)
//   - เขียน assigned_to ลง conversations_shp (พี่เขาให้เราใช้ test)
//   - คำตอบบอทเก็บใน shadow_replies (ไม่เขียนลง messages_shp — ไม่ปนกับแชทจริง)
//   - ไม่ call Shopee API
//   - ไม่ส่งข้อความจริงให้ลูกค้า
//   - ไม่ยุ่งกับ sellcenter
import { Document, ObjectId } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
// ⚡ claim coordinator boundary — internal constants + canonical identities (ไม่ใช่ SystemConfig/UI)
import {
  botworkerRuntime,
  claimIdFor,
  batchIdFor,
  replyIdFor,
  wfReplyId,
  opIdFor,
  withScope,
  resolveBotworkerScope,
  type BotworkerCycleScope,
  type ShopMessageContext,
  type BotworkerScopePair,
  type ClaimContext,
} from "./botworkerRuntime";

export type { ClaimContext } from "./botworkerRuntime";
import { assignmentService } from "./assignmentService";
import { listMessages, getHistoryForBot, getGroupedHistoryForBot, toBotText, toBotImages, type MessageDoc } from "./messageService";
import { getConversation } from "./conversationService";
import { handoffService } from "./handoffService";
import { assertPlatformApiDisabled, BOTWORKER_BACKENDS, type Platform } from "../lib/safety";
import type { ShadowReplyDoc } from "./shadowReplyService";
import { bufferService, type BufferConfig, type BufferMessageDoc } from "./bufferService";
import { getSystemConfig, type SystemConfigDoc } from "./systemConfigService";
// ⚡ callBot ย้ายไป botCallService (แก้ circular dependency กับ workflowEngine)
import { callBot } from "./botCallService";
// ⚡ Workflow engine (แบบ Zaapi Flow Builder) — ① resume ② priority ③ บอท
import { workflowEngine, type EngineResult, type DeliveredMessage } from "./workflowEngine";
// ⚡ botworker parallel sandbox — event log แยกจาก admin_logs + test status store
import { logBotworkerEvent } from "./botworkerEventService";
import { logAdminEvent } from "./adminLogService";
import { testStatusConversationService } from "./testStatusConversationService";

// ⚡ parallel sandbox — source ของ test_status_conversation ที่ worker ใช้
const WORKER_SOURCE = "botworker" as const;

// ─── Types ────────────────────────────────────────────────

export type ChatProcessingStatus =
  | "processing" | "trigger_matched" | "bot_answered" | "handed_off"
  | "bot_failed" | "no_action" | "workflow_actioned" | "workflow_resumed";

export interface ChatProcessingDoc extends Document {
  // _id: legacy = ObjectId (ข้อมูลเดิมคงอยู่) / claim ใหม่ = string "botworker:claim:<mid>"
  //   (InferIdType → string: claim ops เขียน deterministic _id ตรงๆ)
  _id?: string;
  message_id: string;           // id ของข้อความที่ประมวลผลแล้ว
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  status: ChatProcessingStatus;
  trigger_id?: string;
  trigger_action?: "bot_answer" | "handoff_admin";
  shadow_reply_id?: string;     // ref to shadow_replies
  assigned_to?: string;         // admin_id ที่ถูกจ่ายงาน (ถ้า handoff)
  assignment_mode?: string;
  error?: string;
  processed_at: Date;
  // ── claim / fencing fields (deterministic _id = "botworker:claim:<message_id>") ──
  owner_id?: string;            // worker instance ที่ถือ claim อยู่
  fencing_token?: number;       // เพิ่มทุก reclaim — stale owner เขียนไม่ติด
  lease_expires_at?: Date;      // หมดอายุ → worker อื่น reclaim ได้
  attempt?: number;             // เพิ่มทุก reclaim — เกิน maxClaimAttempts → bot_failed
  batch_id?: string;            // canonical sha256 batch identity
  outcome_type?: ChatProcessingStatus; // terminal outcome ที่บันทึกก่อน finalize
  reply_ids?: string[];         // shadow reply ids ของ batch นี้
  side_effects?: { type: string; ref?: string | null; workflow_id?: string; at: Date }[];
  claimed_at?: Date;
  updated_at?: Date;
}

const CLAIM_TERMINAL_STATUSES = new Set<ChatProcessingStatus>([
  "trigger_matched", "bot_answered", "handed_off", "bot_failed",
  "no_action", "workflow_actioned", "workflow_resumed",
]);

// ─── ClaimContext — poll → buffer row → batch processor ────
// (type อยู่ใน botworkerRuntime — re-export ด้านบน)

// ─── Bot Caller — ย้ายไป botCallService.ts (re-export ผ่าน botWorkerService ด้านล่าง) ──

// ─── Check if message already processed ───────────────────
// backward-compat: legacy ObjectId docs (status terminal) นับว่า processed
// claim docs ที่ยัง processing = ยังไม่เสร็จ → ผ่านเข้า claim attempt

async function isProcessed(messageId: string): Promise<boolean> {
  const coll = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const existing = await coll.findOne({ message_id: messageId, status: { $in: [...CLAIM_TERMINAL_STATUSES] } });
  return !!existing;
}

// claims ที่กำลังทำงานอยู่ใน process นี้ — กัน re-entry ขณะ owner=ตัวเอง
const activeClaims = new Set<string>();

function ctxFromDoc(doc: ChatProcessingDoc): ClaimContext {
  return {
    claim_id: String(doc._id),
    claim_ids: [String(doc._id)],
    owner_id: doc.owner_id || botworkerRuntime.ownerId,
    fencing_token: doc.fencing_token || 1,
    lease_expires_at: doc.lease_expires_at || new Date(),
    batch_id: doc.batch_id || batchIdFor(doc.platform, doc.shop_id, doc.conversation_id, [doc.message_id]),
    message_ids: [doc.message_id],
    lost: false,
  };
}

// ─── finalize — terminal write ต้อง fenced เสมอ ────────────
// filter {_id ∈ claim_ids, owner_id, fencing_token, status:"processing"}
// → stale worker เขียนไม่ติด (matchedCount=0)

interface ClaimOutcome {
  type: ChatProcessingStatus;
  reply_ids: string[];
  side_effects?: { type: string; ref?: string | null; workflow_id?: string; at: Date }[];
  extra?: Partial<ChatProcessingDoc>;
}

// fenced filter ต่อ claim — fencing_map (batch, per-claim token) หรือ shared token (direct)
function claimFenceFilter(ctx: ClaimContext): Record<string, unknown> {
  if (ctx.fencing_map) {
    return {
      $or: ctx.claim_ids.map((id) => ({
        _id: id,
        owner_id: ctx.owner_id,
        fencing_token: ctx.fencing_map![id],
      })),
      status: "processing",
    };
  }
  return {
    _id: { $in: ctx.claim_ids },
    owner_id: ctx.owner_id,
    fencing_token: ctx.fencing_token,
    status: "processing",
  };
}

async function finalizeClaims(ctx: ClaimContext, outcome: ClaimOutcome): Promise<number> {
  const coll = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const res = await coll.updateMany(
    claimFenceFilter(ctx),
    {
      $set: {
        status: outcome.type,
        outcome_type: outcome.type,
        reply_ids: outcome.reply_ids,
        side_effects: outcome.side_effects || [],
        processed_at: new Date(),
        updated_at: new Date(),
        ...(outcome.extra || {}),
      },
    }
  );
  return res.modifiedCount;
}

// ─── heartbeat — extend lease ขณะ external call ทำงาน ──────
// update ด้วย fencing filter → matchedCount=0 = lost ownership
// → abort signal + ctx.lost → ห้าม persist/finalize

function startHeartbeat(ctx: ClaimContext, abortCtrl: AbortController): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const coll = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
      const res = await coll.updateMany(
        claimFenceFilter(ctx),
        { $set: { lease_expires_at: new Date(Date.now() + botworkerRuntime.claimLeaseMs), updated_at: new Date() } }
      );
      if (res.modifiedCount !== ctx.claim_ids.length) {
        ctx.lost = true;
        abortCtrl.abort();
      }
    } catch {
      // heartbeat error → ปล่อย lease หมดอายุเอง (ปลอดภัยกว่าเขียนทับ)
    }
  }, botworkerRuntime.heartbeatMs);
}

// ─── findPersistedReplies — recovery check ก่อนเรียก LLM ซ้ำ ──
// reply ใช้ deterministic _id จาก batch_id → มีแล้ว = persist ไปแล้ว
// ⚡ outcome มาจาก outcome_envelope บน reply doc — ห้ามเดาจากชื่อ reply

interface OutcomeEnvelope {
  outcome_type: ChatProcessingStatus;
  trigger_id?: string;
  trigger_action?: string;
  workflow_id?: string;
  side_effects?: { type: string; ref?: string | null; workflow_id?: string; at: Date }[];
}

async function findPersistedReplies(batchId: string | undefined): Promise<{
  ids: string[];
  workflow: boolean;
  envelope?: OutcomeEnvelope;
}> {
  if (!batchId) return { ids: [], workflow: false };
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const base = replyIdFor(batchId);
  const normal = await coll.findOne({ _id: base } as Partial<ShadowReplyDoc>);
  const wf = await coll
    .find({ _id: { $regex: `^${base}:wf` } } as unknown as Partial<ShadowReplyDoc>)
    .toArray();
  const ids = [...(normal ? [base] : []), ...wf.map((d) => String(d._id))];
  const envelope = (normal as { outcome_envelope?: OutcomeEnvelope } | null)?.outcome_envelope
    || (wf[0] as { outcome_envelope?: OutcomeEnvelope } | undefined)?.outcome_envelope;
  return { ids, workflow: wf.length > 0, envelope };
}

// ─── dormant row transition (claim owner เดียว) ──
//   settle claim → terminal แล้ว mark rows ของ claim นั้นเป็น dormant state:
//   "failed" = carryable (inbound ใหม่ distinct ใน conv เดียวกันปลุกได้)
//   "quarantined" = attempt cap หมด → terminal batch (ไม่ carry ตลอดกาล)
async function markRowsDormant(claimId: string, to: "failed" | "quarantined", error?: string): Promise<void> {
  const bufColl = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  if (to === "quarantined") {
    await bufColl.updateMany(
      { claim_id: claimId, kind: { $ne: "conv_lock" }, status: { $in: ["buffered", "processing", "failed"] } },
      { $set: { status: "quarantined" } }
    );
    return;
  }
  // failed — ไม่ทับ rows ที่ dormant อยู่แล้ว (เก็บ error class เดิมไว้)
  await bufColl.updateMany(
    { claim_id: claimId, kind: { $ne: "conv_lock" }, status: { $in: ["buffered", "processing"] } },
    { $set: { status: "failed", error: error ?? "interrupted_before_durable_outcome", failed_at: new Date() } }
  );
}

// ─── claimMessage — single concurrent owner via deterministic _id ──
//   absent → insert claim (E11000 = loser)
//   processing + active lease + owner อื่น → loser
//   processing + active lease + owner=ตัวเอง + ไม่ได้ in-flight → reuse ctx (buffer flush)
//   processing + expired lease → reconcile-only (provider=0):
//     evidence → finalize-only · ไม่มี → settle bot_failed dormant · cap → terminal
//   terminal → skip (ไม่แตะอีก — bot_failed ถูก revive ผ่าน carry-forward เท่านั้น)
//   legacy terminal docs → skip (backward compat)

async function claimMessage(msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
}, signal?: AbortSignal): Promise<
  | { kind: "claimed"; ctx: ClaimContext }
  | { kind: "skip"; detail: string }
  | { kind: "finalized"; status: string; detail: string }
> {
  // ⚡ claim/reclaim คือ side-effect boundary — aborted recovery ห้าม claim ใหม่
  //   (read เดิมจบได้ แต่ abort แล้วต้องไม่เริ่ม ownership write — ออกเงียบเป็น skip)
  if (signal?.aborted) return { kind: "skip", detail: "recovery aborted" };
  const coll = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const claimId = claimIdFor(msg.message_id);
  const now = new Date();
  const existing = await coll.findOne({ _id: claimId });

  if (existing) {
    // terminal → ไม่แตะอีกเลย
    if (existing.status !== "processing") {
      return { kind: "skip", detail: `claim terminal (${existing.status})` };
    }
    const leaseActive = (existing.lease_expires_at?.getTime() || 0) > now.getTime();
    // owner=ตัวเอง + กำลังทำอยู่ใน process นี้ → concurrent re-entry → skip
    if (existing.owner_id === botworkerRuntime.ownerId && activeClaims.has(claimId)) {
      return { kind: "skip", detail: "claim in-flight (self)" };
    }
    // owner=ตัวเอง + lease ยัง active → buffer flush path ที่ claim ไว้ตอนเข้า buffer
    if (existing.owner_id === botworkerRuntime.ownerId && leaseActive) {
      return { kind: "claimed", ctx: ctxFromDoc(existing) };
    }
    // lease active + owner อื่น → loser
    if (leaseActive) {
      return { kind: "skip", detail: "claim lease active (other owner)" };
    }
    // ⚡ abort ระหว่าง ownership read → ห้ามเริ่ม write: attempt-cap terminalize /
    //   reclaim CAS / $inc attempt — claim ต้องคงเดิมให้ recovery รอบถัดไปกู้
    if (signal?.aborted) return { kind: "skip", detail: "recovery aborted" };
    // expired → attempt cap → bot_failed terminal (ไม่วน)
    // ⚡ CAS บน doc ที่เห็นจริง — worker อื่น reclaim ก่อน → filter ไม่ match → ห้าม terminal ทับ
    //   dormant rows ของ batch ที่ cap หมด → quarantined (ไม่ carry ตลอดกาล)
    if ((existing.attempt || 1) >= botworkerRuntime.maxClaimAttempts) {
      const capped = await coll.updateOne(
        {
          _id: claimId,
          status: "processing",
          lease_expires_at: { $lt: now },
          owner_id: existing.owner_id,
          fencing_token: existing.fencing_token,
        },
        {
          $set: {
            status: "bot_failed",
            outcome_type: "bot_failed",
            error: "claim attempts exhausted",
            processed_at: new Date(),
            updated_at: new Date(),
          },
        }
      );
      if (capped.matchedCount === 1) await markRowsDormant(claimId, "quarantined");
      return { kind: "skip", detail: "claim attempts exhausted → bot_failed" };
    }
    // ⚡ expired lease — reconcile-only (provider=0, ไม่มี re-execution):
    //   committed outcome/reply → reclaim CAS เพื่อถือ fencing แล้ว finalize-only
    //   ไม่มี evidence → settle bot_failed dormant (rows → failed; inbound ใหม่
    //   distinct ใน conv เดียวกันเท่านั้นที่ carry-forward ต่อ)
    const found = existing.outcome_type
      ? { ids: [] as string[], workflow: false, envelope: undefined }
      : await findPersistedReplies(existing.batch_id);
    if (existing.outcome_type || found.ids.length > 0) {
      const reclaimed = await coll.findOneAndUpdate(
        { _id: claimId, status: "processing", lease_expires_at: { $lt: now } },
        {
          $set: {
            owner_id: botworkerRuntime.ownerId,
            lease_expires_at: new Date(now.getTime() + botworkerRuntime.claimLeaseMs),
            updated_at: now,
          },
          $inc: { fencing_token: 1, attempt: 1 },
        },
        { returnDocument: "after" }
      );
      if (!reclaimed) {
        return { kind: "skip", detail: "reclaim race lost" };
      }
      const ctx = ctxFromDoc(reclaimed);
      // recovery: outcome recorded แล้ว crash ก่อน finalize → finalize only
      if (reclaimed.outcome_type) {
        await finalizeClaims(ctx, {
          type: reclaimed.outcome_type,
          reply_ids: reclaimed.reply_ids || [],
          side_effects: reclaimed.side_effects || [],
        });
        return { kind: "finalized", status: reclaimed.outcome_type, detail: "recovered outcome → finalized" };
      }
      // recovery: reply persist แล้ว crash ก่อน finalize → finalize โดยไม่เรียก LLM ซ้ำ
      // ⚡ outcome จาก envelope บน reply doc — ห้ามเดา (trigger_matched/handed_off ≠ guessable)
      const env = found.envelope;
      const outcome = env?.outcome_type || (found.workflow ? "workflow_actioned" : "bot_answered");
      await finalizeClaims(ctx, {
        type: outcome,
        reply_ids: found.ids,
        side_effects: env?.side_effects || reclaimed.side_effects || [],
        extra: {
          ...(env?.trigger_id ? { trigger_id: env.trigger_id } : {}),
          ...(env?.trigger_action ? { trigger_action: env.trigger_action as ChatProcessingDoc["trigger_action"] } : {}),
          ...(env?.outcome_type === "handed_off" && env.side_effects?.[0]?.ref
            ? { assigned_to: env.side_effects[0].ref }
            : {}),
        },
      });
      return { kind: "finalized", status: outcome, detail: "reply persisted → finalized without LLM" };
    }
    // ไม่มี durable outcome → settle เป็น canonical dormant failure (provider=0)
    const settled = await coll.updateOne(
      {
        _id: claimId,
        status: "processing",
        lease_expires_at: { $lt: now },
        owner_id: existing.owner_id,
        fencing_token: existing.fencing_token,
      },
      {
        $set: {
          status: "bot_failed",
          outcome_type: "bot_failed",
          error: "interrupted_before_durable_outcome",
          processed_at: new Date(),
          updated_at: new Date(),
        },
      }
    );
    if (settled.matchedCount === 1) {
      await markRowsDormant(claimId, "failed", "interrupted_before_durable_outcome");
      return { kind: "skip", detail: "expired claim settled → bot_failed dormant" };
    }
    return { kind: "skip", detail: "settle CAS lost" };
  }

  // ไม่มี claim doc → legacy terminal check (backward compat 1,574 dup groups)
  const legacy = await coll.findOne({
    message_id: msg.message_id,
    status: { $in: [...CLAIM_TERMINAL_STATUSES] },
  });
  if (legacy) {
    return { kind: "skip", detail: "legacy terminal doc (backward compat)" };
  }

  // ⚡ abort ระหว่าง legacy lookup → ห้าม insert claim ใหม่ใน cancelled run
  if (signal?.aborted) return { kind: "skip", detail: "recovery aborted" };

  // insert claim ใหม่ — deterministic _id → E11000 = loser
  try {
    await coll.insertOne({
      _id: claimId,
      message_id: msg.message_id,
      conversation_id: msg.conversation_id,
      shop_id: msg.shop_id,
      platform: msg.platform,
      status: "processing",
      owner_id: botworkerRuntime.ownerId,
      fencing_token: 1,
      attempt: 1,
      lease_expires_at: new Date(now.getTime() + botworkerRuntime.claimLeaseMs),
      claimed_at: now,
      batch_id: batchIdFor(msg.platform, msg.shop_id, msg.conversation_id, [msg.message_id]),
      reply_ids: [],
      side_effects: [],
      updated_at: now,
    } as unknown as ChatProcessingDoc);
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      return { kind: "skip", detail: "claim E11000 — concurrent owner exists" };
    }
    throw e;
  }
  const doc = await coll.findOne({ _id: claimId });
  return { kind: "claimed", ctx: ctxFromDoc(doc!) };
}

// ─── Mark processed (legacy compat — bufferService signature) ──
// claim path ใหม่ใช้ finalizeClaims แทน; ฟังก์ชันนี้คงไว้ให้ caller เก่า

async function markProcessed(doc: Partial<Omit<ChatProcessingDoc, "_id" | "processed_at">> & {
  message_id: string; conversation_id: string; shop_id: string; platform: Platform; status: ChatProcessingDoc["status"];
}): Promise<void> {
  const coll = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  await coll.insertOne({
    ...doc,
    processed_at: new Date(),
  } as ChatProcessingDoc);
}

// ─── Store bot reply in shadow_replies (NOT messages_shp) ──

function genShadowReplyId(): string {
  return "sr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function storeBotReply(opts: {
  messageId: string;
  messageText: string;
  conversationId: string;
  shopId: string;
  platform: Platform;
  botResp: {
    answer: string;
    source?: string;
    model?: string;
    elapsed?: number;
    usage?: { prompt: number; output: number; total: number };
    cost?: number;
    products?: unknown[];
    image_desc?: string;
    chat_engine?: "legacy" | "v2" | "v3";
  };
  triggerId?: string;
  // ⚡ deterministic reply identity — E11000 = persist ไปแล้ว (recovery reuse)
  replyId?: string;
  batchId?: string;
  inboundMessageIds?: string[];
  // ⚡ outcome envelope — recovery อ่าน outcome_type/metadata จากตรงนี้ (ห้ามเดา)
  outcomeEnvelope?: OutcomeEnvelope;
}): Promise<string> {
  const shadowReplyId = opts.replyId || genShadowReplyId();
  const now = new Date();

  // หา Zaapi/sellcenter reply สำหรับ inbound message นี้ (ถ้ามี)
  const messages = await listMessages(opts.conversationId, { platform: opts.platform, limit: 50 });
  const inboundMsg = messages.find((m) => m.message_id === opts.messageId);
  const zaapiReply = inboundMsg
    ? messages.find(
        (m) =>
          m.direction === "out" &&
          m.role !== "user" &&
          m.source !== "admin" &&
          m.created_timestamp > inboundMsg.created_timestamp
      )
    : undefined;

  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  try {
    await coll.insertOne({
    _id: shadowReplyId as unknown as ObjectId,
    shadow_reply_id: shadowReplyId,
    conversation_id: opts.conversationId,
    shop_id: opts.shopId,
    platform: opts.platform,
    inbound_message_id: opts.messageId,
    inbound_message_ids: opts.inboundMessageIds,
    batch_id: opts.batchId,
    inbound_text: opts.messageText,
    bot_reply_text: opts.botResp.answer,
    bot_source: opts.botResp.source,
    bot_model: opts.botResp.model,
    bot_elapsed_ms: opts.botResp.elapsed != null ? Math.round(opts.botResp.elapsed * 1000) : undefined,  // bot คืนเป็นวินาที → ms
    bot_tokens: opts.botResp.usage,
    bot_cost_usd: opts.botResp.cost,
    bot_cost_thb: opts.botResp.cost ? opts.botResp.cost * 36 : undefined,
    bot_products: opts.botResp.products,
    zaapi_reply_text: zaapiReply?.text,
    zaapi_reply_message_id: zaapiReply?.message_id,
    ...(opts.outcomeEnvelope ? { outcome_envelope: opts.outcomeEnvelope } : {}),
    rating: "unrated",
    origin: "worker",  // สร้างจาก worker (auto pipeline)
    mode: "standalone",  // ⚡ Phase 2R — โหมด standalone (botworker รันอัตโนมัติ)
    trigger_id: opts.triggerId,
    chat_engine: opts.botResp.chat_engine || "legacy", // ⚡ บันทึก engine ที่ใช้
    bot_image_desc: opts.botResp.image_desc,           // ⚡ vision desc บน reply doc ด้วย (self-contained)
    created_at: now,
    updated_at: now,
  });
  } catch (e) {
    // E11000 = reply persist ไปแล้ว (crash recovery) — reuse id เดิม ไม่ insert ซ้ำ
    if ((e as { code?: number }).code === 11000) return shadowReplyId;
    throw e;
  }

  // ⚡ Phase 1A multimodal — เก็บ image_desc ที่ vision pass สกัดได้ ลงใน inbound message doc
  //    ทำให้ turn ถัดไปส่ง image_desc ใน history → bot ไม่ต้องอ่านรูปซ้ำ
  //    (แชร์กับของจริงได้ตาม requirement — เป็น additive cache field ไม่กระทบ ticket state)
  if (opts.botResp.image_desc) {
    const msgColl = await getCollection<MessageDoc>(COLLECTIONS.messages);
    await msgColl.updateOne(
      { message_id: opts.messageId },
      { $set: { image_desc: opts.botResp.image_desc } },
    );
  }

  return shadowReplyId;
}

// ─── Store workflow delivered messages in shadow_replies ──
// เหมือน storeBotReply แต่ origin="workflow" — 1 delivered message = 1 shadow reply
// ⚠️ inbound_message_id มี unique index — หลาย delivered ต่อ inbound เดียว → ต่อท้าย suffix __wf<N>
async function storeWorkflowDelivered(opts: {
  messageId: string;
  messageText: string;
  conversationId: string;
  shopId: string;
  platform: Platform;
  delivered: DeliveredMessage[];
  workflowId: string;
  // ⚡ deterministic identity — <batch reply id>:wf<i> → crash recovery dedupe ได้
  batchId?: string;
  inboundMessageIds?: string[];
  // ⚡ outcome envelope — recovery อ่าน outcome จริงจาก reply doc (ห้ามเดา)
  outcomeEnvelope?: OutcomeEnvelope;
}): Promise<string[]> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const ids: string[] = [];
  const now = new Date();
  for (let i = 0; i < opts.delivered.length; i++) {
    const d = opts.delivered[i];
    const shadowReplyId = opts.batchId ? wfReplyId(opts.batchId, i) : genShadowReplyId();
    try {
    await coll.insertOne({
      _id: shadowReplyId as unknown as ObjectId,
      shadow_reply_id: shadowReplyId,
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      platform: opts.platform,
      inbound_message_id: `${opts.messageId}__wf${i}`,
      inbound_message_ids: opts.inboundMessageIds,
      batch_id: opts.batchId,
      inbound_text: opts.messageText,
      bot_reply_text: d.text,
      ...(d.image_url ? { bot_reply_image_url: d.image_url } : {}),
      bot_source: d.source,
      ...(opts.outcomeEnvelope ? { outcome_envelope: opts.outcomeEnvelope } : {}),
      rating: "unrated",
      origin: "workflow",  // สร้างจาก workflow engine (Flow Builder)
      mode: "standalone",  // ⚡ Phase 2R — โหมด standalone (worker path)
      chat_engine: "legacy", // ⚡ workflow ยังใช้ legacy path (ไม่ผ่าน callBot)
      created_at: now,
      updated_at: now,
    } as ShadowReplyDoc);
    } catch (e) {
      // E11000 = reply persist ไปแล้ว (crash recovery) — เก็บ id เดิม ไม่ insert ซ้ำ
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    ids.push(shadowReplyId);
  }
  return ids;
}

/** จัดการผล workflow แบบเดียวกันทั้ง resume และ match ใหม่ — deliver + outcome + return shape */
async function settleWorkflowResult(
  msg: { message_id: string; conversation_id: string; shop_id: string; platform: Platform },
  botText: string,
  wfResult: EngineResult,
  statusLabel: "workflow_actioned" | "workflow_resumed",
  ctx: ClaimContext
): Promise<{ status: string; detail: string; outcome: ClaimOutcome }> {
  // เก็บ delivered ลง shadow_replies (worker path — ไม่ส่งจริงเหมือนเดิม)
  // reply id deterministic ตาม batch → recovery dedupe ได้ / ไม่ insert ซ้ำ
  // ⚡ envelope ต้องสะท้อน outcome จริง — wf handoff คือ handed_off ไม่ใช่ workflow_actioned
  const intendedOutcome: ChatProcessingStatus = wfResult.handoff ? "handed_off" : statusLabel;
  const envelope: OutcomeEnvelope = {
    outcome_type: intendedOutcome,
    workflow_id: wfResult.workflow_id,
    ...(wfResult.handoff
      ? { side_effects: [{ type: "workflow_handoff", workflow_id: wfResult.workflow_id, ref: wfResult.handoff.agentId, at: new Date() }] }
      : {}),
  };
  const shadowReplyIds = await storeWorkflowDelivered({
    messageId: msg.message_id,
    messageText: botText,
    conversationId: msg.conversation_id,
    shopId: msg.shop_id,
    platform: msg.platform,
    delivered: wfResult.delivered,
    workflowId: wfResult.workflow_id || "",
    batchId: ctx.batch_id,
    inboundMessageIds: ctx.message_ids,
    outcomeEnvelope: envelope,
  });

  if (wfResult.handoff) {
    // assign_ticket action → จ่ายงานแล้ว (engine ทำแล้วใน test store — idempotent ด้วย operation_key)
    await logBotworkerEvent({
      type: "workflow",
      actor: "bot-worker",
      conversation_id: msg.conversation_id,
      shop_id: msg.shop_id,
      platform: msg.platform,
      metadata: {
        workflow_id: wfResult.workflow_id,
        assigned_to: wfResult.handoff.agentId,
        delivered_to_platform: false,
      },
    });
    return {
      status: "workflow_handed_off",
      detail: `${wfResult.detail} → ${wfResult.handoff.agentId || "no agent"}`,
      outcome: {
        type: "handed_off",
        reply_ids: shadowReplyIds,
        side_effects: envelope.side_effects,
        extra: { assigned_to: wfResult.handoff.agentId || undefined },
      },
    };
  }

  await logBotworkerEvent({
    type: "workflow",
    actor: "bot-worker",
    conversation_id: msg.conversation_id,
    shop_id: msg.shop_id,
    platform: msg.platform,
    metadata: {
      workflow_id: wfResult.workflow_id,
      shadow_reply_ids: shadowReplyIds,
      delivered_to_platform: false,
    },
  });
  return {
    status: statusLabel,
    detail: wfResult.detail,
    outcome: { type: statusLabel, reply_ids: shadowReplyIds },
  };
}

// ─── Pick next agent — ใช้ handoffService เพื่อหา admin เดิมก่อน round-robin ──
// ลำดับ:
//   1. ถ้ามี assigned_to อยู่แล้ว → ใช้คนเดิม
//   2. ถ้าไม่มี → หา admin คนสุดท้ายที่เคยตอบ (getLastReplyAdmin)
//   3. ถ้าไม่มี → round-robin (reserveNextAgent ผ่าน handoffToAdminTest)
//   4. ถ้า conversation ปิดอยู่ → reopen ก่อน
//
// ⚡ botworker parallel sandbox — ใช้ handoffToAdminTest เท่านั้น
//   เขียนเฉพาะ test_status_conversation (source=botworker) + cursor *:botworker
//   ไม่แตะ status_conversation จริง — assign สำเร็จ → status="open" (แอดมินรับงานจริง)
//   หา admin ไม่ได้ → pending_assignment=true + status="handoff" (รอ distributor)
async function pickAgent(
  shopId: string,
  platform: Platform,
  conversationId: string,
  reason?: string,
  operationKey?: string
): Promise<{ agentId: string | null; mode: string; inFlight?: boolean }> {
  const mode = await assignmentService.getActiveAssignmentConfig();
  const result = await handoffService.handoffToAdminTest({
    conversationId,
    shopId,
    platform,
    reason: reason || "bot-worker handoff",
    source: WORKER_SOURCE,
    assignedStatus: "open",
    // ⚡ deterministic op key — crash retry ด้วย key เดิมจะไม่ assign ซ้ำ
    //   (dedupe อยู่ที่ handoff owner — botworker_events)
    operationKey,
  });
  if (result.in_flight) return { agentId: null, mode, inFlight: true };
  await logBotworkerEvent({
    conversation_id: conversationId,
    type: result.assignedTo ? "handoff" : "bot_handoff",
    actor: "bot-worker",
    shop_id: shopId,
    platform,
    metadata: {
      reason: reason || "bot-worker handoff",
      assigned_to: result.assignedTo,
      assignment_reason: result.assignmentReason,
      pending: !result.assignedTo,
    },
  });
  return { agentId: result.assignedTo, mode };
}

// ─── Process one message ──────────────────────────────────
// processMessage = thin wrapper: claimMessage → processClaimedMessage → finalizeClaims
//   E11000/lease-active = loser → skip ก่อน LLM
//   outcome/reply อยู่แล้ว (crash recovery) → finalize only ไม่ re-execute
//   caller ที่มี ClaimContext อยู่แล้ว (batch flusher) → ข้าม claim ตรงเข้า core

export async function processMessage(msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  images?: string[];  // ⚡ Phase 1F — image URLs รวมจาก buffer flush
  claimContext?: ClaimContext; // ⚡ batch flusher ส่ง ctx ของ member claims มา — ห้าม claim ซ้ำ
  // ⚡ resolved shop context จาก scope pair — REQUIRED (resolver owner เดียว attach
  //   ที่ poll/flush); caller ที่ขาด ctx = contract violation → fail closed
  shop_ctx: ShopMessageContext;
  // ⚡ outer cancellation signal — era (kill switch/shutdown) / recovery abort
  //   combine กับ claim ownership heartbeat เป็น claimSignal เดียว → ไหลถึง
  //   processClaimedMessage → engineMsg → callBot queue/fetch
}, signal?: AbortSignal): Promise<{ status: string; detail: string; finalized: boolean; lost: boolean }> {
  // ⚡ contract boundary — shop_ctx ต้องมาจาก resolved scope pair เสมอ (poll/flush
  //   attach); ขาด ctx = caller violate contract → reject ก่อน claim (fail closed)
  if (!msg.shop_ctx || !msg.shop_ctx.config_shop_key || !msg.shop_ctx.shopname) {
    throw new Error("processMessage: shop_ctx {config_shop_key,shopname} required — resolve scope ก่อนส่งเข้า");
  }
  let ctx = msg.claimContext;
  if (!ctx) {
    const claimed = await claimMessage(msg);
    if (claimed.kind === "skip") {
      return { status: "skip", detail: claimed.detail, finalized: false, lost: false };
    }
    if (claimed.kind === "finalized") {
      return { status: claimed.status, detail: claimed.detail, finalized: true, lost: false };
    }
    ctx = claimed.ctx;
  }

  // ⚡ activeClaims = executor registry — batch ต้อง track ครบทุก member claim
  //   (recovery เจอ same-owner + in-flight → leave ได้เพราะ executor จริงอยู่)
  for (const id of ctx.claim_ids) activeClaims.add(id);
  const abortCtrl = new AbortController();
  // ⚡ claim signal = era cancellation + claim ownership — source รวมเดียวสำหรับ
  //   outbound/queue/finalize boundary (timeout อยู่ใน callBot ไม่ใช่ที่นี่)
  const claimSignal = signal
    ? AbortSignal.any([signal, abortCtrl.signal])
    : abortCtrl.signal;
  const heartbeat = startHeartbeat(ctx, abortCtrl);
  try {
    const res = await processClaimedMessage(msg, ctx, claimSignal);
    // fenced finalize — heartbeat lost (matchedCount=0) → ห้าม persist/finalize
    // ⚡ finalization contract: finalized เมื่อ terminal write ครบทุก claim_ids เท่านั้น
    //    lost/no-outcome → finalized=false → caller (flush) ห้ามลบ buffer rows
    // ⚡ cancellation fence — era abort หลัง provider response แต่ก่อน finalize
    //    → claim ค้าง processing (recoverable); evidence ที่ persist ไปแล้วถูก
    //    recovery reuse — ห้าม finalize ใน cancelled era
    let finalized = false;
    if (res.outcome && !ctx.lost && !claimSignal.aborted) {
      const n = await finalizeClaims(ctx, res.outcome);
      finalized = n === ctx.claim_ids.length;
    }
    return { status: res.status, detail: res.detail, finalized, lost: ctx.lost };
  } finally {
    clearInterval(heartbeat);
    for (const id of ctx.claim_ids) activeClaims.delete(id);
  }
}

// processing core — ต้องได้ ctx มาเท่านั้น (ห้าม claim เอง)
async function processClaimedMessage(msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  images?: string[];
  claimContext?: ClaimContext;
  shop_ctx: ShopMessageContext; // ⚡ resolved scope context — required contract
}, ctx: ClaimContext, signal: AbortSignal): Promise<{ status: string; detail: string; outcome?: ClaimOutcome }> {
  // ⛔ Safety guard — กันเรียก platform API โดยไม่ตั้งใจ
  assertPlatformApiDisabled(msg.platform, "send");
  assertPlatformApiDisabled(msg.platform, "read");

  // ⚡ shop context — resolved scope ctx เท่านั้น (required — processMessage ปฏิเสธ
  //   caller ที่ไม่ส่ง): msg.shop_id = transport id เสมอ; config_shop_key =
  //   shops.shop_id (config-record domain); shopname = catalog key → /chat `shop`
  //   ไม่มี identity fallback — transport id ไม่เคยเป็น product/persona key
  const conv = await getConversation(msg.conversation_id);
  const configShopKey = msg.shop_ctx.config_shop_key;
  const shopName = msg.shop_ctx.shopname;

  // ── Guard: ตรวจสถานะ conversation จาก test_status_conversation (source=botworker) เท่านั้น ──
  // ⚡ botworker parallel sandbox — ไม่อ่าน/ไม่เขียน status_conversation จริง
  //   state ของแชทใน botworker แยกจาก /tickets สมบูรณ์
  //
  // 1. ถ้ามี assigned_to หรือ status=open/handoff → ข้าม (แอดมินใน sandbox กำลังตอบ / รอ pool)
  // 2. ถ้า status === closed → reopen ใน test store + ประมวลผลปกติ (ลูกค้าทักซ้ำเข้าลูปเดิม)
  // 3. ถ้าไม่มี doc / status=bot → ประมวลผลปกติ
  if (conv) {
    const meta = await testStatusConversationService.getTestStatus(msg.conversation_id, WORKER_SOURCE);
    const effectiveStatus = meta?.status || "bot";
    const effectiveAssignedTo = meta?.assigned_to || null;
    const isClosed = effectiveStatus === "closed" || effectiveStatus === "resolved";
    if (effectiveAssignedTo || (!isClosed && (effectiveStatus === "open" || effectiveStatus === "handoff"))) {
      // ⚡ Workflow guard — admin รับแชทแล้ว → flow ที่รอ reply ต้อง cancel อัตโนมัติ (planner ข้อ 3)
      await workflowEngine.cancelActiveRuns(
        msg.conversation_id,
        `admin ${effectiveAssignedTo || "(pending)"} กำลังดูแชท — cancel flow ที่รอ reply`
      );
      // แอดมินกำลังดูแชทอยู่ (หรือรอ assign ใน pool) → ข้าม (บอทเงียบ)
      return {
        status: "skip_assigned",
        detail: `test store: status=${effectiveStatus} assigned_to=${effectiveAssignedTo || "none"} — skip`,
        outcome: { type: "no_action", reply_ids: [] },
      };
    }
    if (isClosed) {
      // ⚡ ลูกค้าทักซ้ำหลังปิดแชท → reopen ใน test store เข้าลูปเดิม
      //   targetStatus="bot" → เคลียร์ assigned_to + status=bot → บอทตอบต่อ (ตาม lifecycle)
      await testStatusConversationService.reopenTestConversation(
        msg.conversation_id,
        WORKER_SOURCE,
        undefined,
        "bot"
      );
    }
  }

  // ⚠️ Enrich text สำหรับ rich-media messages (item card, order card, ...)
  // ถ้าลูกค้าแชร์การ์ดสินค้า `text` จะเป็น placeholder "[item]" แต่ raw_payload มี item_id
  // แปลงเป็น tag "[สินค้า: <item_id>]" ที่ Python bot เข้าใจ ก่อนส่งให้ trigger/bot
  const botText = toBotText(msg);
  // ⚡ Phase 1A multimodal — ดึง URL รูปจาก raw_payload ส่งให้ bot ใน field images
  // ⚡ Phase 1F — ถ้ามี msg.images (จาก buffer flush รวมหลายรูป) ให้ใช้แทน toBotImages
  const botImages = msg.images && msg.images.length > 0 ? msg.images : toBotImages(msg);

  // ⚡ Phase 9 — single fixed-order dispatch owner (shared กับ Test Chat):
  //   active resume → new match → trigger → bot — หนึ่ง inbound = หนึ่ง terminal
  //   outcome; persisted workflow_priority เป็น inert legacy field (ไม่มี reader)
  const engineMsg = {
    message_id: msg.message_id,
    conversation_id: msg.conversation_id,
    shop_id: msg.shop_id,            // transport domain — run records/runtime identity
    config_shop_key: configShopKey,  // config domain — workflow/assignment matching
    shopname: shopName,              // catalog domain — engine bot calls (/chat shop)
    platform: msg.platform,
    text: botText,
    customer_id: conv?.customer_id,
    // ⚡ botworker parallel — engine เขียน side-effects ลง test store ไม่ใช่ของจริง
    testSource: WORKER_SOURCE,
    // ⚡ ส่ง media URLs (image/video) เข้า engine ด้วย — EngineMessage ไม่มี raw_payload
    //    ทำให้ toBotImages(engineMsg) ใน let_ai_respond คืน [] → ทิ้ง video URL
    ...(botImages.length > 0 ? { images: botImages } : {}),
    // ⚡ deterministic op key — engine dedupe run/assign ด้วย key เดิมตอน crash retry
    operation_key: opIdFor(ctx.claim_id, "workflow"),
    // ⚡ current-batch exclusion — let_ai_respond ตัด batch นี้ออกจาก history
    //   (ข้อความเดียวกันอยู่ใน msg.text/images แล้ว — ห้ามซ้ำเป็น history turn)
    exclude_message_ids: ctx.message_ids,
    // ⚡ claim signal (era+ownership) — let_ai_respond ส่งต่อให้ callBot:
    //   queued workflow call ต้องออกเมื่อ kill switch/ownership ตาย, fetch bounded ใน callBot
    signal,
  };

  // ⚡ try ต้องครอบ workflow sections ด้วย — matchAndRun/resumeFlow throw
  //   (callBot abort/provider error) ต้องไหลถึง classification catch เดียวด้านล่าง
  //   (signal.aborted → cancelled recoverable / else → bot_failed terminal)
  try {
    return await workflowEngine.runInboundDispatch<{
      status: string; detail: string; outcome?: ClaimOutcome;
    }>(engineMsg, msg.text, {
      workflowInFlight: (r) => ({ status: "in_flight", detail: r.detail }),
      workflowError: (r) => ({
        // ⚡ matched-path death (typed field — ไม่ classify จาก reason text): op/run
        //   ตายหลัง commit → side effect อาจเกิดโดยไม่มีหลักฐาน → terminal ห้าม fall
        status: "bot_failed",
        detail: r.detail,
        outcome: { type: "bot_failed", reply_ids: [], extra: { error: r.detail } },
      }),
      workflowHandled: async (r) => {
        const s = await settleWorkflowResult(msg, botText, r,
          r.status === "resumed" ? "workflow_resumed" : "workflow_actioned", ctx);
        return { status: s.status, detail: s.detail, outcome: s.outcome };
      },
      workflowExitDrop: (r) => ({
        status: "workflow_exit_drop",
        detail: r.detail,
        outcome: { type: "no_action", reply_ids: [] },
      }),
      triggerMatched: async (trigger) => {
        // ── แมทช์ trigger ──
        if (trigger.action === "handoff_admin") {
          // ส่งให้แอดมิน — round-robin (operation key → handoff owner dedupe ตอน crash retry)
          const { agentId, mode, inFlight } = await pickAgent(
            configShopKey, msg.platform, msg.conversation_id, undefined,
            opIdFor(ctx.claim_id, "handoff")
          );
          if (inFlight) {
            // ⚡ handoff op กำลังถูก caller อื่น execute — ห้าม finalize เป็น handed_off(ว่าง)
            return { status: "in_flight", detail: `handoff op in-flight for ${msg.conversation_id}` };
          }
          await logBotworkerEvent({
            type: "bot_handoff",
            actor: "bot-worker",
            conversation_id: msg.conversation_id,
            shop_id: msg.shop_id,
            platform: msg.platform,
            metadata: { trigger_id: trigger.trigger_id, assigned_to: agentId, delivered_to_platform: false },
          });
          // ⚡ AI ตัดสินว่าไม่ไหว → ปลุก workflow run ที่ park ai_bot ให้เดินเส้น escalate
          //   (Zaapi let_ai_respond → ai-chatbot-escalate edge) — ไม่มี run park อยู่ = no_match
          //   non-fatal: handoff สำเร็จแล้ว workflow error ห้ามทำ outcome พัง
          try {
            await workflowEngine.escalateAiRun(msg.conversation_id, msg as never);
          } catch (e) {
            await logBotworkerEvent({
              type: "workflow",
              actor: "bot-worker",
              conversation_id: msg.conversation_id,
              shop_id: msg.shop_id,
              platform: msg.platform,
              metadata: { action: "ai_escalate_error", error: e instanceof Error ? e.message : String(e) },
            });
          }
          return {
            status: "handed_off",
            detail: `trigger→handoff→${agentId || "no agent"}`,
            outcome: {
              type: "handed_off",
              reply_ids: [],
              side_effects: [{ type: "handoff", ref: agentId, at: new Date() }],
              extra: {
                trigger_id: trigger.trigger_id,
                trigger_action: "handoff_admin",
                assigned_to: agentId || undefined,
                assignment_mode: mode,
              },
            },
          };
        }

        // ⚡ bot_template — trigger bot_answer ที่ตั้ง template → ตอบ template ทันทีไม่เรียกบอท (เหมือน test-chat)
        if (trigger.bot_template) {
          const shadowReplyId = await storeBotReply({
            messageId: msg.message_id,
            messageText: botText,
            conversationId: msg.conversation_id,
            shopId: msg.shop_id,
            platform: msg.platform,
            botResp: { answer: trigger.bot_template, source: "trigger_bot_answer" },
            triggerId: trigger.trigger_id,
            replyId: replyIdFor(ctx.batch_id),
            batchId: ctx.batch_id,
            inboundMessageIds: ctx.message_ids,
            outcomeEnvelope: { outcome_type: "trigger_matched", trigger_id: trigger.trigger_id, trigger_action: "bot_answer" },
          });
          await logBotworkerEvent({
            type: "bot_reply",
            actor: "bot-worker",
            conversation_id: msg.conversation_id,
            shop_id: msg.shop_id,
            platform: msg.platform,
            metadata: { trigger_id: trigger.trigger_id, shadow_reply_id: shadowReplyId, used_bot_template: true, delivered_to_platform: false },
          });
          return {
            status: "trigger_matched",
            detail: `trigger→bot_template→${shadowReplyId}`,
            outcome: {
              type: "trigger_matched",
              reply_ids: [shadowReplyId],
              extra: { trigger_id: trigger.trigger_id, trigger_action: "bot_answer", shadow_reply_id: shadowReplyId },
            },
          };
        }

        // trigger.action === "bot_answer" → เรียกบอท → เก็บใน shadow_replies
        // ⚡ grouped history — รวม user messages ติดกันเป็น 1 turn + fallback Zaapi
        //    exclude current batch — ctx.message_ids อยู่ใน message/images ของ request แล้ว
        const history = await getGroupedHistoryForBot({
          conversationId: msg.conversation_id,
          platform: msg.platform,
          maxTurns: 10,
          includeSandboxAdmin: true,  // ⚡ merge botworker_messages (แอดมินใน parallel เคยตอบอะไร)
          excludeMessageIds: ctx.message_ids,
        });
        // ⚡ outbound concurrency อยู่ใน callBot (testSource=botworker) — owner เดียวครอบทุก path
        const botResp = await callBot({
          platform: msg.platform,
          message: botText,
          shopId: msg.shop_id,
          shopName,
          history,
          ...(botImages.length > 0 ? { images: botImages } : {}),
          // ⚡ Phase 2A — ส่ง conversationId + testSource (parallel sandbox — handoff เขียน test store)
          conversationId: msg.conversation_id,
          simulate: true,
          testSource: WORKER_SOURCE,
          // ⚡ claim signal (era+ownership) — timeout composition อยู่ใน callBot
          signal,
        });
        // heartbeat lost กลางคัน → stale owner — ห้าม persist/finalize
        if (ctx.lost) return { status: "lost_ownership", detail: "claim lost mid-bot-call" };
        const shadowReplyId = await storeBotReply({
          messageId: msg.message_id,
          messageText: botText,
          conversationId: msg.conversation_id,
          shopId: msg.shop_id,
          platform: msg.platform,
          botResp,
          triggerId: trigger.trigger_id,
          replyId: replyIdFor(ctx.batch_id),
          batchId: ctx.batch_id,
          inboundMessageIds: ctx.message_ids,
          outcomeEnvelope: { outcome_type: "trigger_matched", trigger_id: trigger.trigger_id, trigger_action: "bot_answer" },
        });
        await logBotworkerEvent({
          type: "bot_reply",
          actor: "bot-worker",
          conversation_id: msg.conversation_id,
          shop_id: msg.shop_id,
          platform: msg.platform,
          metadata: { trigger_id: trigger.trigger_id, shadow_reply_id: shadowReplyId, delivered_to_platform: false },
        });
        return {
          status: "trigger_matched",
          detail: `trigger→bot_answer→${shadowReplyId}`,
          outcome: {
            type: "trigger_matched",
            reply_ids: [shadowReplyId],
            extra: { trigger_id: trigger.trigger_id, trigger_action: "bot_answer", shadow_reply_id: shadowReplyId },
          },
        };
      },
      botFallback: async () => {
        // ⚡ grouped history — รวม user messages ติดกันเป็น 1 turn + fallback Zaapi
        //    exclude current batch — ctx.message_ids อยู่ใน message/images ของ request แล้ว
        const history = await getGroupedHistoryForBot({
          conversationId: msg.conversation_id,
          platform: msg.platform,
          maxTurns: 10,
          includeSandboxAdmin: true,  // ⚡ merge botworker_messages (แอดมินใน parallel เคยตอบอะไร)
          excludeMessageIds: ctx.message_ids,
        });
        // ⚡ outbound concurrency อยู่ใน callBot (testSource=botworker) — owner เดียวครอบทุก path
        const botResp = await callBot({
          platform: msg.platform,
          message: botText,
          shopId: msg.shop_id,
          shopName,
          history,
          ...(botImages.length > 0 ? { images: botImages } : {}),
          // ⚡ Phase 2A — ส่ง conversationId + testSource (parallel sandbox — handoff เขียน test store)
          conversationId: msg.conversation_id,
          simulate: true,
          testSource: WORKER_SOURCE,
          // ⚡ claim signal (era+ownership) — timeout composition อยู่ใน callBot
          signal,
        });
        // heartbeat lost กลางคัน → stale owner — ห้าม persist/finalize
        if (ctx.lost) return { status: "lost_ownership", detail: "claim lost mid-bot-call" };

        if (!botResp.answer || botResp.answer.trim() === "") {
          // บอทตอบไม่ได้ → ส่งต่อแอดมิน
          const { agentId, mode, inFlight } = await pickAgent(
            configShopKey, msg.platform, msg.conversation_id, "bot empty answer",
            opIdFor(ctx.claim_id, "handoff")
          );
          if (inFlight) {
            // ⚡ handoff op กำลังถูก caller อื่น execute — ห้าม finalize
            return { status: "in_flight", detail: `handoff op in-flight for ${msg.conversation_id}` };
          }
          await logBotworkerEvent({
            type: "bot_handoff",
            actor: "bot-worker",
            conversation_id: msg.conversation_id,
            shop_id: msg.shop_id,
            platform: msg.platform,
            metadata: { reason: "bot empty answer", assigned_to: agentId, delivered_to_platform: false },
          });
          return {
            status: "handed_off",
            detail: `no trigger→bot empty→handoff→${agentId || "no agent"}`,
            outcome: {
              type: "handed_off",
              reply_ids: [],
              side_effects: [{ type: "handoff", ref: agentId, at: new Date() }],
              extra: { assigned_to: agentId || undefined, assignment_mode: mode },
            },
          };
        }

        // บอทตอบได้ → persist reply idempotently → finalize ใน wrapper (ไม่เขียน messages_shp)
        const shadowReplyId = await storeBotReply({
          messageId: msg.message_id,
          messageText: botText,
          conversationId: msg.conversation_id,
          shopId: msg.shop_id,
          platform: msg.platform,
          botResp,
          replyId: replyIdFor(ctx.batch_id),
          batchId: ctx.batch_id,
          inboundMessageIds: ctx.message_ids,
          outcomeEnvelope: { outcome_type: "bot_answered" },
        });
        await logBotworkerEvent({
          type: "bot_reply",
          actor: "bot-worker",
          conversation_id: msg.conversation_id,
          shop_id: msg.shop_id,
          platform: msg.platform,
          metadata: { shadow_reply_id: shadowReplyId, delivered_to_platform: false },
        });
        return {
          status: "bot_answered",
          detail: `no trigger→bot→${shadowReplyId}`,
          outcome: {
            type: "bot_answered",
            reply_ids: [shadowReplyId],
            extra: { shadow_reply_id: shadowReplyId },
          },
        };
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // ⚡ cancellation ≠ provider error — kill switch (era) / ownership loss abort
    //   outbound+queue: claim คง processing → rising-edge recovery รับต่อ
    //   (timeout ของ fetch ไม่ abort claim signal → provider timeout ยังเป็น bot_failed)
    if (signal.aborted) {
      await logBotworkerEvent({
        type: "bot_cancelled",
        actor: "bot-worker",
        conversation_id: msg.conversation_id,
        shop_id: msg.shop_id,
        platform: msg.platform,
        metadata: { error: errorMsg },
      });
      return { status: "cancelled", detail: `cancelled: ${errorMsg}` };
    }
    // บอท error → บันทึก error — bot_failed terminal one-shot (ไม่ retry อัตโนมัติ)
    await logBotworkerEvent({
      type: "bot_error",
      actor: "bot-worker",
      conversation_id: msg.conversation_id,
      shop_id: msg.shop_id,
      platform: msg.platform,
      metadata: { error: errorMsg },
    });
    return {
      status: "bot_failed",
      detail: errorMsg,
      outcome: { type: "bot_failed", reply_ids: [], extra: { error: errorMsg } },
    };
  }
}

// ─── Poll for new messages ────────────────────────────────
// FIRE-AND-FORGET: แต่ละข้อความยิงไปประมวลผลแยกอิสระ ไม่รอคิว ไม่รอ batch
//   10 คำถามเข้าพร้อมกัน → ยิง 10 reqs ไปบอทพร้อมกัน → บอทตอบทีละคำตอบเสร็จก่อนก็ตอบก่อน
//   ไม่ใช่นั่งรอคำถามแรกเสร็จถึงเริ่มคำถามสอง และไม่ใช่รอทั้ง 10 เสร็จถึงส่งคำตอบ
//
// ─── Worker leadership — single active worker ต่อ production scope ──
// ⚡ singleton doc botworker_state._id="botworker:leader" — CAS vocabulary เดียว
//   กับ message claim (owner_id + fencing_token + lease_expires_at)
//   acquire/renew/takeover อยู่ใน ensureLeadership() ฟังก์ชันเดียว — admission
//   gates (poll/recovery/wait-timeout) เรียกผ่าน acquireWorkerLeadership() เท่านั้น
//   ห้าม duplicate CAS protocol หรือสร้าง owner ที่สอง

interface WorkerLeaderDoc extends Document {
  _id: string;
  owner_id: string;
  fencing_token: number;
  lease_expires_at: Date;
  updated_at: Date;
}

const WORKER_LEADER_ID = "botworker:leader";

// ⚡ fencing context ที่ admission capture — heartbeat renew ได้เฉพาะ ctx นี้
//   (owner_id+fencing_token ตรงเป๊ะ + lease ยังไม่หมด) — ห้าม takeover/reacquire
//   ผ่าน heartbeat; takeover เป็น admission-time operation เท่านั้น
interface LeaderCtx {
  owner_id: string;
  fencing_token: number;
}

let leaderCtx: LeaderCtx | null = null; // lease ctx ปัจจุบันของ process (null = ไม่ถือ/invalid)

// ⚡ bounded re-read หลัง CAS miss/E11000 — same-process concurrent admission
//   (poll+recovery ชนกันบน absent doc) ต้องเห็น winner ที่เป็น ownerId เดียวกัน
//   เป็น admission สำเร็จ ไม่ใช่ loss — re-read ครั้งเดียวเท่านั้น ห้าม loop
async function rereadLeaderForOwner(
  coll: Awaited<ReturnType<typeof getCollection<WorkerLeaderDoc>>>,
  ownerId: string,
): Promise<LeaderCtx | false> {
  const d = await coll.findOne({ _id: WORKER_LEADER_ID });
  if (d && d.owner_id === ownerId && (d.lease_expires_at?.getTime() || 0) > Date.now()) {
    return { owner_id: ownerId, fencing_token: d.fencing_token };
  }
  return false;
}

// ⚡ DB-level verb — explicit ownerId param สำหรับ lease tests; production callers
//   ใช้ default = process identity (botworkerRuntime.ownerId) เท่านั้น
//   absent→insert(token 1) · mine+active→renew (token ไม่เพิ่ม) · expired→takeover
//   CAS (+1 token) · foreign+active→false · CAS miss/E11000→bounded re-read
//   (same-owner active → ctx; foreign → false) · ไม่มี unfenced read-then-update
export async function ensureLeadership(
  ownerId = botworkerRuntime.ownerId,
): Promise<LeaderCtx | false> {
  const coll = await getCollection<WorkerLeaderDoc>(COLLECTIONS.botworkerState);
  const doc = await coll.findOne({ _id: WORKER_LEADER_ID });
  // ⚡ clock ต้องจับหลัง read — lease อาจหมดระหว่าง await findOne; decision +
  //   CAS filter + lease_expires_at/updated_at ของทุก branch อิง now รอบเดียวกัน
  //   ที่นี่เท่านั้น (stale-now จะทำ renew expired doc ด้วย token เดิมผิด contract)
  const now = Date.now();
  if (doc) {
    const active = (doc.lease_expires_at?.getTime() || 0) > now;
    if (doc.owner_id === ownerId && active) {
      // renew own lease — fenced ด้วย identity+token+lease>now (token เดิม ไม่ $inc;
      //   lease ที่หมดอายุไปแล้วห้ามต่อ — takeover ต้องผ่าน expired branch เท่านั้น)
      const r = await coll.updateOne(
        {
          _id: WORKER_LEADER_ID,
          owner_id: ownerId,
          fencing_token: doc.fencing_token,
          lease_expires_at: { $gt: new Date(now) },
        },
        { $set: { lease_expires_at: new Date(now + botworkerRuntime.leaderLeaseMs), updated_at: new Date(now) } },
      );
      if (r.matchedCount === 1) return { owner_id: ownerId, fencing_token: doc.fencing_token };
      return rereadLeaderForOwner(coll, ownerId); // CAS miss — bounded re-read
    }
    if (!active) {
      // expired (owner ไหนก็ได้) — fenced takeover: identity+token+expiry ต้องตรง
      //   snapshot ที่ observe ไว้; CAS miss = มีผู้ชนะอื่น → bounded re-read
      const r = await coll.updateOne(
        {
          _id: WORKER_LEADER_ID,
          owner_id: doc.owner_id,
          fencing_token: doc.fencing_token,
          lease_expires_at: { $lt: new Date(now) },
        },
        {
          $set: {
            owner_id: ownerId,
            lease_expires_at: new Date(now + botworkerRuntime.leaderLeaseMs),
            updated_at: new Date(now),
          },
          $inc: { fencing_token: 1 },
        },
      );
      if (r.matchedCount === 1) return { owner_id: ownerId, fencing_token: doc.fencing_token + 1 };
      return rereadLeaderForOwner(coll, ownerId);
    }
    return false; // foreign active lease — loser
  }
  // absent → insert singleton (E11000 = raced acquire — re-read พิสูจน์ winner)
  try {
    await coll.insertOne({
      _id: WORKER_LEADER_ID,
      owner_id: ownerId,
      fencing_token: 1,
      lease_expires_at: new Date(now + botworkerRuntime.leaderLeaseMs),
      updated_at: new Date(now),
    } as unknown as WorkerLeaderDoc);
    return { owner_id: ownerId, fencing_token: 1 };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return rereadLeaderForOwner(coll, ownerId);
    throw e;
  }
}

// ⚡ renew verb — heartbeat เท่านั้นที่ใช้: ต่ออายุ lease ctx ที่ capture ตอน
//   admission เท่านั้น (exact owner_id+fencing_token และ lease ต้องยังไม่หมด)
//   ห้าม takeover/reacquire — ctx superseded → true (beat ใหม่ใช้ ctx ใหม่เอง)
//   ctx invalid/foreign/expired → false → caller ตัดสิน stop heartbeat
async function renewLeadership(ctx: LeaderCtx): Promise<boolean> {
  const coll = await getCollection<WorkerLeaderDoc>(COLLECTIONS.botworkerState);
  const d = await coll.findOne({ _id: WORKER_LEADER_ID });
  if (leaderCtx !== ctx) return true; // ctx ถูก admission ใหม่แทนแล้ว — beat ถัดไปใช้ ctx ใหม่
  if (!d || d.owner_id !== ctx.owner_id || d.fencing_token !== ctx.fencing_token) return false;
  if ((d.lease_expires_at?.getTime() || 0) <= Date.now()) return false; // expired = takeover territory
  const now = Date.now();
  const r = await coll.updateOne(
    {
      _id: WORKER_LEADER_ID,
      owner_id: ctx.owner_id,
      fencing_token: ctx.fencing_token,
      lease_expires_at: { $gt: new Date(now) },
    },
    { $set: { lease_expires_at: new Date(now + botworkerRuntime.leaderLeaseMs), updated_at: new Date(now) } },
  );
  return r.matchedCount === 1;
}

// ⚡ heartbeat owner เดียว — timer เดียวต่อ process; renew เฉพาะ leaderCtx ที่
//   capture ตอน admission; renew fail หรือ ctx invalid → stop ตัวเอง
//   (leadership loss ≠ shutdown: in-flight ClaimContext work ทำต่อ
//   แต่ admission gate รอบถัดไปปฏิเสธงานใหม่)
let leaderHeartbeat: NodeJS.Timeout | null = null;

function startLeaderHeartbeat(): void {
  if (leaderHeartbeat) return; // single timer — ห้ามซ้อน
  leaderHeartbeat = setInterval(() => {
    const ctx = leaderCtx;
    if (!ctx) return stopLeaderHeartbeat();
    renewLeadership(ctx)
      .then((ok) => { if (!ok && leaderCtx === ctx) stopLeaderHeartbeat(); })
      .catch(() => { if (leaderCtx === ctx) stopLeaderHeartbeat(); });
  }, botworkerRuntime.leaderHeartbeatMs);
  leaderHeartbeat.unref();
}

function stopLeaderHeartbeat(): void {
  leaderCtx = null; // invalidate ctx — renew ที่ค้างอยู่ต้องไม่เขียนต่อ
  if (leaderHeartbeat) clearInterval(leaderHeartbeat);
  leaderHeartbeat = null;
}

// ⚡ admission gate เดียวของ worker — acquire สำเร็จ → capture ctx + arm heartbeat
//   ล้มเหลว → คืน false เฉยๆ ห้าม stop heartbeat: false สะท้อน view ของ caller
//   (อาจ stale หรือ owner อื่นใน test rebind) — ctx ที่ arm อยู่อาจเป็นของ
//   admission ใหม่กว่า; heartbeat ตายด้วย renewLeadership fail (single loss
//   detector) หรือ clearPendingWork (single stop owner) เท่านั้น
//   era abort กลาง acquire → คืน false โดยไม่ arm — heartbeat lifecycle เป็น
//   หน้าที่ของ clearPendingWork เช่นกัน
async function acquireWorkerLeadership(signal?: AbortSignal): Promise<LeaderCtx | false> {
  const ctx = await ensureLeadership();
  if (!ctx || signal?.aborted) return false; // loser/era-dead — heartbeat ห้ามถูกแตะจากตรงนี้
  leaderCtx = ctx;
  startLeaderHeartbeat();
  return ctx;
}

// track in-flight promises (เก็บไว้สำหรับ graceful shutdown เท่านั้น — ไม่ await ในลูป)
const inFlight = new Set<Promise<unknown>>();
// ⚡ parent poll เองก็ต้องอยู่ใน drain — poll ที่รอ Mongo ข้าม shutdown ต้องถูกรอจนจบ
const activePolls = new Set<Promise<unknown>>();

// ⚡ Phase 2D — scope resolver owner เดียวอยู่ใน botworkerRuntime (bufferService
//   ใช้ delayed-execution revalidation ด้วย — ห้าม cycle) — re-export เพื่อ callers เดิม
export { resolveBotworkerScope } from "./botworkerRuntime";

export function pollNewMessages(scope: BotworkerCycleScope): Promise<{
  found: number;
  processed: number;
  results: { message_id: string; status: string; detail: string }[];
}> {
  // ⚡ era signal capture ก่อน await แรกเสมอ (synchronous — ห้ามย้ายหลัง gate;
  //   eraSignal() สร้าง controller ใหม่เมื่อเดิมถูก abort ดังนั้นต้องจับก่อน
  //   shutdown จะได้ตายพร้อม era เดิม ไม่ resurrect era ใหม่)
  // ⚡ Phase 2D — scope เป็น required snapshot ต่อ pass (resolve โดย caller):
  //   disabled rows ถูก filter ที่ Mongo discovery ก่อน claim เสมอ
  const signal = eraSignal();
  const run = (async () => {
    // ⚡ single-active-worker admission gate — loser ห้าม scan/mutate work
    //   collections เลย; abort ก่อน/กลาง gate ต้องออกเงียบ (abort กลาง acquire →
    //   acquireWorkerLeadership unwind เอง — heartbeat ไม่รอด shutdown)
    if (signal.aborted || !(await acquireWorkerLeadership(signal))) {
      return { found: 0, processed: 0, results: [] as { message_id: string; status: string; detail: string }[] };
    }
    return pollNewMessagesInEra(signal, scope);
  })();
  activePolls.add(run);
  run.then(() => activePolls.delete(run), () => activePolls.delete(run));
  return run;
}

async function pollNewMessagesInEra(
  signal: AbortSignal,
  scope: BotworkerCycleScope
): Promise<{
  found: number;
  processed: number;
  results: { message_id: string; status: string; detail: string }[];
}> {
  const coll = await getCollection<{
    message_id: string; conversation_id: string; shop_id: string;
    platform: Platform; role: string; direction: string; text: string;
    raw_payload?: unknown; created_timestamp: Date;
  }>(COLLECTIONS.messages);

  // หาข้อความใหม่: role=user, direction=in, เรียงใหม่ล่าสุดก่อน
  // ⚡ ดึง raw_payload มาด้วย — สำหรับ rich-media messages (item card, order card, ...)
  // ที่ text เป็น placeholder "[item]" ต้องใช้ raw_payload แปลงเป็น tag [สินค้า: <item_id>]
  // ⚡ admission cutoff — per-pair created_timestamp > max(global,platform,shop edge)
  //   อยู่ใน scope filter owner เดียว: ข้อความก่อนเปิด switch ไม่ถูก discover เลย
  const query: Record<string, unknown> = { role: "user", direction: "in" };
  // ⚡ Phase 2D — scope filter ก่อน claim เสมอ ({$and:[base,$or-pairs]} —
  //   deny-all เมื่อ scope ว่าง → disabled rows ไม่ถูก discover เลย)
  const docs = await coll
    .find(withScope(query, scope, "created_timestamp"))
    .sort({ created_timestamp: -1 })
    .toArray();

  // ตัดเฉพาะ terminal docs (legacy + claim ที่ finalize แล้ว)
  // claim ที่ยัง "processing" ต้องยิงซ้ำทุก cycle — claimMessage ตัดสินเอง
  // (active lease → skip / expired → reclaim / outcome·reply ครบ → finalize)
  const ids = docs.map((d) => d.message_id);
  const procColl = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const already = new Set(
    (
      await procColl
        .find({ message_id: { $in: ids }, status: { $in: [...CLAIM_TERMINAL_STATUSES] } }, { projection: { message_id: 1 } })
        .toArray()
    ).map((d) => d.message_id)
  );

  // อ่าน buffer config จาก cycle-scope snapshot (Phase 2D — ห้าม re-read ภายใน pass)
  const sysConfig = scope.config;
  const bufferConfig: BufferConfig = {
    bufferEnabled: sysConfig.bot_buffer_enabled,
    bufferWindowMs: sysConfig.bot_buffer_window_ms,
    bufferMaxMessages: sysConfig.bot_buffer_max_messages,
    bufferWindowMediaMs: sysConfig.bot_buffer_window_media_ms,
    bufferMaxMediaMessages: sysConfig.bot_buffer_max_media_messages,
  };

  // ⚡ single cancellation boundary — read-only discovery จบแล้ว; era ตายระหว่างรอ Mongo
  //   → ห้ามเริ่ม claim/buffer/timer เลย (children ที่ fire แล้วมี abort gates ของตัวเอง)
  if (signal.aborted) {
    return {
      found: docs.length,
      processed: 0,
      results: docs.map((d) => ({ message_id: d.message_id, status: "skip", detail: "era aborted" })),
    };
  }

  const results: { message_id: string; status: string; detail: string }[] = [];
  let kicked = 0;

  for (const doc of docs) {
    if (already.has(doc.message_id)) {
      results.push({ message_id: doc.message_id, status: "skip", detail: "already processed (terminal)" });
      continue;
    }

    // ⚡ FIRE-AND-FORGET — claim ก่อนเสมอ แล้วค่อย buffer/process ด้วย ClaimContext
    //   claim สำเร็จ → buffer insert ถือ ctx ของ message นั้น
    //   claim แพ้ (E11000/lease active/terminal) → skip ไม่เรียก LLM
    const p = (async () => {
      try {
        // ⚡ shop context — doc ผ่าน scope filter มาแล้ว → pair (platform+transport)
        //   มีเสมอ; miss = invariant violation → fail closed ก่อน claim (0 query)
        const pair = scope.pairs.find((p) => p.platform === doc.platform && p.shop_id === doc.shop_id);
        if (!pair) {
          console.log(`  [worker] ${doc.message_id.slice(0, 20)}... → skip: no scope pair (unresolved ctx)`);
          return;
        }
        const claimed = await claimMessage(doc, signal);
        if (claimed.kind !== "claimed") {
          const detail = claimed.kind === "skip" ? claimed.detail : `${claimed.status}: ${claimed.detail}`;
          console.log(`  [worker] ${doc.message_id.slice(0, 20)}... → ${claimed.kind}: ${detail}`);
          return;
        }
        const result = await bufferService.bufferOrProcess(
          {
            message_id: doc.message_id,
            conversation_id: doc.conversation_id,
            shop_id: doc.shop_id,
            platform: doc.platform,
            text: doc.text,
            raw_payload: doc.raw_payload,
            // ⚡ admission proof — delayed-execution boundary (flush) revalidates
            //   scope + cutoff จาก 2 fields นี้ (created_timestamp = platform event time)
            created_timestamp: doc.created_timestamp,
            admitted_edge: scope.global_enabled_since,
            claimContext: claimed.ctx,   // ⚡ row ถือ ctx ไปจนถึง batch processor
            shop_ctx: { config_shop_key: pair.config_shop_key, shopname: pair.shopname },
          },
          bufferConfig,
          processMessage,
          markProcessed,
          signal // ⚡ era signal — debounce/retry callback ลูกต้องตายพร้อม era
        );
        console.log(`  [worker] ${doc.message_id.slice(0, 20)}... → ${result.status}: ${result.detail}`);
      } catch (err) {
        console.error(`  [worker] ${doc.message_id.slice(0, 20)}... → error:`, err instanceof Error ? err.message : err);
      }
    })();

    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    kicked++;
    results.push({ message_id: doc.message_id, status: "fired", detail: "kicked off (fire-and-forget)" });
  }

  return { found: docs.length, processed: kicked, results };
}

// รอให้ทุก promise ที่กำลังทำงานอยู่เสร็จ (ใช้ตอน graceful shutdown)
// ⚡ shutdown drain — ต้องรอ parent polls (activePolls — poll อาจค้างอยู่ใน Mongo read)
//   + message children (inFlight) + recovery pass (recoveryInFlight) + timer-launched flush
//   (bufferService.activeFlushes — debounce/retry callback ไม่มี parent promise)
//   clearPendingWork → era abort → scheduled work หยุด launch งานใหม่ → drain ออกได้จริง
export async function waitForInFlight(timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    (inFlight.size > 0 || activePolls.size > 0 || recoveryInFlight || bufferService.activeFlushes.size > 0) &&
    Date.now() < deadline
  ) {
    await Promise.race([
      Promise.allSettled([
        ...inFlight,
        ...activePolls,
        ...(recoveryInFlight ? [recoveryInFlight] : []),
        ...bufferService.activeFlushes,
      ]),
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }
}

// ─── Startup recovery — stale direct claims + stale buffers ──
// ⚠️ gate bot_worker_enabled ที่ orchestration boundary นี้ —
//    worker ปิดต้องไม่ recover/flush/process เลย

// ⚡ Recovery = reconciliation-only (provider=0 — ไม่มี execution path):
//   claim missing   → orphan row → delete + audit event
//   claim terminal  → bot_failed: ต่ำกว่า cap → row dormant "failed" · cap → "quarantined"
//                     outcome อื่น → งานจบแล้ว → delete row
//   claim processing → active lease (self/foreign) → leave + deferred wake-up
//                      expired → claimMessage reconcile: evidence → finalize-only
//                      ไม่มี → settle bot_failed dormant (rows → failed)
//   dormant failed rows → ไม่แตะ — inbound ใหม่ distinct เดียวปลุก (carry-forward)
interface RecoveryStats { stale: number; orphan: number; finalized: number; deferredUntil?: number }

// ⚡ deferred wake-up — foreign active-lease rows ต้องกลับมา recover ใน era เดิม
//   (timer เดียวต่อช่วง, unref, ยิงหลัง lease expiry เท่านั้น — ไม่ busy-loop)
let deferredRecoveryTimer: NodeJS.Timeout | null = null;
let deferredRecoveryAt = 0;

// falling edge / shutdown — ยกเลิก pending recovery timer (งานค้าง → rising edge ถัดไปเอาต่อ)
function cancelDeferredRecovery(): void {
  if (deferredRecoveryTimer) clearTimeout(deferredRecoveryTimer);
  deferredRecoveryTimer = null;
  deferredRecoveryAt = 0;
}

// exact-identity row CAS — ห้ามเขียนทับ row ที่ identity เปลี่ยนจากที่ observe
const rowIdentityFilter = (row: BufferMessageDoc, claimId: string) => ({
  message_id: row.message_id,
  claim_id: claimId,
  status: row.status,
  owner_id: row.owner_id,
  fencing_token: row.fencing_token,
});
// leave ต้องมี wake-up path เสมอ — defer bounded หลัง lease expiry เท่านั้น
//   (ไม่มี execution path ใน recovery — provider=0)
function deferUntilExpiry(stats: RecoveryStats, leaseExpires: Date | undefined): "leave" {
  stats.deferredUntil = Math.min(
    stats.deferredUntil ?? Number.MAX_SAFE_INTEGER,
    leaseExpires?.getTime() ?? Date.now()
  );
  return "leave";
}

// ⚡ terminal claim → row settle — bot_failed: ต่ำกว่า cap → dormant "failed"
//   (carryable — inbound ใหม่ distinct ปลุกได้) · cap → "quarantined" ·
//   terminal อื่น → งานจบแล้ว → delete row (row เป็น leftover)
async function settleRowForTerminalClaim(
  row: BufferMessageDoc,
  claim: ChatProcessingDoc,
  bufColl: Awaited<ReturnType<typeof getCollection<BufferMessageDoc>>>
): Promise<"delete" | "leave"> {
  if (claim.status !== "bot_failed") return "delete";
  if (row.status === "quarantined") return "leave";
  if ((claim.attempt || 1) >= botworkerRuntime.maxClaimAttempts) {
    await bufColl.updateOne(
      { message_id: row.message_id, kind: { $ne: "conv_lock" } },
      { $set: { status: "quarantined" } }
    );
    return "leave";
  }
  if (row.status !== "failed") {
    await bufColl.updateOne(rowIdentityFilter(row, row.claim_id || claimIdFor(row.message_id)), {
      $set: {
        status: "failed",
        error: claim.error ?? "interrupted_before_durable_outcome",
        failed_at: new Date(),
      },
    });
  }
  return "leave";
}

async function classifyRecoveredBufferRow(
  row: BufferMessageDoc, stats: RecoveryStats, signal: AbortSignal, scope: BotworkerCycleScope
): Promise<"delete" | "leave"> {
  // ⚡ per-row side-effect boundary — cancelled run ไม่แตะ row/claim ต่อ (recoverable)
  if (signal.aborted) return "leave";
  const procColl = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const bufColl = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  const claimId = row.claim_id || claimIdFor(row.message_id);
  const claim = await procColl.findOne({ _id: claimId });

  if (row.status === "quarantined") return "leave";
  // claim หาย → ไม่มี evidence เลย → orphan
  if (!claim) {
    stats.orphan++;
    return "delete";
  }
  if (claim.status !== "processing") {
    return settleRowForTerminalClaim(row, claim, bufColl);
  }

  // ⚡ same-owner + in-flight executor ใน process นี้ → leave ถูกต้อง
  //   (executor จริงเสร็จเอง — ห้าม normalize row ห้าม schedule retry)
  if (claim.owner_id === botworkerRuntime.ownerId && activeClaims.has(claimId)) {
    return "leave";
  }
  // ⚡ active lease (owner ไหนก็ตาม) = in-flight จริง → defer wake-up หลัง expiry
  if ((claim.lease_expires_at?.getTime() || 0) > Date.now()) {
    return deferUntilExpiry(stats, claim.lease_expires_at);
  }

  // ⚡ scope-superseded ordinary buffered work (claim expired แล้ว) → terminal
  //   settle: re-enable ห้ามกู้งานที่ buffer ก่อน cutoff ใหม่ — settle no_action +
  //   delete row (ไม่ใช่ dormant technical failure — ห้ามกลายเป็น carryable)
  //   dormant "failed" rows ข้าม check นี้เสมอ (carry-forward เป็นของมันเอง)
  if (row.status !== "failed" && row.carried !== true) {
    const pair = scope.pairs.find((p) => p.platform === row.platform && p.shop_id === row.shop_id);
    const superseded = !pair || !(row.msg_created_at instanceof Date) ||
      row.msg_created_at.getTime() <= pair.cutoff.getTime();
    if (superseded) {
      const now2 = new Date();
      const upd = await procColl.updateOne(
        { _id: claimId, status: "processing", owner_id: claim.owner_id, fencing_token: claim.fencing_token },
        { $set: { status: "no_action", outcome_type: "no_action", error: "scope_superseded", processed_at: now2, updated_at: now2 } }
      );
      if (upd.matchedCount === 1) {
        stats.stale++;
        return "delete";
      }
      const c2x = await procColl.findOne({ _id: claimId });
      if (!c2x) return "delete";
      if (c2x.status !== "processing") return settleRowForTerminalClaim(row, c2x, bufColl);
      return deferUntilExpiry(stats, c2x.lease_expires_at);
    }
  }

  // expired → claim authority owner เดียว reconcile (provider=0):
  //   evidence → finalize-only · ไม่มี → settle bot_failed dormant · cap → terminal
  const res = await claimMessage({
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    shop_id: row.shop_id,
    platform: row.platform,
  }, signal);
  if (res.kind === "finalized") {
    stats.finalized++;
    return "delete";
  }
  // skip — re-read claim เพื่อ settle row ตาม terminal state ล่าสุด
  const c2 = await procColl.findOne({ _id: claimId });
  if (!c2) return "delete";
  if (c2.status !== "processing") {
    return settleRowForTerminalClaim(row, c2, bufColl);
  }
  // ยัง processing — owner อื่นชนะระหว่าง settle / lease ใหม่ → defer ถึง expiry
  return deferUntilExpiry(stats, c2.lease_expires_at);
}

// ⚡ enabled-era owner เดียว — AbortController หนึ่งตัวต่อ era (recovery passes +
//   debounce/retry callback + poll-launched work ใน era เดียวกัน share signal เดียวกัน)
//   clearPendingWork abort = era terminator จุดเดียว — child work ข้าม pass ต้องตายพร้อม era
//   (ห้ามกระจาย getSystemConfig guard ทั่ว branch)
let eraAbort: AbortController | null = null;

// ⚡ creation site เดียว — reuse ตลอด era; สร้างใหม่เฉพาะตอนไม่มี owner
//   หรือ era เดิมถูก abort แล้ว (new era เริ่มจาก signal ใหม่เสมอ)
function eraSignal(): AbortSignal {
  if (!eraAbort || eraAbort.signal.aborted) eraAbort = new AbortController();
  return eraAbort.signal;
}

async function recoverStaleClaims(stats: RecoveryStats, signal: AbortSignal, scope: BotworkerCycleScope): Promise<number> {
  const procColl = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  // ⚡ reconcile-only (provider=0 — ไม่มี re-execution path):
  //   expired processing claims → claimMessage owner เดียวตัดสิน:
  //   evidence → finalize-only · ไม่มี → settle bot_failed dormant · cap → terminal
  const stale = await procColl
    .find(withScope({ status: "processing", lease_expires_at: { $lt: new Date() } }, scope))
    .toArray();
  let settled = 0;
  for (const claim of stale) {
    try {
      // ⚡ abort checkpoint — cancelled run หยุดทีละตัว (งานค้างใน DB ปลอดภัย — edge ถัดไปกู้ต่อ)
      if (signal.aborted) break;
      const res = await claimMessage({
        message_id: claim.message_id,
        conversation_id: claim.conversation_id,
        shop_id: claim.shop_id,
        platform: claim.platform,
      }, signal);
      if (res.kind === "finalized") { stats.finalized++; settled++; }
      else if (res.kind === "skip" && res.detail.includes("bot_failed")) { stats.stale++; settled++; }
    } catch (err) {
      console.error(`[worker] stale claim recovery error for ${claim.message_id}:`, err);
    }
  }
  return settled;
}

// ⚡ recovery single-flight — concurrent callers (rising edge / deferred timer / manual)
//   coalesce เข้า pass เดียว; caller ที่มาระหว่าง pass → mark pending → rerun รอบเดียว
// ⚡ Phase 2D — scope เป็น required snapshot; caller ที่ join ระหว่าง pass ฝาก scope
//   ใหม่ไว้ใน recoveryScopeWanted → rerun pass ถัดไปใช้ scope ล่าสุด (ไม่ stale)
let recoveryInFlight: Promise<{ recovered: number; conversations: string[] }> | null = null;
let recoveryAgain = false;
let recoveryScopeWanted: BotworkerCycleScope | null = null;

async function recoverStaleBuffersAndClaims(scope: BotworkerCycleScope): Promise<{ recovered: number; conversations: string[] }> {
  recoveryScopeWanted = scope;
  if (recoveryInFlight) {
    recoveryAgain = true;
    return recoveryInFlight;
  }
  const run = (async () => {
    let result = { recovered: 0, conversations: [] as string[] };
    // ⚡ controller หนึ่งตัวต่อ enabled era (ไม่ใช่ต่อ pass) — child work เช่น
    //   flush-retry callback อาจอยู่ข้าม pass; abort เดียวต้องถึงทุก child ใน era
    //   สร้างผ่าน eraSignal() เท่านั้น — reuse ตลอด era, era ใหม่เมื่อเดิมถูก abort
    //   (capture ก่อน await แรก — eraSignal() สร้าง controller ใหม่หลัง abort
    //   ดังนั้นต้องจับ sync ที่ entry ไม่ใช่หลัง leadership gate)
    const signal = eraSignal();
    // ⚡ single-active-worker gate — loser ห้าม scan/reclaim เลย; abort ก่อน/กลาง
    //   gate ต้องออกเงียบ (deferred timer เรียกผ่านฟังก์ชันนี้ → reacquire ทุก run)
    if (signal.aborted || !(await acquireWorkerLeadership(signal))) {
      return result;
    }
    do {
      recoveryAgain = false;
      // ⚡ Phase 2D — scope snapshot ต่อ pass (joiner ล่าสุดชนะ — rerun เห็น scope ใหม่
      //   เสมอ; ภายใน pass เดียวกัน immutable); orchestration gate กิน snapshot เดียวกัน
      const passScope = recoveryScopeWanted ?? scope;
      const config = passScope.config;
      if (!config.bot_worker_enabled) continue;
      const stats: RecoveryStats = { stale: 0, orphan: 0, finalized: 0 };

      // ⚡ buffer rows ก่อนเสมอ — classify ด้วย claim authority (orphan/terminal/
      //   active/expired → delete/dormant/leave); reconcile-only ไม่มี flush
      // ⚡ passScope ทั้งคู่ — joiner ล่าสุดคือ snapshot จริงของ pass นี้;
      //   ใช้ scope เดิมของ caller แรก = stale cutoff → superseded row ถูก
      //   misclassify เป็น dormant carryable แทนที่จะ settle no_action + delete
      const buffers = await bufferService.recoverStaleBuffers(
        (row) => classifyRecoveredBufferRow(row, stats, signal, passScope),
        signal,
        passScope
      );
      // ⚡ abort checkpoint — cancelled กลาง buffered phase → run จบทั้งหมด (break —
      //   ห้าม continue แล้วเริ่ม controller ใหม่จาก recoveryAgain ของ cancelled era)
      if (signal.aborted) { result = buffers; break; }
      const claimRecovered = await recoverStaleClaims(stats, signal, passScope);
      // ⚡ deferred wake-up — rows ที่ defer ไว้ต้องกลับมา recover หลัง lease expiry
      //   ภายใน era เดิม (timer เดียว, unref — ไม่ busy-loop; falling edge ยกเลิกผ่าน clearPendingWork)
      //   scheduling เป็น side-effect boundary → cancelled run ห้ามฝาก wake-up ไว้
      if (!signal.aborted && stats.deferredUntil) {
        const delay = Math.max(0, stats.deferredUntil - Date.now()) + 250;
        if (!deferredRecoveryTimer || deferredRecoveryAt > Date.now() + delay) {
          if (deferredRecoveryTimer) clearTimeout(deferredRecoveryTimer);
          deferredRecoveryAt = Date.now() + delay;
          deferredRecoveryTimer = setTimeout(() => {
            deferredRecoveryTimer = null;
            // ⚡ Phase 2D — deferred pass resolve scope ใหม่ 1 ครั้ง — ต้องถือ
            //   global edge ของ era เดิม (null → fail-closed ไม่แตะอะไรเลย)
            getSystemConfig().then((c) => resolveBotworkerScope(c, passScope.global_enabled_since))
              .then((s) => recoverStaleBuffersAndClaims(s))
              .catch((e) => console.error("[worker] deferred recovery error:", e));
          }, delay);
          deferredRecoveryTimer.unref();
        }
      }
      if (!signal.aborted && stats.stale + stats.orphan + stats.finalized > 0) {
        await logAdminEvent({
          action_type: "bot.recovery_quarantine",
          actor: "bot-worker",
          metadata: {
            stale_claims: stats.stale,
            orphan_rows: stats.orphan,
            evidence_finalized: stats.finalized,
          },
        });
      }
      if (claimRecovered > 0) {
        console.log(`[worker] recovered ${claimRecovered} stale claims`);
      }
      result = buffers;
      // ⚡ abort ระหว่าง claims phase → outer run จบ — caller ที่ join หลัง abort
      //   (recoveryAgain=true) ต้องไม่ชุบ cancelled era ด้วย iteration+controller ใหม่
      if (signal.aborted) break;
    } while (recoveryAgain);
    return result;
  })();
  recoveryInFlight = run;
  try {
    return await run;
  } finally {
    recoveryInFlight = null;
    // ⚡ เก็บ controller ของ run ล่าสุดไว้ — clearPendingWork หลัง run จบต้องยัง abort
    //   callback/timer ที่ capture signal ของ era นั้นได้ (เช่น flush-retry ที่เริ่มแล้ว)
  }
}

export const botWorkerService = {
  processMessage,
  pollNewMessages,
  resolveBotworkerScope,
  callBot,
  isProcessed,
  waitForInFlight,
  ensureLeadership,
  recoverStaleBuffers: recoverStaleBuffersAndClaims,
  // ⚡ workflow wait-timeout = top-level worker work — era signal capture sync
  //   ก่อน await แรก + register ใน inFlight ทันที (shutdown drain ต้องรอ op นี้จบ)
  //   abort ก่อน/กลาง gate → ออกเงียบ ห้ามเรียก engine ห้าม armed heartbeat รอด
  //   (gate ผ่าน service surface — workflowEngine ไม่ import กลับมา)
  checkWaitTimeouts: (scope: BotworkerCycleScope): Promise<number> => {
    const signal = eraSignal();
    const run = (async (): Promise<number> => {
      if (signal.aborted || !(await acquireWorkerLeadership(signal))) return 0;
      return workflowEngine.checkWaitTimeouts(signal, scope);
    })();
    inFlight.add(run);
    run.then(() => inFlight.delete(run), () => inFlight.delete(run));
    return run;
  },
  // ⚡ Zaapi delay timer sweep — era/leadership/inFlight contract เดียวกับ
  //   checkWaitTimeouts (gate ผ่าน service surface — engine ไม่ import กลับมา)
  sweepDueTimerRuns: (scope: BotworkerCycleScope): Promise<{ due: number; resumed: number; errors: string[] }> => {
    const signal = eraSignal();
    const run = (async () => {
      if (signal.aborted || !(await acquireWorkerLeadership(signal))) {
        return { due: 0, resumed: 0, errors: [] };
      }
      return workflowEngine.sweepDueTimerRuns(signal, scope);
    })();
    inFlight.add(run);
    run.then(() => inFlight.delete(run), () => inFlight.delete(run));
    return run;
  },
  clearAllBufferTimers: bufferService.clearAllBufferTimers,
  // ⚡ falling edge — ยกเลิก pending work ทั้งหมด: abort active recovery pass +
  //   buffer debounce + flush retry + deferred recovery timers
  //   (งานที่ตกค้างใน DB ถูก rising-edge recovery เอาต่อ — ไม่หาย)
  clearPendingWork: () => {
    eraAbort?.abort();      // abort era — boundary ถัดไปของทุก scheduled work ออกเงียบ
    recoveryAgain = false;  // rerun ที่ queue ไว้ใน cancelled era ห้ามเริ่มงานใหม่
    stopLeaderHeartbeat();  // disable/shutdown — heartbeat ตาย → lease lapse
    bufferService.clearAllBufferTimers();
    cancelDeferredRecovery();
  },
};
