"""conftest.py — docs/test offline boundary.

Suites under docs/test run offline (no mongod, no network — probes
install their own socket/Mongo tripwires).

Two boundary jobs, in order:

1) .env must never be opened. `shopeechat.knowledge_base` runs
   `_load_env()` → `load_dotenv(<repo>/.env)` at module import, and this
   conftest must import that module to pin the Mongo stub. Production
   code may read `.env` on a developer machine; the offline suite must
   not. `dotenv.load_dotenv` is therefore replaced by a recording no-op
   BEFORE any shopeechat import — every later `from dotenv import
   load_dotenv` (knowledge_base, app, order_store, ...) binds the stub.
   Calls are recorded in `DOTENV_CALLS` so a test can assert the stub
   caught them and that the real loader never ran.

2) Production paths that read admin Mongo per call —
   `runtime_config.get_runtime_config()` (5s TTL → `_fetch` →
   `system_configs.find_one` via `knowledge_base._admin_db()`), reached
   from `execute_grouped_retrieval_requests` → `source_enabled` —
   otherwise block every expiry in pymongo server selection (~30s ×
   retryReads ≈ 60s with no server), which makes multi-file pytest
   batches appear hung at 0% CPU.

   Stub `_cached_admin_client` (not `_admin_db` — tests wire fakes at the
   client level via `knowledge_base._cached_admin_client` and at the
   function level via `_admin_db`; a client-level stub is the floor both
   override). The fake returns empty collections → `_fetch` gets `None`
   → `{}` → all `pool_sources` ON / `kb_source="legacy"` — identical
   semantics to a fresh Mongo with no config doc. Reads answer "empty";
   any other op (writes, unknown calls) raises loudly so a test can
   never pass on a silent fake success.

   Scope: this stub only covers the ambient admin-config reads every
   grouped/selection test transits. Tests that exercise DB-failure or
   readiness semantics inject their own client/`_admin_db` double via
   monkeypatch (which wins — it patches the same attribute after this
   fixture installs the floor). A module that intentionally needs the
   REAL Mongo boundary (e.g. live smoke) opts out by setting
   `OFFLINE_MONGO = False` at module level — the fixture then installs
   nothing and the test sees the true environment.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# ── boundary 1: .env reader stub — MUST run before any shopeechat import
DOTENV_CALLS: list = []
import dotenv  # noqa: E402


def _dotenv_stub(*a, **k):
    DOTENV_CALLS.append((a, k))
    return False                     # never open or parse any file


dotenv.load_dotenv = _dotenv_stub

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import knowledge_base as _kb  # noqa: E402


class _OfflineColl:
    """empty-collection double — reads return empty/None, matching
    "fresh Mongo with no docs"; any other op fails loudly offline"""
    def find_one(self, *a, **k):
        return None
    def find(self, *a, **k):
        return iter(())
    def distinct(self, *a, **k):
        return []
    def aggregate(self, *a, **k):
        return iter(())
    def count_documents(self, *a, **k):
        return 0
    def estimated_document_count(self, *a, **k):
        return 0
    def __getattr__(self, _name):
        def _off(*a, **k):
            raise RuntimeError("docs/test offline — admin client stubbed")
        return _off


class _OfflineDb:
    def __getitem__(self, _name):
        return _OfflineColl()


class _OfflineClient:
    """minimal MongoClient double — ping OK, every db → empty colls"""
    class _Admin:
        @staticmethod
        def command(*a, **k):
            return {"ok": 1}
    admin = _Admin()

    def __getitem__(self, _name):
        return _OfflineDb()


@pytest.fixture(autouse=True)
def _offline_admin_client(request, monkeypatch):
    # opt-out: a module declaring OFFLINE_MONGO = False sees the real
    # environment (live smoke, real-failure semantics) — no fake state
    if getattr(request.module, "OFFLINE_MONGO", True) is False:
        yield
        return
    monkeypatch.setattr(_kb, "_cached_admin_client", _OfflineClient())
    yield
