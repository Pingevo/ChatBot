# conversations_shp Duplicate Remediation Plan

> **For agentic workers:** Execute this plan only after the external Sellcenter writer repository and owner are identified. Use TDD for writer changes. Every Mongo write and DDL step requires a separate operator approval.

**Goal:** Stop new duplicate conversation snapshots without stopping Sellcenter service, merge the existing duplicates without losing data, and enforce one `conversations_shp` document per `conversation_id`.

**Architecture:** Fix the external writer first so every refresh updates the stable conversation identity instead of inserting a new snapshot. After all old writer instances are drained, run a bounded, rerunnable cleanup that merges each duplicate group with CAS protection. Create and verify the unique index only after two consecutive clean censuses.

**Tech Stack:** External Sellcenter writer, MongoDB/PyMongo or the writer's existing Mongo client, Next.js instrumentation, existing `ChatAdminWeb` index owner.

**Related code:**

- `ChatAdminWeb/src/instrumentation.ts`
- `ChatAdminWeb/src/backend/db/mongoClient.ts`
- `ChatAdminWeb/src/backend/service/conversationService.ts`
- `docs/schema.md`
- `docs/SRS_SSD.md`

## 1. Confirmed Evidence

Read-only census performed on 2026-10-14 with temporary `load_dotenv(override=False)`. No env value, URI, credential, document body, customer name, or raw customer/shop ID was printed.

| Evidence | Result |
| --- | ---: |
| Collection | `conversations_shp` |
| Total documents | 151,853 |
| Documents with valid string `conversation_id` | 151,853 |
| Duplicate identity groups | 731 |
| Extra documents | 1,004 |
| Group sizes | 471 x2, 248 x3, 11 x4, 1 x5 |
| Cross-platform duplicate groups | 0 |
| Cross-shop duplicate groups | 0 |
| Different non-empty customer IDs in one group | 0 |
| Duplicate receive range | 2026-09-04 through 2026-10-14 |
| Duplicate documents inspected for cleanup readiness | 1,735 |
| Documents with legacy admin-assignment residue | 0 |
| Groups requiring special field preservation | 1 |

The failure is not a TikTok/Shopee collision and not a cross-shop identity collision. The duplicates are multiple temporal snapshots of the same logical conversation. New duplicates were still being produced on the audit date.

Current indexes include non-unique `{shop_id:1, conversation_id:1}` but no standalone unique `{conversation_id:1}`. `ensureIndexes()` tries to create the latter and receives E11000.

## 2. Root Cause and Non-Goals

### Root cause

The external Sellcenter mirror creates a new Mongo document for a refreshed conversation instead of updating the existing document selected by stable `conversation_id`. A changing/generated `_id`, `insertOne`, or an upsert filter that does not contain stable conversation identity can all produce this behavior. The exact external call site must be confirmed before implementation.

### Non-goals

- Do not change chatbot answer logic, Phase 2B.6, botworker, workflow, or LLM paths.
- Do not move authoritative ownership back into `conversations_shp`; `status_conversation` remains authoritative.
- Do not hide E11000, remove `unique:true`, or add another fallback reader.
- Do not introduce a second sync service, polling repair worker, or permanent cleanup scheduler.
- Do not delete duplicates before fixing and draining the old writer.

## 3. Options Considered

### Option A: Online writer-first migration (recommended)

Deploy an atomic-upsert writer, drain every old insert-style writer instance, clean existing duplicates, then create the unique index. Sellcenter remains available throughout.

**Advantages:** No service outage; fixes the source; cleanup is finite; no new subsystem.

**Cost:** Requires access to the external writer and controlled rollout evidence.

### Option B: Short maintenance stop

Stop the writer, clean duplicates, create the index, deploy the upsert writer, then resume.

**Advantages:** Simplest race model.

**Cost:** Brief ingestion interruption. Use only if online rollout cannot prove all old writer instances are drained.

### Option C: Cleanup while the old writer remains active (rejected)

The old writer can insert between final census and index creation. If the index is created first, the old writer begins failing with E11000. This option cannot guarantee correctness.

## 4. Global Safety Rules

1. Never display or persist `.env` values, URI, credentials, customer names, message bodies, or raw IDs in reports.
2. All audit commands are read-only unless an exact approval token is issued for the named write stage.
3. Dry-run is the default for cleanup tooling. `--apply` must require an exact token and a fresh in-process census.
4. Do not run botworker, chatbot requests, provider calls, or Shopee API calls as part of this migration.
5. Do not call global `ensureIndexes()` for DDL; create only the approved index on the approved collection.
6. Do not touch `status_conversation` or message documents.
7. Every write must be rerunnable and fail closed on concurrent changes.
8. Keep the current Phase 2B.6 working tree separate from this migration.

