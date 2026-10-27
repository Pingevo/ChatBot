# Zaapi Workflow Runtime R1 — Binding Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `saveBindingResolutionBatch` — the version-scoped, CAS-committed binding-resolution path that lets admins map imported Zaapi external identities to local targets, derives workflow scope server-side, records overlap as a publish blocker, and keeps imported workflows disabled/draft and engine-invisible.

**Architecture:** All persistence writes and all Mongo reads for binding resolution stay inside the existing owner `ChatAdminWeb/src/backend/service/workflowService.ts` (same owner as `applyImportBatch`/`saveWorkflowDraft`/`getWorkflowImportDetail`). One thin new API route file delegates to the service owner for both GET (binding-resolution view + scoped candidates) and POST (commit batch). The editor gains one presentational component, `BindingResolutionPanel.tsx`, wired into `WorkflowEditor.tsx`/`NodeConfigPanel`. No engine changes, no new collections, no new indexes, no runtime activation, no new private helpers — overlap and derived scope are computed inline inside the existing owners.

**Tech Stack:** Next.js 16 / TypeScript, MongoDB driver, fake-Mongo harness (`ChatAdminWeb/scripts/test-botworker-fakemongo.mjs` + module-register hooks), `tsx` test scripts, `react-dom/server` SSR-smoke assertions.

**Spec:** `docs/superpowers/specs/2026-10-27-zaapi-workflow-runtime-design.md` (approved; `repeat?: boolean` schema + §18 budget completed — spec remains authoritative).

## Global Constraints

- Persistence/version/binding owner: `workflowService.ts` only — **no second persistence owner, no second read owner, no new collection, no new index DDL, no worker/timer/queue, no background reconciliation, no stored compiled-workflow artifact, no new service file, no new private helper functions, no nested functions**.
- Route files are thin: auth → `workflowService` → HTTP mapping. Route files never call `getCollection`, `find`, `findOne`, `distinct`, or any Mongo method.
- Client input is never authoritative for source identity (spec §6B): request may carry only `workflow_id`, `expected_version`, `version_id`, `binding_id`, `source_index`, `local_id`, `platform`, `shop_id`, `repeat`. Forbidden client keys anywhere in the request: `node_id`, `field_path`, `kind`, `source_value`, `source_fp`, `source_values`, `requirement_fp`, `display_value`, `sources` → 422.
- Resolution never activates: commit always writes `enabled:false`, `status:"draft"`.
- **No match-all authority**: unresolved or invalid account requirements never authorize global eligibility. Zero valid account mappings on a workflow that has account requirements ⇒ zero resolved eligibility + explicit account-scope blocker + disabled/draft. Empty `platforms`/`shop_ids` on an imported workflow is a blocked state, never an authorized scope.
- Overlap: no `priority`/`created_at` winner, no keyword patch; overlap is a publish blocker, never a save blocker (spec §10). Overlap detection reads **resolved account mappings**, never empty arrays as global.
- Imported workflows remain engine-invisible (`listWorkflows enabledOnly+publishedOnly` unchanged).
- No semantic keyword/phrase/regex additions; guards enforce schema/safety invariants only.
- No `.env*`/`มาแล้วจ้า.md` reads; no real Mongo, no services, no provider calls.
- Production index creation deferred to R5 (spec §17.4).
- No new frontend testing dependency in R1.
- **Commit safety**: no committed service method may write before its complete validation contract exists; `repeat:true` fails closed as unsupported until the repeat-expansion commit lands.

---

## 1. Objective and non-goals

**Objective (R1 scope, spec §15):**

1. `saveBindingResolutionBatch` in `workflowService.ts` — complete request validation → repeat expansion → deterministic immutable artifacts → single pointer+scope CAS → audit.
2. Version-scoped immutable mappings on `WorkflowBindingDoc.resolution.mappings[]`.
3. Server-derived account scope (`platforms`/`shop_ids`) written atomically in the commit CAS; zero resolved accounts ⇒ fail-closed blocked state.
4. Exact carry-forward (spec §6A) on Zaapi re-import revision and on `saveWorkflowDraft` (`requirement_fp` gate).
5. Overlap publish blocker computed inline inside `getWorkflowImportDetail`.
6. Minimal binding UI/API: binding list with source display values, scoped candidate picker, conflict display, explicit repeat-apply, stale-version handling.

**Non-goals (explicitly excluded):** `ce/1` normalization, `materializeExecutableWorkflow`, imported workflow execution, node adapters/executors, URL/media recovery, provider/webhook calls, sandbox execution, run `version_id` pinning, execution trace viewer, production DDL/index creation, enabling/publishing imported workflows, R2A/R2B/R3/R4/R5, KB Zaapi, KB switch, pool switches, logging/analytics, Phase 10B, chatbot Python runtime, Lazada/TikTok placeholder implementation, team-entity creation.

---

## 2. Frozen baseline

| Check | Expected |
|---|---|
| Worktree | `ChatBotProductMS-worktrees/zaapi-workflow-foundation` |
| Branch | `codex/zaapi-workflow-foundation` |
| HEAD | `65f88b0` `docs: record workflow runtime design closeout` |
| Chain | `65f88b0` → `8451aab` (spec) → `ba7f5b9` (persistence closeout) → `3193fd7` (persistence feat) |
| Tree | clean except planning docs; staging empty |
| Canonical spec | `docs/superpowers/specs/2026-10-27-zaapi-workflow-runtime-design.md` committed at `8451aab` (+ `repeat` schema/§18 completions this round) |
| Phase 10B | external state — check read-only at execution start, record observed HEAD/dirty; never an R1 blocker unless the workflow worktree is contaminated by Phase 10B files/commits |

If the workflow worktree differs at execution time → stop, do not implement.

---

## 3. Source audit — evidence table (verified callsites, not names)

