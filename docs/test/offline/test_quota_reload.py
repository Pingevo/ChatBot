from __future__ import annotations

import json
from pathlib import Path

from uvicorn import Config
from uvicorn.supervisors.watchfilesreload import FileFilter

from shopeechat import llm


def test_quota_writes_do_not_trigger_python_reload(tmp_path, monkeypatch):
    quota = tmp_path / "exports" / ".gemini_quota.json"
    quota.parent.mkdir()
    monkeypatch.setattr(llm, "_QUOTA_FILE", quota)
    monkeypatch.setattr(llm, "_q_day", {})
    reload_filter = FileFilter(Config("shopeechat.app:app", reload=True))
    for n in range(1, 4):
        llm._q_day["2026-11-10"] = {"model-test": n}
        llm._save_quota_day()
        assert json.loads(quota.read_text()) == {"2026-11-10": {"model-test": n}}
        assert not quota.with_suffix(".tmp").exists()
        assert not reload_filter(quota)
        assert not reload_filter(quota.with_suffix(".tmp"))
    assert reload_filter(Path(llm.__file__))


def test_quota_source_location_is_ignored_even_with_json_reload_includes():
    reload_filter = FileFilter(Config(
        "shopeechat.app:app", reload=True, reload_includes=["*.json"]))
    source = Path(llm.__file__).parent
    assert not reload_filter(source / ".gemini_quota.json")
    assert not reload_filter(source / ".gemini_quota.tmp")
    assert reload_filter(source / "llm.py")
