# Plan: แก้ "context เต็มไปด้วยของตาย" + compare/superlative follow-up เสีย suggestions

**วันที่:** 2026-09-17
**สถานะ:** พร้อม implement — root cause verify แล้วด้วย repro จริง + 4 subagent traces
**ข้อจำกัด:** ห้ามขยาย `app.py` นอกเหนือ block เดิมที่ระบุ; fix ต้อง generalize ทุกประเภทสินค้า

---

## อาการ (หลักฐานจริง)

1. `"หัวชาร์จละ"` @KingGadgets → context 12/12 ใบเป็น st=0 / UNLIST / SELLER_DELETE — **ไม่มีของขายได้สักใบ** ทั้งที่ร้านมีหัวชาร์จ NORMAL+stock>0 อยู่ **113 ใบ** (AD1404U 140W st=7249 ฯลฯ) → LLM จำเป็นต้องแนะนำของตาย (ลิงก์ตายให้ลูกค้า)
2. `"อยากได้ของที่ใช้กับ xiaomi 17 ultra"` (มือถือ 90W) → แนะนำ Xiaomi 45W / Eloop 45W / A15C 67W (UNLIST) แทน 120-140W ที่ legacy เดิมเคยเลือกถูก
3. `"อันไหนดีกว่ากัน อันไหนใหม่กว่า"` / `"ตัวไหนออกใหม่สุด"` หลัง bot แนะนำ Run+Free → ตอบ "ระบบมีแค่ Case รุ่นเดียว" — ไม่เห็นของที่เพิ่งแนะนำ

## Root causes (verify แล้ว)

| # | จุดผิด | ที่ | ชนิด |
|---|---|---|---|
| RC1 | `fetch_units` sort `_score` อย่างเดียว — sellable tier ตาม plan เดิมไม่เคย implement | units.py:172 | design gap |
| RC2 | `_rerank_by_promo_latest` = standalone>promo>recency>sim — **ไม่มี availability tier** | product_store.py:2561 | design gap |
| RC3 | `_available_for_sale = status=="NORMAL"` ไม่เช็ก stock — `st=0` ได้ `avail=True` และ prompt สั่งให้เชื่อ flag นี้เป็นหลัก | product_store.py:622, units.py:219 | bug เดิม (pre-branch) |
| RC4 | Unit path early-return ตัด compat sweep 1,200-doc + supplement + rerank → pool หด ~20× → ของ W สูงไม่เคยเข้า context | product_store.py:2903 | branch regression |
| RC5 | Unit card ใช้ status/stock จาก build-time — `attach_listing_fields` join ไม่ดึง `item_status`/stock สด | units.py:353-357 | branch regression |
| RC6 | `fuzzy_match_products` ถูกถอด `item_status:"NORMAL"` — **review แล้ว: เจตนาถูกต้อง ไม่แก้** (fuzzy รันเฉพาะตอน MODEL-REGEX ที่ hard-filter NORMAL หาไม่เจอ = เคส "ถามของตาย" พอดี; F1 ทำ flag ถูกอยู่แล้ว) | product_store.py:725 | เจตนา |
| RC7 | Compare follow-up อ่าน **anchors เท่านั้น** ไม่เคยอ่าน suggestions + CONV-ACTIVE pin anchor เดี่ยวทำ superlative fetch unreachable + conv_note สั่ง LLM ignore ของที่ bot แนะนำ | app.py:1262, 2431, 3362 | gap เดิม (machinery ออกแบบมาเฉพาะ 2-anchor) |
| RC8 (external) | Catalog เสื่อม — KingGadgets purge charger ไป ~40% ของ matches — legacy run เก่าเกิดก่อน purge | DB state | สภาพแวดล้อม — ไม่แก้โค้ด |

## หลักการ fix (ponytail — shortest correct diff)

- **ของตายต้องอยู่ใน context ได้** (ตอบ "มี X ไหม/หมดไหม" ได้) แต่**ต้องไม่ชนะของขายได้ใน ranking** — แก้ที่ ordering ไม่ใช่ hard filter
- **Exact/code match ต้องชนะเสมอ** — "HA835 มีไหม" ต้องเห็น HA835 แม้ตาย
- `_available_for_sale` แก้ที่ source เดียว — ไม่ไล่ patch callsite
- compat ใช้ machinery legacy เดิม — ไม่เขียน overfetch ใหม่ใน units

---

## Implementation

### F1 — `_available_for_sale` ถูกที่ source (ทั้ง 2 จุด)

`product_store.py:622` และ `units.py:219`:

```python
# เดิม
"_available_for_sale": doc.get("item_status") == "NORMAL",
# ใหม่ (คำนวณหลัง total_stock/sold_out ใน card dict เดียวกัน)
"_available_for_sale": (
    doc.get("item_status") == "NORMAL"
    and total_stock > 0
    and not sold_out
),
```

