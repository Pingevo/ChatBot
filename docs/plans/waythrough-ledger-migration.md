# Plan: Waythrough Ledger Migration (one-time)

## หลักการ

- เป็นงาน **ครั้งเดียว** ไม่ใช่ prerequisite ที่ต้องทำซ้ำทุก task — task ปกติอ่าน ledger + active tail ตาม `AGENTS.md` ข้อ 8
- ใช้ Markdown + คำสั่งมาตรฐาน (`wc`, `sed -n`, `head`, `shasum`, `grep -n '^#'`) เท่านั้น — ไม่มี DB ใหม่, vector search, parser/AI summarizer อัตโนมัติ, dependency ใหม่ หรือ migration script (เพิ่มได้เฉพาะเมื่อมีหลักฐานว่าทำมือไม่พอ และต้องขออนุมัติ)
- Raw logs ไม่ถูกแทน/แก้: frozen ห้ามเปลี่ยนเลย; active append-only
- สถานะเริ่มต้น: `coverage: partial` — frozen semantic coverage 1–240, active semantic coverage 10823–10832 (เฉพาะที่อ่านจริง)
- **แยก 2 อย่าง ห้ามใช้แทนกัน:** (1) active integrity prefix = ยืนยัน append-only (ตั้งที่ EOF แล้ว) (2) semantic coverage ranges = สิ่งที่อ่าน+สรุปจริง. Migration ขยับเฉพาะ (2) และไม่ขยับ/ถอย (1); (1) ขยับเฉพาะเมื่อ append tail ใหม่ถูกตรวจและสรุปแล้ว

## ขั้นตอน

1. **Baseline** — frozen lines/bytes/sha และ active integrity baseline อยู่ใน ledger ส่วน 2 แล้ว (ไม่ต้องทำซ้ำ)
2. **แบ่ง ranges** — ใช้ `grep -n '^## \|^### ' <file>` ทำ heading index แล้วแบ่งแต่ละไฟล์เป็น chunk exact ไม่ซ้อนทับ (ประมาณ 200–300 บรรทัด/รอบ หรือตามขอบ heading) บันทึก plan ranges (ส่วน 4/5 = frozen/active semantic coverage) — ranges index ไม่เรียงลำดับได้ เช่น เริ่มจากช่วงที่ task ต้องใช้
3. **ต่อรอบ (loop)**
   - อ่าน source จริงด้วย `sed -n 'A,Bp'` ของ chunk เดียว
   - เพิ่ม compact entry (id, exact lines, task/date, category, summary, status, superseded-by)
   - entry ที่ cross-chunk (หัวข้อถูกตัดกลาง) ให้ปิด range ที่ขอบ heading ถัดไปแล้วอธิบายใน entry
   - frozen: ตรวจ lines/bytes/sha ก่อนทุกรอบ ไม่ตรง → หยุด
   - active: ตรวจ integrity prefix SHA ก่อนทุกรอบ; รอบ migration เพิ่มเฉพาะ coverage range (ห้ามแตะ integrity prefix)
   - 1 รอบ = 1 commit (ledger เท่านั้น) เมื่อผู้ใช้อนุมัติ
4. **Coverage matrix** — เรียง ranges ของแต่ละไฟล์ตามเลขบรรทัดแล้วตรวจ union ครบ 1..EOF ไม่มี gap/overlap (`sort -n` + เทียบ start(n+1)=end(n)+1 หรืออ่านตา)
5. **Supersede** — รายการซ้ำ/ถูกแทน (เช่น F-012 ซ้ำ F-011) ระบุ superseded-by ไม่ลบทิ้ง
6. **Final** — เมื่อ union ของ coverage ranges ครบทั้ง 2 ไฟล์ + frozen sha และ active integrity prefix sha ตรง → independent review → จึงเปลี่ยนเป็น `coverage: complete`
7. **active ที่งอกเพิ่มระหว่าง/หลัง migration** — จัดการด้วย incremental tail (ledger ส่วน 8): สรุป tail เป็น entry แล้วเลื่อน integrity prefix ไป EOF; ไม่ใช่งานของ migration

## ระหว่าง partial — งานอื่นทำต่อได้เมื่อ

- อ่าน ledger + active tail แล้ว และ integrity (frozen sha, active prefix sha) ผ่าน
- ค้น/อ่านต้นฉบับช่วงที่เกี่ยวกับ task จริง (heading/`grep -n`/`sed -n`)
- รายงาน coverage limitation ตามตรง (ไม่อ้าง full audit)
- ผู้ใช้อนุมัติ scope นั้นภายใต้ targeted coverage

## ลำดับแนะนำ

ranges ที่ task ปัจจุบันต้องใช้ก่อน (targeted) → ที่เหลือตามที่ผู้ใช้ต้องการ; ไม่ต้องเรียงตามเลขบรรทัด

## เกณฑ์เสร็จ

ดู `AGENTS.md` ข้อ 8 G: union ของ coverage ranges ครอบทุกบรรทัด ไม่มี gap/overlap ที่อธิบายไม่ได้, frozen sha ตรง, active integrity prefix sha ตรง, independent review ผ่าน
