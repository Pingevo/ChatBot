# Zaapi Workflow Runtime Design

Status: Approved design — implementation not started
Branch: codex/zaapi-workflow-foundation
Baseline: ba7f5b9

This document is the canonical approved design for moving the Zaapi imported-draft
persistence foundation (`3193fd7`, `ba7f5b9`) to a safe runtime. It is the output of
the design-audit rounds in this session (Design V1 → corrected V2 → approved V3 with
three mandatory binding clarifications). No runtime code is implemented yet.

---

## 1. Existing runtime owners and fixed inbound order

| Owner | File | Role |
|---|---|---|
| Inbound dispatch (sole) | `workflowEngine.runInboundDispatch` | Fixed order: `runInboundWorkflowStage` (active resume → new match) → `matchTrigger` → `botFallback` leaf. Callers: `botWorkerService.processClaimedMessage`, `/api/test-chat/dispatch` |
| Graph traversal / run state | `workflowEngine` | `walkGraph`, `performAction`, `evalCondition`, wait park/resume, `checkWaitTimeouts`, fenced ownership (owner_id/fencing_token/lease), deterministic run ids, `result`/`resume_results` idempotent snapshots |
| Persistence / versions / bindings | `workflowService` | CRUD, `applyImportBatch`, `saveWorkflowDraft` CAS, `_assertActivationAllowed`, `getWorkflowImportDetail`, and the new `saveBindingResolutionBatch` |
| Node capability/schema | `nodeRegistry.ts` | Metadata owner only — `runtimeExecutor` is a declaration, never dispatch |
| Trigger / basic automation | `triggerService.matchTrigger` | Runs only after workflow stage yields no terminal action |
| Bot fallback | dispatch `botFallback` leaf → `callBot` | Unchanged single owner |
| Domain side effects | `handoffService`, `statusConversationService`, `testStatusConversationService`, `conversationService`, `logAdminEvent`, `logBotworkerEvent`, `shadowReplies`, `callBot`, `isSafeFetchUrl` | Existing services; no new per-node services |

Fixed inbound order: **workflow → basic trigger → bot fallback**. One inbound = one
terminal outcome. `workflow_priority` config is removed legacy; the only dispatch
ordering owner is `runInboundDispatch`.

## 2. Node capability matrix (31 Zaapi types — corpus-verified)

Corpus: 21 flows, 218 nodes, 225 source edges (+23 synthesized = 248 persisted).
Status reflects traced runtime behavior, not registry metadata.

| canonical (zaapi) | n | fam | engine today | status |
|---|---|---|---|---|
| message_received | 13 | trigger | `matchTriggerNode` needs `config.keywords` → absent → never matches | requires_adapter |
| label_added | 5 | trigger | never matches; no label-event source | requires_adapter |
| marketplace_order_created | 1 | trigger | never matches; no event adapter | requires_adapter |
| marketplace_return_refund_requested | 1 | trigger | never matches | requires_adapter |
| marketplace_review_added | 1 | trigger | never matches | requires_adapter |
| message_content | 7 | condition | Zaapi `conditions[]`≠`branches[]` → legacy `text=""`→always true→no `true` edge→`condition_false` | requires_adapter |
| business_hours | 5 | condition | no schedule in Zaapi node; no local hours source | blocked (decision pending) |
| label | 8 | condition | no evaluator case → false→exit_to_bot | requires_adapter |
| conversation_assignee | 2 | condition | `admin_id` absent → `!!assigned_to`→wrong branches | requires_adapter + binding |
| last_interaction | 7 | condition | no evaluator case | requires_adapter |
| customer_waiting_time | 3 | condition | no evaluator case | requires_adapter |
| event_time | 2 | condition | no evaluator case (schedule+tz in node → executable) | requires_adapter |
| review_rating | 1 | condition | no evaluator case; no review source | requires_adapter |
| ai_review_sentiment | 2 | condition | no evaluator case; no review source | requires_adapter |
| send_message | 33 | action | `action.message.text` ≠ `cfg.text` → silent no-op | requires_adapter (normalization) |
| add_label | 33 | action | labelIds stripped to bindings → empty → no-op | requires_binding + normalization |
| remove_label | 17 | action | no executor case | requires_adapter + binding |
| chat_assign | 15 | action | `admin_id` absent → auto-handoff executes; team binding ignored | requires_binding |
| chat_unassign | 3 | action | no executor case | requires_adapter |
| close_chat | 5 | action | `close_ticket`→closeConversation works | executable_now |
| reply_to_review | 6 | action | no executor; no review source | requires_adapter |
| add_note_to_review | 1 | action | no executor | requires_adapter |
| mark_review_as_follow_up | 1 | action | no executor | requires_adapter |
| send_marketplace_order_card | 2 | action | no executor | requires_adapter |
| send_button_template | 2 | action | no executor; btn-template-* handles dead | requires_adapter |
| set_ticket_field | 3 | action | no executor; ticket_field unresolvable | requires_adapter + binding |
| chatbot | 6 | action | `let_ai_respond` executes base call; escalation/timeout handles dead | requires_adapter (partial) |
| jump_to | 23 | action | `target_node_id` empty → pass-through on synthesized edge; maxJumps enforced | executable_now |
| delay | 4 | wait | `wait`/`delay` → "unknown node type" → errored | requires_adapter |
| wfr | 3 | wait | legacy park → resume → no unbranched edge → completes wrong | requires_adapter |
| randomizer | 3 | wait | `wait`/`randomizer` → "unknown node type" → errored | requires_adapter |

