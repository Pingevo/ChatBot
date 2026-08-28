#!/usr/bin/env python3
"""run_daily_tests — รัน testQA2 แบบหมุนเวียน key 1-7 (ISOLATED).

กฎเด็ดขาด:
- ห้ามแตะ .env เด็ดขาด — key หลักใน .env ใช้สำหรับหน้าเว็บ (port 8010)
- เทสรัน server แยกบน port 8011 โดยส่ง key+model เป็น env var ตรงๆ ให้ uvicorn
- ใช้ key 1-7 เท่านั้น (GEMINI_API_KEY_1 ถึง GEMINI_API_KEY_7)
- แต่ละ key: 500 req gemini-3.5-flash-lite + 500 req gemini-3.1-flash-lite = 1000 req/key
- ลำดับ: key_1(3.5) → key_1(3.1) → key_2(3.5) → key_2(3.1) → ... → key_7(3.1)
- รวม 7 keys × 1000 = 7,000 req/day

วิธีการ:
1. อ่าน key 1-7 จาก .env (อ่านอย่างเดียว ไม่เขียน)
2. แต่ละรอบ: start uvicorn บน port 8011 ด้วย env var (key+model ของรอบนั้น)
3. รัน testQA2 --resume --max-reqs 500 (ยิง port 8011)
4. พอรอบจบ → kill server รอบนั้น → รอบถัดไป
5. จบทุกรอบ → kill server เทส

Usage:
    python test/run_daily_tests.py
    python test/run_daily_tests.py --keys 3
    python test/run_daily_tests.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
TEST_DIR = ROOT / "test"
RESULT_DIR = ROOT / "testresult"
TESTQA2 = TEST_DIR / "testQA2.py"
RESULTS_FILE = RESULT_DIR / "testQA2_results.json"
PLAN_FILE = RESULT_DIR / "testQA2_plan.json"

# server config — เทสรันบน port 8011 (แยกจากหน้าเว็บ port 8010)
TEST_HOST = "127.0.0.1"
TEST_PORT = 8011
HEALTH_URL = f"http://{TEST_HOST}:{TEST_PORT}/health"
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
VENV_UVICORN = ROOT / ".venv" / "bin" / "uvicorn"

# model config
PRIMARY_MODEL = "gemini-3.5-flash-lite"
FALLBACK_MODEL = "gemini-3.1-flash-lite"
REQS_PER_KEY_PER_MODEL = 500


# ============================================================
# 1. อ่าน .env (อ่านอย่างเดียว ไม่เขียน)
# ============================================================

def load_env_dict(path: Path = ENV_FILE) -> dict[str, str]:
    """อ่าน .env เป็น dict (key=value)."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            env[key.strip()] = val.strip()
    return env


def get_rotation_keys(env: dict[str, str]) -> list[str]:
    """ดึง key 1-7 จาก .env."""
    keys: list[str] = []
    for i in range(1, 8):
        k = f"GEMINI_API_KEY_{i}"
        val = env.get(k, "").strip()
        if val:
            keys.append(val)
    return keys


# ============================================================
# 2. จัดการ test server (port 8011) — ส่ง key เป็น env var
# ============================================================

