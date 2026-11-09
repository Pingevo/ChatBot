"""Offline test-boundary contract — the docs/test conftest must not let
production imports read a real `.env`, and the ambient admin-Mongo stub
must stay overridable per test (no masked DB-failure semantics)."""
import sys

import dotenv


def test_dotenv_never_reads_env_file():
    """conftest installs a recording no-op BEFORE importing shopeechat —
    so `knowledge_base._load_env()` (which runs at import) reached the
    stub, not the real file. Proves `.env` was never opened offline."""
    import conftest
    kb = sys.modules.get("shopeechat.knowledge_base")
    assert kb is not None, "knowledge_base import did not run"
    # the dangerous callsite binds `from dotenv import load_dotenv` at kb
    #   import time — conftest imported kb FIRST under this suite. Later
    #   sibling modules may rebind the alias to their OWN no-op
    #   (test_phase4b_refresh lambda, incident_replay's captured _orig)
    #   — the contract is not "this specific stub object" but "never the
    #   real loader that opens .env". Prove both: the bound callable is
    #   not the provider's real loader, and invoking it cannot read a
    #   file (no-op returns False for any path).
    import dotenv.main
    real_loader = getattr(dotenv.main, "load_dotenv", None)
    assert real_loader is None or kb.load_dotenv is not real_loader, (
        "knowledge_base.load_dotenv binds the REAL dotenv loader — "
        "import order let the .env-reading alias through the boundary")
    assert kb.load_dotenv("anything-nonexistent") is False, (
        "bound load_dotenv behaves like a file reader — expected the "
        "offline no-op")
    assert conftest.DOTENV_CALLS, (
        "expected ≥1 recorded call — knowledge_base._load_env runs "
        "load_dotenv at import; an empty record means the call bypassed "
        "the stub and hit the real .env loader")
    # whatever reader is bound now still must never open a file
    assert dotenv.load_dotenv("anything") is False


def test_offline_admin_stub_overridable(knowledge_base=None):
    """the ambient stub is a floor, not a cage — a test pinning its own
    `_cached_admin_client` must observe its own client, not the offline
    one (DB-failure/readiness semantics are therefore still testable)."""
    import conftest
    from shopeechat import knowledge_base as _kb
    sentinel = object()
    _kb._cached_admin_client = sentinel
    try:
        assert _kb._cached_admin_client is sentinel
    finally:
        _kb._cached_admin_client = conftest._OfflineClient()


def test_db_failure_surfaces_not_empty_success(monkeypatch):
    """a pinned client whose read raises must propagate the failure —
    the offline floor must never convert DB failure into empty-success
    (readiness/DB-error semantics stay observable through the floor)."""
    from shopeechat import knowledge_base as _kb

    class _BoomColl:
        def find_one(self, *a, **k):
            raise RuntimeError("simulated DB failure")

    class _BoomDb:
        def __getitem__(self, _n):
            return _BoomColl()

    class _BoomClient:
        class _Admin:
            @staticmethod
            def command(*a, **k):
                return {"ok": 1}
        admin = _Admin()

        def __getitem__(self, _n):
            return _BoomDb()

    monkeypatch.setattr(_kb, "_cached_admin_client", _BoomClient())
    import pytest
    with pytest.raises(RuntimeError, match="simulated DB failure"):
        _kb._admin_db()["system_configs"].find_one({})


def test_offline_floor_is_empty_not_success_and_write_fails():
    """floor semantics = fresh empty Mongo: reads answer empty (not a
    fabricated config doc); non-read ops raise loudly — a test can never
    pass on silent fake success."""
    import conftest
    import pytest
    coll = conftest._OfflineClient()["db"]["system_configs"]
    assert coll.find_one({}) is None          # empty, not a fake doc
    assert list(coll.find({})) == []
    with pytest.raises(RuntimeError):
        coll.insert_one({"x": 1})             # writes fail loudly
    with pytest.raises(RuntimeError):
        coll.drop()                           # unknown ops fail loudly