## 5. Target Writer Contract

The external writer must own one atomic operation per persisted conversation refresh:

```text
identity filter: { conversation_id: incoming.conversation_id }
operation: atomic update with upsert=true
new-document fields: stable identity and immutable creation fields
refresh fields: mirror-owned conversation fields only
```

Required behavior:

1. Two deliveries of the same snapshot produce one document.
2. A newer snapshot updates the existing document rather than replacing `_id`.
3. An older/out-of-order snapshot cannot regress the `last_message_*` tuple.
4. `created_at` does not move forward after initial creation.
5. `data_received_at` and `updated_at` are monotonic where the source contract permits it.
6. Missing optional fields in an incoming snapshot do not erase a known non-empty value unless the upstream contract explicitly marks deletion.
7. The writer never writes admin ownership fields such as `assigned_to` or `bot_handoff_at`.
8. Duplicate-key errors are surfaced and counted; they are not swallowed.

The writer should use its existing Mongo client and persistence owner. Do not add a helper layer if the existing write call can be corrected in place.

## 6. Execution Stages

### Stage 0: Locate and freeze the writer contract

**Owner:** External Sellcenter team

- Identify the exact repository, entrypoint, collection resolver, and Mongo write call.
- Record whether it currently uses `insertOne`, `replaceOne`, or `updateOne(..., upsert=true)` and its filter.
- List every running writer instance and deployment target.
- Confirm whether refresh events can arrive out of order.
- Confirm the expected semantics of missing fields.

**Gate:** Do not implement cleanup until the write call and all running instances are known.

### Stage 1: Add RED writer tests

The external writer test suite must pin:

1. Same `conversation_id` delivered twice leaves one document.
2. Newer refresh preserves `_id` and updates the mirror fields.
3. Older refresh cannot replace a newer `last_message_timestamp`, `last_message_id`, or `last_message_text` tuple.
4. Missing `customer_id` cannot erase a known non-empty value.
5. A later non-empty `customer_id` fills an earlier missing value.
6. Different conversations remain independent.
7. Mongo failure returns a failed persistence result and does not report success.

Capture the pre-fix RED output. A mock that merely counts method calls is insufficient; the fake must enforce unique identity and update semantics.

### Stage 2: Correct the writer in place

- Replace snapshot insertion or unstable-filter upsert with one atomic operation keyed by `conversation_id`.
- Preserve the existing document `_id`.
- Update the `last_message_*` fields as one tuple selected by the newest `last_message_timestamp`.
- Use `$setOnInsert` or the equivalent for immutable creation fields.
- Update non-empty optional identity fields without replacing them with absent/empty input.
- Do not add retry loops, a repair daemon, or a second persistence owner.

**Gate:** All Stage 1 tests pass and the diff contains one persistence owner.

### Stage 3: Roll out the writer without service downtime

1. Start the corrected writer instance.
2. Route new work to it.
3. Drain and terminate every old insert-style instance.
4. Prove from process/container inventory that no old instance remains.
5. Observe at least two mirror cycles.
6. Run two read-only duplicate censuses separated by at least one minute.

Existing duplicate count may remain 731 during this stage, but it must not increase. If it increases, abort cleanup and return to Stage 0.

### Stage 4: Build one-time cleanup tooling

Recommended location if tooling is kept in this repository:

```text
ChatAdminWeb/scripts/dedupe-conversations.ts
ChatAdminWeb/scripts/test-dedupe-conversations.ts
```

Required CLI contract:

```text
default                     read-only dry-run
--apply                     rejected without exact approval token
--batch-size N              bounded, validated integer
--resume-after ID           deterministic resume cursor
```

The script must use one Mongo client, close it in `finally`, sanitize errors, and return non-zero on cleanup or close failure. It must not import application startup or `ensureIndexes()`.

Canonical merge rules per duplicate group:

1. Start with the document having maximum `data_received_at`, then `updated_at`, then `_id` as a deterministic tie-breaker.
2. Set `created_at` to the earliest valid value.
3. Set `data_received_at` and `updated_at` to their maximum valid values.
4. Copy the entire `last_message_id`, `last_message_text`, and `last_message_timestamp` tuple from the document with maximum `last_message_timestamp`.
5. Fill fields missing from the canonical snapshot using the newest non-empty value from older snapshots.
6. Preserve a non-empty raw `status` if the selected snapshot lacks it, but never treat it as ownership authority.
7. Never copy legacy admin ownership fields.
8. Leave unknown conflicting non-empty fields unchanged and report the group for manual review rather than guessing.

The audit found one current group that exercises rules 4 and 6; tests must include both cases.

### Stage 5: RED cleanup tests

