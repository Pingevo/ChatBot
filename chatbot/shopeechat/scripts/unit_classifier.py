"""unit_classifier — แยกส่วนประกอบ/ประเภทของ "unit" (item_id × model_id) จากชื่อ.

3 ชั้นตามความน่าเชื่อถือ (ตามแผน docs/superpowers/plans/2026-09-16-sellable-unit-index.md):
  1. model_codes จาก model_sku + model_name (token ที่มีตัวอักษร+ตัวเลข ยาว ≥3)
  2. components จาก pattern บน model_name เท่านั้น (เฉพาะX / พร้อมX / X+Y / +xx GB / multi-code)
  3. product_type จาก PRODUCT_TYPES regex ของ product_store (reuse — ไม่เขียนตารางใหม่)

kind:
  standalone = unit เป็นชิ้นเดียวที่ระบุชัด ("เฉพาะหัว", "เฉพาะสาย")
  variant    = ตัวสินค้าหลัก แตกต่างแค่สี/เวอร์ชัน/ความจุ ("สีชมพู", "PB100Pเทา CN.V")
  combo      = สินค้าหลัก + อุปกรณ์เสริม ("พร้อมสาย", "+64 GB", "+Smart Hub")
"""

from __future__ import annotations

import re

from chatbot.shopeechat.product_store import PRODUCT_TYPES, _CHARGER_SUBTYPES

# ---- ตารางเดียวต้นไฟล์ — ย้ายไป config/DB ทีหลังได้ ----

# PRODUCT_TYPES → component ของ "ตัวสินค้าหลัก" (ใช้เป็น comps[0] เสมอ)
_TYPE_TO_MAIN_COMP = {
    "charger": "adapter", "car_charger": "adapter", "wireless_charger": "adapter",
    "desktop_charger": "adapter", "cable": "cable", "powerbank": "powerbank",
    "camera": "camera", "smartwatch": "watch", "smartband": "watch",
    "phone": "phone", "tablet": "tablet", "earphone": "earphone",
    "speaker": "speaker", "soundbar": "speaker", "memory_card": "sd_card",
    "case": "case", "strap": "strap", "screen_protector": "screen_protector",
    "solar_panel": "solar_panel",
}

# component → product_type ระดับ unit (เฉพาะสาย → cable, เฉพาะหัว → charger)
_COMP_TO_TYPE = {
    "adapter": "charger", "cable": "cable", "sd_card": "memory_card",
    "hub": "smart_home", "solar_panel": "solar_panel", "strap": "strap",
    "case": "case", "earphone": "earphone", "powerbank": "powerbank",
    "screen_protector": "screen_protector", "camera": "camera",
    "watch": "smartwatch", "phone": "phone", "tablet": "tablet",
}

# part keywords ต่อ component — เช็คแบบลำดับ (เฉพาะเจาะจงก่อนคำกว้าง)
_PART_WORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("strap", ("สายนาฬิกา", "สายคล้อง", "strap", "สายรัดข้อมือ")),
    ("solar_panel", ("solar panel", "solar", "โซลาร์", "โซล่า", "แผงโซลาร์")),
    ("hub", ("smart hub", "hub", "ฮับ", "gateway")),
    ("sd_card", ("micro sd", "microsd", "sd card", "memory card",
                 "เมมโมรี่", "การ์ดหน่วยความจำ", "sd", "เมม")),
    ("screen_protector", ("กระจกนิรภัย", "tempered", "screen protector", "ฟิล์ม")),
    ("adapter", ("หัวชาร์จ", "หัวชาร์ต", "หัวปลั๊ก", "adapter",
                 "อแดปเตอร์", "แอ็ดดัปเตอร์", "หัว")),
    ("powerbank", ("แบตสำรอง", "แบตเตอรี่สำรอง", "powerbank", "power bank",
                   "พาวเวอร์แบงค์", "พาวเวอร์แบงก์")),
    ("cable", ("สายชาร์จ", "สายชาร์ต", "สายถัก", "สายไนลอน", "สายซิลิโคน",
               "สายดิ่ง", "สายข้อมูล", "cable", "สาย")),
    ("earphone", ("หูฟัง", "earphone", "earbuds", "headphone")),
    ("camera", ("กล้อง", "camera")),
    ("watch", ("นาฬิกา", "วอทช์", "วอช", "watch")),
    ("case", ("เคส", "case", "ซอง")),
    ("stand", ("ขาตั้ง", "stand", "แท่นวาง", "ที่วาง")),
    ("mount", ("mount", "ขายึด", "ที่ยึด", "แขวน")),
    ("bag", ("กระเป๋า", "bag", "ถุง")),
)

