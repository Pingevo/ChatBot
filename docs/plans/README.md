# docs/plans — แผนงาน (แยก active / archive)

## active/ — งานปัจจุบัน/รอทำ (17 ไฟล์)

| กลุ่ม | ไฟล์ |
|---|---|
| **Master + register** | `2026-10-21-zaapi-workflow-kb-pool-master-plan.md` (master plan หลัก), `2026-11-06-remaining-work-register.md` (งานค้างรวม) |
| **Phase 4 canonical retrieval** (design เสร็จ ยังไม่ implement runtime) | `2026-11-04-phase4-zaapi-canonical-retrieval-design.md`, `...-implementation.md`, `deferred-pairing-contract.md`, `2026-11-14-evidence-pool-kb-selector-plan.md` |
| **R-series (runbook/audit)** | `2026-11-09-r0-ai-usage-plan.md`, `r1-phase4b-refresh-runbook.md` (steps 1–4 approved, build/publish/cron ยังไม่), `r3-botworker-canary-plan.md` (canary QA รอทำ), `r4-r5-audit.md`, `2026-11-09-session-handoff.md` |
| **Zaapi KB** | `2026-11-06-zaapi-kb-diff-import-design.md`, `2026-11-07-zaapi-kb-file-import-plan.md`, `2026-11-09-zaapi-kb-k2-import-plan.md`, `2026-11-09-botworker-human-approval-mock-send-plan.md` |
| **อื่นที่ยัง relevant** | `2026-10-14-conversations-shp-duplicate-remediation-plan.md` (dup issue — user เลือกพักไว้), `waythrough-ledger-migration.md` (ledger protocol — ยัง partial) |

## archive/ — เก่า/implement แล้ว/ถูกแทน (22 ไฟล์)

- **Retrieval redesign Sept** (implement ไปแล้วหลาย phase): `2026-09-21-*` ทั้ง 7 ไฟล์, `2026-09-23-phase4-final-audit`, `2026-09-30-...rebaseline`
- **Task plans ที่ปิดแล้ว**: `task5-core-simplification`, `task6a-rerun-canonical-import`, `test200-fixes`, `plan_dead-context_sellable-ranking`, `planner.md` (buffering), `workflow-planner.md` + `implentplanworkflow.md` (workflow engine — ใช้งานจริงแล้ว)
- **Botworker ยุคก่อน**: `botworker-canary-plan`, `botworker-parallel-plan` (parallel worker implement แล้ว — BW-2)
- **One-off/research**: `compat-requery-typed-plan`, `cert-merge-plan`, `cert-standards-search`
- **Reference**: `2026-10-09-current-system-architecture-audit.md` (audit snapshot เก่า — ใช้อ่านประวัติ)

> กฎ: ไฟล์ใน archive = historical record — อ่านเพื่อความเข้าใจ ไม่ใช่ spec ปัจจุบัน (spec จริงอยู่ `docs/SRS_SSD.md`)
