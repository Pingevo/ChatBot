# BotWorker review, handoff analysis and edit UI Implementation Plan

> For agentic workers: use the executing-plans skill. Execute each task in order; every implementation task starts with a failing behavioral test.

**Goal:** Make BotWorker review decisions, handoffs, delivery outcomes and admin actions auditable, then expose filtered visual and conversation-level analysis.

**Architecture:** Keep shadow_replies as the current answer and handoff review projection, botworker_events as the append-only audit timeline, reviewService as the review transition owner, assignmentService/handoffService as the existing BotWorker sandbox assignment owners, and add a server-side analysis service plus a BotWorker view. Do not create a generic workflow or write live Tickets assignment state.

**Tech Stack:** Next.js 16 App Router, TypeScript, MongoDB, React, Recharts, existing tsx fake-Mongo behavioral harness.

**Spec:** docs/superpowers/specs/2026-11-25-botworker-review-handoff-analysis.md

## Global Constraints

- Any admin with BotWorker page access can inspect and act on BotWorker reviews; every action records the actual actor.
- The Shopee live-send switch remains OFF; no test may call Shopee, upload media, or send to a real customer.
- When sending is OFF, a review action records its decision without calling a live or mock sender.
- A bot handoff flag waits for reviewer approval and stays inside the existing BotWorker sandbox assignment domain.
- A handoff suggestion or candidate selection does not assign work or advance round robin.
- Rejection requires a reason; preserve original text, every edit, actor identity, and timestamps.
- Analysis uses server-side filters and Asia/Bangkok calendar boundaries; only confirmed real provider success counts as a real send.
- Do not read .env files, inspect credentials, access provider APIs, or modify product DBs.

## Review Focus

- Same operation ID with changed action, text, reason, or assignee must conflict without duplicate actions or side effects.
- Missing rejection reason must leave the draft pending and call no sender or assignment owner.
- Two different admins with BotWorker page access may review any enabled shop; an account without page access must be denied.
- Handoff admin going offline or becoming ineligible between preview and approval must fail closed without fallback assignment.
- Date boundaries, multiple selected dates, and pagination must produce consistent chart totals and conversation results.

---

### Task 1: Review decision and audit owner

**Files:**
- Modify: ChatAdminWeb/src/backend/service/reviewService.ts
- Modify: ChatAdminWeb/src/backend/service/botworkerEventService.ts
- Modify: ChatAdminWeb/src/backend/service/shadowReplyService.ts
- Modify: ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/review/route.ts
- Modify: ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts
- Test: ChatAdminWeb/scripts/test-botworker-review.ts
- Test seams: ChatAdminWeb/scripts/test-botworker-review-hooks.mjs and test-botworker-review-mocks.mjs

**Interfaces:**
- Extend each review bubble with rejection reason, edit history, actor display-name snapshot, and separate review and delivery state.
- Review actions receive server-derived actor ID/name and require reason for reject.
- Deterministic operation IDs remain the idempotency owner; append action/outcome events in botworker_events.
- Review authorization uses the configured reviewer ID across BotWorker shops; keep requirePageAccess.

- [ ] Add behavioral cases for reason-required rejection, original/edit history, actor/timestamps, OFF sender count = zero, and reviewer across shops.
- [ ] Run only the review script and confirm the new assertions fail on current behavior.
- [ ] Implement minimal typed projection and event persistence; persist decision and audit intent before any explicit sender call.
- [ ] Run review script; verify OFF never calls either sender and retry/replay is idempotent.
- [ ] Update docs/schema.md and ChatAdminWeb/docs/DATA_SCHEMA.md for new review/audit fields.

### Task 2: Reviewer-gated BotWorker handoff

**Files:**
- Modify: ChatAdminWeb/src/backend/service/botWorkerService.ts
- Modify: ChatAdminWeb/src/backend/service/assignmentService.ts
- Modify: ChatAdminWeb/src/backend/service/handoffService.ts
- Modify: ChatAdminWeb/src/backend/service/reviewService.ts
- Create: ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/handoff-preview/route.ts
- Modify: ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/review/route.ts
- Modify: ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts
- Test: ChatAdminWeb/scripts/test-botworker-review.ts

**Interfaces:**
- Preview returns an uncommitted suggestion and all active, online, accepting, eligible admins; it must not reserve the round-robin cursor.
- Handoff review actions receive reply ID, operation ID, decision, selected admin ID, and rejection reason; persist handoff_required, reason/handoff_reason, handoff_explanation, answer, and exact source conversation/message IDs separately.
- Approval revalidates the exact selected admin and commits through handoffService with a deterministic operation key; no fallback to another admin.

