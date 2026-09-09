#!/usr/bin/env python3
"""
shadow_openrouter.py — Shadow bot ที่ใช้ OpenRouter แทน Gemini ตรงๆ

ดึงข้อความจริงจาก conversation (ฝั่ง in เท่านั้น)
จำลอง full flow: vision → intent → buffer flush → RAG → LLM2 → web search → RAG → LLM2
ส่ง log ไป AI Usage Hub
เซฟผลลัพธ์เป็น JSON ที่ test/results/openrouter_shadow_results.json

วิธีใช้:
  cd chatbot
  ../.venv/bin/python3 shadow_openrouter.py [conversation_id]

  default conversation_id = shp_1291688535969234763
"""
from __future__ import annotations
import os
import sys
import json
import time
import urllib.request
from pathlib import Path
from datetime import datetime
from datetime import datetime

# ─── path + .env ─────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat import product_store, llm, persona, intent_classifier, knowledge_base
from pymongo import MongoClient

# ─── Config ───────────────────────────────────────────────────
OPENROUTER_BASE = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
MODEL_VISION = "google/gemini-3.1-flash-lite"
MODEL_INTENT = "google/gemini-3.1-flash-lite"
MODEL_LLM2 = "google/gemini-3.5-flash-lite"
MODEL_SEARCH = "google/gemini-2.5-flash:online"

PRICING = {
    "google/gemini-3.1-flash-lite": {"input": 0.25, "output": 0.50},
    "google/gemini-3.5-flash-lite": {"input": 0.30, "output": 2.50},
    "google/gemini-2.5-flash:online": {"input": 0.30, "output": 2.50},
}

OUTPUT_DIR = _REPO_ROOT / "docs" / "test" / "results"
RESULTS_FILE = OUTPUT_DIR / "openrouter_shadow_results.json"
DETAILS_FILE = OUTPUT_DIR / "openrouter_shadow_details.json"


def _get_or_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        print("❌ ไม่พบ OPENROUTER_API_KEY", file=sys.stderr)
        sys.exit(1)
    return key


def _log_ai_usage(entry: dict) -> None:
    """ส่ง log ไป AI Usage Hub (fire-and-forget ไม่ throw)"""
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
        print(f"[AI-USAGE-HUB] log failed: {e}", file=sys.stderr)


def call_or(model: str, system: str, user: str, history: list[dict] | None = None,
            max_tokens: int = 500, temperature: float = 0.3,
            source: str = "shadow_openrouter", step: str = "unknown",
            reference: str = "") -> dict:
    """call OpenRouter + log ไป AI Usage Hub — คืน {answer, prompt_tokens, output_tokens, cost_usd, duration_s, raw_usage}"""
    messages = [{"role": "system", "content": system}]
    if history:
        for h in history:
            role = h.get("role", "user")
            if role == "model":
                role = "assistant"
            messages.append({"role": role, "content": h.get("text", "")})
    messages.append({"role": "user", "content": user})

    payload = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{OPENROUTER_BASE.rstrip('/')}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_get_or_key()}",
            "HTTP-Referer": "https://chatbot.local",
            "X-Title": "ShopeeChatbot-ShadowOpenRouter",
        },
        method="POST",
    )
    _req_start = time.time()
    _status = "success"
    _http_status = 200
    _error_msg = None
    _resp_data: dict = {}
    try:
        resp = urllib.request.urlopen(req, timeout=90)
        _resp_data = json.loads(resp.read().decode("utf-8"))
        answer = _resp_data.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = _resp_data.get("usage", {})
        p_t = usage.get("prompt_tokens", 0)
        o_t = usage.get("completion_tokens", 0)
        cost_or = float(usage.get("cost", 0.0))
        pricing = PRICING.get(model, {"input": 0.30, "output": 2.50})
        cost_calc = (p_t * pricing["input"] + o_t * pricing["output"]) / 1_000_000
        cost_usd = cost_or if cost_or > 0 else cost_calc
        result = {"answer": answer, "prompt_tokens": p_t, "output_tokens": o_t,
                  "cost_usd": cost_usd, "duration_s": time.time() - _req_start,
                  "raw_usage": usage}
    except urllib.error.HTTPError as e:
        _status = "error"
        _http_status = e.code
        _error_msg = e.read().decode("utf-8")[:300]
        result = {"answer": f"ERROR: {e.code} {_error_msg}", "prompt_tokens": 0, "output_tokens": 0,
                  "cost_usd": 0, "duration_s": time.time() - _req_start, "raw_usage": {}}
    except Exception as e:
        _status = "error"
        _http_status = 0
        _error_msg = str(e)
        result = {"answer": f"ERROR: {e}", "prompt_tokens": 0, "output_tokens": 0,
                  "cost_usd": 0, "duration_s": time.time() - _req_start, "raw_usage": {}}

    _duration_ms = int(result["duration_s"] * 1000)
    _log_ai_usage({
        "provider": "openrouter",
        "model": model,
        "operation": "chat.completions",
        "source": source,
        "user": "system:shadow_bot",
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
        "metadata": {"step": step, "shadow_bot": True},
    })
    return result


