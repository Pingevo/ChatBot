# Phase 4 Final Audit Before Task 5

## Scope

- Legacy Shopee path only (`chatbot/shopeechat/`).
- Audit/review only — no runtime retrieval wiring, no behavior change.
- Verified against actual code + git log on `feature-legacy-shopee-evidence-retrieval` (2026-09-23).

## Phase 4 Inventory

| Phase | Commit | Main files | Runtime effect | Purpose |
|---|---|---|---|---|
| 4A | `ab91602` | route_context.py, tests | none (contract) | `RetrievalProfile` — owner กลางของ request facts |
| 4B | `c55e24c` | app.py | observe-only | build profile ครั้งเดียวก่อน KB; `profile_debug` ใน _steps |
| 4C | `bee45ac` | app.py, product_store, units, knowledge_base, web_search | hint pass-through | ส่ง profile เข้า legacy product/KB/unit/compat/web callsites |
| 4D | `2cdcb9b` | product_store.py, units.py | **yes (soft hints)** | profile-aware hints ใน retrieval (subtype fail-open) |
| 4E | `286c4e3` | route_context.py, tests | none (contract) | `RetrievalSlot` + `build_retrieval_slots` — multi-product contract |
| 4F | `9620022` (+docs `f3e2467`) | device_compat.py, device_specs_data.py, route_context.py, tests | **yes (profile path)** | canonical device alias normalization; alias≠model_code separation |
| 4G | `b7fe0a9` | route_context.py, tests | none (contract) | `RetrievalRelation` + `build_retrieval_relations` — product-to-product mention parser |

Docs-only plan commits: `51b1335` (multi-slot/handoff plan), `943058e` (4F/4G spec), `f3e2467` (4F hardening spec).

## Current Flow

```text
message + history + intent_result + shop + anchor_cards
→ build_retrieval_profile          [runtime: app.py:1754, once]
→ (runtime) profile hints → fetch_products / units / KB / compat / web   [4C/4D]
→ build_retrieval_slots(profile)   [contract-only — tests only]
→ build_retrieval_relations(profile, slots)  [contract-only — tests only]
```

Runtime retrieval consumes **profile fields only**. Slots and relations are parsed contracts with zero runtime callers (verified: no references outside `route_context.py` and `docs/test/`).

## Contract Review

### RetrievalProfile (route_context.py)

- **Fields:** platform, shop, message, intent, product_types (frozenset), subtype, model_codes, variant_terms, target_device, availability_mode, compat_mode, anchor_item_ids, fact_sources.
- **Owner:** `build_retrieval_profile` — single reconcile point; precedence per field (current msg → anchor → intent≥0.7 → history).
- **Hard filter candidates:** `shop`, `platform` (already hard), `model_codes` exact lookup, `availability_mode` (only after availability resolver consumes it), explicit `product_types` when confidence is high.
- **Soft hint candidates:** `subtype` (weak subtype is fail-open in 4D), `target_device`, `compat_mode`, `variant_terms`, history-derived types.
- **Risks:** single `subtype` field can't hold multi-product requests (4E exists for that); `target_device` mixes "device being asked about" with "device compatibility context"; wattage tokens (e.g. `240W`) still leak into `model_codes` — real product codes exist in that shape so it needs context-aware resolution, not blanket filtering.

### RetrievalSlot (route_context.py)

- **Fields:** slot_id, source_span, product_types, subtypes, primary_subtype, brand_hints, model_codes, model_terms, target_device, target_scope, availability_mode, compat_mode, confidence, fact_sources.
- **Reliable:** explicit-kw product types (provenance `kw` vs `regex`), per-slot target_device (family-aware), brand_hints filtered to exclude device-name brands (inside + adjacent-prefix).
- **Ambiguous:** device after bare `กับ` without connector → confidence 0.6 (`_ambiguous_device_target`); single-slot pools all facts (adapter+cable roles merge — relations carry the distinction); `slot_id` naming `slot-<type>` is per-type, not per-instance.
- **Risks:** multi-slot `target_scope="shared"` is positional heuristic; confidence is heuristic (0.4/0.6/0.8/1.0), not calibrated.

### RetrievalRelation (route_context.py)

- **Fields:** source_slot_id, target_slot_id, relation_type (`works_with`), evidence_span, constraints, confidence.
- **Supported:** forward connector + kw target + question marker (`หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน`); symmetric `คู่กัน` with two prior mentions; `'สาย'/'หัว'` shorthand target gated on charger source context or model code (conf 0.7); `'หัว'+อันนี้/code` shorthand source; generic constraints (display, length_m, speed, power_w, protocol, target_subtype).
- **Fail-closed (by design):** no relation without real source evidence (kw mention or code before connector); device mention is never a relation target (`ใช้กับ ip14` stays device-compat); strap compounds (`สายนาฬิกา`) excluded; bare `สาย` without charger/code context not inferred; `รุ่น XYZ ใช้กับสายไหน` (unknown code, no type) → none.
- **Risks:** target_slot_id may be virtual (`slot-<t>` not backed by a real slot); connector/question windows are char-bounded (25/30/20); relation_type vocabulary is one value; symmetric shorthand before connector unsupported.

## Hard Filter vs Soft Hint Policy

**Hard filter candidates (Task 5+):**
- `shop`, `platform` — already hard.
- `model_codes` → exact-unit lookup (already exact).
- explicit-kw `product_types` when slot confidence ≥0.8 — candidate for hard type filter, but needs a "no-match → fallback" rule (4D fail-open pattern).
- `availability_mode` → only after `resolve_availability` (single owner, Task 2).

**Soft hint only (never hard-filter):**
- weak/inferred subtype; shorthand-inferred relation targets (conf 0.7); inferred `target_device`; history-derived types without current evidence; any relation with confidence <0.8; `brand_hints`/`model_terms` (ranking signals, not filters).

## Known Risks Before Task 5

1. Slots/relations are contract-only — wiring them naively can regress (e.g., virtual `slot-<t>` has no backing products).
2. A single slot can hold adapter+cable roles; relation constraints (`target_subtype`) carry the distinction — Task 5 must read constraints, not just slot types.
3. Code-only→cable inference is a shop-domain prior (conf 0.7) — must not hard-filter.
4. Wattage tokens (`240W`, `65W`) are both real product codes and spec constraints — unresolved; relation constraints now capture them as `power_w`/`protocol` but `model_codes` may still hold them.
5. Taxonomy substring quirks remain (kw match inside compounds — `นาฬิกา`⊂`สายนาฬิกา` guarded in relations only; slots/product_types still see it).
6. `app.py` still owns legacy decision logic — profile is a hint layer; conflicts resolve in favor of existing runtime behavior until Task 5 defines precedence.
7. Production process needs restart to pick up new commits (deployment caveat, not code).

## Task 5 Entry Criteria

- [x] 4G committed (`b7fe0a9`), tests 85/85 + regressions green.
- [x] No runtime caller for slots/relations (verified by grep).
- [x] Audit complete (this doc).
- [ ] Task 5 must define consumption policy: which fields are hard filters, which are soft hints, and fallback when a hard filter yields empty.

## Recommended Task 5 Shape

- **Task 5A** — observe/prototype grouped retrieval offline: consume slots+relations to build per-slot queries, union sources, no production behavior change; replay gate on gold set.
- **Task 5B** — wire safe path behind flag; hard-filter only shop/platform/model_codes; everything else soft.
- **Task 5C** — replay/gold gate before default-on; measure vs legacy on the 40+ case gold set.
