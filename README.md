# ChatBotProductMS — MongoDB Exporter

สคริปต์ Python ดึงข้อมูลจาก MongoDB (host/username/password/db จาก `.env`) แล้ว export เป็นไฟล์ `json` หรือ `csv`

## 1. ติดตั้ง

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. ตั้งค่าการเชื่อมต่อ

```bash
cp .env.example .env
# แก้ค่าใน .env ให้ตรงกับ MongoDB ของคุณ
```

ค่าสำคัญใน `.env`:

| ตัวแปร | ตัวอย่าง | หมายเหตุ |
|---|---|---|
| `MONGO_HOST` | `127.0.0.1:27017` หรือ `cluster.x.mongodb.net` | ถ้าลงท้าย `.mongodb.net` จะใช้ scheme `mongodb+srv` อัตโนมัติ |
| `MONGO_USERNAME` | `myuser` | เว้นว่างได้ถ้า DB ไม่ต้อง auth |
| `MONGO_PASSWORD` | `secret` | |
| `MONGO_DB` | `chatbot_product` | |
| `MONGO_AUTH_SOURCE` | `admin` | default `admin` |
| `MONGO_TLS` | `false` | ตั้ง `true` สำหรับ Atlas ที่บังคับ TLS |
| `MONGO_COLLECTION` | `products` | เว้นว่าง = ดึงทุก collection |
| `EXPORT_FORMAT` | `json` หรือ `csv` | |
| `EXPORT_DIR` | `exports` | |
| `EXPORT_LIMIT` | `0` | 0 = ไม่จำกัด |

## 3. รัน

```bash
# ใช้ค่าจาก .env ทั้งหมด
python export_mongo.py

# ระบุ collection + format ที่ command line (override .env)
python export_mongo.py --collection products --format csv --limit 100
```

ไฟล์จะถูกเขียนไปที่ `exports/<collection>.export.json` (หรือ `.csv`)

## หมายเหตุ

- `.env` อยู่ใน `.gitignore` แล้ว อย่า commit ค่าจริง
- สำหรับ MongoDB Atlas ให้ตั้ง `MONGO_TLS=true` และเพิ่ม IP ของคุณใน Network Access

## 4. แชทบอท (FastAPI + Gemini)

แชทบอทตอบคำถามลูกค้าเกี่ยวกับสินค้า เปรียบเทียบสินค้า แนะนำสินค้า และเรื่องเคลม/รับประกัน
สำหรับร้านในเครือทั้งหมด ใช้สถาปัตยกรรม RAG: กรองสินค้าจาก MongoDB ตามคำถาม
แล้วส่ง context สินค้าเข้า Gemini เพื่อสร้างคำตอบ

### ติดตั้งเพิ่ม

```bash
pip install -r requirements.txt   # รวม fastapi, uvicorn, google-genai แล้ว
```

### ตั้งค่า `.env` (เพิ่ม)

```bash
# ใช้ MONGO_URI โดยตรง หรือใช้ค่า MONGO_HOST/USERNAME/PASSWORD/DB
MONGO_URI=
MONGO_DB=dbWallet
MONGO_COLLECTION=ShpProducts

# Gemini
GEMINI_API_KEY=xxx            # ขอได้จาก https://aistudio.google.com/app/apikey
GEMINI_MODEL=gemini-2.0-flash # หรือ gemini-2.5-flash / gemini-2.5-pro

# Server
UVICORN_HOST=127.0.0.1
UVICORN_PORT=8000
```

### รัน

```bash
uvicorn chatbot.app:app --host 127.0.0.1 --port 8000 --reload
# หรือ
python -m uvicorn chatbot.app:app --reload
```

เปิด docs ทดสอบที่ http://127.0.0.1:8000/docs

### ตัวอย่างการเรียก `/chat`

```bash
curl -s -X POST http://127.0.0.1:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "shop": "IMILabThailand",
    "message": "กล้องวงจรปิด IMILAB รุ่นไหนรับประกันศูนย์ไทย 1 ปี บ้าง และราคาเท่าไหร่",
    "limit": 10
  }' | jq
```

```bash
curl -s -X POST http://127.0.0.1:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "เปรียบเทียบหูฟัง QKZ กับ QCY งบ 500-1500 บาท",
    "limit": 10
  }' | jq
```

Response:
```json
{
  "answer": "...",
  "products": [ { "item_id": ..., "name": ..., "price": {...}, "warranty": {...}, "short_link": ... }, ... ],
  "shop": "IMILabThailand",
  "model": "gemini-2.0-flash"
}
```

### Endpoints

| Method | Path          | คำอธิบาย |
|---|---|---|
| GET  | `/health`     | ตรวจสุขภาพ + นับร้าน/หมวด |
| GET  | `/shops`      | รายชื่อร้านในเครือทั้งหมด |
| GET  | `/categories` | รายชื่อหมวดหมู่ |
| POST | `/chat`       | ส่งคำถาม รับคำตอบ + สินค้าที่เกี่ยวข้อง |

### โครงสร้างโมดูล

```
chatbot/
  __init__.py
  product_store.py   # เชื่อม MongoDB + กรอง/ย่อสินค้าเป็น context
  llm.py             # เรียก Gemini พร้อม system instruction + context
  app.py             # FastAPI routes (/chat, /shops, /categories, /health)
```
