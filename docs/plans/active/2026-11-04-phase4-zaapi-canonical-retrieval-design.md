# Phase 4 — Zaapi Canonical KB Retrieval Design Spec

- วันที่: 2026-11-04
- สถานะ: design approved at architecture gate (Gate 1 independent review passed) — เอกสารนี้คือ design reference เดียวสำหรับ Phase 4A–4D ก่อนเขียน implementation plan
- Branch: `feature-botlogic-kb-workflow`
- เอกสารนี้ self-contained — ไม่ต้องอ่าน chat/log เพื่อเข้าใจ contract

## 1. Purpose

Task 3 สร้าง canonical Zaapi KB corpus (immutable raw rows + canonical records + global manifest) แล้ว แต่ยังค้นไม่ได้ Phase 4 ทำให้ canonical corpus ชุดนี้ค้นได้เต็มประสิทธิภาพในรูปแบบ standalone:

- **Exact typed lookup** — ค้นด้วย typed identity references (item/model/code/alias/subject/target) แบบ deterministic equality
- **Semantic retrieval** — ค้นด้วยข้อความดิบผ่าน BGE-M3 embeddings บน unique semantic digest
- Zaapi KB เป็น **factual authority** สำหรับ: specification, compatibility evidence, FAQ, troubleshooting, policy และ note ตาม `record_type` ของ canonical record (`RecordType` = spec/compatibility/faq/troubleshooting/policy/note)
- Phase 4 เป็น **standalone** — retrieval owner ทำงานอิสระ ทดสอบกับ disposable/local Mongo เท่านั้น
- Production จริง Zaapi KB **ต้องทำงานร่วมกับ Shopee catalog/units เสมอ** (identity/listing/link/variant/stock/price/status เป็น authority ของ catalog/units) — การเชื่อมนั้นเป็น Task 5+ รวม pool switch และ answer runtime ด้วย แต่ Phase 4 ต้องพิสูจน์ว่า KB retrieval ทำงานแยกได้ก่อน

## 2. Success criteria

เงื่อนไขผ่านแบบวัดได้ (ไม่เดาตัวเลข benchmark — ตัวเลขจริงมาจาก measurement gates ข้อ 15):

- canonical generation build ได้ **deterministic ใน scope ที่พิสูจน์ได้** — `semantic_text` bytes, `semantic_digest`, ordered record_ids, `record_set_digest`, `record_map`, `structured_index` และ vector row order (sorted digest) เหมือนเดิมทุกครั้งสำหรับ input เดียวกัน; vector bytes รับประกัน byte-identical เฉพาะภายใน runtime/model/device เดียวกันที่ measurement พิสูจน์ (ห้าม claim ข้าม hardware/runtime); `generation_id`, `created_at`, artifact paths เป็น per-attempt metadata — เปลี่ยนได้ทุก build และไม่มี gen-doc digest field
- exact lookup **deterministic** — query เดิม ผลเดิมทุกครั้ง (order + membership)
- semantic retrieval ใช้ **unique semantic digest** เป็น vector identity — ไม่ใช่ raw-row `content_fingerprint`
- generation เก่า **ทำงานต่อได้** ขณะรอ generation ใหม่ build/validate/canary/publish — Task 3 manifest update ไม่ทำให้ active retrieval หยุด
- build failure **ไม่แตะ active pointer** และไม่เขียน generation doc
- publish/rollback CAS ป้องกัน **stale writer และ ABA race**
- corruption → **fail closed** ตาม truth table ข้อ 14 — ไม่ fallback generation อื่นอัตโนมัติ
- **exact hits ยังใช้ได้** เมื่อ semantic model ล้ม (trace ชัด ไม่ silent)
- result ใช้ **`KbEvidenceResult` เดิม** — public result type +0
- ไม่มี keyword/regex/synonym/fuzzy/heuristic เพิ่ม
- artifact format เลือกจาก **measurement** ใน 4D ไม่ใช่สมมติฐาน
- **ไม่มี production/shared Mongo activity** ใน Phase 4 acceptance — disposable เท่านั้น

## 3. Scope และ non-goals

**In scope:**

- 4A disposable real-Mongo fidelity
- 4B source/raw census
- 4C canonical extraction/corpus
- 4D artifact/retrieval benchmark
- generation lifecycle (build → validate → ready doc → CAS publish → readback → rollback)
- standalone canonical retrieval (exact + semantic channels)
- exact/structured index ใน generation artifact
- semantic embeddings บน unique semantic digest
- validation / CAS / readback / rollback
- canary และ acceptance artifacts (gitignored)

**Out of scope:**

- `kb_source` activation และ `zaapiKbReady` gate flip
- runtime pool wiring / `let_ai_respond`
- `kb_zaapi.py` replacement (legacy adapter — ห้ามแตะ ห้ามใช้ใน Phase 4)
- catalog/unit join, product cards, Shopee link, stock, price
- answer composition
- UI upload / canonical tab
- deployment / production activation
- cleanup/retention implementation (ระบุ invariant เท่านั้น)
- system-prompt distillation
- log analytics
- workflow engine
- Task 5+ ทุกอย่าง

## 4. Existing owners และ reuse

**Reuse เป็น function จริง:**

| symbol | file | ใช้ทำอะไร |
|---|---|---|
| `canonical_json`, `fingerprint` | `chatbot/shopeechat/kb_zaapi_schema.py` | deterministic serialization/hash — `generation == fingerprint(sources)` invariant, `record_set_digest` |
| `canonical_record_id`, `raw_row_id`, `validate_record_provenance`, `validate_manifest`, `validate_manifest_records`, `build_revision` | เดียวกัน | record/revision identity + validation ใน build/validate path |
| `load_active_state` | ย้ายจาก `docs/zaapi/script/import_zaapi_kb.py` → `kb_zaapi_schema.py` | materialize active canonical records (importer, exporter, generation build ใช้ owner เดียว — runtime ห้าม import docs script) |
| `embed_texts`, `embed_query` | `chatbot/shopeechat/embedding.py` | BGE-M3 (1024d) — embed semantic_text / query |
| `GEN_ID_RE`, `mint_generation_id` | `chatbot/shopeechat/generation_pointer.py` | generation id mint/validation |
| `canonical_delivery_scope` (ใหม่) | `chatbot/shopeechat/kb_zaapi_schema.py` | pure data-contract owner เดียวของ delivery-scope normalization: `(shop, platform) → (" ".join(shop.split()), platform.strip().casefold())` — `account_scope_fingerprint` reuse function นี้, generation builder ใช้ตอนเขียน projections, retrieval ใช้กับ query scope — ห้าม inline ซ้ำ; **implementation รอบหลังต้องอัปเดต SRS** (เพิ่ม function ใน core schema file) |
| `KbEvidenceResult` | `chatbot/shopeechat/knowledge_base.py` | public result contract (`cards=()`, `attachment_evidence=()`, `supporting_evidence`, `raw_count`, `trace`) |
| executor → pool → compiler contract | `retrieval_executor.py` / `candidate_pool.py` / `answer_context.py` | `RetrievalExecutionResult.request_id` → pool stamp → `_attribute` → `_compile_evidence` closed schema |

**Reuse เฉพาะ pattern (เขียนใหม่ใน Zaapi owner):**

- product generation artifact write (tmp → verify → `os.replace` จาก `build_embeddings.py`)
- product CAS/rollback flow (`publish_generation.py`) — **ห้ามเรียก `cas_publish()` ตรง** เพราะผูก `sellable_units_meta` + product `_SNAPSHOT_FIELDS` + product rollback semantics
- manifest finalize/readback verification pattern

## 5. Architecture และ ownership

Owner ใหม่ 2 ตัวเท่านั้น (`load_active_state` ย้ายไป `kb_zaapi_schema.py` — schema owner เดิม ไม่ใช่ owner ที่สาม) + pure data-contract function เดียวใน schema owner:

- `canonical_delivery_scope(shop, platform) -> tuple[str, str]` ใน `kb_zaapi_schema.py` — owner เดียวของ scope normalization (shop whitespace-collapse case-sensitive / platform strip+casefold); callers: `account_scope_fingerprint` (reuse — ลบ inline expressions เดิม), generation builder (เขียน projections), retrieval (normalize query scope); data contract ไม่ใช่ heuristic — ห้าม callsite ใด inline ซ้ำ

