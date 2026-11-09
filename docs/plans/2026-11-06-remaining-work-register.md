# Remaining Work Register — KB, Human Approval, Workflow, and Original Backlog

**As of:** 2026-11-06 · **Branch observed:** `feature-botlogic-kb-workflow` @ `c289371` · **Status:** planning register, not an implementation approval.

## Purpose and authority

This is the single checklist for outstanding work. The user changed the sequence on 2026-11-09: **the bot-worker human-review mock pilot starts now, ahead of unfinished Zaapi KB work**. The master plan and each linked design remain the technical authority for their own scope. Mark an item complete only with code, data, and customer-boundary evidence, as applicable; a design simulation or commit alone is insufficient.

The user's standing architecture is: `kb_source=legacy` retains legacy KB behavior; `kb_source=zaapi` retrieves from the independent Zaapi KB source in the shared evidence pool. Catalog and units remain their own pool sources for products absent from Zaapi. There is no `both` selector or silent cross-KB fallback. Re-uploaded Zaapi files are **full source snapshots**, identified by explicit `source_id`, regardless of filename. The human-review pilot retains the bot draft and decisions in Admin Mongo and sends only after the designated admin approves.

## Status key and order

- **Open:** implementation or acceptance evidence remains.
- **Design review:** a document/probe exists; production behavior has not been proven.
- **Deferred:** intentionally outside the current release, with a re-entry condition.
- **Blocked:** a prerequisite is missing; do not treat it as delivered.

**Order:** H0–H3 (human-review mock pilot) → unfinished K work (Zaapi KB) → H4/live-delivery gate → W0–W5 (Zaapi workflow) → R0–R5 (original remaining backlog). Support tasks S0–S3 run only when their dependent work needs them. The human-review pilot is a new priority, not a replacement for workflow, Phase 4B, Phase 5, prompt distillation, or analytics/logging. The H mock pilot never sends to Shopee.

## K — Finish Zaapi KB with real data and answers

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| K0 | Design review | Independently review [diff-import design](2026-11-06-zaapi-kb-diff-import-design.md) rev8, including full-state no-op, same-file quarantine retry, account changes, lineage, CAS, and unresolved source-key declarations. | Review findings are closed; approved contract and executable acceptance cases agree. `[sim]` remains labeled simulation. |
| K1 | Open | Implement full-snapshot diff-import after K0: stable row UID, 1:N account records, changed-field updates, deactivation confirmation, hold-publish for failed existing rows, revision-bound quarantine for failed new rows, immutable revision, import log. | Tests through the actual importer/schema owners pass for unchanged/edited/new/removed/renamed rows, cold restart, duplicate keys, crash/retry, account delta, and CAS conflict; unchanged records/IDs remain stable. |
| K2 | Open | Re-census the actual Admin Mongo collections read-only, then import the 118 declared sources into canonical typed records under the approved write and provider budget gates. The old [Task 6A runbook](task6a-rerun-canonical-import-plan.md) is **not an executable instruction yet**: its raw-collection census conflicts with later ledger reports and predates the diff-import design. | Source count/hash, row/account counts, unresolved/quarantined counts, import logs, and immutable manifest membership reconcile with the live corpus; legacy `zaapi_kb` stays available for rollback. |
| K3 | Open | Verify Zaapi search coverage over product and eligible scope-only records, exact and semantic channels, shop/platform isolation, and per-need attribution. Preserve independent pool ownership; do not merge Zaapi facts into catalog/units. | Real canonical records, including FAQ/policy/note/troubleshooting cases allowed by the approved contract, can be retrieved for the right scope; wrong-source and wrong-shop reads are zero. |
| K4 | Open | Build and validate eligible v2 generation artifacts from K2–K3, publish via generation pointer CAS, and expose readiness from the actual loaded generation. | Artifact chain/model identity validate; active generation loads and retrieves without canonical collection reads per request; bad/missing artifacts fail closed; rollback returns to the prior valid state. |
| K5 | Open | Run actual-data customer-answer QA, source-isolation tests, and a bounded one-shop selector canary. Gemini calls and selector changes require their own authorized gate. | Correct answers, honest cannot-confirm cases, zero inactive-KB reads, cost/latency evidence, and audited `legacy ↔ zaapi` rollback are demonstrated. KB acceptance is independent of the H mock pilot. |

