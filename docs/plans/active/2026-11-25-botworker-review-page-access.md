# BotWorker review access correction — 2026-11-25

## Root cause

BotWorker review buttons are hidden when `can_review=false`. The messages route, review action, handoff review, analysis route, and review service currently require a fixed `bot_review_admin_id`. The user clarified that every admin who can access `/botworker` may review; the fixed-admin rule contradicts that contract.

## Change

- Make `requirePageAccess("botworker")` the authorization boundary for reading drafts, reviewing answers, approving/rejecting handoffs, and viewing analysis.
- Remove fixed reviewer ID checks and unused pilot config fields. Keep actor identity from the authenticated session in every stored decision/event, and keep CAS/idempotency, required rejection reason, scoped send switch, and recipient eligibility checks.
- Preserve the review controls for pending bubbles and the status-only view for decided bubbles.

## Verification

Update executable fake-Mongo route tests first: two different page-authorized admins can review without fixed config; action and handoff logs retain the actual actor; blocked page access remains forbidden. Run the focused review suite, TypeScript, and diff checks. No live provider, database write, media upload, or customer send.
