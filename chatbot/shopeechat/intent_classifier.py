"""Pass 1: LLM Intent Classification (ใช้ flash-lite เพื่อความเร็ว).

เรียก LLM รอบแรกเพื่อจำแนก intent ของลูกค้าก่อนเข้า RAG
ใช้เฉพาะใน "จุดอ่อน" ของ hardcoded detection:
  1. detect_claim_request() = True (อาจเป็น false positive)
  2. มี compatibility keyword ("ใช้กับ", "รองรับ", "สำหรับ")
  3. product_type detection ไม่ชัดเจน
  4. มี history ของ warranty + message ปัจจุบันกำกวม

คืน dict:
  {
    "intent": "product_recommend|product_spec|compatibility_check|
               warranty_duration|warranty_claim|general_question|
               greeting|other",
    "product_type": "phone|charger|earphone|smartwatch|powerbank|case|speaker|other|null",
    "charger_subtype": "cable|adapter|set|car_charger|wireless|desktop|socket|null",
    "target_device": "iphone 4s|samsung s25 ultra|null",
    "relation_target": "ชื่อคู่ความสัมพันธ์ที่ลูกค้าระบุในข้อความ|null",
    "capability_asks": ["ข้อความตรงจากคำถามลูกค้าที่ถามว่าสินค้าทำ/มีไหม"],
    "needs_description": bool,
    "general_qtype": "warranty_policy|return_policy|shipping_policy|brands|categories|shops|tax_invoice|null",
    "confidence": 0.0-1.0,
  }
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any


_INTENT_PROMPT = """คุณเป็นระบบจำแนกความต้องการของลูกค้า (intent classifier) สำหรับแชทบอทร้านขายของออนไลน์
อ่านคำถามของลูกค้าและประวัติการแชทล่าสุด แล้วจำแนก intent ตอบเป็น JSON เท่านั้น

intent ที่เป็นไปได้:
- "product_recommend": ลูกค้าอยากให้แนะนำ/ดูสินค้า (เช่น "มีสายชาร์จไหม", "หัวชาร์จ 65w รุ่นไหนดี", "อยากได้หูฟัง")
- "product_spec": ลูกค้าถามสเปก/รายละเอียด/ราคาสินค้าเฉพาะรุ่น (เช่น "CTC615W สเปกอะไร", "ราคาเท่าไหร่")
- "compatibility_check": ลูกค้าถามว่าสินค้าใช้กับ/รองรับอุปกรณ์อะไรได้ไหม (เช่น "สายชาร์จใช้กับ iphone 4s ได้ไหม", "หัวชาร์จรองรับ samsung s25 ultra ไหม")
- "warranty_duration": ลูกค้าถามแค่ระยะเวลารับประกัน (เช่น "CTC615W รับประกันกี่ปี", "รับประกันนานแค่ไหน")
- "warranty_claim": ลูกค้าแจ้งเคลม/ซ่อม/สินค้าเสีย/อยากส่งเคลม (เช่น "สินค้าเสีย", "เคลมยังไง", "พัง", "ไม่ทำงาน", "อยากซ่อม")
- "general_question": ถามนโยบายร้าน/จัดส่ง/รับคืน/แบรนด์/หมวดหมู่/ใบกำกับภาษี (เช่น "ส่งกี่วัน", "มีรับคืนไหม", "นโยบายรับประกัน", "ออกใบกำกับภาษีได้ไหม")
- "greeting": ทักทาย/สังคม/ตอบรับสั้นๆ ที่ไม่มีคำถามหรือความต้องการสินค้า (เช่น "สวัสดีครับ", "ขอบคุณค่ะ", "ok", "ดีจ้า")
- "other": ไม่เข้ากรณีใดข้างต้น

product_type ที่เป็นไปได้ (ถ้าเป็นคำถามเกี่ยวกับสินค้า):
- "phone": โทรศัพท์มือถือ/smartphone
- "charger": อุปกรณ์ชาร์จ (สายชาร์จ/หัวชาร์จ/ชุดชาร์จ/แท่นชาร์จ)
- "earphone": หูฟัง/earbuds/TWS
- "smartwatch": สมาร์ทวอช/นาฬิกา
- "powerbank": แบตเตอรี่สำรอง/พาวเวอร์แบงค์
- "case": เคส/ซอง/ฟิล์ม
- "speaker": ลำโพง
- "other": สินค้าอื่นๆ
- null: ไม่ใช่คำถามเกี่ยวกับสินค้า