```text
[Task 3 canonical state]
 zaapi_kb_records {active:manifest} ──► load_active_state() (kb_zaapi_schema.py)
        │                                   │
        │   ┌── kb_zaapi_generation.py (owner 1: lifecycle) ──────────────┐
        │   │ snapshot canonical pin → ordered record_ids → record_set  │
        │   │ semantic_text(record) → dedupe semantic_digest            │
        │   │ embed_texts (BGE-M3 1024d)                                │
        │   │ artifacts: vectors / record_map / structured_index        │
        │   │          + manifest.json (tmp → validate → atomic rename) │
        │   │ record_map = self-contained: digest→{vector_index,       │
        │   │   text, records[{record_id,scope,item/model/subject/     │
        │   │   target projections}]} — retrieval ไม่ต้องอ่าน Mongo    │
        │   │ insert gen doc _id="gen:<gid>" status="ready"             │
        │   │ publish: pre-check canonical → canary → ABA CAS → readback│
        │   │ rollback: validate previous → ABA CAS swap                │
        │   └───────────────────────────────────────────────────────────┘
        ▼                                    ▼
 zaapi_kb_embedding_generations      exports/zaapi_kb_gen/<gid>/ (immutable)
   {_id:"gen:<gid>" ...}               vectors.<fmt>
   {_id:"active", revision,            record_map.<fmt>
    generation_id, previous,           structured_index.<fmt>
    canonical_generation}              manifest.json
                     │
        ┌── kb_zaapi_retrieval.py (owner 2: standalone retrieval) ──┐
        │ load_active_generation(db) → snapshot (artifacts only)    │
        │ retrieve(snapshot, *, shop, platform, refs, query, limit) │
        │   structured ch: strip() → field namespace → record_ids   │
        │   semantic ch: embed_query → vectors → digest → records   │
        │   record_id→(digest,projection) derive จาก record_map     │
        │   scoped merge → limit ท้าย → evidence จาก projections    │
        └────────────────────────────────────────────────────────────┘
                     ▼
        KbEvidenceResult(supporting_evidence=(kind="kb" records))
                     ▼
        (Task 5) executor → pool stamp request_id → _attribute
                 → _compile_evidence → final closed schema
```

**Data-flow sequence:**

1. `build_generation`: `load_active_state` → validate manifest → pin (`canonical_generation`, `canonical_schema_revision`, `canonical_sources`) → เรียง `record_ids` deterministic → `record_set_digest`
2. ต่อ record: `semantic_text` → group by digest → unique texts = vector rows (sorted digest order)
3. `embed_texts` → vectors artifact + `record_map` (digest→text+record projections) + `structured_index` (6 namespaces × strip-normalized values→sorted unique record_ids) + `manifest.json` — เขียน temp dir → `validate_generation` → atomic rename → insert ready doc
4. `publish`: read gen doc → validate → pre-check `expected_canonical` → canary → ABA CAS → readback → post-read canonical comparison (`newer_canonical_pending`)
5. `retrieve`: `load_active_generation` → snapshot (artifacts เท่านั้น — หลัง publish ไม่อ่าน manifest/records ของ Task 3) → normalize query scope → structured (namespace→projections→scope filter→sort) + semantic (score→eligible digests→rank→eligible projections) → merge/dedupe → `limit` ท้ายสุด → materialize evidence fields จาก projections → `KbEvidenceResult`

## 6. Canonical input contract

Task 3 manifest (`zaapi_kb_records {_id:"active:manifest"}`) มี field จริงเท่านั้น:

```text
_id
schema_revision
sources          # {source_id: pointer} — pointer อ้าง immutable revision doc
generation       # fingerprint(sources)
```

**Invariant (บังคับ validator):**

```text
generation == fingerprint(sources)
```

**Generation pin (ใน gen doc):**

- `canonical_generation` = `manifest["generation"]` ณ ตอน build
- `canonical_schema_revision` = `manifest["schema_revision"]`
- `canonical_sources` = `manifest["sources"]` (copy)
- ordered record IDs (อยู่ใน `record_map` artifact — deterministic order)
- `record_set_digest` = `fingerprint(ordered record_ids)`
- `record_count`

**ห้ามใช้ field ที่ไม่มีจริง:** `manifest_sha256`, `manifest_revision` — ไม่มีใน manifest contract

`expected_canonical` ของ publish = ค่า `manifest["generation"]` ที่ build ใช้ · `newer_canonical_pending` = `current_manifest["generation"] != generation_doc["canonical_generation"]`

## 7. Semantic serialization contract

`semantic_text(record)` (อยู่ใน `kb_zaapi_generation.py`) render deterministic plain text จาก canonical semantic payload — renderer เดียวกันกับ evidence text (ไม่มี renderer ที่สอง):

**ลำดับ fields:**

1. `record_type`, `topic`
2. identity refs: `item_id`, `model_id`, `subject_id`, `target_id` (ลำดับคงที่, เฉพาะที่มีค่า)
3. `model_codes`, `aliases` (stored tuple order — canonical immutable)
4. `facts` — sorted by `fact["key"]` (keys unique ตาม schema); value ที่เป็น list คงลำดับเดิม
5. `steps` (คงลำดับ)
6. `answer_text`

**ไม่รวม:** `shop`, `platform`, source/sheet/row, provenance fingerprints (`source_fingerprint`, `scope_fingerprint`, `content_fingerprint`), `readiness`, `record_id`, filename, timestamps

**กฎ:**

- list-valued facts คงลำดับเดิม (ไม่มี set semantics)
- ไม่ casefold, ไม่เพิ่ม synonym/keyword/regex/synonym table
- `semantic_digest` = SHA-256 ของ rendered `semantic_text` — canonical semantic payload authority เดียว
- vector มาจาก `embed_texts(semantic_text)` — deterministic rendered text ของ payload เดียวกัน
- `content_fingerprint` เป็น raw-row identity — **ไม่ใช่ vector identity**
- semantic เหมือนกันจริงเท่านั้นจึง share vector — record mappings เก็บ scope+record_ids แยกจาก vector

**Truth table:**

| เคส | semantic_digest | vector |
|---|---|---|
| canonical semantics เหมือนกันทุกประการ | เดียวกัน | share 1 vector |
| ต่างเฉพาะ scope (shop/platform) | เดียวกัน | share — scope อยู่ใน `record_map` |
| ต่างเฉพาะ provenance (source/sheet/row) | เดียวกัน | share — provenance อยู่ audit/trace |
| identity refs ต่าง (item/model/subject/target) | ต่างกัน | คนละ vector |
| facts/answer_text/steps ต่าง | ต่างกัน | คนละ vector |
| list-valued fact ลำดับต่าง | ต่างกัน | คนละ vector |
| raw row เดียวกันแต่ canonical extraction ต่าง | ต่างกัน | คนละ vector — raw row ≠ vector identity |

## 8. Query contract

Single function signature (ห้ามสร้าง public query dataclass/type ใหม่ — kwargs เดียว):

```python
def retrieve(
    snapshot,                          # จาก load_active_generation — artifacts only
    *,
    shop: str,
    platform: str,
    item_ids: tuple[str, ...] = (),
    model_ids: tuple[str, ...] = (),
    model_codes: tuple[str, ...] = (),
    aliases: tuple[str, ...] = (),
    subject_ids: tuple[str, ...] = (),
    target_ids: tuple[str, ...] = (),
    semantic_query: str | None = None,
    limit: int = EVIDENCE_LIMIT,       # answer_context.EVIDENCE_LIMIT = 8
) -> KbEvidenceResult
```

**Boundary validation (trust-boundary — malformed → result ว่าง + `trace: invalid_query`, ห้าม raise จน customer turn ล้ม):**

| input | contract | malformed → |
|---|---|---|
| `shop`/`platform` | `str` เท่านั้น; normalize ผ่าน `canonical_delivery_scope` (owner เดียว ข้อ 5) แล้วต้องไม่ว่างทั้งคู่ | `invalid_query` |
| typed-ref containers | `tuple`/`list` เท่านั้น — container ผิด type → invalid | `invalid_query` |
| typed ref element | `str` เท่านั้น; `.strip()` สมมาตรกับ `structured_index`; ค่าว่างหลัง strip → invalid — ห้าม silent match/drop | `invalid_query` |
| duplicate refs | ไม่มีผลต่อ membership — result เหมือน query ที่ dedupe แล้วเป๊ะ (membership + deterministic order) | (no-op) |
| `semantic_query` | `str`/`None` เท่านั้น; whitespace-only → **ไม่มี semantic channel** (เทียบเท่า `None`); non-empty → bytes ส่ง `embed_query` ตามเดิม ห้ามแก้ | type ผิด → `invalid_query` |
| `limit` | `int` เท่านั้น — `bool` ไม่ใช่ int — ช่วง `1..EVIDENCE_LIMIT` | `invalid_query` |
| valid แต่ไม่มี typed refs + ไม่มี semantic_query | — | result ว่าง + `trace: no_query` |

