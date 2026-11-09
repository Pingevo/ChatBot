# Zaapi-Primary Evidence And Grounded Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zaapi KB the primary factual source while Shopee catalog and units remain mandatory commerce authorities, then close the observed Phase 10B grounding, recommendation, and duplicate-card defects.

**Architecture:** Preserve the existing TurnNeed -> retrieval requests -> source union -> candidate pool -> selection -> AnswerContext -> composition chain. Keep imported Zaapi rows as immutable raw/audit input, create identity-bound canonical knowledge records during import/build, and attach those records to Shopee/unit candidates through the existing `KbEvidenceResult` and `EvidenceAttachment` contracts. Do not create a second answer path or a runtime prose/keyword decision layer.

**Tech Stack:** Python 3, FastAPI chatbot modules, MongoDB, NumPy generation artifacts, BGE-M3 embeddings, Gemini structured extraction during the offline import/build step, pytest, Next.js 16/TypeScript admin UI.

**Spec:** `docs/superpowers/specs/2026-11-03-zaapi-primary-evidence-design.md`

## Global Constraints

- Zaapi KB cannot activate unless `mongo_catalog`, `units`, and `kb` are all enabled.
- Zaapi KB cannot create a product card, stock claim, price, link, or sellability state without a joined Shopee/unit identity.
- Zaapi owns grounded specs/compatibility/FAQ/troubleshooting; Shopee/units own commerce state.
- Web search and OpenRouter remain disabled in every acceptance run.
- Product MongoDB is read-only.
- Runtime semantic keyword/regex tables, semantic guards, heuristic helpers, and parallel decision owners may not be added without explicit user approval.
- Every production-function change updates `docs/SRS_SSD.md` section 6 and the active waythrough log.
- Each task starts RED, makes only its owner-level implementation GREEN, and runs its focused regression before proceeding.
- Existing dirty work is never reverted or overwritten; Task 1 disposes it before new production work begins.

## Review Focus

- A knowledge row that mentions several products must not attach every fact to every product; tests require exact model/item attribution.
- A cable capacity value must not become adapter/powerbank output power; tests distinguish `power_capacity_w` from `output_power_w`.
- Zaapi knowledge may be rich but stale; stock, price, sellability, and links must always come from current Shopee/units.
- A recommendation turn must present one primary listing while list/compare turns preserve their requested cardinality.
- Provider failure during offline canonicalization must leave a resumable unresolved record, never publish partial canonical authority.

---

### Task 1: Independently Close The Existing 19-File Candidate

**Files:**
- Review only the current 19-file manifest reported by `git status --short`; any correction found must stay inside its existing owner file and existing test manifest
- Test: existing files in `docs/test/` already modified by the candidate
- Documentation: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Consumes: current uncommitted root-cause corrections at HEAD `6c81d16`
- Produces: a clean committed baseline or a written stop report naming the rejected hunk; no later task starts on a dirty candidate

- [ ] **Step 1: Freeze the exact manifest and diff**

Run:

```bash
git status --short
git diff --numstat
git diff --check
git diff -- chatbot/shopeechat docs/SRS_SSD.md docs/test getoutofmywaybotkaikrook2.md
```

Expected: staging empty; exactly the known 19 files; no whitespace errors. Stop on any unexplained file.

- [ ] **Step 2: Reproduce every candidate correction at its behavioral boundary**

Run the focused suites that own subject resolution, exact-item evidence, grouped KB wiring, canonical specs, guard identity, and answer completeness:

```bash
.venv/bin/python -m pytest \
  docs/test/test_conversation_subject_set.py \
  docs/test/test_turn_decision.py \
  docs/test/test_phase4_source_union.py \
  docs/test/test_phase10b_description_chunks.py \
  docs/test/test_phase10b_canonical_specs_contract.py \
  docs/test/test_issue_5f_spec_grounding.py \
  docs/test/test_phase10b_answer_completeness.py -q
```

Expected: exit 0 and no Mongo/provider process remains.

- [ ] **Step 3: Run the bounded regression in both relevant orders**

