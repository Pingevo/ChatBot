"""Device compatibility helpers — ย้ายออกจาก app.py (refactor).

ครอบคลุม:
- _extract_max_wattage / _extract_product_connectors — สกัด spec จาก product card
- _lookup_spec_db / _resolve_device_spec — spec ของอุปกรณ์ปลายทาง (data อยู่ device_specs_data.py)
- _filter_compat_products — กรองสินค้าตาม connector compatibility
- _apply_product_tiers — รวม tier A (exact/anchor) + tier B (general) ก่อนส่ง LLM
- _device_spec_lookup — web-search spec + re-query DB หาสินค้าที่ compat

ใช้โดย legacy chat() ใน app.py (import เป็น module: device_compat._xxx)
"""

from __future__ import annotations

import re
import sys
from typing import TYPE_CHECKING

from . import product_store

if TYPE_CHECKING:
    from .route_context import RetrievalProfile


def _extract_max_wattage(p: dict) -> float:
    """extract ค่า W สูงสุดจาก spec field ก่อน ถ้าไม่มีค่อยดึงจากชื่อ.

    กรอง model number ออก เช่น CTC615W = สายชาร์จ 240W จริง (615 เป็น model number ไม่ใช่ wattage)

    ⚡ Phase 3b — ย้ายจาก nested function ใน superlative block มาเป็น module-level helper
        เพื่อให้ device-spec-lookup re-query block ใช้ sort ตาม wattage ได้
    """
    # 1. ลองจาก spec field ก่อน (output_power_w จาก CSV schema)
    spec_w = p.get("output_power_w") or p.get("specs", {}).get("output_power_w")
    if spec_w and isinstance(spec_w, (int, float)) and spec_w > 0:
        return float(spec_w)
    # 2. ลองจาก variants ที่มี output_power_w
    variants = p.get("variants") or []
    max_v = 0.0
    for v in variants:
        vw = v.get("output_power_w")
        if vw and isinstance(vw, (int, float)) and vw > max_v:
            max_v = float(vw)
    if max_v > 0:
        return max_v
    # 3. fallback: extract จากชื่อสินค้า
    name = p.get("name") or p.get("item_name") or ""
    if not name:
        return 0.0
    low_name = name.lower()
    # กรอง model number ออกก่อน: CTC615W, CMC610, AD653U, AC30S, ZA651, etc.
    # pattern: ตัวอักษร 2-4 ตัว + ตัวเลข 2-4 ตัว + ตัวอักษร 0-2 ตัว + W
    # แทนที่ด้วยช่องว่าง เพื่อไม่ให้ regex จับเป็น wattage
    _model_pat = re.compile(r"\b[a-z]{2,4}\d{2,4}[a-z]?\s*w\b")
    clean_name = _model_pat.sub(" ", low_name)
    # หาทุกค่าที่ลงท้ายด้วย W (เช่น 210W, 140W, 55W, 30W) ในชื่อที่กรองแล้ว
    matches = re.findall(r"(\d+(?:\.\d+)?)\s*w\b", clean_name)
    if not matches:
        return 0.0
    return max(float(m) for m in matches)


def _wattage_asc_key(p: dict, min_watt: float | None = None) -> tuple:
    """sort key สำหรับเรียง wattage ascending แบบ "adequate first".

    ถ้ารู้ min_watt (spec ของอุปกรณ์เป้าหมาย): สินค้าที่จ่ายไฟพอ spec (watt ≥ min_watt)
    ขึ้นก่อนเรียง asc — ตำแหน่ง "baseline" ของ dual-tier จึงเป็นสินค้าที่ spec ผ่านจริง
    ไม่ใช่ตัว watt ต่ำสุดใน pool (เช่น สาย 60W สำหรับเครื่อง 90W)

    ถ้าไม่รู้ min_watt → asc ล้วน (พฤติกรรมเดิม)
    """
    w = _extract_max_wattage(p)
    if min_watt and min_watt > 0:
        return (0 if w >= min_watt else 1, w)
    return (0, w)


# ⚡ generic device-token extraction — ไม่ hardcode ชื่อรุ่น (แทน list เดิมที่ต้องอัปเดตทุกรุ่นใหม่)
#   Pattern A: "letters+digits" glued หรือ spaced + variant suffix
#     (iphone 17 pro max / mi 17 ultra / s25 / oneplus 13 / m3 / pixel 9)
#   Pattern B: "brand + category-word + digits"
#     (apple watch 9 / galaxy buds 3 / mi band 9 / redmi note 14 / xiaomi pad 7)
_DEVICE_TOKEN_RE = re.compile(
    r"\b(?:"
    r"[a-z]+\s*\d{1,3}[a-z]?"
    r"(?:\s+(?:ultra|pro\s*max|pro|max|plus|air|mini|lite|se|fe|fold|flip|note|gt|edge))?"
    r"|[a-z]{2,}\s+(?:watch|phone|pad|tab|buds|band|pods|note)\s*\d{1,3}[a-z]?"
    r")\b"
)

# ⚡ spec DB — curated data (device_specs_data.py) แทน _KNOWN_DEVICE_SPECS เดิม
#   flat index: normalized term (canonical name + aliases) → canonical key
from .device_specs_data import DEVICE_SPECS as _DEVICE_SPECS

_SPEC_INDEX: dict[str, str] = {}
for _name, _spec in _DEVICE_SPECS.items():
    _SPEC_INDEX[_name] = _name
    for _a in _spec.get("aliases", ()):
        _a_norm = (_a or "").strip().lower()
        if _a_norm:
            _SPEC_INDEX[_a_norm] = _name
_SPEC_TERMS_BY_LEN = sorted(_SPEC_INDEX, key=len, reverse=True)

# head-word ของ canonical key → brand (ใช้ brand-guard กัน "14 pro" ของ iPhone ทับ "mi 14 pro")
_SPEC_HEAD_BRAND = {
    "iphone": "apple", "ipad": "apple", "macbook": "apple", "apple": "apple", "airpods": "apple",
    "galaxy": "samsung",
    "xiaomi": "xiaomi", "redmi": "xiaomi", "poco": "xiaomi",
    "huawei": "huawei", "honor": "honor",
    "oppo": "oppo", "oneplus": "oneplus",
    "realme": "realme",
    "vivo": "vivo", "iqoo": "vivo",
    "pixel": "google", "nexus": "google",
    "nothing": "nothing", "cmf": "nothing",
    "xperia": "sony", "sony": "sony",
    "rog": "asus", "zenfone": "asus", "asus": "asus",
    "motorola": "motorola", "moto": "motorola", "razr": "motorola",
    "infinix": "infinix", "tecno": "tecno", "itel": "itel",
    "nokia": "nokia", "lumia": "nokia",
    "zte": "zte", "nubia": "zte", "meizu": "meizu", "lenovo": "lenovo", "legion": "lenovo",
    "lg": "lg", "htc": "htc", "blackberry": "blackberry",
    "steam": "valve", "nintendo": "nintendo", "ps": "sony", "surface": "microsoft",
    # laptop/audio/gadget brands (spec-db expansion 2026-09)
    "dell": "dell", "xps": "dell",
    "hp": "hp", "spectre": "hp", "envy": "hp", "pavilion": "hp", "elitebook": "hp",
    "thinkpad": "lenovo", "ideapad": "lenovo", "yoga": "lenovo", "thinkbook": "lenovo",
    "zenbook": "asus", "vivobook": "asus", "tuf": "asus", "zephyrus": "asus", "strix": "asus",
    "acer": "acer", "swift": "acer", "aspire": "acer", "nitro": "acer",
    "msi": "msi",
    "freebuds": "huawei", "enco": "oppo", "linkbuds": "sony",
    "amazfit": "amazfit", "garmin": "garmin", "fitbit": "fitbit",
    "gopro": "gopro", "kindle": "amazon",
    "jbl": "jbl", "marshall": "marshall", "bose": "bose", "beats": "beats",
}

