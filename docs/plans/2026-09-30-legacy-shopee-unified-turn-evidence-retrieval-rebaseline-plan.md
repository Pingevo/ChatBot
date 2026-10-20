# Legacy Shopee Unified Turn And Evidence Retrieval Rebaseline Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` task-by-task. Do not implement two phases in parallel on the same branch. Every runtime phase is TDD, requires a fresh reviewer, and must delete or retire an older decision path before it can close.

**Goal:** Make the legacy Shopee bot understand one turn once, keep conversation ownership separate from claim/business lifecycle, verify side effects before claiming success, preserve the correct conversation subjects, retrieve all relevant product evidence into one canonical pool, select context once, and answer through one grounded boundary without case-specific keyword patches.

**Architecture:** Keep the useful availability, unit/live-listing, evidence-card, OCR/cert, history, workflow, assignment, and botworker foundations. Introduce one multi-need turn plan, independent ownership/claim axes, a typed handoff command/result boundary, one conversation subject set, one canonical product/evidence schema, one candidate pool, one selector, and one answer-context compiler. Every migration deletes the replaced owner in the same commit; grouped retrieval may not remain an extra list merged into legacy.

**Tech Stack:** Python 3, FastAPI legacy Shopee runtime, MongoDB read-only product/order/stock data plus admin-owned state collections, existing local embeddings, Gemini/OpenRouter clients, pytest-style tests under `docs/test/`, and the existing Next.js admin status/handoff boundary.

**Status:** Active rebaseline roadmap, revised and accepted 2026-10-09 after the repository-wide architecture audit. Phase 2A is an accepted/frozen test baseline. Phase 2B and 2C below supersede their earlier implementation sequence; Phase 2D is inserted after 2C as the botworker scope gate before Phase 3. Runtime implementation starts at Phase 2B.1 and proceeds sequentially under the RED-first and deletion gates below.

**Historical plan:** `docs/plans/2026-09-21-legacy-shopee-evidence-retrieval-implementation-plan.md`

**Spec:** `docs/plans/2026-10-09-current-system-architecture-audit.md`. This roadmap also preserves evidence from the historical plan, Phase 5/6 commits, GitHub issues #26-#30, and recorded replays. Waythrough entries are chronology, not authority; current code/contracts win when they disagree.

### 2026-10-09 revision decision

- Do not restart the project and do not create a parallel roadmap.
- Freeze Phase 2A: its fixtures, strict xfails, three-axis terminology, missing-resolution-event blocker, episode-identity blocker, and multi-intent blocker remain accepted evidence.
- Replace the old Phase 2B sequence with state transport, claim episode ownership, typed handoff outcome, and explicit admin-side claim outcome work.
- Make Phase 2C evolve `turn_decision.py` into a multi-need `TurnPlan` before it becomes the authoritative subject/follow-up owner.
- Preserve good components as sources/primitives; replace only their competing decision ownership.

### Delivery checkpoint — 2026-10-16

**Target:** Make the legacy Shopee answer path review/PR-ready by 2026-10-16. This checkpoint is not approval to deploy and is not a promise that Lazada/TikTok, workflow-editor UX, KPI/rating semantics, botworker production canary, or production observation will be complete.

**Definition of done for this checkpoint:**

- Phase 2B authoritative ownership, typed handoff result, claim episode lifecycle, close semantics, and explicit claim outcome pass their focused and replay gates.
- Phase 2C multi-need `TurnPlan` and authoritative `ConversationSubjectSet` preserve anchor, follow-up, and history behavior without a parallel long-lived policy path.
- Product evidence continues to include live listings, `units.py`, historical products, KB, image/OCR/cert evidence, anchors, and compatibility evidence.
- Grouped retrieval owns one candidate pool and selection path for migrated cases; a migrated legacy/shadow branch is deleted in the same commit.
- Comparison, compatibility, stock, warranty/claim, certification, troubleshooting, and handoff incidents have end-to-end `chat()` evidence.
- The closeout reports answer quality, LLM/provider-call count, latency, context tokens, estimated cost, owner count, direct state writers, runtime LOC delta, and remaining blockers against a fresh baseline.
- The branch is review/PR-ready with SRS/log updates and clean verification. Production deploy/canary requires separate approval.

**Execution calendar:**

| Date | Planned work | Required gate |
|---|---|---|
| 2026-10-09 | Freeze accepted architecture, baseline fixtures, deadline, and exclusions | Plan accepted; no runtime edit before 2B.1 RED |
| 2026-10-10 | Phase 2B.1-2B.3: ownership transport and truthful handoff outcome | State owner and persisted side effect agree |
| 2026-10-11 | Phase 2B.4-2B.6: claim episode, close semantics, explicit admin outcome | Close does not resolve claim; episode-scoped outcome works |
| 2026-10-12 | Phase 2B.7 and Phase 2C.1: residual deletion and multi-need TurnPlan | Old owner/writer counts decrease |
| 2026-10-13 | Phase 2C.2-2C.3: subject set, anchor/history/follow-up migration | Ambiguity clarifies; migrated app-local branches deleted |
| 2026-10-14 | Retrieval ownership: units/live listing/history/KB/image evidence into one pool | Visibility, availability, provenance, and dedupe gates pass |
| 2026-10-15 | Quality/performance replay: compare, compat, stock, cert, warranty, troubleshooting | Fresh quality/call/latency/token/cost measurements recorded |
| 2026-10-16 | Full regression, deletion audit, docs, diff review, PR-readiness report | No unresolved Critical/High in checkpoint scope |

**Schedule rule:** correctness and owner deletion outrank calendar cosmetics. If a real replay exposes a Critical/High issue, do not hide it with a helper, guard, keyword, xfail, or fallback. Report the blocker and move production deployment past the checkpoint rather than declaring paper completion.

**Estimated effort and confidence:** 45-65 engineering hours; 70-80% confidence for review/PR readiness by 2026-10-16 if scope remains fixed. Production readiness remains subject to an approved canary and real observation.

## Global Constraints

- Scope is the legacy Shopee runtime unless a phase explicitly names `ChatAdminWeb` or bot-worker.
- Do not read `.env*` or secret files. Any DB probe requires separate user approval plus an explicitly supplied safe connection boundary; never print credentials.
- Product/order/stock databases are read-only.
- Do not add product, model, shop, brand, device, or example-sentence exceptions to production routing or ranking.
- Keyword lists are allowed only as versioned taxonomy/config data or bounded protocol grammar such as order numbers; they are not allowed as one-off bug fixes.
- A low-confidence parse may broaden recall or ask a clarification. It may not hard-reject a candidate or trigger a sensitive action.
- Prompt text and output rewriting are safety boundaries, not substitutes for retrieval, state, compatibility, or availability correctness.
- Return/exchange eligibility must come from versioned structured policy data scoped by shop, canonical product category, reason, item condition, and effective period. Production code must not branch on a product/store/example keyword to encode a business rule.
- Do not add nested decision helpers to `app.py`. `app.py` must become orchestration only.
- Do not create a new wrapper if an existing owner can be extended. A new helper must remove duplicated logic or have a named deletion gate in the same phase.
- Preserve the current `ChatResponse` public shape until a separate API migration is approved.
- `handoff_to_admin` may remain as a compatibility output field, but it must be derived from a persisted handoff result; it is never input evidence that the side effect succeeded.
- `status_conversation` is the production ownership source of truth. Raw `conversations.status` may not override it or silently substitute for it.
- Admin close returns answer ownership to the bot. It is never a claim resolution/cancellation event.
- `chat_v2` and `chatbotv3` are frozen for deletion: do not add semantic fixes, tests, flags, or compatibility shims to them. Shared changes that alter them require an explicit boundary review.
- Botworker runtime/canary work is paused and out of scope. Its tested transport/idempotency primitives are preserved.
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
10. **Side-effect truth:** assigned, durably queued, failed, and not-attempted handoffs must be distinguishable; customer text and response flags must agree with the stored outcome.
11. **Ownership versus outcome:** closing a conversation, waiting for the customer, resolving troubleshooting, resolving a claim, and cancelling a claim are separate events.

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
| Phase 2A claim lifecycle baseline | `37f6d30`; 60-row incident fixture; strict xfails | Freeze as evidence; do not expand it into another runtime owner |

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
| no-product handoff trace | response says admin handoff and sets `handoff_to_admin=True`, but no handoff POST occurs | desired command and completed side effect share one boolean; final guard trusts the boolean | Phase 2B |
| production ticket-state transport | `botCallService.resolveTicketState()` reads raw `conversations`, while ticket ownership is stored in `status_conversation` | state owner and transport source disagree | Phase 2B |

## Target Runtime Flow

```text
request
  -> load authoritative conversation ownership + claim episode + workflow state once
  -> build TurnPlan once
       primary action + independent needs[] + subjects + confidence + provenance
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
  -> execute typed commands
       handoff → assigned | queued | failed | not_attempted
       claim outcome → resolved | cancelled (explicit event only)
  -> persist subjects, claim episode, and verified command/workflow outcome
```

## Final Owner Map

| Decision | Final owner | Legacy owners to remove |
|---|---|---|
| Turn action and multi-question needs | `turn_decision.py` evolved to `TurnPlan` with `needs[]`; do NOT create `turn_policy.py` | pre-intent anger branches, app-local claim/general overrides, trigger-like response routing |
| Product query facts | `route_context.py` | source-specific type/subtype/device rediscovery |
| Conversation ownership | `status_conversation`, transported explicitly into `/chat` | raw `conversations.status`, history prose, ticket-close inference |
| Claim episode/lifecycle | one legacy lifecycle owner using `conversation_products.claim_state` as storage | retained-slot activation, direct stage writes, close-ticket clear, `_TERMINAL_CLAIM_REASONS` as fake resolution |
| Active product subjects | `conversation_products.py` subject set | history prose scans, app-local anchor insertion, per-branch follow-up guesses |
| Raw availability facts | `product_store.resolve_availability()` | unit snapshots or prompt wording used as truth |
| Canonical product/evidence schema | `retrieval_policy.make_evidence_card()` | selector checks against raw source field names |
| Candidate execution and pool | `retrieval_executor.py` + `candidate_pool.py` | blind unit early return and branch-local source union |
| Final selection | `retrieval_selection.py` | KB/main tier merges and grouped-plus-base augmentation |
| Answer context and token budget | `retrieval_runtime.py` | branch-local context merges and unconditional 30-card descriptions |
| Compatibility proof | `device_compat.py` evidence producer, selector consumes proof | `phone -> charger`, `_SKIP_TYPES`, source-local family guessing |
| Return/exchange eligibility | new `policy_resolver.py` consuming versioned structured policy records | broad FAQ/description snippets, LLM inference, and prior bot prose used as case-specific approval |
| Claim executor | one legacy claim state machine | duplicated legacy/v2 behavior and history-marker ownership |
| Handoff result | `handoffService`/bot-handoff API returns typed persisted outcome; Python `responses._send_handoff` maps it | reply text/boolean pretending assignment, `ok:true` with ambiguous `assigned_to:null` |
| Final rendering/claim validation | one response boundary | LLM-only cleanup versus canned-only cleanup differences |

## Rollout Rules

- During Phases 0-6: production selection default remains off; shadow may remain on. A dedicated test shop/environment may enable selection for replay.
- Phase 7 introduces a separate canary flag for the unified answer boundary. Do not reuse a flag whose old semantics are “merge selected cards into legacy.”
- Error, timeout, or empty result falls back to the last accepted legacy path until Phase 9 removes it.
- Canary only in an isolated environment/dataset or through an already-proven explicit scope boundary. Do not claim per-shop isolation when the runtime query has no shop allowlist. Log turn-plan/profile/subject/pool/selection/context counts, never raw secrets or full customer history.
- Rollback is a config toggle until final release acceptance.

## Confidence And Change Control

The target architecture is based on current callsites, commit diffs, issue reproductions, the 39-turn replay, and recorded real-data probes. That is enough to choose the direction, but not enough to freeze every interface in advance. Revised Phase 0 is therefore a mandatory evidence gate, not optional setup.

| Revised phase | Confidence | Why | What can still change it |
|---|---|---|---|
| 0: replay baseline | **High** | known incidents are currently spread across unit tests, issues, and transcripts | fixture shape may change after real-schema sanitization |
| 1: pure turn-decision baseline | **High as shadow evidence** | import purity and current one-action behavior are pinned | production interface is intentionally deferred to Phase 2C |
| 2A: lifecycle baseline | **High** | executable incidents and blockers are committed | frozen; new findings belong to the owning implementation phase |
| 2B: state and verified commands | **High on ownership; medium on cross-service schema** | false-success handoff and state-source mismatch are proven in code | exact admin claim-outcome UI/API shape must stay minimal during implementation |
| 2C: TurnPlan and subjects | **High on ownership; medium on interface** | one-action and prose-derived follow-up failures are proven | fixture replay may refine need/subject fields without changing ownership |
| 3: canonical schema | **High** | raw subtype, publish, stock, and variant vocabularies already disagree across sources | field names may be refined after sampling every collection again |
| 4: source union | **High on boundary; medium on source order** | the candidate pool is already useful, but source attempts are not yet the sole runtime path | latency and recall measurements may change per-source budgets |
| 5: evidence/compatibility | **High on proof requirement; medium on representation** | issue failures show product-level context is insufficient for field claims | OCR/KB quality may require confidence levels beyond a boolean proof |
| 6: selector | **High on one-owner rule; medium on scoring** | per-request coverage and dedupe are already validated, while live schema mismatch remains | replay metrics may change quotas and weights without changing ownership |
| 7: context/token/web gate | **High** | duplicate answer/search calls and oversized repeated context are visible in code and logs | model/provider limits may change exact budgets |
| 8: answer boundary | **High on goal; medium on migration order** | multiple LLM boundaries produce inconsistent behavior | item-tag or web paths may need temporary adapters during rollout |
| 9: workflow/trigger consolidation | **Medium** | precedence and multi-output risks are visible, while botworker is paused | implementation waits for Phase 2B/2C contracts and explicit reopening of botworker scope |
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
- [ ] From already-sanitized artifacts or a separately approved explicit read-only connection, create fixtures for mixed stock, UNLIST, deleted, raw subtype vocab, missing evidence, and old-order identity. Never load `.env*` as part of the test plan.
- [ ] Add pure owner tests, integration tests with real-shaped fixtures, and multi-turn `chat()` boundary tests that capture LLM inputs.
- [ ] Run and record failures by owner; do not patch runtime in this phase.

```bash
.venv/bin/python -m pytest docs/test/test_legacy_turn_incident_replay.py -v
.venv/bin/python docs/test/eval_retrieval.py --gold docs/test/gold_retrieval.jsonl --by-intent
git diff --check
```

**Exit gate:** Every known failure has a stable replay and every previously good case has a positive regression.

## Revised Phase 1: Pure Turn-Decision Baseline (Accepted, Shadow-Only)

**Purpose:** Preserve the pure, import-safe, one-action shadow classifier and its fixture evidence. It is not production-ready and must not be wired as-is; multi-need evolution moved to Phase 2C.

**Files:** Existing `chatbot/shopeechat/turn_decision.py`, `docs/test/test_turn_decision.py`, and shadow tests. No runtime work remains in this phase.

```python
@dataclass(frozen=True)
class TurnDecision:
    action: str  # current one-action shadow contract
    reason: str
    confidence: float
    normalized_message: str
    flags: frozenset[str]
```

- [x] Pure/import-safe `decide_turn()` and shadow trace exist.
- [x] Placeholder, handoff, claim, cert, follow-up, product/general, context-gate, stock/select, and contact-info fixture coverage exists.
- [x] Readiness audit proved state/side-effect/multi-intent blockers; no production caller was added.
- [ ] No further runtime work here. Phase 2C replaces the one-action contract and names each legacy branch it deletes.

**Exit gate:** accepted as evidence only. Production wiring remains blocked until Phase 2B state/command truth and Phase 2C multi-need contract pass.

## Revised Phase 2A-2D: State, Verified Commands, Authoritative Subjects, And Botworker Scope

**Purpose:** Separate who may answer, which claim episode is active, what commands actually completed, and which products the customer is discussing. No layer may infer these facts from bot prose.

**Phase split:**

- **2A — accepted/frozen baseline:** executable lifecycle incidents, three-axis terminology, and blockers. Test/audit only; already committed as `37f6d30`.
- **2B — next implementation package:** authoritative ownership transport, claim episode/lifecycle consolidation, verified handoff result, and explicit claim outcome event.
- **2C — after 2B:** evolve `turn_decision.py` into multi-need `TurnPlan`, then make `ConversationSubjectSet` authoritative for follow-ups.
- **2D — after 2C, before Phase 3:** add fail-closed botworker eligibility at global, platform, and shop levels so a sandbox canary can process one selected shop without admitting any other shop.

**Files:** Phase 2B may modify `responses.py`, `warranty_flow.py`, `conversation_products.py`, `app.py`, `ChatAdminWeb/src/backend/service/handoffService.ts`, `statusConversationService.ts`, `botCallService.ts`, and the existing handoff/close API boundaries. Phase 2C may modify `turn_decision.py`, `conversation_products.py`, `route_context.py`, and `app.py`. Phase 2D may modify the existing system/shop configuration owners, botworker admission queries, `/shops` UI/API, and focused safety tests. Exact tasks and deletion gates are specified in the detailed Phase 2B/2C/2D sections below.

- [ ] Phase 2B first proves ownership-state transport and handoff outcomes independently from claim parsing.
- [ ] Phase 2B then consolidates claim episode activation, field acceptance, and transitions in one legacy owner; storage remains in `conversation_products`.
- [ ] Phase 2C RED-tests Q6->Q9, Q12->Q13, Q15->Q18, explicit topic switch, ambiguous references, and multi-need turns.
- [ ] Phase 2C resolves subjects once: explicit identity wins; referential turns use persisted subjects; bot prose is never truth; ambiguity clarifies.
- [ ] Compare/price/link/compat/policy consume the same subject set. An unavailable subject cannot be silently replaced by another product.
- [ ] Keep referenced product/category and order-policy facts stable across follow-ups. Persist customer/order facts, never the prior bot's policy conclusion.
- [ ] Phase 2D requires `global AND platform AND shop` eligibility before claim, buffer, or recovery admission; every new platform/shop defaults OFF.
- [ ] Phase 2D exposes platform switches and per-shop botworker switches on `/shops`, while preserving `connected` and `enabled_for_chat` as separate, unchanged concepts.

**Exit gate:** Phase 2B closes false-success handoff and claim lifecycle incidents with fewer owners/direct writes; Phase 2C preserves all independent needs and stable subjects; Phase 2D proves one-shop sandbox admission without processing another shop. Ticket ownership and explicit events outrank history markers throughout.

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

- [x] Inventory raw product/subtype/status/stock/variant values from real fixtures. (`exports/sellable_units.jsonl` + docs/test fixtures — recorded in active waythrough log)
- [x] RED-test `cable`, `cable_only`, and `c-to-c` normalization; unknown values remain traced unknown. (`docs/test/test_canonical_evidence_card.py` — **55 tests after 2 correction rounds**, honest RED → GREEN both rounds)
- [x] Evolve `make_evidence_card()` as the only canonical source adapter. (`requested=` param; `_canonicalize` internals delegate to `resolve_availability`; canonical writes at one site; executor canonicalizes before `_bucket`)
- [x] Separate requested-option status from whole-item sellability. Missing color is not sold out; one dead variant is not all-dead. (`requested_variant_state` — **structured resolver**: term→exact/unique-longest-contained→one option per dim→SKU row must satisfy ALL dims; never union overlapping options)
- [x] Enforce publish semantics: UNLIST-only is hidden; visible historical listing may answer spec/history; visible active listing is required to sell. (`customer_visibility` hidden→rejected (reason+count only — **no identity/name/item_id/hidden_mentions path**); `historical_only`→unavailable-answerable; `sellable` gate)
- [x] Remove raw-field checks from executor and selector. (executor/pool/selection/guards/dedupe read canonical fields or resolver — zero raw `status`/`sold_out`/`_available_for_sale` decision branches)
- [x] **Round-2 corrections:** unit cards preserve joined-listing `tier_variation`+model `tier_index` (structured, not prose); overlapping option names resolve most-specific only; flag-ON answer boundary **replaces** products with `selected_cards` (no legacy merge — `merge_selected_products` deleted); flag-OFF unchanged rollout; `PUBLISH_STATE`/`PUBLISH_RANK` owned by `product_store` beside `resolve_availability` (zero `product_store`→`retrieval_policy` imports)

**Exit gate:** issue #29 stock case, live multi-subtype coverage, and WPB100L policy pass without selector-specific raw strings. (offline replay 101 pass + canonical 55 pass + focused suites 521 pass — **live re-verify deferred; flag remains OFF in production rollout — grouped selection not yet active**)

> **Rollout note (Round 2+3):** when `grouped_retrieval_selection_enabled()` is OFF, `run_grouped_selection` never runs and legacy product context is unchanged — Phase 3 canonical path is inactive in production until the flag is enabled. When ON, `selected_cards` **replace** the legacy product list at both `llm.answer` callsites (KB ~2278, main ~4456); empty/hidden-only selection yields empty product context; **pipeline exception/None → fail closed `products=[]` — legacy products never re-enter** (corrected from the earlier "fallback retained for errors" claim).
>
> **⚠️ Activation blocker:** `BLOCKED_BY_PHASE4_SOURCE_UNION_DO_NOT_ENABLE_GROUPED_SELECTION` — the executor today unions only `units` + `legacy` sources. Enabling the flag makes canonical selection own the *entire* product context, but KB product identity, compatibility candidates, order/history anchors, image/OCR evidence, and other required sources are Phase 4 work. The flag must remain OFF in production until Phase 4 source union lands; Phase 3 review proceeds offline only.

## Revised Phase 4A: Complete The Evidence-Preserving Source Union (Runtime)

**Purpose:** Put every relevant source into one bounded pool while keeping support text separate from products.

**Files:** Modify executor, runtime, pool, policy, product_store, conversation_products, knowledge_base, app callsites; add unified-source tests; update SRS/log.

- Product candidates: unit, listing, exact identity, compatibility candidate, KB product identity (item/model only), order/history anchor, subject snapshot (historical-only).
- Evidence attachments: `kb_product`, `image_texts`, `subject_snapshot`, `compat`, `anchor` joined by identity domain.
- Supporting evidence: `kb_qa`, `kb_raw`, unmatched/name-only KB records, vision text; never a product candidate without product identity.