Run the Phase 7/8/10B, selection, compatibility, policy, and replay suites once with `test_phase4_source_union.py` first and once last. Use the existing offline environment barrier from those suites. Expected: identical pass/skip/xfail counts and exit 0.

- [ ] **Step 4: Perform mechanism census**

Compare HEAD to the candidate for definitions/tables in the modified production files and report net helpers, guards, regexes, keyword tables, heuristic mechanisms, and decision owners. Expected: candidate report remains helpers +0, guards +0, regexes +0, keyword tables +0, decision owners -1.

- [ ] **Step 5: Ask the user for the repository-required first-commit gate**

Report the exact manifest, numstat, test counts, findings, and proposed commit messages. Do not stage until the user approves this commit gate.

- [ ] **Step 6: Commit the accepted candidate in two commits**

Stage implementation/tests/SRS without the active log and commit:

```bash
git commit -m "fix: close phase 10b evidence ownership gaps"
```

Then stage only `getoutofmywaybotkaikrook2.md` and commit:

```bash
git commit -m "docs: record phase 10b evidence audit closeout"
```

Expected: working tree and staging empty before Task 2.

---

### Task 2: Define Type-Correct Charging Evidence

**Files:**
- Modify: `chatbot/shopeechat/policy_resolver.py`
- Modify: `chatbot/shopeechat/device_compat.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/scripts/build_sellable_units.py`
- Modify: `docs/SRS_SSD.md`
- Test: `docs/test/test_phase10b_canonical_specs_contract.py`
- Test: `docs/test/test_phase10b_answer_completeness.py`
- Test: `docs/test/test_phase10b_zaapi_primary_evidence.py` (new)

**Interfaces:**
- Consumes: existing `FieldEvidence`, `extract_field_facts`, `resolve_compat`, unit `canonical_specs`, and device `min_watt`
- Produces: canonical fact keys `power_capacity_w`, `max_current_a`, `charging_protocols`, and existing `output_power_w` with distinct semantics

- [ ] **Step 1: Write RED schema tests**

Add executable tests proving:

```python
def test_cable_capacity_is_not_power_source_output():
    card = {"product_type": "cable", "canonical_specs": {
        "power_capacity_w": 240, "max_current_a": 6,
        "charging_protocols": ["pd3.1"]}}
    facts = extract_field_facts(card, subject_id="v:1#2")
    assert fact(facts, "power_capacity_w") == 240
    assert not has_fact(facts, "output_w_structured")

def test_ctc620p_capacity_covers_xiaomi_17_ultra_without_output_claim():
    decision = resolve_compat(cable_card_240w_6a_pd31(), xiaomi_17_ultra_spec())
    assert decision.outcome == "compatible"
    assert "missing_wattage_evidence" not in decision.reason_codes
    assert "cable_capacity_covers_target" in decision.reason_codes
```

Also test adapter `output_power_w`, mixed/unknown cable capacity, connector mismatch, protocol uncertainty, NaN/bool/negative values, and cross-item facts.

- [ ] **Step 2: Run RED tests**

```bash
.venv/bin/python -m pytest \
  docs/test/test_phase10b_zaapi_primary_evidence.py \
  docs/test/test_phase10b_canonical_specs_contract.py \
  docs/test/test_phase10b_answer_completeness.py -q
```

Expected: new cable-capacity tests fail because the fact keys and compatibility relation do not exist.

- [ ] **Step 3: Extend the existing fact owner**

In `extract_field_facts`, emit numeric values only from `canonical_specs`/`spec_facts`. Keep `_structured_watts` scoped to power-source output. Add no text parser. In `resolve_compat`, branch on the existing canonical product type: cable adequacy uses connector plus `power_capacity_w`; adapter/powerbank adequacy continues to use `output_w_structured`.

- [ ] **Step 4: Preserve canonical specs through unit build/card creation**

`build_sellable_units.py` must copy an already-normalized `canonical_specs` object into the unit record when supplied by the generation build. `to_unit_card` already preserves a dict; pin that behavior. Do not infer 240W from the listing title or description at runtime.

