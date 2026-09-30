# Legacy Shopee Unified Turn And Evidence Retrieval Rebaseline Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` task-by-task. Do not implement two phases in parallel on the same branch. Every runtime phase is TDD, requires a fresh reviewer, and must delete or retire an older decision path before it can close.

**Goal:** Make the legacy Shopee bot understand one turn once, preserve the correct conversation subjects, retrieve all relevant product evidence into one canonical pool, select context once, and answer through one guarded boundary without case-specific keyword patches.

**Architecture:** Keep the useful Phase 1-5 retrieval foundation, but stop treating grouped retrieval as an extra list merged into the legacy pipeline. Introduce one turn/action decision, one conversation subject set, one canonical product/evidence schema, one candidate pool, one selector, and one answer-context compiler. Migrate callers behind flags and delete each replaced legacy branch after replay proves parity.

**Tech Stack:** Python 3, FastAPI legacy Shopee runtime, MongoDB read-only product/order/stock data, existing local embeddings, Gemini/OpenRouter clients, pytest-style tests under `docs/test/`, Next.js admin config only for existing rollout flags.

**Status:** Proposed rebaseline roadmap. This file does not erase the historical plan and does not authorize runtime implementation by itself. Each revised phase must pass its stated replay/evidence gate before its interfaces become final.

**Historical plan:** `docs/plans/2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md`

**Spec:** This roadmap reorders the remaining work after reviewing the historical plan, current runtime, Phase 5/6 commits, GitHub issues #26-#30, and the 39-turn conversation replay. Completed historical work remains evidence. Unchecked historical runtime steps are superseded only where the status map in the historical plan or this roadmap says so explicitly.

## Global Constraints

- Scope is the legacy Shopee runtime unless a phase explicitly names `ChatAdminWeb` or bot-worker.
- Do not read `.env` directly. DB probes use `load_dotenv()` and existing client helpers; never print secrets.
- Product/order/stock databases are read-only.
- Do not add product, model, shop, brand, device, or example-sentence exceptions to production routing or ranking.
- Keyword lists are allowed only as versioned taxonomy/config data or bounded protocol grammar such as order numbers; they are not allowed as one-off bug fixes.
- A low-confidence parse may broaden recall or ask a clarification. It may not hard-reject a candidate or trigger a sensitive action.
- Prompt text and output rewriting are safety boundaries, not substitutes for retrieval, state, compatibility, or availability correctness.
- Return/exchange eligibility must come from versioned structured policy data scoped by shop, canonical product category, reason, item condition, and effective period. Production code must not branch on a product/store/example keyword to encode a business rule.
- Do not add nested decision helpers to `app.py`. `app.py` must become orchestration only.
- Do not create a new wrapper if an existing owner can be extended. A new helper must remove duplicated logic or have a named deletion gate in the same phase.
- Preserve the current `ChatResponse` public shape until a separate API migration is approved.
- Every function change under `chatbot/shopeechat/` updates SRS section 6 and call relationships.
- Every phase updates `getoutofmywaybotkaikrook2.md`; never edit the frozen history log.
- Before a phase commit, report the diff, tests, real-data probes, residual risks, and deletion count.
- No runtime phase passes on mocked unit tests alone. It needs at least one end-to-end `chat()` replay or sanitized fixture derived from the real schema.

## Review Focus

1. **Subject continuity:** compare, recommendation, price, and link follow-ups must use the same subject set until the customer changes topic.
2. **Availability semantics:** requested option missing, requested option out of stock, listing unpublished, listing deleted, and item with other sellable variants are different facts.
3. **Multi-question turns:** spec, included accessories, shipping, and policy questions in one message must not collapse to one intent.
4. **Sensitive state:** claim collection and human handoff must use persisted state; they must not depend on bot prose or repeatedly parse the entire history.
5. **Evidence claims:** numeric/spec/certification/compatibility claims require field-level provenance for the same product or variant.
6. **Real source schema:** canonical `cable` must cover raw values such as `cable_only` and `c-to-c` without selector-specific string checks.
7. **Noise and ambiguity:** sticker, media-only, typo, bare model, and ambiguous relation messages must not trigger unrelated sales or web search.
8. **Cost:** web fallback cannot run because catalog retrieval was incomplete; LLM context must be selected and budgeted before generation.
9. **Policy eligibility:** a general FAQ or prior bot answer must not prove that a specific order can be returned or exchanged. Customer-selected wrong model, seller-sent wrong item, defect, damage, and unknown cause remain distinct decisions.

---

## Evidence Reviewed For This Rebaseline

This plan was rebuilt from the current checkout, not from session summaries:

- Entire previous 3,457-line master plan.
- Current branch history through `ab1b853` and diffs for Phase 5/6 commits.
- Runtime callsites in `app.py`, grouped retrieval modules, `route_context.py`, `handoffs.py`, `warranty_flow.py`, `product_store.py`, `device_compat.py`, `llm.py`, and `web_search.py`.
- Active waythrough audit and current uncommitted Phase 5 closeout report.
- GitHub issues #26-#30 read from the repository API.
- The 39-turn `mistorethailand` test conversation supplied by the user.
- The 12-turn `nuttawutklinrossukhon` filter conversation supplied by the user, where a broad return-policy path repeatedly promised an exchange contrary to the shop's actual wrong-model policy.
- Focused tests and real-Mongo probe reports already recorded in the active log.