**กฎ:**

- typed equality = `.strip()` สมมาตร — query ตอน retrieve, record values ตอน build `structured_index`
- ไม่ casefold, ไม่ยุบ whitespace ภายใน (เฉพาะ typed refs)
- แต่ละ typed channel อ่าน **เฉพาะ namespace ของ field ตัวเอง** ใน `structured_index` (ข้อ 10) — `item_ids` เห็นเฉพาะ `item_id` postings, ห้าม cross-field lookup, ห้าม union ทุก namespace; query หลาย typed channels → union เฉพาะ namespaces ที่ขอเท่านั้น
- scope matching ผ่าน `canonical_delivery_scope` ทั้งสองฝั่ง (owner เดียว — ห้าม inline expression ซ้ำใน generation/retrieval)
- `semantic_query` ดิบเข้า semantic channel เท่านั้น — ห้าม parse เป็น identity
- **scoped ranking order (ล็อก — scope filter ต้องก่อน rank/limit เสมอ):**
  1. normalize query scope ผ่าน `canonical_delivery_scope`
  2. structured channel: namespace lookup → resolve projections → **scope filter** → dedupe/sort (`canonical_record_id` asc)
  3. semantic channel: score vector rows → **ตัด digest ที่ไม่มี projection ใน requested scope** → rank เฉพาะ scope-eligible digests → expand เฉพาะ eligible projections (shared digest คืนเฉพาะ projections ของ scope ที่ขอ)
  4. merge: structured hits ก่อน ตามด้วย semantic hits (score desc, tie → `canonical_record_id` asc)
  5. dedupe ด้วย `record_id` (structured position ชนะ) → deterministic order
  6. **`limit` ใช้ขั้นสุดท้าย** หลัง scope filtering + merge เท่านั้น — foreign shop/platform ห้ามกิน quota/top-k slot
- ห้ามเพิ่ม threshold/oversampling heuristic — rank เฉพาะ eligible digests แล้วใช้ `limit` ตัดท้าย

## 9. Evidence contract

Producer record จาก Phase 4 `retrieve()` รูปนี้เท่านั้น — ทุก field materialize **จาก generation artifacts เท่านั้น** (`record_map` projections + `text`) ไม่อ่าน canonical Mongo:

```python
{
  "kind": "kb",
  "item_id": <projection.item_id>,      # verbatim เฉพาะเมื่อ projection มีค่า
  "identity": <projection.subject_id    # precedence แน่นอน: subject_id → model_id
              or projection.model_id>,  # verbatim เฉพาะเมื่อมีค่า — ห้ามเดา
  "target": <projection.target_id>,     # verbatim เฉพาะเมื่อ projection มีค่า
  "payload": {"text": <digest_entry.text>},   # semantic_text ของ digest
}
```

**Field→source mapping (closed — ทุก field มี source เดียวชัดเจน):**

| evidence field | source ใน `record_map` | เหตุผล |
|---|---|---|
| `item_id` | `records[i].item_id` verbatim | `_attribute` map เป็น `i:<item_id>` + raw item_id ref keys — typed item authority |
| `identity` | `records[i].subject_id` ก่อน, fallback `records[i].model_id` | ทั้งคู่เป็น `_norm_ref` keys ที่ `_attribute`/`_cand_keys`/`ref_needs` รองรับแล้ว (need `subject_refs` + candidate `model_id`/`identity`) — `subject_id` คือ subject ที่ record ประกาศใน canonical schema, `model_id` fallback เมื่อไม่มี subject; ถ้าไม่มีทั้งคู่ → omit |
| `target` | `records[i].target_id` verbatim | `_norm_target` เทียบ need targets — compatibility authority |
| `payload.text` | `record_map[digest].text` | `semantic_text` เดียวกันกับ vector row — renderer เดียว |

- `model_codes`/`aliases` เป็น **retrieval-only index keys** ใน `structured_index` — เป็น list ไม่ใช่ scalar authority, ห้าม emit เป็น `identity`/`item_id`/`target`; catalog/unit join เป็นงานของ Task 5
- ห้าม emit field ที่ว่าง/None (compiler ทิ้งเองตาม closed schema แต่ producer ห้ามเดาค่า)
- ห้าม prose-parse `semantic_text`/`answer_text` เพื่อหา identity — typed fields เท่านั้น

**ห้าม producer ใส่:** `request_id`, `need_indices`, `linked_candidate`, `subject_refs` — downstream/Task 5 owners เติมเอง

**Attribution flow (Task 5 wiring ใช้ contract นี้ — Phase 4 หยุดที่ producer):**

```text
retrieve() → KbEvidenceResult(supporting_evidence=(producer records))
  → retrieval_executor → RetrievalExecutionResult(request_id=req.request_id, ...)
  → candidate_pool.build_candidate_pool: stamp {"request_id": res.request_id}
      ลง record ที่ไม่มี request_id (candidate_pool.py)
  → answer_context._attribute: request_id → need_indices
  → _compile_evidence._take: emit เฉพาะ _EVIDENCE_OUT_FIELDS
      (ลบ request_id), payload["text"] → plain string,
      bounded ≤ _EVIDENCE_RECORD_BYTES(1500B) / ≤ EVIDENCE_LIMIT(8)
  → final record: {kind, need_indices, item_id?, identity?, target?,
                   payload: "<plain text>"}
```

- `payload` final = **plain text เท่านั้น** — ห้ามส่ง JSON object/JSON prompt payload ให้โมเดล
- ห้ามเพิ่ม custom truncation/budget/marker (`k of N shown`)/fact-priority/layer-dropping owner — `_compile_evidence` เป็น size owner เดิมเพียงตัวเดียว
- `record_id`, `generation_id`, source/sheet/row, provenance → `trace`/audit เท่านั้น ไม่ส่งโมเดล
- `kind="kb"` อยู่ใน `_SUPPORTING_KINDS` เดิม — ห้ามใช้ `kb_zaapi` (legacy kind ไม่อยู่ใน closed kinds)

## 10. Artifact design

**Logical roles (ล็อก) — physical format ยังไม่ล็อกจน 4D:**

| role | เนื้อหา |
|---|---|
| `vectors` | semantic embedding rows — row i ↔ digest i (sorted `semantic_digest` order), dim 1024 |
| `record_map` | `semantic_digest → {vector_index, text, records: [{record_id, shop, platform, item_id, model_id, subject_id, target_id}]}` — `text` = `semantic_text` เก็บครั้งเดียวต่อ digest (ห้ามซ้ำต่อ delivery); record projections มีเฉพาะ field ที่ retrieval/evidence ใช้จริง (`record_id`→dedupe/trace, `shop`/`platform`→scope filter, `item_id`/`model_id`/`subject_id`/`target_id`→evidence fields ข้อ 9) |
| `structured_index` | **field-namespaced index** — key set ปิดตาย 6 namespaces เท่านั้น: `{"item_id": {norm_value: [record_ids]}, "model_id": {...}, "model_code": {...}, "alias": {...}, "subject_id": {...}, "target_id": {...}}` — ป้องกัน cross-field collision (ค่า "ABC" ใน `item_id` vs `alias` ไม่ชนกัน); posting list = sorted+unique `record_id`; query channel อ่านเฉพาะ namespace ของ field ตัวเอง (`item_ids`→`item_id`, `model_ids`→`model_id`, `model_codes`→`model_code`, `aliases`→`alias`, `subject_ids`→`subject_id`, `target_ids`→`target_id`) — ห้าม union ทุก namespace, ห้าม cross-field fallback; reverse resolution ทำ deterministic ที่ load: derive `record_id → (digest, projection)` จาก `record_map` (sorted digest order → map เดียวกันเสมอ, ไม่ใช่ artifact แยก) |
| `manifest` | artifact manifest — **closed schema ด้านล่าง** ครอบ 3 payload roles เท่านั้น — ห้ามมี entry ของตัวเอง (hash ของ manifest อยู่ที่ gen doc เท่านั้น — ตัด recursive self-reference) |

**`manifest.json` closed schema (exact key set ต่อ object — unknown/missing/extra field → fail closed):**