- [ ] **Step 5: Make RED GREEN and run existing wattage regressions**

Run the RED command plus `docs/test/test_phase10_compat_decision.py`, `docs/test/test_phase10_target_ownership.py`, and `docs/test/test_compat_mode_filter.py`. Expected: exit 0; adapter/powerbank behavior unchanged; cable answer no longer claims the cable outputs power.

- [ ] **Step 6: Update SRS and commit**

Document the changed fact and compatibility contracts, calls, side effects, and fallback behavior. Commit only Task 2 files:

```bash
git commit -m "fix: distinguish cable capacity from charger output"
```

---

### Task 3: Build Raw And Canonical Zaapi KB Records

**Files:**
- Create: `chatbot/shopeechat/kb_zaapi_schema.py`
- Modify: `docs/zaapi/script/import_zaapi_kb.py`
- Create: `docs/zaapi/script/export_zaapi_kb.py`
- Modify: `docs/SRS_SSD.md`
- Create: `docs/test/test_zaapi_kb_import.py`
- Create: `docs/test/fixtures/zaapi_kb_minimal/` with sanitized XLSX/TXT/manifest fixtures

**Interfaces:**
- Consumes: current raw `zaapi_kb` row documents and source fingerprints
- Produces: pure canonical `ZaapiKnowledgeRecord` serialization and Mongo collection `zaapi_kb_records`; raw `zaapi_kb` remains intact

- [ ] **Step 1: Write RED raw/canonical round-trip tests**

Tests must pin:

- unchanged source fingerprint imports idempotently;
- raw row remains byte-equivalent after canonical export/re-import;
- canonical records preserve source file/sheet/row and content fingerprint;
- model/item aliases stay attached to the exact record;
- malformed provider output becomes `readiness="invalid"` and never active;
- conflicting same-identity/fact values become `readiness="conflicted"`;
- provider failure leaves a resumable unresolved row and does not replace the previous published canonical records.

- [ ] **Step 2: Run RED importer tests**

```bash
.venv/bin/python -m pytest docs/test/test_zaapi_kb_import.py -q
```

Expected: fail because canonical schema/collection/export do not exist.

- [ ] **Step 3: Add one pure canonical data-contract owner**

`kb_zaapi_schema.py` contains only dataclasses/enums, validation, JSON serialization, and content fingerprinting. It must not connect to Mongo, call Gemini, classify customer intent, or search products. This is a required data-contract owner, not a helper or guard chain.

- [ ] **Step 4: Upgrade the importer without destroying raw data**

Keep `zaapi_kb` as raw/audit rows. Write canonical records to `zaapi_kb_records` only after the full source batch validates. Add CLI modes:

```text
--dry-run
--canonicalize
--resume <checkpoint>
--source <source_id>
--apply
```

Gemini structured extraction runs only under `--canonicalize`, uses a closed JSON schema, records model/prompt version, checkpoints every completed source fingerprint, and never logs raw credentials. Tests inject a fake extractor; no test calls a provider.

- [ ] **Step 5: Add indexes and atomic publication metadata**

Create indexes for `record_id` unique, source fingerprint, shop/platform, record type/topic, model codes, aliases, item/model IDs, readiness, and active revision. Publish by revision metadata only after all records for the batch validate; old active revision remains usable on failure.

- [ ] **Step 6: Implement canonical and sanitized raw export**

Canonical export contains every canonical record and schema revision. Raw export contains sanitized source rows/manifests without credentials. Re-importing unchanged canonical export creates no duplicate records.

- [ ] **Step 7: GREEN, SRS, and commit**

Run importer tests twice in opposite order and `py_compile` both scripts/module. Commit:

```bash
git commit -m "feat: canonicalize zaapi knowledge records"
```

---

### Task 4: Build And Validate Zaapi Knowledge Embeddings

