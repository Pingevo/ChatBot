# Current System Architecture And Root-Cause Audit

> Date: 2026-10-09
> Scope: read-only audit of the current repository state. This document is not an implementation plan and does not authorize runtime changes.
> Evidence: current code at `04f0e10`, both waythrough logs, SRS/SSD, function/process documentation, schema, README, active and historical plans, tests, and recent Git history.

### Audit method and limits

This audit inventories the product-owned source, routes, services, scripts, tests, contracts, plans, and documentation across the repository. The reviewed surface includes the 54-file Shopee package, 52 backend files, 99 API routes, 148 app files, 93 Python test/audit scripts, 32 TypeScript script tests, all plan headings/status ledgers, fixture schemas, and representative stored result aggregates.

"Reviewed repository-wide" does not mean pretending that every generated replay row, binary workbook, image, font, dependency, cache file, or secret was read line by line. Generated results were inspected by schema, aggregate, and representative failures; binary/vendor/cache artifacts were inventoried but are not architectural evidence. `.env*` and `มาแล้วจ้า.md` were deliberately not opened. The waythrough files were used as a change diary only: every important claim below was checked against current code, a current contract, or a stored result artifact.

## 1. Executive Verdict

The system contains many useful capabilities, but it does not yet implement the requested product as one coherent architecture.

- Shopee is the only implemented chatbot runtime. Lazada and TikTok compose services point to empty placeholder packages and will crash if enabled.
- The production default is the 5,223-line legacy `_chat_impl`. `chat_v2` and `chatbotv3` remain selectable by request or environment even though they are incomplete and no longer wanted.
- `turn_decision.py` is still shadow-only. It does not own production routing.
- Grouped retrieval is flag-gated augmentation. It is merged in front of legacy candidates; it has not replaced the legacy retrieval/merge path.
- Trigger, workflow, legacy detectors, intent, warranty/order flows, TurnDecision shadow, and final guards all make overlapping routing decisions.
- The largest correctness defect is semantic, not a missing keyword: flags such as `handoff_to_admin` describe both an intended action and a supposedly completed side effect. Some paths set the flag without performing or verifying the handoff.
- The largest complexity defect is additive evolution: fixes and new plans were added while replaced branches remained live. Tests then accumulated around each branch, making local behavior safer while preserving multiple owners.

Verdict: the project is at **rebaseline/audit stage for answer logic**, not at the end of Phase 2. Phase 2A defines tests and lifecycle blockers; Phase 2B/2C runtime replacement has not started.

## 2. Current Runtime Map

### 2.1 Live request path

```text
platform message
  -> ChatAdminWeb / botworker or direct caller
  -> platform-specific chatbot URL
  -> POST /chat
  -> engine switch
       v3 when request/env selects it
       v2 when request/env selects it
       legacy otherwise (production default)
  -> final output guard
  -> response
```

For botworker turns, another decision stack exists before `/chat`:

```text
active workflow resume
  -> workflow match (depending on priority)
  -> trigger substring match
  -> Python chatbot
```

`workflow_priority="both"` intentionally allows workflow output and trigger processing to continue, so multiple replies are a configured behavior rather than an accidental impossibility.

### 2.2 Legacy answer path

The active legacy path contains at least these decision layers:

1. route normalization
2. optional vision LLM
3. item-card shortcut and anchor logic
4. pre-intent human/anger handoff detector
5. order early flow
6. warranty/claim state machine
7. intent LLM
8. tax/cert handlers
9. general and brand handlers
10. conversation anchor/follow-up heuristics
11. model regex, KB lookup, Mongo lookup, unit-index path, compatibility path
12. grouped retrieval augmentation when enabled
13. web-search fallback and re-answer
14. main answer LLM
15. final output guard/rewrite/escalation

This is not one pipeline with one owner. It is a sequence of partially overlapping short-circuit pipelines.

### 2.3 Data sources today

