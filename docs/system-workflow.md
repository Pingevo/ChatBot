# System Workflow — การทำงานของระบบ ChatBotProductMS (ภาพรวม)

เอกสารนี้อธิบาย flow หลักแบบภาพรวม — รายละเอียดลึกอยู่ใน `SRS_SSD.md` (section 5/6) และ `function and process.md`

## 1. ส่วนประกอบ

```
ลูกค้า (Shopee/TikTok/Lazada chat)
   │  ข้อความเข้า sellcenter/Zaapi → data writer dump ลง Mongo
   ▼
MongoDB admin DB (conversations_shp / messages_shp — legacy dump ทับเรื่อยๆ)
   │
   ├──▶ ChatAdminWeb (Next.js :3000) — admin console + bot-worker
   │       bot-worker poll messages → buffer (debounce) → processMessage
   │       → workflow engine / trigger → call Python bot → เก็บ shadow_replies
   │       → handoff → assigned_to ใน conversations_shp (แอดมินรับงาน)
   │
   └──▶ Python chatbot (FastAPI :8010, shopeechat.app)
           /chat → intent → retrieval (pool: catalog+units+KB+OCR)
           → LLM ตอบ → guards.enforce → response
```

## 2. Message flow (1 ข้อความลูกค้า)

1. **เข้า:** sellcenter/Zaapi sync เขียน `messages` (role=user, direction=in) + dump `conversations` (ทุก ~2s — field ที่โดนทับคือคอนเทนต์แชท; admin meta อยู่ `status_conversation`/`test_status_conversation` แยก)
2. **Buffer:** bot-worker poll → `buffer_messages` debounce ตาม `bot_buffer_window_ms` (default ~15s) — รวมข้อความติดกันเป็น 1 batch
3. **Process:** workflow engine เช็คก่อน (ถ้า `workflow_enabled`) → trigger → `callBot` → Python `/chat`
4. **Bot ตอบ:** intent classify → fetch_products + KB (ตาม `kb_source`) + web search (ถ้าเปิด) → LLM → guards
5. **เก็บผล:** `shadow_replies` (คำตอบบอท — **ไม่ส่งจริง** ใน pilot) + `chat_processing` (idempotency/outcome) + `botworker_events`
6. **Handoff:** ถ้าบอทส่งต่อ → `assigned_to` + event → แอดมินเห็นใน `/tickets`, `/botworker`, `/shadow-inbox`
7. **Review:** แอดมินเทียบคำตอบบอท vs Zaapi ใน `/replay-compare`, `/shadow-inbox` → approve/mock-send (platform API ปิด — ส่งจริงไม่ได้ใน pilot)

## 3. Knowledge sources (3 ชั้น)

| ชั้น | ที่มา | สวิตช์ |
|---|---|---|
| Product catalog | `dbWallet` (read-only) + sellable units + OCR | `pool_sources.{mongo_catalog,units,image_text}` |
| Legacy KB | `kb_products`/`kb_qa`/`knowledge_base` | `kb_source="legacy"` |
| Zaapi KB (ไฟล์) | `zaapi_kb` rows ตาม registry `zaapi_kb_files` | `kb_source="zaapi"` + per-file `active_rev`/`disabled_rev` |

รายละเอียด pool/switch: `docs/pool-and-mainflow.md`

## 4. Deploy

- `docker compose up -d --build` — services: `chatbot-shopee:8010`, `chatadmin-web:3000`, `caddy:80/443`
- MongoDB รันบน host (ไม่ containerize) — admin DB + product DB (dbWallet, read-only)
- env: `.env` (ห้ามอ่าน/commit) — ดู `docs/DEPLOY.md`

## 5. เอกสารที่เกี่ยว

| ไฟล์ | เนื้อหา |
|---|---|
| `docs/SRS_SSD.md` | spec ฟังก์ชันทั้งหมด (section 6 = รายการฟังก์ชัน + call relation) |
| `docs/schema.md` | MongoDB schema ทุก collection |
| `docs/pool-and-mainflow.md` | pool/switch/ฟังก์ชันหลักแบบง่าย |
| `docs/function and process.md` | รายละเอียดทุกหน้า/flow (เชิงลึก) |
| `docs/waythrough-ledger.md` | index งานที่ผ่าน + กฎ waythrough |
