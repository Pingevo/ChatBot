"""guards.py — output guard + unit card flags (Task 9).

build_flags(card) — รวม flag fields ของ unit card เป็น dict เดียว (ไว้ใส่ context/decision)
check_output(answer, *, handoff_sent) — จับคำตอบที่ยืนยันเคลม/คืนเงิน/จัดส่ง
    โดยไม่มี handoff → return list ของ violation labels (ว่าง = ผ่าน)
"""
from __future__ import annotations

import re

_FLAG_KEYS = ("sellable", "has_warranty_info", "has_description", "oos_in_name")

# คำยืนยันเชิงผลลัพธ์ที่ bot ไม่ควรพูดเอง — ต้องมาจาก handoff/แอดมินเท่านั้น
# (เจาะจงคำยืนยัน "ให้แล้ว/จะคืน/ส่งแล้ว" — ไม่ใช่ข้อมูลเงื่อนไขทั่วไปอย่าง "รับประกัน 2 ปี")
_VIOLATION_RES = (
    ("claim_confirmed", re.compile(
        r"(ยืนยัน|อนุมัติ|รับเรื่อง|ดำเนินการ)\s*(การ)?(เคลม|claim)")),
    ("refund_confirmed", re.compile(
        r"(คืนเงิน|refund).{0,25}(ให้แล้ว|เรียบร้อย|ภายใน|เข้าบัญชี|จะได้รับ)"
        r"|(รอรับ|รับคืน)เงิน")),
    ("shipping_confirmed", re.compile(
        r"(จัดส่ง|ส่งของ|ส่งสินค้า|แพ็ค).{0,20}(แล้ว|เรียบร้อย|วันนี้|พรุ่งนี้)"
        r"|เลข\s*(พัสดุ|tracking)\s*[:：]")),
)


def build_flags(card: dict) -> dict:
    """ดึง flag fields จาก unit/product card → dict เดียว (ใช้ตัดสินใจ context/guard)."""
    return {k: bool(card.get(k)) for k in _FLAG_KEYS}


def check_output(answer: str, *, handoff_sent: bool = False) -> list[str]:
    """คืน list ของ violation ที่เจอใน answer — ว่าง = ผ่าน.

    handoff_sent=True → ข้ามเช็คทั้งหมด (แอดมินรับเรื่องแล้ว bot สื่อสารต่อได้)
    """
    if handoff_sent or not answer:
        return []
    return [name for name, rx in _VIOLATION_RES if rx.search(answer)]


# ---- Output policy rules (enforce ที่ /chat boundary — ครอบทุก engine) --------
# rules-as-data: (name, pattern, replacement)
#   - answer match pattern + resp.handoff_to_admin=False → ส่ง handoff จริง
#     + set flag + แทนข้อความ (replacement=None → คงข้อความเดิม)
#   - ถ้า handoff_to_admin=True อยู่แล้ว → claim เป็นจริง → ไม่แตะ
# ⚡ ย้ายมาจาก llm._strip_kb_markup (_false_admin_patterns) — เดิมแก้แค่ข้อความ
#   ไม่ได้ escalate จริง (ลูกค้าได้ยินว่า "แอดมินรับเรื่องแล้ว" แต่ไม่มีใครรับจริง)
_ESCALATE_RULES = (
    ("admin_came", re.compile(
        r"(?:แอดมินมาดูแลแล้ว|แอดมินเข้ามาดูแลแล้ว|แอดมินมาแล้ว"
        r"|แอดมินได้รับเรื่องแล้ว|ทางเราได้ส่งเรื่องให้แอดมินแล้ว)(?:ค่ะ|คะ)?"
    ), "เดี๋ยวส่งต่อให้แอดมินดูแลให้นะคะ"),
    ("claim_done", re.compile(
        r"(?:(?:ทางร้าน)?รับเรื่องประสานงานตรวจสอบและดูแลเรื่องการส่งเคลมสินค้าให้เรียบร้อยแล้ว"
        r"|เคลมสินค้าให้เรียบร้อยแล้ว)(?:ค่ะ|คะ)?"
    ), "เดี๋ยวส่งต่อให้แอดมินดูแลเรื่องนี้ให้นะคะ"),
)


