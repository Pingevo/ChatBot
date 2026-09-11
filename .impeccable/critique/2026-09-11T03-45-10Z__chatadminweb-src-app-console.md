---
target: ChatAdminWeb all pages
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/itdev4/Documents/GitHub/ChatBotProductMS/ChatAdminWeb/src/app/(console)"
timestamp: 2026-09-11T03-45-10Z
slug: chatadminweb-src-app-console
---
# UX Design Critique — ChatAdminWeb `(console)` — Round 4 (post-FilterChips)

Method: dual-agent (A: 1ca2cb0f · B: 73ae73be + parent detector)

## Fixes applied since round 3
1. Created `FilterChips` component at `src/components/ui/FilterChips.tsx` — removable chips for active filters
2. Added `filterBar` slot to PageShell (not yet consumed by pages)
3. Added FilterChips to 4 filter-dense pages: knowledge, triggers, quick-replies, logs

## Design Health Score — Round 4

| # | Heuristic | R1 | R2 | R3 | R4 | Change R3→R4 | Key Issue |
|---|-----------|----|----|----|----|--------------|-----------|
| 1 | Visibility of System Status | 3 | 3 | 3 | 3 | — | Active filters now visible as chips |
| 2 | Match System / Real World | 2 | 3 | 3 | 3 | — | Thai labels in chips |
| 3 | User Control and Freedom | 3 | 3 | 3 | 3 | — | Per-filter removal + clear all |
| 4 | Consistency and Standards | 2 | 3 | 2 | 2 | — | filterBar slot unused; chip labels inconsistent |
| 5 | Error Prevention | 2 | 2 | 2 | 2 | — | No new safeguards |
| 6 | Recognition Rather Than Recall | 2 | 2 | 3 | 3 | — | Chips surface active filter state |
| 7 | Flexibility and Efficiency | 3 | 2 | 3 | 3 | — | One-click chip removal |
| 8 | Aesthetic and Minimalist | 2 | 2 | 2 | 2 | — | Redundant ล้าง buttons next to chips |
| 9 | Error Recovery | 2 | 1 | 2 | 2 | — | Unchanged |
| 10 | Help and Documentation | 1 | 2 | 1 | 2 | ↑1 | (re-assessed) |
| **Total** | | **22** | **23** | **24** | **25** | **+1** | **Needs work** |

## What improved
- Heuristic 6 (Recognition): chips surface active filter state at a glance
- Heuristic 1 (Visibility): users can read active filters without opening dropdowns
- Heuristic 7 (Efficiency): one-click chip removal + clear all
- aria-label count: 4 → 7 (FilterChips adds per-chip aria-label)

## What did NOT improve
- Heuristic 8 (Aesthetic): redundant ล้าง buttons next to FilterChips onClearAll
- Heuristic 4 (Consistency): filterBar slot exists but unused; chip labels inconsistent (raw admin_id vs resolved names)
- text-text-subtle count unchanged (228 in console)
- bg-base count unchanged (15)
- 332 raw `<button>` still missing aria-label

## Detector findings (unchanged)
- `gray-on-color` in `replay-compare/page.tsx:1013`
- `side-tab` accent border in `TestChatClient.tsx:1792`
- `broken-image` placeholder in `TestChatClient.tsx:2218`

## Remaining priority issues
1. [P1] Redundant clear controls — remove per-page ล้าง button, rely on FilterChips onClearAll
2. [P1] PageShell.filterBar slot unused — migrate filter rows + chips into slot
3. [P2] Inconsistent chip labels — triggers/quick-replies show raw admin_id
4. [P2] Chip display limits — long values truncated, add title tooltip
5. [P3] Thai copy/spelling polish in FilterChips
