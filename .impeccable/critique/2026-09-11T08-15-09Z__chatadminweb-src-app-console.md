# Impeccable Critique — 2026-09-11T08-15-09Z

## Score: 34/40 (↑ +2 จาก 32)

### Changes in this round (P6a/b/c/d/e/f)

**P6a — useEscToClear wired:**
- 5 pages: Escape clears search (triggers, quick-replies, knowledge, workflows, logs)

**P6b — Shared FilterSelect:**
- Created `src/components/ui/FilterSelect.tsx`
- Migrated workflows from 4 native `<select>` to `<FilterSelect>`

**P6c — Visible form validation:**
- triggers: silent return → toast.error("กรุณาตั้งชื่อทริกเกอร์") + toast.error("กรุณาเพิ่มคำสำคัญ...")
- quick-replies: silent return → toast.error("กรุณาตั้งชื่อคำตอบเร็ว") + toast.error("กรุณากรอกเนื้อหา...")
- knowledge: silent return → toast.error("กรุณากรอกหัวข้อ") + toast.error("กรุณากรอกคำตอบ") + toast.error("กรุณากรอกยี่ห้อหรือรุ่น...")

**P6d — Error/404 pages:**
- not-found.tsx: 404 with Compass icon, Thai message, dashboard link
- global-error.tsx: global error boundary with AlertCircle, reset
- error.tsx: route error boundary with error message + reset
- loading.tsx: route loading with Loading component

**P6e — Auth loading:**
- AppShell: removed plain text, now shows only Loading component

**P6f — Keyboard shortcut hints:**
- 5 pages: `<kbd>/</kbd>` hint next to search inputs

### Heuristic Scores

| # | Heuristic | Score | Notes |
|---|----------|-------|-------|
| 1 | Visibility of System Status | 4/4 | Live counts, toasts, clean spinner; some load catches silent |
| 2 | Match System / Real World | 3/4 | Thai labels good; logs still mixes English categories |
| 3 | User Control and Freedom | 4/4 | Esc clears, confirm dialogs, undo toast, modal overlay close |
| 4 | Consistency and Standards | 3/4 | FilterSelect unifies workflows; other pages still hand-roll dropdowns |
| 5 | Error Prevention | 3/4 | toast.error validation; still post-submit not inline; no dirty-form guard |
| 6 | Recognition Rather Than Recall | 4/4 | kbd hint, icons, filter chips, help links |
| 7 | Flexibility and Efficiency | 3/4 | / + Esc + filter chips; no bulk actions or saved filters |
| 8 | Aesthetic and Minimalist | 3/4 | Token palette clean; filter bars crowded on smaller screens |
| 9 | Error Recovery | 4/4 | 404 + error + global-error + undo; some messages generic |
| 10 | Help and Documentation | 3/4 | Help icons + anchors; no tooltips or glossary |

### Remaining Issues
1. Filter UI inconsistency — only workflows uses FilterSelect
2. Post-submit validation only — no inline field errors
3. Silent load failures — catch blocks swallow errors
4. Custom dropdowns lack accessibility (aria, keyboard nav)
5. No bulk actions or saved filters
6. Help is shallow — no tooltips/glossary

### Verification
- tsc --noEmit: exit 0 ✅
- detector src/app/(console): [] ✅
- detector src/components: [] ✅