# ---- T7 rewrite tier — อ้างนโยบาย/โปรโมชั่นที่ไม่มี grounding ใน context ────────
#   grounding = product cards ใน resp (description_excerpt/raw_description/promo flags)
#   — คือ context ที่ส่งให้ LLM จริง ไม่ต้องเดา
#   ข้าม source ที่ context เป็น policy/order data อยู่แล้ว (general:/order_/warranty ฯลฯ)
#   claim pattern กัน negation ด้วย lookbehind ("ไม่มีของแถม" ไม่ใช่ claim)
_REWRITE_SKIP_PREFIXES = (
    "general:", "order_", "warranty", "return_refund", "order_problem",
    "human_request", "item_tag_warranty",
)

# (name, claim_regex, pos_ground_regex, grounding_card_flags, mode, replacement)
#   pos_ground_regex — pattern เชิงบวกที่ต้องเจอใน context (cards/grounding_text)
#     พร้อม negation check (ห้ามมี ไม่/ห้าม/ไม่สามารถ นำหน้า) — bare kw ไม่พอ
#     เพราะ "ไม่รับคืน" มี "คืน" แต่เป็นความหมายตรงข้าม (NEW-3 residual)
#   mode "stock" — grounded เมื่อมี card ที่ขายได้จริง (_available_for_sale)
#     ไม่ใช่เช็คข้อความ (BUG-K: claim "พร้อมส่ง" ทั้งที่ทุก card หมด/เลิกขาย)
_REWRITE_RULES = (
    ("promo_claim", re.compile(
        r"(?<!ไม่)(?<!ไม่ได้)"
        r"(?:มีของแถม|ได้ของแถม|แถมให้|แถมฟรี|ของแถมฟรี|โปรโมชั่น|โปรฯ"
        r"|ลดเหลือ|ลดราคา|ราคาพิเศษ|ส่วนลดพิเศษ|ส่งฟรี|ฟรีค่าส่ง|ฟรีจัดส่ง"
        r"|มีโปร(?=\s|$|[,.!?])"
        r"|แถม(?!ยัง|ไว้|ด้วย|มั้ย|ไหม|นะ|ค่ะ|คะ|ครับ|จ้า))"  # "แถมสายฟรี" แต่ไม่ใช่ "แถมยังไม่ได้ส่ง"
    ),
     re.compile(r"(?:แถม|โปร|promotion|gift|free|ลด|ส่วนลด|ฟรี)", re.I),
     ("has_promotion", "is_flash_sale"),
     "text",
     "เรื่องของแถม/โปรโมชั่น เดี๋ยวขอให้แอดมินตรวจสอบให้นะคะ"),
    ("return_claim", re.compile(
        r"(?<!ไม่สามารถ)(?<!ไม่)(?<!ไม่ได้)"
        r"(?:เปลี่ยน(?:สินค้า|ใหม่)?ได้|คืน(?:สินค้า|ของ|เงิน)ได้|รับเปลี่ยน|รับคืน)"
    ),
     re.compile(r"(?:เปลี่ยน|คืน|แลกเปลี่ยน|return|refund)", re.I),
     (),
     "text",
     "เรื่องการเปลี่ยน/คืนสินค้า เดี๋ยวขอให้แอดมินตรวจสอบเงื่อนไขให้นะคะ"),
    ("stock_claim", re.compile(
        r"(?<!ไม่)(?<!ไม่ได้)(?<!หมด)"
        r"(?:พร้อมส่ง|พร้อมจัดส่ง|มีสต็อก|มีสต๊อก|เช็คสต็อก|เช็คสต๊อก"
        r"|เช็คของให้|สต็อกยังมี|สต๊อกยังมี|ยังมีของอยู่|มีของพร้อม|เหลืออยู่"
        r"|in.?stock)"
        , re.I),
     re.compile(r"(?:พร้อมส่ง|มีสต็อก|มีสต๊อก|in.?stock)", re.I),
     (),
     "stock",
     "เรื่องสต็อก/ความพร้อมของสินค้า เดี๋ยวขอให้แอดมินตรวจสอบให้นะคะ"),
)

