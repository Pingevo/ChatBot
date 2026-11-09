# Task 6A — Canonical Import → v2 Generation → Publish Plan

**Goal:** Run the existing Zaapi KB canonical pipeline end-to-end on the shared
admin DB: raw snapshot import → Gemini canonicalize → v2 embedding generation
build → CAS publish → selector flip — so `kb_source="zaapi"` serves real typed
evidence instead of `zaapi_no_active`.

**Audit basis (verified 2026-11-05, read-only census of shared admin DB
`chatbot`):**

| fact | evidence |
|---|---|
| `zaapi_kb` | 8,600 docs, all `active`, kinds `xlsx_row` 8,595 / `text` 5, zero typed fields (`record_id`/`record_type`/`facts` = 0) — legacy corpus, never canonical |
| `zaapi_kb_raw_sources` | **8,600 docs (118 src, `active:false`)** — Stage 1 executed 2026-11-05 (A-074); v2 `raw_row_id` ≡ v1 (verified on DB) → re-apply idempotent |
| `zaapi_kb_records` | collection exists, **0 docs** — no records/revisions/`active:manifest` |
| `zaapi_kb_source_registry` | **absent** — no key-mode declarations; every source defaults to `assigned` at first `--apply` |
| `zaapi_kb_import_log` | **absent** — created on first `--apply` |
| `zaapi_kb_embedding_generations` | **collection absent** — no pointer, no gen docs |
| `exports/zaapi_kb_gen/` | 6 dirs, all `manifest.schema_version=1` → ineligible (`kb_zaapi.py:76` v1 decline); disposable leftovers, no matching gen docs |
| source inputs | `docs/zaapi/kb-export/knowledge-sources.json` = 118 items; all files present; **118/118 sha256 match**; `_manifest.json` unreferenced (benign); `raw/zaapi-knowledge-sources-all.json` = 134 items (superset, unused) |
| corpus estimate | 8,600 importer-parsed rows (dry-run verified, exact A-012 match) → **112,974** canonical records (Σ rows×accounts, exact) |
| key modes (v2) | registry absent → all `assigned`; keyledger (`/tmp/keyledger.json`): 66 column candidates / 52 assigned — **none declared**; declaration = `declare_source` (function, no CLI flag) and must precede first `--apply` of that source |
| exclusion semantics | raw dump 134 items → manifest 118 (15 disabled + 1 `ZAAPI_SYSTEM` quick-reply) — corpus = all enabled non-system sources |
| `main_config` | `kb_source=legacy` (rollback persisted), `pool_sources` all true, `grouped_retrieval_selection_enabled=true`, `bot_worker_enabled=false`, `mock_mode=true` |
| provider | `GEMINI_API_KEY` set (+ `_1.._9`), `google-genai==1.75.0`, importer model `gemini-3.5-flash-lite` |
| readiness gate | `zaapiKbReady()` counts **legacy `zaapi_kb`** (`active:{$ne:false}` ≥1 → always ready) — stale: never checks `zaapi_kb_embedding_generations` |

## Non-goals

- No new helpers/guards/regex/owners — mechanism delta = 0.
- No code changes, no Docker/image deploy, no force-push — those need separate approval.
- `zaapiKbReady` gate fix (re-point to `zaapi_kb_embedding_generations`) is
  optional hardening, **not** required by this plan (listed as decision D4).
- Deleting/migrating legacy `zaapi_kb` — stays as rollback dataset.

## Must-not-touch (hard boundaries)

- `zaapi_kb` (legacy corpus — runtime reads none, admin panel reads it)
- `system_configs` (except Stage 5 selector flip through `setKbSource` CAS only)
- `knowledge_base`, `kb_products`, `kb_qa`, `sellable_units*`, `image_texts*`
- `docs/test/`, `docs/SRS_SSD.md`, all production source files
- `exports/gen/`, `exports/product_embeddings.npz`, existing `exports/zaapi_kb_gen/*` dirs (new gid dir only)

## Exact owners

