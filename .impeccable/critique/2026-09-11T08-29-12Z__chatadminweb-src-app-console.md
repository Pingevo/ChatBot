# Impeccable Critique — 2026-09-11T08-29-12Z

## Score: 35/40 (↑ +1 จาก 34)

### Changes in this round (P7b/c/d/e/f)

**P7b — Silent load failures fixed:**
- 6 pages: toast error on load failure (was silent empty array)
- triggers, quick-replies, knowledge, logs, shops, contacts

**P7c — Inline field validation:**
- triggers: name + keywords show red border + error text when touched & empty
- quick-replies: title + body show red border + error text when touched & empty
- knowledge: topic + answer show red border + error text when touched & empty
- All 3 pages: touched state resets when opening form

**P7d — Bulk actions (triggers only):**
- selectedIds state, toggleSelect, toggleSelectAll, handleBulkDelete
- Bulk action bar (warning-soft) when items selected
- Select-all checkbox + per-row checkbox with aria-label
- Bulk delete with confirmation

**P7e — Tooltips for technical terms:**
- Created Tooltip component (hover/focus, role="tooltip", 4 sides)
- workflows: status filter, enabled filter, priority badge
- triggers: topic label, action label
- knowledge: type label, platform label

**P7f — Accessible dropdowns:**
- 19 custom dropdowns across 4 pages got aria-expanded, aria-haspopup="listbox"
- Menu divs got role="listbox" + aria-label
- triggers: 6, quick-replies: 6, knowledge: 5, logs: 2

### Heuristic Scores

| # | Heuristic | Score | Notes |
|---|----------|-------|-------|
| 1 | Visibility of System Status | 4/4 | Load failures surfaced, inline validation, saving states |
| 2 | Match System / Real World | 4/4 | Thai terminology + tooltips explain technical values |
| 3 | User Control and Freedom | 4/4 | Confirm dialogs, Esc clear, bulk-select/cancel |
| 4 | Consistency and Standards | 3/4 | FormField unused; inline validation duplicated |
| 5 | Error Prevention | 4/4 | On-blur validation + disabled save + confirm modals |
| 6 | Recognition Rather Than Recall | 4/4 | Filter chips, badges, shortcuts, tooltips |
| 7 | Flexibility and Efficiency | 3/4 | Bulk delete on triggers only; no saved filters |
| 8 | Aesthetic and Minimalist | 3/4 | Filter bars crowded; bulk bar adds noise |
| 9 | Error Recovery | 3/4 | No undo/retry in toasts; form discard unguarded |
| 10 | Help and Documentation | 3/4 | Tooltips good start; no glossary/onboarding |

### Remaining Issues
1. FormField component unused — validation duplicated inline
2. Bulk actions only on triggers
3. Custom dropdowns lack keyboard navigation (arrow keys, Escape)
4. No undo/retry in toasts
5. Form discard unguarded
6. No saved filter presets

### Verification
- tsc --noEmit: exit 0 ✅
- detector src/app/(console): [] ✅
- detector src/components: [] ✅