The issues are symptoms and reproductions, not authoritative fix instructions. Each phase below traces them to a shared owner.

## Current Runtime Reality

The current path is not yet the intended single pipeline:

```text
request
  -> order/human early branches
  -> intent classifier
  -> general/tax/warranty/claim early branches
  -> conversation anchor resolution
  -> RetrievalProfile
  -> optional grouped pipeline computes selected cards once
  -> KB branch OR main legacy branch performs its own retrieval/merge/filter
  -> grouped cards are merged into that branch as augmentation
  -> llm.answer
  -> optional web search re-fetches and calls llm.answer again
  -> response cards/timeline
```

Consequences:

- Grouped retrieval can find the right product while a later legacy merge, availability assumption, or LLM framing still gives the wrong answer.
- KB and main paths have separate answer boundaries; item-tag and web reanswer are additional boundaries.
- `RetrievalProfile` is real and useful, but it is not the owner of action routing, conversation subjects, or all compatibility decisions.
- Phase 5C/5F fixed visible failures, but added safety logic around a multi-owner flow. They are temporary protection, not the final architecture.
- Tests can pass with synthetic subtype values while live unit documents use different vocabularies.
- `return_policy` currently combines broad FAQ text with snippets extracted from NORMAL product descriptions, then asks `answer_general()` to infer a case-specific outcome while also supplying prior bot prose as history. The final guard can prove only that positive return/exchange words exist somewhere in that text, not that the rule matches the current shop, product category, reason, and item condition.

## Status Ledger

### Completed And Accepted As Foundation

| Work | Evidence | Decision |
|---|---|---|
| Task 1 measurement/gold tooling | evaluator, validator, reviewed rows | Keep; expand with current incidents before release |
| Task 2 availability resolver | shared resolver and tests | Keep as raw availability fact owner; refine variant/listing semantics in Revised Phase 3 |
| Task 3 evidence-card contract | `retrieval_policy.py` | Keep and evolve into canonical source boundary |
| Task 4A-4D RetrievalProfile and gateway wiring | profile built once and passed through legacy gateways | Keep; sources may no longer rediscover facts after migration |
| Task 4E-4G slot/relation/alias contracts | parser tests and grouped-request use | Keep provisionally; no more keyword expansion; replace uncertain relations with confidence/clarification |
| Phase 5A planner | `8794cfc` | Keep request planning contract |
| Phase 5B1 executor/evidence buckets | `61142f6` | Keep evidence-preserving source attempts |
| Phase 5B2 candidate pool/source union | `762d8b5` | Keep pool concept and identity dedupe |
| Phase 5B3 shadow/selection/runtime flags | `0a22754`, `d960cae`, `d8d5a39`, `f6a191a` | Keep rollout mechanism; runtime selection remains provisional |
| Phase 5D/5E pool tests and final merge dedupe | `86c05d8`, `2792d8a` | Keep regressions and canonical ID behavior |

### Completed But Provisional

| Work | Why not final | Required disposition |
|---|---|---|
| Phase 5C availability/cert/link fixes (`19a5e1a`) | mixed subject, availability, cert, claim fixes across 11 runtime files | Preserve tests; migrate rules into subject/evidence owners, then delete local branches |
| Phase 5F routing/grounding fixes (`0284b89`) | protects production but grows `handoffs.py`, `warranty_flow.py`, guards, and prompt logic | Preserve regression corpus; replace routing with Revised Phase 1 and claim state with Phase 2 |
| Phase 6 subtype coverage (`ab1b853`) | synthetic tests pass but live `cable` vs `cable_only`/`c-to-c` mismatch remains | Reopen; fix at canonical schema boundary, not selector |
| Grouped selection wired into KB/main | proves value for AD1404T and source union | Replace augmentation merge with one selection boundary in Revised Phase 7 |

### Superseded; Do Not Implement As Written

- Old Task 5 live-refresh helpers and old Task 5A `_merge_candidate_sources()` names never existed and are superseded by executor/pool architecture.
- Old Task 6 `retrieval_policy.select_context()` observe design is superseded by `retrieval_selection.select_for_llm_context()`.
- Old Task 7 manual protected merge is superseded by the conversation subject work below.
- Old Tasks 8-12 remain valid requirements, but their former file/function sequence is superseded by Revised Phases 1-8.
- Old Task 13 “cleanup at the end” was too late. Deletion is now a gate in every phase plus a final cleanup phase.

## Incident-To-Owner Map

