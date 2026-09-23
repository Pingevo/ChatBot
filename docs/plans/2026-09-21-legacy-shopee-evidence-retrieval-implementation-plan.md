# Legacy Shopee Evidence Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make legacy Shopee product retrieval evidence-first so the bot selects the right product/unit, refuses to invent spec/warranty/compatibility, and remains easy to debug without bloating `app.py`.

**Architecture:** Keep the current data sources, but resolve one immutable request profile before any ranked product lookup, retrieve a bounded candidate set from the sources relevant to that profile, refresh availability from full live listing data, and then apply one evidence/selection contract before LLM context shaping. Do not load thousands of products and do not rewrite the bot. Every behavior-changing phase starts in measurement or observe mode and crosses a replay gate before enforcement.

**Tech Stack:** Python 3, FastAPI legacy Shopee runtime, MongoDB read-only product/order/stock data, existing local `.npz` embeddings, stdlib tests in `docs/test/`, existing `py_compile` verification.

**Spec:** This plan implements the current audit from 2026-09-21 plus `docs/plans/2026-09-21-plan1-measurement-availability-identity.md` and supersedes the high-level direction in `docs/plans/2026-09-21-legacy-retrieval-redesign-rev2-current-flow.md`.

## Global Constraints

- Scope is legacy Shopee chatbot only. Do not change `chat_v2` or `chatbotv3`.
- Do not read `.env` directly. Scripts that need DB access must call `load_dotenv(ROOT / ".env")` and must not print secrets.
- Product DB `dbWallet.ShpProducts`, order DB `ShpOrders`, and stock DB `itStock.Products` are read-only.
- Do not change prompt text as a substitute for retrieval correctness.
- Do not add runtime hardcode for one product family to fix one case. Product-family rules must live in route/taxonomy helpers or test data.
- Keep current `ChatResponse.products` shape.
- Keep `product_store.fetch_products()` as the main source gateway during this plan.
- Candidate retrieval is bounded per source. Never load a whole shop/catalog into Python merely to dedupe or rank it.
- Normalize Shopee `item_id`/`model_id` at boundaries because `ShpProducts` and `ShpOrders` store many IDs as floats while admin collections store int/string values.
- Keep unit path bypass for `is_compat_check=True` until compatibility recall proves unit can replace legacy sweep.
- Exact unavailable products may be shown for spec, warranty, order history, and discontinued/unlisted questions.
- Shopping recommendation must not recommend unavailable products unless the answer explicitly says unavailable and uses it only as history/spec evidence.
- `guards.enforce()` must never pretend a handoff happened. If no deterministic flow set `handoff_to_admin=True`, guards may remove or rewrite fake handoff wording, but must not mark a real handoff.
- `old admin first` is a preference, not a hard gate. Human assignment must pass eligibility checks before a handoff is treated as owned by an admin.
- Workflow/trigger logic must respect active human handoff state. It may perform deterministic actions before LLM only when doing so cannot answer over an accepted human owner or fake a handoff.
- Every runtime task that changes `chatbot/shopeechat/` must update `docs/SRS_SSD.md` section 6 and `getoutofmywaybotkaikrook2.md`.
- Before first commit for this work and before PR, summarize diff, test result, changed files, and ask the user.

## Review Focus

- **Unavailable exact model:** Customer asks about a discontinued/unlisted/out-of-stock model they bought before. Expected: answer spec/warranty/history from evidence, not recommend it as buyable.
- **Variant/unit stock:** Listing has many variants but only some have stock. Expected: pick the matching sellable unit, not the parent listing or a dead variant.
- **Sensitive policies:** Claim, warranty, refund, tax invoice, and human handoff. Expected: deterministic or evidence-backed response; if handoff is promised, `handoff_to_admin=True`.
- **Compatibility:** Customer asks whether an item works with an existing device. Expected: preserve requested shop/family/subtype/device across every source, answer only from compatible evidence, and never claim no product/all sold out while a sellable compatible candidate exists; say not enough info when evidence is missing.
- **Device shorthand/alias:** Customer writes compact or shorthand device names such as `mi14pro`, `ip14`, `i14 pro`, `iphone14 pro`, or Thai `ไอโฟน14โปร`. Expected: normalize to a canonical device before retrieval/profile/slot logic, while product codes such as `HA835`, `AD1203P`, and `CMC615` remain product model codes, not target devices.
- **Compare/spec:** Customer compares products or asks specs. Expected: include both compared products and quote only fields from `ShpProducts`, `kb_products`, `kb_qa`, `image_texts`, `ShpOrders`, or `itStock.Products`.
- **Old order identity:** An order item may no longer exist in the current catalog. Expected: preserve the order item as history/warranty evidence instead of dropping it because live product hydration misses.
- **Multi-product request:** Customer asks for more than one product with different brands/models/constraints in the same message. Expected: constraints remain attached to the correct product request; a charger brand must not filter smartwatch candidates, and charger subtype must not filter non-charger candidates.
- **Human ownership continuity:** A previous admin should be reused only when still eligible. Expected: if the previous owner is off-duty/not accepting/over capacity, the handoff is reassigned to an eligible admin or team queue instead of silently waiting.
- **Workflow trigger boundary:** Deterministic workflow actions should happen before LLM when appropriate, but must not answer over active human handoff or claim a handoff occurred without a real assignment/queue.

---

## Current Data Facts From Audit

These facts shape the plan and must be rechecked if the data is rebuilt. Counts below were read from the live read-only collections through `load_dotenv()` on 2026-09-22; no secret or customer value was printed.

| Source | Count / Coverage | Meaning |
|---|---:|---|
| `ShpProducts` | 11,693 listings | Main live Shopee product source; sampled `item_id`/`model_id` are floats |
| `ShpProducts.item_status=NORMAL` | 3,360 listings | Listing-level active set |
| `ShpProducts.model` with positive summary/seller availability | 7,873 units | Zero-vs-positive availability agrees in the audited data, but 62 quantities differ; `stock_info_v2.summary_info.total_available_stock` is the variant/model stock truth; fallback to `shopee_stock`/`seller_stock` only when `summary_info.total_available_stock` is missing or unreadable, never when it is present and `0` |
| `sellable_units` | 27,843 units | Unit/variant index |
| `sellable_units.sellable=True` | 5,490 units | Snapshot of sellable unit candidates |
| `sellable_units.product_type=null` | 2,641 units | Classification gap that can cause wrong route/pool |
| `sellable_units → ShpProducts` | 27,843/27,843 item joins; 27,766/27,813 model joins | Item identity is complete after numeric normalization; 47 unit model references are stale/missing |
| `sellable_units.canonical_specs` | 0 stored docs | Unit specs are attached at runtime from `kb_products`; evidence provenance must be added after that join |
| `kb_products` | 1,011 docs | Canonical product/spec KB |
| `kb_products.canonical_specs` | 511 docs | Spec coverage is partial |
| `kb_products.item_ids` | 539 docs | Product link coverage is partial |
| `kb_qa` | 393 docs | FAQ/troubleshooting/policy QA |
| `image_texts` | 14,005 docs, 13,987 with text | OCR evidence source |
| `sellable_units.image_ids → image_texts` | 13,944/72,493 unique image ids (19.23%) | Missing OCR is unknown evidence, not proof that a product lacks a spec/warranty/certification |
| `ShpOrders` | 3,834,072 orders | Order/history/warranty source |
| `ShpOrders` current sample | 5,162/5,178 item refs join current catalog | Old order items can be absent from current `ShpProducts`; order evidence must remain independently answerable |
| `ShpOrders` tracking sample | top-level `tracking_no` present 4,172/5,000; package tracking fields 0/5,000 | Current `lookup_by_tracking()` searches the wrong location first and needs a regression task |
| `itStock.Products` | 8,853 docs; 4,988 `shopee_ship_box` refs | Stock/spec package source; all item refs and 4,975/4,977 model refs join after ID normalization |
| `kb_products.item_ids` / `kb_qa.item_ids` / `image_texts.item_ids` | 100% join after ID normalization | Raw string comparison gives false misses because product IDs are floats |
| `product_embeddings.npz` | 11,503 rows | Listing semantic search |
| `unit_embeddings.npz` | 27,807 rows | Unit semantic search |
| `qa_embeddings.npz` | 392 rows | QA semantic search |

## Target Runtime Flow

The final shape after this plan should be:

```text
app.py
  buffer/debounce input before bot processing
  load conversation state, bounded history, anchors, and assignment state
  enforce human handoff gate before bot answers
  run allowed deterministic workflow/trigger actions before retrieval/LLM
  resolve request state and route facts
  return early for order/claim/tax/human/general when deterministic
  build one retrieval_profile before the first product source retrieval
  pass that same immutable profile to every product source/re-query
  call retrieval_policy.select_context()
  call llm.answer()
  call guards.enforce()
  record suggestion state

product_store.py
  ShpProducts source, listing cards, vector/regex search
  fetch bounded unit and listing pools for eligible non-compat queries
  merge source pools without allowing one non-empty source to hide the other
  batch-refresh candidates from full live listing/model data
  shared resolve_availability()

units.py
  bounded unit source and variant identity
  no final LLM context policy

knowledge_base.py
  KB product/QA source and evidence text
  normalized item-id-first merge with product cards
  no product ranking owner

order_store.py / order_flow.py
  shop-scoped order and tracking evidence
  preserve old order items even when current catalog hydration misses

device_compat.py
  compatibility evidence and compatibility filter
  no final tier/context owner after migration

route_context.py
  single-product RetrievalProfile first
  multi-product RetrievalSlot list after Task 4E
  owns query understanding, not LLM calls

retrieval_policy.py
  protected product merge, availability-aware final selection,
  evidence coverage report, diversity, grouped final LLM product context

handoffs.py / workflow trigger layer
  deterministic handoff decisions, admin eligibility, and workflow state gates
```

`retrieval_policy.py` must not become a second `app.py`. Route facts stay in `route_context.py`, source evidence annotations stay in source modules, and sensitive handoff decisions stay in deterministic flows plus `guards.enforce()`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `docs/test/eval_retrieval.py` | create or finish from Plan 1 | Offline metrics for retrieval pool and gold set |
| `docs/test/gold_retrieval.jsonl` | create | Human-reviewed gold set |
| `docs/test/test_availability.py` | create | Unit tests for availability resolver |
| `docs/test/test_retrieval_profile.py` | create | Canonical message/history/intent/anchor reconciliation tests |
| `docs/test/test_retrieval_slots.py` | create in Task 4E | Multi-product request slot parsing and constraint ownership tests |
| `docs/test/test_device_alias_normalization.py` | create in Task 4F | Canonical device shorthand/alias tests for route/profile/slot inputs |
| `docs/test/test_retrieval_evidence.py` | create | Evidence card contract tests |
| `docs/test/test_candidate_availability_refresh.py` | create | Full live listing/model refresh and normalized ID tests |
| `docs/test/test_candidate_source_union.py` | create | Bounded unit/listing recall and diversity tests |
| `docs/test/test_retrieval_policy.py` | create | Ranking/diversity/protected merge tests |
| `docs/test/test_sensitive_flows.py` | create | Claim/warranty/refund/tax/handoff regression tests |
| `docs/test/test_handoff_assignment_policy.py` | create in Task 11A | Admin eligibility, old-owner continuity, queue fallback tests |
| `docs/test/test_workflow_trigger_audit.py` | create in Task 11B | Trigger ordering and handoff-gate regression tests |
| `chatbot/shopeechat/route_context.py` | modify | Sole owner of canonical `RetrievalProfile` from message/history/intent/anchors |
| `chatbot/shopeechat/product_store.py` | modify | `resolve_availability()`, listing card integration, source annotations |
| `chatbot/shopeechat/units.py` | modify | Use shared availability and profile, emit unit evidence fields |
| `chatbot/shopeechat/retrieval_policy.py` | create | Final context selection owner |
| `chatbot/shopeechat/app.py` | modify gradually | Replace local merge/rank/availability formulas with `retrieval_policy` calls |
| `chatbot/shopeechat/device_compat.py` | modify later | Return compatibility evidence fields, not final context policy |
| `chatbot/shopeechat/web_search.py` | modify later | Merge web reanswer candidates through policy instead of replacing context |
| `chatbot/shopeechat/handoffs.py` | modify in Task 11/11A | Real handoff boundary, assignment eligibility, and owner-state decisions |
| Workflow/bot-worker docs and runtime files | audit in Task 11B, modify only after approval | Trigger ordering, active human handoff gate, and no fake handoff promises |
| `docs/SRS_SSD.md` | modify with runtime changes | Function docs and call relationships |
| `getoutofmywaybotkaikrook2.md` | modify each task | Waythrough log |

## Interfaces To Introduce

The plan intentionally introduces only one new runtime module first. It has exactly one request-fact owner: `route_context`. `intent_classifier` proposes facts, but it never owns the final retrieval request; `retrieval_policy` consumes the resolved profile and must not rebuild it.

```python
# chatbot/shopeechat/product_store.py
def resolve_availability(card_or_doc: dict, *, model_doc: dict | None = None) -> dict:
    """Return normalized availability facts for listing or unit data."""

def normalize_shopee_id(value: object) -> str:
    """Return one stable key for float, int, and string Shopee IDs."""

def refresh_candidate_availability(
    db,
    products: list[dict],
    *,
    profile: RetrievalProfile,
) -> tuple[list[dict], dict]:
    """Refresh a bounded candidate pool from complete live listing/model data."""
```

```python
# chatbot/shopeechat/route_context.py
@dataclass(frozen=True)
class RetrievalProfile:
    platform: str
    shop: str | None
    message: str
    intent: str
    product_types: frozenset[str]
    subtype: str | None
    model_codes: tuple[str, ...]
    variant_terms: tuple[str, ...]
    target_device: str | None
    availability_mode: str
    compat_mode: str
    anchor_item_ids: tuple[str, ...]
    fact_sources: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class RetrievalSlot:
    slot_id: str
    source_span: str
    product_types: frozenset[str]
    subtypes: frozenset[str]
    primary_subtype: str | None
    brand_hints: tuple[str, ...]
    model_codes: tuple[str, ...]
    model_terms: tuple[str, ...]
    target_device: str | None
    target_scope: str
    availability_mode: str
    compat_mode: str
    confidence: float
    fact_sources: tuple[tuple[str, str], ...]


def build_retrieval_slots(profile: RetrievalProfile) -> tuple[RetrievalSlot, ...]:
    """Split a resolved profile into product-request slots without calling an LLM."""


def normalize_device_alias(value: str) -> str | None:
    """Return a canonical device name for known shorthand, or None when unsafe."""


def build_retrieval_profile(
    message: str,
    *,
    history: list[dict] | None,
    intent_result: dict | None,
    shop: str | None,
    platform: str = "shopee",
    anchor_cards: list[dict] | None = None,
) -> RetrievalProfile:
    """Resolve one canonical product-retrieval request from current turn and bounded context."""
```

```python
# chatbot/shopeechat/retrieval_policy.py
def make_evidence_card(card: dict, *, source: str, protected: bool = False,
                       evidence: dict | None = None) -> dict:
    """Wrap existing product card with evidence metadata without changing card shape."""

def select_context(products: list[dict], *, profile: RetrievalProfile,
                   protected_products: list[dict] | None = None,
                   limit: int = 30,
                   evidence_mode: str = "observe") -> tuple[list[dict], dict]:
    """Return selected product cards and debug report from an already-resolved profile."""
```

Ownership and data flow are strict:

1. `intent_classifier.classify_intent()` reads the current question plus its existing bounded four-message history and returns a probabilistic proposal: intent, product family, charger subtype, target device, connector, wattage, and confidence.
2. `route_context.build_retrieval_profile()` is the final deterministic reconciler. It combines the current message, the proposal, bounded history facts, active anchors, current shop, and platform exactly once per product turn.
3. `app.py` builds the profile after intent and anchor resolution, before the first broad product-candidate search. Deterministic exact hydration by explicit `item_id`/order anchor may happen earlier because it supplies the anchor input, but it is not a ranked candidate search. `app.py` passes the same profile object to every later product source and re-query in that turn.
4. `product_store`, `units`, `device_compat`, KB/Mongo candidate fetches, and `web_search.reanswer` may use only the fields relevant to them. They may change their local search string, but must not re-extract or overwrite the canonical shop/type/subtype/device/modes.
5. `retrieval_policy.select_context()` ranks and filters candidates using the profile. It does not infer intent, type, subtype, target device, or availability mode.

After Task 4E, one turn may contain multiple `RetrievalSlot` objects. A slot is a scoped product request, not another intent. For example, “หัวชาร์จ CukTech กับนาฬิกา Xiaomi Mi Watch 8 ใช้กับ Mi 17 Ultra” becomes a charger slot with adapter/CukTech constraints and a smartwatch slot with Xiaomi/Mi Watch constraints. Shared target devices must be marked with `target_scope="shared"` and still require compatibility evidence before a positive claim. Do not solve this by adding case-specific rules for Mi, CukTech, Xiaomi, charger, or smartwatch.

