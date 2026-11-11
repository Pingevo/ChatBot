# แผนงานคงเหลือ — ค้นจาก units เทียบ stock กับ Shopee Mongo

วันที่: 2026-11-11 (Asia/Bangkok)  
สถานะ: roadmap ที่ผู้ใช้เห็นชอบในแชท; แต่ละงานแก้โค้ดต้องมี audit/root cause และแผนย่อยให้อนุมัติตาม `AGENTS.md` §9

## ข้อตกลงเรื่องแหล่งข้อมูล

| คำถาม | แหล่งตัดสิน | ข้อกำหนด |
| --- | --- | --- |
| ค้นหาสินค้าและระบุรุ่นย่อย | **units และ Shopee Mongo** | units ระบุ unit/generation; Mongo catalog เป็นอีกทางค้นหา; ผูก `item_id`/`model_id`/ร้านให้ถูกก่อนเทียบข้อมูล |
| หลักฐาน stock/status ของ unit/รุ่นย่อย | **units snapshot + Shopee Mongo (`ShpProducts`)** | ทั้งคู่มีข้อมูล stock ได้: ถ้า join listing/model ที่ตรงได้ โค้ดใช้ stock/status จาก Mongo; ถ้า join ไม่ได้ โค้ด fallback ไป snapshot ใน units ซึ่งไม่ยืนยันว่าเป็น stock ปัจจุบัน; stock ที่ Mongo เองก็ใหม่เท่ารอบ sync ของแหล่งนั้น |
| สเปก คำอธิบาย FAQ โปรโมชัน และข้อเท็จจริงอื่นเกี่ยวกับสินค้า | **Zaapi KB และ Shopee Mongo** | เลือกหลักฐานให้ตรงสินค้า/ร้าน; ข้อความ KB ไม่ใช้ตัดสิน stock |
| คำตอบสุดท้าย | หลักฐานข้างต้นพร้อม provenance ใน trace | แยก stock ที่ตรวจจาก Mongo, stock snapshot ใน units และ stock ที่ยังไม่ทราบ; ตอบคุณสมบัติตามหลักฐานที่ตรงรุ่น |

จุดที่ต้อง audit ก่อนแก้: `fetch_units(sellable_only=True)` กรองตาม snapshot ได้ แต่ grouped `fetch_unit_evidence` ไม่เปิดตัวกรองนี้โดยปริยาย; ยังมีการจัดอันดับ/ตัดจำนวน candidate ด้วย snapshot ก่อน join ซึ่งอาจกระทบรุ่นที่ restock ต้อง reproduce แยก อีกจุดคือ card ที่ join แล้วอาจถูก downstream variant selection ตีความว่าไม่พร้อมขาย: QA50 T01 มี `_available_for_sale=true` และ stock 50 แต่ canonical `sellable=false`/`requested_variant_state=unknown`; T08 เลือกรุ่น S3 แทน GS3 ต้อง trace แยกตามเคส แก้ business behavior ใน typed owner เดิม ไม่เพิ่ม guard/keyword/regex เพื่อชดเชยข้อมูลที่ขัดกัน

`sellable_units_<gid>` เก็บ stock/status snapshot ณ เวลา build ส่วน ShpProducts มี stock/status ตามรอบ sync ของ Mongo; ตรวจทั้งสองโดยผูกสินค้า/รุ่นเดียวกัน บันทึกว่าใช้ค่าไหนและข้อมูลมีอายุเท่าไรเมื่อทราบ หาก Mongo join ไม่พบหรืออ่านไม่ได้ ให้ระบุว่าค่าจาก units เป็น snapshot ไม่เรียกว่า stock ปัจจุบันโดยไม่มีหลักฐานความสด แยก “ไม่ทราบ” ออกจาก “หมด”; ห้ามอนุมาน stock จากข้อความ KB

## ลำดับงานและเกณฑ์ปิด

### 0. ทำให้ QA วัดผลได้ — API timeout และ telemetry

