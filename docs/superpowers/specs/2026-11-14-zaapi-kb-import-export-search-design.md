# Zaapi KB: import, export และค้นหาข้อมูลแบบเปิด

วันที่: 2026-11-14 · สถานะ: รอผู้ใช้ตรวจสเปก · ขอบเขต: Zaapi KB เท่านั้น

## เป้าหมายและหลักฐาน

นำ raw Zaapi 118 ไฟล์กลับมาใช้เป็นหลักฐานตอบลูกค้า โดยรักษาขอบเขตร้านที่ผู้ใช้ตรวจและแมปแล้ว ค้นหาได้ทั้งข้อมูลสินค้า การรับประกัน การแก้ปัญหา โปรโมชั่น และเนื้อหาชนิดอื่นโดยไม่ต้องอยู่ในชุดหมวดตายตัว เก็บ raw ต้นฉบับแยกจากข้อมูลที่ค่อย ๆ สกัดได้; แบรนด์ รุ่น ชื่อบนหน้าร้าน และ FAQ เป็น optional และทุกค่าที่สกัดต้องย้อนกลับไปยังไฟล์ ชีต แถว คอลัมน์หรือช่วงข้อความต้นฉบับได้ การนำเข้าหนึ่งชุดต้องตรวจสอบและย้อนกลับได้ การส่งออกต้องนำไปตรวจหรือ re-import ได้ และการถามหนึ่งครั้งต้องไม่ embed แถว KB ซ้ำ

หลักฐาน ณ วันที่เขียน: raw มี 113 XLSX/114 ชีต/8,595 แถวข้อมูล และ 5 TXT; พบ 65 รูปแบบหัวตารางและราว 400 ชื่อหัวคอลัมน์ (จำนวนหัวคอลัมน์ไม่ใช่จำนวนหมวด) มีเนื้อหาผสมในไฟล์หรือชีตเดียวกัน ปัจจุบัน `kb_zaapi_files.py` เก็บแถวตามต้นฉบับ แต่ชนิดเนื้อหาจำกัด 4 ค่าในระดับไฟล์/ชีต; `zaapi_search` embed query และทุกแถวที่ผ่าน prefilter ทุก request. การวัด A-286 พบหนึ่ง request ใช้ 806.188 วินาทีใน `embed_texts` สำหรับ 824 แถว ขณะ LLM ใช้ 10.930 วินาทีใน request เดียวกัน; ตัวเลขนั้นวัดบน Mac ไม่ใช่ server i9. การล้าง Mongo A-297 ทำให้หก collection Zaapi KB ว่างอยู่ และ `kb_source=zaapi` ยังเปิด จึงยังไม่มี Zaapi evidence จนกว่าจะ import/publish ใหม่

JSON mapping ที่ผู้ใช้ตรวจแล้วคือ `docs/test/results/zaapi-kb-shop-mapping-validated-2026-11-14.json` (SHA-256 `1fd487a5d1e1613d5f6b4b3018f074bb1b6cbe323aa159d6fd02097c41367598`): เลือก 103 ไฟล์, 693 คู่ไฟล์→ร้าน, 60 ร้านปลายทาง; อีก 15 ไฟล์ยังไม่แมปและต้องไม่เปิดให้ bot ใช้ คู่ข้ามแพลตฟอร์มในไฟล์ 009 จำนวน 46 และ 073 จำนวน 1 เป็นการเลือกของผู้ใช้ มิใช่ผลอนุมานจากชื่อไฟล์

## ทางเลือกและเหตุผล

| ทางเลือก | ผล | ข้อจำกัด |
| --- | --- | --- |
| ขยาย 4 หมวดเป็น 5 หรือชุดคงที่ | แก้ UI ง่าย | ข้อมูลอื่นและแถวผสมตกหล่น; ต้องแก้โค้ดทุกครั้งที่เจอหัวข้อใหม่ |
| เก็บทั้งแถวและค้นด้วยข้อความอย่างเดียว | ไม่ต้องสร้าง vector | ความหมายใกล้กันแต่ใช้คำต่างกันอาจไม่พบ; A-289 synthetic control แสดงตัวอย่างที่ lexical top-5 พลาด |
| **แนะนำ: raw + หน่วยค้นแบบเปิด + lexical/vector ที่เตรียมล่วงหน้า** | รักษาต้นฉบับและ semantic recall โดยไม่ embed แถวซ้ำตอนถาม | ต้องมี build/publish และชุดทดสอบความเกี่ยวข้องก่อนเปิดใช้ |

