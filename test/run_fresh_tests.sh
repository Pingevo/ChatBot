#!/usr/bin/env bash
# run_fresh_tests.sh — เริ่มเทสใหม่จาก 0 ด้วย key_2 ถึง key_7 (ข้าม key_1)
# รัน 500 เคสต่อ key, restart server ทุกครั้งที่เปลี่ยน key
# หยุดเมื่อครบ 3000 เคส หรือ key หมด
set -e
cd /Users/itdev4/Documents/GitHub/ChatBotProductMS
. .venv/bin/activate

ENV_FILE=".env"
LOG_DIR="testlog"
PORT=8010
MAX_REQS=500

# อ่าน key 2-7
get_key() {
  grep -E "^GEMINI_API_KEY_$1=" "$ENV_FILE" | head -1 | cut -d'=' -f2-
}

# อ่าน model
get_model() {
  grep -E "^GEMINI_MODEL=" "$ENV_FILE" | head -1 | cut -d'=' -f2-
}

set_env_key() {
  local key="$1"
  # ใช้ python เพื่อเขียน .env แทนที่ GEMINI_API_KEY
  python3 -c "
import sys
from pathlib import Path
env_path = Path('$ENV_FILE')
lines = env_path.read_text(encoding='utf-8').splitlines(keepends=False)
new_lines = []
for line in lines:
    if line.startswith('GEMINI_API_KEY='):
        new_lines.append('GEMINI_API_KEY=' + '$key')
    else:
        new_lines.append(line)
env_path.write_text('\n'.join(new_lines) + '\n', encoding='utf-8')
"
}

restart_server() {
  echo "🔄 restart server..."
  # kill uvicorn เดิม
  pkill -f "uvicorn chatbot.shopeechat.app:app --host 127.0.0.1 --port $PORT" 2>/dev/null || true
  sleep 2
  # start ใหม่
  nohup .venv/bin/uvicorn chatbot.shopeechat.app:app --host 127.0.0.1 --port $PORT --log-level info > "$LOG_DIR/server.log" 2>&1 &
  echo "  รอ server ready..."
  for i in $(seq 1 30); do
    if curl -s -m 2 "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
      echo "  ✅ server ready (try $i)"
      return 0
    fi
    sleep 1
  done
  echo "  ❌ server ไม่ ready ใน 30 วิ"
  return 1
}

echo "============================================================"
echo "🚀 เริ่มเทสใหม่จาก 0 — ใช้ key_2 ถึง key_7"
echo "   6 keys × 500 เคส = 3000 เคส"
echo "============================================================"
echo ""

TOTAL_DONE=0

for KEY_NUM in 2 3 4 5 6 7; do
  KEY=$(get_key $KEY_NUM)
  if [ -z "$KEY" ]; then
    echo "⚠️  key_$KEY_NUM ว่าง ข้าม"
    continue
  fi

  echo "────────────────────────────────────────────────────────────"
  echo "🔑 รอบ key_$KEY_NUM (key: ${KEY:0:8}...${KEY: -4})"
  echo "────────────────────────────────────────────────────────────"

  # เขียน key ลง .env
  set_env_key "$KEY"
  echo "   เขียน key_$KEY_NUM ลง GEMINI_API_KEY แล้ว"

  # restart server
  restart_server || { echo "❌ restart server ล้มเหลว หยุด"; exit 1; }

  # รัน testQA2 — รอบแรกไม่ resume, รอบต่อๆ ไป resume
  if [ $KEY_NUM -eq 2 ]; then
    echo "   ▶️  รันใหม่จาก 0 (no resume)"
    RUN_ARGS="--run --batch all --max-reqs $MAX_REQS"
  else
    echo "   ▶️  resume ต่อจากเดิม"
    RUN_ARGS="--run --resume --batch all --max-reqs $MAX_REQS"
  fi

  echo "   args: $RUN_ARGS"
  echo ""

  python test/testQA2.py $RUN_ARGS 2>&1 | tee "$LOG_DIR/testQA2_key${KEY_NUM}.log"

  # นับเคสที่ทำได้
  DONE=$(python3 -c "
import json
try:
    with open('testresult/testQA2_results.json') as f:
        print(len(json.load(f)))
except:
    print(0)
")
  echo ""
  echo "   ✅ key_$KEY_NUM เสร็จ — รวม $DONE เคส"
  TOTAL_DONE=$DONE
  echo ""
done

echo "============================================================"
echo "🏁 เสร็จทั้งหมด — รันได้ $TOTAL_DONE เคส"
echo "============================================================"
