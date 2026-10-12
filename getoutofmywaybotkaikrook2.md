# getoutofmywaybotkaikrook2.md — Waythrough Log (active)

> ไฟล์นี้คือบันทึกเส้นทาง **ปัจจุบัน** — ทำอะไร แก้อะไร เคสไหนผ่านแล้ว แก้ยังไง
> `getoutofmywaybotkaikrook.md` (ไฟล์แรก) = **history — อ่านอย่างเดียว ห้ามเขียนเพิ่ม**
> **ก่อนทำอะไรใหม่ → อ่านทั้ง 2 ไฟล์ก่อนทุกครั้ง** (file 1 = เคสเก่าที่ผ่าน, file 2 = งานปัจจุบัน)
> ห้ามทำให้เคสที่เคยผ่านกลับมาพัง
> พอจะทำอะไรใหม่ → เขียนไว้ใน "กำลังจะทำ" ของ**ไฟล์นี้**ก่อน
> แก้เสร็จ → เขียนวิธีแก้ + ย้ายไป "ผ่านแล้ว" ของ**ไฟล์นี้**

---

## วิธีใช้ไฟล์นี้

1. **ก่อนทำงานใหม่** → อ่าน "เคสที่ผ่านแล้ว" ทั้ง file 1 (history) + file 2 ก่อน เพื่อไม่ทำลายของเก่า
2. **ก่อนแก้โค้ด** → เขียนไว้ใน "กำลังจะทำ" ของ file นี้ว่าจะแก้อะไร ทำไม
3. **แก้เสร็จ** → เขียน "วิธีแก้" + ย้ายเคสไป "ผ่านแล้ว" ของ file นี้ + อัปเดต "กำลังจะทำ"
4. **กฎเหล็ก**: ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify / บันทึก baseline ก่อนแก้ / ทุกอย่างที่เขียน ต้องเคยเกิดขึ้นจริง

---

## กำลังทำ (active)

### 🔍 Phase 2B.4 — Claim Episode/Lifecycle Owner (2026-10-14) · audit เสร็จ → รออนุญาต implement · ยังไม่ commit

- **baseline**: branch `feature-legacy-shopee-evidence-retrieval` @ `01d17d4` · tree สะอาด · commits 2B.2/2B.3 ยืนยัน (`1c26317`,`3775366`,`7e42bee`)
- **root cause (code จริง)**: `_claim_collecting` (warranty_flow.py:69) ใช้ retained slots เป็น activation — `{stage:"resolved", customer_name:...}` → True · stage/episode write กระจาย 11 จุด + 2 direct `_cp_ts*` bypass · resolve/clear อนุมานจาก reason string + ticket_state — ไม่มี episode identity
- **safety**: offline/fake เท่านั้น · ไม่ worker/.env/provider/LLM/TS · ไม่ stage/commit

#### 📋 Audit census (อ่านจาก code จริง)

- **lifecycle evaluators = 3+shadow**: `_claim_collecting` slot-predicate (call sites wf:288,295,412,1189,1196,1319,1389 + order_flow:68 + turn_decision:261) · `handle_warranty_flow` v2 + `handle_warranty_flow_legacy` = SM 2 ตัว · `decide_turn` = shadow (delegate `_claim_collecting`)
- **direct stage writers = 11**: `_update_claim_state({stage:collecting})` v2:461,518,601 + `_handle_first_message_claim`:1007 + legacy:1134,1376,1482,1570,1819 · direct bypass `_cp_ts2.update_claim_state({stage:resolved})`:1115 + `_cp_ts.update_claim_state({stage:ts_suggested})`:1785
- **clear writers = 3**: closed-ticket clear v2:327 + legacy:1247 · `_maybe_clear_claim_state`:123 (reason ∈ `_TERMINAL_CLAIM_REASONS` เป็น clear evidence)
- **activation slots**: `customer_name, customer_phone, customer_order_id, purchase_date, has_image, has_video`
- **`_TERMINAL_CLAIM_REASONS`** = {in_warranty, out_of_warranty, claim_info_incomplete} — live producers ครบ (ไม่มี dead entry) — ใช้เป็น clear evidence (ผิด role)
- **persisted fields วันนี้**: `stage, customer_name, customer_phone, customer_order_id, purchase_date, has_image, has_video, started_at, updated_at` — ไม่มี `episode_id`/`resolved_at`/`resolution_reason`
- **production paths**: `app.chat`→`handle_warranty_flow_legacy` (default) + `chat_v2`→`handle_warranty_flow` (opt-in) — owner ต้อง serve ทั้งคู่
- **xfails/fixtures เป้าหมาย**: `test_desired_terminal_stage_beats_retained_slots` (strict) · `p2a-claim-resolved-new-request` (executor: handoff+reason `"claim"`+new episode เคลียร์ case fields; tde `claim_request`/`current:claim_collect`) · `p2a-claim-ticket-closed-*` ×3 (desired: ticket close ≠ claim resolution → claim รอด) · `p2a-claim-collect-name-phone` (secondary owner claim_field_acceptance)
- **parity pins ต้องอัปเดต**: `claim-resolved-retained-slots` (tde claim_collect→unknown+contact_info) · `test_claim_collecting_marker` (slot-only→False) · `test_name_only_with_filled_slots_is_claim_collect` · `test_resolved_with_retained_slots_collects__parity_pin` · `test_clear_claim_state_unsets` · transport C4a/C4b (clear→resolve)

#### 🛠 Corrected implementation plan (post-review 2026-10-14 — Corrections A–E applied)

**Correction A — no reason-based resolution (แก้ plan เดิม)**: `_TERMINAL_CLAIM_REASONS`, `handoff_reason`, `claim_info_incomplete`, `warranty_claim_*` ลบจาก lifecycle authority — เป็น routing/audit metadata เท่านั้น (handoff สำเร็จ = ownership เปลี่ยน ไม่ใช่ claim จบ) · `_maybe_clear_claim_state`+`_TERMINAL_CLAIM_REASONS` ลบทิ้ง ไม่ rename · valid terminal evidence ใน 2B.4: (1) customer ยืนยันแก้สำเร็จหลัง troubleshoot (ts_success path :1109 เดิม) (2) persisted resolved|cancelled ที่อ่านจาก storage · admin event = 2B.6 ห้ามสร้างปลอม

**Correction B — terminal เก็บ evidence ไว้**: →resolved/cancelled = preserve episode_id + collected fields เป็น terminal record + terminal metadata จาก valid evidence เท่านั้น · fresh claim หลัง terminal = episode ใหม่ + identity allowlist `customer_name,customer_phone` เท่านั้น + reset `customer_order_id,purchase_date,has_image,has_video` + started_at ใหม่

**Correction C — fenced/idempotent persistence (audit เพิ่ม)**: `conversation_products` ไม่มี unique index บน conversation_id (ไม่มี create_index ใน repo เลย) · `ChatRequest` ไม่มี stable message_id → CAS บน expected episode = single-winner boundary · `update_claim_state` เดิม = read-modify-write whole-doc (non-atomic, LWW — race exposure จริง) · FakeColl `_match` ไม่ resolve dotted path (`doc.get(k)`) — ต้องขยายทั้ง 2 test fakes (Mongo จริงรองรับ natively) · `update_one` คืน matched_count (ใช้เป็น CAS signal ได้) · `$set` dotted key ทำงานใน `_apply` แล้ว · upsert insert-doc race (doc ยังไม่มีเลย) = pre-existing collection-wide hazard เทียบเท่า save_timeline/add_order_anchor — fenced CAS ปิด episode-level races; dup-doc window บันทึกเป็น residual (unique index = งาน 2B.5+)

**Correction D — history = evidence ไม่ใช่ owner**: `absent + genuine claim-info marker + current field` → transition absent→collecting ผ่าน owner (persist ก่อนรับ field) · `terminal + stale marker` → ห้าม reopen — owner refuses non-fresh transition จาก terminal รวมศูนย์ (caller ไม่ต้อง guard เอง)

**Correction E — interface**: `ClaimLifecycleView{episode_id, stage: absent|ts_suggested|collecting|resolved|cancelled, lifecycle_open, accepts_claim_fields}` — ชื่อเดียวตาม roadmap

**Design**:
1. `ClaimLifecycleView` (frozen dataclass) + `_claim_lifecycle(state)` evaluator เดียวใน warranty_flow.py — `lifecycle_open = stage∈{collecting,ts_suggested}`, `accepts_claim_fields = lifecycle_open` (open episode รับ claim-field submission; ts_suggested→collecting เมื่อรับ field); unknown/missing stage → absent
2. `_claim_transition(req, claim_state, to, fields=None, fresh_claim=False)` — transition owner เดียว คืน authoritative state:
   - `to=open-stage` + open → same-episode fenced merge (episode_id=None legacy doc → merge พร้อม episode_id ใหม่ = promotion)
   - `to=collecting` + absent → new episode (`episode_id=uuid4`, started_at) + identity copy + fields — CAS fence `episode_id $exists:false`
   - `to=collecting` + terminal + `fresh_claim=True` → new episode + identity allowlist copy เท่านั้น — CAS fence `episode_id==old`; fresh=True+open → same episode (retry-idempotent)
   - terminal + `fresh_claim=False` → **refuse** (คืน state เดิม) — stale marker ปลอดภัยทุก caller
   - `to=resolved` → fenced merge `{stage:resolved,resolved_at,resolution_reason}` preserve fields — caller เดียวคือ ts_success
   - `to=cancelled` → ไม่มี producer ใน 2B.4 (2B.6) — ไม่ implement path ที่ไม่มี caller
   - CAS miss → reread ครั้งเดียว → คืน authoritative winner · ห้าม retry loop
3. `conversation_products` storage primitives เท่านั้น: `load_claim_state` (คงเดิม) · `transition_claim_state(cid,platform,shop,expected_episode_id,claim_state)` CAS update_one fence บน `claim_state.episode_id` (`$exists:false` เมื่อ None) — miss → reread → doc ยังไม่มี → fenced upsert ครั้งเดียว (residual window เดิม) · `merge_claim_fields(cid,episode_id,fields)` fenced dotted `$set` + updated_at — miss → reread · `update_claim_state`+`clear_claim_state` **ลบ** (unfenced/no callers)
4. consumers: `order_flow:68`→`lifecycle_open`, `turn_decision:261`→`accepts_claim_fields`, wf gates ทั้ง v2+legacy → view เดียวกัน; marker legs (`_bot_asked_info`,`_bot_asked_claim_info`,`_warranty_ctx_in_history`) เข้า transition owner เสมอ — absent+marker → episode ใหม่ persist ก่อนรับ field; terminal → owner refuse
5. fresh-claim routing: `_is_claim_request` + `not lifecycle_open` → `_handle_first_message_claim` เส้นทางเดียว v2+legacy — `_claim_transition(collecting,fresh_claim=True)` + `handoff_reason="claim"` (fixture pin; ts-failed path ยัง `warranty_claim`)
6. ลบ: `_claim_collecting`, `_update_claim_state`/`_clear_claim_state` wrappers, closed-ticket clears :327/:1247 (**2B.5 prerequisite ปิดก่อนกำหนด — ticket close ≠ claim resolution; 2B.5 ยังเป็นเจ้าของ field-persistence/close-semantic tests ที่เหลือ — ห้ามประกาศ 2B.5 เสร็จ**), `_maybe_clear_claim_state`, `_TERMINAL_CLAIM_REASONS`, `_cp_ts*/_cp_ts2` bypasses :1115/:1785
7. terminal handoff ไม่แตะ claim_state เลย (แค่ลบ call `_maybe_clear_claim_state` ที่ :775) — episode เปิดต่อได้ post-handoff (flow เดิมออกแบบไว้) — `clear_claim_state`/`$unset` path หายทั้งหมด

**RED matrix** (ทั้งหมด fail ก่อน implement):
- A terminal precedence: resolved+slots→not collecting; bare name/phone หลัง terminal → ไม่ reopen (`test_desired_terminal_stage_beats_retained_slots` un-xfail + เพิ่ม cancelled + marker-refusal)
- B fresh episode: resolved/cancelled+explicit request → episode ใหม่≠เดิม, identity retained, case fields reset, started_at reset (`p2a-claim-resolved-new-request`)
- C same episode: collecting continuation episode เดิม; name→phone persist episode เดียว (`p2a-claim-collect-name-phone`)
- D ticket separation: closed ticket ไม่ clear (`p2a-claim-ticket-closed-*` ×3); terminal handoff ไม่ resolve/clear; handoff failure ไม่เปลี่ยน lifecycle
- E history migration: absent+marker+field → persist collecting; terminal+stale marker → refuse
- F race/idempotency: retry new-claim → episode เดิม; concurrent terminal→new → winner เดียว; stale-episode merge → miss+reread ไม่เขียนทับ; CAS loss → bounded reread

**Un-xfails**: `test_desired_terminal_stage_beats_retained_slots`, `p2a-claim-resolved-new-request`, `p2a-claim-ticket-closed-keeps-state`, `p2a-claim-ticket-closed-product-question`, `p2a-claim-ticket-closed-phone-resume`, `p2a-claim-collect-name-phone` (ถ้าเขียวจริง) — fixture flips: status incident→positive, ลบ `current`/`incident_levels` pins, อัปเดต boundary_note

### 🔍 Phase 2B.2 — Typed Handoff Outcome @ assignment owner (2026-10-12) · audit + RED contract ก่อน · ยังไม่ commit

- **baseline**: branch `feature-legacy-shopee-evidence-retrieval` @ `b4fbc82` (docs atop `d403f0a` fix 2B.1) · working tree dirty เดิม = `llm.py` M + `getoutofmywaybotkaikrook2.md` M + untracked diag/testscript/architecture doc — **leftovers ไม่แตะ**
- **scope**: ทำ `handoffToAdmin()` คืน `HandoffOutcome` typed (`assigned|queued|failed`) จาก persisted DB จริง แทน `{assignedTo nullable}`+`ok:true` ambiguous · bot-handoff route + caller ใน scope migrate · `queued` = durable `pending_assignment` (มีจริงใน code — backlogService/assignPendingTicket consume) · Python copy/flag = Phase 2B.3 boundary (audit map เท่านั้น ไม่แก้)
- **safety**: ไม่ worker/Mongo จริง/.env/provider/LLM/Shopee API · fake Mongo+hooks เท่านั้น · ไม่แก้ external Sellcenter writer · ไม่ stage/commit · ไม่แก้ runtime ก่อน audit+RED เสร็จ
- **baseline suite**: `test-ownership-transport.ts` **159/159 PASS** (ก่อนแตะ)

#### 📋 Audit findings (PART 1-3, อ่านจาก code จริง)

**caller/owner map (prod handoff command — 3 callers เท่านั้น)**

| caller | file:line | path |
|---|---|---|
| Python bot handoff | `api/admin/conversations/bot-handoff/route.ts:193` | prod branch (internal secret) |
| admin manual handoff | `api/.../[conversationId]/handoff/route.ts:32` | `json({ok,...result})` — no UI caller พบ |
| workflow assign_ticket auto | `workflowEngine.ts:1361` | `res.handoff={agentId:assignedTo,reason}` |

**owner layers วันนี้ (ใน handoffToAdmin เดียวมี write ≥4 จุด)**
- `handoffToAdmin` L74-175: getConv → getMeta → `reopenConversation`(unfenced upsert, wasClosed) → keep/reuse `assigned_to` → preferPrevious → `autoAssignConversation`→`tryAssign`(CAS fence `assigned_to null|missing`) → `updateStatus`(unfenced upsert) → `setPendingAssignment`(unfenced upsert `assigned_to:null`!) → `conversation.handoff` log
- route L223-235: `conversation.handoff` log ซ้ำอีก 1 (รวม handoff log ≤3 + chat_assigned ≤2 + conversation.open ≤1 = **audit ≤6 rows/1 handoff**)
- `simulateHandoff` L258-361 = **DEAD CODE** (~104 บรรทัด — simulate branch เรียก handoffToAdminTest ไม่ใช่ตัวนี้)

**false-success sites**
1. route → `{ok:true, assigned_to:null}` ทั้ง queued/failed — Python แยกไม่ได้
2. `conversation.handoff` log ยิงแม้ `assigned_to=null` (queued) + route ยิงซ้ำ
3. Python `guards._escalate` set `handoff_to_admin=True` หลัง fire-and-forget `_send_handoff` (returns `{}` on error ≡ `{assigned_to:null}` on queued)
4. **`setPendingAssignment` unfenced upsert `assigned_to:null` → loser race clobber winner's committed assignment** (bug จริง — ไม่ใช่แค่ ambiguity): A wins tryAssign → B's tryAssign miss → B `setPendingAssignment(true)` ทับ `assigned_to:null` ของ A
5. reopen→assign-fail window: closed conv ถูก reopen (handoff) แล้ว selection เจอปัญหา/throw → ค้าง unowned+no pending marker
6. `tryAssign` ไม่ clear `closed_at`/`pending_assignment` → residue ต้องพึ่ง write ตามหลัง

**queued = durable จริง**: `status:"handoff" + assigned_to:null + pending_assignment:true` — backlogService query `pending_assignment:true`, `assignPendingTicket` CAS claim, `/api/assignment/backlog` + `/backlog` page consume — **ไม่ใช้ `status:"pending"`** เพราะ (a) flag คือ durable marker เดิมที่ pipeline ทั้งสายอ่าน (b) UI filter มีแค่ `all|bot|handoff|closed` — queued ที่ status=pending จะหลุดจาก tab "ส่งต่อแอดมิน" (regression) (c) prompt: contract ต้องตรง DB จริง

**outcome forms วันนี้**: `{assignedTo,assignedToName,reopened,assignmentReason}` + null-ambiguity + throw + route `ok:true` + Python `{}` — caller เดา 4 แบบ

**implementation plan (minimal, owner เดิม)**:
- `statusConversationService.commitHandoffState` (ใหม่ — fenced writer เดียว): `findOneAndUpdate(fence, $set, {upsert, returnDocument:"before"})` — fence `{assigned_to null|missing}` (fresh) หรือ `{assigned_to:X}` (closed+owner re-assert); assigned→`{status:handoff,assigned_to:X,assigned_at,mode,pending_assignment:false,closed_at:null,closed_by:null}`; queued→`{status:handoff,assigned_to:null,pending_assignment:true,reason,closed_at:null,closed_by:null}`; คืน `{committed,prior}` (prior=before doc → dedupe audit/transition; E11000→miss→caller converge)
- `assignmentService.selectNextAgent` (extract จาก autoAssignConversation — shop-check+mode+buildPool+pickNextAgent) — autoAssignConversation refactor ใช้ตัวเดียวกัน (กัน duplicate selection logic)
- `handoffToAdmin` → `Promise<HandoffOutcome>`: owned+!closed→converge assigned(0 write,0 log); closed+owner→commit re-assert; unowned→select→commit; miss→bounded re-read→converge; commit→settle reopen(wasClosed)+audit 1×; throw→failed
- route: `{ok:true,outcome,assigned_to,...compat fields}` + ลบ log ซ้ำ; `[id]/handoff` spread outcome; workflowEngine auto → `handoff:{agentId,reason,state}`
- ลบ dead `simulateHandoff`
- out-of-scope inventory: handoffToAdminTest/test stores, manualAssign (explicit-admin CAS — assign route+workflow wantAdmin), assignPendingTicket (distributor CAS — status=handoff คงเดิมเข้ากันได้), reopen/close/resolve routes, Python (`_send_handoff`/`_escalate`/copy = 2B.3), external writer, bot_claim_info write (2B.6)

#### ✅ RED→GREEN evidence (2026-10-12) · gate PASSES → implemented · ยังไม่ commit

- **RED**: suite `test-ownership-transport.ts` + 13 tests (H1-H13) → **159/172** (H ทั้ง 13 FAIL honest — missing `.state`/`.outcome` contract + H7 race clobber จริง: loser `setPendingAssignment` ทับ winner `assigned_to:null`)
- **Gate**: root cause+owner ชัด · RED honest (fakemongo รองรับ returnDocument:"before"/E11000/interleave hooks อยู่แล้ว) · ไม่มี arch ใหม่ (+1 method +1 extraction ใน owner เดิม) · outcome อยู่ใน handoffToAdmin เดิม · ไม่มี guard ซ้อน → **PASS → implement**
- **Runtime changes**:
  - `statusConversationService.commitHandoffState` (ใหม่ ~55 บรรทัด) — fenced writer เดียว: `findOneAndUpdate(fence,$set,{upsert,returnDocument:"before"})` fence `{assigned_to null|missing}`/`{assigned_to:X}`; assigned→`{status:handoff,owner,assigned_at,mode,pending_assignment:false,closed_at:null,closed_by:null}` / queued→`{status:handoff,assigned_to:null,pending_assignment:true}`; E11000→miss
  - `assignmentService.selectNextAgent` (extract) — pure selection ใช้ร่วม autoAssignConversation+handoffToAdmin
  - `handoffToAdmin` → `Promise<HandoffOutcome>`: owned+!closed→converge(0 write/log); select→commit; miss→re-read converge; committed→prior-doc dedupe → audit 1× (chat_assigned+conversation.handoff / queued→handoff only) + reopen settle ผ่าน recordReopen
  - route bot-handoff: `outcome` + compat fields + **ลบ route handoff log ซ้ำ + dead `simulateHandoff` ~105 บรรทัด**
  - `[id]/handoff` route + workflowEngine auto assign_ticket → consume outcome (+`state` ใน handoff result)
- **GREEN**: **172/172 PASS** (H1-H13 ครบ + 159 เดิม) · tsc --noEmit clean · `next build` pass · `git diff --check` clean · regression: workflow-phase1 69/0, workflow-phase6 69/0, admin-logs-pagination 57/0, shadow-batch-isolation 22/0 (e2e ข้าม — real Mongo)
- **SRS/schema**: อัปเดต SRS rows (handoffService/statusConversationService/assignmentService/route transport) + schema.md (assignment_reason field, commitHandoffState writer)
- **bug ที่แก้จริง**: (a) race clobber — loser `setPendingAssignment` unfenced upsert ทับ `assigned_to:null` ของ winner (b) audit ≤6 rows/handoff → 1-2 หลัง commit (c) `assignedTo:null` ambiguity → typed state 3 ค่า (d) dead simulateHandoff (e) reopen→pending-fail window — commit เดิมคลุม close residue

#### 🔍 Phase 2B.2 review-fix (2026-10-13) — independent review 2 High + 2 Medium · TDD RED→GREEN · ยังไม่ commit

- **PART 0 verify (code จริงทั้ง 5 ข้อ = CONFIRMED)**:
  1. `handoffToAdmin` post-CAS settle (`recordReopen`/`logAdminEvent`×2) throw → catch คืน `failed/persisted:false` ทั้งที่ meta committed แล้ว; retry ชน early-converge → audit/close-history ไม่ถูกซ่อมถาวร (ไม่มี durable unsettled marker)
  2. `workflowEngine` auto คืน `{handoff:{agentId:null,state:"failed"}}` → `botWorkerService.settleWorkflowResult` เช็ก `wfResult.handoff ? "handed_off"` (presence-only) → failed กลายเป็น handed_off + `ref:null`; audit `workflow.assign_ticket` ยิง unconditional
  3. workflow direct `admin_id` ใช้ `manualAssign():boolean` (parallel boolean owner — ไม่ clear pending/closed residue) + CAS แพ้คืน `meta?.assigned_to` (stale pre-race ไม่ใช่ persisted winner)
  4. `pickNextAgent` เขียน cursor ใน selection ก่อน `commitHandoffState` — duplicate/concurrent 1 assignment กิน 2 ตำแหน่งคิว
  5. catch ใส่ `e.message` ดิบลง `outcome.reason` → route `console.log` + API response — Mongo URI/query/newline leak
- **RED gate**: suite **173/180** — I1/I2 settle-throw คืน `failed/persisted:false` ทั้งที่ commit แล้ว · I4 workflow auto failed ยัง surface `handoff` · I6 direct คืน untyped `{agentId}` · I7 CAS loser คืน stale `admin-1` แทน persisted winner · I8 1 assignment กิน cursor 2 ตำแหน่ง · I9 Mongo URI+credential+query+newline leak ผ่าน `outcome.reason`/route log · I5 queued pin PASS · 172 เดิมเขียวครบ zero regression
- **design gate (ผ่าน — ไม่มี infra ใหม่)**: unsettled marker = `handoff_settled:false`+`handoff_event_id`+`handoff_reopened`+`handoff_rr_pool_key` persist **ใน commit CAS เดียวกัน** · stable identity = eid จาก committing caller (retry อ่านจาก doc ไม่ gen ใหม่) · audit dedupe ผ่าน `logAdminEvent(eventId)` sha256 `_id` เดิม · `markHandoffSettled` fenced บน eid · single owner = `handoffToAdmin({targetAdminId,actor})` (`manualAssign` ลบ — callers 2 จุด migrate) · cursor = `peekNextAgent` (no write) → commit persist poolKey → settle `markCursorAssigned(committed owner)` หลัง commit เท่านั้น · `failed` ไม่ surface `EngineResult.handoff` (type `Exclude<HandoffOutcomeState,"failed">` กัน compile-time)
- **ผ่านแล้ว (Review-Fix Impl, 2026-10-13):**
  - `statusConversationService.commitHandoffState` — tightened fences (committed ⟹ real transition: direct→owner∈{expected,null}, retained→assigned_to=expected, unowned→null, queued→+`pending_assignment≠true`, caller-claim-reopen→+`status∈{closed,resolved}` → `handoff_reopened` = fenced truth ไม่ใช่ stale read) + settlement marker ใน `$set` เดียวกัน + คืน after-doc · +`markHandoffSettled(convId,eid)` fenced clear · `manualAssign` ลบ
  - `handoffService.handoffToAdmin` — crash-recovery: meta.`handoff_settled===false`→`settleHandoffTransition` ด้วย eid เดิม (recordReopen ตอน flag, `chat_assigned`+`conversation.handoff` audits, `markCursorAssigned`, eid-fenced clear — ทุก step idempotent) · settle throw → `{persisted:true,settled:false,error_code:"settle_error"}` ไม่ใช่ failed · CAS miss converge +ซ่อม settle ผู้ชนะ · `targetAdminId` direct-assign · sanitizer: catch→`{reason:"handoff failed",error_code:"handoff_error"}` (raw exception ไม่ออก outcome/API/stdout)
  - `assignmentService` — `selectNextAgent`→`peekNextAgent` (cursor read-only, คืน poolKey) · +`markCursorAssigned(poolKey,agentId)` caller-owned post-commit · `autoAssignConversation` mark หลัง `tryAssign` สำเร็จ · `pickNextAgent` เหลือเป็น legacy test contract
  - `workflowEngine assign_ticket` — prod direct `admin_id`→`handoffToAdmin({targetAdminId,actor:"workflow-engine"})` (CAS loser → persisted winner); prod auto+direct: `failed`→`{}` ไม่ surface handoff ไม่ยิง success audit; `EngineResult.handoff.state` = `Exclude<…,"failed">` → `botWorkerService.settleWorkflowResult` presence-check = `handed_off` ถูกต้องโดย type
  - `[id]/assign` route — `manualAssign`→`handoffToAdmin({targetAdminId})`; 409 คืน persisted `assigned_to` ของผู้ชนะ
  - `closeHistoryService.recordReopen` — audit-first คงไว้ (`conversation.open` eid-dedupe ก่อน stamp) — settle path เรียกด้วย `messageId=handoff_event_id`
  - **Verify**: ownership transport **180/180** (I1–I9 ผ่าน + B1/B1b rewrite ผ่าน typed owner + H11 fenced-reopen แก้ regression รอบแรก) · workflow-phase1 69/0 · phase6 69/0 · admin-logs 57/0 · shadow-isolation 22/0 · botworker: idempotency 71/0, races 37/0, boundary 20/0, error-policy 38/0, recovery-freshness 59/0, mongo-safety 110/0, config-failclosed 4/0, enable-checkpoint 18/0 · `tsc --noEmit` ✓ · `next build` ✓ · `git diff --check` ✓
  - Docs: SRS_SSD handoffService/assignmentService/statusConversationService/workflowEngine rows · schema.md +4 settlement fields +writer row +recordReopen callers
  - กรณีพิเศษที่เจอระหว่าง impl: `onlyIfCloseRecord` gate ตอนแรกทำ H11 regression (closed conv ไม่มี close-history → open audit หาย) → root fix ที่ fence (`status∈{closed,resolved}` guard เมื่อ claim reopen) ทำให้ flag เป็น truth แทนการ gate ฝั่ง settle → param ถูกลบ
  - **Verdict: `PHASE_2B2_ROOT_CAUSE_CLOSED`** — ยังไม่ stage/commit/push/deploy รอ review

#### 🔍 Phase 2B.2 Architecture Correction (2026-10-13) — Settlement Liveness + Concurrent RR Correctness · audit/RED ก่อน · ยังไม่ commit

- **PART 0 state diagram (code จริง)**:
  ```
  unowned/bot/closed → commit CAS {owner, eid, settled:false, reopened, rr_pool_key}
    → settle: recordReopen? → chat_assigned? → conversation.handoff → markCursorAssigned? → markHandoffSettled(eid)
    settled:true
  ```
  | transition | writer | retry | durable id | caller gets | process ตายตรงนั้น ใครปลุก |
  |---|---|---|---|---|---|
  | ownership commit | commitHandoffState CAS | CAS miss→converge re-read | meta doc | typed outcome | n/a (committed) |
  | reopen stamp+open audit | settle→recordReopen | call ถัดไปเท่านั้น | eid | outcome.settled | **ไม่มี** |
  | chat_assigned/handoff audit | settle→logAdminEvent | call ถัดไปเท่านั้น | eid dedupe | outcome.settled | **ไม่มี** |
  | cursor mark | settle→markCursorAssigned | call ถัดไปเท่านั้น | pool_key doc | — | **ไม่มี** |
  | settled flag | markHandoffSettled | call ถัดไปเท่านั้น | eid fence | — | **ไม่มี** |
- **PART 0 findings (9/9 CONFIRMED)**:
  1. `handoff_settled:false` ซ่อมเฉพาะ call ถัดไปของ `handoffToAdmin` — committed conv ล็อคบอท → Python ไม่ call ซ้ำ → **ไม่มี guaranteed repair owner**
  2. bot-handoff route คืน 200 เมื่อ `settled:false` — Python `_send_handoff` best-effort **ไม่ retry non-2xx** (responses.py:94-99) + post-commit conv locked → ไม่มี second call ทั้งสองทิศ
  3. workflow `failRun` = terminal (`status:"errored"`); `checkWaitTimeouts` scan เฉพาะ `waiting_for_reply`; completed run ไม่ retry → unsettled marker ทิ้งไว้
  4. admin assign: human retry เท่านั้น (unguaranteed)
  5. `peekNextAgent` read-only → conv X/Y พร้อมกัน peek cursor เดียวกัน → ได้ admin คนเดียวกันทั้งคู่ → rotation เสีย
  6. `markCursorAssigned` unconditional update → event เก่า settle ช้าเขียนทับ cursor ของ transition ใหม่ (rewind)
  7. `pickNextAgent` legacy wrapper (read+unconditional write — racy) ยัง exported ใช้โดย test path
  8. CAS-loser converge คืน `settled` จาก pre-settle snapshot (m2 อ่านก่อน settle รัน)
  9. `markHandoffSettled` ไม่เช็ก matchedCount
- **caller inventory**: `commitHandoffState`→handoffToAdmin (prod owner เดียว) · `tryAssign`→autoAssignConversation+tests only · `autoAssignConversation`→tests only (botWorkerService = stale comment) · `setPendingAssignment`→tests only · `pickNextAgent`→doHandoffToAdminTest only · `peekNextAgent`→selectNextAgent · `markCursorAssigned`→settle+autoAssign · `markHandoffSettled`→settle · `reassignConversation`→/api/assignment/reassign (distinct admin-transfer command — ไม่กินคิว) · `assignPendingTicket`→backlogService (distinct queued→assigned command) · `recordReopen`→settle+reopenConversation+applyInbound (reopen side-effect owner เดียว)
- **key code evidence**: `assignment_cursors.pool_key` มี unique index อยู่แล้ว (mongoClient.ts:152) → atomic CAS-claim ทำได้โดยไม่ต้องเพิ่ม index · `failRun`→`status:"errored"` terminal · `checkWaitTimeouts` leader-gated แต่ scan เฉพาะ waiting_for_reply · Python no-retry verified
- **PART 1 RED (180/189 — 9 honest fails)**: J1/J2/J9 `settled`/`handoff_settled`/`handoff_rr_pool_key` marker ยังอยู่ · J3 committed-but-never-emitted doc → converge ไม่ emit → audits=0 (permanent gap) · J4 legacy paths ยังอยู่ · J5 `x=admin-1 y=admin-1` (multi-conv race reproduce) · J6 cursor=undefined (commit-miss ไม่ consume) · J7/J8 next=admin-2 (rewind/re-consume) — 180 เดิมเขียวครบ
- **PART 2 architecture gate (PASS — zero new infra)**: settlement → **Option A' marker-free single-phase** (Option A caller-retry FAIL: Python best-effort no-retry + workflow failRun terminal + admin human-only; Option B extend checkWaitTimeouts = เพิ่ม background recovery → stop-trigger + couples web correctness กับ worker liveness; Option C transaction ไม่มี topology evidence) — ไม่เพิ่ม owner ให้ pending state แต่**ลบ pending state**: ownership CAS = guaranteed durable phase เดียว; emissions = eid-idempotent emit หลัง commit + re-emit ทุก converge (dedupe = free repair); residual = audit gap iff emit-fail+no-later-call (same window as marker design, detectable ผ่าน eid — precedent: `applyInboundOwnershipTransition` run model เดียวกันอยู่แล้ว) · RR → **reservation-order** (committed-order exact ข้าม 2 collections เป็นไปไม่ได้โดยไม่มี txn; `reserveNextAgent` = atomic CAS-claim `{pool_key,last:observed}→{last:next}` บน unique index เดิม; commit-miss→forfeit bounded skip; ไม่มี cursor write หลัง commit → rewind เป็นไปไม่ได้ by construction)
- **ผ่านแล้ว (Architecture Impl, 2026-10-13):**
  - `statusConversationService` — fields: `-handoff_settled -handoff_rr_pool_key +handoff_actor +handoff_reason` (transition truth ครบ — caller ใดก็ emit ด้วย attribution เดิม); `commitHandoffState` opts `-rrPoolKey +callerReason +actor`; **ลบ `markHandoffSettled`/`tryAssign`/`setPendingAssignment`** (parallel ownership/settlement paths)
  - `assignmentService` — **`reserveNextAgent`** = cursor writer เดียว (atomic CAS-claim bounded 3: stale-observer loses→re-read); `selectNextAgent` คืน `{agentId,mode}`; **ลบ `peekNextAgent`/`pickNextAgent`/`markCursorAssigned`/`autoAssignConversation`**
  - `handoffService` — `HandoffOutcome` ลบ `settled` (outcome = ownership truth only); `settleHandoffTransition`→`emitHandoffSideEffects` (persisted attribution, ไม่มี cursor, ไม่มี clear); `handoffToAdmin`: ลบ settle-pending block; converge/CAS-miss/post-commit ทุกจุด `tryEmitHandoff` (emit fail→warn เท่านั้น outcome ยัง truth); commit ส่ง `callerReason`/`actor`; `doHandoffToAdminTest` ใช้ `reserveNextAgent`
  - tests — +J1–J9 (9 tests); **ลบ** B2/B5/B7/B9/B10/I8 (test-only functions + superseded contract); B6 re-seed ผ่าน seedMeta
  - **Verify**: ownership transport **183/183** · workflow-phase1 69/0 · phase6 69/0 · admin-logs 57/0 · shadow-isolation 22/0 · botworker: idempotency 71/0, races 37/0 (B4 op-fence ผ่านใต้ reservation semantics), boundary 20/0, error-policy 38/0, recovery-freshness 59/0, mongo-safety 110/0, config-failclosed 4/0, enable-checkpoint 18/0 · `tsc --noEmit` ✓ · `next build` ✓ · `git diff --check` ✓
  - Docs: SRS_SSD handoffService/assignmentService/statusConversationService rows · schema.md status_conversation +4 transition fields (−2 marker fields) + assignment_cursors access + writer list + recordReopen callers
  - **Complexity**: functions −7 (`tryAssign`/`setPendingAssignment`/`autoAssignConversation`/`markHandoffSettled`/`peekNextAgent`/`pickNextAgent`/`markCursorAssigned`) +2 (`reserveNextAgent`/`emitHandoffSideEffects`+`tryEmitHandoff`); durable fields 4→4 (settled/rr_pool_key → actor/reason); ownership writers 1 (`commitHandoffState`); cursor writers 1 (`reserveNextAgent`); settlement-retry owners 0 (ไม่มี pending phase); outcome fields −1
  - **Verdict: `PHASE_2B2_ARCHITECTURE_ROOT_CLOSED`** — residual documented (audit gap iff emit-fail+no-later-call, detectable via eid) · ยังไม่ stage/commit/push/deploy รอ review

- **baseline**: branch `feature-legacy-shopee-evidence-retrieval` @ `4c5e57a` (docs) atop `ad13494` (fix) · working tree dirty เดิม = `llm.py` modified + untracked `diag-worker-dup*`, `quarantine_rollback*`, `test_vision_dedupe`, architecture-audit doc — **leftovers ไม่แตะ**

## Phase 2B.2 Final Root-Cause Correction — transport truth (2026-10-13, รอบ 3)

- **เป้าหมาย**: 4 findings จาก independent review — A. contention กลายเป็น no_available_admin, B. route 200 ตอน failed, C. emit failure ถูก swallow ไม่มี repair caller, D. SRS contract เก่าซ้ำ — แก้ contract ต้นทาง ไม่เพิ่ม subsystem
- **PART 0 audit — CONFIRMED ทั้งหมด**:
  - A. `reserveNextAgent:155` return `null` รวม no-eligible+contention → `selectNextAgent.agentId:null` → `handoffToAdmin:222` → `desired:null` → commit `adminId:null` = **queued+`no_available_admin` persisted** ทั้งที่ eligible admins มี — contention เขียนสถานะโกหก durable
  - B. `bot-handoff/route.ts:234` `json({ok:true,outcome,...})` — **200 ทุก state** incl. failed; `responses._send_handoff:87-93` คืน body บน 2xx ใดๆ (ไม่อ่าน outcome) → caller เห็น truthy
  - C. `tryEmitHandoff:138-147` swallow emit error → outcome `persisted:true` → route 200 → Python หยุด — **repair caller ไม่มี** (bot หยุดตอบหลัง handoff → converge-emit ไม่มีใครเรียก) — mechanism มีแต่ไม่มี signal
  - D. `SRS_SSD.md:985` tail มี stale block `commitHandoffState({conversationId,adminId,fenceOwner?...})→{committed,prior}` ขัด contract ใหม่ `{adminId,expectedOwner,direct,mode,reason,callerReason,actor,eventId,reopened}→{committed,doc}`
  - **Python caller audit**: `_send_handoff` no-retry คืน `{}` ทุก failure; **11+ call sites** claim `handoff_to_admin=True`+คำตอบ "ส่งแอดมิน" โดยไม่อ่านผล: handoffs.py:328/388/600, order_flow.py:212/317, chat_v2.py:568/592, warranty_flow.py:1699/1925/2047, guards._escalate:384 — **app.py:4353 no_product_found ตั้ง flag=True โดยไม่มี transport call เลย** · direct urllib blocks: warranty_flow.py:762-801 (v2 builder), :976-1002 (tax follow-up fire-and-forget ไม่อ่าน response!), chatbotv3/engine.py:90 `_send_handoff_to_admin` (USE_CHAT_V3 production-reachable — impl ที่ 3) · `_maybe_clear_claim_state` (:805,:1731) clear บน attempt ไม่ใช่ผลจริง · `check_output(handoff_sent=True)` ข้าม output-policy ทั้งหมด — flag ปลอม = ปิด validation
- **Design gate (PASS — zero new infra)**: (1) `reserveNextAgent`→discriminated `ReservationResult{result:"reserved",agentId}|"no_eligible_agent"|"contention"`; `selectNextAgent` propagate; `handoffToAdmin` map contention→`failed{reservation_contention}` **ก่อน commit — ไม่ persist อะไร**; (2) `emitHandoffSideEffects`→`Promise<boolean>` (merge tryEmitHandoff — ไม่ swallow อีกต่อไป); `HandoffOutcome.emit_incomplete` = transport signal (ไม่ใช่ durable marker — ownership truth ไม่ย้อน); (3) `handoffOutcomeHttpStatus(outcome)` shared mapper: failed→404/503/500 ตาม error_code, emit_incomplete→503, else 200 — test_source/simulate สร้าง outcome เดียวกัน (in_flight→failed→503); (4) Python `_send_handoff` = transport owner เดียว — `_post_handoff` bounded retry (same bytes→same identity): 2xx+outcome∈{assigned,queued}→body; 2xx+failed/no-outcome→None; 401/403/404/422→None immediate; 408/429/5xx/network/timeout→retry ≤3; caller ทุก site gate flag+answer บนผลจริง (shared `_HANDOFF_FAILED_ANSWER` copy); urllib dup blocks → `_send_handoff`; chatbotv3 → `_post_handoff` เดียวกัน · residual: emit-fail+retry-exhausted → audit gap (detectable ผ่าน eid) — report ตรงๆ ไม่ claim guaranteed
- **RED evidence (ห้าม patch ก่อน)**:
  - TS `test-ownership-transport.ts` **181/194** — RED 13: K1–K4 (typing/selection→queued เท็จ) · K6–K8/K10–K11 (route/test-path HTTP+outcome) · I1/I2/J1/J2 (emit_incomplete signal เดิมไม่มี) · K5 real CAS interleave + K9 queued-pin PASS แล้ว (reservation core รอด)
  - Python `docs/test/test_handoff_transport.py` **12/29** — RED 17: T3/T4 (2xx+failed/ไม่มี outcome → truthy) · T5/T6/T9/T10 (zero retry) · C1–C5 (callers claim ส่งแอดมินบน exhaustion — flag=True+claim answer) · C6 (v3 ไม่มี retry) · C4a เผย test bug → answer ชน keep-collecting guard ("ได้รับข้อมูล") แก้เป็น terminal answer แล้ว
- **กำลังทำ**: implementation — TS typed selection + emit_incomplete + route status mapper; Python `_send_handoff` bounded retry + caller gating + urllib consolidation; SRS stale-block rewrite
- **ผ่านแล้ว (รอบ 3 — 2026-10-13)**:
  - TS: `AgentSelection{reserved|no_eligible_agent|contention}` ที่ `reserveNextAgent` (CAS-miss ครบ cap→contention ไม่ใช่ null); `selectNextAgent` propagate+mode; `handoffToAdmin` map contention→`failed{reservation_contention}` ก่อน commit (zero durable write); `emitHandoffSideEffects`→boolean → `emit_incomplete` บนทุก outcome (ownership คงอยู่); `handoffOutcomeHttpStatus`: assigned/queued→200, `conversation_not_found`→404, failed/emit_incomplete→503 sanitized; assign/handoff admin routes ใช้ mapper เดียวกัน; `handoffToAdminTest` contention→`in_flight` ไม่ใช่ no_available_admin
  - Python: `_send_handoff` = transport owner เดียว — `dict|None`, typed outcome เป็น authority (2xx+assigned/queued เท่านั้น), 4xx-permanent→None ทันที, 408/429/5xx/network→retry ≤3 payload เดิม; `HANDOFF_FAILED_REPLY` shared; callers ทุก site gate flag+answer+claim-clear บนผลจริง (handoffs×3, order_flow×2, chat_v2×3 incl. `_no_product_guard`, guards._escalate, warranty builder+tax+legacy block, app.py no_product_found — เดิม flag=True โดยไม่มี transport เลย)
  - Consolidation: direct urllib handoff blocks ลบ 3 (warranty_flow ×2, chatbotv3 → delegate `_send_handoff`) + warranty_flow legacy transport block (~70 บรรทัด dup ของ `_build_warranty_claim_response` — crash บน None + flag ไม่ gate) → delegate builder เดียว
  - SRS: ลบ stale `commitHandoffState({fenceOwner})→{committed,prior}` tail ซ้ำ · outcome +`emit_incomplete` · assignmentService typed selection · transport row HTTP matrix · `_send_handoff`/`_send_handoff_to_admin` contract ใหม่
  - Test bug fix: `forceCursorMiss` เดิม set `last=pool[n%len]` ชน observed ได้ → sentinel คนละค่าเสมอ (K2/K6/K10/K11 เขียวหลังแก้ harness ไม่ใช่ prod)
  - **Verify สด**: TS ownership **194/194** (K1–K11 ครบ) · Python **29/29** · error-policy 38 · idempotency 71 · races 37 · recovery 59 · boundary 20 · mongo-safety 110 · config 4 · enable 18 · py_compile 8 files · `tsc --noEmit` 0 · `npm run build` ✓ (84/84) · `git diff --check` ✓
  - Residual (ตรงๆ): emit-fail+retry-exhausted+ไม่มี call ถัดไป → audit gap ถาวร (detectable ผ่าน `handoff_event_id` ไม่ใช่ guaranteed repair — ไม่มี durable outbox); contention→failed ทำให้ลูกค้าได้ fallback reply + conv ยัง bot-owned (bot ตอบต่อได้ ไม่ใช่งานหาย)
  - **Verdict: `PHASE_2B2_TRANSPORT_TRUTH_CLOSED`** — 4 findings ปิดที่ต้นทาง · ไม่มี helper/subsystem ใหม่ · ยังไม่ stage/commit/push/deploy รอ review

#### Legacy Path Closure (2026-10-13, รอบ 4 — 2 High + 1 Medium)

- **PART 0 audit — CONFIRMED**:
  - L-tax: `warranty_flow.handle_warranty_flow_legacy` ~1800-1847 — duplicate ของ canonical `_handle_tax_invoice_followup` (trigger logic เหมือนกัน verbatim) แต่ `_send_handoff` ทิ้งผล + `handoff_to_admin=True` unconditional + answer claim ส่งแอดมินเสมอ
  - L-first: `handle_warranty_flow_legacy` ~1942-1981 — `_send_handoff` คืน `None` ได้ แต่เรียก `.get()` ทันที (AttributeError บน transport fail) + `handoff_to_admin=True` unconditional; canonical `_handle_first_message_claim`→`_build_warranty_claim_response` มี truth gating อยู่แล้ว
  - T-src: `bot-handoff/route.ts` test_source branch — `handoffToAdminTest` return แล้วเขียน claim metadata (`bot_claim_info`/`bot_handoff_at`) + `logBotworkerEvent(bot_handoff)`/`logAdminEvent(conversation.handoff)` + `invalidateBotworkerCache` **ก่อน** `testOutcome` classify — `in_flight→failed→503` แต่ side effects เขียนไปแล้ว; `simulate` branch บัคเดียวกัน (claim write ก่อน sOutcome)
- **Plan**: delegate ไม่ใช่ patch — legacy tax → `_handle_tax_invoice_followup`; legacy first-message → `_build_warranty_claim_response` (claim_ctx เดียวกับ canonical: `{"claim_topic":"เคลม/ซ่อม/ประกันสินค้า"}` = reason "warranty_claim" เหมือนเดิม; answer "รบกวนแจ้งข้อมูล" → keep-collecting guard รอด ไม่ clear stage); route → คำนวณ `tOutcome`/`sOutcome` ทันทีหลัง handoffToAdminTest + early return failed ก่อน side effects ทั้งสอง branch
- **RED baseline (ก่อนแก้ — fail จาก behavior จริงทั้งหมด)**:
  - Python `test_handoff_transport.py`: **32/35** — L1b (exhausted → flag=True + "ส่งต่อแอดมิน" answer), L2b (`AttributeError: 'NoneType' object has no attribute 'get'` บน transport fail), L2c; success paths L1a/L2a ผ่าน
  - TS `test-ownership-transport.ts`: **194/196** — K12 (in_flight → 503 แต่ `bot_claim_info`+`bot_handoff_at` เขียนลง test_status_conversation ก่อน classify), K13 (simulate เขียน `bot_claim_info` ลง test_chat_sessions ก่อน sOutcome)
- **Fixes (error → cause → fix → impact)**:
  - L-tax: exhausted 503 → `handoff_to_admin=True` + "ส่งต่อแอดมิน" answer → legacy block duplicate ของ canonical ทิ้งผล `_send_handoff` → delegate `_handle_tax_invoice_followup` (owner เดิม, `tax_invoice_handoff` label เหมือนกัน) → tax branch เดิน canonical gating; canonical ได้ `intent`/`timing` จาก ctx คืบค่าที่ legacy เคย emit
  - L-first: transport fail → `AttributeError 'NoneType'.get` / `handoff_to_admin=True` → inline `_send_handoff`+`.get`+flag unconditional → เก็บ troubleshoot-first/`auto_ctx`/`update_claim_state` แล้ว delegate tail → `_build_warranty_claim_response(claim_ctx={claim_topic, handoff_reason:"warranty_claim"}, source="warranty_claim_first_message")` → crash หาย, flag ตาม outcome, claim state เดิม (ask-info marker → ไม่ clear), `handoff_reason="warranty_claim"`/`reason`/simulate/timeout เหมือนเดิม; eval `_POLICY_SOURCES` ไม่กระทบ
  - L-review (เจอเพิ่ม ระหว่าง audit): legacy review block ~84 บรรทัด duplicate `_handle_review_request` verbatim (extraction/name-filter/answer/flag เหมือนกัน) → delegate — flag semantics เดิม (mid-flow marker, future-tense answer)
  - T-src: in_flight → claim metadata+bot_handoff audit+cache invalidation เขียนก่อน classify → `tOutcome`/`sOutcome` คำนวณทันทีหลัง `handoffToAdminTest` + early return failed → failed 503 side effects=0; success → side-effect path เดิม; retry converge exactly-once (K12)
  - Builder: `source` param (default `warranty_claim_flow`) + emit `intent`/`timing` จาก ctx (pattern เดียวกับ `steps`/`image_desc_out`) → legacy fields ไม่หาย, callers เดิมไม่กระทบ
- **GREEN**: Python **35/35** · TS ownership **196/196** · error-policy **38/38** · idempotency **71 passed** · production-races **37 passed** · recovery-freshness **59/59** · boundary **20/20** · mongo-safety **110 passed** · config-failclosed **4/4** · enable-checkpoint **18 passed** · `tsc --noEmit` 0 · `npm run build` ✓ · `py_compile` ✓ · `git diff --check` clean
- **Audit**: `_send_handoff` call sites ทั้งหมด truth-gated (guards/builder/tax/order×2/app/chat_v2×3/handoffs×3/engine) · literal `handoff_to_admin=True` เหลือ 2 จุด — review marker (future-tense mid-flow) + post-handoff lock (persisted ticket_state) · helpers ใหม่ = 0 · transport owners = 1
- **Test-contract fix**: `test_issue_5f_handoff`/`test_issue_5f_claim_flow` 8 tests pin old lying contract (unstubbed transport → flag/reason unconditional) → stub `_send_handoff` success ที่ app module + `conversation_id` ใน `_req` → 47 passed + 3 xfailed (HEAD baseline 33/39 เดิม) · SRS rows อัปเดต: builder `source` param + intent/timing, review/tax delegation, route ordering invariant
- **Verdict**: legacy path closure เสร็จ — tax/review/first-message delegate canonical owner เดียว, test/simulate classify ก่อน side effects, runtime net ≈ −134 LOC (warranty_flow −145 / route +11), ยังไม่ stage/commit/push/deploy

#### Review-Fix (2026-10-13, รอบ 5 — 2 High + 1 Medium จาก independent review)

- **PART 0 audit — CONFIRMED ทั้ง 3**:
  - F1: `warranty_flow.py:1150` legacy review delegate ส่ง `(warranty, _app_module, llm)` แต่ signature คือ `(_warranty_mod, llm, _app_module)` — swapped 2 ตัวท้าย → production review path crash `AttributeError: module 'shopeechat.app' has no attribute 'split_segments'` (app มี `_routing` แต่ไม่มี `split_segments`; llm มี `split_segments` แต่ไม่มี `_routing`)
  - F2: `bot-handoff/route.ts` production branch — เขียน `bot_claim_info`/`bot_handoff_at`/`bot_handoff_reason` + invalidate caches ก่อน `handoffOutcomeHttpStatus` classify → failed outcome ทิ้ง success metadata (ต่างจาก test/simulate ที่แก้รอบก่อน)
  - F3: `test_issue_5f_{handoff,claim_flow}.py` — `_app_mod._send_handoff = lambda` ที่ module import, ไม่ restore → process-global mutation รั่วข้าม module
- **Contract check (F2-D)**: `handoffOutcomeHttpStatus` — emit_incomplete→503, state≠failed→200, failed→404/503; `emit_incomplete` = persisted assigned/queued → claim metadata เขียนได้ (ownership จริงเกิด), เกณฑ์คือ `state==="failed"` เท่านั้นที่ early-return
- **RED baseline**:
  - Python transport: **35/37** — L3a crash `AttributeError split_segments` (production entry จริง), L3b res=None — พิสูจน์ F1
  - pytest: **42 passed, 1 failed** — `test_handoff_transport_owner_not_globally_stubbed` เห็น lambda (name `<lambda>`) — พิสูจน์ F3 leak
  - TS ownership: **199/200** — K14 `bot_claim_info`/`bot_handoff_at`/`bot_handoff_reason` เขียนลง conversations doc บน failed — พิสูจน์ F2; K15/K16/K17 pin keep-behaviors (assigned/queued/emit_incomplete เขียน claim ได้)
- **Minimal fix (3 edits, 0 helper ใหม่)**:
  - `warranty_flow.py:1150` — argument order `(warranty, llm, _app_module)` ให้ตรง signature
  - `bot-handoff/route.ts` production — ย้าย `handoffOutcomeHttpStatus`+respBody ขึ้นหลัง `handoffToAdmin` ทันที, `state==="failed"` early-return ก่อน claim write/cache invalidation (assigned/queued/emit_incomplete เดิน success path เดิม)
  - `test_issue_5f_{handoff,claim_flow}.py` — module-level `_app_mod._send_handoff = lambda` → `@pytest.fixture(autouse=True)` + `monkeypatch.setattr` (restore ทุก test)
- **SRS_SSD.md line 109**: ordering invariant ขยายครอบ production branch
- **GREEN**: transport **37/37** · ownership **200/200** (K14 ผ่าน + K15-17 pin) · pytest **48 passed, 3 xfailed** (isolation test ผ่าน — stub restore) · error-policy 38 · idempotency 71 · production-races 37 · recovery-freshness 59 · boundary 20 · mongo-safety 110 · config-failclosed 4 · enable-checkpoint 18 · py_compile ✓ · tsc 0 · build ✓ · diff-check clean
- **Audit**: `_handle_review_request` callers 2 จุด (V2:261 + legacy:1150) — argument order ตรง signature ทั้งคู่; ทุก branch ของ route classify ก่อน success side effects; classifier owner = `handoffOutcomeHttpStatus` ตัวเดียว
- **Verdict**: `PHASE_2B2_LEGACY_PATH_REVIEW_FIXED` — runtime delta รอบนี้ ≈ +9 LOC (route reorder), warranty_flow ±0 (arg swap), ยังไม่ stage/commit/push/deploy

#### Retry-Idempotency Evidence Correction (2026-10-13, รอบ 6 — test-honesty + 1 defect)

- **PART 0 audit**: `bot_handoff_at` ไม่มี contract semantic ที่ไหนเลย (schema.md:1000 = bare `Date?`, reset script ถือ 3 fields เป็น handoff-episode marker เดียวกัน) → ยึดหลักข้อมูลไม่โกหก: retry logical handoff เดิมห้ามเลื่อนเวลาความสำเร็จแรก → **Case C**
- **RED**: K17 retry — `bot_handoff_at` เลื่อนจาก `05:23:22.114Z` → req2 time (write ซ้ำทับทุก field) — defect จริง: claim write block `$set: new Date()` ไม่เช็คค่าเดิม
- **Fix (minimal, update block เดิม)**: `bot_handoff_at: (conv as {bot_handoff_at?: Date}).bot_handoff_at ?? new Date()` — `conv` ถูก fetch ก่อน handoff อยู่แล้ว → อ่านค่าเดิมได้ฟรี, claim fields ยัง refresh ทุก attempt, 0 helper/query ใหม่
- **K15**: เปลี่ยนจาก assert terminal value → วัดจริงผ่าน `queryLog` (updateOne conversations) = 1 write/req
- **K17**: retry payload เดิมจริง → converge `existing_assignment` 200 + `bot_handoff_at` คงเดิม + claim intact + retry write = 1 + audit eid-dedupe เติมพอดี 2 events (chat_assigned + conversation.handoff)
- **GREEN**: ownership **200/200** · error-policy 38 · boundary 20 · config-failclosed 4 · idempotency 71 · production-races 37 · recovery-freshness 59 · mongo-safety 110 · enable-checkpoint 18 · tsc 0 · build ✓ · diff-check clean · Python suites ไม่ได้รัน (ไม่มี Python file เปลี่ยน)
- **Verdict**: `PHASE_2B2_RETRY_IDEMPOTENCY_FIXED` — runtime delta +1 LOC (expression เดิม), ยังไม่ stage/commit/push/deploy

#### Handoff-Episode Timestamp Correction (2026-10-13, รอบ 7)

- **PART 0 audit**: `existing_assignment` เป็น converge signal เพียวๆ ไม่ได้ — retained-owner commit ตอน conv closed ใช้ reason เดียวกัน (handoffService:212-215→319) แต่ commit path นั้น `reopened:true` เสมอ (fence ต้อง status closed) → compound `reason==="existing_assignment" && !outcome.reopened` = converge เดิมเท่านั้น (code-provable)
- **Residual**: queued converge (`no_available_admin`,`reopened:false`) ชนกับ fresh queued commit — outcome เดิมแยกไม่ได้ โดยไม่แตะ handoffService → รายงานไว้ ไม่เดาสัญญาณ
- **RED**: K18 — episode1 assigned → close (`statusSvc.closeConversation` จริง) → reopen bot (assigned_to cleared) → req2 `round_robin` commit ใหม่ — `bot_handoff_at` คง T1 เดิม (stale preserve)
- **Fix**: expression เดิมใน claim write block — preserve `conv.bot_handoff_at` เฉพาะ `(existing_assignment && !reopened)`, นอกนั้น `new Date()`; 0 query/helper เพิ่ม (conv/outcome อยู่ในมือแล้ว)
- **GREEN**: ownership **201/201** — K17 retry คง T1, K18 episode ใหม่ T2>T1 + audit per-episode exactly-once (2 docs/action = 2 eids); error-policy 38 · boundary 20 · config-failclosed 4 · enable-checkpoint 18 · idempotency 71 · recovery-freshness 59 · mongo-safety 110 · production-races 37 · tsc 0 · build ✓ · diff-check clean · Python suites ไม่รัน (ไม่มี Python diff)
- **Docs**: schema.md §2.6 เพิ่ม 3 rows (bot_claim_info/bot_handoff_at/bot_handoff_reason + episode semantics); SRS line 109 เพิ่ม `bot_handoff_at` contract
- **Verdict**: `PHASE_2B2_HANDOFF_EPISODE_TIMESTAMP_CLOSED` — runtime +4 LOC (expression conditional), ยังไม่ stage/commit/push/deploy

#### Structural Episode Contract (2026-10-13, รอบ 8)

- **Root cause**: `HandoffOutcome` ไม่มี structural truth ว่า outcome อยู่ episode เดิม/ใหม่ → route เดาด้วย `reason==="existing_assignment"` (queued converge แยกไม่ได้ + keyword collision retained-commit)
- **Fix**: เพิ่ม `episode: "started"|"continued"|"none"` (type `HandoffEpisode`) ที่ HandoffOutcome + HandoffTestResult (type คนละตัว — sync ตาม contract); return sites: failedOutcome→none, converge assigned/queued→continued, CAS-miss→started (winner commit = episode ใหม่), committed→`wasClosed?started:(assigned_to||pending_assignment?continued:started)` — ครอบ direct transfer + queued→assigned upgrade; test path: in_flight/contention→none, recovered→continued, final→same meta rule
- **Route**: `outcome.episode==="continued"` แทน reason string (0 helper/query เพิ่ม); mapper pass-through `r.episode`
- **RED baseline**: 196/203 — J2,K15,K16,K17,K18,K19,K20 ทั้งหมด `episode===undefined` (field ไม่มี); K19 queued retry เลื่อน T1 จริง
- **GREEN**: **203/203** — K19 queued retry T1 คงเดิม + audit eid-dedupe 1 doc; K20 upgrade `continued` T1 คงเดิม + pending cleared + audit per-transition (chat_assigned 1 / handoff 2); K17 assigned retry T1; K18 new episode T2>T1
- **Consumers audit**: assign/handoff routes + workflowEngine ใช้ state/emit_incomplete เท่านั้น — ไม่แตก; Python `_send_handoff` อ่าน `outcome.state` เดิม (ไม่ต้องรู้ episode); 0 helper/classifier เพิ่ม
- **GREEN อื่น**: error-policy 38 · boundary 20 · config-failclosed 4 · enable-checkpoint 18 · idempotency 71 · recovery-freshness 59 · mongo-safety 110 · production-races 37 · tsc 0 · build ✓ · diff-check clean · Python suites ไม่รัน (ไม่มี Python diff)
- **Verdict**: `PHASE_2B2_STRUCTURAL_HANDOFF_EPISODE_CLOSED` — 1 field ใหม่, ยังไม่ stage/commit/push/deploy

#### Structural Episode Simplification (2026-10-13, รอบ 9 — YAGNI deletion)

- **Correction**: รอบ 8 เพิ่ม `HandoffEpisode` เพื่อ semantics ของ `bot_handoff_at` — audit พิสูจน์ field นี้ **ไม่มี production/UI/metric reader เลย** (writers เท่านั้น + reset script) → machinery ทั้งหมดเป็น over-engineering → ลบออกทั้งหมด
- **ลบ**: `HandoffEpisode` type + `episode` field จาก HandoffOutcome/HandoffTestResult + ค่าใน return sites ทั้งหมด + route import/mapper/preserve-conditional → `bot_handoff_at: new Date()` ธรรมดา
- **Contract ใหม่**: `bot_handoff_at` = last write/refresh time ของ claim metadata — ไม่ใช่ authority/first-success/dedupe signal (authority = status_conversation + outcome.state เหมือนเดิม); failed ยัง zero-write
- **เก็บไว้ครบ**: failed early-return, K14 zero-write, K15 write-count, K16 queued write, K17 emit_incomplete→503→converge+audit once, K18 close→reopen→handoff ใหม่, K19 queued retry converge+audit dedupe, K20 upgrade+pending cleared+audit per-transition — timestamp asserts ผ่อนเป็น `instanceof Date && >= t1` ตาม contract
- **GREEN**: **203/203** · error-policy 38 · boundary 20 · config-failclosed 4 · enable-checkpoint 18 · idempotency 71 · recovery-freshness 59 · mongo-safety 110 · production-races 37 · tsc 0 · build ✓ · diff-check clean · Python ไม่รัน (ไม่มี Python diff)
- **Complexity**: types −1 (HandoffEpisode), outcome fields −1 (episode), route classification logic −1, runtime refs `episode`/`HandoffEpisode` = 0 (rg verified)
- **Verdict**: `PHASE_2B2_EPISODE_OVERENGINEERING_REMOVED` — runtime net ลดลง, ยังไม่ stage/commit/push/deploy
- **เป้าหมาย**: พิสูจน์จาก code จริงว่า path รับข้อความ Sellcenter → persist inbound ไม่เขียน `open` ทับ `status_conversation` + กำหนด contract transition บน inbound ใหม่
- **safety**: audit จาก code เท่านั้น · ไม่ worker/Mongo จริง/.env/provider/LLM · ไม่แก้ production runtime รอบนี้ · ไม่ guard/helper/flag อุดอาการ · owner เดียว = statusConversationService · ไม่ stage/commit
- **writer graph audit (code เสร็จแล้ว)**:
  - `messages_shp` in-repo writers: `messageService.addMessage` (insert, caller เดียว = admin `/send` out-msg) + `botWorkerService` image_desc cache (updateOne additive) — **ไม่มี in-repo inbound writer**
  - `conversations_shp` in-repo writers: `touchLastMessage` (last_message_*/unread_count), bot-handoff `bot_claim_info`, workflowEngine `labels` — **ไม่มี writer ของ status/assigned_to/closed_at บน raw conv** (createConversation/findOrCreate ถูกลบใน ad13494)
  - `status_conversation` writers: statusConversationService (upsertMeta/tryAssign/manualAssign/assignPendingTicket CAS) + `/admin/maintenance/clear-status` (superadmin) + `reset-assignment-state.ts` (script gated) — **ไม่มี caller บน inbound event เพราะไม่มี inbound event ใน repo**
  - Python `app.py`/llm/warranty เขียนเฉพาะ `conversation_products`+`test_chat_*` · `replay_compare`/`shadow_openrouter` อ่านอย่างเดียว · docker-compose ไม่มี sellcenter service
- **boundary verdict (code — corrected A4)**: ไม่พบ in-repo writer/copy path ที่นำ raw status ไปเขียน meta; raw (`*_shp`) กับ meta (`status_conversation`) แยก collection ใน code ปัจจุบัน + readers meta-only ตั้งแต่ ad13494 — นี่คือสิ่งที่พิสูจน์ได้ใน repo · external writer implementation/permissions/retry semantics **ยังไม่ทราบ** (อยู่นอก repo — docs ชี้ shared Mongo dev.digital.in.th + env flags WEBHOOK_WORKER/ENABLE_POLL/BACKGROUND_SHOPEE_SYNC ที่ไม่มี code consume) · ต้องเห็น source/config/contract ของ external writer ก่อนปิด blocker — ห้ามอ้าง "dump เขียน meta ไม่ได้โดยโครงสร้าง" (พิสูจน์ไม่ได้ว่า process นั้นเขียนอะไรได้บ้าง)
- **gap ที่เจอ**: `statusConversationService.reopenConversation` = production owner เดียวของ reopen — แต่ **unfenced** (upsertMeta unconditional, ไม่มี status filter, ไม่มี message identity, log+reopen-history ทุกครั้ง) → ถ้า external caller ยิงทุก inbound จะขโมย open/handoff conv จาก admin ได้ · `closed→bot` on inbound ไม่มี owner ใน repo (implicit: closed ไม่อยู่ใน Python lock set → บอทตอบได้อยู่แล้ว แต่ state ค้าง "closed" + retained assigned_to)
- **PART 2 — 9 scenarios (trace จาก code)**: ① no-meta+inbound → dump ไม่แตะ meta (boundary pin) · ② bot+inbound → ตอบได้แต่ meta write ไม่จำเป็น · ③ **closed+inbound → ไม่มี transition เกิด** — bot ตอบได้เพราะ closed∉lock-set แต่ meta ค้าง closed+assigned_to → ขัด contract · ④ open/handoff/pending+inbound → admin-owned ล็อกถูก (readers meta-only) แต่ reopen("bot") ไม่มี fence — ถ้าถูกยิงจะขโมย · ⑤ duplicate → reopen ไม่ idempotent (log+history ทุก call) · ⑥ concurrent → ไม่มี CAS → ทั้งคู่ "สำเร็จ" · ⑦ dump-after-admin-change → meta ปลอดภัยเชิงโครงสร้าง (คนละ coll, readers meta-only) แต่ **dump rewrite conv ไม่ reopen doc** — ถ้าดีไซน์ตั้งใจให้ dump ยิง hook ต้องมี receiver ที่ยังไม่มี · ⑧ restart between persist+transition → ไม่มี transition step อยู่แล้ว → ไม่มี partial window ใน repo
- **PART 3 — truth table (business)**: {missing,bot,closed,resolved}+new inbound → bot/no-op, bot ตอบ, claim ไม่เปลี่ยน · {open,handoff,pending}+inbound → คงเดิม+locked · stale inbound (ts<closed_at) → ไม่ transition · atomic filter ที่ต้องการ = `{conversation_id, status∈{closed,resolved}, closed_at<inboundTs}` · side-effect owner เดียว = statusConversationService
- **PART 4 — RED contract tests W1–W13 ใน test-ownership-transport.ts** (production owner จริง ผ่าน reopenConversation alias — ไม่มี fake model): suite **112/121** — pins W1/W2/W10/W11 PASS · **RED 9 ตัว**: W3 pending ไม่ clear · W4 replay ไม่ no-op (log 2→4) · W5/W6/W7 open/handoff/pending ถูกพลิกเป็น bot · W8 ไม่มี CAS filter (filter={conversation_id} เดียว) · W9 ไม่มี closed_at staleness bound · W12 already-bot ยังเขียน+log · W13 missing meta ถูก fabricate doc+log · `tsc --noEmit` ผ่าน · ไม่มี regression (112 เดิมเขียวหมด)
- **verdict**: `BLOCKED_BY_EXTERNAL_IMPLEMENTATION_EVIDENCE` — repo พิสูจน์ได้: ไม่มี inbound writer/receiver, meta boundary ปลอดภัยเชิงโครงสร้าง, transition owner ไม่ fenced/idempotent · repo พิสูจน์ไม่ได้: dump filter/upsert-shape/identity/atomicity/retry ของ external writer · **เสนอ seam เล็กสุด**: harden `reopenConversation` (owner เดิม) ให้ fenced CAS + no-op semantics แล้วให้ external boundary ยิง hook หลัง persist — ยังไม่ implement รอ review

#### Review-Fix Round (2026-10-13, 2 High + 2 Medium addressed)

- **A1 corrected — ingress contract**: missing meta + first inbound ต้อง **สร้าง** meta `{status:"bot",assigned_to:null}` (ไม่ใช่ปล่อยว่าง — roadmap ต้องการ explicit authoritative meta) โดยไม่เขียน reopen history/`conversation.open`; topic-only meta เติม `status:"bot"` รักษา fields; compat reader missing→bot คงไว้ (ไม่ใช่ ingress model)
- **A2 corrected — real event + state assertions**: command signature `{conversationId, messageId, inboundAt:Date}`; W9 asserts exact CAS filter `{conversation_id, status∈{closed,resolved}, closed_at<$lt inboundAt}`; W10/W11 stale/equal = unchanged+meta identical+no side-effects; W14 race pin (admin flip closed→open ก่อน CAS → unchanged); W15 replay-after-reclose (E1→reclose T2→replay E1→unchanged)
- **A3 corrected — command boundary**: ไม่ใช้ `reopenConversation` เป็น inbound command (callers จริง: reopen route, handoffService, conversationService wrapper) — สัญญาใหม่ `applyInboundOwnershipTransition` ใน statusConversationService owner เดิม; test seam = typed adapter ที่ fail ชัดว่า "command missing" (ห้าม simulate impl)
- **A4 corrected — wording**: แก้ claim เกินพิสูจน์ (ดู boundary verdict ด้านบน) + W1 เป็น in-repo structural pin เท่านั้น
- **RED gate (PART B)**: suite **109/125** — W1 pin PASS · W2–W17 fail ด้วยเหตุเดียว "applyInboundOwnershipTransition missing — RED forward contract" · 108 tests เดิมเขียวครบ (zero regression) · `tsc --noEmit` ✓ · `git diff --check` ✓
- **PART C re-audit**: ไม่พบ external writer/webhook/receiver ใน repo (sync-shops = read-only `_shp`; routes ที่เขียน messages = outbound/test; env flags WEBHOOK_WORKER/ENABLE_POLL/LOST_PUSH_RECOVERY มีแต่ใน docs ไม่มี code consume; DEPLOY/docs ชี้ shared Mongo dev.digital.in.th) → outcome B · integration contract พร้อมส่งให้เจ้าของ Sellcenter
- **PART D proposal**: `applyInboundOwnershipTransition` ~55 LOC ใน statusConversationService.ts เดิม (fenced CAS closed/resolved→bot + init CAS missing/no-status→bot + unchanged; history/audit เฉพาะ reopened; claim coll ไม่แตะ; reopenConversation/manual paths ไม่เปลี่ยน) — ยังไม่ implement รอ review

#### Final Correction Round (2026-10-13, transport + side-effect ownership + bounded init)

- **PART 1 transport**: auth owner พบ = `x-internal-secret` vs `serverConfig.chatbotInternalSecret` (bot-handoff route precedent + middleware PUBLIC_API exclusion + optional IP allowlist) · endpoint proposal `POST /api/internal/inbound-lifecycle` → validate{conversation_id,message_id,inbound_at} → delegate เท่านั้น (no Mongo in route) · status matrix 401/422/200{outcome}/500-retry · `logDataWriterEvent` พบแต่ zero callers → ยืนยัน data-writer integration เคยออกแบบไว้แต่ writer อยู่นอก repo
- **PART 2 side-effect owner**: `recordReopen` มี `logAdminEvent("conversation.open")` ในตัว → proposal เดิม double-log จริง · contract แก้: side-effect owner เดียว = recordReopen ขยายรับ optional event identity(message_id) · crash window: mongoClient ไม่มี session/transaction + replica-set unproven → เลือก **option B** = CAS $set เก็บ `inbound_reopen_event_id` + unchanged-path identity check → re-emit audit idempotent (deterministic `_id`, E11000 dedupe ตาม botworker precedent) · state exactly-once เสมอ, audit converge เมื่อ event เดิมถูก retry
- **PART 3 bounded init**: แก้ exception-as-normal-path — read once → absent: insertOne (E11000 → bounded re-read ครั้งเดียว ไม่ loop) → status missing/null: CAS on observed state → closed/resolved+fresh: fenced CAS → bot/open/handoff/pending/stale: unchanged zero-write · pipeline-update เทียบแล้วแพ้ — unchanged states ต้องการ zero write attempt
- **PART 4+5 tests**: W18 literal `status:"pending"` → unchanged (แยกจาก handoff+pending_assignment) · W19 exactly-one conversation.open (W4 เสริม total=1) · W20 CAS-miss zero side-effects · W21 init zero side-effects · W22 crash window (hook inject → CAS commits + retry converge once) · W23 duplicate transport converged · W24–W26 transport source-RED (route exists / delegates+no mongo / auth-before-service) · no-op states assert `metaWrites()===0` + `noSideEffects()`
- **RED gate**: suite **109/134** — legacy 108 + W1 เขียวครบ zero regression · RED 25 ตัว: service W2–W18+W23 "command missing" · side-effect W19–W22 เดียวกัน · transport W24–W26 "route missing" · `tsc --noEmit` ✓ · `git diff --check` ✓
- **verdict**: `CONTRACT_READY_FOR_IMPLEMENTATION` — contract+algorithm+transport+side-effect ownership ครบและ RED ถูก boundary · external writer ยังคงต้อง hook เข้า endpoint (integration contract พร้อมส่ง)

#### Contract Closure Round (2026-10-13, test-honesty — executable transport + real race + deterministic audit id)

- **PART 1 executable transport**: W24–W26 regex-on-source ถูกแทนด้วย executable route tests W37–W47 — module hooks เพิ่ม importer-aware leaf seam: เฉพาะ importer ใต้ `/src/app/api/internal/` ที่ import statusConversationService → spy (record calls/args, return/throw ตาม state) · test file + real services ยังได้ real module (command missing = RED ตรง boundary) · spy = leaf mock เหมือน mongoClient/systemConfig — ไม่ใช่ production impl · auth tests พิสูจน์ auth-before-service ด้วย runtime call count (calls=0) ไม่ใช่ source order
- **PART 2 real read/CAS race (W14 เขียนใหม่)**: เดิม mutate ก่อนเรียก command (ไม่ใช่ race จริง) → ใช้ `findOneAndUpdateHook`/`updateOneHook` barrier — admin mutation ลงระหว่าง dispatch read กับ fenced-CAS write → CAS miss → bounded re-read (findOne ≤2) → unchanged + open/admin-2 รอด + zero side-effects + CAS attempt=1 (no retry loop) · version เดิมถูกแทนที่ (ห้ามเก็บสอง tests พิสูจน์เรื่องเดียวกัน)
- **PART 3 concurrent reconcile**: W27 = A wins CAS + ตายกลาง audit → B CAS miss → re-read เห็น bot+matching `inbound_reopen_event_id` → settle audit (log 1 + history marked) แต่คืน unchanged · W28 negative = loser เห็น event id คนละตัว → ไม่ settle · impl proposal แก้: **CAS miss ห้าม return ทันที — bounded re-read เพื่อ reconcile event identity**
- **PART 4 deterministic audit id**: `_id = "adminlog:event:" + sha256(JSON.stringify([action, conversationId, messageId])).slice(0,32)` (node:crypto — ไม่มี dep ใหม่) · contract: eventId → deterministic _id · E11000 → re-read _id → identity ตรง = already-logged (ไม่ throw ไม่ dup) / ไม่ตรง = throw · non-E11000 → throw · legacy callers ไม่มี eventId → auto _id เดิม · W29–W34 RED (logger ยังไม่มี eventId) · W35 (non-E11000 propagate) + W36 (legacy compat) PASS — pins ที่โค้ดจริง satisfy อยู่แล้ว (fakemongo enforce _id unique เสมอ — E11000 ทำงานได้ทันที ไม่ต้อง uniqueKeys)
- **PART 5 guarantee wording**: state transition = single-winner CAS (authoritative) · audit/history = idempotent convergence under retry/reconciliation — **ไม่ใช่ atomic transaction** · ไม่มี retry+crash → audit อาจขาด · `unchanged` = ไม่ต้องเปลี่ยน ownership เพิ่ม แต่ทำ idempotent settlement ของ event เดิมที่ commit แล้วได้ · ห้ามคำว่า exactly-once ไม่มีเงื่อนไข
- **harness delta (test infra เท่านั้น — runtime diff = 0)**: mocks +inboundTransitionCalls/Args/Result/Error · hooks +importer-aware redirect · ไฟล์ใหม่ test-ownership-transport-inbound-svc-spy.mjs · fakemongo +insertOneHook (error-injection seam ตาม hook pattern เดิม)
- **RED gate**: suite **111/152** — legacy 108 + W1 + W35 + W36 = 111 PASS (zero regression) · RED 41 แยก boundary: command missing ×24 (W2–W23, W27, W28) · deterministic logger ×6 (W29–W34) · route missing ×10 (W37–W45, W47) · middleware PUBLIC_API ×1 (W46 — executable: middleware จริงตอบ 401) · `tsc --noEmit` ✓ · `git diff --check` ✓
- **verdict**: `CONTRACT_READY_FOR_IMPLEMENTATION` — transport executable (auth reuse: `x-internal-secret`+`CHATBOT_INTERNAL_SECRET`, PUBLIC_API entry ต้องเพิ่มตอน impl) · runtime proposal อัปเดต: CAS miss → bounded re-read reconcile · `logAdminEvent` +optional eventId → deterministic `_id` + E11000 identity-check · `recordReopen` +optional messageId → owner เดียวใส่ eventId/metadata ลง audit · route = transport adapter เท่านั้น · external writer ยังต้อง hook เข้า endpoint (integration contract พร้อม)
- ยังไม่ stage/commit/push ตามคำสั่ง · runtime diff = 0

### 🧭 Phase 2B.1+2B.1A — Authoritative Ownership Transport (2026-10-09) · **READY_FOR_CORRECTED_REAL_DB_DRY_RUN** · collection-scope + empty-source correction เสร็จ · รอ corrected read-only dry-run · ยังไม่ commit

- **real dry-run gate (2026-10-09)**: อนุมัติ read-only dry-run 1 ครั้ง → preflight ผ่าน (branch/HEAD ✓ · contract ตรวจจาก code จริง ✓ · offline suite 36/36 + diff --check ✓) **แต่หยุดที่ env gate** — `ADMIN_MONGO_URI=unset`, `ADMIN_MONGO_DB=unset` ใน process ปัจจุบัน · ไม่รันคำสั่งจริง · ไม่หา fallback (ห้ามอ่าน .env ทุกชนิด) · real Mongo connections=0 · รอ env ที่ process ส่งมาให้เท่านั้น
- **⚠️ real dry-run #1 (2026-10-09, ผู้ใช้รันเอง) — INVALID evidence**: exit 0 + scanned=0 + ทุก count=0 → **ผิด collection** — runner forward เฉพาะ `ADMIN_MONGO_URI`/`ADMIN_MONGO_DB` ไม่มี `ADMIN_MONGO_COLLECTION_CONVERSATIONS` → fallback `conversations` (ไม่มีใน admin DB — find บน collection ที่ไม่มี = empty cursor เงียบๆ) → vacuous pass · **ยกเลิกเป็น evidence ทั้งหมด — invariant ยัง unproven**
- **collection-scope correction (E1–E5 RED→GREEN, offline เท่านั้น)**: source default → `conversations_shp` (ยืนยันกับ codebase: DEPLOY.md/schema.md/sync-shops/replay_compare — incident report เขียน `conversation_shp` singular แต่ของจริง plural) · target `status_conversation` เดิม · `message_shp`/`messages_shp` ไม่ถูกเปิด (collectionCalls pin) · **empty-source fail closed**: `scanned===0` → exit 1 ทั้ง dry-run/apply/audit + `empty_source:true` ใน output — vacuous scan ไม่มีวัน report clean อีก · E5 regression: `conversations` ว่าง + `conversations_shp` มี rows → CLI อ่าน shp (scanned>0) · D1/D3 seed authoritative row — success ไม่อาศัยฐานว่าง · override env ยังทำงาน explicit (E2) · suite 41/41
- **final-audit empty-scope correction (F1–F5 RED→GREEN)**: dry-run/apply เดิม gate เฉพาะ `summary.scanned===0` — final audit scanned=0 (audit ไม่ถึง source) ยัง exit 0 ได้ → เพิ่ม `auditEmpty` ใน decideExit: ต้อง `summary.scanned>0` **และ** `audit.scanned>0` ทั้งคู่ · audit-only `scanned>0` เดิม · V12 fixture แก้ clean audit scanned 0→1 · cas_lost ยอม success เฉพาะ audit สะอาด+มีหลักฐานจริง · suite 46/46
- **⚠️ real dry-run #2 (2026-10-09, ผู้ใช้รันเอง) — fail closed ทำงานถูกแต่ยัง scanned=0**: exit 1 + `empty_source:true` (gate ใหม่ทำงาน — ไม่ใช่ vacuous pass อีก) → แปลว่า `conversations_shp` ใน DB ที่เชื่อมไม่มี row match CANDIDATE_FILTER · สาเหตุคาด: (a) ชื่อ collection จริงอาจ `conversation_shp` singular ตาม incident report แรก — runner ไม่ได้ forward `ADMIN_MONGO_COLLECTION_CONVERSATIONS` เลยใช้ default ตรงๆ · (b) ADMIN_MONGO_DB ชี้ผิด DB · (c) rows จริงไม่มี assigned_to/closed_at เลย · **รอผู้ใช้ยืนยัน list_collection_names + evidence count จริง** — ยังไม่แก้ code จนกว่าจะรู้ชื่อ/DB ที่ถูก · diag script: `chatbot/testscript/diag_admin_collections.py` (read-only, counts only — ผู้ใช้รันเอง)
- **diag #1+#2 result (2026-10-09, ผู้ใช้รัน)**: `conversations_shp` มีจริง 150,396 rows แต่ **evidence_rows=0 (full-scan count)** — `assigned_to`/`closed_at` ไม่มีในข้อมูลจริงเลย · distinct status=['open'] เท่านั้น · alt ownership fields ไม่มี · related collections (tickets/chat_accept_sessions/platform_team_assignments/assignment_cursors) ว่าง · status_conversation=2 docs (ไม่มี evidence fields) · **สรุป: invariant ผ่านแบบ vacuous — ไม่มี legacy human-owned row ขาด meta ให้ backfill** → verdict เสนอ `INVARIANT_VACUOUS_NO_BACKFILL_NEEDED` (ไม่ต้อง apply; gate ตอบด้วย census ไม่ใช่ migration) · caveat ที่บันทึก: ถ้า human-ownership เคยอยู่ใน raw fields แต่ dump ทับหมดแล้ว สถานะนั้นหายถาวร — backfill กู้ไม่ได้อยู่ดี

- **scope**: lifecycle audit + test-honesty cleanup + offline backfill contract/harness · ห้ามแก้ production transport · ห้าม worker/DB/provider จริง
- **code truth — transport defect (พิสูจน์แล้ว)**:
  - `resolveTicketState` (botCallService L55-83) = producer เดียวของ `ticket_state` — `testSource`→`test_status_conversation` · `simulate`→`test_chat_sessions` · **production→`conversations` ← defect จริง** (raw dump ที่ sellcenter เขียนทับ ไม่ใช่ ownership source)
  - transport = verbatim passthrough · `ticket_state` omit เมื่อ null · error ถูก try/catch กลืนเป็น null → error กับ missing แยกไม่ได้
  - production branch **ไม่มี caller ใน tree** (botWorkerService/workflowEngine ส่ง testSource เสมอ; liveAssignment/test-assignment ใช้ callBot ท้องถิ่นไม่ส่ง ticket_state; TestChatClient ส่งเองผ่าน proxy) — เป็น reserved contract
  - **defect severity สูงกว่าที่คิด**: `createConversation` เขียน `conversations.status="open"` เสมอ → transport ปัจจุบันส่ง "open" ให้ทุก fresh conv → Python lock-set (handoff/open/pending) → บอทเงียบผิด owner ทุกแชทใหม่
- **status_conversation lifecycle (พิสูจน์จาก code)**:
  - doc สร้างเฉพาะเมื่อ admin/system write (upsertMeta family) — fresh conv **ไม่มี doc** เป็นเรื่องปกติ
  - close→"closed" · admin reopen→"handoff" · bot/customer reopen→"bot"(clear assigned) · resolve→"resolved" · pending→status="handoff"+assigned_to=null
  - handoff owner เองใช้ `meta?.status || "bot"` (handoffService L80) **แต่เฉพาะ conv ที่ผ่าน 2J+ paths**
- **BLOCKED evidence (เก็บเป็นบันทึก — ไม่ใช่ passing contract)**: legacy human-owned rows ไม่มี meta ได้จริง — `mapToConversation` derive "handoff"/"closed" จาก raw `assigned_to`/`closed_at` · `getAssignedConversationIds` นับ raw เป็น legacy source · send Phase 7.9 block admin ด้วย raw `assigned_to` · `send` ไม่เขียน meta · ไม่มี backfill ในประวัติ repo → missing⇒"bot" ผิดทิศอันตราย
- **test honesty (PART 1)**: ลบ B1–B4 characterization tests ที่ล็อก defect เป็น PASS (-79 LOC) · เก็บ B5 pin (no conversationId → no ownership query + omit — positive boundary contract) · suite เหลือ **38 tests**
- **migration contract (2B.1A — `scripts/backfill-legacy-ownership.ts`, hardened รอบ safety + final pre-dry-run correction)**:
  - offline script เท่านั้น — request path ไม่เรียก · dry-run default · apply = exact token `--apply=BACKFILL_LEGACY_OWNERSHIP` (token อื่นที่ขึ้นต้น `--apply*` → refuse ก่อน connect) · `--audit` invariant-only · `--batch=N` integer 1–1000 validated ก่อน env/mongo import
  - **client lifecycle (C1+D1–D3)**: `try/finally` ครอบ `connect()` — close() ทำงาน 1 ครั้งแม้ connect throw (dry-run ไม่ค้าง) · connect+close fail พร้อมกัน → output sanitized + exit non-zero · **cleanup failure ห้ามรายงาน success (D1)**: runCli เก็บผลใน `exitCode` ท้องถิ่น · ไม่ return ภายใน try · close() fail → sanitized log + final exit 1 · op error + close error ทั้งคู่ถูก log sanitized (cleanup ไม่ทับ op error) · exit matrix op×cleanup: สำเร็จ+สำเร็จ→decideExit · สำเร็จ+fail→1 · fail+สำเร็จ→1 · fail+fail→1
  - **final audit เสมอ (C2)**: dry-run + apply รัน `auditOwnershipInvariant()` หลัง scan เสมอ (audit-only = audit ครั้งเดียว) — `_id` seek อาจพลาด row ที่ insert หลัง cursor → final audit เป็น truth gate
  - **classification boundary เดียว (`classifyRow`)** — runBackfill + audit ใช้ร่วม: **conversation_id ต้อง canonical `v===v.trim()` (C3)** — whitespace-padded = invalid row · ไม่ trim/ไม่ normalize/ไม่ query meta — migration ไม่เขียน identity โดยปริยาย · meta.status known→skip / non-empty unknown→invalid_authoritative_status (block) · raw.closed_at valid finite Date→closed(ชนะ) / present-invalid→invalid · meta.assigned_to??raw.assigned_to non-empty string→handoff / present-invalid→invalid · closed_by invalid→omit+invalid_optional_fields · **raw.status ไม่อ่าน**
  - fenced write `{conversation_id, $or:[status missing,null]}` + upsert + unique conv_id → concurrent write = cas_lost · ไม่ overwrite authoritative status
  - **_id-seek pagination** (sort _id:1 + `_id>$gt` lastSeen — แทน skip/offset): rows หลัง cursor ถูก process ครั้งเดียว · หลังหมด = หน้าที่ของ final audit
  - **counts-only output** — conversation_ids/per-row arrays ถูกลบทั้งหมด: mode/scanned/candidates/would_*/created/filled/skipped_authoritative/cas_lost/invalid_rows/invalid_authoritative_status/invalid_optional_fields/errors (+invariant_* ใน apply)
  - `decideExit` จุดเดียวที่ CLI boundary — dry-run: actionable>0 ปกติ/ผ่าน แต่ fail เมื่อ summary หรือ final-audit มี errors/invalid/invalid_authoritative · audit/apply ผ่านเฉพาะ actionable=0 ∧ invalid=0 ∧ invalid_authoritative=0 ∧ errors=0 (cas_lost ยอมถ้า audit สะอาด) · `runCli` (rename จาก main, export สำหรับทดสอบ — orchestration ชุดเดียว) คืน code · `process.exitCode` เซ็ตที่ direct-invocation boundary เท่านั้น
  - `safeErrorLabel` — safe name + finite numeric code เท่านั้น (ไม่มี message/stack/URI/host/DB)
  - import purity: lazy `await import("mongodb")` + env อ่านใน runCli() เท่านั้น · invokedAsScript gate
- **tests M1–M12 + V1–V18 + C1–C3 + D1–D3 + E1–E5 + F1–F5 GREEN (46/46 — fake Mongo + mongodb spy + fetch stub)**: M-block = derivation/fence/dry-run/sanitized/purity · V1–V6 strict classification · V7–V8 counts-only bounded ที่ 5,000 rows · V9 identical classify · V10–V14 exit matrix · V15 error sanitizer · V16 batch parser · V17 _id-seek + late-insert · V18 dry-run≠ready เมื่อ invalid · C1 connect-fail→close-once·exit-1·sanitized · C2 dry-run final audit จับ late row + actionable-only ผ่าน · C3 canonical ID · D1 success+close-fail→exit-1 (RED พิสูจน์โค้ดเดิมคืน 0) · D2 op-fail+close-fail→exit-1 op error ไม่ถูกทับ · D3 success+close-ok→exit-0 pin · E1 canonical binding (shp เท่านั้น) · E2 env override · E3 empty-source fail closed ทั้ง 3 mode · E4 non-empty clean → 0 · E5 wrong-source regression · F1/F2 summary-scanned>0+audit-scanned=0→1 · F3/F4 pins · F5 runCli vacuous-audit→1
- **verify**: backfill **46/46** · error-policy (cleaned) **38/38** · boundary 20/20 · idempotency 71/71 · config-failclosed 4/4 · `tsc --noEmit` ✓ · `npm run build` ✓ · `git diff --check` ✓ · worker=0 real-Mongo=0 provider=0 .env=0 · fakemongo ไม่ได้แก้ · mongodb spy +collectionCalls (globalThis state)
- **roadmap**: "Commit 2B.1A" gate ก่อน 2B.1 (อัปเดต hardened contract + แก้ date 2026-10-09) + prerequisite ใน 2B.1
- **next sequence**: approval → **corrected read-only dry-run** (real Admin DB, `scanned>0` เป็น precondition — dry-run #1 scanned=0 ถูกยกเลิก) → review counts → apply approval → `--apply=BACKFILL_LEGACY_OWNERSHIP` → audit actionable=0∧invalid=0 → 2B.1 transport RED→GREEN → ลบ raw ownership fallbacks → commit/review
- **residual**: **real-DB invariant ยังไม่ได้พิสูจน์** — dry-run #1 เชื่อมแล้วแต่อ่านผิด collection → evidence โมฆะ; corrected run ยังไม่ได้ทำ · SRS L977 ยังถูกต้องตาม code (runtime ไม่เปลี่ยน) · fakemongo dead key `statusConversations` ยังอยู่ (แก้ตอน 2B.1 implement) · fresh-conv no-doc ปลอดภัยเฉพาะหลัง legacy rows ถูก resolve

### 🚨 Botworker Incident Closure Part 1 — backlog audit + quarantine dry-run + enable-checkpoint design (2026-10-01) · READ-ONLY · ยังไม่ commit

- **scope**: audit เท่านั้น — ห้าม worker/LLM/DB write/commit; incident: enable หลัง process ค้างหลายวัน → replay 2,288 inbound / 7,171 replies (ส่วนเกิน 4,883)
- **Part A preflight**: branch `feature-legacy-shopee-evidence-retrieval` @ `37f6d30` · working tree = งาน Round 1-4 ค้าง (29 files) · **ไม่มี bot-worker process** · config read-only: `bot_worker_enabled=false` · buffer on (window 7000ms/max 10, media 7000ms/max 10) · `workflow_enabled=true` · interval/concurrency unset → defaults (interval 1000ms)
- **Part B real-Mongo audit (script `testscript/audit_botworker_incident.py` — READ-ONLY, hashed IDs)**:
  - buffer_messages: 4 rows `status=buffered, kind=message` · ไม่มี dup message_id · conversation เดียว · received 09:24–09:26 UTC · rows มี deterministic `claim_id` (botworker:claim:*) แต่ไม่มี batch_id
  - chat_processing: 4 claims deterministic `_id` ตรง 1:1 กับ rows · status=processing · fencing_token=2 · attempt=2 · lease หมด 09:29–09:31 UTC · มี batch_id · reply_ids=0 · outcome_type=null
  - ไม่มี terminal record · ไม่มี shadow_replies ผูก 4 mids · ไม่มี persisted reply
  - inbound 4 ตัวอยู่ใน messages_shp (created 09:24–09:26Z = **ก่อน** incident window 10:33–12:22 → เป็น leftover batch ไม่ใช่ผล replay)
  - **conversation moved on**: หลัง 09:26Z มี admin outbound 15 + user inbound อีก 4 (ถึง 17:57) → replay batch เก่า = ตอบข้อความที่แอดมินจัดการแล้ว → quarantine ถูกต้อง
  - recovery selection (replicate query read-only): `recoverStaleBuffers` เลือก conv นี้ (4 rows) + `recoverStaleClaims` เลือก 4 claims — **เปิด worker ตอนนี้ = batch เก่าถูก flush ทันที**
- **Part C dry-run manifest** (ยังไม่เขียน DB): export → `docs/test/results/botworker_incident_quarantine_export.json` (chmod 0600, gitignore ยืนยัน `.gitignore:44` · 4 buffer + 4 claims + reply meta 0 · จะลบหลัง verify quarantine) · proposed (review-fix): claims → `status=no_action, outcome_type=no_action, error=incident_quarantine` (selector `_id`+status=processing+fencing exact, matchedCount ครบ 4 ก่อนลบ buffer — ไม่ครบ = abort) · buffer rows → delete (selector message_id+status=buffered+kind=message exact) · rollback = CAS `updateOne({_id, error:"incident_quarantine"})` + insert buffer (unique index กันซ้ำ)
- **Part D root cause ในโค้ดจริง — 2 แกน**: (a) **backlog admission** — `bot-worker.ts` L46 `startedAt=boot` → L83 `pollNewMessages(startedAt)` ทุก cycle → `created_timestamp:{$gt:since}` (admit backlog หลายวันเมื่อ toggle); (b) **duplicate execution** — legacy check-then-act/delete-before-finalize (รับผิดชอบโดย claim/lease/fencing/deterministic-id ใน working tree แล้ว) · design: rising-edge `enabledSince` in-loop (~8 บรรทัด, ไม่มี schema/flag ใหม่)
- **RED evidence (child-process harness — bot-worker.ts จริง + leaf mocks)**: `test-botworker-enable-checkpoint.{ts,child,hooks,mocks}` — S3 FAIL ×2 ตรง root cause: `since` คง boot-time ทั้ง 2 enable eras + `m_gap_*` (ข้อความช่วง disabled) ถูก poll · pins ผ่าน: boot-disabled → 0 poll/recovery · boot-enabled → recovery 1 ครั้ง + boundary≈boot · ไม่มี poll ขณะ disabled · **10 pass / 2 fail (RED)**
- **RED evidence ชุด 2 (recovery freshness — per-row, idempotency harness reuse)**: `test-botworker-recovery-freshness.ts` — **2 pass / 7 fail (RED)**: R1 stale batch→callBot=1 · R3 stale claim→callBot=1 · R5 mixed conv → `inbound=[mx_f,mx_s]` stale ถูกดูดเข้า batch จริง (พิสูจน์ absorption hole) · R6 missing received_at → bot · R7 missing claimed_at → bot · R8 fresh row+stale claim → bot · R9 stale row+fresh claim → bot · pins R2 (fresh batch=1 callBot) + R4 (fresh claim resume) ผ่าน · **round นี้ไม่มี runtime diff ใหม่** · DB writes=0
- **Part D เพิ่ม (review fix — per-row + evidence precedence, minimal)**: admission path ที่ 2 = `recoverStaleBuffers`/`recoverStaleClaims` ไม่ดูอายุ **และ flushBuffer re-fence (L342) ไม่เช็ค outcome_type → committed claim ถูก re-execute** (R12 RED พิสูจน์) · precedence ต่อ row: P1 claim missing → ลบ row + audit event · P2 claim terminal → ลบ row · P3 processing+committed evidence (outcome_type / persisted reply) → finalize-only (เส้นเดิม L307-335) → ลบ row, no LLM · P4 ไม่มี evidence → freshness `RECOVERY_FRESH_MS=max(windows)+claimLeaseMs+60s` per-row (received_at+claimed_at ต้อง valid+ใน window ทั้งคู่) · stale → CAS `{_id,status:processing}`→`no_action`/`stale_at_recovery` → matched แล้วค่อยลบ row · CAS lost → ปล่อย row ไว้ · fresh-only → batch เดิม · **ไม่เพิ่ม status/schema**
- **RED evidence ชุด 2 (final — 15 tests)**: `test-botworker-recovery-freshness.ts` — **5 pass / 10 fail**: R1,R3,R5-R9 (stale/missing-ts/mixed/absorption) + R12 (committed outcome ถูก re-exec) + R14 (orphan row→doc insert แทน audit) + R15 (CAS-lost→row ถูกลบผิด) RED ตรง root cause · pins R2,R4,R10,R11,R13 ผ่าน (fresh recovery + existing finalize-only + terminal-settle ทำงานอยู่แล้ว)
- **rollback spec**: `testscript/quarantine_rollback.py` (executable, --apply gated, buffer reinsert = `--reinsert-buffer` แยก approval) + `test_quarantine_rollback_verify.py` **9/9 pass** — V2 พิสูจน์ single-field mutation ถูกจับจริง · CAS `_id`+marker · `$unset` เฉพาะ quarantine-added fields ที่ไม่มีใน snapshot · post-verify = keyset+field equality เต็ม
- **quarantine manifest รอบ 2**: Mongo standalone (`hello().setName=None`) → ไม่มี multi-doc tx → ordered ops + compensating rollback · claim updates 4× (matchedCount=1 ต่อ op, ไม่ครบ → CAS rollback ตัวที่เขียนแล้ว + abort) → buffer delete 4× (deletedCount=1 ต่อ op) → post-verify + re-check `bot_worker_enabled=false` ก่อน/หลัง · rollback ผ่าน `json_util.loads` + CAS `_id`+`status=no_action`+`error=incident_quarantine` · ห้าม $set _id · buffer reinsert ต้อง approve แยก
- **chronology (UTC เต็ม)**: inbound created 2026-10-01 09:24:25–09:26:24Z · buffered +2s · lease หมด 09:29–09:31Z · conv ต่อเนื่อง admin×15+user×4 ถึง 17:57:58Z · audit 2026-10-02 ~02:2xZ · window "10:33–12:22" TZ ไม่ชัด — รายงาน 2 interpretations (UTC=ก่อน window / ICT=หลัง window) ไม่เลือกฝั่ง

#### 🚨 Botworker Incident Closure — Runtime Implementation (2026-10-02) · TDD · approved scope เท่านั้น · ยังไม่ commit

- **fix A — enable checkpoint**: `bot-worker.ts` ลบ `startedAt` → `enabledSince: Date|null` rising-edge (disabled→null, edge→`new Date()` ครั้งเดียว, continuous ใช้เดิม, off→on→boundary ใหม่) → `pollNewMessages(enabledSince)`
- **fix B — recovery precedence** (`botWorkerService` owner เดียว): `classifyRecoveredBufferRow` per-row P1 claim missing→orphan delete+audit · P2 terminal→delete row · P3 committed evidence (outcome_type/reply_ids/persisted reply via `findPersistedReplies`)→`claimMessage` finalize-only (no LLM)→delete · P4 freshness gate (row.received_at+claim.claimed_at valid+fresh ทั้งคู่) → stale CAS `{_id,status:processing,fencing_token}`→`no_action`/`stale_at_recovery`→delete, CAS lost→leave · `recoverStaleClaims` evidence>freshness เดียวกัน · `freshAfter=max(buffer_windows)+claimLeaseMs+60s` (constants เดิม, 0 config ใหม่) · audit `bot.recovery_quarantine` (AdminActionType เพิ่ม union — เหมือน `bot.buffer_*` เดิม)
- **fix C — bufferService boundary**: `recoverStaleBuffers(processMessage, markProcessed, classifyRow?)` — enumerate/apply dispositions เท่านั้น (fresh→conv flush, delete→deleteOne exact row, leave→untouched) · ไม่มี claim/evidence/freshness logic · ไม่ import botWorkerService (callback injection เดิม) · stale row ถูกลบก่อน flush → absorption hole ปิด (R5)
- **fix D — rollback utility**: `EXPORT_PATH` = `Path(__file__).resolve().parents[2]/docs/...` (repo-root, cwd-independent) · collection resolve ผ่าน env-aware pattern เดียวกับ audit script · CAS miss/verify fail → return 1, ไม่พิมพ์ success · `--reinsert-buffer` gate แยก · `main()` return code (testable)
- **error→fix**: (1) R12 hole — flushBuffer re-fence ไม่เช็ค outcome_type → committed claim ถูก re-exec → P3 route ผ่าน claimMessage finalize-only ก่อน flush; (2) `bot.recovery_quarantine` ไม่อยู่ใน AdminActionType → เพิ่ม union (tsc fail→pass); (3) enable-checkpoint era grouping same-ms ทำ test fail เท็จ → group ตาม stream order+edge markers; (4) stats.stale นับทั้ง CAS-lost → นับเฉพาะ matchedCount=1
- **verify (fresh, ทั้งหมด fake-mongo/mocks — DB writes=0, no worker, no LLM/API)**: recovery freshness **15/15** · enable-checkpoint **13/13** · idempotency **43/43** · boundary **20/20** · production races **37/37** · rollback **14/14** (V7: main() dry-run จาก repo root pin path จริง) · tsc --noEmit ✓ · npm build ✓ · git diff --check ✓ · static audit: bufferService ไม่มี claim/evidence logic ซ้ำ
- **verify-botworker-parallel**: suite นี้ connect real Mongo + ทำ writes จริง — launch ค้างจากรอบก่อน (>15min no output) → kill; ไม่อยู่ใน required verification ของรอบนี้ (real-DB ขัด scope)
- **residual**: quarantine/rollback ยังไม่ execute (รอ approval แยก) · `stats` เป็น approximate audit counter · recovery นับ classification ต่อ row (N findOne) — batch ใหญ่ = N queries ตอน boot เท่านั้น

##### Review-fix round (2026-10-02) — 2 High + 1 audit accuracy · TDD

- **F1 error**: boot-enabled → startup recovery รันก่อน `enabledSince` ถูกตั้งใน loop → inbound ที่เข้าระหว่าง recovery มี `created_timestamp < enabledSince` → ไม่ถูก poll ตลอด era
  - **fix**: `enabledSince = new Date()` ทันทีหลัง `bootConfig.bot_worker_enabled` confirm, ก่อน `recoverStaleBuffers` — loop reuse boundary เดิม (off→on ยังได้ boundary ใหม่จาก `if (!enabledSince)`)
  - **RED**: S4 ใหม่ (mocks +`recovery_delay_ms` inject `m_rec_1` mid-recovery) — current impl: `found=[m_post_1×4]` ไม่มี m_rec_1 · fixed → PASS
- **F2 error**: `recoverStaleClaims` lookup inbound ก่อน evidence check → inbound หายเขียน `bot_failed` ทับ claim ที่มี committed outcome/reply
  - **fix**: reorder — bufferedMid skip → evidence check → `claimMessage(claim fields)` finalize-only (ไม่ต้องมี inbound, no LLM) → freshness gate → inbound lookup → `claimMessage(msg)` → process; `claimed` บน evidence path → fall through reprocess path เดิม; "skip" (reclaim แพ้) → continue ไม่นับ
  - **RED**: R16 (stale+outcome+no inbound → `bot_answered`) · R17 (stale+persisted reply+no inbound → envelope finalize) — current ทั้งคู่ได้ `bot_failed` · R18 pin (fresh+no evidence+no inbound → `bot_failed` เดิม) ผ่านทั้งก่อน/หลัง
- **F3 audit**: direct path `claimMessage.kind==="finalized"` → `stats.finalized++` (เฉพาะ finalized จริง, CAS/reclaim แพ้ไม่นับ); R19 pin `evidence_finalized=2` ครอบ buffered+direct
- **verify (fresh)**: recovery **19/19** · enable-checkpoint **16/16** · idempotency **43/43** · boundary **20/20** · races **37/37** · rollback **14/14** · tsc ✓ · npm build ✓ · git diff --check ✓ · DB writes=0 · no worker · no LLM/API

##### Review-fix round 2 (2026-10-02) — ownedCtx liveness gap · TDD

- **error**: evidence path ใน `recoverStaleClaims` คืน `claimed` (evidence หายหลัง reclaim) → โค้ดทิ้ง `res.ctx` เดินต่อด้วย snapshot → stale CAS filter `fencing_token` เก่า miss / missing-inbound update filter `lease_expires_at<now` miss (lease เพิ่ง renew) → **claim ค้าง processing จน restart ถัดไป**
- **fix**: `let ownedCtx: ClaimContext|undefined` ต่อ loop — claimed→เก็บ ctx; stale→`finalizeClaims(ownedCtx,{type:no_action,extra:{error:stale_at_recovery}})`; inbound หาย→`finalizeClaims(ownedCtx,bot_failed)`; fresh+inbound→`processMessage(ownedCtx)` ไม่ claimMessage ซ้ำ; ไม่มี ownedCtx→behavior เดิม; นับ stats.stale เฉพาะ modifiedCount>0
- **RED (R20-R21)**: stale+ghost-reply+no-inbound → claim ค้าง `processing` (CAS miss) ก่อนแก้ · fresh+ghost+no-inbound → ค้าง processing (expired-lease filter miss) ก่อนแก้ — หลังแก้ `no_action`/`bot_failed` terminal
- **pins (R22-R23)**: fresh+inbound→process once, fencing_token=2 (reclaim ครั้งเดียว) · concurrent winner flip หลัง reclaim → finalizeClaims fenced miss → ไม่ทับ + stale_claims ไม่นับ
- **verify (fresh)**: recovery **23/23** · enable-checkpoint **16/16** · idempotency **43/43** · boundary **20/20** · races **37/37** · rollback **14/14** · tsc ✓ · npm build ✓ · git diff --check ✓ · DB writes=0 · no worker · no LLM/API

##### Review-fix round 3 (2026-10-02) — buffered claimed-evidence liveness · TDD

- **error**: `classifyRecoveredBufferRow` P3 — claimMessage คืน `claimed` → return "leave" ทิ้ง res.ctx → row ไม่มี timer + claim lease ใหม่ของเราค้าง + direct recovery ข้าม (row ยังอยู่) → วนค้างข้าม restart ไม่สิ้นสุด (liveness gap เดียวกับ direct path)
- **fix**: `claimed` → `ownedCtx = res.ctx` → row/claim stale → `finalizeClaims(ownedCtx, no_action+stale_at_recovery)` modified>0 → stale+++delete, miss→leave · fresh ทั้งคู่ → sync row `{message_id,status:buffered,claim_id}` $set owner_id+fencing_token=ctx → matched→"fresh" (flushBuffer re-fence owner+token match→process ครั้งเดียว), miss→"leave"
- **RED (R24,R25,R27)**: stale buffered ghost→claim ค้าง processing+row เหลือ · fresh ghost→callBot=0 ไม่ flush (fencing row เก่าไม่ match ctx ใหม่) · row-CAS-loss→row ถูก sync ทับ/flush ผิด — หลังแก้ทั้งหมดถูก
- **pin (R26)**: concurrent winner flip หลัง reclaim → finalizeClaims fenced miss → ไม่ทับ terminal, stale_claims ไม่นับ
- **assertion เพิ่ม**: ทุก "claimed" branch (direct R20-23 + buffered R24-27) ใช้ res.ctx ต่อเสมอ — ไม่มี path ทิ้ง reclaimed ClaimContext, ไม่มี claim+row ค้างข้าม recovery โดยไม่มี owner
- **verify (fresh)**: recovery **27/27** · enable-checkpoint **16/16** · idempotency **43/43** · boundary **20/20** · races **37/37** · rollback **14/14** · tsc ✓ · npm build ✓ · git diff --check ✓ · DB writes=0 · no worker · no LLM/API

##### Review-fix round 4 (2026-10-02) — ownership reconciliation · TDD

- **error**: R27 เดิม pin "row=processing + claim=processing owner=เรา ไม่มี timer/in-flight" เป็น PASS — row ตกหล่นจากทั้ง buffered recovery (enumerate เฉพาะ status:"buffered") และ direct claim recovery (skip เพราะ row ยังอยู่) → ค้างถาวร + row-sync CAS ไม่ lock identity → overwrite row ที่ owner เปลี่ยนแล้วได้ (R29)
- **cause**: recoverStaleBuffers enumerate แค่ buffered (ไม่เห็น crash-leftover processing rows) + sync filter ไม่มี owner_id/fencing_token + CAS miss → unconditional "leave"
- **fix**:
  - `bufferService.recoverStaleBuffers`: enumerate `status:{$in:[buffered,processing]}` (ยกเว้น conv_lock เหมือนเดิม) + delete disposition filter `$in` เดียวกัน — ยังแค่ enumerate/apply, claim/fencing เหมือนเดิมที่ botWorkerService
  - `classifyRecoveredBufferRow`: +lease-active guard หลัง P2 (claim lease ยัง valid = owner อาจ in-flight จริง → leave) · P3 claimed sync → **exact-identity CAS** (message_id+claim_id+status+owner+fencing ที่ observe) → miss → reconcile 1 รอบ (re-read row+claim): claim terminal→delete · owner/token≠ctx→leave · claim ยังของเรา+row อยู่ identity เดิม→repair CAS →fresh · row หาย→restore deterministic membership จาก snapshot (insertOne, dup-key→re-read) · reconcile ไม่สำเร็จ→`finalizeClaims(ctx,no_action)` settle ไม่ทิ้ง claim processing เปล่า
  - P4: row `status:"processing"` + claim expired/reclaimed + fresh → normalize `buffered` exact-identity CAS → fresh (miss→leave — foreign owner)
- **RED (R27,R28,R29,R30)**: status-flip same-owner→ค้าง · seeded processing row→ไม่ถูก enumerate เลย · owner เปลี่ยนก่อน sync→row ถูกทับ identity →callBot=1 ทับ · row หายหลัง reclaim→claim processing เปล่า — หลังแก้: R27 repair→flush→terminal · R28 reclaim+normalize+process 1 ครั้ง+row deleted+1 reply · R29 identity ไม่ถูกทับ callBot=0 winner คง · R30 restore row→flush→terminal 1 reply
- **leave audit**: ทุก leave = verified foreign owner (claim/row token เปลี่ยนจากที่ observe) หรือ terminal winner เท่านั้น — ไม่มี unconditional leave เพิ่ม
- **verify (fresh)**: recovery **30/30** · enable-checkpoint **16/16** · idempotency **43/43** · boundary **20/20** · races **37/37** · rollback **14/14** · tsc ✓ · npm build ✓ · git diff --check ✓ · DB writes=0 · no worker · no LLM/API

##### Review-fix round 5 (2026-10-02) — final liveness: deferred wake-up + shared reconcile + exact delete · TDD

- **error**: (1) foreign active-lease → leave ไม่มี wake-up → ค้างจน restart; (2) P4 normalize CAS miss → leave ไม่ reconcile; (3) P3 row identity เปลี่ยนแต่ claim ยังของเรา → leave ผิด (row ไม่ใช่ authority); (4) settle สำเร็จแต่คืน leave → row เหลือ; (5) delete disposition ลบด้วย message_id+status อย่างเดียว → TOCTOU ลบ row ที่ถูกแทน
- **cause**: recovery รันครั้งเดียวไม่มี deferred path + row-identity check เดี่ยวตัดสิน winner + settle branch ไม่ลบ row + delete filter ไม่ครบ identity
- **fix**:
  - `RecoveryStats.deferredUntil` + module timer เดียว (unref) ใน `recoverStaleBuffersAndClaims` — foreign claim lease active → `defer()` บันทึก expiry → schedule re-run หลัง lease หมด +250ms (ไม่ busy-loop, ไม่เพิ่ม config); disabled-era → re-run gate `bot_worker_enabled` เอง
  - `classifyRecoveredBufferRow` refactor: closures `defer`/`foreignLeave` (re-read พิสูจน์ terminal→delete, foreign→leave±defer) /`rowFence`/`syncSet`/`settleClaim`/`reconcileRow` — **shared reconcile เดียวสำหรับ P3+P4** (bounded ≤3, claim fencing เป็น authority — row owner/token เปลี่ยนอย่างเดียวไม่ใช่ winner, repair ด้วย identity ล่าสุดของ rowNow); reconcile ctx=null เริ่มต้นผ่าน claimMessage (expired lease เท่านั้น)
  - `settleClaim`: finalize สำเร็จ→ลบ row ด้วย identity ล่าสุด+`delete` ทันที (แก้ข้อ 4); miss→re-read: foreign→leave(+defer), transient→retry 1 ครั้ง
  - `bufferService` delete disposition → exact-identity CAS (`message_id+claim_id+status+owner_id+fencing_token` จาก snapshot) — กันลบ row ที่ถูกแทน
  - **R15 แก้ pin**: CAS lost + claim terminal → row deleted (ตรงสเปกใหม่ "claim terminal→delete"); **R29 แก้ hook**: winner renew lease (reclaim จริงต้องมี lease ใหม่; lease ยาว 1h กัน timer ยิงกลาง suite)
  - fakemongo +`deleteOneHook` seam (test harness เท่านั้น)
- **RED (R31–R35 ทั้งหมด fail ก่อนแก้)**: active lease→callBot=0 ถาวรไม่มี wake-up · P4 miss→leave ค้าง · row-diverged+claim-ours→leave ผิด · delete ลบ row ใหม่ · settle สำเร็จแต่ row เหลือ — หลังแก้ 36/36
- **leave audit**: ทุก leave ผ่าน `foreignLeave`/reconcile/`settleClaim` re-read — claim foreign (active→defer wake-up) หรือ self in-flight (`activeClaims`) หรือ CAS churn = live same-owner executor; ไม่มี branch จบด้วย claim processing ของเราเปล่า
- **verify (fresh)**: recovery **36/36** · enable-checkpoint **16/16** · idempotency **43/43** · boundary **20/20** · races **37/37** · rollback **14/14** · tsc ✓ · npm build ✓ · git diff --check ✓ · DB writes=0 · no worker · no LLM/API
- **หยุดรอ review — ยังไม่ commit/push · ห้าม execute quarantine/rollback**

#### 🔧 Botworker Recovery Lifecycle Closure — R36–R40 (2026-10-02) · TDD · รอ review · ยังไม่ commit

- **error**: deferred timer ไม่ผูก lifecycle — (1) loop rising edge ไม่เรียก recovery (boot เท่านั้น) → งานค้างหลัง off→on; (2) falling edge ไม่ยกเลิก buffer/retry/deferred timers; (3) `flushBuffer` ไม่มี enabled gate → timer callbacks transition row→processing ขณะปิดได้; (4) `activeClaims` track เฉพาะ `ctx.claim_id` → member อื่นของ batch ถูก recovery normalize กลาง flush; (5) expired-foreign `foreignLeave` → bare leave ไม่มี execution path
- **cause**: timers/ownership กระจายราย branch ไม่มี lifecycle owner + recovery ไม่ single-flight → pass ซ้อน in-flight batch
- **fix**:
  - `bot-worker.ts` — rising edge ทุกครั้ง: `enabledSince=new Date()` **ก่อน** `recoverStaleBuffers()` (boundary ก่อน recovery เสมอ) · falling edge → `clearPendingWork()` ครั้งเดียว · shutdown ใช้ fn เดียวกัน
  - `botWorkerService` — `recoveryInFlight`/`recoveryAgain` single-flight (concurrent caller coalesce → rerun รอบเดียว) · `cancelDeferredRecovery` + `clearPendingWork` export · `activeClaims` add/delete ครบ `ctx.claim_ids` · classifier hoist: nested closures 6→0, module-level reconciliation = `verifyForeignClaim`+`reconcileClaimedRow` (settle tail รวมในตัวเดียว `settleOnly`) + builders `rowIdentityFilter`/`rowSyncUpdate` · guard ใหม่ same-owner+`activeClaims.has`→leave (executor จริง · ห้าม normalize/retry) · `verifyForeignClaim` defer เสมอ (active→หลัง expiry · expired→+250ms bounded) — ทุก leave มี wake-up
  - `bufferService` — `flushBuffer` gate `bot_worker_enabled` ในตัวเอง (debounce/retry/recovery callers ผ่าน gate เดียวกัน) · `clearAllBufferTimers` เคลียร์ flushRetryTimers รวม
- **RED (ก่อนแก้)**: R36 `clearPendingWork is not a function` · R37 in-flight row ถูก normalize processing→buffered กลาง callBot · R38 member q2 ถูกแตะ (ทั้งคู่กลาย buffered) · R40 callBot=1+transition ขณะ disabled · R39 pass จาก timer รั่วข้าม test — teardown clearPendingWork แยกสะอาดหลังแก้
- **verify (fresh)**: recovery **41/41** · enable-checkpoint **18/18** (+rising-edge recovery ×2, falling-edge cancel) · idempotency **43/43** · boundary **20/20** · races **37/37** · rollback **14/14** · tsc ✓ · npm build ✓ · git diff --check ✓ · DB writes=0 · worker off · LLM/API=0
- **หยุดรอ review — ยังไม่ commit/push · ห้าม execute quarantine/rollback · ห้ามเปิด worker**

#### ✅ Botworker Lifecycle Review-Fix — A(mid-pass disable)/B(shutdown drain)/C(unbounded leave) · DONE R41–R43 (44/44)

- **root causes (review findings)**:
  - A — `recoverStaleBuffersAndClaims` อ่าน `bot_worker_enabled` เฉพาะต้น pass → ปิดกลาง pass ยังเข้า `recoverStaleClaims` + launch `processMessage` ได้
  - B — `waitForInFlight` รอเฉพาะ `inFlight` ไม่รวม `recoveryInFlight` → shutdown drain คืนก่อน recovery จบ → pass ที่ค้างรั่วข้าม test/run ถัดไป (พิสูจน์ใน suite: R42's pass รั่วเข้า R43 → `recoveryAgain` merge → settle ซ้ำเขียน no_action)
  - C — `reconcileClaimedRow` settle tail `return "leave"` หลัง finalize miss ×2 โดยไม่ตั้ง `deferredUntil` → claim processing@เรา ไม่มี wake-up (unbounded)
- **วิธีแก้ (owner เดียว, ไม่เพิ่ม module/flag)**:
  - `let recoveryEpoch` (module, owner=`botWorkerService`) — `clearPendingWork()` ++ → in-flight pass abort ผ่าน checkpoint เดียวกัน: capture ต่อ do-while iteration → `epoch!==recoveryEpoch` ก่อน claims phase (`continue`) + loop-top `recoverStaleClaims` ก่อน launch `processMessage` (break) · buffered path ยังคุมด้วย `flushBuffer` enabled gate เดิม — ไม่ duplicate enabled owner
  - `waitForInFlight` drain loop รวม `recoveryInFlight` (`allSettled`) — shutdown เดิม `clearPendingWork`+`waitForInFlight` timeout เดิม ไม่ hang (epoch abort ทำให้ pass คืนเร็ว)
  - settle tail → `verifyForeignClaim(claimId, stats)` — re-read เดียว: terminal→delete / processing→`deferredUntil`+leave (bounded wake) — defer owner เดิม ไม่เพิ่ม retry loop
  - harness: fakemongo `updateManyHook` veto seam + state decls (`findOneAndUpdateHook`/`updateManyHook`/`onQuery`/`queryDelayMs`) + resetState ล้างทั้งหมด
- **RED evidence (ก่อนแก้)**: `R41 callBot=1` (claims phase launch หลัง disable) · `R42 waitForInFlight returned while recovery pass still running` · `R43 claim ถูก contaminated pass ของ R42 เขียน no_action ข้าม test` (isolated repro: claim ค้าง processing ไม่มี wake-up)
- **ผลเคสอื่น**: R1–R40 ครบ · buffered/dual-phase ordering เดิม · error carry-forward/bot_failed semantics ไม่แตะ · no collection/index/config/env/dependency/status ใหม่
- **verify (fresh)**: recovery **44/44** · checkpoint **18/18** · idempotency **43/43** · boundary **20/20** · races **37/37** · rollback **14/14** · tsc clean (ลบ tsconfig.tsbuildinfo เก่าเพราะ incremental cache ค้าง — regenerate แล้ว) · npm build ✓ · git diff --check ✓ · DB writes=0 · worker off · LLM/API=0
- **หยุดรอ review — ยังไม่ commit/push · ห้าม execute quarantine/rollback · ห้ามเปิด worker**

### 🔧 Botworker Round 4 — source isolation + current-turn history exclusion + measured UI perf (2026-10-01) · TDD · ยังไม่ commit/deploy

- **scope (user-refined)**: แก้เฉพาะ boundary ที่พิสูจน์ผิด — รักษา image_desc/Vision cache เดิมทั้งหมด ห้ามรื้อระบบ/สร้าง cache ใหม่
- **audit findings (โค้ดจริง)**:
  - **F1 (High)** messages route `srFilter` ไม่มี origin/mode → `manual`/`manual_conversation`/`shadowbot`/`ticket` replies ปนใน /botworker + `$nin:["",null]` match docs ที่ field หาย (empty leak); `/api/botworker/replies` มี `mode:"standalone"` แต่ไม่มี `origin` + ตัด legacy docs (mode absent) ทิ้งผิด contract
  - **F2 (High)** `getGroupedHistoryForBot` อ่าน messages_shp role=user ล่าสุด 50 — current inbound อยู่ในนั้นแล้ว (data mirror เขียนก่อน worker poll) → current text ซ้ำทั้ง `history` และ `message`; callers: botWorkerService ×2 + workflow let_ai_respond (botworker branch)
  - **F3 (High ผลลัพธ์ของ F2)** current images อยู่ทั้ง history.images และ req.images → Python `_urls_to_read` ไม่ dedup → describe_images อ่าน URL ซ้ำ = 2× Vision calls/รูป; residual edge post-F2: URL เดิมใน history-without-desc + req.images → `describe_images` ต้อง exact-string dedupe preserve-order ก่อน max cap
  - **F4 (Med)** inbox `BW_CACHE_TTL=2500` < poll 3000 → miss ทุก poll; `ts=now` จับก่อน queries → freshness สั้นกว่า TTL; admin convention `CACHE_TTL=5000`
  - **F5 (Med)** page.tsx มี 2 fetch mechanisms ต่อ resource: `useEffect(loadConversations)` (mount+deps change) + `usePolling` (tick) → overlap เมื่อ fetch ช้ากว่า interval หรือ dep เปลี่ยนกลาง poll; messages เช่นกัน (selectedId effect + poll)
  - **F6 (Low — วัดก่อน)** messages route query Product DB ทุก poll เมื่อ conv มี product cards
  - **F7 (info)** callBot throw บน error/non-2xx + AbortSignal.timeout(90s<lease150s) → bot_failed terminal ผ่าน claim contract — listener :8010 python up, :3000 admin up, worker หยุดแล้ว
- **plan**:
  - B — `messageService` export `BOTWORKER_REPLY_FILTER` (module-level owner เดียว: origin∈{worker,workflow} + (mode=standalone|absent) + !deleted + text ไม่ว่าง) → ใช้ใน getGroupedHistoryForBot + messages route + replies route (3 sites จริง → dedup ถูกต้อง)
  - C — `getGroupedHistoryForBot({excludeMessageIds})` → `message_id:{$nin:ids}` ใน Mongo filter (ไม่ใช่ Node filter); callers ส่ง `ctx.message_ids`; `EngineMessage.exclude_message_ids` → let_ai_respond ส่งต่อ; non-botworker callers ไม่เปลี่ยน
  - D — `llm.describe_images`: `urls = list(dict.fromkeys(image_urls))[:max_images]` (dedupe ก่อน cap) — เฉพาะเมื่อ RED test พิสูจน์ dup ถึง describe_images; SRS_SSD อัปเดตตามกฎข้อ 1
  - E — instrumentation suite วัดก่อน: route-level op counter + Date.now control + React-stub usePolling overlap test; fix: `ts:Date.now()` ตอนเขียน cache + TTL 5000 (convention admin) + `usePolling({immediate,restartKey})` additive + page ลบ duplicate initial effects (running→ref shared กัน restart-overlap)
  - F — pin test callBot error → bot_failed + finalized (ไม่วน); รายงาน listener state ไม่แก้ port
- **files ที่แตะ**: messageService.ts · messages route · replies route · conversations route (cache) · workflowEngine.ts (EngineMessage+let_ai_respond) · botWorkerService.ts (engineMsg+2 call sites) · usePolling.ts (options additive) · botworker/page.tsx · llm.py (dedupe เดียว) · SRS_SSD.md · ไฟล์ test ใหม่ ×3 ชุด · log นี้
- **ห้าม**: ไม่มี index/collection/config/flag/dependency/migration ใหม่ · ไม่แตะ v2/v3 · ไม่ commit

#### ✅ Botworker Round 4 เสร็จ (2026-10-01) — boundary 20/20 + vision-dedupe 4/4 + races 37/37 · รอ review · ยังไม่ commit/push/deploy

- **RED evidence (ก่อนแก้ — 13 fail ตรง root cause)**: S1 messages route รวม manual/manual_conversation/shadowbot/ticket-mode replies ปน · S3 replies route ตัด legacy worker docs (mode absent) ทิ้ง · E1/E2 current text ซ้ำใน history · E5/E6 processMessage→callBot history มี current · E7 workflow let_ai_respond เหมือนกัน · E8 isolation/priority · P1 poll +3s → cache miss 4 queries (TTL 2500<3000) · P2 slow queries → data stale ตั้งแต่เกิด (ts จับก่อน query) · P3 ไม่มี immediate option · P4 (measurement) two-mechanism pattern → maxInFlight=2 พิสูจน์ overlap จริง
- **fix B**: `BOTWORKER_REPLY_FILTER` ใน messageService.ts (owner เดียว: origin∈{worker,workflow} + mode=standalone|absent + !deleted + text ไม่ว่าง — เงื่อนไขเดิมของ getGroupedHistoryForBot ยกเป็น shared const) → ใช้ใน 3 site: getGroupedHistoryForBot + messages route `srFilter` + replies route `filter`
- **fix C**: `getGroupedHistoryForBot({excludeMessageIds})` → `message_id:{$nin}` ใน Mongo query (ไม่ใช่ Node filter — limit 50 ไม่ถูก current batch กิน) · `EngineMessage.exclude_message_ids` (optional, non-botworker ไม่เปลี่ยน) · botWorkerService ส่ง `ctx.message_ids` ทั้ง 3 path (trigger bot_answer L968 / normal fallback L1060 / engineMsg→workflow let_ai_respond)
- **fix D**: `llm.describe_images` — `urls = list(dict.fromkeys(image_urls))[:max]` (dedupe preserve-order ก่อน cap) — จำเป็นเพราะ `_urls_to_read` รวม history-undescribed + req.images โดยไม่ dedupe ข้ามแหล่ง (test D1/D2 RED: 4 calls→2, dup กิน quota) · **ไม่แตะ app.py/cache/schema** — image_desc flow เดิมทั้งหมด
- **fix E**: conversations route TTL 2500→5000 (admin convention) + `ts: Date.now()` ตอนเขียน cache · usePolling += `{immediate, restartKey}` (additive — callers เดิม enabled-only ไม่เปลี่ยน deps) · page.tsx ลบ 2 duplicate fetch mechanisms → usePolling เดียวต่อ resource (conv: immediate+restartKey=loadConversations · messages: non-fetch clear effect + immediate+restartKey=selectedId, `finally setLoadingMessages(false)` รักษา spinner semantics + error เก็บข้อมูลเดิม)
- **fix F**: pin test — callBot throw → claim terminal `bot_failed` + finalized (claim contract เดิมครอบอยู่แล้ว) · listeners: :8010 chatbot up (GET / →200, /health→200) · :3000 admin up · ไม่มี botworker process ค้าง
- **verify (fresh)**: boundary **20/20** · vision-dedupe py **4/4** · production-races **37/37** · idempotency **43/43** · shadow **22/22** · verify-botworker-parallel **21/21** (T6 confirm boundary ใน real path) · tsc ✓ · py_compile llm.py ✓ · diff --check clean · audit: 0 env/secret/v2-v3-runtime/ticket-state/delivery diff
- **complexity**: +1 shared const (BOTWORKER_REPLY_FILTER, 3 sites dedup จริง) +1 optional param +1 optional EngineMessage field +2 usePolling options · **−1 fetch mechanism/resource** (page) · −1 duplicate Vision call/dup URL · **0** index/collection/env/config/flag/dependency/migration
- **measure (P6)**: inbox miss = 4 queries (conversations.find + test_status.find + admins.find + countDocuments) · messages = 4 queries + product lookup เฉพาะเมื่อมี product cards · post-fix poll +3s = **0 queries** (cache HIT) · overlap maxInFlight เดิม 2 → ใหม่ 1
- **residual**: non-botworker callers ของ grouped history ไม่ส่ง excludeMessageIds (behavior เดิม — shadow_inbox generate path ยังเห็น current ใน history เหมือนเดิม ตั้งใจ); restartKey ใหม่เพิ่มใน deps — callers เดิม undefined → stable
- **ยังไม่ทำ**: stage/commit/push/deploy — รอ review · manual sandbox acceptance ยังไม่ได้รัน (ต้องเปิด worker จริง)

### 🔧 Botworker Final Review Fix Round 3 — 1 High + 1 Medium (2026-10-01) · ยังไม่ commit/deploy

- **audit**: (H1) `matchAndRun` ทั้งสอง recovery site (early L358-364 + post-gate L414-419) — acquire fail + ไม่มี `result` → `inFlightResult` ไม่ condition อะไรเลย → terminal run (errored/cancelled/completed-no-result/doc หาย) โกหกเป็น in_flight → claim ค้าง processing → retry วนจน bot_failed ผิดเพี้ยน (และไม่ตรง fresh-exec semantics); (M) early recovery ใช้ `find({conversation_id}).toArray()` แล้ว filter op key ใน Node — โหลด runs ทั้ง conv เข้า memory
- **plan**:
  - H1 — EngineResult += `recoverable?: boolean` (absent=recoverable เดิม); helper เดียว `classifyUnacquirableRun(runId, wfId)` — fresh read: `result`→คืน / running|waiting→in_flight / doc หาย|terminal ไม่มี result→`error`+`recoverable:false` (detail ใส่ status+outcome); ใช้ทั้ง 2 site — ห้ามสร้างซ้ำ
  - botWorkerService — ทั้ง 2 matchAndRun call site (L842, L1021): `error && recoverable===false` → return `{status:"bot_failed", outcome:{type:"bot_failed"}}` settle claim terminal — ห้าม fall ไป trigger/bot (op commit แล้ว อาจมี side effect ที่ไม่มีหลักฐาน → bot ซ้ำโดยไม่รู้ตัว อันตรายกว่า terminal failure); resume path (L831) คง fall-through เดิม (resume error = op ไม่เคย commit → message ยังไม่เข้า flow → bot fallback ปลอดภัยตามเดิม)
  - M — `findOne({conversation_id, operation_key})` แทน toArray+in-memory (conversation boundary คงเดิม; **ไม่มี operation_key index — prefix conversation_id ของ index เดิมถูกใช้, ไม่เพิ่ม index**)
  - backstop ใน resumeFlow ลบ — audit แล้วว่าทุก success path เขียน resume_results atomic (wait-park/completeRun/handleFalseBranch×4/phase2 retry); ลบแล้ว A9 tests กัน regression แบบไม่มีหลังพึ่งพิง
- **RED**: D1 errored/D2 cancelled/D3 completed-no-result → error+!recoverable ไม่ใช่ in_flight · D4 doc หายกลาง recovery (findOneAndUpdateHook delete) · D5 running foreign → in_flight (control) · D6 waiting foreign → acquire เดินต่อ (contract เดิม) · D7 botWorkerService → claim bot_failed ไม่ค้าง processing · D8 legacy no-opkey run ไม่ match boundary · D9 findOneHook pin compound filter {conversation_id, operation_key} · counters คง 0 ทุก terminal case

#### ✅ Final Review Fix Round 3 เสร็จ (2026-10-01) — 37/37 production-race + 43/43 + 22/22 · รอ review · ยังไม่ commit/push/deploy

- **RED evidence (ก่อนแก้ — 6 fail ตรง root cause)**: D1-D4 ทุก terminal state → `"in_flight"` เท็จ (errored/cancelled/completed-no-result/doc-deleted-mid-recovery) · D7 ผ่าน processMessage จริง → claim ค้าง `processing` finalized:false · D9 ไม่มี findOne ที่มีทั้ง conversation_id+operation_key (toArray scan)
- **fix H1**: `resolveUnacquiredRun(runId, wfId)` helper เดียว ใช้ทั้ง 2 recovery site — fresh-read `{run_id}` → `result`→committed · `running|waiting_for_reply`→in_flight · terminal/missing→`error`+`recoverable:false` (detail ใส่ status+outcome); `EngineResult.recoverable?: boolean` (absent=recoverable เดิม) — caller แยก retryable/terminal ได้ชัด
- **botWorkerService**: ทั้ง 2 matchAndRun site (workflow_first/both + trigger_first) `error && recoverable===false` → `{status:"bot_failed", outcome:{type:"bot_failed"}}` — settle claim terminal ไม่ fall ไป trigger/bot (op commit แล้ว side effect ไม่มีหลักฐาน → bot ซ้ำอันตรายกว่า); resume path คง fall-through เดิม (resume error = op ไม่เคย commit → message ยังไม่เข้า flow)
- **fix M**: `findOne({conversation_id, operation_key})` server-side — conversation boundary เดิม · ใช้ index prefix `conversation_id` ที่มีอยู่ · **ไม่เพิ่ม index**
- **backstop**: ลบ wrapper post-write ใน resumeFlow — audit ครบ: ทุก success path (wait-park/completeRun/handleFalseBranch×4/phase2 wait-retry) เขียน resume_results ใน ownedUpdateRun เดียวกัน; ลบแล้วไม่มีอะไรซ่อน path ที่ขาด
- **verify (fresh, no --env-file)**: production-races **37/37** · idempotency **43/43** · shadow **22/22** · tsc ✓ · build ✓ · phase1/phase6/e2e **NOT RUN: credentials unavailable** · diff --check clean
- **complexity**: +1 helper (resolveUnacquiredRun ใช้ 2 site) +1 optional field `recoverable` · −1 wrapper write (backstop ลบ) · 0 index/collection/env/config/dependency · schema.md ไม่ต้องแก้ (recoverable ไม่ persist — error results ไม่เขียน result/resume_results)
- **residual**: run terminal + ข้อความ retry จะ bot_failed แทน fall-to-bot — ตั้งใจ (side-effect ปลอดภัยกว่า); D5 running-foreign ยังรอ lease-expiry retry เดิม
- **ยังไม่ทำ**: stage/commit/push/deploy — รอ review### 🔧 Botworker Final Review Fix Round 2 — 2 High (2026-10-01) · ยังไม่ commit/deploy

- **audit**: (H1) `resumeFlow` wrapper เขียน `resume_results[opKey]` แยกจาก state commit ของ helpers → crash ระหว่าง complete/park-write กับ result-write → run terminal แต่ไม่มี resume result → retry ได้ error → fallthrough trigger/bot; (H2) `matchAndRun` op-key recovery (run_id findOne L371) อยู่หลัง workflow_enabled/listWorkflows/keyword/frequency gates → retry หลัง disable/unpublish/frequency-ครบ/flag-off → no_match → ตกไป path อื่น
- **plan**: H1 — outcome write รวมเข้า mutation owner เดิม: helpers (wait-park/handleFalseBranch×4/completeRun/phase2 wait-retry) ใส่ `resume_results[execOpKey]` ใน `ownedUpdateRun` เดียวกันเมื่อ execOpKey≠run.operation_key (normalize status actioned→resumed ที่ helper → stored===returned; wrapper post-write คงเป็น backstop idempotent) · H2 — `matchAndRun` ต้นไฟล์: `operation_key` → `find({conversation_id})` (index prefix ที่มีอยู่ — ไม่มี operation_key index ตาม audit mongoClient L208-213 → filter in-memory, runs/conv น้อย) → prior.result คืนเดิม / acquireRun fenced / in_flight; ไม่มี prior → gates เดิมสำหรับ op ใหม่
- **RED**: A9 crash-window (state committed, resume_results write dies → retry ต้องคืนผลเดิม, side-effect counter=1, initial result คง) ×3 cases (completed / re-parked / assign_ticket idempotent) · A10-A13 recovery-order (once_per_conversation/once_per_customer/disabled-workflow/flag-off + new-key-gated control + different-key isolation)

#### ✅ Final Review Fix Round 2 เสร็จ (2026-10-01) — 28/28 production-race + 43/43 baseline · รอ review · ยังไม่ commit/push/deploy

- **RED evidence (ก่อนแก้ — 7 fail ตรง root cause)**:
  - A9a/A9c: crash หลัง commit-completed → retry ได้ `"run is completed — cannot resume"` error (resume_results ไม่เคยถูกเขียน)
  - A9b: crash หลัง re-park → retry re-walk จาก w2 → คืน `"action send_message done"` แทน parked outcome (re-execution)
  - R1/R2: retry โดน frequency gate → `no_match`; R3 disabled workflow → `no_match`; R4 flag off → `"workflow engine disabled"`
  - R5 (control) ผ่านทั้งก่อน/หลัง — gates ยังกัน op ใหม่
- **fix H1 (atomic outcome)**: `ownedUpdateRun` param widen → `Record<string,unknown>` (รับ dotted `resume_results.<key>`); helpers ทุก commit site (walkGraph wait-park, handleFalseBranch ×4, completeRun, resumePhase2Wait wait-retry) เขียน `resume_results[execOpKey]` **ใน mutation เดียวกัน** เมื่อ `execOpKey ≠ run.operation_key`; status normalize `actioned→resumed` ที่ helper → stored === returned (caller mapping no-op); initial `result` immutable เหมือนเดิม; timeout path (execOpKey=undefined) ไม่เขียน result/resume_results — semantics เดิม; wrapper post-write คงไว้เป็น backstop idempotent
- **fix H2 (recovery order)**: `matchAndRun` ย้าย existing-op recovery ขึ้นก่อน `getSystemConfig`/listWorkflows/keyword/frequency ทั้งหมด — `find({conversation_id})` (index prefix เดิมที่มีอยู่; **ไม่มี operation_key index — audit mongoClient L208-213 แล้ว ไม่เพิ่ม index**) + filter op key ใน memory → prior.result คืนเดิม / `acquireRun` fenced / `in_flight` / เดินต่อด้วย `getWorkflow(workflow_id)` ของ run (ทำ op ให้จบแม้ workflow ถูก disable) · ไม่มี prior → op ใหม่ → gates ปกติ
- **verify (fresh, no --env-file)**: production-races **28/28** · idempotency **43/43** · shadow-batch-isolation **22/22** · tsc --noEmit ✓ · npm build ✓ · phase1/phase6/e2e — **NOT RUN: credentials unavailable** · git diff --check clean
- **complexity audit**: 0 helper/owner/flag/schema/index/collection/env/dependency ใหม่ — ใช้ `acquireRun`/`failRun`/`runFlow`/`getWorkflow`/`ownedUpdateRun` เดิม; fields เดิมทั้งหมด (resume_results เคยมีแล้ว); เพิ่ม query `find({conversation_id})` 1 ครั้งต่อ keyed matchAndRun (index-backed prefix, bounded per-conv)
- **residual**: terminal errored runs ไม่มี result → in_flight semantics เดิม (pre-existing); wrapper post-write = backstop idempotent (1 updateOne เพิ่มต่อ resume); resume paths ที่เคยคืน "actioned" ตอนนี้คืน "resumed" (self-consistent — outcome เป็น workflow_resumed ซึ่งถูกต้องกว่าสำหรับ resume)
- **ยังไม่ทำ**: stage/commit/push/deploy — รอ review

### 🔧 Botworker Final Review Fix — scope แคบ 1 High + 4 cleanup (2026-10-01) · ยังไม่ commit/deploy

- **audit**: `matchAndRun` เก็บผล op แรกใน `run.result` — แต่ `completeRun`/wait/false/stay-retry เขียน `result` ทุกครั้งที่ `run.operation_key` มี → resume op (คนละ key) เขียนทับผล op แรก → retry op แรกได้คำตอบข้อความภายหลัง (HIGH); `handoffService` recovery branch เขียน done/result ด้วย filter `_id` อย่างเดียว → stale owner ทับ result ของ winner ได้
- **plan**: A7 RED (initial park → resume complete → retry op_initial ต้องได้ result เดิม) + B6 RED (stale owner เขียน recovery result หลัง reclaim ต้องไม่ติด) → fix: result เขียนเฉพาะเมื่อ executing op === run.operation_key (provenance ผ่าน msg.operation_key, legacy ไม่มี key คงเดิม); handoff recovery write fenced `{_id,status:pending,owner_id,fence}` + matchedCount + converge/in_flight
- **cleanup**: schema docs อัปเดต fields ใหม่ · แก้ log claim `--env-file` (ผิด — flag ทำให้ process อ่านไฟล์จริง) · LOC accounting รวม untracked · ไม่เพิ่ม architecture

#### ✅ Final Review Fix เสร็จ (2026-10-01) — 20/20 production-race + 43/43 baseline · รอ review · ยังไม่ commit/push/deploy

- **RED evidence (ก่อนแก้)**: A7 fail — `initial result overwritten by resume` (parked snapshot A `{waiting for reply at n2, delivered:[mock bot answer]}` ถูกทับด้วย B `{action send_message done, delivered:[resumed-reply]}`); B6 fail — stale owner A เขียน `recovered_pending_op` result ติดหลัง B reclaim fence N+1 (คืน assignment result แทน in_flight)
- **root cause → fix:**
  - **A) workflowEngine**: helpers (walkGraph wait-park / handleFalseBranch ×4 / completeRun) เขียน `result` ทุกครั้งที่ `run.operation_key` มี → resume op เขียนทับผล initial · **fix**: เพิ่ม `execOpKey` param ผ่าน runFlow(initial=`run.operation_key`)/doResumeFlow(resume=`msg.operation_key`)/resumePhase2Wait/processWaitTimeout(timeout=`undefined`) → `result` เขียนเฉพาะเมื่อ `execOpKey === run.operation_key` (immutable snapshot ของ initial op); ผล resume อยู่ `resume_results[opKey]` ผ่าน resumeFlow wrapper เหมือนเดิม — ไม่มี result store/collection ใหม่; legacy (ไม่มี op key) behavior เดิม
  - **B) handoffService**: recovery branch (assignment_operation_key===opKey) เขียน `{status:done,result}` ด้วย filter `{_id}` อย่างเดียว → stale owner ทับได้ · **fix**: CAS `{_id, status:"pending", owner_id, fencing_token}` + matchedCount — แพ้ fence → อ่าน winner result / ไม่มี → `in_flight`; ไม่มี terminal write ที่ใช้ `_id` อย่างเดียวเหลือ
- **tests เพิ่ม**: A7 (initial park → resume complete → retry initial ได้ result A เดิม / result B อยู่แค่ resume_results / callBot=1 ไม่ re-exec / same-resume-key retry / different-key isolation) · A8 (initial complete ทันที → retry คืน persisted result ไม่ re-exec) · B6 (stale owner fenced-write recovery result ไม่ติด → in_flight)
- **verify (fresh, no --env-file)**: production-races **20/20** · idempotency **43/43** · tsc --noEmit ✓ · npm build ✓ · shadow-batch-isolation **22/22** · phase1/phase6/e2e — **NOT RUN: credentials unavailable** (process env ไม่มี ADMIN_*/MONGO_*; ห้าม `--env-file`) · git diff --check clean
- **dedup audit**: `callBot`/`getSystemConfig`/`shouldUse*`/`getBotProductLimit` identical ในสอง mocks → extract เป็น `makeCallBotMock`/`makeGetSystemConfigMock` ใน fakemongo.mjs (−59 บรรทัด mocks, +50 shared); COLLECTIONS ต่างกันโดยเจตนา (curated surface ต่าง harness) — ไม่ใช่ mechanical dup; race coverage คงเดิม
- **schema docs**: `docs/schema.md` อัปเดต chat_processing (owner/fence/lease/attempt/batch/outcome/reply_ids/side_effects) · buffer_messages (claim_id/owner/fence/kind/status/batch + conv_lock rows) · workflow_runs (operation_key/result immutable/resume_results/owner/fence/lease/test_source + แก้ status enum) · test_status_conversation (assignment_operation_key) · +ส่วน 2.33 `botworker_events` (handoff op doc fields) — ทั้งหมด optional บน collection เดิม ไม่มี migration/index/collection ใหม่ · `ChatAdminWeb/docs/DATA_SCHEMA.md` ไม่มี collections เหล่านี้ → ไม่ต้องแก้
- **ยังไม่ทำ**: stage/commit/push/deploy — รอ review

### 🔧 Botworker Runtime Hardening — Review Fix round (2026-10-01) — production-race harness + Task A/B/C · ยังไม่ commit/deploy

**audit production code (ก่อนแก้ — findings confirm จริงทุกข้อ):**
- `workflowEngine.updateRun` (L145) filter แค่ `{run_id}` → stale owner เขียนทับ run ที่ถูก reclaim ได้; mutation ทุกจุด (runFlow/walkGraph/completeRun/failRun/resumePhase2Wait/handleFalseBranch/doResumeFlow/processWaitTimeout/getActiveRun-cancel/resume_results write) ผ่าน unfenced path เดียวกัน
- `resumeFlow` (L530) = read snapshot → exec → write ไม่มี ownership CAS; concurrent resume ต่าง op key บน run เดียวเดินพร้อมกันได้
- in-flight คืน `status:"actioned"` (L292/315/329) → botWorkerService `settleWorkflowResult` finalize claim terminal ทั้งที่ยังไม่มีผล (empty outcome)
- run lease ไม่มี heartbeat — graph walk ยาว >150s (50 steps × callBot/send_http) โดน reclaim กลางทางได้
- reclaim CAS ขาด `fencing_token` read-check → same-process callers คู่ (owner เดียวกัน) ผ่าน CAS ทั้งคู่
- `handoffService.handoffToAdminTest` op path: pending+no-result → `meta.assigned_to` ใดๆ = commit proof (assignment เก่าของ op อื่นหลุดมาได้) → fallthrough `doHandoffToAdminTest` โดยไม่มี ownership → concurrent callers exec ซ้ำ + cursor ขยับซ้ำ; op doc ไม่มี owner/fence/lease; result write unfenced
- `bufferService.flushBuffer`: re-fence fail → คืน buffered เหมือนกันทุกสถานะ (terminal claim = zombie row loop); `claimedIds=0` ไม่ schedule retry; candidate query อ่านเฉพาะ `status:"buffered"` → row ค้าง `processing` (crash กลาง flush) หายถาวร
- **test honesty**: hooks เดิม redirect `workflowEngine`+`handoffService` → H3/H4 ทดสอบ mock implementation ไม่ใช่ production

**plan:**
1. extract `scripts/test-botworker-fakemongo.mjs` (shared FakeCollection — before/after semantics, clone-on-read, hook seams) + เพิ่ม op ที่ production chain ใช้จริง: `$push`, `$addToSet`($each), `$nin`, null-matches-missing, multi-key sort
2. refactor mocks เดิมให้ใช้ shared fake mongo (exports เดิมคงไว้ — 43 tests ต้องผ่าน)
3. สร้าง `test-botworker-production-races-{hooks,mocks}.mjs` + `.ts` — redirect เฉพาะ leaf: `mongoClient` (adapter) + `botCallService` (HTTP) + `systemConfigService` (config provider); 4 owner modules (workflowEngine/handoffService/botWorkerService/bufferService) รัน production จริงบน fake mongo — รวม testStatusConversationService/assignmentService (cursor จริง)/workflowService/adminLogService
4. RED tests: A1 stale-owner-cannot-write / A2 concurrent matchAndRun ครั้งเดียว / A3 foreign-active→in_flight / A4 botworker in_flight→claim ไม่ terminal / A5 concurrent resume diff-key ครั้งเดียว / A6 resume crash-retry dedupe · B1 concurrent op exec-once / B2 crash-after-commit reconstruct by op key / B3 stale assigned_to wrong key → no shortcut / B4 expired op reclaim once / B5 active op → in_flight · C1 terminal claim→row cleanup / C2 foreign-active→buffered+retry→processed later / C3 claimedIds=0 retryable→retry / C4 mixed terminal+owned
5. impl: `in_flight` EngineResult status + fenced run writes (owner+fence CAS, RunOwnershipLost→stop walk) + run lease renew per step + resumeFlow CAS-acquire + fenced resume_results/result writes + read-fence บน reclaim/acquire + in-process activeRuns guard; handoff op doc owner/fence/lease + read-fence reclaim + `assignment_operation_key` บน test status doc + fenced result write + in_flight result; flushBuffer 3-way classify (terminal→delete/foreign→buffered+retry/owned→batch) + candidates รวม processing rows + claimedIds=0+retryable→schedule retry
6. guard test: อ่าน hooks source → assert 4 protected modules ไม่อยู่ใน TARGETS
7. verify เต็ม + log

**complexity delta (คาด)**: 0 collection/index/env/config/migration ใหม่ — `in_flight` เป็น EngineResult status เพิ่ม (contract value ไม่ใช่ config); `assignment_operation_key` field ใหม่บน test_status doc เดิม; op doc เพิ่ม owner/fence/lease fields บน botworker_events เดิม

#### ✅ Botworker Runtime Hardening — Review Fix round เสร็จ (2026-10-01) — 17/17 production-race + 43/43 baseline · รอ review · ยังไม่ commit/push/deploy

- **RED evidence (ก่อนแก้)**: `test-botworker-production-races.ts` 17 tests → **4 pass / 13 fail** ตรง root cause ทุกข้อ (A1 stale write, A1b mid-graph, A2 double exec, A3 actioned-แทน-in_flight, A4 finalize+empty outcome, A5 double resume, B1-B5 handoff, C1/C3/C4 buffer) — pass 3 ตัวเป็น honest locks (T1 guard, A6, C2)
- **root cause → fix:**
  - **A) workflowEngine**: `updateRun` unfenced → **ลบออก** ทุก call site ใช้ `ownedUpdateRun` (CAS `{run_id, owner_id:me, fencing_token:snapshot, status∈active}` + renew lease = heartbeat) / `cancelIfAbandoned` (reader-cancel เฉพาะ abandoned) / `heartbeatRun` ต่อ graph step (เสีย ownership → `in_flight` หยุดเดินทันที) · `acquireRun` CAS: waiting→flip running atomically (serialize resumers), running→เฉพาะ lease หมด/no-owner · `EngineResult.status + "in_flight"` (retryable ไม่ใช่ terminal) · parked/cancelled op-key runs persist `result` snapshot ใน fenced write เดียวกัน (same-op retry ไม่เดิน graph ซ้ำ) · `resumeFlow`: fresh-read `resume_results[opKey]` → acquireRun → doResumeFlow → key-scoped result write (filter run_id เท่านั้น — key แยก op เขียนทับกันไม่ได้; fenced write จะแพ้หลัง park เพราะ resumer ถัดไป acquire ต่อได้)
  - **B) handoffService**: op doc ได้ `owner_id`/`fencing_token`/`lease_expires_at`/`status` ที่ insert → E11000 path: result→คืนเดิม / pending→`acquireHandoffOp` CAS (expired หรือ ownerless เท่านั้น) → win: เช็ก evidence `assignment_operation_key===opKey` (assigned_to เดิมของ op อื่น ห้ามใช้) → reconstruct หรือ exec / lose: same-owner sibling→poll result / foreign→`in_flight:true` · result write fenced `{_id,owner_id,fence,status:pending}` fail→converge อ่าน result ของ winner · `updateTestStatus` +param `operationKey` stamp `assignment_operation_key` ที่ commit
  - **C) bufferService**: re-fence fail แยกสาเหตุ — claim terminal/missing→`markProcessed(claim.status)`+delete row (ห้าม buffered zombie); foreign-active→buffered+retryableLeft; owned/expired→batch · `claimedIds=0`+retryableLeft→`scheduleFlushRetry` — ปิดข้อความค้างถาวร
  - **D) botWorkerService**: `in_flight` จาก resumeFlow/matchAndRun/pickAgent → return ตรงๆ ไม่มี outcome → claim ค้าง processing (lease expiry → retry) — ห้าม settle/ห้ามสร้าง workflow outcome ว่าง/ห้าม fall-through trigger/bot ซ้ำ
- **production modules ที่ test โหลดจริง** (T1 static guard ผ่าน — hooks redirect เฉพาะ leaf): workflowEngine · handoffService · botWorkerService · bufferService + real รอง: testStatusConversationService · assignmentService (pickNextAgent cursor จริง) · workflowService · conversationService · messageService · adminLogService · botworkerEventService · triggerService · templateService · customerService · liveAssignmentService → leaf mocks เฉพาะ `mongoClient` + `botCallService` + `systemConfigService` + `lib/config`
- **bug จริงที่เจอระหว่าง impl**: (1) `acquireRun` filter `$or:[{status:waiting}]` ให้ resumer ซ้อนได้ — ต้อง flip status=running ใน CAS; (2) `run.result` บน parked run ทำ resumeFlow ของ op อื่นคืนผลผิด — resume dedupe ต้องดู `resume_results` เท่านั้น; (3) fenced `resume_results` write แพ้หลัง run park (fence เปลี่ยน) — key-scoped write จึงถูก; (4) test artifact: `fakeColl` live-ref ทำ `runDoc.fencing_token` เปลี่ยนหลัง reclaim — assert ต้องใช้ staleSnapshot
- **verify (fresh)**: production-races **17/17** · idempotency **43/43** · tsc --noEmit ✓ · npm build ✓ · shadow-batch-isolation 22/22 · workflow-phase1 69/69 · phase6 69/69 · e2e 16/16 (Mongo remote — **แก้ไขบันทึก**: รอบนั้นใช้ `node --env-file` ซึ่ง **runtime อ่านไฟล์จริง** — ข้อความเดิมที่บอกว่า "ไม่ได้อ่านเนื้อหา" ไม่ถูกต้อง; วิธีนี้ถูกแบนแล้ว รอบถัดไปใช้เฉพาะ env ที่ process มีอยู่แล้ว หรือรายงาน `NOT RUN: credentials unavailable`) · git diff --check clean
- **audit**: 0 env/index/collection/config/migration ใหม่ — fields ใหม่ทั้งหมด optional บน collection เดิม (`workflow_runs.result/resume_results/owner_*`, `botworker_events owner/fence/lease/result`, `test_status_conversation.assignment_operation_key`)
- **ยังไม่ทำ**: stage/commit/push/deploy — รอ review

### 🔧 Botworker Part 1 — Implementation Part 1A+1B ผ่านครบ (2026-10-01) — รอ review · ยังไม่ commit/deploy

- **impl files**: `botworkerRuntime.ts` (ใหม่ — constants: claimLeaseMs/heartbeatMs/botCallTimeoutMs/maxClaimAttempts + `ownerId=crypto.randomUUID()` ต่อ boot + claim/convlock/batch/reply/op identity helpers + ClaimContext) · `botWorkerService.ts` (claimMessage E11000/reclaim-expired/fencing/heartbeat/lost-ownership abort/attempt-cap→bot_failed/outcome record/finalize/recv reply-exists→finalize-only/ClaimContext ผ่าน core) · `bufferService.ts` (claim ก่อน buffer insert, ClaimContext บน row, convlock hashed `_id`+`kind:"conv_lock"`, per-row CAS exact ids, fenced release ใน finally, member-only delete, error→rows คง buffered) · `botCallService.ts` (`signal?: AbortSignal` → fetch, timeout<lease) · `bot-worker.ts` (enabled gate ก่อน recovery ทั้ง direct+buffer) · `handoffService.ts` (`operationKey` → dedupe ที่ owner ผ่าน `botworker_events._id=opKey` — insert E11000→คืน result เดิม) · `workflowEngine.ts` (`EngineMessage.operation_key` → matchAndRun dedupe ด้วย run doc `operation_key` + `result` snapshot; assign action ส่ง `${operation_key}:assign:<node>`)
- **crash windows ที่ปิด**: claim→buffer insert gap (claim ก่อนเสมอ); LLM-accepted→crash (LLM ซ้ำได้ — documented); reply-persisted→crash (finalize-only); side-effect→crash (op-key dedupe ที่ owner: G2/G3/D3-D5); flush error (lock release+rows retained: G5); heartbeat lost (abort+ไม่ persist/finalize: G1); stale finalize/release (matchedCount=0: C3,B2)
- **tests เพิ่ม**: G1 lost-heartbeat no-persist · G2 direct-handoff crash dedupe · G3 workflow run dedupe by operation_key · G4 workflow_resumed outcome · G5 flush-error lock/rows
- **ผล verify จริง**: `test-botworker-idempotency.ts` **32/32 ผ่าน** (27 เดิม + G1–G5 ใหม่) · `tsc --noEmit` ผ่าน · `npm run build` ผ่าน · `test-shadow-batch-isolation.ts` 22/22 · `test-workflow-phase1.ts` 69/69 · `test-workflow-phase6.ts` 69/69 · `test-workflow-e2e.ts` **16/16 ผ่าน** (Mongo remote `digital.in.th` ถึงได้ — รอบแรกรายงานว่า blocked ผิด เพราะ pipe ผ่าน tail ทำ streaming output เงียบจนดูเหมือน hang) · `git diff --check` clean · audit: 0 index/migration/collection/config/env ใหม่ (claim=`chat_processing`, lock=`buffer_messages`, reply=`shadow_replies`, op=`botworker_events` — collection เดิมทั้งหมด) · Phase 2A commit `37f6d30` คงเดิมที่ HEAD
- **ยังไม่ทำ**: stage/commit/push/deploy — รอ review

### 🔧 Botworker Part 1 — Runtime Hardening (10 findings, 2026-10-01) — 43/43 ผ่าน · รอ review · ยังไม่ commit/deploy

- **RED baseline (ก่อน impl)**: 31 pass / 12 fail — C1,C2,D3,D4,D5 (findOneAndUpdate คืน before-doc → ctx fence เก่า → finalize ไม่ติด) · H2 cap-update ไม่ CAS · G3 pending-run · H5 ordering · H6 foreign-claim steal · H7 lost-finalize ลบ rows · H8 guess outcome · H10 ไม่ retry
- **fix per finding**:
  1. FakeMongo ตรง Mongo จริง: `findOneAndUpdate` snapshot-before + `returnDocument:"after"` opt-in เท่านั้น (upsert default=null) + `find`/`findOne`/`toArray` คืน `structuredClone` (driver copy semantics — ปิด live-ref aliasing) — H1 pin
  2. ทุก reclaim ส่ง `returnDocument:"after"` (claimMessage + acquireConvLock); attempt-cap update = CAS `{_id,status,lease<$lt,expected owner,expected fence}` — H2: worker-B reclaim กลางคันไม่ถูก terminal ทับ
  3. handoff owner idempotency จริง: pending op (ไม่มี result) → เช็ก `test_status_conversation` ก่อน — committed assignment → reconstruct result + mark op done (ไม่ re-exec); ไม่มี → exec ครั้งเดียว — G2/H3
  4. workflow atomicity: `run_id` deterministic = `wfr_`+sha256(`${op}:${wf}`)[:20] + `_id`=run_id (E11000=run เดียว) + run doc มี `owner_id`/`fencing_token`/`lease_expires_at`; prior running run active owner อื่น → in-flight response; expired/mine/legacy → fenced reclaim (`$or` owner/lease) แล้วเดินต่อ; `resumeFlow` dedupe ด้วย `resume_results[operation_key]` บน run doc — H4
  5. recovery ordering: `recoverStaleBuffersAndClaims` = buffered flush ก่อน (await) แล้ว direct claims; `recoverStaleClaims` exclude claims ที่ยังมี buffer row (hard guard ไม่พึ่ง ordering) — H5: 3 buffered → 1 batch reply
  6. batch claim CAS: row เก็บ expected `owner_id`+`fencing_token`; re-fence filter = `{owner_id:เรา,fence:row.fence}` หรือ `lease expired` เท่านั้น (ห้ามแย่ง active claim คนอื่น — H6); claim fence = per-claim `$inc` (ห้าม share token กับ conv-lock → `fencing_map` per claim + `lock_fencing_token` แยก); `batch_id` recompute หลังรู้ owned member set จริง
  7. finalization contract: `processMessage` คืน `{status,detail,finalized,lost}`; `finalized` เมื่อ `finalizeClaims` ครบทุก claim_ids เท่านั้น; lost/partial → rows คืน buffered ห้ามลบ — H7
  8. outcome envelope บน reply doc (`outcome_envelope:{outcome_type,trigger_id,trigger_action,workflow_id,side_effects[]}`) — recovery อ่าน envelope ห้ามเดา — H8
  9. timeout audit: `liveAssignmentService` ใช้ `AbortSignal.timeout(90_000)` กับ endpoint เดียวกัน + 429-retry 60s → 60s เก่าตัด valid latency → `botCallTimeoutMs=90000`, `claimLeaseMs=150000` (>timeout+headroom), `heartbeatMs=50000` — H9a/H9b (scaled clock)
  10. flush error → `scheduleFlushRetry` ด้วย `flushErrorRetryMs` (5000; expected-owner re-fence ทำให้เร็วได้โดยไม่รอ lease หมด); lock-loser retry คง `LOCK_RETRY_MS=50` แยก cadence — H10
- **bug ที่ mock-faithfulness เผย**: seeded rows ไม่มี `_id` + live-ref → `updateOne({_id:undefined})` match doc แรกที่ไม่มี _id (เขียน expected fence ทับ row ผิดตัว → member หลุด batch) → row ops ทั้งหมดเปลี่ยนเป็น `message_id` (unique ใน buffer_messages) + mock คืน clones — regression จริงใน harness จับได้
- **ผล verify จริง**: `test-botworker-idempotency.ts` **43/43 ผ่าน** (32 เดิม + H1–H10) · `tsc --noEmit` ผ่าน · `npm run build` ผ่าน · shadow 22/22 · workflow phase1 69/69 · phase6 69/69 · workflow e2e 16/16 (Mongo remote) · `git diff --check` clean · 0 index/migration/collection/config/env ใหม่ · HEAD `37f6d30` คงเดิม
- **ยังไม่ทำ**: stage/commit/push/deploy — รอ review

#### Botworker Part 1 — duplicate-processing audit + RED tests (2026-10-01) — audit/test-only (contract history)

- **error**: botworker ประมวลผล inbound message เดิมซ้ำ — live Mongo: `chat_processing` 23,902 docs มี **1,574 duplicate `message_id` groups** (สูงสุด x107), `shadow_replies` 7,359 docs มี **230 duplicate `inbound_message_id` groups**
- **cause**: `isProcessed` (findOne) เช็กก่อนงานเริ่ม + `markProcessed` insertOne หลังงานจบ → check-then-act race ทุก poll (1s) ระหว่าง bot latency; buffer flush ลบ `buffer_messages` ก่อน terminal → re-buffer ซ้ำ; ไม่มี atomic claim/lease; `chat_processing` ไม่มี index เลยใน DB จริง (ensureIndexes ถูกเรียกเฉพาะ instrumentation.ts ไม่ใช่ bot-worker); `recoverStaleBuffers()` รันก่อน `bot_worker_enabled` check ใน bot-worker.ts
- **design (finalized — round 4)**: ClaimContext `{claim_id,owner_id,fencing_token,lease_expires_at}` ผ่าน poll→buffer row→batch processor (core ห้าม claim ซ้ำ; processMessage=thin wrapper claim→core); claim = `chat_processing._id="botworker:claim:<mid>"` → E11000=loser, ไม่ต้อง unique index/dedupe; conv lock = `buffer_messages._id="botworker:convlock:"+sha256([platform,shop,conv])[:32]` + `kind:"conv_lock"` (buffer queries filter status:"buffered" เสมอ); fencing `{_id,owner_id,fencing_token}` ทุก write/release; heartbeat=lease/3 + AbortSignal timeout; ordering = persist reply (`_id="botworker:reply:<batch_id>"`, wf=`:wf<i>`) → outcome record บน claim (`outcome_type`+`reply_ids[]`+`side_effects[]`) → finalize; `batch_id="botworker:batch:"+sha256(JSON[platform,shop,conv,...sortedIds])[:32]`; timing ผ่าน `botworkerRuntime` module boundary (claimLeaseMs/heartbeatMs/botCallTimeoutMs/ownerId/maxClaimAttempts — constants ไม่ใช่ SystemConfig ไม่ใช่ opts); attempt cap→bot_failed; disabled gate ที่ botWorkerService boundary
- **workflow blocker ตัดสินแล้ว**: แยก Part 1A (claim/lease/reply-order/buffer-lock/heartbeat/timeout/disabled gate + outcome record สำหรับ bot/trigger/no_action/direct-handoff) / Part 1B (workflow outcome idempotency — engine assign ใน matchAndRun ก่อน outcome recorded = double-assign window; `storeWorkflowDelivered` random ids → deterministic `:wf<i>`) — **deploy ไม่ได้จนทั้งคู่ผ่าน** ไม่ defer ไป Part 5
- **RED evidence** (`npx tsx scripts/test-botworker-idempotency.ts`, 27 tests → 24 fail/3 pass): A1 callBot=100 · A2=2 · A3=3 · A4=2 · A5=2 · B1 flush×2→callBot=0+no lock · B4 reply(m10a)=2 · C1 claim stuck processing · C2 callBot=0 · C3=0 · C4=2 · C5 no cap→ยัง processing · C6 no claim doc · D3/D4/D5 outcome-seeded claims ค้าง processing (finalize-only recovery ไม่มี) · E1–E7 outcome_type=undefined ทุก branch · F2 disabled→flush 1 conv · PASS: B2 lock lifecycle (E11000/release/stale-fence/reclaim — Mongo semantics), B3 lock-not-message, F1 legacy skip
- **ไฟล์ใหม่**: `scripts/test-botworker-idempotency{,-hooks.mjs,-mocks.mjs}` — runtime/Admin src ไม่แตะ
- **impact on other cases**: ยังไม่มี — ไม่มี runtime change
- **คงค้าง**: รอ review → impl round เปลี่ยน botWorkerService.ts, bufferService.ts, botCallService.ts (timeout), bot-worker.ts (gate), +ใหม่ botworkerRuntime.ts (constants boundary) — 0 index/migration/collection ใหม่

### ✅ Phase 0D — ย้าย Shadow batch isolation เข้าสู่ legacy branch (verify ผ่าน · commit เฉพาะ 4 ไฟล์ `55ec118`)
- **baseline:** `feature-legacy-shopee-evidence-retrieval` @ `ab1b853` มี Phase 0C/docs ค้างเดิม; index ว่าง · Shadow fix เดิมอยู่ commit `58f7262` บน branch แยก
- **plan:** นำเฉพาะ `shadowReplyService.ts` และ regression scripts 3 ไฟล์เข้ามา; ไม่แก้/ไม่ stage ไฟล์ Phase 0C หรือ log นี้ · ทดสอบ service/route mock, typecheck, build, ตรวจ staged diff ก่อน commit
- **ผลกระทบ:** batch ใหม่แยก bot state ตาม generation batch; single-message และ public `conversation_id` ไม่เปลี่ยน · ไม่มีการลบ state เดิม
- **ผล verify:** RED ก่อนแก้ 18 ผ่าน/4 ไม่ผ่าน (state ID รอบใหม่ยังเท่าเดิม) → GREEN 22/22 · `tsc --noEmit` และ `npm run build` ผ่าน · commit `55ec118` มีเฉพาะ 4 ไฟล์ Shadow (`375 insertions/1 deletion`), ไม่ stage log/Phase 0C · ไม่ push/PR
- **คงค้าง:** single-message ยังใช้ namespace เดิม; ไม่มี live Mongo replay
- **cleanup หลังอนุญาต:** ยกเลิก cherry-pick ที่ค้างใน shadow worktree แล้ว; ลบ branch `fix/shadow-replay-batch-isolation-pr` และ `fix/shadow-replay-batch-isolation` · เก็บ commit ต้นฉบับ `58f7262` ด้วย local tag `backup-shadow-batch-isolation-58f7262`; worktree เดิมยังอยู่แบบ detached (ไม่ลบ directory) · legacy/Phase 0C ไม่ถูกแตะนอกจาก entry Phase 0D นี้

### ✅ Phase 0C Final Semantic Closure (2026-09-30) — เสร็จ รอ review · ไม่มี runtime change · ยังไม่ commit

- **งาน:** ปิด semantic gaps ของ harness แบบ TDD — RED mutation tests 5 ตัวล้มก่อน (nonsense action / answer-on-handoff / handoff_reason ผิด / web_search=True / card_status-absent) แล้ว implement จนเขียว
- **ผลสำคัญที่พบจาก hardening จริง:**
  - `tx-q15-unlist-anchor` เดิม "reproduce" ได้ — คำอธิบายที่สอดคล้องคือ **fake-DB mismatch** (.env-era run อาจชี้ `ADMIN_MONGO_DB` ไป db จริง → timeline seed ใน fake `chatbot_admin` หาไม่เจอ → anchor หายเอง) — เป็น plausible explanation ไม่ใช่ข้อพิสูจน์ เพราะห้ามอ่าน .env. ตอน suppress dotenv แล้ว boundary ทำงานถูก (3001 status=unlisted ถึง LLM จริง) → reclassify **pending_live_replay** (prod drop ต้อง live evidence)
  - `sel-all-dead-evidence` + `expected` block บน 13 non-L3 fixtures = false-green claims → migrate เป็น `expectation_note` metadata; validator reject `expected` ถ้าไม่มี level 3
- **แก้:** action enum {answer,handoff,locked,claim_collect,order_info} + answer↔handoff/no-answer asserts + web_search equality ทั้งสองทิศ + llm_card_status absent-item fail + `_ID_EXPECT_KEYS` ชื่อจริง (llm_item_ids/llm_must_not_item_ids/card_status keys, escape=`noncatalog_item_reason`) + exec-mode นับเฉพาะ L3 (**25 flag_off / 0 grouped_on / 13 contract_only** ⚠ superseded — validator สดหลังเพิ่ม policy fixtures = **27 flag_off**; ดู Review Closure ท้ายไฟล์) + negative control base==[] + fail ต้องชี้ `request coverage '<key>' missing` + `_card_group` enumerate `_SUBTYPE_TO_TYPES` (ไม่ copy keyword list) + docstring ซื่อสัตย์ว่า L2 ครอบ planner→bucket→pool→selection **ไม่ครอบ** public executor/source adapters + import-time tripwires (dotenv stub, socket, MongoClient, urlopen, HF env pins, `MONGO_DB`/`ADMIN_MONGO_DB` fake names) ก่อน shopeechat import + subprocess import probe
- **filter-policy corpus (item 7):** `tx-policy-wrong-model-filter` (answer_level, owner=policy_eligibility — transcript wrong-model filter; probe ยืนยัน route `answer_general`/`return_policy` ctx กว้าง ~68 chars ไม่มี structured decision — ไม่ fabricate green) + `pos-policy-seller-wrong-item` (⚠ superseded claim: เดิมเขียน "counterexample กัน deny-all" — จริง assert แค่ answer ไม่ว่าง/ไม่ handoff/ไม่ web_search; ไม่ได้ assert route/LLM/eligibility — ดู Review Closure ท้ายไฟล์) · เพิ่ม `llm_general_qtype` assertion + owner `policy_eligibility` เข้า taxonomy · เพิ่ม qtype/context capture ใน `_CapturedLLM`
- **ผล:** validator 40 rows ผ่าน (28 pos / 8 inc / 2 answer_level / 2 pending) · replay `44 passed, 19 skipped, 8 xfailed, 5 warnings` ×2 deterministic · compile+diff check ผ่าน · runtime/v2v3/ChatAdminWeb แตะ=0 · ไม่มี commit
- **เพดาน:** `gold-q187` + `tx-q15` pending live replay · grouped-selection-on runtime ยังไม่มี fixture · L2 ไม่ครอบ source adapters (fetch/unit/KB queries) ตาม docstring · q15 ต้อง live ยืนยัน prod drop จริง

### 🧭 เพิ่ม filter wrong-model policy incident เข้า rebaseline roadmap (2026-09-30) — docs-only เสร็จ · runtime ยังไม่แก้

- **หลักฐาน:** transcript 12 เทิร์นร้าน Youpin — ลูกค้าสั่งไส้กรองผิดรุ่น แต่ Q5/Q6/Q10/Q11/Q12 บอทรับรองว่าเปลี่ยนได้ ทั้งที่ business rule จริงคือกรณีลูกค้าเลือกผิดรุ่นไม่รับเปลี่ยน/คืน
- **root cause จาก code flow:** `return_policy` → `knowledge_base.build_general_context()` รวม FAQ + policy snippets จาก description สินค้า NORMAL แบบไม่ผูก shop/category/reason/condition → `llm.answer_general()` รับ bot history เดิมด้วย → คำรับรองผิดรอบแรกถูกทำซ้ำ; `guards.enforce()` ตรวจ positive wording ใน prose แต่ไม่มี case-specific eligibility decision จึงไม่ใช่ owner ที่แก้ต้นเหตุ
- **plan decision:** ห้าม `if filter/shop/sentence`; เพิ่ม structured/versioned policy records + `PolicyQuery`/`PolicyDecision` owner ใน Revised Phase 5, โดย Phase 0 เพิ่ม incident/positive counterexamples, Phase 1 แยก policy need, Phase 2 รักษา subject/order facts, Phase 7 ส่ง bounded policy evidence, Phase 8 validate claim ที่ boundary
- **safety semantics:** `eligible` เท่านั้นจึงรับรองว่าเปลี่ยน/คืนได้ · `ineligible` อธิบายตาม rule · `unknown/admin_review` ห้ามทั้งรับรองและปฏิเสธ; seller-sent-wrong/defect/damage ต้องแยกจาก customer-selected-wrong-model
- **scope:** แก้เฉพาะ rebaseline plan + active log; ไม่แตะ runtime/test fixture ในรอบนี้ และไม่ชน Phase 0C ที่กำลังทำ

### ✅ Revised Phase 0C — Harness Semantic Hardening (2026-09-30) — เสร็จ รอ review · ไม่มี runtime change · ยังไม่ commit

- **งาน:** ปิดช่องเขียวปลอมใน replay harness — ทุก expectation key ต้องมี assertion จริง, offline guard ไม่กลืน HTTP นอก allowlist, fake fetch รักษา shop boundary
- **RED ที่จับได้ก่อนแก้:** validator allowlist fail 3 keys พร้อม fixture id — `expected.link_policy` (tx-q09, tx-q18) + `selection_expect.request_type_coverage` (sel-quota-multi-type) — ทั้งคู่เคยเป็นเขียวปลอม
- **A:** validator มี allowlist ครบทุก block (top-level/expected/profile_expect/slot_expect/availability_expect/selection_expect) — unknown key fail พร้อม `fixture_id.key` · meta-test `test_harness_validator_rejects_unasserted_keys` พิสูจน์ `selected_magic_product` ถูก reject
- **B:** `test_l2_selection_contract` เขียนใหม่ผ่าน production chain จริงทั้งเส้น: `build_retrieval_profile`→`build_retrieval_slots`→`build_retrieval_relations`→`build_grouped_retrieval_requests`→`retrieval_executor._bucket`(per-request)→`build_candidate_pool`→`select_for_llm_context` · assert `request_type_coverage` ผ่าน `result.by_request` + per-request quota (subtype ที่ขอต้องไม่ถูก starve) + isolation (card ต้องอยู่ใน request scope) · negative control `test_l2_selection_quota_negative_control`: drop docs ของแต่ละ coverage key → assertion ต้อง fail (ไม่ vacuous)
- **C:** `link_policy` assert ที่ **L3 LLM-input boundary** (cards ที่ส่งเข้า LLM ⊆ subject ids จาก `llm_item_ids`) — จับ incident จริง: **tx-q09 มี 3004/3005/3006 รั่วเข้า llm input** ตอนขอ link → reclassify answer_level→incident (conversation_subject) · tx-q18 เดิม incident อยู่แล้ว assertion ยืนยันเพิ่ม · prose/link text ที่ LLM สร้างอยู่นอกขอบเขต offline (answer-level)
- **D:** `_fake_fetch` แก้ shop boundary — filter ว่าง/ตรง shop → docs; ไม่ตรง → `[]` (เดิมคืน docs ทุกกรณี) · regression `test_harness_fetch_shop_boundary`
- **E:** `_fake_urlopen` เหลือ allowlist เฉพาะ `bot-handoff` endpoint — URL อื่น `pytest.fail("OFFLINE LEAK")` · tests: handoff URL capture ได้ + `example.com` fail ด้วย tripwire
- **F:** flag coverage ตรง — `_expectations_met` assert flag-off fixture ต้อง `chat_engine=="legacy"`; validator พิมพ์ exec mode: **38 legacy_flag_off / 0 grouped_selection_on** → L3 = Legacy default flag-off orchestration เท่านั้น, grouped contract พิสูจน์ที่ L2
- **fixture fix:** `sel-all-dead-evidence` — planner ไม่สร้าง request ให้ generic browse ("มีตัวไหนบ้าง" → slot-open empty types → n_reqs=0) ทำให้ flat-request เดิมเป็น fabrication → ย้ายเป็น L3 expectation ตามพฤติกรรมจริงที่ probe ได้ (dead items ถึง llm input พร้อม status, resp products=0)
- **ผล:** `36 passed, 18 skipped, 9 xfailed, 5 warnings` ×2 รันเหมือนกัน (~1.4s) — **5 warnings เป็น DeprecationWarning (FastAPI on_event) ไม่ใช่ functional failure** · validator 38 rows: 27 positive / **9 incident** / 1 answer_level / 1 pending
- **เพดาน:** `gold-q187` ยัง pending_live_replay (source recall ต้อง Mongo จริง) · grouped-selection-on runtime path ยังไม่มี fixture (ตาม rollout plan — L2 contract cover อยู่) · ไม่มี commit

### ✅ Revised Phase 0B — Replay Harness Hardening & Fixture Integrity Gate (2026-09-30) — เสร็จ รอ review · ไม่มี runtime change · ยังไม่ commit

- **งาน (user สั่ง):** ทำให้ replay suite offline/deterministic จริง + audit fixture integrity ทุก row ก่อนเริ่มเฟสถัดไป — งานนี้แก้เฉพาะ test harness/fixture/evaluator/docs
- **root cause ของ non-determinism/HF hang (พิสูจน์แล้ว ไม่ใช่เดา):** `app.py:27` `load_dotenv` ตอน import → `.env` เข้า process → branch ที่อ่าน env ต่างกันตามเครื่อง:
  1. engine routing `USE_CHAT_V3`/`USE_LEGACY_CHAT` (app.py:612/621)
  2. grouped flags `runtime_config` DB-absent → env fallback (`USE_GROUPED_RETRIEVAL_*`) → `retrieval_executor` → `units.fetch_unit_evidence` → `units._vector_search` → `embedding.embed_query` → `_get_model` → `SentenceTransformer("BAAI/bge-m3")` → **HF hub download ~2GB = hang** (เส้นทางเดียวกันผ่าน `product_store.vector_search` / `knowledge_base.search_qa` — npz 3 ไฟล์มีอยู่จริงใน exports/)
  3. cert path `[CERT]` → `product_store._cached_stock_client` → **real MongoClient(STOCK_URI)** — tripwire จับได้จริงตอน tx-q10 (connect ไป itStock จริง ผ่าน pymongo monitor thread)
  4. `warranty_flow`/`responses` handoff POST ยิง `urllib.request.urlopen` ตรง (ไม่ผ่าน `app._send_handoff`) — เคย patch ไม่ครอบ
- **fix (owner boundary เท่านั้น):** autouse `_offline_guard` — fail เมื่อ `socket.socket.connect` / `pymongo.MongoClient()` / `urlopen`(unhandled) / `embedding._get_model` ถูก reach · `_install` pin env (`USE_CHAT_V3=0`,`USE_LEGACY_CHAT=1`,`USE_UNIT_INDEX=0`) + patch flag fns ตาม `fx.runtime_flags` + `embed_query/embed_texts` → zero vector + `_cached_stock_client`/`persona._cached_admin_client`/`order_store._ORDER_CLIENT` → FakeClient + `urlopen` → capture payload + `BytesIO(b"{}")`
- **fixture fixes:** `inc-ad1404t-relation` shop→KingGadgets (ตรง catalog) · `tx-q07`/`tx-q09` → `answer_level` (boundary contract ผ่าน — incident อยู่ฝั่ง answer) · `gold-q187` rewrite ตาม gold row จริง (ZMIThailand compare CTC620W vs AC30S/T/301) → `pending_live_replay` เพราะ recall-miss ต้องใช้ Mongo query จริง · ลบ `fetchable_item_ids` ทั้งระบบ (fabricate failure) · `tx-q22q25` ประกาศ `synthetic_pii=["phone"]`
- **validator ใหม่:** `docs/test/validate_legacy_turn_fixtures.py` — shop/catalog consistency, expected-ids ∈ catalog, forbidden fetchable mechanism, status/taxonomy/incident_levels honesty, PII scan → **38 rows ผ่าน: 27 positive / 8 incident / 2 answer_level / 1 pending**
- **ผลจริง (3 รันติด เหมือนกันเป๊ะ):** `33 passed, 19 skipped, 8 xfailed` — pytest ~1.2s (wall ~2.1s) จากเดิมที่ค้าง >4 นาที · xfail 8 = reproduced pipeline incidents (L1×1 ad1404t, L3×7) · skips 19 = no-expectation 18 + pending 1
- **evaluator:** `gold_metrics` แสดง `n_gold_total/evaluated/no_record` + `handoff_policy_hit_rate` (denominator = expected-handoff evaluated) + dict-guard products — rates นับเฉพาะ rows ที่ match จริง
- **verify:** py_compile OK · `git diff --check` clean · runtime `chatbot/shopeechat/` diff = **0 ไฟล์** · ไม่มี HF/Mongo/network เหลือ (tripwires prove)

### ✅ Revised Phase 0 — Gold Replay Baseline & Failure Ownership Gate (2026-09-30) — เสร็จ รอ review · ไม่มี runtime change · ยังไม่ commit

- **งาน (user สั่ง):** สร้าง baseline/replay gate พิสูจน์ว่า chatbot พังตรง owner ใด ก่อนเริ่มแก้ architecture ใน Revised Phase 1 — ทำให้ known incidents "พังแบบอธิบายได้และทำซ้ำได้" เท่านั้น ไม่ต้องทำให้เขียว
- **baseline ก่อนแก้:** branch `feature-legacy-shopee-evidence-retrieval` HEAD=`ab1b853` (Phase 6) · uncommitted = rebaseline docs เดิม 3 ไฟล์ (historical plan status map, rebaseline plan ใหม่, log นี้) — ห้าม revert/stage รวม · **ไม่มี Phase 7 (old) diff ค้าง — old Task 7 superseded โดย rebaseline plan**
- **scope:** fixtures + replay test + gold join + evaluator reporting + token/web baseline — ทั้งหมดอยู่ใต้ `docs/test/` + log
- **files ที่อนุญาต:** `docs/test/fixtures/legacy_turn_incidents.jsonl` (สร้าง) · `docs/test/test_legacy_turn_incident_replay.py` (สร้าง) · `docs/test/gold_retrieval.jsonl` (แก้ตาม review join) · `docs/test/eval_retrieval.py` (แก้เฉพาะที่จำเป็น) · log นี้
- **files ที่ห้ามแตะ:** `chatbot/shopeechat/` ทุกไฟล์ runtime (app.py, llm.py, product_store.py, handoffs.py, warranty_flow.py, route_context.py, retrieval_* ทั้งหมด) · ChatAdminWeb · botworker · v2/v3 · prompts · runtime flags/config · `.env`/secrets · file 1 (frozen) · SRS_SSD.md (Phase 0 ไม่เปลี่ยน function — ถ้าจำเป็นต้องแก้ runtime ให้หยุดรายงาน)
- **known incidents (sources):** GitHub #26-#30 (จาก rebaseline incident map + 5F log — GitHub API unreachable ไม่มี gh/MCP auth) · 39-turn mistorethailand transcript (attachment c5a584d1 — Q6-Q10 subject drift, Q15-Q18 WPB100L UNLIST/link swap, Q22-Q39 claim/handoff state, Q12-Q13 PB200P positive) · AD1404T relation · Mi 17 aliases · multi-subtype `cable_only`/`c-to-c` vocab mismatch (Phase 5 closeout P8a) · availability 7 modes · sticker/noise · human-owned ticket
- **ผล gold join (82 review rows vs 103 gold):** approved 67 → `review_status=accepted` · rejected 15 → 12 มี correction เป็น `corrected` (expectations เดิมคงไว้ — note "corrected:" อยู่แล้ว) · 24 gold rows ไม่อยู่ใน review → `provisional` · review-only ids 3 (q132 + 2) ไม่ merge เข้า gold (ไม่มี original row) · ไม่มี dup/malformed/PII (scan phone/email/tracking clean; `conv-shp_*` 9 ids เก็บเป็น fixture id เท่านั้น) · sidecar `fixtures/gold_retrieval.review.json` 82 rows
- **fixture schema:** `legacy_turn_incidents.jsonl` 38 rows — 15 incident + 23 positive · levels: L1 profile/parse · L2 availability/selection · L3 multi-turn `chat()` boundary (fake Mongo collections real-shaped: float item_id, `model[].stock_info_v2.summary_info`, `tier_variation`, `item_status`, `short_link`; fake intent/LLM/handoff POST; deterministic)
- **incident gate:** `_gate(fx,fails,level)` — incident ที่ reproduce ใน `incident_levels` → xfail พร้อม owner+evidence · incident ที่หายไป → hard fail บังคับลบ flag · positive → assert ตรง
- **reproduction ที่ยืนยัน (9 xfail — deterministic):** `inc-ad1404t-relation` L1 (relation/cable type ไม่ถูก parse, owner=profile_or_slot_parse) · `tx-q08` price follow-up pair drift (llm [3002] ขาด 3003, conversation_subject) · `tx-q10` cert → llm input ว่าง (answer_context) · `tx-q15` UNLIST anchor หายจาก llm input (canonical_availability) · `tx-q18` link follow-up ดึง 3002/3003 ต้องห้ามเข้า llm (conversation_subject) · `tx-q22q25` claim name/phone ไม่ persist — turn1 โดน general warranty-policy กลืน (turn_action) · `tx-q12` PB200P (สินค้าที่ถามเอง 150W) หลุดจาก llm input ทั้งที่ charger/cable อื่นเข้า (compatibility_evidence) · `iss30-claim-plus-product` multi-intent → claim collect ไม่เริ่ม (turn_action) · `gold-q187` AC30 recall ว่างทั้งที่ docs อยู่ (source_recall)
- **positive/regression ผ่าน:** 33 pass — anchors, pair continuity, link follow-up, order lookup, warranty-question-vs-claim, post-handoff lock, noise/sticker, human-owned ticket, availability 6 modes (L2), selection quota, compat unknown≠negative, gold-q203/q204
- **focused suites:** 373 pytest pass (profile/slots/relations/hints/executor/pool/selection×2/evidence/availability×3/5F-anchor/link/cert-ctx/claim/handoff/spec/token/anger/validate/eval/anchor-compare/alias/code-extract/troubleshoot) + script suites: route_context ALL PASS, cert_standards 66/0, guards ALL PASS, general_qtype 27/27, qa_context 4/4, compat_mode 144/144 — `test_timeline_card_refresh` 7/8 (listing cover-image refresh fail = **pre-existing runtime gap** ไม่เกี่ยว Phase 0)
- **token/web baseline (measured, `shadow_replies` n=6611 read-only):** input tok p50=12,790 p95=35,279 (n=5,588) · output p50=161 p95=295 (n=4,749) · cost p50=$0.0041 p95=$0.0126 (n=6,611) · products/turn p50=1 p95=30 · handoff 774 (11.7%) · web_search_used=0 ใน sample · steps n=77 เท่านั้น · per-turn llm_calls ไม่มี field → **unavailable** · `SYSTEM_INSTRUCTION`=34,304 chars · `KB_SYSTEM_INSTRUCTION`=3,573 · `_LLM_CONTEXT_LIMIT` default=30 (range 10-50)
- **eval_retrieval.py:** เพิ่ม `--by-owner`/`--by-review-status` (reuse group metrics เดิม) + `handoff_policy_hit_rate` + `n_evidence_required` + dict-guard `_product_rows` (legacy result formats) — answer exact-string ไม่ใช่ score อยู่แล้ว · ไม่มี results file ที่ map gold ids (replay live เท่านั้นสร้างได้ — out of scope)
- **verify:** replay `33 passed, 18 skipped, 9 xfailed` · focused 373 pass · `py_compile` OK · `git diff --check` clean · runtime files changed = **0** · ยังไม่ stage/commit

### ✅ แยก historical plan กับ rebaseline roadmap หลัง Phase 5/6 incident audit (2026-09-30) — docs-only เสร็จ รอ review/commit

- **งาน:** อ่าน historical plan ทั้ง 3,457 บรรทัด, เทียบ implementation/commits จริง, issues #26-#30 และ transcript 39 เทิร์น แล้วแยกเอกสารเป็น historical plan ฉบับเต็มกับ rebaseline roadmap ฉบับใหม่
- **root cause ที่ยืนยัน:** grouped retrieval ถูก wire แบบ augmentation เข้า legacy KB/main merge หลาย boundary; action/subject/state/evidence schema ยังมีหลาย owner; Phase 5C/5F จึงเพิ่ม safety hotfix บน flow ที่ยังไม่รวมศูนย์ และ tests ส่วนใหญ่พิสูจน์ helper/mocked fixture มากกว่า multi-turn runtime กับ schema จริง
- **ข้อห้าม:** docs-only; ไม่แก้ runtime; ไม่เพิ่ม case-specific keyword/model/shop logic; ไม่เชื่อ issue suggestion โดยไม่ trace code; รักษา Phase 5 Closeout diff ที่ค้างอยู่; ไม่แตะ `.env`/secret/DB write
- **output:** เก็บ `2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md` ฉบับเต็มและเพิ่ม status map (`KEEP / PROVISIONAL / SUPERSEDED / NOT STARTED`); สร้าง `2026-09-30-legacy-shopee-unified-turn-evidence-retrieval-rebaseline-plan.md` แยกสำหรับทิศทางใหม่
- **ผล:** รายละเอียดเดิมไม่ถูกลบ; roadmap ใหม่จัด Revised Phase 0-10: baseline → turn owner → subject/claim state → canonical schema → source union → field evidence/compat → selector → context/token/web → answer boundary → workflow/handoff → cleanup/release
- **สถานะงานเดิม:** Task 1-4 และ grouped retrieval core = accepted foundation; Phase 5C/5F/Phase 6 = provisional ต้อง migrate+ลบ local rules; old Task 5/5A/6/7 interfaces = superseded ห้าม implement ตามชื่อเดิม
- **issue coverage:** map GitHub #26-#30 และ transcript Q6-Q10/Q15-Q18/Q22-Q39 ไปยัง owner phases; Q12-Q13 ถูก pin เป็น positive regression
- **confidence:** owner/sequence ระดับ architecture มีหลักฐานเพียงพอจาก code/callsites/issues/replay; interface และ scoring บางเฟสยัง provisional และต้องผ่าน Revised Phase 0 replay gate ก่อน freeze
- **verify docs:** historical plan 3,485 บรรทัด + rebaseline roadmap 484 บรรทัด · code fences สมดุล (200/14) · placeholder/status/link scan clean · `git diff --check` clean · diff มีเฉพาะ plan docs + active log ไม่มี runtime/test/env

### 🔍 Phase 5 Closeout Gate — audit + รายงานตัดสินใจ (2026-09-24) — audit-only ห้ามแก้ runtime/ห้าม commit

- **งาน (user สั่ง):** ตรวจจากโค้ด/flow/probe จริงว่า Phase 5 ปิดได้หรือยัง — status table ทุก sub-task (original Task 5 live refresh, original 5A source union, 5A planner, 5B1-5B3-D, 5C, 5D, 5E, 5F, Phase 6 multi-subtype) + gap original Task 5/5A vs grouped pipeline + runtime flow audit flag OFF/ON + probe ≥8 กลุ่ม + token/description audit + focused tests
- **กฎ:** ห้ามแก้ runtime ก่อน audit จบ · ห้าม commit จนรายงาน+อนุมัติ · ห้ามเชื่อ session history/comment อย่างเดียว · ห้าม hardcode product/model/shop · ห้ามแตะ v2/v3/ChatAdminWeb/botworker · ห้ามเพิ่ม helper/nested fn ใน app.py · ใช้ `.venv/bin/python` เท่านั้น · Mongo ผ่าน `load_dotenv()` เท่านั้น · Product DB read-only
- **output:** รายงานตัดสินใจ (ปิด Phase 5 ได้ไหม / ต้องมี Phase 5G ไหม / original Task 5/5A ยังต้องทำไหม / ไป Phase 7 ได้หรือยัง)
- **ผล audit (2026-09-24, code+probe จริง):**
  - **live flags:** `grouped_retrieval_shadow_enabled`=True (env) · `grouped_retrieval_selection_enabled`=True (DB `system_configs.main_config` — toggle ใน /config ทำงานจริง, TTL 5s)
  - **wiring จริง:** `_grouped_sel` compute ครั้งเดียวที่ app.py:~1868 (flag ON เท่านั้น, lazy import, exception→None→fallback legacy) → merge เข้า `merged_products` KB path (~2325) + `products` main path (~4726) — **augmentation ไม่ใช่ retrieval path ที่ 3**; `merge_selected_products` dedupe identity `item_id→unit_id→model_id` + cap `_llm_ctx_limit`(30)
  - **ไม่ wire:** item-tag early return (~1074, อยู่ก่อน profile สร้าง — by design), `web_search` LLM2 reanswer (web_search.py:969 — module แยก fetch เอง), chat_v2 (out of scope)
  - **original Task 5/5A:** helper ทุกตัว (`normalize_shopee_id`, `refresh_candidate_availability`, `_refresh_cards_from_docs`, `_merge_candidate_sources`, `candidate-mode`, `bounded_union`) **ไม่มีใน code — มีแค่ใน plan doc**; `eval_retrieval.py` ไม่มี `--candidate-mode`; unit early-return ใน `fetch_products` (product_store:3120) ยังอยู่แต่ dormant เพราะ `USE_UNIT_INDEX` unset; grouped pipeline supersede ที่ executor (units+legacy ต่อ request) + `candidate_pool.build_candidate_pool` (cross-source dedupe/union) — ยกเว้น `requested_variant_status`/`has_other_sellable_variants` annotation ที่ไม่มีทดแทน
  - **probe flag OFF vs ON (Mongo จริง, shop=ZMIThailand, ไม่ยิง LLM):**
    - P1 AD1404T relation: OFF=30 adapter ไม่มีสายเลย (bug เดิม) · ON=req-0 adapter 3 subject + req-1 relation_target cable 3 ตัว hits=(display,length_m,speed) — **PASS**
    - P2 compare AC65B/AC65B2: OFF=คู่จริงปนกับของไม่เกี่ยว · ON=4 subject (sellable + unavailable_subject:normal_zero_stock label ชัด) + hidden_mentions=1 (ZMI AC65B UNLIST) + extra_context note — **PASS**
    - P3 follow-up "แนะนำอันไหน 2 อันนี้": profile resolve types=phone (current ชนะ anchor) → grouped selected เหลือน้อย แต่ merge กับ base products อยู่ดี (augmentation) — **PASS+ข้อควรระวัง** (probe ไม่มี conversation_products timeline จริง)
    - P4 "ราคาเท่าไหร่": anchor carry ทำงาน codes/types จาก anchor — **PASS**
    - P5 WPB100L xiaomi: ON promote WPB100L เป็น subject `unavailable_subject:normal_zero_stock` + 3 alternatives + note ห้ามบอกว่าซื้อได้ — **PASS**
    - P6 link follow-up: `_prepare_link_followup` ตัด short_link ของ UNLIST anchor + note "ยังไม่เปิดขาย ห้ามส่งลิงค์" (keep=True เพราะมี note) — **PASS**
    - P7 "รุ่นไหนมี มอก. บ้าง": subtype carry adapter จาก history ทั้ง OFF/ON — **PASS** (cert evidence คุณภาพอยู่ที่ data/KB ไม่ใช่ retrieval)
    - P8a multi-subtype หัวชาร์จ+สายชาร์จ: **พบ gap จริง** — elig มี cable_only=12 + adapter=8 แต่ selected 3 ตัวเป็น adapter ล้วน เพราะ coverage check เทียบ `card subtype in req.subtypes` โดยตรง: request ใช้ vocab `cable` แต่ unit doc ใช้ `charger_subtype=cable_only`/`cable_subtype=c-to-c` → coverage (ab1b853) ไม่ fire; base merge ยังพก cable อยู่จึงไม่หายจาก context แต่ selected priority ผิด — **FAIL ระดับ quality (Phase 6 scope)**
    - P8b เคส+ฟิล์ม: 2 requests quota แยก, film 0 eligible (device_mismatch ถูกต้อง) — **PASS**
    - claim/handoff: `หัวชาร์จ a18t ใช้งานไม่ได้`/`ชาร์จช้ามากขอเคลม`/`เสียงไม่ชัด`/`สินค้าเสีย`/`ช้ามากไหมคะ` → ไม่ fire anger ✓; `ร้านไม่ตอบเลยโว้ย`/`ผิดหวังมาก` → customer_frustration ✓; `เฮ้ย รับคอมมิชชั่น` → promo guard ✓; `ขอคุยกับแอดมิน` → human_request ✓; `malfunction_safe_check`+`detect_claim_request` ทำงาน — **PASS**
  - **token audit:** `_LLM_CONTEXT_LIMIT=30` · `SYSTEM_INSTRUCTION` 34,304 chars · `description_excerpt` ≤3,000 chars/ใบ (`_clean_description` กรอง section ตามคำถาม) · `include_desc` = `intent.needs_description`(≥0.7) OR `desc_kw` (list กว้าง — เกือบทุก spec-ish คำถาม match) → ส่ง description เฉพาะ spec/warranty/compare/detail ไม่ใช่ทุกคำถาม · worst case ≈ 30×3,000 chars descriptions + 34k chars system · `web_search` LLM2 reanswer = llm.answer ครั้งที่ 2 เต็ม (system ซ้ำ) · **พบ dead code:** `merged_context` app.py:2301 build context ด้วย include_description=True แต่ไม่เคยถูกส่ง (CPU waste ไม่ใช่ token)
  - **tests:** 226 focused tests PASS · py_compile 13 ไฟล์ OK · `git status` clean ก่อน audit (มีเฉพาะ waythrough entry นี้แตะ)
  - **verdict ในรายงาน:** Phase 5 ปิดได้แบบมีเงื่อนไข — gap ที่พบ (P8a subtype vocab mismatch, requested_variant annotation, dead merged_context, merge boundaries 3 จุดใน app.py) จัดเป็น Phase 5G-lite หรือ Phase 6 follow-up ไม่ใช่ blocker

### ✅ อัปเดต master retrieval plan หลัง 5F — reality/deviation/complexity gate (2026-09-24) — docs-only

- **เหตุผล:** user ชี้ถูกว่าแผนเดิม drift จาก implementation จริงและ helper เริ่ม implicit/nested มากขึ้น โดยเฉพาะ grouped retrieval prototype + 5F routing hotfix ที่อยู่นอกแผน retrieval เดิม
- **แก้ไฟล์:** `docs/plans/2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md` เท่านั้น
- **เพิ่ม:** Current Implementation Reality Check, Deviation Audit, Complexity Gate, Task 5F Pre-Retrieval Safety Hotfix Gate, และ Task 13 simplification/owner-map gate
- **สรุป:** 5F เป็น legacy hotfix ที่ commit ได้เพื่อกัน production bug แต่ไม่ใช่ root architecture; Task 11 ยังต้องทำ message/action route owner; Task 13 กลายเป็น mandatory cleanup ก่อน release
- **verify:** `git diff --check` ผ่าน · ไม่มี runtime code change

### 🧪 เทส anger/human-request regression set จาก user (2026-09-24) — test-only ยังไม่แก้โค้ด

- **งาน:** รันเคสใน `~/Downloads/test_anger_detection_regression.py` (issue #26, ข้อความ shopee จริง 90 วัน + QA รอบ 5) กับ logic จริงใน `handoffs.py` — ไฟล์ที่ user ส่ง embed logic **เก่า** (flat substring "กาก") ในตัว ไม่ตรงกับโค้ดปัจจุบันที่มี `_toxic_token_present` (5F-A) แล้ว → ต้องรันเคสเดียวกันกับ `detect_human_request` จริง
- **วิธี:** runner ชั่วคราว import case lists จากไฟล์ user + เรียก `detect_human_request` ตรงๆ (conversation_id=None) — read-only ไม่แตะ prod
- **ผล (2026-09-24):** embedded stale copy 11/32 · **โค้ดจริง 21/32** — MUST_ESCALATE 9/9 ผ่าน, substring กาก 10/10 ผ่าน (5F-A ทำงาน) · ล้มเหลว 11 เคสล้วน FP:
  - อาการสินค้า 8: `ช้ามาก/ช้าจัง` ในบริบทชาร์จ (3), `ไม่มีการตอบ` ⊂ "ไม่มีการตอบสนอง" ปุ่ม/เครื่อง (2), `นานมาก` วัดระยะเวลาสินค้า (3)
  - greeting ร้าน 1: "ตอบช้าหน่อย" ใน auto-greeting ที่ถูกเก็บเป็น inbound
  - affiliate spam 1: "เฮ้ย" strong marker ใน "เฮ้ย <shopname>!รับคอมมิชชั่น..."
  - คำถาม+vocative 1: "รอนานไหมครับแอด" — QGUARD ไม่รับ "แอด" ท้ายประโยค + bare-แอด rule (≤15 ตัวอักษร) ยิง human_request
- **root cause รวม:** mild markers วัด "ความช้า/ไม่ตอบ" แบบไม่แยกบริบท — ของบริการร้าน (ตอบแชท/ส่งของ) vs อาการสินค้า (ชาร์จช้า/ปุ่มไม่ตอบสนอง/หมุนนาน)
- **สถานะ:** แก้แล้วใน Task 5F-R (Message Routing Before Retrieval) — ดู entry ท้ายไฟล์; probe battery 32/32 PASS

### 🔍 Audit live chat failures จาก transcript KingGadgets (2026-09-24) — audit-only ห้ามแก้โค้ด

- **เคส:** (A) Q6 AC65B เทียบ AC65B2 → บอทบอกไม่พร้อมจำหน่าย (listing SELLER_DELETE/UNLIST แต่ variant ปน AD653C/AD652S sellable) · (B) Q15/Q17/Q18 WPB100L — Q15 บอกใช้ได้+ลิงก์, Q17 บอกไม่พร้อมจำหน่าย, Q18 ลิงก์หลุดเป็น AD653C/AD653T/AD1003T (listing UNLIST แต่ sellable_units บาง variant sellable=True) · (C) Q10 "รุ่นไหนมี มอก. บ้าง" → ตอบกว้างทั้งร้าน ไม่ filter subtype/context ไม่บอก availability
- **วิธี:** probe Mongo จริง (ShpProducts/sellable_units/conversation_products/image_texts) + trace fetch_products/handoffs cert path/anchor resolve + runtime flags — read-only เท่านั้น
- **output:** report 4 ส่วน (Facts / Flow trace / Root cause / Recommended fixes) — ห้าม hardcode per-case

### ✅ คัดลอก log ไม่ได้ทั้ง 2 ปุ่ม (ราย log + กอปทั้งหมด) หน้า testchat (2026-09-23) — fixed + tsc ผ่าน

- **error:** `formatLogForCopy` crash `s.cost_usd.toFixed` on undefined → handler ตายก่อนถึง clipboard → กดปุ่มไหนก็ไม่ได้
- **เกิดเพราะ:** debug step ใหม่ `RetrievalProfile`/`GroupedRetrievalShadow` (Task 4B/5B) ไม่มี model/tokens/time_s/cost fields — formatter เรียก `.toFixed` ตรงๆ
- **วิธีแก้:** guard `?? "—"`/`?.toFixed` ตาม pattern line 131 + UI render (?? 0) — TestChatClient.tsx:160-161
- **verify:** `tsc --noEmit` ผ่าน; step ปกติ output เดิม · debug step แสดง "—" + input/output (ข้อมูลจริงของมัน)

### ✅ อัปเดต master retrieval plan: 4E multi-slot + handoff/workflow audit (2026-09-23) — docs-only เสร็จ

- **ขอบเขต:** แก้เฉพาะ `docs/plans/2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md` เพื่อเพิ่มสิ่งที่คุยกันหลัง Task 4D: multi-product/multi-slot retrieval, handoff admin eligibility, และ trigger/workflow audit
- **ห้าม:** ยังไม่แก้ runtime code, ไม่แตะ ChatAdminWeb/botworker/v2/v3, ไม่เริ่ม Task 4E implementation จริง
- **เหตุผล:** profile แบนตัวเดียวเสี่ยงปน constraint เมื่อคำถามมีหลายสินค้า; old admin first ต้องผ่าน eligibility; workflow/trigger ต้องถูก audit ว่าไม่ตอบทับ human handoff และไม่ fake handoff
- **เพิ่มใน plan:** Global constraints/review focus/target flow/file structure/interface เพิ่ม `RetrievalSlot`; เพิ่ม Task 4E, Task 11A, Task 11B; final replay gate และ self-review รู้จัก test ใหม่
- **เพิ่มหลัง user ถาม trigger:** Task 11B ต้อง audit trigger match mode ชัดเจน (`exact`, `contains`, `keyword-any/all`, `regex`, `fuzzy`, `semantic`) และระบุว่า exact-only เช่น "สวัสดีมินเนี่ยน" จะไม่ hit "ดีจ้ามินเนี่ยน" เว้นแต่ trigger นั้นตั้ง mode ที่เหมาะสม
- **verify:** `git diff --check` ผ่าน; markdown code fence count 168 เป็นเลขคู่

### ✅ หัวข้อ "ทดสอบบอท" มองไม่เห็นบน laptop (2026-09-22) — fixed root cause + verified

- **error:** h1 "ทดสอบบอท — {label}" หน้า testchat มองไม่เห็น **เฉพาะจอ ≥1280px (xl)** — จอเล็กเห็นปกติ
- **เกิดเพราะ:** `--color-base: #ffffff` ใน `@theme` (globals.css) ชนกับ utility `text-base` (font-size) ของ Tailwind → `.text-base` ถูก gen เป็น **color ขาว** แทน font-size (font-size หายไปเลย) → `xl:text-base` บน h1 ทำตัวขาวบนพื้นขาวตอน ≥1280px; `.text-text`/`.text-brand` แพ้เพราะ rule ใน media query มาทีหลังใน cascade
- **แก้ด้วย:** ลบ `--color-base` ออกจาก @theme (ซ้ำ `--color-bg`/`--color-surface` ขาวเหมือนกัน) + `bg-base`→`bg-surface` 11 จุด (shop-settings/persona/test-results — สีขาวเดียวกัน หน้าตาไม่เปลี่ยน) + h1 คง `text-brand` (#8b1e28 maroon ตามที่ user ขอ)
- **verify:** compiled CSS จาก dev server — `.text-base`/`.xl:text-base` กลับเป็น `font-size: var(--text-base)` แล้ว ไม่มี color ขาว; reproduce ด้วย Playwright+CSS จริงพิสูจน์ก่อนแก้ว่า h1 = rgb(255,255,255) ที่ 1440px
- **ผลกระทบเคสอื่น (แก้ latent bug ด้วย):** ทุก `sm:/xl:text-base` เคยเป็นตัวขาวที่ breakpoint นั้น (เช่น `text-sm sm:text-base` ขาวตั้งแต่ 640px) · `text-base` ~20 จุดได้ font-size 1rem กลับมา (render เดิม 16px เท่ากัน → หน้าตาไม่เปลี่ยน) · `bg-base`→`bg-surface` สีเดียวกัน

### ✅ ShadowStatPanel "All History" ใช้งานไม่ได้ (2026-09-22) — fixed + verified → ย้ายไป "ผ่านแล้ว"

### 🔄 botworker history ขาด workflow replies (2026-09-22) — รออนุญาตแก้

- **อาการ:** `getGroupedHistoryForBot` (messageService.ts) เลือกคำตอบบอทจาก `shadow_replies` (origin worker/workflow) แต่ lookup ด้วย `inbound_message_id` ดิบ — `storeWorkflowDelivered` (botWorkerService.ts:168) เขียนเป็น `{msgId}__wf{i}` เพื่อเลี่ยง unique index → workflow answers ไม่เคยเข้า history (fallback Zaapi ผิด design "คำตอบบอทเราชนะ")
- **user confirm intent:** คำตอบจาก workflow/trigger/vision ทุก path ต้องเข้า botworker history
- **แพลน (เสนอ user):** strip suffix `__wf\d+$` ตอนสร้าง `botReplyByInboundId` + รวมหลาย delivered ต่อ inbound (ตามลำดับ suffix) เป็น model text เดียว — ไม่แตะ schema/ข้อมูลเก่า
- **ผลกระทบ:** เฉพาะ history pairing ของ workflow replies · trigger/bot/vision path ใช้ id ดิบอยู่แล้วไม่เปลี่ยน

### ✅ GitHub issue #19: LLM พิมพ์ `||` แทน `|||` → การ์ดสินค้าติดในฟองข้อความ (2026-09-21) — fixed + verified → ย้ายไป "ผ่านแล้ว"

### ✅ Legacy Shopee retrieval redesign master plan (2026-09-21) — plan เสร็จ + self-review ผ่าน

- **งาน:** ออกแบบ implementation plan สำหรับ legacy Shopee chatbot เท่านั้น — ลด hardcode, รวม unit+legacy เป็น candidate pipeline เดียว, ทำ retrieval profile/ranker กลาง, ต่อจาก Plan 1 rev 1.2 โดยยังไม่แก้ runtime code
- **เพิ่มรอบนี้:** กำหนด `RetrievalProfile` owner เดียวที่ `route_context` (intent เป็น proposal ไม่ใช่ final owner), precedence จาก current message→anchor→intent→bounded history, ส่ง profile object เดียวให้ทุก legacy product retrieval/re-query, และเพิ่ม Mi 17 Ultra false no-product/out-of-stock gate
- **ขอบเขต:** แผน 14 tasks เริ่ม measurement/gold gate → profile/availability/evidence/selection → compat negative-proof → cleanup/replay; ไม่แตะ v2/v3 หรือ product code
- **ไฟล์:** `docs/plans/2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md`
- **verify:** 2,121 lines หลัง ponytail review · ตัด field/key/report ที่ไม่มี consumer · ใช้ dedupe key เดียว · ระบุ gold drafter/private-metadata boundary ครบ · placeholder/duplicate-owner scan clean · `git diff --check` ผ่าน

### ✅ Legacy retrieval Task 1: measurement + human gold gate (2026-09-22) — release gate ผ่าน

- **งาน:** สร้าง offline evaluator, gold validator/drafter, review UI และ final gold set จาก replay + human review บน branch `feature-legacy-shopee-evidence-retrieval`
- **ทำแล้ว:** `validate_gold_retrieval.py` + `eval_retrieval.py` + `draft_gold_retrieval.py` + tests ครบ; draft `gold_retrieval.draft.jsonl` 82 rows; `gold_review.html` + `gold_retrieval.draft.js` (approve/reject + correction form + image cards)
- **human review:** `gold_retrieval.review (3).json` = approved 67 / rejected 15 / pending 0; rejected ทุก row มี correct_answer
- **promoted corrections:** 12/15 rejected promote เข้า gold ด้วย `CORRECTED` map (item IDs จาก catalog lookup จริง) — Mi17, iPhone13-CTL, q005/q007/q079/q184/q187/q203/q204/q245/q047/q051; exclude q132 (correction ไม่ชัด) + test_200-063/064 (infra 429)
- **gap fill:** gold สุดท้าย **103 rows** — history 12 (10 conv-derived + Mi17 + old-order), out_of_stock 3 (Hagibis stock_info=0 verified), unlisted/discontinued 3+1, refund 3, tax_invoice 5, real handoff 15, old_order_item 1, Mi17 follow-up 1; `must_not_phrases` ครบทุก negative/sensitive row (substring-safe เท่านั้น)
- **validator:** เพิ่ม `validate_gaps` — quota 8 ข้อ + บังคับ must_not_phrases ใน negative modes/sensitive intents; CLI ตรวจ rows+gaps
- **eval fix:** `_record_answer_mode` รู้จัก policy sources (`return_refund_ask_order`, `cert_answer`, `warranty_claim_first_message`) สอดคล้อง draft inference — "ขอเลขออเดอร์" ไม่ถูกนับเป็น recommend อีก
- **baseline (freeze):** `unit_reg_questions_2026-09-18.jsonl` → n=300, products=177, listing_diversity=0.810, dup_pool_rate=0.492, live_ratio_top5=0.818, unit_share=0.393, fallback_rate=0.050, avg_pool=7.847 · gold metrics n_gold=72 → type_purity=0.237, acceptable_hit=0.200, must_not_violation=1.000 (q184/q005 wrong items ใน pool = bug จริง), phrase_violation=0.182 (q203/q204/q245/q300 false claims), answer_mode=0.917 (mismatch 6/72 ล้วน bug จริงจาก review)
- **verify:** tests 19/19 ผ่าน · validator ผ่านทั้ง schema+gap · ยังไม่แตะ runtime code — **Task 1 จบ พร้อมเริ่ม Task 2 availability resolver หลังอนุมัติ**

### ✅ ทบทวนและแก้ master implementation plan จากโค้ด/ข้อมูลปัจจุบัน (2026-09-22) — plan review เสร็จ

- **ขอบเขต:** แก้เฉพาะ `docs/plans/2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md`; ยังไม่แก้ runtime code
- **หลักฐานโค้ดที่ตรวจใหม่:** callsite `fetch_products`/compat/web/KB ทั้งหมด, ลำดับ KB กับ conversation anchor ใน `app.py`, unit early-return ใน `product_store`, full-model/card truncation, order item fallback ใน `order_flow`, และ tracking lookup ใน `order_store`
- **หลักฐาน collection จริง:** อ่านแบบ read-only ผ่าน `load_dotenv` ครบ `ShpProducts`, `ShpOrders`, `itStock.Products`, `knowledge_base`, `kb_products`, `kb_qa`, `kb_raw`, `image_texts`, `sellable_units`, `conversation_products`; ไม่พิมพ์ secret/PII และไม่เขียน DB
- **ข้อค้นพบหลัก:** tracking จริงอยู่ top-level แต่โค้ดค้น nested package; ID ข้าม collection เป็น float/int/string ต้อง normalize; unit model stale 47 refs; OCR ครอบคลุม image id 19.23%; order เก่าบางรายการไม่อยู่ catalog ปัจจุบัน; `seller_stock` กับ summary ตรงกันด้าน zero/positive แต่ต่างจำนวน 62 units จึงต้อง reuse `_shopee_stock`; approved gold 67 rows ยังไม่มี history/Mi17/must-not coverage ที่พอ
- **แก้แผน:** เพิ่ม gold gap gate, full-live candidate refresh, bounded unit+legacy source union ก่อน selection, immutable profile ก่อน KB/product fetch, normalized item-id-first KB merge, shop-scoped order lookup, compatibility negative-proof, รายการ duplicate logic ที่ต้องลบ และ final replay gate
- **refine หลัง user review:** availability resolver ต้องถือ `stock_info_v2.summary_info.total_available_stock` เป็น stock truth ของ variant/model; fallback ไป `shopee_stock`/`seller_stock` เฉพาะเมื่อ summary field หายหรืออ่านไม่ได้เท่านั้น ไม่ใช่เมื่อ summary มีค่า `0`; เพิ่ม test case ใน plan กัน regression summary=0 แล้วหลุดไป fallback
- **ไม่เพิ่ม abstraction เกินจำเป็น:** ตัดข้อเสนอ `order_items_to_anchor_cards()` ที่ไม่มีจริง; ใช้ minimal-card fallback เดิมใน `order_flow`; ไม่สร้าง stock formula/ID normalizer/pipeline order ซ้ำ
- **verify เอกสาร/ฐานวัด:** stale-name scan clean, task headings ครบ Task 1-14 + Task 5A recall subtask, code fences 140 จุดสมดุล, `git diff --check` ผ่าน; evaluator/drafter/gold-validator tests 13/13 ผ่าน และ approved gold validator ผ่าน; ยังไม่แตะ runtime code

### ✅ Master plan Task 2: availability single owner (2026-09-22) — implement + verified รออนุมัติ commit

- **error:** สินค้าที่มีของจริงถูกตอบ "ไม่มีสินค้า/หมดสต็อก" (Mi17 case จาก review) · summary `total_available_stock=0` ไหลไป fallback ได้ · availability semantics กระจายหลายจุดต่างกันเงียบๆ
- **root cause:** `_shopee_stock()` ใช้ `if total_available` (truthiness) → summary=0 ถูกมองเป็น missing → fallback `shopee_stock[]` เอาค่าอื่นมาทับ fact "หมด"; สูตร sellable ซ้ำใน `_doc_sellable` / `to_product_card` / `units._live_sellable` / `app.py` recompute (`_available_for_sale`) / `_doc_stock_total` — ไม่มี owner เดียว
- **fix plan (ตาม plan §Task 2):** แก้ `_shopee_stock` ให้แยก "field มีค่า" vs "ค่าเป็นตัวเลข" (summary→shopee_stock→seller_stock chain; 0 คือ fact) · เพิ่ม `_stock_info_has_any_stock_source()` + `resolve_availability()` เป็น owner เดียวคืน `{catalog_status, available_for_sale, answerable, reason, total_stock}` · wire เฉพาะ duplicated formulas · ห้ามแตะ v2/v3, ห้ามสร้าง `_stock_from_model()`
- **กระทบเคสอื่น (impact analysis):**
  - summary=0 แต่ shopee/seller>0 → out_of_stock (เดิม active ผิด — bug ที่ต้องแก้)
  - ไม่มี stock source อ่านได้ → `active_unknown_stock` + answerable (เดิม sold_out ผิด)
  - unit ที่ model_id หายจาก live listing → `model_missing` ไม่ใช่ sold-out ทั้ง listing
  - `build_sellable_units.py` ได้ semantics ใหม่ผ่าน `_shopee_stock` อัตโนมัติ
  - `item_status:"NORMAL"` mongo query filters + LLM prompt notes ไม่แตะ — ไม่ใช่ stock formula
- **TDD:** `docs/test/test_availability.py` + `test_availability_wiring.py` ก่อนแก้ runtime — RED ยืนยัน (AttributeError resolver + `assert 99 == 0` พิสูจน์ bug)
- **วิธีแก้ (implement แล้ว):**
  - `_stock_info_has_any_stock_source()` — แยก "มี source อ่านได้" (numeric check; seller เฉพาะ if_saleable!=False) ออกจาก "อ่านได้ 0"
  - `_shopee_stock()` — แก้ `if total_available` → `isinstance(total_available, (int,float))`: summary=0 คืน 0 ทันที ไม่ไหลไป fallback; chain summary→shopee_stock→saleable seller_stock→0
  - `resolve_availability(card_or_doc, *, model_doc=None)` — owner เดียวคืน `{catalog_status, available_for_sale, answerable, reason, total_stock}`; doc มี model[] รวมเฉพาะ MODEL_NORMAL; card input fallback ไป total_stock/stock เฉพาะเมื่อไม่ส่ง model_doc
  - wiring: `_doc_sellable`/`_doc_stock_total`/`to_product_card` (resolve จาก model เต็มก่อนตัด variants[:20]; card เพิ่ม `catalog_status`, `sold_out`=out_of_stock เท่านั้น, `total_stock` int|None) · `units._live_availability` คืน (status, availability, model_status) + model หาย→`model_missing`/unlisted · `units._live_sellable`/`to_unit_card` (เพิ่ม `catalog_status`+`availability_reason`) · `app.py` recompute ใช้ resolver + setdefault catalog_status; `_has_unlist`/`_has_sold_out` อ่าน catalog_status
- **verify:** pytest `test_availability.py`+`test_availability_wiring.py` = **32/32 ผ่าน**; gold suite 19/19 ผ่าน; `py_compile` 3 ไฟล์ OK; `git diff --check` OK; `test_unit_card_fields`/`test_route_context`/`test_guards`/`test_timeline_card_refresh` ผ่าน (แก้ stale assert EC4==10→>0 — fail บน HEAD เดิมด้วย); `test_sellable_units` fail เดิมจากนับ stale 26970≠27807 (ไม่เกี่ยว)
- **real-data sanity (export 11,692 docs):** NORMAL→active 2096 / out_of_stock 1264, UNLIST→unlisted 7089, *DELETE+BANNED→discontinued 1203, REVIEWING→unknown 40; ทุก model มี numeric summary → fallback path ไม่ fire → **behavior change ≈0 บนข้อมูลปัจจุบัน**, fix กัน data shape ที่ summary=0/หาย
- **ไม่แตะ:** v2/v3 ทั้งหมด · `item_status:"NORMAL"` mongo query filters · LLM prompt notes · `_stock_from_model()` ไม่ได้สร้าง

### ✅ Master plan Task 3: evidence card contract (2026-09-22) — implement + verified รออนุมัติ commit

- **งาน:** สร้าง `chatbot/shopeechat/retrieval_policy.py` — contract กลาง `_evidence`/`_selection_reason` บน product cards (observe-only)
- **ทำไม:** cards มาจากหลายแหล่ง (product_store/units/KB/anchor/order/compat/web) แต่ไม่มีภาษาเดียวกันบอกว่ามาจากไหน·หลักฐานอะไร·ถูกเลือกเพราะอะไร — Task 6/8/10 ต้องใช้ต่อ
- **spec (user):** `make_evidence_card(product, *, source, evidence=None, selection_reason=None)` — ไม่ mutate, merge `_evidence.sources` ไม่ซ้ำ, preserve existing `_evidence`, normalize item_id/model_id→str (float→int-str ตาม audit), set `_selection_reason`; `strip_private_evidence(product)` — ลบทั้ง 2 keys, ไม่ mutate (รองรับ list ด้วยสำหรับ response boundary ใน Task 8)
- **ห้าม:** เปลี่ยน ranking/retrieval/prompt/จำนวน products · หลุด `_evidence`/`_selection_reason` ใน public response · แตะ v2/v3 · สร้าง ranker
- **TDD:** `docs/test/test_retrieval_evidence.py` ก่อนสร้าง module — **ยังไม่ wire app.py** (observe-only, Task 8 ค่อย wire strip ที่ boundary)
- **implement (แล้ว):** `retrieval_policy.py` — `make_evidence_card` (copy, merge sources dedup, `_norm_id` float→int-str, facts merge, `_selection_reason`) + `strip_private_evidence` (card หรือ list) + `PRIVATE_KEYS`; ไม่ import heavy modules/app
- **verify:** `test_retrieval_evidence.py` **14/14 ผ่าน** (RED ยืนยัน ImportError ก่อน) · availability+gold suite 51/51 ผ่าน · py_compile 4 ไฟล์ OK · `git diff --check` OK
- **behavior change:** ไม่มี — ไฟล์ใหม่เท่านั้น ไม่ wire app.py (observe-only ตาม plan; Task 8 wire strip ที่ response boundary)
- **impact:** ไฟล์ใหม่เท่านั้น — zero behavior change by construction; SRS เพิ่ม §6.27

### ✅ Master plan Task 4A: RetrievalProfile owner กลางของ request facts (2026-09-22) — implement + verified รออนุมัติ commit

- **งาน:** เพิ่ม `@dataclass(frozen=True) RetrievalProfile` + `build_retrieval_profile()` ใน `route_context.py` — โจทย์กลางก่อนดึงสินค้า (contract-only, **ยังไม่ wire app.py/flow**)
- **ทำไม:** ตอนนี้ facts (type/subtype/device/model/shop) ถูก re-derive ซ้ำหลายจุดจาก message/intent/history คนละวิธี → Mi17 bug: "ที่ใช้กับ mi 17 ultra" หลังถามสายชาร์จ ถูกสกัดเป็น phone แทน charger+cable — ถ้า profile ผิดตั้งแต่ต้น rank ดีแค่ไหนก็ดึงของผิด
- **spec (user):** precedence ต่อ field — shop/platform=arg เท่านั้น · product_types: current→anchor→intent(≥0.7)→bounded history · subtype: strong current→anchor→intent(≥0.7)→history→weak current · model_codes: current→anchor→history(follow-up) · target_device: current→intent→history(compat follow-up เท่านั้น) · availability/compat_mode: deterministic mapping เท่านั้น · history อ่าน user ใหม่สุด ≤4, ไม่ concatenate · intent = proposal ไม่ใช่ truth
- **reuse:** `_detect_product_types`/`_detect_charger_subtype`/`_extract_device_token`/`_extract_codes` ผ่าน lazy import — ห้าม copy regex table · move `_COMPARISON_FOLLOWUP_KW`/`_SUPERLATIVE_KW`/`_SINGLE_ITEM_REF_KW` จาก app.py มา route_context (app.py alias กลับ — ไม่เปลี่ยน flow, plan กำหนดให้ owner คือ route_context, Task 9 ลบ consumers ที่เหลือ)
- **ห้าม (4A):** ย้าย app.py flow ก่อน KB · pass profile เข้า product_store/units/KB/device_compat/web_search · เปลี่ยน ranking/retrieval/selection · hardcode Mi17 case-by-case · แตะ v2/v3
- **TDD:** `docs/test/test_retrieval_profile.py` ก่อน — RED ยืนยัน AttributeError → GREEN 15/15
- **implement (แล้ว):** `route_context.py` — `RetrievalProfile` (frozen) + `build_retrieval_profile` + helpers `_bounded_history_facts`/`_variant_terms`/`_resolved_intent`/`_availability_mode`/`_compat_mode`/`_subtype_explicit`/`_id_str` + `_INTENT_MAP`; model-code token ≠ device (เช่น HA835 → code ไม่ใช่ target_device); subtype ⇒ charger family merge
- **app.py:** เพิ่ม `route_context as _rc` ใน import + alias constants 3 ตัวกลับ — **ไม่มี flow/logic เปลี่ยน** (tuple เดิมทุกประการ)
- **verify:** profile **15/15** · suite รวม (evidence+availability+gold) **80/80** · py_compile 5 ไฟล์ OK · `git diff --check` OK · app import OK · script regressions: route_context ALL PASS / car_charger 16/16 / subtype parity 42/42 / guards / unit_card_fields ผ่าน
- **verify กับ MongoDB จริง:** `docs/test/test_retrieval_profile_db.py` (load_dotenv→get_client) **17/17** — KingGadgets มี cable sellable จริง 56 รายการ (พิสูจน์ "ไม่มีสินค้า" เป็น false ตั้งแต่ profile) · real anchor cards → compare + float item_id → int-str ถูก · real model code (W01) → answerable_all + ไม่ถูกนับเป็น device

### ✅ Master plan Task 4B: build profile once ใน app.py ก่อน KB (2026-09-22) — implement + verified รออนุมัติ commit

- **งาน:** `app.py` — resolve conversation active ครั้งเดียวก่อน `lookup_kb` + สร้าง `_retrieval_profile` หลัง intent/anchor blocks (observe-only เท่านั้น)
- **ทำไม:** เดิม CONV-ACTIVE เรียก `resolve_active_by_message` หลัง KB (~2547) → KB/product fetch ไม่มีโจทย์กลาง; Mi17 follow-up ขาด charger+cable+device facts ตอนดึงสินค้า
- **จุดวาง:** ก่อน `ขั้นที่ 1: lookup_kb` — หลัง warranty/general/brand early-returns (ข้าม wasted read บน path ที่ไม่ดึงสินค้า) แต่ก่อน candidate fetch แรก
- **hoist:** `resolve_active_by_message` + `_cur_model_kw` computation → `_conv_active_card`/`_conv_model_kw` — pure read, timeline ไม่มี write คั่น (add_product อยู่ 921/1076 ก่อน intent, 4760 หลังตอบ) → CONV-ACTIVE reuse ผลเดิม · **resolver ยังถูกเรียกครั้งเดียว**
- **anchor collect:** `anchor_card`(tagged) + `_hybrid_anchor_card` + `_conv_active_card` + `_anchor_compare_ctx` current/previous (dedupe)
- **debug:** เพิ่ม `route_context.profile_debug()` → append step "RetrievalProfile" เข้า `_steps` (facts เท่านั้น ไม่ใส่ history dump)
- **equivalence proof:** `_cur_model_kw` ยัง define เฉพาะใน block (guard ที่ ~4063 ใช้ try/NameError เดิม) · subtype-mismatch/new-topic/compat guards ใน CONV-ACTIVE ไม่แตะ · LINK-FOLLOWUP order เดิม
- **TDD pins:** `profile_debug` shape + `build_retrieval_profile` อยู่ก่อน `lookup_kb` ใน source + `resolve_active_by_message` count==1
- **verify:** profile **18/18** · suite **83/83** · py_compile 5 ไฟล์ OK · app import OK · `git diff --check` OK · regressions: route_context / qtype guards 27/27 / timeline_card_refresh 8/8 (Mongo จริง) / guards / unit_card_fields ผ่าน
- **behavior change:** ไม่มี (observe-only) — profile ไม่ถูกใช้ filter/rank/select; ข้อยกเว้นเดียว: conv request ทุกอันมี timeline read เพิ่ม 1 ครั้งแม้ link-followup path (cost เล็ก ไม่เปลี่ยนคำตอบ)
- **ไม่แตะ:** v2/v3 · fetch_products signature · units/device_compat/web_search/knowledge_base · ranking/selection/prompt · ยังไม่ทำ 4C/4D/5
- **behavior change:** ไม่มี — constants alias ค่าเดิม (profile wire เข้า `app.py` ใน Task 4B ด้านล่าง)
- **ไม่แตะ:** v2/v3 · fetch_products signature · units/device_compat/web_search/knowledge_base · ranking/selection/prompt · ไม่มี hardcode Mi17 case-by-case

### ✅ Master plan Task 4C: wire profile ผ่าน gateways (2026-09-22) — implement + verified รออนุมัติ commit

- **งาน:** เพิ่ม `retrieval_profile: RetrievalProfile | None = None` (ท้ายสุด) ให้ `fetch_products`/`fetch_units`/`fetch_unit_cards`/`lookup_kb`/`qa_context`/`_device_spec_lookup`/`reanswer` + app.py ส่ง `_retrieval_profile` ทุก legacy callsite — **pass-through เท่านั้น ยังไม่เปิดสวิตช์**
- **callsite inventory (ก่อนแก้):** app.py: lookup_kb×2 (1858, 4190) · fetch_products×8 (1970, 1982, 3661, 3715, 3732, 3973, 4021, 4215) · _device_spec_lookup×2 (2186, 4486) · qa_context (4503) · reanswer×2 (2296, 4668) · product_store→units.fetch_unit_cards (3052) · device_compat→fetch_products (809, 879, 951) · web_search→fetch_products (786, 809) + lookup_kb (828) · **chat_v2/chatbotv3 ห้ามแตะ** (default None → เดิม)
- **ห้าม:** ใช้ profile filter/rank/select · source union · live refresh · แก้ signature แบบ break callers
- **ทำแล้ว:** TYPE_CHECKING import ทั้ง 5 ไฟล์ (device_compat เพิ่ม `from typing import`) · param ท้ายสุด default None · forwarding: fetch_products→fetch_unit_cards · fetch_unit_cards→fetch_units · _device_spec_lookup→fetch_products×3 · reanswer→fetch_products×2+lookup_kb · app.py `retrieval_profile=_retrieval_profile` ×15 callsite
- **TDD pins:** `test_retrieval_profile_wiring.py` ใหม่ 13 tests — signature+default None+last-param · fetch_unit_cards forward (monkeypatch fetch_units) · no `retrieval_profile.` attr-read ใน 5 gateways · internal forward ใน product_store/device_compat/web_search · app pass ≥15 · v2/v3 untouched
- **verify:** wiring 13/13 · suite **96/96** · py_compile 7 ไฟล์ OK · app import OK · diff --check OK · route_context/guards(27)/unit_card_fields ผ่าน
- **behavior:** ไม่เปลี่ยน — param ทั้งหมด default None, callee ไม่อ่าน field ใด (pin โดย test_profile_not_read_in_gateways); callers เดิม (chat_v2/chatbotv3) ไม่ส่ง param → เดิม 100%

### ✅ Master plan Task 4D: profile-aware retrieval hints (2026-09-23) — implement + verified รออนุมัติ commit

- **งาน:** เปิดใช้ `RetrievalProfile` ใน `fetch_products`/`fetch_units`/`fetch_unit_cards` แบบ conservative recall — profile=None → path เดิมเป๊ะ
- **fields ที่ใช้จริง (product_store.fetch_products):**
  - `product_types` → `exact_product_types` (override param > profile > detect; ว่าง→fuzzy เดิม)
  - `subtype` → subtype source `override > _prof_sub > detect` ทั้ง 5 จุด (shorthand boost + 4 filter sites)
  - `model_codes` → merge เข้า `aug_tokens`/`model_tokens`/`_raw_toks` + **supplement ใหม่**: bounded item_name regex หลัง subtype re-filter ก่อน `to_product_card` (code-hit ไม่โดน type/subtype narrowing — แก้ที่ regex path ไม่มี code recall เดิม aug_tokens อยู่เฉพาะ vector path)
  - `compat_mode != none` → `is_compat_check=True` (pool กว้าง + ข้าม unit index — เส้น web_search requery ที่ไม่ส่ง flag ได้ compat sweep ด้วย)
  - `availability_mode=answerable_all` → `filter_unavailable=False` (spec/compare/history เห็นของหมด/เลิกขาย); sellable_first มีอยู่แล้วใน `_rerank_by_promo_latest` (sellable เป็น sort key แรก)
  - unit gate: profile present → ไม่เรียก `resolve_route` ซ้ำ
- **units.py:** `fetch_units` types/subtype/codes จาก profile เมื่อมี (param > profile > route) · `fetch_unit_cards` skip resolve_route เมื่อมี profile
- **ไม่ใช้:** `target_device` (ยังไม่ inject เข้า query — message มีอยู่แล้ว; ไม่สรุป compat เอง) · `variant_terms` · `fact_sources` · `anchor_item_ids`
- **behavior change:** มีเจตนาเฉพาะ profile-backed calls (app.py เท่านั้น — v2/v3 ไม่ส่ง profile → เดิม 100%): Mi17 case ตอนนี้ query มี charger regex + cable filter แทน shop-only query
- **TDD pins (ใหม่ `test_retrieval_profile_hints.py` 10 tests):** profile types→query regex · None→legacy · subtype→cable filter · codes→bounded item_name regex · compat→skip unit index · answerable_all→sellable_only=False · units codes+skip-resolve · unit_cards skip-resolve · sellable_first pool ไม่ว่าง
- **แก้ 4C pin:** `test_profile_not_read_in_gateways` เหลือ knowledge_base/device_compat/web_search (4D ไม่แตะ behavior สามไฟล์นี้)
- **verify:** hints 10/10 · suite **106/106** · py_compile 7 ไฟล์ OK · diff --check OK · regressions: route_context/guards(27)/unit_card/car_charger(16)/subtype parity(42) ผ่าน
- **ไม่แตะ:** app.py (0 บรรทัด) · device_compat/knowledge_base/web_search behavior · v2/v3 · ChatAdminWeb/botworker · ranking/prompt/response shape · ไม่มี source union/live refresh · ยังไม่ทำ Task 5/5A

#### Phase 4D Hardening (2026-09-23) — implement + verified รออนุมัติ commit รวมกับ 4D

- **subtype fail-open:** helper ใหม่ `_filter_charger_subtype_open(docs, subtype, fail_open)` — filter ว่าง + fail_open → คืน docs เดิม (pool ว่างแย่กว่า pool กว้าง เพราะ subtype จาก profile/history อาจคลาด) · wire ทั้ง **4 จุด** ใน fetch_products (vector / pre-rerank / brand-fallback pre-sort / final re-filter) · `fail_open=retrieval_profile is not None` → **profile=None คง legacy hard filter เป๊ะ** (strict subtype ว่าง→ว่างตามเดิม) · units path ไม่ต้องแก้ — subtype ใช้แค่ขยาย ptypes ไม่เคย narrow + vector `if typed` fail-open อยู่แล้ว
- **comment cleanup:** comment ใหม่ของ 4D ไม่มี `⚡` — สั้น อธิบายหน้าที่จริง; comment เก่าใน `_filter_charger_subtype` (มี ⚡ เดิม) ไม่แตะตาม scope
- **multi-subtype guard:** `"มีสายชาร์จกับหัวชาร์จไหม"` → profile.subtype="cable" (singular — resolve เลือกตัวแรก) · test pin: pool ต้องไม่ว่าง (fail-open กันเคส subtype คลาด) + profile=None คง hard filter
- **model_codes supplement audit:** pin ครบ — bounded regex `_model_token_regex_str` + `shopname` ใน query เดียวกัน + `limit(5)` ต่อ code + dedupe ด้วย `item_id` + append เสริมไม่แทนที่ + ไม่มี supplement เมื่อ `model_codes` ว่าง + code ไม่ถูกตีเป็น target_device (pin อยู่ใน test_retrieval_profile.py)
- **test เพิ่ม:** `test_retrieval_profile_hints.py` 10→16 tests (fail-open/multi-subtype/legacy-hard-filter/supplement regex+shop+limit5/dedupe/no-codes-no-supplement)
- **SRS:** เพิ่ม row `_filter_charger_subtype_open` + ปรับ row `_filter_charger_subtype` (strict ว่าง→คืนว่าง)
- **verify:** hints+wiring 29/29 · suite 83/83 · py_compile OK · diff --check OK · regressions: route_context ALL PASS · car_charger 16/16 · subtype parity 42/42 · qtype guards 27/27 · unit_card_fields ALL PASS
- **risk ที่เหลือ:** (1) `RetrievalProfile.subtype` ยังเป็นค่าเดียว — multi-subtype/multi-product/multi-slot จริงอยู่ใน **Task 4E** (2) brand ยังไม่ใช่ hard-filter contract กลาง (3) fail-open ทำให้เคส "ร้านไม่มี cable จริง" ใน profile-backed call เห็น docs กลุ่มอื่นแทน pool ว่าง — trade-off ที่ตั้งใจ (LLM เลือก/ตอบเองได้) ไม่ใช่ bug

### ✅ Master plan Task 4E: Multi-Product Request Slots (2026-09-23) — contract/parser เสร็จ + verified รออนุมัติ commit

- **งาน:** เพิ่ม `RetrievalSlot` (frozen) + `build_retrieval_slots(profile)` ใน `route_context.py` — deterministic span parse เท่านั้น ไม่เรียก LLM · **ยังไม่ wire เข้า retrieval runtime** (Step 4-5 grouped fetch/selection เป็นงานถัดไป) → runtime behavior ไม่เปลี่ยน
- **กฎแยก slot:** window ของ type mention = [mention pos, mention ของ type อื่นถัดไป) ต่อ product type ที่ profile resolve แล้ว → brand/subtype/model ผูกกับ product ที่อยู่ span เดียวกัน
  - ≤1 typed span → slot เดียวเทียบเท่า profile (4D-compatible, subtypes = ทุกตัวที่ detect)
  - ≥2 → slot ต่อ type: `slot-{type}` · subtypes เฉพาะ charger slot · brand/model/codes จาก span เท่านั้น
  - device หลัง ≥2 distinct types / ก่อน mention แรก / ผูก span ไม่ได้ → `target_scope="shared"` ทุก slot
  - local device ต้องตามหลัง compat connector (ใช้กับ/รองรับ/สำหรับ/เชื่อมต่อ/เข้ากัน) — กัน "mi watch 8" ใน watch span ถูกตีเป็น target device
- **ตัวอย่างที่แก้:** "หัวชาร์จ cuktech กับนาฬิกา xiaomi mi watch 8 ใช้กับ mi 17 ultra" → slot-charger {adapter, CukTech} + slot-smartwatch {Xiaomi, mi watch 8} + device shared — brand/subtype ไม่ปนข้าม
- **เจอระหว่าง implement:** `_extract_device_token` ตี product phrase ("mi watch 8") เป็น device ใน span ตัวเอง → เพิ่ม `_local_target_device` บังคับ connector ก่อน device
- **TDD pins (ใหม่ `test_retrieval_slots.py` 7 tests):** charger+watch แยก constraint · multi-subtype {cable,adapter} ไม่บีบ · single product 1 slot · ambiguous → open slot confidence≤0.5 · shared device scope · frozen+no-mutate · one-slot=profile facts
- **verify:** slots 7/7 · profile+hints+wiring 47/47 · suite 65/65 · route_context regression ALL PASS · py_compile OK · diff --check OK
- **risk ที่เหลือ:** (1) slots ยังไม่ถูกใช้จริง — grouped fetch/selection คือ Step 4-5 (งานถัดไป) (2) same-type multi-instance ("สายชาร์จ 2 แบบ") merge เป็น slot เดียวตาม design (3) span parse ใช้ kw/regex positions — typo'd type kw อาจไม่มี span → fallback profile slot
- **ไม่แตะ:** app.py · product_store/retrieval_policy runtime · prompt/llm.py · ChatAdminWeb/botworker/v2/v3 · ChatResponse shape · Task 5/6/8/10/11

#### Task 4E Hardening (2026-09-23) — target-device pseudo-type fix + verified

- **root cause ที่เจอ (probe):** "มีสายชาร์จ Anker กับฟิล์ม iPhone 15 ไหม" → `slot-phone` ผิดเกิด — "iphone 15" match เฉพาะ phone **regex** (model phrase) ไม่ใช่ user_kw → ในบริบท accessory มันคือ target device ไม่ใช่สินค้าที่จะซื้อ
- **fix ที่ slot layer (ไม่แตะ `_detect_product_types` — กระทบ legacy ทั้งระบบ):**
  - `_explicit_phone_product(low)` — phone kw match แบบ word-boundary (`"iphone"` ไม่นับเป็น kw `"phone"`); regex-only phone mention + มี type อื่นร่วม + ไม่มี kw → drop phone ออกจาก slot boundaries (ไม่ใช่ product slot)
  - `_local_target_device(seg, shared, slot_types)` — target จริงต้อง (a) ตามหลัง compat connector หรือ (b) family ของ token ไม่ตรง slot type ("ฟิล์ม iphone 15" → iphone 15 เป็น target ของฟิล์ม; "นาฬิกา mi watch 8" → mi watch 8 คือตัวสินค้า)
  - single-product phone query ไม่พัง: "โทรศัพท์ iphone 15" มี kw → phone slot อยู่; type เดียว → single-slot เทียบเท่า profile เดิม
- **test เพิ่ม (7→10):** accessory device ไม่สร้าง phone slot · explicit phone purchase เก็บ slot · accessory+device ไม่มี connector ก็ไม่เป็น slot
- **verify:** slots 10/10 · profile+hints+wiring 47/47 · route_context regression ALL PASS · py_compile OK · diff --check OK
- **risk เพิ่ม:** accessory ของ device family เดียวกัน ("สายนาฬิกา mi watch 8") — family-match ทำให้ไม่ได้ target (kw quirk ของ type detect อยู่แล้ว, conservative skip)

#### Task 4E Provenance Hardening (2026-09-23) — root-cause fix + verified

- **root cause (พิสูจน์ด้วย probe):** `_type_mentions()` ลดเหลือ (pos,type) — provenance หายว่า type มาจาก explicit kw ("เคส","โทรศัพท์") หรือ inferred model regex ("iphone 15","mi watch 8") → hardening เดิมต้องใช้ `_explicit_phone_product()` เดาย้อนเฉพาะ phone และยังรั่ว: (a) "เคส iphone 15" → single-slot คืน `profile.product_types`={case,phone} ตรงๆ (b) "เคส mi watch 8" → smartwatch slot ผิด + target=None
- **fix (จุดเดียว — slot layer เท่านั้น, ไม่แตะ `_detect_product_types`):**
  - `_type_mentions` คืน `(pos,type,src)` — src "kw"|"regex"; `_kw_positions` latin kw เช็ก token boundary ("phone" ใน "iphone" ไม่นับ explicit)
  - effective types จุดเดียว: `(explicit or mentioned) | carry(anchor/history/intent)` — มี explicit → drop regex-only mentions ออกจาก boundaries; ไม่มี explicit → inferred เป็น fallback
  - single-slot ใช้ effective (ไม่ใช่ profile.product_types ตรงๆ) → "เคส iphone 15" → {case} + target iphone 15
  - `_local_target_device` มี family rule อยู่แล้ว → "เคส mi watch 8" → {case} + target mi watch 8
  - brand/model_terms hygiene: brand ที่อยู่ใน target phrase ไม่ใช่ product evidence — เว้นแต่ device คือสินค้าเอง (family ตรง slot)
  - ลบ `_explicit_phone_product` (ไม่จำเป็น — provenance ครอบทุก family)
- **probe 8 เคส:** เคส iphone15→{case}+dev · เคส mi watch8→{case}+dev · "อยากได้ iphone 15"→phone fallback · "โทรศัพท์ iphone 15"→phone · accessory multi→ไม่มี phone slot · watch multi→แยก constraint · "หัวชาร์จกับ mi watch 8"→charger+target (ambiguous — รายงานข้อจำกัด) · multi-subtype→{cable,adapter}
- **test เพิ่ม (10→14):** single accessory กรอง inferred phone · family rule ไม่เฉพาะ phone (mi watch 8) · inferred-only fallback (phone slot) · explicit ชนะ inferred same-family
- **verify:** slots 14/14 · profile+hints+wiring 47/47 · route_context regression ALL PASS · py_compile OK · diff --check OK · callers: helpers ใช้เฉพาะใน route_context · profile ไม่ mutate (frozen) · lazy imports เดิม ไม่มี cycle ใหม่
- **risk เพิ่ม:** (1) "หัวชาร์จกับ mi watch 8" ambiguous — explicit-wins rule เลือก target แทน product ที่อาจตั้งใจ (2) "เคส xiaomi mi watch 8" — xiaomi อยู่นอก device token → brand_hints ยังเห็น xiaomi (device-brand pollution บางส่วน)

#### Task 4F Canonical Device Alias Normalization (2026-09-23) — root-cause fix + verified

- **root cause (probe):** `_extract_device_token` จับเฉพาะ spaced form → `mi14pro`/`ไอโฟน14โปร` ไม่ match เลย; `ip14`/`i14 pro`/`iphone14 pro` คืน raw non-canonical (spec lookup พลาด/เดา entry ผิด — "iphone14 pro" เคย fuzzy ไป "iphone 14" หาย suffix); และ `ha835`/`cmc615` (letters+digits glued, head≥2+เลข3หลัก) รั่วเป็น device เพราะ glued-guard เดิมบล็อกเฉพาะ letters+digits+letters
- **fix (device_compat.py เท่านั้น + slot helper เล็ก):**
  - `normalize_device_alias(value)` — family-bounded: iphone/ip/i, ไอโฟน, mi + เลข 1-2 หลัก + suffix (pro/pro max/plus/mini/se/air | โปร/โปรแมกซ์/พลัส/มินิ/แอร์ | ultra/pro/t/t pro) → canonical; product code → None
  - `_extract_device_token`: normalize cand ก่อน guards เดิม; เพิ่ม compact-code gate (glued + head≥2 + เลข=3 + ไม่ใช่ family head + ไม่อยู่ spec index → drop: ha835/cmc615); regex ไม่เจอ → `_DEVICE_ALIAS_PROBE_RE` fallback
  - `xiaomi 14 pro` spec entry เพิ่ม (usb-c, 120W/50W, hypercharge/pd/pps/qc, 2023 — flagship spec จริง; ไม่ใส่จะ fuzzy ไป "xiaomi 14" 90W ผิด)
  - route_context: `_device_occurrence` (literal span หรือ alias-span normalize เท่ากัน) → `_span_device_position` ใช้ร่วม; `_product_brands` เปลี่ยน brand filter จาก string-containment เป็น position-based (แก้ regression: canonical "xiaomi 17 ultra" มีคำว่า xiaomi ทำ watch-brand หาย — ตอนนี้ตัดเฉพาะ occurrence ที่อยู่ใน device span จริง)
- **test เพิ่ม:** `test_device_alias_normalization.py` 4 tests; อัปเดต expectation 2 จุด (mi 17 ultra → xiaomi 17 ultra canonical — intended change)
- **verify:** alias+profile+slots+hints+wiring+gold+evidence+availability 112/112 · route_context regression ALL PASS · car_charger 16/16 · compat_mode_filter 144/144 · py_compile OK · diff --check OK
- **risk:** (1) `i`+digits bare ("i5") map iphone — plan-approved, ร้านขายของมือถือ (2) compact หัว≥2ตัว+เลข3หลักที่เป็น device จริงหายาก (เช่น nord100) จะโดนตัด — bounded (3) probe `i|mi`+digits ใน message ที่ไม่เกี่ยว — มี boundary guard แต่ edge case เหลือ
- **hardening ก่อน commit (probe เจอเพิ่ม):**
  - device alias รั่วเข้า `model_codes` → intent=exact_model/answerable_all ผิด → fix ที่ `build_retrieval_profile`: กรอง `cur_codes` ด้วย `_code_is_device` (compact-eq / normalize-eq / spec-resolve-eq / อยู่ใน device span — "i14" ใน "i14 pro")
  - `a56` ตายเพราะ head `a` อยู่ใน `_NON_DEVICE_TOKENS` → fix: cand ที่อยู่ใน `_SPEC_INDEX` ชนะ NON_DEVICE guard
  - `s25` เดิมโดน code==device guard ฆ่า device → ตอนนี้กรองฝั่ง code แทน (guard เดิมคงไว้เป็น safety net)
  - test +3 (aliases≠codes / s25+a56 survive / real codes HA835…AD653T ยัง exact_model) → 68/68 · probe 8 เคสตรง spec · regressions เดิมผ่าน

#### Task 4G Product-to-Product / Mention Relation Parser (2026-09-23) — contract/parser เสร็จ + verified รออนุมัติ commit

- **root cause:** slot parser เก็บ type/code/brand/device แยกกันแต่**ไม่มี representation ของความสัมพันธ์** — "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน" เห็นแค่ charger+AD1404T+subtypes ปนกันใน slot เดียว ไม่รู้ว่า AD1404T คือ *สินค้าอ้างอิง* และสายชาร์จคือ *เป้าค้นหา* (แถม `_type_mentions` merge same-type run ทำ "สายชาร์จ" mention ที่สองหายไปด้วย)
- **fix (route_context.py เท่านั้น — contract/parser, ยังไม่ wire เข้า retrieval):**
  - `RetrievalRelation` (frozen): source_slot_id / target_slot_id / relation_type("works_with") / evidence_span / constraints(tuple[(k,v)]) / confidence
  - `build_retrieval_relations(profile, slots)` — deterministic เท่านั้น: connector regex (ใช้กับ/คู่กับ/รองรับ/เข้ากับ/ใช้ได้กับ/ใช้คู่กับ/ใช้คู่กัน/ใช้ร่วมกับ/เข้ากัน/คู่กัน) → forward: target=kw-mention หลัง connector ≤25 chars + question marker (ไหน/อะไร/แบบไหน/ตัวไหน/รุ่นไหน/ยี่ห้อไหน/ได้บ้าง) ภายใน 30 chars, source=kw-mention/code ก่อน connector · symmetric (ลงท้าย คู่กัน): สอง mention ก่อน connector + question หลัง · device/target-device mention ไม่ใช่ target (kw-only) → "AD653T ใช้กับ ip14" ไม่สร้าง relation · dedupe ต่อ (src,tgt) slot · ไม่เรียก LLM ไม่สรุป compatibility
  - `_kw_type_mentions` — kw-only ไม่ merge (ต่างจาก `_type_mentions` ที่ merge same-type run สำหรับ slot boundary — สายชาร์จตัวที่สองต้องเห็น)
  - `_relation_constraints` — generic detectors: มีจอ/หน้าจอ→(display,required) · N เมตร/ม./m→(length_m,N) · เต็มสปีด/เร็วสุด/เต็มกำลัง→(speed,full) · NNw/วัตต์→(power_w,N) · pd/qc/pps/ufcs X→(protocol,PD3.1)
  - `_slot_id_for` — map type→slot (single-slot ทุก mention เข้า slot เดียว)
- **fix รองจาก plan 4G (mention ownership):**
  - `_product_brands` + adjacency: brand ที่ติดกับ device occurrence ด้านหน้า (whitespace เท่านั้น) = ชื่อ device — "เคส xiaomi mi watch 8" → xiaomi ไม่รั่วเป็น case brand (เดิมกรองเฉพาะ inside-span)
  - `_ambiguous_device_target` + single-slot confidence: device ตามหลัง "กับ" เปล่า (ไม่ใช่ ใช้กับ/เข้ากับ/คู่กับ) + ไม่มี kw ของ family นั้น → อาจเป็น product อีกชิ้นไม่ใช่ target → confidence 0.6 ("หัวชาร์จกับ mi watch 8" = charger+watch?)
- **test เพิ่ม:** `test_retrieval_relations.py` 7 tests — adapter-code→cable relation (constraints display/length_m=2/speed=full) · exact-model ไม่มี relation · device-compat (ip14) ไม่มี product relation · pairing ไม่มี code (หัวชาร์จกับสายชาร์จใช้คู่กัน → relation) · list ไม่มี connector ไม่มี relation · device-brand adjacency · ambiguous confidence<0.8
- **verify:** 75/75 (relations+slots+alias+profile+hints+wiring) · route_context regression ALL PASS · car_charger 16/16 · compat_mode_filter 144/144 · py_compile OK · diff --check OK
- **risk ที่เหลือ:** (1) relation = contract-only — runtime ยังไม่กิน (Task 5/5A ค่อย wire) (2) connector/question window แบบ char-bound (25/30) — ประโยคยาวหน่อยอาจพลาด (3) adjacency เฉพาะ whitespace — "xiaomi, mi watch 8" ยังนับเป็น brand (4) ambiguous-confidence เฉพาะ single-slot path; multi-slot "A กับ B กับ device" ยัง confidence 0.8 ตามเดิม (5) wattage token เช่น "240W" รั่วเป็น model_codes→exact_model (pre-existing ใน `_extract_codes` ไม่ใช่ 4G) — แก้ไม่ได้ generic เพราะ wattage เป็น product code จริงใน catalog (65W=68 units, 20W=93) ต้อง context-aware resolution ใน task ถัดไป

- **hardening รอบ 2 — 'สาย'/'หัว' shorthand context-aware (2026-09-23) — verify แล้ว รอ commit:**
  - **ปัญหา:** relation parser จับเฉพาะ kw เต็ม — "ใช้กับสายไหน"/"หัวอันนี้ AD1404T" พลาด แต่ "สาย" ลอยตัวใส่ PRODUCT_TYPES ไม่ได้ (compound พัง)
  - **fix:** `_shorthand_target_mentions` — 'สาย'→cable/'หัว'→adapter (type=charger) เฉพาะหลัง connector ≤20c + ตามด้วย question marker ทันที + compound blacklist (สายไฟ/สายตา/สายรัด/สายคล้อง/สายนาฬิกา/สายเชือก/สายพาน/สายลม/สายฝน/สายพันธุ์/หัวหน้า/หัวใจ/…) + **gate:** source ต้องเป็น charger ctx (kw/หัว-shorthand/"charger"ใน product_types) → นาฬิกา→สาย ไม่ infer · `_shorthand_source_mentions` — 'หัว'+อันนี้/นี้/ตัวนี้/รุ่นนี้/code → adapter source · shorthand-inferred → constraints+("target_subtype",sub), confidence 0.7 · `_slot_id_for` fallback → "slot-<t>" (virtual, contract-only)
  - **พบระหว่าง probe:** "สายคล้อง" เป็น case kw จริง (สายคล้องคอ) → charger→case relation ผ่าน kw path = ถูกต้อง — test ปรับเป็น pin "ไม่ infer cable" แทน `==()` · "นาฬิกาใช้กับสายนาฬิกาอะไร" → relation smartwatch→smartwatch (kw "นาฬิกา" substring-match ใน compound — taxonomy quirk ไม่ใช่ cable inference)
  - **verify:** relations 13/13 · รวมชุด 81/81 · probe 12 เคสตรง (shorthand เข้า / compound ไม่เข้า / watch ไม่ infer cable / ไม่มี connector ไม่มี relation) · regressions เดิมผ่าน
  - **risk เพิ่ม:** symmetric คู่กัน ไม่รองรับ bare-สาย ตำแหน่งก่อน connector · kw substring-match ใน compound (นาฬิกา⊂สายนาฬิกา) — taxonomy-level ไม่แก้ใน 4G (guard ใน relation parser แล้ว)

- **hardening รอบ 3 — fail-closed source evidence + strap-compound guard (2026-09-23) — verify แล้ว รอ commit:**
  - **ปัญหา (probe จริง):** (1) "หัวอันนี้ใช้กับสายไหน" (ไม่มี code/kw/anchor) สร้าง relation — 'หัว'-shorthand เพียงลำพังไม่ใช่ source evidence (2) "นาฬิกาใช้กับสายนาฬิกาอะไร" → smartwatch→smartwatch self-relation เพราะ kw "นาฬิกา" substring-match ใน compound "สายนาฬิกา" (สายนาฬิกา = strap accessory ไม่ใช่ watch)
  - **fix (route_context เท่านั้น):** `_strap_compound_mention` — kw mention ที่ text ก่อนหน้าลงท้าย "สาย" = tail ของ สายX compound → ตัดออกจาก kw_mentions (compound kw เอง เช่น สายคล้อง ไม่โดน) · source gate: relation ต้องมี real evidence = kw mention หรือ code ก่อน connector (shorthand ให้ type เท่านั้น ไม่นับ evidence) — symmetric path เช็กเหมือนกัน · charger_ctx สำหรับ cable-shorthand รวม code-only source ("AD1404T ใช้กับสายไหน" → relation — code คือ product evidence ในร้าน charging)
  - **verify:** relations 17/17 · รวมชุด 85/85 · probe 9/9 ตรง (หัวอันนี้ลอย→() / +code→rel / code ล้วน→rel / สายนาฬิกา→() / สายคล้อง→charger→case จาก taxonomy kw ไม่ใช่ cable) · regressions เดิมผ่าน
  - **risk เหลือ:** "รุ่น XYZ ใช้กับสายไหน" โดยไม่มี code ที่รู้จัก → no relation (fail-closed ตั้งใจ) · strap guard เฉพาะ สาย-prefix; compound แบบอื่น ("เคสนาฬิกา") ยังไม่ครอบ · code-only→cable inference ใช้ shop-domain prior (ร้าน charging) — confidence 0.7 สะท้อน
  - **✅ commit `b7fe0a9`** — `feat: add product relation parser contract` (route_context +244, test file 17 tests, SRS, log)

#### Phase 4 Final Audit Before Task 5 (2026-09-23) — docs-only เสร็จ

- **audit doc:** `docs/plans/2026-09-23-phase4-final-audit-before-task5.md` — inventory 4A-4G + commits, flow ปัจจุบัน, contract review ต่อ profile/slots/relations, hard-filter vs soft-hint policy, risks 7 ข้อ, Task 5 entry criteria + recommended shape (5A observe → 5B flag → 5C replay gate)
- **findings หลัก:** (1) runtime กินแค่ profile hints (4B/4C/4D) — slots/relations contract-only ไม่มี caller นอก tests (verify ด้วย grep) (2) hard filter ที่ปลอดภัย = shop/platform/model_codes/availability_mode(hลัง resolver) เท่านั้น — ที่เหลือ soft hint (3) ช่องโหว่สำคัญสำหรับ Task 5: virtual slot-<t> ไม่มี backing products, single-slot adapter+cable merge (relation constraints แบก role), wattage⊂model_codes ambiguity, taxonomy substring quirk นอก relation guard
- **verify:** docs-only · git diff --check clean

#### Task 5A (redefined by user) — Offline Grouped Retrieval Planner (2026-09-23) — contract เสร็จ + verified รออนุมัติ commit

- **note:** plan ใช้ชื่อ "Task 5A" กับงาน source-union ใน product_store/units — user redefined 5A = offline planner prototype (ตรง audit "Recommended Task 5 Shape"); plan's Task 5/5A runtime work ยังไม่แตะ
- **ทำอะไร:** `chatbot/shopeechat/retrieval_planner.py` ใหม่ — `RetrievalRequest` (frozen) + `build_grouped_retrieval_requests(profile, slots, relations)` → request plan ต่อ slot/relation; observe-only (no Mongo/LLM/fetch/runtime caller)
- **policy:** model_code→hard filter เสมอ · product_type→hard เฉพาะ slot/rel conf≥0.8 (ต่ำกว่า→soft) · target_device/brand/model_term/constraints→soft เสมอ (ห้ามตัด candidate ใน 5A) · relation target = product-group request (model_codes=(), target_subtype→subtypes) · virtual slot อ่าน type จากชื่อ `slot-<t>` · shop/platform อยู่ profile ไม่ซ้ำ
- **test เพิ่ม:** `test_grouped_retrieval_requests.py` 6 tests — relation→cable target request (codes ว่าง+cable hint) · exact-model=identity request (no relation_id) · device-compat ไม่สร้าง relation request · multi-slot case+film แยก request ทั้ง dev=iphone 15 · bare-head ไม่มี relation request · low-conf slot→soft hints ไม่มี hard target_device
- **verify:** 91/91 (7 test files) · probe 6 เคส: AD1404T full → base(hard code+type) + relation target(soft display/length_m=2/speed) ✓ · symmetric คู่กัน → target request ✓ · CMC615 → identity req-0 conf0.4 hard code ✓ · mi14pro → dev soft hint ✓ · py_compile + diff --check OK · regressions เดิมผ่าน
- **risk:** (1) ~~kw-based relation target ไม่มี target_subtype~~ → แก้แล้วใน hardening ด้านล่าง (2) request ยังไม่รู้จัก availability/compat resolution จริง (3) relation_target request กับ slot request อาจชี้ slot เดียวกัน — dedupe เป็นเรื่องของ consumer (Task 5B)
- **ยืนยัน:** ไม่ wire runtime · ไม่แตะ app.py/product_store/route_context/v2/v3/ChatAdminWeb/botworker · module ใหม่แยกไฟล์ไม่ทำให้ไฟล์เดิมบวม

##### Task 5A hardening — relation target role ownership (2026-09-23)

- **root cause:** `build_retrieval_relations` ใส่ ("target_subtype",…) เฉพาะ shorthand path ("สายไหน") — kw target "สายชาร์จ" ไม่ได้ subtype ทั้งที่ kw ชี้ cable ชัด → relation target request เป็น charger กว้างไม่มี cable role; source slot ก็กลืน subtype เป้าหมาย (subtypes={adapter,cable})
- **fix (ที่ owner = route_context):** helper `_mention_subtype(low,pos,t)` — charger taxonomy: kw ยาวสุดที่ match ตรง pos → subtype ('สายชาร์จ'→cable/'หัวชาร์จ'→adapter; 'หัว'-shorthand→adapter ที่ callsite) · relation ใส่ constraints ("target_subtype",…)+("source_subtype",…) ทุก path (kw/symmetric ด้วย — conf ไม่เปลี่ยน: shorthand 0.7, kw 0.8) · planner consume: source-slot request แคบ subtypes เหลือ source_subtype; target_subtype→subtypes เหมือนเดิม — ไม่ hardcode คำ/รุ่นใด
- **probe:** "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน…มีจอ ยาว 2 เมตร…เต็มสปีด" → base: codes=AD1404T hard, subs=[adapter] · target: subs=[cable], soft=display/length_m=2/speed/target_subtype ✓ · shorthand "สายไหน" → cable ยังได้ · ip14 → ไม่มี relation · bare head → ไม่มี relation · symmetric คู่กัน → target cable · case+film แยกเหมือนเดิม
- **test เพิ่ม:** +3 (kw target carries cable subtype / source slot keeps adapter role / symmetric target subtype) — 26/26 grouped+relations, รวมชุด 94/94 · regressions route_context/car_charger/compat_mode ผ่าน · py_compile+diff --check OK
- **ยืนยัน:** ยังไม่ wire runtime · SRS §6 อัปเดต (_mention_subtype, build_retrieval_relations, _slot_request)
- **cleanup (role isolation):** `_relation_request` กรอง `source_subtype` ออกจาก target request `soft_hints` — เป็น metadata ฝั่ง source ใช้โดย `_slot_request` เท่านั้น (ยังอยู่ใน `RetrievalRelation.constraints`) · +1 test pin · 95/95 รวมชุด · regressions ผ่าน
- **committed `8794cfc`** — feat: add offline grouped retrieval request planner (5 files)

#### Task 5B1 — Grouped Retrieval Executor observe mode (2026-09-23) — เสร็จ + verified รออนุมัติ commit

- **ทำอะไร:** `retrieval_executor.py` ใหม่ — `RetrievalExecutionResult` (frozen) + `execute_grouped_retrieval_requests(requests, *, message, shop, platform, limit_per_request, observe_only, fetcher)` · ต่อ request สร้าง synthetic `RetrievalProfile` → `units.fetch_unit_cards` (default, lazy; injectable สำหรับ test) → candidates+trace · error ต่อ request ถูกจับไม่ล้มทั้งชุด · soft_hints=trace เท่านั้น ไม่ตัด candidate
- **root-cause fix ที่เจอจาก probe จริง:** relation_target fetch ด้วย message เต็ม → vector เอียงไป source ("หัวชาร์จ AD1404T") ดึง adapter ซ้ำแทน cable → แก้ที่ owner: `build_retrieval_relations` เพิ่ม constraint `("query_hint", text ฝั่ง target จาก tgt_pos ≤200)` — executor ใช้เป็น query ของ relation_target · generic ไม่ hardcode
- **probe Mongo จริง (KingGadgets):** "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน…2 เมตร…เต็มสปีด" → base ได้ AD1404T charger (code-hit) · target ได้ **สายชาร์จจริง CTC620W 2 เมตร PD3.1** ตรง constraints · "รุ่น AD1404T" → identity เดียว · "เคสกับฟิล์ม iPhone 15" → case 6 ตัว / screen_protector **0 ตัว** (units pool ไม่มี/ dead-pool — risk สำหรับ 5B2 union)
- **test เพิ่ม:** `test_grouped_retrieval_executor.py` 8 tests (mock fetcher + live smoke skip-guard) — รวมชุด 102/102 · regressions route_context/car_charger/compat_mode ผ่าน · py_compile+diff --check OK
- **risk ก่อน 5B2:** (1) units path อาจว่างทั้งที่ legacy sweep มีของ (screen_protector case) — 5B2 ต้อง union/fallback (2) query_hint ใช้เฉพาะ relation_target — base ยังใช้ message เต็ม (3) soft_hints (display/length/speed) ยังไม่มีผลต่อ rank ใน 5B1
- **ยืนยัน:** ไม่ wire runtime · ไม่แตะ app.py/product_store runtime · fetcher injectable — production path ไม่เปลี่ยน · SRS §6.29 + relation row อัปเดต

##### 5B1 hardening — evidence-preserving buckets (2026-09-23)

- **ปัญหาเดิม:** executor เรียก `fetch_unit_cards` — all-dead → `[]` เงียบ (runtime fallback signal) → grouped path เสียหลักฐาน "เจอแต่ตาย/ผิดเครื่อง"
- **fix:**
  - `units.fetch_unit_evidence()` + `UnitEvidenceFetchResult` — chain เดิม (fetch_units→attach_*→to_unit_card) แต่ไม่ collapse all-dead; `fetch_unit_cards` behavior เดิมไม่เปลี่ยน
  - executor contract ใหม่: `eligible_candidates` / `unavailable_evidence` / `rejected_evidence` / `source_attempts` (+`candidates` property alias); `_bucket()`: wrong_type / subtype_mismatch (charger-family เท่านั้น, unit type=expansion ผ่าน) / device_mismatch (`_extract_device_token` generic — "haylou watch 8"/"mi band 5" ≠ iphone 15) → rejected; dead→unavailable เก็บ reason
- **probe Mongo จริง:** AD1404T spec sentence → req-1 cable elig=6 (CTC620W 2m PD3.1) unav=12 rej=2 · "เคสกับฟิล์ม iPhone 15" → case elig=2/unav=4 · screen_protector elig=0 raw=13 — **ร้านมีแต่ฟิล์ม Haylou/Mi Band → rejected device_mismatch ทั้งหมด** (ก่อนหน้านี้หายเงียบเป็น [])
- **test:** 11 tests (all-dead evidence / per-slot quota ไม่กินกัน / wrong-device rejected / subtype_mismatch / error isolated / live smoke) — รวมชุด 106/106 · regressions ผ่าน
- **ยืนยัน:** ไม่ wire runtime · fetch_unit_cards เดิมไม่เปลี่ยน · ไม่แตะ v2/v3/ChatAdminWeb/botworker · 5B2 = legacy/source union + dedupe/rank กลาง

#### Task 5B2 — Source Union + Central Candidate Pool (2026-09-23) — เสร็จ + verified รออนุมัติ commit

- **root cause ที่แก้:** unit path กับ legacy path ต่างคนต่างคัด/ตัดเองก่อนถึง pool รวม → สินค้าหายก่อนถูกจัดอันดับ (เช่น เคสที่ units ตัดทิ้งแต่ legacy เจอ, legacy เจอแต่ units all-dead)
- **executor ขยายเป็น multi-source:** `legacy_fetcher` param (None=ปิด, "auto"=adapter จริง `_legacy_evidence_fetcher` — fetch_products เดิมผ่าน MONGO_DB, SystemExit→RuntimeError) · `_run_attempt` ต่อ source → `make_evidence_card(source, selection_reason)` tag ทุก card · result เพิ่ม slot_id/relation_id/subtypes/model_codes/target_device (facts ให้ pool) · error ต่อ source เป็น attempt.error — req.error เฉพาะเมื่อทุก source พัง
- **`_bucket` รับ legacy card:** card ไม่มี `product_type` → `_detect_product_types` จากชื่อ (generic taxonomy เดิม — detect ไม่เจอ = unknown ผ่าน soft ไม่ reject หมด)
- **`candidate_pool.py` ใหม่ (observe-only):** `build_candidate_pool(results, profile, per_request_limit)` → `CandidatePool`
  - dedupe identity: unit/model id (variant) → item_id (`_norm_id` float-int) → name+shop · variant ต่าง unit/model id ไม่ merge · item-level card merge เข้า variant เดิม · bucket=ดีสุดในกลุ่ม
  - `_merge_group`: keep best card (sellable→richer→fields) + union `_evidence.sources`
  - `_score` อธิบายได้: anchor(3 spec/warranty/compare/history | 1 อื่น) · model_code+2 · subtype+1 · device+1 · relation_target+0.5 · sellable+0.5 · multi-source+0.2/ตัว · +card `_score` → why[] ลง trace
  - **A/B boundary:** candidates (A) แยกจาก `evidence_pool` (B: anchor/kb_product/image_text attachments — ต้องมี identity, linked_candidate) + `supporting_evidence` (kb_qa/raw contract เท่านั้น) · `llm_ready()` = eligible cards ที่ `strip_private_evidence` แล้ว — boundary เดียว
  - per-request quota: `by_request` map + `per_request_limit` — slot หนึ่งไม่กิน quota อีก slot
- **probe Mongo จริง (legacy_fetcher="auto"):** AD1404T spec → base merged `('units','legacy')` score 5.70 (code+subtype+multi-source) · target ได้สาย CTC315P จาก legacy · "เคสกับฟิล์ม iPhone 15" → TORRAS/CUKTECH merge สอง source · screen_protector ยัง elig=0 + rej=13 (ฟิล์มนาฬิกาทั้งหมด — evidence ไม่หาย) · **พบ+แก้ dedup miss จริง 2 จุด:** (1) unit `item_id` float vs legacy int → `_norm_id` normalize; (2) anchor `("123.0",)` float-str vs card int 123 → `retrieval_policy._norm_id` ขยาย normalize numeric float-str → "123" (generic canonicalization ใช้ทุก caller) — anchor match+boost ทำงานแล้ว
- **test:** `test_candidate_pool_union.py` 14 tests (two-source attempts / merge sources / variant ไม่ dedupe / per-slot quota / relation groups / dead→unavailable / wrong-device rejected / error isolated / code boost / no-mutation / anchor priority / anchor float-str norm / KB-image attachment / llm_ready strip) — รวมชุดเดิม+pool = 120/120 · evidence policy 14/14 · regressions ผ่าน
- **ยืนยัน:** observe-only — `legacy_fetcher` default None (ปิด) · fetch_products/fetch_unit_cards เดิมไม่เปลี่ยน · ไม่ wire app.py/product_store runtime · ไม่แตะ v2/v3/ChatAdminWeb/botworker · soft_hints ยังเป็น trace · 5B3 = compat/KB evidence เต็มระบบ + selection ส่ง LLM + flag wiring

#### Task 5B3-A — Shadow/Observe Wiring หลัง Flag (2026-09-23) — เสร็จ + verified รออนุมัติ commit

- **เป้าหมาย:** pipeline ใหม่วิ่งข้างๆ runtime เดิมเพื่อ log เทียบ — ยังไม่ให้ LLM ใช้ pool
- **`retrieval_shadow.py` ใหม่:** `run_grouped_retrieval_shadow(profile, message, shop, platform)` → slots→relations→requests→executor(`legacy_fetcher="auto"` union)→pool → `_summary` log-safe (counts/attempts/by_request/top_eligible name+id+sources+score/requests) — private keys ไม่เข้า dict โดย construction, ไม่ log history · error → `{"ok": False, "error"}` ไม่ raise
- **app.py callsite (+20 บรรทัด):** หลัง step `RetrievalProfile` — `USE_GROUPED_RETRIEVAL_SHADOW=="1"` + profile ไม่ None → lazy import `retrieval_shadow` → append `_steps` "GroupedRetrievalShadow" เท่านั้น · except → stderr `[SHADOW]` · **flag ปิด = zero cost ไม่มี import** · step input = metadata ปลอดภัย (`message_len`/`shop`/`platform`/`shadow_enabled`) — **ไม่ log req.message เต็ม** (PII)
- **probe จริง (Mongo):** AD1404T spec → summary ok=true, top_eligible merged `("units","legacy")` score 5.7, evidence_attachments=21 — clean JSON ไม่มี `_evidence`
- **test:** `test_retrieval_shadow.py` 7 tests (call order spies / legacy union flag / error→ok:False ไม่ raise / summary shape+counts / no private keys / app callsite gated+lazy static pin / no v2/v3 caller) — รวมชุด 120 baseline + 46 focused ผ่าน
- **ยืนยัน:** flag default ปิด · flag ปิด = behavior เดิม 100% (import ใน block เท่านั้น) · flag เปิด = observe-only ยังไม่ส่ง pool เข้า LLM · ไม่แตะ prompt/llm.py/v2/v3/ChatAdminWeb/botworker/fetch_products/fetch_unit_cards
- **risk ก่อน 5B3-B:** (1) shadow รันเต็มทุก request — latency เพิ่มเมื่อ flag on (ยอมรับได้สำหรับ observe) (2) `_steps` อาจโต — จำกัด top_eligible 5 ตัวแล้ว (3) 5B3-B = selection policy เลือก candidate จาก pool ส่ง LLM + flag แยก

#### Task 5B3-B — CandidatePool → LLM Selection (contract-only, 2026-09-23) — เสร็จ + verified รออนุมัติ commit

- **บริบท:** shadow proof เคสจริง — ระบบเดิมส่ง LLM แค่ AD1404T adapter → ตอบผิด "ไม่มีสาย"; pipeline ใหม่เจอ CTC615P/CTC620P สายมีจอ OLED 240W variant 2 เมตร (item 51617544280) — ขาดชั้น "เลือก" ให้ถูกกลุ่ม
- **`retrieval_selection.py` ใหม่ (ยังไม่ wire runtime):** `select_for_llm_context(pool, requests, profile)` → `SelectionResult`
  - **per-request quota:** แต่ละ request ได้ quota ตัวเอง (default 3) — relation_target cable ไม่ถูก adapter score สูงกิน quota; role (`slot`/`relation_target`) preserved
  - **constraint ranking:** soft_hints (display/length_m/speed/power_w/protocol) match card text (name + **variant names** + tier_variation + specs — "2 เมตร" อยู่ใน variant ไม่ใช่ item name) → `constraint_hits` +score — soft hint เป็น rank signal ไม่ตัดทิ้ง
  - **unavailable ไม่หาย:** `unavailable_evidence` = stripped summaries ({request_id,name,item_id,reason}) จำกัด 5/req
  - **rejected = counts เท่านั้น:** `rejected_summary` {request_id,reason,count} — ไม่มี card หลุดเข้า selected
  - **strip boundary:** `strip_private_evidence` ก่อน output ทุก card — test pin ไม่มี `_evidence`/`_selection_reason`
- **probe Mongo จริง:** AD1404T spec → slot = 3× AD1404T merged (5.70) · relation_target #1 = **CTC615P/CTC620P สายมีจอ OLED hits=(display,length_m,speed) score 4.59** · #2-3 CTC620W 2m (length+speed ไม่มีจอ) · unav: สายตาย item_unlisted/seller_delete เก็บ reason · rej: wrong_type×15, subtype_mismatch×2 counts
- **test:** `test_retrieval_selection.py` 8 tests (source+target ติดคู่ / quota ไม่กินกัน / constraint ranking มีจอ+2m+240W ชนะ / unavailable fallback / rejected excluded / stripped / explainable / no v2/v3) — รวม focused 54/54 · baseline ผ่าน
- **ยืนยัน:** contract-only ไม่ wire app.py (ไม่มี flag ใหม่ — ยังไม่จำเป็น) · ไม่แตะ prompt/llm.py/v2/v3/ChatAdminWeb/botworker · pool ทั้งหมดไม่ถูกส่งเข้า LLM — selected ต่อ request เท่านั้น
- **risk ก่อน wire จริง:** (1) ต้องออกแบบ integration point ว่า selected cards ไปแทน/เสริม products เดิมตรงไหน + flag `USE_GROUPED_RETRIEVAL_SELECTION` (2) replay gate ควรผ่านก่อนเปิด (3) constraint vocab จำกัด 5 keys — subtype/device constraints อื่นยังไม่ match (4) unavailable evidence ต้อง render เป็นภาษาคนใน prompt ไม่ใช่ dict

#### Task 5B3-C — Wire Selected Context เข้า LLM หลัง Flag (2026-09-23) — เสร็จ + verified รออนุมัติ commit

- **ค้นพบ callsite จริง:** `llm.answer(products=…)` มีหลายจุด — AD1404T case ตอบที่ **KB path (~2240, `merged_products`)** ไม่ใช่ main path (~4622) — wire callsite เดียวจะพลาดเคสนี้
- **`retrieval_runtime.py`:** `run_grouped_selection` (compute ครั้งเดียว → selected_cards role-tagged + extra_context unavailable note + summary) + `merge_selected_products` (selected ก่อน + base dedupe item_id + cap) + `prepare_grouped_selection` (composition สำหรับ tests)
- **app.py wiring:** compute block หลัง RetrievalProfile step (flag `USE_GROUPED_RETRIEVAL_SELECTION` default ปิด + lazy import + try/except→None) → merge 2 llm.answer callsites (KB `merged_products` + main `products`) + extra_context note + `_steps` "GroupedRetrievalSelection"
- **A/B proof จริง (patch llm.answer จับ products):**
  - flag OFF → products=3 (AD1404T เท่านั้น — bug เดิม reproduce) · sel step NONE
  - flag ON → products=9: selected 6 role-tagged (3× AD1404T + **CTC615P/CTC620P สายมีจอ OLED 240W 2m** + 2× CTC620W) + base dedup · extra_context = unavailable note (สายตายไม่เข้า products) · sel step ใน steps
- **hardening:** `_item_id` ใช้ `retrieval_policy._norm_id` — float/int-float-str dedupe ตรงกัน (selected 123 vs base 123.0/"123.0" ไม่ duplicate เข้า LLM) — bug root เดียวกับ candidate_pool/anchor ก่อนหน้า
- **test:** `test_retrieval_selection_runtime.py` 11 tests (merge order/dedup float-int/error→None/strip+role-tag/AD1404T both groups/quota/unavailable ไม่ใช่ recommendation/empty→None/callsite gated+lazy+merge≥2/no v2/v3) — รวม 65/65
- **ยืนยัน:** flag ปิด = behavior เดิม 100% (พิสูจน์แล้วด้วย A/B) · pool ทั้งหมดไม่เข้า LLM — selected+base merge เท่านั้น · ไม่แตะ prompt/llm.py/v2/v3/ChatAdminWeb/botworker
- **risk ก่อน replay/gold gate:** (1) selected unit cards เป็น variant-level — merge อาจให้ unit card แทน listing card (ข้อดี: variant ชัด) (2) callsite 1005 (item_id card path) ยังไม่ wire — เคสส่งการ์ดสินค้ามาเองไม่ผ่าน selection (3) unavailable note เป็น text ไทยเพิ่มใน extra_context — token +เล็กน้อย (4) `llm.answer` callsite 2353 (web-search re-answer) ไม่ wire

### 🔄 กำลังทำ — Plan 1: measurement + availability single owner + item_id diversity (2026-10-02)

- **แพลน:** `docs/plans/2026-09-21-plan1-measurement-availability-identity.md` (rev 1.2 — user review 2 รอบ อนุมัติแล้ว)
- **ขอบเขต:** T1 evaluator+baseline (offline ไม่แตะ prod) → T2 gold set ≥40 เคส + `validate_gold` → **หยุดรอ human review ที่ T2 Step 6** → T3 `resolve_availability` → T4 wire ทุก callsite รวม `app.py:4189-4193` → T5 `_cap_per_listing` → T6 replay gate
- **เงื่อนไข:** TDD ทุก task · ห้ามแตะ prompt block `app.py:4194-4234` · `sellable` snapshot ใน retrieval = known limitation ไม่แก้ใน Plan 1 · gold set ต้องผ่าน human review ก่อนเริ่ม T3
- **baseline ที่จะเทียบ:** `docs/test/results/unit_reg_questions_2026-09-18.jsonl` (300Q)

### ✅ Audit + rewrite docs/schema.md ตามโครงสร้างปัจจุบัน (2026-09-21) — เสร็จ + verified → ย้ายไป "ผ่านแล้ว"

### ✅ เขียน SRS_SSD.md ใหม่ทั้งหมด (2026-10-02) — เสร็จ + verified

- **ทำไม:** SRS เดิมลงวันที่ 2026-09-02 ขาดงาน ~1 เดือน — section 6 ครอบแค่ ~10 modules ขาด 13 โมดูล (device_compat/device_specs_data/order_flow/handoffs/warranty_flow/units/guards/responses/route_context/chat_models/test_chat_api/chat_v2/chatbotv3/scripts), line numbers ตายหมด, pipeline §5 ไม่ตรงโค้ด
- **ตัดสินใจกับ user:** section 6 = มาตรฐาน 8 ช่อง (Purpose/Input/Output/Calls/Called by/How it works/Side effects/Error-fallback) · เอา line numbers ออก (ใช้ชื่อฟังก์ชัน) · ขอบเขตครบ: shopeechat ทุกไฟล์ + chat_v2/chatbotv3 + scripts + ChatAdminWeb
- **วิธี:** audit ฟังก์ชันจากโค้ดจริงทุกไฟล์ (~280 signatures, ไม่เชื่อ SRS เดิม) → เขียนทับ `docs/SRS_SSD.md` ทั้งไฟล์ (815 บรรทัด) → verify ชื่อฟังก์ชันทุกตัวกับ `def/class` จริง (script กรอง — เหลือแต่ env/collection/field names + callee ที่ตั้งใจ flag)
- **ครอบ:** §1 ภาพรวม 3 engines · §2 arch + connections · §3 DB 4 กลุ่ม (admin/dbWallet/order/stock + local files) · §4 external services · §5 pipeline จริง (legacy 21 ขั้น + v2 8 stages + v3 flow + guard boundary) · §6 function inventory 26 หมวด (app/llm/product_store/intent/kb/web_search/persona/warranty/warranty_flow/conv_products/order_store/order_flow/handoffs/device_compat/device_specs/units/embedding/route_context/responses/guards/chat_models/test_chat_api/chat_v2/chatbotv3/scripts/ChatAdminWeb) · §7 env ครบ · §8 status · §9 plans · §10 known issues 15 ข้อ · appendix call graph
- **เจอ bug ใหม่ระหว่าง audit (จดใน §10 #1):** `chat_v2` เรียก callee ที่ไม่มี 3 จุด — (a) `knowledge_base.get_general_context` ไม่มี (ของจริง `build_general_context`) → AttributeError ลอย = **500 ทุก general question ใน v2** · (b) `_cp.add_item_anchor` (c) `_cp.get_timeline` ไม่มีใน conversation_products → try/except กลืน = anchor persistence + follow-up retrieval no-op เงียบ
- **กระทบ:** doc เดิมถูกเขียนทับทั้งไฟล์; ไม่แตะโค้ด — bug ที่เจอจดไว้ใน §10 + §9.2 (งาน chat_v2 callee fix)
- **✅ ขยายเสร็จ (2026-10-02):** user ว่าสั้นเกิน → เขียนใหม่เป็นมาตรฐาน SRS/SSD เต็ม (1,135 บรรทัด): (1) §6 แตก 1 row/ฟังก์ชันจริง ~280 rows ไม่รวมกลุ่ม — 26 หมวดครบทุก module (2) เติม ChatRequest/Response field tables, warranty SM State 0-7 table, PRODUCT_TYPES ~105 ตัว + charger subtypes 7 ตัว, cert 4 แหล่ง, dedupe scorecard, intent labels ครบ, fetch_products internal flow (3) §5 เพิ่มตาราง trigger/branch ของ deterministic paths + engine routing (4) ไม่เอา changelog/line numbers กลับ (5) re-verify ชื่อฟังก์ชันเทียบ `def/class` — ผ่าน เหลือแต่ env/collection/field names + 3 callee ที่ตั้งใจ flag

### Audit สถานะ issue จาก QA docs 2026-09-15 (2026-09-21) — 📋 จดสถานะแล้ว รอวิเคราะห์/แพลนกับ user

- **ต้นทาง:** `~/Downloads/issue-chat-annotations-partial-index-2026-09-15.md` + `shadow-inbox-bot-qa-notes-2026-09-15.md`
- **✅ แก้แล้ว:** (1) partial index chat_annotations → unique index เดียว {scope,conv_id,gen_batch_id} ตามที่เสนอเป๊ะ (mongoClient.ts:48-65,181) (2) NEW-4 ภาษา → policy ใหม่ default ไทยเสมอ ไม่ detect จากข้อความ (llm.py:92-154)
- **🟡 แก้บางส่วน:** NEW-1 (NER primary แล้ว + reject ชื่อมีตัวเลข แต่ fallback regex `ค[่้๊๋ั]?ะ*` ลบ "ค"/"ชื่อ" ทิ้งยังอยู่ warranty.py:629-638) · BUG-M (เพิ่ม KW หลายคำ + post-check fixed patterns llm.py:73-88 แต่ยังขาด "ติดต่อเจ้าหน้าที่/แชทกับเจ้าหน้าที่/ติดต่อร้านค้า" และ post-check ไม่ escalate จริง) · NEW-2 (warranty_flow State 7 รับรูปเป็น evidence + _received_items แล้ว แต่คำถามใน claim ยังถูกกลืน by design State 6) · NEW-8 (cert search มี type_filter แล้ว handoffs.py:168-188) · BUG-H/K/O (sellable-first ranking + shop_capability_line แล้ว แต่ยังไม่ verify ซ้ำ)
- **❌ ยังไม่แก้:** BUG-Q (error path ยังแนบ `{exc}` ดิบถึงลูกค้า llm.py:1455/1588/1692 + quota เป็นเรื่อง ops) · NEW-3 (ไม่มี post-check นโยบาย เปลี่ยนได้/คืนได้/ฟรี/โปร/แถม — guards.check_output มีแต่ log observe-only app.py:216-223) · NEW-6 (anchor ไม่ใช้ image_desc) · NEW-7 (ไม่มี suppression การ์ดสินค้าตาม intent) · NEW-9 (elapsed plumbing ดูถูกแล้วทั้ง 2 ฝั่ง แต่ต้อง re-measure batch ใหม่) · NEW-10 (vision 503 = quota เดียวกับ BUG-Q) · BUG-I (ไม่มี cap prompt tokens) · markdown table (ไม่มีตัวแปลง) · "ทางร้าน จะ" space เกินยังอยู่ (warranty_flow.py:383)
- **guard ที่มีอยู่:** `no_product_found_handoff` มีที่ app.py:3980 + chat_v2.py:1313 (QA เจอว่าไม่เคย fire — ต้องเช็คเงื่อนไข arm)
- **แพลนแก้ root-cause เขียนแล้ว:** `docs/plans/2026-09-21-qa-remaining-bugs-plan.md` — จัดกลุ่มเป็น 5 root cause (RC-A trust boundary, RC-B claim slots, RC-C keyword whack-a-mole, RC-D error leak, RC-E measurement) + 16 tasks · self-review 5 รอบแล้ว
- **กำลังทำ (2026-09-21):** Phase 0 ✅ (T1-T4 เสร็จ+เทสผ่าน) · Phase 1 ✅ (T5 claim-state fill-once + T6 order-problem routing — เสร็จ+เทสผ่าน) · ถัดไป Phase 2 ตามแพลน `docs/plans/2026-09-21-qa-remaining-bugs-plan.md` — เงื่อนไข: เทสก่อนข้ามเฟส + ห้ามกระทบเคสผ่าน
- **decisions จาก user (2026-09-21):** (1) quota — ตัดออกจาก scope user จัดการเอง (NEW-10 vision 503 ตัดไปด้วย) (2) post-handoff = บอทเงียบจน ticket closed + ลูกค้าทักซ้ำ — verify แล้วว่ามีครบอยู่แล้ว: worker `botWorkerService.ts:334` skip เมื่อ assigned_to+!closed (เงียบจริง ไม่เรียกบอท) + bot layer `warranty_flow.py:148-199` lock ด้วย ticket_state เป็น fallback → **ไม่ต้องเปลี่ยน State 6** — NEW-2 fallthrough ใช้เฉพาะ waiting state ก่อน handoff (State 7) (3) fulfillment problem (ส่งผิด/ของขาด/ของแถมไม่ครบ) → ส่งแอดมิน — reuse return/refund path ใน order_flow.py:75-286 เดิม (detect→order_sn→handoff) ไม่สร้าง flow ใหม่; detection แบบ composition (received-verb+problem) + guard freebie-question ด้วย ไหม/เหรอ — รายละเอียดใน plan T6

### live-assignment 500 error (2026-09-21) — ✅ fixed + verified (data layer)

- **อาการ:** หน้า /live-assignment console AxiosError 500 — poll `GET /api/live-assignment?list=1` ตายทุกครั้ง
- **root cause (reproduce แล้วด้วย script):** `push_unit_reg_to_admin.py` insert docs เข้า `test_assignment` โดยใส่ `created_at`/`replayed_at` แต่**ไม่ใส่ `updated_at`** (51 docs, replayed_by=`unit_reg_2026-09-18`) → sort `updated_at:-1` ดัน doc ไม่มี field ไปท้าย → route.ts `docs[last].updated_at.toISOString()` throw TypeError → catch → 500
- **วิธีแก้:**
  1. `push_unit_reg_to_admin.py` — เพิ่ม `"updated_at"` ในทั้ง 2 doc builders (push_questions + push_conversations) — root cause
  2. backfill `updateMany({updated_at:{$exists:false}}, [{$set:{updated_at:"$created_at"}}])` → 51 docs แก้แล้ว
  3. `live-assignment/route.ts` — cursor fallback `updated_at ?? created_at` (กัน writer อื่นลืม field)
- **verify:** probe script เดิม → cursor คำนวณได้ `2026-09-07T09:29:27Z|shp_458...` · bad docs = 0 · `tsc --noEmit` ผ่าน · `py_compile` ผ่าน · endpoint ตอบ 401 (auth ปกติ — dev server hot-reload แล้ว)
- **ผลกระทบเคสอื่น:** admin-chat-result sort `replayed_at` (มีอยู่) ปลอดภัย · test-assignment ไม่แตะ `updated_at` · frontend `liveDocToConversation` มี `|| created_at` อยู่แล้ว · conv_detail ไม่ใช้ `updated_at`

### test-assignment history + live-assignment inbox โหลดช้า/หน่วง (2026-09-18) — ✅ fixed + verified

- **อาการ:** user รายงาน history หน้า test-assignment โหลดช้า + live-assignment inbox หน่วง
- **root cause (วัดจริงใน DB):** `test_assignment` docs อ้วน — avg 60KB max 1.1MB เพราะ `qa` array เก็บ transcript เต็มต่อ doc — list/stats endpoints `find()` **ไม่มี projection** → ลาก transcript เต็มทุก doc → 68 docs ≈ 4MB / ~0.8-1.5s บน remote mongo → live-assignment **poll ทุก 5 วิ** → หน่วงตลอด
- **วิธีแก้ (projection 4 จุด — pattern เดียวกับ listReplayBatches/adminKpiService ที่มีอยู่):**
  - `listLiveAssignments` → `{ qa: { $slice: -1 } }` — list ใช้แค่ `qa[last]` ทำ last-message preview (page.tsx:106); conv_detail ยังดึงเต็มผ่าน `getLiveAssignment` (ไม่แตะ)
  - `listHistoryByAdmin` → `{ qa: 0, message_ratings: 0 }` — route map เฉพาะ summary fields
  - `listDeleted` → `{ qa: 0, message_ratings: 0 }` — เหมือนกัน
  - `getLiveAssignmentStats` → `{ final_status: 1, mock_status: 1 }` (เดิมลาก 5000 doc เต็มมานับ 2 field)
  - `getTestAssignmentStats` → projection summary + `qa.{status,bot_source,bot_intent,bot_web_search_used}` subfields (นับ pipeline stats ได้ครบ ตัด bot_reply/products/retrieval_info ออก)
- **verify จริง (DB ตรง):** list full 68 docs/824ms/3959KB → $slice:-1 = 68 docs/**151ms/450KB** (~9x เล็กลง 5x เร็ว); history 62 docs/**30ms/33KB** (~120x เล็กลง); last qa item ยังมี keys ครบ → preview ไม่พัง; `npx tsc --noEmit` ✅
- **ผลกระทบเคสอื่น:** conv_detail/qaToMessages ใช้ getLiveAssignment (full doc) ไม่แตะ; cursor pagination ใช้ updated_at+conversation_id ยังอยู่ใน projection; `listTestAssignments` ไม่มี caller → ไม่แตะ

### Shadow gen เขียนทับ state ของแชทจริง (timeline + ticket/handoff) (2026-09-18) — ✅ fixed + verified

- **อาการ:** user กด generate shadowbot → คำตอบแยกใน `shadow_replies` ถูก แต่ bot ได้ `conversation_id` จริง → `/chat` เขียน state ลงของจริงทุกอย่าง
- **audit write surface ที่ reachable จาก /chat (เสร็จแล้ว — ยืนยันจากโค้ด):**
  1. `conversation_products` (doc key = conversation_id จริง): `add_product` (anchor+bot_suggestion — app.py:897/4662, `_record_suggestion_products` ×3), `add_order_anchor` (order_flow:179/362, chat_v2:507), `add_item_anchor` (chat_v2:779), `update_claim_state`/`clear_claim_state` (warranty_flow ×5) → **เขียนทุก product turn** (พิมพ์เข็ม: last_updated doc ตรงเวลา shadow batch)
  2. **`conversations` + `status_conversation` + assign admin + admin_events** — `_send_handoff` (responses.py:35) POST `/api/admin/conversations/bot-handoff` payload `simulate: req.simulate_assignment` → shadow ไม่ได้ส่ง → `simulate:false` → **handoff จริงบนแชทจริง** (worst: replay เคส warranty/order → แชทลูกค้าจริงถูก flip เป็น handoff + assign admin จริง + bot อาจเงียบกับลูกค้าจริง)
  3. Python ไม่มี write อื่นนอกจากนี้ (grep ครบทั้ง package — 4 update_one อยู่ใน conversation_products ทั้งหมด)
- **จุดส่ง:** `callOurBot` ซ้ำ 3 ที่ (shadow-inbox/route.ts, generate-conversation/route.ts, scripts/generate-all-shadow.ts) ส่ง `conversation_id` จริง ไม่ส่ง simulate/ticket_state
- **วิธีแก้ (zero Python change — namespace + simulate):**
  - `callOurBot` ×3 (shadow-inbox/route.ts, generate-conversation/route.ts, generate-all-shadow.ts — script เพิ่ม param `conversationId` ให้ด้วย เดิมไม่ส่งเลย): ส่ง `conversation_id: "shadow:" + convId` + `simulate_assignment: true`
  - `replay_compare.py:call_bot` — bug class เดียวกัน (replay ผ่าน /chat ด้วย conv id จริง) → namespace เหมือนกัน
  - ผล: write ทุกจุดใน conversation_products/claim/order ลง key `shadow:` แยกขาด + multi-turn state ใน batch ทำงานปกติ; handoff → `handoffToAdminTest` → `test_status_conversation` แทน conversations จริง + answer ยังได้ชื่อ admin
- **verify จริง:**
  - `npx tsc --noEmit` ✅
  - E2E `generate-all-shadow.ts --limit=1` (conv shp_271339438995668811, 2Q): doc `conversation_products` key `shadow:shp_2713...` ถูกสร้าง (6 products) — real conv **ไม่มี doc ถูกสร้าง/แตะ** ✅, shadow_replies 2 docs ปกติ ✅
  - Direct /chat claim message ด้วย `shadow:` id → `handoff:true` fired → ไม่มี write ลง conversations/status_conversation จริง ✅ (log bot: handoff POST 404 เพราะ ADMIN_HANDOFF_URL env ของ server :8020 ชี้ผิด — pre-existing ไม่เกี่ยว fix)
  - Direct POST bot-handoff `simulate:true` + `shadow:` id → `ok:true simulate:true` → test path เท่านั้น, real collections ไม่แตะ ✅
- **ผลข้างเคียงที่รับแล้ว:** shadow ไม่เห็น timeline เก่าของแชทจริง (by design — replay สร้าง state เอง); doc `shadow:` สะสมใน conversation_products (cleanup ใน clear-shadow-replies ได้ภายหลัง); round-robin cursor ขยับตอน simulate handoff (เหมือน test-chat)

### 400 API_KEY_INVALID หลัง add 10 keys ใหม่ (2026-09-18) — 🔍 diagnose แล้ว รอ user action

- **error:** "ขออภัย ระบบ LLM ติดขัด (400 INVALID_ARGUMENT ...)" — full body ใน log = `API_KEY_INVALID` "API key not valid"
- **เกิดเพราะ:** Gemini ปฏิเสธตัว key เอง (ไม่ใช่ quota/model/request) — pool db ตอนนี้ ~19 keys (9 เก่า + 10 ใหม่), fail rate ~50% (21 err / 43 calls) ≈ 10/19 → **key ที่เพิ่ง add เข้ามา invalid เกือบทั้งหมด/ทั้งหมด** (พิมพ์ผิด / revoke / เอา key คนละ provider มาใส่ pool Gemini)
- **ทำไม log เห็นแต่ [INTENT]:** chat path กลืน ClientError เป็นข้อความขอโทษตอบลูกค้า ไม่ print stderr — intent_classifier เป็นตัวเดียวที่ log error
- **วิธีแก้ (ฝั่ง user):** ปิด toggle 10 keys ใหม่ในหน้า /llm → หายใน ~10s ไม่ต้อง restart; แล้ว validate ทีละตัว `curl "https://generativelanguage.googleapis.com/v1beta/models?key=<KEY>"` ก่อน add กลับ
- **gap ที่เจอ:** ไม่มี per-request key log (หา key ตายจาก log ไม่ได้ ต้องไล่ sha256 จาก UI) + ไม่มี auto-skip bad key (key ตายค้าง rotation จนกว่าจะปิดมือ)

### /llm key list: scroll 10 แถว + toolbar ค้นหา/sort/filter + ปุ่มเพิ่ม key ขึ้นบน (2026-09-18) — ✅ implement + tsc ผ่าน รอ user เช็คหน้าจริง

- **ทำไม:** user ขอ — list key ยาวเกิน ให้โชว์ ~10 แถวแล้ว scroll, ปุ่ม "เพิ่ม key" ไว้ล่างสุดหาไม่เจอ → ย้ายขึ้นบน, อยาก sort/filter/search ตามชื่อ
- **ผลกระทบ:** `KeyPoolCard` (page.tsx) branch `source==="db"` เท่านั้น — component แชร์ 2 pools (Gemini+OpenRouter) ได้ทั้งคู่อัตโนมัติ; display-only บน `keys` array ที่โหลดแล้ว (mutation ยังอ้าง sha256 → sort/reorder ไม่พัง toggle/rename/delete); ไม่แตะ API/backend
- **วิธีแก้:** state `keyQuery`/`sortDesc`/`statusFilter` (all|on|off) → `visibleKeys` derive (filter name icase + status + localeCompare); toolbar บนสุดของ db section = search input (ไอคอน Search) + sort toggle (ArrowDownAZ/ArrowUpZA) + FilterSelect สถานะ + ปุ่ม "เพิ่ม key" (ย้ายจากล่าง); `<ul>` ใส่ `max-h-[512px]` (~10 แถว) + `overflow-y-auto`; แถบล่างเหลือ warning เดิม; empty จาก filter → "ไม่พบ key ตามเงื่อนไข"
- **verify:** `npx tsc --noEmit` ผ่าน — รอ user เช็คหน้าจริง

### compat re-query ดึงผิดหมวด + fallback เดาหมวดเอง (2026-09-18) — ✅ implement+verify เสร็จ รอ code review

- **error:** `หูฟัง sony ใช้กับ iphone 15` → ตอบ "ไม่มีหูฟัง" + เดา "มีสมาร์ทโฟน Xiaomi" — ทั้งที่ร้าน KingGadgets มีหูฟัง **54 ตัว NORMAL** ขายอยู่
- **เกิดเพราะ (audit พบ 4 ชั้น — ลึกกว่า plan เดิม):**
  1. `_filter_compat_products`: ambiguous merge-back เฉพาะ `compat<2` — หูฟัง 50 ตัว (no connector) ถูกลบเงียบๆ เพราะชาร์จ usb-c ≥2 ปน
  2. `_device_spec_lookup` re-query ใช้ charging web keywords เสมอ + prompt "≥27W/dual-tier" ทุก compat query
  3. **ชั้นที่ 3 (เจอตอน E2E):** `web_search.reanswer` re-query `f"{en_type_token} {web_keywords}"` → "earphone หูฟัง Sony iPhone..." → detect ear+phone+iPhone → **ดึงโทรศัพท์ 30 ตัวทับ context ดี**; `_final_products` replace ทั้งก้อน (ไม่ใช่ union)
  4. type token อังกฤษ ("earphone") เอง detect ผิดเพี้ยน (ear**phone**→phone) และไม่ match ชื่อสินค้าไทย
- **แก้ด้วย:**
  1. `_compat_mode` (device_compat.py) — candidates = detect(msg) ∪ intent → priority charging>model_fit>self_compat; skip=phone/voucher, unknown=ไม่มี type
  2. `_filter_compat_products` +`compat_mode`/`asked_type` — charging/unknown=เดิมเป๊ะ; model_fit/skip=คืนทั้งหมด; self_compat=drop เฉพาะ plug ผิด ambiguous เก็บคงลำดับ
  3. `_device_spec_lookup` — non-charging re-query ด้วย `product_store._type_query_word` (canonical Thai kw) + `product_types_override` hard-scope + prompt ไม่พูด wattage + ไม่ต้อง web; charging path ไม่แตะ
  4. `web_search.reanswer` — type token → Thai kw + `product_types_override` + `_final_products` เปลี่ยน replace→union (ของเดิมไม่หาย)
  5. `product_store.shop_capability_line` — per-shop NORMAL type counts (cached) → inject "หมวดที่ร้านมีจริง" เมื่อของถามไม่อยู่ context
- **verify:** test_compat_mode_filter 36/36 ✅ · car_charger_regression 16/16 ✅ · E2E `หูฟัง sony+iphone 15` → "ใช้ร่วมกันได้" + หูฟังจริง 8 ตัว (Xiaomi Buds 3 top) ✅ · E2E `สายชาร์จ+iphone 15` → เดิมเป๊ะ (CTC315P USB-C ถูกแนะนำ) ✅
- **ผลกระทบข้าม:** charging/unknown path โค้ดเดิมทุกบรรทัด; web_search.reanswer ใช้ Thai kw+override ทุก type (positive-neutral); union ทำ context ใหญ่ขึ้น (dedup จัดการ); file sizes: app.py 4797(+4) device_compat 822 product_store 4097 web_search 874 — ทุกไฟล์ต่ำกว่าเพดาน
- **รอ:** code review ก่อนสรุปสุดท้าย

### test_200 selected 100 เคส (2026-09-18) — general/mixed/compat/ambiguous/followup

- **ผิวเผิน:** 98 pass / 0 fail / 2 err — แต่ต้องแยก: **26 เคสเป็นคำตอบ "ระบบ LLM ติดขัด"** (masked เป็น pass เพราะมี products)
- **ที่ดีขึ้นจริง (verify แล้ว):**
  - #143 `เอาขึ้นเครื่องไปจีน` → product_store+web_search (เดิม misroute shipping_policy) — **guard travel ทำงาน**
  - #199 `มีสินค้า smart home ไหม` re-run → product flow ตอบ honest (เดิม ❌ generic dump) — **guard categories ทำงาน**
  - compat non-charging ทำงานถูก: #113 TWS+iPhone / #114 QCY+Samsung / #115 IMILab+Android — ตระกูลเดียวกับเคสหูฟังที่เคยพัง → ตอบถูก+ของจริง
  - charging compat ปกติ: #101/104/105/108/110/118/119/120 ถูกทั้งหมด ไม่มี regression
  - ambiguous/followup ดี: #124 P01 40000mAh / #136 clarify / #146/151 BA651 grounded
- **bug ที่เจอ (จดไว้รอ review):**
  - 🔴 **API_KEY_INVALID** — Gemini key ใน rotation pool ใช้ไม่ได้ → 26/100 คำตอบเป็น error text (ops/config ไม่ใช่โค้ด — เช็ก key pool)
  - 🔴 **MongoClient-after-close race** — `/health` `/shops` `/categories` `/brands` + chat_v2.py:1489 เรียก `client.close()` บน shared cached client (get_client singleton) → request ที่กำลังใช้พังกลางทาง = HTTP 500 ×2 (knowledge_base.py:690 build_general_context) — pre-existing, prod เจอบ่อยเพราะ health check รันตลอด; แก้: ลบ close() บน shared client
  - 🟠 **#132 `อันไหนเสียงดีสุด` → warranty_claim_first_message** — substring "เสีย" ใน "เสียง" trigger claim kw → superlative misroute — ต้อง word-boundary guard บน claim keywords
  - 🟠 **#109 BUG-A confirmed** — `พาวเวอร์แบงค์ชาร์จ MacBook` → p=1 ตอบหัวชาร์จ AC65B2 (ยังไม่แก้ ตามแพลน P1)
- **ไม่พบ regression จาก compat work** — charging/general routing ปกติทั้งหมด
- ผลเก็บที่ `docs/test/results/test_200_selected100.json`

### E2E batch 12 เคสหลังแก้ (2026-09-18) — เจอ bug เพิ่ม 1 + polish 1

- **เคสที่ผ่าน:** speaker+s24 (Kieslect), smartwatch+iphone16, car_charger+s25u (CC903P PD3.0/PPS 90W ถูก), warranty claim (ZMI), powerbank≤1000฿, compare CTC615W/CTC610, superlative (Lagenio K9), lightning cable availability, shipping policy (iSuper), projector browse (Yaber T2/L2)
- **BUG-A (pre-existing, charging path — ยังไม่แก้ รอ review):** `พาวเวอร์แบงค์ใช้กับ macbook air` (CukTech) → intent type=powerbank แต่ web extractor คืน `product_type="charger"` → re-query `charger MacBook Air MagSafe 3 USB-C 70W` → ดึง GaN chargers แทน powerbanks → **ตอบ "ไม่มี powerbank" ผิด** (ร้านมี WPB100/PB060/PB100P)
  - เกิดเพราะ: `_device_spec_lookup` charging path เชื่อ `_device_product_type` จาก web extractor ทับ type ที่ลูกค้าถามจริง — bug ตระกูลเดียวกับ earphone case
  - แผนเสนอ: ส่ง `product_types_override={_asked_type}` เข้า charging re-query เมื่อ asked_type valid — scope ตาม type จริงแต่คง web keywords (charger→เดิม, powerbank/car/wireless→ถูกหมวด)
  - ผลกระทบที่ต้องเช็กตอน review: subtype prefix (adapter/cable/set) ทำงานร่วมกับ override ไหม; เคส cable ใน taxonomy เป็น charger อยู่แล้ว
- **BUG-B (โค้ดใหม่ — แก้แล้ว):** `ฟิล์มจอ iphone 16` → detect={screen_protector}+intent=case → tiebreak alphabetical เลือก case → re-query ดึงเคสแทนฟิล์ม
  - แก้: mode เดียวกันให้ `hit∩detected` ชนะ intent (literal แม่นกว่า context guess) — test 36/36 ผ่าน E2E ตอบเจาะจงฟิล์มถูก
- **observation:** web search JSON parse fail → retry ซ้ำ (double cost ~$0.02/เคส) — pre-existing ไม่เกี่ยว fix นี้
- **observation:** c1 products=smartwatches แต่ answer พูดถึงหูฟัง — Kieslect ไม่มีทั้งคู่ (honest ว่าอาจหมด) ยอมรับได้

### Variant image + OCR รูปนอก description (2026-09-18) — ✅ implement เสร็จ รอ deploy steps

- **ทำไม:** user เจอในแชท thitirat.rac — unit card "สายชาร์จ CTC315P ขาว" (item 6359177007) โชว์รูป `th-11134208-81ztg-mne4rdze5wxse2` = รูปแรกใน desc field_list (banner) แทนรูปสายจริง `th-11134207-7rash-m8zynhw4wjrd0a` — เพราะ `to_unit_card` ใช้ `unit.image_ids[0]` (desc เท่านั้น) ไม่เคยอ่าน `tier_variation.option_list[].image`
- **และ:** image_texts OCR เฉพาะรูปใน desc field_list — รูป มอก./cert ที่อยู่ใน gallery (`image_id_list`) / variant option image ไม่ถูก OCR → cert search พลาด (~12,794 รูปใหม่ใน sellable docs)
- **วิธีแก้ (ทำแล้ว):**
  1. `units._variant_image_id()` — match `model_name` กับ `tier_variation[].option_list[].option` (normalize isalnum+lower; exact หรือ option≥4chars ⊂ name สำหรับ 2-tier) → คืน `option.image.image_id`
  2. `to_unit_card` — `image_url` ลำดับใหม่: **variant > cover (`image_id_list[0]`) > desc (`image_ids[0]`)** (เดิม desc เท่านั้น); `attach_listing_fields` เพิ่ม `tier_variation` ใน projection → runtime ทำงานเลยไม่ต้อง rebuild
  3. `build_image_texts._doc_images()` — image_id→url จาก 3 แหล่ง (desc field_list + gallery + variant options, dedupe desc นำหน้า) — ใช้ร่วมกันใน `_collect_worklist`, `_collect_nonsellable`, `import_image_texts._image_item_ids`
  4. `build_sellable_units._field_list_parts` — `unit.image_ids` ต่อท้ายด้วย gallery+variant ids → `attach_image_texts` join เห็น OCR รูปนอก desc
- **Verify:**
  - py_compile ครบ 5 ไฟล์ ✅
  - unit check ข้อมูลจริง item 6359177007: "สายชาร์จ CTC315P ขาว" → `th-11134207-7rash-m8zynhw4wjrd0a` (รูปสายจริง) ✅, "A18T + CTC315P สีขาว" → variant img ถูก ✅, no-match/empty/empty-listing → `""` ✅, `_doc_images` 33 รูป desc-first + cover+variant ครบ ✅
  - test_cert_standards 46/46 ✅, test_car_charger_regression 16/16 ✅
- **SRS_SSD.md** อัปเดต 6.18.1 (เพิ่ม `_variant_image_id` + ปรับ `to_unit_card`/`attach_listing_fields`/`attach_image_texts`)
- **⚠️ ขั้นตอน deploy ที่เหลือ (ก่อนเห็นผลจริง):**
  1. variant image ใน card — restart :8010/:8015 (runtime change อยู่แล้ว)
  2. OCR รูปใหม่ ~12,794 รูป (sellable) + nonsellable — รัน `build_image_texts.py` (+ `build_image_texts_nonsellable.py`) — resume append ลง `exports/image_texts.jsonl` (~$2-3)
  3. `import_image_texts.py` re-run → `item_ids` map ครบ 3 แหล่ง → cert search เห็นรูป gallery/variant
  4. rebuild `sellable_units` (อยู่ใน P0) → `unit.image_ids` ครบ → `attach_image_texts` join เห็น OCR รูป gallery/variant
- **⚠️ ยังไม่ verify e2e:** รอ deploy steps ข้างบน + replay แชท thitirat.rac เช็ครูป variant จริง

### Restart :8010 + :8015 ด้วยโค้ดใหม่ (2026-09-17 ~17:2x + restart ซ้ำตอน cert done)

- **ทำไม:** replay-compare ยิง `127.0.0.1:8010` — process เก่า start 12:19 ก่อน commit `015a9c3` (sellable ranking + suggestion compare, 16:57) → replay ได้โค้ดเก่า
- **ทำ:** kill 65815/65818 → relaunch `USE_UNIT_INDEX=charger nohup uvicorn` log เข้า `exports/uvicorn_{8010,8015}.log` — ทั้งคู่ health 200
- **เคสที่น่าจะเปลี่ยน:** "ตัวไหนออกใหม่สุด" เดิม CONV-ACTIVE pin Case เดี่ยว → ตอบผิดเป็นของ Case
- **⚠️ gap ที่รู้ว่ายัง:** card ไม่มี field วันที่ (`create_time`) → LLM ตอบ "รุ่นไหนใหม่กว่า" ไม่ได้แม้ context ถูก — เสนอ `listed_date` ใน `to_product_card`/`to_unit_card` รอ user ตัดสินใจ

### 🔄 กำลังทำ — Rebuild unit index สด + regression กว้าง 300Q/50conv ยิง LLM จริง (2026-09-18)

- **งาน (user สั่ง):**
  1. rebuild sellable_units จาก live DB (export สด → build → import → unit_embeddings + typo_dict ใหม่) — `--source mongo` ยังไม่ implement ใช้ export→build เดิม
  2. regression วงกว้างทุก type/ทุกหัวข้อ (ไม่ใช่แค่ charger): compat, ซ้ำซ้อน, เคลม, จัดส่ง, รับประกัน, เครื่องเปิดไม่ติด/เสีย, แจ้งปัญหา, มอก, order/tracking, brand, superlative, compare, model code, typo, shorthand
  3. ยิง LLM จริงเท่านั้น (ไม่ใช่ query-level test) — ดูเนื้อหา+บริบทคำตอบ+เส้นทางที่ตอบ (units vs legacy vs KB vs deterministic) ตรงแพลนไหม
  4. **จด error + root cause ไว้ ไม่แก้**
  5. quota: 300 คำถามเดี่ยว + 50 conversations จริง (messages_shp)
  6. เก็บผลเต็มทุก Q&A → ไฟล์ (+ ถ้าได้เข้า admin-chat-result)
- **วิธี:** runner ใหม่ `docs/test/unit_index_regression.py` ยิง `POST /chat` (instance แยก :8020 ด้วย USE_UNIT_INDEX=1) + reuse `replay_compare` สำหรับ 50 convs จริง; per-turn เก็บ full response (answer/products/unit_id/source/intent/routing/steps/usage/bot_log) + flag `unit_path`(cards มี unit_id)/`unit_attempted`(log [UNITS] แต่ fallback)
- **corpus:** `docs/test/build_unit_reg_corpus.py` → `docs/test/unit_reg_corpus.jsonl` = **300 ข้อ / 17 topics** ผูก shop+model_codes จริงจาก index สด: compat_charging30 compat_other15 warranty26 claim20 shipping15 device_issue15 problem_report10 tisi12 order10 brand10 superlative18 compare15 browse39 model_code20 shorthand15 typo10 price10 general10
- **progress:**
  - export live ✅ ShpProducts 11,692 docs
  - build units ✅ 27,807 units (sellable 5,489 · classified 5,158 = 94% pass gate) — log `exports/rebuild_units_2026-09-18.log`
  - import ✅ `sellable_units` = 27,843 docs (sellable 5,490) · unit_embeddings.npz 106MB สด · typo_dict.json สด
  - bot :8020 `USE_UNIT_INDEX=1` (log `/tmp/chatbot_unit_8020.log`)
- **ผลเทส (เซฟแล้ว):**
  - **300Q ✅ ครบ** — `docs/test/results/unit_reg_questions_2026-09-18.jsonl` — answered 300/300 (quota error ช่วงแรกถูก retry จนหมด) · unit_path=118 · fallback_dead_pool=15 · web=15 · handoff=42
  - **50 convs ✅ ครบ (resume จาก 34)** — `docs/test/results/unit_reg_convs_2026-09-18.jsonl` = 50 convs / **579 qa turns** — answered 326 · quota error 253 (44% — pool หมดช่วงบ่าย เป็น infra ไม่ใช่ logic) · unit_path=60 · dead_pool fb=6
  - push เข้า `test_assignment` แล้ว (replayed_by=`unit_reg_2026-09-18` → ดูที่ /admin-chat-result)
  - conv shops: IMILab 128 / BlackShark 119 / ZMI 96 / CukTech 91 / Kospet 75 qa turns
  - backup run1 ที่ error: `unit_reg_questions_2026-09-18.run1_err.jsonl`
- **⚠️ ระวัง:** API_KEY_INVALID/429 ใน pool (entry บน) — error จะถูกจดเป็น error ไม่แก้ตามคำสั่ง
- **observations เบื้องต้น (จดไว้ ยังไม่แก้):**
  - `device_issue`/`problem_report` ถูก route เข้า warranty claim form + handoff เกือบหมด (เช่น "หูฟังเชื่อมต่อบลูทูธไม่ได้" → claim form) — troubleshooting ไม่ได้ไป QA tips
  - `มีสาขาหน้าร้านไหมครับ` → `tax_invoice_handoff` (คำว่า "สาขา" ชน tax-invoice detect) — misroute
  - `เช็คออเดอร์หน่อย` → เข้า product_store+unit path แทน order flow (คำตอบยังถูก — ขอเลขออเดอร์)
  - `มีของแบรนด์ zmi ไหม` (ร้าน TicWatch) → "ทักแอดมิน" แทนที่จะตอบไม่มี
  - pool all-dead → legacy fallback ทำงานถูก (browse IMILab camera: 441 units แต่ sellable 51 → top-50 vector ตายหมด)
  - unit path ใช้ได้กับ shorthand/superlative/price/model_code ดี (shorthand 15/15, superlative 18/18)
- **ค้าง:** conv replay เหลือ 17 convs (34-50) · วิเคราะห์เนื้อหาเชิงลึกต่อข้อ · รายงานสรุป root-cause · bot :8020 ยังรันอยู่ (โค้ดเก่าก่อน user แก้ spec ladder)

---

## รอ verify — bot + unit index ใช้งานจริง (2026-09-17, priority)

เรื่อง: sellable-first ranking + live join + compat gate + suggestion compare (commit `015a9c3`/`80f1da1`)
verify ระดับ retrieval (quota-free) ผ่านแล้ว — ที่เหลือคือพิสูจน์ end-to-end บนบอทจริง + index สด

### P0 — ทำก่อนสุด (ปลดบล็อกข้ออื่น)

1. **image_texts batch จบ + import เข้า Mongo** — กำลังรัน (ดู 🔨 ด้านล่าง); unit cards ใช้ `attach_image_texts` join ตอน runtime — index ที่ rebuild หลัง import จะครบทั้ง image_ids + image_text ในคราวเดียว
2. **rebuild sellable_units** — `chatbot/shopeechat/scripts/build_sellable_units.py`
   - เหตุ: index ปัจจุบัน stale (KingGadgets charger เหลือ sellable 6/275 ทั้งที่ live มี 113 ใบ) → unit path ตก legacy ตลอด ทำให้ "unit index ใช้งานจริง" ยังพิสูจน์ไม่ได้
   - verify หลัง rebuild: `sellable=True` count ต่อ shop ต้องใกล้ live catalog; probe `USE_UNIT_INDEX=charger` + "หัวชาร์จละ" ต้องได้ unit cards ขายได้โดยตรง (ไม่ใช่ผ่าน fallback)
   - สั่ง: `cd chatbot && ../.venv/bin/python -m shopeechat.scripts.build_sellable_units`

### P1 — หลัง rebuild (พิสูจน์ unit path จริง)

3. **probe ซ้ำ UIF=charger** (quota-free): "หัวชาร์จละ" ต้องคืน sellable units เอง ไม่เห็น log `pool all-dead → legacy fallback`; "HA835 มีไหม" code-hit ยังคุ้ม
4. **E2E LLM — test chat / shadow replay** (ต้อง quota):
   - "หัวชาร์จละ" → แนะนำของที่ขายได้จริง ไม่มีลิงก์ตาย
   - "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → เลือก 90W+ (เดิมตอบ 45-67W)
   - bot แนะนำ ≥2 ตัว → ถามต่อ "อันไหนดีกว่า" → เทียบของที่เพิ่งแนะนำ ไม่วน anchor เก่า
   - "HA835 มีไหม" → ตอบหมด/เลิกขายถูกต้อง
   - เคสร้านที่ของตายเยอะ → ตอบ "หมด" มากขึ้น = พฤติกรรมถูกต้อง ไม่ใช่ regression
5. **live compare :8010/:8015** (UIF on/off เทียบกัน) — อยู่ในตารางข้างล่างแล้ว ค้างรอ quota เหมือนกัน

### P2 — กันซ้ำระยะยาว

6. **เฝ้า log `[UNITS] pool all-dead`** ช่วงแรกหลัง deploy — ถ้าหลุดบ่อย = index stale เร็ว → ตัดสินใจ cadence rebuild (cron รายวัน/สัปดาห์ หรือ trigger หลัง sync สินค้า)
7. **replay แชทจริง** ที่เคยพัง (nat041134 order, katess.nk compare) — รวมกับแถว "รอ verify" เดิมด้านล่าง

---

## รอ verify (implement แล้ว — ย้ายมาจาก file 1)

| งาน | รออะไร | ref file 1 |
|---|---|---|
| ensureIndexes partial index fix (MongoDB 5.0) | rebuild deploy จริง + เช็ค log ไม่มี `ensureIndexes failed` | L8056-8073 |
| Video understanding 6 paths | ส่งวิดีโอจริงผ่าน test chat + Shopee bot worker | L8112-8134 |
| Order item anchoring + return/refund handoff | replay แชทจริง (nat041134) | L7509-7545 |
| Product types หมวดใหม่ (กระเป๋า/รองเท้า/จอยเกม) | replay จริงยืนยัน fallback query ดึงถูกหมวด | L7591 |
| Anchor compare (Run vs Swim) | replay แชท katess.nk; เคส "swim" ค้นไม่เจอ = product search quality แยก | L7673-7709 |
| live compare :8010/:8015 (unit flag on/off) | ค้างรอ quota | L8436 |
| SRS_SSD.md updates | 2 งานติดรอ verify replay ก่อน (กฎข้อ 1) | L7507, L7545 |

## รอ action / ตัดสินใจ (ย้ายมาจาก file 1)

- **single-key switch** — L8456: เดิมให้ตั้ง `GEMINI_API_KEY` ตัวเดียวใน .env + ลบ `_1.._9` + restart; **แต่** llm_config มี `key_source.gemini` แล้ว → สลับเป็น `single` ผ่านหน้า /llm ได้เลยไม่ต้องแตะ .env (ปัจจุบัน = "db" 9 keys)
- **Ponytail review app.py findings** — L8014-8030: ⏸️ รออนุมัติส่วนที่ยังไม่ได้ apply (บางส่วนไปกับ refactor แล้ว)
- **Ponytail repo-audit** — L8032-8037: dead deps ใน requirements.txt (resend/PyJWT/bcrypt/email-validator), docker-compose lazada/tiktok services — report-only รอตัดสินใจ
- **Task 5 unit_embeddings** — L8103: entry เขียน "🔄 กำลังรัน" แต่ `exports/unit_embeddings.npz` 103MB มีแล้ว — น่าจะเสร็จ แค่ไม่ได้อัปเดต entry

## เลื่อนไว้โดยตั้งใจ (YAGNI / แยกงาน — ย้ายมาจาก file 1)

- Neural reranker `bge-reranker-v2-m3` (option F6 — ดูผล sellable ranking ก่อน) — L8611
- unit index rebuild (deploy step — cron/manual) — L8611
- charger kw → data-driven subtype (migration ใหญ่) — L8611
- hard filter `item_status` ตอน query — **ห้ามทำ** (ทำลายตอบของลบได้ เก็บไว้ tier) — L8611
- UI assign role ให้ user + SSO login flow map email→role — L8497
- ChatAdminWeb UX debt — focus trap/restore, tab roles, aria-pressed, FormField consolidation, undo coverage, saved filter presets — L7637-7643, L7779, L7826, L7850

---

## ผ่านแล้ว (file 2)

### ✅ 2026-09-22 — ShadowStatPanel "All History" โชว์ "ยังไม่มีสถิติ" ตลอด

- **error:** panel สถิติขวา tab "All History" ใน /shadow-inbox โหลดไม่เคยสำเร็จ — frontend catch → `setStats(null)` → โชว์ "ยังไม่มีสถิติ"
- **เกิดเพราะ:** `getShadowReplyStats` (shadowReplyService.ts) ทำ `find({deleted_at:{$exists:false}}).toArray()` ไม่มี projection/limit → ลาก 4,980 docs = 50.9MB / **140.8s** (doc อ้วนเพราะ `bot_products` สูงสุด 354KB/doc) — axios timeout 30s → request ตาย
- **แก้ด้วย:** `.project()` เฉพาะ field ที่ stats ใช้ (`rating, star_rating, comment, bot_cost_usd, bot_elapsed_ms, bot_tokens.total`) — pattern เดียวกับ fix test-assignment/live-assignment
- **verify:** `getShadowReplyStats({})` จริงผ่าน tsx = **333ms** (เดิม ~141s) ค่าถูก (total=4980, win_rate=100%, cost=$21.17, tokens=64.3M) · `tsc --noEmit` ผ่าน · commit `83509de`
- **ผลกระทบเคสอื่น:** caller เดียว route.ts `?stats=1` ครอบทั้ง All History + Per Chat (conv filter) — Per Chat เร็วขึ้นด้วย; output shape ไม่เปลี่ยน
- **probe script:** `ChatAdminWeb/scripts/probe-shadow-stats.ts` (committed — ใช้วัดซ้ำได้)

### ✅ 2026-09-21 — Legacy Shopee evidence-first retrieval implementation plan

- **ทำไม:** user ขอ implementation plan จาก audit โค้ดจริง + Mongo collections จริง เพื่อแก้ root cause ของการคัดสินค้า, ลด hardcode/hardlogic, ลด `app.py` bloat, และแยกเจ้าของ logic ให้ debug ง่ายขึ้น
- **วิธี:** ใช้ `brainstorming` + `writing-plans`; รวมผล audit data/callsite หลักใน legacy Shopee; plan แบบ evidence-first เริ่ม measurement/gold gate → availability owner → `RetrievalProfile` owner เดียว → evidence coverage observe-only → retrieval_policy → gated compat/sensitive/web cleanup → replay gate; intent เป็น proposal, `route_context` reconcile current message+anchor+intent+bounded history; ทุก legacy product source ได้ profile object เดียว
- **เคสเพิ่ม:** Mi 17 Ultra follow-up ต้อง carry family/subtype จาก history โดยไม่กลายเป็น phone search; negative stock/compat แยก proof (`sellable_candidate_count`, `compatible_candidate_count`, `compatibility_unknown_count`) ห้ามตอบไม่มี/หมดเมื่อยังมี compatible sellable candidate
- **ไฟล์:** `docs/plans/2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md`
- **verify:** ponytail review รอบสองแล้ว; ตัด `history_terms`/private keys/report fields ที่ไม่มี consumer, รวม dedupe key, ระบุ gold drafter และ response-boundary stripping; placeholder/duplicate-owner scan ผ่าน; `wc -l` = 2,121; `git diff --check` ผ่าน; ยังไม่แตะ runtime code

### ✅ 2026-09-21 — Legacy retrieval redesign rev 2 current-flow audit + no-regression plan

- **ทำไม:** user ขอให้เขียนแผนใหม่จากโค้ดปัจจุบัน ไม่ให้ทำคำตอบเดิมพัง ไม่ให้โค้ดบวม และต้องลด hardcode/hardlogic ที่ root cause
- **วิธี:** อ่านกฎใหม่ + ใช้สกิล brainstorming/writing-plans/ponytail → audit flow จริงจาก `app.py`, `product_store.py`, `units.py`, `device_compat.py`, `route_context.py`, `conversation_products.py` → เขียนแผน rev 2 ที่ยอมรับว่า unit path เสียบอยู่ใน `product_store.fetch_products()` แล้ว และวางทางลด owner ซ้ำทีละ phase
- **ไฟล์:** `docs/plans/2026-09-21-legacy-retrieval-redesign-rev2-current-flow.md`
- **verify:** `rg` placeholder scan ไม่พบ `TBD/TODO/implement later/fill in/placeholder`; `wc -l` = 759; `git diff --check` ผ่าน; ไม่แตะ runtime code

### ✅ 2026-09-21 — ปรับกฎ commit/branch/PR (AGENTS.md ข้อ 10)

- **ทำไม:** user ต้องการ workflow "ทำ local → commit หลายครั้งบน branch → PR ครั้งเดียว" + กฎเลือก branch: งานใหม่ทิศเดียวกับ branch เดิม → commit ต่อ; คนละทิศ → สร้าง branch ใหม่
- **แก้:** AGENTS.md ข้อ 10 ขยายจาก "กฎการ commit" เป็น "commit / branch / PR" — ทำงานบน branch เสมอ, commit หลายครั้งได้หลังงานถูกอนุมัติ (ไม่ต้องถามทุก commit), push=สำรองไม่ใช่ PR, PR ครั้งเดียวตอนเสร็จ, ยังต้องถามก่อน commit ครั้งแรกของงาน + ก่อนเปิด PR

### ✅ 2026-09-21 — issue #19: `||` แทน `|||` → การ์ดติดฟองข้อความ

- **error:** LLM พิมพ์ตัวคั่น `||` (2 ขีด) แทน `|||` → `split_segments` พลาด → markdown การ์ดสินค้าหลุดในฟองข้อความ (1/40 sim chats)
- **เกิดเพราะ:** กติกา `|||` มีแค่ใน prompt ไม่มี post-processing บังคับ
- **แก้ด้วย:** `llm._strip_kb_markup` (llm.py ท้ายฟังก์ชัน ก่อน return) +`re.sub(r"\s*\|{2,}\s*", " ||| ", text)` — funnel เดียวครอบทุก LLM answer (answer/answer_general/answer_with_kb, web_search.reanswer→llm.answer, `_append_base_warranty`) ทั้ง 3 engines; จับ `||`/`||||`+ ด้วย (กว้างกว่าที่ issue เสนอ — `||||` เดิม split แล้วเหลือ `|` ติดหัว segment)
- **verify:** py_compile ✅ · assert 7 เคส (`||`→split ถูก, `|||` unchanged, `||||`→clean, no-pipe ไม่แตะ, table→bullet ปกติ, pipe เดี่ยวไม่แตะ, `||` มี space รอบ) ✅ · test_qa_batch_20260911 13/17 — 4 fail = BUG-M stale tests pre-existing บน HEAD เหมือนกัน (false-admin replacement ย้ายไป guards.enforce ตั้งแต่ T4) ไม่ใช่ regression · SRS_SSD §6.2 อัปเดตแล้ว
- **ผลกระทบเคสอื่น:** deterministic answers (handoffs/warranty/order_flow) ไม่ผ่านฟังก์ชันนี้ ไม่เปลี่ยน; frontend split `|||`+trim ใช้ ` ||| ` ได้ปกติ; table converter รันก่อน ไม่ชน
- **หมายเหตุ:** `docs/issue-bot-segment-separator-2026-09-21.md` + `docs/test/sim_customer.py`/`sim_report.py` (check `MK_bad_separator`) ที่ issue อ้าง ไม่มีใน repo นี้

### ✅ 2026-09-21 — Add commit-approval rule + retrieval plan anti-bloat notes

- **ทำไม:** user ต้องการกฎชัดเจนว่า agent ห้าม commit เองตอนจบ phase และต้องลดโอกาสที่ legacy retrieval plan จะทำให้ `app.py`/pipeline บวม
- **วิธีแก้:** `AGENTS.md` เพิ่มกฎ comment/docstring สั้น และเพิ่มข้อ 10 "กฎการ commit" ว่าต้องสรุป diff/test/ไฟล์ที่เปลี่ยนแล้วถาม user ก่อน commit ทุกครั้ง; `docs/plans/2026-09-21-legacy-retrieval-redesign-plan.md` เพิ่ม no-commit-without-approval, anti-bloat, comment constraints; `docs/plans/2026-09-21-legacy-retrieval-redesign.md` เพิ่ม Code Size And Comment Policy
- **verify:** `rg` พบกฎ commit/comment ในไฟล์เป้าหมายครบ; `git status --short` ยืนยันเป็น working tree เท่านั้น ยังไม่ได้ commit
- **ผลกระทบ:** doc-only; ไม่แตะ runtime code และไม่ต้องอัปเดต `docs/SRS_SSD.md`

### ✅ 2026-09-21 — rewrite docs/schema.md ตามโครงสร้างจริง (doc-only, ไม่แตะโค้ด)

- **งาน (user สั่ง):** อ่าน schema.md เดิม → เขียนอัปเดตว่าโครงสร้างตอนนี้เป็นยังไง ใครใช้ collection ไหนบ้าง
- **เจอว่าเดิมล้าสมัย:** เขียนไว้ตอน 34 collections แต่ `config.ts` ตอนนี้ 36 keys + ขาด collections ที่เพิ่มหลัง KB re-import (kb_products/kb_qa/kb_raw), sellable_units, image_texts, stock DB `itStock.Products`, llm key pool ใน system_configs
- **สิ่งที่แก้ใน schema.md:**
  - §1.2: 34→36 keys + note ว่าทุกชื่อ override ด้วย `ADMIN_MONGO_COLLECTION_*` (production ใช้ `*_shp`)
  - §1.3: DB connections 3→4 (เพิ่ม stock DB `STOCK_URI`/`STOCK_DB`) + เพิ่ม §1.4 ตาราง 7 collections ที่ Python เป็นเจ้าของ (อยู่นอก COLLECTIONS)
  - `knowledge_base` (§2.3): ระบุเป็น legacy fallback สำหรับ Python — runtime หลักย้ายไป kb_qa/kb_products (`_kb_coll` เหลือ caller เดียวใน get_general_faq); admin UI `/knowledge` ยัง CRUD เต็ม
  - `conversations` (§2.6): เพิ่ม field `labels` (อ่านโดย /labels + workflowEngine) + ชื่อ deployed `conversations_shp`
  - `shops` (§2.8): เพิ่ม writer `sync-shops.ts` (aggregate จาก conversations_shp)
  - `system_configs` (§2.19): แก้จาก single-doc → multi-doc config store 3 docs (`main_config`/`llm_config`/`role_permissions`) — เดิมเขียน PK ผิดเป็น "default" (จริงคือ `main_config`); llm_config อ่านโดย Python `llm.py` (TTL 10s) + `web_search.py`
  - `test_chat_sessions` (§2.26): ref ย้าย app.py→test_chat_api.py + เพิ่ม fields `source`/`script_test` + writer `shadow_openrouter.py`
  - `test_assignment` (§2.28): เพิ่ม reader liveAssignmentService/adminKpiService + writer `push_unit_reg_to_admin.py`
  - §3.2 ShpProducts: ขยาย consumers (units/knowledge_base/app.py/chat_v2/chatbotv3/replay_compare + Next.js 2 services) + env ฝั่ง Next.js คือ `SHP_PRODUCTS_COLLECTION`
  - เพิ่ม §3.5 stock DB `itStock.Products` (cert search path เท่านั้น, collection name hardcoded `Products`)
  - §4 ShpOrders: เพิ่ม Next.js `/admin/conversations/[id]/orders` route (buyer_user_id lookup), ฟิลด์ครบ Phase 3C, ลบ `lookup_orders_by_buyer` (ไม่มีจริงในโค้ด)
  - §5 ขยาย 2→7 collections: conversation_products (+order_anchors/active_order_sn/claim_state), test_chat_logs (ref ใหม่), image_texts, sellable_units (schema เต็ม + sellable อ่านสด), kb_products, kb_qa, kb_raw (audit trail ไม่มี reader)
  - เพิ่ม §7 local files (npz/jsonl pipeline) — แก้จุดที่เดา: ไม่มี build_unit_embeddings.py (จริงคือ `build_embeddings.py --units`/`--qa`), `device_specs_data` เป็น module ไม่ใช่ json
  - §8 access matrix แยกตาม owner: 8.1 Next.js COLLECTIONS / 8.2 Python-owned / 8.3 external read-only / 8.4 unused
  - renumber §2.13 ซ้ำ (quick_replies+close_history) → §2.13-2.32 เรียงถูก
- **Verify:** เช็คชื่อ collection ทุกตัวกับ `config.ts` (36 keys), `mongoClient.ts` ensureIndexes, per-service `COLLECTIONS.*` grep (34 services), direct collection ใน API routes, Python modules (units/knowledge_base/test_chat_api/conversation_products/llm/app), import/build scripts, doc shapes จาก source (parse_row, _build_unit, import_image_texts, test_chat_api)
- **หมายเหตุ drift ที่ยังค้าง (ไม่ได้แก้ — นอก scope):** `docs/SRS_SSD.md` §3.1 เขียนชื่อผิดว่า `knowledge_base_products`/`knowledge_base_qa` (จริงคือ `kb_products`/`kb_qa`)

### ✅ 2026-09-18 — stale timeline card: shadow gen โชว์รูป desc banner หลัง fix variant image

- **error:** user กด generate shadowbot (conv thitirat.rac `shp_458397959795636281`) หลัง deploy variant-image fix → card ยังโชว์ `th-11134208-81ztg-mne4rdze5wxse2` (desc banner)
- **เกิดเพราะ:** card ใน `bot_products` มี key set = `_strip_card_for_storage` shape พอดี (ไม่มี unit extras/condition/raw_description) + name เป็น item_name เวอร์ชันเก่า → มาจาก **`conversation_products` timeline restore** (CONV-ACTIVE → `resolve_active_by_message` → stored card ตรงๆ) ไม่ใช่ build สด — timeline เขียนด้วยโค้ดเก่า (batch 09:11 local ก่อน units.py fix 09:49) แล้ว `_record_suggestion_products` re-record card เดิมทุก turn → stale self-perpetuate ไม่มี TTL
- **พิสูจน์:** fresh `to_unit_card` บน unit เดียวกัน → รูป variant ถูก `th-11134207-7rash-...` ✅ = โค้ดใหม่ปกติ ปัญหาอยู่ที่ snapshot เก็บไว้
- **แก้ด้วย:** `conversation_products.py` — `_rebuild_card` (unit-level → sellable_units lookup + attach_kb_specs/attach_image_texts + `_listing=doc` → `to_unit_card`; อื่น → `to_product_card`) + `_materialize_card` (cache 30s/(item,model) → rebuild → fallback stored) — patch getters ทั้ง 5 (`get_active_product`/`get_suggestion_latest`/`get_latest_suggestion_batch`/`get_anchor_and_suggestions`/`resolve_active_by_message`) → restore ทุกจุดได้ card สด (image/name/price/stock/status ทั้งหมด — user สั่ง refresh หมด)
- **ผลกระทบข้าม:** follow-up turns ทุกแชทได้ข้อมูลสด (รวม stock/status ที่เคย stale — ดีขึ้น); doc หาย → fallback stored; ต้นทุน +1-2 mongo find/restore (cache 30s กันซ้ำใน request); write path ไม่เปลี่ยน; card สดถูก re-record → timeline self-heal
- **Verify:** test_timeline_card_refresh 8/8 (ใหม่ — unit→variant img, listing→cover, doc หาย→fallback, no-card→minimal) · cert 66/66 · car_charger 16/16 · guards 27/27 · qa_context 4/4 · **E2E จริง** restart :8010 → /chat conv เดิม "ตัวนี้มีสีอะไรบ้างคะ" → `image_url=th-11134207-7rash-m8zynhw4wjrd0a` (รูปสาย CTC315P ขาวจริง) ✅

### ✅ 2026-09-18 — แก้ 3 ปัญหาจาก test_200 (P0 crash + 2 misroute)

- **แพลน:** `docs/plans/test200-fixes-plan.md`
- **P0 qa_context IndexError → HTTP 500 (#132):** dict literal `tag={...}[level]` evaluate f-string `topic.split()[0]` **ทุก key ก่อนเลือก** → hit ใดๆ topic='' (32/393 docs) crash ไม่ว่า level — แก้ `_topic0 = next(iter(split()), "")` 1 จุด @ `knowledge_base.py:1266`
- **P1 shipping misroute (#143 "ขึ้นเครื่องไปจีน"):** **regression จาก Phase 6 intent-first** — เดิม `general_qtype` มาจาก keyword เท่านั้น ("ขึ้นเครื่อง" ไม่ match → ผ่านไป compat-followup L~1680 ตอบถูก) → Phase 6 ให้ LLM ตั้ง qtype → `shipping_policy` early return L~1540 ก่อน fix เก่าทำงาน — แก้ `_general_qtype_bypass` @ `app.py:440`: shipping_policy + `_TRAVEL_KWS` (ไม่มี `_SHIP_VERB_KWS` — "ส่งไปจีน"=จัดส่งจริง) → None → product flow
- **P2 categories misroute (#199 "มี smart home ไหม"):** intent→categories → generic dump ทั้งที่ smart home = cross-type cluster (95 items/17 types) — guard เดียวกัน: categories + `_CAT_NOUN_RE` noun เจาะจง (ไม่อยู่ใน `_CAT_GENERIC_NOUNS`) → product flow ค้น "Smart" ในชื่อสินค้าจริง
- **ผลกระทบข้าม:** shipping จริง ("ส่งกี่วัน"/"ค่าส่ง"/"ส่งต่างประเทศ") คงเดิม — verb precedence; categories จริง ("ขายอะไรบ้าง") คงเดิม — generic noun set; type อื่นไม่โดน (guard เฉพาะ 2 qtype)
- **Verify:** test_qa_context_guard 4/4 · test_general_qtype_guards 27/27 · cert 66/66 · car_charger 16/16 · **E2E 5/5**: #143→product_store ตอบถูกบริบท, powerbank ขึ้นเครื่อง→ตอบกฎ 100Wh, "ส่งกี่วัน"→shipping คงเดิม, #199→kb+mongo 10 products จริง, "มีสินค้าอะไรบ้าง"→categories คงเดิม
- **test ใหม่:** `docs/test/test_qa_context_guard.py`, `docs/test/test_general_qtype_guards.py`

### ✅ 2026-09-18 — language policy: ตอบไทยเสมอ เว้นแต่ลูกค้าขอภาษาอื่น → อังกฤษ

- **error:** เดิม `_detect_lang` mirror ภาษาลูกค้า — ข้อความอังกฤษ/จีนล้วน → ตอบอังกฤษ, ตัวเลข/รหัสล้วน ("1"/"ctc615w") → `other` → ตอบอังกฤษให้ลูกค้าไทย (เคสจริงใน replay Q3)
- **เกิดเพราะ:** detect จาก script ของข้อความ ไม่ใช่จากเจตนา — ข้อความสั้น/รหัสสินค้าหลุดเป็น non-Thai
- **แก้ด้วย:** ลบ `_detect_lang`; `_lang_instruction(message)` ใหม่เช็ค `_LANG_REQUEST_RE` — explicit request เท่านั้นถึงคืน block "Answer in English" (ไม่ใช่ภาษาที่ขอ เพราะคุมคุณภาพไม่ได้), อื่นๆ → `""` ตอบไทย; regex ครอบ TH (verb+ภาษา+ชื่อภาษา) / EN (verb+ชื่อภาษา, "in X please", "X please") / CJK / bahasa / อาหรับ / รัสเซีย — ไม่รวม thai/ไทย; แก้ prompt "ตอบเป็นภาษาเดียวกับลูกค้า" → "ตอบภาษาไทยเสมอ" 2 จุด (SYSTEM_INSTRUCTION + KB_SYSTEM_INSTRUCTION) ไม่งั้น LLM mirror อยู่ดี
- **ผลกระทบข้าม:** pure-English/CJK message ที่ไม่ได้ขอภาษา → ตอบไทย (ตั้งใจตาม spec); ตัวเลข/รหัสล้วน → ไทย (ดีขึ้น); FP guard — "app ภาษาจีนใช้ได้ไหม"/"english manual"/"speak thai" ไม่ trigger; callsite 3 จุด (answer/answer_with_kb/answer_general) ใช้ signature ใหม่
- **verify:** test_qa_batch_20260911 เขียน LANG section ใหม่ **17/17** + edge 8 เคสเพิ่มผ่าน + py_compile
- **SRS_SSD.md** อัปเดต 6.2.3 (เพิ่ม `_lang_instruction`/`_LANG_REQUEST_RE`, ลบ `_detect_lang`) + 6.2.4
- **จุดเหลือ:** request ที่เขียนด้วยภาษาแปลกที่ไม่มีใน regex (เช่นฝรั่งเศสบอกตอบเยอรมัน) → ตอบไทยตาม default — เจอจริงค่อยเติมชื่อภาษา
- **deploy:** restart :8010/:8015 แล้ว (kill PID เก่า → relaunch `USE_UNIT_INDEX=charger nohup uvicorn` log `exports/uvicorn_{8010,8015}.log`) — health 200 ทั้งคู่

### ✅ 2026-09-18 — test_200 full run (220 ข้อ LLM จริง) + จดปัญหาที่เจอ

- **ผลรวม 220 ข้อ: 217 ✅ / 2 ❌ / 1 ERR** (run แบ่ง 4 segment เพราะ test client โดนฆ่าซ้ำตอน bot restart — `lsof -ti:8010 | xargs kill` ฆ่า client ที่ connection ค้างด้วย)
- **cert flow live 8/8 ✅** (manual — test_200 ไม่มี cert): type filter ถูกทุกหมวด, model keyword เจอ UNLIST, generic เช็ค 6 certs, FCC ไม่มี→handoff
- **ปัญหาที่เจอ (จดไว้หาจุดแก้รอบหน้า):**
  1. **#132 HTTP 500 — `qa_context` crash**: `knowledge_base.py:1268` `(h.get('topic') or '').split()[0]` → IndexError เมื่อ brand-level QA hit มี topic ว่าง — **kb_qa มี 32 docs topic=''** (general_faq entries) → ทุกแชทที่ QA search คืน doc เหล่านี้ที่ level=brand จะ 500 เหมือนกัน (pre-existing bug ไม่เกี่ยว cert/compat)
  2. **#143 "เอาขึ้นเครื่องไปจีนด้วยได้อ่ะ"** (followup context หัวชาร์จ 67W) → route ไป `general:shipping_policy` ตอบ "ทักแอดมิน" 0 products — คำถามกฎการบินถูก misroute/punt แทนตอบในบริบทสินค้า (หัวชาร์จขึ้นเครื่องได้อยู่แล้ว กฎ Wh ใช้กับ powerbank)
  3. **#199 "มีสินค้า smart home ไหม" (YoupinOfficialStore)** → 0 products + ตอบ generic categories ทั้งที่ร้านมี smart/home NORMAL **98 ตัว** — "smart home" ไม่มีใน taxonomy → หลุด retrieval ไปคำตอบกว้าง
  4. minor: #166 ตอบอังกฤษ (ถามอังกฤษล้วน — พอรับได้); #133 ThaiSuperPhone "งบ 2000" → แนะนำเสื้อยืด (ร้านขายเสื้อจริงแต่คำตอบดูแปลกในร้านมือถือ)
- **ข้อสังเกต infra:** test_200 แก้ให้อ่าน `CHATBOT_INTERNAL_SECRET` จาก env (เดิม hardcode dev-secret → 401 ทั้งชุด); resume script `/tmp/resume_test200.py` (argv=offset) ใช้ซ้ำได้
- **cert regression หลัง fixes:** test_cert_standards 66/66, car_charger 16/16 ยังผ่าน

### ✅ 2026-09-18 — cert merge 4 แหล่ง (stock DB + variant names + desc + OCR) + เลข มอก. ในคำตอบ

- **ทำไม:** user มี stock DB (`itStock.Products`) เก็บ cert flag structured: `is_tis`/`tis_id`/`tis_license_id`/`is_ccc`/`is_ce` — coverage เดิม (desc+OCR) พลาด 173 items; variant names มี token `CN.V (CCC)`/`GB.V (CE)` อีก 616 items ที่ไม่เคยถูกดู
- **แผน:** `docs/plans/cert-merge-plan.md` — เลือก runtime merge (ไม่ใช่ cert_map collection) เพราะ stock เปลี่ยนบ่อย + ไม่ต้องมี pipeline
- **วิธีแก้ (ทำแล้ว):**
  1. `product_store._stock_products_coll()` — lazy `itStock.Products` (env `STOCK_URI`/`STOCK_DB`) degrade→None เหมือน `_admin_image_texts_coll`
  2. `_VARIANT_CERT_RES`/`_VARIANT_MONGO_TERMS`/`_variant_cert_hit()` — version→cert inference: `CN.V`→ccc, `GB.V`/`Global`→**ce** (GB.V = GloBal version ไม่ใช่ GB standard — verify จาก `(GB Ver.)` item 4842405819), `EU`→ce, `US.V`→fcc; explicit `(CCC)`/`(CE)`/`มอก`; `GB/T`→gb เท่านั้น (กัน "128 GB" FP)
  3. `search_cert_products` +param `stock_db` — path 3 stock flags→`shopee_ship_box.item_id`→product docs (`via="stock"`, `cert_ids`={tis_id,tis_license_id}) + path 4 variant regex (`via="variant"`); multi-source→`via="both"`
  4. `handoffs.py` — เจาะรุ่น 1 ผลมี `cert_ids.tis_id` → คำตอบใส่ "เลข มอก. 2879-2560 ใบอนุญาต น 30516-48/2879"
- **verify:**
  - test_cert_standards **66/66** (เดิม 46 + ใหม่ 20: variant tokens 12 เคส + stock/variant paths 8 เคส — 'False' string ไม่นับ, both merge, cert_context มีชื่อ option)
  - real Mongo: ccc=111 items (both 80/variant 17/stock-only), ce=85 (variant 62), tisi=200+ (stock 82+18 both) — เลข มอก. จริงโผล่ใน cert_context
  - QB817 (UNLIST) ถามเจาะรุ่นเจอ `via="both"` ถูก — คำถามทั่วไปกรอง NORMAL ตามเดิม
  - test_car_charger_regression 16/16, py_compile ครบ
  - **post-check (user ขอ):** version tokens กระจาย: ccc=136 items (charger 99/powerbank 98/purifier 9/fan 7), ce=141 (charger 76/powerbank 70/purifier 21/camera 14) — กองหมวด CCC catalog ตามคาด, camera เล็ก edge → hedge ด้วย cert_context
- **SRS_SSD.md** อัปเดต: `_stock_products_coll`, `_variant_cert_hit`, `_STOCK_CERT_FLAGS`, `_VER_RE`/`_VARIANT_CERT_RES`/`_VARIANT_MONGO_TERMS`, `search_cert_products` (4 paths+stock_db+cert_ids), `post_intent_handoffs`
- **impact check ข้าม type (user ขอ — verify ซ้ำบนข้อมูลจริง):**
  - caller เดียวใน prod = `handoffs.post_intent_handoffs` (cert flow) — `search_tisi_products` เป็น compat wrapper ไม่มี caller → blast radius แค่คำถาม cert
  - variant hits ทุก cert: ce=170 items, ccc=178 — eyeball option names ทั้งหมดเป็น version token จริง (GB.V/CN.V/CN Ver./Global V./(CE)/(CCC)) — camera/purifier/fan/monitor/TV stick = Xiaomi GB/CN version จริง ไม่ใช่ FP; tisi/fcc/rohs/gb = 0 hits
  - type_filter ครอบ path 3/4 เหมือน path 1/2 — stock/variant item หมวด A ไม่รั่วตอนถามหมวด B (leaked=0); model_keyword ยังเจอ UNLIST (QB817 via=both)
  - timing ~0.7-2.3s/คำถาม (desc regex scan เป็นหลัก) — variant scan เพิ่ม ~0.3s
- **fix ตาม impact check (4 จุดเล็ก):**
  1. `_stock_products_coll` cache `_cached_stock_client` (เดิม new MongoClient/คำถาม)
  2. `handoffs` แสดงเลข มอก. เฉพาะเมื่อถาม tisi (`"tisi" in _certs`) — คำถาม CE/CCC ไม่แปะเลข มอก.
  3. path 3 ข้าม query เมื่อ certs ไม่มี stock flag (fcc/rohs/gb) — fcc query 1.0→0.5s
  4. stock `cert_context` = "stock: {cert} · เลข มอก. x" (สะท้อน cert ที่ hit จริง)
- **verify หลัง fix:** test_cert_standards 66/66, car_charger 16/16, real smoke ce/ccc/tisi/fcc ปกติ
- **⚠️ deploy:** `STOCK_URI`/`STOCK_DB` ต้องอยู่ใน env ของ bot host (docker-compose .env) — ไม่มี → path 3 ข้ามเงียบๆ (degrade)
- **phase 2 (บันทึกไว้):** negative evidence `is_tis='False'` ตอบ "ไม่มี" เจาะรุ่น; cert on unit card (`model_id` join 99% พร้อมแล้ว)

### ✅ 2026-09-18 — spec-db substring collision → word-boundary match + brand guard

- **เจอจาก audit ของ user:** user ถาม "มั่นใจแค่ไหนว่าจะไม่พัง" → verify สดพบ collision จริงใน index 656 terms:
  - `mi 14 pro` → **iPhone 14 Pro (lightning 23W)** (จริง: usb-c 120W) — alias "14 pro" อยู่ใน "mi 14 pro" และยาวกว่า "mi 14"(5)
  - `mi 11 pro` → **iPhone 11 Pro** — alias "11 pro" เหมือนกัน
  - `ใช้กับ cta56` → **Galaxy A56** — term "a56" ฝังใน product code "cta56"
  - `vivo s25` → **Galaxy S25** — brand ผิด
  - ผลกระทบจริง: connector filter ใช้ spec ผิด → ทิ้งสาย usb-c ทั้งหมดให้ลูกค้าที่ถาม Mi 14 Pro
- **แก้ 2 ชั้นใน `_lookup_spec_db`:**
  1. `_term_boundary_match` — term ต้อง match แบบ token boundary (ต้น/ท้ายไม่ติด ascii-alnum) → "a56" ใน "cta56" ไม่ match, "iphone 5" ใน "5s" ไม่ match; ตัวอักษรไทย=boundary → "ใช้กับiphone17" ยัง match
  2. `_device_brand_hint` + `_spec_brand` — detect brand จาก input (mi/xiaomi/vivo/samsung/ฯลฯ ~20 brands + ไทย); ถ้าเจอ brand เดียวพอดี → รับเฉพาะ entry brand ตรง, ไม่ตรงหมด → None → web fallback; หลาย brand/ไม่มี → longest-match เดิม
- **verify 42/42:** bug cases ทั้ง 5 แก้ถูก (mi 14 pro→xiaomi 14, cta56→None, vivo s25→None→web fallback) + regression เดิมทั้งหมดไม่พัง — brand-guard drop log พิมพ์เพื่อ debug ได้
- **SRS_SSD.md** อัปเดต `_lookup_spec_db` ทั้ง 2 ตาราง
- **บริบท:** user สั่งพัก expansion "ทุกแบรนด์ 20 ปี" (เสี่ยงเขียนข้อมูลผิดจากความจำ ~400 รุ่น) — fix นี้ปิดช่อง collision ของ DB ปัจจุบัน ~140 รุ่น; ยังเหลือความเสี่ยง "fact ผิดใน entry" ซึ่งจำกัดด้วยการคุม entries ให้เฉพาะที่ verify ได้

### ✅ 2026-09-18 — DEVICE_SPECS catalog แทน _KNOWN_DEVICE_SPECS (สเปค hardcode ผิด → structured data)

- **ทำไม:** user ชี้ "spec hardcode บางทีผิด" ขอให้ไปดึง spec จากเว็บ (เสนอ GSMArena) — verify จริงเจอว่า `_KNOWN_DEVICE_SPECS` ผิด: iPhone 17 ใส่ 27W ทั้งที่จริงต้อง 40W+ adapter (PD3.2 AVS); ตารางมีแค่ ~25 รุ่น ขาด iPhone ≤14/iPad/MacBook เก่า/แบรนด์อื่นเกือบทั้งหมด
- **GSMArena direct ไม่ได้:** ติด anti-bot check — ใช้ `web_search.search_and_extract` spot-verify แทน (ดึง spec รุ่นใหม่ได้จริง: iPhone 17 Pro Max 40W, S26 Ultra 60W PPS, Pixel 10 Pro XL 45W PPS)
- **แก้:**
  1. **ไฟล์ใหม่ `device_specs_data.py`** — `DEVICE_SPECS` dict ~140 devices: `{connector, wired_w, wireless_w, protocols[], year, aliases[]}` — ครอบ iPhone ทุกรุ่น (5→17 Pro Max, lightning+usb-c eras), iPad/MacBook, Samsung S/Z/A/Tab 5 ปี, Xiaomi/Redmi/Poco, Huawei/Honor, Oppo/OnePlus/Realme, Vivo/iQOO, Pixel, Nothing, Sony, Asus, Motorola, Infinix/Tecno, game handhelds — แทน `_KNOWN_DEVICE_SPECS` (ลบทิ้งแล้ว — DB ครอบทุก entry เดิม)
  2. **`_lookup_spec_db(name)`** — flat index `term→canonical` (656 terms จาก keys+aliases), match: exact → alias → substring longest (กัน "iphone 17" ทับ "iphone 17 pro max")
  3. **`_resolve_device_spec`** — priority ใหม่: **spec DB → web parse** (เดิม web → hardcode table); structured data ไม่ต้องเดาจาก text
  4. **`_filter_compat_products`** — priority ใหม่: **`_resolve_device_spec` (DB→web) → intent** (เดิม intent ก่อน — intent wattage เป็น LLM guess ผิดได้ เช่น iPhone 17)
  5. **`_device_spec_lookup`** — `_dev_min_watt` resolve: **DB → intent → resolve**; เติม catalog line ลง spec extra: "📋 สเปคจาก catalog: connector=usb-c, ชาร์จมีสายสูงสุด 90W, ไร้สาย 50W, protocols: hypercharge, pd, pps, qc" → LLM เห็น protocol ชัด (เดิมได้แต่ watt จาก web text)
- **verify:**
  - unit `_lookup_spec_db` **32/32**: exact/alias/substring ครบ (mi 17 ultra→xiaomi, s25 ultra→galaxy, "ใช้กับ iphone 17 pro max"→substring) + negatives (ctc615w/ad653u/ipad/macbook/galaxy/brand เดี่ยว/x999 → None หมด)
  - **E2E in-process 7 เคส**: pingevox Q2→สาย 240W/100W (เดิม 60W ผิด) Q3→"ชาร์จเร็วสูงสุด 90W" + หัวชาร์จ 100W/120W; **s25 ultra** (เดิมไม่มีใน list เลย)→"45W USB-C"+สาย 60W; **pixel 10 pro xl**→"45W PPS" cite protocol จาก catalog; **iphone 14**→"Lightning 20W" สาย Lightning (เดิมตารางมีแค่ 12-17); **macbook air m3**→240W
  - stderr: `[DEVICE-SPEC] spec-db hit` + `source=spec-db` ทุกเคส — web search ยังทำงานคู่ขนานหา spec extra/keywords (ไม่ขัดกัน)
- **SRS_SSD.md** อัปเดต 6.15.2 + refactor note (เพิ่ม `_SPEC_INDEX`/`_lookup_spec_db`/`DEVICE_SPECS`, ปรับ `_resolve_device_spec`/`_filter_compat_products`/`_device_spec_lookup`, ลบ `_KNOWN_DEVICE_SPECS` rows)
- **หมายเหตุ:** ค่า wired_w = marketing spec (GSMArena-equivalent + spot-verify) — ยังเป็น curated table แต่ structured + provenance ชัด + อัปเดตจุดเดียว; device ใหม่ที่ไม่มีใน DB → fallback web parse เหมือนเดิม (ไม่มี hardcode gate)

### ✅ 2026-09-18 — generic device-token extractor แทน list ชื่อรุ่น hardcode

- **ทำไม:** user ชี้ "พึ่ง hardcode เกินไป" — spec lookup มี web-search เป็น primary อยู่แล้ว แต่ trigger list เป็นรุ่นเจาะจง 2 จุด: `_device_patterns_fallback` (device_compat) + device list ใน `_extract_charger_constraints` (app.py) → รุ่นใหม่ที่ intent พลาด = ไม่ search spec
- **แก้:** เพิ่ม `device_compat._extract_device_token(msg)` — `_DEVICE_TOKEN_RE` pattern A "letters+digits(+ultra/pro/max/edge/note...)" + pattern B "brand+category+digits" (apple watch 9 / galaxy buds 3 / redmi note 14); กรอง 2 ชั้น: `_NON_DEVICE_TOKENS` stoplist (pd/usb/qc/gen/set/watch-lone...) + product-code shape (letters+digits+letters glued = CTC615W/AD653U)
- **ใช้แทน:** `_device_spec_lookup` fallback + `_extract_charger_constraints` device — list รุ่นเจาะจงถูกลบทั้งคู่
- **`_KNOWN_DEVICE_SPECS` คงไว้:** emergency fallback เท่านั้น (fire เมื่อ intent ไม่ให้ connector AND web search พลาดพร้อมกัน — ปกติไม่ถึง)
- **verify:**
  - unit 24 cases: ดึงได้ iphone 17 pro max / s26 ultra / pixel 10 pro / honor magic 7 / huawei mate 70 / apple watch 9 / redmi note 14 (รุ่นที่ list เก่าไม่มีทั้งหมด) ; กรอง ctc615w / ad653u / pd3.0 / usb 3.0 / gen 2 / set 3 / gan 65w หมด
  - **fallback path จริง (intent_result={}):** "s26 ultra" (list เก่าไม่มี) → resolve → web search "Samsung Galaxy S26 Ultra USB-C 60W" → min_watt=60 → re-query sort adequate-first [65,140,140] ✅ — นี่คือ flow ที่ user ขอ: เจอ device → search spec → ไม่พึ่ง hardcode
  - E2E pingevox regression: Q3 → C2C615 140W ✅, Q4 → AD1203P 120W ✅
- **SRS_SSD.md** อัปเดต 6.15.2 (เพิ่ม `_extract_device_token` + ปรับ `_device_spec_lookup`)

### ✅ 2026-09-17 — pingevox Q3: แนะนำสาย 60W ให้เครื่อง 90W → adequate-first wattage sort

- **อาการ (แชทจริง pingevox, shadow):** "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → ตอบ CTC315P 60W ทั้งที่ context มีสาย 100W/140W/240W ครบ
- **root cause (verify ด้วย repro):** `_device_spec_lookup` re-query sort **wattage asc ล้วน** → สาย 60W อยู่ต้น context, 100W+ อยู่ตำแหน่ง 14-19 → LLM position bias หยิบ 60W เป็น "baseline" ทั้งที่ spec เครื่องต้องการ 90W — `min_watt` resolve ได้ (web text "90W" / `_KNOWN_DEVICE_SPECS`) แต่ใช้แค่ connector filter ไม่เคยใช้จัดลำดับ
- **แก้ (structural, ไม่ hardcode ผูกสินค้า):**
  1. เพิ่ม `_wattage_asc_key(p, min_watt)` ใน `device_compat.py` — ของที่ watt ≥ min_watt (จ่ายไฟพอ spec เครื่อง) ขึ้นก่อนเรียง asc, ของต่ำกว่าไปท้าย, ไม่รู้ min_watt → asc เดิม
  2. `_filter_compat_products` sort เปลี่ยนมาใช้ key นี้ (`device_min_watt` resolve อยู่แล้ว)
  3. `_device_spec_lookup` resolve `_dev_min_watt` (intent → `_resolve_device_spec`) ครั้งเดียว ใช้ทั้ง (a) เติม threshold ชัดใน spec extra: "อุปกรณ์รองรับสูงสุด ~90W → ตัวหลักต้อง ≥90W" (b) sort re-query
- **verify E2E (history format จริง `[สินค้า: xxx]`):**
  - Q3 → context: สาย 100W ขึ้น [2-3], CTC315P ถูกดันท้าย → ANS แนะนำ **CMC615 240W / C2C615 140W** ✅ (2 รอบหลัง fix)
  - Q4 "หัวชาร์จละ" → AD1203P 120W / AD1003T 100W ✅ ไม่กระทบ
  - regression iPhone 17 (min_watt=27): สาย 60W ยังเป็น baseline ได้ถูกต้อง ✅ + COMPAT-FILTER main path ใช้ key ใหม่ ✅
  - unit check `_wattage_asc_key`: None→asc ล้วน / 90→[100,240,0,60] / 27→[60,100,240,0] ✅
- **tests:** test_charger_subtype_parity 42/42 · test_anchor_compare · test_guards · test_car_charger_regression 16/16 ผ่าน — test_pingevox_mistore ยิง HTTP 401 (infra ไม่เกี่ยว)
- **หมายเหตุ:** ยังเป็น prompt+ordering level — LLM อาจพลาดเป็นบางรอบ แต่ context ตอนนี้เอื้อม baseline ที่ spec ผ่านจริงเสมอ; ⚠️ KB path ไม่มี `_filter_compat_products` (connector filter รันเฉพาะ main path) — gap เดิมที่ยังไม่แตะ
- **SRS_SSD.md** อัปเดต 6.15.2 (เพิ่ม `_wattage_asc_key` + ปรับ `_filter_compat_products`/`_device_spec_lookup`)

### ✅ 2026-09-17 — image_texts batch จบ + import Mongo + cert standards search (plan: `docs/plans/cert-standards-search.md`)

**image_texts pipeline สมบูรณ์:**
- batch 8 shards จบครบ err=0 — unique ok **14,005 รูป**, err-only ค้าง 0 (97 error เก่า retry ผ่านหมด); cost รอบนี้ ~$2
- `import_image_texts.py` เพิ่ม `_image_item_ids()` — map `image_id → item_ids` จาก export field_list (logic เดียวกับ `_collect_worklist`) + index `item_ids` → upsert **14,005 docs ทุกตัวมี item_ids** (11,290 new / 2,715 updated); kinds: spec 11,543 / banner 1,355 / product 1,068 / raw 21 / variant_map 18

**cert standards search (มอก./CE/CCC/FCC/RoHS/GB):**
- **ก่อน:** `search_tisi_products` ค้น `description` เท่านั้น → 86 listings ที่บอก มอก. เฉพาะในรูปหลุดหมด (union จริง ~213 listings vs เดิมเห็น ~127)
- **แก้:** `warranty.detect_cert_question` (superset TISI — boundary regex กัน FP: CE ใน "service", GB ใน "128GB", หมอก/เสมอกัน); `extract_tisi_model_keyword` ตัด cert kw + stopword ไทยเพิ่ม (ที่/ร้าน/อะไร — fix bug ที่เจอตอน live: "มีสินค้าที่ผ่าน CE ไหม" → kw='ที่' ฆ่าผลหมด); `product_store.search_cert_products` merge desc+image_texts (`via`=desc/image/both, sellable-first, model_kw→ไม่กรอง status); `handoffs.py` cert block label dynamic + `cert_not_found`
- **compat:** `detect_tisi_question`/`search_tisi_products` เป็น wrapper/cงเดิม
- **verify:** `docs/test/test_cert_standards.py` **31/31** + test_new_product_types 66/66 + py_compile ครบ; **live chat() จริง:** "รุ่นไหนมี มอก. บ้าง"→cert_answer 30 รายการ ✅, "มีสินค้าที่ผ่าน CE ไหม"→CE จริง ✅, "A18T มี มอก. ไหม"→เฉพาะ A18T ✅, "สินค้าผ่านมาตรฐานอะไรบ้าง"→all certs ✅, "หมอกเย็น"→ไม่เข้า cert path ✅; restart :8010/:8015 health 200
- **SRS_SSD.md** อัปเดต: 6.3.1/6.3.6/6.3.7 (search_cert_products + helpers + constants), 6.8.1 (detect_cert_question + tisi fns), 6.17.1 (post_intent_handoffs)
- **replay จริง `shp_152520384227573579`** (CukTechThailand, 10 turns, LLM จริง): Q1/Q2/Q5 cert ตอบถูก ✅; fix เพิ่ม `ทุกรุ่น/ทุกตัว/ทุกอัน/ทุกชิ้น/ทุกสินค้า/ทั้งหมด` ใน `_TISI_GENERAL_KWS` (เดิม "ทุกรุ่นมี มอก ไหม" → kw หลุด → handoff ผิด); **จุดเหลือ:** Q3 "1" บอทตอบอังกฤษ (LLM language slip), Q4 "ทุกรุ่น" ไม่มี cert kw → หลุด cert path (ถ้าจะให้ follow-up สั้นต่อ cert context ต้องเพิ่ม logic แยก), cert_answer list ชื่อเต็มยาว 3k chars (อาจ trim/กรองหมวด)
- **test chat KingGadgets (2026-09-18):** "หาพาวแบง มีมอก มีไหม" → handoff ผิด — root cause `extract_tisi_model_keyword` คืนคำไทยล้วน ("หาพาวแบง") เป็น model → name filter ฆ่าผลหมด ทั้งที่ KingGadgets มีของจริง (tisi 1/ccc 2/ce 6); **fix:** model kw ต้องมี token alnum ≥3 ตัว (รหัสรุ่น AC65B2/A18T) — คำไทยล้วน → "" = คำถามทั่วไป; เลือก token ที่มีตัวเลขก่อน; test 36/36 + live verify: ได้ PowerConnex PCX-P (มอก.) / 3 items (tisi+ccc union) ✅
- **category-aware cert search (2026-09-18):** user ชี้ "PowerConnex ไม่ใช่ powerbank" — generic cert search ไม่กรองหมวด → **fix:** (1) เพิ่ม kw `"พาวแบง"` bare ใน PRODUCT_TYPES powerbank (เดิม detect ไม่ได้เพราะ kw ต้องมี ค์/ก์); (2) `search_cert_products` เพิ่ม `type_filter` + `_name_matches_types` กรอง item_name ด้วย PRODUCT_TYPES regex ทั้ง desc+image path; (3) handoffs ส่ง `_detect_product_types(msg)` เฉพาะตอนไม่มี model_kw — filter แล้วว่าง → re-search ไม่กรองหมวด → ตอบ "สำหรับ{หมวด} ยังไม่พบข้อมูล {cert} แต่สินค้าอื่นที่มีได้แก่..." แทน handoff; **verify:** test 42/42 + live KingGadgets: "พาวแบง+มอก" → 0→fallback ตอบตรงๆ (ไม่เรียก PowerConnex ว่า powerbank) / "พาวเวอร์แบงค์+ccc" → เฉพาะ Aura LPB200NC (Himo/PowerConnex หลุด) ✅; restart :8010
- **tisi regex FP "เสมอกัน" (2026-09-18):** นับ มอก. ต่อร้านเจอ KingGadgets 13 รายการ — user สงสัย → inspect เจอ 2 FP: BINNIFA "เสมอกันที่ 0.8 มม." + Amazfit "อยู่เสมอการแจ้งเตือน" — root cause: "เสมอกัน" เก็บเป็น `[เ][ส][ม][อ][ก]` (เ เป็นสระของ ส ไม่ใช่ของ ม) → lookbehind `[หเ]` เห็น ส ไม่ block; **fix:** เพิ่ม ส → `(?<![หสเ])มอก` ใน `_CERT_SEARCH_RES` + `_TISI_PATTERN` (product_store) + `_CERT_QUESTION_RES` (warranty) + เพิ่ม guard `"เสมอก"` ใน `detect_tisi_question` เดิม; **verify:** test 46/46 + recount: union 449→429, KingGadgets 13→11 (11 จริง = รางปลั๊กมอก.2432-2555 ส่วนมาก SELLER_DELETE เหลือขายแค่ PCX-P), Leravan/Binnifa/QKZ/LuckyHomeMart หลุดออกหมด (เป็น FP ทั้งร้าน) ✅; restart :8010
- **หมายเหตุ:** รูป cert อยู่ใน image scope เดิมอยู่แล้ว (มอก. 119 รูป/GB 227/CCC 19/CE 14) — ไม่ต้อง extract เพิ่ม; งานนี้คือทำให้ runtime ใช้ข้อมูลนั้นได้

### ✅ 2026-09-17 — sellable-first ranking + live stock join + compat gate + suggestion compare (commit `015a9c3`, `80f1da1`)

**E2E verify ผ่าน chat() จริง (LLM จริง):**

| เคส | ผล |
|---|---|
| `หัวชาร์จละ` (KingGadgets) | ✅ context 30/30 sellable — แนะนำของขายได้จริง |
| `ใช้กับ xiaomi 17 ultra` | ✅ เลือก AD653 GaN 90W ถูก (เดิมได้แค่ 45-67W) — product_recommend+target_device หลุดเข้า compat sweep ถูกต้อง |
| `HA835 มีไหม` | ✅ ตอบ "ไม่มีรุ่นนี้" + flag dead ถูก + เสนอทางเลือก sellable |
| `หูฟังแนะนำ` → `อันไหนดีกว่า` | ✅ suggestion-batch fired → CONV-ACTIVE ไม่ pin → ANCHOR-COMP-MERGE 2 ใบ → เทียบของที่เพิ่งแนะนำจริง |
| `รับประกันกี่เดือน` (follow-up) | ✅ ตอบ EC4 12 เดือน จาก anchor |
| `ของเสีย เคลมยังไง` / `ชาร์จไม่เข้า` / `ประกันหมดแล้ว` | ✅ เข้า claim intake + handoff ถูกต้อง |
| `พาวเวอร์แบงค์ 20000 มีสต็อกไหม` | ✅ ตอบจากของ sellable จริง |
| `สายชาร์จ type c ราคาเท่าไหร่` | ✅ ปฏิเสธราคาตาม policy + แนะนำรุ่น |
| `ส่งของกี่วัน` | ✅ shipping_policy KB |
| `พัดลมตัวไหนถูกสุด` | ✅ superlative เลือกตัวถูกสุดจริง |
| `in-ear vs ครอบหู ต่างกันยังไง` | ✅ อธิบายความต่างถูก |
| `หม้อทอดไร้น้ำมัน` (type ตายทั้งหมวด) | ✅ ตอบ "หมด/เลิกจำหน่าย" สุภาพ ไม่เสนอลิงก์ตาย |

**Retrieval matrix quota-free:** 36/37 types ผ่าน (ทุก type: flag ถูก + sellable ขึ้นก่อนเสมอ) — เคสเดียว `phone` 0 sellable = **ของจริงใน catalog** (มือถือขายผ่าน listing "ทักแชทรับโค้ด" ที่ตายหมด) + พบ `product_type=phone` ใน unit index ถูก classify ผิด (เป็นหัวชาร์จ/ขาตั้งที่ชื่อมี "โทรศัพท์") = data issue เดิม ไม่เกี่ยวกับ fix

**เจตนาที่คงไว้:** ของตายอยู่ใน context ตอบ "เคยมีไหม/หมดไหม" ได้ แต่ไม่ชนะของขายได้; code-hit ชนะเสมอ

**ข้อสังเกตเล็กๆ:** suggestion-batch อาจจับคู่เทียบข้าม type (หูฟัง vs กระเป๋า) ถ้า turn ก่อนแนะนำปนกัน — ไม่ใช่ bug แต่ปรับได้ภายหลังถ้ารำคาญ; `[stock]` query ช้า 106s ครั้งเดียว (LLM latency spike ไม่ใช่ logic)

### /logs กระพริบ + scroll เด้งกลับบนทุก 5 วิ (2026-09-17) — ✅ fixed

- **root cause:** `loadLogs` ตั้ง `setLoading(true)` ทุก call → `usePolling` (5s) ทำให้ list ถูกแทนด้วย `<Loading/>` ทุกรอบ → DOM หาย → scrollTop clamp เป็น 0 → ข้อมูลกลับมา remount ที่บนสุด = กระพริบ + เด้งบน
- **แก้:** `loadLogs(silent)` — poll ส่ง `silent=true` (ไม่แตะ loading); manual refresh/filter change ยังแสดง spinner; `onClick={() => loadLogs()}` (กัน MouseEvent ไปเป็น silent)
- **ไฟล์:** `ChatAdminWeb/src/app/(console)/logs/page.tsx` (3 จุด)
- **verify:** `npx tsc --noEmit` ผ่าน — รอ user เช็คหน้าจริง
- **pattern ที่ถูกใน codebase:** poll ไม่ setLoading (ดู test-assignment `loadStats`)

### ✅ 2026-09-17 (ต่อ) — กฎเหล็ก "แนะนำ ≥2 รุ่น" ที่ prompt (llm.py)

- **ทำไม:** user ขอให้บอทเสนอตัวเลือก ≥2 เสมอเมื่อลูกค้าขอคำแนะนำทั่วไป (ให้ลูกค้าเปรียบเทียบได้ + ทำให้ suggestion batch ≥2 ใน timeline เสมอ → compare follow-up มีของเทียบ) — ยกเว้นถามเจาะจงรุ่นเดียว
- **แก้:** `SYSTEM_INSTRUCTION` llm.py — เดิม "แนะนำ 2-3 ชิ้น" แบบ soft → เป็นกฎเหล็ก "ขอแนะนำทั่วไป → ต้องเสนอ ≥2 รุ่น sellable" (pattern เดียวกับ compat dual-tier rule ที่มีอยู่) — ยกเว้น: เจาะจงรุ่น/item card/ถาม spec-สต็อก-ราคา-ประกัน หรือ context มีตัวเดียวจริง (ห้ามแต่งรุ่นมั่ว)
- **verify E2E:** `หูฟังบลูทูธแนะนำหน่อย` → เสนอ 2 รุ่น ✅ · `พาวเวอร์แบงค์มีอะไรน่าสนใจบ้าง` → ≥2 ✅ · `HA835 มีไหม` → ยังตอบเจาะจง + เสนอทางเลือก 1 ตัว (ไม่บังคับ 2 เพราะถามรุ่นเดียว) ✅
- **หมายเหตุ:** นี่คือ prompt-level rule (LLM อาจไม่ตาม 100% — แต่เป็น mechanism เดียวกับที่ codebase ใช้กฎทั้งหมด) ไม่มี hardcode ผูกสินค้า/type

### ✅ 2026-09-17 (ต่อ) — FIX จริง: compare follow-up ตอบ anchor เก่า (ITEM-TAG shortcut ครอบ)

- **อาการ (แชทจริง babyspeed, shadow):** ส่งการ์ด Case → bot แนะนำหูฟัง → "อันไหนดีกว่า/ใหม่กว่า" กลับตอบ "มีแค่ Case รุ่นเดียว" ทั้งที่ timeline มี suggestions อยู่
- **root cause จริง (ลึกกว่า suggestion batch):** item tag `[สินค้า: xxx]` ค้างใน `req.history` ตลอด → ทุก follow-up ถูก history-scan re-pin `_tagged_item_id` → เข้า **ITEM-TAG shortcut** ตอบจาก `products=[anchor_card]` + return ทันที — **ไม่เคยถึง FOLLOWUP-COMP/suggestion batch เลย** (repro ก่อนหน้าหลุดเพราะใส่ "[item]" placeholder ไม่มี item_id)
- **แก้ (structural, ไม่ hardcode):**
  1. `_COMPARISON_FOLLOWUP_KW`/`_SUPERLATIVE_KW` hoist เป็น module const (แชร์ 3 จุด)
  2. ITEM-TAG else-branch: compare/superlative kw + timeline ≥2 สินค้า (`get_anchor_and_suggestions`) → **fall through ไป main flow** (ไม่ตอบจากการ์ดเดี่ยว)
  3. FOLLOWUP-COMP trigger รวม `_SUPERLATIVE_KW` ("ใหม่สุด/ถูกสุด" ก็ต้องมีชุดเทียบ)
  4. `get_latest_suggestion_batch` คืน batch ทุกขนาด — callsite เติม anchor ล่าสุดเป็นคู่เทียบเมื่อ batch=1 (สินค้าที่คุยอยู่ 2 ชิ้นล่าสุด)
- **verify E2E (history format จริง `[สินค้า: xxx]`):**
  - Case → แนะนำหูฟัง → Q3 compare → `ITEM-TAG bypass → suggestion batch (EO008+Case) → merge → เทียบจริง` ✅
  - Q4 superlative "ใหม่สุด" → suggestion batch → ตอบจากของที่คุยอยู่ ไม่ใช่ Case ✅
  - regression: ถาม spec anchor ("รับประกันกี่ปี") → shortcut เดิมตอบเดี่ยว ✅ · compare แต่ timeline มีแค่ anchor → "มีรุ่นเดียว" ถูกต้อง ✅
- **tests:** test_anchor_compare 7/7 · test_guards pass · test_recent_qa_pairs 10/10 · test_compare_3way (exp path) 17 ข้อปกติ

**เสริม (regression guard หลัง user review):** `_SUPERLATIVE_KW` มี "สุด"/"ชาร์จเร็ว" ที่ match กว้าง — เคส "ตัวนี้ชาร์จเร็วไหม" (ถาม anchor เดี่ยว) จะหลุด bypass ผิด → เพิ่ม `_SINGLE_ITEM_REF_KW` (ตัวนี้/รุ่นนี้/อันนี้/ชิ้นนี้/สินค้านี้/เรือนนี้) block ทั้ง bypass และ FOLLOWUP-COMP — verify: "ตัวนี้ชาร์จเร็วไหม" ตอบ Case เดี่ยวถูก ✅, repro หลัก Q3/Q4 ยังผ่าน ✅

### 📊 2026-09-17 (ต่อ) — test_200 selected-100 rerun รอบ 3 (หลัง user แก้ API key)

- **ผิวเผิน:** 100 pass / 0 fail / 0 err — ไม่มี HTTP 500 (race ไม่ trigger — ยัง latent ในโค้ด: `client.close()` บน shared cached client ยังอยู่ app.py:282/300/309/385 + chat_v2.py:1489)
- **LLM errors เหลือ 9/100** — เปลี่ยนจาก `400 API_KEY_INVALID` → `429 RESOURCE_EXHAUSTED` (key ใช้ได้แล้ว แต่ชน quota — เคส #123,#124,#152-160 กระจุกท้ายรัน = rate limit)
- **BUG-A #109 ยืนยันยังพัง:** "พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม" → ตอบ "ยังไม่มีพาวเวอร์แบงค์วางจำหน่าย" ทั้งที่ DB มี **25+ รุ่น** (PB200P 150W / P23 210W / QB826G 210W — ชาร์จ MacBook ได้จริง) — root cause เดิม: charging re-query เชื่อ web extractor "charger" → pool เต็มหัวชาร์จ — P1 (`product_types_override`) ยังไม่ implement
- **ค้นพบเพิ่ม:** CukTechThailand ทั้ง 136 docs `product_type=None` (untyped 100%) — แต่ override ใช้ regex บน `item_name` ไม่ใช่ field → P1 design ยังใช้ได้
- **#132 `เสียงดีสุด` ถูก route:** เพราะ intent LLM ทำงาน — แต่ "เสีย" substring ใน `_CLAIM_REQUEST_INDICATORS` ยังอยู่ = **latent** แสดงตัวเฉพาะตอน intent fail (Run1 เห็นแล้ว)
- **#45/#46 QCY "ไม่มีหูฟัง" = ถูกจริง:** catalog QCYThailand 23 ชิ้น `UNLIST` ทั้งหมด — grounded ✅ (compat #113/#114 ตอบ "รองรับ" เป็นความจริงทางเทคนิค — gray area จดไว้)
- **#136 เจอ path ใหม่:** `superlative_no_match_clarify` — "เอาที่ดีที่สุด" ไม่มี type → ถาม clarify กลับ ✅ (น่าจะจาก parallel session)
- **สรุป:** คุณภาพคำตอบจริงดีขึ้นมากเมื่อ LLM ทำงาน — bug ที่เหลือ = BUG-A (P1 พร้อม) + mongo close race (latent) + "เสีย" boundary (latent) + 429 quota (ops)

### ✅ 2026-09-17 (ต่อ) — BUG-A fixed: charging re-query scope ตาม type ที่ถามจริง

- **อาการ:** "พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม" (CukTechThailand, #109) → ตอบ "ยังไม่มีพาวเวอร์แบงค์" ทั้งที่ DB มี 25+ รุ่น (PB200P 150W / P23 210W / QB826G 210W)
- **root cause:** `_device_spec_lookup` charging re-query สร้าง query จาก `_device_product_type` ที่ **web extractor เดา** ("charger" ทับทุกเคส) → fetch ดึงหัวชาร์จเต็ม pool → LLM สรุป "ไม่มี" จาก context ที่ผิดหมวด
- **แก้ (~25 บรรทัด ไม่มี hardcode สินค้า):**
  - `_CHARGER_FORMS` = {car_charger, wireless_charger, desktop_charger, dock} — เส้นแบ่ง class (degrade-safe)
  - `_charging_scope(msg, asked_type)` = `detect(msg)` ∩ `_CHARGING_TYPES` — 'charger' drop เมื่อมี form เจาะจง (substring artifact ของ "หัวชาร์จ/แท่นชาร์จ") แต่เก็บเมื่อคู่กับ non-form; detect ว่าง → fallback `{asked_type}`; ไม่มี → None
  - re-query ส่ง `product_types_override=_chg_scope` — override ใช้ regex บน `item_name` → ทำงานกับร้าน untyped 100% ได้ (verified CukTech 136 docs type=None)
- **verify:** scope matrix 8/8 · test_compat_mode_filter **45/45** · car_charger_regression **16/16** · general_qtype_guards 27 · qa_context_guard 4/4
- **E2E:** #109 → "ชาร์จได้ — CUKTECH AURA PB100S 30W" (powerbank จริง) ✅ · สายชาร์จ iPhone15 → CTC315P เดิมเป๊ะ ✅ · หัวชาร์จในรถ → **CC903P Car Charger จริง** (OBS-2 ดีขึ้นด้วย — subtype scope แม่นกว่า) ✅
- **ผลกระทบเคสอื่น:** generic charger → {charger} เดิมเป๊ะ · multi-type เก็บครบ · unknown mode ไม่ส่ง override · type ใหม่ใน taxonomy ไม่ต้องแตะโค้ด
- **จดไว้:** PB100S 30W ต่ำกว่า spec MacBook (~70W) — คำตอบบอก 30W ตรงๆ grounded แต่ adequate-first sort อาจควรเลือกรุ่น watt สูงกว่า (ไม่ใช่ wrong-answer — เดี๋ยวดูว่า spec-db มี MacBook Air ไหม)

### ✅ 2026-10-02 — Spec source ladder (P3): web search = ด่านสุดท้าย + ฆ่า prose watt parse

- **อาการ:** ทุก compat query ยิง web search ~6K tok/call (~$0.01) แม้ device อยู่ใน spec-db — web ถูกเรียกตั้งแต่แรกก่อนเช็ก db เลย; + prose `max(\d+W)` ดูด "สายชาร์จ 240W" มาเป็น spec ของเครื่องเป้าหมาย; + re-query พึ่ง web keywords → web fail = pool ว่าง → ตอบผิดหมวด (หัวชาร์จ 65W แทนพาวเวอร์แบงค์)
- **root cause:** ลำดับ source ผิด (จ่ายก่อนฟรี) + เชื่อเลขลอยใน prose + re-query ผูกกับ web keywords
- **แก้ (generic ทุก type/subtype — ไม่มี hardcode keyword):**
  1. `_device_spec_lookup` charging/unknown → source ladder: spec-db → re-query derive เอง (`{subtype_kw} {type_word} {device} {conn_synonyms}` + `_charging_scope`) → catalog evidence `_device_mentioned` (สินค้าระบุชื่อ device ตรง = declared compat) → **web เฉพาะเมื่อไม่มีหลักฐาน** → web keywords re-query เพิ่ม → intent min_watt สำรอง
  2. `_CONN_QUERY_KW` — connector→query synonyms (vocab map เดียวกับ `_extract_product_connectors`)
  3. `_device_mentioned` — boundary match + no-space variant ("iPhone18" = "iphone 18") บน name/description
  4. `_resolve_device_spec` — **ลบ prose watt parse**: เชื่อเฉพาะ connector vocab; watt ต้องมาจาก structured (spec-db/web-structured/intent) เท่านั้น
  5. min_watt chain consistent: spec-db → web-structured → intent (lookup+filter ตรงกัน)
- **verify:** test_compat_mode_filter **70/70** (เพิ่ม section 10 — spec-db hit→ไม่ web, catalog hit→ไม่ web, ทุกชั้นพลาด→web, intent-only→web, prose→connector only) · car_charger 16/16 · guards 27+4+7+10 ผ่าน
- **E2E จริง:** "พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม" → spec-db hit macbook(70W) → re-query scope={powerbank} merge 64 → sort ≥70W ก่อน → **ตอบ PB200P 150W + PB250 210W** (ก่อนหน้า: หัวชาร์จ 65W) — **0 web call** · สายชาร์จ iphone15 → CTC315P ✅ · เคส/หูฟัง เดิมเป๊ะ
- **ผลกระทบเคสอื่น:** model_fit/self_compat/skip path ไม่แตะ · non-compat intents ไม่แตะ · web search ยังทำงานเป็น fallback เมื่อ device แปลก/ไม่มีหลักฐาน · prose connector parse ยังอยู่ (ตัว load-bearing ของ filter)
- **จดไว้:** unit-index compat re-query ใช้ `is_compat_check=True` เดิม (ข้าม unit path) — ถ้าอนาคตอยากให้ compat ใช้ units ต้องทำ field-filter sweep แทน vector-only (limit ไม่ใช่ตัวจำกัด — similarity ต่างหาก)

### ✅ 2026-10-02 (ต่อ) — spec-db expansion ~10 ปี + outer web-search gate

- **งาน:** เพิ่ม `DEVICE_SPECS` ครอบคลุมย้อนหลัง ~2016-2026 ทุกแบรนด์ (มือถือ/แท็บเล็ต/หูฟัง/ล็อปท็อป/แก็ดเจ็ต) — user สั่ง: "เก็บเป็นชุดข้อมูลได้ถ้าสเปคเดียวกัน"
- **ทำ:**
  - `device_specs_data.py`: 249 → **516 entries** — เพิ่ม Samsung Note8-20/S7-S10/A-J-M/Tab เก่า, AirPods ทุก gen, iPad lightning era, Galaxy Buds, Sony WF/WH, Redmi Buds, FreeBuds, Enco, JBL, Bose, Beats, Marshall, Mi 8-10, Redmi Note 7-11, Poco F/X/M, Oppo F/Reno เก่า, Realme, OnePlus 5-9/Nord, Vivo V/Y, Huawei P/Mate/Nova, Honor, Pixel 1-5a, Xperia, Zenfone/ROG, Motorola edge/g/razr, MatePad/Lenovo Tab/Oppo Pad, **Windows laptops** (Dell XPS/Inspiron, HP Spectre/Envy/Pavilion/Elitebook/Omen, ThinkPad/Yoga/IdeaPad/Legion, Zenbook/Vivobook/TUF/ROG, Acer Swift/Aspire/Nitro, MSI, Surface), wearables (Huawei/Amazfit/Garmin/Fitbit/Xiaomi watch), GoPro/Kindle/JBL speaker/Switch Lite + **generic entries** (iphone/ipad/notebook — query ลอยไม่มีรุ่น)
  - shared spec templates `_T_*` (25 templates) — รุ่นที่ spec เหมือนกัน `{**_T_x, year, aliases}` แก้จุดเดียวทั้งชุด
  - `device_compat.py`: `_SPEC_HEAD_BRAND` + `_DEVICE_BRAND_HINTS` เพิ่ม brand ใหม่ (sony/asus/moto/infinix/tecno/itel/nokia/zte/meizu/lenovo/lg/htc/nintendo/valve/microsoft ฯลฯ)
- **เจอระหว่างทำ (fix เพิ่ม):** `should_use_web_search` rule `compatibility_check_device_specific` ยิง web เสมอเมื่อข้อความมี "แบรนด์+เลขรุ่น" — แม้ spec-db grounded แล้ว (redmi note 9 จ่าย 5,784 tok/$0.009 ฟรีๆ) → เพิ่ม gate: `target_device` อยู่ใน spec-db → ข้าม `device_specific`+`short_answer` trigger (negative/no_products ยังทำงาน) — lazy import `_lookup_spec_db` ไม่ cycle
- **verify:** test_compat_mode_filter **144/144** (เพิ่ม section 11: มือถือเก่า/connector micro-usb-lightning/หูฟัง/แท็บเล็ต/laptop/gadget/shared-template/brand-guard/generic/outer-gate) · car_charger 16/16 · guards 27+4+7+10 ผ่าน
- **E2E:** `redmi note 9` → spec-db hit (usb-c 18W) + **0 web call** (ก่อน: จ่าย $0.009/ครั้ง) · `macbook` → PB200P/PB250 เดิมเป๊ะ 0 web · `ชาร์จ notebook ได้ไหม` → generic notebook 65W → แนะนำ GaN 65-100W ✅
- **ผลกระทบเคสอื่น:** lookup logic ไม่แตะ (data เท่านั้น) · brand guard กัน alias ข้ามแบรนด์ (oppo a73→None, xiaomi x9→None) · dupe keys 6 ตัวถูกลบ (spec ซ้ำของเดิม) · alias ไทย 4 สะกด
- **จดไว้:** ไฟล์ `test_compat_mode_filter.py` ถูก IDE/watcher revert 2 รอบระหว่างทำ — ต้องเขียนแบบ atomic ผ่าน shell · server 8020 (unit-index) ยังรันโค้ดเก่า

### ✅ 2026-09-21 — Phase 0 (QA remaining-bugs plan): T1-T4 output boundary + extraction + human-request

แพลน: `docs/plans/2026-09-21-qa-remaining-bugs-plan.md` (review 5 รอบ) — RC-A ไม่มี trust boundary LLM→ลูกค้า / RC-B claim state / RC-C keyword whack-a-mole / RC-D error ดิบหลุด / RC-E วัดไม่ได้

- **T1 (BUG-Q error ดิบถึงลูกค้า):** llm.py มี 6 จุดคืน `f"...({exc})"` แนบ exception → เพิ่ม `LLM_ERROR_REPLY` + `_error_reply()` — ลูกค้าได้ข้อความสุภาพเดียวกัน, exception log ฝั่ง server
- **T2 (NEW-1 ชื่อขยะ + order_sn):**
  - root cause: `_THAI_NAME_FALLBACK_RE` ใน `extract_customer_info` เชื่อ text ที่ clean แล้วเป็นชื่อคน → "ขอบคุณ"/ชื่อสินค้ากลายเป็นชื่อ → **ลบทิ้ง** เหลือ NER + EN-name pattern; เพิ่ม reject เมื่อชื่อ EN ติด model/ตัวเลข ("Pro Max" จาก "iPhone 15 Pro Max" ไม่ใช่ชื่อ)
  - `_PHONE_PATTERN` ใช้ `\b` → normalize ลบ space แล้วเบอร์ติดตัวไทยไม่ match → เบอร์หลุดเป็น order_id → แก้ boundary ให้กัน digit adjacency แทน
  - mask เบอร์ก่อน scan order_id ทั้ง `extract_customer_info`/`detect_purchase_date_and_order`; order_id ถึง 19 หลัก
  - `order_store.extract_order_sn` เพิ่ม fallback เลขล้วน 15-19 หลัก (`_ORDER_SN_RE` บังคับมีตัวอักษร → Shopee sn ตัวเลขล้วนไม่ถูกจับ)
- **T3 (BUG-M human-request):** flat keywords จับ "ติดต่อเจ้าหน้าที่/แชทกับเจ้าหน้าที่/ติดต่อร้านค้า" ไม่ได้ → เพิ่ม composition verb+target regex (คน guarded `(?!ละ|ขับ|ส่ง|รับ)`) + ร้าน-rule (contact verbs เท่านั้น) + English — **แก้ FP เดิมด้วย:** ลบ flat "ขอคน/ติดต่อคน/พูดกับคน/ส่งต่อคน" ที่ match substring ("ขอคนละครึ่ง"/"พูดกับคนขับ" เคยโดน handoff ผิด)
- **T4 (RC-A trust boundary):** `chat()` → `_chat_impl` + thin wrapper เรียก `guards.enforce` (ครอบ legacy/v2/v3 — funnel /chat จุดเดียว); rules-as-data `_ESCALATE_RULES`: answer อ้าง "แอดมินรับเรื่องแล้ว/เคลมเรียบร้อย" แต่ `handoff_to_admin=False` → **`_send_handoff` จริง** + แทนข้อความ + set flag (เดิม `_false_admin_patterns` ใน llm แก้แค่คำ ไม่ส่งจริง → ลบออกจาก `_strip_kb_markup`); `answer == LLM_ERROR_REPLY` → escalate; fail-open
- **verify:** py_compile ทุกไฟล์ · test_guards pass · car_charger 16/16 · qtype_guards 27/27 · subtype_parity 42/42 · probe บน :8030 — human-request ใหม่ handoff ถูก / "คนละครึ่ง"/"คนขับ"/"แอดเพื่อน" ไม่หลุด · extract: ชื่อไทย/EN/เบอร์/order 19 หลัก ถูก, "ขอบคุณ"/"Pro Max" ไม่กลายเป็นชื่อ · enforce: false-admin claim → handoff_to_admin=True + ข้อความถูกแทน
- **ผลกระทบเคสอื่น:** NER path เดิมไม่แตะ (ชื่อจริงยังจับได้) · flat kw ที่เหลือครบคำเดิม · enforce ไม่แตะ resp ที่ handoff แล้ว · v2/v3 ผ่าน wrapper อัตโนมัติ · skip: rewrite-rule (นโยบายไม่มี grounding) = T7 Phase 2 ตามแพลน

### ✅ 2026-09-21 — Phase 1 (QA plan): T5 claim-state fill-once + T6 order-problem routing

- **T5 (RC-B claim ถามซ้ำ/กลืนคำถาม):**
  - root cause หลัก: legacy `warranty_flow.py` เคลียร์ `claim_state` ทุกครั้งที่ handoff แต่ State-7 receipt ก็ handoff → save→clear ใน turn เดียวกัน → fill-once พัง; v2 (`handle_warranty_flow`) ไม่ load/save claim_state เลย; `purchase_date` ไม่เคยถูก save
  - helpers ใหม่ (warranty_flow.py:34-124, ใช้ร่วม 2 engines): `_is_question_msg` (question markers กัน swallow), `_merge_claim_slots` (ข้อความปัจจุบัน ∪ persisted — ค่าปัจจุบันชนะ), `_claim_collecting` (persisted marker: stage=collecting หรือมี slot → info resume ได้แม้ last model msg ไม่ใช่ claim prompt), `_update/_clear_claim_state` wrapper, `_maybe_clear_claim_state` (clear เฉพาะ terminal reasons + ข้ามเมื่อ answer ยัง "รบกวนแจ้งข้อมูล"/"ได้รับข้อมูล" — กัน ask-info prompt ที่ใช้ reason in_warranty ลบ state)
  - legacy: State-7 gate ขยายด้วย `_claim_collecting` + merge+persist (incl. purchase_date) + BUG-D fallback มี question-fallthrough (คำถามล้วน+ไม่ใช่ claim request → ปล่อย pipeline ปกติตอบ) + ticket closed → clear state; v2: load claim_state + merge ทุก collection branch + persist + mark stage=collecting ตอนเริ่มขอข้อมูล
  - **เจอ regression ตอน probe (แก้แล้ว):** ลูกค้าแทรกคำถามกลาง flow แล้วส่งเลข order ต่อ → `early_order_flow` ดักเป็น order_lookup (เช็ค `_in_claim_flow` จาก last model msg อย่างเดียว) → เพิ่ม check persisted `claim_state` ผ่าน `_claim_collecting` ใน order_flow.py:64-74 → resume ทำงาน + bare order ปกติยัง order_lookup
- **T6 (ส่งผิด/ของขาด/ของแถมขาด → แอดมิน ไม่ใช่เคลม):**
  - root cause: `_RETURN_REFUND_KWS` มีแค่คำกลุ่มคืนของ/คืนเงิน → fulfillment complaints หลุดลง LLM intent → โดนจัด warranty_claim เข้าฟอร์มเคลมผิดประเภท
  - แก้: ขยาย class "ปัญหาออเดอร์ที่ต้องส่งแอดมิน" ใน `early_order_flow` — `_ORDER_PROBLEM_*` composition (context×fault) + direct phrases + hypothetical guard ("ถ้า/สมมติ/ในกรณี/หาก" ข้าม) + topic classifier; reuse path เดิมเป๊ะ: มี order_sn → anchor+handoff `reason=order_problem`+topic / ไม่มี → ถามเลข → follow-up (marker "สินค้าที่ได้รับ/ปัญหาการจัดส่ง/ของแถม/ของไม่ครบ" ใน `_is_rr_followup` + `_rr_followup_order_problem` แยก kind)
  - priority: match ทั้งคู่ → return/refund ชนะ (behavior เดิม); `not _in_claim_flow` guard ทั้งตอน detect + follow-up (ไม่ดึงคนออกจากเคลม)
  - fault list ไม่มี "เสีย/พัง/ใช้ไม่ได้" — defect ยังไป warranty เหมือนเดิม
- **verify:** py_compile · probe :8030 — "ส่งของผิด/ของแถมไม่ครบ/แกะกล่องของขาด/ยังไม่ได้รับของ" → `order_problem_ask_order` · +order_sn → `order_problem_handoff` reason=order_problem+topic · follow-up order-problem→order_problem / return-refund→return_refund (kind ถูก) · "ส่งผิด ขอคืนเงิน" → return_refund ชนะ · negatives: "มีของแถมไหม"→product_store, "สินค้าเสีย"→warranty_claim, "เปลี่ยนได้ไหม"/"ถ้าส่งผิดทำยังไง"→return_policy (ไม่ handoff) · T5 live: fill-once merge เลข order จาก turn ก่อนใน review, question fallthrough → warranty_policy จริง, resume หลังคำถาม → claim รับ order_sn+persist, claim_state ใน DB ถูก · regression: guards ✓ qtype 27/27 parity 42/42 car_charger 16/16
- **ผลกระทบเคสอื่น:** bare order_sn ไม่มี claim → order_lookup เหมือนเดิม · return/refund path ไม่เปลี่ยน (เพิ่ม flag เฉยๆ) · warranty defect flow ไม่แตะ · tracking/anchor path เหมือนเดิม (ข้ามเฉพาะเมื่อ claim_state collecting)

### ✅ 2026-09-21 — Phase 2 (QA plan): T7-T11 output grounding + card suppress + image anchor + cleanup

- **T7 (RC-A tier-2 — claim ไม่มี grounding ใน context):**
  - root cause: guard เดิม escalate ได้เฉพาะ "อ้างว่าแอดมินทำแล้ว" — แต่ LLM แต่ง "มีของแถม/คืนเงินได้" โดยไม่มีหลักฐานใน product context ผ่านไปถึงลูกค้าได้
  - แก้ (guards.py): `_REWRITE_RULES` rules-as-data — promo claim (มีของแถม/แถมฟรี/ลดเหลือ/ส่งฟรี/โปร ฯลฯ) + return claim (เปลี่ยนได้/คืนเงินได้/รับคืน); `_claim_grounded` เช็ค grounding จาก `resp.products` จริง (description_excerpt/raw_description kw + has_promotion/is_flash_sale flags — คือ context ที่ส่งให้ LLM จริง ไม่ต้อง plumb เพิ่ม); `_REWRITE_SKIP_PREFIXES` ข้าม source ที่ context เป็น policy/order อยู่แล้ว (general:/order_/warranty/return_refund/human_request ฯลฯ); lookbehind กัน negation ("ไม่มีของแถม" ผ่าน)
  - **เจอ defect ตอน live probe (แก้แล้ว):** แทนที่เฉพาะ span ที่ match → เศษ claim ค้าง ("...TA3005U ที่มี[REPLACED]แถม Adaptor") → `_replace_clause` หา clause boundary (`\n`/`|||`/`.!? `/particle ไทย+space) แล้ว swap ทั้ง clause + collapse particle ซ้ำ
- **T8 (NEW-7 การ์ดมั่ว):** intent ∈ {warranty_claim, general_question, other} + ข้อความไม่มี `_PRODUCT_MENTION_KWS` → `products_for_response=[]` (ทั้ง path ปกติ + web-search branch); hoist `product_kw` → `product_store._PRODUCT_MENTION_KWS` เป็น single source (ใช้ร่วม `_clean_description` + gate)
- **T9 (NEW-6 รูปไม่ผูกสินค้า):** `image_desc` → `extract_model_keywords` → item_name regex → **match ตัวเดียวเท่านั้น** → set `_hybrid_anchor_card` (desc กำกวม match ≥2 → ปล่อย flow ปกติ); อยู่หลัง item-tag block ก่อน retrieval → anchor เข้า narrowing/compare ปกติ
- **T10 (cosmetic):** `_strip_kb_markup` — markdown table `| a | b |` → `• a: b · c: d` (Shopee render ตารางไม่ได้) + collapse "ทางร้าน จะ"→"ทางร้านจะ"
- **T11 (NEW-8 dump list ดิบ):** `answer_general` — brands/categories ถ้าคำถาม specific ให้ตอบจาก context ก่อน ห้าม echo list ดิบ (เคส "CUKTECH คือ ZMI เดิมไหม" เคยได้ brand list ทั้งก้อน)
- **verify:** py_compile ทุกไฟล์ · unit probe 8+7 เคส (ungrounded→rewrite clause สะอาด / grounded flag+desc→ผ่าน / negation→ผ่าน / general source→ข้าม / escalate ชนะ rewrite) · live :8030 — greeting/sticker/thanks/complaint → cards=0, product-q → cards=10, "มีของแถมไหม" → ตอบสะอาดหลัง fix clause, "CUKTECH คือ ZMI เดิมไหม" → ตอบเฉพาะเจาะจงไม่ dump, T6/T5 path เดิมไม่หลุด · regression: guards ✓ qtype 27/27 parity 42/42 car_charger 16/16
- **ผลกระทบเคสอื่น:** rewrite tier แตะเฉพาะ answer ที่ claim โปร/เปลี่ยนคืน ungrounded เท่านั้น · card suppress มี product-kw escape hatch (complaint ที่ถามสินค้ายังได้การ์ด) · image anchor ต้อง match ตัวเดียว+ไม่มี ref อื่น → ไม่ทับ anchor เดิม · T9 live-verify จำกัด (ต้องส่งรูปจริง) — logic มี guard ครบ
- **เหลือ:** Phase 3 (T12-T16 — replay เคสเดิม / audit no_product_found_handoff / shadow batch / price prohibition / corpus) เป็นงาน verify/measure ไม่ใช่ code fix

### ✅ 2026-09-21 — Phase 3 (QA plan): T12-T16 verify/measure — audit เสร็จ เจอ bug จริง 1 ตัว

- **T12 (replay BUG-H/K/O):** "Luxury Black" / "ROSY" / "BINNIFA" / "Pad 7" → ตอบ "ไม่มี/ไม่พบ" ถูก shop-scope ครบทุกเคส + เสนอของใกล้เคียงจากร้านจริง — ไม่มี cross-shop fabrication เดิม
- **T13 (audit no_product_found_handoff ไม่เคย fire):** root cause 2 ชั้น — (1) arm1 `not products` แทบเป็นไปไม่ได้ เพราะ vector path `argsort(sims)[:top_k]` **ไม่มี similarity floor** คืน nearest เสมอ; (2) arm2 ถูก `_is_conv_active` ∈ `_guard_has_intent` ปิดเงียบ — แชทที่มี anchor อยู่แล้ว arm2 ตายเสมอ; fire ได้เฉพาะ fresh conv + ของแปลกไม่ติด kw + "มี...ไหม" · สังเกต: guard return ก่อน web-search (fire แล้วไม่ลอง web) — เป็น design เดิม ไม่แตะ
- **T14 (NEW-9 bot_elapsed_ms):** เจอ bug จริง = **unit mismatch** — `/chat` คืน `elapsed` เป็นวินาที แต่เขียนลง `bot_elapsed_ms` ดิบๆ (shadowReplyService ×2, botWorkerService, test-assignment ×2) → 4.2s แสดง "4.2ms" → ดูเหมือน 0/พัง; `bot_tokens` เก็บ usage ครบอยู่แล้ว (BUG-I ok) — **รออนุญาตแก้ (×1000 ที่ write sites หรือแปลงตอน display)**
- **T15 (price prohibition):** prompt มีครบ (llm.py:198-200/504-506/535/546/1518 "ห้ามบอกราคาทุกกรณี") → leak ถ้ามี = LLM non-compliance ไม่ใช่ missing prompt — ไม่ต้องแก้
- **T16:** เพิ่ม `misinterpret_monitor` 4 เคสเข้า corpus generator (ย่อ=สรุปสั้น / ปิด AOD) — corpus regen 304 ข้อ

### ✅ 2026-09-21 — NEW-9 fix: bot_elapsed unit mismatch (seconds→ms)

- **error:** `bot_elapsed_ms`/`bot_elapsed` แสดง "4.2ms" ทั้งที่จริง 4.2 วินาที — ดูเหมือน elapsed=0/พัง
- **root cause:** `/chat` คืน `elapsed` เป็น**วินาที** แต่ write sites เก็บดิบลง field ที่ชื่อ/แสดงเป็น **ms**
- **fix:** `Math.round(elapsed * 1000)` (คง `undefined` เมื่อไม่มี elapsed — ไม่เขียน 0 ซ้ำอาการเดิม) ที่ 9 sites / 4 ไฟล์: `shadowReplyService.ts` ×2, `botWorkerService.ts`, `liveAssignmentService.ts` ×4, `test-assignment/route.ts` ×2
- **ไม่แตะ:** bot python (`elapsed` วินาทีถูกตาม schema) + display logic (อ่านเป็น ms ถูกแล้ว)
- **doc เก่าใน DB** ยังเป็นวินาที (โชว์เล็กผิดหน่วย) — **user ตัดสินใจไม่ backfill** (ปล่อยให้ข้อมูลใหม่ไหลทับ; 2026-09-21)
- **verify:** `npx tsc --noEmit` clean · grep ไม่เหลือ write site ดิบ

### ✅ 2026-09-22 — Residual-bugs batch (QA notes 2026-09-15 leftovers): frustration + rewrite-tier ext + vision-fail + answer_general

- **BUG-M part D (ลูกค้าโกรธไม่ escalate):** `handoffs.detect_human_request` เพิ่ม anger detection — strong markers (ผิดหวัง/หัวร้อน/โกรธ/โมโห/เซ็ง/ห่วย/กาก/แย่มาก/ตีของกลับ/ไม่ไหวแล้ว) fire เดี่ยว; mild complaints (ช้ามาก/รอนาน/ไม่มีใครตอบ/เงียบหาย/ตอบช้า) มี question-guard (ไหม/มั้ย/แค่ไหน/เท่าไหร่/กี่วัน/เมื่อไหร่/ป่าว/บ้าง) → "ส่งช้าไหม"/"รอนานแค่ไหน" ไม่หลุด; handoff `reason=customer_frustration` + ข้อความขอโทษ; verify: unit 21/21 + live :8030
- **BUG-K (claim พร้อมส่งทั้งที่หมด):** `_REWRITE_RULES` เพิ่ม `stock_claim` (พร้อมส่ง/เช็คสต็อก/มีสต็อก/เหลืออยู่/in stock) — mode "stock": grounded เฉพาะเมื่อมี card `_available_for_sale` (หรือ grounding_text ยืนยัน); ไม่มี → rewrite "ขอแอดมินตรวจสอบสต็อก"
- **NEW-3 residual (general: ขัด KB):** เดิม skip `general:*` ทั้งหมด → LLM ขัด KB ตัวเองผ่าน (Youpin "เปลี่ยนได้" ทั้งที่ KB ห้าม) — ตอนนี้ app.py แนบ `routing_decision["grounding_text"]=context[:2000]` ที่ general/brand paths → enforce verify claim เทียบ KB จริง; grounding polarity-aware (`_pos_grounded`: pos pattern ที่ไม่มี ไม่/ห้าม/หมด ใน 20 chars ก่อนหน้า — "ไม่รับคืน" ไม่ ground "เปลี่ยนได้" อีก)
- **NEW-6 residual (แต่งชื่อรุ่น):** `model_claim` — token `[A-Z]{2,}\d{2,}[A-Z]*` ใน answer ที่ไม่อยู่ใน `_context_pool` (cards+grounding_text+message+history+image_desc) เลย → rewrite; boundary ASCII lookaround (ทำงานในไทยติดกัน "รุ่นWPB100P"); stoplist spec (IP66/PD65W/USB30/WiFi6); token ที่ลูกค้าถามเอง/history เคยพูด = grounded ผ่าน
- **NEW-10 (vision fail):** `app.py` vision pass — `_urls_to_read` ไม่ว่างแต่ `_new_desc` ว่าง/error → inject failure note เข้า `_vision_context` ("อ่านรูปไม่ได้ ห้ามเดา ขอส่งใหม่/พิมพ์อธิบาย") — ก่อนหน้า LLM ตอบเหมือนไม่มีรูปหรือแต่งเนื้อหา; `_new_desc` init ก่อน try (กัน NameError เมื่อ describe_images raise)
- **NEW-8 residual:** `answer_general` instruction "ตอบเฉพาะที่ถามจาก context/ห้าม dump list/ห้าม bare ทักแอดมิน" ขยายจาก brands/categories → ทุก qtype
- **verify:** py_compile ครบ · unit probe 19/19 (stock/model/polarity/general-grounding/negation/history-grounded) · live :8030 — anger→customer_frustration, คำถามไม่หลุด, รูป 404 → "ภาพเปิดดูไม่ได้ ส่งใหม่", shipping → ตอบรายละเอียดจริง · regression: guards ✓ qtype 27/27 parity 42/42 car_charger 16/16
- **ผลกระทบเคสอื่น:** anger ชนะ claim path (ตั้งใจ — ลูกค้าโกรธได้คนทันที) · stock_claim แตะเฉพาะ answer ที่ claim stock ชัด (negation ผ่าน) · model_claim ไม่แตะ token ที่อยู่ใน context · rules re-scan ≤4 รอบกัน multi-clause claim · general: ที่ไม่มี grounding_text ยัง skip เหมือนเดิม
- **ยังเหลือ (ต้องทำต่อถ้าจะเอา):** BUG-I token bloat (measurement มีแล้ว แต่ยังไม่มี cap/trim) · KB data gaps (มอก.ต่อร้าน/ชื่อแอพ/ศูนย์ — เป็น data ไม่ใช่โค้ด) · anchor swap PB100→LPB100 ระดับ retrieval (model_claim กันเฉพาะชื่อที่ไม่อยู่ใน context)

### ✅ 2026-09-22 — Plan B: anchor/retrieval swap (PB100→LPB100) — bounded model matching

- **error:** ลูกค้าถาม "PB100" → cards/anchor/ตอบ เป็น "PB100P"/"LPB100" (รุ่นใกล้) — QA NEW-6 residual
- **root cause (3 ชั้นซ้อน):**
  1. substring match `token in name` — "pb100" ⊂ "lpb100"/"pb100p" → exact-match/diversity bucket/TEXT-ANCHOR/anchor resolve ผิดรุ่น
  2. Mongo regex `alpha.?rest` (เช่น `PB.?100`) unbounded ทั้งสองปลาย + `re.escape(token)` ดิบใน Direct-regex — match PB100P/LPB100 แล้ว `insert(0)` ดันขึ้นหน้า list
  3. `_extract_model_tokens` คืน [] เมื่อ query มีรุ่นเดียว → vector path ข้ามทั้ง regex-augmentation และ diversity → listing ที่มี "PB100" จริงไม่เคยเข้า candidate set (top_k ตัดทิ้ง)
- **fix:** helper เดียว `product_store._model_token_in_name(name, token)` + `_model_token_regex_str(token)` — token ที่มี letter+digit (model code) match แบบ bounded `(?<![A-Za-z0-9])T\s*O\s*K\s*E\s*N(?![A-Za-z0-9])` (space-insensitive "EC 4"↔"EC4", กัน prefix/suffix); token alpha-ล้วน/digit-ล้วน คง substring เดิม (brand/device names)
  - ใช้ร่วมกัน: `product_store` (exact-match promotion, `_doc_matches_model`/diversity, vector augment+promotion), `conversation_products.resolve_active_by_message`, `knowledge_base._search_kb_single` (KB model scope), `app.py` ×5 (KB-MODEL-REGEX, MODEL-REGEX, Direct-regex, image-anchor regex, TEXT-ANCHOR, part-flow, kb_missing, comp-ref filter)
  - `_extract_model_tokens` refactor → `_raw_model_tokens` (ทุก token) + wrapper เดิม (≥2 gate สำหรับ diversity)
  - vector path: augment ด้วย raw tokens (รุ่นเดียวก็ดึง doc ที่ชื่อมี token จริงเข้า candidate) + promote bounded-exact หน้า list
  - TEXT-ANCHOR scan ขยาย [:3]→[:5] (bounded match ทำให้ listing จริงที่อันดับ 4 ยัง anchor ได้)
- **verify:** unit 15/15 (PB100 ✓ / LPB100 ✗ / PB1000 ✗ / PB100S ✗ / PB 100 ✓ / EC 4↔EC4 ✓ / ไทยติดกัน ✓) · live :8030 — "PB100 มีไหม"→cards PB100 จริง+anchor ถูก, "รุ่นนี้"→CONV-ACTIVE reuse anchor ตอบตาม listing เดิม, "LPB100"→LPB100 listings · Mongo regex ทดสอบตรง: คืนเฉพาะ listing ที่มี PB100 standalone · regression guards ✓ qtype 27/27 parity 42/42 car_charger 16/16
- **ผลกระทบเคสอื่น:** query "LPB100" เดิมอาจ match PB100-only listing → ตอนนี้ได้ LPB100 จริง; pure-alpha/pure-digit tokens ไม่เปลี่ยน; typo-fuzzy prefix (biokoopp→biokoop) คงเดิมใน non-digit branch
- **เหลือ:** Plan A KB data gaps (รอตัดสินใจ) · BUG-I token bloat

### ✅ 2026-09-22 — Issue #17 (critical): /health ปิด shared MongoClient → /chat 500 สุ่มทุก 30 วิ

- **error:** `InvalidOperation: Cannot use MongoClient after close` → `POST /chat` 500 สุ่ม — production วัด 9 ครั้ง/ชม., 10% ของแชททดสอบล้ม
- **root cause:** `_db()` คืน singleton client จาก `get_client()` แต่ 5 จุดเรียก `client.close()` — /health (docker healthcheck ทุก 30 วิ = ตัวหลัก), /shops, /categories, /brands, `chat_v2()` finally — ปิด client กลาง request อื่นที่ถือ `db` อยู่ · docstring `_db()` โกหกว่า "stateless เปิดใหม่ทุกครั้ง" → บักกลับมารอบ 2
- **fix:** ลบ `client.close()` ทั้ง 5 จุด (try/finally ที่มีแค่เพื่อ close ถูกยุบ+dedent) · เพิ่ม `@app.on_event("shutdown")` `_shutdown_db_clients()` ปิดทั้ง product + admin singletons ตอน process จบเท่านั้น · แก้ docstring `_db()`/`get_client()` เตือนห้าม close
- **verify:** live :8030 — /health ×3 + /shops(auth) ×2 คั่นกลาง /chat → ทุก request 200, "Cannot use MongoClient after close" = 0 · py_compile ครบ
- **ผลกระทบเคสอื่น:** export_mongo.py (script แยก client เอง) ไม่แตะ · chat_v2 `_build_context` ยังคืน client เดิมใน tuple (ไม่มีใคร close แล้ว) · connection อยู่จน process shutdown — พฤติกรรมที่ถูกของ singleton

### ✅ 2026-09-21 — DX: SIM sessions ตอบว่าง (Black Shark Pad 7 warranty + อีก 3) = issue #17 บน prod

- **อาการที่ user รายงาน:** session `SIM warranty · Black Shark Pad 7` + แชทอื่นในหน้า /test-chat/shopee ตอบเปล่า/ไม่ตอบ
- **สแกน DB:** 47 sessions ล่าสุด → `empty_model=3` (Pad 7 warranty, FunCooler 5 spec, GS3 compat) + `user_last=1` (CUKTECH PB200P compat ไม่มี model msg) — ทั้ง 4 เป็น session `SIM ·` จาก sim run เดียวกัน (11:45–12:04 local, admin=sim) ไม่ใช่แชทจริง
- **หลักฐาน boundary:** model msg ว่างมี `stats` เป็น null ทั้งหมด (source/intent/usage/cost/timing.total) + `sim_checks:["EMPTY"]` → request ระดับ HTTP ล้ม (non-200/non-JSON) ไม่ใช่ 200-answer-ว่าง · `conversation_products` มี docs `sim:20260921-1145-448d:*` → request ถึง bot แล้วตายกลางทาง · `sim:` IDs ไม่อยู่ใน log บอท local เลย → sim ยิงไป **prod bot**
- **root cause:** issue #17 (fixed `c411b1d` 13:42 วันนี้ — หลัง sim run 11:45) — prod image เก่ายังมี `/health` `client.close()` (docker HEALTHCHECK ทุก 30 วิ) ปิด shared MongoClient กลาง `/chat` ที่ถือ db → `Cannot use MongoClient after close` → HTTP 500 สุ่ม ~10-15% (3-4/20 = เท่าที่วัด 9/hr บน prod)
- **เช็กแล้วว่าไม่ใช่สาเหตุ:** `flush/route.ts` `data.answer||""` (ทำงานเฉพาะ 200) · `TestChatClient` bot_error → แสดง error แดงถูก (user จริงเห็น error ไม่ใช่เงียบ) · direct repro :8010 ทั้ง 3 เคสตอบปกติ (warranty 1213 chars, spec KB+mongo, compat product_store) — retrieval/LLM ไม่พัง
- **สถานะ:** ไม่ต้องแก้โค้ดเพิ่ม — root cause แก้แล้วใน `c411b1d` · **action = redeploy prod** ให้ image มี fix แล้วลบ/รัน sim sessions ใหม่ยืนยัน

### ✅ 2026-09-22 — Botworker parity fixes: workflow reply pairing (__wf) + trigger bot_template

- **error (a):** คำตอบที่มาจาก workflow engine ไม่เข้า bot history — `storeWorkflowDelivered` เขียน `inbound_message_id` = `<msgId>__wf<N>` (หลาย bubble ต่อ inbound เลี่ยง unique index) แต่ `getHistoryForBot`/`getGroupedHistoryForBot` lookup ด้วย id ดิบ → pair ไม่ได้ → history fallback ไปใช้ Zaapi ทั้งที่บอทเราตอบแล้ว
- **error (b):** trigger `bot_answer` + `bot_template` — test-chat ตอบ template ทันทีไม่เรียกบอท แต่ botworker เรียก callBot เสมอ → parallel run ไม่ตรง production intent
- **fix (a):** `messageService.ts` เพิ่ม `indexBotRepliesByInbound` + `baseInboundId` — ตัด suffix `__wf<N>` เป็น base id, รวมหลาย bubble เป็น text เดียวด้วย " ||| " ตามลำดับ N · ใช้ร่วมกันทั้ง 2 ฟังก์ชัน history + orphan check เทียบ base id (กัน wf reply โผล่ซ้ำเป็น orphan)
- **fix (b):** `botWorkerService.ts` — หลัง `handoff_admin` check ก่อน callBot: `trigger.bot_template` → `storeBotReply` (answer=template, source="trigger_bot_answer") + `markProcessed` status=trigger_matched + `logAdminEvent` (used_bot_template) → return; ไม่เรียก Python bot
- **verify:** `npx tsc --noEmit` clean · `git diff --check` clean · integration test กับ Mongo จริง (seed conv สังเคราะห์แล้วลบ): grouped — u1 pair "WF-A ||| WF-B" ชนะ zaapi ✓, turn [u2,u3] หา worker reply ผ่าน u3 ✓, ไม่ซ้ำ ✓; history — pair ถูก + orphan จริงยัง append + wf reply ไม่เป็น orphan ซ้ำ ✓ (11/11 PASS)
- **ผลกระทบเคสอื่น:** reply id ดิบ (worker/trigger/normal) ทำงานเหมือนเดิม — n=-1 sort ก่อน wf bubbles · raw+wf mix ภายใต้ base เดียว join raw ก่อน · schema/index ไม่แตะ · handoff_admin + bot_answer ไม่มี template = path เดิมเป๊ะ · SRS_SSD 6.26 อัปเดต 2 แถว (botWorkerService, messageService)

### 🔧 กำลังจะทำ — Botworker true-parallel sandbox (รออนุญาต)

- **เป้าหมาย:** botworker เป็น parallel run ของ ticket จริง — รับเรื่อง/ปิดแชท/โยนงาน/status ทำงานได้จริง แต่ state ทั้งหมดอยู่ใน test collections ไม่แตะของจริง
- **audit พบจุดที่แตะ state จริงอยู่:**
  1. `pickAgent` → `handoffService.handoffToAdmin` (จริง) → เขียน status_conversation + tryAssign จริง — cursor แยกอยู่แล้วเพราะ buildPool poolKey มี source (`*:botworker`)
  2. status guard อ่าน `status_conversation` จริง (admin กดปิดในหน้า botworker จะไม่มีผลต่อ worker)
  3. workflow nodes: `assign_ticket`(direct/auto) + `add_label` + `close_ticket` + `add_note` เขียน conversations/status_conversation จริง; conditions `conversation_status`/`assignee` อ่านของจริง
  4. `callBot(simulate=false)` → Python `_send_handoff` POST /api/admin/conversations/bot-handoff ไม่มี simulate → เขียน status_conversation + conversations.bot_claim_info จริง (route รองรับ simulate แต่ hardcode source="test_chat")
  5. `storeBotReply` เขียน `image_desc` ลง messages_shp (additive field — ต้องย้ายไป shadow_replies.bot_image_desc ถ้าจะแยกสนิท)
  6. หน้า /botworker ปุ่ม close/reopen/handoff/transfer ยิง API ticket จริง (`chatService.close/handoff`, `/api/assignment/reassign`) → แก้ของจริง!
- **แพลน:** (a) worker เปลี่ยนเป็นอ่าน/เขียน `test_status_conversation` source=botworker ทั้งหมด + `handoffToAdminTest` (b) engine เพิ่ม `testSource` — side-effect nodes เขียน test doc เมื่อถูกส่งมาจาก worker (c) callBot+Python เพิ่ม `test_source` → handoff ลง test store + ticket_state อ่านจาก test store (d) image_desc → `bot_image_desc` บน shadow_replies + history map ผ่าน inbound id (e) API routes ใหม่ /api/botworker/conversations/:id/{close,reopen,handoff,transfer,accept,close-history} + หน้าเปลี่ยนมาใช้
- **คงเดิม:** test-chat ไม่แตะ (conv id ไม่ชนของจริงอยู่แล้ว) · conversation_products/anchor share กับ shadowbot ตามเดิม · workflow_runs ไม่มี source — ไม่กระทบ tickets
- **คำถามเปิด:** toggle "รับแชท" (is_accepting_chats) บนหน้า botworker เขียน profile แอดมินจริง — เก็บไว้หรือซ่อน?
- **plan จริง:** `docs/plans/botworker-parallel-plan.md` (เขียนแล้ว — รออนุญาต) · เพิ่มเติมจาก user: รับเรื่อง=self-assign คนกด (ทั้ง tickets+botworker), admin ตอบแชทใน parallel ได้จริง (collection ใหม่ botworker_messages), ปิดแล้วลูกค้าทักซ้ำ=reopen loop, assign history แยก (botworker_events), image_desc/anchor share ได้, toggle รับแชทเก็บไว้
- **plan update (2026-09-22):** เพิ่มปัญหา pool ว่างแล้วไม่มี pending marker/backlog distributor — handoff ที่หา admin ไม่ได้ต้องเขียน `pending_assignment=true`; ไม่ auto-drain ตอน admin คนแรกเปิดรับแชท; ให้ superadmin/dev เลือก selected admin pool แล้ว preview+commit งานค้างเอง (round_robin_selected / least_loaded_selected / manual_quota); เพิ่มลำดับทำงาน MVP safety → UI sandbox → workflow sandbox → backlog distributor
- **plan update 2 (2026-09-22):** เพิ่ม bug manual transfer dropdown แสดง admin ที่พักรับแชท — ต้อง filter `active && role=admin && is_accepting_chats !== false` ทั้ง tickets+botworker และ validate ที่ API; เพิ่ม Part H reset หลังจบทดสอบแบบ dry-run→backup→confirm ครอบ ticket/test_chat/shadowbot/botworker/live-assignment/test-assignment assignment+close history ทั้งหมด
- **plan update 3 (2026-09-22):** user ยืนยันว่า admin reply ใน botworker ต้องนับเป็น history — เพิ่ม requirement ให้ `botworker_messages` merge เข้า sandbox history; history ของ worker ต้อง prioritize `shadow_replies` origin worker/workflow mode standalone ก่อน Zaapi fallback และห้ามปน shadowbot/replay/test source อื่น

### ✅ 2026-09-22 — Botworker true-parallel sandbox (ทั้ง 8 parts เสร็จ + verify 21/21)

- **error/เป้าหมาย:** botworker ต้องเป็น parallel run ของ /tickets ที่ทำงานได้จริงครบ (รับเรื่อง/โยนงาน/ตอบแชท/ปิด-เปิด/status) แต่ state แยกสนิทจาก ticket จริง — audit เจอจุดรั่ว 6 จุด (pickAgent→handoffToAdmin จริง, guard อ่าน status_conversation จริง, workflow nodes เขียนจริง, Python handoff ไม่มี test_source, ปุ่ม UI ยิง API จริง, image_desc เขียน messages_shp)
- **fix ตาม `docs/plans/botworker-parallel-plan.md`:**
  - **A** worker: guard อ่าน `test_status_conversation`[botworker] (assigned/open/handoff→skip, closed→reopen เข้าลูปเดิม) · `pickAgent`→`handoffToAdminTest(source=botworker, assignedStatus=open)` · ทุก event→`logBotworkerEvent` (ลบ logAdminEvent ออกจาก worker) · callBot/engineMsg ส่ง `testSource`
  - **B** testStatusConversationService: +`pending_assignment`/`labels`/`close_history[]`/`bot_claim_info`/`reopen_count` + `manualTestAssign`(atomic)/`setTestPendingAssignment`/`assignPendingTestTicket`/`pushTestCloseHistory`/`addTestLabels` · handoffService `assignedStatus` + pending marker ทั้ง real (`statusConversationService.setPendingAssignment`/`assignPendingTicket`) และ test · `botworkerEventService` ใหม่ (collection `botworker_events` แยกจาก admin_logs) · COLLECTIONS `botworkerMessages`/`botworkerEvents` + index
  - **C** workflowEngine: `EngineMessage.testSource` — assign_ticket/add_label/close_ticket/add_note เขียน test doc, conditions conversation_status/assignee อ่าน test doc, let_ai_respond ส่ง testSource+includeSandboxAdmin, run persist `test_source` (resume จาก timeout ยังอยู่ sandbox)
  - **D** botCallService `testSource` → ticket_state อ่าน test store + POST `test_source` · Python `ChatRequest.test_source` + `_send_handoff` payload · route `bot-handoff` branch `test_source="botworker"` → handoffToAdminTest + claim info ลง test doc
  - **E** API `/api/botworker/conversations/:id/` — accept(self-assign→open)/transfer(validate active+role+accepting)/handoff(pool→open หรือ handoff+pending)/close(+close_history)/reopen(assignee→open, ไม่มี→bot)/send(botworker_messages+claim→open)/close-history/events + messages route merge botworker_messages
  - **F** หน้า /botworker: ปุ่มทั้งหมดยิง sandbox routes + composer ใหม่ (admin reply→botworker_messages+claim→open→worker skip) + bubble สีตาม `bubble_color` ที่บันทึกตอนส่ง + transfer dropdown filter `is_accepting_chats!==false` · หน้า /tickets "รับเรื่อง"→`POST assign {admin_id:me}` (self-assign จริง แก้ bug เดิมที่ไม่เคย assign ให้คนกด) · `/api/assignment/reassign` validate target active+role+accepting ซ้ำ
  - **G** `backlogService` + `/api/assignment/backlog` GET + `/preview` + `/commit` (superadmin/dev, idem_key, re-check pending atomic) — modes: round_robin_selected/least_loaded_selected/manual_quota; ticket→status_conversation(handoff), botworker→test store(open) · หน้า `/backlog` ใหม่ (page key `backlog` admin:none/superadmin:dev:edit) · ไม่มี auto-drain
  - **H** `scripts/reset-assignment-state.ts` — dry-run default, `--confirm --phrase=RESET_ASSIGNMENT_STATE`, backup→`exports/maintenance/reset-assignment-<ts>/`, `--accepting=keep|all-on|all-off`, soft-delete shadow_replies test origins (หรือ --hard), unset status_conversation/conversations เฉพาะ bot-handoff fields, delete test_status/botworker/cursors/processing/buffer/accept-sessions, post-reset verify; ไม่แตะ messages_shp/master data
- **verify:** `tsc --noEmit` clean · `git diff --check` clean · `py_compile app.py` clean · reset dry-run รันจริงบน DB (ไม่เขียน — count เท่านั้น) · **`scripts/verify-botworker-parallel.ts` 21/21 PASS** (manualTestAssign→test only, status_conversation/conversations ไม่มี doc, pending marker, preview ไม่เขียน, commit assign+idem replay, pool validation reject nonexistent, history: worker reply ชนะ zaapi + admin sandbox เข้าเป็น model turn + shadowbot/manual ไม่รั่ว + flag ปิดไม่มี admin msg, handoffToAdminTest ไม่แตะ real store)
- **ผลกระทบเคสอื่น:** /tickets "รับเรื่อง" เปลี่ยนจาก pool-handoff → self-assign (ตาม requirement user) · reassign ปฏิเสธ admin พักรับแชท (ทั้ง UI filter + API 422) · handoffToAdmin จริงตอนนี้ mark pending_assignment เมื่อ pool ว่าง (งานค้างไม่หาย) · test-chat/shadowbot ไม่เปลี่ยน (source แยก) · `image_desc` คงบน messages_shp (additive, share ตาม plan) · toggle รับแชทบน botworker เก็บไว้ (profile จริง — user อนุมัติ)

### 🔧 กำลังจะทำ — Audit fixes: test_status index + reset script completeness

- **audit พบจุดผิดพลาด:**
  1. `test_status_conversation` มี unique index `{conversation_id}` เดี่ยว → conv เดียวกันมี doc ได้แค่ source เดียว (botworker ชน test_assignment/test_chat) — live DB: `conversation_id_1` unique ยังอยู่, compound `{source,conversation_id}` เป็น non-unique · data ปลอดภัย (94 docs ทุกตัวมี source, ไม่มี dupe)
  2. reset script ไม่ครบตาม requirement "เหมือนไม่เคยทดลอง": ไม่ backup `conversations` ก่อน unset · ไม่ backup `admins` เมื่อใช้ --accepting · ไม่แตะ `admin_logs` scope assign/close/handoff/test เลย · workflow_runs filter ขาด `waiting_for_reply` · post-reset verification ไม่ครบ
  3. `chat_accept_sessions` แค่ปิด open sessions — ไม่มี hard reset ล้าง history
  4. ไม่มี warning ให้หยุด bot-worker ก่อน reset จริง · --no-backup ไม่มี warning
- **plan แก้:**
  - `mongoClient.ts`: migration block ก่อน Promise.all — drop unique `{conversation_id}` + drop non-unique compound เก่า → `safeCreateIndex` ใหม่: unique `{source:1,conversation_id:1}` + non-unique `{conversation_id:1}` (query เดี่ยวยังเร็ว)
  - `reset-assignment-state.ts`: +backup `conversations`(filter bot_handoff fields) +backup `admins` เมื่อ --accepting≠keep +backup&delete `admin_logs` scope (chat_assigned/conversation.handoff/status_change/backlog_commit/live_assignment.*/test_assignment.*/test_chat.rate/shadow_reply.*) +workflow_runs เพิ่ม `waiting_for_reply` +`--accept-sessions-hard` ลบ history หลัง backup +verification checklist ครบทุก collection +warning หยุด bot-worker +--no-backup loud warning
- **verify:** tsc · py_compile · git diff --check · dry-run เท่านั้น (ห้าม --confirm จนกว่าอนุมัติ)

#### ✅ ผลลัพธ์ (verify แล้ว)

- **index migration:** `mongoClient.ts` เพิ่ม drop block ก่อน Promise.all — drop unique `conversation_id_1` + non-unique `source_1_conversation_id_1` เดิม → สร้างใหม่: `{conversation_id:1}` non-unique sparse (query เดี่ยว) + `{source:1,conversation_id:1}` unique — **verify บน DB จริง:** indexes เปลี่ยนถูกต้อง + upsert conv เดียวกัน 2 source สำเร็จ (เดิมจะ E11000)
- **side finding (ไม่แก้ — นอก scope):** `conversations_shp` มี duplicate `conversation_id` docs ใน dev DB → unique index `conversation_id_1` ของมันสร้างไม่ได้ (E11000) — pre-existing, instrumentation.ts catch error ไว้อยู่แล้วไม่ crash; data มาจาก sellcenter dump
- **reset script เพิ่ม:** backup `conversations`(bot_handoff fields) + `admins`(เมื่อ --accepting≠keep) + `admin_logs` scope (action_type ใน ADMIN_LOG_SCOPE: chat_assigned/conversation.handoff/status_change/backlog_commit/live_assignment.*/test_assignment.*/test_chat.rate/shadow_reply.*) · workflow_runs filter ครอบ `waiting_for_reply/running/waiting/active/paused` + `test_source` · `--accept-sessions-hard` ลบ history ทั้งหมด (default แค่ปิด open) · post-reset verification 20 checks ครบทุก collection · warning หยุด bot-worker + `--no-backup` loud warning
- **verify:** tsc clean · py_compile clean · git diff --check clean · dry-run รันจริง 2 variants (default + hard/all-off/no-backup) แสดง count ถูก · `--confirm` ไม่มี phrase → ยัง dry-run + เตือน · verify-botworker-parallel ยัง 21/21 หลัง migration
- **ยังไม่รัน:** `--confirm --phrase=RESET_ASSIGNMENT_STATE` จริง (รอ approval — จะ wipe test data + scoped admin_logs บน DB นี้)

### 🔧 กำลังจะทำ — Audit fix รอบ 2: close_history collection + admin_logs scope ขาด

- **audit พบ:**
  1. `close_history` collection (`closeHistoryService.ts`) ไม่ถูก reset เลย — script unset แค่ field `close_history` ใน status_conversation doc แต่ collection แยกยังค้าง → ประวัติปิดแชทจริงเหลือ
  2. `ADMIN_LOG_SCOPE` ขาด `chat_reassigned` (assignmentService), `conversation.close`/`conversation.open`/`conversation.resolve` (statusConversationService/closeHistoryService)
- **plan:** reset script — +`closeHistory` เข้า backup+delete+verify · +4 action types เข้า ADMIN_LOG_SCOPE · ไม่แตะ `assignment.*` config logs (mode_change/team_add คือ audit ของ config ไม่ใช่ conversation state)
- **verify:** tsc · dry-run นับ close_history + admin_logs scope ใหม่

#### ✅ ผลลัพธ์รอบ 2 (verify แล้ว)

- **fix:** `reset-assignment-state.ts` — +`closeHistory` เข้า backup/delete/verify · +`chat_reassigned`/`conversation.open`/`conversation.close`/`conversation.resolve` เข้า ADMIN_LOG_SCOPE (คงไม่แตะ `assignment.mode_change`/team config — audit ของ config)
- **verify:** tsc clean · dry-run: close_history=3 docs เข้า scope, admin_logs 2388→2395 (+7 จาก action types ใหม่)

### 🔧 กำลังจะทำ — Audit fix รอบ 3: admin-owned state (topic/item_ids/pinned)

- **user อนุมัติเพิ่ม:** ADMIN_LOG_SCOPE += `conversation.set_topic`,`conversation.set_item_ids` · STATUS_UNSET += `topic`,`item_ids`,`pinned` (admin-owned state จากการใช้หน้า tickets/botworker — ไม่ใช่ข้อมูลลูกค้า) · consistency: pin/unpin เกิด admin_logs `conversation.pin`/`unpin` → รวมเข้า scope ด้วยเพราะ unset pinned แล้วแต่ log เหลือจะขัดกัน
- **verify:** tsc · dry-run

#### ✅ ผลลัพธ์รอบ 3 (verify แล้ว)

- **fix:** `reset-assignment-state.ts` — ADMIN_LOG_SCOPE +`set_topic`/`set_item_ids`/`pin`/`unpin` · STATUS_UNSET +`topic`/`item_ids`/`pinned` (admin-owned state ทั้งหมด — test doc ลบทั้ง doc อยู่แล้วไม่ต้อง unset)
- **verify:** tsc clean · dry-run: admin_logs=2395 (ไม่เปลี่ยน — DB นี้ยังไม่มี log ของ action ใหม่, scope พร้อมรับเมื่อมี)

### 🔧 กำลังจะทำ — Audit fix รอบ 4: เปลี่ยน scope reset เป็น "assignment/chat-state only" (preserve replay/generate artifacts)

- **requirement ใหม่ (user):** reset เคลียร์เฉพาะ state การทำงาน (assign/handoff/close/reopen/backlog/topic/pin/accept sessions/cursors) — **เก็บ** replay/generate history ทั้งหมด: shadow_replies, test_assignment, test_chat_sessions, test_chat_ratings + logs ที่เป็น replay/generate/rating history
- **เอาออกจาก reset scope (preserve):**
  - collections: `shadow_replies` (ทั้ง soft/hard — ลบ TEST_REPLY_FILTER + --hard flag ทิ้ง), `test_assignment`, `test_chat_sessions`, `test_chat_ratings`
  - admin_logs: `shadow_reply.*` (10 ตัว), `test_assignment.*` (6 ตัว), `test_chat.rate`, `live_assignment.batch_replay`, `live_assignment.admin_reply` (= คำตอบ/ผลทดสอบ)
- **คงไว้ใน ADMIN_LOG_SCOPE (assignment/chat-state เท่านั้น):** chat_assigned, chat_reassigned, conversation.handoff/status_change/open/close/resolve, set_topic, set_item_ids, pin, unpin, backlog_commit, live_assignment.close_chat, live_assignment.reopen_process · +เพิ่ม `bot.handoff_to_admin` (bot ส่งต่อ=assignment state), `chat_accept.start`/`stop` + `agent.pause`/`resume`/`agent_auto_paused` (accept-session history — ล้าง sessions แล้วต้องล้าง log คู่กันไม่งั้น audit กระหล่อน)
- **คง reset เหมือนเดิม:** status_conversation unset (รวม topic/item_ids/pinned), conversations bot_handoff fields, close_history (backup+delete), assignment_cursors, chat_accept_sessions (close/hard), test_status_conversation (assignment state ของ test pages — result/history อยู่ใน test_assignment/test_chat_sessions ที่ preserve), workflow_runs (active/test filter เดิม), botworker_messages+events (manual admin action state), chat_processing+buffer_messages (runtime processing state), admins accepting flag (เมื่อ --accepting≠keep)
- **UI/ข้อความ:** header "Assignment/chat-state reset" + dry-run แสดง section "PRESERVE (replay/generate artifacts)" + verification ไม่เช็ก preserved colls = 0 + เพิ่มเช็ก topic/item_ids/pinned/assigned_at fields
- **verify:** tsc · git diff --check · dry-run เท่านั้น (ห้าม --confirm)

#### ✅ ผลลัพธ์รอบ 4 (verify แล้ว)

- **fix:** `reset-assignment-state.ts` — scope ใหม่ "assignment/chat-state reset": เอา `shadow_replies`/`test_assignment`/`test_chat_sessions`/`test_chat_ratings` ออกจาก backup+delete+verify (preserve ทั้งหมด) · ลบ `--hard` flag + `TEST_REPLY_FILTER` · ADMIN_LOG_SCOPE เหลือเฉพาะ assign/close/handoff/state (ตัด shadow_reply.*/test_assignment.*/test_chat.rate/live_assignment.batch_replay/admin_reply; เพิ่ม bot.handoff_to_admin, chat_accept.start/stop, agent.pause/resume/agent_auto_paused — accept-session state) · dry-run แสดง section PRESERVE + counts · verification เพิ่มเช็ก assigned_at/assignment_reason/topic/item_ids/pinned
- **verify:** tsc clean · git diff --check clean · dry-run — admin_logs scope=4 docs
- **⚠️ สังเกต:** dry-run รอบนี้ state collections เป็น 0 ทั้งหมด (รอบก่อน: test_status=94, sessions=113, close_history=3) — น่าจะมีการเคลียร์ test state บน DB นี้ไปแล้วนอก script นี้ · shadow_replies 6555 docs ยังอยู่ครบ (preserve ถูกต้อง)

### 🔧 กำลังจะทำ — Post-incident: admin filter bugs + legacy residue + live-assignment state (preserve QA history)

- **อาการหลัง reset/restore:** /tickets เห็น handoff ของ admin_temp_001-003 (legacy `conversations_shp.assigned_to` ~15 docs ค้าง + API fallback อ่าน legacy) · filter admin ที่ไม่มีงานกลายเป็น "โชว์ทั้งหมด" (`conversationIds=[]` → no-filter bug) · restore test_assignment ดึง assigned_to/mock_status กลับมาด้วย · /live-assignment + /botworker ไม่มี assigned_to filter ชัดเจน
- **plan:**
  - **A** `conversationService.listConversations`: `opts.conversationIds` ถูกส่งมาแต่เป็น `[]` → return `[]` ทันที (ห้าม [] = no-filter) · เช็ก callsite `/api/admin/conversations`
  - **B** reset script: +unset legacy assignment fields ใน `conversations_shp` (assigned_to/assigned_at/assigned_to_name/assignment_reason — audit field `status` ก่อนว่า master หรือ admin-owned; ถ้าไม่ชัด unset เฉพาะ docs ที่มี assigned_to/bot_handoff fields) + backup + dry-run count
  - **C** reset script: `test_assignment` เปลี่ยนจาก preserve-ทั้ง-doc → **updateMany $unset เฉพาะ state fields** (assigned_to/assigned_at/assigned_to_name/mock_status/close_*/reopened_* ฯลฯ ตาม schema จริง) — preserve qa/messages/bot_reply/products/retrieval_info · backup affected docs ก่อน · verify state fields=0 แต่ docs ยังอยู่
  - **D** `/live-assignment`: page → route → service รองรับ `assigned_to=all|me|unassigned|<id>` — empty/falsy ≠ no-filter
  - **E** `/botworker`: เพิ่ม `assigned_to` param → filter จาก `test_status_conversation[source=botworker]` (ไม่ใช้ conversations_shp.assigned_to) · empty list ถูกต้อง · cache key รวม filter
  - **verify:** tsc · git diff --check · read-only probes · dry-run เท่านั้น (ห้าม --confirm)

#### ✅ ผลลัพธ์รอบ 5 (verify แล้ว)

- **root causes:**
  1. `listConversations` — `conversationIds=[]` ถูกข้าม filter (เช็ก length>0) → admin ไม่มีงานเห็นทั้งหมด · fix: `!== undefined` → `$in: []` match 0 จริง
  2. `/tickets` เห็น admin_temp_* — `status_conversation` สะอาดแล้วแต่ `getAssignedConversationIds` fallback อ่าน legacy `conversations_shp.assigned_to` (15 docs ค้าง) → reset เพิ่ม unset assigned_to/assigned_at/assigned_to_name/assignment_reason/status เฉพาะ docs ที่มี residue (status-only docs ไม่แตะ — อาจเป็น dump field)
  3. `test_assignment` restore ดึง state กลับ — เปลี่ยนจาก preserve-ทั้ง-doc → `$unset` state fields (assigned_to/mock_status/close_*/reopened_*/pending_assignment) เก็บ qa/ratings/replay metadata · backup affected docs ก่อน
  4. `/live-assignment` — route รับ `assigned_to` แต่ page ไม่เคยส่ง (chatFilter เป็นแค่ UI) → ส่ง chatFilter ใน loadList/loadMore/poll · service รองรับ `unassigned` ($in [null,""] — ไม่ชน cursor $or) · route resolve me→admin_id
  5. `/botworker` — route ไม่มี assigned_to param เลย → เพิ่ม all|me|unassigned|<id> filter จาก test_status_conversation[botworker] ($in=[]→empty จริง, unassigned→$nin) + cache key รวม filter + admin name map สำหรับ badge · page ส่ง chatFilter
- **verify:** tsc clean · diff --check clean · dry-run: conversations_shp legacy=15 docs, test_assignment state=92 docs (docs preserved), shadow_replies 6555 เก็บ, admin_logs scope=4
- **ยังไม่รัน --confirm**

#### ✅ ผลลัพธ์รอบ 6 (verify แล้ว)

- **fix:** `TEST_ASSIGN_UNSET` +`stopped_at_handoff` · verification +check 同名 (probe: 92 docs มี field นี้)
- **final_status decision — PRESERVE:** `final_status` คือ replay verdict ("bot_answered"/"handed_off"/"no_agent"/"error") = ผลทดสอบ — ใช้ใน stats + badge เป็น "ผล replay" ไม่ใช่ live state · ล้างแล้ว replay history เสียความหมาย · badge "handoff" ใน list = verdict ของ replay โดยตั้งใจ (admin action state จริงคือ assigned_to/mock_status/close_* ที่ล้างแล้ว) — ถ้าอยากให้ list ดูสะอาดสมบูรณ์ค่อยเพิ่ม flag ล้าง final_status แยก
- **verify:** tsc clean · dry-run scope ถูก

### 🔧 กำลังจะทำ — live-assignment UI: แยก current state ออกจาก replay verdict

- **root cause:** `liveDocToConversation` map `final_status` (replay verdict) → `status` (current chat state) — reset state หมดแล้วแต่ list ยังขึ้น badge "แอดมิน" เพราะ verdict ค้าง
- **plan:**
  - `liveDocToConversation`: status จาก state fields เท่านั้น — `mock_status==="closed"`→closed, `assigned_to||stopped_at_handoff`→handoff (อยู่ในมือแอดมิน/รอรับ), else→bot · post-reset ทุก field unset → "bot" สะอาด
  - แสดง replay verdict แยก: `Conversation.replay_verdict?` (optional) + chip "replay: X" ใน ChatList badge row (optional — ไม่กระทบหน้าอื่น)
  - test-assignment page ไม่แตะ — ใช้ replay_status/final_status ในตารางผล replay โดยตรง (context ถูกอยู่แล้ว)
  - verify: tsc + diff --check

#### ✅ ผลลัพธ์รอบ 7 (verify แล้ว)

- **fix:** `liveDocToConversation` — status จาก state fields เท่านั้น: `mock_status==="closed"`→closed, `assigned_to||stopped_at_handoff`→handoff, else→bot (post-reset ทุก field unset → "bot" สะอาด ไม่มี badge แอดมินหลอก)
- **replay verdict แยก:** `Conversation.replay_verdict?` (optional) + chip "replay: <final_status>" ใน ChatList badge row — final_status เก็บเป็นข้อมูล/แสดงเป็น verdict ไม่ใช่ current state · optional field ไม่กระทบหน้าอื่น
- **test-assignment ไม่แตะ:** ใช้ replay_status/final_status ในตารางผล replay โดยตรง — context ถูกอยู่แล้ว
- **verify:** tsc clean · git diff --check clean
- **ยังไม่รัน --confirm / ยังไม่ commit**

#### ✅ ผลลัพธ์รอบ 8 — RESET จริง (verify แล้ว)

- **pre-check:** ไม่มี bot-worker รัน (ps + docker ps) — เจอแค่ verify-botworker-parallel.ts ค้าง (read-only)
- **dry-run สุดท้าย:** conversations_shp=15, test_assignment=92, admin_logs=4 · preserve shadow_replies=6555, test_chat_sessions=115
- **reset จริง:** `--accept-sessions-hard --confirm --phrase=RESET_ASSIGNMENT_STATE` — backup 111 docs → `exports/maintenance/reset-assignment-2026-09-22T10-41-40-412Z`
- **post-reset verification:** 26/26 ✓ ไม่มี ✗ — status_conversation/conversations_shp/test_assignment state fields = 0, admin_logs scoped=0, close_history=0, accept_sessions=0 (hard)
- **probe หลัง reset:** shadow_replies 6555 (active 6555) · test_assignment 160 docs (qa+final_status ครบ) · test_chat_sessions 115 · conversations_shp.assigned_to=0 · test_assignment.assigned_to/mock_status/stopped_at_handoff=0
- **static:** tsc clean · diff --check clean · py_compile app.py+responses.py clean
- **manual UI:** รอผู้ใช้ตรวจผ่าน browser preview (ต้อง login session)
- **ยังไม่ commit**

### 🔧 กำลังจะทำ — Task 5B3-D: runtime config toggle สำหรับ grouped retrieval (2026-09-23)

- **เป้าหมาย:** เปิด/ปิด `grouped_retrieval_shadow_enabled` + `grouped_retrieval_selection_enabled` จากหน้า /config (dev-only) โดยไม่แก้ .env / ไม่ restart process
- **design:** DB `system_configs.main_config` เป็น owner (field absent → env fallback เดิม) · Python `runtime_config.py` TTL 5s · ไม่มีปุ่ม refresh เพราะรอ ≤5s เพียงพอและลด surface
- **tests ต้อง RED ก่อน:** `docs/test/test_runtime_config.py` + pin update ใน selection_runtime/shadow tests (env check ย้ายเข้า runtime_config)

#### ✅ ผลลัพธ์ Task 5B3-D (verify แล้ว — ยังไม่ commit)

- **Python `runtime_config.py` (ใหม่):** `get_runtime_config` อ่าน `system_configs.main_config` TTL 5s · `_flag` = DB bool ชนะ / field absent / DB error → env fallback · `grouped_retrieval_shadow_enabled()` + `grouped_retrieval_selection_enabled()`
- **app.py:** 2 flag blocks เรียก runtime_config (lazy, except→False) แทน env ตรงๆ · ไม่มี runtime-config reload endpoint
- **Admin:** SystemConfig +2 fields · whitelist + boolean validate 422 · card "Legacy Shopee Retrieval" หน้า /config — 2 toggles + warning selection กระทบคำตอบจริง · ไม่มีปุ่ม refresh/reload
- **live probe (Mongo จริง):** doc มีแต่ยังไม่มี fields → env fallback: shadow=True (env=1) / selection=False — DB จะเป็น owner หลัง toggle เขียนครั้งแรก
- **verify:** pytest 77/77 · py_compile · tsc clean · next build ผ่าน · diff --check clean

### 🔍 Audit (read-only, ไม่แก้โค้ด) — live chat failures จาก transcript KingGadgets (2026-09-24)

**ขอบเขต:** probe Mongo จริง + run code path จริง (fetch_products / fuzzy_match / grouped pipeline / conversation_products / cert search) — ไม่แตะโค้ด ไม่เขียน DB

#### A. AC65B เทียบ AC65B2 (Q6)

- **DB facts:** AC65B item 28053691336 = `SELLER_DELETE` (discontinued จริง — variant นึงมี seller stock 199 แต่ listing ตาย) · AC65B2 item 49217564003 = `UNLIST` (variant AC65B2 stock=0; siblings AD653C/AD652S ใน listing เดียวกัน stock ~1,288) · `sellable_units`: AC65B ทั้ง 6 units=False, AC65B2 units=False แต่ AD653C/AD652S units=True (snapshot ตอน build)
- **KB มี spec ทั้งคู่** (kb_products AC65B+AC65B2) → compare ทำได้ถ้า retrieval ส่งมา
- **จุดหายที่ 1 (confirmed):** `unit_classifier._CODE_RE = ^[A-Za-z]{0,5}\d{2,5}[A-Za-z]{0,3}$` parse `AC65B2` ไม่ได้ (letters→digits→letter→digit) → `build_retrieval_profile` codes=('AC65B',) เท่านั้น — AC65B2 ไม่เข้า slot/request ตั้งแต่ต้น
- **grouped pipeline จริง (selection ON):** units fetcher 'AC65B' → 37 hits (ดึง units ของ AC65B2 listing มาด้วยเพราะชื่อมี "AC65B2" substring) → pool มี AC65B=discontinued + AC65B2 listing=unlisted ใน unavailable ครบ → **selector เลือก AD653C/AD653T/AD652S จาก listing อื่น (eligible/sellable) 3 ใบ tag "สินค้าที่ลูกค้าถามถึงโดยตรง"** → LLM เห็นเพื่อนบ้านแทนคู่ที่ถาม; คู่จริงอยู่แค่ใน extra_context note (ชื่ออย่างเดียว ไม่มี spec/link)
- **legacy path:** MODEL-REGEX hardcode `item_status:NORMAL` → ทั้งคู่หลุด; FUZZY-MATCH (ไม่ filter status) เจอทั้งคู่เป็น top 2 → card เข้า context พร้อม status ถูกต้อง
- **สรุป:** verdict "ไม่พร้อมจำหน่าย" ถูกต้องตาม DB; ที่พลาดคือ (1) extraction ทิ้ง AC65B2 (2) selector ไม่มี compare/unavailable-subject role — เติม quota ด้วยของขายได้แทนคู่ที่ถาม (3) unavailable evidence ไม่พก spec → เปรียบเทียบไม่ได้ทั้งที่ KB มี
- **fix phase:** `unit_classifier._CODE_RE` (extraction) + `retrieval_selection` (compare intent ต้อง promote unavailable targets เข้า context ไม่ใช่แทนด้วย sellable neighbors) + attach KB spec ให้ unavailable compare subjects

#### B. WPB100L (Q15/Q17/Q18)

- **DB facts:** item 45367578327 = `UNLIST`, seller stock รวม ~440 ทั้ง 6 variants `if_saleable=True` · `sellable_units` ทั้ง 6 = sellable=True (**stale** — build ตอน listing ยัง NORMAL; runtime `resolve_availability` join สด → `unlisted`/`available_for_sale=False` ถูกต้อง)
- **Q15 (compat):** KB hit (WPB100L spec) → `mongo_query` จาก kb_models → fetch_products supplement (ดึงทุก status) → card UNLIST + link เข้า context → bot ตอบ compatible + ส่งลิงค์ listing ที่ตายแล้ว (ไม่มี flag ถึงลูกค้า)
- **Q17 ("สนใจ PB WPB100L"):** fuzzy_match เจอ WPB100L #1 (UNLIST, sell=False) → bot ตอบ "ไม่พร้อมจำหน่าย" ถูกต้อง — **Q15/Q17 ไม่ได้ขัดกันที่ retrieval: card เดียวกัน ต่างกันที่ framing ตอน LLM ตอบ**
- **Q18 ("ขอลิงค์สินค้า") — root cause confirmed:** LINK-FOLLOWUP (`app.py` ~2626) → `get_anchor_and_suggestions` เอา anchors ก่อน — ตอนนั้น anchors = WPB100L(ล่าสุด)+AC65B2+AC30S+LPB100 **UNLIST ทั้งหมด** → แล้ว prompt (`app.py` ~3619) สั่ง LLM "ส่งลิงค์ของสินค้า status=NORMAL ทุกตัวใน context" → LLM ข้าม anchors เงียบๆ ไปลิงค์ NORMAL chargers (AD653C/AD653T/AD1003T) จาก suggestion tail → ลิงค์ผิดรุ่น + ไม่บอกลูกค้าว่า WPB100L ถูก unlist
- **conv timeline (shp_152520383445167602):** WPB100L เป็น `bot_suggestion` + `is_anchor=true` @10:30:12 — anchor ถูกบันทึกถูกต้อง ปัญหาอยู่ที่ link-followup instruction + ไม่มี unavailable-aware answer
- **fix phase:** `app.py` LINK-FOLLOWUP block — เมื่อ anchor ล่าสุด unavailable ต้องบอกตรงๆ (unlisted/เลิกขาย + link ดูได้ถ้าต้องการ) แทน silent swap ไป NORMAL items; grouped path ต้องเก็บ exact-model unavailable card เป็น primary context ของ turn นั้น

#### C. มอก. path (Q10 "รุ่นไหนมี มอก. บ้าง")

- **reproduce ตรง transcript เป๊ะ:** `detect_cert_question` → ('tisi',) · `extract_tisi_model_keyword` → '' · `_detect_product_types(msg)` → ∅ → `type_filter=None` → 15 items ทุกหมวดของร้าน (PowerConnex/Eloop×9/inFace/ROIDMI/Huawei) = ตรงคำตอบจริง
- **status handling ถูกแล้ว:** generic cert search filter `item_status==NORMAL` (`product_store.py` ~4129) + sellable-first sort — ไม่มีของหมด/ปลดลงปน
- **ที่พลาด:** `_cert_types` อ่านเฉพาะ `req.message` (`handoffs.py` ~228) — context จากคำถามก่อน (charger/powerbank) ไม่ถูก carry; `RetrievalProfile` มี precedence current→anchor→intent→history พร้อมใช้แต่ cert handler ไม่ได้ใช้
- **fix phase:** `handoffs.py` cert block — fallback `type_filter` ไปที่ profile.product_types (+subtype expansion) เมื่อ message ไม่มี type word

#### สรุปหลัก

- availability verdict ทุกเคส**ถูกต้อง**ตาม live DB (UNLIST/SELLER_DELETE จริง) — ไม่ใช่ false "หมดสต็อก"
- จุดพังจริง 3 จุด: `_CODE_RE` ทิ้ง code pattern letter-digit-letter-digit · selector/followup ไม่มี "unavailable subject" semantics (แทนด้วยของขายได้เงียบๆ) · cert handler ไม่ carry context

### 🔧 กำลังจะทำ — Task 5C: availability policy + unavailable compare subjects + cert context + follow-up safety (2026-09-24)

- **จาก audit ข้างบน** — root causes: `_CODE_RE` ทิ้ง AC65B2 · grouped selector ไม่มี subject semantics · LINK-FOLLOWUP silent swap · cert ไม่ carry context · "ใช้งานไม่ได้" หลุด claim detect
- **policy ใหม่ (user spec):** UNLIST = customer_hidden (ยังไม่ publish — ไม่ใช้ตอบ spec/compat/compare/link ถ้าไม่มี visible listing อื่นของ model เดียวกัน) · SELLER_DELETE/NORMAL+stock0 = customer-visible historical → ตอบ spec/compare ได้พร้อม label · live item_status ชนะ unit snapshot เสมอ (มีอยู่แล้ว — lock ด้วย test)
- **plan:**
  - B) `unit_classifier._CODE_RE` รับ letter→digit→letter→digit (AC65B2) — generic ไม่ hardcode
  - A) `resolve_availability` +`customer_visible` (UNLIST→False) → card field → executor `_bucket` UNLIST→rejected(customer_hidden) → selection เก็บ hidden_mentions เป็น name-level note "ยังไม่เปิดขาย" (ไม่ใช่ spec/link evidence)
  - C) selection: candidates ที่ match requested model_codes → role "subject" (รวม customer-visible unavailable ใน answerable_all mode) · ที่ไม่ match → "alternative" tag "รุ่นแนะนำทดแทน" — ห้าม substitute แอบเป็น subject
  - D) app.py LINK-FOLLOWUP: anchor ล่าสุด unavailable → UNLIST ตัด short_link + note "ยังไม่มีจำหน่าย"+ทดแทนหมวดเดียวกัน; visible-unavailable → บอกสถานะ+ลิงค์ดูข้อมูลได้; ห้าม silent swap
  - E) handoffs cert: type_filter fallback → RetrievalProfile (history/intent/anchor types + subtype expansion) · no-context → cap list+clarify · stock=0 label
  - F) warranty claim detect +keywords ("ใช้งานไม่ได้"/"ชาร์จไฟไม่ได้" ฯลฯ) + first-claim answer มี safe checks ก่อนขอข้อมูลเคลม
- **TDD:** tests ใหม่ก่อนแต่ละจุด · verify: pytest + py_compile + diff --check · **ยังไม่ commit จน user approve**

### ✅ Task 5C เสร็จ (ยังไม่ commit — รอ user approve)

- **B) `_CODE_RE`** → `^[A-Za-z]{0,5}\d{2,5}(?:[A-Za-z]{0,3}\d{0,2})?$` — AC65B2 เข้า; i14/ip14/s25/a56 ยัง device (filter ที่ profile level `_code_is_device`)
- **A) availability policy:** `resolve_availability` +`customer_visible` (False เฉพาะ UNLIST/unknown) → propagate ผ่าน `to_product_card`/`to_unit_card`/`_live_availability` → executor `_bucket` reject 'customer_hidden' ก่อนทุก check → selection `hidden_mentions` (name-level) เฉพาะรุ่นที่ถาม
- **C) subject/alternative:** selection `_code_match` (model_codes ∪ name boundary-regex) → code-match=role 'subject'; code-bearing req ไม่ match→'alternative'; unavailable-visible + answerable_all → promote เป็น subject (cap len(codes), ไม่ซ้ำ unav note); runtime `_ROLE_NOTE` +subject/alternative + unavailable-subject warning
- **D) link-followup:** `app._prepare_link_followup` — UNLIST ตัด short_link+note; visible-dead note สถานะ+ลิงค์ดูได้; ไม่มีตัวขาย→fetch ทดแทน type เดียวกัน tag 'ทดแทน'; conv note แยก has_unav (ห้าม silent swap)
- **E) cert context:** handoffs — type_filter fallback message→history(4 user msgs)→anchor card; phone compat-target ตัดเมื่อไม่มี phone noun; subtype filter เมื่อ detect; ผลไม่ NORMAL มี label; no-context → cap 12 + ถามหมวด
- **F) claim detect:** warranty +คำ "ใช้งานไม่ได้"/"ชาร์จไฟไม่ได้"/"ชาร์จไม่ขึ้น"/"เสียบแล้วไม่ชาร์จ" + `malfunction_safe_check()` (acknowledge+เช็กสาย/หัว/ปลั๊ก/พอร์ต+หยุดใช้ถ้าร้อน/ไหม้) prepend ใน first-claim ทั้ง 2 sites
- **tests ใหม่:** test_code_extraction_5c (5), test_availability_subjects_5c (11), test_link_followup_5c (5), test_cert_context_5c (5), test_troubleshoot_claim_5c (5) = 31
- **regression:** retrieval suite 164 pass · role rename slot→subject ตั้งใจ (2 test อัปเดตตาม semantic ใหม่)
- **live verify:** AC65B compare → codes ทั้งคู่เข้า profile; AC65B(SELLER_DELETE)=subject, AC65B2(UNLIST listing)=hidden_mention, AD653C/T=alternative ✓

### 🔧 กำลังจะทำ — Task 5C hardening: 5 gaps จาก code review ก่อน commit (2026-09-24 รอบ 2)

- **1) hidden-only grouped selection หาย:** `run_grouped_selection` return None เมื่อ `sel.selected` ว่าง ทั้งที่ `hidden_mentions` มี → ต้องคืน result (selected_cards=[] + extra_context บอกยังไม่เปิดขาย)
- **2) link-followup ทิ้ง note-only anchor:** `_prepare_link_followup` ตัด short_link ของ UNLIST แล้ว caller filter `short_link or image_url` ทิ้ง card ที่เหลือแต่ note → LLM ไม่เห็นรุ่นที่ถาม → silent swap — fix: caller ใช้ predicate ที่ keep card มี `_context_note`
- **3) model-level visibility ไม่ consistent:** `resolve_availability`/`_live_availability` ให้ `customer_visible` ไม่ครบ — model_status != MODEL_NORMAL หรือ model missing ใน NORMAL listing ต้อง False (variant-level ≠ listing-level SELLER_DELETE)
- **4) cert label ไม่ส่ง stock:** `resolve_availability({"item_status": ...})` ไม่มี total_stock → NORMAL stock=0 label ผิด → ส่ง stock เข้า resolver
- **5) cert phone hardlogic:** `if "phone" in _cert_types: discard` เป็น product-specific hack — root cause: type derivation ไม่มี provenance → ใช้ `route_context._type_mentions` (kw explicit ชนะ regex device/model mention) + suppress model_kw ที่ไม่ใช่ code-shape เมื่อ explicit type ชี้หมวดอื่น
- **TDD:** tests ก่อนแก้ทั้ง 5 จุด · ยังไม่ commit

### ✅ Task 5C hardening เสร็จ (ยังไม่ commit — รอ user approve)

- **1) hidden-only selection:** `retrieval_runtime.run_grouped_selection` guard `not sel.selected → None` ทำ hidden_mentions หาย → แก้เป็น return None เฉพาะเมื่อไม่มีทั้ง selected+hidden_mentions; LLM ได้ note "ยังไม่เปิดขาย" แม้ไม่มีของขาย
- **2) note-only anchor หลุด:** caller filter `short_link or image_url` ทิ้ง card ที่เหลือแต่ `_context_note` → เพิ่ม `app._link_followup_keep` (keep เมื่อมี link/image/**หรือ _context_note**) ใช้ที่ call site จริง
- **3) model-level visibility:** `resolve_availability` คำนวณ `vis` ก่อน model_status check → model_not_normal ใต้ NORMAL listing ได้ visible=True ผิด → fix `customer_visible=False`; `units._live_availability` model_missing → visible เฉพาะ listing status ที่เป็น historical evidence (SELLER_DELETE/DELETED/SHOPEE_DELETE/BANNED), NORMAL/UNLIST → hidden
- **4) cert label ไม่มี stock:** handoffs ส่งแค่ item_status เข้า resolver → NORMAL stock=0 label ผิด → ส่ง `total_stock: p["stock"]` ด้วย
- **5) cert phone hardlogic:** ลบ `if "phone" in _cert_types … discard` — แทนด้วย provenance: `route_context.requested_product_types(text, explicit_only=)` ใช้ `_type_mentions` src=kw|regex (explicit type noun ชนะ device/model mention); + suppress `model_keyword` ที่ไม่ใช่ code-shape (unit_classifier._extract_codes) เมื่อมี explicit type — "iPhone"/"Watch" เป็น compat target ไม่ใช่รุ่นสินค้า; hoist typo-fix list เป็น `_PT_TYPO_FIXES`/`_fix_product_type_typos` (product_store) ใช้ร่วมกันกัน regression "หัวชาจ"
- **tests ใหม่:** +7 (hidden-only runtime, note-only filter predicate, model_not_normal, model_missing, cert stock label, provenance matrix 4 เคส, code-shaped model_kw เก็บ)
- **verify:** focused suite 89 pass · retrieval/warranty regression 227 pass · py_compile 11 files OK · git diff --check OK
- **remaining risk:** explicit_only suppression ทำ "โทรศัพท์ iPhone 15 มี มอก" ค้นด้วย type_filter={phone} แทน name~iPhone (กว้างขึ้นเล็กน้อย) · hidden-only result ยัง merge base products จาก legacy path (note สั่งห้ามส่งลิงค์รุ่นนั้นอยู่แล้ว)

### 📌 งานค้าง — Task 9/10 follow-up: phone/compat hardlogic audit (ยังไม่แก้ — อยู่นอก scope 5C)

inventory จุดที่ยังเป็น device/phone-specific hardlogic (audit ก่อน refactor ให้เข้ากับ RetrievalProfile provenance):

- `product_store.py:~1790` — `_detect_product_types` ยังมี `found.discard("phone")` เมื่อ compat kw (ใช้กับ/รองรับ) — compat rule เฉพาะ phone
- `product_store.py:~3165-3178` — `product_types == {"phone"}` override + `phone→charger` shorthand subtype override (false positive จาก device name)
- `device_compat.py:~357,397-403` — `_SKIP_TYPES = {"phone","voucher"}` + skip branch เฉพาะ type
- ทิศทาง: inventory ทั้งหมด → เสนอ root-cause refactor เข้า `RetrievalProfile`/`requested_product_types` provenance (kw explicit ชนะ regex mention) แทน guard ต่อ type — ห้ามแก้ทันทีใน 5C เพราะเสี่ยงบาน

### 🔧 กำลังจะทำ — Task 5D: Candidate Pool / Source Union Audit (2026-09-24)

- **เป้า:** ยืนยันว่า sources ทั้งหมด (units/legacy/exact/relation_target/anchor/KB/image_texts/unavailable) เข้า grouped candidate pool ก่อน selection — ยังไม่แก้ compat hardlogic 9/10
- **probes:** A) AD1404T relation (subject+relation_target cable) · B) AC65B/AC65B2 compare · C) WPB100L hidden · D) multi-type case+film quota · E) anchor link follow-up
- **กฎ:** audit-first — แก้เฉพาะเมื่อเจอ blocker จริง · prefer executor/candidate_pool/runtime มากกว่า app.py · ยังไม่ commit

### ✅ Task 5D audit เสร็จ — pool union ไม่มี blocker (ไม่แก้ runtime · ยังไม่ commit)

**source union ปัจจุบัน (ต่อ request):** `units` (`fetch_unit_evidence` — units index + join listing/image_texts/kb_specs, status-agnostic) + `legacy` (`fetch_products` ผ่าน `_legacy_evidence_fetcher` — NORMAL-only ที่ Mongo query) → `_bucket` แยก eligible/unavailable/rejected(customer_hidden) → `build_candidate_pool` dedupe (unit/model→item→name+shop) + EvidenceAttachment (anchor/kb_product/image_text เมื่อ card มี field) → `select_for_llm_context` per-request quota

**live probe results (DB จริง):**
- **A relation "หัวชาร์จ AD1404T ใช้กับสายชาร์จ…มีจอ 2 เมตร เต็มสปีด":** slot=adapter+code, relation_target=cable+query_hint ฝั่ง target ✓ — subject=AD1404T listings, relation_target=CTC615P/CTC620P (hits display+length_m+speed) + CTC620W 2m; สายตาย (Mcdodo/Baseus/ZMI) เป็น unavailable evidence; adapter Eloop C2 ใน target req → subtype_mismatch ✓
- **B compare AC65B/AC65B2:** codes ทั้งคู่เข้า profile; AC65B(SELLER_DELETE)→subject promoted; AC65B2(UNLIST)→hidden_mentions; AD653C/T→alternative ✓
- **C WPB100L:** customer_hidden → hidden_mentions "ยังไม่เปิดขาย" + alternatives เข้า ✓
- **D multi-type "เคส+ฟิล์ม iphone 15":** slot แยก req-0(case)/req-1(screen_protector), quota ต่อ request ไม่กินกัน; film ทั้งหมด rejected (customer_hidden×7 + device_mismatch×6) เก็บใน pool.rejected + rejected_summary — ไม่หาย ✓
- **E link follow-up:** อยู่นอก grouped pool โดย design (app.py conversation_products path — 5C fix แล้ว)

**sources นอก pool (ตั้งใจ/contract-only):** kb_qa/kb_raw (supporting_evidence ยังไม่ populate), web_search, item-tag direct, link-followup, warranty/history lookup, device_compat re-query

**known limitations (ไม่ใช่ blocker — ไม่แก้):**
- anchor เข้า pool แค่ tag (`anchor_item_ids`→is_anchor+score+attachment) — ไม่มี fetcher ดึง anchor โดยตรง; codeless anchor ที่ fetcher พลาดอาจไม่เข้า pool แต่ไม่หายเพราะ `merge_selected_products` เก็บ base products
- legacy source NORMAL-only → hidden/discontinued evidence เข้าผ่าน units เท่านั้น (units index มีเฉพาะของที่เคยอยู่ใน index ตอน build)
- profile types=∅ เมื่อ message ขึ้น code ล้วน+device kw ("WPB100L ใช้กับมือถือ") → eff_types ว่าง → type check ผ่านหมด (wide net — code-match rank นำอยู่แล้ว; compat typing คือ scope Task 9/10)

**tests:** +5 pinning (`test_candidate_pool_sources_5d.py` — dedupe cross-source, query_hint routing, per-request quota isolation, all-dead evidence preserved, anchor tag limitation) · verify: focused suite 77 pass · py_compile OK · diff --check OK · **ไม่มี runtime diff**

### 🔧 Task 5E: Selection Dedup + Runtime Guard Audit (2026-09-24) — fix แล้ว (ยังไม่ commit)

- **เป้า:** พิสูจน์ risk "selected card ซ้ำข้าม request เข้า LLM" ก่อนเปิด flag กว้าง
- **root cause (พิสูจน์ด้วย failing test):** `candidate_pool` dedupe เฉพาะภายใน request (merged per-res) → `select_for_llm_context` `selected.extend(picked)` ต่อ request ไม่ dedupe ข้าม → `merge_selected_products` เดิม `merged = list(selected_cards)` ไม่ dedupe ตัวเองเลย → card เดียวกัน eligible ใต้ 2 requests → **ซ้ำเข้า LLM context ได้จริง**
- **fix (root cause, generic):** `retrieval_runtime.merge_selected_products` + helper `_identity_keys(card)` — canonical identity `item_id`→`unit_id`→`model_id` (`_norm_id` เหมือน candidate_pool) — selected dedupe กันเอง first-wins, base ที่ชน identity ใดๆ ถูกตัด; card ไม่มี identity → เก็บหมด (dedupe ไม่ได้)
- **ไม่เปลี่ยน:** selection ranking, prompt, planning — ไม่มี hardcode รุ่น/สินค้า/ร้าน
- **private evidence:** ปลอดภัยอยู่แล้ว — `strip_private_evidence` ที่ selection layer ×3 + pin test `assert "_evidence"/"_selection_reason" not in p`
- **flag flow:** `_grouped_sel` set เฉพาะ flag-on (app.py ~1868); error→None, empty (ไม่มี selected+hidden)→None; merge `if _grouped_sel:` ที่ 2 callsites (~2315 KB, ~4713 main) — **flag off = products เดิม 100%, error/empty = base fallback**
- **tests:** +2 regression (`merge_dedupes_selected_among_themselves` — int/"123.0" float-str ซ้ำ+first wins+base dup ตัด, `merge_dedupes_selected_unit_model_fallback` — unit_id/model_id fallback) — RED→GREEN ยืนยัน
- **verify:** focused suite 65 pass · py_compile 5 ไฟล์ OK · diff --check OK
- **final hardening (review edge):** `_identity_keys` เดิม `""`→key `i:` → card ไม่มี identity ชนกันเองผิด — fix ให้ blank/whitespace normalize แล้วไม่สร้าง key (+test `test_merge_does_not_dedupe_blank_identity_fields` RED→GREEN)

### 🔧 กำลังจะทำ — Phase 5F: Issue Root-Cause Remediation + Token Audit (2026-09-24)

- **เป้า:** แก้ issues #26-#30 + token audit แบบ root-cause (ห้ามเชื่อ issue summary ตรงๆ — trace flow+test ก่อนแตะ)
- **scope:** 5F-A handoff anger substring FP · 5F-B claim/warranty state · 5F-C availability/link anchor · 5F-D spec grounding · 5F-E token/web_search audit · 5F-F misc QA
- **กฎ:** failing test ก่อนแก้ทุกจุด · ไม่ commit จนรายงาน+approve · ไม่ hardcode รุ่น/ร้าน/keyword

#### 5F-A ✅ — anger substring FP → `_toxic_token_present` (verify ผ่าน, ยังไม่ commit)
- **root cause:** `"กาก" in _msg_low` substring → "นาฬิกากันน้ำ" มี "กาก" (ท้ายคำ+ต้นคำถัดไป) → FP handoff; strong anger ข้าม question guard
- **fix:** module helper `_toxic_token_present` — short toxic token ต้อง standalone: หลัง token เป็นสระ/วรรณยุกต์→reject; ตัวอักษรไทยติด→นับเฉพาะ intensifier (กากมาก/ห่วยแย่); prev จบสระ→strict กว่า (หน้ากาก=product type จริงของร้าน); generic ไม่ hardcode "นาฬิกา"
- **tests:** `test_issue_5f_handoff.py` 11 pass (นาฬิกากันน้ำ/นาฬิกากับมือถือ ไม่ handoff · กากมาก/ห่วยมาก/ผิดหวังมาก handoff · ส่งช้ามากไหม ไม่ handoff)
- **tradeoff (documented):** "สินค้ากากครับ" → ไม่ handoff (polite particle ท้าย) — soft complaint ปลอดภัยกว่า FP

#### 5F-B ✅ — claim flow: name/phone hygiene + handoff no-refire (verify ผ่าน)
- **bugs จริง 3 จุด (จาก failing tests ไม่ใช่ guess):**
  1. `_extract_name_ner` เก็บ glued particle/honorific/field label → "สมชายนะคะ"/"คุณสมชาย"/"เลขคำสั่งซื้อ" เป็นชื่อ — fix strip ท้ายคำ+คำนำหน้า+reject labels (generic)
  2. `_PHONE_PATTERN` collapse spaces → "0812345678 2508088B5T4W1D" (phone ติด order) phone หาย — fix pattern บน text จริง + masking
  3. anger/human-request ยิง `_send_handoff` ซ้ำทุกข้อความระหว่าง ticket handoff แล้ว — fix `ticket_state=="handoff"` → None (post-handoff lock ตอบแทนอยู่แล้ว)
- **tests:** `test_issue_5f_claim_flow.py` 22 pass + phone/date regression 11 pass

#### 5F-C ✅ — availability audit (owner ถูกแล้ว · pin tests)
- **audit result:** `resolve_availability` = owner เดียว ใช้ครบทุก callsite (app mark `_available_for_sale` ทุก card · UNLIST note เข้า context · link follow-up ตัด short_link+ไม่ silent swap · cert label ผ่าน resolver)
- **contract pin:** `test_issue_5f_availability_anchor.py` 5 pass — UNLIST+stock>0→hidden ไม่ขาย · SELLER_DELETE/BANNED→historical answerable (ตอบ spec ได้ ห้ามขาย) · NORMAL stock0→oos visible · stock>0→sellable
- **ไม่มี runtime diff** — resolver contract เดิมครอบ semantics ครบ (ตัวเลข 0=known fact, missing=unknown)

#### 5F-D ✅ — spec grounding: prompt placeholders + spec_claim guard (verify ผ่าน)
- **root cause 2 ชั้น:** ① SYSTEM_INSTRUCTION/KB_SYSTEM_INSTRUCTION ตัวอย่างมี literal จริง (5200mAh/IP68/iOS 13/22มม./6.7นิ้ว/5W/12W + ชื่อรุ่นจริง CUKTECH/Lagenio/EC4/SC230/BioKoop) → LLM ยืมไปตอบ ② guards มี model_claim แต่ไม่เช็กเลข+หน่วย
- **fix ①:** ตัวอย่างทั้งหมด → placeholder `<…จาก context>` (เก็บ domain-knowledge numbers ใน reasoning guidance ที่สั่งห้ามตอบจากความรู้อยู่แล้ว)
- **fix ②:** `guards.enforce` + `_SPEC_CLAIM_RE` — เลข+หน่วย (mAh/W/V/A/Hz/GB/MP/ATM/dB/nit/นิ้ว/มม/ซม/เมตร/กรัม/ชั่วโมง/นาที/วัน/เดือน/ปี/ครั้ง/เท่า/พอร์ต) + IPxx + protocol ver (PD/QC/USB/BT/WiFi/Bluetooth/Qi) + bare UFCS/PPS/GaN/Qi ต้องอยู่ใน context pool (strip-space+lower) — negation นำหน้าข้าม, loop ≤4, หลัง model_claim
- **tests:** `test_issue_5f_spec_grounding.py` 26 pass (prompt hygiene pin + ungrounded→rewrite + grounded/negated/plain/handoff ผ่าน)

#### 5F-E ✅ — token accounting + web_search gate (verify ผ่าน)
- **audit: ไม่มี double-count** — `resp.usage` = billable total เดียว, `steps` = debug breakdown; UI (`bot_tokens.total`, TestChatClient) + DB (`bot_tokens`) + replay ใช้ usage ตรง ไม่บวก steps ซ้ำ
- **bug จริง — KB branch undercount:** `usage_info = _ws_r["usage"]` ทับ LLM1 ทิ้ง + `cost` ไม่รวม `_ws_cost` (product branch ถูก: `_combined_usage`+`cost+_ws_cost`) — fix `_sum_usage` helper ใช้ทั้ง 2 branch + KB cost เพิ่ม `_ws_cost`
- **contract pin:** `reanswer().usage` = LLM2 เท่านั้น; search-call tokens (OpenRouter) อยู่ steps+cost_usd — ด้วย design (ต่าง provider)
- **web_search gate bug:** `pass1_low_confidence` ยิงแม้มี products+คำตอบมั่นใจ — fix ยิงเฉพาะไม่มี products (negative answer → rule 5 จัดการเหมือนเดิม)
- **tests:** `test_issue_5f_token_accounting.py` — accounting contract + gating

#### 5F-F ✅ — misc QA audit (ส่วนใหญ่ fixed/deliberate อยู่แล้ว + 1 gate)
- **abubu:** fixed แล้ว — `bot_name` จาก persona doc fallback "ทางร้าน" (app.py ~770)
- **separator `||`/`|||`:** fixed แล้ว — `_strip_kb_markup` normalize pipe≥2→` ||| ` (issue #19)
- **language mirror:** deliberate policy — ตอบไทยเสมอ, explicit lang request → English instruction (`_lang_instruction` + `_LANG_REQUEST_RE` หลายภาษา)
- **multi-intent:** grouped retrieval ครอบแล้ว (5B-D — multi-type request slots + per-request quota)
- **sticker/noise → search:** bug จริง — placeholder-only message (`[สติกเกอร์]`/ว่าง) low conf+no products → search ยิง — fix gate ใน `should_use_web_search` (bracket-tag-l้วน/ว่าง → skip, class เดียวกับ greeting)
- **deferred (next phase — ต้อง product decision):** sticker/noise ยังผ่าน intent+LLM (2 calls ~ต้นทุนน้อย) — canned reply/เงียบต้องเลือก policy ก่อน

### Phase 5F-Hardening Gate — reviewer blocking fixes (กำลังทำ — ยังไม่ commit)
- **ทำไม:** reviewer probe เจอ 4 ช่องโหว่จริงในงาน 5F → ต้อง harden ก่อน commit 5F
- **H1:** `_TOXIC_FOLLOW_STRONG` มีคำทั่วไป (อะไร/แล้ว/ละ/อีก) → `หน้ากากอะไร` FP เป็น toxic — แก้ด้วย pythainlp tokenize (มีใน env, warranty.py ใช้อยู่แล้ว) + strict fallback
- **H2:** `spec_claim` ใช้ `_context_pool` (รวม message+history) → "รองรับ 65W ไหม" ground "รองรับ 65W" เอง — แยก `_evidence_pool` (cards+grounding เท่านั้น)
- **H3:** prompt ยังเหลือเลข spec จริงใน reasoning guidance (45W, 65W/100W/140W, 20W/30W) → genericize
- **H4:** `ticket_state in ("handoff","open")` ยังพึ่ง history marker → ยึด state เป็น source of truth
- **H5:** เพิ่ม e2e pin — hidden-only selection note / UNLIST ไม่เสนอขาย / link follow-up ไม่ silent swap / SELLER_DELETE answerable-not-sellable
- **กฎ:** failing test ก่อนแก้ทุกจุด · ไม่ hardcode คำ/รุ่น/ร้าน · ไม่ commit จน reviewer approve

#### 5F-Hardening Gate ✅ — reviewer blocking fixes (verify ผ่าน, ยังไม่ commit)
- **H1 anger matcher root fix:** `_TOXIC_FOLLOW_STRONG` มีคำทั่วไป (อะไร/แล้ว/ละ/อีก/ดิ/สิ) → "หน้ากากอะไร" FP — **fix:** pythainlp `word_tokenize` เป็น primary (token "กาก" ต้องเป็นคำแยกจริง — "หน้ากาก"=1 token, "สินค้ากาก"→["สินค้า","กาก"]); fallback = strict boundary + subject-prefix (ของ/สินค้า/ร้าน/บริการ…) + intensifier จริงเท่านั้น; lazy-load `_get_word_tokenizer` (pattern warranty._get_ner); bonus: "กากครับ"/"นาฬิกากาก" จับได้แล้ว
- **H2 spec evidence pool:** `spec_claim` เดิมใช้ `_context_pool` (รวม req.message+history) → "รองรับ 65W ไหม" ground ตัวเอง — **fix:** แยก `_identity_pool` (model_claim ใช้ message/history ได้) vs `_evidence_pool` (cards+grounding เท่านั้น); ลบ test เก่าที่ pin พฤติกรรมบอค
- **H3 prompt literals:** reasoning guidance เหลือ 45W, 65W/100W/140W, 20W/30W, Samsung S23-25, iPhone 15/14 → genericize ทั้งหมด ("วัตต์สูง/ต่ำ", "รุ่นใหม่/เก่า")
- **H4 ticket_state = truth:** `handle_warranty_flow_legacy` — เพิ่ม `_is_active_post_handoff` (handoff/open/pending→lock, closed/resolved/bot→ไม่, None→marker fallback) + `_post_handoff_gate` (extract จาก inline — info/product-q/exception ปล่อยผ่านเหมือนเดิม); lock ทำงานแม้ history ว่าง; `detect_human_request` no-refire ขยายเป็น open/pending; **v2 `handle_warranty_flow` ไม่แตะ** (out of scope)
- **H5 e2e pins:** hidden-only selection→hidden_mentions (ไม่มี card เข้า LLM) · UNLIST+stock>0 reject ทุก mode · link follow-up SELLER_DELETE→ลิงก์อยู่+note+ทดแทน tag · UNLIST anchor→ลิงก์ถูกตัดแต่เก็บผ่าน note
- **verify:** focused 95 pass + broad 14-file 158 pass · py_compile OK · diff --check OK · probes ตรง expected ทุกเคส

### Task 5F-R: Message Routing Before Retrieval ✅ (verify ผ่าน, ยังไม่ commit)
- **ทำไม:** probe battery (ข้อความ shopee จริง) เจอ mild-anger/human-request ยิงบนอาการสินค้า+คำถาม+noise — ด่านแรกพังก่อน retrieval ทำงาน
- **root cause:** mild markers ("ช้ามาก/นานมาก/ไม่มีการตอบ") + bare-"แอด" rule เป็น flat substring — ไม่แยก subject (บริการร้าน vs อาการสินค้า vs กริยาเวลา vs greeting/spam)
- **fix (`handoffs.py` — semantic groups + span masking, ไม่มี exception รายคำ):**
  - `_term_spans`/`_overlaps`: marker/kw ที่ทับ product span ไม่นับ ("ไม่มีการตอบ|สนอง", "ทำไมไม่ตอบ|สนอง")
  - `_mild_anger_fires`: mild fires iff มี service context (รอ/ตอบ/ส่ง/ทัก/ร้าน/พัสดุ…) นอก marker+product span — หรือไม่มี product/history context เลย (bare "ช้ามาก" ยังยิง)
  - `_is_question_message`: QGUARD ตรวจหลังตัด vocative tail (ครับ/ค่ะ/แอด/นะ) → "รอนานไหมครับแอด" = คำถาม + bare-แอด rule ยกเว้นคำถาม
  - `_SHOP_SCRIPT_TERMS` (ยินดีต้อนรับ/ตอบช้าหน่อย) → suppress mild; `_PROMO_TERMS` (คอมมิชชั่น/affiliate) → suppress anger ทั้งหมด
- **ผลกระทบเคสอื่น:** service complaint ปน product noun ยังยิง ("สั่งสายชาร์จแล้วร้านส่งช้ามาก"→fire); claim intent ("ชาร์จช้ามากขอเคลม") ไหลต่อไป warranty_flow ไม่โดน anger กลืน; strong anger ไม่แตะ (ยกเว้น promo)
- **verify:** ไฟล์ใหม่ `docs/test/test_anger_detection_regression.py` 39 เคส (11 escalate + 10 product + 14 neutral + 2 noise + claim/service mix) + probe 32/32 + focused 10 ไฟล์ 139 pass · py_compile OK · diff --check OK · hardcode scan clean
- **ยังไม่ครอบ:** v2 `detect_human_request` (SRS 6.x ตาราง chat_v3 — แยก implementation, out of scope)

### Task 13-lite: Owner/Complexity Checkpoint (audit-only — ก่อน Phase 6, ยังไม่ commit)

#### Owner map (สแกนโค้ดจริง 2026-09-24)

| Decision | Final owner | Duplicate owners ปัจจุบัน | Delete/keep + gate |
|---|---|---|---|
| request facts (types/subtype/codes/question shape) | `route_context.py` (`build_retrieval_profile`, `requested_product_types`) | `product_store._detect_charger_subtype`/`_detect_product_types` (impl ต้นทาง), nested `_resolve_charger_subtype` ใน app.py:661 + call sites อย่างน้อย 5 จุด (KB/device lookup, superlative skip, main fetch, no-product guard) | ลบ closure หลัง profile ครอบทุก call site — gate: `test_route_context.py` + replay |
| message/action route | `handoffs.detect_human_request` (legacy) — owner ถาวรรอ Task 11 | `chatbotv3/emotion.detect_human_request`+`detect_negative_emotion` (v3, impl แยก logic เก่าแบบ substring) | Task 11 ตัดสิน owner; ห้ามขยาย handoffs.py เพิ่ม — gate: `test_anger_detection_regression.py` |
| warranty/claim route | `warranty_flow.handle_warranty_flow_legacy` (app.py:1669 caller) | `handle_warranty_flow` (v2, chat_v2.py:608) — ~850 บรรทัด/อัน parallel impls; **H4 fix อยู่เฉพาะ legacy** | Task 11 unify หรือ port `_is_active_post_handoff`/`_post_handoff_gate` ไป v2 — gate: `test_issue_5f_claim_flow.py` |
| candidate retrieval | legacy: `product_store.fetch_products` + app.py branches; grouped: planner→executor→pool→selection→runtime | 2 paths คู่ขนานจนกว่า Phase 6-10 เลือก | เก็บทั้งคู่จน replay gate — flag: `USE_GROUPED_RETRIEVAL_*` |
| candidate pool | `candidate_pool.build_candidate_pool` | เข้าถึงได้เฉพาะผ่าน runtime/shadow (flag-gated) | เก็บ; ลบทั้ง chain ถ้า replay ปฏิเสธ grouped |
| final LLM context | `retrieval_selection.select_for_llm_context` + `retrieval_runtime.merge_selected_products` | merge จุดอื่นใน app.py: `_merge_kb_mongo` (KB+mongo), web-search replacement merge | Task 13 เลือก merge boundary เดียว — gate: `test_retrieval_selection_runtime.py` |
| availability | `product_store.resolve_availability` ✅ | callers: units/app/handoffs — ศูนย์กลางถูกแล้ว | keep |
| compatibility proof | `device_compat.py` | shim `_resolve_charger_subtype` (app.py), product-family hardlogic | ลบ shim หลัง Task 10 |
| handoff POST / post-handoff lock | `handoffs` + `warranty_flow._post_handoff_gate` (legacy เท่านั้น) | v2 inline gate ยังพึ่ง history marker | parity gap — port หรือรอ Task 11 |
| link follow-up | `app._prepare_link_followup`/`_link_followup_keep` | — | keep (owner เดียวอยู่แล้ว) |
| usage accounting | `app._sum_usage` | — | keep |

#### Duplicate/complexity audit

| Item | Caller | Verdict |
|---|---|---|
| `retrieval_runtime.prepare_grouped_selection` | wrapper ครบจบที่ใช้ใน tests/probes เท่านั้น; production flag path ใช้ `run_grouped_selection` แล้ว merge เองใน app.py | **contract/probe wrapper** — อาจลบหรือ inline หลัง Phase 6-10 เลือก final boundary |
| `retrieval_shadow.run_grouped_retrieval_shadow` | app.py:1860 (flag `USE_GROUPED_RETRIEVAL_SHADOW`) | observe-only — เก็บจน replay แล้วลบ (plan กำหนด) |
| `retrieval_runtime.run_grouped_selection`/`merge_selected_products` | app.py:1881 + merge site (flag `USE_GROUPED_RETRIEVAL_SELECTION`) | flag-gated — removal decision หลัง replay |
| `app._resolve_charger_subtype` (nested closure) | app.py:2010, 2192, 3784, 3845, 4235 (อย่างน้อย 5 call sites) | **shim ใหญ่ — Task 13 delete หลัง `RetrievalProfile.subtype` ครอบทุก caller** |
| `chatbotv3/emotion.detect_human_request`/`detect_negative_emotion` | chatbotv3/engine.py | duplicate impl logic เก่า — Task 11/13 delete หรือ port |
| `handle_warranty_flow` vs `_legacy` | v2 vs app.py | **duplication ใหญ่สุด** (~850×2 บรรทัด) — Task 11 |
| `app._get_post_handoff_exceptions` | ไม่มี direct caller ใน app.py แต่ `warranty_flow` เรียกผ่าน `_app_module` ทั้ง v2/legacy | owner คลาดเพราะ helper อยู่ app.py แต่ decision อยู่ warranty_flow — ย้ายความเป็นเจ้าของได้ใน Task 13/11 |
| `app._recent_qa_pairs`, `_merge_kb_mongo`, `_link_followup_keep` | 1 call site ต่ออัน | inline candidates — ตัดสิน Task 13 |
| nested closures (`_extract_charger_constraints`, `_is_good_keyword`, `_extract_max_mah`, `_extract_weight`) | local เท่านั้น | keep — scope ถูก |
| `USE_GROUPED_RETRIEVAL_SHADOW`/`_SELECTION` | runtime_config DB+env | เก็บจน replay decision |

#### File size: app.py 5,159 (+~860 จากต้นแผน) · warranty_flow 2,082 (2 impls) · handoffs 608 · route_context 1,090 · product_store 4,346

#### Risk ถ้าเริ่ม Phase 6 ตอนนี้
- เพิ่ม retrieval path ที่ 3 โดยไม่เลือก legacy vs grouped → owner ซ้อน
- final LLM context มี merge ≥3 จุด (KB merge / grouped merge / web merge) — Phase 6 ห้ามเพิ่มจุดที่ 4
- handoffs.py ห้ามโตต่อจนกว่า Task 11 owner ชัด (plan บังคับ)
- v2 warranty path ขาด H4 fix → ถ้า v2 live อยู่จริง product escape risk ยังเปิดอยู่

#### Verdict: ไป Phase 6 ได้ ภายใต้ guardrails
1. Phase 6 ต้องเลือก/ประกาศ candidate path winner (หรือเก็บ flag ไว้และ commit ว่าจะตัดใน Task 13)
2. ห้ามเพิ่ม merge boundary ใหม่ — ใช้ `merge_selected_products` หรือ boundary เดิมเท่านั้น
3. ห้ามขยาย `handoffs.py`/`warranty_flow.py` helper — routing ใหม่ไปที่ Task 11 owner
4. helper ใหม่ใน Phase 6 ต้องตอบ: ลบ duplicate อะไร / inline ไม่ได้เพราะอะไร
5. port `_is_active_post_handoff` ไป v2 เมื่อ policy อนุญาตให้แตะ v2 (หรือบันทึกเป็น Task 11 item)

---

## Phase 6 — Selection Policy Owner Refinement (audit → 2 bugs → TDD fix)

### Audit result (flow จริงที่ตรวจ)

`app.py` flag `USE_GROUPED_RETRIEVAL_SELECTION` → `run_grouped_selection` (planner→executor→pool→selection) → `merge_selected_products` เข้า KB path (~2325) + main path (~4725) — boundary เดิม 2 จุด ไม่เพิ่ม · flag-off → `_grouped_sel=None` fallback path เดิมครบ · unavailable/hidden ไป `extra_context` เท่านั้น (ไม่ใช่ selected card) · rejected → summary counts · dedupe key = item_id→unit_id→model_id normalized · private evidence strip ที่ `_select_one`/pool `llm_ready` · web search merge เป็น boundary แยก — ไม่แตะ

### Bugs found + fixed (TDD)

| Bug | Root cause | Fix (owner) | RED→GREEN |
|---|---|---|---|
| multi-subtype slot (`หัวชาร์จกับสายชาร์จ` → subtypes={adapter,cable}) fetch เหลือ subtype เดียว — อีก subtype ไม่เคยเข้า pool | `_request_profile` ส่ง subtype เดียว → `product_store._filter_charger_subtype` hard-cut + units `ptypes` narrowing | `retrieval_executor._request_profile`: multi-subtype → `subtype=None` + expand `product_types` ตาม `_SUBTYPE_TO_TYPES` ทุก subtype | `test_multi_subtype_slot_fetch_not_narrowed_to_one_subtype` |
| request เดียวหลาย subtype — subtype score สูงกิน `per_request_limit` หมด → subtype ที่ถาม (ขายได้) หายจาก LLM context | `select_for_llm_context` pick `ranked[:quota]` ไม่เช็ก coverage | `retrieval_selection`: subtype coverage — ทุก subtype ที่ถาม+มี candidate ได้ ≥1 ที่ (swap tail ที่ไม่ใช่ representative เดียว) | `test_multi_subtype_quota_one_subtype_cannot_eat_all` |

### Verify: focused 8 ไฟล์ 92 pass (รวม 2 test ใหม่ + slots/requests regression) · py_compile OK · diff --check OK · hardcode scan clean

### Audit answers ที่เหลือ (ไม่มี bug)
- unavailable/UNLIST = evidence เท่านั้น ไม่ recommend (pin โดย 5C tests) · exact/anchor preserve (code-hit + subject role) · cross-request dedupe ที่ merge boundary (5E) · spec constraints (display/2m/speed) มีผล ranking จริง (`test_constraint_ranking_display_length_speed`)
- lower-ranked sellable หลุดเพราะ quota = by design ยกเว้น subtype coverage ที่แก้แล้ว

### Residual risk
- `per_request_limit=3` ยังตัดสินค้าขายได้ rank ต่ำใน subtype เดียวกัน — trade-off context size เดิม
- coverage swap เลือกตาม subtype field ใน card — card ไม่มี subtype field ไม่ถือเป็น representative (conservative)

---

## Phase 0C — Review Closure: import-boundary isolation + report honesty (แก้ 2026-09-30)

### Root causes → fixes (TDD)

| Finding | Root cause | Fix | RED→GREEN |
|---|---|---|---|
| A: import stubs leaked process-wide | lambdas ติดตั้ง dotenv/socket/urlopen/MongoClient ตอน collection ไม่มี restore — test module อื่นใน pytest process เดียว inherit patches | stub เฉพาะใน try/finally รอบ `from shopeechat import ...` — restore originals ทันทีหลัง import | `test_replay_import_isolation.py` (ไฟล์แยก ไม่มี autouse guard): RED `leaked=[...4 lambdas]` → GREEN; ต้องอยู่คนละ module เพราะ `_offline_guard` re-patch ตอนเทสต์ mask leak |
| B: `pos-policy-seller-wrong-item` อ้าง "กัน deny-all" เกินหลักฐาน | assert แค่ answer ไม่ว่าง/ไม่ handoff/ไม่ web_search — ไม่ได้ assert route, LLM-call count หรือ eligibility | title/boundary_note เขียนใหม่ตรง assertion จริง (option A — ไม่เพิ่ม evaluator logic); eligibility/deny-all รอ Phase 5 PolicyDecision | fixture text only — validator 40 rows ยังผ่าน |
| C: policy incident note ไม่แยก proven/unproven | boundary_note รวม claim เดียว | แยกชัด: PROVEN=route answer_general/qtype=return_policy ภายใต้ fixture+stub; NOT PROVEN=real classifier route/live FAQ text/eligibility | fixture text only |
| D: L3 count/คำอธิบายเกินหลักฐาน | รายงานเดิม L3=25 stale; "legacy engine actually ran" อ้างเกิน | ใช้ validator output สด (L3=27); comment `_expectations_met` ชี้ chat_engine=engine-flag check ไม่ใช่หลักฐานทุก adapter รัน | live output |
| E: tx-q15 ยัง unproven | pending_reason เดิมฟันธง artifact เกินไป | เขียนใหม่: fake-DB mismatch = คำอธิบายที่สอดคล้องกับอาการ ไม่ใช่ข้อพิสูจน์; live replay ยังต้องทำ | fixture text only |
| F: warnings attribution ผิด | รายงานเดิม "5 warnings = FastAPI ทั้งหมด" | output สด: 4× FastAPI `on_event` (app.py:77/:107 + fastapi internals) + 1× google.genai.types `_UnionGenericAlias` (py3.17) | grep warnings summary |

### ผล verify สด
- validator: 40 rows — 28 positive / 8 incident / 2 answer_level / 2 pending_live_replay · **L3=27** · grouped-on=0 · contract-only=13
- replay+isolation (combined same process): **45 passed, 19 skipped, 8 xfailed, 5 warnings** — isolation test พิสูจน์ไม่มี lambda ค้างใน globals
- py_compile 4 files OK · git diff --check clean · runtime/ChatAdminWeb/.env diff = 0
- ไม่มี commit/stage — รอ review

### ✅ Review Closure รอบ 2 (2026-09-30) — เสร็จ รอ review · ไม่มี runtime change · ยังไม่ commit
- F1 (option A — ลด claim): `pos-policy-seller-wrong-item` title/note เขียนใหม่ — assert เพียง answer ไม่ว่าง + ไม่ handoff + ไม่ web_search; ไม่อ้าง route, no-LLM-call, eligibility หรือ deny-all guard (รอ Phase 5 PolicyDecision)
- F2 (subprocess identity probe + bound-alias hardening): `test_replay_import_isolation.py` — fresh interpreter ติดตั้ง fail-fast trap บน `dotenv.load_dotenv` **ก่อน** import replay module (app.py ส่ง explicit `.env` path — cwd sentinel เดิมพิสูจน์ไม่ได้และ unsafe-on-regress → ถูกตัดออก) → snapshot identity 4 provider globals → import → assert trap ไม่ถูกเรียก + identity คืนเหมือนเดิม (`is`) **+ เช็ก module-bound aliases `replay.app.load_dotenv` / `replay.knowledge_base.load_dotenv` ด้วย** (รอบแรกเช็กแค่ provider — `from dotenv import load_dotenv` bind lambda ไว้ใน module namespace ทำให้ restore provider เดียวไม่พอ) · ordering-independent · RED 1: ถอด dotenv-stub ใน module → trap จับ `load_dotenv('repo/.env')` fail ก่อนอ่าน `.env` จริง · RED 2: alias check → `bound dotenv aliases installed: app.load_dotenv, knowledge_base.load_dotenv` (lambda ค้างจริง) → fix: finally restore aliases ด้วย `_orig[0]` → GREEN · `_offline_guard` เพิ่ม `_dotenv_guard` fail-fast patch ทั้ง 3 bindings (dotenv/app/knowledge_base) — ห้าม silent-False lambda + meta-test `test_offline_guard_blocks_dotenv_aliases` พิสูจน์ทุก binding trip `OFFLINE LEAK` · ยังไม่พิสูจน์ global อื่นนอก set นี้และ env pins
- F3 (supersede-note): entry Phase 0C Final Semantic Closure เก่า — annotate ตัวเลข 25→27 flag_off, claim "กัน deny-all", และ tx-q15 เป็น plausible explanation ไม่ใช่ข้อพิสูจน์ (history คงไว้ ไม่ลบ)

### Phase 0 follow-up findings — shadow rerun 2026-09-30 (จดเข้า rebaseline plan แล้ว)
- **Runtime check:** bot rerun ผ่าน screen session `shadowbot-debug`; รอบที่ bot พร้อมจริง shadow conversation `shp_152520383445167602` จบครบ `done docs=39` และ Python `/chat` เป็น `200 OK` ทุก turn — error "ข้อความที่ 10" ก่อนหน้าเกิดจาก bot port 8010 ไม่พร้อมช่วง restart/debug (`fetch failed`) ไม่ใช่ traceback Python ของ Q10
- **UNLIST leak ยังไม่จบ:** transcript ล่าสุด Q15 ตอบ WPB100L เป็น not-yet-on-sale ถูกทาง แต่ Q17 กลับแนะนำ WPB100L รุ่นเดียวกันพร้อมรูป/ลิงก์ในฐานะ alternative — แปลว่า `customer_hidden`/UNLIST ยังไม่ถูก enforce ที่ final answer-context boundary ทุกทาง (anchor/alternative/base merge/link follow-up ยังรั่วได้)
- **Token/latency จริง:** live log เห็นหลาย product turns ใช้ prompt ~53K-56K tokens (`products=30`, `include_desc=True`, history โตถึง 20 turns) และ batch 39 turns ใช้เวลาหลายนาที — Phase 0 ต้องเพิ่ม token/latency baseline + Phase 7 ต้องมี AnswerContext budget ก่อน LLM
- **Shadow placeholder pollution:** `[bundle_message]` และ `[faq_liveagent]` ถูกส่งเข้า bot เป็น message จริง ทำ retrieval/LLM และ handoff text เข้า history แล้วกระทบ turn ถัดไป — ต้องทำ fixture/gate ใน Phase 0 และแก้ผ่าน TurnDecision/Shadow input normalization ไม่ใช่ hardcodeคำตอบรายเคส
- **Plan update:** เพิ่ม rows ใน `docs/plans/2026-09-30-legacy-shopee-unified-turn-evidence-retrieval-rebaseline-plan.md` สำหรับ UNLIST leakage, token/latency, placeholder normalization และ RED gates ใน Revised Phase 0

---

## Phase 0 Closeout + Phase 1 Audit/Plan (2026-09-30)

### ✅ Phase 0 committed: `3acefe3` — `test: add legacy replay rebaseline and import isolation gates`
- 10 files (harness 3 + fixtures 2 + gold/eval + plans 2 + log) · verify สดก่อน commit: validator 40 rows / replay+isolation 46p 19s 8x / py_compile / diff --check / runtime diff=0

### 🔍 Phase 1 audit (plan-only — รออนุมัติ ยังไม่แก้ runtime)
- Action decision กระจาย ≥6 owners ที่ evaluate คนละจุด/คนละ input: `handoffs.detect_human_request` (pre-intent), intent_classifier + inline intent↔keyword merge (app.py ~1329), `warranty.detect_claim_request`, `warranty_flow.handle_warranty_flow_legacy` (claim SM + `_post_handoff_gate`), follow-up rewriters ที่ mutate `req.message` กลางทาง, item_tag/CONV-ACTIVE keyword blocks
- Input ไม่ได้ normalize รวม: placeholder stripping ทำซ้ำ ≥4 จุด (~957, ~1530, ~2517, `_post_handoff_gate` inline re.sub) — `route_context.normalize_message` แก้แค่ typo
- แนวแก้เสนอ: `TurnDecision` owner เดียว (fixed-order evaluation, detectors เป็น predicates) — รายละเอียดในรายงานส่ง user รอ approval

### 🚧 Revised Phase 1 — TurnDecision contract owner (contract-only, ยังไม่ wire runtime)

- **ทำ:** `shopeechat/turn_decision.py` — `TurnDecision` frozen dataclass (9 actions) + `decide_turn()` pure function, fixed order: normalize→lock→noise→human→claim(resume→request)→anger→followup→product/general→unknown · ใช้ detectors เดิมเป็น predicates เท่านั้น (ไม่ copy keyword): `handoffs.is_human_request`/`is_service_anger` (extract verbatim → module-level จาก detect_human_request, zero behavior change), `warranty.detect_claim_request`/`extract_customer_info`/`parse_purchase_date`, `knowledge_base.detect_general_question`/`extract_model_keywords`, `route_context.resolve_route`
- **Root cause ที่แก้:** decision กระจาย ≥6 จุด + placeholder stripping ซ้ำ ≥4 ที่ + req.message ถูก mutate กลางทาง + anger อยู่ก่อน claim (product issue เสี่ยงโดนกลืน)
- **TDD:** `docs/test/test_turn_decision.py` 41 tests — RED (module missing→collection error) → GREEN · shadow-vs-fixtures contract test พบว่า: product-question ต้องใช้ route_context detector (ไม่ใช่แค่ intent), ticket_state อยู่ fixture-level, placeholder→noise ต้องยกเว้นใน family check (legacy ตอบ generic)
- **ยังไม่ wire เข้า app.py** — contract เท่านั้น; SRS §6.35 + §6.13 อัปเดต

### 🔧 Phase 1A Hardening — purity leak ของ turn_decision (2026-09-30, รอ review · ยังไม่ commit)

- **Blocker (reviewer พบ):** `turn_decision.py` import `knowledge_base` top-level → `knowledge_base._load_env()` เรียก `load_dotenv(repo/.env)` ตอน import → contract ที่ claim pure/no-env ไม่จริง (รั่วเข้า test แล้วตอน `test_turn_decision` รันเดี่ยว) — root cause เดียวกับ Phase 0C alias issue: purity ต้องพิสูจน์ ไม่ใช่ประกาศ
- **Fix:** สร้าง `message_detectors.py` (pure, stdlib `re` เท่านั้น) — ย้าย verbatim `GENERAL_QUESTION_KEYWORDS`, `detect_general_question`, `_TARGET_DEVICE_KWS`, `is_target_device_kw`, `extract_model_keywords`; `knowledge_base.py` re-export 4 symbols (public API คงเดิม — app/web_search/chat_v2 เรียก `knowledge_base.*` เหมือนเดิม); `turn_decision` เปลี่ยน import เป็น `message_detectors` (ห้าม import knowledge_base — docstring ระบุไว้)
- **Audit chain:** warranty/handoffs/route_context ไม่มี dotenv/DB ตอน import; route_context lazy-import product_store (pymongo ตอน import แต่ไม่ connect/ไม่อ่าน env — MongoClient สร้างใน function เท่านั้น); turn_decision lazy-import route_context ใน decide_turn → probe ยืนยัน call-time ก็ไม่แตะ dotenv
- **TDD:** RED (purity probe fail — trap จับ `load_dotenv` ผ่าน knowledge_base import; compat probe fail — module ไม่มี) → GREEN 43 tests
- **Tests เพิ่ม (subprocess probes):** `test_turn_decision_pure_import_and_call` — fail-fast trap บน `dotenv.load_dotenv` ก่อน import turn_decision + เรียก decide_turn 2 เคส (product/general) · `test_knowledge_base_detector_compat_unchanged` — suppress-only lambda (ไม่ใช่ trap — knowledge_base import ต้องผ่าน) แล้ว pin parity `knowledge_base.*` ≡ `message_detectors.*` ทั้ง 3 symbols · ทั้งคู่ไม่อ่าน `.env` จริง
- **Verify:** turn_decision 43p · replay+isolation 46p/19s/8x (unchanged — parity proof) · validator 40 rows · py_compile 4 files · diff --check clean · forbidden diff=0
- **Residual risk:** purity probe ครอบ dotenv-load path ของ turn_decision เท่านั้น — module อื่นที่มี side effect อื่น (เช่น module-level env read นอก load_dotenv) ไม่ได้ถูกจับ; SRS §6.36 เพิ่ม, §6.35/§6.x knowledge_base rows อัปเดตเป็น re-export

### 🔬 Phase 1B — TurnDecision shadow wiring (observe-only) (2026-09-30, รอ review · ยังไม่ commit)

- **สิ่งที่ทำ:** `_turn_decision_shadow(req, history, steps)` ใน `app.py` — เรียก `decide_turn` ผ่าน lazy import หลัง history step ใน `_chat_impl` (ก่อน deterministic/handoff early returns → จับทุก turn; intent_result ยังไม่มี → None) · flag `USE_TURN_DECISION_SHADOW=1` (default off) · trace = `{name, ok, action, reason, confidence, flags, message_len}` — ไม่มี raw message/history (PII-safe) · exception → `ok=False` step · **ไม่ mutate/early-return/กระทบคำตอบ**
- **Root cause ที่แก้:** contract มีแต่ไม่มีข้อมูลจริงเทียบ legacy — shadow wiring ให้ compare data โดยไม่เสี่ยงเปลี่ยน behavior
- **TDD:** `docs/test/test_turn_decision_shadow.py` 10 tests — RED 7 fail (ไม่มี trace) → GREEN · covers: flag off → ไม่มี trace, flag on → trace เดียว, decide_turn raise → ok=False + chat ไม่พัง, answer identical on/off, trace ไม่มี PII (เบอร์โทรไม่รั่ว), placeholder→noise, product issue→ไม่ handoff, human request→handoff, ticket active→locked
- **Sweep (52 turns, 40 fixtures, missing=0):** match — placeholders→noise, claim→claim_request, product→answer_product, ticket→locked (tx-q28, route-open-ticket-locks ถูก lock ก่อน anger — parity ทิศทาง) · **mismatch ที่บันทึก (ไม่แก้ — Phase 1C data):**
  - "ราคาเท่าไหร่"/"ขอลิงค์" follow-ups → `unknown` (`_FOLLOWUP_KWS` ยังไม่ครอบ price/link asks — contract step 7 แคบกว่า production follow-up family)
  - "0812345678" (claim fill turn) → `answer_product` แทน claim_collect — digit token โดน extract_model_keywords จับ + claim_state ใน fixture อาจว่าง (ต้อง trace เพิ่มใน 1C)
  - "ตัวไหนมี มอก. บ้าง" → followup vs legacy handoff (tx-q10)
- **Verify:** shadow 10p · turn_decision 43p · replay+iso 46p/19s/8x (unchanged) · validator 40 rows · py_compile 5 files · diff --check clean · forbidden diff=0 · SRS §6.1 เพิ่ม `_turn_decision_shadow`
- **ยืนยัน:** runtime answer ไม่เปลี่ยน (flag default off + test พิสูจน์ answer identical on/off) · TurnDecision ยังไม่เป็น owner จริง

- **Hotfix (reviewer พบ blocker):** helper แทรกผิดตำแหน่ง — `@app.post("/chat")` ติดกับ `_turn_decision_shadow` แทน `chat` → route `/chat` ถูกผูกกับ helper · **fix:** ย้าย decorator กลับไปหา `def chat` (helper อยู่ก่อน decorator) — logic ใน helper ไม่เปลี่ยน · **regression test:** `test_chat_route_still_points_to_chat_endpoint` assert `/chat` POST endpoint = `chat` (RED → GREEN) · verify สด: shadow 11p / turn_decision 43p / replay+iso 46p-19s-8x / validator 40 rows / py_compile 5 files / forbidden diff=0 · runtime answer ไม่เปลี่ยน · ยังไม่ commit

### 🛠 Phase 1C — TurnDecision mismatch hardening (contract/shadow only) (2026-09-30, รอ review · ยังไม่ commit)

- **แก้ (contract เท่านั้น, runtime ไม่เปลี่ยน):**
  - **price/link follow-up → unknown** — เพิ่ม semantic families `_LINK_NOUN_KWS`+`_LINK_OBTAIN_KWS`/`_PRICE_ASK_KWS` ใน step 7, **context-gated** (history หรือ item_tag) + `_NON_PRODUCT_LINK_KWS` exclusion (สมัคร/สมาชิก/เพจ/ไลน์ ฯลฯ) → `followup` + `link_followup`/`price_followup` flag · comparison family เปลี่ยนจาก ad-hoc `_FOLLOWUP_KWS` เป็น canonical `route_context._COMPARISON_FOLLOWUP_KW + _SUPERLATIVE_KW` (เจ้าของเดิม ไม่ copy)
  - **phone/order-only → answer_product** — step 8: `warranty.extract_customer_info` hit → flag `contact_info` + ตัด token ที่เป็น contact value ออกจาก model-kw evidence → "0812345678"/"2508088B5T4W1D" ลอยๆ → `unknown` ("contact info without claim context"); มี claim_state → `claim_collect` เหมือนเดิม
  - **cert/มอก → step 6.5 ใหม่** — `warranty.detect_cert_question` → `answer_product`+`cert_question` (owner = deterministic cert path ใน post_intent_handoffs — escalate เมื่อไม่เจอเป็น downstream) · ชนะ generic follow-up ("ตัวไหนมี" กลืนรอบแรก) → ต้องอยู่ก่อน step 7
- **Root cause ของ mismatch:** contract step 7 follow-up ใช้ kw set ad-hoc (ไม่มี price/link family) + step 8 นับ digit/alnum token เป็น model kw ไม่ว่าบริบท + ไม่มี cert family
- **TDD:** +11 tests ใน test_turn_decision (5 RED → GREEN: price/link w/ history, phone-only w/o state, order-id w/o state, cert) · +1 pin test ใน shadow suite ยึด 4 fixture turns ที่แก้
- **Intentional mismatch ที่ยังเหลือ (ไม่ force pass):**
  - tx-q10 "ตัวไหนมี มอก. บ้าง" → contract `answer_product` vs legacy `handoff` — legacy handoff เพราะ fake catalog ไม่มี cert docs (contract ถูกทาง — cert path ตอบ deterministic ถ้ามี evidence)
  - "ชื่อ สมชาย ใจดี" (name-only fill) → `unknown` (ยัง — name ไม่ใช่ claim signal เดี่ยวใน contract)
  - "รุ่นนี้ยังมีขายไหมครับ" / "มีตัวไหนบ้าง" → `unknown` — ไม่มี stock-ask/select family (Phase ถัดไปค่อยตัดสิน owner)
- **Verify:** turn_decision 53p · shadow 12p · replay+iso 46p/19s/8x unchanged · validator 40 rows · py_compile · diff --check clean · forbidden diff=0
- **ยืนยัน:** shadow-only — ไม่มี runtime caller ใหม่, app.py diff เดิม (helper+callsite เดียว), คำตอบจริงไม่เปลี่ยน

- **Phase 1C review fix — context gate กว้างเกิน (reviewer probe พบ):** `bool(history)` นับทุก history เป็น context → "ราคาเท่าไหร่" หลัง greeting/human-request/claim history เป็น followup ผิด · **fix:** `_history_has_product_context()` — scan last 6 turns, normalize+ข้าม placeholder/noise, True เมื่อเจอ item_tag / extract_model_keywords / resolve_route(product_types|subtype|model_codes); exception ต่อข้อความ → ข้าม (ไม่ทำ decision พัง) · ใช้ gate step 7 ทั้ง link/price/compare · **TDD:** +5 tests (3 RED: greeting/human-request/claim history → not followup; 2 positive: product history → followup) · verify: turn_decision+shadow 70p · replay+iso 46/19/8 unchanged · runtime ไม่เปลี่ยน

### 🛠 Phase 1D — residual gap hardening (stock/select + name fill) (2026-09-30, รอ review · ยังไม่ commit)

- **Production owners (จาก code จริง):** stock/select ไม่มี detector เฉพาะ — ไหลผ่าน product path ปกติผ่าน anchor (`_SINGLE_ITEM_REF_KW` "รุ่นนี้" → CONV-ACTIVE) หรือ fetch · name fill อยู่ใน `warranty_flow._merge_claim_slots` — name valid ต้องมี space + ≤40 chars + ไม่มี digit; `extract_customer_info` (NER+regex) จับ "สมชาย ใจดี" ได้จริง
- **แก้ (contract-only):**
  - `_STOCK_ASK_KWS`/`_SELECT_ASK_KWS` semantic families ใน step 7 — product-context-gated เหมือน price/link → `followup` + `stock_followup`/`select_followup`
  - `_valid_claim_name()` — mirror production slot rule; เข้า `_has_claim_signal` (claim_state+name → `claim_collect`) และ contact_info check ใน step 8 (name-only ไม่มี state → `unknown`+`contact_info` ไม่ใช่ product)
- **TDD:** +8 tests — RED 4 (stock/select w/ product history, name w/ + w/o claim_state) → GREEN · negative: greeting/claim history → not followup, no-history stock → not product, `มี AC65B ไหม`+claim_state → ไม่กลืนเป็น claim_collect
- **Sweep residual (ตั้งใจ — contract เห็นแค่ request-level context):** tx-q15 `รุ่นนี้ยังมีขายไหม` / tx-q18 `ขอลิงค์ตัวนี้` / sel-all-dead / avail-* / pos-image — single-turn, ไม่มี history → `unknown` ถูกต้อง (anchor จริงอยู่ใน DB — wiring phase ต้องส่ง anchor เข้ามา) · tx-q22q25 name turn → `unknown` เพราะ fake ไม่มี claim_state (incident เดิม)
- **Verify:** turn_decision+shadow 78p · replay+iso 46/19/8 unchanged · validator 40 rows · py_compile · diff --check · forbidden=0 · runtime ไม่เปลี่ยน (shadow-only)

### 📋 Phase 1E — readiness audit (2026-09-30, audit-only · ไม่มี code change)

- **Verdict: wire nothing yet** — blockers: (1) `locked` ไม่มี `post_handoff_exceptions` input — production gate honor per-shop exceptions จาก shop_settings (app.py `_get_post_handoff_exceptions`), contract ใช้แค่ ticket_state → wire ทับจะ over-lock (2) `noise` ไม่มี answer path — wiring = runtime behavior ใหม่ต้อง approve ก่อน (3) claim_collect/followup ต้องมี anchor+claim-state owner (Phase 2) (4) coverage บาง: claim_collect=0 rows, locked=2 rows
- **รายละเอียดตาราง risk ต่อ family + tests-that-must-exist + rollback อยู่ใน rebaseline plan §Phase 1E**
- verify: ไม่มี code change — suite เดิมผ่าน (78p turn_decision+shadow, 46/19/8 replay)

### 📋 Phase 1F — TurnDecision contract inputs (2026-09-30 · committed 813e3ec)

- **Root cause**: contract ขาด 3 inputs ที่ production gate ใช้ — (1) `post_handoff_exceptions` → contract over-lock (ข้อความที่แอดมินตั้ง exception ก็โดน locked); จริงๆแล้ว production escape กว้างกว่าที่เคยเข้าใจ: greeting `"สวัสดี"` ก็อยู่ใน `_POST_HANDOFF_PRODUCT_KWS` → test lock เดิม encode semantics ผิด (2) `active_anchor` → anchor-backed turns (`รุ่นนี้ยังมีขายไหม`, `ขอลิงค์ตัวนี้`) เป็น unknown เพราะไม่มี context (3) `claim_state` ใช้ truthy แทน provenance — production ใช้ `_claim_collecting` (stage=collecting หรือมี slot persist)
- **Fix (contract-only + shadow callsite snapshot)**: `decide_turn` +2 params (`post_handoff_exceptions`, `active_anchor`) backward compatible · step 2 เพิ่ม `_post_handoff_escape` mirror `_post_handoff_gate` ทุก escape (claim info / product kw ¬warranty kw / shop exceptions) → flag `post_handoff_escape` · claim_state gate เปลี่ยนเป็น `_wf._claim_collecting` (reuse เจ้าของเดิม) · step 7 ctx += `_anchor_has_product_context` · callsite: `load_timeline` ครั้งเดียว → `claim_state` + `active_item_id` จาก doc เดียวกัน (anchor snapshot = `{item_id}` เท่านั้น, ไม่ materialize card) + exceptions เฉพาะ ticket active
- **Test fix ที่ production-semantics ถูกต้อง**: lock tests เดิมใช้ `"สวัสดีครับ"` (อยู่ใน product-kw escape → production ไม่ lock) → เปลี่ยนเป็น `"ยังไม่มีใครตอบเลย"` + เพิ่ม pin `test_active_ticket_does_not_lock_greeting`; claim_state fixture key `name` → `customer_name` (real slot key)
- **RED→GREEN**: 7 RED → 90/90 pass · sweep: tx-q15/tx-q18 จาก unknown → **followup ตรง production** (fake มี anchor) · tx-q22q25 name/phone ยัง unknown ถูกต้อง (fake ไม่มี claim_state)
- **Residual**: claim_collect ยังไม่มี fixture rows จริง · `noise`/`locked` ยังไม่ wire — รอ readiness ใหม่หลัง inputs ครบ
- verify: 90p turn_decision+shadow · 46/19/8 replay+iso · validator 40 rows · py_compile · forbidden=0 · **runtime answer ไม่เปลี่ยน (shadow-only)**

### 🔧 Phase 1F review-fix — honest claim semantics + minimal snapshot (2026-09-30 · committed 813e3ec)

- **Finding 1 (claim provenance)**: `update_claim_state` merge ไม่ล้าง slot → `{stage:"resolved", customer_name:...}` เกิดได้จริง และ `_claim_collecting` เช็ก slot ไม่เช็ก stage → resolved+retained-slots **ยัง collect** — report เดิมเขียน "resolved ไม่นับ" กว้างเกิน · fix: rename tests → `resolved_without_slots`, เพิ่ม parity-pin test `test_resolved_with_retained_slots_collects__parity_pin` บันทึก semantics จริงเป็น Phase 2 blocker (ห้ามแก้ `_claim_collecting` ใน phase นี้เพราะเปลี่ยน runtime)
- **Finding 2 (snapshot)**: callsite เดิมเรียก load_claim_state + get_active_product (materialize card = product-DB read + live-cache write) + exceptions ทุก ticket → แก้เป็น `load_timeline` ครั้งเดียว (claim_state + active_item_id จาก doc เดียว, anchor = `{item_id}` เท่านั้น) + exceptions เฉพาะ ticket active — shadow reads: **timeline reads 2→1 · product materialization 1+→0 · shop-settings ทุก turn→เฉพาะ active ticket**
- **Finding 3 (forwarding tests)**: +6 direct shadow-boundary tests (timeline once / ไม่เรียก load_claim_state+get_active_product / inactive skip exceptions / active forwards / loader fail ไม่ raise / trace PII-free) — RED 2 จุด (แยก claim read, query exceptions ตอน inactive) → GREEN
- verify: 97p turn_decision+shadow · 46/19/8 replay+iso · validator 40 rows · py_compile · forbidden=0 · **runtime answer ไม่เปลี่ยน**

### 📋 Phase 1G — coverage + readiness re-audit (2026-09-30 · committed 40b66e7 · test/audit only)

- **Baseline ก่อนแก้**: 52 turns — claim_collect=0, locked=2, noise=1 · hypothesis ยืนยัน: gap มาจาก harness ไม่ seed state ไม่ใช่ contract ขาด input
- **Harness**: เพิ่ม `shop_settings_seed` (ขั้นต่ำ — admindb fake) + validator key · timeline/claim/ticket seed มีอยู่แล้ว
- **+12 fixtures**: lock-escape×5 (shop-exception/phone/product-q/product+warranty/plain), claim-collect-seeded (2 turns), claim-resolved±slots, anchor stock/link followup, no-anchor negative, noise→product seq — ผ่าน `app.chat()` + shadow boundary จริง ไม่ใช่ direct decide_turn
- **ผล sweep 66 turns**: claim_collect 0→3 · locked 2→4 · noise 1→2 · followup 10→12 · ยืนยัน resolved+retained-slots → collect (parity pin)
- **Pin test แก้ให้ forward fixture seeds** (claim_state/anchor/exceptions) เข้า `_decide` + `_KNOWN_DIVERGENT_IDS` 5 รายการพร้อมเหตุ (exception→claim_request vs legacy handoff, empty-catalog guard artifact, claim-info→unknown vs admin handoff)
- **Readiness verdict**: ทุก family `blocked_by_phase2` หรือ `needs_more_evidence` — **wire nothing yet**
- verify: 97p turn_decision+shadow · 58/19/8 replay+iso · validator 52 rows · forbidden=0 · **runtime ไม่เปลี่ยน**

#### Phase 1G review-fix — evidence honesty (2026-09-30 · committed 40b66e7 · test/audit only)

- **False-green 1 — divergence allowlist**: `_KNOWN_DIVERGENT_IDS` ลบแล้ว — แทนด้วย `turn_decision_expect` (per-user-turn exact action + `flags_contains`) ที่ sweep และ contract test assert จริง 12 rows
- **False-green 2 — vacuous claim**: `claim-collect-seeded`/`claim-resolved-retained` เดิม assert `claim_state_exists` (seed สร้างอยู่แล้ว) → เปลี่ยน `final_claim_state` ตาม post-state จริง: collect-seeded persist แค่ `customer_phone` (name turn ไม่เขียน), resolved-retained assert retained name เท่านั้น (legacy ไม่ persist phone — no-product-guard handoff)
- **False-green 3 — empty-catalog artifact**: `lock-escape-product-question`/`no-anchor-stock-unknown`/`noise-then-product` เดิม pin legacy handoff (no-product guard) เป็น positive → เปลี่ยนเป็น contract-only (`expectation_note` + `turn_decision_expect` เป็น acceptance owner)
- **Validator hardening**: `turn_decision_expect` schema (count=user turns, action enum, flags list[str], unknown nested key reject) + `shop_settings_seed` nested schema + vacuous `claim_state_exists` guard — meta-tests RED→GREEN
- **Doc wording**: hypothesis แก้เป็น "absent stateful fixtures + missing shop_settings_seed boundary" (ไม่ใช่ input gap) · noise verdict → needs_more_evidence (ไม่ใช่ phase2 blocker) · locked parity → "lock-vs-escape matches gate; downstream ต่างใน documented rows"
- verify: 97p turn_decision+shadow · 61/19/8 replay+iso · validator 52 rows · runtime/Admin diff=0 · **runtime ไม่เปลี่ยน**

##### Phase 1G review-fix#2 — final evidence integrity (committed 40b66e7 · test/audit only)

- **claim-resolved-retained-slots → contract-only จริง**: ลบ `expected` block (final_claim_state assert เฉพาะ retained seed field = vacuous) — acceptance = `turn_decision_expect` claim_collect+claim_resume; note ระบุ executor divergence = Phase 2 blocker
- **Validator เพิ่ม 2 guards**: (1) `final_claim_state` ที่ทุก key/value ⊆ claim_state_seed → reject vacuous; (2) `turn_decision_expect[].action` non-string (list/dict/int) → reject ไม่ crash (TypeError fix)
- **Contract test ordering**: `_fixture_contract_check` extract + explicit expectation ถูก assert ก่อน generic noise skip — proven ด้วย mutation test (flip noise→locked in-memory ต้อง mismatch)
- verify: 98p turn_decision+shadow (+1 mutation test) · 63/19/8 replay+iso (+2 validator meta-tests; contract-only conversion เปลี่ยน acceptance semantics ไม่ใช่จำนวน test case) · validator 52 rows · sweep 66 turns action counts คงเดิม · runtime/Admin diff=0

### 📋 Phase 2A — claim lifecycle audit + RED contract baseline (ยังไม่ commit · test/audit only)

- **Hypothesis ยืนยัน**: ไม่มี lifecycle owner เดียว — `_claim_collecting` (wf:69) ใช้ retained slots เป็น active marker แม้ `stage=resolved`; `update_claim_state` merge stage โดยไม่ล้าง slots; stage writes กระจาย ≥10 callsites ใน 2 SM impls ขนานกัน (`handle_warranty_flow` v2 / `_legacy` app.py); direct `_cp_ts*` calls bypass wrapper (wf:1151,2006)
- **Schema inventory + callsite map + transition truth table** (17 rows) → plan ตอน Phase 2A
- **New findings**: (1) `has_video` เป็น dead field (ไม่เคยถูก write); (2) closed-ticket clear (wf:1361) อยู่ใน `if history` guard → no-history ปล่อย stale claim_state ทิ้งไว้; (3) name persistence gap — NER path ไม่ persist lone-name turn (incident pin)
- **test_phase2_claim_state_contract.py** (ใหม่, offline): 9 parity pins pass + 3 strict xfail (resolved+retained → desired not-collecting; terminal precedence; slots-not-activation) — delete condition = Phase 2B owner lands
- **+5 fixtures** (rows 53-57): collect name→phone (incident/xfail — name gap), product-q resume, ticket-closed clears (model-turn history เพื่อเข้าถึง SM path), ts_suggested success→resolved, ts_suggested failed→collecting+handoff — ทุกอันมี turn_decision_expect
- **Harness**: `claim_state_exists` เป็น bidirectional consumer (false = assert cleared); `_fixture_contract_check` ใช้ first **user** turn (model turns = history seed)
- **YAGNI**: ไม่เพิ่ม per-turn claim schema (final_claim_state + tde พอ); ไม่สร้าง public wrapper
- verify: 9p+3x contract · 98p td+shadow · 67/19/9 replay+iso · validator 57 rows · sweep 73 turns missing=0 · runtime/Admin diff=0 · **wire nothing yet ยังคงเดิม**

#### Phase 2A review-fix — honest RED pins + replacement plan (ยังไม่ commit)

- **No-history gap เป็น executable**: `p2a-claim-ticket-closed-no-history-stale` (row 58) — ticket closed + collecting + history ว่าง → stale claim_state ไม่ถูก clear → incident/strict-xfail ผ่าน gate เดิม; deletion condition = Phase 2B Commit 4 ย้าย terminal reset ก่อน `if history`
- **xfail consolidation**: 3 ฟังก์ชัน desired-terminal → parametrized เดียว `test_desired_terminal_stage_beats_retained_slots` (3 cases: name / phone / 3-slot) — coverage เดิม net LOC ลด
- **Owner map แก้**: TurnDecision ไม่ใช่ duplicate — มัน delegate ไป `_claim_collecting` ตัวเดียว → shared predicate ผิด = bug กระจายทั้ง executor + shadow; Phase 2B ต้อง replace owner ไม่ใช่เพิ่มชั้น
- **Line refs → stable names** ทั้ง Phase 2A section (function/branch names ไม่ใช่ wf:NNNN)
- **Terminology แยกสองแกน**: `lifecycle_open` vs `accepts_claim_fields` (ts_suggested = open แต่ไม่รับ fields; resolved = terminal; slots = audit data ไม่กระทบแกน; ticket closed override ทั้งคู่)
- **Phase 2B rewrite เป็น replacement commits** (6 commits — migrate+delete ใน commit เดียว, ไม่มี long-lived shim) + **pre-implementation blocker: engine scope** (A: shared legacy+v2 / B: legacy-only — ต้อง user approval) + **complexity gates** (owner count ต้องลด, keyword tables/flags/shims = 0, net LOC ≤0 refactor commits ไม่งั้น INCREASES_COMPLEXITY_BLOCKED)
- verify (fresh): 9p+3x contract (3 xfail funcs → 1 parametrized ×3 cases, count เดิม) · 98p td+shadow · 67/19/10 replay+iso (57→58 fixtures, +1 strict xfail no-history) · validator 58 rows · sweep 74 turns missing=0 · runtime/Admin diff=0 · **wire nothing yet**

#### Phase 2A correction — ticket ownership ≠ claim lifecycle (ยังไม่ commit)

- **Root cause ของ correction**: Phase 2A เดิมถือว่า ticket closed = claim จบ → pin "clear claim_state" เป็นตัวอย่างถูก — ผิด business rule: ticket_state คือ conversation ownership (status_conversation), claim resolution ต้องเป็น explicit event
- **Audit finding (BLOCKER)**: ไม่มี claim-resolution event/field ในระบบ — `ConversationStatus` (open/closed/bot/handoff/resolved/pending) = ownership เท่านั้น; ticketService.status เป็น ticket-level เหมือนกัน; claim terminal signals มีแค่ bot-side: `_TERMINAL_CLAIM_REASONS` + ts-success `stage=resolved` → `BLOCKED_BY_MISSING_CLAIM_RESOLUTION_EVENT`
- **Fixture corrections**: `p2a-claim-ticket-closed-clears`→`keeps-state` (desired=claim survive → incident: current clears wrongly) · `no-history-stale`→positive (survives accidentally, pin semantics) · +3 rows: closed+product-q (incident: clears+answers), closed+phone-resume (incident: clear→re-collect แต่ retained name หาย), resolved+new-claim-request (contract-only)
- **Validator relax**: `claim_state_exists:true`+seed+`ticket_state` = survival assertion ไม่ vacuous (executor มี clear path จริง)
- **Plan**: truth table rows 14-15b rewrite · ticket=third axis (ownership) · Commit 4 = delete wrongful clear (ไม่ใช่ move) · +multi-intent blocker (TurnDecision ต้องรองรับ needs[] ก่อน wire; ห้าม turn_policy.py ซ้ำ)
- verify (fresh): contract+td+shadow 107p+3x · replay+iso 68/19/12 · validator 61 rows · sweep 77 turns missing=0 · runtime/Admin diff=0 · **wire nothing yet**

#### Phase 2A review-fix round 2 — lifecycle vs ownership separation hardened (ยังไม่ commit)

- **error**: review ชี้ plan ขัดกันเอง (top บอก closed ไม่ล้าง claim แต่ allowed transitions ยังมี `collecting→resolved (terminal handoff)` + `any→absent (closed ticket/clear)`) + fixture `resolved-new-request` pin bug เป็น positive + validator vacuous-guard bypass ด้วย ticket_state ใดๆ + owner `claim_or_ticket_state` รวมสองแกนที่เพิ่งแยก + Option A/B ค้าง
- **cause**: correction รอบแรกแก้ truth table แต่ลืม contract-proposal transition list + validator bypass กว้างเกิน path ที่ execute ได้จริง
- **fix**:
  - transitions ใหม่: absent→collecting (explicit request) · absent→ts_suggested · ts_suggested→resolved (resolution ของ troubleshooting episode ไม่ใช่ admin case) · ts_suggested→collecting · resolved→collecting (explicit new request เท่านั้น) · `collecting→terminal` BLOCKED จนมี explicit resolved/cancelled event · `any→absent` BLOCKED จนมี reset/cancel event · ticket close ไม่ใช่ lifecycle transition
  - `_TERMINAL_CLAIM_REASONS` ระบุชัด = bot-side cleanup heuristics ไม่ใช่ authoritative resolution; Phase 2B ต้อง audit/delete/replace ห้าม migrate แบบถือว่าถูก
  - `Three independent axes`: conversation_ownership / claim_lifecycle / claim_field_acceptance
  - ลบ `p2a-claim-ticket-closed-no-history-stale` (exists-only บน no-history path = assertion ไม่พิสูจน์ root cause; with-history 3 rows ครอบ wrongful clear แล้ว)
  - `resolved-new-request` → incident+strict xfail: expected handoff/claim + stage=collecting, tde=`claim_request` (current: claim_collect+claim_resume ไม่ handoff — retained slots ชนะ detect_claim_request)
  - validator: OWNERS เพิ่ม `conversation_ownership`/`claim_lifecycle`/`claim_field_acceptance`, ลบ `claim_or_ticket_state` (+reject ใน secondary_owners) · vacuous-exists guard แคบเป็น `ticket_state=="closed" AND มี model/history_extra turn` เท่านั้น
  - meta-tests TDD: RED (2 fail) → validator fix → GREEN (8 pass)
  - migrate 14 fixtures: lock-escape×2→conversation_ownership, claim rows→claim_lifecycle (+secondary_owners 1 รายการ)
  - plan: ลบ Option A/B → scope locked = Legacy runtime only, v2/v3 frozen, shared-helper change ที่กระทบ v2 ต้องหยุดออกแบบ boundary ก่อน
  - sweep/contract test: incident+tde divergence เป็น expected (resolved-new-request contract=claim_request vs current=claim_collect) — strictness อยู่ที่ replay `_gate` (unexpected pass = fail)
- **impact on other cases**: ไม่มี — meta-tests เก่า 6 ตัวยังผ่าน, incident xefail count +1 (resolved-new-request), fixture count 61→60, sweep turns 77→76
- verify (fresh): contract+td+shadow 107p+3x · replay+iso 67/19/13 · validator 60 rows · sweep 76 turns missing=0 · runtime/Admin diff=0 · **wire nothing yet**

#### Phase 2A review-fix round 3 — false-green hardening (ยังไม่ commit)

- **error**: (1) `final_claim_state` ถูก assert เฉพาะ action=claim_collect → handoff+fcs ผ่านเงียบ; (2) `expected_mismatch_ids` เป็น dead variable — incident tde mismatch ถูกกรองทิ้งโดยไม่ assert อะไร; (3) fresh-claim fixture ไม่ระบุ slot policy; (4) plan สั่งสร้าง `turn_policy.py` ขัดกับ blocker ที่ห้าม owner ซ้ำ; (5) `claim_field_acceptance` เป็น taxonomy ไม่มีผู้ใช้
- **cause**: tde strictness รอบ 2 ออกแบบเป็น "incident = tolerate" ทั้งแถว → divergence กลายเป็น silent; fcs ผูกกับ action branch โดยไม่ได้ตั้งใจ
- **fix**:
  - `tde_entry_error()` (validator-owned, shared โดย contract test + sweep): entry ไม่มี `current` = current-pin ต้อง match รวม flags (incident ไม่ยกเว้น); entry มี `current` (incident-only) = actual ต้อง == current และต่างจาก desired — match desired = stale pin fail, ต่างทั้งคู่ = drift fail
  - `final_claim_state` ย้ายเป็น independent post-state assertion ตรวจทุก action; `None` value = assert key absent; claim_collect branch เหลือ assert claim state มีจริง
  - `resolved-new-request`: seed เพิ่ม order_id/purchase_date/has_image; expected assert case fields absent (None) + handoff claim; tde `{"action":"claim_request","current":"claim_collect"}`; slot policy = identity allowlist (name/phone reuse OK, case evidence ห้าม carry); blocker `BLOCKED_BY_CLAIM_EPISODE_IDENTITY` (flat claim_state ไม่มี episode boundary)
  - validator: tde `current` key rules (incident-only, enum, ≠action) + secondary_owners taxonomy check
  - plan: owner map/Phase 1 Files → evolve `turn_decision.py` ไม่สร้าง turn_policy; "monotonic except reset/close" ลบ; `_claim_collecting` reader cell แก้เป็น "collecting OR retained slots"
  - `claim_field_acceptance` มีผู้ใช้: secondary_owners บน name-phone + phone-resume fixtures
- **RED evidence**: meta-tests 3 ตัว fail ก่อนแก้ (fcs-skipped-under-handoff, `current` rejected, tde_entry_error missing) → GREEN 15/15 meta
- **impact**: executor-side incident rows (name-phone, ticket-closed×3) tde เป็น current-pins — flags ถูกตรวจด้วยแล้ว; replay xfail ยัง 13 (resolved-new-request fail ด้วย handoff + case-field retention)
- verify (fresh): contract+td+shadow 107p+3x · replay+iso 71/19/13 · validator 60 rows · sweep 76 turns missing=0 · runtime/Admin diff=0 · **wire nothing yet**

#### Botworker recovery cancellation contract — AbortController owner เดียว (ยังไม่ commit)

- **error**: `recoveryEpoch` เป็น cancellation owner แต่ไม่ถูกส่งเข้า buffered recovery เลย และตรวจเฉพาะหัว direct-claim loop/ระหว่าง phase — abort ระหว่าง await chain ยัง claim+processMessage ได้ (R44), abort ระหว่าง buffered classify ยังไหลเข้า flushBuffer เพราะ config gate ไม่รู้ recovery lifecycle (R45), abort หลัง lock+re-fence ยัง launch LLM (R46)
- **cause**: epoch = ตัวเลขเปรียบเทียบ manual — boundary ใหม่ใน chain ไม่ได้ epoch โดยอัตโนมัติ; `flushBuffer` gate เดิมดู `bot_worker_enabled` จาก config เท่านั้น (shutdown ไม่ใช่ toggle-off)
- **fix**: ลบ `recoveryEpoch` ทั้งหมด → `recoveryAbort: AbortController | null` ตัวเดียวต่อ active pass; `clearPendingWork` = `abort()`+`recoveryAgain=false` (drop rerun ของ cancelled era)+clear timers เดิม; signal เดียวส่งผ่าน classifier→recoverStaleBuffers→flushBuffer→recoverStaleClaims→claimMessage; checkpoint เฉพาะ side-effect boundary (claim/reclaim, batch transition, processMessage launch, retry/defer/audit scheduling); `flushBuffer` abort กลางทาง → revert member rows→buffered + `skip` เงียบ (ไม่เข้า generic catch, ไม่ terminalize, lock ปล่อยใน finally); `AbortSignal` optional param เฉพาะ boundary ที่มี normal+recovery caller — normal callers ไม่ส่ง = behavior เดิม
- **RED evidence**: R44 callBot=1 (abort หลัง loop-top ก่อน claim) · R45 callBot=1 (abort ระหว่าง classify → flush ทำงานเพราะ config ยัง true) · R46 callBot=1 (abort กลาง re-fence → processMessage ยังรัน) → post-fix 48/48 (R44–R47 green; R47 normal signal-less path ไม่เปลี่ยน)
- **impact**: recoveryEpoch refs=0 · cancellation owners=1 · new helper/flag/module=0 · runtime LOC ≈ +43 (boundary checks + signal params — botWorkerService ≈+15, bufferService ≈+28)
- verify (fresh): freshness 48/48 · enable-checkpoint 18/18 · idempotency 43/43 · boundary 20/20 · production-races 37/37 · tsc clean · build ✓ · diff --check ✓ · DB writes=0, LLM/API=0, no commit/push/deploy

#### Botworker cancellation final review-fix — R48–R50 (ยังไม่ commit)

- **error**: 3 leak ใน AbortController contract — (1) `scheduleFlushRetry` timer callback เรียก `flushBuffer` โดยไม่ส่ง signal (fire ก่อน abort + ค้างใน read → LLM หลัง shutdown); (2) aborted pass ใช้ `continue` → caller ที่ join หลัง abort ตั้ง `recoveryAgain` → iteration+controller ใหม่ฟื้น cancelled era; (3) `claimMessage` ตรวจ signal ก่อน `findOne` เท่านั้น → abort กลาง read ยัง reclaim ($inc attempt/fencing)/attempt-cap/insert ได้
- **fix (minimal)**: (1) callback ส่ง `signal` เดิมเข้า `flushBuffer`; (2) aborted → `break` ทั้ง run + เช็ค `signal.aborted` ก่อนประเมิน `recoveryAgain` + เก็บ controller ล่าสุดไว้ (ไม่ null ใน finally) เพื่อให้ post-run `clearPendingWork` abort ถึง retry callback ที่ค้างอยู่; (3) `claimMessage` เช็คหลัง ownership read (ก่อน attempt-cap/reclaim) + หลัง legacy lookup (ก่อน insert) — finalize-only ที่เริ่มแล้วปล่อยจบตาม spec
- **RED evidence**: R48 callBot=1 (retry flush รอด abort) · R49 callBot=1 (era ฟื้น) · R50 owner=test-worker f=2 attempt=2 (reclaim หลัง abort) → post-fix 51/51
- **impact**: cancellation owners=1 (AbortController) · recoveryEpoch=0 · helpers/flags/modules=0 · runtime LOC ≈ +14 · normal signal-less path ไม่เปลี่ยน
- verify (fresh): freshness 51/51 · enable-checkpoint 18/18 · idempotency 43/43 · boundary 20/20 · production-races 37/37 · tsc clean · build ✓ · diff --check ✓ · DB writes=0, LLM/API=0, no commit/push/deploy

#### Botworker cancellation owner lifetime — R51 era-scoped controller (ยังไม่ commit)

- **error**: AbortController สร้างใหม่ทุก recovery pass — retry callback จาก pass A ถือ signal A แต่ pass B เปลี่ยน `recoveryAbort` เป็น B → `clearPendingWork` abort เฉพาะ B → retry A รอด → flush/LLM หลัง shutdown (owner อายุสั้นกว่า child work ที่มันสร้าง)
- **fix (architectural, จุดเดียว)**: `recoverStaleBuffersAndClaims` สร้าง controller เฉพาะเมื่อ `recoveryAbort` เป็น null หรือ `.signal.aborted` — reuse controller เดียวกันข้ามทุก pass/rerun ใน enabled era เดียวกัน; `clearPendingWork` เป็นจุดเดียวที่จบ era; post-abort joiner ยังถูก break ดรอป; explicit recovery หลัง drain เห็น aborted แล้วสร้าง era ใหม่เอง
- **RED evidence**: R51 `callBot=1` (retry จาก pass A รอด abort เพราะ recoveryAbort ชี้ controller B) → post-fix 52/52
- **impact**: cancellation owners=1 · controller creation sites=1 (L1715) · signal identity ตัวเดียวทั้ง era · recoveryEpoch=0 · new state/helper/flag/module=0 · runtime LOC ≈ +3 net
- verify (fresh): freshness 52/52 · enable-checkpoint 18/18 · idempotency 43/43 · boundary 20/20 · production-races 37/37 · tsc clean · build ✓ · diff --check ✓ · DB writes=0, LLM/API=0, no commit/push/deploy

#### Botworker normal-flush shutdown lifecycle closure — N1–N5 + era-wide signal (ยังไม่ commit)

- **error (RED, proven)**: normal debounce/retry timer callback ไม่มี AbortSignal และ promise ไม่อยู่ใน shutdown drain — N1 debounce callback fired+stalled ก่อน clearPendingWork ยัง callBot=1; N2 retry callback เช่นกัน callBot=1; N3 `waitForInFlight` return ก่อน timer-launched flush จบ (botInFlight=1 อยู่); N4 in-flight flush fail หลัง shutdown ยัง arm retry timer ใหม่ (postAbortFinds=2); (harness gap ที่เจอระหว่างดีบัก: `test()` finally ไม่ drain inFlight → p chain เลื้อยข้าม resetState → `ctxFromDoc(null)`)
- **cause**: `flushBuffer` มี abort gates อยู่แล้ว (post-read, pre-processMessage, scheduleFlushRetry) แต่ normal path (poll→bufferOrProcess→debounce/immediate) ไม่เคยส่ง signal; timer callbacks drop promise ไม่เข้า `inFlight`; `scheduleFlushRetry`/`clearAllBufferTimers` เคลียร์ได้เฉพาะ timer ที่ยังไม่ fire
- **fix (owner เดิมขยายขอบเขต)**: `recoveryAbort` → `eraAbort` + `eraSignal()` เป็น creation site เดียว (reuse ทั้ง era, สร้างใหม่เมื่อ aborted) — poll ส่ง era signal เข้า `bufferOrProcess` → debounce callback + `scheduleFlushRetry` + `flushBuffer`; `activeFlushes` Set + `trackedFlush` helper เฉพาะ 2 timer-callback sites (ไม่มี parent promise) — `waitForInFlight` drain `inFlight + recoveryInFlight + activeFlushes`; `clearPendingWork` abort era เดียวจบทุก child; test-harness finally drain `waitForInFlight` กันข้าม-test bleed; N4 ใช้ fencing bump (partial-finalize path) แทน deleteOne hook ที่ไม่มี
- **R40 fix (test-timing, ไม่ใช่ production)**: settle ที่ drain activeFlushes ทำ debounce flush fire ภายใน settle — claim `owner_id` อย่างเดียวไม่พอ เพราะ lease +400ms หมดก่อน timer starved (~485ms late) → refence reclaim ผ่าน `lease_expires_at < now` — แก้ด้วย foreign+ACTIVE lease (`+30000`) ตอน mutate แล้ว lapse เป็น `now-1` ตอน re-enable = foreign lease หมดใน disabled window — deterministic ไม่ผูก wall-clock
- **RED evidence**: N1 `callBot=1` · N2 `callBot=1` · N3 `waitForInFlight returned while flush active` · N4 `postAbortFinds=2` · N5 pass ตั้งแต่แรก → post-fix **57/57** (N1–N5 + R40 + R1–R51 คงเดิม)
- **impact**: cancellation owners=1 (eraAbort เดิมขยายขอบเขต) · controllers ใหม่=0 · flags/config/schema/modules=0 · helper ใหม่ 1 (`trackedFlush` — ปิด gap "timer callback ไม่มี parent promise") · timer callback sites=2 (debounce, retry) ทั้งคู่ถือ era signal+tracked · normal signal-less `flushBuffer` API ไม่เปลี่ยน (T1 production-code canary ผ่าน) · runtime LOC น้อย (test file +N1–N5 ≈ +260)
- verify (fresh): freshness 57/57 · enable-checkpoint 18/18 · idempotency 43/43 · boundary 20/20 · production-races 37/37 · tsc clean · build ✓ · diff --check ✓ · DB writes=0, LLM/API=0, no commit/push/deploy

#### Botworker poll lifecycle closure — parent poll era gap (N6/N7) (ยังไม่ commit)

- **error (RED, proven)**: `pollNewMessages` เรียก `eraSignal()` *หลัง* await 4 จุด (`getCollection` messages, inbound `find().toArray()`, terminal-claim lookup, `getSystemConfig`) → shutdown คั่นกลาง → query จบหลัง abort → `eraSignal()` เห็น controller เดิม aborted → **สร้าง era ใหม่** → claim/buffer/LLM หลัง shutdown และ `clearAllBufferTimers` ไปแล้ว (timer orphans); parent poll promise ไม่อยู่ใน drain set เลย → `waitForInFlight` คืนก่อน poll จบ
- **RED evidence**: N6 `waitForInFlight returned while parent poll still mid-query` + log `[worker] n6... → skip: era aborted` พิสูจน์ era ใหม่ถูกสร้าง post-shutdown จริง (abort ที่ 2 จาก test-finally ฆ่ามัน); N7 explicit next era pass เป็น control
- **fix (owner เดิม, ไม่เพิ่ม controller)**: `pollNewMessages` → thin wrapper — `const signal = eraSignal()` sync ก่อน await แรก + `activePolls` Set register parent promise + `.then(del, del)` cleanup ทั้ง resolve/reject → delegate `pollNewMessagesInEra(since, signal)` = body เดิมไม่ duplicate; single cancellation boundary `if (signal.aborted)` หลัง read-only discovery ก่อน claim loop → คืน `{found, processed:0, results: skip}`; signal ส่งเข้า `claimMessage`+`bufferOrProcess`; `waitForInFlight` += `activePolls` (drain parent poll ค้าง Mongo)
- **test harness**: fakemongo +`findHook` seam (mirror `findOneHook`, run ต่อ query op ก่อน execute) — deterministic latch บน inbound find; `resetState` += `findHook=null`; N6 restructure capture-verdict→release→assert (latch release เสมอแม้ assert แตก)
- **post-fix**: **59/59** (N6 GREEN — drain รอ parent จนปล่อย query, post-release ไม่มี claim/buffer/reply/callBot/timer; N7 GREEN — era ใหม่ประมวลผล once)
- **impact**: cancellation owners=1 (`eraAbort`) · controller ใหม่=0 · registry ใหม่ 1 (`activePolls` — parent poll ไม่มี tracker เดิม) · helper ใหม่ 1 (`pollNewMessagesInEra` — body move) · flags/config/schema/index/dep=0 · fire-and-forget children/debounce/immediate-flush/explicit-era semantics ไม่เปลี่ยน
- verify (fresh): freshness 59/59 · enable-checkpoint 18/18 · idempotency 43/43 · boundary 20/20 · production-races 37/37 · tsc clean · build ✓ · diff --check ✓ · DB writes=0, LLM/API=0, no commit/push/deploy

#### [กำลังจะทำ] Botworker closeout gate — real-Mongo verification + commit prep (no implementation)

- **เป้าหมาย**: พิสูจน์ชุด botworker ปัจจุบันก่อน commit — git inventory/scope audit, fresh offline verification (5 suites+tsc+build), read-only Mongo audit (sanitized), audit synthetic script (`__verify_bw_`) แล้วหยุดขออนุญาตก่อนรัน, complexity closeout, staging manifest A/B — **ห้าม stage/commit/push/deploy**
- **constraints**: no new helper/guard/lifecycle · ห้ามเปิด worker/LLM/Shopee API · ห้ามแตะ env/secrets/raw customer data (hash IDs เท่านั้น) · Product DB read-only · Mongo write เฉพาะ synthetic prefix หลังอนุญาต · failure → หยุดวิเคราะห์ ห้าม patch

#### Closeout evidence correction — audit script truthfulness (ยังไม่ commit)

- **error (reviewer, proven)**: (1) audit terminal query ใช้ list เก่า `[processed,bot_failed,handoff,skipped,answered]` — contract จริง `{trigger_matched,bot_answered,handed_off,bot_failed,no_action,workflow_actioned,workflow_resumed}` → terminal claims มองไม่เห็น; (2) reply query เฉพาะ scalar `inbound_message_id` — runtime เขียน `inbound_message_ids` array (batch) + scalar `mid__wf<N>` (workflow) → batch/wf reply นับเป็นศูนย์
- **fix (audit เท่านั้น, runtime untouched)**: `classify_claim_status` — contract มี non-terminal เดียวคือ "processing" → status!=processing&&non-empty=terminal, missing/empty="unknown" (legacy names ได้ฟรี, future status ไม่หลุด); `terminal_statuses_per_mid` ใช้ claims ที่ fetch อยู่แล้ว (ไม่เพิ่ม query); `build_reply_query` = `$or` scalar+array; `reply_references_mid` = scalar|mid+__wf prefix|array; output เพิ่ม `claims_unknown_status`, `terminal_claims_with_buffer_row`, `reply_evidence_summary` (unique mids/docs/batch — batch reply = doc เดียว ไม่นับซ้ำ)
- **RED evidence**: focused test `test_audit_botworker_incident.py` (mini FakeColl — $in/$or/$ne/$exists เท่าที่ audit ใช้) → RED 1 fail (ไม่มี classify_claim_status) + divergence probe พิสูจน์ list เก่าขาด 6 statuses → GREEN 34/34
- **real audit rerun**: ตัวเลขเดิมยืนยันแล้วด้วย query ที่ถูก — 4 claims ยัง processing จริง (ไม่ใช่ hidden terminal), 0 unknown status, 0 replies (scalar/array), 0 terminal-with-buffer — ไม่มี hidden contradiction
- **verify-botworker-parallel**: ไม่รัน — `commitPlan`→`listPending("botworker")` ไม่จำกัด prefix (real pending_assignment docs=10 จะถูก assign จริงนอก cleanup scope); script ทดสอบ assignment/history isolation ไม่ใช่ claim/lease/recovery → สถานะ `REAL_MONGO_RUNTIME_VERIFY_NOT_RUN`
- **impact**: runtime LOC/helpers/guards=0 · config/schema/index/collection=0 · audit script +56/-23, test file ใหม่ ~155 บรรทัด · Mongo write=0, LLM/API=0, worker off
- verify (fresh): freshness 59/59 · checkpoint 18/18 · idempotency 43/43 · boundary 20/20 · races 37/37 · rollback-verify 14/14 · audit-test 34/34 · py_compile 5 files · tsc clean · build ✓ · diff --check ✓ · INDEPENDENT_COMMIT_BUILD_NOT_YET_PROVEN (A/B verify รันบน working tree รวม)
- **review-fix (1 High + 2 Medium, ปิดแล้ว)**:
  - HIGH scalar-only wf reply หลุด query → `build_reply_query` เพิ่ม clause `^(mid|...)__wf\d+$` (re.escape ทุก mid) + `reply_references_mid` ใช้ `re.fullmatch(...__wf\d+)` ไม่ใช่ startswith (กัน `__wfx` หลอก) — RED fixture r4 (scalar suffix เท่านั้น) + rY (lookalike) พิสูจน์
  - MED import purity → `knowledge_base` lazy ใน `main()` — test assert `"shopeechat.knowledge_base" not in sys.modules` (import audit ไม่อ่าน .env อีก)
  - MED terminal เหมารวม → `classify_claim_status` 4 ทาง: `terminal`(KNOWN_TERMINAL_STATUSES=contract+legacy) / `processing`(KNOWN_NON_TERMINAL) / `unrecognized`(non-empty นอก contract — รายงานพร้อม status จริง) / `unknown`(missing) — pin ด้วย `some_new_status`→unrecognized + `KNOWN_TERMINAL_STATUSES ⊇ contract`
  - post-fix: audit-test **41/41** · real audit rerun ตัวเลขเดิม (4 processing claims, 0 replies, 0 flagged, 0 terminal+row) แต่ proven ด้วย query ถูกแล้ว · freshness 59/59 คงเดิม (TS untouched)

#### Closeout contract-drift fix — terminal pin reads TS owner (ยังไม่ commit · test-only)

- **error**: contract เขียนซ้ำ 3 ที่ (TS owner `CLAIM_TERMINAL_STATUSES`, audit `KNOWN_TERMINAL_STATUSES`, test `CLAIM_TERMINAL_CONTRACT`) — test เทียบ mirror↔mirror → owner drift ผ่านได้เหมือน stale-list เดิม
- **fix**: `extract_owner_terminal_statuses()` ใน test file อ่าน declaration จาก `botWorkerService.ts` จริง (bounded regex เฉพาะ `CLAIM_TERMINAL_STATUSES = new Set<...>([...])`, raise เมื่อหาย/ว่าง — verify แล้วทั้ง 2 case) → exact-equality `KNOWN_TERMINAL_STATUSES - LEGACY_TERMINAL_STATUSES == owner_statuses`; ลบ `CLAIM_TERMINAL_CONTRACT` mirror; legacy `{processed,handoff,skipped,answered}` ตรวจแยก
- **RED evidence**: mutation `| {"__contract_drift_probe__"}` → `FAIL ... extra={'__contract_drift_probe__'}` → คืนแล้ว
- **GREEN**: 41/41 — owner extracted = 7 statuses, missing=∅ extra=∅
- verify: py_compile ✓ · diff --check clean · audit file untouched (ไม่รัน real audit ซ้ำตามเงื่อนไข) · runtime/UI/API/schema=0

#### Botworker commit closeout — 0/A/B แยก + isolated worktree verify (committed)

- **commits**: `88efc77` test: correct botworker incident audit contracts (2 files) · `43d1ff1` fix: make botworker processing idempotent and recoverable (25 files) · `20cbca8` fix: isolate botworker history and sandbox replies (8 files)
- **error found by isolation**: `test-botworker-boundary.*` ถูกวางใน Commit A แต่ suite มี P2 (inbox-cache timestamp) + P3 (usePolling `immediate`) ที่ทดสอบ contract ของไฟล์ฝั่ง B → isolated A: tsc TS2353 + FAIL P2/P3
- **fix**: ย้าย boundary suite (3 ไฟล์) ไป Commit B — B depends on A อยู่แล้ว ไม่เสีย coverage; ไม่แก้โค้ดใดๆ
- **isolation method**: `git write-tree`+`commit-tree` → detached worktree = exact staged content; `node_modules` ต้อง `cp -Rc` clonefile (Turbopack ปฏิเสธ symlink ชี้ออกนอก project root); `.env` ถูกคัดลอกชั่วคราวเข้า isolated worktree และถูก build process โหลดใช้งานเพื่อให้ `ADMIN_JWT_SECRET` พร้อมสำหรับ build แต่ไม่มีการแสดงเนื้อหา ไม่มีไฟล์ `.env` ถูก commit และ temporary worktree/patch ถูกลบแล้ว
- **verify (isolated A)**: freshness 59/59 · checkpoint 18/18 · idempotency 43/43 · races 37/37 · tsc clean · build 84/84 ✓
- **verify (isolated B, base=A)**: tsc clean · boundary 20/20 (P2/P3 green เมื่อ B ครบ) · build 84/84 ✓ · diff --check ✓
- **verify (combined branch)**: audit 41/41 · freshness 59/59 · checkpoint 18/18 · idempotency 43/43 · boundary 20/20 · races 37/37 · tsc clean · build ✓ · py_compile ✓ · all diffs clean
- **leftovers**: `llm.py`, `test_vision_dedupe.py`, `quarantine_rollback.py`, `test_quarantine_rollback_verify.py` — excluded by spec, untouched
- **NOT RUN**: real-Mongo runtime verify (verify-parallel unsafe — listPending ไม่จำกัด prefix) · quarantine/rollback ยังไม่ execute · worker off · Mongo write=0 · LLM/API=0 · no push/deploy

#### [กำลังจะทำ] Botworker real-Mongo smoke harness — Part 1 safety gate (no execute)

- **เป้าหมาย**: harness `verify-botworker-runtime-mongo.ts` + safety test `test-botworker-runtime-mongo-safety.ts` — isolated temp DB (`<prod>_botworker_verify_<rand>`) + local fake `/chat` + marker-token cleanup + fail-closed CLI (default dry-run, `--apply` ต้อง token) — Part 1 ไม่รัน Mongo writes จริง
- **constraints**: production/runtime/UI/API=0 แก้ · worker off · no LLM/Shopee · no .env read/print · dynamic-import production services หลังตั้ง ADMIN_MONGO_DB/CHATBOT_BASE_URL_SHOPEE เท่านั้น · ไม่เรียก ensureIndexes (สร้างเฉพาะ minimal index ใน temp DB) · ห้าม commit/push
- **ผล Part 1 (verify แล้ว, ยังไม่ commit)**: safety test **39/39** (RED ก่อน implement: `harness file exists` fail → GREEN) · dry-run prints sanitized plan exit=0 · `--apply` no-token/wrong-token → exit=1 **ก่อน** load env/Mongo · tsc clean · diff --check clean · harness 469 LOC (<500 gate) · guards=4 (apply token / db-name pattern+≠prod / cleanup marker+token / output sanitizer) · production LOC/helpers/schema/index=0 · scenarios S1–S6 implemented แต่ execute เฉพาะ --apply (Part 2 หลังอนุมัติ) · Mongo writes=0 · network binds=0 · runtime imports=0 · `verify-botworker-parallel` ไม่ถูกอ้างอิง
- **residual**: scenario assertions ยังไม่ proven กับ Mongo จริง (ตัวเลข claim/reply/row ต้องยืนยันใน Part 2) · fake `/chat` รับ body เท่านั้น (ไม่เก็บ headers) · isolated name = `<prod>_botworker_verify_<rand16>` — prod prefix เป็นส่วนหนึ่งของ pattern โดยตั้งใจ (ต่างจาก prod name ตรงๆ)
- **review fix (exit-code overwrite, verify แล้ว)**: `finally` เคยเขียน `process.exitCode=1` เมื่อ cleanup ล้ม แต่ `runApply` return 0 → `.then` เขียนทับเป็น 0 → temp DB ค้างแต่รายงาน success — **fix**: pure `smokeExitCode(failedAssertions, cleanupFailed)` + `runApply` ไม่มี return ใน try / ไม่แตะ `process.exitCode` (pin: count=2 เฉพาะ then+catch) · fake.close() fail → cleanupFailed แล้วทำ DB cleanup ต่อ · scenario throw → propagate ผ่าน finally → outer catch → exit 1 · 4-case control flow: pass/pass→0 · fail/pass→1 · pass/fail→1 · throw→1 · safety test 39→**47/47** (RED ก่อน fix: 7 fails ตรง finding) · tsc clean · --apply ยัง refuse ก่อน env load · Mongo writes=0

#### [กำลังจะทำ] Botworker real-Mongo smoke Part 1.1/2 — Mongo client closure + one-shot apply

- **root cause**: `mongoClient.getDb()` singleton MongoClient ไม่ถูกปิดใน runApply → socket/timer ค้าง process อาจไม่จบแม้ dropDatabase สำเร็จ — แก้ด้วย `db.client.close()` ใน nested finally (driver API ตรง ห้ามสร้าง production closeMongo helper)
- **plan**: RED source-contract tests (client.close ใน finally / dropDatabase return check / close-fail→cleanupFailed / exitCode ยังเฉพาะ boundary) → minimal fix → GREEN → Part 2 one-shot --apply
- **Part 1.1 (verify แล้ว)**: `db.client.close()` ใน nested finally + `dropDatabase()` return ต้อง true — RED 5 fails (no close / unchecked return) → GREEN **52/52** · tsc clean · dry-run ok
- **Part 2 (รัน --apply ครั้งเดียว)**: exit=1 — **seed insert แรกถูก Mongo auth ปฏิเสธ** (`not authorized on <prod>_botworker_verify_<rand>` — user ไม่มีสิทธิ์เขียน DB อื่นนอก configured) → S1–S6 ไม่ได้ execute · writes=0 · cleanup refuse ถูกต้อง (no marker→no drop) · client close ทำงาน process จบปกติ · read-only `listDatabases` ยืนยัน `*_botworker_verify_*` = **0 DBs** — temp DB ไม่เคยถูกสร้างจริง (Mongo สร้าง lazily เมื่อ write แรกซึ่งถูก reject)
- **finding ใหม่**: driver error message แสดง temp DB name เต็มใน console — sanitized guard ครอบเฉพาะ string ของเราเอง ไม่ครอบ error จาก Mongo (ต้อง sanitize e.message ใน Part 3 ถ้าจะใช้ต่อ)
- **residual**: ต้องการ Mongo user ที่มีสิทธิ์ create/write/drop บน `*_botworker_verify_*` หรือ role `dbAdminAnyDatabase`/`readWriteAnyDatabase` — หรือเปลี่ยน approach เป็น separate verify user/URI (ต้องตัดสินใจนอก scope)
- verdict งานนี้: REAL_MONGO_SMOKE_FAILED (auth boundary, ไม่ใช่ runtime bug) · Mongo writes=0 · LLM/API=0 · worker off

---
## งาน: Botworker real-Mongo smoke Part 3 — loopback-only disposable Mongo + error sanitization
**สถานะ:** ✅ harness rewrite เสร็จ + verify ผ่าน — ❌ disposable Mongo ไม่มีในเครื่อง → apply ไม่ได้รัน

### Baseline / RED / GREEN
- Baseline ก่อนแก้: safety 52/52, tsc clean, dry-run 0
- RED (new contract): 25 fails — verify URI validator, harness-constant DB name, sanitizer, source pins ทั้งหมด absent
- GREEN: safety **73/73**, `npx tsc --noEmit` clean, dry-run exit 0, `git diff --check` clean

### วิธีแก้ (harness only — production/runtime = 0)
- `BOTWORKER_VERIFY_MONGO_URI` required ใน apply — `validateLoopbackMongoUri()` รับเฉพาะ `mongodb://` + host ∈ {127.0.0.1, localhost, [::1]} + explicit port ≠ 27017 + ไม่มี credentials/query — reject srv, non-loopback, malformed
- `ADMIN_MONGO_URI` + `ADMIN_MONGO_DB` set จากค่า verified ก่อน dynamic import — DB name = `botworker_runtime_verify_<rand>` (harness constant, ไม่ derive จาก prod)
- `sanitizeError(e, stage)` ตัวเดียวสำหรับทุก error path — whitelist: stage + error name + code เท่านั้น — ปิด raw driver message leak (ก่อนหน้านี้ leak temp DB name ทั้งก้อน)
- apply-refusal matrix verified: empty/srv/non-loopback/27017/creds/no-port → exit 1 ทุกกรณีก่อน Mongo connect/bind

### Disposable Mongo discovery → UNAVAILABLE
- Option A native `mongod`: `which`+`/opt/homebrew/bin`+`/usr/local/bin`+`brew list` → ไม่มี binary
- Option B cached Docker image: `docker` CLI ไม่มีอยู่ในเครื่องเลย (command not found)
- ตามสเปก: ห้าม install/download/pull, ห้าม fallback production → **apply ไม่ได้รัน**
- port 27017 closed — configured Mongo เป็น remote server

### Files changed
- `ChatAdminWeb/scripts/verify-botworker-runtime-mongo.ts` (+validator, +sanitizer, rewrite apply-boundary ~±60 LOC)
- `ChatAdminWeb/scripts/test-botworker-runtime-mongo-safety.ts` (+21 checks = 73 total)
- `getoutofmywaybotkaikrook2.md` (entry นี้)

### Verdict: `DISPOSABLE_MONGO_UNAVAILABLE`
Smoke harness พร้อมรันแล้ว — ขาดแค่ Mongo ที่เครื่องนี้: native `mongod` (brew install mongodb-community) หรือ cached mongo Docker image → rerun apply ครั้งเดียวตาม spec ได้ทันที

---
## งาน: Botworker smoke harness final safety correction — explicit URI provenance + strict error sanitizer
**สถานะ:** ✅ เสร็จ (harness/test only — ไม่ได้รัน apply, disposable Mongo ยังไม่มี)

### Finding 1 (High): verify-URI provenance — dotenv โหลดก่อนอ่าน URI
- Root cause: `runApply()` โหลด `dotenv/config` ก่อนอ่าน `BOTWORKER_VERIFY_MONGO_URI` → URI อาจมาจาก `.env` แทน explicit env → provenance ไม่ชัด
- RED: 2 pins fail (env-read + validate อยู่หลัง dotenv import — index 217/192 > 153)
- Fix ขั้นต่ำ: ย้าย `const uri = validateLoopbackMongoUri(process.env[VERIFY_URI_ENV] || "")` ขึ้นก่อน `await import("dotenv/config")` — ลำดับใหม่: **approval token → explicit URI validate → dotenv → ADMIN_MONGO_URI/DB rebind → fake → dynamic imports**
- ไม่มี fallback ไป ADMIN_MONGO_URI; dotenv ไม่เป็นแหล่ง verify URI อีกต่อไป

### Finding 2 (Medium): sanitizer ไม่ใช่ whitelist จริง
- Root cause: `e.name`/`code` ส่งออกโดยไม่กรอง → name/code ที่แปลก (URI, spaces, newline, string code) รั่วได้
- RED: 7 fails (malicious name, spaces, uri-chars, string code, NaN, Infinity, non-Error)
- Fix ขั้นต่ำใน `sanitizeError` ตัวเดิม: name ต้องผ่าน `/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/` มิฉะนั้น `"Error"`; code แสดงเฉพาะ `typeof number && Number.isFinite` — string/NaN/Infinity/object ไม่แสดง
- แก้ pin regex ผิดของตัวเองด้วย: `\s*` backtrack ทำ lookahead ผ่านบน space → เปลี่ยนเป็น `(?!\s*["'`])` ตรงหลัง comma

### Task 3: doc accuracy
- test header `<prod>_botworker_verify_<rand>` → `botworker_runtime_verify_<rand>` + lifecycle line
- harness header import-order แก้เป็น verify-URI → dotenv (เดิมเขียนกลับ)
- แก้ wording รอบก่อน: refusal matrix เดิม reject หลัง dotenv (dotenv ถูกโหลดใน process แต่ไม่มีการเปิด/แสดงเนื้อหาไฟล์) — หลัง correction นี้ missing/invalid URI reject **ก่อน** dotenv แล้วจริง

### Verify สด (ไม่มี --apply)
- safety **88/88** (73 + 15 new: 9 sanitizer strict + 4 provenance pins + 2 stage-constant)
- `npx tsc --noEmit` clean · dry-run exit 0 · `git diff --check` clean
- refusal probes: token+no-URI → exit 1 ก่อน dotenv/bind; token+`:27017` → exit 1 ก่อน dotenv/bind; output sanitized ทั้งคู่
- production/configured Mongo connections = 0 · Mongo writes = 0 · ports bound = 0 · LLM/Shopee = 0

### Verdict: `HARNESS_SAFETY_READY_DISPOSABLE_MONGO_UNAVAILABLE`
S1–S6 ยัง not executed/unproven — รอ disposable Mongo (native `mongod` หรือ cached image) เท่านั้น

### Real-Mongo smoke closeout (2026-10-06) — ✅ proven on disposable MongoDB 5.0
- Docker Desktop client/server `29.8.2`; image `mongo:5.0` native arm64; container ชั่วคราว bind เฉพาะ `127.0.0.1:27018`, ไม่ mount volume
- preflight: safety **88/88**, `npx tsc --noEmit` clean, dry-run exit 0
- apply รันหนึ่งครั้ง: S1–S6 **27/27 passed** — duplicate claim once, buffer batch once, HTTP 429 terminal `bot_failed`/no retry, new inbound พา failed turn เข้า history ครั้งเดียว, stale/evidence recovery finalize-only
- cleanup: harness drop `botworker_runtime_verify_<rand>`; read-only `listDatabases` เหลือ `[]`; ลบ container `chatbot-mongo-smoke` แล้ว; เก็บ image ไว้สำหรับ rerun
- fake `/chat` เท่านั้น: Gemini/OpenRouter/Shopee calls = 0; production/configured Mongo writes = 0
- verdict: `REAL_MONGO_SMOKE_PROVEN`

> **Committed:** `8fb416a test: add loopback-only botworker Mongo smoke harness` (3 files, +812) — staging ว่าง, leftovers untouched; S1–S6 พิสูจน์ภายหลังผ่าน disposable MongoDB 5.0 ครบแล้วตาม closeout ด้านบน

---

## [ผ่านแล้ว] /logs server-side pagination + responsive Pagination (2026-10-06) — ✅ fixed + verified

- **requirement (user update ล่าสุด)**: PAGE_SIZE=100 (API default+clamp 1–100) · sort `{timestamp:-1,_id:-1}` · summary `รายการ X–Y จากทั้งหมด Z รายการ` · Pagination +optional props `showBoundaryButtons`/`responsive` (CSS-only: phone≤3/md≤5/lg≤maxButtons numbered) · poll 5s เฉพาะหน้า 1, silent, ไม่ reset filter/expanded/view/scroll · verify screenshot 4 viewports (375/768/1366/1920)
- **baseline**: `/logs` fetch `limit=200` ครั้งเดียว + filter client-side ทั้งหมด ไม่มี pagination UI · API คืน `total=rows.length` (ผิด) · service `$sort timestamp:-1` ไม่มี `_id` tiebreaker · Pagination ใช้โดย shops/contacts/knowledge/ProductsTab (props ขั้นต่ำ — ห้ามเปลี่ยน behavior)
- **root cause**: ไม่มี server-side pagination เลย — filter client-side บน 200 rows แรกทำให้ log เก่ากว่านั้นหาไม่เจอ + total ผิด + sort ไม่ deterministic
- **วิธีแก้**:
  - `adminLogService.listAdminLogsExtended` → คืน `{rows,page,pageSize,total,totalPages}` · pipeline เดียว: `$match(base)→$lookup→$addFields→$match(search)→$sort{timestamp:-1,_id:-1}→$facet{rows:[$skip,$limit],meta:[$count]}` · search regex-escape (reuse `safeRegexSearch`) ครอบ 8 fields รวม joined username/name · actionType exact ชนะ actionTypes
  - `route.ts` → params ใหม่ `page`(≥1) `pageSize`(default 100, clamp 1–100) `admin_id` `action_type` `action_types`(CSV dedupe) `since`(invalid→ignore) `q`(≤100) — `limit` param เดิมถูกแทนด้วย pageSize
  - `Pagination.tsx` → +`showBoundaryButtons`(«/» aria-label ไทย) +`responsive`(3 CSS clusters `md:hidden`/`md:flex lg:hidden`/`lg:flex` ผ่าน `windowPages` — numbered รวม ≤3/≤5/≤maxButtons) · default path algorithm เดิมไม่แตะ → 4 หน้าอื่น render เหมือนเดิม
  - `logs/page.tsx` → `PAGE_SIZE=100` + `page/total/totalPages` state · loadLogs ส่ง server params (admin_id/action_type/action_types/q) + `reqSeq` stale-guard · filter ทุกจุด `setPage(1)` · search debounce 300ms · `usePolling {enabled: canViewLogs && page===1}` · row key `log._id` (แก้ expanded หลุดตอน poll) · footer summary+Pagination เดียวใช้ร่วม list/table
  - `shop-settings/page.tsx` → `limit:50` → `pageSize:50` (caller เดียวที่ใช้ param เก่า — คง behavior 50 rows)
- **verify**: TDD RED 44 fail → GREEN **51/51** (`scripts/test-admin-logs-pagination.ts` + fake-Mongo mocks) · `tsc --noEmit` clean · `next build` pass (warnings เดิมเท่า baseline) · `diff --check` clean
- **browser verify จริง** (playwright + minted session dev account, ลบ session แล้ว): 4 viewports ทุกตัว hScroll=false, numbered visible phone=3/tablet=5/laptop=pc=7, table แสดงเฉพาะ lg+, page1=100 rows, last page 349=40 rows (34,840 total ตรง), next/last/first ใช้งานจริง, summary `รายการ 101–200 จากทั้งหมด 34,840 รายการ · หน้า 2 จาก 349` ตรง format, poll page1=1 call/5s page2=0
- **เคสอื่น**: Pagination หน้าอื่นไม่เปลี่ยน (default path เดิม) · `/admin/logs` caller อื่นมีแค่ shop-settings (แก้แล้ว) · `listAdminLogs` ไม่แตะ
- **ยังไม่ commit** — รอ user review diff ก่อนตามกฎข้อ 10

### Review-fix รอบ 2: $lookup ก่อน pagination = performance regression (2026-10-06) — ✅ fixed + verified

- **root cause**: pipeline แรกทำ `$lookup` admins บน log ทั้งชุดก่อน `$facet` — page 1 poll ทุก 5s = join ทั้ง ~34,840 records ต่อ request แม้แสดงแค่ 100
- **RED evidence (fake pipeline วัด input จริง)**: F1 `lookup input=252` (page1, ต้อง ≤100) · F2 `input=252` (page3, ต้อง =52) · F3 top-level `$lookup` ก่อน `$facet` · F4 ไม่มี admin resolution query · F6 index ยังไม่มี — 51 tests เดิมยังผ่าน (mock ไม่พัง)
- **วิธีแก้ (stage order เท่านั้น, semantics เดิม)**:
  - `$match(base+search)` → `$sort{timestamp:-1,_id:-1}` → `$facet{ rows:[$skip,$limit,$lookup,$addFields,$project], meta:[$count] }`
  - search username/name: `find()` admins ด้วย escaped regex เดียวกัน (projection `admin_id`, ≤1 query เฉพาะเมื่อมี q) → fold `{admin_id:{$in:ids}}` เข้า `$or` ร่วมกับ raw fields 6 ตัว — search semantics ไม่เปลี่ยน
  - index ใหม่ 1 ตัวผ่าน owner เดิม: `safeCreateIndex(db, COLLECTIONS.adminLogs, { timestamp: -1, _id: -1 })` — ไม่รัน prod เอง, index เดิมครบ
- **after (probe)**: `lookup_input page1=100, page3=52` (เทียบ before=252) · admin resolution findCalls: no-search=0, with-search=1
- **verify**: focused suite **57/57** (51 เดิม + 6 ใหม่ — B15 rewrite บังคับ pipeline ใหม่ตาม prompt) · tsc clean · `next build` pass · `diff --check` clean · diff เฉพาะไฟล์ที่อนุญาต (service/mongoClient/2 test files) · ไม่มี UI เปลี่ยน → ไม่ mint session / ไม่ screenshot ใหม่
- **complexity delta**: modules/deps/env/collections/helpers = 0 · indexes +1 · duplicate pagination paths = 0 · behavior change = query execution order only
- **ยังไม่ commit** — งานเดิม + fix นี้รวม review เดียวรอ user อนุมัติ

---
## งาน: Phase BW-1 — Fix Duplicate-Poll Buffer Livelock + Prove Shutdown Gates
**สถานะ:** 🚧 กำลังทำ — audit owner code + hypothesis ก่อน RED

### BW-1 ผลงาน (หลัง verify)
- **Root cause พิสูจน์จากโค้ด**: `insertToBuffer` กลืน E11000 คืน void → `bufferOrProcess` เดินต่อ → `clearTimer`+re-arm debounce ทุกครั้ง → poll (1s) < window (7s) → timer ไม่มีวันครบ = livelock (chain: poll→claim claimed(owner self+lease)→bufferOrProcess→E11000)
- **Fix ขั้นต่ำที่ owner เดียว**: `insertToBuffer` คืน `"inserted"|"duplicate"`; duplicate ที่มี debounce/retry timer อยู่แล้วไม่ re-arm; duplicate ที่ timer หายหลัง transient failure ซ่อม deadline จาก `received_at` โดยไม่เริ่ม window ใหม่ — ไม่มี helper/flag/config ใหม่
- **RED**: L1/L2/L3 fail จาก livelock/contract; review พบ L4 insert สำเร็จแต่ read ล้มก่อน arm timer → early-return ทำ row ค้าง (`processCalls=0`) → **GREEN 47/47** หลังซ่อม deadline
- **Suites**: idempotency 46/46 · freshness 59/59 · enable-checkpoint 18/18 · boundary 20/20 · races 37/37 · tsc clean · build 84/84 · diff-check clean
- **Shutdown gates** มีอยู่แล้ว (cite): freshness ~L782 (toggle-off+clearPendingWork→callBot=0, row survive), ~L945 (disabled-window silent + procTransitions=0), enable-checkpoint S1-S3
- **SRS_SSD.md** อัปเดต bufferService row (duplicate contract)
- **ยังไม่ทำ**: single-worker lease, 429/500 carry-forward, real-Mongo smoke (S1-S6 disposable)

### BW-1 review-fix: missing-timer liveness gap (audit scratch + TDD)
- **Finding (High) พิสูจน์จริง**: fix เดิม (`duplicate → early-return`) ทำ row ค้างถ้า insert สำเร็จแต่ `getBufferedMessages` throw ก่อน arm — duplicate ถัดไป return ตลอดโดยไม่มี timer → ไม่มี execution path จน restart. Controlled revert (guard เดิม) → L4 fail (`processCalls=0`) → restore scratch → pass
- **Contract ที่ audit แล้วเก็บ scratch ไว้**: dup+timer(debounce|retry)→early return · dup+no timer+buffered>0→arm `max(0, latest received_at + window − now)` (deadline อิง original received_at ไม่เริ่ม window ใหม่) · dup+buffered=0→"batch already processing" · distinct→re-arm เดิม · max→immediate flush เดิม
- **mocks scratch**: `findHook` field (+2 บรรทัด — fakemongo engine รองรับอยู่แล้ว, resetState null อยู่แล้ว)
- **Network trap (Task 4)**: เพิ่มใน mocks.mjs owner เดียว — fetch/http.request/https.request/net.connect/Socket.connect throw `[test-net-trap]` + self-check T0
- **Timing margins (Task 3)**: ไม่มี fake clock — widen L1(100ms window/check@140) L2(200ms/check@310) L4(120ms/check@180+) — margin ~40-70ms ทั้งสองฝั่ง
- **Stale `.next/types`** เคยทำ tsc ด่า (dev-session artifact) — ลบ regen แล้ว clean
- **Suites**: idempotency **48/48** · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · tsc clean · build 84/84
- verdict: `ROOT_CAUSE_CLOSED` — ยังไม่ commit

### BW-1 final test-honesty fix (test-only — runtime ไม่เปลี่ยน)
- **F1 L4 timing**: window 120→300, repair@~120, intermediate checkpoint @~340 (original deadline 300 ผ่าน / incorrect fresh 420 ยังไม่ถึง) → assert `processCalls===1` โดยไม่ settle ก่อน; หลัง fresh deadline assert ยัง 1 + row consumed
- **Controlled mutation**: repair delay → full `effectiveWindowMs` → `FAIL L4 processCalls=0 @t≈340` (ยิงตอน ~420) → restore → GREEN
- **F2 T0 trap ครบ**: +https.request + `new net.Socket().connect` — matrix: fetch/http/https/net.connect/Socket.connect ทั้ง 5 throw `[test-net-trap]`; import graph audit — ไม่มี network client อื่น (mongodb driver ไม่โหลดเพราะ mongoClient ถูก redirect) → known boundaries covered
- runtime diff ไม่เปลี่ยนจาก candidate · suites: idempotency 48/48 · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · tsc clean · build pass

---
## งาน: Phase BW-2 — Single Active Botworker Ownership
**สถานะ:** 🚧 กำลังทำ — audit + RED contract tests เท่านั้น ยังไม่แก้ runtime

### BW-2 audit (ก่อนแก้ — evidence จากโค้ดจริง)
- **ไม่มี worker-leadership boundary เลย**: `pollNewMessages`/`recoverStaleBuffersAndClaims` ไม่มี gate — process ไหนก็ยิงได้; claim-level fencing (E11000/lease/CAS owner_id+fencing_token) เป็น backstop เดียว
- **ownerId** = `worker-<pid>-<uuid>` ต่อ boot, scope = claim doc เท่านั้น — ไม่มี worker lease doc
- **duplicate work จริงของ worker สองเครื่อง**: messages/chat_processing scan ทุก cycle, claim CAS ชน, recovery scans, deferred timers, `checkWaitTimeouts` scan, `bot.recovery_quarantine` log ซ้อน
- **reuse leader doc พิสูจน์ว่าไม่ได้**: chat_processing → recoverStaleClaims scan `{status:processing,lease<now}` จะ CAS `no_action` ทับ lease (ไม่มี message_id→ไม่ fresh); buffer_messages → P1 orphan `deleteOne`; system_configs → admin save clobber + shape pollution; botworker_events/messages → UI log/inbox semantics
- **proposal**: `botworker_state` singleton `_id:"botworker:leader"` {owner_id,fencing_token,lease_expires_at} — CAS acquire-on-entry ใน pollNewMessages + recovery เท่านั้น (vocabulary เดียวกับ claim protocol)
- **two-instance honesty**: mocks ให้ `botworkerRuntime.ownerId` rebind ระหว่าง call (fake Mongo resolve owner dynamic = process แยกจริงที่ DB layer); assertion เฉพาะ DB-observable outcome (found/processed/claim owner/callBot) ไม่พึ่ง singleton in-memory
- **RED 5/6**: M1 loser poll found=1/processed=1 · M2 loser recovery recovered=1 (steal งาน expired-claim ของ foreign owner!) · M4 expired lease ไม่ transfer · M5/M6 ไม่มี leader doc → acquire-on-entry ไม่มี · M3 green-pin (ไม่มี write ให้ห้าม — vacuous วันนี้)

### BW-2 review-fix (audit/contract/tests — ยังไม่แก้ runtime)
- **Corrected audit**: `system_configs` เป็น keyed docs — update path filter `{config_key:"main_config"}` → leader doc ภายใต้ key อื่นจะไม่ถูก config save clobber (แก้ claim เดิมที่บอกว่า clobber). เหลือเหตุผล semantic: coordination state ≠ admin configuration + blast radius (config tooling/migration/listing) → ยังเสนอ `botworker_state` singleton `_id:"botworker:leader"`, ไม่มี index เพิ่ม
- **Two-instance honesty (fixed)**: DB-level tests เรียก `ensureLeadership(ownerId)` ด้วย explicit param — ไม่ rebind global ขณะงานค้าง; integration tests rebind `botworkerRuntime.ownerId` เฉพาะหลัง `settle()`; concurrent absent-acquire ทดสอบด้วย `Promise.all` (fake Mongo enforce `_id` E11000 จริง)
- **Vacuous M3 (fixed)**: loser ต้อง produced found=0/processed=0/recovered=0/claim writes=0/buffer mutations=0/callBot=0 + leader doc untouched — RED วันนี้ (found=1/processed=1)
- **Query-counter proof**: ใช้ `state.onQuery` seam ที่มีอยู่ (ครอบทุก op) — loser อนุญาตเฉพาะ `botworker_state`; pin poll+recovery+`botWorkerService.checkWaitTimeouts()` (proposed gated wrapper — workflowEngine→botWorkerService import ตรงจะวน circular dep จึง gate ที่ service surface)
- **Lease/heartbeat contract pinned**: renew ก่อน expiry token ไม่เพิ่ม · expired takeover token+1 once · heartbeat เกิน lease span รักษา ownership · CAS lose→false · no heartbeat→lapse→takeover · leader loss ไม่ฆ่า in-flight claim work (message fencing เป็น owner) แต่ห้ามรับงานใหม่ · disable/shutdown ฆ่า heartbeat → lease lapse
- **Rollout limitation (explicit)**: lease คุ้มเฉพาะ worker เวอร์ชันใหม่ — worker เก่าไม่อ่าน leader doc เลย; deployment gate = stop old workers → deploy → verify singleton leader doc → start 1 instance; BW-2 alone หยุด deployed worker เก่าไม่ได้
- **RED สด**: 48 passed, 14 failed (M0a-f "coordinator contract missing" + M1-M8 real gaps: loser scan found=1, loser recovery stole foreign work=1, takeover ไม่เกิด, acquire-on-entry ไม่มี)

### BW-2 contract final correction (tests/mocks เท่านั้น — runtime ยังไม่แตะ)
- **onQuery ครบทุก op**: +updateMany/deleteOne/deleteMany/distinct/estimatedDocumentCount/aggregate (นับ attempt แม้ veto/unsupported) — meta-test M-INT พิสูจน์ทุกชนิด, จับ bug READ_OPS ขาด estimatedDocumentCount
- **M0b แก้**: seed lease now+1000 (< leaderLeaseMs 5000) → renew → owner/token เดิม, newExpiry > oldExpiry และ ≈now+leaderLeaseMs (tolerance 2s)
- **lifecycle semantics แยกชัด**: leadership loss = หยุด heartbeat + ปฏิเสธ admission ใหม่ (ไม่เรียก clearPendingWork, ไม่ abort in-flight ClaimContext work, รอบถัดไป reacquire ก่อน); disable/shutdown = clearPendingWork → abort era + heartbeat + timers ทั้งหมด
- **M9 automatic heartbeat** *(superseded — ถูกแทนด้วย recovery-based M9 ใน "contract cleanup รอบสุดท้าย"; poll-acquire ไม่พิสูจน์ recovery path จริง)*: acquire ผ่าน poll → findHook block work-query 260ms (>3× lease 80ms) → heartbeat 20ms renew อัตโนมัติ ~12 beat → mid-block doc ยัง A/token1 → ensure(B)=false → หลัง block owner เดียว (test ไม่เรียก renew เอง)
- **M10 CAS-loss race**: updateOne/findOneAndUpdateHook flip doc→B กลาง renewal write → CAS miss → A=false → heartbeat ตาย (0 writes หลัง loss) → admission ถัดไป scan 0 work collections
- **M11 timer cleanup**: test() finally + reset() เรียก clearPendingWork (single stop owner) — post-cleanup sleep>4×heartbeat → 0 writes ใน botworker_state; heartbeat unref
- **Collection parity**: mock COLLECTIONS + `botworkerState:"botworker_state"` — test/proposal อ้างผ่าน COLLECTIONS เท่านั้น ไม่ hardcode
- **Naming honesty**: M0d=manual renewal · M1=sequential active-leader/loser (A settle ก่อน B) · concurrency จริงอยู่ M0a เท่านั้น
- **RED สด**: 49 passed (48 เดิม + M-INT) / 17 failed — M0a-f contract missing, M1-M11 real gaps; sibling suites 59/18/20/37 unchanged, tsc clean

### BW-2 contract cleanup รอบสุดท้าย (test/docs only)
- **M9 → recovery จริง**: seed stale claim(expired owner A)+buffer row → `recoverStaleBuffers()` as A → findHook block work-query 260ms (lease 80/heartbeat 20, ≥3× margin) → mid-block doc A/token1 + ensure(B)=false (heartbeat renew อัตโนมัติ ~12 beat, test ไม่เรียก renew) → ปล่อย block → recovered=1, callBot=1, claim เดียว finalize owner A
- **M-INT exact**: `op→bucket` map ตรง — assert reads==Σread-ops, writes==Σwrite-ops (ไม่ใช่ >=N; insertMany→insertOne delegate ระวังนับซ้ำ)
- **Dedup**: ลบ M0d (manual renewal — ครอบโดย M0b+M9) + M0e (CAS-loss — ครอบโดย M0c+M10); คง M0a/b/c/f + M1-M11
- **Test count จริง**: 64 tests — 49 pass (48 legacy + M-INT) / 15 RED (contract gaps ทั้งหมด)
- **Complexity delta**: test file net −46 LOC จากรอบก่อน (ลบ 2 tests ~36 บรรทัด, M-INT rewrite, M9 rewrite)
- siblings unchanged: 59/18/20/37 · tsc clean · diff-check clean

### BW-2 implementation final round (runtime — รอ review ก่อน commit)
- **M-INT honesty proof**: controlled mutation สลับ bucket `distinct`↔`updateMany` → RED `op distinct classified as write, want read` → restore → GREEN; baseline กลับ 49/15 ตรง
- **Coordinator**: `ensureLeadership(ownerId = botworkerRuntime.ownerId)` — `botworker_state` singleton `_id:"botworker:leader"` {owner_id,fencing_token,lease_expires_at,updated_at}; absent→insert token 1 (E11000=loser) · self+active→renew CAS `{_id,owner_id,fencing_token}` ไม่เพิ่ม token · expired→takeover CAS `{+lease<now}` + `$inc token` ครั้งเดียว · foreign/CAS-miss→false · ไม่มี unfenced read-then-update
- **Heartbeat**: `leaderHeartbeat` timer เดียว (unref, `leaderHeartbeatMs`) — arm หลัง acquire สำเร็จผ่าน `acquireWorkerLeadership()`; CAS-loss→`stopLeaderHeartbeat` ตัวเอง (ไม่ abort in-flight claim work); `clearPendingWork` += stop heartbeat
- **Gates (3 จุดเท่านั้น)**: `pollNewMessages` + `recoverStaleBuffersAndClaims` + `botWorkerService.checkWaitTimeouts` (bot-worker.ts เรียก wrapper แทน workflowEngine ตรง) — loser = 0 work scan/0 mutation นอก state doc/0 provider call
- **Ordering regression ที่พบ+แก้**: gate ไว้ *ก่อน* `eraSignal()`/`recoveryInFlight`/`activePolls` registration → waitForInFlight gap (R42) + era resurrect (R43/R51) → ย้าย gate เข้า *ใน* tracked run หลัง eraSignal capture ซิงก์ + เช็ค `signal.aborted` ก่อน/หลัง gate → freshness กลับ 59/59
- **Runtime delta**: botWorkerService +~120 LOC (coordinator ~80, heartbeat ~20, gates ~10, export ~10) · botworkerRuntime +2 constants (leaderLeaseMs=15000, leaderHeartbeatMs=5000) · config.ts +1 key `botworkerState` · bot-worker.ts −1 import +1 call site · 0 feature flag / 0 index / 0 coordinator ตัวที่สอง
- **Schema delta**: collection ใหม่ `botworker_state` doc `{_id,owner_id,fencing_token,lease_expires_at,updated_at}` — singleton `_id`, ไม่เพิ่ม index
- **GREEN สด**: 64/64 (48 legacy + M-INT + 15 contract) · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · tsc clean · `npm run build` ผ่าน · diff-check clean
- **Rollout invariant (ข้อจำกัด)**: lease คุ้มเฉพาะ worker code ใหม่ — worker เก่าไม่อ่าน leader doc; deploy ต้อง stop old workers ทั้งหมด → deploy → verify singleton → start 1 instance; BW-2 alone หยุด old deployed worker ไม่ได้
- **Residual risks**: งาน in-flight ของ old-version worker ที่ไม่รู้ lease ยังรันต่อได้จน drain; takeover latency ≤leaderLeaseMs(15s) หลัง leader ตาย; lease clock เพิงพา wall clock ของ Mongo server+client เครื่องเดียว (test=host เดียวกัน)

### BW-2 lifecycle review-fix (2 High + 1 Medium — ownership lifecycle เดียว)
- **F1 heartbeat ใช้ verb ผิด semantics**: เดิม heartbeat tick เรียก `ensureLeadership()` — renew+takeover+reacquire ปนกัน → stale beat ที่ resume หลัง lease หมดสามารถ takeover เองโดยไม่ผ่าน admission → **แก้**: `ensureLeadership` คืน `LeaderCtx{owner_id,fencing_token}|false`; heartbeat ใช้ `renewLeadership(ctx)` verb ใหม่ — `findOne`→`leaderCtx!==ctx` superseded→true → owner/token mismatch→false → lease expired→false → fenced `updateOne{_id,owner_id,fencing_token,lease>now}` — renew-only ไม่มี takeover path; tick หยุดตัวเองเฉพาะเมื่อ `leaderCtx===ctx` เดิม (superseded ctx ไม่ฆ่า heartbeat ใหม่)
- **F2 checkWaitTimeouts ไม่มี cancel/drain**: เดิม wrapper เป็น bare `async` — ไม่มี era signal, ไม่ register ใน tracked set → abort กลาง leadership lookup แล้ว engine ยังรัน + heartbeat arm ทับ shutdown + waitForInFlight ไม่รอ → **แก้**: capture `eraSignal()` sync ก่อน await → register `run` เข้า `inFlight` (reuse set เดิม) ก่อน gate → `signal.aborted || !(await acquireWorkerLeadership(signal))` — abort กลาง acquire → return false โดยไม่ arm (heartbeat stop เป็นของ clearPendingWork เท่านั้น — กันยิง heartbeat ของ era ใหม่ที่เพิ่ง arm)
- **F3 same-process concurrent admission**: poll+recovery ชน absent doc → E11000 loser ได้ false → `acquireWorkerLeadership` ฝั่ง loser ไป `stopLeaderHeartbeat()` ฆ่า heartbeat ที่ winner เพิ่ง arm → lease ไม่ถูกต่อ → **แก้**: E11000/CAS miss → `rereadLeaderForOwner` bounded re-read ครั้งเดียว — winner เป็น ownerId เดียวกัน+active → คืน ctx นั้น (admission สำเร็จ); `false` เหลือเฉพาะ foreign/loss จริง → stop heartbeat ถูกต้อง
- **RED evidence ก่อนแก้**: 64 pass / 5 fail — M12c (post-cleanup renewal write landed), M13 (engine ran after abort + heartbeat armed + drain ไม่รอ), M14 (heartbeat ถูกฆ่าโดย concurrent loser → lease lapsed) ล้วน RED ตาม design; M12a/M12b ผ่านบน impl เก่า (M12b เพราะ stale `now` capture ก่อน blocked findOne ทำให้ resumed call เห็น foreign doc เป็น active พอดี) — tests ยัง pin semantics ที่ถูกต้องหลังแก้
- **GREEN หลังแก้**: 69/69 · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · tsc clean · build ผ่าน · diff-check clean
- **Delta**: botWorkerService +~75 LOC รวม (LeaderCtx/reread/renewLeadership/acquireWorkerLeadership rewrite + 3 gate sites) · test file +5 tests (M12a-c, M13, M14) · 0 collection/flag/index เพิ่ม

### BW-2 final admission-race correction (1 High + 1 Medium)
- **F1 stale admission clock**: `ensureLeadership` เดิมจับ `now` ก่อน `await findOne` — lease หมดระหว่าง read แต่ stale-now ทำให้เข้า renew branch และ CAS filter `lease>staleNow` match เศษ lease → คืน ctx token เดิม + เขียน expiry ที่ตายแล้ว → **แก้**: ย้าย `now = Date.now()` ไปหลัง findOne — decision+filter+lease_expires_at+updated_at ทุก branch อิง post-read timestamp เดียว (แก้ในฟังก์ชันเดิม ไม่เพิ่ม helper)
- **F2 stale admission result kills newer heartbeat**: `acquireWorkerLeadership` เดิม `if (!ctx) stopLeaderHeartbeat()` — ผล false ของ op ที่อ่าน stale/foreign view ฆ่า heartbeat ที่ admission ใหม่กว่าเพิ่ง arm (same-process re-acquire ติดตั้ง ctx ref ใหม่) → **แก้**: ลบ stop ออกจาก false path — heartbeat ตายเฉพาะ (a) `renewLeadership` fail (single loss detector) หรือ (b) `clearPendingWork` (single stop owner) — false ของ admission ไม่ใช่หลักฐานว่า armed ctx invalid
- **RED evidence**: 69 pass / 2 fail (of 71) — M15 (stale-now renew คืน ctx token5 + lease ตายแล้ว แทนที่ takeover token6), M16 (stale B-view false ฆ่า heartbeat{ctx ใหม่} → lease lapsed ทั้งที่ doc ยังของเรา)
- **M16 timeline**: A poll acquire ctx{A,1}+arm → rebind ownerId=B (loser-view) → op1 poll park ที่ leader findOne → rebind กลับ A → op2 recovery renew→`leaderCtx` ref ใหม่ (same token) → release op1 → read {A,1}=foreign(B)→false → stale false ต้องไม่ฆ่า heartbeat → lease renew ต่อ >150ms, token ค้าง 1, callBot=1
- **GREEN หลังแก้**: 71/71 · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · tsc clean · build ผ่าน · diff-check clean
- **Delta**: botWorkerService net +~8 LOC (ย้าย clock + ลบ false-path stop + comments) · test +2 tests (M15, M16) · 0 helper/coordinator เพิ่ม

### BW-2 real-Mongo smoke gate (disposable Docker Mongo 7 — commit 9539f9e verified)
- **Part 0 env-isolation fix (RED→GREEN)**: `verify-botworker-runtime-mongo.ts::runApply` เดิม `await import("dotenv/config")` — ขัดกฎ no-env-file → ลบออก + rebind strict env ทั้ง 5 ตัวจาก test-local constants เท่านั้น (ADMIN_MONGO_URI=validated loopback, ADMIN_MONGO_DB=verify_<rand>, ADMIN_JWT_SECRET/CHATBOT_INTERNAL_SECRET=`VERIFY_ONLY_*` fixed literals, CHATBOT_BASE_URL_SHOPEE=fake.url) ก่อน dynamic import ทุกตัว; safety suite เปลี่ยน dotenv-ordering pins → env-isolation pins → **110/110**
- **Round 1 (S1–S6)**: disposable `mongo:7` container `--rm` bind `127.0.0.1:27018:27017` เท่านั้น → `--apply` exit 0, **27/27 PASS**; verdict เดิม `REAL_MONGO_CORE_SMOKE_PASS`
- **Correction (reviewer)**: S1 loser เป็น **message-claim loser** (E11000 บน `botworker:claim:<mid>`) ไม่ใช่ **worker-leadership loser** — verdict รอบ 1 จึงถูกต้องแค่ core smoke; leadership race ยัง `BW2_REAL_MONGO_LEADERSHIP_RACE_UNPROVEN`
- **Round 2 (S7–S9 added, TDD RED 7 fails → GREEN 110/110 safety)**: scenarios ใหม่เรียก `svc.ensureLeadership(explicitOwnerId)` ตรง (DB-level CAS จริง, ไม่ rebind process owner, ไม่มี sleep-เลือก-winner, ไม่มี retry)
  - **S7 concurrent absent acquire = 5/5**: delete singleton → `Promise.all([A,B])` → winner เดียว/loser false · doc=1 · owner=winner · token=1 · fake calls+0
  - **S8 active renew + foreign reject = 7/7**: winner renew → owner เดิม/token=1/lease เพิ่ม · loser→false · post-loser doc byte-identical (loser เขียน 0) · fake+0
  - **S9 expired concurrent takeover = 8/8**: fenced expire `matchedCount=1` → `Promise.all([C,D])` → winner เดียว/other false · doc=1 · token=**2** พอดี · lease อนาคต · stale token-1 owner re-call→false · fake+0
- **Round 2 apply**: exit 0, **S1–S9 = 47/47 PASS**; verdict **`BW2_REAL_MONGO_LEADERSHIP_PASS`**
- **Cleanup**: harness marker/token-guarded dropDatabase → post-check `getDBNames()` = 0 verify DBs · container `--rm` removed · port 27018 closed · 0 volumes/containers เหลือ
- **Safety**: worker ไม่เคยเปิด · provider/Python/Shopee calls = **0** (fake `/chat` in-process เท่านั้น, total 4 calls S1–S4) · `.env` ไม่ถูกอ่าน · configured/prod Mongo ไม่ถูกเชื่อม · ไม่มี retry --apply

### BW-4/BW-5 error policy + single outbound concurrency owner (1 High root cause)
- **Part 0 audit (จากโค้ดจริง)**: outbound bot calls = 3 paths — (a) `processClaimedMessage` direct (no-match → bot), (b) trigger `bot_answer` — ทั้งคู่ผ่าน `acquireBotSlot` ใน botWorkerService, (c) `workflowEngine.let_ai_respond` → `callBot` **ตรง** → limiter ไม่ครอบ (unbounded) · error path ถูกอยู่แล้ว: non-2xx→`bot call failed:<status>`→catch→terminal `bot_failed`, 0 retry owner · carry-forward = `getGroupedHistoryForBot` (failed inbound มาใน history ครั้งเดียว, current ไม่ซ้ำ, consecutive-fail group เป็น 1 turn)
- **BW-4 (test-only, behavior ถูกอยู่แล้ว)**: suite ใหม่ `test-botworker-error-policy.ts` (hooks redirect เฉพาะ mongoClient+systemConfigService; `botCallService` real; fetch stub นับ call/peak/gate/status/reject/hang) — E1–E9: 429/500/network/timeout→fetch×1+terminal `bot_failed`+0 reply+0 auto-handoff · poll ซ้ำ fetch ค้าง 1 · new inbound→fetch+1, failed inbound ใน history×1, current ไม่ซ้ำ, 2 fails ต่อเนื่อง history bounded · empty answer→handed_off (pin)
- **BW-5 root cause**: limiter ใน botWorkerService ครอบแค่ call sites ตัวเอง — `let_ai_respond` bypass ทั้งระบบ + queue ไม่รองรับ abort + `releaseBotSlot` admit waiter โดยไม่เช็ค limit ใหม่ → **แก้**: ย้าย limiter ไป `botCallService.callBot` (outbound boundary เดียวที่ทุก path ไหลผ่าน) gate ด้วย `testSource==="botworker"` เท่านั้น — acquire ก่อน fetch + release ใน finally + FIFO waiters ที่ remove ได้ด้วย AbortSignal (abort ก่อน/กลาง queue → ไม่เรียก fetch) + drain อ่าน limit ล่าสุดทุก release (ลด limit กลางคันไม่ admit จน active<limit ใหม่) → ลบ semaphore เดิมทั้งก้อน (ไม่เก็บ 2 ระบบคู่กัน)
- **RED evidence**: 13/21 pass — C1 fetch=5>limit2 (callBot unlimited) · C3/C4 workflow bypass (2>1, 3>2) · C5 queued call abort ไม่ได้ (stuck) · C6 ownership-loss กลาง queue ยัง fetch=2 · C7 ลด limit แล้ว admit ต่อ (5>3) · C8 fetch=3>1 — ทุกเคสชี้ limiter อยู่ผิด boundary
- **GREEN**: 21/21 · idempotency 71/71 · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · safety 110/110 · tsc clean · build ผ่าน · diff-check clean
- **Complexity gate**: concurrency owner ก่อน/หลัง = 1→1 (ครอบคลุม 2/3→3/3 paths) · retry owner provider errors = 0→0 · config/flag/collection/index/module ใหม่ = 0 · shim = 0 (ลบ owner เดิมใน commit เดียว) · non-worker callers ไม่เปลี่ยน (C11 pin)
- **Delta**: botCallService +limiter ~57 LOC + acquire/release wrap · botWorkerService −limiter ก้อนเดิม+config-read block+call-site wrappers ~65 LOC (diff ใหญ่เพราะ re-indent try/finally) · test files +3 (error-policy + hooks + mocks)

### BW-5 review correction — cancellation threading + fail-stale limiter (3 High + 2 Medium findings)
- **Review verdict เดิม `BW5_COST_CONCURRENCY_CLOSED` เร็วเกิน** — limiter ถูกย้ายมา boundary จริง แต่ cancellation/timeout/fail-stale contract ยังรั่ว → corrective fix บน HEAD `1ab78bf` (ห้าม amend)
- **High 1 — workflow AI ไม่มี ownership/timeout signal**: `EngineMessage` ไม่มี `signal` → `let_ai_respond` เรียก `callBot` โดยไม่มี cancellation → queued workflow call ฆ่าไม่ได้ + fetch ไม่มี 90s bound → **แก้**: `EngineMessage.signal` + `engineMsg.signal = claimSignal` + `let_ai_respond` ส่ง `msg.signal` เข้า `callBot` + `checkWaitTimeouts(signal)` thread ถึง `processWaitTimeout` dummy msg (resumed let_ai_respond ตายพร้อม era)
- **High 2 — kill switch ไม่ถึง claimed work ที่รอ queue**: era signal หยุดที่ launch boundary — `ProcessMessageFn` รับแค่ msg → claimed work ที่ queued ใน limiter ยิง fetch หลัง toggle off → **แก้**: `processMessage(msg, signal?)` combine `AbortSignal.any([era, abortCtrl])` = claimSignal เดียว → `processClaimedMessage`/`engineMsg`/`callBot` queue+fetch · queued waiter ถูก abort-remove → **ไม่ fetch, claim คง `processing`** (recoverable — `bot_cancelled` event แยกจาก provider error) — try ใน `processClaimedMessage` เดิมครอบแค่ trigger+bot → workflow throw หลุด catch ทำ processMessage reject (unhandled rejection crash ใน test) → **ขยาย try ให้ครอบ workflow resume+matchAndRun** = classification point เดียว (aborted→cancelled / else→bot_failed)
- **High 3 — config read failure อาจ burst เป็น 50**: `getSystemConfig` กลืน DB error → `mergeWithSafety({})` (limit 50) — release เดิมอ่าน fresh+ใช้ตรงๆ → read ล้ม = เพดาน 50 → **แก้**: drain **fail-stale** — read 2 ครั้งเทียบ identity (`cachedConfig` ref เดียวกัน = healthy → fresh limit ใช้ได้ทั้งลด/เพิ่ม; doc ใหม่ = read ไม่เสถียร → `lastAcceptedBotCallLimit`) — ไม่เพิ่ม config owner
- **Medium 1 — C6 strict**: `P2_STUCK_IN_QUEUE` เดิมยอมรับ → เปลี่ยนเป็น fail ทันที (waiter ต้อง settle, ไม่ fetch, ไม่ finalize stale claim)
- **Medium 2 — C3/C4 exact workflow pin**: assert `workflow_actioned`/run doc/`WF_PROMPT_MARKER` ใน request body — direct fallback ผ่าน test ไม่ได้
- **RED (pre-fix, D-series เพิ่มใน suite เดิม)**: D1 workflow queued+ownership loss → `P2_STUCK`/fetch+finalize · D2 hang ไม่มี timeout → slot รั่วถาวร (contaminate test ถัดไป — ย้ายไปรันท้าย) · D3/D4 falling edge กลาง queue → `fetch=2` (claimed work ยิงหลัง kill switch) · D5 configError → `fetch=3` (drain burst ผ่าน fallback)
- **GREEN หลังแก้**: error-policy **26/26** (E1–E9 + C1–C12 + D1–D5) · idempotency 71/71 · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · safety 110/110 · dry-run exit 0 · tsc clean · build ผ่าน · diff-check clean · provider calls=0, worker=0, real Mongo=0, `.env` read=0
- **Complexity gate**: concurrency owner=1 (callBot) · kill-switch owner=1 (`clearPendingWork`→eraAbort) · cancellation classifier=1 (catch เดียว) · timeout composer=1 (callBot fetchSignal, `botCallSignal` helper ใน worker ถูกลบ) · provider retry owner=0 · config/flag/collection/index/module ใหม่=0 (`bot_cancelled` = 1 union member ใน event type เดิม — ไม่ใช่ schema ใหม่)
- **Residual**: `botCallTimeoutMs`=90s real ในโปรดักชัน (D2 ใช้ runtime override 80ms); recovery ของ claim ที่ cancelled ขึ้นกับ rising-edge เดิม (ไม่เปลี่ยน); drain identity-check พึ่ง `cachedConfig` ref — ถ้า getSystemConfig เปลี่ยนเป็น non-cached ต้อง revisit (pin ไว้ในคอมเมนต์โค้ด)

### BW-5 final corrective fix — config health owner + post-response fence + wait-timeout rollback (3 High findings, corrective commits ต่อ `250a960`)
- **F1 config failure burst ที่ admission**: `getSystemConfig` กลืน DB error → fresh fallback doc (limit=50) ทุก call → callBot เขียนทับ `lastAcceptedBotCallLimit` ก่อน acquire — identity check `a===b` กันเฉพาะ drain → **แก้**: `systemConfigService` เป็น last-known-good owner จุดเดียว — read ล้ม+เคยสำเร็จ → คืน `cachedConfig` เดิม; cold-start ล้ม → `{...mergeWithSafety({}), bot_concurrency_limit:1}` fail-closed · `callBot` ลบ `lastAcceptedBotCallLimit`+double-read identity check — admission+drain ใช้ contract เดียวจาก owner (admission: `confLimit>0 ? confLimit : 1`; drain: อ่านค่าเดียว ไม่เชื่อตัวเลข fallback)
- **F2 kill-switch post-response race**: หลัง `callBot` resolve เช็คแค่ `ctx.lost` — era abort หลัง provider success ก่อน `finalizeClaims` ยัง finalize ได้ → **แก้**: fence เดียวที่ `processMessage` — `res.outcome && !ctx.lost && !claimSignal.aborted` → claim คง `processing` (recoverable); deterministic evidence (shadow_replies/run result) ที่ persist ไปแล้วถูก recovery reuse — ไม่เรียก provider ซ้ำ · ไม่เพิ่ม guard ทุก branch
- **F3 wait-timeout abort→failRun**: outer `checkWaitTimeouts` catch ทุก error → `failRun(run)` ด้วย stale snapshot — fenced run (token mismatch) CAS miss → ค้าง `running` (scanner มองไม่เห็น); legacy/unfenced → `errored` terminal → **แก้**: `processWaitTimeout` (owner เดียว ถือ acquired ctx) — era abort ก่อน/กลางเดิน → `restoreWaitPark` fenced write คืน `waiting_for_reply` + preserve `wait_started_at`/`wait_node_id`/`waiting_for`/`current_node_id`/`wait_retry_count` (CAS miss = owner ใหม่ reclaim แล้ว → ไม่เขียนทับ) · outer catch แยก `signal.aborted` → continue (real error ยัง `failRun` เดิม)
- **Test-infra**: fake-mongo `onQuery` เป็น awaitable (13 sites — pause gate ที่ persist boundary); mock `getSystemConfig` เปลี่ยนจาก throw → production-faithful contract (healthy: snapshot เป็น lastGood; error: `lastGood ?? fail-closed-1`) — RED run ชั่วคราวใช้ fresh-50 fallback model ตรง production เดิม
- **RED evidence (pre-fix, 26/32)**: D6 `fetch=4` (admission ยึด fresh-50) · D7 `fetch=3` (cold-start admit 50) · D8 `claim=bot_answered` (finalize หลัง kill switch) · D9 `claim=workflow_actioned` · D10 `run.status=running` (fenced — failRun stale-token CAS miss) · D11 `run.status=errored` (legacy — unfenced failRun)
- **GREEN หลังแก้**: error-policy **32/32** (E1–E9, C1–C12, D1–D11) · idempotency 71/71 · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · safety 110/110 · tsc clean · build ผ่าน · diff-check clean · provider calls=0 · worker=0 · real Mongo=0 · `.env`=0
- **Owners หลังแก้**: config last-known-good = `systemConfigService` 1 จุด (`cachedConfig` เดิม — ไม่มี cache ซ้ำ) · outbound concurrency = `callBot` 1 จุด · kill switch = `clearPendingWork`→`eraAbort` 1 จุด · claim finalization fence = `processMessage` 1 จุด · wait-timeout rollback = `processWaitTimeout` 1 จุด · provider retry = 0 · object-identity health check = 0 · flags/config/collection/index ใหม่ = 0
- **Delta**: systemConfigService +4 (catch คืน last-good/fail-closed) · botCallService −15 net (ลบ lastAccepted+identity check) · botWorkerService +1 condition · workflowEngine +~25 (restoreWaitPark closure + try/catch wrap + outer abort-skip) · tests +6 (D6–D11) + helpers (`pauseQuery`/`waitFor`) + fake-mongo await hook
- **Residual**: era abort ระหว่าง persist writes อื่น (ไม่ใช่ reply evidence) ยังขึ้นกับ recovery เดิม; wait-timeout path ไม่ persist delivered ลง shadow_replies (contract เดิม — ไม่เปลี่ยน); legacy run abort → rollback ผ่าน acquired doc (acquire ใส่ owner ให้) — ไม่ใช่ fenced guarantee ของ run เดิม
- **Verdict correction**: `BW5_COST_CONCURRENCY_CLOSED` รอบก่อนประกาศเร็ว — รอบนี้ปิดจริงหลัง 3 findings แก้+GREEN ครบ; `BW6_PREDEPLOY_READY` ยังถือว่า mock-verified เท่านั้น — canary/deploy ยังไม่ได้ทำ

### BW-5 final root-cause correction (4 findings จาก reviewer, corrective commits ต่อ `2fbbe83`)
- **A config failure → fail-closed field policy**: `getSystemConfig` เดิมคืน `cachedConfig` ทั้งก้อนตอน read ล้ม — `bot_worker_enabled`/`workflow_enabled`/`shadow_bot_enabled` stale-true → worker ทำงานต่อกลาง Mongo outage → **แก้**: warm-cache failure คืน projection ของ cached — enable switches 7 ตัว (`bot_worker_enabled`/`bot_buffer_enabled`/`workflow_enabled`/`shadow_bot_enabled`/`mock_mode_enabled`/`grouped_retrieval_shadow_enabled`/`grouped_retrieval_selection_enabled`) = false เสมอ, limits/windows/URLs/engine fields fail-stale (last-validated — `bot_concurrency_limit` คงค่า), cold-start = `{...mergeWithSafety({}), bot_concurrency_limit:1}` · cache owner ยัง 1 จุด
- **B stale fencing context ใน timeout error path**: outer `checkWaitTimeouts` catch → `failRun(run)` ด้วย snapshot ก่อน acquire — `processWaitTimeout` ได้ token ใหม่แล้ว → CAS miss → run ค้าง `running` → **แก้**: `processWaitTimeout` (owner เดียว) → `Promise<boolean>` — non-abort error หลัง acquire → `failRun(acquired)` ด้วย fencing ปัจจุบัน; outer catch เหลือ log-only (ห้าม terminal write ด้วย stale snapshot)
- **C abort boundary**: pre-aborted signal เดิมยัง acquire+restore (writes) และ loop เดินต่อ → **แก้**: `signal.aborted` check ก่อน `acquireRun` (zero write) + loop-top `break` (abort ระหว่าง → ไม่แตะ candidate ถัดไป) + `processed` นับเฉพาะ return true (จัดการจริง) — boundary เดียว ไม่มี guard ซ้อน
- **D production-faithful config tests**: suite ใหม่ `test-botworker-config-failclosed.ts` (hooks redirect เฉพาะ `mongoClient` — `systemConfigService` = production จริง) — module-cache separation ซื่อสัตย์ด้วย case ordering (cold-start รันก่อน healthy) · F1 cold-start outage → worker=false+limit=1 · F2 healthy → DB fields จริง · F3 warm outage → switches false + limit last-validated · F4 recovery → ค่าจริงกลับ · mock contract ใน error-policy-mocks อัปเดตตาม (switches fail-closed + `lastGoodConfig?.limit ?? 1`)
- **RED evidence (pre-fix)**: F3 `shadow_bot_enabled=true` stale กลาง outage (suite ใหม่ — `bot_worker_enabled` ก็ stale เช่นกัน) · D12 `processed=1` + runWrites>0 (pre-aborted ยัง acquire/restore) · D13 `run_b token=6` (abort แล้วยัง acquire candidate ถัดไป) · D14 `run.status=running` (provider-500 post-acquire → failRun stale-token CAS miss)
- **GREEN หลังแก้**: error-policy **35/35** (E1–E9, C1–C12, D1–D14) · config-failclosed **4/4** · idempotency 71/71 · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · tsc clean · build ผ่าน · diff-check clean · provider=0 · worker=0 · real Mongo=0 · `.env`=0
- **Delta**: systemConfigService +14 (fail-closed projection + policy comment) · workflowEngine +~25 (boolean return + pre-acquire check + loop break + inner failRun − outer stale-failRun − throw) · mocks +12 (contract mirror) · test +3 files (config suite) + D12–D14 + shared seed helpers (ลบ dup ใน D10/D11) · helpers runtime +0 · branches runtime +2/−2 net ~0 · owners: cache=1, timeout-transition=1, abort boundary=1 · flags/collections/modules ใหม่ = 0
- **Residual**: `restoreWaitPark`/`failRun(acquired)` throw → outer log-only catch (DB write fail อยู่แล้ว — run ค้าง running จน lease expiry + recovery เดิม) · wait-timeout path ไม่ persist delivered ลง shadow_replies (contract เดิม) · `processMessage` finalize fence เดิม (era abort หลัง evidence persist) ไม่เปลี่ยน
- **Readiness wording ที่แก้**: BW-5 ปิดได้เฉพาะหลัง production config suite + timeout races ผ่าน (รอบนี้ผ่านแล้ว) · BW-6 ยังไม่ deploy/canary — mock/fake-Mongo verified เท่านั้น

### BW-5 final closure correction (1 High + 2 Medium, corrective commits ต่อ `b189357`)
- **A cold-start outage อ่าน switches จาก env (High)**: cold-start catch คืน `{...mergeWithSafety({}), limit:1}` — `mergeWithSafety({})` → `getSafeDefaults()` อ่าน `BOT_WORKER_ENABLED`/`MOCK_MODE_ENABLED`/`SHADOW_BOT_ENABLED`/`BOT_BUFFER_ENABLED`/`WORKFLOW_ENABLED`/`USE_GROUPED_RETRIEVAL_SHADOW`/`USE_GROUPED_RETRIEVAL_SELECTION` จาก env (call-time) → env=true → switches true กลาง outage → **แก้**: `FAIL_CLOSED_SWITCHES` const object เดียวใน owner — warm=`{...cachedConfig, ...FAIL_CLOSED_SWITCHES}`, cold=`{...mergeWithSafety({}), ...FAIL_CLOSED_SWITCHES, bot_concurrency_limit:1}` — policy เดียวกันทั้งสอง failure path, healthy env-fallback ไม่เปลี่ยน
- **B abort ระหว่าง getWorkflow await ยังเขียน cancel (Medium)**: loop-top check มีแล้วแต่ abort ลงกลาง `await getWorkflow` + lookup→null → `cancelIfAbandoned` ยัง updateOne `status:cancelled` → **แก้**: `signal.aborted` check อันเดียวหลัง await ก่อน write branch → break (boundary เดิม ไม่เพิ่ม guard ที่ call sites)
- **C processed เกินจริงเมื่อ failRun CAS แพ้ (Medium)**: `failRun` คืน boolean อยู่แล้วแต่ caller ไม่ส่งต่อ — `await failRun(acquired); return true` → terminal CAS miss (foreign reclaim) ยังนับ handled → **แก้**: `return await failRun(acquired, ...)` ทั้ง wait-node-missing branch และ non-abort catch — true เฉพาะ terminal write สำเร็จ
- **RED evidence (pre-fix, จริง)**: F1 `mock_mode_enabled=true` (env-true leak บน cold-start — เซ็ต 7 env vars ก่อน import) · D15 `workflow_runs writes=1` (abort กลาง parked findOneHook workflows → lookup→null → cancel write ยังทำ) · D16 `processed=1` (updateOneHook flip owner/token ก่อน errored write → CAS miss แต่ยังนับ)
- **GREEN หลังแก้**: config-failclosed **4/4** (F1 cold env-true→all false+limit1 · F2 healthy+pin env-fallback `mock_mode_enabled=true` เมื่อ DB absent · F3 warm→switches false+limit คง · F4 recovery) · error-policy **37/37** (D1–D16) · idempotency 71/71 · freshness 59/59 · checkpoint 18/18 · boundary 20/20 · races 37/37 · tsc clean · build ผ่าน · diff-check clean
- **Delta**: systemConfigService +13/−10 (FAIL_CLOSED_SWITCHES const — ลบ inline 7-key list ซ้ำระหว่าง warm/cold) · workflowEngine +9/−6 (post-await abort check +3, failRun-result returns) · helpers runtime +0 (const object ไม่ใช่ fn — ลด dup จริง) · branches +1 (post-lookup check) · owners: cache=1 / transition=1 / abort boundary=1 · flags/collections/modules = 0
- **Test-infra**: config suite เซ็ต env switches=true ก่อน dynamic import (honest cold-start) · error-policy mocks เพิ่ม `findOneHook`/`updateOneHook` keys ใน state literal (tsc) · note: tsc incremental cache (`tsconfig.tsbuildinfo`) stale เคยหนึ่งครั้ง — ลบแล้วรันใหม่ clean
- **Residual**: wait-node-missing `failRun` branch เป็น defensive (unreachable ผ่าน checkWaitTimeouts — outer filter require current_node_id=wait node) — fix ใส่ไว้ symmetric · abort ระหว่าง `coll.find(candidates)`/`logAdminEvent` ไม่มี write-run side effect (find=read, log=audit เท่านั้น) · era abort หลัง completeRun เริ่มเขียนแล้ว = contract เดิม
- **Readiness**: BW-5 ปิดด้วย production config suite + timeout/accounting races ผ่านจริง · BW-6 ยังไม่ deploy/canary

### BW-6 preflight G2+G3 (approved เฉพาะ G2+G3 — G4 ยังไม่อนุมัติ)
- **G2 real-Mongo smoke PASS — `47/47` exit 0 รันเดียว บน HEAD `f316cdb`**: disposable `mongo:7` (image `1f995ad6fdb9` เดิม ไม่ pull) `--rm` bind `127.0.0.1:27018` เท่านั้น, ไม่มี volume/credentials — S1 claim idempotency+single reply · S2 buffered merge+row delete · S3 `bot_failed`+no re-invoke · S4 retry history-once · S5 stale→`no_action`+`stale_at_recovery` · S6 outcome preserved · S7 concurrent acquire winner เดียว/token=1 · S8 renew+foreign reject+doc byte-identical · S9 fenced takeover token=2+stale refused — `BOTWORKER_REAL_MONGO_SMOKE` token + loopback URI เท่านั้น, fake `/chat`, provider=0, worker=0
- **G2 cleanup verified**: harness drop `botworker_runtime_verify_*` เอง → mongosh `getDBNames` กรอง verify = 0 DBs · `docker stop` + `--rm` → `ps -a` = 0 containers · port 27018 = 0 listeners
- **G3 canary plan docs-only**: `docs/plans/botworker-canary-plan.md` — proven-vs-unproven matrix, staged enable (Stage 0 dry config `limit=1`/`workflow_enabled=false` → Stage A single-shop 30min obs → Stage B ramp 3+workflow 60min → Stage C ≥24h), success/failure criteria, dup-detection queries (`shadow_replies.inbound_message_id` unique, `chat_processing` claims, `admin_logs`, `botworker_state` lease), 429/500 monitoring, cost ceiling (limit=hard cap, calls ≤ inbound), kill switch 2 ระดับ (DB toggle ≤~7s / `compose stop`), rollback (claims processing → recovered next era, no data cleanup), pre-enable checklist — collection/field names verify จาก config.ts จริง
- **ไม่แตะ**: runtime, worker, deploy, canary จริง, `.env`, push/PR — uncommitted doc รอ review

### BW-6 G3 canary plan correction (docs-only, HEAD `f316cdb` — uncommitted รอ review)
- **Review findings → fixed ใน `docs/plans/botworker-canary-plan.md`**:
  - **single-shop ไม่จริง**: `pollNewMessagesInEra` query `{role:user, direction:in, created_timestamp>since}` ไม่มี `shop_id` filter (verify line 1418) → plan แยก 2 modes: **A isolated env/DB** (recommended — shop scope จริงเพราะ data มีแค่ test shop) vs **B production-global** (ทุก shop post-edge eligible — `limit=1` จำกัด concurrent calls เท่านั้น ไม่จำกัดร้าน/total calls; ต้อง pre-compute worst-case spend จาก inbound rate) — shop allowlist runtime อยู่นอก scope docs-only
  - **cost ceiling ไม่ hard**: limit ≠ ceiling → mandatory values table (`EXECUTION_MODE`/`MAX_CANARY_DURATION_MINUTES`/`MAX_PROVIDER_CALLS`/`MAX_PROVIDER_COST_USD`/`OBSERVER_OWNER`/`ABORT_AUTHORITY`/`CANARY_START_TS`/`FORCED_STOP_TS` — ทุกช่อง `MUST_SET_BEFORE_G4` ห้าม invent) + hard-stop contract: provider-side budget/counter ที่เชื่อถือได้ หรือ G4=BLOCKED + wall-clock forced stop
  - **workflow calls อาจ > inbound**: Stage A `workflow_enabled=false` คง ≤1 call/claimed turn; Stage B ต้องนับ calls ฝั่ง provider จริง ห้าม derive จาก inbound
  - **shadow_replies ไม่พิสูจน์ calls หยุด**: 429/500/timeout ไม่มี reply doc → rollback verify = process state + worker logs + **provider dashboard (primary)** + claims/admin_logs supporting
  - **emergency order แยก 2 กรณี**: normal = DB toggle→paused confirm→stop; cost spike = `compose stop` ก่อน→DB toggle ก่อน restart→verify process+provider activity
  - **monitoring**: queries window-scoped (`CANARY_START`) + origin worker, 429/500 ดู 3 แหล่ง, cost criterion = ตัวเลขก่อน G4
- **Gate**: G1 PASS · G2 PASS 47/47 (หลักฐานเดิมคงไว้ข้างบน) · G3 READY_FOR_REVIEW · **G4 BLOCKED_BY_MODE_AND_COST_LIMIT_APPROVAL** · G5 NOT APPROVED
- **Uncommitted**: `docs/plans/botworker-canary-plan.md` (rewrite) + log นี้ — ห้าม stage จน review ผ่าน

### BW-6 G3 final safety correction (docs-only, HEAD `f316cdb` — uncommitted รอ review)
- **5 findings fixed ใน canary plan** (หลักฐาน G2 คงไว้ด้านบน ไม่รันซ้ำ):
  - **High1 counter≠hard stop**: §4.1 บังคับ enforcement จริง — provider-enforced hard budget/rate cap (reject calls เมื่อชนเพดาน) หรือ automated supervisor อ่าน authoritative usage→`compose stop` เมื่อแตะ MAX_*; manual observer=monitoring เท่านั้น; ไม่มี→`BLOCKED_BY_MISSING_AUTOMATED_COST_STOP` + review evidence: mechanism owner/threshold/armed proof/stop action/usage-API-down behavior
  - **High2 callBot≠provider call**: terminology §1 — worker request=HTTP `/chat`→Python, provider call=upstream OpenRouter/Gemini/search/model ใน Python (1 request อาจหลาย calls); Stage A พิสูจน์แค่ ≤1 **worker request**/turn ไม่ใช่ provider call; `MAX_PROVIDER_*` อ่าน provider-side usage เท่านั้น ห้าม derive จาก claims/inbound/callBot/shadow_replies; Mode B worst-case ต้อง `PROVIDER_COST_PER_CHAT_P95_USD` วัดจริง ไม่มี→BLOCKED
  - **Med3 forced stop enforcement**: `FORCED_STOP_TS` เดียวไม่พอ → `FORCED_STOP_MECHANISM`+`OWNER`+`ARMED_AT` keys + armed proof + exact stop action + scheduler-fail fallback (cost-stop ยังตัด + observer hard-stop); ไม่ invent command ใช้ `MUST_SET_BEFORE_G4`
  - **Med4 dup query origin filter**: verify `origin:"worker"|"workflow"`+`mode:"standalone"` (botWorkerService:472/538) + `__wf<N>` suffix — query ตรวจ same-identity dup เท่านั้น (multi workflow deliveries=ตั้งใจ)
  - **Med5 mandatory thresholds**: เพิ่ม `MAX_BOT_FAILED_RATE_PERCENT`/`MAX_CONSECUTIVE_429`/`MAX_CONSECUTIVE_5XX`/`PROVIDER_COST_PER_CHAT_P95_USD`/`FORCED_STOP_MECHANISM`/`OWNER`/`ARMED_AT`/`COST_STOP_MECHANISM`/`ARMED_AT` — ทุกช่อง `MUST_SET_BEFORE_G4`, criteria อ้าง key ตรงๆ
- **Gate**: `G4 = BLOCKED_BY_EXECUTION_MODE_AND_ENFORCED_LIMITS` (ปลดเมื่อ mode+thresholds+cost-per-chat+armed cost stop+armed forced stop+owners+rollback reviewed+explicit approval ครบ) · G5 NOT APPROVED
- **Uncommitted**: plan rewrite + log นี้ — ห้าม stage จน review ผ่าน

### BW-6 G3 cleanup — review passed, 2 จุดแก้เพิ่ม (docs-only, HEAD `f316cdb`)
- **`COST_STOP_OWNER`** เพิ่มใน mandatory table (`MUST_SET_BEFORE_G4`) + อ้างตรงใน §4.1 evidence/checklist/G4 unblock — เจ้าของกลไก cost-stop จริง ห้ามแทนด้วย `OBSERVER_OWNER`/`ABORT_AUTHORITY` (คนละหน้าที่)
- **p95 ≠ worst-case**: เปลี่ยน "worst-case spend" → **planned spend estimate (p95-based)** — สูตร `inbound_rate × PROVIDER_COST_PER_CHAT_P95_USD × duration` ใช้วางแผนเท่านั้น tail cost อาจเกิน; ตัวจำกัดจริง = `COST_STOP_MECHANISM` + provider-enforced limit
- **G3 review ผ่าน → commit** `docs: add botworker canary safety gate` · G4 ยัง `BLOCKED_BY_EXECUTION_MODE_AND_ENFORCED_LIMITS` — ไม่ได้เปิด worker/deploy/canary

### 2026-10-09 — Botworker intentional pause checkpoint
- **สถานะ**: พักงาน Botworker โดยตั้งใจหลัง G1 fake/static PASS, G2 real-Mongo PASS 47/47 และ G3 canary safety plan commit `04f0e10`; worker ยังปิด, ไม่มี deploy/canary/push ใน checkpoint นี้
- **งานที่เหลือก่อนปิด Botworker ทางเทคนิค**: Mode A end-to-end บน isolated environment/DB พร้อม enforced cost/time stop; ถ้าผ่านให้ถือว่างานโค้ด Botworker ปิดได้
- **งานที่เหลือก่อน production rollout**: Mode B production-global canary (runtime ปัจจุบันไม่มี `shop_id` allowlist) หลังเลือก execution mode, กำหนด thresholds/cost-per-chat, arm automated cost stop + forced stop และได้รับอนุมัติ G4 แยกต่างหาก
- **Gate ปัจจุบัน**: `G3_APPROVED_AND_COMMITTED` · `G4_BLOCKED_BY_EXECUTION_MODE_AND_ENFORCED_LIMITS` · `G5_NOT_APPROVED`
- **ห้ามทำต่ออัตโนมัติ**: ห้ามเปิด/รัน botworker, deploy หรือ provider canary จนผู้ใช้กลับมาอนุมัติงาน Botworker โดยตรง

### 2026-10-09 — Current-system architecture/root-cause audit (กำลังทำ, read-only)
- **ขอบเขต**: เก็บและตรวจปัญหา 21 ข้อจากผู้ใช้เทียบกับ code/runtime owners, README, SRS/SSD, function/process, schema, plans, waythrough ทั้งสองไฟล์ และ git history จริง
- **เป้าหมาย**: ระบุว่างานอยู่จุดไหน, behavior ใดใช้งานจริง/shadow/contract/dead, owner ที่ซ้ำกัน, root cause ของ hardcode/guard/helper/fallback ที่เพิ่มไม่จบ และ requirement mismatch โดยยังไม่ออกแบบ architecture ใหม่
- **ข้อห้ามรอบนี้**: audit/docs only; ไม่แก้ runtime, ไม่เปิด botworker, ไม่เรียก provider, ไม่อ่าน `.env`/secret, ไม่ stage/commit/push/deploy
- **หลักฐานแรก**: production default ยังเข้า legacy `_chat_impl`; `turn_decision` เป็น shadow-only; grouped selection เป็น flag-gated และ merge ทับบน base products; assignment ไม่มี load cap แต่ยังกรอง `is_accepting_chats` และมี pending/no-available path ซึ่งต้องเทียบ requirement ล่าสุดแยกต่างหาก

### 2026-10-09 — Current-system architecture/root-cause audit (อ่านครบและบันทึกผลแล้ว)
- **Artifact**: `docs/plans/2026-10-09-current-system-architecture-audit.md` — snapshot ข้อเท็จจริงของระบบปัจจุบัน, runtime/data map, root causes 9 กลุ่ม, mapping ปัญหา 21 ข้อ, requirement alignment, Phase 2A/2B status และข้อห้ามก่อน redesign; ไม่ใช่ implementation plan
- **Critical handoff defect**: `app.py` no-product branch ตั้ง `handoff_to_admin=True` โดยไม่เรียก `_send_handoff`; `guards.enforce` เห็น flag แล้ว return; `_send_handoff` เองคืน `{}` เมื่อ fail และ callers หลายจุดไม่ได้ตรวจ success — desired action ถูกใช้แทน completed side effect
- **Decision ownership**: production default = legacy 5,223 LOC; v2/v3 ยัง request/env-selectable; TurnDecision shadow-only; grouped retrieval เป็น augmentation merge; workflow→trigger→chatbot เพิ่ม decision stack หน้า Python อีกชั้น
- **Lifecycle mismatch**: conversation close/ownership ถูกใช้ปน claim resolution; Phase 2A tests/audit มีแล้ว แต่ Phase 2B/2C replacement runtime ยังไม่เริ่ม และ explicit claim-resolution event ยังไม่มี
- **KPI defect**: `response_rate_10min` ใช้ reply/message count หาร conversation count จึงเกิน 100% ได้ตามสูตร; `resolved=total-closed` ก็ไม่ใช่ business-resolution contract ที่ชัด
- **Platform gap**: Shopee เท่านั้นที่มี chatbot runtime; Lazada/TikTok package ว่าง แม้ compose ระบุ collection/port แล้ว; order adapter ปัจจุบันเป็น collection เดียว default `ShpOrders`
- **Complexity cause**: add-first/no-retirement, หลาย decision/evidence/answer owners, branch-local LLM/context merges, keyword เป็น flow control, tests pin incidents มากกว่า owner deletion, docs หลาย time layers
- **Safety**: runtime/tests/config ไม่เปลี่ยน; worker/provider/Mongo/`.env` = 0; ไม่มี stage/commit/push/deploy; unrelated leftovers ไม่แตะ
- **Exhaustive scope clarification**: inventory ครอบ product-owned source/routes/services/scripts/tests/contracts/plans/docs ทั้ง repo (Shopee 54 files, backend 52, API routes 99, Python test/audit 93, TS script tests 32); generated replay ดู schema+aggregate+representative failures, binary/vendor/cache ไม่นับเป็น architecture evidence, `.env*`/secret ไม่อ่าน
- **Evidence-quality correction**: stored results ไม่ใช่ baseline เดียว — test-200 = HTTP 401 ทั้ง 220 rows (ใช้วัด quality ไม่ได้), comprehensive เก่า 359/385 คนละ evaluator, OpenRouter shadow 18 cases เฉลี่ย ~34.9k tokens/$0.014/11.25s, e2e 12 casesเฉลี่ย 9.73s max 36.3s
- **Additional code defects**: dashboard return ก่อน cache population (unreachable cache); metric/status บาง route ยังอ่าน raw conversations ทั้งที่ ticket owner คือ status_conversation; order/tracking lookup ถอด shop filter เมื่อ scoped miss; TestChatClient มี workflow/trigger orchestration ซ้ำ; canonical UNLIST sibling exception ยังไม่มี owner เดียว
- **Disposition**: keep availability resolver + unit/live join + evidence/OCR/history + workflow/assignment/botworker primitives; migrate legacy/trigger/selection/guards ไป owner เดียว; remove v2/v3 พร้อม callers/config/UI/tests ไม่ใช่ comment; แผนแรกที่เสนอ = state axes + typed handoff command/result ก่อน retrieval redesign

### 2026-10-09 — Rebaseline Phase 2 plan revision (กำลังทำ, docs-only)
- **การตัดสินใจของผู้ใช้**: แก้แผนเดิม `2026-09-30-legacy-shopee-unified-turn-evidence-retrieval-rebaseline-plan.md` ในที่เดิม ไม่สร้างแผนคู่ขนาน; สิ่งที่พิสูจน์แล้วและดีกว่าให้เก็บ
- **ขอบเขต revision**: freeze Phase 2A เป็น evidence baseline; แก้ Phase 2B ให้ครอบ state axes + claim episode + verified handoff command/result + explicit admin-side claim outcome; แก้ Phase 2C ให้ TurnPlan multi-need มาก่อน authoritative subject set
- **หลัก complexity**: migrate+delete ใน commit เดียว, ห้าม keyword/flag/shim/owner ใหม่แบบค้างคู่, v2/v3 frozen for deletion ไม่รับ semantic fix, botworker paused และอยู่นอก scope
- **ข้อห้ามรอบนี้**: docs/plan only; ไม่แก้ runtime/tests/config, ไม่เปิด worker, ไม่เรียก provider/Mongo, ไม่อ่าน `.env`, ไม่ stage/commit/push/deploy

### 2026-10-09 — Rebaseline Phase 2 plan revision (เสร็จ รอ review)
- **แก้ไฟล์เดิม ไม่สร้าง plan ใหม่**: `docs/plans/2026-09-30-legacy-shopee-unified-turn-evidence-retrieval-rebaseline-plan.md` เป็น roadmap หลักต่อ; link spec ไป architecture audit 2026-10-09
- **Phase 1/2A**: Phase 1 ระบุใหม่ให้ตรงของจริงว่า pure one-action shadow baseline เท่านั้น; Phase 2A freeze/accepted ที่ commit `37f6d30`, ห้ามเพิ่ม tests แทนการ implement
- **Phase 2B revision**: 7 replacement commits — ownership transport จาก `status_conversation`; typed `assigned|queued|failed` handoff; Python result boundary; episode-aware claim lifecycle; ticket-close ไม่ clear claim; explicit admin `resolved|cancelled` claim outcome แยกจาก close/resolve conversation; residual deletion gate
- **Phase 2C revision**: evolve `turn_decision.py` in place เป็น `TurnPlan.needs[]`; persisted `ConversationSubjectSet`; migrate compare/price/link/compat แล้วลบ app-local owner blocks; ห้าม `turn_policy.py`/subject module คู่ขนาน
- **เก็บของดี**: availability/unit live join/evidence/OCR/history/workflow/assignment/botworker primitives; v2/v3 frozen for deletion; botworker paused/out of scope
- **Complexity gates**: semantic keyword/rollout flag/long-lived shim ใหม่ = 0 ใน 2B/2C; owner count ต้องลด; migrated branch ลบ commit เดียว; refactor-only runtime net LOC <= 0
- **Self-review corrections**: production ticket state pin ไป `status_conversation`; `queued` ต้อง persist `status=pending` และหยุด bot; failed ห้ามทิ้ง transient reopen; production claim metadata ย้ายออกจาก raw conversations; claim outcome ใช้ dedicated API/UI action ไม่ reuse close/resolve; `.env*` ห้ามอ่านใน plan
- **Verification**: docs-only `git diff --check` clean; runtime/tests/config diff จากรอบนี้ = 0; worker/provider/Mongo = 0; ไม่มี stage/commit/push/deploy; unrelated leftovers ไม่แตะ
- **Next gate**: รอ user review revision นี้; ถ้าอนุมัติ เริ่ม Phase 2B.1 ด้วย RED tests ก่อน implementation

### 2026-10-09 — Rebaseline accepted + 2026-10-16 delivery checkpoint
- **User decision**: รับ revised roadmap และผลลัพธ์ปลายทางที่รักษา anchor item, follow-up, history, `units.py`, live availability และ image/OCR/cert evidence; อนุมัติให้เริ่ม implementation ตามลำดับเดิม ไม่สร้าง roadmap คู่ขนาน
- **Deadline**: เป้าหมาย 2026-10-16 = legacy Shopee core review/PR-ready ไม่ใช่ production deploy และไม่รวม Lazada/TikTok runtime, workflow-editor UX, KPI/rating redesign, botworker production canary หรือ production observation
- **Definition of done**: Phase 2B state/handoff/claim truth + Phase 2C multi-need/subject continuity + one migrated candidate-pool/selection path; comparison/compat/stock/cert/warranty/troubleshooting/handoff ผ่าน `chat()` evidence; รายงาน quality/calls/latency/tokens/cost/owner count/direct writers/LOC; migrated legacy/shadow owner ลบใน commit เดียว
- **Schedule**: 10 ต.ค. 2B.1-2B.3 · 11 ต.ค. 2B.4-2B.6 · 12 ต.ค. 2B.7+2C.1 · 13 ต.ค. 2C.2-2C.3 · 14 ต.ค. retrieval ownership · 15 ต.ค. quality/performance replay · 16 ต.ค. full regression/deletion audit/docs/PR readiness
- **Safety/complexity gate**: RED-first; runtime phase ทำทีละ phase; semantic keyword/rollout flag/long-lived shim ใหม่ = 0; ห้าม helper/guard อุด incident; Critical/High จาก replay ต้องรายงาน blocker แทนการประกาศเสร็จ; botworker ยัง paused และห้ามเปิด/รัน
- **Next action**: Phase 2B.1 authoritative ownership transport — audit current caller/tests, เขียน RED disagreement/missing-state tests ก่อนแตะ runtime; ห้าม provider/Mongo/worker/`.env`; ยังไม่ stage/commit จน review implementation รอบแรก

### 2026-10-12 — Phase 2B.1A census gate closed + Phase 2B.1 started (กำลังทำ)
- **Census verdict**: `diag_admin_collections.py` (read-only, user-run) → `conversations_shp` 150,396 docs, `assigned_to!=null ∨ closed_at` = **0 rows**, distinct status = `["open"]` เท่านั้น, field census ไม่มี ownership field อื่น; `status_conversation`=2 docs; assignment collections ว่าง — verdict `BACKFILL_NOT_APPLICABLE_CENSUS_COMPLETE`, migration apply = forbidden/no-op (ไม่มี raw evidence ให้กู้ และถ้าเคยมีก็ถูก dump ทับไปแล้ว)
- **User direction**: census อนุมัติข้าม apply ได้ แต่ไม่อนุมัติ transport switch — ต้องทำ writer/reader contract tests ก่อน
- **Phase 2B.1 scope ที่รับ**: `resolveTicketState` production → `status_conversation` เท่านั้น; meta-only readers (list map/filter, send conflict, assign fallback, [id] GET, team workload, workflowEngine assignee, autoAssign/reassign, shadow-inbox); missing meta → `ticket_state="bot"` (explicit unlocked — Python `_ACTIVE_TICKET_STATES={handoff,open,pending}` lock set); read error → fail closed ไม่เรียก Python
- **Python boundary (audit)**: `turn_decision._ticket_active` lock = `{handoff,open,pending}`; "bot"/closed/resolved → unlock; `None` → history-scan fallback (ต้องส่ง "bot" explicit ห้าม omit)
- **Safety**: ไม่มี Mongo จริง/.env/provider/worker; ไม่ stage/commit; TDD RED-first จาก fake mongo suite เดิม

### 2026-10-12 — Phase 2B.1 authoritative ownership transport (เสร็จ รอ review)
- **RED→GREEN**: `scripts/test-ownership-transport.ts` (ใหม่ — A transport ×11 / B writer ×15 / C reader ×11) เริ่ม 14/35 RED → **37/37 GREEN**; RED ตรง defect จริงทุกจุด (ไม่มี test typo)
- **Transport**: `resolveTicketState` prod branch → `COLLECTIONS.statusConversation`; missing meta → `"bot"` explicit (Python `None` = history-scan fallback ห้าม omit), meta ไม่มี status → `"bot"`, read error → throw fail-closed (fetch ไม่ถูกเรียก), ไม่มี conversationId → ไม่ query
- **Readers → meta-only**: `admin/conversations` list/mapToConversation/getAssignedConversationIds/status-filter/auto-reopen, `[id]` GET (status+assigned_to จาก meta; raw display เท่านั้น), `send` conflict guard (`meta.assigned_to`), `assign` route previous-owner, `team` workload counts (assigned/closedResolved/unassignedHandoff จาก meta; `total` = thread inventory เดิม), `shadow-inbox`/`botworker` conv map (`meta?.closed_at`), `workflowEngine` conditions conversation_status+assignee (prod), `autoAssignConversation` early-exit, `reassignConversation` `from_admin_id`
- **Writer fix เจอระหว่างทาง**: `workflowEngine` `assign_ticket` direct-assign (prod) เคยเขียน `conversations.assigned_to` ดิบ (dump ทับได้ — ไม่มี authority) → เปลี่ยนเป็น `statusConversationService.manualAssign` CAS เหมือน testSource branch (direct assign = transfer semantics: expected previous = owner ปัจจุบัน)
- **CAS contract**: `manualAssign`/`tryAssign` catch E11000 (unique `conversation_id` index + upsert ชน race) → return `false` ไม่ throw — เจอจาก fake mongo unique-index modeling
- **Harness (test-only)**: fakemongo +aggregate ($match/$group accumulators), ObjectId/Date equality, uniqueKeys E11000, eager onQuery ของ aggregate (M-INT instrumentation contract — attempt นับแม้ cursor ไม่ถูก consume)
- **Verify จริง**: tsc clean · `npm run build` clean (84/84) · `git diff --check` clean · suites: idempotency 71/71, production-races 37/37, recovery-freshness 59/59, boundary 20/20, error-policy 38/38, runtime-mongo-safety 110/110, config-failclosed 4/4, enable-checkpoint 18/18, ownership-backfill 46/46
- **เจตนาเดิมรักษา**: claim lifecycle ไม่แตะ (close ≠ claim resolved); round-robin CAS/assignment config ไม่เปลี่ยน; ไม่มี keyword/helper/module/flag ใหม่; raw `conversations` เหลือเฉพาะ display/thread inventory; `findOrCreateConversation` dedup ใช้ raw status โดยตั้งใจ (thread identity ไม่ใช่ ownership)
- **Safety**: ไม่มี Mongo จริง/.env/provider/LLM/`/chat` จริง/worker; ไม่ stage/commit/push/deploy; llm.py + diag-worker-dup* เป็น dirty เดิมไม่แตะ

### 2026-10-12 — Phase 2B.1 Review Fix (2 High + 1 Medium) (เสร็จ รอ review)
- **RED→GREEN**: ต่อ `test-ownership-transport.ts` เพิ่ม 16 tests → 14/53 RED ตรง defect จริง → **53/53 GREEN**
- **F1 (High) — explicit owner clear**: `updateStatus(convId, status, assignedTo?: string|null)` — `undefined`=คง owner, `null`=ล้าง `assigned_to`+`assigned_at` (audit `close_history`/`admin_logs` อยู่ครบ), `string`=ตั้ง owner+`assigned_at`; `reassignConversation` ส่ง `newAgentId` ตรง (เคย `|| undefined` → unassign หาย), list auto-reopen ส่ง `null` (เคย `undefined` → persist owner ค้าง), `updateConversationStatus` widened pass-through — ไม่มี helper ใหม่
- **F2 (High) — status filter บน meta**: `/api/admin/conversations?status=` เคยส่ง status เข้า raw filter (`conversations_shp.status`="open" หมด → match ผิด + total_count ผิด) → prefetch ids จาก `status_conversation`: `bot`=exclude meta status อื่น (missing/no-status meta=bot), อื่นๆ=include `{status}` ids; intersect `assigned_to` include-set / union exclude-set **ก่อน** limit+cursor; `include_count` ใช้ constraints ชุดเดียวกัน
- **F3 (Medium) — canonical metric partition**: active=`{handoff,open,pending}`+owner, awaiting=`{handoff,pending}`+no owner, closed=`{closed,resolved}` (retained `assigned_to`=history ไม่ใช่ active), bot=missing/no-status/`bot` — `/api/team` (workload agg + realCounts เลิกหัก assigned/closed ซ้อน), `/api/stats/live` (เขียน ownership ใหม่ทั้งหมดบน meta id-sets ∩ range), `/api/stats/dashboard`
- **Audit เจอเพิ่ม+แก้**: `stats/admin-activity` (raw assigned_to/status/closed_at ทั้ง route → meta-driven JS partition), `stats/performance` (3 raw reads → meta id-sets); หลังแก้ production ownership readers บน `conversations` = **0** — raw เหลือเฉพาะ inventory/display/time-bucket (`unread_count`, `last_message_*`, `created_at`, thread identity) + test-domain collections
- **Harness (test-only)**: fakemongo +accumulators (`$max/$min/$push/$first/$last`), +stages (`$sort/$limit/$skip/$project`), shared `sortDocs`
- **Verify จริง**: suite 53/53 · error-policy 38/38 · idempotency 71/71 · production-races 37/37 · recovery-freshness 59/59 · boundary 20/20 · runtime-mongo-safety 110/110 · config-failclosed 4/4 · enable-checkpoint 18/18 · ownership-backfill 46/46 · `tsc` clean · build 84/84 · `git diff --check` clean
- **Safety**: ไม่มี Mongo จริง/.env/provider/LLM/worker; ไม่ stage/commit/push/deploy; `llm.py`+diag-worker-dup* dirty เดิมไม่แตะ; Phase 2B.2 typed handoff outcome ยัง out of scope

### 2026-10-12 — Phase 2B.1 Review Fix Round 2 (กำลังทำ)
- **รับงาน**: ปิด 2 High + 2 Medium — response rate >100%, status filter ขัด auto-reopen, ownership partition ไม่ exhaustive (open+no owner), unbounded meta scans/ID arrays; ห้าม guard/clamp/flow ซ้ำ, ห้าม stage/commit
- **Root-cause map (audit เสร็จ)**:
  - `computeResponseStats` numerator = reply **messages** ทุกฉบับ (3 replies ในแชทเดียว → numerator 3) ส่วน route หารด้วยจำนวน conversation → ได้ 300%; measurement unit ที่ถูก = **customer turn** (รัน user msgs ต่อเนื่อง → first qualifying out msg)
  - auto-reopen: **ไม่มี inbound ingestion owner ใน codebase** (messages_shp/conversations_shp ถูก external dump เขียน — botWorkerService comment ยืนยัน read-only; botworker เป็น optional poller ที่อาจปิดอยู่ — auto-reopen ใน GET มีอยู่เพื่อ /tickets ไม่พึ่ง worker) → ย้ายไป ingest ไม่ได้; fix ที่ owner เดิม = hoist transition ก่อน status-ID prefetch ให้ filter/count/cache เห็น post-transition state (ไม่ใช่ post-filter guard)
  - partition: awaiting ต้องเป็น `{handoff,open,pending}`+no owner (open+no-owner ยัง lock bot ตาม transport) — team ใช้ `{h,p}` อยู่
  - query shape: stats routes โหลด `statusColl.find({}).toArray()` ทั้ง collection + ยิง `$in` array โตตาม meta — แก้เป็น meta-driven `$lookup` aggregation (meta→conv บน unique conversation_id index, range filter ใน pipeline) ไม่มี JS id arrays
- **ผ่านแล้ว (Round 2, 2026-10-12):**
  - G response rate: `computeResponseStats` เดิมนับ reply ทุกข้อความ÷จำนวน conv → 150-300%; แก้เป็น customer-turn walk (user-run→first qualifying reply) numerator/denominator population เดียวกัน → 1 turn 3 replies = 1 answered; 2 turns ตอบ 1 = 50%; avg=first response เท่านั้น; perAdmin ตาม actor; performance=adminOnly ตาม UI footnote; admin-activity rate=admin turns เดียวกัน
  - H auto-reopen: เดิม transition post-fetch → ?status=closed คืน row ที่เพิ่ง reopen + total_count/cache เก่า + ?status=bot หาไม่เจอ; ไม่มี ingest owner ใน codebase (external dump เขียน messages_shp) → hoist transition ก่อน cache check+prefetch ใน route เดิม ผ่าน meta→conv $lookup (status idx→unique conv_id idx) + invalidate cache เมื่อเขียน; repeat GET idempotent
  - J partition: awaiting={h,o,p}+no-owner ทุก endpoint (open+no-owner=awaiting ไม่ใช่ bot — team unassignedHandoff + live open_unassigned เดิมรวม bot ผิด); admin-activity unanswered +open, resolved +closed/bot (closed+owner=history เดิมหาย)
  - J bounded: stats routes เปลี่ยน statusColl.find({}).toArray()+$in arrays → meta-driven $lookup aggs (status/assigned_to idx → unique conv_id idx → conv-side range match → group/count) + subtract pattern สำหรับ unanswered/per-shop; listConversations ลบ dead opts.status
  - fakemongo: +$lookup/$unwind/$count, composite _id group keys, pipeline→onQuery
  - RED 18 → GREEN 74/74; สำรอง suites: error-policy 38, idempotency 71, races 37, recovery 59, boundary 20, mongo-safety 110, config 4, enable 18, backfill 46; tsc/build/diff-check clean; ยังไม่ commit ตามคำสั่ง

### 2026-10-12 — Phase 2B.1 Closure + Deletion Gate (กำลังทำ)
- **รับงาน**: ปิด correctness gaps (response-time boundary, lifecycle write ใน list GET, unbounded status filter) + deletion gate (backfill tooling, dead exports, comment slimming) → runtime net ≤0 vs HEAD; RED-first, ห้าม stage/commit
- **Baseline**: branch feature-legacy-shopee-evidence-retrieval @ 04f0e10 · suite 74/74 (J6 เคย flake เพราะ seed created_at ชน ms เดียวกับ route weekEnd exclusive $lt — แก้ seed เป็น now-5s) · src numstat net +95 · fakemongo +109
- **Deletion inventory (audit เสร็จ)**:
  - KEEP: statusConversationService (meta authority), conversationService.{getConversation,closeConversation,reopenConversation,updateConversationStatus,touchLastMessage}, stats routes, ownership suite
  - REPLACE: computeResponseStats (boundary attribution — fetch ≥start, turn นับเมื่อ turn_ts∈[start,end)), list GET (conv-driven $lookup pipeline, read-only)
  - DELETE: backfill-legacy-ownership.ts(379)+test-ownership-backfill*(948)+diag_admin_collections.py(122) — census ปิด invariant แล้ว; listConversations(sole caller=route), createConversation/findOrCreateConversation(genConversationId, 0 prod callers — B8 test pin เท่านั้น), wrappers setConversationTopic/setConversationItemIds/togglePinned/resetUnread (0 callers), getAssignedConversationIds, auto-reopen block ใน GET
  - BLOCKED: closed→bot auto-reopen on inbound — audit ยืนยัน ไม่มี production inbound owner ใน repo (external dump เขียน messages_shp; botWorkerService เขียน test_status_conversation sandbox เท่านั้นโดย design; botCallService เป็น reader; bot-handoff=handoff callback ไม่ใช่ per-inbound) → BLOCKED_BY_MISSING_INBOUND_LIFECYCLE_OWNER
- **Boundary truth table (computeResponseStats, owner เดียว)**:
  - turn เข้า period เมื่อ turn_ts (user msg สุดท้ายของ run) ∈ [start,end) — fetch msgs `>= start` (forward ถึง data end; bounded โดย now ไม่ใช่ history ย้อนหลัง)
  - user msg ใหม่หลัง end ต่อ run เดิม → turn_ts ขยับ → turn ไป period ถัดไป (reply ไม่ปิด turn ใน period นี้, ไม่มี double count)
  - reply หลัง end ปิด turn ได้ปกติ (resolved state ไม่มีขอบเขตเวลา)
  - turn ก่อน start + reply ใน range → out msg กระพริบเดี่ยวไม่มี run → ไม่นับ
  - avg/within10/perAdmin ใช้ population เดียวกัน (turns attributed to period)
- **Plan**: RED (K=boundary, L=read-only list, M=pipeline filter) → fix responseStats → ลบ lifecycle block+prefetch → pipeline list → ลบ tooling/dead exports/comment slim → complexity gate → battery
- **ผ่านแล้ว (Closure+Deletion, 2026-10-13):**
  - RED 12 honest fails (K1-3,K5-7 boundary + L1-4 read-only + M1 census + F1-5 premise) → GREEN 82/82
  - K boundary: `computeResponseStats` เดิม fetch แค่ [start,end) ทั้ง user+reply → user 23:59+reply 00:01 นับ unanswered; แก้ fetch `>=start` (bounded by now) turn_ts attribution; reply ข้าม end ปิด turn ได้, user ใหม่ต่อ run → turn ย้าย period; route parity K7 ผ่าน owner เดียว
  - L read-only list GET: ลบ auto-reopen block+prefetch ออกทั้งหมด (owner audit→ไม่มี production inbound owner ใน repo → ห้ามประดิษฐ์ owner); 2×GET=0 writes/0 meta query, cache-hit=0 DB; source pin L1
  - M pipeline: list route เปลี่ยน meta census→`conversation_id.$in` arrays เป็น conv-driven `$lookup`+`$unwind`+meta `$match` ใน pipeline เดียวกับ rows/count (rows=count predicate เดียวกัน); no-meta-filter path join หลัง limit (page-scoped); 3-page cursor parity M2 ผ่าน
  - Deletion: backfill tooling+tests+diag_admin_collections.py = **1,449 LOC ลบ** (census `BACKFILL_NOT_APPLICABLE_CENSUS_COMPLETE` บันทึก roadmap L816-825); dead exports conversationService (genConversationId/createConversation/findOrCreate/listConversations/4 wrappers = 172 LOC) + statusConversationService (setTopic/setItemIds/togglePinned/resetUnread 40 LOC — caller มีเฉพาะ dead wrappers+test); B8 ลบ (รองรับ dead fn เท่านั้น), B7 repoint→setPendingAssignment; generate-all-shadow.ts เปลี่ยนเป็น direct collection find; phase-history comments ตัด 20 จุด (เก็บ contract text)
  - fakemongo: เพิ่ม ops 0 (net +109 = baseline — ทุก op มี production caller ใน 5 routes ที่แชร์ suite, เก็บไว้ตาม shortest-path)
  - Complexity: src numstat net **−202** vs HEAD (+605/−807) ≤0 ✅
  - Verify: transport 82, error-policy 38, idempotency 71, races 37, recovery 59, boundary 20, mongo-safety 110, config 4, enable 18; tsc/build(84)/diff-check clean; backfill suite ไม่รัน (tooling ลบแล้ว — invariant ปิดด้วย census)
  - ยังไม่ commit ตามคำสั่ง; verdict BLOCKED_BY_MISSING_INBOUND_LIFECYCLE_OWNER (auto-reopen closed→bot ยังไม่มี owner — integration point เสนอ: external dump writer หรือ dedicated inbound poller ใน phase แยก)

### 2026-10-13 — Phase 2B.1 Review Correction (กำลังทำ)
- **รับงาน**: fix channel authz+pagination, query scalability (status/assigned ไม่ full-join), lifecycle owner audit ซ้ำ, response-time bounded query, generate-all-shadow dedup; net ≤0; RED-first; ห้าม stage/commit
- **Baseline**: 04f0e10 · suite 82/82 · src net −202 · tsc/diff-check clean
- **Part 1 audit (re-verify, schema.md L79/L1617-1618 + code)**: `messages_shp`/`conversations_shp` inbound (`role=user,direction=in`) **เขียนโดย Sellcenter dump เท่านั้น — external process นอก repo, sync ~ทุก 2 นาที**; ใน repo: Python app.py เขียนแค่ conversation_products/test_chat_*; messageService เขียนเฉพาะ out-msgs (admin send); botWorkerService เขียน chatProcessing/shadowReplies/botworkerState/botworker_messages + image_desc cache เท่านั้น → **BLOCKED_BY_EXTERNAL_INBOUND_WRITER**; integration contract ที่ต้องเพิ่ม: dump writer post-write hook CAS `status_conversation {status:bot, assigned_to:null}` เมื่อ meta closed + inbound ts>closed_at, หรือ inbound webhook → admin app (phase แยก — ห้าม poller/GET side-effect)
- **Plan**: RED N (channel authz) + O (query shape) + P (response boundary probes) → fold channels_access เข้า baseMatch → meta-driven join ทิศ meta→conv สำหรับ status/assigned filter → responseStats bounded per-open-conv probe → generate-all-shadow single-client → battery
- **ผ่านแล้ว (Review Correction, 2026-10-13):**
  - RED 10 honest fails (N1-3 channel post-limit/starved count + O1/O2/O5/O6 conv-first full join + P1/P3/P5 unbounded `>=start` fetch) → GREEN **98/98**
  - N channel authz: เดิม JS filter หลัง $limit → unauthorized rows กิน limit/count/cursor + `channels_access=[]` รั่วทุก channel; แก้ fold `{platform:{$in:access}}` ลง match เดียวกันทั้ง rows/count/cursor (privileged/[] = unrestricted เดิม); platform ที่ขอแต่ไม่มีสิทธิ์ → `$in:[]` (0 rows); N3 เจอ hasMore `docs.length===limit` false-positive บน exact-multiple → fetch limit+1 slice; cacheKey เดิมขาด me+channels (cross-admin leak สำหรับ assigned_to=me/authorized pop) → เพิ่มทั้งคู่
  - O query shape: meta-bound filters (human status/assigned=me|<id>) → aggregate จาก `status_conversation` (indexed status/assigned_to $match) → `$lookup` conv → conv-side match → sort/limit; missing-meta filters (bot/unassigned) คง conv-first anti-join (missing meta อยู่นอก meta coll ทำ meta-first ไม่ได้โดย schema); default = conv sort/limit→page-scoped join เดิม; rows/count predicate เดียวกัน
  - Real-Mongo explain (disposable mongo:7 loopback, 150,396 convs + 2,000 meta, production index set, container --rm cleaned): default+channel IXSCAN(sort-idx) docs=101 n=51 ~2ms · assigned_to IXSCAN(assigned_to_1) docs=667 ~16ms · status=handoff+channel docs=667 ~15ms · count(handoff) docs=667 — เทียบ conv-first เดิม status=handoff docs=75,198 ~1,389ms (~113×); status=bot anti-join docs=75,198 ~1,259ms = structural (missing-meta ต้องแทนได้ → bounded เมื่อ meta complete ที่ ingress = external writer เดียวกับ Part 1 blocker)
  - P responseStats: เดิม fetch `>=start` ไม่มี upper bound อ่านถึงปัจจุบันทุกครั้ง; แก้ fetch เฉพาะ [start,end) + open-run resolution ด้วย per-conv probe (first post-end user/reply ผ่าน `$min`/`$first` aggregate — conv ที่ค้างเท่านั้น); user หลัง end ก่อน reply → run ต่อ → turn ย้าย period (ไม่นับ); reply ก่อน/ไม่มี user → ปิด turn; historical end เดือนก่อนอ่าน bounded; adminOnly probe role=admin
  - Part 5: generate-all-shadow `withAdminDb` เปิด MongoClient ทุก call → client เดียวใน main + finally ปิดทุก path (รวม dry-run early return); fakemongo audit: ทุก op มี production caller จริง ($elemMatch ไม่มีใน engine เลย)
  - Verify: transport 98/98 · error-policy 38 · idempotency 71 · races 37 · recovery 59 · boundary 20 · mongo-safety 110 · config 4 · enable 18 · tsc/build(84)/diff-check clean · src net −116 (≤0)
  - Verdict: **BLOCKED_BY_EXTERNAL_INBOUND_WRITER** — correctness+scalability+response-bounds ปิดครบ แต่ `closed→bot` on inbound ต้องการ writer ใน Sellcenter dump (นอก repo) — integration contract: post-write hook CAS `status_conversation{status:bot,assigned_to:null}` เมื่อ meta.status∈{closed,resolved} + inbound.created_timestamp>closed_at, idempotent key=conversation_id+inbound_ts; ห้าม poller/GET side-effect ตามคำสั่ง
  - ยังไม่ stage/commit/push ตามคำสั่ง

### 2026-10-13 — Phase 2B.1 Final Review Fix (กำลังทำ)
- **รับงาน**: จัดการ reviewer findings 2 High + 2 Medium — R1-R5 probes บน responseStats post-end probe (unbounded $in + unbounded time — ห้ามแก้จนกว่า business เลือก Option A/B/C), generate-all-shadow ใช้ singleton getDb แทน direct MongoClient, แยก scalability claims ตาม path, test-honesty (P1-5 + K disputed semantics → probe naming); verdict ต้องคง BLOCKED_*
- **Baseline**: 04f0e10 · suite 98/98 · tsc/diff-check clean · src net −116
- **UI poll audit (Part 3)**: useSharedConversations poll 3s ด้วย filter ที่ page mount — tickets = `assigned_to`(me/all/<id>) เท่านั้น ไม่มี status param; replay-compare/test-assignment/shadow-inbox = `assigned_to:"all"` → **ไม่มี UI page ใด poll `status=bot`/`unassigned`** — anti-join ~75k ใช้ได้เฉพาะ direct API call (ยังเป็น blocked path แต่ไม่ใช่ hot path ของ poller)
- **Plan**: R1-R5 probes (assert facts, ชื่อ probe) → P1-5 + K post-end semantics เปลี่ยนเป็น probe naming → Part 2 single-owner getDb + RED source pins → report options A/B/C
- **ผ่านแล้ว (Final Review Fix, 2026-10-13):**
  - Probes R1-R5 (assert observed facts — ไม่ใช่ approved contract): R1 probe `$in` = openRuns population (n=7/7, closed turn excluded) — cardinality ไม่มีขอบ; R2 probe `$match` = `$gte:end` ไม่มี `$lt/$lte` — scan [end,∞); R3 same period re-report: reply post-end → answered 0→1, user+reply post-end → totalTurns 2→1 (report ไม่ frozen); R4 equal-ts post-end user+reply → impl `<` strict ให้ reply ชนะ (answered=1) ขัด in-range tie-break (user ก่อน); R5 adminOnly bot→user→admin post-end → original turn ย้าย period (total=0)
  - **ไม่แก้ responseStats.ts** — post-end resolution semantics รอ business decision: Option A (frozen at end — ไม่ต้อง probe เลย, report นิ่ง, turn ค้าง unanswered ถาวร) / B (grace window — reply ภายใน window ปิด turn, ต้องมีค่าที่ user approve, probe bounded $lt) / C (open-ended — สิ่งที่ impl ทำอยู่, report เปลี่ยนย้อนหลัง, query cost ตามที่ probe วัด) → **BLOCKED_BY_RESPONSE_METRIC_BOUNDARY_DECISION**
  - Q1-Q5 source pins (RED: Q1/Q2 fail บน direct MongoClient) → generate-all-shadow ใช้ `getDb()` singleton เดียวกับ listMessages/shadowReplyService; ปิด `db.client.close()` ใน finally ทุก path; close error catch แยกไม่ mask op error + exitCode=1 เมื่อ fail เดี่ยว; Q3-Q5 pass (cleanup/exit contract)
  - Scalability claims แยกตาม path ใน SRS: default+assigned = indexed/page-scoped; bot/unassigned = unbounded anti-join ~75k/request (blocked); UI poll audit = ไม่มี page ใด poll bot/unassigned (tickets=assigned_to เท่านั้น, อื่น=all)
  - Test-honesty: K1-3/K5-7 + P1-5 renamed `probe-*` (encode disputed post-end semantics — ไม่ใช่ approved contract); K4 คง contract (pre-start exclusion ไม่เกี่ยว post-end)
  - Verify: transport **108/108** · error-policy 38 · idempotency 71 · races 37 · recovery 59 · boundary 20 · mongo-safety 110 · config 4 · enable 18 · tsc/build(84)/diff-check clean · src net −116 (ไม่เปลี่ยน — ไม่มี src edit รอบนี้) · direct MongoClient ใน script = 0
  - Verdict: **BLOCKED_BY_RESPONSE_METRIC_DECISION_AND_EXTERNAL_INBOUND_WRITER**
  - ยังไม่ stage/commit/push ตามคำสั่ง

### 2026-10-13 — Phase 2B.1 Response Metric Contract Impl (Option B — กำลังทำ)
- **รับงาน**: user อนุมัติ Option B — bounded grace window 24h; แทน open-ended post-end resolution, T1-T13 contract tests แทน probes, 21-requirement traceability, คง lifecycle blocker; ห้าม commit/deploy
- **Baseline**: 04f0e10 · suite 108/108 · tsc/diff-check clean · src net −116
- **RED (7 honest failures)**: T3/T4 reply ≥ graceEnd ยังปิด turn · T6 user ≥ graceEnd ย้าย turn · T7 equal-ts reply ชนะ (impl `<` strict) · T9 report ไม่ freeze · T10 probe ไม่มี `$lt` · T11 ไม่มี batching/$in=openRuns
- **แก้ (responseStats.ts)**: `RESPONSE_ATTRIBUTION_GRACE_MS=24h` + `RESPONSE_PROBE_BATCH_SIZE=500` (policy owner เดียวในไฟล์); initial fetch คง [start,end); post-end probe = batched `$in`(≤500) + `$gte:end,$lt:graceEnd`; tie-break user-wins เทียบผ่าน sort order เดียวกับ in-range; ไม่มี events ≥ graceEnd ถูกอ่าน → report freeze; adminOnly/bot exclusion/pre-start/first-reply/denominator คงเดิม; public return type เดิม; ไม่มี env/flag/module/index/dependency ใหม่
- **GREEN**: ownership transport 108/108 — T1-T13 ผ่าน (probe-K/P/R ลบ/เปลี่ยนเป็น contract; ไม่เก็บ probe ซ้ำเรื่องเดียวกัน)
- **Real-Mongo explain** (query shape เปลี่ยน → ต้อง prove): disposable mongo:7 loopback, seed 100k msgs, index `{conversation_id:1,created_timestamp:1}`; batch probe `docs=1000 keys=1999 n=500 ms=4` — IXSCAN เสิร์ฟ 500-conv batch; container+script cleanup ครบ
- **เหลือ**: SRS/roadmap/active-log docs, full verification battery, LOC accounting, final report
- **ผ่านแล้ว (Option B impl, 2026-10-13):**
  - Docs: SRS_SSD §response-rate metrics อัปเดตเป็น grace contract (24h, batch 500, freeze, tie user-wins); responseStats header/JSDoc ตรง implementation; roadmap +21-row Master Requirement Traceability (req→owner→action→phase→evidence→status)
  - Traceability 21/21: #14 handoff reopen blocked โดย external inbound writer; #3 in_progress (−99 vs HEAD); #12 verified (response metric); ที่เหลือ not_started/in_progress ตาม phase map
  - Full verify: transport 108/108 · error-policy 38 · idempotency 71 · races 37 · recovery 59 · boundary 20 · mongo-safety 110 · config 4 · enable 18 · tsc clean · build 84/84 · diff-check clean
  - src net vs HEAD = −99 (เพิ่มจาก −116: +17 net ใน responseStats.ts = batch loop + grace bounds + 2 exported policy constants — justify: approved contract implementation)
  - Test consolidation: probe-P1-P5 + probe-R1-R5 ลบ (covered โดย T3/T4/T6/T7/T9/T10/T11), K probes → contract tests, file = 1,683 บรรทัด (pre-round ≈1,690 — reconstructed จาก edit offsets, file untracked ไม่มี snapshot)
  - Query after: probe = `$match{conv_id:{$in:≤500},created_timestamp:{$gte:end,$lt:end+24h},role}` ×2 agg/batch; explain: docs=1000 keys=1999 n=500 ms=4 บน {conversation_id,created_timestamp} IXSCAN; queries = 2×⌈openRuns/500⌉ — ไม่ใช่ N+1
  - หลักฐานสะอาด: list GET writes=0 · provider/botworker/API=0 · prod Mongo=0 · env/flag/module/index/dep ใหม่=0
  - Verdict: **RESPONSE_METRIC_CONTRACT_CLOSED_EXTERNAL_INBOUND_OWNER_BLOCKED**
  - ยังไม่ stage/commit/push ตามคำสั่ง

### 2026-10-13 — Phase 2B.1 Pre-Commit Gate + Commit 1 (ผ่านแล้ว)
- Pre-commit gate: preflight ✓ · per-file audit 27 ไฟล์ครบ (ทุก hunk = ownership/meta-authority/metric contract — ไม่มี unrelated hunk) · fresh verify 9 suites ครบ + tsc + build 84/84 + diff-check · staged diff secret/forbidden scan ผ่าน (hit เดียว = `llm.py` path ใน traceability table — doc ref ไม่ใช่ไฟล์)
- Commit 1: `ad13494` `fix: centralize conversation ownership and bound response metrics` — 27 ไฟล์ +3,106/−944, runtime net −99; reviewer อนุมัติ ไม่ใส่ Devin/Co-authored trailer ตามธรรมเนียม
- ไม่ได้ stage: llm.py, diag-worker-dup*, quarantine/vision testscript, architecture-audit doc (leftovers ที่ถูกต้อง)
- งานโค้ด Phase 2B.1 ปิดใน commit นี้ — แต่ **ไม่ใช่ deploy-ready**: `BLOCKED_BY_EXTERNAL_INBOUND_WRITER` ยังต้องพิสูจน์ external sync/import จะไม่เขียน `open` ทับ authoritative status หลัง deploy (closed→bot transition ต้องอยู่ที่ Sellcenter inbound boundary, idempotent+atomic)
- Docs-only commit 2 (ไฟล์นี้) ตามมาแยกต่างหาก

#### Implementation Round (2026-10-13, runtime — ผ่านแล้ว)
- **เป้าหมาย**: 111/152 → GREEN ทั้งหมด · TDD ทีละ boundary · runtime diff จำกัด 4 ไฟล์+1 ใหม่
- **Plan**: ① logAdminEvent +eventId → deterministic `_id` "adminlog:event:"+sha256([action,conv,eventId])[:32] + metadata.message_id=eventId · E11000→findOne(_id) identity check (match=already-logged/else throw) · ไม่มี eventId = เดิมเป๊ะ ไม่เพิ่ม read ② recordReopen +messageId → pass eventId ให้ logAdminEvent (side-effect owner เดียว) ③ applyInboundOwnershipTransition: flat read-dispatch (missing→insertOne[E11000→re-read once] / no-status→init CAS / closed,resolved+fresh→fenced CAS+recordReopen / miss→reconcile re-read / bot+event_id match→settle / else→unchanged) ④ route POST /api/internal/inbound-lifecycle (adapter เท่านั้น) + middleware PUBLIC_API entry
- **ผ่านแล้ว (Runtime Impl, 2026-10-13):**
  - `adminLogService.logAdminEvent` +`eventId` (optional): deterministic `_id` + `metadata.message_id=eventId` · E11000→re-read `_id` identity-check (action+conv+message_id ตรง=already-logged ไม่ throw/ไม่ dup · ไม่ตรงหรือ non-E11000=throw) · legacy callers ไม่มี eventId = path เดิมเป๊ะ zero extra read — **W29–W36 GREEN**
  - `closeHistoryService.recordReopen` +`messageId` → ส่ง eventId ให้ logAdminEvent จุดเดียว (sole side-effect owner — statusConversationService ไม่เรียก logAdminEvent สำหรับ inbound path)
  - `statusConversationService.applyInboundOwnershipTransition` +`InboundOwnershipEvent`/`InboundTransitionOutcome` types +`inbound_reopen_event_id` field (ไม่มี index ใหม่): bounded read-dispatch — missing→insertOne{bot,null,updated_at} (E11000→re-read ครั้งเดียว dispatch observed · ยัง null→unchanged fail-closed) · no-status→init CAS `{conv,$or:[status:$exists:false,null]}`→bot+assigned_to:null รักษา metadata · closed|resolved→staleness pre-check (zero-write stale/equal)→fenced CAS `{conv,status:$in[closed,resolved],closed_at:$lt inboundAt}`→bot+clear residue+event_id→recordReopen→reopened · CAS miss→bounded re-read reconcile เฉพาะ bot+matching event_id→settle → unchanged · bot+match→settle→unchanged · อื่น→unchanged zero-write — **W2–W28 GREEN**
  - Route `src/app/api/internal/inbound-lifecycle/route.ts` (~50 LOC): x-internal-secret vs `serverConfig.chatbotInternalSecret` → validate (string/trim/non-empty/≤256, ISO-8601+tz ≤64) → delegate ครั้งเดียว → `200{ok,outcome}` / 401 / 422 / 500 generic (server-side log เท่านั้น ไม่ leak raw/secret) · zero Mongo import · middleware PUBLIC_API +1 entry — **W37–W50 GREEN**
  - Fix ระหว่างทาง: `StatusConversationDoc.status/closed_by` +`| null` (typing ให้ตรง storage จริง — init CAS filter `status:null` + `$set closed_by:null` ผ่าน typecheck)
  - **Verify: 155/155** (เพิ่ม W48–W50 overlong/no-tz/offset tests ตาม PART 6) · regression battery: error-policy 38 · idempotency 71 · races 37 · recovery 59 · boundary 20 · mongo-safety 110 · config 4 · enable 18 · `tsc --noEmit` ✓ · `npm run build` ✓ (route ขึ้น ƒ /api/internal/inbound-lifecycle) · `git diff --check` ✓
  - Docs: schema.md +`inbound_reopen_event_id`/writer row · SRS_SSD statusConversationService row +route blocker อัปเดต · roadmap +inbound-lifecycle subsection
  - **Verdict: `PHASE_2B1_RUNTIME_GREEN_EXTERNAL_HOOK_PENDING`** — in-repo receiver+owner เสร็จและพิสูจน์แล้ว · Sellcenter writer ต้อง POST หลัง persist (contract พร้อม) + topology/secret เป็น operator confirm · ยังไม่ stage/commit/push/deploy ตามคำสั่ง

#### Review-Fix Round สุดท้าย (2026-10-13 — กำลังทำ)
- **Findings**: M1 strict timestamp (`new Date` normalize 2026-02-30→Mar 2 — calendar-invalid date ถูกใช้ตัดสิน reopen) · M2 429 contract (middleware rate-limit 300/min ip:path ก่อน PUBLIC_API — external writer ต้องมี retry contract) · L3 docs accuracy (schema recordReopen callers + SRS fields ครบ 8)
- **Plan**: RED W51–W53 (invalid calendar/overflow → 422, leap-day pin → 200) → single `parseInboundTimestamp` helper (regex capture + Date.UTC reverse-compare — ไม่พึ่ง new Date อย่างเดียว) → docs 429/integration contract + schema callers → verify battery เดิม
- **ผ่านแล้ว (Review-Fix, 2026-10-13):**
  - RED evidence: W51 `2026-02-30T00:00:00Z` → route รับ (200, calls=1 — new Date normalize) ขณะ W52/W53 ผ่านอยู่แล้ว → root cause = regex+`new Date` ไม่ตรวจ calendar
  - Fix (root cause ตัวเดียว): `parseInboundTimestamp` ใน route — regex capture Y/Mo/D/H/Mi/S/frac/tz → ช่วงหลัก (month 1-12, hour≤23, min/sec≤59, off-hour≤23, off-min≤59) → `Date.UTC` re-compute + reverse-compare components บน instant (offMs-corrected) → ปฏิเสธ normalized dates · ไม่มี dep ใหม่ · helper parsing ตัวเดียว · **W51 GREEN**, suite **158/158** (+3: W51 invalid-day / W52 overflow clock+offset / W53 leap-day pin)
  - Docs: SRS route cell + strict-validate/`parseInboundTimestamp` note · SRS service row + Called-by/Calls/Side-effects/Error ครบ 8 ตาม AGENTS §1 · roadmap + External delivery contract (200=success เท่านั้น · 401/422=permanent no blind retry · 429/5xx/network=retryable same identity bounded backoff writer-owned · at-least-once ปลอดภัยผ่าน receiver idempotency · 300/min ไม่เคลมว่าพอ) · schema.md recordReopen Update row + applyInboundOwnershipTransition caller/messageId
  - Verify สด: ownership **158/158** · error-policy 38 · idempotency 71 · races 37 · recovery 59 · boundary 20 · mongo-safety 110 · config 4 · enable 18 · `tsc --noEmit` ✓ · `npm run build` ✓ · `git diff --check` ✓
  - Runtime delta รอบนี้: route.ts +~36/−11 เท่านั้น (parse helper — src diff 4 ไฟล์คงเดิม) · ไม่มี retry impl ใน receiver · route zero-Mongo delegate ครั้งเดียว · worker/provider/Mongo/.env = 0
  - **Verdict: `PHASE_2B1_RUNTIME_REVIEW_FIXED_EXTERNAL_HOOK_PENDING`** — external writer retry/topology ยังต้องพิสูจน์ก่อนลบ blocker · ยังไม่ stage/commit/push/deploy

#### Timestamp Precision Final Correction (2026-10-13 — กำลังทำ)
- **Finding (Medium จุดสุดท้าย)**: `Math.round(parseFloat("0."+F)*1000)` — `.999999` round→1000ms carry เป็นวินาทีถัดไป → reverse-check fail → reject timestamp ที่ควรรับ (Python ISO microsecond writer); `.1235`-class inputs ถูก round แทน truncate ทำให้ stored instant ≠ contract
- **Plan**: W54 RED (microsecond frac → truncate 3 หลัก, offset+frac ไม่ carry) → แก้ fracMs เดียวใน `parseInboundTimestamp` = `Number(F.slice(0,3).padEnd(3,"0"))` (truncate, ไม่ round, ไม่ carry) → docs canonicalization note → verify battery เดิม → คาด 159/159
- **ผ่านแล้ว (Precision Correction, 2026-10-13):**
  - RED evidence: W54 case-2 `2026-10-05T07:00:00.999999+07:00` → **422** (`Math.round(0.999999*1000)`=1000ms → carry เป็นวินาทีถัดไป → reverse-check second mismatch → reject timestamp ที่ควรรับ)
  - Fix (1 บรรทัด root cause): `fracMs = F ? Number(F.slice(0,3).padEnd(3,"0")) : 0` — truncate 3 หลัก ไม่ round ไม่ carry · comment ระบุ canonicalize→ms, sub-ms ไม่เก็บ · **159/159 GREEN** (W51–W53 คงเดิม)
  - Docs: SRS route cell + "fractional seconds truncate→ms (sub-ms ไม่เก็บ)" · roadmap contract + fractional-seconds canonicalization clause
  - Verify สด: ownership **159/159** · error-policy 38 · idempotency 71 · races 37 · recovery 59 · boundary 20 · mongo-safety 110 · config 4 · enable 18 · `tsc --noEmit` ✓ · `npm run build` ✓ (route ƒ) · `git diff --check` ✓
  - Complexity delta รอบนี้: route.ts **+4/−2** เท่านั้น · helpers/functions เพิ่ม **1** (`parseInboundTimestamp`) · runtime modules/files เพิ่ม **1** (`inbound-lifecycle/route.ts`) · dependencies/config/env/indexes/collections เพิ่ม = **0** · ไม่มี abstraction layer/parallel owner ใหม่ · route zero-Mongo delegate ครั้งเดียว · ไม่มี retry impl ใน receiver · worker/provider/Mongo/.env = 0
  - **Verdict: `PHASE_2B1_RUNTIME_FINAL_GREEN_EXTERNAL_HOOK_PENDING`** — external writer wiring ยังเป็น blocker เดิม · ยังไม่ stage/commit/push/deploy

#### Commit Closeout (2026-10-13 — ผ่านแล้ว)
- Commit 1: `d403f0a` `fix: add authoritative inbound ownership lifecycle` — 13 files +953/−10 (runtime +224/−5 · tests/harness +714/−1 · docs +15/−4)
- Commit 2: `e3e0b4d` `docs: record phase 2b.1 inbound lifecycle closeout` — log-only +83
- Complexity final: helpers/functions เพิ่ม 1 (`parseInboundTimestamp` local) · runtime modules/files เพิ่ม 1 (`inbound-lifecycle/route.ts`) · deps/config/env/indexes/collections เพิ่ม 0 · ownership owner 1→1 · ไม่มี abstraction layer/retry owner/guard family/parallel runtime path
- Leftovers ไม่ถูกแตะ: llm.py · diag-worker-dup×5 · quarantine/vision×3 · architecture-audit doc
- **Verdict: `PHASE_2B1_RUNTIME_COMMITTED_EXTERNAL_HOOK_PENDING`** — `BLOCKED_BY_EXTERNAL_WRITER_WIRING` ยังอยู่ · ไม่มี push/PR/deploy

#### External Writer Audit (2026-10-13 — กำลังทำ, read-only TIMEBOX)
- **Plan**: หา writer ตัวจริงที่ persist `messages_shp`/`conversations_shp` (role=user inbound) — sweep in-repo → sibling repos → topology → spec สิ่งที่ต้องขอจาก external owner
- **ผ่านแล้ว (Writer Audit, read-only):**
  - In-repo sweep: `messageService.addMessage` เขียน `messages_shp` แต่ caller เดียวคือ admin `/send` (role=admin, direction=out) · botWorkerService เขียน `shadow_replies` เท่านั้น (comment ชัด "ไม่เขียน messages_shp") · Python chatbot ไม่ resolve messages/conversations collections · `sync-shops.ts` อ่าน conversations_shp READ-ONLY เขียนเฉพาะ `shops` · bot-worker.ts = poll reader เท่านั้น → **ไม่มี in-repo inbound writer**
  - Sibling repos sweep (`ChatbotPythonbackend/Chatbot/ChatbotPPing/ChatBotPDigg/ChatBotPhase1/biokoop chatbot/dataclean*`): zero code hits สำหรับ `messages_shp|conversations_shp` — `ChatBotPDigg` เป็น unified-inbox clone เขียน DB ตัวเอง (`zaapi_clone` mongoose `messages`/`conversations`), อ่าน sellcenter Mongo แค่ tokens — **ไม่ใช่ writer ของ admin DB นี้**
  - Topology truth (SRS/DEPLOY): "Shopee (sellcenter mirror → MongoDB)" dump ทับ `conversations_shp`/`messages_shp`/`customers_shp`/`shops` ทุก ~2s ตรงลง shared `chatbot` Mongo (host :27017) — writer = **Sellcenter system (external infra)** ไม่มี service ใน docker-compose, ไม่มี process local
  - Payload semantics: `created_timestamp` = platform time (message ที่แท้) → ใช้เป็น `inbound_at` ใน hook contract · `data_received_at` = writer persist time (debug field)
  - **Verdict: `BLOCKED_BY_EXTERNAL_WRITER_REPO_REQUIRED`** — ต้องขอ Sellcenter repo/path + entrypoint จาก owner เพื่อวาง hook หลัง durable persist; receiver ไม่สร้าง caller ปลอม

#### Phase 2B.2 Commit Closeout (2026-10-13 — ผ่านแล้ว)
- Commit 1: `1c26317` `fix: make bot handoff outcomes authoritative` — 26 files +2721/−1023 (TS services/routes + Python bot + tests + SRS/schema)
- Root causes ที่ปิด: legacy review swapped args (crash AttributeError) · failed handoff เขียน success metadata ก่อน classify · pytest transport stub leak ทั่ว global · reason-string ทาย episode ชน retained-commit · HandoffEpisode over-engineering → ลบ (YAGNI — `bot_handoff_at` ไม่มี reader เลย)
- Verification (fresh ก่อน commit): ownership **203/203** · handoff-transport Python **37/37** · pytest 5 suites **59 passed 3 xfailed** · error-policy 38 · boundary 20 · config-failclosed 4 · enable-checkpoint 18 · idempotency 71 · recovery-freshness 59 · mongo-safety 110 · production-races 37 · py_compile 12 files OK · tsc 0 · build ✓ · diff-check clean
- Complexity: types −1 (HandoffEpisode) · outcome fields −1 (episode) · route string-classification −1 · helpers/guards/modules/queries/config/index/collection เพิ่ม 0
- Contract ปิดท้าย: `bot_handoff_at` = last claim-metadata refresh เท่านั้น (ไม่ใช่ authority/first-success/dedupe signal) · failed → zero success side effects · emit_incomplete → 503 retryable · authority = status_conversation + outcome.state
- Leftovers ไม่ถูกแตะ/ไม่ถูก stage: llm.py (vision URL dedupe — งานอื่น) · diag-worker-dup×5 · quarantine/vision×3 · architecture-audit doc
- Residual blockers: `BLOCKED_BY_EXTERNAL_WRITER_REPO_REQUIRED` ยังอยู่ · ไม่มี push/PR/deploy/worker/provider/real Mongo
- **Verdict: `PHASE_2B2_HANDOFF_CLOSED_AND_COMMITTED`**

#### Phase 2B.2 Post-Commit Contract Correction (2026-10-13 — กำลังทำ)
- **Baseline**: HEAD `aed9fb3` — 2 findings จาก diff review:
  - A. `_handle_review_request` (warranty_flow.py:707-718) คืน `handoff_to_admin=True`+`handoff_reason="review_request"`+routing `handoff` โดยไม่เคยเรียก `_send_handoff` — mid-flow response ที่แค่ขอลูกค้ายืนยัน ("ถ้าถูกต้องเดี๋ยวส่งต่อ"); flag=True ทำให้ `check_output` skip ทุก guard (guards.py:37)
  - B. `handoffToAdmin` converge (handoffService.ts:188) gate แค่ `assigned_to && !wasClosed` — `{status:"bot", assigned_to:X}` คืน `state:"assigned"` ทั้งที่ `resolveTicketState` ยังส่ง "bot" ให้ Python
- **Plan**: A — flip 3 fields เป็น bot_reply (confirm path มีอยู่แล้ว line 1492 → `_build_warranty_claim_response` → transport จริง); B — converge gate เพิ่ม `status ∈ {"handoff","open","pending"}` (set เดียวกับ Python handoffs.py:301) → `status:"bot"`/missing ไหลไป retained-owner fenced commit → normalize เป็น handoff โดย owner เดิม — ไม่มี helper/guard/ใหม่
- **ผ่านแล้ว (Post-Commit Contract Correction, TDD):**
  - RED: L3b `handoff_to_admin:True`+`path:handoff` (ไม่มี transport call — L3c ยืนยัน `calls==[]` ตั้งแต่ก่อนแก้) · H14 `{status:"bot",assigned_to:"admin-1"}` → converge คืน `assigned` แต่ meta ยัง `"bot"`
  - Fix A: `warranty_flow.py` flip 3 fields — `handoff_to_admin:False`/`handoff_reason:None`/`routing("bot_reply")`; `handoff_claim` เก็บไว้ (claim-info data ไม่ใช่ success marker); guard-safe (`_VIOLATION_RES`/`_ESCALATE_RULES` ไม่ match review text)
  - Fix B: `handoffService.ts` converge gate เพิ่ม `status∈{handoff,open,pending}` (set เดียวกับ `handoffs.py:301` ที่ Python อ่านผ่าน resolveTicketState) — inconsistent `{status:"bot"}+owner` ไหลเข้า retained-owner fenced commit (line 212→commitHandoffState fence `{assigned_to:expectedOwner}` ไม่ต้องการ status) → normalize `status:"handoff"` owner เดิม + eid audit · call ซ้ำ converge zero-write
  - GREEN: ownership **204/204** (H14 ใหม่) · handoff-transport **38/38** (L3b/L3c ใหม่) · pytest 59+3xf · error-policy 38 · boundary 20 · config-failclosed 4 · enable-checkpoint 18 · idempotency 71 · recovery-freshness 59 · mongo-safety 110 · production-races 37 · py_compile OK · tsc 0 · build ✓ · diff-check clean
  - Complexity: helpers 0 · guards 0 · modules/types/config/env/index/collection +0 · ownership writer 1→1 · runtime delta: warranty_flow −1 line · handoffService +6/−3 (gate+comment) — condition/return semantics เท่านั้น
  - Residual: `_TERMINAL_CLAIM_REASONS` ยังมี `"review_request"` vestigial (ไม่มี call path ใช้ — `_maybe_clear_claim_state` ถูกเรียกเฉพาะใน `_build_warranty_claim_response`) — ไม่มีผล behavior
  - ยังไม่ stage/commit — รอ review; suggested msg: `fix: align handoff flags with persisted lifecycle state`

#### Phase 2B.2 Contract Correction Closeout (2026-10-13 — ผ่านแล้ว)
- Commit: `3775366` `fix: align handoff flags with persisted lifecycle state` — 5 files +54/−19
- Findings ปิด: (A) `_handle_review_request` false-success (`handoff_to_admin=True`+routing `handoff` โดยไม่มี `_send_handoff` → guard skip ทั้งหมด) → bot_reply contract; (B) `handoffToAdmin` converge ไม่เช็ค status → `{status:"bot"}+owner` คืน assigned โกหก → gate `status∈{handoff,open,pending}` แล้ว normalize ผ่าน retained-owner fenced commit
- Cleanup: ลบ `"review_request"` จาก `_TERMINAL_CLAIM_REASONS` (vestigial — ไม่มี claim_ctx ผลิต reason นี้, `_maybe_clear_claim_state` reachable เฉพาะผ่าน `_build_warranty_claim_response`) → behavior delta = 0
- Fresh verification: ownership **204/204** · handoff-transport **38/38** · pytest **59+3xf** · error-policy 38 · boundary 20 · config-failclosed 4 · enable-checkpoint 18 · idempotency 71 · recovery-freshness 59 · mongo-safety 110 · production-races 37 · py_compile OK · tsc 0 · build ✓ · diff-check clean
- Complexity: helpers/guards/modules/types/config/env/index/collection +0 · ownership writer 1→1 · runtime diff = 2 condition/return fixes + 1 dead-contract removal
- Leftovers ไม่แตะ: `.gitignore` (user's diag ignore) · `llm.py` · vision/quarantine×3 · architecture-audit · diag-worker-dup×5 (ignored, on disk)
- Residual: `BLOCKED_BY_EXTERNAL_WRITER_REPO_REQUIRED` ยังอยู่ · ไม่มี push/PR/deploy/worker/provider/real Mongo
- **Verdict: `PHASE_2B2_HANDOFF_CONTRACT_CORRECTED_AND_COMMITTED`**

#### Leftover Cleanup + Commit Preparation (2026-10-13 — กำลังทำ)
- **Scope**: ปิด working-tree leftovers แยก ownership ชัดเจน — vision URL dedupe (`llm.py` + focused test), architecture audit snapshot, และ local incident-tool ignore เท่านั้น
- **Safety decision**: `diag-worker-dup*.ts` และ `quarantine_rollback*.py` เป็น local incident artifacts; rollback พึ่ง gitignored export และมี `--apply` เขียน DB จริง จึงเก็บบน disk แต่ไม่ commit source จนกว่าจะออกแบบ safety gate ใหม่
- **Commit plan**: vision fix+test แยก · architecture audit docs-only แยก · `.gitignore` แยก · active log closeout แยก; exact-path staging เท่านั้น ห้าม `git add -A`
- **ผ่านแล้ว (Leftover Cleanup Closeout)**: vision test 4/4 + py_compile ผ่าน (API keys loaded=0) → `6f29145` `fix: dedupe vision image URLs` (2 files) · architecture snapshot → `43bef5c` `docs: add current system architecture audit` (1 file; trailing whitespace แก้ก่อน commit) · local incident ignores → `9c1b779` `chore: ignore local incident diagnostics` (`.gitignore` only)
- **Final state target**: tracked/untracked status ว่าง; diag-worker×5 + quarantine×2 ยังอยู่บน disk แต่ถูก ignore; ไม่มี worker/provider/Mongo/`.env`/push/PR/deploy

#### Phase 2B.4 Claim Episode/Lifecycle Owner — GREEN + Isolation Fix (working tree — รอ review, ห้าม commit)
- **Root cause เพิ่มที่พบระหว่าง GREEN**: shadow sweep พังเฉพาะเมื่อรันร่วม `test_issue_5f_claim_flow.py` — 5f import `shopeechat.app` ตรงๆ ก่อน `test_legacy_turn_incident_replay` ทำให้ `load_dotenv()` อ่าน `.env` จริง → `ADMIN_MONGO_DB=chatbot` ชน `setdefault("chatbot_admin")` ที่มาทีหลัง (no-op) → `cp._admin_db()` อ่าน `client["chatbot"]` (FakeDb ว่าง) แทน seeded `client["chatbot_admin"]` → `load_timeline` คืน None → claim_state/anchor หายหมดใน shadow snapshot → action 'unknown'/'locked' ทุก fixture ที่ seed claim/anchor. baseline ไม่พังเพราะ `decide_turn` มี history-marker fallback owner (mask bug นี้ไว้) — ตอนลบ second owner ตาม Correction D เลยโผล่
- **วิธีแก้**: `_install` pin `ADMIN_MONGO_DB`/`MONGO_DB` ต่อ test (env-pinned boundary มีอยู่แล้ว — เติม 2 ตัวที่หลุด) — ไม่แตะ production code, ไม่เพิ่ม fallback
- **ผลกระทบเคสอื่น**: sweep/executor replay ทุก fixture ได้ claim_state+anchor ถูกต้อง; `test_shadow_human_request_is_handoff` (baseline combo-fail) ผ่านด้วย `_fake_send` truthy outcome fix เดิม
- **GREEN สุดท้าย (run เดียวกัน)**: `contract 30 + turn_decision 113 + 5f 18 + shadow 18 + replay 74` = **221 passed, 19 skipped, 9 xfailed, 0 failed**; handoff-transport script 38/38; qa_batch 12 passed + 4 failed (`_strip_kb_markup` — identical บน baseline, pre-existing ไม่เกี่ยว claim); py_compile 10 files OK; `git diff --check` clean
- **xfail คงเหลือ 9 (honest)**: claim-persist×2 (routing interception — 2C scope), keeps-state (claim รอดแล้ว แต่ greeting re-escalate — ownership axis), อีก 6 ไม่เกี่ยว claim
- **Un-xfails ปิดจริง**: `p2a-claim-resolved-new-request`, `p2a-claim-ticket-closed-product-question`, `p2a-claim-ticket-closed-phone-resume`, `p2a-claim-collect-name-phone` + baseline handoff-transport×5 หาย (fake คืน assigned outcome)
- **ยังไม่ stage/commit/push** — รอ final report review

#### Phase 2B.4 Review-Fix (PHASE_2B4_REVIEW_FIX_REQUIRED → กำลังทำ)
- **H1 episode-only fence ไม่พอ**: stale writer `{e1,collecting}` merge หลัง e1→resolved จะเขียน stage กลับ (episode fence ยัง match) + terminal whole-state `$set claim_state` ลบ evidence ที่ concurrent writer เพิ่งเพิ่ม → plan: fence = `expected_episode_id + expected_stage` ทุก transition; terminal ผ่าน `merge_claim_fields` partial `$set` (stage/resolved_at/resolution_reason); whole-state เฉพาะ new-episode create; CAS miss → reread ครั้งเดียว
- **H2 upsert ไม่มี uniqueness**: `conversation_products` ไม่มี unique index → concurrent create อาจได้ 2 docs → plan: `COLLECTIONS.conversationProducts` (config.ts) + `safeCreateIndex {conversation_id:1} unique` (mongoClient.ts owner เดิม); upsert path reconcile E11000 → reread 1 ครั้ง; ไม่มี Python index helper; deploy gate `BLOCKED_BY_CONVERSATION_PRODUCTS_UNIQUENESS_AUDIT` ค้างจน real census+index proof
- **M1 race tests ไม่ interleave**: extend `_FakeColl` เดิมด้วย `docs` list + `interleave` hook queue (fire ก่อน apply ใน update_one) + calls log → deterministic interleave จริง
- **M2 `.env` import purity**: `test_issue_5f_claim_flow.py` import `shopeechat.app` ก่อน trap → wrap dotenv stub รอบ shopeechat imports + restore + subprocess import-purity test
- **ข้อห้ามคงเดิม**: ไม่เพิ่ม owner/fallback/reason table/helper ใหม่; `_claim_episode_fence` ลบ (inline filter); absent fence ใช้ Mongo null-equality (`field: None` match missing∨null)
- **ผ่านแล้ว (Review-Fix RED→GREEN)**:
  - RED จริง: R1 stale merge reopen resolved (`collecting` กลับมา) · R2 whole-state terminal ทิ้ง evidence · R3 CAS-loss · R4 single-doc · R5 index pin — 6 failed ก่อนแก้
  - **ค้นพบเพิ่มระหว่าง fix**: create path ใช้ `update_one(upsert)` — rival insert ก่อน → upsert **match doc ของ rival แล้วทับ claim_state เงียบๆ** (ไม่ใช่แค่ dup doc) → เปลี่ยนเป็น `insert_one` + E11000→reread (unique index เป็นตัวตัดสิน)
  - GREEN: contract **35/35** · รวมสุทธิ **227 passed, 19 skipped, 9 xfailed, 0 failed** · handoff-transport 38/38 · py_compile 4 files · tsc 0 error · `npm run build` ✓ · `git diff --check` clean
  - `_claim_episode_fence` ลบแล้ว (inline filter) · helper รวม −1 · expected_stage fence ทุก write · terminal = partial `$set` เท่านั้น
  - M2 ปิด: 5f wrap shopeechat imports ด้วย dotenv stub try/finally + subprocess purity test (`test_module_import_never_reads_dotenv`) — `.env` ไม่ถูกอ่านไม่ว่า collection order ไหน
  - Changed files จริง = 17 (เพิ่ม config.ts + mongoClient.ts นอกชุดเดิม 15)
  - **Deploy gate คงอยู่**: `BLOCKED_BY_CONVERSATION_PRODUCTS_UNIQUENESS_AUDIT` — real-DB duplicate census + index proof ยังไม่ได้รัน (ห้ามในรอบนี้) → offline pass เท่านั้น ยังไม่ production-safe

#### Phase 2B.4 Test-Purity Correction (PHASE_2B4_LOGIC_PASS_TEST_PURITY_CORRECTION_REQUIRED → ผ่านแล้ว)
- **Finding A (leaked alias)**: 5f import trap restore เฉพาะ `dotenv.load_dotenv` — `app.load_dotenv`/`knowledge_base.load_dotenv` bind stub lambda ค้างทั้ง process → RED: `test_load_dotenv_aliases_restored_after_import` FAILED (`app.load_dotenv` ≠ provider fn) → fix: finally restore ผ่าน `sys.modules.get()` ทั้ง 2 alias (replay file ทำ pattern นี้อยู่แล้ว lines 95-102)
- **Finding B (self-import .env)**: `test_handoff_transport_owner_not_globally_stubbed` import `shopeechat.app` เอง → standalone run อ่าน `.env` จริง (proof: `[KEYS] โหลด API keys จำนวน: 9` ตอนรันเดี่ยว) → fix: `sys.modules.get` + `pytest.skip` เมื่อ app ไม่ได้โหลด — leakage check ทำงานเต็มใน combined order (issue_5f โหลด app ก่อน)
- **GREEN**: standalone contract 34 passed+1 skipped, `[KEYS]` absent (app ไม่ถูก import เลย — .env=0 มี executable proof) · standalone 5f 18/18 (purity subprocess + alias restore) · combined 5f→contract: transport assertion **executes** (ไม่ skip) + aliases restored · full suite **228 passed, 19 skipped, 9 xfailed, 0 failed** · handoff-transport 38/38 · py_compile OK · `git diff --check` clean
- **ไม่แตะ**: runtime, CAS, index, fixtures, expectations — TS/runtime diff คงเดิมจาก reviewed candidate · changed files จริง = **17**
- **RED count แก้ไข**: รอบนี้ RED = 2 findings (A ผ่าน alias test fail จริง, B ผ่าน [KEYS]=9 evidence) — R6 ไม่นับ (ไม่มี pre-fix failing output)
- **Deploy gate คงเดิม**: `BLOCKED_BY_CONVERSATION_PRODUCTS_UNIQUENESS_AUDIT`

#### Phase 2B.4 Evidence Correction + Real-DB Audit Gate (กำลังทำ/บล็อก env)
- **Test evidence corrected (fresh raw runs)**: contract standalone `34 passed, 1 skipped` (no `[KEYS]` — app ไม่ถูก import) · 5f standalone `18 passed` (18 tests จริง — รายงานก่อนหน้าเขียน 19 ผิด) · 5f+contract combined `53 passed` (transport leakage assertion executes, ไม่ skip) · turn_decision standalone `83 passed` (รายงานก่อนหน้าเขียน 113 ผิด — นับรวม suite อื่น) · shadow `18 passed` · replay `74 passed, 19 skipped, 9 xfailed` · full suite raw line: **`228 passed, 19 skipped, 9 xfailed, 5 warnings in 4.51s`** — per-file sum 35+83+18+18+74 = 228 ✓ ตรง
- **Mongo census verdict: `PREFLIGHT_BLOCKED_ENV_MISSING`** — `ADMIN_MONGO_URI`/`ADMIN_MONGO_DB`/`MONGO_*` ทั้งหมด unset ใน process env; กฎห้ามอ่าน `.env` + ห้าม fallback → ไม่ connect เลย; ยังไม่มี total/duplicate/index census — `BLOCKED_BY_CONVERSATION_PRODUCTS_UNIQUENESS_AUDIT` คงเดิม ไม่ใช่ pass
- **ยังไม่ stage/commit/push** · runtime/TS/fixtures ไม่แตะรอบนี้ · botworker/provider/API = 0 · Mongo writes = 0
- **Real-DB census done (read-only, one-shot)**: ephemeral /tmp script · `load_dotenv(override=False)` โหลด root `.env` ตามการอนุญาตชั่วคราวภายใน subprocess เดียว; ไม่แสดงเนื้อหาหรือค่า env/URI/credentials และ environment สิ้นสุดพร้อม subprocess · collection `conversation_products` (env override unset → owner default) · **total=3112 · exists=3112 · missing=0 · null=0 · empty=0 · non-string=0 · duplicate_groups=0 · extra=0 · largest=0** · index: เหลือแค่ `_id_` ไม่มี index บน `conversation_id` (unique sparse contract ยังไม่ถูกสร้าง) · consistency checks pass ทั้งหมด · mongo_writes=0 · client closed · verdict `PHASE_2B4_CENSUS_PASS_INDEX_CREATION_APPROVAL_PENDING` — ข้อมูล clean, index รออนุมัติสร้างแยกต่างหาก

#### Phase 2B.4 — COMMITTED closeout (commit 1: `8885a5a` `fix: fence warranty claim lifecycle transitions`, 16 files)
- **Root causes ที่ปิด**: (1) retained slots/history/reason strings เคยเป็น lifecycle authority แข่งกัน (2) stale same-episode write reopen terminal ได้ (3) terminal whole-state `$set` ลบ concurrent evidence ได้ (4) upsert create path overwrite doc ของ rival เงียบๆ (5) ไม่มี unique index → concurrent-create correctness ไม่ถูกคุ้ม
- **Final architecture**: `_claim_lifecycle` = evaluator เดียว · `_claim_transition` = transition owner เดียว · `transition_claim_state`+`merge_claim_fields` = storage primitives 2 ตัว · fence = `episode_id + expected_stage` · fresh episode ผ่าน `insert_one` · E11000 → reread ครั้งเดียวไม่ retry · terminal = partial dotted `$set` (เก็บ evidence เป็น audit record) · ไม่มี ticket-close/reason/history-marker เป็น lifecycle owner
- **Verification (frozen pre-commit)**: `228 passed, 19 skipped, 9 xfailed` · handoff transport `38/38` · py_compile pass · `tsc --noEmit` pass · `npm run build` pass · diff checks clean
- **Real-DB census**: 3112 docs · `conversation_id` ทุกตัวเป็น non-empty string · duplicate groups=0 · mongo writes=0 · index บน `conversation_id` ยังไม่มี
- **Complexity**: evaluator=1 · transition owner=1 · storage write primitives=2 · retry loops=0 · whole-state terminal writes=0 · +1 collection config key · +1 unique sparse index declaration · ไม่มี dep/env/flag/module ใหม่
- **.env ความจริง**: census โหลด root `.env` ครั้งเดียวภายใต้การอนุญาตชั่วคราวใน subprocess เดียว (ไม่แสดงค่า); Next build อาจ auto-load `.env` เอง — ห้ามอ้างว่า `.env=0` ทั้งรอบ
- **BLOCKER เหลือ**: `INDEX_CREATION_APPROVAL_PENDING` — **committed code ยังไม่ deploy-approved**; ห้าม deploy ก่อน create unique index `{conversation_id:1} unique sparse` บน real DB + verify ด้วย `listIndexes` (data clean พร้อมแล้วตาม census)
- **Real-DB index gate CLOSED**: หลัง approval token สร้าง `{conversation_id:1} unique sparse` บน `conversation_products` ผ่าน `create_index` ครั้งเดียว (ephemeral /tmp script, deleted after) — fresh census ก่อน DDL: total=3112, missing/null/empty/non-string=0, dup_groups=0 → `create_index` → returned `conversation_id_1` → `listIndexes` verify: `{conversation_id:1}` unique:true sparse:true ไม่มี partial filter, exact contract ✓ · indexes ตอนนี้ = `_id_` + `conversation_id_1` (ไม่มี index อื่นเปลี่ยน) · stats: connections=1, census_reads=2, create_index_calls=1, document_writes=0, list_indexes=2, client closed · `load_dotenv` โหลด root `.env` ครั้งเดียวภายใต้การอนุญาตชั่วคราว — ไม่แสดงค่า env/URI/credential ใด · verdict `PHASE_2B4_INDEX_CREATED_AND_VERIFIED_DEPLOY_STILL_NOT_APPROVED` — gate ปิดแล้ว แต่**ยังห้าม deploy/push/PR/botworker** จนกว่าจะมีการอนุมัติ deploy แยกต่างหาก
