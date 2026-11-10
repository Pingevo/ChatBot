# Zaapi Workflow, KB Source, And Evidence Pool Master Plan

**Status:** Approved design backlog, rebaselined against the complete Zaapi export on 2026-10-22; implementation has not started.

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

### 1.1 Raw + Canonical ownership (approved 2026-10-27)

Zaapi input uses a two-layer contract:

```text
Zaapi export -> immutable raw snapshot -> validated canonical records -> runtime
```

- Raw snapshots preserve the imported payload, source IDs, source revision, content fingerprint, and fields that cannot yet be normalized. They are audit/import/export evidence and never become executable authority.
- Canonical workflow, node, edge, binding, and KB records are the only runtime authority.
- Import generates local IDs. Zaapi account, shop, workflow, version, user, team, label, and ticket-field IDs remain source metadata until explicitly mapped.
- Unsupported nodes and unknown KB shapes remain inspectable with their raw provenance, but stay disabled/unready and cannot publish silently.
- Export supports a canonical portable package, a sanitized raw-source package, and a Zaapi-compatible projection for fields that have a proven reverse mapping. Export never includes credentials or secrets.
- Import and export are versioned, fingerprinted, dry-run capable, and covered by round-trip tests. Canonical export is the lossless application backup; Zaapi-compatible export is not allowed to claim lossless round-trip for unsupported fields.

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

### 2.3 Verified Zaapi package baseline

The implementation scope is based on the read-only export at `/Users/itdev4/Downloads/zaapi`, not on a single example flow. The verified baseline is:

| Export area | Verified contents | Planning consequence |
|---|---:|---|
| Active custom flows | 21 | Import every flow as a disabled local draft |
| Flow graph | 218 nodes / 225 edges | Preserve graph shape, positions, handles, and branch order |
| Node types used by those flows | 31 | First executable node wave; all are exercised by real exported graphs |
| Applicable five-platform catalogue | approximately 56 node types | Capability target after the 31 used types; unsupported pairs stay unavailable |
| Basic Automations | 4 total / 1 active | Import separately as disabled draft and report overlap with custom flows |
| Active KB sources | 118 (113 XLSX / 5 TXT) | Import through one new Zaapi KB backend; do not mix with legacy KB |
| KB source-account bindings | 899 | Convert to unresolved local bindings; never copy account IDs as authority |
| Active Scenario Handling records | 53 / 1,882 account links | Import as inert instruction drafts and map to an existing behavior owner |
| Active AI personalities | 11 / 86 account links | Map to the existing persona owner after account/shop binding |
| Lookup records | 92 accounts, 21 labels, 2 teams, 6 users, 3 ticket fields | Use only for mapping UI and import audit; regenerate local identities |

All 31 node types present in the node-type lookup are used by at least one exported flow. The export also contains overlapping triggers, label-trigger chains, small-channel exceptions, and flows whose names contain wording such as "ยังไม่ใช้" despite being active. Import and publish decisions must use structured status fields and validation, never names.

The package contains external account IDs, people/team references, and public object URLs. Raw exports are migration input, not application source; do not commit the package wholesale or log its identifiers.

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

Import all 21 active custom flows and the one active Basic Automation. Every imported artifact starts as a disabled local draft, even when the Zaapi source says it is active. Import preserves portable behavior but does not grant executable local identity or provider capability.

Import process:

```text
upload JSON
-> validate supported export shape
-> read flow name, nodes, positions, edges, handles, and portable config
-> generate local workflow/node/edge IDs
-> retain original IDs only in import audit metadata
-> remove account, shop, user, and team bindings from executable config
-> save as disabled draft with unresolved bindings
-> detect trigger overlap, label-trigger chains, and Basic Automation conflicts
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

Import audit metadata must preserve source workflow/version IDs, source revision, content fingerprint, import batch, imported timestamp, and structural warnings. It must not treat those values as local executable IDs.

The imported draft must be viewable and editable before any shop or platform is assigned. It must not execute or publish while required bindings are unresolved, required nodes are unavailable, graph validation fails, or a trigger conflict is unreviewed.

### 4.1 Canonical workflow persistence and export

Use the existing workflow persistence as the runtime owner and add only the import/version/binding records required by the approved Raw + Canonical contract:

| Record | Responsibility |
|---|---|
| `workflows` | Local workflow identity, name, lifecycle state, current draft/published version |
| `workflow_versions` | Canonical nodes, edges, handles, layout, schema version, immutable version fingerprint |
| `workflow_runs` | Runtime state, wait/resume checkpoint, lease/fencing, terminal result |
| `workflow_events` | Node start/result/error/branch/idempotency trace |
| `workflow_bindings` | Explicit local platform/shop/account/team/user/label/ticket-field mappings |
| `workflow_import_batches` | Import source, counts, warnings, errors, fingerprint, actor, timestamps |
| `workflow_raw_snapshots` | Sanitized original Zaapi payload/reference; audit and raw re-export only |

Workflow import/export requirements:

- `dry-run import` validates package shape, graph integrity, node support, conflicts, and unresolved bindings without writes;
- `apply import` is idempotent by source identity + revision + content fingerprint and creates disabled local drafts;
- canonical export includes schema version, workflow/version metadata, nodes, edges, positions, handles, portable config, and unresolved binding requirements;
- Zaapi-compatible export includes only fields with a tested reverse mapping and reports omitted/unsupported fields explicitly;
- raw export returns the sanitized original snapshot and manifest without credentials;
- re-importing an unchanged canonical export produces no duplicate workflow/version/node/edge records.

### 4.2 Export data ownership

Do not place every Zaapi export into KB or append it wholesale to the system prompt. Route each data family to one owner:

| Zaapi data | Local owner | Initial state |
|---|---|---|
| 21 custom flows | Existing `workflows` persistence and `workflowEngine` | Disabled drafts |
| 1 active Basic Automation | Existing workflow model with import-kind metadata | Disabled draft with overlap warning |
| 118 knowledge sources | New Zaapi KB collection and adapter | Imported but inactive while `kb_source=legacy` |
| 53 Scenario Handling records | Inert scenario-instruction records | Unbound drafts; each must map to policy, workflow, handoff, or typed answer-task owner before activation |
| 11 AI personalities | Existing persona owner | Unbound drafts until shop/account mapping is complete |
| Accounts, labels, teams, users, ticket fields | Binding registry/import audit | Unresolved mappings; never direct local authority |

"Import all" means preserve every supplied record with provenance and report unsupported or unresolved items. It does not mean enable all records, execute all flows, or inject all instructions into every prompt.

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

The 118 source files do not share one spreadsheet schema. The verified export contains at least 17 header signatures across product detail, Q&A, stock, links, warranty, promotion, and wide model-spec workbooks. All 113 XLSX files pass ZIP integrity, but the installed `openpyxl` parser cannot load 65 files because of OOXML compatibility differences. Therefore the existing legacy workbook importer must not be reused unchanged and the Zaapi importer must not assume one fixed header layout.

Required import pipeline:

```text
manifest/hash verification
-> robust XLSX/TXT extraction into raw source rows
-> preserve source ID, sheet, row, column labels, and import provenance
-> classify supported record shape without filename keyword authority
-> normalize only fields proven by that source shape
-> validate canonical Zaapi KB documents
-> dry-run additions/updates/deactivations/errors
-> write idempotently by stable source ID + revision + fingerprint
-> build required indexes/embeddings/readiness evidence
-> allow audited backend switch
```

The importer must retain an inspectable raw representation for fields that cannot be normalized safely. A malformed or unsupported workbook is an import error for that source, not permission to discard it silently or infer values from the filename.

### 8.2 Canonical KB persistence and import/export

Use separate Raw + Canonical records:

| Record | Responsibility |
|---|---|
| `zaapi_kb_import_batches` | Package/source hashes, dry-run/apply counts, additions, updates, deactivations, unsupported rows, errors, actor, timestamps |
| `zaapi_kb_raw_sources` | Source file identity, sheet/row/header provenance, raw extracted values, source revision/fingerprint |
| `zaapi_kb_records` | Validated canonical records queried by the Zaapi KB adapter |
| `zaapi_kb_embedding_generations` | Immutable semantic-retrieval generation, artifact digest, readiness and active pointer |

Canonical `zaapi_kb_records` must cover:

```yaml
record_id: local stable ID
source:
  system: zaapi
  source_id: stable external source ID
  revision: source revision
  import_batch_id: local import batch
  file_name: audit display only
  sheet: optional sheet name
  row: optional source row
  fingerprint: normalized content hash
content:
  record_type: qa | product_fact | policy | troubleshooting | promotion | link | free_text
  title: optional title/question
  body: canonical answer/content
  structured: validated type-specific values only
scope:
  platforms: []
  shops: []
  products: []
  language: th | en | mixed | unknown
  tags: []
status:
  active: boolean
  readiness: ready | unsupported | invalid | disabled
  error_codes: []
embedding:
  generation_id: optional immutable generation
