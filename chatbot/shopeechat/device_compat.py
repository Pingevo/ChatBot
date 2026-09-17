"""Device compatibility helpers — ย้ายออกจาก app.py (refactor).

ครอบคลุม:
- _extract_max_wattage / _extract_product_connectors — สกัด spec จาก product card
- _KNOWN_DEVICE_SPECS / _resolve_device_spec — spec ของอุปกรณ์ปลายทาง
- _filter_compat_products — กรองสินค้าตาม connector compatibility
- _apply_product_tiers — รวม tier A (exact/anchor) + tier B (general) ก่อนส่ง LLM
- _device_spec_lookup — web-search spec + re-query DB หาสินค้าที่ compat

ใช้โดย legacy chat() ใน app.py (import เป็น module: device_compat._xxx)
"""

from __future__ import annotations

import re
import sys

from . import product_store


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


# ⚡ Known device charging specs — ใช้สำหรับ _filter_compat_products (CODE-level compat filter)
#    ถ้า device ไม่อยู่ในตาราง → fallback ใช้ web search text จาก _device_spec_lookup
#    connector: พอร์ตชาร์จของอุปกรณ์ (usb-c / lightning / micro-usb)
#    min_watt: ค่า W ขั้นต่ำที่อุปกรณ์รองรับชาร์จเต็มสปีด (ใช้เป็นข้อมูลเท่านั้น ไม่ใช้กรอง)
_KNOWN_DEVICE_SPECS: dict[str, dict] = {
    "iphone 17 pro max": {"connector": "usb-c", "min_watt": 27},
    "iphone 17 pro":     {"connector": "usb-c", "min_watt": 27},
    "iphone 17":         {"connector": "usb-c", "min_watt": 27},
    "iphone 16 pro max": {"connector": "usb-c", "min_watt": 27},
    "iphone 16 pro":     {"connector": "usb-c", "min_watt": 27},
    "iphone 16":         {"connector": "usb-c", "min_watt": 27},
    "iphone 15 pro max": {"connector": "usb-c", "min_watt": 27},
    "iphone 15 pro":     {"connector": "usb-c", "min_watt": 27},
    "iphone 15":         {"connector": "usb-c", "min_watt": 27},
    "iphone 14":         {"connector": "lightning", "min_watt": 20},
    "iphone 13":         {"connector": "lightning", "min_watt": 20},
    "iphone 12":         {"connector": "lightning", "min_watt": 20},
    "s25 ultra":         {"connector": "usb-c", "min_watt": 45},
    "s24 ultra":         {"connector": "usb-c", "min_watt": 45},
    "s23 ultra":         {"connector": "usb-c", "min_watt": 45},
    "mi 17 ultra":       {"connector": "usb-c", "min_watt": 90},
    "mi 17":             {"connector": "usb-c", "min_watt": 90},
    "macbook air m4":    {"connector": "usb-c", "min_watt": 70},
    "macbook air m3":    {"connector": "usb-c", "min_watt": 70},
    "macbook air m2":    {"connector": "usb-c", "min_watt": 70},
    "macbook pro 14":    {"connector": "usb-c", "min_watt": 96},
    "macbook pro 16":    {"connector": "usb-c", "min_watt": 140},
    "ipad pro":          {"connector": "usb-c", "min_watt": 30},
    "ipad air":          {"connector": "usb-c", "min_watt": 30},
}


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


def _resolve_device_spec(device_name: str, web_search_extra: str = "") -> dict | None:
    """⚡ resolve device charging spec จาก web search ก่อน, hardcoded เป็น fallback.

    Args:
        device_name: ชื่ออุปกรณ์เป้าหมาย (เช่น "iPhone 17 Pro Max", "Mi 17 Ultra")
        web_search_extra: text จาก _device_spec_lookup (มี spec จาก Google Search)

    Returns:
        {connector: str, min_watt: float} หรือ None ถ้าดึงไม่ได้
    """
    if not device_name:
        return None
    low = device_name.lower().strip()
    # 1. parse จาก web search text ก่อน (หลัก — _device_spec_lookup หามาให้แล้ว)
    if web_search_extra:
        ws_lower = web_search_extra.lower()
        spec: dict = {}
        if any(kw in ws_lower for kw in ("usb-c", "type-c", "type c", "usb c", "usbc")):
            spec["connector"] = "usb-c"
        elif any(kw in ws_lower for kw in ("lightning", "ไลนิ่ง", "ไลนิง")):
            spec["connector"] = "lightning"
        elif any(kw in ws_lower for kw in ("micro usb", "micro-usb")):
            spec["connector"] = "micro-usb"
        watt_matches = re.findall(r"(\d+)\s*w(?:att)?\b", ws_lower)
        if watt_matches:
            spec["min_watt"] = max(float(w) for w in watt_matches)
        if "connector" in spec:
            print(f"[DEVICE-SPEC] parsed from web search: {spec}", file=sys.stderr)
            return spec
    # 2. fallback: known specs (longest key first — กัน "iphone 17" match ทับ "iphone 17 pro max")
    for key in sorted(_KNOWN_DEVICE_SPECS.keys(), key=len, reverse=True):
        if key in low:
            print(f"[DEVICE-SPEC] fallback to known spec: {key!r} → {_KNOWN_DEVICE_SPECS[key]}", file=sys.stderr)
            return _KNOWN_DEVICE_SPECS[key]
    return None