**Files:**
- Modify: `chatbot/shopeechat/embedding.py`
- Modify: `chatbot/shopeechat/scripts/build_embeddings.py`
- Modify: `chatbot/shopeechat/scripts/publish_generation.py`
- Modify: `chatbot/shopeechat/scripts/refresh_data.sh`
- Modify: `docs/SRS_SSD.md`
- Create: `docs/test/test_zaapi_kb_embeddings.py`

**Interfaces:**
- Consumes: active, resolved canonical records from `zaapi_kb_records`
- Produces: generation artifact `zaapi_kb_embeddings.npz` keyed by `record_id`, shop/platform, record type/topic, and identity fields

- [ ] **Step 1: Write RED artifact tests**

Pin deterministic chunk text, one row per canonical knowledge unit, unique record IDs, 1024 dimensions, finite vectors, generation ID equality, source fingerprint, and exact row-count/hash validation. Include missing/corrupt/empty artifact publication failures when Zaapi is required.

- [ ] **Step 2: Run RED**

```bash
.venv/bin/python -m pytest docs/test/test_zaapi_kb_embeddings.py -q
```

- [ ] **Step 3: Reuse the existing embedding and verified-NPZ owners**

Do not add another model loader. Build embedding text from canonical record topic, identity labels, typed facts, and answer/steps. Store metadata arrays needed for runtime masks. Add artifact validation to `publish_generation.py` and a blocking build step to `refresh_data.sh` when `kb_source=zaapi` is the target generation policy.

- [ ] **Step 4: GREEN and old-generation compatibility**