# brand hint จากข้อความ — (regex, brand); ถ้า detect ได้ brand เดียวพอดี → filter candidates
_DEVICE_BRAND_HINTS: tuple = tuple(
    (re.compile(pat), brand) for pat, brand in (
        (r"iphone|ipad|macbook|airpods|apple|iwatch|ไอโฟน|ไอแพด|แมค", "apple"),
        (r"samsung|galaxy|ซัมซุง|ซัมซัง", "samsung"),
        (r"xiaomi|redmi|poco|เสียวหมี่|ชาวมี|\bmi\b", "xiaomi"),
        (r"huawei|mate|pura|nova|หัวเว่ย", "huawei"),
        (r"honor|ออนเนอร์", "honor"),
        (r"oppo|reno|ออปโป้", "oppo"),
        (r"oneplus|one plus|วันพลัส", "oneplus"),
        (r"realme|narzo|เรียลมี", "realme"),
        (r"vivo|iqoo|วีโว่", "vivo"),
        (r"pixel|nexus|พิกเซล", "google"),
        (r"nothing|cmf", "nothing"),
        (r"sony|xperia|โซนี่", "sony"),
        (r"asus|rog|zenfone|เอซุส", "asus"),
        (r"motorola|moto|razr|โมโต", "motorola"),
        (r"infinix", "infinix"),
        (r"tecno|camon|pova|spark|phantom", "tecno"),
        (r"itel", "itel"),
        (r"nokia|lumia|โนเกีย", "nokia"),
        (r"zte|nubia|red magic", "zte"),
        (r"meizu", "meizu"),
        (r"lenovo|legion", "lenovo"),
        (r"\blg\b", "lg"),
        (r"htc", "htc"),
        (r"nintendo|switch", "nintendo"),
        (r"steam", "valve"),
        (r"surface", "microsoft"),
        (r"dell|xps", "dell"),
        (r"\bhp\b|spectre|envy|pavilion|elitebook", "hp"),
        (r"thinkpad|ideapad|yoga|thinkbook", "lenovo"),
        (r"zenbook|vivobook|tuf gaming|rog\b", "asus"),
        (r"acer|aspire|nitro|\bswift\b", "acer"),
        (r"\bmsi\b", "msi"),
        (r"amazfit", "amazfit"),
        (r"garmin", "garmin"),
        (r"fitbit", "fitbit"),
        (r"gopro", "gopro"),
        (r"kindle", "amazon"),
        (r"jbl", "jbl"),
        (r"marshall", "marshall"),
        (r"bose", "bose"),
        (r"beats", "beats"),
        (r"freebuds", "huawei"),
        (r"enco", "oppo"),
        (r"linkbuds", "sony"),
    )
)


def _spec_brand(canon: str) -> str:
    """brand ของ canonical entry — จาก head-word ของ key"""
    return _SPEC_HEAD_BRAND.get((canon or "").split(" ", 1)[0], "")


def _device_brand_hint(low: str) -> str:
    """brand ที่ detect จาก input — คืน brand เดียวเฉพาะเมื่อเจอ brand เดียวพอดี (หลาย/ไม่มี → '')"""
    brands = {brand for pat, brand in _DEVICE_BRAND_HINTS if pat.search(low)}
    return brands.pop() if len(brands) == 1 else ""


def _ascii_alnum(ch: str) -> bool:
    return ch.isascii() and ch.isalnum()


def _term_boundary_match(term: str, low: str) -> bool:
    """term อยู่ใน low แบบ token boundary — ต้น/ท้ายไม่ติด ascii alnum
    (กัน 'a56' ฝังใน 'cta56' / 'iphone 5' ฝังใน 'iphone 5s';
    ตัวอักษรไทยนับเป็น boundary เพราะไม่ใช่ ascii → 'ใช้กับiphone17' ยัง match)"""
    i = low.find(term)
    while i >= 0:
        left_ok = i == 0 or not _ascii_alnum(low[i - 1])
        j = i + len(term)
        right_ok = j == len(low) or not _ascii_alnum(low[j])
        if left_ok and right_ok:
            return True
        i = low.find(term, i + 1)
    return False


def _lookup_spec_db(device_name: str) -> dict | None:
    """⚡ ค้น spec จาก DEVICE_SPECS — exact → boundary substring longest-match + brand guard.

    - exact: input == term (canonical/alias) → ใช้เลย
    - substring: term ต้อง match แบบ token boundary (กัน 'a56' ใน 'cta56')
    - brand guard: input มี brand เดียวชัด (เช่น 'mi', 'xiaomi', 'vivo') →
      รับเฉพาะ entry ที่ brand ตรง — ไม่ตรงหมด → None → web fallback
      (กัน '14 pro' ของ iPhone ทับ 'mi 14 pro' ของ Xiaomi)

    Returns: {"device": canonical, "min_watt"(=wired_w), "connector", "wired_w",
              "wireless_w", "protocols", "year"} หรือ None ถ้าไม่มีใน DB
    """
    low = (device_name or "").lower().strip()
    if not low:
        return None
    canon = _SPEC_INDEX.get(low)
    if not canon:
        hint = _device_brand_hint(low)
        cands = sorted(
            ((_term, _c) for _term, _c in _SPEC_INDEX.items()
             if _term in low and _term_boundary_match(_term, low)),
            key=lambda t: len(t[0]), reverse=True,
        )
        for _term, _c in cands:
            if not hint or _spec_brand(_c) == hint:
                canon = _c
                break
            print(f"[DEVICE-SPEC] brand-guard: drop {_term!r}→{_c!r} "
                  f"(brand={_spec_brand(_c)!r} != hint={hint!r})", file=sys.stderr)
    if not canon:
        return None
    return {"device": canon, "min_watt": _DEVICE_SPECS[canon].get("wired_w"),
            **_DEVICE_SPECS[canon]}


# compact device shorthand — normalize เป็น canonical เฉพาะ family ที่รู้จัก
# (iphone/ip/i, ไอโฟน, mi) ไม่ใช่ letters+digits ทั่วไป → product code ไม่รั่ว
_IPHONE_ALIAS_RE = re.compile(
    r"^(?:iphone|ip|i)\s*(\d{1,2})\s*"
    r"(pro\s*max|promax|plus|mini|se|air|pro)?$")
_MI_ALIAS_RE = re.compile(
    r"^mi\s*(\d{1,2})\s*"
    r"(pro\s*max|promax|ultra|t\s*pro|pro|t)?$")
_THAI_IPHONE_ALIAS_RE = re.compile(
    r"^ไอโฟน\s*(\d{1,2})\s*(โปรแมกซ์|โปร|พลัส|มินิ|แอร์)?$")
_THAI_SUFFIX = {"โปรแมกซ์": "pro max", "โปร": "pro", "พลัส": "plus",
              "มินิ": "mini", "แอร์": "air"}
_EN_SUFFIX = {"promax": "pro max"}

# probe กว้างสำหรับ form ที่ _DEVICE_TOKEN_RE จับไม่ได้ (glued suffix / ไทย) —
# normalize_device_alias เป็นตัว validate จริง
_DEVICE_ALIAS_PROBE_RE = re.compile(
    r"(?<![a-z0-9])(?:iphone|ip|i|mi)\s*\d{1,2}"
    r"(?:\s*(?:pro\s*max|promax|ultra|t\s*pro|plus|mini|se|air|pro|t))?"
    r"(?![a-z0-9])"
    r"|ไอโฟน\s*\d{1,2}(?:โปรแมกซ์|โปร|พลัส|มินิ|แอร์)?")


