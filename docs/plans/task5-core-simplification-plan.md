# Task 5 — Core Simplification Plan v2 (CORRECTED — AUDIT-ONLY — รอ user approval)

สร้าง: 2026-11-05 · แก้ไขรอบ correction ตาม factual/safety findings
Branch `feature-botlogic-kb-workflow` @ `7fabb04`
Authority: master plan Stage 2 ข้อ 6–10 · Phase 4 design · legacy plan Reality Check + Complexity Gate + Task 13 · ledger A-008/A-009/A-023–A-059

## 0. Corrected census (วัดจริงด้วย AST/diff — ไม่มีตัวเลขประมาณ)

### 0.1 Production files changed: **13 ไฟล์** (ยืนยัน `git diff --name-only`)

answer_context · app · candidate_pool · device_compat · guards · kb_zaapi · kb_zaapi_generation · kb_zaapi_retrieval · kb_zaapi_schema · policy_resolver · retrieval_runtime · retrieval_selection · warranty — **+1469/−228 → net +1241 LOC**

### 0.2 New function defs: **18 ชื่อ = 15 top-level + 3 nested** (net +16 หลัง kb_zaapi.py ลบ 2 def เก่า)

| file | top-level added | nested added |
|---|---|---|
| answer_context | `_validate_meta` `_kb_zaapi_need_ok` `_pair_segment` | `_covers` (depth 4) |
| app | `_pair_facts` `_subject_pins` `_pair_verdicts` | `_pair_subject_pins` `_pair_verdict_fn` (depth 2 — closure ใน `_chat_impl`) |
| device_compat | `_extract_product_host_connectors` `_surface_connectors` | — |
| guards | `_clause_span` `_conn_claim_re` `_connector_grounded` `_subject_cards` | — |
| policy_resolver | `_pair_conn_vals` `_wattage_rc` | — |
| warranty | `warranty_value_months` | — |

ไม่มี lambda ใหม่ (ลูกเล่น regex ใน `_conn_claim_re` เป็น closure body ไม่ใช่ lambda)

### 0.3 if/try nodes: **+123 if · +7 try** (AST census ต่อไฟล์ — answer_context +52/+1, app +24/+5, guards +28/0, policy_resolver +6/0, device_compat +4/0, kb_zaapi_retrieval +6/0, warranty +3/0, retrieval_runtime +2/0, retrieval_selection +1/0, kb_zaapi −3/+1)

### 0.4 Module-level bindings — **16 ชื่อใหม่** (นับ binding ไม่ใช่ประเภทรวม):

| binding | file | type | class |
|---|---|---|---|
| `_META_EMIT_KEYS` | answer_context | frozenset | MERGE |
| `_ROUTING_META_KEYS` | answer_context | frozenset | MERGE |
| `_META_REQUIRED` | answer_context | frozenset | MERGE |
| `_RECORD_TYPE_VALUES` | answer_context | frozenset | CORE |
| `_READINESS_ACTIVE` | answer_context | scalar | CORE |
| `_CONN_SURFACE` | device_compat | tuple | DELETE |
| `_CONN_SURFACE_RE` | device_compat | regex | DELETE |
| `_PAIRING_RE` | guards | regex | DELETE |
| `_CONN_CLAIM_RE` | guards (built in `_conn_claim_re`) | regex | DELETE |
| `_DEFER_CONN` | guards (local const) | str | DELETE |
| `_PROJECTION_FIELDS_V1`+`_PROJECTION_FIELDS` | kb_zaapi_generation | tuple pair | MERGE→owner เดียว |
| `_PROJECTION_FIELDS_V1`+`_PROJECTION_FIELDS` | kb_zaapi_retrieval | set pair | MERGE→owner เดียว (schema copy ซ้ำสองไฟล์ — ยืนยัน duplicate) |
| `_DEVICE_STRUCTURED_SOURCES` | policy_resolver | frozenset | CORE |
| `_PRODUCT_PAIR_STRUCTURED_SOURCES` | policy_resolver | frozenset | DELETE |
| `_PRODUCTISH` | kb_zaapi | frozenset — **rename/แทน `_MATCH_COLS`** | CORE (ไม่ใช่เพิ่ม) |

