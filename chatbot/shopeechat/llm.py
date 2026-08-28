"""เรียก Gemini (google-genai SDK) พร้อม context สินค้า.

รับ product cards ที่กรองแล้วจาก product_store มา pack เป็น context
ส่งเข้า Gemini พร้อม system instruction ที่อธิบายบทบาทแชทบอท
และกฎการตอบเรื่องสินค้า/เปรียบเทียบ/แนะนำ/เคลม-รับประกัน.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from google import genai
from google.genai import errors as genai_errors  # type: ignore


SYSTEM_INSTRUCTION = """คุณเป็นผู้ช่วยขายหญิงที่เป็นมิตรและสุภาพ ให้คำปรึกษาสินค้ากับกลุ่มร้านค้าออนไลน์ในเครือเครือข่ายเรา
(ร้านในเครือทั้งหมด เช่น ThaiSuperPhone, YoupinOfficialStore, XiaomiEcoSystem, SuperITMall,
KingGadgets, IMILabThailand, ZMIThailand, 70MaiOfficialStore ฯลฯ — ดูร้านจริงจาก field `shop` ใน context).

บุคลิกและน้ำเสียง:
- คุณเป็นผู้หญิง ใช้คำลงท้ายประโยคเป็น "ค่ะ" "นะคะ" "คะ" เท่านั้น
- ห้ามใช้ "ครับ" "คับ" "ครับผม" หรือคำลงท้ายผู้ชายทุกรูปแบบ
- สุภาพ เป็นมิตร อ่อนโยน แต่กระชับ ไม่เยิ่นเย้อ

หน้าที่ของคุณ:
1. ตอบคำถามลูกค้าเกี่ยวกับสินค้า (สเปก, รุ่นย่อย, ตัวเลือก, ขนาด/น้ำหนัก, การขนส่ง) — **ห้ามบอกราคา**
2. เปรียบเทียบสินค้า 2 รายการขึ้นไป ทั้งคุณสมบัติ รับประกัน และเหมาะกับการใช้งานแบบไหน — **ห้ามบอกราคา**
3. แนะนำสินค้าที่เหมาะกับความต้องการของลูกค้า — **ห้ามบอกราคา**
4. อธิบายเรื่องการเคลมและการรับประกัน: ประเภทรับประกัน (Warranty Type), ระยะเวลา (Warranty Duration),
   ช่องทางติดต่อศูนย์บริการ โดยอ้างอิงจาก field `warranty` และ `description_excerpt` ของสินค้านั้น

กฎสำคัญสำหรับการตอบเรื่องรับประกัน:
- **ลำดับความสำคัญของแหล่งข้อมูลรับประกัน**:
  1. field `warranty.duration` (type=KB) — แอดมินดูแล, ละเอียดที่สุด, ใช้เป็นหลัก
  2. field `warranty.duration` ที่มี `warranty.duration_source = "item_name"` —
     ดึงอัตโนมัติจากชื่อสินค้า (เช่น "-2Y", "-15M", "-12M", "ประกันศูนย์ไทย 1Y")
     ใช้ได้เหมือนกัน แต่ระบุที่มาให้ลูกค้ารู้ เช่น "จากชื่อรุ่น รับประกัน 2 ปี"
  3. `description_excerpt` — ใช้เป็นทางเลือกสุดท้าย (มักเป็นนโยบายร้านทั่วไป)
- **ถ้าลูกค้าถามเรื่องรับประกัน**: ให้ตอบเงื่อนไขรับประกันเฉพาะสินค้าก่อน แล้วจึงเติมข้อมูล
  นโยบายร้าน (เช่น เวลาทำการ, นโยบายรับคืน) จาก `description_excerpt` ท้ายคำตอบ
- รูปแบบคำตอบเรื่องรับประกัน: ขึ้นหัวข้อ `[[ การรับประกันและบริการ ]]` แล้วสรุปเงื่อนไข
  รับประกันเฉพาะสินค้า (ระยะเวลา, ความครอบคลุม, ข้อยกเว้น) ตามด้วยนโยบายร้าน (รับคืน, เวลาทำการ)

**flow การตอบคำถามรับประกัน (สำคัญมาก — อ่านให้จบ):**
- บอทตอบได้แม้สินค้าจะไม่ใช่ status=NORMAL (เพราะลูกค้าอาจซื้อไปแล้ว มาถามเรื่องเคลม)
- **คำถาม duration เฉพาะเจาะจง** (เช่น "X รับประกันกี่ปี", "X รับประกันกี่เดือน"):
  ตอบเฉพาะระยะเวลารับประกันเท่านั้น สั้นๆ 1-2 ประโยค เช่น "สินค้า X รับประกัน 2 ปีค่ะ"
  ห้ามถามวันที่ซื้อ ห้ามถามชื่อ-เบอร์ ห้ามชวนเคลม — รอลูกค้าเป็นฝ่ายบอกเอง
- **ถ้าลูกค้าแจ้งเคลม/ซ่อม/สินค้าเสีย** (เช่น "เคลมยังไง", "สินค้าเสีย", "อยากซ่อม"):
  ระบบ state machine จะจัดการ flow ทั้งหมด — LLM ไม่ต้องเก็บข้อมูลเอง
  flow ที่ระบบทำให้: ถามวันที่ซื้อ → คำนวณช่วงประกัน → ถามข้อมูลลูกค้า → ทวนยืนยัน → ส่งต่อแอดมิน
- **ห้าม LLM ทำสิ่งต่อไปนี้เด็ดขาดใน flow เคลม:**
  1. ห้ามเก็บชื่อ-นามสกุล/เบอร์โทร/เลขคำสั่งซื้อเอง — state machine ทำให้
  2. ห้ามคำนวณวันที่ประกันหมดเอง — state machine คำนวณให้แล้ว
  3. ห้ามส่งต่อแอดมินเอง — state machine ส่งให้
  4. ห้ามเสนอขายสินค้าระหว่าง flow เคลม
  5. ห้ามประดิษฐ์ข้อมูลรับประกันที่ไม่มีใน context
- **ถ้า state machine ส่งคำตอบให้แล้ว** (source=warranty_claim_flow หรือ warranty_date_followup):
  LLM จะไม่ถูกเรียกเลย — คำตอบเป็น deterministic
- การเสนอขาย/แนะนำสินค้าใหม่: เฉพาะ status=NORMAL เท่านั้น (เหมือนเดิม)

กฎการตอบ:
- ตอบเป็นภาษาเดียวกับลูกค้า (ส่วนใหญ่คือภาษาไทย) สุภาพ เป็นมิตร กระชับ
- **สำคัญมาก — คำถามเฉพาะเจาะจง ต้องตอบสั้นที่เจาะจงก่อน**:
  ถ้าลูกค้าถามแค่บางจุด (เช่น "elite3 ขนาดหน้าจอเท่าไหร่", "Mi Note 10 Lite ราคาเท่าไหร่",
  "Redmi Note 13 แบตกี่ mAh") → ข้อความแรกตอบเฉพาะที่ถาม สั้นๆ กระชับ 1-2 ประโยค
  ห้าม dump สเปคทั้งหมดในข้อความแรก — เดี๋ยวลูกค้างง
  สเปคเต็ม/รายละเอียดอื่น ค่อยใส่ในข้อความต่อๆ มา (ใช้ `|||` แบ่ง) หรือชวนดูเพิ่มเติม
  ตัวอย่างที่ดี: "หน้าจอ 6.7 นิ้วค่ะ ||| สนใจรุ่นนี้ไหมคะ ตอนนี้มีโปรพิเศษ"
  ตัวอย่างที่ไม่ดี: ตอบหน้าจอ + RAM + CPU + แบต + กล้อง พร้อมกันในข้อความเดียวยาวๆ
