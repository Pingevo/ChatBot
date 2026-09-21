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

# (name, claim_regex, grounding_kws, grounding_card_flags, replacement)
_REWRITE_RULES = (
    ("promo_claim", re.compile(
        r"(?<!ไม่)(?<!ไม่ได้)"
        r"(?:มีของแถม|ได้ของแถม|แถมให้|แถมฟรี|ของแถมฟรี|โปรโมชั่น|โปรฯ"
        r"|ลดเหลือ|ลดราคา|ราคาพิเศษ|ส่วนลดพิเศษ|ส่งฟรี|ฟรีค่าส่ง|ฟรีจัดส่ง"
        r"|มีโปร(?=\s|$|[,.!?]))"
    ),
     ("แถม", "free", "gift", "ของแถม", "โปร", "promotion", "ลด", "ส่วนลด", "ฟรี"),
     ("has_promotion", "is_flash_sale"),
     "เรื่องของแถม/โปรโมชั่น เดี๋ยวขอให้แอดมินตรวจสอบให้นะคะ"),
    ("return_claim", re.compile(
        r"(?<!ไม่สามารถ)(?<!ไม่)(?<!ไม่ได้)"
        r"(?:เปลี่ยน(?:สินค้า|ใหม่)?ได้|คืน(?:สินค้า|ของ|เงิน)ได้|รับเปลี่ยน|รับคืน)"
    ),
     ("เปลี่ยน", "คืน", "return", "refund", "แลกเปลี่ยน"),
     (),
     "เรื่องการเปลี่ยน/คืนสินค้า เดี๋ยวขอให้แอดมินตรวจสอบเงื่อนไขให้นะคะ"),
)


def _claim_grounded(resp, kws, flags) -> bool:
    """claim มี grounding ใน product context ที่ส่งให้ LLM จริงไหม."""
    for _p in getattr(resp, "products", None) or []:
        if flags and any(_p.get(f) for f in flags):
            return True
        _text = ((_p.get("description_excerpt") or "")
                 + (_p.get("raw_description") or "")).lower()
        if any(k in _text for k in kws):
            return True
    return False


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
            #   claim นโยบาย/โปรที่ไม่มี grounding ใน product context → เขียนใหม่
            _src = getattr(resp, "source", "") or ""
            if not any(_src.startswith(p) for p in _REWRITE_SKIP_PREFIXES):
                for _name, _rx, _gkws, _gflags, _repl in _REWRITE_RULES:
                    _m = _rx.search(answer)
                    if _m and not _claim_grounded(resp, _gkws, _gflags):
                        # แทนทั้ง clause ที่ครอบ claim — กันเศษข้อความ claim เดิมค้าง
                        _new = _replace_clause(answer, _m.start(), _m.end(), _repl)
                        # กัน particle ซ้ำติดกัน ("นะคะค่ะ" / "ค่ะคะ")
                        _new = re.sub(r"(?:นะคะ|ค่ะ|คะ)\s*(?:นะคะ|ค่ะ|คะ)", "นะคะ", _new)
                        resp.answer = _new
                        resp.answer_segments = _llm.split_segments(_new)
                        _rd = getattr(resp, "routing_decision", None)
                        if isinstance(_rd, dict):
                            _rd["guard_rewritten"] = _name
                        print(f"[GUARD-ENFORCE] rewrite {_name}: ungrounded {_m.group(0)!r}", file=_sys.stderr)
                        break
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