Task 4F owns canonical device aliases before slots are wired into retrieval. Device shorthand normalization must happen in `device_compat` and be consumed by `route_context`; it must not be implemented as one-off checks in `app.py`, `product_store`, or prompt text. Compact customer terms such as `mi14pro`, `ip14`, `i14 pro`, `iphone14 pro`, and `ไอโฟน14โปร` may become target devices only when the pattern is a recognized device family. Alphanumeric product model codes remain model codes.

Task 4G hardens the remaining root cause in Task 4E: relation ownership is still implicit in span heuristics. The long-term owner should be a small deterministic mention/relation extractor inside `route_context`, not more slot-specific `if phone/watch/xiaomi` conditions. Ambiguous phrases such as `หัวชาร์จกับ Mi Watch 8` must remain low-confidence or broad until the wording proves whether `Mi Watch 8` is a second product or a target device.

Important rule: `select_context()` returns normal product cards, not a new response shape. Private `_evidence` and `_selection_reason` metadata must be stripped from `ChatResponse.products` after internal selection/answering and before response serialization.

### Canonical answer to “who extracts these fields?”

For this input:

```text
shop = current shop
product_types = {"charger"}
subtype = "cable"
target_device = "iPhone 13"
availability_mode = "sellable_first"
compat_mode = "connector_required"
```

- `shop` comes only from `ChatRequest.shop`; history and the LLM may not change it.
- `product_types` and `subtype` are resolved by `route_context` from explicit current-message taxonomy first, then a compatible active anchor, then a high-confidence intent proposal, then bounded recent-history carry-forward for an elliptical follow-up.
- `target_device` is resolved from an explicit device in the current message first, then the intent proposal for the current turn, then the newest bounded history device only when the current message is a compatibility follow-up and no topic switch is detected.
- `availability_mode` is derived by `route_context` from the answer mode: shopping/recommendation/compatibility → `sellable_first`; explicit “พร้อมส่งเท่านั้น” → `sellable_only`; spec/warranty/compare about a named item → `answerable_all`; order/history anchor → `exact_history`.
- `compat_mode` is deterministic from the resolved product family/subtype plus target device: cable → `connector_required`; adapter/powerbank/car charger → `power_required`; Bluetooth audio/wearable → `bluetooth_general`; no target device → `none`.

Canonical taxonomy uses `product_types={"charger"}` plus `subtype="cable"`; it does not put the ambiguous string `"cable/charger"` in one field. This matches the current parent-family/subtype model and prevents different sources from interpreting the slash differently.

### Does every retrieval receive the same values?

Yes for every **legacy product-candidate retrieval** in the turn: main `fetch_products`, unit gateway, KB/Mongo product merge, compatibility re-query, alternative/fallback product fetch, and web-search DB re-query. All receive the same immutable `RetrievalProfile`. A generated search query may differ by source, but the profile does not.

No profile is needed for deterministic non-product paths such as order lookup, tracking, claim-state collection, tax invoice, human handoff, or pure policy QA that returns before product retrieval. `chat_v2` and `chatbotv3` are outside this plan.

---

## Task 1: Finish Measurement And Human Gold Gate

**Current workspace checkpoint (verified 2026-09-22):** evaluator, drafter, validator, review UI, and 67 approved rows exist; their 13 unit tests pass and the validator is clean. This task is not complete as a release gate: the approved set has 0 history rows, 0 `must_not_phrases`, no Mi 17 row, only 4 compare rows, 3 warranty rows, 1 unlisted row, and no explicit refund/tax/real-handoff coverage. Do not start runtime enforcement until these gaps are closed.

**Files:**
- Create or finish: `docs/test/eval_retrieval.py`
- Create or finish: `docs/test/test_eval_retrieval.py`
- Create: `docs/test/gold_retrieval.jsonl`
- Create: `docs/test/draft_gold_retrieval.py`
- Create: `docs/test/validate_gold_retrieval.py`

**Interfaces:**
- Produces `gold_retrieval.jsonl` records with the existing required keys plus optional context assertions shown below. `history`, `must_not_phrases`, `expected_subtype`, and `expected_target_device` are optional so existing rows remain valid:

```json
{
  "id": "stable-case-id",
  "shop": "shop name",
  "message": "customer message",
  "history": [],
  "intent": "recommend|exact_model|spec|compare|compatibility|warranty|claim|refund|tax_invoice|handoff|order",
  "expected_answer_mode": "products|recommend|no_such_type|no_info|out_of_stock|discontinued|handoff|policy",
  "acceptable_item_ids": [],
  "must_not_item_ids": [],
  "must_not_phrases": [],
  "expected_product_type": "",
  "expected_subtype": "",
  "expected_target_device": "",
  "expected_catalog_status": "",
  "requires_evidence": ["spec", "warranty", "compatibility"]
}
```

- Consumes current replay result files:
  - `docs/test/results/unit_reg_questions_2026-09-18.jsonl`
  - `docs/test/results/test_200_selected100.json`

- [x] **Step 1: Write validator tests**

Create `docs/test/test_validate_gold_retrieval.py`:

```python
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from validate_gold_retrieval import validate_rows


def test_valid_gold_row_passes():
    rows = [{
        "id": "compat-powerbank-macbook-001",
        "shop": "CukTech",
        "message": "พาวเวอร์แบงค์ใช้กับ macbook air ได้ไหม",
        "intent": "compatibility",
        "expected_answer_mode": "recommend",
        "acceptable_item_ids": [123],
        "must_not_item_ids": [456],
        "expected_product_type": "powerbank",
        "expected_catalog_status": "active",
        "requires_evidence": ["compatibility"],
    }]
    assert validate_rows(rows) == []


def test_no_info_cannot_require_min_power():
    rows = [{
        "id": "bad-001",
        "shop": "Any",
        "message": "มีสายรุ่นนี้ไหม",
        "intent": "compatibility",
        "expected_answer_mode": "no_info",
        "acceptable_item_ids": [],
        "must_not_item_ids": [],
        "expected_product_type": "cable",
        "expected_catalog_status": "",
        "requires_evidence": ["compatibility"],
        "min_output_power_w": 60,
    }]
    errors = validate_rows(rows)
    assert errors and "min_output_power_w" in errors[0]
```

- [x] **Step 2: Verify validator tests**

Run:

```bash
.venv/bin/python -m pytest docs/test/test_validate_gold_retrieval.py -v
```

Verified: the measurement-tool suite passes 13/13 in the current workspace.

- [x] **Step 3: Implement validator, drafter, evaluator, and review UI**

Create `docs/test/validate_gold_retrieval.py`:

```python
from __future__ import annotations

import json
import sys
from pathlib import Path

REQUIRED = {
    "id", "shop", "message", "intent", "expected_answer_mode",
    "acceptable_item_ids", "must_not_item_ids", "expected_product_type",
    "expected_catalog_status", "requires_evidence",
}

NO_PRODUCT_MODES = {"no_such_type", "no_info"}


def validate_rows(rows: list[dict]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for i, row in enumerate(rows, 1):
        rid = str(row.get("id") or "")
        missing = sorted(REQUIRED - set(row))
        if missing:
            errors.append(f"row {i} missing {missing}")
        if rid in seen:
            errors.append(f"row {i} duplicate id {rid}")
        seen.add(rid)
        if row.get("expected_answer_mode") in NO_PRODUCT_MODES and row.get("min_output_power_w"):
            errors.append(f"row {i} has min_output_power_w but expected_answer_mode={row.get('expected_answer_mode')}")
        for key in ("acceptable_item_ids", "must_not_item_ids", "requires_evidence"):
            if not isinstance(row.get(key), list):
                errors.append(f"row {i} {key} must be list")
        for key in ("history", "must_not_phrases"):
            if key in row and not isinstance(row[key], list):
                errors.append(f"row {i} {key} must be list")
    return errors


def load_jsonl(path: str) -> list[dict]:
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: validate_gold_retrieval.py docs/test/gold_retrieval.jsonl", file=sys.stderr)
        return 2
    errors = validate_rows(load_jsonl(argv[1]))
    for err in errors:
        print(err)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
```

- [ ] **Step 4: Close semantic coverage gaps in the reviewed gold set**

Keep the 67 approved rows, then add only the missing human-reviewed cases. Use corrected rejected rows where available and draft new rows from existing replay data before asking for review. Do not count a row toward a category unless its expected fields actually test that category.

| Intent | Minimum rows |
|---|---:|
| recommendation by type | 8 |
| exact model active | 6 |
| exact model out-of-stock/unlisted/discontinued | 8 |
| variant/unit stock | 8 |
| compare | 6 |
| spec | 6 |
| compatibility charging | 8 |
| compatibility non-charging | 6 |
| warranty/history/order | 6 |
| claim/refund/tax/handoff | 8 |

Additional hard requirements before runtime work:
- At least 8 rows contain bounded `history`, including Mi 17 Ultra cable carry, a topic switch, a compare follow-up, and an old-order follow-up.
- Add the corrected Mi 17 Ultra row to approved gold or a committed standalone acceptance file; it may not remain only in a rejected browser export.
- Add `must_not_phrases` to every negative compatibility/stock/handoff case.
- Include at least 3 explicit out-of-stock, 3 unlisted/discontinued, 3 refund, 3 tax-invoice, and 3 real-handoff rows.
- Include one old order item whose `item_id` is absent from current `ShpProducts`; expected evidence is `ShpOrders`, not a live product card.
- For a product/recommend answer, require at least one acceptable item/unit id unless the mode explicitly permits a text-only clarification.
- For compatibility rows, require `expected_target_device`, expected family/subtype when known, and `requires_evidence=["compatibility"]`.

Extend `validate_rows()` with allowed enums and the semantic checks above. Keep retrieval rows and deterministic sensitive-flow rows in the same JSONL only if the evaluator reports them separately; never average handoff/policy rows into product hit-rate metrics.

Implement `draft_gold_retrieval.py` to read both replay result shapes, dedupe by normalized `(shop, message)`, map only fields present in the source, and emit deterministic JSONL ordered by intent then stable case id. Run it before human review:

```bash
.venv/bin/python docs/test/draft_gold_retrieval.py \
  docs/test/results/unit_reg_questions_2026-09-18.jsonl \
  docs/test/results/test_200_selected100.json \
  > docs/test/gold_retrieval.draft.jsonl
```

The approved file is copied to `docs/test/gold_retrieval.jsonl` only after human review.

- [ ] **Step 5: Re-run validator and freeze baseline by intent and answer mode**

Run:

```bash
.venv/bin/python docs/test/validate_gold_retrieval.py docs/test/gold_retrieval.jsonl
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl --gold docs/test/gold_retrieval.jsonl --by-intent
```

Expected: validator passes. Save the current baseline (`n=300`, `live_ratio_top5=0.818`, `fallback_rate=0.050`, `avg_pool=7.847`) plus the expanded-gold metrics in the active log before runtime changes.

---

## Task 2: Make Availability A Single Owner

This is Plan 1 Task 3-4, but promoted as a dependency for every later task.

**Files:**
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/app.py`
- Create: `docs/test/test_availability.py`
- Create: `docs/test/test_availability_wiring.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `product_store.resolve_availability(card_or_doc, *, model_doc=None) -> dict`
- Later tasks consume keys:
  - `catalog_status`: `active|active_unknown_stock|out_of_stock|unlisted|discontinued|unknown`
  - `available_for_sale`: `bool`
  - `answerable`: `bool`
  - `reason`: short machine-readable string
  - `total_stock`: `int | None`
- Reuses and corrects existing `_shopee_stock()` as the only numeric stock calculation. Do not introduce `_stock_from_model()` or a second interpretation of `seller_stock`.

Live collection evidence: `summary_info.total_available_stock` and positive `seller_stock` agree on sellable/non-sellable for all 27,798 inspected units, but 62 units have different numeric quantities. Runtime selling availability therefore uses Shopee's `summary_info.total_available_stock` through `_shopee_stock()` whenever that field exists. `seller_stock` is not summed as a replacement, and a present value of `0` is a known out-of-stock fact, not permission to fall back.

- [ ] **Step 1: Write failing resolver tests**

Create `docs/test/test_availability.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import product_store


def test_normal_positive_summary_stock_is_active():
    doc = {"item_status": "NORMAL"}
    model = {"model_status": "MODEL_NORMAL", "stock_info_v2": {"summary_info": {"total_available_stock": 3}}}
    got = product_store.resolve_availability(doc, model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["answerable"] is True
    assert got["total_stock"] == 3


def test_normal_zero_stock_is_out_of_stock_but_answerable():
    doc = {"item_status": "NORMAL"}
    model = {"model_status": "MODEL_NORMAL", "stock_info_v2": {"summary_info": {"total_available_stock": 0}}}
    got = product_store.resolve_availability(doc, model_doc=model)
    assert got["catalog_status"] == "out_of_stock"
    assert got["available_for_sale"] is False
    assert got["answerable"] is True
    assert got["total_stock"] == 0


def test_present_zero_summary_does_not_fallback_to_other_stock_fields():
    doc = {"item_status": "NORMAL"}
    model = {
        "model_status": "MODEL_NORMAL",
        "stock_info_v2": {
            "summary_info": {"total_available_stock": 0, "total_reserved_stock": 0},
            "shopee_stock": [{"location_id": "", "stock": 99}],
            "seller_stock": [{"location_id": "THZ", "stock": 99, "if_saleable": True}],
        },
    }
    got = product_store.resolve_availability(doc, model_doc=model)
    assert got["catalog_status"] == "out_of_stock"
    assert got["available_for_sale"] is False
    assert got["total_stock"] == 0


def test_missing_summary_can_fallback_to_shopee_stock():
    doc = {"item_status": "NORMAL"}
    model = {
        "model_status": "MODEL_NORMAL",
        "stock_info_v2": {"shopee_stock": [{"location_id": "", "stock": 4}]},
    }
    got = product_store.resolve_availability(doc, model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["total_stock"] == 4


def test_missing_summary_and_shopee_stock_can_fallback_to_seller_stock():
    doc = {"item_status": "NORMAL"}
    model = {
        "model_status": "MODEL_NORMAL",
        "stock_info_v2": {"seller_stock": [{"location_id": "THZ", "stock": 2, "if_saleable": True}]},
    }
    got = product_store.resolve_availability(doc, model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["total_stock"] == 2


def test_normal_unknown_stock_is_answerable_but_not_sellable():
    doc = {"item_status": "NORMAL"}
    model = {"model_status": "MODEL_NORMAL", "stock_info_v2": {}}
    got = product_store.resolve_availability(doc, model_doc=model)
    assert got["catalog_status"] == "active_unknown_stock"
    assert got["available_for_sale"] is False
    assert got["answerable"] is True
    assert got["total_stock"] is None


def test_unlist_is_not_sellable_but_answerable_for_history():
    got = product_store.resolve_availability({"item_status": "UNLIST"}, model_doc={})
    assert got["catalog_status"] == "unlisted"
    assert got["available_for_sale"] is False
    assert got["answerable"] is True


def test_seller_delete_is_discontinued():
    got = product_store.resolve_availability({"item_status": "SELLER_DELETE"}, model_doc={})
    assert got["catalog_status"] == "discontinued"
    assert got["available_for_sale"] is False
    assert got["answerable"] is True
```

- [ ] **Step 2: Run failing test**

Run:

```bash
.venv/bin/python -m pytest docs/test/test_availability.py -v
```

Expected: fail because `resolve_availability` does not exist or returns missing keys.

- [ ] **Step 3: Implement resolver in `product_store.py`**

Add implementation near `_shopee_stock()`. First fix `_shopee_stock()` so field presence and numeric value are separate:

- If `stock_info_v2.summary_info.total_available_stock` exists and is numeric, return it, including `0`.
- Fallback to `stock_info_v2.shopee_stock[].stock` only when `summary_info.total_available_stock` is missing or not numeric.
- Fallback to saleable `stock_info_v2.seller_stock[].stock` only when both summary and shopee stock are missing or unreadable.
- If no source is usable, return `0` for `_shopee_stock()` and let `resolve_availability()` decide whether stock was known.

Then implement `resolve_availability()`. First detect whether a stock field is present so missing stock remains `None`; when present, obtain the numeric value only through `_shopee_stock()`:

- If `model_doc` is supplied, resolve that exact unit.
- If a raw listing has `model[]`, sum `_shopee_stock(model)` across the complete array and consider it sellable when at least one `MODEL_NORMAL` model has stock.
- If a raw listing has no models, use its own `stock_info_v2`.
- If the input is already a card, use `total_stock`/`stock` only as a fallback. A later task refreshes cards from raw listings before enforcement.