```python
{
  "schema_version": 1,
  "generation_id": "<gid>",        # ต้องตรง directory gid + gen doc
  "vectors": {
    "file": ..., "sha256": ..., "size_bytes": int,
    "format": str, "row_count": int, "dim": int, "dtype": str,
  },
  "record_map": {
    "file": ..., "sha256": ..., "size_bytes": int,
    "format": str, "digest_count": int, "record_count": int,
  },
  "structured_index": {
    "file": ..., "sha256": ..., "size_bytes": int,
    "format": str, "field_count": 6, "key_count": int,
    "posting_count": int,
  },
}
```

กฎบังคับ validator: ทุก `int` เป็น plain int (ห้าม `bool`); counts ≥ 0; `field_count` == 6 ตรง namespace set ปิด; `generation_id` ตรง directory/gen doc; `file` ต้องเป็น fixed filename ของ role นั้น; serialization deterministic (sorted keys, canonical bytes — rebuild ได้ผลเดียวกัน); format alternatives ของ 4D เปลี่ยน **encoding** ได้แต่ห้ามเปลี่ยน logical metadata schema นี้

**Canonical path (trust boundary):**

```text
exports/zaapi_kb_gen/<gid>/<fixed filename>
```

กฎบังคับ validator:

- repo-relative เท่านั้น — ห้าม absolute path, ห้าม `..`, ห้าม foreign gid
- `<gid>` ต้องผ่าน `GEN_ID_RE` และเท่ากับ `generation_id` ใน gen doc
- filename ∈ closed set `{vectors, record_map, structured_index, manifest}` + extension ตาม declared format
- hash/bytes/count/shape/dim/dtype/format ต้องตรงตาม validation chain ข้อ 11 (gen doc→`manifest.json`→payload roles) — gen doc เช็ค manifest, manifest เช็ค payloads
- `structured_index` namespace keys = closed set 6 fields เท่านั้น และทุก posting list sorted+unique `record_id` — namespace ขาด/เกิน หรือ posting duplicate/unsorted → generation fail closed
- gen doc **ไม่เก็บ arbitrary path** — path derive จาก `gid` + fixed filenames
- ไม่เก็บ raw/full-text object array ใน artifact ถ้าไม่มี consumer (`record_map.text` มี consumer = evidence `payload.text` + vector row identity — ยกเว้นเดียวที่จำเป็น)
- **retrieval self-containment invariant:** snapshot ที่ `load_active_generation` คืนต้องเพียงพอต่อ exact+semantic retrieval และ evidence materialization โดยไม่อ่าน `zaapi_kb_records`/manifest ของ Task 3 — build/publish เป็นจุดเดียวที่เทียบ canonical state

**Format alternatives (ตัดสินที่ 4D):**

| ทางเลือก | ข้อดี | ข้อเสีย |
|---|---|---|
| `.npz` compressed | ไฟล์เล็ก, atomic write+verify pattern เดิม | load ช้ากว่าเล็กน้อย |
| `.npy` + memmap | load เร็ว, RSS ต่ำตอน query | ไฟล์ใหญ่กว่า |
| float16 | ครึ่งขนาด/RSS | recall drift ต้องพิสูจน์ vs float32 |

4D วัด: build/load/query latency, peak RSS, file sizes, float32-vs-float16 recall, structured index build+lookup cost — upper bound วางแผน 8,600 vectors (float32 ≈ 35.2 MB); final count = distinct `semantic_digest` จาก 4C

## 11. Generation document closed schema

`zaapi_kb_embedding_generations {_id:"gen:<gid>"}` — insert-once, immutable:

| field | consumer / validator |
|---|---|
| `_id="gen:<gid>"` | lookup, CAS readback, rollback resolution |
| `generation_id` | `GEN_ID_RE` validator, pointer equality |
| `status="ready"` | publish/retrieval gate — ค่าเดียว ไม่มี state machine |
| `created_at` | audit + retention ordering (ภายหลัง) |
| `canonical_generation` | publish pre-check vs `expected_canonical`; `newer_canonical_pending`; validator `== fingerprint(canonical_sources)` |
| `canonical_schema_revision` | schema-compat check |
| `canonical_sources` | fingerprint input; provenance/rebuild traceability |
| `record_set_digest` | `fingerprint(ordered record_ids)` — pinned-set proof; validator เทียบ `record_map` |
| `record_count` | validator vs `record_map` |
| `serialization={"version":"semantic_text/v1"}` | build↔retrieval renderer agreement |
| `model={name, revision, sentence_transformers_version, dim, normalize_embeddings, output_dtype}` | embedding compatibility pin ครบ (ข้อ 13/14) — retrieval เช็ค runtime ตรงทุก field ก่อนเปิด semantic channel |
| `artifacts` | `{manifest: {file, sha256, size_bytes, format}}` — gen doc เป็น owner เดียวของ manifest identity/hash (ตัด self-hash); payload metadata อยู่ใน manifest ไม่ซ้ำใน gen doc |


**ไม่มี:** `building` / `validating` / `failed` / `superseded` mutation — build ล้มไม่เขียน doc, pointer ไม่เปลี่ยน, temp dir เป็น orphan residual

**Validation chain (3 ชั้น ไม่มี self-reference):**

1. **gen doc → manifest:** `manifest.json` file ต้อง sha256/size ตรง `artifacts.manifest` ใน gen doc — ไม่ตรง → generation fail closed
2. **manifest → payloads:** manifest ต้องตรง closed schema ข้อ 10 (`schema_version`/`generation_id`/3 role objects, exact keys, plain int, counts ≥0) — role แต่ละตัวเช็ค `file`/`sha256`/`size_bytes` ตรง bytes จริง — ไม่ตรง → fail closed
3. **payload → shape/count:** load แล้วเช็ค shape/dim/count/dtype ตรง manifest ของ role นั้น + authoritative counts: `vectors.row_count` == `record_map.digest_count`, `record_map.record_count` == gen doc `record_count`, `structured_index.field_count` == 6 และ namespaces/postings/`posting_count` ตรง payload + projections ครบ fields ข้อ 10 — ไม่ตรง → fail closed (ไม่มี `counts` block ซ้ำใน gen doc — count authority = manifest roles + `record_count` เท่านั้น)

## 12. Active pointer closed schema

`zaapi_kb_embedding_generations {_id:"active"}`:

| field | consumer / validator |
|---|---|
| `_id="active"` | CAS filter |
| `revision: plain int` ≥1 — ห้าม `bool` | **ABA fence** — CAS filter expected revision; `$set` = expected+1 ทุก write |
| `generation_id: str` ผ่าน `GEN_ID_RE` | retrieval resolves active gen; CAS fence (expected) |
| `previous_generation_id: None | str` ผ่าน `GEN_ID_RE` | rollback target (gen doc immutable → gid พอ) — bootstrap แรก = `None` |
| `canonical_generation: str` | lowercase SHA-256 hex 64 chars — readback coherence = active gen doc; audit |
| `activated_at: str` | non-empty ISO-8601 ที่ parse ได้ด้วย stdlib และมี timezone UTC — audit |

**Closed-schema rules:** exact key set — extra/missing field → invalid pointer fail closed ทุก path; `revision` bool/0/negative → invalid; `previous_generation_id` type ผิดหรือไม่ผ่าน `GEN_ID_RE` → invalid; `canonical_generation` ผิดความยาว/non-hex/uppercase → invalid; `activated_at` empty/naive/non-UTC/malformed → invalid; validator ใช้ stdlib parsing เท่านั้น (ห้าม regex/table ใหม่); publish: `previous_generation_id` = OLD gid; rollback: swap ตาม CAS contract; readback validate exact schema + coherence เสมอ

**CAS (publish/rollback ใช้กลไกเดียว):**