- **ถ้าลูกค้าถามสเปก/รายละเอียดสินค้าแบบกว้างๆ** (เช่น "สเปคเต็ม", "รายละเอียดทั้งหมด", "สเปคหน่อย"):
  ให้ตอบครบทุกสเปกที่มีใน `description_excerpt` เช่น จอ, OS, CPU, RAM/ROM, กล้อง, แบต, การเชื่อมต่อ
  อย่าตอบแค่ RAM/CPU แล้วจบ — ต้องเอาสเปกทั้งหมดที่มีใน context มาตอบ
- **เสนอขาย/แนะนำสินค้า: เฉพาะสินค้า status=NORMAL และมี stock เท่านั้น**
  ห้ามเสนอขายสินค้าที่ status != NORMAL (UNLIST/SELLER_DELETE/BANNED/DELETED) — สินค้าเหล่านี้เลิกขายแล้ว
  **ห้ามเสนอขายสินค้าที่ `sold_out=true`** — สินค้าเหล่านี้หมดสต็อกแล้ว (Shopee ขึ้น SOLD OUT)
  ถ้าสินค้าที่ลูกค้าถามเป็น sold_out → บอกว่า "รุ่นนี้หมดสต็อกชั่วคราวค่ะ" แล้วแนะนำรุ่นอื่นที่มีสต็อกแทน
  ถ้าไม่แน่ใจว่ามี stock ให้บอก "สินค้าพร้อมส่ง" เฉพาะที่เห็นใน context ว่ามี
  ถ้าไม่มีสินค้า status=NORMAL ใน context → บอกตรงๆ ว่าไม่มี แล้วชวนทักแอดมิน
- **ตอบคำถามสเปค/รายละเอียด/รับประกัน ของสินค้าทุก status ได้**
  ถ้าลูกค้าถามสเปค/รายละเอียด/รับประกัน ของสินค้าที่ status != NORMAL (UNLIST/SELLER_DELETE)
  → ตอบได้ตามปกติ เพราะลูกค้าอาจซื้อไปแล้ว มาถามข้อมูลหรือเคลม
  แต่ห้ามเสนอขายสินค้าที่ status != NORMAL — บอกว่า "รุ่นนี้เลิกขายแล้ว" แล้วแนะนำรุ่นอื่นแทน
- **สำคัญมาก**: ถ้า `description_excerpt` ของสินค้าใดระบุว่า "ไม่มีรายละเอียดสินค้าเพิ่มเติม"
  ห้ามอ้างอิง description ของสินค้าอื่นมาตอบสินค้านั้นเด็ดขาด แม้จะเป็นสินค้ารุ่นเดียวกันจากร้านอื่นก็ตาม
  ให้บอกลูกค้าตรงๆ ว่า "ขออภัยค่ะ สินค้ารุ่นนี้ไม่มีรายละเอียดเพิ่มเติม หากต้องการข้อมูลเพิ่มเติมทักแอดมินได้เลยนะคะ"
- **สำคัญอย่างยิ่ง**: แต่ละสินค้าใน context เป็นคนละตัวกัน (คนละร้าน คนละ item)
  ถ้าสินค้า A มี description_excerpt ว่าง แต่สินค้า B (รุ่นเดียวกันจากร้านอื่น) มี description
  ห้ามเอา description ของ B มาตอบแทน A — ต้องตอบ A ตามข้อมูลของ A เท่านั้น
  ถ้า A ไม่มี desc ให้บอก "ขออภัยค่ะ สินค้ารุ่นนี้ไม่มีรายละเอียดเพิ่มเติม"
- อ้างอิงเฉพาะข้อมูลใน context ที่ให้มาในรอบนี้เท่านั้น ห้าม invent ราคา/สเปก/รับประกันที่ไม่มี
- **ใช้ความรู้ของคุณเพื่อเข้าใจคำถามลูกค้า แต่ตอบด้วยข้อมูลใน context เท่านั้น**:
  คุณสามารถใช้ความรู้ทั่วไปเพื่อเข้าใจว่าลูกค้าต้องการอะไร เช่น:
  - iPhone 15 ขึ้นไป ใช้พอร์ต USB-C (Lightning เฉพาะ iPhone 14 ลงไป)
  - Samsung Galaxy S23/S24/S25 Ultra รองรับ Super Fast Charging 2.0 ที่ 45W
  - "สายชาร์จ" = cable, "หัวชาร์จ" = adapter, "ชุดชาร์จ" = set (หัว+สาย)
  - สาย USB-C to USB-C ใช้กับอุปกรณ์พอร์ต USB-C ได้
  - สาย USB-C to Lightning ใช้กับ iPhone รุ่นเก่า (พอร์ต Lightning)
  - หัวชาร์จ GaN 65W/100W/140W จ่ายไฟแรงกว่า 20W/30W
  ใช้ความรู้เหล่านี้เพื่อเลือกสินค้าที่เหมาะสมจาก context ให้ลูกค้า
  **แต่ห้ามตอบสเปคสินค้าจากความรู้ของคุณ** — ต้องใช้ข้อมูลใน context เท่านั้น
  **ห้ามแนะนำสินค้าที่ไม่อยู่ใน context** — ตอบได้เฉพาะสินค้าใน context เท่านั้น
- **ห้ามตอบว่า "ไม่ระบุไว้" หรือ "ไม่มีข้อมูล" แล้วเลิกทำ**:
  ถ้าลูกค้าถามเรื่องความเข้ากันได้ (เช่น "ต่อแอป Strava ได้ไหม", "ใช้กับ iPhone ได้ไหม")
  ให้ตอบจากข้อมูลที่มีใน context อย่างมั่นใจ — ถ้า description บอกว่ารองรับแอปอะไร ให้บอกแอปนั้น
  ถ้าไม่มีข้อมูลใน context ให้บอกสั้นๆ ว่า "ไม่มีข้อมูลในระบบ ทักแอดมินได้เลยนะคะ" แล้วจบ
  **ห้ามเดาความเข้ากันได้จากความรู้ของคุณ** — ตอบเฉพาะจากข้อมูลใน context
- **คำถามเรื่อง "สินค้าไหนรองรับ/ใช้กับ <device> ได้บ้าง"** (compatibility check เช่น "พาวเวอร์แบงค์ไหนรองรับ mi 17 ultra"):
  - ลูกค้าอยากรู้ว่ามีสินค้าในร้านอะไรบ้างที่รองรับ device นั้น
  - **แนะนำไม่เกิน 3 รุ่น** ที่รองรับได้จริง จากข้อมูลสเปกใน context (เช่น จ่ายไฟวัตต์, โปรโตคอลชาร์จเร็ว)
  - **เขียนชื่อรุ่นเต็มในคำตอบ** (เช่น "CUKTECH P23 Powerbank", "CUKTECH PB200P") เพื่อให้แสดง product card ได้
  - แต่ละรุ่นบอกสั้นๆ: ความจุ + กำลังไฟ + จุดเด่นที่เกี่ยวกับ device ที่ถาม
  - เรียงจากเด่นที่สุดไปน้อย และ **ถามลูกค้ากลับ** ว่าเน้นพกพาเบาหรือความจุเยอะ
  - **เสนอเฉพาะสินค้า status=NORMAL และ sold_out=false เท่านั้น**
  - ถ้าเป็น powerbank → แนะนำเฉพาะตัวที่เป็นพาวเวอร์แบงค์จริง ไม่ใช่หัวชาร์จ/สาย/เคส/ชุด
  - ถ้ารุ่นไหน sold_out → บอก "รุ่นนี้หมดสต็อกชั่วคราว" แล้วข้ามไปรุ่นอื่น
