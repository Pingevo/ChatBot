"""test_pool_sources_admission.py — P1: central evidence-pool switches.

พิสูจน์สัญญา:
- field absent → ทุก source ON (behavior เดิม)
- source OFF → ไม่ query (fetcher ไม่ถูกเรียก) + zero candidates
- kb OFF / kb_source=zaapi → legacy KB collections zero reads
- image_text OFF → attach_image_texts no-op
- kb_source selector strict: legacy|zaapi เท่านั้น invalid→legacy

run: python docs/test/test_pool_sources_admission.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chatbot"))

from shopeechat import runtime_config as rc          # noqa: E402
from shopeechat import retrieval_executor as rex      # noqa: E402
from shopeechat.retrieval_planner import channel_request  # noqa: E402
from shopeechat import knowledge_base as kb           # noqa: E402
from shopeechat import units                          # noqa: E402

PASS = [0]
FAIL = [0]


def check(name, cond):
    if cond:
        PASS[0] += 1
        print(f"  ok  {name}")
    else:
        FAIL[0] += 1
        print(f" FAIL {name}")


def set_cfg(cfg):
    """inject main_config ลง cache ตรงๆ (ข้าม Mongo + TTL)"""
    rc._cache = cfg
    rc._ts = time.time()


def reset_cfg():
    rc._cache = None
    rc._ts = 0.0


def counting_fetcher(calls, tag):
    def fn(*a, **k):
        calls.append(tag)
        return []
    return fn


# ---------- config readers ----------
print("== runtime_config pool/kb readers ==")
set_cfg({})
check("absent → all sources ON", rc.pool_sources() ==
      {"kb": True, "mongo_catalog": True, "units": True, "image_text": True})
check("absent → kb_source legacy", rc.kb_source() == "legacy")
check("absent → kb enabled + legacy allowed", rc.kb_enabled() and rc.legacy_kb_reads_allowed())

set_cfg({"pool_sources": {"kb": False, "units": False}})
s = rc.pool_sources()
check("explicit OFF respected", s["kb"] is False and s["units"] is False)
check("unspecified keys stay ON", s["mongo_catalog"] is True and s["image_text"] is True)
check("kb OFF → kb_enabled false", rc.kb_enabled() is False)
check("kb OFF → legacy reads blocked", rc.legacy_kb_reads_allowed() is False)

set_cfg({"kb_source": "zaapi"})
check("kb_source=zaapi", rc.kb_source() == "zaapi")
check("zaapi → legacy reads blocked", rc.legacy_kb_reads_allowed() is False)
set_cfg({"kb_source": "bogus"})
check("invalid kb_source → legacy", rc.kb_source() == "legacy" and rc.legacy_kb_reads_allowed())

# ---------- executor channel admission ----------
print("== executor source admission ==")
req = channel_request("slot")

set_cfg({"pool_sources": {"units": False}})
calls = []
res = rex.execute_grouped_retrieval_requests(
    (req,), message="pb100", shop=None,
    fetcher=counting_fetcher(calls, "units"),
    legacy_fetcher=counting_fetcher(calls, "legacy"), snap=None)
check("units OFF → units fetcher ไม่ถูกเรียก", "units" not in calls)
check("units OFF → legacy ยังทำงาน", calls == ["legacy"])
check("units OFF → ไม่มี units attempt", [a.source for a in res[0].source_attempts] == ["legacy"])

set_cfg({"pool_sources": {"mongo_catalog": False}})
calls = []
res = rex.execute_grouped_retrieval_requests(
    (req,), message="pb100", shop=None,
    fetcher=counting_fetcher(calls, "units"),
    legacy_fetcher=counting_fetcher(calls, "legacy"), snap=None)
check("mongo_catalog OFF → legacy fetcher ไม่ถูกเรียก", calls == ["units"])
check("mongo_catalog OFF → ไม่มี legacy attempt", [a.source for a in res[0].source_attempts] == ["units"])

set_cfg({"pool_sources": {"units": False, "mongo_catalog": False}})
calls = []
res = rex.execute_grouped_retrieval_requests(
    (req,), message="pb100", shop=None,
    fetcher=counting_fetcher(calls, "units"),
    legacy_fetcher=counting_fetcher(calls, "legacy"), snap=None)
check("ทั้งคู่ OFF → ไม่มี fetch เลย + zero candidates",
      calls == [] and res[0].eligible_candidates == ())

set_cfg({})
calls = []
res = rex.execute_grouped_retrieval_requests(
    (req,), message="pb100", shop=None,
    fetcher=counting_fetcher(calls, "units"),
    legacy_fetcher=counting_fetcher(calls, "legacy"), snap=None)
check("default → ทั้งสอง source fetch (behavior เดิม)",
      calls == ["units", "legacy"])

# ---------- legacy KB guards ----------
print("== legacy KB collection guards ==")
set_cfg({"pool_sources": {"kb": False}})
check("kb OFF → _search_kb_single ว่าง", kb._search_kb_single("pb100") == [])
check("kb OFF → get_general_faq None", kb.get_general_faq() is None)
check("kb OFF → _qa_docs ว่าง", kb._qa_docs() == [])

set_cfg({"kb_source": "zaapi"})
check("zaapi → _search_kb_single ว่าง (zero legacy reads)",
      kb._search_kb_single("pb100") == [])
check("zaapi → get_general_faq None", kb.get_general_faq() is None)

set_cfg({})
check("legacy ON → entry fns ผ่าน guard (ไม่ throw)", isinstance(kb._legacy_allowed(), bool))

# ---------- units guards ----------
print("== units attach guards ==")
unit_docs = [{"has_description": False, "model_codes": ["X1"],
              "image_ids": ["i1"]}]
set_cfg({"kb_source": "zaapi"})
check("zaapi → attach_kb_specs no-op (kb_products zero reads)",
      units.attach_kb_specs([dict(u) for u in unit_docs]) == unit_docs)
set_cfg({"pool_sources": {"image_text": False}})
check("image_text OFF → attach_image_texts no-op",
      units.attach_image_texts([dict(u) for u in unit_docs], snap=None) == unit_docs)

# ---------- zaapi adapter gate ----------
print("== zaapi kb adapter gate ==")
from shopeechat import kb_zaapi  # noqa: E402

set_cfg({})
r = kb_zaapi.zaapi_kb_evidence(shop="s", message="pb100")
check("legacy selector → zaapi gate closed (zero reads)",
      r.supporting_evidence == () and "zaapi_gate_closed" in r.trace)

set_cfg({"pool_sources": {"kb": False}, "kb_source": "zaapi"})
r = kb_zaapi.zaapi_kb_evidence(shop="s", message="pb100")
check("kb OFF → zaapi gate closed", "zaapi_gate_closed" in r.trace)

set_cfg({"kb_source": "zaapi"})
r = kb_zaapi.zaapi_kb_evidence(shop="s", message="สวัสดี")
check("zaapi + ไม่มี keyword → no_keywords (ไม่ query)",
      "zaapi_no_keywords" in r.trace)

reset_cfg()
print(f"\n=== {PASS[0]} passed, {FAIL[0]} failed ===")
sys.exit(1 if FAIL[0] else 0)