Modified (ไม่ใช่เพิ่ม): `_REQUESTED_FACT_KEYS` (extend — มีอยู่ HEAD:109) · `_FIELD_UNITS` (extend)
**Semantic regex additions: +3** (`_CONN_SURFACE_RE`, `_PAIRING_RE`, `_CONN_CLAIM_RE` — ทั้งหมด pairing)
**dataclass field +1** (`AnswerContext.pair_verdicts`) · **boundary param +1** (`pair_verdict_fn`) · **flags +0** · **deps +0**

### 0.5 Function census verdict — **18 = CORE-KEEP 2 + MERGE 1 + CONDITIONAL KEEP 2 + DELETE 13**

| verdict | functions |
|---|---|
| CORE-KEEP (2) | `_kb_zaapi_need_ok` `_covers` |
| MERGE (1) | `_validate_meta` |
| CONDITIONAL KEEP (2) | `_wattage_rc` `warranty_value_months` |
| DELETE/DEFER (13) | `_pair_segment` `_pair_facts` `_subject_pins` `_pair_verdicts` `_pair_subject_pins` `_pair_verdict_fn` `_conn_claim_re` `_subject_cards` `_connector_grounded` `_clause_span` `_extract_product_host_connectors` `_surface_connectors` `_pair_conn_vals` |

## 1. Scope matrix — สามกลุ่มแยกชัด

### A. TASK 5 CORE (สัมพันธ์ master plan โดยตรง)
`kb_source: legacy|zaapi` strict · no both/fallback · inactive zero reads · Zaapi active immutable artifacts only · source admission → central pool · item/model/request/need attribution · catalog/units sellable authority · malformed artifact/meta fail closed · switch/rollback · retrieval parity/canary

### B. CONDITIONAL SAFETY CARRYOVER — evidence gate

| item | approved invariant | regression test | owner | callers | mechanism delta | เหตุผลอยู่ใน candidate นี้ | verdict |
|---|---|---|---|---|---|---|---|
| `_wattage_rc` | wattage truth channel (R2/R3 era — verdict ต้องไม่ตี unknown เป็น full-speed; ledger A-023+ / LOW-3 locks) | `test_phase10b_answer_completeness.py` LOW-3 (~L961, L1117: ไม่มี wattage evidence + structured min_watt; unknown ≠ below-target) — executable, ยังอยู่ | policy_resolver | `resolve_compat` L916 (declared charges — **coverage ใหม่**), L965 (derived connector_match — แทน inline block เดิมที่ HEAD:834-880) | +46 LOC, **dedup inline → shared**; เพิ่ม coverage เฉพาะ declared-path | Zaapi compat records = declared proofs สำหรับ charges; ไม่มี eval → declared compatible ขาด wattage caveat → overclaim risk; logic เดิมที่ HEAD ไม่ใช่ semantics ใหม่ | **KEEP (ผ่าน evidence)** |
| `warranty_value_months` | warranty grounding = owner เดียว (warranty owner consolidation — ไม่เพิ่ม semantic matcher) | `test_task5_final_answer.py` L1105-1181: `test_warranty_suffix_2y` `test_warranty_title_path_2y_no_zaapi` `test_warranty_zaapi_path_no_suffix` `test_warranty_no_source_cannot_confirm` `test_cable_length_2m_never_two_months` — 5 executable tests | warranty | `guards.py:396` (claim compare จุดเดียว) | +14 LOC, +0 helper นอก owner | Zaapi meta มี warranty "24 เดือน"/"2 ปี" ต้อง normalize → เทียบ claim ได้; ถอด = Zaapi warranty claims fail grounding → cannot-confirm ทั้งที่มี evidence (quality regression ไม่ใช่ safety hole) | **KEEP (ผ่าน evidence)** |
| `spec_measured` channel ext. | typed spec evidence → guard grounding (pre-existing HEAD:922 — candidate เพิ่ม Zaapi meta เข้าช่องเดิม) | `test_task5_final_answer.py` L1247 spec_measured assert; `test_phase10b_r12_semantic_contract.py` | answer_context + guards (owner เดิมทั้งคู่) | evidence pipeline เดิม | ไม่มี helper ใหม่ — extend dict เดิม | Zaapi spec facts ต้องไหลช่องเดิม ไม่งั้น evidence ไม่ถึง guard → claims ungrounded | **CORE (เป็น extension ไม่ใช่ carryover)** |
| typed compat final-answer (non-pair) | `compat_verdicts`→`_compat_segment` pre-existing Phase 10 | compat suites (144/144) | answer_context/policy_resolver เดิม | compose เดิม | +0 | ไม่ใช่ส่วนเพิ่มของ candidate นี้ | CORE (ไม่แตะ) |

