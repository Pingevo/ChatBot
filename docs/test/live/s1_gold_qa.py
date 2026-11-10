"""S1 live gold QA — in-process real Mongo + real Gemini, bounded.

Runs docs/test/tools/gold_retrieval.jsonl through appmod.chat() with the
live generation + persisted runtime flags (no flag forcing). Safety:
- web search + openrouter + vision = die-spies (forbidden this run)
- conversation_products persistence → in-memory (zero product conv writes)
- handoffs sandboxed: simulate_assignment + test_source="test_chat"
- cp._coll read-only barrier; per-turn usage captured for cost control
- hard stop: >MAX_CALLS gemini calls or ERR_STREAK consecutive errors
Artifacts → docs/test/results/ (gitignored).
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from dataclasses import replace  # noqa: E402
from shopeechat import conversation_products as cp  # noqa: E402
from shopeechat import web_search as ws  # noqa: E402
from shopeechat import llm  # noqa: E402
import shopeechat.app as appmod  # noqa: E402

GOLD = ROOT / "docs/test/tools/gold_retrieval.jsonl"
TS = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
OUT_DIR = ROOT / "docs/test/results"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_JSONL = OUT_DIR / f"s1_gold_qa_{TS}.jsonl"
OUT_MD = OUT_DIR / f"s1_gold_qa_{TS}.md"

MAX_CALLS = int(os.environ.get("S1_MAX_CALLS", "500"))
ERR_STREAK = int(os.environ.get("S1_ERR_STREAK", "6"))
LIMIT_ROWS = int(os.environ.get("S1_LIMIT", "0"))  # 0 = all

counts = {"gemini": 0, "web": 0, "openrouter": 0, "vision": 0,
          "mongo_write": 0, "tokens_prompt": 0, "tokens_output": 0,
          "tokens_total": 0}


def _die(name):
    def f(*a, **k):
        counts[name] += 1
        raise RuntimeError(f"S1 DENIED: {name}")
    return f


ws.search_and_extract = _die("web")
if hasattr(ws, "search_and_answer"):
    ws.search_and_answer = _die("web")
llm._openrouter_generate = _die("openrouter")
for _n in ("describe_image", "describe_images"):
    if hasattr(llm, _n):
        setattr(llm, _n, _die("vision"))

# ── Mongo write barrier + in-memory conversation state (canary pattern) ──
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
                raise RuntimeError(f"S1 DENIED mongo {k}")
            return w
        return v


cp._coll = lambda: _ReadOnly(_real_coll())
_mem: dict = {}
_tl: dict = {}
_claim: dict = {}
_real_get = cp.get_subject_set


def _get(cid):
    st = _mem.get(cid)
    if st is None:
        return cp.SubjectSetView(None, None, ())
    return cp.SubjectSetView(st, st, (), None,
                             st.subject_ids[0] if st.subject_ids else None)


cp.get_subject_set = _get


def _rec(cid, ss, *, expected_prior=None, platform=None, shop=None):
    if ss is None:
        return None
    prior = expected_prior.rev if expected_prior is not None else None
    ss2 = replace(ss, rev=(prior or 0) + 1)
    _mem[cid] = ss2
    return ss2


cp.record_subject_set = _rec
cp.load_timeline = lambda cid: _tl.get(cid)


def _save_tl(cid, platform, shop, products, active_item_id):
    _tl[cid] = {"conversation_id": cid, "platform": platform, "shop": shop,
                "products": products, "active_item_id": active_item_id}


cp.save_timeline = _save_tl
cp.load_claim_state = lambda cid: _claim.get(cid)


def _transition(cid, platform, shop, *, expected_episode_id, expected_stage,
                claim_state):
    cur = _claim.get(cid)
    if cur and (cur.get("episode_id") != expected_episode_id
                or cur.get("stage") != expected_stage):
        return cur
    _claim[cid] = dict(claim_state or {})
    return _claim[cid]


cp.transition_claim_state = _transition


def _merge(cid, *, episode_id, expected_stage, fields):
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


def _order_anchor(conversation_id, platform=None, shop=None, order_sn=None,
                  order=None, **kw):
    doc = _tl.setdefault(conversation_id, {"products": []})
    doc.setdefault("order_anchor", {"order_sn": order_sn, "order": order})
    return doc


cp.add_order_anchor = _order_anchor

# ── usage capture via client wrapper ─────────────────────────────────────
_cur: dict = {}
_real_client = llm._client


def _client(*a, **k):
    c = _real_client(*a, **k)
    orig = c.models.generate_content

    def gen(*a, **k):
        counts["gemini"] += 1
        r = orig(*a, **k)
        um = getattr(r, "usage_metadata", None)
        if um is not None:
            p = getattr(um, "prompt_token_count", None) or 0
            o = getattr(um, "candidates_token_count", None) or 0
            t = getattr(um, "total_token_count", None) or (p + o)
            counts["tokens_prompt"] += p
            counts["tokens_output"] += o
            counts["tokens_total"] += t
            _cur.setdefault("usage", []).append(
                {"model": getattr(r, "model_version", None)
                 or k.get("model") or "?",
                 "p": p, "o": o, "t": t})
        return r

    c.models.generate_content = gen
    return c


llm._client = _client


def _verdict(row: dict, resp, err) -> tuple[str, list[str]]:
    """pass | fail | review — hard-fail on must_not violations."""
    why: list[str] = []
    ans = (getattr(resp, "answer", "") or "") if resp else ""
    ans_l = ans.lower()
    prods = getattr(resp, "products", None) or []
    pids = {str(p.get("item_id")) for p in prods if isinstance(p, dict)}
    for ph in row.get("must_not_phrases") or ():
        if ph and ph.lower() in ans_l:
            why.append(f"must_not_phrase:{ph}")
    for iid in row.get("must_not_item_ids") or ():
        s = str(iid)
        if s in ans or s in pids:
            why.append(f"must_not_item:{s}")
    if why:
        return "fail", why
    acc = [str(x) for x in (row.get("acceptable_item_ids") or ())]
    if acc:
        hit = any(s in ans or s in pids for s in acc)
        why.append("acceptable_item:" + ("hit" if hit else "miss"))
        if not hit:
            return "fail", why
    mode = row.get("expected_answer_mode") or ""
    src = (getattr(resp, "source", "") or "") if resp else ""
    np_ = len(prods)
    if err:
        return "fail", why + [f"error:{err}"]
    if mode == "handoff":
        ok = ("handoff" in src or "claim" in src
              or "แอดมิน" in ans or "ทีมงาน" in ans or "ส่งต่อ" in ans)
        why.append("mode:handoff=" + ("ok" if ok else f"src={src}"))
        return ("pass" if ok else "review"), why
    if mode in ("recommend", "products"):
        ok = np_ > 0
        why.append(f"mode:{mode}=products:{np_}")
        return ("pass" if ok else "review"), why
    if mode in ("out_of_stock", "discontinued", "no_such_type"):
        ok = np_ == 0 or any(
            w in ans for w in ("หมด", "ไม่มีขาย", "ไม่มีจำหน่าย", "เลิก",
                               "ไม่พบ"))
        why.append(f"mode:{mode}=" + ("ok" if ok else f"products:{np_}"))
        return ("pass" if ok else "review"), why
    ok = bool(ans.strip())
    why.append(f"mode:{mode}=answer:{len(ans)}ch")
    return ("pass" if ok else "review"), why


def main():
    rows = [json.loads(l) for l in GOLD.open() if l.strip()]
    if LIMIT_ROWS:
        rows = rows[:LIMIT_ROWS]
    gid = None
    try:
        from shopeechat import generation_pointer as gp
        gid = getattr(gp.resolve_snapshot(force=True), "generation_id", None)
    except Exception as e:
        gid = f"snapshot_err:{e}"
    print(f"S1 gold QA: {len(rows)} rows, gid={gid}, ts={TS}", flush=True)
    verdicts = {"pass": 0, "fail": 0, "review": 0}
    fails = []
    streak = 0
    with OUT_JSONL.open("w") as fj:
        for i, row in enumerate(rows):
            global _cur
            _cur = {}
            conv = f"s1-{row['id']}-{TS}"
            g0 = counts["gemini"]
            t0 = time.time()
            err = None
            resp = None
            try:
                resp = appmod.chat(appmod.ChatRequest(
                    message=row["message"], shop=row["shop"],
                    conversation_id=conv,
                    history=list(row.get("history") or []),
                    limit=10, simulate_assignment=True,
                    test_source="test_chat"))
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"
            lat = round(time.time() - t0, 2)
            v, why = _verdict(row, resp, err)
            verdicts[v] += 1
            prods = getattr(resp, "products", None) or []
            rec = {
                "i": i, "id": row["id"], "shop": row["shop"],
                "mode": row.get("expected_answer_mode"),
                "msg": row["message"], "verdict": v, "why": why,
                "answer": getattr(resp, "answer", None) if resp else None,
                "source": getattr(resp, "source", None) if resp else None,
                "products_n": len(prods),
                "product_ids": [str(p.get("item_id")) for p in prods
                                if isinstance(p, dict)],
                "usage": _cur.get("usage"),
                "gemini_calls": counts["gemini"] - g0,
                "latency_s": lat, "error": err,
            }
            fj.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
            fj.flush()
            if v == "fail":
                fails.append((row["id"], ";".join(why)))
            streak = 0 if err is None else streak + 1
            ans = (rec["answer"] or "")[:80].replace("\n", " ")
            print(f"[{i + 1}/{len(rows)}] {row['id']} v={v} src={rec['source']} "
                  f"g={rec['gemini_calls']} :: {ans}", flush=True)
            if streak >= ERR_STREAK or counts["gemini"] > MAX_CALLS:
                print(f"STOP: streak={streak} calls={counts['gemini']}",
                      flush=True)
                break
    summary = {
        "ts": TS, "gid": gid, "rows": sum(verdicts.values()),
        "verdicts": verdicts, "counts": counts,
        "fails": fails,
    }
    OUT_MD.write_text(
        "# S1 gold QA " + TS + "\n\n```json\n"
        + json.dumps(summary, ensure_ascii=False, indent=1, default=str)
        + "\n```\n")
    print("=== SUMMARY ===")
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=str))
    print(f"artifacts: {OUT_JSONL.name}, {OUT_MD.name}")


if __name__ == "__main__":
    main()
