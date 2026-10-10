# Legacy Shopee Unified Turn And Evidence Retrieval Rebaseline Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` task-by-task. Do not implement two phases in parallel on the same branch. Every runtime phase is TDD, requires a fresh reviewer, and must delete or retire an older decision path before it can close.

**Goal:** Make the legacy Shopee bot understand one turn once, keep conversation ownership separate from claim/business lifecycle, verify side effects before claiming success, preserve the correct conversation subjects, retrieve all relevant product evidence into one canonical pool, select context once, and answer through one grounded boundary without case-specific keyword patches.

**Architecture:** Keep the useful availability, unit/live-listing, evidence-card, OCR/cert, history, workflow, assignment, and botworker foundations. Introduce one multi-need turn plan, independent ownership/claim axes, a typed handoff command/result boundary, one conversation subject set, one canonical product/evidence schema, one candidate pool, one selector, and one answer-context compiler. Every migration deletes the replaced owner in the same commit; grouped retrieval may not remain an extra list merged into legacy.

**Tech Stack:** Python 3, FastAPI legacy Shopee runtime, MongoDB read-only product/order/stock data plus admin-owned state collections, existing local embeddings, Gemini/OpenRouter clients, pytest-style tests under `docs/test/`, and the existing Next.js admin status/handoff boundary.

**Status:** Active rebaseline roadmap, revised and accepted 2026-10-09 after the repository-wide architecture audit. Phase 2A is an accepted/frozen test baseline. Phase 2B and 2C below supersede their earlier implementation sequence. Runtime implementation starts at Phase 2B.1 and proceeds sequentially under the RED-first and deletion gates below.

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

## Revised Phase 2A-2C: State, Verified Commands, And Authoritative Subjects

**Purpose:** Separate who may answer, which claim episode is active, what commands actually completed, and which products the customer is discussing. No layer may infer these facts from bot prose.

**Phase split:**

- **2A — accepted/frozen baseline:** executable lifecycle incidents, three-axis terminology, and blockers. Test/audit only; already committed as `37f6d30`.
- **2B — next implementation package:** authoritative ownership transport, claim episode/lifecycle consolidation, verified handoff result, and explicit claim outcome event.
- **2C — after 2B:** evolve `turn_decision.py` into multi-need `TurnPlan`, then make `ConversationSubjectSet` authoritative for follow-ups.

**Files:** Phase 2B may modify `responses.py`, `warranty_flow.py`, `conversation_products.py`, `app.py`, `ChatAdminWeb/src/backend/service/handoffService.ts`, `statusConversationService.ts`, `botCallService.ts`, and the existing handoff/close API boundaries. Phase 2C may modify `turn_decision.py`, `conversation_products.py`, `route_context.py`, and `app.py`. Exact tasks and deletion gates are specified in the detailed Phase 2B/2C sections below.

- [ ] Phase 2B first proves ownership-state transport and handoff outcomes independently from claim parsing.
- [ ] Phase 2B then consolidates claim episode activation, field acceptance, and transitions in one legacy owner; storage remains in `conversation_products`.
- [ ] Phase 2C RED-tests Q6->Q9, Q12->Q13, Q15->Q18, explicit topic switch, ambiguous references, and multi-need turns.
- [ ] Phase 2C resolves subjects once: explicit identity wins; referential turns use persisted subjects; bot prose is never truth; ambiguity clarifies.
- [ ] Compare/price/link/compat/policy consume the same subject set. An unavailable subject cannot be silently replaced by another product.
- [ ] Keep referenced product/category and order-policy facts stable across follow-ups. Persist customer/order facts, never the prior bot's policy conclusion.

**Exit gate:** Phase 2B closes false-success handoff and claim lifecycle incidents with fewer owners/direct writes; Phase 2C preserves all independent needs and stable subjects. Ticket ownership and explicit events outrank history markers throughout.

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

Run `0 -> 1 -> 2A (accepted) -> 2B -> 2C -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10`.

- Begin next at **2B.1** after this revision is reviewed. Do not rerun or enlarge 2A as a substitute for implementation.
- Do not run Phases 2B-8 in parallel on one branch; contracts and `app.py` boundaries are sequential.
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

Do not continue the old Phase 7 sequence and do not add a Phase 5G keyword/helper patch. Phase 0, Phase 1 shadow work, and Phase 2A are preserved evidence. After review of the 2026-10-09 revision, implementation starts at **Phase 2B.1 authoritative ownership transport**, then proceeds sequentially through 2B and 2C. The completed work remains useful infrastructure; this revision changes ownership and migration order without restarting the project.

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

#### Commit 2B.4 — claim episode/lifecycle owner

**Files:** modify `warranty_flow.py`, `conversation_products.py`, Phase 2A tests/fixtures, SRS/log. Do not create `claim_lifecycle.py` unless the reviewer proves deletion cannot keep `warranty_flow.py` understandable; the default is reuse and consolidate.

- [ ] RED-test terminal precedence, explicit fresh request after resolved, customer identity reuse, case-evidence reset, and bare contact data after terminal.
- [ ] Add `episode_id` at `absent|resolved|cancelled -> collecting`; retain `customer_name/customer_phone` only through an explicit allowlist and clear prior case evidence.
- [ ] Make one lifecycle evaluator produce `ClaimLifecycleView`. Replace and delete `_claim_collecting` slot-based activation.
- [ ] Route stage changes through one transition owner; storage helpers remain persistence-only.
- [ ] Un-xfail `p2a-claim-resolved-new-request` only when the executor and TurnDecision consumer use the same lifecycle view.