timestamps:
  source_updated_at: optional source timestamp
  imported_at: import timestamp
  updated_at: local update timestamp
```

The schema stores source filenames for audit only; filenames, free-text keywords, or guessed IDs never determine record type, shop, platform, product identity, or policy semantics. Shape classification must come from validated source structure or an explicit import mapping.

KB import/export requirements:

- dry-run first, then idempotent apply by source ID + revision + fingerprint;
- preserve every source as imported, unchanged, unsupported, or failed with a reason;
- canonical export supports JSONL/JSON plus a standard XLSX projection and manifest;
- raw export preserves the sanitized source package and provenance;
- rollback deactivates/reverts one import batch without deleting legacy KB;
- switching `kb_source` is separate from import and requires readiness/index/embedding/retrieval-smoke evidence.

### 8.3 Atomic switching and readiness

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
- Freeze import-audit, unresolved-binding, scenario/persona ownership, and KB-record contracts.
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
- Build the Zaapi JSON preview/import path with import batches and structural conflict reports.
- Import all 21 custom flows and the active Basic Automation as disabled unresolved drafts.
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
- Add the new Zaapi KB collection, indexes, multi-shape XLSX/TXT importer, readiness check, and adapter.
- Add strict `legacy | zaapi` selection with no `both` and no implicit fallback.
- Allow `let_ai_respond` to narrow, never widen, source policy.

### Workstream F: Scenario, persona, and binding migration

- Import Scenario Handling records as inert drafts with source provenance.
- Classify each scenario into an existing authoritative owner: policy, workflow, handoff, or typed answer task.
- Reject activation when a scenario has no owner or would introduce a parallel prose/keyword decision path.
- Import personalities into the existing persona owner with unresolved account/shop bindings.
- Map accounts, shops, labels, teams, users, and ticket fields explicitly; never infer identity from display names alone.
- Produce a completeness report for imported, mapped, unsupported, and unresolved records.

### Workstream G: Verification and rollout

- Contract tests for every node and branch.
- Graph import round-trip and unresolved-binding tests.
- Runtime retry/idempotency, crash-resume, delay, timeout, randomizer, and loop-ceiling tests.
- Per-platform connector tests with provider leaves mocked, followed by authorized sandbox tests.
- Pool truth-table and strict KB-selection tests, including proof that the inactive backend receives zero reads.
- Import completeness tests for 21 flows, 218 nodes, 225 edges, 118 KB sources, 53 scenarios, 11 personalities, and one active Basic Automation.
- Conflict tests for overlapping message triggers, label-trigger chains, duplicated side effects, and source-active flows whose names imply otherwise.
- Editor interaction and responsive visual tests.
- One-shop/one-platform canary before broader activation.

## 10. Acceptance Gates

The program is complete only when:

1. Every in-scope node is either executable on a platform with tests or explicitly unavailable and unpublishable for that platform.
2. All 21 active custom flows import with 218 nodes and 225 edges preserved, while every imported workflow/node/edge receives a local ID.
3. The one active Basic Automation imports separately and overlapping trigger/side-effect behavior is reported before publish.
4. No external account/shop/user/team/label/ticket-field ID becomes an executable local identity without an explicit local mapping.
5. Every imported flow can remain an unbound disabled draft and cannot publish until mappings, capabilities, conflicts, and graph validation pass.
6. All 118 KB sources appear in an import report as imported, unchanged, unsupported, or failed with a reason; none disappear silently.
7. Every Scenario Handling record has provenance and remains inert until assigned to exactly one existing authoritative behavior owner.
8. Every personality remains inactive until its local shop/account binding is resolved through the existing persona owner.
9. Existing workflows continue to execute through the same engine and dispatch owner.
10. Every pool switch proves the disabled source receives zero reads.
11. `kb_source=legacy` proves zero reads to the Zaapi collection.
12. `kb_source=zaapi` proves zero reads to all legacy KB collections.
13. Switching KB does not delete, rewrite, or merge either dataset.
14. A failed Zaapi KB readiness check cannot activate Zaapi and cannot silently fall back to legacy.
15. Workflow side effects are idempotent across retry, worker restart, lease recovery, and duplicate inbound events.
16. UI save conflicts are visible and cannot silently overwrite another admin's graph.
17. Logs identify workflow/run/node/branch/source/import batch without recording credentials or customer secrets unnecessarily.
18. The 31 node types used by imported flows pass contract/replay tests before any imported workflow can publish; remaining applicable catalogue nodes may follow only as verified capability increments.

## 11. Estimated Schedule

Assumptions: one experienced engineer, existing APIs and test credentials are available, provider review time is excluded, and Phase 10 is closed before starting.

| Milestone | Estimated elapsed work |
|---|---:|
| Export intake, contracts, capability and conflict matrix | 4-6 working days |
| Central pool switches and strict KB selector | 4-7 working days |
| Zaapi KB collection, multi-shape importer, readiness, adapter | 8-15 working days |
| Workflow importer for 21 flows + Basic Automation | 5-8 working days |
| Registry, graph validation, runtime foundations | 8-14 working days |
| First 31 used node types and shared messaging/ticket/utility behavior | 10-18 working days |
| Editor redesign, bindings, trace, CAS, dry-run/publish gates | 8-14 working days |
| Scenario/persona migration and binding reconciliation | 5-10 working days |
| Remaining applicable catalogue nodes | 8-15 working days |
| Five-platform real connector/event/action coverage | 20-40 working days, strongly dependent on API access |
| Regression, security review, sandbox tests, canary | 5-10 working days |

**Sequential total:** approximately 14-22 working weeks for the complete export, full applicable catalogue, and truthful five-platform adapter scope.

**With isolated teams/worktrees after contracts freeze:** approximately 9-14 weeks, split into workflow runtime/editor, platform adapters, and KB/pool. Shared schema, roadmap, SRS, config owners, and waythrough edits must remain owned by one integration track. The user has currently chosen sequential work, so this is planning information rather than authorization to parallelize.

**First useful delivery:** approximately 3-5 weeks after Phase 10 closes for pool switches, strict legacy/Zaapi KB selection, a dry-run import report for all 118 KB sources, and all 21 workflows visible as disabled unresolved drafts. This delivery does not imply five-platform execution is ready.

### Delivery horizons (scope must not be conflated)

| Horizon | Honest deliverable | Estimate |
|---|---|---:|
| Emergency foundation | Freeze Raw + Canonical schemas, Web Search default-OFF contract, pool/KB switch contract, import/export manifests, and run a no-write census/dry-run against the supplied package | 2 working days |
| First usable KB delivery | New Zaapi KB Raw + Canonical import, strict `legacy | zaapi` switch, pool admission, import/export, readiness checks, and local canary; workflows remain imported disabled drafts | 2-4 working weeks |
| First useful workflow delivery | All 21 flows imported/editable, registry/runtime/editor ready for the 31 used node types that have real supported adapters, unresolved pairs visibly blocked | 6-10 working weeks |
| Complete approved program | Approximately 56 applicable node types, truthful five-platform connectors, full import/export, scenario/persona migration, security/regression/canary | 14-22 working weeks sequentially |

The two-day horizon does not include importing all 118 heterogeneous KB sources into production-ready canonical records, implementing the 31 used workflow nodes, completing the editor, or enabling five-platform actions. Claiming those outcomes in two days would require silent data loss, simulated node success, or unverified platform behavior and is therefore outside the approved design.

The largest uncertainty is not the editor. It is real event and action access for Facebook, LINE, TikTok, Shopee, and Lazada. Missing credentials, webhook subscriptions, review/order APIs, or send permissions block a truthful executable node regardless of UI completion.

## 12. Execution Order

This program is part of a larger ordered backlog. The order below is authoritative for sequencing unless the user explicitly changes it.

### Stage 0: Finish and isolate the current work

1. Finish Phase 10B r12 root-cause work, complete its focused and regression verification, review it independently, and commit runtime/tests/docs separately from the active-log closeout.
2. Do not stage, commit, or merge this Zaapi plan update with the Phase 10B implementation commit. The Zaapi program starts from a clean reviewed state.

### Stage 1: Freeze shared contracts

3. Freeze the node registry, graph schema/version, import audit metadata, unresolved binding types, deterministic operation keys, execution-event shape, Zaapi KB document shape, central pool policy, and strict `legacy | zaapi` selector.
4. Produce a capability matrix for the 31 node types used by the 21 flows, then the remaining applicable five-platform catalogue. Each platform/node pair is `supported`, `unavailable`, or `requires_adapter`; there is no implicit support.
5. Produce import conflict rules for overlapping message triggers, label-trigger chains, Basic Automation overlap, timezone preservation, duplicate side effects, and source-active flows with misleading names.

### Stage 2: Add central pool controls and Zaapi KB safely

6. Add source-admission switches for `kb`, `mongo_catalog`, `units`, and `image_text` before any source fetch, with zero-read tests for disabled sources.
7. Wrap the current multi-collection KB behavior behind the unchanged legacy adapter and add the atomic `kb_source: legacy | zaapi` setting with no `both` and no silent fallback.
8. Build the Zaapi KB dry-run importer for all 118 sources: verify hashes, extract XLSX/TXT robustly, retain raw provenance, normalize only supported shapes, and report additions/updates/deactivations/errors.
9. Create the new Zaapi KB collection/index/readiness contract, import all valid sources idempotently, and build required embedding/readiness artifacts while `kb_source=legacy` remains active.
10. Verify retrieval parity and prove the inactive KB backend receives zero reads. Do not switch production traffic yet.

### Stage 3: Import workflows before enabling behavior

11. Build the workflow/Basic Automation importer and import all 21 active flows plus the one active Basic Automation as disabled local drafts with regenerated local IDs.
12. Preserve 218 nodes, 225 edges, positions, handles, branch ordering, and portable config; store external IDs only as audit metadata and unresolved bindings.
13. Generate completeness and conflict reports. A count mismatch, unsupported shape, unresolved required binding, or unreviewed conflict blocks publish but does not discard the draft.

### Stage 4: Make the imported graphs executable

14. Implement/migrate the 31 node types actually used by the imported flows through the single registry and existing `workflowEngine`; retain `runInboundDispatch` as the sole inbound ordering owner.
15. Add persisted waits, deterministic operation keys, crash/retry idempotency, randomizer branch persistence, jump/step ceilings, and execution events.
16. Extend the existing `@xyflow/react` editor with registry-driven palette/configuration, unresolved-binding UI, capability status, validation, CAS save, dry-run, publish gates, and execution trace.
17. Map local shops/platforms/admins/teams/labels/ticket fields explicitly and replay imported flows against the export to prove branch equivalence.
18. Import Scenario Handling records as inert drafts and map each record to exactly one existing policy/workflow/handoff/typed-answer owner. Import personalities through the existing persona owner. Nothing activates from text/name matching alone.
19. Implement the remaining applicable catalogue node types after the 31 used types are stable; each node/platform pair remains unavailable until its executor and adapter tests pass.

### Stage 5: Real platform capability and canaries

20. Implement real shared messaging/ticket capabilities, then verified Facebook and LINE adapters, followed by Shopee, Lazada, and TikTok marketplace capabilities allowed by available APIs.
21. Run offline contracts, import round-trip, crash/retry, and UI tests; then authorized provider sandbox tests and one-shop/one-platform canaries.
22. Canary `kb_source=zaapi` only after readiness, retrieval truth, inactive-backend zero-read, and rollback-switch tests pass. Roll back by audited selector change, never by deleting data.
23. Activate flows incrementally only after mappings and conflict reviews pass. Import completion is not activation approval.

### Stage 6: Remaining ordered backlog

24. Distill the system prompt after the typed answer boundary/finalizer and Phase 10 activation behavior are authoritative; measure exact payload size, answer-call count, median/p95 tokens, latency, and cost before and after.
25. Finish Phase 4B operator setup: first manual image-text/embedding refresh, generation verification, timing/cost evidence, 09:00 schedule, atomic generation switch, and old-generation cleanup policy.
26. Supply and validate the production structured policy records required by Phase 5 before policy activation.
27. Complete Botworker production canary gates: enforced cost stop, concurrency 1, one-shop admission, forced stop, restart/recovery evidence, and deployment approval.
28. Schedule database/writer maintenance separately: external writer corrections, duplicate cleanup, uniqueness/index verification, and inbound-lifecycle wiring. No production cleanup runs merely because application code is ready.
29. Implement Logging and Analytics Truth last, as explicitly prioritized by the user:
   - Analytics Truth for the three pages with one window/timezone contract and authoritative queries;
   - Audit Event Correctness with one action vocabulary and idempotent command events;
   - Provider/Cost Observability with actual provider/model, safe key reference, tokens, cost, latency, attempt, outcome, and turn correlation;
   - Workflow/import observability from the execution and import events defined earlier, without creating a second behavior owner.

### Parallelism rule

- Do not parallelize Phase 10/Phase 8 chatbot-flow edits against the same working tree.
- The current user decision is sequential execution; do not start parallel work without a new explicit approval.
- If parallelism is later approved, it starts only after shared contracts freeze and uses isolated branches/worktrees with disjoint ownership.
- Platform adapters may run in separate worktrees per platform after the node registry contract is frozen.
- One integration owner controls shared schema, system-config fields, canonical roadmap, SRS, and active waythrough updates.