**Identity contract (corrected — two domains):**
- Candidate identity: `u:{unit_id}`/`v:{item_id}#{model_id}` (variant key — parseable `item:model` unit_ids canonicalize to the same `v:` key) → `i:{item_id}` → `n:{shop}:{name}` + `identity_quality` marker. Merge iff identical key; `m:{model_id}`-alone merging is forbidden (cross-item collision); variants sharing item_id never merge.
- Listing vs variant: when ≥1 non-rejected variant candidate exists for an item, the listing `i:` card must not remain a selectable candidate — its evidence converts to `item`-domain attachments joined to every matching variant (source provenance retained). Rejected-only variants never suppress the listing; with no variants the listing stays a normal candidate.
- Attachment identity: `item` domain joins all variants of an item; `model`/`v` domain joins only the matching variant (listing fallback + trace); `name` domain is low-confidence and never merges variants. Attachment joins never collapse candidates.

**Control flow:** the single early `run_grouped_selection` callsite (app.py:1831) is deleted; each mutually exclusive branch (KB / main) invokes the same `retrieval_runtime` owner once *after* its branch evidence is resolved → exactly one profile, one source union, one candidate pool, one selection per eligible turn.

**Bounded fetchers:** `fetch_products_by_ids` (batched subject/anchor identity — replaces per-entry find_one N+1), `fetch_products_by_models` (one `$or` model listing lookup scoped to shop for KB model-code docs), `fetch_products(include_unit_index=False)` for the legacy channel (kills unit early-return hiding + mislabeled cards).

- [x] RED-test source omission, partial unit result, KB-only evidence, missing live anchor, stale snapshot, source failure, bounded limits, variant non-merge, attachment domains, single-callsite-per-branch — `docs/test/test_phase4_source_union.py` (26 cases; honest RED 23F/3P → GREEN 26/26).
- [x] Add bounded adapters; record raw/eligible/unavailable/rejected counts and reasons per source attempt — `channel_request` (planner) + `channels` (executor) + `kb_product_evidence`/`fetch_product_docs_by_ids`/`fetch_products_by_models`.
- [x] Attach evidence by identity domain; name-only matching records explicit low confidence and never merges variants — `_join_attachment` owner (item/model/name domains), `identity_quality` marker.
- [x] Stale subject/anchor snapshots: `_snapshot_only` → `historical_only`/`unknown` states, `sellable=False`, no purchase link; live evidence always wins the merge — `_canonicalize` snapshot branch + materialize live-over-snapshot.
- [x] KB-only records without shop listing/unit evidence remain supporting evidence — never sellable candidates — name-only/no-identity → supporting channel; KB prose cannot set publish/stock (availability-primitives guard).
- [x] Populate `pool.supporting_evidence` + `attachment_evidence`; trace dropped candidates at per-request truncation.
- [x] Probe active, all-dead, UNLIST, stale model, null type, and missing OCR fixtures.

**Review-fix round (4 findings — 2 High + 2 Medium — verified and corrected at existing owners):**
- [x] Global pool dedupe: `build_candidate_pool` groups by `_identity_key` across **all** execution results of the turn — one `PooledCandidate` per identity with merged `sources`/`request_ids`; per-request scoring/role/slot/relation preserved via `request_scores`/`by_request`; attachment join targets the unique global list. No post-hoc cleanup pass.
- [x] KB model ownership: `kb_product_evidence` matches each fetched product to its exact KB model doc via `_doc_matches_model`/`_model_token_in_name` (boundary-aware — K9≠K90); unmatched model docs → supporting evidence independently; still one bounded shop-scoped query.
- [x] Supporting shape: KB `app.py` callsite passes `[{"kind","text"}]` sequence like the main branch — no bare dict (which iterated into `"kind"`/`"text"` string records); runtime keeps record contract, no coercion added.
- [x] Strict shop scope: `fetch_product_docs_by_ids` queries only the given shop when `shop_filter` is supplied — unscoped fallback deleted; missing scoped ids → `_snapshot_only` historical cards (sellable=False, no link); one unscoped query allowed only when no shop filter.
- RED 10F/5P → GREEN 39/39 contract cases; broad offline regression 971 passed / 20 skipped / 7 xfailed once.

**Implementation status (4A complete — flag OFF):** single `_identity_key`/`_join_attachment`/materialize owners; one canonical candidate per identity per turn; 2 mutually-exclusive branch callsites (early exec deleted); broad suite green (971 passed incl. incident replay + contract 39); `units.py`, refresh/build/import/DEPLOY untouched.

**Exit gate:** reviewed recall never decreases, no source hides another because it returned first, and exactly one union/pool/selection executes per eligible turn on each branch. Flag remains OFF.

## Revised Phase 4B: Atomic Daily Evidence Refresh (corrected 2026-10-19 — review round 1: 4 High + 3 Medium applied; review round 2: request-wide snapshot ownership + OCR accepted-state preservation; review round 3: generation-keyed caches + fingerprint-scoped pending budget; review round 4: independent KB/generated brand sources + per-fingerprint deferred error_class)

**Purpose:** Keep product exports, image text, sellable units, and embeddings fresh daily without downtime or half-published artifacts.

**Files:** Modify `scripts/refresh_data.sh`, `build_image_texts.py`, `build_image_texts_nonsellable.py`, `import_image_texts.py` (becomes cache-state owner only), `build_sellable_units.py`, `build_embeddings.py`, `import_sellable_units.py`, `units.py`, `product_store.py`, `conversation_products.py`, `knowledge_base.py`; create `chatbot/shopeechat/generation_pointer.py` (single snapshot/pointer resolver), `scripts/publish_generation.py` (validate→finalize→CAS→cleanup owner), `docs/test/test_phase4b_refresh.py`; `docker-compose.yml` (+`exports_data` volume); update DEPLOY/SRS/schema/log.

**Audit-proven facts (2026-10-19 — must drive the design):**
- `refresh_data.sh` runs unit NPZ **before** OCR → OCR never enters same-run `search_text` (which contains no OCR today — `build_sellable_units.py:174-208`); NPZ verify happens **after** `os.replace` and is print-only (`build_embeddings.py:153-162`); `sellable_units` upsert has no delete (live proof: jsonl=26,970 vs Mongo=27,807 stale units); `image_texts.jsonl` resume keys `image_id` only → URL change never re-OCRs; batch OCR bypasses `llm._generate` quota manager (raw genai client; 429→`error`, ~130s/image burn, no run-level stop); `mkdir` lock goes permanently stale on SIGKILL; `exports/` is baked into the image with **no volume** → container FS artifacts ephemeral and `image_texts.jsonl` resume state regresses on recreate.
- Per request today: `sellable_units` (live-mutated), `unit_embeddings.npz` (mtime cache), `product_embeddings.npz` (separate mtime), `image_texts`, live `ShpProducts` are resolved **independently** → generation mixing is the status quo, not an edge case.
- Runtime `image_texts` readers (all must consume the snapshot): `units.attach_image_texts` (:421), `product_store.search_cert_products` (:4108 via `_admin_image_texts_coll`), `conversation_products` (:311, :1325 — via `_units_coll`+attach chain). Non-runtime writers: `import_image_texts.py`.

**Generation identity:** `generation_id` = `g<UTC %Y%m%d-%H%M%S>-<8 hex>` (`uuid4` suffix — no same-second collision); allowlist regex `^g\d{8}-\d{6}-[0-9a-f]{8}$` validates every pointer field; derived-path check: `collection == sellable_units_{gid}`, `image_texts_collection == image_texts_{gid}`, file paths must start `exports/gen/{gid}/` — pointer cannot reference arbitrary collections/files.

**Publication sequence (finalize-before-pointer — corrected):**
```text
flock -n (exit before any Mongo/OCR/write work if held)
→ mint gid (dir mkdir collision → new suffix)
→ export source snapshot → gen dir
→ discover image identities → classify vs OCR cache
→ bounded incremental OCR (caps → remaining become `deferred`)
→ update OCR cache `image_texts` (mutable state — never read by runtime)
→ materialize published `image_texts_g<gid>` (immutable subset)
→ build units JSONL (OCR-aware) → build npz ×2 (verify BEFORE os.replace)
→ import `sellable_units_g<gid>` (+indexes)
→ validate counts/hashes/gen-id pairing across all artifacts
→ write+finalize manifest.json (tmp→os.replace) → verify finalized manifest+hashes
→ CAS pointer once (win/lose; never retry blindly)
→ canonical legacy copies (tmp+os.replace — optional, non-correctness)
→ grace-aware cleanup (best-effort — failure never rolls back activation)
→ lock auto-released on exit/kill
```
After the pointer CAS succeeds, **zero correctness-critical writes remain**. Failure before CAS leaves the old generation active; failure after CAS affects only optional copies/cleanup.

**OCR cache vs published evidence (corrected split):**
- `image_texts` (existing) = OCR **processing cache/state owner** only: `fingerprint` (`image_id`+normalized_url), `status` (`ok|error|deferred`), `error_class`, `attempts_total`, `last_generation_id`, reusable `text`. Updated during build phase. **Runtime never reads it.** It does not prove what evidence is active.
- `image_texts_g<gid>` = **published OCR evidence** per generation: `{image_id, image_url, kind, text, truncated, item_ids}` — only `ok` records attached to that generation's catalog images; materialized from cache pre-pointer; immutable post-publish; pointer carries its name; all three runtime readers use `snap.image_texts_collection`. Removed images → absent from published set (cache retains audit + `item_ids=[]`).

**Pointer + CAS contract (corrected):** `sellable_units_meta {_id:"active"}` holds the complete validated snapshot `{generation_id, units_collection, image_texts_collection, units_npz, product_npz, units_jsonl, manifest_path, manifest_sha256, unit_count, npz_rows, activated_at, previous:{…same fields…}}`.
- Publish: `update_one({_id:"active", generation_id: expected_current}, {$set: next})` — `matched_count==1` won; `==0` lost → one bounded reread to classify, no retry loop.
- Bootstrap: `update_one({_id:"active", generation_id:{$exists:false}}, {$set: full}, upsert=true)` — existing doc can't match → insert attempt → `DuplicateKeyError` = conflict (fenced without transaction). Pointer-absent is a distinct expected state, not corruption.
- Rollback: `update_one({_id:"active", generation_id: expected_active}, {$set: {top←previous, previous←displaced}})` — stale rollback (expected≠actual) matches 0 → never overwrites a newer publish.

**Request snapshot (corrected — one owner, every generated source):** `generation_pointer.py` (new, imports only `knowledge_base` lazily → no cycle) owns `EvidenceSnapshot` (frozen dataclass: `generation_id, units_collection, image_texts_collection, units_npz, product_npz, units_jsonl, manifest_path, manifest_sha256, activated_at`) + `resolve_snapshot(db=None)` — reads `sellable_units_meta.active`, validates allowlist+derived paths, short TTL returns the *same immutable object* to all in-window callers. **Request owner = `_chat_impl`**: resolves `EvidenceSnapshot` exactly once per `/chat` request (post post-handoff lock, pre engine dispatch) and threads the captured value — which may legitimately be `None` — into every generated-source consumer (`fetch_products`×n, `lookup_kb`, `qa_context`, `materialize_subject_cards`, `get_active_product`, `search_cert_products`, `_device_spec_lookup`, `reanswer`, `fuzzy_match_products`, `run_grouped_selection`/`_shadow`, handoffs/warranty ctx dicts, `chat_v2`/`chatbotv3` dispatch). Consumers take `snap` — `SNAP_UNSET` (argument omitted) distinguishes a standalone caller from a captured `None`: a supplied value, including `None`, is **never re-resolved**. Standalone entries (`chat_v2`, `chatbotv3.chat_v3`, `retrieval_executor`, `fetch_products`, `search_cert_products`, `_load_vector_store`, `materialize_subject_cards`, `lookup_kb`, `qa_context`) resolve once at their own boundary only when `snap` is omitted. npz caches key by immutable path. Pointer flip mid-turn cannot change that turn's sources (callers hold the captured object; TTL is cache-only, not a consistency fence). **Caches that store generation-derived data key by the captured generation identity** (H1-r3/M1-r3): `_LIVE_CARD_CACHE` = `(item_id, model_name, gen_id|None)` at both `_materialize_card` and `materialize_subject_cards` (30s TTL unchanged — a card built under gen A is never served to a request holding B or captured-`None`); `_brand_cache` = single entry `{gen, ts, brands}` — hit only when `gen` matches the supplied snapshot's `generation_id`; `kb_products` and generated-units brand reads sit in **independent failure boundaries** (one source's failure never discards the other; captured `None` performs zero unit reads), total failure falls back to that generation's baseline, never to another generation's set. Missing/invalid pointer or `npz.generation_id ≠ snap.generation_id` → fail closed to keyword/legacy path — never the mutable base `sellable_units`. Pre-first-pointer: legacy listing path + canonical `product_embeddings.npz` remain; **unit/grouped semantic path stays dark (fail-closed)** — no false atomicity claim.

**Incremental OCR contract:** fingerprint = `image_id`+normalized_url → `unchanged|new|changed|retryable_error|deferred|removed`; unchanged reuse; new/changed OCR once within run budget; retries only retryable errors, bounded; quota/cap exhaustion → `deferred` + run-level stop (not `error`, not failed generation); **accepted-state preservation (M1): accepted fields (`status`, `fingerprint`, `text`, `kind`, `truncated`) are authoritative — a failed/deferred OCR on a *changed* fingerprint writes `pending_*` fields (`pending_fingerprint`, `pending_status`, `pending_error`, `pending_error_class`, `pending_attempts_total`, `pending_last_generation_id`) on the same doc instead of clobbering them; a later success promotes pending → accepted and clears pending fields (`$unset`); publish uses a doc only when `accepted fingerprint == discovered fingerprint`; `pending_attempts_total` belongs to `(image_id, pending_fingerprint)` (M2-r3): ≥`MAX_ATTEMPTS` blocks retry only when `pending_fingerprint == discovered`; a newer fingerprint C gets its own budget — pending identity switches to C, attempts reset to 0 then count C's attempts, B's error fields never carry over, and a pre-provider-call deferral writes `pending_*` with zero attempts; accepted A stays, B never published); new images without accepted evidence keep ordinary `error`/`deferred` records**; partial/missing OCR never blocks publish. OCR→`search_text`: only `spec|variant_map|product` kinds, caps (≤400/≤200/≤200, total ≤800), dedupe, boilerplate filter; `banner` supporting-only; full OCR stays an attachment via `attach_image_texts` on the published collection.

**Retention/cleanup (corrected):** never delete active; never delete previous; never delete any generation younger than fixed grace **24h** (covers max request lifetime + pointer TTL + drain + margin — documented fixed value, no config field). Cleanup lists `*_g*` collections/`exports/gen/*`, rereads pointer, drops only gens absent from active+previous AND older than grace; failed staging gens follow the same absent-check. Cleanup runs post-activation, best-effort, injected clock in tests. Repeated same-day publishes accumulate protected gens until grace passes.

**Lock (corrected — native):** `flock` binary is **verified present** in `python:3.11-slim` (`/usr/bin/flock`, util-linux — required package set): `exec 9>"exports/.refresh.lock"; flock -n 9 || { echo skip; exit 0; }`. Held via the open file descriptor for the whole run; auto-released on exit/kill/container restart — no stale-lock protocol, no PID check. Covers the entire refresh, not just publish. (Contingency if a future image drops util-linux: Python `fcntl.flock` on the inherited OFD — stdlib, same semantics; not implemented now.)

**09:00 capacity contract (corrected — honest):** hard run budget = `--max-calls` (default 1500/day-run) + `MAX_ATTEMPTS=3`/image + new `--max-runtime-min` (default 90); hitting any limit → remaining work `deferred` (resumes next run). Embeddings are local (no provider quota) but duration is a canary observation, not a claim. Provider: dedicated `IMGTXT_GEMINI_API_KEY_*` pool **preferred**; shared chat keys require explicit operator acceptance of contention and the bounded run cap is what limits damage — shared quota is **not** claimed safe. First-ever full backlog = manual off-hours. Cron `0 9 * * *` Asia/Bangkok activates **only after** first generation + timing evidence — operator gate, never agent-installed.

**Manifest** (`exports/gen/<gid>/manifest.json`): non-secret operational metadata only — `{generation_id, counts, sha256 per artifact, validation results, status, activated_at}`. Finalized (tmp→os.replace) **before** pointer CAS; pointer records `manifest_path`+`manifest_sha256` and never references a pending manifest.

**Out of contract:** `qa_embeddings.npz` (KB domain, rebuilt in place); `kb_products`, `kb_qa`, live `ShpProducts`, `itStock` (shared/non-generated sources — `attach_kb_specs` switches its db handle to `_kb._admin_db()`).

- [x] RED-test (offline: tmp dirs + fake Mongo + leaf stubs; no torch/provider/real Mongo): fingerprint classify ×6 states; unchanged=0 OCR calls; new=1; changed URL=1; retryable bounded; quota/cap→`deferred`; removed→detached from published set; cache update invisible to active generation; pointer flip exposes new `image_texts_g*` atomically; one snapshot reaches units+product vectors+OCR readers; mid-request flip doesn't mix; manifest finalized before CAS; zero correctness writes after CAS; publish CAS loss keeps winner; stale rollback can't overwrite; concurrent bootstrap → one pointer; publish within grace keeps in-flight gen; cleanup ignores active/previous/young; cleanup failure doesn't invalidate activation; second refresh exits before provider/Mongo writes; killed lock owner leaves no permanent lock; same-second gid no collision; budget exhaustion→deferred; run cap never exceeded on shared quota; npz/collection/manifest mismatch blocks activation; missing pointer fail-closed; missing OCR non-blocking; banner excluded + caps + dedupe; manifest has no secrets. — **`docs/test/test_phase4b_refresh.py` 39 tests: RED 39/39 → GREEN 39/39**
- [x] Implementation order: RED file → `generation_pointer.py` → scripts (fingerprint/deferred/state, gen-dir builds, gen-coll import, publish owner) → runtime snapshot threading → `refresh_data.sh` rewrite → docs. Old publication paths become unreachable in the same diff (base `sellable_units` writer removed; `_load_done` jsonl state replaced by cache coll; direct `image_texts` runtime reads removed). — **implemented 2026-10-19; structural gates: 0 mutable `image_texts` runtime readers, 0 base writers, `flock` lock**
- [ ] Operator gates: real Mongo privileges (create/drop `*_g*`, write `sellable_units_meta`, upsert `image_texts`); `exports_data` volume on deploy host (first-up copy-up seeds from image; image updates do **not** reseed existing volumes — runbook documents first-gen bootstrap); `IMGTXT_GEMINI_API_KEY_*` decision; first manual refresh post-deploy (units dark until first pointer); `0 9 * * *` cron install after timing evidence. — **ยังเป็น gate ค้างทั้งหมด (ตาม design — agent ไม่ install cron/deploy)**

**Exit gate:** a failed run leaves the previous accepted generation untouched; a successful run publishes one consistent generation (units collection + published OCR collection + both npz + manifest) through a single CAS; rollback is one CAS; in-flight requests are protected by grace, not just active+previous.

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
    missing_evidence: tuple[str, ...]   # R1: evidence absent at decision time
