"""test_runtime_config.py — Task 5B3-D: runtime config flags จาก admin DB.

pin: DB system_configs.main_config เป็น owner เมื่อ field เป็น bool
· field absent / DB error → env fallback เดิม
· cache TTL 5s; ไม่มี manual reload endpoint
· app.py ไม่เช็ก USE_GROUPED_RETRIEVAL_* env ตรงๆ
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

import pytest  # noqa: E402

from shopeechat import knowledge_base as _kb  # noqa: E402
from shopeechat import runtime_config as rc  # noqa: E402


class _FakeColl:
    def __init__(self, doc=None, exc=None):
        self._doc = doc
        self._exc = exc
        self.calls = 0

    def find_one(self, filt, **kw):
        self.calls += 1
        if self._exc is not None:
            raise self._exc
        return self._doc


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    rc._cache = None
    rc._ts = 0.0
    monkeypatch.delenv("USE_GROUPED_RETRIEVAL_SHADOW", raising=False)
    monkeypatch.delenv("USE_GROUPED_RETRIEVAL_SELECTION", raising=False)
    yield
    rc._cache = None
    rc._ts = 0.0


def _patch_db(monkeypatch, doc=None, exc=None):
    coll = _FakeColl(doc=doc, exc=exc)
    monkeypatch.setattr(_kb, "_admin_db",
                        lambda: {"system_configs": coll})
    return coll


def test_default_false_no_field_no_env(monkeypatch):
    _patch_db(monkeypatch, doc={"config_key": "main_config"})
    assert rc.grouped_retrieval_shadow_enabled() is False
    assert rc.grouped_retrieval_selection_enabled() is False


def test_db_field_true_wins(monkeypatch):
    _patch_db(monkeypatch, doc={
        "config_key": "main_config",
        "grouped_retrieval_shadow_enabled": True,
        "grouped_retrieval_selection_enabled": True,
    })
    assert rc.grouped_retrieval_shadow_enabled() is True
    assert rc.grouped_retrieval_selection_enabled() is True


def test_db_false_beats_env(monkeypatch):
    """DB เป็น owner — เขียน false แล้ว env=1 ต้องไม่ชนะ"""
    _patch_db(monkeypatch, doc={
        "config_key": "main_config",
        "grouped_retrieval_selection_enabled": False,
    })
    monkeypatch.setenv("USE_GROUPED_RETRIEVAL_SELECTION", "1")
    assert rc.grouped_retrieval_selection_enabled() is False


def test_env_fallback_when_field_absent(monkeypatch):
    """doc เก่าไม่มี field → env เดิมยังใช้ได้ (local/dev)"""
    _patch_db(monkeypatch, doc={"config_key": "main_config"})
    monkeypatch.setenv("USE_GROUPED_RETRIEVAL_SELECTION", "1")
    assert rc.grouped_retrieval_selection_enabled() is True
    assert rc.grouped_retrieval_shadow_enabled() is False


def test_env_fallback_when_db_error(monkeypatch):
    _patch_db(monkeypatch, exc=RuntimeError("mongo down"))
    assert rc.grouped_retrieval_selection_enabled() is False
    monkeypatch.setenv("USE_GROUPED_RETRIEVAL_SELECTION", "1")
    assert rc.grouped_retrieval_selection_enabled() is True


def test_db_error_keeps_last_cache(monkeypatch):
    coll = _patch_db(monkeypatch, doc={
        "grouped_retrieval_selection_enabled": True})
    assert rc.grouped_retrieval_selection_enabled() is True
    coll._exc = RuntimeError("mongo down")
    rc._ts = 0.0  # บังคับ re-fetch
    assert rc.grouped_retrieval_selection_enabled() is True  # stale cache


def test_cache_ttl_single_fetch(monkeypatch):
    coll = _patch_db(monkeypatch, doc={
        "grouped_retrieval_shadow_enabled": True})
    rc.grouped_retrieval_shadow_enabled()
    rc.grouped_retrieval_selection_enabled()
    assert coll.calls == 1


def test_cache_refreshes_after_ttl(monkeypatch):
    coll = _patch_db(monkeypatch, doc={
        "grouped_retrieval_selection_enabled": False})
    rc.grouped_retrieval_selection_enabled()
    coll._doc["grouped_retrieval_selection_enabled"] = True
    rc._ts = 0.0  # simulate expired TTL
    assert rc.grouped_retrieval_selection_enabled() is True
    assert coll.calls == 2


def test_no_manual_reload_endpoint():
    """runtime config ใช้ TTL เท่านั้น — ไม่มี endpoint/manual refresh surface"""
    src = (ROOT / "chatbot" / "shopeechat" / "app.py").read_text()
    assert "runtime-config/reload" not in src
    assert "refresh_runtime_config" not in src
    assert not hasattr(rc, "refresh_runtime_config")


def test_app_uses_runtime_config_not_env():
    """app.py ห้ามเช็ก USE_GROUPED_RETRIEVAL_* env ตรงๆ — ผ่าน runtime_config เท่านั้น"""
    src = (ROOT / "chatbot" / "shopeechat" / "app.py").read_text()
    assert 'os.environ.get("USE_GROUPED_RETRIEVAL_SHADOW"' not in src
    assert 'os.environ.get("USE_GROUPED_RETRIEVAL_SELECTION"' not in src
    assert "runtime_config" in src
    assert "grouped_retrieval_shadow_enabled" in src
    assert "grouped_retrieval_selection_enabled" in src
    # lazy import — module top ห้าม import
    head = src[:src.index("def chat")]
    assert "import runtime_config" not in head


def test_no_v2_v3_caller():
    for mod in ("chatbotv2", "chatbotv3"):
        p = ROOT / "chatbot" / "shopeechat" / f"{mod}.py"
        if p.exists():
            assert "runtime_config" not in p.read_text()
