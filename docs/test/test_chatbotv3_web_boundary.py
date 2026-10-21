"""Phase 10A review finding H2 — v3 OpenRouter `:online` bypass (RED tests).

Contract: `main_config.web_search_enabled !== true` → no model/API
request may use `:online` or a web-search plugin on ANY engine.
chatbotv3 `call_or` is the shared model-selection/provider boundary —
it must sanitize the model id before the request payload is built.
Normal offline v3 answering must still occur (exactly one provider call).
"""
from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import runtime_config  # noqa: E402
from shopeechat.chatbotv3 import or_client  # noqa: E402

ONLINE = "google/gemini-2.5-flash:online"
OFFLINE = "google/gemini-2.5-flash"


@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    import socket
    monkeypatch.setattr(
        socket.socket, "connect",
        lambda *a, **k: pytest.fail("OFFLINE LEAK: socket.connect",
                                    pytrace=False))
    yield


def _capture_or(monkeypatch):
    """capture the exact provider payload; fake one key + one HTTP ok."""
    captured: list[dict] = []
    monkeypatch.setattr(or_client, "_API_KEYS", ["k1"])
    monkeypatch.setattr(or_client, "_KEY_CYCLE", itertools.cycle(["k1"]))

    def _urlopen(req, timeout=None):
        p = json.loads(req.data.decode("utf-8"))
        if "messages" in p:      # AI Usage Hub log payload ไม่มี messages
            captured.append(p)

        class _R:
            def read(self):
                return json.dumps({
                    "choices": [{"message": {"content": "ok"}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                }).encode()
        return _R()
    monkeypatch.setattr(or_client.urllib.request, "urlopen", _urlopen)
    return captured


def test_v3_online_model_sanitized_when_web_search_off(monkeypatch):
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: False)
    captured = _capture_or(monkeypatch)
    or_client.call_or(model=ONLINE, system="s", user="u")
    assert captured and captured[0]["model"] == OFFLINE, (
        "web_search_enabled=False → provider payload ต้องไม่ใช้ :online")
    assert "plugins" not in captured[0]


def test_v3_online_model_allowed_when_web_search_on(monkeypatch):
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: True)
    captured = _capture_or(monkeypatch)
    or_client.call_or(model=ONLINE, system="s", user="u")
    assert captured and captured[0]["model"] == ONLINE


def test_v3_toggle_error_fails_closed(monkeypatch):
    def _boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(runtime_config, "web_search_enabled", _boom)
    captured = _capture_or(monkeypatch)
    or_client.call_or(model=ONLINE, system="s", user="u")
    assert captured and captured[0]["model"] == OFFLINE


def test_v3_offline_model_untouched_when_off(monkeypatch):
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: False)
    captured = _capture_or(monkeypatch)
    or_client.call_or(model=OFFLINE, system="s", user="u")
    assert captured and captured[0]["model"] == OFFLINE


def test_v3_offline_answer_occurs_exactly_once_when_off(monkeypatch):
    """web OFF → normal v3 answering still works — one provider call,
    sanitized model, answer returned."""
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: False)
    captured = _capture_or(monkeypatch)
    result = or_client.call_or(model=ONLINE, system="s", user="u")
    assert result["answer"] == "ok"
    assert len(captured) == 1
    assert captured[0]["model"] == OFFLINE


# ── audit H2 — llm._openrouter_generate must share ONE sanitize owner ───────

def _capture_llm_or(monkeypatch):
    """capture llm._openrouter_generate payload — fake key + mocked HTTP."""
    import urllib.request as _u
    from shopeechat import web_search as _ws
    from shopeechat import llm as _llm
    captured: list[dict] = []
    monkeypatch.setattr(_ws, "_get_openrouter_key", lambda: "k1")
    monkeypatch.setattr(_ws, "_get_openrouter_base",
                        lambda: "https://openrouter.ai/api/v1")

    def _urlopen(req, timeout=None):
        captured.append(json.loads(req.data.decode("utf-8")))

        class _R:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps({
                    "choices": [{"message": {"content": "ok"}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                }).encode()
        return _R()
    monkeypatch.setattr(_u, "urlopen", _urlopen)
    return captured, _llm


def test_llm_openrouter_off_strips_online(monkeypatch):
    """OFF → terminal :online ถูก strip ก่อน payload — llm boundary
    ต้องเชื่อ toggle เดียวกับ call_or"""
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: False)
    captured, _llm = _capture_llm_or(monkeypatch)
    _llm._openrouter_generate(ONLINE, "u", {})
    assert captured and captured[0]["model"] == OFFLINE, (
        "web_search_enabled=False → llm OpenRouter payload ต้องไม่ใช้ :online")


def test_llm_openrouter_toggle_error_strips_online(monkeypatch):
    def _boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(runtime_config, "web_search_enabled", _boom)
    captured, _llm = _capture_llm_or(monkeypatch)
    _llm._openrouter_generate(ONLINE, "u", {})
    assert captured and captured[0]["model"] == OFFLINE


def test_llm_openrouter_on_preserves_online(monkeypatch):
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: True)
    captured, _llm = _capture_llm_or(monkeypatch)
    _llm._openrouter_generate(ONLINE, "u", {})
    assert captured and captured[0]["model"] == ONLINE


def test_llm_openrouter_offline_model_unchanged(monkeypatch):
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: False)
    captured, _llm = _capture_llm_or(monkeypatch)
    _llm._openrouter_generate(OFFLINE, "u", {})
    assert captured and captured[0]["model"] == OFFLINE


def test_shared_owner_strips_terminal_suffix_only(monkeypatch):
    """owner เดียว — strip เฉพาะ terminal :online; ค่าอื่น byte-identical;
    ค่าที่ไม่ใช่ True แท้ → OFF"""
    san = runtime_config.sanitize_or_model
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: False)
    assert san("google/x:online") == "google/x"
    assert san("google/x") == "google/x"
    assert san("google/x:onliney") == "google/x:onliney"
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: True)
    assert san("google/x:online") == "google/x:online"
    # switch ไม่ใช่ True แท้ (malformed truthy) → OFF เช่นกัน
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: "yes")
    assert san("google/x:online") == "google/x"


def test_call_or_routes_through_shared_owner(monkeypatch):
    """behavioral pin — call_or ต้องผ่าน owner เดียว (mock owner →
    payload model เปลี่ยนตาม) ไม่ใช่ inline strip ของตัวเอง"""
    monkeypatch.setattr(runtime_config, "sanitize_or_model",
                        lambda m: "SENTINEL-MODEL")
    captured = _capture_or(monkeypatch)
    or_client.call_or(model=ONLINE, system="s", user="u")
    assert captured and captured[0]["model"] == "SENTINEL-MODEL"


def test_llm_routes_through_shared_owner(monkeypatch):
    monkeypatch.setattr(runtime_config, "sanitize_or_model",
                        lambda m: "SENTINEL-MODEL")
    captured, _llm = _capture_llm_or(monkeypatch)
    _llm._openrouter_generate(ONLINE, "u", {})
    assert captured and captured[0]["model"] == "SENTINEL-MODEL"
