# Phase 4 — Zaapi Canonical KB Retrieval Implementation Plan

> **For agentic workers:** execute task-by-task sequentially; 1 commit = 1 task ที่ verify ผ่านแล้วเท่านั้น; steps ใช้ checkbox (`- [ ]`) สำหรับ tracking; อ่าน spec คู่กับ plan นี้เสมอ — spec คือ contract, plan นี้คือลำดับการทำ

- วันที่: 2026-11-04
- สถานะ: plan draft — รอ independent review; **ห้ามเริ่ม implementation ก่อน approve**
- Branch: `feature-botlogic-kb-workflow` (ทิศเดียวกับ design commit 0f919f1 — commit ต่อ branch เดิม)
- Spec: `docs/plans/2026-11-04-phase4-zaapi-canonical-retrieval-design.md` (authoritative — ตัวเลข/กฎทุกอย่างยึด spec; plan นี้ไม่แก้ contract ใด ๆ)

**Goal:** ทำให้ canonical Zaapi KB corpus (Task 3) ค้นได้เต็มประสิทธิภาพ standalone บน disposable Mongo — exact typed channels + semantic channel, generation lifecycle ครบ build→validate→publish→rollback

**Architecture:** owner ใหม่ 2 ตัว (`kb_zaapi_generation.py` lifecycle, `kb_zaapi_retrieval.py` standalone retrieval) + consolidation 2 จุดใน `kb_zaapi_schema.py` (`canonical_delivery_scope` + ย้าย `load_active_state`) + model pin ใน `embedding.py` — DAG เดียว: `generation → retrieval → schema`

**Tech stack:** Python (`.venv` 3.14), pytest 9.1.1, pymongo 4.x, numpy, sentence-transformers (pin จริงจาก env audit), BGE-M3 1024d, mongo:7 disposable (4A/4C/4D)

## Global constraints (ทุก task มีผลโดยปริยาย — copy จาก spec/AGENTS ต้นฉบับ)

- **Budget §17 + declared additions (itemized — ห้ามรวม category ใน delta reconciliation):**

  | mechanism category | allowance | allowance source |
  |---|---|---|
  | decision owners | +2 (`kb_zaapi_generation`, `kb_zaapi_retrieval`) | spec §17 |
  | public evidence result type | +0 (`KbEvidenceResult` เท่านั้น) | spec §17 |
  | normalization fn | +1 (`canonical_delivery_scope`; normalization callsites −2) | spec §17 |
  | trust-boundary query validation | +1 group | spec §17 |
  | CAS implementation | +1 (`kb_zaapi_generation.py` เท่านั้น) | spec §17 |
  | closed-schema validators | +3 (`validate_gen_pointer`/`validate_gen_doc`/`validate_artifact_manifest` — data-contract fns ใน schema owner เดิม; §10–12 mandates fail-closed contracts) | declared addition — spec-mandated mechanism |
  | disposable-target validator (uri+db_name pair) | +1 (`require_disposable_target` — CLI boundary; proven precedent active log:3605) | review-mandated |
  | retrieval entrypoint | +1 (`retrieve_active` — §14 result-ว่าง+trace contract) | declared addition — spec-mandated mechanism |
  | model-identity accessor | +1 (`model_identity` — §13 single identity source) | declared addition — spec-mandated mechanism |
  | constant | +1 (`MODEL_REVISION`) | declared addition — spec-mandated mechanism |
  | custom truncation/marker/fact-priority | +0 | spec §17 |
  | pointer cache/TTL | +0 | spec §17 |
  | local duplicate validation | +0 | spec §17 |
  | keyword/regex/heuristic/synonym/fuzzy | +0 | spec §17 |
  | feature flags | +0 | spec §17 |
  | dependencies | +0 (pin contract เท่านั้น) | spec §17 |
  | second model loader / fallback latest / silent generation fallback | +0 | spec §17 |
  | fake Mongo ชุดใหม่ | +0 | user-locked |
  | test-infra owner (`mongo_doubles.py`) | +1 — test code ไม่นับ production mechanism | review-mandated |
- ห้าม keyword/regex/synonym/fuzzy/heuristic · ห้าม feature flag · ห้าม second model loader/resolver · ห้าม fallback latest model · ห้าม silent generation fallback
- ห้าม production/shared Mongo (digital.in.th) ทุกกรณี — disposable เท่านั้น · legacy `zaapi_kb` collection ห้ามอ่าน/เขียน · `dbWallet` read-only
- ห้าม provider call ก่อน explicit budget approval (เฉพาะ 4C) · ห้าม Docker นอก gate 4A · ห้าม deploy/push/PR · staging ว่างเสมอจนกว่าอนุญาต commit
- ห้ามอ่าน `.env` ทุกชนิด / `มาแล้วจ้า.md` · artifacts/canary ห้ามมี secrets (canary gitignored)
- **ห้ามเริ่ม Task 5:** `kb_source` activation, `zaapiKbReady`, pool wiring, `app.py:1218-1220`, `kb_zaapi.py` legacy adapter, catalog/unit join, runtime `let_ai_respond`, UI, retention cleanup impl
- 1 commit = 1 task verified; ก่อน commit รายงาน diff + test result (AGENTS §10); SRS update ทุก task ที่แตะ production function (AGENTS §1–2)
- test doubles: reuse `GenColl`/`GenDb`/`_match`/`FakeColl`/`FakeDb`/`FakeClient` เท่านั้น — **ห้ามสร้าง fake Mongo ชุดที่สี่** (user-locked) และ**ห้าม import test module เพื่อ reuse** (side effects ตอน import) — extract ไป neutral `docs/test/tools/mongo_doubles.py` ชุดเดียว (T1)
- disposable Mongo barrier เป็น enforcement ไม่ใช่ warning — contract เดียวกับ `validateLoopbackMongoUri` ที่ repo พิสูจน์แล้ว (active log:3605, botworker smoke): `MongoClient` สร้างได้เฉพาะหลัง `require_disposable_target(uri, db_name)` ผ่าน (validate **pair ในฟังก์ชันเดียว** — ไม่มี helper ตัวที่สอง) = URI: `mongodb://` เท่านั้น (reject `mongodb+srv://`), single loopback host (`localhost`/`127.0.0.1`/`::1`), **explicit port และ `port != 27017`**, **no credentials, no query/options, no multi-host, no db path**; `db_name` ต้อง match closed pattern `^zaapi_kb_p4_verify_[A-Za-z0-9_-]{8,}$` (prefix เฉพาะ Phase 4 — harness สุ่ม**ครั้งเดียว**แล้วส่งชื่อเดิมให้ทุก command/writer ผ่าน `--db-name`, ห้าม derive จาก URI/prod); refusal ทุกแถวพิสูจน์ `MongoClient` ถูกเรียก **0 ครั้ง**; ห้าม DNS name/ambient `ADMIN_MONGO_URI` path; importer/exporter functions รับ colls ที่ inject จาก disposable client ตรงเสมอ
- **Docker approval ≠ image-pull approval ≠ network approval (3 ชั้นแยก):** ทุก `docker run` ต้อง `docker image inspect <image>` local check ก่อน — image ไม่มี → STOP ขอ pull approval แยก → `docker pull` เฉพาะ image ที่อนุมัติ (mongo:7, python:3.11-slim); ห้าม pull อัตโนมัติ
- cleanup proof ต้อง scoped เท่านั้น: mongo container ใช้ `--tmpfs /data/db` (ไม่สร้าง anonymous volume) + `docker rm -f` + `docker ps -a --filter name=zaapi-p4` + `docker volume ls --filter name=zaapi-p4` → ทั้งหมด 0 — **ห้ามตัดสินจาก container/volume ทั้งเครื่อง** (ของผู้ใช้อาจมีอยู่แล้ว)
- **container lifecycle (ล็อก — container แต่ละก้อนมีเจ้าของ cleanup ตัวเดียว):** T13 = `zaapi-p4-test` (cleanup ใน T13 เท่านั้น) · T15–T16 = `zaapi-p4-corpus` (spin ใน T15 หลัง approval, **ใช้ target เดิมตลอด T15–T16, cleanup ใน T16 `finally` เท่านั้น** — T15 ห้าม cleanup เมื่อผ่านเพราะ T16 ต้องใช้ corpus+generation เดิม; T15 fail/หยุดก่อน T16 → `docker rm -f zaapi-p4-corpus` + scoped proof ทันที)
- baseline ที่ต้องรักษา: `pytest docs/test/offline/test_zaapi_kb_import.py docs/test/offline/test_phase4b_refresh.py` = **416 passed** (วัดจริง 2026-11-04)
- waythrough protocol ข้อ 8H: append "กำลังจะทำ" ก่อนงาน / "ผ่านแล้ว" หลัง verify + ledger entry + prefix/hash ใน commit เดียวกัน

## File structure map

| file | status | owner / role |
|---|---|---|
| `chatbot/shopeechat/kb_zaapi_retrieval.py` | **create** | owner 2 — `load_active_generation`/`load_generation_snapshot`/`retrieve`/`ZaapiKbSnapshot`/`_load_artifacts` |
| `chatbot/shopeechat/kb_zaapi_generation.py` | **create** | owner 1 — builders/`validate_generation`/`build_generation`/`publish`/`rollback`/CAS |
| `chatbot/shopeechat/scripts/zaapi_kb_gen.py` | **create** | thin CLI — subcommands เรียก owner 1 (ไม่ใช่ decision owner) |
| `chatbot/shopeechat/kb_zaapi_schema.py` | modify | +`canonical_delivery_scope`, +`load_active_state` (ย้ายเข้า), +closed-schema validators 3 ตัว, `account_scope_fingerprint` ใช้ owner ใหม่ |
| `chatbot/shopeechat/embedding.py` | modify | +`MODEL_REVISION`, +`model_identity()`, `_get_model` constructor `revision=` |
| `requirements.txt` | modify | +`sentence-transformers==<installed exact>` (dep count +0 — version contract) |
| `docker/Dockerfile.chatbot` | modify | ลบ `sentence-transformers` ออกจาก unpinned install (คง `pythainlp rapidfuzz`) |
| `docs/zaapi/script/import_zaapi_kb.py` | modify | `load_active_state` → import จาก schema (re-export compatibility, ห้าม implementation ซ้ำ) |
| `docs/zaapi/script/export_zaapi_kb.py` | modify | `load_active_state` → import จาก schema |
| `docs/test/tools/mongo_doubles.py` | **create** | neutral test-infra owner — `_norm`/`_get_path`/`_match`/`_Cursor`/`FakeColl`/`FakeDb`/`FakeClient`/`GenColl`/`GenDb` (ย้าย verbatim จาก 2 donor files; implementation ชุดเดียว ห้าม copy) |
| `docs/test/live/test_legacy_turn_incident_replay.py` | modify | ลบ class/helper defs → re-import จาก `mongo_doubles` (side-effect imports คงในไฟล์ตัวเองเท่านั้น) |
| `docs/test/offline/test_phase4b_refresh.py` | modify | ลบ `GenColl`/`GenDb` defs + late `_match` imports → re-import จาก `mongo_doubles` |
| `docs/test/tools/zaapi_phase4_helpers.py` | **create** | record/manifest factories, artifact-dir writer, embed stub, socket tripwire — import `mongo_doubles` เท่านั้น ห้าม import test module |
| `docs/test/tools/phase4b_census.py` | **create** | deterministic census tool (committed — ตาม repo convention `docs/test/`; outputs gitignored) |
| `docs/test/offline/test_phase4_zaapi_scope.py` | **create** | scope owner tests (§16.25, 31) |
| `docs/test/offline/test_phase4_zaapi_generation.py` | **create** | builders/validate/build/publish/rollback (§16.1,2,6,7?—ดู coverage map) |
| `docs/test/offline/test_phase4_zaapi_retrieval.py` | **create** | snapshot/retrieve/evidence/failure (§16.3–9,21–24,26,28–30,32–34,38) |
| `docs/test/offline/test_phase4_zaapi_attribution.py` | **create** | producer→pool→compiler seam (§16.17,18) |
| `docs/test/live/test_phase4_zaapi_isolation.py` | **create** | offline leak + import order (§16.19,20) |
| `docs/SRS_SSD.md` | modify | section 6 ทุก production function ที่เปลี่ยน (per-task) |

**ไม่แตะ (ห้ามใน scope เด็ดขาด):** `kb_zaapi.py`, `generation_pointer.py`, `publish_generation.py` (`cas_publish`/`rollback`/`_pointer_set_doc` — pattern only), `build_embeddings.py` (`_save_verified_npz` — pattern only), `runtime_config.py`, `app.py`, `candidate_pool.py`, `answer_context.py`, `retrieval_executor.py`, `units.py`, `product_store.py`, `knowledge_base.py` (ยกเว้นอ่าน `KbEvidenceResult`), shared `.npz` artifacts ทั้งหมด

## Implementation-surface audit (callsite census — จากโค้ดจริง 2026-11-04)

