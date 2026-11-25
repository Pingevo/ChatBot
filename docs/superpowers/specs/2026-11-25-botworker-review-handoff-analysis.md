# BotWorker answer review, handoff approval and analysis

**Status:** Approved for implementation with the user's additions on 2026-11-25. This document defines the behavior; implementation is in progress.

## Goal

Make every BotWorker answer and every handoff flag pass through admin review. Any admin with BotWorker page access may review. Preserve the bot's original output, the reviewer's edits or rejection reason, the actual delivery/assignment outcome, and who performed each action. Add an analysis view inside the BotWorker analysis area with visual summaries and per-conversation Q&A history.

The feature remains internal to BotWorker. The default-off Shopee live-send switch remains OFF, and no setting change may trigger a send.

## Roles and identity

- **Reviewer/approver:** any admin with BotWorker page access. Each action records the acting admin's stable account ID; the UI must not expose actions when the request is unauthorized.
- **Handoff assignee:** an eligible admin who is online when handoff is approved. The existing BotWorker assignment/round-robin owner provides the suggested recipient; the reviewer may instead choose any other eligible online admin. The reviewer may also choose themselves.
- **Responder:** the admin who later replies in the conversation. Store this independently from the reviewer and assignee.
- Each record and event must be tied to the complete conversation identity: platform, shop ID, conversation ID, and the relevant inbound message ID(s). Do not associate a reply by customer name or by a partial conversation key.

## Bot answer review flow

1. When the worker produces an answer, persist the exact original bot text and its source/engine metadata as a reviewable draft in shadow_replies, tied to the conversation and source message IDs. It stays pending until an authorized admin acts.
2. The reviewer sees the customer input, original bot answer, engine, shop, conversation, and current review/delivery state.
3. **Approve and send:** record the reviewer and approval first. If the live-send switch is ON, only this explicit action may invoke the existing scoped sender. Record the provider outcome and message/reference IDs when available.
4. **Edit and send:** preserve the original bot text; append an edit action containing the before/after text and actor; mark the final approved text; then follow the same explicit-send gate. The approved/sent text must remain recoverable even after later actions.
5. **Reject:** require a non-empty reason. Keep the original bot answer and rejected text; save the reason in shadow_replies and in the action history; record reviewer ID/name and timestamp. Rejection never invokes the sender.
6. The separate “do not send”/reject action does not erase the draft. If a later manual response is made, it is a separate BotWorker message/action with its own actor and delivery result.

### Delivery state is separate from review decision

Do not overload a single status to mean both approval and delivery. Store/report review decision separately from delivery outcome. At minimum distinguish pending review, approved, edited-and-approved, rejected, sent with confirmed provider success, send failed, delivery unknown/ambiguous, not sent because the switch was OFF, and internal-only/not attempted.

When the switch is OFF, record the reviewer decision and not_sent_switch_off; do not call Shopee or a mock sender that marks the draft as settled/sent. Enabling the switch later must not send anything automatically. A later send requires a new explicit reviewer action. Only a confirmed real provider success counts as a real send; mock, sandbox, failed, ambiguous, and switch-off outcomes do not.

## Handoff review flow

1. A bot handoff response is saved as a review item with the exact upstream fields: handoff_required, reason, handoff_reason, handoff_explanation, answer, conversation_id, and message_id. Keep the reason code separate from its operator explanation and from the customer-facing answer. Preserve the provided codes legal_or_platform_dispute, clarification_unresolved, and insufficient_shop_evidence without keyword inference. Store the exact inbound conversation/message IDs from the worker as the correlation authority; if upstream IDs are present but conflict, fail closed and do not create a review item for a different conversation. The item must be visible to the reviewer like every other draft.
2. Before approval, show the reviewer the suggested assignee from the existing BotWorker round-robin/assignment owner, the assignment reason, and the eligible-admin list with online status. Let the reviewer choose any eligible admin who is online, including themselves. Previewing or changing this selection must not assign the conversation or advance the round-robin cursor.
3. The reviewer may approve or reject the handoff. Approval records the reviewer, flag/reason, selected recipient, selection source (round-robin suggestion or reviewer choice), and timestamp, then commits assignment through the existing BotWorker assignment owner. The selected assignee may be the reviewer.
4. The committed assignee must be the recipient the reviewer selected and must still be eligible and online at commit time. If that admin goes offline or becomes ineligible before commit, fail closed, refresh the online list, and require the reviewer to choose and confirm again; never silently route to a different person.
5. Rejecting a handoff requires a reason, retains the bot flag and message, and logs the reviewer and timestamp. It does not modify assignment or send a customer message.
6. Record the eventual responder separately when an admin replies. Handoff approval itself does not imply a customer-facing message was sent.

The assignment write remains in the existing BotWorker assignment domain (currently sandbox/test status). This feature must not silently write Tickets/live conversation assignment state or call a Shopee API. Any future change to that boundary needs its own explicit scope.

## Edit-mode UI correction

When the reviewer enters edit mode, expand the editor within the available message column instead of leaving it at the compact bubble size shown in the screenshot. Use a readable minimum height (at least 140px), full available width, and content-based growth up to a sensible maximum with scrolling after that. Keep the text readable at normal chat size, keep Save/Send/Cancel controls visible and aligned, and prevent horizontal overflow on phone/tablet layouts.

