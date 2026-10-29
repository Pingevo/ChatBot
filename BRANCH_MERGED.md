# BRANCH_MERGED — งานใน branch นี้ถูก merge ไปแล้ว

**สถานะ: ว่าง (archive)** — branch `codex/zaapi-workflow-foundation` เก็บไว้เป็นประวัติเท่านั้น
งานทั้งหมดถูก merge เข้า branch หลักแล้ว อย่าทำงานใหม่ใน branch นี้

## Merge path

```
codex/zaapi-workflow-foundation
        │  merge commit 30bd506 (conflicts แก้แล้ว 4 ไฟล์)
        ▼
feature-phase3-aswer-quality  ← branch ทำงานหลัก (checkout ที่ /ChatBotProductMS)
        │  merge commit f8ce657 (clean, ไม่มี conflict)
        ▼
main                          ← ต้นทางสุดท้าย (push แล้ว)
```

- วันที่ merge: 2026-10-29
- ทำงานต่อที่: `feature-phase3-aswer-quality` ใน `/Users/itdev4/Documents/GitHub/ChatBotProductMS`

## Logic ถูกย้ายไปไว้ที่ไหนบ้าง

| งาน | ชิ้นหลัก | ตำแหน่งปลายทาง (บน feature/main) |
|---|---|---|
| **Zaapi workflow engine** | node executors canonical, branch semantics, durable waits, binding resolution, handoff/escalation | `ChatAdminWeb/src/lib/workflow/`, `ChatAdminWeb/scripts/bot-worker.ts`, test ใน `ChatAdminWeb/scripts/test-workflow-*.ts` |
| **Zaapi workflow import** | flows import เป็น disabled drafts, binding resolution (all_admins), marketplace flows 06/19/21 deferred | `ChatAdminWeb/src/lib/workflow/zaapiImport.ts` + หน้า workflow UI |
| **Evidence pool switches** | `pool_sources` 4 keys (kb/mongo_catalog/units/image_text) — absent→ON; `kb_source` legacy\|zaapi strict selector | `chatbot/shopeechat/runtime_config.py` (Python owner) + `ChatAdminWeb/src/backend/service/systemConfigService.ts` (`setKbSource` CAS + `zaapiKbReady` gate) |
| **KB admission guards** | kb OFF / kb_source=zaapi → legacy KB zero reads; units/mongo_catalog/image_text OFF → no fetch | `chatbot/shopeechat/knowledge_base.py`, `units.py`, `retrieval_executor.py`, `retrieval_runtime.py`, `app.py` |
| **Zaapi KB corpus** | adapter `kb_zaapi.py` (account-scoped, supporting evidence only), collection `zaapi_kb` (8,600 docs / 118 sources บน `digital.in.th` DB `chatbot`), `manual_edit`/`unscoped` flags | `chatbot/shopeechat/kb_zaapi.py` + `docs/zaapi/script/import_zaapi_kb.py` + raw export `docs/zaapi/kb-export/` |
| **Admin UI** | `/knowledge` corpus switcher (legacy\|zaapi), Zaapi grouped-source list + CRUD + legacy-style filter bar, legacy accordion list, `/config` Evidence Pool card | `ChatAdminWeb/src/app/(console)/knowledge/page.tsx`, `src/components/knowledge/ZaapiKbPanel.tsx`, `src/app/api/zaapi-kb/`, `src/app/(console)/config/page.tsx`, `src/app/api/config/route.ts` |
| **Tests** | pool admission truth-table + zaapi adapter gate | `docs/test/test_pool_sources_admission.py` (28 tests) |

## Conflicts ที่แก้ตอน merge (commit 30bd506)

- `app.py` — เก็บ `_kb_fetcher` (selector legacy/zaapi) + `desc_fetcher` (description recall ของ feature branch) ทั้งคู่
- `retrieval_runtime.py` — เก็บ `history_cards` channel + guard `source_enabled("kb")`
- `docs/SRS_SSD.md` — `to_unit_card` ใช้ signature Phase 11 ของ feature branch; `attach_kb_specs` เก็บ pool-gate note
- `getoutofmywaybotkaikrook2.md` — เก็บ entries ทั้งสองฝั่ง (append-only)

## ทิ้งไว้จงใจ / ข้อจำกัดที่ยังค้าง

- Imported Zaapi workflows ยังเป็น **disabled drafts** — ต้อง resolve bindings + production config ก่อน enable
- Marketplace flows 06/19/21 — deferred (ยังไม่มี real marketplace event adapters)
- Zaapi KB retrieval เป็น keyword/text-match — ยังไม่มี vector embeddings
- หน้า `/config` Evidence Pool: `kb_source` ยัง = `legacy` — flip ผ่าน UI ได้ (gate พร้อมแล้ว)