Old generations without the artifact remain valid while Zaapi is inactive. Zaapi activation readiness fails when the active candidate generation lacks a valid artifact. Run publication tests and `bash -n refresh_data.sh`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: publish zaapi knowledge embeddings"
```

---

### Task 5: Replace Broad Zaapi Scanning With Identity-Bound Retrieval

**Files:**
- Modify: `chatbot/shopeechat/kb_zaapi.py`
- Modify: `chatbot/shopeechat/app.py`
- Modify: `chatbot/shopeechat/retrieval_runtime.py`
- Modify: `docs/SRS_SSD.md`
- Create: `docs/test/test_zaapi_kb_retrieval.py`
- Modify: `docs/test/test_phase4_source_union.py`

**Interfaces:**
- Consumes: TurnNeeds/profile, canonical records, `zaapi_kb_embeddings.npz`, catalog/unit candidates, `KbEvidenceResult`, `EvidenceAttachment`
- Produces: bounded identity-linked attachments/supporting evidence; no sellable candidate from KB alone

- [ ] **Step 1: Write RED retrieval tests**

Cover exact model/item resolution, aliases, topic-scoped semantic retrieval, troubleshooting questions without model text but with current subject, open discovery, cross-shop isolation, cross-item isolation, unresolved records, conflicting records, and no-catalog identity. Pin that PB100P Global PPS 5A evidence attaches only to PB100P Global and not PB150S.

- [ ] **Step 2: Prove current adapter fails**

Run:

```bash
.venv/bin/python -m pytest docs/test/test_zaapi_kb_retrieval.py -q
```

Expected failures include no-keyword follow-up, first-4000 scan behavior, missing identity attachment, and no semantic topic retrieval.

- [ ] **Step 3: Change `zaapi_kb_evidence` to consume typed scope**

Extend the existing function to accept `retrieval_profile`, `needs`, and `snap`. Apply masks in this order: active canonical revision, shop/platform, resolved item/model/code identities, record type/topic compatible with the need, then exact alias/code or vector ranking. Never use full-collection Python scanning.

- [ ] **Step 4: Emit existing evidence contracts**

Resolved records become `EvidenceAttachment` rows using item/model identity domains. Unresolved general FAQ/troubleshooting records remain supporting evidence and must carry need attribution. A canonical record never becomes a candidate card itself.

- [ ] **Step 5: Wire one deferred fetcher into grouped runtime**

`app.py` constructs one source-selected deferred KB fetcher using the already-compiled profile/needs/snapshot. `run_grouped_selection` runs it once through the existing KB channel. Remove any duplicate branch-specific Zaapi invocation rather than adding another callsite.

- [ ] **Step 6: GREEN, regression, SRS, and commit**

Run Zaapi retrieval, source union, candidate pool, selection, AnswerContext, and exact-item suites. Assert collection query count is bounded and zero legacy KB reads occur when Zaapi is selected. Commit:

```bash
git commit -m "feat: retrieve zaapi evidence by need and identity"
```

---

### Task 6: Enforce Zaapi Source Dependencies In Runtime And Admin UI

**Files:**
- Modify: `chatbot/shopeechat/runtime_config.py`
- Modify: `ChatAdminWeb/src/backend/service/systemConfigService.ts`
- Modify: `ChatAdminWeb/src/app/api/admin-config/route.ts`
- Modify: `ChatAdminWeb/src/app/(console)/admin-config/page.tsx`
- Modify: `docs/SRS_SSD.md`
- Modify: `docs/test/test_runtime_config.py`
- Modify: `docs/test/test_pool_sources_admission.py`
- Create: `ChatAdminWeb/scripts/test-admin-config-pool-policy.ts`

**Interfaces:**
- Consumes: `kb_source`, `pool_sources`, Zaapi corpus/artifact readiness
- Produces: validated atomic configuration where Zaapi implies catalog+units+kb ON

- [ ] **Step 1: Write RED truth-table tests**

Pin valid legacy configurations and these Zaapi cases:

```text
zaapi + kb/catalog/units ON + ready -> valid
zaapi + any mandatory source OFF -> reject write and runtime not ready
zaapi + corpus/artifact not ready -> reject activation
invalid persisted config -> fail closed; do not query Zaapi
```

- [ ] **Step 2: Run Python and TypeScript RED tests**

Run:

```bash
.venv/bin/python -m pytest docs/test/test_runtime_config.py -q
.venv/bin/python docs/test/test_pool_sources_admission.py
cd ChatAdminWeb && npx tsx scripts/test-admin-config-pool-policy.ts
```

Expected: current independent switches allow invalid Zaapi combinations.

- [ ] **Step 3: Validate at the existing config owner**

The service/API performs one atomic validation before write. Python exposes readiness/validity through `runtime_config`; it does not silently force switches ON. Retrieval sees invalid state as Zaapi unavailable and performs zero KB reads.

- [ ] **Step 4: Update UI behavior**

When Zaapi is selected, show catalog, units, and KB as required and prevent saving an invalid combination. Display readiness failures from the API. Keep image text optional. Do not create a new settings page.

- [ ] **Step 5: GREEN, `tsc`, SRS, and commit**

Run the three source-policy commands above and `cd ChatAdminWeb && npx tsc --noEmit`. Commit:

```bash
git commit -m "fix: require commerce sources for zaapi knowledge"
```

---

### Task 7: Select One Primary Recommendation And Collapse Listing Cards

**Files:**
- Modify: `chatbot/shopeechat/answer_context.py`
- Modify: `chatbot/shopeechat/app.py` only at the existing composition/response boundary
- Modify: `ChatAdminWeb/src/components/chat/TestChatClient.tsx`
- Modify: `docs/SRS_SSD.md`
- Create: `docs/test/test_phase10b_recommendation_presentation.py`
- Modify: `docs/test/test_phase8_composition.py`
- Modify: `docs/test/test_phase10b_answer_completeness.py`

**Interfaces:**
- Consumes: selected variant-granular candidates, TurnNeed operation/order, typed compatibility decisions
- Produces: one primary listing for `recommend`, bounded listing set for list/search, explicit set for compare, and stable UI keys

- [ ] **Step 1: Write RED presentation tests**

Pin:

- Xiaomi recommendation with three compatible cable candidates presents only the highest-ranked primary listing;
- an incompatible historical CTL301 may produce one explanatory clause but no recommendation card;
- two variants of one item remain distinct through stock evaluation and become one customer card;
- `list` still returns multiple distinct listings;
- `compare` keeps all explicitly compared identities;
- PB150S mixed stock says which variant is unavailable and which is available;
- no positive and unanswered outcome coexist for the same need.

- [ ] **Step 2: Run RED**

```bash
.venv/bin/python -m pytest \
  docs/test/test_phase10b_recommendation_presentation.py \
  docs/test/test_phase8_composition.py \
  docs/test/test_phase10b_answer_completeness.py -q
