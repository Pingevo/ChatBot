# Remaining Work Register — KB, Human Approval, Workflow, and Original Backlog

**As of:** 2026-11-11 (+0700) · **Branch observed:** `ui/mobile-ux-phase1` @ `8df0388` · **Status:** evidence-based rebaseline authorized by the user; operational gates remain task-specific.

## Purpose and authority

This is the single checklist for outstanding work. The user changed the sequence on 2026-11-09: **the bot-worker human-review mock pilot starts now, ahead of unfinished Zaapi KB work**. The master plan and each linked design remain the technical authority for their own scope. Mark an item complete only with code, data, and customer-boundary evidence, as applicable; a design simulation or commit alone is insufficient.

The user's standing architecture is: `kb_source=legacy` retains legacy KB behavior; `kb_source=zaapi` retrieves from the independent Zaapi KB source in the shared evidence pool. Catalog and units remain their own pool sources for products absent from Zaapi. There is no `both` selector or silent cross-KB fallback. Current file-backed imports are **full-file snapshots** keyed by filename; visibility uses the registry’s `(source_file, active_rev, active_apply)` triple. The older canonical `source_id`/stable-row diff design is superseded for this serving path (K1); this does not claim equivalent cross-revision row identity. The human-review pilot retains the bot draft and decisions in Admin Mongo and sends only after the designated admin approves.

## Status key and order

- **Open / Partial:** implementation or acceptance evidence remains.
- **Superseded:** replaced by the named current contract; this does not certify the old acceptance cases.
- **Rebaseline / Reconcile census:** contract applicability or conflicting observations must be resolved before acceptance.
- **Done:** the scoped work has recorded evidence; residual work is listed separately.
- **Design review:** a document/probe exists; production behavior has not been proven.
- **Deferred:** intentionally outside the current release, with a re-entry condition.
- **Blocked:** a prerequisite is missing; do not treat it as delivered.

**Order:** H0–H3 (human-review mock pilot) → unfinished K work (Zaapi KB) → H4/live-delivery gate → W0–W5 (Zaapi workflow) → R0–R5 (original remaining backlog). Support tasks S0–S3 run only when their dependent work needs them. The human-review pilot is a new priority, not a replacement for workflow, Phase 4B, Phase 5, prompt distillation, or analytics/logging. The H mock pilot never sends to Shopee.

## K — Finish Zaapi KB with real data and answers

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| K0 | Rebaseline | Review the current file-backed snapshot/visibility/scope contract instead of treating the canonical [diff-import review](2026-11-06-zaapi-kb-diff-import-design.md) as a prerequisite to implementing K1 again. Current owner: `kb_zaapi_files.py`; serving pivot recorded in [ledger A-118/A-168](../../waythrough-ledger.md). | Current import, retry/CAS, rollback, scope and filename identity contract has explicit review evidence; any still-required canonical semantics are tracked individually. |
| K1 | **Superseded** | User-approved rebaseline: file-backed `apply_import`/`rollback_import` replace the old canonical diff-import workstream for current serving. [Importer](../../../chatbot/shopeechat/kb_zaapi_files.py) implements full-file replacement, attempt-scoped staging, CAS visibility, audit and rollback. `_row_id` includes filename/revision/attempt/sheet/row index. | Superseded by the file-backed snapshot contract, not a claim that stable row IDs, changed-field updates or quarantine semantics from the old design were implemented. Contract review remains K0; retrieval/answer acceptance remains K3/K5. |
| K2 | Reconcile census | All 118 files are registered. [A-168](../../waythrough-ledger.md) recorded 75 active / 7,101 active rows; the user subsequently reports 118/118 active and 20,768 total rows from Mongo. The supplied type counts total 12,168, leaving 8,600 rows unexplained if intended as a complete breakdown. Remove the stale “88 files left” task; retain both observations until query scope/time is reconciled. | Attach a dated census using actual active revision/apply triples, per-file shop/platform scope and content types; distinguish all stored/retired rows from visible active rows. User-reported numbers are not independently re-queried by this docs update. |
| K3 | Partial | File-backed planner/adapter probes returned rows for all four sampled shops ([A-168](../../waythrough-ledger.md)); leading hits sometimes referenced other products. QA50 recorded 21 KB channel traces selecting zero rows (A-166). Adapter reachability is proven; relevance, selection into final context and attribution remain open. | Correct product and eligible scope-only evidence reaches the final answer for the right shop/platform, with source isolation and per-need attribution verified on real questions. |
| K4 | Dormant / rebaseline | Canonical `zaapi_kb_embedding_generations` is not the current serving owner; the user reports zero documents. File-backed serving is recorded in A-118/A-168 and [schema §5.14](../../schema.md). Do not schedule a canonical-generation build solely to satisfy this old row. | Record whether the canonical generation milestone is superseded or retained as a separate future architecture task. Current file-backed readiness, rollback and answer-quality obligations remain K0/K3/K5. |
| K5 | Open | Run actual-data customer-answer QA, source-isolation tests, and a bounded one-shop selector canary. Gemini calls and selector changes require their own authorized gate. | Correct answers, honest cannot-confirm cases, zero inactive-KB reads, cost/latency evidence, and audited `legacy ↔ zaapi` rollback are demonstrated. KB acceptance is independent of the H mock pilot. |