| Concern | Current source |
|---|---|
| Shopee catalog | `ShpProducts` via `MONGO_COLLECTION` |
| Lazada catalog | planned `OpenLazadaProducts`; chatbot package is empty |
| TikTok catalog | planned `TiksProduct`; chatbot package is empty |
| Shared KB | admin DB `knowledge_base`, `kb_products`, `kb_qa` |
| Stock/cert supplement | `itStock.Products` plus catalog fields |
| Orders | one configured `ORDER_COLLECTION`, default `ShpOrders` |
| Conversation subject/claim | `conversation_products` |
| Ownership/assignment | `status_conversation` plus assignment collections |

The three-platform requirement is therefore a target, not current behavior. Product collection switching exists in compose, but shared runtime adapters and platform order sources do not.

## 3. Root Causes

### RC1: Add-first evolution without retirement

Legacy behavior remained live while v2, v3, grouped retrieval, TurnDecision, output guards, and many targeted fixes were added. Recent plans correctly require migrate-and-delete, but runtime has not reached those phases. The result is more than 30,000 lines in the Python chatbot package, 5,223 lines in `app.py`, nine `fetch_products` callsites in that file, and 15 direct `ChatResponse` returns.

### RC2: No single decision owner

Workflow, trigger, handoff detectors, order flow, warranty flow, intent, anchor logic, retrieval policy, web-search policy, TurnDecision shadow, and output guards can all decide what a turn means. Their precedence is encoded mainly by source order and early returns. A fix in one owner does not automatically apply to the others.

### RC3: Desired action and completed side effect share one flag

`handoff_to_admin` is treated as proof that handoff happened. In reality:

- the no-product branch sets `handoff_to_admin=True` without calling `_send_handoff`;
- `guards.enforce` returns immediately when that flag is true;
- `_send_handoff` returns `{}` on failure;
- several callers set the success flag without validating the result.

This directly produces “the bot says it sent an admin but no handoff occurred.” The correct model needs an explicit command/result boundary, not another keyword or guard.

### RC4: Conversation ownership and business lifecycle are conflated

`open`, `handoff`, `pending`, `closed`, and `resolved` are used as conversation ownership/status. Claim lifecycle is separately stored as a flat `claim_state`, but legacy code clears it when a ticket is closed. Admin close can mean “I replied; wait for customer,” so close is not claim resolution. Phase 2A already proves this mismatch and records that an explicit claim-resolution event does not exist.

### RC5: Candidate union and final selection have multiple owners

KB cards, catalog cards, unit cards, anchors, compatibility results, grouped selection, fallback products, and web-search re-query are merged at branch-local points. `_merge_kb_mongo` may append KB-only products; grouped selection then prepends selected cards to the legacy list. This is source accumulation, not a canonical evidence union followed by one selector.

### RC6: Keywords are acting as the control plane

Keywords are appropriate for lexical extraction and deterministic policy facts. They become fragile when they choose whole flows. Current core Python contains 833 references to keyword concepts, including product taxonomy, anger/human detection, follow-up, comparison, compatibility, claims, tax, certificate, stock, and web-search gates. The issue is not the existence of keywords; it is that branch ownership and lifecycle transitions depend on them in many modules.

### RC7: LLM boundaries are branch-local

Intent, optional vision, main answer, web search, and re-answer are independent calls. Provider fallback can add further upstream calls. Different branches build context differently, so an intent result or evidence gathered earlier is not guaranteed to reach every later answer path in the same shape. Cost and latency are consequences of this ownership split.

### RC8: Tests pin branches more than architecture

There are 93 Python test/audit/replay scripts and 32 TypeScript script tests in the current tree. These tests are valuable evidence, especially for botworker concurrency, but many protect individual incidents and branch behavior. They do not by themselves prove that there is one routing owner, one evidence owner, or one side-effect contract.

The scripts are also not one uniformly safe test suite. Static inventory finds pure unit/contract tests, fake-Mongo tests, import-isolation tests, live DB/provider/replay scripts, data builders, and destructive maintenance tools in the same broad test/script areas. Commands must be classified before execution; a green subset cannot be generalized to the whole system.

