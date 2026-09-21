# Legacy Retrieval Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task unless the user explicitly chooses subagent-driven execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered legacy/unit product selection decisions with a measured, profile-driven candidate selector for the legacy Shopee chatbot.

**Architecture:** Finish Plan 1 first, then add a small selector layer inside `chatbot/shopeechat` without changing public `/chat` behavior all at once. Unit and legacy retrieval become candidate sources; one profile/ranker decides final context.

**Tech Stack:** Python 3, existing MongoDB collections, existing `docs/test` assert-style scripts, no new runtime dependency.

**Spec:** `docs/plans/2026-09-21-legacy-retrieval-redesign.md`

## Global Constraints

- Legacy Shopee only: ignore `chat_v2` and `chatbotv3`.
- Do not read `.env`; use existing config loading patterns only.
- Do not revert existing uncommitted changes.
- No behavior-changing runtime refactor before Plan 1 Task 1-2 baseline and human-reviewed gold set.
- Every product-code change updates `docs/SRS_SSD.md` section 6 and `getoutofmywaybotkaikrook2.md`.
- Every behavior change has a focused assert-style test or replay gate.
- Keep current public `ChatResponse.products` card shape until the selector is proven.
- Prefer deleting duplicated runtime logic over adding new branches.
- Do not commit at the end of any phase without explicit user approval. Summarize changed files, diff intent, and verification first.
- Keep `app.py` as orchestration only: add one narrow callsite per phase, then move duplicated selection logic out or delete it.
- New comments/docstrings must stay short: purpose, inputs, output, key calls, and fallback only.

## Review Focus

- Exact model identity: `PB100` must not match `LPB100`, `PB100S`, or `PB1000`.
- Unavailable exact model: discontinued/sold-out products must still answer spec/warranty/history.
- Recommendation: unavailable products must not be sold or linked as available.
- Compare: two compared products/variants must not collapse into one through dedupe.
- Compatibility: answer must not claim support without connector/watt/model-fit evidence.

---

## Phase 0: Finish Plan 1 Before Runtime Refactor

**Files:**
- Follow: `docs/plans/2026-09-21-plan1-measurement-availability-identity.md`
- Existing data: `docs/test/results/unit_reg_questions_2026-09-18.jsonl`

**Interfaces:**
- Produces offline retrieval metrics and gold validation.
- Produces single `resolve_availability()` owner.
- Produces first per-listing diversity cap.

- [ ] **Step 1: Confirm current workspace**

Run:

```bash
git status --short
```

Expected: note any uncommitted files. Do not revert them.

- [ ] **Step 2: Complete Plan 1 Task 1**

Implement exactly the offline evaluator and baseline from `docs/plans/2026-09-21-plan1-measurement-availability-identity.md`.

Run:

```bash
.venv/bin/python docs/test/test_eval_retrieval.py
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl
```

Expected: evaluator tests pass and baseline numbers are saved.

- [ ] **Step 3: Complete Plan 1 Task 2**

Create `docs/test/gold_retrieval.jsonl` with at least 40 human-reviewable cases.

Run:

```bash
.venv/bin/python docs/test/test_eval_retrieval.py
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl --gold docs/test/gold_retrieval.jsonl --by-intent
```

Expected: gold validator returns no errors. Stop for human review before Plan 1 Task 3.

- [ ] **Step 4: Finish Plan 1 Tasks 3-6 only after gold approval**

Implement availability resolver, callsite wiring, listing diversity, and replay gate from Plan 1.

Expected: no runtime redesign starts until this phase is complete.

---

## Phase 1: Retrieval Profile Telemetry

**Files:**
- Create: `chatbot/shopeechat/retrieval_profile.py`
- Test: `docs/test/test_retrieval_profile.py`
- Modify later: `chatbot/shopeechat/app.py` only to call and log profile, not to change retrieval behavior
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces: `build_retrieval_profile(message: str, route, intent_result: dict | None, state: dict | None) -> dict`
- Consumes: `route_context.RouteContext`, existing intent dict, state summary from `conversation_products`

- [ ] **Step 1: Write failing tests**

Create `docs/test/test_retrieval_profile.py` with cases:

```python
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context
from shopeechat.retrieval_profile import build_retrieval_profile


def _p(msg: str, intent: dict | None = None, state: dict | None = None) -> dict:
    return build_retrieval_profile(msg, route_context.resolve_route(msg, intent), intent or {}, state or {})


def main() -> int:
    rec = _p("มีหัวชาร์จไหม", {"intent": "product_recommend", "product_type": "charger", "charger_subtype": "adapter", "confidence": 0.9})
    assert rec["intent"] == "recommend"
    assert rec["allow_unavailable"] is False
    assert rec["prefer_unit"] is True
    assert rec["max_per_listing"] == 1
    assert rec["ranking_mode"] == "sellable_first"

    spec = _p("PB100 รับประกันกี่ปี", {"intent": "product_spec", "confidence": 0.9})
    assert spec["intent"] in ("spec", "warranty", "exact_model")
    assert spec["allow_unavailable"] is True
    assert spec["ranking_mode"] == "exact_first"

    comp = _p("ใช้กับ iPhone 15 ได้ไหม", {"intent": "compatibility_check", "product_type": "charger", "target_device": "iPhone 15", "confidence": 0.9})
    assert comp["intent"] == "compatibility"
    assert comp["require_compat_evidence"] is True
    assert comp["ranking_mode"] == "compat_first"

    cmp_p = _p("ตัวนี้กับตัวก่อนต่างกันยังไง", {"intent": "product_spec", "confidence": 0.8}, {"has_compare_pair": True})
    assert cmp_p["intent"] == "compare"
    assert cmp_p["preserve_variants"] is True
    assert cmp_p["ranking_mode"] == "compare_diverse"

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Run tests and see failure**

```bash
.venv/bin/python docs/test/test_retrieval_profile.py
```

Expected: import failure because `retrieval_profile.py` does not exist.

- [ ] **Step 3: Implement minimal profile builder**

Create `chatbot/shopeechat/retrieval_profile.py`.

Implementation rules:
- no Mongo calls
- no LLM calls
- derive profile from route + intent + state only
- keep output as plain dict for now

- [ ] **Step 4: Run tests**

```bash
.venv/bin/python docs/test/test_retrieval_profile.py
python -m py_compile chatbot/shopeechat/retrieval_profile.py
```

Expected: pass.

- [ ] **Step 5: Add read-only telemetry in legacy `app.py`**

At the point after intent classification and state/context resolution, call `build_retrieval_profile(...)` and put the result into `routing_decision` or `steps` for observability.

Constraint: do not change retrieval behavior in this phase.

- [ ] **Step 6: Run focused checks**

```bash
python -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/retrieval_profile.py
.venv/bin/python docs/test/test_retrieval_profile.py
```

Expected: pass.

---

## Phase 2: Candidate Contract And Normalizers

**Files:**
- Create: `chatbot/shopeechat/retrieval_candidates.py`
- Test: `docs/test/test_retrieval_candidates.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces: `candidate_from_product_card(card: dict, *, source: str, match_reason: str) -> dict`
- Produces: `candidate_from_unit_card(card: dict, *, source: str, match_reason: str) -> dict`
- Produces: `candidate_identity(candidate: dict) -> tuple[str, str | None]`
- Consumes: existing card shapes from `to_product_card()` and `to_unit_card()`

- [ ] **Step 1: Write failing tests**

Test cases:
- listing card identity is `(item_id, None)`
- unit card identity is `(item_id, model_id)`
- availability fields are copied, not recomputed ad hoc
- evidence fields include description/image_text/warranty_text/canonical_specs when present

- [ ] **Step 2: Implement candidate normalizers**

Keep this additive. Do not change `fetch_products()` return yet.

- [ ] **Step 3: Add source wrappers**

Add internal helpers:

```python
_cards_to_candidates(cards: list[dict], source: str, match_reason: str) -> list[dict]
```

Use them only in tests/telemetry first.

- [ ] **Step 4: Verify**

```bash
.venv/bin/python docs/test/test_retrieval_candidates.py
python -m py_compile chatbot/shopeechat/retrieval_candidates.py chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py
```

Expected: pass.

---