| Evidence | Symptom | Root boundary | Owning phase |
|---|---|---|---|
| Issue #26 | product questions become anger handoff | action route decided by substring/context helpers before shared turn understanding | Phase 1 |
| Issue #27 | claim name missing and state regresses | claim slots parsed per turn and duplicated flow implementations/state gates | Phase 2 |
| Issue #28 | fabricated/conflicting specs | selected card context lacks field-level evidence and final claims are not checked against the same subject | Phases 5-6 |
| Issue #29 | variant missing becomes “all sold out”; bare model falls to web; 118k tokens | variant/listing availability conflated, model identity weak, web runs after incomplete catalog path | Phases 3, 6, 7 |
| Issue #30 | multi-intent loss, noise sale, wrong route, immediate claim, language/persona formatting | one flat intent and multiple output paths | Phases 1, 2, 6, 7 |
| Q6-Q10 | compare pair lost, recommendation/price/link changes subject, TISI broad | no authoritative turn subject set; cert query not scoped to subject/type | Phases 2 and 5 |
| Q15-Q18 | unpublished WPB100L first sold, then unavailable, then link swapped | publish state not enforced uniformly; link branch chooses arbitrary sellable tail | Phases 2, 3, 5 |
| 2026-09-30 shadow rerun Q15-Q18 | UNLIST+stock WPB100L is correctly described as not yet on sale in one turn, then offered again as an alternative with image/link in a later turn | customer visibility is not enforced at the final answer-context boundary; hidden mentions, alternatives, anchors, and base products can be merged back into LLM context inconsistently | Phase 0 gate, then Phases 2, 3, 6, 7 |
| 2026-09-30 shadow rerun Q1-Q39 | full batch completes only after several minutes; repeated turns send 30 products, long history, and full descriptions, with observed prompt sizes around 53K-56K tokens | token budget is not owned before answer generation; description inclusion, history, grouped/base merge, and debug replay all amplify context | Phase 0 measurement, then Phase 7 |
| 2026-09-30 shadow rerun Q2-Q4 | `[bundle_message]` and `[faq_liveagent]` are treated as customer questions and pollute history/action state | shadow/replay input normalization is missing a turn-decision boundary for platform placeholders and non-customer events | Phase 0 gate, then Phases 1 and 8 |
| Q22-Q25 | unsafe troubleshooting and partial claim collection | troubleshoot/claim action and state are mixed | Phases 1-2 |
| Q26-Q39 | handoff/claim continues inconsistently | shadow generation and live ownership state are not represented by one action gate | Phases 1, 2, 8 |
| Q12-Q13 | PB200P answer and link are correct | important positive regression | All replay gates |
| Filter Q5-Q12 | bot promises exchange after customer ordered the wrong filter model, then repeats its own unsupported promise | no structured policy-eligibility owner; broad description/FAQ text and bot history are treated as case proof | Phases 0, 1, 2, 5, 7, 8 |

## Target Runtime Flow

```text
request
  -> load authoritative conversation/ticket/workflow/claim state once
  -> build TurnDecision once
       action + independent query needs + confidence + provenance
  -> action gate
       no-op/media | workflow | human-owned | claim/troubleshoot |
       order/policy | clarify | product-answer
  -> resolve ConversationSubjectSet once
  -> build RetrievalProfile + slots/relations per product need
  -> execute bounded source adapters
       unit | listing | exact identity | compatibility | KB product |
       image/OCR | order/history anchor | authoritative policy rules
  -> normalize every result to CanonicalEvidenceCard
  -> CandidatePool + SupportingEvidencePool
       kb_qa/kb_raw are supporting evidence, not product candidates
       policy rules resolve to PolicyDecision; prose and bot history never do
  -> select per need with subject/slot/evidence/availability coverage
  -> compile one bounded AnswerContext
  -> call LLM once, unless an explicit pre-answer external-evidence gate ran
  -> validate claims and render response once
  -> persist subjects, claim state, and handoff/workflow outcome
```

## Final Owner Map

| Decision | Final owner | Legacy owners to remove |
|---|---|---|
| Turn action and multi-question needs | new `turn_policy.py` | pre-intent anger branches, app-local claim/general overrides, trigger-like response routing |
| Product query facts | `route_context.py` | source-specific type/subtype/device rediscovery |
| Active subjects and claim/ticket continuity | `conversation_products.py` plus claim executor | history prose scans, app-local anchor insertion, per-turn claim slot reconstruction |
| Raw availability facts | `product_store.resolve_availability()` | unit snapshots or prompt wording used as truth |
| Canonical product/evidence schema | `retrieval_policy.make_evidence_card()` | selector checks against raw source field names |
| Candidate execution and pool | `retrieval_executor.py` + `candidate_pool.py` | blind unit early return and branch-local source union |
| Final selection | `retrieval_selection.py` | KB/main tier merges and grouped-plus-base augmentation |
| Answer context and token budget | `retrieval_runtime.py` | branch-local context merges and unconditional 30-card descriptions |
| Compatibility proof | `device_compat.py` evidence producer, selector consumes proof | `phone -> charger`, `_SKIP_TYPES`, source-local family guessing |
| Return/exchange eligibility | new `policy_resolver.py` consuming versioned structured policy records | broad FAQ/description snippets, LLM inference, and prior bot prose used as case-specific approval |
| Claim executor | one legacy claim state machine | duplicated legacy/v2 behavior and history-marker ownership |
| Handoff/workflow ownership | actual assignment/workflow service | reply text pretending assignment and bot-side old-admin assumption |
| Final rendering/claim validation | one response boundary | LLM-only cleanup versus canned-only cleanup differences |

## Rollout Rules

- During Phases 0-6: production selection default remains off; shadow may remain on. A dedicated test shop/environment may enable selection for replay.
- Phase 7 introduces a separate canary flag for the unified answer boundary. Do not reuse a flag whose old semantics are “merge selected cards into legacy.”
- Error, timeout, or empty result falls back to the last accepted legacy path until Phase 9 removes it.
- Each canary decision is per shop, logged with turn-decision/profile/subject/pool/selection/context counts, never raw secrets or full customer history.
- Rollback is a config toggle until final release acceptance.