## 3. Binding census (three cardinalities)

| kind | records | values | unique identities |
|---|---|---|---|
| account | 21 | 632 | 87 |
| label | 67 | 119 | 21 |
| user | 13 | 17 | 6 |
| team | 11 | 11 | 2 |
| ticket_field | 3 | 3 | 3 |
| url | 4 | 4 | 1 (`[redacted]` — zero recoverable endpoints) |
| **total records** | **119** | | |

- **records** = binding requirements, one per `(node_id, field_path, kind)`.
- **values** = total external-id occurrences inside records (arrays inflate).
- **unique** = distinct external identities = the real decision count. 87 unique
  accounts need up to 87 explicit decisions, not 632.

## 4. Re-import identity contract

- `wfId = "wf_imp_" + _shortHash(sourceRef.workflowId || flowKeyHash)` — same Zaapi
  `workflowId` ⇒ same local `workflow_id` forever. Re-import never creates a second
  workflow document; no soft-delete needed.
- `versionId = "wv_" + _shortHash(wfId:seq:fingerprint)` — content fingerprint change
  ⇒ new immutable `WorkflowVersionDoc` under the same `workflow_id`.
- `exec_format: "ce/1"` is part of the fingerprint input ⇒ normalized draft ⇒ new
  `version_seq`/`version_id`. `schema_version:"canonical-workflow/1"` stays the graph
  schema; `exec_format` marks the executable-config dialect.
- Repoint rule (already in `applyImportBatch`): `current_version_id` repoints only
  when `seq > curSeq`; the same atomic `updateOne` forces `enabled:false` +
  `status:"draft"`; fingerprint-dup re-apply is a no-op; older re-apply never repoints.
- Old pre-normalized versions remain immutable readable history.

Planned RED tests:
1. pre-ce/1 import → ce/1 re-import = same `workflow_id`, new `version_id`, `seq=2`
2. post-repoint `enabled===false && status==="draft"`
3. `wv_A` version doc still fully readable
4. re-apply old pre-ce/1 batch does not roll pointer back
5. re-apply ce/1 batch is idempotent (no new docs, `version` unchanged)

## 5. Binding-resolution CAS lifecycle (`saveBindingResolutionBatch`)

Owner: `workflowService` (existing persistence owner — no parallel framework).

One request schema — the only contract:

```ts
{
  workflow_id: string,
  expected_version: number,
  version_id: string,            // current version under CAS
  proposed: [{
    binding_id: string,          // client never supplies node_id/field_path/kind
    repeat?: boolean,            // §6 repeat-resolution; default false
    mappings: [{
      source_index: number,      // position in binding.source_values[]
      local_id: string,
      platform?: WorkflowPlatform,
      shop_id?: string,
    }],
  }],
}
```