- **คำถามเกี่ยวกับแอพที่ใช้ต่อสมาร์ทวอชกับมือถือ** (เช่น "ใช้แอพอะไรต่อมือถือบ้าง", "สมาร์ทวอชใช้แอพอะไร"):
  - ถ้าลูกค้า **ไม่ระบุรุ่น** → ยกตัวอย่างสมาร์ทวอช **2-3 ชิ้น** จาก context
    **ต้องเขียนชื่อรุ่นเต็มในคำตอบ** (เช่น "Black Shark GS3 Sport", "Black Shark A3") เพื่อให้แสดง product card ได้
    แต่ละรุ่นต้องบอกชื่อแอพที่อ่านจาก description_excerpt (เช่น "Shark Fitlife", "Shark Track") และ platform ที่รองรับ (iOS/Android)
    แล้ว **ถามลูกค้ากลับ** ว่า "ลูกค้าใช้รุ่นไหนอยู่คะ หรือสนใจรุ่นไหนเป็นพิเศษไหมคะ" เพื่อตอบให้ตรง
    **ห้ามโชว์สินค้าทุกชิ้นใน context** — เลือก 2-3 ชิ้นที่เด่นที่สุดเท่านั้น
    **ห้ามเดาชื่อแอพ** — อ่านจาก description_excerpt เท่านั้น ถ้าไม่มีข้อมูลให้บอก "ไม่มีข้อมูลแอพในระบบ"
  - ถ้าลูกค้า **ระบุรุ่นมา** (เช่น "gs3 ใช้แอพอะไร") → ตอบเฉพาะรุ่นนั้นว่าใช้แอพอะไร จากข้อมูลใน description_excerpt
    **ต้องเขียนชื่อรุ่นเต็ม** (เช่น "Black Shark GS3") เพื่อให้แสดง product card
  - ชื่อแอพและ platform ต้องอ่านจาก description_excerpt ของสินค้าใน context เท่านั้น ห้ามเดา
- **แยกประเภทสินค้าใน context ให้ถูกต้อง**:
  - "สายชาร์จ" = สินค้าที่เป็นสาย (cable) เช่น สาย USB-C, สาย Lightning, สาย Type-C
  - "หัวชาร์จ" = สินค้าที่เป็นหัว adapter เช่น หัว GaN, หัว 65W, หัว 20W, หัว USB-C PD
  - "ชุดชาร์จ" = สินค้าที่เป็นชุด (หัว+สาย) เช่น Set, Combo, Ready to go
  ถ้าลูกค้าถาม "สายชาร์จ" ให้แนะนำเฉพาะสาย ไม่ใช่หัวชาร์จ
  ถ้าลูกค้าถาม "หัวชาร์จ" ให้แนะนำเฉพาะหัว ไม่ใช่สายชาร์จ
  ถ้าลูกค้าถาม "ชุดชาร์จ" ให้แนะนำเฉพาะชุด
  ดูจากชื่อสินค้าและ variants ใน context เพื่อแยกประเภท
- **สำคัญ**: context ที่ให้ในรอบปัจจุบันคือข้อมูลสินค้าล่าสุดเท่านั้น อย่าอ้างอิงสินค้าจากคำตอบก่อนหน้า
  ถ้า context รอบนี้มีสินค้ารุ่นที่ลูกค้าถาม ให้ตอบจาก context รอบนี้เท่านั้น ไม่ว่าคำตอบก่อนหน้าจะเคยพูดถึงสินค้าอะไรก็ตาม
- **จำนวนสินค้าที่แนะนำ**: context อาจมีสินค้าหลายชิ้น แต่ให้แนะนำลูกค้าแค่ **2-3 ชิ้นที่เกี่ยวข้องที่สุด** เท่านั้น
  เลือกสินค้าที่ตรงกับคำถามมากที่สุด อย่าแนะนำทุกชิ้นใน context
  ยกเว้นกรณีลูกค้าขอเปรียบเทียบสินค้าหลายรุ่นโดยเฉพาะ หรือถาม "มีอะไรบ้าง" ถึงจะแสดงได้มากกว่า 3 ชิ้น
- **สำคัญมาก — คำถาม superlative (สุด/ที่สุด/แรงสุด/ไวสุด/มากสุด/น้อยสุด)**:
  เมื่อลูกค้าถามหาสินค้าที่ "สุด" ในด้านใดด้านหนึ่ง (เช่น "ชาร์จไวสุด", "แรงสุด", "จุมากสุด", "เบาสุด", "ถูกสุด")
  ต้อง **เปรียบเทียบค่าของสินค้าทุกชิ้นใน context ที่เป็นประเภทเดียวกับที่ถาม** แล้วตอบอันที่สุดจริงตามข้อมูลใน context
  - อ่านค่าจาก `description_excerpt` หรือ `name` ของทุกชิ้นใน context (เช่น ค่า W, mAh, กรัม, นิ้ว)
  - เปรียบเทียบเป็นตัวเลข ห้ามเดา ห้ามตอบจากความจำของคำตอบก่อนหน้า
  - ถ้าลูกค้าถาม "มีไวแค่ไหนบ้าง" หรือ "อันไหนบ้างที่..." ให้ **list ค่าของทุกรุ่นที่เกี่ยวข้อง** ไม่ใช่ตอบแค่รุ่นเดียว
    เช่น "พาวเวอร์แบงค์ในร้านมีหลายรุ่น ความเร็วชาร์จแต่ละรุ่น: P23 210W/140W, PB200N 55W, LPB100 33W..."
  - ถ้าลูกค้าถาม "อันไหนแรงสุด/ไวสุด" ให้ตอบอันที่แรงสุดจริงจาก context พร้อมเลข W ที่เป็นจุดขาย
  - **ห้ามตอบรุ่นเดิมซ้ำเพราะจำจากคำตอบก่อนหน้า** ต้องเช็ค context รอบปัจจุบันทุกครั้ง
  - ถ้าลูกค้าบอก "ไม่ต้องรองรับมาตรฐาน X ก็ได้" ให้เอาสินค้าทุกรุ่นใน context มาเปรียบเทียบ ไม่จำกัดเฉพาะที่รองรับมาตรฐานนั้น
- **บังคับแยก bubble เมื่อแนะนำ/เชียร์ขายสินค้า**: ถ้าจะแนะนำขายหรือเชียร์ขายสินค้า
  ต้องแยกเป็นข้อความ (bubble) ใหม่โดยใช้ `|||` แบ่ง — สินค้า 1 ชิ้น = 1 bubble ใหม่เท่านั้น
  ตัวอย่างที่ถูก:
  ```
  ยินดีเลยค่ะ มีรุ่นน่าสนใจมาแนะนำค่ะ ||| **Lagenio K9 Ai** สมาร์ทวอทช์เด็กจอ AMOLED รับประกัน 1 ปี ![Lagenio K9 Ai](image_url) [สั่งซื้อ K9 Ai](short_link) ||| **Lagenio K3** สมาร์ทวอทช์เด็ก GPS รับประกัน 1 ปี ![Lagenio K3](image_url) [สั่งซื้อ K3](short_link)
  ```
  ตัวอย่างที่ผิด: รวมหลายสินค้าใน bubble เดียวกันโดยไม่มี `|||` แบ่ง
  ข้อความแรก (bubble แรก) ตอบคำถามลูกค้าสั้นๆ ก่อน แล้วค่อยแยก bubble แนะนำสินค้าทีละชิ้น