## Confidence And Change Control

The target architecture is based on current callsites, commit diffs, issue reproductions, the 39-turn replay, and recorded real-data probes. That is enough to choose the direction, but not enough to freeze every interface in advance. Revised Phase 0 is therefore a mandatory evidence gate, not optional setup.

| Revised phase | Confidence | Why | What can still change it |
|---|---|---|---|
| 0: replay baseline | **High** | known incidents are currently spread across unit tests, issues, and transcripts | fixture shape may change after real-schema sanitization |
| 1: one turn decision | **High on ownership; medium on interface** | early routing currently prevents retrieval and multi-intent handling | replay may show that some deterministic workflow actions need a separate pre-route gate |
| 2: subjects and claim state | **High on ownership; medium on storage contract** | follow-up identity and claim progression demonstrably fail when inferred from prose/history | existing persisted conversation schema may require a smaller migration than proposed |
| 3: canonical schema | **High** | raw subtype, publish, stock, and variant vocabularies already disagree across sources | field names may be refined after sampling every collection again |
| 4: source union | **High on boundary; medium on source order** | the candidate pool is already useful, but source attempts are not yet the sole runtime path | latency and recall measurements may change per-source budgets |
| 5: evidence/compatibility | **High on proof requirement; medium on representation** | issue failures show product-level context is insufficient for field claims | OCR/KB quality may require confidence levels beyond a boolean proof |
| 6: selector | **High on one-owner rule; medium on scoring** | per-request coverage and dedupe are already validated, while live schema mismatch remains | replay metrics may change quotas and weights without changing ownership |
| 7: context/token/web gate | **High** | duplicate answer/search calls and oversized repeated context are visible in code and logs | model/provider limits may change exact budgets |
| 8: answer boundary | **High on goal; medium on migration order** | multiple LLM boundaries produce inconsistent behavior | item-tag or web paths may need temporary adapters during rollout |
| 9: workflow/handoff/assignment | **Medium** | requirements are clear, but ownership crosses bot, admin, worker, and persisted state | a dedicated child design must verify the live assignment service before implementation |
| 10: deletion/release | **High** | parallel owners and stale helpers are the measured source of complexity | deletion list depends on which adapters survive canary |

Rules for changing this roadmap:

1. A phase may change only after a failing replay, real-schema evidence, or a verified callsite contradicts it.
2. Product/model/shop-specific examples stay in fixtures, never production routing or ranking.
3. Passing focused tests cannot close a phase when an end-to-end or real-shaped gate is listed.
4. Every runtime phase gets a detailed child implementation plan before coding; this roadmap is sequencing and ownership, not line-by-line worker instructions.
5. If a phase adds a new owner without retiring or naming the old owner to delete, the phase fails review.

---

## Revised Phase 0: Freeze, Reproduce, And Build The Real Release Gate

**Purpose:** Turn current incidents into one executable baseline before changing behavior.

**Files:**
- Create: `docs/test/fixtures/legacy_turn_incidents.jsonl`
- Create: `docs/test/test_legacy_turn_incident_replay.py`
- Modify: `docs/test/gold_retrieval.jsonl`
- Modify: `docs/test/eval_retrieval.py`
- Modify: active log

**Interface:** Each fixture stores input turns, authoritative state, expected action, expected subject identities, expected availability mode, required evidence, forbidden claims, expected product groups, and any authoritative policy decision. Product/model/shop examples belong in fixtures only.

- [ ] Capture current flags, commit, system prompt size, p50/p95 tokens, web-search rate, and the 39-turn baseline.
- [ ] Add the 2026-09-30 39-turn shadow rerun as a baseline artifact: batch duration, per-turn HTTP status, prompt/output/total tokens, product count, `include_desc`, history length, and whether the response came from placeholder, product, cert, policy, claim, or handoff flow.
- [ ] Add RED rows for issues #26-#30, the 39-turn failures, AD1404T, Mi 17, multi-subtype, sticker/media, bare model, and missing variant.
- [ ] Add RED rows for UNLIST leakage: WPB100L `UNLIST` with positive stock must be `hidden_mention` only; it may be named as not-yet-on-sale, but must never be selected, linked, imaged, recommended as an alternative, or used as spec/compat/compare proof unless another visible listing of the same canonical product exists.
- [ ] Add RED rows for link/anchor continuity: if the current subject is hidden/unpublished, a link follow-up must say the exact subject is not available and then offer visible alternatives in the same product family; it must not silently swap to unrelated chargers/powerbanks or link the hidden listing.
- [ ] Add RED rows for token/latency budget: product-answer turns must record a bounded `AnswerContext` estimate; no normal replay turn should send 30 full-description cards by default, and any turn above the agreed token budget must fail the gate with a reason.
- [ ] Add RED rows for shadow placeholder normalization: `[bundle_message]`, `[faq_liveagent]`, media-only, sticker-only, and punctuation-only turns must not enter product retrieval or LLM product answer as ordinary customer questions.
- [ ] Add the sanitized filter-policy replay: customer selected the wrong model, outer box may be opened while the inner wrap remains sealed, and the authoritative shop/category rule says ineligible. Q5/Q6/Q10/Q11/Q12 must never claim exchange eligibility; prior bot prose must not become policy evidence. Add distinct positive fixtures for seller-sent wrong item and an explicit eligible rule so the fix cannot become a blanket refusal.
- [ ] Through `load_dotenv()` and read-only clients, create sanitized fixtures for mixed stock, UNLIST, deleted, raw subtype vocab, missing evidence, and old-order identity.
- [ ] Add pure owner tests, integration tests with real-shaped fixtures, and multi-turn `chat()` boundary tests that capture LLM inputs.
- [ ] Run and record failures by owner; do not patch runtime in this phase.

