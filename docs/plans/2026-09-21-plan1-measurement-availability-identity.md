# Plan 1 — Measurement, Availability, Identity Implementation Plan (rev 1.2)

> **สำหรับผู้ลงมือ:** ทำทีละ task ตามลำดับ แต่ละ task จบด้วย commit ที่รันเทสผ่านแล้ว
> ห้ามข้ามขั้น "รันเทสให้ fail ก่อน" — มันคือสิ่งที่พิสูจน์ว่าเทสวัดของจริง

**Goal:** วางไม้บรรทัดที่วัดคุณภาพ retrieval ได้โดยไม่เรียก LLM, ทำให้สถานะสินค้ามีเจ้าของเดียวจริง (รวม `app.py`), และหยุดอาการ listing เดียวครองผลลัพธ์ (วัดได้ 49%)

**Architecture:** ไม่สร้าง module ใหม่ — เพิ่มฟังก์ชันใน `product_store.py` (เจ้าของ availability), `units.py` (จุดที่ variant ซ้ำเกิด) และ *แทนที่* สูตรซ้ำใน `app.py` ด้วยการเรียก resolver เดียวกัน เครื่องมือวัดเป็นสคริปต์ offline ใน `docs/test/` ที่อ่านไฟล์ผลลัพธ์ที่มีอยู่ ไม่ต่อ Mongo ไม่ใช้ quota

**Tech Stack:** Python 3 (stdlib เท่านั้นสำหรับเครื่องมือวัด), เทสเป็นสคริปต์ `main()` + `assert` ตามแบบ `docs/test/test_units.py`

**Spec:** `docs/plans/2026-09-21-retrieval-hybrid-rerank-plan.md` + ข้อสรุปสถาปัตยกรรม v4 ในแชท 2026-09-21

## เปลี่ยนอะไรจาก rev 1.0 (ตาม review ของเจ้าของงาน)

| # | ประเด็น | การแก้ |
|---|---|---|
| 1 | evaluator ไม่ได้ใช้ gold fields ให้ครบ | Task 1 เพิ่ม `acceptable_hit_rate`, `must_not_violation_rate`, `status_accuracy`, `answer_mode_accuracy`; `type_purity` นับเฉพาะ intent ที่ต้องการสินค้า |
| 2 | `app.py:4189-4193` คำนวณ availability เป็นสูตรที่สาม | Task 4 เพิ่มขั้นแทนสูตรนั้นด้วย `resolve_availability()` + สแกน callsite ทั้งหมด |
| 3 | ห้ามเหมา model_status ที่ไม่รู้จักเป็น `unlisted` | **วัดค่าจริงแล้ว: ทั้ง catalog มี `MODEL_NORMAL` ค่าเดียว (27,774)** → ค่าที่ไม่รู้จัก = `unknown` + log ครั้งเดียว ไม่เขียน mapping สำหรับค่าที่ไม่เคยพบ (เดาน้อยที่สุด) |
| 4 | `sellable` snapshot ยังถูกใช้เป็น retrieval filter | เพิ่มหัวข้อ **Known limitations** ระบุชัดว่า Plan 1 ไม่แตะ `units.py` `base_q["sellable"]` / `_sellable_mask()` |
| 5 | `per_listing=1` เป็น global rule ไม่ได้ | Task 5 ทำเป็นพารามิเตอร์ที่ caller ส่ง + code-hit ยกเว้น + gold เพิ่มเคส variant question เพื่อจับ regression (policy เต็มตาม intent ไปอยู่ Plan 5) |
| 6 | เกณฑ์ผ่านต้องแยกตาม intent | Task 6 แยกเกณฑ์ตาม intent, ไม่ใช้ค่ารวม |
| 7 | `_doc_sellable` เปลี่ยน `any()`→`max()` | คงแนวคิดเดิม (`any`) + เพิ่มเทส multi-model / stock ชนิดแปลก |
| 8 | field ใหม่ต้องไม่หลุดเข้า LLM | Task 4 เพิ่มเทสยืนยันว่า `catalog_status` ไม่อยู่ใน context |

### rev 1.2 (review รอบ 2)

| # | ประเด็น | การแก้ |
|---|---|---|
| 9 | เคสที่คำตอบถูกคือ "ไม่มีสินค้า" ไม่ควรถูกนับ `adequacy_at_1` | `gold_metrics` ข้าม `adequacy_at_1` เมื่อ `expected_answer_mode ∈ {no_such_type, no_info}` + `validate_gold` ถือว่าการใส่ `min_output_power_w` คู่กับ mode เหล่านั้นเป็น gold ที่ขัดแย้งกันเอง |
| 10 | `app.py` ห้ามส่ง `stock=0` เพราะ `sold_out=True` (flag อาจ stale) | ใช้ `status + total_stock` ดิบเป็นหลัก แล้วนับกรณีที่ `sold_out` ขัดกับผล resolver เป็น warning log + ตัวเลข (`sold_out_conflict`) — ตรวจแล้วว่า `sold_out` ถูก derive จาก stock ทุกจุดที่สร้าง card (`product_store.py:638`, `units.py:289`) จุดเดียวที่อาจ stale คือ card ที่ restore จาก timeline (`conversation_products.py:244`) ซึ่ง `total_stock` stale ไปพร้อมกันอยู่แล้ว → ความเสี่ยงต่ำ และการ log ทำให้เห็นถ้าเกิดจริง |

## Global Constraints

- **ห้ามเพิ่ม logic ใหม่ใน `app.py`** — Task 4 แก้ `app.py` ได้เฉพาะการ *แทนสูตรซ้ำด้วยการเรียก resolver* (โค้ดลดลง ไม่มี behavior ใหม่)
- **ห้ามเปลี่ยน prompt/policy ใดๆ ใน Plan 1** — `_notes` / prompt rule ที่ `app.py:4204-4234` คงเดิมทุกตัวอักษร
- v2/v3 พังได้ ไม่ต้อง verify (ผู้ใช้อนุมัติ 2026-09-21) — Plan 1 ไม่ได้ลบอะไรที่ v2/v3 ใช้
- ห้ามอ่าน `.env` โดยตรง — ใช้ `load_dotenv(ROOT/".env")` ในสคริปต์เท่านั้น
- ทุก task: `python -m py_compile` ไฟล์ที่แก้ก่อน commit
- ทุก task ที่แตะฟังก์ชันใน `chatbot/shopeechat/`: อัปเดต `docs/SRS_SSD.md` section 6 (AGENTS.md ข้อ 1) และ `getoutofmywaybotkaikrook2.md` (ข้อ 8)
- เทสรันด้วย `.venv/bin/python docs/test/<file>.py`
- **ห้ามอ้างว่า compat ดีขึ้นใน Plan 1** — Plan 1 ไม่แตะ spec/wattage

## Known limitations ของ Plan 1 (ต้องเขียนลง waythrough ด้วย)

1. **retrieval ยังใช้ `sellable` snapshot** — `units.py` `base_q["sellable"] = True` (บรรทัด 138-139) และ `_sellable_mask()` (บรรทัด 74-79) อ่าน field build-time อยู่ → availability มีเจ้าของเดียวเฉพาะชั้น card/eligibility ยังไม่ใช่ชั้น candidate (แก้ใน Plan 4)
2. **per-listing policy ยังไม่ผูกกับ intent เต็มรูปแบบ** — Plan 1 ให้ caller ส่งค่าได้ แต่ยังไม่มีตัวจำแนก "คำถาม variant/compare" ที่เชื่อถือได้ (ไปกับ ranking profile ใน Plan 5)
3. **`answer_mode_accuracy` เป็น heuristic ระดับข้อความ** — ใช้ pattern ที่ประกาศชัดในโค้ด ไม่ใช่ความจริงสัมบูรณ์ รายงานแยกจาก retrieval metric เสมอ
4. **compat/wattage ไม่ถูกแตะ** — `_extract_max_wattage` ยัง fallback อ่านชื่อสินค้า (แก้ใน Plan 3)

---

## File Structure

| ไฟล์ | สถานะ | ความรับผิดชอบ |
|---|---|---|
| `docs/test/eval_retrieval.py` | สร้างใหม่ | metric จากไฟล์ผลลัพธ์ (offline, stdlib) |
| `docs/test/test_eval_retrieval.py` | สร้างใหม่ | เทสของเครื่องมือวัด |
| `docs/test/gold_retrieval.jsonl` | สร้างใหม่ | gold set ที่คนติดป้าย |
| `docs/test/test_availability.py` | สร้างใหม่ | เทส resolver |
| `docs/test/test_availability_wiring.py` | สร้างใหม่ | เทสว่าทุก callsite ใช้ resolver + field ใหม่ไม่หลุดเข้า LLM |
| `docs/test/test_listing_diversity.py` | สร้างใหม่ | เทส per-listing cap |
| `chatbot/shopeechat/product_store.py` | แก้ | `resolve_availability()` + `_doc_sellable`/`to_product_card` เรียกใช้ |
| `chatbot/shopeechat/units.py` | แก้ | `_live_sellable`/`to_unit_card` เรียกใช้; `_cap_per_listing()` |
| `chatbot/shopeechat/app.py` | แก้ (ลบสูตรซ้ำเท่านั้น) | `:4189-4193` เรียก resolver แทนสูตรที่สาม |
| `docs/SRS_SSD.md`, `getoutofmywaybotkaikrook2.md` | แก้ | เอกสารตามกฎ repo |