- [ ] Add tests for engine handoff and trigger handoff staying pending; exact reason codes/explanation/answer/IDs staying separate; conflicting upstream IDs failing closed; preview leaving assignment/cursor unchanged; selecting another online admin; self-assignment; rejection reason; and offline-at-commit conflict.
- [ ] Run the review script and confirm each new behavior fails before implementation.
- [ ] Remove automatic pickAgent calls from bot-response and trigger handoff branches; persist a handoff review item tied to source messages.
- [ ] Add read-only candidate preview using existing assignment pool order and current online status.
- [ ] Add exact-recipient commit through the existing BotWorker test assignment owner, with revalidation and operation-key idempotency.
- [ ] Run review script; assert no Tickets status writes and no external delivery on handoff approval/rejection.
- [ ] Update docs/schema.md and ChatAdminWeb/docs/DATA_SCHEMA.md.

### Task 3: Server-side BotWorker review analysis

**Files:**
- Create: ChatAdminWeb/src/backend/service/botworkerReviewAnalyticsService.ts
- Create: ChatAdminWeb/src/app/api/botworker/review-analysis/route.ts
- Modify: ChatAdminWeb/scripts/test-botworker-review.ts
- Modify: ChatAdminWeb/scripts/test-botworker-review-hooks.mjs
- Modify: ChatAdminWeb/scripts/test-botworker-review-mocks.mjs

**Interfaces:**
- GET accepts granularity day/month/year, one or more selected period values, supported shop/platform/reviewer/decision/handoff/assignee/delivery filters, search, and cursor/limit.
- Response contains period summaries/charts and a paginated conversation list with complete chronological review/handoff events.
- Convert Asia/Bangkok calendar periods to UTC query boundaries server-side; use shadow_replies and botworker_events only.

- [ ] Add fake-Mongo tests for Bangkok day edges, multi-day and month/year selection, filters, pagination, incomplete legacy records, and confirmed-send-only metrics.
- [ ] Run the script and confirm the tests fail on the missing API.
- [ ] Implement aggregate/query owner and authenticated route restricted by BotWorker page access.
- [ ] Run the script and verify all metrics and details use the same date/filter contract across pages.

### Task 4: BotWorker review and analysis UI

**Files:**
- Modify: ChatAdminWeb/src/app/(console)/botworker/page.tsx
- Create: ChatAdminWeb/src/components/botworker/BotworkerReviewAnalysis.tsx
- Modify: ChatAdminWeb/src/lib/services.ts
- Modify: ChatAdminWeb/src/lib/types.ts
- Test: ChatAdminWeb/scripts/test-botworker-review.ts (API contract assertions)

**Interfaces:**
- BotWorker page exposes inbox and analysis views to any admin with BotWorker page access.
- Review editor grows to at least 140px, full available width, and scrolls after a readable max height.
- Handoff review card displays flag/reason, suggested admin and online choices before approval; selection is explicit.
- Reject prompts for a reason; action controls display current decision and delivery status separately.
- Analysis includes visual summary charts and a searchable, paginated conversation detail/timeline section.

- [ ] Add API-client/type tests for candidate lists and analysis response shape.
- [ ] Implement responsive review UI, reviewer-selected assignee, rejection reason dialog, and expanded editor.
- [ ] Implement period selectors for day/month/year and one/multiple periods, summary cards/charts, and paginated Q&A/timeline.
- [ ] Run npm run build and npm run lint only if a lint script exists; do not run customer-send tests or any live provider operation.

### Task 5: Documentation and safe verification

**Files:**
- Modify: docs/schema.md
- Modify: ChatAdminWeb/docs/DATA_SCHEMA.md
- Modify: docs/SRS_SSD.md only if chatbot/shopeechat/ code changes
- Modify: getoutofmywaybotkaikrook2.md (append-only)
- Modify: docs/waythrough-ledger.md

- [ ] Review the complete diff and verify live-send config remains false by default without reading env files.
- [ ] Run git diff --check, the fake-Mongo BotWorker review script, and the authorized build/lint commands.
- [ ] Confirm the tests use fake Mongo and never call the Shopee sender; do not send messages or media to customers.
- [ ] Append verified results and any limitations to the active log, index the exact new line range, then update the active integrity prefix/hash and metadata.
- [ ] Report the final diff and verification results; stop before commit until the user reviews and approves the concrete diff.
