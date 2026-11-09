# AGENTS.md — ChatBotProductMS

กฎสำหรับ AI agent ที่ทำงานใน repo นี้

## โครงสร้าง repo

> แผนผังนี้คือแหล่งอ้างอิงหลักสำหรับหาไฟล์ — อ่านก่อนทำงานทุกครั้ง

### ส่วนสำคัญของบอท (core — ห้ามย้าย/ห้ามแตะโดยไม่จำเป็น)

- `chatbot/shopeechat/` — Python FastAPI chatbot (Shopee) — ใช้งานจริง
  - `app.py` — ไฟล์หลัก ~4,300 บรรทัด (entry: `chat()`)
  - `llm.py` — LLM client + answer logic
  - `product_store.py` — ดึง/ค้นสินค้าจาก MongoDB
  - `knowledge_base.py` — KB + RAG
  - `intent_classifier.py` — จำแนก intent (HF model)
  - `warranty.py` — logic รับประกัน/claim flow
  - `order_store.py` — lookup คำสั่งซื้อ
  - `conversation_products.py` — anchor/timeline สินค้าตาม conversation
  - `web_search.py` — web search fallback (`search_and_extract`)
  - `embedding.py` / `persona.py` — embedding helper / persona prompt
  - `scripts/export_mongo.py` — export (ใช้ตอน build embeddings)
  - `scripts/build_embeddings.py` — สร้าง `exports/product_embeddings.npz`
  - `static/index.html` — health/info page
- `chatbot/lazadachat/`, `chatbot/tiktokchat/` — placeholder (ยังไม่ implement — อย่าเพิ่มโค้ดจริง)
- `ChatAdminWeb/` — Next.js admin console (มี `AGENTS.md` ของตัวเอง)

### Script / เครื่องมือช่วย (ไม่ใช่ core บอท)

- `docs/adminbase/script/import_adminbase.py` — import `docs/adminbase/*.xlsx` เข้า MongoDB
- `chatbot/testscript/` — script test/shadow ของบอท (import `shopeechat` ผ่าน sys.path ชี้ parent)
  - `backfill_ai_usage.py` — backfill ข้อมูล AI usage
  - `shadow_openrouter.py` — shadow test เทียบ OpenRouter
  - `test_openrouter_cost.py`, `test_openrouter_full_cost.py` — วัด cost
- `chatbot/frontendScript/replay_compare.py` — script replay เปรียบเทียบ bot vs Zaapi (backend engine ของหน้า `/replay-compare` ใน ChatAdminWeb — spawn ผ่าน API route)
- `ChatAdminWeb/scripts/` — script ช่วย admin (TS): `bot-worker.ts`, `sync-shops.ts`, `seed-superadmin.mjs`, `generate-all-shadow.ts`, `clear-shadow-replies.ts`, `rollout-workflow.ts`, `test-workflow-*.ts`

### Test (สคริปต์ทดสอบ + ผลลัพธ์)

- `docs/test/` — suite ทดสอบ: `testQA2.py`, `test_200.py`, `test_comprehensive.py`, `test_all_conditions.py`, `test_flow.py`, `test_car_charger_regression.py`, `run_daily_tests.py`, `run_fresh_tests.sh`, `check_progress.py`, `diag_car_charger.py`, `analyze_qa_replays.py`, `find_qa_conversations.py`
  - `docs/test/logs/` — log การทดสอบ (gitignore)
  - `docs/test/results/` — ผลลัพธ์ replay/JSON (`replay_*.json`, `openrouter_shadow_*.json`) (gitignore)

### ผลลัพธ์ (results/output — ไม่ใช่โค้ด)

- `exports/` — export ข้อมูลใหญ่ (`ShpProducts.export.json`, `product_embeddings.npz`) — Docker copy `product_embeddings.npz` เข้า image
- `docs/adminbase/` — ไฟล์ต้นฉบับข้อมูลสินค้า (`*.xlsx`) + `script/import_adminbase.py`

### Deploy (Docker)

