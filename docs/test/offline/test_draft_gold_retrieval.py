"""Tests for docs/test/draft_gold_retrieval.py."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import draft_gold_retrieval as dg


def test_draft_rows_are_schema_complete_and_deterministic():
    recs = [
        {"id": "b", "topic": "compat_charging", "shop": "ShopB",
         "message": "หัวชาร์จใช้กับ iphone 15 ได้ไหม", "answer": "แนะนำค่ะ",
         "products": [{"item_id": 2, "status": "NORMAL"}]},
        {"id": "a", "topic": "compat_charging", "shop": "ShopA",
         "message": "สายชาร์จใช้กับ iphone 13 ได้ไหม", "answer": "แนะนำค่ะ",
         "products": [{"item_id": 1, "status": "NORMAL"}]},
        {"id": "a2", "topic": "compat_charging", "shop": "ShopA",
         "message": "สายชาร์จใช้กับ iphone 13 ได้ไหม", "answer": "duplicate",
         "products": []},
    ]
    rows = dg.draft_rows(recs, include_manual=False)
    assert [r["id"] for r in rows] == ["a", "b"]
    row = rows[0]
    assert row["intent"] == "compatibility"
    assert row["expected_product_type"] == "charger"
    assert row["expected_subtype"] == "cable"
    assert row["expected_target_device"] == "iphone 13"
    assert row["requires_evidence"] == ["compatibility"]
    assert row["acceptable_item_ids"] == []
    assert row["must_not_item_ids"] == []


def test_explicit_manual_cases_include_mi17_gate():
    rows = dg.draft_rows([])
    by_id = {r["id"]: r for r in rows}
    mi17 = by_id["compat-mi17-history-cable"]
    assert mi17["history"] == [{"role": "user", "text": "มีสายชาร์จไหม"}]
    assert mi17["expected_product_type"] == "charger"
    assert mi17["expected_subtype"] == "cable"
    assert mi17["expected_target_device"] == "mi 17 ultra"
    assert "สินค้าหมดสต็อกทั้งหมด" in mi17["must_not_phrases"]


def test_write_review_data_outputs_browser_rows(tmp_path):
    path = tmp_path / "rows.js"
    recs = [{"id": "a", "answer": "ตอบ", "products": [{"item_id": 1, "name": "สาย"}]}]
    rows = dg.review_rows(recs, [{"id": "a", "message": "ทดสอบ"}], {"1": "https://img.test/1"})
    assert rows[0]["_review"]["answer"] == "ตอบ"
    assert rows[0]["_review"]["products"][0]["item_id"] == 1
    assert rows[0]["_review"]["products"][0]["image"] == "https://img.test/1"
    dg.write_review_data(rows, str(path))
    text = path.read_text(encoding="utf-8")
    assert text.startswith("window.GOLD_DRAFT_ROWS = ")
    assert json.loads(text.removeprefix("window.GOLD_DRAFT_ROWS = ").rstrip(";\n"))[0]["id"] == "a"


def test_load_image_map_reads_export_rows(tmp_path):
    path = tmp_path / "products.json"
    path.write_text(json.dumps([
        {"item_id": 1.0, "images": {"image_url_list": ["https://img.test/1"]}},
        {"item_id": 2, "images": {"image_url_list": ["https://img.test/2"]}},
    ]), encoding="utf-8")
    assert dg._load_image_map(str(path), {"1"}) == {"1": "https://img.test/1"}


def test_apply_review_keeps_approved_and_promotes_corrected(tmp_path):
    path = tmp_path / "review.json"
    path.write_text(json.dumps([
        {"id": "a", "decision": "approved"},
        {"id": "compat-mi17-history-cable", "decision": "rejected",
         "correction": {"correct_answer": "มีสินค้าที่ใช้ร่วมกันได้"}},
        {"id": "test_200_selected100-063", "decision": "rejected",
         "correction": {"correct_answer": "error 429"}},
        {"id": "c", "decision": "pending"},
    ]), encoding="utf-8")
    rows = [
        {"id": "a", "expected_answer_mode": "recommend"},
        {"id": "compat-mi17-history-cable", "expected_answer_mode": "products",
         "acceptable_item_ids": []},
        {"id": "test_200_selected100-063", "expected_answer_mode": "recommend"},
        {"id": "c"},
    ]
    out = dg.apply_review(rows, str(path))
    ids = [r["id"] for r in out]
    assert ids == ["a", "compat-mi17-history-cable"]
    mi17 = out[1]
    assert mi17["acceptable_item_ids"], "corrected Mi17 must carry acceptable ids"
    assert mi17["note"].startswith("corrected:")


def test_conv_gold_rows_builds_history(tmp_path):
    conv = {
        "conv_id": "c1", "shop_name": "ShopX",
        "qa": [
            {"i": 1, "user_text": "มีสายชาร์จไหม", "bot_answer": "มีค่ะ"},
            {"i": 2, "user_text": "ใช้กับ iphone ได้ไหม", "bot_answer": "ได้ค่ะ", "bot_handoff": False},
        ],
    }
    path = tmp_path / "convs.jsonl"
    path.write_text(json.dumps(conv, ensure_ascii=False) + "\n", encoding="utf-8")
    spec = [("c1", 2, {"intent": "compatibility", "expected_answer_mode": "recommend"})]
    rows = dg.conv_gold_rows(str(path), spec)
    assert len(rows) == 1
    row = rows[0]
    assert row["shop"] == "ShopX"
    assert row["message"] == "ใช้กับ iphone ได้ไหม"
    assert row["history"] and row["history"][0]["text"] == "มีสายชาร์จไหม"
    assert row["intent"] == "compatibility"


def test_extra_rows_cover_manual_and_replay_ids():
    recs = [
        {"id": "q081", "topic": "claim", "shop": "ShopA", "source": "return_refund_ask_order",
         "message": "ขอคืนเงินได้ไหม", "answer": "แจ้งเลขออเดอร์"},
        {"id": "x1", "topic": "claim", "shop": "ShopA", "message": "อื่น", "answer": "x"},
    ]
    rows = dg.extra_replay_rows(recs)
    ids = {r["id"] for r in rows}
    assert "q081" in ids and "x1" not in ids
    q081 = next(r for r in rows if r["id"] == "q081")
    assert q081["intent"] == "refund"
    assert "order_history" in q081["requires_evidence"]

    manual_ids = {r["id"] for r in dg.EXTRA_MANUAL}
    assert sum(r.get("expected_answer_mode") == "out_of_stock" for r in dg.EXTRA_MANUAL) >= 3
    assert sum(r.get("expected_catalog_status") in {"unlisted", "discontinued"} for r in dg.EXTRA_MANUAL) >= 3
    assert any("old_order_item" in (r.get("tags") or []) for r in dg.EXTRA_MANUAL)

