"""Extract structured text จากรูปด้วย Gemini vision — bounded incremental OCR
ของ evidence generation (Phase 4B).

วิธีใช้:
    .venv/bin/python chatbot/shopeechat/scripts/build_image_texts.py \
        --export exports/gen/<gid>/ShpProducts.export.json \
        --gen-dir exports/gen/<gid> --gid <gid> --scope sellable \
        [--max-calls N] [--max-runtime-min M] [--limit N] [--shard K/N]

ผลลัพธ์ (generation-scoped):
    exports/gen/<gid>/image_texts.jsonl — evidence set สมบูรณ์ของ gen
        {image_id, image_url, kind, text, truncated, item_ids} — reuse (unchanged)
        + fresh (new/changed/retryable) เท่านั้น; error/deferred ไม่อยู่ใน set

OCR cache = shared collection `image_texts` (runtime ไม่อ่าน — published evidence
อยู่ image_texts_g<gid>): fingerprint(image_id+normalized_url), status
(ok|error|deferred), error_class, attempts_total, last_generation_id
classify: unchanged|new|changed|retryable_error|deferred|removed
quota/budget/เวลาหมด → เหลือเป็น deferred (ไม่ใช่ error) run-level stop

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


def _discover_images(path: Path) -> dict[str, dict]:
    """image_id → {image_url, used_by, item_ids, sellable_item_ids} จาก export ทั้งก้อน.

    discovery owner เดียวของ generation — materialize/classify/units ใช้ map เดียวกัน
    """
    info: dict[str, dict] = {}
    n_docs = 0
    for d in _iter_export_docs(path):
        n_docs += 1
        sellable = d.get("item_status") == "NORMAL" and _doc_stock(d) > 0
        try:
            item_id = int(d.get("item_id"))
        except (TypeError, ValueError):
            continue
        for iid, url in _doc_images(d).items():
            e = info.setdefault(iid, {"image_url": url, "used_by": 0,
                                      "item_ids": set(), "sellable_item_ids": set()})
            e["used_by"] += 1
            e["item_ids"].add(item_id)
            if sellable:
                e["sellable_item_ids"].add(item_id)
    print(f"docs={n_docs} unique_images={len(info)}")
    return info


def _collect_worklist(path: Path, scope: str = "sellable") -> list[dict]:
    """worklist ตาม scope — sellable=รูปที่ sellable doc ใช้, nonsellable=รูปที่
    โผล่เฉพาะใน non-sellable docs (หัก sellable ids ทิ้งเหมือนเดิม)."""
    info = _discover_images(path)
    items = []
    for iid, e in sorted(info.items()):
        if scope == "sellable" and not e["sellable_item_ids"]:
            continue
        if scope == "nonsellable" and e["sellable_item_ids"]:
            continue
        items.append({"image_id": iid, "image_url": e["image_url"],
                      "used_by": e["used_by"],
                      "is_template": e["used_by"] > TEMPLATE_MIN_USED_BY,
                      "item_ids": sorted(e["item_ids"])})
    print(f"scope={scope} worklist={len(items)}")
    return items


# ---- Phase 4B: fingerprint classification + OCR cache state -----------------
#
# `image_texts` (shared collection) = OCR processing cache เท่านั้น — runtime
# ไม่อ่าน; evidence ที่ลูกค้าเห็นอยู่ `image_texts_g<gid>` (materialize แยก)
# fingerprint = image_id + normalized_url → URL เปลี่ยน = re-OCR

_RETRYABLE_ERRORS = {"quota", "transient"}


def _normalize_url(url: str) -> str:
    """ตัด query/fragment/trailing slash — URL เดียวกันรูปแบบต่าง = fingerprint เดียว"""
    return (url or "").split("?")[0].split("#")[0].strip().rstrip("/")


def _fingerprint(image_id: str, url: str) -> str:
    return f"{image_id}|{_normalize_url(url)}"


def _error_class(msg: str) -> str:
    """quota/transient = retryable ใน run ถัดไป; อื่น = permanent (ไม่เผา retry)"""
    m = (msg or "").lower()
    if "429" in m or "resource_exhausted" in m or "quota" in m:
        return "quota"
    if any(k in m for k in ("timeout", "timed out", "deadline", "unavailable",
                            "500", "502", "503", "connection")):
        return "transient"
    return "permanent"


def _classify_images(discovered: dict[str, str], cache: dict[str, dict]) -> dict[str, str]:
    """image_id → unchanged|new|changed|retryable_error|deferred|removed.

    - unchanged: cache ok + fingerprint ตรง → reuse evidence (0 provider call)
      — รวม error ที่ไม่ retryable/attempts หมดแล้วด้วย (skip — ไม่เผาอีก)
    - new: ไม่เคยอยู่ใน cache; changed: fingerprint ต่าง (URL เปลี่ยน)
    - retryable_error: error ที่ retry ได้และ attempts_total < MAX_ATTEMPTS
    - deferred: run ก่อนตัดงบ — run นี้ทำต่อได้ภายใต้ budget เดียวกัน
    - removed: อยู่ใน cache แต่ไม่อยู่ใน catalog gen นี้ → detach
    """
    out: dict[str, str] = {}
    for iid, url in discovered.items():
        doc = cache.get(iid)
        if doc is None:
            out[iid] = "new"
            continue
        fp = _fingerprint(iid, url)
        if doc.get("fingerprint") != fp:
            # accepted ok คงอยู่ + pending retry budget หมด → หยุด OCR (bounded
            # ข้าม run) — เก็บ accepted เดิมไว้, ไม่ publish (fp ต่างกัน).
            # budget เป็นของ pending_fingerprint เดียวกันเท่านั้น — fingerprint
            # ใหม่ (C) ได้ budget ของตัวเอง ห้ามถูกบล็อกโดย B ที่ exhausted
            if (doc.get("status") == "ok"
                    and doc.get("pending_fingerprint") == fp
                    and (doc.get("pending_attempts_total") or 0)
                    >= MAX_ATTEMPTS):
                out[iid] = "unchanged"
            else:
                out[iid] = "changed"
            continue
        status = doc.get("status")
        if status == "deferred":
            out[iid] = "deferred"
        elif status == "ok":
            out[iid] = "unchanged"
        elif (status == "error" and doc.get("error_class") in _RETRYABLE_ERRORS
              and (doc.get("attempts_total") or 0) < MAX_ATTEMPTS):
            out[iid] = "retryable_error"
        else:
            out[iid] = "unchanged"
    for iid in cache:
        if iid not in discovered:
            out[iid] = "removed"
    return out


_PENDING_FIELDS = ("pending_fingerprint", "pending_status", "pending_error",
                   "pending_error_class", "pending_attempts_total",
                   "pending_last_generation_id")


def _cache_upsert(coll, image_id: str, unset: tuple = (), **fields) -> None:
    """cache-state write owner (build phase เท่านั้น) — UpdateOne keyed image_id."""
    from pymongo import UpdateOne
    fields["image_id"] = image_id
    fields["ts"] = int(time.time())
    update = {"$set": fields}
    if unset:
        update["$unset"] = {k: "" for k in unset}
    coll.bulk_write([UpdateOne({"image_id": image_id}, update,
                             upsert=True)])


def _evidence_record(item: dict, doc: dict) -> dict:
    """published evidence shape — fields เดียวกับ cache-ok แต่ไม่มี state metadata"""
    return {"image_id": item["image_id"], "image_url": item["image_url"],
            "kind": doc.get("kind"), "text": doc.get("text"),
            "truncated": doc.get("truncated"),
            "item_ids": item.get("item_ids") or []}


def run_generation_ocr(work: list[dict], db, gen_dir: Path, gid: str,
                       max_calls: int, deadline_ts: float | None = None) -> dict:
    """bounded incremental OCR สำหรับ generation เดียว.

    - classify vs cache → unchanged reuse evidence (0 calls), work classes OCR
      ต่อ item ภายใต้ max_calls (นับทุก attempt) + deadline
    - budget/เวลาหมด หรือ provider quota → ที่เหลือ status=deferred ใน cache
      (ไม่ใช่ error, ไม่ทำ generation fail) + run-level stop
    - removed → item_ids=[] (audit คงไว้ใน cache, ไม่อยู่ใน published set)
    - เขียน gen_dir/image_texts.jsonl = evidence set สมบูรณ์ของ gen (reuse+fresh)
    """
    coll = db["image_texts"]
    cache = {d["image_id"]: d for d in coll.find({})}
    discovered = {w["image_id"]: w["image_url"] for w in work}
    cls = _classify_images(discovered, cache)
    evidence: list[dict] = []
    counts = {"unchanged": 0, "new": 0, "changed": 0, "retryable_error": 0,
              "deferred": 0, "removed": 0, "processed": 0, "calls": 0}
    calls_used = 0
    stop = False
    for item in work:
        iid = item["image_id"]
        state = cls[iid]
        fp = _fingerprint(iid, item["image_url"])
        base = {"fingerprint": fp, "image_url": item["image_url"],
                "item_ids": item.get("item_ids") or [],
                "last_generation_id": gid}
        if state == "unchanged":
            counts["unchanged"] += 1
            doc = cache.get(iid) or {}
            # publish เฉพาะ accepted record ที่ fingerprint ตรง discovered —
            # accepted fp เก่า (URL เปลี่ยน) ห้ามไหลเข้า generation ใหม่
            if (doc.get("status") == "ok" and doc.get("text")
                    and doc.get("fingerprint") == fp):
                evidence.append(_evidence_record(item, doc))
            continue
        # accepted ok + fingerprint เปลี่ยน → เก็บ accepted ไว้, เขียน pending_*
        has_accepted = (state == "changed"
                        and (cache.get(iid) or {}).get("status") == "ok")
        prev = cache.get(iid) or {}
        # pending state เป็นของ (image_id, pending_fingerprint) — fingerprint
        # เปลี่ยน (B→C) → attempts/error ของ fp เก่าไม่ไหลมา, C เริ่มนับใหม่
        same_pending_fp = prev.get("pending_fingerprint") == fp
        prev_pending_attempts = (
            prev.get("pending_attempts_total") or 0) if same_pending_fp else 0
        # work classes — budget/wall-clock หมด → mark deferred แทน error
        if stop or calls_used >= max_calls or (
                deadline_ts is not None and time.time() >= deadline_ts):
            if has_accepted:
                _cache_upsert(coll, iid,
                              item_ids=item.get("item_ids") or [],
                              last_generation_id=gid,
                              pending_fingerprint=fp,
                              pending_status="deferred",
                              pending_error=(prev.get("pending_error")
                                             if same_pending_fp else None),
                              pending_error_class=(
                                  prev.get("pending_error_class")
                                  if same_pending_fp else None),
                              pending_attempts_total=prev_pending_attempts,
                              pending_last_generation_id=gid)
            else:
                _cache_upsert(coll, iid, status="deferred", **base)
            counts["deferred"] += 1
            continue
        entry = _extract_one(item)
        calls_used += int(entry.get("attempts") or 1)
        counts["calls"] = calls_used
        counts["processed"] += 1
        counts[state] += 1
        if entry["status"] == "ok":
            _cache_upsert(coll, iid, status="ok", kind=entry.get("kind"),
                          text=entry.get("text"),
                          truncated=entry.get("truncated"),
                          error=None, error_class=None, attempts_total=0,
                          unset=_PENDING_FIELDS,
                          **base)
            evidence.append(_evidence_record(item, entry))
        elif entry["status"] == "deferred":
            if has_accepted:
                _cache_upsert(coll, iid,
                              item_ids=item.get("item_ids") or [],
                              last_generation_id=gid,
                              pending_fingerprint=fp,
                              pending_status="deferred",
                              pending_error=entry.get("error"),
                              pending_error_class=_error_class(
                                  entry.get("error") or ""),
                              pending_attempts_total=(prev_pending_attempts
                                  + int(entry.get("attempts") or 1)),
                              pending_last_generation_id=gid)
            else:
                _cache_upsert(coll, iid, status="deferred",
                              error=entry.get("error"), **base)
            counts["deferred"] += 1
            stop = True            # quota exhaustion → run-level stop
        else:
            if has_accepted:
                _cache_upsert(
                    coll, iid,
                    item_ids=item.get("item_ids") or [],
                    last_generation_id=gid,
                    pending_fingerprint=fp,
                    pending_status="error",
                    pending_error=entry.get("error"),
                    pending_error_class=_error_class(
                        entry.get("error") or ""),
                    pending_attempts_total=(prev_pending_attempts
                        + int(entry.get("attempts") or 1)),
                    pending_last_generation_id=gid)
            else:
                _cache_upsert(
                    coll, iid, status="error", error=entry.get("error"),
                    error_class=_error_class(entry.get("error") or ""),
                    attempts_total=(prev.get("attempts_total") or 0)
                    + int(entry.get("attempts") or 1),
                    **base)
        time.sleep(MIN_INTERVAL)
    for iid, state in cls.items():
        if state != "removed":
            continue
        counts["removed"] += 1
        _cache_upsert(coll, iid, item_ids=[], last_generation_id=gid)
    if evidence:
        gen_dir.mkdir(parents=True, exist_ok=True)
        with open(gen_dir / "image_texts.jsonl", "w", encoding="utf-8") as f:
            for e in evidence:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"ocr gen={gid} counts={counts} evidence={len(evidence)}")
    return counts


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
            # 429/quota → deferred + run-level stop (ไม่เผา 65s×3 ต่อรูป)
            if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg:
                status, entry["status"] = "deferred", "deferred"
                break
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
    ap.add_argument("--export", type=Path, default=EXPORT_PATH)
    ap.add_argument("--gen-dir", type=Path, default=ROOT / "exports")
    ap.add_argument("--gid", type=str, default="")
    ap.add_argument("--scope", choices=["sellable", "nonsellable"],
                    default="sellable")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-calls", type=int,
                    default=int(os.environ.get("IMGTXT_MAX_CALLS", "1500")),
                    help="เพดาน provider call ต่อ phase — นับทุก attempt")
    ap.add_argument("--max-runtime-min", type=float,
                    default=float(os.environ.get("IMGTXT_MAX_RUNTIME_MIN", "90")))
    ap.add_argument("--shard", type=str, default="", help="K/N")
    args = ap.parse_args()
    if not args.gid:
        sys.exit("--gid required (one generation_id per refresh run)")

    work = _collect_worklist(args.export, scope=args.scope)
    if args.shard:
        k, n = (int(x) for x in args.shard.split("/"))
        work = work[k::n]
    if args.limit:
        work = work[: args.limit]

    deadline = time.time() + args.max_runtime_min * 60
    env_deadline = os.environ.get("REFRESH_DEADLINE_EPOCH")
    if env_deadline:
        deadline = min(deadline, float(env_deadline))

    from chatbot.shopeechat import knowledge_base as _kb
    db = _kb._admin_db()
    counts = run_generation_ocr(work, db=db, gen_dir=args.gen_dir,
                                gid=args.gid, max_calls=args.max_calls,
                                deadline_ts=deadline)
    print(f"Done: {counts}")


if __name__ == "__main__":
    main()
