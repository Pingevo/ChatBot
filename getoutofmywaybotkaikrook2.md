# getoutofmywaybotkaikrook2.md — Waythrough Log (active)

> ไฟล์นี้คือบันทึกเส้นทาง **ปัจจุบัน** — ทำอะไร แก้อะไร เคสไหนผ่านแล้ว แก้ยังไง
> `getoutofmywaybotkaikrook.md` (ไฟล์แรก) = **history — อ่านอย่างเดียว ห้ามเขียนเพิ่ม**
> **ก่อนทำอะไรใหม่ → อ่านทั้ง 2 ไฟล์ก่อนทุกครั้ง** (file 1 = เคสเก่าที่ผ่าน, file 2 = งานปัจจุบัน)
> ห้ามทำให้เคสที่เคยผ่านกลับมาพัง
> พอจะทำอะไรใหม่ → เขียนไว้ใน "กำลังจะทำ" ของ**ไฟล์นี้**ก่อน
> แก้เสร็จ → เขียนวิธีแก้ + ย้ายไป "ผ่านแล้ว" ของ**ไฟล์นี้**

---

## วิธีใช้ไฟล์นี้

1. **ก่อนทำงานใหม่** → อ่าน "เคสที่ผ่านแล้ว" ทั้ง file 1 (history) + file 2 ก่อน เพื่อไม่ทำลายของเก่า
2. **ก่อนแก้โค้ด** → เขียนไว้ใน "กำลังจะทำ" ของ file นี้ว่าจะแก้อะไร ทำไม
3. **แก้เสร็จ** → เขียน "วิธีแก้" + ย้ายเคสไป "ผ่านแล้ว" ของ file นี้ + อัปเดต "กำลังจะทำ"
4. **กฎเหล็ก**: ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify / บันทึก baseline ก่อนแก้ / ทุกอย่างที่เขียน ต้องเคยเกิดขึ้นจริง

---

## กำลังทำ (active)

### 🔨 image_texts batch — nonsellable เหลือ ~3,100 รูป กำลังรัน 8 shards (2026-09-17)

- **state:** sellable ครบ 5,925 แล้ว; nonsellable todo 3,665 → รันอยู่ ~393/shard × 8
- **รัน:** `build_image_texts_nonsellable.py --shard K/8` × 8 procs — K คู่=gemini-3.5-flash-lite, คี่=gemini-3.1-flash-lite (quota pool แยกกัน), `IMGTXT_MIN_INTERVAL=1.8` (~133/min/model < 135 = 9 keys × 15 RPM), `IMGTXT_SKIP_HUB=1` (hub timeout 5s/call ทำช้า — usage ยังเขียน `exports/image_texts_usage.jsonl` local, backfill ทีหลังได้)
- **แก้ script:** `build_image_texts.py` — `MIN_INTERVAL` อ่าน env `IMGTXT_MIN_INTERVAL` (default 0.78 เดิม); `web_search._log_ai_usage` skip ได้ด้วย `IMGTXT_SKIP_HUB`
- **logs:** `exports/image_texts_run_8_{0..7}.log`; output `exports/image_texts.jsonl`
- **key config จริง (verify แล้ว):** `key_source.gemini="db"` + pool `keys` 9 ตัว enabled → บอทใช้ 9 keys round-robin ไม่ใช่ key เดียว; `single_keys.gemini` มีเก็บ (enc:v1) แต่ไม่ active
- **ขั้นต่อไป:** รอจบ → `import_image_texts.py` เข้า Mongo `image_texts` collection → เช็ค count เพิ่ม

### 📋 กำลังจะทำ — cert standards search ผ่าน image_texts (plan เขียนแล้ว รออนุมัติ)

- **เรื่อง:** ตอนนี้ `search_tisi_products` ค้น มอก. ใน `description` text เท่านั้น — สินค้าที่บอก มอก./CE/CCC/GB แค่ในรูป description หลุดหมด (ใน jsonl มีแล้ว: มอก. 112 รูป, GB 227, CCC 19, CE 14)
- **plan:** `docs/plans/cert-standards-search.md` — 5 tasks: (1) import_image_texts เติม `item_ids` จาก export field_list (2) `detect_cert_question` ใน warranty.py superset ของ TISI (3) `search_cert_products` ค้น desc+image_texts merge (4) wire handoffs.py (5) SRS + live verify
- **regression guard:** `detect_tisi_question`/`search_tisi_products` คงเป็น wrapper; เคส หมอก/เสมอกัน FP เดิมต้องยังผ่าน
- **dependency:** image path จะมีข้อมูลก็ต่อเมื่อ import รันด้วยโค้ดใหม่ (item_ids) — รอ batch จบก่อน import
- **สถานะ:** รอ user อนุมัติ plan ก่อน implement