```bash
.venv/bin/python -m pytest docs/test/test_legacy_turn_incident_replay.py -v
.venv/bin/python docs/test/eval_retrieval.py --gold docs/test/gold_retrieval.jsonl --by-intent
git diff --check
```

**Exit gate:** Every known failure has a stable replay and every previously good case has a positive regression.

## Revised Phase 1: One Turn Decision Before Retrieval Or Handoff

**Purpose:** Replace flat intent plus early substring branches with one explicit action and multiple independent needs.

**Files:** Create `turn_policy.py` and `test_turn_policy.py`; modify `app.py` and later reduce `handoffs.py`; update SRS/log.

```python
@dataclass(frozen=True)
class TurnNeed:
    kind: str
    text_span: str
    subject_ref: str | None
    required_evidence: frozenset[str]
    confidence: float
    provenance: tuple[str, ...]

@dataclass(frozen=True)
class TurnDecision:
    action: str  # no_reply|workflow|human_wait|handoff|claim|troubleshoot|answer|clarify
    needs: tuple[TurnNeed, ...]
    confidence: float
    reason_codes: tuple[str, ...]
    state_version: str | None
```

- [ ] RED-test product issue vs service complaint, explicit human request, neutral question, noise/media, multi-intent, cancel vs return, contact request, troubleshoot before claim, active handoff, and clarification.
- [ ] Represent a policy question as an independent `TurnNeed` carrying the requested operation and known reason/condition facts; do not collapse it into a generic FAQ intent or infer eligibility at this layer.
- [ ] Implement observe-only `decide_turn()` from intent output, authoritative state, and deterministic structural facts. Do not add semantic keyword tables.
- [ ] Log only action/need kinds/confidence/provenance and compare with old routing.
- [ ] Migrate gates in order: no-reply, human ownership, explicit handoff, troubleshoot/claim, workflow, product/policy.
- [ ] Delete or thin the corresponding early branches and Phase 5F message-category ownership.

**Exit gate:** issues #26/#30 route cases pass; real complaints still hand off; multi-intent retains all needs; `app.py` has one action switch.

## Revised Phase 2: Authoritative Subjects And Claim State

**Purpose:** Persist what products are being discussed and what claim data is collected instead of guessing from bot prose.

**Files:** Modify `conversation_products.py`, `warranty.py`, `warranty_flow.py`, `app.py`; create subject and multi-turn claim tests; update SRS/log.

```python
@dataclass(frozen=True)
class ConversationSubjectSet:
    subject_ids: tuple[str, ...]
    source_turn_id: str | None
    relation: str              # single|compare|alternatives|bundle
    requested_operation: str  # describe|compare|recommend|price|link|compat|policy
    confidence: float
```

- [ ] RED-test Q6->Q9, Q12->Q13, Q15->Q18, explicit topic switch, and ambiguous references.
- [ ] Resolve subjects once: explicit identity wins; referential turns use persisted subjects; bot prose is never truth; ambiguity clarifies.
- [ ] Make compare/price/link consume the subject set. Unavailable subjects cannot be silently swapped.
- [ ] Keep the referenced product/category and order-policy facts stable across follow-ups such as packaging condition and "กรณีนี้เปลี่ยนได้ไหม". Persist customer/order facts, never the prior bot's policy conclusion.
- [ ] RED-test issue #27 across labelled/name-only data, field ordering, media, troubleshooting acknowledgement, policy during claim, closed ticket, and handoff.
- [ ] Merge current parsed fields into persisted claim state fill-once; validate phone/order separately; transitions are monotonic except reset/close.
- [ ] Choose one claim executor and stop editing parallel implementations in the same phase.

**Exit gate:** issue #27 passes, follow-up identity remains stable, and ticket state outranks history markers.

## Revised Phase 3: Canonical Product, Variant, And Availability Schema

**Purpose:** Normalize source vocabularies before pooling or selection.

**Files:** Modify `retrieval_policy.py`, `product_store.py`, `units.py`, `candidate_pool.py`; add canonical-card and variant-semantics tests; update SRS/log.

```python
{
  "canonical_type": "charger",
  "canonical_roles": ["adapter"],
  "variant_facets": {"connector": "usb-c", "length_m": 2, "color": "gray"},
  "publish_state": "published|unpublished|deleted|unknown",
  "stock_state": "in_stock|out_of_stock|unknown",
  "requested_variant_state": "not_requested|available|out_of_stock|not_offered|unknown",
  "customer_visibility": "visible|historical_only|hidden",
  "availability_reason": "...",
  "_evidence": {"sources": [], "facts": {}}
}
```