| symbol | file:line | callsites จริง | disposition |
|---|---|---|---|
| `canonical_json`, `fingerprint` | `kb_zaapi_schema.py:56,62` | importer ×12, exporter ×4 | **reuse** |
| `account_scope_fingerprint` | `kb_zaapi_schema.py:67` | schema:198,337 · importer:134,264 · exporter:33 | reuse + refactor internals → `canonical_delivery_scope` (inline ×2: บรรทัด 76–77, 83–84) |
| `canonical_record_id` | `kb_zaapi_schema.py:89` | importer:45,355 | reuse |
| `raw_row_id`/`validate_raw_row`/`index_raw_rows`/`sanitize_source_row` | `kb_zaapi_schema.py` | importer/exporter | reuse |
| `build_revision`/`validate_manifest`/`validate_manifest_records`/`validate_record_provenance` | `kb_zaapi_schema.py` | importer/exporter | reuse |
| `load_active_state(records_coll, raw_coll, manifest)` | `import_zaapi_kb.py:214` | importer ×4 (270,399,418,439) + exporter:45 | **ย้าย owner → `kb_zaapi_schema.py`**; importer/exporter re-import (compatibility — `importer.load_active_state` resolve ต่อ, ไม่มี impl ซ้ำ) |
| `embed_texts`, `embed_query` | `embedding.py:49,70` | units:107 · knowledge_base:977,1007 · product_store:228,312 · build_embeddings:53,190 | reuse ผ่าน singleton เดียว |
| `_get_model` | `embedding.py:33` | app:85 warmup · embed_texts internals · build_description_chunks:140 (tokenizer) | +`revision=MODEL_REVISION` — loader เดิม ไม่มีตัวที่สอง |
| `MODEL_NAME`/`EMBEDDING_DIM`/`DEVICE` | `embedding.py:27–30` | build_embeddings:31 | reuse |
| `GEN_ID_RE`, `mint_generation_id` | `generation_pointer.py:26,74` | publish:327,335 · tests | reuse |
| `KbEvidenceResult` | `knowledge_base.py:1203` | kb_product_evidence:1308 · kb_zaapi:71,75,108,130 | reuse (+0) — `cards=(), attachment_evidence=(), supporting_evidence, raw_count, trace` |
| `EVIDENCE_LIMIT=8` | `answer_context.py:73` | — | reuse (default `limit`) |
| `_SUPPORTING_KINDS` (มี `"kb"` แล้ว), `_EVIDENCE_OUT_FIELDS`, `_EVIDENCE_RECORD_BYTES=1500`, `_EVIDENCE_TEXT_KEYS`, `_attribute`, `_compile_evidence` | `answer_context.py:74,115,127,132,492,728` | — | reuse unchanged — producer ไม่ใส่ `request_id`/`need_indices`/`linked_candidate`/`subject_refs` |
| pool `request_id` stamp | `candidate_pool.py:255–260` | — | reuse unchanged |
| `RetrievalExecutionResult.request_id` | `retrieval_executor.py:35,301,321` | — | Task 5 seam — ไม่แตะ |
| `_save_verified_npz` (tmp→verify→os.replace) | `build_embeddings.py:58` | — | **pattern only** (เขียนใหม่ใน owner) |
| `sha256_file`, `finalize_manifest` readback, `cas_publish` gid-fence, `cleanup_generations` grace | `publish_generation.py:48,254,270,413` | — | **pattern only — ห้ามเรียก `cas_publish()` ตรง** (ผูก `sellable_units_meta`/`_SNAPSHOT_FIELDS`); cleanup = Task 5+ invariant |
| `_persist_immutable` (insert-once+readback) | `import_zaapi_kb.py:197` | importer | pattern — gen doc insert = `insert_one` ธรรมดา |
| `MemoryCollection` | `test_zaapi_kb_import.py:30` | suite เดิม | reuse ตามเดิมใน suite นั้น — ไม่มี `insert_one`, Phase 4 ใช้ GenColl; helpers ห้าม import test module |
| `_norm`/`_get_path`/`_match`/`_Cursor`/`FakeColl`/`FakeDb`/`FakeClient` | `test_legacy_turn_incident_replay.py:119,131,147,177,188,258,280` | test_phase4b_refresh:36–37 | **ย้าย → `docs/test/tools/mongo_doubles.py`** (impl ชุดเดียว) — module นี้มี import-time side effects (env/tripwires/`app` load บรรทัด 53+) ห้าม import จาก helpers เด็ดขาด |
| `GenColl`/`GenDb` | `test_phase4b_refresh.py:71,154` | — | **ย้าย → `mongo_doubles.py` เช่นกัน** — `insert_one`+DuplicateKeyError, fenced `update_one`, `list_collection_names`; late `_match` imports (:106,120,134) เปลี่ยนเป็น module import จาก `mongo_doubles` |
| `extractor` seam | `import_zaapi_kb.py:336` | tests | reuse — deterministic stub extractor สำหรับ 4A/4B (provider-free) |
| `runtime_config` `kb_source`/`kb_enabled`/`pool_sources`/`zaapiKbReady` | `runtime_config.py:69–97` | app:1218 | **Task 5 — ห้ามแตะ** |
| `zaapi_kb` legacy collection + `kb_zaapi.py` adapter | — | app:1219 | **ห้ามแตะ/ห้ามอ่าน/ห้ามเขียน** |
| `sentence-transformers` | — | Dockerfile:19 (unpinned), venv 5.7.0 | pin exact ที่ `requirements.txt` (owner เดียว), ลบออกจาก Dockerfile line |
| BGE-M3 revision | — | HF cache snapshots: `5617a9f6…` (refs/main) + `9a0624b8…` | audit+lock — **ห้ามถือ refs/main เป็น proof อัตโนมัติ**: ต้องพิสูจน์ commit ที่ loader resolve จริง (T4) |
| `_admin_db` | `knowledge_base.py:136` | units:63 · kb_zaapi:36 | **ห้ามใช้ใน Phase 4** — ambient env path; Phase 4 colls = `safe_uri, safe_db = require_disposable_target(uri, db_name)` → `MongoClient(safe_uri)[safe_db]` inject เท่านั้น |
| `_get_admin_db` | `import_zaapi_kb.py:57` | importer CLI main | **ห้าม ambient path ใน Phase 4** — `import_source(item, files_dir, raw_coll, records_coll, *)` รับ colls inject ตรงอยู่แล้ว (:252–253); T13/T15 เรียก function ไม่ใช่ CLI `--apply` |
| `exports/` gitignore | `.gitignore` | — | `exports/zaapi_kb_gen/<gid>/` + canary = gitignored อยู่แล้ว (ไม่ต้องแก้) |

**Module import DAG (ล็อก — ห้าม cycle):**
`kb_zaapi_generation` → `kb_zaapi_retrieval` (`_load_artifacts`, `load_generation_snapshot` สำหรับ validate/canary) → `kb_zaapi_schema` + `embedding` + `knowledge_base`(lazy `KbEvidenceResult`) + `answer_context`(`EVIDENCE_LIMIT`). `kb_zaapi_retrieval` ห้าม import `kb_zaapi_generation`.

**Locked interface (ทุก task อ้างอิงชุดนี้เท่านั้น):**

```python
# kb_zaapi_schema.py (เพิ่ม)
def canonical_delivery_scope(shop: str, platform: str) -> tuple[str, str]:
    """(" ".join(shop.split()), platform.strip().casefold()) — pure, callers validate."""
def load_active_state(records_coll, raw_coll, manifest: dict) -> list[dict]: ...
def validate_gen_pointer(doc) -> dict: ...          # §12 closed schema
def validate_gen_doc(doc) -> dict: ...              # §11 closed schema
def validate_artifact_manifest(obj) -> dict: ...    # §10 manifest.json closed schema

# embedding.py (เพิ่ม)
MODEL_REVISION = "<audited immutable commit — T4 locks, no placeholder>"
def model_identity() -> dict: ...  # 6 fields ตาม §13 — loader truth เดียว

# kb_zaapi_generation.py (owner 1)
def semantic_text(record: dict) -> str: ...
def semantic_digest(record_or_text) -> str: ...
def record_set_digest(record_ids) -> str: ...
def build_record_map(records, texts_by_digest) -> dict: ...
def build_structured_index(records) -> dict: ...
def build_manifest_payload(gid, roles) -> dict: ...
def validate_generation(gen_dir, gen_doc, db) -> dict: ...
def build_generation(db, *, embed=None, exports_root=None, gid=None, now=None) -> dict: ...
def publish(db, gid, *, canary_cases=(), exports_root=None) -> str: ...
def rollback(db, expected_gid, *, exports_root=None) -> str: ...

# kb_zaapi_retrieval.py (owner 2)
@dataclass(frozen=True)
class ZaapiKbSnapshot:
    generation_id: str
    vectors: "np.ndarray"            # (n_digests, 1024) float32 — row i ↔ digests[i]
    digests: tuple[str, ...]         # sorted semantic_digest order
    record_map: dict                 # digest → {vector_index, text, records[...]}
    structured_index: dict           # 6 namespaces → {norm_value: [record_id...]}
    record_index: dict               # record_id → (digest, projection)
    model: dict                      # gen doc pin 6 fields
    model_compatible: bool           # runtime identity == pin (exact channel ไม่พึ่ง flag นี้)
    canonical_generation: str
    record_count: int

def load_generation_snapshot(db, gid, *, exports_root=None) -> ZaapiKbSnapshot | None: ...
def load_active_generation(db, *, exports_root=None) -> ZaapiKbSnapshot | None: ...
def _load_artifacts(gen_dir, gen_doc) -> dict: ...   # chain ชั้น 1–3 → payload objects (fail → raise/None ตาม callsite)
def retrieve(snapshot, *, shop, platform, item_ids=(), model_ids=(), model_codes=(),
             aliases=(), subject_ids=(), target_ids=(), semantic_query=None,
             limit=EVIDENCE_LIMIT) -> KbEvidenceResult: ...
def retrieve_active(db, *, shop, platform, item_ids=(), model_ids=(), model_codes=(),
                    aliases=(), subject_ids=(), target_ids=(), semantic_query=None,
                    limit=EVIDENCE_LIMIT, exports_root=None) -> KbEvidenceResult: ...
    # end-to-end boundary: load_active_generation → None → ว่าง + trace ("generation_unavailable",)
    # (spec §14: pointer/gen-doc/artifact fail closed → result ว่าง + trace — None ไม่มีทางแปลงเป็น
    #  KbEvidenceResult.trace ได้ จึงต้องมี entrypoint นี้; public result type ยัง +0)

# scripts/zaapi_kb_gen.py (thin CLI — disposable barrier enforced ก่อน MongoClient)
def require_disposable_target(uri: str, db_name: str) -> tuple[str, str]:
    """validate (uri, db_name) pair ในฟังก์ชันเดียว — ไม่มี helper ที่สอง:
    uri contract เดียวกับ validateLoopbackMongoUri (repo-proven, active log:3605):
    mongodb:// เท่านั้น (reject mongodb+srv://) + single loopback host
    (localhost/127.0.0.1/[::1]) + explicit port และ port != 27017 +
    no credentials + no query/options + no multi-host + no db path;
    db_name ต้อง match ^zaapi_kb_p4_verify_[A-Za-z0-9_-]{8,}$ —
    raise ก่อนสร้าง MongoClient เสมอ (ทุก refusal พิสูจน์ client ถูกเรียก 0 ครั้ง)
    CLI: --mongo-uri + --db-name required; harness สุ่ม db_name ครั้งเดียวแล้วส่งให้ทุก command"""
```

**semantic_text renderer (ล็อก `"semantic_text/v1"` — labeled lines, deterministic + LLM-readable เพราะเป็น `payload.text` ด้วย):**

```python
lines = [f"record_type: {r['record_type']}", f"topic: {r['topic']}"]
for k in ("item_id", "model_id", "subject_id", "target_id"):
    if r.get(k) is not None:
        lines.append(f"{k}: {r[k]}")
for v in r["model_codes"]: lines.append(f"model_code: {v}")   # stored tuple order
for v in r["aliases"]:     lines.append(f"alias: {v}")
for f in sorted(r["facts"], key=lambda x: x["key"]):          # keys unique per schema
    lines.append(f"fact {f['key']}: {canonical_json(f['value'])}")  # list value คงลำดับ
for v in r["steps"]:       lines.append(f"step: {v}")
lines.append(f"answer_text: {r['answer_text']}")
# semantic_digest = sha256("\n".join(lines).encode("utf-8")).hexdigest()
# ห้ามรวม shop/platform/provenance/readiness/record_id/filename/timestamps
```

**Artifact filenames (closed set — default format ก่อน 4D ตัดสิน):** `vectors.npz` (keys `digests`, `embeddings`, `generation_id`), `record_map.json`, `structured_index.json`, `manifest.json` — serialization `canonical_json` (deterministic). manifest `format` values: `"npz"`/`"json"` — 4D เปลี่ยน encoding ได้แต่ schema เดิม