| stage | owner function | file | writes |
|---|---|---|---|
| raw+canonical import | `import_source` / `_persist_immutable` / `import_snapshot` | `docs/zaapi/script/import_zaapi_kb.py` | `zaapi_kb_raw_sources`, `zaapi_kb_records` (records + `revision:*` + `active:manifest`), `zaapi_kb_source_registry`, `zaapi_kb_import_log` |
| key declaration | `declare_source` (no CLI — function call) | same file | `zaapi_kb_source_registry` `reg:<sid>` insert-once |
| canonical read | `load_active_state` / `validate_manifest_records` | `chatbot/shopeechat/kb_zaapi_schema.py:527` | none |
| gen build | `build_generation` | `chatbot/shopeechat/kb_zaapi_generation.py:196` | `exports/zaapi_kb_gen/<gid>/` + insert `gen:<gid>` doc |
| gen validate | `validate_generation` | `kb_zaapi_generation.py:285` | none |
| publish CAS | `publish` → `_resolve_and_cas` → `_cas_swap` | `kb_zaapi_generation.py:405,343,322` | `zaapi_kb_embedding_generations {_id:"active"}` |
| rollback CAS | `rollback` | `kb_zaapi_generation.py:445` | same pointer |
| selector CAS | `setKbSource` | `ChatAdminWeb/src/backend/service/systemConfigService.ts:479` | `system_configs.main_config` |
| runtime load | `load_active_generation` / `retrieve` | `chatbot/shopeechat/kb_zaapi_retrieval.py:210,280` | none |
| adapter gate | `zaapi_kb_evidence` | `chatbot/shopeechat/kb_zaapi.py:36` | none |

DB namespace: shared admin DB via `ADMIN_MONGO_URI` + `ADMIN_MONGO_DB=chatbot`.
Artifact path: `<repo>/exports/zaapi_kb_gen/<gid>/`; in Docker, `/app/exports`
is named volume `exports_data` (docker-compose.yml:48).

## Preconditions

1. `ADMIN_MONGO_*` + `GEMINI_API_KEY` in process env (importer does **not**
   load dotenv — operator loads env per runbook; never print values).
2. Source manifest + files unchanged since audit: re-verify before Stage 1 —
   `knowledge-sources.json` 118 items, all `downloaded_file.sha256` match.
3. Gemini quota for ~8.6K requests on `gemini-3.5-flash-lite` approved
   (approval gate A2). Free-tier (~20 req/day) is infeasible.
4. Stage 3 runs where the serving runtime reads `exports/`: prod
   `chatbot-shopee` container (`exports_data` volume) **or** local build +
   artifact copy into that volume. Precondition: verify the running image
   contains Phase-4 code — `docker compose exec chatbot-shopee python -c
   "import shopeechat.kb_zaapi_generation"` — if ImportError → STOP, image
   deploy needed first (separate approval).
5. Selector flip only after Stage 4 publish verified — the `zaapiKbReady`
   gate is stale and will not protect against a premature flip.

## Stage 0 — Rehearsal (no shared writes)

- [x] **S0.1 Dry-run raw parse — EXECUTED 2026-11-05** (read-only, 0 provider
  calls, `/tmp/task6a_dryrun.jsonl`): 118 results, exit 0, `raw_count` sum
  **8,600** (exact A-012 match), 0 zero-row sources, readiness `invalid`×118
  (expected — no `--canonicalize` → no records → not publishable), 0
  conflicts. Top row drivers: `6abf5e4c…` 1,907×18 accts, `6ab647cf…`
  819×68, `6a56130c…` 718, `6a56132f…` 621.

- [x] **S0.1b Model pin — VERIFIED offline**: `HF_HUB_OFFLINE=1` load →
  `model_identity()` = bge-m3 @ `5617a9f6…`, ST 5.7.0, dim 1024, fp32,
  normalize → `_model_pin()` will pass at Stage 3.

- Note: existing test fakes (`GenColl`/`GenDb`) lack `$setOnInsert` →
  `import_source` cannot run against them; disposable real-Mongo rehearsal
  needs Docker approval (A-045 precedent) or go straight to gated Stage 1.

- [x] **S0.2 Preview, full-ID source — EXECUTED 2026-11-06** (read-only,
  0 provider, 0 writes): `--source` requires the **exact full id**
  (`it["id"] == args.source`; prefix → `error: source not found`, exit 2):

```bash
.venv/bin/python docs/zaapi/script/import_zaapi_kb.py \
  --dry-run --source 6acf5df0ff3520d5c8bb7cbb    # exit 0, status=preview, raw_count=2
```

- **v2 contract correction**: under the committed importer (F7 fix),
  `--dry-run` returns at the preview gate **before extraction** — 0
  provider calls, 0 checkpoint writes, regardless of `--canonicalize`/
  `--resume`. A "canonicalize dry-run" that measures extraction **does
  not exist**; the only extraction probe is a real `--apply` canary
  (shared write + provider calls — separate approval).

