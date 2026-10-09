# Botworker Canary Plan (docs-only — final safety correction, G4 BLOCKED)

> Status: **G3 final-safety corrected — READY_FOR_REVIEW**
> Baseline: `feature-legacy-shopee-evidence-retrieval` @ `f316cdb`
> เอกสารแผนเท่านั้น — ห้าม execute จนกว่า G4 จะได้รับอนุมัติแยกต่างหาก

---

## 0. Corrections (ทุก review round → fixed)

| Finding | ข้อเท็จจริงจาก code | การแก้ |
|---|---|---|
| "single-shop" ไม่จริงบน production DB | `pollNewMessagesInEra` query `{role:"user",direction:"in",created_timestamp>since}` — **ไม่มี shop_id filter** | §2 สอง execution modes |
| concurrency limit ≠ cost ceiling | จำกัด calls **พร้อมกัน** เท่านั้น — ไม่จำกัดร้าน/turns/total | §3+§4 |
| **counter/dashboard ไม่ใช่ hard stop** | monitoring ≠ enforcement — ต้องมีกลไกตัด calls อัตโนมัติ | §4.1 enforcement contract |
| **callBot ≠ provider call** | worker `/chat` request หนึ่งอาจ spawn หลาย upstream calls ใน Python | §1.1 terminology ทั้งเอกสาร |
| **FORCED_STOP_TS ไม่มี enforcement** | timestamp อย่างเดียวไม่หยุดอะไร — ต้องมี scheduler armed | §4.4 + §3 keys |
| workflow calls อาจ > inbound | run หนึ่งเดินได้หลาย `let_ai_respond` + resume | §4.3 |
| shadow_replies ไม่พิสูจน์ calls หยุด | 429/500/timeout ไม่มี reply doc | §7 |
| dup query ขาด origin filter | `origin`/`mode` มีจริงใน `shadow_replies` (`botWorkerService:472-473,538-539`) | §8 query |
| mandatory thresholds ไม่ครบ | failure bounds ต้องเป็นตัวเลขก่อน G4 | §3 table |

## 1. Terminology — **บังคับใช้ทั้งเอกสาร**

- **Worker request** = HTTP `POST /chat` จาก botworker → Python bot
  (`botCallService.callBot` — boundary เดียวที่ worker ออกไป)
- **Provider call** = upstream request ภายใน Python pipeline (intent classifier,
  answer/LLM2, web-search, model calls — OpenRouter/Gemini/อื่น)
- **1 worker request อาจ = หลาย provider calls** — worker มองไม่เห็นและนับไม่ได้;
  นับ/cost ได้เฉพาะจาก **provider-side authoritative usage** เท่านั้น
- ห้าม derive provider calls/cost จาก claims, inbound count, callBot count หรือ
  `shadow_replies` — ทุกตัวอยู่ผิดฝั่งของ boundary

## 2. Execution modes — **เลือก+อนุมัติ 1 mode ก่อน G4**

### Mode A (recommended): isolated canary environment/DB

- Worker ชี้ DB ที่มีเฉพาะข้อความร้านทดสอบ/seeded — shop-scope จริงจาก data
- `workflow_enabled=false`, `bot_concurrency_limit=1`
- พิสูจน์ lifecycle/claims/kill-switch/recovery — **ไม่**พิสูจน์ traffic+provider cost จริง

### Mode B: production DB — **global rollout** (ไม่ใช่ single-shop)

- ไม่มี shop filter → **ทุก shop post-edge eligible**
- `bot_concurrency_limit=1` จำกัด concurrent requests เท่านั้น — ไม่จำกัดร้าน/turns/total
- บังคับก่อนเปิด: observed inbound rate + **planned spend estimate** =
  `inbound_rate × PROVIDER_COST_PER_CHAT_P95_USD × duration`
  — ใช้ค่าที่วัดจริงจาก provider usage เท่านั้น; **สูตรนี้เป็น p95-based
  planning estimate เท่านั้น ไม่ใช่ hard ceiling** — tail cost อาจสูงกว่า
  estimate; ตัวจำกัดความเสียหายจริง = `COST_STOP_MECHANISM` + provider-enforced
  limit (§4.1); **ยังไม่มีค่าวัดจริง → G4 production mode BLOCKED**
