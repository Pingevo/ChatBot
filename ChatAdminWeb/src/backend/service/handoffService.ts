// Handoff service — จุดกลางสำหรับ "บอทส่งต่อแอดมิน"
// ทำ 3 อย่าง:
//   1. reopen conversation ถ้าสถานะเป็น closed (ลูกค้าทักกลับมา)
//   2. assign ให้ admin — ถ้าเคยมี admin ตอบแล้ว → ส่งคืน admin เดิมก่อนเสมอ
//      ถ้าไม่เคยมี → auto-assign แบบ round-robin
//   3. ส่ง assigned_admin_name กลับให้บอทบอกลูกค้าได้
// เรียกจาก: data writer (sellcenter เขียนลง MongoDB) หรือ trigger match
// ⚡ Phase 2J — status/assigned_to เก็บใน status_conversation (จริง) ไม่โดน dump ทับ
//   ส่วน test หน้าอื่นใช้ handoffToAdminTest เก็บใน test_status_conversation
import { randomUUID } from "node:crypto";
import { Document, type Collection } from "mongodb";
import { conversationService } from "./conversationService";
import { statusConversationService } from "./statusConversationService";
import { testStatusConversationService, type TestSource } from "./testStatusConversationService";
import { assignmentService } from "./assignmentService";
import { logAdminEvent } from "./adminLogService";
import { closeHistoryService } from "./closeHistoryService";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { botworkerRuntime } from "./botworkerRuntime";

/**
 * ดึงชื่อ admin จาก admin_id
 */
async function getAdminName(adminId: string): Promise<string | null> {
  const coll = await getCollection<{ admin_id: string; name?: string; username?: string }>(
    COLLECTIONS.admins
  );
  const admin = await coll.findOne({ admin_id: adminId });
  return admin?.name || admin?.username || null;
}

/**
 * ดึง admin คนสุดท้ายที่ตอบลูกค้าใน conversation นี้
 * (จาก messages collection — หา message ล่าสุดที่ sender เป็น admin)
 */
async function getLastReplyAdmin(
  conversationId: string
): Promise<string | null> {
  const coll = await getCollection<{
    conversation_id: string;
    sender: string;
    admin_id?: string;
    timestamp: Date;
  }>(COLLECTIONS.messages);
  const msg = await coll.findOne(
    {
      conversation_id: conversationId,
      sender: "admin",
      admin_id: { $exists: true, $nin: [""] },
    },
    { sort: { timestamp: -1 } }
  );
  return msg?.admin_id || null;
}

/**
 * ⚡ Phase 2B.2 — typed handoff outcome (authoritative)
 *   state ต้องสะท้อน persisted DB truth เท่านั้น — ห้าม derive จาก selection:
 *     assigned ⇔ meta{status:handoff, assigned_to:X} committed/converged
 *     queued   ⇔ meta{status:handoff, assigned_to:null, pending_assignment:true} committed/converged
 *     failed   ⇔ verify durable outcome ไม่ได้ — caller ห้าม claim success กับลูกค้า
 *
 * โครงสร้าง (single-phase — ไม่มี pending-settlement marker):
 *   read-dispatch → converge+emit → select (reservation) → single fenced commit
 *   (commitHandoffState — committed ⟹ real transition) → emit
 *   side effects = eid-idempotent emissions: emit หลัง commit + re-emit บน
 *   converge ใดๆ (dedupe = free repair — ไม่มี owner ที่ต้องตื่นมาซ่อม)
 *   crash ก่อน/กลาง emit โดยไม่มี call ถัดไป → audit gap (detectable ผ่าน eid —
 *   contract เดียวกับ applyInboundOwnershipTransition)
 */
export type HandoffOutcomeState = "assigned" | "queued" | "failed";
export interface HandoffOutcome {
  state: HandoffOutcomeState;
  assigned_to: string | null;
  assigned_to_name: string | null;
  persisted: boolean;
  reason: string;
  error_code: string | null;
  reopened: boolean;
  // ⚡ transport signal (ไม่ใช่ durable marker): side-effect emission ไม่ครบ —
  //   ownership truth ไม่ย้อน แต่ caller/transport ต้องเห็นว่า audit ขาด → retry converge
  emit_incomplete: boolean;
}

const failedOutcome = (reason: string, error_code: string): HandoffOutcome => ({
  state: "failed", assigned_to: null, assigned_to_name: null,
  persisted: false, reason, error_code, reopened: false, emit_incomplete: false,
});