### RC9: Documentation contains multiple time layers

SRS, function/process docs, historical plans, rebaseline plan, and two waythrough logs describe different moments. For example, some SRS sections still call modules observe-only while runtime selection is flag-gated; the rebaseline is explicitly proposed rather than implemented. No single document currently distinguishes “live now,” “shadow/provisional,” “planned,” and “retired” for every component.

## 4. The 21 Reported Problems Mapped To Code

| # | Reported concern | Audit status | Evidence / actual root cause |
|---|---|---|---|
| 1 | Trigger/workflow utilization, complexity, nodes, UI | Partial | Workflow supports 1 trigger, 5 conditions, 8 actions, and wait-for-reply with retry/timeout. Trigger is a separate substring engine. Runtime can run workflow then trigger. UI exists, but no usability study or production outcome evidence proves it is optimal. |
| 2 | Deep specs exist but bot says no data and does not really hand off | Confirmed defect | Retrieval can reject/misclassify candidates before LLM. Independently, no-product response sets a handoff flag without issuing the handoff side effect; final guard then skips escalation. |
| 3 | Implicit complexity, nested guards/helpers/keywords | Confirmed structural issue | Multiple decision owners, 833 keyword references, nested helper logic in `_chat_impl`, and many broad exception fallbacks. |
| 4 | High latency, tokens, and cost | Confirmed architectural risk | Optional vision + intent + answer + web search + re-answer can produce five logical calls; provider fallback may add calls. Up to 30 product contexts can reach the answer LLM. No single per-turn budget owner exists. |
| 5 | Fixing one point reopens old defects | Confirmed cause | Additive branch patches and different owners implement similar semantics. Local regression tests pass without removing the competing path. |
| 6 | Multi-source pool and bad KB-to-Mongo append behavior | Confirmed | `_merge_kb_mongo`, KB-only append, device re-query, anchors, grouped-selection prepend, and web replacement are separate merge points. |
| 7 | Stock freshness and unit embeddings | Partial | Unit index is a snapshot, with some live listing refresh/join. Legacy listing reads current catalog data. Because different paths use different freshness rules, current stock truth is not uniform. |
| 8 | Order/history quality | Partial and Shopee-specific | Order lookup is detailed but relies on one configured collection, regex extraction, and shop fallback that may remove the shop filter. There is no implemented Lazada/TikTok order adapter. |
| 9 | Anchor/follow-up weak and hard-coded | Confirmed | Anchor, history references, comparison, superlative, short follow-up, subtype changes, and model carry-forward are spread through large blocks in `app.py` plus `conversation_products` and TurnDecision shadow. |
| 10 | Too many LLM stages; web/re-answer context unclear | Confirmed | Calls are independent boundaries. Web search receives route/intent-derived context in some paths, but KB and product branches integrate it separately and rebuild answer context differently. |
| 11 | Intent reliability and value on every turn | Unproven as a net benefit | Deterministic early paths skip it, but normal legacy product turns call intent. No current ablation report compares quality/cost with and without intent across the real fixture corpus. |
| 12 | Log metrics and 200-300% values | Confirmed formula defect | `response_rate_10min = replyWithin10min / totalConversations`. Numerator counts replies/messages; denominator counts conversations. Multiple replies per conversation can exceed 100%. `resolved` is also derived as total minus closed, which does not match ordinary resolution semantics. |
| 13 | Rating/scoring correctness | Storage works; meaning not validated | Ratings are stored in separate test-chat, test-assignment, and shadow schemas with different units and actors. KPI aggregation combines activities, not one normalized answer-quality denominator. No inter-rater or ground-truth contract proves score validity. |
| 14 | Troubleshooting and real handoff coverage | Partial with confirmed false-success risk | Troubleshooting/claim handlers exist. Handoff transport is best-effort and callers often do not verify success. A response flag can therefore disagree with assignment state. |
| 15 | Round robin/admin selection/time accounting | Partially correct, requirement mismatch | Atomic assignment and three pool modes exist. Existing/previous admin may win before round robin. Admins can hold multiple chats, but `is_accepting_chats=false` excludes them and all-excluded creates pending assignment. Cursor may advance on a lost assignment CAS. |
| 16 | Comparison regressed | Confirmed behavior risk, failure has two layers | Comparison semantics are distributed across intent, anchors, retrieval, prompt notes, and grouped selection. The observed local failure also returned the exact LLM error reply despite legacy retrieval finding products, so provider/LLM failure and candidate routing must be diagnosed separately. |
| 17 | Compatibility needs hard-coded keywords | Confirmed | A large deterministic compatibility engine and device-spec data are useful, but activation, target-device extraction, product-family detection, and follow-up routing still depend on lexical tables in several owners. |
| 18 | Warranty question confused with claim | Confirmed risk | Warranty policy, troubleshooting, claim request, retained claim state, ticket lock, and keyword/history evidence share one large state machine. Phase 2A has strict-xfail incidents and lifecycle blockers. |
| 19 | Certificate/TISI answers wrong despite matching products | Confirmed multi-source risk | Certificate search uses four evidence sources, category/model heuristics, subtype filtering, and fallback to products in other categories. An empty or mis-scoped intermediate set can produce handoff even when another source contains evidence. |
| 20 | Legacy/new/current plans and fallbacks are mixed | Confirmed | Legacy is live; grouped retrieval augments it; TurnDecision is shadow; v2/v3 remain selectable; historical and rebaseline plans coexist. The system has not completed replacement/deletion phases. |
| 21 | Remove v2/v3 | Feasible but not yet done | Both engines are still request/env selectable and documented. They should be removed only after auditing callers/tests/config, then delete code and switches; comments alone would preserve ambiguity. |

