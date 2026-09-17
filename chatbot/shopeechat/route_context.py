"""route_context.py — resolve ข้อมูล routing จาก message จุดเดียว.

ทำไมมีไฟล์นี้:
- app.py เดิมเรียก _detect_product_types / _detect_charger_subtype / แก้ typo
  กระจายหลายจุดด้วย argument ต่างกัน → ย้ายมาไว้ที่เดียว ทดสอบได้
- `normalize_message` แก้ typo เทียบ `exports/typo_dict.json` (คำจริงจาก catalog)
  — แก้เฉพาะที่ชัวร์ (rapidfuzz ≥85) ไม่เดา

ผู้ใช้: units.fetch_units (Task 8) — และภายหลัง app.py ค่อยย้ายมาใช้
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent.parent.parent
_TYPO_DICT_PATH = _ROOT / "exports" / "typo_dict.json"

_TYPO_THRESHOLD = 85          # rapidfuzz score ขั้นต่ำที่ถือว่า typo จริง
_TYPO_MIN_LEN = 4             # คำสั้นกว่านี้ไม่แก้ (เสี่ยงแก้ผิด เช่น ec4 → ec2)

_SPEC_WORDS = ("สเปค", "spec", "รายละเอียด", "ขนาด", "น้ำหนัก", "วัตต์", "w ",
               "ความเร็ว", "รองรับ", "กี่วัตต์", "mah", "ความจุ", "ชาร์จเร็ว",
               "อินพุต", "เอาท์พุต", "input", "output", "พอร์ต")
_WARRANTY_WORDS = ("ประกัน", "รับประกัน", "warranty", "เคลม", "ศูนย์")
_SHIPPING_WORDS = ("จัดส่ง", "ส่งของ", "ขนส่ง", "ค่าส่ง", "กี่วัน", "ส่งไว")


@dataclass
class RouteContext:
    """ข้อมูล routing ที่ resolve แล้วจาก message เดียว."""
    message: str                      # message หลัง normalize
    product_types: set[str] = field(default_factory=set)
    charger_subtype: str | None = None
    model_codes: list[str] = field(default_factory=list)
    needs_spec: bool = False
    needs_warranty: bool = False
    needs_shipping: bool = False
    corrections: dict[str, str] = field(default_factory=dict)  # typo → คำที่แก้


_typo_sets: dict[str, set[str]] | None = None


def _load_typo_dict() -> dict[str, set[str]]:
    """โหลด typo_dict.json ครั้งเดียว (lazy) — ไม่มีไฟล์ → empty sets."""
    global _typo_sets
    if _typo_sets is None:
        try:
            d = json.loads(_TYPO_DICT_PATH.read_text(encoding="utf-8"))
        except Exception:
            d = {}
        _typo_sets = {k: set(v) for k, v in d.items()}
    return _typo_sets


def normalize_message(message: str) -> tuple[str, dict[str, str]]:
    """แก้ typo เทียบคำจริงใน catalog — คืน (ข้อความที่แก้, {เดิม:แก้}).

    กฎ: เฉพาะ token latin ≥4 chars; เลือก candidate ที่ score สูงสุด ≥85
    และไม่ใช่คำเดิมเป๊ะ (คำถูกอยู่แล้ว → score 100 กับตัวเอง → ข้าม)
    """
    if not message:
        return message, {}
    from rapidfuzz import fuzz, process

    td = _load_typo_dict()
    vocab = td.get("product_words", set()) | td.get("model_codes", set()) | td.get("brands", set())
    if not vocab:
        return message, {}

    thai_vocab = td.get("thai_terms", set())
    corrections: dict[str, str] = {}
    tokens = re.split(r"(\s+)", message)
    for i, tok in enumerate(tokens):
        t = tok.strip().lower()
        if not t:
            continue
        if re.fullmatch(r"[a-z0-9._\-]+", t) and len(t) >= _TYPO_MIN_LEN and t not in vocab:
            best = process.extractOne(t, vocab, scorer=fuzz.ratio, score_cutoff=_TYPO_THRESHOLD)
        elif re.fullmatch(r"[ก-๙]+", t) and len(t) >= 3 and t not in thai_vocab:
            # ภาษาไทย threshold สูงกว่า — false positive อันตรายกว่า (คำไทยคล้ายกันเยอะ)
            best = process.extractOne(t, thai_vocab, scorer=fuzz.ratio, score_cutoff=90)
        else:
            continue
        if best and best[0] != t:
            tokens[i] = tok.replace(t, best[0]) if tok != t else best[0]
            corrections[t] = best[0]
    return "".join(tokens), corrections


def resolve_route(message: str, intent_result: dict | None = None) -> RouteContext:
    """Resolve routing ครั้งเดียว: normalize → types/subtype/codes/needs.

    intent_result: ผล intent_classifier (ใช้เป็น fallback เมื่อ msg ไม่มี subtype)
    """
    from . import product_store as _ps
    from .scripts.unit_classifier import _extract_codes

    msg, corrections = normalize_message(message or "")
    low = msg.lower()

    ptypes = _ps._detect_product_types(msg)
    subtype = _ps._detect_charger_subtype(msg)
    if not subtype and intent_result and intent_result.get("product_type") == "charger":
        v = intent_result.get("charger_subtype")
        if v in ("adapter", "cable", "set", "car_charger", "wireless", "desktop", "socket"):
            subtype = v

    return RouteContext(
        message=msg,
        product_types=ptypes,
        charger_subtype=subtype,
        model_codes=_extract_codes(msg),
        needs_spec=any(w in low for w in _SPEC_WORDS),
        needs_warranty=any(w in low for w in _WARRANTY_WORDS),
        needs_shipping=any(w in low for w in _SHIPPING_WORDS),
        corrections=corrections,
    )
