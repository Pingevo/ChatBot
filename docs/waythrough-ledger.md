# Waythrough Ledger (canonical index)

## 1. Purpose และ authority

- ดัชนี/สรุป compact ของ raw logs — **ไม่แทน raw logs**; ถ้าขัดกัน raw logs ชนะ
- Raw logs: `getoutofmywaybotkaikrook.md` (frozen) + `getoutofmywaybotkaikrook2.md` (append-only active)
- โปรโตคอลอ่าน/เขียน: `AGENTS.md` ข้อ 8 · แผน migration: `docs/plans/waythrough-ledger-migration.md`
- ความหมาย status: `verified` = raw log บันทึก test/evidence ว่าผ่านและ ledger ตรวจต้นฉบับแล้ว · `historical-unverified` = log เองระบุว่ายังไม่ verify เต็ม/evidence บาง · `superseded` = มี entry ใหม่แทน (ระบุ superseded-by)

## 2. Integrity metadata

ตรวจ "ไฟล์ไม่ถูกแก้ย้อนหลัง" เท่านั้น — **ไม่ได้แปลว่าเนื้อหาถูกอ่านหรือ index แล้ว** (ดู coverage ส่วน 4–5)

Frozen:

| field | value |
| --- | --- |
| frozen_file | `getoutofmywaybotkaikrook.md` |
| frozen_lines | 8624 |
| frozen_bytes | 892284 |
| frozen_sha256 | `a67b91526019270975652ab8cbd07aadeab482d8a59d442e679eafc40f520341` |

Active append-only integrity baseline:

| field | value |
| --- | --- |
| active_file | `getoutofmywaybotkaikrook2.md` |
| active_integrity_prefix_lines | 10832 |
| active_integrity_prefix_sha256 | `723f3350ad0d5fa2ce0974302f37d616ab00b4e6efd317aa1edffd868b14617c` |
| active_line_count_at_baseline | 10832 (bytes 2085662) |
| active_integrity_recorded_at | 2026-11-03T17:52+0700 |

Baseline ตั้งที่ EOF หลัง append correction note (บรรทัดสุดท้ายของ task นี้) แล้ววัดทั้งไฟล์

## 3. Coverage status

`coverage: partial`

- semantic coverage (ส่วน 4–5) ยังไม่ครบ — ห้ามอ้างว่า full historical audit ผ่าน
- integrity baseline ที่ EOF ไม่ได้แปลว่า active 1..EOF ถูกอ่าน
- งานใหม่อ่านเฉพาะ active tail หลัง `active_integrity_prefix_lines`; ประวัติที่ coverage ยังขาดใช้ targeted search + อ่าน exact range + เพิ่ม coverage entry (AGENTS.md ข้อ 8)

## 4. Frozen semantic coverage ranges

| range | state |
| --- | --- |
| 1–240 | read + indexed (ส่วนที่ 6: F-001..F-013) |
| 241–8624 | ไม่ได้ index (gap) |

## 5. Active semantic coverage ranges

| range | state |
| --- | --- |
| 10823–10832 | read + indexed (A-001) |
| 1–10822 | ไม่ได้ index (gap) |

## 6. Ledger entries

F-xxx = frozen `getoutofmywaybotkaikrook.md` (อ่านจริง 1–240); A-xxx = active `getoutofmywaybotkaikrook2.md` (10823–10832) — ช่วงบรรทัดตรวจกับต้นฉบับแล้ว

