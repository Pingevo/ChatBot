# Evidence Pool Switches + Strict KB Selector — Implementation Plan

Master plan: `2026-10-21-zaapi-workflow-kb-pool-master-plan.md` §7–8, Workstream E, Stage 3.
Approved design 2026-11-14.

## Contracts (frozen by master plan)

- `pool_sources: {kb, mongo_catalog, units, image_text}` — OFF = ไม่ query, ส่ง 0 candidates เข้า pool
- `kb_source: "legacy" | "zaapi"` — ไม่มี `both`, ไม่มี implicit fallback, flip ผ่าน CAS + audit
- Zaapi ไม่พร้อม → flip `kb_source=zaapi` ถูกบล็อก (readiness gate), fail-closed
- เปลี่ยน dataset ไม่ลบ/ไม่ merge ฝั่งใด
- `let_ai_respond` narrow ได้อย่างเดียว (phase สุดท้าย)

## Owners

| ชิ้น | ไฟล์ |
|---|---|
| Config write/read/whitelist | `ChatAdminWeb/src/backend/service/systemConfigService.ts` |
| Python reader | `chatbot/shopeechat/runtime_config.py` |
| Channel admission | `chatbot/shopeechat/retrieval_executor.py` (channel list), `chatbot/shopeechat/retrieval_runtime.py` (kb_fetcher pass-through) |
| KB-collection guard | `chatbot/shopeechat/knowledge_base.py` entry fns + `units.attach_kb_specs` (kb_products read) |
| image_text guard | `chatbot/shopeechat/units.py::attach_image_texts` + `product_store` image_texts/cert read sites |
| Zaapi KB adapter | `chatbot/shopeechat/kb_zaapi.py` (ใหม่ — contract = `KbEvidenceResult` เดียวกับ `kb_product_evidence`) |
| Importer | `ChatAdminWeb/scripts/import-zaapi-kb.ts` (dry-run/idempotent/fingerprint เหมือน import-zaapi-corpus) |
| Admin UI | `/config` page (dev-only) — Evidence Pool card |
| Readiness | service check: schema+indexes+count+smoke retrieval |

## Phases

### P1 — Central policy + admission (config + runtime + guards)
1. `systemConfigService`: `pool_sources` (default all true), `kb_source` (default `legacy`) — allowedKeys + mergeWithSafety + ADMIN configurable + audit
2. `runtime_config.py`: `pool_sources() -> dict`, `kb_enabled() -> bool`, `kb_source() -> "legacy"|"zaapi"`
3. `retrieval_executor`: ข้าม channel `units`/`legacy`(mongo_catalog) เมื่อ OFF — `SourceAttempt` บันทึก skipped
4. `retrieval_runtime`/`app.py`: kb OFF → ไม่ inject `kb_fetcher`; image_text OFF → `attach_image_texts` no-op + product_store image_texts reads ปิด
5. KB guard ที่ entry fns (lookup_kb, search_qa, qa_context, qa_troubleshoot_tips, kb_product_evidence, get_general_faq) + `attach_kb_specs` → kb OFF คืน empty
6. Tests: truth-table ต่อ source — OFF source zero candidates + zero collection reads

### P2 — zaapi_kb + selector
7. `zaapi_kb` collection + indexes (source_record_id unique, fingerprint, active)
8. Importer dry-run/idempotent
9. `kb_zaapi.py` adapter
10. `kb_source` selector: kb channel + KB guard เลือก backend — zaapi ON → legacy collections zero reads
11. Readiness gate บล็อก flip + UI card /config
12. Tests: legacy→zaapi zero reads, zaapi→legacy zero reads, flip-blocked เมื่อ not ready, importer idempotent

### P3 — let_ai_respond narrowing
13. `let_ai_respond` node ส่ง `pool_narrow` → intersect central set (narrow only) → tests

## หมายเหตุ
- ทุก flag default = behavior เดิม (all sources ON, kb=legacy) — เปลี่ยนได้เฉพาะเมื่อตั้งใจ
- SourceAttempt (retrieval_executor:19-28) มีอยู่แล้ว — ใช้เป็นหลักฐาน zero reads
