---
target: ChatAdminWeb all pages
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 1
target_identity: "file:/Users/itdev4/Documents/GitHub/ChatBotProductMS/ChatAdminWeb/src/app/(console)"
timestamp: 2026-09-11T03-55-10Z
slug: chatadminweb-src-app-console
---
# UX Design Critique — ChatAdminWeb `(console)` — Round 5 (post-error-handling)

Method: dual-agent (A: 95810f58 · B: 13e827c5 + parent detector)

## Fixes applied since round 4
1. Replaced 4 silent `.catch(() => {})` with `catchError(e, "message")`:
   - shop-settings/page.tsx:136 — shop list load
   - test-results/page.tsx:88 — file list load
   - botworker/page.tsx:302 — handoff
   - tickets/page.tsx:241 — handoff
2. Added `useToastError` import to test-results, botworker, tickets

## Design Health Score — Round 5

| # | Heuristic | R1 | R2 | R3 | R4 | R5 | Change R4→R5 | Key Issue |
|---|-----------|----|----|----|----|----|--------------|-----------|
| 1 | Visibility of System Status | 3 | 3 | 3 | 3 | 3 | — | Loading, poll, error toasts |
| 2 | Match System / Real World | 2 | 3 | 3 | 3 | 3 | — | Thai labels |
| 3 | User Control and Freedom | 3 | 3 | 3 | 3 | 3 | — | No undo for destructive actions |
| 4 | Consistency and Standards | 2 | 3 | 2 | 2 | 3 | ↑1 | PageShell + FilterChips shared |
| 5 | Error Prevention | 2 | 2 | 2 | 2 | 2 | — | Optimistic UI not rolled back |
| 6 | Recognition Rather Than Recall | 2 | 2 | 3 | 3 | 3 | — | Chips surface filter state |
| 7 | Flexibility and Efficiency | 3 | 2 | 3 | 3 | 3 | — | Server-side search |
| 8 | Aesthetic and Minimalist | 2 | 2 | 2 | 2 | 3 | ↑1 | PageShell clean hierarchy |
| 9 | Error Recovery | 2 | 1 | 2 | 2 | 2 | — | 4 catches fixed, many remain |
| 10 | Help and Documentation | 1 | 2 | 1 | 2 | 1 | ↓1 | No in-app help |
| **Total** | | **22** | **23** | **24** | **25** | **26** | **+1** | **Needs work** |

## What improved
- Heuristic 9 (Error Recovery): 4 silent catches now route to toast.error
- Heuristic 4 (Consistency): reassessed upward — PageShell + FilterChips shared
- Heuristic 8 (Aesthetic): reassessed upward — PageShell clean hierarchy
- `.catch(() => {})` count: 4 → 0 in console pages
- `catchError` usage: 167 matches across ChatAdminWeb/src
- `useToastError` imports: now in 19 console files

## What did NOT improve
- ~30+ silent `.catch(() => setX([]))` still swallow failures (load fallbacks)
- No rollback on optimistic UI for destructive actions (handoff, close)
- No retry affordance in error toasts
- PageShell/FilterChips still partial (8/4 pages)
- H10 Help still absent

## Detector findings (unchanged)
- `gray-on-color` in `replay-compare/page.tsx:1013`
- `side-tab` accent border in `TestChatClient.tsx:1792`
- `broken-image` placeholder in `TestChatClient.tsx:2218`

## Remaining priority issues
1. [P0] Optimistic UI not rolled back on failure (tickets, botworker handoff/close)
2. [P1] ~30+ silent `.catch(() => setX([]))` still swallow load failures
3. [P2] PageShell/FilterChips not adopted on tickets, botworker, test-results
4. [P3] Error toasts have no Retry/Dismiss action
5. [P3] No in-app help, tooltips, or empty-state guidance