- [ ] Inventory raw product/subtype/status/stock/variant values from real fixtures.
- [ ] RED-test `cable`, `cable_only`, and `c-to-c` normalization; unknown values remain traced unknown.
- [ ] Evolve `make_evidence_card()` as the only canonical source adapter.
- [ ] Separate requested-option status from whole-item sellability. Missing color is not sold out; one dead variant is not all-dead.
- [ ] Enforce publish semantics: UNLIST-only is hidden; visible historical listing may answer spec/history; visible active listing is required to sell.
- [ ] Remove raw-field checks from executor and selector.

**Exit gate:** issue #29 stock case, live multi-subtype coverage, and WPB100L policy pass without selector-specific raw strings.

## Revised Phase 4: Complete The Evidence-Preserving Source Union

**Purpose:** Put every relevant source into one bounded pool while keeping support text separate from products.

**Files:** Modify executor, pool, KB, compatibility, and conversation owners; add unified-source tests; update SRS/log.

- Product candidates: unit, listing, exact identity, compatibility candidate, KB product identity, order/history anchor.
- Evidence attachments: `kb_product`, `image_texts`, and stock/spec joins by normalized identity.
- Supporting evidence: `kb_qa` and `kb_raw`; never a product candidate without product identity.

- [ ] RED-test source omission, partial unit result, KB-only evidence, missing live anchor, source failure, and bounded limits.
- [ ] Add bounded adapters; record raw/eligible/unavailable/rejected counts and reasons.
- [ ] Attach evidence by `_norm_id`; use name matching only when no identity exists and record low confidence.
- [ ] Dedupe cross-source evidence without merging distinct variants.
- [ ] Probe active, all-dead, UNLIST, stale model, null type, and missing OCR fixtures.

**Exit gate:** reviewed recall never decreases and no source hides another because it returned first.

## Revised Phase 5: Field Evidence, Policy Eligibility, And Compatibility Proof

**Purpose:** Represent what is known per field and product, and resolve sensitive business-policy outcomes from authoritative structured rules before selection or generation.

**Files:** Create `policy_resolver.py`; modify policy, KB, compatibility, product/unit adapters; add field-evidence, policy-eligibility, and compatibility tests; update SRS/log.

```python
@dataclass(frozen=True)
class PolicyQuery:
    policy_type: str
    shop: str | None
    subject_ids: tuple[str, ...]
    canonical_product_types: tuple[str, ...]
    reason: str                 # customer_wrong_model|seller_wrong_item|defect|damage|unknown
    item_condition: str         # sealed|outer_opened|inner_opened|used|unknown
    order_state: str | None
    event_time: str | None

@dataclass(frozen=True)
class PolicyDecision:
    outcome: str                # eligible|ineligible|admin_review|unknown
    matched_rule_ids: tuple[str, ...]
    required_evidence: tuple[str, ...]
    reason_codes: tuple[str, ...]
    source_versions: tuple[str, ...]
```

- [ ] Define versioned policy records as data, not Python branches: shop scope, canonical product type/category, reason, allowed item conditions/order states, outcome, required evidence, priority, effective dates, source, and version. Business operators own rule content; catalog descriptions and generated answers are not authoritative rules.
- [ ] Resolve by deterministic specificity and effective date. Conflicting, missing, or incomplete rules return `admin_review`/`unknown`; they may never default to eligible.
- [ ] RED-test customer-selected wrong model versus seller-sent wrong item, defect, opened outer packaging versus opened inner seal, unknown condition, conflicting rules, expired rules, shop/category mismatch, and a general FAQ that contains positive exchange wording but has no matching eligibility rule.
- [ ] For the supplied filter fixture, load the shop/category wrong-model prohibition as fixture policy data. Do not put the shop name, filter term, or sentence in production logic.
- [ ] Stop `_extract_policy_from_descriptions()` and generic `answer_general()` context from deciding case eligibility. They may explain general process only after `PolicyDecision` is known.

- [ ] Define stable fact keys (`output_w`, `capacity_mah`, `water_rating`, `wifi_bands`, `certifications`, `connector`, `protocols`, `warranty`) with source and identity.
- [ ] RED-test issue #28 unsupported 5ATM/IP68/GPS/day/GHz/mm claims and cross-product spec leakage.
- [ ] Scope TISI/CCC/CE by current subject/type/subtype and visibility; missing OCR is unknown.
- [ ] Require explicit proof for compatibility and incompatibility; missing proof remains unknown.
- [ ] Remove `phone -> charger` and `_SKIP_TYPES` only after profile/slot/compat replay passes.
- [ ] When customer evidence conflicts with missing DB evidence, acknowledge uncertainty rather than repeat the prior claim.

**Exit gate:** issue #28 passes without model-specific code; positive Mi 17/iPhone cases remain; unknown evidence never becomes a negative claim; filter wrong-model replay is `ineligible`, seller-fault positive fixtures retain their configured outcome, and no policy outcome is inferred from bot history or broad prose.

## Revised Phase 6: One Selector With Coverage And Roles

**Purpose:** Select per need from the canonical pool and stop appending arbitrary legacy products afterward.

**Files:** Modify selector, runtime, and pool; extend tests/replay; update SRS/log.

