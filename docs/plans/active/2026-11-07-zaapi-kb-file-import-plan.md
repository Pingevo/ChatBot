# Plan: Zaapi KB — นำเข้าไฟล์ตรงเป็นข้อมูลต้นฉบับ (spec v4, ledger A-098..A-102)

Date: 2026-11-07 · Branch: feature-botlogic-kb-workflow · Status: approved direction, pre-implementation

## Root cause [โค้ดจริง]

- `kb_source=zaapi` → `app.py:1218` `_grouped_kb_fetcher` → `kb_zaapi.zaapi_kb_evidence` → `kb_zaapi_retrieval.load_active_generation` อ่าน `zaapi_kb_records` manifest/active gen เท่านั้น — raw rows ใน `zaapi_kb`/`zaapi_kb_raw_sources` ไม่ถูกอ่าน → `zaapi_no_active` (blackhole)
- Canonical path ต้องแปลงผ่าน Gemini (importer `--canonicalize`) — ผู้ใช้ปฏิเสธ: เสี่ยงข้อมูลเพี้ยน + cost + ขั้นตอนเกิน
- Legacy `zaapi_kb` docs ไม่มี `source_file` → ใช้เป็น serving contract ไม่ได้โดยตรง; manual docs (no `source_file`) ต้องคงไว้

## Data contract

Row (collection `zaapi_kb`): `_id=sha256(file|rev|sheet|row_index)`, `source_file`, `file_rev`,
`sheet`, `row_index`, `source_row`, `fields` (คอลัมน์→ค่า verbatim), `text` ("k: v" join),
`kind` ("file_row"|"text"), `imported_at`, `file_sha256`; scope อยู่ที่ file level (registry).
Manual docs = `{source_file: {$exists:false}}` — ห้ามแตะ.

Registry (`zaapi_kb_files`, `_id`=filename ตรงทุกตัวอักษร): `active_rev`, `file_sha256`,
`accounts` (shop scope), `platforms`, `row_count`, `imported_by`, `updated_at`.
ชื่อไฟล์เดิม = replace ทั้งชุด (rev+1, CAS flip จุดเดียว); ชื่อใหม่ = แหล่งเพิ่ม; ห้ามจับคู่ข้ามชื่อ.
Log (`zaapi_kb_import_log`): apply/rollback/sweep — who, when, revs, counts, status.

Visibility = row `{source_file,file_rev}` == registry pair; manual มองเห็นเสมอ.
Apply: parse→validate→insert rev ใหม่→verify count→CAS `{_id,active_rev:old}`→mark old `expire_at`→log.
Rollback: CAS กลับ prev_rev ถ้า rows ยังอยู่ + clear `expire_at`. Sweep: delete `expire_at<now` (รันตอน apply/sweep call).

## Search (v4 — ไม่มี persistent vector, ไม่มี cache)

`kb_zaapi_files.zaapi_search(shop, platform, query)`:
registry → visible pairs + scope filter (accounts/platforms ว่าง = ทุกร้าน) →
`zaapi_kb.find($or)` (manual รวม) → Python prefilter (need refs substring + trigram Dice) top-K →
lazy-embed `embed_query`+`embed_texts` cosine → hits `{record_id="file::sheet::row", payload.text,
meta{file,sheet,row}, kind="kb", _qa_score/_qa_sim=cosine}`.
Reads/request: 2 (registry+rows) · Writes: 0 · embed: local BGE-M3 เฉพาะ top-K.

## Wiring (owner เดิม — ไม่มี owner ใหม่)

- productish (needs product/compare/compat): `zaapi_kb_evidence` (kb_zaapi.py) → `kb_zaapi_files.search` →
  supporting_evidence `kind="kb"`, `record_id`, `meta.file/sheet/row` (raw rows ไม่มี canonical meta → ไม่ใช้ `kb_zaapi` kind)
- QA/FAQ/troubleshoot: `knowledge_base.search_qa` zaapi branch → `zaapi_search` → hits `{a:text, q:"", _qa_sim, _qa_score, _qa_source:"zaapi", model_codes จาก row text}` → `qa_context`/`qa_troubleshoot_tips` gates เดิม (_QA_MIN_SCORE 0.45 / min_sim 0.5)
- informational policy (warranty/shipping): `get_general_faq` zaapi branch → `zaapi_search(topic)` → `{answer}` (contract เดิม)
- return_policy eligibility: `_pdec` typed decision owns — unchanged (raw text ไม่ใช่ structured record)
- Legacy mode: `_legacy_allowed()` gate เดิม — zaapi branch ทั้งหมดเช็ค `kb_source()=="zaapi"` เท่านั้น; legacy read = 0

## Endpoints (FastAPI owner — spec approved)

app.py (internal-secret middleware เดิม):
- `POST /zaapi-kb/import/preview?filename&accounts&platforms` (octet-stream) — parse→diff→JSON, 0 writes
- `POST /zaapi-kb/import/apply?...` — apply ตาม flow ข้างบน
- `POST /zaapi-kb/import/rollback?file` — CAS กลับ
- `GET /zaapi-kb/export?file` → xlsx bytes (values round-trip)
- `GET /zaapi-kb/files` → registry + counts (UI list)

Next.js: `api/zaapi-kb/[...path]/route.ts` (ใหม่ — binary-safe; proxy เดิม `req.text()` ทำ binary พัง, ไม่แตะ proxy)
UI: `/knowledge` Zaapi tab — Import modal (file + scope + preview→confirm) + Export; Legacy tab คงเดิม

## Changed-file manifest

1. `chatbot/shopeechat/kb_zaapi_files.py` (ใหม่ — parse/apply/rollback/sweep/export/search/status)
2. `chatbot/shopeechat/kb_zaapi.py` (evidence → files backend)
3. `chatbot/shopeechat/knowledge_base.py` (search_qa + get_general_faq zaapi branches, hit handling)
4. `chatbot/shopeechat/app.py` (5 endpoints)
5. `ChatAdminWeb/src/app/api/zaapi-kb/[...path]/route.ts` (ใหม่)
6. `ChatAdminWeb/src/app/(admin)/knowledge/page.tsx` (Zaapi tab)
7. `docs/test/offline/test_zaapi_kb_files.py` (ใหม่)
8. `docs/SRS_SSD.md` §6

Dormant (ไม่ลบ — cleanup แยก): `kb_zaapi_retrieval.py` canonical path, importer `--canonicalize`, `zaapi_kb_records` readers.

## Implementation order (A→G ตาม PART 4)

A. `kb_zaapi_files`: parse+preview (0 writes) → B. apply/CAS/rollback/sweep → C. export →
D. endpoints+Next route+UI → E. `zaapi_kb_evidence`+`search_qa`+`get_general_faq` →
F. app.chat() e2e (FAQ/troubleshoot/policy) → G. readiness = registry+active searchable rows
