"""Phase 10B — request-snapshot propagation through the QA search path.

Live canary defect: `app._chat_impl → qa_context(snap=_snap) → search_qa →
_known_brands(snap)` — `snap` was a free variable inside `search_qa`
(NameError → HTTP 500 on the known-brand scope branch, e.g. the
"IMILAB W01 เชื่อมต่อกับ Strava" turn). Commit `6d47ad3` made
`_known_brands` generation-scoped and updated the callsite inside
`search_qa`'s body but never added `snap` to its signature; the two
owning wrappers (`qa_context`, `qa_troubleshoot_tips`) never forwarded
their captured snapshot.

Pins (all exercise the REAL `search_qa` — only leaf data seams stubbed):
- known-brand scope branch must not raise NameError
- explicit snapshot reaches `_known_brands` by object identity
- `qa_context(..., snap=S)` forwards S to `search_qa`'s `_known_brands`
- `qa_troubleshoot_tips(..., snap=S)` forwards S
- omitted snap → `_known_brands` resolves the pointer once (standalone)
- explicit snap → zero extra pointer resolution / zero generated-unit read

Offline: no Mongo, no .env, no embedding model, no provider calls.
"""
from __future__ import annotations

import sys
import time
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# knowledge_base runs load_dotenv(repo/.env) at import — neutralize so no
# real env file is ever read from tests (same seam as phase4b suite).
if "dotenv" not in sys.modules or not hasattr(sys.modules["dotenv"], "load_dotenv"):
    _dotenv = sys.modules.setdefault("dotenv", types.ModuleType("dotenv"))
    _dotenv.load_dotenv = lambda *a, **k: False
else:
    sys.modules["dotenv"].load_dotenv = lambda *a, **k: False

from shopeechat import generation_pointer as _gen  # noqa: E402
from shopeechat import knowledge_base as kb  # noqa: E402
from shopeechat import units as _units  # noqa: E402
from test_legacy_turn_incident_replay import FakeColl, FakeDb  # noqa: E402

GID = "g20261021-120000-a1b2c3d4"


def _pointer_doc(gid: str = GID) -> dict:
    """valid sellable_units_meta.active payload → real EvidenceSnapshot."""
    return {
        "_id": "active", "generation_id": gid,
        "units_collection": f"sellable_units_{gid}",
        "image_texts_collection": f"image_texts_{gid}",
        "units_npz": f"exports/gen/{gid}/unit_embeddings.npz",
        "product_npz": f"exports/gen/{gid}/product_embeddings.npz",
        "units_jsonl": f"exports/gen/{gid}/sellable_units.jsonl",
        "manifest_path": f"exports/gen/{gid}/manifest.json",
        "manifest_sha256": "ab12", "activated_at": "2026-10-21T12:00:00Z",
    }


# docs reaching the `elif known_brand:` branch need `known` empty (no
# model_codes) — every seeded doc then calls `_known_brands(snap)` at the
# topic-brand scope line.
_QA_DOCS = [
    {"_id": "q1", "topic": "Kieslect แบตหมดเร็ว", "q": "นาฬิกาแบตลดไว",
     "a": "x" * 40, "model_codes": [], "item_ids": []},
    {"_id": "q2", "topic": "วิธีใช้งานทั่วไป", "q": "ตั้งค่า",
     "a": "y" * 40, "model_codes": [], "item_ids": []},
]


@pytest.fixture
def qa_env(monkeypatch):
    """Seed kb_qa cache + kill vector path + fake admin DB + units spy.

    search_qa itself stays real — only data-source seams are stubbed:
    _qa_docs (cache seed), _qa_vectors (None → no npz/embed), _admin_db
    (FakeDb), units._units_coll (spy raising → generated brands absent).
    """
    monkeypatch.setenv("USE_QA_KB", "1")
    kb._qa_docs_cache = list(_QA_DOCS)
    kb._qa_docs_ts = time.time()
    kb._brand_cache = None
    monkeypatch.setattr(kb, "_qa_vectors", lambda: None)
    admin = FakeDb({"kb_products": [{"brand": "KB-SEED-BRAND"}]})
    monkeypatch.setattr(kb, "_admin_db", lambda: admin)
    units_reads: list = []
    monkeypatch.setattr(_units, "_units_coll",
                        lambda snap=None: (units_reads.append(
                            snap.generation_id if snap is not None else None)
                            or (_ for _ in ()).throw(RuntimeError("units down"))))
    resolves: list = []
    monkeypatch.setattr(_gen, "resolve_snapshot",
                        lambda *a, **k: resolves.append(1) or None)
    try:
        yield types.SimpleNamespace(units_reads=units_reads, resolves=resolves,
                                    admin=admin)
    finally:
        kb._qa_docs_cache = None
        kb._qa_docs_ts = 0.0
        kb._brand_cache = None


def _spy_known_brands(monkeypatch):
    """Wrap the real _known_brands — records the snap arg, delegates through."""
    calls: list = []
    real = kb._known_brands

    def _spy(snap=_gen.SNAP_UNSET):
        calls.append(snap)
        return real(snap)

    monkeypatch.setattr(kb, "_known_brands", _spy)
    return calls


def _stub_route_empty(monkeypatch):
    """resolve_route → no model codes (conversation_id stays None)."""
    from shopeechat import route_context as _rc
    monkeypatch.setattr(_rc, "resolve_route",
                        lambda *a, **k: types.SimpleNamespace(model_codes=()))