- [ ] RED-test multi-type/subtype, compare pair, relation pair, subject, unavailable subject, hidden mention, and alternatives.
- [ ] Select from canonical types/roles/facets only.
- [ ] Keep `subject`, `relation_target`, `alternative`, `historical_evidence`, and `hidden_mention` distinct.
- [ ] In canary mode, make legacy base products a preselection source, not a postselection append.
- [ ] Keep unavailable/rejected summaries outside recommendations.

**Exit gate:** Q6-Q10, Q15-Q18, AD1404T, and live multi-subtype probes pass; selected duplicates are zero.

## Revised Phase 7: Bounded Answer Context And Web Gate

**Purpose:** Compile only needed fields and stop repeated giant LLM contexts.

**Files:** Modify runtime, LLM, web search; create context-budget tests; update SRS/log.

```python
@dataclass(frozen=True)
class AnswerContext:
    products: tuple[dict, ...]
    evidence: tuple[dict, ...]
    availability_notes: tuple[dict, ...]
    policy_decisions: tuple[PolicyDecision, ...]
    unanswered_needs: tuple[str, ...]
    estimated_tokens: int
    trace: tuple[str, ...]
```

- [ ] RED-test browse without descriptions, targeted spec fields, symmetric compare, and policy/claim without 30 product descriptions.
- [ ] Include only the resolved `PolicyDecision`, the matching rule explanation, and required next-step evidence for policy turns. Exclude unrelated policy snippets and prior bot conclusions.
- [ ] Replace fixed 30-card behavior with per-need quotas plus a hard emergency cap.
- [ ] Measure system prompt separately; remove duplicated rules only with regressions. Treat provider caching as optional optimization.
- [ ] Decide web search before the answer. Never use web for local catalog existence, stock, price, or unresolved local identity.
- [ ] Delete dead context work and prevent unchanged context from being resent to LLM2.

**Cost gates:** product-context p95 drops at least 30%; estimated p95 cost is below 1 THB/turn; local catalog hits do not trigger web; normal turns have one answer call.

## Revised Phase 8: One Answer Boundary And Output Contract

**Purpose:** Migrate KB, main, item-tag, and web paths to one context/render/guard boundary.

**Files:** Modify `app.py`, runtime, LLM, guards, web search; add unified-boundary tests; update SRS/log.

- [ ] Introduce one canary orchestration call that consumes decision, subjects, and `AnswerContext` without re-retrieval.
- [ ] Migrate main, KB, item-tag/spec, then web-enriched callsites one commit at a time; delete each old merge/context block.
- [ ] Apply persona, whitespace, language, separators, private-key stripping, and claim validation to LLM and canned responses through one finalizer.
- [ ] Validate numeric/unit/cert/compat claims against evidence for the same subject; soften unsupported claims without inventing handoff/product.
- [ ] Validate positive and negative return/exchange claims against the matching `PolicyDecision`. A positive promise requires `outcome="eligible"`; `ineligible` must explain the configured reason without offering an exchange; `unknown/admin_review` must not promise or deny eligibility.
- [ ] Persist response subjects/products, not preselection candidates.

**Exit gate:** issue #30 formatting/language/noise cases and issue #28 claim checks pass; one product-answer boundary remains.

## Revised Phase 9: Workflow, Trigger, Handoff, And Assignment

**Purpose:** Use the action decision and authoritative assignment state to prevent bot/human overlap.

**Files:** Audit then modify actual worker/workflow owner and `handoffs.py` only where required; add workflow/handoff state tests; update docs/log.

- [ ] Inventory buffer, trigger, delivery, ticket, assignment, accept/reply/close, timeout, and bot suppression ownership.
- [ ] Separate assigned, accepted, last responder, and last successful owner. Old owner wins only when eligible.
- [ ] Gate triggers by action/state; sensitive actions remain exact/structured, low-risk FAQ may be tolerant.
- [ ] Label shadow generation as non-delivered; live bot stops after accepted handoff except approved data collection.
- [ ] Fall back to eligible round-robin or explicit team queue, never silent waiting.

**Exit gate:** live bot does not answer over humans; handoff wording maps to real queue/assignment; triggers and claim collection respect state.

## Revised Phase 10: Mandatory Deletion, Replay, Canary, Release

**Purpose:** Remove provisional paths and prove the final pipeline.

- [ ] Build the final owner/caller map with `rg`.
- [ ] Delete replaced Phase 5F routing tables, app-local subtype/compare/link merges, phone hacks, grouped-plus-base merge, dead contexts, duplicate availability formulas, obsolete flags/wrappers, and unjustified one-caller helpers.
- [ ] Run full incident/gold replay for action, subjects, pool, selection, claims, links, handoff, tokens, and latency.
- [ ] Canary by internal/test shop, then expand only with no critical/high regression.
- [ ] Remove fallback only after acceptance; keep a rollback commit/tag and deploy notes.

**Final acceptance:**

- Issues #26-#30 pass without model/shop-specific production conditions.
- The corrected 39-turn conversation passes and Q12-Q13 remains good.
- Exact, compare, compat, multi-product/subtype, history, warranty, claim, and link metrics do not regress.
- No sellable compatible item is absent because another source returned first.
- No unavailable/unpublished subject is silently swapped.
- No unsupported spec/cert/compat claim reaches the customer.
- No return/exchange eligibility claim reaches the customer without a matching effective structured policy decision for the same shop, subject/category, reason, and condition.
- One normal turn has one action, subject set, pool, selection, context, and answer boundary.
- `app.py`, `handoffs.py`, and `warranty_flow.py` have net complexity reduction from Phase 0.
- p95 estimated cost stays below 1 THB and every web fallback has an evidence reason.