def find_test_server_pid() -> int | None:
    """หา PID ของ uvicorn บน port 8011."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", f"uvicorn chatbot.*--port {TEST_PORT}"],
            capture_output=True, text=True, timeout=5,
        )
        pids = [p for p in result.stdout.strip().split("\n") if p.strip()]
        if pids:
            return int(pids[0])
    except Exception:
        pass
    return None


def kill_test_server() -> bool:
    """Kill test server (port 8011)."""
    pid = find_test_server_pid()
    if not pid:
        return True
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(2)
        if find_test_server_pid():
            os.kill(pid, signal.SIGKILL)
            time.sleep(1)
        return True
    except ProcessLookupError:
        return True
    except Exception as e:
        print(f"  ⚠️  kill test server ไม่สำเร็จ: {e}")
        return False


def start_test_server(api_key: str, model: str) -> subprocess.Popen | None:
    """Start uvicorn บน port 8011 ด้วย key+model ที่ส่งเป็น env var (ไม่แตะ .env)."""
    cmd = [
        str(VENV_UVICORN),
        "chatbot.shopeechat.app:app",
        "--host", TEST_HOST,
        "--port", str(TEST_PORT),
        "--log-level", "warning",
    ]
    # ส่ง key+model เป็น env var ตรงๆ ให้ process (ไม่แตะ .env)
    env = os.environ.copy()
    env["GEMINI_API_KEY"] = api_key
    env["GEMINI_MODEL"] = model
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            start_new_session=True,
        )
        return proc
    except Exception as e:
        print(f"  ❌ start test server ไม่สำเร็จ: {e}")
        return None


def wait_test_server_ready(timeout: int = 60) -> bool:
    """รอจนกว่า test server จะพร้อม (poll /health)."""
    import urllib.request
    import urllib.error
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            req = urllib.request.urlopen(HEALTH_URL, timeout=3)
            if req.status == 200:
                return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(1)
    return False


def restart_test_server(api_key: str, model: str) -> bool:
    """Restart test server ด้วย key+model ใหม่."""
    print(f"  🔄 restarting test server (port {TEST_PORT})...", end=" ", flush=True)
    kill_test_server()
    time.sleep(1)
    start_test_server(api_key, model)
    if wait_test_server_ready(timeout=60):
        print("✅ ready")
        return True
    else:
        print("❌ timeout")
        return False


# ============================================================
# 3. รัน testQA2
# ============================================================

def run_testqa2(max_reqs: int, batch: str = "all") -> int:
    """รัน testQA2 --run --resume --max-reqs N (ยิง port 8011)."""
    cmd = [
        str(VENV_PYTHON),
        str(TESTQA2),
        "--run",
        "--resume",
        "--batch", batch,
        "--max-reqs", str(max_reqs),
    ]
    # ส่ง TEST_CHAT_URL ให้ testQA2 ยิง port 8011
    env = os.environ.copy()
    env["TEST_CHAT_URL"] = f"http://{TEST_HOST}:{TEST_PORT}/chat"
    print(f"  ▶️  รัน: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    try:
        for line in proc.stdout:
            print(line, end="", flush=True)
    except Exception:
        pass
    proc.wait()
    return proc.returncode


def count_done() -> int:
    if not RESULTS_FILE.exists():
        return 0
    try:
        with open(RESULTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return sum(1 for d in data if d.get("source") != "error")
    except Exception:
        return 0


def count_total() -> int:
    if not PLAN_FILE.exists():
        return 0
    try:
        with open(PLAN_FILE, "r", encoding="utf-8") as f:
            plan = json.load(f)
            return plan["stats"]["total"]
    except Exception:
        return 0


def remove_error_cases() -> int:
    if not RESULTS_FILE.exists():
        return 0
    try:
        with open(RESULTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        before = len(data)
        clean = [d for d in data if d.get("source") != "error"]
        removed = before - len(clean)
        if removed > 0:
            with open(RESULTS_FILE, "w", encoding="utf-8") as f:
                json.dump(clean, f, ensure_ascii=False, indent=2)
            print(f"  🧹 ลบ {removed} error cases (จะรันใหม่)")
        return removed
    except Exception:
        return 0


# ============================================================
# 4. Main loop
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="run_daily_tests — รัน testQA2 แบบหมุนเวียน key 1-7 (ISOLATED)")
    parser.add_argument("--batch", default="all", help="batch ที่จะรัน (default: all)")
    parser.add_argument("--keys", type=int, default=7, help="จำนวน key (default: 7, max 7)")
    parser.add_argument("--max-reqs", type=int, default=REQS_PER_KEY_PER_MODEL,
                        help=f"max reqs/key/model (default: {REQS_PER_KEY_PER_MODEL})")
    parser.add_argument("--dry-run", action="store_true", help="แสดงแผนไม่รันจริง")
    parser.add_argument("--primary-model", default=PRIMARY_MODEL)
    parser.add_argument("--fallback-model", default=FALLBACK_MODEL)
    args = parser.parse_args()

    args.keys = min(args.keys, 7)

    # อ่าน .env (อ่านอย่างเดียว)
    env = load_env_dict()
    rotation_keys = get_rotation_keys(env)

    if not rotation_keys:
        print("❌ ไม่พบ GEMINI_API_KEY_1 ถึง _7 ใน .env")
        return

    use_keys = rotation_keys[:args.keys]
    n_keys = len(use_keys)

    # สถานะ
    total = count_total()
    done = count_done()
    remaining = total - done

    # แผน: key_1(3.5) → key_1(3.1) → key_2(3.5) → ...
    rounds = []
    for i in range(n_keys):
        rounds.append({"key": use_keys[i], "key_num": i + 1, "model": args.primary_model})
        rounds.append({"key": use_keys[i], "key_num": i + 1, "model": args.fallback_model})
    total_capacity = len(rounds) * args.max_reqs

    print(f"\n{'='*60}")
    print(f"📊 สถานะ testQA2 (ISOLATED — port {TEST_PORT})")
    print(f"{'='*60}")
    print(f"  ทั้งหมด: {total} เคส")
    print(f"  รันแล้ว: {done} เคส")
    print(f"  เหลือ: {remaining} เคส")
    print(f"  batch: {args.batch}")
    print(f"  key ที่จะใช้: {n_keys} ตัว (key 1-{n_keys})")
    print(f"  max reqs/key/model: {args.max_reqs}")
    print(f"  test server: port {TEST_PORT} (หน้าเว็บใช้ port 8010 แยก)")
    print(f"  ลำดับ: key_1({args.primary_model}) → key_1({args.fallback_model}) → key_2(...) → ...")
    print(f"  รวมความจุ/วัน: {total_capacity} เคส")
    print(f"  รอบนี้จะรัน: {min(total_capacity, remaining)} เคส")
    print(f"{'='*60}\n")

    if remaining <= 0:
        print("✅ test ครบทั้งหมดแล้ว!")
        return

    if args.dry_run:
        print("🔍 Dry-run — แผนการรัน:")
        for idx, r in enumerate(rounds, 1):
            masked = r["key"][:8] + "..." + r["key"][-4:] if len(r["key"]) > 12 else "***"
            print(f"  รอบ {idx:2d}: key_{r['key_num']} ({masked}) | model={r['model']} → รัน {args.max_reqs} เคส")
        print(f"\n  รวม: {total_capacity} เคส")
        print(f"  ⚠️  ไม่แตะ .env — key ส่งเป็น env var ตรงๆ ให้ uvicorn (port {TEST_PORT})")
        return

    # setup signal handler — ฆ่า test server ตอนจบ/crash
    def cleanup(signum=0, frame=None):
        kill_test_server()
        if signum:
            sys.exit(1)
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)
    atexit_registered = False
    import atexit
    atexit.register(cleanup)
    atexit_registered = True

    print(f"🔒 ISOLATED: ไม่แตะ .env — key ส่งเป็น env var ตรงๆ ให้ uvicorn (port {TEST_PORT})")
    print(f"   หน้าเว็บ (port 8010) ใช้ key หลักจาก .env ไม่กระทบ\n")

    # วนรอบ
    total_round_done = 0
    models_used: set[str] = set()

    for idx, r in enumerate(rounds, 1):
        if remaining <= 0:
            print("\n✅ test ครบทั้งหมดแล้ว!")
            break

        masked = r["key"][:8] + "..." + r["key"][-4:] if len(r["key"]) > 12 else "***"
        print(f"\n{'─'*60}")
        print(f"🔑 รอบ {idx}/{len(rounds)}: key_{r['key_num']} ({masked}) | model={r['model']}")
        print(f"{'─'*60}")

        # 1. restart test server ด้วย key+model ของรอบนี้ (env var ตรงๆ)
        if not restart_test_server(r["key"], r["model"]):
            print(f"  ❌ restart test server ไม่สำเร็จ ข้ามรอบนี้")
            continue
        models_used.add(r["model"])

        # 2. ลบ error cases เก่า
        remove_error_cases()

        # 3. รัน testQA2
        this_round_max = min(args.max_reqs, remaining)
        print(f"  ▶️  รัน testQA2 {this_round_max} เคส (port {TEST_PORT})...")
        exit_code = run_testqa2(max_reqs=this_round_max, batch=args.batch)

        # 4. อัปเดตสถานะ
        new_done = count_done()
        round_done = new_done - done
        done = new_done
        remaining = total - done
        total_round_done += round_done

        print(f"\n  📈 รอบนี้รัน: {round_done} เคส | รวมสะสม: {done}/{total} | เหลือ: {remaining}")

        if exit_code != 0:
            print(f"  ⚠️  testQA2 exit code: {exit_code}")

        if round_done < this_round_max and remaining <= 0:
            print(f"  test ครบแล้ว หยุดหมุนเวียน")
            break

    # ฆ่า test server
    kill_test_server()

    # สรุป
    print(f"\n{'='*60}")
    print(f"🏁 สรุปวันนี้")
    print(f"{'='*60}")
    print(f"  รันทั้งหมด: {total_round_done} เคส (ในรอบนี้)")
    print(f"  รวมสะสม: {done}/{total}")
    print(f"  เหลือ: {remaining} เคส")
    print(f"  model ที่ใช้: {', '.join(sorted(models_used))}")
    if remaining > 0:
        days_left = (remaining + total_capacity - 1) // total_capacity
        print(f"  ประมาณ {days_left} วันถึงจะครบ (ที่ {total_capacity}/วัน)")
        print(f"\n📌 วันถัดไป: python test/run_daily_tests.py")
    else:
        print(f"\n✅ test ครบทั้งหมด {total} เคสแล้ว!")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