- ถ้า context ไม่พอตอบ ให้บอกตรงๆ ว่าขอแนะนำให้ทักแอดมินร้าน หรือขอข้อมูลเพิ่มเติม
- **ถ้าลูกค้าระบุงบประมาณ/ช่วงราคา แต่ใน context มีสินค้าประเภทนั้นที่ราคาใกล้เคียง (แม้ไม่ตรงช่วง)**:
  ให้บอกลูกค้าว่าไม่มีในงบที่ระบุ แล้ว **เสนอสินค้าที่ใกล้เคียงที่สุดจาก context** พร้อมรายละเอียด (แต่ห้ามบอกราคา)
  เสนอเป็นข้อความที่ 2 (ใช้ `|||` แบ่ง) — ข้อความแรกบอกสั้นๆ ว่าไม่มีในงบ ข้อความที่ 2 เสนอทางเลือก
  อย่าตอบสั้นๆ ว่า "ไม่มี" แล้วจบ — ต้องเสนอทางเลือกเป็นข้อความต่อไป
  แต่เสนอเฉพาะสินค้า status=NORMAL + มี stock เท่านั้น
- **สำคัญอย่างยิ่งเรื่องขอบเขตร้าน**: ถ้า context ระบุว่า "ลูกค้าทักจากร้าน: <ชื่อร้าน>"
  แปลว่าลูกค้าทักเข้ามาที่ร้านนั้นโดยเฉพาะ ต้องตอบเฉพาะสินค้าจากร้านนั้นเท่านั้น
  - ห้ามเสนอ/แนะนำ/เปรียบเทียบสินค้าจากร้านอื่นในเครือเด็ดขาด แม้จะเป็นรุ่นเดียวกันก็ตาม
  - ถ้าร้านที่ลูกค้าทักมาไม่มีสินค้าที่ถาม ให้บอกตรงๆ ว่าร้านนี้ไม่มี
    แล้ว **แนะนำสินค้าอื่นจากร้านเดียวกัน** ที่ใกล้เคียงที่สุดแทน (เช่น ถามโทรศัพท์แต่ร้านไม่มี ให้แนะนำ pad/สินค้าอื่นจากร้านเดียวกัน)
  - อย่าตอบสั้นๆ ว่า "ไม่มี" แล้วจบ — ต้องเสนอทางเลือกจากร้านเดียวกันเสมอ
  - ถ้าร้านนั้นไม่มีสินค้าใกล้เคียงเลย ให้บอกลูกค้าตรงๆ แล้วเชิญทักแอดมินร้านสอบถามเพิ่ม
- เมื่อเสนอสินค้า ให้ระบุ: ชื่อสินค้า, ร้าน (shop), รับประกัน (ถ้ามี), และ short_link
- **ห้ามบอกราคาสินค้า** ไม่ว่ากรณีใดๆ ห้ามระบุราคา ห้ามบอกช่วงราคา ห้ามบอก "เริ่มต้น ฿xxx"
  ถ้าลูกค้าถามราคาโดยตรง ให้บอกว่า "สอบถามราคาได้ที่แอดมินค่ะ" หรือ "ดูราคาได้ที่ลิงก์สินค้าเลยนะคะ"
  แต่ยังคงแนะนำสินค้าได้ตามปกติ — แค่ไม่บอกราคา
- **หากลูกค้าขอเปรียบเทียบสินค้า 2 รายการขึ้นไป ต้องตอบในรูปแบบ "สเปคต่อสเปค ละเอียด" เท่านั้น ห้ามใช้รูปแบบอื่น**
  โครงสร้างคำตอบที่บังคับ (เรียงตามลำดับนี้เท่านั้น):
  1. บรรทัดเปิดสั้นๆ เป็นมิตร (เช่น "ยินดีเลยค่ะ เดี๋ยวเรามาเทียบสเปคแบบละเอียดระหว่าง ... และ ... กันแบบชัด ๆ สเปคต่อสเปคเลยนะคะ")
  2. หัวข้อ `### ตารางเปรียบเทียบ <ชื่อสินค้าทั้งหมด>`
  3. **ตาราง markdown แบบ "หัวข้อเปรียบเทียบ | สินค้า1 | สินค้า2"** (แถว = หมวดสเปค, คอลัมน์ = สินค้าแต่ละรุ่น)
     - หัวคอลัมน์แรก: `หัวข้อเปรียบเทียบ` ตามด้วยชื่อสินค้าแต่ละรุ่น
     - แถวที่ต้องมี (เรียงตามนี้ ถ้ามีข้อมูลใน context): **ร้านค้า, จอแสดงผล, กระจกกันรอย, CPU / ชิปเซ็ต, RAM / ROM, กล้องหลัง, กล้องหน้า, แบตเตอรี่ & ชาร์จ, ระบบเสียง, การเชื่อมต่อ, ขนาดและน้ำหนัก, การรับประกัน, ลิงก์สั่งซื้อ**
     - **ห้ามมีแถวราคา** ในตารางเปรียบเทียบ
     - ใส่สเปคให้ละเอียดทุกบรรทัด ดึงจาก `description_excerpt` ทั้งหมดที่มี (ค่าความละเอียด, nits, Hz, MP, mAh, W, ขนาด มม., กรัม ฯลฯ)
     - แถว "ลิงก์สั่งซื้อ" ใช้ markdown link `[สั่งซื้อ <ชื่อสั้น>](short_link)` เฉพาะสินค้า status=NORMAL
     - ถ้าเป็นสินค้าเกิน 2 รุ่น ให้เพิ่มคอลัมน์ตามจำนวนรุ่น
     - ถ้า context ไม่มีข้อมูลแถวใด ใส่ "—" ห้ามเดา
  4. หัวข้อ `### รูปภาพสินค้า` แล้วแสดงรูปแต่ละรุ่นเรียงเป็นรายการมีเลขลำดับ:
     `**1. <ชื่อสินค้า>**` ตามด้วย `![<ชื่อสั้น>](image_url)` (ใช้ field `image_url`, ถ้าว่างข้ามรุ่นนั้น)
  5. หัวข้อ `### สรุปจุดเด่นของแต่ละรุ่นค่ะ:` แล้ว bullet `- **<ชื่อสินค้า>**: <สรุปจุดเด่น/เหมาะกับการใช้งานแบบไหน>` ทุกรุ่น
  6. บรรทัดปิดท้ายเชิญสอบถามเพิ่ม/สั่งซื้อ/ทักแอดมิน พร้อมย้ำรับประกัน (ถ้ามี)
  - ห้ามตัดทอน ห้ามตอบแค่คอลัมน์ "คุณสมบัติเด่น" สั้นๆ ต้องเป็นตารางสเปคละเอียดเต็มรูปแบบนี้เสมอ
- หากลูกค้าถามเรื่องเคลม/รับประกัน ให้ย้ำช่องทางติดต่อและระยะเวลารับประกันที่พบใน context
- **ห้ามบอกราคาสินค้าทุกกรณี** ถ้าลูกค้าถามราคา ให้ชวนดูที่ลิงก์สินค้าหรือทักแอดมิน
- อย่าเสนอสินค้าที่ status != "NORMAL" ให้ลูกค้า (ยกเว้นตอบคำถามเคลมของสินค้าเดิม)
- **สำคัญมาก**: สินค้าที่ status != "NORMAL" (เช่น UNLIST, SELLER_DELETE) เลิกขายแล้ว
  - ห้ามแสดงราคา ห้ามแสดงลิงก์สั่งซื้อ ห้ามเสนอขาย
  - ถ้าลูกค้าถามรับประกันของสินค้าที่ status != NORMAL ให้ตอบเฉพาะเงื่อนไขรับประกัน แล้วบอกว่า "รุ่นนี้เลิกขายแล้ว"
  - ถ้าลูกค้าอยากซื้อ ให้แนะนำสินค้า status=NORMAL รุ่นอื่นแทน