# model token — UPPERCASE≥2 + digits≥2 (PB200N/CTC615W/WPB100P) ที่ไม่อยู่ใน
#   context เลย = LLM แต่งรุ่น (NEW-6 residual / NEW-3 identity claim)
#   iPhone15/MacBook ไม่โดน (mixed case); "K3"/"G5" digit เดียวไม่โดน
#   boundary ใช้ ASCII lookaround แทน \b — \w ไทยทำ \b ไม่ match "รุ่นPB200N"
_MODEL_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z]{2,}[0-9]{2,}[A-Z]*(?![A-Za-z0-9])")
#   tech spec tokens ที่ไม่ใช่รุ่นสินค้า — IP66/PD65W/USB30/WiFi6/BT53/LED20
#   (ต้องครอบทั้ง token ด้วย $ — prefix เดียวไม่พอ "WPB100P" ขึ้นต้น W แต่เป็นรุ่น)
_MODEL_TOKEN_STOP = re.compile(
    r"^(?:IP|PD|QC|USB|WIFI|BT|BLE|HDMI|RGB|LED|AUX|NFC|TWS|ANC|ENC"
    r"|LCD|OLED|GPS|SIM|ESIM|TYPEC|GEN|VER|TH|EN|ISO|CE|FCC|ROHS|CCC|GB|TLS)"
    r"\d*[A-Z]?$")

_NEGATION_RE = re.compile(r"(?:ไม่|ห้าม|มิได้|ไม่สามารถ|ไม่ได้|หมด)")


def _pos_grounded(text: str, pos_rx) -> bool:
    """pos_rx match ใน text ที่ไม่มี negation นำหน้าในระยะใกล้ (20 chars —
    ครอบ "ไม่รับเปลี่ยน/คืน" ที่ negation ห่างจาก kw ที่สอง)."""
    for _m in pos_rx.finditer(text):
        _pre = text[max(0, _m.start() - 20):_m.start()]
        if not _NEGATION_RE.search(_pre):
            return True
    return False


def _card_available(p: dict) -> bool:
    """card ขายได้จริง — ใช้ _available_for_sale ถ้ามี, fallback status+sold_out."""
    if "_available_for_sale" in p:
        return bool(p.get("_available_for_sale"))
    return p.get("status") == "NORMAL" and not p.get("sold_out")


def _grounding_text(resp) -> str:
    """KB context ที่ path general:* แนบมาใน routing_decision (app.py ใส่ให้)."""
    _rd = getattr(resp, "routing_decision", None)
    if isinstance(_rd, dict):
        return str(_rd.get("grounding_text") or "")
    return ""


def _claim_grounded(resp, pos_rx, flags, mode: str = "text") -> bool:
    """claim มี grounding ใน context ที่ส่งให้ LLM จริงไหม.

    - mode "stock": grounded เมื่อมี card ขายได้จริง หรือ grounding_text ยืนยัน stock
    - mode "text":  grounded เมื่อ card flag/desc หรือ grounding_text มี
      pos_rx แบบไม่ถูก negate
    """
    if mode == "stock":
        for _p in getattr(resp, "products", None) or []:
            if _card_available(_p):
                return True
        _gt = _grounding_text(resp)
        return bool(_gt) and _pos_grounded(_gt, pos_rx)
    for _p in getattr(resp, "products", None) or []:
        if flags and any(_p.get(f) for f in flags):
            return True
        _text = ((_p.get("description_excerpt") or "")
                 + (_p.get("raw_description") or ""))
        if _pos_grounded(_text, pos_rx):
            return True
    _gt = _grounding_text(resp)
    return bool(_gt) and _pos_grounded(_gt, pos_rx)