เกณฑ์ B ผ่านทั้งสองรายการ → promote เป็น KEEP; หาก implement แล้ว regression ไม่ผ่าน → revert รายการนั้น (Step 5)

### C. DEFERRED — NOT PRODUCTION READY (ไม่ใช่ hidden feature)
product↔product pairing · connector inference/claim guard · pair verdict/composition · mixed/multi-need pairing · connector backfill · pairing answer ownership · Gemini activation

## 2. Negative pairing safety contract (แทน "model ตอบเอง" เดิม — ช่องโหว่ปิดแล้ว)

R7–R11D พิสูจน์ว่า model pairing prose ทำได้: wrong-model confirm, cross-product verdict leak, foreign identity render, positive claim ไร้ structured evidence → **defer ≠ ปล่อย model ตอบ**

1. **Feature-completeness**: pairing ไม่ใช่ gate — candidate ไม่จำเป็นตอบ pairing ได้
2. **Negative safety gate (activation บังคับ)**:
   - unsupported positive pairing claims = **0**
   - wrong-item/wrong-variant pairing claims = **0**
   - unknown evidence ห้ามกลายเป็น compatible
   - cannot-confirm ยอมรับได้เต็มที่
3. ห้ามสร้าง pairing mechanism ใหม่ในรอบนี้ · ห้าม prose regex/keyword guard ใหม่
4. Implementation ภายหลังมีเพียง 2 ทางเลือก:
   - typed boundary เดิม decline unsupported pairing (ไม่เพิ่ม owner/mechanism) — **ทางเลือกต้อง user เลือก ถ้า canary fail**
   - หรือ activation block จนกว่า replay จะ clean
5. Pairing canary อยู่ใน baseline-vs-candidate QA เสมอ (safety-only category — วัด "ห้ามตอบผิด" ไม่วัด "ตอบได้")

## 3. Hunk-level manifest (corrected — caller-verified)