# R1 — PolicyQuery += evidence_ids/evidence_by_subject/conflicting_evidence
```

- [x] Define versioned policy records as data, not Python branches: shop scope, canonical product type/category, reason, allowed item conditions/order states, outcome, required evidence, priority, effective dates, source, and version. — `PolicyRule` frozen dataclass + `policy_rule_from_dict`; production activation blocked: `active_policy_rules()` returns `()` until an approved record store exists.
- [x] Resolve by deterministic specificity and effective date. Conflicting, missing, or incomplete rules return `admin_review`/`unknown`; they may never default to eligible. — `resolve_policy` (effective-date → scope → reason/condition/order_state → precedence tier specificity→priority→version **before** conflict — R1-M1: lower-precedence general rule cannot conflict with a higher-precedence specific rule; conflict only inside the winning tier).
- [x] **R1-H3** Winning rule's `required_evidence` must be supplied+consistent — missing or conflicting evidence → `admin_review` with `missing_evidence` naming the absent ids; never `eligible`/`ineligible` on absent evidence. Supplied evidence comes from `PolicyQuery.evidence_ids`/`evidence_by_subject` only — never inferred from customer prose, FAQ, history, or bot answers.
- [x] **R1-M1** Specificity/priority precedence implemented: shop/subject/category-specific rule beats a general rule deterministically; equal-rank conflicting rules → `admin_review` (`rule_conflict`); expired/pending rules excluded before tiering (`rule_expired`/`rule_pending`/`rule_window_unverifiable` codes); same rule_id multiple versions → **R2-D: newest valid `effective_from` wins — `version` is an opaque identity, never compared lexicographically; same-day conflicting outcomes → `rule_conflict`/`admin_review`; malformed dates rejected at `policy_rule_from_dict` (stdlib `datetime.fromisoformat`)**.
- [x] RED-test customer-selected wrong model versus seller-sent wrong item, defect, opened outer packaging versus opened inner seal, unknown condition, conflicting rules, expired rules, shop/category mismatch, and a general FAQ that contains positive exchange wording but has no matching eligibility rule. — `docs/test/test_phase5_field_policy_compat.py` 52 tests, honest RED → GREEN.
- [x] For the supplied filter fixture, load the shop/category wrong-model prohibition as fixture policy data. Do not put the shop name, filter term, or sentence in production logic. — fixture supplies `policy_records`; `tx-policy-wrong-model-filter` flipped incident→positive (`ineligible` via typed decision).
- [x] Stop `_extract_policy_from_descriptions()` and generic `answer_general()` context from deciding case eligibility. They may explain general process only after `PolicyDecision` is known. — return_policy `policy_only` path = `general_faq` explanation + deterministic typed outcome at the final boundary; description scraping remains only for shipping and warranty-terms fallback (non-eligibility qtypes).
- [x] **Policy-only ownership:** `PolicyDecision` is the sole eligibility owner for a pure return/exchange-policy answer. `guards.enforce` renders `_POLICY_TEXT_*` deterministically after handoff and `LLM_ERROR_REPLY` handling; `guard_rewritten="policy_decision"` is the structural idempotency marker. `_enforce_policy_claim`, `_RETURN_CLAIM_ANY`, and `_policy_decision_txt` remain deleted; generic `return_claim` rewriting applies only when no typed decision exists.
- [x] **Mixed product + return-policy textual composition is deferred — closeout applied (uncommitted).** R5 proved the product LLM receives the raw mixed question and returns one untyped prose blob, so it can emit a policy conclusion that contradicts the appended typed segment. Closeout applied: `_chat_impl` fails closed to `_send_handoff` (`reason="policy_mixed_review"`) before any product LLM call — admin-review deterministic answer on confirmed transport, `HANDOFF_FAILED_REPLY` on failure (terminal at `guards.enforce`), typed `PolicyDecision` kept as routing diagnostics, already-resolved cards retained without extra retrieval; `_pdec_mode`/serialized `composition`/the mixed-append branch deleted. No prose stripping or prompt-compliance assumption used. The replacement work is split explicitly across Phase 6 (structured per-need interpretation), Phase 7 (need-scoped answer input/context), and Phase 8 (typed answer segments plus one finalizer); mixed automatic answering stays off until all three exit gates pass.

- [x] **R6 — pure `return_policy` unknown/admin_review now require authoritative handoff (uncommitted).** Defect: production `active_policy_rules()` returns `()` → pure `unknown` → fell to `answer_general` (wasted model call, result discarded) and `enforce` emitted admin-review wording with no handoff. Fix: the `_pdec` block in `_chat_impl` is the single decision/action owner — `unknown`/`admin_review` → `_send_handoff(reason="policy_review_required")` exactly once (success → admin-review answer + flags; failure/no conversation_id → `HANDOFF_FAILED_REPLY`, no success claim); `eligible`/`ineligible` → deterministic `_POLICY_TEXT_*` zero-model response, no handoff; mixed contract unchanged (`policy_mixed_review`). `enforce` keeps `HANDOFF_FAILED_REPLY` terminal + `policy_only` render. Typed decision remains diagnostics in `routing_decision`.
- [x] **R1-H2** One `PolicyDecision` per eligible return-policy turn, computed once at the `general_qtype` block, carried by `_rd_extra()` closure → `routing_decision` at **all 7 return sites** (general, mixed product+policy, model/item-specific, tagged-item, web-search, no-product, superlative). No second resolution, no prose re-classification downstream. Replay fixtures: `pos-policy-return-model-item`, `pos-policy-return-tagged-item` (+ `tx-policy-wrong-model-filter`, `pos-policy-seller-wrong-item`).
- [x] **R1-H4** Production classifier emits typed policy signals: `policy_reason`, `policy_item_condition`, `policy_order_state` in the JSON prompt contract + default result; closed-enum validation (`POLICY_REASONS`/`POLICY_CONDITIONS`/`POLICY_ORDER_STATES`) — invalid/missing → `unknown`, never keyword-guessed. Zero new model/provider calls; threaded through existing `intent_result` → `build_policy_query`.

- [x] Define stable fact keys (`output_w`, `capacity_mah`, `water_rating`, `wifi_bands`, `certifications`, `connector`, `protocols`, `warranty`) with source and identity. — `FieldEvidence` + `extract_field_facts`/`device_field_facts`; every fact bound to `candidate_pool._identity_key` subject.
- [x] RED-test issue #28 unsupported 5ATM/IP68/GPS/day/GHz/mm claims and cross-product spec leakage. — `claim_supported` typed guard; contract tests cover all listed claims + cross-product isolation. **R1-H5: production caller is now `guards._spec_fact_grounded` inside `enforce` (the single output boundary) — spec tokens are checked against `FieldEvidence` of the exact `routing_decision["subject_ids"]` identities only; another product's facts cannot ground a claim; `kb_inherit`-sourced facts (specs borrowed via own model_codes) do not ground; missing evidence → ask-admin phrasing, never a negative factual claim. **R2-B fail-closed: >1 subject_ids → ungrounded always — the free-form answer contract has no structured claim↔subject relation (`answer_segments` are plain strings); no prose name-parsing or keyword matching added.** `attach_kb_specs` stamps `_specs_origin="kb_inherit"` for provenance.
- [x] Scope TISI/CCC/CE by current subject/type/subtype and visibility; missing OCR is unknown. — cert facts emitted per-subject from that subject's own card text (reuses `_CERT_SEARCH_RES`/`_has_cert` — no new vocab); absent fact = unknown.
- [x] Require explicit proof for compatibility and incompatibility; missing proof remains unknown. — `resolve_compat` single owner; `incompatible` requires declared disjoint connector set or declared proof; missing evidence → `unknown`; `unknown` never becomes exclusion (asked subject protected; ambiguous non-subject merge-back unchanged). **R1-H6: evidence provenance preserved — `device_field_facts` requires a structured `source` (spec-db/web-structured); an `intent` connector hint produces no provable fact → `unknown` (`hint_only_device_evidence`), never `incompatible`; all-candidates-proven-incompatible returns protected subjects only (explanation via `_context_note`, never as recommendations); `if not compat: return products` behavior removed.**
- [ ] Remove `phone -> charger` and `_SKIP_TYPES` only after profile/slot/compat replay passes. — **retained (deliberate):** both are mode/type-detection gates upstream of the per-product verdict — `resolve_compat` replaced compat verdicts, not mode gating; removal needs its own focused replay. Recorded as retained legacy branch with caller+blocker in waythrough.
- [x] When customer evidence conflicts with missing DB evidence, acknowledge uncertainty rather than repeat the prior claim. — customer-only/conflicting declared proofs → `admin_review` (`customer_evidence_unverified`/`proof_conflict`), never a repeat of an earlier claim.

**Exit gate:** issue #28 passes without model-specific code; positive Mi 17/iPhone cases remain; unknown evidence never becomes a negative claim; filter wrong-model replay is `ineligible`, seller-fault positive fixtures retain their configured outcome, and no policy outcome is inferred from bot history or broad prose. Pure policy answers are deterministic. Mixed product + return-policy turns are fail-closed and cannot auto-emit an eligibility verdict until the Phase 6/7/8 replacement contract is complete.

**Review-fix round (R1) closed — uncommitted:** H1 typed decision authoritative at `guards.enforce`; H2 single decision carried to all 7 return sites (4 executable fixtures); H3 required-evidence gate + `missing_evidence`; H4 classifier emits closed-enum policy signals; H5 field evidence now grounds spec claims at the boundary for the exact subject identity; H6 provenance-aware compat (intent hint ≠ proof, all-negative → protected-only); M1 precedence tier before conflict; M2 deleted `lookup_device_spec`/`POLICY_OUTCOMES`/`COMPAT_OUTCOMES`; complaint-vs-hypothetical coverage: `pos-complaint-seller-wrong-item-real` (real complaint → order_problem owner) + hypothetical eligibility fixtures on the policy route. Focused evidence: contract suite 81/81, spec-grounding 36/36, compat script 144/144, replay 105p, validator clean.

**Correction round 5 (R5) — BLOCKED (uncommitted):** mixed turns can still carry two contradictory policy conclusions (LLM-emitted prose inside the product blob + appended typed segment). Feasibility audit: `ChatResponse.answer`/`answer_segments` are one untyped prose blob; `llm.answer` input is `desc_message = req.message` — the policy question reaches the product LLM verbatim; `TurnNeed` has no per-need question text; no typed product segment exists. Removing LLM-emitted policy prose without prose parsing requires the Phase 8 typed mixed-answer segment contract (per-need scoped input from the interpretation boundary + product-owned typed segment composed with exactly one `PolicyDecision`-rendered segment). No runtime change made in this round; heuristic/stripping approaches are explicitly disallowed.

**Correction round 4 (R4) closed — uncommitted:** **M1** mixed composition idempotency moved to the structural `guard_rewritten=="policy_decision"` marker — `_final not in resp.answer` prose-membership removed; `policy_only` always canonicalizes answer/segments/marker; `mixed` composes at most once and is byte-stable on re-run. **M2** `PolicyQuery.event_time` parsed via stdlib `fromisoformat` → canonical `YYYY-MM-DD` compared directly against canonical rule dates; malformed/missing event time with dated rules → `rule_window_unverifiable` fail-closed; `_day` helper deleted. Evidence: 4 honest RED → contract 127/127; replay 105p; spec-grounding 36/36; compat 144/144; guards 27/27; action-switch+turn_decision 150p; classifier 10/10; validator clean; diff-check clean. Complexity: helpers −1, regex/vocab +0, owners unchanged (decision=`resolve_policy`, composition=`enforce`).

**Correction round 3 (R3) closed — uncommitted:** **A/HIGH** mixed-answer destruction fixed — `composition` mode (`policy_only`|`mixed`) decided once at the `general_qtype`/needs branch, carried in `policy_decision` via `_rd_extra`; `mixed` = ordinary product guarding then exactly one `|||` deterministic segment appended (idempotent), product info retained; eligibility prose/decision marker removed from `_policy_carry` (product LLM never sees eligibility — not delegated); `_policy_decision_txt` deleted. **B** `LLM_ERROR_REPLY` escalation moved before policy composition — provider failure never masked. **C** canonical dates: `effective_from`/`until` normalized to `YYYY-MM-DD` at `from_dict` (basic `YYYYMMDD`/datetime → same day); `until < from` rejected. **D** same-rule_id same-day records: identical decision payload → dedupe; any decision-relevant difference → `rule_conflict`/`admin_review` — no requirement/source unioning. **LOW** dead `_pdec_active` condition removed. Evidence: 12 honest RED → contract 117/117; replay 105p; spec-grounding 36/36; compat 144/144; action-switch+turn_decision 150p; guards 27/27; classifier 10/10; validator clean; diff-check clean. Complexity: helpers +0, regex/vocab +0, policy owners =1, composition owners =1 (enforce), runtime functions +0.

**Correction round 2 (R2) closed — uncommitted:** **A/H1** deterministic rendering — `_enforce_policy_claim`/`_RETURN_CLAIM_ANY` deleted; typed outcome owns the entire final answer (mutation-proof, incl. `เปลี่ยนไม่ได้`/`ไม่เข้าเงื่อนไขการเปลี่ยน/คืน`/empty). **B/H2** multi-subject spec grounding fails closed — no claim↔subject structure exists. **C/M1** required-evidence stays unsupplied in production — traced `req.order_sn` (customer text, unverified), `lookup_order` (claim path only), `load_claim_state` (other-episode, not attributable) → **no authoritative evidence owner exists at the decision point → activation blocker stands**; resolver gate tests retained. **D/M2** opaque `version` never ordered — newest valid `effective_from` wins; same-day conflicting → `rule_conflict`; malformed ISO dates rejected. 8 honest RED → contract 96/96, spec-grounding+replay 141p, compat 144/144, guards 27/27, classifier 10/10, validator clean, `git diff --check` clean. Complexity: keyword/regex tables +0, phrase variants +0, helpers −1, policy owners =1, spec owners =1, runtime functions −1. **Remaining blocker:** production required-evidence supply (activation stays blocked).

## Operational Track After Phase 5: Logging And Analytics Truth

**Priority:** Start only after Phase 5 is committed. Complete Analytics Truth before Phase 6; provider observability may not run in parallel with chatbot answer-flow work because it touches shared Python boundaries.

**Purpose:** Make the three analytics pages and operational logs report persisted evidence rather than aliases, residual arithmetic, hard-coded deltas, or unauditable provider assumptions. This track observes the runtime; it must not become another decision owner for chatbot, workflow, trigger, handoff, or botworker behavior.

### Track A: Analytics Truth

- [ ] Define one explicit time-window and timezone contract shared by `/analytics/live`, `/analytics/performance`, and `/analytics/admin-activity`; return the window in every API response.
- [ ] Replace aliased chart payloads and hard-coded deltas/sparklines with independently computed series. Unsupported metrics return `null`/`unavailable`, never fabricated zeroes or reused `customersByChannel` data.
- [ ] Count bot answers, admin answers, unanswered turns, connected shops, and SLA only from their authoritative persisted events/statuses. Zaapi/external `role=admin` rows without a verified admin actor must not inflate admin response metrics.
- [ ] Fix the dashboard cache write path and remove debug output that can leak implementation details.
- [ ] Add route/service contract tests for empty data, mixed platforms, boundary timestamps, missing actor identity, status partitions, and truthful unavailable metrics.

**Track A exit gate:** all three pages use the same declared window/timezone; every displayed number maps to one named source/query; no chart aliases or hard-coded trends remain; labels describe exactly what is counted.

### Track B: Audit Event Correctness

- [ ] Inventory every `admin_logs` writer and reader; define one action vocabulary and minimum event fields (`event_id`, `action`, actor identity/type, platform, shop/conversation identity where applicable, occurred time, correlation identity, outcome).
- [ ] Remove duplicate writes at the owning command boundary. Preserve one durable event per accepted command; retries reuse the same event identity where the command is idempotent.
- [ ] Reconcile emitted actions with consumers such as `/team`; delete or migrate reader expectations for actions no producer emits.
- [ ] Keep customer text, credentials, full provider payloads, and raw prompts out of audit events.

**Track B exit gate:** writer/reader action census has no orphan required action, duplicate command events converge, and admin-activity totals are reproducible from stored rows.

### Track C: Provider And Cost Observability

- [ ] At the existing provider-call boundary, persist one sanitized usage event with role, requested provider/model, actual provider/model after fallback, safe key reference/hash (never the key), token counts, cost, latency, outcome/error class, message/turn correlation, and retry/attempt identity.
- [ ] Cover Gemini, OpenRouter web search, intent, vision/video, and answer roles without adding provider calls or changing routing/fallback behavior.
- [ ] Make repeated delivery/recovery/finalization idempotent for usage accounting; one provider attempt must not be charged twice in analytics.
- [ ] Expose provider/model/key-reference and cost views only after completeness tests prove that unknown usage is displayed as unknown rather than zero.

**Track C exit gate:** an operator can trace each charged provider attempt to one turn and actual model/key reference without seeing secrets; totals equal the underlying usage-event sum; missing telemetry is explicit.

**Safety and sequencing:** Track A may use a separate branch/worktree after the Botworker soak closes. Tracks B/C remain sequential with chatbot/runtime work. Each track updates its own tests, SRS/schema where contracts change, and active waythrough entry; shared-document conflicts are resolved once by the integration owner. No real provider call, production write, or analytics backfill is authorized by this roadmap entry.

## Revised Phase 6: One Selector With Coverage And Roles

**Purpose:** Select per need from the canonical pool and stop appending arbitrary legacy products afterward.

**Files:** Modify selector, runtime, and pool; extend tests/replay; update SRS/log.

- [x] RED-test multi-type/subtype, compare pair, relation pair, subject, unavailable subject, hidden mention, and alternatives.
- [x] **Moved from Phase 5 R5:** extend the existing `classify_intent` → `decide_turn` → `TurnPlan` path (no second planner/model call) so each independent need carries structured requested fields/ranking/relation and enough typed scope to build a need-specific request. Exact identities and persisted lifecycle state remain deterministic authorities; intent remains a proposal. Delete each replaced semantic keyword branch in the same diff.
- [x] Select from canonical types/roles/facets only.
- [x] Keep `subject`, `relation_target`, `alternative`, `historical_evidence`, and `hidden_mention` distinct.
- [x] In canary mode, make legacy base products a preselection source, not a postselection append. *(grouped path unions `legacy_fetcher` results into the canonical pool before selection; flags remain OFF — see closeout)*
- [x] Keep unavailable/rejected summaries outside recommendations.

**Exit gate:** Q6-Q10, Q15-Q18, AD1404T, and live multi-subtype probes pass; selected duplicates are zero; one existing TurnPlan owns all needs; no parallel semantic planner or new keyword fallback remains; mixed product and policy needs can be represented separately without parsing answer prose.

**Phase 6 closeout (committed — see waythrough `getoutofmywaybotkaikrook2.md` for the hash):** `TurnNeed` carries only honestly owned structured scope/ranking — product/compare needs receive intent product scope (conf≥0.7 via `route_context.intent_product_scope`); compat and other kinds stay empty because `RetrievalRequest`/relations remain the relation-scope owner (no turn-wide scope stamping, no connector-window reconstruction). Mixed product+compat scope is isolated in both directions (powerbank cannot leak into compat; charger/cable cannot leak into product). The selector consumes one `TurnPlan` for request→need attribution and `need.ranking` ordering; identity dedupe and role precedence (`subject > relation_target > historical_evidence > alternative > slot`, `hidden_mention` label-only) are canonical. Reversed relations (`สายที่ใช้กับ AD1404T`) require typed productish needs via `PRODUCTISH_NEED_KINDS` (owner: `turn_decision`); production and `retrieval_shadow` derive the same `allow_reversed` contract, absent needs fail closed. `intent_confidence` (single normalization owner) bounds malformed/bool/non-finite/out-of-range confidence to `0.0` — fail closed, no exception. `SelectionResult.by_need`/`uncovered_needs` were removed as speculative Phase 7 surface — deferred to Phase 7 `AnswerContext` when a real consumer exists. `_REL_ASK` deleted; zero new semantic keyword tables (`_RANK_FIELD_KWS` moved verbatim from the deleted app.py superlative block). Grouped retrieval flags (`USE_GROUPED_RETRIEVAL_SELECTION`/`_SHADOW`) remain OFF. Phase 7 still owns need-scoped answer context (incl. `unanswered_needs`, card-cap replacement, prompt-token measurement, web gate); Phase 8 still owns typed answer composition. Fixed-card-cap removal, web-search planning, and prompt-token measurement were **not** implemented in Phase 6. **Frozen verification:** Phase 6 suite 27/27; affected batch 528 passed / 21 skipped / 4 xfailed (baseline-identical); fixture validator 72 rows pass; `py_compile` clean; `git diff --check` clean; runtime delta +408/−88 = +320 net.

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
- [ ] **Moved from Phase 5 R5:** compile a need-scoped product request/context from the Phase 6 structured need. The product answer call must not receive the return/exchange-policy question or eligibility context; policy evidence remains in the typed `PolicyDecision` channel. Prompt instructions alone are not a correctness boundary.
- [ ] Include only the resolved `PolicyDecision`, the matching rule explanation, and required next-step evidence for policy turns. Exclude unrelated policy snippets and prior bot conclusions.
- [ ] Replace fixed 30-card behavior with per-need quotas plus a hard emergency cap.
- [ ] Measure system prompt separately; remove duplicated rules only with regressions. Treat provider caching as optional optimization.
- [ ] Decide web search before the answer. Never use web for local catalog existence, stock, price, or unresolved local identity.
- [ ] Delete dead context work and prevent unchanged context from being resent to LLM2.

**Cost gates:** product-context p95 drops at least 30%; estimated p95 cost is below 1 THB/turn; local catalog hits do not trigger web; normal turns have one answer call. Mixed-turn tests prove the product call receives only its scoped need and no policy question/context.

## Revised Phase 8: One Answer Boundary And Output Contract

**Purpose:** Migrate KB, main, item-tag, and web paths to one context/render/guard boundary.

**Files:** Modify `app.py`, runtime, LLM, guards, web search; add unified-boundary tests; update SRS/log.

- [ ] Introduce one canary orchestration call that consumes decision, subjects, and `AnswerContext` without re-retrieval.
- [ ] **Moved from Phase 5 R5:** replace the untyped prose-only contract with typed answer ownership (`product`/`policy`/`claim` or an equivalent existing-contract extension). The single finalizer renders exactly one policy segment from `PolicyDecision`, composes it with product-owned content, and is byte-stable on replay. Do not use prose membership, policy synonym tables, or a sanitizer as ownership evidence.
- [ ] Migrate main, KB, item-tag/spec, then web-enriched callsites one commit at a time; delete each old merge/context block.
- [ ] Apply persona, whitespace, language, separators, private-key stripping, and claim validation to LLM and canned responses through one finalizer.
- [ ] Validate numeric/unit/cert/compat claims against evidence for the same subject; soften unsupported claims without inventing handoff/product.
- [ ] Validate positive and negative return/exchange claims against the matching `PolicyDecision`. A positive promise requires `outcome="eligible"`; `ineligible` must explain the configured reason without offering an exchange; `unknown/admin_review` must not promise or deny eligibility.
- [ ] Persist response subjects/products, not preselection candidates.

**Exit gate:** issue #30 formatting/language/noise cases and issue #28 claim checks pass; one product-answer boundary remains. Mutation tests prove typed eligible + injected LLM denial and typed ineligible + injected LLM approval cannot produce contradictory final policy conclusions. Only then may mixed product + return-policy automatic answering be enabled.

## Revised Phase 9: Workflow And Trigger Ownership Consolidation

**Purpose:** Apply the Phase 2B ownership/handoff contract and Phase 2C TurnPlan to the pre-chat workflow/trigger stack, leaving one orchestration order without changing the proven assignment primitive.

**Files:** Audit then modify the actual workflow/trigger orchestration owner; add precedence/state tests; update docs/log. Botworker changes require its paused-canary gate to be reopened explicitly.

- [ ] Inventory workflow resume/match, trigger match, chatbot invocation, delivery, and multi-output ownership.
- [ ] Choose one precedence contract for active workflow, new workflow, trigger, and TurnPlan; remove `both` behavior where it can emit competing customer answers.
- [ ] Gate workflow/trigger execution by authoritative ownership and verified command outcomes from Phase 2B.
- [ ] Label shadow generation as non-delivered; no shadow/test state may prove a live handoff.
- [ ] Delete duplicate TestChatClient orchestration or make it call the production owner rather than reimplementing precedence.

**Exit gate:** one orchestration order exists; workflow/trigger cannot bypass ownership or produce an untracked second answer.

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
- One normal turn has one TurnPlan, subject set, pool, selection, context, and answer boundary; independent needs are preserved inside the plan.
- `app.py`, `handoffs.py`, and `warranty_flow.py` have net complexity reduction from Phase 0.
- p95 estimated cost stays below 1 THB and every web fallback has an evidence reason.

## Execution Order And Parallelism

Run `0 -> 1 -> 2A (accepted) -> 2B -> 2C -> 2D -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10`.

- Begin next at **2B.1** after this revision is reviewed. Do not rerun or enlarge 2A as a substitute for implementation.
- Do not run Phases 2B-8 in parallel on one branch; contracts and `app.py`/botworker boundaries are sequential.
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
7. Delete the replaced branch; a disabled duplicate is not retirement.
8. Run unit, integration, multi-turn replay, compile/typecheck, and `git diff --check`.
9. Update SRS/log with measurements and residual risks.
10. Show staged scope and ask before the phase's first commit.

## Self-Review

- Retrieval, availability, variants, subjects, multi-query, evidence, compatibility, claim, handoff/workflow, token cost, and cleanup all have owners and gates.
- AC65B, WPB100L, A18T, iPhone, Mi Watch, and shop names appear only in regression evidence, never as production branching requirements.
- Every migration phase names old logic to delete; release is blocked if duplicate owners remain.
- `TurnPlan` consumes authoritative ownership/claim views before subjects; subjects precede profile/requests; sources emit canonical cards before pool/selection; `AnswerContext` is the sole LLM input contract.
- Real-schema fixtures are mandatory because synthetic `subtype="cable"` tests missed live `cable_only`/`c-to-c` values.
- Rollout stays reversible until full replay and canary pass.

## Decision

Do not continue the old Phase 7 sequence and do not add a Phase 5G keyword/helper patch. Phase 0, Phase 1 shadow work, and Phase 2A are preserved evidence. After review of the 2026-10-09 revision, implementation starts at **Phase 2B.1 authoritative ownership transport**, then proceeds sequentially through 2B, 2C, and the inserted 2D botworker scope gate before Phase 3. The completed work remains useful infrastructure; this revision changes ownership and migration order without restarting the project.

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

---

## Phase 1G — TurnDecision coverage/readiness re-audit (2026-09-30)

Test/audit/docs only — no runtime change, no wiring. Hypothesis confirmed (review-corrected): coverage gap came from absent stateful fixtures and a single missing harness boundary (`shop_settings_seed`) — not from a TurnDecision input gap; `timeline_seed`/`claim_state_seed`/`ticket_state` already existed.

### Evidence after Phase 1F + 1G fixtures (66 turns / 52 fixtures)

| action | turns | boundary coverage | parity vs legacy | verdict |
|---|---:|---|---|---|
| noise | 2 | boundary (sticker seq) | legacy answers placeholder turns — contract `noise` intended | `needs_more_evidence` — no defined runtime response/no-reply contract |
| locked | 4 | boundary incl. shop-exception, info/product escapes | lock-vs-escape decision matches production gate; downstream action after escape intentionally differs in documented rows | `needs_more_evidence` — only non-escape pin cases |
| handoff | 1 | boundary | match | `needs_more_evidence` — thin + side-effecting |
| claim_request | 3 | boundary | legacy answers where claim never starts (incident) | `blocked_by_phase2` — needs claim-state owner |
| claim_collect | 3 | **boundary via claim_state_seed** (first real coverage) | TurnDecision matches `_claim_collecting` owner, including the resolved+retained-slots behavior. Legacy executor diverges on some rows by handing off or not persisting submitted fields; lifecycle/executor ownership remains a Phase 2 blocker. | `blocked_by_phase2` |
| followup | 12 | boundary via timeline_seed anchor | anchor turns now followup = production-parity | `blocked_by_phase2` — subject/anchor owner pending |
| answer_product | 27 | boundary | mostly parity; diverges on empty-catalog guards | `blocked_by_phase2` — retrieval owner |
| answer_general | 1 | thin | — | `needs_more_evidence` |
| unknown | 13 | — | honest fallback where no context | `not_a_wiring_target` |

### Decision

**Wire nothing yet.** Reasons split by owner: claim/subject actions (`claim_request`, `claim_collect`, `followup`, `answer_product`) → blocked by Phase 2 owners; `noise` → undefined response/no-reply contract; `handoff`/`answer_general`/`locked` → evidence/side-effect gate not yet met; `unknown` → not a wiring target.

Review-fix hardened the evidence itself: `turn_decision_expect` adds exact per-turn action+flags assertions consumed by both the shadow sweep and the contract test (replacing the `_KNOWN_DIVERGENT_IDS` skip-list); validator now enforces its schema, `shop_settings_seed` nested schema, and rejects vacuous `claim_state_exists` on seeded rows; three rows pinned empty-catalog handoff artifacts as positive behavior and are now contract-only (`expectation_note`, acceptance via `turn_decision_expect`).

Final integrity pass: `claim-resolved-retained-slots` is fully contract-only (no legacy `expected` block — asserting retained seed fields was vacuous); validator now rejects `final_claim_state` that is a pure subset of `claim_state_seed`, and `turn_decision_expect[].action` type-checks non-strings instead of crashing; the direct contract test asserts explicit expectations before the generic noise skip (`_fixture_contract_check` ordering proven by mutation test).

### Tests required before wiring

- locked: more escape combinations (date/media/name) through boundary
- claim_collect: full lifecycle fixture (request → collect → resolve)
- noise: defined response path (needs owner decision, Phase 2)
- subject set owner for followup beyond single anchor

### Rollback

Unchanged — shadow flag default off; no enforcement callsite exists.

## Phase 2A — Claim lifecycle owner audit + RED contract baseline (test/audit only)

**Root-cause hypothesis (proven by trace):** claim flow has no single lifecycle owner. `_claim_collecting()` (warranty_flow.py:69) uses retained slots as an active marker even when `stage=resolved`; `update_claim_state` (conversation_products.py:786) merges `stage` without clearing retained slots; stage writes/clears are scattered across ≥10 callsites in two parallel SM impls (`handle_warranty_flow` v2 for chat_v2.py, `handle_warranty_flow_legacy` for app.py); and the whole legacy SM body is history-gated (`if history` at warranty_flow.py:1110) so state transitions silently skip when history is empty.

### Claim-state schema inventory (conversation_products doc field `claim_state`)

| field | shape | writers | readers | merge semantics | lifecycle role | risk |
|---|---|---|---|---|---|---|
| `stage` | str enum: absent / `collecting` / `resolved` / `ts_suggested` | `_update_claim_state` wrapper (~10 callsites across both SM impls); direct `update_claim_state` bypasses ×2 (troubleshoot success → `resolved`, troubleshoot tip sent → `ts_suggested`) | `_claim_collecting` (stage==collecting OR any retained slot — slot-based check, no terminal precedence), ts_suggested check at top of both SM impls, shadow `load_timeline` | merge overwrite (new value wins, None/"" skipped) | **lifecycle marker — but not honored terminally** | resolved+slots still counts as collecting |
| `customer_name` | str | claim-info persistence writes in both SM impls (guarded by `_has_name` NER+space+≤40) | `_merge_claim_slots`, awaiting-confirmation review lines | fill-once | slot | NER miss → silent non-persist (Phase 2A fixture gap) |
| `customer_phone` | str | same sites | `_merge_claim_slots`, review lines | fill-once | slot | — |
| `customer_order_id` | str | same sites | `_merge_claim_slots`, review lines | fill-once | slot | — |
| `purchase_date` | str (YYYY-MM-DD) | `handle_warranty_flow_legacy` State 7 persistence | `_merge_claim_slots`, claim ctx | fill-once | slot | written only on some paths |
| `has_image`/`has_video` | bool | `handle_warranty_flow_legacy` State 7 (`has_image` only) | `_merge_claim_slots` (either counts) | fill-once | slot | `has_video` never written — dead field |
| `started_at`/`updated_at` | iso str | `update_claim_state` auto | none (audit) | auto | audit | — |

### Writer/reader callsite map

| callsite | file:line | writes/reads | transition | side effect | reopens resolved? | owner dup? |
|---|---|---|---|---|---|---|
| `load_claim_state` | conv_products:767 | read | — | — | — | store owner |
| `update_claim_state` | conv_products:786 | merge+upsert | any→any | DB write | **yes — no guard** | — |
| `clear_claim_state` | conv_products:836 | `$unset` | →absent | DB write | — | — |
| `_claim_collecting` | wf:69 | read | — | pure predicate | treats retained slots as active | **shared legacy predicate — not a dup**: `turn_decision.py:261` delegates to it, so incorrect slot-based semantics propagate to both warranty execution and TurnDecision shadow |
| `_maybe_clear_claim_state` | wf:114 | clear | →absent on bot-side clear reason (heuristic — see `_TERMINAL_CLAIM_REASONS` note below) | DB write | — | answer-text guarded |
| clear on closed ticket | `handle_warranty_flow_legacy` closed-ticket branch | clear | →absent | inside `if history` block | — | **semantically wrong + history-gated** — ticket close is ownership, not claim resolution |
| ts success | `handle_warranty_flow_legacy` ts-followup success branch | stage→resolved | ts_suggested→resolved | direct `_cp` call | — | bypasses `_update_claim_state` wrapper |
| ts failed | `handle_warranty_flow_legacy` ts-followup failure branch | stage→collecting | ts_suggested→collecting | +handoff | — | — |
| info submission | `handle_warranty_flow_legacy` State 7 + awaiting-confirmation persistence | stage→collecting + slots | — | +handoff | — | two parallel writes |
| first-message claim | `handle_warranty_flow_legacy` first-message claim block | stage→collecting | absent→collecting | +handoff | — | — |

**Duplicates found:** stage is written by the `_update_claim_state` wrapper AND by two direct `update_claim_state` calls (ts success / ts suggest) bypassing the wrapper; the "start collecting" write exists at 5+ sites; `handle_warranty_flow` (v2) duplicates the entire SM for chat_v2 (SRS §6 documents both).

### Transition truth table (current proven vs desired candidate)

| # | current stage | slots | ticket | turn | current behavior (proven) | desired candidate | evidence |
|---|---|---|---|---|---|---|---|
| 1 | absent | — | — | claim request | ask-info + handoff + stage=collecting | absent→collecting | legacy claim-request / first-message claim blocks; existing fixtures |
| 2 | collecting | — | — | valid name | receipt + persist name? — **NER path drops lone names in some paths** (gap) | persist name | p2a-claim-collect-name-phone (xfail) |
| 3 | collecting | — | — | phone | receipt + persist phone | persist | claim-collect-seeded (green) |
| 4 | collecting | — | — | order_id | persist via _update_claim_state | persist | info-submission persistence write |
| 5 | collecting | — | — | purchase date | persist purchase_date | persist | State 7 persistence write |
| 6 | collecting | — | — | [รูปภาพ] | has_image=True + receipt | persist | State 7 persistence write |
| 7 | collecting | any | — | product question | **fallthrough → product answer; state kept** | same | question-fallthrough branch; p2a-claim-product-question-resume |
| 8 | collecting | any | — | policy question | question fallthrough | same | `_is_question_msg` branch |
| 9 | collecting | any | — | correction (new phone) | merge: fresh wins | same | `_merge_claim_slots` fill-once contract |
| 10 | ts_suggested | — | — | "หายแล้ว" | stage→resolved, thanks, no handoff | terminal | ts-success branch; p2a-claim-ts-success |
| 11 | ts_suggested | — | — | "ไม่หาย" | stage→collecting + ask-info + handoff | ts→collecting | ts-failed branch; p2a-claim-ts-failed |
| 12 | resolved | none | — | phone | not collecting → normal flow | not collecting | claim-resolved-no-slots (green) |
| 13 | resolved | retained | — | phone | **`_claim_collecting` True → resume collect; legacy executor actually hands off (empty-catalog guard)** | terminal wins → not collecting | claim-resolved-retained (contract-only) + xfail param×3 |
| 14 | collecting | any | closed | any (with history) | **clears claim_state — WRONG per business rule**: ticket close = ownership return, not claim resolution | claim survives; bot may answer | p2a-claim-ticket-closed-keeps-state (incident xfail) |
| 14c | collecting | any | closed | product question | answers product but **clears claim first** (history path) | answer + claim kept | p2a-claim-ticket-closed-product-question (incident xfail) |
| 14d | collecting | any | closed | phone | clears claim → re-collects via history-marker path → phone persisted, **retained name lost** | field accepted, all slots kept | p2a-claim-ticket-closed-phone-resume (incident xfail) |
| 15b | resolved | retained | — | explicit new claim request | contract `claim_collect`+`claim_resume` via slot-check — retained slots win over `detect_claim_request`, no handoff | resolved→collecting as a FRESH claim via `claim_request`; old slots are audit, not active collection | p2a-claim-resolved-new-request (incident, strict xfail) |
| 15 | — | — | handoff | claim info | escape gate → collect | same | lock-escape-* fixtures |
| 16 | — | — | handoff | product question | escape → answer | same | lock-escape-product-question |
| 17 | any | any | — | explicit reset | **no reset path exists in code** | owner-decided | — (none found) |

### Minimal lifecycle contract proposal (design only — no code in 2A)

Three independent axes replace the ambiguous "active":

1. **conversation_ownership** (`ticket_state` / `status_conversation`): who may answer — `closed`/`resolved`/`bot` → bot may answer; `handoff`/`open`/`pending` → human owns/locks. Ticket close means the admin returned answering rights to the bot — it says nothing about the claim. **Ticket close is never a claim lifecycle transition and must NOT clear `claim_state`** (current code does, inside a history-gated branch → wrong semantics + history-dependent).
2. **claim_lifecycle** (`claim_state.stage`): whether a claim episode exists and whether it is terminal.
3. **claim_field_acceptance** (`accepts_claim_fields`): whether this turn may add claim fields — depends on claim lifecycle + information type + claim context, never on ticket close.

| stage | lifecycle_open | accepts_claim_fields | terminal |
|---|---:|---:|---:|
| absent | false | false | — (no state) |
| ts_suggested | true | false | false |
| collecting | true | true | false |
| resolved | false | false | true |

- **Persisted slots affect neither claim axis** — they are audit data; only explicit stage drives both. A slot submission while `resolved` must not reopen collection.

**BLOCKER — `BLOCKED_BY_MISSING_CLAIM_RESOLUTION_EVENT`:** audit found no field/event marking a claim resolved/cancelled. Conversation `status` (open/closed/bot/handoff/resolved/pending in `status_conversation`, `conversationService.ts`) is ownership-only; `ticketService` tickets have `status` (open/in_progress/resolved/closed) — also ticket-level, not claim-level. Admin-side claim resolution does not exist in the schema.

The only claim-terminal signals today are bot-side **cleanup heuristics, not authoritative claim-resolution events**:

- `_TERMINAL_CLAIM_REASONS` (`warranty_claim_in_warranty`, `warranty_claim_out_of_warranty`, `claim_info_incomplete`, `review_request`) trigger `_maybe_clear_claim_state` — they are flow/handoff reasons for wiping working state. A warranty-claim handoff, a review request, or an incomplete-info timeout does **not** prove the claim was resolved or cancelled; `claim_info_incomplete` in particular may just be abandoned collection. Phase 2B must **audit/delete/replace** these heuristics after a real lifecycle event is defined — they must not be migrated to the new owner as if they were correct behavior.
- The ts-success branch (`stage=resolved`) marks the **troubleshooting episode** resolved — not proof that an admin claim case was closed.

General terminal transitions (`collecting → terminal`, `any → absent`) are BLOCKED until an explicit claim resolved/cancelled event or field exists — "admin resolved the claim" cannot be implemented without it.

**BLOCKER — `BLOCKED_BY_CLAIM_EPISODE_IDENTITY`:** the flat `claim_state` dict cannot represent an audit-history vs active-episode boundary. The fresh-claim slot policy (evidenced by `p2a-claim-resolved-new-request`): customer-identity allowlist (`customer_name`, `customer_phone`) may be reused into a new episode; case-specific evidence (`customer_order_id`, `purchase_date`, `has_image`, `has_video`) must not carry over. A real "new claim episode" therefore needs an episode boundary (e.g. episode id / prior-episode archive) so retained identity slots are explicit reuse, not silent inheritance — until then, do not claim a fully fresh claim beyond what the flat state can express.

**BLOCKER — multi-intent TurnDecision:** `decide_turn` returns one action; "สินค้าเสียอยากเคลม + อยากดูพาวเวอร์แบงค์" loses the product need. Do not wire production until the contract supports primary action + independent `needs[]`. Phase 2A does not implement TurnPlan; the final owner map evolves `turn_decision.py` — no parallel `turn_policy.py`.
- **Reopen from resolved:** only via explicit new claim request (`detect_claim_request` / `intent=warranty_claim`) → `resolved → collecting` starts a fresh collection; never via bare phone/name/order text.
- **TurnDecision consumes `accepts_claim_fields`** for the `claim_collect` branch (today it delegates to `_claim_collecting`, which conflates both axes).
- **Claim executor consumes both:** `accepts_claim_fields` gates slot persistence/receipt; `lifecycle_open` gates claim-context behaviors (ts follow-up, review request).
- **Mutation owner:** one module owns `lifecycle_open`/`accepts_claim_fields`/transition/clear. Storage owner ≠ lifecycle owner: `conversation_products` stores fields; the lifecycle contract decides transitions (may live beside `update_claim_state`, but as decision logic, not just persistence). `_claim_collecting`/`_merge_claim_slots`/`_maybe_clear_claim_state` collapse into it.
- **Allowed transitions:**
  - `absent → collecting` — explicit claim request
  - `absent → ts_suggested` — troubleshooting advice sent (current implementation)
  - `ts_suggested → resolved` — customer confirms troubleshooting succeeded; this resolves the **troubleshooting episode**, it is not proof an admin claim case was closed
  - `ts_suggested → collecting` — troubleshooting failed and claim collection begins
  - `resolved → collecting` — explicit **new** claim request only (fresh claim); never bare phone/name/order text
  - `collecting → terminal` — **BLOCKED** until an explicit claim resolved/cancelled event exists (`BLOCKED_BY_MISSING_CLAIM_RESOLUTION_EVENT`)
  - `any → absent` — **BLOCKED** until an explicit reset/cancel lifecycle event exists
  - ticket close is **not** a claim lifecycle transition

### Phase 2B — State And Verified Side-Effect Replacement

**Scope:** Legacy Shopee is the only answer executor changed. `chat_v2`/`chatbotv3` are frozen for deletion and botworker remains paused. This phase may change the existing ChatAdmin handoff/status boundary because Python cannot prove assignment or claim outcome by itself. It must not change workflow, retrieval, selection, prompts, or product policy.

**Interfaces owned by this phase:**

```python
@dataclass(frozen=True)
class HandoffResult:
    state: Literal["assigned", "queued", "failed", "not_attempted"]
    assigned_admin_id: str | None
    assigned_admin_name: str | None
    persisted: bool
    reason: str
    error_code: str | None

