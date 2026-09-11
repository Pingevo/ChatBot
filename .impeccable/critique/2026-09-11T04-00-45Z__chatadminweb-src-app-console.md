---
target: ChatAdminWeb all pages
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 1
target_identity: "file:/Users/itdev4/Documents/GitHub/ChatBotProductMS/ChatAdminWeb/src/app/(console)"
timestamp: 2026-09-11T04-00-45Z
slug: chatadminweb-src-app-console
---
# UX Design Critique — ChatAdminWeb `(console)` — Round 6 (post-IA-bloat)

Method: dual-agent (A: 6395b1b0 · B: 0129af89 + parent detector)

## Fixes applied since round 5
1. Made "การทดสอบบอท" group collapsible in Sidebar.tsx (10 items hidden by default)
2. Added nav search input at top of sidebar (filters items by label)
3. When searching, all collapsible groups auto-expand
4. Added Search, X icons + aria-labels (search input, clear button)

## Design Health Score — Round 6

| # | Heuristic | R1 | R2 | R3 | R4 | R5 | R6 | Change R5→R6 | Key Issue |
|---|-----------|----|----|----|----|----|----|--------------|-----------|
| 1 | Visibility of System Status | 3 | 3 | 3 | 3 | 3 | 3 | — | Loading, poll, toasts |
| 2 | Match System / Real World | 2 | 3 | 3 | 3 | 3 | 3 | — | Thai labels |
| 3 | User Control and Freedom | 3 | 3 | 3 | 3 | 3 | 3 | — | Collapse/expand, search |
| 4 | Consistency and Standards | 2 | 3 | 2 | 2 | 3 | 2 | ↓1 | PageShell only 8 pages |
| 5 | Error Prevention | 2 | 2 | 2 | 2 | 2 | 2 | — | No new guards |
| 6 | Recognition Rather Than Recall | 2 | 2 | 3 | 3 | 3 | 3 | — | Nav search + collapsible |
| 7 | Flexibility and Efficiency | 3 | 2 | 3 | 3 | 3 | 3 | — | Search + Cmd+B |
| 8 | Aesthetic and Minimalist | 2 | 2 | 2 | 2 | 3 | 3 | — | 10 dev tools hidden |
| 9 | Error Recovery | 2 | 1 | 2 | 2 | 2 | 3 | ↑1 | Reassessed — toasts work |
| 10 | Help and Documentation | 1 | 2 | 1 | 2 | 1 | 1 | — | No in-app help |
| **Total** | | **22** | **23** | **24** | **25** | **26** | **26** | **0** | **Needs work** |

Note: Assessment A reported 29/40 but used different baseline (R5=26 with H4=2, H6=2, H7=2, H8=2, H9=3).
Reconciling with our tracked R5 scores, the actual delta is:
- H6: 3→3 (already 3 in R5)
- H7: 3→3 (already 3 in R5)
- H8: 3→3 (already 3 in R5)
- H9: 2→3 (reassessed upward)
- H4: 3→2 (reassessed downward — PageShell still only 8 pages)
Net: 26→26 (H9 +1 offset by H4 -1)

## What improved
- H9 (Error Recovery): reassessed 2→3 — catchError toasts work
- Nav search input with aria-label
- "การทดสอบบอท" collapsible (10 items hidden by default)
- aria-label count in Sidebar.tsx: 1→3

## What did NOT improve
- H4 (Consistency): reassessed 3→2 — PageShell still only 8 pages
- ~30+ silent `.catch(() => setX([]))` remain
- No in-app help (H10)
- Nav search has no empty state, no fuzzy match

## Detector findings (unchanged)
- `gray-on-color` in `replay-compare/page.tsx:1013`
- `side-tab` accent border in `TestChatClient.tsx:1792`
- `broken-image` placeholder in `TestChatClient.tsx:2218`

## Remaining priority issues
1. [P0] Finish PageShell rollout — only 8/28+ pages use it
2. [P1] Nav search under-polished — no empty state, no fuzzy match
3. [P2] ~30+ silent `.catch(() => setX([]))` still swallow load failures
4. [P3] No in-app help, tooltips, or empty-state guidance
5. [P3] Detector findings: gray-on-color, side-tab, broken-image
