# AGENTS.md — ChatBotProductMS

กฎสำหรับ AI agent ที่ทำงานใน repo นี้

## โครงสร้าง repo

- `chatbot/shopeechat/` — Python FastAPI chatbot (Shopee) — ใช้งานจริง
- `chatbot/lazadachat/`, `chatbot/tiktokchat/` — placeholder (ยังไม่ implement)
- `ChatAdminWeb/` — Next.js admin console (มี AGENTS.md ของตัวเอง)
- `docs/` — เอกสารระบบ
- `replay_compare.py` — script replay เปรียบเทียบ bot vs Zaapi

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

### 8. ห้ามลืม — อ่าน `getoutofmywaybotkaikrook.md` ทุกครั้ง

**ไฟล์บังคับ**: `getoutofmywaybotkaikrook.md` (ที่ root ของ repo)

- ต้องอ่านทุกครั้งก่อนทำงานใหม่ใน repo นี้
- เป็น waythrough log — บันทึกทำอะไร แก้อะไร เคสไหนผ่านแล้ว แก้ยังไง
- **ห้ามทำลายเคสที่เคยผ่าน** — ดูใน "เคสที่ผ่านแล้ว" ก่อนแก้
- ก่อนทำอะไรใหม่ → เขียนใน "กำลังจะทำ" ก่อน
- แก้เสร็จ → เขียน "วิธีแก้" + ย้ายไป "ผ่านแล้ว" + อัปเดต "กำลังจะทำ"
- มีกฎเหล็ก: ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify, บันทึก baseline ก่อนแก้, ฯลฯ
