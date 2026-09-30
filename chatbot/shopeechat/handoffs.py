"""handoffs — early handoff/detection blocks ของ legacy chat().

ย้าย verbatim จาก app.py chat():
- detect_human_request — BUG-3 fix: ลูกค้าขอคุยกับคน/แอดมิน → handoff ทันที (pre-intent)
- post_intent_handoffs — tax invoice + มอก. (TISI) handler (post-intent)

คืน dict kwargs สำหรับ ChatResponse ถ้าจับ flow ได้, None ถ้าไม่ใช่ → pipeline ต่อ.
"""
from __future__ import annotations

import re
import sys
import time as _time

# --- short toxic token matcher (5F-A, hardened 5F-H1) ---
# สระ/วรรณยุกต์/เครื่องหมายที่ต้องแปะพยัญชนะ — ถ้าอยู่ "หลัง" token แปลว่า
# พยัญชนะตัวท้ายขึ้นพยางค์ใหม่ ("นาฬิกากัน"=นาฬิกา+กัน ไม่มี "กาก")
# ถ้าอยู่ "ก่อน" token แปลว่าคำก่อนจบสระ — token อาจเป็นหางคำประสม ("หน้ากาก")
_TOXIC_DEPENDENT = frozenset("ะัาำิีึืฺุูๅ็่้๊๋์ํ")
# intensifier ที่ตามหลัง token = บ่นจริง (ใช้เฉพาะ fallback เมื่อไม่มี tokenizer)
#   ห้ามใส่คำทั่วไป (อะไร/แล้ว/ละ/อีก) — "หน้ากากอะไร" เป็นคำถามสินค้าไม่ใช่คำด่า
_TOXIC_INTENSIFIERS = (
    "มาก", "จัง", "สุด", "จริง", "แท้", "เลย", "ว่ะ", "เว้ย", "วะ",
    "เว่อ", "เวอร์", "โว้ย", "เกิน", "เหลือเกิน", "ชิบ", "โคตร",
)
# subject นำหน้า token = complaint phrase ชัด ("ของกาก"/"สินค้ากาก"/"ร้านกาก")
_TOXIC_SUBJECTS = (
    "ของ", "สินค้า", "ร้าน", "บริการ", "งาน", "พัสดุ", "แอดมิน",
    "คุณภาพ", "เจ้าหน้าที่", "ไอเทม", "ไอเท็ม", "ตัวนี้", "ชิ้นนี้",
)

_WORD_TOKENIZER = None


def _get_word_tokenizer():
    """lazy-load pythainlp word_tokenize (pattern เดียวกับ warranty._get_ner) —
    คืน callable หรือ None ถ้าไม่มี lib."""
    global _WORD_TOKENIZER
    if _WORD_TOKENIZER is None:
        try:
            from pythainlp import word_tokenize
            _WORD_TOKENIZER = word_tokenize
        except Exception:
            _WORD_TOKENIZER = False
    return _WORD_TOKENIZER if _WORD_TOKENIZER is not False else None


def _is_thai_word_char(ch: str) -> bool:
    return "ก" <= ch <= "ๅ"  # U+0E01–U+0E45 consonant/vowel/sign (ไม่รวม ๆ)


def _starts_with_any(text: str, prefixes: tuple) -> bool:
    return any(text.startswith(p) for p in prefixes)


def _endswith_any(text: str, suffixes: tuple) -> bool:
    return any(text.endswith(s) for s in suffixes)


def _toxic_token_present(msg_low: str, token: str) -> bool:
    """True เมื่อ short toxic token เป็นคำแยกจริง — ไม่ใช่ substring กลาง/ท้าย
    คำประสม ("หน้ากาก"=product, "นาฬิกากัน"=นาฬิกา+กัน). ใช้ tokenizer เป็นหลัก;
    fallback = strict boundary + subject/intensifier complaint markers."""
    _wt = _get_word_tokenizer()
    if _wt is not None:
        try:
            return token in _wt(msg_low)
        except Exception:
            pass  # tokenizer fail → strict fallback ด้านล่าง
    pos = 0
    while True:
        i = msg_low.find(token, pos)
        if i < 0:
            return False
        prev = msg_low[i - 1] if i else ""
        rest = msg_low[i + len(token):]
        nxt = rest[:1]
        if nxt in _TOXIC_DEPENDENT:
            pos = i + 1  # พยัญชนะท้ายขึ้นพยางค์ใหม่ → ไม่ใช่คำ standalone
            continue
        if _endswith_any(msg_low[:i], _TOXIC_SUBJECTS):
            return True  # "ของกาก"/"ร้านกาก" = complaint มี subject ชัด
        if prev and (_is_thai_word_char(prev) or prev in _TOXIC_DEPENDENT):
            pos = i + 1  # ติดคำก่อนหน้า → compound tail ("หน้ากาก")
            continue
        if not nxt or not _is_thai_word_char(nxt):
            return True  # standalone boundary ("กาก", "กาก!")
        if _starts_with_any(rest, _TOXIC_INTENSIFIERS):
            return True  # "กากมาก"/"กากจัง" = บ่นจริง
        pos = i + 1