เลือกทางที่สามตามแบบที่ผู้ใช้ยืนยันในบทสนทนา ไม่ใช้ LLM ตีความ/เขียน raw ใหม่ระหว่าง import หรือ runtime

## ขอบเขตข้อมูลและสัญญา

1. **Source identity:** ใช้ `source_id` จาก `knowledge-sources.json`, SHA-256 ของไฟล์จริง และชื่อไฟล์เดิมเป็น provenance. ชื่อไฟล์ไม่ใช่ตัวตัดสินร้าน หมวด หรือสินค้า. เก็บ bytes ของไฟล์ต้นฉบับไว้สำหรับ export ที่ตรง SHA; เก็บ parsed rows แยกเพื่อค้นและตรวจสอบ. TXT มีตำแหน่งเป็นช่วงข้อความแทนชีต/แถว
2. **Shop scope:** mapping JSON ระบุ `source_id → shop key` รูป `platform|shop_id`. Import ตรวจ version, source/shop snapshot hashes, ความครบของไฟล์, จำนวนที่เลือก, ID ซ้ำ/แปลกปลอม และ shop key กับทะเบียนร้านปัจจุบัน. หากทะเบียนร้านเปลี่ยนจน key ใช้ไม่ได้ ให้หยุด publish แล้วรายงานรายการที่ต้อง review; ไม่จับคู่ชื่ออัตโนมัติ. 15 ไฟล์ไม่มี mapping เก็บเป็น raw ที่ไม่เสิร์ฟ; 47 คู่ข้ามแพลตฟอร์มเก็บเป็น manual override พร้อม provenance ของ export. ห้ามตีความ mapping ระดับไฟล์ว่าเป็น scope เฉพาะแถวเมื่อ raw ไม่ระบุเช่นนั้น
3. **Raw row:** เก็บ `source_id`, `source_file`, `file_sha256`, `sheet`, `source_row`, `row_index`, `cells: [{column_index, header, value}]` และ `text` ตามต้นฉบับ พร้อม generation/revision. หัวคอลัมน์คือ key ที่ไฟล์ให้มา แต่ไม่ใช่ key ที่ unique เสมอ: ตรวจพบชื่อหัวคอลัมน์ซ้ำ 4 จุดใน raw ดังนั้น `column_index` ต้องอยู่คู่กับ header เพื่อไม่ทำค่า cell หาย. `fields` แบบ dict เดิมเป็น compatibility view เท่านั้น ไม่ใช่ raw authority. แถวที่ไม่มีหัวคอลัมน์หรือข้อมูล parse ไม่ได้ต้องปรากฏใน preview/warnings; ห้ามทิ้งโดยไม่รายงาน. ไม่มีการเขียน Product DB (`dbWallet`)
4. **Extracted data:** เก็บ projection แยกจาก raw เช่น `brand`, `model_name`, `storefront_title`, `faq_pairs` เฉพาะค่าที่สกัดได้จาก layout/cell ที่ตรวจแล้ว; ทุก field มี `source_row_id`, `column_index` และถ้าอยู่ภายใน cell ให้มี text span/offset. ฟิลด์ใดไม่มีในไฟล์ให้เว้นว่าง/ไม่สร้าง ไม่เติมจากชื่อไฟล์หรือชื่อร้านด้วยการเดา. หนึ่งแถวอาจมีหลายเรื่องและหลาย FAQ; ไม่บังคับหนึ่งแถว = หนึ่งสินค้า/หนึ่งหมวด. เพิ่ม extractor สำหรับรูปแบบไฟล์ใหม่ทีละแบบพร้อม fixture และผลตรวจ; การสกัดรอบใหม่สร้าง revision ของ projection โดย raw bytes/rows เดิมไม่เปลี่ยน. ถ้าแยก Q/A อย่างมั่นใจไม่ได้ ให้เก็บข้อความ FAQ เดิมและยังค้นได้ โดยไม่สร้างคู่คำถาม–คำตอบเทียม

   ตัวอย่างจาก raw จริง: ไฟล์ 017 แถว Excel 71 มี `ชื่อสินค้า = Black Shark ROKAS 5...`, `รายละเอียดสินค้า = ชื่อบนหน้าร้าน: Black Shark Rokas 5...` และ cell `คำถามที่พบบ่อยเกี่ยวกับสินค้า` ที่มี `Q:`/`A:` อยู่ด้วยกัน. ไฟล์ 013 แถว 12 ใช้ `ชื่อแบรนด์`, `คำถามเกี่ยวสินค้า`, `คำตอบเกี่ยวกับสินค้า` คนละคอลัมน์และไม่มี `รุ่นสินค้า` ในแถวนั้น. ชื่อ `brand`, `Name`, `ProductNameOnShop`, `faq` ที่ผู้ใช้ยกเป็นรูปแบบ projection ที่ทำได้ มิใช่หัวคอลัมน์ที่พบตรงตัวในชุด raw นี้