```python
def _stock_info_has_any_stock_source(stock_info: dict) -> bool:
    summary = (stock_info or {}).get("summary_info") or {}
    if "total_available_stock" in summary:
        return True
    shopee_stock = (stock_info or {}).get("shopee_stock")
    if isinstance(shopee_stock, list) and any(isinstance(x, dict) and "stock" in x for x in shopee_stock):
        return True
    seller_stock = (stock_info or {}).get("seller_stock")
    return isinstance(seller_stock, list) and any(isinstance(x, dict) and "stock" in x for x in seller_stock)


def _shopee_stock(model_doc: dict) -> int:
    si = (model_doc or {}).get("stock_info_v2") or {}
    summary = si.get("summary_info") or {}
    if isinstance(summary.get("total_available_stock"), (int, float)):
        return int(summary["total_available_stock"])

    shopee_stock = si.get("shopee_stock")
    if isinstance(shopee_stock, list):
        usable = [x for x in shopee_stock if isinstance(x, dict) and isinstance(x.get("stock"), (int, float))]
        if usable:
            return sum(int(x["stock"]) for x in usable)

    seller_stock = si.get("seller_stock")
    if isinstance(seller_stock, list):
        usable = [
            x for x in seller_stock
            if isinstance(x, dict)
            and x.get("if_saleable") is not False
            and isinstance(x.get("stock"), (int, float))
        ]
        if usable:
            return sum(int(x["stock"]) for x in usable)
    return 0


def resolve_availability(card_or_doc: dict, *, model_doc: dict | None = None) -> dict:
    status = str(card_or_doc.get("item_status") or card_or_doc.get("status") or "").upper()
    model_status = str((model_doc or card_or_doc).get("model_status") or "").upper()
    models = [] if model_doc is not None else list(card_or_doc.get("model") or [])

    if models:
        active_models = [m for m in models if str(m.get("model_status") or "").upper() == "MODEL_NORMAL"]
        stock_known = any(_stock_info_has_any_stock_source(m.get("stock_info_v2") or {}) for m in active_models)
        stock = sum(_shopee_stock(m) for m in active_models) if stock_known else None
        if not active_models:
            stock_known, stock = True, 0
    else:
        source = model_doc if model_doc is not None else card_or_doc
        info = source.get("stock_info_v2") or {}
        stock_known = _stock_info_has_any_stock_source(info) or source.get("stock") is not None or source.get("total_stock") is not None
        stock = _shopee_stock(source) if _stock_info_has_any_stock_source(info) else None

    if stock is None and not models:
        raw_stock = card_or_doc.get("stock", card_or_doc.get("total_stock"))
        try:
            stock = int(raw_stock) if raw_stock is not None else None
        except Exception:
            stock = None
    if not stock_known:
        stock = None

    if status == "NORMAL" and model_status and model_status != "MODEL_NORMAL":
        return {"catalog_status": "unlisted", "available_for_sale": False,
                "answerable": True, "reason": "model_not_normal", "total_stock": stock}
    if status == "NORMAL":
        if stock is None:
            return {"catalog_status": "active_unknown_stock", "available_for_sale": False,
                    "answerable": True, "reason": "normal_unknown_stock", "total_stock": stock}
        if stock > 0:
            return {"catalog_status": "active", "available_for_sale": True,
                    "answerable": True, "reason": "normal_positive_stock", "total_stock": stock}
        return {"catalog_status": "out_of_stock", "available_for_sale": False,
                "answerable": True, "reason": "normal_zero_stock", "total_stock": stock}
    if status == "UNLIST":
        return {"catalog_status": "unlisted", "available_for_sale": False,
                "answerable": True, "reason": "item_unlisted", "total_stock": stock}
    if status in {"SELLER_DELETE", "DELETED", "SHOPEE_DELETE", "BANNED"}:
        return {"catalog_status": "discontinued", "available_for_sale": False,
                "answerable": True, "reason": f"item_{status.lower()}", "total_stock": stock}
    return {"catalog_status": "unknown", "available_for_sale": False,
            "answerable": False, "reason": f"unknown_status:{status or 'missing'}", "total_stock": stock}
```

- [ ] **Step 4: Wire resolver**

Replace duplicated formulas only:
- `_doc_sellable()` calls `resolve_availability(doc)["available_for_sale"]`.
- `to_product_card()` resolves listing status from the full raw `doc["model"]` list before creating or truncating public `variants`; it adds `catalog_status`, `_available_for_sale`, `sold_out`, and `total_stock`.
- `units._live_sellable()` calls `product_store.resolve_availability(unit)["available_for_sale"]`.
- `units.to_unit_card()` passes the joined live listing plus the exact live model document to the resolver. A unit whose `model_id` no longer exists in the listing is unavailable with reason `model_missing`, not unknown and not listing-wide sold out.
- The local availability formula in `app.py` is replaced with resolver result, with no new branching.

- [ ] **Step 5: Run tests**

Run:

```bash
.venv/bin/python -m pytest docs/test/test_availability.py -v
.venv/bin/python -m pytest docs/test/test_availability_wiring.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/app.py
```

Expected: all pass.

---

## Task 3: Add Evidence Card Contract Without Changing Behavior

**Files:**
- Create: `chatbot/shopeechat/retrieval_policy.py`
- Create: `docs/test/test_retrieval_evidence.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `make_evidence_card()`
- Produces `strip_private_evidence()`; Task 8 wires it once at the public product-response boundary.
- Later tasks consume `_evidence` and `_selection_reason` internally.

- [ ] **Step 1: Write failing evidence tests**

Create `docs/test/test_retrieval_evidence.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import retrieval_policy


def test_make_evidence_card_preserves_public_shape():
    card = {"item_id": 1, "name": "ZMI Powerbank", "catalog_status": "active"}
    got = retrieval_policy.make_evidence_card(card, source="product_store",
                                              evidence={"spec": ["ShpProducts.description"]})
    assert got["item_id"] == 1
    assert got["name"] == "ZMI Powerbank"
    assert got["_evidence"]["source"] == "product_store"
    assert got["_evidence"]["spec"] == ["ShpProducts.description"]


def test_strip_private_evidence_removes_internal_keys():
    card = {"item_id": 1, "name": "A", "_evidence": {"source": "kb"}, "_selection_reason": "exact"}
    got = retrieval_policy.strip_private_evidence([card])
    assert got == [{"item_id": 1, "name": "A"}]
```

- [ ] **Step 2: Run failing test**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_evidence.py -v
```

Expected: fail because module does not exist.

- [ ] **Step 3: Implement minimal contract**

Create `chatbot/shopeechat/retrieval_policy.py`:

```python
from __future__ import annotations

from collections import Counter

PRIVATE_KEYS = ("_evidence", "_selection_reason")


def make_evidence_card(card: dict, *, source: str, protected: bool = False,
                       evidence: dict | None = None) -> dict:
    out = dict(card)
    meta = dict(evidence or {})
    meta["source"] = source
    meta["protected"] = bool(protected)
    out["_evidence"] = meta
    return out


def strip_private_evidence(products: list[dict]) -> list[dict]:
    cleaned: list[dict] = []
    for product in products:
        p = dict(product)
        for key in PRIVATE_KEYS:
            p.pop(key, None)
        cleaned.append(p)
    return cleaned
```

- [ ] **Step 4: Run tests and compile**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_evidence.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/retrieval_policy.py
```

Expected: pass.

---

## Task 4: Build One Canonical Retrieval Profile Before Any Product Fetch

This task is four independently reviewed migrations. Do not implement it as one patch. The current `app.py` resolves some comparison anchors before KB, but resolves the general conversation-active product after the KB early-return path. Therefore “build profile before first fetch” requires moving/reusing anchor resolution earlier; merely inserting a constructor near the main `fetch_products()` call is incorrect.

**Files:**
- Modify: `chatbot/shopeechat/route_context.py`
- Modify: `chatbot/shopeechat/app.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/device_compat.py`
- Modify: `chatbot/shopeechat/web_search.py`
- Modify: `chatbot/shopeechat/knowledge_base.py`
- Create: `docs/test/test_retrieval_profile.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `route_context.RetrievalProfile`.
- Produces `route_context.build_retrieval_profile(message, *, history, intent_result, shop, platform="shopee", anchor_cards=None) -> RetrievalProfile`.
- Adds optional `retrieval_profile: RetrievalProfile | None = None` to legacy product-candidate gateways during migration.
- Every source receives the same immutable profile object. A source-specific query string is separate and may not mutate canonical facts.

The exact resolved profile for the user’s example is:

```python
RetrievalProfile(
    platform="shopee",
    shop="current shop",
    message="สายชาร์จใช้กับ iPhone 13 ได้ไหม",
    intent="compatibility",
    product_types=frozenset({"charger"}),
    subtype="cable",
    model_codes=(),
    variant_terms=(),
    target_device="iPhone 13",
    availability_mode="sellable_first",
    compat_mode="connector_required",
    anchor_item_ids=(),
    fact_sources=(
        ("product_types", "message"),
        ("subtype", "message"),
        ("target_device", "message"),
    ),
)
```

- [ ] **Task 4A Step 1: Write failing profile ownership and precedence tests**

Create `docs/test/test_retrieval_profile.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import route_context


def test_iphone_cable_profile_keeps_device_separate_from_product_type():
    got = route_context.build_retrieval_profile(
        "สายชาร์จใช้กับ iPhone 13 ได้ไหม",
        history=[],
        intent_result={"intent": "compatibility_check", "confidence": 0.95},
        shop="ZMIThailand",
    )
    assert got.platform == "shopee"
    assert got.shop == "ZMIThailand"
    assert got.product_types == frozenset({"charger"})
    assert got.subtype == "cable"
    assert got.target_device.lower() == "iphone 13"
    assert got.compat_mode == "connector_required"
    assert got.availability_mode == "sellable_first"
    assert "phone" not in got.product_types


def test_mi_17_ultra_carries_cable_from_history_when_intent_is_unavailable():
    got = route_context.build_retrieval_profile(
        "อยากได้ที่ใช้กับ mi 17 ultra",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="KingGadgets",
    )
    assert got.shop == "KingGadgets"
    assert got.product_types == frozenset({"charger"})
    assert got.subtype == "cable"
    assert got.target_device.lower() == "mi 17 ultra"
    assert got.availability_mode == "sellable_first"
    assert got.compat_mode == "connector_required"
    assert ("subtype", "history") in got.fact_sources


def test_current_message_beats_wrong_intent_and_old_history():
    got = route_context.build_retrieval_profile(
        "หัวชาร์จใช้กับ mi 17 ultra",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={
            "intent": "product_recommend",
            "product_type": "phone",
            "charger_subtype": "cable",
            "target_device": "mi 17 ultra",
            "confidence": 0.99,
        },
        shop="KingGadgets",
    )
    assert got.product_types == frozenset({"charger"})
    assert got.subtype == "adapter"
    assert "phone" not in got.product_types


def test_explicit_new_topic_does_not_carry_charger_history():
    got = route_context.build_retrieval_profile(
        "หูฟังใช้กับ mi 17 ultra ได้ไหม",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={"intent": "compatibility_check", "confidence": 0.9},
        shop="KingGadgets",
    )
    assert got.product_types == frozenset({"earphone"})
    assert got.subtype is None
    assert got.compat_mode == "bluetooth_general"


def test_shop_never_comes_from_history_or_intent():
    got = route_context.build_retrieval_profile(
        "มีสายชาร์จไหม",
        history=[{"role": "user", "text": "ร้าน OtherShop มีอะไร"}],
        intent_result={"shop": "WrongShop", "intent": "product_recommend"},
        shop="KingGadgets",
    )
    assert got.shop == "KingGadgets"


def test_exact_old_model_profile_is_answerable_even_when_unavailable():
    got = route_context.build_retrieval_profile(
        "HA835 ยังมีประกันไหม",
        history=[],
        intent_result={"intent": "warranty_duration", "confidence": 0.9},
        shop="AnyShop",
    )
    assert "HA835" in got.model_codes
    assert got.availability_mode == "answerable_all"


def test_compare_profile_is_resolved_deterministically_not_by_classifier_label():
    anchors = [{"item_id": 1, "name": "Run"}, {"item_id": 2, "name": "Swim"}]
    got = route_context.build_retrieval_profile(
        "อันไหนดีกว่า",
        history=[],
        intent_result={"intent": "other", "confidence": 0.4},
        shop="AnyShop",
        anchor_cards=anchors,
    )
    assert got.intent == "compare"
    assert got.availability_mode == "answerable_all"
    assert got.anchor_item_ids == ("1", "2")
```

- [ ] **Task 4A Step 2: Run the profile test and confirm the missing owner**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_profile.py -v
```

Expected: fail because `RetrievalProfile` and `build_retrieval_profile()` do not exist. Record current outputs for the two Mi 17 Ultra cases before implementation.

- [ ] **Task 4A Step 3: Add the immutable profile and bounded fact helpers**

Add to `route_context.py`:

```python
@dataclass(frozen=True)
class RetrievalProfile:
    platform: str
    shop: str | None
    message: str
    intent: str
    product_types: frozenset[str]
    subtype: str | None
    model_codes: tuple[str, ...]
    variant_terms: tuple[str, ...]
    target_device: str | None
    availability_mode: str
    compat_mode: str
    anchor_item_ids: tuple[str, ...] = ()
    fact_sources: tuple[tuple[str, str], ...] = ()
```

Implement these private helpers in the same file; do not create another resolver module:

```python
def _bounded_history_facts(history: list[dict] | None) -> dict:
    """Read at most four newest messages and return only user type/subtype/device/model facts."""


def _variant_terms(message: str) -> tuple[str, ...]:
    """Return explicit color/capacity/size/variant phrases from the current message."""


def _resolved_intent(message: str, intent_result: dict | None,
                     model_codes: tuple[str, ...], anchor_cards: list[dict]) -> str:
    """Normalize classifier labels and deterministic exact/compare/superlative route facts."""


def _availability_mode(intent: str, model_codes: tuple[str, ...], message: str) -> str:
    """Map answer purpose to sellable_first/sellable_only/answerable_all/exact_history."""


def _compat_mode(product_types: frozenset[str], subtype: str | None,
                 target_device: str | None) -> str:
    """Map resolved product facts to none/connector_required/power_required/bluetooth_general."""
```

`_bounded_history_facts()` rules are exact:
- Inspect at most the newest four history entries, newest first.
- Extract carry-forward facts only from `role="user"`; bot prose is not a source of product truth.
- Keep only product family, charger subtype, bounded model code, and short target-device token; never concatenate history into a retrieval query.
- Carry type/subtype/device only when the current message is elliptical or contains compatibility/follow-up language and does not explicitly name a conflicting new product family.
- Active anchor facts passed through `anchor_cards` are stronger than plain history, but an explicit current-message family/subtype always wins.
- Reuse `device_compat._extract_device_token()` and existing product taxonomy detectors through lazy imports; do not copy their regex tables into `route_context.py`.

- [ ] **Task 4A Step 4: Implement deterministic reconciliation precedence**

`build_retrieval_profile()` must resolve each field independently with this order:

| Field | Precedence |
|---|---|
| `shop` | `ChatRequest.shop` only |
| `platform` | explicit function argument only |
| `product_types` | explicit current message → compatible active anchor → high-confidence intent proposal → bounded history carry |
| `subtype` | explicit strong current message → compatible active anchor → high-confidence intent subtype → bounded history carry → current weak detector |
| `model_codes` | exact current message → explicit anchor model → bounded user history only for referential follow-up |
| `variant_terms` | explicit current color/capacity/size/variant phrase → matching active anchor variant; never inferred from bot prose |
| `target_device` | explicit current message → current-turn intent proposal → bounded history only for compatibility follow-up |
| `availability_mode` | deterministic answer-purpose mapping; never copied from intent output |
| `compat_mode` | deterministic mapping from final type/subtype/device; never copied from intent output |

Normalize current intent labels inside this function:

```python
_INTENT_MAP = {
    "product_recommend": "recommend",
    "product_spec": "spec",
    "compatibility_check": "compatibility",
    "warranty_duration": "warranty",
    "warranty_claim": "claim",
    "general_question": "general",
    "other": "other",
}
```

After this label normalization, `_resolved_intent()` applies deterministic route modifiers already present in legacy behavior: explicit bounded model query → `exact_model`; two protected products plus comparison wording → `compare`; superlative wording plus a product family/anchor → `superlative`; order/history anchor → `history`. Move/reuse the existing generic detector constants from `app.py` in this task rather than creating a second keyword set; Task 9 deletes the remaining local consumers after replay.

Use intent type/subtype only when `confidence >= 0.7` and it does not conflict with explicit current-message facts. Intent target device may still be used below 0.7 only when a deterministic current-message device token confirms the same normalized device. This prevents an LLM guess from changing the requested product family.

- [ ] **Task 4B Step 5: Resolve product anchors before KB and build the profile once in `app.py`**

After intent classification, move the existing conversation active/compare resolution before the KB product lookup. Reuse `conversation_products.resolve_active_by_message()` exactly once; do not add a second timeline resolver. Collect tagged, hybrid, active, and compare current/previous cards, then build one profile before `knowledge_base.lookup_kb()` or any Mongo/vector candidate lookup:

```python
from . import route_context as _route_context

