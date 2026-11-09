# K2 — Zaapi KB file-import into shared admin Mongo (file-backed serving)

**Branch:** `codex/zaapi-kb-closeout` · **Date:** 2026-11-09 · **Status:** awaiting 2 decisions

## Verified real state (2026-11-09, read-only)

- `zaapi_kb`: 8,600 docs — **old-format** rows (no `source_file`/`file_rev`/`apply_id`) → invisible to file-backed search; left untouched as rollback
- `zaapi_kb_files` registry: **0 docs** → `zaapi_search` returns empty now
- `zaapi_kb_records`: 0 → canonical path dormant (spec v4 supersedes; **not** K2 work)
- `kb_source = legacy`; `pool_sources.kb = true`
- Files: `docs/zaapi/kb-export/knowledge-files/*.xlsx` — 118 files, `knowledge-sources.json` manifest reconciles (118/8,600/8,597 fingerprints)

## Work

Bulk `apply_import` per file (staged rev+1 → CAS publish triple) — the merged, reviewed path. No code changes expected.

Per file: `accounts=[shop]`, `platforms=["shopee"]`, `content_type`/`sheet_types` per decision below, `admin="k2-import"`.
Idempotent per spec: same file re-import = rev+1 full replace, CAS-loser self-cleans.
Rollback: registry `prev_apply`/prev_rev per file; old rows remain until `_RETIRE_S`.

## Open decisions (blocking write)

### D1 — content_type (required for visibility)

`zaapi_kb_evidence` queries `types=("product",)` — rows without `content_type="product"` are **invisible to the bot**. Allowed set: `product | troubleshooting | faq | warranty`.

Options:
- **A.** declare every file `content_type="product"` — all rows searchable; type label is loose but spec only requires admin-declared
- **B.** classify per file/sheet properly (product/troubleshooting/faq/warranty) AND widen evidence `types` — semantically correct, needs type-list change in `kb_zaapi.py`
- **C.** mixed: declare `product` now, re-type later via re-import (rev+1 per file)

### D2 — accounts mapping (shop scoping)

Filenames contain Zaapi display names (`Black Shark Thailand`); system shop names differ (`BlackShark`). Empty accounts = file serves **all** shops (leak for shop-specific promos). Proposed: normalize (strip spaces/lowercase) → map to `shops.shopname`; unmapped files reported for manual declaration, not auto-global.

## Verification

- Per-file: `apply_import` result (new_rows, CAS ok) + registry triple
- After: `_visible_pairs` count, `zaapi_search` hits per shop (right-shop hits >0, wrong-shop 0), import log entries
- `file_kb_ready` true; regression tests unaffected (offline + disposable already green)
EOF
