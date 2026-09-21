# Legacy Shopee Evidence Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make legacy Shopee product retrieval evidence-first so the bot selects the right product/unit, refuses to invent spec/warranty/compatibility, and remains easy to debug without bloating `app.py`.

**Architecture:** Keep current retrieval sources, but add one small evidence/selection contract that sits after source retrieval and before LLM context shaping. Do not rewrite the bot. First measure current behavior, then make availability one owner, then add evidence reporting in observe-only mode before any enforcement, then move final selection policy out of `app.py` in small no-regression steps.

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
- Keep unit path bypass for `is_compat_check=True` until compatibility recall proves unit can replace legacy sweep.
- Exact unavailable products may be shown for spec, warranty, order history, and discontinued/unlisted questions.
- Shopping recommendation must not recommend unavailable products unless the answer explicitly says unavailable and uses it only as history/spec evidence.
- `guards.enforce()` must never pretend a handoff happened. If no deterministic flow set `handoff_to_admin=True`, guards may remove or rewrite fake handoff wording, but must not mark a real handoff.
- Every runtime task that changes `chatbot/shopeechat/` must update `docs/SRS_SSD.md` section 6 and `getoutofmywaybotkaikrook2.md`.
- Before first commit for this work and before PR, summarize diff, test result, changed files, and ask the user.

## Review Focus

- **Unavailable exact model:** Customer asks about a discontinued/unlisted/out-of-stock model they bought before. Expected: answer spec/warranty/history from evidence, not recommend it as buyable.
- **Variant/unit stock:** Listing has many variants but only some have stock. Expected: pick the matching sellable unit, not the parent listing or a dead variant.
- **Sensitive policies:** Claim, warranty, refund, tax invoice, and human handoff. Expected: deterministic or evidence-backed response; if handoff is promised, `handoff_to_admin=True`.
- **Compatibility:** Customer asks whether an item works with an existing device. Expected: preserve requested shop/family/subtype/device across every source, answer only from compatible evidence, and never claim no product/all sold out while a sellable compatible candidate exists; say not enough info when evidence is missing.
- **Compare/spec:** Customer compares products or asks specs. Expected: include both compared products and quote only fields from `ShpProducts`, `kb_products`, `kb_qa`, `image_texts`, `ShpOrders`, or `itStock.Products`.

---

## Current Data Facts From Audit

These facts shape the plan and must be rechecked if the data is rebuilt.

| Source | Count / Coverage | Meaning |
|---|---:|---|
| `ShpProducts` | 11,692 listings | Main live Shopee product source |
| `ShpProducts.item_status=NORMAL` | 3,360 listings | Listing-level active set |
| `ShpProducts` with positive `model.stock_info_v2.seller_stock` | 2,088 listings / 5,467 units | Real sellable units are fewer than active listings |
| `sellable_units` | 27,843 units | Unit/variant index |
| `sellable_units.sellable=True` | 5,490 units | Snapshot of sellable unit candidates |
| `sellable_units.product_type=null` | 2,641 units | Classification gap that can cause wrong route/pool |
| `kb_products` | 1,011 docs | Canonical product/spec KB |
| `kb_products.canonical_specs` | 511 docs | Spec coverage is partial |
| `kb_products.item_ids` | 539 docs | Product link coverage is partial |
| `kb_qa` | 393 docs | FAQ/troubleshooting/policy QA |
| `image_texts` | 14,005 docs, 13,987 with text | OCR evidence source |
| `ShpOrders` | 3,833,931 orders | Order/history/warranty source |
| `itStock.Products` | 8,847 docs | Stock/spec package source; join through `shopee_ship_box.item_id/model_id` |
| `product_embeddings.npz` | 11,503 rows | Listing semantic search |
| `unit_embeddings.npz` | 27,807 rows | Unit semantic search |
| `qa_embeddings.npz` | 392 rows | QA semantic search |

## Target Runtime Flow

The final shape after this plan should be:

```text
app.py
  resolve request state, deterministic flows, route facts
  return early for order/claim/tax/human/general when deterministic
  build one retrieval_profile before the first product source retrieval
  pass that same immutable profile to every product source/re-query
  call retrieval_policy.select_context()
  call llm.answer()
  call guards.enforce()
  record suggestion state

product_store.py
  ShpProducts source, listing cards, vector/regex search
  unit gateway remains at start of fetch_products()
  shared resolve_availability()

units.py
  unit source, unit cards, live listing join
  no final LLM context policy

knowledge_base.py
  KB product/QA source and evidence text
  no product ranking owner

device_compat.py
  compatibility evidence and compatibility filter
  no final tier/context owner after migration

retrieval_policy.py
  protected product merge, availability-aware final selection,
  evidence coverage report, diversity, final LLM product context
```

`retrieval_policy.py` must not become a second `app.py`. Route facts stay in `route_context.py`, source evidence annotations stay in source modules, and sensitive handoff decisions stay in deterministic flows plus `guards.enforce()`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `docs/test/eval_retrieval.py` | create or finish from Plan 1 | Offline metrics for retrieval pool and gold set |
| `docs/test/gold_retrieval.jsonl` | create | Human-reviewed gold set |
| `docs/test/test_availability.py` | create | Unit tests for availability resolver |
| `docs/test/test_retrieval_profile.py` | create | Canonical message/history/intent/anchor reconciliation tests |
| `docs/test/test_retrieval_evidence.py` | create | Evidence card contract tests |
| `docs/test/test_retrieval_policy.py` | create | Ranking/diversity/protected merge tests |
| `docs/test/test_sensitive_flows.py` | create | Claim/warranty/refund/tax/handoff regression tests |
| `chatbot/shopeechat/route_context.py` | modify | Sole owner of canonical `RetrievalProfile` from message/history/intent/anchors |
| `chatbot/shopeechat/product_store.py` | modify | `resolve_availability()`, listing card integration, source annotations |
| `chatbot/shopeechat/units.py` | modify | Use shared availability and profile, emit unit evidence fields |
| `chatbot/shopeechat/retrieval_policy.py` | create | Final context selection owner |
| `chatbot/shopeechat/app.py` | modify gradually | Replace local merge/rank/availability formulas with `retrieval_policy` calls |
| `chatbot/shopeechat/device_compat.py` | modify later | Return compatibility evidence fields, not final context policy |
| `chatbot/shopeechat/web_search.py` | modify later | Merge web reanswer candidates through policy instead of replacing context |
| `docs/SRS_SSD.md` | modify with runtime changes | Function docs and call relationships |
| `getoutofmywaybotkaikrook2.md` | modify each task | Waythrough log |

## Interfaces To Introduce

The plan intentionally introduces only one new runtime module first. It has exactly one request-fact owner: `route_context`. `intent_classifier` proposes facts, but it never owns the final retrieval request; `retrieval_policy` consumes the resolved profile and must not rebuild it.

```python
# chatbot/shopeechat/product_store.py
def resolve_availability(card_or_doc: dict, *, model_doc: dict | None = None) -> dict:
    """Return normalized availability facts for listing or unit data."""
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

- [ ] **Step 1: Write failing validator test**

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

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
.venv/bin/python -m pytest docs/test/test_validate_gold_retrieval.py -v
```

Expected: fail because `validate_gold_retrieval.py` does not exist.

- [ ] **Step 3: Implement validator**

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

- [ ] **Step 4: Build first human-reviewed gold set**

Create at least 60 rows in `docs/test/gold_retrieval.jsonl`:

Do not require the user to draft all rows manually. First generate candidate rows from existing replay files, then the user reviews/edits/approves them.

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

Implement `draft_gold_retrieval.py` to read both replay result shapes, dedupe by normalized `(shop, message)`, map only fields present in the source, and emit deterministic JSONL ordered by intent then stable case id. Run it before human review:

```bash
.venv/bin/python docs/test/draft_gold_retrieval.py \
  docs/test/results/unit_reg_questions_2026-09-18.jsonl \
  docs/test/results/test_200_selected100.json \
  > docs/test/gold_retrieval.draft.jsonl
```

The approved file is copied to `docs/test/gold_retrieval.jsonl` only after human review.

- [ ] **Step 5: Run validator and baseline**

Run:

```bash
.venv/bin/python docs/test/validate_gold_retrieval.py docs/test/gold_retrieval.jsonl
.venv/bin/python docs/test/eval_retrieval.py docs/test/results/unit_reg_questions_2026-09-18.jsonl --gold docs/test/gold_retrieval.jsonl --by-intent
```

Expected: validator passes. Baseline report is saved or copied into the active log before runtime changes.

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