**Exit:** retained slots are audit data, not activation; a new incident has a distinct episode id.

#### Commit 2B.5 — ticket close semantics and field persistence

**Files:** modify `warranty_flow.py` and existing Phase 2A fixtures/tests; update SRS/log.

- [ ] Delete the closed-ticket `clear_claim_state` branch; close changes ownership only.
- [ ] Un-xfail `p2a-claim-ticket-closed-keeps-state`, `-product-question`, and `-phone-resume`.
- [ ] Fix lone-name persistence at the existing parser/persistence owner and delete duplicate branch-local validation.
- [ ] Un-xfail `p2a-claim-collect-name-phone` only after name and phone persist through the same episode.

**Exit:** closing and reopening a conversation cannot erase or resolve a claim episode.

#### Commit 2B.6 — explicit admin claim outcome

**Files:** create `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/claim-outcome/route.ts`; modify `statusConversationService.ts`, `bot-handoff/route.ts`, `botCallService.ts`, the admin conversation response/type, and `components/chat/InfoTab.tsx`; consume the event in the legacy claim owner; update schema/SRS/log and focused API/UI/contract tests. Do not repurpose the existing conversation `close` or `resolve` routes.

- [ ] RED-test ordinary close with an active claim: ownership returns to bot and claim remains collecting.
- [ ] RED-test explicit `resolved` and `cancelled` for the current `episode_id`, stale episode id, repeated event, and non-claim conversation.
- [ ] Move production `bot_claim_info` ownership from raw `conversations` into `status_conversation`, including `active_claim_episode_id`; test/sandbox stores remain isolated as today.
- [ ] Persist `ClaimOutcome` in `status_conversation` separately from conversation `status`; require actor, timestamp, outcome, and matching episode id.
- [ ] Add a dedicated claim section in `InfoTab` only when `active_claim_episode_id` exists, with explicit `resolved` and `cancelled` commands plus confirmation. Ordinary close remains a separate action and never sends a claim outcome.
- [ ] Extend the existing `/chat` state payload with the episode-scoped outcome. The wire form uses an ISO timestamp; storage keeps a Mongo `Date`.
- [ ] Apply the event idempotently to the Python claim lifecycle on the next authoritative turn. A stale/mismatched episode cannot terminate the active claim, and repeated delivery is a no-op.
- [ ] Delete `_TERMINAL_CLAIM_REASONS` as lifecycle resolution evidence; keep any still-needed reason only as audit/routing metadata.
- [ ] Do not infer resolution from close reason, free-text resolution, bot answer, handoff reason, or ticket status.

**Exit:** `BLOCKED_BY_MISSING_CLAIM_RESOLUTION_EVENT` and `BLOCKED_BY_CLAIM_EPISODE_IDENTITY` are closed by explicit, episode-scoped evidence.

#### Commit 2B.7 — residual deletion and gate

- [ ] Inventory direct claim-stage writers, handoff bool writers, raw production ticket-state readers, and lifecycle predicates.
- [ ] Delete dead direct writes/helpers/fields, including `has_video` only if no live writer/consumer remains.
- [ ] Run Phase 2A contract, legacy replay/isolation, handoff/API, typecheck/build, and diff checks.
- [ ] Report owner count, direct writer count, runtime LOC delta, un-xfails, and residual blockers. No cleanup item may be deferred here from an earlier commit merely to make that commit additive.

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

- [ ] RED-test mixed claim+product, product+policy, comparison+compatibility, explicit human request plus information need, and noise/media-only turns.
- [ ] Replace the one-action result with `TurnPlan.needs[]` in `turn_decision.py`; no new semantic keyword table and no `turn_policy.py`.
- [ ] Keep shadow comparison until every consumer understands `needs[]`; delete the superseded one-action assertions/adapter in the same commit.

#### Commit 2C.2 — persisted subject set

- [ ] RED-test explicit model identity, compare pairs, recommendation batches, topic switch, ambiguous "ตัวนี้", unavailable subject, and no-history turns with persisted subjects.
- [ ] Persist subject ids/relations/operations from explicit evidence and selected results; never persist a conclusion parsed from bot prose.
- [ ] Migrate compare/price/link/compat follow-ups to the subject set and delete the corresponding app-local history/keyword owner blocks.
- [ ] Ambiguity produces clarification; it must not silently select the newest or sellable tail product.

#### Commit 2C.3 — one action switch and deletion gate

- [ ] Make legacy orchestration consume one `TurnPlan` and one `ConversationSubjectSet` before retrieval.
- [ ] Delete migrated early action/anchor/follow-up branches from `app.py`; retain deterministic extractors only as evidence producers.
- [ ] Pin Q6-Q9, Q12-Q13, Q15-Q18 and multi-need incidents through `chat()` replay.
- [ ] Report action owners and subject owners before/after; Phase 2C fails if either count does not decrease.

**Phase 2B/2C complexity gates — every runtime commit reports:**

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
