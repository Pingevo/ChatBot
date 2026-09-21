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

### Waythrough log (บังคับอ่านทุกครั้ง — กฎข้อ 8)

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

### 8. ห้ามลืม — อ่าน waythrough log ทุกครั้ง (อ่าน file 1+2, เขียนเฉพาะ file 2)

**ไฟล์บังคับ**: `getoutofmywaybotkaikrook.md` + `getoutofmywaybotkaikrook2.md` (ที่ root ของ repo)

- ต้องอ่าน**ทั้ง 2 ไฟล์**ทุกครั้งก่อนทำงานใหม่ใน repo นี้
- `getoutofmywaybotkaikrook.md` = **history (freeze)** — อ่านอย่างเดียว ห้ามเขียนเพิ่ม
- `getoutofmywaybotkaikrook2.md` = **active** — กำลังจะทำ/กำลังทำ/ผ่านแล้วใหม่/งานค้าง เขียนที่นี่เท่านั้น
- เป็น waythrough log — บันทึกทำอะไร แก้อะไร เคสไหนผ่านแล้ว แก้ยังไง
- **ห้ามทำลายเคสที่เคยผ่าน** — ดูใน "เคสที่ผ่านแล้ว" ทั้ง 2 ไฟล์ก่อนแก้
- ก่อนทำอะไรใหม่ → เขียนใน "กำลังจะทำ" ของ file 2 ก่อน
- แก้เสร็จ → เขียน "วิธีแก้" + ย้ายไป "ผ่านแล้ว" ของ file 2 + อัปเดต "กำลังจะทำ"+"วันเวลาทีแก้"
- มีกฎเหล็ก: ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify, บันทึก baseline ก่อนแก้, ฯลฯ

### 9. แก้ที่ root cause + ขออนุญาตก่อนแก้

- ทุกการแก้ไขต้องแก้ที่ root cause — ห้ามหาทางลัดเพื่อให้เคสตรงหน้าผ่าน แล้วทิ้งช่องว่าง/ปัญหาไว้ให้เคสถัดไป
- ก่อนแก้ต้องวิเคราะห์ก่อนว่า root cause คืออะไร และคิดก่อนว่าจะแก้ยังไง — ห้าม patch ที่อาการ
- ห้ามทำฟังก์ชันซ้อนฟังก์ชันโดยไม่จำเป็น
- ห้ามใช้ guard/helper เป็นตัวแก้ปัญหา — มอง guard เป็นทางลัด ใช้ได้เฉพาะเมื่อจำเป็นต้องใช้จริงๆ เท่านั้น
- ก่อนลงมือแก้ไขทุกครั้ง ต้องเขียน plan วิเคราะห์/audit ก่อน (root cause คืออะไร, กระทบเคสไหนบ้าง, จะแก้ยังไง) แล้วถามผู้ใช้และรออนุญาตก่อนเสมอ — ห้ามแก้ก่อนได้รับอนุญาต

### 10. กฎการ commit

- ห้าม agent commit เองโดยไม่ได้รับอนุญาตชัดเจนจากผู้ใช้ก่อนทุกครั้ง
- แม้งานใน phase จะเสร็จและ test ผ่านแล้ว ให้สรุป diff, test result, และไฟล์ที่เปลี่ยน แล้วถามผู้ใช้ก่อน commit
- ถ้าผู้ใช้ไม่ได้สั่ง commit โดยตรง ให้หยุดที่ working tree เท่านั้น