charger_subtype (ถ้า product_type=charger):
- "cable": สายชาร์จ
- "adapter": หัวชาร์จ/adapter (หัวชาร์จบ้าน/พกพา ทั่วไป)
- "set": ชุดชาร์จ (หัว+สาย หรือ หัว+สาย+พาวเวอร์แบงค์)
- "car_charger": หัวชาร์จในรถ/ที่ชาร์จในรถ (Car Charger)
- "wireless": แท่นชาร์จไร้สาย/MagSafe/Qi
- "desktop": แท่นชาร์จตั้งโต๊ะ/charging station
- "socket": ปลั๊กไฟอัจฉริยะ/smart plug
- null: ไม่ระบุ

target_device: ถ้าลูกค้าระบุอุปกรณ์ที่จะใช้งานด้วย (เช่น "iphone 4s", "samsung s25 ultra", "macbook", "xiaomi 17 ultra") หรือ null
  ⚠️ สกัด target_device ทุกครั้งที่ลูกค้าระบุอุปกรณ์เป้าหมาย ไม่ว่า intent จะเป็นอะไร
  (เช่น product_recommend + "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → target_device="xiaomi 17 ultra")
  ไม่ใช่เฉพาะ compatibility_check เท่านั้น
  ⚠️ target_device คืออุปกรณ์คู่ที่ใช้ร่วมกับสินค้าเท่านั้น — ห้ามใส่ตัวสินค้าที่ลูกค้าถามถึงเอง
  (สินค้าที่ถามไม่ใช่ counterpart ของตัวเอง; ฟังก์ชัน/ความสามารถที่ถาม → capability_asks แทน)

relation_target: ถ้าลูกค้าถามความเข้ากันได้/การเชื่อมต่อ/การใช้ร่วมกับ "สิ่ง" ที่ระบุชื่อไว้ในข้อความ
  ให้คัดชื่อนั้นตามที่ลูกค้าเขียน (อุปกรณ์ แอป บริการ หรือรุ่นสินค้าก็ได้) — หรือ null ถ้าไม่มี
  - ต้องเป็นข้อความที่ลูกค้าเขียนจริงเท่านั้น ห้ามเดาหรือแต่งชื่อเอง
  - ถ้าเป็นอุปกรณ์ ใส่ใน target_device ด้วยตามกติกาเดิม (relation_target = ชื่อดิบ ไม่ normalize)
  - เช่น "w01 รองรับ strava ไหม" → relation_target="strava"; "ใช้กับ iphone 15" → "iphone 15"
  - ไม่ใส่ spec value (ip68/65w/pd3.1/usb) และไม่ใส่คำกริยา/คำถาม

device_connector: ถ้า target_device ไม่เป็น null ให้ระบุพอร์ตชาร์จของอุปกรณ์นั้น หรือ null ถ้าไม่ทราบ
  ค่าที่เป็นไปได้: "usb-c", "lightning", "micro-usb", null
  - iPhone 15 ขึ้นไป → "usb-c"
  - iPhone 12-14 → "lightning"
  - Samsung/Xiaomi/OPPO/Vivo/Realme ส่วนใหญ่ → "usb-c"
  - iPad Pro/Air (2018+) → "usb-c"
  - MacBook → "usb-c"
  - โทรศัพท์เก่ากว่า iPhone 12 → "lightning"

device_min_watt: ถ้า target_device ไม่เป็น null ให้ระบุค่า W ขั้นต่ำที่อุปกรณ์รองรับชาร์จเต็มสปีด หรือ null ถ้าไม่ทราบ
  - iPhone 12-17 → 20-27
  - Samsung S series Ultra → 45
  - Xiaomi 17 Ultra → 90
  - MacBook Air → 70
  - MacBook Pro 14 → 96, MacBook Pro 16 → 140

needs_description: true ถ้าต้องดึง description สินค้ามาตอบ (เช่น compatibility_check, product_spec, warranty_duration) มิฉะนั้น false

requested_facts: list ของข้อเท็จจริงสินค้าที่ลูกค้าถาม (closed set; ไม่มี → [])
- "price": ราคา · "stock": สต็อก/มีของไหม · "link": ลิงก์สินค้า
- "description": รายละเอียด/สเปกทั่วไป · "warranty": ระยะเวลารับประกัน
- "data_transfer_speed": ความเร็วถ่ายโอนข้อมูล (Mbps/Gbps)
- "charging_speed": ความเร็วชาร์จ/กำลังไฟ (W) · "compatibility": ความเข้ากันได้
⚠️ "เท่าไหร่/กี่" ไม่ได้แปลว่าราคาเสมอ — ใส่ "price" เฉพาะเมื่อลูกค้าถามราคาจริง
   ("speed data เท่าไหร่" → ["data_transfer_speed"] ไม่ใช่ price)

spec_constraints: list ของเงื่อนไขสเปกเชิงตัวเลขที่ลูกค้ากำหนด — [{"field","op","value"}]
- field: "data_transfer_mbps" (ความเร็วข้อมูล — normalize หน่วยเอง: 10Gbps→10000,
  480Mbps→480), "output_power_w" (กำลังไฟ W), "capacity_mah", "cable_length_m"
- op: "gte"|"lte"|"gt"|"lt"|"eq"  (gte=ขึ้นไป/อย่างน้อย, lte=ไม่เกิน/ลงไป)
- value: ตัวเลขในหน่วย canonical ของ field นั้น
- ไม่มีเงื่อนไขเชิงตัวเลข → []

required_features: list ของคุณสมบัติสินค้าที่ลูกค้าบังคับ (closed set; ไม่มี → [])
- "magnetic": สายแม่เหล็ก/หัวแม่เหล็ก/ข้อต่อแม่เหล็ก (magnetic connector/cable)

capability_asks: list ของความสามารถ/ฟังก์ชันที่ลูกค้าถามว่าสินค้าทำได้หรือมีไหม (ไม่มี → [])
- เช่น "ตัดเสียงรบกวนตอนคุยโทร", "ปรับเพลงจากตัวอุปกรณ์", "กันน้ำ", "โทรออกได้"
- ต้องคัดเป็นข้อความตรงจากคำถามลูกค้าเท่านั้น (exact excerpt — ห้าม paraphrase/แต่งเพิ่ม/แปล)
- ห้ามซ้ำสิ่งที่สกัดไปแล้วใน relation_target/target_device หรือ requested_facts/
  required_features/spec_constraints — capability_asks เก็บเฉพาะส่วนที่เหลือ
- ไม่ใช่ spec ตัวเลข (→ spec_constraints), ไม่ใช่ข้อเท็จจริงมาตรฐาน (→ requested_facts),
  ไม่ใช่คู่เชื่อมต่อ/อุปกรณ์/แอปที่ระบุชื่อ (→ target_device/relation_target)

general_qtype: ถ้า intent=general_question ระบุประเภทคำถามทั่วไป (ถ้าไม่ใช่ general_question → null)
- "warranty_policy": ถามนโยบาย/เงื่อนไขรับประกัน (เช่น "รับประกันกี่ปี", "มีประกันไหม", "เคลมยังไง")
- "return_policy": ถามนโยบายรับคืน/เปลี่ยนสินค้า (เช่น "รับคืนไหม", "เปลี่ยนสินค้าได้ไหม")
- "shipping_policy": ถามนโยบายจัดส่ง/เวลาส่ง (เช่น "ส่งกี่วัน", "เมื่อไหร่ได้ของ")
- "brands": ถามแบรนด์ที่มี (เช่น "มีแบรนด์อะไรบ้าง", "มียี่ห้ออะไร")
- "categories": ถามหมวดหมู่สินค้า (เช่น "ขายอะไรบ้าง", "มีหมวดหมู่อะไร")
- "shops": ถามร้านในเครือ (เช่น "มีร้านอะไรบ้าง", "ร้านในเครือ")
- "tax_invoice": ขอใบกำกับภาษี/ส่งข้อมูลใบกำกับภาษี (เช่น "ขอใบกำกับภาษี", "ออกใบกำภาษีได้ไหม")
- null: ไม่ใช่คำถามทั่วไป

subject_scope: ลูกค้าอ้างอิงสินค้าที่เคยคุยกันในบทสนทนา (subject set) แบบใด
- "explicit": ระบุสินค้าชัดเจน (ชื่อรุ่น/รหัสสินค้า/การ์ดสินค้า)
- "current_single": อ้างสินค้า 1 ชิ้นในกลุ่มปัจจุบัน ("อันนี้", "ตัวนี้", "ตัวเดิม", "อันเดิม")
- "current_set": อ้างทั้งกลุ่มสินค้าปัจจุบัน ("2 อันนี้", "ทั้งสอง", "พวกนี้", "ชุดนี้", "อันไหนดีที่สุดในพวกนี้")
- "none": ไม่อ้างอิงสินค้าเดิม (คำถามใหม่/ทั่วไป/ระบุประเภทสินค้าใหม่)

subject_count: ตัวเลขจำนวนสินค้าที่ลูกค้าระบุ เฉพาะเมื่อ subject_scope=current_set ("2 อันนี้"→2, "ทั้งสาม"→3) — null ถ้าไม่ระบุตัวเลขหรือ scope อื่น

policy_reason: สาเหตุที่ลูกค้าอยากเปลี่ยน/คืน (เฉพาะเมื่อ general_qtype="return_policy" หรือคำถามเกี่ยวกับเปลี่ยน/คืน) — เลือกจาก:
- "customer_wrong_model": ลูกค้าซื้อผิดรุ่นเอง / อยากเปลี่ยนเพราะเลือกผิด
- "seller_wrong_item": ทางร้านส่งผิดรุ่น/ผิดของ
- "defect": สินค้าชำรุด/ใช้งานไม่ได้
- "damage": สินค้าเสียหายระหว่างขนส่ง/แกะกล่องเจอของเสีย
- "unknown": ไม่ได้ระบุ / ไม่ใช่คำถามเปลี่ยนคืน

policy_item_condition: สภาพสินค้าที่ลูกค้าบอก (เฉพาะกรณีเปลี่ยน/คืน) — เลือกจาก:
- "sealed": ยังไม่แกะซีล/กล่อง
- "outer_opened": แกะกล่องนอกแล้ว แต่ยังไม่ใช้งาน
- "inner_opened": แกะซีลใน/ใช้งานครั้งเดียว
- "used": ใช้งานแล้ว
- "unknown": ไม่ได้ระบุ / ไม่เกี่ยวกับเปลี่ยนคืน

policy_order_state: สถานะออเดอร์ที่เกี่ยวข้อง (เฉพาะกรณีเปลี่ยน/คืน) — เลือกจาก:
- "unshipped": ยังไม่จัดส่ง
- "shipped": จัดส่งแล้ว/อยู่ระหว่างขนส่ง
- "delivered": ได้รับของแล้ว
- "unknown": ไม่ได้ระบุ / ไม่เกี่ยวกับเปลี่ยนคืน

confidence: ความมั่นใจ 0.0-1.0

ตัวอย่าง:
คำถาม: "สายชาร์จรุ่นไหนใช้กับ iphone 17 promax ได้บ้าง"
{"intent":"compatibility_check","product_type":"charger","charger_subtype":"cable","target_device":"iphone 17 pro max","device_connector":"usb-c","device_min_watt":27,"needs_description":true,"general_qtype":null,"confidence":0.95}

คำถาม: "มีสินค้าประเภทสายชาร์จไหม"
{"intent":"product_recommend","product_type":"charger","charger_subtype":"cable","target_device":null,"device_connector":null,"device_min_watt":null,"needs_description":false,"general_qtype":null,"confidence":0.95}

คำถาม: "cuktech ctc615w รับประกันกี่ปี"
{"intent":"warranty_duration","product_type":"charger","charger_subtype":"cable","target_device":null,"device_connector":null,"device_min_watt":null,"needs_description":true,"general_qtype":null,"confidence":0.95}

คำถาม: "สินค้าเสีย อยากเคลม"
{"intent":"warranty_claim","product_type":null,"charger_subtype":null,"target_device":null,"device_connector":null,"device_min_watt":null,"needs_description":false,"general_qtype":null,"confidence":0.95}

คำถาม: "มีสายชาร์จไหม" (history ล่าสุด: บอทตอบเรื่องรับประกัน)
{"intent":"product_recommend","product_type":"charger","charger_subtype":"cable","target_device":null,"device_connector":null,"device_min_watt":null,"needs_description":false,"general_qtype":null,"confidence":0.9}

คำถาม: "หัวชาร์จ 65w รุ่นไหนดี"
{"intent":"product_recommend","product_type":"charger","charger_subtype":"adapter","target_device":null,"device_connector":null,"device_min_watt":null,"needs_description":false,"general_qtype":null,"confidence":0.95}

คำถาม: "มีหัวชาร์จในรถไหม"
{"intent":"product_recommend","product_type":"charger","charger_subtype":"car_charger","target_device":null,"device_connector":null,"device_min_watt":null,"needs_description":false,"general_qtype":null,"confidence":0.95}

คำถาม: "มีแท่นชาร์จไร้สายไหม"
{"intent":"product_recommend","product_type":"charger","charger_subtype":"wireless","target_device":null,"device_connector":null,"device_min_watt":null,"needs_description":false,"general_qtype":null,"confidence":0.95}

คำถาม: "อยากได้ของที่ใช้กับ xiaomi 17 ultra"
{"intent":"product_recommend","product_type":"charger","charger_subtype":null,"target_device":"xiaomi 17 ultra","device_connector":"usb-c","device_min_watt":90,"needs_description":true,"general_qtype":null,"confidence":0.9}

คำถาม: "หัวชาร์จละ มีไหมใช้กับ mi 17 ultra"
{"intent":"product_recommend","product_type":"charger","charger_subtype":"adapter","target_device":"mi 17 ultra","device_connector":"usb-c","device_min_watt":90,"needs_description":true,"general_qtype":null,"confidence":0.9}

คำถาม: "พาวเวอร์แบงค์ใช้กับ oneplus 13 ได้ไหม"
{"intent":"compatibility_check","product_type":"powerbank","charger_subtype":null,"target_device":"oneplus 13","device_connector":"usb-c","device_min_watt":80,"needs_description":true,"general_qtype":null,"confidence":0.9}

คำถาม: "iphone หละแนะนำอันไหน 2 อันนี้" (history ล่าสุด: บอทเปรียบเทียบ AC65B กับ AC65B2)
{"intent":"product_recommend","product_type":"charger","charger_subtype":"adapter","target_device":"iphone","device_connector":"usb-c","device_min_watt":20,"needs_description":false,"general_qtype":null,"subject_scope":"current_set","subject_count":2,"confidence":0.9}

คำถาม: "สายชาร์จใช้กับ iphone 13 ได้ไหม"
{"intent":"compatibility_check","product_type":"charger","charger_subtype":"cable","target_device":"iphone 13","device_connector":"lightning","device_min_watt":20,"needs_description":true,"general_qtype":null,"confidence":0.9}

คำถาม: "ส่งกี่วัน"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"shipping_policy","confidence":0.95}