| Item | Owner / evidence |
|---|---|
| `WorkflowDoc` owner | `ChatAdminWeb/src/backend/service/workflowService.ts:39-83` — `workflow_id`, `enabled`, `shop_ids`, `platforms`, `version`, `status`, `current_version_id`, `import{source,source_workflow_id,batch_id}`. Mutated by `createWorkflow`/`updateWorkflow`/`toggleWorkflow`/`delete`/`restore`/`applyImportBatch`/`saveWorkflowDraft`. |
| `WorkflowVersionDoc` owner | `workflowService.ts:86-106` — `version_id`, `version_seq`, `schema_version:"canonical-workflow/1"`, version-owned payload fields, `handle_labels`, `source_ref`, `import_batch_id`, `fingerprint`. Immutable inserts at `:609-617` (import) and `:797-806` (CAS save). |
| `WorkflowBindingDoc` owner | `workflowService.ts:143-156` — `binding_id`, `workflow_id`, `version_id`, `node_id`, `field_path`, `kind`, `count`, `source_ref`, `source_values`, `status`. Inserts at `:632-642` (import) and carry-forward clone at `:808-825` (CAS). |
| Import/re-import owner | `applyImportBatch` `workflowService.ts:514-723` — batch claim (`claim_token`+60s lease, `_assertImportClaim` fence), deterministic ids (`wf_imp_`/`wv_`/`wrs_`/`wb_` via `_shortHash`), repoint only `seq > curSeq` + forced `enabled:false`/`draft` `:656-678`, `_batchComplete` gate, finalize CAS, post-commit audit. |
| Editor CAS owner | `saveWorkflowDraft` `workflowService.ts:745-846` — `expectedVersion` gate `:756`, version insert `:787-806`, surviving-node binding carry `:808-825`, single commit `updateOne({workflow_id, is_deleted, version: expectedVersion})` `:830-836`, audit after `:839-844`. |
| Activation gate owner | `_assertActivationAllowed` `workflowService.ts:249-269` — called by `updateWorkflow` `:313`, `toggleWorkflow` `:350`, `saveWorkflowDraft` `:762`. Imported (has `import` provenance) → `getWorkflowImportDetail` readiness + `publishReadiness` (`FOUNDATION_GATES.runtimeActivation=false` → all imported blocked). |
| Publish-readiness owner | `getWorkflowImportDetail` `workflowService.ts:863-888` → `validateCanonicalDraft` (registry capability, `nodeRegistry.ts`) → `publish_blockers`. |
| API routes | `src/app/api/workflows/route.ts` (GET list / POST create); `…/[workflowId]/route.ts` (GET incl. `import_detail`, PATCH w/ `expected_version`→CAS, DELETE soft); `…/[workflowId]/toggle/route.ts`; `…/[workflowId]/restore/route.ts`; `…/import/route.ts` (preview→`applyImportBatch`, 409/422/500). Auth: `requirePageEdit(req,"workflow")` / `requireAuth`. |
| Binding UI surface | `WorkflowEditor.tsx` — `importDetail` state from GET `import_detail`; `loadedVersion` = CAS expected_version (`:297`); `NodeConfigPanel` `bindings` prop filtered by `node_id` (`:794`); unresolved-count chip on disabled Publish (`:643-647`); import modal + Apply (`:840-859`). No binding-resolution UI exists. |
| Account/shop/platform identity | `shops` coll → `ShopDoc{shop_id, shopname, platform, connected, …}` (`shopService.ts:9-30`); `Platform = "shopee"|"tiktok"|"lazada"` (`systemConfigService.ts:21`). Workflow `shop_ids` compare against `EngineMessage.config_shop_key` domain via `listWorkflows` `:227-228`. |
| Label identity | **No label master collection** — `src/app/api/labels/route.ts` uses `conversations.distinct("labels")`. Local label identity = label string; validity = membership in the distinct set. Read happens inside `workflowService`. |
| User identity | `admins` coll → `{admin_id, role, active, is_accepting_chats, …}` (`assignmentService.ts:47`). Valid iff doc exists and `active !== false`. |
| Team identity (decided) | **No `teams` collection exists.** `shop_team_assignments{shop_id, admin_id, is_active, role_on_shop}` and `platform_team_assignments{platform, admin_id, is_active}` are membership rows, not team identities. **R1 decision (approved): team bindings stay unresolved + publish-blocking; UI shows "team mapping unavailable — local team identity not defined". No fake team collection, no team→admin mapping, no schema expansion.** Execution deferred to a later adapter/data-contract round. |
| ticket_field / url | No `ticket_fields` collection; `url` values are `"[redacted]"` at import (`provenanceSnapshot`, `REDACT_VALUE` mask in `zaapiImport.ts`). Both unresolvable → publish-blocking (spec §11/§16). |
| Index declarations | `mongoClient.ts ensureIndexes` — `workflow_versions` unique `version_id`, unique `(workflow_id, version_seq)`, `(workflow_id, fingerprint)`; `workflow_import_batches` unique `batch_id`, `(source, source_fingerprint)`; `workflow_raw_snapshots` unique `snapshot_id`; `workflow_bindings` unique `binding_id`, `(workflow_id, version_id)`, `(workflow_id, status)`. Declarations only — reused as-is, no additions. |
| Fake-Mongo seams | `createFakeMongo(state)` (`test-botworker-fakemongo.mjs`) — hooks: `findHook`, `findOneHook`, `insertOneHook`, `updateOneHook`, `updateManyHook`, `findOneAndUpdateHook`, `deleteOneHook`; `uniqueKeys` E11000; `onQuery`/`onInsert` counters. `test-workflow-persistence-mocks.mjs` redirects `mongoClient` + `adminLogService`; `COLLECTIONS` map covers the 5 workflow colls. |
| Audit-log owner | `adminLogService.logAdminEvent` — `AdminActionType` union includes `workflow.import_apply`, `workflow.cas_save`. R1 adds `workflow.binding_resolve`. |
| Current overlap/conflict | Preview-time `conflicts[]` in `zaapiImport.ts` (`trigger_overlap`, `label_chain`, basic-automation overlap) — report-only. Runtime: `listWorkflows` sorts `priority:-1, created_at:-1`, engine iterates in order (legacy — superseded by spec §10 fail-closed in R2A). No persisted overlap tracking exists. |
| UI test facility | **None.** No vitest/jest/testing-library/playwright in `package.json`. Existing convention: `tsx` scripts + `renderToStaticMarkup` SSR-smoke (`test-workflow-foundation.ts:12,393`). UI verification = executable service/API tests + SSR markup assertions + `tsc --noEmit` + explicit browser canary (§15). No new frontend test dependency. |
| Reuse-required functions | `_shortHash`, `stableFingerprint`, `canonicalJson`, `provenanceSnapshot`, `REDACT_VALUE`, `_resolveRawPath`, `_assertImportClaim`, `_batchComplete`, `_impErr`, `pickAllowed`, `hasUnsafeKeys`, `validateWorkflowGraph`, `validateCanonicalDraft`, `publishReadiness`, `getWorkflowImportDetail`, `_assertActivationAllowed`, `getCollection`/`COLLECTIONS`, `logAdminEvent`, `requirePageEdit`/`requireAuth`, `json`/`error`/`readJson`, `node:crypto` `createHash` (already imported by `workflowEngine.ts`; add to `workflowService.ts`). |

**Call graph (resolution path):**

```
GET  /api/workflows/[workflowId]/bindings
  → requireAuth → workflowService.getBindingResolutionView(workflowId) → json
POST /api/workflows/[workflowId]/bindings
  → requirePageEdit("workflow")
  → workflowService.saveBindingResolutionBatch(workflowId, req, actor) → status map
      → strict-shape validate + load WorkflowBindingDoc by binding_id
      → repeat expansion (server-side exact equality — added Task 2)
      → one typed switch validates local targets (shops / admins / conversations)
      → inline SHA-256 digests + deterministic version/binding artifacts
      → inline derived platforms+shop_ids (fail-closed) + inline overlap re-eval
      → commit updateOne CAS → audit after commit
```