- [ ] **Step 1: Write failing resolver tests**

Create `docs/test/test_availability.py`:

```python
from __future__ import annotations

from chatbot.shopeechat import product_store


def test_normal_positive_seller_stock_is_active():
    doc = {"item_status": "NORMAL"}
    model = {"model_status": "MODEL_NORMAL", "stock_info_v2": {"seller_stock": [{"stock": 3}]}}
    got = product_store.resolve_availability(doc, model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["answerable"] is True
    assert got["total_stock"] == 3


def test_normal_zero_stock_is_out_of_stock_but_answerable():
    doc = {"item_status": "NORMAL"}
    model = {"model_status": "MODEL_NORMAL", "stock_info_v2": {"seller_stock": [{"stock": 0}]}}
    got = product_store.resolve_availability(doc, model_doc=model)
    assert got["catalog_status"] == "out_of_stock"
    assert got["available_for_sale"] is False
    assert got["answerable"] is True


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

Add implementation near current availability helpers:

```python
def _stock_from_model(model_doc: dict | None) -> int | None:
    if not model_doc:
        return None
    info = model_doc.get("stock_info_v2") or {}
    total = 0
    seen = False
    for row in info.get("seller_stock") or []:
        try:
            total += int(row.get("stock") or 0)
            seen = True
        except Exception:
            continue
    return total if seen else None


def resolve_availability(card_or_doc: dict, *, model_doc: dict | None = None) -> dict:
    status = str(card_or_doc.get("item_status") or card_or_doc.get("status") or "").upper()
    model_status = str((model_doc or card_or_doc).get("model_status") or "").upper()
    stock = _stock_from_model(model_doc)
    if stock is None:
        raw_stock = card_or_doc.get("stock", card_or_doc.get("total_stock"))
        try:
            stock = int(raw_stock) if raw_stock is not None else None
        except Exception:
            stock = None

    if status == "NORMAL" and (not model_status or model_status == "MODEL_NORMAL"):
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
- `to_product_card()` adds `catalog_status`, `_available_for_sale`, `sold_out`, `stock`.
- `units._live_sellable()` calls `product_store.resolve_availability(unit)["available_for_sale"]`.
- `units.to_unit_card()` uses resolver result.
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

**Files:**
- Modify: `chatbot/shopeechat/route_context.py`
- Modify: `chatbot/shopeechat/app.py`
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Modify: `chatbot/shopeechat/device_compat.py`
- Modify: `chatbot/shopeechat/web_search.py`
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

- [ ] **Step 1: Write failing profile ownership and precedence tests**

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

- [ ] **Step 2: Run the profile test and confirm the missing owner**

```bash
.venv/bin/python -m pytest docs/test/test_retrieval_profile.py -v
```

Expected: fail because `RetrievalProfile` and `build_retrieval_profile()` do not exist. Record current outputs for the two Mi 17 Ultra cases before implementation.

- [ ] **Step 3: Add the immutable profile and bounded fact helpers**

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

- [ ] **Step 4: Implement deterministic reconciliation precedence**

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

- [ ] **Step 5: Build the profile once in `app.py`**

After intent classification and after active/tagged anchor cards are available, but before the first product-candidate retrieval, build one profile:

```python
from . import route_context as _route_context

_retrieval_profile = _route_context.build_retrieval_profile(
    req.message,
    history=history,
    intent_result=_intent_result,
    shop=req.shop,
    platform=req.platform,
    anchor_cards=[p for p in (anchor_card, _hybrid_anchor_card) if p],
)
```

Do not rebuild the profile when `retrieval_message` is rewritten. `retrieval_message` is a source query; `_retrieval_profile` remains the customer request contract.

