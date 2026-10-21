"""runtime_config.py — Task 5B3-D: runtime flags จาก admin DB system_configs.

หน้า /config (dev-only) เขียน field ลง system_configs.main_config
→ bot หยิบไปใช้ใน ≤5s ไม่ต้อง restart
DB เป็น owner เมื่อ field เป็น bool · field absent / DB error → env fallback เดิม
"""
from __future__ import annotations

import os
import time as _time

_TTL = 5.0
_cache: dict | None = None
_ts = 0.0

_COLL = os.environ.get(
    "ADMIN_MONGO_COLLECTION_SYSTEM_CONFIGS", "system_configs").strip()


def _fetch() -> dict:
    from . import knowledge_base as _kb  # lazy — กัน import หนักตอน module load
    return _kb._admin_db()[_COLL].find_one(
        {"config_key": "main_config"}, max_time_ms=1500) or {}


def get_runtime_config(force_refresh: bool = False) -> dict:
    """อ่าน main_config doc จาก admin DB — TTL 5s, fail → คืน cache เดิม/{}"""
    global _cache, _ts
    now = _time.time()
    if not force_refresh and _cache is not None and now - _ts < _TTL:
        return _cache
    try:
        _cache = _fetch()
    except Exception:
        if _cache is None:
            _cache = {}
    _ts = now
    return _cache


def _flag(db_key: str, env_key: str) -> bool:
    """DB bool ชนะเสมอ · field absent/DB error → env "1" fallback เดิม"""
    v = get_runtime_config().get(db_key)
    if isinstance(v, bool):
        return v
    return os.environ.get(env_key, "0") == "1"


def grouped_retrieval_shadow_enabled() -> bool:
    return _flag("grouped_retrieval_shadow_enabled",
                 "USE_GROUPED_RETRIEVAL_SHADOW")


def grouped_retrieval_selection_enabled() -> bool:
    return _flag("grouped_retrieval_selection_enabled",
                 "USE_GROUPED_RETRIEVAL_SELECTION")


def web_search_enabled() -> bool:
    """global web-search operator toggle — strict bool: เปิดได้เฉพาะ
    persisted main_config.web_search_enabled == True เท่านั้น
    missing/invalid/DB-error → OFF · ไม่มี env fallback"""
    return get_runtime_config().get("web_search_enabled") is True


def sanitize_or_model(model: str) -> str:
    """OpenRouter `:online` policy owner เดียว — web_search_enabled()
    is True เท่านั้นที่คง terminal `:online`; OFF/malformed/read-error
    → strip (offline model เดิมส่งต่อ byte-identical เมื่อไม่มี suffix)"""
    try:
        on = web_search_enabled() is True
    except Exception:
        on = False
    if not on and isinstance(model, str) \
            and model.lower().endswith(":online"):
        return model[: -len(":online")]
    return model