---

## Task 1 — neutral test-infra owner + Phase 4 helpers

- **Objective:** extract Mongo doubles ไป neutral owner `docs/test/tools/mongo_doubles.py` (impl ชุดเดียว — ห้าม copy, ห้ามชุดที่สี่, **ห้าม import test module เพื่อ reuse**) แล้วสร้าง Phase 4 helpers ที่ import จากมันเท่านั้น
- **เหตุ (review-confirmed):** `test_legacy_turn_incident_replay.py` มี import-time side effects (`os.environ` mutation + socket tripwires + `app` import ที่ `load_dotenv()` — บรรทัด 53+); `test_phase4b_refresh.py:36` import จากมัน → helpers ที่ import ไฟล์เหล่านี้ฝ่า isolation contract ทันที
- **Files to read:** `test_legacy_turn_incident_replay.py:119–300` (`_norm`/`_get_path`/`_match`/`_Cursor`/`FakeColl`/`FakeDb`/`FakeClient` — block เดียวย้ายได้ verbatim; `_norm_set`:624 เป็น suite-local ทิ้งไว้), `test_phase4b_refresh.py:36–37,71–173` (`GenColl`/`GenDb` + late `_match` imports :106,120,134), `test_zaapi_kb_import.py:30–84` (`MemoryCollection` — ทิ้งไว้ใน suite เดิม), `kb_zaapi_schema.py:295–446`, `docs/test/fixtures/zaapi_kb_minimal/`
- **Files expected to modify:** create `docs/test/tools/mongo_doubles.py`; modify `test_legacy_turn_incident_replay.py` (ลบ 7 defs → re-import), `test_phase4b_refresh.py` (ลบ 2 classes + late imports → re-import); create `docs/test/tools/zaapi_phase4_helpers.py`; create `docs/test/live/test_phase4_zaapi_isolation.py` (doubles-owner test แรก — file นี้รับ isolation tests ของ T12 ด้วย)
- **Owner:** test-infra `mongo_doubles.py` (ไม่ใช่ production owner — ไม่นับ mechanism)
- **RED test:** `docs/test/live/test_phase4_zaapi_isolation.py` —
  ```python
  def test_doubles_single_owner_and_no_test_module_import():
      import mongo_doubles as md
      from test_phase4b_refresh import GenDb, GenColl          # re-import path
      from test_legacy_turn_incident_replay import FakeColl, FakeDb, FakeClient
      assert GenDb is md.GenDb and GenColl is md.GenColl
      assert FakeColl is md.FakeColl and FakeDb is md.FakeDb and FakeClient is md.FakeClient
  def test_helpers_do_not_import_test_modules():
      # subprocess: sys.path เตรียม → import zaapi_phase4_helpers →
      # assert "test_legacy_turn_incident_replay" และ "test_phase4b_refresh" ไม่อยู่ใน sys.modules
  ```
  Run → **FAIL** (`ModuleNotFoundError: mongo_doubles`)
- **Minimal GREEN:** `mongo_doubles.py` = ย้าย verbatim `_norm`/`_get_path`/`_match`/`_Cursor`/`FakeColl`/`FakeDb`/`FakeClient`/`GenColl`/`GenDb` (+imports `SimpleNamespace`, `re`); donor files แทนด้วย `from mongo_doubles import ...` (test_phase4b_refresh late imports :106,120,134 → module-level); helpers ตามเดิมแต่ `from mongo_doubles import GenDb, GenColl, _match` เท่านั้น:
  ```python
  def record(*, record_type="spec", topic="t", model_codes=("CB-100",), aliases=(),
             item_id=None, model_id=None, subject_id=None, target_id=None,
             facts=(), answer_text="", steps=(), shop="ShopA", platform="shopee",
             content_fingerprint=None, readiness="resolved", **over): ...
  def manifest_for(record_dicts_by_source) -> dict: ...
  def stub_embed(texts, batch_size=32): ...          # deterministic seeded normalize แล้ว
  def block_network(monkeypatch): ...              # socket tripwire (own impl — helpers เป็น owner)
  ```
- **Regression tests:** `pytest docs/test/live/test_legacy_turn_incident_replay.py docs/test/offline/test_phase4b_refresh.py docs/test/offline/test_zaapi_kb_import.py -q` — donor suites ต้องผ่านเหมือนเดิม (re-import resolve) + baseline 416 คง
- **Verification command:** `.venv/bin/python -m pytest docs/test/live/test_phase4_zaapi_isolation.py docs/test/live/test_legacy_turn_incident_replay.py docs/test/offline/test_phase4b_refresh.py docs/test/offline/test_zaapi_kb_import.py -q` + `grep -n "class FakeColl\|class GenColl" docs/test/*.py` → เหลือเฉพาะ `mongo_doubles.py`
- **Mongo/provider/network side effects:** ไม่มี
- **Stop condition:** `class FakeColl`/`class GenColl` เหลือใน donor file / donor suite แตก / helpers import test module → หยุด (ห้าม copy impl — move เท่านั้น)
- **Expected mechanism delta:** test-infra owner +1 (`mongo_doubles.py` — test code ไม่นับ production mechanism); fake Mongo ชุดใหม่ +0; impl duplicates −0 (move ไม่ใช่ copy)
- **SRS:** ไม่มี (test-only)
- **Commit boundary:** `mongo_doubles.py` + donor re-imports + helpers + isolation test — commit เดียว
- **Depends on:** —

## Task 2 — `canonical_delivery_scope` owner consolidation

- **Objective:** owner เดียวของ delivery-scope normalization ตาม spec §5 — รวม inline copy 2 จุดใน `account_scope_fingerprint`
- **Files to read:** `kb_zaapi_schema.py:56–86` (fingerprint+scope fn), `docs/test/offline/test_zaapi_kb_import.py` (scope-related tests), spec §5/§8/§16.25,31
- **Files expected to modify:** `chatbot/shopeechat/kb_zaapi_schema.py`, create `docs/test/offline/test_phase4_zaapi_scope.py`, `docs/SRS_SSD.md`
- **Owner:** `kb_zaapi_schema.py` (data-contract owner เดิม — ไม่ใช่ owner ใหม่)
- **RED test:** `docs/test/offline/test_phase4_zaapi_scope.py` —
  ```python
  def test_scope_owner_parity_and_truth_table():
      from shopeechat.kb_zaapi_schema import canonical_delivery_scope
      # shop: whitespace collapse (leading/trailing/internal) → match; case-sensitive → NOT match
      assert canonical_delivery_scope("  Shop  A ", " shopee ") == ("Shop A", "shopee")
      assert canonical_delivery_scope("Shop A", "SHOPEE") == ("Shop A", "shopee")
      assert canonical_delivery_scope("shop a", "shopee") == ("shop a", "shopee")
      # parity: คู่ normalized เดียวกับที่ account_scope_fingerprint ใช้ hash → same input same fingerprint
  def test_account_scope_fingerprint_uses_owner(): ...
      # accounts [{name:"  Shop  A ",platform:" SHOPEE "}] เทียบ [{name:"Shop A",platform:"shopee"}] → fingerprint เท่ากัน (เดิมผ่านอยู่แล้ว — ยืนยันไม่แตกหลัง refactor)
  ```
  Run: `pytest docs/test/offline/test_phase4_zaapi_scope.py -q` → **FAIL** (`ImportError`/`AttributeError` — function ยังไม่มี)
- **Minimal GREEN:**
  ```python
  def canonical_delivery_scope(shop: str, platform: str) -> tuple[str, str]:
      """delivery scope normalization owner เดียว (shop collapse whitespace case-sensitive,
      platform strip+casefold) — callers validate types ที่ boundary เท่านั้น"""
      return " ".join(shop.split()), platform.strip().casefold()
  ```
  แล้วแทน inline ใน `account_scope_fingerprint` ทั้ง 2 จุด (`" ".join(account.get("name","").split())`, `account.get("platform","").strip().casefold()` → `canonical_delivery_scope(account.get("name",""), account.get("platform",""))`)
- **Regression tests:** `pytest docs/test/offline/test_phase4_zaapi_scope.py docs/test/offline/test_zaapi_kb_import.py -q` + `python -m py_compile chatbot/shopeechat/kb_zaapi_schema.py`
- **Verification command:** เหมือน regression + ค้นหา inline คงเหลือ `grep -n '" ".join(.*split())' kb_zaapi_schema.py` → เหลือเฉพาะใน `canonical_delivery_scope`
- **Mongo/provider/network:** ไม่มี
- **Stop condition:** parity test แตก / fingerprint ของ fixture เดิมเปลี่ยน → revert แล้วรายงาน (normalization semantics ห้ามขยับ)
- **Expected mechanism delta:** pure data-contract fn +1 (budgeted), duplicated normalization callsites −2, owners +0
- **SRS:** เพิ่ม `canonical_delivery_scope` entry + แก้ `account_scope_fingerprint` (Calls เปลี่ยน)
- **Commit boundary:** scope fn + tests + SRS — commit เดียว
- **Depends on:** T1

## Task 3 — `load_active_state` owner move

- **Objective:** owner เดียวของ "materialize active canonical records" ย้ายจาก `docs/zaapi/script/import_zaapi_kb.py` → `kb_zaapi_schema.py` — runtime (generation build) ห้าม import docs script
- **Files to read:** `import_zaapi_kb.py:214–227` (function ต้นฉบับ), `:42–48` (import block), callsites 270,399,418,439; `export_zaapi_kb.py:16,45`; `docs/test/offline/test_zaapi_kb_import.py:2327` (`importer.load_active_state` call)
- **Files expected to modify:** `kb_zaapi_schema.py` (+function), `import_zaapi_kb.py` (ลบ def, เพิ่มใน import list), `export_zaapi_kb.py` (เปลี่ยน import source), `docs/SRS_SSD.md`
- **Owner:** `kb_zaapi_schema.py` — **implementation เหลือชุดเดียว; re-export compatibility เท่านั้น**
- **RED test:** เพิ่มใน `docs/test/offline/test_phase4_zaapi_scope.py` —
  ```python
  def test_load_active_state_lives_in_schema_owner():
      import shopeechat.kb_zaapi_schema as schema
      assert callable(schema.load_active_state)          # owner เดียว
      import import_zaapi_kb as imp                       # (sys.path docs/zaapi/script)
      assert imp.load_active_state is schema.load_active_state   # re-export, ไม่ใช่ impl ซ้ำ
  ```
  + behavioral: MemoryCollection + `manifest_for` fixture → `schema.load_active_state` คืน validated docs (reuse `importer` fixture เดิม)
  Run → **FAIL** (schema ไม่มี function)
- **Minimal GREEN:** ย้าย function body verbatim (docstring คงเดิม) เข้า `kb_zaapi_schema.py`; `import_zaapi_kb.py` เพิ่ม `load_active_state` ใน `from shopeechat.kb_zaapi_schema import (...)` block แล้วลบ def เดิม; `export_zaapi_kb.py` เปลี่ยน `from import_zaapi_kb import load_active_state` → `from shopeechat.kb_zaapi_schema import load_active_state`
- **Regression tests:** `pytest docs/test/offline/test_zaapi_kb_import.py docs/test/offline/test_phase4_zaapi_scope.py -q` → ทั้ง suite ต้องผ่านเหมือนเดิม (importer re-export ทำให้ `importer.load_active_state` resolve)
- **Verification command:** เดิม + `python -m py_compile` ทั้ง 3 ไฟล์ + `grep -rn "def load_active_state" chatbot/ docs/` → เหลือ 1 จุด (`kb_zaapi_schema.py`)
- **Mongo/provider/network:** ไม่มี
- **Stop condition:** `def load_active_state` เหลือ >1 จุด หรือ suite เดิมแตก → หยุด (ห้ามคง impl ซ้ำ — user-locked)
- **Expected mechanism delta:** owners +0 (move), functions +0 net (ย้าย), importer/exporter diff น้อยสุด
- **SRS:** เพิ่ม `load_active_state` entry (Purpose/Input/Output/Calls/Called by — importer/exporter/generation build)
- **Commit boundary:** move + tests + SRS — commit เดียว
- **Depends on:** T2 (ไฟล์เดียวกัน)

## Task 4 — Model identity audit + pin (embedding.py + dependency contract)

