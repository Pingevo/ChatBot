# Unified Chat Inbox — Phase 1: Shopee

Self-hosted unified chat inbox (Zaapi clone). Reads Shopee tokens from an existing
sellcenter system's MongoDB (read-only) — no OAuth flow implemented here.

รับข้อความใหม่แบบเรียลไทม์ผ่าน **webhook ที่ forward มาจาก sellcenter** (ไม่ใช่รับตรงจาก
Shopee — ดู gotcha ข้อแรกใน Iron Rules ด้านล่าง) บวกกับ **polling** (`pollWorker.js`,
20 วิ) เป็น reconciliation คู่กัน

ดูรายละเอียดสถาปัตยกรรมเต็มใน `chat-center-megaplan.md` (ไฟล์แยกที่คุยกันไว้ก่อนหน้า — เดิมชื่อ zaapi-clone-megaplan.md)

## Setup

```bash
cp .env.example .env
# แก้ .env ใส่ค่าจริง: MONGODB_URI, SELLCENTER_MONGO_URI, SHOPEE_PARTNER_KEY
npm install
```

## Run

ต้องรัน 2 process แยกกัน:

```bash
npm start   # web server + admin UI (port จาก .env — ปัจจุบัน 8123 เพราะ 3000 อยู่ใน Windows excluded range)
npm run poll   # polling worker (แยก process กัน server ค้าง)
```

## ⚠️ ก่อนใช้งานจริง — Task 0 (Verification-first)

**ยังไม่ได้ทำ** และต้องทำก่อนต่อร้านจริง ตามที่ระบุใน megaplan ข้อ 9:

1. ต่อ `SELLCENTER_MONGO_URI` จริง ดึง token ตัวอย่างจาก `Shp2022Token` มาดู field จริง
   เทียบกับ `src/services/tokenReader.js` ว่า field ตรงกันไหม (`access_token_time_unix`,
   `expire_in`, `shop_id`, `shopname`)
2. ยิง `get_conversation_list`/`get_message` จริงด้วย token จริง เก็บ raw response ไว้ที่
   `docs/shopee-api-samples/` เทียบกับ field ที่ map ไว้ใน `pollWorker.js`
3. ตรวจสอบหน่วย timestamp จริงอีกครั้ง (`last_message_timestamp` = nanoseconds,
   `created_timestamp` = seconds — ยืนยันจากเอกสารทางการแล้ว แต่ควร sanity-check กับข้อมูลจริง)

## Kill switch

`ENABLE_SEND_MESSAGE=false` (default) ปิดการส่งข้อความออกทั้งหมด เปิดเป็น `true`
ใน `.env` เมื่อพร้อม rollout Phase 1b เท่านั้น (ดู megaplan ข้อ 12)

## Rollout ที่แนะนำ

1. **Phase 1a (read-only)**: เปิด `enabled_for_chat: true` ให้ร้านทดสอบใน `shops`
   collection, ปล่อย polling worker รันคู่ขนานกับ Seller Center app ปกติ 1-2 วัน
   ตรวจ `request_logs` ว่า poll ครบไม่มี error
2. **Phase 1b**: ตั้ง `ENABLE_SEND_MESSAGE=true` เมื่อมั่นใจแล้ว

## Iron Rules (สำคัญ)

- ⛔ **ห้ามแก้ webhook callback URL ที่ลงทะเบียนกับแพลตฟอร์ม (Shopee ฯลฯ) มาเป็นของ ChatBot
  เองเด็ดขาด** — Shopee ให้ลงทะเบียน callback URL ได้ **เส้นเดียวต่อ partner** และเส้นที่
  ลงทะเบียนจริงคือของ **sellcenter** (`https://sales.digital.in.th/shp/push`) ChatBot
  ไม่มีทางได้รับ push ตรงจากแพลตฟอร์มเองได้ ต้องรับผ่านการ forward จาก sellcenter เท่านั้น
  (sellcenter's `ShpPushController.js` case 10 → ChatBot's `POST /webhook/internal/shopee-forward`
  ใน `src/routes/webhook.js`, ตรวจด้วย shared secret `INTERNAL_FORWARD_SECRET` ไม่ใช่ HMAC
  ของแพลตฟอร์ม) ถ้าไปเปลี่ยน callback URL ในคอนโซล Shopee เป็น URL ของ ChatBot เอง
  (เช่น `/webhook/shopee`) โดยไม่ได้ประสานกับทีม sellcenter ก่อน **sellcenter จะหยุดรับ
  push ทั้งหมดทันที** (code 3/4/6/22/29 ที่ sellcenter จัดการอยู่ก็จะพังไปด้วย ไม่ใช่แค่แชท)
  เส้น `POST /webhook/shopee` ในโปรเจกต์นี้เก็บไว้เป็น fallback เผื่ออนาคตค่อยย้าย callback
  มาที่นี่จริงๆ (ต้องวางแผนคู่กับทีม sellcenter ก่อนเสมอ ไม่ใช่แก้ข้างเดียว)
- ห้ามใช้ native Node.js modules — deploy บน Plesk/Passenger
- ห้ามเขียนลง sellcenter's `Shp2022Token` ยกเว้น fallback refresh (มี log ทุกครั้ง)
- id ทั้งหมด (`message_id`, `conversation_id`, `from_id` ฯลฯ) เก็บเป็น String เสมอ —
  ห้ามแปลงเป็น Number เด็ดขาด (int64 precision loss)