---

## 4. Persisted-data contract

### `WorkflowBindingDoc` additions (same collection, spec §6)

```ts
status: "unresolved" | "resolved" | "invalid";   // existing union — "invalid" used by R1
resolution?: {
  mappings: {
    source_index: number;          // position in source_values[] — positional, authoritative
    source_fp: string;             // SHA-256(source_value) — indexing/lookup ONLY
    local_id: string;
    platform?: Platform;           // account: required together with shop_id
    shop_id?: string;
    state: "valid" | "invalid";
    resolved_by: string;
    resolved_at: Date;
    invalidated_at?: Date;
    invalid_reason?: string;
    via: "direct" | "repeat";
    carried?: boolean;             // carried across import revision (spec §6A)
  }[];
  conflict?: string;               // last rejection/overlap note — status stays "unresolved"
}
```

Status rules (spec §5): `resolved` = every `source_values[i]` has exactly one `state:"valid"` mapping; `invalid` = ≥1 mapping invalidated; else `unresolved`. `unresolved` and `invalid` both count as not-ready for activation (readiness reports both counts; `_assertActivationAllowed` requires both zero — plus spec §17 gates still hold).

### `WorkflowVersionDoc` (unchanged shape)

New doc per resolution batch — same canonical graph as the `version_id` under CAS, fresh deterministic `version_seq`/`version_id`, `fingerprint` covers canonical graph + complete binding-resolution payload (spec §6C). Old version doc immutable.

### `WorkflowDoc` commit write

One `updateOne` `$set`: `{current_version_id: newVersionId, version: seq, enabled:false, status:"draft", platforms: derived, shop_ids: derived, updated_at, updated_by}` on filter `{workflow_id, is_deleted:{$ne:true}, version: expected_version}`.

**Derived scope rule (fail-closed):** `platforms`/`shop_ids` = unique values across `state:"valid"` account mappings on the target version, computed inline in the commit path. If the workflow has account requirements and zero mappings resolve ⇒ both arrays empty **and** an explicit `account_scope` blocker is appended to `publish_blockers` — this is a blocked state, never match-all authorization. If account requirements exist and coverage is incomplete (any `kind:"account"` requirement whose binding `status !== "resolved"` or whose eligible valid mapping count ≠ `count`) ⇒ one deterministic `account_scope` blocker. If the workflow has **no** account requirements at all (no `kind:"account"` binding), arrays stay empty, no `account_scope` blocker is emitted (do not invent account requirements), but an **explicit global-scope blocker** (`scope: explicit global scope approval required`) is emitted while no explicit global-scope contract exists — empty imported scope is never automatic match-all authorization; an intentionally global imported workflow requires a separate explicit global-scope contract + approval, not inferred emptiness.

### Digest contract (all computed inline — no digest helper)

| Artifact | Formula |
|---|---|
| `requirement_fp` | `createHash("sha256").update(canonicalJson({node_id, field_path, kind, count, source_values})).digest("hex")` at the assignment site — `source_values` **ordered**; exact equality authoritative, digest index aid only (spec §8). |
| `source_fp` | `createHash("sha256").update(canonicalJson(source_value)).digest("hex")` per mapped value — lookup only. |
| version `fingerprint` | `stableFingerprint({…versionPayload, resolution: completeMappings})` — deterministic for crash-retry idempotency. |
| `version_id` | `"wv_" + _shortHash(\`${workflow_id}:${seq}:${fingerprint}\`)` with seq-bump collision loop (same pattern as `saveWorkflowDraft:787-795`). |
| `binding_id` | `"wb_" + _shortHash(\`${versionId}:${node_id}:${field_path}:${kind}\`)` — unchanged convention (`:633`). |

`createHash` imported from `node:crypto` at the top of `workflowService.ts` (same import as `workflowEngine.ts:15`).

---

## 5. API contract

### Service interface consumed by the routes (all Mongo inside `workflowService`)

```ts
// POST body — spec §5 completed schema
interface BindingResolutionRequest {
  workflow_id: string;
  expected_version: number;        // CAS gate on workflows.version
  version_id: string;              // must equal workflow.current_version_id
  proposed: {
    binding_id: string;            // server loads doc; client supplies nothing else
    repeat?: boolean;              // default false — §6 repeat-resolution
    mappings: {
      source_index: number;        // bounds-checked against binding.source_values
      local_id: string;
      platform?: Platform;         // account: required with shop_id
      shop_id?: string;
    }[];
  }[];
}

interface BindingResolutionResult {
  ok: boolean;
  conflict?: boolean; not_found?: boolean; validation?: string;
  current_version?: number; current_version_id?: string;
  version?: number; version_id?: string;
  resolved?: number; unresolved?: number; invalid?: number;
  repeated?: { binding_id: string; source_index: number }[];   // repeat expansion targets
  publish_blockers?: string[]; overlap_conflicts?: string[];
}

interface BindingResolutionView {          // GET response — server-produced display data
  workflow_id: string; version_id: string | null; expected_version: number;
  bindings: {
    binding_id: string; node_id: string; field_path: string; kind: string;
    count: number; status: BindingStatus;
    sources: { source_index: number; display_value: string }[];
    resolution?: WorkflowBindingDoc["resolution"];
  }[];
  candidates: {
    accounts: { platform: Platform; shop_id: string; shopname: string }[];
    labels: string[];
    users: { admin_id: string; display: string }[];
    teams: []; ticket_fields: []; urls: [];                    // empty — unresolvable kinds
  };
  unresolved: number; invalid: number;
  publish_blockers: string[]; overlap_conflicts: string[];
}
```

`workflowService` exports add: `saveBindingResolutionBatch`, `getBindingResolutionView`. `getWorkflowImportDetail` gains `invalid_bindings` + `overlap_conflicts` on its return.

### `GET /api/workflows/[workflowId]/bindings`

Auth: `requireAuth`. Thin handler: `getBindingResolutionView(workflowId)` → `json(...)`. 404 when workflow absent. Returns `BindingResolutionView` above.

**Source-display safety contract:**

- `display_value` is server-produced, read-only display data — never echoed back as persistence authority.
- Rendered from the **already-sanitized persisted** `source_values` (credentials masked at import by `provenanceSnapshot`/`REDACT_VALUE`).
- account/label/user/team external identifiers may be shown to authenticated admins.
- Any stored value that equals `"[redacted]"` **or** matches `REDACT_VALUE` defensively renders `"[redacted]"`; URL values stay redacted and unresolvable.
- Non-primitive values render via `canonicalJson` truncation; credentials/secrets never returned.
- Client POST still carries only `binding_id` + `source_index` + local target; `display_value`/`sources` in a request → 422 (strict-shape validation).

### `POST /api/workflows/[workflowId]/bindings`