## Audit record and data ownership

Use shadow_replies as the current draft/review/delivery projection and botworker_events as the append-only action history; do not add a parallel generic workflow or audit collection. Extend the existing typed owners only where the source audit shows the existing fields cannot preserve the required history.

Each action event should capture, where applicable:

- event/action ID and idempotency key; platform, shop ID, conversation ID, draft/bubble ID and source message IDs;
- action name, actor account ID and display-name snapshot, timestamp;
- exact original bot text, edited/final text, and before/after values for each edit;
- handoff_required, reason, handoff_reason, handoff_explanation, exact answer, upstream conversation/message IDs, suggested, reviewer-selected, and committed assignee IDs/names, selection source, online/eligibility check result, and assignment result;
- rejection reason;
- review decision, delivery outcome, safe provider message/reference IDs, and error category;
- responder identity and response message ID for a later admin reply.

Events must be queryable in chronological order and retries must not duplicate an action. If an audit write or required state persistence fails, do not send or assign; return a visible error and preserve enough event data to diagnose the failed action. Never log credentials, access tokens, or signed secrets.

Historical records without actor, edit, reason, or provider evidence must remain marked as incomplete/unknown. Do not infer missing actions or count mock/sandbox results as real deliveries.

## Analysis page

Add a new view/tab in the existing BotWorker bot-analysis area; keep existing views intact. It has two parts:

### 1. Visual summary

Provide date granularity controls for **day, month, and year**. Day mode supports one date or multiple selected dates; month/year modes support selecting one or more calendar periods. Use Asia/Bangkok calendar boundaries for selection and display, converting boundaries to UTC for database queries. All cards and charts must use the same server-side filter.

Show at least:

- bot drafts received, pending review, reviewed, approved, edited, and rejected;
- handoff flags, pending handoffs, approved/rejected handoffs, assignment failures, and counts by assignee;
- real sends confirmed, sends failed, delivery unknown, and not sent because the switch was OFF;
- review time and send outcome trends over the selected periods.

Define every metric from persisted fields/events. Do not count a decision as a send, a sandbox assignment as a live assignment, or an ambiguous provider result as confirmed delivery.

### 2. Conversation Q&A and event timeline

Show a server-filtered, paginated list of conversations matching the selected dates. Each conversation detail must show the customer input, original bot answer, every edited/final answer, rejection reason when present, handoff flag/reason, previewed and committed assignee, reviewer, responder, and a chronological timeline of actions and outcomes.

Support search and filters by shop, platform, reviewer, review decision, handoff state/assignee, and delivery outcome. Read the complete history from the server; do not compute totals or filter only the currently loaded page in the browser. The page must clearly mark older records whose audit data predates this feature or is incomplete.

## Permissions and safety

- Any admin with BotWorker page access can inspect review items, act on them, and open the analysis view. The API checks page access for each request and records the actual actor.
- The live-send setting stays default OFF. No automatic send on worker response, approval persistence, page load, switch change, retry, or handoff.
- “Reject/do not send” never reaches a sender. Handoff assignment is an internal assignment action, not a customer message.
- No test may call Shopee, upload media, or send to a real customer. Any verification that exercises delivery must use a fake sender and assert the live sender was not called.

## Acceptance criteria

1. Every new bot answer, including a handoff answer, is persisted before review and retains its original text; handoff reason code, operator explanation, customer-facing answer, and source conversation/message IDs remain separate and exact.
2. Only the configured reviewer can approve, edit, reject, or approve handoff; every action identifies its actor and timestamp.
3. Rejecting an answer or handoff requires a reason and preserves the text/flag and reason in shadow_replies plus the append-only history.
4. Editing preserves original and final text and records each edit.
5. With the send switch OFF, all review decisions remain auditable, no sender is called, and the recorded delivery state is not sent. Turning the switch ON does not send existing drafts.
6. With the switch ON, only an explicit approved send action can call the existing sender; reject, handoff approval, page view, and background worker response cannot.
7. Handoff preview does not assign or advance round-robin. The reviewer can choose any eligible online admin before approval. Approval assigns exactly that admin if they remain online/eligible; otherwise it fails visibly and requires a new selection and approval.
8. Reviewer, assignee, and responder are displayed/stored as separate identities; self-assignment is valid.
9. Analysis charts and conversation details honor the same day/month/year filters, multi-day selection, server-side filters, and pagination.
10. Metrics distinguish confirmed real delivery from mock/sandbox, failure, ambiguous, and switch-off states; incomplete historical audit data is labeled rather than guessed.
11. Edit mode expands to a readable, responsive editor with visible controls and no cramped/shrunken text area.
12. All write routes are idempotent and fail closed if audit/state persistence fails. No code path introduced by this feature sends a real customer message without an explicit reviewer action.

## Out of scope

- Changing bot answer generation or handoff classification.
- Changing the assignment policy or adding a second assignment engine.
- Sending customer messages from the new analysis page.
- Moving BotWorker sandbox handoff writes into Tickets/live assignment state.
- Changing the global live-send default or enabling it.
- Backfilling actor/reason/edit history that was never recorded.
- Deploying or performing real Shopee/customer operations.
