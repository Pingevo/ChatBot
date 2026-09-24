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
    c = {"name": name, "product_type": ptype, "_available_for_sale": avail,
         "unit_id": unit_id, "item_id": item_id or unit_id,
         "availability_reason": "" if avail else "sold_out"}
    c.update(kw)
    return c


def _prep(msg=AD1404T_MSG, adapter_cards=(), cable_cards=(),
          base_products=(), **kw):
    from shopeechat.retrieval_runtime import prepare_grouped_selection
    return prepare_grouped_selection(
        _profile(msg), message=msg, shop="KingGadgets", platform="shopee",
        base_products=list(base_products), limit=10,
        fetcher=_units_fetcher(adapter_cards, cable_cards),
        legacy_fetcher=lambda m, **k: [], **kw)


def test_selected_first_then_base_merged():
    adapter = _card("CUKTECH AD1404T หัวชาร์จ", "charger", "ua1",
                    charger_subtype="adapter", model_codes=["AD1404T"])
    cable = _card("CTC620P สายมีจอ OLED 240W", "cable", "up1",
                  cable_subtype="cable", variants=[{"name": "2 เมตร"}])
    base = [_card("สินค้า legacy เดิม", "charger", None, item_id="b1")]
    out = _prep(adapter_cards=[adapter], cable_cards=[cable],
                base_products=base)
    assert out and out["products"]
    names = [p.get("name") for p in out["products"]]
    assert names[0] == "CUKTECH AD1404T หัวชาร์จ" or "AD1404T" in names[0]
    assert "CTC620P สายมีจอ OLED 240W" in names
    assert "สินค้า legacy เดิม" in names          # base ไม่หาย
    # selected (adapter+cable) ต้องมาก่อน base legacy
    assert names.index("CTC620P สายมีจอ OLED 240W") \
        < names.index("สินค้า legacy เดิม")


def test_same_item_deduped_selected_wins():
    adapter = _card("AD1404T unit", "charger", "ua1", item_id="i1",
                    charger_subtype="adapter", model_codes=["AD1404T"])
    base = [_card("AD1404T legacy listing", "charger", None, item_id="i1")]
    out = _prep(adapter_cards=[adapter], base_products=base)
    names = [p.get("name") for p in out["products"]]
    assert "AD1404T unit" in names
    assert "AD1404T legacy listing" not in names  # selected ชนะ item เดียวกัน


def test_merge_dedupes_float_int_item_id():
    # selected item_id=123 (int) vs base 123.0 (float) / "123.0" (float-str)
    # — ต้อง normalize เหมือน candidate_pool._norm_id ไม่งั้น duplicate หลุดเข้า LLM
    from shopeechat.retrieval_runtime import merge_selected_products
    out = merge_selected_products(
        [{"name": "selected", "item_id": 123}],
        [{"name": "base-float", "item_id": 123.0},
         {"name": "base-fstr", "item_id": "123.0"},
         {"name": "base-other", "item_id": 456}],
        limit=10)
    names = [p["name"] for p in out]
    assert names == ["selected", "base-other"]


def test_error_returns_none_fallback():
    from shopeechat.retrieval_runtime import prepare_grouped_selection

    def boom(message, **kw):
        raise RuntimeError("units exploded")

    out = prepare_grouped_selection(
        _profile(), message="m", shop="s", base_products=[{"name": "b"}],
        limit=10, fetcher=boom, legacy_fetcher=lambda m, **k: [])
    assert out is None or not out.get("products") or \
        out["products"] == [{"name": "b"}]


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
    assert summ["selected"]["slot"] >= 1


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


def test_empty_selection_returns_none():
    out = _prep(adapter_cards=[], cable_cards=[],
                base_products=[{"name": "b"}])
    assert out is None or out["products"] == [{"name": "b"}]


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
    # merge ที่ llm.answer callsites — ต้องมีอย่างน้อย 2 จุด (KB path + main)
    assert src.count("merge_selected_products") >= 2
    assert "_grouped_sel" in window


def test_no_v2_v3_caller():
    for mod in ("chatbotv2", "chatbotv3"):
        p = ROOT / "chatbot" / "shopeechat" / f"{mod}.py"
        if p.exists():
            src = p.read_text()
            assert "retrieval_runtime" not in src
            assert "prepare_grouped_selection" not in src
