"""Regression coverage for the server-owned global engine selector."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT / "docs" / "test" / "live"))

from test_legacy_turn_incident_replay import _install  # noqa: E402
from shopeechat import app  # noqa: E402


def _greeting(monkeypatch, *, use_v2: bool, use_v3: bool):
    fixture = {"id": "global-engine-selector", "shop": "TestShop", "platform": "shopee",
               "conversation_id": "global-engine-selector-c1", "turns": []}
    _install(monkeypatch, fixture)
    return app.chat(app.ChatRequest(
        message="สวัสดีครับ", shop="TestShop", platform="shopee",
        conversation_id="global-engine-selector-c1", history=[], limit=5,
        simulate_assignment=True, test_source="engine-selector",
        use_v2=use_v2, use_v3=use_v3))


def test_explicit_legacy_selection_is_not_overridden_by_deployment_env(monkeypatch):
    monkeypatch.setenv("USE_CHAT_V3", "1")
    monkeypatch.setenv("USE_LEGACY_CHAT", "0")

    response = _greeting(monkeypatch, use_v2=False, use_v3=False)

    assert response.chat_engine == "legacy"


def test_explicit_v2_selection_is_not_overridden_by_v3_deployment_env(monkeypatch):
    monkeypatch.setenv("USE_CHAT_V3", "1")
    monkeypatch.setenv("USE_LEGACY_CHAT", "1")

    response = _greeting(monkeypatch, use_v2=True, use_v3=False)

    assert response.chat_engine == "v2"