Phase 4 retrieval code and Task 5 pool integration were committed earlier; K0–K5 concern data readiness, repeat import, end-to-end retrieval, answer quality, and activation. “Data exists in Mongo” and “code is committed” do not close K5.

## H — Urgent pilot: admin approval before real bot-worker delivery

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| H0 | Design review | Start now: use the [per-bubble mock-send plan](2026-11-09-botworker-human-approval-mock-send-plan.md) to review `shadow_replies`, bot-worker UI/API, assignment ownership and outbound paths for one designated admin and one Shopee shop. | Server-owned draft/recipient/product identity, approval authority and no-bypass paths are explicit. Existing `/botworker` send remains sandbox-only. |
| H1 | Open | Store original and per-bubble drafts on generation; show approve, edit and reject per bubble. Inline editor has **บันทึก / บันทึกและส่ง / ยกเลิก**. | Original is immutable; saved edit remains pending; rejected bubble has no send request; state and actor/time survive refresh. |
| H2 | Open | Add conditional review decisions and a **mock-only** Shopee send seam: one request per approved text bubble, plus a separate typed card request when item identity is verified. | No network send, no live flag change, no `sent_text` from mock; duplicate clicks/retries do not create duplicate mock requests; existing sandbox composer remains distinct. |
| H3 | Open | Test approvals, edits, reject, `|||` ordering, product-card identity, failure/retry and unauthorized decisions against the persisted mock request log. | Mongo review state, UI and mock receipts agree; zero actual Shopee delivery. Live canary is a later, separately authorized gate. |
| H4 | Open | Recheck bot-worker and workflow output paths against the approval boundary before enabling additional traffic. | No enabled path can bypass the pilot approval rule; expansion beyond the pilot is separately reviewed. |

The existing [bot-worker script](../../ChatAdminWeb/scripts/bot-worker.ts) and [bot-worker send route](../../ChatAdminWeb/src/app/api/botworker/conversations/%5BconversationId%5D/send/route.ts) explicitly do **not** deliver to Shopee today. H2 therefore includes a genuine platform-delivery capability, not a relabeling of a Mongo write.

## W — Zaapi workflow program, retained from the original plan

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| W0 | Open | Rebaseline [workflow runtime design](../superpowers/specs/2026-10-27-zaapi-workflow-runtime-design.md), R1 branch/commit status, current code, and capability matrix. | Exactly which R1 binding/persistence/browser gates are merged and verified is documented; no draft is described as active. |
| W1 | Open | Import all 21 active Zaapi flows and one active Basic Automation as **disabled local drafts**; preserve 218 nodes, 225 edges, order, positions, unresolved bindings, and source provenance. | Counts and round-trip match; unresolved/overlapping drafts cannot publish. |
| W2 | Open | Complete R2A runtime materialization and the 31 used node types through the existing registry/engine; persisted waits, retries, operation keys, trace, and branch replay. | Node/branch tests and crash/retry replay pass without duplicate side effects. |
| W3 | Open | Complete editor bindings, explicit local identity mapping, Scenario Handling and persona migration, conflict review, and publish gates. | Every active candidate has resolved bindings/owner/capability and a dry-run replay; unsupported behavior stays disabled. |
| W4 | Open | Add R2B and later external adapters only for verified platform capabilities, then R3–R5 version pinning, authenticated sandbox, DDL/canary. | Real adapter tests and one-shop/one-platform canary pass; imported flows activate incrementally. H4 approval policy applies to pilot traffic. |
| W5 | Open | Implement remaining applicable catalogue nodes after the 31 used types, only where authoritative event/action adapters exist. | Each enabled platform/node pair has contract and replay evidence; unsupported pairs remain unavailable. |