- [ ] **Step 6: Pass the same profile through every legacy product-candidate path**

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
```

Use `if TYPE_CHECKING: from .route_context import RetrievalProfile` plus postponed annotations in modules where a runtime import would form a cycle. Do not weaken the public plan contract to `object` or `dict` merely to avoid import cycles.

Migration rule: when `retrieval_profile` is present, use its `shop`, `product_types`, `subtype`, `target_device`, `availability_mode`, and `compat_mode`; do not call `resolve_route()` or trust a generated query to rediscover those facts. When absent, keep the current path unchanged until all legacy callsites are migrated.

Audit and wire this exact legacy matrix:

| Path | Current calls | Required profile behavior |
|---|---:|---|
| Main and alternative product retrieval in `app.py` | 8 `product_store.fetch_products()` callsites | pass `_retrieval_profile` unchanged |
| Unit gateway inside `product_store.fetch_products()` | 1 `units.fetch_unit_cards()` path | forward the same profile; no second `resolve_route(message)` |
| Compatibility re-query in `device_compat.py` | 3 `product_store.fetch_products()` callsites | use profile family/subtype/device even when local query adds connector keywords |
| Web-search DB re-query in `web_search.py` | 2 `product_store.fetch_products()` callsites | preserve original profile; web keywords may add recall but cannot replace family/device |
| KB/Mongo merge in legacy `app.py` | included in the 8 app callsites | pass profile to both initial and missing-model fallback fetches |
| Direct regex/model candidate branches in `app.py` | direct Mongo candidate paths | scope with profile facts and send candidates through the same selector |

Do not change the three `chat_v2.py` callsites in this plan.

- [ ] **Step 7: Remove secondary extraction from consumers only after wiring**

For profile-backed calls:
- `product_store.fetch_products()` uses `profile.product_types` and `profile.subtype` rather than detecting from rewritten `message`.
- The unit gate and `units.fetch_unit_cards()` receive the profile rather than calling `resolve_route(message)` again.
- `device_compat._device_spec_lookup()` uses `profile.target_device`, `profile.product_types`, and `profile.subtype`; intent fields become fallback only when no profile was supplied.
- `web_search.reanswer()` must not let extractor `product_type` replace `profile.product_types`.
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

## Task 5: Reconcile Legacy Candidates With Live Unit Stock

**Files:**
- Modify: `chatbot/shopeechat/product_store.py`
- Modify: `chatbot/shopeechat/units.py`
- Create: `docs/test/test_legacy_candidate_reconciliation.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Produces `product_store.reconcile_candidates(products: list[dict], *, profile: RetrievalProfile) -> tuple[list[dict], dict]`.
- Consumes availability facts from Task 2 and `RetrievalProfile` from Task 4.
- Compatibility annotation remains in `device_compat` (Task 10) to avoid a circular `product_store ↔ device_compat` owner.

- [ ] **Step 1: Write failing reconciliation tests**

Create `docs/test/test_legacy_candidate_reconciliation.py`:

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


def test_listing_with_sellable_variant_is_not_reported_as_sold_out():
    products = [{
        "item_id": 1,
        "name": "หัวชาร์จ 120W",
        "status": "NORMAL",
        "catalog_status": "out_of_stock",
        "_available_for_sale": False,
        "variants": [
            {"model_id": 11, "name": "ขาว", "stock": 0},
            {"model_id": 12, "name": "ดำ", "stock": 5},
        ],
    }]
    got, report = product_store.reconcile_candidates(
        products, profile=_profile("มีหัวชาร์จไหม"))
    assert got[0]["catalog_status"] == "active"
    assert got[0]["_available_for_sale"] is True
    assert report["revived_by_variant_stock"] == 1


def test_requested_variant_out_but_other_variant_available_is_explicit():
    products = [{
        "item_id": 1,
        "name": "สายชาร์จ CTC315P",
        "status": "NORMAL",
        "_available_for_sale": True,
        "variants": [
            {"model_id": 11, "name": "สีขาว", "stock": 0},
            {"model_id": 12, "name": "สีดำ", "stock": 3},
        ],
    }]
    profile = _profile("สายชาร์จ CTC315P สีขาว")
    assert profile.variant_terms == ("สีขาว",)
    got, report = product_store.reconcile_candidates(products, profile=profile)
    assert got[0]["requested_variant_status"] == "out_of_stock"
    assert got[0]["has_other_sellable_variants"] is True
