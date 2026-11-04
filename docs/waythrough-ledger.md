# Waythrough Ledger (canonical index)

## 1. Purpose และ authority

- ดัชนี/สรุป compact ของ raw logs — **ไม่แทน raw logs**; ถ้าขัดกัน raw logs ชนะ
- Raw logs: `getoutofmywaybotkaikrook.md` (frozen) + `getoutofmywaybotkaikrook2.md` (append-only active)
- โปรโตคอลอ่าน/เขียน: `AGENTS.md` ข้อ 8 · แผน migration: `docs/plans/waythrough-ledger-migration.md`
- ความหมาย status: `verified` = raw log บันทึก test/evidence ว่าผ่านและ ledger ตรวจต้นฉบับแล้ว · `historical-unverified` = log เองระบุว่ายังไม่ verify เต็ม/evidence บาง · `superseded` = มี entry ใหม่แทน (ระบุ superseded-by)

## 2. Integrity metadata

ตรวจ "ไฟล์ไม่ถูกแก้ย้อนหลัง" เท่านั้น — **ไม่ได้แปลว่าเนื้อหาถูกอ่านหรือ index แล้ว** (ดู coverage ส่วน 4–5)

Frozen:

| field | value |
| --- | --- |
| frozen_file | `getoutofmywaybotkaikrook.md` |
| frozen_lines | 8624 |
| frozen_bytes | 892284 |
| frozen_sha256 | `a67b91526019270975652ab8cbd07aadeab482d8a59d442e679eafc40f520341` |

Active append-only integrity baseline:

| field | value |
| --- | --- |
| active_file | `getoutofmywaybotkaikrook2.md` |
| active_integrity_prefix_lines | 11134 |
| active_integrity_prefix_sha256 | `57bd4b3225c7cddac30d1083a03bb08d13a181d898a468dac6e7ea300d34d9d5` |
| active_line_count_at_baseline | 11134 (bytes 2140137) |
| active_integrity_recorded_at | 2026-11-04T11:44+0700 |

Baseline ตั้งที่ EOF หลัง append closeout (บรรทัดสุดท้ายของ task นี้) แล้ววัดทั้งไฟล์

## 3. Coverage status

`coverage: partial`

- semantic coverage (ส่วน 4–5) ยังไม่ครบ — ห้ามอ้างว่า full historical audit ผ่าน
- integrity baseline ที่ EOF ไม่ได้แปลว่า active 1..EOF ถูกอ่าน
- งานใหม่อ่านเฉพาะ active tail หลัง `active_integrity_prefix_lines`; ประวัติที่ coverage ยังขาดใช้ targeted search + อ่าน exact range + เพิ่ม coverage entry (AGENTS.md ข้อ 8)

## 4. Frozen semantic coverage ranges

| range | state |
| --- | --- |
| 1–240 | read + indexed (ส่วนที่ 6: F-001..F-013) |
| 241–8624 | ไม่ได้ index (gap) |

## 5. Active semantic coverage ranges

| range | state |
| --- | --- |
| 595–683 | read + indexed (A-002) |
| 6490–6569 | read + indexed (A-003) |
| 6897–6966 | read + indexed (A-004) |
| 7105–7177 | read + indexed (A-005) |
| 7474–7609 | read + indexed (A-006) |
| 10026–10117 | read + indexed (A-007) |
| 10118–10181 | read + indexed (A-008) |
| 10383–10426 | read + indexed (A-009) |
| 10483–10525 | read + indexed (A-010) |
| 10526–10750 | read + indexed (A-011) |
| 10751–10822 | read + indexed (A-012) |
| 10823–10832 | read + indexed (A-001) |
| 10833–10848 | read + indexed (A-013) |
| 10849–10858 | read + indexed (A-014) |
| 10859–10871 | read + indexed (A-015) |
| 10872–10889 | read + indexed (A-016) |
| 10890–10900 | read + indexed (A-017) |
| 10901–10918 | read + indexed (A-018) |
| 10919–10934 | read + indexed (A-019) |
| 10935–10951 | read + indexed (A-020) |
| 10952–10958 | read + indexed (A-021) |
| 10959–10970 | read + indexed (A-022) |
| 10971–10982 | read + indexed (A-023) |
| 10983–10995 | read + indexed (A-024) |
| 10996–11012 | read + indexed (A-025) |
| 11013–11025 | read + indexed (A-026) |
| 11026–11039 | read + indexed (A-027) |
| 11040–11046 | read + indexed (A-028) |
| 11047–11058 | read + indexed (A-029) |
| 11059–11076 | read + indexed (A-030) |
| 11077–11093 | read + indexed (A-031) |
| 11094–11107 | read + indexed (A-032) |
| 11108–11116 | read + indexed (A-033) |
| 11117–11125 | read + indexed (A-034) |
| 11126–11134 | read + indexed (A-035) |
| 1–594, 684–6489, 6570–6896, 6967–7104, 7178–7473, 7610–10025, 10182–10382, 10427–10482 | ไม่ได้ index (gap — ดูส่วน 7) |

## 6. Ledger entries

