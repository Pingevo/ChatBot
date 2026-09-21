# Legacy Retrieval Redesign Rev 2 — Current Flow Audit And No-Regression Plan

**Status:** completed current-flow audit; implementation is specified in `2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md`
**Scope:** legacy Shopee chatbot only: `chatbot/shopeechat/app.py` runtime path. Ignore `chat_v2` and `chatbotv3`.
**Reason for rev 2:** the current code has moved since the first redesign plan. In particular, `units.py` is already wired through `product_store.fetch_products()` behind `USE_UNIT_INDEX`, so the implementation must improve the existing convergence instead of creating a second convergence pipeline.

## Goal

Make product selection more correct without breaking existing answers:

- Keep working deterministic flows: order, claim, handoff, policy, item tag, active product, compare follow-up.
- Keep current `ChatResponse.products` shape.
- Keep unit path where it already works.
- Keep legacy sweep for compatibility until unit can prove equivalent or better.
- Move duplicated selection decisions into small owners.
- Delete old duplicated branches only after replay gates prove behavior is safe.

This is not a rewrite. The safest path is to stabilize the current flow, measure it, then extract one owner at a time.

## Current Flow From Code

The current runtime is not a single candidate pool yet, but it is also no longer fully separate unit and legacy paths.

```text
chat()
  deterministic early flows
    item tag
    order / return / tracking
    warranty / claim
    general policy
  context and state flows
    image anchor
    comparison follow-up
    link follow-up
    conversation active product
  retrieval flows
    KB + Mongo merge path
    product_store.fetch_products()
      optional unit path first
      legacy path fallback
    device_compat re-query/filter
    web_search re-answer fallback
  final context shaping
    app.py merge anchors
    app.py availability note
    app.py rejection memory
    device_compat tier merge
    llm.answer
    guards.enforce
```

### Product Pull Points Today

1. `fetch_product_by_id()` for item tags and explicit Shopee item cards.
2. `conversation_products` for active product, link follow-up, suggestion batch, compare anchors.
3. KB product docs plus Mongo merge in `app.py`.
4. `product_store.fetch_products()` for normal product retrieval.
5. `units.fetch_unit_cards()` called at the top of `product_store.fetch_products()` when `USE_UNIT_INDEX` allows it.
6. `device_compat._device_spec_lookup()` for compatibility re-query and device evidence.
7. `web_search.reanswer()` for last-resort search, DB re-query, and second LLM answer.

## Review Of The Previous Plan

The previous direction was mostly right:

- Measurement first is still required.
- Single availability owner is still required.
- Identity by bounded model token is still required.
- Compare must preserve both products.
- Compatibility must require evidence.
- `app.py` must stop owning ranking and availability policy over time.

The part that needs correction:

- Do not build a brand-new "collect unit + collect legacy" flow beside `fetch_products()`.
- `fetch_products()` already owns "try unit then legacy fallback" for many calls.
- A new candidate layer should first wrap current cards for telemetry and selector tests, not replace current retrieval sources.
- Compatibility should keep bypassing unit path for now because the current code intentionally uses a wider legacy sweep.

## Root Causes To Fix

### Root Cause 1: Selection Decisions Have Too Many Owners

Availability, ranking, diversity, exact match, compare preservation, and compatibility ordering are split across:

- `app.py`
- `product_store.py`
- `units.py`
- `device_compat.py`
- `web_search.py`
- `conversation_products.py`

Long-term fix: leave each file with one job and move cross-source selection policy into a small selection owner.

### Root Cause 2: Availability Is Still Recomputed In Multiple Places

Current code still computes availability in at least:

- `product_store._doc_sellable()`
- `product_store.to_product_card()`
- `units._live_sellable()`
- `units.to_unit_card()`
- `app.py` before LLM context notes
- dedupe sell-score

Long-term fix: Plan 1 `resolve_availability()` must land before selector behavior changes.