def fetch_user_messages(conversation_id: str) -> tuple[list[dict], str, str]:
    """ดึงข้อความฝั่ง in (ลูกค้า) จาก admin MongoDB
    คืน (messages, shop_name, platform)
    """
    admin_db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
    admin_client = knowledge_base._build_admin_client()
    db = admin_client[admin_db_name]

    # หา conversations collection — ลอง env var ก่อน, ถ้าไม่มีลอง _shp suffix, ถ้าไม่มีลอง default
    conv_coll_name = os.environ.get("ADMIN_MONGO_COLLECTION_CONVERSATIONS", "").strip()
    if not conv_coll_name or conv_coll_name not in db.list_collection_names():
        # ลอง conversations_shp (Shopee-specific)
        if "conversations_shp" in db.list_collection_names():
            conv_coll_name = "conversations_shp"
        else:
            conv_coll_name = "conversations"
    print(f"  Using conversations collection: {conv_coll_name}")
    conv_coll = db[conv_coll_name]

    conv = conv_coll.find_one({"conversation_id": conversation_id})
    if not conv:
        print(f"❌ ไม่พบ conversation {conversation_id} ใน {conv_coll_name}", file=sys.stderr)
        sys.exit(1)

    shop_name = conv.get("shop_name", "") or conv.get("shopname", "") or ""
    platform = conv.get("platform", "shopee")
    shop_id = conv.get("shop_id", "")

    # หา messages collection — ลอง env var ก่อน, ถ้าไม่มีลอง _shp suffix
    msg_coll_name = os.environ.get("ADMIN_MONGO_COLLECTION_MESSAGES", "").strip()
    if not msg_coll_name or msg_coll_name not in db.list_collection_names():
        if "messages_shp" in db.list_collection_names():
            msg_coll_name = "messages_shp"
        else:
            msg_coll_name = "messages"
    print(f"  Using messages collection: {msg_coll_name}")
    msg_coll = db[msg_coll_name]

    # ดึง messages ฝั่ง in (direction = "in")
    msgs = list(msg_coll.find({
        "conversation_id": conversation_id,
        "direction": "in",
    }).sort("created_timestamp", 1))

    print(f"  Conversation: {conversation_id}")
    print(f"  Shop: {shop_name} (shop_id={shop_id})")
    print(f"  Platform: {platform}")
    print(f"  User messages: {len(msgs)}")

    return msgs, shop_name, platform


def extract_text_and_images(msg: dict) -> tuple[str, list[str]]:
    """แยก text และ image URLs จาก message
    Schema ของ Shopee mirror:
      raw_payload.data.content.message_type = "image" | "text" | ...
      raw_payload.data.content.content = { url, image_url, thumb_url, ... }
    """
    text = msg.get("text", "") or ""
    images: list[str] = []
    raw = msg.get("raw_payload")
    if raw and isinstance(raw, dict):
        # schema หลัก: raw_payload.data.content
        data = raw.get("data", {})
        if isinstance(data, dict):
            content = data.get("content", {})
            if isinstance(content, dict):
                msg_type = content.get("message_type", "")
                if msg_type in ("image", "image_with_text", "video"):
                    inner = content.get("content", {})
                    if isinstance(inner, dict):
                        # ดึง URL จากหลาย field (เหมือน messageMediaParser.ts)
                        for key in ("url", "image_url", "sticker_url", "image", "pic", "file_url"):
                            val = inner.get(key)
                            if isinstance(val, str) and val.startswith("http"):
                                images.append(val)
                                break
                        # thumb_url อาจเป็น hash — prepend Shopee host
                        if not images:
                            for key in ("thumb_url", "thumbnail_url"):
                                val = inner.get(key)
                                if isinstance(val, str) and val:
                                    if val.startswith("http"):
                                        images.append(val)
                                    else:
                                        images.append(f"https://img.sp.mms.shopee.sg/{val}")
                                    break
        # fallback schema: raw_payload.message_type + raw_payload.content
        if not images:
            msg_type = raw.get("message_type", "") or raw.get("msg_type", "")
            if msg_type in ("image", "image_with_text", "video"):
                content = raw.get("content", {})
                if isinstance(content, dict):
                    for key in ("url", "image_url", "image", "pic", "file_url"):
                        val = content.get(key)
                        if isinstance(val, str) and val.startswith("http"):
                            images.append(val)
                            break
    return text, images


