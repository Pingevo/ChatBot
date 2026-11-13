# Customer-answer root-cause findings and correction plan

วันที่: 2026-11-11 (Asia/Bangkok)
สถานะ: **audit + proposed plan only** — ยังไม่อนุมัติให้แก้ production code หรือเปลี่ยน behavior

## 1. เป้าหมายและขอบเขต

รวบรวมปัญหาคำตอบที่พบจาก code walkthrough, QA artifacts และ API probe จริง ให้แยก **สิ่งที่ยืนยันแล้ว**, **ช่องโหว่ที่พิสูจน์จากโค้ดแต่ยังไม่ reproduce live**, และ **สิ่งที่ยังไม่มีหลักฐาน** ก่อนแก้ทีละ root cause

เอกสารนี้ต่อยอดจาก [remaining-work roadmap](2026-11-11-remaining-work-roadmap.md) และ [remaining-work register](2026-11-06-remaining-work-register.md) ไม่แทนแผนเดิม

ข้อจำกัดที่ล็อกไว้:

- แก้ business behavior ที่ typed owner เดิม
- เพิ่ม helper, guard, regex, keyword table, heuristic หรือ decision owner = **0**
- ห้ามทำให้ guard ยอมรับ claim ที่ไม่มีหลักฐาน; แก้ทางนำข้อมูลจริงเข้า evidence owner เดิม
- ถ้า owner/typed contract เดิมแทนข้อมูลที่ต้องการไม่ได้ ให้หยุดและรายงาน missing contract ก่อนขออนุมัติ ไม่ปะ patch เฉพาะตัวอย่าง
- Product DB เป็น read-only; live QA ใช้ synthetic/Test Chat หรือ shadow path ที่ไม่ส่งข้อความจริง
- API/Gemini result ในเอกสารนี้มีหนึ่งคำถาม live; ผล QA50/QA12 อื่นเป็นหลักฐานจากรอบก่อน ไม่ใช่การรันซ้ำในรอบนี้

## 2. ภาพรวม

ปัญหาไม่ได้มีต้นเหตุเดียวว่า “Zaapi KB ไม่ทำงาน” แต่แยกเป็น request classification, shop scope, product/model/variant selection, typed evidence, Zaapi retrieval/provenance, handoff และรูปแบบคำตอบ

หลักฐานแยกเส้นทางสำคัญ:

- **คำถามรับประกัน:** ใน API probe ข้อมูล policy อยู่ใน `grounding_text`; general FAQ ในโหมด Zaapi ใช้ `get_general_faq` → `zaapi_search`. สำหรับคำถามนี้จึงมีหลักฐานว่าเส้นทาง FAQ ดึง context มาได้ แต่ route/คำตอบปลายทางยังไม่ทำงานตามที่ลูกค้าต้องการ
- **คำถามสินค้า:** หลาย QA trace มี `ch:kb selected=0`; ยังไม่ทราบครบว่าไม่มี hit ตั้งแต่ retrieval หรือถูกตัดภายหลังที่ pool/selector. ห้ามเอาผล FAQ ด้านบนไปสรุปว่า product KB ใช้ได้ทุกกรณี
- HTTP 200 อย่างเดียวไม่ใช่เกณฑ์ผ่าน: ต้องตรวจข้อเท็จจริง, สินค้า/ร้าน, ความครบคำถาม, handoff state และต้นทุน/เวลา

## 3. Findings

### F1 — ข้อความบอกให้ทักแอดมิน แต่ระบบไม่ได้ handoff — **ยืนยันจาก API จริง**

**ตัวอย่าง:** ส่ง “ถ้าสินค้าไหม้ประกันไหม” ผ่าน `/chat` ได้ HTTP 200 และคำตอบ “รบกวนทักแอดมินเพื่อตรวจสอบข้อมูลเพิ่มเติมเกี่ยวกับกรณีสินค้าไหม้ให้นะคะ” แต่ response ระบุ `source=general:warranty_policy`, `routing=bot_reply`, `handoff_to_admin=false`, `handoff_reason=null`.

**หลักฐานประกอบ:** context มีเงื่อนไขรับประกันและข้อยกเว้นความเสียหายจากการใช้งานผิดวิธี/อุบัติเหตุ/ตกหล่น แต่คำตอบไม่ได้วินิจฉัยสิทธิ์หรือบอกขั้นตอนที่ชัด และไม่ได้สร้าง handoff. `detect_claim_request` ตรวจ symptom ภายในทางที่ match question-pattern; phrase `ประกันไหม` ไม่อยู่ในชุด pattern ที่ครอบคลุม. จากนั้น general-answer branch เรียก `answer_general` และคืน `bot_reply` โดยตรง ไม่เรียก handoff owner. จุดเกี่ยวข้อง: `warranty.py:403-468`, `app.py:1555-1617`, `app.py:2205-2255`, `responses.py:46-58`.

**ความมั่นใจ:** สูงสำหรับผลลัพธ์และเส้นทางที่ไม่ handoff; สูงสำหรับ code path; ไม่ได้พิสูจน์ว่าทุกประโยคที่มีคำว่าไหม้ควรเป็น claim.

**แนวแก้ที่เสนอ:** กำหนดความหมายใน typed decision เดิมให้แยก “ถามเงื่อนไขทั่วไป” ออกจาก “รายงานอาการเสียและต้องให้เจ้าหน้าที่ตรวจ”. เมื่อเป็นเคสต้องส่งต่อ ใช้ handoff owner เดิมและบอกลูกค้าตามผลจริง: queued/assigned เท่านั้นจึงบอกว่าส่งแล้ว; ถ้าส่งไม่สำเร็จต้องไม่อ้างว่าส่งแล้ว. ห้ามแก้ด้วยการเพิ่มคำพ้องหรือ keyword เฉพาะเคส.

**ผล live เพิ่มเติม (§7.7):** คำถาม troubleshooting ของ PB150S ให้คำแนะนำและชวนติดต่อแอดมิน แต่ `handoff_to_admin=false`. เป็นการยืนยันอาการ “ข้อความชวนติดต่อ ≠ handoff ที่เกิดจริง” ในอีก intent หนึ่ง; ยังต้องแยก owner ที่สร้างข้อความออกจาก handoff transport.

