"""Web search fallback — ด่านสุดท้ายเมื่อ RAG + LLM ไม่มั่นใจ

ใช้ OpenRouter กับ model ที่รองรับ Google Search (เช่น :online suffix)
เพื่อค้นหาข้อมูลเพิ่มเติมจากอินเทอร์เน็ต เช่น:
  - สายชาร์จรุ่นใหม่รองรับ iPhone 17 ProMax ไหม
  - เทคโนโลยีชาร์จของโทรศัพท์รุ่นใหม่
  - ข้อมูลอุปกรณ์เก่าที่ไม่มีในระบบ

หลักการ:
  1. เรียกเฉพาะเมื่อ Pass 1 + Pass 2 ไม่มั่นใจ (low confidence / uncertainty markers)
  2. ครอบ context: บอก LLM ว่าเป็นแชทร้านค้าเรา ชื่อร้าน X สินค้า Y แพลตฟอร์ม Z
  3. ส่ง history ให้ LLM ด้วย
  4. บอก LLM ให้ใช้ Google Search หาข้อมูล แต่ตอบในบุคลิกเดิม
  5. Log ทุกครั้งไป AI Usage Hub (ตาม format ของทีม)
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from typing import Any


# ── Config ──────────────────────────────────────────────────────────────────
# อ่าน env ทุกครั้ง (lazy) เพราะ load_dotenv อาจโหลดหลัง import

def _get_openrouter_key() -> str:
    return os.environ.get("OPENROUTER_API_KEY", "").strip()

def _get_openrouter_base() -> str:
    return os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()

def _get_openrouter_model() -> str:
    return os.environ.get("OPENROUTER_SEARCH_MODEL", "google/gemini-2.5-flash:online").strip()

def _get_ai_usage_hub_url() -> str:
    return os.environ.get("AI_USAGE_HUB_URL", "").strip()

def _get_ai_usage_hub_token() -> str:
    return os.environ.get("AI_USAGE_HUB_TOKEN", "").strip()


def _log_ai_usage(entry: dict) -> None:
    """ส่ง log ไป AI Usage Hub (fire-and-forget ไม่ throw)."""
    _hub_url = _get_ai_usage_hub_url()
    _hub_token = _get_ai_usage_hub_token()
    if not _hub_url or not _hub_token:
        return
    try:
        _body = json.dumps(entry).encode("utf-8")
        _req = urllib.request.Request(
            f"{_hub_url.rstrip('/')}/internal/ai-usage/logs",
            data=_body,
            headers={
                "Content-Type": "application/json",
                "x-service-token": _hub_token,
            },
            method="POST",
        )
        urllib.request.urlopen(_req, timeout=5)
    except Exception as e:
        print(f"[AI-USAGE-HUB] log failed: {e}", file=sys.stderr)


def is_configured() -> bool:
    """ตรวจว่าตั้งค่า OpenRouter แล้วหรือไม่."""
    return bool(_get_openrouter_key())


# ── Uncertainty detection ───────────────────────────────────────────────────

# คำที่บ่งบอกว่า LLM ไม่มั่นใจในคำตอบ
# แบ่งเป็น 2 กลุ่ม: ชัดเจน (trigger เลย) และ ต้องมี context อื่นร่วมด้วย
_UNCERTAINTY_MARKERS_STRONG = [
    # ความไม่แน่ใจชัดเจน
    "ไม่แน่ใจ", "ไม่ทราบแน่ชัด", "ไม่แน่นอน", "ไม่สามารถยืนยันได้",
    "i'm not sure", "not sure", "uncertain", "cannot confirm",
    # ไม่มีข้อมูลในระบบ (เฉพาะเจาะจง)
    "ไม่มีข้อมูลสินค้า", "ไม่มีข้อมูลในระบบ", "ไม่พบข้อมูล",
    "no information available", "no data available",
    # แนะนำให้สอบถามเพิ่ม (เฉพาะเจาะจง)
    "แนะนำให้สอบถามเพิ่มเติม", "กรุณาตรวจสอบเพิ่มเติม",
]

# markers อ่อน — ต้องมี "ทักแอดมิน" หรือ "ติดต่อแอดมิน" ร่วมด้วยถึงจะ trigger
_UNCERTAINTY_MARKERS_WEAK = [
    "ไม่มีรายละเอียดเพิ่มเติม", "ไม่มีรายละเอียด",
    "ไม่สามารถระบุได้", "ไม่ทราบ",
]

_ADMIN_REFERRAL_MARKERS = ["ทักแอดมิน", "ติดต่อแอดมิน", "แอดมินได้เลย"]


def detect_uncertainty(answer: str) -> tuple[bool, str | None]:
    """ตรวจว่าคำตอบมีความไม่มั่นใจหรือไม่.

    Returns:
        (is_uncertain, matched_marker)
    """
    ans_lower = answer.lower()
    # 1. strong markers — trigger เลย
    for marker in _UNCERTAINTY_MARKERS_STRONG:
        if marker in ans_lower:
            return True, marker
    # 2. weak markers — ต้องมี admin referral ร่วมด้วย
    has_admin_ref = any(m in ans_lower for m in _ADMIN_REFERRAL_MARKERS)
    if has_admin_ref:
        for marker in _UNCERTAINTY_MARKERS_WEAK:
            if marker in ans_lower:
                return True, f"{marker} + admin_referral"
    return False, None


# ── Trigger conditions ──────────────────────────────────────────────────────

def should_use_web_search(
    answer: str,
    intent_result: dict | None = None,
    products: list[dict] | None = None,
    message: str = "",
) -> tuple[bool, str]:
    """ตัดสินใจว่าควรใช้ web search หรือไม่.

    Returns:
        (should_search, reason)
    """
    # ไม่ตั้งค่า OpenRouter → ไม่ใช้
    if not is_configured():
        return False, "openrouter_not_configured"

    # ⚡ BUG-11 fix — guard กัน web_search ในเคสที่ไม่จำเป็น (ประหยัดต้นทุน + เวลา)
    # 1. ถ้ามี products อยู่แล้วและเป็น ordinary product query (ไม่ใช่ spec/compat/warranty)
    #    → LLM มี context พอแล้ว ไม่ต้อง search ภายนอก
    # 2. ถ้าเป็น greeting/thanks/short message → ไม่ search
    _msg_lower = message.lower()
    _has_products = products is not None and len(products) > 0
    # ordinary product query = มีสินค้าใน context + ไม่ใช่ spec/compat/warranty/comparison question
    _ordinary_product_kws = (
        "ราคา", "ราคาเท่าไหร่", "กี่บาท", "ขอลิงค์", "ขอรูป", "ขอดู",
        "สนใจ", "อยากได้", "จอง", "สั่ง", "ซื้อ", "มีไหม", "มีไหมคะ",
    )
    _is_ordinary_product_q = any(kw in _msg_lower for kw in _ordinary_product_kws)
    # greeting/thanks = ข้อความสั้นๆ ที่ไม่ใช่คำถาม
    _greeting_kws = (
        "ขอบคุณ", "ขอบคุณค่ะ", "ขอบคุณครับ", "โอเค", " ok ", "รับทราบ",
        "สวัสดี", "หวัดดี", "ดีค่ะ", "ดีครับ", "hi ", "hello",
    )
    _is_greeting = any(kw in _msg_lower for kw in _greeting_kws) and len(message.split()) <= 4
    if _is_greeting:
        return False, "greeting_or_thanks"
    if _has_products and _is_ordinary_product_q:
        return False, "ordinary_product_query_with_context"

    # ตรวจคำถามเรื่องรับประกัน/สเปค/comparison และมีสินค้าใน context
    # (ใช้สำหรับ skip web search เมื่อ context มีข้อมูลอยู่แล้ว)
    _msg_lower = message.lower()
    _warranty_kw = ("รับประกัน", "ประกัน", "warranty", "สเปค", "spec", "สเปก")
    _comparison_kw = (" vs ", "ต่างกัน", "เปรียบเทียบ", "เทียบ", "กับ")
    _is_warranty_q = any(kw in _msg_lower for kw in _warranty_kw)
    _is_comparison_q = any(kw in _msg_lower for kw in _comparison_kw)
    _has_products = products is not None and len(products) > 0
    # ตรวจ comparison โดยนัย: message สั้นๆ ที่มี 2+ model keywords (เช่น "k5 k9")
    # แต่ต้องไม่มีคำถามอื่น (เช่น "สเปค", "รับประกัน") เพราะอาจเป็น "brand + model" ของรุ่นเดียว
    _model_count = 0
    _non_model_word_count = 0
    try:
        from . import knowledge_base as _kb
        _models = _kb.extract_model_keywords(message)
        _models = [m for m in _models if m.lower() != "vs"]
        _model_count = len(_models)
        _model_lower = [m.lower() for m in _models]
        _non_model_word_count = sum(1 for w in message.split() if w.lower() not in _model_lower and w.lower() != "vs")
    except Exception:
        pass
    _is_implicit_comparison = _model_count >= 2 and _non_model_word_count == 0
    # ถ้าเป็น warranty/spec/comparison/charging-spec question และมีสินค้าใน context → ไม่ควร search
    # เพราะ context สินค้ามีข้อมูลอยู่แล้ว ไม่ควรดึงจาก external (อาจได้สินค้าแบรนด์อื่นมา)
    _charging_spec_kws = (
        "ใช้สายชาร์จอะไร", "ใช้สายอะไรชาร์จ", "ใช้สายอะไร",
        "ชาร์จยังไง", "ชาร์จอะไร", "ชาร์จ type c", "ชาร์จ type-c",
        "ชาร์จได้ไหม", "ชาร์จกี่วัต", "ชาร์จกี่แอม", "ชาร์จกี่w",
        "พอร์ตอะไร", "พอร์ตชาร์จ", "พอร์ตไหน",
        "wireless ได้ไหม", "ชาร์จไร้สาย", "ชาร์จไม่ต้องเสียบ",
        "ใช้สาย c to c", "ใช้สาย c to a", "ใช้สาย usb",
        "ชาร์จเร็วไหม", "ชาร์จเร็วกี่", "แทนอันเดิม", "แทนของเดิม",
        "สายชาร์จเดิม", "สายเดิมเสีย", "สายชาร์จใหม่",
        "ใช้สายชาร์จแบบไหน", "สายชาร์จแบบไหน",
    )
    _is_charging_spec_q = any(kw in _msg_lower for kw in _charging_spec_kws)
    # carry-forward follow-up: ถามซ้ำ/อยากได้ข้อมูลเพิ่ม และมีสินค้าใน context → ไม่ควร search
    _followup_kws = ("อยากได้ข้อมูลเพิ่ม", "ข้อมูลเพิ่ม", "รายละเอียดเพิ่ม", "ราคาเท่าไหร่",
                     "ราคา", "รับประกัน", "สเปค", "สเปก", "รีวิว", "ขอดู", "ดูรุ่น",
                     "อยากรู้เพิ่ม", "บอกรายละเอียด", "อธิบายเพิ่ม")
    _is_followup_q = any(kw in _msg_lower for kw in _followup_kws) and len(message.split()) <= 8

    # yes/no spec question: ถาม "มี...ไหม/รองรับ...ไหม/ได้...ไหม/กัน...ไหม" แบบสั้นๆ
    # และมีสินค้าใน context → "ไม่มี/ไม่รองรับ" เป็น spec จริง ไม่ใช่ความไม่มั่นใจ
    # (เช่น "มีแบตไหม" → "ไม่มีแบต" = spec, ไม่ใช่ "ไม่รู้")
    import re as _re_yn
    _yesno_pat = _re_yn.search(
        r"(มี|รองรับ|ได้|กัน|สำรอง|เสียบ|ใช้งาน|เป็น|มาพร้อม|มีในตัว|ติดในตัว)"
        r".{0,40}(ไหม|มั้ย|หรือเปล่า|อะไรแน่|ป่าว)",
        _msg_lower,
    )
    _is_yesno_spec_q = bool(_yesno_pat) and len(message.split()) <= 12
    _skip_search = (
        _is_warranty_q or _is_comparison_q or _is_implicit_comparison
        or _is_charging_spec_q or _is_followup_q or _is_yesno_spec_q
    ) and _has_products

    # 1. คำตอบมี uncertainty markers
    uncertain, marker = detect_uncertainty(answer)
    if uncertain:
        # แต่ถ้าเป็นคำถามเรื่องรับประกัน/สเปค/comparison และมีสินค้าใน context → ไม่ search
        # เพราะ context สินค้ามีข้อมูลอยู่แล้ว ไม่ควรดึงจาก external (อาจได้สินค้าแบรนด์อื่นมา)
        if _skip_search:
            pass  # ไม่ trigger web search สำหรับ warranty/spec/comparison question ที่มีสินค้าใน context
        else:
            return True, f"answer_uncertain (marker: {marker})"

    # 2. Pass 1 confidence ต่ำมาก
    if intent_result:
        conf = intent_result.get("confidence")
        if conf is not None and conf < 0.5:
            return True, f"pass1_low_confidence ({conf:.2f})"

    # 3. Compatibility question → search เฉพาะเมื่อจำเป็น
    #    - ถ้า LLM ตอบไม่ได้/ไม่มั่นใจ → search
    #    - ถ้าไม่มีสินค้าใน context → search
    #    - ถ้าคำถามมีชื่ออุปกรณ์เฉพาะ (มีตัวเลขรุ่น) → search
    #      เพราะ DB มักไม่มีข้อมูล protocol/compatibility ของอุปกรณ์เฉพาะ
    #    - ถ้า LLM ตอบได้และไม่มีอุปกรณ์เฉพาะ → ไม่ search (ประหยัดต้นทุน)
    if intent_result and intent_result.get("intent") == "compatibility_check":
        ans_lower = answer.lower()
        # ถ้า LLM ตอบ "ไม่มี/ไม่รองรับ/ไม่แน่ใจ" → ต้อง search
        # แต่ถ้าเป็น yes/no spec question ของสินค้าใน context (เช่น "รองรับ wifi 5G ไหม")
        # → "ไม่รองรับ" เป็น spec จริง ไม่ใช่ความไม่มั่นใจ → ไม่ search
        if any(neg in ans_lower for neg in ["ไม่มี", "ไม่รองรับ", "ไม่สามารถ", "ไม่พบ", "ไม่แน่ใจ", "ไม่ทราบ", "ไม่แน่นอน"]):
            if _skip_search:
                pass  # yes/no spec question ของสินค้าใน context → ไม่ search
            else:
                return True, "compatibility_check_negative_answer"
        # ถ้าไม่มีสินค้าใน context → search
        if products is not None and len(products) == 0:
            return True, "compatibility_check_no_products"
        # ถ้าคำถามมีชื่ออุปกรณ์เฉพาะ (แบรนด์ + ตัวเลขรุ่น) → search
        #    เพราะ DB มักไม่มีข้อมูล protocol ของอุปกรณ์เฉพาะ
        #    เช่น "iphone 17", "xiaomi mi 17 ultra", "galaxy s25"
        import re as _re_dev
        _device_pattern = _re_dev.search(
            r"(iphone|ipad|galaxy|xiaomi|redmi|samsung|huawei|honor|oppo|vivo|realme|poco|oneplus|pixel|macbook|mac\s|surface|rog|legion|navis)"
            r"\s*\w*\s*\d+\s*(pro|max|ultra|lite|plus|mini|air|note|s|t|pro\s*max)?",
            message.lower(),
        )
        if _device_pattern:
            return True, "compatibility_check_device_specific"
        # ถ้าคำตอบสั้นๆ (LLM ไม่มั่นใจ) → search
        if len(answer) < 80:
            return True, "compatibility_check_short_answer"

    # 4. คำถามมี spec/protocol keywords → search เฉพาะเมื่อจำเป็น
    msg_lower = message.lower()
    _spec_keywords = (
        "pd 3", "pd3", "pd3.1", "pd3.2",
        "mipps", "hypercharge",
        "โปรโตคอล", "protocol", "ufcs", "scp",
        "thunderbolt", "usb4", "usb 4",
    )
    _has_spec_kw = any(kw in msg_lower for kw in _spec_keywords)
    if _has_spec_kw:
        ans_lower = answer.lower()
        # ถ้า LLM ตอบไม่ได้ → search
        if any(neg in ans_lower for neg in ["ไม่มี", "ไม่รองรับ", "ไม่สามารถ", "ไม่พบ", "ไม่แน่ใจ", "ไม่ทราบ"]):
            return True, "spec_query_negative_answer"
        # ถ้าไม่มีสินค้า → search
        if products is not None and len(products) == 0:
            return True, "spec_query_no_products"

    # 5. คำตอบบอก "ไม่มี" หรือ "ไม่รองรับ" → search
    # แต่ถ้าเป็นคำถามเรื่องรับประกัน/สเปค/comparison และมีสินค้าใน context → ไม่ search
    if any(neg in answer.lower() for neg in ["ไม่มี", "ไม่รองรับ", "ไม่สามารถ", "ไม่พบ"]):
        if _skip_search:
            pass  # ไม่ trigger web search สำหรับ warranty/spec/comparison question ที่มีสินค้าใน context
        else:
            return True, "negative_answer"

    return False, "confident_enough"


# ── Web search via OpenRouter ───────────────────────────────────────────────

def search_and_extract(
    message: str,
    shop: str | None = None,
    platform: str | None = None,
    history: list[dict] | None = None,
    reason: str = "",
) -> dict[str, Any]:
    """Step 1+2: เรียก OpenRouter + Google Search เพื่อหาข้อมูลทั่วไป + extract keyword.

    ไม่ตอบลูกค้าโดยตรง — คืนข้อมูลที่หาได้ + keywords สำหรับ query DB

    Returns:
        dict: {
            search_info: str,       # ข้อมูลทั่วไปจาก Google Search
            keywords: list[str],    # keyword สำหรับ query DB (เช่น ["USB-C", "Type-C", "PD"])
            product_type: str,      # ประเภทสินค้าที่ควรค้น (เช่น "charger", "cable")
            usage: {prompt, output, total},
            cost_usd: float,
            model: str,
            search_used: bool,
            reason: str,
            error: str | None,
            elapsed: float,
        }
    """
    if not is_configured():
        return {
            "search_info": "",
            "keywords": [],
            "product_type": "",
            "usage": {"prompt": 0, "output": 0, "total": 0},
            "cost_usd": 0.0,
            "model": _get_openrouter_model(),
            "search_used": False,
            "reason": reason,
            "error": "openrouter_not_configured",
            "elapsed": 0.0,
        }

    _t0 = time.time()

    # ── สร้าง system instruction ──
    system_parts = [
        "คุณเป็นระบบค้นหาข้อมูลอุปกรณ์และเทคโนโลยี ใช้ Google Search หาข้อมูลแล้วสรุปเป็น JSON",
        "",
        f"=== บริบทร้านค้า ===",
        f"ชื่อร้าน: {shop or '(ไม่ระบุ)'}",
        f"แพลตฟอร์ม: {platform or 'shopee'}",
        "",
        "=== งานของคุณ ===",
        "1. ใช้ Google Search หาข้อมูลเกี่ยวกับอุปกรณ์/เทคโนโลยีที่ลูกค้าถาม",
        "   เช่น พอร์ตชาร์จ, สเปก, ความเข้ากันได้, เทคโนโลยีที่รองรับ, โปรโตคอลชาร์จเร็ว",
        "2. สรุปข้อมูลที่หาได้เป็นข้อความสั้นๆ (search_info) — รวมรุ่นที่รองรับ และโปรโตคอล",
        "3. extract keyword สำหรับค้นสินค้าในฐานข้อมูลร้าน (keywords)",
        "   - คิดว่าสินค้าที่จะตอบลูกค้าต้องมี keyword อะไรในชื่อ/สเปก",
        "   - เช่น ถ้าอุปกรณ์ใช้ USB-C → keywords = [\"USB-C\", \"Type-C\", \"USB C to C\"]",
        "   - เช่น ถ้าเป็นสายถัก → keywords = [\"สายถัก\", \"ไนลอน\", \"braided\"]",
        "   - เช่น ถ้าถามพาวเวอร์แบงค์ → keywords = [\"พาวเวอร์แบงค์\", \"แบตสำรอง\", \"powerbank\", \"PB\"]",
        "   - ใส่ keyword ทั้งไทยและอังกฤษที่อาจใช้ในชื่อสินค้า",
        "   - ใส่รหัสรุ่นที่ค้นพบด้วย เช่น PB100P, PB200P, P23, BA652U",
        "   - ถ้าค้นเจอว่าแบรนด์ไหนรองรับ ให้ใส่ชื่อแบรนด์ด้วย เช่น CUKTECH, ZMI",
        "4. ระบุ product_type ที่ควรค้น (charger/earphone/smartwatch/phone/powerbank/other)",
        "",
        "ตอบเป็น JSON เท่านั้น รูปแบบ:",
        '{"search_info": "ข้อมูลสรุป", "keywords": ["keyword1", "keyword2"], "product_type": "charger"}',
        "",
        "ตัวอย่าง:",
        'คำถาม: "สายถัก iphone 17 promax มีไหม"',
        '{"search_info": "iPhone 17 Pro Max ใช้พอร์ต USB-C รองรับ USB-C to USB-C และ PD 3.0", "keywords": ["USB-C", "Type-C", "USB C to C", "สายถัก", "ไนลอน", "braided"], "product_type": "charger"}',
        "",
        'คำถาม: "พาวเวอร์แบงค์ที่รองรับชาร์จเร็ว xiaomi mi 17 ultra มีไหม"',
        '{"search_info": "Xiaomi 17 Ultra รองรับ MiPPS/HyperCharge 90W Max ต้องใช้พาวเวอร์แบงค์ที่รองรับ PPS 5A+ รุ่นที่รองรับ: CUKTECH PB100P (120W), PB200P (120W), P23 (140W), BA652U (90W)", "keywords": ["พาวเวอร์แบงค์", "แบตสำรอง", "powerbank", "PB100P", "PB200P", "P23", "BA652U", "PB200U", "PB150S"], "product_type": "powerbank"}',
        "",
        "ห้ามตอบเป็นข้อความธรรมดา ตอบ JSON เท่านั้น",
    ]

    # ── สร้าง user prompt ──
    # เพิ่ม context เกี่ยวกับแบรนด์ร้าน เพื่อให้ search เจาะจง
    _brand_hint = ""
    if shop and "cuktech" in shop.lower():
        _brand_hint = "\nหมายเหตุ: ร้านนี้ขายแบรนด์ CUKTECH/ZMI (เครือ Xiaomi) กรุณาค้นหาสินค้าของแบรนด์นี้ด้วย"
    # 🔒 H1: Limit message length to reduce prompt injection risk
    _safe_message = str(message)[:2000] if message else ""
    user_prompt = f"คำถามของลูกค้า: {_safe_message}\n\nหมายเหตุ: ระบบไม่มั่นใจในคำตอบจากข้อมูลในระบบ ({reason})\nกรุณาใช้ Google Search หาข้อมูลแล้วตอบเป็น JSON{_brand_hint}"

    # ── สร้าง messages (OpenAI format) ──
    messages = [{"role": "system", "content": "\n".join(system_parts)}]

    # history (ส่งแค่ 4 รอบล่าสุด เพื่อประหยัด token)
    if history:
        for h in history[-4:]:
            role = h.get("role", "user")
            text = h.get("text", "")
            if role == "model":
                role = "assistant"
            elif role not in ("user", "assistant"):
                role = "user"
            if text:
                if len(text) > 200:
                    text = text[:200] + "..."
                messages.append({"role": role, "content": text})

    messages.append({"role": "user", "content": user_prompt})

    # ── เรียก OpenRouter ──
    payload = {
        "model": _get_openrouter_model(),
        "messages": messages,
        "temperature": 0.2,
        # ⚡ BUG-11 fix — ลด max_tokens 1024 → 512 (พอสำหรับ extract keywords + short info)
        #   QA เคยเจอ 24,986 tokens ในเคสที่ไม่จำเป็น — ลดลงช่วยประหยัดต้นทุน
        "max_tokens": 512,
    }

    _req_start = time.time()
    _status = "success"
    _http_status = 200
    _error_msg = None
    _usage = {"prompt": 0, "output": 0, "total": 0}
    _cost_usd = 0.0
    _answer = ""
    _resp_data: dict = {}

    try:
        _body = json.dumps(payload).encode("utf-8")
        _req = urllib.request.Request(
            f"{_get_openrouter_base().rstrip('/')}/chat/completions",
            data=_body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {_get_openrouter_key()}",
                "HTTP-Referer": os.environ.get("OPENROUTER_REFERER", "https://chatbot.local"),
                "X-Title": os.environ.get("OPENROUTER_APP_TITLE", "ShopeeChatbot"),
            },
            method="POST",
        )
        # ⚡ BUG-11 fix — ลด timeout 30 → 20 (กันค้างนานเกินไปในเคสที่ไม่จำเป็น)
        _resp = urllib.request.urlopen(_req, timeout=20)
        _resp_data = json.loads(_resp.read().decode("utf-8"))
        _http_status = _resp.getcode()

        _answer = _resp_data.get("choices", [{}])[0].get("message", {}).get("content", "")
        _resp_usage = _resp_data.get("usage", {})
        _usage = {
            "prompt": _resp_usage.get("prompt_tokens", 0),
            "output": _resp_usage.get("completion_tokens", 0),
            "total": _resp_usage.get("total_tokens", 0),
        }
        _cost_usd = float(_resp_usage.get("cost", 0.0))

    except urllib.error.HTTPError as e:
        _status = "error"
        _http_status = e.code
        _error_msg = f"HTTP {e.code}: {e.reason}"
        try:
            _err_body = e.read().decode("utf-8")
            _error_msg += f" | {_err_body[:200]}"
        except Exception:
            pass
        print(f"[WEB-SEARCH] OpenRouter error: {_error_msg}", file=sys.stderr)
    except Exception as e:
        _status = "error"
        _http_status = 0
        _error_msg = str(e)
        print(f"[WEB-SEARCH] error: {e}", file=sys.stderr)

    _duration_ms = int((time.time() - _req_start) * 1000)

    # ── Log ไป AI Usage Hub ──
    _log_ai_usage({
        "provider": "openrouter",
        "model": _get_openrouter_model(),
        "operation": "chat.completions",
        "source": "web_search_fallback",
        "user": "system:chatbot",
        "reference": f"shop:{shop or 'unknown'}|platform:{platform or 'shopee'}",
        "prompt_tokens": _usage["prompt"],
        "completion_tokens": _usage["output"],
        "cost_usd": round(_cost_usd, 6),
        "duration_ms": _duration_ms,
        "attempt": 1,
        "status": _status,
        "http_status": _http_status,
        "error_message": _error_msg,
        "raw_usage": _resp_data.get("usage", {}) if _status == "success" else None,
        "metadata": {
            "shop": shop,
            "platform": platform,
            "reason": reason,
            "message_snippet": message[:100],
            "search_used": True,
            "step": "search_and_extract",
        },
    })

    # ── Parse JSON จากคำตอบ ──
    _search_info = ""
    _keywords: list[str] = []
    _product_type = ""
    if _status == "success" and _answer:
        try:
            # ลอง parse JSON จากคำตอบ (อาจมี ```json ครอบ)
            _clean = _answer.strip()
            if _clean.startswith("```"):
                _clean = _clean.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            _parsed = json.loads(_clean)
            _search_info = _parsed.get("search_info", "")
            _keywords = _parsed.get("keywords", []) or []
            _product_type = _parsed.get("product_type", "")
        except (json.JSONDecodeError, IndexError) as e:
            # ถ้า parse ไม่ได้ ใช้คำตอบเป็น search_info เลย
            _search_info = _answer[:500]
            print(f"[WEB-SEARCH] JSON parse failed: {e}", file=sys.stderr)

    _total_elapsed = time.time() - _t0
    print(
        f"[WEB-SEARCH] done in {_total_elapsed:.2f}s  status={_status}  "
        f"tokens={_usage['total']}  cost=${_cost_usd:.6f}  keywords={_keywords[:5]}",
        file=sys.stderr,
    )

    return {
        "search_info": _search_info,
        "keywords": _keywords,
        "product_type": _product_type,
        "usage": _usage,
        "cost_usd": _cost_usd,
        "model": _get_openrouter_model(),
        "search_used": _status == "success",
        "reason": reason,
        "error": _error_msg,
        "elapsed": round(_total_elapsed, 2),
    }



# ---- web search → re-answer (ย้ายจาก nested fn ใน app.py chat()) ----

def reanswer(
    *,
    db,
    llm_ctx_limit: int,
    search_message: str,
    llm_message: str,
    products_in: list[dict],
    reason: str,
    shop: str | None,
    platform: str | None,
    history_list: list[dict],
    persona_extra: str,
    intent_result: dict,
    vision_context: str,
    extra_context_prefix: str = "",
    do_kb_lookup: bool = True,
    do_model_code_regex: bool = True,
    do_dedup_rerank: bool = True,
    req_limit: int = 10,
) -> dict:
    """Web search → re-query DB → LLM2 re-answer.

    Returns dict:
      - answer: str (จาก LLM2, ไม่ใช่จาก search)
      - usage: dict (LLM2 token usage)
      - products: list[dict] (products ใหม่ที่ merge แล้ว)
      - cost_usd: float (search cost)
      - search_used: bool
      - search_reason: str
      - search_model: str
      - search_elapsed: float
      - steps: list[dict] (Search + RAG(search) + LLM2(search))
      - error: str | None
    """
    from . import knowledge_base, product_store, llm

    _result: dict = {
        "answer": "",
        "usage": {"prompt": 0, "output": 0, "total": 0},
        "products": products_in,
        "cost_usd": 0.0,
        "search_used": False,
        "search_reason": reason,
        "search_model": "",
        "search_elapsed": 0.0,
        "steps": [],
        "error": None,
    }

    if not is_configured():
        return _result

    try:
        _ws_r = search_and_extract(
            message=search_message,
            shop=shop,
            platform=platform,
            history=history_list,
            reason=reason,
        )
    except Exception as _e:
        print(f"[WEB-SEARCH-REANSWER] search_and_extract error: {_e}", file=sys.stderr)
        _result["error"] = str(_e)
        return _result

    if _ws_r.get("error") or not _ws_r.get("search_used"):
        print(f"[WEB-SEARCH-REANSWER] skipped (error: {_ws_r.get('error')})", file=sys.stderr)
        _result["error"] = _ws_r.get("error")
        return _result

    _result["search_used"] = True
    _result["search_model"] = _ws_r.get("model", "") or ""
    _result["search_elapsed"] = _ws_r.get("elapsed", 0.0) or 0.0
    _result["cost_usd"] = _ws_r.get("cost_usd", 0.0) or 0.0

    _ws_keywords = _ws_r.get("keywords", []) or []
    _ws_search_info = _ws_r.get("search_info", "") or ""
    _ws_product_type = _ws_r.get("product_type", "") or ""
    _ws_usage = _ws_r.get("usage", {}) or {}

    print(f"[WEB-SEARCH-REANSWER] keywords={_ws_keywords[:5]}  product_type={_ws_product_type}", file=sys.stderr)

    # ── Step 1: re-query DB ด้วย keywords ──
    _new_products: list[dict] = []
    _ws_kb_context = ""
    if _ws_keywords:
        _search_query = " ".join(_ws_keywords[:6])
        if _ws_product_type:
            _search_query = f"{_ws_product_type} {_search_query}"
        try:
            _new_products = product_store.fetch_products(
                db,
                message=_search_query,
                shop_filter=shop,
                limit=llm_ctx_limit,
                desc_message=llm_message,
            )
            print(f"[WEB-SEARCH-REANSWER] DB re-query: {_search_query!r} → {len(_new_products)} products", file=sys.stderr)
        except Exception as _e:
            print(f"[WEB-SEARCH-REANSWER] DB re-query error: {_e}", file=sys.stderr)

        # model code regex (PB/BA/LPB/WPB) — optional
        if do_model_code_regex and _ws_search_info:
            _model_codes = re.findall(
                r'\b(PB\d{3}[A-Z]?|P\d{2}|BA\d{3}[A-Z]?|LPB\d{3}[A-Z]?|WPB\d{3}[A-Z]?)\b',
                _ws_search_info,
            )
            if _model_codes:
                _model_codes = list(dict.fromkeys(_model_codes))[:5]
                print(f"[WEB-SEARCH-REANSWER] model codes: {_model_codes}", file=sys.stderr)
                for _code in _model_codes:
                    try:
                        _code_products = product_store.fetch_products(
                            db,
                            message=_code,
                            shop_filter=shop,
                            limit=3,
                            desc_message=llm_message,
                        )
                        _existing_ids = {p.get("item_id") or p.get("name") for p in _new_products}
                        for _cp in _code_products:
                            _pid = _cp.get("item_id") or _cp.get("name")
                            if _pid not in _existing_ids:
                                _new_products.append(_cp)
                                _existing_ids.add(_pid)
                    except Exception as _e:
                        print(f"[WEB-SEARCH-REANSWER] model code query error ({_code}): {_e}", file=sys.stderr)

        # KB lookup — optional
        if do_kb_lookup:
            try:
                _ws_kb_r = knowledge_base.lookup_kb(_search_query)
                if _ws_kb_r and _ws_kb_r.get("found"):
                    _ws_kb_context = _ws_kb_r.get("context", "") or ""
                    for _kd in _ws_kb_r.get("kb_docs", [])[:3]:
                        _kb_card = knowledge_base._kb_doc_to_card(_kd)
                        _kb_card["_kb_only"] = True
                        _new_products.append(_kb_card)
                    print(f"[WEB-SEARCH-REANSWER] KB re-query: {len(_ws_kb_r.get('kb_docs', []))} docs", file=sys.stderr)
            except Exception as _e:
                print(f"[WEB-SEARCH-REANSWER] KB re-query error: {_e}", file=sys.stderr)

    # ── Step 2: merge + dedup + rerank ──
    _final_products = _new_products if _new_products else list(products_in)
    if do_dedup_rerank and _final_products:
        # ⚡ 2026-09-16 — ใช้ _dedupe_products ระดับโมดูล (แทน _base_name/_listing_sell_score จาก closure)
        #   KB branch ต้องเรียกด้วย do_dedup_rerank=False เพราะยังไม่มี products ที่ต้อง dedup
        _final_products = product_store._dedupe_products(_final_products, log_label="DEDUP-WS")
        # rerank: standalone > bundle
        if len(_final_products) > req_limit:
            _final_products.sort(
                key=lambda p: not product_store._is_bundle_product(p),
                reverse=True,
            )

    # ── Step 3: strip URL ออกจาก search_info ──
    _ws_search_info_clean = _ws_search_info
    if _ws_search_info_clean:
        # markdown link [text](url) → ลบทั้งก้อน
        _ws_search_info_clean = re.sub(
            r'\[([^\]]+)\]\([^)]+\)', r'', _ws_search_info_clean
        )
        # plain URL
        _ws_search_info_clean = re.sub(
            r'https?://[^\s\)\]]+', r'', _ws_search_info_clean,
            flags=re.IGNORECASE,
        )
        # empty markdown link [text]() หรือ [text]( )
        _ws_search_info_clean = re.sub(
            r'\[([^\]]*)\]\(\s*\)', r'', _ws_search_info_clean
        )
        # whitespace รวม
        _ws_search_info_clean = re.sub(r'\s{2,}', ' ', _ws_search_info_clean).strip()
        # ถ้าสั้นเกินไป → ใช้ตัวเดิม (กันข้อมูลหายหมด)
        if len(_ws_search_info_clean) < 20:
            _ws_search_info_clean = _ws_search_info
        if _ws_search_info_clean != _ws_search_info:
            print(f"[WEB-SEARCH-REANSWER] stripped external URLs from search_info", file=sys.stderr)

    # ── Step 4: สร้าง extra_context ──
    _extra_context = ""
    if _ws_search_info_clean and len(_ws_search_info_clean) >= 20:
        _extra_parts = [
            "=== ข้อมูลจาก Google Search (ข้อมูลประกอบเท่านั้น — ห้ามใช้เป็นแหล่งหลัก) ===",
            "ห้ามนำข้อมูลนี้มาเป็นหัวข้อคำตอบหลัก, ห้ามแนะนำสินค้าที่ไม่อยู่ใน context,",
            "ห้ามตอบเรื่องสินค้า/แบรนด์อื่นที่ไม่ใช่สินค้าใน context",
            "ห้ามใส่ลิงก์ใดๆ ในคำตอบ นอกจาก short_link ของสินค้าใน context",
            "---",
            _ws_search_info_clean,
        ]
        if _ws_kb_context:
            _extra_parts.append(f"=== ข้อมูลจาก Knowledge Base ===\n{_ws_kb_context}")
        _extra_context = "\n".join(_extra_parts)
        if vision_context:
            _extra_context = (vision_context + "\n" + _extra_context).strip()
        if extra_context_prefix:
            _extra_context = (extra_context_prefix + "\n" + _extra_context).strip()

    # ── Step 5: record Search step ──
    _ws_t_in = _ws_usage.get("prompt", 0)
    _ws_t_out = _ws_usage.get("output", 0)
    _result["steps"].append({
        "name": "Search",
        "model": _result["search_model"] or "openrouter",
        "tokens_in": _ws_t_in,
        "tokens_out": _ws_t_out,
        "time_s": round(_result["search_elapsed"], 2),
        "cost_usd": round(_result["cost_usd"], 6),
        "cost_thb": round(_result["cost_usd"] * 36, 4),
        "input": {
            "message": search_message[:200],
            "reason": reason,
            "intent": intent_result.get("intent"),
        },
        "output": {
            "search_used": True,
            "keywords": _ws_keywords[:8],
            "product_type": _ws_product_type,
            "search_info": _ws_search_info_clean[:500],
        },
    })

    # ── Step 6: record RAG(search) step ──
    _final_names = [p.get("name", "")[:60] for p in _final_products[:10]]
    _result["steps"].append({
        "name": "RAG(search)",
        "model": "mongodb+kb",
        "tokens_in": 0,
        "tokens_out": 0,
        "time_s": 0,
        "cost_usd": 0,
        "cost_thb": 0,
        "input": {
            "query": " ".join(_ws_keywords[:6]) if _ws_keywords else "",
            "keywords": _ws_keywords[:8],
            "shop": shop,
        },
        "output": {
            "product_count": len(_final_products),
            "products": _final_names,
            "kb_used": bool(_ws_kb_context),
        },
    })

    # ── Step 7: LLM2 re-answer (search_info = ข้อมูลประกอบ ไม่ใช่คำตอบหลัก) ──
    if _final_products and _extra_context:
        print(f"[WEB-SEARCH-REANSWER] LLM2 re-answer with {len(_final_products)} products + search context", file=sys.stderr)
        try:
            _ws_answer, _ws_llm_usage = llm.answer(
                message=llm_message,
                products=_final_products,
                shop_hint=shop,
                history=history_list,
                persona_extra=persona_extra,
                intent_result=intent_result,
                extra_context=_extra_context,
            )
        except RuntimeError as _e:
            print(f"[WEB-SEARCH-REANSWER] LLM re-answer error: {_e}", file=sys.stderr)
            _ws_answer = ""
            _ws_llm_usage = {"prompt": 0, "output": 0, "total": 0}
    else:
        print(f"[WEB-SEARCH-REANSWER] no products or no search context → skip LLM2 re-answer", file=sys.stderr)
        _ws_answer = ""
        _ws_llm_usage = {"prompt": 0, "output": 0, "total": 0}

    # ── Step 8: record LLM2(search) step ──
    _llm2_t_in = _ws_llm_usage.get("prompt", 0)
    _llm2_t_out = _ws_llm_usage.get("output", 0)
    _llm2_cost = llm._gemini_cost(_llm2_t_in, _llm2_t_out)
    _result["steps"].append({
        "name": "LLM2(search)",
        "model": os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite"),
        "tokens_in": _llm2_t_in,
        "tokens_out": _llm2_t_out,
        "time_s": 0,
        "cost_usd": round(_llm2_cost, 6),
        "cost_thb": round(_llm2_cost * 36, 4),
        "input": {
            "message": llm_message[:200],
            "product_count": len(_final_products),
            "products": _final_names,
            "intent": intent_result.get("intent"),
            "history_count": len(history_list) if history_list else 0,
            "search_info_used": bool(_ws_search_info_clean),
            "kb_context_used": bool(_ws_kb_context),
        },
        "output": {
            "answer": _ws_answer[:500] if _ws_answer else "",
            "answer_full_length": len(_ws_answer) if _ws_answer else 0,
        },
    })

    _result["answer"] = _ws_answer
    _result["usage"] = _ws_llm_usage
    _result["products"] = _final_products
    return _result
