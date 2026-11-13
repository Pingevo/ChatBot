# Dev Worker Prompt — Phase 1 Customer Answer Quality

```text
SESSION: เดิม

# PHASE 1 — CUSTOMER ANSWER QUALITY — EXECUTE TASKS 1–7 TODAY

ทำงานใน repo:
/Users/itdev4/Documents/GitHub/ChatBotProductMS

เป้าหมายรอบนี้คือทำเฉพาะ Phase 1 (Tasks 1–7) ของแผน customer-answer quality ให้จบวันนี้ตามหลักฐาน โดยยังไม่เริ่ม Zaapi KB correction, workflow integration หรือ full live QA ของ Phase ถัดไป. “เสร็จวันนี้” ไม่อนุญาตให้ข้าม RED/STOP gate หรือสร้าง GREEN เทียม; ถ้าขาด typed contract ให้จบด้วย PARTIAL + executable evidence.

## PART 0 — อ่านและตรึงสถานะก่อนทำ

1. อ่าน `AGENTS.md` ทั้งไฟล์และทำตามทุกข้อ
2. อ่าน `docs/waythrough-ledger.md` ครบ ตรวจ frozen SHA และ active prefix SHA ตามกฎข้อ 8 แล้วอ่านเฉพาะ active tail หลัง prefix
3. อ่านไฟล์ต่อไปนี้ครบก่อนแก้โค้ด:
   - `docs/superpowers/plans/2026-11-12-customer-answer-quality-kb-workflow-implementation.md`
   - `docs/plans/active/2026-11-12-full-system-chatbot-live-qa-report.md`
   - `docs/plans/active/2026-11-11-customer-answer-findings-and-correction-plan.md`
   - `docs/SRS_SSD.md` เฉพาะ section 6 ของ function ที่ Phase 1 จะเปลี่ยน
4. รายงาน branch, HEAD, staged/unstaged/untracked manifest ก่อนเริ่ม และรักษา dirty UI work ที่มีอยู่ทั้งหมด ห้ามแก้/format/stage ไฟล์ UI ที่ไม่ใช่งานนี้
5. append “กำลังจะทำ Phase 1” ลง `getoutofmywaybotkaikrook2.md` ตามกฎ repo

## PART 1 — ขอบเขตงาน

ทำตามลำดับเท่านั้น:

1. Task 1 — Freeze Customer-Answer Acceptance Matrix
2. Task 2 — Real Visual Media as Typed Turn Input
3. Task 3 — Intent Provider Failure must not become semantic `other`
4. Task 4 — Carry Same-Product Description and Specs to the Owning Need
5. Task 5 — Select One Primary Product and Keep Answer/Card Identity Bound
6. Task 6 — Preserve Product and Relation Context Across Follow-up Turns
7. Task 7 — Honest Compatibility, No-Evidence and Handoff Wording

รายละเอียด file, interface, test case และ command ให้ยึดจากแผนหลักแบบ verbatim. ห้ามเริ่ม Tasks 8–10 ในรอบนี้

## PART 2 — กติกา RED/GREEN/REGRESSION ที่บังคับ

ทำ RED → GREEN “ราย production function” ไม่ใช่รวมหลาย function แล้วแก้ทีเดียว:

1. เขียน executable behavioral RED สำหรับ function A
2. รันเฉพาะ targeted test ของ function A และเก็บ failure จริง
3. แก้ minimal code ที่ function A ใน owner เดิมเท่านั้น
4. รัน test เดิมให้ GREEN
5. ถ้า Task ต้องแก้ function B ให้ทำ RED → GREEN ของ B แยกอีกวง
6. เมื่อทุก function ของ Task GREEN แล้ว จึงรัน regression set ของ Task นั้น “หนึ่งครั้งเดียว”
7. ห้ามรัน full/focused regression ซ้ำหลังทุก function; regression ใหญ่มีครั้งเดียวตอนจบ Task
8. ถ้า GREEN เผยว่าต้องแตะ owner อื่น, เพิ่ม typed field/interface หรือเพิ่ม mechanism นอกงบ ให้ STOP Task นั้นพร้อมหลักฐาน ห้าม patch ต่อ

Task 2 ต้องแยกอย่างน้อย:
- `turn_decision.decide_turn`: owner-level RED → GREEN
- `app._chat_impl`: customer-boundary RED → GREEN
- จากนั้น regression ของ Task 2 หนึ่งครั้ง

Tasks 3–7 ใช้จังหวะเดียวกันตามจำนวน function ที่พิสูจน์ว่าต้องเปลี่ยนจริง

## PART 3 — ข้อห้ามด้าน complexity

- ห้ามเพิ่ม production helper
- ห้ามเพิ่ม guard ที่ตีความ business behavior
- ห้ามเพิ่ม regex หรือขยาย regex semantic
- ห้ามเพิ่ม keyword/phrase table หรือคำใหม่ในตาราง
- ห้ามเพิ่ม heuristic
- ห้าม hardcode คำตอบ, product identity, shop, intent หรือ fallback prose เพื่อให้ test ผ่าน
- ห้ามสร้าง decision/composition owner ใหม่
- ห้ามสร้าง nested function โดยไม่จำเป็น
- ห้ามแก้หลาย layer สำหรับ root cause เดียว
- ห้ามแก้ expected test เพื่อยอมรับ behavior ผิด
- ห้ามใช้ source-text assertion เป็นหลักฐานแทน behavior

กลไกใหม่ที่อนุมัติไว้สำหรับ Phase 1 มีเพียง keyword-only parameter:
`decide_turn(..., has_visual_media: bool = False)`

นอกเหนือจากนี้ต้อง STOP และขออนุมัติ ห้ามตีความว่าแผนอนุมัติให้อัตโนมัติ

## PART 4 — Safety และข้อมูล

- ห้ามอ่าน `.env` ทุกชนิด
- ห้ามอ่าน `มาแล้วจ้า.md`
- Product DB read-only
- ห้ามส่งข้อความให้ลูกค้าจริง, ห้าม Shopee live send, ห้าม assign admin จริง, ห้ามแก้ config ระบบใช้งาน
- รอบ Phase 1 ใช้ offline seam/stub เท่านั้น ไม่เรียก Gemini/provider จริง
- raw QA logs/results ต้องอยู่ path gitignored เดิมและห้าม commit
- ห้าม stage/commit/push/PR/deploy

## PART 5 — Owner และ STOP gate ต่อ Task

Task 1:
- fixture ต้อง redacted และไม่มี customer/conversation IDs, address หรือ image bytes
- baseline suite รันหนึ่งครั้งหลัง fixture gate

Task 2:
- แก้เฉพาะ typed media input ที่ `decide_turn` และ call site `_chat_impl`
- ห้ามย้าย Vision, เพิ่ม media keyword หรือ final-answer guard
- expected mechanism delta: params +1; ที่เหลือ +0

Task 3:
- แก้ exception branch เดิมของ intent provider
- ห้าม retry, fallback classifier, keyword หรือ helper ใหม่
- semantic provider failure ต้องไม่ถูกปลอมเป็น intent `other`

Task 4:
- trace same-identity description/spec ตั้งแต่ source card → pool → selected request → attributed evidence → AnswerContext
- direct product spec ใช้ description ของ identity/shop เดียวกันได้ แต่ description prose ห้ามเป็น compatibility proof
- แก้เฉพาะ first drop; ถ้าต้องเพิ่ม fact/provenance field ให้ STOP

Task 5:
- recommendation ปกติ = หนึ่ง primary product + หนึ่ง card
- explicit compare/options เท่านั้นที่คืนหลาย subject ตามที่ขอ
- answer context และ `ChatResponse.products` ต้องใช้ selected identity/shop/sellable set เดียวกัน
- price ห้ามเข้า model-visible customer prose context; product-card display contract เดิมไม่เปลี่ยนถ้าไม่ได้รับอนุมัติ
- ก่อนแก้ต้อง trace retrieval → pool → selection → AnswerContext → final products และแก้ first wrong owner เท่านั้น

Task 6:
- ใช้ `ConversationSubjectSet`, timeline `bot_suggestion`, target device และ relation fields ที่มีอยู่
- ทดสอบสอง turn จริงใน conversation id เดียว และ negative control คนละ conversation
- ห้ามเพิ่ม conversation keyword, regex, memory collection, summary field หรือ LLM memory
- ถ้าต้องมี persisted field ใหม่ให้ STOP

Task 7:
- typed evidence ครบต้องตอบ compatible/incompatible ตรง ๆ
- generic cannot-confirm ใช้ได้เฉพาะ dimension ที่ยังไม่มีหลักฐาน และต้องรายงาน fact ที่ขาดจาก typed state เดิม
- ใช้ `UnansweredNeed.reason`, routing result และ persisted handoff state ที่มีอยู่
- ถ้า typed state ปัจจุบันแยก missing-product/missing-fact หรือ handoff outcome ไม่ได้ ให้ STOP เป็น missing contract
- ห้าม post-render replace หรือ canned variation pool

## PART 6 — เอกสารและ verification

ทุก Task ที่เปลี่ยน function ใน `chatbot/shopeechat/` ต้องอัปเดต `docs/SRS_SSD.md` section 6 ให้ครบ Purpose/Input/Output/Calls/Called by/How it works/Side effects/Error fallback พร้อม file+line หลังแก้จริง

หลังจบแต่ละ Task รายงาน:
- root cause
- function/owner ที่แก้
- targeted RED command + failure
- targeted GREEN command + result
- regression command “ครั้งเดียว” + result
- final answer/products/evidence/route/action proof
- files changed
- net mechanism delta: helpers, guards, regexes, keyword tables, heuristics, fields/params, decision owners
- residual/STOP reason

ทำ Tasks 1–7 ต่อเนื่องได้โดยไม่ต้องหยุดถามระหว่าง Task หากยังอยู่ใน contract นี้และทุก gate ผ่าน แต่ถ้าต้องเพิ่ม mechanism, owner หรือ typed contract ที่ไม่ได้อนุมัติ ให้หยุดทั้ง run และรายงานทันที

## PART 7 — Final Phase 1 report

เมื่อ Task 1–7 จบ:

1. รันเฉพาะ verification/compile/diff-check ที่แผนกำหนดสำหรับ Phase 1; อย่ารัน Tasks 8–10
2. append “ผ่านแล้ว/วิธีแก้/งานค้าง” ลง active log
3. สรุป exact new ranges เข้า ledger และเลื่อน active integrity prefix ไป EOF ตาม AGENTS ข้อ 8
4. ตรวจ staging ว่างและไม่มีไฟล์นอก scope ถูกแก้
5. ส่งรายงานแยก Task 1–7 พร้อมตาราง RED/GREEN/regression และ counts จริง
6. หยุดก่อน stage/commit/push/PR/deploy

ห้ามใช้คำว่าเสร็จ/ผ่านถ้าไม่มี fresh command evidence. หากบาง Task STOP ให้รายงาน Phase 1 ว่า PARTIAL พร้อม root cause และอย่ากลบด้วยการแก้เฉพาะหน้า
```