### F2 — ข้อมูลร้านอื่นเสี่ยงปนใน policy และ exact-item lookup — **โค้ดยืนยันช่องโหว่; หลักฐาน live บางส่วน**

**ตัวอย่าง:** QA ก่อนหน้าพบคำตอบเรื่องการจัดส่งของ KingGadgets มีเนื้อหา IMILab/Leravan. `_extract_policy_from_descriptions` ค้นสินค้า `NORMAL` โดยไม่มี `shopname` predicate (`knowledge_base.py:395-436`). อีกช่องทางหนึ่ง `fetch_product_by_id` ค้น `item_id + shop` ก่อน แต่ถ้าไม่พบจะ retry ด้วย `item_id` โดยไม่กรองร้าน (`product_store.py:3785-3821`); app เรียกใช้กับ shared/tagged item (`app.py:1301`).

**ความมั่นใจ:** สูงว่า query paths นี้ไม่มี scope ตามที่ต้องการ; cross-shop exact-item เป็น code-proven risk แต่ยังไม่มี live replay ที่ยืนยัน foreign item หลุดจริง. การปน policy มีตัวอย่างจาก QA ก่อนหน้า.

**แนวแก้ที่เสนอ:** ใช้ shop/platform จาก turn scope ที่มีอยู่ใน query owner เดิมตั้งแต่ก่อนจำกัดผล. Exact-item ที่ไม่พบในร้านปัจจุบันให้เป็น not-found ในร้านนั้น ห้าม fallback เงียบไปอีกร้าน. ข้อมูลส่วนกลางใช้ได้เมื่อมี contract/provenance ระบุชัดว่า shared; ไม่ให้ empty scope ทำให้ข้อมูลร้านเฉพาะกลายเป็น global.

### F3 — คำถามหลายรุ่น/หลายสีถูกยุบเป็น selection เดียว — **T01 ยืนยัน; T08 จุดย่อยยังไม่ครบ**

**T01 ตัวอย่าง:** “พัดลม Zaiwan BP35S สีชมพูกับสีเขียวมีสต็อกไหม แล้วส่ายซ้ายขวาได้กี่องศา?” Mongo sync มีสีชมพู 50, สีเขียว 30 และ description ระบุ 120°. คำตอบกลับบอกว่าสีชมพูไม่มีของและไม่ตอบองศา. Trace เก็บสีชมพู+เขียวเป็น `variant_terms` เดียว และ need ไม่มีมุมส่าย. Offline reproduction พบ card ที่มี stock 50/available=true ถูก canonicalize เป็น variant unknown/sellable=false.

**T08 ตัวอย่าง:** “GS3 กับ GS3 Ultra มีสีอะไรที่ยังมีสต็อกบ้าง?” trace มี `model_codes=[]`, เลือก S3 relation-targets และไม่มี GS3 subject card; Mongo sync มีสต็อก GS3/Ultra. สิ่งที่ยืนยันคือผลค้น/เลือกไม่ถึงรุ่นเป้าหมาย; ยังระบุไม่ได้ว่า candidate หายที่ fetch, admission หรือ selector.

**ผล live เพิ่มเติม (§7.7):** ภายใต้ Grouped Retrieval Selection ที่เปิดจริง คำถาม GS3/GS3 Ultra ได้คำตอบว่า GS3 ไม่มีของและเสนอ S3 Special Edition พร้อม product card ทั้งที่ ShpProducts snapshot มี GS3-family stock รวม 1,393. ยืนยัน wrong-model substitution ที่ `/chat`; จำนวน stock เป็น snapshot จาก DB ไม่ใช่หน้าร้าน Shopee แบบ real-time.

**จุดตรวจ:** `route_context.py:395` (`_variant_terms`), `units.py` search/model path, retrieval executor, canonical availability และ selector. ดู source evidence ที่ `docs/test/results/qa50_shop_audit_2026-11-10.json` และ ledger A-177–A-180.

**แนวแก้ที่เสนอ:** ใช้ typed request/profile และ model/variant identity owners เดิมให้แทนแต่ละรุ่น/สีและแต่ละ fact ที่ถาม; ให้ stock ผูกกับ item/model/variant เดียวกัน. ตรวจ trace ตั้งแต่ raw candidates ก่อน top-K ถึง final selected cards. ห้ามเพิ่ม regex/alias/keyword หรือ fallback แนะนำสินค้าคล้าย ๆ เพื่อกลบการหาไม่เจอ. ถ้า typed profile ปัจจุบันแทนรายการหลายสี/หลาย fact ไม่ได้ ให้ยื่น missing-contract decision ก่อน.

### F4 — ข้อมูลในชื่อ/ข้อความไม่ถึง evidence ที่ guard ยอมรับ — **พบจาก QA; behavior เป็น fail-closed**

**ตัวอย่าง:** T07 CTC515N มี connector/100W ในข้อมูลสินค้า แต่ final answer ยืนยันไม่ได้; trace มี `guard_rewritten=spec_claim` และไม่มี matching `spec_measured`. `_spec_fact_grounded` ต้องการ identity-scoped `FieldEvidence` หรือ typed Zaapi evidence (`guards.py:269-346`).

**ผล live เพิ่มเติม (§7.7):** ShpProducts title ที่ตรวจมีข้อมูล Kieslect Actor ว่ามี GPS และ Actor ปรากฏใน selector candidates แต่ `spec_measured=[]`; final answer ถูก rewrite เป็น cannot-confirm (`guard_rewritten=spec_claim`). สิ่งนี้พิสูจน์ว่าข้อมูลใน catalog และ candidate ไม่ได้แปลว่า typed evidence ถึง answer guard; ยังไม่อนุมัติให้ใช้ title เป็น proof โดยไม่มี authority contract.

**ความมั่นใจ:** สูงว่าคำตอบถูกปิดโดยช่องทาง typed evidence; ไม่ได้สรุปว่าทุกข้อความใน product title เป็นแหล่ง authoritative เพียงพอ.

**แนวแก้ที่เสนอ:** ตรวจแหล่ง structured/canonical ที่มีอยู่และให้ field ที่เชื่อถือได้ไหลผ่าน evidence producer/owner เดิม โดยคง identity scope และ guard เดิม. หากข้อความ title ยังไม่มี authority contract ห้ามยกเป็น proof ด้วยการลดความเข้มของ guard.