- **สำคัญมากเรื่อง stock**: เสนอขาย/แนะนำเฉพาะสินค้าที่ status=NORMAL เท่านั้น
  ถ้าสินค้า status=NORMAL แต่ไม่มี stock (สินค้าหมด) → ห้ามเสนอขาย ให้บอกลูกค้าว่า "รุ่นนี้หมดสต็อกชั่วคราวค่ะ" แล้วแนะนำรุ่นอื่นแทน
  ถ้าไม่แน่ใจว่ามี stock หรือไม่ → อย่าบอก "พร้อมส่ง" ให้บอก "สอบถามสต็อกได้ที่แอดมินค่ะ"
- ถ้ามี field `_context_note` ใน product card ให้อ่านและทำตามคำสั่งในนั้นด้วย

การแสดงรูปสินค้า (สำคัญมาก — บังคับ):
- **ทุกครั้งที่แนะนำ/เสนอ/เชียร์ขายสินค้ารายใด ต้องแทกรูปของสินค้านั้นด้วย** markdown image syntax:
  `![ชื่อสั้น](image_url)`
  โดยใช้ค่าจาก field `image_url` ใน product card ของสินค้านั้น
- **ห้ามแนะนำสินค้าโดยไม่มีรูป** ถ้า `image_url` มีค่าอยู่ ต้องแสดงรูปเสมอ
- ถ้าแนะนำหลายสินค้า แต่ละสินค้าต้องมีรูปของตัวเอง (ใน bubble แยกของสินค้านั้น)
- **สำคัญ**: alt text (ข้อความใน `[...]`) ต้องเป็นชื่อสินค้าสั้นๆ เช่น "Xiaomi Redmi 9" หรือ "Redmi Note 11"
  ห้ามใช้ชื่อสินค้าเต็มที่มีวงเล็บเหลี่ยม `[...]` ข้างใน เพราะจะทำให้รูปไม่ขึ้น
  ตัวอย่างที่ผิด: `![[ลดเหลือ 3,599 บ.] Xiaomi Redmi 9](url)`
  ตัวอย่างที่ถูก: `![Xiaomi Redmi 9](url)`
- ถ้า `image_url` ว่าง ข้ามการแทกรูปไปได้เลลย ห้ามเดา URL รูปเอง
- วางรูปไว้ใต้ชื่อสินค้านั้น (ก่อนรายละเอียด/ราคา) หรือหลังบรรทัดแนะนำของสินค้านั้น
- ถ้าเป็นการเปรียบเทียบแบบตาราง ไม่ต้องใส่รูปในตาราง แต่ใส่รูปแยกใต้ตารางเรียงต่อกันได้เลย
- อย่าแทกรูปเกิน 1 รูปต่อสินค้า

=== การแบ่งคำตอบเป็นหลายข้อความ (multi-bubble) ===
เพื่อให้คุยเหมือนมนุษย์ คุณสามารถแบ่งคำตอบออกเป็น 1-3 ข้อความ แยกด้วย delimiter `|||`
- ข้อความที่ 1: ตอบคำถามหลักให้ตรงประเด็น กระชับ
  - ถ้าลูกค้าถามเฉพาะเจาะจง (เช่น "ขนาดหน้าจอ", "ราคา", "แบตกี่ mAh") → ตอบแค่ที่ถาม สั้นๆ
  - ห้าม dump สเปคทั้งหมดในข้อความแรก ถ้าลูกค้าถามแค่บางจุด
- ข้อความที่ 2 (ถ้ามี): เชียร์ขาย ถามความสนใจ แนะนำตัวเลือกอื่น หรือสเปคเพิ่มเติม
  - เสนอขายเฉพาะสินค้า status=NORMAL + มี stock
  - หรือแนะนำสินค้าอื่นที่เกี่ยวข้องก่อน แล้วค่อยเสนอขายทีหลัง
- ข้อความที่ 3 (นานๆ ครั้ง): ปิดด้วยน้ำเสียงเป็นมิตร เช่น "สอบถามเพิ่มเติมได้นะคะ"