F-xxx = frozen `getoutofmywaybotkaikrook.md` (อ่านจริง 1–240); A-xxx = active `getoutofmywaybotkaikrook2.md` — exact ranges ในคอลัมน์ `lines` (A-001..A-019 ครอบหลายช่วง) — ช่วงบรรทัดตรวจกับต้นฉบับแล้ว

| id | lines | task / date | category | summary | status | superseded-by / note |
| --- | --- | --- | --- | --- | --- | --- |
| F-001 | 1–34 | protocol / freeze 2026-09-17 | decision/approval | ไฟล์ freeze; งานใหม่เขียนใน file 2; ลำดับงาน C→A→B→D→Q14→Replay UI; **ไม่มี Phase 4 contract** ใน 1–240 | verified | — |
| F-002 | 38–56 | C context loss | passed behavior | `conversation_products.py` timeline anchor/suggestion; active = anchor ล่าสุด else suggestion; `[สินค้า: id]` จาก messageService; Q1–Q4 ผ่าน | verified | — |
| F-003 | 58–62 | A claim trigger | passed behavior | คำถามรับประกันเข้า claim flow ผิด → warranty detection จับก่อน; Q11 ผ่าน | verified | — |
| F-004 | 64–70 | B claim cascade | passed behavior | claim state machine เลิก flow ได้; Q12 trust, Q13 compat ไม่ถูกดัก | verified | — |
| F-005 | 72–76 | D trust | passed behavior | แก้ prompt/context ตอบ authenticity/shipping/sealed/warranty; Q5,Q8,Q9 — evidence บางในบรรทัดนี้ | historical-unverified | — |
| F-006 | 78–92 | Q14 ดึงผิดรุ่น | regression lock | root cause 4 จุด: CONV-ACTIVE หลัง history block, "ดูสินค้า" ใน new_topic_kws, `_ref_regex_products` reset, fetch_products ทับ; routing ผ่าน (products=1 BioKoop) แต่ LLM 429 → **answer ไม่ verify**. อย่าให้ active anchor ถูกทับ | historical-unverified | — |
| F-007 | 94–113 | Order lookup | passed behavior | `order_store.py` + `extract_order_sn`/`lookup_order`/`build_order_context`; flow ผ่าน (found / not-found) แต่ LLM 429 → answer ไม่ verify | historical-unverified | — |
| F-008 | 115–126 | Ticket panel order history | passed behavior | API orders route + `OrderHistorySection`; build ผ่าน, manual UI ไม่ verify; join `customer_id`=`buyer_user_id` (buyer_user_id 0/None เชื่อมไม่ได้) | historical-unverified | — |
| F-009 | 128–147 | Q2/Q6/Q7 | passed behavior | desc_kw ขยาย, "เปลี่ยน" ออกจาก warranty kw, State 6 post-handoff (บอทหยุดตอบหลัง handoff), prompt อนุญาต history สินค้าเดียวกัน; Q2,Q6,Q7 ผ่าน | verified | — |
| F-010 | 149–160 | Replay UI | passed behavior | `run_conv` + `?history=1` + 3 tabs; typecheck/build ผ่าน, ผู้ใช้ยังไม่ทดสอบจริง | historical-unverified | — |
| F-011 | 162–188 | Phase 2Z++++ 2026-09-07 | regression lock | `is_target_device_kw` เพิ่ม regex `^1[1-7][฀-๿]+$` + `ไอโฟน\s*\d+` กัน "13คะ" ทำให้ข้าม CONV-ACTIVE; unit 14 cases ผ่าน, replay จริงยังไม่ verify. **ประวัติขยาย regex/keyword เฉพาะ case — สนับสนุนกฎ: ห้ามเพิ่ม semantic table/regex โดยไม่ขออนุญาต** (ดูเพิ่ม F-006 `new_topic_kws`, F-009 `desc_kw`) | historical-unverified | — |
| F-012 | 190–216 | Phase 2Z++++ (duplicate) | failed/rejected approach | เนื้อหาซ้ำ F-011 ทุกบรรทัด | superseded | superseded-by: F-011 — duplicate, ไม่มี info ใหม่ |
| F-013 | 218–240 | Phase 3C order lookup ครบ + order anchor 2026-09-07 | pending/deferred work | `[order: sn]`, ฟิลด์ order เพิ่ม, order anchor, ส่งเลข order เฉยๆ → ตอบรับสั้นไม่เรียก LLM, `order_sn` ใน ChatRequest; py_compile/tsc/lookup ผ่าน; **หัวข้อยังต่อหลังบรรทัด 240 และยังไม่ indexed (gap ส่วน 7)** | historical-unverified | — |
| A-001 | 10823–10832 | waythrough protocol correction 2026-11-03 | decision/approval | ผู้ใช้อนุมัติเปลี่ยนกฎข้อ 8 เป็น ledger + incremental tail; แยก integrity prefix ออกจาก semantic coverage; docs only | verified | — |
| A-002 | 595–683 | Phase 4A/4B design 2026-10-19 | invariant | generation precedent: `exports/gen/<gid>` + `sellable_units_g<gid>` + pointer `sellable_units_meta{_id:"active"}` fenced CAS (bootstrap `$exists:false`, previous embedded = rollback target), manifest finalize+verify ก่อน CAS, verify-ก่อน-replace, `image_texts_g<gid>` per-gen published vs shared cache, grace 24h cleanup, fail-closed ห้าม fallback base coll; request snapshot resolve 1×/request | verified | — |
| A-003 | 6490–6569 | Phase 7 R1–R3 evidence boundary | invariant | closed emit `_EVIDENCE_OUT_FIELDS`; `_EVIDENCE_TEXT_KEYS` precedence → `payload["text"]`; `_EVIDENCE_RECORD_BYTES` bound + byte-boundary cut + `evidence_truncated:*`/`record_too_large`; `request_id` attribution ก่อน compile ถูกลบออกจาก final; kinds closed รวม `"kb"`; compile owner เดียว | verified | — |
| A-004 | 6897–6966 | master-plan backlog 2026-10-21 | decision/approval | `kb_source` = legacy\|zaapi atomic, ไม่มี both/silent fallback, inactive backend zero reads; 118 sources → `zaapi_kb_raw_sources` + `zaapi_kb_records` + immutable embedding generations; Zaapi adapter เข้า pool/selection/answer owner เดิม | verified | — |
| A-005 | 7105–7177 | master-plan rebaseline + Phase 10B r12/final acceptance | invariant | typed `subject_refs` identity authority; per-need scope gate; structured composition provenance segments; canonical subtype owner ใช้ structured fields (precedent: typed refs เท่านั้น ไม่ parse prose) | verified | — |
| A-006 | 7474–7609 | Phase 10B gen build + CAS preflight + rehearsal | passed behavior | NEW_GID build+validate (28,072 units/27,183 desc/13,823 it/11,792 prod); CAS BLOCKED — pointer อยู่ shared prod Mongo (digital.in.th live traffic) → disposable-only precedent; local-Docker rehearsal PASSED (fenced CAS + rollback); `_canon_iid` digit-only fail-closed | verified | regression-lock aspect: disposable-only precedent อยู่ใน summary |
| A-007 | 10026–10117 | Mongo clean slate + workflow R2/R3 | passed behavior | user-approved Mongo write precedent (clean slate + import corpus); idempotent import `already_applied`; workflow scope เท่านั้น — ไม่กระทบ Phase 4 KB | verified | — |
| A-008 | 10118–10181 | Workstream E P1/P2a + pool matrix | invariant | `pool_sources()`/`source_enabled()`/`kb_enabled()`/`kb_source()` (invalid→legacy); `setKbSource` CAS gated `zaapiKbReady`; legacy `zaapi_kb` = 8,600 docs บน shared digital.in.th/chatbot — Phase 4 ห้ามแตะ; `kb_zaapi.py` adapter kind `kb_zaapi` ∉ `_SUPPORTING_KINDS`; scope-gate/dead-intent findings | verified | regression-lock aspect: Phase 4 ห้ามแตะ legacy/adapter อยู่ใน summary |
| A-009 | 10383–10426 | Zaapi-primary evidence + Task 2 | decision/approval | Zaapi KB = factual authority สเปก/compat/FAQ/troubleshooting แต่ไม่เปิดเดี่ยว (คู่ catalog+units ใน Task 5); master-plan order: typed evidence → canonical import → KB embeddings → identity-bound retrieval → source policy | verified | — |
| A-010 | 10483–10525 | Task 3 raw+canonical impl | invariant | raw/canonical split, deterministic serialize/fingerprint, full-source validation ก่อน publish pointer, checkpoint/resume, invalid/conflicted/unresolved ไม่ publish; findings: one-shot cursor, snapshot integrity, CAS fence | verified | — |
| A-011 | 10526–10750 | Task 3 correction/second review (อ่านใน Phase 4 dev session เดิม) | invariant | per-row checkpoint, snapshot/pointer integrity, sanitization bijection (xlsx text = exact permutation ของ field lines), CAS fence+race convergence, source replacement = full snapshot ภายใต้ selected source_id, filename = audit metadata only | verified | passed-behavior aspect อยู่ใน summary |
| A-012 | 10751–10822 | Task 3 closeout + Phase 4 Gate 0/1 + ledger protocol | decision/approval | BSON 16MiB gate + `_id==record_id==hash`; collections: `zaapi_kb_raw_sources`/`zaapi_kb_records`/`zaapi_kb` legacy untouched/`zaapi_kb_embedding_generations` (Task 4); commits b072bd8+7a4e402; Gate 0: Docker down/ไม่มี mongod/mongomock; census 8,600 rows→112,974 deliveries, tokenizer p95 654/max 2,727/0 >8192; rev.2/3: semantic_digest ≠ content_fingerprint, reuse `KbEvidenceResult`, pin canonical gen, ไม่มี state machine, payload `{"text"}` | verified | passed-behavior aspect อยู่ใน summary |
| A-013 | 10833–10848 | Phase 4 Gate 1 final architecture task 2026-11-03 | pending/deferred work | task appends เท่านั้น: "กำลังจะทำ" (baseline 22fdce9 + protocol verified) + closeout (targeted ranges → A-002..A-012, verdict `PHASE_4_GATE1_FINAL_ARCHITECTURE_READY_FOR_APPROVAL`, รอ independent review); ไม่มีโค้ดเปลี่ยน | historical-unverified | รอ reviewer approve รายงาน |
| A-014 | 10849–10858 | Phase 4 Gate 1 contract correction 2026-11-03 | decision/approval | correction findings ล็อก contract: (1) manifest = `_id`/`schema_revision`/`sources`/`generation`, `generation==fingerprint(sources)` (schema.py:23,473); pin = canonical_generation/schema_revision/sources+record_set_digest (2) pointer `revision:int` ABA-fence (filter rev+gid, +1/write; matched=0→reread→conflict; no retry) (3) producer record ไม่ใส่ `request_id`/`need_indices` — pool stamp→`_attribute`→compiler ลบ (candidate_pool.py:255-259, executor:301/321, answer_context:505) (4) channel failure A–D truth table (5) artifacts = `exports/zaapi_kb_gen/<gid>/<fixed filename>` closed set (6) phases 4A mongo-fidelity/4B raw census/4C canonical corpus/4D benchmark | verified | contract findings — ไม่ใช่ test evidence |
| A-015 | 10859–10871 | Phase 4 design spec written 2026-11-04 | decision/approval | Gate 1 review passed → design spec `docs/plans/2026-11-04-phase4-zaapi-canonical-retrieval-design.md` (532 บรรทัด, 20 sections ครบ) — docs only; record fields จริง verify แล้ว (RecordType 6 ค่า, subject_id/target_id scalar, facts={key,value} unique-key); placeholders=0, ไม่มี runtime wiring ใน scope; verdict `PHASE_4_DESIGN_SPEC_READY_FOR_USER_REVIEW` | superseded | superseded-by: A-016 — scope normalization ใน entry นี้ผิด |
| A-016 | 10872–10889 | Phase 4 design spec contract correction 2026-11-04 | decision/approval | independent review 5 findings แก้ใน spec: (H1) `record_map` self-contained `{vector_index,text,records[{record_id,scope,item_id,model_id,subject_id,target_id}]}`, producer mapping exact (`item_id`←`item_id`, `identity`←`subject_id`→`model_id`, `target`←`target_id`, `model_codes`/`aliases` retrieval-only), canonical touch points = build+publish เท่านั้น (pinned-record = build/publish validation ไม่ใช่ runtime) (M1) scope ตาม `account_scope_fingerprint` จริง — shop `" ".join(split())` case-sensitive / platform `strip().casefold()` (schema.py:76-84) (M2) reproducibility boundary — digests/map/index deterministic, vector bytes same-runtime เท่านั้น, ไม่มี gen-doc digest (M3) manifest = 3 payload roles ไม่มี self-hash, gen doc เป็น owner ของ manifest hash, validation chain 3 ชั้น (P1) A-015 → superseded; tests §16 +7 items | verified | corrections ยังอยู่ใน spec; second review เพิ่ม findings → แก้ใน A-017 |
| A-017 | 10890–10900 | Phase 4 design spec final boundary correction 2026-11-04 | decision/approval | second review 3 findings: (M1) query contract → `retrieve(snapshot, *, shop, platform, typed-ref kwargs, semantic_query, limit=EVIDENCE_LIMIT)` — malformed → ว่าง+`invalid_query` ไม่ raise; valid-no-input → `no_query`; whitespace-only semantic = ไม่มี channel; duplicate refs = no-op (M2) scope owner เดียว `canonical_delivery_scope` ใน `kb_zaapi_schema.py` — `account_scope_fingerprint` reuse, generation/retrieval เรียก function เดียว; budget: data-contract fn +1 / callsites −2 / trust-boundary validation +1 (P1) A-016 status นอก enum → `historical-unverified`; tests §16 +4 (28–31) | verified | historical protocol exception — raw log ขาด "กำลังจะทำ" pre-work entry (บันทึกตามจริงภายหลังใน A-018 range); ไม่อ้าง protocol ผ่าน |
| A-018 | 10901–10918 | Phase 4 design spec typed-index/model/bootstrap/manifest correction 2026-11-04 | decision/approval | review 4 findings: (H1) `structured_index` → namespaced closed set 6 fields (`item_id`/`model_id`/`model_code`/`alias`/`subject_id`/`target_id`), channel อ่านเฉพาะ namespace ตัวเอง, posting sorted+unique (H2) model pin ครบ `{name,revision:immutable,sentence_transformers_version,dim,normalize_embeddings,output_dtype}` — build reject ถ้า revision resolve ไม่ได้, mismatch → `semantic_unavailable` (H3) bootstrap = `find_one`→validate→`insert_one` เท่านั้น ห้าม upsert — corrupt pointer fail closed ไม่ repair (M1) manifest closed schema exact per role (`schema_version`/`generation_id`/plain int/`field_count==6`/deterministic); ledger categories A-016/A-017 → `decision/approval`; tests §16 +5 (32–36) | verified | — |
| A-019 | 10919–10934 | Phase 4 design spec model-loader/scoped-ranking/pointer-schema correction 2026-11-04 | decision/approval | review 5 findings: (H1) model compat check ครบ 6 fields รวม `name` (H2) loader contract — `embedding.py` singleton เดียว `SentenceTransformer(MODEL_NAME, revision=MODEL_REVISION)`; gen doc เก็บ identity ที่ loader ใช้จริง; ห้าม loader/resolver ที่สอง; ST pin exact (dep เดิม); SRS note; revision จริง audit+lock ก่อน 4C (H3) scoped ranking — scope filter ก่อน rank/limit; foreign scope ไม่กิน quota; `limit` ท้ายสุด (M1) pointer closed schema exact (int≥1 non-bool / GEN_ID_RE / previous None\|GEN_ID_RE / 64-char lowercase hex / UTC ISO-8601); bootstrap previous=None (M2) ledger enum cleanup — column `superseded-by/note`, composite categories → primary, annotated statuses → exact enum, A-017 protocol exception note; ลบ redundant `counts` จาก gen doc; tests §16 +3 (37–39) | verified | — |
| A-020 | 10935–10951 | Phase 4 design spec shared-embedding compat + ledger enum correction 2026-11-04 | decision/approval | review 3 findings: (H1) shared-embedding compatibility gate — `embedding.py` = shared singleton (product_store `embed_query`/units `embed_query`/knowledge_base QA `embed_texts`+`embed_query`+lazy mtime cache/`build_embeddings`/`app` warmup/tokenizer); pin `MODEL_REVISION` เปลี่ยน vector space ของ `.npz` artifacts เดิมที่ไม่มี identity proof → gate ก่อน shared pin มีผล (resolve commit/pin ST/census callsites/rebuild-or-prove-identity/validate-ก่อน-serve/QA cache reset); Phase 4 standalone build ได้แต่ production activation block จน Task 5 gate; commit code ≠ deploy safety; unknown/mismatch → vector channel fail closed (M1) dependency packaging — exact ST version owner เดียว = `requirements.txt`, ลบ unpinned install ใน `docker/Dockerfile.chatbot`, container build พิสูจน์ installed==gen-doc, dep +0 (M2) F-012 category `superseded`→`failed/rejected approach`; tests §16 +1 (40) | verified | raw closeout census (32 rows) เป็น pre-append count — แก้โดย A-021 โดยไม่เปลี่ยน raw history |
| A-021 | 10952–10958 | ledger census accuracy correction 2026-11-04 | decision/approval | correction note: closeout A-020 เขียน census = 32 rows (pre-append count — นับก่อนเพิ่ม entry) — post-A-020 จริง = 33 rows {categories: decision/approval 12, failed/rejected approach 1, invariant 6, passed behavior 10, pending/deferred work 2, regression lock 2} {statuses: verified 18, historical-unverified 13, superseded 2}; BAD = 0 — enum validity เดิมยังถูกต้อง; แก้เฉพาะ census count + metadata, ไม่เปลี่ยน architecture/spec, ไม่แก้ raw log ย้อนหลัง | verified | historical protocol exception — raw entry รวม "กำลังจะทำ + ผ่านแล้ว" ไว้ block เดียว ไม่พิสูจน์ลำดับ 8H; ไม่อ้าง protocol รอบนี้ผ่าน; corrected-by: A-022 |
| A-022 | 10959–10970 | waythrough protocol closeout correction 2026-11-04 | decision/approval | แก้เฉพาะ protocol bookkeeping: A-021 raw entry รวม pre-work/closeout block เดียว (ไม่พิสูจน์ลำดับ 8H) → A-021 note = historical protocol exception; รอบนี้ append "กำลังจะทำ" (10959–10963) ก่อนแก้ ledger และ "ผ่านแล้ว" (10964–10970) หลังตรวจ — แยก heading/ช่วงเวลาจริง; ไม่แก้ raw ย้อนหลัง, ไม่เปลี่ยน spec/architecture; raw closeout ไม่เขียนตัวเลข census (เลิก off-by-one loop) | verified | — |
| A-023 | 10971–10982 | Phase 4 design spec verdict receipt + commit 2026-11-04 | decision/approval | verdict PHASE_4_DESIGN_SPEC_INDEPENDENT_PRECOMMIT_REVIEW_PASSED received → A-016..A-022 statuses → verified (A-017/A-021 keep protocol-exception notes; A-013 คง historical-unverified, A-015 คง superseded); commit 0f919f1 รวม spec+ledger+log 3 files (git stat ยืนยัน — raw closeout บันทึก intent "staging เฉพาะ spec" แต่จริง commit รวม dirty docs ตาม protocol); ไม่แตะ production code/test/SRS | verified | — |
| A-024 | 10983–10995 | Phase 4 implementation plan drafted 2026-11-04 | decision/approval | callsite census → dispositions (reuse/owner move `load_active_state`→schema impl ชุดเดียว/new owners ×2 `kb_zaapi_generation`+`kb_zaapi_retrieval` DAG gen→retrieval→schema/ห้ามแตะ `app.py:1218`+`kb_zaapi.py`+`generation_pointer.py`+shared npz/deferred Task 5); plan file `docs/plans/2026-11-04-phase4-zaapi-canonical-retrieval-implementation.md` — 18 tasks ×13 fields, locked interfaces, §16 coverage map 40 items, 16 commit boundaries, gates 4A–4D stop conditions; user guards: single-owner move, fake Mongo reuse `GenColl/GenDb` ห้ามชุดที่สี่, MODEL_REVISION resolve-from-loaded-snapshot ห้าม refs-main-as-proof, baseline 416 preserved; docs only ไม่แตะ production/test/SRS ไม่รัน Mongo/provider/Docker — รอ independent review | historical-unverified | independent review = `PHASE_4_IMPLEMENTATION_PLAN_REVIEW_FAILED_CORRECTION_REQUIRED` (2H/3M) — corrections ใน A-025; ยังไม่ approve plan |
| A-025 | 10996–11012 | Phase 4 plan review corrections applied 2026-11-04 | decision/approval | verify-genuine-then-fix: H1 `require_disposable_uri` loopback-literal gate ก่อน `MongoClient` (T10 RED + global constraint) + T13/T15 inject colls เข้า `import_source` ตรง ห้าม ambient `--apply`/`ADMIN_MONGO_URI`; H2 `retrieve_active` entrypoint → load failure = `KbEvidenceResult` ว่าง + `generation_unavailable` trace (§14:500 contract; result type +0); M1 `docs/test/mongo_doubles.py` neutral owner — 9 defs verbatim move, donors re-import, T1 มี RED จริง; M2 approval = manual stop ไม่มี code; T4 `local_files_only=True` ก่อน; M3 +Task 13B packaging py3.11 ใน Docker window 4A; doc accuracy: T6 retitle/T14 census committed/19 tasks×13 fields/725 lines; Low 2 รายการไม่พบในไฟล์ (T3 Owner dup, T13 seed dup) — รายงานตามจริง; docs only | verified | plan ยังไม่ approve — second review พบ 1H/2M เพิ่ม (A-026) |
| A-026 | 11013–11025 | Phase 4 plan second-review corrections 2026-11-04 | decision/approval | verdict SECOND_REVIEW_FAILED → fix: (H) `require_disposable_uri` = proven `validateLoopbackMongoUri` contract (log:3605) — `mongodb://`/single loopback/explicit port≠27017/no creds,query,multi-host,db-path + generated `zaapi_kb_p4_verify_<rand>` DB + refusal matrix assert `MongoClient` 0 calls; (M) T13B `--network none`+`--no-index`+pip-cache mount ก่อน → ไม่ครบ=STOP ขอ network approval แยกจาก Docker; (M) budget itemized — spec §17 rows แยก declared additions (validators+3 §10–12, retrieve_active+1 §14, model_identity+1 §13, MODEL_REVISION+1) + review-mandated (uri-validator+1, mongo_doubles test-only+1); ไฟล์ 755 lines/19 tasks×13 fields; docs only | verified | plan ยังไม่ approve — third review พบ 1H/2M/1L เพิ่ม (A-027); pip-cache mount approach ใน entry นี้ถูกแทนด้วย wheelhouse ใน A-027 |
| A-027 | 11026–11039 | Phase 4 plan third-review corrections 2026-11-04 | decision/approval | verdict THIRD_REVIEW_FAILED → fix 4 จุดเท่านั้น: (H) validator เดิม → `require_disposable_target(uri, db_name)` pair (count +1 คงเดิม), CLI `--db-name` required, harness สุ่ม `zaapi_kb_p4_verify_<rand>` ครั้งเดียว pass ทุก command (cross-invocation consistency test), db_name closed pattern, refusal ยัง assert client 0 calls; (M) T13B → wheelhouse `--no-index --find-links=/wheelhouse` หรือ STOP (ลบ pip-cache mount — `--no-index` มองไม่เห็น HTTP cache); (M) `docker image inspect` local gate ก่อน pull/run ทั้ง mongo:7+python:3.11-slim — Docker/pull/network = 3 approval ชั้น; (L) cleanup scoped `rm -fv`+`ps --filter name=zaapi-p4`+`volume ls --filter` → 0 ใน scope ไม่นับทั้งเครื่อง; ไฟล์ 765 lines/19 tasks×13 fields; docs only | verified | plan ยังไม่ approve — fourth review พบ 1H/1M/1L (A-028); cleanup ใน entry นี้ถูกแทนด้วย `--tmpfs` approach (A-028) |
| A-028 | 11040–11046 | Phase 4 plan fourth-review corrections 2026-11-04 | decision/approval | verdict FOURTH_REVIEW_FAILED → fix call syntax/คำสั่งเท่านั้น: (H) callsite 4 จุด → pattern เดียว `safe_uri, safe_db = require_disposable_target(uri, db_name)` → `MongoClient(safe_uri)[safe_db]` (audit-table/T13 header/T13 seed/T15 — เดิม tuple-เข้า-client/index ซ้ำ/single-arg), ไม่มี helper เพิ่ม; (M) T13B online command แยกชัดเจน — `docker run --rm -v "$PWD:/repo" -w /repo python:3.11-slim sh -c "pip install -r requirements.txt && ..."` ไม่มี wheelhouse mount/`--find-links`; (L) `--tmpfs /data/db` → ไม่มี anonymous volume → cleanup proof = named container+named-filter เท่านั้น; ไฟล์ 771 lines/19 tasks×13 fields; docs only | verified | — |
| A-029 | 11047–11058 | Phase 4 plan fifth-review corrections 2026-11-04 | decision/approval | verdict FIFTH_REVIEW_FAILED → fix lifecycle gap เท่านั้น (1 High): T13 ลบ `zaapi-p4-test` แต่ T15/T16 ต้องใช้ Mongo ต่อ → lock lifecycle: T15 spin `zaapi-p4-corpus` ใหม่หลัง approval (image-inspect + `--tmpfs` + สุ่ม port/db_name ครั้งเดียว) ใช้ target เดิมตลอด T15–T16; T15 ห้าม cleanup เมื่อผ่าน; T15 fail ก่อน T16 → failure cleanup ทันที; T16 cleanup `zaapi-p4-corpus` ใน `finally` ทั้ง success/failure + scoped proof = 0; lifecycle rule ใน global constraints; ไม่มี helper/owner/mechanism เพิ่ม; ไฟล์ 772 lines/19 tasks×13 fields; docs only | verified | — |
| A-030 | 11059–11076 | Phase 4 Task 1 implementation — neutral mongo_doubles + Phase 4 helpers 2026-11-04 | passed behavior | approved scope 10 defs (9 + `_AdminNs` companion): RED จริง 5 failed (ModuleNotFoundError ×4 + behavioral `phase4b import pulled the donor side-effect module` — `[KEYS]` line พิสูจน์ app-import side effect); GREEN: `docs/test/mongo_doubles.py` เจ้าของเดียว (verbatim move — GenColl ลบเฉพาะ late `_match` imports ×3), donors re-export `is`-identity parity (replay 8 ชื่อ + `_AdminNs`, p4b 5 ชื่อ), `zaapi_phase4_helpers.py` (record/manifest_for/stub_embed/block_network — lazy schema imports, fingerprint/revision ผ่าน schema owner เดิม); verify: isolation 5/5, regression 9 files = 709 passed/0 failed, baseline 416 คงเดิม, executable census single-owner (AST+`__module__`), diff --check OK, production bytes = 0; pre-existing identical `_norm` ใน `validate_legacy_turn_fixtures.py` = HEAD เดิม นอก scope; ยังไม่ commit — รอ independent review `PHASE_4_TASK_1_NEUTRAL_MONGO_DOUBLES_READY_FOR_INDEPENDENT_REVIEW` | verified | งานค้าง = Task 2 เท่านั้น |
| A-031 | 11077–11093 | Phase 4 Task 2 implementation — `canonical_delivery_scope` owner consolidation 2026-11-04 | passed behavior | RED 4 tests → 2 failed จริง (ImportError/AttributeError) + 2 passed parity/boundary locks; GREEN: `canonical_delivery_scope` (pure — callers validate types) เพิ่มใน `kb_zaapi_schema.py` + แทน inline normalization 2 จุดใน `account_scope_fingerprint` (`*`-unpack คง identity triple); uses-owner spy พิสูจน์ rewire จริง (2 calls/account); fingerprint parity คงเดิม — normalization bytes-identical; SRS §6.34c +row + Calls cell; verify: scope 4/4, regression 425 passed/0 failed, baseline 416 คง, py_compile/diff --check OK, `" ".join` เหลือเฉพาะ owner fn; delta: normalization fn +1 (budgeted), callsites −2, owners +0; production delta = schema ไฟล์เดียว +11/−4; ยังไม่ commit — รอ independent review | verified | งานค้าง = Task 3 (`load_active_state` move) เท่านั้น |
| A-032 | 11094–11107 | Phase 4 Task 3 implementation — `load_active_state` owner move importer→schema 2026-11-04 | passed behavior | RED 2 tests → `AttributeError` จริง; GREEN: ย้าย verbatim → `kb_zaapi_schema.py:527` (deps same-module), importer re-export (`is`-identity), exporter import ตรงจาก schema; behavioral test = GenDb-seeded coherent state (GenColl read path รองรับ `find`/`$in`; `$setOnInsert` ขาด → seed ตรงไม่รัน import_source); `def load_active_state` = 1 impl ทั้ง repo; verify: scope 6/6, regression 427/0, py_compile ×3, SRS owner updated; delta: owners +0 (move) functions +0 net; commit `…` | verified | งานค้าง = T4→T18 |
| A-033 | 11108–11116 | Phase 4 Task 4 implementation — model identity audit + pin 2026-11-04 | passed behavior | audit evidence จริง (ห้าม placeholder): ST `5.7.0`, snapshot_download local-only → `5617a9f61b028005a4858fdac845db406aefb181`, `HF_HUB_OFFLINE=1` offline load proven 1024d; RED 2 (AttributeError) → GREEN: `MODEL_REVISION` 40-hex, `_get_model` +`revision=` (loader เดียว), `model_identity()` 6 fields ผ่าน importlib.metadata; requirements.txt +`sentence-transformers==5.7.0` (owner เดียว dep +0), Dockerfile ลบ unpinned ST (คง pythainlp/rapidfuzz); verify: scope 8/8, regression 571/0, live identity check OK; delta: constant +1, accessor +1, dep +0 | verified | งานค้าง = T5→T18 |
| A-034 | 11117–11125 | Phase 4 Task 5 implementation — closed-schema validators ×3 2026-11-04 | passed behavior | RED 4 → GREEN: `validate_gen_pointer`/`validate_gen_doc`/`validate_artifact_manifest` ใน `kb_zaapi_schema.py` (spec §10–§12) — exact key sets, `GEN_ID_RE` reuse (ไม่มี regex ใหม่), revision ABA int≥1, ISO-8601 UTC stdlib, canonical_generation==fingerprint(sources), model 6-field pin, file==role.format, field_count==6; +`_sha256_hex` primitive +2 constant tables; verify: gen suite 12/12, regression 748/0 | verified | งานค้าง = T6→T18 |
| A-035 | 11126–11134 | Phase 4 Task 6 implementation — generation builders + atomic artifact writers 2026-11-04 | passed behavior | RED 9 → GREEN: `kb_zaapi_generation.py` (owner 1 ของ 2) — `semantic_text` locked v1 renderer, `semantic_digest`/`record_set_digest`, `build_record_map` (projections 7f, scope ผ่าน `canonical_delivery_scope`), `build_structured_index` (6 ns sorted+unique), `build_manifest_payload`, `_sha256_file` pattern-copy, `_write_artifact` tmp→verify→os.replace; helpers +`write_gen_dir`; verify: gen suite 13/13, regression 757/0 | verified | งานค้าง = T7→T18 |

