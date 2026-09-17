#!/usr/bin/env python3
"""
test_desc_image_cost.py — ยิง 1 รูปจาก description_info ผ่าน OpenRouter vision
เพื่อวัด token + cost จริงต่อรูป (ก่อนรัน batch ~6-7k รูป)

วิธีใช้:
  cd chatbot && python testscript/test_desc_image_cost.py

log เข้า AI Usage Hub (source=test_desc_image_extract) — ดูผลใน admin ได้เลย
"""
from __future__ import annotations
import os, sys, json, time, urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env")

MODEL = os.environ.get("OPENROUTER_TEST_MODEL", "google/gemini-3.5-flash-lite")
BASE = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
# ราคาจาก shadow_openrouter.py (USD/1M tokens)
PRICING = {"input": 0.30, "output": 2.50}
THB_PER_USD = 34.0

# รูปจริงจาก description_info ของ IMILAB EC4 (verify แล้วว่า field_list[0] มี image_url)
IMAGE_URL = "https://cf.shopee.co.th/file/th-11134208-81ztm-mne4ut1lqgoz37"
ITEM_NAME = "IMILAB EC4 (GB V.) กล้องวงจรปิดไร้สาย คมชัด 2.5K 4MP"

EXTRACT_PROMPT = """รูปนี้มาจาก description ของสินค้า Shopee: "{name}"
- ถ้ามีข้อความ/spec → แตกข้อความทั้งหมดออกมาเป็นตัวอักษร (รักษาตัวเลข/หน่วย/รหัสรุ่น)
- ถ้าเป็นตารางรหัสตัวเลือก → list mapping code:option
- ถ้าเป็นรูปสินค้าล้วน → บรรยายสั้นๆ ว่าคืออะไร เห็นอุปกรณ์อะไรบ้าง
- ถ้าเป็นแบนเนอร์เงื่อนไขร้าน → สรุปเงื่อนไข
ตอบเป็น JSON เท่านั้น: {{"kind": "spec|variant_map|product|banner", "text": "..."}}""".format(name=ITEM_NAME)


def _log_ai_usage(entry: dict) -> None:
    hub_url = os.environ.get("AI_USAGE_HUB_URL", "").strip()
    hub_token = os.environ.get("AI_USAGE_HUB_TOKEN", "").strip()
    if not hub_url or not hub_token:
        print("[AI-USAGE-HUB] ไม่มี env — ข้าม log", file=sys.stderr)
        return
    try:
        req = urllib.request.Request(
            f"{hub_url.rstrip('/')}/internal/ai-usage/logs",
            data=json.dumps(entry).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-service-token": hub_token},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
        print("[AI-USAGE-HUB] logged ✓", file=sys.stderr)
    except Exception as e:
        print(f"[AI-USAGE-HUB] log failed: {e}", file=sys.stderr)


def main() -> None:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("❌ ไม่พบ OPENROUTER_API_KEY")

    payload = {
        "model": MODEL,
        "temperature": 0.1,
        "max_tokens": 1500,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": EXTRACT_PROMPT},
                {"type": "image_url", "image_url": {"url": IMAGE_URL}},
            ],
        }],
    }
    req = urllib.request.Request(
        f"{BASE.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "HTTP-Referer": "https://chatbot.local",
            "X-Title": "ShopeeChatbot-DescImageCost",
        },
        method="POST",
    )
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=90)
        data = json.loads(resp.read().decode("utf-8"))
        status, http_status, err = "success", 200, None
    except urllib.error.HTTPError as e:
        data, status, http_status, err = {}, "error", e.code, e.read().decode("utf-8")[:300]
    dur = time.time() - t0

    answer = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    usage = data.get("usage") or {}
    p_t = usage.get("prompt_tokens", 0)
    o_t = usage.get("completion_tokens", 0)
    cost_usd = float(usage.get("cost", 0.0)) or (p_t * PRICING["input"] + o_t * PRICING["output"]) / 1e6
    cost_thb = cost_usd * THB_PER_USD

    print(f"\n=== RESULT ===")
    print(f"model: {MODEL}")
    print(f"image: {IMAGE_URL}")
    print(f"prompt_tokens: {p_t}  output_tokens: {o_t}  total: {p_t + o_t}")
    print(f"cost: ${cost_usd:.6f} = ฿{cost_thb:.4f}   duration: {dur:.1f}s")
    print(f"raw_usage: {json.dumps(usage, ensure_ascii=False)}")
    print(f"\n=== ANSWER ===\n{answer[:1500]}")
    print(f"\n=== EXTRAPOLATE ===")
    for n in (6500, 14005):
        print(f"  {n:,} รูป ≈ ฿{cost_thb * n:,.0f}")

    _log_ai_usage({
        "provider": "openrouter", "model": MODEL, "operation": "chat.completions",
        "source": "test_desc_image_extract", "user": "system:chatbot",
        "reference": f"shop:IMILAB|image:{IMAGE_URL.split('/')[-1]}",
        "prompt_tokens": p_t, "completion_tokens": o_t,
        "cost_usd": round(cost_usd, 6), "duration_ms": int(dur * 1000),
        "attempt": 1, "status": status, "http_status": http_status, "error_message": err,
    })


if __name__ == "__main__":
    main()