/** route contract เดียวทุก endpoint — failed ห้าม 2xx:
 *   emit_incomplete → 503 retryable (ownership kept, audit ขาด — retry converge)
 *   failed + conversation_not_found → 404 permanent
 *   failed อื่น (contention/internal/unverified) → 503 retryable
 */
export function handoffOutcomeHttpStatus(o: HandoffOutcome): number {
  if (o.emit_incomplete) return 503;
  if (o.state !== "failed") return 200;
  return o.error_code === "conversation_not_found" ? 404 : 503;
}

/** side-effect emissions ของ committed transition — idempotent ด้วย handoff_event_id
 *  (audit _id dedupe / recordReopen self-gate) — caller ใดก็ emit/re-emit ได้ปลอดภัย
 *  attribution อ่านจาก persisted transition truth (handoff_actor/handoff_reason)
 */
async function emitHandoffSideEffects(
  meta: import("./statusConversationService").StatusConversationDoc,
  opts: { conversationId: string; shopId?: string; reason?: string; actor?: string }
): Promise<void> {
  const eid = meta.handoff_event_id;
  if (!eid) return; // ไม่มี dedupe identity → emit ไม่ได้ (จะเขียน audit ซ้ำทุก call)
  const actor = meta.handoff_actor ?? opts.actor;
  const reason = meta.handoff_reason ?? opts.reason;
  if (meta.handoff_reopened) {
    // flag = fenced truth (commit apply ⟹ prior ปิดจริง) → reopen audit สมควรเขียนเสมอ
    await closeHistoryService.recordReopen({
      conversationId: opts.conversationId,
      reopenedBy: "bot",
      reopenReason: reason || "ลูกค้าทักกลับมา — บอทส่งต่อแอดมิน",
      messageId: eid,
    });
  }
  if (meta.assigned_to) {
    await logAdminEvent({
      action_type: "chat_assigned",
      actor: actor || "system",
      target_admin_id: meta.assigned_to,
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      metadata: { mode_used: meta.assignment_mode_used, atomic: true },
      eventId: eid,
    });
  }
  await logAdminEvent({
    action_type: "conversation.handoff",
    actor: actor || "bot",
    conversation_id: opts.conversationId,
    metadata: {
      outcome: meta.assigned_to ? "assigned" : "queued",
      assigned_to: meta.assigned_to ?? null,
      reason,
      assignment_reason: meta.assignment_reason,
      mode: meta.assignment_mode_used,
    },
    eventId: eid,
  });
}

/** emit ที่ไม่ทำให้ ownership outcome เสีย — emission คือ observability (idempotent,
 *  re-attempt บน call ถัดไป) ไม่ใช่ durable phase ที่ต้อง guarantee;
 *  gap ตรวจจับได้ผ่าน handoff_event_id บน doc เทียบ audit rows
 *  ⚡ คืน boolean — ห้าม swallow: caller ต้อง surface emit_incomplete ให้ transport
 *  retry request เดิมได้ (converge owner เดิม + re-emit eid เดิม)
 */
async function tryEmitHandoff(
  meta: import("./statusConversationService").StatusConversationDoc,
  opts: { conversationId: string; shopId?: string; reason?: string; actor?: string }
): Promise<boolean> {
  try {
    await emitHandoffSideEffects(meta, opts);
    return true;
  } catch {
    console.warn(`[handoff] side-effect emit incomplete — conv=${opts.conversationId} eid=${meta.handoff_event_id ?? "none"}`);
    return false;
  }
}

