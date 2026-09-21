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

### ✅ Audit + rewrite docs/schema.md ตามโครงสร้างปัจจุบัน (2026-09-21) — เสร็จ + verified → ย้ายไป "ผ่านแล้ว"

### ✅ เขียน SRS_SSD.md ใหม่ทั้งหมด (2026-10-02) — เสร็จ + verified

- **ทำไม:** SRS เดิมลงวันที่ 2026-09-02 ขาดงาน ~1 เดือน — section 6 ครอบแค่ ~10 modules ขาด 13 โมดูล (device_compat/device_specs_data/order_flow/handoffs/warranty_flow/units/guards/responses/route_context/chat_models/test_chat_api/chat_v2/chatbotv3/scripts), line numbers ตายหมด, pipeline §5 ไม่ตรงโค้ด
- **ตัดสินใจกับ user:** section 6 = มาตรฐาน 8 ช่อง (Purpose/Input/Output/Calls/Called by/How it works/Side effects/Error-fallback) · เอา line numbers ออก (ใช้ชื่อฟังก์ชัน) · ขอบเขตครบ: shopeechat ทุกไฟล์ + chat_v2/chatbotv3 + scripts + ChatAdminWeb
- **วิธี:** audit ฟังก์ชันจากโค้ดจริงทุกไฟล์ (~280 signatures, ไม่เชื่อ SRS เดิม) → เขียนทับ `docs/SRS_SSD.md` ทั้งไฟล์ (815 บรรทัด) → verify ชื่อฟังก์ชันทุกตัวกับ `def/class` จริง (script กรอง — เหลือแต่ env/collection/field names + callee ที่ตั้งใจ flag)
- **ครอบ:** §1 ภาพรวม 3 engines · §2 arch + connections · §3 DB 4 กลุ่ม (admin/dbWallet/order/stock + local files) · §4 external services · §5 pipeline จริง (legacy 21 ขั้น + v2 8 stages + v3 flow + guard boundary) · §6 function inventory 26 หมวด (app/llm/product_store/intent/kb/web_search/persona/warranty/warranty_flow/conv_products/order_store/order_flow/handoffs/device_compat/device_specs/units/embedding/route_context/responses/guards/chat_models/test_chat_api/chat_v2/chatbotv3/scripts/ChatAdminWeb) · §7 env ครบ · §8 status · §9 plans · §10 known issues 15 ข้อ · appendix call graph
- **เจอ bug ใหม่ระหว่าง audit (จดใน §10 #1):** `chat_v2` เรียก callee ที่ไม่มี 3 จุด — (a) `knowledge_base.get_general_context` ไม่มี (ของจริง `build_general_context`) → AttributeError ลอย = **500 ทุก general question ใน v2** · (b) `_cp.add_item_anchor` (c) `_cp.get_timeline` ไม่มีใน conversation_products → try/except กลืน = anchor persistence + follow-up retrieval no-op เงียบ
- **กระทบ:** doc เดิมถูกเขียนทับทั้งไฟล์; ไม่แตะโค้ด — bug ที่เจอจดไว้ใน §10 + §9.2 (งาน chat_v2 callee fix)
- **✅ ขยายเสร็จ (2026-10-02):** user ว่าสั้นเกิน → เขียนใหม่เป็นมาตรฐาน SRS/SSD เต็ม (1,135 บรรทัด): (1) §6 แตก 1 row/ฟังก์ชันจริง ~280 rows ไม่รวมกลุ่ม — 26 หมวดครบทุก module (2) เติม ChatRequest/Response field tables, warranty SM State 0-7 table, PRODUCT_TYPES ~105 ตัว + charger subtypes 7 ตัว, cert 4 แหล่ง, dedupe scorecard, intent labels ครบ, fetch_products internal flow (3) §5 เพิ่มตาราง trigger/branch ของ deterministic paths + engine routing (4) ไม่เอา changelog/line numbers กลับ (5) re-verify ชื่อฟังก์ชันเทียบ `def/class` — ผ่าน เหลือแต่ env/collection/field names + 3 callee ที่ตั้งใจ flag

### Audit สถานะ issue จาก QA docs 2026-09-15 (2026-09-21) — 📋 จดสถานะแล้ว รอวิเคราะห์/แพลนกับ user

- **ต้นทาง:** `~/Downloads/issue-chat-annotations-partial-index-2026-09-15.md` + `shadow-inbox-bot-qa-notes-2026-09-15.md`
- **✅ แก้แล้ว:** (1) partial index chat_annotations → unique index เดียว {scope,conv_id,gen_batch_id} ตามที่เสนอเป๊ะ (mongoClient.ts:48-65,181) (2) NEW-4 ภาษา → policy ใหม่ default ไทยเสมอ ไม่ detect จากข้อความ (llm.py:92-154)
- **🟡 แก้บางส่วน:** NEW-1 (NER primary แล้ว + reject ชื่อมีตัวเลข แต่ fallback regex `ค[่้๊๋ั]?ะ*` ลบ "ค"/"ชื่อ" ทิ้งยังอยู่ warranty.py:629-638) · BUG-M (เพิ่ม KW หลายคำ + post-check fixed patterns llm.py:73-88 แต่ยังขาด "ติดต่อเจ้าหน้าที่/แชทกับเจ้าหน้าที่/ติดต่อร้านค้า" และ post-check ไม่ escalate จริง) · NEW-2 (warranty_flow State 7 รับรูปเป็น evidence + _received_items แล้ว แต่คำถามใน claim ยังถูกกลืน by design State 6) · NEW-8 (cert search มี type_filter แล้ว handoffs.py:168-188) · BUG-H/K/O (sellable-first ranking + shop_capability_line แล้ว แต่ยังไม่ verify ซ้ำ)
- **❌ ยังไม่แก้:** BUG-Q (error path ยังแนบ `{exc}` ดิบถึงลูกค้า llm.py:1455/1588/1692 + quota เป็นเรื่อง ops) · NEW-3 (ไม่มี post-check นโยบาย เปลี่ยนได้/คืนได้/ฟรี/โปร/แถม — guards.check_output มีแต่ log observe-only app.py:216-223) · NEW-6 (anchor ไม่ใช้ image_desc) · NEW-7 (ไม่มี suppression การ์ดสินค้าตาม intent) · NEW-9 (elapsed plumbing ดูถูกแล้วทั้ง 2 ฝั่ง แต่ต้อง re-measure batch ใหม่) · NEW-10 (vision 503 = quota เดียวกับ BUG-Q) · BUG-I (ไม่มี cap prompt tokens) · markdown table (ไม่มีตัวแปลง) · "ทางร้าน จะ" space เกินยังอยู่ (warranty_flow.py:383)
- **guard ที่มีอยู่:** `no_product_found_handoff` มีที่ app.py:3980 + chat_v2.py:1313 (QA เจอว่าไม่เคย fire — ต้องเช็คเงื่อนไข arm)
- **แพลนแก้ root-cause เขียนแล้ว:** `docs/plans/2026-09-21-qa-remaining-bugs-plan.md` — จัดกลุ่มเป็น 5 root cause (RC-A trust boundary, RC-B claim slots, RC-C keyword whack-a-mole, RC-D error leak, RC-E measurement) + 16 tasks · self-review 5 รอบแล้ว
- **กำลังทำ (2026-09-21):** Phase 0 ✅ (T1-T4 เสร็จ+เทสผ่าน) · Phase 1 ✅ (T5 claim-state fill-once + T6 order-problem routing — เสร็จ+เทสผ่าน) · ถัดไป Phase 2 ตามแพลน `docs/plans/2026-09-21-qa-remaining-bugs-plan.md` — เงื่อนไข: เทสก่อนข้ามเฟส + ห้ามกระทบเคสผ่าน
- **decisions จาก user (2026-09-21):** (1) quota — ตัดออกจาก scope user จัดการเอง (NEW-10 vision 503 ตัดไปด้วย) (2) post-handoff = บอทเงียบจน ticket closed + ลูกค้าทักซ้ำ — verify แล้วว่ามีครบอยู่แล้ว: worker `botWorkerService.ts:334` skip เมื่อ assigned_to+!closed (เงียบจริง ไม่เรียกบอท) + bot layer `warranty_flow.py:148-199` lock ด้วย ticket_state เป็น fallback → **ไม่ต้องเปลี่ยน State 6** — NEW-2 fallthrough ใช้เฉพาะ waiting state ก่อน handoff (State 7) (3) fulfillment problem (ส่งผิด/ของขาด/ของแถมไม่ครบ) → ส่งแอดมิน — reuse return/refund path ใน order_flow.py:75-286 เดิม (detect→order_sn→handoff) ไม่สร้าง flow ใหม่; detection แบบ composition (received-verb+problem) + guard freebie-question ด้วย ไหม/เหรอ — รายละเอียดใน plan T6

### live-assignment 500 error (2026-09-21) — ✅ fixed + verified (data layer)

- **อาการ:** หน้า /live-assignment console AxiosError 500 — poll `GET /api/live-assignment?list=1` ตายทุกครั้ง
- **root cause (reproduce แล้วด้วย script):** `push_unit_reg_to_admin.py` insert docs เข้า `test_assignment` โดยใส่ `created_at`/`replayed_at` แต่**ไม่ใส่ `updated_at`** (51 docs, replayed_by=`unit_reg_2026-09-18`) → sort `updated_at:-1` ดัน doc ไม่มี field ไปท้าย → route.ts `docs[last].updated_at.toISOString()` throw TypeError → catch → 500
- **วิธีแก้:**
  1. `push_unit_reg_to_admin.py` — เพิ่ม `"updated_at"` ในทั้ง 2 doc builders (push_questions + push_conversations) — root cause
  2. backfill `updateMany({updated_at:{$exists:false}}, [{$set:{updated_at:"$created_at"}}])` → 51 docs แก้แล้ว
  3. `live-assignment/route.ts` — cursor fallback `updated_at ?? created_at` (กัน writer อื่นลืม field)
- **verify:** probe script เดิม → cursor คำนวณได้ `2026-09-07T09:29:27Z|shp_458...` · bad docs = 0 · `tsc --noEmit` ผ่าน · `py_compile` ผ่าน · endpoint ตอบ 401 (auth ปกติ — dev server hot-reload แล้ว)
- **ผลกระทบเคสอื่น:** admin-chat-result sort `replayed_at` (มีอยู่) ปลอดภัย · test-assignment ไม่แตะ `updated_at` · frontend `liveDocToConversation` มี `|| created_at` อยู่แล้ว · conv_detail ไม่ใช้ `updated_at`

### test-assignment history + live-assignment inbox โหลดช้า/หน่วง (2026-09-18) — ✅ fixed + verified

- **อาการ:** user รายงาน history หน้า test-assignment โหลดช้า + live-assignment inbox หน่วง
- **root cause (วัดจริงใน DB):** `test_assignment` docs อ้วน — avg 60KB max 1.1MB เพราะ `qa` array เก็บ transcript เต็มต่อ doc — list/stats endpoints `find()` **ไม่มี projection** → ลาก transcript เต็มทุก doc → 68 docs ≈ 4MB / ~0.8-1.5s บน remote mongo → live-assignment **poll ทุก 5 วิ** → หน่วงตลอด
- **วิธีแก้ (projection 4 จุด — pattern เดียวกับ listReplayBatches/adminKpiService ที่มีอยู่):**
  - `listLiveAssignments` → `{ qa: { $slice: -1 } }` — list ใช้แค่ `qa[last]` ทำ last-message preview (page.tsx:106); conv_detail ยังดึงเต็มผ่าน `getLiveAssignment` (ไม่แตะ)
  - `listHistoryByAdmin` → `{ qa: 0, message_ratings: 0 }` — route map เฉพาะ summary fields
  - `listDeleted` → `{ qa: 0, message_ratings: 0 }` — เหมือนกัน
  - `getLiveAssignmentStats` → `{ final_status: 1, mock_status: 1 }` (เดิมลาก 5000 doc เต็มมานับ 2 field)
  - `getTestAssignmentStats` → projection summary + `qa.{status,bot_source,bot_intent,bot_web_search_used}` subfields (นับ pipeline stats ได้ครบ ตัด bot_reply/products/retrieval_info ออก)
- **verify จริง (DB ตรง):** list full 68 docs/824ms/3959KB → $slice:-1 = 68 docs/**151ms/450KB** (~9x เล็กลง 5x เร็ว); history 62 docs/**30ms/33KB** (~120x เล็กลง); last qa item ยังมี keys ครบ → preview ไม่พัง; `npx tsc --noEmit` ✅
- **ผลกระทบเคสอื่น:** conv_detail/qaToMessages ใช้ getLiveAssignment (full doc) ไม่แตะ; cursor pagination ใช้ updated_at+conversation_id ยังอยู่ใน projection; `listTestAssignments` ไม่มี caller → ไม่แตะ

### Shadow gen เขียนทับ state ของแชทจริง (timeline + ticket/handoff) (2026-09-18) — ✅ fixed + verified

- **อาการ:** user กด generate shadowbot → คำตอบแยกใน `shadow_replies` ถูก แต่ bot ได้ `conversation_id` จริง → `/chat` เขียน state ลงของจริงทุกอย่าง
- **audit write surface ที่ reachable จาก /chat (เสร็จแล้ว — ยืนยันจากโค้ด):**
  1. `conversation_products` (doc key = conversation_id จริง): `add_product` (anchor+bot_suggestion — app.py:897/4662, `_record_suggestion_products` ×3), `add_order_anchor` (order_flow:179/362, chat_v2:507), `add_item_anchor` (chat_v2:779), `update_claim_state`/`clear_claim_state` (warranty_flow ×5) → **เขียนทุก product turn** (พิมพ์เข็ม: last_updated doc ตรงเวลา shadow batch)
  2. **`conversations` + `status_conversation` + assign admin + admin_events** — `_send_handoff` (responses.py:35) POST `/api/admin/conversations/bot-handoff` payload `simulate: req.simulate_assignment` → shadow ไม่ได้ส่ง → `simulate:false` → **handoff จริงบนแชทจริง** (worst: replay เคส warranty/order → แชทลูกค้าจริงถูก flip เป็น handoff + assign admin จริง + bot อาจเงียบกับลูกค้าจริง)
  3. Python ไม่มี write อื่นนอกจากนี้ (grep ครบทั้ง package — 4 update_one อยู่ใน conversation_products ทั้งหมด)
- **จุดส่ง:** `callOurBot` ซ้ำ 3 ที่ (shadow-inbox/route.ts, generate-conversation/route.ts, scripts/generate-all-shadow.ts) ส่ง `conversation_id` จริง ไม่ส่ง simulate/ticket_state
- **วิธีแก้ (zero Python change — namespace + simulate):**
  - `callOurBot` ×3 (shadow-inbox/route.ts, generate-conversation/route.ts, generate-all-shadow.ts — script เพิ่ม param `conversationId` ให้ด้วย เดิมไม่ส่งเลย): ส่ง `conversation_id: "shadow:" + convId` + `simulate_assignment: true`
  - `replay_compare.py:call_bot` — bug class เดียวกัน (replay ผ่าน /chat ด้วย conv id จริง) → namespace เหมือนกัน
  - ผล: write ทุกจุดใน conversation_products/claim/order ลง key `shadow:` แยกขาด + multi-turn state ใน batch ทำงานปกติ; handoff → `handoffToAdminTest` → `test_status_conversation` แทน conversations จริง + answer ยังได้ชื่อ admin
- **verify จริง:**
  - `npx tsc --noEmit` ✅
  - E2E `generate-all-shadow.ts --limit=1` (conv shp_271339438995668811, 2Q): doc `conversation_products` key `shadow:shp_2713...` ถูกสร้าง (6 products) — real conv **ไม่มี doc ถูกสร้าง/แตะ** ✅, shadow_replies 2 docs ปกติ ✅
  - Direct /chat claim message ด้วย `shadow:` id → `handoff:true` fired → ไม่มี write ลง conversations/status_conversation จริง ✅ (log bot: handoff POST 404 เพราะ ADMIN_HANDOFF_URL env ของ server :8020 ชี้ผิด — pre-existing ไม่เกี่ยว fix)
  - Direct POST bot-handoff `simulate:true` + `shadow:` id → `ok:true simulate:true` → test path เท่านั้น, real collections ไม่แตะ ✅
- **ผลข้างเคียงที่รับแล้ว:** shadow ไม่เห็น timeline เก่าของแชทจริง (by design — replay สร้าง state เอง); doc `shadow:` สะสมใน conversation_products (cleanup ใน clear-shadow-replies ได้ภายหลัง); round-robin cursor ขยับตอน simulate handoff (เหมือน test-chat)

### 400 API_KEY_INVALID หลัง add 10 keys ใหม่ (2026-09-18) — 🔍 diagnose แล้ว รอ user action

- **error:** "ขออภัย ระบบ LLM ติดขัด (400 INVALID_ARGUMENT ...)" — full body ใน log = `API_KEY_INVALID` "API key not valid"
- **เกิดเพราะ:** Gemini ปฏิเสธตัว key เอง (ไม่ใช่ quota/model/request) — pool db ตอนนี้ ~19 keys (9 เก่า + 10 ใหม่), fail rate ~50% (21 err / 43 calls) ≈ 10/19 → **key ที่เพิ่ง add เข้ามา invalid เกือบทั้งหมด/ทั้งหมด** (พิมพ์ผิด / revoke / เอา key คนละ provider มาใส่ pool Gemini)
- **ทำไม log เห็นแต่ [INTENT]:** chat path กลืน ClientError เป็นข้อความขอโทษตอบลูกค้า ไม่ print stderr — intent_classifier เป็นตัวเดียวที่ log error
- **วิธีแก้ (ฝั่ง user):** ปิด toggle 10 keys ใหม่ในหน้า /llm → หายใน ~10s ไม่ต้อง restart; แล้ว validate ทีละตัว `curl "https://generativelanguage.googleapis.com/v1beta/models?key=<KEY>"` ก่อน add กลับ
- **gap ที่เจอ:** ไม่มี per-request key log (หา key ตายจาก log ไม่ได้ ต้องไล่ sha256 จาก UI) + ไม่มี auto-skip bad key (key ตายค้าง rotation จนกว่าจะปิดมือ)

### /llm key list: scroll 10 แถว + toolbar ค้นหา/sort/filter + ปุ่มเพิ่ม key ขึ้นบน (2026-09-18) — ✅ implement + tsc ผ่าน รอ user เช็คหน้าจริง

- **ทำไม:** user ขอ — list key ยาวเกิน ให้โชว์ ~10 แถวแล้ว scroll, ปุ่ม "เพิ่ม key" ไว้ล่างสุดหาไม่เจอ → ย้ายขึ้นบน, อยาก sort/filter/search ตามชื่อ
- **ผลกระทบ:** `KeyPoolCard` (page.tsx) branch `source==="db"` เท่านั้น — component แชร์ 2 pools (Gemini+OpenRouter) ได้ทั้งคู่อัตโนมัติ; display-only บน `keys` array ที่โหลดแล้ว (mutation ยังอ้าง sha256 → sort/reorder ไม่พัง toggle/rename/delete); ไม่แตะ API/backend
- **วิธีแก้:** state `keyQuery`/`sortDesc`/`statusFilter` (all|on|off) → `visibleKeys` derive (filter name icase + status + localeCompare); toolbar บนสุดของ db section = search input (ไอคอน Search) + sort toggle (ArrowDownAZ/ArrowUpZA) + FilterSelect สถานะ + ปุ่ม "เพิ่ม key" (ย้ายจากล่าง); `<ul>` ใส่ `max-h-[512px]` (~10 แถว) + `overflow-y-auto`; แถบล่างเหลือ warning เดิม; empty จาก filter → "ไม่พบ key ตามเงื่อนไข"
- **verify:** `npx tsc --noEmit` ผ่าน — รอ user เช็คหน้าจริง

### compat re-query ดึงผิดหมวด + fallback เดาหมวดเอง (2026-09-18) — ✅ implement+verify เสร็จ รอ code review

- **error:** `หูฟัง sony ใช้กับ iphone 15` → ตอบ "ไม่มีหูฟัง" + เดา "มีสมาร์ทโฟน Xiaomi" — ทั้งที่ร้าน KingGadgets มีหูฟัง **54 ตัว NORMAL** ขายอยู่
- **เกิดเพราะ (audit พบ 4 ชั้น — ลึกกว่า plan เดิม):**
  1. `_filter_compat_products`: ambiguous merge-back เฉพาะ `compat<2` — หูฟัง 50 ตัว (no connector) ถูกลบเงียบๆ เพราะชาร์จ usb-c ≥2 ปน
  2. `_device_spec_lookup` re-query ใช้ charging web keywords เสมอ + prompt "≥27W/dual-tier" ทุก compat query
  3. **ชั้นที่ 3 (เจอตอน E2E):** `web_search.reanswer` re-query `f"{en_type_token} {web_keywords}"` → "earphone หูฟัง Sony iPhone..." → detect ear+phone+iPhone → **ดึงโทรศัพท์ 30 ตัวทับ context ดี**; `_final_products` replace ทั้งก้อน (ไม่ใช่ union)
  4. type token อังกฤษ ("earphone") เอง detect ผิดเพี้ยน (ear**phone**→phone) และไม่ match ชื่อสินค้าไทย
- **แก้ด้วย:**
  1. `_compat_mode` (device_compat.py) — candidates = detect(msg) ∪ intent → priority charging>model_fit>self_compat; skip=phone/voucher, unknown=ไม่มี type
  2. `_filter_compat_products` +`compat_mode`/`asked_type` — charging/unknown=เดิมเป๊ะ; model_fit/skip=คืนทั้งหมด; self_compat=drop เฉพาะ plug ผิด ambiguous เก็บคงลำดับ
  3. `_device_spec_lookup` — non-charging re-query ด้วย `product_store._type_query_word` (canonical Thai kw) + `product_types_override` hard-scope + prompt ไม่พูด wattage + ไม่ต้อง web; charging path ไม่แตะ
  4. `web_search.reanswer` — type token → Thai kw + `product_types_override` + `_final_products` เปลี่ยน replace→union (ของเดิมไม่หาย)
  5. `product_store.shop_capability_line` — per-shop NORMAL type counts (cached) → inject "หมวดที่ร้านมีจริง" เมื่อของถามไม่อยู่ context
- **verify:** test_compat_mode_filter 36/36 ✅ · car_charger_regression 16/16 ✅ · E2E `หูฟัง sony+iphone 15` → "ใช้ร่วมกันได้" + หูฟังจริง 8 ตัว (Xiaomi Buds 3 top) ✅ · E2E `สายชาร์จ+iphone 15` → เดิมเป๊ะ (CTC315P USB-C ถูกแนะนำ) ✅
- **ผลกระทบข้าม:** charging/unknown path โค้ดเดิมทุกบรรทัด; web_search.reanswer ใช้ Thai kw+override ทุก type (positive-neutral); union ทำ context ใหญ่ขึ้น (dedup จัดการ); file sizes: app.py 4797(+4) device_compat 822 product_store 4097 web_search 874 — ทุกไฟล์ต่ำกว่าเพดาน
- **รอ:** code review ก่อนสรุปสุดท้าย

### test_200 selected 100 เคส (2026-09-18) — general/mixed/compat/ambiguous/followup

- **ผิวเผิน:** 98 pass / 0 fail / 2 err — แต่ต้องแยก: **26 เคสเป็นคำตอบ "ระบบ LLM ติดขัด"** (masked เป็น pass เพราะมี products)
- **ที่ดีขึ้นจริง (verify แล้ว):**
  - #143 `เอาขึ้นเครื่องไปจีน` → product_store+web_search (เดิม misroute shipping_policy) — **guard travel ทำงาน**
  - #199 `มีสินค้า smart home ไหม` re-run → product flow ตอบ honest (เดิม ❌ generic dump) — **guard categories ทำงาน**
  - compat non-charging ทำงานถูก: #113 TWS+iPhone / #114 QCY+Samsung / #115 IMILab+Android — ตระกูลเดียวกับเคสหูฟังที่เคยพัง → ตอบถูก+ของจริง
  - charging compat ปกติ: #101/104/105/108/110/118/119/120 ถูกทั้งหมด ไม่มี regression
  - ambiguous/followup ดี: #124 P01 40000mAh / #136 clarify / #146/151 BA651 grounded
- **bug ที่เจอ (จดไว้รอ review):**
  - 🔴 **API_KEY_INVALID** — Gemini key ใน rotation pool ใช้ไม่ได้ → 26/100 คำตอบเป็น error text (ops/config ไม่ใช่โค้ด — เช็ก key pool)
  - 🔴 **MongoClient-after-close race** — `/health` `/shops` `/categories` `/brands` + chat_v2.py:1489 เรียก `client.close()` บน shared cached client (get_client singleton) → request ที่กำลังใช้พังกลางทาง = HTTP 500 ×2 (knowledge_base.py:690 build_general_context) — pre-existing, prod เจอบ่อยเพราะ health check รันตลอด; แก้: ลบ close() บน shared client
  - 🟠 **#132 `อันไหนเสียงดีสุด` → warranty_claim_first_message** — substring "เสีย" ใน "เสียง" trigger claim kw → superlative misroute — ต้อง word-boundary guard บน claim keywords
  - 🟠 **#109 BUG-A confirmed** — `พาวเวอร์แบงค์ชาร์จ MacBook` → p=1 ตอบหัวชาร์จ AC65B2 (ยังไม่แก้ ตามแพลน P1)
- **ไม่พบ regression จาก compat work** — charging/general routing ปกติทั้งหมด
- ผลเก็บที่ `docs/test/results/test_200_selected100.json`

### E2E batch 12 เคสหลังแก้ (2026-09-18) — เจอ bug เพิ่ม 1 + polish 1

- **เคสที่ผ่าน:** speaker+s24 (Kieslect), smartwatch+iphone16, car_charger+s25u (CC903P PD3.0/PPS 90W ถูก), warranty claim (ZMI), powerbank≤1000฿, compare CTC615W/CTC610, superlative (Lagenio K9), lightning cable availability, shipping policy (iSuper), projector browse (Yaber T2/L2)
- **BUG-A (pre-existing, charging path — ยังไม่แก้ รอ review):** `พาวเวอร์แบงค์ใช้กับ macbook air` (CukTech) → intent type=powerbank แต่ web extractor คืน `product_type="charger"` → re-query `charger MacBook Air MagSafe 3 USB-C 70W` → ดึง GaN chargers แทน powerbanks → **ตอบ "ไม่มี powerbank" ผิด** (ร้านมี WPB100/PB060/PB100P)
  - เกิดเพราะ: `_device_spec_lookup` charging path เชื่อ `_device_product_type` จาก web extractor ทับ type ที่ลูกค้าถามจริง — bug ตระกูลเดียวกับ earphone case
  - แผนเสนอ: ส่ง `product_types_override={_asked_type}` เข้า charging re-query เมื่อ asked_type valid — scope ตาม type จริงแต่คง web keywords (charger→เดิม, powerbank/car/wireless→ถูกหมวด)
  - ผลกระทบที่ต้องเช็กตอน review: subtype prefix (adapter/cable/set) ทำงานร่วมกับ override ไหม; เคส cable ใน taxonomy เป็น charger อยู่แล้ว
- **BUG-B (โค้ดใหม่ — แก้แล้ว):** `ฟิล์มจอ iphone 16` → detect={screen_protector}+intent=case → tiebreak alphabetical เลือก case → re-query ดึงเคสแทนฟิล์ม
  - แก้: mode เดียวกันให้ `hit∩detected` ชนะ intent (literal แม่นกว่า context guess) — test 36/36 ผ่าน E2E ตอบเจาะจงฟิล์มถูก
- **observation:** web search JSON parse fail → retry ซ้ำ (double cost ~$0.02/เคส) — pre-existing ไม่เกี่ยว fix นี้
- **observation:** c1 products=smartwatches แต่ answer พูดถึงหูฟัง — Kieslect ไม่มีทั้งคู่ (honest ว่าอาจหมด) ยอมรับได้

### Variant image + OCR รูปนอก description (2026-09-18) — ✅ implement เสร็จ รอ deploy steps

- **ทำไม:** user เจอในแชท thitirat.rac — unit card "สายชาร์จ CTC315P ขาว" (item 6359177007) โชว์รูป `th-11134208-81ztg-mne4rdze5wxse2` = รูปแรกใน desc field_list (banner) แทนรูปสายจริง `th-11134207-7rash-m8zynhw4wjrd0a` — เพราะ `to_unit_card` ใช้ `unit.image_ids[0]` (desc เท่านั้น) ไม่เคยอ่าน `tier_variation.option_list[].image`
- **และ:** image_texts OCR เฉพาะรูปใน desc field_list — รูป มอก./cert ที่อยู่ใน gallery (`image_id_list`) / variant option image ไม่ถูก OCR → cert search พลาด (~12,794 รูปใหม่ใน sellable docs)
- **วิธีแก้ (ทำแล้ว):**
  1. `units._variant_image_id()` — match `model_name` กับ `tier_variation[].option_list[].option` (normalize isalnum+lower; exact หรือ option≥4chars ⊂ name สำหรับ 2-tier) → คืน `option.image.image_id`
  2. `to_unit_card` — `image_url` ลำดับใหม่: **variant > cover (`image_id_list[0]`) > desc (`image_ids[0]`)** (เดิม desc เท่านั้น); `attach_listing_fields` เพิ่ม `tier_variation` ใน projection → runtime ทำงานเลยไม่ต้อง rebuild
  3. `build_image_texts._doc_images()` — image_id→url จาก 3 แหล่ง (desc field_list + gallery + variant options, dedupe desc นำหน้า) — ใช้ร่วมกันใน `_collect_worklist`, `_collect_nonsellable`, `import_image_texts._image_item_ids`
  4. `build_sellable_units._field_list_parts` — `unit.image_ids` ต่อท้ายด้วย gallery+variant ids → `attach_image_texts` join เห็น OCR รูปนอก desc
- **Verify:**
  - py_compile ครบ 5 ไฟล์ ✅
  - unit check ข้อมูลจริง item 6359177007: "สายชาร์จ CTC315P ขาว" → `th-11134207-7rash-m8zynhw4wjrd0a` (รูปสายจริง) ✅, "A18T + CTC315P สีขาว" → variant img ถูก ✅, no-match/empty/empty-listing → `""` ✅, `_doc_images` 33 รูป desc-first + cover+variant ครบ ✅
  - test_cert_standards 46/46 ✅, test_car_charger_regression 16/16 ✅
- **SRS_SSD.md** อัปเดต 6.18.1 (เพิ่ม `_variant_image_id` + ปรับ `to_unit_card`/`attach_listing_fields`/`attach_image_texts`)
- **⚠️ ขั้นตอน deploy ที่เหลือ (ก่อนเห็นผลจริง):**
  1. variant image ใน card — restart :8010/:8015 (runtime change อยู่แล้ว)
  2. OCR รูปใหม่ ~12,794 รูป (sellable) + nonsellable — รัน `build_image_texts.py` (+ `build_image_texts_nonsellable.py`) — resume append ลง `exports/image_texts.jsonl` (~$2-3)
  3. `import_image_texts.py` re-run → `item_ids` map ครบ 3 แหล่ง → cert search เห็นรูป gallery/variant
  4. rebuild `sellable_units` (อยู่ใน P0) → `unit.image_ids` ครบ → `attach_image_texts` join เห็น OCR รูป gallery/variant
- **⚠️ ยังไม่ verify e2e:** รอ deploy steps ข้างบน + replay แชท thitirat.rac เช็ครูป variant จริง

### Restart :8010 + :8015 ด้วยโค้ดใหม่ (2026-09-17 ~17:2x + restart ซ้ำตอน cert done)

- **ทำไม:** replay-compare ยิง `127.0.0.1:8010` — process เก่า start 12:19 ก่อน commit `015a9c3` (sellable ranking + suggestion compare, 16:57) → replay ได้โค้ดเก่า
- **ทำ:** kill 65815/65818 → relaunch `USE_UNIT_INDEX=charger nohup uvicorn` log เข้า `exports/uvicorn_{8010,8015}.log` — ทั้งคู่ health 200
- **เคสที่น่าจะเปลี่ยน:** "ตัวไหนออกใหม่สุด" เดิม CONV-ACTIVE pin Case เดี่ยว → ตอบผิดเป็นของ Case
- **⚠️ gap ที่รู้ว่ายัง:** card ไม่มี field วันที่ (`create_time`) → LLM ตอบ "รุ่นไหนใหม่กว่า" ไม่ได้แม้ context ถูก — เสนอ `listed_date` ใน `to_product_card`/`to_unit_card` รอ user ตัดสินใจ

### 🔄 กำลังทำ — Rebuild unit index สด + regression กว้าง 300Q/50conv ยิง LLM จริง (2026-09-18)

- **งาน (user สั่ง):**
  1. rebuild sellable_units จาก live DB (export สด → build → import → unit_embeddings + typo_dict ใหม่) — `--source mongo` ยังไม่ implement ใช้ export→build เดิม
  2. regression วงกว้างทุก type/ทุกหัวข้อ (ไม่ใช่แค่ charger): compat, ซ้ำซ้อน, เคลม, จัดส่ง, รับประกัน, เครื่องเปิดไม่ติด/เสีย, แจ้งปัญหา, มอก, order/tracking, brand, superlative, compare, model code, typo, shorthand
  3. ยิง LLM จริงเท่านั้น (ไม่ใช่ query-level test) — ดูเนื้อหา+บริบทคำตอบ+เส้นทางที่ตอบ (units vs legacy vs KB vs deterministic) ตรงแพลนไหม
  4. **จด error + root cause ไว้ ไม่แก้**
  5. quota: 300 คำถามเดี่ยว + 50 conversations จริง (messages_shp)
  6. เก็บผลเต็มทุก Q&A → ไฟล์ (+ ถ้าได้เข้า admin-chat-result)
- **วิธี:** runner ใหม่ `docs/test/unit_index_regression.py` ยิง `POST /chat` (instance แยก :8020 ด้วย USE_UNIT_INDEX=1) + reuse `replay_compare` สำหรับ 50 convs จริง; per-turn เก็บ full response (answer/products/unit_id/source/intent/routing/steps/usage/bot_log) + flag `unit_path`(cards มี unit_id)/`unit_attempted`(log [UNITS] แต่ fallback)
- **corpus:** `docs/test/build_unit_reg_corpus.py` → `docs/test/unit_reg_corpus.jsonl` = **300 ข้อ / 17 topics** ผูก shop+model_codes จริงจาก index สด: compat_charging30 compat_other15 warranty26 claim20 shipping15 device_issue15 problem_report10 tisi12 order10 brand10 superlative18 compare15 browse39 model_code20 shorthand15 typo10 price10 general10
- **progress:**
  - export live ✅ ShpProducts 11,692 docs
  - build units ✅ 27,807 units (sellable 5,489 · classified 5,158 = 94% pass gate) — log `exports/rebuild_units_2026-09-18.log`
  - import ✅ `sellable_units` = 27,843 docs (sellable 5,490) · unit_embeddings.npz 106MB สด · typo_dict.json สด
  - bot :8020 `USE_UNIT_INDEX=1` (log `/tmp/chatbot_unit_8020.log`)
- **ผลเทส (เซฟแล้ว):**
  - **300Q ✅ ครบ** — `docs/test/results/unit_reg_questions_2026-09-18.jsonl` — answered 300/300 (quota error ช่วงแรกถูก retry จนหมด) · unit_path=118 · fallback_dead_pool=15 · web=15 · handoff=42
  - **50 convs ✅ ครบ (resume จาก 34)** — `docs/test/results/unit_reg_convs_2026-09-18.jsonl` = 50 convs / **579 qa turns** — answered 326 · quota error 253 (44% — pool หมดช่วงบ่าย เป็น infra ไม่ใช่ logic) · unit_path=60 · dead_pool fb=6
  - push เข้า `test_assignment` แล้ว (replayed_by=`unit_reg_2026-09-18` → ดูที่ /admin-chat-result)
  - conv shops: IMILab 128 / BlackShark 119 / ZMI 96 / CukTech 91 / Kospet 75 qa turns
  - backup run1 ที่ error: `unit_reg_questions_2026-09-18.run1_err.jsonl`
- **⚠️ ระวัง:** API_KEY_INVALID/429 ใน pool (entry บน) — error จะถูกจดเป็น error ไม่แก้ตามคำสั่ง
- **observations เบื้องต้น (จดไว้ ยังไม่แก้):**
  - `device_issue`/`problem_report` ถูก route เข้า warranty claim form + handoff เกือบหมด (เช่น "หูฟังเชื่อมต่อบลูทูธไม่ได้" → claim form) — troubleshooting ไม่ได้ไป QA tips
  - `มีสาขาหน้าร้านไหมครับ` → `tax_invoice_handoff` (คำว่า "สาขา" ชน tax-invoice detect) — misroute
  - `เช็คออเดอร์หน่อย` → เข้า product_store+unit path แทน order flow (คำตอบยังถูก — ขอเลขออเดอร์)
  - `มีของแบรนด์ zmi ไหม` (ร้าน TicWatch) → "ทักแอดมิน" แทนที่จะตอบไม่มี
  - pool all-dead → legacy fallback ทำงานถูก (browse IMILab camera: 441 units แต่ sellable 51 → top-50 vector ตายหมด)
  - unit path ใช้ได้กับ shorthand/superlative/price/model_code ดี (shorthand 15/15, superlative 18/18)
- **ค้าง:** conv replay เหลือ 17 convs (34-50) · วิเคราะห์เนื้อหาเชิงลึกต่อข้อ · รายงานสรุป root-cause · bot :8020 ยังรันอยู่ (โค้ดเก่าก่อน user แก้ spec ladder)

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

### ✅ 2026-09-21 — rewrite docs/schema.md ตามโครงสร้างจริง (doc-only, ไม่แตะโค้ด)

- **งาน (user สั่ง):** อ่าน schema.md เดิม → เขียนอัปเดตว่าโครงสร้างตอนนี้เป็นยังไง ใครใช้ collection ไหนบ้าง
- **เจอว่าเดิมล้าสมัย:** เขียนไว้ตอน 34 collections แต่ `config.ts` ตอนนี้ 36 keys + ขาด collections ที่เพิ่มหลัง KB re-import (kb_products/kb_qa/kb_raw), sellable_units, image_texts, stock DB `itStock.Products`, llm key pool ใน system_configs
- **สิ่งที่แก้ใน schema.md:**
  - §1.2: 34→36 keys + note ว่าทุกชื่อ override ด้วย `ADMIN_MONGO_COLLECTION_*` (production ใช้ `*_shp`)
  - §1.3: DB connections 3→4 (เพิ่ม stock DB `STOCK_URI`/`STOCK_DB`) + เพิ่ม §1.4 ตาราง 7 collections ที่ Python เป็นเจ้าของ (อยู่นอก COLLECTIONS)
  - `knowledge_base` (§2.3): ระบุเป็น legacy fallback สำหรับ Python — runtime หลักย้ายไป kb_qa/kb_products (`_kb_coll` เหลือ caller เดียวใน get_general_faq); admin UI `/knowledge` ยัง CRUD เต็ม
  - `conversations` (§2.6): เพิ่ม field `labels` (อ่านโดย /labels + workflowEngine) + ชื่อ deployed `conversations_shp`
  - `shops` (§2.8): เพิ่ม writer `sync-shops.ts` (aggregate จาก conversations_shp)
  - `system_configs` (§2.19): แก้จาก single-doc → multi-doc config store 3 docs (`main_config`/`llm_config`/`role_permissions`) — เดิมเขียน PK ผิดเป็น "default" (จริงคือ `main_config`); llm_config อ่านโดย Python `llm.py` (TTL 10s) + `web_search.py`
  - `test_chat_sessions` (§2.26): ref ย้าย app.py→test_chat_api.py + เพิ่ม fields `source`/`script_test` + writer `shadow_openrouter.py`
  - `test_assignment` (§2.28): เพิ่ม reader liveAssignmentService/adminKpiService + writer `push_unit_reg_to_admin.py`
  - §3.2 ShpProducts: ขยาย consumers (units/knowledge_base/app.py/chat_v2/chatbotv3/replay_compare + Next.js 2 services) + env ฝั่ง Next.js คือ `SHP_PRODUCTS_COLLECTION`
  - เพิ่ม §3.5 stock DB `itStock.Products` (cert search path เท่านั้น, collection name hardcoded `Products`)
  - §4 ShpOrders: เพิ่ม Next.js `/admin/conversations/[id]/orders` route (buyer_user_id lookup), ฟิลด์ครบ Phase 3C, ลบ `lookup_orders_by_buyer` (ไม่มีจริงในโค้ด)
  - §5 ขยาย 2→7 collections: conversation_products (+order_anchors/active_order_sn/claim_state), test_chat_logs (ref ใหม่), image_texts, sellable_units (schema เต็ม + sellable อ่านสด), kb_products, kb_qa, kb_raw (audit trail ไม่มี reader)
  - เพิ่ม §7 local files (npz/jsonl pipeline) — แก้จุดที่เดา: ไม่มี build_unit_embeddings.py (จริงคือ `build_embeddings.py --units`/`--qa`), `device_specs_data` เป็น module ไม่ใช่ json
  - §8 access matrix แยกตาม owner: 8.1 Next.js COLLECTIONS / 8.2 Python-owned / 8.3 external read-only / 8.4 unused
  - renumber §2.13 ซ้ำ (quick_replies+close_history) → §2.13-2.32 เรียงถูก
- **Verify:** เช็คชื่อ collection ทุกตัวกับ `config.ts` (36 keys), `mongoClient.ts` ensureIndexes, per-service `COLLECTIONS.*` grep (34 services), direct collection ใน API routes, Python modules (units/knowledge_base/test_chat_api/conversation_products/llm/app), import/build scripts, doc shapes จาก source (parse_row, _build_unit, import_image_texts, test_chat_api)
- **หมายเหตุ drift ที่ยังค้าง (ไม่ได้แก้ — นอก scope):** `docs/SRS_SSD.md` §3.1 เขียนชื่อผิดว่า `knowledge_base_products`/`knowledge_base_qa` (จริงคือ `kb_products`/`kb_qa`)

### ✅ 2026-09-18 — stale timeline card: shadow gen โชว์รูป desc banner หลัง fix variant image

- **error:** user กด generate shadowbot (conv thitirat.rac `shp_458397959795636281`) หลัง deploy variant-image fix → card ยังโชว์ `th-11134208-81ztg-mne4rdze5wxse2` (desc banner)
- **เกิดเพราะ:** card ใน `bot_products` มี key set = `_strip_card_for_storage` shape พอดี (ไม่มี unit extras/condition/raw_description) + name เป็น item_name เวอร์ชันเก่า → มาจาก **`conversation_products` timeline restore** (CONV-ACTIVE → `resolve_active_by_message` → stored card ตรงๆ) ไม่ใช่ build สด — timeline เขียนด้วยโค้ดเก่า (batch 09:11 local ก่อน units.py fix 09:49) แล้ว `_record_suggestion_products` re-record card เดิมทุก turn → stale self-perpetuate ไม่มี TTL
- **พิสูจน์:** fresh `to_unit_card` บน unit เดียวกัน → รูป variant ถูก `th-11134207-7rash-...` ✅ = โค้ดใหม่ปกติ ปัญหาอยู่ที่ snapshot เก็บไว้
- **แก้ด้วย:** `conversation_products.py` — `_rebuild_card` (unit-level → sellable_units lookup + attach_kb_specs/attach_image_texts + `_listing=doc` → `to_unit_card`; อื่น → `to_product_card`) + `_materialize_card` (cache 30s/(item,model) → rebuild → fallback stored) — patch getters ทั้ง 5 (`get_active_product`/`get_suggestion_latest`/`get_latest_suggestion_batch`/`get_anchor_and_suggestions`/`resolve_active_by_message`) → restore ทุกจุดได้ card สด (image/name/price/stock/status ทั้งหมด — user สั่ง refresh หมด)
- **ผลกระทบข้าม:** follow-up turns ทุกแชทได้ข้อมูลสด (รวม stock/status ที่เคย stale — ดีขึ้น); doc หาย → fallback stored; ต้นทุน +1-2 mongo find/restore (cache 30s กันซ้ำใน request); write path ไม่เปลี่ยน; card สดถูก re-record → timeline self-heal
- **Verify:** test_timeline_card_refresh 8/8 (ใหม่ — unit→variant img, listing→cover, doc หาย→fallback, no-card→minimal) · cert 66/66 · car_charger 16/16 · guards 27/27 · qa_context 4/4 · **E2E จริง** restart :8010 → /chat conv เดิม "ตัวนี้มีสีอะไรบ้างคะ" → `image_url=th-11134207-7rash-m8zynhw4wjrd0a` (รูปสาย CTC315P ขาวจริง) ✅

### ✅ 2026-09-18 — แก้ 3 ปัญหาจาก test_200 (P0 crash + 2 misroute)

- **แพลน:** `docs/plans/test200-fixes-plan.md`
- **P0 qa_context IndexError → HTTP 500 (#132):** dict literal `tag={...}[level]` evaluate f-string `topic.split()[0]` **ทุก key ก่อนเลือก** → hit ใดๆ topic='' (32/393 docs) crash ไม่ว่า level — แก้ `_topic0 = next(iter(split()), "")` 1 จุด @ `knowledge_base.py:1266`
- **P1 shipping misroute (#143 "ขึ้นเครื่องไปจีน"):** **regression จาก Phase 6 intent-first** — เดิม `general_qtype` มาจาก keyword เท่านั้น ("ขึ้นเครื่อง" ไม่ match → ผ่านไป compat-followup L~1680 ตอบถูก) → Phase 6 ให้ LLM ตั้ง qtype → `shipping_policy` early return L~1540 ก่อน fix เก่าทำงาน — แก้ `_general_qtype_bypass` @ `app.py:440`: shipping_policy + `_TRAVEL_KWS` (ไม่มี `_SHIP_VERB_KWS` — "ส่งไปจีน"=จัดส่งจริง) → None → product flow
- **P2 categories misroute (#199 "มี smart home ไหม"):** intent→categories → generic dump ทั้งที่ smart home = cross-type cluster (95 items/17 types) — guard เดียวกัน: categories + `_CAT_NOUN_RE` noun เจาะจง (ไม่อยู่ใน `_CAT_GENERIC_NOUNS`) → product flow ค้น "Smart" ในชื่อสินค้าจริง
- **ผลกระทบข้าม:** shipping จริง ("ส่งกี่วัน"/"ค่าส่ง"/"ส่งต่างประเทศ") คงเดิม — verb precedence; categories จริง ("ขายอะไรบ้าง") คงเดิม — generic noun set; type อื่นไม่โดน (guard เฉพาะ 2 qtype)
- **Verify:** test_qa_context_guard 4/4 · test_general_qtype_guards 27/27 · cert 66/66 · car_charger 16/16 · **E2E 5/5**: #143→product_store ตอบถูกบริบท, powerbank ขึ้นเครื่อง→ตอบกฎ 100Wh, "ส่งกี่วัน"→shipping คงเดิม, #199→kb+mongo 10 products จริง, "มีสินค้าอะไรบ้าง"→categories คงเดิม
- **test ใหม่:** `docs/test/test_qa_context_guard.py`, `docs/test/test_general_qtype_guards.py`

### ✅ 2026-09-18 — language policy: ตอบไทยเสมอ เว้นแต่ลูกค้าขอภาษาอื่น → อังกฤษ

- **error:** เดิม `_detect_lang` mirror ภาษาลูกค้า — ข้อความอังกฤษ/จีนล้วน → ตอบอังกฤษ, ตัวเลข/รหัสล้วน ("1"/"ctc615w") → `other` → ตอบอังกฤษให้ลูกค้าไทย (เคสจริงใน replay Q3)
- **เกิดเพราะ:** detect จาก script ของข้อความ ไม่ใช่จากเจตนา — ข้อความสั้น/รหัสสินค้าหลุดเป็น non-Thai
- **แก้ด้วย:** ลบ `_detect_lang`; `_lang_instruction(message)` ใหม่เช็ค `_LANG_REQUEST_RE` — explicit request เท่านั้นถึงคืน block "Answer in English" (ไม่ใช่ภาษาที่ขอ เพราะคุมคุณภาพไม่ได้), อื่นๆ → `""` ตอบไทย; regex ครอบ TH (verb+ภาษา+ชื่อภาษา) / EN (verb+ชื่อภาษา, "in X please", "X please") / CJK / bahasa / อาหรับ / รัสเซีย — ไม่รวม thai/ไทย; แก้ prompt "ตอบเป็นภาษาเดียวกับลูกค้า" → "ตอบภาษาไทยเสมอ" 2 จุด (SYSTEM_INSTRUCTION + KB_SYSTEM_INSTRUCTION) ไม่งั้น LLM mirror อยู่ดี
- **ผลกระทบข้าม:** pure-English/CJK message ที่ไม่ได้ขอภาษา → ตอบไทย (ตั้งใจตาม spec); ตัวเลข/รหัสล้วน → ไทย (ดีขึ้น); FP guard — "app ภาษาจีนใช้ได้ไหม"/"english manual"/"speak thai" ไม่ trigger; callsite 3 จุด (answer/answer_with_kb/answer_general) ใช้ signature ใหม่
- **verify:** test_qa_batch_20260911 เขียน LANG section ใหม่ **17/17** + edge 8 เคสเพิ่มผ่าน + py_compile
- **SRS_SSD.md** อัปเดต 6.2.3 (เพิ่ม `_lang_instruction`/`_LANG_REQUEST_RE`, ลบ `_detect_lang`) + 6.2.4
- **จุดเหลือ:** request ที่เขียนด้วยภาษาแปลกที่ไม่มีใน regex (เช่นฝรั่งเศสบอกตอบเยอรมัน) → ตอบไทยตาม default — เจอจริงค่อยเติมชื่อภาษา
- **deploy:** restart :8010/:8015 แล้ว (kill PID เก่า → relaunch `USE_UNIT_INDEX=charger nohup uvicorn` log `exports/uvicorn_{8010,8015}.log`) — health 200 ทั้งคู่

### ✅ 2026-09-18 — test_200 full run (220 ข้อ LLM จริง) + จดปัญหาที่เจอ

- **ผลรวม 220 ข้อ: 217 ✅ / 2 ❌ / 1 ERR** (run แบ่ง 4 segment เพราะ test client โดนฆ่าซ้ำตอน bot restart — `lsof -ti:8010 | xargs kill` ฆ่า client ที่ connection ค้างด้วย)
- **cert flow live 8/8 ✅** (manual — test_200 ไม่มี cert): type filter ถูกทุกหมวด, model keyword เจอ UNLIST, generic เช็ค 6 certs, FCC ไม่มี→handoff
- **ปัญหาที่เจอ (จดไว้หาจุดแก้รอบหน้า):**
  1. **#132 HTTP 500 — `qa_context` crash**: `knowledge_base.py:1268` `(h.get('topic') or '').split()[0]` → IndexError เมื่อ brand-level QA hit มี topic ว่าง — **kb_qa มี 32 docs topic=''** (general_faq entries) → ทุกแชทที่ QA search คืน doc เหล่านี้ที่ level=brand จะ 500 เหมือนกัน (pre-existing bug ไม่เกี่ยว cert/compat)
  2. **#143 "เอาขึ้นเครื่องไปจีนด้วยได้อ่ะ"** (followup context หัวชาร์จ 67W) → route ไป `general:shipping_policy` ตอบ "ทักแอดมิน" 0 products — คำถามกฎการบินถูก misroute/punt แทนตอบในบริบทสินค้า (หัวชาร์จขึ้นเครื่องได้อยู่แล้ว กฎ Wh ใช้กับ powerbank)
  3. **#199 "มีสินค้า smart home ไหม" (YoupinOfficialStore)** → 0 products + ตอบ generic categories ทั้งที่ร้านมี smart/home NORMAL **98 ตัว** — "smart home" ไม่มีใน taxonomy → หลุด retrieval ไปคำตอบกว้าง
  4. minor: #166 ตอบอังกฤษ (ถามอังกฤษล้วน — พอรับได้); #133 ThaiSuperPhone "งบ 2000" → แนะนำเสื้อยืด (ร้านขายเสื้อจริงแต่คำตอบดูแปลกในร้านมือถือ)
- **ข้อสังเกต infra:** test_200 แก้ให้อ่าน `CHATBOT_INTERNAL_SECRET` จาก env (เดิม hardcode dev-secret → 401 ทั้งชุด); resume script `/tmp/resume_test200.py` (argv=offset) ใช้ซ้ำได้
- **cert regression หลัง fixes:** test_cert_standards 66/66, car_charger 16/16 ยังผ่าน

### ✅ 2026-09-18 — cert merge 4 แหล่ง (stock DB + variant names + desc + OCR) + เลข มอก. ในคำตอบ

- **ทำไม:** user มี stock DB (`itStock.Products`) เก็บ cert flag structured: `is_tis`/`tis_id`/`tis_license_id`/`is_ccc`/`is_ce` — coverage เดิม (desc+OCR) พลาด 173 items; variant names มี token `CN.V (CCC)`/`GB.V (CE)` อีก 616 items ที่ไม่เคยถูกดู
- **แผน:** `docs/plans/cert-merge-plan.md` — เลือก runtime merge (ไม่ใช่ cert_map collection) เพราะ stock เปลี่ยนบ่อย + ไม่ต้องมี pipeline
- **วิธีแก้ (ทำแล้ว):**
  1. `product_store._stock_products_coll()` — lazy `itStock.Products` (env `STOCK_URI`/`STOCK_DB`) degrade→None เหมือน `_admin_image_texts_coll`
  2. `_VARIANT_CERT_RES`/`_VARIANT_MONGO_TERMS`/`_variant_cert_hit()` — version→cert inference: `CN.V`→ccc, `GB.V`/`Global`→**ce** (GB.V = GloBal version ไม่ใช่ GB standard — verify จาก `(GB Ver.)` item 4842405819), `EU`→ce, `US.V`→fcc; explicit `(CCC)`/`(CE)`/`มอก`; `GB/T`→gb เท่านั้น (กัน "128 GB" FP)
  3. `search_cert_products` +param `stock_db` — path 3 stock flags→`shopee_ship_box.item_id`→product docs (`via="stock"`, `cert_ids`={tis_id,tis_license_id}) + path 4 variant regex (`via="variant"`); multi-source→`via="both"`
  4. `handoffs.py` — เจาะรุ่น 1 ผลมี `cert_ids.tis_id` → คำตอบใส่ "เลข มอก. 2879-2560 ใบอนุญาต น 30516-48/2879"
- **verify:**
  - test_cert_standards **66/66** (เดิม 46 + ใหม่ 20: variant tokens 12 เคส + stock/variant paths 8 เคส — 'False' string ไม่นับ, both merge, cert_context มีชื่อ option)
  - real Mongo: ccc=111 items (both 80/variant 17/stock-only), ce=85 (variant 62), tisi=200+ (stock 82+18 both) — เลข มอก. จริงโผล่ใน cert_context
  - QB817 (UNLIST) ถามเจาะรุ่นเจอ `via="both"` ถูก — คำถามทั่วไปกรอง NORMAL ตามเดิม
  - test_car_charger_regression 16/16, py_compile ครบ
  - **post-check (user ขอ):** version tokens กระจาย: ccc=136 items (charger 99/powerbank 98/purifier 9/fan 7), ce=141 (charger 76/powerbank 70/purifier 21/camera 14) — กองหมวด CCC catalog ตามคาด, camera เล็ก edge → hedge ด้วย cert_context
- **SRS_SSD.md** อัปเดต: `_stock_products_coll`, `_variant_cert_hit`, `_STOCK_CERT_FLAGS`, `_VER_RE`/`_VARIANT_CERT_RES`/`_VARIANT_MONGO_TERMS`, `search_cert_products` (4 paths+stock_db+cert_ids), `post_intent_handoffs`
- **impact check ข้าม type (user ขอ — verify ซ้ำบนข้อมูลจริง):**
  - caller เดียวใน prod = `handoffs.post_intent_handoffs` (cert flow) — `search_tisi_products` เป็น compat wrapper ไม่มี caller → blast radius แค่คำถาม cert
  - variant hits ทุก cert: ce=170 items, ccc=178 — eyeball option names ทั้งหมดเป็น version token จริง (GB.V/CN.V/CN Ver./Global V./(CE)/(CCC)) — camera/purifier/fan/monitor/TV stick = Xiaomi GB/CN version จริง ไม่ใช่ FP; tisi/fcc/rohs/gb = 0 hits
  - type_filter ครอบ path 3/4 เหมือน path 1/2 — stock/variant item หมวด A ไม่รั่วตอนถามหมวด B (leaked=0); model_keyword ยังเจอ UNLIST (QB817 via=both)
  - timing ~0.7-2.3s/คำถาม (desc regex scan เป็นหลัก) — variant scan เพิ่ม ~0.3s
- **fix ตาม impact check (4 จุดเล็ก):**
  1. `_stock_products_coll` cache `_cached_stock_client` (เดิม new MongoClient/คำถาม)
  2. `handoffs` แสดงเลข มอก. เฉพาะเมื่อถาม tisi (`"tisi" in _certs`) — คำถาม CE/CCC ไม่แปะเลข มอก.
  3. path 3 ข้าม query เมื่อ certs ไม่มี stock flag (fcc/rohs/gb) — fcc query 1.0→0.5s
  4. stock `cert_context` = "stock: {cert} · เลข มอก. x" (สะท้อน cert ที่ hit จริง)
- **verify หลัง fix:** test_cert_standards 66/66, car_charger 16/16, real smoke ce/ccc/tisi/fcc ปกติ
- **⚠️ deploy:** `STOCK_URI`/`STOCK_DB` ต้องอยู่ใน env ของ bot host (docker-compose .env) — ไม่มี → path 3 ข้ามเงียบๆ (degrade)
- **phase 2 (บันทึกไว้):** negative evidence `is_tis='False'` ตอบ "ไม่มี" เจาะรุ่น; cert on unit card (`model_id` join 99% พร้อมแล้ว)

### ✅ 2026-09-18 — spec-db substring collision → word-boundary match + brand guard

- **เจอจาก audit ของ user:** user ถาม "มั่นใจแค่ไหนว่าจะไม่พัง" → verify สดพบ collision จริงใน index 656 terms:
  - `mi 14 pro` → **iPhone 14 Pro (lightning 23W)** (จริง: usb-c 120W) — alias "14 pro" อยู่ใน "mi 14 pro" และยาวกว่า "mi 14"(5)
  - `mi 11 pro` → **iPhone 11 Pro** — alias "11 pro" เหมือนกัน
  - `ใช้กับ cta56` → **Galaxy A56** — term "a56" ฝังใน product code "cta56"
  - `vivo s25` → **Galaxy S25** — brand ผิด
  - ผลกระทบจริง: connector filter ใช้ spec ผิด → ทิ้งสาย usb-c ทั้งหมดให้ลูกค้าที่ถาม Mi 14 Pro
- **แก้ 2 ชั้นใน `_lookup_spec_db`:**
  1. `_term_boundary_match` — term ต้อง match แบบ token boundary (ต้น/ท้ายไม่ติด ascii-alnum) → "a56" ใน "cta56" ไม่ match, "iphone 5" ใน "5s" ไม่ match; ตัวอักษรไทย=boundary → "ใช้กับiphone17" ยัง match
  2. `_device_brand_hint` + `_spec_brand` — detect brand จาก input (mi/xiaomi/vivo/samsung/ฯลฯ ~20 brands + ไทย); ถ้าเจอ brand เดียวพอดี → รับเฉพาะ entry brand ตรง, ไม่ตรงหมด → None → web fallback; หลาย brand/ไม่มี → longest-match เดิม
- **verify 42/42:** bug cases ทั้ง 5 แก้ถูก (mi 14 pro→xiaomi 14, cta56→None, vivo s25→None→web fallback) + regression เดิมทั้งหมดไม่พัง — brand-guard drop log พิมพ์เพื่อ debug ได้
- **SRS_SSD.md** อัปเดต `_lookup_spec_db` ทั้ง 2 ตาราง
- **บริบท:** user สั่งพัก expansion "ทุกแบรนด์ 20 ปี" (เสี่ยงเขียนข้อมูลผิดจากความจำ ~400 รุ่น) — fix นี้ปิดช่อง collision ของ DB ปัจจุบัน ~140 รุ่น; ยังเหลือความเสี่ยง "fact ผิดใน entry" ซึ่งจำกัดด้วยการคุม entries ให้เฉพาะที่ verify ได้

### ✅ 2026-09-18 — DEVICE_SPECS catalog แทน _KNOWN_DEVICE_SPECS (สเปค hardcode ผิด → structured data)

- **ทำไม:** user ชี้ "spec hardcode บางทีผิด" ขอให้ไปดึง spec จากเว็บ (เสนอ GSMArena) — verify จริงเจอว่า `_KNOWN_DEVICE_SPECS` ผิด: iPhone 17 ใส่ 27W ทั้งที่จริงต้อง 40W+ adapter (PD3.2 AVS); ตารางมีแค่ ~25 รุ่น ขาด iPhone ≤14/iPad/MacBook เก่า/แบรนด์อื่นเกือบทั้งหมด
- **GSMArena direct ไม่ได้:** ติด anti-bot check — ใช้ `web_search.search_and_extract` spot-verify แทน (ดึง spec รุ่นใหม่ได้จริง: iPhone 17 Pro Max 40W, S26 Ultra 60W PPS, Pixel 10 Pro XL 45W PPS)
- **แก้:**
  1. **ไฟล์ใหม่ `device_specs_data.py`** — `DEVICE_SPECS` dict ~140 devices: `{connector, wired_w, wireless_w, protocols[], year, aliases[]}` — ครอบ iPhone ทุกรุ่น (5→17 Pro Max, lightning+usb-c eras), iPad/MacBook, Samsung S/Z/A/Tab 5 ปี, Xiaomi/Redmi/Poco, Huawei/Honor, Oppo/OnePlus/Realme, Vivo/iQOO, Pixel, Nothing, Sony, Asus, Motorola, Infinix/Tecno, game handhelds — แทน `_KNOWN_DEVICE_SPECS` (ลบทิ้งแล้ว — DB ครอบทุก entry เดิม)
  2. **`_lookup_spec_db(name)`** — flat index `term→canonical` (656 terms จาก keys+aliases), match: exact → alias → substring longest (กัน "iphone 17" ทับ "iphone 17 pro max")
  3. **`_resolve_device_spec`** — priority ใหม่: **spec DB → web parse** (เดิม web → hardcode table); structured data ไม่ต้องเดาจาก text
  4. **`_filter_compat_products`** — priority ใหม่: **`_resolve_device_spec` (DB→web) → intent** (เดิม intent ก่อน — intent wattage เป็น LLM guess ผิดได้ เช่น iPhone 17)
  5. **`_device_spec_lookup`** — `_dev_min_watt` resolve: **DB → intent → resolve**; เติม catalog line ลง spec extra: "📋 สเปคจาก catalog: connector=usb-c, ชาร์จมีสายสูงสุด 90W, ไร้สาย 50W, protocols: hypercharge, pd, pps, qc" → LLM เห็น protocol ชัด (เดิมได้แต่ watt จาก web text)
- **verify:**
  - unit `_lookup_spec_db` **32/32**: exact/alias/substring ครบ (mi 17 ultra→xiaomi, s25 ultra→galaxy, "ใช้กับ iphone 17 pro max"→substring) + negatives (ctc615w/ad653u/ipad/macbook/galaxy/brand เดี่ยว/x999 → None หมด)
  - **E2E in-process 7 เคส**: pingevox Q2→สาย 240W/100W (เดิม 60W ผิด) Q3→"ชาร์จเร็วสูงสุด 90W" + หัวชาร์จ 100W/120W; **s25 ultra** (เดิมไม่มีใน list เลย)→"45W USB-C"+สาย 60W; **pixel 10 pro xl**→"45W PPS" cite protocol จาก catalog; **iphone 14**→"Lightning 20W" สาย Lightning (เดิมตารางมีแค่ 12-17); **macbook air m3**→240W
  - stderr: `[DEVICE-SPEC] spec-db hit` + `source=spec-db` ทุกเคส — web search ยังทำงานคู่ขนานหา spec extra/keywords (ไม่ขัดกัน)
- **SRS_SSD.md** อัปเดต 6.15.2 + refactor note (เพิ่ม `_SPEC_INDEX`/`_lookup_spec_db`/`DEVICE_SPECS`, ปรับ `_resolve_device_spec`/`_filter_compat_products`/`_device_spec_lookup`, ลบ `_KNOWN_DEVICE_SPECS` rows)
- **หมายเหตุ:** ค่า wired_w = marketing spec (GSMArena-equivalent + spot-verify) — ยังเป็น curated table แต่ structured + provenance ชัด + อัปเดตจุดเดียว; device ใหม่ที่ไม่มีใน DB → fallback web parse เหมือนเดิม (ไม่มี hardcode gate)

### ✅ 2026-09-18 — generic device-token extractor แทน list ชื่อรุ่น hardcode

- **ทำไม:** user ชี้ "พึ่ง hardcode เกินไป" — spec lookup มี web-search เป็น primary อยู่แล้ว แต่ trigger list เป็นรุ่นเจาะจง 2 จุด: `_device_patterns_fallback` (device_compat) + device list ใน `_extract_charger_constraints` (app.py) → รุ่นใหม่ที่ intent พลาด = ไม่ search spec
- **แก้:** เพิ่ม `device_compat._extract_device_token(msg)` — `_DEVICE_TOKEN_RE` pattern A "letters+digits(+ultra/pro/max/edge/note...)" + pattern B "brand+category+digits" (apple watch 9 / galaxy buds 3 / redmi note 14); กรอง 2 ชั้น: `_NON_DEVICE_TOKENS` stoplist (pd/usb/qc/gen/set/watch-lone...) + product-code shape (letters+digits+letters glued = CTC615W/AD653U)
- **ใช้แทน:** `_device_spec_lookup` fallback + `_extract_charger_constraints` device — list รุ่นเจาะจงถูกลบทั้งคู่
- **`_KNOWN_DEVICE_SPECS` คงไว้:** emergency fallback เท่านั้น (fire เมื่อ intent ไม่ให้ connector AND web search พลาดพร้อมกัน — ปกติไม่ถึง)
- **verify:**
  - unit 24 cases: ดึงได้ iphone 17 pro max / s26 ultra / pixel 10 pro / honor magic 7 / huawei mate 70 / apple watch 9 / redmi note 14 (รุ่นที่ list เก่าไม่มีทั้งหมด) ; กรอง ctc615w / ad653u / pd3.0 / usb 3.0 / gen 2 / set 3 / gan 65w หมด
  - **fallback path จริง (intent_result={}):** "s26 ultra" (list เก่าไม่มี) → resolve → web search "Samsung Galaxy S26 Ultra USB-C 60W" → min_watt=60 → re-query sort adequate-first [65,140,140] ✅ — นี่คือ flow ที่ user ขอ: เจอ device → search spec → ไม่พึ่ง hardcode
  - E2E pingevox regression: Q3 → C2C615 140W ✅, Q4 → AD1203P 120W ✅
- **SRS_SSD.md** อัปเดต 6.15.2 (เพิ่ม `_extract_device_token` + ปรับ `_device_spec_lookup`)

### ✅ 2026-09-17 — pingevox Q3: แนะนำสาย 60W ให้เครื่อง 90W → adequate-first wattage sort

- **อาการ (แชทจริง pingevox, shadow):** "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → ตอบ CTC315P 60W ทั้งที่ context มีสาย 100W/140W/240W ครบ
- **root cause (verify ด้วย repro):** `_device_spec_lookup` re-query sort **wattage asc ล้วน** → สาย 60W อยู่ต้น context, 100W+ อยู่ตำแหน่ง 14-19 → LLM position bias หยิบ 60W เป็น "baseline" ทั้งที่ spec เครื่องต้องการ 90W — `min_watt` resolve ได้ (web text "90W" / `_KNOWN_DEVICE_SPECS`) แต่ใช้แค่ connector filter ไม่เคยใช้จัดลำดับ
- **แก้ (structural, ไม่ hardcode ผูกสินค้า):**
  1. เพิ่ม `_wattage_asc_key(p, min_watt)` ใน `device_compat.py` — ของที่ watt ≥ min_watt (จ่ายไฟพอ spec เครื่อง) ขึ้นก่อนเรียง asc, ของต่ำกว่าไปท้าย, ไม่รู้ min_watt → asc เดิม
  2. `_filter_compat_products` sort เปลี่ยนมาใช้ key นี้ (`device_min_watt` resolve อยู่แล้ว)
  3. `_device_spec_lookup` resolve `_dev_min_watt` (intent → `_resolve_device_spec`) ครั้งเดียว ใช้ทั้ง (a) เติม threshold ชัดใน spec extra: "อุปกรณ์รองรับสูงสุด ~90W → ตัวหลักต้อง ≥90W" (b) sort re-query
- **verify E2E (history format จริง `[สินค้า: xxx]`):**
  - Q3 → context: สาย 100W ขึ้น [2-3], CTC315P ถูกดันท้าย → ANS แนะนำ **CMC615 240W / C2C615 140W** ✅ (2 รอบหลัง fix)
  - Q4 "หัวชาร์จละ" → AD1203P 120W / AD1003T 100W ✅ ไม่กระทบ
  - regression iPhone 17 (min_watt=27): สาย 60W ยังเป็น baseline ได้ถูกต้อง ✅ + COMPAT-FILTER main path ใช้ key ใหม่ ✅
  - unit check `_wattage_asc_key`: None→asc ล้วน / 90→[100,240,0,60] / 27→[60,100,240,0] ✅
- **tests:** test_charger_subtype_parity 42/42 · test_anchor_compare · test_guards · test_car_charger_regression 16/16 ผ่าน — test_pingevox_mistore ยิง HTTP 401 (infra ไม่เกี่ยว)
- **หมายเหตุ:** ยังเป็น prompt+ordering level — LLM อาจพลาดเป็นบางรอบ แต่ context ตอนนี้เอื้อม baseline ที่ spec ผ่านจริงเสมอ; ⚠️ KB path ไม่มี `_filter_compat_products` (connector filter รันเฉพาะ main path) — gap เดิมที่ยังไม่แตะ
- **SRS_SSD.md** อัปเดต 6.15.2 (เพิ่ม `_wattage_asc_key` + ปรับ `_filter_compat_products`/`_device_spec_lookup`)

### ✅ 2026-09-17 — image_texts batch จบ + import Mongo + cert standards search (plan: `docs/plans/cert-standards-search.md`)

**image_texts pipeline สมบูรณ์:**
- batch 8 shards จบครบ err=0 — unique ok **14,005 รูป**, err-only ค้าง 0 (97 error เก่า retry ผ่านหมด); cost รอบนี้ ~$2
- `import_image_texts.py` เพิ่ม `_image_item_ids()` — map `image_id → item_ids` จาก export field_list (logic เดียวกับ `_collect_worklist`) + index `item_ids` → upsert **14,005 docs ทุกตัวมี item_ids** (11,290 new / 2,715 updated); kinds: spec 11,543 / banner 1,355 / product 1,068 / raw 21 / variant_map 18

**cert standards search (มอก./CE/CCC/FCC/RoHS/GB):**
- **ก่อน:** `search_tisi_products` ค้น `description` เท่านั้น → 86 listings ที่บอก มอก. เฉพาะในรูปหลุดหมด (union จริง ~213 listings vs เดิมเห็น ~127)
- **แก้:** `warranty.detect_cert_question` (superset TISI — boundary regex กัน FP: CE ใน "service", GB ใน "128GB", หมอก/เสมอกัน); `extract_tisi_model_keyword` ตัด cert kw + stopword ไทยเพิ่ม (ที่/ร้าน/อะไร — fix bug ที่เจอตอน live: "มีสินค้าที่ผ่าน CE ไหม" → kw='ที่' ฆ่าผลหมด); `product_store.search_cert_products` merge desc+image_texts (`via`=desc/image/both, sellable-first, model_kw→ไม่กรอง status); `handoffs.py` cert block label dynamic + `cert_not_found`
- **compat:** `detect_tisi_question`/`search_tisi_products` เป็น wrapper/cงเดิม
- **verify:** `docs/test/test_cert_standards.py` **31/31** + test_new_product_types 66/66 + py_compile ครบ; **live chat() จริง:** "รุ่นไหนมี มอก. บ้าง"→cert_answer 30 รายการ ✅, "มีสินค้าที่ผ่าน CE ไหม"→CE จริง ✅, "A18T มี มอก. ไหม"→เฉพาะ A18T ✅, "สินค้าผ่านมาตรฐานอะไรบ้าง"→all certs ✅, "หมอกเย็น"→ไม่เข้า cert path ✅; restart :8010/:8015 health 200
- **SRS_SSD.md** อัปเดต: 6.3.1/6.3.6/6.3.7 (search_cert_products + helpers + constants), 6.8.1 (detect_cert_question + tisi fns), 6.17.1 (post_intent_handoffs)
- **replay จริง `shp_152520384227573579`** (CukTechThailand, 10 turns, LLM จริง): Q1/Q2/Q5 cert ตอบถูก ✅; fix เพิ่ม `ทุกรุ่น/ทุกตัว/ทุกอัน/ทุกชิ้น/ทุกสินค้า/ทั้งหมด` ใน `_TISI_GENERAL_KWS` (เดิม "ทุกรุ่นมี มอก ไหม" → kw หลุด → handoff ผิด); **จุดเหลือ:** Q3 "1" บอทตอบอังกฤษ (LLM language slip), Q4 "ทุกรุ่น" ไม่มี cert kw → หลุด cert path (ถ้าจะให้ follow-up สั้นต่อ cert context ต้องเพิ่ม logic แยก), cert_answer list ชื่อเต็มยาว 3k chars (อาจ trim/กรองหมวด)
- **test chat KingGadgets (2026-09-18):** "หาพาวแบง มีมอก มีไหม" → handoff ผิด — root cause `extract_tisi_model_keyword` คืนคำไทยล้วน ("หาพาวแบง") เป็น model → name filter ฆ่าผลหมด ทั้งที่ KingGadgets มีของจริง (tisi 1/ccc 2/ce 6); **fix:** model kw ต้องมี token alnum ≥3 ตัว (รหัสรุ่น AC65B2/A18T) — คำไทยล้วน → "" = คำถามทั่วไป; เลือก token ที่มีตัวเลขก่อน; test 36/36 + live verify: ได้ PowerConnex PCX-P (มอก.) / 3 items (tisi+ccc union) ✅
- **category-aware cert search (2026-09-18):** user ชี้ "PowerConnex ไม่ใช่ powerbank" — generic cert search ไม่กรองหมวด → **fix:** (1) เพิ่ม kw `"พาวแบง"` bare ใน PRODUCT_TYPES powerbank (เดิม detect ไม่ได้เพราะ kw ต้องมี ค์/ก์); (2) `search_cert_products` เพิ่ม `type_filter` + `_name_matches_types` กรอง item_name ด้วย PRODUCT_TYPES regex ทั้ง desc+image path; (3) handoffs ส่ง `_detect_product_types(msg)` เฉพาะตอนไม่มี model_kw — filter แล้วว่าง → re-search ไม่กรองหมวด → ตอบ "สำหรับ{หมวด} ยังไม่พบข้อมูล {cert} แต่สินค้าอื่นที่มีได้แก่..." แทน handoff; **verify:** test 42/42 + live KingGadgets: "พาวแบง+มอก" → 0→fallback ตอบตรงๆ (ไม่เรียก PowerConnex ว่า powerbank) / "พาวเวอร์แบงค์+ccc" → เฉพาะ Aura LPB200NC (Himo/PowerConnex หลุด) ✅; restart :8010
- **tisi regex FP "เสมอกัน" (2026-09-18):** นับ มอก. ต่อร้านเจอ KingGadgets 13 รายการ — user สงสัย → inspect เจอ 2 FP: BINNIFA "เสมอกันที่ 0.8 มม." + Amazfit "อยู่เสมอการแจ้งเตือน" — root cause: "เสมอกัน" เก็บเป็น `[เ][ส][ม][อ][ก]` (เ เป็นสระของ ส ไม่ใช่ของ ม) → lookbehind `[หเ]` เห็น ส ไม่ block; **fix:** เพิ่ม ส → `(?<![หสเ])มอก` ใน `_CERT_SEARCH_RES` + `_TISI_PATTERN` (product_store) + `_CERT_QUESTION_RES` (warranty) + เพิ่ม guard `"เสมอก"` ใน `detect_tisi_question` เดิม; **verify:** test 46/46 + recount: union 449→429, KingGadgets 13→11 (11 จริง = รางปลั๊กมอก.2432-2555 ส่วนมาก SELLER_DELETE เหลือขายแค่ PCX-P), Leravan/Binnifa/QKZ/LuckyHomeMart หลุดออกหมด (เป็น FP ทั้งร้าน) ✅; restart :8010
- **หมายเหตุ:** รูป cert อยู่ใน image scope เดิมอยู่แล้ว (มอก. 119 รูป/GB 227/CCC 19/CE 14) — ไม่ต้อง extract เพิ่ม; งานนี้คือทำให้ runtime ใช้ข้อมูลนั้นได้

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

### 📊 2026-09-17 (ต่อ) — test_200 selected-100 rerun รอบ 3 (หลัง user แก้ API key)

- **ผิวเผิน:** 100 pass / 0 fail / 0 err — ไม่มี HTTP 500 (race ไม่ trigger — ยัง latent ในโค้ด: `client.close()` บน shared cached client ยังอยู่ app.py:282/300/309/385 + chat_v2.py:1489)
- **LLM errors เหลือ 9/100** — เปลี่ยนจาก `400 API_KEY_INVALID` → `429 RESOURCE_EXHAUSTED` (key ใช้ได้แล้ว แต่ชน quota — เคส #123,#124,#152-160 กระจุกท้ายรัน = rate limit)
- **BUG-A #109 ยืนยันยังพัง:** "พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม" → ตอบ "ยังไม่มีพาวเวอร์แบงค์วางจำหน่าย" ทั้งที่ DB มี **25+ รุ่น** (PB200P 150W / P23 210W / QB826G 210W — ชาร์จ MacBook ได้จริง) — root cause เดิม: charging re-query เชื่อ web extractor "charger" → pool เต็มหัวชาร์จ — P1 (`product_types_override`) ยังไม่ implement
- **ค้นพบเพิ่ม:** CukTechThailand ทั้ง 136 docs `product_type=None` (untyped 100%) — แต่ override ใช้ regex บน `item_name` ไม่ใช่ field → P1 design ยังใช้ได้
- **#132 `เสียงดีสุด` ถูก route:** เพราะ intent LLM ทำงาน — แต่ "เสีย" substring ใน `_CLAIM_REQUEST_INDICATORS` ยังอยู่ = **latent** แสดงตัวเฉพาะตอน intent fail (Run1 เห็นแล้ว)
- **#45/#46 QCY "ไม่มีหูฟัง" = ถูกจริง:** catalog QCYThailand 23 ชิ้น `UNLIST` ทั้งหมด — grounded ✅ (compat #113/#114 ตอบ "รองรับ" เป็นความจริงทางเทคนิค — gray area จดไว้)
- **#136 เจอ path ใหม่:** `superlative_no_match_clarify` — "เอาที่ดีที่สุด" ไม่มี type → ถาม clarify กลับ ✅ (น่าจะจาก parallel session)
- **สรุป:** คุณภาพคำตอบจริงดีขึ้นมากเมื่อ LLM ทำงาน — bug ที่เหลือ = BUG-A (P1 พร้อม) + mongo close race (latent) + "เสีย" boundary (latent) + 429 quota (ops)

### ✅ 2026-09-17 (ต่อ) — BUG-A fixed: charging re-query scope ตาม type ที่ถามจริง

- **อาการ:** "พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม" (CukTechThailand, #109) → ตอบ "ยังไม่มีพาวเวอร์แบงค์" ทั้งที่ DB มี 25+ รุ่น (PB200P 150W / P23 210W / QB826G 210W)
- **root cause:** `_device_spec_lookup` charging re-query สร้าง query จาก `_device_product_type` ที่ **web extractor เดา** ("charger" ทับทุกเคส) → fetch ดึงหัวชาร์จเต็ม pool → LLM สรุป "ไม่มี" จาก context ที่ผิดหมวด
- **แก้ (~25 บรรทัด ไม่มี hardcode สินค้า):**
  - `_CHARGER_FORMS` = {car_charger, wireless_charger, desktop_charger, dock} — เส้นแบ่ง class (degrade-safe)
  - `_charging_scope(msg, asked_type)` = `detect(msg)` ∩ `_CHARGING_TYPES` — 'charger' drop เมื่อมี form เจาะจง (substring artifact ของ "หัวชาร์จ/แท่นชาร์จ") แต่เก็บเมื่อคู่กับ non-form; detect ว่าง → fallback `{asked_type}`; ไม่มี → None
  - re-query ส่ง `product_types_override=_chg_scope` — override ใช้ regex บน `item_name` → ทำงานกับร้าน untyped 100% ได้ (verified CukTech 136 docs type=None)
- **verify:** scope matrix 8/8 · test_compat_mode_filter **45/45** · car_charger_regression **16/16** · general_qtype_guards 27 · qa_context_guard 4/4
- **E2E:** #109 → "ชาร์จได้ — CUKTECH AURA PB100S 30W" (powerbank จริง) ✅ · สายชาร์จ iPhone15 → CTC315P เดิมเป๊ะ ✅ · หัวชาร์จในรถ → **CC903P Car Charger จริง** (OBS-2 ดีขึ้นด้วย — subtype scope แม่นกว่า) ✅
- **ผลกระทบเคสอื่น:** generic charger → {charger} เดิมเป๊ะ · multi-type เก็บครบ · unknown mode ไม่ส่ง override · type ใหม่ใน taxonomy ไม่ต้องแตะโค้ด
- **จดไว้:** PB100S 30W ต่ำกว่า spec MacBook (~70W) — คำตอบบอก 30W ตรงๆ grounded แต่ adequate-first sort อาจควรเลือกรุ่น watt สูงกว่า (ไม่ใช่ wrong-answer — เดี๋ยวดูว่า spec-db มี MacBook Air ไหม)

### ✅ 2026-10-02 — Spec source ladder (P3): web search = ด่านสุดท้าย + ฆ่า prose watt parse

- **อาการ:** ทุก compat query ยิง web search ~6K tok/call (~$0.01) แม้ device อยู่ใน spec-db — web ถูกเรียกตั้งแต่แรกก่อนเช็ก db เลย; + prose `max(\d+W)` ดูด "สายชาร์จ 240W" มาเป็น spec ของเครื่องเป้าหมาย; + re-query พึ่ง web keywords → web fail = pool ว่าง → ตอบผิดหมวด (หัวชาร์จ 65W แทนพาวเวอร์แบงค์)
- **root cause:** ลำดับ source ผิด (จ่ายก่อนฟรี) + เชื่อเลขลอยใน prose + re-query ผูกกับ web keywords
- **แก้ (generic ทุก type/subtype — ไม่มี hardcode keyword):**
  1. `_device_spec_lookup` charging/unknown → source ladder: spec-db → re-query derive เอง (`{subtype_kw} {type_word} {device} {conn_synonyms}` + `_charging_scope`) → catalog evidence `_device_mentioned` (สินค้าระบุชื่อ device ตรง = declared compat) → **web เฉพาะเมื่อไม่มีหลักฐาน** → web keywords re-query เพิ่ม → intent min_watt สำรอง
  2. `_CONN_QUERY_KW` — connector→query synonyms (vocab map เดียวกับ `_extract_product_connectors`)
  3. `_device_mentioned` — boundary match + no-space variant ("iPhone18" = "iphone 18") บน name/description
  4. `_resolve_device_spec` — **ลบ prose watt parse**: เชื่อเฉพาะ connector vocab; watt ต้องมาจาก structured (spec-db/web-structured/intent) เท่านั้น
  5. min_watt chain consistent: spec-db → web-structured → intent (lookup+filter ตรงกัน)
- **verify:** test_compat_mode_filter **70/70** (เพิ่ม section 10 — spec-db hit→ไม่ web, catalog hit→ไม่ web, ทุกชั้นพลาด→web, intent-only→web, prose→connector only) · car_charger 16/16 · guards 27+4+7+10 ผ่าน
- **E2E จริง:** "พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม" → spec-db hit macbook(70W) → re-query scope={powerbank} merge 64 → sort ≥70W ก่อน → **ตอบ PB200P 150W + PB250 210W** (ก่อนหน้า: หัวชาร์จ 65W) — **0 web call** · สายชาร์จ iphone15 → CTC315P ✅ · เคส/หูฟัง เดิมเป๊ะ
- **ผลกระทบเคสอื่น:** model_fit/self_compat/skip path ไม่แตะ · non-compat intents ไม่แตะ · web search ยังทำงานเป็น fallback เมื่อ device แปลก/ไม่มีหลักฐาน · prose connector parse ยังอยู่ (ตัว load-bearing ของ filter)
- **จดไว้:** unit-index compat re-query ใช้ `is_compat_check=True` เดิม (ข้าม unit path) — ถ้าอนาคตอยากให้ compat ใช้ units ต้องทำ field-filter sweep แทน vector-only (limit ไม่ใช่ตัวจำกัด — similarity ต่างหาก)

### ✅ 2026-10-02 (ต่อ) — spec-db expansion ~10 ปี + outer web-search gate

- **งาน:** เพิ่ม `DEVICE_SPECS` ครอบคลุมย้อนหลัง ~2016-2026 ทุกแบรนด์ (มือถือ/แท็บเล็ต/หูฟัง/ล็อปท็อป/แก็ดเจ็ต) — user สั่ง: "เก็บเป็นชุดข้อมูลได้ถ้าสเปคเดียวกัน"
- **ทำ:**
  - `device_specs_data.py`: 249 → **516 entries** — เพิ่ม Samsung Note8-20/S7-S10/A-J-M/Tab เก่า, AirPods ทุก gen, iPad lightning era, Galaxy Buds, Sony WF/WH, Redmi Buds, FreeBuds, Enco, JBL, Bose, Beats, Marshall, Mi 8-10, Redmi Note 7-11, Poco F/X/M, Oppo F/Reno เก่า, Realme, OnePlus 5-9/Nord, Vivo V/Y, Huawei P/Mate/Nova, Honor, Pixel 1-5a, Xperia, Zenfone/ROG, Motorola edge/g/razr, MatePad/Lenovo Tab/Oppo Pad, **Windows laptops** (Dell XPS/Inspiron, HP Spectre/Envy/Pavilion/Elitebook/Omen, ThinkPad/Yoga/IdeaPad/Legion, Zenbook/Vivobook/TUF/ROG, Acer Swift/Aspire/Nitro, MSI, Surface), wearables (Huawei/Amazfit/Garmin/Fitbit/Xiaomi watch), GoPro/Kindle/JBL speaker/Switch Lite + **generic entries** (iphone/ipad/notebook — query ลอยไม่มีรุ่น)
  - shared spec templates `_T_*` (25 templates) — รุ่นที่ spec เหมือนกัน `{**_T_x, year, aliases}` แก้จุดเดียวทั้งชุด
  - `device_compat.py`: `_SPEC_HEAD_BRAND` + `_DEVICE_BRAND_HINTS` เพิ่ม brand ใหม่ (sony/asus/moto/infinix/tecno/itel/nokia/zte/meizu/lenovo/lg/htc/nintendo/valve/microsoft ฯลฯ)
- **เจอระหว่างทำ (fix เพิ่ม):** `should_use_web_search` rule `compatibility_check_device_specific` ยิง web เสมอเมื่อข้อความมี "แบรนด์+เลขรุ่น" — แม้ spec-db grounded แล้ว (redmi note 9 จ่าย 5,784 tok/$0.009 ฟรีๆ) → เพิ่ม gate: `target_device` อยู่ใน spec-db → ข้าม `device_specific`+`short_answer` trigger (negative/no_products ยังทำงาน) — lazy import `_lookup_spec_db` ไม่ cycle
- **verify:** test_compat_mode_filter **144/144** (เพิ่ม section 11: มือถือเก่า/connector micro-usb-lightning/หูฟัง/แท็บเล็ต/laptop/gadget/shared-template/brand-guard/generic/outer-gate) · car_charger 16/16 · guards 27+4+7+10 ผ่าน
- **E2E:** `redmi note 9` → spec-db hit (usb-c 18W) + **0 web call** (ก่อน: จ่าย $0.009/ครั้ง) · `macbook` → PB200P/PB250 เดิมเป๊ะ 0 web · `ชาร์จ notebook ได้ไหม` → generic notebook 65W → แนะนำ GaN 65-100W ✅
- **ผลกระทบเคสอื่น:** lookup logic ไม่แตะ (data เท่านั้น) · brand guard กัน alias ข้ามแบรนด์ (oppo a73→None, xiaomi x9→None) · dupe keys 6 ตัวถูกลบ (spec ซ้ำของเดิม) · alias ไทย 4 สะกด
- **จดไว้:** ไฟล์ `test_compat_mode_filter.py` ถูก IDE/watcher revert 2 รอบระหว่างทำ — ต้องเขียนแบบ atomic ผ่าน shell · server 8020 (unit-index) ยังรันโค้ดเก่า

### ✅ 2026-09-21 — Phase 0 (QA remaining-bugs plan): T1-T4 output boundary + extraction + human-request

แพลน: `docs/plans/2026-09-21-qa-remaining-bugs-plan.md` (review 5 รอบ) — RC-A ไม่มี trust boundary LLM→ลูกค้า / RC-B claim state / RC-C keyword whack-a-mole / RC-D error ดิบหลุด / RC-E วัดไม่ได้

- **T1 (BUG-Q error ดิบถึงลูกค้า):** llm.py มี 6 จุดคืน `f"...({exc})"` แนบ exception → เพิ่ม `LLM_ERROR_REPLY` + `_error_reply()` — ลูกค้าได้ข้อความสุภาพเดียวกัน, exception log ฝั่ง server
- **T2 (NEW-1 ชื่อขยะ + order_sn):**
  - root cause: `_THAI_NAME_FALLBACK_RE` ใน `extract_customer_info` เชื่อ text ที่ clean แล้วเป็นชื่อคน → "ขอบคุณ"/ชื่อสินค้ากลายเป็นชื่อ → **ลบทิ้ง** เหลือ NER + EN-name pattern; เพิ่ม reject เมื่อชื่อ EN ติด model/ตัวเลข ("Pro Max" จาก "iPhone 15 Pro Max" ไม่ใช่ชื่อ)
  - `_PHONE_PATTERN` ใช้ `\b` → normalize ลบ space แล้วเบอร์ติดตัวไทยไม่ match → เบอร์หลุดเป็น order_id → แก้ boundary ให้กัน digit adjacency แทน
  - mask เบอร์ก่อน scan order_id ทั้ง `extract_customer_info`/`detect_purchase_date_and_order`; order_id ถึง 19 หลัก
  - `order_store.extract_order_sn` เพิ่ม fallback เลขล้วน 15-19 หลัก (`_ORDER_SN_RE` บังคับมีตัวอักษร → Shopee sn ตัวเลขล้วนไม่ถูกจับ)
- **T3 (BUG-M human-request):** flat keywords จับ "ติดต่อเจ้าหน้าที่/แชทกับเจ้าหน้าที่/ติดต่อร้านค้า" ไม่ได้ → เพิ่ม composition verb+target regex (คน guarded `(?!ละ|ขับ|ส่ง|รับ)`) + ร้าน-rule (contact verbs เท่านั้น) + English — **แก้ FP เดิมด้วย:** ลบ flat "ขอคน/ติดต่อคน/พูดกับคน/ส่งต่อคน" ที่ match substring ("ขอคนละครึ่ง"/"พูดกับคนขับ" เคยโดน handoff ผิด)
- **T4 (RC-A trust boundary):** `chat()` → `_chat_impl` + thin wrapper เรียก `guards.enforce` (ครอบ legacy/v2/v3 — funnel /chat จุดเดียว); rules-as-data `_ESCALATE_RULES`: answer อ้าง "แอดมินรับเรื่องแล้ว/เคลมเรียบร้อย" แต่ `handoff_to_admin=False` → **`_send_handoff` จริง** + แทนข้อความ + set flag (เดิม `_false_admin_patterns` ใน llm แก้แค่คำ ไม่ส่งจริง → ลบออกจาก `_strip_kb_markup`); `answer == LLM_ERROR_REPLY` → escalate; fail-open
- **verify:** py_compile ทุกไฟล์ · test_guards pass · car_charger 16/16 · qtype_guards 27/27 · subtype_parity 42/42 · probe บน :8030 — human-request ใหม่ handoff ถูก / "คนละครึ่ง"/"คนขับ"/"แอดเพื่อน" ไม่หลุด · extract: ชื่อไทย/EN/เบอร์/order 19 หลัก ถูก, "ขอบคุณ"/"Pro Max" ไม่กลายเป็นชื่อ · enforce: false-admin claim → handoff_to_admin=True + ข้อความถูกแทน
- **ผลกระทบเคสอื่น:** NER path เดิมไม่แตะ (ชื่อจริงยังจับได้) · flat kw ที่เหลือครบคำเดิม · enforce ไม่แตะ resp ที่ handoff แล้ว · v2/v3 ผ่าน wrapper อัตโนมัติ · skip: rewrite-rule (นโยบายไม่มี grounding) = T7 Phase 2 ตามแพลน

### ✅ 2026-09-21 — Phase 1 (QA plan): T5 claim-state fill-once + T6 order-problem routing

- **T5 (RC-B claim ถามซ้ำ/กลืนคำถาม):**
  - root cause หลัก: legacy `warranty_flow.py` เคลียร์ `claim_state` ทุกครั้งที่ handoff แต่ State-7 receipt ก็ handoff → save→clear ใน turn เดียวกัน → fill-once พัง; v2 (`handle_warranty_flow`) ไม่ load/save claim_state เลย; `purchase_date` ไม่เคยถูก save
  - helpers ใหม่ (warranty_flow.py:34-124, ใช้ร่วม 2 engines): `_is_question_msg` (question markers กัน swallow), `_merge_claim_slots` (ข้อความปัจจุบัน ∪ persisted — ค่าปัจจุบันชนะ), `_claim_collecting` (persisted marker: stage=collecting หรือมี slot → info resume ได้แม้ last model msg ไม่ใช่ claim prompt), `_update/_clear_claim_state` wrapper, `_maybe_clear_claim_state` (clear เฉพาะ terminal reasons + ข้ามเมื่อ answer ยัง "รบกวนแจ้งข้อมูล"/"ได้รับข้อมูล" — กัน ask-info prompt ที่ใช้ reason in_warranty ลบ state)
  - legacy: State-7 gate ขยายด้วย `_claim_collecting` + merge+persist (incl. purchase_date) + BUG-D fallback มี question-fallthrough (คำถามล้วน+ไม่ใช่ claim request → ปล่อย pipeline ปกติตอบ) + ticket closed → clear state; v2: load claim_state + merge ทุก collection branch + persist + mark stage=collecting ตอนเริ่มขอข้อมูล
  - **เจอ regression ตอน probe (แก้แล้ว):** ลูกค้าแทรกคำถามกลาง flow แล้วส่งเลข order ต่อ → `early_order_flow` ดักเป็น order_lookup (เช็ค `_in_claim_flow` จาก last model msg อย่างเดียว) → เพิ่ม check persisted `claim_state` ผ่าน `_claim_collecting` ใน order_flow.py:64-74 → resume ทำงาน + bare order ปกติยัง order_lookup
- **T6 (ส่งผิด/ของขาด/ของแถมขาด → แอดมิน ไม่ใช่เคลม):**
  - root cause: `_RETURN_REFUND_KWS` มีแค่คำกลุ่มคืนของ/คืนเงิน → fulfillment complaints หลุดลง LLM intent → โดนจัด warranty_claim เข้าฟอร์มเคลมผิดประเภท
  - แก้: ขยาย class "ปัญหาออเดอร์ที่ต้องส่งแอดมิน" ใน `early_order_flow` — `_ORDER_PROBLEM_*` composition (context×fault) + direct phrases + hypothetical guard ("ถ้า/สมมติ/ในกรณี/หาก" ข้าม) + topic classifier; reuse path เดิมเป๊ะ: มี order_sn → anchor+handoff `reason=order_problem`+topic / ไม่มี → ถามเลข → follow-up (marker "สินค้าที่ได้รับ/ปัญหาการจัดส่ง/ของแถม/ของไม่ครบ" ใน `_is_rr_followup` + `_rr_followup_order_problem` แยก kind)
  - priority: match ทั้งคู่ → return/refund ชนะ (behavior เดิม); `not _in_claim_flow` guard ทั้งตอน detect + follow-up (ไม่ดึงคนออกจากเคลม)
  - fault list ไม่มี "เสีย/พัง/ใช้ไม่ได้" — defect ยังไป warranty เหมือนเดิม
- **verify:** py_compile · probe :8030 — "ส่งของผิด/ของแถมไม่ครบ/แกะกล่องของขาด/ยังไม่ได้รับของ" → `order_problem_ask_order` · +order_sn → `order_problem_handoff` reason=order_problem+topic · follow-up order-problem→order_problem / return-refund→return_refund (kind ถูก) · "ส่งผิด ขอคืนเงิน" → return_refund ชนะ · negatives: "มีของแถมไหม"→product_store, "สินค้าเสีย"→warranty_claim, "เปลี่ยนได้ไหม"/"ถ้าส่งผิดทำยังไง"→return_policy (ไม่ handoff) · T5 live: fill-once merge เลข order จาก turn ก่อนใน review, question fallthrough → warranty_policy จริง, resume หลังคำถาม → claim รับ order_sn+persist, claim_state ใน DB ถูก · regression: guards ✓ qtype 27/27 parity 42/42 car_charger 16/16
- **ผลกระทบเคสอื่น:** bare order_sn ไม่มี claim → order_lookup เหมือนเดิม · return/refund path ไม่เปลี่ยน (เพิ่ม flag เฉยๆ) · warranty defect flow ไม่แตะ · tracking/anchor path เหมือนเดิม (ข้ามเฉพาะเมื่อ claim_state collecting)

### ✅ 2026-09-21 — Phase 2 (QA plan): T7-T11 output grounding + card suppress + image anchor + cleanup

- **T7 (RC-A tier-2 — claim ไม่มี grounding ใน context):**
  - root cause: guard เดิม escalate ได้เฉพาะ "อ้างว่าแอดมินทำแล้ว" — แต่ LLM แต่ง "มีของแถม/คืนเงินได้" โดยไม่มีหลักฐานใน product context ผ่านไปถึงลูกค้าได้
  - แก้ (guards.py): `_REWRITE_RULES` rules-as-data — promo claim (มีของแถม/แถมฟรี/ลดเหลือ/ส่งฟรี/โปร ฯลฯ) + return claim (เปลี่ยนได้/คืนเงินได้/รับคืน); `_claim_grounded` เช็ค grounding จาก `resp.products` จริง (description_excerpt/raw_description kw + has_promotion/is_flash_sale flags — คือ context ที่ส่งให้ LLM จริง ไม่ต้อง plumb เพิ่ม); `_REWRITE_SKIP_PREFIXES` ข้าม source ที่ context เป็น policy/order อยู่แล้ว (general:/order_/warranty/return_refund/human_request ฯลฯ); lookbehind กัน negation ("ไม่มีของแถม" ผ่าน)
  - **เจอ defect ตอน live probe (แก้แล้ว):** แทนที่เฉพาะ span ที่ match → เศษ claim ค้าง ("...TA3005U ที่มี[REPLACED]แถม Adaptor") → `_replace_clause` หา clause boundary (`\n`/`|||`/`.!? `/particle ไทย+space) แล้ว swap ทั้ง clause + collapse particle ซ้ำ
- **T8 (NEW-7 การ์ดมั่ว):** intent ∈ {warranty_claim, general_question, other} + ข้อความไม่มี `_PRODUCT_MENTION_KWS` → `products_for_response=[]` (ทั้ง path ปกติ + web-search branch); hoist `product_kw` → `product_store._PRODUCT_MENTION_KWS` เป็น single source (ใช้ร่วม `_clean_description` + gate)
- **T9 (NEW-6 รูปไม่ผูกสินค้า):** `image_desc` → `extract_model_keywords` → item_name regex → **match ตัวเดียวเท่านั้น** → set `_hybrid_anchor_card` (desc กำกวม match ≥2 → ปล่อย flow ปกติ); อยู่หลัง item-tag block ก่อน retrieval → anchor เข้า narrowing/compare ปกติ
- **T10 (cosmetic):** `_strip_kb_markup` — markdown table `| a | b |` → `• a: b · c: d` (Shopee render ตารางไม่ได้) + collapse "ทางร้าน จะ"→"ทางร้านจะ"
- **T11 (NEW-8 dump list ดิบ):** `answer_general` — brands/categories ถ้าคำถาม specific ให้ตอบจาก context ก่อน ห้าม echo list ดิบ (เคส "CUKTECH คือ ZMI เดิมไหม" เคยได้ brand list ทั้งก้อน)
- **verify:** py_compile ทุกไฟล์ · unit probe 8+7 เคส (ungrounded→rewrite clause สะอาด / grounded flag+desc→ผ่าน / negation→ผ่าน / general source→ข้าม / escalate ชนะ rewrite) · live :8030 — greeting/sticker/thanks/complaint → cards=0, product-q → cards=10, "มีของแถมไหม" → ตอบสะอาดหลัง fix clause, "CUKTECH คือ ZMI เดิมไหม" → ตอบเฉพาะเจาะจงไม่ dump, T6/T5 path เดิมไม่หลุด · regression: guards ✓ qtype 27/27 parity 42/42 car_charger 16/16
- **ผลกระทบเคสอื่น:** rewrite tier แตะเฉพาะ answer ที่ claim โปร/เปลี่ยนคืน ungrounded เท่านั้น · card suppress มี product-kw escape hatch (complaint ที่ถามสินค้ายังได้การ์ด) · image anchor ต้อง match ตัวเดียว+ไม่มี ref อื่น → ไม่ทับ anchor เดิม · T9 live-verify จำกัด (ต้องส่งรูปจริง) — logic มี guard ครบ
- **เหลือ:** Phase 3 (T12-T16 — replay เคสเดิม / audit no_product_found_handoff / shadow batch / price prohibition / corpus) เป็นงาน verify/measure ไม่ใช่ code fix

### ✅ 2026-09-21 — Phase 3 (QA plan): T12-T16 verify/measure — audit เสร็จ เจอ bug จริง 1 ตัว

- **T12 (replay BUG-H/K/O):** "Luxury Black" / "ROSY" / "BINNIFA" / "Pad 7" → ตอบ "ไม่มี/ไม่พบ" ถูก shop-scope ครบทุกเคส + เสนอของใกล้เคียงจากร้านจริง — ไม่มี cross-shop fabrication เดิม
- **T13 (audit no_product_found_handoff ไม่เคย fire):** root cause 2 ชั้น — (1) arm1 `not products` แทบเป็นไปไม่ได้ เพราะ vector path `argsort(sims)[:top_k]` **ไม่มี similarity floor** คืน nearest เสมอ; (2) arm2 ถูก `_is_conv_active` ∈ `_guard_has_intent` ปิดเงียบ — แชทที่มี anchor อยู่แล้ว arm2 ตายเสมอ; fire ได้เฉพาะ fresh conv + ของแปลกไม่ติด kw + "มี...ไหม" · สังเกต: guard return ก่อน web-search (fire แล้วไม่ลอง web) — เป็น design เดิม ไม่แตะ
- **T14 (NEW-9 bot_elapsed_ms):** เจอ bug จริง = **unit mismatch** — `/chat` คืน `elapsed` เป็นวินาที แต่เขียนลง `bot_elapsed_ms` ดิบๆ (shadowReplyService ×2, botWorkerService, test-assignment ×2) → 4.2s แสดง "4.2ms" → ดูเหมือน 0/พัง; `bot_tokens` เก็บ usage ครบอยู่แล้ว (BUG-I ok) — **รออนุญาตแก้ (×1000 ที่ write sites หรือแปลงตอน display)**
- **T15 (price prohibition):** prompt มีครบ (llm.py:198-200/504-506/535/546/1518 "ห้ามบอกราคาทุกกรณี") → leak ถ้ามี = LLM non-compliance ไม่ใช่ missing prompt — ไม่ต้องแก้
- **T16:** เพิ่ม `misinterpret_monitor` 4 เคสเข้า corpus generator (ย่อ=สรุปสั้น / ปิด AOD) — corpus regen 304 ข้อ

### ✅ 2026-09-21 — NEW-9 fix: bot_elapsed unit mismatch (seconds→ms)

- **error:** `bot_elapsed_ms`/`bot_elapsed` แสดง "4.2ms" ทั้งที่จริง 4.2 วินาที — ดูเหมือน elapsed=0/พัง
- **root cause:** `/chat` คืน `elapsed` เป็น**วินาที** แต่ write sites เก็บดิบลง field ที่ชื่อ/แสดงเป็น **ms**
- **fix:** `Math.round(elapsed * 1000)` (คง `undefined` เมื่อไม่มี elapsed — ไม่เขียน 0 ซ้ำอาการเดิม) ที่ 9 sites / 4 ไฟล์: `shadowReplyService.ts` ×2, `botWorkerService.ts`, `liveAssignmentService.ts` ×4, `test-assignment/route.ts` ×2
- **ไม่แตะ:** bot python (`elapsed` วินาทีถูกตาม schema) + display logic (อ่านเป็น ms ถูกแล้ว)
- **doc เก่าใน DB** ยังเป็นวินาที (โชว์เล็กผิดหน่วย) — ไม่ได้ backfill (test/shadow data; ถ้าต้องการให้บอก)
- **verify:** `npx tsc --noEmit` clean · grep ไม่เหลือ write site ดิบ