- Shop allowlist runtime = out of scope docs-only นี้

> **G4 BLOCKED จนกว่าเลือก+อนุมัติ 1 mode**

## 3. Mandatory values — ทุกช่องต้องกำหนดก่อน G4

| Key | ค่า | หมายเหตุ |
|---|---|---|
| `EXECUTION_MODE` | `MUST_SET_BEFORE_G4` | A isolated / B production-global |
| `MAX_CANARY_DURATION_MINUTES` | `MUST_SET_BEFORE_G4` | wall-clock bound |
| `MAX_PROVIDER_CALLS` | `MUST_SET_BEFORE_G4` | นับจาก provider-side authoritative usage เท่านั้น |
| `MAX_PROVIDER_COST_USD` | `MUST_SET_BEFORE_G4` | hard budget — provider-side usage เท่านั้น |
| `PROVIDER_COST_PER_CHAT_P95_USD` | `MUST_SET_BEFORE_G4` | วัดจริงจาก provider usage (Mode B planned spend estimate — ไม่ใช่ hard ceiling) |
| `MAX_BOT_FAILED_RATE_PERCENT` | `MUST_SET_BEFORE_G4` | `bot_failed`/terminal claims threshold |
| `MAX_CONSECUTIVE_429` | `MUST_SET_BEFORE_G4` | consecutive provider 429 abort threshold |
| `MAX_CONSECUTIVE_5XX` | `MUST_SET_BEFORE_G4` | consecutive provider 5xx abort threshold |
| `COST_STOP_MECHANISM` | `MUST_SET_BEFORE_G4` | กลไก enforcement ตาม §4.1 (ไม่ invent) |
| `COST_STOP_OWNER` | `MUST_SET_BEFORE_G4` | เจ้าของ automated cost-stop mechanism (คนละหน้าที่จาก `OBSERVER_OWNER`/`ABORT_AUTHORITY`) |
| `COST_STOP_ARMED_AT` | `MUST_SET_BEFORE_G4` | timestamp ที่พิสูจน์ว่า armed ก่อนเปิด |
| `FORCED_STOP_MECHANISM` | `MUST_SET_BEFORE_G4` | scheduler/supervisor ตาม §4.4 (ไม่ invent) |
| `FORCED_STOP_OWNER` | `MUST_SET_BEFORE_G4` | เจ้าของกลไก forced stop |
| `FORCED_STOP_ARMED_AT` | `MUST_SET_BEFORE_G4` | timestamp ที่พิสูจน์ว่า armed ก่อนเปิด |
| `CANARY_START_TS` / `FORCED_STOP_TS` | `MUST_SET_BEFORE_G4` | start + deadline |
| `OBSERVER_OWNER` | `MUST_SET_BEFORE_G4` | monitoring only — **ไม่ใช่ hard stop** |
| `ABORT_AUTHORITY` | `MUST_SET_BEFORE_G4` | คนสั่ง kill ทันที |
| `bot_concurrency_limit` | `1` | floor เดียวกับ fail-closed |
| `workflow_enabled` (Stage A) | `false` | ≤1 worker request ต่อ claimed turn |
| `bot_worker_interval_ms` | `2000` | default |
| `bot_buffer_enabled`/`_window_ms` | ตาม production intent | บันทึกค่าที่ใช้ |

## 4. Cost + time hard-stop contracts

### 4.1 Automated cost stop — **enforcement บังคับ (ไม่ใช่ counter)**

trusted counter/dashboard อย่างเดียว **ไม่ปลด G4** — ต้องมี enforcement จริง
อย่างใดอย่างหนึ่ง (`COST_STOP_MECHANISM`):