## Stage 1 — Raw snapshot import — **EXECUTED 2026-11-05 (A-074)**

Writes `zaapi_kb_raw_sources` only (insert-once + readback, `active:false`
immutable snapshots). No provider calls. ~8.6K docs — verified present.
Re-run under v2 is a no-op (same `raw_row_id`) plus an import-log event.

```bash
.venv/bin/python docs/zaapi/script/import_zaapi_kb.py --apply | tee /tmp/task6a_stage1.jsonl
```

Acceptance (read-only verify):

```python
# .venv/bin/python - <<'EOF'  (env loaded like /tmp/task6a_census.py)
raw = db["zaapi_kb_raw_sources"]
assert raw.count_documents({}) >= 8600
assert len(raw.distinct("source_id")) == 118
assert db["zaapi_kb"].count_documents({}) == 8600   # legacy untouched
# spot: index_raw_rows(raw.find()) validates every row without error
EOF
```

Idempotent: re-run = insert-once skip + readback mismatch → hard fail (no
silent divergence). `import_batch="canonical-v1"`.

## Stage 2 — Canonicalize + manifest publish (approval gate A2: Gemini quota + shared write + key-mode decisions)

Expected ≈8.6K **extractor invocations** (1 per row needing extraction per
run; unchanged rows reuse prior records). **Provider-call honesty:**
`_gemini_extract` builds a fresh `genai.Client()` per invocation and the
importer loop has no retry — but what the SDK does inside each request
(transport retries, connection reuse) is **unverified**, so extractor
invocations are *not* a guaranteed HTTP-request count. Checkpoint caches
resolved outputs only — it is a resume cache, **not a call counter**;
failed rows are re-invoked on reruns, so cumulative invocations across
runs can exceed row count. **No hard call cap exists** — budget is
enforced only by `--source` scoping and checkpoint resume.
**v2 contract corrections vs this doc's original text:**