- `total_stock`/`sold_out` คำนวณอยู่แล้วใน function เดียวกัน — แค่ย้ายลำดับ
- `app.py:4024` recompute กลายเป็น no-op (คงไว้ — idempotent, zero-risk)
- **ครอบคลุม:** item_tag / KB-merge / web-search / unit / timeline-restore / chat_v2 — ทุก path พร้อมกัน

### F2 — sellable tier ใน ranking (2 จุด)

**F2a** `_rerank_by_promo_latest` (product_store.py:2561) — sort key เพิ่ม tier แรก:

```python
def sort_key(d):
    sellable = d.get("item_status") == "NORMAL" and _doc_has_stock(d)
    return (sellable, is_standalone, has_promo, recency, sim)
```

- `_doc_has_stock(d)` — helper เล็ก reuse `_shopee_stock` (มีอยู่แล้ว product_store.py:548): `sum stock ของ model[] or stock_info_v2.summary`
- ผล: ของขายได้ขึ้นก่อนเสมอ; ของตายยังอยู่ใน context (ตอบคำถามได้) แต่ไม่ชนะ
- exact-match `insert(0)` ที่ app.py:1828 / MODEL-REGEX paths **ไม่แตะ** — specific-item query ยัง pin ถูก

**F2b** `fetch_units` (units.py:172) — sort key ใหม่:

```python
# เดิม: key=-u["_score"]
# ใหม่: code-hit ชนะเสมอ → sellable (build-time) → score
ranked = sorted(hits.values(),
    key=lambda u: (u.get("_matched_by") == "code", bool(u.get("sellable")), u["_score"]),
    reverse=True)[:limit]
```

**⚠️ review I1 — `sellable` บน unit doc เป็น build-time snapshot** และ sort นี้เกิดก่อน `attach_listing_fields` → ของที่ตายหลัง build ยังชนะ tier แล้วกิน slot → เพิ่ม **live re-sort หลัง join** ใน `fetch_unit_cards`:

```python
# fetch_unit_cards: overfetch → join → live re-sort → cut
us = fetch_units(message, route=route, limit=limit*2, **kwargs)   # overfetch
us = attach_listing_fields(attach_image_texts(attach_kb_specs(us)))
us.sort(key=lambda u: (u.get("_matched_by")=="code", _live_sellable(u), u["_score"]), reverse=True)
us = us[:limit]
```

`_live_sellable(u)` = helper เดียวกับ F3 (อ่าน `_listing` สด; fallback `u.sellable`) — ทำให้ listing ที่ตายหลัง build ถูกดีดออกจาก top ทันที

### F3 — live availability ใน unit path (แก้ตาม review C2/I5)

`units.py:353-357` — projection ของ `attach_listing_fields` เพิ่ม:
`"item_status": 1, "stock_info_v2": 1, "model.model_id": 1, "model.model_status": 1, "model.stock_info_v2": 1`
(doc-level `stock_info_v2` จำเป็นสำหรับ solo unit ที่ `model_id=None`)

`to_unit_card` (units.py:209-219): helper `_live_availability(unit)` → `(status, stock, model_status)`:

- `lst` ไม่มี → fallback snapshot เดิม (`unit.item_status`, `unit.stock`, `unit.model_status`)
- `model_id` มี → หา model ตรง `model_id` ใน `lst["model"]` → stock จาก `_shopee_stock(m)`, status เช็ก `model_status` ด้วย
- `model_id=None` (solo) → `_shopee_stock(lst)` doc-level

**ต้องเขียนค่าสดลงทุก field** (ไม่ใช่แค่ `_available_for_sale` — app.py:4024 recompute flag จาก `status`/`total_stock`/`sold_out` จะเขียนทับค่าสดถ้า field พวกนั้นยัง stale):
`"status"`, `"total_stock"`, `"sold_out"`, `"_available_for_sale"`, `"variants[0].stock"`, `"model_status"`

### F4 — unit gate ข้าม compat query (แก้ตาม review C1)

**`RouteContext` ไม่มี compat field** — compat เป็น intent-based: `app.py:3366` `_is_compat = _intent_result["intent"]=="compatibility_check"` ส่งเข้า `fetch_products(..., is_compat_check=...)` (param มีอยู่แล้ว product_store.py:2845)

**แต่ query จริงที่รายงาน** `"อยากได้ของที่ใช้กับ xiaomi 17 ultra"` ถูก classify เป็น `product_recommend` + `target_device` ไม่ใช่ `compatibility_check` → ต้องครอบทั้งสอง:

1. `app.py:3513` — ส่ง `is_compat_check=_is_compat or bool(_intent_result.get("target_device"))` (device-compat ก็คือ compat เชิง semantic — ได้ compat sweep `max(limit*20,500)` ที่ product_store.py:3138 ด้วย = pool กลับมาเต็ม)
   - ⚠️ implement ต้องเช็ก usage ทั้งหมดของ `is_compat_check` ใน fetch_products ว่า widening นี้ไม่กระทบ filter อื่น
2. `product_store.py` ที่ unit gate (~2881) — `if is_compat_check: _uif = ""` (param อยู่ใน scope แล้ว; ครอบ `USE_UNIT_INDEX=charger` และ `=1` mode)