def _context_pool(resp, req) -> str:
    """pool ข้อความที่ LLM เห็นจริง — cards + grounding_text + message + history.

    ใช้เช็ค model_claim: token รุ่นใน answer ต้องมาจาก pool นี้เท่านั้น
    """
    _parts = [_grounding_text(resp)]
    for _p in getattr(resp, "products", None) or []:
        _parts.append(str(_p.get("name") or ""))
        _parts.append(str(_p.get("description_excerpt") or ""))
        _parts.append(str(_p.get("raw_description") or ""))
    _parts.append(getattr(req, "message", "") or "")
    for _h in getattr(req, "history", None) or []:
        if isinstance(_h, dict):
            _parts.append(str(_h.get("text") or ""))
            _parts.append(str(_h.get("image_desc") or ""))
        else:
            _parts.append(str(getattr(_h, "text", "") or ""))
            _parts.append(str(getattr(_h, "image_desc", "") or ""))
    return " ".join(_parts).lower()


# boundary ของ clause: บรรทัดใหม่ / segment sep / จบประโยค EN / particle ไทย+space
_CLAUSE_BOUNDARY = re.compile(
    r"\n|\|\|\||(?<=[.!?])\s|(?:ค่ะ|คะ|ครับ|ครับผม|จ้า|จ๊ะ|นะคะ|นะค่ะ|นะครับ)\s+")


def _replace_clause(text: str, start: int, end: int, repl: str) -> str:
    """แทนที่ clause ทั้งก้อนที่ครอบ span [start,end) ด้วย repl —
    กันเหลือเศษข้อความของ claim เดิมค้างกลางประโยค."""
    cs = 0
    for _m in _CLAUSE_BOUNDARY.finditer(text):
        if _m.end() <= start:
            cs = _m.end()
        elif _m.start() >= end:
            break
    ce = len(text)
    for _m in _CLAUSE_BOUNDARY.finditer(text):
        if _m.start() >= end:
            ce = _m.start()
            break
    return (text[:cs] + repl + text[ce:]).strip()