```text
filter  {_id:"active", revision:R, generation_id:OLD}
$set    {revision:R+1, generation_id:NEW,
         previous_generation_id:OLD,
         canonical_generation:<NEW gen doc canonical_generation>,
         activated_at:now}
bootstrap (find-then-insert — ห้าม update/upsert เด็ดขาด):
  1. find_one({_id:"active"})
  2. พบ → validate closed pointer schema:
       valid → ดำเนินการ CAS ปกติ (ขั้น filter ด้านบน)
       invalid (ขาด field/type ผิด/extra field) → fail closed —
       ห้าม repair อัตโนมัติ, bytes เดิมต้องไม่ถูกแก้
  3. ไม่พบ → insert_one exact pointer {revision:1, generation_id:<gid>,
       previous_generation_id:None, canonical_generation:<gen doc>, activated_at:now}
       DuplicateKeyError → conflict + reread ครั้งเดียวรายงาน actual
เหตุผล: filter-based upsert เดิมจะ match corrupt pointer ที่ขาด
revision/generation_id แล้วเขียนทับ — overwrite corrupt state เงียบๆ
matched=0 → reread ครั้งเดียว → conflict:<actual gid>@rev<n> — ไม่มี retry loop
readback validate: pointer fields ↔ gen doc coherence หลัง matched=1
publish/rollback หลัง bootstrap ใช้ owner CAS เดียวกัน
```

**ทำไม gid-only fence ไม่พอ (A→B→A race):** publisher อ่าน `(rev R, gid A)` แล้วค้าง; ระหว่างนั้นมี publish อื่น A→B แล้ว rollback B→A — pointer กลับมา `gid A` แต่ `rev = R+2` — CAS filter ด้วย `revision=R` จะ matched=0 → conflict ถูกต้อง; ถ้า fence ด้วย `gid=A` เพียงอย่างเดียวจะผ่านผิดและเขียนทับ state ที่ stale writer ไม่ควรแตะ

## 13. Lifecycle

**Canonical-state touch points (closed — เท่านี้เท่านั้น):** Task 3 state (`zaapi_kb_records` + `active:manifest`) ถูกอ่านแค่ 2 จุด — **build** (snapshot + pin) และ **publish** (`expected_canonical` pre-check + post-read comparison); active retrieval หลัง publish อ่าน **immutable artifacts เท่านั้น** — Task 3 manifest/records update หรือหายไม่ทำให้ active generation หยุด (stale-but-coherent ตามข้อ 14)

**Build:**

```text
resolve model identity (name+immutable revision+ST version
   — resolve ไม่ได้หรือ revision ไม่ใช่ immutable commit → reject ก่อนเขียนอะไรเลย)
→ load_active_state (snapshot canonical state)
→ semantic_text per record → dedupe semantic_digest
→ embed_texts unique digests
→ write temp dir exports/zaapi_kb_gen/.tmp-<gid>/
→ validate_generation (hash/count/dim/finite/mapping/index/pin/model)
→ atomic rename → exports/zaapi_kb_gen/<gid>/
→ insert gen doc {_id:"gen:<gid>", status:"ready"}
→ pointer ยังไม่เปลี่ยน (active gen เดิม serve ต่อ)
```

**Model compatibility pin + loader contract (build → gen doc → retrieval):**

- `embedding.py` เป็น **model-loading owner เดียว** — singleton `_get_model()` ต้องเรียก `SentenceTransformer(MODEL_NAME, revision=MODEL_REVISION, device=DEVICE)` โดย `MODEL_REVISION` = immutable commit constant ใน `embedding.py` (audit + lock ก่อน gate 4C/build แรก — ห้าม placeholder)
- ห้าม loader ตัวที่สอง/“resolve revision แยก”/model resolver/registry/factory ใน Phase 4 modules — model ที่ embed build กับ embed query ผ่าน singleton owner เดียวกันเสมอ (resolve ไม่ได้ → build reject ก่อนเขียน artifact)
- `model` ใน gen doc = `{name:"BAAI/bge-m3", revision:<ค่าที่ loader ใช้จริง>, sentence_transformers_version:<installed version จริง>, dim:1024, normalize_embeddings:true, output_dtype:"float32"}`
- **dependency packaging contract:** exact `sentence_transformers_version` มี owner เดียว = canonical dependency manifest (`requirements.txt`) — implementation ต้องย้าย/บันทึก exact pin ที่นั่นและลบ `pip install sentence-transformers` (unpinned) ซ้ำออกจาก `docker/Dockerfile.chatbot`; container build ต้องพิสูจน์ installed version ตรง gen-doc `sentence_transformers_version`; dependency count **+0** — version contract เปลี่ยนเท่านั้น; ค่าจริง audit+lock ก่อน 4C ห้าม placeholder
- `load_active_generation` เช็ค runtime identity **ครบทั้ง 6 fields** (`name`, `revision`, `sentence_transformers_version`, `dim`, `normalize_embeddings`, `output_dtype`) ตรง gen doc **ก่อนเปิด semantic channel** — mismatch field ใดก็ได้ (รวม `name`) → `semantic_unavailable` (exact channel ไม่กระทบตามข้อ 14)
- ห้าม silently โหลด latest model/dependencies; ไม่มี unpinned path
- device ไม่ใช่ semantic identity — vector-byte reproducibility ยังจำกัดตามข้อ 2 measurement เดิม
- implementation รอบหลังต้องอัปเดต SRS สำหรับ `embedding.py` (เพิ่ม `MODEL_REVISION` + constructor arg) — mechanism delta: loader +0, decision owner +0, dependency +0

**Shared-embedding compatibility gate (shared runtime — บังคับก่อน pin มีผลจริง):**

- `embedding.py` เป็น **shared singleton** ไม่ใช่ของ Zaapi เพียงอย่างเดียว — consumers จริงจาก callsites วันนี้: `product_store.py` (`product_embeddings.npz`), `units.py` (`unit_embeddings.npz`), `knowledge_base.py` (`qa_embeddings.npz` + lazy vector cache auto-reload ตาม mtime), `scripts/build_embeddings.py` (artifact builder), `app.py` warmup `_get_model()`, model tokenizer สำหรับ description chunks
- การเปลี่ยน constructor เป็น `revision=MODEL_REVISION` เปลี่ยน vector space ของ singleton เดียวกันทั้งระบบ → artifacts `.npz` เดิมไม่มี model-identity proof → **ห้าม serve vector channel แบบ silent mismatch**
- shared pin มีผลกับ shared runtime ได้ก็ต่อเมื่อ gate ครบทุกข้อ: (a) resolve immutable model commit จริง (b) pin exact ST version ใน canonical manifest (c) census consumers/artifacts ทั้งหมดจาก callsites จริง (d) rebuild artifacts ทุกชุดที่ใช้ cosine space เดียวกันด้วย model identity เดียวกัน หรือมี metadata พิสูจน์ exact identity ตรงกัน (e) validate model identity ก่อน serve — unknown/mismatch → vector channel นั้น fail closed ห้ามใช้ต่อเงียบ ๆ (f) QA lazy vector cache ต้องสร้างจาก identity เดียวกันและ reset/reload หลัง artifact migration
- Phase 4 standalone/disposable build Zaapi generation ด้วย pinned model ได้ (runtime/env ของตัวเอง) — แต่ **production/shared runtime activation ถูก block จน shared-vector migration gate (Task 5) ผ่าน**
- commit code ≠ deploy safety — การ import Phase 4 modules ห้ามเปลี่ยน retrieval เดิมโดยไม่มี migration; ห้ามแก้ด้วย feature flag/fallback-latest/second loader/heuristic

**Publish:**

```text
read gen doc → validate_generation เต็มรูปแบบ
→ expected_canonical pre-check: current manifest["generation"] == expected_canonical
    ไม่ตรง → reject ก่อน CAS (rebuild จำเป็น)
→ canary (gitignored cases, arg-passed) บน candidate generation — fail → reject
→ ABA-safe CAS (filter rev+gid, +1)
→ readback validate pointer ↔ gen doc
→ post-read canonical comparison → newer_canonical_pending=true ได้
    (gen ที่ pin ไว้ยัง coherent เสมอ — ไม่ auto-rollback)
```

**Rollback:**

```text
validate previous gen doc (status="ready" + artifact hashes)
→ CAS ด้วย current (rev, gid) — filter เดียวกับ publish
→ swap active/previous, revision+1, canonical_generation ของ previous
→ readback validate
→ ไม่อ้าง latest Task 3 manifest ใดๆ
```

## 14. Failure contract