5. **Search unit:** สร้างหนึ่งหน่วยต่อแถวข้อมูลและต่อ TXT chunk ที่มี offset อ้างต้นฉบับ; ถ้าแถวยาวเกินขนาด input model ให้แตกตามขอบคอลัมน์/ข้อความแบบ deterministic และเก็บ parent row เดียวกัน. แต่ละหน่วยมี ID คงที่จาก source SHA + ตำแหน่ง + ลำดับ chunk, ข้อความสำหรับค้น, `source_row_id`, shop scope, และ vector พร้อม model identity/dimension. การแตกแถวไม่เปลี่ยนค่า raw หรืออ้างว่า cell ไหนเป็นคำถาม/คำตอบด้วยการเดาคำ. คอลัมน์ Q/A ที่อยู่แถวเดียวกันยังอยู่ร่วมใน row evidence ที่ส่งให้ bot. การค้น raw ใช้ได้แม้ projection ยังไม่ครบ
6. **หัวข้อ:** `tags: string[]` เป็น metadata เสริมหลายค่าและเพิ่มได้; ว่างได้. ผู้ใช้หรือ pipeline กำหนด explicit tags จากข้อมูลที่ตรวจแล้วเท่านั้น; parser ไม่เดาหมวดจากชื่อไฟล์/หัวคอลัมน์/ข้อความ. `tags` ใช้ช่วย filter ใน admin เท่านั้น และไม่ใช่เงื่อนไขบังคับในการค้นลูกค้า. ต้องถอด closed type filters ที่ทำให้ untyped หรือหัวข้อใหม่ไม่เข้า QA/evidence path; คง `content_type` เดิมได้ชั่วคราวเพื่ออ่านข้อมูลเก่า แต่ไม่ใช้เป็น authority ของระบบใหม่
7. **Product identity:** ข้อมูลสินค้าใน KB เป็น supporting evidence; บัตรสินค้า/ราคา/สต็อกปัจจุบันยังมาจาก product owner เดิม. `model_name` ที่สกัดจากแถวและ `storefront_title` เป็นคนละฟิลด์ และไม่ใช่ `item_id` ของ Mongo โดยอัตโนมัติ. ถ้าต้องผูก Zaapi row กับ Mongo product ต้องมี mapping ที่ตรวจแล้วหรือ structured identity จาก owner เดิม; ห้ามผูกด้วยชื่อคล้ายกันอย่างเงียบ ๆ. คำถามรุ่นเฉพาะต้องไม่ใช้หลักฐานคนละรุ่นเพียงเพราะ vector score สูง. โปรโมชั่นที่ไม่รู้ช่วงเวลา/หมดอายุต้องไม่ถูกนำไปอ้างว่าใช้อยู่ปัจจุบัน

## Import, export และ publication

Import รับชุดไฟล์ต้นฉบับ + metadata Zaapi + JSON mapping ที่ตรวจแล้ว. `preview` เป็น read-only: แสดง source/file SHA, ร้านที่จะใช้, overrides, จำนวนชีต/แถว/หน่วยค้น, แถวผิดปกติ, ไฟล์ไม่แมป, diff ต่อ generation ปัจจุบัน และต้นทุน build โดยประมาณ. `apply` ทำงาน offline: เก็บ raw bytes/rows → สกัด projection เฉพาะ layout ที่ตรวจแล้ว (ส่วนที่ยังไม่สกัดคง raw) → สร้างหน่วยค้น → embed แบบ batch โดย pin model identity เดียว → verify count/hash/provenance/vector → สร้าง generation ที่ยังไม่มองเห็น. ห้ามใช้ Gemini ในขั้นนี้