### F5 — Zaapi มีหลาย serving path และ provenance ถูกทำให้แบน — **บางส่วนยืนยัน; relevance บางจุดยังเปิด**

- Product evidence ผ่าน `zaapi_kb_evidence` รับเฉพาะ productish needs (`kb_zaapi.py:39-87`); general warranty FAQ ค้น `get_general_faq`/`zaapi_search` แยก path (`knowledge_base.py:362-392`).
- `get_general_faq` join คำตอบหลาย hit เป็น string แต่ metadata เก็บแยกไว้; `build_general_context` ใช้เฉพาะ `answer` (`knowledge_base.py:479-514`). ทำให้ source boundary/provenance ไม่ชัดใน prompt.
- Product QA ก่อนหน้าหลาย trace มี `ch:kb selected=0`. หลักฐานยังไม่แยกว่า `zaapi_search` ไม่พบ row หรือ row ถูก reject/หลุดที่ attribution/pool/selector.
- **ผล live เพิ่มเติม (§7.7):** Local Zaapi query พบแถวรับประกัน LPB200NL = 1 ปี แต่ `/chat` สามครั้งเลือก description ของ CTC315P, ไม่ส่ง product card และตอบอายุประกันไม่ได้. ใน trace ที่ละเอียด exact LPB200NL row ไม่อยู่ใน final context; ยังไม่พิสูจน์ว่าตกที่ adapter, attribution, pool admission หรือ selector.

**แนวแก้ที่เสนอ:** เก็บ trace ต่อ query ที่ existing owner ทำอยู่ให้ครบ retrieval → scope → ranking → pool → selection → answer context; เปรียบเทียบ hit ที่ถูกต้องกับ hit จริง. รักษา record provenance/ขอบเขตแต่ละแถวใน context เพื่อจับคำตอบขัดกัน. ปรับ ranking เฉพาะเมื่อ probe พิสูจน์ว่าปัญหาอยู่ที่ ranking; ไม่เพิ่ม semantic keyword/filter แบบเดา.

### F6 — คำแนะนำ troubleshooting ทั่วไปไม่ตรงสินค้า — **เสี่ยงจาก owner ปัจจุบัน; ต้องยืนยันตามรุ่น**

`malfunction_safe_check` คืน checklist เปลี่ยนสาย/หัวชาร์จ/ปลั๊กและตรวจพอร์ตเมื่อเจอข้อความ malfunction ทั่วไป (`warranty.py:471-490`); first-claim flow ต่อด้วยข้อความ claim ทั่วไป (`warranty_flow.py:1736-1753`). QA ก่อนหน้ามีอุปกรณ์สวมใส่/ปุ่มกีฬาได้คำแนะนำกว้างที่อาจไม่เกี่ยวอุปกรณ์.

**ผล live เพิ่มเติม (§7.7):** คำถาม PB150S ชาร์จไม่เข้าได้ checklist ทั่วไป พร้อมรายละเอียดสเปก/โปรโตคอลและลิงก์ `goto.in.th`; มีชื่อ “abubu” ที่ยังหา provenance ไม่ได้. Mongo มี troubleshooting row ของ PB150S ในการอ่านก่อนหน้า แต่ request trace รอบนี้ยังไม่พิสูจน์ว่าคำแนะนำแต่ละข้อถูกดึงจาก row นั้นหรือมาจาก model.

**แนวแก้ที่เสนอ:** ให้ troubleshooting KB ที่ตรงรุ่น/ชนิดอุปกรณ์เป็นทางหลักผ่าน owner เดิม; ถ้าไม่มีคำแนะนำที่ตรง อย่าแสดง checklist ชาร์จไฟกับอุปกรณ์ที่ไม่เกี่ยว และส่งต่อด้วยผล handoff จริง. ทดสอบกับรุ่น/อาการจริงก่อนปรับ default.

### F7 — คำตอบยาว/ซ้ำ — **แนวโน้มยืนยันจาก prompt และ QA**

Prompt สั่งทั้งให้ตอบสั้น 1–2 ประโยคและให้เสริมอีก 2–3 ประโยค/60–120 คำ; output cap 4096 tokens (`llm.py:297-334`, `llm.py:1725-1742`). T05 ตอบ 15W/55W ถูก แต่ขยายข้อมูลและ CTA เกินคำถาม — จัดเป็นปัญหาความกระชับ ไม่ใช่ missing fact.

**แนวแก้ที่เสนอ:** ทำคำสั่ง prompt เดิมให้ไม่ขัดกัน: ตอบประเด็นที่ถามก่อน, เพิ่มเฉพาะข้อมูลจำเป็น, แนะนำสินค้า/CTA เมื่อร้องขอหรือมีเหตุผลจาก context. คงคำตอบละเอียดเมื่อผู้ใช้ถามสเปกเต็ม. ปรับ output budget ที่มีอยู่เมื่อมีผลวัด; ไม่เพิ่ม post-answer truncation guard.

**ผล live เพิ่มเติม (§7.7):** PB150S troubleshooting answer มีข้อมูลนอกคำถาม, ลิงก์และ product-card prose สองรายการ ทั้งที่ `products=[]`; เป็นหลักฐานคำตอบยาว/รูปแบบไม่สอดคล้องกับ structured output ใน canary นี้.

### F8 — ภาพและการจำบริบท — **ยังไม่ยืนยัน**

QA12 ที่ตรวจไม่มี image turn และบาง replay ส่ง assistant/card history หรือ item id ไม่ครบ; จึงยังแยก production defect ออกจากข้อจำกัด harness ไม่ได้. ไม่สรุปว่า image path หรือ memory เสียจนกว่าจะทดสอบ conversation เดียวกันด้วย payload/history/card ที่ครบ.

**แนวตรวจที่เสนอ:** ใช้ full conversation จริงใน Test Chat/shadow, เก็บ message IDs, image bytes/URLs ที่เข้า bot, item-card IDs, history ที่ส่งเข้า `/chat`, per-turn request ID และ final response. เริ่มจากตรวจ harness parity ก่อนเปลี่ยน production owner.

### F9 — ข้อมูล Zaapi ซ้ำใน Mongo — **ยังไม่ยืนยันจาก audit นี้**

