"""Task 4C wiring pins — `retrieval_profile` param exists on legacy gateways
and app.py passes the one `_retrieval_profile` through, WITHOUT any callee
using it to filter/rank/select (observe-only plumbing)."""

from __future__ import annotations

import inspect
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "chatbot" / "shopeechat"
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import device_compat, knowledge_base, product_store, units, web_search  # noqa: E402


def _sig(fn) -> inspect.Parameter | None:
    return inspect.signature(fn).parameters.get("retrieval_profile")


@pytest.mark.parametrize("fn", [
    product_store.fetch_products,
    units.fetch_units,
    units.fetch_unit_cards,
    knowledge_base.lookup_kb,
    knowledge_base.qa_context,
    device_compat._device_spec_lookup,
    web_search.reanswer,
], ids=["fetch_products", "fetch_units", "fetch_unit_cards", "lookup_kb",
        "qa_context", "_device_spec_lookup", "reanswer"])
def test_gateway_accepts_retrieval_profile(fn):
    p = _sig(fn)
    assert p is not None, f"{fn.__name__} missing retrieval_profile param"
    assert p.default is None


def test_retrieval_profile_is_last_param():
    for fn in (product_store.fetch_products, device_compat._device_spec_lookup,
               web_search.reanswer, knowledge_base.qa_context):
        params = list(inspect.signature(fn).parameters)
        assert params[-1] == "retrieval_profile", f"{fn.__name__}: not last"


def test_fetch_unit_cards_forwards_profile(monkeypatch):
    seen = {}

    def _fake_fetch_units(message, **kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(units, "fetch_units", _fake_fetch_units)
    sentinel = object()
    units.fetch_unit_cards("สายชาร์จ", retrieval_profile=sentinel)
    assert seen.get("retrieval_profile") is sentinel


def test_profile_not_read_in_gateways():
    """No callee may read profile fields yet — pass-through/debug only."""
    pat = re.compile(r"retrieval_profile\.")
    for name in ("product_store", "units", "knowledge_base", "device_compat", "web_search"):
        src = (SRC / f"{name}.py").read_text()
        hits = pat.findall(src)
        assert not hits, f"{name}.py reads retrieval_profile fields ({len(hits)}x)"


def test_profile_forwarded_in_internal_calls():
    """Callees that re-query products/KB must forward the same object."""
    for name in ("product_store", "device_compat", "web_search"):
        src = (SRC / f"{name}.py").read_text()
        assert "retrieval_profile=retrieval_profile" in src, f"{name}.py no forward"


def test_app_passes_profile_to_all_legacy_callsites():
    src = (SRC / "app.py").read_text()
    # 15 legacy callsites: lookup_kb×2, fetch_products×8, _device_spec_lookup×2,
    # qa_context×1, reanswer×2
    n = src.count("retrieval_profile=_retrieval_profile")
    assert n >= 15, f"app.py passes _retrieval_profile at {n} sites (want >=15)"


def test_v2_v3_untouched():
    for f in SRC.rglob("*.py"):
        if "chat_v2" in f.name or "chatbotv3" in str(f):
            assert "retrieval_profile" not in f.read_text(), f"{f} touched"