# segment ที่ไม่ใช่ component — สี/เวอร์ชัน/มาตรฐาน
_COLOR_WORDS = (
    "สีเทา", "สีดำ", "สีขาว", "สีชมพู", "สีทอง", "สีเงิน", "สีเบจ", "สีน้ำเงิน",
    "สีเขียว", "สีแดง", "สีม่วง", "สีเหลือง", "สีส้ม", "สีฟ้า", "สีกะปิ",
    "เทา", "ดำ", "ขาว", "ชมพู", "ทอง", "เงิน", "เบจ", "น้ำเงิน", "เขียว",
    "แดง", "ม่วง", "เหลือง", "ส้ม", "ฟ้า", "กะปิ",
    "black", "white", "gray", "grey", "gold", "silver", "pink", "blue",
    "green", "red", "purple", "orange", "rose gold",
)
_SKIP_SEGMENTS = (
    "cn.v", "gb.v", "cnv", "gbv", "ccc", "ce", "global", "เวอร์ชั่น", "version",
    "ver", "cn", "gb", "mtl", "metal",
    "bk", "wh", "gr", "gd", "bl", "pk", "rd", "sl", "gl", "rg", "bkwh",
)

_CODE_RE = re.compile(r"^[A-Za-z]{0,5}\d{2,5}[A-Za-z]{0,3}$")
_GB_RE = re.compile(r"\b\d{2,4}\s*gb\b", re.I)
_OOS_RE = re.compile(r"หมด|sold\s*out|out\s*of\s*stock", re.I)
_CHARGING_TYPES = {"charger", "cable", "car_charger", "wireless_charger",
                   "desktop_charger", "powerbank", "phone", "tablet"}

_TYPE_RES = tuple(
    (name, re.compile(rx, re.IGNORECASE)) for name, _kws, rx in PRODUCT_TYPES
)


_COMPAT_RE = re.compile(
    r"(?:สำหรับ|รองรับ|ใช้(?:งาน)?กับ|เหมาะกับ|for)\s*[a-z0-9ก-๙.+_\- ]{0,30}", re.IGNORECASE)
_CABLE_ONLY_RE = re.compile(r"สายชาร์จ|สายชาร์ต|\bcable\b", re.IGNORECASE)


def _detect_type(text: str) -> str | None:
    """product_type แรกที่ regex match — ตามลำดับ PRODUCT_TYPES (priority เดิม)."""
    low = text.lower()
    # compat phrase ไม่ใช่ประเภทสินค้า — "สายชาร์จ สำหรับ iPhone" คือ cable ไม่ใช่ phone
    low = _COMPAT_RE.sub(" ", low)
    # "สายชาร์จ" ล้วน = cable — กัน charger pattern กลืน "ชาร์จ"
    # แต่ "พร้อมสายชาร์จ"/"หัวชาร์จ" = ชาร์จแถมสาย → ปล่อย table ตัดสิน
    if (_CABLE_ONLY_RE.search(low) and "หัวชาร์จ" not in low
            and "หัวชาร์ต" not in low and not re.search(r"พร้อม\s*สาย", low)):
        return "cable"
    for name, rx in _TYPE_RES:
        if rx.search(low):
            return name
    return None


def _extract_codes(text: str) -> list[str]:
    """model codes: token ที่มีตัวอักษร+ตัวเลข ยาว ≥3 (HA835, AL870, PB150P, EC4, P23)."""
    codes = []
    for tok in re.split(r"[\s\-_/+(),]+", text or ""):
        t = tok.strip()
        if (3 <= len(t) <= 12 and _CODE_RE.match(t)
                and any(c.isdigit() for c in t) and any(c.isalpha() for c in t)):
            codes.append(t.upper())
    return codes


def _norm_seg(seg: str) -> str:
    return re.sub(r"[\s()\-_]+", "", seg.strip().lower())


def _is_color_or_version(seg: str) -> bool:
    s = _norm_seg(seg)
    if s in _SKIP_SEGMENTS:
        return True
    return any(_norm_seg(c) == s or s.startswith("สี") and _norm_seg(seg[2:]) == _norm_seg(c)
               for c in _COLOR_WORDS)


def _seg_component(seg: str, item_type: str | None) -> str | None:
    """component ของ segment เดียว — สาย → cable (charging) / strap (smartwatch)."""
    s = seg.lower()
    for comp, words in _PART_WORDS:
        if any(w in s for w in words):
            if comp == "cable" and item_type in ("smartwatch", "smartband"):
                return "strap"
            return comp
    if _GB_RE.search(s):
        return "sd_card"
    return None