Client input is **not** authoritative for source identity. The client never supplies
`node_id`, `field_path`, `kind`, `source_value`, `source_fp`, `source_values`, or
`requirement_fp` — the server loads each `WorkflowBindingDoc` by `binding_id` and
verifies, for every proposal, **before writing any artifact**:

- `binding.workflow_id === request.workflow_id`
- `binding.version_id === request.version_id`
- `request.version_id` equals the workflow's `current_version_id` (the CAS-expected version)
- `source_index` is in bounds of `binding.source_values`
- mapping target kind/scope valid (account ⇒ `platform`+`shop_id` required; local
  identity exists; scope consistent)
- all proposals belong to the same `workflow_id`/`version_id`
- no duplicate `binding_id` or duplicate `(binding_id, source_index)` proposals

Any validation failure → reject; zero artifacts, zero pointer mutation.

Lifecycle:

1. Validate all proposals (above) → verify `workflows.version === expected_version`
   (CAS gate).
2. Insert new immutable `WorkflowVersionDoc` (same canonical graph, new
   `version_seq`/`version_id` — deterministic identity from canonical graph +
   complete binding-resolution payload).
3. Insert new version-scoped `WorkflowBindingDoc`s carrying the approved mappings.
4. **One** CAS `updateOne` — the single commit point writes all of:
   `current_version_id` → new version, `version+1`, `enabled:false`,
   `status:"draft"`, **derived `platforms` + derived `shop_ids`** (computed
   server-side from the complete resolved account-binding set for the target
   version — never client-supplied), `updated_at`/`updated_by`.
   Resolution never activates.
5. Old version doc + old binding docs remain immutable.
6. No local IDs into `raw` provenance; no third "compiled workflow" artifact.

Executable failure tests: derived `platforms`/`shop_ids` equal the resolved
mappings after commit; crash before pointer CAS leaves old pointer **and** old
derived scope together (no half-flip); stale `expected_version` changes neither
pointer nor derived scope; direct non-CAS edits to `platforms`/`shop_ids` on
imported workflows stay rejected (existing `saveWorkflowDraft` version-owned
guard); activation/runtime detects derived-scope divergence → fail closed. No
second scope owner, no background reconciliation.

Resolution status: `resolved` = every `source_values[i]` has exactly one valid
mapping; `invalid` = ≥1 mapping invalidated (deleted/stale local); `unresolved` =
otherwise. `resolution.conflict` stores rejections — status stays `unresolved`.

## 6. Version-scoped immutable mappings

```ts
// WorkflowBindingDoc additions:
status: "unresolved" | "resolved" | "invalid";
resolution?: {
  mappings: {
    source_index: number;          // position in source_values[]
    source_fp: string;             // SHA-256 digest — indexing/lookup ONLY
    local_id: string;
    platform?: WorkflowPlatform;   // account: required with shop_id
    shop_id?: string;
    state: "valid" | "invalid";
    resolved_by: string; resolved_at: Date;
    invalidated_at?: Date; invalid_reason?: string;
    via: "direct" | "repeat";
    carried?: boolean;             // provenance: carried across import revision
  }[];
  conflict?: string;
}
```

### Mandatory clarification A — exact re-import carry-forward

A resolved mapping MAY carry to a new import revision **only when all** match
exactly:

- same Zaapi `source_workflow_id`
- same canonical `node_id`
- same `field_path`
- same binding `kind`
- same ordered `source_values`
- same `count`
- same exact source identities
- same platform/shop scope contract
- mapped local target still exists and is valid

All pass → carry mapping + resolved state to the new version, record
`carried:true` provenance. Any fail → new `unresolved` mapping; **never** partial
or heuristic carry; old version immutable. This avoids forcing admins to remap 87
accounts after an unrelated revision.

### Mandatory clarification B — client input is not authoritative