คำถาม: "มีรับคืนไหม"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"return_policy","policy_reason":"unknown","policy_item_condition":"unknown","policy_order_state":"unknown","confidence":0.95}

คำถาม: "ถ้าซื้อผิดรุ่นเอง ยังไม่ได้แกะเลย เปลี่ยนได้ไหม"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"return_policy","policy_reason":"customer_wrong_model","policy_item_condition":"sealed","policy_order_state":"delivered","confidence":0.9}

คำถาม: "รับประกันกี่ปี"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"warranty_policy","confidence":0.95}

คำถาม: "มีแบรนด์อะไรบ้าง"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"brands","confidence":0.95}

คำถาม: "ขายอะไรบ้าง"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"categories","confidence":0.95}

คำถาม: "ขอใบกำกับภาษี"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"tax_invoice","confidence":0.95}

คำถาม: "สวัสดีจ้า"
{"intent":"greeting","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":null,"confidence":0.95}

คำถาม: "Speed data เท่าไหร่?ครับ"
{"intent":"product_spec","product_type":"charger","charger_subtype":"cable","target_device":null,"needs_description":true,"general_qtype":null,"subject_scope":"current_single","requested_facts":["data_transfer_speed"],"confidence":0.95}

คำถาม: "มีรุ่น 10Gbps ขึ้นไปและเป็นสายแม่เหล็กไหม"
{"intent":"product_recommend","product_type":"charger","charger_subtype":"cable","target_device":null,"needs_description":false,"general_qtype":null,"subject_scope":"none","spec_constraints":[{"field":"data_transfer_mbps","op":"gte","value":10000}],"required_features":["magnetic"],"confidence":0.95}