Phase 4 retrieval code and Task 5 pool integration were committed earlier; K0–K5 concern data readiness, repeat import, end-to-end retrieval, answer quality, and activation. “Data exists in Mongo” and “code is committed” do not close K5.

## H — Urgent pilot: admin approval before real bot-worker delivery

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| H0 | **Done** | Plan + 2 รอบ independent review ผ่าน (A-109→A-111); เสร็จใน PR #37 merged 2026-11-09. | Server-owned draft/recipient/product identity, approval authority and no-bypass paths verified — `reviewService.ts` owner เดียว |
| H1 | **Done** | `review_bubbles` freeze ตอน insert (storeBotReply+storeWorkflowDelivered); inline edit pending→approve แยก `edited_text`/`edited_approved`; reject ไม่มี send request; actor/time persist — tests C/E ผ่าน | Original immutable; saved edit remains pending; rejected bubble has no send request — verified A-109..A-122 |
| H2 | **Done** | `mockSendService.ts` seam: deterministic `mocksend:` events 1 per text bubble + typed `product_card` เมื่อ shop identity verify ผ่าน (entry.shop↔conv.shop_name); delivered:false เสมอ | No network send, no `sent_text`, dup clicks/op ids → single receipt; verified incl. real-Mongo validator failpoint 5/5 |
| H3 | **Done** | 35/35 review suite (incl. K1–K7 review fixes) + 20/20 boundary + live bot :8010 3 ร้าน + real SIGKILL crash recovery + Playwright UI 5/5 | Mongo/UI/receipts agree; zero actual Shopee delivery — PR #37 merged into main |
| H4 | Open | Recheck bot-worker and workflow output paths against the approval boundary before enabling additional traffic. | No enabled path can bypass the pilot approval rule; expansion beyond the pilot is separately reviewed. |

The existing [bot-worker script](../../../ChatAdminWeb/scripts/bot-worker.ts) and [bot-worker send route](../../../ChatAdminWeb/src/app/api/botworker/conversations/%5BconversationId%5D/send/route.ts) explicitly do **not** deliver to Shopee today. H2 proves mock receipts only; real marketplace delivery capability and its approval remain a separate gate.

## W — Zaapi workflow program, retained from the original plan

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| W0 | Partial — audit complete | [A-165](../../waythrough-ledger.md) rebaselined code/corpus/merged commits; this update aligns the register. Runtime uses `workflowCanonicalEval.ts`; planned `materializeExecutableWorkflow`/`ce/1` names are absent. | Remaining: browser canary evidence and closure of the runtime-contract documentation drift; no draft described as active. |
| W1 | Partial | A-165 records 21 flows / 218 nodes / 225 edges; user Mongo census reports 21 workflow documents, all disabled. Existing flow drafts satisfy that portion of import scope. | Remaining: import the one active source Basic Automation as a disabled local draft, fix the single-file handle gap, and retain round-trip/provenance/unresolved-binding evidence. |
| W2 | Partial | A-165 records runtime support for 31/31 used node types and 18/18 chat-flow E2E cases. Registry/engine implementation exists; node trace, marketplace adapter and real-Mongo binding evidence remain incomplete. | Persisted wait/retry/crash replay and real binding/adapter traces demonstrate no duplicate side effects; runtime contract matches the actual evaluator. |
| W3 | Partial | Binding/editor/replay work exists (A-165); migration of 53 Scenario Handling records and 11 personalities remains open, as does real binding resolution. | Each candidate has resolved local identity/owner/capability, conflict review and dry-run evidence; unsupported or unresolved behavior stays disabled. |
| W4 | Open | Add R2B and later external adapters only for verified platform capabilities, then R3–R5 version pinning, authenticated sandbox, DDL/canary. | Real adapter tests and one-shop/one-platform canary pass; imported flows activate incrementally. H4 approval policy applies to pilot traffic. |
| W5 | Open | Implement remaining applicable catalogue nodes after the 31 used types, only where authoritative event/action adapters exist. | Each enabled platform/node pair has contract and replay evidence; unsupported pairs remain unavailable. |