Additional defects found while tracing those concerns:

- The dashboard route returns before its cache population block, so the documented 60-second cache never fills; the block is unreachable.
- Dashboard/performance code derives state from raw `conversations` fields even though ticket code names `status_conversation` as the authoritative admin-owned state.
- `lookup_order` and tracking lookup retry without `shop_filter`, which can return another shop's order if identifiers collide or data is malformed.
- `TestChatClient` owns a separate trigger/workflow/chat orchestration path in addition to botworker orchestration, so the test surface is not merely a UI over the production owner.
- The requested UNLIST exception is not explicit at canonical-product level. Individual hidden variants/listings are filtered, but the policy "allow historical evidence only when the same canonical product has a non-UNLIST sibling" has no single enforceable owner.

## 5. Alignment With The Requested Product

| Requirement | Current status |
|---|---|
| Three platforms with separate catalog sources | Not implemented end-to-end; only Shopee runtime exists |
| Shared KB with future shared sources | Present, but merge/evidence ownership is inconsistent |
| Product basics | Implemented but path-dependent |
| Spec comparison table, strengths/weaknesses/use cases | LLM can produce it when evidence reaches the answer boundary; not guaranteed |
| Related-product recommendations | Implemented through retrieval/ranking, but multiple selection owners |
| Compatibility | Broad capability exists; routing is keyword-heavy and fragmented |
| Warranty and claim policy | Implemented, but policy questions and claim lifecycle are not cleanly separated |
| Troubleshooting | Implemented in warranty/compat paths, not one canonical owner |
| Real handoff | Infrastructure exists; response truth is not reliably tied to side-effect success |
| Tax/refund/return/claim data collection | Partial; several paths hand off early, lifecycle semantics remain mixed |
| Bot silent after handoff until admin closes | Implemented through ticket-state lock in major paths; exceptions and state conflation make it non-canonical |
| Admin close means waiting, not necessarily resolved | Not represented correctly; close and lifecycle resolution are conflated |
| Existing round robin, multiple chats per admin | Multiple chats are allowed. Previous-admin preference and accepting toggle mean assignment is not always pure round robin |

## 6. Current Project Position

### Completed foundations

