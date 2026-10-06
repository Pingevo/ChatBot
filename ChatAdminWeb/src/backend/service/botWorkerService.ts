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
  type ClaimContext,
} from "./botworkerRuntime";

export type { ClaimContext } from "./botworkerRuntime";
import { triggerService } from "./triggerService";
import { assignmentService } from "./assignmentService";
import { listMessages, getHistoryForBot, getGroupedHistoryForBot, toBotText, toBotImages, type MessageDoc } from "./messageService";
import { getConversation } from "./conversationService";
import { handoffService } from "./handoffService";
import { assertPlatformApiDisabled, type Platform } from "../lib/safety";
import type { ShadowReplyDoc } from "./shadowReplyService";
import { bufferService, type BufferConfig, type BufferMessageDoc } from "./bufferService";
import { getSystemConfig } from "./systemConfigService";
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

// ─── claimMessage — single concurrent owner via deterministic _id ──
//   absent → insert claim (E11000 = loser)
//   processing + active lease + owner อื่น → loser
//   processing + active lease + owner=ตัวเอง + ไม่ได้ in-flight → reuse ctx (buffer flush)
//   processing + expired lease → reclaim doc เดิม (fencing++/attempt++)
//   terminal → skip (ไม่แตะอีก)
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
    if ((existing.attempt || 1) >= botworkerRuntime.maxClaimAttempts) {
      await coll.updateOne(
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
      return { kind: "skip", detail: "claim attempts exhausted → bot_failed" };
    }
    // expired → reclaim doc เดิม (ไม่ insert ใหม่)
    // ⚡ returnDocument:"after" — ctx ต้องถือ owner/token ใหม่ ไม่ใช่ snapshot ก่อน update
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
    const found = await findPersistedReplies(reclaimed.batch_id);
    if (found.ids.length > 0) {
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
    // ไม่มี outcome/reply → re-execute (crash ก่อน side effect → caller ใช้ operation key dedupe)
    return { kind: "claimed", ctx };
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
//   3. ถ้าไม่มี → round-robin (autoAssignConversation)
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
}): Promise<{ status: string; detail: string; finalized: boolean; lost: boolean }> {
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
  const heartbeat = startHeartbeat(ctx, abortCtrl);
  try {
    const res = await processClaimedMessage(msg, ctx, abortCtrl.signal);
    // fenced finalize — heartbeat lost (matchedCount=0) → ห้าม persist/finalize
    // ⚡ finalization contract: finalized เมื่อ terminal write ครบทุก claim_ids เท่านั้น
    //    lost/no-outcome → finalized=false → caller (flush) ห้ามลบ buffer rows
    let finalized = false;
    if (res.outcome && !ctx.lost) {
      const n = await finalizeClaims(ctx, res.outcome);
      finalized = n === ctx.claim_ids.length;
    }
    return { status: res.status, detail: res.detail, finalized, lost: ctx.lost };
  } finally {
    clearInterval(heartbeat);
    for (const id of ctx.claim_ids) activeClaims.delete(id);
  }
}

