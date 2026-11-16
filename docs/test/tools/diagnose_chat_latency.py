"""Measure /chat latency through the in-process app without changing bot code.

Run from the repo root with .venv/bin/python. This uses the configured real
provider and MongoDB: each turn can incur provider cost and writes ai_usage to
Admin Mongo. The default is 100 sequential plus 100 parallel turns. Use only
approved QA input with an authorized, isolated configuration. Reports contain
timings and status only, never customer text.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
from contextlib import redirect_stderr, redirect_stdout
from contextvars import ContextVar
from datetime import datetime, timezone
import json
from pathlib import Path
import statistics
import sys
import threading
from time import perf_counter


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))
CURRENT: ContextVar[dict | None] = ContextVar("latency_trace", default=None)


def _instrument(module, name: str, stage: str) -> None:
    original = getattr(module, name)

    def timed(*args, **kwargs):
        start = perf_counter()
        trace = CURRENT.get()
        if trace is not None:
            trace["_active"].append((stage, start))
        try:
            return original(*args, **kwargs)
        finally:
            if trace is not None:
                trace["_active"].pop()
                trace[stage].append(round(perf_counter() - start, 6))

    setattr(module, name, timed)


def _questions(path: Path, count: int) -> tuple[dict, list[dict]]:
    seen = set()
    rows = []
    single = None
    with path.open() as source:
        for line in source:
            row = json.loads(line)
            key = row.get("turn_id")
            message = row.get("request_message")
            if not key or key in seen or not isinstance(message, str) or not message:
                continue
            seen.add(key)
            question = {"message": message, "shop": row.get("shop"), "history": []}
            rows.append(question)
            usage = (row.get("response_payload") or {}).get("usage") or {}
            if single is None and usage.get("total", 0) > 0:
                single = question
            if len(rows) >= count and single is not None:
                break
    if len(rows) < count:
        raise ValueError(f"need {count} distinct questions, found {len(rows)}")
    return single or rows[0], rows[:count]


async def _one(client, question: dict, secret: str, trace_store=None, index=0) -> dict:
    trace = defaultdict(list)
    if trace_store is not None:
        trace_store[index] = trace
    token = CURRENT.set(trace)
    start = perf_counter()
    started_at = datetime.now(timezone.utc).isoformat()
    try:
        try:
            response = await client.post(
                "/chat", json=question,
                headers={"X-Internal-Secret": secret} if secret else {},
            )
            payload = response.json()
            return {
                "index": index,
                "started_at": started_at,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "wall_s": round(perf_counter() - start, 3),
                "http": response.status_code,
                "request_id": payload.get("request_id") if isinstance(payload, dict) else None,
                "bot_timing": payload.get("timing") if isinstance(payload, dict) else None,
                "steps": [(step.get("name"), step.get("time_s"))
                          for step in payload.get("steps", []) if isinstance(step, dict)]
                if isinstance(payload, dict) else [],
                "usage_total": (payload.get("usage") or {}).get("total", 0)
                if isinstance(payload, dict) else 0,
                "stages": {k: {"calls": len(v), "sum_s": round(sum(v), 3),
                                "max_s": round(max(v), 3)} for k, v in trace.items()
                           if not k.startswith("_")},
                "embed_texts_items": trace.get("_embed_items", []),
            }
        except Exception as exc:
            return {"index": index, "started_at": started_at,
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "wall_s": round(perf_counter() - start, 3),
                    "error_type": type(exc).__name__,
                    "stages": {k: {"calls": len(v), "sum_s": round(sum(v), 3),
                                    "max_s": round(max(v), 3)} for k, v in trace.items()
                               if not k.startswith("_")},
                    "embed_texts_items": trace.get("_embed_items", [])}
    finally:
        CURRENT.reset(token)


def _summary(rows: list[dict]) -> dict:
    out = {"count": len(rows), "statuses": {}, "stages": {}}
    for row in rows:
        key = str(row.get("http", row.get("error_type", "unknown")))
        out["statuses"][key] = out["statuses"].get(key, 0) + 1
    for key in ("wall_s", "bot_timing.total", "bot_timing.pass1", "bot_timing.llm"):
        values = []
        for row in rows:
            value = row
            for part in key.split("."):
                value = value.get(part) if isinstance(value, dict) else None
            if isinstance(value, (int, float)):
                values.append(value)
        if values:
            values.sort()
            out[key] = {"n": len(values), "p50_s": round(statistics.median(values), 3),
                        "p95_s": round(values[int((len(values) - 1) * .95)], 3),
                        "max_s": round(values[-1], 3)}
    stages = {name for row in rows for name in row["stages"]}
    for name in sorted(stages):
        values = [row["stages"].get(name, {}).get("sum_s", 0) for row in rows]
        out["stages"][name] = {"requests_used": sum(value > 0 for value in values),
                                "p50_s": round(statistics.median(values), 3),
                                "p95_s": round(sorted(values)[int((len(values) - 1) * .95)], 3),
                                "max_s": round(max(values), 3)}
    return out


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


async def _run(args) -> dict:
    import os
    os.environ["EMBEDDING_DEVICE"] = args.device
    import httpx
    from google.genai.models import Models
    from shopeechat import (app, embedding, intent_classifier, kb_zaapi_files,
                           knowledge_base, llm, product_store, retrieval_runtime,
                           web_search)

    from pymongo import monitoring

    class MongoTiming(monitoring.CommandListener):
        def started(self, event):
            pass

        def succeeded(self, event):
            trace = CURRENT.get()
            if trace is not None:
                trace["mongo_command"].append(round(event.duration_micros / 1_000_000, 6))

        def failed(self, event):
            trace = CURRENT.get()
            if trace is not None:
                trace["mongo_command"].append(round(event.duration_micros / 1_000_000, 6))

    monitoring.register(MongoTiming())

    for module, name, stage in (
        (embedding, "embed_query", "embed_query"),
        (embedding, "embed_texts", "embed_texts"),
        (product_store, "fetch_products", "fetch_products"),
        (product_store, "vector_search", "vector_search"),
        (knowledge_base, "search_qa", "search_qa"),
        (kb_zaapi_files, "zaapi_search", "zaapi_search"),
        (intent_classifier, "classify_intent", "classify_intent"),
        (retrieval_runtime, "run_grouped_selection", "grouped_selection"),
        (app, "_typed_answer_boundary", "typed_answer_boundary"),
        (web_search, "search_and_extract", "web_search"),
        (llm, "_acquire", "quota_acquire"),
        (llm, "_generate", "llm_generate"),
        (Models, "generate_content", "provider_sdk"),
    ):
        _instrument(module, name, stage)
    _original_embed_texts = embedding.embed_texts

    def _count_embed_texts(texts, *args, **kwargs):
        trace = CURRENT.get()
        if trace is not None:
            trace["_embed_items"].append(len(texts))
        return _original_embed_texts(texts, *args, **kwargs)

    embedding.embed_texts = _count_embed_texts

    _, questions = _questions(args.input, args.count)
    args.details.parent.mkdir(parents=True, exist_ok=True)
    prior_rows = []
    if args.resume and args.details.exists():
        prior_rows = [json.loads(line) for line in args.details.read_text().splitlines() if line.strip()]
    else:
        args.details.write_text("")
    prior_report = {}
    if args.resume and args.output.exists():
        try:
            prior_report = json.loads(args.output.read_text())
        except Exception:
            prior_report = {}
    state = {"phase": "warmup", "device": args.device,
             "started_at": datetime.now(timezone.utc).isoformat(),
             "completed": 0, "pending": 0, "current_indices": []}
    heartbeat_stop = threading.Event()

    def heartbeat():
        while not heartbeat_stop.wait(5):
            _write_json(args.output, dict(state, heartbeat_at=datetime.now(timezone.utc).isoformat()))

    heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
    heartbeat_thread.start()
    with open('/dev/null', 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
        warmup_start = perf_counter()
        app._warmup()
        warmup_s = round(perf_counter() - warmup_start, 3)
        state.update(phase="starting_tests", warmup_s=warmup_s)
        transport = httpx.ASGITransport(app=app.app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://diagnostic.local",
                                     timeout=None) as client:
            results = {}
            modes = ("sequential", "parallel") if args.mode == "both" else (args.mode,)
            for mode in modes:
                rows = [row for row in prior_rows if row.get("mode") == mode]
                completed_indices = {row.get("index") for row in rows}
                previous_elapsed = 0.0
                if args.resume and prior_report.get("phase") == mode:
                    try:
                        previous_elapsed = max(0.0, (
                            datetime.fromisoformat(prior_report["heartbeat_at"])
                            - datetime.fromisoformat(prior_report["mode_started_at"])
                        ).total_seconds())
                    except (KeyError, TypeError, ValueError):
                        previous_elapsed = 0.0
                state.update(phase=mode, mode_started_at=datetime.now(timezone.utc).isoformat(),
                             completed=len(rows), pending=len(questions) - len(rows),
                             current_indices=[])
                mode_start = perf_counter()
                if mode == "sequential":
                    for i, question in enumerate(questions):
                        if i in completed_indices:
                            continue
                        state.update(completed=len(rows), pending=len(questions) - len(rows),
                                     current_indices=[i])
                        row = await _one(client, question, app._INTERNAL_SECRET, index=i)
                        row["mode"] = mode
                        rows.append(row)
                        with args.details.open("a") as details:
                            details.write(json.dumps(row) + "\n")
                        state.update(completed=len(rows), pending=len(questions) - len(rows),
                                     current_indices=[])
                        _write_json(args.output, {"phase": mode, "device": args.device,
                                                  "warmup_s": warmup_s,
                                                  "mode_wall_s": round(perf_counter() - mode_start, 3),
                                                  "completed": len(rows),
                                                  "pending": len(questions) - len(rows)})
                else:
                    traces = {}
                    task_indices = {}
                    tasks = []
                    for i, question in enumerate(questions):
                        if i in completed_indices:
                            continue
                        task = asyncio.create_task(_one(client, question, app._INTERNAL_SECRET,
                                                        traces, i))
                        tasks.append(task)
                        task_indices[task] = i
                    pending = set(tasks)
                    while pending:
                        done, pending = await asyncio.wait(
                            pending, timeout=5, return_when=asyncio.FIRST_COMPLETED)
                        finished = [task.result() for task in done]
                        rows.extend(finished)
                        with args.details.open("a") as details:
                            for row in finished:
                                row["mode"] = mode
                                details.write(json.dumps(row) + "\n")
                        state.update(completed=len(rows), pending=len(pending),
                                     current_indices=[task_indices[task] for task in pending])
                        active = defaultdict(int)
                        for task in pending:
                            i = task_indices[task]
                            if task in pending:
                                stack = (traces.get(i) or {}).get("_active", [])
                                active[stack[-1][0] if stack else "threadpool_or_uninstrumented"] += 1
                        _write_json(args.output, {"phase": mode, "device": args.device,
                                                  "warmup_s": warmup_s,
                                                  "mode_wall_s": round(perf_counter() - mode_start, 3),
                                                  "completed": len(rows),
                                                  "pending": len(pending),
                                                  "pending_indices": state["current_indices"],
                                                  "pending_stage_snapshot": dict(active)})
                results[mode] = {"wall_s": round(previous_elapsed + perf_counter() - mode_start, 3),
                                 **_summary(rows)}
            heartbeat_stop.set()
    heartbeat_stop.set()
    heartbeat_thread.join(timeout=1)
    report = {"warmup_s": warmup_s, "device": args.device,
              "modes": results,
              "note": "in-process ASGI, real Mongo/provider, no retries; QA inputs omit history"}
    _write_json(args.output, report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=ROOT / "docs/test/results/liveqa_1000_20261114_run1/attempts.jsonl")
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--mode", choices=("sequential", "parallel", "both"), default="both")
    parser.add_argument("--device", choices=("cpu", "mps"), default="cpu")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/test/results/chat_latency_diagnostic.json")
    parser.add_argument("--details", type=Path, default=ROOT / "docs/test/results/chat_latency_diagnostic_requests.jsonl")
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be positive")
    result = asyncio.run(_run(args))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