### Root Cause 3: `app.py` Mixes Orchestration With Retrieval Policy

`app.py` should decide the route and orchestrate calls, but today it also:

- mutates `retrieval_message`
- decides anchor versus fetch
- injects product type/subtype prefixes
- merges anchors into products
- recomputes availability
- sorts superlative/compat products
- builds policy notes
- controls some fallback choices

Long-term fix: extract policy in very small steps. Do not add another large helper that simply moves the bloat.

### Root Cause 4: Compatibility Is A Special Pipeline

Compatibility currently bypasses unit because unit top-N is too small for broad high-wattage/spec sweep. That is a valid current safety decision.

Long-term fix: keep the special path until measurement proves unit candidates can provide enough recall. Do not force compatibility into unit-first behavior early.

### Root Cause 5: Hardcode Fixes Are Often Specific To Charger

Subtype carry, strong/loose "หัว", adapter/cable/set filters, and compat re-query have many charger-specific branches.

Long-term fix: separate generic policy from product-family classifiers. Charger logic can remain as taxonomy data, but not as scattered runtime branches in `app.py`.

## New Target Shape

The target shape should build on current code:

```text
app.py
  route and deterministic flows only
  calls current retrieval source
  calls selection owner
  calls llm.answer
  calls guards.enforce

product_store.py
  Mongo/listing source
  unit gate remains here at first
  card creation
  no final context policy

units.py
  unit source
  unit card creation
  live unit availability via shared resolver

device_compat.py
  device evidence and compat filtering
  no final tier merge owner after migration

route_context.py
  normalized route facts
  product type / subtype / model code / need flags

retrieval_policy.py
  small owner for profile, availability marking, tier policy, final selection
```

Only one new runtime file is proposed at first: `retrieval_policy.py`.

Do not create `retrieval_candidates.py`, `retrieval_selector.py`, and `retrieval_profile.py` immediately unless `retrieval_policy.py` becomes too large. The no-bloat rule is one owner first; split only when the file has proven separate responsibilities.

## Proposed Flow After Migration

```text
1. app.py resolves route, intent, state
2. deterministic early flows may return
3. app.py obtains products through existing paths
   - item tag
   - KB + Mongo
   - product_store.fetch_products() with unit gate
   - device_compat re-query when needed
4. retrieval_policy builds a profile from route + intent + state
5. retrieval_policy marks availability using product_store.resolve_availability()
6. retrieval_policy merges protected products
   - item tag anchor
   - active product
   - compare pair
   - exact model hits
7. retrieval_policy selects final LLM context
8. app.py calls llm.answer
9. web_search fallback keeps current behavior until it has its own gate
10. app.py records suggestions
```

This keeps current retrieval sources but removes repeated final decision logic over time.

## Non-Negotiable No-Regression Rules

1. No behavior-changing retrieval refactor before offline baseline and human-reviewed gold set.
2. Do not change deterministic order/warranty/handoff flows in this work.
3. Do not change v2/v3.
4. Do not change prompt blocks as a substitute for retrieval correctness.
5. Do not remove `is_compat_check` unit bypass until compat recall is measured.
6. Do not dedupe compare pairs away.
7. Do not recommend or link unavailable products for shopping intent.
8. Do allow unavailable exact products for spec, warranty, history, and order follow-up.
9. Do not add new DB schema or runtime dependency.
10. Every deleted branch needs a replay/test that proves the replacement covers it.

## Phased Plan

### Phase 0: Freeze The Baseline Before Runtime Changes

Purpose: make sure later changes are judged against actual current behavior.

Work:

- Keep Plan 1 Task 1 and Task 2 as the first real implementation work.
- Build offline evaluator from `docs/test/results/unit_reg_questions_2026-09-18.jsonl`.
- Build human-reviewed gold retrieval set.
- Tag cases by intent:
  - recommend
  - exact model
  - sold-out exact model
  - unlisted/discontinued spec
  - warranty/history
  - compare
  - compatibility charging
  - compatibility non-charging
  - link follow-up
  - active product follow-up

