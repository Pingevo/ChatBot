"""or_client — OpenRouter client สำหรับ chatbotv3.

Pattern มาจาก `chatbot/testscript/shadow_openrouter.py` แต่ปรับให้:
- รองรับหลาย key (round-robin) เหมือน legacy `_load_api_keys`/`_next_api_key`
- log ไป AI Usage Hub (fire-and-forget)
- ใช้ urllib (ไม่พึ่ง requests) เหมือน shadow_openrouter
- รองรับ multimodal (ส่ง image_url ใน content ได้ — OpenRouter รองรับ vision)

⚠️ ไม่ใช้ SDK ของ provider ใด — ใช้ OpenRouter REST API ตรงๆ
"""
from __future__ import annotations

import itertools as _itertools
import json
import os
import sys
import time
import urllib.request
import urllib.error
from typing import Any
from urllib.parse import urlparse as _urlparse
import ipaddress as _ipaddress
import socket as _socket


# ---- C1: Image URL validator (SSRF/LFI defense) -----------------------------

def _is_safe_image_url(url: str) -> bool:
    """🔒 C1+M5: Validate image URL — block file://, private IPs, metadata endpoints.
    Also checks resolved IP to prevent DNS rebinding."""
    try:
        parsed = _urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        hostname = parsed.hostname or ""
        if not hostname:
            return False
        # Resolve and check IP (M5: also catches DNS rebinding to private IPs)
        resolved = _socket.getaddrinfo(hostname, None)
        for _fam, _typ, _proto, _cn, sa in resolved:
            ip = _ipaddress.ip_address(sa[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast:
                return False
        return True
    except Exception:
        return False


# ---- Config -----------------------------------------------------------------

OPENROUTER_BASE = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()

# Default models (สามารถ override ผ่าน env)
MODEL_LLM2 = os.environ.get("CHATBOTV3_MODEL", "google/gemini-2.5-flash:online").strip()
MODEL_VISION = os.environ.get("CHATBOTV3_VISION_MODEL", "google/gemini-3.1-flash-lite").strip()

# Pricing (USD per 1M tokens) — ใช้คำนวณ cost ถ้า OpenRouter ไม่ส่ง cost กลับมา
_PRICING: dict[str, dict[str, float]] = {
    "google/gemini-2.5-flash:online": {"input": 0.30, "output": 2.50},
    "google/gemini-3.5-flash-lite": {"input": 0.30, "output": 2.50},
    "google/gemini-3.1-flash-lite": {"input": 0.25, "output": 0.50},
}
_DEFAULT_PRICING = {"input": 0.30, "output": 2.50}


# ---- API key rotation (round-robin) -----------------------------------------
# รองรับหลาย key เพื่อหลีกเลี่ยง rate limit (เหมือน legacy GEMINI_API_KEY_1..9)
# อ่าน OPENROUTER_API_KEY_1 .. _9 (หรือ OPENROUTER_API_KEY ตัวเดียว)

def _load_api_keys() -> list[str]:
    """โหลด API keys ทั้งหมดจาก env (OPENROUTER_API_KEY_1 .. _9, และ OPENROUTER_API_KEY)."""
    keys: list[str] = []
    for i in range(1, 10):
        k = os.environ.get(f"OPENROUTER_API_KEY_{i}", "").strip()
        if k:
            keys.append(k)
    if not keys:
        k = os.environ.get("OPENROUTER_API_KEY", "").strip()
        if k:
            keys.append(k)
    return keys


_API_KEYS: list[str] = _load_api_keys()
_KEY_CYCLE = _itertools.cycle(_API_KEYS) if _API_KEYS else None
_KEY_INDEX = 0

# debug log — ยืนยันว่าโหลด keys ครบ
# 🔒 M3: Log only count + hash prefix, not actual key fragments
import hashlib as _hashlib
print(f"[OR-V3] โหลด OpenRouter API keys จำนวน: {len(_API_KEYS)}", file=sys.stderr)
for i, k in enumerate(_API_KEYS):
    _hash = _hashlib.sha256(k.encode()).hexdigest()[:8]
    print(f"[OR-V3]   key[{i}] = sha256:{_hash}", file=sys.stderr)


def _next_api_key() -> str:
    """หา key ถัดไปแบบ round-robin."""
    global _KEY_INDEX
    if not _API_KEYS:
        raise RuntimeError("ไม่พบ OPENROUTER_API_KEY หรือ OPENROUTER_API_KEY_1..9 ใน env")
    key = next(_KEY_CYCLE)
    _KEY_INDEX = (_KEY_INDEX + 1) % len(_API_KEYS)
    return key


# ---- AI Usage Hub logging (fire-and-forget) ---------------------------------

def _log_ai_usage(entry: dict) -> None:
    """ส่ง log ไป AI Usage Hub (fire-and-forget ไม่ throw)."""
    hub_url = os.environ.get("AI_USAGE_HUB_URL", "").strip()
    hub_token = os.environ.get("AI_USAGE_HUB_TOKEN", "").strip()
    if not hub_url or not hub_token:
        return
    try:
        body = json.dumps(entry).encode("utf-8")
        req = urllib.request.Request(
            f"{hub_url.rstrip('/')}/internal/ai-usage/logs",
            data=body,
            headers={"Content-Type": "application/json", "x-service-token": hub_token},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"[OR-V3] AI Usage Hub log failed: {e}", file=sys.stderr)


# ---- Main call function ------------------------------------------------------

def call_or(
    model: str,
    system: str,
    user: str,
    history: list[dict] | None = None,
    max_tokens: int = 4096,
    temperature: float = 0.3,
    source: str = "chatbotv3",
    step: str = "unknown",
    reference: str = "",
    images: list[str] | None = None,
) -> dict:
    """call OpenRouter + log ไป AI Usage Hub.

    Args:
        model: OpenRouter model id (เช่น "google/gemini-2.5-flash:online")
        system: system instruction
        user: user message (text)
        history: ประวัติแชท [{"role":"user","text":"..."},{"role":"model","text":"..."}]
                 (role "model" จะถูกแปลงเป็น "assistant" อัตโนมัติ)
        max_tokens: max output tokens
        temperature: sampling temperature
        source: source label สำหรับ log (เช่น "chatbotv3")
        step: step label สำหรับ log (เช่น "llm2", "vision")
        reference: reference id สำหรับ log (เช่น conversation_id)
        images: list ของ image URLs (สำหรับ multimodal — ส่งเป็น image_url content)

    Returns:
        dict: {answer, prompt_tokens, output_tokens, cost_usd, duration_s, raw_usage, model, error}
        - answer: คำตอบ text (หรือ error message ถ้า fail)
        - prompt_tokens, output_tokens: token usage
        - cost_usd: ต้นทุนประมาณ (USD)
        - duration_s: เวลาที่ใช้ (วินาที)
        - raw_usage: raw usage dict จาก OpenRouter
        - model: model ที่ใช้
        - error: error message ถ้า fail (None ถ้าสำเร็จ)
    """
    # build messages
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    if history:
        for h in history:
            role = h.get("role", "user")
            if role == "model":
                role = "assistant"
            if role not in ("user", "assistant"):
                role = "user"
            messages.append({"role": role, "content": h.get("text", "")})

    # user message — รองรับ multimodal (ส่ง image_url ใน content)
    # 🔒 H1: Limit user message length to reduce prompt injection risk
    _safe_user = str(user)[:2000] if user else ""
    if images:
        content: list[dict[str, Any]] = [{"type": "text", "text": _safe_user}]
        for img_url in images[:3]:  # จำกัด 3 รูป/turn เหมือน legacy
            if img_url and img_url.strip():
                # 🔒 C1: Validate URL — block file://, private IPs, metadata endpoints
                if not _is_safe_image_url(img_url):
                    print(f"[OR-V3] blocked unsafe image URL: {img_url[:60]}", file=sys.stderr)
                    continue
                content.append({
                    "type": "image_url",
                    "image_url": {"url": img_url},
                })
        messages.append({"role": "user", "content": content})
    else:
        messages.append({"role": "user", "content": _safe_user})

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    body = json.dumps(payload).encode("utf-8")

    _req_start = time.time()
    _status = "success"
    _http_status = 200
    _error_msg: str | None = None
    _resp_data: dict = {}

    try:
        api_key = _next_api_key()
        req = urllib.request.Request(
            f"{OPENROUTER_BASE.rstrip('/')}/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": "https://chatbot.local",
                "X-Title": "ChatBotProductMS-v3",
            },
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=90)
        _resp_data = json.loads(resp.read().decode("utf-8"))
        answer = _resp_data.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = _resp_data.get("usage", {})
        p_t = usage.get("prompt_tokens", 0)
        o_t = usage.get("completion_tokens", 0)
        cost_or = float(usage.get("cost", 0.0))
        pricing = _PRICING.get(model, _DEFAULT_PRICING)
        cost_calc = (p_t * pricing["input"] + o_t * pricing["output"]) / 1_000_000
        cost_usd = cost_or if cost_or > 0 else cost_calc
        result = {
            "answer": answer,
            "prompt_tokens": p_t,
            "output_tokens": o_t,
            "cost_usd": cost_usd,
            "duration_s": time.time() - _req_start,
            "raw_usage": usage,
            "model": model,
            "error": None,
        }
    except urllib.error.HTTPError as e:
        _status = "error"
        _http_status = e.code
        try:
            _error_msg = e.read().decode("utf-8")[:300]
        except Exception:
            _error_msg = str(e)
        result = {
            "answer": "",
            "prompt_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0,
            "duration_s": time.time() - _req_start,
            "raw_usage": {},
            "model": model,
            "error": f"HTTP {e.code}: {_error_msg}",
        }
    except Exception as e:
        _status = "error"
        _http_status = 0
        _error_msg = str(e)
        result = {
            "answer": "",
            "prompt_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0,
            "duration_s": time.time() - _req_start,
            "raw_usage": {},
            "model": model,
            "error": str(e),
        }

    # log ไป AI Usage Hub
    _duration_ms = int(result["duration_s"] * 1000)
    _log_ai_usage({
        "provider": "openrouter",
        "model": model,
        "operation": "chat.completions",
        "source": source,
        "user": "system:chatbotv3",
        "reference": reference or f"step:{step}",
        "prompt_tokens": result["prompt_tokens"],
        "completion_tokens": result["output_tokens"],
        "cost_usd": round(result["cost_usd"], 6),
        "duration_ms": _duration_ms,
        "attempt": 1,
        "status": _status,
        "http_status": _http_status,
        "error_message": _error_msg,
        "raw_usage": _resp_data.get("usage", {}) if _status == "success" else None,
        "metadata": {"step": step, "chatbotv3": True},
    })

    return result