1. **provider-enforced hard limit** — hard budget/rate/call cap ที่ provider
   **reject calls** เมื่อชนเพดาน (enforcement อยู่ใน provider เอง), หรือ
2. **automated external supervisor** — process/job ที่อ่าน authoritative usage
   แล้วสั่ง `docker compose stop bot-worker` เมื่อแตะ `MAX_PROVIDER_CALLS` หรือ
   `MAX_PROVIDER_COST_USD`

manual observer/dashboard = **monitoring เท่านั้น** ไม่ใช่ hard stop
→ ไม่มี enforcement จริง → `G4 = BLOCKED_BY_MISSING_AUTOMATED_COST_STOP`

**หลักฐานที่ review ก่อน G4 (ครบทุกข้อ):**
- `COST_STOP_OWNER` — เจ้าของกลไก (assigned + reachable; ห้ามแทนด้วย
  `OBSERVER_OWNER`/`ABORT_AUTHORITY` คนละหน้าที่)
- configured threshold (`MAX_PROVIDER_CALLS`/`MAX_PROVIDER_COST_USD` เท่าไหร่)
- วิธีพิสูจน์ว่า armed แล้ว (`COST_STOP_ARMED_AT` + วิธีตรวจ)
- stop command/action ที่กลไกจะยิง (exact — เช่น compose stop)
- failure behavior ถ้า usage API/dashboard ใช้ไม่ได้ (fail-open ห้าม — ต้อง
  มี fallback stop หรือขึ้น abort)

### 4.2 Worker-request bound (per claimed turn)

- Stage A `workflow_enabled=false` → direct/trigger = **≤1 worker `/chat`
  request ต่อ claimed turn** (no retry contract — พิสูจน์ใน suite แล้ว)
- **ห้ามเขียนหรือสื่อว่า "≤1 provider call ต่อ turn"** — upstream calls ใน
  Python นับไม่ได้จาก worker (§1)
- Stage B `workflow_enabled=true` → run อาจเดินหลาย `let_ai_respond` + resume →
  **ห้าม derive** worker requests จาก inbound — ต้องนับฝั่ง boundary/usage จริง

### 4.3 Workflow enable note

- `workflow_enabled=true` ขยาย surface (multi-node calls + wait-timeout resume)
- เปิดเฉพาะ Stage B พร้อม bounds ใหม่ของตัวเอง — ห้าม carry ค่า bound จาก Stage A

### 4.4 Forced stop — **scheduler enforcement บังคับ**

`FORCED_STOP_TS` อย่างเดียวไม่พอ — ต้องมี automated scheduler/supervisor
(`FORCED_STOP_MECHANISM`) ที่ **armed ก่อนเปิด worker**:

- exact stop action ที่ mechanism จะยิงเมื่อครบ `FORCED_STOP_TS` (เลือกกลไกจริง —
  ไม่ invent command ที่ระบบไม่มี)
- owner (`FORCED_STOP_OWNER`) + armed proof (`FORCED_STOP_ARMED_AT` + วิธีตรวจ
  ว่า schedule ติดตั้งจริง)
- **ถ้า scheduler/supervisor ล้ม**: `COST_STOP_MECHANISM` ต้องยังตัด calls ได้
  + observer hard-stop process ทันที (§7)
- ไม่มีหลักฐาน armed ก่อน G4 → **BLOCKED**

## 5. Enable sequence

**Stage 0 — dry config**
1. `system_configs.main_config`: `bot_worker_enabled=false`,
   `bot_concurrency_limit=1`, `workflow_enabled=false`, buffer ตาม intent
2. mandatory values §3 ครบ — ไม่มี `MUST_SET_BEFORE_G4` ค้าง

**Stage A — canary window**
1. `bot_worker_enabled=true` ผ่าน admin config → edge ≤~7s → `enabledSince`
   (ข้อความเก่าไม่ process)