def normalize_device_alias(value: str) -> str | None:
    """คืน canonical device สำหรับ shorthand/compact form ที่รู้จัก
    ('mi14pro'→'xiaomi 14 pro', 'ip14'→'iphone 14', 'ไอโฟน14โปร'→'iphone 14 pro')
    — None สำหรับ product code / family ที่ไม่รองรับ"""
    low = re.sub(r"\s+", " ", (value or "").lower()).strip()
    if not low:
        return None
    m = _IPHONE_ALIAS_RE.match(low)
    if m:
        suf = _EN_SUFFIX.get(m.group(2) or "", m.group(2) or "")
        return f"iphone {m.group(1)}{' ' + suf if suf else ''}"
    m = _THAI_IPHONE_ALIAS_RE.match(low)
    if m:
        suf = _THAI_SUFFIX.get(m.group(2) or "", "")
        return f"iphone {m.group(1)}{' ' + suf if suf else ''}"
    m = _MI_ALIAS_RE.match(low)
    if m:
        suf = _EN_SUFFIX.get(m.group(2) or "", m.group(2) or "")
        return f"xiaomi {m.group(1)}{' ' + suf if suf else ''}"
    return None


# head token ที่ match "letters+digits" แต่ไม่ใช่ device — protocol/connector/unit/product-noun
_NON_DEVICE_TOKENS = frozenset({
    "usb", "pd", "qc", "pps", "ufcs", "gan", "mfi", "type", "qi", "qi2",
    "magsafe", "nfc", "hdmi", "wifi", "bt", "ble", "lte",
    "w", "v", "a", "c", "g", "e", "k", "mah", "wh", "kw", "gb", "tb", "mb",
    "ghz", "hz", "mm", "cm", "kg",
    "set", "lot", "gen", "ver", "version", "rev", "mk", "no", "pcs", "pc",
    "pack", "box", "series", "part", "ep", "vol", "level", "stage",
    "watch", "phone", "pad", "tab", "buds", "band", "pods", "note",
    "cable", "charger", "adapter", "case", "cover",
})


def _extract_device_token(msg: str) -> str | None:
    """⚡ ดึง target_device จากข้อความแบบ generic — ไม่ hardcode ชื่อรุ่น.

    จับ token รูป "letters+digits(+variant word)" — ครอบทุกรุ่นปัจจุบัน+อนาคต
    (iphone 18 / galaxy s27 / pixel 10 / apple watch 9 / redmi note 14 …)
    โดยไม่ต้องอัปเดต list เมื่อมี device ใหม่

    กรอง false positive 2 ชั้น:
    - head อยู่ใน _NON_DEVICE_TOKENS (pd3 / usb4 / qi2 / gen 2 / set 3 / note 14 ลอยๆ)
    - รูป letters+digits+letters glued ทั้งก้อน (CTC615W / AD653U) = product code ไม่ใช่ device
    """
    low = (msg or "").lower()
    for _m in _DEVICE_TOKEN_RE.finditer(low):
        cand = _m.group(0).strip()
        canon = normalize_device_alias(cand)
        if canon:
            return canon
        head_m = re.match(r"[a-z]+", cand)
        if (head_m and head_m.group(0) in _NON_DEVICE_TOKENS
                and cand not in _SPEC_INDEX):
            continue
        if re.fullmatch(r"[a-z]+\d+[a-z]+", cand):
            continue
        # compact code shape: glued + head ≥2 letters + เลข 3 หลัก
        # (ha835/cmc615) ที่ไม่ใช่ family/ไม่มี spec → product code ไม่ใช่ device
        if " " not in cand:
            _cc = re.fullmatch(r"([a-z]{2,})(\d{3})[a-z]?", cand)
            if (_cc and cand not in _SPEC_INDEX
                    and not _spec_brand(_cc.group(1))):
                continue
        return cand
    # regex หลักไม่เจอ → probe alias form (mi14pro glued / ไอโฟน14โปร)
    for _m in _DEVICE_ALIAS_PROBE_RE.finditer(low):
        canon = normalize_device_alias(_m.group(0))
        if canon:
            return canon
    return None


# ── compat mode classification (category-level — ไม่ใช่ model-level hardcode) ──
# ของที่ connector+watt สำคัญ (charging gear) → path เดิมทุกบรรทัด
_CHARGING_TYPES = {"charger", "powerbank", "car_charger",
                   "wireless_charger", "desktop_charger", "dock"}
# ของที่ compat = ขนาด/รุ่นเครื่อง (connector ไม่เกี่ยว)
_MODEL_FIT_TYPES = {"case", "screen_protector", "battery", "stylus", "memory_card"}
# 'phone' = target-device pseudo-type (มาจาก "โทรศัพท์/iphone 15" ในข้อความ)
# 'voucher' = ไม่ใช่ของจริง
_SKIP_TYPES = {"phone", "voucher"}
# form เจาะจงของ charger — "หัวชาร์จในรถ" detect {charger, car_charger}
# ('charger' เป็น substring artifact ของ "หัวชาร์จ"/"แท่นชาร์จ" ไม่ใช่ intent แยก)
_CHARGER_FORMS = {"car_charger", "wireless_charger", "desktop_charger", "dock"}


def _charging_scope(message: str, asked_type: str | None) -> set[str] | None:
    """⚡ scope ของ charging re-query = type ที่ลูกค้าถามจริง ∩ _CHARGING_TYPES.

    BUG-A: web extractor เดา product_type="charger" ทับทุกคำถามชาร์จ
    → "พาวเวอร์แบงค์ชาร์จ macbook" ดึงหัวชาร์จทั้งที่ถาม powerbank.
    scope จาก detect+intent (ไม่ใช่ extractor):
    - 'charger' ถูก drop เมื่อมี form เจาะจง (substring artifact)
      แต่เก็บเมื่อคู่กับ non-form ("ชุดชาร์จและพาวเวอร์แบงค์" → ทั้งคู่)
    - detect ว่าง → fallback {_asked_type} (anchor/intent)
    - ไม่มี type เลย → None (re-query เดิม ไม่ scope)
    """
    scope = product_store._detect_product_types(message or "") & _CHARGING_TYPES
    if "charger" in scope and (scope & _CHARGER_FORMS):
        scope.discard("charger")
    if not scope and asked_type in _CHARGING_TYPES:
        scope = {asked_type}
    return scope or None


def _compat_mode(product_type: str | None, message: str) -> tuple[str, str | None]:
    """⚡ จำแนก compat mode จาก product_type ของลูกค้า — ใช้ร่วมกันทั้ง
    `_device_spec_lookup` (re-query) และ `_filter_compat_products` (filter).

    candidates = detect(msg) ∪ {intent type ที่ valid} — แล้วเลือกตาม
    mode priority: charging > model_fit > self_compat
    (compat attr ที่ลูกค้าถามน่าจะเป็นเรื่องชาร์จก่อน > ขนาดรุ่น > อื่น)
    รวมทั้งสอง source เพราะ detect จับ literal ได้แม่น ("สายชาร์จ"→charger
    แม้ intent เดา earphone) และ intent จับ context ได้ ("ปากกา ipad"→stylus
    แม้ literal detect เป็น stationery)

    Returns:
        (mode, asked_type): mode ∈ {charging, model_fit, self_compat, skip, unknown}
        asked_type = type token ที่เลือก (None เมื่อ unknown/skip)
    """
    detected = product_store._detect_product_types(message or "") - _SKIP_TYPES
    candidates = set(detected)
    pt = (product_type or "").strip().lower()
    if pt and pt not in ("other", "null", "none") and pt not in _SKIP_TYPES:
        candidates.add(pt)
    if not candidates:
        return ("skip", None) if pt in _SKIP_TYPES else ("unknown", None)
    for ts in (_CHARGING_TYPES, _MODEL_FIT_TYPES):
        hit = candidates & ts
        if hit:
            # literal detect ชนะ intent ภายใน mode เดียวกัน — "ฟิล์มจอ" detect
            # screen_protector แต่ intent เดา case → re-query ต้องดึงฟิล์ม
            picked = sorted(hit & detected or hit)[0]
            return ("charging" if ts is _CHARGING_TYPES else "model_fit"), picked
    return "self_compat", sorted(candidates)[0]