- Legacy replay/import-isolation baseline
- Pure TurnDecision contract and shadow trace
- Context inputs and expanded shadow fixtures
- Phase 2A claim-lifecycle audit/test baseline
- Botworker idempotency, buffer, leadership, error-policy, and real-Mongo smoke work
- `/logs` server-side pagination

### Not completed

- TurnDecision is not production owner
- Phase 2B claim-lifecycle replacement commits are not implemented
- Phase 2C authoritative conversation subjects are not implemented
- Grouped retrieval has not replaced legacy retrieval
- One bounded answer-context/compiler boundary does not exist
- One verified handoff command/result contract does not exist
- Old v2/v3 engines are not removed
- Three-platform chatbot adapters are not implemented
- KPI/rating semantic validation is not complete
- Botworker still awaits real-provider/canary testing and is intentionally paused

## 7. Component Disposition

The next architecture should preserve working evidence and concurrency primitives. It should replace ownership, not rewrite everything.

| Component/capability | Disposition | Reason |
|---|---|---|
| `resolve_availability` and live listing/unit join | Keep and make authoritative | Already distinguishes sellable, out-of-stock, historical/deleted, and hidden states better than branch-local checks |
| Unit index and variant coverage | Keep as a candidate source | It has strong variant/model coverage; embeddings are recall aids, not live stock truth |
| Legacy catalog search | Keep temporarily as another candidate source | It supplies recall/history that the unit pool can miss; it must stop owning final selection |
| KB, catalog, anchor, cert/OCR, web evidence | Normalize into one evidence union | Sources remain useful; branch-local append/prepend/re-query behavior does not |
| Image extraction and certificate/TISI evidence | Keep | Four-source evidence is valuable; it must not independently own routing or availability |
| Conversation history and cached image descriptions | Keep | Avoids rereading images and preserves context; duplicate manual enrichment owners should be removed |
| Workflow graph/run engine | Keep core; redefine precedence | Nodes and idempotency exist, but workflow/trigger/chat ownership and `both` multi-output behavior need one contract |
| Trigger substring engine | Migrate simple cases into workflow/turn policy, then retire overlap | First-match substring routing duplicates workflow and Python routing |
| Assignment CAS and round-robin cursor | Keep core; correct eligibility contract | Supports multiple concurrent chats, but acceptance/pending semantics and cursor advancement need requirement-level decisions |
| Botworker claim/buffer/leadership/error safety | Keep, paused for canary | Strong concurrency evidence exists; it is transport/execution infrastructure, not answer-quality architecture |
| Legacy `_chat_impl` | Migrate one owner at a time, then shrink/delete branches | It contains valuable behavior but is not a maintainable policy owner |
| TurnDecision shadow | Use as contract input only if extended to multi-need plan; do not wire as-is | One action cannot represent compound customer needs or side-effect outcomes |
| Grouped retrieval selection | Promote only by replacing legacy selection in the same change | Current prepend-to-legacy mode preserves duplicate owners |
| Final output guards | Retain only narrow safety assertions | Post-hoc answer rewriting cannot remain the main grounding/handoff mechanism |
| `chat_v2` / `chatbotv3` | Remove with all callers, config, UI, docs, and tests | Keeping selectable dead alternatives preserves ambiguity and regression surface |
| Lazada/TikTok placeholders | Replace with platform adapters when implemented | Empty packages are not runtimes; shared policy should not be copied three times |

### Product policy that the replacement must encode

1. A catalog adapter supplies platform-specific products/orders; KB and policy evidence can be shared.
2. Candidate identity is canonical product plus listing/variant evidence, never display name alone.
3. A product may be discussed when active, out of stock, discontinued, or historically deleted if evidence exists.
4. UNLIST evidence is hidden unless the canonical product has an eligible non-UNLIST listing that justifies discussing the product; hidden listing details remain excluded.
5. Recommendation/sales output contains only currently sellable and in-stock variants/listings.
6. Comparison/spec/history may use non-sellable historical evidence, clearly labelled, without recommending purchase.
7. OCR/image certificate data is evidence attached to a candidate; it never decides the turn or stock state.
8. Handoff success exists only after the assignment/status write succeeds and returns a typed result.
9. After a successful handoff the bot is silent until the admin closes ownership; that close resumes bot ownership but does not resolve an open claim/business episode.
10. Admin assignment permits multiple chats. Any acceptance toggle, previous-admin preference, or pending state must be an explicit approved policy, not an accidental interpretation of "availability."

