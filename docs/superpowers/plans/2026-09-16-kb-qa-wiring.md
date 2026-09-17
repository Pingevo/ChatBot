# KB QA Wiring + Per-Product Warranty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ต่อ `kb_qa` (392 troubleshooting QA) เข้า runtime ด้วย model-aware hybrid retrieval, repoint KB reads จาก `knowledge_base` เก่าไป `kb_products`/`kb_qa`, และทำให้คำตอบเรื่องประกันตอบตามข้อมูลจริงระดับสินค้า (ชื่อ + รูปเงื่อนไข) แทน policy กลางตัวเดียว

**Architecture:** additive เท่านั้น — เพิ่ม query path ใหม่ใน `knowledge_base.py`/`units.py`, wire เข้า `app.py` แค่จุด concat context (≤6 บรรทัด), ไม่ลบ collection เก่า (rollback ผ่าน env), embedding ใหม่ใช้ infra เดิม (`embedding.py` + npz cache pattern ของ `units.py`)

**Tech Stack:** Python, pymongo, numpy, local HF embedding (`embedding.embed_query/embed_texts`), FastAPI app

**Spec:** สรุป requirements จากการคุยกับ user (16 ก.ย. 2026) — QA ต้องจับรุ่นได้จริง, ไม่เอาคำแนะนำข้ามรุ่น, ประกันต้องตอบตามสินค้า/ร้านจริง, ห้ามขยาย `app.py` นอกจาก wiring

## Global Constraints

- **ห้ามขยาย `app.py`** เกิน wiring lines — logic ทั้งหมดอยู่ใน `knowledge_base.py`/`units.py`/`product_store.py`/scripts
- **ห้ามลบ collection `knowledge_base` เก่า** — เก็บเป็น rollback จนกว่า test ผ่าน + user สั่งลบ
- **product DB (dbWallet) read-only** — เขียนได้เฉพาะ admin DB (kb_*, sellable_units, image_texts)
- **rule 8** — เขียน `getoutofmywaybotkaikrook.md` ก่อน/หลังทำ
- **rule 1** — อัปเดต `docs/SRS_SSD.md` ทุกฟังก์ชันที่เพิ่ม/แก้
- QA context ต้อง label ชัดว่า "เฉพาะรุ่น X" vs "คำแนะนำทั่วไป" — ห้ามให้ LLM เห็นคำแนะนำรุ่นอื่นโดยไม่มี label
- Kill switch: `USE_QA_KB=0` ปิด QA path ทั้งหมด

---

### Task 0: Waythrough log + baseline

**Files:**
- Modify: `getoutofmywaybotkaikrook.md`

- [ ] **Step 1:** เขียนใน "กำลังจะทำ" — KB repoint + QA retrieval + warranty per-product + banner warranty join
- [ ] **Step 2:** บันทึก baseline: `curl` คำถาม "นาฬิกาแบตลดไวครับ" ไปที่ port 8015 → เก็บคำตอบเดิมไว้เทียบ

### Task 1: Repoint KB collections (knowledge_base → kb_products/kb_qa)

**Files:**
- Modify: `chatbot/shopeechat/knowledge_base.py` (`_kb_coll` area ~119, `_search_kb_single` ~415-501, `get_general_faq` ~504)

**Interfaces:**
- Produces: `_kb_products_coll() -> Collection`, `_kb_qa_coll() -> Collection` — ใช้ใน Task 3

**Verified facts (เก็บไว้ในโค้ดเป็น comment):**
- `kb_products` shape = old `knowledge_base` **ยกเว้น** ไม่มี `specs` — มี `canonical_specs` + `specs_raw` แทน → ต้อง alias
- `kb_qa` มี `general_faq` doc "รับประกัน" 982 chars (content เดียวกับตัวเก่า — verify แล้ว)
- `kb_products`/`kb_qa` มี `active` field เหมือนเดิม → query `{"active": {"$ne": False}}` ใช้ได้

- [ ] **Step 1: เพิ่ม collection helpers**