Audit นี้ไม่ได้ทำ active-revision census, duplicate-key/content comparison หรือ trace import/export ของ Zaapi รอบใหม่. จึงยังระบุไม่ได้ว่าความซ้ำเป็นสาเหตุของคำตอบแย่. แยกเป็นงาน data-integrity ใน K0/K2/K4 และ external writer/dedupe work; อย่าลบข้อมูลก่อนมี identity rule, backup และ dry-run evidence.

### F10 — ข้อห้ามราคาเป็น prompt-only และ model ยังเห็นราคา — **ยืนยันจาก code/test/transcript**

`llm.py` สั่งห้ามบอกราคา แต่ `answer_context._BASE_CARD_FIELDS` รวม `price` และ `_scope_card` ส่ง field นี้เข้า model-visible card. `guards.py` ไม่มี output-price validation ใน path ที่ตรวจ; `test_phase8_composition.py` พิสูจน์ว่า composition marker ที่ valid ปล่อย `WPB100L ราคา 990 บาทค่ะ` ผ่านแบบ byte-identical. Transcript Q3 ก่อนหน้าก็มีราคาใน prose. สรุป: ระบบมีคำสั่งห้าม แต่ไม่มี invariant ที่บังคับผลลัพธ์ทุก path.

**แนวแก้ที่เสนอ:** ยืนยันขอบเขตว่าราคาห้ามอยู่เฉพาะข้อความตอบหรือรวมถึง product cards; จากนั้นแก้ที่ answer-context/composition owner เดิมให้ model ไม่ได้รับ price สำหรับ customer prose และให้ทุก output path เคารพนโยบายเดียวกัน. ห้ามเพิ่ม regex/guard/heuristic; ถ้า existing typed owner ทำให้รับประกันทุก path ไม่ได้ ให้หยุดรายงาน missing contract ก่อน.

### F11 — Runtime config snapshot รอบแรกคลาดจากค่าที่อ่านสำเร็จภายหลัง — **รอบล่าสุดยืนยันว่าโหมดที่ขอเปิดอยู่**

การอ่าน Mongo รอบแรกเห็น grouped selection ปิดและอ่าน `prompt_modular` ไม่สำเร็จ; snapshot นั้นถูก supersede. การอ่าน persisted `main_config` ที่สำเร็จภายหลังยืนยัน `kb_source=zaapi`, `pool_sources` ทั้งสี่เปิด, `grouped_retrieval_selection_enabled=true`, `prompt_modular=true`, `grouped_retrieval_shadow_enabled=false`. ไม่มีการเขียน config. API canary แสดง `GroupedRetrievalSelection` ใน trace จึงยืนยันว่า selector ทำงานใน request ที่ทดสอบ; shadow comparison ยังปิดและไม่ได้รัน.

**ผลต่อแผน:** ไม่ต้องเปิดหรือ rollback config ในรอบนี้. เก็บการตรวจ persisted + per-request trace เป็น precondition ของ QA ต่อไป; แยกการเปิด shadow comparison เป็นการตัดสินใจอีกข้อ.

### F12 — Need-kind กับ Zaapi record-kind อาจทำให้ข้อมูลมีอยู่แต่ไม่เข้าคำถาม troubleshooting — **final-answer symptom ยืนยัน; จุดตกของ evidence ยังไม่ชี้ขาด**

`kb_zaapi_evidence` รับเฉพาะ productish needs; `qa_troubleshoot_tips` ค้นเฉพาะ record types FAQ/troubleshooting. Active file-backed snapshot ที่ตรวจพบ product/spec/stock rows แต่ scoped `types=(troubleshooting,)` คืน 0 hit. รายงาน Mongo เก่าที่ A-189 เคยบันทึก troubleshooting row ของ PB150S; ยังไม่ได้พิสูจน์ว่าเป็น revision/corpus เดียวกับ active file-backed snapshot. Live `/chat` รอบล่าสุดตอบ checklist/spec ทั่วไป, มีหลาย model candidates, `products=[]`, `handoff_to_admin=false`, และมีข้อความ provenance ไม่ชัด. อาการปลายทางจึง reproduce แล้ว แต่ request-level evidence trace ยังไม่แยกว่า retrieval/need mapping, attribution, corpus/revision, model generation หรือ composition เป็นสาเหตุหลัก.

**แนวแก้ที่เสนอ:** ทำ matrix need-kind × record-kind จากคำถามตัวอย่างและ source rows จริง แล้วแก้การเชื่อมที่ typed retrieval/attribution owner เดิมเท่านั้น. ต้องพิสูจน์ว่า data ชนิด product ที่ช่วยตอบอาการถูกยอมรับโดย contract เดิมหรือไม่; อย่าแก้ด้วย keyword/regex ใหม่หรือให้ทุก record เข้า every need.

### F13 — ค่า usage/cost และ latency ต่อ request รายงานไม่ครบ — **ยืนยันจาก 6 live API calls**

`ChatResponse.usage/cost` นับ answer call แต่ไม่รวม intent call: หก requests รวม top-level answer usage 84,829 tokens (~$0.0269007 จาก `ai_usage`) ขณะที่ `ai_usage` รวม intent+answer 114,140 tokens / $0.0381822. Intent step cost ใช้ rate ต่างจาก `_gemini_cost` ใน `ai_usage` ราว $0.00060/request. อีกทั้งเวลารอ `_acquire` เกิดก่อน provider timer จึงไม่อยู่ใน `ai_usage` elapsed: KingGadgets LLM step 31.889s เทียบ provider elapsed 4.047s; quota wait เป็นคำอธิบายที่สอดคล้องกับ code แต่ยังไม่มีค่ารอที่วัดตรง.

**แนวแก้ที่เสนอ:** ให้ telemetry ที่มีอยู่รายงาน turn total รวม intent/answer/retry/fallback และแยก queue/quota wait ออกจาก provider elapsed; ใช้ rate source เดียวกันหรือระบุ rate/version ใน estimate. ห้ามตั้ง latency/cost SLO จาก top-level `ChatResponse` ค่าเดียว.

## 4. ลำดับการแก้ที่เสนอ

### Stage 0 — สร้าง regression set และ trace ที่เชื่อถือได้

