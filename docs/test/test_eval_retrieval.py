"""Tests for docs/test/eval_retrieval.py."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import eval_retrieval as ev


def _write(tmp: Path, rows: list[dict]) -> str:
    path = tmp / "results.jsonl"
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    return str(path)


ROWS = [
    {
        "id": "a", "topic": "browse_type", "shop": "S1", "unit_path": True,
        "unit_attempted": "attempted", "answer": "แนะนำรุ่นนี้เลยค่ะ",
        "products": [
            {"item_id": 1, "product_type": "charger", "status": "NORMAL", "_available_for_sale": True},
            {"item_id": 1, "product_type": "charger", "status": "NORMAL", "_available_for_sale": True},
            {"item_id": 1, "product_type": "charger", "status": "NORMAL", "_available_for_sale": False},
            {"item_id": 1, "product_type": "charger", "status": "NORMAL", "_available_for_sale": False},
            {"item_id": 2, "product_type": "powerbank", "status": "UNLIST", "_available_for_sale": False},
        ],
    },
    {
        "id": "b", "topic": "compat_charging", "shop": "S1", "unit_path": False,
        "unit_attempted": "fallback_dead_pool",
        "answer": "ขออภัยค่ะ ทางร้านไม่มีสินค้าประเภทนี้จำหน่ายนะคะ",
        "products": [
            {"item_id": 3, "product_type": "powerbank", "output_power_w": 65,
             "status": "NORMAL", "_available_for_sale": True},
            {"item_id": 4, "product_type": "powerbank", "status": "NORMAL",
             "_available_for_sale": True},
        ],
    },
    {
        "id": "c", "topic": "compat_charging", "shop": "S1", "unit_path": True,
        "unit_attempted": "attempted", "answer": "แนะนำรุ่นนี้เลยค่ะ",
        "products": [
            {"item_id": 5, "product_type": "powerbank", "output_power_w": 65,
             "status": "NORMAL", "_available_for_sale": True},
            {"item_id": 6, "product_type": "powerbank", "status": "NORMAL",
             "_available_for_sale": True},
        ],
    },
]

GOLD = [
    {"id": "a", "shop": "S1", "message": "มีหัวชาร์จไหม", "intent": "recommend",
     "expected_answer_mode": "recommend", "acceptable_item_ids": [1],
     "must_not_item_ids": [2], "expected_product_type": "charger",
     "expected_catalog_status": "active", "requires_evidence": []},
    {"id": "b", "shop": "S1", "message": "มีสายชาร์จไหม", "intent": "compatibility",
     "expected_answer_mode": "no_such_type", "acceptable_item_ids": [],
     "must_not_item_ids": [], "expected_product_type": "charger",
     "expected_subtype": "cable", "expected_catalog_status": "",
     "requires_evidence": ["compatibility"]},
    {"id": "c", "shop": "S1", "message": "พาวเวอร์แบงค์ชาร์จโน้ตบุ๊คได้ไหม",
     "intent": "compatibility", "expected_answer_mode": "recommend",
     "acceptable_item_ids": [], "must_not_item_ids": [],
     "expected_product_type": "powerbank", "expected_catalog_status": "active",
     "requires_evidence": ["compatibility"], "min_output_power_w": 60},
]


def test_load_results_and_pool_metrics():
    with tempfile.TemporaryDirectory() as tmp:
        recs = ev.load_results(_write(Path(tmp), ROWS))
    assert len(recs) == 3

    m = ev.pool_metrics(recs)
    assert m["n"] == 3
    assert m["n_with_products"] == 3
    assert abs(m["listing_diversity"] - 0.8) < 1e-9
    assert abs(m["dup_pool_rate"] - 1 / 3) < 1e-9
    assert abs(m["live_ratio_top5"] - 0.8) < 1e-9
    assert abs(m["unit_share"] - 2 / 3) < 1e-9
    assert abs(m["fallback_rate"] - 1 / 3) < 1e-9
    assert abs(m["avg_pool"] - 3.0) < 1e-9


def test_classify_answer_mode():
    assert ev.classify_answer_mode("ขออภัยค่ะ ทางร้านไม่มีสินค้าประเภทนี้จำหน่ายนะคะ") == "no_such_type"
    assert ev.classify_answer_mode("ไม่พบข้อมูลรุ่นนี้ในระบบค่ะ") == "no_info"
    assert ev.classify_answer_mode("รุ่นนี้หมดสต็อกชั่วคราวค่ะ") == "out_of_stock"
    assert ev.classify_answer_mode("รุ่นนี้เลิกจำหน่ายแล้วค่ะ") == "discontinued"
    assert ev.classify_answer_mode("แนะนำรุ่นนี้เลยค่ะ") == "recommend"


def test_record_answer_mode_uses_policy_sources():
    ask_order = {"source": "return_refund_ask_order",
                 "answer": "เรื่องคืนสินค้า รบกวนแจ้งเลขคำสั่งซื้อให้หน่อยนะคะ"}
    assert ev._record_answer_mode(ask_order) == "policy"
    cert = {"source": "cert_answer", "answer": "สินค้าที่มี มอก. ได้แก่: • A • B"}
    assert ev._record_answer_mode(cert) == "policy"
    handoff = {"source": "return_refund_ask_order", "handoff_to_admin": True,
               "answer": "แจ้งเลขออเดอร์"}
    assert ev._record_answer_mode(handoff) == "handoff"


def test_gold_metrics():
    g = ev.gold_metrics(ROWS, GOLD)
    assert g["n_gold"] == 3
    assert abs(g["type_purity"] - 0.9) < 1e-9
    assert abs(g["acceptable_hit_rate"] - 1.0) < 1e-9
    assert abs(g["must_not_violation_rate"] - 1.0) < 1e-9
    assert abs(g["status_accuracy"] - 1.0) < 1e-9
    assert abs(g["adequacy_at_1"] - 1.0) < 1e-9
    assert abs(g["answer_mode_accuracy"] - 1.0) < 1e-9


def test_load_results_accepts_json_array_and_matches_message_fallback():
    recs = [{"id": "t200-1", "shop": "S1", "message": "มีหัวชาร์จไหม", "answer": "แนะนำค่ะ", "products": []}]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "results.json"
        path.write_text(json.dumps(recs, ensure_ascii=False), encoding="utf-8")
        loaded = ev.load_results(str(path))
    gold = [dict(GOLD[0], id="different-id")]
    assert ev.gold_metrics(loaded, gold)["n_gold"] == 1


def test_by_intent_groups_matched_records():
    grouped = ev.by_intent(ROWS, GOLD)
    assert set(grouped) == {"recommend", "compatibility"}
    assert grouped["recommend"]["n"] == 1
    assert grouped["compatibility"]["n"] == 2
    assert grouped["compatibility"]["n_gold"] == 2


def test_pool_metrics_accepts_product_count_shape():
    recs = [{"products": 0}, {"products": 2}]
    m = ev.pool_metrics(recs)
    assert m["n"] == 2
    assert m["n_with_products"] == 1
    assert m["avg_pool"] == 2.0
