# Legacy Shopee Retrieval Redesign

**Status:** draft for user review  
**Scope:** `chatbot/shopeechat` legacy engine only. Ignore `chat_v2` and `chatbotv3`.  
**Builds on:** `docs/plans/2026-09-21-plan1-measurement-availability-identity.md` rev 1.2 and `docs/plans/2026-09-21-retrieval-hybrid-rerank-plan.md`.

## Goal

Make product selection reliable for 65 Shopee shops with mixed catalogs, variant-heavy listings, discontinued products, warranty/spec follow-ups, comparisons, and compatibility questions, while reducing runtime hardcode and duplicate retrieval pipelines.

The target behavior is not "always recommend sellable products". It is:

- Recommend only sellable products when the customer is shopping.
- Still retrieve unlisted, sold-out, and discontinued products when the customer asks about a specific model, warranty, spec, history, or an item they already bought.
- Preserve multiple products/variants for compare questions.
- Require grounded evidence for spec, warranty, and compatibility.
- Send LLM a small, honest context; never ask it to infer catalog truth from weak matches.

## Current Shape

Current legacy flow is powerful but tangled:

```text
app.py
  normalize/vision/anchor/order/warranty/intent/policy
  mutates retrieval_message many times
  calls product_store.fetch_products
  calls device_compat re-query
  merges/dedupes/notes availability
  calls llm.answer
  guards.enforce

product_store.py
  type/subtype detection
  unit gate
  regex/vector/Mongo fallback
  rerank/dedupe/card

units.py
  separate unit candidate path
  separate sellable snapshot/live re-sort
  separate rank/fallback

device_compat.py
  separate re-query/filter/sort
```

The problem is not lack of logic. The problem is too many owners for the same decisions:

- message meaning: `app.py`, `route_context.py`, `intent_classifier.py`, `product_store.py`
- availability: `product_store.py`, `units.py`, `app.py`, dedupe score
- identity: listing name, item_id, item_id+model_id, model token substring
- ranking: unit ranking, legacy ranking, compat sort, superlative sort, app merge rules
- context truth: cards, KB, OCR, device specs, history, output guards

## Design Iterations

### Iteration 0 — Replace legacy with unit path

Rejected.

Unit path solves variant stock, but it is too narrow for compatibility sweep, broad catalog fallback, discontinued listing lookup, and current device compatibility behavior. Replacing legacy would lose working behavior.

### Iteration 1 — Keep current flow and add more guards

Rejected.

This continues the current pattern: charger-specific fixes, app.py retrieval mutation, and late guards. It may fix the next bug but does not make the next product type safer.

### Iteration 2 — Merge unit and legacy inside `app.py`

Rejected.

`app.py` is already the hardest file to reason about. Adding source merge/ranking there would make the orchestration worse and keep retrieval untestable.

### Iteration 3 — Candidate contract inside retrieval layer

Accepted as the core direction.

Legacy listing search and unit search should become candidate sources. They should not decide final ranking independently. They return normalized candidates; one selector resolves availability, identity, diversity, rank, and context-card conversion.

### Iteration 4 — Profile-driven selector after Plan 1

Chosen.

Do Plan 1 first because it gives the measurement baseline, gold review, single availability resolver, and initial diversity guard. Then introduce a `RetrievalProfile` and `Candidate` layer in small, measurable steps.

## Target Flow

```text
1. Route request
   app.py builds RouteContext + ConversationState

2. Deterministic safety
   order / tracking / claim / handoff / tax / policy branches still return early

3. Build RetrievalProfile
   intent + route + state -> one profile object

4. Collect candidates
   anchors + exact model + unit source + legacy listing source + KB source + compat source

5. Normalize candidates
   one identity shape, one availability result, one evidence envelope

6. Select candidates
   rank by profile, enforce diversity, preserve compare pairs, keep exact matches

7. Build context cards
   convert selected candidates to existing product-card shape for llm.answer

8. Answer and guard
   llm.answer -> guards.enforce -> persist suggestions/state
```

## Core Interfaces

These are intentionally plain dict/dataclass-like Python objects. No new dependency, no DB schema change in the first pass.

### `RetrievalProfile`

Purpose: encode what the customer is trying to do so retrieval can stop guessing from scattered flags.

Fields:

```python
{
  "intent": "recommend|search|spec|warranty|compatibility|compare|superlative|exact_model|history",
  "product_types": set[str],
  "charger_subtype": str | None,
  "model_codes": list[str],
  "target_device": str | None,
  "allow_unavailable": bool,
  "prefer_unit": bool,
  "preserve_variants": bool,
  "require_compat_evidence": bool,
  "max_per_listing": int | None,
  "ranking_mode": "sellable_first|exact_first|compat_first|compare_diverse|superlative",
}
```

Profile examples:

| Customer asks | Profile result |
|---|---|
| "มีหัวชาร์จไหม" | recommend, sellable only, unit preferred, max 1 per listing |
| "PB100 รับประกันกี่ปี" | warranty/spec, allow unavailable, exact first |
| "ตัวนี้กับตัวก่อนต่างกันยังไง" | compare, preserve variants, compare-diverse |
| "ใช้กับ iPhone 15 ได้ไหม" | compatibility, require compat evidence, compat-first |
| "HA835 มีไหม" | exact_model, allow unavailable, exact first |

### `Candidate`

Purpose: one shape for unit/listing/KB/anchor candidates before ranking.

```python
{
  "identity": {
    "item_id": str,
    "model_id": str | None,
    "unit_id": str | None,
  },
  "shop": str,
  "name": str,
  "product_type": str | None,
  "subtype": str | None,
  "source": "anchor|unit|legacy|kb|compat|exact_model",
  "match_reason": "item_tag|order_item|code|type|vector|regex|history|kb|compat_requery",
  "availability": {
    "catalog_status": "active|out_of_stock|unlisted|discontinued|removed|restricted|reviewing|unknown",
    "available_for_sale": bool,
    "stock": int,
    "reason": str,
  },
  "evidence": {
    "name": str,
    "description": str,
    "image_text": str,
    "warranty_text": str,
    "canonical_specs": dict,
    "compat": dict,
  },
  "score_parts": dict,
  "raw": dict,
}
```

## Availability Policy

Plan 1's `resolve_availability()` should be the only availability owner.

Policy:

- `active`: `item_status == NORMAL` and selected listing/model stock > 0
- `out_of_stock`: `item_status == NORMAL` and selected stock == 0
- `unlisted/discontinued/removed/restricted/reviewing`: derived from raw item/model status only when values exist
- `unknown`: status not mapped; log once, do not assume unlisted

Important rule:

Availability decides "can recommend/sell", not "can answer". A product can be unavailable but still valid context for spec, warranty, and history.

## Identity Policy

Use ids, not names, for selection decisions.

- Listing identity: `item_id`
- Unit identity: `item_id + model_id` when `model_id` exists
- Text model identity: bounded model-token match, never raw substring for alpha+digit codes
- Compare identity: preserve at least the two compared identities even if dedupe would normally collapse them
- Display name can be used for customer text only, not as primary identity

The current uncommitted `_model_token_in_name()` direction is correct and should be reused as the identity primitive.

## Ranking Profiles

One final selector ranks candidates after all sources return.

### Recommend / Search

Priority:

1. shop exact match
2. product type/subtype exact match
3. available for sale
4. exact code/name match
5. promotion/recency only after correctness
6. diversity per listing

Unavailable candidates are allowed only as fallback context, not sales recommendations.

### Spec / Warranty / History

Priority:

1. exact item/model/order/history anchor
2. exact model code
3. shop match
4. evidence richness
5. availability as information, not as filter

This profile must retrieve discontinued products.

### Compatibility

Priority:

1. product type customer asked for
2. device compatibility evidence
3. connector/protocol/wattage evidence
4. availability
5. price/promo/recency

Compatibility must not be inferred from product name alone when structured evidence is missing. If evidence is insufficient, context should tell LLM to say that directly.

### Compare

Priority:

1. preserve explicit compared identities
2. preserve latest anchor/suggestion pair
3. enough spec fields to compare
4. do not dedupe away variants under comparison
5. availability shown as fact, not primary rank

### Superlative

Priority:

1. candidates with measurable field for the asked dimension
2. exact type/subtype
3. availability
4. score by the measurable field

If no measurable field exists, answer should be grounded as "ข้อมูลไม่พอ" rather than letting LLM invent.

## Unit And Legacy Roles

Unit path should not be a separate early-return pipeline forever.