export async function handoffToAdmin(opts: {
  conversationId: string;
  shopId: string;
  platform: string;
  reason?: string;
  source?: string; // ⚡ C1 — source สำหรับ cursor separation (default: "ticket")
  targetAdminId?: string; // ⚡ direct-assign command (workflow admin_id / assign route)
  actor?: string; // audit actor — default bot/system
}): Promise<HandoffOutcome> {
  // ⚡ Phase 2J — อ่าน status/assigned_to จาก meta (ไม่ใช่ conversations ที่โดน dump ทับ)
  const conv = await conversationService.getConversation(opts.conversationId);
  if (!conv) return failedOutcome("conversation not found", "conversation_not_found");

  const direct = opts.targetAdminId != null && opts.targetAdminId !== "";
  try {
    const meta = await statusConversationService.getMeta(opts.conversationId);
    const wasClosed = meta?.status === "closed" || meta?.status === "resolved";

    // converge — owned & not closed & status เป็น post-handoff state → persisted truth + emit
    //   (idempotent — re-emit ซ่อม audit ที่ขาดจาก emit crash ก่อนหน้าได้ฟรีด้วย eid dedupe)
    //   post-handoff set = {handoff,open,pending} ตาม ticket_state contract ที่ Python อ่าน
    //   (status:"bot"/missing + owner = inconsistent → หลุดไป retained-owner fenced commit
    //   normalize เป็น handoff; direct command: converge เฉพาะเมื่อ owner ตรง target แล้ว)
    if (meta?.assigned_to && !wasClosed
        && (meta.status === "handoff" || meta.status === "open" || meta.status === "pending")
        && (!direct || meta.assigned_to === opts.targetAdminId)) {
      const emitted = await tryEmitHandoff(meta, opts);
      return {
        state: "assigned",
        assigned_to: meta.assigned_to,
        assigned_to_name: await getAdminName(meta.assigned_to),
        persisted: true,
        reason: "existing_assignment", error_code: null, reopened: false,
        emit_incomplete: !emitted,
      };
    }

    // ── select desired owner: direct target → retained (closed) → previous replier → round-robin ──
    let desired: string | null = null;
    let mode: string | undefined;
    let reason = "no_available_admin";
    // ⚡ contention = claim พิสูจน์ไม่ได้ (retryable) — ต่างจาก pool ว่างจริง
    //   durable truth (queued เดิม) ชนะ attempt failure → เช็ค converge ก่อนคืน
    let selectionFailed: HandoffOutcome | null = null;
    if (direct) {
      desired = opts.targetAdminId!;
      mode = "direct";
      reason = "direct_assign";
    } else if (meta?.assigned_to) {
      desired = meta.assigned_to;
      mode = "existing_assignment";
      reason = "existing_assignment";
    } else {
      const { getSystemConfig } = await import("./systemConfigService");
      const sysConfig = await getSystemConfig();
      if (sysConfig.assignment_prefer_previous_admin !== false) {
        const lastReplyAdmin = await getLastReplyAdmin(opts.conversationId);
        if (lastReplyAdmin) {
          const adminColl = await getCollection<{
            admin_id: string; active: boolean; role: string; is_accepting_chats?: boolean;
          }>(COLLECTIONS.admins);
          const admin = await adminColl.findOne({
            admin_id: lastReplyAdmin,
            active: { $ne: false },
            is_accepting_chats: { $ne: false },
          });
          if (admin) {
            desired = lastReplyAdmin;
            mode = "previous_reply_admin";
            reason = "previous_reply_admin";
          }
        }
      }
      if (!desired) {
        // reservation-order — ตำแหน่งคิวถูก claim แบบ atomic ณ จุดนี้;
        //   commit ล้มเหลว → position forfeit (bounded skip — contract)
        const sel = await assignmentService.selectNextAgent(
          { shop_id: opts.shopId, platform: opts.platform },
          opts.source || "ticket"
        );
        if (sel.result === "reserved") {
          desired = sel.agentId;
          mode = sel.mode;
          reason = "round_robin";
        } else if (sel.result === "contention") {
          // eligible admins มีแต่ claim พิสูจน์ไม่ได้ → retryable failure
          //   (ห้าม persist queued/no_available_admin — สถานะโกหก durable)
          selectionFailed = failedOutcome(
            "cursor reservation contention — claim unproven",
            "reservation_contention"
          );
        }
      }
    }

    // converge — queued durable อยู่แล้ว + ยังหา admin ไม่ได้ → persisted truth + emit
    if (!desired && !direct && meta?.pending_assignment === true && !wasClosed) {
      const emitted = await tryEmitHandoff(meta, opts);
      return {
        state: "queued", assigned_to: null, assigned_to_name: null,
        persisted: true,
        reason: "no_available_admin", error_code: null, reopened: false,
        emit_incomplete: !emitted,
      };
    }

    // contention พิสูจน์ claim ไม่ได้และไม่มี durable queued เดิม → retryable failed
    //   (ไม่ persist อะไร — ไม่มี ownership transition ที่พิสูจน์ได้)
    if (selectionFailed) return selectionFailed;

    // ── single fenced commit — ผลลัพธ์อิง CAS จริงเท่านั้น ──
    const commit = await statusConversationService.commitHandoffState({
      conversationId: opts.conversationId,
      adminId: desired,
      expectedOwner: meta?.assigned_to ?? null,
      direct,
      mode,
      reason,
      callerReason: opts.reason,
      actor: opts.actor,
      eventId: randomUUID(),
      reopened: wasClosed,
    });

    if (!commit.committed) {
      // CAS miss → bounded converge re-read (ห้ามเขียนทับผู้ชนะ) + emit ของผู้ชนะ (idempotent)
      const m2 = await statusConversationService.getMeta(opts.conversationId);
      const emitted = m2 ? await tryEmitHandoff(m2, opts) : true;
      if (m2?.assigned_to) {
        return {
          state: "assigned",
          assigned_to: m2.assigned_to,
          assigned_to_name: await getAdminName(m2.assigned_to),
          persisted: true,
          reason: "converged_assignment", error_code: null,
          reopened: wasClosed && m2.status === "handoff",
          emit_incomplete: !emitted,
        };
      }
      if (m2?.pending_assignment === true) {
        return {
          state: "queued", assigned_to: null, assigned_to_name: null,
          persisted: true,
          reason: "no_available_admin", error_code: null,
          reopened: wasClosed && m2.status === "handoff",
          emit_incomplete: !emitted,
        };
      }
      return failedOutcome("commit lost and converge unresolved", "persist_unverified");
    }

    // committed → emit (idempotent — failure ไม่เปลี่ยน ownership truth;
    //   call ถัดไปของ conv นี้ re-emit ซ่อม gap ได้ด้วย eid เดิม)
    const committedDoc = commit.doc ?? await statusConversationService.getMeta(opts.conversationId);
    const emitted = committedDoc ? await tryEmitHandoff(committedDoc, opts) : true;
    return {
      state: desired ? "assigned" : "queued",
      assigned_to: desired,
      assigned_to_name: desired ? await getAdminName(desired) : null,
      persisted: true,
      reason, error_code: null,
      reopened: wasClosed,
      emit_incomplete: !emitted,
    };
  } catch {
    // 🔒 sanitizer — ห้าม raw exception (Mongo URI/query/newline) ออก API/log
    return failedOutcome("handoff failed", "handoff_error");
  }
}