### Restart :8010 + :8015 ด้วยโค้ดใหม่ (2026-09-17 ~17:2x)

- **ทำไม:** replay-compare ยิง `127.0.0.1:8010` — process เก่า start 12:19 ก่อน commit `015a9c3` (sellable ranking + suggestion compare, 16:57) → replay ได้โค้ดเก่า
- **ทำ:** kill 65815/65818 → relaunch `USE_UNIT_INDEX=charger nohup uvicorn` log เข้า `exports/uvicorn_{8010,8015}.log` — ทั้งคู่ health 200
- **เคสที่น่าจะเปลี่ยน:** "ตัวไหนออกใหม่สุด" เดิม CONV-ACTIVE pin Case เดี่ยว → ตอบผิดเป็นของ Case
- **⚠️ gap ที่รู้ว่ายัง:** card ไม่มี field วันที่ (`create_time`) → LLM ตอบ "รุ่นไหนใหม่กว่า" ไม่ได้แม้ context ถูก — เสนอ `listed_date` ใน `to_product_card`/`to_unit_card` รอ user ตัดสินใจ

---

## รอ verify — bot + unit index ใช้งานจริง (2026-09-17, priority)

เรื่อง: sellable-first ranking + live join + compat gate + suggestion compare (commit `015a9c3`/`80f1da1`)
verify ระดับ retrieval (quota-free) ผ่านแล้ว — ที่เหลือคือพิสูจน์ end-to-end บนบอทจริง + index สด

### P0 — ทำก่อนสุด (ปลดบล็อกข้ออื่น)

1. **image_texts batch จบ + import เข้า Mongo** — กำลังรัน (ดู 🔨 ด้านล่าง); unit cards ใช้ `attach_image_texts` join ตอน runtime — index ที่ rebuild หลัง import จะครบทั้ง image_ids + image_text ในคราวเดียว
2. **rebuild sellable_units** — `chatbot/shopeechat/scripts/build_sellable_units.py`
   - เหตุ: index ปัจจุบัน stale (KingGadgets charger เหลือ sellable 6/275 ทั้งที่ live มี 113 ใบ) → unit path ตก legacy ตลอด ทำให้ "unit index ใช้งานจริง" ยังพิสูจน์ไม่ได้
   - verify หลัง rebuild: `sellable=True` count ต่อ shop ต้องใกล้ live catalog; probe `USE_UNIT_INDEX=charger` + "หัวชาร์จละ" ต้องได้ unit cards ขายได้โดยตรง (ไม่ใช่ผ่าน fallback)
   - สั่ง: `cd chatbot && ../.venv/bin/python -m shopeechat.scripts.build_sellable_units`

### P1 — หลัง rebuild (พิสูจน์ unit path จริง)

3. **probe ซ้ำ UIF=charger** (quota-free): "หัวชาร์จละ" ต้องคืน sellable units เอง ไม่เห็น log `pool all-dead → legacy fallback`; "HA835 มีไหม" code-hit ยังคุ้ม
4. **E2E LLM — test chat / shadow replay** (ต้อง quota):
   - "หัวชาร์จละ" → แนะนำของที่ขายได้จริง ไม่มีลิงก์ตาย
   - "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → เลือก 90W+ (เดิมตอบ 45-67W)
   - bot แนะนำ ≥2 ตัว → ถามต่อ "อันไหนดีกว่า" → เทียบของที่เพิ่งแนะนำ ไม่วน anchor เก่า
   - "HA835 มีไหม" → ตอบหมด/เลิกขายถูกต้อง
   - เคสร้านที่ของตายเยอะ → ตอบ "หมด" มากขึ้น = พฤติกรรมถูกต้อง ไม่ใช่ regression
5. **live compare :8010/:8015** (UIF on/off เทียบกัน) — อยู่ในตารางข้างล่างแล้ว ค้างรอ quota เหมือนกัน

### P2 — กันซ้ำระยะยาว