## Phase 3: Selector And Ranking Profiles

**Files:**
- Create: `chatbot/shopeechat/retrieval_selector.py`
- Test: `docs/test/test_retrieval_selector.py`
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces: `select_candidates(candidates: list[dict], profile: dict, limit: int) -> list[dict]`
- Consumes: Candidate dicts and RetrievalProfile dicts

- [ ] **Step 1: Write failing selector tests**

Minimum tests:
- recommend ranks sellable over unavailable
- exact_model keeps unavailable exact product
- compare preserves two identities
- max_per_listing caps variants for recommend but not exact code
- compatibility requires `evidence.compat.supported is True` when `require_compat_evidence=True`

- [ ] **Step 2: Implement smallest selector**

Implement score tuple functions by `profile["ranking_mode"]`.

Do not call Mongo, LLM, embeddings, or product type detectors here.

- [ ] **Step 3: Verify**

```bash
.venv/bin/python docs/test/test_retrieval_selector.py
python -m py_compile chatbot/shopeechat/retrieval_selector.py
```

Expected: pass.

---

## Phase 4: Unit Path Becomes Candidate Source

**Files:**
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Test: `docs/test/test_unit_candidate_source.py`
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces: `units.fetch_unit_candidates(...) -> list[dict]`
- Keeps: `units.fetch_unit_cards(...)` for backward compatibility during migration

- [ ] **Step 1: Add tests that compare card and candidate identity**

Use fixture dicts; no Mongo required.

- [ ] **Step 2: Implement `fetch_unit_candidates` as wrapper**

Initially:

```text
fetch_units -> attach_* -> to_unit_card -> candidate_from_unit_card
```

No behavior change yet.

- [ ] **Step 3: Wire telemetry only**

In `product_store.fetch_products`, when unit path returns cards, also compute candidate summary for logs/steps. Do not change returned cards yet.

- [ ] **Step 4: Verify with Plan 1 evaluator**

Run offline metrics on the same baseline. Expected: no runtime output change.

---

## Phase 5: Legacy Listing Source Becomes Candidate Source

**Files:**
- Modify: `chatbot/shopeechat/product_store.py`
- Test: `docs/test/test_legacy_candidate_source.py`
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces: internal `_legacy_docs_to_candidates(docs: list[dict], message: str, source: str) -> list[dict]`

- [ ] **Step 1: Test listing identity and availability preservation**

Use product doc fixtures that cover:
- active stock > 0
- active stock 0
- non-NORMAL item
- multi-model where one model has stock

- [ ] **Step 2: Convert post-query docs to candidates in parallel with cards**

Do not remove existing card path yet.

- [ ] **Step 3: Compare selector output to current card output**

For simple recommend cases, selected candidate item_ids should match existing top cards or improve only in measured ways documented by gold metrics.

---

## Phase 6: Selector Controls Final Context For Low-Risk Intents

**Files:**
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/app.py`
- Test: Plan 1 evaluator + targeted tests
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

**Scope:** recommend/search only. Do not switch compatibility/compare/warranty yet.

- [ ] **Step 1: Add feature flag**

Use env flag:

```text
USE_RETRIEVAL_SELECTOR=0|recommend
```

Default off.

- [ ] **Step 2: When flag is `recommend`, use selector output for recommend/search contexts**

Keep fallback to current path on exception.

- [ ] **Step 3: Run offline metrics**

```bash
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl --gold docs/test/gold_retrieval.jsonl --by-intent
```

Expected:
- recommend type purity not worse
- live ratio top5 improves or not worse
- must-not violation rate not worse

- [ ] **Step 4: Run known regression tests**

```bash
python -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/product_store.py
.venv/bin/python docs/test/test_eval_retrieval.py
```

Add any existing project tests that touch product selection.

---

## Phase 7: Compatibility Selector

**Files:**
- Modify: `chatbot/shopeechat/device_compat.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Test: `docs/test/test_compat_candidate_selector.py`
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

**Goal:** stop charger-specific re-query from overriding the product type the customer asked for.

- [ ] **Step 1: Test compatibility evidence requirement**

