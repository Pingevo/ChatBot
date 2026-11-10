# Bot-worker: admin review per bubble with mock Shopee delivery

**Status:** implementation plan, not implemented · **Priority:** H0–H3 before remaining KB/workflow work · **Pilot:** one designated admin, one Shopee shop · **Delivery:** mock only; no Shopee network call

## 1. Goal and current baseline

For each customer turn, the bot stores its original draft in Admin Mongo. The designated admin reviews each answer bubble in `/botworker`, approves it unchanged, edits it on that page, or rejects it. Approved bubbles are submitted in order to a mock Shopee sender, one mock request per bubble. A recommended product is a typed card request when a verified Shopee item identity is present. The mock must never report actual customer delivery.

Current owners: `botWorkerService.ts` inserts drafts into `shadow_replies`; the conversation messages route reads them; `/botworker/page.tsx` splits `|||` only while rendering; the existing `/botworker/.../send` route writes a sandbox admin message; `safety.ts` keeps Shopee live send disabled. Keep that sandbox route distinct from the new review action. No change to KB source selection or answer generation is needed.

## 2. Locked behavior and state

### Each answer bubble

Persist an ordered `review_bubbles` array on the existing `shadow_replies` document when the answer is first stored. Each bubble has a stable ID derived from the existing reply ID and its ordinal, `original_text`, `edited_text` only after Save, a decision (`pending | approved | edited_approved | rejected`), decision actor/time, a delivery state (`not_requested | mock_sent | mock_failed`), and the mock request/receipt if attempted. Preserve `bot_reply_text` unchanged for provenance and existing readers. Split once at persistence using the existing `splitAnswerSegments` contract; empty segments are not sent. For older drafts without this field, the reader may display split text but must not silently make them eligible for approval.

`sent_text` is reserved for delivery confirmed by a real provider in a later, separately authorized phase. It is absent for every mock outcome, including `mock_sent`, and always absent for rejected bubbles. `approved_text` holds the reviewed text submitted to the mock. An edit saved without submission remains `pending` with `edited_text` retained. Cancel discards only the unsaved UI edit.

### Controls in `/botworker`

Pending bubble: **อนุมัติส่ง**, **แก้ไข**, **ไม่อนุมัติส่ง**. The edit view is inline in that bubble, with **บันทึก**, **บันทึกและส่ง**, **ยกเลิก**. `บันทึก` stores the edit and keeps it pending. `บันทึกและส่ง` saves the edit, records `edited_approved`, and submits that one bubble to the mock sender. `ยกเลิก` restores the last persisted text in the editor and makes no decision or request. If a saved edit is later approved with the main button, its decision is `edited_approved`. Reject preserves original and saved edit for audit but makes no send request. Completed decisions are read-only; a later correction needs an explicit new draft/review cycle, never a hidden rewrite of the old decision.

Show original text, current saved edit, status, decision actor/time, and mock outcome separately. Label `mock_sent` visibly as **จำลองส่งเท่านั้น — ลูกค้ายังไม่ได้รับ**. Product cards belong to a specific review bubble/send part, not implicitly to the last visual segment.

### Batch and order

The review unit is one bubble; approval of bubble 2 does not approve bubble 1 or 3. To preserve the answer order, approve/send is enabled only after every earlier bubble is either rejected or has a completed mock request. Each eligible click submits exactly one mock API call for that text bubble. If one mock call fails, retain the result for completed bubbles and keep later approve/send disabled until the admin explicitly retries the failed bubble. Repeated clicks, concurrent admins, refreshes and retries cannot create a second mock request for an already completed bubble. A deterministic request ID and unique mock-log insert protect a retry after a crash between the mock insert and review-state update. Do not call the mock when a bubble is rejected. If the bot answer contains no nonempty bubble, store the draft but expose no send action.

## 3. Data and API ownership

Use `shadow_replies` for draft and review state; avoid a second collection for the same draft. The existing Admin Mongo write from bot generation remains the first write. Extend the existing message read route to return `review_bubbles` plus permission state for the designated admin. Add a review command route under `/api/botworker/conversations/[conversationId]/...` accepting the stable reply/bubble IDs, action (`save | approve | save_and_approve | reject`), optional edited text, and an operation ID. Derive shop, platform, conversation, inbound reply identity and actor on the server from persisted records/auth; never trust client supplied identity or admin ID. Reject wrong shop, wrong admin, stale draft version and already final decisions. Use one conditional Mongo update for each state transition; record actor/time and command outcome with the existing bot-worker audit event owner.

The server owns segment text, order and card identity. It must not accept a replacement answer array or arbitrary Shopee payload from the browser. `save` validates nonempty edited text and length against the actual provider capability once known; for this mock plan use a documented bounded input limit and test it. The approval API returns the new persisted state for the clicked bubble. It must be safe to retry the same operation ID and return the previous outcome without a second mock call.

Do not write mock results into `messages_shp`, which represents observed marketplace messages. Do not insert mock approvals into the existing `botworker_messages` sandbox composer collection as if they were manual chat replies. Leave the existing sandbox composer behavior and label unchanged.

## 4. Mock Shopee send contract