# --- message-category context (5F routing hardening) ---
# mild anger ("ช้ามาก"/"นานมาก"/"ไม่มีการตอบ") วัดความช้า/ไม่ตอบ — ต้องแยกว่า
# บ่น "บริการร้าน" (ตอบแชท/จัดส่ง) vs "อาการสินค้า" (ชาร์จช้า/ปุ่มไม่ตอบสนอง)
# ใช้ semantic group + span masking — ไม่ใช่ exception รายคำ/รายสินค้า
_SERVICE_CONTEXT_TERMS = (
    "รอ", "ตอบ", "ส่ง", "จัดส่ง", "ทัก", "แชท", "แอดมิน", "แอด",
    "ร้าน", "พัสดุ", "ขนส่ง", "คิว", "เจ้าหน้าที่", "พนักงาน",
    "บริการ", "ออเดอร์", "order", "เพจ", "inbox", "แจ้ง", "เช็ค",
    "ติดตาม", "ยกเลิก", "คืนเงิน",
)
_PRODUCT_CONTEXT_TERMS = (
    "ชาร์จ", "เชื่อม", "ปุ่ม", "กด", "หมุน", "เสียบ", "ตอบสนอง",
    "เปิด", "ปิด", "จอ", "แอป", "แอพ", "app", "ภาพ", "เสียง",
    "พัดลม", "กล้อง", "แบต", "เครื่อง", "ทำงาน", "ใช้งาน", "เคลม",
    "ดึง", "จับคู่", "ซิงค์", "sync", "pair", "ค้าง", "ดับ",
    "พัง", "เสีย", "โหลด", "บูต", "รีเซ็ต", "นิ่ง", "รวน", "เพี้ยน",
)
# กริยาเวลา/ประวัติ — "ซื้อมานานมากแล้ว" = ระยะเวลาผ่าน ไม่ใช่รอคิวร้าน
_HISTORY_CONTEXT_TERMS = ("เคย", "ซื้อ", "ลืม", "นานมา", "มานาน", "ตั้งแต่")
# auto-greeting/สคริปต์ร้านที่รั่วเป็น inbound — "อาจจะตอบช้าหน่อย" คือคำขอโทษร้าน
_SHOP_SCRIPT_TERMS = (
    "ยินดีต้อนรับ", "ต้อนรับ", "สอบถามได้", "สอบถามเข้ามา",
    "ตอบช้าหน่อย", "อาจจะตอบช้า", "ขออภัยที่ตอบช้า", "ขอโทษที่ตอบช้า",
)
# affiliate/spam — "เฮ้ย" เป็นการจับตา ไม่ใช่ลูกค้าโกรธ
_PROMO_TERMS = (
    "คอมมิชชั่น", "ค่าคอม", "commission", "affiliate",
    "ตัวแทนจำหน่าย", "สมัครตัวแทน", "รับเปอร์เซ็นต์", "เปอร์เซ็นต์",
)

# question markers — ตรวจหลังตัด vocative tail (ครับ/ค่ะ/แอด/นะ) ท้ายประโยค
_QUESTION_RE = re.compile(
    r"(ไหม|มั้ย|หรอ|เหรอ|รึเปล่า|หรือเปล่า|ป่าว|บ้าง|แค่ไหน|เท่าไหร่|เท่าไหน"
    r"|กี่วัน|กี่ชั่วโมง|เมื่อไหร่|เมื่อไหน|ตอนไหน|รึ)[คะค่ะครับ\s\?]*$")
_VOCATIVE_TAIL_RE = re.compile(
    r"(?:ครับ|ค่ะ|คะ|จ้า|จ๊ะ|นะ|น๊า|งับ|งั้บ|ฮะ|หะ|เอย|คร้าบ|คับ|ค่า"
    r"|แอดมิน|แอด|admin)+[\s\?\.!~]*$")


def _term_spans(text: str, terms: tuple) -> list[tuple[int, int]]:
    """ทุก occurrence (start,end) ของ terms ใน text — สำหรับ span masking."""
    out = []
    for t in terms:
        pos = 0
        while True:
            i = text.find(t, pos)
            if i < 0:
                break
            out.append((i, i + len(t)))
            pos = i + 1
    return out