Tests must prove:

1. Dry-run performs zero writes.
2. The 2/3/4/5-document groups converge to one document.
3. The last-message tuple is never mixed across snapshots.
4. Missing latest `status` preserves the older non-empty value.
5. Missing latest customer field is filled from a non-empty snapshot.
6. Concurrent writer change causes CAS loss and leaves the group untouched for the next run.
7. Canonical update failure prevents deletion.
8. Partial deletion is rerunnable.
9. Unknown non-empty conflicts are reported and not auto-resolved.
10. Cleanup never writes `status_conversation` or messages.

### Stage 6: Production dry-run

Run once against the real DB with no `--apply`:

- Reproduce the 731 groups and 1,004 proposed deletions, adjusted only for new evidence.
- Report each merge-rule count without printing document values.
- Require unresolved-conflict count = 0.
- Require writer-stability evidence from Stage 3.
- Produce an exact write manifest: canonical updates and extra `_id` deletions, represented by non-reversible digests in logs.

**Approval gate:** Stop and request a cleanup token. Dry-run approval does not authorize writes.

### Stage 7: Apply bounded cleanup

For each batch:

1. Re-read the group.
2. Recompute the canonical merge.
3. Update the canonical document with a CAS filter over `_id` and observed freshness fields.
4. If CAS misses, skip the whole group and report it.
5. Delete only the exact observed extra `_id` values after the canonical update succeeds.
6. Re-read and require exactly one document for the identity.

Run bounded batches until complete. Do not loop indefinitely; each invocation has a fixed maximum batch count and explicit resume cursor.

### Stage 8: Clean census and unique index

1. Run two full censuses separated by at least one writer cycle.
2. Require duplicate groups = 0 and invalid identities = 0 both times.
3. Request a separate DDL approval token.
4. Create exactly:

```js
{ conversation_id: 1 }, { unique: true, sparse: true }
```

5. Verify with `listIndexes` that key, `unique`, and `sparse` exactly match.
6. Exercise one normal writer refresh and verify document count for that identity remains one.
7. Restart only the Next.js admin service and require no `ensureIndexes` E11000 warning.

### Stage 9: Observation and closeout

For at least 24 hours:

- Duplicate groups remain 0.
- Writer duplicate-key failures remain 0.
- Inbound conversation refreshes continue.
- Latest-message rendering, unread count, ownership, close/reopen, and handoff smoke checks pass.
- No fallback or manual repair process is running.

Update `docs/schema.md`, `docs/SRS_SSD.md`, and the active waythrough log with the final writer owner, index evidence, cleanup counts, and residual risks.

## 7. Rollback

### Writer rollback

Never roll back to an insert-style writer after the unique index exists. Keep a patched previous release that retains the stable-identity upsert contract. If the corrected writer must be withdrawn, stop ingestion rather than reintroducing duplicate creation.

### Cleanup rollback

Before apply, create an operator-approved backup of exactly the affected documents outside Git. Verify backup count and restore procedure without printing data. Cleanup updates canonical before deleting extras, so a failed run remains rerunnable. Restore only the affected identity groups if post-cleanup verification finds lost data.

### Index rollback

Dropping the unique index is not a normal rollback. Do so only when a verified writer compatibility defect prevents ingestion, and keep the upsert writer active while correcting the defect.

## 8. Acceptance Criteria

The remediation is complete only when all are true:

- External writer uses one stable-identity atomic upsert owner.
- All old insert-style instances are absent.
- Two consecutive full censuses report zero duplicates.
- Unique sparse `conversation_id_1` exists and matches the exact contract.
- A live writer refresh updates one document without changing `_id`.
- Next.js startup has no E11000 warning.
- Core conversation display, ownership, handoff, close/reopen, and latest-message smoke checks pass.
- Twenty-four-hour monitoring reports no recurrence.

## 9. Estimated Time

| Work | AI-agent execution estimate |
| --- | ---: |
| Locate/audit external writer | 20-45 minutes |
| Writer RED tests + minimal fix | 45-90 minutes |
| Controlled rollout and stability census | 20-40 minutes |
| Cleanup tooling + tests | 60-120 minutes |
| Dry-run, approved apply, index verification | 30-60 minutes |
| Observation | 24 hours elapsed time |

Expected engineering time is approximately 3-5 hours if the writer repository and deployment owner are available. The 24-hour observation runs without blocking offline Phase 2B.6/2B.7 work.

## 10. Current Verdict

`ROOT_CAUSE_CONFIRMED_WRITER_FIX_REQUIRED_BEFORE_CLEANUP`

Phase 2B.6 can continue offline in parallel. Production deployment remains blocked until the writer, cleanup, and unique-index gates are complete.