- `docker/Dockerfile.chatbot` — build image บอท (ใช้ร่วม 3 แพลตฟอร์ม)
- `docker-compose.yml` — คุมทุก service (อยู่ที่ root เพื่อรัน `docker compose up` ได้เลย)
- `docker/Caddyfile` — reverse proxy + auto SSL
- `.dockerignore` — ไฟล์ที่ไม่ copy เข้า image (ต้องอยู่ที่ build context root = repo root)
- `.env` / `.env.example` — env จริง (ห้ามอ่าน/ห้าม commit) / ตัวอย่าง
- `ChatAdminWeb/Dockerfile` — build image Next.js admin
- คำสั่ง: `docker compose up -d --build` / `docker compose logs -f` / `docker compose down`
- Service: `chatbot-shopee:8010`, `chatadmin-web:3000`, `caddy:80/443`, MongoDB รันบน host (ไม่ containerize)

### Doc (เอกสารระบบ)

- `docs/SRS_SSD.md` — **ไฟล์อ้างอิงหลัก** (ต้องอัปเดตทุกครั้งที่แก้ฟังก์ชัน — กฎข้อ 1)
- `docs/schema.md` — schema DB
- `docs/function and process.md` — อธิบายฟังก์ชัน/กระบวนการ
- `docs/DEPLOY.md` — คู่มือ deploy Docker + Caddy (canonical)
- `README.md` — คู่มือ MongoDB exporter
- `ChatAdminWeb/README.md`, `ChatAdminWeb/docs/DATA_SCHEMA.md`

### Plan (แผนงาน)

- `docs/plans/planner.md` — Plan: Message Buffering (Debounce) สำหรับ bot-worker
- `docs/plans/workflow-planner.md` — Plan: Workflow Engine (แบบ Zaapi Flow Builder)
- `docs/plans/implentplanworkflow.md` — Plan: Workflow Implement (multi-branch condition)

### Rule (กฎสำหรับ AI agent)

- `AGENTS.md` (root) — กฎหลักของ repo นี้ (บังคับอ่าน)
- `ChatAdminWeb/AGENTS.md` — กฎเฉพาะ Next.js 16

### Waythrough log (ledger + active tail — กฎข้อ 8)

- `docs/waythrough-ledger.md` — **canonical ledger** (ดัชนี/สรุป อ่านครบทุกครั้ง) + แผน `docs/plans/waythrough-ledger-migration.md`
- `getoutofmywaybotkaikrook.md` — **history (freeze)** — เคสเก่าที่ผ่าน/ปัญหาเก่า อ่านอย่างเดียว ห้ามเขียนเพิ่ม
- `getoutofmywaybotkaikrook2.md` — **active log** — กำลังจะทำ/กำลังทำ/ผ่านแล้วใหม่/งานค้าง เขียนที่นี่เท่านั้น
- `มาแล้วจ้า.md` — ไฟล์ secret deploy (ห้ามอ่านซ้ำ — อนุญาตตอนสร้างครั้งเดียว)

## กฎการแก้ไขโค้ด

### 1. เมื่อเพิ่ม/แก้/ลบฟังก์ชัน → ต้องอัปเดต SRS_SSD.md

ไฟล์อ้างอิงหลัก: `docs/SRS_SSD.md`

ทุกครั้งที่มีการเปลี่ยนแปลงฟังก์ชันใน `chatbot/shopeechat/` ต้องอัปเดต section 6 ของ SRS ให้ครบ:

- **Purpose** — ฟังก์ชันทำอะไร
- **Input** — parameter แต่ละตัว (ชื่อ + type + ความหมาย)
- **Output** — return type + โครงสร้าง
- **Calls** — เรียกฟังก์ชันอะไรบ้างในไฟล์เดียวกัน + โมดูลนอก
- **Called by** — ใครเรียกฟังก์ชันนี้
- **How it works** — ขั้นตอนการทำงาน 3-5 บรรทัด
- **Side effects** — DB write, log, HTTP call, cache
- **Error/fallback** — กรณี error ทำยังไง

### 2. ต้องเขียน call relationship ชัด

เวลาเพิ่มฟังก์ชันใหม่ ต้องระบุใน SRS ว่า:

- ฟังก์ชันนี้เรียกอะไร (Calls)
- ใครเรียกฟังก์ชันนี้ (Called by)
- ทำไมต้องเรียก (เหตุผลในการ call)
- เรียกที่ไหน (file + line)
- เรียกยังไง (ใน context ไหน — เช่น "ใน web search fallback หลัง llm.answer")

### 3. กฎการเขียนโค้ด

- อย่าลบ comment ที่มีอยู่เว้นแต่ได้รับอนุญาต
- comment/docstring ที่เพิ่มหรือแก้ ต้องสั้นและบอกแค่หน้าที่, input, output, ขั้นตอนสำคัญ, function ที่เรียก, fallback/error ที่จำเป็น — ห้ามใส่ประวัติยาวหรือสัญลักษณ์ตกแต่ง
- ใช้ pattern ที่มีอยู่ในไฟล์ — ดู helper ข้างเคียงก่อนเขียนใหม่
- ฟังก์ชัน helper เริ่มต้นด้วย `_` (private)
- ใช้ `from __future__ import annotations` แล้ว type hint ด้วย `|` union
- API key rotation ใช้ pattern `_load_api_keys` + `_next_api_key` + `_client`
- MongoDB admin DB ใช้ env `ADMIN_MONGO_*`, product DB ใช้ env `MONGO_*`
- Lazy import โมดูลหนัก (`warranty`, `intent_classifier`, `web_search`) ใน function ที่ใช้

### 4. คำสั่งที่ใช้บ่อย

- รัน bot: `cd chatbot && uvicorn shopeechat.app:app --port 8010 --reload`
- รัน admin: `cd ChatAdminWeb && npm run dev`
- ตรวจ syntax: `python -m py_compile chatbot/shopeechat/<file>.py`
- ตรวจ charger subtype: `python test/test_charger_subtype.py`

### 5. คำเตือนด้านความปลอดภัย

- ห้ามอ่าน `.env` ทุกชนิด
- ห้ามอ่าน `มาแล้วจ้า.md` (ไฟล์เก็บ secret จริงสำหรับ deploy — อนุญาตเฉพาะตอนสร้างครั้งเดียว ห้ามอ่านซ้ำ)
- ห้าม commit secret/key
- ห้ามแก้ security policy / branch protection
- Product DB (`dbWallet`) เป็น read-only — ห้ามเขียน

### 6. กฎเฉพาะ Next.js

ดู `ChatAdminWeb/AGENTS.md` — มีกฎเฉพาะของ Next.js 16 (อ่าน docs ใน `node_modules/next/dist/docs/` ก่อนเขียน)

### 7. สิ่งที่ต้องระวัง

- `app.py` ใหญ่มาก (~4,300 บรรทัด) — ฟังก์ชัน nested ใน `chat()` ใช้ได้เฉพาะในนั้น
- `_score_card` และ `_is_sold_out` ใน `product_store.py` นิยามแล้วไม่ถูกเรียก — อย่าลบโดยไม่เช็ค
- `search_and_answer` ใน `web_search.py` deprecated — ใช้ `search_and_extract` แทน
- `lazadachat/` และ `tiktokchat/` เป็น placeholder — อย่าเพิ่มโค้ดจริงโดยไม่ได้รับอนุญาต

### 8. ห้ามลืม — waythrough log (canonical ledger + incremental tail, เขียนเฉพาะ file 2)

(แก้ 2026-11-03 ด้วยการอนุมัติของผู้ใช้: การอ่าน raw logs ~19k บรรทัด / ~3 MB ทุก session ไม่ scale)

**A. Source of truth**
- `getoutofmywaybotkaikrook.md` = frozen source of truth (อ่านอย่างเดียว ห้ามแก้)
- `getoutofmywaybotkaikrook2.md` = append-only active source of truth — เขียนที่นี่เท่านั้น
- `docs/waythrough-ledger.md` = ดัชนี/สรุป ไม่แทน raw logs; ห้ามแก้ย้อนหลัง/ลบ/rewrite raw logs