def _seg_is_code(seg: str) -> bool:
    s = _norm_seg(seg)
    return bool(_CODE_RE.match(s) and any(c.isdigit() for c in s))


def _code_matches_listing(seg: str, listing_codes: set[str]) -> bool:
    """segment code ตรงกับ code ของ listing (เช่น 716BK vs HA716 — เทียบตัวเลข)."""
    seg_digits = re.sub(r"\D", "", seg)
    if not seg_digits:
        return False
    for lc in listing_codes:
        if seg_digits and seg_digits in re.sub(r"\D", "", lc):
            return True
    return False


def _companion_comp(item_type: str | None) -> str:
    """component เริ่มต้นของ code คู่ที่ resolve ไม่ได้ (charging family → cable)."""
    return "cable" if item_type in _CHARGING_TYPES else "accessory"


def _parse_components(model_name: str, item_type: str | None,
                      listing_codes: set[str], item_name: str = "") -> tuple[list[str], bool]:
    """คืน (components, explicit_standalone) — main comp อยู่ index 0 เสมอ."""
    main = _TYPE_TO_MAIN_COMP.get(item_type) or item_type
    low = (model_name or "").lower()
    item_low = (item_name or "").lower()
    explicit = False

    # "เฉพาะX" / "X เดียว" — unit คือชิ้นเดียวที่ระบุ → standalone
    m = re.search(r"เฉพาะ\s*([ก-๙a-zA-Z]+)", low)
    if m:
        comp = _seg_component(m.group(1), item_type)
        return [comp or main or "accessory"], True
    if re.search(r"(หัว|สาย|ตัว|เครื่อง)\s*เดียว", low):
        comp = _seg_component(re.search(r"(หัว|สาย|ตัว|เครื่อง)\s*เดียว", low).group(1), item_type)
        return [comp or main or "accessory"], True

    comps: list[str] = []
    saw_main = False
    # แยก segments ด้วย + / กับ / และ
    for seg in re.split(r"\+|กับ|และ", model_name or ""):
        seg = seg.strip()
        if not seg:
            continue
        if _is_color_or_version(seg):
            saw_main = True  # สี/เวอร์ชันอธิบายตัวสินค้าหลัก (อุปกรณ์ลอยๆ ไม่มีสี variant)
            continue
        if re.search(r"พร้อม", seg):
            rest = re.sub(r".*พร้อม\s*", "", seg)
            comp = _seg_component(rest or seg, item_type)
            saw_main = True  # "X พร้อม Y" → X คือตัวสินค้าหลักเสมอ
        else:
            comp = _seg_component(seg, item_type)
        if comp:
            if comp not in comps:
                comps.append(comp)
            continue
        # segment เป็น code-only: match listing → หลักฐานตัวสินค้าหลัก; code อื่น → companion
        # (code ที่อยู่ใน segment เดียวกับ part word — เช่น "สายชาร์จ AL870" —
        #  คือ code ของ component นั้น ไม่ใช่หลักฐาน main product)
        # เช็ค listing match ก่อน _seg_is_code — code สั้นอย่าง EC4 (เลขตัวเดียว)
        # ไม่ผ่าน _seg_is_code แต่ match listing ได้;
        # segment ที่อยู่ใน item_name ตรงๆ (EC4 ไม่อยู่ใน listing_codes เพราะเลขตัวเดียว)
        # ก็เป็นหลักฐานตัวสินค้าหลักเช่นกัน
        if _code_matches_listing(seg, listing_codes) or (
                len(seg) >= 2 and any(c.isalpha() for c in seg) and seg.lower() in item_low):
            saw_main = True
            continue
        if _seg_is_code(seg):
            comp = _companion_comp(item_type)
            if comp not in comps:
                comps.append(comp)
    # main comp ใส่ index 0 เฉพาะเมื่อมีหลักฐานตัวสินค้าหลัก หรือไม่เจอ comp ไหนเลย
    if main and (saw_main or not comps) and main not in comps:
        comps.insert(0, main)
    if not comps and (main or item_type):
        comps = [main or item_type]  # type ไม่รู้จัก (เฟอร์นิเจอร์) → main=item_type เอง
    return comps, explicit