- ยึดกรณี F1, T01, T08, T07, shipping cross-shop, troubleshooting และ verbosity เป็น golden cases พร้อม source record, shop/platform, expected facts, route และ current answer
- ต่อ telemetry ด้วย request ID ให้รวม intent + answer + retries/fallback; API response usage ต้อง reconcile กับ `ai_usage`
- ตรวจ full transcript/image/card/history ก่อน replay; ระบุ `context-limited` หากต้นทางไม่ครบ
- persisted config ล่าสุดยืนยัน grouped selection และ modular prompt เปิด; API canary เห็น `GroupedRetrievalSelection`. Shadow comparison ยังปิด. ผล selector-on รอบนี้ใช้ได้เป็น preliminary QA; ห้ามเหมารวมเป็นผล full conversation หรือ shadow QA
- มี bounded API canary 6 ครั้งแล้ว (§7.7): ใช้ synthetic/de-identified questions, ไม่มี history/images/conversation IDs และไม่มีการส่งข้อความ. ถือเป็น preliminary evidence ไม่ใช่ full-conversation หรือ shadow QA
- เพิ่ม golden cases จาก live: LPB200NL warranty → exact KB row ไม่ถึง final context; GS3/GS3 Ultra → S3 substitution; Actor GPS → `spec_claim` rewrite; PB150S troubleshooting → admin wording โดยไม่มี handoff และ prose cards แต่ `products=[]`
- รวม tokens/cost ต้องนับ intent+answer: 6 calls = 114,140 tokens, estimated $0.0381822; response top-level ต่ำกว่านี้เพราะนับ answer อย่างเดียว
- **Gate:** อธิบายได้ว่าแต่ละเคสเสียที่ stage ใด โดยไม่แก้ code; canary รอบนี้ชี้ failure ที่ retrieval/selection/evidence/output boundary ได้บางส่วน แต่ F12 provenance, cross-shop live leakage, image/history และ end-to-end handoff transport ยังไม่ปิด

### Stage 1 — P0: handoff ที่ตรงกับสิ่งที่บอกลูกค้า

- ปรับ contract ใน typed intent/claim flow เดิมและ general-answer routing ที่มีอยู่
- Test pair: “สินค้าไหม้ประกันไหม” ต้องไม่วินิจฉัยเกินหลักฐานและต้องสร้าง handoff ที่มี persisted queued/assigned outcome; “ประกันกี่ปี” ยังคงเป็น FAQ; เมื่อ handoff fail ห้ามบอกว่าส่งแล้ว
- **Gate:** final ChatResponse และ admin queue/log ยืนยันผลเดียวกัน

### Stage 1A — P0: บังคับข้อห้ามราคาในทุกคำตอบ

- แยกข้อกำหนดว่าราคาห้ามเฉพาะ prose หรือรวม product cards; trace ทุก renderer/model-context path ที่ปล่อยราคา
- ปรับเฉพาะ existing answer-context/composition owner; mechanism delta ต้องเป็น +0 helper/guard/regex/keyword/heuristic/owner
- Test ทั้ง direct price question, recommendation, multi-need, product card, valid composition marker และ fallback reply; assertion ตรวจ `ChatResponse.answer` และ fields ที่ frontend แสดงจริง
- **Gate:** ไม่มีราคาหลุดในช่องทางที่ผู้ใช้ห้าม และคำตอบ/การ์ดที่ไม่เกี่ยวยังคงครบ

### Stage 2 — P0: ร้าน/แพลตฟอร์มเป็นขอบเขตก่อนใช้ข้อมูล

- แก้ existing exact-item lookup และ shipping-policy query ให้ scope ตั้งแต่ Mongo query; ระบุ global/shared policy ด้วย provenance ชัด
- Test สองร้านที่ใช้ item ID/สินค้า/นโยบายคนละชุด; miss ในร้าน A ต้องไม่คืน record ของ B; shared policy ใช้ได้เฉพาะ record ที่ประกาศ shared จริง
- **Gate:** ไม่มี foreign product/policy ถึง pool, prompt หรือคำตอบ

### Stage 3 — P1: แยกรุ่น, สี และ fact ที่ถาม

- Trace T01/T08 ตั้งแต่ profile → fetch → ranking → join → availability → selector → context
- Test BP35S: stock ชมพู 50, เขียว 30, swing 120°; GS3/GS3 Ultra: แยกสองรุ่นและสีที่มี stock โดยไม่แทนด้วย S3
- **Gate:** ทุกคำตอบผูกกับ identity/variant และ source freshness ที่ตรวจได้; unknown ไม่ถูกแปลว่า sold out

### Stage 4 — P1: ข้อมูลสินค้าเข้าช่อง typed evidence

- ใช้ T07 เป็น regression; ระบุ source authority และ `FieldEvidence` ที่ส่งเข้า guard owner เดิม
- **Gate:** numeric/spec claim ผ่านเมื่อ evidence ตรง identity; เมื่อไม่มี evidence ยังคงถูกปฏิเสธ

### Stage 5 — P1: ปิด Zaapi retrieval และ provenance gap

- วัด `zaapi_search` hit, scope, score, selection และ final-context inclusion สำหรับ FAQ/product questions แยกกัน
- ทำ need-kind × record-kind acceptance โดยเฉพาะ product/spec rows ที่อาจช่วยตอบ troubleshooting; ระบุ data ที่ขาดแยกจาก row ที่ค้นไม่เข้า
- คงแต่ละ source row และที่มาใน answer context; เพิ่ม acceptance สำหรับข้อมูลขัดกันและ unrelated top hit
- **Gate:** hit ที่ถูกต้องของร้าน/รุ่นเข้าถึง answer owner พร้อมที่มา; ไม่มี inactive/foreign record; ทราบสาเหตุทุก `ch:kb selected=0`

### Stage 6 — P2: troubleshooting และความกระชับ

- ทดสอบ troubleshooting ตาม device/model ก่อน; ปรับ prompt owner เดิมให้มีคำสั่งเดียวเรื่องความยาว
- **Gate:** คำแนะนำตรงอุปกรณ์และหลักฐาน; ตอบคำถามก่อน ไม่ยืดหรือแนะนำสินค้าอื่นโดยไม่จำเป็น

### Stage 7 — End-to-end QA และ activation decision