**B. ก่อนงานใหม่ (ไม่ต้องอ่าน raw logs ตั้งแต่บรรทัด 1 และไม่ต้องอ่าน active 1..EOF)**
1. อ่าน ledger ให้ครบ
2. ตรวจ frozen integrity (C) — ไม่ตรง → หยุด
3. คำนวณ SHA-256 ของ active บรรทัด `1..active_integrity_prefix_lines` (D) — ไม่ตรง → หยุด
4. อ่านเฉพาะ active tail `active_integrity_prefix_lines + 1 .. EOF`
5. สรุป tail เข้า ledger เป็น entry (exact range) ก่อนเริ่มงานใหม่
6. งานที่ต้องใช้ historical context ซึ่ง semantic coverage ยังขาด: targeted search (`grep -n` heading/คำค้น) → อ่าน exact source range → เพิ่ม coverage entry
7. รายงาน coverage limitation ตามตรง
- ห้ามบังคับอ่าน active 1..EOF เพียงเพราะ semantic migration ยัง partial

**C. Frozen integrity** — ledger เก็บ line count, byte size, full SHA-256 ของ frozen file; ถ้าไม่ตรง → **หยุดทันที** ห้าม regenerate ledger กลบการเปลี่ยนโดยไม่มี user approval

**D. Active integrity (append-only) แยกจาก semantic coverage — ห้ามใช้แทนกัน**
- integrity: ledger เก็บ `active_integrity_prefix_lines`, `active_integrity_prefix_sha256`, `active_line_count_at_baseline`, `active_integrity_recorded_at` — ยืนยันแค่ว่าบรรทัด 1..N ไม่ถูกแก้ย้อนหลัง (`head -n N file | shasum -a 256`) ตั้ง N = EOF ได้หลังตรวจทั้งไฟล์; **ไม่ได้แปลว่า 1..N ถูกอ่านหรือ index**
- semantic coverage: ledger เก็บ `active_coverage_ranges` (และ frozen coverage ranges) = exact ranges ที่อ่านและสรุปเข้า ledger จริง; partial/ว่างได้แม้ integrity prefix อยู่ที่ EOF; ห้ามอ้าง full coverage จนครบ 1..EOF; migration ขยับเฉพาะ coverage
- integrity prefix ขยับเฉพาะเมื่อ append tail ใหม่ถูกตรวจและสรุปเข้า ledger แล้ว

**E. Ledger entry** ต้องมี: source file, exact inclusive line range (ห้าม `N+`), phase/task/date (ถ้ามี), category (invariant | passed behavior | failed/rejected approach | regression lock | pending/deferred work | decision/approval), concise summary, status (verified | historical-unverified | superseded), superseded-by (ถ้ามี)

**F. Migration state** — `coverage: partial` | `coverage: complete`. ขณะ partial: อ่าน ledger + active tail ตาม B, รายงาน coverage gap, ผู้ใช้อนุมัติให้ทำต่อภายใต้ targeted coverage ได้, ห้ามกล่าวว่า full historical audit ผ่าน

**G. Completion rule** — `coverage: complete` ได้เมื่อ: union ของ coverage ranges ครอบทุกบรรทัดของ raw logs ทั้งสองไฟล์ ไม่มี gap/overlap ที่อธิบายไม่ได้, frozen SHA ตรง, active integrity prefix SHA ตรง, ledger ผ่าน independent review — ถ้า checksum ตัวใดไม่ตรง ห้ามถือว่า complete

**H. Writing rule (บังคับ ไม่ optional)**
- ก่อนเริ่มงาน → append "กำลังจะทำ" ลง file 2
- หลัง verify → append "ผ่านแล้ว/วิธีแก้/งานค้าง" ลง file 2 (append สุดท้ายของ task)
- จากนั้นต้อง: (1) อ่านและสรุป tail ที่เพิ่มใน task เข้า ledger เป็น entry, (2) เลื่อน active integrity prefix ไป EOF ใหม่, (3) คำนวณ prefix SHA ใหม่, (4) อัปเดต metadata — ใน commit เดียวกัน; ห้ามเขียน active เพิ่มหลังวัด baseline
- ถ้างานหยุดก่อนอัปเดต ledger: session ถัดไปจะเห็น tail หลัง prefix เดิม และต้องสรุปก่อนเริ่มงานใหม่
- ห้ามให้ ledger อ้างงานว่า verified ถ้า test/evidence ยังไม่ผ่าน
- **ห้ามทำลายเคสที่เคยผ่าน** — เช็ก ledger entries (invariant / regression lock / passed behavior) ที่เกี่ยวก่อนแก้
- กฎเหล็ก: ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify, บันทึก baseline ก่อนแก้