- **ทำไม:** replay 12 บทสนทนาเริ่มได้ 5 เคส จบครบ 1 เคส; 4 เคส timeout ที่ 180 วินาที และ API 8010 เคยติดต่อไม่ได้ ขณะที่ยอด token/cost ใน response กับ step logs ไม่ตรงกัน (ledger A-166–A-169)
- **ทำอย่างไร:** ใช้คำถามเดียวเก็บเวลาของ request, retrieval, provider และ final response ตรวจว่า request ยังทำงานต่อหลัง client timeout หรือไม่ Reconcile usage ด้วย request ID และ provider attempt แยก retry/fallback กับ metadata ที่ไม่มี usage
- **ผ่านเมื่อ:** ระบุขั้นตอนที่ช้าและแก้ที่ owner นั้น; API พร้อมสำหรับ bounded replay; รายงานจำนวน request/attempt, token/cost และ unknown cost โดยไม่รวมซ้ำ

### 1. ค้นรุ่นให้ครบและเทียบ stock สองแหล่ง — QA50 stock

- **ทำไม:** QA50 พบ stock false-negative ซึ่งกระทบคำตอบลูกค้าและโอกาสขาย (A-166)
- **ทำอย่างไร:** เก็บ trace แยก T01 (พบ stock แต่ variant/คำตอบผิด) กับ T08 (ค้น/เลือกรุ่นผิด) จาก unit และ Mongo retrieval → ranking/limit → join → availability resolver → variant selection → final answer เทียบ `item_id`/`model_id`, stock/status และ provenance ของแต่ละแหล่ง ตรวจกรณี Mongo กับ units ตรงกัน/ขัดกัน, รุ่นที่ restock หลัง build, หลาย variant, stock ศูนย์/ไม่ทราบ, join ไม่สำเร็จ แล้วแก้สาเหตุที่ typed owner เดิม
- **ผ่านเมื่อ:** ค้นรุ่นที่มีหลักฐานตรงตัวได้ครบ; คำตอบพร้อมขายตรงกับ stock/status ของรุ่นเดียวกันและ trace ระบุแหล่ง/ความสดตามหลักฐาน; snapshot เก่าไม่ถูกอ้างเป็น stock ปัจจุบัน; unknown ไม่กลายเป็น “หมด” หรือ “มีขาย”; executable behavioral regression ครอบคลุมเส้นทางจริง

### 2. ให้หลักฐานสินค้าเข้าคำตอบตรงรุ่น — K3

- **ทำไม:** file-backed Zaapi adapter คืน rows แล้ว แต่ผลอันดับต้นบางเคสคนละสินค้า และ QA50 มี `ch:kb` 21 traces ที่เลือกศูนย์ (A-166/A-168)
- **ทำอย่างไร:** ไล่ query → Zaapi KB/Shopee Mongo candidates → product/shop identity → selection → final context → answer แยกสาเหตุ query, scope, ranking และ selection; ปรับ owner เดิมตามหลักฐาน ไม่เพิ่ม semantic keyword/regex โดยพลการ
- **ผ่านเมื่อ:** คำถามสเปก/FAQ/โปรโมชันได้หลักฐานตรงรุ่นและร้าน พร้อม attribution; คำตอบเรื่อง stock แยก provenance ของ units snapshot กับ ShpProducts และไม่ดึง stock จากข้อความ KB

### 3. ปิด QA คำตอบจริง — replay, S1 และ K5

- **ทำไม:** shadow replay บางชุดไม่มี assistant turns หรือ item/order anchors ทำให้ตัดสินคุณภาพไม่ได้; หนึ่งเคสที่จบเข้าสู่ invoice handoff ตั้งแต่ต้น จึงไม่พิสูจน์ KB (A-166/A-168)
- **ทำอย่างไร:** ตรวจ transcript ก่อนยิง ส่ง history/รูป/anchors ที่มีจริง เก็บ trace ทุก turn และเทียบคำตอบกับ source facts สำหรับ stock, compatibility, FAQ, โปรโมชัน และ handoff ระบุ `context-limited` เมื่อข้อมูลต้นทางไม่ครบ ใช้งบ provider ตาม gate ที่อนุมัติ
- **ผ่านเมื่อ:** 12 บทสนทนามีผลครบหรือมี gap ที่ระบุได้; เคส QA50 ที่เคย fail มีผลก่อน/หลัง; คำตอบผ่านเกณฑ์ข้อเท็จจริงและความตรงคำถาม ไม่ใช้ HTTP 200 เป็นเกณฑ์เดียว

### 4. ปิด handoff และขอบเขต approval — H4, R3, S8