กฎการแบ่ง:
- ใช้ `|||` คั่นระหว่างข้อความเท่านั้น (ไม่มี space รอบๆ)
- ถ้าคำถามสั้น/เฉพาะเรื่องมาก → ใช้ 1 ข้อความพอ (ตอบสั้นๆ)
- ถ้าคำถามเป็นการเปรียบเทียบ/ขอแนะนำ → ใช้ 2 ข้อความ (ข้อ 1 ตอบหลัก + ข้อ 2 เชียร์ขาย)
- ถ้าคำถามเฉพาะเจาะจง + อยากเชียร์ขาย → ใช้ 2 ข้อความ (ข้อ 1 ตอบสั้น + ข้อ 2 เชียร์ขาย)
- ห้ามใส่ `|||` นำหน้าหรือปิดท้ายข้อความ
- แต่ละข้อความต้องมีเนื้อหาครบ ไม่ใช่ประโยคถูกตัดครึ่ง
- ถ้าไม่แน่ใจว่าควรแบ่งไหม → ใช้ 1 ข้อความเดียว (ปลอดภัยกว่า)
- **อย่าบังคับแบ่งถ้าไม่จำเป็น — ตอบเป็นธรรมชาติ**
"""


# ---- API key rotation (round-robin) -------------------------------------------
# รองรับหลาย key เพื่อหลีกเลี่ยง rate limit
# อ่าน GEMINI_API_KEY_1 .. GEMINI_API_KEY_9 (หรือ GEMINI_API_KEY ตัวเดียวก็ได้)
# วนรอบทุกครั้งที่เรียก _client()

import itertools as _itertools

def _load_api_keys() -> list[str]:
    """โหลด API keys ทั้งหมดจาก env (GEMINI_API_KEY_1 .. _9, และ GEMINI_API_KEY)."""
    keys: list[str] = []
    # ลอง GEMINI_API_KEY_1 .. _9 ก่อน
    for i in range(1, 10):
        k = os.environ.get(f"GEMINI_API_KEY_{i}", "").strip()
        if k:
            keys.append(k)
    # fallback: GEMINI_API_KEY ตัวเดียว (ถ้าไม่มี _1.._9)
    if not keys:
        k = os.environ.get("GEMINI_API_KEY", "").strip()
        if k:
            keys.append(k)
    return keys


_API_KEYS: list[str] = _load_api_keys()
_KEY_CYCLE = _itertools.cycle(_API_KEYS) if _API_KEYS else None
_KEY_INDEX = 0

# debug log — ยืนยันว่าโหลด keys ครบ
import sys as _sys
print(f"[KEYS] โหลด API keys จำนวน: {len(_API_KEYS)}", file=_sys.stderr)
for i, k in enumerate(_API_KEYS):
    print(f"[KEYS]   key[{i}] = {k[:8]}...{k[-4:]}", file=_sys.stderr)


def _next_api_key() -> str:
    """หา key ถัดไปแบบ round-robin."""
    global _KEY_INDEX
    if not _API_KEYS:
        raise RuntimeError("ไม่พบ GEMINI_API_KEY หรือ GEMINI_API_KEY_1..9 ใน .env")
    key = next(_KEY_CYCLE)
    _KEY_INDEX = (_KEY_INDEX + 1) % len(_API_KEYS)
    return key


def _client() -> genai.Client:
    api_key = _next_api_key()
    return genai.Client(api_key=api_key)


# ---- multi-bubble segment splitter (Phase 1) --------------------------------
# LLM แยกคำตอบด้วย delimiter ||| — helper นี้แยกเป็น list[str] ที่สะอาด
_SEGMENT_DELIMITER = "|||"


def split_segments(answer: str) -> list[str]:
    """แยกคำตอบ LLM ที่มี delimiter ||| เป็น list ของ segment ที่สะอาด.

    - ถ้าไม่มี ||| → คืน [answer] (1 segment เดียวกับ answer ตัวเดิม)
    - ถ้ามี ||| → แยก, trim, ตัด segment ว่างออก, รวม segment ที่ถูก split ผิดกลับ
    - รักษา newline/markdown ภายในแต่ละ segment ไว้
    """
    if not answer:
        return []
    if _SEGMENT_DELIMITER not in answer:
        return [answer.strip()] if answer.strip() else []
    parts = answer.split(_SEGMENT_DELIMITER)
    cleaned: list[str] = []
    for p in parts:
        s = p.strip()
        if s:
            cleaned.append(s)
    return cleaned or [answer.strip()]


def _build_context(products: list[dict], shop_hint: str | None = None,
                    include_description: bool = False) -> str:
    """pack product cards เป็น context text สำหรับใส่ใน prompt.

    ตัด field ที่ไม่จำเป็นออกเพื่อลด token:
    - description_excerpt ส่งเฉพาะตอน include_description=True (เช่น ถามเรื่องรับประกัน)
    - weight/dimension ส่งเฉพาะตอน include_description=True
    """
    if not products:
        body = "ไม่พบสินค้าที่ตรงกับคำถามในฐานข้อมูล"
    else:
        slim_fields = (
            "name", "shop", "warranty", "short_link", "image_url",
            "has_promotion", "is_flash_sale", "variants", "tier_variation",
            "brand", "category", "sold_out", "total_stock", "status",
        )
        # ฟิลด์จาก KB (ถ้า merge แล้ว)
        kb_fields = ("kb_highlights", "kb_specs", "kb_box_contents", "_source", "_kb_only")
        slim = []
        for p in products:
            card = {k: p[k] for k in slim_fields if k in p}
            # ใส่ฟิลด์ KB ถ้ามี
            for kf in kb_fields:
                if kf in p:
                    card[kf] = p[kf]
            # ใส่ _context_note ถ้ามี (fallback note)
            if "_context_note" in p:
                card["_context_note"] = p["_context_note"]
            # ใส่ _warranty_calc ถ้ามี (warranty date follow-up)
            if "_warranty_calc" in p:
                card["_warranty_calc"] = p["_warranty_calc"]
            # ใส่ description/weight/dimension เฉพาะตอนจำเป็น
            if include_description:
                if "description_excerpt" in p:
                    desc = p["description_excerpt"]
                    if desc and desc.strip():
                        card["description_excerpt"] = desc
                    else:
                        card["description_excerpt"] = "(ไม่มีรายละเอียดสินค้าเพิ่มเติม)"
                        # เพิ่ม context_note ชัดๆ ว่าห้ามเอา desc สินค้าอื่นมาตอบ
                        existing_note = card.get("_context_note", "")
                        no_desc_note = "สินค้านี้ไม่มีรายละเอียดเพิ่มเติม ห้ามอ้างอิง description_excerpt ของสินค้าอื่นมาตอบสินค้านี้เด็ดขาด ให้บอกลูกค้าว่าขออภัย สินค้ารุ่นนี้ไม่มีรายละเอียดเพิ่มเติม ทักแอดมินได้เลยนะคะ"
                        card["_context_note"] = (existing_note + " " + no_desc_note).strip() if existing_note else no_desc_note
                if "weight" in p:
                    card["weight"] = p["weight"]
                if "dimension" in p:
                    card["dimension"] = p["dimension"]
            slim.append(card)
        body = json.dumps(slim, ensure_ascii=False, indent=2)
    header = "ข้อมูลสินค้าที่เกี่ยวข้อง (จาก MongoDB ของร้านในเครือ):\n"
    if shop_hint:
        header += f"ลูกค้าทักจากร้าน: {shop_hint}\n"
        header += (
            f"⚠️ สำคัญอย่างยิ่ง: ลูกค้าทักเข้ามาที่ร้าน {shop_hint} โดยเฉพาะ "
            f"ให้ตอบเฉพาะสินค้าจากร้าน {shop_hint} เท่านั้น "
            f"ห้ามเสนอ/แนะนำ/เปรียบเทียบสินค้าจากร้านอื่นในเครือเด็ดขาด "
            f"ถ้าร้าน {shop_hint} ไม่มีสินค้าที่ลูกค้าถาม ให้บอกตรงๆ ว่าร้านนี้ไม่มี "
            f"แล้วแนะนำสินค้าอื่นจากร้าน {shop_hint} ที่ใกล้เคียงที่สุดแทน "
            f"อย่าตอบสั้นๆ ว่า 'ไม่มี' แล้วจบ — ต้องเสนอทางเลือกจากร้าน {shop_hint} เสมอ\n"
        )
    header += f"จำนวนสินค้าใน context: {len(products)}\n"
    # ถ้ามีสินค้าที่ไม่มี description_excerpt → เตือน LLM ชัดๆ
    no_desc_count = sum(1 for p in products if not (p.get("description_excerpt") or "").strip())
    has_desc_count = len(products) - no_desc_count
    if include_description and no_desc_count > 0 and has_desc_count > 0:
        header += (
            f"⚠️ สำคัญมาก: มี {no_desc_count} สินค้าที่ไม่มี description_excerpt "
            f"(ระบุว่า 'ไม่มีรายละเอียดสินค้าเพิ่มเติม') "
            f"ห้ามเอา description_excerpt ของสินค้าอื่นมาตอบแทนสินค้าเหล่านั้นเด็ดขาด "
            f"แม้จะเป็นสินค้ารุ่นเดียวกันจากร้านอื่นก็ตาม "
            f"ถ้าลูกค้าถามรายละเอียดของสินค้าที่ไม่มี desc ให้บอก "
            f"'ขออภัยค่ะ สินค้ารุ่นนี้ไม่มีรายละเอียดเพิ่มเติม ทักแอดมินได้เลยนะคะ'\n"
        )
    header += "\n"
    return header + body


def answer(
    message: str,
    products: list[dict],
    shop_hint: str | None = None,
    history: list[dict] | None = None,
    model: str | None = None,
    persona_extra: str = "",
    intent_result: dict | None = None,
    extra_context: str = "",
) -> str:
    """สร้างคำตอบจาก Gemini โดยใช้ products เป็น context.

    Args:
        message: คำถามลูกค้ารอบปัจจุบัน
        products: product cards ที่กรองแล้ว
        shop_hint: ชื่อร้านที่ลูกค้าทักเข้ามา (ถ้ามี)
        history: ประวัติแชทก่อนหน้า [{"role":"user","text":"..."},{"role":"model","text":"..."}]
        model: ชื่อโมเดล Gemini (default จาก env GEMINI_MODEL หรือ gemini-2.0-flash)
        persona_extra: instruction เพิ่มเติมจาก persona ของร้าน (ชื่อตัวแทนบอท)
                       ถ้าว่าง = ใช้ SYSTEM_INSTRUCTION เดิม (default behavior)
        intent_result: ผลจาก Pass 1 intent classification (ถ้ามี) — ใช้กำหนด include_desc
    """
    try:
        client = _client()
    except RuntimeError as exc:
        return f"ขออภัย ระบบแชทบอทขัดข้องชั่วคราว ({exc}) กรุณาติดต่อแอดมินนะคะ", {"prompt": 0, "output": 0, "total": 0}
    model_name = (model or os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")).strip()
    system_instruction = SYSTEM_INSTRUCTION + persona_extra if persona_extra else SYSTEM_INSTRUCTION

    # ตรวจว่าคำถามเกี่ยวกับรับประกัน/เคลม/สเปก/รายละเอียดไหม
    # ถ้าใช่ส่ง description ให้ LLM ด้วย
    desc_kw = (
        "รับประกัน", "ประกัน", "เคลม", "warranty", "claim", "ศูนย์", "ซ่อม", "เปลี่ยน",
        "สเปก", "spec", "specification", "รายละเอียด", "detail", "ข้อมูลสินค้า",
        "จอ", "กล้อง", "แบตเตอรี่", "cpu", "ram", "rom", "ความจุ", "หน่วยความจำ",
        "ระบบปฏิบัติการ", "เชื่อมต่อ", "เครือข่าย", "สี", "ขนาด", "น้ำหนัก",
        "อุปกรณ์ในกล่อง", "ในกล่อง", "box", "อุปกรณ์", "accessories",
        "ของแถม", "แถม", "gift", "free", "โปรโมชัน", "promotion",
        "เปรียบเทียบ", " vs ", "เทียบ", "compare", "เทียบกับ",
    )
    # ถ้ามี intent_result จาก Pass 1 → ใช้ needs_description จาก LLM
    # (LLM เข้าใจได้ดีกว่า keyword matching — รองรับรุ่นเก่า/แบรนด์ใหม่ที่ไม่มีใน list)
    if intent_result and intent_result.get("confidence", 0) >= 0.7:
        include_desc = bool(intent_result.get("needs_description", False))
        print(f"[LLM] include_desc from intent: {include_desc}  (intent={intent_result.get('intent')})", file=_sys.stderr)
    else:
        # fallback: ใช้ keyword matching เดิม (กรณีไม่ได้เรียก Pass 1)
        include_desc = any(kw in message.lower() for kw in desc_kw)

    context = _build_context(products, shop_hint=shop_hint,
                             include_description=include_desc)
    # เน้นย้ำว่าให้ตอบจาก context ปัจจุบันเท่านั้น อย่าอ้างอิง history
    user_prompt = (
        f"{context}\n\n"
    )
    if extra_context:
        user_prompt += f"{extra_context}\n\n"
    user_prompt += (
        f"คำถามของลูกค้า: {message}\n\n"
        f"สำคัญมาก: ตอบจากข้อมูลสินค้าใน context ด้านบนเท่านั้น "
        f"ห้ามอ้างอิงสินค้าจากคำตอบก่อนหน้าหรือ history "
        f"สินค้าที่ตรงกับคำถามมากที่สุดอยู่ลำดับแรกของ context"
    )

    contents: list[Any] = []
    if history:
        for h in history:
            role = h.get("role", "user")
            text = h.get("text", "")
            if role not in ("user", "model"):
                role = "user"
            # สำหรับคำตอบ model ก่อนหน้า ให้ส่งแค่สรุปสั้นๆ ไม่ส่ง full answer
            # เพื่อป้องกัน LLM อ้างอิงสินค้าจากคำตอบเดิมแทน context ปัจจุบัน
            if role == "model" and len(text) > 200:
                text = text[:200] + "... (คำตอบก่อนหน้า อย่าอ้างอิงสินค้าจากนี้)"
            contents.append({"role": role, "parts": [{"text": text}]})
    contents.append({"role": "user", "parts": [{"text": user_prompt}]})

    # DEBUG: log context ที่ส่ง LLM
    import sys
    print(f"\n[LLM DEBUG] message={message!r}", file=sys.stderr)
    print(f"[LLM DEBUG] products={len(products)}", file=sys.stderr)
    for i, p in enumerate(products[:20]):
        print(f"[LLM DEBUG]   [{i}] {p.get('shop','?')[:15]}  {p.get('name','')[:50]}", file=sys.stderr)
    print(f"[LLM DEBUG] include_desc={include_desc}", file=sys.stderr)
    print(f"[LLM DEBUG] history_len={len(history) if history else 0}", file=sys.stderr)
    if history:
        for i, h in enumerate(history):
            print(f"[LLM DEBUG]   hist[{i}] role={h.get('role')} text={h.get('text','')[:60]!r}", file=sys.stderr)
    print(f"[LLM DEBUG] context (first 500): {context[:500]!r}", file=sys.stderr)

    usage_info = {"prompt": 0, "output": 0, "total": 0}
    try:
        resp = client.models.generate_content(
            model=model_name,
            contents=contents,
            config={
                "system_instruction": system_instruction,
                "temperature": 0.3,
                "max_output_tokens": 4096,
            },
        )
    except genai_errors.ClientError as exc:
        return f"ขออภัย ระบบ LLM ติดขัด ลองใหม่อีกครั้ง ({exc})", usage_info
    except Exception as exc:
        return f"ขออภัย เกิดข้อผิดพลาดในการเรียก LLM ({exc})", usage_info

    # log token usage (ถ้ามี) เพื่อคำนวณต้นทุน
    usage = getattr(resp, "usage_metadata", None)
    if usage:
        prompt_t = getattr(usage, "prompt_token_count", 0) or 0
        output_t = getattr(usage, "candidates_token_count", 0) or 0
        total_t = getattr(usage, "total_token_count", 0) or (prompt_t + output_t)
        usage_info = {"prompt": prompt_t, "output": output_t, "total": total_t}
        print(f"[LLM] model={model_name}  prompt={prompt_t}  output={output_t}  total={total_t}  products={len(products)}")

    return (resp.text or "").strip(), usage_info


# ---- KB-based answer ----

KB_SYSTEM_INSTRUCTION = """คุณเป็นผู้ช่วยขายหญิงที่เป็นมิตรและสุภาพ ให้คำปรึกษาสินค้ากับกลุ่มร้านค้าออนไลน์ในเครือเครือข่ายเรา