Cases:
- powerbank + MacBook stays powerbank
- car charger + S25 stays car_charger
- earphone + iPhone uses self_compat and does not require wattage
- screen protector/case uses model_fit and does not return phones

- [ ] **Step 2: Convert `_device_spec_lookup` additions to candidates**

Keep current DB re-query but normalize additions as candidates with `source="compat"`.

- [ ] **Step 3: Use selector for compatibility profile under flag**

Use:

```text
USE_RETRIEVAL_SELECTOR=compat
```

- [ ] **Step 4: Verify**

Run compatibility-focused regression files and gold metrics by intent.

---

## Phase 8: Compare / Spec / Warranty Selector

**Files:**
- Modify: `chatbot/shopeechat/app.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/conversation_products.py` only if state summary helper is needed
- Test: `docs/test/test_compare_candidate_selector.py`
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

- [ ] **Step 1: Add state summary helper**

Create a small helper that returns:

```python
{
  "active_product": ...,
  "latest_suggestions": [...],
  "compare_pair": [...],
  "has_compare_pair": bool,
}
```

Do not change timeline schema.

- [ ] **Step 2: Test compare preservation**

The selector must keep both current and previous anchors even if dedupe base names collide.

- [ ] **Step 3: Test unavailable exact model**

Exact model spec/warranty keeps unavailable candidates and does not replace them with sellable alternatives unless user asks to buy.

---

## Phase 9: Remove Duplicate Runtime Logic

**Files:**
- Modify: `chatbot/shopeechat/app.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/device_compat.py`
- Docs: `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md`

Only after selector is active and replay gates pass.

Deletion candidates:
- unit early-return ranking/fallback that duplicates selector
- app.py availability recompute after Plan 1 resolver is wired
- charger subtype carry logic duplicated outside `route_context`/profile
- name-based dedupe where id-based candidate identity is available
- compatibility watt/sort branches that selector owns

- [ ] **Step 1: Delete one duplicate branch at a time**

One deletion per user-approved commit candidate. Run focused tests and offline metrics after each deletion before asking to commit.

- [ ] **Step 2: Track LOC**

Record LOC for:

```bash
wc -l chatbot/shopeechat/app.py chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/device_compat.py
```

Expected: total logic should decrease by the end of this phase.

---

## Phase 10: Release Gate

**Files:**
- Results under `docs/test/results/`
- Docs update in `getoutofmywaybotkaikrook2.md`

- [ ] **Step 1: Offline gate**

Run evaluator by intent and compare to baseline.

Pass criteria:
- `must_not_violation_rate` decreases or stays zero
- `status_accuracy` improves or stays >= baseline
- `listing_diversity` improves for recommend/unit-heavy topics
- compatibility `adequacy_at_1` improves or stays stable
- exact-model/warranty/history no regressions in gold

- [ ] **Step 2: LLM gate**

Run a small live-LLM set only after offline pass.

Include:
- exact discontinued model spec
- sold-out model warranty
- recommend across mixed shop
- compare two anchors
- powerbank MacBook compatibility
- car charger compatibility
- non-charging compatibility

- [ ] **Step 3: Shadow/replay gate**

Use shadow/replay with `conversation_id` namespaced as already fixed. Confirm no write to real conversation state.

- [ ] **Step 4: Document results**

Move active log entry to passed only after verification. Do not claim complete if only design/plan is done.

## Self-Review

Spec coverage:
- Measurement-first: Phase 0.
- Availability/identity: Plan 1 + Candidate contract.
- Unit+legacy convergence: Phases 4-6.
- Compatibility: Phase 7.
- Compare/spec/warranty/history: Phase 8.
- Hardcode reduction: Phase 9.
- Release safety: Phase 10.

Red-flag scan:
- No unresolved markers.
- Each phase has concrete files and checks.

YAGNI check:
- No new DB schema.
- No new dependency.
- No rewrite of `/chat`.
- Feature-flagged behavior changes.
- Existing card shape preserved until selector proves itself.
- Every new helper must replace an old branch by the next cleanup phase, or be removed.
- Comments stay as maintenance notes, not history logs.

Main risk:
- Phase 6+ can still be large if attempted in one pass. Keep one intent/profile per user-approved commit candidate.
