# Plan — แก้ 3 ปัญหาจาก test_200 full run (220 ข้อ, LLM จริง)

แหล่งที่มา: `getoutofmywaybotkaikrook2.md` § test_200 full run — เจอ 1 ERR (HTTP 500) + 2 FAIL (misroute)

## สรุป root cause + impact

| # | เคส | Root cause | Fix | ผลกระทบ type/subtype | เสี่ยง |
|---|---|---|---|---|---|
| P0 | #132 HTTP 500 | `qa_context` dict literal evaluate f-string `topic.split()[0]` **ทุก key ก่อนเลือก level** → hit ใดๆ ที่ topic ว่าง crash — kb_qa มี **32/393 docs topic=''** (general_faq) → landmine ~8% ของทุก QA hit | guard split 1 จุด | ไม่มี — crash → tag ถูกต้อง | **0** |
| P1 | #143 "ขึ้นเครื่องไปจีน" → shipping_policy | intent ส่ง `general_qtype=shipping_policy` → `app.py:1499` early-return ก่อนถึง compat-followup (1620) + product flow — **ทั้ง bug class**: คำถามกฎเครื่องบิน/ต่างประเทศทุก type (powerbank Wh rules = เคสจริงที่พบบ่อยสุด) | deterministic guard ที่ choke point เดิม | ทุก type ได้ประโยชน์ โดยเฉพาะ powerbank/charger/battery; shipping จริงไม่โดน (มี verb precedence) | ต่ำ |
| P2 | #199 "มีสินค้า smart home ไหม" → general:categories | intent ส่ง `general_qtype=categories` → generic dump 0 products — "smart home" คือ **cross-type cluster** (Youpin 95 items กระจาย 17 types: smartwatch 57, air_purifier 13, camera 13...) ไม่ใช่ taxonomy type — แต่ชื่อสินค้ามี "Smart/สมาร์ท" ตรงๆ → text search เจอ | deterministic guard: categories + noun เจาะจง → product flow | ทุก noun ที่ taxonomy ไม่ครอบ (smart home, เครื่องชงกาแฟ, หม้อทอด...) → ได้ product search จริง | ต่ำ-กลาง |

**สิ่งที่ตัดทิ้ง (อย่าทำ):**
- เพิ่ม `smart_home` เข้า PRODUCT_TYPES — ผิดทาง: เป็น cluster ข้าม 17 types ไม่ใช่ type; item names ไม่มี "smart home" literal → type filter จะ under-match
- แก้ intent_classifier prompt — deterministic guard ครอบแล้ว; prompt เปลี่ยน = nondeterministic + ต้อง regression ทั้งชุด (defer เป็น hardening ภายหลังถ้าจำเป็น)
- backfill topic ให้ 32 docs — code guard ครอบแล้ว; data fix เป็น optional cleanup ไม่บังคับ
- ย้าย/แตะ `_compat_followup_kws` (1620) — ใช้คนละจุด คนละวัตถุประสงค์ (skip KB ไม่ใช่ skip general route)

---

## Task 1 — P0: guard `topic.split()[0]` ใน `qa_context`

**Files:** `chatbot/shopeechat/knowledge_base.py:1265-1269` · test: `docs/test/test_qa_context_guard.py` (ใหม่)

**บริบท:** `qa_context` ถูกเรียกทุกข้อความ (`app.py` ~L4331) — crash rate = P(empty-topic doc ติด top-3 QA hits)

**วิธีแก้ (diff เดียว):**

```python
    for h in hits:
        _topic0 = next(iter((h.get("topic") or "").split()), "")
        tag = {"model": f"เฉพาะรุ่น {','.join(h.get('model_codes') or [])}",
               "item": "เฉพาะสินค้าที่ลูกค้าสนใจ",
               "brand": f"เฉพาะแบรนด์ {_topic0}",
               "generic": "คำแนะนำทั่วไป (ไม่เจาะรุ่น)"}[h["_qa_level"]]
```

(หมายเหตุ: level="brand" set ได้เฉพาะเมื่อ topic startswith known brand — ค่า `_topic0` ที่ใช้จริงใน brand branch จะไม่ว่างอยู่แล้ว; guard นี้กันเฉพาะ eager-eval)

