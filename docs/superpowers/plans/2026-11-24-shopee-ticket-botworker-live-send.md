# Scoped Shopee Live Send for Tickets and BotWorker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add a default-off Shopee outbound switch that enables actual sends only from Tickets and BotWorker while preserving BotWorker's draft-first, admin-review, and `shadow_replies` record.

**Architecture:** Keep the existing global Shopee API switches locked. Add one narrowly scoped console-send control and enforce it in the three server routes used by the two pages: Tickets' admin send route, BotWorker's manual composer route, and BotWorker's reviewed-reply route. Both page composers use typed message parts and the same provider owner when the switch is ON. Use an official-contract-backed Shopee sender; keep BotWorker's existing per-bubble review decision and draft persistence as the authority, recording provider-confirmed results back to the existing shadow reply.

**Tech Stack:** Next.js 16 App Router, TypeScript route handlers, MongoDB `system_configs`, `messages`, `shadow_replies`, and `botworker_events`.

**Spec:** `docs/plans/active/2026-11-09-botworker-human-approval-mock-send-plan.md` (existing review and mock-send contract) plus the user's 2026-11-24 scope: live sends are allowed only from Tickets and BotWorker; other pages retain current behavior.

## Global Constraints

- The new switch defaults OFF and is checked on the server for every live send attempt.
- Only `/api/admin/conversations/[conversationId]/send`, `/api/botworker/conversations/[conversationId]/send`, and `/api/botworker/conversations/[conversationId]/review` may use this switch.
- Configure the switch in the existing `/config` page, but limit its effect to send actions initiated from Tickets and BotWorker. `/shadow-inbox`, Test Chat, Replay, Workflow/other send routes, TikTok, and Lazada keep their current behavior and do not consult it.
- When OFF, Tickets keeps its existing internal-only message record, BotWorker's manual composer keeps its sandbox-only behavior, and BotWorker review keeps its existing mock/no-customer-delivery behavior. All three paths make zero Shopee requests.
- When ON, a send action initiated from either page may send supported content to the Shopee customer. BotWorker AI drafts still require the existing explicit admin action; the switch never auto-sends a draft. Reject never sends.
- BotWorker stores the draft in `shadow_replies` before review; only the existing admin send/edit-and-send actions may invoke live delivery; reject never sends.
- Preserve `review_bubbles` decision, order, authorization, and idempotency contracts; keep original bot text immutable and record the final provider-confirmed text and receipt separately.
- Tests use a fake transport and must make zero requests to Shopee. Do not enable the switch, send a canary message, or deploy as part of implementation.
- Do not read `.env` or `มาแล้วจ้า.md`; obtain credentials only through an existing approved server-side credential owner.
- Keep the existing globally locked `shopee_live_send_enabled` field unavailable to other routes; the scoped control is a separate, audited setting.
- Implement in a clean worktree/branch from `main`; the current checkout has unrelated uncommitted v4/8010 changes.
- Implement text, image, video, sticker, product card, and any additional send type only when the official Shopee contract verifies its payload, upload prerequisites, recipient identity, and receipt behavior. Unsupported types fail closed with a visible reason; never silently downgrade them to text.

## Review Focus

1. Switch OFF or stale config cache: none of the three routes makes an outbound request; Tickets retains its current internal-only record, BotWorker manual composer retains sandbox-only behavior, and review retains no-customer-delivery behavior.
2. Switch ON followed by toggle OFF before a request reaches the sender: the server rechecks the current persisted value and refuses the send.
3. Provider timeout after request acceptance: persist an `unknown` outcome and do not automatically resend unless the official API provides a verified idempotency or reconciliation contract.
4. Duplicate approval, concurrent reviewers, and retry after refresh: preserve the current single-decision and bubble-order guarantees without duplicate customer sends.
5. Non-Shopee conversation, unsupported media kind, or missing recipient/file identity: return a visible failure and make no provider request.

## Baseline Findings

- Tickets currently sends text to an internal admin message record only. Its route explicitly says it does not send to a platform and calls `assertPlatformApiDisabled`; the request body contains only `text`.
- BotWorker's review route injects `sendMockPart`. `reviewService` stores per-bubble decisions and mock delivery states; it has no real-provider state today. The BotWorker composer route is a separate sandbox message path that also needs the scoped gate for this request.
- `/config` already displays a locked `shopee_live_send_enabled` switch. The config API rejects writes to that field and `systemConfigService` derives it from hard-coded safety values. Reusing or unlocking it would affect a broader platform-wide rule, so this plan uses a separately named, surface-scoped control.
- Current outbound UI contracts are text-only for both page composers and text/product-card for BotWorker review. Neither composer currently has the requested image, video, emoji-picker, or sticker controls. The existing mock plan reserves real-delivery fields for a separate phase.
- Shopee's official Open Platform documentation returned HTTP 403 during this audit. Exact chat send/upload payloads, supported media types, idempotency, and provider receipt semantics are therefore unverified. Implementation must stop at the contract-discovery gate until an accessible official contract or user-provided official specification is available.

