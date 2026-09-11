# Critique Round 26 — 2026-09-11T09:17Z

## Score: 33/40

| # | Heuristic | Score | Notes |
|---|----------|-------|-------|
| 1 | Visibility of System Status | 4 | role="status" on Loading, aria-current on Pagination/Sidebar, role-gated subtitles |
| 2 | Match System / Real World | 3 | Thai labels via actionTypeLabel, but raw IDs remain in logs table |
| 3 | User Control and Freedom | 4 | Backdrop/Escape close, ConfirmDialog cancel, arrow-key dropdown nav, / search |
| 4 | Consistency and Standards | 3 | useListboxNav shared, Pagination shared, role="dialog" on 9 modals; tabs lack role="tablist" |
| 5 | Error Prevention | 3 | htmlFor/id/aria-invalid/aria-describedby wired; no focus-to-error on submit |
| 6 | Recognition Rather Than Recall | 4 | Filter chips, aria-pressed, aria-current, Thai labels, icons |
| 7 | Flexibility and Efficiency | 4 | Arrow nav, Enter-to-submit, / search, bulk select, Ctrl+B |
| 8 | Aesthetic and Minimalist | 2 | Dense filter bars, 10-column log table, long form modals |
| 9 | Error Recovery | 3 | Toasts + ConfirmDialog; no undo for bulk delete |
| 10 | Help and Documentation | 4 | /help with glossary, per-page anchors, tooltips |

## Changes in this round (P11a-h)

### P11a — quick-replies bug fixes
- Fixed platform/shop toggle: compute nextPlatforms FIRST, then filter shop_ids
- Added canEditPage(user, "quickreply") role gating — Add/Edit/Delete/Toggle/bulk buttons hidden when read-only

### P11b — Knowledge uses Pagination component
- Replaced manual prev/next with shared Pagination (aria-current="page")

### P11c — aria-current on active controls
- Sidebar active Link: aria-current="page"
- Knowledge tabs: aria-pressed
- Logs view-mode toggle: aria-pressed

### P11d — Logs expansion a11y + humanize
- List expand button: aria-expanded
- Table row: tabIndex, role="button", onKeyDown Enter/Space
- actionTypeLabel() helper for Thai action labels in filter chip + badges

### P11e — Loading/EmptyState live regions
- Loading.tsx: role="status", aria-label="กำลังโหลด"
- EmptyState.tsx: role="status" (later removed — not a live region)

### P11f — Modal dialog semantics (9 modals)
- ImageViewer, CloseChatModal, knowledge/quick-replies/triggers form modals, workflows/shop-settings/tickets/live-assignment
- All got role="dialog", aria-modal="true", aria-labelledby + title id

### P11g — Labels htmlFor/id + aria-describedby
- triggers/quick-replies/knowledge: all labels have htmlFor, inputs have id
- Invalid inputs: aria-invalid="true", aria-describedby → error text id

### P11h — Dropdown arrow nav + aria-activedescendant
- Created useListboxNav hook in useKeyboardShortcuts.ts
- All 19 dropdowns: ArrowUp/Down, Enter/Space, Escape, aria-activedescendant, role="option", aria-selected
- Listbox focuses on open via inline ref callback

### P11i — Form onSubmit + Enter-to-submit
- triggers/quick-replies/knowledge: <form onSubmit>, Save button type="submit"

## Remaining Issues
1. Modals lack focus trap/restore
2. Tabs lack role="tablist"/"tab"/"tabpanel"
3. Logs table still shows raw IDs
4. No undo for destructive actions
5. No focus-to-first-error on submit
6. Platform/shop toggle buttons in forms lack aria-pressed

## Recommendations
1. Add focus trap to modals
2. Convert tabs to ARIA tab pattern
3. Hide raw IDs behind tooltips in logs table
4. Add undo for delete/toggle
5. Focus first invalid field on submit attempt
