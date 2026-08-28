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
    "charger_subtype": "cable|adapter|set|null",
    "target_device": "iphone 4s|samsung s25 ultra|null",
    "needs_description": bool,
    "confidence": 0.0-1.0,
  }
"""
from __future__ import annotations

import itertools as _itertools
import json
import os
import sys
from typing import Any

from google import genai


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
- "adapter": หัวชาร์จ/adapter
- "set": ชุดชาร์จ (หัว+สาย หรือ หัว+สาย+พาวเวอร์แบงค์)
- null: ไม่ระบุ

target_device: ถ้าลูกค้าระบุอุปกรณ์ที่จะใช้งานด้วย (เช่น "iphone 4s", "samsung s25 ultra", "macbook") หรือ null

needs_description: true ถ้าต้องดึง description สินค้ามาตอบ (เช่น compatibility_check, product_spec, warranty_duration) มิฉะนั้น false

confidence: ความมั่นใจ 0.0-1.0

ตัวอย่าง:
คำถาม: "สายชาร์จรุ่นไหนใช้กับ iphone 17 promax ได้บ้าง"
{"intent":"compatibility_check","product_type":"charger","charger_subtype":"cable","target_device":"iphone 17 pro max","needs_description":true,"confidence":0.95}

คำถาม: "มีสินค้าประเภทสายชาร์จไหม"
{"intent":"product_recommend","product_type":"charger","charger_subtype":"cable","target_device":null,"needs_description":false,"confidence":0.95}

คำถาม: "cuktech ctc615w รับประกันกี่ปี"
{"intent":"warranty_duration","product_type":"charger","charger_subtype":"cable","target_device":null,"needs_description":true,"confidence":0.95}

คำถาม: "สินค้าเสีย อยากเคลม"
{"intent":"warranty_claim","product_type":null,"charger_subtype":null,"target_device":null,"needs_description":false,"confidence":0.95}

คำถาม: "มีสายชาร์จไหม" (history ล่าสุด: บอทตอบเรื่องรับประกัน)
{"intent":"product_recommend","product_type":"charger","charger_subtype":"cable","target_device":null,"needs_description":false,"confidence":0.9}

คำถาม: "หัวชาร์จ 65w รุ่นไหนดี"
{"intent":"product_recommend","product_type":"charger","charger_subtype":"adapter","target_device":null,"needs_description":false,"confidence":0.95}

ตอบเป็น JSON เท่านั้น ห้ามมีคำอธิบาย
"""


def _load_api_keys() -> list[str]:
    """โหลด API keys จาก environment (ใช้ shared keys กับ llm.py)."""
    keys: list[str] = []
    for i in range(1, 10):
        k = os.environ.get(f"GEMINI_API_KEY_{i}", "").strip()
        if k:
            keys.append(k)
    k = os.environ.get("GEMINI_API_KEY", "").strip()
    if k and k not in keys:
        keys.append(k)
    return keys


_API_KEYS: list[str] = _load_api_keys()
_KEY_CYCLE = _itertools.cycle(_API_KEYS) if _API_KEYS else None
_KEY_INDEX = 0


def _next_api_key() -> str:
    global _KEY_INDEX
    if not _API_KEYS:
        raise RuntimeError("ไม่พบ GEMINI_API_KEY สำหรับ intent classifier")
    key = next(_KEY_CYCLE)
    _KEY_INDEX = (_KEY_INDEX + 1) % len(_API_KEYS)
    return key


def _client() -> genai.Client:
    return genai.Client(api_key=_next_api_key())


# default เมื่อ LLM ไม่พร้อมหรือ error
_DEFAULT_RESULT: dict[str, Any] = {
    "intent": "other",
    "product_type": None,
    "charger_subtype": None,
    "target_device": None,
    "needs_description": False,
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

    model_name = os.environ.get("INTENT_MODEL", "gemini-3.1-flash-lite")

    try:
        client = _client()
        response = client.models.generate_content(
            model=model_name,
            contents=user_prompt,
            config={
                "system_instruction": _INTENT_PROMPT,
                "temperature": 0.0,
                "max_output_tokens": 200,
                "response_mime_type": "application/json",
            },
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