Workflow import, executable runtime, and live activation are separate milestones. The [workflow plan](workflow-planner.md) records partial R1 work and outstanding browser/activation gates; do not infer that the complete export is running.

## R — Original remaining backlog, still tracked

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| R0 | Open | **Prompt distillation:** after typed answer/finalizer and activation behavior are stable, measure exact prompt payload, answer-call count, median/p95 tokens, latency, cost, and answer accuracy; then reduce duplication. | Before/after measurements and customer-answer regression pass; no prompt rewrite substitutes for retrieval correctness. |
| R1 | Open | **Phase 4B operator setup:** first manual image-text/embedding refresh, generation validation, time/cost measurement, 09:00 schedule, atomic generation switch, old-generation cleanup policy. This is distinct from the Zaapi KB Phase 4 generation work. | Operator runbook and first refresh are verified; scheduler and rollback evidence exist. |
| R2 | Open | **Original Phase 5:** supply and validate real production structured policy records before policy activation. This is not the discarded devworker-created Phase 5 draft. | Policy records have authoritative provenance, schema validation, scoped retrieval, and answer tests; no activation from prose/name matching. |
| R3 | Open | **Bot-worker production canary:** cost stop, concurrency 1, one-shop admission, forced stop, restart/recovery, deployment gate. Align with H0–H4 so the canary cannot bypass human approval. | [Canary plan](botworker-canary-plan.md) gates pass with observed provider/DB evidence and authorized deployment. |
| R4 | Open | **Database/writer maintenance:** external writer corrections, duplicate cleanup, uniqueness/index verification, inbound lifecycle. Schedule writes separately. | Before/after census and rollback plan are reviewed; no production cleanup from application-code readiness alone. |
| R5 | Open | **Logging and Analytics Truth:** three analytics pages share one time-window/timezone contract and authoritative queries; audit events use one action vocabulary and idempotent command events; provider logs contain actual provider/model, safe key reference, tokens, cost, latency, attempt, outcome, turn correlation; workflow/import events feed observability. | Numbers reconcile with source collections and provider usage; trace a real turn/import/approval decision end to end. The minimal audit events required by H1–H3 ship with H, while this broader analytics program remains R5. |

## S — Explicit support and deferred items

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| S0 | Deferred | Product↔product pairing remains under [deferred pairing contract](deferred-pairing-contract.md). | Re-enter only with structured connector facts for both sides, a typed relation owner, variant-safe attribution, and customer-answer canaries. |
| S1 | Open | Gemini live QA for KB/answer quality, under an authorized provider budget. | Real prompts and answers are judged against source facts; stub/fixture results are labeled separately. |
| S2 | Open | Diagnose the dotenv test-order isolation flake when it blocks a required regression gate. | Cause reproduced and fixed without weakening the test; forward/reverse batch exits zero. |
| S3 | Open | Waythrough semantic-coverage migration remains partial; use targeted reads for current work. | Ledger coverage becomes complete only under AGENTS.md §8G, including independent review. |

## Maintenance rules for this register

1. Update a row only with a linked review, test, data census, or deployment result. Preserve historical results in the waythrough ledger; this register holds the current state.
2. When starting a task, cite its ID, branch, baseline, dependent gate, changed-file boundary, and definition of done. Do not combine unrelated work in one commit or approval request.
3. Any disagreement between an older plan and live code/data becomes an explicit rebaseline task. In particular, recheck the old Task 6A database census before using its commands.
4. Review customer answer quality and source attribution, not only unit tests or successful function calls. Live sends, provider spend, Mongo writes, selector flips, and deployment each use their own concrete authorization gate.
5. The next action is **H0** using the 2026-11-09 mock-send plan. The KB work resumes after H0–H3; H4 and real delivery require a separate reviewed gate. Nothing in this register authorizes production writes or real customer messages.