| เคส | เงื่อนไข | ผล |
|---|---|---|
| missing/invalid pointer | ไม่มี `_id:"active"` หรือ schema ผิด | retrieval fail closed → result ว่าง + trace |
| existing corrupt pointer (bootstrap) | `find_one` พบแต่ closed schema ไม่ผ่าน (ขาด revision/generation_id, extra field, type ผิด) | **fail closed — ห้าม upsert ทับ, ห้าม auto-repair, bytes เดิมไม่ถูกแก้**; bootstrap เฉพาะ absent เท่านั้น (insert_one) |
| generation doc missing/corrupt | pointer ชี้ gid ที่ไม่มี doc/doc invalid | fail closed → ว่าง + trace |
| manifest missing/hash mismatch | ไม่มี `manifest.json` หรือ hash/size ไม่ตรง `artifacts.manifest` ใน gen doc | generation fail closed (chain ชั้น 1) |
| manifest schema violation | extra/missing field, bool-as-int, negative counts, `field_count≠6`, `generation_id` ไม่ตรง | generation fail closed (chain ชั้น 2) |
| payload hash/shape/count/dim corrupt | manifest เช็ค bytes ไม่ผ่าน หรือ shape/count/dim ไม่ตรง (chain ชั้น 2–3) | generation fail closed — ไม่ fallback gen อื่น |
| pinned record missing | **build/publish validation เท่านั้น:** `record_id` ที่ pin ใน `record_map` หาย/เปลี่ยนใน canonical state ณ build/publish | build/publish reject — ไม่ใช่ runtime check; retrieval ไม่อ่าน `zaapi_kb_records` อยู่แล้ว |
| structured index corrupt | load: hash/shape/namespace/posting ไม่ตรง (chain 2–3 — namespace ขาด/เกิน, posting dup/unsorted); build/publish: rebuild จาก canonical ≠ artifact (index ครอบ `model_codes`/`aliases` — rebuild ต้องใช้ canonical records จึงทำได้เฉพาะ validation points) | generation fail closed — ห้ามใช้ semantic แทน |
| model compat mismatch | runtime identity ≠ gen doc ครบเช็คทั้ง 6 fields (`name`/`revision`/ST version/`dim`/`normalize_embeddings`/`output_dtype`) | `semantic_unavailable` — exact hits ยังคืนปกติ; semantic-only → ว่าง + trace; **ห้าม silently load latest model** |
| model identity unresolvable | `model.revision` resolve ไม่ได้หรือไม่ใช่ immutable commit | build reject ก่อนเขียน artifact/gen doc — pointer ไม่เปลี่ยน |
| semantic model unavailable + exact hits | `embed_query` ล้ม แต่ typed refs มี valid hits | คืน exact hits ปกติ + `trace: semantic_unavailable` — ไม่อ้าง result สมบูรณ์, ไม่ silent |
| semantic-only + model unavailable | มีเฉพาะ `semantic_query` แล้ว model ล้ม | result ว่าง + `semantic_unavailable` |
| shared vector artifact identity unknown/mismatch | `.npz` เดิม (product/unit/description/QA) ไม่มี model-identity proof หรือ identity ≠ loaded model | vector channel นั้น **fail closed — ห้าม serve แบบ silent mismatch**; non-vector path ของ consumer นั้นไม่กระทบ |
| build crash | ก่อน gen doc | temp dir orphan residual (ยังไม่ cleanup), pointer ไม่เปลี่ยน, ไม่มี failed doc |
| CAS conflict | `matched=0` | reread ครั้งเดียว → `conflict:<actual>@rev<n>`; pointer เดิมคงอยู่; ไม่ retry |
| canonical drift ก่อน pre-check | `manifest["generation"]` ปัจจุบัน ≠ expected | reject ก่อน CAS — gen ไม่ activate, rebuild จำเป็น |
| canonical drift หลัง pre-check | manifest เปลี่ยนระหว่าง check→CAS (standalone ตรวจไม่ได้) | publish สำเร็จ; gen coherent กับ pins ตัวเอง; post-read `newer_canonical_pending=true`; ไม่ auto-rollback |
| readback invalid | write สำเร็จแต่ doc อ่านกลับไม่ตรง gen doc | `readback_invalid` report; rollback ต้อง explicit |
| rollback stale | expected (rev,gid) เก่า | `matched=0` → conflict; pointer ไม่ถูกทับ |
| ABA race | A→B→A ระหว่าง read→CAS | rev mismatch → conflict (gid-only จะผ่านผิด) |
| malformed query input | type/range/empty-ref ผิด contract ข้อ 8 | result ว่าง + `trace: invalid_query` — ห้าม raise, ไม่ทำลาย customer turn |

หลักการ: semantic channel ล้มต้องไม่ทำลาย valid exact hits · artifact/index corruption = generation fail closed ทั้งหมด · ห้าม fallback ไป generation อื่นอัตโนมัติ

## 15. Phase gates 4A–4D

### 4A — Disposable real-Mongo fidelity

- **Entry:** design spec approved + implementation plan approved; ผู้ใช้เปิด Docker Desktop เอง
- **Writes allowed:** disposable Mongo container เท่านั้น (mongo:7, localhost/internal net, ไม่ publish ออกนอก) — ห้าม shared/production Mongo เด็ดขาด (precedent: Phase 10B CAS BLOCKED shared pointer)
- **ทำอะไร:** รัน Task 3 importer/exporter + generation lifecycle กับ Mongo จริง — ทดสอบ real `DuplicateKeyError`, CAS `matched_count`, `update_one`, readback, BSON 16MiB gate, index behavior
- **Stop conditions:** Docker daemon ไม่มี → หยุดรอผู้ใช้; container ชี้ non-disposable target → abort
- **Evidence:** container/network/volume names, test matrix results, cleanup proof (0 containers/volumes เหลือ)
- **Acceptance:** `PHASE_4A_DISPOSABLE_MONGO_FIDELITY_PASSED`

### 4B — Source/raw census

- **Entry:** 4A หรือ raw snapshot ที่มีอยู่ (provider-free)
- **Writes allowed:** ไม่มี (read-only + report)
- **ทำอะไร:** นับ sources, raw rows, distinct `content_fingerprint`, deliveries, account scope distribution, malformed/empty/conflict distribution — ไม่เรียก provider
- **Evidence:** census report (ตัวเลขจริง เช่น 118 sources / 8,600 rows / 112,974 deliveries ถ้าตรง)
- **Acceptance:** `PHASE_4B_RAW_CENSUS_COMPLETE`

### 4C — Canonical extraction/corpus

- **Entry:** **provider-budget approval ชัดเจนก่อน** + model identity resolved แล้ว (`model.revision` = immutable commit + `sentence_transformers_version` จริง — รายงานค่าจริงใน evidence, ห้าม placeholder)
- **Writes allowed:** `zaapi_kb_raw_sources`, `zaapi_kb_records`, `active:manifest` บน disposable Mongo เท่านั้น + checkpoint files
- **ทำอะไร:** extraction ต่อ unique raw row ตาม checkpoint contract; validate full source batches ก่อน pointer; unresolved/conflicted/invalid ไม่เข้า active; resume ได้จาก checkpoint
- **วัด:** distinct `semantic_digest` count, deliveries, token distribution จาก `semantic_text` serialization จริง (ไม่ใช่ raw-row proxy)
- **Stop conditions:** provider quota/budget gate ไม่ผ่าน → หยุดก่อนเรียก
- **Evidence:** corpus counts, digest cardinality, token stats, checkpoint/resume proof
- **Acceptance:** `PHASE_4C_CANONICAL_CORPUS_COMPLETE`

### 4D — Benchmark / retrieval acceptance

- **Entry:** 4C corpus + อย่างน้อย 1 validated generation บน disposable Mongo
- **Writes allowed:** generation artifacts + gen docs + pointer บน disposable เท่านั้น
- **วัด:** artifact alternatives (`.npz` vs `.npy`+memmap vs float16), build/load/query latency, peak RSS, file sizes, float32-vs-float16 recall, structured index cost, mapping validation cost, evidence budget usage
- **ทดสอบ:** deterministic exact tests, semantic retrieval cases, scope isolation, failure/adversarial (ข้อ 14–16), evidence payload acceptance
- **กฎ:** no uncalibrated threshold — top-k เท่านั้น; canary cases gitignored ส่งเป็น arg
- **Evidence:** benchmark report + acceptance matrix
- **Acceptance:** `PHASE_4D_RETRIEVAL_BENCHMARK_COMPLETE`

## 16. Test design

Behavioral RED→GREEN (executable — ห้าม source-text assertion อย่างเดียว):