- **Objective:** immutable BGE-M3 revision + exact ST version + `model_identity()` owner — ล็อก identity 6 fields ตาม spec §13
- **Files to read:** `embedding.py` ทั้งไฟล์, `requirements.txt`, `docker/Dockerfile.chatbot:16–21`, `docs/test/offline/test_phase10b_description_builder.py` (embed seams), `docs/test/live/test_legacy_turn_incident_replay.py:330–340,460–470` (`_get_model` mock seam), spec §13
- **Files expected to modify:** `embedding.py`, `requirements.txt`, `docker/Dockerfile.chatbot`, `docs/SRS_SSD.md`
- **Owner:** `embedding.py` (model-loading owner เดียว — loader +0)
- **Audit step (ก่อนเขียน test — บังคับ ห้าม placeholder):**
  - [ ] `.venv/bin/python -c "import sentence_transformers as st; print(st.__version__)"` → บันทึกค่าจริง (วันนี้ = 5.7.0 — ยืนยันซ้ำ ณ วันทำ)
  - [ ] resolve revision ที่ loader ใช้จริง — **ห้ามถือ `refs/main` เป็น proof อัตโนมัติ (user-locked) และลอง local-only ก่อนเสมอ:**
    ```bash
    .venv/bin/python - <<'PY'
    from huggingface_hub import snapshot_download
    p = snapshot_download("BAAI/bge-m3", revision="main", local_files_only=True)
    print(p)                                                # …/snapshots/<commit> — no network
    PY
    ```
    `local_files_only=True` resolve ไม่ได้ → **STOP → ขออนุญาตผู้ใช้แยก** (HF network call หรือผู้ใช้ระบุ commit เอง) — ห้าม network โดยไม่ขอ; resolve ได้ (cache วันนี้ `5617a9f6…` ที่ refs/main) ต้องยืนยันอีกชั้นด้วย `SentenceTransformer("BAAI/bge-m3", revision=<candidate>, device="cpu")` โหลดจริงจาก snapshot นั้น — `HF_HUB_OFFLINE=1` env กัน auto-fetch; load ไม่ผ่าน → **STOP** รายงาน ห้ามเดาค่า
  - [ ] บันทึกคู่ `(MODEL_REVISION, sentence_transformers_version)` จริงลง task evidence — ค่านี้คือสิ่งที่ gen doc จะ pin
- **RED test:** `docs/test/offline/test_phase4_zaapi_scope.py` เพิ่ม (หรือแยก `test_phase4_model_pin` ในไฟล์เดิมเพื่อรวมเทสต์ contract):
  ```python
  def test_loader_uses_immutable_revision(monkeypatch):
      captured = {}
      import shopeechat.embedding as emb
      monkeypatch.setattr(emb, "_model", None)
      import sentence_transformers
      monkeypatch.setattr(sentence_transformers, "SentenceTransformer",
                          lambda *a, **kw: captured.update(kw) or object())
      emb._get_model()
      assert captured.get("revision") == emb.MODEL_REVISION
      assert len(emb.MODEL_REVISION) == 40 and set(emb.MODEL_REVISION) <= set("0123456789abcdef")
  def test_model_identity_six_fields():
      ident = emb.model_identity()
      assert set(ident) == {"name","revision","sentence_transformers_version","dim",
                            "normalize_embeddings","output_dtype"}
      assert ident["name"] == "BAAI/bge-m3" and ident["dim"] == 1024
      assert ident["normalize_embeddings"] is True and ident["output_dtype"] == "float32"
  ```
  Run → **FAIL**
- **Minimal GREEN:** `MODEL_REVISION = "<audited 40-hex>"`; `_get_model` → `SentenceTransformer(MODEL_NAME, revision=MODEL_REVISION, device=DEVICE)`; `model_identity()` คืน 6-field dict (`sentence_transformers_version` จาก `importlib.metadata.version("sentence-transformers")` — resolve ไม่ได้ → raise/None ตาม contract; `dim=EMBEDDING_DIM`, `normalize_embeddings=True`, `output_dtype="float32"` ตาม `embed_texts` contract เดิม); `requirements.txt` +`sentence-transformers==<installed exact>`; Dockerfile ลบ `sentence-transformers` ออกจาก line 19 (คง `pythainlp rapidfuzz`)
- **Regression tests:** `pytest docs/test/offline/test_phase10b_description_builder.py docs/test/live/test_legacy_turn_incident_replay.py -q` (embed seams ต้องไม่แตก) + py_compile `embedding.py`
- **Verification command:** ข้างบน + `python -c "from shopeechat import embedding; assert embedding.model_identity()['revision']==embedding.MODEL_REVISION"` + `grep -n "sentence-transformers" requirements.txt docker/Dockerfile.chatbot` → อยู่เฉพาะ requirements.txt (pinned)
- **Mongo/provider/network:** model resolve step อาจแตะ HF cache/network ครั้งเดียว (cache มีอยู่แล้ว — ห้ามบังคับ download; offline resolution ก่อน)
- **Stop condition:** revision resolve ไม่ได้ / load จริงไม่ผ่าน / ST version ไม่ตรง env → **หยุดรายงาน ห้าม placeholder** (spec: resolve ไม่ได้ → build reject ก่อนเขียน)
- **Expected mechanism delta:** loader +0, model-identity accessor +1 (`model_identity`), constant +1 (`MODEL_REVISION`), dependency +0 (pin contract เปลี่ยนเท่านั้น), Dockerfile unpinned dep −1
- **SRS:** `embedding.py` — `MODEL_REVISION`, `model_identity`, `_get_model` (signature/behavior)
- **Commit boundary:** audit evidence + pin + dep contract + tests + SRS — commit เดียว
- **Depends on:** T1 (test conventions)

## Task 5 — closed-schema validators (schema owner)

- **Objective:** closed-schema validators 3 ตัวใน `kb_zaapi_schema.py` — pointer doc (§12), gen doc (§11), artifact manifest object (§10) — pure dict validation สไตล์ `validate_manifest` เดิม (fail closed `ValueError`, ไม่มี I/O)
- **Files to read:** `kb_zaapi_schema.py:449–517` (validator style), spec §10–§12 (field tables เป๊ะ ๆ)
- **Files expected to modify:** `kb_zaapi_schema.py`, `docs/test/offline/test_phase4_zaapi_generation.py` (create — validator tests อยู่ชุด generation), `docs/SRS_SSD.md`
- **Owner:** `kb_zaapi_schema.py`
- **RED test (ตัวอย่าง — ครบ truth tables):**
  ```python
  def test_pointer_closed_schema(bootstrap_doc): ...
      # exact key set {_id,revision,generation_id,previous_generation_id,canonical_generation,activated_at}
      # extra/missing field → ValueError; revision bool/0/-1 → reject; previous None ok / "g.." ผิด → reject
      # canonical_generation non-64hex/uppercase → reject; activated_at naive/non-UTC/malformed → reject
  def test_gen_doc_closed_schema(): ...
      # canonical_generation != fingerprint(canonical_sources) → reject; status != "ready" → reject
      # model{} ไม่ครบ 6 fields / type ผิด → reject; artifacts.manifest ขาด file/sha256/size_bytes/format → reject
  def test_artifact_manifest_closed_schema(): ...
      # extra/missing field, bool-as-int, negative counts, field_count!=6, generation_id mismatch → reject
  ```
  Run → **FAIL**
- **Minimal GREEN:** 3 validators (style เดียวกับ `validate_manifest` — `_plain_int`/`_nonempty_str` reuse, `GEN_ID_RE` import จาก generation_pointer, `activated_at` parse ด้วย `datetime.fromisoformat` + tz UTC check เท่านั้น, ห้าม regex ใหม่)
- **Regression tests:** `pytest docs/test/offline/test_zaapi_kb_import.py -q` + py_compile
- **Verification command:** `pytest docs/test/offline/test_phase4_zaapi_generation.py -q`
- **Mongo/provider/network:** ไม่มี
- **Stop condition:** validator ยอมรับ doc ที่ schema เดิมตั้งใจปฏิเสธ → หยุด
- **Expected mechanism delta:** data-contract validators +3 (schema owner เดิม — ไม่ใช่ duplicate validation: เป็น source เดียวที่ทั้ง generation/retrieval เรียก), owners +0
- **SRS:** +3 function entries
- **Commit boundary:** validators + tests + SRS — commit เดียว
- **Depends on:** T3 (ไฟล์เดียวกัน)

## Task 6 — generation builders (pure logic + atomic artifact writers)

- **Objective:** `kb_zaapi_generation.py` ชุด pure builders — `semantic_text`/`semantic_digest`/`record_set_digest`/`build_record_map`/`build_structured_index`/`build_manifest_payload` + atomic artifact writers (tmp→verify→`os.replace` pattern จาก `build_embeddings.py:58`)
- **Files to read:** spec §5,§7,§10,§16.1–2,24,26,27,33,36; `build_embeddings.py:46–76` (embed seam + `_save_verified_npz` pattern), `publish_generation.py:48–53,254–267` (`sha256_file`/`finalize_manifest` patterns)
- **Files expected to modify:** create `kb_zaapi_generation.py`; extend `docs/test/tools/zaapi_phase4_helpers.py` (+`write_gen_dir` ที่เรียก builders เหล่านี้); `docs/test/offline/test_phase4_zaapi_generation.py`; `docs/SRS_SSD.md`
- **Owner:** `kb_zaapi_generation.py` (owner 1 — lifecycle)
- **RED test:**
  - `test_semantic_text_determinism` — record เดียวกัน → bytes เดียวกัน; field order คงที่ (§16.1)
  - `test_semantic_digest_truth_table` — 7 แถว spec §7 ครบ: same semantics/scope-only/provenance-only → digest เดียวกัน; identity-refs/facts/steps/list-order/raw-diff-extract-diff → ต่างกัน (§16.2)
  - `test_record_map_self_contained` — `text` ครั้งเดียวต่อ digest; records sorted by `record_id`; projections `{record_id,shop,platform,item_id,model_id,subject_id,target_id}` — `shop`/`platform` normalize ผ่าน `canonical_delivery_scope` (T2) ตอนเขียน (§16.24 build-side)
  - `test_structured_index_namespaces` — 6 namespaces ครบ, value `strip()`, postings sorted+unique, value strip แล้วว่าง → ไม่ index (unreachable per §8 — ระบุใน test docstring); cross-field ไม่ชน (`"ABC"` ทุก field → แยก postings) (§16.32/33 build-side)
  - `test_manifest_deterministic` — rebuild → bytes เดียวกัน; exact key set 3 roles + ไม่มี self entry (§16.27,36)
  - `test_reproducibility_boundary` — builders ทั้งชุดบน input เดียวกัน → outputs เท่ากันเป๊ะ (§16.26 — vector bytes แยกเคส same-runtime)
  Run → **FAIL** (module ไม่มี)
- **Minimal GREEN:** module ใหม่ตาม locked interface; `semantic_text` ตาม renderer ด้านบน; `build_record_map` — digest→`{vector_index: <sorted-digest position>, text, records:[projection...sorted by record_id]}` (projections normalize scope ผ่าน `canonical_delivery_scope`); `build_structured_index` — closed 6 namespaces `item_id/model_id/model_code/alias/subject_id/target_id`, `value.strip()`, skip empty-after-strip, postings `sorted(set(...))`; `build_manifest_payload` — exact §10 schema (canonical_json bytes); writers `_write_artifact(dir_tmp, name, bytes_or_npz)` → tmp→sha256/size verify→`os.replace`; `_sha256_file` pattern-copy (5 บรรทัด — ห้าม import จาก publish_generation เพราะ module นั้นมี `sys.path.insert` side effect ที่ top-level)
- **Regression tests:** `pytest docs/test/offline/test_phase4_zaapi_generation.py docs/test/offline/test_phase4_zaapi_scope.py -q` + py_compile
- **Verification command:** เดิม
- **Mongo/provider/network:** ไม่มี (builders pure — embed ผ่าน injected callable เท่านั้น)
- **Stop condition:** deterministic tests flake (output ไม่นิ่งข้าม run) → หยุด — deterministic เป็น hard contract ข้อ 2
- **Expected mechanism delta:** owner ใหม่ +1 ของ 2 (budgeted), helpers/heuristic +0 — builders เป็น contract serialization ไม่ใช่ business helper
- **SRS:** module + function entries (Purpose/Input/Output/Calls/Called by ครบ)
- **Commit boundary:** module + builders + tests + SRS — commit เดียว
- **Depends on:** T2 (scope fn), T3 (`load_active_state` ใน schema), T5 (validators)

## Task 7 — retrieval loaders (snapshot + artifact chain)

