// Handoff service — จุดกลางสำหรับ "บอทส่งต่อแอดมิน"
// ทำ 3 อย่าง:
//   1. reopen conversation ถ้าสถานะเป็น closed (ลูกค้าทักกลับมา)
//   2. assign ให้ admin — ถ้าเคยมี admin ตอบแล้ว → ส่งคืน admin เดิมก่อนเสมอ
//      ถ้าไม่เคยมี → auto-assign แบบ round-robin
//   3. ส่ง assigned_admin_name กลับให้บอทบอกลูกค้าได้
// เรียกจาก: data writer (sellcenter เขียนลง MongoDB) หรือ trigger match
// ⚡ Phase 2J — status/assigned_to เก็บใน status_conversation (จริง) ไม่โดน dump ทับ
//   ส่วน test หน้าอื่นใช้ handoffToAdminTest เก็บใน test_status_conversation
import { Document, type Collection } from "mongodb";
import { conversationService } from "./conversationService";
import { statusConversationService } from "./statusConversationService";
import { testStatusConversationService, type TestSource } from "./testStatusConversationService";
import { assignmentService } from "./assignmentService";
import { logAdminEvent } from "./adminLogService";
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
 * บอทส่งต่อแอดมิน — ใช้ตอน trigger match handoff_admin หรือ data writer เห็นว่าควรส่งต่อ
 * ถ้า conversation ปิดอยู่ → reopen อัตโนมัติ + assign ใหม่
 * ถ้า conversation เปิดอยู่ → เปลี่ยน status เป็น handoff + assign (ถ้ายังไม่มี)
 *
 * ⚠️ ถ้าเคยมี admin ตอบแล้ว → ส่งคืน admin เดิมก่อนเสมอ (ก่อน round-robin)
 */
export async function handoffToAdmin(opts: {
  conversationId: string;
  shopId: string;
  platform: string;
  reason?: string;
  source?: string; // ⚡ C1 — source สำหรับ cursor separation (default: "ticket")
}): Promise<{
  assignedTo: string | null;
  assignedToName: string | null;
  reopened: boolean;
  assignmentReason: string;
}> {
  // ⚡ Phase 2J — อ่าน status/assigned_to จาก meta (ไม่ใช่ conversations ที่โดน dump ทับ)
  const conv = await conversationService.getConversation(opts.conversationId);
  if (!conv) {
    return { assignedTo: null, assignedToName: null, reopened: false, assignmentReason: "conversation not found" };
  }
  const meta = await statusConversationService.getMeta(opts.conversationId);

  const currentStatus = meta?.status || "bot";
  const wasClosed = currentStatus === "closed" || currentStatus === "resolved";
  let reopened = false;
  let assignmentReason = "unknown";

  // ถ้าปิดอยู่ → reopen ก่อน (เขียนลง meta)
  if (wasClosed) {
    await statusConversationService.reopenConversation({
      conversationId: opts.conversationId,
      reopenedBy: "bot",
      reopenReason: opts.reason || "ลูกค้าทักกลับมา — บอทส่งต่อแอดมิน",
    });
    reopened = true;
  }

  // ── Step 1: ถ้ามี assigned_to อยู่แล้ว → ใช้คนเดิม ──
  let assignedTo = meta?.assigned_to || null;

  // ── Step 2: ถ้ายังไม่มี assigned_to → หา admin คนสุดท้ายที่เคยตอบ ──
  // ⚡ G2 — เช็ค config ว่าจะจ่ายให้คนเดิมหรือ round-robin เลย
  if (!assignedTo) {
    const { getSystemConfig } = await import("./systemConfigService");
    const sysConfig = await getSystemConfig();
    const preferPrevious = sysConfig.assignment_prefer_previous_admin !== false;
    if (preferPrevious) {
      const lastReplyAdmin = await getLastReplyAdmin(opts.conversationId);
      if (lastReplyAdmin) {
        // เช็คว่า admin ยัง active อยู่ไหม
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
          assignmentReason = "previous_reply_admin: ส่งคืน admin เดิมที่เคยตอบ";
        }
      }
    } else {
      assignmentReason = "round_robin_skipped_previous: config ปิดจ่ายคนเดิม → round-robin";
    }
  }

  // ── Step 3: ถ้ายังไม่มี → auto-assign round-robin ──
  if (!assignedTo) {
    const agentId = await assignmentService.autoAssignConversation({
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      platform: opts.platform,
      assigned_to: null,
    }, opts.source || "ticket");
    if (agentId) {
      assignedTo = agentId;
      assignmentReason = "round_robin: ไม่มี admin เดิม → จ่ายคิว";
    }
  } else if (!assignmentReason) {
    assignmentReason = "existing_assignment: มี admin ดูแลอยู่แล้ว";
  }

  // ── อัปเดต status + assigned_to (เขียนลง meta ไม่ใช่ conversations) ──
  if (assignedTo) {
    await statusConversationService.updateStatus(
      opts.conversationId,
      "handoff",
      assignedTo,
      "bot"
    );
    // ⚡ backlog — assign สำเร็จ → clear pending marker (กรณีเคยค้าง)
    if (meta?.pending_assignment) {
      await statusConversationService.setPendingAssignment(opts.conversationId, false);
    }
  } else {
    // ⚡ backlog — หา admin ไม่ได้ → mark pending_assignment กันงานค้างหาย (distributor จ่ายทีหลัง)
    await statusConversationService.setPendingAssignment(opts.conversationId, true, "no_available_admin");
  }

  // ── ดึงชื่อ admin ──
  const assignedToName = assignedTo ? await getAdminName(assignedTo) : null;

  await logAdminEvent({
    action_type: "conversation.handoff",
    actor: "bot",
    conversation_id: opts.conversationId,
    metadata: {
      assigned_to: assignedTo,
      assigned_to_name: assignedToName,
      reopened,
      reason: opts.reason,
      assignment_reason: assignmentReason,
    },
  });

  return { assignedTo, assignedToName, reopened, assignmentReason };
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
}): Promise<{
  assignedTo: string | null;
  assignedToName: string | null;
  reopened: boolean;
  assignmentReason: string;
}> {
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
      const agentId = await assignmentService.pickNextAgent(poolKey, orderedAgentIds);
      if (agentId) {
        assignedTo = agentId;
        assignmentReason = `round_robin: ไม่มี admin เดิม → จ่ายคิว (test:${opts.source})`;
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
  getAdminName,
  getLastReplyAdmin,
};
