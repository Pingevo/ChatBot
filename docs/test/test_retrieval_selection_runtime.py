"""test_retrieval_selection_runtime.py — Task 5B3-C: flag-gated LLM context.

pin: prepare_grouped_selection contract (merge/fallback/strip/quota/unavailable)
+ app.py callsite gated + lazy + no v2/v3
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402
from shopeechat.units import UnitEvidenceFetchResult  # noqa: E402

AD1404T_MSG = ("หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้างในร้านเรา "
               "ขอแบบมีจอ ยาว 2 เมตรและได้เต็มสปีด")


def _profile(msg=AD1404T_MSG):
    return route_context.build_retrieval_profile(
        msg, history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop="KingGadgets")


def _units_fetcher(adapter_cards, cable_cards):
    def f(message, **kw):
        p = kw["retrieval_profile"]
        docs = cable_cards if p.subtype == "cable" else adapter_cards
        return UnitEvidenceFetchResult(
            cards=tuple(docs), raw_count=len(docs),
            sellable_count=sum(1 for c in docs if c.get("_available_for_sale")),
            unavailable_count=0, trace=("u",))
    return f


def _card(name, ptype, unit_id, item_id=None, avail=True, **kw):
    # stamp resolver fields เหมือน to_unit_card output จริง
    # (ไม่มี → resolver นับ unknown/hidden → canonical ดร็อป)
    c = {"name": name, "product_type": ptype, "_available_for_sale": avail,
         "unit_id": unit_id, "item_id": item_id or unit_id,
         "status": "NORMAL" if avail else "SELLER_DELETE",
         "total_stock": 3 if avail else 0,
         "catalog_status": "active" if avail else "discontinued",
         "customer_visible": True,
         "availability_reason": "" if avail else "sold_out"}
    c.update(kw)
    return c


def _prep(msg=AD1404T_MSG, adapter_cards=(), cable_cards=(), **kw):
    from shopeechat.retrieval_runtime import prepare_grouped_selection
    return prepare_grouped_selection(
        _profile(msg), message=msg, shop="KingGadgets", platform="shopee",
        limit=10,
        fetcher=_units_fetcher(adapter_cards, cable_cards),
        legacy_fetcher=lambda m, **k: [], **kw)


def test_selected_cards_are_the_products():
    # canonical owns context — products = selected_cards เท่านั้น
    adapter = _card("CUKTECH AD1404T หัวชาร์จ", "charger", "ua1",
                    charger_subtype="adapter", model_codes=["AD1404T"])
    cable = _card("CTC620P สายมีจอ OLED 240W", "cable", "up1",
                  cable_subtype="cable", variants=[{"name": "2 เมตร"}])
    out = _prep(adapter_cards=[adapter], cable_cards=[cable])
    assert out and out["products"]
    names = [p.get("name") for p in out["products"]]
    assert names[0] == "CUKTECH AD1404T หัวชาร์จ" or "AD1404T" in names[0]
    assert "CTC620P สายมีจอ OLED 240W" in names


def test_selected_deduped_across_requests():
    # card เดียวกัน eligible ใต้หลาย request → selector ซ้ำได้ →
    # run ต้องคัดซ้ำตาม identity (normalize เหมือน candidate_pool._norm_id)
    # ไม่งั้น LLM เห็นสินค้าซ้ำ (ตอบมั่ว/เสีย quota)
    from shopeechat.retrieval_runtime import prepare_grouped_selection
    shared = _card("shared", "charger", "u1", item_id=123,
                   charger_subtype="adapter", model_codes=["AD1404T"])
    out = prepare_grouped_selection(
        _profile(), message="m", shop="s", limit=10,
        fetcher=lambda m, **kw: UnitEvidenceFetchResult(
            cards=(shared,), raw_count=1, sellable_count=1,
            unavailable_count=0, trace=("u",)),
        legacy_fetcher=lambda m, **k: [])
    names = [p["name"] for p in (out or {}).get("products", [])]
    assert names.count("shared") <= 1


def test_fetcher_error_isolated_returns_empty_not_none():
    # source attempt error ไม่ทำ pipeline ล้ม — รันสำเร็จแต่ selected ว่าง
    # → dict(products=[]) (canonical owns: ว่าง=ว่าง) ไม่ใช่ fallback
    from shopeechat.retrieval_runtime import prepare_grouped_selection

    def boom(message, **kw):
        raise RuntimeError("units exploded")

    out = prepare_grouped_selection(
        _profile(), message="m", shop="s",
        limit=10, fetcher=boom, legacy_fetcher=lambda m, **k: [])
    assert out is not None and out["products"] == []


def test_pipeline_exception_returns_none_fail_closed(monkeypatch):
    # exception ระดับ pipeline (ไม่ใช่ attempt) → None → flag-ON caller fail
    # closed เป็น product context ว่าง (legacy products ไม่ re-enter)
    from shopeechat import retrieval_runtime as rr
    monkeypatch.setattr(
        rr, "build_retrieval_slots",
        lambda p: (_ for _ in ()).throw(RuntimeError("boom")))
    out = rr.run_grouped_selection(
        _profile(), message="m", shop="s",
        fetcher=lambda m, **k: None, legacy_fetcher=lambda m, **k: [])
    assert out is None


def test_selected_cards_stripped_and_role_tagged():
    adapter = _card("AD1404T", "charger", "ua1", charger_subtype="adapter")
    cable = _card("สายมีจอ", "cable", "uc1", cable_subtype="cable",
                  variants=[{"name": "2 เมตร"}])
    out = _prep(adapter_cards=[adapter], cable_cards=[cable])
    for p in out["products"]:
        assert "_evidence" not in p and "_selection_reason" not in p
    target = next(p for p in out["products"]
                  if p.get("name") == "สายมีจอ")
    assert target.get("_context_note")  # role tag ให้ LLM รู้ว่าเป็น target


def test_ad1404t_case_has_both_groups():
    adapter = _card("CUKTECH AD1404T หัวชาร์จ 140W", "charger", "ua1",
                    charger_subtype="adapter", model_codes=["AD1404T"])
    cable = _card("CUKTECH CTC615P/CTC620P สายมีจอ OLED 6A 240W", "cable",
                  "up1", cable_subtype="cable",
                  variants=[{"name": "CTC620P 2 เมตร"}])
    out = _prep(adapter_cards=[adapter], cable_cards=[cable])
    names = [p.get("name") for p in out["products"]]
    assert any("AD1404T" in n for n in names)
    assert any("CTC620P" in n for n in names)
    summ = out["summary"]
    assert summ["selected"]["relation_target"] >= 1
    # Task 5C — card ที่ match code ที่ถาม = "subject" (เดิม "slot")
    assert summ["selected"]["subject"] >= 1


def test_target_quota_not_eaten_by_source():
    adapters = [_card(f"AD1404T v{i}", "charger", f"ua{i}", item_id=f"a{i}",
                      charger_subtype="adapter", model_codes=["AD1404T"])
                for i in range(6)]
    cable = _card("สายมีจอ OLED 240W", "cable", "uc1", cable_subtype="cable",
                  variants=[{"name": "2 เมตร"}])
    out = _prep(adapter_cards=adapters, cable_cards=[cable])
    names = [p.get("name") for p in out["products"]]
    assert "สายมีจอ OLED 240W" in names


def test_unavailable_summary_not_recommendation():
    cable_dead = _card("สายตาย", "cable", "ud1", cable_subtype="cable",
                       avail=False, availability_reason="seller_delete")
    adapter = _card("AD1404T", "charger", "ua1", charger_subtype="adapter")
    out = _prep(adapter_cards=[adapter], cable_cards=[cable_dead])
    names = [p.get("name") for p in out["products"]]
    assert "สายตาย" not in names               # ไม่ใช่ recommendation
    extra = out.get("extra_context") or ""
    assert "สายตาย" in extra                    # แต่เป็น evidence note


def test_empty_selection_returns_empty_products():
    # pipeline รันได้แต่ selected ว่าง → products ว่าง (canonical owns context
    # — ว่าง=ว่าง ไม่ fallback legacy; None สงวนไว้เฉพาะ error)
    out = _prep(adapter_cards=[], cable_cards=[])
    assert out is not None and out["products"] == []


def test_app_callsite_flag_gated_lazy():
    src = (ROOT / "chatbot" / "shopeechat" / "app.py").read_text()
    # Task 5B3-D — flag ผ่าน runtime_config (DB owner + env fallback ข้างใน)
    flag_fn = "grouped_retrieval_selection_enabled"
    assert flag_fn in src
    assert 'os.environ.get("USE_GROUPED_RETRIEVAL_SELECTION"' not in src
    head = src[:src.index("def chat")]
    assert "import retrieval_runtime" not in head
    assert "from . import retrieval_runtime" not in head
    assert "import runtime_config" not in head
    idx = src.index(flag_fn)
    window = src[max(0, idx - 400):idx + 1500]
    assert "import runtime_config" in window
    assert "retrieval_runtime" in window
    assert "run_grouped_selection" in window
    assert "try:" in window and "except" in window
    # flag ON → canonical selected แทน products ที่ llm.answer callsites
    # — ห้าม merge base legacy (UNLIST re-entry) — ทั้ง KB path + main
    assert "merge_selected_products" not in src
    assert src.count('selected_cards"][:') >= 2
    assert "_grouped_sel" in window


def test_no_v2_v3_caller():
    for mod in ("chatbotv2", "chatbotv3"):
        p = ROOT / "chatbot" / "shopeechat" / f"{mod}.py"
        if p.exists():
            src = p.read_text()
            assert "retrieval_runtime" not in src
            assert "prepare_grouped_selection" not in src

def test_identity_keys_fallback_unit_model():
    # card ไม่มี item_id → identity keys fallback unit_id/model_id
    # (ใช้ใน dedupe ของ run_grouped_selection — card เดียวกันหลาย request)
    from shopeechat.retrieval_runtime import _identity_keys
    assert _identity_keys({"unit_id": "u1"}) == ["u:u1"]
    assert _identity_keys({"model_id": "m9"}) == ["m:m9"]
    assert _identity_keys({"item_id": 123.0}) == ["i:123"]


def test_identity_keys_blank_fields_are_not_identity():
    # hardening 5E: "" / whitespace ไม่ใช่ identity จริง — ห้ามสร้าง key
    # (card id ว่างห้ามถูก dedupe กันเอง)
    from shopeechat.retrieval_runtime import _identity_keys
    assert _identity_keys({"item_id": ""}) == []
    assert _identity_keys({"unit_id": ""}) == []
    assert _identity_keys({"model_id": "  "}) == []
    assert _identity_keys({}) == []