---

## Task 1: เครื่องมือวัด retrieval (offline)

**Files:**
- Create: `docs/test/eval_retrieval.py`
- Create: `docs/test/test_eval_retrieval.py`

**Interfaces:**
- Produces:
  - `load_results(path: str) -> list[dict]`
  - `pool_metrics(recs: list[dict]) -> dict` → `{"n","n_with_products","listing_diversity","dup_pool_rate","live_ratio_top5","unit_share","fallback_rate","avg_pool"}`
  - `gold_metrics(recs: list[dict], gold: list[dict]) -> dict` → `{"n_gold","type_purity","acceptable_hit_rate","must_not_violation_rate","status_accuracy","adequacy_at_1","answer_mode_accuracy"}`
  - `classify_answer_mode(answer: str) -> str`
  - `validate_gold(gold: list[dict]) -> list[str]` (เพิ่มใน Task 2)
- Consumes: ไฟล์ผลจาก `docs/test/unit_index_regression.py` (key: `id`,`topic`,`shop`,`answer`,`products[]`,`unit_path`,`unit_attempted`)

- [ ] **Step 1: เขียนเทสที่ยัง fail**

สร้าง `docs/test/test_eval_retrieval.py`:

```python
"""Test eval_retrieval — เครื่องมือวัดคุณภาพ pool (offline).

รัน: .venv/bin/python docs/test/test_eval_retrieval.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "docs" / "test"))

import eval_retrieval as ev


def _write(tmp: Path, rows: list[dict]) -> str:
    p = tmp / "res.jsonl"
    p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    return str(p)


ROWS = [
    # rec a: 4 unit จาก listing 1 + 1 จาก listing 2 → unique 2/5 = 0.4, live 2/5
    {"id": "a", "topic": "browse_type", "shop": "S1", "unit_path": True,
     "unit_attempted": "attempted",
     "answer": "แนะนำรุ่นนี้เลยค่ะ ใช้งานดีมาก",
     "products": [
         {"item_id": 1, "product_type": "charger", "catalog_status": "active", "_available_for_sale": True},
         {"item_id": 1, "product_type": "charger", "catalog_status": "active", "_available_for_sale": True},
         {"item_id": 1, "product_type": "charger", "catalog_status": "out_of_stock", "_available_for_sale": False},
         {"item_id": 1, "product_type": "charger", "catalog_status": "out_of_stock", "_available_for_sale": False},
         {"item_id": 2, "product_type": "cable", "catalog_status": "unlisted", "_available_for_sale": False},
     ]},
    # rec b: คำตอบที่ถูกคือ "ไม่มี" แต่ pool มีของผิดประเภทหลุดมา → unique 2/2, live 2/2
    {"id": "b", "topic": "compat_charging", "shop": "S1", "unit_path": False,
     "unit_attempted": "fallback_dead_pool",
     "answer": "ขออภัยค่ะ ทางร้านไม่มีสินค้าประเภทนี้จำหน่ายนะคะ",
     "products": [
         {"item_id": 3, "product_type": "powerbank", "output_power_w": 65,
          "catalog_status": "active", "_available_for_sale": True},
         {"item_id": 4, "product_type": "powerbank", "catalog_status": "active",
          "_available_for_sale": True},
     ]},
    # rec c: compat จริง — top-1 65W ≥ 60 → adequacy ผ่าน; unique 2/2, live 2/2
    {"id": "c", "topic": "compat_charging", "shop": "S1", "unit_path": True,
     "unit_attempted": "attempted",
     "answer": "แนะนำรุ่นนี้เลยค่ะ",
     "products": [
         {"item_id": 5, "product_type": "powerbank", "output_power_w": 65,
          "catalog_status": "active", "_available_for_sale": True},
         {"item_id": 6, "product_type": "powerbank", "catalog_status": "active",
          "_available_for_sale": True},
     ]},
]

GOLD = [
    {"id": "a", "shop": "S1", "message": "มีหัวชาร์จไหม", "intent": "recommend",
     "expected_product_type": "charger", "expected_answer_mode": "recommend",
     "expected_catalog_status": "active",
     "acceptable_item_ids": [1], "must_not_item_ids": [2]},
    {"id": "b", "shop": "S1", "message": "มีสายชาร์จไหม",
     "intent": "compatibility", "expected_product_type": "cable",
     "expected_answer_mode": "no_such_type"},
    {"id": "c", "shop": "S1", "message": "พาวเวอร์แบงค์ชาร์จโน้ตบุ๊คได้ไหม",
     "intent": "compatibility", "expected_product_type": "powerbank",
     "expected_answer_mode": "recommend", "expected_catalog_status": "active",
     "min_output_power_w": 60},
]


def main() -> int:
    with tempfile.TemporaryDirectory() as d:
        recs = ev.load_results(_write(Path(d), ROWS))
    assert len(recs) == 3, recs

    m = ev.pool_metrics(recs)
    assert m["n"] == 3 and m["n_with_products"] == 3, m
    assert abs(m["listing_diversity"] - 0.8) < 1e-9, m       # (0.4 + 1.0 + 1.0)/3
    assert abs(m["dup_pool_rate"] - 1/3) < 1e-9, m           # เฉพาะ a มี listing ซ้ำ >= 3
    assert abs(m["live_ratio_top5"] - 0.8) < 1e-9, m         # (2/5 + 2/2 + 2/2)/3
    assert abs(m["unit_share"] - 2/3) < 1e-9, m
    assert abs(m["fallback_rate"] - 1/3) < 1e-9, m
    assert abs(m["avg_pool"] - 3.0) < 1e-9, m                # (5 + 2 + 2)/3
    print("PASS pool_metrics")

    assert ev.classify_answer_mode("ขออภัยค่ะ ทางร้านไม่มีสินค้าประเภทนี้จำหน่ายนะคะ") == "no_such_type"
    assert ev.classify_answer_mode("ไม่พบข้อมูลรุ่นนี้ในระบบค่ะ") == "no_info"
    assert ev.classify_answer_mode("รุ่นนี้หมดสต็อกชั่วคราวค่ะ") == "out_of_stock"
    assert ev.classify_answer_mode("รุ่นนี้เลิกจำหน่ายแล้วค่ะ") == "discontinued"
    assert ev.classify_answer_mode("แนะนำรุ่นนี้เลยค่ะ") == "recommend"
    print("PASS classify_answer_mode")

    g = ev.gold_metrics(recs, GOLD)
    assert g["n_gold"] == 3, g
    # type_purity: a = 4/5, c = 2/2 (b ถูกข้ามเพราะ expected_answer_mode = no_such_type)
    assert abs(g["type_purity"] - 0.9) < 1e-9, g
    assert abs(g["acceptable_hit_rate"] - 1.0) < 1e-9, g      # a เจอ item 1
    assert abs(g["must_not_violation_rate"] - 1.0) < 1e-9, g  # a มี item 2 ที่ห้าม
    assert abs(g["status_accuracy"] - 1.0) < 1e-9, g          # a: item1=active, c: top-1=active
    # adequacy: b ถูกข้าม (no_such_type — ของที่หลุดมาไม่ใช่คำตอบ), c: top-1 65W >= 60
    assert abs(g["adequacy_at_1"] - 1.0) < 1e-9, g
    assert abs(g["answer_mode_accuracy"] - 1.0) < 1e-9, g     # a/c=recommend, b=no_such_type
    print("PASS gold_metrics")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: รันให้ fail**

```bash
cd /Users/itdev4/Documents/GitHub/ChatBotProductMS
.venv/bin/python docs/test/test_eval_retrieval.py
```
คาด: `ModuleNotFoundError: No module named 'eval_retrieval'`

- [ ] **Step 3: เขียน implementation**

สร้าง `docs/test/eval_retrieval.py`:

```python
"""eval_retrieval — วัดคุณภาพ pool จากไฟล์ผลลัพธ์ (offline, ไม่เรียก LLM/Mongo).

รัน:
  .venv/bin/python docs/test/eval_retrieval.py <results.jsonl>
  .venv/bin/python docs/test/eval_retrieval.py <results.jsonl> --gold docs/test/gold_retrieval.jsonl
  .venv/bin/python docs/test/eval_retrieval.py <results.jsonl> --gold <gold> --by-intent

metric ที่ไม่ต้องใช้ gold (วัดรูปร่าง pool):
  listing_diversity   unique item_id / จำนวน product (1.0 = ไม่มี listing ซ้ำ)
  dup_pool_rate       สัดส่วนคำถามที่ listing เดียวโผล่ >= 3 ครั้ง
  live_ratio_top5     สัดส่วนสินค้าพร้อมขายใน 5 อันดับแรก
  unit_share          สัดส่วนคำถามที่ตอบผ่าน unit path
  fallback_rate       สัดส่วนที่ unit path ตกกลับ legacy
  avg_pool            จำนวน product เฉลี่ยต่อคำถาม

metric ที่ต้องมี gold (ความจริงมาจากคน):
  type_purity              เฉพาะเคสที่ "ต้องการสินค้า" — เคสที่คำตอบถูกคือ "ไม่มี" ไม่ถูกนับ
  acceptable_hit_rate      เคสที่ระบุ acceptable_item_ids แล้วเจออย่างน้อย 1 ตัวใน pool
  must_not_violation_rate  เคสที่มีสินค้าต้องห้ามหลุดเข้า pool (ยิ่งต่ำยิ่งดี)
  status_accuracy          catalog_status ของสินค้าที่ match ตรงกับที่คาด
  adequacy_at_1            เคส compat ที่อันดับ 1 จ่ายไฟถึงเกณฑ์ (อ่านจาก field เท่านั้น)
                           — ข้ามเคสที่ expected_answer_mode ∈ {no_such_type, no_info}
                           เพราะคำตอบที่ถูกคือ "ไม่มี" แม้ pool จะมีของผิดหลุดมา
  answer_mode_accuracy     ⚠️ heuristic ระดับข้อความ — ดู classify_answer_mode
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict

# intent ที่ "ต้องการสินค้าในคำตอบ" — ใช้คัดว่าเคสไหนควรนับ type_purity
_WANTS_PRODUCTS = ("recommend", "compatibility", "compare", "spec",
                   "exact_model", "superlative")
# mode ที่แปลว่า "คำตอบที่ถูกคือไม่มีสินค้า" — ไม่นับ type_purity/diversity
_NO_PRODUCT_MODES = ("no_such_type", "no_info")

# ⚠️ heuristic: pattern ตรวจโหมดคำตอบ เรียงตามลำดับความจำเพาะ (แรกสุดชนะ)
_MODE_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("no_info", ("ไม่พบข้อมูล", "ไม่พบสินค้า", "ไม่มีข้อมูลรุ่น", "ไม่พบรุ่น")),
    ("no_such_type", ("ไม่มีสินค้าประเภท", "ไม่มีจำหน่าย", "ไม่มีสินค้าชนิด",
                      "ไม่ได้จำหน่าย", "ไม่มีขาย")),
    ("discontinued", ("เลิกจำหน่าย", "เลิกผลิต", "ยกเลิกการจำหน่าย")),
    ("out_of_stock", ("หมดสต็อก", "สินค้าหมด", "ของหมด")),
)


def classify_answer_mode(answer: str) -> str:
    """เดาโหมดคำตอบจากข้อความ — heuristic ที่ประกาศ pattern ชัด ไม่ใช่ความจริงสัมบูรณ์.

    ใช้เทียบกับ expected_answer_mode ใน gold เพื่อจับ regression หยาบๆ
    (เช่น เคยตอบ "ไม่มี" ถูก แล้วกลายเป็นเชียร์ขายสินค้าผิดประเภท)
    ค่าเริ่มต้น "recommend" = ไม่เข้า pattern ปฏิเสธใดๆ
    """
    a = answer or ""
    for mode, pats in _MODE_PATTERNS:
        if any(p in a for p in pats):
            return mode
    return "recommend"


def load_results(path: str) -> list[dict]:
    """อ่าน JSONL ผลลัพธ์ — รองรับ flat (questions) และ nested (conversations)."""
    out: list[dict] = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if "qa" in r:
            for q in r["qa"]:
                out.append({
                    "id": f"{r.get('conv_id')}:{q.get('i')}",
                    "topic": "conv",
                    "shop": r.get("shop_name"),
                    "answer": q.get("bot_answer") or "",
                    "products": q.get("bot_products") or [],
                    "unit_path": q.get("unit_path"),
                    "unit_attempted": q.get("unit_attempted"),
                })
        else:
            out.append(r)
    return out


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def pool_metrics(recs: list[dict]) -> dict:
    div, live, pools = [], [], []
    dup = 0
    with_products = 0
    for r in recs:
        ps = r.get("products") or []
        if not ps:
            continue
        with_products += 1
        pools.append(float(len(ps)))
        ids = [p.get("item_id") for p in ps]
        div.append(len(set(ids)) / len(ids))
        if Counter(ids).most_common(1)[0][1] >= 3:
            dup += 1
        top5 = ps[:5]
        live.append(sum(1 for p in top5 if p.get("_available_for_sale")) / len(top5))
    n = len(recs)
    return {
        "n": n,
        "n_with_products": with_products,
        "listing_diversity": _mean(div),
        "dup_pool_rate": dup / with_products if with_products else 0.0,
        "live_ratio_top5": _mean(live),
        "unit_share": sum(1 for r in recs if r.get("unit_path")) / n if n else 0.0,
        "fallback_rate": sum(1 for r in recs if r.get("unit_attempted") in
                             ("fallback_dead_pool", "fallback_error")) / n if n else 0.0,
        "avg_pool": _mean(pools),
    }


def _max_watt(p: dict) -> float:
    """อ่าน W จาก field ที่ระบุชัดเท่านั้น — ไม่เดาจากชื่อ (ไม้บรรทัดต้องไม่เดา)."""
    for key in ("output_power_w", "max_output_power_w"):
        v = p.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    for v in (p.get("variants") or []):
        w = v.get("output_power_w")
        if isinstance(w, (int, float)) and w > 0:
            return float(w)
    return 0.0


def gold_metrics(recs: list[dict], gold: list[dict]) -> dict:
    """metric ที่ความจริงมาจาก gold — ไม่ใช้ tag ของระบบตัดสินตัวเอง."""
    by_id = {r.get("id"): r for r in recs}
    purity, adeq, modes = [], [], []
    accept_hits: list[float] = []
    must_not_cases = must_not_hits = 0
    status_hits = status_total = 0
    used = 0
    for g in gold:
        r = by_id.get(g.get("id"))
        if r is None:
            continue
        used += 1
        ps = r.get("products") or []
        ids = [p.get("item_id") for p in ps]
        mode_expected = g.get("expected_answer_mode")

        want_type = g.get("expected_product_type")
        if (want_type and ps and g.get("intent") in _WANTS_PRODUCTS
                and mode_expected not in _NO_PRODUCT_MODES):
            purity.append(sum(1 for p in ps if p.get("product_type") == want_type) / len(ps))

        acceptable = set(g.get("acceptable_item_ids") or [])
        if acceptable:
            accept_hits.append(1.0 if acceptable & set(ids) else 0.0)

        must_not = set(g.get("must_not_item_ids") or [])
        if must_not:
            must_not_cases += 1
            if must_not & set(ids):
                must_not_hits += 1

        want_status = g.get("expected_catalog_status")
        if want_status and ps:
            matched = next((p for p in ps if p.get("item_id") in acceptable), ps[0])
            status_total += 1
            status_hits += 1 if matched.get("catalog_status") == want_status else 0

        # adequacy นับเฉพาะเคสที่คำตอบถูกคือ "มีสินค้า" — เคส no_such_type/no_info
        # ที่มีของหลุดใน pool ไม่ใช่ความผิดของ top-1 (validate_gold กันไม่ให้ใส่ min_w คู่กันอยู่แล้ว)
        min_w = g.get("min_output_power_w")
        if min_w and mode_expected not in _NO_PRODUCT_MODES:
            adeq.append(1.0 if ps and _max_watt(ps[0]) >= float(min_w) else 0.0)

        if mode_expected:
            modes.append(1.0 if classify_answer_mode(r.get("answer") or "") == mode_expected
                         else 0.0)
    return {
        "n_gold": used,
        "type_purity": _mean(purity),
        "acceptable_hit_rate": _mean(accept_hits),
        "must_not_violation_rate": (must_not_hits / must_not_cases) if must_not_cases else 0.0,
        "status_accuracy": (status_hits / status_total) if status_total else 0.0,
        "adequacy_at_1": _mean(adeq),
        "answer_mode_accuracy": _mean(modes),
    }


def by_intent(recs: list[dict], gold: list[dict]) -> dict:
    """แยก metric ตาม intent ของ gold — ค่ารวมกลบปัญหาเฉพาะกลุ่ม (compat/exact model)."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for g in gold:
        groups[g.get("intent") or "?"].append(g)
    out = {}
    for intent, gs in sorted(groups.items()):
        ids = {g.get("id") for g in gs}
        sub = [r for r in recs if r.get("id") in ids]
        out[intent] = {**pool_metrics(sub), **gold_metrics(sub, gs)}
    return out