The resolution API accepts only: `workflow_id`, `expected_version`, `version_id`,
`binding_id`, `source_index`, selected local target identity + scope. The server:

- loads the binding document itself
- reads `source_values[source_index]` itself
- verifies index bounds, kind, and scope
- computes exact equality/digest itself
- rejects stale version/binding requests
- never trusts client-supplied `source_value`/`source_fp`
- never copies raw external IDs into executable node config

### Mandatory clarification C — resolution CAS crash/retry contract

- deterministic target version identity = canonical graph + complete binding-resolution payload
- immutable version and binding artifacts written **before** pointer flip
- `expected_version` on the workflow update is the only commit point
- stale `expected_version` → conflict, zero pointer mutation
- retry after crash-before-commit → reuse deterministic artifacts (insert-idempotent)
- concurrent same `expected_version` → exactly one pointer winner; loser gets conflict
- orphan artifacts never become `current_version_id` automatically
- failure-injection tests at: version insert, mid-binding insert, pre-pointer commit, pointer commit
- **no multi-document exactly-once claim**

### Repeat-resolution

`via:"repeat"` is an explicit bulk action applying one confirmed mapping to other
bindings containing the same exact source identity — verified by exact value
equality + same kind + same scope. Never auto-fills; account mappings never
transfer to label/user/team.

- `repeat` is optional and defaults to `false`.
- The server performs exact source-value equality itself from its own binding
  documents; the client never sends a source value or fingerprint.
- A repeat target requires the same `kind` and the same scope contract; no
  cross-kind transfer.
- Repeat expansion happens inside `saveBindingResolutionBatch` during
  validation, **before** any artifact write.
- Expanded (repeated) targets are returned in the resolution result so the
  admin can see exactly which bindings changed.

## 7. Pure in-memory executable materializer

One owner:

```
materializeExecutableWorkflow(versionDoc, bindingsForVersionId)
  → ExecutableWorkflow   // canonical-exec dialect; Zaapi-free
```

- Pure function inside the workflowEngine module; **no DB writes**.
- Missing/invalid/incomplete mapping → fail closed before graph execution
  (`error recoverable:false`).
- Engine consumes one dialect only — no dual Zaapi/canonical branching.
- Run pins `version_id` at `createRun`; later binding edits produce new versions —
  active runs are immune.
- Historical runs resume against their pinned version + that version's bindings;
  never the current workflow pointer.
- Rejected alternative: materialize-at-publish into a stored artifact — adds a
  third collection + stale-validation burden; version-pinning makes in-memory
  equally immutable.

## 8. Carry-forward truth tables (real mutation paths)

### Zaapi re-import revision

| Condition | New-version binding |
|---|---|
| all §6-A conditions hold | carried (`carried:true`, resolved preserved) |
| any condition fails | new `unresolved`; old immutable |
| node removed | absent on new version; old intact |

### Local editor CAS (`saveWorkflowDraft`)

| Mutation | New-version binding |
|---|---|
| name/position/non-binding config | carried iff `requirement_fp` identical |
| node deleted | dropped |
| subtype change / binding-consuming field removed | dropped |
| external-ID edit | impossible (stripped at import) |
| resolution change | only via `saveBindingResolutionBatch` (own version) |

`requirement_fp` = SHA-256 over `{node_id, field_path, kind, count,
source_values[] ordered}`. **Exact value equality is authoritative**; digest is
indexing/lookup only and may never override equality. `_shortHash` (FNV-1a) stays
a doc-id derivation only — never an external-identity key.

RED tests: rename→carried; subtype change on same `node_id`→dropped; delete→absent;
wrong `expected_version`→reject + zero writes; resolution batch→new version + old
bindings immutable; account mapping refused on label-kind binding; repeat-apply
verifies value+kind+scope; identical-requirement re-import→carried with
`carried:true`; count-change re-import→fresh unresolved.

## 9. Account/platform/shop scope ownership

**One owner:** version-scoped resolved account bindings are authoritative for an
imported workflow's `(platform, shop_id)` eligibility set. `WorkflowDoc.platforms`/
`shop_ids` are derived display/filter indexes written at import/resolution — not
independently editable for imported flows. Activation/runtime validates derived
fields against pinned bindings; divergence → fail closed.