```

- [ ] **Step 2: Run failing tests**

```bash
.venv/bin/python -m pytest docs/test/test_legacy_candidate_reconciliation.py -v
```

Expected: fail because `reconcile_candidates()` does not exist.

- [ ] **Step 3: Implement reconciliation**

Rules:
- Do not trust listing-level `sold_out` if variants/model stock say otherwise.
- If any variant/model has stock > 0, the listing is not globally sold out.
- If the requested variant is out but another variant is available, mark that explicitly. Do not answer “สินค้าหมด” globally.
- Reconciliation should annotate availability and return a report; final dropping still belongs to `retrieval_policy.select_context()`.
- Do not import `device_compat` here. Connector/power evidence is annotated in Task 10.

- [ ] **Step 4: Wire after every legacy fetch**

In `app.py`, after calls to `product_store.fetch_products()` and before merge/rank/LLM, call:

```python
products, _reconcile_report = product_store.reconcile_candidates(products, profile=_retrieval_profile)
```

Append `_reconcile_report` to `_steps`.

- [ ] **Step 5: Run regression**

```bash
.venv/bin/python -m pytest docs/test/test_legacy_candidate_reconciliation.py -v
.venv/bin/python -m py_compile chatbot/shopeechat/product_store.py chatbot/shopeechat/app.py
```

Expected: legacy results no longer globally report sold out when a sellable variant exists; compatibility flags are added separately in Task 10 before final LLM context selection.

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
    return f"item:{product.get('item_id')}"


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
  - `spec`: include `sellable_units.desc_sections`, `kb_products.canonical_specs`, `image_texts.text` when present.
  - `warranty`: include `kb_products.warranty_*` or OCR text when present.
- `knowledge_base.lookup_kb()`:
  - when KB docs are converted/merged, evidence source is `kb_products.canonical_specs` or `kb_products.specs_raw`.
- `device_compat._filter_compat_products()`:
  - set compatibility evidence only when connector/watt/spec check used a real field or web/device spec evidence.

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
- Modify: `chatbot/shopeechat/app.py`
- Create: `docs/test/test_route_context_policy.py`
- Modify: `docs/SRS_SSD.md`
- Modify: `getoutofmywaybotkaikrook2.md`

**Interfaces:**
- Consumes `RetrievalProfile` from Task 4; it does not introduce another route-fact shape.
- Keeps `resolve_route(message, intent_result=None) -> RouteContext` as the low-level current-message parser used by `build_retrieval_profile()` and as a temporary fallback for unmigrated callers.
- Removes local product-family/subtype ownership from `app.py` after profile replay passes.

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

- [ ] **Step 5: Run regression**

```bash
.venv/bin/python -m pytest docs/test/test_route_context_policy.py -v
.venv/bin/python docs/test/test_car_charger_regression.py
.venv/bin/python -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/route_context.py chatbot/shopeechat/product_store.py
```

Expected: charger regression remains green, non-charger route tests pass, and `app.py` loses product-family/subtype branching.

---

## Task 10: Compatibility Recall Gate Before Any Unit-First Change

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

- [ ] **Step 5: Replay compatibility gold and the reported Mi 17 Ultra flow**

Add two human-reviewed gold rows before running:

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
- Compatibility acceptable hit rate does not drop. If it drops, keep enforcement observe-only.
- Both profiles show identical facts at main fetch, compatibility re-query, and final selection.
- The Mi 17 Ultra row returns at least one sellable compatible candidate when current catalog evidence contains one.
- The customer answer does not claim no product/all sold out while `compatible_candidate_count > 0`.

---

## Task 11: Sensitive Flow Gate For Claim, Refund, Tax, Warranty, And Handoff

**Files:**
- Create: `docs/test/test_sensitive_flows.py`
- Modify: `chatbot/shopeechat/handoffs.py`
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

from chatbot.shopeechat import guards


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
```

- [ ] **Step 2: Run tests**

```bash
.venv/bin/python -m pytest docs/test/test_sensitive_flows.py -v
```

- [ ] **Step 3: Patch only boundary violations**

If tests fail, fix the boundary in `guards.enforce()` or existing deterministic flow. Do not add LLM prompt rules for these cases. `guards.enforce()` may remove or rewrite fake handoff wording, but it must not set `handoff_to_admin=True` unless an upstream deterministic flow already did the real handoff.

- [ ] **Step 4: Replay sensitive gold**

Run only gold rows where intent is `claim|refund|tax_invoice|handoff|warranty|order`.

