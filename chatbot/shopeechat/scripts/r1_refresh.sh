#!/usr/bin/env bash
# R1 — Phase 4B evidence generation refresh (daily 09:00)
# build-only: OCR cache reuse, units+embeddings, STOP before publish
# publish = separate approved action (runbook)
set -euo pipefail
cd "$(dirname "$0")/../../.."
GID=$(.venv/bin/python -c "import sys; sys.path.insert(0,'.'); from chatbot.shopeechat.generation_pointer import mint_generation_id; print(mint_generation_id())")
DIR="exports/gen/$GID"; mkdir -p "$DIR"
echo "[r1] gid=$GID start=$(date -u +%FT%TZ)"
.venv/bin/python chatbot/shopeechat/scripts/build_image_texts.py --gen-dir "$DIR" --gid "$GID" --scope sellable
.venv/bin/python chatbot/shopeechat/scripts/build_sellable_units.py --export exports/ShpProducts.export.json --image-texts "$DIR/image_texts.jsonl" --out "$DIR/sellable_units.jsonl"
.venv/bin/python chatbot/shopeechat/scripts/build_embeddings.py --units --units-path "$DIR/sellable_units.jsonl" --out "$DIR/unit_embeddings.npz" --gid "$GID"
# product embeddings — ต้องเช็ค description path ของ build_embeddings ก่อน (ห้ามเดา)
echo "[r1] done gid=$GID — publish requires separate approval"