## 7. Known semantic coverage gaps

- frozen 241–8624 ไม่ได้ index (F-013 ปิดที่ 240 แต่หัวข้อ Phase 3C ยังต่อหลัง 240)
- active gap ที่ยังไม่ได้ index: 1–594, 684–6489, 6570–6896, 6967–7104, 7178–7473, 7610–10025, 10182–10382, 10427–10482 — targeted coverage เท่านั้น ห้ามอ้าง full audit
- Q14 / order (F-006, F-007) ระดับ answer ไม่ verify เพราะ provider 429
- ไม่ใช้ `/tmp/p4ledger/ledger.md` (ไม่ได้ตรวจ checksum/ต้นฉบับ)

## 8. Update procedure

ก่อนงาน:
1. frozen: `wc -l -c` + `shasum -a 256 getoutofmywaybotkaikrook.md` ต้องตรงส่วน 2 (ไม่ตรง → หยุด)
2. active: `head -n <active_integrity_prefix_lines> getoutofmywaybotkaikrook2.md | shasum -a 256` ต้องตรงส่วน 2 (ไม่ตรง → หยุด)
3. อ่านเฉพาะ tail: `sed -n '<N+1>,$p' getoutofmywaybotkaikrook2.md`; ถ้ามี tail → สรุปเป็น entry + เพิ่มส่วน 5 ก่อนเริ่มงานใหม่
4. ประวัติที่ coverage ขาด: `grep -n` หา heading → `sed -n 'A,Bp'` อ่าน exact range → เพิ่ม entry + ส่วน 4/5/7