Exit gate:

- baseline metrics saved
- gold validator passes
- human review completed
- no runtime behavior changed

Impact:

- No production behavior risk.
- Required to prevent "fix one case, break ten" changes.

### Phase 1: Finish Single Availability Owner

Purpose: remove the most dangerous duplicated policy first.

Work:

- Add `product_store.resolve_availability()`.
- Make `product_store._doc_sellable()` call it.
- Make `product_store.to_product_card()` call it.
- Make `units._live_sellable()` and `units.to_unit_card()` call it.
- Replace `app.py` availability recompute with the resolver.
- Preserve current output fields:
  - `status`
  - `sold_out`
  - `total_stock`
  - `_available_for_sale`
  - `sellable`
- Keep `catalog_status` internal or strip it from LLM context until the prompt is updated intentionally.

Tests:

- `docs/test/test_availability.py`
- `docs/test/test_availability_wiring.py`
- existing `docs/test/test_units.py`
- existing `docs/test/test_unit_card_fields.py`
- `python -m py_compile chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/app.py`

Impact:

- Expected behavior should be parity.
- Main risk is wording around out-of-stock versus unlisted.
- Mitigation: resolver tests must include NORMAL stock 0, NORMAL stock > 0, UNLIST with stock, SELLER_DELETE, missing stock, and model-level stock.

### Phase 2: Add Read-Only Selection Trace

Purpose: see where products came from without changing what the customer gets.

Work:

- Create `chatbot/shopeechat/retrieval_policy.py`.
- Add a read-only function:

```python
def summarize_selection(
    products: list[dict],
    *,
    message: str,
    intent_result: dict | None,
    route,
    source: str,
) -> dict:
    ...
```

- It returns counts only:
  - source label
  - product count
  - unit count
  - unavailable count
  - duplicate item_id count
  - duplicate listing count
  - compare protected count
  - target device present
- Add this summary to `steps` or `routing_decision`.
- Do not change `products`.

Tests:

- `docs/test/test_retrieval_policy_trace.py`
- py_compile for `app.py` and `retrieval_policy.py`

Impact:

- No customer-facing change.
- Gives evidence before moving policy.

### Phase 3: Move Final Availability Notes Into Policy Owner

Purpose: remove one block from `app.py` without changing behavior.

Current owner:

- `app.py` computes `_available_for_sale`
- builds `_pending_context_note`
- later injects it into product 0

New owner:

```python
def mark_availability_and_notes(products: list[dict]) -> tuple[list[dict], str]:
    ...
```

Rules:

- Mutate the same fields as today or return copied cards consistently.
- Use `resolve_availability()` only.
- Return the exact same note text at first.
- Do not change prompt wording in this phase.

Tests:

- product active + stock > 0
- NORMAL + stock 0
- UNLIST + stock > 0
- mixed products
- timeline-restored card missing fields

Impact:

- Low if output notes are byte-for-byte equivalent.
- Shrinks `app.py`.
- Gives one owner for sale eligibility.

### Phase 4: Move Tier Merge Out Of `device_compat.py`

Purpose: tier merge is not compatibility evidence; it is final context selection.

Current owner:

- `device_compat._apply_product_tiers()`

New owner:

```python
def apply_context_tiers(
    products: list[dict],
    protected_item_ids: set[str],
    *,
    limit: int,
) -> list[dict]:
    ...
```

Keep behavior:

- protected products first
- sellable Tier B first
- call existing `product_store._dedupe_products()`
- same limit behavior

Do not move `_filter_compat_products()` yet. Compatibility filtering stays in `device_compat.py`.

Tests:

- protected exact product survives even unavailable
- active product survives
- compare pair survives
- Tier B sellable products rank before unavailable
- duplicate base names dedupe as today

Impact:

- Medium because final context ordering matters.
- Mitigation: run baseline/gold comparison before and after.

