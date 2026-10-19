#!/bin/bash
# refresh_data.sh — atomic daily evidence refresh (Phase 4B)
#
# publication sequence (single generation, pointer flip เดียว):
#   flock → mint gid → export → bounded incremental OCR → materialize
#   image_texts_g<gid> → OCR-aware units → verified product/unit npz →
#   import sellable_units_g<gid> → validate + manifest → CAS pointer →
#   non-critical canonical copies/QA → cleanup (grace 24h)
#
# - lock = native flock (release auto ตอน exit/kill — ไม่มี stale lock)
# - ไม่ชน lock → exit ก่อน Mongo/provider/artifact work ทั้งหมด
# - fail ก่อน CAS → generation เก่ายัง active (ไม่มี partial publish)
# - runtime เห็น generation ใหม่ผ่าน pointer เท่านั้น (snapshot resolve)
#
# cron (operator gate — เปิดหลัง first-gen + timing evidence เท่านั้น):
#   0 9 * * *  /path/to/repo/chatbot/shopeechat/scripts/refresh_data.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
PY="${REFRESH_PY:-$ROOT/.venv/bin/python}"
[ -x "$PY" ] || PY="$(command -v python3)"
LOG_DIR="$ROOT/exports"
LOG="$LOG_DIR/refresh_$(date +%Y%m%d).log"

# native flock — ครอบ run ทั้งหมด; kill/restart ไม่ทิ้ง lock ค้าง (fd ปิดเอง)
LOCKFILE="$LOG_DIR/.refresh.lock"
mkdir -p "$LOG_DIR"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    echo "[$(date '+%F %T')] skip — refresh กำลังรันอยู่แล้ว" >> "$LOG"
    exit 0
fi

step() { echo "[$(date '+%F %T')] === $*" >> "$LOG"; }
run()  { step "$1"; shift; "$@" >> "$LOG" 2>&1; }
warn() { step "WARN: $*"; }

MAX_RUNTIME_MIN="${REFRESH_MAX_RUNTIME_MIN:-90}"
export REFRESH_DEADLINE_EPOCH=$(( $(date +%s) + MAX_RUNTIME_MIN * 60 ))

step "refresh start"
GID="$("$PY" -c 'from chatbot.shopeechat.generation_pointer import mint_generation_id as m; print(m())')" || {
    step "ABORT — mint generation_id failed"; exit 1; }
GEN_DIR="$LOG_DIR/gen/$GID"
mkdir -p "$GEN_DIR"
step "generation: $GID (deadline +${MAX_RUNTIME_MIN}m)"

# export เป็นต้นทางของทุกอย่าง — fail → หยุด อย่า build บนข้อมูลผิด
if ! run "export ShpProducts" "$PY" chatbot/shopeechat/scripts/export_mongo.py \
        --collection ShpProducts --format json --out "$GEN_DIR"; then
    step "ABORT — export failed"; exit 1
fi
GEN_EXPORT="$GEN_DIR/ShpProducts.export.json"

# bounded incremental OCR — quota/เวลาหมด → deferred (non-blocking, gen ยัง publish)
run "OCR sellable"    "$PY" chatbot/shopeechat/scripts/build_image_texts.py \
    --export "$GEN_EXPORT" --gen-dir "$GEN_DIR" --gid "$GID" --scope sellable \
    || warn "OCR sellable incomplete — ต่อด้วย evidence ที่มี"
run "OCR nonsellable" "$PY" chatbot/shopeechat/scripts/build_image_texts_nonsellable.py \
    --export "$GEN_EXPORT" --gen-dir "$GEN_DIR" --gid "$GID" \
    || warn "OCR nonsellable incomplete — ต่อด้วย evidence ที่มี"
run "materialize image_texts_$GID" "$PY" \
    chatbot/shopeechat/scripts/import_image_texts.py \
    --gen-dir "$GEN_DIR" --gid "$GID" || {
    step "ABORT — materialize published OCR failed"; exit 1; }

# OCR-aware units + verified npz — fail → abort (ยังไม่ได้แตะ pointer)
if ! run "build units" "$PY" chatbot/shopeechat/scripts/build_sellable_units.py \
        --export "$GEN_EXPORT" --image-texts "$GEN_DIR/image_texts.jsonl" \
        --out "$GEN_DIR/sellable_units.jsonl"; then
    step "ABORT — build units failed"; exit 1
fi
if ! run "import units_$GID" "$PY" chatbot/shopeechat/scripts/import_sellable_units.py \
        --gen-dir "$GEN_DIR" --gid "$GID"; then
    step "ABORT — import units failed"; exit 1
fi
if ! run "product npz" "$PY" chatbot/shopeechat/scripts/build_embeddings.py \
        --export "$GEN_EXPORT" --out "$GEN_DIR/product_embeddings.npz" \
        --gid "$GID"; then
    step "ABORT — product embeddings failed"; exit 1
fi
if ! run "unit npz" "$PY" chatbot/shopeechat/scripts/build_embeddings.py --units \
        --units-path "$GEN_DIR/sellable_units.jsonl" \
        --out "$GEN_DIR/unit_embeddings.npz" --gid "$GID"; then
    step "ABORT — unit embeddings failed"; exit 1
fi

# validate + manifest + one fenced pointer CAS (rollback: publish_generation.py --rollback)
if ! run "publish $GID" "$PY" chatbot/shopeechat/scripts/publish_generation.py \
        --gen-dir "$GEN_DIR" --gid "$GID" --expected auto; then
    step "ABORT — publish failed (previous generation stays active)"
    exit 1
fi

# ---- non-critical post-activation — fail ไม่ย้อน generation ที่ publish แล้ว
run "qa embeddings (non-contract)" "$PY" \
    chatbot/shopeechat/scripts/build_embeddings.py --qa \
    || warn "qa embeddings failed — non-critical"
for pair in "product_embeddings.npz" "unit_embeddings.npz" "sellable_units.jsonl"; do
    [ -f "$GEN_DIR/$pair" ] || continue
    cp "$GEN_DIR/$pair" "$LOG_DIR/.$pair.tmp" 2>/dev/null \
        && mv -f "$LOG_DIR/.$pair.tmp" "$LOG_DIR/$pair" 2>/dev/null \
        || warn "canonical copy $pair failed — non-critical"
done

step "refresh done — pointer → $GID (runtime เห็นผ่าน snapshot อัตโนมัติ)"