def _extract_product_connectors(p: dict) -> set[str]:
    """⚡ สกัด DEVICE-SIDE connector types จากชื่อ+description ของสินค้า.

    สำหรับสายชาร์จ: ดึง connector ฝั่งอุปกรณ์ (ปลาย "to Y" ใน "X to Y")
      - "C to Lightning" → device-side = lightning (ไม่ใช่ usb-c)
      - "C to C" → device-side = usb-c
      - "A to Lightning" → device-side = lightning
      - "A to C" → device-side = usb-c
    สำหรับหัวชาร์จ/พาวเวอร์แบงค์: ดึงพอร์ต output (USB-C, USB-A)
    สำหรับชุดชาร์จ: ดึงจากสายที่อยู่ในเซต

    Returns:
        set ของ connector types ที่ DEVICE-SIDE: 'usb-c', 'lightning', 'micro-usb', 'usb-a'
        ถ้าดึงไม่ได้ → set() ว่าง (caller ถือว่า ambiguous → เก็บไว้ ไม่กรองออก)
    """
    name = (p.get("name") or p.get("item_name") or "").lower()
    desc = (p.get("description") or "").lower()
    text = f"{name} {desc}"
    connectors: set[str] = set()

    # ── Cable patterns: "X to Y" → Y คือ device-side connector ──
    # C to Lightning / USB-C to Lightning / Type-C to Lightning
    if re.search(r'(?:usb-c|type-c|type c|usb c|c)\s*to\s*lightning', text):
        connectors.add("lightning")
    # A to Lightning / USB-A to Lightning
    if re.search(r'(?:usb-a|usb a|a)\s*to\s*lightning', text):
        connectors.add("lightning")
    # C to C / USB-C to USB-C / Type-C to Type-C / C-to-C
    if re.search(r'(?:usb-c|type-c|type c|usb c|c)\s*to\s*(?:usb-c|type-c|type c|usb c|c)\b', text):
        connectors.add("usb-c")
    # A to C / USB-A to USB-C / USB-A to Type-C
    if re.search(r'(?:usb-a|usb a|a)\s*to\s*(?:usb-c|type-c|type c|usb c|c)\b', text):
        connectors.add("usb-c")
    # Micro USB to ... (มีไม่บ่อย)
    if re.search(r'to\s*micro', text):
        connectors.add("micro-usb")

    # ── ถ้าเจอ cable pattern แล้ว → ใช้ cable pattern เป็นหลัก (ไม่เช็ค adapter) ──
    # ── ถ้าไม่เจอ cable pattern → ลอง adapter/set pattern ──
    if not connectors:
        # Adapter: พอร์ต output (USB-C, USB-A)
        if any(kw in text for kw in (
            "usb-c", "type-c", "type c", "usb c", "usbc",
            "pd ", "power delivery", "gan",
        )):
            connectors.add("usb-c")
        if any(kw in text for kw in ("usb-a", "usb a ", "usba", "a to c", "a to lightning")):
            connectors.add("usb-a")

    # ── Lightning ลอยๆ (เช่น "Type C, Lightning" หรือ "lightning cable" ไม่มี "to") ──
    #    เช็คนอก if not connectors เพราะ set อาจมีทั้ง USB-C และ Lightning
    if any(kw in text for kw in ("lightning", "ไลนิ่ง", "ไลนิง")):
        connectors.add("lightning")

    # Micro USB
    if any(kw in text for kw in ("micro usb", "micro-usb", "microusb")):
        connectors.add("micro-usb")

    return connectors


# connector → query synonyms (vocab map — ชุดเดียวกับ _extract_product_connectors)
_CONN_QUERY_KW = {
    "usb-c": ["usb-c", "type-c"],
    "lightning": ["lightning"],
    "micro-usb": ["micro usb", "micro-usb"],
}


def _device_mentioned(device_name: str, products: list[dict]) -> bool:
    """catalog evidence — สินค้าระบุชื่อ target_device ตรงใน name/description
    → ร้านมีสินค้า declared-compat อยู่แล้ว (เช่น "สำหรับ iPhone 18")
    ใช้ boundary match เดียวกับ _lookup_spec_db — กันชื่อสั้น/ฝังตีเป็น hit
    """
    low = (device_name or "").strip().lower()
    if len(low) < 3 or not products:
        return False
    # ชื่อสินค้ามักเขียนติดกัน ("iPhone18") — เช็กทั้งมี/ไม่มีช่องว่าง
    variants = {low, low.replace(" ", "")}
    for p in products:
        text = " ".join(str(p.get(k) or "") for k in
                        ("name", "item_name", "description_excerpt",
                         "raw_description")).lower()
        if any(_term_boundary_match(v, text) for v in variants):
            return True
    return False


def _web_spec_to_dict(device_specs: list | None, device_name: str) -> dict | None:
    """⚡ normalize device_specs (structured list จาก web search) → spec dict
    รูปแบบเดียวกับ _lookup_spec_db — ใช้แทน regex parse ของ prose

    - entry match: normalized substring overlap ทั้งสองทาง
      ("macbook" ⊂ "macbook air" ✓, "macbook pro" ⊄ "macbook air" ✓)
      → device_name เจาะจงเลือกเฉพาะ entry ที่ตรง; generic match ทั้ง list
    - min_watt = max ของ max_watt ที่ match (spec ceiling — สินค้าที่ถึง
      ใช้ได้กับทุกรุ่นย่อย; เป็น ranking hint ไม่ใช่ hard filter)
    - connector = ตัวแรกที่เจอ (LLM ควรให้ตรงกันทุก entry)
    """
    if not device_specs or not device_name:
        return None
    low = device_name.lower().strip()
    if not low:
        return None
    _entries = [e for e in device_specs if isinstance(e, dict)]
    _matched = [e for e in _entries
                if str(e.get("device") or "").strip()
                and (low in str(e["device"]).lower()
                     or str(e["device"]).lower() in low)]
    pool = _matched or _entries
    watts = [float(e["max_watt"]) for e in pool
             if isinstance(e.get("max_watt"), (int, float)) and e["max_watt"] > 0]
    conns = [str(e["connector"]).lower() for e in pool if e.get("connector")]
    protos = sorted({str(p).lower() for e in pool for p in (e.get("protocols") or [])})
    if not watts and not conns:
        return None
    return {
        "device": device_name,
        "connector": conns[0] if conns else None,
        "min_watt": max(watts) if watts else None,
        "wired_w": max(watts) if watts else None,
        "protocols": protos,
        "source": "web-structured",
    }