def _print(title: str, m: dict) -> None:
    print(f"\n── {title} ──")
    for k, v in m.items():
        print(f"  {k:<24} {v:.3f}" if isinstance(v, float) else f"  {k:<24} {v}")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    path = argv[0]
    gold_path = argv[argv.index("--gold") + 1] if "--gold" in argv else None
    recs = load_results(path)
    _print(f"pool metrics ({path})", pool_metrics(recs))
    if gold_path:
        gold = [json.loads(l) for l in open(gold_path, encoding="utf-8") if l.strip()]
        errs = validate_gold(gold)
        if errs:
            print("\nGOLD INVALID:")
            for e in errs:
                print("  " + e)
            return 1
        _print(f"gold metrics ({gold_path})", gold_metrics(recs, gold))
        if "--by-intent" in argv:
            for intent, m in by_intent(recs, gold).items():
                _print(f"intent={intent}", m)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

> `validate_gold` ถูกเรียกใน `main()` แต่ยังไม่มีตัวฟังก์ชัน — เพิ่มใน Task 2
> ระหว่าง Task 1 ให้รันเฉพาะโหมดไม่มี `--gold` (เทสไม่เรียก `main()`)

- [ ] **Step 4: รันเทสให้ผ่าน**

```bash
.venv/bin/python docs/test/test_eval_retrieval.py
```
คาด: `PASS pool_metrics` / `PASS classify_answer_mode` / `PASS gold_metrics` / `ALL PASS`