```python
def _admin_db():
    db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
    return _build_admin_client()[db_name]

def _kb_coll():
    """legacy knowledge_base — เก็บไว้เป็น fallback (rollback) ระหว่าง migration."""
    coll_name = os.environ.get("ADMIN_MONGO_COLLECTION_KB", "knowledge_base").strip()
    return _admin_db()[coll_name]

def _kb_products_coll():
    coll = os.environ.get("ADMIN_MONGO_COLLECTION_KB_PRODUCTS", "kb_products").strip()
    return _admin_db()[coll]

def _kb_qa_coll():
    coll = os.environ.get("ADMIN_MONGO_COLLECTION_KB_QA", "kb_qa").strip()
    return _admin_db()[coll]
```

- [ ] **Step 2: `_search_kb_single` เปลี่ยน `coll = _kb_coll()` → `_kb_products_coll()`** และหลัง fetch field เต็ม เพิ่ม alias:

```python
for doc in results:
    # kb_products ใช้ canonical_specs/specs_raw — alias กลับเป็น specs ให้ format_kb_context
    if not doc.get("specs"):
        doc["specs"] = doc.get("canonical_specs") or doc.get("specs_raw") or {}
    doc["_match_score"] = score_map.get(doc["_id"], 0)
```

(เพิ่ม `"canonical_specs": 1, "specs_raw": 1` ใน projection ด้วย)

- [ ] **Step 3: `get_general_faq` → อ่าน `kb_qa` ก่อน, fallback legacy**

```python
def get_general_faq(topic: str = "รับประกัน") -> dict[str, Any] | None:
    """ดึง general_faq ตาม topic — kb_qa ก่อน, legacy knowledge_base fallback."""
    q = {"type": "general_faq", "topic": topic, "active": {"$ne": False}}
    return _kb_qa_coll().find_one(q) or _kb_coll().find_one(q)
```

- [ ] **Step 4: Test** — `testscript/test_kb_repoint.py`: `search_kb_by_model("IMILAB EC4")` ต้องได้ doc ที่มี specs ไม่ว่าง + `get_general_faq("รับประกัน")` ได้ answer ยาว ~982 chars

### Task 2: QA embeddings — `build_embeddings.py --qa`

**Files:**
- Modify: `chatbot/shopeechat/scripts/build_embeddings.py` (เพิ่ม `--qa` flag ตาม pattern `--units` ที่มีอยู่ ~line 46-58)

**Interfaces:**
- Produces: `exports/qa_embeddings.npz` keys: `qa_ids` (str ObjectId), `embeddings` (N×dim float32), `topics` (N str)

- [ ] **Step 1: เพิ่ม flag + block**

```python
ap.add_argument("--qa", action="store_true",
                help="embed kb_qa 'topic | q' จาก Mongo → qa_embeddings.npz")
...
if args.qa:
    from chatbot.shopeechat import knowledge_base as _kb
    docs = list(_kb._kb_qa_coll().find({"type": "qa", "active": {"$ne": False}},
                                       {"q": 1, "topic": 1}))
    texts = [f"{d.get('topic') or ''} | {d.get('q') or ''}".strip(" |") for d in docs]
    emb = embed_texts(texts)  # ใช้ helper เดียวกับ --units ในไฟล์นี้
    np.savez(ROOT / "exports" / "qa_embeddings.npz",
             qa_ids=[str(d["_id"]) for d in docs],
             topics=[d.get("topic") or "" for d in docs],
             embeddings=emb)
```

(อ่านชื่อฟังก์ชัน embed จริงในไฟล์ก่อน — ใช้ตัวเดียวกับ `--units` block)

- [ ] **Step 2: รัน** → ได้ ~392 vectors, ขนาดไฟล์เล็ก (ฟรี — local model)

### Task 3: `search_qa` + `qa_context` (model-aware hybrid QA retrieval)

**Files:**
- Modify: `chatbot/shopeechat/knowledge_base.py` (ต่อท้ายไฟล์ — section ใหม่ "QA retrieval")

**Interfaces:**
- Consumes: `_kb_qa_coll()` (Task 1), `exports/qa_embeddings.npz` (Task 2), `embedding.embed_query`, `route_context.resolve_route`, `conversation_products.get_active_card`
- Produces: `qa_context(message: str, conversation_id=None, claim: bool=False) -> str` — app.py เรียกตัวนี้ตัวเดียว