def _resolve_device_spec(device_name: str, web_search_extra: str = "",
                         web_specs: list | None = None) -> dict | None:
    """⚡ resolve device charging spec — spec DB (curated) → web structured → prose regex.

    Args:
        device_name: ชื่ออุปกรณ์เป้าหมาย (เช่น "iPhone 17 Pro Max", "Mi 17 Ultra")
        web_search_extra: text จาก _device_spec_lookup (มี spec จาก Google Search)
        web_specs: device_specs list จาก search_and_extract (structured — ชนะ prose regex)

    Returns:
        {connector: str, min_watt: float, ...} หรือ None ถ้าดึงไม่ได้
    """
    if not device_name:
        return None
    low = device_name.lower().strip()
    # 1. spec DB (curated — หลัก; ข้อมูล structured ไม่ต้องเดาจาก text)
    _db_spec = _lookup_spec_db(low)
    if _db_spec:
        print(f"[DEVICE-SPEC] spec-db hit: {_db_spec['device']!r} → "
              f"connector={_db_spec['connector']} min_watt={_db_spec['min_watt']}", file=sys.stderr)
        return _db_spec
    # 2. structured device_specs จาก web search (LLM extraction — แยก device
    #    spec กับ accessory spec ได้ตามความหมาย ไม่ดูดเลขมั่วเหมือน regex)
    _ws_spec = _web_spec_to_dict(web_specs, device_name)
    if _ws_spec:
        print(f"[DEVICE-SPEC] web-structured: {_ws_spec['device']!r} → "
              f"connector={_ws_spec['connector']} min_watt={_ws_spec['min_watt']}", file=sys.stderr)
        return _ws_spec
    # 3. parse จาก web search text (last resort — เมื่อ LLM ไม่ส่ง device_specs)
    #    เชื่อเฉพาะ connector vocab (3 ค่า deterministic) — ไม่เอาเลข watt
    #    จาก prose: เลขลอยไม่มีป้ายกำกับว่าของใคร (เคยดูด "สาย 240W" มาเป็น
    #    spec ของเครื่อง) → watt ต้องมาจาก structured source เท่านั้น
    if web_search_extra:
        ws_lower = web_search_extra.lower()
        spec: dict = {}
        if any(kw in ws_lower for kw in ("usb-c", "type-c", "type c", "usb c", "usbc")):
            spec["connector"] = "usb-c"
        elif any(kw in ws_lower for kw in ("lightning", "ไลนิ่ง", "ไลนิง")):
            spec["connector"] = "lightning"
        elif any(kw in ws_lower for kw in ("micro usb", "micro-usb")):
            spec["connector"] = "micro-usb"
        if "connector" in spec:
            print(f"[DEVICE-SPEC] parsed from web search: {spec}", file=sys.stderr)
            return spec
    return None


def _filter_compat_products(
    products: list[dict],
    device_name: str,
    web_search_extra: str = "",
    intent_connector: str | None = None,
    intent_min_watt: float | None = None,
    compat_mode: str = "charging",
    asked_type: str | None = None,
    web_specs: list | None = None,
) -> list[dict]:
    """⚡ CODE-level compat filter — กรองสินค้าที่ compatible กับอุปกรณ์จริง.

    กรองตาม connector type เท่านั้น (ไม่กรองตาม wattage — เก็บทุก wattage
    เพื่อให้ LLM เห็นทั้ง baseline และ upgrade)

    หลังกรอง → sort by wattage ascending (baseline ก่อน, upgrade ทีหลัง)

    Device spec priority:
    1. DEVICE_SPECS db (curated — device_specs_data.py — หลัก)
    2. web search text parse (จาก _device_spec_lookup — fallback)
    3. intent_connector (จาก intent classifier LLM — last resort)

    Fallback strategy (safe — ไม่ over-filter):
    - ถ้าดึง device spec ไม่ได้ → คืนทั้งหมด
    - ถ้าสินค้าดึง connector ไม่ได้ → ambiguous → เก็บไว้
    - ถ้ากรองแล้วเหลือ < 2 ตัว → รวม ambiguous กลับ
    - ถ้ากรองแล้วว่าง → คืนทั้งหมด

    Args:
        products: list ของ product cards
        device_name: ชื่ออุปกรณ์เป้าหมาย (จาก intent_result.target_device)
        web_search_extra: text จาก _device_spec_lookup (fallback สำหรับ device spec)
        intent_connector: connector จาก intent classifier (usb-c / lightning / micro-usb)
        intent_min_watt: min watt จาก intent classifier (ใช้เป็นข้อมูลเท่านั้น ไม่ใช้กรอง)
        web_specs: device_specs list จาก search_and_extract (structured — ชนะ prose parse)

    Returns:
        list ของสินค้าที่ผ่าน compat filter, sort by wattage ascending
    """
    if not products or not device_name:
        return products

    # model_fit: compat = ขนาด/รุ่นเครื่อง ไม่ใช่ connector → ไม่กรอง connector
    # skip (phone/voucher): ถามตัวเครื่อง/ไม่ใช่ accessory → ไม่กรอง
    if compat_mode in ("skip", "model_fit"):
        return products

    # resolve device connector: spec DB/web parse ก่อน → intent (LLM guess) last
    device_connector = ""
    device_min_watt: float | None = None

    device_spec = _resolve_device_spec(device_name, web_search_extra,
                                       web_specs=web_specs)
    if device_spec:
        device_connector = device_spec.get("connector", "")
        device_min_watt = device_spec.get("min_watt")
        _src = (device_spec.get("source")
                or ("spec-db" if _lookup_spec_db(device_name) else "web-parse"))
        print(f"[COMPAT-FILTER] device={device_name!r} connector={device_connector!r} "
              f"min_watt={device_min_watt} (source={_src}) products={len(products)}", file=sys.stderr)
    elif intent_connector:
        device_connector = intent_connector
        device_min_watt = intent_min_watt
        print(f"[COMPAT-FILTER] device={device_name!r} connector={device_connector!r} "
              f"min_watt={device_min_watt} (source=intent) products={len(products)}", file=sys.stderr)
    else:
        return products

    if not device_connector:
        return products

    # self_compat (earphone/speaker/smartwatch/...): ของที่ถามไม่มี connector
    # อยู่แล้ว — กฎเดียว: drop เฉพาะของที่ประกาศ plug แล้วไม่ตรง device,
    # ambiguous (ไม่มี connector) เก็บเสมอ คงลำดับ ไม่มี watt sort
    # — เดิม ambiguous ถูกลบเงียบๆ เมื่อ compat≥2 (หูฟังหายเพราะชาร์จปน)
    if compat_mode == "self_compat":
        kept: list[dict] = []
        dropped_sc = 0
        for p in products:
            conns = _extract_product_connectors(p)
            if (not conns or device_connector in conns
                    or ("usb-a" in conns and device_connector == "usb-c")):
                kept.append(p)
            else:
                dropped_sc += 1
                _pn = (p.get("name") or p.get("item_name") or "")[:60]
                print(f"[COMPAT-FILTER] self_compat DROP {_pn!r} connectors={conns} "
                      f"(device={device_connector!r})", file=sys.stderr)
        if not kept:
            print(f"[COMPAT-FILTER] self_compat กรองแล้วว่าง → คืนทั้งหมด {len(products)} ตัว", file=sys.stderr)
            return products
        print(f"[COMPAT-FILTER] self_compat type={asked_type} ผ่าน {len(kept)}/{len(products)} "
              f"(dropped={dropped_sc})", file=sys.stderr)
        return kept

    compat: list[dict] = []
    ambiguous: list[dict] = []
    dropped = 0

    for p in products:
        connectors = _extract_product_connectors(p)
        if not connectors:
            # ดึง connector ไม่ได้ → ambiguous → เก็บไว้ (ไม่ over-filter)
            ambiguous.append(p)
        elif device_connector in connectors:
            # connector ตรง → compatible
            compat.append(p)
        elif "usb-a" in connectors and device_connector == "usb-c":
            # USB-A adapter อาจใช้กับ USB-C device ได้ (ผ่าน A-to-C cable) → ambiguous
            ambiguous.append(p)
        else:
            # connector ไม่ตรง → กรองออก
            dropped += 1
            _pname = (p.get("name") or p.get("item_name") or "")[:60]
            print(f"[COMPAT-FILTER] DROP {_pname!r} connectors={connectors} "
                  f"(device={device_connector!r})", file=sys.stderr)

    # ถ้ากรองเหลือน้อย → รวม ambiguous กลับ (กัน over-filter)
    if len(compat) < 2 and ambiguous:
        print(f"[COMPAT-FILTER] กรองเหลือ {len(compat)} → รวม {len(ambiguous)} ambiguous กลับ", file=sys.stderr)
        compat.extend(ambiguous)
        ambiguous = []

    # ถ้ากรองแล้วว่าง → คืนทั้งหมด (fallback ปลอดภัย)
    if not compat:
        print(f"[COMPAT-FILTER] กรองแล้วว่าง → คืนทั้งหมด {len(products)} ตัว", file=sys.stderr)
        return products

    # sort by wattage ascending — ของที่จ่ายไฟพอ spec เครื่อง (≥min_watt) ขึ้นก่อน
    # (baseline ก่อน, upgrade ทีหลัง; ของต่ำกว่า spec ไปท้าย)
    compat.sort(key=lambda p: _wattage_asc_key(p, device_min_watt))

    print(f"[COMPAT-FILTER] ผ่าน {len(compat)} จาก {len(products)} ตัว "
          f"(dropped={dropped}, ambiguous={len(ambiguous)}) "
          f"top3 wattage: {[_extract_max_wattage(p) for p in compat[:3]]}W", file=sys.stderr)

    return compat