// bounded signal สำหรับ external bot call: timeout < lease + abort เมื่อเสีย ownership
function botCallSignal(ownershipSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(botworkerRuntime.botCallTimeoutMs),
    ownershipSignal,
  ]);
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
}, ctx: ClaimContext, signal: AbortSignal): Promise<{ status: string; detail: string; outcome?: ClaimOutcome }> {
  // ⛔ Safety guard — กันเรียก platform API โดยไม่ตั้งใจ
  assertPlatformApiDisabled(msg.platform, "send");
  assertPlatformApiDisabled(msg.platform, "read");

  // ⚡ Phase 2Q — อัปเดต concurrency limit จาก config (admin ปรับได้ใน /admin-config)
  try {
    const sysConfig = await getSystemConfig();
    currentConcurrencyLimit = sysConfig.bot_concurrency_limit || 50;
  } catch {
    // ถ้าอ่าน config ไม่ได้ → ใช้ค่าเดิม
  }

  // ดึง shop_name จาก conversation — Python bot ต้องการชื่อร้าน (ไม่ใช่ shop_id ตัวเลข)
  // เพื่อกรองสินค้าเฉพาะร้านที่ลูกค้าทักเข้ามา
  const conv = await getConversation(msg.conversation_id);
  const shopName = conv?.shop_name || undefined;

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

  // ⚡ Workflow engine (แบบ Zaapi Flow Builder) — อ้างอิง docs/plans/workflow-planner.md
  // ① Active Flow Resume (เสมอ ไม่สน priority) — แชทนี้มี flow ที่กำลังรอ reply อยู่ไหม?
  //    มี → ส่งข้อความเข้า flow เดิม (resume) → จบ
  // ② Priority (workflow_first default) — workflow ก่อน trigger
  //    workflow_first: workflow ฮิต → จบ / ไม่ฮิต → trigger → บอท
  //    both: workflow ฮิต → deliver แล้วไป trigger ต่อ (⚠️ ตอบซ้ำได้ — planner เตือนแล้ว)
  //    trigger_first: ตรวจหลัง trigger ไม่ match (ดูด้านล่าง)
  // ③ บอท — เหมือนเดิม ไม่แตะ
  const wfConfig = await getSystemConfig();
  const engineMsg = {
    message_id: msg.message_id,
    conversation_id: msg.conversation_id,
    shop_id: msg.shop_id,
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
  };

  if (wfConfig.workflow_enabled) {
    // ① Active Flow Resume — flow รอ reply อยู่ → ข้อความใหม่เข้า flow ก่อนเสมอ
    const activeRun = await workflowEngine.getActiveRun(msg.conversation_id);
    if (activeRun) {
      const wfResult = await workflowEngine.resumeFlow(activeRun, engineMsg);
      if (wfResult.status === "in_flight") {
        // ⚡ run ถูก owner อื่นกำลัง execute — ห้าม settle/finalize/เขียน outcome
        //   คืนโดยไม่มี outcome → claim ค้าง processing → lease หมดแล้ว retry เอง
        return { status: "in_flight", detail: wfResult.detail };
      }
      if (wfResult.status === "error") {
        // resume พัง → ข้อความนี้ตกไป trigger/bot ตามปกติ (ไม่ทิ้งลูกค้า)
        console.error(`[worker] workflow resume error: ${wfResult.detail}`);
      } else {
        const r = await settleWorkflowResult(msg, botText, wfResult, "workflow_resumed", ctx);
        return { status: r.status, detail: r.detail, outcome: r.outcome };
      }
    }

    // ② workflow_first / both — ลอง match workflow ก่อน trigger
    if (wfConfig.workflow_priority === "workflow_first" || wfConfig.workflow_priority === "both") {
      const wfResult = await workflowEngine.matchAndRun(engineMsg);
      if (wfResult.status === "in_flight") {
        // ⚡ run เดียวกันกำลังถูก execute โดย owner อื่น — ห้ามตกไป trigger/bot ซ้ำ
        return { status: "in_flight", detail: wfResult.detail };
      }
      if (wfResult.status === "error" && wfResult.recoverable === false) {
        // ⚡ committed op ตาย terminal (errored/cancelled/corrupt/missing) — op อาจทำ
        //   side effect ไปแล้วโดยไม่มีหลักฐาน → fall ไป bot จะซ้ำโดยไม่รู้ตัว;
        //   settle เป็น bot_failed terminal ปลอดภัยกว่า (claim ไม่ค้าง retry ไม่จบ)
        return {
          status: "bot_failed",
          detail: wfResult.detail,
          outcome: { type: "bot_failed", reply_ids: [], extra: { error: wfResult.detail } },
        };
      }
      if (wfResult.status === "actioned" || wfResult.status === "resumed") {
        if (wfConfig.workflow_priority === "workflow_first") {
          const r = await settleWorkflowResult(msg, botText, wfResult, "workflow_actioned", ctx);
          return { status: r.status, detail: r.detail, outcome: r.outcome };
        }
        // both → deliver แล้วไป trigger ต่อ (ตอบซ้ำได้ — ไม่แนะนำ แต่ planner ให้เลือกได้)
        await storeWorkflowDelivered({
          messageId: msg.message_id,
          messageText: botText,
          conversationId: msg.conversation_id,
          shopId: msg.shop_id,
          platform: msg.platform,
          delivered: wfResult.delivered,
          workflowId: wfResult.workflow_id || "",
          batchId: ctx.batch_id,
          inboundMessageIds: ctx.message_ids,
          outcomeEnvelope: { outcome_type: "workflow_actioned", workflow_id: wfResult.workflow_id },
        });
        // ไม่ return — ไป trigger ต่อ
      } else if (wfResult.status === "exit_drop") {
        // condition false + exit_drop → cancel flow + ทิ้งข้อความ
        return {
          status: "workflow_exit_drop",
          detail: wfResult.detail,
          outcome: { type: "no_action", reply_ids: [] },
        };
      }
      // exit_to_bot / no_match / error → fall through ไป trigger → บอท (ตาม pipeline ปกติ)
    }
  }

  try {
    // 2. Check trigger
    const trigger = await triggerService.matchTrigger(msg.text, {
      shopId: msg.shop_id,
      platform: msg.platform,
    });

    if (trigger) {
      // ── แมทช์ trigger ──
      if (trigger.action === "handoff_admin") {
        // ส่งให้แอดมิน — round-robin (operation key → handoff owner dedupe ตอน crash retry)
        const { agentId, mode, inFlight } = await pickAgent(
          msg.shop_id, msg.platform, msg.conversation_id, undefined,
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
      // ⚡ Phase 2Q — acquire concurrency slot ก่อนยิงบอท
      await acquireBotSlot();
      let botResp;
      try {
        botResp = await callBot({
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
          // ⚡ bounded HTTP timeout + abort เมื่อเสีย ownership กลางคัน
          signal: botCallSignal(signal),
        });
      } finally {
        releaseBotSlot();
      }
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
    }

    // ⚡ trigger_first — trigger ไม่ match → ลอง workflow ก่อนไปบอท (planner ②)
    if (wfConfig.workflow_enabled && wfConfig.workflow_priority === "trigger_first") {
      const wfResult = await workflowEngine.matchAndRun(engineMsg);
      if (wfResult.status === "in_flight") {
        // ⚡ run กำลังถูก owner อื่น execute — ห้ามตกไปบอทซ้ำ / ห้าม finalize
        return { status: "in_flight", detail: wfResult.detail };
      }
      if (wfResult.status === "error" && wfResult.recoverable === false) {
        // ⚡ committed op ตาย terminal — settle bot_failed เหมือน branch workflow_first
        return {
          status: "bot_failed",
          detail: wfResult.detail,
          outcome: { type: "bot_failed", reply_ids: [], extra: { error: wfResult.detail } },
        };
      }
      if (wfResult.status === "actioned" || wfResult.status === "resumed") {
        const r = await settleWorkflowResult(msg, botText, wfResult, "workflow_actioned", ctx);
        return { status: r.status, detail: r.detail, outcome: r.outcome };
      }
      if (wfResult.status === "exit_drop") {
        return {
          status: "workflow_exit_drop",
          detail: wfResult.detail,
          outcome: { type: "no_action", reply_ids: [] },
        };
      }
      // exit_to_bot / no_match / error → ไปบอท (fall through)
    }

    // ── ไม่แมทช์ trigger → ส่งให้บอทตอบ → เก็บใน shadow_replies ──
    // ⚡ grouped history — รวม user messages ติดกันเป็น 1 turn + fallback Zaapi
    //    exclude current batch — ctx.message_ids อยู่ใน message/images ของ request แล้ว
    const history = await getGroupedHistoryForBot({
      conversationId: msg.conversation_id,
      platform: msg.platform,
      maxTurns: 10,
      includeSandboxAdmin: true,  // ⚡ merge botworker_messages (แอดมินใน parallel เคยตอบอะไร)
      excludeMessageIds: ctx.message_ids,
    });
    // ⚡ Phase 2Q — acquire concurrency slot ก่อนยิงบอท
    await acquireBotSlot();
    let botResp;
    try {
      botResp = await callBot({
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
        // ⚡ bounded HTTP timeout + abort เมื่อเสีย ownership กลางคัน
        signal: botCallSignal(signal),
      });
    } finally {
      releaseBotSlot();
    }
    // heartbeat lost กลางคัน → stale owner — ห้าม persist/finalize
    if (ctx.lost) return { status: "lost_ownership", detail: "claim lost mid-bot-call" };

    if (!botResp.answer || botResp.answer.trim() === "") {
      // บอทตอบไม่ได้ → ส่งต่อแอดมิน
      const { agentId, mode, inFlight } = await pickAgent(
        msg.shop_id, msg.platform, msg.conversation_id, "bot empty answer",
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

  } catch (err) {
    // บอท error → บันทึก error — bot_failed terminal one-shot (ไม่ retry อัตโนมัติ)
    const errorMsg = err instanceof Error ? err.message : String(err);
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
// ⚡ Phase 2Q — Concurrency limiter (semaphore pattern)
//   ถ้า buffer เปิด → 500 ข้อความเข้ามา → buffer รวมเป็น 200 context → flush พร้อมกัน
//   ถ้าไม่จำกัด → ยิงบอท 200 reqs พร้อมกัน → Python bot โอเวอร์โหลด
//   ใช้ bot_concurrency_limit จาก config (admin ปรับได้ใน /admin-config, default 50)
let activeBotCalls = 0;
let currentConcurrencyLimit = 50;
const botCallQueue: Array<() => void> = [];

async function acquireBotSlot(): Promise<void> {
  // ⚡ Phase 2Q — อ่าน limit จาก config ทุกครั้ง (admin อาจเปลี่ยนได้)
  if (activeBotCalls < currentConcurrencyLimit) {
    activeBotCalls++;
    return;
  }
  await new Promise<void>((resolve) => {
    botCallQueue.push(() => {
      activeBotCalls++;
      resolve();
    });
  });
}

function releaseBotSlot(): void {
  activeBotCalls--;
  const next = botCallQueue.shift();
  if (next) next();
}

// track in-flight promises (เก็บไว้สำหรับ graceful shutdown เท่านั้น — ไม่ await ในลูป)
const inFlight = new Set<Promise<unknown>>();
// ⚡ parent poll เองก็ต้องอยู่ใน drain — poll ที่รอ Mongo ข้าม shutdown ต้องถูกรอจนจบ
const activePolls = new Set<Promise<unknown>>();

export function pollNewMessages(since?: Date): Promise<{
  found: number;
  processed: number;
  results: { message_id: string; status: string; detail: string }[];
}> {
  // ⚡ era signal capture ก่อน await แรกเสมอ — poll ที่รอ Mongo ข้าม shutdown
  //   ต้องตายพร้อม era เดิม (clearPendingWork abort ถึง) ห้ามสร้าง era ใหม่เอง
  const signal = eraSignal();
  const run = pollNewMessagesInEra(since, signal);
  activePolls.add(run);
  run.then(() => activePolls.delete(run), () => activePolls.delete(run));
  return run;
}

async function pollNewMessagesInEra(
  since: Date | undefined,
  signal: AbortSignal
): Promise<{
  found: number;
  processed: number;
  results: { message_id: string; status: string; detail: string }[];
}> {
  const coll = await getCollection<{
    message_id: string; conversation_id: string; shop_id: string;
    platform: Platform; role: string; direction: string; text: string;
    raw_payload?: unknown;
  }>(COLLECTIONS.messages);

  // หาข้อความใหม่: role=user, direction=in, เรียงใหม่ล่าสุดก่อน
  // ⚡ Phase 2P — ถ้ามี since → ประมวลผลเฉพาะข้อความที่เข้ามาหลัง since (กันประมวลผลข้อความเก่าตอนเปิดครั้งแรก)
  // ⚡ Phase 2Q — ไม่ limit แล้ว — ดึงทั้งหมดที่เข้ามาใหม่ (buffer เป็นตัวคุมปริมาณจริง)
  // ดึง raw_payload มาด้วย — สำหรับ rich-media messages (item card, order card, ...)
  // ที่ text เป็น placeholder "[item]" ต้องใช้ raw_payload แปลงเป็น tag [สินค้า: <item_id>]
  const query: Record<string, unknown> = { role: "user", direction: "in" };
  if (since) {
    query.created_timestamp = { $gt: since };
  }
  const docs = await coll
    .find(query)
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

  // อ่าน buffer config จาก system config
  const sysConfig = await getSystemConfig();
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
            claimContext: claimed.ctx,   // ⚡ row ถือ ctx ไปจนถึง batch processor
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

// ⚡ Incident closure — boot recovery precedence (per-row):
//   P1 claim missing   → orphan row → delete + audit event
//   P2 claim terminal  → work finalized แล้ว → delete row
//   P3 committed evidence (outcome_type / reply_ids / persisted reply)
//      → existing finalize-only path ผ่าน claimMessage (ไม่เรียก LLM) → delete row
//   P4 ไม่มี evidence → freshness gate: row.received_at + claim.claimed_at
//      ต้อง valid และอยู่ใน window ทั้งคู่ ถึงจะเข้า batch
//      stale → CAS claim → no_action/stale_at_recovery → delete row
//      CAS lost → leave row untouched
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
const rowSyncUpdate = (ctx: ClaimContext) => ({
  $set: { status: "buffered" as const, owner_id: ctx.owner_id, fencing_token: ctx.fencing_token },
});

// leave ต้องมี execution path เสมอ — re-read claim ครั้งเดียว:
//   terminal/missing → "delete" (row leftover) · อื่น → defer bounded wake-up แล้ว "leave"
//   (lease active → ตื่นหลัง expiry · expired/ของเราแต่ไม่มี executor → +250ms bounded)
async function verifyForeignClaim(claimId: string, stats: RecoveryStats): Promise<"delete" | "leave"> {
  const procColl = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const c2 = await procColl.findOne({ _id: claimId });
  if (!c2 || c2.status !== "processing") return "delete";
  stats.deferredUntil = Math.min(
    stats.deferredUntil ?? Number.MAX_SAFE_INTEGER,
    c2.lease_expires_at?.getTime() ?? Date.now()
  );
  return "leave";
}

// ⚡ shared reconciliation owner — P3/P4 ใช้ร่วมกันหลัง row CAS miss (bounded, claim fencing authority)
//   ctx0=null → establish ownership ใน loop ผ่าน claimMessage (expired lease เท่านั้น)
//   settleOnly=true → ข้าม repair loop เข้า settle terminal ทันที (claimed-stale path)
async function reconcileClaimedRow(
  row: BufferMessageDoc,
  claim: ChatProcessingDoc,
  ctx0: ClaimContext | null,
  stats: RecoveryStats,
  settleOnly = false,
  signal?: AbortSignal
): Promise<"fresh" | "delete" | "leave"> {
  const procColl = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const bufColl = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  const claimId = row.claim_id || claimIdFor(row.message_id);
  let ctx = ctx0;

  if (!settleOnly) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimNow = await procColl.findOne({ _id: claimId });
      if (!claimNow || claimNow.status !== "processing") return "delete"; // winner terminal → row leftover
      const leaseActive = (claimNow.lease_expires_at?.getTime() || 0) > Date.now();
      if (ctx) {
        if (claimNow.owner_id !== ctx.owner_id || claimNow.fencing_token !== ctx.fencing_token) {
          if (!leaseActive) { ctx = null; continue; } // winner ตายแล้ว → reclaim รอบถัดไป
          stats.deferredUntil = Math.min(
            stats.deferredUntil ?? Number.MAX_SAFE_INTEGER, claimNow.lease_expires_at!.getTime());
          return "leave"; // foreign owner ทำงานจริง — wake-up scheduled
        }
      } else {
        if (leaseActive && claimNow.owner_id !== botworkerRuntime.ownerId) {
          stats.deferredUntil = Math.min(
            stats.deferredUntil ?? Number.MAX_SAFE_INTEGER, claimNow.lease_expires_at!.getTime());
          return "leave";
        }
        const res = await claimMessage({
          message_id: row.message_id, conversation_id: row.conversation_id,
          shop_id: row.shop_id, platform: row.platform,
        }, signal);
        if (res.kind === "finalized") { stats.finalized++; return "delete"; }
        if (res.kind === "skip") return verifyForeignClaim(claimId, stats); // re-read พิสูจน์ winner/in-flight
        ctx = res.ctx;
        continue; // ctx เพิ่งได้ → re-read ยืนยัน fencing รอบถัดไป
      }
      const rowNow = await bufColl.findOne({ message_id: row.message_id, claim_id: claimId });
      if (!rowNow) {
        // row หายแต่ claim ยังเป็นเรา → restore deterministic membership จาก snapshot เดิม
        try {
          const { _id: _drop, ...rest } = row;
          await bufColl.insertOne({
            ...rest, status: "buffered",
            owner_id: ctx.owner_id, fencing_token: ctx.fencing_token,
          } as BufferMessageDoc);
          return "fresh";
        } catch (e) {
          if ((e as { code?: number }).code === 11000) continue; // concurrent insert → re-read รอบถัดไป
          throw e;
        }
      }
      if (rowNow.status === "buffered" && rowNow.owner_id === ctx.owner_id && rowNow.fencing_token === ctx.fencing_token)
        return "fresh"; // row ตรง ctx อยู่แล้ว
      // claim authority ยังของเรา → repair row เข้า ctx ด้วย fenced CAS บน identity ล่าสุดของ row
      const upd = await bufColl.updateOne(rowIdentityFilter(rowNow, claimId), rowSyncUpdate(ctx));
      if (upd.matchedCount === 1) return "fresh";
    }
  }
  if (!ctx) return verifyForeignClaim(claimId, stats); // ไม่เคยถือ ownership → verified leave + wake-up

  // settle — claim ของเรา → terminalize + ลบ row ด้วย identity ล่าสุด (ห้ามทิ้ง processing เปล่า)
  const outcome = {
    type: "no_action" as const,
    reply_ids: claim.reply_ids || [],
    side_effects: claim.side_effects || [],
    extra: { error: "stale_at_recovery" },
  };
  for (let i = 0; i < 2; i++) {
    const n = await finalizeClaims(ctx, outcome);
    if (n > 0) {
      stats.stale++;
      const rowFinal = await bufColl.findOne({ message_id: row.message_id, claim_id: claimId });
      if (rowFinal) await bufColl.deleteOne(rowIdentityFilter(rowFinal, claimId));
      return "delete";
    }
    const c2 = await procColl.findOne({ _id: claimId });
    if (!c2 || c2.status !== "processing") return "delete";
    if (c2.owner_id !== ctx.owner_id || c2.fencing_token !== ctx.fencing_token) {
      stats.deferredUntil = Math.min(
        stats.deferredUntil ?? Number.MAX_SAFE_INTEGER,
        c2.lease_expires_at?.getTime() ?? Date.now());
      return "leave"; // foreign/concurrent winner — verified + wake-up scheduled
    }
    // doc ยังตรง ctx → miss เมื่อกี้ transient → loop ลอง finalize ซ้ำครั้งเดียว
  }
  // ⚡ exhausted — ห้าม bare leave โดยไม่มี wake-up: re-read → defer owner เดิม
  //   (terminal→delete · processing→wake หลัง lease expiry · foreign→defer expiry)
  return verifyForeignClaim(claimId, stats);
}

async function classifyRecoveredBufferRow(
  row: BufferMessageDoc, freshAfter: Date, stats: RecoveryStats, signal: AbortSignal
): Promise<"fresh" | "delete" | "leave"> {
  // ⚡ per-row side-effect boundary — cancelled run ไม่แตะ row/claim ต่อ (recoverable)
  if (signal.aborted) return "leave";
  const procColl = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const bufColl = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  const claimId = row.claim_id || claimIdFor(row.message_id);
  const claim = await procColl.findOne({ _id: claimId });

  // P1 — claim หาย → ไม่มี evidence เลย → orphan
  if (!claim) {
    stats.orphan++;
    return "delete";
  }
  // P2 — claim terminal แล้ว → row เป็น leftover
  if (claim.status !== "processing") {
    return "delete";
  }

  // ⚡ same-owner + in-flight executor ใน process นี้ → leave ถูกต้อง
  //   (executor จริงเสร็จเอง — ห้าม normalize row ห้าม schedule retry)
  if (claim.owner_id === botworkerRuntime.ownerId && activeClaims.has(claimId)) {
    return "leave";
  }
  // ⚡ foreign owner + lease ยัง active = in-flight จริง → defer wake-up หลัง expiry
  if (claim.owner_id !== botworkerRuntime.ownerId &&
      (claim.lease_expires_at?.getTime() || 0) > Date.now()) {
    stats.deferredUntil = Math.min(
      stats.deferredUntil ?? Number.MAX_SAFE_INTEGER, claim.lease_expires_at!.getTime());
    return "leave";
  }

  const rowFresh = row.received_at instanceof Date && row.received_at >= freshAfter;
  const claimFresh = claim.claimed_at instanceof Date && claim.claimed_at >= freshAfter;

  // P3 — committed evidence → finalize-only (claimMessage จัดการ outcome/reply branches)
  const hasEvidence =
    Boolean(claim.outcome_type) ||
    (claim.reply_ids?.length ?? 0) > 0 ||
    (await findPersistedReplies(claim.batch_id)).ids.length > 0;
  if (hasEvidence) {
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
    if (res.kind === "skip") return verifyForeignClaim(claimId, stats); // CAS lost → re-read พิสูจน์ winner
    // ⚡ "claimed" = evidence หายหลัง reclaim — fencing/lease ใหม่อยู่ใน res.ctx เท่านั้น
    //   ห้ามใช้ claim snapshot token → ต้อง settle/sync ผ่าน ctx ใหม่เสมอ
    const ownedCtx = res.ctx;
    if (!rowFresh || !claimFresh) {
      // stale → fenced settle no_action ด้วย ctx ใหม่ (สำเร็จ → ลบ row + delete)
      return reconcileClaimedRow(row, claim, ownedCtx, stats, true, signal);
    }
    // fresh ทั้งคู่ → sync row เข้า ctx ใหม่ด้วย exact-identity CAS → miss → shared reconcile
    const upd = await bufColl.updateOne(rowIdentityFilter(row, claimId), rowSyncUpdate(ownedCtx));
    if (upd.matchedCount === 1) return "fresh";
    return reconcileClaimedRow(row, claim, ownedCtx, stats, false, signal);
  }
  // P4 — ไม่มี evidence → freshness gate (row + claim ต้อง fresh ทั้งคู่)
  if (rowFresh && claimFresh) {
    // crash-leftover: row ค้าง "processing" จาก flush ที่ตายกลางทาง → normalize กลับ buffered
    if (row.status === "processing") {
      const upd = await bufColl.updateOne(
        rowIdentityFilter(row, claimId),
        { $set: { status: "buffered" } }
      );
      if (upd.matchedCount === 1) return "fresh";
      return reconcileClaimedRow(row, claim, null, stats, false, signal); // miss → reconcile (establish ownership ใน loop)
    }
    return "fresh";
  }
  const cas = await procColl.updateOne(
    { _id: claimId, status: "processing", fencing_token: claim.fencing_token },
    {
      $set: {
        status: "no_action",
        outcome_type: "no_action",
        error: "stale_at_recovery",
        processed_at: new Date(),
        updated_at: new Date(),
      },
    }
  );
  if (cas.matchedCount === 1) {
    stats.stale++;
    return "delete";
  }
  return verifyForeignClaim(claimId, stats); // CAS lost → re-read พิสูจน์ winner + wake-up
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

async function recoverStaleClaims(freshAfter: Date, stats: RecoveryStats, signal: AbortSignal): Promise<number> {
  const procColl = await getCollection<ChatProcessingDoc>(COLLECTIONS.chatProcessing);
  const stale = await procColl
    .find({ status: "processing", lease_expires_at: { $lt: new Date() } })
    .toArray();
  // ⚡ การ์ดแข็ง: claim ที่ยังมี buffer row ค้าง = งานของ batch recovery —
  //   direct recovery ห้ามยิงทีละข้อความ (จะแตก batch เป็น N replies)
  const mids = stale.map((c) => c.message_id).filter(Boolean) as string[];
  const bufferedMid = new Set<string>();
  if (mids.length > 0) {
    const rows = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages).then((c) =>
      c.find({ kind: "message", message_id: { $in: mids }, status: { $in: ["buffered", "processing"] } }).toArray()
    );
    for (const r of rows) bufferedMid.add(r.message_id);
  }
  let recovered = 0;
  for (const claim of stale) {
    try {
      // ⚡ abort checkpoint — cancelled run หยุด launch claim/processMessage ทีละตัว
      //   (งานค้างใน DB ปลอดภัย — rising edge ถัดไปกู้ต่อ)
      if (signal.aborted) break;
      if (claim.message_id && bufferedMid.has(claim.message_id)) continue;
      // ⚡ evidence ก่อน inbound lookup — committed outcome/reply finalize-only
      //   ผ่าน claimMessage ได้โดยไม่ต้องมี inbound doc (inbound หายห้ามทับ bot_failed)
      const hasEvidence =
        Boolean(claim.outcome_type) ||
        (claim.reply_ids?.length ?? 0) > 0 ||
        (await findPersistedReplies(claim.batch_id)).ids.length > 0;
      let ownedCtx: ClaimContext | undefined;
      if (hasEvidence) {
        const res = await claimMessage({
          message_id: claim.message_id,
          conversation_id: claim.conversation_id,
          shop_id: claim.shop_id,
          platform: claim.platform,
        }, signal);
        if (res.kind === "finalized") { stats.finalized++; continue; }
        if (res.kind === "skip") continue; // reclaim CAS แพ้ → ไม่นับ ไม่ process
        // ⚡ "claimed" = evidence หายหลัง reclaim — fencing/lease ใหม่อยู่ใน ctx เท่านั้น
        //   snapshot `claim` เก่าใช้ CAS/terminal ไม่ได้แล้ว → ทุก op ข้างล่างใช้ ownedCtx
        ownedCtx = res.ctx;
      }
      // ไม่มี committed evidence → freshness gate
      //   claim เก่ากว่า enable boundary → CAS no_action/stale_at_recovery
      const fresh = claim.claimed_at instanceof Date && claim.claimed_at >= freshAfter;
      if (!fresh) {
        if (ownedCtx) {
          // reclaim แล้ว → fenced finalize ด้วย ctx ใหม่ (ห้ามใช้ snapshot token)
          const n = await finalizeClaims(ownedCtx, {
            type: "no_action",
            reply_ids: claim.reply_ids || [],
            side_effects: claim.side_effects || [],
            extra: { error: "stale_at_recovery" },
          });
          if (n > 0) stats.stale++;
        } else {
          const cas = await procColl.updateOne(
            { _id: claim._id, status: "processing", fencing_token: claim.fencing_token },
            {
              $set: {
                status: "no_action",
                outcome_type: "no_action",
                error: "stale_at_recovery",
                processed_at: new Date(),
                updated_at: new Date(),
              },
            }
          );
          if (cas.matchedCount === 1) stats.stale++;
        }
        continue; // CAS lost → owner อื่นชนะ → skip โดยไม่ process
      }
      // reprocess path — ต้องมี inbound doc
      const msgColl = await getCollection<{
        message_id: string; conversation_id: string; shop_id: string;
        platform: Platform; role: string; direction: string; text: string; raw_payload?: unknown;
      }>(COLLECTIONS.messages);
      const msg = await msgColl.findOne({ message_id: claim.message_id });
      if (!msg) {
        // inbound หายไป → finalize bot_failed กันค้าง
        //   (ownedCtx: lease เพิ่ง renew → expired-lease filter จะ miss → ต้อง fenced ด้วย ctx)
        if (ownedCtx) {
          await finalizeClaims(ownedCtx, {
            type: "bot_failed",
            reply_ids: claim.reply_ids || [],
            side_effects: claim.side_effects || [],
            extra: { error: "inbound message missing at recovery" },
          });
        } else {
          await procColl.updateOne(
            { _id: claim._id, status: "processing", lease_expires_at: { $lt: new Date() } },
            { $set: { status: "bot_failed", outcome_type: "bot_failed", error: "inbound message missing at recovery", processed_at: new Date(), updated_at: new Date() } }
          );
        }
        continue;
      }
      if (!ownedCtx) {
        const claimed = await claimMessage(msg, signal);
        if (claimed.kind === "finalized") { stats.finalized++; continue; }
        if (claimed.kind !== "claimed") continue;
        ownedCtx = claimed.ctx;
      }
      if (signal.aborted) continue; // abort หลัง claim → ห้าม launch (claim คง lease ใหม่ → edge ถัดไปกู้)
      const p = processMessage({ ...msg, claimContext: ownedCtx });
      inFlight.add(p.catch(() => {}).finally(() => inFlight.delete(p)));
      recovered++;
    } catch (err) {
      console.error(`[worker] stale claim recovery error for ${claim.message_id}:`, err);
    }
  }
  return recovered;
}

// ⚡ recovery single-flight — concurrent callers (rising edge / deferred timer / manual)
//   coalesce เข้า pass เดียว; caller ที่มาระหว่าง pass → mark pending → rerun รอบเดียว
let recoveryInFlight: Promise<{ recovered: number; conversations: string[] }> | null = null;
let recoveryAgain = false;

async function recoverStaleBuffersAndClaims(): Promise<{ recovered: number; conversations: string[] }> {
  if (recoveryInFlight) {
    recoveryAgain = true;
    return recoveryInFlight;
  }
  const run = (async () => {
    let result = { recovered: 0, conversations: [] as string[] };
    // ⚡ controller หนึ่งตัวต่อ enabled era (ไม่ใช่ต่อ pass) — child work เช่น
    //   flush-retry callback อาจอยู่ข้าม pass; abort เดียวต้องถึงทุก child ใน era
    //   สร้างผ่าน eraSignal() เท่านั้น — reuse ตลอด era, era ใหม่เมื่อเดิมถูก abort
    const signal = eraSignal();
    do {
      recoveryAgain = false;
      // orchestration gate — disabled worker ห้าม recover/flush/process
      const config = await getSystemConfig();
      if (!config.bot_worker_enabled) continue;
      // ⚡ freshness boundary — recovery รับเฉพาะงานที่ยังอยู่ใน in-flight window
      //   (buffer window + claim lease + grace) — เก่ากว่านี้ = ไม่พิสูจน์ owner ได้ → quarantine
      const freshAfter = new Date(
        Date.now() -
          (Math.max(config.bot_buffer_window_ms || 0, config.bot_buffer_window_media_ms || 0) +
            botworkerRuntime.claimLeaseMs +
            60_000)
      );
      const stats: RecoveryStats = { stale: 0, orphan: 0, finalized: 0 };

      // ⚡ buffered batches ก่อนเสมอ — direct-claim recovery ต้องเห็นผล batch ก่อน
      //   (มิฉะนั้น member claims ถูกยิง direct ทีละข้อความ = N replies แทน 1 batch)
      const buffers = await bufferService.recoverStaleBuffers(
        processMessage,
        markProcessed,
        (row) => classifyRecoveredBufferRow(row, freshAfter, stats, signal),
        signal
      );
      // ⚡ abort checkpoint — cancelled กลาง buffered phase → run จบทั้งหมด (break —
      //   ห้าม continue แล้วเริ่ม controller ใหม่จาก recoveryAgain ของ cancelled era)
      if (signal.aborted) { result = buffers; break; }
      const claimRecovered = await recoverStaleClaims(freshAfter, stats, signal);
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
            recoverStaleBuffersAndClaims().catch((e) =>
              console.error("[worker] deferred recovery error:", e));
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
            fresh_after: freshAfter.toISOString(),
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
  callBot,
  isProcessed,
  waitForInFlight,
  recoverStaleBuffers: recoverStaleBuffersAndClaims,
  clearAllBufferTimers: bufferService.clearAllBufferTimers,
  // ⚡ falling edge — ยกเลิก pending work ทั้งหมด: abort active recovery pass +
  //   buffer debounce + flush retry + deferred recovery timers
  //   (งานที่ตกค้างใน DB ถูก rising-edge recovery เอาต่อ — ไม่หาย)
  clearPendingWork: () => {
    eraAbort?.abort();      // abort era — boundary ถัดไปของทุก scheduled work ออกเงียบ
    recoveryAgain = false;  // rerun ที่ queue ไว้ใน cancelled era ห้ามเริ่มงานใหม่
    bufferService.clearAllBufferTimers();
    cancelDeferredRecovery();
  },
};
