"""PART 1.1 — harness-only Gemini retry policy.

Proves: 503 retried with sleeps exactly [5,5,5] (1 attempt + ≤3 retries),
non-503 raises immediately (no retry), 4th consecutive 503 terminates.
Production retry untouched — this exercises the canary wrapper only.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import canary_exact_item_attribution as H          # pure defs — zero patches
from shopeechat import llm


class _StubModels:
    def __init__(self, outcomes):
        self._outcomes = list(outcomes)
        self.calls = 0

    def generate_content(self, *a, **k):
        self.calls += 1
        out = self._outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


class _StubClient:
    def __init__(self, outcomes):
        self.models = _StubModels(outcomes)


def _wrap(monkeypatch, outcomes, sleeps):
    stub = _StubClient(outcomes)
    monkeypatch.setattr(H, "_real_client", lambda: stub)
    monkeypatch.setattr(llm, "_client", H._client)   # seam under monkeypatch → auto-restore
    monkeypatch.setattr("time.sleep", sleeps.append)
    H.counts["gemini"] = 0
    H.counts["attempts"] = 0
    H.counts["e503"] = 0
    H.counts["e429"] = 0
    c = llm._client()          # harness wrapper installs its gen()
    return c, stub


def test_503_retried_with_exact_5_5_5_sleeps(monkeypatch):
    sleeps = []
    c, stub = _wrap(monkeypatch, [
        Exception("503 UNAVAILABLE: overloaded"),
        Exception("503 UNAVAILABLE: overloaded"),
        Exception("503 UNAVAILABLE: overloaded"),
        "OK"], sleeps)
    assert c.models.generate_content(model="m", contents="x") == "OK"
    assert sleeps == [5, 5, 5]
    assert stub.models.calls == 4
    assert H.counts["gemini"] == 1            # one logical call
    assert H.counts["attempts"] == 4          # four physical attempts
    assert H.counts["e503"] == 3


def test_non_503_not_retried(monkeypatch):
    sleeps = []
    c, stub = _wrap(monkeypatch, [Exception("400 INVALID_ARGUMENT")], sleeps)
    with pytest.raises(Exception, match="400"):
        c.models.generate_content(model="m", contents="x")
    assert stub.models.calls == 1
    assert sleeps == []


def test_429_counted_not_retried(monkeypatch):
    sleeps = []
    c, stub = _wrap(monkeypatch, [Exception("429 RESOURCE_EXHAUSTED")], sleeps)
    with pytest.raises(Exception, match="429"):
        c.models.generate_content(model="m", contents="x")
    assert stub.models.calls == 1
    assert sleeps == []
    assert H.counts["e429"] == 1


def test_fourth_503_terminates(monkeypatch):
    sleeps = []
    c, stub = _wrap(monkeypatch, [
        Exception("503 UNAVAILABLE")] * 4 + ["SHOULD_NOT_REACH"], sleeps)
    with pytest.raises(Exception, match="503"):
        c.models.generate_content(model="m", contents="x")
    assert stub.models.calls == 4             # original + 3 retries, stop
    assert sleeps == [5, 5, 5]
    assert H.counts["e503"] == 4


# ── harness import-safety + seam lifecycle (Phase 10B pre-commit gate) ────

def test_harness_import_patches_nothing():
    """module already imported above → no production binding is a spy."""
    import inspect
    from shopeechat import retrieval_runtime as rrt
    from shopeechat import turn_decision as td
    from shopeechat import answer_context as acx
    assert rrt.run_grouped_selection is not H._gs
    assert td.decide_turn is not H._decide
    assert acx.compile_answer_context is not H._ctx
    assert llm._client is not H._client
    assert "needs" in inspect.signature(
        rrt.run_grouped_selection).parameters


def test_harness_import_identity_fresh_process():
    """byte-identical bindings before/after import — proven in a clean proc."""
    import subprocess
    import textwrap
    root = Path(__file__).resolve().parents[2]
    code = textwrap.dedent("""
        import sys
        sys.path.insert(0, %r); sys.path.insert(0, %r)
        from shopeechat import retrieval_runtime as rrt
        from shopeechat import turn_decision as td
        from shopeechat import answer_context as acx
        from shopeechat import llm, web_search as ws
        from shopeechat import conversation_products as cp
        from shopeechat import runtime_config as rcfg
        before = (rrt.run_grouped_selection, td.decide_turn,
                  acx.compile_answer_context, llm.answer, llm._client,
                  cp.get_subject_set, ws.search_and_extract,
                  rcfg.grouped_retrieval_selection_enabled)
        import canary_exact_item_attribution  # noqa: F401
        after = (rrt.run_grouped_selection, td.decide_turn,
                 acx.compile_answer_context, llm.answer, llm._client,
                 cp.get_subject_set, ws.search_and_extract,
                 rcfg.grouped_retrieval_selection_enabled)
        sys.exit(0 if before == after else 1)
    """ % (str(root / "chatbot"), str(root / "docs" / "test")))
    r = subprocess.run([sys.executable, "-c", code],
                       capture_output=True, timeout=120)
    assert r.returncode == 0, r.stderr[-500:]


def test_install_seams_then_restore_normal():
    """install() swaps bindings; restore() reverts every captured one."""
    from shopeechat import retrieval_runtime as rrt
    from shopeechat import turn_decision as td
    from shopeechat import answer_context as acx
    from shopeechat import conversation_products as cp
    before = (rrt.run_grouped_selection, td.decide_turn,
              acx.compile_answer_context, llm._client, llm.answer,
              cp.get_subject_set, cp.load_timeline, cp._coll)
    restore = H.install()
    try:
        assert rrt.run_grouped_selection is H._gs
        assert td.decide_turn is H._decide
        assert acx.compile_answer_context is H._ctx
        assert llm._client is H._client
        assert cp.get_subject_set is H._get
    finally:
        restore()
    after = (rrt.run_grouped_selection, td.decide_turn,
             acx.compile_answer_context, llm._client, llm.answer,
             cp.get_subject_set, cp.load_timeline, cp._coll)
    assert after == before


def test_install_restored_after_injected_exception():
    """the main() try/finally contract: execution failure → full restore."""
    from shopeechat import retrieval_runtime as rrt
    orig = rrt.run_grouped_selection
    restore = H.install()
    try:
        raise RuntimeError("injected canary failure")
    except RuntimeError:
        pass
    finally:
        restore()
    assert rrt.run_grouped_selection is orig


def test_gs_spy_fail_closed_none_passthrough(monkeypatch):
    """legit run_grouped_selection → None must pass through, no out.get."""
    monkeypatch.setattr(H, "_real_gs", lambda *a, **k: None)
    assert H._gs() is None