def _overlaps(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(start < e and s < end for s, e in spans)


def _is_question_message(msg_low: str) -> bool:
    """คำถามจริง — ตัด vocative tail ก่อน ("รอนานไหมครับแอด" → "รอนานไหม")."""
    return bool(_QUESTION_RE.search(_VOCATIVE_TAIL_RE.sub("", msg_low)))


def _mild_anger_fires(msg_low: str, mild_terms: tuple) -> bool:
    """mild marker = บ่นบริการร้านเท่านั้นถึง escalate:
    - occurrence ที่ทับ product span ไม่นับ ("ไม่มีการตอบ|สนอง" = อาการสินค้า)
    - ต้องมี service context นอก marker/product span — หรือไม่มี product
      context เลย (bare "ช้ามาก" ในแชทร้าน ≈ บ่นบริการ)"""
    _ctx = _term_spans(msg_low, _PRODUCT_CONTEXT_TERMS + _HISTORY_CONTEXT_TERMS)
    _hits = [(s, e) for s, e in _term_spans(msg_low, mild_terms)
             if not _overlaps(s, e, _ctx)]
    if not _hits:
        return False
    _blocked = _ctx + _hits
    _has_svc = any(not _overlaps(s, e, _blocked)
                   for s, e in _term_spans(msg_low, _SERVICE_CONTEXT_TERMS))
    return _has_svc or not _ctx


# ── pure decision predicates (Revised Phase 1 — extracted verbatim from
#   detect_human_request so turn_decision can reuse them without firing a
#   handoff; behavior must not change) ─────────────────────────────────────

_HUMAN_REQUEST_KWS = (
    "ขอคุยกับคน", "ขอคุยกับแอดมิน", "ขอแอดมิน", "มีคนตอบไหม",
    "มีคนไหม", "มีมนุษย์ไหม", "มนุษย์ตอบ", "มนุษย์มาตอบ", "คนตอบหน่อย",
    "admin มา", "admin ตอบ", "แอดมินมา", "แอดมินตอบ", "แอดมินไม่ทำงาน",
    "ไม่มีคนตอบ", "ไม่มีแอดมิน", "เมื่อไหร่จะมีคน", "เมื่อไหร่จะมีแอดมิน",
    "เมื่อไหร่จะมีมนุษย์", "อยากคุยกับคน", "อยากคุยกับแอดมิน",
    "ให้คนตอบ", "ให้แอดมินตอบ", "ติดต่อแอดมิน",
    "พูดกับแอดมิน", "ส่งต่อแอดมิน",
    # ⚡ "ขอคน"/"ติดต่อคน"/"พูดกับคน"/"ส่งต่อคน" ย้ายไป composition (มี guard กัน "คนละ"/"คนขับ")
    # BUG-M fix — เพิ่มคำที่ลูกค้าไทยใช้จริงแต่หลุด (จาก QA 2026-09-11)
    "กรุณาตอบกลับ", "ตอบหน่อย", "มีใครอยู่ไหม", "ยังอยู่ไหม",
    "แอดดด", "ทำไมไม่ตอบ", "หายไปไหน", "แอดมินยังไม่ตอบ",
    "คนยังไม่ตอบ", "รอแอดมิน", "รอคน", "แอดมินยังไม่มา",
    "ทำไมไม่มีคน", "ทำไมไม่มีแอดมิน", "ขอเบอร์แอดมิน",
    "ติดต่อกลับด่วน", "ติดต่อกลับหน่อย", "กลับหน่อย",
)
# ⚡ BUG-M phase 2 — composition: (verb + target) ครอบ phrasing ใหม่โดยไม่ต้องเพิ่มทีละเคส
_HUMAN_VERB_RE = (
    r"(?:ติดต่อ|โทรหา|โทร|คุยกับ|คุย|แชทกับ|แชท|พูดคุยกับ|พูดคุย|พูดกับ|พูด"
    r"|ขอคุย|ขอพูด|ขอแชท|ขอ|ส่งต่อ|ให้|อยากคุย|อยากพูด|อยากแชท|อยาก)"
)
#   target "คน" ต้องกัน "คนละ"/"คนขับ"/"คนส่ง" (คำทั่วไป ไม่ใช่ขอคุยกับคน)
_HUMAN_TARGET_RE = r"(?:เจ้าหน้าที่|พนักงาน|ทีมงาน|แอดมิน|admin|มนุษย์|human|agent|staff|คนจริง|ตัวคน|คน(?!ละ|ขับ|ส่ง|รับ))"

_STRONG_ANGER_PHRASES = (
    "เห้ย", "เฮ้ย", "หัวร้อน", "โกรธ", "โมโห", "ผิดหวัง", "เซ็ง",
    "รำคาญ", "ห่วย", "แย่มาก", "แย่จริง", "แย่จัง", "แย่สุด",
    "แย่ที่สุด", "ไม่ไหวแล้ว", "ตีของกลับ", "ไม่เอาแล้ว",
    "เลวร้าย", "แย่เอามาก", "worst",
)
# short token ("กาก") — ต้อง _toxic_token_present กันชนคำประสม
_STRONG_ANGER_TOKENS = ("กาก",)
_MILD_ANGER = (
    "ช้ามาก", "ช้าจัง", "ช้าเกิน", "ช้าสุด", "นานมาก", "นานเกิน",
    "รอนาน", "ไม่ตอบเลย", "ตอบช้า", "เงียบหาย", "ไม่มีคนตอบ",
    "ไม่มีใครตอบ", "ไม่มีการตอบ", "ช้าว่ะ", "ช้าเว้ย",
)


def is_human_request(message: str) -> bool:
    """pure predicate — ลูกค้าขอคุยกับคน/แอดมิน (ไม่ fire handoff, ไม่แตะ req).

    รับ message ดิบ; normalize เอง (lower + ำ→ัม) เหมือน detect_human_request.
    """
    msg_low = (message or "").lower().replace("ำ", "ัม")
    _is_question = _is_question_message(msg_low)
    # kw ที่จบ "กลาง" product term ไม่นับ — "ทำไมไม่ตอบ|สนอง" = อาการสินค้า
    _prod_spans = _term_spans(
        msg_low, _PRODUCT_CONTEXT_TERMS + _HISTORY_CONTEXT_TERMS)
    is_hr = any(
        any(not any(s < e_kw < e for s, e in _prod_spans)
            for _, e_kw in _term_spans(msg_low, (kw,)))
        for kw in _HUMAN_REQUEST_KWS)
    if not is_hr and re.search(
        _HUMAN_VERB_RE + r"[กับหาด่วน]{0,6}\s*" + _HUMAN_TARGET_RE, msg_low
    ):
        is_hr = True
    # "ร้าน" เป็น target เฉพาะ contact-verbs — "คุยเรื่องร้าน" ไม่ใช่ขอคุยกับคน
    if not is_hr and re.search(r"(?:ติดต่อ|โทรหา|โทร|ขอเบอร์)\S{0,6}ร้าน", msg_low):
        is_hr = True
    # English — "talk to human" / "speak to agent" / "contact staff" / "real person"
    if not is_hr and re.search(
        r"(?:talk|speak|chat|call|contact|connect)\W{0,5}(?:to\W{0,5})?(?:a\W{0,5})?"
        r"(?:human|agent|staff|admin|person|someone|real)",
        msg_low,
    ):
        is_hr = True
    # BUG-M fix — "แอด" สั้น → เฉพาะข้อความสั้นที่ไม่มีคำต่อท้าย
    if not is_hr:
        _msg_stripped = msg_low.strip()
        if (
            len(_msg_stripped) <= 15
            and "แอด" in _msg_stripped
            and not _is_question
            and not any(w in _msg_stripped for w in (
                "แอดเพื่อน", "แอดไลน์", "แอดเดรส", "แอดเคาท์",
                "แอดมิชั่น", "แอดปโน", "แอดมิน",
            ))
        ):
            is_hr = True
    return is_hr


def is_service_anger(message: str) -> bool:
    """pure predicate — ลูกค้าโกรธ/ผิดหวังกับบริการ (ไม่ fire handoff).

    composition เดิม: strong marker เดี่ยวพอ / mild ต้องมี service context /
    promo+shop-script ไม่นับ / question-guard สำหรับ mild.
    """
    msg_low = (message or "").lower().replace("ำ", "ัม")

    def _strong() -> bool:
        return any(kw in msg_low for kw in _STRONG_ANGER_PHRASES) or \
            any(_toxic_token_present(msg_low, t) for t in _STRONG_ANGER_TOKENS)

    _is_promo = any(t in msg_low for t in _PROMO_TERMS)
    _is_shop_script = any(t in msg_low for t in _SHOP_SCRIPT_TERMS)
    is_angry = False
    if _strong() and not _is_promo:
        is_angry = True
    elif not _is_shop_script and _mild_anger_fires(msg_low, _MILD_ANGER):
        is_angry = True
    # question-guard — เฉพาะ mild marker
    if is_angry and not _strong() and _is_question_message(msg_low):
        is_angry = False
    return is_angry


def detect_human_request(req, ctx: dict) -> dict | None:
    """Human-request handoff — ย้าย verbatim จาก app.py chat() (BUG-3 fix).

    ctx keys: steps, timing_breakdown, total_start, image_desc_out, model_name
    """
    from . import llm
    from . import app as _app_module

    _steps = ctx.get("steps") or []
    _timing_breakdown = ctx.get("timing_breakdown") or {}
    _total_start = ctx.get("total_start", _time.time())
    _image_desc_out = ctx.get("image_desc_out", "")
    model_name = ctx.get("model_name", "")

    # ⚡ 5F-B/H4 — ticket อยู่ฝั่งแอดมินแล้ว → ห้าม re-fire handoff
    #   open=แอดมินรับงาน, handoff=รอ distributor, pending=อยู่ในคิว
    #   (ลูกค้าโมโห/ขอคนระหว่างรอแอดมิน = duplicate POST + notification spam)
    #   ให้ post-handoff lock ใน warranty_flow ตอบ "รอแอดมิน" แทน
    if getattr(req, "ticket_state", None) in ("handoff", "open", "pending"):
        return None

    # ===== BUG-3 fix — ลูกค้าขอคุยกับคน/แอดมิน → handoff ทันที ห้ามบอทตอบเอง =====
    # ก่อนหน้านี้: ลูกค้าถาม "Admin ไม่ทำงานกันหรอคะ เมื่อไหร่จะมีมนุษย์มาตอบ"
    #   → บอทตอบ "แอดมินมาดูแลแล้วค่ะ" (เท็จ) + handoff_to_admin=null (ไม่ escalate)
    # ตอนนี้: detect คำขอคุยกับคน → ส่งต่อแอดมินจริง + ตอบว่า "เดี๋ยวส่งต่อให้แอดมินนะคะ"
    # ⚡ Revised Phase 1 — detection ย้ายไป module-level predicates
    #   (is_human_request / is_service_anger) เพื่อให้ turn_decision reuse ได้
    #   โดยไม่ fire handoff — logic เดิม verbatim, ไม่มี keyword เพิ่ม
    _is_human_request = is_human_request(req.message)
    _is_angry = is_service_anger(req.message)

    if _is_human_request or _is_angry:
        _reason = "human_request" if _is_human_request else "customer_frustration"
        _topic = "ลูกค้าขอคุยกับแอดมิน" if _is_human_request else "ลูกค้าไม่พอใจ/โกรธ"
        _human_answer = (
            f"ขออภัยที่ให้รอนะคะ เดี๋ยวส่งต่อแชทนี้ให้แอดมินดูแลให้นะคะ "
            f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            if _is_human_request else
            f"ขออภัยที่ทำให้ไม่พอใจนะคะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
            f"ดูแลให้โดยเร็วนะคะ รบกวนรอการติดต่อกลับอีกครั้งนะคะ"
        )
        _total_elapsed = _time.time() - _total_start

        # ส่งต่อแอดมิน (best-effort) — เหมือน tax invoice handoff
        if req.conversation_id:
            _app_module._send_handoff(req, None, reason=_reason,
                          claim={"topic": _topic}, log_tag="HUMAN-HANDOFF")
        print(f"[TIMING] HUMAN-HANDOFF({_reason}): {_total_elapsed:.2f}s", file=sys.stderr)
        return dict(
            answer=_human_answer,
            answer_segments=llm.split_segments(_human_answer),
            products=[],
            shop=req.shop,
            model=model_name,
            source="human_request_handoff",
            usage={},
            elapsed=round(_total_elapsed, 2),
            cost=0.0,
            handoff_to_admin=True,
            handoff_reason=_reason,
            timing=_timing_breakdown,
            steps=_steps,
            routing_decision=_app_module._routing(
                "handoff", f"{_reason}: {_topic} → ส่งแอดมิน",
                handoff_reason=_reason,
            ),
            image_desc=_image_desc_out,
        )
    return None


def post_intent_handoffs(req, ctx: dict, db) -> dict | None:
    """Tax invoice + TISI handlers — ย้าย verbatim จาก app.py chat() (post-intent).

    ctx keys: is_tax_invoice, bot_name, steps, timing_breakdown,
    total_start, image_desc_out, model_name
    """
    from . import llm
    from . import product_store
    from . import warranty
    from . import app as _app_module

    _is_tax_invoice = ctx.get("is_tax_invoice", False)
    _bot_name = ctx.get("bot_name", "ทางร้าน")
    _steps = ctx.get("steps") or []
    _timing_breakdown = ctx.get("timing_breakdown") or {}
    _total_start = ctx.get("total_start", _time.time())
    _image_desc_out = ctx.get("image_desc_out", "")
    model_name = ctx.get("model_name", "")

    # ===== Tax invoice → handoff แอดมินเลย (หลัง intent classification) =====
    # ถ้าลูกค้าขอใบกำกับภาษี หรือส่งข้อมูลใบกำกับภาษี → ส่งแอดมินโดยตรง
    # ไม่ต้องให้บอทตอบเอง เพราะใบกำกับภาษีต้องแอดมินดำเนินการ
    # ⚡ Phase 6 — ย้ายมาหลัง intent classification เพื่อให้ intent_result มีส่วนร่วม
    #   แต่ keyword detection ยังจับ data submission (เลขผู้เสียภาษี/หจก.) ที่ intent อาจไม่จับ
    if _is_tax_invoice:
        _tax_answer = (
            f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
            f"เพื่อดำเนินการเรื่องใบกำกับภาษีให้นะคะ "
            f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
        )
        _total_elapsed = _time.time() - _total_start

        # ส่งต่อแอดมิน (best-effort)
        if req.conversation_id:
            _app_module._send_handoff(req, None, reason="tax_invoice_request",
                          claim={"topic": "ใบกำกับภาษี"}, log_tag="TAX-HANDOFF")
        print(f"[TIMING] TAX-HANDOFF: {_total_elapsed:.2f}s", file=sys.stderr)
        return dict(
            answer=_tax_answer,
            answer_segments=llm.split_segments(_tax_answer),
            products=[],
            shop=req.shop,
            model=model_name,
            source="tax_invoice_handoff",
            usage={},
            elapsed=round(_total_elapsed, 2),
            cost=0.0,
            handoff_to_admin=True,
            handoff_reason="tax_invoice_request",
            timing=_timing_breakdown,
            steps=_steps,
            routing_decision=_app_module._routing(
                "handoff", "tax_invoice: ลูกค้าขอใบกำกับภาษี → ส่งแอดมิน",
                handoff_reason="tax_invoice_request",
            ),
            image_desc=_image_desc_out,
        )

    # ===== cert standards question handler (มอก./CE/CCC/FCC/RoHS/GB) =====
    # ถ้าลูกค้าถามเรื่องมาตรฐาน → ค้นสินค้าใน DB (description + image_texts)
    # - ถ้าเจอ → ตอบว่ามี รุ่นไหนบ้าง (หรือรุ่นที่เจาะจงถาม)
    # - ถ้าไม่เจอ → ส่งเรื่องให้แอดมิน + handoff
    _certs = warranty.detect_cert_question(req.message)
    if _certs:
        _cert_label = "/".join({"tisi": "มอก."}.get(c, c.upper()) for c in _certs)
        _tisi_model_kw = warranty.extract_tisi_model_keyword(req.message)
        # หมวดสินค้าที่ลูกค้าระบุ — provenance-aware (route_context owner):
        #   explicit type noun ชนะ device/model regex mention — "หัวชาร์จ
        #   iphone 17" → {charger} (iphone เป็น compat target ไม่ใช่หมวดที่ถาม)
        from . import route_context as _rc_cert
        _cert_types = _rc_cert.requested_product_types(req.message)
        if _tisi_model_kw and _rc_cert.requested_product_types(
                req.message, explicit_only=True):
            # model_kw ที่ไม่ใช่ code-shaped (ชื่อ device/brand เช่น "iPhone")
            # เมื่อ explicit type noun ชี้หมวดอื่น → token นั้นคือ compat target
            # ไม่ใช่รุ่นสินค้า → ค้นตามหมวดแทน (code-shaped เช่น "AC65B2"
            # หรือข้อความที่ไม่มี explicit type เลย → เก็บไว้ค้นชื่อตรงๆ)
            from .scripts.unit_classifier import _extract_codes as _uc_codes
            if not _uc_codes(_tisi_model_kw):
                _tisi_model_kw = ""
        # ⚡ Task 5C-E — carry context: message ไม่มี type → history user msgs → active anchor
        _cert_ctx_text = " ".join(
            (getattr(m, "text", "") or "")
            for m in list(req.history or [])[-4:]
            if getattr(m, "role", "") == "user")
        if not _cert_types and _cert_ctx_text:
            _cert_types = _rc_cert.requested_product_types(_cert_ctx_text)
        if not _cert_types and req.conversation_id:
            try:
                from . import conversation_products as _cp_cert
                _ac = _cp_cert.get_active_product(req.conversation_id)
                if _ac:
                    _cert_types = _rc_cert.requested_product_types(
                        _ac.get("name") or "")
            except Exception:
                pass
        print(f"[CERT] cert question detected certs={_certs}, model_keyword={_tisi_model_kw!r}, types={_cert_types}", file=sys.stderr)
        _cert_fallback_products = []
        try:
            _tisi_products = product_store.search_cert_products(
                db,
                _certs,
                shop_filter=req.shop,
                model_keyword=_tisi_model_kw or None,
                limit=30,
                type_filter=_cert_types or None,
            )
            if not _tisi_products and _cert_types:
                # ไม่เจอในหมวดที่ถาม → ค้นไม่จำกัดหมวด เพื่อตอบ "ไม่พบในหมวดนี้ แต่มีอันอื่น"
                _cert_fallback_products = product_store.search_cert_products(
                    db,
                    _certs,
                    shop_filter=req.shop,
                    model_keyword=None,
                    limit=30,
                )
        except Exception as _te:
            print(f"[TISI] search error: {_te}", file=sys.stderr)
            _tisi_products = []

        # ⚡ Task 5C-E — subtype-aware: context บอก adapter/cable → กรองผลตาม
        #   subtype เมื่อกรองแล้วยังเหลือ (กัน "หัวชาร์จ มอก." ตอบสายชาร์จ)
        _cert_sub = (
            product_store._detect_charger_subtype(req.message)
            or product_store._detect_charger_subtype(_cert_ctx_text))
        if _cert_sub and _tisi_products:
            _sub_ok = [p for p in _tisi_products
                       if product_store._detect_charger_subtype(
                           p.get("name") or "") == _cert_sub]
            if _sub_ok:
                _tisi_products = _sub_ok

        _TYPE_TH = {
            "powerbank": "พาวเวอร์แบงค์", "charger": "อุปกรณ์ชาร์จ",
            "phone": "โทรศัพท์", "earphone": "หูฟัง", "smartwatch": "สมาร์ทวอช",
            "smartband": "สมาร์ทแบนด์", "case": "เคส", "camera": "กล้อง",
            "speaker": "ลำโพง", "tablet": "แท็บเล็ต", "memory_card": "เมมโมรี่การ์ด",
        }
        _type_th = "/".join(_TYPE_TH.get(t, t) for t in sorted(_cert_types))

        if _tisi_products or _cert_fallback_products:
            # สร้างคำตอบ — แสดงรุ่นที่มี cert ที่ถาม
            # ⚡ Task 5C-E — ผลที่ไม่ NORMAL ต้องมี availability label
            #   (ห้ามดูเหมือนขายได้ — customer_hidden/เลิกขาย ระบุชัด)
            _CERT_AV_LABEL = {"out_of_stock": "หมดสต็อกชั่วคราว",
                              "unlisted": "ยังไม่เปิดขาย",
                              "discontinued": "เลิกจำหน่าย",
                              "unknown": "ไม่พร้อมจำหน่าย"}
            _tisi_names = []
            for p in (_tisi_products or _cert_fallback_products):
                _name = p.get("name", "")
                # ตัด prefix ราคา/โค้ดออกจากชื่อ (เช่น "[ราคาพิเศษ 1990บ.] PowerConnex..." → "PowerConnex...")
                _clean_name = re.sub(r"^\[.*?\]\s*", "", _name).strip()
                _av = product_store.resolve_availability(
                    {"item_status": p.get("status"),
                     "total_stock": p.get("stock")})
                _lab = _CERT_AV_LABEL.get(_av["catalog_status"], "")
                if _lab:
                    _clean_name = f"{_clean_name} ({_lab})"
                _tisi_names.append(_clean_name)
            if _tisi_model_kw:
                # ลูกค้าเจาะจงรุ่น → ตอบเฉพาะรุ่นนั้น
                if len(_tisi_names) == 1:
                    # stock DB มีเลข มอก./ใบอนุญาตจริง → แสดงเฉพาะตอนถาม มอก.
                    # (cert_ids เป็น metadata รวม — คำถาม CE/CCC ไม่แปะเลข มอก. กันสับสน)
                    _cids = (_tisi_products[0].get("cert_ids") or {}) if _tisi_products else {}
                    _cids_txt = ""
                    if _cids.get("tis_id") and "tisi" in _certs:
                        _cids_txt = f" (เลข มอก. {_cids['tis_id']}"
                        if _cids.get("tis_license_id"):
                            _cids_txt += f" ใบอนุญาต {_cids['tis_license_id']}"
                        _cids_txt += ")"
                    _tisi_answer = (
                        f"ค่ะ สินค้า{_tisi_names[0]} มี {_cert_label}{_cids_txt} ค่ะ "
                        f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                    )
                else:
                    _tisi_list = "\n".join(f"• {n}" for n in _tisi_names)
                    _tisi_answer = (
                        f"ค่ะ สินค้าที่มี {_cert_label} ในร้าน ได้แก่:\n{_tisi_list}\n\n"
                        f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                    )
            elif not _tisi_products and _cert_fallback_products:
                # ไม่เจอในหมวดที่ถาม → ตอบตรงๆ + เสนอสินค้าหมวดอื่นที่มี cert
                _tisi_list = "\n".join(f"• {n}" for n in _tisi_names)
                _tisi_answer = (
                    f"ค่ะ สำหรับ{_type_th} ยังไม่พบข้อมูล {_cert_label} ในระบบค่ะ "
                    f"แต่สินค้าอื่นที่มี {_cert_label} ได้แก่:\n"
                    f"{_tisi_list}\n\n"
                    f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                )
            else:
                # ลูกค้าถามทั่วไป "รุ่นไหนมี X บ้าง" → แสดงรุ่นทั้งหมด
                # ⚡ Task 5C-E — ถามลอยๆ ไม่มี context เลย: cap list + ถามหมวด
                #   (ไม่ dump สินค้าทั้งร้านทุกหมวด)
                _names_show = _tisi_names
                _clarify = ""
                if not _cert_types:
                    _names_show = _tisi_names[:12]
                    _clarify = ("หากสนใจหมวดไหน (เช่น พาวเวอร์แบงค์/หัวชาร์จ/"
                                "สายชาร์จ) แจ้งได้นะคะ จะได้แนะนำเจาะหมวดให้ค่ะ")
                    if len(_tisi_names) > 12:
                        _clarify = (f"และยังมีอีก {len(_tisi_names) - 12} รุ่นค่ะ "
                                    + _clarify)
                _tisi_list = "\n".join(f"• {n}" for n in _names_show)
                _tisi_answer = (
                    f"ค่ะ สินค้าที่มี {_cert_label} ในร้าน ได้แก่:\n"
                    f"{_tisi_list}\n\n"
                    + (_clarify + "\n" if _clarify else "")
                    + "สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                )
            _total_elapsed = _time.time() - _total_start

            _cert_n = len(_tisi_products) if _tisi_products else len(_cert_fallback_products)
            print(f"[CERT] found {_cert_n} products with {_cert_label}"
                  f"{' (fallback: นอกหมวดที่ถาม)' if not _tisi_products else ''}", file=sys.stderr)
            return dict(
                answer=_tisi_answer,
                answer_segments=llm.split_segments(_tisi_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="cert_answer",
                usage={},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                handoff_to_admin=False,
                timing=_timing_breakdown,
                steps=_steps,
                routing_decision=_app_module._routing(
                    "cert", f"{_cert_label}: เจอ {_cert_n} สินค้า → ตอบ",
                ),
                image_desc=_image_desc_out,
            )
        else:
            # ไม่พบสินค้าที่มี cert ที่ถาม → ส่งเรื่องให้แอดมิน + handoff
            _tisi_handoff_answer = (
                f"ขออภัยค่ะ {_bot_name} ไม่พบข้อมูล {_cert_label} ของสินค้าในระบบ "
                f"เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
                f"เพื่อตรวจสอบข้อมูล {_cert_label} ให้นะคะ "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            )
            _total_elapsed = _time.time() - _total_start

            # ส่งต่อแอดมิน (best-effort)
            if req.conversation_id:
                _app_module._send_handoff(req, None, reason="cert_not_found",
                              claim={"topic": f"สอบถาม {_cert_label}"}, log_tag="CERT-HANDOFF")
            print(f"[CERT] no products with {_cert_label} found → handoff to admin", file=sys.stderr)
            return dict(
                answer=_tisi_handoff_answer,
                answer_segments=llm.split_segments(_tisi_handoff_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="cert_handoff",
                usage={},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                handoff_to_admin=True,
                handoff_reason="cert_not_found",
                timing=_timing_breakdown,
                steps=_steps,
                routing_decision=_app_module._routing(
                    "handoff", f"{_cert_label}: ไม่พบสินค้าที่มี {_cert_label} → ส่งแอดมิน",
                    handoff_reason="cert_not_found",
                ),
                image_desc=_image_desc_out,
            )
    return None