## 10. Overlap rule (singular — no exceptions)

```
|E| = 0  → no_match → trigger → bot
|E| = 1  → execute
|E| > 1  → fail closed: execute NONE
           + logAdminEvent("workflow.overlap_conflict")
           → exit_to_bot → trigger → bot
```

No `created_at` winner, no `priority` winner, no keyword patch, no parallel
execution. `triggerService` automations are downstream fallback and never part of
the overlap set.

Save-vs-publish contract (single rule — resolution is never discarded for revealing
overlap):

- a binding-resolution CAS **may persist** the mapping + derived scope as a
  disabled draft — the overlap it creates is recorded in publish-readiness/
  conflict output
- publish/enable/activation is **blocked** while overlap exists
- runtime keeps the final fail-closed rule `|E|>1 → execute none → log → trigger→bot`

Publish-readiness overlap detection covers:

1. imported vs imported
2. imported match-all `message_received` vs enabled/published **legacy** workflow
   in the same platform/shop scope
3. imported revision vs another active imported workflow
4. account-scope changes introducing new overlap (re-evaluated inside resolution
   CAS before commit — reported in readiness, never blocking the save itself)

Corpus evidence: `_cross_facts.json` `message_received_overlaps` — flows 1+3 share
81 accounts, both "trigger every time".

Admin resolves overlap by: narrowing shop/platform/account scope (re-resolution),
disabling/unpublishing one workflow, or changing the trigger/event contract when
adapters exist — never keywords or new priority.

RED tests: overlap-producing resolution batch persists a disabled draft; readiness
reports cannot-publish; zero workflows execute while ambiguous; narrowing scope in
a later resolution version clears readiness; no priority/created_at winner.

## 11. URL/media blocked behavior

Verified: `REDACT_VALUE = /url|webhook|token|secret|apikey|api_key|password/i` —
`imageUrl`/`videoUrl`/`callbackUrl` → `"[redacted]"` at import; `source_values`
resolved from sanitized `raw` ⇒ **zero recoverable URL values**.

R1/R2A: url bindings are publish-blocking; `send_message` is **text only**;
`image_url`/`video_url` never populated for imports; `send_http`/webhook/callback
publish-blocked; normalization never claims URL recovery.

Later bounded phase classification (proposal only — not authorized):
credential-bearing endpoint/webhook/callback URL → always redacted + blocked until
explicit rebind; ordinary media asset URL → preservable only after an approved URL
provenance/safety design; safety never inferred from key name or domain substring;
sandbox never fetches external URLs regardless.

## 12. Sandbox trust boundary

- `TEST_SOURCES` allowlist (`testStatusConversationService.ts:18`) — no unchecked
  `as TestSource` casts.
- Typed `sandbox` option constructed **only** by authenticated
  `/api/test-chat/dispatch`; `EngineMessage` has no draft/version override field;
  bot-worker production callsite cannot supply it.
- Sandbox constraints: workflow exists + `enabled===false` + `status==="draft"` +
  `version_id` belongs to it; runs carry `test_source`; side effects route to test
  owners; platform delivery impossible (engine emits `delivered[]` only).
- `live_bot:false` default → deterministic stub; real `/chat` needs explicit
  per-request authorization.
- `send_http` → fake recorder, never fetches; `add_note` → never production
  `admin_logs` (test store or fail-closed); media URLs never fetched.
- Unsupported side effect → typed fail-closed **before** execution.

Sandbox matrix:

| case | prod owner | sandbox owner | safe |
|---|---|---|---|
| send_message (text) | caller→shadow_replies | render only | yes |
| add/remove_label | conv.labels | addTestLabels/removeTestLabels | yes |
| assign/unassign | handoffToAdmin CAS | handoffToAdminTest/test store | yes |
| close_chat | closeConversation | closeTestConversation | yes |
| wait/delay/randomizer/jump_to | run state | test_source run | yes |
| let_ai_respond | callBot | stub default; live_bot gate | gated |
| add_note | admin_logs | blocked/fake (hole fix) | fix required |
| send_http | fetch | never — recorder | blocked |
| media URL | — | never fetched | blocked |
| marketplace/review/ticket_field/button | — | typed fail-closed | blocked |