- **ทำไม:** simulated handoff persist 13/13 แต่ assigned admin 0/13; ต้องยืนยันว่า “ส่งต่อแล้ว” หมายถึงเข้าคิวหรือมีผู้รับจริง (A-166)
- **ทำอย่างไร:** ตรวจ response → queue → assignment contract ก่อนแก้ข้อความหรือ flow; เก็บ live multi-bubble review/mock receipt; ตรวจ worker/workflow ทุกเส้นทางกับ approval boundary, concurrency, cost stop/manual watch และ stop/recovery ก่อนขยาย traffic
- **ผ่านเมื่อ:** ผล queue/assignment ตรงข้อความที่บอกลูกค้า; ไม่มีเส้นทางเปิดใช้งานที่ข้าม approval; canary มีหลักฐานตาม gate ที่อนุมัติ

### 5. ปิดข้อมูลและงานปฏิบัติการ — K0/K2/K4, R1, R4

- **K0/K2/K4:** reconcile census ที่ A-168 บันทึก 75/118 active กับตัวเลข 118/118 ที่ผู้ใช้รายงานภายหลัง โดยแยก total rows ออกจาก visible active rows และอธิบายยอด content type ที่ยังไม่ครบ; ทบทวน file-backed contract และระบุว่า canonical generation K4 ถูก supersede หรือคงเป็นงานอนาคต K1 เดิมถูกแทนด้วย file-backed snapshot importer แล้ว ไม่ทำซ้ำเพื่อปิด checklist
- **R1:** ยืนยันการรัน scheduler 09:00 จริงและ cleanup/retention ตาม policy โดยรักษา active กับ rollback generation; build/publish ผ่านแล้ว (A-145)
- **R4:** ให้เจ้าของ external Sellcenter writer แก้ contract ที่สร้างข้อมูลซ้ำก่อน แล้วจึงทำ census, cleanup/index และ rollback ในช่วงที่อนุมัติ
- **ผ่านเมื่อ:** แหล่งข้อมูลและจำนวน active ตรงกัน, contract ของ snapshot units กับ live ShpProducts รวมถึง fallback ชัด, scheduler/retention มีหลักฐานจริง และข้อมูลซ้ำไม่เกิดใหม่จาก writer เดิม

### 6. ขยายระบบหลังคำตอบหลักผ่าน — workflow, R2, R0

- **W0–W3:** ปิด browser evidence, Basic Automation/handle gap, real bindings, node trace และ scenario/persona migration; replay แต่ละ flow ก่อนเปิดใช้
- **W4–W5:** เพิ่ม adapter/ชนิด node เฉพาะ capability ที่มีเจ้าของและทดสอบได้ พร้อม canary ภายใต้ H4
- **R2:** รับ structured policy records จากเจ้าของข้อมูลจริง ตรวจ provenance/scope/schema ก่อนเปิดใช้
- **R0:** หลัง retrieval/answer QA ผ่าน วัด prompt, latency, provider usage/cost และความถูกต้องก่อน/หลังลดส่วนซ้ำ
- **ผ่านเมื่อ:** workflow ไม่ทำ side effect ซ้ำและตรวจย้อนหลังได้, policy ตอบจาก record ที่พิสูจน์ได้, prompt สั้นลงโดยไม่ทำให้คำตอบถอยหลัง

## งานสนับสนุนและจุดเริ่ม

- **S3:** เติม active-log semantic gaps และ independent review เป็นช่วงย่อย; checksum ที่ตรงไม่เท่ากับ coverage ครบ
- **Mobile UX Phase 1:** ทำตามแผนที่อนุมัติเมื่อมี owner พร้อม; งานคำตอบลูกค้าข้างต้นมีลำดับก่อนใน roadmap นี้
- **เริ่มงาน:** ปิดงาน 0 ด้วย trace ที่ชี้จุด timeout ได้ แล้ว audit งาน 1 ด้วยเคส stock ที่มี unit identity ชัดเจน ก่อนเสนอ code change

สถานะราย task และหลักฐานย้อนหลังอยู่ใน [remaining-work register](2026-11-06-remaining-work-register.md) และ [waythrough ledger](../../waythrough-ledger.md) แผนนี้เป็น roadmap; การแก้แต่ละปัญหาต้องวิเคราะห์ root cause, ผลกระทบ และ regression locks ก่อนลงมือ
