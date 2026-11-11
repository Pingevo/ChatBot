"""build_generation resume/lock logic — pure function tests (no Mongo/spawn)."""

from datetime import datetime, timedelta, timezone

from shopeechat.scripts import build_generation as bg


def _steps(done=(), statuses=None):
    """run doc `steps` dict — แค่ key ที่มีคือ step ที่เคยแตะแล้ว"""
    out = {}
    for s in done:
        out[s] = {"status": "done", "percent": 100.0}
    for name, st in (statuses or {}).items():
        out[name] = {"status": st}
    return out


# ---------- _resume_plan ----------

def test_plan_all_done_reruns_tail_only():
    steps = _steps(done=bg._STEP_ORDER)
    assert bg._resume_plan(steps, "daily") == ["import_db", "validate"]


def test_plan_fresh_run_does_everything():
    assert bg._resume_plan({}, "daily") == bg._STEP_ORDER


def test_plan_failed_mid_resume_from_death_point():
    steps = _steps(done={"export", "image_texts_sellable"},
                   statuses={"image_texts_nonsellable": "running"})
    plan = bg._resume_plan(steps, "daily")
    # pair atomic → sellable re-runs ด้วย; แล้วต่อยอดถึง tail
    assert plan == [
        "image_texts_sellable", "image_texts_nonsellable",
        "sellable_units", "unit_embeddings", "product_embeddings",
        "description_embeddings", "import_db", "validate"]


def test_plan_atomic_pair_when_only_one_missing():
    # sellable done แต่ nonsellable ไม่เคยแตะ → ทั้งคู่ต้อง rerun
    steps = _steps(done={"export", "image_texts_sellable"})
    plan = bg._resume_plan(steps, "daily")
    assert "image_texts_sellable" in plan
    assert "image_texts_nonsellable" in plan


def test_plan_daily_includes_description_step():
    # daily: description_embeddings = carry — ถ้าไม่ done ต้องอยู่ใน plan
    steps = _steps(done=[s for s in bg._STEP_ORDER
                         if s != "description_embeddings"])
    plan = bg._resume_plan(steps, "daily")
    assert "description_embeddings" in plan
    assert plan[-2:] == ["import_db", "validate"]


def test_plan_tail_always_last():
    steps = _steps(statuses={"product_embeddings": "failed"})
    plan = bg._resume_plan(steps, "weekly")
    assert plan[-2:] == ["import_db", "validate"]
    assert plan[0] == "export"


# ---------- _run_alive / _check_build_lock ----------

def test_run_alive_with_live_pid():
    import os
    run = {"_id": "gX", "status": "building", "pid": os.getpid(),
           "updated_at": "2000-01-01T00:00:00+00:00"}
    assert bg._run_alive(run) is True


def test_run_dead_pid_not_alive():
    # pid มหาศาลที่ไม่น่ามี process → dead → ไม่บล็อกแม้ updated_at ใหม่มาก
    run = {"_id": "gX", "status": "building", "pid": 2_000_000_000,
           "updated_at": datetime.now(timezone.utc).isoformat()}
    assert bg._run_alive(run) is False


def test_legacy_run_no_pid_stale_check():
    fresh = {"_id": "gX", "status": "building",
             "updated_at": datetime.now(timezone.utc).isoformat()}
    stale = {"_id": "gX", "status": "building",
             "updated_at": (datetime.now(timezone.utc)
                            - timedelta(hours=25)).isoformat()}
    assert bg._run_alive(fresh) is True
    assert bg._run_alive(stale) is False


class _FakeColl:
    def __init__(self, docs):
        self._docs = docs

    def find(self, q):
        return list(self._docs)


def test_build_lock_blocks_live_run():
    import os
    db = {bg._RUNS_COLL: _FakeColl([
        {"_id": "g1", "status": "building", "pid": os.getpid(),
         "updated_at": "2000-01-01T00:00:00+00:00"}])}
    try:
        bg._check_build_lock(db)
    except RuntimeError as e:
        assert "g1" in str(e)
    else:
        raise AssertionError("expected lock")


def test_build_lock_passes_dead_and_excludes_self():
    db = {bg._RUNS_COLL: _FakeColl([
        {"_id": "gDead", "status": "building", "pid": 2_000_000_000,
         "updated_at": datetime.now(timezone.utc).isoformat()}])}
    bg._check_build_lock(db)  # dead pid → ไม่ raise
    import os
    db[bg._RUNS_COLL]._docs.append(
        {"_id": "gSelf", "status": "building", "pid": os.getpid(),
         "updated_at": datetime.now(timezone.utc).isoformat()})
    bg._check_build_lock(db, exclude_gid="gSelf")  # exclude ตัวเอง → ไม่ raise