2. Mode A: seeded/test messages เท่านั้น — นับ worker requests + provider usage
   จริง vs `MAX_PROVIDER_CALLS`/`MAX_PROVIDER_COST_USD`
   Mode B: ทุก shop post-edge — observe inbound rate เทียบ planned spend
   estimate ที่ pre-compute (tail อาจเกิน — cost stop §4.1 เป็นตัวจำกัดจริง)
3. Window = `MAX_CANARY_DURATION_MINUTES` — ครบ → forced stop (§4.4)

**Stage B — ramp (ต้อง A ผ่าน + approval ใหม่)**
1. `bot_concurrency_limit` 1→3 live
2. `workflow_enabled=true` → นับ worker requests + provider usage จริง (§4.3)
3. bounds ของตัวเอง (`MAX_*` ชุดใหม่ — ห้าม carry Stage A)

**Stage C** — ramp ทีละขั้น + ≥24h observation ก่อน stable

## 6. Success / failure criteria (อ้าง mandatory keys ตรงๆ)

**Success**
- ทุก claim → terminal status ภายใน SLA (≤ buffer window + provider timeout)
- replies ต่อ inbound ≤1 (§8 query — window+origin scoped)
- `bot_failed` rate < `MAX_BOT_FAILED_RATE_PERCENT`% ของ terminal claims
- consecutive 429 < `MAX_CONSECUTIVE_429`, consecutive 5xx < `MAX_CONSECUTIVE_5XX`
- provider calls ≤ `MAX_PROVIDER_CALLS`, cost ≤ `MAX_PROVIDER_COST_USD`
  (provider-side authoritative usage เท่านั้น)
- ไม่มี crash loop / unhandled rejection ใน `docker logs bot-worker`
- `botworker_state` lease ต่อเนื่อง (`lease_expires_at` > now)

**Failure → abort ทันที**
- duplicate reply ต่อ inbound (same-identity) ≥1 เคส
- `bot_failed` rate ≥ `MAX_BOT_FAILED_RATE_PERCENT`%
- consecutive 429 ≥ `MAX_CONSECUTIVE_429` หรือ 5xx ≥ `MAX_CONSECUTIVE_5XX`
- provider calls ≥ `MAX_PROVIDER_CALLS` หรือ cost ≥ `MAX_PROVIDER_COST_USD`
- claims `processing` ค้าง >10 นาทีนับจาก lease expiry
- worker-request ยังเพิ่มทั้งที่ไม่มี inbound ใหม่ (runaway loop)

## 7. Emergency stop orders — แยก 2 กรณี

### Normal rollback (criteria ผ่าน/หมดเวลา/หยุดควบคุม)
1. DB toggle `bot_worker_enabled=false`
2. รอ paused confirm ≤ bounded TTL (~7s) — `[bot-worker] ... paused` →
   `clearPendingWork()` ฆ่า era
3. `docker compose stop bot-worker` ถ้าต้องการหยุดถาวร

### Cost spike / runaway (provider กำลังเผาตังค์)
1. **`docker compose stop bot-worker` ก่อน** — หยุด process ทันที
   (SIGTERM → `clearPendingWork()` + drain bounded `botCallTimeoutMs`)
2. ตั้ง `bot_worker_enabled=false` **ก่อน** restart ใดๆ
3. ตรวจไม่มี bot-worker process/container active
4. ตรวจ **provider activity** — ไม่มี upstream request ใหม่หลัง grace
   (**ห้ามใช้ `shadow_replies` count นิ่งเป็นหลักฐานเดียว**)

### Rollback verification (ครบทุกข้อ)
- [ ] `docker ps` ไม่มี bot-worker
- [ ] worker logs — ไม่มี fetch/claim ใหม่หลัง stop timestamp
- [ ] **provider usage/activity — ไม่มี request ใหม่ (primary evidence)**
- [ ] supporting: `chat_processing` ไม่มี terminal write ใหม่, `admin_logs`
      นิ่ง — supporting เท่านั้น ไม่ใช่ proof หลัก

