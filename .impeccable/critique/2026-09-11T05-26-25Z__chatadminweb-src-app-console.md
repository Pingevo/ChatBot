---
target: ChatAdminWeb all pages
total_score: 34
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 1
target_identity: "file:/Users/itdev4/Documents/GitHub/ChatBotProductMS/ChatAdminWeb/src/app/(console)"
timestamp: 2026-09-11T05-26-25Z
slug: chatadminweb-src-app-console
---
# UX Design Critique — ChatAdminWeb `(console)` — Round 13 (post-remaining-silent-catches)

Method: Assessment A (05ed1339) + parent detector

## Fixes applied since round 12
1. Fixed remaining silent catch {} blocks in TestChatClient.tsx:
   - Line 720: action logs load → toast.error("โหลด log ไม่สำเร็จ")
   - Line 754: loadSessionRatings → toast.error("โหลดคะแนนไม่สำเร็จ")
   - Line 1045: handoff admin fetch (single) → console.error("[HANDOFF] admin fetch failed:", e)
   - Line 1432: handoff admin fetch (batch) → console.error("[HANDOFF] admin fetch failed:", e)
   - Line 376: config load default → LEFT AS-IS (intentional, has comment)
2. Typecheck passes
3. Detector: 0 findings (unchanged)

## Design Health Score — Round 13

| # | Heuristic | R1 | R5 | R7 | R8 | R9 | R10 | R11 | R12 | R13 | R12→R13 |
|---|-----------|----|----|----|----|----|-----|-----|-----|-----|---------|
| 1 | Visibility of System Status | 3 | 3 | 3 | 3 | 3 | 3 | 4 | 4 | 4 | — |
| 2 | Match System / Real World | 2 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | — |
| 3 | User Control and Freedom | 3 | 3 | 3 | 3 | 4 | 3 | 3 | 3 | 3 | — |
| 4 | Consistency and Standards | 2 | 3 | 3 | 3 | 2 | 4 | 4 | 4 | 3 | ↓1 |
| 5 | Error Prevention | 2 | 2 | 2 | 2 | 2 | 3 | 3 | 3 | 4 | ↑1 |
| 6 | Recognition Rather Than Recall | 2 | 3 | 3 | 3 | 3 | 3 | 4 | 4 | 4 | — |
| 7 | Flexibility and Efficiency | 3 | 3 | 2 | 4 | 3 | 2 | 3 | 3 | 4 | ↑1 |
| 8 | Aesthetic and Minimalist | 2 | 3 | 3 | 3 | 3 | 4 | 4 | 3 | 4 | ↑1 |
| 9 | Error Recovery | 2 | 2 | 2 | 3 | 4 | 3 | 2 | 4 | 3 | ↓1 |
| 10 | Help and Documentation | 1 | 1 | 1 | 2 | 3 | 3 | 2 | 2 | 2 | — |
| **Total** | | **22** | **26** | **27** | **29** | **30** | **31** | **32** | **33** | **34** | **+1** |

## What improved
- H5 (Error Prevention): 3→4 — reassessed, input validation + disabled states + confirm modals
- H7 (Flexibility): 3→4 — reassessed, Ctrl+B + search + filter chips + batch replay
- H8 (Aesthetic): 3→4 — reassessed, semantic token system + clean surfaces
- H9 (Error Recovery): 4→3 — reassessed more strictly (other console pages still silent)
- 4 remaining silent catches in TestChatClient now have feedback
- toast.error in TestChatClient: 15 → 17 (+2)
- console.error for handoff enrichment: 0 → 2

## What did NOT improve (or regressed)
- H4 (Consistency): 4→3 — reassessed, still 20/33 pages without PageShell
- H9 (Error Recovery): 4→3 — reassessed, other console pages still swallow errors
- Many console pages still use console.error-only or silent catch
- Help/onboarding still at 2/4

## Detector findings — 0 (unchanged)

## Remaining priority issues
1. [P0] Surface data-load/poll errors across console (17+ files with silent/console.error catches)
2. [P1] Replace native title tooltips with accessible Tooltip component + add real help
3. [P2] Reduce cognitive overload in test-chat log panel and replay-compare
4. [P3] Add breadcrumbs or page-level wayfinding
5. [P3] Extend FilterChips to all filter-dense pages
