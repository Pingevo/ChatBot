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
               warranty_duration|warranty_claim|general_question|other",
    "product_type": "phone|charger|earphone|smartwatch|powerbank|case|speaker|other|null",
    "charger_subtype": "cable|adapter|set|car_charger|wireless|desktop|socket|null",
    "target_device": "iphone 4s|samsung s25 ultra|null",
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

general_qtype: ถ้า intent=general_question ระบุประเภทคำถามทั่วไป (ถ้าไม่ใช่ general_question → null)
- "warranty_policy": ถามนโยบาย/เงื่อนไขรับประกัน (เช่น "รับประกันกี่ปี", "มีประกันไหม", "เคลมยังไง")
- "return_policy": ถามนโยบายรับคืน/เปลี่ยนสินค้า (เช่น "รับคืนไหม", "เปลี่ยนสินค้าได้ไหม")
- "shipping_policy": ถามนโยบายจัดส่ง/เวลาส่ง (เช่น "ส่งกี่วัน", "เมื่อไหร่ได้ของ")
- "brands": ถามแบรนด์ที่มี (เช่น "มีแบรนด์อะไรบ้าง", "มียี่ห้ออะไร")
- "categories": ถามหมวดหมู่สินค้า (เช่น "ขายอะไรบ้าง", "มีหมวดหมู่อะไร")
- "shops": ถามร้านในเครือ (เช่น "มีร้านอะไรบ้าง", "ร้านในเครือ")
- "tax_invoice": ขอใบกำกับภาษี/ส่งข้อมูลใบกำกับภาษี (เช่น "ขอใบกำกับภาษี", "ออกใบกำภาษีได้ไหม")
- null: ไม่ใช่คำถามทั่วไป

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

คำถาม: "สายชาร์จใช้กับ iphone 13 ได้ไหม"
{"intent":"compatibility_check","product_type":"charger","charger_subtype":"cable","target_device":"iphone 13","device_connector":"lightning","device_min_watt":20,"needs_description":true,"general_qtype":null,"confidence":0.9}

คำถาม: "ส่งกี่วัน"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"shipping_policy","confidence":0.95}

คำถาม: "มีรับคืนไหม"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"return_policy","confidence":0.95}

คำถาม: "รับประกันกี่ปี"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"warranty_policy","confidence":0.95}

คำถาม: "มีแบรนด์อะไรบ้าง"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"brands","confidence":0.95}

คำถาม: "ขายอะไรบ้าง"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"categories","confidence":0.95}

คำถาม: "ขอใบกำกับภาษี"
{"intent":"general_question","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"general_qtype":"tax_invoice","confidence":0.95}

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
    "device_connector": None,
    "device_min_watt": None,
    "needs_description": False,
    "general_qtype": None,
    "confidence": 0.0,
}


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
            "warranty_duration", "warranty_claim", "general_question", "other",
        }
        if result.get("intent") not in valid_intents:
            result["intent"] = "other"
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
