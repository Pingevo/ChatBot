"""Validate docs/test/gold_retrieval.jsonl rows."""
from __future__ import annotations

import json
import sys
from pathlib import Path

REQUIRED = {
    "id", "shop", "message", "intent", "expected_answer_mode",
    "acceptable_item_ids", "must_not_item_ids", "expected_product_type",
    "expected_catalog_status", "requires_evidence",
}

INTENTS = {
    "recommend", "exact_model", "spec", "compare", "compatibility",
    "warranty", "claim", "refund", "tax_invoice", "handoff", "order",
    "superlative", "history", "general", "other",
}
ANSWER_MODES = {
    "products", "recommend", "no_such_type", "no_info", "out_of_stock",
    "discontinued", "handoff", "policy", "inform_only",
}
EVIDENCE = {"spec", "warranty", "compatibility", "order_history"}
NO_PRODUCT_MODES = {"no_such_type", "no_info"}
NEGATIVE_MODES = {"out_of_stock", "no_such_type", "discontinued", "handoff"}
SENSITIVE_INTENTS = {"refund", "tax_invoice"}

GAP_CHECKS = [
    ("history", lambda r: bool(r.get("history")), 8),
    ("out_of_stock", lambda r: r.get("expected_answer_mode") == "out_of_stock", 3),
    ("unlisted/discontinued",
     lambda r: r.get("expected_catalog_status") in {"unlisted", "discontinued"}, 3),
    ("refund", lambda r: r.get("intent") == "refund", 3),
    ("tax_invoice", lambda r: r.get("intent") == "tax_invoice", 3),
    ("handoff", lambda r: r.get("expected_answer_mode") == "handoff", 3),
    ("old_order_item", lambda r: "old_order_item" in (r.get("tags") or []), 1),
    ("mi17 follow-up",
     lambda r: "mi 17" in str(r.get("expected_target_device") or "").lower()
     and bool(r.get("history")), 1),
]


def validate_gaps(rows: list[dict]) -> list[str]:
    """Semantic coverage quotas required before runtime work may start."""
    errors = [
        f"gap: need >= {need} {name} rows, got {sum(1 for r in rows if check(r))}"
        for name, check, need in GAP_CHECKS
        if sum(1 for r in rows if check(r)) < need
    ]
    for i, row in enumerate(rows, 1):
        sensitive = (
            row.get("expected_answer_mode") in NEGATIVE_MODES
            or row.get("intent") in SENSITIVE_INTENTS
        )
        if sensitive and not row.get("must_not_phrases"):
            errors.append(
                f"row {i} ({row.get('id')}): negative/sensitive case missing must_not_phrases")
    return errors


def validate_rows(rows: list[dict]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for i, row in enumerate(rows, 1):
        rid = str(row.get("id") or "")
        missing = sorted(REQUIRED - set(row))
        if missing:
            errors.append(f"row {i} missing {missing}")
        if not rid:
            errors.append(f"row {i} missing id")
        elif rid in seen:
            errors.append(f"row {i} duplicate id {rid}")
        seen.add(rid)

        intent = row.get("intent")
        if intent is not None and intent not in INTENTS:
            errors.append(f"row {i} unknown intent {intent}")
        mode = row.get("expected_answer_mode")
        if mode is not None and mode not in ANSWER_MODES:
            errors.append(f"row {i} unknown expected_answer_mode {mode}")
        if mode in NO_PRODUCT_MODES and row.get("min_output_power_w"):
            errors.append(f"row {i} has min_output_power_w but expected_answer_mode={mode}")

        for key in ("acceptable_item_ids", "must_not_item_ids", "requires_evidence"):
            if not isinstance(row.get(key), list):
                errors.append(f"row {i} {key} must be list")
        bad_evidence = set(row.get("requires_evidence") or []) - EVIDENCE
        if bad_evidence:
            errors.append(f"row {i} unknown requires_evidence {sorted(bad_evidence)}")
        for key in ("history", "must_not_phrases"):
            if key in row and not isinstance(row[key], list):
                errors.append(f"row {i} {key} must be list")
    return errors


def load_jsonl(path: str) -> list[dict]:
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: validate_gold_retrieval.py docs/test/gold_retrieval.jsonl", file=sys.stderr)
        return 2
    rows = load_jsonl(argv[1])
    errors = validate_rows(rows) + validate_gaps(rows)
    for err in errors:
        print(err)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
