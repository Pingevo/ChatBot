#!/bin/bash
# refresh_data.sh — rebuild ข้อมูลทั้งหมดที่ bot ใช้ (export → units → embeddings → image OCR)
#
# ไม่ต้อง restart bot: npz loaders เช็ค mtime เอง + Mongo collections อ่านสดอยู่แล้ว
# ปลอดภัยที่จะรันซ้ำ: image OCR resume จาก jsonl (ทำเฉพาะรูปใหม่), imports เป็น upsert
#
# cron แนะนำ: 0 3 * * *  /path/to/repo/chatbot/shopeechat/scripts/refresh_data.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
LOG_DIR="$ROOT/exports"
LOG="$LOG_DIR/refresh_$(date +%Y%m%d).log"

# lock — mkdir atomic บน macOS/Linux (ไม่ต้องพึ่ง flock ที่ macOS ไม่มี)
LOCK="$LOG_DIR/.refresh.lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
    echo "[$(date '+%F %T')] skip — refresh กำลังรันอยู่แล้ว" >> "$LOG"
    exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

step() { echo "[$(date '+%F %T')] === $*" >> "$LOG"; }
run()  { step "$1"; shift; "$@" >> "$LOG" 2>&1; }

step "refresh start"

# export เป็นต้นทางของทุกอย่าง — fail → หยุดทั้งหมด อย่า build บนข้อมูลผิด
if ! run "export ShpProducts" "$PY" chatbot/shopeechat/scripts/export_mongo.py \
        --collection ShpProducts --format json; then
    step "ABORT — export failed"
    exit 1
fi

run "product embeddings"  "$PY" chatbot/shopeechat/scripts/build_embeddings.py
run "build units"         "$PY" chatbot/shopeechat/scripts/build_sellable_units.py
run "import units"        "$PY" chatbot/shopeechat/scripts/import_sellable_units.py
run "unit embeddings"     "$PY" chatbot/shopeechat/scripts/build_embeddings.py --units
run "qa embeddings"       "$PY" chatbot/shopeechat/scripts/build_embeddings.py --qa
run "image OCR sellable (incremental)"    "$PY" chatbot/shopeechat/scripts/build_image_texts.py --max-calls 4000
run "image OCR nonsellable (incremental)" "$PY" chatbot/shopeechat/scripts/build_image_texts_nonsellable.py --max-calls 4000
run "import image_texts"  "$PY" chatbot/shopeechat/scripts/import_image_texts.py

step "refresh done — bot เห็นข้อมูลใหม่อัตโนมัติ (mtime reload + live Mongo)"