- [ ] **Step 1: doc + vector caches**

```python
_QA_VEC_PATH = Path(__file__).resolve().parent.parent.parent / "exports" / "qa_embeddings.npz"
_qa_docs_cache: list[dict] | None = None
_qa_vec_cache: dict | None = None

def _qa_docs() -> list[dict]:
    global _qa_docs_cache
    if _qa_docs_cache is None:
        _qa_docs_cache = list(_kb_qa_coll().find(
            {"type": "qa", "active": {"$ne": False}},
            {"q": 1, "a": 1, "topic": 1, "model_codes": 1, "item_ids": 1}))
    return _qa_docs_cache

def _qa_vectors() -> dict | None:
    global _qa_vec_cache
    if _qa_vec_cache is None:
        try:
            z = np.load(_QA_VEC_PATH, allow_pickle=True)
            _qa_vec_cache = {"ids": z["qa_ids"], "emb": z["embeddings"]}
        except Exception:
            _qa_vec_cache = {}
    return _qa_vec_cache or None
```

(`import numpy as np` เพิ่มด้านบนไฟล์)

- [ ] **Step 2: `search_qa` — hybrid scoring**

```python
_QA_MIN_SCORE = 0.45   # cosine sim floor — tune จาก test
_QA_TRIGGER_KWS = (    # recall gate — คำบอกใบ้ว่าเป็นปัญหา/how-to (ไม่ใช่คำตอบ)
    "วิธี", "ตั้งค่า", "ติดตั้ง", "รีเซ็ต", "reset", "ใช้งาน", "เชื่อมต่อ",
    "ชาร์จไม่", "ไม่ชาร์จ", "ไม่ทำงาน", "ใช้ไม่ได้", "ไม่ติด", "ค้าง",
    "เสีย", "พัง", "เสียงไม่", "จอไม่", "เปิดไม่", "ปิดเอง", "ดับ",
    "หมดเร็ว", "ลดไว", "ลดเร็ว", "ไม่ขึ้น", "ไม่ได้",
)

def search_qa(message: str, *, model_codes: set[str] | None = None,
              anchor_item_id: str | None = None, limit: int = 3) -> list[dict]:
    """ค้น kb_qa — hybrid: embedding sim + substring + model/item anchor boost.

    Model rules (กันข้ามรุ่น):
    - doc ที่มี model_codes แต่ไม่ intersect known_codes → exclude เมื่อรู้รุ่น
    - doc ไม่มี model_codes → topic-level, ใช้ได้ทุกรุ่น (label 'generic')
    """
    docs = _qa_docs()
    if not docs:
        return []
    qv = _qa_vectors()
    sim_of: dict[str, float] = {}
    if qv is not None:
        try:
            from . import embedding as _emb
            q = _emb.embed_query(message)
            sims = qv["emb"] @ q
            sim_of = {str(qv["ids"][i]): float(sims[i]) for i in range(len(sims))}
        except Exception:
            pass
    known = {c.upper() for c in (model_codes or set())}
    out = []
    for d in docs:
        did = str(d["_id"])
        score = sim_of.get(did, 0.0)
        dcodes = {str(c).upper() for c in (d.get("model_codes") or [])}
        diids = {str(i) for i in (d.get("item_ids") or [])}
        # substring bonus — ถ้า q (หรือส่วนสำคัญ) ปรากฏใน message ตรงๆ
        qtext = (d.get("q") or "")
        if qtext and len(qtext) >= 8 and qtext.lower() in message.lower():
            score += 0.4
        level = "generic"
        if known and dcodes:
            if dcodes & known:
                score += 0.5; level = "model"
            else:
                continue   # คำแนะนำผูกรุ่นอื่น — ห้ามใช้
        if anchor_item_id and str(anchor_item_id) in diids:
            score += 0.4; level = "item"
        if score >= _QA_MIN_SCORE:
            d["_qa_score"], d["_qa_level"] = score, level
            out.append(d)
    out.sort(key=lambda x: -x["_qa_score"])
    return out[:limit]
```