@dataclass(frozen=True)
class ClaimLifecycleView:
    episode_id: str | None
    stage: Literal["absent", "ts_suggested", "collecting", "resolved", "cancelled"]
    lifecycle_open: bool
    accepts_claim_fields: bool
```

```ts
type HandoffOutcome = {
  state: "assigned" | "queued" | "failed";
  assigned_to: string | null;
  assigned_to_name: string | null;
  persisted: boolean;
  reason: string;
  error_code: string | null;
};

type ClaimOutcome = {
  episode_id: string;
  outcome: "resolved" | "cancelled";
  actor: string;
  occurred_at: Date;
};
```

`queued` means the handoff request was durably persisted for human ownership but no admin id was assigned yet. It is an exceptional backlog state, not the normal business assumption and not customer copy saying "no admin available". Both `assigned` and `queued` stop bot answers; only `assigned` may name an admin. `failed` never sets human ownership and never permits customer copy claiming that the handoff completed.

#### Commit 2B.1A — ownership initialization/backfill gate (inserted 2026-10-09)

**Context (proven by lifecycle audit):** missing `status_conversation` is not safe to read as bot-owned. Fresh bot-owned conversations have no meta doc by design, and legacy human-owned rows can also lack one — live code derives `"handoff"`/`"closed"` from raw `conversations.assigned_to`/`closed_at` (`mapToConversation`, `getAssignedConversationIds`, `send` Phase 7.9 guard). Therefore `missing → "bot"` may only be wired after a one-time initialization pass.

**Files:** `ChatAdminWeb/scripts/backfill-legacy-ownership.ts` + `test-ownership-backfill.ts` (+ hooks/mocks). Offline script only — request path must not invoke it; no runtime service imports at module load.

- [x] Contract tests M1–M12 + V1–V18 + C1–C3 + D1–D3 + E1–E5 + F1–F5 (46/46): authoritative skip, meta-fill, missing-meta create, closed precedence, raw-status exclusion, idempotency, CAS loss, invariant audit, bounded output, import purity, strict input classification, exit matrix, `_id`-seek pagination, sanitized errors, client lifecycle + cleanup-exit contract, canonical IDs, canonical collection binding, empty-source + empty-audit fail closed.
- [x] **Canonical collection binding (E1–E5)** — source default = `conversations_shp` (sellcenter-dump legacy ownership source; `ADMIN_MONGO_COLLECTION_CONVERSATIONS` remains an explicit override); target = `status_conversation`; `message_shp`/`messages_shp` are never opened. **The 2026-10-09 real dry-run (`scanned=0`, all-zero) is invalidated as evidence** — it read the wrong collection (`conversations` fallback: the runner forwarded only `ADMIN_MONGO_URI`/`ADMIN_MONGO_DB`, and a find on a nonexistent collection returns an empty cursor). A corrected real dry-run has not been run yet.
- [x] **Empty-source fail closed** — `scanned===0` (no rows matched the candidate filter) exits 1 in every mode; output carries `empty_source:true`. Contract sharpened (F1–F5): dry-run/apply additionally require **both** `summary.scanned>0` **and** `audit.scanned>0` — a summary that saw rows but a final audit that scanned zero means the audit never reached the source (vacuous audit → exit 1, not clean). `cas_lost` success is permitted only when the final audit has real evidence (`scanned>0`) and is clean.
- [x] **Single classification boundary** (`classifyRow`) consumed by both `runBackfill` and `auditOwnershipInvariant` — no duplicated derivation. Invalid `conversation_id`/ownership fields → `invalid_rows` (blocked, never written, never used to query meta); unknown non-empty `meta.status` → `invalid_authoritative_status` (blocked, never overwritten); invalid `closed_by` → omitted + `invalid_optional_fields` (non-blocking).
- [x] **Canonical IDs only** — `conversation_id` accepted iff `typeof string ∧ length > 0 ∧ v === v.trim()`. Whitespace-padded IDs are invalid rows, never trimmed/normalized, never used to query `status_conversation` — the migration never rewrites identity implicitly.
- [x] **Counts-only output** — `conversation_ids` and all per-row arrays removed; summary carries scalar counters only (scanned/candidates/would_*/created/filled/skipped_authoritative/cas_lost/invalid_*/errors). No raw identifiers, messages, names, phones, or order ids in output.
- [x] **Stable pagination** — `_id`-seek (`sort {_id:1}` + `_id > lastSeen`), replaces skip/offset. `conversations` is read-only; rows inserted behind the cursor are caught by the final audit, rows ahead are processed once.
- [x] **Client lifecycle** — `try/finally` wraps `connect()` onward, so `close()` runs exactly once even when `connect()` throws (C1); a connect-failure dry-run cannot hang on an open socket. Cleanup failures can never report success: `runCli` holds the result in a local `exitCode`, performs no `return` from inside `try`, and a `close()` failure logs a sanitized error and forces final exit 1 (D1–D3); operation and cleanup errors are both reported sanitized, cleanup never masks the operation error.
- [x] **CLI/exit contract** — dry-run default; apply requires the exact token `--apply=BACKFILL_LEGACY_OWNERSHIP` (any other `--apply*` token refuses before connecting); `--batch=N` validated as integer 1–1000 before env/Mongo import; `--audit` runs invariant count only. Exit decision computed once at the CLI boundary (`decideExit`): dry-run always runs the final invariant audit after the scan — `actionable > 0` is allowed, but `invalid`/`errors`/`invalid_authoritative_status` fail dry-run; audit-only runs one audit and succeeds only at all-zero; apply succeeds only when the post-audit is clean on all four counts (`cas_lost` acceptable when the audit is clean). `process.exitCode` is written only by the outer direct-invocation boundary.
- [x] **Sanitized errors** — CLI prints `safeErrorLabel` output only (safe `name` + finite numeric `code`); never `e.message`, stack, URI, host, or DB name.
- [x] **Gate (resolved by census, not by apply):** 2026-10-12 corrected real dry-run (`conversations_shp` source) exited 1 with `empty_source:true` — the fail-closed gate fired correctly. Follow-up read-only census of the real Admin DB (`diag_admin_collections.py`, user-run): `conversations_shp` total=150,396, **raw ownership evidence `assigned_to != null ∨ closed_at` = 0 rows**, `distinct status = ["open"]` only, field census shows no alternative ownership field; `status_conversation` total=2; `tickets`/`chat_accept_sessions`/`platform_team_assignments`/`assignment_cursors` empty; `shop_team_assignments`=7 (shop→admin mapping, not conversation ownership).
- [x] **Invariant conclusion:** `BACKFILL_NOT_APPLICABLE_CENSUS_COMPLETE` — the legacy dump never carries `assigned_to`/`closed_at` (or any prior content was overwritten by dump long ago and is unrecoverable by backfill). There are zero raw human-owned rows to migrate, so **migration apply is forbidden/no-op**. Census proves *existing data* has no violations; it does **not** by itself prove runtime correctness — Phase 2B.1 additionally requires writer/reader contract tests before the transport switch (user direction 2026-10-12).

**Exit:** invariant discharged by real-DB census; writer/reader contract tests + transport implementation proceed under 2B.1.

#### Commit 2B.1 — authoritative ownership transport

**Files:** modify `ChatAdminWeb/src/backend/service/botCallService.ts` and its existing tests/mocks; update SRS/log.

- [x] Prerequisite: Phase 2B.1A invariant verified on real Admin DB (raw human-owned rows lacking authoritative status = 0). Discharged by census (`BACKFILL_NOT_APPLICABLE_CENSUS_COMPLETE`, see 2B.1A).

- [x] RED-test production calls where raw `conversations.status` disagrees with `status_conversation.status`; expected request uses `status_conversation`. (`scripts/test-ownership-transport.ts` — 14/35 RED → 37/37 GREEN)
- [x] RED-test missing meta as explicit `null/unknown`, not a history-derived ownership claim. (missing meta → explicit `"bot"`; Python `None` would trigger history-scan fallback — A1/A11 pin this)
- [x] Change `resolveTicketState()` production read from `COLLECTIONS.conversations` to `COLLECTIONS.statusConversation`; keep test-source stores unchanged.
- [x] Delete the raw-conversation production fallback and stale comments in the same commit.
- [x] Verify handoff/open/closed/pending/resolved transport plus existing bot-call/botworker suites. Do not start the worker.

**Scope extended per user brief 2026-10-12 (all meta-authority readers/writers, not only `resolveTicketState`):**

- Readers switched to `status_conversation`: `resolveTicketState` (missing meta → `"bot"` explicit, meta w/o status → `"bot"`, read error → throw = fail closed, no `conversationId` → no query/no field), `admin/conversations` list+`mapToConversation`+`getAssignedConversationIds`+status filter/auto-reopen, `[conversationId]` GET (status/assigned_to from meta, raw kept display-only), `send` conflict guard (`meta.assigned_to`), `assign` route previous-owner, `team` route workload counts (meta-only; `total` stays thread inventory from `conversations`), `shadow-inbox` + `botworker` conversation maps (`meta?.closed_at` not raw), `workflowEngine` conditions `conversation_status`+`assignee` (prod branch), `assignmentService.autoAssignConversation` early-exit + `reassignConversation` `from_admin_id`.
- Writers: `workflowEngine` `assign_ticket` direct-assign (prod) now CAS-assigns through `statusConversationService.manualAssign` (was raw `conversations.assigned_to` write — dump-overwritable, no authority); `statusConversationService` CAS losers catch E11000 → `false` (unique `conversation_id` index — `manualAssign`/`tryAssign` no longer throw under contention).
- Contract suite: `scripts/test-ownership-transport.ts` 37/37 (A transport ×11, B writer ×15, C reader ×11); suites re-run green: idempotency 71/71, production-races 37/37, recovery-freshness 59/59, boundary 20/20, error-policy 38/38, runtime-mongo-safety 110/110, config-failclosed 4/4, enable-checkpoint 18/18, ownership-backfill 46/46; `tsc --noEmit` clean, `npm run build` clean, `git diff --check` clean.
- Harness additions: fakemongo `aggregate` ($match/$group + accumulators for team route), ObjectId/Date equality, `uniqueKeys` E11000 modeling, eager `onQuery` for aggregate (instrumentation contract).

**Review fix 2026-10-12 (2 High + 1 Medium — all closed, suite 53/53):**

- **F1 (High) — explicit owner-clear semantics:** `updateStatus(conversationId, status, assignedTo?: string | null, actor?)` — `undefined` = keep owner, `null` = clear `assigned_to`+`assigned_at` (audit/history `close_history`/`admin_logs` untouched), `string` = set owner + `assigned_at`. Fixed the two paths that collapsed `null`→`undefined`: `assignmentService.reassignConversation` (`new_admin_id=null` unassign now persists `status=handoff + assigned_to=null`) and list auto-reopen (`closed→bot` now persists `assigned_to=null`, not only in the response map). `conversationService.updateConversationStatus` widened pass-through.
- **F2 (High) — status filter on meta:** `/api/admin/conversations?status=` no longer filters raw `conversations_shp.status` (always `"open"` on real data). Route prefetches conversation_ids from `status_conversation`: `status=bot` → exclude all meta with non-bot status (missing/no-status meta = bot); other statuses → include `{status}` ids; combined with `assigned_to` filter via include-set intersection / exclude-set union **before** raw limit+cursor pagination. `include_count` reuses the same ID constraints.
- **F3 (Medium) — canonical metric partition (mutually exclusive):** active = `{handoff,open,pending}`+assigned; awaiting = `{handoff,pending}`+no owner; closed = `{closed,resolved}` (retained `assigned_to` = history, not workload); bot = missing/no-status/`bot` meta. Applied to `/api/team` (workload agg + realCounts — no more overlapping assigned/closed subtraction), `/api/stats/live`, `/api/stats/dashboard`. Audit additionally found+fixed the last two raw ownership readers: `/api/stats/admin-activity`, `/api/stats/performance`. Remaining raw `conversations` reads = inventory/display/time-bucket only (`unread_count`, `last_message_*`, `created_at`, thread identity) + test-domain collections.
- RED→GREEN: 14 honest RED (F1×3, F2×8, F3×3) → 53/53 GREEN; regression suites all re-run green after fix; `tsc`/build/diff-check clean. Fakemongo extended: `$max/$min/$push/$first/$last` accumulators, `$sort/$limit/$skip/$project` stages.

**Review fix round 2, 2026-10-12 (2 High + 2 Medium — all closed, suite 74/74):**

- **G (High) — response rate as customer-turn population:** `computeResponseStats` now measures *customer turns* (run of consecutive `role=user` msgs; turn ts = last user msg; first qualifying `bot|admin` — or `admin`-only — out msg closes the turn; later replies ignored). Numerator (`within10minTurns`) and denominator (`totalTurns`) are the same event population → rate ≤100 by construction, never clamped. `avgResponseSeconds` = first-response latency only. `perAdmin` attributes turns to first-reply *actor* (historical responder, not current owner). `stats/performance` uses `adminOnly` per UI footnote "คำนวณจากการตอบกลับของแอดมินบนระบบเท่านั้น"; `stats/admin-activity` per-admin rate = admin's within-10min turns / admin's answered turns.
- **H (High) — auto-reopen transition before filter/count/cache:** the `closed→bot` transition (closed meta + `conversations.last_message_timestamp` > `closed_at`) now runs *before* the cache check and all ID prefetches in `/api/admin/conversations`, via bounded `status_conversation {status∈{closed,resolved},closed_at≠null} → $lookup conversations` aggregate (status index → unique `conversation_id` index). Writes invalidate the list cache. No inbound-ingestion owner exists in this codebase (`messages_shp`/`conversations_shp` are written by the external dump; botworker is an optional poller) so the list route remains the transition owner, but it now transitions before every evaluation — `?status=closed` never returns a row that just reopened, `?status=bot` sees it immediately, `total_count` and pagination are consistent, and repeat GETs are write-free (idempotent).
- **J (Medium) — exhaustive partition everywhere:** canonical buckets `active_assigned {h,o,p}+owner | awaiting_assignment {h,o,p}+no-owner | closed {closed,resolved} | bot (missing/no-status/bot-meta)`. `open`+no-owner is **awaiting/human-open** (still locks the bot per transport contract), not bot: `team.unassigned_handoff` filter widened to include `open`; `live.open_unassigned` now counts awaiting only (was `openTotal−openAssigned` = bot+awaiting); `admin-activity` unanswered bucket widened to `{h,o,p}` and closed/resolved/bot count as resolved (closed+retained-owner = activity history, was silently uncounted).
- **J (Medium) — bounded status queries:** stats routes no longer run `statusColl.find({}).toArray()` or ship `$in/$nin` ID arrays. Live/dashboard/performance/admin-activity partition counts run as meta-driven `$lookup` aggregations (`status_conversation` $match → `$lookup conversations` on the unique `conversation_id` index → `$unwind` → conv-side range `$match` → `$group`/`$count`). Unanswered/open-per-shop metrics = in-range total minus meta-closed∩same-conditions (DB-side subtract, exact for disjoint sets). `listConversations` lost the dead `opts.status` param (raw `status` filter can no longer be requested by any caller).
- RED→GREEN: 18 honest RED (G×9 route/unit, H×5, J×4 — G4/G6/G10/J6 pass as coverage pins) → 74/74 GREEN. Fakemongo extended: `$lookup`/`$unwind`/`$count` stages, composite `_id` group keys, pipeline passed to `onQuery` for query-shape pins.

**Closure + deletion gate, 2026-10-13 (suite 82/82, runtime net −202 vs HEAD):**

- **K — response-time boundary contract:** `computeResponseStats` now fetches messages `>= start` (bounded forward by `now`, no full-history scan) and attributes a turn to a period by `turn_ts` (last user msg of the run) ∈ `[start,end)`. A reply after `end` closes an in-range turn; a user msg after `end` extending the run moves the turn to the next period (reply then can't close it here — no double count); `adminOnly` bot replies after `end` don't close admin turns. Daily/performance routes share the same owner — no per-route patches.
- **L — read-only list GET:** lifecycle audit confirmed **no production inbound-lifecycle owner exists in this repo** (`messages_shp` written by external Sellcenter dump; `botWorkerService` polls inbound but writes `test_status_conversation` only — sandbox isolation by design; `botCallService` is a ticket_state reader; `bot-handoff` = handoff-event callback). Per outcome B, the in-GET `closed→bot` write was **removed entirely** — `admin/conversations` GET is now read-only (zero writes, zero status queries on repeat/cache-hit; source-pinned). `closed`+new-inbound stays `closed` in list reads → **`BLOCKED_BY_MISSING_INBOUND_LIFECYCLE_OWNER`** — smallest integration point for a later phase: external dump writer post-write hook, or a dedicated inbound poller that CAS-updates `status_conversation` (status=`bot`, assigned_to=null) on `closed` meta + newer inbound.
- **M — DB-side status/assigned filter:** list route no longer runs meta census → `conversation_id.$in/$nin` arrays. Rows and `total_count` share one conv-driven pipeline: conv `$match` (platform/shop/cursor/search) → `$lookup status_conversation` → `$unwind(preserve)` → meta `$match` (`status=bot` = `meta.status`∉owned-set covering missing/no-status/`bot`; `assigned_to`/`me`/`unassigned` as meta predicates) → `$sort` → `$limit`; no-meta-filter path joins after `$limit` (page-scoped). 3-page cursor parity pinned.
- **Deletion (1,449 LOC tooling + 212 LOC src):** `backfill-legacy-ownership.ts` (379) + `test-ownership-backfill*` (948) + `diag_admin_collections.py` (122) deleted — census `BACKFILL_NOT_APPLICABLE_CENSUS_COMPLETE` discharged the invariant; backfill suite not re-run by design. `conversationService`: `genConversationId`/`createConversation`/`findOrCreateConversation`/`listConversations`/wrappers `setConversationTopic`/`setConversationItemIds`/`togglePinned`/`resetUnread` (0 prod callers; `generate-all-shadow.ts` repointed to direct collection find). `statusConversationService`: `setTopic`/`setItemIds`/`togglePinned`/`resetUnread` (callers were only the dead wrappers; B8 test removed, B7 repointed to `setPendingAssignment`). `getAssignedConversationIds` removed with the route rewrite. Phase-history comment prefixes stripped from all diff-added lines (contract text kept).
- **Gate evidence:** `git diff --numstat ChatAdminWeb/src` = +605/−807 = **net −202 ≤ 0**; backfill LOC 0; new helper/module/flag/index/dependency 0; prod raw-ownership fallback refs 0; list-GET lifecycle writes 0; fakemongo net +109 unchanged (every op load-bearing across 5 sharing routes). Verify: transport 82/82, error-policy 38, idempotency 71, races 37, recovery 59, boundary 20, mongo-safety 110, config 4, enable 18; `tsc`/build(84)/diff-check clean. Verdict: `BLOCKED_BY_MISSING_INBOUND_LIFECYCLE_OWNER`.

**Exit:** one production ownership source; raw conversation dumps cannot override bot silence/resume; one owner for set/clear, status filtering, and metrics.

**Inbound lifecycle implementation, 2026-10-13 (suite 155/155 — receiver in-repo done, external wiring pending):**

- **Contract rounds (3, test-only):** corrected W1–W13 → W1–W17 (init ≠ reopen), then W1–W26 (transport + bounded init + pending), then W1–W47 with executable transport/real-race/deterministic-id tests. External boundary re-audited twice: no in-repo inbound writer or receiver existed; `logDataWriterEvent` present but 0 callers; `ENABLE_*` env flags doc-only.
- **Implemented:** `statusConversationService.applyInboundOwnershipTransition({conversationId,messageId,inboundAt})` → `initialized|reopened|unchanged` — bounded read-dispatch: missing→`insertOne{status:bot,assigned_to:null}` (E11000→bounded re-read once); no-status→init CAS preserving metadata; `closed|resolved`+`closed_at<inboundAt`→fenced CAS `{conversation_id,status:$in[closed,resolved],closed_at:$lt inboundAt}`→bot+clear owner/close/pending residue+`inbound_reopen_event_id`→`recordReopen`; CAS miss→bounded re-read reconcile (settle only `bot`+matching event id); `bot`+match→idempotent settle; other states→unchanged zero-write. `logAdminEvent` +optional `eventId` → deterministic `_id` (`"adminlog:event:"+sha256([action,conversation_id,eventId])[:32]`)+`metadata.message_id`, E11000→identity re-check (match=already-logged, mismatch/non-E11000→throw). `recordReopen` +optional `messageId` remains sole side-effect owner. New route `POST /api/internal/inbound-lifecycle` (x-internal-secret auth + bounded validation + ISO-8601-with-tz + delegate only — zero Mongo) + `middleware.ts` `PUBLIC_API` entry.
- **Guarantee wording:** state transition = single-winner CAS (authoritative); audit/history = idempotent convergence under retry/reconciliation — NOT atomic transaction; `unchanged` may still settle a matching committed event.
- **Evidence:** 111/152 RED → **155/155 GREEN**; regression battery all green (error-policy 38, idempotency 71, races 37, recovery 59, boundary 20, mongo-safety 110, config 4, enable 18); `tsc`/build/diff-check clean. Harness additions (test-only): service spy leaf for `/api/internal/*` importers, fakemongo `insertOneHook`.
- **Remaining blocker:** `BLOCKED_BY_EXTERNAL_WRITER_WIRING` — Sellcenter writer must POST `{conversation_id,message_id,inbound_at}` after durable persist; deploy-topology reachability + shared `CHATBOT_INTERNAL_SECRET` are operator confirmations, not code gaps.
- **External delivery contract (integration spec for the writer owner):** POST after durable inbound persist only; success = HTTP 200 with `{outcome}`; `401`/`422` = permanent integration/config error — never blind-retry (fix the cause); `429` (middleware `API_RATE_LIMIT` 300/min per `ip:path`, enforced before `PUBLIC_API`)/`5xx`/network failure = retryable delivery; every retry MUST reuse the exact same `conversation_id`,`message_id`,`inbound_at` (no identity regeneration) under bounded backoff owned by the writer; receiver idempotency makes at-least-once delivery safe; no claim is made that 300/min is sufficient — headroom is a traffic-evidence decision for operators, not a code change. `inbound_at` accepts ISO-8601 fractional seconds (e.g. Python microseconds) and canonicalizes to Mongo/JavaScript millisecond precision by truncation — sub-millisecond precision is NOT stored; the writer must reuse the same `inbound_at` string on retry (identity is stable regardless).

#### Commit 2B.2 — typed handoff outcome at the assignment owner

**Files:** modify `handoffService.ts`, bot-handoff route, existing handoff/assignment tests; update schema/SRS/log only if stored fields change.

- [ ] RED-test assigned, durable queue, conversation missing, assignment write failure, status write failure, and repeated command outcomes.
- [ ] Make `handoffToAdmin()` return `HandoffOutcome`; the service decides `assigned|queued|failed` only after the corresponding status/pending write completes.
- [ ] Persist `assigned` as `status=handoff + assigned_to`; persist `queued` as `status=pending + assigned_to=null + pending_assignment=true`. A failed command may not leave a transient reopened/bot-owned state.
- [ ] Select/reuse the admin before the final ownership write where possible; test partial-failure boundaries so a thrown write cannot be reported as success.
- [ ] Make the API return the typed outcome. HTTP success means the command was evaluated, not that assignment necessarily succeeded.
- [ ] Preserve round-robin CAS and multiple-chat behavior. Do not add load caps, admin-unavailable copy, keyword rules, or another assignment service.
- [ ] Delete ambiguous `ok:true + assigned_to:null` interpretation from callers/tests in the same commit.

**Exit:** assignment/status persistence is the sole handoff truth owner.

#### Commit 2B.3 — Python handoff command/result boundary

**Files:** modify `responses.py`, `guards.py`, `app.py`, focused handoff tests, SRS/log.

- [ ] RED-test no-product, explicit-human, guard escalation, HTTP error, invalid response, `assigned`, and `queued` paths.
- [ ] Make `_send_handoff()` return `HandoffResult`; network/setup/parse failures map to `failed`, never `{}` interpreted by convention.
- [ ] Derive compatibility fields `handoff_to_admin` and `handoff_reason` from `assigned|queued` only.
- [ ] Replace the no-product flag-only return with command execution and outcome-based customer copy.
- [ ] Remove `guards.enforce()`'s assumption that a pre-set flag proves success; do not add a second retry or fallback handoff call.
- [ ] Delete replaced bool-only branches and assertions in the same commit.

**Exit:** response text, response metadata, and persisted ownership agree; one turn makes at most one handoff command.

#### Commit 2B.4 — claim episode/lifecycle owner ✅ (working tree verified — pending review/commit)

**Files:** modified `warranty_flow.py`, `conversation_products.py`, `turn_decision.py`, `order_flow.py`, Phase 2A tests/fixtures, SRS/log.

- [x] RED-test terminal precedence, explicit fresh request after resolved, customer identity reuse, case-evidence reset, and bare contact data after terminal. → `test_phase2_claim_state_contract.py` (30 tests incl. race/idempotency: duplicate retry, concurrent fresh CAS, stale-writer fence, CAS-loser reread)
- [x] Add `episode_id` at `absent|resolved|cancelled -> collecting`; retain `customer_name/customer_phone` only through an explicit allowlist (`_CLAIM_IDENTITY_FIELDS`) and clear prior case evidence.
- [x] Make one lifecycle evaluator produce `ClaimLifecycleView` (`_claim_lifecycle`). Replaced and deleted `_claim_collecting` slot-based activation — including `order_flow`/`turn_decision` consumers.
- [x] Route stage changes through one transition owner (`_claim_transition`); storage helpers `transition_claim_state`/`merge_claim_fields` are persistence-only fenced CAS primitives (no policy, no LWW, bounded reread on miss).
- [x] Un-xfail `p2a-claim-resolved-new-request` — executor and TurnDecision consumer use the same lifecycle view (flipped to `positive`, green).
- [x] Correction A applied: `_maybe_clear_claim_state`, `_TERMINAL_CLAIM_REASONS`, handoff-reason resolution, closed-ticket clears — all deleted as lifecycle authority; terminal evidence = ts-success confirm + persisted terminal stage only (admin events = 2B.6).
- [x] Correction B applied: terminal transition preserves episode + collected evidence as audit record (`resolved_at`/`resolution_reason`); fresh episode reuses identity allowlist only.
- [x] Correction C applied: fenced CAS (`expected_episode_id`, `$exists` for absent), single bounded reread on CAS miss, no unconditional replace.
- [x] Correction D applied: history-marker lifecycle branches deleted (no second owner); `accepts_claim_fields` = `collecting` only.
- [x] Correction E applied: `ClaimLifecycleView` single name, no parallel class.

**Exit:** retained slots are audit data, not activation; a new incident has a distinct episode id. **Harness fix recorded:** `_install` now pins `ADMIN_MONGO_DB`/`MONGO_DB` per test — sibling module importing `shopeechat.app` first let `.env` (`ADMIN_MONGO_DB=chatbot`) shadow the seeded db and silently drop `claim_state`/anchor in the shadow sweep (pre-existing isolation gap, exposed when the history-marker fallback was deleted).

**Review-fix round (CAS/uniqueness hardening — verified, pending commit):**
- [x] H1: fence = `expected_episode_id + expected_stage` on every write; stale same-episode merge after terminal cannot reopen (R1); terminal transition = partial `$set` via `merge_claim_fields` — concurrent evidence preserved (R2); whole-state write only for new-episode create.
- [x] H2: unique `{conversation_id:1}` declared at `COLLECTIONS.conversationProducts` + `safeCreateIndex` in `mongoClient.ts` (existing owner); create path uses `insert_one` (not upsert — upsert would match the rival's doc and overwrite it); E11000 → single reread. **Deploy gate `BLOCKED_BY_CONVERSATION_PRODUCTS_UNIQUENESS_AUDIT` stays** — real-DB duplicate census + index proof still required; not production-safe until then.
- [x] M1: contract `_FakeColl` extended with `docs` list, `interleave` hook queue, unique-insert E11000 — races interleave deterministically (R1–R4), no threads.
- [x] M2: `test_issue_5f_claim_flow` wraps shopeechat imports in a try/finally dotenv stub; subprocess import-purity test asserts zero `load_dotenv` calls regardless of collection order.
- [x] `_claim_episode_fence` deleted — filters inlined in the two primitives; storage helper count unchanged.

#### Commit 2B.5 — ticket close semantics and field persistence ✅ (working tree verified — pending review/commit)

**Files:** modified `warranty_flow.py`, `warranty.py`, `turn_decision.py`, `app.py`, `chat_v2.py` + Phase 2A fixtures/tests; updated SRS/log.

- [x] Delete the closed-ticket `clear_claim_state` branch; close changes ownership only. *(done in 2B.4 as one-owner prerequisite — closed early)*
- [x] Un-xfail `p2a-claim-ticket-closed-keeps-state`, `-product-question`, and `-phone-resume`. *(all green — `-keeps-state` flipped to positive; BUG-D catch-all that re-escalated closed-ticket greetings is deleted)*
- [x] Fix lone-name persistence at the existing parser/persistence owner and delete duplicate branch-local validation. *(`extract_customer_info` is sole name-validity owner: final gate 2–40 chars, no digit, space not required; `_merge_claim_slots` is precedence-only; 12 duplicate `len≤40+" "+digit` sites deleted; history scan keeps only contextual denylist)*
- [x] Un-xfail `p2a-claim-collect-name-phone` only after name and phone persist through the same episode. *(green — same episode, fenced merge)*
- [x] Unconditional active-ticket lock: `handoff/open/pending` → wait-admin for every message class — no claim-info/product/shop-exception escapes, no claim writes, no re-POST. `closed/resolved/bot` → normal pipeline; episode unchanged.
- [x] **Boundary correction (review H1/H2/M3):** lock owner = exactly one site at `_chat_impl` entry — runs before v3/v2 dispatch, `_db()`, vision, persona, TurnDecision shadow, deterministic responders, intent/retrieval/LLM. `_build_post_handoff_response` is wait-only: `handoff_to_admin=False`, `handoff_reason=None`, routing path `"human_wait"` (flag/reason/path="handoff" are new-handoff *commands* for downstream callers — never emitted by the waiting state). Duplicate runtime gates removed from `chat_v2._check_deterministic`, `handle_warranty_flow`, `handle_warranty_flow_legacy`, and the inner `_chat_impl` gate; `turn_decision` keeps pure `locked` classification only.
- [x] Legacy confirm-correction persists via `_claim_transition` (v2 parity — previously rebuilt ctx only).
- [x] Structural audit: BUG-D branch=0, `claim_info_incomplete` producer=0, `_QUESTION_MARKERS`/`_is_question_msg`=0, escape helpers (`_post_handoff_escape`/`_post_handoff_gate`/`_get_post_handoff_exceptions`/`post_handoff_exceptions`/`_is_post_handoff_exception`/`_is_post_handoff_product_q`)=0, duplicate name validators outside parser=0 (contextual history denylist preserved), `_claim_lifecycle`=1, `_claim_transition`=1, storage writers=2, new helpers=0, runtime −201 LOC net.
- [x] Latent `NameError` fixed: legacy `_is_post_handoff_product_q` (v2-only scope) → inline `_is_product_q` from module kw constants.

**Verification (fresh, post-boundary-correction):** replay+5f+contract+turn_decision+shadow `265 passed, 19 skipped, 8 xfailed`; sibling suites `79 passed`; handoff transport standalone `38/38`; `npx tsc --noEmit` clean; `npm run build` green; py_compile 5 touched files; `git diff --check` clean. `test_anger_detection_regression` 11 failures identical to baseline `72c325e` (offline `_send_handoff` POST — pre-existing env limitation, not this diff).

**Exit:** closing and reopening a conversation cannot erase or resolve a claim episode; active ticket is an unconditional ownership lock; lone names accepted by the parser persist; corrections persist through the transition owner.

#### Commit 2B.6 — explicit admin claim outcome

**Files:** create `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/claim-outcome/route.ts`; modify `statusConversationService.ts`, `bot-handoff/route.ts`, `botCallService.ts`, the admin conversation response/type, and `components/chat/InfoTab.tsx`; consume the event in the legacy claim owner; update schema/SRS/log and focused API/UI/contract tests. Do not repurpose the existing conversation `close` or `resolve` routes.

- [x] RED-test ordinary close with an active claim: ownership returns to bot and claim remains collecting. — CO15 pin green (close ไม่แตะ claim fields); Python side ไม่มี ordinary-close terminal path
- [x] RED-test explicit `resolved` and `cancelled` for the current `episode_id`, stale episode id, repeated event, and non-claim conversation. — contract suite section G + CO3–CO8 (applied/already_applied/stale_episode/no_active_claim/invalid + race)
- [x] Move production `bot_claim_info` ownership from raw `conversations` into `status_conversation`, including `active_claim_episode_id`; test/sandbox stores remain isolated as today. — `recordClaimHandoff` (status service owner); raw-`conversations` writer deleted; test/simulate branches เขียน test stores เหมือนเดิม
- [x] Persist `ClaimOutcome` in `status_conversation` separately from conversation `status`; require actor, timestamp, outcome, and matching episode id. — `claim_outcome{episode_id,outcome,actor_id,occurred_at}` ผ่าน `applyClaimOutcome` fenced CAS เท่านั้น
- [x] Add a dedicated claim section in `InfoTab` only when `active_claim_episode_id` exists, with explicit `resolved` and `cancelled` commands plus confirmation. Ordinary close remains a separate action and never sends a claim outcome. — `ClaimSection` + `confirm.ask` (ConfirmDialog เดิม); แยกจาก close chat
- [x] Extend the existing `/chat` state payload with the episode-scoped outcome. The wire form uses an ISO timestamp; storage keeps a Mongo `Date`. — `ChatRequest.claim_outcome` top-level; `botCallService` serialize `occurred_at` ISO (prod only)
- [x] Apply the event idempotently to the Python claim lifecycle on the next authoritative turn. A stale/mismatched episode cannot terminate the active claim, and repeated delivery is a no-op. — `_consume_claim_outcome` ที่ SM heads ทั้งสอง ผ่าน `_claim_transition` เดิม (fencing เดิม); stale/mismatch/terminal/malformed → no-op
- [x] Delete `_TERMINAL_CLAIM_REASONS` as lifecycle resolution evidence; keep any still-needed reason only as audit/routing metadata. — absent ตั้งแต่ 2B.4 (verified — ไม่ถูกสร้างกลับ)
- [x] Do not infer resolution from close reason, free-text resolution, bot answer, handoff reason, or ticket status. — outcome มาจาก `req.claim_outcome` explicit transport เท่านั้น; `_consume_claim_outcome` ไม่มี text/reason scan

**Exit:** `BLOCKED_BY_MISSING_CLAIM_RESOLUTION_EVENT` and `BLOCKED_BY_CLAIM_EPISODE_IDENTITY` are closed by explicit, episode-scoped evidence. — **implemented 2026-10-14 (ยังไม่ commit — รอ review ตาม stop gate)**

**2B.6 Review-Fix (independent review: 2 High + 2 Medium — implemented 2026-10-14, unstaged)**

- [x] **H1 episode resurrection / terminal overwrite** — `recordClaimHandoff` เดิม `upsertMeta` unconditional `$set` → fenced atomic write `{conversation_id, claim_outcome.episode_id:{$ne:ep}, $or:[{active==ep},{active==null}]}` + `$set{active:ep, claim_outcome:null, …}` (E11000→bounded CAS re-fence ครั้งเดียว); `applyClaimOutcome` เพิ่ม `claim_outcome.episode_id:{$ne:ep}` ใน CAS → same-episode outcome immutable (first terminal wins แม้ malformed `{active:E,outcome:E}`) — RED R1–R6 → GREEN
- [x] **H2 false success on metadata failure** — route เดิม catch `recordClaimHandoff` throw แล้วต่อ → 503 `ok:false` retryable (ownership ที่ commit แล้วคงอยู่; retry identity เดิม converge ผ่าน `handoff_event_id` dedupe + metadata once); `_send_handoff` ลบ hidden `load_claim_state`/Mongo read → explicit `episode_id` param; `_build_warranty_claim_response` รับ `claim_state` จาก caller — claim caller เดียวส่ง episode — RED R7–R9 + U1–U5 + R8a–d → GREEN
- [x] **M1 UI state leak** — `ClaimSection` key `\`${conversation.id}|${conversation.active_claim_episode_id ?? "-"}\`` — remount/reset busy/applied/errorMsg เมื่อ conversation หรือ episode เปลี่ยน — R10–R11 source pins
- [x] **M2 production claim shape** — canonical `customer_order_id` ตั้งแต่ Python ctx → route body type → `Conversation.bot_claim_info` → InfoTab; `order_id` contract ลบ (ไม่มี legacy producer) — R12
- [x] **F3-3 flake (test-only, ระหว่าง verify)** — seed `new Date()` เท่า route `end` ใน ms เดียวกัน → `$lt` exclusive หลุด (binary 0/5); fix seed `now-1000ms` clamp ≥ local-midnight+1 — 5 consecutive runs 231/231

**Owner counts หลัง review-fix:** lifecycle evaluator=1 (`_claim_lifecycle`) · Python transition owner=1 (`_claim_transition`) · transport owner=1 (`_send_handoff`, explicit `episode_id`, no store read) · claim metadata writer=1 (`recordClaimHandoff`) · outcome writer=1 (`applyClaimOutcome`) · `_TERMINAL_CLAIM_REASONS`=0 · raw `conversations` claim writer=0 · `order_id` UI contract=0

**2B.6 Review-Fix round 2 (final correctness: 2 High + 1 Medium — implemented 2026-10-14, unstaged)**

- [x] **F1 stale handoff silent 2xx** — `recordClaimHandoff` เดิม `Promise<void>`: fenced no-op เงียบ → route คืน 2xx → Python confirm stale episode → เปลี่ยนเป็น typed result `{status: written|already_terminal|stale_episode, claimOutcome?}` — no-op/E11000 → bounded reread ครั้งเดียว classify (outcome.ep==E→already_terminal+persisted outcome · active=E'≠E→stale_episode · อื่น→throw); route: written→success เดิม · already_terminal→200 converged `claim_metadata:"already_terminal"`+`claim_outcome` · **stale_episode→409 `ok:false`** (Python ไม่ retry/ไม่ confirm) · throw→503 — RED R13 → GREEN
- [x] **F2 audit crash window** — `applyClaimOutcome` เดิม commit CAS ก่อน `logAdminEvent`: audit throw→500; retry เจอ already_applied return ก่อน repair → audit หายถาวร → already_applied path เรียก `logAdminEvent(eventId=episodeId)` ด้วย **persisted actor/outcome** ก่อน return (ไม่ใช่ request's conflicting values; dedupe=E11000 ใน logAdminEvent เท่านั้น — repair ≤1 ครั้ง) — RED R15 → GREEN
- [x] **F3 authoritative outcome on wire/UI** — route เดิมคืนแค่ `{ok,result:"already_applied"}`; InfoTab `setApplied(o)` ใช้ค่าที่กด → conflicting retry (admin-B cancelled เทียบ admin-A resolved persisted) แสดงผิด → `applyClaimOutcome` คืน `{result, claimOutcome}`; route ส่ง `claim_outcome` persisted ทั้ง applied/already_applied; InfoTab อ่าน `body.claim_outcome.outcome` — absent → error ไม่ synthesize — RED R16 → GREEN

**Result:** `recordClaimHandoff` = typed verdict owner เดียว · `applyClaimOutcome` = `{result,claimOutcome}` owner เดียว · audit dedupe = `logAdminEvent` E11000 เดียว · route ทั้งสอง zero Mongo · stale→409 (ไม่ใช่ 2xx) ตลอด chain

**2B.6 Review-Fix round 3 — Final Handoff Ordering (High — implemented 2026-10-14, unstaged)**

- [x] **Ordering root cause** — route เดิมเรียก `handoffToAdmin` (ownership CAS+reopen+audits commit) ก่อน `recordClaimHandoff` classify → stale/terminal verdict มาหลัง side effects → reorder: request มี `episode_id` → `recordClaimHandoff` เป็น gate ก่อน `handoffToAdmin` — written→handoff · stale_episode→409 (handoff calls=0) · already_terminal→200 converged+persisted outcome (handoff calls=0, `outcome:null` — ไม่ synthesize; Python confirm เฉพาะ outcome.state∈{assigned,queued}) · throw→503 (handoff calls=0) · written+handoff-fail→เก็บ metadata ไม่ rollback, retry converge · no `episode_id`→non-claim flow เดิม — RED R17–R20 → GREEN 239/239 · R7 assertions อัปเดตตาม ordering contract ใหม่ (metadata fail → no ownership commit)

**2B.6 Review-Fix round 4 — Atomic Episode Fence on Ownership CAS (High — implemented 2026-10-14, unstaged)**

- [x] **TOCTOU gate↔ownership CAS root cause** — round-3 ปิด sequential bypass แล้วแต่ `commitHandoffState` CAS ยังไม่มี episode fence → terminalize E หรือ E2-active แทรกระหว่าง `recordClaimHandoff(E)→written` กับ ownership CAS ได้ → แก้ที่ CAS owner เดียว: `expectedClaimEpisodeId` ไหล `route → handoffToAdmin → commitHandoffState` บังคับ `{active_claim_episode_id: E, claim_outcome.episode_id: {$ne: E}}` ใน atomic `findOneAndUpdate` เดียวกับ `status/assigned_to/pending_assignment/reopen/handoff_event_id`; CAS miss (และ initial `getMeta`) classify `claim_verdict: already_terminal|stale_episode` ก่อน generic converge โดยไม่ emit audit — route คืน converged 200 (+persisted `claim_outcome`, `outcome:null`) หรือ 409 `ok:false`; non-claim (`expectedClaimEpisodeId` absent) byte-equivalent; `commitHandoffState` ใช้ `upsert: !opts.expectedClaimEpisodeId` (`committed: Boolean(doc)`) และ `handoffToAdmin` เช็ค `if (E)` แม้ `meta == null` เพื่อห้าม upsert สร้าง episode เองเมื่อไม่มี meta doc — RED R21–R22 (interleave via `findOneAndUpdateHook`) + R23–R24 pins + R25 (missing-meta no-upsert) → GREEN 244/244

#### Commit 2B.7 — residual deletion and gate

- [x] Inventory direct claim-stage writers, handoff bool writers, raw production ticket-state readers, and lifecycle predicates.
- [x] Delete dead direct writes/helpers/fields, including `has_video` only if no live writer/consumer remains. — **`has_video` deleted**: git history proves zero truthy writers ever (production only ever wrote `None`; video evidence always folded into `has_image` via `วิดีโอ|video` placeholder). Sole reader was `_merge_claim_slots` `or cs.get("has_video")` — removed; docstring/schema/test-seed cleaned in same change. Marker fallback in `_is_active_post_handoff` retained (reachable when callers omit `ticket_state`: simulate/botworker/replay paths) — executable contract pins it.
- [x] Run Phase 2A contract, legacy replay/isolation, handoff/API, typecheck/build, and diff checks.
- [x] Report owner count, direct writer count, runtime LOC delta, un-xfails, and residual blockers. No cleanup item may be deferred here from an earlier commit merely to make that commit additive.

**2B.7 actual (unstaged — รอ independent review):**

| metric | before | after |
|---|---|---|
| claim lifecycle transition owner | 1 (`_claim_transition`) | 1 |
| claim storage primitives | 2 (`transition_claim_state`/`merge_claim_fields`) | 2 |
| lifecycle evaluator | 1 (`_claim_lifecycle`) | 1 |
| Python handoff transport writer | 1 (`_send_handoff`) | 1 |
| TS ownership writers | `statusConversationService` only (commitHandoffState/updateStatus/recordClaimHandoff/applyClaimOutcome/applyInboundOwnershipTransition) | same |
| raw production ticket-state readers | 0 (prod = `status_conversation` เท่านั้น) | 0 |
| marker/keyword fallbacks | 2 live legs (`_is_active_post_handoff` marker leg; `order_flow` claim-prompt leg) | 2 (kept — both cover callers/data without structured state) |
| dead claim fields | `has_video` reader 1 | 0 |
| new helpers/guards/shims/flags/modules | — | **0** |
| runtime LOC net (refactor-only) | — | **0** (in-place edits; no line added/removed) |

**Verification (2B.7)**: ownership transport **244/244** · Python handoff transport **47/47** · claim contract **52+1s** · canonical batch **312 pass/19 skip/8 xfail** · replay isolation **1 pass** · fixture validator **all rows** · `py_compile` 3 files OK · `tsc --noEmit` clean · `npm run build` pass · `git diff --check` clean · anger suite not rerun (baseline 11 fail = pre-existing `72c325e` signature, unchanged — reported separately, not green).

**2B.7 correction round (post independent review — unstaged, รอ final read-only review):**

Independent review: no Critical/High; `has_video` deletion ถูกต้องและ video input ทำงาน — แต่ gate ไม่ครบ: เหลือ dead writable config + dead function surface + stale enum docs + ไม่มี executable pin ของ video evidence. Corrections (source-verified before accept):

- **Dead config `post_handoff_exceptions` deleted**: zero runtime readers repo-wide (Python reader ถูกลบตั้งแต่ 2B.5; TS reads nothing) — removed write surface: `route.ts` body field + passthrough, `shopSettingsService.ts` doc field / `DEFAULT_SHOP_SETTINGS` / upsert opts / `$set` path / insert default (UI controls = 0 already). `shop_settings` docs ที่มี field เก่า = inert historical data — runtime ignores (lock unconditional); no migration/cleanup. Fixture `lock-shop-exception-escape` + validator `_ss_keys` + meta-tests retained: seed simulates a legacy doc still carrying the field — the executor wires it into fake admindb so the row pins "active ticket stays locked even when a DB doc has the field".
- **Dead `_merge_claim_slots` surface deleted**: params `has_date`/`has_image` + output keys `date`/`image` — zero consumers of those keys (callers read only name/phone/order_id; evidence persists via `_claim_transition` independently). Signature now `(info, *, claim_state)` → `{name, phone, order_id}`; both production call sites (v2 + legacy) updated.
- **Enum/doc corrections**: `ChatRequest.ticket_state` Field description + SRS enum lists now state the full set `handoff|open|pending|closed|resolved|bot` (active = handoff/open/pending → unconditional lock; closed/resolved/bot → normal; None/other → marker fallback); `schema.md` `status_conversation.status` rows add missing `pending` (canonical `ConversationStatus` = 6 values); `load_claim_state` docstring now names the real persisted key set (lifecycle + slots + evidence) pointing at canonical schema.
- **Video evidence executable pin added**: `test_p2b7_video_placeholder_persists_has_image` — `[วิดีโอ]` turn on a seeded collecting episode through real `app.chat` → legacy SM → `_claim_transition` → fake Mongo: `has_image is True`, same `episode_id`, `stage` collecting, and `"has_video" not in claim` (absence — airtight, not None-equality). Mutation evidence: removing `วิดีโอ|video` from the placeholder recognition makes the pin FAIL; reverted → PASS.
- **Shop-settings behavior test added** (`scripts/test-shop-settings.ts`, same hooks+fakemongo harness — no parallel harness): passing `post_handoff_exceptions` on create/update is never persisted; legacy doc field stays inert (service never rewrites it); `faq_liveagent_*` still persists.

| correction metric | before | after |
|---|---|---|
| `post_handoff_exceptions` runtime readers | 0 | 0 |
| `post_handoff_exceptions` writers (API+service surface) | 6 sites | **0** |
| `post_handoff_exceptions` UI controls | 0 | 0 |
| `_merge_claim_slots` params | 4 (`info, has_date, has_image, claim_state`) | **2** (`info, claim_state`) |
| `_merge_claim_slots` output keys | 5 | **3** (`name, phone, order_id`) |
| `_merge_claim_slots` kwarg call sites | 2 (v2+legacy passing dead args) | **0** |
| new helpers/guards/shims/flags/modules | — | **0** |
| runtime LOC delta | — | **−18 net** (code −20: route.ts −2, shopSettingsService −9, warranty_flow −9; +2 docstring in conversation_products; app.py ±0) |

**Verification (correction — fresh)**: TS ownership transport **244/244** · shop-settings contract **3/3** · Python handoff transport **47/47** · claim contract **52+1s** · canonical batch **313 pass/19 skip/8 xfail** (baseline 312 + new video pin; skips/xfails identical) · replay isolation+warranty_delivery **12/12** · fixture validator **all rows** · `py_compile` 3 files OK · `tsc --noEmit` clean · `npm run build` pass (84/84) · `git diff --check` clean · anger suite **11 fail = baseline-identical `72c325e` signature** (offline `_send_handoff` POST — pre-existing, reported separately, not green).

### Phase 2C — Multi-Need TurnPlan And Authoritative Subjects

**Scope:** Phase 2C starts only after 2B passes. It changes turn understanding and subject continuity, not retrieval ranking or answer prompting. Extend existing `turn_decision.py` and `conversation_products.py`; do not create parallel policy/subject modules.

**Interfaces owned by this phase:**

```python
@dataclass(frozen=True)
class TurnNeed:
    kind: Literal["product", "compare", "compat", "policy", "order", "troubleshoot", "claim", "human"]
    operation: Literal["describe", "compare", "recommend", "price", "link", "stock", "compat", "policy", "lookup", "collect", "handoff"]
    subject_refs: tuple[str, ...]
    confidence: float
    provenance: tuple[str, ...]

@dataclass(frozen=True)
class TurnPlan:
    primary_action: Literal["no_reply", "human_wait", "execute_needs", "handoff", "clarify"]
    needs: tuple[TurnNeed, ...]
    ownership: Literal["bot", "human", "unknown"]
    claim: ClaimLifecycleView
    requires_clarification: bool

@dataclass(frozen=True)
class ConversationSubjectSet:
    subject_ids: tuple[str, ...]
    source_turn_id: str | None
    relation: Literal["single", "compare", "alternatives", "bundle"]
    requested_operations: tuple[str, ...]
    confidence: float
```

#### Commit 2C.1 — evolve TurnDecision in place

- [x] RED-test mixed claim+product, product+policy, comparison+compatibility, explicit human request plus information need, and noise/media-only turns (initial type-availability RED + controlled single-need mutation RED across 9 mixed-need/fixture tests + subject-identity RED).
- [x] Replace the one-action result with `TurnPlan.needs[]` in `turn_decision.py`; no new semantic keyword table and no `turn_policy.py` (reuses `route_context._REL_CONN_RE` for compat connector; `subject_refs` restricted to stable explicit identities: `_ITEM_TAG_RE` item IDs, `route.model_codes`, and `order_sn` for order lookup; dead `_ticket_active` deleted; `_resolve_ownership` replaces `_ticket_active` [module-level helper net 0], plus 1 local nested aggregator `_add_need`).
- [x] Keep shadow comparison until every consumer understands `needs[]`; delete the superseded one-action assertions/adapter in the same commit.

#### Commit 2C.2 — persisted subject set ✅ (working tree verified — pending review/commit)

- [x] RED-test explicit model identity, compare pairs, recommendation batches, topic switch, ambiguous "ตัวนี้", unavailable subject, and no-history turns with persisted subjects — **58 missing-contract RED → 63 GREEN** (`test_conversation_subject_set.py`: P1 identity normalize/round-trip/collision · P2 absent-minimal/field-preservation/dup-create/exception · P3 stale-CAS/winner-reread · decide precedence incl. mutations · resolve matrix · e2e replay).
- [x] Persist subject ids/relations/operations from explicit evidence and selected results; never persist a conclusion parsed from bot prose — `ConversationSubjectSet` + `get_subject_set`/`resolve_subjects`/`decide_subject_set`/`record_subject_set`/`materialize_subject_cards` in `conversation_products.py`; `subject_ids` = canonical item_id strings only; bot-prose subject selectors deleted (FOLLOWUP-COMP prose fallback, `_is_ref_like` markdown/brand-model parse, CARRY-FORWARD fuzzy) + `resolve_active_by_message` removed; decision choke = `_record_suggestion_products` (+ item-tag mutually-exclusive callsite); ≤1 read + ≤1 write per turn; CAS fence = full semantic snapshot `subject_set.{ids,relation,ops,confidence,source_turn_id}` (no retry, winner reread); absent-doc minimal insert under existing `{conversation_id:1}` unique.
- [x] Migrate compare/price/link/compat follow-ups to the subject set and delete the corresponding app-local history/keyword owner blocks — resolved set pins `_ref_regex_products`; FOLLOWUP-COMP composes from resolved pair; link follow-up serves the resolved set with `alt_fetcher=None` (no silent swap); explicit compare fetches every stated model kw (MODEL-REGEX multi-kw merge via `extract_model_keywords` — digit-tail fix AC65B2); `test_retrieval_profile` pin retargeted `resolve_active_by_message(` → `resolve_subjects(`.
- [x] Ambiguity produces clarification; it must not silently select the newest or sellable tail product — `resolve_subjects` → clarify → deterministic `subject_clarify` ChatResponse, zero writes; incidents tx-q08/tx-q09/tx-q18 verified fixed → status flipped `incident→positive`; anchor-derived bootstrap (`is_anchor` entries → single/alternatives, conf 0.5) preserves legacy link follow-up.
- Verification: focused 183 passed · canonical batch 401 passed/19 skipped/5 xfailed · claim contract 52+1s · td 107 · td-shadow 17 · anchor/compare/link/availability/cert/units suites green · script suites (handoff 47/47, guards, route_context, charger parity 42/42, unit card/classifier) pass · `py_compile`/`git diff --check` clean — pre-existing live-data failures unchanged (`test_retrieval_profile_db` device check, `test_sellable_units` count vs live DB).

> **Correction (2026-10-15, final safety + ABA round — supersedes two statements above without rewriting them):**
>
> - **CAS fence is now `subject_set.rev`** (persisted monotonic int, +1 per committed write, compare=False on the dataclass). The earlier "full semantic snapshot" fence closed same-ids semantic races but was **not ABA-safe** — a sequence A→B→A′ (semantically identical to A, `source_turn_id=None`) let a stale writer's expected snapshot match again and overwrite the newer decision. Now: `prior.rev>0 → {subject_set.rev:r}`; `prior.rev=0 → {subject_set.rev:null}` (pre-token doc compat — missing∨null, writes never persist 0); `prior=None → {subject_set:null}` (absent∨null only). Miss → one bounded reread → winner; absent doc → minimal insert with `rev=1`; E11000 → one winner reread.
> - **Keyword gate correction:** `_SUBJECT_WHICH_KWS` and `_SET_COUNT_REF_RE` were new semantic tables (not moved canonical). They had no canonical TurnPlan/route-context owner and have been **removed**, not kept-under-provenance: `_SUBJECT_PAIR_KWS`/`_SUBJECT_LINK_KWS` remain as the single-owner moved tables; `set_soft` now reaches only via canonical `_SUPERLATIVE_KW`; `set_hard` only via `_SUBJECT_LINK_KWS`. Deferred behavior: bare which-of-set ("อันไหนดี") → `no_subject_ref`; set-count deixis ("อันไหน 2 อันนี้", "ทั้งสอง") on multi sets → falls to canonical singular "อันนี้" → clarify. **q07 t3 (`tx-q07-pair-continuity`) marked `pending_live_replay`+`pending_reason` — requires a TurnPlan subject-arity/set-ref signal (2C.3).** Verdict this round: `PHASE_2C2_BLOCKED_BY_TURNPLAN_SIGNAL_SET_COUNT_DEIXIS` — new semantic keyword tables = 0 achieved, at the cost of the deferred case.
> - **Test-purity correction:** the earlier batches that listed anchor/timeline/retrieval-profile files alongside offline suites ran with `.env` loaded by `test_conversation_subject_set.py` — those files (`test_anchor_compare`, `test_timeline_card_refresh`, `test_retrieval_profile`, `test_retrieval_profile_db`, `test_sellable_units`, `test_unit_live_compare`, `test_compare_3way`, `test_grouped_retrieval_executor`, `test_compat_mode_filter`, plus `test_cert_standards`/`test_general_qtype_guards`/`test_new_product_types`/`test_qa_context_guard` which `load_dotenv` at import) are **live-DB/env-loading and were never honestly "offline"** — they are now classified `NOT_RUN_REAL_DB_REQUIRES_SEPARATE_APPROVAL`. The subject suite no longer loads `.env`; it restores the `os.environ` delta written by the replay harness's import and carries executable purity probes (zero `load_dotenv`/MongoClient/socket calls, env-identical, bidirectional collection-order independence).
> - Fresh offline verification this round: subject suite **79** · replay **100/20s/5x** (q07 skip = the deferral) · full offline batch (canonical + wide, 33 files) **612 passed, 20 skipped, 5 xfailed** · handoff transport **47/47** · fixture validator all rows · `py_compile`/`git diff --check` clean.

#### Commit 2C.3 — one action switch and deletion gate

> - **Slice-1 done (structured subject-reference signal — 2C.2 blocker closed):** the missing TurnPlan subject-arity/set-ref signal that blocked q07 now exists. `intent_classifier.classify_intent` (the already-executed Pass-1 LLM JSON boundary — Phase 6 removed the gate, so it runs every message) gained `subject_scope` (`none|explicit|current_single|current_set`) + `subject_count` in its existing schema — **zero new model calls**. `TurnNeed` carries the same two fields (kind=="product" only, invalid→none). `resolve_subjects` validates the typed signal against the persisted `ConversationSubjectSet`: `current_set`+count absent-or-matching→resolved, `current_single`+n==1→resolved, `explicit`→no_subject_ref (explicit evidence owns upstream), missing-set/count-mismatch/unknown-scope/conf<0.7→clarify; it never interprets language when a signal is present. q07 (`tx-q07-pair-continuity`) restored `pending_live_replay`→`answer_level` with a per-turn `intent_result` override (new harness key on turns, keyed by message text); replay GREEN — both `3002`/`3003` reach the LLM pool via the existing `materialize_subject_cards` path. `_SET_COUNT_REF_RE`/`_SUBJECT_WHICH_KWS` stay deleted; new semantic keyword tables = 0. **Owner correction (2026-10-04, supersedes the interim wiring above):** `_chat_impl` now calls `decide_turn(intent_result=_intent_result, claim_state=_sv.claim_state, active_anchor=_sv.active_item_id)` **once per turn post-classify (before post_intent_handoffs)** — the pre-classification shadow call was removed and `_turn_decision_shadow` only serializes that same plan. `resolve_subjects` reads `subject_scope`/`subject_count` from the selected product `TurnNeed` and `signal_confidence` from `TurnPlan.intent_confidence` — no direct `_intent_result`→resolver path remains. `get_subject_set` also propagates `claim_state`/`active_item_id`/`products` when a doc exists without subject identity (claim-resume plans). Classifier example corrected: AC65B/AC65B2 = charger/adapter. **Remaining 2C.3 (not done):** TurnPlan action-switch consumption, branch deletion, warranty-policy enricher, `get_active_product` anchor readers, live classifier canary.

> - **Action-switch done + correction round (independent-review H1/H2/M1–M3 closed, uncommitted):** one `decide_turn` call post-classify feeds an unconditional `primary_action` gate (`human_wait`/`no_reply`/`clarify`/`handoff`/`execute_needs`); deleted: item-tag early-answer arm, pre-classify `detect_human_request`, 4 compare/link selectors + duplicate pin block, warranty-policy prose enricher, LINK-FOLLOWUP kw-gate/anchor-ladder. Corrections: **H1** planner exception now fail-closes (HTTPException 500 — zero retrieval/LLM/handoff; no fallback plan, no planless legacy path); **H2** mixed claim+product — warranty owner runs first, then the plan's product-ish needs dispatch once to the product owner (resolved subject cards or `fetch_products`+`llm.answer`, merged into the claim response); **M1** `detect_human_request` consumes `ctx["plan_decided_reason"]` (no re-detection) and an empty transport result fails closed (`HANDOFF_FAILED_REPLY` — no fallthrough to bot answer); **M2** duplicate-answer test now observes `_install`'s real captured LLM (`==1` answer call, non-vacuous); **M3** SRS updated. Focused evidence: action-switch 27p+4 correction tests, turn_decision/subject_set/shadow 229, claim+handoff 47, transport script 47/47, replay 101p — no new keyword tables/model calls/helpers. **Remaining blocker before close:** independent review + the one-time broad 37-file/offline batch (deferred per plan).
>
> - **Correction round 2 (handoff dominance + canonical path — uncommitted):** the interim mixed branch that ran `fetch_products`+`llm.answer` at the `_wfr` boundary is **deleted** — it duplicated the canonical product path and ran after confirmed handoffs. New contract at the `_wfr` boundary: `handoff_to_admin` or `answer==HANDOFF_FAILED_REPLY` → terminal return (zero retrieval/LLM/cards — handoff ownership outranks remaining needs same-turn); claim bot-owned + product-ish need in plan → `_mixed_claim_carry` (claim guidance text) flows into the existing canonical product pipeline and is composed once at the final `llm.answer`/`_ws_answer` boundary — normal `usage`/`cost`/`timing`/RAG+LLM2 steps/routing. `detect_human_request` is transport-only: `ctx["plan_decided_reason"]` required, absent→`None`, zero predicate calls inside; direct test callers migrated (transport tests pass the decided reason; detection suites pin `is_human_request`/`is_service_anger` — the same predicates `decide_turn` owns). Runtime net LOC −18 vs the round-1 correction state (cumulative −127 vs HEAD).
>
> - **Correction round 3 (typed disposition + single composition + required decision + real cost — uncommitted):** prose-derived lifecycle removed — warranty/claim owner now writes a typed internal `warranty_disposition` field on every claim-response dict. The `_wfr` boundary pops the field and gates on it — it never compares `answer`/copy text (a mutated `HANDOFF_FAILED_REPLY` stays terminal via the typed signal; the field is popped before `ChatResponse` and at the `chat_v2` boundary so it cannot leak into the API payload). `detect_human_request` takes `plan_decided_reason` as a **required keyword-only argument** — omitting it raises `TypeError`; the `ctx.get` fallback and missing-reason branch are deleted; all production and direct test callers supply the decided reason. Canonical metrics pinned: `resp.usage == {10,5,15}` fake usage, `resp.cost == LLM2 step cost_usd > 0`, RAG+LLM2 steps + `timing["llm"]` all from the one canonical call.
>
> - **Correction round 4 (guard-chain removal + enforceable typed contracts + routing invariance — uncommitted):** the `_mixed_claim_carry` guard chain is **deleted** — carry no longer appears in any branch-selection condition (general-elif / brand detection / KB lookup / superlative clarify / no-product guard restored to identical routing with or without claim guidance). Claim guidance is **presentation data only**, composed exactly once by the single existing shared finalizer `_append_base_warranty(answer, message, source, *, claim_guidance)` at every answer family (general/brand/KB/superlative-clarify/no-product/main/web-search) — both manual prepend blocks deleted; deterministic branches that never used the finisher now call this same existing finisher (no second finalizer, no per-return `if carry` checks). `warranty_disposition` is now an enforceable **`_WarrantyDisposition` enum** (`StrEnum`: `TERMINAL` / `CONTINUE_PRODUCT`) — all 8 producers write members, the boundary consumes exhaustively (`missing`/`unknown`/`TERMINAL` → fail-closed return; only `CONTINUE_PRODUCT` + productish need continues), and the `pop(..., "terminal")` string fallback is gone. `plan_decided_reason` is typed `Literal["human_request","customer_frustration"]` with an explicit `ValueError` on invalid input — a typo can no longer be reinterpreted as anger. Routing-invariance tests pin same-branch-with/without-carry across all reachable families including a real seeded `kb_products` fixture; missing-disposition fail-closed pinned. Runtime net LOC −127 vs HEAD (enum + finalizer param + ValueError balanced by the deleted guard chain, manual prepends, `_HandoffDecision` alias, `_reason` alias, and comment trims).
>
> - **Correction round 5 (handoff-reason ownership — uncommitted):** the action gate no longer inspects `TurnNeed.provenance` — `_ho_prov` construction deleted. `plan_decided_reason` is derived from the canonical `TurnPlan.flags` contract: `"customer_frustration"` iff the flag exists, else `"human_request"`. `provenance` remains serialized in the TurnDecisionShadow as diagnostic evidence only; renaming a diagnostic marker cannot flip the transport reason (pinned by an integration test that rewrites provenance post-plan while the flag stays — production still sends `customer_frustration`). Sibling contract pinned: handoff without the flag → `human_request`. Zero new helpers/guards/types/modules/tables/model calls; runtime net LOC −130 vs HEAD (3 lines tighter — `_ho_prov` block gone).

- [ ] Make legacy orchestration consume one `TurnPlan` and one `ConversationSubjectSet` before retrieval.
- [ ] Delete migrated early action/anchor/follow-up branches from `app.py`; retain deterministic extractors only as evidence producers.
- [ ] Pin Q6-Q9, Q12-Q13, Q15-Q18 and multi-need incidents through `chat()` replay.
- [ ] Report action owners and subject owners before/after; Phase 2C fails if either count does not decrease.

### Phase 2D — Botworker Platform And Shop Scope Gate

**Scope:** Starts only after Phase 2B and 2C are closed, and finishes before Phase 3. This phase controls botworker admission for the existing `/botworker` sandbox; it does not enable delivery to Shopee/TikTok/Lazada and does not change answer logic.

**Authoritative eligibility:**

```text
system_configs.bot_worker_enabled
AND platform is enabled for botworker
AND shops.bot_worker_enabled for the exact (platform, shop_id)
= eligible for botworker admission
```

- [x] Add one platform-scope field under the existing `main_config` owner and one `bot_worker_enabled` field on `shops`; all missing/new values resolve to OFF (fail-closed). **Done:** `main_config.bot_worker_platforms:{shopee,tiktok,lazada}` (single field, whitelist-validated in `PUT /api/config`, `FAIL_CLOSED_SWITCHES`) + `shops.bot_worker_enabled` (`upsertShop` `$setOnInsert:false`).
- [x] Do not reuse `connected` or `enabled_for_chat`: they retain connection/sync semantics and must not grant botworker admission. **Done:** resolver matches `bot_worker_enabled===true` only (T10 pin: connected/enabled_for_chat=true → deny).
- [x] Resolve the enabled `(platform, shop_id)` scope once per worker cycle and apply it in Mongo discovery before `claimMessage`; do not add a per-message settings lookup or distributed guards. **Done:** `resolveBotworkerScope` (1 config read caller-side + 1 shops query) → `BotworkerCycleScope{config,pairs}`; `buildScopeFilter` = `$or` per-platform `{platform,shop_id:{$in}}`; `withScope` composes every admission query; scope is a **required** param on `pollNewMessages`/`recoverStaleBuffers`/`recoverStaleClaims`/`checkWaitTimeouts` (tsc proves zero unscoped callers; no self-resolve fallback — the caller must supply a resolved scope). **Review-fix:** resolver now folds the global gate — `config.bot_worker_enabled!==true` → `pairs:[]` without querying shops; empty pairs → structural deny-all `{shop_id:{$in:[]}}` (the admission query may execute but matches/claims zero rows).
- [x] Apply the same scope to stale-claim/buffer recovery admission so disabled work cannot re-enter through restart recovery. Already-running work may finish; the existing global switch remains the immediate abort/drain kill switch. **Done:** all 4 admission queries (messages/chat_processing/buffer_messages×2/workflow_runs) consume the cycle snapshot; deferred wake-up resolves a fresh snapshot per pass.
- [x] Add platform switches and per-shop Botworker switches to `/shops`, with explicit effective-state labels: globally disabled, platform disabled, shop disabled, or enabled. **Done:** `src/lib/botworkerScope.ts` `effectiveBotworkerState` + `ToggleSwitch` reuse; tiktok/lazada switches disabled (no backend); PATCH→server-state, no optimistic UI.
- [x] Keep Shopee/TikTok/Lazada platform values in the contract, default all OFF, and do not enable a platform whose chatbot backend is not implemented. **Done:** `BOTWORKER_BACKENDS=["shopee"]` in `safety.ts`; enforced in 3 layers — `PUT /api/config` rejects `true` for non-backend platforms (422), resolver/buildScopeFilter hard-exclude non-backends even on direct DB edits, UI disables those switches.
- [x] RED-test global/platform/shop truth table, missing-config fail-closed, query-before-claim behavior, disabled recovery rows, scope changes between cycles, API authorization/audit, and responsive `/shops` UI states. **Done:** `test-botworker-scope-gate.ts` 47 tests — truth table ×10, admission ×12, historical/first-enable ×10, replay/idempotency ×7, API ×8, canary sim ×2 — all green; responsive layout verified via flex-wrap markup; **visual browser review still manual.**
- [ ] Canary: enable global + Shopee + exactly one shop; keep workflow disabled and concurrency 1; inspect replies only in `/botworker`/`shadow_replies`; assert platform-delivery calls remain zero and another shop remains unclaimed. **Simulated only (K1/K2):** config contract proved offline; **live canary not run — requires separate operator approval after commit.**
- [x] Stop criteria: any non-selected shop claim, platform API call, duplicate reply, uncontrolled provider spend, or inability to disable admission. No botworker process may be started by an AI agent; live execution requires separate operator approval. **Held:** 0 worker starts, 0 platform calls, deny-all verified (structural `{shop_id:{$in:[]}}` filter — a query may run but matches zero); kill switch + era abort unchanged.
- [x] **Review-fix (post-implementation):** (a) `resolveBotworkerScope` now enforces the global `bot_worker_enabled` gate inside the resolver itself — direct entry-point calls under global-OFF admit zero (previously only the `bot-worker.ts` loop gate enforced it); (b) `PATCH /api/shops/[id]` rejects `bot_worker_enabled:true` on non-`BOTWORKER_BACKENDS` platforms with 422, zero write, zero audit — disabling a latent flag stays allowed; drawer switch permits disable-only on unsupported platforms. Pins: C8/A6/X9/X10/X11 (52/52).

**Deletion/complexity gate:** eligibility has one configuration owner and one runtime admission owner; no second poller, per-message DB lookup, helper chain, parallel allowlist, or reuse of unrelated shop flags. Report query count, owner count, runtime LOC, and removed/replaced logic.

**Exit gate:** one selected shop can be exercised in the sandbox while every other shop/platform remains unclaimed, provider cost limits are armed, and global shutdown still aborts/drains the active era.

**Phase 2D implementation status (uncommitted working tree, pending independent review):**

- **Owners:** config = 1 (`systemConfigService.updateSystemConfig` / `PUT /api/config`); shop flag = 1 (`shopService.setShopBotWorker` / `PATCH /api/shops/[id]`); runtime admission = 1 (`botWorkerService.resolveBotworkerScope` + `botworkerRuntime.buildScopeFilter/withScope` — 4 query consumers). No new collection/index/env/dependency/poller/coordinator.
- **Query count:** +1 `shops.find` per worker cycle (scope resolution); scope DB lookups per message = 0; intra-cycle `getSystemConfig` reads in poll/recovery/timeout replaced by `scope.config` (single snapshot). The existing 5s-cached `getSystemConfig` inside `processClaimedMessage` remains for workflow flags — it is a cache read, not a per-message scope DB lookup, and was not threaded deeper deliberately.
- **Replay/historical safety (new-inbound contract):** canonical identity (`claimIdFor`/`batchIdFor`/`replyIdFor`) unchanged; admission boundary = three-level per-pair cutoff `created_timestamp > max(global_enabled_since, platform_enabled_at, shop_enabled_at)` — pre-cutoff rows never admitted regardless of which switch opened last; recovery is **reconcile-only (provider=0)**: committed evidence finalizes, interrupted claims settle `bot_failed`+rows `failed` dormant, orphans delete, foreign leases defer; **deleted:** `freshAfter` freshness gate, expired-claim re-execution, startup buffer auto-flush, `flushErrorRetryMs`/`scheduleFlushRetry`; dormant failed batches wake **only** via distinct inbound in the same `(platform, shop_id, conversation_id)` (carry-forward, fenced CAS revive, bounded by `maxClaimAttempts` → `quarantined`); successful terminal batches never re-open.
- **Focused verification (new contract):** scope-gate 88/88 · idempotency 71/71 · recovery-freshness 39/39 (suite rewritten to reconcile-only contract) · error-policy 38/38 · enable-checkpoint 18/18 · production-races 37/37 · boundary 20/20 · config-failclosed 4/4 · runtime-mongo-safety 110/110 · admin-logs 57/57 · shadow-batch-isolation 22/22 · shop-settings 3/3 · ownership-transport 244/244 — `tsc --noEmit` clean · `next build` clean · `git diff --check` clean. (env-gated suites `test-workflow-phase1/phase6/e2e`, `verify-botworker-runtime-mongo` require `ADMIN_JWT_SECRET`/`CHATBOT_INTERNAL_SECRET` — not runnable offline; no `.env` read.)
- **Complexity gate:** scope = additive required-param filtering on existing queries; old unscoped signatures deleted in the same diff (no parallel admission path). Runtime LOC: `botworkerRuntime` +46, `botWorkerService` +75/−Δ, `systemConfigService` +13, `shopService` +19, `safety.ts` +5, `bufferService` +16/−Δ, `workflowEngine` +12/−Δ, routes +95/−Δ, UI +138/−Δ, `botworkerScope.ts` +37 — net additive as designed (feature adds a gate, not a refactor); helper added = 1 shared module (`botworkerScope.ts` for page+drawer) + 3 pure runtime fns.
- **Residual risks:** (1) no retry policy for provider 429/5xx — `bot_failed` is terminal by design (BW-4); a future retryable-error contract is a separate decision; (2) UI visual/browser verification remains manual — no dev server was started; (3) `getSystemConfig` per-message cached read inside `processClaimedMessage` (workflow flags) retained — cached, not a DB hit.

**Phase 2D new-inbound + error carry-forward contract (2026-10-16, uncommitted):** superseded the earlier clean-start/operator-retry design — **no retry API, no retry queue, no autonomous timer**. Final contract: eligible inbound (post three-level cutoff) → buffer → distinct-message debounce → one flush → success terminal (`bot_answered`/`handed_off`/`trigger_matched`/`no_action`/`workflow_*`) OR dormant `failed` rows + `bot_failed` claims on technical failure (429/500/529/non-2xx/network/timeout/invalid-response/interrupted). Dormant batch retains original message_ids + text + raw media payload; wakes only on a distinct new inbound in the same exact `(platform, shop_id, conversation_id)` → one combined debounce → one flush. Poll/restart/enable-edge/recovery/lease-expiry can never wake it; a duplicate `message_id` never counts as new activity; attempt cap quarantines the old batch while new inbound stays independently processable. Recovery = reconciliation-only (provider=0): finalize persisted evidence, settle interrupted to dormant, delete orphans/leftovers, defer foreign leases. `checkWaitTimeouts` settles pre-cutoff parked runs without provider resume. Owners: cutoff/scope=1 (`resolveBotworkerScope`), buffer admission=1 (`bufferOrProcess`), flush=1 (`flushBuffer`), carry-forward=1 (`carryDormantRows`), provider invocation=1 (`processClaimedMessage`), recovery provider paths=0, error-retry timers=0, new collections/deps/env-flags=0. Deleted: `freshAfter` gate, `reconcileRow`/`rowSyncUpdate`/`verifyForeignClaim`/`reconcileClaimedRow`, expired-claim re-execute, startup buffer flush, `flushErrorRetryMs`+`scheduleFlushRetry`+`flushRetryTimers`, H10 old-contract test; recovery-freshness suite rewritten end-to-end (39 tests). Evidence: x100 poll+recovery passes on dormant batch → provider stays 1; x100 duplicate self-repolls → no wake; one-year historical inbound → 0 admitted; media URLs survive carry-forward; concurrent inbounds → one carrier. Runtime LOC delta vs HEAD: `botWorkerService` 2040→1926, `bufferService` 751→939, `botworkerRuntime` 80→134, `systemConfigService` 535→573, `shopService` 140→183, `workflowEngine` 1693→1713, `bot-worker.ts` 150→160.

**Pre-deploy procedure (future sequence — not executed in this round):** (1) finish code + local tests → independent review → commit Phase 2D → (2) deploy with worker/global switch OFF → verify zero worker processes → (3) read-only scoped census of old buffer/claim/workflow counts — do NOT replay them on startup → (4) set concurrency=1, keep workflow OFF → (5) enable Shopee platform → enable exactly one canary shop → enable global Botworker LAST → (6) record effective cutoff = `max(global_enabled_since, platform_at, shop_at)` → confirm only inbound created after cutoff is admitted → (7) observe provider usage + unique message_ids; provider count must not grow without new distinct inbound → (8) STOP immediately on any historical/duplicate activity.

**Phase 2D final independent review (2026-10-16, uncommitted):** independent re-review of the full diff found one Medium UI defect — `/shops` `handlePlatformToggle` echoed the whole `bot_worker_platforms` map into `PUT /api/config`, so a latent `true` on a non-backend platform (direct-DB only state) would 422-dead-end every platform switch with no UI recovery path. Fixed at the owner: new `buildBotWorkerPlatformPatch` in `src/lib/botworkerScope.ts` emits implemented-platform keys only — latent keys are never echoed and self-heal to OFF on the next read; sibling implemented values are preserved for the future multi-backend case. Corrections: platform-toggle payload narrowed (X12 pin, RED→GREEN), `botWorkerEffective` gained a semantic `code` field (UI no longer compares Thai display strings), drawer no-backend suffix deduplicated, global state labelled read-only in Thai, `load()` re-derives the open drawer's `selectedShop` so a successful save shows authoritative data. Verification: scope-gate 53/53 (+X12), all other focused suites unchanged-green (total 737/737), `tsc --noEmit` clean, `next build` clean, `git diff --check` clean. Browser visual verification remains an operator manual gate (no dev server started; `.env`-loading servers require separate authorization).

```text
Runtime files and lines added/deleted/net
Functions/helpers added/deleted
Decision owners and direct state writers before/after
Keyword tables, flags, shims, and parallel paths added/deleted
Xfails removed/remaining and exact blocker for each remainder
```

Mandatory: new semantic keyword tables = 0; new rollout flags = 0; long-lived shims = 0; migrated branch deleted in the same commit; owner count decreases; refactor-only runtime net LOC <= 0. Failure means `INCREASES_COMPLEXITY_BLOCKED`, no commit.

### YAGNI cuts

- `claim_state_expect` per-turn schema — not added: final-state `final_claim_state` + `turn_decision_expect` per-turn already cover every case in the truth table; intermediate non-mutation is implied by both.
- Public lifecycle wrapper — not created in 2A (tests target `_claim_collecting` as temporary owner).
- `has_video` writer — dead field documented; removal deferred to Phase 2B owner consolidation.

## Master Requirement Traceability (2026-10-13)

Acceptance ledger for the 21 user requirements. `blocked` rows cite the blocking contract; nothing here expands this round's implementation scope.

| # | Requirement | Current owner/path | Action | Target phase | Acceptance evidence | Status |
|---|---|---|---|---|---|---|
| 1 | Workflow/trigger consolidation | `src/backend/service/workflowEngine.ts`, `src/app/api/triggers/` | replace (single gated owner) | Phase 9 | trigger/workflow suites + ownership gate tests | not_started |
| 2 | Deep product specs | `product_store.py`, `knowledge_base.py` | replace (canonical schema) | Phase 3+5 | schema fixture + field-evidence tests | not_started |
| 3 | Complexity reduction | repo-wide (`ChatAdminWeb/src` net LOC vs HEAD) | keep (gate per phase) | every phase / Phase 10 | numstat net ≤0 at each phase close | in_progress (2B.1: −116) |
| 4 | Latency/cost | `llm.py` pipeline, shadow cost metrics | replace (one answer boundary) | Phase 8 | bounded context + per-call cost report | not_started |
| 5 | Regressions | `docs/test/` corpus + `scripts/test-*` suites | keep (expand coverage pins) | all | 9 offline suites green + replay fixtures | in_progress |
| 6 | Product pool (canonical evidence) | `product_store.py` multi-source fetch | replace (single union pool) | Phase 4 | pool-completeness tests vs source census | not_started |
| 7 | Stock freshness | availability fields in product schema | replace (schema contract) | Phase 3 | freshness TTL + staleness tests | not_started |
| 8 | Order history | `order_store.py` | keep (owner exists) | Phase 2C integration | lookup tests via TurnPlan context | not_started |
| 9 | Anchor/follow-up/history | `conversation_products.py`, `turn_decision.py` | replace (ConversationSubjectSet) | Phase 2C | subject-set migration + deleted app-local branches | not_started |
| 10 | LLM/websearch pipeline | `llm.py`, `web_search.py` | replace (web gate) | Phase 7 | gated search tests, no unbounded fetch | not_started |
| 11 | Intent reliability | `intent_classifier.py` | replace (multi-need TurnPlan) | Phase 2C | multi-intent fixture resolves blockers | not_started |
| 12 | Logs/metrics | `src/app/api/stats/*`, `responseStats.ts`, `adminLogService` | keep + replace (bounded contract) | Phase 2B.1 (done) | T1–T13 grace contract + freeze proof | **verified** (response metric); logs keep |
| 13 | Ratings | `testChatRatingService` | keep | — | existing rating tests | not_started |
| 14 | Troubleshooting/handoff | `handoffService`, `bot-handoff` route, `statusConversationService` | keep (transport verified) | Phase 2B | ownership suites green | in_progress — reopen path **blocked** by external inbound writer |
| 15 | Round robin | `liveAssignmentService`, `assignmentService` | keep | Phase 2B integration | assignment contract tests | not_started |
| 16 | Comparison (replay) | `replay-compare` route + `replay_compare.py` | keep | — | replay fixtures + suite | in_progress (in use) |
| 17 | Compatibility | field evidence + proof booleans | replace (compat proof contract) | Phase 5 | compat-proof tests on real incident rows | not_started |
| 18 | Warranty/claim intent | `warranty.py`, claim episode state | replace (episode owner) | Phase 2B.4-2B.6 | episode-scoped outcome tests | not_started |
| 19 | Certification/TISI | `knowledge_base.py` evidence fields | replace (field evidence) | Phase 5 | evidence-card coverage tests | not_started |
| 20 | Legacy/new-plan consolidation | this roadmap | keep (traceability ledger) | all | this table 21/21 rows | in_progress |
| 21 | v2/v3 retirement | superseded phases + dead exports | delete | Phase 10 | deletion manifest + zero-prod-caller audit | in_progress (2B.1: backfill/dead exports removed) |

Blocking contracts: **external inbound writer** (Sellcenter dump must CAS `status_conversation {status:bot, assigned_to:null}` on `closed/resolved` + newer inbound, and write complete meta at ingress — also unbounds `status=bot`/`unassigned` list queries) blocks #14 reopen path; **Phase 2B state/command truth** gates #1, #11, #18 per rollout rules.

**Phase 2D UI relocation (2026-10-16, uncommitted):** per-shop Botworker switch moved from `ShopDetailDrawer` onto each shop card on `/shops` — the card is now the sole per-shop Botworker UI owner. Card row sits between sync/chat info and the workflow footer: Bot icon + `บอทตอบกลับ` + effective-state text (`botWorkerEffective` — unchanged owner) + `ToggleSwitch`; row-level `stopPropagation` keeps card click → drawer intact while switch/row clicks never open it. Page owns `shopSavingId: string | null` — only the saving shop's switch disables; PATCH `/shops/{id}` then authoritative `load()` (no optimistic mutation). Drawer deleted: `bwEnabled`/`bwSaving`/sync effect/`toggleBotWorker`/`bwImpl`/`bwEff`/control row JSX/`botWorker`+`onChanged` props/`ToggleSwitch`+`botworkerScope` imports/`ShopRow.bot_worker_enabled` — drawer is Workflow/Trigger/Persona/KB only. Disable rules on card: `!canEditPage("shop")` / saving-shop / unsupported-platform OFF (latent ON still disable-only; API 422 remains final boundary). Runtime/API/contract bytes untouched. Verification: scope-gate 53/53, shop-settings 3/3, `tsc --noEmit` clean, `next build` clean, `git diff --check` clean. Visual verification via live dev server pending operator check.

**Phase 2D CAS correction (2026-10-16, uncommitted):** per-shop Botworker write is now optimistic concurrency — PATCH `/api/shops/[id]` is single-command (`{connected}` XOR `{bot_worker_enabled, expected_bot_worker_enabled}`; mixed → 422 with zero write/audit, removing the partial-write path). `setShopBotWorker(shopId, enabled, expected)` issues one atomic `updateOne` whose filter encodes the caller-observed value (expected=true → `{shop_id,bot_worker_enabled:true}`; expected=false → `{shop_id,$or:[{bot_worker_enabled:false},{bot_worker_enabled:{$exists:false}}]}` — missing ≡ false); success = `matchedCount===1` (idempotent same-value writes still match). CAS miss → route re-reads once (gone → 404; exists → 409 `shop botworker state changed`) with zero audit and no retry. Card UI serializes saves per browser (`shopSavingId` locks all shop switches while one PATCH is in flight — spinner only on the saving shop), sends `expected_bot_worker_enabled` from the displayed persisted flag, reloads authoritative rows before success toast, and on 409 reloads + shows a specific conflict toast without retry. RED→GREEN: X13 combined→422, X14a–e CAS matrix (incl. missing-field canonical-false + no-retry single updateOne), X15 two stale callers → one 200 + one 409 + one audit, X16 different shops independent, X17 expected validation → 400; X5–X12 migrated to the new payload unchanged semantics. Scope-gate 61/61, shop-settings 3/3, admin-logs 57/57, config-failclosed 4/4, `tsc --noEmit` clean, `next build` clean, `git diff --check` clean. Admission/runtime bytes unchanged — only the shop write owner, its route contract, and the card handler changed.

**Phase 2D platform-fence CAS (2026-10-16, uncommitted):** the per-shop enable CAS now fences `platform ∈ BOTWORKER_BACKENDS` inside the same `updateOne` filter — a shop-sync platform flip between the route pre-read and the write can no longer persist `bot_worker_enabled:true` on an unsupported platform (was only prevented by the pre-read check; write raced past it). Disable keeps no platform fence — latent `true` remains clearable on any platform. CAS miss classification on the single re-read: missing → 404, enabling + now-unsupported → 422, otherwise → 409 (stale expected never misclassified). RED→GREEN: X18 platform flip mid-request → 422 + zero write/audit + exactly one updateOne; X19 latent disable on unsupported → 200; X20 enable-with-stale-expected → 409 (not 422). Scope-gate 64/64, shop-settings 3/3, admin-logs 57/57, config-failclosed 4/4, `tsc --noEmit` clean, `git diff --check` clean.

**Phase 2D retry/scope root-cause correction (2026-10-16, uncommitted):** independent review found four behavioral gaps — fixed at root cause. (A) Autonomous lease/lock retry deleted entirely: `scheduleFlushRetry`, `flushRetryTimers`, lock-loss recheck, and foreign-claim lease polling removed; a lost conv lock is now a plain skip, and the winning flusher arms a normal debounce for leftover rows once inside `finally` after fenced lock release (ownership-gated `ownsBatch`) — zero provider-capable retry timers remain; expired foreign claims reconcile dormant (`bot_failed` claim + `failed` row) with provider=0. (B) Delayed-execution scope gate: `flushBuffer` is the single delayed-admission owner — resolves current scope once, requires the exact pair still enabled and each ordinary row's `msg_created_at > pair.cutoff`; superseded rows settle terminal `no_action` (fenced CAS) + `markProcessed` + row delete — never dormant, never carryable; carried dormant rows bypass the cutoff (the new inbound is the wake gate); global-era safety comes from falling-edge `clearPendingWork` + rising-edge reconcile ordering. (C) Exact tuple identity: `bufferTimers`, `getBufferedMessages`, `flushBuffer(platform, shop_id, conversation_id, …)`, conv lock and `batchIdFor` all key by `convLockIdFor(platform, shop_id, conversation_id)` — no conversation-only query or timer remains; rows persist `msg_created_at` + `admitted_edge` admission evidence. (D) Platform edge atomic CAS: `bot_worker_platforms` removed from `updateSystemConfig` whitelist; new `setBotWorkerPlatformEnabled(platform, enabled, expected)` is the single write owner — one `updateOne` filtered on expected persisted state (missing≡false, upsert only when expected=false), OFF→ON stamps `bot_worker_platform_enabled_at.<p>` in the same write, ON→OFF clears, true→true is an early no-op that cannot move the edge; miss → one bounded reread → 409, audit only on success; route validates `expected_bot_worker_platforms` and audits per-key; `/shops` sends the expected map and reloads on 409 (same UX as shop CAS). (E) Media pins: CF11 `image_with_text` and CF12 `video` carry-forward proven alongside CF8 `image`. RED evidence: 16 failures on first mutant run (dormant carry, scope-disabled settle, tuple partition, CAS) — all converted to green via implementation/fixture correctness (edge epoch falsy sentinel, `seedFailedRow` claim seeding removed, numeric `created_timestamp` fixtures → Date, SD wait-for-inflight, X12 persisted-state pin, strict-owned re-fence). Focused GREEN: scope-gate 103/103 · production-races 37/37 · idempotency 71/71 · recovery-freshness 30/30 · error-policy 38/38 · enable-checkpoint 18/18 · boundary 20/20 · config-failclosed 4/4 · runtime-mongo-safety 110 · shop-settings 3 · admin-logs 57 · ownership-transport 244 · shadow-batch 22 — `tsc --noEmit`, `npm run build`, `git diff --check` clean. New collections/deps/env flags/pollers = 0; new semantic keyword/regex tables = 0.

**Phase 2D independent final-review corrections (2026-10-16, uncommitted):** a second independent review (fresh diff + fresh test output; prior entries above treated as claims, not facts) proved five real defects and one test-honesty gap, all fixed at the owner. Supersedes details in the two entries above: (1) `setBotWorkerPlatformEnabled` — `upsert:!expected` let a CAS miss (expected=false vs persisted=true) attempt an insert against the unique `config_key` index → E11000 → 500 instead of 409; now `code===11000` maps into the same bounded-reread miss path, and `enabled===expected` is a zero-write `findOne` probe on the expected filter (match → applied no-change; miss → applied:false → route 409) instead of an unconditional early no-op — a stale `(true,true)` no longer reports applied while persisted is OFF. (2) `setShopBotWorker` gained the same probe — `(enable=true, expected=true)` previously matched the CAS filter and restamped `bot_worker_enabled_at`, silently moving the shop cutoff on an idempotent call; the probe is zero-write and edge-preserving. (3) `PUT /api/config` `bot_worker_platforms` is now enforced single-command: exactly one platform key per request and no foreign fields (`{bot_worker_platforms:{shopee,tiktok}}` or `{...+other config field}` → 422 before any CAS) — the per-key loop allowed key1 to commit with zero audit before key2's 409; `buildBotWorkerPlatformPatch` is therefore deleted (page sends `{[p]:next}`/`{[p]:seen}` inline — same contract as PATCH shop). (4) `recoverStaleBuffersAndClaims` passed the first caller's stale `scope` to `classifyRecoveredBufferRow` while enumeration/claims used the latest joiner's `passScope` — a scope-refreshing joiner could misclassify a pre-new-cutoff row as dormant-carryable instead of `no_action`+delete; one-token fix to `passScope`. (5) `verify-botworker-runtime-mongo.ts` seeds lacked `bot_worker_platform_enabled_at`/`bot_worker_enabled_at` → resolver fail-closed → harness could not start (env-gated, statically proven fix). (6) `botWorkerEffective(null)` now returns distinct `code:"unavailable"` instead of masquerading as `global_off`. Test honesty: scope-gate mocks previously *reimplemented* the platform CAS (read-then-write, no upsert, no unique key) — hooks gained a `parentURL===MOCK_URL` exemption, the mock now delegates to the real service through a state.config↔coll bridge, and `uniqueKeys` registers `system_configs.config_key`; `config-failclosed` gained F5–F8 exercising the real CAS incl. E11000/upsert/probe paths. Fresh post-fix evidence: scope-gate 107/107 · config-failclosed 8/8 · production-races 37 · idempotency 71 · recovery-freshness 30 · error-policy 38 · enable-checkpoint 18 · boundary 20 · runtime-mongo-safety 110 · shop-settings 3 · admin-logs 57 · ownership-transport 244 · shadow-batch 22 · `tsc --noEmit`/`npm run build`/`git diff --check` clean. UI visual gate remains login-blocked (no authenticated session; `.env` not readable); real-Mongo harness stays env-gated.

**Phase 2D final narrow corrections — mapping index + exhaustive EngineResult (2026-10-16, uncommitted):** third independent review of the shop-context correction found exactly two residual defects, fixed at the owner without touching resolved shop mapping/mandatory context/dispatcher ordering/buffer/product-retrieval. (H1) `resolveBotworkerScope` was logically bounded by enabled-shop identities but the `(platform, shop_name)` arm had no supporting index — at production scale (~135k `conversations_shp`) every worker cycle could platform-prefix-scan. Fix: one non-unique partial index declared at the existing owner `mongoClient.ts::ensureIndexes` — `{platform:1, shop_name:1, shop_id:1}` named `platform_1_shop_name_1_shop_id_1`, `partialFilterExpression:{shop_name:{$gt:""}}` (docs without usable string `shop_name` never enter the index) — plus resolver name clauses changed from `{shop_name:{$in:[...]}}` to per-name equality terms `{platform, shop_name:<name>}` so the planner can prove the partial filter. Disposable `mongo:7` explain (120,006 synthetic docs, production-shaped canonical index present): BEFORE → name arms IXSCAN'd the `{platform,shop_id,…}` compound as platform-prefix + in-memory filter, `totalDocsExamined=120,010`; AFTER → per-term IXSCAN on both `platform_1_shop_name_1_shop_id_1` and the canonical compound, `totalDocsExamined=5`, `totalKeysExamined=5`, 5 mapping rows, 0 COLLSCAN, ~59ms→~0ms. **Declaration is code only — the real production index has NOT been created; Botworker stays OFF until separate index approval + verification.** (M1) `EngineResult.status:"error"` was non-exhaustive: 9/10 producers set `recoverable:false` while the terminal-run resume used `error`+absent-recoverable to mean fall-through — missing data was a behavioral control. Fix: `EngineResult` is now a discriminated union — non-error arms carry `recoverable?:undefined`, the `error` arm requires `recoverable:boolean` at type level; resume on terminal/non-active run returns existing `no_match` (never `error`); dispatcher branches on typed `status`+`recoverable` only (`recoverable===undefined` checks = 0; reason-string classification = 0); `test-chat` resume treats `no_match` as continue-to-match. RED→GREEN: focused suite 30/34 → 34/34 (I1 index declaration, I2 index-compatible query shape, J1 terminal-run non-error, J2 recoverable-typed producers, J3 dispatcher fall-through, J4 no undefined/reason branching). Fresh verification: shop-context 34/34 · scope-gate 107/107 · error-policy 38/38 · idempotency 71/71 · production-races 37/37 · recovery-freshness 30/30 · boundary 20/20 · enable-checkpoint 18/18 · config-failclosed 8/8 · runtime-mongo-safety 111/111 · ownership-transport 244/244 · workflow-e2e 16/16 · phase1 69/69 · phase6 69/69 · disposable runtime harness 55/55 (DB dropped, containers removed) · `tsc --noEmit`/`npm run build`/`git diff --check` clean. New modules/deps/env/flags/collections = 0 (one index declaration only); production `ensureIndexes`/createIndex calls executed = 0; product/retrieval bytes = 0; dispatch owner = 1. Verdict: `BOTWORKER_LOGIC_FINAL_GREEN_PRODUCTION_MAPPING_INDEX_PENDING`.