## 8. What Must Not Happen Next

1. Do not add another router, policy module, or guard beside existing owners.
2. Do not add more case-specific keywords to fix the 21 concerns.
3. Do not wire TurnDecision while it still returns one action and cannot represent multi-intent needs.
4. Do not call a handoff successful from response text or a boolean; require a stored/typed result.
5. Do not treat ticket close as claim resolution.
6. Do not make grouped retrieval default-on while it is still an augmentation merge.
7. Do not delete v2/v3 by commenting them out; delete callers, flags, tests, and modules together after an inventory.
8. Do not expand tests indefinitely without naming which old owner/branch the implementation will delete.

## 9. Recommended Architecture Discussion Order

This is sequencing for the next design discussion, not authorization to code.

1. Define the state model: conversation ownership, waiting-for-customer, claim episode, and terminal business outcome as separate axes.
2. Define one turn-plan contract capable of multiple needs and one side-effect command/result contract.
3. Define platform adapters for catalog, orders, and delivery while keeping shared KB/policy services.
4. Define one evidence schema and one candidate union/selection boundary.
5. Define one bounded LLM answer call and explicit gates for vision, intent, and web enrichment.
6. Decide trigger/workflow ownership relative to the turn planner; eliminate overlapping keyword routers.
7. Define observability units before fixing KPIs: conversation, inbound turn, outbound reply, provider call, and business outcome.
8. Migrate one owner at a time and delete the replaced branch in the same commit.
9. Remove v2/v3 and obsolete flags only after their caller inventory is empty.
10. Run replay/canary gates after owner count and runtime LOC decrease, not merely after new tests pass.

## 10. Evidence Quality And Confidence

Stored result files are not a single current quality baseline:

- `test_200_results.json` contains 220/220 HTTP 401 results and cannot measure answer quality.
- `test_comprehensive_results.json` reports 359/385 correct, but uses an older evaluator and should not be compared directly with current replay/contract gates.
- `openrouter_shadow_results.json` contains 18 cases averaging about 34,923 tokens, USD 0.014, and 11.25 seconds per case. It supports the cost/latency concern but is historical, not a current release benchmark.
- `e2e_batch_10.json` contains 12 cases averaging 9.73 seconds with a 36.3-second maximum.
- Current gold/incident contracts contain 103 retrieval rows and 60 incident rows. They are useful release evidence, but they do not yet cover the full three-platform product requirement.

High confidence:

- engine routing and legacy ownership
- false-success handoff defect
- grouped retrieval augmentation rather than replacement
- Phase 2A/2B status
- KPI numerator/denominator mismatch
- Lazada/TikTok placeholder status
- assignment precedence and state conflation

Still requires targeted evidence before implementation:

- quality/cost ablation for intent on real turns
- exact live stock age and refresh SLA per source
- comparison failure split between provider configuration and answer context
- workflow editor usability with real operators
- rating agreement and ground-truth definition
- desired same-admin versus round-robin policy after a waiting-customer close

## 11. Overall Requirement Verdict

The current repository **does not yet satisfy the requested product end to end**. It has most Shopee capabilities as ingredients, but their ownership and side effects are not reliable enough to call the architecture complete. Lazada/TikTok are not implemented, handoff truth can be false, lifecycle axes are conflated, source union/selection is not singular, metrics use incompatible units, and old engines remain live.

The correct next move is not a greenfield rewrite and not another guard. Preserve the proven adapters/evidence/concurrency components, define the state/turn/evidence/command contracts, migrate one production owner at a time, and delete each replaced path in the same commit. The first implementation package should be the state and handoff command/result contract because it closes the most dangerous customer-visible lie without depending on the later retrieval redesign.
