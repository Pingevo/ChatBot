# ChatBotProductMS

ระบบแชทบอทตอบคำถามลูกค้าสำหรับร้านค้าในเครือ (Shopee เป็นหลัก) — Python FastAPI bot + Next.js admin console + MongoDB

## โครงสร้าง repo

```
chatbot/shopeechat/   # Python FastAPI chatbot (ใช้งานจริง) — app.py entry: chat()
  app.py              # ~5,800 บรรทัด — endpoints + orchestration
  llm.py / knowledge_base.py / product_store.py / units.py / retrieval_*.py ...
  kb_zaapi*.py        # Zaapi file-backed KB (import/toggle/search/generation)
  scripts/            # export_mongo.py, build_*.py, import_*.py, publish_generation.py
ChatAdminWeb/         # Next.js 16 admin console (port 3000) — console + bot-worker + API proxy
  src/app/(console)/  # pages: /knowledge, /zaapi-kb-mapping, /generations, /tickets, /botworker ...
  src/backend/        # services: botWorkerService, workflowEngine, mongoClient, systemConfig ...
docs/
  SRS_SSD.md          # spec ฟังก์ชันทั้งหมด (อ่านก่อนแก้โค้ด)
  schema.md           # MongoDB schema ทุก collection + local files
  system-workflow.md  # workflow ภาพรวม (ข้อความ → bot → shadow → review)
  pool-and-mainflow.md# pool/switch/ฟังก์ชันหลักแบบง่าย
  "function and process.md" # รายละเอียดทุกหน้า/flow เชิงลึก
  plans/active|archive/  # แผนงานปัจจุบัน / ประวัติ
  test/               # live/ (ยิงจริง) · offline/ (pytest) · tools/ (script ครั้งเดียว)
  waythrough-ledger.md# ดัชนีงานที่ผ่าน + protocol (อ่าน docs/waythrough-README.md ก่อน)
docker/ + docker-compose.yml + Caddyfile   # deploy
getoutofmywaybotkaikrook.md                # frozen work log (อ่านอย่างเดียว)
getoutofmywaybotkaikrook2.md               # active work log (append-only)
```

## รัน dev

```bash
# bot (FastAPI :8010)
cd chatbot && ../.venv/bin/python -m uvicorn shopeechat.app:app --host 127.0.0.1 --port 8010 --reload

# admin web (:3000)
cd ChatAdminWeb && npm run dev
```

## Deploy (Docker)

```bash
docker compose up -d --build   # chatbot-shopee:8010, chatadmin-web:3000, caddy:80/443
docker compose logs -f
```

MongoDB รันบน host (ไม่ containerize) — admin DB + product DB (`dbWallet`, read-only) · คู่มือเต็ม `docs/DEPLOY.md`

## ทดสอบ

```bash
.venv/bin/python -m pytest docs/test/offline -q   # logic ล้วน ไม่ต้องมี server
python docs/test/run_fresh_tests.sh               # live suite (ต้องมี bot+keys) — ดู docs/test/README.md
```

## เอกสารที่ควรอ่านก่อนทำงาน

| ไฟล์ | เนื้อหา |
|---|---|
| `AGENTS.md` | กฎ repo (บังคับ) — รวม waythrough protocol ข้อ 8 |
| `docs/SRS_SSD.md` | spec ฟังก์ชัน — **ต้องอัปเดตทุกครั้งที่แก้ฟังก์ชัน** |
| `docs/schema.md` | Mongo schema + collection access |
| `docs/system-workflow.md` + `docs/pool-and-mainflow.md` | ภาพรวมการทำงาน + pool/switch |
| `docs/waythrough-README.md` | ระบบ work log 3 ชั้น (raw logs / ledger / protocol) |
| `ChatAdminWeb/AGENTS.md` | กฎเฉพาะ Next.js 16 |

## กฎเหล็ก

- ห้ามอ่าน `.env*` / `มาแล้วจ้า.md` · ห้าม commit secret · `dbWallet` read-only
- แก้ฟังก์ชันใน `chatbot/shopeechat/` → อัปเดต `docs/SRS_SSD.md` section 6
- ก่อน/หลังงาน → append `getoutofmywaybotkaikrook2.md` + อัปเดต ledger (AGENTS.md ข้อ 8)
- `lazadachat/` `tiktokchat/` เป็น placeholder — ห้ามเพิ่มโค้ดจริงโดยไม่อนุมัติ

## Exporter (เดิม)

`chatbot/shopeechat/scripts/export_mongo.py` — dump MongoDB → `exports/<collection>.export.json|csv`
(ค่าจาก `.env`: `MONGO_HOST/USERNAME/PASSWORD/DB` ฯลฯ — ดู `docs/schema.md` §7 สำหรับ artifacts ทั้งหมด)
