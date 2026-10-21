# Zaapi Workflow, KB Source, And Evidence Pool Master Plan

**Status:** Approved design backlog; implementation has not started.

**Start gate:** Close and commit Phase 10 first. Do not mix this program with the current Phase 10 working tree.

**Goal:** Extend the existing workflow engine and editor to support the Zaapi node model for Facebook, LINE, TikTok, Shopee, and Lazada; import Zaapi flow graphs without binding external identities; control which evidence sources enter the existing central pool; and switch atomically between the existing legacy KB pipeline and a new Zaapi KB collection.

## 1. Non-Negotiable Architecture

1. Keep `runInboundDispatch` as the single inbound ordering owner: workflow, then trigger, then bot.
2. Keep one workflow engine. New nodes extend `workflowEngine`; they do not create a second runner.
3. Keep one retrieval/evidence pool. Source switches control admission into that pool; they do not create alternate answer paths.
4. Keep the existing legacy KB collections and behavior intact behind one legacy adapter.
5. Add one new Zaapi KB collection and one new adapter that emits the same canonical KB evidence shape.
6. Select exactly one KB backend at runtime: `legacy` or `zaapi`. There is no `both` mode and no silent fallback.
7. If the selected KB backend is unavailable or invalid, fail closed and expose the readiness error. Do not silently read the other KB.
8. Node behavior must be real: config schema, validation, branches, executor, persisted state where needed, idempotency, execution events, and tests.
9. A node whose platform connector does not exist or is not ready must be visibly unavailable and must block publish. Do not simulate success.
10. Reuse `@xyflow/react`, existing workflow persistence, existing assignment/domain services, and existing retrieval owners. Do not add another graph library or duplicate domain logic inside node components.

## 2. Scope

### 2.1 Platforms in the first program

- Facebook
- LINE
- TikTok
- Shopee
- Lazada

Shopify, WhatsApp, and email-specific nodes are excluded from this first program. Shared messaging, ticket, AI, flow-control, and utility nodes used by the five selected platforms remain in scope.

### 2.2 Node families

Implement every applicable node from the supplied Zaapi catalogue in these families:

- Messaging triggers: message received, LINE friend added, data-collection form filled, label added, label removed, incoming webhook.
- Marketplace triggers: review added, order created, order shipped, order delivered, delayed order, payment reminder, order cancelled, return/refund requested, delivery failed, confirm receipt, product interest.
- Message/customer/ticket/time conditions: message content, message language, new/returning customer, customer waiting time, last interaction, conversation assignee, conversation status, label, business hours.
- Marketplace conditions: review rating, review text, AI review sentiment, AI review intent, marketplace products, cancellation reason, return/refund reason.
- Messaging actions: send message and button template for channels that support them; marketplace private reply, order card, and voucher where the platform API supports them.
- Ticket actions: assign, unassign, add/remove label, close, follow-up, internal note, spam.
- Review actions: reply, follow-up, internal note.
- AI action: let AI respond with a knowledge-source scope that may only narrow the central policy.
- Flow-control actions: jump with a hard loop limit and outbound HTTP with an explicit security policy.
- Utility nodes: delay, wait for reply, search conversation, randomizer.

The catalogue is a capability target, not permission to claim unsupported behavior. Each platform/node pair requires a tested event or action adapter before it can be published.

## 3. Canonical Node Registry

Create one registry that owns node metadata and validation:

```text
node type and stable subtype
display metadata
configuration schema
input and output handles
supported platforms
required platform capability
publish-time validation
runtime executor identity
idempotency class
```

The editor palette, API validation, graph compiler, and runtime dispatcher must consume this registry. Avoid separate switch tables in UI, API, and runtime.

Required graph validation:

- one valid trigger per executable entry path;
- edges reference existing nodes and valid output handles;
- branch identifiers are unique per node;
- no unreachable required node;
- jump targets exist and have a finite maximum count;
- waiting nodes persist a resumable checkpoint;
- platform and account bindings are resolved before publish;
- unavailable platform capabilities block publish;
- cyclic execution cannot bypass the runtime step ceiling.

## 4. Zaapi Flow Import Without External Bindings

The supplied flow contains six nodes and five edges:

```text
message received
-> delay 9 minutes
-> business hours
-> customer waiting time greater than 8 minutes
-> conversation assignee exclusion
-> round-robin team assignment
```

Import process:

```text
upload JSON
-> validate supported export shape
-> read flow name, nodes, positions, edges, handles, and portable config
-> generate local workflow/node/edge IDs
-> retain original IDs only in import audit metadata
-> remove account, shop, user, and team bindings from executable config
-> save as draft with unresolved bindings
-> validate mappings later
-> dry-run/replay
-> publish
```

Portable data:

- flow name and description;
- node types and portable configuration;
- node positions;
- edges, output handles, and branch order;
- delay durations and comparison rules.

External data that must become unresolved bindings:

- Zaapi workflow/version IDs;
- account and channel IDs;
- shop/platform selections;
- user/admin IDs;
- team IDs;
- external URLs and credentials.

The imported draft must be viewable and editable before any shop or platform is assigned. It must not execute or publish while required bindings are unresolved.

## 5. Workflow Editor UX

Extend the existing React Flow editor rather than rebuilding it:

- left node library grouped as Trigger, Condition, Action, and Utility, with search and platform availability;
- central pannable/zoomable canvas with drag, multi-select, connect, delete, duplicate, snap, and persisted positions;
- clear labelled output handles for true/false, no-match, timeout, escalation, buttons, and weighted routes;
- right inspector for selected-node configuration, validation, account/team mapping, and capability status;
- top toolbar for workflow name, draft/published state, undo/redo, validate, dry-run, save, and publish;
- execution trace showing node status, chosen branch, timestamps, error, and idempotency result;
- optimistic version/CAS on save so two admins cannot silently overwrite the same graph;
- responsive fallback that remains editable on common laptop sizes; mobile may be view-only if the canvas cannot remain safely operable.

## 6. Runtime Semantics

- Trigger events enter through existing platform/event adapters and the existing dispatch boundary.
- Conditions are deterministic and return typed branch identifiers.
- Actions call existing assignment, ticket, messaging, review, trigger, or bot domain services; nodes do not write those collections directly.
- Delay and wait-for-reply persist checkpoints in `workflow_runs`; do not use process-memory timers as authority.
- Every side-effecting action uses a deterministic operation key per workflow run and node execution.
- Resume uses lease/fencing rules and may execute each operation at most once under the persisted operation contract.
- Randomizer persists the selected branch so retries cannot choose another branch.
- Business hours use an explicit timezone and calendar configuration.
- HTTP nodes require an allow/deny policy, bounded timeout/body, redacted logs, and no secret in workflow JSON.
- Execution events feed the later logging and analytics program without creating another behavior owner.

## 7. Central Evidence Pool Switches

Create one central source policy that controls which source adapters may contribute evidence:

```yaml
pool_sources:
  kb: true
  mongo_catalog: true
  units: true
  image_text: true
```

Semantics:

- An OFF source is not queried and contributes zero candidates.
- An ON source still passes through its existing eligibility, scope, and readiness rules.
- Enabled source outputs enter the existing source union and canonical candidate pool.
- Ranking, deduplication, need selection, answer context, and finalization remain single-owner paths.
- A workflow `let_ai_respond` node may narrow the enabled set for that run, but cannot enable a source disabled by the central policy.
- Source policy changes are audited and versioned.

The effective source set is:

```text
central pool policy
INTERSECT optional workflow-node scope
INTERSECT source readiness/platform eligibility
```

## 8. Strict Legacy/Zaapi KB Selection

The KB controls are separate from the central pool switches:

```yaml
pool_sources:
  kb: true

kb_source: legacy | zaapi
```

Truth table:

| `pool_sources.kb` | `kb_source` | Runtime behavior |
|---|---|---|
| OFF | any value | Query no KB collection and contribute no KB evidence |
| ON | `legacy` | Run the existing multi-collection legacy KB pipeline unchanged |
| ON | `zaapi` | Query only the new Zaapi KB collection through the new adapter |

There is no `both` mode. Selecting Zaapi must not read legacy KB as a fallback, and selecting legacy must not read the Zaapi collection.

### 8.1 New Zaapi KB collection

Use one dedicated collection with a canonical document contract covering at least:

- local record ID;
- stable external source record ID;
- title/question and answer/content;
- platform/shop applicability where supplied;
- tags/category/language;
- source revision and import batch;
- content fingerprint;
- active/readiness status;
- created/updated/imported timestamps;
- embedding generation reference where semantic retrieval is required.

The importer must be dry-run first, idempotent by stable source identity and fingerprint, versioned, reversible, count additions/updates/deactivations, and never delete legacy KB collections.

### 8.2 Atomic switching and readiness

