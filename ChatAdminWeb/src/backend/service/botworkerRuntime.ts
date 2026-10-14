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

export const botworkerRuntime = {
  // lease ต้อง > botCallTimeoutMs + headroom สำหรับ finalize
  claimLeaseMs: 150000,
  // heartbeat ตื่นทุก lease/3 — fencing filter ทำให้ stale worker renew ไม่ติด
  heartbeatMs: 50000,
  // bounded HTTP timeout สำหรับ external bot call — ต้อง < claimLeaseMs
  // ⚡ audit: liveAssignmentService ใช้ AbortSignal.timeout(90_000) กับ endpoint เดียวกัน
  //    + 429-retry 60s waits → valid latency ถึง 90s+ — timeout ต่ำกว่านี้ตัดคำตอบจริง
  botCallTimeoutMs: 90000,
  // flush error retry — claim owner/token เดิม re-fence ผ่าน expected-owner filter ได้
  // จึง retry เร็วได้โดยไม่ต้องรอ lease หมด
  flushErrorRetryMs: 5000,
  // owner identity unique ต่อ process boot — stale owner จาก process เก่า
  // เขียนทับไม่ได้เพราะ fencing_token เปลี่ยนทุก reclaim
  ownerId: `worker-${process.pid}-${randomUUID()}`,
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