### 9. แก้ที่ root cause + ขออนุญาตก่อนแก้

- ทุกการแก้ไขต้องแก้ที่ root cause — ห้ามหาทางลัดเพื่อให้เคสตรงหน้าผ่าน แล้วทิ้งช่องว่าง/ปัญหาไว้ให้เคสถัดไป
- ก่อนแก้ต้องวิเคราะห์ก่อนว่า root cause คืออะไร และคิดก่อนว่าจะแก้ยังไง — ห้าม patch ที่อาการ
- ห้ามทำฟังก์ชันซ้อนฟังก์ชันโดยไม่จำเป็น
- ห้ามใช้ guard/helper เป็นตัวแก้ปัญหา — มอง guard เป็นทางลัด ใช้ได้เฉพาะเมื่อจำเป็นต้องใช้จริงๆ เท่านั้น
- ก่อนลงมือแก้ไขทุกครั้ง ต้องเขียน plan วิเคราะห์/audit ก่อน (root cause คืออะไร, กระทบเคสไหนบ้าง, จะแก้ยังไง) แล้วถามผู้ใช้และรออนุญาตก่อนเสมอ — ห้ามแก้ก่อนได้รับอนุญาต

#### กฎ complexity containment (mandatory)

- business behavior ต้องแก้ที่ typed owner เดิมที่มีอยู่ — ห้ามสร้าง owner ใหม่เพื่อหลบ
- การขยาย semantic keyword/phrase/regex (ตารางคำใหม่, คำใหม่ในตาราง, pattern ใหม่ที่ตีความข้อความ) ต้องขออนุญาตผู้ใช้โดยตรงก่อนเสมอ
- guard ทำได้เฉพาะ validate safety/schema invariants — ห้าม infer intent, product type/subtype, retrieval scope, product identity, compatibility, หรือ business semantics ของคำตอบ
- ทุก correction round ต้องรายงาน net change ของ helpers, guards, regexes, keyword tables, และ decision owners — correction ที่เพิ่ม mechanism count ห้ามทำถ้าไม่ได้รับอนุญาตชัดเจน
- local patch ซ้ำหลายจุดสำหรับปัญหาเดียวกัน ต้องถูกรวมเป็น owner เดียว หรือรายงานเป็น missing data contract (อย่าปะต่อ)
- source-text test (เช็คว่ามี/ไม่มีโค้ด) อย่างเดียวไม่พอ — ต้องมี executable behavioral test พิสูจน์พฤติกรรมจริง

### 10. กฎการ commit / branch / PR

- ทำงานบน branch เสมอ — ห้าม commit ตรง `main`
- เมื่อผู้ใช้อนุมัติงานแล้ว → commit เก็บ state บน branch ได้หลายครั้ง (1 commit = 1 fix ที่ verify ผ่าน) ไม่ต้องถามทุก commit
- **ก่อนเริ่มงานใหม่ต้องเช็กทิศทาง branch:** ถ้างานใหม่ไปทิศเดียวกับ branch ปัจจุบัน → commit ต่อบน branch เดิม; ถ้าคนละทิศ → สร้าง branch ใหม่จาก `main` ก่อน commit
- `push` เพื่อสำรองงานขึ้น remote ได้ — push ≠ PR
- เปิด PR ครั้งเดียวตอนงานเสร็จ/พร้อมรีวิว — PR รวมทุก commit บน branch (push commit เพิ่มภายหลัง PR อัปเดตเอง ไม่ต้องเปิดใหม่)
- ก่อน commit ครั้งแรกของแต่ละงาน และก่อนเปิด PR ให้สรุป diff, test result, ไฟล์ที่เปลี่ยน แล้วถามผู้ใช้ก่อน
- ถ้าผู้ใช้ไม่ได้อนุมัติงาน/commit โดยตรง ให้หยุดที่ working tree เท่านั้น