- [ ] **Step 5: ตรวจว่า schema ของไฟล์ผลจริงตรงกับ loader ก่อนเชื่อ baseline**

```bash
.venv/bin/python -c "
import sys; sys.path.insert(0,'docs/test')
import eval_retrieval as ev
recs = ev.load_results('docs/test/results/unit_reg_questions_2026-09-18.jsonl')
assert len(recs) == 300, len(recs)
need = ('id','products','unit_path','unit_attempted','answer')
missing = [k for k in need if k not in recs[0]]
assert not missing, missing
print('schema OK', len(recs))
"
```
ถ้า `missing` ไม่ว่าง → แก้ `load_results` ให้ตรง schema จริงก่อน ห้ามบันทึก baseline

- [ ] **Step 6: บันทึก baseline**

```bash
.venv/bin/python docs/test/eval_retrieval.py \
  docs/test/results/unit_reg_questions_2026-09-18.jsonl \
  | tee docs/test/results/eval_baseline_2026-09-18.txt
```
คาด `listing_diversity ≈ 0.72`, `dup_pool_rate ≈ 0.49` (ตัวเลขที่วัดไว้ในแชท — ทั้งคู่วัดจาก `products` ของ response เดียวกัน ไม่ใช่คนละขั้น)
ต่างเกิน ±0.02 → หยุด ตรวจ loader ก่อน

- [ ] **Step 7: Commit**

```bash
git add docs/test/eval_retrieval.py docs/test/test_eval_retrieval.py docs/test/results/eval_baseline_2026-09-18.txt
git commit -m "test: offline retrieval metrics (pool + gold + per-intent) with baseline"
```

---

## Task 2: Gold set ที่คนติดป้าย + validator

**Files:**
- Create: `docs/test/gold_retrieval.jsonl`
- Modify: `docs/test/eval_retrieval.py` (เพิ่ม `validate_gold`)
- Modify: `docs/test/test_eval_retrieval.py` (เพิ่มเทส)

**Interfaces:**
- Produces: `validate_gold(gold: list[dict]) -> list[str]`
- Schema (บังคับ: `id`, `shop`, `message`, `intent`):

```json
{"id":"q001","shop":"...","message":"...","intent":"compatibility",
 "expected_product_type":"cable","expected_answer_mode":"no_such_type",
 "expected_catalog_status":null,"min_output_power_w":null,
 "acceptable_item_ids":[],"must_not_item_ids":[],"min_distinct_listings":null,
 "note":"เหตุผลที่คำตอบนี้ถูก"}
```

- [ ] **Step 1: เขียนเทสที่ยัง fail**

เพิ่มใน `docs/test/test_eval_retrieval.py` ก่อน `print("\nALL PASS")`:

```python
    assert ev.validate_gold(GOLD) == [], ev.validate_gold(GOLD)
    errs = ev.validate_gold([
        {"id": "y", "shop": "S", "message": "m", "intent": "bogus_intent"},
        {"shop": "S", "message": "m", "intent": "recommend"},
        {"id": "y", "shop": "S", "message": "m", "intent": "recommend"},
        {"id": "z", "shop": "S", "message": "m", "intent": "recommend",
         "expected_answer_mode": "bogus_mode"},
        {"id": "w", "shop": "S", "message": "m", "intent": "compatibility",
         "min_output_power_w": -5},
        {"id": "v", "shop": "S", "message": "m", "intent": "compatibility",
         "expected_answer_mode": "no_such_type", "min_output_power_w": 60},
    ])
    assert any("intent" in e for e in errs), errs
    assert any("ขาด id" in e for e in errs), errs
    assert any("ซ้ำ" in e for e in errs), errs
    assert any("expected_answer_mode" in e for e in errs), errs
    assert any("min_output_power_w" in e for e in errs), errs
    # เคส v: "ไม่มีสินค้า" แต่ใส่เกณฑ์วัตต์ = gold ขัดกันเอง (จะทำ adequacy วัดผิด)
    assert any("min_output_power_w" in e and "ขัดกันเอง" in e for e in errs), errs
    print("PASS validate_gold")
```

- [ ] **Step 2: รันให้ fail**

```bash
.venv/bin/python docs/test/test_eval_retrieval.py
```
คาด: `AttributeError: module 'eval_retrieval' has no attribute 'validate_gold'`

- [ ] **Step 3: เขียน implementation**

เพิ่มใน `docs/test/eval_retrieval.py` (วางก่อน `_print`):

```python
_GOLD_INTENTS = ("recommend", "compatibility", "compare", "spec", "superlative",
                 "exact_model", "warranty", "history", "no_info")
_GOLD_MODES = ("recommend", "inform_only", "no_such_type", "no_info",
               "out_of_stock", "discontinued")
_GOLD_STATUSES = ("active", "out_of_stock", "unlisted", "discontinued",
                  "removed", "restricted", "reviewing", "unknown")


def validate_gold(gold: list[dict]) -> list[str]:
    """ตรวจ gold ก่อนใช้ — ป้ายผิดอันตรายกว่าไม่มีป้าย (metric ทุกตัวอิงมันหมด)."""
    errs: list[str] = []
    seen: set[str] = set()
    for i, g in enumerate(gold):
        gid = g.get("id")
        tag = gid or f"#{i}"
        if not gid:
            errs.append(f"[{tag}] ขาด id")
        elif gid in seen:
            errs.append(f"[{tag}] id ซ้ำ")
        else:
            seen.add(gid)
        for k in ("shop", "message"):
            if not g.get(k):
                errs.append(f"[{tag}] ขาด {k}")
        if g.get("intent") not in _GOLD_INTENTS:
            errs.append(f"[{tag}] intent ไม่รู้จัก: {g.get('intent')}")
        mode = g.get("expected_answer_mode")
        if mode is not None and mode not in _GOLD_MODES:
            errs.append(f"[{tag}] expected_answer_mode ไม่รู้จัก: {mode}")
        st = g.get("expected_catalog_status")
        if st is not None and st not in _GOLD_STATUSES:
            errs.append(f"[{tag}] expected_catalog_status ไม่รู้จัก: {st}")
        w = g.get("min_output_power_w")
        if w is not None and not (isinstance(w, (int, float)) and w > 0):
            errs.append(f"[{tag}] min_output_power_w ต้องเป็นตัวเลข > 0")
        if mode in _NO_PRODUCT_MODES:
            if g.get("acceptable_item_ids"):
                errs.append(f"[{tag}] mode={mode} แต่ระบุ acceptable_item_ids (ขัดกันเอง)")
            if w is not None:
                errs.append(f"[{tag}] mode={mode} แต่ระบุ min_output_power_w (ขัดกันเอง)")
    return errs
```

- [ ] **Step 4: รันเทสให้ผ่าน**

```bash
.venv/bin/python docs/test/test_eval_retrieval.py
```

- [ ] **Step 5: ร่าง gold set ≥ 40 เคสจากผลรันจริง**

เงื่อนไขการกระจาย (ตรวจด้วยตาก่อนส่ง review):
- ≥ 8 ร้าน · ทุก intent ใน `_GOLD_INTENTS` อย่างน้อย 2 เคส
- ≥ 5 เคสที่คำตอบถูกคือ "ไม่มี/ไม่พบ" (`no_such_type` / `no_info`)
- ≥ 3 เคส `exact_model` ที่สินค้า **ไม่ active** (ต้องตอบสถานะได้ ไม่ใช่เงียบ)
- ≥ 3 เคส variant/compare ที่ต้องเห็นหลายรุ่นย่อย → ใส่ `"min_distinct_listings"` หรือระบุใน note ว่าห้ามเหลือ variant เดียว (ใช้จับ regression ของ Task 5)

ตัวอย่าง 6 บรรทัดแรก (อ้างเคสที่ตรวจแล้วในผลรัน 2026-09-18):

