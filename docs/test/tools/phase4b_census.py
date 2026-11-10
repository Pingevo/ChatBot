"""Phase 4 Gate 4B — deterministic raw/source census (file-only path).

Counts over `docs/zaapi/kb-export/` snapshot through the importer row
semantics (`_build_docs` — owner เดิม, ไม่ copy) และ schema owners เท่านั้น:
sources, raw rows, distinct `content_fingerprint`, deliveries (accounts
expansion), account-scope distribution (`canonical_delivery_scope` — owner
เดียว), malformed/empty/content-collision distribution. Every row is rebuilt
into its closed storage doc and passed through `validate_raw_row` —
ตัวเลขที่ขัด contract → exit nonzero (RED fail condition ของ task).

Provider-free, read-only; writes report to docs/test/results/ (gitignored).
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT / "docs/zaapi/script"))

from shopeechat.kb_zaapi_schema import (  # noqa: E402
    RAW_CONTENT_FIELDS, canonical_delivery_scope, canonical_json,
    fingerprint, raw_row_id, sanitize_source_row, validate_raw_row)
from import_zaapi_kb import _build_docs  # noqa: E402

EXPORT = ROOT / "docs/zaapi/kb-export"
FILES_DIR = EXPORT / "knowledge-files"
SOURCES_MANIFEST = EXPORT / "knowledge-sources.json"
REPORT = ROOT / "docs/test/results/phase4b_census.md"


def census() -> dict:
    """Run the census; returns the stats dict (also printed as JSON)."""
    items = json.loads(SOURCES_MANIFEST.read_text(encoding="utf-8"))["items"]
    stats = {
        "sources_declared": len(items),
        "sources_parsed": 0,
        "malformed_sources": [],
        "empty_sources": [],
        "raw_rows": 0,
        "content_fingerprints": set(),
        "raw_row_ids": set(),
        "deliveries": 0,
        "scope_counts": Counter(),
        "kind_counts": Counter(),
        "rows_per_source": {},
        "collision_fingerprints": Counter(),
    }
    for item in sorted(items, key=lambda i: str(i.get("id", ""))):
        source_id = item["id"]
        try:
            rows = _build_docs(item, FILES_DIR, "census")
        except Exception as exc:  # noqa: BLE001 — census รายงานไม่ล้ม
            stats["malformed_sources"].append(
                {"source_id": source_id, "error": str(exc)})
            continue
        stats["sources_parsed"] += 1
        if not rows:
            stats["empty_sources"].append(source_id)
        n_accounts = len(item.get("accounts") or [])
        for account in item.get("accounts") or []:
            stats["scope_counts"][canonical_delivery_scope(
                account.get("name", ""), account.get("platform", ""))] += 1
        stats["rows_per_source"][source_id] = len(rows)
        for row in rows:
            # rebuild closed storage doc → validate_raw_row (contract gate)
            stored = {
                **row,
                "raw_row_json": canonical_json(
                    {k: row.get(k) for k in RAW_CONTENT_FIELDS}),
                "active": False,
                "_id": raw_row_id(row)}
            validate_raw_row(stored)
            safe = sanitize_source_row(row)
            cfp = fingerprint(
                {k: safe.get(k) for k in RAW_CONTENT_FIELDS})
            stats["content_fingerprints"].add(cfp)
            stats["raw_row_ids"].add(stored["_id"])
            stats["collision_fingerprints"][cfp] += 1
            stats["deliveries"] += n_accounts
            stats["kind_counts"][row["kind"]] += 1
            stats["raw_rows"] += 1
    return stats


def _render(stats: dict) -> str:
    collisions = {fp: n for fp, n in stats["collision_fingerprints"].items()
                  if n > 1}
    lines = [
        "# Phase 4 Gate 4B — raw/source census (file-only)",
        "",
        f"- sources declared: {stats['sources_declared']}",
        f"- sources parsed: {stats['sources_parsed']}",
        f"- malformed sources: {len(stats['malformed_sources'])}",
        f"- empty sources (0 rows): {len(stats['empty_sources'])}",
        f"- raw rows: {stats['raw_rows']}",
        f"- distinct content_fingerprint: "
        f"{len(stats['content_fingerprints'])}",
        f"- distinct raw_row_id: {len(stats['raw_row_ids'])}",
        f"- deliveries (rows × accounts): {stats['deliveries']}",
        f"- content-fingerprint collisions (>1 row share): "
        f"{len(collisions)} fingerprint(s) covering "
        f"{sum(collisions.values())} rows",
        "",
        "## kind distribution",
        "",
    ]
    lines += [f"- {k}: {v}" for k, v in sorted(stats["kind_counts"].items())]
    lines += ["", "## account scope distribution (canonical_delivery_scope)",
              ""]
    lines += [f"- {shop!r} / {plat!r}: {n}"
              for (shop, plat), n in sorted(
                  stats["scope_counts"].items(),
                  key=lambda kv: (-kv[1], kv[0]))]
    if stats["malformed_sources"]:
        lines += ["", "## malformed sources", ""]
        lines += [f"- `{m['source_id']}`: {m['error']}"
                  for m in stats["malformed_sources"]]
    if stats["empty_sources"]:
        lines += ["", "## empty sources", ""]
        lines += [f"- `{s}`" for s in stats["empty_sources"]]
    lines += ["", "## rows per source", ""]
    lines += [f"- `{sid}`: {n}"
              for sid, n in sorted(stats["rows_per_source"].items())]
    return "\n".join(lines) + "\n"


def main() -> int:
    stats = census()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(_render(stats), encoding="utf-8")
    out = {
        "sources_declared": stats["sources_declared"],
        "sources_parsed": stats["sources_parsed"],
        "malformed": len(stats["malformed_sources"]),
        "empty": len(stats["empty_sources"]),
        "raw_rows": stats["raw_rows"],
        "distinct_content_fingerprint": len(
            stats["content_fingerprints"]),
        "deliveries": stats["deliveries"],
        "report": str(REPORT),
    }
    print(canonical_json(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
