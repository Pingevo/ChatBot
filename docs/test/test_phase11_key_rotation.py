"""Phase 11 FIX-1 — dead-key skip ใน gemini key rotation.

Owner-mandated RED spec: fake key list ที่มี failing middle key →
call ต้องสำเร็จด้วย key ถัดไปใน call เดียวกัน และ dead key
ต้องไม่ถูก issue ซ้ำใน process นั้น — offline เท่านั้น:
genai.Client ถูก stub ทั้งหมด ไม่มี network/quota-file I/O.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "chatbot"))

from google.genai import errors as genai_errors  # noqa: E402

from shopeechat import llm  # noqa: E402


def _err(code: int, msg: str) -> genai_errors.ClientError:
    return genai_errors.ClientError(code, {"error": {"message": msg}})


class _FakeModels:
    """generate_content stub — 401 ให้ key ที่อยู่ใน bad set."""

    def __init__(self, calls: list, bad: frozenset):
        self._calls = calls
        self._bad = bad
        self.key = None

    def generate_content(self, *a, **k):
        self._calls.append(self.key)
        if self.key in self._bad:
            raise _err(401, "UNAUTHENTICATED")
        return types.SimpleNamespace(text="ok", usage_metadata=None)


class _FakeClient:
    def __init__(self, api_key, calls, bad):
        self.models = _FakeModels(calls, bad)
        self.models.key = api_key


def _wire(monkeypatch, keys, bad=frozenset(), start: int = 0,
          dead: frozenset = frozenset()):
    """เชื่อม fake pool + client ให้ owner จริง — คืน list ของ key ที่ถูกใช้."""
    calls: list = []
    monkeypatch.setattr(llm, "_active_keys", lambda: list(keys))
    monkeypatch.setattr(llm, "_KEY_INDEX", start)
    monkeypatch.setattr(llm, "_DEAD_KEYS", set(dead), raising=False)
    monkeypatch.setattr(llm, "_acquire", lambda model, est=0: model)
    monkeypatch.setattr(llm, "_record_tokens", lambda *a, **k: None)
    monkeypatch.setattr(
        llm.genai, "Client",
        lambda api_key=None: _FakeClient(api_key, calls, frozenset(bad)))
    return calls


def _gen():
    return llm._generate(
        "fake-model",
        [{"role": "user", "parts": [{"text": "hi"}]}],
        {"max_output_tokens": 8},
        est_tokens=10,
    )


def test_dead_middle_key_skipped_within_same_call(monkeypatch):
    """key ตัวกลางตอบ 401 → call เดียวกันสำเร็จด้วย key ถัดไป."""
    calls = _wire(monkeypatch, ["k0", "k1", "k2"], bad={"k1"}, start=1)
    resp = _gen()
    assert resp.text == "ok"
    assert calls == ["k1", "k2"]          # k1 ล้ม → k2 ใน call เดียวกัน
    assert "k1" in llm._DEAD_KEYS         # mark dead ใน process


def test_dead_key_never_reissued_in_process(monkeypatch):
    """key ที่ mark dead แล้วต้องไม่ถูก rotation เลือกอีก."""
    _wire(monkeypatch, ["k0", "k1", "k2"], start=0, dead={"k1"})
    picks = [llm._next_api_key() for _ in range(6)]
    assert "k1" not in picks
    assert set(picks) == {"k0", "k2"}


def test_all_dead_raises_on_existing_error_path(monkeypatch):
    """ทุก key ตาย → bounded ≤ len(keys) attempts แล้ว error path เดิม."""
    calls = _wire(monkeypatch, ["k0", "k1"], bad={"k0", "k1"}, start=0)
    with pytest.raises(genai_errors.ClientError):
        _gen()
    assert calls == ["k0", "k1"]          # ทุกตัวถูกลอง 1 ครั้ง ไม่เกิน pool
    assert llm._DEAD_KEYS == {"k0", "k1"}
    # pool dead หมด → error path เดียวกับไม่มี key เลย
    with pytest.raises(RuntimeError):
        llm._next_api_key()


def test_non_auth_client_error_not_retried(monkeypatch):
    """error ที่ไม่ใช่ 401/UNAUTHENTICATED → ไม่ retry ไม่ mark dead."""
    calls = _wire(monkeypatch, ["k0", "k1"], start=0)

    def _client_500(api_key=None):
        c = _FakeClient(api_key, calls, frozenset())
        if api_key == "k0":
            def _raise(*a, **k):
                calls.append("k0")
                raise _err(500, "INTERNAL")
            c.models.generate_content = _raise
        return c
    monkeypatch.setattr(llm.genai, "Client", _client_500)
    with pytest.raises(genai_errors.ClientError):
        _gen()
    assert calls == ["k0"]                # ไม่มี retry
    assert "k0" not in getattr(llm, "_DEAD_KEYS", set())


def test_healthy_rotation_order_unchanged(monkeypatch):
    """control — pool ปกติ rotation เดิม round-robin."""
    _wire(monkeypatch, ["k0", "k1", "k2"], start=0)
    assert [llm._next_api_key() for _ in range(4)] == ["k0", "k1", "k2", "k0"]