| file | symbol/hunk | approved req | caller/consumer | verdict | behavioral test | LOC Δ | mech Δ |
|---|---|---|---|---|---|---|---|
| kb_zaapi.py | adapter rewrite (+94/−94) incl. `_PRODUCTISH`←`_MATCH_COLS` | active immutable artifacts เท่านั้น | retrieval adapter | KEEP | artifact load/retrieve tests | ±0 net | −2 defs |
| kb_zaapi_retrieval.py | typed retrieval +50 | canonical retrieval/attribution | runtime | KEEP | retrieval tests | +50 | +6 if |
| kb_zaapi_generation.py | `_PROJECTION_FIELDS*` +20 | v1/v2 artifact contract | schema owner | MERGE→single projection owner | generation tests | +20→~+12 | −1 schema copy |
| kb_zaapi_retrieval.py | `_PROJECTION_FIELDS*` (dup copy) | เดียวกัน | retrieval L124-126 | MERGE→import จาก owner | เดิม | −~8 | −1 copy |
| kb_zaapi_schema.py | ±1 | validation | — | KEEP | schema tests | ±1 | 0 |
| candidate_pool.py | +14 | pool attribution | pool | KEEP | admission 28 | +14 | 0 |
| retrieval_runtime.py | +17 | source admission | runtime | KEEP | isolation/zero-read | +17 | +2 if |
| retrieval_selection.py | +10 | selection | selector | KEEP | selection tests | +10 | +1 if |
| answer_context | `_META_EMIT_KEYS`/`_ROUTING_META_KEYS`/`_META_REQUIRED`/`_validate_meta` | meta transport fail-closed | evidence/attach paths (L958,985) | **MERGE → 1 closed contract** | contract probe (shape/poison-key/routing-vs-emitted) | ~−30 | −2 keysets |
| answer_context | `_RECORD_TYPE_VALUES`/`_READINESS_ACTIVE` | artifact readiness | meta validation | KEEP | เดิม | ~+10 | 0 |
| answer_context | `_kb_zaapi_need_ok` | **attribution owner** (Zaapi evidence↔need binding — ไม่ใช่ answer-policy owner) | L659 evidence coverage | KEEP | attribution tests | +41 | 0 |
| answer_context | `_covers` | **attribution** (per-request evidence coverage) | L1363/1373 | KEEP | เดิม | +37 | 0 |
| answer_context | spec_measured wiring/`_REQUESTED_FACT_KEYS` ext | Zaapi spec evidence→guard channel | HEAD:922 channel เดิม | KEEP | L1247 assert | ~+40 | 0 |
| answer_context | meta transport hunks เหลือ (evidence emit/attach) | evidence เข้า pool + bound | pool→context | KEEP | attribution tests | ~+250 | +30 if |
| answer_context | `pair_verdicts` field + `_pair_segment` + compose pair loop | — (pairing) | compose | **DELETE** | — | −60 | −1 field −1 def −1 if-cluster |
| app.py | boundary pair exclusion L740-810 | — | boundary | **DELETE** | — | −74 | −1 try −10 if |
| app.py | `_pair_facts`/`_subject_pins`/`_pair_verdicts` L935-1044 | — | `_rd_extra`+boundary | **DELETE** | — | −106 | −3 defs |
| app.py | `_rd_extra` pair + `_pair_subject_pins`/`_pair_verdict_fn` L2219-2330 | — | rd_extra/boundary | **DELETE** | — | −140 | −2 defs −2 try |
| app.py | core hunks เหลือ (pool wiring/attribution/meta) | core | — | KEEP | — | ~+75 | — |
| guards.py | connector_claim tier + `_conn_claim_re`/`_subject_cards`/`_connector_grounded`/`_clause_span`/`_PAIRING_RE`/`_DEFER_CONN` + call sites | — | enforce | **DELETE** | — | −~150 | −4 defs −2 regex −1 tier |
| guards.py | typed grounding (`_spec_fact_grounded`/spec_measured) + warranty compare + เหลือ | core grounding | enforce เดิม | KEEP | claim guard tests | ~+90 | — |
| device_compat.py | `_extract_product_host_connectors`/`_surface_connectors`/`_CONN_SURFACE`/`_CONN_SURFACE_RE` | — | `_pair_conn_vals`/guard | **DELETE** | — | −54 | −2 defs −2 tables |
| device_compat.py | structured-surface hunks อื่น (ถ้ามีที่ core) | connector typed surface สำหรับ device compat | resolver | KEEP (ตรวจ caller ตอน implement) | — | 0−small | — |
| policy_resolver.py | `_pair_conn_vals` + `_PRODUCT_PAIR_STRUCTURED_SOURCES` + pair branch (L928-936) | — | resolve_compat connects | **DELETE** | — | −~60 | −1 def −1 table −1 branch |
| policy_resolver.py | `_wattage_rc` + declared-charges call (L916) | wattage truth (dedup+extend declared path) | resolve_compat | **CONDITIONAL KEEP** (§1.B ผ่าน) | LOW-3 tests | +46−~20 inline | +1 def อยู่ใน owner เดิม |
| policy_resolver.py | `_FIELD_UNITS` ext + `power_capacity_w`/`max_current_a` + `_DEVICE_STRUCTURED_SOURCES` + Zaapi compat source | spec evidence mapping | resolver | KEEP | spec/compat tests | ~+60 | +1 table |
| warranty.py | `warranty_value_months` | warranty grounding normalize | guards:396 | **CONDITIONAL KEEP** (§1.B ผ่าน) | 5 warranty tests | +14 | +1 def ใน owner |

