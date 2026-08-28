# คู่มือ Deploy — ChatBotProductMS (Docker)

## ภาพรวมระบบ

```
ChatBotProductMS/                    (root — chatbot backend)
├── .env                             ← env รวมของ chatbot ทั้ง 3 แพลตฟอร์ม
├── .env.web                         ← env ของ Next.js admin + bot-worker
├── Dockerfile.chatbot               ← build chatbot image (ใช้ร่วม 3 แพลตฟอร์ม)
├── docker-compose.yml               ← คุมทุก service
│
└── ChatAdminWeb/                    (Next.js admin + bot-worker)
    ├── .env                         ← (ไม่ใช้ตอน deploy — ใช้ .env.web ที่ root แทน)
    └── Dockerfile                   ← build Next.js image
```

## Services ที่รัน

| Service | Container | Port | ใช้ env จาก | สถานะ |
|---------|-----------|------|-------------|-------|
| chatbot-shopee | chatbot-shopee | 8010 | `.env` | พร้อมใช้ |
| chatbot-lazada | chatbot-lazada | 8011 | `.env` | อนาคต (profile: lazada) |
| chatbot-tiktok | chatbot-tiktok | 8012 | `.env` | อนาคต (profile: tiktok) |
| chatadmin-web | chatadmin-web | 3000 | `.env.web` | พร้อมใช้ |
| bot-worker | bot-worker | — | `.env.web` | พร้อมใช้ |

**หลักการ:** chatbot ทั้ง 3 แพลตฟอร์มใช้ `.env` ไฟล์เดียวกัน (ค่า DB, Gemini, OpenRouter ฯลฯ เหมือนกัน) ต่างกันแค่ `APP_MODULE` + `UVICORN_PORT` + `MONGO_COLLECTION` ที่ docker-compose override ผ่าน `environment:`

---

## ขั้นตอน Deploy

### 1. เตรียมไฟล์ env บน server (2 ไฟล์)

สร้างไฟล์ 2 ไฟล์ที่ root ของ project (ที่เดียวกับ docker-compose.yml):

#### ไฟล์ที่ 1: `.env` (chatbot ทั้ง 3 แพลตฟอร์มใช้ร่วมกัน)

```bash
# ===== MongoDB สินค้า (dbWallet — read-only) =====
MONGO_URI=mongodb://USER:PASS@host.docker.internal:27017/?authSource=dbWallet
MONGO_DB=dbWallet
MONGO_AUTH_SOURCE=dbWallet
MONGO_TLS=false
MONGO_COLLECTION=ShpProducts
TIKTOK_MONGO_COLLECTION=TiksProduct
LAZADA_MONGO_COLLECTION=OpenLazadaProducts

# ===== Admin DB (chatbot — read/write) =====
ADMIN_MONGO_URI=mongodb://USER:PASS@host.docker.internal:27017/?authSource=admin
ADMIN_MONGO_HOST=
ADMIN_MONGO_USERNAME=
ADMIN_MONGO_PASSWORD=
ADMIN_MONGO_DB=chatbot
ADMIN_MONGO_AUTH_SOURCE=admin
ADMIN_MONGO_TLS=false
ADMIN_MONGO_COLLECTION_KB=knowledge_base
ADMIN_MONGO_COLLECTION_LOGS=admin_logs
ADMIN_MONGO_COLLECTION_GUARDRAILS=guardrails
ADMIN_MONGO_COLLECTION_TICKETS=tickets
ADMIN_MONGO_COLLECTION_ADMINS=admins
ADMIN_MONGO_COLLECTION_AUTH_TOKENS=auth_tokens
ADMIN_MONGO_COLLECTION_SESSIONS=sessions

# ===== Gemini API =====
GEMINI_API_KEY=AIza...
GEMINI_API_KEY_1=
GEMINI_API_KEY_2=
GEMINI_API_KEY_3=
GEMINI_API_KEY_4=
GEMINI_API_KEY_5=
GEMINI_API_KEY_6=
GEMINI_API_KEY_7=
GEMINI_API_KEY_8=
GEMINI_API_KEY_9=
GEMINI_KEY_MAX_REQS=500
GEMINI_MODEL=gemini-3.5-flash-lite

# ===== Web Search (OpenRouter) =====
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SEARCH_MODEL=google/gemini-2.5-flash:online
OPENROUTER_REFERER=https://chatbot.local
OPENROUTER_APP_TITLE=ShopeeChatbot

# ===== Internal Secret (ต้องตรงกับ .env.web) =====
CHATBOT_INTERNAL_SECRET=<สุ่มค่าจริง>

# ===== Server =====
UVICORN_HOST=0.0.0.0
UVICORN_PORT=8010

# ===== Admin Auth =====
ADMIN_JWT_SECRET=<สุ่มค่าจริง>
ADMIN_SESSION_TIMEOUT_HOURS=8
AUTH_TOKEN_EXPIRES_MINUTES=15

# ===== Email (Resend) =====
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=noreply@itsr.com
RESEND_FROM_NAME=Chatbot Admin
APP_BASE_URL=https://โดเมนจริง.com

# ===== SSO (system81/sellcenter) =====
SELLCENTER_OAUTH_BASE_URL=https://...
SSO_APP_NAME=...
SSO_AUTO_PROVISION_DOMAIN=...

# ===== Safety switches =====
ENABLE_SEND_MESSAGE=false
ENABLE_MARK_READ=false
ENABLE_PIN=false
ENABLE_POLL=false
POLL_INTERVAL_MS=2000
ENABLE_BACKGROUND_SHOPEE_SYNC=false
ENABLE_WEBHOOK_WORKER=false
WEBHOOK_WORKER_INTERVAL_MS=3000
WEBHOOK_WORKER_BATCH_SIZE=20
WEBHOOK_WORKER_MAX_RETRIES=5
WEBHOOK_WORKER_STALE_MS=60000
ENABLE_LOST_PUSH_RECOVERY=false
LOST_PUSH_RECOVERY_INTERVAL_MS=3600000
ENABLE_ASSIGNMENT_WATCHDOG=false
ASSIGNMENT_WATCHDOG_INTERVAL_MS=120000
PRESENCE_IDLE_MS=600000
PRESENCE_OFFLINE_MS=1800000
CHAT_SLA_ALERT_MS=600000
CHAT_SLA_REASSIGN_MS=1200000

# ===== AI Usage Hub (optional) =====
AI_USAGE_HUB_URL=
AI_USAGE_HUB_TOKEN=
```

