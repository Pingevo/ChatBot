"""Live category QA — replay real BlackShark customer chats through app.chat().

in-process: real Mongo reads + real Gemini (production config ตามจริง
ไม่ force grouped/kb_source/provider) — seams เดียวกับ canary/s1 pattern:
- conversation subject/timeline/claim state → in-memory (0 conv writes)
- cp._coll → read-only barrier (นับ write attempt)
- simulate_assignment=True + test_source="test_chat" → handoff เขียน test colls
- web search / openrouter / vision = die-spies (bounded run)
- media turns ส่งเป็น text placeholder (ไม่ส่งรูปจริง — vision ไม่ถูกเรียก)
- guard: >MAX_CALLS gemini calls หรือ ERR_STREAK error ติดกัน → หยุด

usage:
  .venv/bin/python docs/test/live/live_category_qa.py [--only cat1,cat2] [--limit N]

output: docs/test/results/live_category_qa_<ts>.{jsonl,md} (gitignored)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from shopeechat import conversation_products as cp  # noqa: E402
from shopeechat import web_search as ws  # noqa: E402
from shopeechat import llm  # noqa: E402
import shopeechat.app as appmod  # noqa: E402

CASES = ROOT / "docs/test/results/category_qa_cases.json"
TS = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
OUT_DIR = ROOT / "docs/test/results"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_JSONL = OUT_DIR / f"live_category_qa_{TS}.jsonl"
OUT_MD = OUT_DIR / f"live_category_qa_{TS}.md"

MAX_CALLS = int(os.environ.get("CATQA_MAX_CALLS", "800"))
ERR_STREAK = int(os.environ.get("CATQA_ERR_STREAK", "8"))
PACE_S = float(os.environ.get("CATQA_PACE_S", "2"))

counts = {"gemini": 0, "attempts": 0, "e503": 0, "e429": 0,
          "web": 0, "openrouter": 0, "vision": 0, "mongo_write": 0}


def _die(name):
    def f(*a, **k):
        counts[name] += 1
        raise RuntimeError(f"CATQA DENIED: {name}")
    return f


ws.search_and_extract = _die("web")
ws.reanswer = _die("web")
if hasattr(ws, "should_use_web_search"):
    ws.should_use_web_search = _die("web")
if hasattr(ws, "search_and_answer"):
    ws.search_and_answer = _die("web")
llm._openrouter_generate = _die("openrouter")
for _n in ("describe_image", "describe_images"):
    if hasattr(llm, _n):
        setattr(llm, _n, _die("vision"))

# ── in-memory conversation state (zero real writes) ──────────────────────
_real_coll = cp._coll


class _ReadOnly:
    def __init__(self, c):
        self._c = c

    def __getattr__(self, k):
        v = getattr(self._c, k)
        if k in ("update_one", "insert_one", "update_many", "replace_one",
                 "delete_one", "delete_many", "bulk_write",
                 "find_one_and_update", "find_one_and_replace",
                 "find_one_and_delete"):
            def w(*a, **k):
                counts["mongo_write"] += 1
                raise RuntimeError(f"CATQA DENIED mongo {k}")
            return w
        return v


cp._coll = lambda: _ReadOnly(_real_coll())
_mem: dict = {}
_tl: dict = {}
_claim: dict = {}


cp.get_subject_set = lambda cid, **k: (
    cp.SubjectSetView(_mem[cid], _mem[cid], (), None,
                      _mem[cid].subject_ids[0]
                      if _mem[cid].subject_ids else None)
    if cid in _mem else cp.SubjectSetView(None, None, ()))


def _rec(cid, ss, *, expected_prior=None, platform=None, shop=None, **k):
    if ss is None:
        return None
    prior = expected_prior.rev if expected_prior is not None else None
    ss2 = replace(ss, rev=(prior or 0) + 1)
    _mem[cid] = ss2
    return ss2


cp.record_subject_set = _rec
cp.load_timeline = lambda cid, **k: _tl.get(cid)


def _save_tl(cid, platform, shop, products, active_item_id, **k):
    _tl[cid] = {"conversation_id": cid, "platform": platform, "shop": shop,
                "products": products, "active_item_id": active_item_id}
    return True


cp.save_timeline = _save_tl
cp.load_claim_state = lambda cid, **k: _claim.get(cid)


def _transition(cid, platform, shop, *, expected_episode_id, expected_stage,
                claim_state, **k):
    cur = _claim.get(cid)
    if cur and (cur.get("episode_id") != expected_episode_id
                or cur.get("stage") != expected_stage):
        return cur
    _claim[cid] = dict(claim_state or {})
    return _claim[cid]


cp.transition_claim_state = _transition


def _merge(cid, *, episode_id, expected_stage, fields,
           platform=None, shop=None, **k):
    cur = _claim.get(cid)
    if not cur or cur.get("episode_id") != episode_id \
            or (expected_stage is not None
                and cur.get("stage") != expected_stage):
        return cur
    for k, v in (fields or {}).items():
        if v not in (None, "", {}, []):
            cur[k] = v
    return cur


cp.merge_claim_fields = _merge

# ── gemini counter + bounded 503 retry ───────────────────────────────────
_real_client = llm._client


def _client(*a, **k):
    c = _real_client(*a, **k)
    orig = c.models.generate_content

    def gen(*a, **k):
        counts["gemini"] += 1
        for attempt in range(6):
            counts["attempts"] += 1
            try:
                return orig(*a, **k)
            except Exception as e:
                code = str(getattr(e, "code", "") or "")
                msg = str(e)
                if ("503" in code or "503" in msg or "UNAVAILABLE" in msg) \
                        and attempt < 5:
                    counts["e503"] += 1
                    time.sleep(5)
                    continue
                if "429" in code or "429" in msg \
                        or "RESOURCE_EXHAUSTED" in msg:
                    counts["e429"] += 1
                    if attempt < 5:
                        time.sleep(30)
                        continue
                raise
    c.models.generate_content = gen
    return c


llm._client = _client


def _req_of(t: dict, conv: str, history: list) -> appmod.ChatRequest:
    kind = t.get("kind")
    iid = t.get("item_id")
    if kind in ("item", "variation_card") and iid:
        msg, item_id = f"[สินค้า: {iid}]", iid
    else:
        msg, item_id = t["text"], None
    return appmod.ChatRequest(
        message=msg, shop="BlackShark", item_id=item_id,
        order_sn=t.get("order_sn"), conversation_id=conv,
        history=list(history), limit=10, platform="shopee",
        simulate_assignment=True, test_source="test_chat")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=str, default="")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    cases = json.loads(CASES.read_text())["cases"]
    if only:
        cases = [c for c in cases if c["category"] in only]
    if args.limit:
        cases = cases[:args.limit]

    streak, stopped = 0, False
    md: list[str] = [f"# live category QA {TS}", ""]
    with OUT_JSONL.open("w") as fj:
        for ci, case in enumerate(cases):
            if stopped:
                break
            cat, cid = case["category"], case["conversation_id"]
            conv = f"catqa-{cat}-{ci}-{TS}"
            history: list[dict] = []
            md.append(f"## [{cat}] {cid}")
            for ti, turn in enumerate(case["turns"], 1):
                req = _req_of(turn, conv, history)
                g0, t0, err, resp = counts["gemini"], time.time(), None, None
                try:
                    resp = appmod.chat(req)
                except Exception as e:  # noqa: BLE001
                    err = f"{type(e).__name__}: {e}"[:400]
                lat = round(time.time() - t0, 2)
                ans = (resp.answer or "") if resp else ""
                rec = {
                    "cat": cat, "conv": cid, "turn": ti,
                    "msg": req.message,
                    "item_id": req.item_id, "order_sn": req.order_sn,
                    "answer": ans, "source": resp.source if resp else None,
                    "intent": resp.intent if resp else None,
                    "products": [str(p.get("item_id"))
                                 for p in
                                 ((resp.products if resp else None) or [])
                                 if isinstance(p, dict)],
                    "handoff": resp.handoff_to_admin if resp else None,
                    "handoff_reason": resp.handoff_reason if resp else None,
                    "usage": resp.usage if resp else None,
                    "cost": resp.cost if resp else None,
                    "latency_s": lat,
                    "gemini_calls": counts["gemini"] - g0,
                    "error": err,
                }
                fj.write(json.dumps(rec, ensure_ascii=False,
                                    default=str) + "\n")
                fj.flush()
                history.append({"role": "user", "text": req.message})
                history.append({"role": "model", "text": ans})
                short = ans[:110].replace("\n", " ")
                print(f"[{cat} {ci + 1}/{len(cases)} t{ti}/"
                      f"{len(case['turns'])}] {lat}s g={rec['gemini_calls']} "
                      f"src={rec['source']} :: {short}", flush=True)
                md.append(f"- t{ti} `{req.message[:120]}`")
                md.append(f"  → {ans[:500]}" +
                          (f" [handoff={rec['handoff']} "
                           f"{rec['handoff_reason']}]"
                           if rec["handoff"] else "") +
                          (f" [ERR {err}]" if err else ""))
                streak = 0 if err is None else streak + 1
                if streak >= ERR_STREAK or counts["gemini"] > MAX_CALLS:
                    print(f"STOP: streak={streak} "
                          f"gemini={counts['gemini']}", flush=True)
                    md.append(f"\nSTOP streak={streak} gemini="
                              f"{counts['gemini']}")
                    stopped = True
                    break
                time.sleep(PACE_S)
            md.append("")
    OUT_MD.write_text("\n".join(md), encoding="utf-8")
    print("=== COUNTS ===")
    print(json.dumps(counts))
    print(f"artifacts: {OUT_JSONL.name}, {OUT_MD.name}")


if __name__ == "__main__":
    main()