### Phase 5: Make A Small Retrieval Profile From Existing Facts

Purpose: stop scattering "what kind of question is this" through final selection.

Owner:

- `retrieval_policy.py`

Function:

```python
def build_retrieval_profile(
    message: str,
    *,
    route,
    intent_result: dict | None,
    state_flags: dict,
) -> dict:
    ...
```

Inputs should be facts already computed:

- `route_context.resolve_route()`
- intent result
- state flags from `app.py`
  - has active product
  - has compare pair
  - is partial compare
  - is link follow-up
  - is conv active
  - has target device

Do not call Mongo, LLM, web, or embedding.

Profile values:

- `mode`: `recommend`, `exact`, `spec`, `warranty`, `compat`, `compare`, `history`, `fallback`
- `allow_unavailable`
- `prefer_unit`
- `require_compat_evidence`
- `preserve_compare_pair`
- `max_per_listing`

Tests:

- shopping recommendation disallows unavailable
- exact warranty allows unavailable
- compare preserves pair
- compatibility requires evidence
- link follow-up uses previous products and does not search new by default

Impact:

- Read-only first.
- Later phases use it to replace scattered flags.

### Phase 6: Introduce Final Selection Function Behind Current Behavior

Purpose: make one function responsible for final LLM context.

Function:

```python
def select_llm_products(
    products: list[dict],
    *,
    profile: dict,
    protected_item_ids: set[str],
    limit: int,
) -> list[dict]:
    ...
```

Initial implementation should delegate to existing helpers:

- `mark_availability_and_notes()`
- `apply_context_tiers()`
- `product_store._dedupe_products()`

Do not touch source retrieval yet.

Tests:

- recommend mode: sellable first
- spec mode: exact unavailable allowed
- compare mode: protected pair cannot be removed
- compat mode: does not claim compatibility; it only keeps context order
- per-listing cap only applies to broad recommendation, not exact/code hit

Impact:

- Medium-high.
- Enable for one low-risk source path first, not all paths.

### Phase 7: Replace One `app.py` Policy Block At A Time

Purpose: delete duplication, not add layers.

Order:

1. Replace availability marking block.
2. Replace tier merge call.
3. Replace superlative sort only after metrics prove parity.
4. Replace compare merge only after compare tests pass.
5. Replace link-follow-up shaping last because it is state-sensitive.

Every replacement must:

- remove or shrink code in `app.py`
- keep the same tests green
- run offline evaluator
- add no new runtime dependency

Impact:

- Controlled because each step has one deletion target.
- If a step cannot delete old code, stop and rethink; do not leave parallel logic.

### Phase 8: Compatibility Candidate Review

Purpose: decide if compatibility can move closer to the common selector.

Do not change current compat behavior until this phase.

Audit:

- compare current legacy compat sweep against unit pool recall
- measure high-wattage recall
- measure non-charging compat recall
- measure product type purity
- record when unit path misses products that legacy finds

Possible outcomes:

1. Keep compatibility legacy-only for now.
2. Add unit candidates only as supplemental evidence.
3. Move compat candidates into final selector if recall is equal or better.

Impact:

- This is the riskiest domain.
- No change without metrics and replay.

### Phase 9: Delete Hardcode Branches Only After Ownership Exists

Deletion candidates:

- duplicate availability recompute in `app.py`
- final tier merge ownership in `device_compat.py`
- direct superlative sort in `app.py`
- duplicated subtype prefix injection if `route_context` and profile cover it
- duplicate exact-model regex search outside the source owner
- fallback blocks that only exist because the previous owner could not express policy

Do not delete:

- item tag direct lookup
- conversation anchor storage
- order/warranty deterministic flows
- compatibility evidence lookup
- web search fallback

Deletion rule:

If the new owner cannot explain the old branch's behavior in one test, keep the branch.

## File Ownership After The Plan

### `app.py`

Owns:

- request lifecycle
- deterministic early returns
- calling retrieval sources
- calling selection policy
- calling LLM and guard
- response assembly

Does not own:

- availability formulas
- final ranking policy
- compatibility evidence rules
- product identity rules
- dedupe policy

### `product_store.py`

Owns:

- listing retrieval
- current unit gate entry point until a later proven split
- listing card creation
- shared identity primitive `_model_token_in_name`
- shared availability resolver
- existing dedupe helper until moved or renamed

Does not own:

- final LLM context selection
- compare preservation policy

### `units.py`

Owns:

- unit retrieval
- unit card creation
- live unit stock join

Does not own:

- final ranking across unit/listing/history
- broad compatibility recall

### `device_compat.py`

Owns:

- device spec lookup
- compatibility evidence
- compatibility filtering

Does not own:

- final tier merge after Phase 4
- generic ranking policy

### `route_context.py`

Owns:

- normalized message facts
- product type/subtype/model code extraction
- typo normalization

Does not own:

- ranking
- database access

### `retrieval_policy.py`

Owns:

- retrieval profile
- availability note policy
- protected product policy
- final LLM context selection

Does not own:

- Mongo queries
- unit index
- device spec extraction
- LLM calls

## Regression Gate

A phase cannot be called complete unless it passes the relevant gate.

Always run for product-code changes:

```bash
python -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/device_compat.py
```

Focused tests:

```bash
.venv/bin/python docs/test/test_units.py
.venv/bin/python docs/test/test_unit_card_fields.py
.venv/bin/python docs/test/test_compat_mode_filter.py
.venv/bin/python docs/test/test_car_charger_regression.py
.venv/bin/python docs/test/test_route_context.py
.venv/bin/python docs/test/test_guards.py
```

Retrieval gates after Plan 1:

```bash
.venv/bin/python docs/test/test_eval_retrieval.py
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl --gold docs/test/gold_retrieval.jsonl --by-intent
```

Replay gate before broad rollout:

- exact model: PB100 must not become LPB100/PB100S/PB1000
- sold-out exact model spec still answers
- unlisted/discontinued warranty/history still answers
- recommend does not sell unavailable product
- compare keeps both products
- charger compatibility keeps high-wattage candidates
- non-charging compatibility does not disappear due to connector ambiguity
- link follow-up returns previous products
- item tag still answers directly when safe

## Code Size Gate

Track before and after each phase:

```bash
wc -l chatbot/shopeechat/app.py chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/device_compat.py chatbot/shopeechat/retrieval_policy.py
```

Rules:

- If `retrieval_policy.py` grows beyond roughly 350 lines, split only by proven responsibility.
- If `app.py` grows in a phase that claims extraction, the phase failed.
- Every new helper must replace a branch or be telemetry-only with a removal date.
- No second candidate pipeline beside `fetch_products()` until measurement proves the need.

## What This Plan Intentionally Does Not Do

- No rewrite of `/chat`.
- No new vector database.
- No new LLM classifier.
- No new DB schema.
- No new dependency.
- No v2/v3 work.
- No immediate deletion of legacy fallback.
- No immediate compatibility rewrite.
- No global config system for every product type.

## Plan Self-Review

### Coverage

The plan covers current code reality:

- unit is already inside `fetch_products`
- compatibility intentionally bypasses unit
- availability is still duplicated
- final selection is still spread across `app.py`, `device_compat.py`, and `product_store.py`
- no-regression gates are required before behavior changes

### Bloat Check

The plan adds one initial runtime file, `retrieval_policy.py`, not three. It delays candidate objects until current cards and metrics prove the need.

### Risk Check

Highest-risk areas:

1. compatibility recall
2. compare pair preservation
3. exact model identity
4. availability wording
5. link/active-product follow-up

Each has a specific gate before rollout.

### Root Cause Check

The plan does not patch charger only. It moves duplicated ownership out of scattered branches and into one final selection owner, while keeping product-family evidence in the files that already own that knowledge.