**_PROJECTION_FIELDS_*: caller ยืนยัน** — generation.py:40 ใช้ copy ของตัวเอง; retrieval.py:124-126 ใช้ copy ของตัวเอง → schema เดียวกันสองไฟล์ = duplicate owner จริง → merge เข้า `kb_zaapi_schema` (owner เดียว) แล้วทั้งสอง import

## 4. Test strategy (corrected — แยก 4 ชั้น)

| ชั้น | รายการ | disposition | est. LOC |
|---|---|---|---|
| **Core executable** | source isolation · inactive zero reads · artifact-only retrieval · fail-closed schema/meta · need/item/model attribution · lifecycle/rollback · pool admission · final-answer smoke (core only) · `conftest.py` + `test_offline_boundary.py` (infra) | KEEP executable | ~1800-2000 |
| **Conditional safety tests** | LOW-3 wattage (phase10b) · 5 warranty tests · spec_measured assert · compat suites | KEEP executable (ผูกกับ §1.B) | ~200 |
| **Negative pairing safety canaries** | ใหม่/สกัด: "pairing question → ห้าม positive claim เมื่อ evidence ไม่มี" · wrong-item pairing = 0 · unknown ≠ compatible | **KEEP executable** (QA/activation — ไม่บังคับตอบได้) | ~100-150 (สกัดจาก R7–R11D scenarios เดิม) |
| **Deferred specification** | R7–R11D truth tables/controls (~900-1000 LOC: pair scope, name binding, provider fail, exact-pair, spoof) | **สกัดเป็น non-executable spec** `docs/plans/deferred-pairing-contract.md` (ระบุ source test names เดิม + traceability) **แล้วลบ executable tests** — ห้าม `test_*.py` ใน backlog | −900-1000 |

ห้ามลบ regression test ของ legacy/core behavior ที่ยังมี owner

## 5. Edit order (corrected — 8 steps มี gate ทุกขั้น)

1. **Scope-preservation prep** — freeze core invariant list + negative pairing safety canaries (executable) ก่อนลบ; ไม่เพิ่ม production mechanism
2. **Delete pairing subsystem** — เฉพาะ manifest DELETE ที่ caller ตรวจครบแล้ว; ตรวจ dangling refs (`pair_verdict_fn` param, `_pair_segment`, `pair_verdicts` field, imports, `_PRODUCT_PAIR_STRUCTURED_SOURCES`, pair branch ใน resolve_compat)
3. **Verify ทันที** — core suites + legacy compat regressions + **negative pairing safety canaries**; unsupported positive claim กลับมา → **STOP** รายงาน user (ห้าม auto-fix ด้วย regex/guard/helper)
4. **Merge metadata contracts** — `_META_*` → single closed contract + `_PROJECTION_FIELDS_*` → `kb_zaapi_schema` owner เดียว; verify: emitted shape ไม่เปลี่ยน · routing-only fields ไม่ถึง LLM · poison keys ทับ identity/linkage ไม่ได้
5. **Resolve CONDITIONAL KEEP** — keep เฉพาะที่ regression evidence ผ่าน (`_wattage_rc`, `warranty_value_months` — expected KEEP per §1.B); ไม่ผ่าน → revert/defer
6. **Test cleanup** — ลบ deferred executable pairing tests · สร้าง `docs/plans/deferred-pairing-contract.md` (non-executable + source-test traceability) · คง negative canaries
7. **Whole-candidate QA** — baseline-vs-candidate replay (50-100 cases); pairing = safety-only category; **0 provider calls** จนกว่า user authorize แยก
8. **Remeasure/SRS/ledger** — production LOC + funcs/helpers/guards/regex/tables/owners + test LOC + exact changed-file manifest

## 6. Mechanism budget (exact)