Workflow import, executable runtime, and live activation are separate milestones. The [workflow plan](../archive/workflow-planner.md) records partial R1 work and outstanding browser/activation gates; do not infer that the complete export is running.

## R — Original remaining backlog, still tracked

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| R0 | Partial | Prompt A/B measurements and lossless typed-context JSON compaction are recorded in A-139/A-154; the latter reduced serialized context bytes about 21% without removing facts. These are not a complete customer-answer regression or live cost/p95 proof. | Authorized live before/after quality, exact provider usage/cost and latency evidence pass; source facts/cards/identity remain correct. Coordinate with S1 and QA findings. |
| R1 | Partial — publish complete | [A-145](../../waythrough-ledger.md), commit `245d143` merged in main: generation `g20261110-054801-c989b70a` built/validated, Admin Accept performed CAS publication, bundle pointer verified, previous generation retained for rollback. | Remaining: observed 09:00 scheduler execution and cleanup/retention policy execution evidence. Build/publish implementation is not an outstanding task. |
| R2 | Open | **Original Phase 5:** supply and validate real production structured policy records before policy activation. This is not the discarded devworker-created Phase 5 draft. | Policy records have authoritative provenance, schema validation, scoped retrieval, and answer tests; no activation from prose/name matching. |
| R3 | Partial / operational gate | A-136 verified local review/mock canary through real inbound and then disabled the worker. Production expansion remains gated; cost-stop automation is unimplemented (manual watch was the prior user decision). | Confirm the current cost-stop/manual-watch policy, concurrency/admission, stop/recovery and H4 boundary before separately authorized deployment/traffic expansion; see [canary plan](2026-11-09-r3-botworker-canary-plan.md). |
| R4 | Blocked | Archive recovery and application index-contract correction completed (A-122/A-127); broad dedup is not complete. A-140 census/tooling remains blocked on external Sellcenter writer correction before cleanup/index remediation. | External writer owner resolves insertion contract; separately reviewed cleanup window, census, exact writes, rollback and uniqueness evidence complete. |
| R5 | **Done** | **Logging and Analytics Truth:** shared statsRange/Bangkok-tz contract (A-141), one audit action vocabulary + idempotent `review_op`/`mock_send` command events, provider logs with provider/model/key_ref/tokens/cost/latency/attempt/outcome + request_id/conv_id turn correlation (A-152/A-153, live census 120 enriched docs), workflow/import events (A-143), `request_id` propagated `chat()`→`callBot`→all 4 shadow-doc paths (A-162). | Verified 2026-11-10: stats-reconcile 10/10 mongo==js==naive; boundary 22/22 (E7b/E7c); pytest 10/10; probe +§7 per-bubble reconcile; real E2E join `ai_usage req b3c286c8-c1f`→shadow `sr_xly5jx22mwahkgnq` via generation_batch_id (A-163). Residual: `request_id` on shadow docs appears only on turns processed by the new Next.js code; live reconcile remains sample-level until new decided drafts; no browser UI pass. |

## S — Explicit support and deferred items