## Execution Order And Parallelism

Run `0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10`.

- Do not run Phases 1-8 in parallel on one branch; contracts and `app.py` boundaries are sequential.
- Read-only DB audits, fixture sanitization, and corpus review may use isolated worktrees in parallel.
- Phase 9 inventory may run read-only while Phase 7 runs, but runtime edits wait for Phase 8 contracts.
- Use a fresh dev-worker session per phase and a fresh reviewer before commit.

## Per-Phase Commit Protocol

1. Read AGENTS, both logs, this plan, and phase owners.
2. Confirm branch/dirty tree and preserve unrelated work.
3. Write and run RED tests from real incident fixtures.
4. State one root-cause hypothesis and changed boundary.
5. Implement the smallest owner change.
6. Migrate named callers.
7. Delete or disable the replaced branch.
8. Run unit, integration, multi-turn replay, compile/typecheck, and `git diff --check`.
9. Update SRS/log with measurements and residual risks.
10. Show staged scope and ask before the phase's first commit.

## Self-Review

- Retrieval, availability, variants, subjects, multi-query, evidence, compatibility, claim, handoff/workflow, token cost, and cleanup all have owners and gates.
- AC65B, WPB100L, A18T, iPhone, Mi Watch, and shop names appear only in regression evidence, never as production branching requirements.
- Every migration phase names old logic to delete; release is blocked if duplicate owners remain.
- `TurnDecision` precedes subjects; subjects precede profile/requests; sources emit canonical cards before pool/selection; `AnswerContext` is the sole LLM input contract.
- Real-schema fixtures are mandatory because synthetic `subtype="cable"` tests missed live `cable_only`/`c-to-c` values.
- Rollout stays reversible until full replay and canary pass.

## Decision

Do not continue the old Phase 7 sequence and do not add a Phase 5G keyword/helper patch. Start at Revised Phase 0, then Phase 1. The completed work remains useful infrastructure; the new plan changes decision ownership and migration order.

---

## Phase 1E — TurnDecision readiness audit (2026-09-30)

Evidence: shadow sweep 52 turns / 40 fixtures (`test_turn_decision_shadow.py::test_shadow_sweep_all_fixtures`) + 78 contract/shadow tests. Legacy remains production owner; `decide_turn` is trace-only.

### Action-family risk table

| action | fixture evidence | verdict | if wired now |
|---|---|---|---|
| `noise` | sticker→noise + 5 placeholder families in unit tests | **candidate** — but no noise-answer path exists; wiring = new runtime behavior, needs defined response | placeholder turns stop hitting retrieval/LLM (desired fix for [bundle_message]/[faq_liveagent] pollution) |
| `locked` | tx-q28 + route-open-ticket-locks (legacy=handoff→locked) | **NOT ready** — production `_post_handoff_gate` honors per-shop `post_handoff_exceptions` from admin DB; contract takes only ticket_state → would over-lock configured exceptions | suppresses answers admin configured to allow |
| `handoff` | iss26-real-complaint match; unit test human-request | needs more fixture rows; predicates verbatim so parity high | side-effecting (admin POST) — wire only via existing paths |
| `claim_request` | tx-q22q25 + iss30-multi (both legacy=answer — known incident: claim never starts) | contract is *intended* behavior; wiring starts claim flow where legacy answered | real behavior change — needs claim-state owner first |
| `claim_collect` | zero fixture coverage (no claim_state in fakes) | **NOT ready** — needs Phase 2 claim-state owner/provenance | unknown |
| `followup` | 7 turns match answer-family | **NOT ready** — needs anchor/subject owner (contract sees request-level context only; anchor lives in DB) | wrong-context followups |
| `answer_product` | 18 turns match | **NOT ready** — depends on retrieval/subject owner; cert family = deterministic evidence path | changes retrieval boundary |
| `answer_general` | 1 fixture + unit tests | thin coverage | low impact but low evidence |
| `unknown` | residual unknowns all context-free single turns — honest fallback | n/a | n/a |

### Decision

**Wire nothing yet.** Blockers:

1. `locked` missing `post_handoff_exceptions` input (contract would over-lock admin-configured messages)
2. `noise` has no defined response path — wiring it creates new runtime behavior needing approval of the answer text/path
3. `claim_collect`/`followup` need anchor + claim-state owners (Phase 2)
4. Coverage: 52 turns, claim_collect=0 rows, locked=2 rows — too thin for ownership transfer

### Tests required before any wiring

- locked: fixtures covering shop-settings exceptions (exception keyword → not locked)
- noise: defined response path + multi-turn placeholder sequences
- anchor-aware decide_turn input (active product) — kills residual unknowns
- claim_state provenance fixtures (collect mid-flow)

### Rollback (when wiring happens)

Single seam: `_turn_decision_shadow` callsite + future enforcement flag. Revert = flag off (default) or delete callsite — decision owner never mutates legacy paths.