```json
{"id":"q001","shop":"LeravanOfficialStore","message":"สายชาร์จใช้กับ iphone 15 ได้ไหมครับ","intent":"compatibility","expected_product_type":"cable","expected_answer_mode":"no_such_type","note":"ร้านขายเครื่องนวด ไม่มีสายชาร์จ — ห้ามเสนอเครื่องนวดแทนแบบยืนยัน"}
{"id":"q174","shop":"ZMIThailand","message":"หัวชาร์จตัวไหนเร็วสุด","intent":"superlative","expected_product_type":"charger","expected_answer_mode":"recommend","note":"ผลรันเดิม pool เป็น powerbank PB100S ซ้ำ 5 ตัว = ผิดประเภท + ซ้ำ listing"}
{"id":"q245","shop":"ThaiSuperPhone","message":"อยากได้ XMIC201 ครับ","intent":"exact_model","expected_answer_mode":"no_info","note":"ไม่มีรหัสนี้ในร้าน ต้องตอบไม่พบ"}
{"id":"q264","shop":"KingGadgets","message":"หัวชาจมีไหม","intent":"recommend","expected_product_type":"charger","expected_answer_mode":"recommend"}
{"id":"q003","shop":"LydstoThailand","message":"พาวเวอร์แบงค์ชาร์จโน้ตบุ๊คได้ไหมครับ","intent":"compatibility","expected_product_type":"powerbank","min_output_power_w":60,"expected_answer_mode":"recommend","note":"adequacy จะยังไม่ผ่านจนกว่า Plan 3 (specs ตอน build) — ใช้เป็น baseline"}
{"id":"q179","shop":"KospetThailand","message":"สมาร์ทวอทช์ตัวไหนจอใหญ่สุด","intent":"superlative","expected_product_type":"smartwatch","expected_answer_mode":"recommend","min_distinct_listings":3,"note":"ต้องเห็นหลายรุ่นจริง ไม่ใช่ listing เดียวหลายสี"}
```

- [ ] **Step 6: หยุดรอ human review**

```bash
.venv/bin/python docs/test/eval_retrieval.py \
  docs/test/results/unit_reg_questions_2026-09-18.jsonl \
  --gold docs/test/gold_retrieval.jsonl --by-intent
```
ส่งผลให้เจ้าของงานตรวจ — **ห้ามไป Task 3 ก่อน gold ผ่านสายตาคน**

- [ ] **Step 7: Commit**

```bash
git add docs/test/gold_retrieval.jsonl docs/test/eval_retrieval.py docs/test/test_eval_retrieval.py
git commit -m "test: human-labeled gold set + schema validator"
```

---

## Task 3: Availability resolver (mapping จากค่าจริงเท่านั้น)

**หลักฐานที่ใช้เขียน mapping** (นับจาก `exports/ShpProducts.export.json` ทั้งไฟล์ + `sellable_units.jsonl`):

```
item_status : NORMAL 5,302 · UNLIST 7,849 · SELLER_DELETE 1,071 · BANNED 59
              REVIEWING 61 · DELETED 60 · SHOPEE_DELETE 13
model_status: MODEL_NORMAL 27,774  ← มีค่าเดียวทั้ง catalog (และ "" 33 ใน unit export)
```
→ **ไม่เขียน mapping สำหรับ model_status ค่าที่ไม่เคยพบ** ค่าที่ไม่รู้จัก = `unknown` + log ครั้งเดียว แล้วค่อยเพิ่ม mapping เมื่อเห็นของจริง (เดาน้อยที่สุด)

**Files:**
- Modify: `chatbot/shopeechat/product_store.py` (เพิ่มก่อน `_doc_sellable` บรรทัด 581)
- Create: `docs/test/test_availability.py`

**Interfaces:**
- Produces: `resolve_availability(item_status: str | None, stock: int | None, model_status: str | None = None) -> tuple[str, bool]`
  - `catalog_status ∈ {"active","out_of_stock","unlisted","discontinued","removed","restricted","reviewing","unknown"}`
  - invariant: `sellable == (catalog_status == "active")`

- [ ] **Step 1: เขียนเทสที่ยัง fail**

สร้าง `docs/test/test_availability.py`:

```python
"""Test resolve_availability — เจ้าของสถานะสินค้าเพียงจุดเดียว.

mapping อ้างค่าจริงจาก catalog (2026-09-21):
  item_status : NORMAL / UNLIST / SELLER_DELETE / BANNED / REVIEWING / DELETED / SHOPEE_DELETE
  model_status: MODEL_NORMAL (ค่าเดียวที่มีจริง) + "" ใน unit export

รัน: .venv/bin/python docs/test/test_availability.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat.product_store import resolve_availability as ra


def main() -> int:
    cases = [
        (("NORMAL", 10, "MODEL_NORMAL"), ("active", True)),
        (("NORMAL", 0, "MODEL_NORMAL"), ("out_of_stock", False)),
        (("NORMAL", 3, ""), ("active", True)),              # unit export มี "" ปกติ
        (("NORMAL", 3, None), ("active", True)),
        (("UNLIST", 5, "MODEL_NORMAL"), ("unlisted", False)),     # ซ่อนขาย ≠ เลิกขาย
        (("UNLIST", 0, "MODEL_NORMAL"), ("unlisted", False)),
        (("SELLER_DELETE", 0, "MODEL_NORMAL"), ("discontinued", False)),
        (("SELLER_DELETE", 3, "MODEL_NORMAL"), ("discontinued", False)),
        (("DELETED", 0, ""), ("removed", False)),
        (("SHOPEE_DELETE", 0, ""), ("removed", False)),
        (("BANNED", 0, ""), ("restricted", False)),               # ถูกระงับ ≠ เลิกผลิต
        (("REVIEWING", 0, ""), ("reviewing", False)),
        (("", 0, ""), ("unknown", False)),
        ((None, None, None), ("unknown", False)),
        (("normal", 2, None), ("active", True)),                  # case-insensitive
        # model_status ค่าที่ไม่เคยพบใน catalog → unknown (ไม่เดาว่าเป็น unlisted)
        (("NORMAL", 10, "MODEL_SOMETHING_NEW"), ("unknown", False)),
    ]
    for args, want in cases:
        got = ra(*args)
        assert got == want, f"{args} → {got} (คาด {want})"
    print(f"PASS {len(cases)} availability cases")

    for st in ("NORMAL", "UNLIST", "SELLER_DELETE", "BANNED", "DELETED",
               "REVIEWING", "SHOPEE_DELETE", "ZZZ", "", None):
        for stock in (0, 1, 999, None):
            cs, sell = ra(st, stock)
            assert sell == (cs == "active"), (st, stock, cs, sell)
    print("PASS sellable == (catalog_status == 'active') invariant")

    # stock ชนิดแปลก ต้องไม่ระเบิด
    for bad in ("5", 2.7, -3, True):
        cs, sell = ra("NORMAL", bad)
        assert cs in ("active", "out_of_stock"), (bad, cs)
    print("PASS stock ชนิดแปลก")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: รันให้ fail**

```bash
.venv/bin/python docs/test/test_availability.py
```
คาด: `ImportError: cannot import name 'resolve_availability'`

- [ ] **Step 3: เขียน implementation**

เพิ่มใน `chatbot/shopeechat/product_store.py` เหนือ `def _doc_sellable`:

```python
# ── availability (เจ้าของสถานะสินค้าเพียงจุดเดียวของระบบ) ────────────────
#   ทุกที่ที่ถามว่า "ขายได้ไหม / เลิกขายหรือยัง" ต้องเรียกฟังก์ชันนี้
#   ห้ามคำนวณซ้ำที่อื่น และห้ามเก็บ sellable เป็นค่าจริงถาวร (เป็นค่าคำนวณเสมอ)
#   mapping อ้างค่าที่พบจริงใน catalog 2026-09-21 เท่านั้น — ค่าใหม่ = unknown ไม่เดา
_CATALOG_STATUS_MAP = {
    "NORMAL": "active",              # ต้องมี stock ด้วยถึง active จริง
    "UNLIST": "unlisted",            # ร้านซ่อน/พักขาย — ไม่ใช่เลิกผลิต
    "SELLER_DELETE": "discontinued",  # ร้านลบเอง = เลิกจำหน่าย
    "DELETED": "removed",
    "SHOPEE_DELETE": "removed",
    "BANNED": "restricted",          # ถูกระงับ — ห้ามบอกลูกค้าว่าเลิกผลิต
    "REVIEWING": "reviewing",
}
# model_status ที่พบจริงมีค่าเดียว — ค่าอื่นแปลว่าเจอของใหม่ ให้ยอมรับว่าไม่รู้
_MODEL_STATUS_OK = ("MODEL_NORMAL", "")
_seen_unknown_model_status: set[str] = set()