_retrieval_profile = _route_context.build_retrieval_profile(
    req.message,
    history=history,
    intent_result=_intent_result,
    shop=req.shop,
    platform=req.platform,
    anchor_cards=_resolved_anchor_cards,
)
```

Do not rebuild the profile when `retrieval_message` is rewritten. `retrieval_message` is a source query; `_retrieval_profile` remains the customer request contract.

Task 4B is observe-only: append `profile_debug()` to `_steps`, but do not yet change source output. Add regressions proving that moving anchor resolution earlier preserves item-tag direct replies, link follow-up, image-new-topic behavior, compare ordering, and claim/order early returns.

- [ ] **Task 4C Step 6: Pass the same profile through product, unit, and KB candidate paths**

Add an optional migration parameter at the end of signatures so existing callers do not break:

```python
# product_store.py
def fetch_products(..., retrieval_profile: RetrievalProfile | None = None) -> list[dict]: ...

# units.py
def fetch_units(..., retrieval_profile: RetrievalProfile | None = None) -> list[dict]: ...
def fetch_unit_cards(..., retrieval_profile: RetrievalProfile | None = None) -> list[dict]: ...

# device_compat.py
def _device_spec_lookup(..., retrieval_profile: RetrievalProfile | None = None) -> tuple[str, list[dict], list[dict]]: ...

# web_search.py
def reanswer(..., retrieval_profile: RetrievalProfile | None = None) -> dict: ...

# knowledge_base.py
def lookup_kb(message: str, *, retrieval_profile: RetrievalProfile | None = None) -> dict | None: ...
def qa_context(message: str, *, retrieval_profile: RetrievalProfile | None = None,
               conversation_id=None, claim: bool = False) -> str: ...
```

Use `if TYPE_CHECKING: from .route_context import RetrievalProfile` plus postponed annotations in modules where a runtime import would form a cycle. Do not weaken the public plan contract to `object` or `dict` merely to avoid import cycles.

Migration rule: when `retrieval_profile` is present, use its `shop`, `product_types`, `subtype`, `target_device`, `availability_mode`, and `compat_mode`; do not call `resolve_route()` or trust a generated query to rediscover those facts. When absent, keep the current path unchanged until all legacy callsites are migrated.

Before changing any signature, regenerate the callsite inventory from the current checkout and save it in the active log:

```bash
rg -n "fetch_products\\(|lookup_kb\\(|qa_context\\(|_device_spec_lookup\\(|reanswer\\(" chatbot/shopeechat
```

The counts below are the 2026-09-22 snapshot, not a substitute for the fresh audit:

| Path | Current calls | Required profile behavior |
|---|---:|---|
| Main and alternative product retrieval in `app.py` | 8 `product_store.fetch_products()` callsites | pass `_retrieval_profile` unchanged |
| Unit gateway inside `product_store.fetch_products()` | 1 `units.fetch_unit_cards()` path | forward the same profile; no second `resolve_route(message)` |
| Compatibility re-query in `device_compat.py` | 3 `product_store.fetch_products()` callsites | use profile family/subtype/device even when local query adds connector keywords |
| Web-search DB re-query in `web_search.py` | 2 `product_store.fetch_products()` callsites | preserve original profile; web keywords may add recall but cannot replace family/device |
| KB/Mongo merge in legacy `app.py` | included in the 8 app callsites | pass profile to both initial and missing-model fallback fetches |
| Direct regex/model candidate branches in `app.py` | direct Mongo candidate paths | scope with profile facts and send candidates through the same selector |
| KB product and QA retrieval | `lookup_kb()` plus `qa_context()`/troubleshooting callers | use profile model codes/anchor item ids; do not call `resolve_route()` again when profile exists |

Do not change the three `chat_v2.py` callsites in this plan.

- [ ] **Task 4D Step 7: Pass the profile through compatibility and web re-query, then remove secondary extraction**

For profile-backed calls:
- `product_store.fetch_products()` uses `profile.product_types` and `profile.subtype` rather than detecting from rewritten `message`.
- The unit gate and `units.fetch_unit_cards()` receive the profile rather than calling `resolve_route(message)` again.
- `device_compat._device_spec_lookup()` uses `profile.target_device`, `profile.product_types`, and `profile.subtype`; intent fields become fallback only when no profile was supplied.
- `web_search.reanswer()` must not let extractor `product_type` replace `profile.product_types`.
- `knowledge_base.lookup_kb()` uses profile model codes and protected anchor IDs when present. `qa_context()` must not independently resolve route/timeline facts a second time.
- Keep compatibility shims until the replay gate passes, then delete them in Task 13.

- [ ] **Step 8: Add one debug serialization point**

Add `route_context.profile_debug(profile, *, source: str, used_fields: tuple[str, ...]) -> dict` and append it to `_steps` at source boundaries:

```python
{
    "source": "device_compat_requery",
    "shop": "KingGadgets",
    "product_types": ["charger"],
    "subtype": "cable",
    "target_device": "mi 17 ultra",
    "availability_mode": "sellable_first",
    "compat_mode": "connector_required",
    "used_fields": ["shop", "product_types", "subtype", "target_device"],
    "fact_sources": {
        "product_types": "history",
        "subtype": "history",
        "target_device": "message",
    },
}
```

Log facts, not full history. Do not show this report to customers.

- [ ] **Step 9: Run profile, existing route, and compile checks**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_profile.py docs/test/test_route_context.py -v
.venv/bin/python docs/test/test_car_charger_regression.py
.venv/bin/python -m py_compile chatbot/shopeechat/route_context.py chatbot/shopeechat/app.py chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/device_compat.py chatbot/shopeechat/web_search.py
```

If `docs/test/test_route_context.py` is not present, run the current route-context equivalent and record the exact path in the active log.

Expected:
- Every profile test passes, including intent failure and wrong-intent conflict.
- The Mi 17 Ultra follow-up resolves to charger+cable+target device instead of phone/no-type.
- All legacy product-candidate callsites can be audited to the same profile id/debug facts.
- Runtime answer behavior is still unchanged in this task; false out-of-stock is closed by availability/selection/compatibility tasks below, not by prompt changes here.

---

## Task 4E: Multi-Product Request Slots

**Why this task exists:** Task 4D starts trusting one `RetrievalProfile` during retrieval. That is correct for single-product turns, but a flat profile is not enough when a customer asks for multiple products in one message and gives different constraints per product. Without slots, a charger brand can accidentally filter smartwatch candidates, a charger subtype can filter non-charger candidates, or a model phrase can be attached to the wrong product request.

**Files:**
- Modify: `chatbot/shopeechat/route_context.py`
- Create: `docs/test/test_retrieval_slots.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `RetrievalSlot` and `build_retrieval_slots(profile) -> tuple[RetrievalSlot, ...]`.
- Consumes the Task 4D `RetrievalProfile`; does not call LLM and does not replace intent classification.
- Keeps `RetrievalProfile.subtype` for backward compatibility. Adds slot-level `subtypes` for multi-subtype/multi-product queries.
- This task is contract/parser only. Source modules do not fetch per slot until Task 5A/selection wiring.

- [ ] **Step 1: Write failing slot parsing tests**

Create `docs/test/test_retrieval_slots.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import route_context


def _profile(message: str):
    return route_context.build_retrieval_profile(
        message,
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets",
    )


def test_charger_and_watch_keep_separate_constraints():
    prof = _profile(
        "อยากได้หัวชาร์จกับนาฬิกาใช้กับ mi 17 ultra "
        "brand ที่มองไว้หัวชาร์จเอา cuktech นาฬิกาเอา xiaomi mi watch 8"
    )
    slots = route_context.build_retrieval_slots(prof)

    charger = next(s for s in slots if "charger" in s.product_types)
    watch = next(s for s in slots if "smartwatch" in s.product_types)

    assert "adapter" in charger.subtypes
    assert "cuktech" in {b.lower() for b in charger.brand_hints}
    assert "xiaomi" not in {b.lower() for b in charger.brand_hints}
    assert "smartwatch" not in charger.product_types

    assert "xiaomi" in {b.lower() for b in watch.brand_hints}
    assert any("watch 8" in t.lower() for t in watch.model_terms)
    assert "cuktech" not in {b.lower() for b in watch.brand_hints}
    assert "adapter" not in watch.subtypes


def test_multi_subtype_charger_does_not_collapse_to_one_subtype():
    prof = _profile("มีสายชาร์จกับหัวชาร์จไหม")
    slots = route_context.build_retrieval_slots(prof)
    charger = next(s for s in slots if "charger" in s.product_types)
    assert {"cable", "adapter"} <= set(charger.subtypes)
    assert charger.primary_subtype in (None, "cable", "adapter")


