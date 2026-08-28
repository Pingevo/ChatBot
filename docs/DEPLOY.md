# Deploy Guide — digital.in.th

โฮสต์: `digital.in.th` (Linux server, MongoDB รันบน host เดียวกัน)

## สถาปัตยกรรมบน server

```
digital.in.th (host)
├── MongoDB (รันบน host โดยตรง, port 27017)
│   ├── dbWallet          — สินค้า (ShpProducts, TikProducts, OpenLazadaProducts)
│   └── chatbot_admin     — admin data (KB, sessions, logs, persona, ...)
│
└── Docker containers
    ├── chatbot-shopee   :8010  (Python/FastAPI — บอท Shopee)
    ├── chatbot-lazada   :8011  (Python/FastAPI — บอท Lazada, ยังไม่มีโค้ด)
    ├── chatbot-tiktok   :8012  (Python/FastAPI — บอท TikTok, ยังไม่มีโค้ด)
    └── chatadmin-web    :3000  (Next.js — admin frontend)
```

> **สำคัญ**: ตอนนี้มีโค้ดพร้อมแค่ Shopee + Admin Web
> Lazada และ TikTok อยู่ใน docker-compose แต่ใช้ `profiles` ซ่อนไว้ จะรันเมื่อเขียนโค้ดแล้ว

---

## ขั้นที่ 1: เตรียม server

SSH เข้า server:
```bash
ssh user@digital.in.th
```

ติดตั้ง Docker + Docker Compose:
```bash
# ติดตั้ง Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# logout แล้ว login ใหม่เพื่อใช้ docker ได้ไม่ต้อง sudo

# ตรวจว่าติดตั้งสำเร็จ
docker --version
docker compose version
```

ตรวจว่า MongoDB รันอยู่บน host:
```bash
mongosh --eval "db.adminCommand('ping')"
# หรือ
systemctl status mongod
```

---

## ขั้นที่ 2: clone โค้ด

```bash
cd /opt
git clone <repo-url> ChatBotProductMS
cd ChatBotProductMS
```

---

## ขั้นที่ 3: สร้างไฟล์ .env

สร้าง 3 ไฟล์ env (อย่า commit ขึ้น git — อยู่ใน .gitignore แล้ว):

### `.env.chatbot.shopee` — บอท Shopee

```bash
cat > .env.chatbot.shopee << 'EOF'
# ── MongoDB (เชื่อม host MongoDB ผ่าน host.docker.internal) ──
MONGO_URI=mongodb://host.docker.internal:27017/
MONGO_DB=dbWallet
MONGO_COLLECTION=ShpProducts

# ── Admin DB ──
ADMIN_MONGO_URI=mongodb://host.docker.internal:27017/
ADMIN_MONGO_DB=chatbot_admin

# ── Gemini LLM ──
GEMINI_API_KEY=ใส่-key-จริง-ที่นี่
GEMINI_MODEL=gemini-2.5-flash

# ── Internal secret (ต้องตรงกับ .env.web) ──
CHATBOT_INTERNAL_SECRET=สุ่ม-string-ยาวๆ-ที่นี่

# ── Web search fallback (optional) ──
OPENROUTER_API_KEY=ใส่-ถ้า-มี
OPENROUTER_SEARCH_MODEL=google/gemini-2.5-flash:online

# ── Embedding ──
EMBEDDING_DEVICE=cpu
EOF
```

### `.env.chatbot.lazada` — บอท Lazada (เตรียมไว้ ยังไม่รัน)

```bash
cat > .env.chatbot.lazada << 'EOF'
MONGO_URI=mongodb://host.docker.internal:27017/
MONGO_DB=dbWallet
MONGO_COLLECTION=OpenLazadaProducts
ADMIN_MONGO_URI=mongodb://host.docker.internal:27017/
ADMIN_MONGO_DB=chatbot_admin
GEMINI_API_KEY=ใส่-key-จริง-ที่นี่
GEMINI_MODEL=gemini-2.5-flash
CHATBOT_INTERNAL_SECRET=สุ่ม-string-ยาวๆ-ที่นี่
EMBEDDING_DEVICE=cpu
EOF
```

### `.env.chatbot.tiktok` — บอท TikTok (เตรียมไว้ ยังไม่รัน)

```bash
cat > .env.chatbot.tiktok << 'EOF'
MONGO_URI=mongodb://host.docker.internal:27017/
MONGO_DB=dbWallet
MONGO_COLLECTION=TikProducts
ADMIN_MONGO_URI=mongodb://host.docker.internal:27017/
ADMIN_MONGO_DB=chatbot_admin
GEMINI_API_KEY=ใส่-key-จริง-ที่นี่
GEMINI_MODEL=gemini-2.5-flash
CHATBOT_INTERNAL_SECRET=สุ่ม-string-ยาวๆ-ที่นี่
EMBEDDING_DEVICE=cpu
EOF
```

### `.env.web` — Admin Web (Next.js)

