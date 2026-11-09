# Zaapi-Primary Evidence And Grounded Recommendation Design

**Status:** Approved by user on 2026-11-03

**Date:** 2026-11-03

**Goal:** Make Zaapi KB the primary factual authority for product knowledge while Shopee catalog and sellable units remain mandatory authorities for product identity and commerce, then close the remaining Phase 10B answer-quality defects without adding semantic guards, keyword rules, or parallel decision owners.

## 1. Decisions

1. Zaapi KB never runs alone. Enabling it requires Shopee catalog and units.
2. Zaapi KB owns product specifications, compatibility statements, FAQ, usage instructions, troubleshooting, and knowledge-backed limitations.
3. Shopee catalog owns listing identity, shop, title, link, image, visibility, and listing status.
4. Units own model/variant identity, stock, price, sellability, and current structured variant facts.
5. Knowledge cannot create a sellable product. A KB record without a resolved catalog/unit identity is supporting knowledge only and cannot produce a product card or availability claim.
6. Runtime answers consume canonical typed evidence. Raw prose remains provenance and model context, not an independent business-decision owner.
7. Existing owners remain: `decide_turn` for needs, retrieval planner/executor for requests, candidate pool for identity union, selection for admission/ranking, AnswerContext for evidence attribution, and composition/finalizer for customer output.

## 2. Source Authority

| Data | Primary authority | Fallback | Conflict behavior |
|---|---|---|---|
| Listing identity, shop, link, image | Shopee catalog | none | unresolved KB cannot create a card |
| Variant/model, stock, price, sellability | units + live Shopee join | listing-level availability | commerce source wins |
| Specifications and protocols | Zaapi canonical KB | structured unit/catalog facts | exact-identity Zaapi record wins; conflict is recorded |
| Compatibility | Zaapi declared compatibility + typed product/device facts | typed unit/catalog facts | unknown remains unknown; no prose-only positive verdict |
| FAQ, usage, troubleshooting | Zaapi canonical KB | attributed catalog description | answer only from identity/topic-scoped evidence |
| Raw description | source provenance and recall | none | never overrides structured commerce state |

Conflicting factual records for the same identity and fact key are not silently averaged or selected by prompt order. The canonical record carries source revision and conflict state. A conflict that changes the customer conclusion produces a bounded limitation/admin-review outcome.

## 3. Canonical KB Records

Every imported Zaapi source is preserved in an immutable raw snapshot and normalized into canonical records. A canonical record contains:

```text
record_id
source_snapshot_id
source_file / sheet / row or text span
shop and platform scope
record_type: spec | compatibility | faq | troubleshooting | policy | note
topic
product identity hints: item_id, model_id, model_codes, aliases
canonical fact keys and typed values
subject and target identities for compatibility
answer text or ordered troubleshooting steps
source revision and content fingerprint
readiness: resolved | unresolved | conflicted | invalid
```

Normalization happens during import/build, not on every customer turn. Unknown fields remain raw with provenance and do not become executable facts. Import is idempotent by source revision plus content fingerprint and supports dry-run, apply, canonical export, and sanitized raw export.

## 4. Typed Product Evidence

Charging products use type-correct facts:

- Power sources (adapter/powerbank): output profiles, `output_power_w`, ports, supported protocols.
- Cables: connector endpoints, `power_capacity_w`, `max_current_a`, data-transfer speed, supported protocols, and declared device-family capability.
- Devices: required connector, target charging ceiling, and required/optional protocols.

`output_power_w` is not reused as cable capacity. A cable can be proven adequate when its connector matches and its typed capacity/current/protocol evidence covers the target requirement. The answer must still state that actual charging power depends on the charger, device negotiation, and protocol support.

For CTC620P, the expected canonical facts include USB-C to USB-C, PD3.1, 6A, cable capacity 240W, and declared Xiaomi support up to 120W with provenance to the exact Zaapi/source-description record. Against Xiaomi 17 Ultra's typed USB-C/90W target, this proves that the cable is not the capacity bottleneck; it does not claim that the cable supplies 120W.

## 5. Retrieval Flow

```text
customer turn
-> TurnPlan / TurnNeed
-> resolve current subject and target identities
-> build retrieval requests per need
-> query mandatory catalog + units
-> query Zaapi KB by shop, need topic, and resolved identities
-> exact code/alias match plus semantic retrieval inside that scope
-> attach KB evidence to matching catalog/unit candidates
-> selection evaluates typed constraints and evidence coverage
-> AnswerContext emits one attributed outcome per need
-> composition answers in customer order
```