- [ ] **Step 3: `qa_context` — entry ที่ app.py เรียก**

```python
def qa_context(message: str, *, conversation_id=None, claim: bool = False) -> str:
    """คืน context block '=== คำแนะนำจากฐานความรู้ ===' หรือ '' ถ้าไม่เกี่ยว/ไม่มี hit.

    เรียกเฉพาะเมื่อ message มีสัญญาณปัญหา/how-to หรือ claim=True
    anchor ดึงจาก conversation timeline (item_id → model_codes ผ่าน sellable_units)
    """
    if os.environ.get("USE_QA_KB", "1").strip() == "0":
        return ""
    low = message.lower()
    if not claim and not any(k in low for k in _QA_TRIGGER_KWS):
        return ""
    try:
        from . import route_context as _rc
        codes = set(_rc.resolve_route(message).model_codes)
    except Exception:
        codes = set()
    anchor_iid = None
    if conversation_id:
        try:
            from . import conversation_products as _cp
            card = _cp.get_active_card(conversation_id)
            if card:
                anchor_iid = card.get("item_id")
                for c in (card.get("model_codes") or []):
                    codes.add(str(c).upper())
        except Exception:
            pass
    hits = search_qa(message, model_codes=codes, anchor_item_id=anchor_iid)
    if not hits:
        return ""
    lines = ["=== คำแนะนำจากฐานความรู้ (QA) ==="]
    for h in hits:
        tag = {"model": f"เฉพาะรุ่น {','.join(h.get('model_codes') or [])}",
               "item": "เฉพาะสินค้าที่ลูกค้าสนใจ",
               "generic": "คำแนะนำทั่วไป (ไม่เจาะรุ่น)"}[h["_qa_level"]]
        lines.append(f"[{tag}] ถาม: {h.get('q')}\nตอบ: {h.get('a')}")
    return "\n\n".join(lines)
```

หมายเหตุ: `get_active_card` — ตรวจชื่อจริงใน conversation_products.py ตอน implement (มีฟังก์ชันคืน active card อยู่ ~line 289-298)

### Task 4: Wire เข้า 2 จุด (claim path + LLM path)

**พบระหว่าง baseline test (Task 0):** "นาฬิกาแบตลดไวครับ" → `source=warranty_claim_first_message` — claim path **short-circuit ก่อนถึง LLM** (`warranty_flow.py` ~1754 ขอข้อมูลเคลม+handoff ทันที) → inject แค่ `_combined_extra` ไม่มีผลกับเคสที่อยากแก้ที่สุด ต้อง wire 2 จุด:

**Files:**
- Modify: `chatbot/shopeechat/warranty_flow.py` (~1757, ใน `_claim_first_answer` assembly)
- Modify: `chatbot/shopeechat/app.py` (~4188)

- [ ] **Step 1 (customer-facing, claim path):** ก่อน return claim-first answer — prepend คำแนะนำเบื้องต้นจาก search_qa (`a` field เป็น customer-facing อยู่แล้ว เพราะแอดมินเขียนเป็นคำตอบ):

```python
        _qa_hits = []
        try:
            from . import knowledge_base as _kbmod
            _qa_hits = _kbmod.search_qa(req.message)  # gate อยู่ข้างใน (claim=True path ไม่ต้อง trigger kw)
        except Exception:
            pass
        if _qa_hits:
            tips = "\n".join(f"• {h.get('a','').strip()}" for h in _qa_hits[:2] if h.get("a"))
            if tips:
                _claim_first_answer = f"เบื้องต้นลองทำตามนี้ก่อนนะคะ:\n{tips}\n\n" + _claim_first_answer
```

(claim path มาถึงจุดนี้เสมอแปลว่าเป็น problem report → เรียก search_qa ตรงๆ ไม่ผ่าน trigger gate)

- [ ] **Step 2 (LLM path — how-to/ปัญหาที่ไม่ใช่ claim):** ก่อน `_combined_extra = ...` (line ~4188):