- Preliminary bounded QA 6 requests ทำแล้วผ่าน `/chat` ตรงตามขอบเขตที่อนุมัติ (§7.7); ขั้นต่อไปคือขยาย multi-shop/full-conversation และ Shadow QA เมื่อเปิด shadow โดยอนุมัติ พร้อมเก็บ history/images เฉพาะเมื่ออนุมัติ scope นั้น
- เทียบทุกคำตอบกับ source จริงทีละ fact; สุ่มตรวจโดยมนุษย์; no customer send; หยุดเมื่อมี wrong-shop fact, false stock, unsupported claim หรือ false handoff
- Duplicate/census และ image/history ต้องมีผลแยก ไม่ถือว่าผ่านเพราะ HTTP 200
- **Gate:** quality report ผ่านเกณฑ์ข้อเท็จจริง, relevance, coverage, shop isolation, handoff, brevity, cost/latency; จึงเสนอ activation แยกต่างหาก

## 5. ข้อห้ามและเกณฑ์ review ของทุก correction

- เปลี่ยนทีละ owner ตาม root cause พร้อม RED ก่อน GREEN หลัง; ไม่แก้ test ให้เข้ากับ behavior ผิด
- รายงาน helpers / guards / regex / keyword tables / heuristics / decision owners ก่อนและหลัง; เป้าของแผนนี้คือ **+0 ทุกหมวด**
- ไม่ยกเลิก evidence guard เพื่อให้คำตอบดูผ่าน และไม่ใช้ prompt แทน shop scope หรือ source attribution
- อัปเดต `docs/SRS_SSD.md` ทุกครั้งที่แก้/เพิ่ม/ลบฟังก์ชันใน `chatbot/shopeechat/`
- ก่อนแตะ production code ต้องส่ง root-cause plan, ผลกระทบ, test cases และ manifest ให้ผู้ใช้อนุมัติตาม `AGENTS.md` §9

## 6. สถานะหลักฐานและไฟล์อ้างอิง

- Live API evidence: synthetic “ถ้าสินค้าไหม้ประกันไหม”, request `d4c9f4cd-6bc`, HTTP 200, 23.28s; response usage 1,236 tokens / estimated $0.000419; `ai_usage` intent+answer 6,107 tokens / estimated $0.0022809. ไม่มีข้อความลูกค้าจริงถูกส่ง
- ผล bounded QA ล่าสุด: เพิ่มอีก 6 synthetic `/chat` calls ภายใต้ grouped selection ที่ยืนยันว่าเปิด; wrong-model, evidence miss, false admin wording และ usage/cost discrepancy บันทึกใน §7.7 และ raw findings §13.8
- Product/Mongo evidence: QA50/QA12 และ A-176–A-184; stock เป็นค่าจาก ShpProducts sync ณ เวลา query ไม่ใช่ live Shopee storefront
- ไม่มี source/test/config edit ในงานจัดทำเอกสารนี้; implementation ยังรอ approval; active ledger coverage ยัง partial

## 7. Follow-up audit — fixed-answer routes and Zaapi Mongo evidence (2026-11-11)

### 7.1 คำตอบแบบคงที่กับคำตอบจาก LLM

คำตอบที่พบแบ่งเป็นสามแบบ และไม่ควรเหมารวมว่าเป็น hardcode ทั้งระบบ:

| กลุ่ม | owner / trigger | ผลที่ออก |
|---|---|---|
| Static action reply | `app.chat` ใช้ `TurnPlan.primary_action`: `greeting`, `no_reply`, `clarify`, `human_wait`, `handoff` ก่อน retrieval (`app.py:1671-1738`) | ทักทาย/ถามชื่อสินค้า/ไม่ตอบ/แจ้งรอหรือส่งต่อ โดยไม่เรียก answer LLM |
| Typed deterministic/template | policy outcome; compat/no-match/unanswered; warranty claim/date; order/address/return; handoff transport (`guards.py:90`, `answer_context.py:2059-2145`, `warranty_flow.py:740-1120`, `order_flow.py:20-650`, `handoffs.py:309-430`) | ข้อความมาจาก outcome, product identity, claim/order state, วันที่หรือข้อมูล KB; รูปประโยคซ้ำได้ แต่บางส่วนเติมข้อมูลจริง |
| LLM-generated | product/general/บางคำถาม order และ KB หลัง context assembly (`knowledge_base.py:362-392,470-514`, `app.py` answer paths) | โมเดลเขียนคำตอบจาก prompt/context; ตัว KB search ส่ง evidence ไม่ได้เป็นตัว render คำตอบสุดท้ายเอง |

ตัวอย่าง trigger ที่ตรวจจาก owner: `no_reply` มาจาก placeholder/noise; `clarify` เมื่อยังเลือก subject ไม่ได้; `greeting` เป็น social turn; `human_wait` เมื่อ ticket/claim ถูกส่งต่อแล้ว; `handoff` เมื่อ TurnPlan ขอคนหรือพบ frustration. ถ้าไม่มี conversation id หรือ transport ไม่ยืนยัน queued/assigned จะใช้ `HANDOFF_FAILED_REPLY` (`responses.py:37`) แทนการอ้างว่าส่งสำเร็จ. Return policy ที่เป็น `eligible/ineligible` render จาก typed outcome; `unknown/admin_review` ใช้ handoff. First claim จะขอวันซื้อ/เลข order/รูปหรือวิดีโอ; `malfunction_safe_check` เพิ่ม checklist เมื่อข้อความเข้ากลุ่มอาการเสีย (`warranty.py:471`). Guard rewrite แทนคำอ้าง promo/คืน/stock/model/spec เมื่อไม่มีหลักฐาน (`guards.py:98+`, `:553+`).

พบถ้อยคำกลางที่ใช้ซ้ำจริง เช่น handoff failure, ขอเลขคำสั่งซื้อ, cannot-confirm และประโยค policy; การซ้ำของ wording นี้ไม่ได้แปลว่าคำตอบทุกชนิดถูกกำหนดตายตัว. ประเด็นที่ต้องจับตาคือคำตอบจาก LLM อาจพูดถึงแอดมินเองโดยไม่มี handoff: ledger A-184 มี synthetic `/chat` case ที่ `routing=bot_reply` และ `handoff_to_admin=false` แต่คำตอบบอกให้ทักแอดมิน; เป็นหลักฐานรอบก่อนและไม่ได้ยิงซ้ำใน audit นี้.