Auth: `requirePageEdit(req, "workflow")`. Thin handler: `readJson` → `saveBindingResolutionBatch(workflowId, body, r.ctx.admin.admin_id)` → status map.

Success `200`: `{ok:true, version, version_id, resolved, unresolved, invalid, repeated, publish_blockers, overlap_conflicts}`.

Error mapping (existing route conventions):

| Result field | HTTP | error |
|---|---|---|
| middleware auth fail | 401/403 | middleware response |
| `not_found` | 404 | `workflow not found` |
| `conflict` | 409 | `conflict` + `current_version`/`current_version_id` |
| `validation` | 422 | `validation` + `detail` |
| unexpected throw | 500 | `detail` |

---

## 6. CAS sequence (numbered) — `saveBindingResolutionBatch(workflowId, req, actor)`

All branches live inside the single typed owner — no nested functions, no helper calls beyond the reuse list in §3.

1. **Strict-shape validate** (inline branches): types, required fields, `workflow_id` === route param, forbidden keys absent anywhere (`node_id`/`field_path`/`kind`/`source_value`/`source_fp`/`source_values`/`requirement_fp`/`display_value`/`sources`), `proposed` non-empty, no duplicate `binding_id`, no duplicate `(binding_id, source_index)`. `repeat:true` → **fail closed with `unsupported` until Task 2 lands** — the committed method never silently accepts a field it does not implement. Zero writes.
2. **Load workflow** `findOne({workflow_id, is_deleted:{$ne:true}})` → `not_found`. Require `workflow.import` → validation reject otherwise.
3. **CAS pre-check**: `workflow.version === expected_version` else `conflict + current_version`; `workflow.current_version_id === version_id` else `conflict + current_version_id`.
4. **Load bindings** `bindings.find({workflow_id, version_id})` → every `proposed.binding_id` must exist in that set → validation reject.
5. **Repeat expansion** (Task 2; before artifact creation, spec §6): for each `repeat:true` proposal, server finds sibling bindings in the same `version_id` whose `source_values` contain the exact same value (inline `source_fp` + deep-equality), same `kind`, same scope contract → appends the mapping to each matching `source_index` with `via:"repeat"`. Never cross-kind. Expanded targets recorded in `repeated[]`.
6. **Per-proposal validation + local-target switch** (one typed `switch (binding.kind)` inside the owner — no per-kind validators):
   - `source_index` ∈ `[0, source_values.length)`.
   - **Partial mapping → reject**: each proposal must cover every index `0..count-1` of its binding.
   - `account` → `platform`+`shop_id` required; `local_id===shop_id`; shops doc exists with `{shop_id, platform}`.
   - `label` → `local_id` ∈ `conversations.distinct("labels")`.
   - `user` → `local_id` ∈ `admins.admin_id` with `active !== false`.
   - `team` → reject `unresolvable: team mapping unavailable — local team identity not defined` (publish-blocking).
   - `ticket_field`, `url` → reject `unresolvable` (spec §16/§11).
   - account scope fields only on account kind.
7. **Compute artifacts** (inline): `resolution.mappings` per proposed binding; merge carried mappings for non-proposed bindings (re-validate each carried target inline — missing → `state:"invalid"`, binding `invalid`). `source_fp` per mapping via inline `createHash("sha256").update(canonicalJson(v)).digest("hex")`. Version payload = canonical graph from current `WorkflowVersionDoc` + `resolution` → `stableFingerprint`; `seq = expected_version+1`; seq-bump orphan loop.
8. **Derive scope** (inline, fail-closed): from all `state:"valid"` account mappings → `platforms`/`shop_ids` unique sets. Account requirements present + zero eligible ⇒ empty arrays + `account_scope: no resolved account mappings`; requirements present + any binding `status !== "resolved"` or eligible count ≠ `count` ⇒ one `account_scope: incomplete account mappings`; all bindings resolved with complete valid coverage ⇒ no `account_scope` blocker — never match-all. Imported workflow with no account requirements ⇒ `scope: explicit global scope approval required` (not an `account_scope` blocker — no invented requirements).
9. **Insert immutable artifacts** (insert-idempotent, same resume convention as import): new `WorkflowVersionDoc`; version-scoped `WorkflowBindingDoc`s for every requirement (proposed-resolved + carried-valid/invalid + untouched-unresolved).
10. **Re-evaluate overlap inline** (same computation as the readiness owner — §8) → `overlap_conflicts` + blocker strings; recorded on the response; save still commits (spec §10).
11. **Commit**: `workflows.updateOne({workflow_id, is_deleted:{$ne:true}, version: expected_version}, {$set:{current_version_id, version: seq, enabled:false, status:"draft", platforms, shop_ids, updated_at, updated_by:actor}})` → `matchedCount===0` ⇒ `conflict`. Sole commit point — pointer+version+activation-state+derived-scope flip atomically.
12. **Audit after commit** (non-blocking, swallowed): `logAdminEvent({action_type:"workflow.binding_resolve", actor, metadata:{workflow_id, version_id, seq, resolved, unresolved, invalid, repeated: repeated.length, overlap: overlap_conflicts}})`. No success audit on validation/CAS failure.

---

## 7. Carry-forward truth tables

### Zaapi re-import revision (inside `applyImportBatch` — spec §6A)

Compare new-version binding requirement against the previous version's `WorkflowBindingDoc` with the same `(node_id, field_path, kind)`:

| Condition (ALL must hold) | Result |
|---|---|
| same `source_workflow_id` AND same `node_id` AND same `field_path` AND same `kind` AND same ordered `source_values` AND same `count` AND same scope contract AND every mapped local target still exists/valid | carry: new doc copies `resolution.mappings` with `carried:true`, status preserved |
| any condition fails | new `unresolved` doc (empty resolution); old immutable |
| node removed from graph | binding absent on new version; old intact |
| `source_values` reordered | condition fail → `unresolved` (positional `source_index` breaks) |

Seam: `applyImportBatch` binding-insert loop (`:632-642`) looks up the prev version's matching binding (prev = workflow `current_version_id` pre-repoint). `requirement_fp` equality gate computed inline; ordered `source_values` deep-equality authoritative.

### Local `saveWorkflowDraft` CAS revision (spec §8)

| Mutation | New-version binding |
|---|---|
| name/description/position/non-binding config | carried iff `requirement_fp` identical (replaces surviving-node-only clone at `:808-825`) |
| node deleted | dropped |
| subtype change / binding-consuming field removed | dropped |
| external-ID edit via editor | impossible (stripped at import) |
| resolution change | only via `saveBindingResolutionBatch` (own version) |
| carried mapping target deleted/missing | kept with `state:"invalid"`; binding `invalid`; readiness blocker |

---

## 8. Overlap truth table (publish-readiness — spec §10)

Overlap computation lives **inline inside `getWorkflowImportDetail`** (existing readiness owner — no helper). **Inputs: resolved `state:"valid"` account mappings' `(platform, shop_id)` set + `message_received` trigger presence in the version graph. Never derived from empty `shop_ids`/`platforms` arrays** — unresolved account scope contributes zero eligibility, not global scope.