def _charger_subtype(comps: list[str], text: str, item_type: str | None) -> str | None:
    """subtype จาก _CHARGER_SUBTYPES kw ก่อน (car/wireless/desktop/set) แล้วค่อย comps."""
    low = text.lower()
    for sub in ("car_charger", "wireless", "desktop"):
        if any(kw in low for kw in _CHARGER_SUBTYPES.get(sub, ())):
            return sub
    if "ชุดชาร์จ" in low or "ชุดชาร์ต" in low:
        return "set"
    s = set(comps)
    if s == {"adapter", "cable"}:
        return "set"
    if s == {"adapter"}:
        return "adapter"
    if s == {"cable"}:
        return "cable_only"
    return None


def _cable_subtype(text: str) -> str | None:
    low = text.lower()
    if "c to c" in low or "type c to c" in low or "type-c to type-c" in low:
        return "c-to-c"
    if "c to l" in low or "to lightning" in low:
        return "c-to-l"
    if "lightning" in low or "ไลนิ่ง" in low or "ไลนิง" in low:
        return "lightning"
    if "micro" in low:
        return "micro"
    if "type a" in low or "usb-a" in low or "usb a" in low:
        return "type-a"
    if "type c" in low or "type-c" in low or "usb-c" in low or "usb c" in low:
        return "usb-c"
    return None


def _camera_subtype(text: str) -> str | None:
    low = text.lower()
    if "ติดรถ" in low or "dashcam" in low or "dash cam" in low:
        return "dashcam"
    if "doorbell" in low or "กริ่ง" in low:
        return "doorbell"
    if "นอกบ้าน" in low or "outdoor" in low or "ภายนอก" in low:
        return "outdoor"
    if "ในบ้าน" in low or "indoor" in low or "ภายใน" in low:
        return "indoor"
    return None


def classify_unit(item_name: str, model_name: str = "", model_sku: str = "",
                  kb_lookup=None) -> dict:
    """classify unit → {components, kind, product_type, charger_subtype, cable_subtype,
    camera_subtype, model_codes, oos_in_name, confidence}"""
    item_type = _detect_type(item_name or "")
    listing_codes = set(_extract_codes(item_name or ""))
    model_codes = _extract_codes(model_sku or "") + _extract_codes(model_name or "")

    comps, explicit = _parse_components(model_name or "", item_type, listing_codes,
                                        item_name=item_name)
    if not comps and item_type:
        comps = [_TYPE_TO_MAIN_COMP.get(item_type) or item_type]

    text = f"{item_name} {model_name}"

    # kind — standalone เมื่อ unit เป็น "ชิ้นเดียวที่ไม่ใช่ตัวสินค้าหลัก" (เฉพาะสายใน listing หัวชาร์จ)
    main_comp = (_TYPE_TO_MAIN_COMP.get(item_type) or item_type) if item_type else None
    if len(comps) > 1:
        kind = "combo"
    elif explicit or (comps and main_comp not in comps):
        kind = "standalone"
    else:
        kind = "variant"

    # unit-level product_type
    if len(comps) == 1:
        product_type = _COMP_TO_TYPE.get(comps[0], item_type)
    elif comps:
        product_type = _COMP_TO_TYPE.get(comps[0], item_type) or item_type
    else:
        product_type = item_type

    charger_subtype = _charger_subtype(comps, text, item_type) \
        if product_type in ("charger", "cable") or set(comps) & {"adapter", "cable"} else None
    cable_subtype = _cable_subtype(text) if "cable" in comps or product_type == "cable" else None
    camera_subtype = _camera_subtype(text) if product_type == "camera" or "camera" in comps else None

    known = bool(comps) + bool(product_type)
    confidence = "high" if known == 2 else ("medium" if known == 1 else "low")
    if confidence == "low":
        product_type = None  # ไม่ฝืนเดา

    return {
        "components": comps,
        "kind": kind,
        "product_type": product_type,
        "charger_subtype": charger_subtype,
        "cable_subtype": cable_subtype,
        "camera_subtype": camera_subtype,
        "model_codes": list(dict.fromkeys(model_codes)),
        "oos_in_name": bool(_OOS_RE.search(model_name or "")),
        "confidence": confidence,
    }


if __name__ == "__main__":
    # self-check เคสหลัก — assert ล้มถ้า logic พัง (ponytail: runnable check)
    r = classify_unit("ZMI HA835 หัวชาร์จ 65W", "HA835 เฉพาะหัว", "ZMI-HA835-BK")
    assert r["components"] == ["adapter"] and r["kind"] == "standalone", r
    r = classify_unit("IMILAB EC4 กล้องวงจรปิด", "EC4 +Smart Hub+Solar", "X")
    assert r["components"] == ["camera", "hub", "solar_panel"] and r["kind"] == "combo", r
    print("unit_classifier self-check OK")