### 7.2 Mongo และ retrieval probes (อ่านอย่างเดียว)

- Mongo มี registry 118 ไฟล์และ active rows 7,101; config ขณะตรวจเลือก `kb_source=zaapi`, grouped retrieval เปิด, shadow ปิด และ pool sources `kb`, `mongo_catalog`, `units`, `image_text` เปิด.
- KingGadgets: คำถามระบุ `CUKTECH LPB200NL` เรื่องประกันคืนแถวจริงจากไฟล์ประกัน คำตอบใน record คือ 1 ปี; top score .8249. ผลลำดับรองมี `LPB200NC` ซึ่งเป็นรุ่นใกล้กัน ต้องตรวจการผูก model ที่ขั้น attribution/final context ต่อ.
- Troubleshooting: แถว `CUKTECH PB150S` ใน Mongo มีสเปกพอร์ต/กำลังไฟ/ประกันและวิธีตรวจสายกับหัวชาร์จ รวมถึงเกณฑ์หยุดใช้/ส่งต่อ. Query กว้าง `หัวชาร์จ ชาร์จไม่เข้า วิธีแก้` คืนแถวถามกลับว่าหมายถึงอุปกรณ์ชนิดใด แทนขั้นตอนเฉพาะ PB150S. นี่แสดง data-exists + retrieval-query mismatch สำหรับ probe นี้; ยังไม่ใช่หลักฐาน final Gemini answer.
- Query กว้างเรื่องรับประกัน/เปลี่ยนคืนคืนผล registration, address change และ warranty ของสินค้าอื่นปะปน. ใน shop scope ที่ตรวจมี 823 candidates ก่อน cosine rerank; `zaapi_search` embed candidates ทั้งหมดที่ผ่าน prefilter ก่อนตัด top-K. Latency/recall ยังไม่ได้ benchmark.
- ยังไม่ได้ทำ duplicate-content census ครบ corpus หรือ live replay ของทุก account; ห้ามสรุปว่าไม่มีข้อมูลซ้ำ.

### 7.3 Test evidence และข้อจำกัด

- Owner battery 9 ไฟล์: run แรก 406 passed, 1 skipped, 1 xfailed และ 1 failed. Failure ที่ `test_return_policy_context_excludes_description_scrape` เป็น monkeypatch `get_general_faq` ที่ไม่รับ `shop/platform` ซึ่ง production ส่งเป็น keyword args; ยังไม่มี baseline run ยืนยันว่าเป็น pre-existing.
- Rerun เมื่อตัดเฉพาะ test fixture mismatch: 406 passed, 1 skipped, 1 xfailed, 1 deselected. Zaapi-serving targeted selection: 22 passed, 30 deselected.
- Full `test_zaapi_kb_files.py` ยังไม่จบ: run ปกติค้างที่ HF Hub/model loading และถูก interrupt หลัง 11 pass; offline run ค้างอีกครั้งหลัง 27 pass. ไม่นับเป็น full-suite pass.
- Gemini final-answer probe ที่ใช้ context จริงจาก Mongo ไม่ได้รัน: automatic approval review ปฏิเสธคำสั่งเพราะจะส่งข้อมูล Zaapi จาก Mongo ไปยัง Gemini ซึ่งเป็นบริการภายนอกที่ไม่ใช่ trusted destination. ไม่มี Gemini request จาก probe นี้, ไม่มี Mongo write และไม่มี customer send.

### 7.4 Follow-up symptom ที่ผู้ใช้รายงาน — ยังไม่ reproduce

ผู้ใช้ชี้แจงอาการให้แคบลง: เมื่อข้อมูลสเปกไม่มี บอทตอบว่า **“ไม่พบข้อมูล” แล้วส่งต่อแอดมิน**. จัดเป็น **user-reported, not reproduced in this audit** จนกว่าจะมี exact question/answer, product identity และ response trace.

Source paths ที่อาจเกี่ยวข้อง แต่ยังไม่มีหลักฐานว่าเคสนี้เข้า path ใด:

- `compile_answer_context` ทำเครื่องหมาย `no_selection`/`no_evidence`; `_unanswered_segment` render “ไม่พบข้อมูลในระบบของร้าน” หรือ “ไม่มีข้อมูลยืนยัน…” (`answer_context.py:2101-2171`). Segment นี้อย่างเดียวไม่ได้พิสูจน์ว่ามี admin handoff.
- `guards.enforce` อาจส่ง handoff เมื่อ typed constraint ไม่มีสินค้าผ่าน (`guards.py:523-530`), หรือเมื่อคำตอบมีถ้อยคำอ้างว่าจะส่งต่อแอดมินและยังไม่มี handoff (`guards.py:388-406,690-715`). ถ้า transport ไม่สำเร็จ จะเปลี่ยนเป็น `HANDOFF_FAILED_REPLY`.
- อีกทางคือ `TurnPlan` หรือ typed policy owner เลือก handoff ก่อน/หลัง retrieval (`app.py:1671-1738,2094-2129`).

การตรวจเคสจริงครั้งถัดไปต้องเก็บ `source`, `routing_decision`, `handoff_to_admin`, `handoff_reason`, `unanswered_needs`, selected evidence และ handoff API outcome ใน request เดียว เพื่อแยกว่าเป็น (1) field ไม่มีใน source, (2) retrieval ไม่เลือกแถว, (3) evidence ไม่ถึง subject/need, (4) no-match constraint สั่ง handoff, หรือ (5) LLM พูดถึงแอดมินแล้ว guard ส่ง handoff. ห้ามสรุปว่า “ไม่พบข้อมูล” หมายถึงไม่มีข้อมูลจริง และห้ามลด guard/เพิ่มคำตอบคงที่ก่อนระบุ owner ที่ทำให้เกิดผลนี้.

### 7.5 สรุปสถานะ ณ audit รอบเดิม

โค้ดมี static replies และ typed templates หลายจุด; คำตอบสินค้า/ทั่วไปจำนวนมากยังมาจาก LLM. Mongo probe ยืนยันว่ามี record ที่ตอบตรงได้และมี query กว้างที่ค้น noisy. ยังไม่มี Gemini final-answer comparison บนข้อมูลร้านจริง, benchmark retrieval, duplicate census ครบ corpus หรือ repro ของอาการสเปกหายตามข้อ 7.4. การ audit รอบนี้ไม่เปลี่ยน production/test/config/DB; implementation ยังรอแผน root-cause และ approval ตาม `AGENTS.md` §9.