| Case | Detection | Readiness output |
|---|---|---|
| imported vs imported, resolved `(platform, shop_id)` intersect, both `message_received` | scan `workflows` `import` present, `is_deleted:{$ne:true}`, other `workflow_id`; intersect **resolved** scope | blocker `overlap with imported workflow <wf_id>` |
| imported match-all `message_received` vs enabled+published **legacy** wf same scope | scan `workflows` `import` absent, `enabled:true`, `status:"published"`, `shop_ids`/`platforms` intersect (legacy empty = all vs the imported workflow's **resolved** set), has trigger node | blocker `overlap with legacy workflow <wf_id>` |
| imported revision vs another active imported workflow | same as row 1 | same |
| scope change introduces overlap inside resolution CAS | inline recompute at step 10 before commit | `overlap_conflicts` + `publish_blockers`; **save still commits** disabled draft |
| narrowed scope removes overlap | recompute yields empty set | blocker cleared on next readiness read |
| zero resolved accounts on a workflow with account requirements | derive yields empty → `account_scope` blocker; overlap contributes nothing | blocker `account_scope: no resolved account mappings` |
| `|E|>1` runtime fail-closed | **R2A** — not in R1 | — |

No `priority`/`created_at` winner; admin resolves by narrowing scope via re-resolution, disabling/unpublishing, or trigger-contract change (spec §10).

---

## 9. Failure / recovery truth table

| Failure | Expected behavior |
|---|---|
| stale `expected_version` | step 3 → `conflict`; zero artifacts, zero pointer mutation |
| stale `version_id` (≠ `current_version_id`) | step 3 → `conflict`; zero writes |
| wrong `workflow_id` (route vs body, or binding belongs to other wf) | step 1/4 → validation reject |
| binding from another workflow/version | step 4 lookup fails → reject |
| `source_index` out of bounds | step 6 → reject |
| duplicate `binding_id` | step 1 → reject |
| duplicate `(binding_id, source_index)` | step 1 → reject |
| `repeat:true` before Task 2 | step 1 → fail-closed `unsupported` reject; zero writes |
| wrong target kind (account→label etc.) | step 6 → reject |
| deleted/missing local target | step 6 → reject (proposed); carried → `state:"invalid"` |
| account missing `platform`/`shop_id` | step 6 → reject |
| client supplies `source_value`/`source_fp`/`display_value`/`sources`/identity keys | step 1 → reject |
| partial mapping | step 6 → reject |
| invalid carried target | carried `state:"invalid"`, status `invalid`, blocker |
| reordered `source_values` | carry table row 4 → `unresolved` |
| changed count/kind/field_path | `requirement_fp` mismatch → `unresolved` |
| crash after version insert | orphan `WorkflowVersionDoc`; retry reuses deterministic id |
| crash mid-binding insert | partial orphan bindings; retry `findOne`→skip-existing |
| crash before pointer CAS | old pointer + old derived scope stay together (no half-flip) |
| pointer CAS conflict | `matchedCount=0` → `conflict`; orphans never auto-current |
| concurrent same `expected_version` | exactly one `updateOne` winner; loser `conflict` |
| orphan artifacts | never auto-current; seq-bump never blocks future payloads |
| pointer + derived scope | one `$set` — never half-update |
| overlap-producing scope save | commits disabled draft; `publish_blockers` populated |
| narrowed scope | readiness recompute clears blocker |
| account requirements exist + zero resolved | `account_scope` blocker; disabled/draft; zero eligibility — never runnable match-all |
| imported direct scope edit | `updateWorkflow` → `CAS_REQUIRED` 422 (existing); `saveWorkflowDraft` → reject `shop_ids`/`platforms` when `import` present (inline check, Task 6) |
| legacy workflow behavior | unchanged — no `import` provenance → no binding paths; `platforms`/`shop_ids` still editable via CAS |
| imported engine-invisible | `listWorkflows(enabledOnly, publishedOnly)` unchanged; `enabled:false`+`draft` excluded |
| validation/CAS failure | zero success audit — `workflow.binding_resolve` emitted only after commit |

---

## 10. Complexity budget (spec §18 — closed, no pending approvals)

Full-design function/helper total **+4**: `saveBindingResolutionBatch` (R1), `getBindingResolutionView` (R1), `normalizeCanonicalExec` (R2A), `materializeExecutableWorkflow` (R2A).

| Kind | R1 count | Names / notes |
|---|---|---|
| Public service methods | **+2** | `saveBindingResolutionBatch`, `getBindingResolutionView` — the two approved R1 helpers |
| Private helpers | **+0** | SHA-256 inline `createHash(...)` at assignment sites; overlap inline in `getWorkflowImportDetail`; derived scope inline in commit path; local-target validation = one typed `switch` inside the owner; no nested functions |
| Guards | **+0 standalone** | strict-shape + scope-edit checks are inline branches inside existing owners |
| Decision owners | **+0** | all reads+writes inside `workflowService` |
| Collections | **+0** | reuse 5 workflow colls + shops/admins/conversations reads |
| Indexes | **+0** | `source_fp` digest index optional — measured first, deferred |
| Workers/timers/queues | **+0** | — |
| Regexes | **+0** | `REDACT_VALUE` reused for display safety — no new pattern |
| Keyword tables | **+0** | — |
| Route handlers | **+2** | GET+POST in one new route file — thin |
| UI components | **+1** | `BindingResolutionPanel.tsx` — presentational only |
| AdminActionType members | **+1** | `workflow.binding_resolve` |
| Runtime activation paths | **+0** | `FOUNDATION_GATES.runtimeActivation` stays `false` |
| Test files | **+2** | service suite + route suite (existing seam mechanism — no new dependency) |

---

## 11. TDD task sequence

Harness convention: `register(new URL("./<hooks>.mjs", import.meta.url))` before imports, `pass/fail` counters, `ok/eq` asserts — same as `test-workflow-persistence.ts`.

**Interfaces between tasks:**

- Task 1 produces: `BindingResolutionRequest`, `BindingResolutionResult`, `BindingResolutionView`, `ResolutionMapping` types; `saveBindingResolutionBatch` (complete contract minus repeat expansion); `workflow.binding_resolve` action. `repeat:true` → `unsupported` reject.
- Task 2 consumes Task 1's method + `repeat` field → produces `repeated[]` + `via:"repeat"` mappings.
- Task 3 consumes Task 1's commit path → adds fail-closed derived-scope semantics + `account_scope` blocker.
- Task 4 consumes inline `requirement_fp` pattern → gates carry in `applyImportBatch` + `saveWorkflowDraft`.
- Task 5 consumes `getWorkflowImportDetail` → produces `invalid_bindings` + `overlap_conflicts` fields + inline overlap computation.
- Task 6 consumes Task 5 readiness fields → `_assertActivationAllowed` checks `unresolved+invalid+blockers===0`; `saveWorkflowDraft` inline imported-scope rejection.
- Task 7 consumes Task 1's service method → produces `getBindingResolutionView` + thin route; route suite proves delegation + zero direct Mongo.
- Task 8 consumes Task 7's GET/POST → `BindingResolutionPanel` + editor wiring.
- Task 9 consumes everything → acceptance matrix + docs.

> Commands run from `ChatAdminWeb/`. Focused: `npx tsx scripts/test-workflow-binding-resolution.ts` (+ `test-workflow-binding-routes.ts` from Task 7). Regression: `npx tsx scripts/test-workflow-persistence.ts` (fresh baseline **210 passed, 0 failed**) and `npx tsx scripts/test-workflow-foundation.ts` (fresh non-corpus baseline **161 passed, 0 failed** — the Zaapi corpus census is a separate opt-in run via `ZAAPI_EXPORT_DIR`, not part of this count). Typecheck: `npx tsc --noEmit`.

### Task 1: Complete direct-resolution service contract

**Files:**
- Modify: `src/backend/service/workflowService.ts` — types (`BindingResolutionRequest`, `BindingResolutionResult`, `BindingResolutionView`, `ResolutionMapping`), `resolution` field on `WorkflowBindingDoc`, `createHash` import, `saveBindingResolutionBatch` (steps 1–4 + 6–12 minus repeat expansion; `repeat:true` → `unsupported` reject), `getBindingResolutionView` is Task 7.
- Modify: `src/backend/service/adminLogService.ts` — `"workflow.binding_resolve"` in `AdminActionType`.
- Test: `scripts/test-workflow-binding-resolution.ts` (new — registers `test-workflow-persistence-hooks.mjs`).

- [x] RED 1 (absence): import fixture via `applyImportBatch`; call `svcAny.saveBindingResolutionBatch(wfId, validReq, "admin_t")` → **absent/fails**; zero new docs across all 5 colls; zero `workflow.binding_resolve` events.
- [x] RED 2 (validation matrix — every case asserts reject + zero writes + zero audit): stale `expected_version`; stale `version_id`; `workflow_id` mismatch; binding from other workflow/version; `source_index` OOB; duplicate `binding_id`; duplicate `(binding_id, source_index)`; forbidden keys (`source_value`, `source_fp`, `node_id`, `display_value`, `sources`); account missing `platform`/`shop_id`; nonexistent shop; label not in `conversations.distinct`; missing/inactive `admin_id`; `team`/`ticket_field`/`url` proposals; partial mapping; non-imported workflow; `repeat:true` → `unsupported`.
- [x] RED 3 (happy path shape): direct resolution → `{ok:true, version, version_id, resolved, unresolved, invalid, publish_blockers, overlap_conflicts}`; new `WorkflowVersionDoc` (seq+1, graph identical, fingerprint covers graph+resolution); version-scoped bindings `resolved` with `via:"direct"`, `source_fp` = 64-hex SHA-256, `resolved_by`; old version+bindings byte-identical; pointer+`enabled:false`+`draft`+derived scope flipped atomically; `workflow.binding_resolve` audit emitted **after** commit only.
- [x] RED 4 (crash/conflict): `insertOneHook` throw mid-bindings → retry resumes on deterministic ids; `updateOneHook` veto on commit → `conflict`, orphans never current; concurrent duplicate request → one winner, loser `conflict`; forced failures emit **no** success audit.
- [x] Impl: complete method (no repeat expansion); commits nothing until every validation branch exists.
- [x] GREEN: `npx tsx scripts/test-workflow-binding-resolution.ts` all sections green; `npx tsc --noEmit` clean.
- [x] Regression: `npx tsx scripts/test-workflow-persistence.ts` still 210/210.
- [x] Commit: `feat: saveBindingResolutionBatch direct-resolution contract` (landed `c3d6c89`)

### Task 2: Repeat expansion

**Files:** `src/backend/service/workflowService.ts` (step 5 inside the method); test additions.

- [x] RED: `repeat:true` on account proposal → sibling bindings with identical source value + same `kind` + same scope get `via:"repeat"` mappings; `repeated[]` echoes every expanded target; cross-kind never transfers (account value inside a label binding is never mapped); `repeat` absent → `via:"direct"`; repeat expansion that would leave a sibling still partial → sibling stays `unresolved` (no auto-complete beyond same-value matches); crash mid-repeat-artifacts → retry idempotent.
- [x] Impl: expansion block inside step 5 only.
- [x] GREEN + regression + commit: `feat: binding-resolution repeat-apply` (implementation commit `ba6027b`)

> **Task 2 closeout:** repeat expansion implemented inside `saveBindingResolutionBatch` step-5/step-7 only — exact same-kind sibling expansion by `canonicalJson` deep equality (no substring/keyword/fuzzy/regex, no cross-kind, no scope inference), `via:"repeat"` + `repeated[]` sorted by binding_id→source_index; no new helper/guard/keyword/decision owner; production unique-index blocker still open; Task 3 not started.

### Task 3: Fail-closed account scope

**Files:** `src/backend/service/workflowService.ts` (step 8 derivation + `account_scope` blocker).

- [x] RED: account requirements exist + zero resolved → `account_scope` blocker + empty `platforms`/`shop_ids` + disabled/draft; partial unresolved account set → publish blocked; removing/invalidating last valid mapping → blocked zero eligibility; resolving exact accounts → derived set equals mappings; empty arrays never authorized match-all (`listWorkflows({enabledOnly:true, publishedOnly:true})` excludes; blocker present).
- [x] Impl: inline derive + blocker append.
- [x] GREEN + regression + commit: `feat: fail-closed derived account scope`

> **Task 3 closeout (commit `020118a` `feat: fail-closed derived account scope`):** inline scope readiness inside `saveBindingResolutionBatch` step-8b and recomputed inside `getWorkflowImportDetail` from version-scoped account bindings (authoritative — never `WorkflowDoc.platforms`/`shop_ids`). Final truth table: zero eligible account mappings ⇒ `account_scope: no resolved account mappings`; any account binding `status !== "resolved"` or eligible valid-mapping count ≠ `count` ⇒ `account_scope: incomplete account mappings`; all bindings `resolved` with complete coverage ⇒ no `account_scope` blocker; imported workflow with no account requirements ⇒ `scope: explicit global scope approval required` (separate blocker — no invented `account_scope`). Eligible mapping = `state:"valid"` + `platform` + `shop_id` present. Correction round 1: **M1** — complete readiness requires `status === "resolved"` (sticky `invalid` status with count-complete valid mappings now stays blocked; invalid status is never silently repaired — explicit direct resolution only); **M2** — empty imported scope is a blocked state via the explicit global-scope blocker while no global-scope contract exists. Save still commits disabled/draft; blockers are readiness output only (not persisted, not in fingerprint, not in raw provenance). Verified: binding-resolution 732/732, persistence 210/210, foundation 161/161, `tsc --noEmit` clean, `git diff --check` clean. Complexity delta: all +0 (no helper/function/guard/table/owner/flag/dep). Imported workflows remain `enabled:false`/`status:"draft"`; `_assertActivationAllowed` still consumes `getWorkflowImportDetail`; `FOUNDATION_GATES.runtimeActivation` unchanged; `listWorkflows` semantics unchanged. Production unique-index blocker still open; Task 4 not started.

### Task 4: Exact carry-forward (both mutation paths)

**Files:** `src/backend/service/workflowService.ts` (`applyImportBatch` binding loop `:632-642`; `saveWorkflowDraft` carry `:808-825`).

- [ ] RED: identical-requirement re-import → `carried:true`, status preserved; count-change → `unresolved`; reordered `source_values` → `unresolved`; removed node → absent; carried target deleted → `state:"invalid"` + `invalid` status; `saveWorkflowDraft` rename-only → carried (`requirement_fp` identical); subtype change same `node_id` → dropped.
- [ ] Impl: inline `requirement_fp` equality gate in both paths + carried-target re-validation.
- [ ] GREEN + regression + commit: `feat: exact binding carry-forward`

### Task 5: Overlap readiness (inline)

**Files:** `src/backend/service/workflowService.ts` (overlap block inline in `getWorkflowImportDetail`; `overlap_conflicts` on `WorkflowImportDetail` + resolution result).

- [ ] RED: imported↔imported same resolved scope + `message_received` → both blocked; imported↔enabled/published legacy same scope → blocked; disjoint resolved scope → clean; overlap-producing resolution commits disabled draft AND returns `overlap_conflicts`; narrowing clears; zero-resolved-account workflow contributes nothing to overlap sets (not global).
- [ ] Impl: inline overlap computation inside `getWorkflowImportDetail` — no helper.
- [ ] GREEN + regression + commit: `feat: overlap publish blocker in readiness`

### Task 6: Activation/scope ownership

**Files:** `src/backend/service/workflowService.ts` (`saveWorkflowDraft` inline imported-scope rejection; `_assertActivationAllowed` checks `unresolved+invalid+blockers===0`; `getWorkflowImportDetail` reports `invalid_bindings`).

- [ ] RED: `saveWorkflowDraft` with `shop_ids`/`platforms` on imported → throws; same on legacy → passes; `invalid_bindings` counted; `toggleWorkflow`/`updateWorkflow` enable on fully-resolved imported → still blocked by `FOUNDATION_GATES.runtimeActivation=false`.
- [ ] Impl: inline checks only.
- [ ] GREEN + regression + commit: `feat: imported scope ownership enforcement`

### Task 7: Thin API route + read view + route suite

**Files:**
- Modify: `src/backend/service/workflowService.ts` (`getBindingResolutionView` — second approved public method; composes `getWorkflowImportDetail` + `bindings.find` + `shops`/`admins`/`conversations.distinct` reads inside the owner).
- Create: `src/app/api/workflows/[workflowId]/bindings/route.ts` (GET+POST thin).
- Test: `scripts/test-workflow-binding-routes.ts` + `test-workflow-binding-routes-hooks.mjs` + `test-workflow-binding-routes-mocks.mjs` (new suite — see §13 for the frozen mechanism).

- [ ] RED (service): `getBindingResolutionView` returns `sources:[{source_index, display_value}]` with correct index/display pairing; account/label/user ids visible; `"[redacted]"`/`REDACT_VALUE`-matching values render `"[redacted]"`; no credential/URL leakage (fixture value containing a masked token).
- [ ] RED (route — exact assertions): GET 200; GET 404; POST 200; POST 409; POST 422 (incl. forbidden `source_value`/`display_value`/`sources` fields); handler delegates to `workflowService` (spy on stub args); route performs zero direct Mongo (mongoClient mock throws on any call → success responses prove delegation-only).
- [ ] Impl: `getBindingResolutionView` + thin route.
- [ ] GREEN: `npx tsx scripts/test-workflow-binding-routes.ts` all green.
- [ ] Regression + commit: `feat: binding-resolution API route + read view`

### Task 8: Binding-resolution UI

**Files:**
- Create: `src/components/workflow/BindingResolutionPanel.tsx` (presentational only — no business decisions)
- Modify: `src/components/workflow/WorkflowEditor.tsx` (wire panel into `NodeConfigPanel`; derived scope fields read-only with "derived from bindings" note; `loadedVersion` refresh on success; 409 toast + reload offer)

- [ ] RED (SSR markup assertions via `renderToStaticMarkup` inside `test-workflow-binding-resolution.ts`): `display_value` renders beside `source_index` labels; kind-scoped candidate options present/absent per bucket; team rows show "team mapping unavailable — local team identity not defined"; derived scope rendered read-only; overlap/blocker chips render.
- [ ] Interaction behaviors (repeat checkbox → `repeat:true`, 409 reload, picker selection) covered by the explicit browser canary in §15 — no fabricated automation; POST identity-field rejection already proven server-side in Task 1/7.
- [ ] Impl: panel + editor wiring; all authoritative validation stays server-side.
- [ ] GREEN (SSR section) + regression (`test-workflow-foundation.ts` 161/161 stays green) + commit: `feat: binding-resolution panel UI`

### Task 9: Acceptance matrix + docs

**Files:** `scripts/test-workflow-binding-resolution.ts`; `ChatAdminWeb/docs/DATA_SCHEMA.md`; `docs/plans/workflow-planner.md` status line; `getoutofmywaybotkaikrook2.md`.

- [ ] Full §9 failure table asserted row-by-row; credential-absence on persisted docs + audit events; engine-invisibility assertion; fake-mongo failure hooks at every boundary.
- [ ] Docs: `DATA_SCHEMA.md` `workflow_bindings.resolution` subsection + derived-scope ownership; planner status line; log completion.
- [ ] Commit: `test+docs: binding-resolution acceptance matrix`

---

## 12. Exact commands

```bash
cd ChatAdminWeb
npx tsx scripts/test-workflow-binding-resolution.ts   # focused service suite (count set by implementation — never fabricated)
npx tsx scripts/test-workflow-binding-routes.ts       # focused route suite (from Task 7)
npx tsx scripts/test-workflow-persistence.ts          # regression — fresh baseline 210 passed, 0 failed
npx tsx scripts/test-workflow-foundation.ts           # regression — fresh non-corpus baseline 161 passed, 0 failed
npx tsc --noEmit                                      # typecheck + type-contract gate
git diff --check                                      # whitespace
```

Corpus census is a separate opt-in run (`ZAAPI_EXPORT_DIR=/path npx tsx scripts/test-workflow-foundation.ts`); its count is independent of the 161 synthetic baseline. No real Mongo; no `npm run dev`; no service starts.

## 13. Frozen route-test mechanism (audited — exact)

The repo's module-register seam (`test-*-hooks.mjs` + `test-*-mocks.mjs`) already redirects leaf modules per-suite. Route tests use a **dedicated pair** because redirecting `workflowService`/`authorize` globally would break the service suite that exercises the real owner:

- `scripts/test-workflow-binding-routes-hooks.mjs` — `module.register` resolve hook redirecting:
  - `/src/backend/middleware/authorize.` → mocks (`requireAuth`/`requirePageEdit` return `state.auth` controlled ctx/response)
  - `/src/backend/service/workflowService.` → mocks (`workflowService.saveBindingResolutionBatch`/`getBindingResolutionView` return `state.svcResult`; args captured to `state.svcCalls` for delegation asserts)
  - `/src/backend/db/mongoClient.` → mocks (`getCollection`/`getDb`/`ensureIndexes` **throw** — proves route code performs zero direct Mongo: any direct call fails the handler and the test)
- `scripts/test-workflow-binding-routes-mocks.mjs` — exports the union above + `state`.
- Test file imports the **real route module** after registering hooks, constructs real `new NextRequest("http://localhost/api/workflows/wf_x/bindings", {method, body: JSON.stringify(...)})`, invokes exported `GET`/`POST` with `{params: Promise.resolve({workflowId})}`, asserts `Response.status` + `await res.json()` for each row: GET 200, GET 404, POST 200, POST 409, POST 422, forbidden identity/display fields → 422 (stub returns `validation` → mapped), delegation args captured, zero-Mongo proven by throwing mock.
- Auth failure path: `state.auth = {ok:false, response: <401 NextResponse>}` → assert middleware short-circuits before service stub is called (`state.svcCalls` empty).
- No new test dependency; no invented pure HTTP-mapping helper.

## 14. Documentation updates during implementation

- `ChatAdminWeb/docs/DATA_SCHEMA.md` — `workflow_bindings.resolution` subsection + derived-scope ownership note.
- `docs/plans/workflow-planner.md` — one status line noting R1 landed (respect SUPERSEDED markers).
- `getoutofmywaybotkaikrook2.md` — active-log entry updates.
- No `SRS_SSD.md` update — `workflowService.ts`/`workflowEngine.ts` are ChatAdminWeb TS, not `chatbot/shopeechat/` (rule 1 scope).

## 15. Commit sequence (1 commit = 1 verified, independently safe task)

1. `feat: saveBindingResolutionBatch direct-resolution contract` — complete validation+write contract; `repeat` fails closed
2. `feat: binding-resolution repeat-apply`
3. `feat: fail-closed derived account scope`
4. `feat: exact binding carry-forward`
5. `feat: overlap publish blocker in readiness`
6. `feat: imported scope ownership enforcement`
7. `feat: binding-resolution API route + read view`
8. `feat: binding-resolution panel UI`
9. `test+docs: binding-resolution acceptance matrix`

No commit leaves a writable method with incomplete validation, an accepted-but-unimplemented request field, an activation path, a parallel owner, or hidden helpers.

## 16. R1 exit gate

All must hold before claiming done:

- `test-workflow-binding-resolution.ts` + `test-workflow-binding-routes.ts` all-green; `test-workflow-persistence.ts` **210/210**; `test-workflow-foundation.ts` **161/161** (non-corpus); `npx tsc --noEmit` clean; `git diff --check` clean.
- §9 failure table: every row verified by an executable test.
- Imported workflows: `enabled:false`, `status:"draft"`, engine-invisible; zero-valid-accounts ⇒ `account_scope` blocker; activation blocked by gates + readiness.
- No new collections/indexes/workers/decision owners/private helpers; §10 counts hold exactly.
- **Browser canary (explicit steps, recorded in log)**: open imported draft → bindings list shows `display_value` beside `source_index`; pick scoped candidates; resolve → disabled draft + derived scope; repeat checkbox → `repeat:true` observed in request payload; force stale `expected_version` → 409 toast + reload offer; overlap blocker chip renders; team row shows unavailable note; derived scope read-only.
- No secrets/local paths in diffs; Phase 10B untouched; active log updated; **no push/merge/deploy**.

## 17. Remaining R2A–R5 (out of scope — pointers only)

- **R2A**: `normalizeCanonicalExec` (`ce/1`), `materializeExecutableWorkflow`, safe-node executor set, `|E|>1` fail-closed runtime (spec §7/§10/§14).
- **R2B**: external adapters, URL/media safety, ticket-field/review/marketplace/button/team entities — separate approval.
- **R3**: run `version_id` pinning + `node_trace` + run viewer.
- **R4**: authenticated sandbox per spec §12.
- **R5**: index DDL verify + canary + activation review (spec §17).

## 18. Rollback / safety notes

- Artifact inserts idempotent by deterministic id — crash-retry safe; orphans never auto-current.
- Pointer+scope write is one `updateOne` — no partial flips.
- Resolution commits only `enabled:false`/`draft` — worst case is a blocked disabled draft.
- `git revert` per commit boundary; no migrations, no DDL.
- Fake-mongo hooks inject failures at every boundary.
- Source/design conflict mid-implementation → stop and report; never invent a workaround.

## 19. Estimated duration

Spec §15/§19: **R1 = 4–5 working days** (sequential, TDD + docs + commits).

---

## 20. Design-to-source questions answered

- **A. Placement:** `saveBindingResolutionBatch` + `getBindingResolutionView` in `workflowService.ts`, exported on `workflowService` — same collection set, deterministic-id + CAS + audit conventions. No second persistence/read owner; route never touches Mongo.
- **B. API:** `POST`/`GET /api/workflows/[workflowId]/bindings` (§5); 404/409/422 per table.
- **C. Local targets:** account→`shops` (`platform`+`shop_id` required, `local_id===shop_id`); label→`conversations.distinct("labels")`; user→`admins.admin_id` (`active!==false`); `team`→unresolvable in R1 (no entity — UI "team mapping unavailable — local team identity not defined"); `ticket_field`/`url`→unresolvable.
- **D. Account canonical triple:** `platform` (`Platform` union), `shop_id` (shops.shop_id = config-domain key used by `listWorkflows`/`config_shop_key`), `local_id`=`shop_id`.
- **E. Deterministic payloads:** §4 inline digest contract.
- **F. Failure ordering:** §6 sequence — validate → repeat-expand → artifacts → single pointer+scope CAS → post-commit audit.
- **G. Carry-forward:** §7 truth tables.
- **H. Overlap:** §8 — inline in readiness, resolved-mapping intersection only.
- **I. Legacy unchanged:** no `import` provenance → no binding paths; manual scope editing retained.
- **J. Activation reject:** `updateWorkflow`, `toggleWorkflow`, `saveWorkflowDraft` (all via `_assertActivationAllowed`; readiness gains `invalid` count + overlap blockers); `applyImportBatch` force-off unchanged.
