"""Extract structured text จากรูปใน description_info ด้วย Gemini vision (sellable first).

วิธีใช้:
    .venv/bin/python chatbot/shopeechat/scripts/build_image_texts.py [--limit N] [--max-calls N]

ผลลัพธ์:
    exports/image_texts.jsonl — 1 line/รูป:
        {image_id, image_url, kind, text, is_template, used_by, status,
         model, prompt_tokens, output_tokens, cost_usd, finish_reason,
         attempts, error, ts}
    resume: รันซ้ำจะข้าม image_id ที่ status=="ok" แล้ว (error ถูก retry ใหม่)

Rate limit (รวมทุก key ตาม quota จริง): ≤80 calls/min → sleep 0.78s/call,
≤--max-calls ต่อ run (default 4000/day) → หยุดสะอาด รันซ้ำวันถัดไป resume ต่อ

ทุก call → _log_ai_usage เข้า AI Usage Hub (reuse web_search._log_ai_usage)
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

# โหลด .env ก่อน import llm — llm.py อ่าน GEMINI_API_KEY_1..9 ตอน import (เหมือน app.py)
from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

from chatbot.shopeechat import llm, web_search  # noqa: E402

EXPORT_PATH = ROOT / "exports" / "ShpProducts.export.json"
OUTPUT_PATH = ROOT / "exports" / "image_texts.jsonl"
USAGE_LOG_PATH = ROOT / "exports" / "image_texts_usage.jsonl"
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
MIN_INTERVAL = float(os.environ.get("IMGTXT_MIN_INTERVAL", "0.78"))  # ~77/min หลาย key; key เดียว (15 RPM/model) ใช้ ~4.1
CALL_TIMEOUT = 120
MAX_ATTEMPTS = 3
TEMPLATE_MIN_USED_BY = 20    # image_id ที่โผล่ใน >20 listings = template ร้าน

_EXTRACT_PROMPT = """รูปนี้มาจาก description ของสินค้า Shopee
- ถ้ามีข้อความ/spec → แตกข้อความทั้งหมดออกมาเป็นตัวอักษร (รักษาตัวเลข/หน่วย/รหัสรุ่น)
- ถ้าเป็นตารางรหัสตัวเลือก → list mapping code:option
- ถ้าเป็นรูปสินค้าล้วน → บรรยายสั้นๆ ว่าคืออะไร เห็นอุปกรณ์อะไรบ้าง
- ถ้าเป็นแบนเนอร์เงื่อนไขร้าน → สรุปเงื่อนไข
ตอบเป็น JSON เท่านั้น: {"kind": "spec|variant_map|product|banner", "text": "..."}"""


def _iter_export_docs(path: Path):
    """stream-parse export JSON (pretty-printed array) ทีละ doc — ไม่โหลดทั้งไฟล์."""
    buf, started = [], False
    with open(path, encoding="utf-8") as f:
        for line in f:
            s = line.rstrip("\n")
            if not started:
                if s == "  {":
                    started, buf = True, [line]
                continue
            buf.append(line)
            if s in ("  }", "  },"):
                yield json.loads("".join(buf).rstrip().rstrip(","))
                started, buf = False, []


def _doc_stock(d: dict) -> int:
    """stock รวมทั้ง listing — formula เดียวกับ sellable census (summary_info.total_available_stock)."""
    return sum(
        ((m.get("stock_info_v2") or {}).get("summary_info") or {}).get("total_available_stock", 0) or 0
        for m in (d.get("model") or [])
    )


def _doc_images(d: dict) -> dict[str, str]:
    """image_id → url จาก 3 แหล่งของ listing (dedupe — source แรกที่เจอชนะ).

    1. desc `field_list` — รูปใน description (spec/cert/banner)
    2. `image.image_id_list` — gallery/รูปปก (มอก./cert badge มักอยู่รูปแรกๆ ไม่ใช่ใน desc)
    3. `tier_variation[].option_list[].image` — รูป variant
    """
    ids: dict[str, str] = {}
    fl = ((d.get("description_info") or {}).get("extended_description") or {}).get("field_list") or []
    for f in fl:
        if isinstance(f, dict) and f.get("field_type") == "image" and isinstance(f.get("image_info"), dict):
            iid = f["image_info"].get("image_id")
            if iid:
                ids[iid] = f["image_info"].get("image_url") or f"https://cf.shopee.co.th/file/{iid}"
    img = d.get("image") or {}
    urls = img.get("image_url_list") or []
    for i, iid in enumerate(img.get("image_id_list") or []):
        if iid:
            ids.setdefault(iid, urls[i] if i < len(urls) else f"https://cf.shopee.co.th/file/{iid}")
    for tv in (d.get("tier_variation") or []):
        for o in (tv.get("option_list") or []):
            oi = o.get("image") or {}
            iid = oi.get("image_id")
            if iid:
                ids.setdefault(iid, oi.get("image_url") or f"https://cf.shopee.co.th/file/{iid}")
    return ids


def _collect_worklist(path: Path) -> list[dict]:
    """คืน list ของ {image_id, image_url, used_by, is_template} เฉพาะรูปใน sellable docs."""
    used_by: collections.Counter = collections.Counter()
    sellable: dict[str, str] = {}
    n_docs = n_sellable = 0
    for d in _iter_export_docs(path):
        n_docs += 1
        ids = _doc_images(d)
        for iid in ids:
            used_by[iid] += 1
        if d.get("item_status") == "NORMAL" and _doc_stock(d) > 0:
            n_sellable += 1
            sellable.update(ids)
    print(f"docs={n_docs} sellable_docs={n_sellable} unique_images(sellable)={len(sellable)}")
    return [
        {"image_id": iid, "image_url": url, "used_by": used_by[iid],
         "is_template": used_by[iid] > TEMPLATE_MIN_USED_BY}
        for iid, url in sorted(sellable.items())
    ]


def _load_done(path: Path) -> set[str]:
    """image_id ที่ extract สำเร็จแล้ว — resume ข้าม."""
    done = set()
    if path.exists():
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    if json.loads(line).get("status") == "ok":
                        done.add(json.loads(line)["image_id"])
                except Exception:
                    pass
    return done


def _fetch_bytes(url: str) -> tuple[bytes, str]:
    """โหลดรูปเป็น bytes + mime (catalog URL ของเราเอง — ไม่ต้อง DNS-pin เหมือน describe_image)."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req, timeout=15)
    data = resp.read()
    ct = (resp.headers.get("Content-Type") or "").lower()
    mime = ("image/png" if "png" in ct else
            "image/webp" if "webp" in ct else
            "image/gif" if "gif" in ct else "image/jpeg")
    if not data:
        raise ValueError("empty image bytes")
    return data, mime


