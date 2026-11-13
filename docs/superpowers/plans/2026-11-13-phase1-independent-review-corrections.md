# Phase 1 — Independent Review Blocker Corrections (A-260)

Date: 2026-11-13 · SESSION: เดิม (ต่อจาก Xiaomi work A-258/A-259)
Source: `docs/waythrough-ledger.md` entry A-260 (verdict `CHANGES_REQUESTED`)
Constraint: mechanism +0 ทุกประเภท (helpers/guards/regex/keyword tables/heuristics/
decision owners/fields/deps); fix ใน typed owner เดิมเท่านั้น; ห้าม stage/commit.

---

## Task A — Preserve sandbox handoff semantics

### Root cause (verified source trace)
`responses.intent_provider_failure_handoff` (responses.py:178-181) เรียก
`_send_handoff(req, None, reason=..., claim=..., log_tag=...)` **โดยไม่ส่ง
`simulate=True`** → `_payload["simulate"]` ไม่ถูก set → Admin route
(`bot-handoff/route.ts:85` — `body.simulate === true`) ไม่เข้า test-store branch →
provider-failure handoff จาก Test Chat/Shadow (`simulate_assignment=True`)
ไหลไป live `conversations` route/404.

Convention ที่มีอยู่แล้ว: caller ทุกจุดที่ต้อง simulate pass `simulate=True`
— `chat_v2.py:1398` (no_product_found), `app.py:4656` (NO-PRODUCT-GUARD),
`chatbotv3/engine.py:113`. `_send_handoff` param `simulate` มีอยู่แล้ว →
fields/params +0.

### Owner
`chatbot/shopeechat/responses.py` — `intent_provider_failure_handoff` เท่านั้น
(`_send_handoff` signature/contract ไม่แตะ).

### RED acceptance
1. Unit: patch เฉพาะ `urllib.request.urlopen` (HTTP transport seam จริง —
   ห้าม patch `intent_provider_failure_handoff`/`_send_handoff`) →
   `simulate_assignment=True` → payload `simulate:true` +
   `reason:"intent_provider_failure"`; `simulate_assignment=False` →
   `simulate:false` (ตาม convention `simulate=True` caller อื่น).
2. E2E legacy path: `_install` + `classify_intent` raise + restore real
   `responses._send_handoff` → `handoffs` urlopen capture พบ
   `payload["simulate"] is True` + `test_source` propagated.
3. E2E v2 path: `_v2_call` + provider raise → same payload contract.
4. `test_source=None` → ไม่มี `test_source` key (ห้ามใช้ test_source หลบ
   simulation contract); invalid test_source ไม่เปลี่ยน `simulate` flag.

### Minimal fix
`simulate=True` ใน `_send_handoff(...)` call เดิม — 1 token change.

### Regression command
`.venv/bin/pytest -q docs/test/offline/test_phase1_final_review.py -k "f6 or f11_provider or handoff"`

---

## Task B — Enforce one-primary recommendation contract

### Approved contract (plan Task 5, 2026-11-12)
- normal recommendation = หนึ่ง primary product / หนึ่ง card
- หลายรายการเฉพาะ typed compare / explicit requested subjects
- `subtypes` จำกัดประเภท ไม่ใช่ cardinality license
- `role="alternative"` = typed fallback/substitute ไม่ใช่ unlimited admission
- answer context กับ `ChatResponse.products` ใช้ selected set เดียวกัน

### Root cause (verified source trace)
`answer_context.py:1869-1876` — cap fires เฉพาะเมื่อ
`n.operation=="recommend" and not n.subtypes and s.role!="alternative"
and took_primary>=1` →
(1) `s.role != "alternative"` → alternative ทุกตัวหลุด cap
(2) `not n.subtypes` → subtype recommend ("หัวชาร์จละ") หลุด cap
executable evidence: W01 fixture (subject+alternative) → ctx.products = 2.

### Owner
`chatbot/shopeechat/answer_context.py` — `compile_answer_context` loop เท่านั้น
(ไม่แตะ selection/retrieval/composition/web-gate).

### Design (ใน loop เดิม, ไม่มี helper ใหม่)
- precompute ต่อ need: `_prim_cap = max(1, len(n.subject_refs or ()))`
  (multi requested subjects → cap ตามที่ขอ — "explicit requested subjects")