คำถาม: "หูฟังรุ่นนี้ตัดเสียงรบกวนเวลาคุยโทรได้ไหม แล้วปรับเพลงจากตัวหูฟังได้หรือไม่"
{"intent":"product_spec","product_type":"earphone","charger_subtype":null,"target_device":null,"needs_description":true,"general_qtype":null,"subject_scope":"explicit","requested_facts":["description"],"capability_asks":["ตัดเสียงรบกวนเวลาคุยโทร","ปรับเพลงจากตัวหูฟัง"],"confidence":0.95}

ตอบเป็น JSON เท่านั้น ห้ามมีคำอธิบาย
"""


# API key rotation + model ใช้ของ llm.py ร่วมกัน (llm_config DB → env fallback)
# — call site ใช้ llm._generate ซึ่งจัดการ client/key/quota เอง

# default เมื่อ LLM ไม่พร้อมหรือ error
_DEFAULT_RESULT: dict[str, Any] = {
    "intent": "other",
    "product_type": None,
    "charger_subtype": None,
    "target_device": None,
    "relation_target": None,
    "device_connector": None,
    "device_min_watt": None,
    "needs_description": False,
    "general_qtype": None,
    "subject_scope": "none",
    "subject_count": None,
    # Phase 5 — typed policy signals (closed enum; invalid → "unknown")
    "policy_reason": "unknown",
    "policy_item_condition": "unknown",
    "policy_order_state": "unknown",
    # typed fact/spec contract (closed enums — normalize ด้านล่าง)
    "requested_facts": [],
    "required_features": [],
    "spec_constraints": [],
    # capability asks = residual source-grounded excerpt จาก message ลูกค้า
    "capability_asks": [],
    "confidence": 0.0,
}

_SUBJECT_SCOPES = {"none", "explicit", "current_single", "current_set"}

# closed contract enums — consumer normalize ผ่าน intent_fact_scope
# (route_context) ซ้ำอีกชั้น ค่านอก enum → drop (fail closed)
REQUESTED_FACTS = frozenset({
    "price", "stock", "link", "description", "warranty",
    "data_transfer_speed", "charging_speed", "compatibility"})
REQUIRED_FEATURES = frozenset({"magnetic"})
SPEC_CONSTRAINT_FIELDS = frozenset({
    "data_transfer_mbps", "output_power_w", "capacity_mah",
    "cable_length_m"})
SPEC_CONSTRAINT_OPS = frozenset({"gte", "lte", "gt", "lt", "eq"})


def norm_spec_constraints(raw) -> tuple[tuple[str, str, float], ...]:
    """model-emitted spec constraints → canonical (field, op, float) tuple —
    invalid entries drop (fail closed); canonical owner เดียวของ shape นี้"""
    out: list[tuple[str, str, float]] = []
    if not isinstance(raw, (list, tuple)):
        return ()
    for c in raw:
        if not isinstance(c, dict):
            continue
        field, op = str(c.get("field") or ""), str(c.get("op") or "")
        if field not in SPEC_CONSTRAINT_FIELDS or op not in SPEC_CONSTRAINT_OPS:
            continue
        try:
            out.append((field, op, float(c.get("value"))))
        except (TypeError, ValueError):
            continue
    return tuple(dict.fromkeys(out))


def _grounded_excerpt(text: str, message: str) -> str | None:
    """source validation เดียวของ capability_asks — text ต้องเป็น substring
    ของ message หลัง structural fold (ลบ whitespace + casefold เท่านั้น);
    คืน span ต้นฉบับของลูกค้าเป็น display text; ไม่เจอ → None (fail closed)."""
    needle = "".join(text.split()).casefold()
    if not needle or len(needle) > 200:
        return None
    chars: list[str] = []
    pos: list[int] = []
    for i, c in enumerate(message):
        if not c.isspace():
            chars.append(c.casefold())
            pos.append(i)
    j = "".join(chars).find(needle)
    if j < 0:
        return None
    return message[pos[j]:pos[j + len(needle) - 1] + 1].strip()


def classify_intent(
    message: str,
    history: list[dict] | None = None,
    shop: str | None = None,
) -> dict[str, Any]:
    """จำแนก intent ของลูกค้าด้วย LLM (flash-lite).

    Args:
        message: คำถามลูกค้าปัจจุบัน
        history: ประวัติแชท (list of {role, text}) — ส่งแค่ 4 ล่าสุด
        shop: ชื่อร้าน (optional — ใส่ใน prompt เพื่อ context)

    Returns:
        dict ตามรูปแบบด้านบน ถ้า error → คืน _DEFAULT_RESULT (confidence=0)
    """
    if not message or not message.strip():
        return dict(_DEFAULT_RESULT)

    # สร้าง history text (ส่งแค่ 4 ล่าสุด)
    history_text = ""
    if history:
        recent = history[-4:]
        lines = []
        for h in recent:
            role = h.get("role", "user")
            text = h.get("text", "")[:200]  # ตัดแต่ละ message ไม่เกิน 200 ตัวอักษร
            label = "ลูกค้า" if role == "user" else "บอท"
            lines.append(f"{label}: {text}")
        history_text = "\n".join(lines)

    # สร้าง prompt
    user_parts = []
    if shop:
        user_parts.append(f"ร้าน: {shop}")
    if history_text:
        user_parts.append(f"ประวัติล่าสุด:\n{history_text}")
    user_parts.append(f"คำถามลูกค้า: \"{message}\"")
    user_prompt = "\n\n".join(user_parts)

    from . import llm as _llm   # lazy — key pool/model/quota ร่วมกับ llm.py (llm_config DB → env)
    model_name = _llm.get_model("intent")

    try:
        response = _llm._generate(
            model_name,
            user_prompt,
            {
                "system_instruction": _INTENT_PROMPT,
                "temperature": 0.0,
                "max_output_tokens": 250,
                "response_mime_type": "application/json",
            },
            role="intent",
        )
        raw = (response.text or "").strip()
        if not raw:
            print("[INTENT] empty response → default", file=sys.stderr)
            return dict(_DEFAULT_RESULT)

        result = json.loads(raw)
        # validate fields
        valid_intents = {
            "product_recommend", "product_spec", "compatibility_check",
            "warranty_duration", "warranty_claim", "general_question",
            "greeting", "other",
        }
        if result.get("intent") not in valid_intents:
            result["intent"] = "other"
        if result.get("subject_scope") not in _SUBJECT_SCOPES:
            result["subject_scope"] = "none"
        # Phase 5 — policy signals: closed enums เท่านั้น, ค่าอื่น → unknown
        from . import policy_resolver as _polres
        if result.get("policy_reason") not in _polres.POLICY_REASONS:
            result["policy_reason"] = "unknown"
        if result.get("policy_item_condition") not in _polres.POLICY_CONDITIONS:
            result["policy_item_condition"] = "unknown"
        if result.get("policy_order_state") not in _polres.POLICY_ORDER_STATES:
            result["policy_order_state"] = "unknown"
        # typed fact/spec contract — closed enums; ค่านอก set → drop
        _rf = result.get("requested_facts")
        result["requested_facts"] = [
            str(x) for x in (_rf if isinstance(_rf, (list, tuple)) else ())
            if str(x) in REQUESTED_FACTS]
        _feat = result.get("required_features")
        result["required_features"] = [
            str(x) for x in (_feat if isinstance(_feat, (list, tuple)) else ())
            if str(x) in REQUIRED_FEATURES]
        result["spec_constraints"] = [
            {"field": f, "op": op, "value": v}
            for f, op, v in norm_spec_constraints(
                result.get("spec_constraints"))]
        # capability_asks = residual capability questions — ต้องเป็น
        # exact excerpt จาก message ลูกค้าเท่านั้น (source-grounded;
        # structural fold: whitespace + casefold) — display text = span
        # ต้นฉบับของลูกค้า; ไม่เจอใน message → drop fail-closed
        _ca = result.get("capability_asks")
        _seen_ca: set[str] = set()
        _kept_ca: list[str] = []
        for _x in (_ca if isinstance(_ca, (list, tuple)) else ()):
            _span = _grounded_excerpt(str(_x), message)
            if _span is None:
                continue
            _k = "".join(_span.split()).casefold()
            if _k not in _seen_ca:
                _seen_ca.add(_k)
                _kept_ca.append(_span)
        result["capability_asks"] = _kept_ca[:8]
        # relation_target ต้อง grounded — คัดมาจากข้อความลูกค้าจริงเท่านั้น;
        # ไม่ใช่ str / ไม่อยู่ใน message / spec-like → None (fail closed)
        _rt = result.get("relation_target")
        if not isinstance(_rt, str) or not _rt.strip() \
                or _rt.strip().lower() not in message.lower() \
                or _polres._spec_tokens(_rt.strip()):
            result["relation_target"] = None
        else:
            result["relation_target"] = _rt.strip()
        try:
            _sc = result.get("subject_count")
            _sc = None if _sc is None else int(_sc)
            result["subject_count"] = _sc if _sc is None or _sc >= 1 else None
        except (TypeError, ValueError):
            result["subject_count"] = None
        if result.get("confidence") is None:
            result["confidence"] = 0.5
        # ใส่ default fields ที่อาจขาด
        for k, v in _DEFAULT_RESULT.items():
            if k not in result:
                result[k] = v
        # เพิ่ม usage + model สำหรับ log panel
        result["model"] = model_name
        try:
            usage = response.usage_metadata
            result["usage"] = {
                "prompt": getattr(usage, "prompt_token_count", 0) or 0,
                "output": getattr(usage, "candidates_token_count", 0) or 0,
                "total": getattr(usage, "total_token_count", 0) or 0,
            }
        except Exception:
            result["usage"] = {"prompt": 0, "output": 0, "total": 0}

        print(f"[INTENT] intent={result['intent']}  type={result.get('product_type')}  "
              f"sub={result.get('charger_subtype')}  device={result.get('target_device')}  "
              f"conn={result.get('device_connector')}  watt={result.get('device_min_watt')}  "
              f"desc={result.get('needs_description')}  conf={result.get('confidence')}",
              file=sys.stderr)
        return result

    except json.JSONDecodeError as e:
        print(f"[INTENT] JSON parse error: {e}  raw={raw[:100]!r}", file=sys.stderr)
        return dict(_DEFAULT_RESULT)
    except Exception as e:
        print(f"[INTENT] error: {e}", file=sys.stderr)
        return dict(_DEFAULT_RESULT)


# ---- helper: ตรวจว่าควรเรียก Pass 1 ไหม ----

def should_run_pass1(
    message: str,
    claim_detected: bool,
    product_types: set[str] | None,
    has_warranty_history: bool,
) -> bool:
    """ตรวจว่า message นี้ควรเรียก LLM รอบแรก (Pass 1) ไหม.

    เรียก Pass 1 เฉพาะ "จุดอ่อน" ของ hardcoded detection:
      1. detect_claim_request() = True (อาจเป็น false positive)
      2. มี compatibility keyword ("ใช้กับ", "รองรับ", "สำหรับ")
      3. product_type detection ไม่ชัดเจน (ไม่มี type หรือมีหลาย type)
      4. มี history ของ warranty + message ปัจจุบันกำกวม

    ถ้าไม่เข้าเงื่อนไขข้างต้น → ใช้ hardcoded detection ตามเดิม (ประหยัดเวลา)
    """
    if not message or not message.strip():
        return False

    msg_lower = message.lower()

    # 1. claim request detected (อาจเป็น false positive → ให้ LLM ยืนยัน)
    if claim_detected:
        return True

    # 2. compatibility keyword
    compat_kws = ("ใช้กับ", "รองรับ", "สำหรับ", "compatible", "support", "works with")
    if any(kw in msg_lower for kw in compat_kws):
        return True

    # 3. product_type ไม่ชัดเจน
    if product_types is None or len(product_types) == 0:
        # ไม่ detect ได้ → ลองให้ LLM ช่วย
        # แต่ถ้าเป็นคำสั้นๆ ที่ไม่น่าเป็นสินค้า (เช่น "ขอบคุณ") → ไม่ต้อง
        if len(message.split()) >= 2:
            return True

    # 4. มี warranty history + message ปัจจุบันกำกวม
    if has_warranty_history:
        # ถ้า message ปัจจุบันมี keyword ของสินค้า แต่ history เป็น warranty → อาจสับสน
        product_kws = ("สายชาร์จ", "หัวชาร์จ", "ชุดชาร์จ", "หูฟัง", "เคส", "แบต",
                       "นาฬิกา", "โทรศัพท์", "สินค้า", "รุ่น")
        if any(kw in msg_lower for kw in product_kws):
            return True

    return False