## 13. Side-effect idempotency matrix

| node | ordering vs commit | retry replay | dup? | verdict |
|---|---|---|---|---|
| send_message | `delivered[]`→caller stores post-commit | committed `result`→re-settle→same `wfReplyId`→E11000 | no dup persist | supported |
| let_ai_respond | callBot during walk, pre-commit | node replays→second call | second **call** possible; persist deduped | at-least-once cost — explicit, never "exactly-once" |
| assign_ticket | CAS op doc pre-commit | op-doc result replay | no | supported |
| add_label / remove_label | `$addToSet`/`$pull` pre-commit | re-apply same set | converges | supported |
| close_chat | closeConversation pre-commit | already-closed → no-op | converges | supported |
| add_note | insert pre-commit | second note doc | **yes** | blocked until `{op}:note:{node}` dedupe |
| send_http | fetch pre-commit | second outbound call | **yes** | blocked |
| delay/randomizer/jump_to | pure state | deterministic replay | no | supported |
| review/order/ticket_field/button | — | — | — | R2B blocked |

No exactly-once claim for the workflow as a whole.

Acceptance tests: kill-after-effect-before-commit + same op-key replay → no dup
shadow reply, no dup assignment, label/close converge.

## 14. `ce/1` normalization contract

`CanonicalDraft.exec_format = "ce/1"` stamped at import; absent ⇒ legacy import.
All Zaapi-shaped config is translated at import — engine reads canonical-exec only.

| Zaapi | canonical-exec |
|---|---|
| `triggerOncePerConversation`/`triggerOncePerOpen` | `trigger_frequency`: `once_per_conversation` (either) / `every_time` (neither) — documented approximation |
| `accountIds`/`labelIds`/`userIds`/`teamIds`/`ticketFieldId`/`assigneeUserId` | bindings only; local ids materialize into executable config via §7 |
| `action.message.{text,imageUrl*,videoUrl*,variables,type}` | `config.{text,image_url*,video_url*,variables,message_type}` — *never populated for imports (redacted) |
| `action.label.labelIds` | resolved `config.label_ids` |
| `conditions[{operator,operands,nextStepId}]`+`noMatchNextStepId` | `branches[{branch_id:"condition-index-i", cond_op, operands}]`+`fallback_branch_id:"no-match"` — edges keep handles, **no rewrite** |
| `waitForReply{replyType,numberOfRetries,invalidInputReply,expiresIn,*StepId}` | `WaitForReplyConfig{answer_type,max_retries,retry_message,timeout_ms}` + **edge rewrite**: `wfr-success`→`success`, retriesExpired→`retry_exceeded`, timeExpired→`no_reply` |
| `delay{unit,value}` | `config.delay_ms` + persisted `resume_at` (scanned by `checkWaitTimeouts`) |
| `randomizer{paths[{weight,nextStepId}]}` | `config.paths[{weight}]`; edges keep `randomizer-path-N`; deterministic pick `SHA-256(run_id+node_id)` persisted in `context` |
| `action.assignment{userIds,teamIds}` | resolved `config.assignee`/`team` |
| `action.chatbot{instruction}` | `config.prompt_prefix`; escalation/timeout stay dead handles → publish-blocked until R2B |
| `action.setTicketField` | blocked — unresolvable |
| `action.jumpTo{maxJumps}` | `config.max_jumps`; target via synthesized edge |

Correction preserved from V2: condition/randomizer edges need zero rewrite;
**WFR edges are rewritten** — "zero edge rewrite" never claimed globally.

Loss tests: per-node golden fixtures for all 31 types — every operand/handle/
schedule preserved; every source step-ref lands in exactly one canonical edge;
`exec_format` stamped; fingerprint deterministic.

## 15. Round sequence