def main():
    conversation_id = sys.argv[1] if len(sys.argv) > 1 else "shp_1291688535969234763"

    print("=" * 70)
    print("=== Shadow Bot — OpenRouter Full Flow ===")
    print(f"Conversation: {conversation_id}")
    print("=" * 70)

    # ─── ดึงข้อความจริง ─────────────────────────────────────
    msgs, shop_name, platform = fetch_user_messages(conversation_id)
    if not msgs:
        print("❌ ไม่มีข้อความฝั่น in ใน conversation นี้", file=sys.stderr)
        sys.exit(1)

    # ─── MongoDB + persona ──────────────────────────────────
    product_client = product_store.get_client()
    product_db_name = os.environ.get("MONGO_DB", "").strip()
    if not product_db_name:
        print("❌ MONGO_DB ไม่ถูกตั้งใน env", file=sys.stderr)
        sys.exit(1)
    product_db = product_client[product_db_name]
    persona_doc = persona.get_persona(shop_name, platform=platform)
    persona_extra = persona.build_persona_instruction(persona_doc, shop_name)
    system_instruction = llm.SYSTEM_INSTRUCTION + persona_extra if persona_extra else llm.SYSTEM_INSTRUCTION

    # ─── วนลูปแต่ละข้อความ ──────────────────────────────────
    history: list[dict] = []
    results: list[dict] = []
    details: list[dict] = []
    grand_total_cost = 0.0
    grand_total_prompt = 0
    grand_total_output = 0

    for i, msg in enumerate(msgs, 1):
        text, images = extract_text_and_images(msg)
        if not text.strip():
            continue

        print(f"\n{'─' * 70}")
        print(f"### Q[{i}/{len(msgs)}]: {text[:80]!r}")
        if images:
            print(f"  📷 images: {len(images)}")
        print(f"{'─' * 70}")

        q_cost = 0.0
        q_prompt = 0
        q_output = 0
        steps: list[dict] = []
        q_start = time.time()

        ref = f"conv:{conversation_id}|q:{i}"

        # ─── Step 0: Buffer flush ─────────────────────────────
        if len(history) >= 10:
            merged = " | ".join([h["text"] for h in history[-10:] if h["role"] == "user"][-5:] + [text])
            print(f"  [Step 0] Buffer flush: merge → 1 (ฟรี)")
            steps.append({"step": "buffer_flush", "model": None, "system_prompt": None,
                          "user_prompt": merged[:200], "answer": None,
                          "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0,
                          "duration_s": 0, "note": "merge 10 questions into 1 (no LLM call)",
                          "input": {"merged_questions": [h["text"][:100] for h in history[-10:] if h["role"] == "user"][-5:] + [text]},
                          "output": {"combined_message": merged[:500]}})
        else:
            merged = text
            print(f"  [Step 0] Buffer: {len(history)} msgs (ไม่ flush)")
            steps.append({"step": "buffer_flush", "model": None, "system_prompt": None,
                          "user_prompt": None, "answer": None,
                          "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0,
                          "duration_s": 0, "note": f"buffer has {len(history)} msgs, no flush",
                          "input": {"buffer_count": len(history)},
                          "output": None})

        # ─── Step 1: Vision ───────────────────────────────────
        if images:
            print(f"  [Step 1] Vision ({MODEL_VISION})...")
            # ⚡ ส่งเฉพาะคำถามปัจจุบัน (text) ไม่ใช่ merged history ทั้งก้อน
            #    เพื่อกัน vision model โดน bias จากคำถามก่อนหน้า (เช่น คุยเรื่องพาวเวอร์แบงค์
            #    แล้วรูปแมวกลายเป็นพาวเวอร์แบงค์) — context เป็นแค่ hint เบาๆ
            vision_prompt = llm._VISION_PROMPT + f"\nร้าน: {shop_name}\nคำถามปัจจุบัน: {text[:150]}"
            vision_user = f"รูป: {images[0]}\nอธิบายรูปนี้เป็นภาษาไทยสั้นๆ"
            v = call_or(MODEL_VISION, vision_prompt, vision_user, max_tokens=200, temperature=0.1,
                        source="shadow:vision", step="vision", reference=ref)
            q_cost += v["cost_usd"]
            q_prompt += v["prompt_tokens"]
            q_output += v["output_tokens"]
            vision_desc = v["answer"]
            steps.append({"step": "vision", "model": MODEL_VISION,
                          "system_prompt": vision_prompt[:500], "user_prompt": vision_user,
                          "answer": vision_desc, "prompt_tokens": v["prompt_tokens"],
                          "output_tokens": v["output_tokens"], "cost_usd": v["cost_usd"],
                          "duration_s": round(v["duration_s"], 2), "images": images,
                          "input": {"urls": images, "current_question": text[:150]},
                          "output": {"description": vision_desc[:500]}})
            print(f"           → {v['prompt_tokens']}+{v['output_tokens']} tokens, ${v['cost_usd']:.6f}")
        else:
            print(f"  [Step 1] Vision: skip (ไม่มีรูป)")
            vision_desc = ""
            steps.append({"step": "vision", "model": None, "system_prompt": None,
                          "user_prompt": None, "answer": None,
                          "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0,
                          "duration_s": 0, "note": "no images"})

        # ─── Step 2: Intent ───────────────────────────────────
        print(f"  [Step 2] Intent ({MODEL_INTENT})...")
        intent_system = intent_classifier._INTENT_PROMPT
        intent_history = [{"role": h["role"], "text": h["text"]} for h in history[-6:]]
        intent_user = json.dumps({"message": merged, "history_count": len(history), "shop": shop_name},
                                 ensure_ascii=False)
        ic = call_or(MODEL_INTENT, intent_system, intent_user, intent_history, max_tokens=100, temperature=0.0,
                     source="shadow:intent", step="intent", reference=ref)
        q_cost += ic["cost_usd"]
        q_prompt += ic["prompt_tokens"]
        q_output += ic["output_tokens"]
        steps.append({"step": "intent", "model": MODEL_INTENT,
                      "system_prompt": intent_system[:500], "user_prompt": intent_user,
                      "answer": ic["answer"], "prompt_tokens": ic["prompt_tokens"],
                      "output_tokens": ic["output_tokens"], "cost_usd": ic["cost_usd"],
                      "duration_s": round(ic["duration_s"], 2),
                      "input": {"message": merged[:200], "history_count": len(history), "shop": shop_name},
                      "output": {"intent_raw": ic["answer"][:500]}})
        print(f"           → {ic['prompt_tokens']}+{ic['output_tokens']} tokens, ${ic['cost_usd']:.6f}")

        # ─── Step 3: RAG ──────────────────────────────────────
        print(f"  [Step 3] RAG (MongoDB)...")
        t0 = time.time()
        products = product_store.fetch_products(product_db, merged, shop_filter=shop_name, limit=10)
        rag_time = time.time() - t0
        steps.append({"step": "rag", "model": None, "system_prompt": None,
                      "user_prompt": merged[:200], "answer": None,
                      "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0,
                      "duration_s": round(rag_time, 2),
                      "products_found": len(products),
                      "product_names": [p.get("name", "")[:60] for p in products[:5]],
                      "input": {"query": merged[:200], "shop": shop_name, "limit": 10},
                      "output": {"product_count": len(products), "products": [p.get("name", "")[:60] for p in products[:5]]}})
        print(f"           → {len(products)} products, {rag_time:.2f}s (ฟรี)")

        # ─── Step 4: LLM2 ─────────────────────────────────────
        print(f"  [Step 4] LLM2 ({MODEL_LLM2})...")
        context = llm._build_context(products, shop_hint=shop_name, include_description=False)
        extra_ctx = f"=== รูปภาพที่ลูกค้าส่งมา ===\n{vision_desc}\n" if vision_desc else ""
        user_prompt = (
            f"{context}\n\n{extra_ctx}"
            f"คำถามของลูกค้า: {merged}\n\n"
            f"ตอบจากข้อมูลสินค้าใน context เป็นหลัก ประมาณ 2-3 บรรทัด"
        )
        a1 = call_or(MODEL_LLM2, system_instruction, user_prompt, history, max_tokens=500, temperature=0.3,
                     source="shadow:llm2", step="llm2", reference=ref)
        q_cost += a1["cost_usd"]
        q_prompt += a1["prompt_tokens"]
        q_output += a1["output_tokens"]
        steps.append({"step": "llm2", "model": MODEL_LLM2,
                      "system_prompt": system_instruction[:500], "user_prompt": user_prompt[:1000],
                      "answer": a1["answer"], "prompt_tokens": a1["prompt_tokens"],
                      "output_tokens": a1["output_tokens"], "cost_usd": a1["cost_usd"],
                      "duration_s": round(a1["duration_s"], 2),
                      "input": {"context_length": len(context), "history_count": len(history)},
                      "output": {"answer": a1["answer"][:500]}})
        print(f"           → {a1['prompt_tokens']}+{a1['output_tokens']} tokens, ${a1['cost_usd']:.6f}")

        # ─── Step 5: Web search ───────────────────────────────
        print(f"  [Step 5] Web search ({MODEL_SEARCH})...")
        search_system = "คุณเป็นผู้ช่วยขายของออนไลน์ ค้นหาข้อมูลสินค้าจากเว็บแล้วตอบเป็นภาษาไทย"
        search_user = f"ค้นหา: {merged}\nร้าน: {shop_name}\nตอบเป็นภาษาไทยสั้นๆ พร้อมแหล่งข้อมูล"
        ws = call_or(MODEL_SEARCH, search_system, search_user, history, max_tokens=300, temperature=0.3,
                     source="shadow:web_search", step="web_search", reference=ref)
        q_cost += ws["cost_usd"]
        q_prompt += ws["prompt_tokens"]
        q_output += ws["output_tokens"]
        steps.append({"step": "web_search", "model": MODEL_SEARCH,
                      "system_prompt": search_system, "user_prompt": search_user,
                      "answer": ws["answer"], "prompt_tokens": ws["prompt_tokens"],
                      "output_tokens": ws["output_tokens"], "cost_usd": ws["cost_usd"],
                      "duration_s": round(ws["duration_s"], 2),
                      "input": {"query": merged[:200], "shop": shop_name},
                      "output": {"search_answer": ws["answer"][:500]}})
        print(f"           → {ws['prompt_tokens']}+{ws['output_tokens']} tokens, ${ws['cost_usd']:.6f}")

        # ─── Step 6: RAG again ─────────────────────────────────
        print(f"  [Step 6] RAG again (MongoDB)...")
        t0 = time.time()
        products2 = product_store.fetch_products(product_db, ws["answer"][:200], shop_filter=shop_name, limit=10)
        rag2_time = time.time() - t0
        steps.append({"step": "rag_again", "model": None, "system_prompt": None,
                      "user_prompt": ws["answer"][:200], "answer": None,
                      "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0,
                      "duration_s": round(rag2_time, 2),
                      "products_found": len(products2),
                      "product_names": [p.get("name", "")[:60] for p in products2[:5]],
                      "input": {"query": ws["answer"][:200], "shop": shop_name, "limit": 10},
                      "output": {"product_count": len(products2), "products": [p.get("name", "")[:60] for p in products2[:5]]}})
        print(f"           → {len(products2)} products, {rag2_time:.2f}s (ฟรี)")

        # ─── Step 7: LLM2 again ───────────────────────────────
        print(f"  [Step 7] LLM2 again ({MODEL_LLM2})...")
        context2 = llm._build_context(products2, shop_hint=shop_name, include_description=False)
        user_prompt2 = (
            f"{context2}\n\n=== ข้อมูลจากเว็บ ===\n{ws['answer']}\n\n"
            f"คำถามของลูกค้า: {merged}\n\nตอบจากข้อมูลสินค้า + ข้อมูลจากเว็บ"
        )
        a2 = call_or(MODEL_LLM2, system_instruction, user_prompt2, history, max_tokens=500, temperature=0.3,
                     source="shadow:llm2_again", step="llm2_again", reference=ref)
        q_cost += a2["cost_usd"]
        q_prompt += a2["prompt_tokens"]
        q_output += a2["output_tokens"]
        steps.append({"step": "llm2_again", "model": MODEL_LLM2,
                      "system_prompt": system_instruction[:500], "user_prompt": user_prompt2[:1000],
                      "answer": a2["answer"], "prompt_tokens": a2["prompt_tokens"],
                      "output_tokens": a2["output_tokens"], "cost_usd": a2["cost_usd"],
                      "duration_s": round(a2["duration_s"], 2),
                      "input": {"context_length": len(context2), "search_answer_length": len(ws["answer"]), "history_count": len(history)},
                      "output": {"final_answer": a2["answer"][:500]}})
        print(f"           → {a2['prompt_tokens']}+{a2['output_tokens']} tokens, ${a2['cost_usd']:.6f}")

        q_elapsed = time.time() - q_start

        # ─── สรุปคำถามนี้ ──────────────────────────────────────
        print(f"\n  ╔══ Q{i} summary ═══════════════════════════════════════╗")
        print(f"  ║ 💰 คำถามนี้เสีย: ${q_cost:.6f} (฿{q_cost * 36:.4f})")
        print(f"  ║ 📊 Tokens: {q_prompt:,} in + {q_output:,} out = {q_prompt + q_output:,} total")
        print(f"  ║ ⏱  เวลา: {q_elapsed:.1f}s")
        print(f"  ║ 📈 รวมสะสม: ${grand_total_cost + q_cost:.6f} (฿{(grand_total_cost + q_cost) * 36:.4f})")
        print(f"  ╚══════════════════════════════════════════════════════╝")
        for s in steps:
            if s.get("model"):
                print(f"    {s['step']:12s} {s['model']:38s} {s['prompt_tokens']:6d}+{s['output_tokens']:4d}  ${s['cost_usd']:.6f} (฿{s['cost_usd'] * 36:.4f})")

        # ─── สร้าง result (Schema 1 + extra fields) ───────────
        step_summary = " | ".join([
            f"{s['step']}:{s.get('cost_usd', 0):.4f}" for s in steps if s.get("model")
        ])
        results.append({
            "i": i,
            "shop": shop_name,
            "msg": text,
            "cat": "openrouter_shadow",
            "source": "product_store+web_search",
            "web_search": "Y",
            "products": len(products),
            "elapsed": round(q_elapsed, 2),
            "ok": "✅" if not a2["answer"].startswith("ERROR") else "ERR",
            "answer": a2["answer"],
            "notes": f"cost: ${q_cost:.6f} | tokens: {q_prompt}+{q_output} | steps: {step_summary}",
            "test_id": f"shadow-{conversation_id}-{i}",
            # extra fields (ignored by test-results route)
            "steps": steps,
            "total_cost_usd": round(q_cost, 6),
            "total_tokens": {"prompt": q_prompt, "output": q_output},
            "has_images": bool(images),
            "image_urls": images,
        })

        details.append({
            "i": i,
            "conversation_id": conversation_id,
            "shop": shop_name,
            "question": text,
            "images": images,
            "steps": steps,
            "final_answer": a2["answer"],
            "total_cost_usd": round(q_cost, 6),
            "total_tokens": {"prompt": q_prompt, "output": q_output},
            "elapsed_s": round(q_elapsed, 2),
        })

        grand_total_cost += q_cost
        grand_total_prompt += q_prompt
        grand_total_output += q_output

        # สะสม history
        history.append({"role": "user", "text": text})
        history.append({"role": "model", "text": a2["answer"]})

    # ─── เซฟ JSON ────────────────────────────────────────────
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n✅ เซฟ results → {RESULTS_FILE}")

    with open(DETAILS_FILE, "w", encoding="utf-8") as f:
        json.dump(details, f, ensure_ascii=False, indent=2)
    print(f"✅ เซฟ details → {DETAILS_FILE}")

    # ─── เซฟลง test_chat_sessions (MongoDB admin) ────────────
    #    mark source=script_test → testchat/shopee ดึงได้ + inbox แสดง badge
    print(f"\n📝 บันทึกลง test_chat_sessions...")
    try:
        admin_db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
        admin_client = knowledge_base._build_admin_client()
        admin_db = admin_client[admin_db_name]
        test_chat_coll_name = os.environ.get("ADMIN_MONGO_COLLECTION_TEST_CHAT_SESSIONS", "test_chat_sessions").strip()
        test_chat_coll = admin_db[test_chat_coll_name]

        now = datetime.utcnow()
        session_doc = {
            "shop": shop_name,
            "title": f"🧪 Shadow OpenRouter — {conversation_id}",
            "messages": [],
            "created_at": now,
            "updated_at": now,
            "admin_id": "system:script_test",
            "admin_name": "Shadow Bot (OpenRouter)",
            "source": "script_test",  # ⚡ mark สำหรับ badge
            "script_test": True,  # ⚡ flag สำหรับ filter
            "conversation_id": conversation_id,
            "platform": platform,
            "total_cost_usd": round(grand_total_cost, 6),
            "total_tokens": {"prompt": grand_total_prompt, "output": grand_total_output},
        }
        insert_result = test_chat_coll.insert_one(session_doc)
        session_id = str(insert_result.inserted_id)
        print(f"  ✅ สร้าง session: {session_id}")

        # push messages (user + model สลับกัน)
        for r in results:
            # user message
            user_msg = {
                "role": "user",
                "text": r["msg"],
                "timestamp": now.isoformat(),
                "images": r.get("image_urls", []),
            }
            test_chat_coll.update_one(
                {"_id": insert_result.inserted_id},
                {"$push": {"messages": user_msg}, "$set": {"updated_at": datetime.utcnow()}},
            )

            # model message (with full stats + steps)
            steps_for_ui = []
            for s in r.get("steps", []):
                steps_for_ui.append({
                    "name": s.get("step", ""),
                    "model": s.get("model") or "",
                    "tokens_in": s.get("prompt_tokens", 0),
                    "tokens_out": s.get("output_tokens", 0),
                    "time_s": s.get("duration_s", 0),
                    "cost_usd": s.get("cost_usd", 0),
                    "cost_thb": round(s.get("cost_usd", 0) * 36, 2),
                    "input": s.get("input"),
                    "output": s.get("output"),
                })

            model_msg = {
                "role": "model",
                "text": r["answer"],
                "timestamp": now.isoformat(),
                "stats": {
                    "elapsed": r["elapsed"],
                    "usage": {"prompt": r["total_tokens"]["prompt"], "output": r["total_tokens"]["output"],
                              "total": r["total_tokens"]["prompt"] + r["total_tokens"]["output"]},
                    "cost": r["total_cost_usd"],
                    "model": "openrouter-shadow",
                    "source": "product_store+web_search",
                    "web_search_used": True,
                    "web_search_model": MODEL_SEARCH,
                    "steps": steps_for_ui,
                },
            }
            test_chat_coll.update_one(
                {"_id": insert_result.inserted_id},
                {"$push": {"messages": model_msg}, "$set": {"updated_at": datetime.utcnow()}},
            )

        print(f"  ✅ บันทึก {len(results) * 2} messages ลง session")
        print(f"\n📌 session_id: {session_id}")
        print(f"   ดูได้ที่: /test-chat/shopee → เลือก session '🧪 Shadow OpenRouter — {conversation_id}'")
        print(f"   ดูได้ที่: /test-chat-result?session_id={session_id}")
    except Exception as e:
        print(f"  ❌ บันทึก MongoDB ล้มเหลว: {e}", file=sys.stderr)

    # ─── สรุปรวม ─────────────────────────────────────────────
    print(f"\n{'=' * 70}")
    print(f"╔══════════════════════════════════════════════════════════╗")
    print(f"║          📊 สรุปรวม Shadow Bot OpenRouter               ║")
    print(f"╠══════════════════════════════════════════════════════════╣")
    print(f"║  Conversation: {conversation_id:<42s} ║")
    print(f"║  Shop: {shop_name:<50s} ║")
    print(f"║  Questions: {len(results):<47d} ║")
    print(f"║  Total tokens: {grand_total_prompt:,} in + {grand_total_output:,} out{'':>16s}║")
    print(f"║                                                          ║")
    print(f"║  💰 ค่าใช้จ่ายรวม: ${grand_total_cost:.6f} (฿{grand_total_cost * 36:.2f}){'':>17s}║")
    avg = grand_total_cost / len(results) if results else 0
    print(f"║  💰 เฉลี่ย/คำถาม: ${avg:.6f} (฿{avg * 36:.2f}){'':>20s}║")
    print(f"╚══════════════════════════════════════════════════════════╝")
    print(f"{'=' * 70}")
    print(f"\nดูผลได้ที่:")
    print(f"  test-results page → เลือกไฟล์ 'openrouter_shadow_results.json'")
    print(f"  details JSON → {DETAILS_FILE}")


if __name__ == "__main__":
    main()