def _filter_compat_products(
    products: list[dict],
    device_name: str,
    web_search_extra: str = "",
    intent_connector: str | None = None,
    intent_min_watt: float | None = None,
) -> list[dict]:
    """⚡ CODE-level compat filter — กรองสินค้าที่ compatible กับอุปกรณ์จริง.

    กรองตาม connector type เท่านั้น (ไม่กรองตาม wattage — เก็บทุก wattage
    เพื่อให้ LLM เห็นทั้ง baseline และ upgrade)

    หลังกรอง → sort by wattage ascending (baseline ก่อน, upgrade ทีหลัง)

    Device spec priority:
    1. intent_connector (จาก intent classifier LLM — หลัก)
    2. web search text (จาก _device_spec_lookup — fallback)
    3. _KNOWN_DEVICE_SPECS (hardcoded — last resort)

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

    Returns:
        list ของสินค้าที่ผ่าน compat filter, sort by wattage ascending
    """
    if not products or not device_name:
        return products

    # resolve device connector: intent ก่อน → web search → hardcoded
    device_connector = ""
    device_min_watt: float | None = None

    if intent_connector:
        device_connector = intent_connector
        device_min_watt = intent_min_watt
        print(f"[COMPAT-FILTER] device={device_name!r} connector={device_connector!r} "
              f"min_watt={device_min_watt} (source=intent) products={len(products)}", file=sys.stderr)
    else:
        device_spec = _resolve_device_spec(device_name, web_search_extra)
        if not device_spec:
            return products
        device_connector = device_spec.get("connector", "")
        device_min_watt = device_spec.get("min_watt")
        print(f"[COMPAT-FILTER] device={device_name!r} connector={device_connector!r} "
              f"min_watt={device_min_watt} (source=fallback) products={len(products)}", file=sys.stderr)

    if not device_connector:
        return products

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

    # sort by wattage ascending (baseline ก่อน, upgrade ทีหลัง)
    compat.sort(key=lambda p: _extract_max_wattage(p))

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
) -> tuple[str, list[dict]]:
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
        (device_spec_extra, additional_products):
        - device_spec_extra: string ที่จะใส่ใน extra_context ของ LLM
        - additional_products: list ของสินค้าที่ re-query ได้ (dedup กับ existing_products แล้ว)
    """
    _device_spec_extra = ""
    _additional_products: list[dict] = []

    # resolve target_device จากหลายแหล่ง: intent_result → message regex
    _resolved_target_device = intent_result.get("target_device") or ""
    if not _resolved_target_device:
        _msg_low_dev = (req.message or "").lower()
        _device_patterns_fallback = [
            r'(mi\s*17\s*ultra|xiaomi\s*17\s*ultra)',
            r'(mi\s*17\b)',
            r'(iphone\s*17\s*pro\s*max)',
            r'(iphone\s*17\b)',
            r'(s25\s*ultra|samsung\s*25\s*ultra)',
            r'(s24\s*ultra|samsung\s*24\s*ultra)',
            r'(iphone\s*16\b)',
            r'(iphone\s*15\b)',
            r'(oneplus\s*1[0-9])',
            r'(macbook\s*air\s*m[0-9])',
            r'(mac\s*air\s*m[0-9])',
            r'(pixel\s*[0-9])',
        ]
        for _pat_dev in _device_patterns_fallback:
            _m_dev = re.search(_pat_dev, _msg_low_dev)
            if _m_dev:
                _resolved_target_device = _m_dev.group(1).strip()
                break

    if not _resolved_target_device:
        return "", []

    from . import web_search as _ws
    if not _ws.is_configured():
        return "", []

    _compat_device_name = _resolved_target_device
    _device_search_query = f"{_compat_device_name} charging spec port watt protocol"
    print(f"[DEVICE-SPEC-LOOKUP] target_device={_compat_device_name!r} → web search", file=sys.stderr)
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
            if _device_search_info:
                # strip URLs ออกจาก search_info (กัน LLM เอาลิงก์ไปใส่คำตอบ)
                _device_info_clean = re.sub(
                    r'\[([^\]]+)\]\([^)]+\)', r'', _device_search_info
                )
                _device_info_clean = re.sub(
                    r'https?://[^\s\)\]]+', r'', _device_info_clean,
                    flags=re.IGNORECASE
                ).strip()
                if len(_device_info_clean) >= 20:
                    _device_spec_extra = (
                        f"\n=== ข้อมูลสเปกอุปกรณ์ {_compat_device_name} (จาก Google Search) ===\n"
                        f"{_device_info_clean}\n"
                        f"ใช้ข้อมูลนี้เพื่อเลือกสินค้าที่รองรับอุปกรณ์รุ่นนี้จริง "
                        f"(เช่น พอร์ตชาร์จ, ความเร็วชาร์จสูงสุด, โปรโตคอล) "
                        f"และแนะนำสินค้าที่จ่ายไฟได้พอ/เท่ากับที่อุปกรณ์รองรับ\n"
                        f"⚠️ สินค้าที่แนะนำต้องรองรับ spec ของอุปกรณ์เป้าหมายจริง "
                        f"(พอร์ต/wattage/protocol) ไม่ใช่แค่มีชื่อแบรนด์เดียวกับอุปกรณ์เป้าหมาย "
                        f"ถ้า description ของสินค้าไม่ได้ระบุ wattage/protocol ที่ตรงตามที่อุปกรณ์เป้าหมายต้องการ "
                        f"ให้บอกลูกค้าตรงๆ ว่าอาจชาร์จได้ไม่เต็มสปีด ไม่ใช่ระบุว่า compat เฉยๆ\n"
                        f"⚡ Phase 3b — dual-tier recommendation: ⚠️ กฎเหล็ก: ถ้าร้านมีสินค้าที่ connector type ตรงกับอุปกรณ์เป้าหมาย "
                        f"2 ตัวขึ้นไป → ต้องแนะนำอย่างน้อย 2 ตัว ห้ามแนะนำแค่ 1 ตัวเด็ดขาด: "
                        f"(1) baseline — ตัวที่ compat ตรงสเปคขั้นต่ำที่อุปกรณ์ต้องการ "
                        f"(2) upgrade — ตัวที่ compat และมีสเปคสูงกว่า (wattage/current สูงกว่า) เป็นตัวเลือกอัปเกรด "
                        f"ถ้ามีแค่ตัวเดียวที่ compat จริงๆ ให้เสนอแค่ตัวนั้น ห้ามแต่งว่ามีตัวสเปคสูงกว่าถ้าไม่มีจริงใน context\n"
                        f"ห้ามข้าม connector type เด็ดขาด — สินค้าที่ connector ไม่ตรงกับอุปกรณ์เป้าหมาย "
                        f"ห้ามเสนอแม้จะสเปคสูงแค่ไหน ไม่ว่าจะ frame เป็น baseline หรือ upgrade ก็ตาม"
                    )
                    print(f"[DEVICE-SPEC-LOOKUP] ได้ spec ของ {_compat_device_name}: {_device_info_clean[:120]!r}", file=sys.stderr)
            # re-query DB ด้วย keywords จาก search หาสินค้าที่ compatible
            if _device_keywords:
                _device_search_q = " ".join(_device_keywords[:6])
                if _device_product_type:
                    _device_search_q = f"{_device_product_type} {_device_search_q}"
                # ⚡ Phase 4 — ใช้ _resolve_charger_subtype() เพื่อคง subtype
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
                    _device_search_q = f"{_device_sub_kw} {_device_search_q}"
                    print(f"[DEVICE-SPEC-LOOKUP] subtype={_resolved_sub_for_device} → prefix({_device_sub_kw!r})", file=sys.stderr)
                print(f"[DEVICE-SPEC-LOOKUP] re-query DB: {_device_search_q!r}", file=sys.stderr)
                try:
                    _device_products = product_store.fetch_products(
                        db,
                        message=_device_search_q,
                        shop_filter=req.shop,
                        limit=llm_ctx_limit,
                        desc_message=req.message,
                        filter_unavailable=False,
                    )
                    if _device_products:
                        # ⚡ Phase 3b — sort by wattage ascending (baseline first, upgrade next)
                        _device_products.sort(key=lambda p: _extract_max_wattage(p))
                        print(f"[DEVICE-SPEC-LOOKUP] sort by wattage (asc)  top3: {[_extract_max_wattage(p) for p in _device_products[:3]]}", file=sys.stderr)
                        # dedup กับ existing_products
                        _existing_pids = {str(p.get("item_id") or "") for p in existing_products}
                        for _dp in _device_products:
                            _dpid = str(_dp.get("item_id") or "")
                            if _dpid and _dpid not in _existing_pids:
                                _additional_products.append(_dp)
                                _existing_pids.add(_dpid)
                        if _additional_products:
                            print(f"[DEVICE-SPEC-LOOKUP] merge {len(_additional_products)} สินค้าจาก re-query (dedup กับ {len(existing_products)} existing)", file=sys.stderr)
                except Exception as _e:
                    print(f"[DEVICE-SPEC-LOOKUP] re-query error: {_e}", file=sys.stderr)
    except Exception as _e:
        print(f"[DEVICE-SPEC-LOOKUP] error: {_e}", file=sys.stderr)

    return _device_spec_extra, _additional_products
