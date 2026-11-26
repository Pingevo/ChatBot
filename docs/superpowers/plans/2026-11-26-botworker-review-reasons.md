# BotWorker Review Reasons and Handoff Plan

> **For agentic workers:** Execute inline in the current session. The user explicitly authorized implementation. Preserve unrelated working-tree changes; do not commit or send live messages.

**Goal:** Capture structured reasons for BotWorker answer edits/rejections and handoff rejection, show the edit/send outcome in Bot Performance Q&A, and make the existing handoff decision and customer message controls clear together.

**Architecture:** Keep review decisions in the existing `reviewService` owner and persist the reason with the existing `review_bubbles` edit history, rejection state, and `handoff_review` state. The existing BotWorker bubble remains the customer-facing draft with its current mock/live send gate; the handoff panel continues to assign an eligible selected admin. The analysis API passes persisted reason history and delivery states to the Q&A drawer.

**Tech Stack:** Next.js 16 App Router, React/TypeScript, MongoDB shadow reply/event documents, `tsx` behavioral integration harness.

**Spec:** User request in the current Codex task, clarified 2026-11-26.

## Global Constraints

- Reason categories are exactly `สเปคผิด`, `ควรส่งแอดมิน`, `การแก้ปัญหาผิด`, `ผิดรุ่น`, `ตอบไม่ได้`.
- Changed answer text requires one category and non-empty explanation for save and save-and-send; send-as-is requires no edit reason.
- Answer rejection and handoff rejection require one category and non-empty explanation.
- Handoff keeps selected-recipient assignment separate from customer-message sending; the existing delivery switch and idempotency rules remain authoritative.
- No customer/provider send, live database write, deployment, push, or commit during implementation.
- Existing dirty changes in BotWorker UI/service/tests/docs are pre-existing work and must be preserved.

## Review Focus

- Missing/unknown category or blank explanation is rejected without changing review state or sending.
- Valid edit reason is stored on each revision, including save-and-send, and survives Q&A serialization.
- Valid answer rejection and handoff rejection keep category and explanation with reviewer identity.
- “อนุมัติส่ง” without editing still uses the current text and delivery switch; Q&A distinguishes confirmed live send, mock-only, switch-off, failed, unknown, and not requested for both text and product-card delivery.
- Selecting a different eligible admin remains honored; rejecting a handoff does not assign anyone or send a customer message.

## Files and Owners

- `ChatAdminWeb/src/lib/types.ts` — shared fixed category values/type.
- `ChatAdminWeb/src/backend/service/reviewService.ts` — validation, edit/reject persistence, audit binding, handoff rejection persistence, and existing assignment owner.
- `ChatAdminWeb/src/backend/service/shadowReplyService.ts` — persisted document contract.
- `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/review/route.ts` and `.../handoff-review/route.ts` — request payload types and route forwarding.
- `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — reason controls, handoff copy, recipient selection, and existing send/edit actions.
- `ChatAdminWeb/src/backend/service/botPerformanceService.ts` and `ChatAdminWeb/src/components/bot-performance/BotPerformanceQa.tsx` — map/render revision reasons, rejection reasons, and separate text/product-card delivery results.
- `ChatAdminWeb/scripts/test-botworker-review.ts` — executable route/service/analytics behavior coverage using the existing controlled harness.
- `docs/schema.md` and `ChatAdminWeb/docs/DATA_SCHEMA.md` — persisted reason fields.

## Tasks

### Task 1: Persist answer edit and rejection reasons

**Files:** shared category type, shadow reply contract, review service, review route, schema docs, existing review harness.

- [x] Add behavior cases for missing/unknown category, blank explanation, valid save history, save-and-send history/text, and categorized rejection.
- [x] Run `cd ChatAdminWeb && node --import tsx scripts/test-botworker-review.ts`; observe expected failures before production edits. The `tsx` CLI itself could not create its IPC pipe in the sandbox, so the Node import entry point ran the same harness directly.
- [x] Add the fixed category contract, service validation/persistence, operation binding, route forwarding, and schema fields.
- [x] Re-run the behavioral harness; valid send still uses the existing mock sender and the exact edited text.

### Task 2: Require and persist handoff rejection reasons

**Files:** existing handoff review owner, route, shadow reply contract, BotWorker UI, behavioral harness.

- [x] Make missing category, blank explanation, and valid reject cases executable; confirm missing category was initially accepted and transitioned the handoff.
- [x] Persist category/explanation in `handoff_review`, operation binding, and audit details; forward through the route.
- [x] Prove rejection makes no assignment or customer message; verify existing recipient selection, approval, resume, and round-robin cases still pass.
- [x] Add a failing case showing a handoff bubble cannot bypass the handoff rejection reason; enforce the transition through the existing review owner.

### Task 3: Render review reasons, delivery outcome, and handoff context

**Files:** BotWorker page, Bot Performance service/Q&A, behavioral harness, both schema docs.

- [x] Add API behavior assertions for analysis edit history, rejection category, handoff rejection, and delivery state; observe the expected missing handoff-category failure.
- [x] Add fixed category dropdowns and required explanation fields for answer edit/reject and handoff reject. Preserve send-as-is and edited-send actions; keep eligible-recipient selection and separate the assignment decision from customer delivery.
- [x] Label handoff customer draft/reason/recipient and show the latest edit or rejection reason in the BotWorker bubble.
- [x] Render every edit revision with diff, category, explanation, reviewer/time, categorized rejection, and explicit per-bubble delivery result in Q&A; legacy edit rows without history say no reason was recorded.
- [x] Update schema docs and run the review harness: 66/66 pass, including old in-flight approval retries and separate product-card outcome/ID in Q&A data.
- [x] Type-check changed source files excluding generated `.next` route types: pass. Full `npx tsc --noEmit` reports stale `.next` references to missing `src/app/api/botworker/review-analysis/route.ts` and unrelated errors in the in-progress untracked composer helper test.
- [x] Independent review caught old approval retry binding changes and missing card-delivery reporting; preserved old approval bindings, added card ID/state to Q&A, and added behavioral assertions for the card display condition.
- [x] Final review harness: 66/66 pass; targeted TypeScript check and `git diff --check` pass. No commit, live send, DB/provider call, or deployment.