| metric | before | after (target) |
|---|---|---|
| production net | +1241 | **~+440–560** (delete ~650-750 + merge ~-30) |
| app.py | +319 | ~+60–80 |
| guards.py | +239 | ~+90 |
| new defs | 18 (15 top+3 nested) | 5 (`_validate_meta`, `_kb_zaapi_need_ok`, `_covers`, `_wattage_rc`, `warranty_value_months`) |
| semantic regex | +3 | **0** |
| frozenset/table new | 16 bindings | ~9 (core only, post-merge) |
| guard tiers | +1 (connector_claim) | 0 |
| dataclass fields | +1 | 0 |
| boundary params | +1 | 0 |
| decision/composition owners | 0 new (pairing ไม่เคยเป็น owner ใหม่ — เป็น mechanism ใน owners เดิม) | 0 |
| test LOC | 3039 | ~2100-2300 (core ~1900 + safety ~200 + canaries ~150) |

## 7. Unresolved user decisions (ต้องตอบก่อน implement)

1. CONDITIONAL KEEP ทั้งสองมี evidence ผ่าน §1.B — **confirm keep** หรือสั่ง defer `_wattage_rc`/`warranty_value_months` ออก?
2. ถ้า Step 3 negative canary fail — เลือกทางไหน: (a) typed boundary decline (ต้องออกแบบไม่เพิ่ม mechanism) หรือ (b) block activation?
3. `_PROJECTION_FIELDS_*` merge destination = `kb_zaapi_schema.py` เห็นด้วยไหม?
4. cannot-confirm threshold สำหรับ QA activation (ตัวเลขเป๊ะ)?
5. Deferred spec file ชื่อ `docs/plans/deferred-pairing-contract.md` — โอเคไหม?

## 8. Residual risks + rollback

- Deletion dangling refs — Step 2/3 gate
- Meta merge เปลี่ยน emitted shape — Step 4 contract probe
- Pairing canary fail post-delete — STOP → user decision (§7.2) ห้าม auto-fix
- Rollback = revert ทีละ step (แต่ละ step = verifiable unit)
- Deferred spec ต้องเป็น prose contract ไม่ใช่ executable — ห้าม drift เป็น hidden test suite

## 9. FINAL ACTUAL METRICS (post-implementation — 2026-11-05)

| metric | baseline | expected | actual | verdict |
|---|---|---|---|---|
| production net | +1241 | +440–560 | **+626** (+831/−205) | over range +66 — เหตุผล: typed decline block + mixed-fact strip (`_rel_strip`/`_dc_replace`) + meta merge + `_wattage_rc` keep — ไม่มี patch เพิ่มเพื่อเลขสวย |
| app delta | +319 | +60–80 | **+3** | ต่ำกว่าเป้า — pairing wiring ถูกลบทั้งหมด (net เหลือ Zaapi transport เพียง 3 บรรทัด) |
| semantic pairing regex | +3 | 0 | **0** | pass |
| connector guard tier | +1 | 0 | **0** | pass |
| pair field/param | +1/+1 | 0 | **0** | pass |
| new defs vs HEAD | 18 | ~5 | **+7/−2 = net +5** (fresh census 13 files) | `_covers`/`_kb_zaapi_need_ok`/`_validate_meta`/`_clause_span`/`_subject_cards`/`_wattage_rc`/`warranty_value_months` เพิ่ม; `_shop_clause`/`_zaapi_coll` ลบ — caller-verification ครบ |
| test LOC (task5+canary) | 3039 | ~2100-2300 | **~1050** | ต่ำกว่าเป้า — ลบ deferred executable tests 56 defs/~730 LOC; canaries ย้ายเข้า retained module (test modules −1) — **30 tests ในไฟล์เดียว** (22 core + 4 canary + 4 controls) |
| production files touched | 13 | — | 6 (app/answer_context/guards/device_compat/policy_resolver/kb_zaapi_generation) | 7 core-Zaapi files ไม่ถูกแตะรอบนี้ |

Deferred spec: `docs/plans/deferred-pairing-contract.md` (non-executable, created)
Typed decline: single branch ใน `compile_answer_context` — +0 helpers/guards/regex/keyword/fields/params/owners