| Round | Scope | Est. |
|---|---|---|
| **R1** | `saveBindingResolutionBatch` CAS + mappings[] + account-scope owner + carry-forward (§6A) + client-not-authoritative (§6B) + crash/retry contract (§6C) + overlap publish blocker + minimal UI/API (binding list, scoped candidate picker, conflict display, repeat-apply) — **no runtime activation** | 4–5 d |
| **R2A** | `ce/1` normalization + `materializeExecutableWorkflow` + text-only `send_message` + safe idempotent set (add/remove_label, chat_assign/unassign, close_chat, message_content, conversation_assignee, label cond, last_interaction, customer_waiting_time, event_time, jump_to, wait_for_reply edge remap, delay, randomizer, `message_received` match) + `|E|` fail-closed — no URL/media/provider/webhook | 5–7 d |
| **R2B** | external/platform adapters; URL/media safety design; chatbot escalation/timeout; live provider sandbox authorization; marketplace/review/order/button/ticket-field nodes — **blocked without separate approval; no duration promised** | discovery |
| **R3** | run `version_id` pinning + `node_trace` + run viewer | 1–2 d |
| **R4** | authenticated sandbox: TEST_SOURCES allowlist, sandbox context, `add_note`/`send_http` holes, `live_bot` gate, fail-closed matrix | 2–3 d |
| **R5** | index DDL verify + one-shop canary + activation review (gates §17) | 1–2 d + review |

Honest estimate: sequential R1→R5 ≈ **13–19 working days** + unbounded R2B.

## 16. Blocked nodes (deferred — not TODO)

- `label_added` + `marketplace_*` triggers ×3 — no event sources
- `business_hours` — no local hours store and Zaapi node carries no schedule;
  requires decision (manual hours in normalized config vs new shop field);
  **no new shop-hours schema in R1**
- `review_rating`, `ai_review_sentiment`, `reply_to_review`, `add_note_to_review`,
  `mark_review_as_follow_up` — no review source
- `send_marketplace_order_card`, `send_button_template` — no adapters
- `set_ticket_field` — ticket_field unresolvable
- `chatbot` escalation/timeout branches — dead handles
- `send_http`/webhook — non-idempotent outbound
- `add_note` — until op-keyed dedupe
- URL/media fields — redacted, unrecoverable
- live provider call in sandbox — defaults OFF

## 17. Activation gates (all must pass)

1. exact bindings resolved and valid (`unresolved==0 && invalid==0`)
2. every used node has verified executor/adapter (registry executor ↔ real dispatch)
3. graph validation + capability validation pass
4. required indexes created and verified (production DDL gated to R5)
5. sandbox execution tests pass
6. side-effect idempotency tests pass
7. failure/recovery tests pass
8. local canary passes
9. explicit activation approval — only then flip `FOUNDATION_GATES.runtimeActivation`

## 18. Complexity budget

- function/helper total +4 across the full design:
  - `saveBindingResolutionBatch` — R1 public service method
  - `getBindingResolutionView` — R1 public read-model method (binding UI/API view)
  - `normalizeCanonicalExec` — R2A `ce/1` normalizer (importer)
  - `materializeExecutableWorkflow` — R2A
- R1 private helpers +0: overlap computed inline inside `getWorkflowImportDetail`;
  SHA-256 computed inline at each assignment via
  `createHash("sha256").update(canonicalJson(v)).digest("hex")`; local-target
  validation is one typed switch inside `saveBindingResolutionBatch`; derived
  scope computed inline in its commit path; no nested functions
- guards +0 standalone; registries +0; decision owners +0; workers/timers +0
  (delay reuses `checkWaitTimeouts`); collections +0; required indexes +0
  (optional `source_fp` digest index — measured first)
- no semantic keywords, keyword mappers, regex business inference, duplicated
  decision owners, or speculative frameworks

## 19. Estimate

R1 4–5d · R2A 5–7d · R3 1–2d · R4 2–3d · R5 1–2d+review ⇒ **13–19 working days**
sequential, plus R2B which has no fixed estimate until real sources/adapters are
scoped and separately approved.