ใช้ `kb_zaapi_files.py` เป็น owner ของ parse/import/search/export ต่อไป และปรับ adapter/QA callsites ที่ใช้งานจริง ไม่เปิดทาง canonical ที่ dormant ขึ้นมาเป็นระบบคู่ขนาน. แยกข้อมูลหน่วยค้นและไฟล์ต้นฉบับออกจาก row collection เพื่อไม่ให้ `export_file` หรือ legacy row readers อ่านหน่วยค้นเป็นแถว; รายละเอียดชื่อ collection/index อยู่ใน implementation plan. การ publish ใช้ active generation pointer เดียวหลังทั้ง batch ผ่าน เพื่อไม่เสิร์ฟข้อมูลครึ่งชุด; request resolve pointer ครั้งเดียว. รุ่นเก่ายังอยู่ช่วง rollback/grace แล้วค่อย sweep. Build หรือ validation fail ต้องไม่เปลี่ยน pointer และต้องมีรายงานที่ replay ได้. `kb_source=zaapi` และร้านที่ไม่มี matching source ให้คืน no evidence ตามจริง ไม่มี fallback ไป legacy แบบเงียบ ๆ

Export มีสองรูปแบบแยกกันชัด: (1) **source package** บรรจุ bytes ต้นฉบับ, metadata, mapping JSON, extraction revision/field provenance, manifest/checksums/generation ID สำหรับตรวจและ re-import แบบ byte-identical; (2) **human-readable file export** ตาม API เดิมเป็น XLSX/TXT ที่สร้างจาก parsed rows ซึ่งรับประกันค่าข้อมูล/ลำดับ/ตำแหน่งที่เทียบได้ แต่ไม่รับประกันสูตร รูปแบบ หรือ hyperlink แบบ byte-identical. Export ต้องระบุ active generation และไม่ดึง staged/retired rows. Import source package ซ้ำด้วย raw SHA, mapping และ extraction revision เดิมต้องไม่สร้างข้อมูลซ้ำหรือเปลี่ยนผลค้น; ถ้า mapping/extraction เปลี่ยนให้เป็น generation ใหม่ที่ตรวจและ publish ใหม่

## กระบวนการค้นตอนตอบลูกค้า

สรุปสั้น: นำ Zaapi KB เข้า Mongo ครั้งหนึ่งพร้อมเก็บ raw → สร้างดัชนีข้อความและ embedding ของหน่วยค้นทั้ง 118 ไฟล์ล่วงหน้า → publish เฉพาะ 103 ไฟล์ที่มี mapping ร้าน → ตอนลูกค้าถาม กรองร้าน/แพลตฟอร์มก่อน ค้นรุ่น/ชื่อสินค้าแบบตรงร่วมกับความหมายของอาการหรือคำถาม แล้วส่งแถวต้นฉบับที่พบให้บอทตอบ. ไม่มีการ embed แถว Zaapi ใหม่ต่อคำถาม และ 15 ไฟล์ที่ยังไม่แมปไม่ถูกใช้ตอบลูกค้า

1. Runtime อ่าน generation ที่ active และ shop key ที่มาจาก request/authenticated shop context. ไม่มี shop key ที่ยืนยันได้ → ไม่ปล่อย KB ที่จำกัดร้าน. ใช้ mapping ที่ publish แล้วเป็นขอบเขตแรก
2. ใช้ typed subject/target refs และ candidate identity จาก owner เดิมเพื่อจำกัดรุ่นที่ถามเมื่อมี; exact model/code match ต้องเคารพขอบ token แบบ `_ref_hit` ปัจจุบัน. `brand`, `model_name`, `storefront_title` ที่สกัดได้ช่วยจับชื่อเรียกและจัดอันดับ แต่ถ้าแถวไม่มีฟิลด์เหล่านี้ยังค้น raw text ได้; ห้ามกรองทิ้งเพราะฟิลด์ optional ว่าง. คำถามทั่วไปที่ไม่มีรุ่นค้นได้ใน scope ร้านโดยไม่บังคับหมวด
3. ค้นข้อความตรง/lexical และ vector ของหน่วยที่อยู่ใน scope; query embed สูงสุดหนึ่งครั้งต่อคำถามที่ต้องใช้ semantic search. Vector ของหน่วยอ่านจาก index ที่ build ไว้ ไม่เรียก `embed_texts` ต่อ request. อาการที่ใช้คำต่างจาก raw ให้ semantic search ช่วยหา แล้วตรวจรุ่นและร้านก่อนเลือก. หาก raw มีคอลัมน์ช่องทางที่ระบุแพลตฟอร์มของลิงก์/โปรโมชันในแถวนั้นอย่างชัดเจน ให้ใช้เป็น scope เพิ่มเติมของแถวนั้น; mapping ระดับไฟล์ไม่อนุญาตให้ส่งลิงก์ต่างแพลตฟอร์มโดยอัตโนมัติ. รวมคะแนนและ deduplicate กลับ parent row; ส่ง row context, source file/sheet/row และ score เป็น `supporting_evidence` ผ่าน `kb_zaapi.py`/QA owners เดิม. `tags` ช่วยอธิบายผล ไม่ตัด untagged ทิ้ง
4. ไม่พบหลักฐานพอหรือพบคนละรุ่น/ร้าน → ไม่อ้างข้อมูลนั้น. Legacy KB/สินค้า/คำสั่งซื้อยังอยู่ตาม gate/owner เดิม. เก็บ trace ต่อ stage: scope count, lexical/vector candidate count, selected row IDs, query embedding time, index search time, LLM time เพื่อแยกคอขวดจริง