/**
 * ⚡ Phase 2J — Test version ของ handoffToAdmin
 *   ใช้ round-robin จริง (cursor ขยับจริง) แต่เก็บใน test_status_conversation ไม่ใช่ status_conversation
 *   ไม่เขียน admin_logs / close_history (test ไม่ต้อง audit)
 *   ใช้กับ: test-assignment, shadowbot, replay-compare, test-chat
 */
type HandoffTestResult = {
  assignedTo: string | null;
  assignedToName: string | null;
  reopened: boolean;
  assignmentReason: string;
  // ⚡ op ถูก owner อื่น execute อยู่ — retryable, ห้ามถือว่า assign สำเร็จ
  in_flight?: boolean;
};

type HandoffOpDoc = Document & {
  _id: string;
  status: "pending" | "done";
  owner_id?: string;
  fencing_token?: number;
  lease_expires_at?: Date;
  result?: HandoffTestResult;
};

function inFlightHandoff(opKey: string): HandoffTestResult {
  return {
    assignedTo: null, assignedToName: null, reopened: false,
    assignmentReason: `in_flight: op ${opKey} owned by another worker`,
    in_flight: true,
  };
}

/** CAS claim op — pending+lease หมด/ไม่มี owner เท่านั้น (active foreign → null) */
async function acquireHandoffOp(opColl: Collection<HandoffOpDoc>, opKey: string): Promise<HandoffOpDoc | null> {
  const now = new Date();
  return opColl.findOneAndUpdate(
    {
      _id: opKey,
      status: "pending",
      $or: [{ lease_expires_at: { $lt: now } }, { owner_id: { $exists: false } }],
    },
    {
      $set: {
        owner_id: botworkerRuntime.ownerId,
        lease_expires_at: new Date(now.getTime() + botworkerRuntime.claimLeaseMs),
        updated_at: now,
      },
      $inc: { fencing_token: 1 },
    },
    { returnDocument: "after" }
  );
}