- Default existing installations to `legacy` so current behavior does not change during migration.
- Import and validate Zaapi KB while `legacy` remains active.
- Block switching to `zaapi` until schema, indexes, required embeddings, and a retrieval smoke test pass.
- Change `kb_source` atomically through the existing system-config owner and audit the actor/revision.
- If the selected backend later becomes unavailable, fail closed with an observable readiness error; do not silently switch back.
- Rollback is one audited switch from `zaapi` to `legacy`; no data migration is needed.

## 9. Delivery Workstreams

### Workstream A: Contracts and capability matrix

- Freeze Phase 10 first.
- Inventory existing workflow nodes, events, platform connectors, domain services, and KB readers.
- Map every in-scope Zaapi node to each platform as supported, unavailable, or requiring a new adapter.
- Define node registry, graph schema version, binding model, operation keys, and execution events.
- Produce executable contract tests before runtime changes.

### Workstream B: Registry, compiler, and runtime

- Introduce the canonical node registry.
- Migrate existing nodes without behavior change.
- Add graph validation and typed branch outputs.
- Implement persistent delay/wait, assignment, randomizer, jump limits, and execution tracing.
- Preserve `runInboundDispatch` ownership.

### Workstream C: Editor and import

- Redesign the existing editor around the registry.
- Add binding/readiness validation and CAS saves.
- Build the Zaapi JSON preview/import path.
- Import the supplied six-node flow as an unresolved draft.
- Add dry-run/replay and publish gates.

### Workstream D: Platform adapters and real nodes

- Implement and verify shared messaging/ticket nodes first.
- Implement Facebook and LINE messaging/event adapters.
- Implement Shopee, Lazada, and TikTok event/action adapters available under approved APIs.
- Add marketplace order/review triggers, conditions, and actions only when their authoritative events/actions are available.
- Keep unsupported platform/node pairs disabled until their real adapter tests pass.

### Workstream E: Pool and KB controls

- Add central pool source policy to the existing config owner and admin UI.
- Apply source admission before each adapter fetch.
- Wrap legacy KB behind one adapter without changing its internals.
- Add the new Zaapi KB collection, indexes, importer, readiness check, and adapter.
- Add strict `legacy | zaapi` selection with no `both` and no implicit fallback.
- Allow `let_ai_respond` to narrow, never widen, source policy.

### Workstream F: Verification and rollout

- Contract tests for every node and branch.
- Graph import round-trip and unresolved-binding tests.
- Runtime retry/idempotency, crash-resume, delay, timeout, randomizer, and loop-ceiling tests.
- Per-platform connector tests with provider leaves mocked, followed by authorized sandbox tests.
- Pool truth-table and strict KB-selection tests, including proof that the inactive backend receives zero reads.
- Editor interaction and responsive visual tests.
- One-shop/one-platform canary before broader activation.

## 10. Acceptance Gates

The program is complete only when:

1. Every in-scope node is either executable on a platform with tests or explicitly unavailable and unpublishable for that platform.
2. The supplied Zaapi flow imports with the same graph and behavior, but no external account/user/team ID becomes an executable local identity.
3. The imported flow can remain an unbound draft and cannot publish until mappings are complete.
4. Existing workflows continue to execute through the same engine and dispatch owner.
5. Every pool switch proves the disabled source receives zero reads.
6. `kb_source=legacy` proves zero reads to the Zaapi collection.
7. `kb_source=zaapi` proves zero reads to all legacy KB collections.
8. Switching KB does not delete, rewrite, or merge either dataset.
9. A failed Zaapi KB readiness check cannot activate Zaapi and cannot silently fall back to legacy.
10. Workflow side effects are idempotent across retry, worker restart, lease recovery, and duplicate inbound events.
11. UI save conflicts are visible and cannot silently overwrite another admin's graph.
12. Logs identify workflow/run/node/branch/source without recording credentials or customer secrets unnecessarily.

## 11. Estimated Schedule

Assumptions: one experienced engineer, existing APIs and test credentials are available, provider review time is excluded, and Phase 10 is closed before starting.

| Milestone | Estimated elapsed work |
|---|---:|
| Contracts, inventory, capability matrix | 3-5 working days |
| Registry, graph validation, runtime foundations | 7-12 working days |
| Editor redesign and Zaapi graph import | 7-12 working days |
| Central pool switches and strict KB selector | 4-7 working days |
| Zaapi KB collection/import/readiness/adapter | 5-8 working days after receiving the KB export |
| Shared messaging/ticket/utility nodes | 7-12 working days |
| Five-platform real connector/event/action coverage | 20-40 working days, strongly dependent on API access |
| Regression, security review, sandbox tests, canary | 5-10 working days |