## ทดสอบและเงื่อนไขเปิดใช้

- Offline parser/property tests ด้วย fixture หลายชีต, หลายร้าน, หัวคอลัมน์แปลกหรือซ้ำ, แถวผสม, แถวไม่มีแบรนด์/รุ่น, FAQ ใน cell เดียวหรือแยกคอลัมน์, TXT ยาว, cell ว่าง: ทุก raw row ต้องมี provenance และ round-trip ค่าข้อมูลได้; projection ที่สกัดได้ต้องมี source cell/span; raw ที่ยังสกัดไม่ได้และ untagged ต้องค้นได้
- Isolated Mongo integration: preview = 0 writes; apply/build fail ไม่เปลี่ยน pointer; publish ทั้งชุด/rollback; concurrent import conflict; disabled/unmapped/cross-shop ไม่รั่ว; source package export → import ลง DB ใหม่ → SHA/rows/mapping/search hits เท่ากัน; human-readable export → parse แล้วค่า/ลำดับเท่ากันภายใต้ข้อจำกัดที่ระบุ
- Gold retrieval set จาก raw จริง ครอบสินค้าใกล้ชื่อกัน, รับประกัน, ซ่อม, วิธีแก้, โปรโมชั่น, ลิงก์, สต็อกเก่า, generic FAQ, หลายร้าน/แพลตฟอร์ม; ผู้ตรวจระบุ expected `source_id/sheet/row` ก่อนวัด. ต้องรายงาน recall@k, wrong-shop และ wrong-model rate เปรียบกับ baseline; ห้าม publish ถ้ามี wrong-shop/wrong-model หรือเคสสำคัญที่ตอบผิดโดยไม่แก้ root cause
- Load test หนึ่งคำถาม, 100 คำถามเรียงกัน, 100 คำถามพร้อมกัน และ 200 พร้อมกันบนเครื่องทดสอบที่รองรับ โดยจำกัดการยิงเพื่อไม่ทำให้เครื่องใช้งานค้าง; แยกเวลาค้น, query embedding, LLM, total และ memory. เกณฑ์หลัก: `embed_texts` ของ corpus = 0 ใน request path และไม่มี timeout จากการ embed แถวซ้ำ; latency เป้าหมายจริงต้องตั้งจากผลบน i9/RAM 8GB ก่อน production publish ไม่เอาตัวเลข Mac ไปยืนยันสเกล server
- ตรวจ response end-to-end จาก bot: evidence ที่เลือกต้องส่งถึง answer owner, ระบุ row ที่ใช้จริงใน trace, ไม่อ้างโปรโมชั่นหมดอายุ/สต็อกจาก snapshot เป็นข้อมูลปัจจุบัน และไม่เปลี่ยน sellable card owner. อัปเดต `docs/SRS_SSD.md` §6, schema/process docs และ regression tests เมื่อแก้ฟังก์ชันจริง

## งานที่ยังไม่ทำในขั้นสเปก

ยังไม่ import Mongo, ไม่เปิด publish, ไม่เปลี่ยน bot/admin runtime หรือ config, ไม่แก้ Product DB. การเลือกกฎจัดอันดับและ threshold ต้องยึด gold set จริง; สเปกนี้ไม่อ้างว่า mapping ระดับสินค้า/รุ่นครบ 100% หรือรองรับ Facebook/LINE ในระบบร้านปัจจุบัน. Historical waythrough semantic coverage ยัง partial; ใช้ entries ที่เกี่ยวกับ Zaapi และ current code เป็นหลักฐานเฉพาะงานนี้