Zaapi retrieval is need-scoped, not whole-turn broad search. Exact item/model/code resolution has priority over semantic similarity. Semantic results cannot cross shop or resolved product identity. Unresolved discovery searches may use product family/type scope but cannot assert compatibility or stock until a catalog/unit identity is joined.

Embeddings are built per canonical knowledge unit, not per entire workbook or arbitrary fixed row batch. Retrieval returns bounded evidence records with provenance. Full KB documents are never inserted wholesale into the prompt.

## 6. Central Pool Policy

The runtime source policy validates source dependencies:

```yaml
kb_source: zaapi
pool_sources:
  mongo_catalog: true
  units: true
  kb: true
  image_text: optional
```

`kb_source=zaapi` with catalog or units disabled is invalid configuration and cannot activate. There is no Zaapi-only answer path and no silent fallback to legacy KB. Source adapters contribute to the existing union/pool; they do not create a second selector or finalizer.

## 7. Selection And Presentation

Candidate identity remains variant-granular through stock and evidence evaluation. Customer presentation groups decided candidates by listing identity.

- `recommend`: present one primary product/listing selected by the existing ranking and typed constraints.
- `list` or open discovery: present a bounded set of distinct listings.
- `compare`: present only the compared identities.
- Exact-subject questions: preserve the exact subject; alternatives are separate and cannot replace it.
- Incompatible historical products may be summarized once when relevant but are not recommendation cards.
- Multiple variants of one listing produce one card with the selected/available variant facts.

The UI key uses stable composite identity (`item_id`, `model_id`/`unit_id`, and a final index fallback) so valid variant records cannot produce duplicate React keys.

## 8. Answer Contract

1. Answer the direct conclusion first.
2. Preserve the order of customer asks.
3. Each need has exactly one outcome: grounded answer, typed limitation/no-match, clarification, or admin handoff.
4. Partial evidence answers the supported portion and names only the unsupported portion.
5. Product cards and links follow the conclusion; they do not substitute for it.
6. No positive compatibility, stock, or specification claim may be sourced from another product identity.
7. Model prose cannot override typed decisions or invent missing facts.

## 9. Required Acceptance Cases

The RED corpus includes all observed failures:

- CTC620P recommended for Xiaomi 17 Ultra from exact typed cable evidence, with charger/protocol caveat but no false unknown-wattage warning.
- Xiaomi cable recommendation produces one primary listing, not three products plus an incompatible historical card.
- `หัวชาร์จละ` carries Xiaomi 17 Ultra as target, changes subtype to adapter, and presents one listing card per item.
- PB150S reports sold-out CN variant and available GB variant accurately without four duplicate cards.
- PB100P Global answers PD3.0/PPS 5A from the exact Zaapi KB record and does not borrow another model's facts.
- CMC615P speed uses exact-item description/KB evidence only.
- W01 GPS/pace/heart-rate display/Strava remains cannot-confirm when exact evidence is absent.
- Greeting turns do not emit stale product answers.
- 10Gbps plus magnetic evaluates both typed constraints and returns an honest no-match when no product proves both.
- Multi-question turns answer every supported need in customer order and do not combine positive and unanswered outcomes for one need.
- Cross-shop and cross-item KB leakage is rejected.

## 10. Verification Gates

1. Record baseline answers and test counts before implementation.
2. Add executable RED tests at the real owner boundaries; source-text assertions alone are insufficient.
3. Implement one owner-level correction at a time and make its RED test GREEN.
4. Run focused suites after each task.
5. Run the full affected Phase 4-10B regression and both test orders used to detect global-state leakage.
6. Run real Mongo read-only plus real Gemini acceptance with web, OpenRouter, vision, and Mongo writes blocked.
7. Review customer-facing answers manually, not only route/trace success.
8. Require zero new unexplained regressions, zero cross-product evidence, zero duplicate cards, and zero ungrounded positive claims.
9. Report net helpers, guards, regexes, keyword tables, heuristic mechanisms, and decision owners. No increase is allowed without explicit user approval.

## 11. Delivery Order

1. Independently review and either commit or reject the current 19-file candidate diff.
2. Implement typed product evidence and generation/import normalization.
3. Implement canonical Zaapi KB import/export and indexes.
4. Implement identity-bound, need-scoped Zaapi retrieval.
5. Enforce source dependencies and wire evidence into the existing pool.
6. Correct recommendation cardinality, listing-level presentation, and UI identity.
7. Run offline regression and live acceptance.
8. Commit implementation and closeout documentation separately.

Workflow runtime/node work, prompt distillation, and logging/analytics remain separate programs. They consume the final evidence and execution contracts but do not block this design from being reviewed and planned.