```

- [ ] **Step 3: Apply cardinality in the existing AnswerContext/composition owner**

Use `TurnNeed.operation`, existing selection order, and listing `item_id`. Do not add a phrase detector or score threshold. Keep all variant evidence available for typed decisions, then project decided customer cards by listing at the final product/card boundary.

- [ ] **Step 4: Make availability deterministic**

For one listing with mixed variants, render availability from typed variant states before model prose. The model may explain but cannot overwrite the stock conclusion.

- [ ] **Step 5: Fix React identity**

Use the existing product identity fields in this order: `unit_id`, `item_id:model_id`, `item_id`, then index. Verify the browser console has no duplicate-key warning for PB150S variants.

- [ ] **Step 6: GREEN, UI verification, SRS, and commit**

Run Phase 7/8/10B composition and subject tests, TypeScript compile, and a localhost Test Chat browser check. Commit:

```bash
git commit -m "fix: present one grounded recommendation per need"
```

---

### Task 8: Run The Complete Offline Acceptance Matrix

**Files:**
- Create: `docs/test/test_phase10b_zaapi_acceptance.py`
- Modify: `docs/test/live_matrix_abc.py` only for missing instrumentation, never to alter production behavior
- Modify: `docs/SRS_SSD.md` for final contract corrections
- Append: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Consumes: Tasks 2-7 final bytes
- Produces: executable acceptance for every observed customer failure and a clean offline regression report

- [ ] **Step 1: Encode every observed conversation as behavioral acceptance**

Include Pingevox CTL301/Xiaomi/head-charger/greetings, Wattaka CMC615P data speed/10Gbps+magnetic, IMILAB W01 GPS/pace/heart-rate/Strava, PB150S mixed variants, PB100P Global PD3.0/PPS 5A, exact-item and multi-need order.

- [ ] **Step 2: Run focused acceptance**

Expected: all cases pass route assertions, evidence identity/provenance assertions, card-count assertions, and customer-text semantic assertions.

- [ ] **Step 3: Run the affected full regression**

Run this exact Python batch once in the listed order and once with the three Zaapi files moved to the end:

```bash
.venv/bin/python -m pytest \
  docs/test/test_zaapi_kb_import.py \
  docs/test/test_zaapi_kb_embeddings.py \
  docs/test/test_zaapi_kb_retrieval.py \
  docs/test/test_phase4_source_union.py \
  docs/test/test_grouped_retrieval_executor.py \
  docs/test/test_grouped_retrieval_requests.py \
  docs/test/test_candidate_pool_union.py \
  docs/test/test_retrieval_selection.py \
  docs/test/test_retrieval_selection_runtime.py \
  docs/test/test_phase7_answer_context.py \
  docs/test/test_phase7_boundary_review.py \
  docs/test/test_phase8_composition.py \
  docs/test/test_phase10_compat_decision.py \
  docs/test/test_phase10_target_ownership.py \
  docs/test/test_phase10b_answer_completeness.py \
  docs/test/test_phase10b_canonical_specs_contract.py \
  docs/test/test_phase10b_description_chunks.py \
  docs/test/test_phase10b_exact_item_identity.py \
  docs/test/test_phase10b_multi_need_composition.py \
  docs/test/test_phase10b_recommendation_presentation.py \
  docs/test/test_phase10b_zaapi_acceptance.py \
  docs/test/test_phase10b_zaapi_primary_evidence.py \
  docs/test/test_turn_decision.py \
  docs/test/test_conversation_subject_set.py \
  docs/test/test_phase5_field_policy_compat.py \
  docs/test/test_guards.py -q