def _apply_product_tiers(
    products: list[dict],
    tier_a_ids: set[str],
    limit: int,
) -> list[dict]:
    """⚡ Phase 3 — รวม products ด้วย tier logic ก่อนส่งเข้า LLM.

    Tier A (exact match): สินค้าที่ match จาก MODEL-REGEX หรือเป็น anchor_card/hybrid_anchor_card
        → ใส่เข้า context เสมอ ไม่ถูกตัดด้วย limit ไม่ว่า status จะเป็นอะไร
    Tier B (แนะนำทั่วไป): สินค้าจาก vector/keyword search ทั่วไป
        → เรียง normal+stock>0 ขึ้นก่อน แล้วตัด limit

    รวม tier A+B แล้วเรียก _dedupe_products(...)
    ห้ามมี item_id ซ้ำจาก tier A และ tier B

    Args:
        products: list ของ product cards ที่จะส่งให้ LLM
        tier_a_ids: set ของ item_id ที่เป็น Tier A (exact match / anchor)
        limit: จำนวนสูงสุดของ Tier B (ใช้ค่าเดิมจาก req.limit)

    Returns:
        list ของ product cards ที่ผ่าน tier merge + dedup แล้ว
    """
    if not products:
        return products

    # แยก Tier A และ Tier B
    _tier_a: list[dict] = []
    _tier_b: list[dict] = []
    for p in products:
        _iid = str(p.get("item_id") or "")
        if _iid and _iid in tier_a_ids:
            _tier_a.append(p)
        else:
            _tier_b.append(p)

    # เรียง Tier B: normal+stock>0 ขึ้นก่อน แล้วตัด limit
    _tier_b.sort(
        key=lambda p: (
            p.get("status") == "NORMAL",
            not p.get("sold_out", False),
            p.get("total_stock", 0) or 0,
        ),
        reverse=True,
    )
    _tier_b_limited = _tier_b[:limit]

    # รวม Tier A + Tier B (Tier A ก่อน = สินค้าที่ลูกค้าถามถึงเป็นหลัก)
    _merged = _tier_a + _tier_b_limited

    # Dedup (อาจมีซ้ำจาก tier A และ tier B ถ้า item_id ตรง — แต่ set ช่วยกันแล้ว
    # อย่างไรก็ตามอาจมี base_name ซ้ำจาก listing อื่น → ให้ _dedupe_products จัดการ)
    _merged = product_store._dedupe_products(_merged, log_label="TIER-MERGE")

    if len(_merged) != len(products):
        print(
            f"[TIER-MERGE] products: {len(products)} → {len(_merged)} "
            f"(tier_a={len(_tier_a)}, tier_b={len(_tier_b)}→{len(_tier_b_limited)}, limit={limit})",
            file=sys.stderr,
        )
    else:
        print(
            f"[TIER-MERGE] products: {len(products)} (tier_a={len(_tier_a)}, tier_b={len(_tier_b)}, limit={limit})",
            file=sys.stderr,
        )
    return _merged