def resolve_availability(item_status: str | None, stock: int | None,
                         model_status: str | None = None) -> tuple[str, bool]:
    """raw fields → (catalog_status, sellable). sellable = catalog_status == "active".

    Args:
        item_status: item_status จาก Shopee (NORMAL/UNLIST/SELLER_DELETE/...)
        stock: stock ที่ขายได้จริง (unit-level หรือ listing รวม)
        model_status: model_status ของ variant (พบจริงเฉพาะ MODEL_NORMAL)

    Returns:
        (catalog_status, sellable) — catalog_status ใช้เลือกถ้อยคำตอบลูกค้า
        ("เดี๋ยวเข้า" / "พักขาย" / "เลิกจำหน่าย" / "ถูกระงับ" คนละความหมาย)
    """
    status = _CATALOG_STATUS_MAP.get((item_status or "").strip().upper(), "unknown")
    ms = (model_status or "").strip().upper()
    if ms not in _MODEL_STATUS_OK:
        if ms not in _seen_unknown_model_status:
            _seen_unknown_model_status.add(ms)
            print(f"[AVAIL] model_status ใหม่ที่ยังไม่มี mapping: {ms!r} → unknown",
                  file=sys.stderr)
        return "unknown", False
    if status == "active":
        try:
            n = int(stock or 0)
        except (TypeError, ValueError):
            n = 0
        if n <= 0:
            status = "out_of_stock"
    return status, status == "active"
```

- [ ] **Step 4: รันเทสให้ผ่าน**

```bash
.venv/bin/python docs/test/test_availability.py
python -m py_compile chatbot/shopeechat/product_store.py
```

- [ ] **Step 5: Commit**

```bash
git add chatbot/shopeechat/product_store.py docs/test/test_availability.py
git commit -m "feat: single-source availability resolver (evidence-based status mapping)"
```

---

## Task 4: ให้ทุก callsite ใช้ resolver เดียว (รวม `app.py`)

**ทำไม:** สูตร availability วันนี้มี **4 ชุด** — `_doc_sellable:589-594` · `to_product_card:638` · `units._live_sellable:225-228` · **`app.py:4189-4193`** ถ้าไม่แตะชุดที่ 4 คำว่า single owner ไม่จริง

**Files:**
- Modify: `chatbot/shopeechat/product_store.py:581-594`, `:611-638`
- Modify: `chatbot/shopeechat/units.py:219-228`, `:253-329`
- Modify: `chatbot/shopeechat/app.py:4189-4193` (แทนสูตรซ้ำ — ไม่เพิ่ม logic)
- Create: `docs/test/test_availability_wiring.py`

**Interfaces:**
- Consumes: `product_store.resolve_availability` (Task 3)
- Produces: card field `catalog_status: str` ทั้ง 2 ชนิด (`_available_for_sale` / `sellable` / `sold_out` ความหมายเดิม)

- [ ] **Step 1: หา callsite ให้ครบก่อนแก้ (บันทึกผลลง waythrough)**

```bash
cd /Users/itdev4/Documents/GitHub/ChatBotProductMS/chatbot/shopeechat
grep -rn "_available_for_sale\|item_status.*NORMAL\|sold_out" *.py | grep -v "^chat_v2\|^chatbotv3" | tee /tmp/avail_callsites.txt
wc -l /tmp/avail_callsites.txt
```
ทุกบรรทัดที่ *คำนวณ* สถานะ (ไม่ใช่แค่ *อ่าน* ค่า) ต้องถูกแทนในขั้นตอนนี้ — ถ้าเจอจุดที่ 5 ที่ไม่ได้อยู่ในลิสต์ ให้เพิ่มเข้า Step 3 และบันทึกไว้

- [ ] **Step 2: เขียนเทสที่ยัง fail**

สร้าง `docs/test/test_availability_wiring.py`:

```python
"""Test ว่า card ทุกชนิดใช้ resolve_availability ตัวเดียว, ค่าเดิมไม่เปลี่ยน,
และ field ใหม่ไม่หลุดเข้า LLM context ใน Plan 1.

รัน: .venv/bin/python docs/test/test_availability_wiring.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import llm, product_store as ps, units


def _doc(item_status: str, stock: int) -> dict:
    return {"item_id": 111, "item_name": "ทดสอบ", "shopname": "S1",
            "item_status": item_status,
            "stock_info_v2": {"summary_info": {"total_available_stock": stock}}}


def _multi_model_doc(item_status: str, stocks: list[int]) -> dict:
    return {"item_id": 222, "item_name": "หลายรุ่น", "shopname": "S1",
            "item_status": item_status,
            "model": [{"model_id": i, "model_name": f"m{i}", "model_status": "MODEL_NORMAL",
                       "stock_info_v2": {"summary_info": {"total_available_stock": s}}}
                      for i, s in enumerate(stocks)]}


def main() -> int:
    # ── to_product_card ──
    c = ps.to_product_card(_doc("NORMAL", 5))
    assert c["catalog_status"] == "active" and c["_available_for_sale"] is True, c
    assert c["sold_out"] is False and c["total_stock"] == 5, c

    c = ps.to_product_card(_doc("NORMAL", 0))
    assert c["catalog_status"] == "out_of_stock" and c["_available_for_sale"] is False, c
    assert c["sold_out"] is True, c

    c = ps.to_product_card(_doc("UNLIST", 7))
    assert c["catalog_status"] == "unlisted" and c["_available_for_sale"] is False, c
    assert c["sold_out"] is False, c      # มีของแต่ขายไม่ได้ = คนละเรื่อง

    c = ps.to_product_card(_doc("SELLER_DELETE", 0))
    assert c["catalog_status"] == "discontinued", c
    print("PASS to_product_card catalog_status")

    # ── _doc_sellable: multi-model + stock แปลก ต้องเท่า resolver ──
    for st in ("NORMAL", "UNLIST", "SELLER_DELETE", "BANNED"):
        for stocks in ([0, 0], [0, 4], [9], []):
            d = _multi_model_doc(st, stocks) if stocks else _doc(st, 0)
            total = max(stocks) if stocks else 0
            want = ps.resolve_availability(st, total)[1]
            assert ps._doc_sellable(d) is want, (st, stocks, want)
    print("PASS _doc_sellable delegates to resolver (multi-model)")

    # ── to_unit_card ──
    unit = {"unit_id": "1:2", "item_id": 1, "model_id": 2, "display_name": "u",
            "model_name": "สีดำ", "shop": "S1", "item_status": "UNLIST",
            "stock": 4, "model_status": "MODEL_NORMAL", "price": 100,
            "desc_sections": {"specs": "x"}}
    card = units.to_unit_card(unit)
    assert card["catalog_status"] == "unlisted", card["catalog_status"]
    assert card["sellable"] is False and card["_available_for_sale"] is False, card
    unit["item_status"] = "NORMAL"
    card = units.to_unit_card(unit)
    assert card["catalog_status"] == "active" and card["sellable"] is True, card
    unit["stock"] = 0
    assert units._live_sellable(unit) is False, "stock 0 ต้องขายไม่ได้"
    print("PASS to_unit_card + _live_sellable")

    # ── Plan 1: catalog_status ต้องยังไม่ถูกส่งเข้า LLM ──
    ctx = llm._build_context([units.to_unit_card(unit)], shop_hint="S1")
    assert "catalog_status" not in ctx, "Plan 1 ยังไม่เปิด field นี้ให้ LLM (ถ้อยคำอยู่ Plan 2)"
    print("PASS catalog_status ไม่หลุดเข้า context")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: รันให้ fail**

```bash
.venv/bin/python docs/test/test_availability_wiring.py
```
คาด: `KeyError: 'catalog_status'`

- [ ] **Step 4: เขียน implementation**

**4a.** `product_store.py` — body ใหม่ของ `_doc_sellable` (แทนบรรทัด 589-594) คงแนวคิด `any()` เดิม:

```python
    models = doc.get("model") or []
    if models:
        return any(resolve_availability((doc or {}).get("item_status"),
                                        _shopee_stock(m))[1] for m in models)
    return resolve_availability((doc or {}).get("item_status"), _shopee_stock(doc))[1]
```

**4b.** `product_store.py` — ใน `to_product_card` เพิ่มบรรทัดนี้หลังบล็อกคำนวณ `total_stock` (หลังบรรทัด 617):

```python
    _catalog_status, _sellable = resolve_availability(doc.get("item_status"), total_stock)
```
แล้วแก้ใน dict ที่ return: แทนบรรทัด 638 ด้วย

```python
        "catalog_status": _catalog_status,
        "_available_for_sale": _sellable,
```

**4c.** `units.py` — body ใหม่ของ `_live_sellable` (แทนบรรทัด 225-228):

```python
    from . import product_store as _ps   # lazy — กัน circular
    if "_listing" not in unit:
        status, stock, mstatus = (unit.get("item_status"), unit.get("stock"),
                                  unit.get("model_status"))
    else:
        status, stock, mstatus = _live_availability(unit)
    return _ps.resolve_availability(status, stock, mstatus)[1]
```

**4d.** `units.py` — ใน `to_unit_card` หลังบรรทัด 262 เพิ่ม:

```python
    catalog_status, live_sellable = _ps.resolve_availability(status, stock, model_status)
```
แล้วใน dict ที่ return: เพิ่ม `"catalog_status": catalog_status,` ถัดจาก `"status": status,`
และแทน `"_available_for_sale": status == "NORMAL" and stock > 0,` → `"_available_for_sale": live_sellable,`
และแทน `"sellable": status == "NORMAL" and stock > 0,` → `"sellable": live_sellable,`

**4e.** `app.py` — แทนสูตรที่สาม (บรรทัด 4189-4193) ด้วยการเรียก resolver บน **raw fields**
— ห้ามส่ง `stock=0` เพราะ `sold_out=True`: flag อาจ stale บน card ที่ restore จาก timeline
(`conversation_products.py:244`) ทั้งที่ `status`/`total_stock` ยังเป็นของใหม่
→ raw ชนะเสมอ, flag ที่ขัดกันกลายเป็น warning ไม่ใช่ตัวตัดสิน:

```python
                _p["catalog_status"], _p["_available_for_sale"] = \
                    product_store.resolve_availability(
                        _p.get("status"), _p.get("total_stock", 0) or 0)
```

แล้วต่อจาก loop เดิม (ก่อน `_has_unlist`) เพิ่มการนับ conflict — ต่อยอด print
`[AVAIL-FOR-SALE]` ที่มีอยู่บรรทัด 4202 ไม่สร้างช่อง log ใหม่:

```python
            _sold_out_conflict = [
                _p.get("item_id") for _p in products
                if _p.get("sold_out") and _p["_available_for_sale"]
            ]
```

และเพิ่ม `sold_out_conflict={len(_sold_out_conflict)}` ต่อท้าย f-string เดิม +
บรรทัดเตือนเมื่อเกิดจริง:

```python
            if _sold_out_conflict:
                print(f"[AVAIL-FOR-SALE] sold_out flag ขัดกับ status+stock "
                      f"(flag stale): {_sold_out_conflict[:5]}", file=sys.stderr)
```

> parity note: ผล `_available_for_sale` เท่าสูตรเดิมทุก card ที่สร้างสด เพราะ `sold_out`
> derive จาก `stock==0` ตอนสร้าง (`product_store.py:638`, `units.py:289`) — ต่างได้เฉพาะ
> card ที่ restore จาก timeline ซึ่งเป็นเจตนา (raw ชนะ flag ที่ stale)
> ห้ามแตะบรรทัด 4194-4234 (`_has_unlist` / `_has_sold_out` / `_notes` / prompt rule)
> — Plan 1 ไม่เปลี่ยน policy; `_has_sold_out` ยังอ่าน `sold_out` ดิบตามเดิม

- [ ] **Step 5: รันเทสให้ผ่าน + เทสเดิมต้องไม่พัง**

```bash
.venv/bin/python docs/test/test_availability_wiring.py
.venv/bin/python docs/test/test_availability.py
.venv/bin/python docs/test/test_unit_card_fields.py
.venv/bin/python docs/test/test_general_qtype_guards.py
python -m py_compile chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/app.py
```
เทสที่ต้องต่อ Mongo ถ้ารันไม่ได้ ให้บันทึกเหตุผล — **ไม่ถือว่าผ่าน**

- [ ] **Step 6: อัปเดตเอกสาร**

- `docs/SRS_SSD.md` section 6: เพิ่ม `resolve_availability`; แก้ `_doc_sellable` / `to_product_card` / `to_unit_card` / `_live_sellable` ว่า Calls `resolve_availability`; บันทึกว่า `chat()` เลิกคำนวณ `_available_for_sale` เอง
- `getoutofmywaybotkaikrook2.md`: สถานะสินค้าเคยมี 4 สูตร → เหลือ 1; ค่าที่ออกไม่เปลี่ยน (มีเทส); known limitation: retrieval ยังใช้ `sellable` snapshot

- [ ] **Step 7: Commit**

```bash
git add chatbot/shopeechat/product_store.py chatbot/shopeechat/units.py chatbot/shopeechat/app.py \
        docs/test/test_availability_wiring.py docs/SRS_SSD.md getoutofmywaybotkaikrook2.md
git commit -m "refactor: every availability callsite (incl. app.py) derives from one resolver"
```

---

## Task 5: หยุด listing เดียวครองผลลัพธ์ (policy ส่งจาก caller)

**Files:**
- Modify: `chatbot/shopeechat/units.py` (เพิ่ม `_cap_per_listing` ก่อน `fetch_unit_cards`; `fetch_unit_cards` รับ `per_listing`)
- Modify: `chatbot/shopeechat/product_store.py:2920-2927` (ส่ง `per_listing` ต่อ)
- Create: `docs/test/test_listing_diversity.py`

**Interfaces:**
- Produces: `_cap_per_listing(units: list[dict], limit: int, per_listing: int = 1) -> list[dict]`
  - รักษาลำดับ input · `_matched_by == "code"` ไม่ติดโควตา · ตัวเกินไม่ถูกทิ้ง (เลื่อนท้าย)
  - `per_listing <= 0` = ไม่จำกัด (สำหรับ caller ที่ต้องการทุก variant)
- Produces: `fetch_unit_cards(message, *, per_listing: int = 1, **kwargs)`
- Produces: `fetch_products(..., per_listing: int = 1)` — ส่งต่อให้ unit path เท่านั้น (legacy listing path ไม่มี variant ซ้ำ)

- [ ] **Step 1: เขียนเทสที่ยัง fail**

สร้าง `docs/test/test_listing_diversity.py`:

```python
"""Test _cap_per_listing — identity = item_id, policy มาจาก caller.

