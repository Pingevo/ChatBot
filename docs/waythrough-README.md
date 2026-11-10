# Waythrough — ระบบบันทึกงาน (อ่านก่อนแตะ ledger)

มี 3 ชั้น อย่าสับสน:

## 1. Raw logs (source of truth — ห้ามแก้ย้อนหลัง)

| ไฟล์ | สถานะ | ใช้ยังไง |
|---|---|---|
| `getoutofmywaybotkaikrook.md` | **frozen** (8,624 บรรทัด) — อ่านอย่างเดียว | ประวัติเก่า 1–240 indexed, ที่เหลือยังไม่ index (coverage partial) |
| `getoutofmywaybotkaikrook2.md` | **active append-only** (12,693+ บรรทัด) | เขียน "กำลังจะทำ" ก่อนงาน / "ผ่านแล้ว" หลัง verify — ห้ามแก้ย้อนหลัง ห้ามลบ |

## 2. Ledger = ดัชนี (ไม่ใช่ log)

`docs/waythrough-ledger.md` — **สรุปย่อ** ของ raw logs เป็น entry (id, line range, สรุป, status)
- ไม่แทน raw logs — ถ้าขัดกัน raw logs ชนะ
- coverage ตอนนี้ `partial` — ยังไม่ได้อ่าน/index ครบทุกบรรทัด (ห้ามอ้าง "อ่านครบ")

## 3. Protocol ก่อน/หลังงาน (AGENTS.md ข้อ 8)

ก่อนงาน: เช็ค frozen sha + active prefix sha (ใน ledger ส่วน 2) → อ่านเฉพาะ tail หลัง prefix → สรุปเข้า ledger
หลังงาน: append closeout ลง file 2 → สรุปเข้า ledger → วัด EOF ใหม่ → อัปเดต prefix+sha (commit เดียวกัน)

**ห้าม:** แก้ raw log ย้อนหลัง, ลบ entry, claim coverage complete ทั้งที่ยัง partial

## ทำไมต้องมีระบบนี้

raw logs ~19k บรรทัดอ่านทุก session ไม่ scale → ledger เก็บ "อะไรผ่าน/ตัดสินใจอะไร" แบบ compact
แต่ raw logs ยังเป็นหลักฐาน — ledger แค่ชี้ทาง (exact line range) ไปหาต้นฉบับ