def _device_spec_lookup(
    db,
    req,
    intent_result: dict,
    history: list[dict] | None,
    existing_products: list[dict],
    retrieval_message: str,
    anchor_card: dict | None,
    hybrid_anchor_card: dict | None,
    llm_ctx_limit: int,
    resolve_subtype_fn=None,
    retrieval_profile: RetrievalProfile | None = None,
) -> tuple[str, list[dict], list[dict]]:
    """⚡ Extract device-spec-lookup logic เป็น helper — ใช้ได้ทั้ง KB path และ main path.

    ทำ 2 อย่าง:
    1. Web search ดึง spec ของ target_device (พอร์ตชาร์จ, ความเร็ว, โปรโตคอล) → คืน extra_context string
    2. Re-query DB ด้วย keywords จาก web search → คืน list ของสินค้าที่ compat (sort by wattage asc)

    Args:
        db: MongoDB database handle
        req: ChatRequest (มี message, shop, platform)
        intent_result: ผลจาก intent classifier (มี target_device)
        history: chat history (ส่งให้ web search)
        existing_products: สินค้าที่มีอยู่แล้ว (เพื่อ dedup)
        retrieval_message: คำค้นหลัก (ใช้ใน _resolve_charger_subtype)
        anchor_card: anchor product card (สำหรับ subtype resolution)
        hybrid_anchor_card: hybrid anchor card
        llm_ctx_limit: LLM context limit (max products)

    Returns:
        (device_spec_extra, additional_products, device_specs):
        - device_spec_extra: string ที่จะใส่ใน extra_context ของ LLM
        - additional_products: list ของสินค้าที่ re-query ได้ (dedup กับ existing_products แล้ว)
        - device_specs: structured spec list จาก web search (ส่งต่อให้ compat filter)
    """
    _device_spec_extra = ""
    _additional_products: list[dict] = []
    _device_ws_specs: list[dict] = []

    # resolve target_device จากหลายแหล่ง: intent_result → generic device-token regex
    # (ไม่ hardcode ชื่อรุ่น — ครอบทุก device ปัจจุบัน+อนาคต)
    _resolved_target_device = intent_result.get("target_device") or ""
    if not _resolved_target_device:
        _resolved_target_device = _extract_device_token(req.message) or ""

    if not _resolved_target_device:
        return "", [], []

    _compat_device_name = _resolved_target_device
    _compat_md, _asked_type = _compat_mode(
        intent_result.get("product_type"), req.message)
    print(f"[DEVICE-SPEC-LOOKUP] target={_compat_device_name!r} "
          f"mode={_compat_md} type={_asked_type}", file=sys.stderr)

    # skip (phone/voucher): ถามตัวเครื่อง/ไม่ใช่ accessory → ไม่ spec-search ไม่ re-query
    if _compat_md == "skip":
        return "", [], []

    # non-charging (model_fit/self_compat): re-query ตาม type ของลูกค้า
    # — ทำได้โดยไม่ต้อง web search (เดิม gate ด้วย web success ทำให้หลุดทั้งหมด)
    # — ไม่ inject charger prompt/wattage threshold (เดิมบังคับ "≥27W" ทุก compat query)
    if _compat_md in ("model_fit", "self_compat"):
        # canonical Thai kw (PRODUCT_TYPES[0]) — token อังกฤษ detect ผิดเพี้ยน
        # ("earphone" → ear+phone) และไม่ match ชื่อสินค้าไทย
        _rq_word = product_store._type_query_word(_asked_type)
        _rq = (f"{_rq_word} {_compat_device_name}" if _compat_md == "model_fit"
               else _rq_word)  # self_compat: ห้ามใส่ device — BT ใช้ได้ทุกเครื่อง
        _device_spec_extra = (
            f"\n⚠️ สินค้าที่แนะนำต้องใช้ร่วมกับ {_compat_device_name} ได้จริง"
            if _compat_md == "self_compat" else
            f"\n⚠️ สินค้าที่แนะนำต้องรองรับรุ่น {_compat_device_name} โดยเฉพาะ "
            f"(เช็กขนาด/รุ่นที่สินค้าระบุ)"
        ) + " — ไม่ต้องพิจารณา wattage/พอร์ตชาร์จ"
        print(f"[DEVICE-SPEC-LOOKUP] {_compat_md} re-query: {_rq!r}", file=sys.stderr)
        try:
            # hard-scope ด้วย type จริง — model_fit query มี device name ปน
            # ("case iphone 15" → detect phone → ดึงโทรศัพท์ทับเคส)
            _pto = ({_asked_type}
                    if _asked_type and product_store._product_type_regex({_asked_type})
                    else None)
            _rq_products = product_store.fetch_products(
                db,
                message=_rq,
                shop_filter=req.shop,
                limit=llm_ctx_limit,
                desc_message=req.message,
                filter_unavailable=False,
                product_types_override=_pto,
                is_compat_check=True,  # re-query ของ compat — ข้าม unit index เหมือน main path
                retrieval_profile=retrieval_profile,
            )
            _existing_pids = {str(p.get("item_id") or "") for p in existing_products}
            for _dp in _rq_products or []:
                _dpid = str(_dp.get("item_id") or "")
                if _dpid and _dpid not in _existing_pids:
                    _additional_products.append(_dp)
                    _existing_pids.add(_dpid)
            if _additional_products:
                print(f"[DEVICE-SPEC-LOOKUP] {_compat_md} merge "
                      f"{len(_additional_products)} สินค้า (dedup กับ "
                      f"{len(existing_products)} existing)", file=sys.stderr)
        except Exception as _e:
            print(f"[DEVICE-SPEC-LOOKUP] {_compat_md} re-query error: {_e}", file=sys.stderr)
        # catalog grounding: ของที่ถามไม่อยู่ใน context → บอกหมวดที่ร้านมีจริง
        # (กัน LLM เดาหมวดเอง เช่น 'smartphone' ที่ร้านไม่มี)
        _have_types: set[str] = set()
        for _p in (existing_products or []) + _additional_products:
            _have_types |= product_store._detect_product_types(
                _p.get("name") or _p.get("item_name") or "")
        _cap = product_store.shop_capability_line(
            db, req.shop, _asked_type, have_types=_have_types)
        if _cap:
            _device_spec_extra += _cap
        return _device_spec_extra, _additional_products, _device_ws_specs

    # charging/unknown — spec ladder: แหล่งฟรีก่อน → web search ด่านสุดท้าย
    #   1. spec-db (curated, deterministic)
    #   2. catalog evidence — สินค้าใน scope ระบุชื่อ device ตรง (declared compat)
    #   3. web search — จ่าย เฉพาะเมื่อ 1-2 ไม่มีหลักฐาน (rare path)
    #   4. intent fields — LLM guess (ไม่นับเป็น evidence สำหรับตัด web)
    from . import web_search as _ws

    _db_spec = _lookup_spec_db(_compat_device_name)
    _dev_min_watt = (_db_spec or {}).get("min_watt")
    _dev_conn = (_db_spec or {}).get("connector") or ""
    _chg_scope = _charging_scope(req.message, _asked_type)

    # ── re-query #1 — keywords derive เอง (type + device + connector synonyms)
    #    ไม่พึ่ง web keywords อีกต่อไป — pool เติมได้แม้ไม่ยิง search
    _rq_kws = [product_store._type_query_word(_asked_type or "charger"),
               _compat_device_name]
    _rq_kws += _CONN_QUERY_KW.get(_dev_conn, [])
    # subtype prefix — resolve จาก message/anchor (ไม่พึ่ง web)
    _resolved_sub_for_device = None
    if resolve_subtype_fn:
        _resolved_sub_for_device = resolve_subtype_fn(
            intent_result=intent_result,
            retrieval_message=retrieval_message,
            anchor_card=hybrid_anchor_card or anchor_card,
            msg=req.message,
        )
    _device_sub_kw = {"adapter": "หัวชาร์จ", "cable": "สายชาร์จ",
                      "set": "ชุดชาร์จ", "car_charger": "หัวชาร์จในรถ",
                      "wireless": "แท่นชาร์จไร้สาย"}.get(_resolved_sub_for_device or "", "")
    if _device_sub_kw:
        _rq_kws.insert(0, _device_sub_kw)
        print(f"[DEVICE-SPEC-LOOKUP] subtype={_resolved_sub_for_device} → prefix({_device_sub_kw!r})", file=sys.stderr)
    _device_search_q = " ".join(k for k in _rq_kws if k)
    print(f"[DEVICE-SPEC-LOOKUP] re-query DB: {_device_search_q!r} scope={_chg_scope}", file=sys.stderr)
    _existing_pids = {str(p.get("item_id") or "") for p in existing_products}
    try:
        _rq1 = product_store.fetch_products(
            db,
            message=_device_search_q,
            shop_filter=req.shop,
            limit=llm_ctx_limit,
            desc_message=req.message,
            filter_unavailable=False,
            product_types_override=_chg_scope,
            # ⚡ compat re-query ต้องข้าม unit index (pool เล็ก →
            #   ของ spec สูงไม่เข้า context) + sweep กว้างเหมือน main path
            is_compat_check=True,
            retrieval_profile=retrieval_profile,
        )
        for _dp in _rq1 or []:
            _dpid = str(_dp.get("item_id") or "")
            if _dpid and _dpid not in _existing_pids:
                _additional_products.append(_dp)
                _existing_pids.add(_dpid)
        if _additional_products:
            print(f"[DEVICE-SPEC-LOOKUP] merge {len(_additional_products)} สินค้าจาก re-query (dedup กับ {len(existing_products)} existing)", file=sys.stderr)
    except Exception as _e:
        print(f"[DEVICE-SPEC-LOOKUP] re-query error: {_e}", file=sys.stderr)

    # ── catalog evidence — สินค้าใน scope ระบุชื่อ device ตรง → declared compat
    #    (เช็กเฉพาะเมื่อ spec-db miss — db hit แข็งกว่าอยู่แล้ว)
    _catalog_hit = (not _db_spec) and _device_mentioned(
        _compat_device_name, list(existing_products or []) + _additional_products)

    # ── web search — ด่านสุดท้าย เฉพาะเมื่อ spec-db + catalog ไม่มีหลักฐาน ──
    _device_info_clean = ""
    if not (_db_spec or _catalog_hit) and _ws.is_configured():
        _device_search_query = f"{_compat_device_name} charging spec port watt protocol"
        print(f"[DEVICE-SPEC-LOOKUP] ไม่มีหลักฐาน local → web search: {_compat_device_name!r}", file=sys.stderr)
        try:
            _device_ws_result = _ws.search_and_extract(
                message=_device_search_query,
                shop=req.shop,
                platform=req.platform,
                history=history,
                reason="compat_device_spec_lookup",
            )
            if not _device_ws_result.get("error") and _device_ws_result.get("search_used"):
                _device_search_info = _device_ws_result.get("search_info", "")
                _device_keywords = _device_ws_result.get("keywords", [])
                _device_product_type = _device_ws_result.get("product_type", "")
                _device_ws_specs = _device_ws_result.get("device_specs") or []
                if _device_ws_specs:
                    print(f"[DEVICE-SPEC-LOOKUP] device_specs={_device_ws_specs}", file=sys.stderr)
                if _device_search_info:
                    # strip URLs ออกจาก search_info (กัน LLM เอาลิงก์ไปใส่คำตอบ)
                    _device_info_clean = re.sub(
                        r'\[([^\]]+)\]\([^)]+\)', r'', _device_search_info
                    )
                    _device_info_clean = re.sub(
                        r'https?://[^\s\)\]]+', r'', _device_info_clean,
                        flags=re.IGNORECASE
                    ).strip()
                    if len(_device_info_clean) < 20:
                        _device_info_clean = ""
                    else:
                        print(f"[DEVICE-SPEC-LOOKUP] ได้ spec ของ {_compat_device_name}: {_device_info_clean[:120]!r}", file=sys.stderr)
                # min_watt จาก web-structured (ชนะ intent — ข้อมูลจริง > ความจำ)
                if not _dev_min_watt:
                    _wsd = _web_spec_to_dict(_device_ws_specs, _compat_device_name)
                    _dev_min_watt = (_wsd or {}).get("min_watt")
                # re-query #2 ด้วย web keywords → merge เพิ่ม (ของที่ derive หาไม่เจอ)
                if _device_keywords:
                    _wq = " ".join(_device_keywords[:6])
                    if _device_product_type:
                        _wq = f"{_device_product_type} {_wq}"
                    if _device_sub_kw:
                        _wq = f"{_device_sub_kw} {_wq}"
                    try:
                        _rq2 = product_store.fetch_products(
                            db, message=_wq, shop_filter=req.shop,
                            limit=llm_ctx_limit, desc_message=req.message,
                            filter_unavailable=False,
                            product_types_override=_chg_scope,
                            is_compat_check=True,
                            retrieval_profile=retrieval_profile)
                        _n2 = 0
                        for _dp in _rq2 or []:
                            _dpid = str(_dp.get("item_id") or "")
                            if _dpid and _dpid not in _existing_pids:
                                _additional_products.append(_dp)
                                _existing_pids.add(_dpid)
                                _n2 += 1
                        if _n2:
                            print(f"[DEVICE-SPEC-LOOKUP] merge +{_n2} สินค้าจาก web-keyword re-query", file=sys.stderr)
                    except Exception as _e:
                        print(f"[DEVICE-SPEC-LOOKUP] web re-query error: {_e}", file=sys.stderr)
        except Exception as _e:
            print(f"[DEVICE-SPEC-LOOKUP] web error: {_e}", file=sys.stderr)

    # intent = ตัวสำรองสุดท้ายของ min_watt
    if not _dev_min_watt:
        _dev_min_watt = intent_result.get("device_min_watt")

    # ── สร้าง extra จากหลักฐานที่มี ──
    if _device_info_clean:
        _device_spec_extra = (
            f"\n=== ข้อมูลสเปกอุปกรณ์ {_compat_device_name} (จาก Google Search) ===\n"
            f"{_device_info_clean}\n"
            f"ใช้ข้อมูลนี้เพื่อเลือกสินค้าที่รองรับอุปกรณ์รุ่นนี้จริง "
            f"(เช่น พอร์ตชาร์จ, ความเร็วชาร์จสูงสุด, โปรโตคอล) "
            f"และแนะนำสินค้าที่จ่ายไฟได้พอ/เท่ากับที่อุปกรณ์รองรับ\n"
        )
    if _db_spec:
        # เติมสเปค structured จาก catalog ลง spec extra (protocols/wireless — ไม่ต้องเดาจาก web text)
        _proto_txt = ", ".join(_db_spec.get("protocols") or []) or "-"
        _wl_txt = f", ชาร์จไร้สาย {_db_spec['wireless_w']}W" if _db_spec.get("wireless_w") else ""
        _device_spec_extra += (
            f"\n📋 สเปคจาก catalog (ข้อมูล structured — อ้างอิงหลัก): "
            f"{_db_spec['device']} → connector={_db_spec.get('connector')}, "
            f"ชาร์จมีสายสูงสุด {_db_spec.get('wired_w')}W{_wl_txt}, "
            f"protocols: {_proto_txt}"
        )
    elif _catalog_hit:
        _device_spec_extra += (
            f"\n📋 หลักฐานจาก catalog: มีสินค้าในหมวดนี้ที่ระบุว่าใช้กับ "
            f"{_compat_device_name} ได้ — อ้างอิงสินค้าที่ระบุชื่ออุปกรณ์ตรงเป็นหลัก"
        )
    if _device_spec_extra or _additional_products:
        _device_spec_extra += (
            f"\n⚠️ สินค้าที่แนะนำต้องรองรับ spec ของอุปกรณ์เป้าหมายจริง "
            f"(พอร์ต/wattage/protocol) ไม่ใช่แค่มีชื่อแบรนด์เดียวกับอุปกรณ์เป้าหมาย "
            f"ถ้า description ของสินค้าไม่ได้ระบุ wattage/protocol ที่ตรงตามที่อุปกรณ์เป้าหมายต้องการ "
            f"ให้บอกลูกค้าตรงๆ ว่าอาจชาร์จได้ไม่เต็มสปีด ไม่ใช่ระบุว่า compat เฉยๆ"
        )
    if _dev_min_watt and _device_spec_extra:
        _device_spec_extra += (
            f"\n⚠️ อุปกรณ์รุ่นนี้รองรับชาร์จเร็วสูงสุดประมาณ {int(_dev_min_watt)}W "
            f"→ สินค้าที่แนะนำเป็นตัวหลัก (baseline/upgrade) ต้องรองรับอย่างน้อย {int(_dev_min_watt)}W "
            f"ถ้าเสนอสินค้าที่ watt ต่ำกว่านี้ ต้องบอกลูกค้าชัดเจนว่าชาร์จได้ไม่เต็มสปีด"
        )
    if _device_spec_extra:
        _device_spec_extra += (
            f"\n⚡ dual-tier recommendation: ⚠️ กฎเหล็ก: ถ้าร้านมีสินค้าที่ connector type ตรงกับอุปกรณ์เป้าหมาย "
            f"2 ตัวขึ้นไป → ต้องแนะนำอย่างน้อย 2 ตัว ห้ามแนะนำแค่ 1 ตัวเด็ดขาด: "
            f"(1) baseline — ตัวที่ compat ตรงสเปคขั้นต่ำที่อุปกรณ์ต้องการ "
            f"(2) upgrade — ตัวที่ compat และมีสเปคสูงกว่า (wattage/current สูงกว่า) เป็นตัวเลือกอัปเกรด "
            f"ถ้ามีแค่ตัวเดียวที่ compat จริงๆ ให้เสนอแค่ตัวนั้น ห้ามแต่งว่ามีตัวสเปคสูงกว่าถ้าไม่มีจริงใน context\n"
            f"ห้ามข้าม connector type เด็ดขาด — สินค้าที่ connector ไม่ตรงกับอุปกรณ์เป้าหมาย "
            f"ห้ามเสนอแม้จะสเปคสูงแค่ไหน ไม่ว่าจะ frame เป็น baseline หรือ upgrade ก็ตาม"
        )

    # sort pool ที่ merge มาครั้งเดียวด้วย min_watt สุดท้าย (adequate-first)
    if _additional_products:
        _additional_products.sort(key=lambda p: _wattage_asc_key(p, _dev_min_watt))
        print(f"[DEVICE-SPEC-LOOKUP] sort pool (min_watt={_dev_min_watt}) "
              f"top3: {[_extract_max_wattage(p) for p in _additional_products[:3]]}W", file=sys.stderr)

    return _device_spec_extra, _additional_products, _device_ws_specs