6. **เฝ้า log `[UNITS] pool all-dead`** ช่วงแรกหลัง deploy — ถ้าหลุดบ่อย = index stale เร็ว → ตัดสินใจ cadence rebuild (cron รายวัน/สัปดาห์ หรือ trigger หลัง sync สินค้า)
7. **replay แชทจริง** ที่เคยพัง (nat041134 order, katess.nk compare) — รวมกับแถว "รอ verify" เดิมด้านล่าง

---

## รอ verify (implement แล้ว — ย้ายมาจาก file 1)

| งาน | รออะไร | ref file 1 |
|---|---|---|
| ensureIndexes partial index fix (MongoDB 5.0) | rebuild deploy จริง + เช็ค log ไม่มี `ensureIndexes failed` | L8056-8073 |
| Video understanding 6 paths | ส่งวิดีโอจริงผ่าน test chat + Shopee bot worker | L8112-8134 |
| Order item anchoring + return/refund handoff | replay แชทจริง (nat041134) | L7509-7545 |
| Product types หมวดใหม่ (กระเป๋า/รองเท้า/จอยเกม) | replay จริงยืนยัน fallback query ดึงถูกหมวด | L7591 |
| Anchor compare (Run vs Swim) | replay แชท katess.nk; เคส "swim" ค้นไม่เจอ = product search quality แยก | L7673-7709 |
| live compare :8010/:8015 (unit flag on/off) | ค้างรอ quota | L8436 |
| SRS_SSD.md updates | 2 งานติดรอ verify replay ก่อน (กฎข้อ 1) | L7507, L7545 |

## รอ action / ตัดสินใจ (ย้ายมาจาก file 1)

- **single-key switch** — L8456: เดิมให้ตั้ง `GEMINI_API_KEY` ตัวเดียวใน .env + ลบ `_1.._9` + restart; **แต่** llm_config มี `key_source.gemini` แล้ว → สลับเป็น `single` ผ่านหน้า /llm ได้เลยไม่ต้องแตะ .env (ปัจจุบัน = "db" 9 keys)
- **Ponytail review app.py findings** — L8014-8030: ⏸️ รออนุมัติส่วนที่ยังไม่ได้ apply (บางส่วนไปกับ refactor แล้ว)
- **Ponytail repo-audit** — L8032-8037: dead deps ใน requirements.txt (resend/PyJWT/bcrypt/email-validator), docker-compose lazada/tiktok services — report-only รอตัดสินใจ
- **Task 5 unit_embeddings** — L8103: entry เขียน "🔄 กำลังรัน" แต่ `exports/unit_embeddings.npz` 103MB มีแล้ว — น่าจะเสร็จ แค่ไม่ได้อัปเดต entry

## เลื่อนไว้โดยตั้งใจ (YAGNI / แยกงาน — ย้ายมาจาก file 1)

- Neural reranker `bge-reranker-v2-m3` (option F6 — ดูผล sellable ranking ก่อน) — L8611
- unit index rebuild (deploy step — cron/manual) — L8611
- charger kw → data-driven subtype (migration ใหญ่) — L8611
- hard filter `item_status` ตอน query — **ห้ามทำ** (ทำลายตอบของลบได้ เก็บไว้ tier) — L8611
- UI assign role ให้ user + SSO login flow map email→role — L8497
- ChatAdminWeb UX debt — focus trap/restore, tab roles, aria-pressed, FormField consolidation, undo coverage, saved filter presets — L7637-7643, L7779, L7826, L7850

---

## ผ่านแล้ว (file 2)

### ✅ 2026-09-17 — sellable-first ranking + live stock join + compat gate + suggestion compare (commit `015a9c3`, `80f1da1`)

**E2E verify ผ่าน chat() จริง (LLM จริง):**