```

Record exact pass/skip/xfail counts and ensure no pytest/PyMongo process remains. If a listed historical filename has been renamed before execution, resolve it with `rg --files docs/test | rg '<stem>'`, record the resolved path in the report, and do not silently omit the suite.

- [ ] **Step 4: Run static/structural gates**

```bash
.venv/bin/python -m py_compile \
  chatbot/shopeechat/policy_resolver.py \
  chatbot/shopeechat/device_compat.py \
  chatbot/shopeechat/units.py \
  chatbot/shopeechat/kb_zaapi_schema.py \
  chatbot/shopeechat/kb_zaapi.py \
  chatbot/shopeechat/runtime_config.py \
  chatbot/shopeechat/retrieval_runtime.py \
  chatbot/shopeechat/answer_context.py \
  chatbot/shopeechat/app.py \
  chatbot/shopeechat/embedding.py \
  chatbot/shopeechat/scripts/build_sellable_units.py \
  chatbot/shopeechat/scripts/build_embeddings.py \
  chatbot/shopeechat/scripts/publish_generation.py \
  docs/zaapi/script/import_zaapi_kb.py \
  docs/zaapi/script/export_zaapi_kb.py
cd ChatAdminWeb && npx tsc --noEmit
git diff --check
```

Run the mechanism census. Any unexplained helper/guard/regex/keyword/heuristic/decision-owner increase stops the task.

- [ ] **Step 5: Commit offline acceptance artifacts**

Do not commit generated result JSON, embeddings, exports, or secrets. Commit only test code/SRS changes:

```bash
git commit -m "test: lock zaapi grounded-answer acceptance"
```

---

### Task 9: Run Real Mongo + Gemini Acceptance And Close The Branch

**Files:**
- Results (gitignored): `docs/test/results/phase10b_zaapi_primary_*.json` and `.md`
- Append-only: `getoutofmywaybotkaikrook2.md`
- Update status: `docs/plans/2026-10-21-zaapi-workflow-kb-pool-master-plan.md`
- Update status: `docs/superpowers/specs/2026-11-03-zaapi-primary-evidence-design.md`

**Interfaces:**
- Consumes: final committed offline candidate, real read-only product/admin Mongo, real Gemini, candidate generation artifacts
- Produces: customer-facing acceptance report, rollback-safe activation recommendation, and clean branch

- [ ] **Step 1: Preflight safety**

Verify product/admin Mongo targets, enforce write barriers, pin generation process-locally, block web/OpenRouter/vision, use isolated conversation IDs, and print no secrets. Stop if any target is shared-production writable or artifact generation does not match the code.

- [ ] **Step 2: Import/build a bounded Zaapi pilot**

Canonicalize the exact CUKTECH and IMILAB sources required by the acceptance corpus first. Validate raw/canonical counts, unresolved/conflicted rows, embeddings, hashes, and retrieval smokes before any full-corpus build.

- [ ] **Step 3: Run real customer conversations**

Run the acceptance corpus with real Mongo reads and real Gemini. Retry only transient 503 with bounded 5-second spacing and a fixed attempt cap. Persist full question, answer, selected identities, need attribution, evidence provenance, usage, and timing.

- [ ] **Step 4: Manually score answer quality**

For every turn verify direct conclusion, completeness, identity correctness, stock truth, compatibility wording, recommendation count, duplicate cards, and handoff necessity. Route success alone is not a pass.

- [ ] **Step 5: Full-corpus build only after pilot passes**

Run canonical import and embedding for all Zaapi sources with checkpoints. Validate and stage the generation without flipping a shared pointer. Repeat read-only retrieval samples across shops/topics.

- [ ] **Step 6: Final independent review and closeout**

Require no Critical/High/Medium findings, zero new unexplained regressions, zero cross-product evidence, zero ungrounded positive claims, and zero duplicate cards. Update master-plan status and append the final Thai technical plus plain-language report.

- [ ] **Step 7: Commit closeout documentation**

```bash
git commit -m "docs: record zaapi primary evidence closeout"
```

Expected final state: clean working tree, empty staging, no provider/test process, no pointer flip/deploy/push/PR unless separately approved.