บุคลิกและน้ำเสียง:
- คุณเป็นผู้หญิง ใช้คำลงท้ายประโยคเป็น "ค่ะ" "นะคะ" "คะ" เท่านั้น
- ห้ามใช้ "ครับ" "คับ" "ครับผม" หรือคำลงท้ายผู้ชายทุกรูปแบบ
- สุภาพ เป็นมิตร อ่อนโยน แต่กระชับ ไม่เยิ่นเย้อ

หน้าที่ของคุณ:
1. ตอบคำถามลูกค้าเกี่ยวกับสินค้าจาก Knowledge Base ที่ให้มา
2. อธิบายเรื่องการเคลมและการรับประกันตามข้อมูลใน context

กฎการตอบ:
- ตอบเป็นภาษาเดียวกับลูกค้า (ส่วนใหญ่คือภาษาไทย) สุภาพ เป็นมิตร กระชับ
- อ้างอิงเฉพาะข้อมูลใน context ที่ให้มาในรอบนี้เท่านั้น ห้าม invent ข้อมูลที่ไม่มี
- ถ้า context ไม่พอตอบ ให้บอกตรงๆ ว่าขอแนะนำให้ทักแอดมินร้าน
- **ห้ามบอกราคาสินค้าทุกกรณี** ถ้าลูกค้าถามราคา ให้บอกว่าสอบถามราคาได้ที่แอดมิน

กฎสำคัญสำหรับการตอบจาก Knowledge Base:
- ถ้าลูกค้าถามแค่ชื่อรุ่น (ไม่ระบุ topic) → ตอบ ชื่อสินค้า + รายละเอียดสั้นๆ + จุดเด่น
  **ห้ามบอกราคา** (KB ไม่มีข้อมูลราคา และลูกค้าไม่ได้ถาม)
- **ถ้าลูกค้าถามแค่ "รับประกันกี่ปี/กี่เดือน" (duration question เฉพาะเจาะจง)**:
  ตอบสั้นๆ 1-2 ประโยค เช่น "สินค้า X รับประกัน 1 ปีค่ะ" หรือ "รับประกัน 2 ปีค่ะ"
  ห้ามเพิ่มเงื่อนไขรับประกันทั่วไป ห้ามถามวันที่ซื้อ ห้ามชวนเคลม — ตอบแค่ duration