def _parse_answer(raw: str) -> tuple[str, str]:
    """แกะ {kind, text} จาก JSON response — fail → kind="raw" เก็บ text ดิบไว้."""
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        obj = json.loads(s)
        return str(obj.get("kind") or "raw"), str(obj.get("text") or "")
    except Exception:
        return "raw", raw.strip()


# client cache ต่อ key — สร้าง Client ใหม่ทุก call (แบบ llm._client()) เจอ bug
# "client has been closed" เพราะ SDK share httpx transport ที่ถูก GC ปิดไป
# rotation ยังทำงานเหมือนเดิม: วน key → คืน client ของ key นั้น
_CLIENTS: dict = {}
_KEY_CYCLE = None


def _next_client():
    global _KEY_CYCLE
    import itertools
    from google import genai
    if _KEY_CYCLE is None:
        _KEY_CYCLE = itertools.cycle(llm._API_KEYS)
    key = next(_KEY_CYCLE)
    if key not in _CLIENTS:
        _CLIENTS[key] = genai.Client(api_key=key)
    return _CLIENTS[key]


def _extract_one(item: dict) -> dict:
    """ยิง vision 1 รูป (retry ≤3) → entry dict พร้อมบันทึก. ทุก call log AI Usage Hub."""
    from google.genai import types as _t
    from google.genai import errors as _e

    entry = {
        "image_id": item["image_id"], "image_url": item["image_url"],
        "used_by": item["used_by"], "is_template": item["is_template"],
        "model": MODEL, "status": "error", "attempts": 0, "ts": int(time.time()),
    }
    try:
        img_bytes, mime = _fetch_bytes(item["image_url"])
    except Exception as exc:
        entry["error"] = f"download: {exc}"
        return entry

    for attempt in range(1, MAX_ATTEMPTS + 1):
        entry["attempts"] = attempt
        t0 = time.time()
        try:
            resp = _next_client().models.generate_content(
                model=MODEL,
                contents=[_EXTRACT_PROMPT, _t.Part.from_bytes(data=img_bytes, mime_type=mime)],
                config={"temperature": 0.1, "max_output_tokens": 4000},
            )
            usage = getattr(resp, "usage_metadata", None)
            pt = getattr(usage, "prompt_token_count", 0) or 0
            ot = getattr(usage, "candidates_token_count", 0) or 0
            finish = str(resp.candidates[0].finish_reason) if resp.candidates else ""
            kind, text = _parse_answer(resp.text or "")
            entry.update(
                status="ok", kind=kind, text=text,
                prompt_tokens=pt, output_tokens=ot,
                cost_usd=round(llm._gemini_cost(pt, ot), 6),
                finish_reason=finish,
                truncated="MAX_TOKENS" in finish.upper(),
                error=None,
            )
            status, err_msg = "success", None
        except _e.ClientError as exc:
            status, err_msg = "error", str(exc)[:300]
            entry["error"] = err_msg
            # 429/quota — รอแล้ว retry (key ถัดไปถูก rotate ใน _client() อัตโนมัติ)
            if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg:
                time.sleep(65)
                continue
            break
        except Exception as exc:  # network/parse — retry
            status, err_msg = "error", str(exc)[:300]
            entry["error"] = err_msg
            time.sleep(5)
            continue
        break

    usage_entry = {
        "provider": "gemini", "model": MODEL, "operation": "image_text_extract",
        "source": "build_image_texts", "user": "system:chatbot",
        "reference": f"image:{item['image_id']}",
        "prompt_tokens": entry.get("prompt_tokens", 0),
        "completion_tokens": entry.get("output_tokens", 0),
        "cost_usd": entry.get("cost_usd", 0.0),
        "duration_ms": int((time.time() - t0) * 1000),
        "attempt": entry["attempts"], "status": status,
        "http_status": 200 if status == "success" else 0,
        "error_message": err_msg,
    }
    # เขียน local usage log ก่อนเสมอ — hub post timeout ทิ้งได้โดยไม่เสียข้อมูล
    # (backfill_ai_usage.py replay ไฟล์นี้เข้า hub ทีหลังได้)
    try:
        with open(USAGE_LOG_PATH, "a", encoding="utf-8") as uf:
            uf.write(json.dumps(usage_entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
    if not os.environ.get("IMGTXT_SKIP_HUB"):  # hub ล่ม=timeout 5s/call — skip ได้ (usage อยู่ local log, backfill ทีหลัง)
        web_search._log_ai_usage(usage_entry)
    return entry


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="จำกัดจำนวนรูป (0=ไม่จำกัด)")
    ap.add_argument("--max-calls", type=int, default=4000, help="เพดาน call ต่อ run (quota/day รวมทุก key)")
    ap.add_argument("--shard", type=str, default="", help="K/N — รันเฉพาะ slice ที่ K (0-based) จาก N shards (parallel workers)")
    args = ap.parse_args()

    work = _collect_worklist(EXPORT_PATH)
    done = _load_done(OUTPUT_PATH)
    todo = [w for w in work if w["image_id"] not in done]
    if args.shard:
        k, n = (int(x) for x in args.shard.split("/"))
        todo = todo[k::n]
    if args.limit:
        todo = todo[: args.limit]
    print(f"done={len(done)} todo={len(todo)} max_calls={args.max_calls} shard={args.shard or '-'}")

    n_ok = n_err = 0
    cost_sum = 0.0
    t_start = time.time()
    with open(OUTPUT_PATH, "a", encoding="utf-8") as out:
        for i, item in enumerate(todo):
            if i >= args.max_calls:
                print(f"⛔ ถึง max_calls={args.max_calls} — หยุด (รันซ้ำ resume ต่อได้)")
                break
            t_call = time.time()
            entry = _extract_one(item)
            out.write(json.dumps(entry, ensure_ascii=False) + "\n")
            out.flush()
            if entry["status"] == "ok":
                n_ok += 1
                cost_sum += entry.get("cost_usd", 0)
            else:
                n_err += 1
            if (i + 1) % 25 == 0 or i < 5:
                el = time.time() - t_start
                print(f"[{i+1}/{len(todo)}] ok={n_ok} err={n_err} cost=${cost_sum:.3f} "
                      f"rate={(i+1)/el:.2f}/s eta={(len(todo)-i-1)/((i+1)/el)/60:.0f}m "
                      f"last={entry.get('kind','-')} {entry['image_id']}", flush=True)
            time.sleep(max(0.0, MIN_INTERVAL - (time.time() - t_call)))

    print(f"\nDone: ok={n_ok} err={n_err} cost=${cost_sum:.3f} "
          f"(~฿{cost_sum*34:.0f}) elapsed={(time.time()-t_start)/60:.0f}m")
    print(f"output → {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