**Test (`test_qa_context_guard.py` — assert style เหมือน test_cert_standards):**
- monkeypatch `knowledge_base.search_qa` → คืน `[{"_qa_level": "generic", "topic": "", "q": "x", "a": "y", "model_codes": []}]`
- `qa_context("อันไหนเสียงดีสุด")` → ต้องไม่ raise + output มี "คำแนะนำทั่วไป"
- เคสกัน regression: topic="CUKTECH สายชาร์จ" level="brand" → tag ยัง "เฉพาะแบรนด์ CUKTECH"

**Verify:** `python3 docs/test/test_qa_context_guard.py` + `python3 -m py_compile knowledge_base.py`

---

## Task 2 — P1+P2: general_qtype guards ที่ `app.py:1499` (choke point เดียว)

**Files:** `chatbot/shopeechat/app.py` ~L1499-1518 · test: `docs/test/test_general_qtype_guards.py` (ใหม่)

**Design:** helper ตัวเดียว pure function ทดสอบได้ ใช้ที่ choke point — pattern เดียวกับ guard warranty+model ที่มีอยู่ (L1503)

```python
# module level — travel/flight kws (subset ของ _compat_followup_kws + เพิ่ม)
_TRAVEL_KWS = ("ขึ้นเครื่อง", "เครื่องบิน", "นำขึ้น", "ติดตัวขึ้น",
               "ไปจีน", "ต่างประเทศ", "สนามบิน", "ตม.", "ผ่านสแกน")
# shipping verbs — ถ้ามีคำเหล่านี้ปน ถือเป็นคำถามจัดส่งจริง ("ส่งไปจีนได้ไหม")
_SHIP_VERB_KWS = ("ส่ง", "จัดส่ง", "ขนส่ง", "ship", "deliver", "ค่าส่ง", "cod")
# noun กว้างที่ถือว่า "ถามหมวดรวม" ไม่ใช่สินค้าเจาะจง
_CAT_GENERIC_NOUNS = {"สินค้าอะไร", "อะไร", "อะไรบ้าง", "ทั้งหมด", "ทุกอย่าง",
                      "หมวดหมู่", "หมวดหมู่อะไร", "หมวดอะไร", "ประเภท", "ประเภทอะไร",
                      "ของ", "สินค้า", "อะไรดี", "แบบไหน"}
_CAT_NOUN_RE = re.compile(r"(?:มี|ขาย)\s*(.{2,40}?)\s*(?:ไหม|มั้ย|ป่าว|บ้าง)(?:\s|$|[!?])")

def _general_qtype_bypass(qtype: str | None, message: str) -> str | None:
    """คืน qtype เดิม หรือ None ถ้า message ควรไป product flow แทน general route."""
    if not qtype:
        return qtype
    low = (message or "").lower()
    if qtype == "shipping_policy":
        # ถามกฎการเดินทางของสินค้า (ขึ้นเครื่อง/ไปต่างประเทศ) ไม่ใช่เรื่องจัดส่ง
        # — shipping verb ชนะ ("ส่งไปจีน" = ถามจัดส่งจริง)
        if any(k in low for k in _TRAVEL_KWS) and not any(k in low for k in _SHIP_VERB_KWS):
            return None
    elif qtype == "categories":
        # "มีสินค้า smart home ไหม" — noun เจาะจงที่ taxonomy ไม่ครอบ → product search
        m = _CAT_NOUN_RE.search(low)
        if m:
            noun = m.group(1).strip()
            if noun and noun not in _CAT_GENERIC_NOUNS and len(noun) >= 2:
                return None
    return qtype
```

**จุดเรียกใช้ (ใน `chat()` ก่อน `if general_qtype:`):**

```python
        if general_qtype:
            _gq0 = general_qtype
            general_qtype = _general_qtype_bypass(general_qtype, req.message)
            if _gq0 and not general_qtype:
                print(f"[INTENT] general_qtype {_gq0} → bypass to product flow", file=sys.stderr)
        if general_qtype:
            # ... block เดิมทั้งหมด (warranty/return model guard → build_general_context → return)
```