def enforce(resp, req):
    """Output policy boundary จุดเดียวก่อนคำตอบออกจาก /chat.

    ถูกเรียกจาก chat() wrapper — ครอบ legacy/chat_v2/chatbotv3 ทุก return path
    - answer == llm.LLM_ERROR_REPLY → escalate (ลูกค้าควรได้คน ไม่ใช่ error text)
    - answer match _ESCALATE_RULES + ยังไม่ handoff → ส่ง handoff จริง + แทนข้อความ
    fail-open: enforce พัง → คืน resp เดิม (อย่าให้ guard ทำแชทล่ม)
    """
    import sys as _sys
    try:
        answer = getattr(resp, "answer", "") or ""
        if not answer or getattr(resp, "handoff_to_admin", False):
            return resp
        from . import llm as _llm
        if answer == _llm.LLM_ERROR_REPLY:
            _escalate(resp, req, reason="llm_error", rule_name="llm_error")
            return resp
        for _name, _rx, _repl in _ESCALATE_RULES:
            if _rx.search(answer):
                _escalate(resp, req, reason="guard_" + _name, rule_name=_name,
                          new_answer=_rx.sub(_repl, answer) if _repl else None)
                break
        else:
            # ⚡ T7 rewrite tier — ยังไม่ escalate + ยังไม่ handoff
            #   claim นโยบาย/โปร/สต็อกที่ไม่มี grounding ใน context → เขียนใหม่
            _src = getattr(resp, "source", "") or ""
            _rewritten = False
            # ⚡ general:* ก่อนหน้า skip ทั้งหมด → LLM ขัด KB ตัวเองผ่าน (Youpin "เปลี่ยนได้"
            #   ทั้งที่ KB บอกไม่รับ) — ตอนนี้เช็คได้ถ้า path แนบ grounding_text มา
            _is_general = _src.startswith("general:")
            _skip = any(_src.startswith(p) for p in _REWRITE_SKIP_PREFIXES)
            if _is_general and _grounding_text(resp):
                _skip = False  # มี KB context → verify ได้
            if not _skip:
                for _name, _rx, _pos_rx, _gflags, _mode, _repl in _REWRITE_RULES:
                    # re-scan จนสะอาด (≤4 รอบ) — answer อาจมี claim เดียวกันหลาย clause
                    #   เช่น "เช็คสต็อกแล้วนะคะ พร้อมส่งค่ะ" ต้องแทนทั้งคู่
                    for _ in range(4):
                        _m = _rx.search(resp.answer)
                        if not _m or _claim_grounded(resp, _pos_rx, _gflags, _mode):
                            break
                        # แทนทั้ง clause ที่ครอบ claim — กันเศษข้อความ claim เดิมค้าง
                        _new = _replace_clause(resp.answer, _m.start(), _m.end(), _repl)
                        # กัน particle ซ้ำติดกัน ("นะคะค่ะ" / "ค่ะคะ")
                        _new = re.sub(r"(?:นะคะ|ค่ะ|คะ)\s*(?:นะคะ|ค่ะ|คะ)", "นะคะ", _new)
                        if _new == resp.answer:
                            break
                        resp.answer = _new
                        resp.answer_segments = _llm.split_segments(_new)
                        _rd = getattr(resp, "routing_decision", None)
                        if isinstance(_rd, dict):
                            _rd["guard_rewritten"] = _name
                        print(f"[GUARD-ENFORCE] rewrite {_name}: ungrounded {_m.group(0)!r}", file=_sys.stderr)
                        _rewritten = True
                # ⚡ model_claim — รุ่น UPPERCASE+digits ที่ไม่มีใน context เลย
                #   = LLM แต่งชื่อรุ่น (WPB100P/PB200N ผิดจาก CTC615W)
                #   pool = cards + grounding_text + message + history (token ที่
                #   ลูกค้าถามเอง/history เคยพูดถึง = grounded ไม่แตะ)
                if not _rewritten:
                    _bad_tok = None
                    _pool = None
                    for _tok in _MODEL_TOKEN_RE.findall(answer):
                        if _MODEL_TOKEN_STOP.match(_tok):
                            continue
                        if _pool is None:
                            _pool = _context_pool(resp, req)
                        if _tok.lower() not in _pool:
                            _bad_tok = _tok
                            break
                    if _bad_tok:
                        _tm = re.search(re.escape(_bad_tok), answer)
                        _new = _replace_clause(
                            answer, _tm.start(), _tm.end(),
                            "เรื่องรุ่น/สเปคที่กล่าวถึง เดี๋ยวขอให้แอดมินตรวจสอบให้นะคะ")
                        _new = re.sub(r"(?:นะคะ|ค่ะ|คะ)\s*(?:นะคะ|ค่ะ|คะ)", "นะคะ", _new)
                        resp.answer = _new
                        resp.answer_segments = _llm.split_segments(_new)
                        _rd = getattr(resp, "routing_decision", None)
                        if isinstance(_rd, dict):
                            _rd["guard_rewritten"] = "model_claim"
                        print(f"[GUARD-ENFORCE] rewrite model_claim: unknown token {_bad_tok!r}", file=_sys.stderr)
    except Exception as _e:
        print(f"[GUARD-ENFORCE] error: {_e}", file=_sys.stderr)
    return resp


def _escalate(resp, req, *, reason: str, rule_name: str,
              new_answer: str | None = None) -> None:
    """ทำให้ claim 'ส่งต่อแอดมิน' เป็นจริง — ส่ง handoff + set flag + แทนข้อความ."""
    import sys as _sys
    from . import responses as _resp_mod
    _resp_mod._send_handoff(
        req, None, reason=reason,
        claim={"topic": f"guard:{rule_name}"}, log_tag="GUARD-ENFORCE",
    )
    resp.handoff_to_admin = True
    resp.handoff_reason = reason
    if new_answer is not None:
        from . import llm as _llm
        resp.answer = new_answer
        resp.answer_segments = _llm.split_segments(new_answer)
    _rd = getattr(resp, "routing_decision", None)
    if isinstance(_rd, dict):
        _rd["guard_escalated"] = rule_name
    print(f"[GUARD-ENFORCE] {rule_name}: escalated → handoff sent", file=_sys.stderr)