export async function handoffToAdminTest(opts: {
  conversationId: string;
  shopId: string;
  platform: string;
  reason?: string;
  source: TestSource;
  // ⚡ botworker — assign สำเร็จ = status "open" (แอดมินกำลังตอบ); default "handoff" คงพฤติกรรม test หน้าอื่น
  assignedStatus?: "handoff" | "open";
  // ⚡ botworker Part 1B — deterministic operation key: crash หลัง assign commit
  //   แต่ก่อน claim outcome → retry ด้วย key เดิมจะได้ result เดิม ไม่ assign ซ้ำ
  //   (idempotency อยู่ที่ handoff owner — dedupe doc ใน botworker_events)
  operationKey?: string;
}): Promise<HandoffTestResult> {
  if (!opts.operationKey) return doHandoffToAdminTest(opts);

  // ⚡ op-key path — fenced operation ownership:
  //   insert pending(owner+lease) → E11000 = เคยมี op นี้
  //   pending+expired/unowned → CAS reclaim (caller เดียว)
  //   pending+active foreign → in_flight (ห้าม exec)
  //   pending+same-owner (sibling call ใน process เดียวกัน) → รอ result แล้วคืนอันเดียวกัน
  //   assignment evidence = test_status.assignment_operation_key === opKey เท่านั้น
  //   (assigned_to เก่าจาก op อื่น ห้ามนับว่า op นี้ commit แล้ว)
  const opKey = opts.operationKey;
  const opColl = await getCollection<HandoffOpDoc>(COLLECTIONS.botworkerEvents);
  const now = new Date();
  let op: HandoffOpDoc | null = null;
  try {
    await opColl.insertOne({
      _id: opKey,
      status: "pending",
      owner_id: botworkerRuntime.ownerId,
      fencing_token: 1,
      lease_expires_at: new Date(now.getTime() + botworkerRuntime.claimLeaseMs),
      created_at: now,
    });
    op = { _id: opKey, status: "pending", owner_id: botworkerRuntime.ownerId, fencing_token: 1 };
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }

  if (!op) {
    // มี op doc อยู่แล้ว → result? / CAS reclaim / in_flight
    const prior = await opColl.findOne({ _id: opKey });
    if (prior?.result) return prior.result;
    op = await acquireHandoffOp(opColl, opKey);
    if (!op) {
      const cur = await opColl.findOne({ _id: opKey });
      if (cur?.result) return cur.result;
      // sibling ใน process เดียวกันกำลัง exec (owner เดียวกัน) → รอ result สั้นๆ
      if (cur?.status === "pending" && cur.owner_id === botworkerRuntime.ownerId) {
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 50));
          const again = await opColl.findOne({ _id: opKey });
          if (again?.result) return again.result;
          if (again?.status !== "pending" || again?.owner_id !== botworkerRuntime.ownerId) break;
        }
      }
      return inFlightHandoff(opKey);
    }
    // ⚡ ครอง op แล้ว — เช็กว่า assignment commit ไปแล้วหรือยัง (crash window)
    //   หลักฐานต้องเป็น assignment_operation_key === opKey เท่านั้น
    const meta = await testStatusConversationService.getTestStatus(opts.conversationId, opts.source);
    if (meta?.assigned_to && meta.assignment_operation_key === opKey) {
      const recovered: HandoffTestResult = {
        assignedTo: meta.assigned_to,
        assignedToName: await getAdminName(meta.assigned_to),
        reopened: false,
        assignmentReason: "recovered_pending_op: assignment committed before crash",
      };
      // ⚡ fenced — stale owner ที่เสีย CAS (op ถูก reclaim ด้วย fence ใหม่) ห้ามเขียน result ทับ;
      //   CAS fail → converge อ่าน result ของ winner หรือ in_flight
      const rwr = await opColl.updateOne(
        { _id: opKey, status: "pending", owner_id: botworkerRuntime.ownerId, fencing_token: op.fencing_token ?? 1 },
        { $set: { status: "done", result: recovered, updated_at: new Date() } }
      );
      if (rwr.matchedCount !== 1) {
        const cur = await opColl.findOne({ _id: opKey });
        if (cur?.result) return cur.result;
        return inFlightHandoff(opKey);
      }
      return recovered;
    }
  }

  // exec — fenced result write (เสีย ownership ระหว่าง exec → ห้ามเขียนทับ result ของ reclaimer)
  const result = await doHandoffToAdminTest(opts);
  const fence = op.fencing_token ?? 1;
  const wr = await opColl.updateOne(
    { _id: opKey, owner_id: botworkerRuntime.ownerId, fencing_token: fence, status: "pending" },
    { $set: { status: "done", result, updated_at: new Date() } }
  );
  if (wr.matchedCount !== 1) {
    // op ถูก reclaim+commit โดย caller อื่นแล้ว → คืนผลที่ commit จริง (converge)
    const cur = await opColl.findOne({ _id: opKey });
    if (cur?.result) return cur.result;
    return inFlightHandoff(opKey);
  }
  return result;
}

