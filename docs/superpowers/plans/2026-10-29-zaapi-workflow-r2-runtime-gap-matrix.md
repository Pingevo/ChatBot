# Zaapi Workflow R2 — Runtime Gap Matrix

วันที่: 2026-10-29 · สถานะ: analysis เสร็จ ยังไม่ implement

## บริบท

R1 เสร็จ: import corpus 21 flows → Mongo (218 nodes / 248 edges / 119 binding requirements) เป็น **disabled drafts** — โครง+config+labels ครบ 100% แต่เป็นพิมพ์เขียว engine ยังรันไม่ได้

สาเหตุ 3 ชั้น:
1. **config shape ต่าง** — imported เก็บ `conditions[]`/`action.*` แบบ Zaapi แต่ evaluator อ่าน legacy fields (`cfg.text`, `branches`, `match_type`)
2. **branch vocab ต่าง** — edges ใช้ `condition-index-N`/`no-match`/`ai-chatbot-*`/`wfr-*`/`btn-template-*`/`randomizer-path-N` แต่ edge-follower เข้าใจ `true`/`false`/legacy ids
3. **ไม่มี executor/event source** — ~20 types ไม่มี runtime เลย

## ตาราง gap: 31 types ที่ corpus ใช้จริง

### Triggers

| type | × | สถานะ | ต้องทำ |
|---|---|---|---|
| `message_received` | 13 | event source มี | adapter: once flags + accountIds→shop binding + trigger freq |
| `label_added` | 5 | ❌ ไม่มี event | emit label event → trigger flows (cross-flow chains!) |
| `marketplace_review_added` / `order_created` / `return_refund` | 1 ต่อตัว | ❌ ไม่มี | marketplace webhook/event ingestion |

### Conditions — evaluator ต้องอ่าน `conditions[]` + no-match

| type | × | สถานะ | ต้องทำ |
|---|---|---|---|
| `message_content` | 7 | legacy executor มี | adapter: contains_one_of/equals + msgType + sourceMsgStepId ref |
| `label` | 8 | ❌ | evaluator ใหม่: ตรวจ ticket labels (contains_one_of/all/does_not_contain) |
| `business_hours` | 5 | legacy executor มี | **per-shop business-hours config (ข้อมูลใหม่)** + within/outside ops |
| `event_time` | 2 | ❌ | evaluator: minutes-from-midnight windows + eventTimeZone (Asia/Singapore=UTC+8) |
| `last_interaction` | 7 | ❌ | evaluator: เวลาจากข้อความล่าสุดลูกค้า {value,unit} |
| `customer_waiting_time` | 3 | ❌ | evaluator: เวลาลูกค้ารอตอบ {value,unit} |
| `conversation_assignee` | 2 | legacy "assignee" มี | adapter: equals + userIds→bound users |
| `review_rating` | 1 | ❌ | marketplace review data |
| `ai_review_sentiment` | 2 | ❌ | AI sentiment 3-way + no-match="ไม่มีรีวิว" |

### Actions — evaluator ต้องอ่าน `action.*` canonical

| type | × | สถานะ | ต้องทำ |
|---|---|---|---|
| `send_message` | 33 | executor มี | adapter: action.message.text + image type |
| `add_label` | 33 | executor มี | adapter: labelIds→bound labels + **emit label event** |
| `remove_label` | 17 | ❌ | executor ใหม่ + emit label event |
| `chat_assign` | 15 | assign_ticket มี | adapter + **round-robin `lastAssignedUsersIndex` state** + assignWhenAllOoh + assignToLastTicketHandledBy |
| `chat_unassign` | 3 | ⚠️ registry มี | ตรวจ executor + adapter |
| `close_chat` | 5 | close_ticket มี | adapter trivial |
| `chatbot` | 6 | let_ai_respond มี | adapter + **escalate/timeout branch engine** + timeout {value,unit} + knowledge scope |
| `send_button_template` | 2 | ❌ | interactive buttons + postback routing + expiresIn + none-selected |
| `send_marketplace_order_card` | 2 | ❌ | marketplace adapter |
| `set_ticket_field` | 3 | ❌ | ticket fields entity + **template var `{{marketplaceOrderTotal}}`** |
| `reply_to_review` / `add_note_to_review` / `mark_review_as_follow_up` | 6/1/1 | ❌ | marketplace review adapter |

### Utility

| type | × | สถานะ | ต้องทำ |
|---|---|---|---|
| `delay` | 4 | ❌ | **durable timer** (รอด restart — persist wake-at) |
| `wfr` | 3 | wait_for_reply legacy มี | adapter: replyType + retries + expiresIn + invalidInputReply + retry-expired |
| `randomizer` | 3 | ❌ | weighted pick per contact |
| `jump_to` | 23 | legacy มี | adapter + **maxJumps counter per run** (loop guard 3) |

## Cross-cutting runtime pieces (ต้องมีก่อน activate flow จริง)

1. **Canonical executor layer** — อ่าน `conditions[]`/`action.*` + route branch vocab (อาจแปลง canonical→legacy ตอน activate หรือสอน evaluator อ่านทั้งสอง shape)
2. **Durable scheduler** — delay/wfr-expiry/event-time ต้อง survive restart (persist + sweep job)
3. **Per-shop business hours config** — Zaapi ไม่เก็บใน flow; binding/readiness check ใหม่
4. **Label event bus** — add/remove label → fire `label_added`/`label_removed` triggers + loop guard (cross-flow chains เช่น flows 10–14)
5. **Marketplace integration** — review/order/refund events + reply/order-card APIs
6. **Template var resolver** — `{{marketplaceOrderTotal}}` ฯลฯ
7. **Ticket fields + round-robin runtime state**
8. **Edge branch router** — canonical vocab ทั้งหมด
9. **Trigger dedup/overlap** — มี blocker แล้ว ใช้ต่อ (flows 1,3,4,5 share 81 channels "every time")

## คำถามที่ Zaapi docs ไม่ระบุ (ต้องตัดสินเอง)

- retry-expired ของ wfr route ไปไหนเมื่อไม่มี edge (docs บอก unspecified)
- ข้อความใหม่เข้าระหว่าง delay → run เก่าถูกยกเลิกไหม (dedup semantics)
- round-robin `lastAssignedUsersIndex` scope: per-node หรือ per-team

## ลำดับ R2 ที่เสนอ (pilot-first)

1. **fix `lookups.handles`** — importer bug เล็ก (single-file เสีย labels)
2. **Edge branch router** — canonical vocab → edge follower
3. **Condition adapter + evaluators ใหม่** — message_content/label/business_hours/last_interaction/customer_waiting_time/conversation_assignee (ครอบ flow ส่วนใหญ่)
4. **Action adapter** — send_message/add+remove_label/chat_assign(+RR)/close/unassign
5. **Durable timer + delay/wfr**
6. **label_added trigger + label events**
7. **chatbot escalate/timeout + knowledge scope**
8. **marketplace/review + button template + set_ticket_field + template vars**
9. **Readiness gates** — mark requires_adapter types บล็อก publish จน executor พร้อม
10. **Pilot: flow 01 (เก็บตกแชทค้าง)** — เล็ก ครอบ timer+condition+assign → canary ร้านแรก