Implement a small transport seam behind the review command, with a mock implementation only. Extend the existing `botworker_events` owner with a `mock_send` event keyed by a deterministic Mongo `_id` from reply ID, bubble ID and part type; its unique insert is the mock request log. Record `shop_id`, conversation/recipient identity, reply-to inbound ID, bubble ID, ordinal, approved text, and typed send part (`text` or `product_card`). Return a clearly fake receipt (`provider: mock`, `delivered: false`, request ID). The seam must contain no Shopee URL, token lookup, HTTP client invocation or live-send flag change. One approved text bubble means one mock text request. Do not claim that an array of bubbles is one Shopee request. Do not use the current random `logBotworkerEvent` ID as the mock idempotency key.

For a product recommendation, let the admin select a displayed `bot_products` entry for a specific bubble. Use its verified Shopee item ID and shop association to construct a separate typed `product_card` mock request. Never infer item ID from prose or a URL. If the record lacks an authoritative item ID or the platform card capability is not verified, show a blocking reason on that card and do not replace it silently with a plain link. The UI may still display the product as context. Exact outbound Shopee card payload and ordering relative to text require an official/API-backed contract before a real adapter is written; the mock describes intent, not a claimed Shopee schema.

## 5. Implementation sequence

1. **Baseline and isolation:** record branch/dirty paths, existing bot-worker/KB locks, and the three current owners above. Work in a separate bot-worker branch/worktree so uncommitted Zaapi KB changes remain untouched. Read the local Next.js docs required by `ChatAdminWeb/AGENTS.md` before code.
2. **RED tests:** prove current UI-only split, missing per-bubble review state, sandbox-only send and absent card request. Add behavioral tests for the transitions below; avoid source-text-only assertions.
3. **Draft persistence:** freeze `review_bubbles` with stable IDs at the existing bot draft insertion owner. Preserve recovery behavior for duplicate inserts and historical drafts. Keep the original answer immutable.
4. **Review command:** add server-side authorization and conditional state updates at the existing bot-worker route/service boundary. Save, approve, save-and-approve, reject and duplicate-click behavior must be atomic at the document level.
5. **Mock delivery:** submit approved bubbles in order, one mock request per bubble; persist mock receipts/failure separately from decisions. No real platform API call or `sent_text` write.
6. **UI:** render three main controls per pending bubble and three inline editing controls; show saved edit, decision and mock status. Refresh must reconstruct the same state from Mongo. Do not alter the unrelated sandbox composer.
7. **Product card intent:** bind a card to a verified product item ID and shop, create a separate typed mock request, and display missing-identity/capability blocks. Keep text and card outcomes separate.
8. **Verification and closeout:** run focused UI/API/service tests, typecheck, relevant bot-worker regression scripts, `git diff --check`, and inspect the exact mock request log for 1-, 2- and 3-bubble cases. Update docs/ledger. Report actual test counts and limitations; stop before any live enablement, deployment, push or production Mongo migration.

## 6. Acceptance matrix

| Case | Required observation |
| --- | --- |
| One bot answer `A|||B|||C` | Three stable review bubbles in Mongo; UI displays three; no mock requests before approval |
| Approve `B` while A is pending | Action disabled/rejected as out of order; zero mock requests |
| Reject A, then approve `B` unchanged | A rejected with zero requests; only B has `approved`, `approved_text=B`, exactly one mock text request; C remains pending; `sent_text` absent |
| Edit `A`, Save | Saved edit visible after refresh; still pending; zero mock requests |
| Edit `A`, Save and send | `edited_approved`; request text equals saved edit; original remains A; `sent_text` absent |
| Edit `C`, Cancel | Unsaved changes discarded; no decision or request |
| Reject `C` | `rejected`; no request, no `approved_text` or `sent_text` |
| Double click / retry / two admins | One persisted decision and at most one mock request; unauthorized admin cannot decide |
| Mock failure on bubble 2 | Bubble 1 receipt remains, bubble 2 shows failure, bubble 3 is not submitted automatically; none has `sent_text` |
| Verified product card | Separate typed `product_card` mock request with exact item/shop identity; no URL-to-card inference |
| Missing or mismatched product identity | No card request; UI gives reason; no plain-link fallback as if a card were sent |
| Refresh/restart | Original, saved edit, decision and mock receipt survive; no auto-send on restart |
| Existing sandbox composer and other shops | No real send, no changed legacy sandbox behavior, no approval route outside the pilot scope |

## 7. Complexity and safety limits

Reuse existing split, draft, auth, audit and Mongo owners. No new semantic keyword table, regex-based item detection, answer guard, or product matching heuristic. Add only the fields/route/mock seam required for this workflow; report actual net helpers, guards, regexes, keyword tables and decision owners. This plan does not authorize changing `SAFETY.shopeeLiveSend`, using Shopee credentials, calling Shopee, writing shared production data, or claiming that a mock receipt proves delivery.

## 8. Later live gate

The live phase requires the exact named admin/shop, official Shopee text/card capability and payload, recipient/reply-to identity, provider receipt and reconciliation behavior, unique operation keys across restart, authorization to send to a specific canary conversation, and a stop/rollback procedure. Only then may a separately reviewed adapter populate `sent_text` after confirmed provider delivery. This gate is outside this mock plan.