| id | lines | task / date | category | summary | status |
| --- | --- | --- | --- | --- | --- |
| F-001 | 1–34 | protocol / freeze 2026-09-17 | decision/approval | ไฟล์ freeze; งานใหม่เขียนใน file 2; ลำดับงาน C→A→B→D→Q14→Replay UI; **ไม่มี Phase 4 contract** ใน 1–240 | verified |
| F-002 | 38–56 | C context loss | passed behavior | `conversation_products.py` timeline anchor/suggestion; active = anchor ล่าสุด else suggestion; `[สินค้า: id]` จาก messageService; Q1–Q4 ผ่าน | verified |
| F-003 | 58–62 | A claim trigger | passed behavior | คำถามรับประกันเข้า claim flow ผิด → warranty detection จับก่อน; Q11 ผ่าน | verified |
| F-004 | 64–70 | B claim cascade | passed behavior | claim state machine เลิก flow ได้; Q12 trust, Q13 compat ไม่ถูกดัก | verified |
| F-005 | 72–76 | D trust | passed behavior | แก้ prompt/context ตอบ authenticity/shipping/sealed/warranty; Q5,Q8,Q9 — evidence บางในบรรทัดนี้ | historical-unverified |
| F-006 | 78–92 | Q14 ดึงผิดรุ่น | regression lock | root cause 4 จุด: CONV-ACTIVE หลัง history block, "ดูสินค้า" ใน new_topic_kws, `_ref_regex_products` reset, fetch_products ทับ; routing ผ่าน (products=1 BioKoop) แต่ LLM 429 → **answer ไม่ verify**. อย่าให้ active anchor ถูกทับ | historical-unverified |
| F-007 | 94–113 | Order lookup | passed behavior | `order_store.py` + `extract_order_sn`/`lookup_order`/`build_order_context`; flow ผ่าน (found / not-found) แต่ LLM 429 → answer ไม่ verify | historical-unverified |
| F-008 | 115–126 | Ticket panel order history | passed behavior | API orders route + `OrderHistorySection`; build ผ่าน, manual UI ไม่ verify; join `customer_id`=`buyer_user_id` (buyer_user_id 0/None เชื่อมไม่ได้) | historical-unverified |
| F-009 | 128–147 | Q2/Q6/Q7 | passed behavior | desc_kw ขยาย, "เปลี่ยน" ออกจาก warranty kw, State 6 post-handoff (บอทหยุดตอบหลัง handoff), prompt อนุญาต history สินค้าเดียวกัน; Q2,Q6,Q7 ผ่าน | verified |
| F-010 | 149–160 | Replay UI | passed behavior | `run_conv` + `?history=1` + 3 tabs; typecheck/build ผ่าน, ผู้ใช้ยังไม่ทดสอบจริง | historical-unverified |
| F-011 | 162–188 | Phase 2Z++++ 2026-09-07 | regression lock | `is_target_device_kw` เพิ่ม regex `^1[1-7][\u0E00-\u0E7F]+$` + `ไอโฟน\s*\d+` กัน "13คะ" ทำให้ข้าม CONV-ACTIVE; unit 14 cases ผ่าน, replay จริงยังไม่ verify. **ประวัติขยาย regex/keyword เฉพาะ case — สนับสนุนกฎ: ห้ามเพิ่ม semantic table/regex โดยไม่ขออนุญาต** (ดูเพิ่ม F-006 `new_topic_kws`, F-009 `desc_kw`) | historical-unverified |
| F-012 | 190–216 | Phase 2Z++++ (duplicate) | superseded | เนื้อหาซ้ำ F-011 ทุกบรรทัด | superseded (by F-011 — duplicate, ไม่มี info ใหม่) |
| F-013 | 218–240 | Phase 3C order lookup ครบ + order anchor 2026-09-07 | pending/deferred work | `[order: sn]`, ฟิลด์ order เพิ่ม, order anchor, ส่งเลข order เฉยๆ → ตอบรับสั้นไม่เรียก LLM, `order_sn` ใน ChatRequest; py_compile/tsc/lookup ผ่าน; **หัวข้อยังต่อหลังบรรทัด 240 และยังไม่ indexed (gap ส่วน 7)** | historical-unverified |
| A-001 | 10823–10832 | waythrough protocol correction 2026-11-03 | decision/approval | ผู้ใช้อนุมัติเปลี่ยนกฎข้อ 8 เป็น ledger + incremental tail; แยก integrity prefix ออกจาก semantic coverage; docs only | verified |

## 7. Known semantic coverage gaps

- frozen 241–8624 ไม่ได้ index (F-013 ปิดที่ 240 แต่หัวข้อ Phase 3C ยังต่อหลัง 240)
- active 1–10822 ไม่ได้ index
- Q14 / order (F-006, F-007) ระดับ answer ไม่ verify เพราะ provider 429
- ไม่ใช้ `/tmp/p4ledger/ledger.md` (ไม่ได้ตรวจ checksum/ต้นฉบับ)

## 8. Update procedure

ก่อนงาน:
1. frozen: `wc -l -c` + `shasum -a 256 getoutofmywaybotkaikrook.md` ต้องตรงส่วน 2 (ไม่ตรง → หยุด)
2. active: `head -n <active_integrity_prefix_lines> getoutofmywaybotkaikrook2.md | shasum -a 256` ต้องตรงส่วน 2 (ไม่ตรง → หยุด)
3. อ่านเฉพาะ tail: `sed -n '<N+1>,$p' getoutofmywaybotkaikrook2.md`; ถ้ามี tail → สรุปเป็น entry + เพิ่มส่วน 5 ก่อนเริ่มงานใหม่
4. ประวัติที่ coverage ขาด: `grep -n` หา heading → `sed -n 'A,Bp'` อ่าน exact range → เพิ่ม entry + ส่วน 4/5/7

หลังงาน (บังคับ):
1. append closeout ลง active log (append สุดท้าย)
2. สรุป tail ที่เพิ่มใน task เข้า ledger เป็น entry exact range + อัปเดตส่วน 5
3. วัด EOF line/bytes + `shasum -a 256` ทั้งไฟล์ → อัปเดตส่วน 2 (`active_integrity_*`, recorded_at)
4. ห้ามให้ ledger อ้าง verified ถ้า evidence ไม่ผ่าน; ห้ามเขียน active เพิ่มหลังวัด baseline

ถ้างานหยุดก่อนอัปเดต ledger: session ถัดไปเห็น tail หลัง prefix เดิม ต้องสรุปก่อนเริ่มงานใหม่

integrity prefix กับ semantic coverage ห้ามใช้แทนกัน; migration ขยับเฉพาะ coverage ranges

## 9. Verification checklist

- [ ] frozen lines/bytes/sha ตรงส่วน 2
- [ ] active prefix sha (1..active_integrity_prefix_lines) ตรงส่วน 2
- [ ] tail ถูกอ่านและสรุปเป็น entry ก่อนเลื่อน integrity prefix
- [ ] ทุก entry เป็น exact inclusive range + category + status; `verified` มี evidence ใน raw log
- [ ] ก่อน `coverage: complete`: union ของ coverage ranges ครบทุกบรรทัดของ frozen และ active ไม่มี gap/overlap ที่อธิบายไม่ได้, integrity ทั้งสองตรง, independent review ผ่าน