**Test (`test_general_qtype_guards.py`):**
- `bypass("shipping_policy", "เอาขึ้นเครื่องไปจีนด้วยได้อ่ะ")` → None
- `bypass("shipping_policy", "ส่งไปจีนได้ไหม")` → "shipping_policy" (verb ชนะ)
- `bypass("shipping_policy", "ส่งกี่วัน")` → "shipping_policy" (ไม่มี travel kw)
- `bypass("shipping_policy", "พาวเวอร์แบงค์ขึ้นเครื่องได้ไหม")` → None
- `bypass("categories", "มีสินค้า smart home ไหม")` → None
- `bypass("categories", "มีสินค้าอะไรบ้าง")` → "categories" (generic noun)
- `bypass("categories", "ขายอะไรบ้าง")` → "categories"
- `bypass("categories", "มีหมวดหมู่อะไรบ้าง")` → "categories"
- `bypass("brands"/"shops"/"warranty_policy"/None, ...)` → เดิมเป๊ะ

**E2E verify (server restart แล้วยิงจริง):**
- #143 sequence เดิม (ถามหัวชาร์จ 67W → "เอาขึ้นเครื่องไปจีนด้วยได้อ่ะ") → ต้องได้ products + ตอบบริบทสินค้า ไม่ใช่ shipping punt
- "พาวเวอร์แบงค์ขึ้นเครื่องได้ไหม" (standalone ไม่มี history) → products + ตอบกฎ Wh
- "ส่งกี่วัน" → ยัง shipping_policy เหมือนเดิม (regression)
- "มีสินค้า smart home ไหม" (Youpin) → products จริง (smart camera/purifier/...) ไม่ใช่ category dump
- "มีสินค้าอะไรบ้าง" (Youpin) → ยัง categories เหมือนเดิม (regression)

**Impact check ข้าม type/subtype (ตามกฎ — เช็คก่อนแก้):**
- travel kws อยู่ใน `_compat_followup_kws` อยู่แล้ว (1620) → bypass แล้ว compat-followup เดิมจับ charger-history เคสต่อได้ทันที — เคส #143 เดินทางสู่ machinery ที่ออกแบบไว้แล้ว
- `_TRAVEL_KWS` ไม่ชนคำถาม shipping จริง: "ส่งกี่วัน/เมื่อไหร่ได้ของ/นโยบายจัดส่ง" ไม่มี travel kw
- `_SHIP_VERB_KWS` ครอบ edge "ส่งไปต่างประเทศ/จัดส่งจีน" → shipping คงเดิม
- categories bypass ไม่กระทบ type ที่ detect ได้ (พัดลม/หูฟัง/เคส — intent ส่ง product_question อยู่แล้ว ไม่เข้า categories route)
- ข้อเสียที่รับ: "มีของแท้ไหม"→noun "ของแท้" ถ้า intent ส่ง categories → product search "ของแท้" → worst case no-product guard/handoff — ยังดีกว่า category dump ที่ตอบผิดคำถาม

---

## Task 3 — verify รวม + docs

- รัน `docs/test/test_general_qtype_guards.py` + `docs/test/test_qa_context_guard.py`
- regression: `test_cert_standards.py` 66/66 + `test_car_charger_regression.py` 16/16
- E2E 5 เคสข้างบนบน server จริง
- อัปเดต `docs/SRS_SSD.md`: `qa_context` (guard), `_general_qtype_bypass` (ฟังก์ชันใหม่ — Purpose/Input/Output/Calls/Called by/How it works/Error fallback ตามกฎข้อ 1-2)
- อัปเดต `getoutofmywaybotkaikrook2.md`: ย้าย 3 ปัญหา → ผ่านแล้ว พร้อม error→cause→fix→impact แบบสั้น

## ข้าม scope (ไม่ทำใน plan นี้)

- minor #166 (ตอบอังกฤษตาม input อังกฤษ — พฤติกรรมถูกแล้ว)
- minor #133 (ThaiSuperPhone เสื้อยืด — ข้อมูลจริงร้านขายเสื้อ ไม่ใช่ bug)
- OBS จาก compat plan (context hygiene, web retry) — อยู่ใน plan อื่นแล้ว defer ตามเดิม