#### ไฟล์ที่ 2: `.env.web` (Next.js admin + bot-worker)

```bash
# ===== Admin MongoDB (ต้องตรงกับ .env ฝั่ง chatbot) =====
ADMIN_MONGO_URI=mongodb://USER:PASS@host.docker.internal:27017/?authSource=admin
ADMIN_MONGO_HOST=
ADMIN_MONGO_USERNAME=
ADMIN_MONGO_PASSWORD=
ADMIN_MONGO_DB=chatbot
ADMIN_MONGO_AUTH_SOURCE=admin
ADMIN_MONGO_TLS=false
ADMIN_MONGO_COLLECTION_KB=knowledge_base
ADMIN_MONGO_COLLECTION_LOGS=admin_logs
ADMIN_MONGO_COLLECTION_GUARDRAILS=guardrails
ADMIN_MONGO_COLLECTION_TICKETS=tickets
ADMIN_MONGO_COLLECTION_ADMINS=admins
ADMIN_MONGO_COLLECTION_AUTH_TOKENS=auth_tokens
ADMIN_MONGO_COLLECTION_SESSIONS=sessions
ADMIN_MONGO_COLLECTION_CONVERSATIONS=conversations_shp
ADMIN_MONGO_COLLECTION_MESSAGES=messages_shp
ADMIN_MONGO_COLLECTION_CUSTOMERS=customers_shp
ADMIN_MONGO_COLLECTION_CLOSE_HISTORY=close_history
ADMIN_MONGO_COLLECTION_SHOPS=shops
ADMIN_MONGO_COLLECTION_TRIGGERS=triggers
ADMIN_MONGO_COLLECTION_PUSH_EVENTS=pushevents
ADMIN_MONGO_COLLECTION_REQUEST_LOGS=requestlogs
ADMIN_MONGO_COLLECTION_SYSTEM_CONFIGS=system_configs

# ===== dbWallet (read-only — สินค้า) =====
MONGO_URI=mongodb://USER:PASS@host.docker.internal:27017/?authSource=dbWallet
MONGO_DB=dbWallet
SHP_PRODUCTS_COLLECTION=ShpProducts
TIKTOK_PRODUCTS_COLLECTION=TikProducts
LAZADA_PRODUCTS_COLLECTION=OpenLazadaProducts
SHP_CHAT_CONVS_COLLECTION=ShpChatConversations
SHP_CHAT_MSGS_COLLECTION=ShpChatMessages

# ===== Auth =====
ADMIN_JWT_SECRET=<สุ่มค่าจริง — ต้องตรงกับ .env>
ADMIN_SESSION_TIMEOUT_HOURS=8
AUTH_TOKEN_EXPIRES_MINUTES=15

# ===== Internal Secret (ต้องตรงกับ .env) =====
CHATBOT_INTERNAL_SECRET=<สุ่มค่าจริง — ต้องตรงกับ .env>

# ===== SSO =====
SELLCENTER_OAUTH_BASE_URL=https://...
SSO_APP_NAME=...
SSO_AUTO_PROVISION_DOMAIN=...

# ===== Email =====
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=noreply@itsr.com
RESEND_FROM_NAME=Chatbot Admin
APP_BASE_URL=https://โดเมนจริง.com

# ===== Bot Worker (docker-compose override เป็น true แล้ว แต่ตั้งไว้ก็ได้) =====
BOT_WORKER_ENABLED=true
BOT_WORKER_INTERVAL_MS=2000

# ===== Sync control =====
ENABLE_BACKGROUND_SYNC=false
BACKGROUND_SYNC_INTERVAL_MS=2000

# NOTE: CHATBOT_BASE_URL_* ไม่ต้องตั้ง — docker-compose override เป็น
#   http://chatbot-shopee:8010 / http://chatbot-lazada:8011 / http://chatbot-tiktok:8012
```