รัน: .venv/bin/python docs/test/test_listing_diversity.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat.units import _cap_per_listing


def _u(uid: str, item_id: int, matched: str = "vector") -> dict:
    return {"unit_id": uid, "item_id": item_id, "_matched_by": matched}


def main() -> int:
    # เคสจริง q174: PB100S 5 variants (listing 1) + อีก 3 listing
    pool = [_u("a1", 1), _u("a2", 1), _u("a3", 1), _u("a4", 1), _u("a5", 1),
            _u("b1", 2), _u("c1", 3), _u("d1", 4)]
    out = _cap_per_listing(pool, limit=8)
    assert [u["item_id"] for u in out[:4]] == [1, 2, 3, 4], [u["item_id"] for u in out]
    assert len(out) == 8, out                     # ไม่ทิ้งของ — ส่วนเกินไปท้าย
    print("PASS cap 1 ต่อ listing + ส่วนเกินเลื่อนท้าย")

    out = _cap_per_listing([_u("a1", 1), _u("a2", 1)], limit=8)
    assert len(out) == 2, out
    print("PASS pool เล็กกว่า limit")

    pool = [_u("h1", 9, "code"), _u("h2", 9, "code"), _u("h3", 9, "code"),
            _u("x1", 7), _u("x2", 7)]
    out = _cap_per_listing(pool, limit=5)
    assert [u["unit_id"] for u in out[:3]] == ["h1", "h2", "h3"], out
    print("PASS code-hit ยกเว้นโควตา")

    pool = [_u("a1", 1), _u("a2", 1), _u("a3", 1), _u("b1", 2)]
    out = _cap_per_listing(pool, limit=4, per_listing=2)
    assert [u["unit_id"] for u in out] == ["a1", "a2", "b1", "a3"], out
    print("PASS per_listing=2 (คำถามแบบ compare/variant)")

    out = _cap_per_listing(pool, limit=4, per_listing=0)
    assert [u["unit_id"] for u in out] == ["a1", "a2", "a3", "b1"], out
    print("PASS per_listing=0 = ไม่จำกัด")

    out = _cap_per_listing([_u(f"u{i}", i) for i in range(20)], limit=8)
    assert len(out) == 8
    print("PASS limit")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: รันให้ fail**

```bash
.venv/bin/python docs/test/test_listing_diversity.py
```
คาด: `ImportError: cannot import name '_cap_per_listing'`

- [ ] **Step 3: เขียน implementation**

เพิ่มใน `chatbot/shopeechat/units.py` เหนือ `def fetch_unit_cards`:

```python
def _cap_per_listing(units: list[dict], limit: int,
                     per_listing: int = 1) -> list[dict]:
    """กัน listing เดียวกินผลลัพธ์ — identity คือ item_id ไม่ใช่ชื่อ.

    unit = variant → listing เดียวมีได้ 10+ unit ต่างกันแค่สี/รุ่นย่อย
    (`_dedupe_products` ยุบด้วยชื่อจึงไม่เคยจับได้ — display_name มี " — <variant>")

    - เรียงตามลำดับที่รับมา (caller sort มาก่อนแล้ว)
    - code-hit ไม่ติดโควตา: ถามเจาะจงรุ่นต้องเห็นทุก variant ของ listing นั้น
    - per_listing <= 0 = ไม่จำกัด (คำถามแบบ "มีสีอะไรบ้าง" / เปรียบเทียบรุ่นย่อย)
    - ตัวเกินโควตาไม่ถูกทิ้ง แต่เลื่อนไปท้าย (pool บางยังได้ของครบ limit)
    """
    if per_listing <= 0:
        return units[:limit]
    picked: list[dict] = []
    spill: list[dict] = []
    seen: dict = {}
    for u in units:
        if u.get("_matched_by") == "code":
            picked.append(u)
            continue
        iid = u.get("item_id")
        n = seen.get(iid, 0)
        if n < per_listing:
            seen[iid] = n + 1
            picked.append(u)
        else:
            spill.append(u)
    return (picked + spill)[:limit]
```

