"""Offline retrieval metrics from replay result files.

Usage:
  .venv/bin/python docs/test/eval_retrieval.py <results.jsonl|results.json>
  .venv/bin/python docs/test/eval_retrieval.py <results.jsonl> --gold docs/test/gold_retrieval.jsonl
  .venv/bin/python docs/test/eval_retrieval.py <results.jsonl> --gold <gold> --by-intent
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from validate_gold_retrieval import validate_rows

_WANTS_PRODUCTS = {
    "recommend", "compatibility", "compare", "spec", "exact_model",
    "superlative",
}
_NO_PRODUCT_MODES = {"no_such_type", "no_info"}

_MODE_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("no_info", ("ไม่พบข้อมูล", "ไม่พบสินค้า", "ไม่มีข้อมูลรุ่น", "ไม่พบรุ่น")),
    ("no_such_type", ("ไม่มีสินค้าประเภท", "ไม่มีจำหน่าย", "ไม่มีสินค้าชนิด",
                      "ไม่ได้จำหน่าย", "ไม่มีขาย")),
    ("discontinued", ("เลิกจำหน่าย", "เลิกผลิต", "ยกเลิกการจำหน่าย")),
    ("out_of_stock", ("หมดสต็อก", "สินค้าหมด", "ของหมด")),
    ("handoff", ("ส่งต่อแอดมิน", "ให้แอดมิน", "เจ้าหน้าที่จะติดต่อ")),
)


def classify_answer_mode(answer: str) -> str:
    """Classify coarse answer mode from answer text."""
    answer = answer or ""
    for mode, patterns in _MODE_PATTERNS:
        if any(pattern in answer for pattern in patterns):
            return mode
    return "recommend"


_POLICY_SOURCES = {"return_refund_ask_order", "cert_answer", "warranty_claim_first_message"}


def _record_answer_mode(rec: dict) -> str:
    source = str(rec.get("source") or "")
    if rec.get("handoff_to_admin") or "handoff" in source:
        return "handoff"
    if source.startswith("general:") or source in _POLICY_SOURCES:
        return "policy"
    return classify_answer_mode(rec.get("answer") or "")


def _expected_mode(mode: str | None) -> str | None:
    return "recommend" if mode == "products" else mode


def _norm_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _norm_item_id(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value)
    return text[:-2] if text.endswith(".0") else text


def _record_key(rec: dict) -> tuple[str, str]:
    return _norm_text(rec.get("shop")), _norm_text(rec.get("message") or rec.get("msg"))


def _load_json(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return []
    if path.suffix == ".json":
        data = json.loads(text)
        return data if isinstance(data, list) else [data]
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _flatten_conversation(rec: dict) -> list[dict]:
    meta = rec.get("_meta") or {}
    shop = rec.get("shop") or rec.get("shop_name") or meta.get("shop")
    out = []
    for i, qa in enumerate(rec.get("qa") or [], 1):
        out.append({
            "id": f"{rec.get('conv_id') or rec.get('conversation_id') or 'conv'}:{qa.get('i', i)}",
            "topic": "conversation",
            "shop": shop,
            "message": qa.get("message") or qa.get("user_message") or qa.get("user") or "",
            "answer": qa.get("bot_answer") or qa.get("answer") or "",
            "products": qa.get("bot_products") or qa.get("products") or [],
            "source": qa.get("bot_source") or qa.get("source"),
            "unit_path": qa.get("unit_path"),
            "unit_attempted": qa.get("unit_attempted"),
            "handoff_to_admin": qa.get("handoff_to_admin") or qa.get("handoff"),
        })
    return out


def load_results(path: str) -> list[dict]:
    """Load flat question records or nested conversation replay records."""
    out: list[dict] = []
    for rec in _load_json(Path(path)):
        if isinstance(rec, dict) and isinstance(rec.get("qa"), list):
            out.extend(_flatten_conversation(rec))
        elif isinstance(rec, dict):
            if "message" not in rec and "msg" in rec:
                rec = dict(rec)
                rec["message"] = rec.get("msg")
            out.append(rec)
    return out


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _product_rows(rec: dict) -> list[dict]:
    products = rec.get("products")
    return products if isinstance(products, list) else []


def pool_metrics(recs: list[dict]) -> dict:
    diversity, live, pools = [], [], []
    duplicated = 0
    with_products = 0
    for rec in recs:
        products = rec.get("products")
        if isinstance(products, (int, float)):
            if products > 0:
                with_products += 1
                pools.append(float(products))
            continue
        products = products or []
        if not products:
            continue
        with_products += 1
        pools.append(float(len(products)))
        ids = [_norm_item_id(p.get("item_id")) for p in products]
        diversity.append(len(set(ids)) / len(ids))
        if len(set(ids)) < len(ids):
            duplicated += 1
        top5 = products[:5]
        live.append(sum(1 for p in top5 if p.get("_available_for_sale") or p.get("sellable")) / len(top5))
    n = len(recs)
    return {
        "n": n,
        "n_with_products": with_products,
        "listing_diversity": _mean(diversity),
        "dup_pool_rate": duplicated / with_products if with_products else 0.0,
        "live_ratio_top5": _mean(live),
        "unit_share": sum(1 for r in recs if r.get("unit_path")) / n if n else 0.0,
        "fallback_rate": sum(1 for r in recs if r.get("unit_attempted") in
                             {"fallback_dead_pool", "fallback_error"}) / n if n else 0.0,
        "avg_pool": _mean(pools),
    }


def _catalog_status(product: dict) -> str:
    status = str(product.get("catalog_status") or product.get("status") or "").upper()
    return {
        "NORMAL": "active",
        "UNLIST": "unlisted",
        "SELLER_DELETE": "discontinued",
        "DELETED": "discontinued",
        "SHOPEE_DELETE": "discontinued",
        "BANNED": "restricted",
        "REVIEWING": "reviewing",
    }.get(status, status.lower() or "unknown")


def _max_watt(product: dict) -> float:
    for key in ("output_power_w", "max_output_power_w"):
        value = product.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    for variant in product.get("variants") or []:
        value = variant.get("output_power_w")
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    return 0.0


def _find_record(recs: list[dict], gold: dict) -> dict | None:
    gid = str(gold.get("id") or "")
    for rec in recs:
        if str(rec.get("id") or "") == gid:
            return rec
    shop, message = _record_key(gold)
    if shop and message:
        for rec in recs:
            if _record_key(rec) == (shop, message):
                return rec
    return None


def validate_gold(gold: list[dict]) -> list[str]:
    return validate_rows(gold)


def gold_metrics(recs: list[dict], gold: list[dict]) -> dict:
    """Evaluate replay records against human-reviewed gold rows."""
    purity, adequacy, modes = [], [], []
    acceptable_hits: list[float] = []
    distinct_hits: list[float] = []
    must_not_cases = must_not_hits = 0
    phrase_cases = phrase_hits = 0
    status_hits = status_total = 0
    used = 0

    for row in gold:
        rec = _find_record(recs, row)
        if rec is None:
            continue
        used += 1
        products = _product_rows(rec)
        ids = {_norm_item_id(p.get("item_id")) for p in products}
        expected_mode = row.get("expected_answer_mode")

        want_type = row.get("expected_product_type")
        if (want_type and products and row.get("intent") in _WANTS_PRODUCTS
                and expected_mode not in _NO_PRODUCT_MODES):
            purity.append(sum(1 for p in products if p.get("product_type") == want_type) / len(products))

        acceptable = {_norm_item_id(v) for v in row.get("acceptable_item_ids") or []}
        if acceptable:
            acceptable_hits.append(1.0 if acceptable & ids else 0.0)

        must_not = {_norm_item_id(v) for v in row.get("must_not_item_ids") or []}
        if must_not:
            must_not_cases += 1
            must_not_hits += 1 if must_not & ids else 0

        phrases = row.get("must_not_phrases") or []
        if phrases:
            phrase_cases += 1
            answer = rec.get("answer") or ""
            phrase_hits += 1 if any(p in answer for p in phrases) else 0

        want_status = row.get("expected_catalog_status")
        if want_status and products:
            matched = next(
                (p for p in products if _norm_item_id(p.get("item_id")) in acceptable),
                products[0],
            )
            status_total += 1
            status_hits += 1 if _catalog_status(matched) == want_status else 0

        min_watt = row.get("min_output_power_w")
        if min_watt and expected_mode not in _NO_PRODUCT_MODES:
            adequacy.append(1.0 if products and _max_watt(products[0]) >= float(min_watt) else 0.0)

        min_distinct = row.get("min_distinct_listings")
        if min_distinct:
            distinct_hits.append(1.0 if len(ids) >= int(min_distinct) else 0.0)

        if expected_mode:
            modes.append(1.0 if _record_answer_mode(rec) == _expected_mode(expected_mode) else 0.0)

    return {
        "n_gold": used,
        "type_purity": _mean(purity),
        "acceptable_hit_rate": _mean(acceptable_hits),
        "must_not_violation_rate": must_not_hits / must_not_cases if must_not_cases else 0.0,
        "must_not_phrase_violation_rate": phrase_hits / phrase_cases if phrase_cases else 0.0,
        "status_accuracy": status_hits / status_total if status_total else 0.0,
        "adequacy_at_1": _mean(adequacy),
        "min_distinct_listings_rate": _mean(distinct_hits),
        "answer_mode_accuracy": _mean(modes),
    }


def by_intent(recs: list[dict], gold: list[dict]) -> dict[str, dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in gold:
        groups[row.get("intent") or "?"].append(row)
    out: dict[str, dict] = {}
    for intent, rows in sorted(groups.items()):
        matched = [m for row in rows if (m := _find_record(recs, row))]
        out[intent] = {**pool_metrics(matched), **gold_metrics(recs, rows)}
    return out


def _print(title: str, metrics: dict) -> None:
    print(f"\n── {title} ──")
    for key, value in metrics.items():
        if isinstance(value, float):
            print(f"  {key:<32} {value:.3f}")
        else:
            print(f"  {key:<32} {value}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results")
    parser.add_argument("--gold")
    parser.add_argument("--by-intent", action="store_true")
    args = parser.parse_args(argv)

    recs = load_results(args.results)
    _print(f"pool metrics ({args.results})", pool_metrics(recs))
    if not args.gold:
        return 0

    gold = load_results(args.gold)
    errors = validate_gold(gold)
    if errors:
        print("\nGOLD INVALID:")
        for error in errors:
            print(f"  {error}")
        return 1

    _print(f"gold metrics ({args.gold})", gold_metrics(recs, gold))
    if args.by_intent:
        for intent, metrics in by_intent(recs, gold).items():
            _print(f"intent={intent}", metrics)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