- `_ok_ids` = identities ที่ `sellable` + `_scope_card` ผ่าน (หรือ union-emitted)
- `_prim_ok` = มี non-alternative ∈ `_ok_ids`
- loop rules (operation == "recommend" เท่านั้น):
  1. candidate ไม่อยู่ใน `_ok_ids` แต่มี `_ok_ids` ไม่ว่าง → skip
     (มีตัวขายได้ → ของขายไม่ได้ไม่ใช่ recommendation)
  2. `role=="alternative"` และ `_prim_ok` → skip (fallback เฉพาะเมื่อไม่มี
     eligible primary)
  3. `took >= _prim_cap` → skip (หนึ่งรายการต่อ requested subject)
- `took_primary` counter เดิมถูกยกเลิก (superseded โดย `_prim_ok`/`_prim_cap`)
- non-recommend ops (describe/compare/compat/price/...) — behavior เดิมทุกบรรทัด

### RED acceptance
1. recommend + [subject, alternative] → exactly 1 (subject id)
2. recommend + subtypes + 2 candidates → exactly 1
3. no eligible primary (subject absent) + eligible alternative → exactly 1 alternative
4. sellable=False subject + sellable alternative → exactly 1 (alternative)
5. sellable primary → alternative ไม่แนบเพิ่ม (= case 1)
6. compare need 2 subjects → เก็บทั้งคู่ (ไม่ over-correct)
7. ctx.products identity == selected identity (answer/card parity)
8. rewrite `test_recommend_need_still_admits_alternatives` →
   `test_recommend_need_admits_one_primary` ตาม approved contract

### Regression command
`.venv/bin/pytest -q docs/test/offline/test_phase10b_answer_completeness.py docs/test/offline/test_task5_final_answer.py docs/test/offline/test_phase7_answer_context.py`

---

## Task C — Legacy scoped-state activation readiness (read-only)

### Inventory (verified source trace)
- `conversation_products` collection (`_admin_db()["conversation_products"]`,
  Python-owned) — fields: `conversation_id`, `platform`, `shop`,
  `products[]`, `active_item_id`, `subject_set`, `claim_state`
- scoped readers (A-242): `load_timeline`, `save_timeline`/`add_product`,
  `add_order_anchor`, `load_claim_state`, `transition_claim_state`,
  `merge_claim_fields`, `get_subject_set`, `record_subject_set` —
  exact-or-unscoped ต่อ dim, legacy unscoped → fail closed (None/empty view)
- `_LIVE_CARD_CACHE` (conversation_products.py:348) = in-process card cache —
  ไม่เกี่ยวกับ persisted scope
- deterministic scope authority: `conversations` collection
  (`conversations_shp` prod) — `conversations._id == conversation_id` →
  `{platform, shop_id}` (durable relation; `shop` field ใน
  conversation_products = shop_id เดียวกัน — เห็นจาก `_send_handoff` payload
  `"shop_id": req.shop`)

### Census (offline session — ไม่มี live Mongo access)
Executable census script ใน plan deliverable (read-only aggregate);
counts ต้องรันโดย operator — session นี้รายงาน `MIGRATION_CENSUS_NOT_EXECUTED`
จริง ไม่ fabricate ตัวเลข.

### Deliverable
`docs/plans/active/2026-11-13-conversation-scope-backfill-plan.md` —
collections/fields, authority, dry-run command, write filter, idempotency,
conflict behavior, rollback, acceptance, STOP gate, unproven list.

---

## Task D — Exact Phase-1 commit manifest

Report-only จาก `git diff --name-status` + `git status --short` —
ห้าม wildcard, ห้าม `git add`. แยก: production / tests / docs-SRS /
waythrough / ChatAdminWeb / Zaapi / untracked Phase-1 / excluded.

---

## Stop conditions
- helper/guard/table/owner เพิ่มจำเป็น → STOP + evidence
- negative controls regress → STOP
- full suite มี failure ใหม่ → STOP
- integrity mismatch → STOP
- ไม่มี authoritative scope mapping → `MIGRATION_BLOCKED_BY_MISSING_SCOPE_AUTHORITY`