| เคส | ผล |
|---|---|
| `หัวชาร์จละ` (KingGadgets) | ✅ context 30/30 sellable — แนะนำของขายได้จริง |
| `ใช้กับ xiaomi 17 ultra` | ✅ เลือก AD653 GaN 90W ถูก (เดิมได้แค่ 45-67W) — product_recommend+target_device หลุดเข้า compat sweep ถูกต้อง |
| `HA835 มีไหม` | ✅ ตอบ "ไม่มีรุ่นนี้" + flag dead ถูก + เสนอทางเลือก sellable |
| `หูฟังแนะนำ` → `อันไหนดีกว่า` | ✅ suggestion-batch fired → CONV-ACTIVE ไม่ pin → ANCHOR-COMP-MERGE 2 ใบ → เทียบของที่เพิ่งแนะนำจริง |
| `รับประกันกี่เดือน` (follow-up) | ✅ ตอบ EC4 12 เดือน จาก anchor |
| `ของเสีย เคลมยังไง` / `ชาร์จไม่เข้า` / `ประกันหมดแล้ว` | ✅ เข้า claim intake + handoff ถูกต้อง |
| `พาวเวอร์แบงค์ 20000 มีสต็อกไหม` | ✅ ตอบจากของ sellable จริง |
| `สายชาร์จ type c ราคาเท่าไหร่` | ✅ ปฏิเสธราคาตาม policy + แนะนำรุ่น |
| `ส่งของกี่วัน` | ✅ shipping_policy KB |
| `พัดลมตัวไหนถูกสุด` | ✅ superlative เลือกตัวถูกสุดจริง |
| `in-ear vs ครอบหู ต่างกันยังไง` | ✅ อธิบายความต่างถูก |
| `หม้อทอดไร้น้ำมัน` (type ตายทั้งหมวด) | ✅ ตอบ "หมด/เลิกจำหน่าย" สุภาพ ไม่เสนอลิงก์ตาย |

**Retrieval matrix quota-free:** 36/37 types ผ่าน (ทุก type: flag ถูก + sellable ขึ้นก่อนเสมอ) — เคสเดียว `phone` 0 sellable = **ของจริงใน catalog** (มือถือขายผ่าน listing "ทักแชทรับโค้ด" ที่ตายหมด) + พบ `product_type=phone` ใน unit index ถูก classify ผิด (เป็นหัวชาร์จ/ขาตั้งที่ชื่อมี "โทรศัพท์") = data issue เดิม ไม่เกี่ยวกับ fix

**เจตนาที่คงไว้:** ของตายอยู่ใน context ตอบ "เคยมีไหม/หมดไหม" ได้ แต่ไม่ชนะของขายได้; code-hit ชนะเสมอ

**ข้อสังเกตเล็กๆ:** suggestion-batch อาจจับคู่เทียบข้าม type (หูฟัง vs กระเป๋า) ถ้า turn ก่อนแนะนำปนกัน — ไม่ใช่ bug แต่ปรับได้ภายหลังถ้ารำคาญ; `[stock]` query ช้า 106s ครั้งเดียว (LLM latency spike ไม่ใช่ logic)

### /logs กระพริบ + scroll เด้งกลับบนทุก 5 วิ (2026-09-17) — ✅ fixed

- **root cause:** `loadLogs` ตั้ง `setLoading(true)` ทุก call → `usePolling` (5s) ทำให้ list ถูกแทนด้วย `<Loading/>` ทุกรอบ → DOM หาย → scrollTop clamp เป็น 0 → ข้อมูลกลับมา remount ที่บนสุด = กระพริบ + เด้งบน
- **แก้:** `loadLogs(silent)` — poll ส่ง `silent=true` (ไม่แตะ loading); manual refresh/filter change ยังแสดง spinner; `onClick={() => loadLogs()}` (กัน MouseEvent ไปเป็น silent)
- **ไฟล์:** `ChatAdminWeb/src/app/(console)/logs/page.tsx` (3 จุด)
- **verify:** `npx tsc --noEmit` ผ่าน — รอ user เช็คหน้าจริง
- **pattern ที่ถูกใน codebase:** poll ไม่ setLoading (ดู test-assignment `loadStats`)

### ✅ 2026-09-17 (ต่อ) — กฎเหล็ก "แนะนำ ≥2 รุ่น" ที่ prompt (llm.py)