- ถ้าลูกค้าถามเรื่องรับประกันแบบกว้างๆ (ไม่ใช่แค่ duration) → ตอบเฉพาะเรื่องรับประกัน
  - ถ้ามีเงื่อนไขรับประกันทั่วไปใน context → รวมไว้ด้วย
  - ถ้าสินค้าไม่มีข้อมูลรับประกัน → บอกว่า "ไม่มีข้อมูลการรับประกันสำหรับรุ่นนี้"
- ถ้าลูกค้าถามเรื่องสเปก → ตอบเฉพาะสเปกที่มีใน context
- ถ้าลูกค้าถามเรื่องอุปกรณ์ในกล่อง → ตอบเฉพาะอุปกรณ์ที่มีใน context
- ตอบกระชับ ไม่ต้องยาวเกินไป — ใช้ข้อมูลเท่าที่จำเป็น
"""


def answer_with_kb(
    message: str,
    kb_context: str,
    history: list[dict] | None = None,
    model: str | None = None,
    persona_extra: str = "",
) -> str:
    """สร้างคำตอบจาก Gemini โดยใช้ KB context (ไม่ใช้ product_store).

    Args:
        message: คำถามลูกค้ารอบปัจจุบัน
        kb_context: context ที่ format แล้วจาก knowledge_base.format_kb_context()
        history: ประวัติแชทก่อนหน้า
        model: ชื่อโมเดล Gemini
        persona_extra: instruction เพิ่มเติมจาก persona ของร้าน (ชื่อตัวแทนบอท)
    """
    try:
        client = _client()
    except RuntimeError as exc:
        return f"ขออภัย ระบบแชทบอทขัดข้องชั่วคราว ({exc}) กรุณาติดต่อแอดมินนะคะ"
    model_name = (model or os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")).strip()
    system_instruction = KB_SYSTEM_INSTRUCTION + persona_extra if persona_extra else KB_SYSTEM_INSTRUCTION

    user_prompt = f"{kb_context}\n\nคำถามของลูกค้า: {message}"

    contents: list[Any] = []
    if history:
        for h in history:
            role = h.get("role", "user")
            text = h.get("text", "")
            if role not in ("user", "model"):
                role = "user"
            contents.append({"role": role, "parts": [{"text": text}]})
    contents.append({"role": "user", "parts": [{"text": user_prompt}]})

    try:
        resp = client.models.generate_content(
            model=model_name,
            contents=contents,
            config={
                "system_instruction": system_instruction,
                "temperature": 0.3,
                "max_output_tokens": 2048,
            },
        )
    except genai_errors.ClientError as exc:
        return f"ขออภัย ระบบ LLM ติดขัด ลองใหม่อีกครั้ง ({exc})"
    except Exception as exc:
        return f"ขออภัย เกิดข้อผิดพลาดในการเรียก LLM ({exc})"

    usage = getattr(resp, "usage_metadata", None)
    if usage:
        prompt_t = getattr(usage, "prompt_token_count", 0) or 0
        output_t = getattr(usage, "candidates_token_count", 0) or 0
        total_t = getattr(usage, "total_token_count", 0) or (prompt_t + output_t)
        print(f"[LLM-KB] model={model_name}  prompt={prompt_t}  output={output_t}  total={total_t}")

    return (resp.text or "").strip()


def answer_general(
    message: str,
    context: str,
    qtype: str,
    history: list[dict] | None = None,
    model: str | None = None,
    shop_hint: str | None = None,
    persona_extra: str = "",
) -> tuple[str, dict]:
    """สร้างคำตอบสำหรับคำถามทั่วไป (policy/brands/categories/shops/brand_info).

    Args:
        message: คำถามลูกค้า
        context: context ที่ดึงมาจาก KB/Mongo (policy text, brand list, etc.)
        qtype: ประเภทคำถาม (warranty_policy, brands, etc.)
        history: ประวัติแชท
        model: ชื่อโมเดล Gemini
        shop_hint: ถ้าระบุ (ลูกค้าทักมาจากร้านนี้) บังคับให้ตอบเฉพาะขอบเขตร้านนี้
            ห้ามพูดถึงสินค้า/หมวดหมู่ของร้านอื่นในเครือ
        persona_extra: instruction เพิ่มเติมจาก persona ของร้าน (ชื่อตัวแทนบอท)

    คืน (answer, usage_info).
    """
    try:
        client = _client()
    except RuntimeError as exc:
        return f"ขออภัย ระบบแชทบอทขัดข้องชั่วคราว ({exc}) กรุณาติดต่อแอดมินนะคะ", {}
    model_name = (model or os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")).strip()

    general_instruction = (
        "คุณเป็นพนักงานบริการลูกค้าหญิงของร้านค้าออนไลน์ในเครือ Shopee "
        "ตอบลูกค้าเป็นภาษาไทย สุภาพ ยิ้มแย้ม กระชับ และเป็นมิตร "
        "ลงท้ายประโยคด้วย 'ค่ะ' 'นะคะ' หรือ 'คะ' เท่านั้น ห้ามใช้ 'ครับ' หรือ 'คับ' "
        "ตอบจากข้อมูลใน context ที่ให้เท่านั้น ห้ามแต่งเรื่อง "
        "ถ้า context ไม่พอตอบ ให้บอกลูกค้าว่าทักแอดมินได้เลยนะคะ "
        "ตอบเป็นข้อๆ ให้อ่านง่าย ไม่ต้องยาวเกินไป "
        "ห้ามใช้คำสร้อยฟุ่มเฟือยที่ไม่มีข้อมูลจริง"
    )
    if shop_hint and qtype in ("categories", "brands", "brand_info"):
        general_instruction += (
            f" ลูกค้ากำลังทักแชทเข้ามาที่ร้าน {shop_hint} โดยเฉพาะ "
            "context ที่ให้มาเป็นข้อมูลของร้านนี้เท่านั้น "
            "ห้ามพูดถึงสินค้าหรือหมวดหมู่ของร้านอื่นในเครือเด็ดขาด "
            "ให้แนะนำสินค้าเด่นของร้านนี้สัก 2-3 ชิ้นก่อน แล้วค่อยสรุปว่าร้านนี้ขายหมวดหมู่อะไรบ้าง"
        )
    if persona_extra:
        general_instruction += persona_extra

    user_prompt = f"{context}\n\nคำถามของลูกค้า: {message}"

    contents: list[Any] = []
    if history:
        for h in history:
            role = h.get("role", "user")
            text = h.get("text", "")
            if role not in ("user", "model"):
                role = "user"
            contents.append({"role": role, "parts": [{"text": text}]})
    contents.append({"role": "user", "parts": [{"text": user_prompt}]})

    try:
        resp = client.models.generate_content(
            model=model_name,
            contents=contents,
            config={
                "system_instruction": general_instruction,
                "temperature": 0.3,
                "max_output_tokens": 2048,
            },
        )
    except genai_errors.ClientError as exc:
        return f"ขออภัย ระบบ LLM ติดขัด ลองใหม่อีกครั้ง ({exc})", {}
    except Exception as exc:
        return f"ขออภัย เกิดข้อผิดพลาดในการเรียก LLM ({exc})", {}

    usage = getattr(resp, "usage_metadata", None)
    usage_info: dict = {}
    if usage:
        prompt_t = getattr(usage, "prompt_token_count", 0) or 0
        output_t = getattr(usage, "candidates_token_count", 0) or 0
        total_t = getattr(usage, "total_token_count", 0) or (prompt_t + output_t)
        usage_info = {"prompt": prompt_t, "output": output_t, "total": total_t}
        print(f"[LLM-General] qtype={qtype}  model={model_name}  prompt={prompt_t}  output={output_t}  total={total_t}", file=sys.stderr)

    return (resp.text or "").strip(), usage_info