class TestSearchQaSnapshot:
    def test_known_brand_scope_branch_no_nameerror(self, monkeypatch, qa_env):
        """Pre-fix defect: `_known_brands(snap)` inside search_qa raised
        NameError (snap undefined) — the live W01 canary 500."""
        hits = kb.search_qa("นาฬิกาเชื่อมต่อ app ไหม",
                            model_codes=set(), known_brand="imilab",
                            snap=None)
        assert isinstance(hits, list)  # no raise — brand-scope filter ran

    def test_explicit_snap_reaches_known_brands_identically(
            self, monkeypatch, qa_env):
        """The snapshot object passed in must reach _known_brands by identity
        (byte-identical forwarding — no re-resolution, no copy)."""
        snap = _gen.snapshot_from_pointer(_pointer_doc())
        calls = _spy_known_brands(monkeypatch)
        kb.search_qa("นาฬิกาเชื่อมต่อ app ไหม",
                     model_codes=set(), known_brand="imilab", snap=snap)
        assert len(calls) == len(_QA_DOCS), (
            f"expected one _known_brands call per scoped doc, got {len(calls)}")
        assert all(c is snap for c in calls), (
            "_known_brands received a different snapshot object")
        assert qa_env.resolves == [], (
            "explicit snap must not trigger pointer re-resolution")

    def test_qa_context_forwards_snap(self, monkeypatch, qa_env):
        """qa_context owns a request snapshot — it must reach the
        _known_brands call inside search_qa, not just qa_context's own."""
        _stub_route_empty(monkeypatch)
        snap = _gen.snapshot_from_pointer(_pointer_doc())
        calls = _spy_known_brands(monkeypatch)
        # message carries trigger kw ("วิธี/เชื่อมต่อ") + a baseline brand
        # ("qcy") → known_brand set → search_qa enters the scope branch
        kb.qa_context("qcy วิธีเชื่อมต่อ strava ได้ไหม", snap=snap)
        assert len(calls) >= 2, (
            f"expected ≥2 _known_brands calls (qa_context + search_qa), "
            f"got {len(calls)}")
        assert all(c is snap for c in calls), (
            "search_qa did not receive the caller's snapshot")

    def test_qa_troubleshoot_tips_forwards_snap(self, monkeypatch, qa_env):
        _stub_route_empty(monkeypatch)
        snap = _gen.snapshot_from_pointer(_pointer_doc())
        calls = _spy_known_brands(monkeypatch)
        kb.qa_troubleshoot_tips("qcy เชื่อมต่อไม่ได้", snap=snap)
        assert len(calls) >= 2, (
            f"expected ≥2 _known_brands calls, got {len(calls)}")
        assert all(c is snap for c in calls)

    def test_omitted_snap_resolves_once(self, monkeypatch, qa_env):
        """Standalone contract preserved: snap omitted → SNAP_UNSET →
        `_known_brands` resolves the pointer itself (its existing contract —
        once per scoped-doc call, before the per-gen cache check). `search_qa`
        must add zero resolutions of its own."""
        kb.search_qa("นาฬิกาเชื่อมต่อ app ไหม",
                     model_codes=set(), known_brand="imilab")
        assert qa_env.resolves == [1] * len(_QA_DOCS), (
            f"expected 1 resolution per _known_brands call "
            f"({len(_QA_DOCS)}), got {qa_env.resolves}")

    def test_explicit_snap_no_pointer_resolution(self, monkeypatch, qa_env):
        """Explicit snap (incl. captured None) → zero resolve_snapshot calls
        and zero generated-unit reads beyond _known_brands' own contract."""
        snap = _gen.snapshot_from_pointer(_pointer_doc())
        calls = _spy_known_brands(monkeypatch)
        kb.search_qa("นาฬิกาเชื่อมต่อ app ไหม",
                     model_codes=set(), known_brand="imilab", snap=snap)
        assert qa_env.resolves == []
        assert qa_env.units_reads == [GID], (
            "generated-unit read must happen exactly once per the "
            "_known_brands contract")

    def test_captured_none_skips_generated_read(self, monkeypatch, qa_env):
        """captured snap=None → _known_brands never reads units (contract)."""
        kb.search_qa("นาฬิกาเชื่อมต่อ app ไหม",
                     model_codes=set(), known_brand="imilab", snap=None)
        assert qa_env.resolves == []
        assert qa_env.units_reads == []

    def test_snap_is_keyword_only_param(self):
        """Structural pin: `snap` exists on search_qa as keyword-only."""
        import inspect
        p = inspect.signature(kb.search_qa).parameters["snap"]
        assert p.kind is inspect.Parameter.KEYWORD_ONLY
        assert p.default is _gen.SNAP_UNSET

    def test_model_scoped_path_unchanged(self, monkeypatch, qa_env):
        """Pin: docs with non-empty dcodes take the model branch (boost or
        continue) — `_known_brands` is only consulted when dcodes is empty."""
        calls = _spy_known_brands(monkeypatch)
        kb._qa_docs_cache = [
            {"_id": "m1", "topic": "t", "q": "q1", "a": "a" * 40,
             "model_codes": ["X1"], "item_ids": []},
            {"_id": "m2", "topic": "t", "q": "q2", "a": "a" * 40,
             "model_codes": ["OTHER"], "item_ids": []},
        ]
        hits = kb.search_qa("q เชื่อมต่อ", model_codes={"X1"},
                            known_brand="imilab", snap=None)
        assert calls == [], "dcodes non-empty docs must skip _known_brands"
        assert isinstance(hits, list)