### 7.6 Audit continuation — historical snapshot (2026-11-11; superseded by §7.7)

- Persisted runtime config: `kb_source=zaapi`; all four `pool_sources` true; **grouped selection=false**, shadow=false. This does not satisfy the user's requested QA mode. Config was not changed. `prompt_modular` remains unverified: a read-only retry failed at DNS resolution; do not claim it is enabled.
- Mongo snapshot: 118 registry files, 7,101 active rows, 0 manual, 8,600 legacy/unmigrated. PB150S product/spec/stock rows exist; no active CukTech troubleshooting row was found in the scoped files checked. A `troubleshooting`-only retrieval returned 0 hits. This is a source-kind/need-kind mismatch candidate, not yet a reproduced final-answer defect.
- Local Zaapi query for LPB200NL warranty found exact 1-year row at score .8249, with near-model LPB200NC/LPB200N also ranked. First call 25.185s included cold local embedding load; no steady-state latency conclusion.
- Current ShpProducts snapshot: BP35S is NORMAL and available, stock 80 (pink 50, green 30, white 0), description says 120° swing; GS3 family total 1,393. Values are synced database snapshots, not live storefront inventory.
- Price prohibition is not enforced at the output boundary found: `price` enters model context and valid composition tests preserve a price-bearing answer verbatim. Add F10 and P0 Stage 1A above.
- Offline suites rerun: 132 passed; second batch 212 passed / 1 failed. The lone failure is a test double `lambda topic` that rejects production caller keyword `shop`; the test did not reach its behavior assertion. No clean-HEAD run was performed, so do not label it pre-existing.
- GET `/health` and `/shops` succeeded (33 shops; 29 categories). Direct authenticated `/chat` with Mongo-derived product context was **rejected by automatic approval review** because it could transmit that data to external Gemini. No provider request, final-answer QA, provider tokens/cost, Mongo write, or customer send occurred. Do not retry through another route; obtain an accepted egress boundary before provider QA.
- No code/config/data change; only audit docs/log/ledger. Live final-answer quality claims remain open until the correct grouped-selection mode and an approved provider boundary are available.

### 7.7 Audit continuation — approved bounded live API QA (2026-11-11)

- ผู้ใช้อนุมัติเปิด grouped selection ชั่วคราวและอนุมัติ Gemini egress แบบจำกัด. ตรวจ Mongo ซ้ำแล้วพบค่าที่ขอเปิดอยู่แล้ว (`kb_source=zaapi`, pool sources 4/4 true, grouped=true, `prompt_modular=true`, shadow=false); **ไม่ได้เขียน/เปลี่ยน config**. Request trace มี `GroupedRetrievalSelection`.
- ยิง `/chat` โดยตรง 6 ครั้ง: KingGadgets warranty query ซ้ำ 3 ครั้ง; CukTech PB150S troubleshooting 1; BlackShark GS3/GS3 Ultra stock/colors 1; Kieslect Actor GPS 1. ทุกครั้ง HTTP 200, de-identified prompt, `history=[]`, `images=[]`, ไม่มี conversation ID, handoff simulation, ไม่มี customer send.
- ผลสำคัญ: KingGadgets ตอบซ้ำว่าให้ตรวจสอบ ทั้งที่ local Zaapi search มี exact LPB200NL 1-year warranty row; selector trace เลือก CTC315P description และ final context ไม่มี exact row. CukTech ตอบ checklist/spec เพิ่ม, พูดถึงแอดมินแต่ `handoff=false`, ใส่ product-card prose 2 ใบทั้งที่ `products=[]`, มี URL นอก Shopee domain และคำว่า “abubu” ที่ยังไม่มี provenance. BlackShark ถาม GS3/GS3 Ultra แต่ได้ S3 Special Edition. Kieslect Actor มี GPS ใน ShpProducts title/candidate แต่ typed evidence ว่างและ guard rewrite เป็น cannot-confirm. รายละเอียด/request IDs อยู่ใน raw findings §13.8.
- Accounting: 114,140 total tokens / `$0.0381822` `ai_usage` estimated cost / 198.94s รวม wall time. Top-level response นับ answer-only 84,829 tokens / `$0.0269007`; intent 29,311 tokens ถูกละไว้. Cost rate ของ intent กับ `_gemini_cost` ไม่ตรงกัน. ไม่ใช่ใบแจ้งหนี้ provider; ค่าประมาณจาก `ai_usage`.
- Slow path: KingGadgets answer step 31.889s เทียบ provider elapsed 4.047s; code มี `_acquire` ก่อน provider timer และอาจรอ quota, แต่ exact wait ยังไม่วัด. BlackShark/Kieslect intent provider elapsed ราว 15s. ต้องแยก queue/quota wait และ provider time ก่อนระบุสาเหตุ latency ทั้งหมด.
- Verification: offline battery 132 passed; second batch 212 passed / 1 failed ที่ test double ปฏิเสธ caller kwargs `shop/platform` ก่อน assertion. ยังไม่ทดสอบบน clean HEAD จึงไม่จัดเป็น pre-existing. `health`/`shops` ผ่านก่อนหน้า; no code/test/config/Mongo/Product DB writes, no customer messages. Gemini calls เกิดเฉพาะตาม bounded approval.
- ขอบเขตที่ยังเปิด: shadow comparison ไม่ได้รัน, ไม่มี full history/image turns, ไม่ได้ทดสอบ handoff transport สำเร็จจริง, ไม่มี cross-shop leak reproduction live, ไม่มีครบทุกสาขา/33 ร้าน, ไม่มี clean-HEAD test baseline และไม่มี full duplicate census.
- **สถานะ:** QA ยืนยันปัญหาคุณภาพหลายข้อใน selector/evidence/answer/handoff-output และ telemetry. นี่เป็น diagnosis evidence ไม่ใช่ implementation หรือ production-readiness. การแก้ code ยังต้องแยก root-cause plan และขออนุมัติตาม AGENTS.md §9.