หลังงาน (บังคับ):
1. append closeout ลง active log (append สุดท้าย)
2. สรุป tail ที่เพิ่มใน task เข้า ledger เป็น entry exact range + อัปเดตส่วน 5
3. วัด EOF line/bytes + `shasum -a 256` ทั้งไฟล์ → อัปเดตส่วน 2 (`active_integrity_*`, recorded_at)
4. ห้ามให้ ledger อ้าง verified ถ้า evidence ไม่ผ่าน; ห้ามเขียน active เพิ่มหลังวัด baseline

ถ้างานหยุดก่อนอัปเดต ledger: session ถัดไปเห็น tail หลัง prefix เดิม ต้องสรุปก่อนเริ่มงานใหม่

integrity prefix กับ semantic coverage ห้ามใช้แทนกัน; migration ขยับเฉพาะ coverage ranges

## 9. Verification checklist

- [ ] frozen lines/bytes/sha ตรงส่วน 2
- [ ] active prefix sha (1..active_integrity_prefix_lines) ตรงส่วน 2
- [ ] tail ถูกอ่านและสรุปเป็น entry ก่อนเลื่อน integrity prefix
- [ ] ทุก entry เป็น exact inclusive range + category + status; `verified` มี evidence ใน raw log
- [ ] ก่อน `coverage: complete`: union ของ coverage ranges ครบทุกบรรทัดของ frozen และ active ไม่มี gap/overlap ที่อธิบายไม่ได้, integrity ทั้งสองตรง, independent review ผ่าน
