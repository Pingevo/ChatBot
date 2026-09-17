# คู่มือ Deploy — ChatBotProductMS (Docker)

> สำหรับ lead tech ที่จะ deploy ระบบบน server
> ทุกคำสั่งรันจาก root ของ project (`ChatBotProductMS/`)

## ภาพรวมระบบ

```
ChatBotProductMS/                    (root — chatbot backend)
├── .env                             ← env รวมของ chatbot ทั้ง 3 แพลตฟอร์ม
├── .env.web                         ← env ของ Next.js admin + bot-worker
├── docker-compose.yml               ← คุมทุก service
├── docker/
│   ├── Dockerfile.chatbot           ← build chatbot image (ใช้ร่วม 3 แพลตฟอร์ม)
│   └── Caddyfile                    ← config reverse proxy + auto SSL
│
└── ChatAdminWeb/                    (Next.js admin + bot-worker)
    ├── .env                         ← (ไม่ใช้ตอน deploy — ใช้ .env.web ที่ root แทน)
    └── Dockerfile                   ← build Next.js image
```

## Services ที่รัน (default)

| Service | Container | Port | ใช้ env จาก | สถานะ |
|---------|-----------|------|-------------|-------|
| chatbot-shopee | chatbot-shopee | 8010 (internal) | `.env` | พร้อมใช้ |
| chatadmin-web | chatadmin-web | 3000 (internal) | `.env.web` | พร้อมใช้ |
| bot-worker | bot-worker | — | `.env.web` | พร้อมใช้ |
| caddy | caddy | 80, 443 | `docker/Caddyfile` | พร้อมใช้ |

### Services อนาคต (profile — ยังไม่เปิด default)

| Service | Container | Port | Profile | สถานะ |
|---------|-----------|------|---------|-------|
| chatbot-lazada | chatbot-lazada | 8011 | `lazada` | ⚠️ placeholder — ยังไม่มี app.py |
| chatbot-tiktok | chatbot-tiktok | 8012 | `tiktok` | ⚠️ placeholder — ยังไม่มี app.py |

> ⚠️ **lazada/tiktok เป็น placeholder** — `chatbot/lazadachat/` และ `chatbot/tiktokchat/` มีแค่ `__init__.py` ว่าง ไม่มี `app.py` ถ้าเปิดด้วย `--profile lazada` หรือ `--profile tiktok` container จะ crash ทันที (uvicorn หา module ไม่เจอ) ต้อง implement `app.py` จริงก่อนถึงจะเปิดได้

**หลักการ:** chatbot ทั้ง 3 แพลตฟอร์มใช้ `.env` ไฟล์เดียวกัน (ค่า DB, Gemini, OpenRouter ฯลฯ เหมือนกัน) ต่างกันแค่ `APP_MODULE` + `UVICORN_PORT` + `MONGO_COLLECTION` ที่ docker-compose override ผ่าน `environment:`

---

## สถาปัตยกรรม traffic

```
Internet ──→ Caddy (80/443, auto SSL)
              ├── admin.example.com  → chatadmin-web:3000 (Next.js)
              └── bot.example.com    → chatbot-shopee:8010 (FastAPI)

chatadmin-web ──→ chatbot-shopee:8010  (internal, ผ่าน docker network)
bot-worker    ──→ chatbot-shopee:8010  (internal, ผ่าน docker network)
chatbot-shopee ──→ host.docker.internal:27017  (MongoDB บน host)
```

