"""Unit index broad regression — ยิง LLM จริงผ่าน POST /chat แล้วเก็บผลเต็ม.

สองโหมด (แยก quota ตามที่สั่ง):
  --questions  : 300 คำถามเดี่ยวจาก corpus JSONL
  --conversations N : N conversations จริงจาก messages_shp (replay เต็ม multi-turn)

บันทึกทุก Q&A แบบเต็มลง JSONL (เขียนทีละบรรทัด — resume ได้ด้วย --skip-existing):
  answer จริง, products (unit_id → ใช้ unit path), source, intent, routing_decision,
  steps, web_search_used, handoff, usage/cost/elapsed, bot_log, error+สาเหตุเดา

วิธีใช้:
  .venv/bin/python docs/test/unit_index_regression.py \
      --questions docs/test/unit_reg_corpus.jsonl \
      --bot http://127.0.0.1:8020 \
      --out docs/test/results/unit_reg_questions_2026-09-18.jsonl

  .venv/bin/python docs/test/unit_index_regression.py \
      --conversations 50 \
      --bot http://127.0.0.1:8020 \
      --out docs/test/results/unit_reg_convs_2026-09-18.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "chatbot" / "frontendScript"))

import requests  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

INTERNAL_SECRET = os.environ.get("CHATBOT_INTERNAL_SECRET", "")
CHATBOT_LOG_PATH = os.environ.get("CHATBOT_LOG_PATH", "")


def _log_tail(path: str, before: int) -> str:
    """อ่านส่วนที่เพิ่มในไฟล์ log ตั้งแต่ offset `before` (เหมือน replay_compare)."""
    try:
        after = os.path.getsize(path)
        if after <= before:
            return ""
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(before)
            return f.read(after - before)
    except Exception:
        return ""


def _call_bot(bot_url: str, body: dict, timeout: int = 150) -> dict:
    headers = {"Content-Type": "application/json"}
    if INTERNAL_SECRET:
        headers["X-Internal-Secret"] = INTERNAL_SECRET
    log_path = os.environ.get("CHATBOT_LOG_PATH", "/tmp/chatbot.log")
    try:
        log_before = os.path.getsize(log_path)
    except Exception:
        log_before = 0
    try:
        resp = requests.post(f"{bot_url.rstrip('/')}/chat", json=body,
                             headers=headers, timeout=timeout)
        bot_log = _log_tail(log_path, log_before)
        if resp.status_code == 429:
            return {"error": "429 rate limit", "bot_log": bot_log}
        if not resp.ok:
            return {"error": f"http {resp.status_code}",
                    "http_body": resp.text[:500], "bot_log": bot_log}
        data = resp.json()
        data["bot_log"] = bot_log
        return data
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}",
                "bot_log": _log_tail(log_path, log_before)}


def _err_cause(rec: dict, bot_log: str) -> str | None:
    """เดาสาเหตุ error จาก response + bot_log (จดไว้ ไม่แก้ — ตามที่สั่ง)."""
    err = rec.get("error")
    ans = rec.get("answer") or ""
    blob = (err or "") + " " + ans + " " + bot_log
    if "API_KEY_INVALID" in blob or "key not valid" in blob.lower():
        return "llm_api_key_invalid (pool มี key ตาย — จดแล้วใน waythrough)"
    if "RESOURCE_EXHAUSTED" in blob or "429" in blob:
        return "llm_quota/rate_limit"
    if "Cannot use MongoClient after close" in blob:
        return "mongo_client_closed_race (shared singleton ถูก close — known latent bug)"
    if "ระบบ LLM ติดขัด" in ans:
        return "llm_error_masked (ดู bot_log)"
    if err:
        return f"unclassified: {err[:200]}"
    return None


def _unit_path_used(resp: dict) -> bool:
    """ตอบผ่าน unit path จริง — products ต้องมี unit_id."""
    return any(p.get("unit_id") for p in (resp.get("products") or []))


def _unit_attempted(bot_log: str) -> str:
    """unit path ถูกลองไหม และจบยังไง: used / fallback-empty / fallback-dead / no."""
    if "[UNITS] msg=" not in bot_log:
        return "no"
    if "pool all-dead" in bot_log:
        return "fallback_dead_pool"
    if "collection unavailable" in bot_log or "vector search error" in bot_log:
        return "fallback_error"
    return "attempted"


def _steps_names(resp: dict) -> list[str]:
    return [s.get("name", "?") for s in (resp.get("steps") or [])]


def run_questions(corpus_path: str, bot_url: str, out_path: str,
                  skip_existing: bool, limit: int | None, delay: float) -> None:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    done_ids: set[str] = set()
    if skip_existing and out.exists():
        for line in out.open(encoding="utf-8"):
            try:
                done_ids.add(json.loads(line)["id"])
            except Exception:
                pass
    corpus = [json.loads(l) for l in open(corpus_path, encoding="utf-8") if l.strip()]
    if limit:
        corpus = corpus[:limit]
    n_total = len(corpus)
    n_run = n_err = 0
    t0 = time.time()
    with out.open("a", encoding="utf-8") as f:
        for i, q in enumerate(corpus):
            qid = q["id"]
            if qid in done_ids:
                continue
            body = {
                "message": q["message"],
                "history": q.get("history") or [],
                "limit": q.get("limit", 10),
                "platform": "shopee",
                "conversation_id": f"unitreg-{qid}",
            }
            if q.get("shop"):
                body["shop"] = q["shop"]
            resp = _call_bot(bot_url, body)
            bot_log = resp.pop("bot_log", "") if isinstance(resp, dict) else ""
            rec = {
                "id": qid,
                "topic": q.get("topic"),
                "shop": q.get("shop"),
                "message": q["message"],
                "answer": resp.get("answer", ""),
                "source": resp.get("source"),
                "model": resp.get("model"),
                "chat_engine": resp.get("chat_engine"),
                "unit_path": _unit_path_used(resp),
                "unit_attempted": _unit_attempted(bot_log),
                "products": [
                    {k: p.get(k) for k in
                     ("item_id", "name", "unit_id", "model_name", "sellable",
                      "_available_for_sale", "product_type", "price", "status")}
                    for p in (resp.get("products") or [])[:10]
                ],
                "n_products": len(resp.get("products") or []),
                "intent": resp.get("intent"),
                "routing_decision": resp.get("routing_decision"),
                "steps": _steps_names(resp),
                "web_search_used": resp.get("web_search_used"),
                "web_search_reason": resp.get("web_search_reason"),
                "handoff_to_admin": resp.get("handoff_to_admin"),
                "handoff_reason": resp.get("handoff_reason"),
                "usage": resp.get("usage"),
                "cost": resp.get("cost"),
                "elapsed": resp.get("elapsed"),
                "answer_segments_n": len(resp.get("answer_segments") or []),
                "error": resp.get("error"),
                "error_cause": _err_cause(resp, bot_log),
                "bot_log": bot_log[-4000:],
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            n_run += 1
            if rec["error"] or rec["error_cause"]:
                n_err += 1
            if n_run % 10 == 0 or n_run == 1:
                rate = n_run / max(time.time() - t0, 0.1)
                eta = (n_total - i - 1) / max(rate, 0.01) / 60
                print(f"[{i+1}/{n_total}] {qid} src={rec['source']} "
                      f"unit={rec['unit_path']} err={rec['error_cause']} "
                      f"({rate:.2f}/s, eta {eta:.0f}m)", flush=True)
            time.sleep(delay)
    print(f"DONE questions: ran={n_run} errors={n_err} → {out_path}")


def run_conversations(n_conv: int, bot_url: str, out_path: str,
                      delay: float) -> None:
    """Replay N conversations จริง — reuse replay_compare (เก็บ debug ครบอยู่แล้ว)."""
    import replay_compare as rc
    from pymongo import MongoClient

    rc.BOT_URL = f"{bot_url.rstrip('/')}/chat"
    rc.INTERNAL_SECRET = INTERNAL_SECRET

    admin_client = MongoClient(rc.ADMIN_MONGO_URI, serverSelectionTimeoutMS=5000)
    admin_db = admin_client[rc.ADMIN_MONGO_DB]
    prod_db = None
    if rc.PROD_MONGO_URI:
        prod_db = MongoClient(rc.PROD_MONGO_URI,
                              serverSelectionTimeoutMS=5000)[rc.PROD_MONGO_DB]

    convs = rc.list_conversations(admin_db, None, "shopee", n_conv)
    print(f"found {len(convs)} conversations")

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with out.open("w", encoding="utf-8") as f:
        for i, c in enumerate(convs):
            cid = c["conversation_id"]
            try:
                r = rc.replay_one(admin_db, prod_db, cid, verbose=False)
            except Exception as e:
                r = {"conv_id": cid, "error": f"{type(e).__name__}: {e}"}
            r["_meta"] = {"idx": i + 1, "shop": c.get("shop_name"),
                          "n_user": c.get("n_user")}
            # เพิ่ม unit flag ต่อ qa (products ไม่ถูกเก็บใน qa — ดูจาก bot_log)
            for q in r.get("qa", []):
                log = q.get("bot_log") or ""
                q["unit_attempted"] = _unit_attempted(log)
                q["unit_path"] = "[UNITS] msg=" in log and "pool all-dead" not in log
                q["error_cause"] = _err_cause(
                    {"error": q.get("bot_error"), "answer": q.get("bot_answer", "")},
                    log)
            f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
            f.flush()
            el = time.time() - t0
            print(f"[{i+1}/{len(convs)}] {cid} qa={len(r.get('qa', []))} "
                  f"({el/60:.1f}m)", flush=True)
            time.sleep(delay)
    print(f"DONE conversations → {out_path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", help="corpus JSONL path")
    ap.add_argument("--conversations", type=int, help="N real conversations")
    ap.add_argument("--bot", default="http://127.0.0.1:8020")
    ap.add_argument("--out", required=True)
    ap.add_argument("--skip-existing", action="store_true")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--delay", type=float, default=0.3)
    args = ap.parse_args()

    if args.questions:
        run_questions(args.questions, args.bot, args.out,
                      args.skip_existing, args.limit, args.delay)
    elif args.conversations:
        run_conversations(args.conversations, args.bot, args.out, args.delay)
    else:
        sys.exit("ระบุ --questions หรือ --conversations")


if __name__ == "__main__":
    main()