1. `semantic_text` determinism: record เดียวกัน → bytes เดียวกัน; field order คงที่
2. semantic digest truth table ครบทุกแถว (ข้อ 7)
3. exact normalization: `strip()` สมมาตร — leading/trailing space match, internal whitespace/case **ไม่** match
4. scope isolation: record คนละ shop/platform ไม่ leak เข้าผล
5. structured+semantic merge: dedupe record_id, structured ก่อน, deterministic order
6. semantic unavailable + exact hits → hits + `semantic_unavailable` trace
7. semantic-only + model ล้ม → ว่าง + trace
8. corruption fail-closed ทุกแถวข้อ 14 (pointer missing, gen doc missing, manifest hash/size, payload hash/shape/count/dim, index corrupt) + pinned-record drift → build/publish reject (ไม่ใช่ runtime path)
9. path traversal rejection: absolute/`..`/foreign gid/unknown filename → reject
10. generation validation: `canonical_generation != fingerprint(canonical_sources)` → fail
11. CAS stale writer: expected rev/gid เก่า → conflict
12. ABA race: A→B→A ระหว่าง read→CAS → conflict (fake coll)
13. bootstrap race: concurrent insert → หนึ่งชนะ, อีกฝั่ง DuplicateKey → conflict
14. rollback stale expected → conflict; rollback success → previous เป็น active
15. canonical drift: pre-check reject / post-check `newer_canonical_pending`
16. readback invalid → report ไม่ auto-rollback
17. producer record ไม่มี `request_id`/`need_indices`/`linked_candidate`/`subject_refs` — emit เฉพาะ kind + item_id/identity/target (เมื่อมี) + payload
18. executor/pool attribution integration: pool stamp → `_attribute` → compiler emit closed schema (reuse existing harness seams)
19. offline suites: ไม่มี provider/Mongo leak (socket tripwire pattern เดิม)
20. order independence / import isolation (test files ไม่ poison กัน — Phase 10B precedent)
21. **artifact self-containment:** snapshot จาก generation artifacts เพียงอย่างเดียว (canonical collection absent/stubbed) → `KbEvidenceResult` ครบ — พิสูจน์ retrieval ไม่แตะ latest manifest/records หลัง publish
22. **exact-hit materialization:** typed ref hit → `payload.text` = `semantic_text` ของ digest เดียวกัน + `item_id`/`identity`/`target` ตรง mapping ข้อ 9 verbatim จาก projections
23. **semantic-hit materialization:** digest hit → text/projection fields เหมือน exact channel (mapping เดียวกัน — renderer เดียว)
24. **shared digest dedupe:** 2 records scope ต่างกัน semantic เหมือนกัน → `text`/vector เก็บครั้งเดียว; query แต่ละ scope คืน projection ของ scope ตัวเองเท่านั้น
25. **scope normalization truth table:** shop leading/trailing/internal whitespace ต่าง → match (collapse); shop ต่าง case → **ไม่ match**; platform ต่าง case → match; คนละ shop/platform → ไม่ leak
26. **reproducibility boundary:** input เดียวกัน + runtime เดียวกัน rebuild → `semantic_digest`/`record_map`/`structured_index`/`record_set_digest`/vector row order เท่ากันเป๊ะ; vector bytes เทียบเฉพาะภายใน runtime เดียวกัน — ห้าม assert ข้าม device/runtime
27. **manifest contract:** manifest มี entry ครบ 3 payload roles และไม่มี self entry; tamper `manifest.json` → จับที่ชั้น 1 (gen doc hash); tamper payload bytes → จับที่ชั้น 2; shape/count mismatch → จับที่ชั้น 3
28. **query validation truth table ครบข้อ 8:** valid exact-only / semantic-only / combined / no-input → `no_query` / scope ว่าง / container ผิด type / element ไม่ใช่ str / ref ว่างหลัง strip / `limit` เป็น bool·non-int·0·negative·>EVIDENCE_LIMIT / `semantic_query` ไม่ใช่ str|None → ว่าง + `invalid_query` — ทุกเคส ห้าม raise
29. **whitespace-only `semantic_query`** → เทียบเท่า `None` (ไม่มี semantic channel — ไม่เรียก `embed_query`); typed hits ยังทำงานถ้ามี refs; non-empty text ส่ง embed ตาม bytes เดิม
30. **duplicate refs** → result เหมือน deduped query เป๊ะ (membership + order ตาม deterministic merge)
31. **scope-owner parity:** `canonical_delivery_scope` output ตรง `account_scope_fingerprint` normalization เดิม และตรง retrieval comparison — owner เดียว ไม่มี inline copy ใน callsites; malformed types fail ที่ boundary
32. **namespace isolation:** ค่า `"ABC"` อยู่ครบทั้ง 6 fields ของ record — query `item_ids=["ABC"]` คืนเฉพาะ `item_id` postings (ไม่เห็น alias/target ฯลฯ); mixed typed query → union เฉพาะ namespaces ที่ขอ; ไม่มี cross-field leak
33. **index namespace/posting malformed:** artifact มี namespace นอก 6 set / ขาด namespace / posting duplicate / unsorted → generation fail closed
34. **model compat mismatches (6 fields ครบ):** `name` ≠ / `revision` ≠ / ST version ≠ / `dim` ≠ / `normalize_embeddings` ≠ / `output_dtype` ≠ → `semantic_unavailable` (exact hits ยังคืน; semantic-only → ว่าง + trace); immutable revision resolve ไม่ได้ → build reject ก่อนเขียน artifact/doc; ห้าม silently load latest
35. **bootstrap cases (7 เคส):** absent → `insert_one` สำเร็จ; concurrent → 1 ชนะ 1 conflict (DuplicateKey); existing valid → normal rev+gid CAS; existing ขาด revision / ขาด generation_id / extra field / type ผิด → fail closed + bytes เดิมไม่ถูกแก้ (ไม่มี upsert path)
36. **manifest closed schema:** extra/missing field ทุก role, bool-as-int, negative counts, `field_count≠6`, `generation_id` mismatch, role counts ไม่สอดคล้อง payload → reject; serialization deterministic (rebuild → bytes เดียวกัน)
37. **model loader pin:** `SentenceTransformer` constructor ได้ `revision=MODEL_REVISION` จริง (ไม่ใช่ name-only); build/query ผ่าน singleton identity เดียวกัน; model ที่โหลดก่อน Phase 4 ก็เป็น revision ที่ pin; ไม่มี unpinned/latest path — ห้าม loader ตัวที่สอง
38. **scoped ranking:** foreign shop scores สูงสุดหลายตัวแต่ local hits ไม่หลุด `limit`; shared digest (local+foreign projections) → คืนเฉพาะ local projection; foreign exact posting ไม่กิน `limit`; `limit` ใช้หลัง scoped merge เท่านั้น; query เดิม → membership/order deterministic
39. **pointer closed schema:** first bootstrap → `previous_generation_id=None`; previous invalid type/gid → reject; `revision` bool/0 → reject; `canonical_generation` wrong-length/non-hex/uppercase → reject; `activated_at` empty/naive/non-UTC/malformed → reject; extra/missing field → reject; publish/rollback readback coherence ผ่าน/ไม่ผ่านตาม contract
40. **shared-vector compatibility gate:** pinned query model + legacy artifact ไม่มี identity proof → ห้าม serve vector channel silently; artifact identity mismatch → vector channel fail closed แต่ non-vector path ของ consumer เดิมทำงาน; rebuilt artifact ด้วย identity ตรงกัน → retrieval ใช้ได้; product/unit/description/QA consumers ใช้ model identity เดียวกัน; QA lazy cache reset/reload หลัง migration

## 17. Complexity containment budget

| mechanism | budget |
|---|---|
| decision owners ใหม่ | **+2 สูงสุด** (generation lifecycle, retrieval) |
| public evidence result type | +0 (`KbEvidenceResult` เดิม) |
| keyword tables / regex / heuristics | +0 |
| flags | +0 |
| dependencies | +0 |
| normalization helpers | pure data-contract function **+1** (`canonical_delivery_scope` ใน `kb_zaapi_schema.py` — รวม scope normalization เดิมที่ซ้ำ inline) → duplicated normalization callsites **−2**; business helper/guard/heuristic **+0** — อนุมัติเพราะรวม semantic decision ให้เหลือ owner เดียวแทน inline copy สองจุด |
| trust-boundary query validation | **+1 กลุ่ม** (boundary เดียวใน `retrieve` — malformed → ว่าง + `invalid_query`, ไม่ raise) |
| custom truncation owner / marker / fact-priority | +0 |
| pointer cache / TTL | +0 |
| CAS implementation | **+1** (ใน `kb_zaapi_generation.py` เท่านั้น — rev+gid fenced) |
| local duplicate validation | +0 (validate ที่ owner เดียว ไม่ซ้ำซ้อน) |

