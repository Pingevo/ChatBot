"""วิเคราะห์ผล unit regression — สรุปต่อ topic + error causes + unit path stats.

รัน: .venv/bin/python docs/test/analyze_unit_reg.py docs/test/results/unit_reg_questions_2026-09-18.jsonl
รองรับทั้งไฟล์ questions (flat records) และ conversations (มี qa[] nested)
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict


def load(path: str) -> list[dict]:
    recs = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line:
            recs.append(json.loads(line))
    return recs


def iter_qa(recs: list[dict]):
    """yield (topic, qa-like dict) — questions flat / conversations nested."""
    for r in recs:
        if "qa" in r:
            for q in r["qa"]:
                yield "conv:" + (r.get("_meta") or {}).get("shop", "?"), {
                    "answer": q.get("bot_answer", ""),
                    "source": q.get("bot_source"),
                    "error": q.get("bot_error"),
                    "error_cause": q.get("error_cause"),
                    "unit_path": q.get("unit_path"),
                    "unit_attempted": q.get("unit_attempted"),
                    "web_search_used": q.get("web_search_used"),
                    "handoff": q.get("handoff"),
                }
        else:
            yield r.get("topic", "?"), r


def analyze(path: str) -> None:
    recs = load(path)
    topics: dict[str, Counter] = defaultdict(Counter)
    err_by_cause: dict[str, list] = defaultdict(list)
    n = 0
    for topic, q in iter_qa(recs):
        n += 1
        t = topics[topic]
        t["n"] += 1
        if q.get("error") or q.get("error_cause"):
            t["error"] += 1
            err_by_cause[q.get("error_cause") or q.get("error", "?")[:120]].append(
                (topic, (q.get("message") or "")[:60]))
        elif not (q.get("answer") or "").strip():
            t["empty"] += 1
        else:
            t["answered"] += 1
        if q.get("unit_path"):
            t["unit"] += 1
        if q.get("unit_attempted") in ("fallback_dead_pool", "fallback_error"):
            t["unit_fallback"] += 1
        if q.get("web_search_used"):
            t["web"] += 1
        if q.get("handoff") or q.get("handoff_to_admin"):
            t["handoff"] += 1

    print(f"\n{'='*100}")
    print(f"TOTAL qa={n}  file={path}")
    print(f"{'topic':<22} {'n':>4} {'answered':>9} {'error':>6} {'empty':>6} "
          f"{'unit':>5} {'u_fb':>5} {'web':>5} {'hnd':>4}")
    tot = Counter()
    for topic in sorted(topics):
        t = topics[topic]
        tot.update(t)
        print(f"{topic:<22} {t['n']:>4} {t['answered']:>9} {t['error']:>6} "
              f"{t['empty']:>6} {t['unit']:>5} {t['unit_fallback']:>5} "
              f"{t['web']:>5} {t['handoff']:>4}")
    print(f"{'TOTAL':<22} {tot['n']:>4} {tot['answered']:>9} {tot['error']:>6} "
          f"{tot['empty']:>6} {tot['unit']:>5} {tot['unit_fallback']:>5} "
          f"{tot['web']:>5} {tot['handoff']:>4}")

    print(f"\n--- error causes ---")
    for cause, exs in sorted(err_by_cause.items(), key=lambda x: -len(x[1])):
        print(f"[{len(exs)}] {cause}")
        for topic, msg in exs[:3]:
            print(f"      e.g. {topic}: {msg}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        analyze(p)