### 2. Build + Start

```bash
cd ChatBotProductMS

# build + start ทุก service พร้อมกัน
docker compose up -d --build

# ถ้าจะเปิด lazada/tiktok ด้วย
docker compose --profile lazada --profile tiktok up -d --build
```

### 3. ตรวจสอบ

```bash
# ดู status ทุก container
docker compose ps

# ดู log ทั้งหมด
docker compose logs -f

# ดู log แยก service
docker compose logs -f chatbot-shopee
docker compose logs -f chatadmin-web
docker compose logs -f bot-worker

# ตรวจ health
curl http://localhost:8010/health    # chatbot → {"ok":true,...}
curl http://localhost:3000/api/auth/me  # Next.js
```

### 4. คำสั่งที่ใช้บ่อย

```bash
# rebuild หลังแก้โค้ด
docker compose up -d --build

# รีสตาร์ท service เดียว
docker compose restart chatbot-shopee
docker compose restart chatadmin-web
docker compose restart bot-worker

# หยุดทั้งหมด
docker compose down

# หยุด + ลบ volume (ระวัง! ลบ HF cache ด้วย ต้องโหลดใหม่)
docker compose down -v
```

---

## สิ่งที่ต้องระวัง

### 1. MongoDB host
MongoDB รันบน host ไม่ได้ containerize — ใน env ใช้ `host.docker.internal:27017` แทน `127.0.0.1:27017` (docker-compose ตั้ง `extra_hosts` ให้แล้ว)

### 2. ค่าที่ต้องตรงกันทั้ง 2 ไฟล์
- `CHATBOT_INTERNAL_SECRET` — ต้องเหมือนกันใน `.env` และ `.env.web`
- `ADMIN_MONGO_URI` / `ADMIN_MONGO_DB` — ต้องชี้ไป DB เดียวกัน
- `ADMIN_JWT_SECRET` — ต้องเหมือนกัน

### 3. UVICORN_HOST
ใน `.env` ต้องเป็น `0.0.0.0` ไม่ใช่ `127.0.0.1` (ไม่งั้น container ไม่รับ connection จากนอก container)

### 4. HF model cache
ครั้งแรกที่ `docker compose up` chatbot จะโหลด sentence-transformers model (~4GB) ใช้เวลานานหน่อย หลังจากนั้นเก็บใน volume `hf_cache` รีสตาร์ทเร็ว

### 5. CHATBOT_BASE_URL_* ใน .env.web
**ไม่ต้องตั้ง** — docker-compose override เป็น `http://chatbot-shopee:8010` ฯลฯ ให้แล้ว ถ้าตั้งใน .env.web จะถูก override ทับอยู่ดี

### 6. BOT_WORKER_ENABLED
docker-compose override เป็น `true` ให้ bot-worker แล้ว ไม่ต้องตั้งใน .env.web ก็ได้ (ตั้งไว้ก็ไม่กระทบ)

### 7. MONGO_COLLECTION
docker-compose override `MONGO_COLLECTION` สำหรับแต่ละแพลตฟอร์ม:
- shopee → `ShpProducts`
- lazada → `OpenLazadaProducts`
- tiktok → `TiksProduct`

ถ้าใน `.env` ตั้ง `MONGO_COLLECTION` ไว้ ค่าใน `environment:` ของ docker-compose จะทับ

---

## โครงสร้างไฟล์ env สรุป

```
ChatBotProductMS/
├── .env          ← chatbot ทั้ง 3 แพลตฟอร์ม (shopee/lazada/tiktok)
├── .env.web      ← Next.js admin + bot-worker
└── docker-compose.yml
```

**ไม่ต้องสร้าง:** `.env.chatbot.shopee`, `.env.chatbot.lazada`, `.env.chatbot.tiktok` (เดิมใช้ 3 ไฟล์ ตอนนี้รวมเป็น `.env` ไฟล์เดียว)