| ID | Status | Work and dependency | Done when |
| --- | --- | --- | --- |
| S0 | Deferred | Product↔product pairing remains under [deferred pairing contract](deferred-pairing-contract.md). | Re-enter only with structured connector facts for both sides, a typed relation owner, variant-safe attribution, and customer-answer canaries. |
| S1 | Open | Live KB/customer-answer QA remains incomplete. Current branch adds `S1_IDS`/`S1_DEBUG` capture in `s1_gold_qa.py` (`8df0388`), which is harness work rather than a passing QA result. | Authorized provider-budget run judges real answers against source facts, with route/context traces; fixtures remain labeled separately. |
| S2 | **Done** | Fixes `9b4cbee`, `f072ff4`, `b9d4a26`, `6c5be51` are merged. [A-150](../../waythrough-ledger.md) records full offline forward and reversed runs: each 1,975 passed / 15 skipped / 1 xfailed, exit 0; earlier focused reversed import batch 191 passed. | Recorded regression gate passed; this documentation rebaseline does not claim a fresh test run. |
| S3 | Open | Frozen 1–8624 is indexed; active semantic gaps listed in [ledger §7](../../waythrough-ledger.md) remain, including 1–594 and seven other intervals. Coverage remains partial. | Complete all active coverage gaps and independent review under AGENTS.md §8G; checksum integrity alone does not establish semantic coverage. |
| S4 | **Done** | **Buffer index-race:** worker up ก่อน Next instrumentation → unique indexes ยังไม่ถูกสร้าง → re-poll insert rows ซ้ำใน buffer_messages. เจอใน A-121 repro | Worker ensure indexes เองตอน start หรือใช้ upsert/findOneAndUpdate แทน insert-then-catch; หรือกำหนด startup order ชัดเจน |
| S5 | **Done** | **`product_store.find()` ไม่มี `max_time_ms`** (~4 จุด) — slow product query ทำให้ bot >90s → claim `bot_failed` → dormant (user-approved design: รอ inbound ปลุก ไม่ auto-retry) | Query timeout bound; re-measure คำถามสินค้า end-to-end |
| S6 | **Done** | `botCallTimeoutMs` 90s — measured 38,990 samples: p95=46.5s, >90s=2.3% (provider tail) → **decision: คง 90s** | monitor post-S5 |
| S7 | **Done** | `50af537` merged; [A-151](../../waythrough-ledger.md) verified default quota path `exports/.gemini_quota.json`, current process without reload, and real Uvicorn filter rejecting quota JSON/tmp while accepting Python. Two persistence/filter tests passed. | Closed for the documented runtime/default watcher; arbitrary custom watcher configurations were not certified. |
| S8 | Partial — code complete | `972aab4` merged: workflow `bot_products` persisted with E7b evidence; dead `DocLike.inbound_message_ids`/`batch_id` declarations and response `review_admin_id` removed ([A-143](../../waythrough-ledger.md)). Persisted inbound IDs remain in worker documents; broad database-field deletion is not part of this cleanup. | Remaining: observe a real multi-bubble bot answer through review and mock receipts. Delimiter splitting is proven by fixture/unit mechanics, without recorded live-path proof. |

## Current QA and parallel-session work

- **QA50 follow-ups (A-166):** stock false-negative, intent/comparison/compatibility answer quality, handoff queue outcome (sandbox documents 13/13 but assigned admin 0/13), response-versus-step token/cost reconciliation, and replay history/card anchors remain open. A-168 corrects the older inference that empty canonical collections meant the file-backed adapter was unavailable.
- **Shop QA 12 (A-168):** 12 selected, 5 started, 1 completed with immediate invoice handoff/human-wait, 4 first-turn timeouts at 180 seconds, 7 unstarted; full per-turn traces/quality/latency/usage/cost and preview remain pending. The subsequent parallel announcement A-169 resumes bounded health/timeout diagnosis; it is not completion evidence.
- **Mobile UX Phase 1 (A-164):** design/planning stage; no mobile implementation commit recorded. The branch name alone does not establish implementation.
- Evidence references are in the [canonical ledger](../../waythrough-ledger.md). Latest directly recorded serving census is A-168; newer user-reported Mongo counts are explicitly distinguished above. Historical semantic coverage remains partial.

## Maintenance rules for this register

1. Update a row only with a linked review, test, data census, or deployment result. Preserve historical results in the waythrough ledger; this register holds the current state.
2. When starting a task, cite its ID, branch, baseline, dependent gate, changed-file boundary, and definition of done. Do not combine unrelated work in one commit or approval request.
3. Any disagreement between an older plan and live code/data becomes an explicit rebaseline task. In particular, recheck the old Task 6A database census before using its commands.
4. Review customer answer quality and source attribution, not only unit tests or successful function calls. Live sends, provider spend, Mongo writes, selector flips, and deployment each use their own concrete authorization gate.
5. H0–H3 are complete. Continue current K3/K5/S1 evidence gathering within the authorized test scope; reconcile K2 census and K0/K4 architecture status. H4 and real delivery require their own reviewed gate. This documentation update authorizes no new provider spend, production writes or customer sends.