- ผล: compat/device-compat ได้ legacy sweep เต็มกลับมา; model/subtype query ยังได้ unit precision

### F5 — compare/superlative เห็น suggestions (app.py — block เดิมเท่านั้น)

**F5a** `app.py:~1276` fallback — เมื่อ `_fc_anchors < 2` (แก้ตาม review C3):

- `get_anchor_and_suggestions` **ใช้ไม่ได้** — คืน stripped cards ไม่มี `is_anchor`/`mentioned_at`
- ใช้ `load_timeline(conv_id)` raw entries → filter `not p.get("is_anchor")` → หยิบ **trailing run ของ suggestions** (entries ท้าย list ติดกันที่ is_anchor=False — `_record_suggestion_products` append ทีละ batch ต่อเทิร์น app.py:4551-4566) → ถ้า ≥2 ใบ → ตั้ง `_anchor_compare_ctx {"current": tail[-1].card, "previous": tail[-2].card}`
- Fallback เดิม (model-keyword rewrite) เป็น last resort

**F5b** `app.py:~2419` CONV-ACTIVE guard — ถ้า `_is_comparison_followup` หรือ `_is_superlative_q` **และ** timeline มี ≥2 candidates → อย่า pin `_ref_regex_products=[active]` เดี่ยว (ทั้งสอง flag นิยามก่อน 2419 แล้ว — review verify แล้ว; conv-note "ignore suggestions" อยู่ใน `if _ref_regex_products` จะไม่ fire เองเมื่อ unpin — RC7 ส่วน 3 ไม่ต้องแก้เพิ่ม)

**F5c** keyword — **ระวัง review I3**: `_comparison_followup_kw` ถูก reuse ที่ 1389 (`_is_partial_comp`) และ `_is_comparison_followup` ถูกนิยามซ้ำที่ 3909 ด้วย tuple คนละชุด → เพิ่ม keyword เฉพาะจุดที่ต้องการ หรือ sync ทั้ง 3 จุด — ตัดสินตอน implement โดยดูผลกระทบจริง

**F5d** fix fallback ordering: `_qa10` เรียงเก่า→ใหม่ ทำให้ `[:3]` ตัดของล่าสุดทิ้ง — ดึง model tokens จาก **คำตอบล่าสุดก่อน** (reversed) — เฉพาะใน block นี้

### F6 (option — แยก decision, ไม่รวมใน fix นี้)

`BAAI/bge-reranker-v2-m3` via `sentence_transformers.CrossEncoder` (installed แล้ว, ฟรี, local):
- ~50 บรรทัด: lazy singleton (pattern `_get_model` เดิม) + `rerank(query, docs)` → score → ใช้เรียง **ภายใน** sellable tier หลัง F2
- หลัง env flag `USE_NEURAL_RERANK` เท่านั้น — ไม่ใช่ส่วนของ root cause fix
- `voyageai/rerank-2.5-lite` ผ่าน OpenRouter: เช็กก่อนว่า OpenRouter proxy rerank endpoint ไหม — ถ้าไม่ต้อง Voyage key แยก → เสีย cost/dep — เลือก bge

---

## Verify plan (quota-free)

1. `python -m py_compile` ทุกไฟล์ที่แก้
2. **Probe retrieval** (script เดิมที่ใช้ repro): `"หัวชาร์จละ"` @KingGadgets flag on+off → ต้องมี sellable ≥1 ใน top-12 และของตายไม่ครอง top
3. `"HA835 มีไหม"` → HA835 ยังอยู่ top-3 (code-hit protection ทำงาน)
4. `"อยากได้ของที่ใช้กับ xiaomi 17 ultra"` flag=charger → compat ไม่เข้า unit path (เช็ก log `[UNITS]` ไม่ขึ้น / context มี 120-140W)
5. `docs/test/test_units.py`, `test_car_charger_regression.py`, `test_unit_classifier.py`, `test_all_conditions.py` — ผ่านเหมือนเดิม
6. F5: จำลอง timeline doc (Case anchor + Run/Free suggestion) → เรียก path compare → context ต้องมี Run+Free

## Rollout

- F1-F4 แยก commit เดียว (retrieval layer) → probe verify → restart :8010/:8015
- F5 commit แยก (app.py) → replay verify
- ถ้า probe fail → revert commit, ไม่ deploy
- `USE_UNIT_INDEX` ยัง `charger` ต่อได้ — F4 ทำให้ compat ไม่เสี่ยง

## ไม่ทำใน plan นี้

- Hard filter `item_status` ตอน query (ทำลาย "ตอบของลบได้")
- Token cap/context trim (งานแยก — ปัจจุบัน 28-41k tokens)
- chat_v2 broken calls (`get_timeline`/`add_item_anchor` ไม่มีจริง) — นอก scope legacy
- subtype hardcode ย้ายเข้า data (ทำตอน type ที่ 2 ต้องการ — YAGNI ตอนนี้)
- Neural reranker (F6 — แยก decision หลังเห็นผล F1-F4)