- **Objective:** `kb_zaapi_retrieval.py` ชุด load path — `_load_artifacts` (validation chain ชั้น 1–3), `load_generation_snapshot`, `load_active_generation`, `ZaapiKbSnapshot` — fail closed ทุก corruption ตาม spec §14
- **Files to read:** spec §8,§10,§11,§12,§14; `generation_pointer.py:81–120` (snapshot validation style); `units.py:66–85` (npz load + gen-id assert pattern); T5 validators; T6 artifact layout
- **Files expected to modify:** create `kb_zaapi_retrieval.py`; helpers (+`write_gen_dir`, `tamper_*` utilities สำหรับ corruption matrix); `docs/test/offline/test_phase4_zaapi_retrieval.py` (create); `docs/SRS_SSD.md`
- **Owner:** `kb_zaapi_retrieval.py` (owner 2 — standalone retrieval)
- **RED test:**
  - `test_self_containment` — snapshot จาก artifacts เพียงอย่างเดียว (canonical colls absent/stubbed ใน GenDb) → load สำเร็จ (§16.21)
  - `test_corruption_matrix` — pointer missing/invalid → None; gen doc missing/corrupt → None; `manifest.json` missing/hash mismatch → None; payload hash/shape/count/dim corrupt → None; index namespace นอก 6/ขาด/posting dup/unsorted → None (§16.8,33 — fail closed ไม่ fallback gen อื่น)
  - `test_path_traversal` — gen doc บังคับ foreign gid/absolute/`..` (ผ่าน helpers ที่เขียน dir ปกติ แต่ gen doc/pointer ปลอม) → None (§16.9)
  - `test_model_compat` — runtime `model_identity()` ≠ gen doc ทีละ field ครบ 6 → snapshot โหลดแต่ `model_compatible=False` (exact ยังใช้ได้ — §16.34 load-side)
  - `test_pointer_schema` — validate ผ่านทั้ง good + reject rows (§16.39 read-path)
  Run → **FAIL**
- **Minimal GREEN:** `_load_artifacts(gen_dir, gen_doc)` — เช็ค `artifacts.manifest` file+sha256+size จริง (ชั้น 1) → parse manifest obj → `validate_artifact_manifest` (T5) → เช็ค payload bytes ต่อ role (ชั้น 2) → load (np.load / json.loads canonical check) + shape/dim/count/dtype/cross-counts ตาม §11 ชั้น 3 → คืน `{vectors, digests, record_map, structured_index}`; `load_generation_snapshot` — gen doc read+`validate_gen_doc` → `_load_artifacts` → derive `record_index` (record_id→(digest,projection) จาก record_map sorted digest order) → model compat 6 fields (`embedding.model_identity()` — ST version ผ่าน `importlib.metadata` ไม่ต้องโหลด model) → snapshot; `load_active_generation` — pointer find_one + `validate_gen_pointer` → `load_generation_snapshot(pointer.gid)`; ทุก fail → `None` (+log print เบา ๆ ตาม pattern `[GEN]`/`[UNITS]` — **None เป็น internal loader signal เท่านั้น ไม่ใช่ public contract**: spec §14 บังคับ result ว่าง + trace ที่ boundary → `retrieve_active` ใน T8 เป็นตัวแปลง None→`("generation_unavailable",)`; canary/publish ใช้ None เป็น reject signal โดยตรง ไม่ต้องมี trace)
- **Regression tests:** `pytest docs/test/offline/test_phase4_zaapi_retrieval.py -q` + suite เดิม 416
- **Verification command:** เดิม
- **Mongo/provider/network:** ไม่มี (GenDb + tmp artifact dirs)
- **Stop condition:** corruption case ใดผ่านมือ loader (silent serve) → หยุด — fail-closed เป็น hard contract
- **Expected mechanism delta:** owner ใหม่ +1 ของ 2 (budgeted), loaders +0 จาก shared singleton
- **SRS:** module + function entries
- **Commit boundary:** module + loaders + tests + SRS — commit เดียว
- **Depends on:** T4 (model identity), T5 (validators), T6 (artifact layout)

## Task 8 — `retrieve()` full query contract

- **Objective:** `retrieve()` ครบ — boundary validation → scope normalize → structured channels → semantic channel → scoped merge → `limit` → producer records → `KbEvidenceResult`; + `retrieve_active(db, ...)` end-to-end entrypoint ที่แปลง load failure → ว่าง + trace ตาม spec §14
- **Files to read:** spec §8,§9,§14 (failure rows),§16.3–7,17,22–25,28–32,38; `answer_context.py:73–134` (result contract), `knowledge_base.py:1203–1212` (`KbEvidenceResult`), `kb_zaapi.py:67` (lazy import convention)
- **Files expected to modify:** `kb_zaapi_retrieval.py`; `docs/test/offline/test_phase4_zaapi_retrieval.py`; `docs/SRS_SSD.md`
- **Owner:** `kb_zaapi_retrieval.py`
- **RED test (ทุก cluster — synthetic snapshot ในหน่วยความจำ, embed ผ่าน monkeypatch `embed_query`):**
  - `test_query_validation_truth_table` (§16.28): valid exact-only/semantic-only/combined; no-input→`no_query`; scope normalize แล้วว่าง→`invalid_query`; container ผิด type (`dict`,`str`,`set`,`int`)→`invalid_query`; element ไม่ใช่ str→`invalid_query`; ref ว่างหลัง strip→`invalid_query`; `limit` bool/0/-1/`EVIDENCE_LIMIT+1`/non-int→`invalid_query`; `semantic_query` ผิด type→`invalid_query` — **ทุกเคส result ว่าง+trace ไม่ raise**
  - `test_whitespace_semantic` (§16.29): `"   "`→ไม่มี semantic channel (assert `embed_query` **ไม่ถูกเรียก** — monkeypatch counter); typed hits ยังทำงาน; non-empty ส่ง bytes เดิม
  - `test_duplicate_refs_noop` (§16.30): `("X","X")` == `("X",)` ทั้ง membership+order
  - `test_exact_strip_and_namespaces` (§16.3,32): `" X "`match`"X"`; internal whitespace/case ไม่ match; `"ABC"` ทุก field → `item_ids=["ABC"]` เห็นเฉพาะ item_id postings; mixed → union เฉพาะ namespaces ที่ขอ
  - `test_scope_isolation` (§16.4,25): คนละ shop/platform ไม่ leak; shop case-sensitive; platform casefold
  - `test_merge_dedupe` (§16.5): structured ก่อน, semantic ตาม (score desc, tie→record_id asc); dedupe record_id structured ชนะ; deterministic
  - `test_semantic_unavailable` (§16.6,7): `model_compatible=False` + exact hits → hits + `semantic_unavailable`; semantic-only → ว่าง+trace; `embed_query` raise → เดียวกัน
  - `test_scoped_ranking` (§16.38): foreign top-scored หลายตัว + local hits ไม่หลุด `limit`; shared digest (local+foreign projections) → เฉพาะ local projection; foreign exact posting ไม่กิน quota; `limit` หลัง merge
  - `test_materialization` (§16.22,23): `payload.text` == `record_map[digest].text` verbatim; `item_id`/`identity`(`subject_id`→`model_id` precedence)/`target` ตรง verbatim; ไม่มี field ว่าง/None
  - `test_producer_closed_record` (§16.17): ไม่มี `request_id`/`need_indices`/`linked_candidate`/`subject_refs`; `kind=="kb"`; `payload` = `{"text": str}`
  - `test_shared_digest_scope` (§16.24 retrieve-side): digest เดียวกัน 2 records 2 scopes — query แต่ละ scope ได้ projection ของตัวเองเท่านั้น
  - `test_load_failure_trace` (§14 pointer/gen-doc/artifact rows — **end-to-end ผ่าน `retrieve_active`**):
    ```python
    def test_load_failure_becomes_empty_result_with_trace():
        # GenDb: pointer absent / corrupt (validate_gen_pointer fail) / gen doc missing /
        # manifest hash mismatch — แต่ละเคสผ่าน helpers.tamper_*
        res = retrieve_active(db, shop="ShopA", platform="shopee", item_ids=("IT-1",))
        assert isinstance(res, KbEvidenceResult)
        assert res.supporting_evidence == () and res.raw_count == 0
        assert "generation_unavailable" in res.trace          # marker เดียวสำหรับทุก load failure
        # snapshot ใช้ได้ → retrieve_active → เหมือน retrieve(snap, ...) เป๊ะ (delegation identity)
    ```
  Run → **FAIL**
- **Minimal GREEN:** `retrieve()` ตาม locked interface — validation group เดียว (boundary เดียว); `_postings_for(structured_index, ns, refs)`; exact: union postings→`record_index`→scope filter→`sorted(record_id)`; semantic: `embed_query` (lazy `from . import embedding as _emb`)→`vectors @ q`→eligible digests (≥1 projection ใน scope)→score desc (tie digest asc)→expand เฉพาะ scope-matching records→(score desc, record_id asc); merge structured+semantic→dedupe→`limit`→`_evidence_record(digest, projection)` per spec §9 mapping (omit empty); `trace` markers: `invalid_query`/`no_query`/`semantic_unavailable`/`generation_unavailable` (+hit counters สั้น deterministic เช่น `exact=2`,`semantic=1`); `retrieve_active()` = `load_active_generation(db, exports_root=…)` → `None` ⇒ `KbEvidenceResult(supporting_evidence=(), raw_count=0, trace=("generation_unavailable",))` else `retrieve(snap, **kwargs)` — public type +0
- **Regression tests:** `pytest docs/test/offline/test_phase4_zaapi_retrieval.py -q` ครบไฟล์
- **Verification command:** เดิม + `python -m py_compile chatbot/shopeechat/kb_zaapi_retrieval.py`
- **Mongo/provider/network:** ไม่มี (snapshot synthetic; `embed_query` monkeypatch — offline)
- **Stop condition:** เคส malformed ใด raise แทน result ว่าง / scope leak ตัวใดผ่าน → หยุด
- **Expected mechanism delta:** trust-boundary validation +1 กลุ่ม (budgeted), result type +0, keyword/heuristic +0
- **SRS:** `retrieve` entry ครบ (input ตาราง kwargs + contract)
- **Commit boundary:** retrieve + tests + SRS — commit เดียว
- **Depends on:** T7

## Task 9 — `validate_generation` + `build_generation` + ready doc insert

- **Objective:** generation owner orchestration — model identity → `load_active_state` → pin → builders → tmp dir → `_load_artifacts` verify → canonical cross-checks → atomic rename → `insert_one` ready doc — failure ไม่แตะ pointer/doc
- **Files to read:** spec §6,§11,§13,§14; T3 `load_active_state`, T6 builders, T7 `_load_artifacts`; `build_embeddings.py` (batch embed pattern), `publish_generation.py:318–388` (identity gate style)
- **Files expected to modify:** `kb_zaapi_generation.py`; helpers (+canonical-state fixture: raw rows + records + manifest บน GenDb); `docs/test/offline/test_phase4_zaapi_generation.py`; `docs/SRS_SSD.md`
- **Owner:** `kb_zaapi_generation.py`
- **RED test:**
  - `test_build_happy_path` — GenDb canonical state (fixture) + `stub_embed` → `build_generation` คืน `{generation_id,record_count,digest_count}`; gen dir ครบ 4 artifacts; gen doc `_id="gen:<gid>"` `status="ready"` fields ครบ §11; pointer **ไม่แตะ** (ไม่มี active doc)
  - `test_build_determinism` — build 2 ครั้ง input เดียวกัน (gid ต่าง) → digests/record_map/structured_index/record_set_digest เท่ากันเป๊ะ (§16.26 build-side)
  - `test_build_failure_no_side_effects` — embed raise / manifest invalid → raise; ไม่มี gen doc; pointer ไม่เปลี่ยน; tmp dir orphan เท่านั้น (§14 build crash)
  - `test_model_unresolvable_reject` — `model_identity()` resolve ไม่ได้ (monkeypatch ST version missing / revision ว่าง) → **reject ก่อนเขียน artifact/doc ใด ๆ** (§16.34 build-side)
  - `test_pinned_record_drift` — canonical state เปลี่ยนระหว่าง pin กับ validate (helpers แกะ doc หลัง build ก่อน validate — หรือ tamper record แล้ว re-validate) → `validate_generation` reject (§16.8 pinned-record — build/publish path เท่านั้น)
  - `test_canonical_pin_validation` — `canonical_generation != fingerprint(canonical_sources)` → reject (§16.10); `record_set_digest != fingerprint(record_map ids)` → reject; `record_count` mismatch → reject
  Run → **FAIL**
