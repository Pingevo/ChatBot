"""test_retrieval_shadow.py — Task 5B3-A: shadow wiring contract tests.

pin: helper เรียก pipeline ตามลำดับ · error ไม่ล้ม · summary ไม่มี private
keys · app.py callsite gated ด้วย flag + lazy import เท่านั้น
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402


def _profile(msg="มีเคส iPhone 15 ไหม", intent="product_recommend"):
    return route_context.build_retrieval_profile(
        msg, history=[],
        intent_result={"intent": intent, "confidence": 0.9},
        shop="KingGadgets")


def _walk_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _walk_keys(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _walk_keys(v)


def test_shadow_calls_pipeline_in_order():
    from shopeechat import retrieval_shadow as rs
    calls = []

    class _Spy:
        def __init__(self, name, ret):
            self.name, self.ret = name, ret

        def __call__(self, *a, **kw):
            calls.append(self.name)
            return self.ret

    prof = _profile()
    fake_pool = type("P", (), {
        "eligible": (), "unavailable": (), "rejected": (),
        "by_request": (), "evidence_pool": (), "trace": ()})()
    names = ("build_retrieval_slots", "build_retrieval_relations",
             "build_grouped_retrieval_requests",
             "execute_grouped_retrieval_requests", "build_candidate_pool")
    orig = {n: getattr(rs, n) for n in names}
    try:
        rs.build_retrieval_slots = _Spy("slots", ())
        rs.build_retrieval_relations = _Spy("relations", ())
        rs.build_grouped_retrieval_requests = _Spy("requests", ())
        rs.execute_grouped_retrieval_requests = _Spy("executor", ())
        rs.build_candidate_pool = _Spy("pool", fake_pool)
        out = rs.run_grouped_retrieval_shadow(prof, message="m", shop="s")
    finally:
        for n, fn in orig.items():
            setattr(rs, n, fn)
    assert calls == ["slots", "relations", "requests", "executor", "pool"]
    assert out["ok"] is True


def test_shadow_uses_legacy_union():
    from shopeechat import retrieval_shadow as rs
    seen = {}
    orig = rs.execute_grouped_retrieval_requests

    def spy(*a, **kw):
        seen.update(kw)
        return ()

    rs.execute_grouped_retrieval_requests = spy
    try:
        rs.run_grouped_retrieval_shadow(_profile(), message="m", shop="s")
    finally:
        rs.execute_grouped_retrieval_requests = orig
    assert seen.get("legacy_fetcher") == "auto"


def test_shadow_error_returns_not_raises():
    from shopeechat import retrieval_shadow as rs
    orig = rs.build_retrieval_slots

    def boom(*a, **kw):
        raise RuntimeError("slots exploded")

    rs.build_retrieval_slots = boom
    try:
        out = rs.run_grouped_retrieval_shadow(_profile(), message="m", shop="s")
    finally:
        rs.build_retrieval_slots = orig
    assert out["ok"] is False and "slots exploded" in out["error"]


def test_shadow_summary_shape_and_counts():
    from shopeechat import retrieval_shadow as rs
    from shopeechat.units import UnitEvidenceFetchResult

    def units_fetcher(message, **kw):
        return UnitEvidenceFetchResult(
            cards=({"name": "เคสทดสอบ", "product_type": "case",
                    "_available_for_sale": True, "item_id": "1",
                    "unit_id": "u1"},),
            raw_count=1, sellable_count=1, unavailable_count=0, trace=("u",))

    out = rs.run_grouped_retrieval_shadow(
        _profile(), message="m", shop="KingGadgets",
        fetcher=units_fetcher, legacy_fetcher=lambda m, **kw: [])
    assert out["ok"] is True
    assert out["request_count"] >= 1
    assert out["counts"]["eligible"] >= 1
    assert {a["source"] for a in out["attempts"]} == {"units", "legacy"}
    assert out["top_eligible"][0]["name"] == "เคสทดสอบ"
    assert set(out["by_request"]) == {
        r["request_id"] for r in out["requests"]} or out["by_request"]


def test_shadow_summary_has_no_private_keys():
    from shopeechat import retrieval_shadow as rs
    from shopeechat.units import UnitEvidenceFetchResult

    def units_fetcher(message, **kw):
        return UnitEvidenceFetchResult(
            cards=({"name": "x", "product_type": "case",
                    "_available_for_sale": True,
                    "_evidence": {"sources": ["units"]},
                    "_selection_reason": "ok"},),
            raw_count=1, sellable_count=1, unavailable_count=0, trace=("u",))

    out = rs.run_grouped_retrieval_shadow(
        _profile(), message="m", shop="s",
        fetcher=units_fetcher, legacy_fetcher=lambda m, **kw: [])
    keys = set(_walk_keys(out))
    assert "_evidence" not in keys
    assert "_selection_reason" not in keys
    assert "history" not in keys  # ไม่ log PII


def test_app_callsite_is_flag_gated_and_lazy():
    """static pin: callsite เดียวใน app.py ต้องอยู่หลัง env flag + lazy import"""
    src = (ROOT / "chatbot" / "shopeechat" / "app.py").read_text()
    flag = "USE_GROUPED_RETRIEVAL_SHADOW"
    assert src.count(flag) >= 1
    # module top ต้องไม่ import retrieval_shadow — flag off = zero cost
    head = src[:src.index("def chat")]
    assert "import retrieval_shadow" not in head
    assert "from . import retrieval_shadow" not in head
    # callsite ต้อง gated ด้วย flag + lazy import ในบล็อกเดียวกัน
    idx = src.index(flag)
    window = src[idx:idx + 1200]
    assert '== "1"' in window
    assert "retrieval_shadow" in window
    assert "run_grouped_retrieval_shadow" in window
    assert "try:" in window and "except" in window
    # step input ห้าม log message เต็ม (PII) — ใช้ metadata ปลอดภัย
    assert '"message": req.message' not in window
    assert "message_len" in window


def test_no_v2_v3_caller():
    """shadow pipeline ห้ามถูกเรียกจาก v2/v3"""
    for mod in ("chatbotv2", "chatbotv3"):
        p = ROOT / "chatbot" / "shopeechat" / f"{mod}.py"
        if p.exists():
            src = p.read_text()
            assert "retrieval_shadow" not in src
            assert "candidate_pool" not in src
            assert "execute_grouped_retrieval" not in src