Target role:

- `units.py` reads unit documents and converts them to normalized candidate facts.
- `product_store.py` reads listing documents and converts them to normalized candidate facts.
- `product_store.fetch_products()` can remain the public API during migration, but internally it should call one selector.
- `to_unit_card()` and `to_product_card()` should become card conversion from selected candidates, not the place where ranking truth is created.

Short-term, do not remove legacy. Legacy remains the broad fallback and compatibility sweep until unit candidate coverage is proven by metrics.

## Hardcode Reduction Strategy

Do not try to remove all rules. Remove scattered runtime rules.

Keep hard rules where they represent catalog truth:

- stock/status availability
- exact model code boundary
- connector incompatibility
- warranty claim handoff policy
- unsupported evidence -> no hallucination

Move these away from `app.py`:

- subtype carry/override rules
- availability recompute
- per-listing diversity
- ranking order
- context notes derived from availability

Replace charger-only branches with profile fields:

```text
charger adapter/cable/set/car_charger
case/screen_protector model_fit
earphone/speaker self_compat
powerbank/charger charging
```

The goal is not generic AI magic. The goal is one declared rule table and one selector, not dozens of emergency branches.

## Measurement Gates

Nothing runtime-heavy should merge without these:

1. Offline evaluator from Plan 1 passes.
2. Human-reviewed gold set passes validation.
3. Baseline is recorded before code changes.
4. Each phase reports metrics by intent, not only aggregate.
5. No phase can improve recommend while breaking exact-model/warranty/history.

Minimum metrics:

- type purity by intent
- acceptable hit rate
- must-not violation rate
- status accuracy
- listing diversity
- live ratio top 5
- adequacy at 1 for compatibility
- answer mode accuracy

## Migration Plan At A Glance

```text
Phase 0: finish Plan 1 measurement/gold/availability/diversity
Phase 1: introduce RetrievalProfile read-only telemetry
Phase 2: introduce Candidate normalization beside existing cards
Phase 3: selector ranks candidates but output kept equivalent where possible
Phase 4: convert unit path from early return to candidate source
Phase 5: convert compat re-query to candidate source
Phase 6: move context-note construction out of app.py
Phase 7: remove duplicated ranking/subtype/availability branches
```

## Code Size And Comment Policy

- `app.py` should only orchestrate route, retrieval, answer, and guard calls. Do not add new ranking, availability, subtype, or unit fallback branches there unless they are temporary telemetry.
- Every new retrieval helper must have an owner and a deletion target: it should replace duplicated legacy/unit logic, not sit beside it forever.
- Feature flags must be removed after replay gates pass.
- Track LOC before and after the cleanup phase for `app.py`, `product_store.py`, `units.py`, and `device_compat.py`.
- Code comments should be short maintenance notes: purpose, inputs, output, key calls, and fallback. Keep history and phase notes in waythrough logs or plan docs, not runtime code.
- The agent must not commit without explicit user approval after presenting changed files and verification results.

## Non-Goals

- No v2/v3 fixes.
- No new vector database.
- No new LLM prompt rewrite as a substitute for retrieval correctness.
- No hard cutover from legacy to unit.
- No DB schema migration required for the first pass.
- No attempt to perfectly classify all 105 product types before measurement proves the need.

## Open Risks

- Unit documents may still lack reliable `product_type/subtype` for some shops.
- Gold labels need human review; bad gold is worse than no gold.
- Compatibility evidence still depends partly on curated device specs and web extraction.
- Refactoring `app.py` too early can break passed cases. The first phases should be additive telemetry, not behavior changes.
- Some current uncommitted changes affect identity matching; implementation must preserve them or consciously supersede them.

## Self-Review

Checked against user goals:

- 65 shops and mixed product types: covered by profile + metrics by intent/shop.
- Variant/unit/stock/unlisted/discontinued: covered by Candidate identity and availability policy.
- Compare/spec/compat/warranty/history: covered by ranking profiles.
- No hallucinated spec/warranty/compat: covered by evidence requirement and context builder direction.
- Reduce runtime hardcode: covered by route/profile/selector ownership.
- Legacy-only: explicit scope.

Chosen shape after rejecting direct unit replacement, more guards, and app.py merge. The smallest useful architecture is not a full rewrite; it is a measured selector layer added after Plan 1.