- Publish is **not** gated on "all records resolved": a failed *new* row
  is written to `revision.quarantined[]` and the rest of the source
  publishes; a failed *previously-resolved* row triggers `hold_publish`
  (the entire source's prior revision stays active). First import ⇒ all
  rows new ⇒ failures land in quarantine, source still publishes.
- Identity is durable `row_uid` (`{source_id}:r{n}`), matched by declared
  key (column mode) or content fingerprint (assigned). Destructive deltas
  (row removal, key rename, reposition) become `proposals` that require a
  `--confirm <needs_confirm-token>` bound to base revision + file fp.
- Per-source `zaapi_kb_source_registry` doc holds `key_mode/key_columns/
  uid_next/staged/lease`. First `--apply` auto-creates it with
  `key_mode:"assigned"` — **declare column mode before first apply** or the
  source locks to assigned (later switch = all rows re-mint uids, since
  column mode matches `prior_key_map`, not `prior_row_map`). There is **no
  CLI flag** for declarations — `declare_source(...)` is a function call.
- Every apply attempt (noop/held/stopped/conflict/published) writes a
  distinct `zaapi_kb_import_log` event.
- **Key-mode decision required per source before bulk apply** — see
  "Key-mode decisions" below.

**Two execution modes — pick one:**

### 2a. Sequential (baseline)

```bash
.venv/bin/python docs/zaapi/script/import_zaapi_kb.py \
  --canonicalize --apply --resume /tmp/task6a_import_ckpt.json \
  | tee /tmp/task6a_stage2.jsonl
```

### 2b. Parallel workers — key rotation, zero code change

10 importer processes, **disjoint source sets** (balanced partition verified
against dry-run — `/tmp/task6a_workers.json`), one `GEMINI_API_KEY` variant
per worker, one checkpoint file per worker:

| worker | env key | sources | rows |
|---|---|---|---|
| 0 | `GEMINI_API_KEY` | 1 (`6abf5e4c…` ยักษ์เดียว) | 1,907 |
| 1 | `GEMINI_API_KEY_1` | 1 (`6ab647cf…`) | 819 |
| 2–9 | `GEMINI_API_KEY_2..9` | 7–18 sources each | ~734 each |

**Quota claim (user-provided, unverified: 20 keys × 500 RPD = 10,000/day)**:

- ~8,600 expected invocations < 10,000/day → **จบในวันเดียว** *if the quota
  figure is true*; แต่ละ key ต้องไม่เกิน 500 — ยืนยันจริงด้วย canary (G1)
- Repartition เป็น 20 workers: **W0 = source ยักษ์ (1,907 rows) — เกิน
  500/key** → ใช้ key-chaining: รัน W0 ด้วย key A; เมื่อ key หมด RPD
  (rows ล้ม → `unresolved`, checkpoint ไม่ cache) → rerun คำสั่งเดิมด้วย
  key ถัดไป — checkpoint ข้าม row ที่ resolved แล้ว ไม่เรียกซ้ำ →
  chain ~4 keys จนครบ 1,907
- W1–W19 = 117 sources ที่เหลือ ~350 rows/worker (~12–15 min) → เสร็จก่อน
  → key ที่ว่าง (ใช้ไป ~350/500, เหลือ ~150) เอามา chain ให้ W0 ได้ —
  เพียงพอ (เหลือรวม ~2,850)
- ห้าม print key จริงลง log/checkpoint/command — อ้างอิงผ่าน env var เท่านั้น
- วิธี partition ภายใน source เดียวไม่มี (ไม่มี row-range flag) —
  serial+chain เท่านั้นสำหรับ source ยักษ์

```bash
# per worker i (env สมบูรณ์ + key variant เฉพาะ):
for sid in <worker-source-ids>; do
  GEMINI_API_KEY=$GEMINI_API_KEY_i \
  .venv/bin/python docs/zaapi/script/import_zaapi_kb.py \
    --canonicalize --apply --source "$sid" \
    --resume /tmp/task6a_ckpt_w$i.json >> /tmp/task6a_stage2_w$i.jsonl
done
```

Safety (verified against importer design):

- Disjoint source sets = no two workers touch the same source (raw rows +
  records are insert-once keyed by content fingerprint → cross-worker dup
  impossible by construction).
- `active:manifest` CAS is fenced by `expected_generation` — concurrent
  publish → loser gets `publication_conflict`, checkpoint keeps fence →
  **convergence pass** after all workers: rerun every source with
  `--apply` (checkpoint hits = 0 provider calls) → manifest converges.
- Per-worker `--resume` file — never share one checkpoint across workers.
- Throughput: ~1.5–2.5 s/row sequential per worker → W1–W19 ~12–15 min;
  W0 (1,907 rows serial + chain reruns) ≈ ~75–90 min = wall time
  **~1.5 h** total (vs 3–6 h sequential single-key).
- RPM ไม่ใช่ข้อจำกัด (~0.5 RPM effective/worker ≪ 15/key); RPD เท่านั้น
  ที่กัด และผ่านด้วย key-chaining ข้างบน — S0.2 probe ยังคุ้มอยู่
  (ยืนยันว่า 500/day นับต่อ key จริง ไม่ share project) แต่ไม่บล็อก.
- 429/failed rows → `unresolved`, never cached → rerun converges
  (single attempt per run — importer has no retry loop; per-run bound
  only, cumulative invocations across reruns can exceed row count, and
  SDK-internal request behavior is unverified).

- **Parallel divergence (declared)**: `_fact_conflicts` เปรียบ candidates กับ
  persisted snapshot ณ เวลาเริ่ม source → sources ที่ process พร้อมกัน
  cross-check กันเองไม่ได้ (sequential mode จับได้เสมอ) → contradiction
  facts ระหว่าง concurrent sources อาจ publish คู่กัน (content issue —
  mechanism ยัง fail-closed ปกติ) → **required post-step 2b.1**: read-only
  conflict audit ก่อนเข้า Stage 3 — group resolved records ด้วย
  `(shop, platform, identity{item_id|model_id|model_codes}, target_id,
  fact.key)` หา value ขัดกัน → รายงานให้ reviewer ตัดสิน; ไม่แก้ data
  เอง (repair = decision แยก)

Semantics to expect:

- Per-source: match rows→uids → diff → extraction **only for
  changed/new rows** → `ZaapiKnowledgeRecord.from_extraction` per account
  membership → `_fact_conflicts` → `build_revision` → `active:manifest`
  CAS (generation fence). Unchanged rows reuse prior member records —
  0 provider calls.
- `published:false` + `publication_conflict:true` = CAS lost → checkpoint
  holds fence; rerun converges (single bounded reread, no retry loop).
- Readiness outcomes: `resolved` publishes; `unresolved` (provider fail) /
  `invalid` (extraction malformed) → new rows `quarantined` (published in
  revision metadata, no records) or existing rows `hold_publish`;
  `conflicted` → excluded to quarantine. checkpoint caches **resolved**
  rows only → reruns retry only failures.
- Statuses surfaced per source: `published` / `noop` / `preview` /
  `needs_confirm` / `hold_publish` / `stopped` / `cas_conflict` /
  `unavailable` (active state unreadable — preview only, never faked as
  first import).
- Progress: `grep -c '"published":true' /tmp/task6a_stage2.jsonl` → target
  118; `grep publication_conflict` for CAS losses.

Acceptance:

```python
rec = db["zaapi_kb_records"]
m = rec.find_one({"_id": "active:manifest"})
assert m and m["generation"] == fingerprint(m["sources"])   # via schema owner
assert len(m["sources"]) == 118
docs = load_active_state(rec, db["zaapi_kb_raw_sources"], m)  # full owner validation
# report: len(docs), readiness histogram, invalid% — record in closeout
```

Stop conditions: any `ValueError` (checkpoint/fingerprint/schema mismatch);
invalid+unresolved share > 10% → stop and investigate extraction/model
before more spend; any write outside the four target collections
(`zaapi_kb_raw_sources`, `zaapi_kb_records`, `zaapi_kb_source_registry`,
`zaapi_kb_import_log`); any `hold_publish`/`needs_confirm`/`stopped`/
`cas_conflict` → halt that source and report.

## Key-mode decisions (required before bulk apply)

Basis: `/tmp/keyledger.json` (100%-complete + normalized-unique re-verified
per import). Modes and their edit semantics — **no mode is risk-free**:

| class | files | proposed mode | edit semantics |
|---|---|---|---|
| modelish (`รุ่น/SKU/รหัส/แบรนด์`) | 24 | **column** | non-key edit → `changed`, same uid, 0 proposals; key edit → `rename` proposal (human confirms, uid kept) |
| name-mutable (`ชื่อสินค้า/ชื่อ`) | 32 | **column** | same mechanics; name edits are the common case → rename proposals per edit batch (confirm burden accepted) |
| text-mutable (`คำถาม/ปัญหา/หัวข้อ`) | 7 | **column** | same; small files (1–49 rows) — low stakes either mode |
| link-volatile (`ลิงก์`) | 2 | **human decides** | `010` = 1,907 rows: volatile links → rename-proposal storms under column, positional-pairing risk under assigned — explicit call needed |
| other (`หมวดสินค้า`) | 1 | **column** | 10 rows |
| assigned (no viable key) | 52 | **assigned** (only option) | unchanged/moved row inherits uid via content-fp; single edit → `reposition` proposal (human verifies pairing — multi-edit pairs positionally); **edit+add same batch → `deactivate`+`add` = uid churn on edited rows**; ambiguous match → STOP |

Shared truths: multi-row delete/add batches degrade to deactivate+add
proposals in **both** modes (rename pairing requires exactly 1 missing ↔
1 new); column mode adds `dup/blank key → STOP` and header-change stops;
`declare_source` is `$setOnInsert` → only effective before a source's
first `--apply` created its registry doc (afterwards = manual registry
write + full uid re-mint on next import — churn, not silent). Undeclared
bulk apply = all 118 locked to assigned forever-or-churn.

## Stage 3 — v2 generation build (approval gate A3: shared write + artifact write)

Model pin: BGE-M3 `revision=5617a9f6…` immutable, ST 5.7.0, dim 1024,
float32 (all verified at runtime by `_model_pin`). Unique semantic digests
≈ ≤8.6K (scope excluded from `semantic_text` → account-expanded rows
dedupe); vectors ≈ 8.6K×1024×4 B ≈ 35 MB; record_map ≈ 113K projections.

Prod path (inside container — writes to `exports_data` volume + shared DB):

```bash
docker compose exec chatbot-shopee python - <<'EOF'
from shopeechat.kb_zaapi_generation import build_generation
from shopeechat.knowledge_base import _admin_db
print(build_generation(_admin_db()))
EOF
```

Local path (if container image lacks code — artifacts staged then copied):

```bash
.venv/bin/python - <<'EOF'
from dotenv import load_dotenv; load_dotenv(".env", override=False)
import os; from pymongo import MongoClient
from chatbot.shopeechat.kb_zaapi_generation import build_generation
db = MongoClient(os.environ["ADMIN_MONGO_URI"])[os.environ["ADMIN_MONGO_DB"]]
print(build_generation(db, exports_root="/tmp/task6a_exports"))
EOF
# then copy /tmp/task6a_exports/zaapi_kb_gen/<gid> into exports_data volume
```

Acceptance: `gen:<gid>` doc validates (`validate_gen_doc` inside build);
artifacts pass `_load_artifacts`; `canonical_generation ==
fingerprint(manifest.sources)`; `record_count` == `load_active_state` len.
STOP if `reject:*`/`conflict:*` or vector shape ≠ (n_digests,1024).

## Stage 4 — Publish (approval gate A4: shared pointer CAS)

Canary derived from real resolved data (construct at exec time — pick one
resolved record from `zaapi_kb_records`, assert `min_hits:1` via its
`subject_id`/`model_codes` + its account's `name`/`platform` as scope).
Concrete scope candidate verified in manifest: source
`6acf5df0ff3520d5c8bb7cbb` (single account) → `shop="Black Shark
Thailand"`, `platform="Shopee"` (scope normalizes platform to casefold —
`retrieve` handles both):

```python
# probe: rec.find_one({"readiness":"resolved","model_codes":{"$ne":[]}})
canary = [{"name": "resolved-record-hit",
           "query": {"shop": <acct_name>, "platform": <acct_platform>,
                     "model_codes": (<one model_code>,)},
           "assert": {"min_hits": 1}}]
```

```python
from shopeechat.kb_zaapi_generation import publish
status = publish(db, gid, canary_cases=canary, exports_root=<same-as-build>)
# expect "published" (or "published+newer_canonical_pending" only if a
# source re-import raced — then rebuild, do NOT republish stale gen)
```

CAS owner: `_resolve_and_cas` — bootstrap insert `{_id:"active",revision:1}`
here (no pointer exists) or fenced `update_one` on `{revision,generation_id}`.
`readback_invalid`/any `reject:*`/`conflict:*` → STOP, report string.

## Stage 5 — Selector flip (approval gate A5)

Owner: `setKbSource("zaapi", expected="legacy")` via ChatAdminWeb
`POST /api/config` `{kb_source:"zaapi", expected_kb_source:"legacy"}` —
or admin UI. Readiness gate passes trivially (stale — see D4).

Post-flip verification (≤5 s TTL):

- `main_config.kb_source == "zaapi"` persisted.
- Productish request → trace shows `zaapi_artifact=Nsup+Matt` —
  NOT `zaapi_no_active` / `zaapi_v1_ineligible` / `generation_unavailable`.
- `legacy_kb_reads_allowed() == False` (expected — zaapi is sole KB source).
- Spot-check typed evidence: spec/compat answers cite `kind:"kb_zaapi"`
  meta `record_id`.

## Rollback / recovery — from owners that exist (no invented cleanup)

| phase | lever | mechanism | limit |
|---|---|---|---|
| mid-import, before publish | stop + rerun | lease auto-released (`finally`); `staged.<tag>` + `--resume` checkpoint preserved → rerun converges; unreferenced `rec:*` docs are immutable orphans (invisible — no pointer) | staged reused only if same `file_fp` + `expected_rev`; else re-match |
| partial import (some sources published) | per-source | manifest `sources` map is per-source — failed/absent sources have no pointer; `cas_conflict` → rerun same source converges on current generation | cross-source state unaffected by design |
| after publish, bad source | forward-fix | correct file → re-import → new revision supersedes via CAS (normal path) | needs source-file fix |
| after publish, must unpublish | **manual DB op** | remove `sources.<sid>` pointer from `active:manifest` (`update_one` + `generation` recompute) — **no CLI/owner does this**; old `rev:*`/`rec:*` stay immutable | manual op must keep `generation == fingerprint(sources)` or `validate_manifest` fails |
| snapshot restore | `export_zaapi_kb.py --source` → `import_snapshot` | bootstrap/copy into empty-or-identical manifest state | **cannot** overwrite a diverged manifest (`existing active manifest conflict` raise) — not a rollback tool for changed pointers |
| selector | `setKbSource("legacy", expected="zaapi")` | instant, proven A-071 | — |
| gen pointer | `rollback(db, expected_gid)` | needs a previous gen; bootstrap `previous=None` → N/A for first publish (use selector) | — |
| canonical data | leave | immutable by design; harmless while selector=legacy or pointer absent | 0 |

Retracted guidance: **do not drop `zaapi_kb_records` or the registry** —
that was only safe while nothing was published; after any publish it
destroys unrelated sources' state. Per-source recovery = pointer removal
(manual) or forward re-import, above.

## Risks / notes

- **`zaapiKbReady` is stale** (counts legacy `zaapi_kb`): admin UI can flip
  to zaapi any time → blackhole between flip and Stage 4. Mitigate by
  sequence discipline; optional fix = repoint gate to
  `zaapi_kb_embedding_generations` `{_id:"active"}` + gen doc present
  (decision D4, needs code approval).
- **Partial canonical coverage**: sources that fail publish
  (`unresolved`/`invalid`/`conflicted` rows) are absent from manifest →
  those topics have no zaapi evidence; runtime fails closed to supporting
  evidence only (no wrong answers).
- **Artifact visibility**: pointer published before artifacts land in the
  serving container's `exports_data` → `load_active_generation` fails
  closed (`zaapi_no_active`) — ordering in Stage 3/4 prevents this.
- **Concurrent admins**: manifest CAS per source + pointer CAS handle
  races; single bounded reread, no retry loops.
- **`zaapi_kb` admin CRUD** (`/api/zaapi-kb` POST/PATCH/DELETE) writes the
  legacy collection only — no code path outside importer/generation owners
  writes `zaapi_kb_raw_sources`/`zaapi_kb_records`/
  `zaapi_kb_embedding_generations` (exclusive writers confirmed).
- **Checkpoint location** `/tmp/task6a_import_ckpt.json` — move to a
  durable path for multi-day runs (`/tmp` may clear on reboot).

## Estimated runtime / cost

| stage | time | cost |
|---|---|---|
| S0 | ~5 min | ≤1 source of Gemini calls |
| S1 | ~10–20 min | 0 |
| S2 | ~3–6 h sequential; **~1.5 h parallel×20** (if 10K/day quota holds ≥ ~8.6K expected invocations — one day enough; key-chaining for the 1.9K-row source); resumable | ~8.6K expected invocations ≈ 6 M tok in / 2.5 M tok out — est. ~$1–3 on flash-lite paid tier (verify pricing + true request count before A2) |
| S3 | ~10–40 min (encode ~8.6K texts + ~113K projections) | 0 (local model) |
| S4–S5 | ~5 min + QA | 0 |

## Approvals required (staged GO/NO-GO)

| gate | scope | status |
|---|---|---|
| G0 read-only preview | `--dry-run` all 118 | **DONE 2026-11-06** — 118/118 `preview`, added 8,600, proposals 0, 0 writes/provider |
| G1 canary | `--canonicalize --apply --source 6acf5df0ff3520d5c8bb7cbb` — shared Mongo write (rec 2 + rev 1 + reg 1 + log + manifest bootstrap) + **expected 2 extractor invocations** (2 rows; actual provider HTTP requests unverified — SDK-internal retry possible, **no hard cap**) | **pending approval** — key mode chosen: `assigned` (2-row promo file; zero extra declaration writes; uid churn irrelevant for canary) unless user prefers pre-declared `column(ชื่อสินค้า)` |
| G2 key declarations | per-source `declare_source` for chosen column-mode sources (24 modelish + up to 42 mutable — human signs each) | **pending** — must precede those sources' first `--apply` |
| G3 bulk canonicalize | remaining 117 sources, ~8,598 expected extractor invocations + `--resume` checkpoint; budget: user-provided 20 keys × 500 RPD (unverified — true request count measured in canary) | **NO-GO** until G1 result + G2 declarations + quota evidence |
| A3 gen build | `build_generation` (+ Docker exec if container path) | later, separate |
| A4 publish CAS | `publish` + canary cases | later, separate |
| A5 selector flip | `setKbSource` | later, separate |
| (optional) D4 | `zaapiKbReady` repoint to `zaapi_kb_embedding_generations` | needs code approval |

Import success ≠ KB usable: generation build → validate → publish →
selector flip → retrieval smoke → customer QA are downstream gates.

## Self-review

placeholders 0 · contradictions 0 · owner duplication 0 · wrong-collection
refs 0 · unbounded retry 0 · hidden provider/network calls 0 ·
shared-write-without-approval 0 · importer/build/publish/flip are separate
gated steps (not atomic) · `zaapi_kb` in must-not-touch.