## File Structure

- `ChatAdminWeb/src/backend/service/systemConfigService.ts` — persist/read the new default-off scoped setting.
- `ChatAdminWeb/src/app/api/config/route.ts` and `ChatAdminWeb/src/app/(console)/config/page.tsx` — validate, authorize, audit, and display the explicit Tickets/BotWorker live-send switch.
- `ChatAdminWeb/src/backend/service/shopeeOutboundService.ts` — proposed typed provider transport owner, created only after the Shopee contract and secure credential owner are verified.
- `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/send/route.ts`, `ChatAdminWeb/src/app/(console)/tickets/page.tsx`, and `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx` — add typed composer parts and image/video/emoji/sticker input controls; keep current internal-only behavior when OFF, and send supported content through the shared provider owner when ON.
- `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/send/route.ts` and `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — add the same typed composer capabilities and server-side gate; keep sandbox-only persistence when OFF, and send supported content through the shared provider owner when ON.
- `ChatAdminWeb/src/backend/service/reviewService.ts`, `ChatAdminWeb/src/backend/service/botWorkerService.ts`, `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/review/route.ts`, and `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — preserve review decisions and select mock/no-live behavior when OFF versus provider delivery after an explicit send/edit-and-send approval when ON; persist and render supported media parts if the bot draft contains them.
- `ChatAdminWeb/src/backend/service/shadowReplyService.ts` — extend the existing review delivery type only for provider-confirmed outcome fields; keep `bot_reply_text` unchanged.
- `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — show mock versus provider-confirmed status without changing the three admin decisions.
- `ChatAdminWeb/scripts/test-shopee-scoped-live-send.ts` plus its local hook/mock files — executable behavior tests for the setting, the three allowed routes, typed composer behavior, and unchanged routes.

## Implementation Tasks

### Task 1: Verify the Shopee delivery contract before writing a sender

**Files:** No production file changes. Evidence is recorded in this plan or a linked contract note.

- [ ] Obtain accessible official documentation for text, image, video, sticker, product-card and other requested message types, including upload steps, recipient/reply identity, response IDs, errors, retries, and duplicate-send handling.
- [ ] Identify the existing server-side credential/token owner without reading secret files.
- [ ] If either the official contract or credential owner cannot be verified, stop before adding the live sender and report the exact missing evidence.

### Task 2: Add the scoped default-off setting with behavioral tests first

**Files:** Modify `ChatAdminWeb/src/backend/service/systemConfigService.ts`, `ChatAdminWeb/src/app/api/config/route.ts`, `ChatAdminWeb/src/app/(console)/config/page.tsx`. Create `ChatAdminWeb/scripts/test-shopee-scoped-live-send.ts` and local mocks/hooks.

- [ ] Add failing tests proving missing setting resolves to OFF; unauthorized/non-boolean updates are rejected; the existing global `shopee_live_send_enabled` remains rejected; and setting changes cannot enable any route by themselves.
- [ ] Run `cd ChatAdminWeb && npx tsx scripts/test-shopee-scoped-live-send.ts` and verify the expected failures.
- [ ] Add one persisted setting named `shopee_console_send_enabled`, default `false`, to `SystemConfigDoc`, safe normalization, and the existing whitelist. The config route accepts only a boolean and retains `requirePageEdit("config")`.
- [ ] Add a separately labeled, confirmation-protected switch in `/config`: “ส่งจริงจาก Tickets / BotWorker”. Show OFF as “ไม่ส่งออก Shopee”; show ON as “ปุ่มส่งในสองหน้านี้ส่งถึงลูกค้าจริง”. Keep all existing global platform switches locked.
- [ ] Re-run the focused script and verify only the new scoped setting can change.

### Task 3: Add the provider sender behind a typed, injected transport

**Files:** Create `ChatAdminWeb/src/backend/service/shopeeOutboundService.ts` and `ChatAdminWeb/scripts/test-shopee-outbound-service.ts`.

- [ ] Write failing tests for each provider-confirmed message type, shop/recipient binding, upload failure, provider rejection, accepted receipt, timeout/unknown result, and deterministic operation identity.
- [ ] Run `cd ChatAdminWeb && npx tsx scripts/test-shopee-outbound-service.ts` and verify it fails before the sender exists.
- [ ] Implement the smallest typed adapter supported by the official contract. Resolve tokens through the verified credential owner. Return distinct `sent`, `failed`, or `unknown` outcomes with provider message IDs when confirmed.
- [ ] Do not auto-retry an ambiguous send. Allow retry only where the official contract proves idempotency or a reconciliation lookup can confirm the first request was not accepted.
- [ ] Verify all tests with a fake transport and assert no test makes a network request.

### Task 4: Gate Ticket live send without changing other ticket behavior

**Files:** Modify `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/send/route.ts`, `ChatAdminWeb/src/app/(console)/tickets/page.tsx`, and `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx`; create `ChatAdminWeb/scripts/test-ticket-live-send-route.ts`.

- [ ] Add failing route/UI tests for text, emoji, and each verified attachment kind: OFF (internal record only, zero provider calls), ON+Shopee (one provider call then persist confirmed delivery), provider failure/unknown, non-Shopee (existing local-only behavior), assignment conflict, unsupported type, and repeated request IDs.
- [ ] Run `cd ChatAdminWeb && npx tsx scripts/test-ticket-live-send-route.ts` and verify the tests fail against the current local-only route.
- [ ] Read the current setting immediately before sending. When OFF, preserve the existing internal `messages` write. When ON, require a Shopee conversation, send through the provider owner, and persist the provider result without claiming delivery on failure/unknown.
- [ ] Keep all other route behavior unchanged and run the focused test.

### Task 5: Gate the BotWorker manual composer

**Files:** Modify `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/send/route.ts` and `ChatAdminWeb/src/app/(console)/botworker/page.tsx`; extend the scoped-send route tests.

- [ ] Add failing tests for OFF (sandbox record only, zero provider calls), ON+Shopee text/emoji/verified media delivery, non-Shopee behavior, upload/provider failure, unsupported type, and duplicate request identity.
- [ ] Keep the existing BotWorker sandbox message record and UI behavior when OFF. When ON, require a Shopee conversation, recheck the persisted switch immediately before sending, and record the actual provider result rather than fabricating delivery.
- [ ] Reuse the same typed message-part model and composer controls as Tickets; unsupported types fail visibly without being silently converted to text.

### Task 6: Switch BotWorker review from mock-only to gated provider delivery

**Files:** Modify `ChatAdminWeb/src/backend/service/reviewService.ts`, `ChatAdminWeb/src/backend/service/shadowReplyService.ts`, `ChatAdminWeb/src/backend/service/botWorkerService.ts`, `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/review/route.ts`, `ChatAdminWeb/src/app/(console)/botworker/page.tsx`, and `ChatAdminWeb/scripts/test-botworker-review.ts`.

- [ ] Add failing tests that cover OFF (no provider call, draft/review state retained), ON approve, ON edit-and-send, reject, text/image/video/sticker/product-card parts supported by the verified contract, ordering, duplicate click, concurrent admin, timeout/unknown, and retry reconciliation.
- [ ] Run `cd ChatAdminWeb && npx tsx scripts/test-botworker-review.ts` and verify failures for the missing live path.
- [ ] Preserve the current per-bubble decision and ordering state machine. Select live delivery only when the setting is ON and the conversation is Shopee; otherwise retain the current mock-only behavior.
- [ ] Store provider-confirmed final text and receipt in the existing `shadow_replies` record; keep original bot text and saved edit for audit. Keep mock receipts explicitly labeled as not delivered.
- [ ] Update BotWorker status labels so mock, confirmed send, failure, and unknown are distinguishable. Send/edit-send remain the only actions that can call the sender; reject never does.
- [ ] Run the existing review regression script and the new scoped-send script.

### Task 7: Prove route isolation and close out

**Files:** Relevant route test scripts; `docs/waythrough-ledger.md`; `getoutofmywaybotkaikrook2.md`.

- [ ] Extend `ChatAdminWeb/scripts/test-shopee-scoped-live-send.ts` with executable regression assertions that Shadow Inbox, Test Chat, Replay, and Workflow-only paths do not consult `shopee_console_send_enabled` and make no Shopee call. BotWorker's composer is in scope and must be covered separately for both switch states.
- [ ] Run `cd ChatAdminWeb && npx tsx scripts/test-shopee-scoped-live-send.ts`, `cd ChatAdminWeb && npx tsx scripts/test-botworker-review.ts`, and `cd ChatAdminWeb && npm run build`.
- [ ] Review the diff and run `git diff --check`; do not enable the switch, call Shopee, deploy, push, or commit without separate approval.
- [ ] Update the active log and ledger with exact verification results and limitations.

## Approval Boundary

The repository's current Iron Rule says platform live sending stays hard-disabled and the global send field cannot be changed through the UI. This request requires a deliberate, narrow exception for the three named server routes, limited to the Tickets and BotWorker pages. Approval of this plan authorizes implementing that scoped capability with the new switch default OFF; it does not authorize turning it ON, sending a real message, using unverified media payloads, deploying, or changing other pages.