def test_single_product_turn_remains_one_slot():
    prof = _profile("มีหัวชาร์จ CukTech ใช้กับ Mi 17 Ultra ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    assert "charger" in slots[0].product_types
```

- [ ] **Step 2: Run tests to verify RED**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_slots.py -v
```

Expected: fail because `RetrievalSlot`/`build_retrieval_slots` do not exist or do not split constraints yet.

- [ ] **Step 3: Implement deterministic slot extraction**

In `route_context.py`:
- Add frozen `RetrievalSlot`.
- Add `build_retrieval_slots(profile)`.
- Split by product mentions and connector words such as “กับ”, “ส่วน”, “เอา”, “ของ”, “สำหรับ”, and “ใช้กับ” only as deterministic span hints.
- Attach brand/model terms to the nearest product span when the span explicitly mentions that product.
- Mark target devices after “ใช้กับ/รองรับ/สำหรับ” as shared only when the wording is outside a specific product span.
- If confidence is low or no product boundary is clear, return one slot derived from the original profile and fail open.

Do not add case-specific logic for the example brands/devices. This must work for the same pattern with other product families.

- [ ] **Step 4: Add provenance hardening tests**

Extend `docs/test/test_retrieval_slots.py`:

```python
def test_single_accessory_keeps_inferred_phone_out_of_product_types():
    prof = _profile("มีเคส iPhone 15 ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    assert slots[0].product_types == frozenset({"case"})
    assert slots[0].target_device == "iphone 15"


def test_inferred_device_family_rule_is_not_phone_specific():
    prof = _profile("มีเคส Mi Watch 8 ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    assert slots[0].product_types == frozenset({"case"})
    assert slots[0].target_device == "mi watch 8"


def test_inferred_only_model_keeps_product_type_fallback():
    prof = _profile("อยากได้ iPhone 15")
    slots = route_context.build_retrieval_slots(prof)
    assert slots[0].product_types == frozenset({"phone"})
```

Expected: fail if type mention provenance is lost or if the fix is phone-specific.

- [ ] **Step 5: Implement provenance in slot parsing**

In `route_context.py`:
- `_type_mentions()` returns `(pos, type, src)` where `src` is `"kw"` for explicit user product keywords and `"regex"` for inferred device/model phrases.
- Latin keyword matching uses token boundaries so `"phone"` in `"iphone"` is not an explicit product keyword.
- Compute effective product types once: when any explicit product keyword exists, regex-only device/model mentions do not create product slots; when no explicit keyword exists, inferred model types remain a fallback product request.
- Single-slot and multi-slot paths both use the same effective product types.
- Keep brand/model evidence out of the slot when it belongs only to the target device, except when the device is itself the requested product family.

- [ ] **Step 6: Verification**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_slots.py docs/test/test_retrieval_profile.py docs/test/test_retrieval_profile_hints.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/route_context.py chatbot/shopeechat/product_store.py chatbot/shopeechat/retrieval_policy.py
git diff --check
```

Expected:
- Single-product turns keep one slot and existing Task 4D behavior.
- Multi-subtype charger turns do not lose one subtype because of a single `subtype` field.
- Multi-product turns do not leak product-specific brand/model/subtype constraints into another product slot.

---

## Task 4F: Canonical Device Alias Normalization

**Why this task exists:** Task 4D/4E can preserve target devices only after a device is extracted correctly. Current generic extraction catches normal forms such as `mi 14 pro` and `iphone 14 pro`, but compact or shorthand customer forms can be lost or stay non-canonical: `mi14pro` is dropped by the product-code guard, `i14 pro` and `ip14` are tokens without spec evidence, and Thai `ไอโฟน14โปร` is not normalized. If this remains unfixed before grouped retrieval/compat selection, retrieval can miss compatible products before final ranking even starts.

**Files:**
- Modify: `chatbot/shopeechat/device_compat.py`
- Modify: `chatbot/shopeechat/route_context.py` only if the extracted normalized token is not already consumed there
- Create: `docs/test/test_device_alias_normalization.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `device_compat.normalize_device_alias(value: str) -> str | None`.
- `_extract_device_token(message)` may call `normalize_device_alias()` before returning a token.
- `_lookup_spec_db(device_name)` must accept the normalized value without adding alias rules in product retrieval code.
- Does not change `_detect_product_types()` and does not add prompt text.

- [ ] **Step 1: Write failing alias tests**

Create `docs/test/test_device_alias_normalization.py`:

```python
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import device_compat, route_context  # noqa: E402


def _profile(message: str):
    return route_context.build_retrieval_profile(
        message,
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets",
    )


def test_compact_xiaomi_phone_alias_becomes_target_device():
    assert device_compat.normalize_device_alias("mi14pro") == "xiaomi 14 pro"
    assert device_compat._extract_device_token("สายชาร์จใช้กับ mi14pro") == "xiaomi 14 pro"
    prof = _profile("สายชาร์จใช้กับ mi14pro")
    assert prof.target_device == "xiaomi 14 pro"
    assert prof.compat_mode == "connector_required"


def test_iphone_shorthand_aliases_normalize_to_iphone_family():
    assert device_compat.normalize_device_alias("ip14") == "iphone 14"
    assert device_compat.normalize_device_alias("i14 pro") == "iphone 14 pro"
    assert device_compat._lookup_spec_db("iphone 14 pro")["connector"] == "lightning"


def test_thai_iphone_alias_normalizes():
    assert device_compat.normalize_device_alias("ไอโฟน14โปร") == "iphone 14 pro"
    prof = _profile("มีสายชาร์จใช้กับไอโฟน14โปรไหม")
    assert prof.target_device == "iphone 14 pro"


def test_product_model_codes_are_not_target_devices():
    for value in ("HA835", "AD1203P", "CMC615", "CTC615W"):
        assert device_compat.normalize_device_alias(value) is None
        assert device_compat._extract_device_token(f"มีรุ่น {value} ไหม") is None
```

- [ ] **Step 2: Run tests to verify RED**

```bash
.venv/bin/python -m pytest docs/test/test_device_alias_normalization.py -v
```

Expected: fail on compact/shorthand device normalization while product-code negative cases remain the safety gate.

- [ ] **Step 3: Implement minimal canonical alias normalization**

In `device_compat.py`:
- Add `normalize_device_alias(value: str) -> str | None`.
- Normalize whitespace and lowercase ASCII.
- Accept only known device-family prefixes:
  - `iphone`, `ip`, or `i` followed by iPhone model numbers and optional suffix words `pro`, `pro max`, `plus`, `mini`, `se`, `air`.
  - Thai `ไอโฟน` followed by model number and optional Thai suffix `โปร`, `โปรแมกซ์`, `พลัส`, `มินิ`, `แอร์`.
  - `mi` followed by Xiaomi phone model number and optional suffix words `ultra`, `pro`, `pro max`, `t`, `t pro`.
- Return canonical values such as `iphone 14 pro`, `iphone 14`, `xiaomi 14 pro`.
- Return `None` for ambiguous alphanumeric product codes and unsupported families. Do not add a fallback that treats every letters+digits token as a device.
- Call this helper from `_extract_device_token()` after the regex candidate is found and before the product-code guard drops compact family tokens. If no regex candidate is found, probe the full message for the explicit alias patterns above.

- [ ] **Step 4: Ensure spec lookup coverage**

Update `device_specs_data.py` only if the normalized canonical value is missing and there is enough curated data. If a specific variant is missing, add the alias only when it is safe:

```python
"xiaomi 14 pro": {"connector": "usb-c", "wired_w": 120, "wireless_w": 50,
                  "protocols": ["hypercharge", "pd", "pps", "qc"],
                  "year": 2023, "aliases": ["mi 14 pro", "mi14pro"]},
```

If exact watt/spec evidence is not available, do not invent it. Prefer normalizing `mi14pro` to a token that preserves target identity and let compatibility answer say evidence is incomplete rather than claim a wattage.

- [ ] **Step 5: Probe route/slot behavior**

Run this probe and record the result in `getoutofmywaybotkaikrook2.md`:

```bash
.venv/bin/python - <<'PY'
import sys
sys.path.insert(0, "chatbot")
from shopeechat import route_context, device_compat

for msg in (
    "หาสายชาร์จใช้กับ mi14pro",
    "หาสายชาร์จใช้กับ i14 pro",
    "หาสายชาร์จใช้กับ ip14",
    "หาสายชาร์จใช้กับ iphone14 pro",
    "หาสายชาร์จใช้กับ ไอโฟน14โปร",
    "มีรุ่น HA835 ไหม",
):
    prof = route_context.build_retrieval_profile(
        msg,
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets",
    )
    print(msg, "=>", prof.product_types, prof.target_device, prof.compat_mode,
          device_compat._lookup_spec_db(prof.target_device or ""))
PY
```

Expected:
- compact/shorthand phone requests become target devices for cable/charger questions;
- product model codes stay model-code/search facts, not target devices;
- missing exact spec remains unknown evidence, not a fabricated compatibility claim.

- [ ] **Step 6: Verification**

```bash
.venv/bin/python -m pytest docs/test/test_device_alias_normalization.py docs/test/test_retrieval_profile.py docs/test/test_retrieval_slots.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/device_compat.py chatbot/shopeechat/route_context.py
git diff --check
```

Expected:
- Existing Task 4D/4E behavior remains unchanged except normalized target devices.
- `mi14pro`, `ip14`, `i14 pro`, `iphone14 pro`, and `ไอโฟน14โปร` no longer enter retrieval as unknown device strings.
- product codes are not reclassified as devices.

---

## Task 4G: Mention Relation Parser Hardening

**Why this task exists:** Task 4E fixes the immediate provenance leak, but relation ownership is still spread across slot span rules, `_local_target_device()`, brand filtering, and family checks. That is better than one-off phone/watch fixes, but still leaves ambiguity and small pollution such as `เคส xiaomi mi watch 8` where `xiaomi` can look like a product brand for the case. The root-cause direction is to make route mentions and their relations explicit once, then let `build_retrieval_slots()` consume that structure.

**Files:**
- Modify: `chatbot/shopeechat/route_context.py`
- Create or extend: `docs/test/test_route_mentions.py` or `docs/test/test_retrieval_slots.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces a small internal dataclass such as `RouteMention` or plain dicts from `extract_route_mentions(message, allowed_types)`.
- `build_retrieval_slots(profile)` may use the mention list, but public `RetrievalProfile` and `RetrievalSlot` fields stay unchanged.
- Does not call LLM.
- Does not change retrieval runtime, `product_store.fetch_products()`, or prompt text.

- [ ] **Step 1: Write failing relation tests**

Add tests that prove the current span heuristics are not enough:

```python
def test_device_brand_is_not_product_brand_for_accessory():
    prof = _profile("มีเคส xiaomi mi watch 8 ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    assert slots[0].product_types == frozenset({"case"})
    assert slots[0].target_device in {"xiaomi mi watch 8", "mi watch 8"}
    assert "xiaomi" not in {b.lower() for b in slots[0].brand_hints}


def test_ambiguous_device_without_product_keyword_is_low_confidence():
    prof = _profile("หัวชาร์จกับ Mi Watch 8")
    slots = route_context.build_retrieval_slots(prof)
    charger = next(s for s in slots if "charger" in s.product_types)
    assert charger.target_device in (None, "mi watch 8")
    assert charger.confidence < 0.8
```

Expected: fail if device-brand pollution remains or if ambiguous relation is treated as high-confidence.

- [ ] **Step 2: Implement one mention extractor**

In `route_context.py`, add one internal owner:

```python
@dataclass(frozen=True)
class RouteMention:
    text: str
    kind: str        # "product_type" | "device" | "brand" | "model_code"
    value: str
    start: int
    end: int
    source: str      # "kw" | "regex" | "alias"


def extract_route_mentions(message: str, allowed_types: frozenset[str]) -> tuple[RouteMention, ...]:
    ...
```

Rules:
- Product type mentions keep provenance from keyword vs regex.
- Device mentions use `device_compat._extract_device_token()` after Task 4F normalization.
- Brand mentions that are inside a device mention are tagged as device-owned and must not become `brand_hints` for a different product slot.
- Model codes come from the existing `_extract_codes()` helper.
- Do not add family-specific branches for `iphone`, `mi watch`, `xiaomi`, or `charger` except through existing taxonomy/device helpers.

- [ ] **Step 3: Make `build_retrieval_slots()` consume mentions**

Use the mention list to:
- create slot boundaries from explicit product type mentions;
- attach brands/model codes only when their spans are inside the product span and not inside a target device mention;
- mark relation confidence lower when a device phrase follows `กับ` but there is no compatibility connector and no explicit product keyword for that device family;
- preserve current passing behavior for 4E tests.

- [ ] **Step 4: Verify**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_slots.py docs/test/test_route_mentions.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/route_context.py
git diff --check
```

Expected:
- No new runtime retrieval behavior.
- Existing 4E slot tests keep passing.
- Ambiguous wording is not converted into a high-confidence compatibility/product claim.
- Device brand pollution is removed through mention ownership, not a product-family special case.

---

## Task 5: Refresh Candidate Availability From Full Live Listings

**Files:**
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/order_store.py`
- Create: `docs/test/test_candidate_availability_refresh.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `product_store.normalize_shopee_id(value) -> str` as the one boundary normalizer for float/int/string IDs.
- Produces `product_store.refresh_candidate_availability(db, products: list[dict], *, profile: RetrievalProfile) -> tuple[list[dict], dict]`.
- Consumes availability facts from Task 2 and `RetrievalProfile` from Task 4.
- Performs one batch `ShpProducts` query for all candidate item IDs and uses complete raw `model[]` data. It does not infer compatibility or rank products.
- Compatibility annotation remains in `device_compat` (Task 10) to avoid a circular `product_store ↔ device_compat` owner.

- [ ] **Step 1: Write failing ID and live-refresh tests**

Create `docs/test/test_candidate_availability_refresh.py`. Test the pure internal mapping helper with raw listing fixtures; do not construct truncated cards and pretend they are live DB data.

```python
from __future__ import annotations

from chatbot.shopeechat import product_store, route_context


def _profile(message: str) -> route_context.RetrievalProfile:
    return route_context.build_retrieval_profile(
        message,
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.95},
        shop="TestShop",
    )


def test_normalize_shopee_id_handles_float_int_and_string():
    assert product_store.normalize_shopee_id(123.0) == "123"
    assert product_store.normalize_shopee_id(123) == "123"
    assert product_store.normalize_shopee_id("123.0") == "123"


def test_listing_uses_full_raw_models_not_public_variants_limit():
    products = [{"item_id": "1", "name": "หัวชาร์จ 120W", "variants": []}]
    models = [
        {"model_id": i, "model_name": f"รุ่น {i}", "model_status": "MODEL_NORMAL",
         "stock_info_v2": {"summary_info": {"total_available_stock": 0}}}
        for i in range(1, 25)
    ]
    models[23]["stock_info_v2"]["summary_info"]["total_available_stock"] = 5
    docs = {"1": {"item_id": 1.0, "item_status": "NORMAL", "model": models}}
    got, report = product_store._refresh_cards_from_docs(
        products, docs, profile=_profile("มีหัวชาร์จไหม"))
    assert got[0]["catalog_status"] == "active"
    assert got[0]["_available_for_sale"] is True
    assert report["refreshed"] == 1


def test_requested_variant_after_twentieth_model_is_resolved_from_raw_doc():
    products = [{"item_id": 1, "name": "สายชาร์จ CTC315P"}]
    models = [
        {"model_id": i, "model_name": f"สี {i}", "model_status": "MODEL_NORMAL",
         "stock_info_v2": {"summary_info": {"total_available_stock": 3}}}
        for i in range(1, 24)
    ]
    models.append({"model_id": 24, "model_name": "สีขาว", "model_status": "MODEL_NORMAL",
                   "stock_info_v2": {"summary_info": {"total_available_stock": 0}}})
    profile = _profile("สายชาร์จ CTC315P สีขาว")
    got, report = product_store._refresh_cards_from_docs(
        products, {"1": {"item_id": 1.0, "item_status": "NORMAL", "model": models}},
        profile=profile)
    assert got[0]["requested_variant_status"] == "out_of_stock"
    assert got[0]["has_other_sellable_variants"] is True


def test_missing_live_listing_keeps_order_history_answerable():
    products = [{"item_id": "999", "name": "รุ่นเก่า", "_evidence": {"order_history": ["ShpOrders"]}}]
    got, report = product_store._refresh_cards_from_docs(
        products, {}, profile=_profile("รุ่นเก่ายังมีประกันไหม"))
    assert got[0]["answerable"] is True
    assert got[0]["_available_for_sale"] is False
    assert got[0]["availability_reason"] == "live_listing_missing_order_history"


def test_missing_unit_model_is_not_promoted_by_listing_stock():
    products = [{"item_id": 1, "model_id": 999, "unit_id": "1:999"}]
    docs = {"1": {"item_id": 1.0, "item_status": "NORMAL", "model": [
        {"model_id": 10, "model_status": "MODEL_NORMAL",
         "stock_info_v2": {"summary_info": {"total_available_stock": 5}}}
    ]}}
    got, report = product_store._refresh_cards_from_docs(
        products, docs, profile=_profile("มีรุ่นนี้ไหม"))
    assert got[0]["_available_for_sale"] is False
    assert got[0]["availability_reason"] == "model_missing"
```

- [ ] **Step 2: Run failing tests**

```bash
.venv/bin/python -m pytest docs/test/test_candidate_availability_refresh.py -v
```

Expected: fail because the shared ID normalizer and live refresh functions do not exist.

- [ ] **Step 3: Implement one batch live refresh**

Rules:
- Normalize all candidate IDs before dedupe/join. Promote the existing nested cert-search ID normalization instead of adding another formula.
- Fetch raw live listings once with `$in` and projection `item_id`, `item_status`, `stock_info_v2`, and complete `model.{model_id,model_name,model_status,stock_info_v2}`.
- Unit cards resolve by exact `model_id`; listing cards resolve across the complete model array.
- Variant terms are matched against raw `model_name`, including models after index 20.
- A missing raw listing is `unknown`, not `out_of_stock`. Keep KB/order/history evidence answerable but never recommend it as sellable.
- A DB error preserves the source card facts, records `refresh_error`, and must not convert unknown into sold out.
- Return annotations and a report; final dropping still belongs to `retrieval_policy.select_context()`.
- Do not import `device_compat` here. Connector/power evidence is annotated in Task 10.

- [ ] **Step 4: Wire once after candidate union, not after every fetch**

In each final legacy candidate path (KB early-return path and main path), call refresh once after all source candidates are merged and before compatibility/selection:

```python
products, _availability_report = product_store.refresh_candidate_availability(
    db, products, profile=_retrieval_profile)
```

Append `_availability_report` to `_steps`. Do not call the DB refresher separately for unit, legacy, KB, anchor, and web lists.

Replace `order_store.py`'s `.replace(".0", "")` conversion with `normalize_shopee_id()`. Use the same normalized key in `retrieval_policy._key()` and the KB/image/stock join adapters touched later.

- [ ] **Step 5: Run regression**

```bash
.venv/bin/python -m pytest docs/test/test_candidate_availability_refresh.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/product_store.py chatbot/shopeechat/app.py
```

Expected: cards use full live listing/model availability, stale unit models stay unavailable, old-order evidence remains answerable, and no candidate is declared sold out merely because the public card omitted models after index 20.

---

## Task 5A: Close Candidate Recall Before Final Selection

The current unit gateway returns immediately whenever it finds any unit cards. That means a non-empty but incomplete/wrong unit pool prevents the legacy listing search from contributing the correct product. This task fixes candidate generation itself; later ranking cannot recover a product that was never retrieved.

**Files:**
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `docs/test/eval_retrieval.py`
- Create: `docs/test/test_candidate_source_union.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `product_store._merge_candidate_sources(unit_cards, legacy_cards, *, profile, limit) -> tuple[list[dict], dict]`.
- `fetch_products()` remains the public gateway and still returns `list[dict]`.
- Candidate source labels are private metadata (`unit_exact`, `unit_vector`, `legacy_exact`, `legacy_vector`, `kb`, `anchor`, `order`) and are stripped before the public response.

- [ ] **Step 1: Write bounded-union tests**

Cover these cases:
- Unit returns non-empty wrong/partial results while legacy contains the acceptable exact item; union must include the acceptable item.
- The same item/model from unit and listing sources is represented once, preferring the unit card for shopping while preserving stronger KB/order evidence.
- Several variants from one listing cannot consume the entire output before distinct `item_id` values are represented.
- `product_type=null` unit rows cannot block typed legacy candidates.
- Compatibility remains on the existing wide legacy path while `is_compat_check=True`.
- Per-source inputs and final output are capped by caller `limit`; the test must fail if the helper can return an unbounded list.

- [ ] **Step 2: Add offline source-union evaluation before runtime change**

Extend the evaluator with `--candidate-mode current|bounded_union`. It may call both current source functions for the gold query, but it must record only bounded top results, source contribution, acceptable-hit recall, item diversity, live ratio, pool size, and elapsed time. It must not read a whole shop or collection into memory.

Run current and bounded-union modes on the same reviewed rows. Acceptance to continue:
- Exact-model and compatibility acceptable-hit rates do not decrease.
- At least one previously missing acceptable item is recovered, or the task is rejected as unnecessary.
- Shopping live ratio does not decrease.
- Duplicate-pool rate and item diversity do not regress.
- Record median and p95 retrieval time; any material increase must be reviewed before runtime rollout.

- [ ] **Step 3: Replace blind unit early-return behind a temporary rollout flag**

For profile-backed non-compat shopping queries only:
- Fetch the existing bounded unit pool.
- Continue through the existing bounded legacy search instead of returning immediately.
- Merge with `_merge_candidate_sources()` and cut to `limit`.
- Exact code hits and protected identity stay ahead of semantic hits.
- If either source errors, return the healthy source using current fallback behavior.

Keep current behavior as the default until Step 2 passes. Use one temporary rollout setting for the union; remove it in Task 13 after replay. Do not add per-product-family flags.

- [ ] **Step 4: Re-run gold and Mi 17 gates**

```bash
.venv/bin/python -m pytest docs/test/test_candidate_source_union.py -v
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl --gold docs/test/gold_retrieval.jsonl --by-intent --candidate-mode bounded_union
```

Expected: correct candidates are present before final selection, pool size remains bounded, and compatibility still uses the proven wide legacy sweep.

---

## Task 6: Add Selection Policy In Observe-Only Mode

**Files:**
- Modify: `chatbot/shopeechat/retrieval_policy.py`
- Create: `docs/test/test_retrieval_policy.py`
- Modify: `chatbot/shopeechat/app.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Consumes `route_context.RetrievalProfile` from Task 4; it must not build or alter request facts.
- Consumes the bounded, live-refreshed pool from Tasks 5 and 5A; it must not query MongoDB or call retrieval sources.
- Produces `select_context()`.
- `app.py` initially calls this only to produce a debug report in `_steps`; it does not change `products`.

- [ ] **Step 1: Write failing selection tests**

Create `docs/test/test_retrieval_policy.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import retrieval_policy, route_context


def _profile(message: str, intent: str) -> route_context.RetrievalProfile:
    return route_context.build_retrieval_profile(
        message,
        history=[],
        intent_result={"intent": intent, "confidence": 0.95},
        shop="TestShop",
    )


def test_recommend_drops_unavailable_when_not_protected():
    products = [
        {"item_id": 1, "name": "dead", "catalog_status": "out_of_stock", "_available_for_sale": False},
        {"item_id": 2, "name": "live", "catalog_status": "active", "_available_for_sale": True},
    ]
    selected, report = retrieval_policy.select_context(
        products, profile=_profile("มีหัวชาร์จไหม", "product_recommend"), limit=5)
    assert [p["item_id"] for p in selected] == [2]
    assert report["dropped_unavailable"] == 1


def test_protected_compare_pair_is_kept_even_if_same_listing():
    products = [{"item_id": 3, "name": "other", "_available_for_sale": True, "catalog_status": "active"}]
    protected = [
        {"item_id": 1, "name": "current", "_available_for_sale": False, "catalog_status": "out_of_stock"},
        {"item_id": 2, "name": "previous", "_available_for_sale": False, "catalog_status": "unlisted"},
    ]
    selected, report = retrieval_policy.select_context(
        products,
        profile=_profile("ตัวนี้กับอันก่อนต่างกันยังไง", "product_spec"),
        protected_products=protected,
        limit=5,
    )
    assert [p["item_id"] for p in selected[:2]] == [1, 2]
    assert report["protected_count"] == 2
```

- [ ] **Step 2: Run failing test**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_policy.py -v
```

Expected: fail because functions are not implemented.

- [ ] **Step 3: Implement observe-only selector**

Add only selection logic; profile construction remains in `route_context.py`:

```python
def _key(product: dict) -> str:
    unit_id = product.get("unit_id")
    if unit_id:
        return f"unit:{unit_id}"
    from .product_store import normalize_shopee_id
    return f"item:{normalize_shopee_id(product.get('item_id'))}"


def select_context(products: list[dict], *, profile: RetrievalProfile,
                   protected_products: list[dict] | None = None,
                   limit: int = 30,
                   evidence_mode: str = "observe") -> tuple[list[dict], dict]:
    protected_products = protected_products or []
    out: list[dict] = []
    seen: set[str] = set()
    dropped_unavailable = 0
    sellable_candidate_count = sum(
        1 for p in products
        if bool(p.get("_available_for_sale") or p.get("available_for_sale"))
    )

    for product in protected_products:
        k = _key(product)
        if k not in seen:
            p = dict(product)
            p["_selection_reason"] = "protected"
            out.append(p)
            seen.add(k)

    for product in products:
        k = _key(product)
        if k in seen:
            continue
        available = bool(product.get("_available_for_sale") or product.get("available_for_sale"))
        shopping = profile.availability_mode in {"sellable_first", "sellable_only"}
        if shopping and not available:
            dropped_unavailable += 1
            continue
        p = dict(product)
        p["_selection_reason"] = "available" if available else "answerable_unavailable"
        out.append(p)
        seen.add(k)
        if len(out) >= limit:
            break

    return out, {
        "scoped_candidate_count": len(products),
        "sellable_candidate_count": sellable_candidate_count,
        "output_count": len(out),
        "protected_count": len(protected_products),
        "dropped_unavailable": dropped_unavailable,
        "drop_reasons": {"unavailable": dropped_unavailable},
        "source_counts": dict(Counter(
            (p.get("_evidence") or {}).get("source", "unknown") for p in products
        )),
    }
```

- [ ] **Step 4: Wire observe-only in `app.py`**

After existing `products` are finalized but before `llm.answer()`, add only:

```python
from . import retrieval_policy as _retrieval_policy

_selected_preview, _selection_report = _retrieval_policy.select_context(
    products,
    profile=_retrieval_profile,
    protected_products=[],
    limit=_llm_ctx_limit,
)
_steps.append({
    "name": "retrieval_policy_observe",
    "model": None,
    "tokens_in": 0,
    "tokens_out": 0,
    "time_s": 0,
    "cost_usd": 0,
    "cost_thb": 0,
    "input": {"product_count": len(products)},
    "output": _selection_report,
})
```

Do not replace `products` yet.

- [ ] **Step 5: Run tests and replay gate**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_policy.py docs/test/test_retrieval_evidence.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/retrieval_policy.py
```

Expected: tests pass and runtime output is unchanged except debug steps.

---

## Task 7: Move Protected Product Merge Into Policy

**Files:**
- Modify: `chatbot/shopeechat/retrieval_policy.py`
- Modify: `chatbot/shopeechat/app.py`
- Modify: `docs/test/test_retrieval_policy.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `collect_protected_products(anchor_card, hybrid_anchor_card, ref_regex_products, anchor_compare_ctx) -> list[dict]`

- [ ] **Step 1: Add tests for exact model and compare protection**

Append to `docs/test/test_retrieval_policy.py`:

```python
def test_collect_protected_products_dedupes_by_item_id():
    anchor = {"item_id": 1, "name": "A"}
    ref = [{"item_id": 1, "name": "A duplicate"}, {"item_id": 2, "name": "B"}]
    got = retrieval_policy.collect_protected_products(
        anchor_card=anchor,
        hybrid_anchor_card=None,
        ref_regex_products=ref,
        anchor_compare_ctx={},
    )
    assert [p["item_id"] for p in got] == [1, 2]


def test_collect_protected_products_keeps_compare_order():
    ctx = {
        "current": {"item_id": 10, "name": "current"},
        "previous": {"item_id": 9, "name": "previous"},
    }
    got = retrieval_policy.collect_protected_products(
        anchor_card=None,
        hybrid_anchor_card=None,
        ref_regex_products=[],
        anchor_compare_ctx=ctx,
    )
    assert [p["item_id"] for p in got[:2]] == [10, 9]
```

- [ ] **Step 2: Run failing tests**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_policy.py -v
```

Expected: fail because function does not exist.

- [ ] **Step 3: Implement protected collector**

```python
def collect_protected_products(*, anchor_card: dict | None,
                               hybrid_anchor_card: dict | None,
                               ref_regex_products: list[dict] | None,
                               anchor_compare_ctx: dict | None) -> list[dict]:
    ordered: list[dict] = []
    compare = anchor_compare_ctx or {}
    for key in ("current", "previous"):
        if compare.get(key):
            ordered.append(compare[key])
    for product in (anchor_card, hybrid_anchor_card):
        if product:
            ordered.append(product)
    ordered.extend(ref_regex_products or [])

    out: list[dict] = []
    seen: set[str] = set()
    for product in ordered:
        k = _key(product)
        if k not in seen:
            out.append(product)
            seen.add(k)
    return out
```

- [ ] **Step 4: Replace local merge in `app.py`**

Before replacing runtime behavior, create or select a replay slice that covers:
- item tag direct product
- active product follow-up
- link follow-up
- compare current versus previous
- partial compare: anchor plus model keyword
- exact model regex
- carry-forward model/history

Run that slice once against current code and save the baseline in the active log.

Replace only the blocks that manually insert:
- `anchor_card`
- `_hybrid_anchor_card`
- `_ref_regex_products`
- `_anchor_compare_ctx` current/previous

with:

```python
_protected_products = _retrieval_policy.collect_protected_products(
    anchor_card=anchor_card,
    hybrid_anchor_card=_hybrid_anchor_card,
    ref_regex_products=_ref_regex_products,
    anchor_compare_ctx=_anchor_compare_ctx,
)
products, _selection_report = _retrieval_policy.select_context(
    products,
    profile=_profile,
    protected_products=_protected_products,
    limit=_llm_ctx_limit,
)
```

Keep existing compare notes. This task moves product list ownership, not answer wording.

- [ ] **Step 5: Run targeted regression**

Run:

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_policy.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/retrieval_policy.py
.venv/bin/python docs/test/test_car_charger_regression.py
```

Expected: tests pass. The anchor/compare/follow-up replay slice must keep the same protected products as baseline. If it does not, keep `collect_protected_products()` observe-only and do not replace local merge yet.

---

## Task 8: Add Evidence Coverage For Spec, Warranty, And Compatibility

**Files:**
- Modify: `chatbot/shopeechat/retrieval_policy.py`
- Modify: `chatbot/shopeechat/knowledge_base.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/device_compat.py`
- Modify: `chatbot/shopeechat/app.py`
- Create: `docs/test/test_evidence_requirements.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Evidence keys:
  - `spec`: list of source labels
  - `warranty`: list of source labels
  - `compatibility`: list of source labels
  - `order_history`: list of source labels
- Produces `retrieval_policy.required_evidence(profile) -> frozenset[str]` from the canonical intent/availability mode.
- `select_context(..., evidence_mode="observe|enforce")` receives rollout behavior separately from immutable request facts; this task must use `observe` only.

- [ ] **Step 1: Write failing evidence requirement tests**

Create `docs/test/test_evidence_requirements.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import retrieval_policy, route_context


def _spec_profile() -> route_context.RetrievalProfile:
    return route_context.build_retrieval_profile(
        "A18T สเปคอะไรบ้าง",
        history=[],
        intent_result={"intent": "product_spec", "confidence": 0.95},
        shop="TestShop",
    )


def test_spec_question_reports_no_evidence_without_dropping_yet():
    products = [{"item_id": 1, "name": "A", "_available_for_sale": True}]
    selected, report = retrieval_policy.select_context(
        products, profile=_spec_profile(), limit=5, evidence_mode="observe")
    assert [p["item_id"] for p in selected] == [1]
    assert report["missing_evidence"] == {"spec": 1}
    assert report["dropped_missing_evidence"] == 0


def test_spec_question_keeps_kb_evidence():
    products = [{
        "item_id": 1,
        "name": "A",
        "_available_for_sale": True,
        "_evidence": {"spec": ["kb_products.canonical_specs"]},
    }]
    selected, report = retrieval_policy.select_context(
        products, profile=_spec_profile(), limit=5, evidence_mode="observe")
    assert [p["item_id"] for p in selected] == [1]
    assert report["missing_evidence"] == {}
    assert report["dropped_missing_evidence"] == 0
```

- [ ] **Step 2: Run failing test**

```bash
.venv/bin/python -m pytest docs/test/test_evidence_requirements.py -v
```

Expected: fail because selection does not report evidence coverage yet.

- [ ] **Step 3: Annotate source evidence**

Add evidence metadata at card creation points:

- `product_store.to_product_card()`:
  - `spec`: `["ShpProducts.description"]` only when description/spec fields are actually included.
  - `warranty`: `["ShpProducts.description"]` only when warranty text exists in description or field.
- `units.to_unit_card()`:
  - `spec`: include `sellable_units.desc_sections`, runtime-joined `kb_products.canonical_specs`, and `image_texts.text` only when each field is actually present. The stored unit collection currently has zero populated `canonical_specs`; provenance must be attached after `attach_kb_specs()`, not inferred from the unit schema.
  - `warranty`: include `kb_products.warranty_*` or OCR text when present.
- `knowledge_base.lookup_kb()`:
  - when KB docs are converted/merged, evidence source is `kb_products.canonical_specs` or `kb_products.specs_raw`.
- `device_compat._filter_compat_products()`:
  - set compatibility evidence only when connector/watt/spec check used a real field or web/device spec evidence.
- `order_store.lookup_order()` / order anchors:
  - add `order_history: ["ShpOrders.item_list"]` to order-derived cards even when the item no longer exists in `ShpProducts`.
- `itStock.Products`:
  - annotate only fields actually joined through normalized `shopee_ship_box.item_id/model_id`. Do not label the whole stock document as spec/cert evidence merely because `spec` exists.

Absence rules:
- Missing OCR is `unknown`; only 19.23% of unique unit image IDs currently have `image_texts` rows.
- Missing KB spec/warranty fields are `unknown`, not negative evidence.
- A compatibility mismatch requires an explicit connector/power/protocol contradiction; missing evidence is not incompatibility.

- [ ] **Step 4: Report evidence coverage in selection**

In `select_context()`:

```python
required = required_evidence(profile)
evidence = product.get("_evidence") or {}
missing = [k for k in required if not evidence.get(k)]
for key in missing:
    missing_evidence[key] += 1
if missing and evidence_mode == "enforce":
    dropped_missing_evidence += 1
    continue
```

`required_evidence()` maps canonical intent only: `spec → {"spec"}`, `warranty → {"warranty"}`, `compatibility → {"compatibility"}`, and returns an empty set for recommendation/browse unless another task adds an explicit evidence contract. Do not enforce in this task. `evidence_mode="enforce"` may only be enabled later after gold replay proves that evidence coverage is high enough for that intent/source.

After internal selection and `llm.answer()` have consumed evidence, call `strip_private_evidence()` exactly once while assigning public `ChatResponse.products`. Add an assertion to `test_retrieval_evidence.py` that the serialized product cards contain neither `_evidence` nor `_selection_reason`.

- [ ] **Step 5: Run tests and sensitive replay**

```bash
.venv/bin/python -m pytest docs/test/test_evidence_requirements.py docs/test/test_retrieval_policy.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/knowledge_base.py chatbot/shopeechat/device_compat.py chatbot/shopeechat/retrieval_policy.py
```

Expected: tests pass. Gold report shows evidence coverage gaps, but no product is dropped solely for missing evidence yet.

---

## Task 9: Reduce Product-Family Hardlogic With Route Facts Contract

**Files:**
- Modify: `chatbot/shopeechat/route_context.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/knowledge_base.py`
- Modify: `chatbot/shopeechat/app.py`
- Create: `docs/test/test_route_context_policy.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Consumes `RetrievalProfile` from Task 4; it does not introduce another route-fact shape.
- Keeps `resolve_route(message, intent_result=None) -> RouteContext` as the low-level current-message parser used by `build_retrieval_profile()` and as a temporary fallback for unmigrated callers.
- Removes local product-family/subtype ownership from `app.py` after profile replay passes.
- Moves KB/product evidence merge to `knowledge_base.merge_product_evidence(kb_docs, product_cards) -> list[dict]`; normalized `item_ids` are the first join key, bounded model codes are fallback only.

- [ ] **Step 1: Write route context tests**

Create `docs/test/test_route_context_policy.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import route_context


def test_charger_strong_subtype_adapter():
    got = route_context.resolve_route("มีหัวชาร์จ gan ไหม")
    assert "charger" in got.product_types
    assert got.charger_subtype == "adapter"


def test_cable_subtype_does_not_become_phone_from_iphone_device():
    got = route_context.resolve_route("สายชาร์จที่ใช้กับไอโฟน 13")
    assert "charger" in got.product_types or "cable" in got.product_types
    assert got.charger_subtype == "cable"


def test_powerbank_for_macbook_stays_powerbank_not_charger():
    got = route_context.resolve_route("พาวเวอร์แบงค์ใช้กับ macbook air ได้ไหม")
    assert "powerbank" in got.product_types
    assert "charger" not in got.product_types


def test_earphone_compat_stays_earphone():
    got = route_context.resolve_route("หูฟังใช้กับ iphone 15 ได้ไหม")
    assert "earphone" in got.product_types


def test_smartwatch_compat_stays_smartwatch():
    got = route_context.resolve_route("นาฬิกาใช้กับ android ได้ไหม")
    assert "smartwatch" in got.product_types
```

- [ ] **Step 2: Run failing or current-state tests**

```bash
.venv/bin/python -m pytest docs/test/test_route_context_policy.py -v
```

Expected: current failures identify which hardlogic still lives in `app.py` or `product_store.py`, across charger, powerbank, earphone, and smartwatch.

- [ ] **Step 3: Consolidate only generic subtype parsing**

Move `_STRONG_SUBTYPE_KWS` and the generic current-message subtype precedence needed by `build_retrieval_profile()` from the nested `app.py` closure into `route_context.py`. Do not duplicate the product taxonomy; call the existing `product_store._detect_product_types()` and `_detect_charger_subtype()` helpers. Do not add product/model-specific branches.

- [ ] **Step 4: Replace `app.py` subtype calls with the canonical profile**

Replace calls to nested `_resolve_charger_subtype()` with `_retrieval_profile.subtype`. For a source helper that cannot yet receive the whole profile, pass `subtype=_retrieval_profile.subtype` explicitly and mark that shim for Task 13 deletion. Do not create a second resolver wrapper.

Delete the nested closure and its duplicated keyword table in Task 13 after targeted replay passes.

- [ ] **Step 4A: Remove duplicate candidate generation from the KB branch**

The KB branch currently contains its own model regex Mongo query, direct regex loop, product-type keyword map, charger subtype table, and `_merge_kb_mongo()` owner. Replace them only after the bounded-model regressions pass:
- `knowledge_base.lookup_kb(..., retrieval_profile=profile)` returns KB evidence docs.
- `product_store.fetch_products(..., retrieval_profile=profile)` owns exact model, regex/vector, shop, family, and subtype candidate retrieval.
- `knowledge_base.merge_product_evidence()` joins KB docs to cards by normalized `item_ids` first. The live audit shows all 5,086 KB product item refs join current `ShpProducts` after numeric normalization.
- Use bounded model-code/name matching only when a KB doc has no item IDs.
- Delete the app-local direct regex and charger subtype filters; do not move their keyword tables into the new selector.

Add regression cases for PB100 versus LPB100/PB100P, KB-only discontinued history, comparison with two KB docs, and one KB row with no item IDs.

- [ ] **Step 5: Run regression**

```bash
.venv/bin/python -m pytest docs/test/test_route_context_policy.py -v
.venv/bin/python docs/test/test_car_charger_regression.py
.venv/bin/python -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/route_context.py chatbot/shopeechat/product_store.py
```

Expected: charger regression remains green, non-charger route tests pass, and `app.py` loses product-family/subtype branching.

---

## Task 10: Compatibility Evidence And Negative-Proof Gate

**Files:**
- Create: `docs/test/test_compat_recall_gate.py`
- Modify: `chatbot/shopeechat/app.py`
- Modify: `chatbot/shopeechat/device_compat.py`
- Modify: `chatbot/shopeechat/retrieval_policy.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `device_compat.compat_evidence(product, device_specs, profile) -> dict`.
- Consumes the same `RetrievalProfile` built in Task 4; it must not read type/subtype/device from intent separately when a profile exists.
- Keeps `is_compat_check=True` bypass of unit path in `product_store.fetch_products()`.
- This task may pass `evidence_mode="enforce"` to selection only after Task 8 coverage report and compat gold replay show enough evidence coverage. Otherwise keep compatibility in observe mode.

- [ ] **Step 1: Write compatibility gate tests**

Create `docs/test/test_compat_recall_gate.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import retrieval_policy, route_context


def _mi17_cable_profile() -> route_context.RetrievalProfile:
    return route_context.build_retrieval_profile(
        "อยากได้ที่ใช้กับ mi 17 ultra",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="KingGadgets",
    )


def test_compat_drops_product_without_compat_evidence():
    products = [{"item_id": 1, "name": "unknown cable", "_available_for_sale": True}]
    selected, report = retrieval_policy.select_context(
        products,
        profile=_mi17_cable_profile(),
        limit=10,
        evidence_mode="enforce",
    )
    assert selected == []
    assert report["dropped_missing_evidence"] == 1
    assert report["compatibility_unknown_count"] == 1


def test_compat_keeps_product_with_connector_evidence():
    products = [{
        "item_id": 1,
        "name": "USB-C cable",
        "_available_for_sale": True,
        "_evidence": {"compatibility": ["device_compat.connector:usb-c"]},
    }]
    selected, report = retrieval_policy.select_context(
        products,
        profile=_mi17_cable_profile(),
        limit=10,
        evidence_mode="enforce",
    )
    assert [p["item_id"] for p in selected] == [1]


def test_mi17_sellable_compatible_candidate_beats_dead_candidates():
    products = [
        {
            "item_id": 10,
            "name": "old USB-C cable",
            "_available_for_sale": False,
            "catalog_status": "out_of_stock",
            "_evidence": {"compatibility": ["device_compat.connector:usb-c"]},
        },
        {
            "item_id": 11,
            "name": "live USB-C cable 100W",
            "_available_for_sale": True,
            "catalog_status": "active",
            "_evidence": {
                "compatibility": [
                    "device_compat.connector:usb-c",
                    "device_compat.min_watt:90",
                ],
            },
        },
    ]
    selected, report = retrieval_policy.select_context(
        products,
        profile=_mi17_cable_profile(),
        limit=10,
        evidence_mode="enforce",
    )
    assert [p["item_id"] for p in selected] == [11]
    assert report["dropped_unavailable"] == 1
```

- [ ] **Step 2: Run failing/current tests**

```bash
.venv/bin/python -m pytest docs/test/test_compat_recall_gate.py -v
```

- [ ] **Step 3: Add compatibility evidence annotation**

In `device_compat._filter_compat_products()`, when a product passes due to connector/wattage/device spec, attach:

```python
product["_evidence"]["compatibility"] = ["device_compat.connector:usb-c"]
```

Use exact labels for actual checks:
- `device_compat.connector:<connector>`
- `device_compat.min_watt:<watts>`
- `device_compat.web_specs`
- `device_compat.device_specs_data`

When Task 10 integrates these annotations with selection, update `compatible_candidate_count` to count sellable candidates with positive compatibility evidence, set `compatibility_unknown_count` for sellable candidates with neither positive nor negative proof, and extend `drop_reasons` with `wrong_family_or_subtype`, `connector_mismatch`, `insufficient_power`, and `missing_evidence`. Do not overwrite the availability counts created in Task 6.

- [ ] **Step 4: Make “no compatible product / sold out” a post-selection conclusion**

Negative wording has two separate proofs; do not collapse stock and compatibility:

```python
if answer_claims_all_out_of_stock:
    assert report["scoped_candidate_count"] > 0
    assert report["sellable_candidate_count"] == 0

if answer_claims_no_compatible_product:
    assert report["sellable_candidate_count"] > 0
    assert report["compatible_candidate_count"] == 0
    assert report["compatibility_unknown_count"] == 0
```

The implementation report must distinguish:
- `scoped_candidate_count`: candidates from the requested shop+family+subtype before availability/compat filtering.
- `sellable_candidate_count`: candidates with normalized live availability.
- `compatible_candidate_count`: sellable candidates with positive required compatibility evidence.
- `compatibility_unknown_count`: sellable scoped candidates that lack enough evidence to prove compatible or incompatible.
- `drop_reasons`: counts for unavailable, wrong family/subtype, connector mismatch, insufficient power, and missing evidence.

If `scoped_candidate_count == 0`, say the current search found no matching product; do not call that “all stock exhausted.” If sellable candidates exist but compatibility is unknown, answer “ข้อมูลความเข้ากันได้ยังไม่พอ” or use the existing safe fallback; do not claim the shop has no product or that all stock is exhausted. This is the direct guard against the reported Mi 17 Ultra false-negative.

Wire this in the single pre-LLM compatibility decision in `app.py` using the selection report. Do not add another keyword detector or a post-hoc string replacement in `guards.py`; the decision must come from candidate evidence counts.

- [ ] **Step 5: Promote and replay the corrected Mi 17 Ultra acceptance case**

The current approved gold contains no Mi 17 row. Promote the human correction from the rejected review export into reviewed gold or a committed standalone acceptance file, then add/verify these two rows before running:

```json
{"id":"compat-mi17-history-cable","shop":"KingGadgets","message":"อยากได้ที่ใช้กับ mi 17 ultra","history":[{"role":"user","text":"มีสายชาร์จไหม"}],"intent":"compatibility","expected_product_type":"charger","expected_subtype":"cable","expected_target_device":"mi 17 ultra","expected_answer_mode":"products","requires_evidence":["compatibility"],"must_not_phrases":["ไม่มีสินค้าที่ใช้ได้","สินค้าหมดสต็อกทั้งหมด"]}
{"id":"compat-iphone13-cable","shop":"ZMIThailand","message":"สายชาร์จใช้กับ iPhone 13 ได้ไหม","history":[],"intent":"compatibility","expected_product_type":"charger","expected_subtype":"cable","expected_target_device":"iphone 13","expected_answer_mode":"products","requires_evidence":["compatibility"],"must_not_phrases":["ไม่มีสินค้าที่ใช้ได้","สินค้าหมดสต็อกทั้งหมด"]}
```

Resolve acceptable item/unit ids from the current read-only catalog during the human gold review; do not hardcode a remembered product id in runtime code.

Run evaluator by intent:

```bash
.venv/bin/python -m pytest docs/test/test_compat_recall_gate.py docs/test/test_retrieval_profile.py -v
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl --gold docs/test/gold_retrieval.jsonl --by-intent
```

Expected:
- Before selection, the bounded candidate pool already contains an acceptable sellable item/unit for each positive case. A selector-only pass is not sufficient.
- Compatibility acceptable hit rate does not drop. If it drops, keep enforcement observe-only.
- Both profiles show identical facts at main fetch, compatibility re-query, and final selection.
- The Mi 17 Ultra row returns at least one sellable compatible candidate when current catalog evidence contains one.
- The customer answer does not claim no product/all sold out while `compatible_candidate_count > 0`.

---

## Task 11: Sensitive Flow Gate For Claim, Refund, Tax, Warranty, And Handoff

**Files:**
- Create: `docs/test/test_sensitive_flows.py`
- Modify: `chatbot/shopeechat/handoffs.py`
- Modify: `chatbot/shopeechat/order_store.py`
- Modify: `chatbot/shopeechat/order_flow.py`
- Modify: `chatbot/shopeechat/warranty_flow.py`
- Modify: `chatbot/shopeechat/guards.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces no new major runtime API. Tightens tests around existing response fields:
  - `handoff_to_admin`
  - `handoff_reason`
  - `source`
  - `routing_decision`

- [ ] **Step 1: Write sensitive flow tests**

Create `docs/test/test_sensitive_flows.py`:

```python
from __future__ import annotations

from unittest.mock import MagicMock

from chatbot.shopeechat import guards, order_store


def test_guard_does_not_allow_fake_handoff_text():
    resp = {
        "answer": "เดี๋ยวส่งต่อแอดมินให้นะคะ",
        "handoff_to_admin": False,
        "source": "product_store",
    }
    req = type("Req", (), {"simulate_assignment": False})()
    got = guards.enforce(resp, req)
    assert got["handoff_to_admin"] is False
    assert "ส่งต่อแอดมิน" not in got["answer"]


def test_tax_invoice_requires_handoff_reason():
    resp = {
        "answer": "ส่งต่อแอดมินเรื่องใบกำกับภาษีให้นะคะ",
        "handoff_to_admin": True,
        "handoff_reason": "tax_invoice_request",
        "source": "tax_invoice_handoff",
    }
    req = type("Req", (), {"simulate_assignment": False})()
    got = guards.enforce(resp, req)
    assert got["handoff_to_admin"] is True
    assert got["handoff_reason"] == "tax_invoice_request"


def test_tracking_lookup_checks_indexed_top_level_field(monkeypatch):
    doc = {
        "order_sn": "ORDER1",
        "shopname": "ShopA",
        "tracking_no": "TRACK12345678",
        "package_list": [{"logistics_status": "LOGISTICS_DELIVERY_DONE"}],
        "item_list": [],
    }
    coll = MagicMock()
    coll.find_one.side_effect = [doc, doc]
    monkeypatch.setattr(order_store, "_get_order_collection", lambda: coll)

    got = order_store.lookup_by_tracking("TRACK12345678", shop_filter="ShopA")
    assert got and got["order_sn"] == "ORDER1"
    assert got["tracking_no"] == "TRACK12345678"
    assert coll.find_one.call_args_list[0].args[0] == {
        "tracking_no": "TRACK12345678",
        "shopname": "ShopA",
    }


def test_order_lookup_does_not_retry_outside_current_shop(monkeypatch):
    coll = MagicMock()
    coll.find_one.return_value = None
    monkeypatch.setattr(order_store, "_get_order_collection", lambda: coll)

    assert order_store.lookup_order("ORDER1", shop_filter="ShopA") is None
    coll.find_one.assert_called_once_with({"order_sn": "ORDER1", "shopname": "ShopA"})


def test_old_order_item_survives_without_live_catalog_lookup(monkeypatch):
    coll = MagicMock()
    coll.find_one.return_value = {
        "order_sn": "ORDER1",
        "shopname": "ShopA",
        "item_list": [{"item_id": 999.0, "model_id": 888.0,
                       "item_name": "รุ่นเก่า", "model_quantity_purchased": 1}],
    }
    monkeypatch.setattr(order_store, "_get_order_collection", lambda: coll)

    got = order_store.lookup_order("ORDER1", shop_filter="ShopA")
    assert got["items"][0]["item_id"] == "999"
    assert got["items"][0]["model_id"] == "888"
```

- [ ] **Step 2: Run tests**

```bash
.venv/bin/python -m pytest docs/test/test_sensitive_flows.py -v
```

- [ ] **Step 3: Patch only boundary violations**

If tests fail, fix the boundary in `guards.enforce()` or existing deterministic flow. Do not add LLM prompt rules for these cases. `guards.enforce()` may remove or rewrite fake handoff wording, but it must not set `handoff_to_admin=True` unless an upstream deterministic flow already did the real handoff.

Fix the verified order schema mismatch in `order_store`:
- Query indexed top-level `tracking_no` first, then nested package fields as compatibility fallback.
- In `lookup_order()`, read top-level `tracking_no` when package entries contain status/carrier but no tracking number.
- Keep `shop_filter` on both primary and fallback queries; do not silently return an order from another shop. If a cross-shop diagnostic lookup is still needed, it must not expose order data and must hand off safely.
- Keep the existing `order_flow` minimal-card fallback when an order item is no longer in the live catalog. Annotate that card as order-history evidence when adding it to `conversation_products`; do not add a second order-to-card pipeline.

- [ ] **Step 4: Replay sensitive gold**

Run only gold rows where intent is `claim|refund|tax_invoice|handoff|warranty|order`.

Expected:
- If response says handoff, `handoff_to_admin=True` must already come from a deterministic handoff flow.
- If non-handoff output contains fake handoff wording, guards remove or rewrite the wording and leave `handoff_to_admin=False`.
- Claim/refund/tax do not recommend random products.
- Warranty uses order/product evidence or says admin will check.
- Tracking lookup succeeds for the actual top-level schema and never searches another shop for customer-visible details.

---

## Task 11A: Handoff Assignment Eligibility Policy

**Why this task exists:** The current business rule “old admin first” is unsafe when the old admin is off-duty, not accepting chat, over capacity, disabled, or otherwise unavailable. Assignment must prefer continuity, but only after eligibility. A chat should not wait on an admin who cannot actually receive the work.

**Files:**
- Create: `docs/test/test_handoff_assignment_policy.py`
- Modify: `chatbot/shopeechat/handoffs.py` or the current deterministic handoff owner after a fresh callsite audit
- Modify: admin/workflow assignment code only if the runtime owner is outside `chatbot/shopeechat`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces an assignment policy helper with this shape, adjusted to the actual module owner found during audit:

```python
def choose_handoff_assignee(
    *,
    previous_owner_admin_id: str | None,
    last_successful_owner_admin_id: str | None,
    eligible_admins: list[dict],
    function_key: str | None,
    shop: str | None,
    platform: str = "shopee",
) -> dict:
    """Return assignee or queue decision; old owner is preference after eligibility."""
```

- Tracks these semantics:
  - `current_assigned_admin_id`: admin currently assigned by the system.
  - `last_human_responder_admin_id`: latest admin who actually replied to the customer.
  - `last_successful_owner_admin_id`: latest admin who accepted, replied, or closed the case after handling it.
  - `previous_owner_admin_id`: previous owner used as a continuity preference.
  - `assigned != accepted != successful owner`.

- [ ] **Step 1: Write failing assignment policy tests**

Create `docs/test/test_handoff_assignment_policy.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import handoffs


def _admin(admin_id, *, accepting=True, active=True, capacity=0,
           max_capacity=5, functions=("sales",), shops=("KingGadgets",)):
    return {
        "admin_id": admin_id,
        "accepting": accepting,
        "active": active,
        "capacity": capacity,
        "max_capacity": max_capacity,
        "functions": list(functions),
        "shops": list(shops),
        "disabled": False,
    }


def test_old_owner_wins_only_when_eligible():
    got = handoffs.choose_handoff_assignee(
        previous_owner_admin_id="a1",
        last_successful_owner_admin_id="a1",
        eligible_admins=[_admin("a1"), _admin("a2")],
        function_key="sales",
        shop="KingGadgets",
    )
    assert got["admin_id"] == "a1"


def test_old_owner_off_duty_falls_back_to_eligible_pool():
    got = handoffs.choose_handoff_assignee(
        previous_owner_admin_id="a1",
        last_successful_owner_admin_id="a1",
        eligible_admins=[_admin("a1", accepting=False), _admin("a2")],
        function_key="sales",
        shop="KingGadgets",
    )
    assert got["admin_id"] == "a2"
    assert got["reason"] == "old_owner_not_eligible"


def test_no_eligible_admin_returns_team_queue():
    got = handoffs.choose_handoff_assignee(
        previous_owner_admin_id="a1",
        last_successful_owner_admin_id="a1",
        eligible_admins=[_admin("a1", accepting=False), _admin("a2", capacity=5)],
        function_key="sales",
        shop="KingGadgets",
    )
    assert got["queue"] == "team"
    assert got["admin_id"] is None
```

- [ ] **Step 2: Run tests to verify RED**

```bash
.venv/bin/python -m pytest docs/test/test_handoff_assignment_policy.py -v
```

- [ ] **Step 3: Implement eligibility gates**

Eligibility must check:
- admin is accepting chat.
- admin is inside working hours and not on leave when that data is available.
- admin is active/online according to current policy.
- admin can handle the requested shop/platform/function.
- admin capacity is below max capacity.
- admin is not disabled/suspended.
- active assignment is not past reassignment timeout/SLA.

Assignment order:
1. last successful owner if eligible.
2. eligible admins in the same function/shop.
3. round robin among eligible admins.
4. backup/supervisor/team queue if none are eligible.

Do not update old owner merely because the system assigned an admin. Update successful owner only when an admin accepts, replies, or closes the case after handling it.

- [ ] **Step 4: Wire only the real deterministic handoff owner**

Before editing runtime code, run:

```bash
rg -n "handoff|assigned_to|assign|round robin|round_robin|accepting|capacity|admin" chatbot ChatAdminWeb docs/plans
```

Record the owner module in `getoutofmywaybotkaikrook2.md`. Wire the helper at that owner only. Do not add a second assignment pipeline.

- [ ] **Step 5: Verification**

```bash
.venv/bin/python -m pytest docs/test/test_handoff_assignment_policy.py docs/test/test_sensitive_flows.py -v
git diff --check
```

Expected:
- Previous owner continuity remains when the old owner is eligible.
- Ineligible old owner is skipped instead of blocking the customer.
- Queue fallback is explicit when nobody is eligible.
- A promised handoff still requires real assignment or real queue entry.

---

## Task 11B: Trigger And Workflow Flow Audit

**Why this task exists:** Workflow/trigger behavior is useful and should stay before LLM for deterministic cases, but it must be audited as a state machine boundary. It must not answer over an active human owner, must not fake a handoff, and must not run duplicate retrieval/LLM work after a deterministic action already resolved the turn.

**Files:**
- Create: `docs/test/test_workflow_trigger_audit.py`
- Modify after audit: current workflow/trigger owner modules only
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces no new public API at first. The first deliverable is an audit table and tests around the current owner.
- If runtime changes are needed, introduce a small deterministic gate function rather than spreading checks through `app.py`.

- [ ] **Step 1: Inventory current trigger/workflow callsites**

Run:

```bash
rg -n "workflow|trigger|handoff|ticket_state|assigned_to|bot reply|bot_reply|shadow_replies|storeWorkflowDelivered|getGroupedHistoryForBot" chatbot ChatAdminWeb docs
```

Record in the active log:
- where buffer/debounce happens;
- where workflow/trigger replies are produced;
- how each trigger matches text: exact, contains, keyword-any, keyword-all, regex, fuzzy, semantic, or custom code;
- whether trigger matching normalizes case, punctuation, repeated whitespace, Thai particles, and common typos;
- where bot history is built;
- where handoff is requested;
- where assignment state is checked;
- where the bot is prevented from answering during active human handoff.

- [ ] **Step 2: Write expected flow tests or executable assertions**

Create `docs/test/test_workflow_trigger_audit.py`. If the current runtime owner is TypeScript, write a small Python static test that reads the documented audit result committed in this task, then add the TypeScript test command once the runtime owner is modified. Pin these rules:

```python
def test_flow_order_documented():
    expected_order = [
        "buffer/debounce",
        "load_state_history_assignment",
        "handoff_gate",
        "workflow_trigger",
        "intent_route_context",
        "rag_product_retrieval",
        "llm",
        "search_fallback",
        "handoff_assignment",
    ]
    assert expected_order.index("handoff_gate") < expected_order.index("workflow_trigger")
    assert expected_order.index("workflow_trigger") < expected_order.index("intent_route_context")
```

When the owner module is identified, replace the static flow-order test with module-level checks against that owner in the same task. Do not leave a permanent no-op.

- [ ] **Step 3: Audit rules**

Classify each workflow/trigger:
- deterministic before LLM and safe to return;
- deterministic action that requires handoff assignment;
- informational trigger that can run only when no active human owner exists;
- trigger that should be blocked or delayed while human handoff is active;
- trigger that duplicates RAG/LLM and should be removed or moved.

Every trigger that says “ส่งต่อแอดมิน” must set or call a deterministic handoff path that creates a real assignment or queue entry.

Audit matching behavior explicitly. If the current trigger is exact-match only, document that `"สวัสดีมินเนี่ยน"` will not match `"ดีจ้ามินเนี่ยน"` and decide whether that trigger should remain exact or move to a safer mode. Target trigger match modes:

| Match mode | Use for | Risk rule |
|---|---|---|
| exact | risky commands, state transitions, claim/refund/tax/handoff actions | safest default for sensitive actions |
| contains / keyword-any | greeting, low-risk FAQ, broad informational triggers | must not perform handoff or irreversible actions |
| keyword-all | intent-like deterministic FAQ where all concepts must appear | require tests for false positives |
| regex | structured values such as order numbers, tracking numbers, phone/email patterns | keep patterns bounded and shop/state aware |
| fuzzy | typo-tolerant low-risk greetings/FAQ only | require explicit threshold and negative tests |
| semantic/LLM | not a default trigger mode | use only behind approval, evidence, and handoff gates |

Do not silently convert all exact triggers to fuzzy. Match mode must be stored or derived per trigger so sensitive triggers remain exact while safe greetings can use contains/keyword/fuzzy behavior.

- [ ] **Step 4: Design the target gate**

Target order:

```text
message
  -> buffer/debounce
  -> load conversation state + history + assignment state
  -> human handoff gate
       active accepted owner: bot stops
       owner ineligible/timeout: reassign through Task 11A policy
  -> deterministic workflow/trigger
  -> intent + route_context
  -> RAG/product retrieval
  -> LLM
  -> search fallback
  -> RAG
  -> LLM
  -> handoff assignment policy
```

The audit may conclude that the current ordering is already correct for some triggers. Keep those unchanged and document why.

- [ ] **Step 5: Verification**

Run the tests discovered in the audit. At minimum:

```bash
git diff --check
```

If TypeScript runtime files are modified, also run:

```bash
cd ChatAdminWeb && npx tsc --noEmit
```

Expected:
- Bot does not answer over active accepted human handoff.
- Workflow trigger replies are included in bot history where intended.
- Handoff promises correspond to real assignment/queue state.
- Deterministic triggers still happen before LLM when safe.

---

## Task 12: Make Web Search Reanswer Evidence-Aware

**Files:**
- Modify: `chatbot/shopeechat/web_search.py`
- Modify: `chatbot/shopeechat/retrieval_policy.py`
- Modify: `docs/test/test_retrieval_policy.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- `web_search.reanswer(..., retrieval_profile: RetrievalProfile | None = None)` continues to return the current dict shape.
- It must forward the same profile to both internal `product_store.fetch_products()` calls and merge `_final_products` through `retrieval_policy.select_context()` before returning.
- Web extraction may add evidence/keywords, but it may not replace canonical shop/product family/subtype/target device.

- [ ] **Step 1: Add merge test**

Append:

```python
def test_web_reanswer_union_keeps_original_protected():
    original = [{"item_id": 1, "name": "anchor", "_available_for_sale": True}]
    web = [{"item_id": 2, "name": "web", "_available_for_sale": True}]
    profile = route_context.build_retrieval_profile(
        "รุ่นนี้มีแบตไหม",
        history=[],
        intent_result={"intent": "product_spec", "confidence": 0.95},
        shop="TestShop",
        anchor_cards=original,
    )
    selected, report = retrieval_policy.select_context(
        web,
        profile=profile,
        protected_products=original,
        limit=5,
    )
    assert [p["item_id"] for p in selected] == [1, 2]
```

- [ ] **Step 2: Wire web search result**

Inside `web_search.reanswer()`, after it has products from DB re-query, call `select_context()` using `products_in` as protected when request is an anchor/follow-up/spec/compare context.

- [ ] **Step 3: Run tests**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_policy.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/web_search.py chatbot/shopeechat/retrieval_policy.py
```

Expected: web fallback cannot erase protected anchor products.

---

## Task 13: Remove Duplicate Logic And Clean Comments In Touched Areas

**Files:**
- Modify: `chatbot/shopeechat/app.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/device_compat.py`
- Modify: `chatbot/shopeechat/knowledge_base.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- No new API.
- Deletes only branches proven replaced by tests and replay.

- [ ] **Step 1: Static scan**

Run:

```bash
rg -n "available_for_sale|sold_out|catalog_status|_resolve_charger_subtype|CHARGER-SUBTYPE|Tier merge|Direct regex search" chatbot/shopeechat/app.py chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/device_compat.py
```

Record duplicated blocks in the active log.

- [ ] **Step 2: Delete one replaced block at a time**

For each deleted block:
- name the replacement function
- run the specific unit test
- run `py_compile`
- run the relevant replay slice

Delete only after its replacement gate passes:
- the blind unit-card immediate return in `fetch_products()` after bounded source union owns that decision
- duplicate direct-regex/type/subtype retrieval branches in `app.py` after the canonical profile and KB merge own them
- local item/model ID conversions after `normalize_shopee_id()` covers every touched boundary
- duplicate availability formulas after `resolve_availability()` and live refresh are wired
- the temporary bounded-union rollout setting after final replay acceptance

- [ ] **Step 3: Rewrite comments only in touched areas**

Comment style for touched blocks:

```python
"""Select final product context.

Input: product cards from current retrieval path and protected anchor cards.
Output: product cards for LLM context and debug report.
Calls: retrieval_policy.select_context.
Fallback: keeps protected products when evidence filtering would remove all context.
"""
```

Do not rewrite unrelated historical comments in the whole file.

- [ ] **Step 4: Verify file size and call ownership**

Run:

```bash
wc -l chatbot/shopeechat/app.py chatbot/shopeechat/retrieval_policy.py chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py
rg -n "select_context\\(|resolve_availability\\(|collect_protected_products\\(" chatbot/shopeechat
```

Expected:
- `app.py` does not grow from this plan.
- `retrieval_policy.py` stays focused on profile/protection/selection only.
- availability formulas are not duplicated in `app.py`.

---

## Task 14: Final Replay Gate And Release Readiness

**Files:**
- Modify: `getoutofmywaybotkaikrook2.md`
- Modify: `docs/SRS_SSD.md` if final function inventory changed

**Interfaces:**
- No new runtime interface.

- [ ] **Step 1: Run unit/static checks**

```bash
.venv/bin/python -m pytest docs/test/test_availability.py docs/test/test_retrieval_profile.py docs/test/test_retrieval_slots.py docs/test/test_device_alias_normalization.py docs/test/test_route_mentions.py docs/test/test_candidate_availability_refresh.py docs/test/test_candidate_source_union.py docs/test/test_retrieval_evidence.py docs/test/test_retrieval_policy.py docs/test/test_evidence_requirements.py docs/test/test_compat_recall_gate.py docs/test/test_sensitive_flows.py docs/test/test_handoff_assignment_policy.py docs/test/test_workflow_trigger_audit.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/route_context.py chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/knowledge_base.py chatbot/shopeechat/device_compat.py chatbot/shopeechat/web_search.py chatbot/shopeechat/retrieval_policy.py
```

- [ ] **Step 2: Run targeted existing regressions**

```bash
.venv/bin/python docs/test/test_car_charger_regression.py
.venv/bin/python docs/test/test_charger_subtype.py
```

If a script path does not exist in the current checkout, record it and run the closest existing equivalent under `docs/test/`.

- [ ] **Step 3: Run retrieval evaluator against baseline and gold**

```bash
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl --gold docs/test/gold_retrieval.jsonl --by-intent
```

Acceptance gates:
- No sensitive handoff regression.
- No decrease in compare protected-product hit rate.
- No decrease in exact model acceptable hit rate.
- Compatibility acceptable hit rate does not drop.
- Mi 17 Ultra and iPhone 13 profile facts are identical across main fetch, compat re-query, web re-query (if used), and final selection.
- No answer says no compatible product/all sold out when the report has `compatible_candidate_count > 0`.
- Shopping recommendation live ratio improves or stays equal.
- Must-not violation rate decreases or stays equal.

- [ ] **Step 4: Manual review report**

Write a short report in `getoutofmywaybotkaikrook2.md`:
- changed files
- removed duplicate branches
- metrics before/after
- known limitations left
- whether PR is ready

- [ ] **Step 5: Ask before commit/PR**

Before commit:

```text
สรุป diff:
- ...

ผล test:
- ...

ไฟล์ที่เปลี่ยน:
- ...

อนุมัติให้ commit ไหมครับ?
```

Before PR:

```text
สรุป branch:
- commits
- tests
- known risks

อนุมัติให้เปิด PR ไหมครับ?
```

## What Gets Removed Eventually

Remove only after the owning task passes replay:

| Current logic | Replacement |
|---|---|
| Availability formulas in `app.py`/`units.py` | `product_store.resolve_availability()` |
| Blind unit-card immediate return | bounded unit + legacy candidate union in `fetch_products()` |
| Manual anchor/compare product insertion in `app.py` | `retrieval_policy.collect_protected_products()` |
| Final product filtering/tier merge in `app.py` | `retrieval_policy.select_context()` |
| Charger subtype priority closure in `app.py` | `route_context.build_retrieval_profile()` |
| App-local KB regex/model merge and subtype table | `knowledge_base.merge_product_evidence()` using normalized item IDs first |
| Local float/int/string ID cleanup | `product_store.normalize_shopee_id()` at source boundaries |
| Per-source type/device rediscovery from rewritten queries | the single `RetrievalProfile` passed through all legacy product sources |
| Web search final product replacement | evidence-aware union through `retrieval_policy.select_context()` |
| Flat single-profile handling for multi-product turns | `route_context.build_retrieval_slots()` plus grouped selection |
| Unconditional `old admin first` assignment | old successful owner only after eligibility checks |
| Workflow trigger replies that bypass human handoff state | trigger gate after assignment-state load and before retrieval/LLM |
| Long historical comments in touched blocks | short purpose/input/output/calls/fallback comments |

Do not remove:

| Keep | Reason |
|---|---|
| `conversation_products` | Needed for active product, suggestion, order/claim state |
| `product_store.fetch_products()` | Main bounded candidate gateway for unit and listing sources |
| `units.py` | Required for variant/unit stock and unit-level identity |
| `device_compat` wide legacy sweep | Still required for compatibility recall |
| `guards.enforce()` | Output boundary for handoff and sensitive claims |
| `warranty_flow` / `order_flow` deterministic paths | Sensitive flows must not become LLM-only |

## Known Remaining Limits After This Plan

- `kb_products` spec coverage is partial. Missing spec must remain “ไม่มีข้อมูลพอ” rather than guessed.
- Unit classification has `product_type=null` rows. This plan can avoid over-trusting them but does not rebuild the classifier.
- Device alias normalization is intentionally limited to recognized family prefixes. Unknown shorthand must remain unknown rather than being guessed into a device, especially when it could be a product model code.
- `itStock.Products` currently looks strongest for package/spec join, not direct cert flags by simple key names. Cert search may still depend more on description/OCR unless deeper stock spec parsing is added.
- Compatibility remains partly special because it needs broad recall. Do not force it into unit-only retrieval until recall tests prove it.
- Intent classification remains probabilistic. The profile resolver limits its authority but cannot recover an unstated product family when neither current message, anchor, nor bounded history contains one; that case must clarify rather than guess.
- Multi-slot extraction is deterministic and span-based. If a customer gives constraints without clear product spans, the system should fail open or ask a clarifying question rather than attach the constraint to the wrong slot.
- Mention relation parsing is deterministic, not a full natural-language parser. Truly ambiguous messages such as `หัวชาร์จกับ Mi Watch 8` should remain low-confidence or broad until the customer wording gives a clear relation.
- Handoff eligibility depends on current admin availability/capacity data. If that data is stale or unavailable, assignment must use explicit queue fallback instead of pretending an admin owns the chat.
- Workflow/trigger audit may find TypeScript runtime ownership outside this legacy Shopee plan. Treat those runtime edits as a separate approved task if they exceed docs/audit scope.
- Some old comments outside touched blocks will remain. Cleaning the whole file is a separate documentation cleanup, not part of retrieval correctness.

## Self-Review

Spec coverage:
- Correct product retrieval and selection: Tasks 1-10 and 14.
- 65 shops / many product types: Task 1 gold by shop/type; Task 4 retrieval profile; Task 9 route context; Task 14 replay gates.
- Variant/unit/stock/unlisted/discontinued: Task 2 availability, Task 5 live refresh, Task 5A source recall, Task 7 protected exact products.
- Compare/spec/compat/warranty/history: Tasks 4, 5, 7, 8, 10, 11.
- Multi-product/multi-query turns: Task 4E.
- Device shorthand/alias recall: Task 4F.
- Mention/relation root-cause hardening: Task 4G.
- Intent/history/anchor extraction ownership: Task 4 defines one immutable profile and exact precedence; Tasks 9, 12, and 13 remove secondary owners.
- Mi 17 Ultra false no-product/out-of-stock: Task 4 preserves cable+device facts, Task 4F normalizes compact device aliases, Task 5 refreshes live availability, Task 5A prevents an incomplete unit pool from hiding listing candidates, Task 10 requires compatible-candidate proof before negative wording, Task 14 replays it.
- No hallucinated spec/warranty/compat: Task 8 evidence coverage, Task 10 gated compatibility enforcement, and Task 11 sensitive gates.
- Real human handoff ownership: Tasks 11, 11A, and 11B.
- Trigger/workflow ordering: Task 11B.
- Reduce hardcode and pipeline duplication: Tasks 4, 9, 12, 13.
- Do not bloat code: one new runtime module first, Task 13 file-size check.

Placeholder scan:
- No task contains placeholder wording or deferred implementation language.
- Every runtime interface used later is defined before use.

Type consistency:
- `build_retrieval_profile()` returns one frozen `RetrievalProfile`; no task defines `build_profile()` elsewhere.
- `build_retrieval_slots()` returns frozen `RetrievalSlot` objects and does not replace `RetrievalProfile`; one-slot turns remain backward compatible.
- `resolve_availability()` returns dict keys used by `refresh_candidate_availability()` and `select_context()`.
- `select_context()` consumes `RetrievalProfile` and returns `(list[dict], dict)` in all tasks; rollout-only `evidence_mode` is a separate argument.
- Private evidence keys are `_evidence` and `_selection_reason`; Task 8 strips both at the public response boundary.

Review focus coverage:
- Unavailable exact model: Tasks 2, 4, 7, 14.
- Variant/unit stock: Tasks 2, 5, 14.
- Sensitive policies: Task 11.
- Human ownership continuity: Task 11A.
- Workflow trigger boundary: Task 11B.
- Compatibility: Tasks 4, 5, 10.
- Device shorthand/alias: Task 4F.
- Compare/spec: Tasks 7 and 8.