- **Minimal GREEN:** `build_generation(db, *, embed=None, exports_root=None, gid=None, now=None)` ตาม flow §13 (`exports_root` default `ROOT/"exports"`; `gid = gid or mint_generation_id(now)`); `validate_generation(gen_dir, gen_doc, db)` — `validate_gen_doc` (T5) + `_load_artifacts` (T7) + canonical checks (`load_active_state` อ่าน `zaapi_kb_records`+`zaapi_kb_raw_sources` จาก `db` — touch point #1 เท่านั้น); insert `insert_one` (DuplicateKeyError → raise); rename dir — target มีอยู่ → raise (immutable)
- **Regression tests:** `pytest docs/test/offline/test_phase4_zaapi_generation.py -q` + 416 baseline
- **Verification command:** เดิม
- **Mongo/provider/network:** ไม่มี (GenDb + `stub_embed`)
- **Stop condition:** build ล้มแล้วมี doc/pointer ค้าง / non-determinism เกิด → หยุด
- **Expected mechanism delta:** ไม่มี owner เพิ่ม — orchestration ใน owner เดิม; canonical touch point +1 (build — ตาม spec §13 ที่ล็อก 2 จุด)
- **SRS:** `build_generation`, `validate_generation` entries
- **Commit boundary:** orchestration + tests + SRS — commit เดียว
- **Depends on:** T3,T4,T5,T6,T7

## Task 10 — publish/bootstrap CAS + readback + rollback + thin CLI

- **Objective:** publish flow §13 — read+validate gen doc → full `validate_generation` → `expected_canonical` pre-check → canary (arg-passed) → ABA-safe CAS → readback → `newer_canonical_pending`; rollback ผ่าน CAS owner เดียว; bootstrap find→validate→insert เท่านั้น (ห้าม upsert)
- **Files to read:** spec §12,§13,§14,§16.11–16,35,39; `publish_generation.py:270–315,391–410` (CAS/rollback pattern — ห้ามเรียกตรง)
- **Files expected to modify:** `kb_zaapi_generation.py`; create `chatbot/shopeechat/scripts/zaapi_kb_gen.py` (thin CLI: `build`/`publish`/`rollback`/`validate`, `--mongo-uri` + `--db-name` ทั้งคู่ required — **gate `require_disposable_target(uri, db_name)` ก่อน `MongoClient` เสมอ**, ไม่ default ไป shared); `docs/test/offline/test_phase4_zaapi_generation.py`; `docs/SRS_SSD.md`
- **Owner:** `kb_zaapi_generation.py` (CAS +1 budgeted ที่นี่เท่านั้น)
- **RED test:**
  - `test_bootstrap_insert_only` (§16.35 ครบ 7 เคส): absent→`insert_one` สำเร็จ (`previous_generation_id=None`, `revision=1`); concurrent→1 ชนะ 1 `DuplicateKey`→`conflict:<actual>@rev<n>`; existing valid→normal rev+gid CAS; existing ขาด `revision`/ขาด `generation_id`/extra field/type ผิด → **fail closed + bytes เดิมไม่แก้** (assert doc unchanged ทุก byte); ไม่มี upsert path ใน source
  - `test_cas_stale_writer` (§16.11): expected (rev,gid) เก่า → `matched=0` → reread ครั้งเดียว → `conflict:<actual>@rev<n>` ไม่ retry
  - `test_aba_race` (§16.12): จำลอง A→B→A ระหว่าง read→CAS (GenColl hook/ write) → rev mismatch → conflict (gid-only จะผ่านผิด — test ต้องพิสูจน์ filter มี `revision`)
  - `test_rollback` (§16.14): stale expected → conflict; success → previous เป็น active + `previous_generation_id` = OLD + rev+1 + `canonical_generation` ของ prev gen doc + readback ผ่าน; `previous=None` → `conflict:no-previous`
  - `test_canonical_drift` (§16.15): manifest เปลี่ยนก่อน pre-check → reject ก่อน CAS (`canonical_drift`); เปลี่ยนหลัง pre-check (simulate ไม่ได้ตรวจซ้ำ) → publish สำเร็จ + `newer_canonical_pending=True` + ไม่ auto-rollback
  - `test_readback_invalid` (§16.16): write สำเร็จแต่ doc อ่านกลับผิด (helpers แกะ doc ใน `before` hook) → report `readback_invalid` ไม่ auto-rollback
  - `test_canary_gate` — canary case fail → reject ก่อน CAS; case ผ่าน → ดำเนินการ; cases มาจาก arg (gitignored file → parsed list[dict])
  - `test_disposable_target_gate` — refusal matrix ครบ (แต่ละเคส: monkeypatch `MongoClient` counter → **assert 0 calls เสมอ**): `mongodb+srv://…` → reject; non-loopback (`digital.in.th`, `prod.internal`, DNS name ใด ๆ) → reject; `mongodb://localhost:27017` / `:27017` ทุก loopback → **reject**; ไม่มี explicit port → reject; credentials (`user:pass@`) → reject; query/options (`?replicaSet=`) → reject; multi-host (แม้ all-loopback หรือปน 27017) → reject; db path ใน uri (`/anything`) → reject; empty/malformed → reject; `db_name` ผิด (`"admin"`, `"zaapi_kb_records"`, prefix ผิด, suffix สั้น/ว่าง, non-str) → **reject ก่อน client เช่นกัน**; pass: valid uri + `zaapi_kb_p4_verify_<rand>`; **cross-invocation consistency: `(uri, db)` เดียวกันส่ง 2 calls → target เดียวกัน** (ไม่สุ่มใหม่ใน validator)
  - `test_pointer_schema_write_path` (§16.39): doc ที่ publish เขียน → `validate_gen_pointer` ผ่าน round-trip
  Run → **FAIL**
- **Minimal GREEN:** `_cas_swap(db, *, expected_rev, expected_gid, new_gid, canonical_generation, now)` — filter `{_id:"active", revision:R, generation_id:OLD}`, `$set{revision:R+1,generation_id:NEW,previous_generation_id:OLD,canonical_generation,activated_at}`; `_resolve_and_cas` wrapper bootstrap logic; `publish`/`rollback` ตาม §13 flows; `_run_canary(snapshot, cases)` — case schema `{name, query:{retrieve kwargs}, assert:{min_hits?, record_ids?, empty?}}`; CLI thin: parse args → `uri, db = require_disposable_target(args.mongo_uri, args.db_name)` (**validate pair ก่อน — ห้าม `MongoClient` ก่อน validate**; trust-boundary input check ไม่ใช่ business guard/flag) → `MongoClient(uri)[db]` → call owner fns → print `canonical_json` result
- **Regression tests:** `pytest docs/test/offline/test_phase4_zaapi_generation.py -q` ครบไฟล์ + py_compile ทั้ง 2 ไฟล์
- **Verification command:** เดิม + `grep -n "upsert" kb_zaapi_generation.py` → ไม่มี (bootstrap = find+insert_only เท่านั้น)
- **Mongo/provider/network:** ไม่มี (GenDb; canary cases synthetic)
- **Stop condition:** corrupt pointer ถูกแก้/เขียนทับ / CAS ไม่มี revision ใน filter / auto-rollback เกิด → หยุดทันที (invariant)
- **Expected mechanism delta:** CAS impl +1 (budgeted), pointer cache/TTL +0, flags +0
- **SRS:** `publish`, `rollback`, `_cas_swap`, `_run_canary`, script entry
- **Commit boundary:** lifecycle + CLI + tests + SRS — commit เดียว
- **Depends on:** T8 (retrieve สำหรับ canary), T9

## Task 11 — producer→pool→compiler attribution contract (test-only)

- **Objective:** พิสูจน์ producer record จาก `retrieve()` เข้า executor→pool→compiler contract ได้โดยไม่มี Task 5 wiring (§16.17,18) — test อย่างเดียว ไม่มี production code ใหม่
- **Files to read:** `candidate_pool.py:210–260` (stamp), `answer_context.py:492–510,720–840` (`_attribute`/`_compile_evidence`/`_take`), `retrieval_executor.py:285–333`, `docs/test/offline/test_candidate_pool_sources_5d.py`, `docs/test/offline/test_phase7_answer_context.py` (harness seams)
- **Files expected to modify:** create `docs/test/offline/test_phase4_zaapi_attribution.py`; helpers (ถ้าต้องเสริม `RetrievalExecutionResult` factory)
- **Owner:** test-only — หากเผย gap ใน producer record → fix ที่ retrieval owner (ไม่ใช่เพิ่ม code ใน task นี้โดยตรง — แยก correction commit ถ้าจำเป็น)
- **RED test:**
  ```python
  def test_producer_records_survive_attribution_and_compile():
      snap = <synthetic snapshot>; res_kbe = retrieve(snap, shop="ShopA", platform="shopee", item_ids=("IT-1",))
      assert all(set(e) <= {"kind","item_id","identity","target","payload"} for e in res_kbe.supporting_evidence)
      # wrap ใน RetrievalExecutionResult(request_id="r1", source="kb", supporting_evidence=...)
      # → build_candidate_pool seam → _attribute → _compile_evidence →
      # final records: kind=="kb", need_indices เติมจาก request_id, payload == plain str, ≤ _EVIDENCE_RECORD_BYTES, request_id ถูกลบ
      assert isinstance(final[0]["payload"], str) and "request_id" not in final[0]
  ```
  Run → **FAIL** (test file ยังไม่มี — behavioral: producer fields ต้องตรง closed schema)
- **Minimal GREEN:** test passes เมื่อ producer mapping ตรง — ถ้า fail ให้แก้ `_evidence_record` mapping ใน retrieval (separate correction commit) — ห้ามแก้ compiler/pool
- **Regression tests:** `pytest docs/test/offline/test_phase4_zaapi_attribution.py docs/test/offline/test_candidate_pool_sources_5d.py docs/test/offline/test_phase7_answer_context.py -q`
- **Verification command:** เดิม
- **Mongo/provider/network:** ไม่มี
- **Stop condition:** producer record ต้องแก้จนเกิน spec §9 mapping → หยุดรายงาน (contract drift — spec ชนะ)
- **Expected mechanism delta:** +0 (contract proof)
- **SRS:** ไม่มี (ยกเว้น correction ถ้าเกิด)
- **Commit boundary:** attribution test — commit เดียว (test-only)
- **Depends on:** T8 + seams เดิม

## Task 12 — offline/isolation + regression matrix + SRS completeness

- **Objective:** §16.19 (no provider/Mongo leak — socket tripwire), §16.20 (import/order isolation — test files ไม่ poison กัน), รัน regression matrix ครบ, ตรวจ SRS ครบทุก production function
- **Files to read:** `docs/test/live/test_legacy_turn_incident_replay.py:320–470` (seam/tripwire patterns), `docs/test/offline/test_phase4_source_union.py` (import isolation precedent)
- **Files expected to modify:** create `docs/test/live/test_phase4_zaapi_isolation.py`; `docs/SRS_SSD.md` (completeness fixes เท่านั้น)
- **Owner:** test-only
- **RED test:**
  ```python
  def test_no_provider_or_mongo_leak(monkeypatch):
      # block_network(monkeypatch) + รัน retrieve/build-validation path ด้วย fakes → ไม่มี socket call
  def test_import_order_isolation():
      # import kb_zaapi_retrieval/kb_zaapi_generation ลำดับต่างกัน + import test files อื่นก่อน → behavior เดิม
      # ยืนยัน: ไม่มี module-level side effect (ไม่มี Mongo connect/model load ตอน import — lazy เท่านั้น)
  def test_no_new_module_touches_network_or_mongo_at_import():
      # subprocess: sys.path → import modules → assert no socket/connect attempts
  ```
- **Minimal GREEN:** modules ผ่านโดยออกแบบ (lazy imports เท่านั้น — `knowledge_base`/`embedding`/`pymongo` ไม่ถูก import ที่ module level ของ owner ใหม่)
- **Regression tests:** matrix เต็มด้านล่าง — 416 baseline + Phase 4 files ใหม่ทั้งหมดต้องผ่าน; เคสเดิม 0 fail
- **Verification command:** regression matrix (รันครบ — command เดียว):
  ```bash
  .venv/bin/python -m pytest \
    docs/test/offline/test_phase4_zaapi_scope.py docs/test/offline/test_phase4_zaapi_generation.py \
    docs/test/offline/test_phase4_zaapi_retrieval.py docs/test/offline/test_phase4_zaapi_attribution.py \
    docs/test/live/test_phase4_zaapi_isolation.py \
    docs/test/offline/test_zaapi_kb_import.py docs/test/offline/test_phase4b_refresh.py \
    docs/test/offline/test_phase10b_zaapi_primary_evidence.py \
    docs/test/offline/test_phase10b_description_builder.py \
    docs/test/offline/test_phase10b_description_chunks.py \
    docs/test/offline/test_phase7_answer_context.py docs/test/live/test_phase7_boundary_review.py \
    docs/test/offline/test_candidate_pool_sources_5d.py docs/test/offline/test_candidate_pool_union.py \
    docs/test/offline/test_phase4_source_union.py docs/test/live/test_legacy_turn_incident_replay.py -q
  ```
  expected: 416 baseline + Phase 4 tests ผ่านทั้งหมด; เคสเดิม 0 fail
- **Mongo/provider/network:** ไม่มี (ยกเว้น socket tripwire asserts)
- **Stop condition:** suite เดิมแตก / module ใหม่มี import-time side effect / SRS ขาด entry → แก้ก่อนปิด task
- **Expected mechanism delta:** +0
- **SRS:** completeness checklist — `canonical_delivery_scope`, `load_active_state`, `MODEL_REVISION`, `model_identity`, `_get_model`, schema validators ×3, generation module ทุก public fn, retrieval module ทุก public fn
- **Commit boundary:** isolation tests + SRS fixes — commit เดียว
- **Depends on:** T2–T11

## Task 13 — Gate 4A: disposable real-Mongo fidelity

- **Objective:** พิสูจน์ mechanics จริงบน Mongo container — real `DuplicateKeyError`, `matched_count`, `update_one`, readback, BSON 16MiB gate, index behavior — MemoryCollection/GenColl เป็นเพียงตัวจำลอง
- **Entry gate:** plan approved + **ผู้ใช้เปิด Docker Desktop เอง** — ถ้า `docker info` ไม่ผ่าน → **STOP รอผู้ใช้ ห้าม fallback**
- **Files to read:** spec §15 4A; `docs/DEPLOY.md` (docker conventions); refresh precedent `docs/test/offline/test_phase4b_refresh.py`
- **Files expected to modify:** ไม่มี production change; evidence outputs ใต้ `docs/test/results/` (gitignored)
- **Owner:** execution gate (script จาก T10 + importer/exporter เดิม) — ไม่มี owner ใหม่
- **RED test:** ไม่ใช่ code — test matrix บน disposable (**ทุก Mongo access ผ่าน pattern เดียว: `safe_uri, safe_db = require_disposable_target(uri, db_name)` → `MongoClient(safe_uri)[safe_db]` — ห้ามส่ง tuple เข้า client, ห้าม ambient `ADMIN_MONGO_URI`/`_get_admin_db` path เด็ดขาด; importer/exporter เรียก functions ตรงด้วย injected colls ไม่ใช่ CLI**):
  - image gate: `docker image inspect mongo:7` (local-only) — ไม่มี → **STOP ขอ pull approval แยก** → `docker pull mongo:7` เฉพาะหลังอนุมัติ (Docker approval ไม่รวม pull/network)
  - spin `docker run -d --name zaapi-p4-test --label zaapi_phase4=1 --tmpfs /data/db -p 127.0.0.1:<random>:27017 mongo:7` (`--tmpfs` → ไม่สร้าง anonymous/persistent volume เลย; internal localhost เท่านั้น)
  - harness setup: สุ่ม `DB=zaapi_kb_p4_verify_<rand>` **ครั้งเดียว** → pass `--db-name "$DB"` ให้ทุก command/writer (build→publish→rollback→concurrent writers = DB ก้อนเดียวกัน)
  - barrier proof: `require_disposable_target` refusal matrix ครบ (srv/non-loopback/`27017`/no-port/creds/query/multi-host/db-path/malformed + `db_name` ผิด pattern) → ไม่มี connection attempt (socket ว่าง); ambient env `ADMIN_MONGO_URI` ชี้ shared ถ้ามี → **ไม่มีทางถูกอ่าน** (functions รับ colls เท่านั้น)
  - seed: `from import_zaapi_kb import import_source` → `import_source(item, files_dir, raw_coll, records_coll)` raw-only + `import_source(..., extractor=stub)` deterministic — `safe_uri, safe_db = require_disposable_target(uri, DB)` → colls = `MongoClient(safe_uri)[safe_db][...]` → canonical จริงบน container
  - lifecycle: `zaapi_kb_gen.py build --mongo-uri <validated> --db-name "$DB"` → `publish` → `rollback` → publish ซ้ำ → CAS conflict จริง (สอง writers — scripts ขนาน, `--db-name` เดียวกัน)
  - assertions: real `DuplicateKeyError` ใน bootstrap race; `matched_count` จริง; `bson` 16MiB gate (revision ใหญ่จำลอง); readback round-trip; collection/index สร้างจริง; **writers ทั้งสองแตะ DB เดียวกัน** (assert client db name)
  - cleanup proof (scoped เท่านั้น): `docker rm -f zaapi-p4-test` + `docker ps -a --filter name=zaapi-p4` → empty + `docker volume ls --filter name=zaapi-p4` → empty (`--tmpfs` ทำให้ไม่มี anonymous volume ให้ filter มองไม่เห็น — container ชื่อเดียวคือ proof; **ห้ามตัดสินจาก `docker volume ls` ทั้งเครื่อง**)
- **Minimal GREEN:** matrix ผ่านทุก row บน real Mongo + barrier proof ว่า ambient/shared path ไม่ถูกแตะ + scoped cleanup 0 resources ใน scope
- **Regression tests:** offline suite ทั้งหมด (T12 command)
- **Verification command:** evidence = container/network/volume names + matrix results + cleanup proof → `docs/test/results/phase4a_mongo_fidelity.md`
- **Mongo/provider/network:** **disposable mongo:7 container เท่านั้น** — ห้าม shared/production เด็ดขาด; ไม่มี provider
- **Stop conditions:** Docker daemon ไม่มี → หยุดรอผู้ใช้; container ชี้ non-disposable target (uri ไม่ใช่ localhost/disposable) → abort ทันที; fidelity mismatch กับ fake-behavior contract → หยุดรายงาน (แยก fix task)
- **Expected mechanism delta:** +0 (gate วัดของจริง)
- **Commit boundary:** ไม่มี production/test commit — evidence `docs/test/results/` gitignored; verdict ลง waythrough log ตาม 8H
- **Acceptance:** `PHASE_4A_DISPOSABLE_MONGO_FIDELITY_PASSED` (บันทึกใน waythrough log — ไม่มี code commit)
- **Depends on:** T12 (offline suite ผ่านก่อน), Docker daemon (user action)

## Task 13B — Packaging verification (production Python 3.11)

- **Objective:** พิสูจน์ `requirements.txt` (รวม ST pin จาก T4) install + import ได้ภายใต้ production Python 3.11 (Dockerfile `FROM python:3.11-slim`) — `.venv` ของ dev เป็น 3.14 จึงยังไม่พิสูจน์ packaging contract
- **Entry gate:** Docker daemon up (window เดียวกับ T13) — **แต่ Docker approval ≠ network approval: package fetch ต้องลอง local-only ก่อนเสมอ**
- **Files to read:** `docker/Dockerfile.chatbot` (base image + install steps), `requirements.txt` (pin จริงหลัง T4), spec §20
- **Files expected to modify:** evidence `docs/test/results/phase4_packaging.md` (gitignored)
- **Owner:** packaging gate (ไม่ใช่ production owner)
- **RED test:** รัน check — pin install ไม่ได้บน 3.11 หรือ `sentence_transformers.__version__ != <pin>` หรือ module ใหม่ import ไม่ได้ → fail
- **Minimal GREEN (ลำดับล็อก — local-only ก่อนเสมอ; `--no-index` มองไม่เห็น pip HTTP cache จึงต้องใช้ wheelhouse จริง):**
  ```bash
  # step 0 — image gate (local-only): docker image inspect python:3.11-slim
  #   → ไม่มี image = STOP ขอ pull approval แยก → docker pull หลังอนุมัติเท่านั้น
  # step 1 — เลือกเส้นทางเดียว (ห้ามสร้าง cache system/script ใหม่):
  #   (a) มี wheelhouse จริง (host dir ที่มี .whl ครบ requirements):
  docker run --rm --network none \
    -v "$PWD:/repo" -v "<wheelhouse>:/wheelhouse" -w /repo \
    python:3.11-slim sh -c \
    "pip install --no-index --find-links=/wheelhouse -r requirements.txt && \
     python -c 'import sentence_transformers as st; assert st.__version__==\"<pin>\"' && \
     python -c 'import sys; sys.path.insert(0,\"chatbot\"); import shopeechat.kb_zaapi_generation, shopeechat.kb_zaapi_retrieval'"
  #   (b) ไม่มี wheelhouse → STOP ขอ explicit network approval แยกทันที
  #       หลังอนุมัติ — online command แยกชัดเจน (ไม่มี wheelhouse mount, ไม่มี --find-links):
  docker run --rm \
    -v "$PWD:/repo" -w /repo \
    python:3.11-slim sh -c \
    "pip install -r requirements.txt && \
     python -c 'import sentence_transformers as st; assert st.__version__==\"<pin>\"' && \
     python -c 'import sys; sys.path.insert(0,\"chatbot\"); import shopeechat.kb_zaapi_generation, shopeechat.kb_zaapi_retrieval'"
  ```
  - container ephemeral — ไม่ push image, ไม่ build production image ใน gate นี้
- **Regression tests:** ไม่มี production change
- **Verification command:** คำสั่ง docker run ด้านบน + evidence file (บันทึก path ที่ใช้ — wheelhouse หรือ approval-network + ผล image-inspect)
- **Mongo/provider/network:** step 0/1a = **none** (`--network none`, image inspect local); pull/install online = หลัง separate approval เท่านั้น — ไม่ใช่ provider call
- **Stop condition:** image/wheels ไม่มี + ไม่ได้ approval → **หยุดรอผู้ใช้ ห้าม pull หรือรัน online เงียบ ๆ**; pin install ไม่ได้บน 3.11 → หยุดรายงาน (ห้าม silent downgrade/เปลี่ยน pin เอง)
- **Expected mechanism delta:** +0 (verification เท่านั้น)
- **Commit boundary:** ไม่มี — evidence เท่านั้น
- **Depends on:** T4 (pin ล็อกแล้ว), T13 (Docker window)

## Task 14 — Gate 4B: raw/source census

- **Objective:** census จาก raw sources — provider-free, read-only + report
- **Entry gate:** 4A หรือ `docs/zaapi/kb-export/` snapshot ที่มีอยู่
- **Files to read:** `docs/zaapi/kb-export/knowledge-sources.json`, `docs/zaapi/script/import_zaapi_kb.py` (row semantics), spec §15 4B
- **Files expected to modify:** census script `docs/test/tools/phase4b_census.py` (**committed** — deterministic census tool ตาม repo convention `docs/test/` มี test scripts tracked อยู่แล้ว; reproducible evidence tooling); evidence `docs/test/results/phase4b_census.md` (gitignored)
- **Owner:** analysis tooling (ไม่ใช่ production owner — ไม่นับ mechanism)
- **RED test:** รัน census script บน raw input จริง → ถ้าตัวเลขหลัก (sources/raw rows/deliveries) คำนวณไม่ออกหรือขัด `validate_raw_row` contract → fail
- **Minimal GREEN:** สคริปต์นับ (offline — ไม่มี provider): sources, raw rows, distinct `content_fingerprint`, deliveries (`accounts` expansion), account scope distribution (ผ่าน `canonical_delivery_scope` — owner เดียว, ห้าม inline), malformed/empty/conflict distribution → report ตัวเลขจริง (เทียบ prior: 118 sources / 8,600 rows / 112,974 deliveries ถ้าตรง)
- **Regression tests:** ไม่มี production change — ไม่ต้องรัน suite (census read-only)
- **Verification command:** census script run + report file
- **Mongo/provider/network:** disposable Mongo read (ถ้าผ่าน 4A) หรือ file-only — ไม่มี provider
- **Stop condition:** ตัวเลขขัด schema contract (raw rows invalid ทำ import ไม่ได้) → หยุดรายงาน
- **Expected mechanism delta:** +0 (tool เป็น analysis script — deterministic counting เท่านั้น)
- **Commit boundary:** `docs/test/tools/phase4b_census.py` — commit เดียว (tool เท่านั้น; report gitignored)
- **Acceptance:** `PHASE_4B_RAW_CENSUS_COMPLETE`
- **Depends on:** T13 (หรือ file-only path)

## Task 15 — Gate 4C: canonical corpus (provider-budget GATED)

- **Objective:** canonical extraction/corpus จริงบน disposable — per-unique-row, checkpoint/resume, invalid/conflicted/unresolved ไม่เข้า active
- **Entry gate (ล็อกสองชั้น — manual stop, ไม่ใช่ code/flag/state file):** (1) **explicit provider-budget approval จากผู้ใช้ใน session** — enforcement คือ operator ไม่ execute คำสั่ง extraction จนกว่าได้รับอนุมัติ; ไม่มี approval mechanism ในโค้ด (flags ห้ามอยู่แล้ว และไม่มี "dry-run gate" ให้ implement — approval เป็น human decision ไม่ใช่สิ่งที่ test ได้); (2) model identity resolved (`MODEL_REVISION`+ST version จริงจาก T4 — รายงานค่าจริงใน evidence)
- **Files to read:** spec §15 4C; `import_zaapi_kb.py:513–548` (CLI + `--canonicalize --resume`), checkpoint contract `:191–194,273–299`
- **Files expected to modify:** checkpoint files (gitignored) + disposable collections `zaapi_kb_raw_sources`/`zaapi_kb_records`/`active:manifest`; evidence `docs/test/results/phase4c_corpus.md`
- **Owner:** importer machinery เดิม (`import_zaapi_kb.py`) — ไม่มี owner ใหม่
- **RED test:** ไม่มี automated RED สำหรับ approval (human gate — ห้ามสร้าง RED ปลอม); contract ที่พิสูจน์คือ **provider ติดต่อได้ทางเดียว = `extractor` callable ที่ operator ส่งเข้า `import_source` หลัง approval** — importer functions ไม่สร้าง provider client จาก ambient env (ตรวจด้วย code read + socket tripwire ใน T12 suite)
- **Minimal GREEN (container lifecycle ล็อก — T13 ลบ `zaapi-p4-test` ไปแล้ว ต้องเปิดก้อนใหม่ที่นี่):** หลัง approval → (1) image gate `docker image inspect mongo:7` local-only (ไม่มี → STOP ขอ pull approval แยก) → (2) spin `docker run -d --name zaapi-p4-corpus --label zaapi_phase4=1 --tmpfs /data/db -p 127.0.0.1:<random>:27017 mongo:7` → (3) สุ่ม port + `db_name` **ครั้งเดียว** → `safe_uri, safe_db = require_disposable_target(uri, db_name)` → เรียก `import_source(item, files_dir, raw_coll, records_coll, extractor=<real Gemini extractor>, resume_from=ckpt)` ด้วย injected colls จาก `MongoClient(safe_uri)[safe_db]` (ห้าม ambient `--apply`/`--canonicalize` CLI path เช่นเดียวกับ T13) → corpus counts, distinct `semantic_digest` count (จาก `semantic_text` serialization จริง ไม่ใช่ raw-row proxy), deliveries, token distribution (จาก `model_identity` tokenizer หรือ estimate contract — รายงานค่าจริง), checkpoint kill/resume proof (จงใจ kill ระหว่างทาง → resume ต่อได้ → ผลเท่ากัน) — **target เดิมตลอด T15–T16; T15 ห้าม cleanup เมื่อผ่าน (T16 ต้องใช้ corpus/generation เดิม); T15 fail/หยุดก่อน T16 → failure cleanup `docker rm -f zaapi-p4-corpus` + `ps/volume --filter name=zaapi-p4` → 0 ทันที**
- **Regression tests:** offline suite (T12 command) — importer behavior ต้องไม่แตก
- **Verification command:** evidence file + checkpoint resume proof log
- **Mongo/provider/network:** **provider calls = Gemini extraction เท่านั้น หลัง approval**; disposable Mongo writes; checkpoint files local
- **Stop conditions:** quota/budget gate ไม่ผ่าน → หยุดก่อนเรียก; checkpoint/resume ไม่ converge → หยุดรายงาน
- **Expected mechanism delta:** +0 (ใช้ machinery เดิม)
- **Commit boundary:** ไม่มี — evidence + checkpoint เท่านั้น (gitignored)
- **Acceptance:** `PHASE_4C_CANONICAL_CORPUS_COMPLETE`
- **Depends on:** T4 (identity), T13 (disposable contract — container ใหม่ `zaapi-p4-corpus` spin ใน task นี้), approval (user action)

## Task 16 — Gate 4D: artifact/retrieval benchmark

- **Objective:** ตัดสิน artifact format จาก measurement + acceptance matrix — ห้ามเดา (spec §10 alternatives + §20 unresolved measurements)
- **Entry gate:** 4C corpus + ≥1 validated generation บน disposable
- **Files to read:** spec §10 (format alternatives), §15 4D, §20 measurement table; T10 publish flow (canary seam)
- **Files expected to modify:** benchmark/canary code ใต้ `docs/test/` (gitignored outputs); format encoding **เปลี่ยนได้เฉพาะใน owner เดิม** (manifest schema คงเดิม)
- **Owner:** `kb_zaapi_generation.py`/`kb_zaapi_retrieval.py` (encoding change ถ้าข้อมูลสนับสนุน — owner เดิมเท่านั้น ห้ามตัวที่สาม)
- **RED test:** benchmark matrix script รันบน validated generation → ต้องคำนวณทุก metric row ได้; format candidate ใด load ไม่ได้ = candidate นั้นตก (ไม่ใช่ test fail)
- **Minimal GREEN (measurement matrix):** `.npz` compressed vs `.npy`+memmap vs float16 — build/load/query latency, peak RSS (`tracemalloc`/`resource`), file sizes, float32-vs-float16 recall บน corpus; structured index build+lookup cost; deterministic exact cases, semantic cases, scope isolation, failure matrix (§14), evidence budget usage (p95 record bytes vs 1500B cap); canary cases gitignored ส่งเป็น arg — **top-k เท่านั้น ห้าม uncalibrated threshold**; **cleanup (บังคับ — `finally` ทั้ง success/failure): `docker rm -f zaapi-p4-corpus` + `docker ps -a --filter name=zaapi-p4` + `docker volume ls --filter name=zaapi-p4` → 0 (container จาก T15 ถูกลบที่นี่เท่านั้น — ห้าม cleanup ก่อน/หลังจุดอื่น)**
- **Regression tests:** offline suite (T12 command) หลัง format decision ใด ๆ — retrieval/generation contract ต้องเหมือนเดิม
- **Verification command:** `docs/test/results/phase4d_benchmark.md` + acceptance matrix
- **Mongo/provider/network:** disposable only — ไม่มี provider (embedding ผ่าน pinned model local)
- **Stop condition:** recall/perf ไม่เคียงข้อเสนอใด ๆ → เลือก safe default `.npz` float32 (spec §20) + บันทึกเหตุผล
- **Expected mechanism delta:** +0 (decision จาก measurement; เปลี่ยนเฉพาะ encoding ถ้าข้อมูลสนับสนุน)
- **Commit boundary:** format encoding change (ถ้ามี) — commit เดียวพร้อม regression proof; benchmark outputs gitignored
- **Acceptance:** `PHASE_4D_RETRIEVAL_BENCHMARK_COMPLETE`
- **Depends on:** T15

## Task 17 — shared-vector compatibility gate report (Task 5 input)

- **Objective:** gate analysis ตาม spec §13 — **report เท่านั้น ห้าม activate** (production activation = Task 5)
- **Files to read:** census rows embedding consumers; `units.py:66–85`, `product_store.py:55–158,279–338`, `knowledge_base.py:936–985` (QA lazy mtime cache + `_qa_embed_missing`), `build_embeddings.py`, `refresh_data.sh`
- **Files expected to modify:** report `docs/test/results/phase4_shared_vector_gate.md` (gitignored) — ไม่มี production change
- **RED test/GREEN (report rows บังคับ):**
  | consumer | artifact | identity proof? | action |
  |---|---|---|---|
  | product_store `vector_search`/`fetch_description_evidence` | `product_embeddings.npz`,`description_embeddings.npz` (gen-paired) | npz เก็บ `generation_id` ไม่เก็บ model revision → **prove-or-rebuild** | rebuild ด้วย pinned model + byte-compare same-runtime หรือ rebuild ใหม่ |
  | units `_vector_search` | `unit_embeddings.npz` | เดียวกัน | เดียวกัน |
  | knowledge_base QA | `qa_embeddings.npz` + lazy mtime cache | ไม่มี `generation_id` เลย → unknown | rebuild + mtime reload (mechanism เดิม kb.py:945–956 จัดการเอง) |
  | build_embeddings builder | (writer) | pinned model → artifacts ใหม่มี identity | ใส่ `model_identity` ลง npz ใหม่ (Task 5) |
  | app warmup `_get_model` | — | loader เดียว pin เดียว | ไม่มี artifact |
- **Owner:** analysis report (ไม่ใช่ production owner — ไม่นับ mechanism; consumer files อ่านเท่านั้น)
- **Minimal GREEN:** report ครบทุก row + verdict — หาก byte-compare ต้องรัน model จริง local (cache มีแล้ว; ห้าม download ใหม่ถ้าไม่จำเป็น)
- **Regression tests:** ไม่มี production change — ไม่ต้องรัน suite
- **Verification command:** report file ครบทุก row + gate verdict (`shared-pin-safe`/`needs-rebuild:<list>`)
- **Mongo/provider/network:** ไม่มี (อาจรัน model load จริง local เพื่อ byte-compare vectors — local, ไม่ใช่ provider)
- **Stop condition:** artifact ใดพิสูจน์ identity ไม่ได้และ rebuild เสี่ยง → flag ใน report — **ห้าม serve vector channel แบบ silent mismatch**
- **Expected mechanism delta:** +0 (analysis)
- **Commit boundary:** ไม่มี — report gitignored
- **Acceptance:** gate report พร้อมส่ง Task 5 (`PHASE_4_SHARED_VECTOR_GATE_ASSESSED`)
- **Depends on:** T4 (pin), T16 (benchmark evidence ประกอบ)

## Task 18 — closeout: budget delta + acceptance + verdict

- **Objective:** reconcile mechanism delta จริงเทียบ budget §17 + acceptance matrix รวม + รายงาน verdict
- **Files to read:** ทุก diff ในงาน; spec §17; `docs/waythrough-ledger.md` §8
- **Files expected to modify:** `docs/test/results/phase4_acceptance.md`; waythrough log (closeout append — per 8H); ledger entry + prefix/hash update (commit เดียวกับ docs ถ้า commit ได้รับอนุมัติ)
- **Owner:** closeout bookkeeping (ไม่ใช่ production owner)
- **RED test:** budget reconciliation — ถ้า actual delta แถวใดเกิน budget → fail
- **Minimal GREEN:** budget table actual-vs-budget ทุกแถว +0/over → รายงาน; SRS completeness re-check; regression matrix รอบสุดท้ายผ่าน
- **Regression tests:** regression matrix เต็ม (T12 command) — รอบสุดท้ายก่อนปิดงาน
- **Verification command:** regression matrix (T12 command) + `git diff --check` + `git status` staging ว่าง
- **Mongo/provider/network:** ไม่มี
- **Stop condition:** mechanism delta เกิน budget โดยไม่ได้อนุมัติ → rollback task นั้นก่อนปิด (ห้ามบังคับ merge)
- **Commit boundary:** ledger/log bookkeeping เท่านั้น (ตาม 8H — ห้ามเขียน active เพิ่มหลัง baseline วัดแล้ว)
- **Expected mechanism delta (รวมทั้งงาน — itemized ตาม budget table ด้านบน ห้ามรวม category):** owners +2 · normalization fn +1 (`canonical_delivery_scope`, callsites −2) · closed-schema validators +3 · trust-boundary query validation +1 group · URI safety validator +1 (`require_disposable_target` uri+db_name pair) · retrieval entrypoint +1 (`retrieve_active`) · CAS +1 · model-identity accessor +1 · constant +1 (`MODEL_REVISION`) · `load_active_state` = move net +0 · public result type +0 · truncation/marker/fact-priority +0 · pointer cache/TTL +0 · duplicate validation +0 · keyword/regex/heuristic/flags/deps/loaders/fallback +0 · fake Mongo +0 · test-infra owner +1 (`mongo_doubles.py` — test code); ทุก declared addition ต้อง map กลับ spec section ที่ mandate (§10–12/§13/§14) หรือ review mandate — เกินแถวใด = stop
- **Verdict target:** `PHASE_4_IMPLEMENTATION_COMPLETE_READY_FOR_REVIEW` (หลัง independent review แยกต่างหาก)
- **Depends on:** T12–T17

---

## Coverage map — spec §16 test items → tasks

| spec §16 | task | spec §16 | task |
|---|---|---|---|
| 1,2 semantic_text/digest | T6 | 21 self-containment | T7 |
| 3,4 exact norm/scope isolation | T8 | 22,23 materialization | T8 |
| 5 merge/dedupe | T8 | 24 shared digest | T6 (build) + T8 (retrieve) |
| 6,7 semantic failure | T8 | 25,31 scope truth/parity | T2 (+ T8 retrieve) |
| 8 corruption fail-closed | T7 (+T9 pinned drift) | 26 reproducibility | T6+T9 |
| 9 path traversal | T7 | 27,36 manifest | T5+T6 |
| 10 canonical pin | T9 | 28–30 query validation | T8 |
| 11–14 CAS/ABA/bootstrap/rollback | T10 | 32,33 namespace | T6+T7+T8 |
| 15,16 drift/readback | T10 | 34,37 model compat/loader pin | T4+T7+T9 |
| 17,18 producer/attribution | T8+T11 | 35 bootstrap 7-case | T10 |
| 19,20 offline/isolation | T12 | 38 scoped ranking | T8 |
| — | — | 39 pointer schema | T5+T10 |
| — | — | 40 shared-vector gate | T17 |

## Commit order (16 boundaries — sequential, revertable)

1. T1 doubles extraction+helpers → 2. T2 scope owner → 3. T3 `load_active_state` move → 4. T4 model pin+deps → 5. T5 validators → 6. T6 generation builders → 7. T7 retrieval loaders → 8. T8 retrieve+`retrieve_active` → 9. T9 build/validate → 10. T10 publish/rollback/CLI+URI gate → 11. T11 attribution test → 12. T12 isolation+matrix+SRS → 13. T13 4A (evidence, ไม่มี code commit) → 13B. T13B packaging py3.11 (evidence) → 14. T14 4B (census tool commit) → 15. T15 4C → 16. T16 4D → T17 gate report → T18 closeout

กฎท้าย: ทุก task ต้อง `git status` staging ว่างก่อนเริ่ม task ถัดไป; gate tasks (T13–T17) ไม่มี production commit — evidence gitignored + verdict ลง waythrough log ตาม 8H