- **Caddy** รับ traffic ภายนอกที่ port 80/443 ทำ SSL อัตโนมัติ (Let's Encrypt)
- **chatadmin-web** และ **chatbot-shopee** ไม่ expose port ออก internet โดยตรง (ใช้ `expose` / `127.0.0.1:` binding)
- **MongoDB** รันบน host ไม่ได้ containerize — container เข้าผ่าน `host.docker.internal`

---

## ขั้นตอน Deploy

### 0. ตรวจสอบ prerequisites บน server

```bash
# ต้องมี Docker + Docker Compose v2
docker --version          # >= 20.10
docker compose version    # >= 2.20

# ต้องมี MongoDB รันอยู่บน host (port 27017)
mongosh --eval "db.adminCommand('ping')"   # หรือ mongo / mongod status

# ต้องเปิด port 80 + 443 บน firewall (สำหรับ Caddy + Let's Encrypt)
# ถ้าใช้ ufw:
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp   # HTTP/3
```

### 1. โคลน/อัปเดตโค้ดบน server

```bash
git clone <repo-url> ChatBotProductMS
cd ChatBotProductMS
# หรือถ้า clone แล้ว: git pull
```

### 2. เตรียมไฟล์ env บน server (2 ไฟล์)

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
APP_BASE_URL=https://admin.โดเมนจริง.com

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
APP_BASE_URL=https://admin.โดเมนจริง.com

# ===== Bot Worker (docker-compose override เป็น true แล้ว แต่ตั้งไว้ก็ได้) =====
BOT_WORKER_ENABLED=true
BOT_WORKER_INTERVAL_MS=2000

# ===== Sync control =====
ENABLE_BACKGROUND_SYNC=false
BACKGROUND_SYNC_INTERVAL_MS=2000

# NOTE: CHATBOT_BASE_URL_* ไม่ต้องตั้ง — docker-compose override เป็น
#   http://chatbot-shopee:8010 / http://chatbot-lazada:8011 / http://chatbot-tiktok:8012
```

#### สุ่ม secret values

```bash
# สุ่ม CHATBOT_INTERNAL_SECRET (ต้องเหมือนกันใน .env และ .env.web)
openssl rand -hex 32

# สุ่ม ADMIN_JWT_SECRET (ต้องเหมือนกันใน .env และ .env.web)
openssl rand -hex 32
```

### 3. ตั้งค่า Caddy (domain + SSL)

Caddy เป็น reverse proxy ที่ทำ SSL อัตโนมัติ (Let's Encrypt) — config อยู่ใน `docker/Caddyfile` ที่ root ของ project

#### กรณี A: มีโดเมนจริง (แนะนำ — SSL อัตโนมัติ)

แก้ `docker/Caddyfile` — uncomment บล็อกกรณี A แล้วแก้โดเมน พร้อม comment บล็อกกรณี B:

```caddyfile
admin.example.com {
    encode zstd gzip
    reverse_proxy chatadmin-web:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}

# ถ้าไม่ต้องการ expose chatbot API ออก internet ให้ comment บล็อกนี้
bot.example.com {
    encode zstd gzip
    reverse_proxy chatbot-shopee:8010 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

**สำคัญ:** ตั้ง DNS A record ให้โดเมนชี้มาที่ IP ของ server ก่อน `docker compose up` ไม่งั้น Caddy จะขอ cert ไม่สำเร็จ

#### กรณี B: ยังไม่มีโดเมน (HTTP, ไม่ SSL — default)

`docker/Caddyfile` ค่า default รัน HTTP บน port 80 อยู่แล้ว — ไม่ต้องแก้อะไร

เข้าผ่าน:
- `http://IP-ของ-server/` → admin web
- `http://IP-ของ-server/bot/health` → chatbot API (มี prefix `/bot`)

พอมีโดเมนแล้ว สลับไปกรณี A (uncomment + แก้โดเมน + comment กรณี B) แล้ว reload:
```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### 4. Build + Start

```bash
cd ChatBotProductMS

# build + start ทุก service พร้อมกัน (default = shopee + admin + worker + caddy)
docker compose up -d --build

# ถ้าจะเปิด lazada/tiktok ด้วย (⚠️ ยังไม่มี app.py — container จะ crash)
# docker compose --profile lazada --profile tiktok up -d --build
```

ครั้งแรกใช้เวลานาน (~10-20 นาที) เพราะ:
- โหลด Python deps + sentence-transformers + torch (~4GB)
- โหลด Node deps + build Next.js
- โหลด HF model cache (เก็บใน volume `hf_cache` รอบต่อไปเร็ว)

### 5. ตรวจสอบ

```bash
# ดู status ทุก container (ทุกตัวควรเป็น Up)
docker compose ps

# ดู log ทั้งหมด
docker compose logs -f

# ดู log แยก service
docker compose logs -f chatbot-shopee
docker compose logs -f chatadmin-web
docker compose logs -f bot-worker
docker compose logs -f caddy

# ตรวจ health (จากใน host)
curl http://localhost:8010/health    # chatbot → {"ok":true,...}
curl http://localhost:3000/api/auth/me  # Next.js (expected 401 — ปกติ)

# ตรวจผ่าน Caddy — กรณี B (ยังไม่มีโดเมน)
curl http://IP-ของ-server/api/auth/me        # expected 401 (admin)
curl http://IP-ของ-server/bot/health         # {"ok":true,...} (chatbot)

# ตรวจผ่าน Caddy — กรณี A (มีโดเมน)
curl https://admin.example.com/api/auth/me   # expected 401
curl https://bot.example.com/health          # {"ok":true,...}

# ตรวจ Caddy cert (กรณี A)
docker compose logs caddy | grep "certificate obtained"
```

### 6. สร้าง superadmin (ครั้งแรก)

ระบบต้องมี superadmin อย่างน้อย 1 คนเพื่อ login ครั้งแรก:

```bash
# รัน script สร้าง superadmin (อยู่ใน ChatAdminWeb/scripts/)
docker compose exec chatadmin-web npx tsx scripts/seed-superadmin.mjs
# หรือรันจาก host:
cd ChatAdminWeb && npx tsx scripts/seed-superadmin.mjs
```

---

## คำสั่งที่ใช้บ่อย

```bash
# rebuild หลังแก้โค้ด
docker compose up -d --build

# รีสตาร์ท service เดียว
docker compose restart chatbot-shopee
docker compose restart chatadmin-web
docker compose restart bot-worker
docker compose restart caddy

# ดู log ย้อนหลัง 100 บรรทัด
docker compose logs --tail 100 chatbot-shopee

# หยุดทั้งหมด (container ยังอยู่)
docker compose stop

# หยุด + ลบ container (volume ยังอยู่)
docker compose down

# หยุด + ลบ container + volume (ระวัง! ลบ HF cache ด้วย ต้องโหลดใหม่)
docker compose down -v

# รันเฉพาะ chatbot (debug)
docker compose up chatbot-shopee

# เข้า shell ใน container
docker compose exec chatbot-shopee bash
docker compose exec chatadmin-web sh

# reload Caddy หลังแก้ Caddyfile (ไม่ต้อง restart)
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

---

## สิ่งที่ต้องระวัง

### 1. MongoDB host
MongoDB รันบน host ไม่ได้ containerize — ใน env ใช้ `host.docker.internal:27017` แทน `127.0.0.1:27017` (docker-compose ตั้ง `extra_hosts` ให้แล้ว)

ถ้า MongoDB รันอยู่อีกเครื่อง (ไม่ใช่ host) ให้แก้ `MONGO_URI` และ `ADMIN_MONGO_URI` เป็น IP จริงของเครื่อง MongoDB และเอา `host.docker.internal` ออก

### 2. ค่าที่ต้องตรงกันทั้ง 2 ไฟล์
- `CHATBOT_INTERNAL_SECRET` — ต้องเหมือนกันใน `.env` และ `.env.web`
- `ADMIN_MONGO_URI` / `ADMIN_MONGO_DB` — ต้องชี้ไป DB เดียวกัน
- `ADMIN_JWT_SECRET` — ต้องเหมือนกัน

### 3. UVICORN_HOST
ใน `.env` ต้องเป็น `0.0.0.0` ไม่ใช่ `127.0.0.1` (ไม่งั้น container ไม่รับ connection จากนอก container)

### 4. HF model cache
ครั้งแรกที่ `docker compose up` chatbot จะโหลด sentence-transformers model (~4GB) ใช้เวลานานหน่อย หลังจากนั้นเก็บใน volume `hf_cache` รีสตาร์ทเร็ว

ถ้า `docker compose down -v` จะลบ `hf_cache` ด้วย → ต้องโหลดใหม่อีกครั้ง

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

### 8. Caddy + Let's Encrypt rate limit
Caddy ขอ SSL cert อัตโนมัติตอน start — ถ้า DNS ยังไม่ชี้มาที่ server จะขอไม่สำเร็จและ retry จนโดน rate limit

**ทางแก้:** ตั้ง DNS ให้ถูกก่อน `docker compose up` หรือใช้กรณี B (HTTP, ไม่ SSL) จนกว่า DNS จะพร้อม

### 9. Safety switches
ค่า default ทุก switch เป็น `false` (ปิดหมด) เพื่อความปลอดภัยสูงสุด — บอทตอบใน shadow mode (เก็บคำตอบใน `shadow_replies` ไม่ส่งจริง)

ถ้าต้องการให้บอทส่งข้อความจริง ต้องเปิด `ENABLE_SEND_MESSAGE=true` ใน `.env` **หลังจากทดสอบเรียบร้อยแล้ว**

---

## Troubleshooting

### chatbot-shopee container รันไม่ขึ้น / restart วนลูป

```bash
docker compose logs chatbot-shopee --tail 50
```

สาเหตุที่พบบ่อย:
- **MongoDB เชื่อมไม่ได้** — ตรวจ `MONGO_URI` ใน `.env` ว่าใช้ `host.docker.internal` และ MongoDB รันอยู่บน host
- **Gemini API key ผิด/หมดโควต้า** — ตรวจ `GEMINI_API_KEY` ใน `.env`
- **HF model โหลดไม่ได้** — ครั้งแรกต้องออนไลน์ ถ้า offline ใช้ volume `hf_cache` ที่เคยโหลดแล้ว

### chatadmin-web ขึ้น 401 ทุกหน้า
ปกติ — ต้อง login ก่อน ถ้ายังไม่มี superadmin รัน `seed-superadmin.mjs` (ดูขั้นตอนที่ 6)

### bot-worker ไม่ทำงาน
```bash
docker compose logs bot-worker --tail 50
```
ตรวจ:
- `BOT_WORKER_ENABLED` ต้องเป็น `true` (docker-compose override ให้แล้ว)
- `ADMIN_MONGO_COLLECTION_MESSAGES` ใน `.env.web` ต้องถูกต้อง
- chatbot-shopee ต้อง healthy (`docker compose ps`)

### Caddy ขอ cert ไม่สำเร็จ
```bash
docker compose logs caddy --tail 50
```
สาเหตุ:
- DNS ยังไม่ชี้มาที่ server → รอ DNS propagate หรือใช้ HTTP ไปก่อน (กรณี B)
- Port 80/443 ถูก block บน firewall → เปิด port
- โดน Let's Encrypt rate limit → รอ 1 ชม. แล้ว retry

### container เข้าถึง MongoDB ไม่ได้ (host.docker.internal ไม่ work)
```bash
# ทดสอบจากใน container
docker compose exec chatbot-shopee curl -v telnet://host.docker.internal:27017
```
ถ้าไม่ติด:
- ตรวจ `extra_hosts` ใน docker-compose.yml (ต้องมี `host.docker.internal:host-gateway`)
- ถ้า MongoDB รันอีกเครื่อง แก้ `MONGO_URI` เป็น IP จริง

### โหลด HF model นานมาก / โหลดซ้ำทุกครั้ง
ตรวจว่า volume `hf_cache` ยังอยู่:
```bash
docker volume ls | grep hf_cache
```
ถ้าหาย (จาก `docker compose down -v`) ต้องโหลดใหม่ครั้งเดียว รอบต่อไปเร็ว

---

## โครงสร้างไฟล์ env สรุป

```
ChatBotProductMS/
├── .env          ← chatbot ทั้ง 3 แพลตฟอร์ม (shopee/lazada/tiktok)
├── .env.web      ← Next.js admin + bot-worker
├── docker/Caddyfile ← reverse proxy + SSL config
└── docker-compose.yml
```

**ไม่ต้องสร้าง:** `.env.chatbot.shopee`, `.env.chatbot.lazada`, `.env.chatbot.tiktok` (เดิมใช้ 3 ไฟล์ ตอนนี้รวมเป็น `.env` ไฟล์เดียว)

---

## อัปเดตระบบ (หลัง deploy แล้ว)

```bash
cd ChatBotProductMS

# 1. ดึงโค้ดใหม่
git pull

# 2. rebuild + restart
docker compose up -d --build

# 3. ตรวจสอบ
docker compose ps
docker compose logs -f --tail 50
```

ถ้าแก้แค่ `docker/Caddyfile` ไม่ต้อง rebuild:
```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

ถ้าแก้แค่ `.env` / `.env.web` ไม่ต้อง rebuild แค่ restart:
```bash
docker compose restart
```

---

## Backup

### สำคัญ: MongoDB อยู่บน host (ไม่ใช่ใน Docker)
backup MongoDB ด้วยเครื่องมือปกติของ MongoDB (`mongodump` / `mongorestore`) ไม่เกี่ยวกับ Docker

### Docker volumes ที่ควร backup
- `hf_cache` — ไม่จำเป็น (โหลดใหม่ได้)
- `caddy_data` — เก็บ SSL cert (โหลดใหม่ได้ แต่เสียเวลา)

```bash
# backup caddy cert
docker run --rm -v chatbotproductms_caddy_data:/data -v $(pwd):/backup alpine \
  tar czf /backup/caddy_data_backup.tar.gz -C /data .

# restore
docker run --rm -v chatbotproductms_caddy_data:/data -v $(pwd):/backup alpine \
  tar xzf /backup/caddy_data_backup.tar.gz -C /data
```

## Data refresh (cron)

bot อ่าน Mongo สด + auto-reload `.npz` เมื่อไฟล์เปลี่ยน (mtime) → rebuild ข้อมูลได้โดยไม่ต้อง restart

```cron
# ทุกคืน 03:00 — export → units → embeddings → image OCR (incremental)
0 3 * * *  /path/to/repo/chatbot/shopeechat/scripts/refresh_data.sh
```

- lock กันรันซ้อน (`exports/.refresh.lock.d`) — cron วันถัดไปข้ามถ้ารอบก่อนยังไม่จบ
- log: `exports/refresh_YYYYMMDD.log`
- export fail → abort ทั้งหมด (ไม่ build บนข้อมูลผิด); ขั้นอื่น fail → log แล้วไปต่อ
- image OCR เป็น incremental (resume จาก `image_texts.jsonl`) — คืนที่ไม่มีรูปใหม่จบในไม่กี่วินาที ไม่เสียค่า Gemini ซ้ำ
- `kb_qa`/`kb_products` ไม่ต้องรอ cron — สดเองผ่าน TTL cache 5 นาที + lazy-embed