async function doHandoffToAdminTest(opts: {
  conversationId: string;
  shopId: string;
  platform: string;
  reason?: string;
  source: TestSource;
  assignedStatus?: "handoff" | "open";
  operationKey?: string;
}): Promise<HandoffTestResult> {
  const meta = await testStatusConversationService.getTestStatus(opts.conversationId, opts.source);
  const currentStatus = meta?.status || "bot";
  const wasClosed = currentStatus === "closed" || currentStatus === "resolved";
  let reopened = false;
  let assignmentReason = "unknown";

  if (wasClosed) {
    await testStatusConversationService.reopenTestConversation(opts.conversationId, opts.source);
    reopened = true;
  }

  // Step 1: ถ้ามี assigned_to อยู่แล้ว → ใช้คนเดิม
  let assignedTo = meta?.assigned_to || null;
  if (assignedTo) {
    assignmentReason = "existing_assignment: มี admin ดูแลอยู่แล้ว (test)";
  }

  // Step 2: หา admin คนสุดท้ายที่เคยตอบ
  if (!assignedTo) {
    const lastReplyAdmin = await getLastReplyAdmin(opts.conversationId);
    if (lastReplyAdmin) {
      const adminColl = await getCollection<{
        admin_id: string; active: boolean; role: string; is_accepting_chats?: boolean;
      }>(COLLECTIONS.admins);
      const admin = await adminColl.findOne({
        admin_id: lastReplyAdmin,
        active: { $ne: false },
        is_accepting_chats: { $ne: false },
      });
      if (admin) {
        assignedTo = lastReplyAdmin;
        assignmentReason = "previous_reply_admin: ส่งคืน admin เดิมที่เคยตอบ (test)";
      }
    }
  }

  // Step 3: round-robin (cursor ขยับจริง)
  if (!assignedTo) {
    const mode = await assignmentService.getActiveAssignmentConfig();
    const { poolKey, orderedAgentIds } = await assignmentService.buildPool(
      mode,
      { shop_id: opts.shopId, platform: opts.platform },
      opts.source
    );
    if (orderedAgentIds.length > 0) {
      const sel = await assignmentService.reserveNextAgent(poolKey, orderedAgentIds);
      if (sel.result === "reserved") {
        assignedTo = sel.agentId;
        assignmentReason = `round_robin: ไม่มี admin เดิม → จ่ายคิว (test:${opts.source})`;
      } else if (sel.result === "contention") {
        // claim พิสูจน์ไม่ได้ (retryable) — ห้าม persist pending_assignment โกหก
        return {
          assignedTo: null, assignedToName: null, reopened,
          assignmentReason: `reservation_contention: cursor claim ไม่สำเร็จ (test:${opts.source})`,
          in_flight: true,
        };
      }
    }
  }

  // เขียนลง test_status_conversation (ไม่ใช่ status_conversation จริง)
  if (assignedTo) {
    await testStatusConversationService.updateTestStatus(
      opts.conversationId,
      opts.source,
      opts.assignedStatus || "handoff",
      assignedTo,
      assignmentReason,
      // ⚡ stamp op key = หลักฐานว่า assignment นี้ commit โดย op ไหน (crash recovery)
      opts.operationKey
    );
    // ⚡ backlog — assign สำเร็จ → clear pending marker (กรณีเคยค้าง)
    if (meta?.pending_assignment) {
      await testStatusConversationService.setTestPendingAssignment(opts.conversationId, opts.source, false);
    }
  } else {
    // ⚡ backlog — หา admin ไม่ได้ → mark pending_assignment กันงานค้างหาย
    await testStatusConversationService.setTestPendingAssignment(
      opts.conversationId,
      opts.source,
      true,
      "no_available_admin"
    );
  }

  const assignedToName = assignedTo ? await getAdminName(assignedTo) : null;
  return { assignedTo, assignedToName, reopened, assignmentReason };
}

export const handoffService = {
  handoffToAdmin,
  handoffToAdminTest,
  handoffOutcomeHttpStatus,
  getAdminName,
  getLastReplyAdmin,
};