## 8. Monitoring (window-scoped + origin-filtered)

> field names verify จาก code: `origin:"worker"|"workflow"`,
> `mode:"standalone"` (`botWorkerService:472-473,538-539`), workflow delivered
> replies ต่อท้าย `__wf<N>` → query ตรวจ duplicate **same-identity** เท่านั้น
> (หลาย workflow deliveries ต่อ inbound เป็นของตั้งใจ — ไม่ใช่ bug)

```js
// same-identity duplicate replies ใน window — เฉพาะ worker/workflow origin
db.shadow_replies.aggregate([
  { $match: {
      created_at: { $gte: CANARY_START_TS },
      origin: { $in: ["worker", "workflow"] },
      mode: "standalone"
  } },
  { $group: { _id: "$inbound_message_id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
]);
// claims ค้างใน window
db.chat_processing.find({
  status: "processing", claimed_at: { $gte: CANARY_START_TS },
  lease_expires_at: { $lt: new Date(Date.now() - 10*60*1000) }
});
// bot_failed + error pattern — terminal claims
db.chat_processing.find(
  { status: "bot_failed", processed_at: { $gte: CANARY_START_TS } }
).sort({ processed_at: -1 }).limit(50);
// workflow errors + timeout activity
db.admin_logs.find({
  action_type: { $in: ["workflow.run_errored", "workflow.wait_no_reply"] },
  timestamp: { $gte: CANARY_START_TS }
}).sort({ timestamp: -1 }).limit(50);
// leader lease liveness
db.botworker_state.find();
```

**429/500 ต้องดู 3 แหล่ง**: terminal claims (`bot_failed`+error string),
`docker logs bot-worker` (fetch errors), **provider dashboard/usage**
(authoritative — consecutive-count นับที่นี่)

## 9. Pre-enable checklist

- [ ] `EXECUTION_MODE` approved (A/B)
- [ ] mandatory values §3 **ครบทุกช่อง** — 0 `MUST_SET_BEFORE_G4`
- [ ] `COST_STOP_MECHANISM` เลือกกลไกจริง + `COST_STOP_OWNER` assigned & reachable
      + evidence §4.1 ครบ + `COST_STOP_ARMED_AT`
- [ ] `FORCED_STOP_MECHANISM` เลือกกลไกจริง + armed proof + `FORCED_STOP_ARMED_AT`
- [ ] `PROVIDER_COST_PER_CHAT_P95_USD` วัดจริง (บังคับสำหรับ Mode B)
- [ ] `bot_worker_enabled=false`, `bot_concurrency_limit=1`, `workflow_enabled=false`
- [ ] Mode B: inbound rate + planned spend estimate (p95-based) pre-computed
- [ ] rollback §7 reviewed + `ABORT_AUTHORITY`/`OBSERVER_OWNER` assigned & reachable
- [ ] Mongo read + `docker logs` + provider dashboard access พร้อม
- [ ] explicit user authorization สำหรับ G4

## 10. Gate status

```
G1 fake/static suites        PASS
G2 real-Mongo smoke          PASS 47/47
G3 corrected canary plan     READY_FOR_REVIEW
G4 worker enable             BLOCKED_BY_EXECUTION_MODE_AND_ENFORCED_LIMITS
G5 deploy                    NOT APPROVED
```

**G4 unblocks เมื่อครบทั้งหมด**: execution mode approved · exact
duration/calls/USD/failure thresholds · provider cost-per-chat measurement ·
automated cost stop configured **and armed** with `COST_STOP_OWNER` · forced
stop configured **and armed** · observer + abort authority assigned · rollback
actions reviewed · explicit user approval

---
*เอกสารแผนเท่านั้น — ไม่มี runtime/config/code เปลี่ยน*