```python
        _qa_ctx = knowledge_base.qa_context(
            req.message,
            conversation_id=getattr(req, "conversation_id", None),
            claim=_is_claim_request,
        )
        if _qa_ctx:
            _combined_extra = (_combined_extra + "\n\n" + _qa_ctx).strip()
```

- [ ] **Step 3:** KB path (line ~1974) — เพิ่ม `+ _qa_ctx` ใน extra_context expression ถ้า scope ถึง (ตัวแปรต้อง init ก่อน branch ที่ ~1625 หรือประกาศ `_qa_ctx = ""` ไว้ต้น)

### Task 5: `warranty` บน unit card — reuse `warranty.extract_warranty_from_name` ที่มีอยู่แล้ว

**พบระหว่างรีวิว:** legacy path (`product_store._warranty_info`) มี name-parser อยู่แล้วที่ `warranty.py:66` — handle false positive ครบ (70mai/CS50M/1.5M/EVLM7M → None, verified จริง) แต่ `to_unit_card` hardcode `warranty=None` → **unit path ถอยหลังจาก legacy** ต้องซ่อม ไม่ต้องเขียน parser ใหม่

**Files:**
- Modify: `chatbot/shopeechat/units.py` (`to_unit_card` ~196)

**Interfaces:**
- Consumes: `warranty.extract_warranty_from_name(name) -> {months,raw,text,source}|None`
- Produces: card["warranty"] = "2 ปี" / "6 เดือน" / None

- [ ] **Step 1: ใส่ใน `to_unit_card`** (unit doc ไม่มี attribute_list → เรียก name-parse ตรงๆ)

```python
        from . import warranty as _w
        _winfo = _w.extract_warranty_from_name(unit.get("item_name") or unit.get("display_name") or "")
        ...
        "warranty": _winfo["text"] if _winfo else None,
```

- [ ] **Step 2: ทำไม่ต้อง audit ใหม่** — parser เดิมผ่านเคสหลอกทั้งหมดแล้ว (verified ด้วย run จริง: CS50M/70mai/1.5M/T11M/EVLM7M ทั้งหมด → None)

### Task 6: warranty_text จากรูป banner

**Files:**
- Modify: `chatbot/shopeechat/units.py` (`attach_image_texts` ~264-284, `to_unit_card` ~206)

- [ ] **Step 1:** ใน `attach_image_texts` เพิ่ม query ที่ 2:

```python
        # warranty banner — kind=banner ที่ text มีเงื่อนไขประกัน → warranty_text ต่อ unit
        war_of = {d["image_id"]: d.get("text") for d in coll.find(
            {"image_id": {"$in": iids}, "kind": "banner",
             "text": {"$regex": "เงื่อนไขการรับประกัน|รับประกัน|เคลม"}},
            {"image_id": 1, "text": 1})}
        for u in unit_docs:
            wp = [war_of[i] for i in (u.get("image_ids") or []) if war_of.get(i)]
            if wp:
                u["warranty_text"] = "\n".join(dict.fromkeys(wp))[:1200]
```

- [ ] **Step 2:** `to_unit_card` — append เข้า `description_excerpt`:

```python
        desc = pick_desc_sections(unit, route) or (unit.get("image_text") or "")[:3000]
        if unit.get("warranty_text"):
            desc = (desc + "\n\nเงื่อนไขการรับประกัน (จากรูปสินค้า):\n" + unit["warranty_text"]).strip()
        "description_excerpt": desc[:3200],
```

### Task 7: Tests + verify

**Files:**
- Create: `chatbot/testscript/test_qa_kb.py`

- [ ] **Step 1: unit-level tests (เรียกฟังก์ชันตรง, ไม่ผ่าน HTTP)**