Expected:
- If response says handoff, `handoff_to_admin=True` must already come from a deterministic handoff flow.
- If non-handoff output contains fake handoff wording, guards remove or rewrite the wording and leave `handoff_to_admin=False`.
- Claim/refund/tax do not recommend random products.
- Warranty uses order/product evidence or says admin will check.

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
.venv/bin/python -m pytest docs/test/test_availability.py docs/test/test_retrieval_profile.py docs/test/test_legacy_candidate_reconciliation.py docs/test/test_retrieval_evidence.py docs/test/test_retrieval_policy.py docs/test/test_evidence_requirements.py docs/test/test_compat_recall_gate.py docs/test/test_sensitive_flows.py -v
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
| Manual anchor/compare product insertion in `app.py` | `retrieval_policy.collect_protected_products()` |
| Final product filtering/tier merge in `app.py` | `retrieval_policy.select_context()` |
| Charger subtype priority closure in `app.py` | `route_context.build_retrieval_profile()` |
| Per-source type/device rediscovery from rewritten queries | the single `RetrievalProfile` passed through all legacy product sources |
| Web search final product replacement | evidence-aware union through `retrieval_policy.select_context()` |
| Long historical comments in touched blocks | short purpose/input/output/calls/fallback comments |

Do not remove:

| Keep | Reason |
|---|---|
| `conversation_products` | Needed for active product, suggestion, order/claim state |
| `product_store.fetch_products()` | Main gateway and already owns unit-first fallback |
| `units.py` | Required for variant/unit stock and unit-level identity |
| `device_compat` wide legacy sweep | Still required for compatibility recall |
| `guards.enforce()` | Output boundary for handoff and sensitive claims |
| `warranty_flow` / `order_flow` deterministic paths | Sensitive flows must not become LLM-only |

## Known Remaining Limits After This Plan

- `kb_products` spec coverage is partial. Missing spec must remain “ไม่มีข้อมูลพอ” rather than guessed.
- Unit classification has `product_type=null` rows. This plan can avoid over-trusting them but does not rebuild the classifier.
- `itStock.Products` currently looks strongest for package/spec join, not direct cert flags by simple key names. Cert search may still depend more on description/OCR unless deeper stock spec parsing is added.
- Compatibility remains partly special because it needs broad recall. Do not force it into unit-only retrieval until recall tests prove it.
- Intent classification remains probabilistic. The profile resolver limits its authority but cannot recover an unstated product family when neither current message, anchor, nor bounded history contains one; that case must clarify rather than guess.
- Some old comments outside touched blocks will remain. Cleaning the whole file is a separate documentation cleanup, not part of retrieval correctness.

## Self-Review

Spec coverage:
- Correct product retrieval and selection: Tasks 1-10 and 14.
- 65 shops / many product types: Task 1 gold by shop/type; Task 4 retrieval profile; Task 9 route context; Task 14 replay gates.
- Variant/unit/stock/unlisted/discontinued: Task 2 availability, Task 5 legacy/unit reconciliation, Task 7 protected exact products.
- Compare/spec/compat/warranty/history: Tasks 4, 5, 7, 8, 10, 11.
- Intent/history/anchor extraction ownership: Task 4 defines one immutable profile and exact precedence; Tasks 9, 12, and 13 remove secondary owners.
- Mi 17 Ultra false no-product/out-of-stock: Task 4 preserves cable+device facts, Task 5 normalizes live availability, Task 10 requires compatible-candidate proof before negative wording, Task 14 replays it.
- No hallucinated spec/warranty/compat: Task 8 evidence coverage, Task 10 gated compatibility enforcement, and Task 11 sensitive gates.
- Reduce hardcode and pipeline duplication: Tasks 4, 9, 12, 13.
- Do not bloat code: one new runtime module first, Task 13 file-size check.

Placeholder scan:
- No task contains placeholder wording or deferred implementation language.
- Every runtime interface used later is defined before use.

Type consistency:
- `build_retrieval_profile()` returns one frozen `RetrievalProfile`; no task defines `build_profile()` elsewhere.
- `resolve_availability()` returns dict keys used by `reconcile_candidates()` and `select_context()`.
- `select_context()` consumes `RetrievalProfile` and returns `(list[dict], dict)` in all tasks; rollout-only `evidence_mode` is a separate argument.
- Private evidence keys are `_evidence` and `_selection_reason`; Task 8 strips both at the public response boundary.

Review focus coverage:
- Unavailable exact model: Tasks 2, 4, 7, 14.
- Variant/unit stock: Tasks 2, 5, 14.
- Sensitive policies: Task 11.
- Compatibility: Tasks 4, 5, 10.
- Compare/spec: Tasks 7 and 8.