```bash
cat > .env.web << 'EOF'
# ── MongoDB (Next.js รันใน container เชื่อม host) ──
ADMIN_MONGO_URI=mongodb://host.docker.internal:27017/
ADMIN_MONGO_DB=chatbot_admin

# ── JWT ──
ADMIN_JWT_SECRET=สุ่ม-string-ยาวๆ-อีก-อัน-ที่นี่
ADMIN_SESSION_TIMEOUT_HOURS=8

# ── Chatbot proxy ──
CHATBOT_INTERNAL_SECRET=ต้อง-ตรง-กับ-ไฟล์-บอท
CHATBOT_BASE_URL_SHOPEE=http://chatbot-shopee:8010
CHATBOT_BASE_URL_LAZADA=http://chatbot-lazada:8011
CHATBOT_BASE_URL_TIKTOK=http://chatbot-tiktok:8012

# ── Email (Resend, optional) ──
RESEND_API_KEY=
RESEND_FROM_EMAIL=noreply@digital.in.th
APP_BASE_URL=https://digital.in.th

# ── AI Usage Hub (optional) ──
AI_USAGE_HUB_URL=https://digital.in.th
AI_USAGE_HUB_TOKEN=
EOF
```

> **สำคัญ**: `CHATBOT_INTERNAL_SECRET` ใน `.env.web` และ `.env.chatbot.*` ต้องเหมือนกัน
> ไม่งั้น Next.js เรียกบอทไม่ได้ (401)

---

## ขั้นที่ 4: build และรัน

### รันเฉพาะที่มีโค้ดแล้ว (Shopee + Admin Web)

```bash
docker compose up -d --build
```

ตรวจสถานะ:
```bash
docker compose ps
docker compose logs -f chatbot-shopee
docker compose logs -f chatadmin-web
```

ทดสอบ:
```bash
# บอท Shopee
curl http://localhost:8010/health

# Admin Web
curl http://localhost:3000/api/auth/me
```

### รัน Lazada/TikTok ด้วย (เมื่อเขียนโค้ดแล้ว)

```bash
docker compose --profile lazada --profile tiktok up -d --build
```

---

## ขั้นที่ 5: ตั้ง Nginx reverse proxy (optional แต่แนะนำ)

ติดตั้ง Nginx:
```bash
sudo apt install -y nginx
```

สร้าง config:
```bash
sudo cat > /etc/nginx/sites-available/chatbot << 'EOF'
server {
    listen 80;
    server_name digital.in.th;

    # Admin Web
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # ไม่ expose บอท port ออก internet โดยตรง
    # Next.js เรียกผ่าน internal docker network อยู่แล้ว
}
EOF

sudo ln -s /etc/nginx/sites-available/chatbot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

ติดตั้ง SSL (Let's Encrypt):
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d digital.in.th
```

---

## ขั้นที่ 6: ดูแลรักษา

### ดู log
```bash
docker compose logs -f                    # ทุก service
docker compose logs -f chatbot-shopee     # เฉพาะบอท Shopee
```

### restart
```bash
docker compose restart chatbot-shopee
```

### update โค้ดใหม่
```bash
git pull
docker compose up -d --build
```

### ดู resource usage
```bash
docker stats
```

### ตรวจ MongoDB connection จาก container
```bash
docker compose exec chatbot-shopee python -c "
from pymongo import MongoClient
c = MongoClient('mongodb://host.docker.internal:27017/')
print(c.list_database_names())
"
```

---

## หมายเหตุสำคัญ

### 1. Embedding model (BAAI/bge-m3 ~4GB)
- โหลดครั้งแรกตอนบอท start (ใช้เวลา 5-10 นาที)
- เก็บใน volume `hf_cache` — restart ไม่ต้องโหลดใหม่
- กิน RAM ~2GB ตอนรัน
- ถ้า server มี GPU ให้ตั้ง `EMBEDDING_DEVICE=cuda` (เร็วขึ้น 10x)

### 2. product_embeddings.npz (44MB)
- ไฟล์ vector สินค้า pre-computed — copy ไปใน image แล้ว
- ถ้า rebuild embeddings บน local ต้อง copy ไฟล์ใหม่ขึ้น server แล้ว rebuild image

### 3. MongoDB auth
- ถ้า MongoDB มี auth ให้ใส่ username/password ใน URI:
  ```
  MONGO_URI=mongodb://user:pass@host.docker.internal:27017/?authSource=admin
  ```

### 4. Firewall
- เปิดแค่ port 80/443 ออก internet
- port 3000/8010/8011/8012 เปิดเฉพาะภายใน (docker network + localhost)
- port 27017 (MongoDB) เปิดเฉพาะ localhost

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp
sudo ufw deny 8010/tcp
sudo ufw deny 27017/tcp
sudo ufw enable
```

### 5. Backup MongoDB
```bash
# ทำ cron backup ทุกคืน
echo "0 2 * * * mongodump --out /backup/$(date +\%Y\%m\%d)" | crontab -
```