ทุก implementation round ต้องรายงาน actual delta เทียบ budget นี้

## 18. Security และ side effects

- ห้ามอ่าน `.env` ทุกชนิด — ห้ามอ่าน `มาแล้วจ้า.md`
- shared product DB (`dbWallet`) read-only; admin/shared Mongo (digital.in.th) **ห้ามแตะ** — Phase 4 ใช้ disposable Mongo เท่านั้น
- ไม่มี production pointer write — legacy `zaapi_kb` collection ห้ามอ่าน/เขียน
- provider calls ต้องมี explicit budget approval ก่อน (เฉพาะ 4C extraction)
- artifacts/canary files ห้ามมี secrets/customer data — canary gitignored
- ไม่ deploy/push/PR; staging ว่างเสมอจนกว่าอนุมัติ commit

## 19. Deferred Task 5+

- runtime `kb_source` wiring + `zaapiKbReady` readiness switch
- pool admission / `let_ai_respond` wiring
- catalog/units join + identity-bound retrieval (Zaapi KB ไม่เปิดเดี่ยว)
- product cards / Shopee link / stock / price
- answer composition
- per-request snapshot/cache/TTL
- UI: import/export/canonical tab
- retention cleanup (invariant: ห้ามลบ record/revision/artifact ที่ active หรือ previous generation อ้างถึง — implementation ภายหลัง)
- legacy `zaapi_kb` adapter deprecation/replacement
- **shared-vector migration gate** (blocks production pin activation): census consumers/artifacts จาก callsites จริง → rebuild/prove exact model identity ต่อ artifact set → QA lazy cache reset/reload → validate-identity-ก่อน-serve — commit code ≠ deploy safety
- production canary/deployment

## 20. Decision record และ unresolved measurements

**Design decisions (final — ไม่มี TBD):**

- vector identity = `semantic_digest` (SHA-256 ของ `semantic_text`) ไม่ใช่ `content_fingerprint`
- semantic serialization รวม identity refs รอบแรก — ตัด scope/provenance/readiness
- structured equality = `strip()` สมมาตร; scope ผ่าน `canonical_delivery_scope` owner เดียวใน `kb_zaapi_schema.py` (shop `" ".join(split())` case-sensitive, platform `strip().casefold()`) — `account_scope_fingerprint`/generation/retrieval เรียก function เดียวกัน ห้าม inline ซ้ำ
- query contract = `retrieve(snapshot, *, shop, platform, ...typed-ref kwargs, semantic_query, limit=EVIDENCE_LIMIT)` — kwargs เดียวไม่มี query type ใหม่; malformed → ว่าง + `invalid_query` (ห้าม raise); valid-no-input → `no_query`; whitespace-only semantic = ไม่มี channel; duplicate refs = no-op
- `record_map` self-contained: `text` ครั้งเดียวต่อ digest + record projections `{record_id,shop,platform,item_id,model_id,subject_id,target_id}` — evidence materialize จาก artifacts ล้วน ไม่อ่าน canonical Mongo ต่อ request
- producer mapping exact: `item_id`←`item_id`; `identity`←`subject_id`→`model_id` precedence; `target`←`target_id`; `model_codes`/`aliases` retrieval-only — ไม่ emit; ไม่มี prose parsing
- artifact trust chain 3 ชั้น: gen doc → `manifest.json` hash → payload roles hash → shape/count — manifest ไม่มี self-hash, gen doc ไม่เก็บ payload hash ซ้ำ
- reproducibility boundary: digests/map/index/row order deterministic เสมอ; vector bytes รับประกันเฉพาะ same-runtime rebuild ที่ measurement พิสูจน์ — `generation_id`/`created_at`/paths เป็น attempt metadata ไม่มี gen-doc digest
- evidence = `KbEvidenceResult` + `payload{"text"}` plain text; producer ไม่ใส่ request_id/need_indices
- pointer = `{_id:"active", revision:int≥1 non-bool, generation_id:GEN_ID_RE, previous_generation_id:None|GEN_ID_RE, canonical_generation:64-char lowercase sha256, activated_at:UTC ISO-8601}` exact key set ใน `zaapi_kb_embedding_generations` — ABA-safe rev+gid CAS; invalid → fail closed ทุก path; readback validate schema+coherence
- scoped ranking: scope filter ก่อน rank/`limit` เสมอ — semantic rank เฉพาะ scope-eligible digests, foreign scope ไม่กิน quota, `limit` ตัดท้ายหลัง merge; ไม่มี threshold/oversampling
- lifecycle ไม่มี state machine — insert-once ready doc + fenced CAS + readback
- active gen pin canonical+records — ไม่อ่าน latest manifest ต่อ request; drift → `newer_canonical_pending` ไม่ auto-rollback
- canary = arg-passed gitignored cases; full validation ก่อน publish ไม่มี fast flag
- `structured_index` = field-namespaced closed set 6 fields (`item_id`/`model_id`/`model_code`/`alias`/`subject_id`/`target_id`) — channel อ่านเฉพาะ namespace ตัวเอง, posting sorted+unique, ไม่มี cross-field/union-all
- model pin ครบ 6 fields (`name`/`revision` immutable/`sentence_transformers_version`/`dim`/`normalize_embeddings`/`output_dtype`) — `embedding.py` singleton เดียว load ด้วย `SentenceTransformer(MODEL_NAME, revision=MODEL_REVISION)`; build ห้ามเริ่มถ้า revision resolve ไม่ได้; load compare ครบทั้ง 6 (รวม `name`) → `semantic_unavailable` (exact ยังคืน) — ห้าม silently load latest; ค่าจริง audit+lock ก่อน gate 4C
- shared-embedding compat: `embedding.py` = shared singleton (product/unit/description/QA artifacts) — pin `MODEL_REVISION` เปลี่ยน vector space ของ consumers เดิม; shared pin มีผลเฉพาะหลัง migration gate ครบ (census/rebuild-or-prove-identity/validate-ก่อน-serve/QA cache reset); artifact ไม่มี identity proof → vector channel fail closed ไม่ silent serve; Phase 4 standalone build ได้แต่ production activation block จน gate ผ่าน; ห้าม flag/fallback-latest/second-loader
- dependency packaging: exact ST version owner เดียว = `requirements.txt`; ลบ unpinned `pip install sentence-transformers` จาก `docker/Dockerfile.chatbot` ใน implementation; container build พิสูจน์ installed==gen-doc version; dep count +0
- bootstrap = `find_one` → validate-or-insert เท่านั้น — ห้าม update/upsert; first pointer `previous_generation_id=None`; corrupt pointer ไม่ถูกแตะ, ไม่ auto-repair; publish/rollback ใช้ owner CAS เดียว
- count authority = manifest role counts + gen doc `record_count` เท่านั้น — gen doc ไม่มี `counts` block ซ้ำ (validator เทียบ `vectors.row_count`/`record_map.digest_count`/`record_map.record_count`/`structured_index.field_count`)
- `manifest.json` = closed schema (`schema_version`/`generation_id`/3 role objects, exact keys, plain int ไม่รับ bool, counts ≥0, `field_count==6`) — deterministic serialization; 4D format alternatives เปลี่ยน encoding ไม่เปลี่ยน schema

**Unresolved measurements (เหลือเฉพาะสิ่งที่ต้องวัด):**

| measurement | gate | metric | options | acceptance rule | safe default |
|---|---|---|---|---|---|
| artifact format | 4D | load/query latency, RSS, file size, recall | `.npz` / `.npy`+memmap / float16 | เร็ว+เบากว่าโดยไม่เสีย recall | `.npz` float32 (pattern เดิม) |
| distinct `semantic_digest` count | 4C | count + deliveries ratio | — | รายงานค่าจริง | upper bound วางแผน ≤8,600 vectors |
| structured index serialization | 4D | build+lookup cost, size | JSON map / array artifact | deterministic rebuild ผ่าน + เร็วพอ | JSON map |
| top-k/threshold | 4D | recall@k บน canary | top-k เท่านั้น vs calibrated threshold | ห้าม uncalibrated threshold | top-k ผูก `limit` |
| evidence budget usage | 4D | p95 record bytes vs 1500B cap | เลือก record count | ไม่ truncate จนสูญ facts ใน acceptance cases | emit ≤`EVIDENCE_LIMIT` records |
| canary cases | 4A/4D | pass rate บน disposable | curated set | ครอบ structured+semantic+scope+failure | deterministic smoke set (gitignored) |