**Sequential total:** approximately 10-16 working weeks for the full five-platform, real-node scope.

**With three isolated teams/worktrees after contracts freeze:** approximately 6-9 weeks, split into workflow runtime/editor, platform adapters, and KB/pool. Shared schema, roadmap, and waythrough edits must remain owned by one integration track.

**First useful delivery:** approximately 2-3 weeks for the supplied six-node flow working as a draft/sandbox flow plus the central pool switches, assuming it initially targets capabilities already present in the repository.

The largest uncertainty is not the editor. It is real event and action access for Facebook, LINE, TikTok, Shopee, and Lazada. Missing credentials, webhook subscriptions, review/order APIs, or send permissions block a truthful executable node regardless of UI completion.

## 12. Execution Order

This program is part of a larger ordered backlog. The order below is authoritative for sequencing unless the user explicitly changes it.

### Stage 1: Close the current rebaseline safely

1. Final independent review of Phase 10A.
2. Commit Phase 10A runtime/tests/docs separately from its active-log closeout.
3. Keep this Zaapi master plan and its active-log pointer out of the Phase 10A implementation commit.
4. Run the one-shop grouped-pipeline canary with grouped flags controlled and web search OFF by default.
5. Close remaining Phase 8 activation work: unmigrated item-tag/spec/web-enriched boundaries, shared finalizer responsibilities, evidence-scoped numeric/unit/certificate checks, and the residual-prose blocker.
6. Remove the legacy fallback and obsolete wrappers only after canary acceptance; retain rollback notes and an accepted baseline.
7. Distill the system prompt after the typed boundary/finalizer is authoritative; measure exact payload, answer-call count, median/p95 tokens, latency, and cost before and after.

### Stage 2: Complete operational readiness

8. Finish Phase 4B operator setup: first manual refresh, generation verification, timing/cost evidence, then the 09:00 schedule and old-generation cleanup policy.
9. Supply and validate the production structured policy records required by Phase 5 before policy activation.
10. Implement Logging and Analytics Truth in order:
   - Analytics Truth for the three pages with one window/timezone contract and authoritative queries;
   - Audit Event Correctness with one action vocabulary and idempotent command events;
   - Provider/Cost Observability with actual provider/model, safe key reference, tokens, cost, latency, attempt, outcome, and turn correlation.
11. Complete the Botworker production canary gates: enforced cost stop, concurrency 1, one-shop admission, forced stop, restart/recovery evidence, and deployment approval.
12. Schedule database/writer maintenance separately: external writer corrections, duplicate cleanup, uniqueness/index verification, and inbound-lifecycle wiring. No production cleanup runs merely because application code is ready.

### Stage 3: Add the Zaapi KB and pool controls

13. Freeze the central source-policy and strict KB-selection contracts from this plan.
14. Add pool admission switches for `kb`, `mongo_catalog`, `units`, and `image_text` before source fetch.
15. Wrap the existing multi-collection legacy KB pipeline behind the unchanged legacy adapter.
16. Add the new Zaapi KB collection, dry-run importer, indexes, readiness checks, and canonical adapter after receiving the actual KB export.
17. Add the atomic `kb_source: legacy | zaapi` switch, prove zero reads to the inactive backend, and canary the Zaapi dataset before wider use.

### Stage 4: Expand workflow capability

18. Freeze the node capability matrix for Facebook, LINE, TikTok, Shopee, and Lazada.
19. Implement the canonical node registry, graph validation, runtime contracts, persisted waits, idempotency, and execution events.
20. Redesign the existing `@xyflow/react` editor and add import preview, unresolved bindings, CAS save, dry-run, and publish gates.
21. Import the supplied six-node Zaapi flow as a local unbound draft, then map shops/platforms/admins/teams and verify equivalent replay behavior.
22. Implement shared messaging, ticket, utility, AI, and flow-control nodes.
23. Implement real platform adapters and marketplace event/action nodes by verified API capability; unavailable platform/node pairs remain unpublishable.
24. Run per-platform sandbox tests, then one-shop canaries, then final integration and activation review.

### Parallelism rule

- Do not parallelize Phase 10/Phase 8 chatbot-flow edits against the same working tree.
- After contracts freeze, Logging/Analytics UI/query work, Zaapi KB import work, and workflow editor work may run in isolated branches/worktrees when they do not modify the same schema/config owners.
- Platform adapters may run in separate worktrees per platform after the node registry contract is frozen.
- One integration owner controls shared schema, system-config fields, canonical roadmap, SRS, and active waythrough updates.