แก้ `fetch_unit_cards` — signature และบรรทัด `top = us[:limit]`:

```python
def fetch_unit_cards(message: str, **kwargs) -> list[dict]:
    """fetch_units + attach_kb_specs + attach_image_texts + attach_listing_fields + to_unit_card."""
    route = kwargs.pop("route", None)
    per_listing = int(kwargs.pop("per_listing", 1))
```
และ

```python
    top = _cap_per_listing(us, limit, per_listing)
```

แก้ `product_store.fetch_products` — เพิ่มพารามิเตอร์ (ท้ายรายการ, มี default = ไม่กระทบ caller เดิม):

```python
    per_listing: int = 1,
```
และส่งต่อในบล็อก unit path (`product_store.py:2920-2927`) เพิ่มบรรทัด:

```python
                per_listing=per_listing,
```

- [ ] **Step 4: shadow diff ก่อนเชื่อ (ไม่เปิดใช้ทันที)**

```bash
.venv/bin/python -c "
import sys; sys.path.insert(0,'.')
from chatbot.shopeechat.units import _cap_per_listing
import json
recs=[json.loads(l) for l in open('docs/test/results/unit_reg_questions_2026-09-18.jsonl')]
changed=0; total=0
for r in recs:
    ps=r.get('products') or []
    if not ps: continue
    total+=1
    fake=[{'unit_id':p.get('unit_id'),'item_id':p.get('item_id'),'_matched_by':'vector'} for p in ps]
    after=_cap_per_listing(fake, len(fake))
    if [f['unit_id'] for f in after] != [f['unit_id'] for f in fake]: changed+=1
print(f'pool ที่ลำดับจะเปลี่ยน: {changed}/{total} ({changed/total:.0%})')
"
```
คาด ~49% (ตรงกับ `dup_pool_rate` ใน baseline) — ถ้าต่างมาก แปลว่าเข้าใจสาเหตุผิด ให้หยุดตรวจก่อน

- [ ] **Step 5: รันเทสให้ผ่าน**

```bash
.venv/bin/python docs/test/test_listing_diversity.py
.venv/bin/python docs/test/test_units.py
python -m py_compile chatbot/shopeechat/units.py chatbot/shopeechat/product_store.py
```

- [ ] **Step 6: อัปเดตเอกสาร**

- `docs/SRS_SSD.md`: เพิ่ม `_cap_per_listing`; แก้ signature `fetch_unit_cards` / `fetch_products` (`per_listing`)
- `getoutofmywaybotkaikrook2.md`: 49% ของ pool ซ้ำ listing เพราะ dedupe ใช้ชื่อ → ใช้ item_id; policy มาจาก caller; known limitation: ยังไม่มีตัวจำแนก compare/variant query (Plan 5)

- [ ] **Step 7: Commit**

```bash
git add chatbot/shopeechat/units.py chatbot/shopeechat/product_store.py \
        docs/test/test_listing_diversity.py docs/SRS_SSD.md getoutofmywaybotkaikrook2.md
git commit -m "fix: cap units per listing by item_id (caller-provided policy, code-hit exempt)"
```

---

## Task 6: Replay gate (แยกเกณฑ์ตาม intent)

- [ ] **Step 1: รัน corpus ใหม่**

```bash
cd chatbot && USE_UNIT_INDEX=charger ../.venv/bin/uvicorn shopeechat.app:app --port 8021 &
cd /Users/itdev4/Documents/GitHub/ChatBotProductMS
.venv/bin/python docs/test/unit_index_regression.py \
  --questions docs/test/unit_reg_corpus.jsonl \
  --bot http://127.0.0.1:8021 \
  --out docs/test/results/unit_reg_questions_plan1.jsonl
```

- [ ] **Step 2: เทียบ baseline แบบแยก intent**

```bash
.venv/bin/python docs/test/eval_retrieval.py \
  docs/test/results/unit_reg_questions_plan1.jsonl \
  --gold docs/test/gold_retrieval.jsonl --by-intent \
  | tee docs/test/results/eval_plan1.txt
diff docs/test/results/eval_baseline_2026-09-18.txt docs/test/results/eval_plan1.txt
```

- [ ] **Step 3: ตรวจเกณฑ์ (แยกกลุ่ม ไม่ใช้ค่ารวม)**

| กลุ่ม | metric | เกณฑ์ |
|---|---|---|
| `recommend` / `superlative` | `listing_diversity` | **≥ 0.95** |
| `recommend` / `superlative` | `dup_pool_rate` | **≤ 0.05** |
| `exact_model` | `acceptable_hit_rate` | **ไม่ลดลง** (variant ของรุ่นที่ถามต้องไม่หาย) |
| `compare` | `min_distinct_listings` ใน gold | ผ่านทุกเคส (ไม่เหลือ listing เดียว) |
| `warranty` / `history` | `acceptable_hit_rate` | ไม่ลดลง |
| ทุกกลุ่ม | `must_not_violation_rate` | ไม่เพิ่ม |
| ทุกกลุ่ม | `answer_mode_accuracy` | ไม่ลดลงเกิน 0.05 (heuristic — ใช้ดูแนวโน้ม) |
| ทุกกลุ่ม | `fallback_rate` | ไม่เพิ่มเกิน +0.02 |
| `compatibility` | `adequacy_at_1` | **ไม่ตั้งเกณฑ์** — Plan 1 ไม่แตะ spec (บันทึกค่าไว้เฉยๆ) |
| ทั้งหมด | เทสเดิม | ยังผ่าน |

ไม่ผ่านข้อใด → **หยุด** วิเคราะห์ก่อน ห้ามขึ้น Plan 2

- [ ] **Step 4: Commit + สรุปลง waythrough**

```bash
git add docs/test/results/eval_plan1.txt
git commit -m "test: plan1 gate metrics vs baseline (per intent)"
```

---

## Self-Review

**1. Spec coverage** — ครอบ: gold set + baseline (T1-2), availability single owner รวม `app.py` (T3-4), item_id diversity แบบ caller policy (T5), gate แยก intent (T6)
**ไม่ครอบโดยตั้งใจ:** knowledge_status, normalized specs + provenance, indexes, conversation constraints, candidate contract, unified selector, table-driven ranking, two-phase join, evidence layer, ลบ name-inspection, `sellable` snapshot ใน retrieval → อยู่ใน Known limitations + แผนถัดไป

**2. Placeholder scan** — ไม่มี TBD/TODO; ทุก step มีโค้ดและคำสั่งจริง; ข้อยกเว้นที่ประกาศชัด: `validate_gold` ถูกเรียกใน `main()` ของ Task 1 แต่นิยามใน Task 2 (มีหมายเหตุกำกับ + เทส Task 1 ไม่เรียก `main()`)

**3. Type consistency** — `resolve_availability(...) -> tuple[str, bool]` ใช้เหมือนกันทุกจุด · `_cap_per_listing(units, limit, per_listing)` ตรงกันระหว่างเทส/implementation/caller · field ใหม่ชื่อ `catalog_status` เหมือนกันทั้ง unit/listing card · `per_listing` ชื่อเดียวกันตลอดสาย (`fetch_products` → `fetch_unit_cards` → `_cap_per_listing`)

---

## แผนถัดไป

| Plan | เนื้อหา | เงื่อนไขเริ่ม |
|---|---|---|
| **2** | knowledge_status + evidence provenance; เปิด `catalog_status` เข้า context + ถ้อยคำมาตรฐานต่อสถานะ (พักขาย/เลิกจำหน่าย/ถูกระงับ) | Plan 1 Task 6 ผ่าน |
| **3** | normalized specs ตอน build (`output_power_w`, `connectors`, `capacity_mah` + source/confidence) + index (`shop+product_type`, `charger_subtype`) + `explain()` verify | Plan 2 ผ่าน + coverage report |
| **4** | candidate contract + unified retrieval (structured / vector / unknown) + เลิก `sim>0.3` + เลิกใช้ `sellable` snapshot เป็น filter | Plan 3 coverage ถึงเกณฑ์ต่อร้าน/type |
| **5** | selector เดียว + table-driven ranking profile (รวม per-listing policy ตาม intent) + two-phase live join + ลบ unit pipeline ซ้ำ + ลบ `is_compat_check` bypass | Plan 4 ผ่าน |
| **6** | ลบ runtime name-inspection ทีละ field (หลัง shadow compare) + แยกไฟล์ `chat()` ตามรอยต่อ | Plan 5 ผ่าน + gold ผ่าน |