```python
# repoint
assert knowledge_base.get_general_faq("รับประกัน")["answer"]
assert knowledge_base.search_kb_by_model("IMILAB EC4")  # specs ไม่ว่าง
# QA model-aware
hits = knowledge_base.search_qa("LPB200NL ใช้กับ S26 ได้ไหม", model_codes={"LPB200NL"})
assert hits and hits[0]["_qa_level"] == "model"
hits = knowledge_base.search_qa("นาฬิกาแบตลดไวครับ")          # Kieslect generic QA
assert any("แบต" in (h.get("q") or "") for h in hits)
hits = knowledge_base.search_qa("KS3 วิธีกลับด้านหน้าจอ", model_codes={"KS3"})
assert all("LPB200NL" not in (h.get("model_codes") or []) for h in hits)  # cross-model guard
# warranty parse
assert product_store._warranty_from_name("... -2Y") == "2 ปี"
assert product_store._warranty_from_name("DEM-CS50M") == ""
assert product_store._warranty_from_name("70mai PRO") == ""
assert product_store._warranty_from_name("พร้อมสาย USB-C 1.5M") == ""
assert product_store._warranty_from_name("SanDisk ประกัน Synnex -7Y") == "7 ปี"
```

- [ ] **Step 2: HTTP smoke บน 8015** — "นาฬิกาแบตลดไวครับ" → คำตอบมีคำแนะนำจาก QA / "ประกันกี่ปี" บนสินค้า -2Y → "2 ปี"

- [ ] **Step 3:** เทียบ baseline Task 0 — คำตอบ "นาฬิกาแบตลดไว" ต้องดีขึ้น (มี steps จาก KB) ไม่ใช่ตอบมั่ว

### Task 8: Docs

- [ ] อัปเดต `docs/SRS_SSD.md` section 6 — `search_qa`, `qa_context`, `_kb_products_coll`, `_kb_qa_coll`, `_warranty_from_name`, `attach_image_texts` (warranty branch)
- [ ] `getoutofmywaybotkaikrook.md` — วิธีแก้ + ย้ายไป "ผ่านแล้ว" + เวลา

---

## Self-Review

**Spec coverage:**
- ✅ QA hit "นาฬิกาแบตลดไว" → Task 3 (embedding sim) + Task 4 (wire)
- ✅ จับตามรุ่น → Task 3 model_codes/item_id boost + cross-model exclude
- ✅ ประกันตามสินค้า/ร้าน → Task 5 (ชื่อ→warranty_period) + Task 6 (banner→warranty_text) + Task 1 (general_faq repoint ทำให้ policy กลางยังอยู่)
- ✅ ไม่รื้อ collection / rollback → Task 1 fallback + USE_QA_KB kill switch + old coll ไม่ลบ
- ⚠️ **gap ที่รู้:** warranty_text/warranty_period ทำงานเฉพาะ **unit path** (charger route ตอน flag=charger) — legacy path ยังเห็นแค่ชื่อสินค้าใน card (ซึ่งมี "2Y" อยู่แล้ว) + base warranty ต่อท้ายเหมือนเดิม — ยอมรับได้ตาม scope ที่คุย; ขยาย flag ภายหลัง

**Placeholder scan:** มี 2 จุดที่บอก "ตรวจชื่อจริงตอน implement" — `get_active_card` (conversation_products) และชื่อ embed fn ใน build_embeddings — เป็นสิ่งที่ต้องอ่านไฟล์ตอนเขียนจริง ไม่ใช่ placeholder ว่าง

**Type consistency:** `search_qa` คืน docs ที่มี `_qa_score`/`_qa_level`; `qa_context` อ่าน keys เดียวกัน; npz keys `qa_ids/topics/embeddings` ตรงกันทั้ง build และ load; `_warranty_from_name` return `str` ไม่ใช่ None (หลีกเลี่ยง None-check ทุก call site)

**Risks ที่ยอมรับ + mitigation:**
- Thai paraphrase embedding อาจ miss → mitigated: substring bonus + anchor boost + threshold tune ใน Task 7
- `_QA_MIN_SCORE=0.45` เป็นเดา → Task 7 step 3 tune จากผลจริง
- QA trigger keywords เป็น list ใหม่ → justified เพราะเป็น recall gate (กัน context noise บนคำถามสินค้าปกติ) precision อยู่ที่ scoring
- `warranty_period` regex ยังมี edge case → audit dump ใน Task 5 step 3 + card ยังมีชื่อดิบให้ LLM เห็นเอง
