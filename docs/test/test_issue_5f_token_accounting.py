"""test_issue_5f_token_accounting.py — Phase 5F-E: token accounting + web_search gate.

Audit findings (traced จริง):
1) ไม่มี double-count — resp.usage = billable total เดียว, steps = debug breakdown
   UI/DB/replay ใช้ usage.total ตรงๆ ไม่เคยบวก steps ซ้ำ
2) KB+web_search branch under-counts: usage_info = _ws_r["usage"] ทับ LLM1 ทิ้ง
   และ cost ไม่รวม _ws_cost — product_store branch ทำถูก (_combined_usage + cost+_ws_cost)
   → fix: _sum_usage helper + เพิ่ม _ws_cost เข้า cost (contract เดียวกัน)
3) should_use_web_search rule pass1_low_confidence ยิงแม้มี products + คำตอบมั่นใจ
   → fix: low conf เพียงอย่างเดียวไม่พอ — มี products แล้วข้าม (negative answer → rule 5 จัดการ)
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import app as _app  # noqa: E402
from shopeechat import llm, web_search as ws  # noqa: E402


# ---------- accounting contract ----------

def test_sum_usage_combines_llm1_llm2():
    """billable usage = LLM1 + LLM2 (steps ไม่เข้ามาเกี่ยว — debug only)."""
    u1 = {"prompt": 1000, "output": 200, "total": 1200}
    u2 = {"prompt": 800, "output": 100, "total": 900}
    assert _app._sum_usage(u1, u2) == {"prompt": 1800, "output": 300, "total": 2100}
    # dict เดิมไม่ถูกแก้
    assert u1["prompt"] == 1000


def test_sum_usage_missing_keys_default_zero():
    assert _app._sum_usage({}, {"prompt": 5}) == {
        "prompt": 5, "output": 0, "total": 0}


def test_kb_branch_combines_usage_not_replace():
    """KB+web_search path ต้องรวม LLM1+LLM2 เหมือน product_store path —
    pin ด้วย source scan (chat() ต้องการ Mongo+LLM จริง ทดสอบตรงไม่ได้)."""
    src = Path(_app.__file__).read_text()
    # KB branch (knowledge_base+mongo): usage_info ต้องถูก merge ไม่ใช่ overwrite
    kb_block = src[src.index("_kb_should_search"):src.index("_kb_source =")]
    assert "_sum_usage(" in kb_block, (
        "KB branch ยัง overwrite usage_info — LLM1 tokens หายจาก billable usage")
    assert "_ws_cost" in src[src.index("cost = llm._gemini_cost(prompt_t, output_t)"):src.index("_kb_source =")], (
        "KB branch cost ยังไม่รวม _ws_cost — search cost หายจาก resp.cost")


def test_reanswer_usage_is_llm2_only(monkeypatch):
    """contract: reanswer().usage = LLM2 tokens; search-call tokens อยู่ steps."""
    monkeypatch.setattr(ws, "is_configured", lambda: True)
    monkeypatch.setattr(ws, "search_and_extract", lambda **kw: {
        "search_used": True, "model": "openrouter-x", "elapsed": 0.1,
        "cost_usd": 0.001, "keywords": ["k1"],
        "search_info": "ข้อมูลจากเว็บยาวพอ " * 5, "product_type": "",
        "usage": {"prompt": 11, "output": 22, "total": 33}})
    monkeypatch.setattr(llm, "answer", lambda **kw: (
        "คำตอบใหม่", {"prompt": 100, "output": 50, "total": 150}))
    r = ws.reanswer(
        db=None, llm_ctx_limit=5, search_message="q", llm_message="q",
        products_in=[{"name": "P", "item_id": 1}], reason="t", shop="s",
        platform="shopee", history_list=[], persona_extra="",
        intent_result={}, vision_context="",
        do_kb_lookup=False, do_model_code_regex=False, do_dedup_rerank=False)
    assert r["usage"] == {"prompt": 100, "output": 50, "total": 150}
    search_step = r["steps"][0]
    assert search_step["name"] == "Search"
    assert search_step["tokens_in"] == 11 and search_step["tokens_out"] == 22


# ---------- web_search gating ----------

@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(ws, "is_configured", lambda: True)


def test_low_confidence_with_products_no_search():
    """conf ต่ำ + มี products + คำตอบมั่นใจ → catalog พอ ไม่ search."""
    should, reason = ws.should_use_web_search(
        answer="รุ่นนี้สเปคดีค่ะ รายละเอียดครบตามข้อมูลสินค้า",
        intent_result={"confidence": 0.3, "intent": "product_info"},
        products=[{"name": "X"}],
        message="รุ่นนี้เป็นยังไงบ้าง",
    )
    assert not should, f"low conf อย่างเดียวไม่ควร search (reason={reason})"


def test_low_confidence_no_products_still_search():
    """conf ต่ำ + ไม่มี products → fallback search ยังทำงาน."""
    should, reason = ws.should_use_web_search(
        answer="รุ่นนี้สเปคดีค่ะ",
        intent_result={"confidence": 0.3, "intent": "product_info"},
        products=[],
        message="รุ่นนี้เป็นยังไงบ้าง",
    )
    assert should and "low_confidence" in reason


def test_low_confidence_negative_answer_still_search():
    """conf ต่ำ + มี products แต่คำตอบติดลบ → ยัง search (ผ่าน rule negative)."""
    should, reason = ws.should_use_web_search(
        answer="ขออภัยค่ะ ไม่มีข้อมูลรุ่นนี้ในระบบเลย",
        intent_result={"confidence": 0.3, "intent": "product_info"},
        products=[{"name": "X"}],
        message="รุ่นนี้เป็นยังไงบ้าง",
    )
    assert should


def test_high_confidence_with_products_no_search():
    """ปกติ: conf สูง + มีสินค้า + ตอบมั่นใจ → ไม่ search (คงเดิม)."""
    should, _ = ws.should_use_web_search(
        answer="รุ่นนี้สเปคดีค่ะ",
        intent_result={"confidence": 0.9, "intent": "product_info"},
        products=[{"name": "X"}],
        message="รุ่นนี้เป็นยังไงบ้าง",
    )
    assert not should


# ---------- 5F-F sticker/noise gate ----------

@pytest.mark.parametrize("msg", [
    "[สติกเกอร์]", "[sticker]", "[รูปภาพ]", "[สติกเกอร์] [สติกเกอร์]",
    "[item]", "[สินค้า: 12345]", "",
])
def test_placeholder_only_message_no_search(msg):
    """ข้อความ placeholder/สติกเกอร์ล้วน (ไม่มีคำถามจริง) → ไม่ search external.
    conf ต่ำ + ไม่มี products ก็ตาม — noise ไม่ใช่ query."""
    should, reason = ws.should_use_web_search(
        answer="ขออภัยค่ะ ไม่แน่ใจว่าต้องการสอบถามเรื่องใด",
        intent_result={"confidence": 0.2, "intent": "other"},
        products=[],
        message=msg,
    )
    assert not should, f"placeholder/noise {msg!r} ไม่ควร trigger search (reason={reason})"


def test_placeholder_with_real_question_still_searchable():
    """placeholder + คำถามจริงต่อท้าย → flow ปกติ (gate ไม่กว้างเกิน)."""
    should, reason = ws.should_use_web_search(
        answer="ขออภัยค่ะ ไม่มีข้อมูลรุ่นนี้เลย",
        intent_result={"confidence": 0.3, "intent": "other"},
        products=[],
        message="[รูปภาพ] รุ่นนี้ใช้กับเครื่องอะไรได้บ้าง",
    )
    assert should, "มีคำถามจริง + ไม่มี products + ตอบติดลบ → search ต้องยังทำงาน"