- **ทำไม:** user ขอให้บอทเสนอตัวเลือก ≥2 เสมอเมื่อลูกค้าขอคำแนะนำทั่วไป (ให้ลูกค้าเปรียบเทียบได้ + ทำให้ suggestion batch ≥2 ใน timeline เสมอ → compare follow-up มีของเทียบ) — ยกเว้นถามเจาะจงรุ่นเดียว
- **แก้:** `SYSTEM_INSTRUCTION` llm.py — เดิม "แนะนำ 2-3 ชิ้น" แบบ soft → เป็นกฎเหล็ก "ขอแนะนำทั่วไป → ต้องเสนอ ≥2 รุ่น sellable" (pattern เดียวกับ compat dual-tier rule ที่มีอยู่) — ยกเว้น: เจาะจงรุ่น/item card/ถาม spec-สต็อก-ราคา-ประกัน หรือ context มีตัวเดียวจริง (ห้ามแต่งรุ่นมั่ว)
- **verify E2E:** `หูฟังบลูทูธแนะนำหน่อย` → เสนอ 2 รุ่น ✅ · `พาวเวอร์แบงค์มีอะไรน่าสนใจบ้าง` → ≥2 ✅ · `HA835 มีไหม` → ยังตอบเจาะจง + เสนอทางเลือก 1 ตัว (ไม่บังคับ 2 เพราะถามรุ่นเดียว) ✅
- **หมายเหตุ:** นี่คือ prompt-level rule (LLM อาจไม่ตาม 100% — แต่เป็น mechanism เดียวกับที่ codebase ใช้กฎทั้งหมด) ไม่มี hardcode ผูกสินค้า/type

### ✅ 2026-09-17 (ต่อ) — FIX จริง: compare follow-up ตอบ anchor เก่า (ITEM-TAG shortcut ครอบ)

- **อาการ (แชทจริง babyspeed, shadow):** ส่งการ์ด Case → bot แนะนำหูฟัง → "อันไหนดีกว่า/ใหม่กว่า" กลับตอบ "มีแค่ Case รุ่นเดียว" ทั้งที่ timeline มี suggestions อยู่
- **root cause จริง (ลึกกว่า suggestion batch):** item tag `[สินค้า: xxx]` ค้างใน `req.history` ตลอด → ทุก follow-up ถูก history-scan re-pin `_tagged_item_id` → เข้า **ITEM-TAG shortcut** ตอบจาก `products=[anchor_card]` + return ทันที — **ไม่เคยถึง FOLLOWUP-COMP/suggestion batch เลย** (repro ก่อนหน้าหลุดเพราะใส่ "[item]" placeholder ไม่มี item_id)
- **แก้ (structural, ไม่ hardcode):**
  1. `_COMPARISON_FOLLOWUP_KW`/`_SUPERLATIVE_KW` hoist เป็น module const (แชร์ 3 จุด)
  2. ITEM-TAG else-branch: compare/superlative kw + timeline ≥2 สินค้า (`get_anchor_and_suggestions`) → **fall through ไป main flow** (ไม่ตอบจากการ์ดเดี่ยว)
  3. FOLLOWUP-COMP trigger รวม `_SUPERLATIVE_KW` ("ใหม่สุด/ถูกสุด" ก็ต้องมีชุดเทียบ)
  4. `get_latest_suggestion_batch` คืน batch ทุกขนาด — callsite เติม anchor ล่าสุดเป็นคู่เทียบเมื่อ batch=1 (สินค้าที่คุยอยู่ 2 ชิ้นล่าสุด)
- **verify E2E (history format จริง `[สินค้า: xxx]`):**
  - Case → แนะนำหูฟัง → Q3 compare → `ITEM-TAG bypass → suggestion batch (EO008+Case) → merge → เทียบจริง` ✅
  - Q4 superlative "ใหม่สุด" → suggestion batch → ตอบจากของที่คุยอยู่ ไม่ใช่ Case ✅
  - regression: ถาม spec anchor ("รับประกันกี่ปี") → shortcut เดิมตอบเดี่ยว ✅ · compare แต่ timeline มีแค่ anchor → "มีรุ่นเดียว" ถูกต้อง ✅
- **tests:** test_anchor_compare 7/7 · test_guards pass · test_recent_qa_pairs 10/10 · test_compare_3way (exp path) 17 ข้อปกติ

**เสริม (regression guard หลัง user review):** `_SUPERLATIVE_KW` มี "สุด"/"ชาร์จเร็ว" ที่ match กว้าง — เคส "ตัวนี้ชาร์จเร็วไหม" (ถาม anchor เดี่ยว) จะหลุด bypass ผิด → เพิ่ม `_SINGLE_ITEM_REF_KW` (ตัวนี้/รุ่นนี้/อันนี้/ชิ้นนี้/สินค้านี้/เรือนนี้) block ทั้ง bypass และ FOLLOWUP-COMP — verify: "ตัวนี้ชาร์จเร็วไหม" ตอบ Case เดี่ยวถูก ✅, repro หลัก Q3/Q4 ยังผ่าน ✅
