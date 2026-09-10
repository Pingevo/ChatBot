#!/usr/bin/env python3
"""
test_openrouter_full_cost.py — เทียบราคา bot ถ้า call OpenRouter แทน Gemini ตรงๆ

จำลอง FULL flow ที่แพงที่สุดต่อ 1 คำถาม:
  1. Buffer flush (10 คำถาม merge เป็น 1) — ไม่ call LLM (merge ใน Python)
  2. Image vision pass (ถ้ามีรูป) — gemini-3.1-flash-lite
  3. Intent classification — gemini-3.1-flash-lite
  4. RAG (MongoDB — ฟรี)
  5. LLM2 (answer) — gemini-3.5-flash-lite
  6. Web search fallback (ถ้า LLM2 ตอบไม่ได้) — gemini-2.5-flash:online
  7. RAG again (ค้นสินค้าจากผล search)
  8. LLM2 again (ตอบจากผล search + RAG)

ทั้งหมด call ผ่าน OpenRouter เพื่อดูราคาจริง

วิธีใช้:
  cd chatbot
  python3 test_openrouter_full_cost.py

ต้องมี env (โหลดจาก .env อัตโนมัติ):
  - OPENROUTER_API_KEY
  - MONGO_* (product DB)
"""
from __future__ import annotations
import os
import sys
import json
import time
import urllib.request
from pathlib import Path

# ─── path + .env ─────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat import product_store, llm, persona, intent_classifier

# ─── Config ───────────────────────────────────────────────────
SHOP = "CukTechThailand"
OPENROUTER_BASE = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

# ⚡ model เดียวกับ bot จริง
MODEL_VISION = "google/gemini-3.1-flash-lite"        # vision pass
MODEL_INTENT = "google/gemini-3.1-flash-lite"        # intent classification
MODEL_LLM2 = "google/gemini-3.5-flash-lite"          # answer
MODEL_SEARCH = "google/gemini-2.5-flash:online"     # web search fallback

# ราคา OpenRouter (USD per 1M tokens)
PRICING = {
    "google/gemini-3.1-flash-lite": {"input": 0.25, "output": 0.50},
    "google/gemini-3.5-flash-lite": {"input": 0.30, "output": 2.50},
    "google/gemini-2.5-flash:online": {"input": 0.30, "output": 2.50},  # +search premium
}

# ─── คำถามจาก session log (8 คำถามจริง) ─────────────────────
QUESTIONS = [
    "หาสายชาร์จ",
    "หาสายชาร์จ ไอโฟน 11 โปรแมก แบบชาร์จไวๆ ราคาถูกๆ",
    "ไม่มีสาย ligthning หรอ",
    "แล้วทำไมตะกี้บอกไม่มีอะ่",
    "มีหัวชาจไหม ใช้ในรถ",
    "CUKTECH CC903P Car Charger 100W Max อันนี้มีไหม",
    "CUKTECH WCJ153 2 in 1 Car Charge",
    "สรุปคือมี สรปุมีหรือไม่มี",
]

# รูปตัวอย่าง (Shopee CDN — ใช้สำหรับ vision pass test)
SAMPLE_IMAGE_URL = "https://cf.shopee.co.th/file/sg-11134201-82596-msqlu3p9c6bm88"


def _get_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        print("❌ ไม่พบ OPENROUTER_API_KEY", file=sys.stderr)
        sys.exit(1)
    return key


def _log_ai_usage(entry: dict) -> None:
    """ส่ง log ไป AI Usage Hub (fire-and-forget ไม่ throw) — เหมือน web_search.py"""
    hub_url = os.environ.get("AI_USAGE_HUB_URL", "").strip()
    hub_token = os.environ.get("AI_USAGE_HUB_TOKEN", "").strip()
    if not hub_url or not hub_token:
        return  # ยังไม่ตั้งค่า — ข้ามเงียบๆ
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
            source: str = "test_full_cost", step: str = "unknown") -> dict:
    """call OpenRouter — คืน {answer, prompt_tokens, output_tokens, cost_usd}
    ⚡ log ไป AI Usage Hub ทุกครั้ง (เหมือน bot จริง)
    """
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
            "Authorization": f"Bearer {_get_key()}",
            "HTTP-Referer": "https://chatbot.local",
            "X-Title": "ShopeeChatbot-FullCostTest",
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
                  "cost_usd": cost_usd}
    except urllib.error.HTTPError as e:
        _status = "error"
        _http_status = e.code
        _error_msg = e.read().decode("utf-8")[:300]
        result = {"answer": f"ERROR: {e.code} {_error_msg}", "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0}
    except Exception as e:
        _status = "error"
        _http_status = 0
        _error_msg = str(e)
        result = {"answer": f"ERROR: {e}", "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0}

    # ⚡ log ไป AI Usage Hub (เหมือน bot จริง)
    _duration_ms = int((time.time() - _req_start) * 1000)
    _log_ai_usage({
        "provider": "openrouter",
        "model": model,
        "operation": "chat.completions",
        "source": source,
        "user": "system:cost_test",
        "reference": f"shop:{SHOP}|step:{step}",
        "prompt_tokens": result["prompt_tokens"],
        "completion_tokens": result["output_tokens"],
        "cost_usd": round(result["cost_usd"], 6),
        "duration_ms": _duration_ms,
        "attempt": 1,
        "status": _status,
        "http_status": _http_status,
        "error_message": _error_msg,
        "raw_usage": _resp_data.get("usage", {}) if _status == "success" else None,
        "metadata": {
            "shop": SHOP,
            "step": step,
            "test_script": True,
        },
    })
    return result


def main():
    print("=" * 70)
    print("=== OpenRouter FULL Flow Cost Test ===")
    print(f"Shop: {SHOP}")
    print(f"Models:")
    print(f"  Vision: {MODEL_VISION}")
    print(f"  Intent: {MODEL_INTENT}")
    print(f"  LLM2:   {MODEL_LLM2}")
    print(f"  Search: {MODEL_SEARCH}")
    print(f"Questions: {len(QUESTIONS)}")
    print("=" * 70)

    # ─── MongoDB + persona (เหมือน bot) ──────────────────────
    client = product_store.get_client()
    db = client[os.environ.get("MONGO_DB", "dbWallet")]
    persona_doc = persona.get_persona(SHOP, platform="shopee")
    persona_extra = persona.build_persona_instruction(persona_doc, SHOP)
    system_instruction = llm.SYSTEM_INSTRUCTION + persona_extra if persona_extra else llm.SYSTEM_INSTRUCTION

    # ─── จำลอง history 10 คำถาม+คำตอบ (สะสมจากคำถามก่อนหน้า) ──
    history: list[dict] = []

    grand_total_cost = 0.0
    grand_total_prompt = 0
    grand_total_output = 0
    per_step_costs: list[dict] = []

    for i, q in enumerate(QUESTIONS, 1):
        print(f"\n{'─' * 70}")
        print(f"### Question [{i}/{len(QUESTIONS)}]: {q!r}")
        print(f"{'─' * 70}")

        q_cost = 0.0
        q_prompt = 0
        q_output = 0
        steps_log: list[dict] = []

        # ─── Step 0: Buffer flush (10 คำถาม merge เป็น 1) ─────
        #    จำลอง: ถ้ามี 10 คำถามใน buffer → merge เป็นคำถามเดียว
        #    (ใน bot จริง merge ใน Python — ไม่ call LLM)
        #    ที่นี่ merge คำถามปัจจุบัน + history ล่าสุดเป็น "merged question"
        if len(history) >= 10:
            merged = " | ".join([h["text"] for h in history[-10:] if h["role"] == "user"][-5:] + [q])
            print(f"  [Step 0] Buffer flush: merge 10 → 1 (ไม่ call LLM — ฟรี)")
            print(f"           merged: {merged[:80]}...")
        else:
            merged = q
            print(f"  [Step 0] Buffer: {len(history)} คำถาม (ยังไม่ถึง 10 → ไม่ flush)")

        # ─── Step 1: Vision pass (ถ้ามีรูป) ────────────────────
        #    จำลอง: ส่งรูปตัวอย่างในคำถามแรก + คำถามที่ 5
        has_image = i in (1, 5)
        if has_image:
            print(f"  [Step 1] Vision pass ({MODEL_VISION})...")
            vision_prompt = llm._VISION_PROMPT + f"\nร้าน: {SHOP}\nHistory context: {merged[:200]}"
            # ใน bot จริง ส่งรูปเป็น inline_data — ที่นี่ส่ง URL เป็น text (OpenRouter รองรับ image_url)
            vision_user = f"รูป: {SAMPLE_IMAGE_URL}\nอธิบายรูปนี้เป็นภาษาไทยสั้นๆ"
            t0 = time.time()
            v = call_or(MODEL_VISION, vision_prompt, vision_user, max_tokens=200, temperature=0.1,
                        source="test_full_cost:vision", step="vision")
            v_time = time.time() - t0
            q_cost += v["cost_usd"]
            q_prompt += v["prompt_tokens"]
            q_output += v["output_tokens"]
            vision_desc = v["answer"]
            steps_log.append({"step": "vision", "model": MODEL_VISION, "tokens_in": v["prompt_tokens"],
                              "tokens_out": v["output_tokens"], "cost_usd": v["cost_usd"], "time_s": round(v_time, 2)})
            print(f"           → {v['prompt_tokens']}+{v['output_tokens']} tokens, ${v['cost_usd']:.6f}, {v_time:.2f}s")
            print(f"           desc: {vision_desc[:80]}...")
        else:
            print(f"  [Step 1] Vision: skip (ไม่มีรูป)")
            vision_desc = ""

        # ─── Step 2: Intent classification ────────────────────
        print(f"  [Step 2] Intent ({MODEL_INTENT})...")
        intent_system = intent_classifier._INTENT_PROMPT
        intent_history = [{"role": h["role"], "text": h["text"]} for h in history[-6:]]
        intent_user = json.dumps({"message": merged, "history_count": len(history), "shop": SHOP},
                                 ensure_ascii=False)
        t0 = time.time()
        ic = call_or(MODEL_INTENT, intent_system, intent_user, intent_history, max_tokens=100, temperature=0.0,
                     source="test_full_cost:intent", step="intent")
        ic_time = time.time() - t0
        q_cost += ic["cost_usd"]
        q_prompt += ic["prompt_tokens"]
        q_output += ic["output_tokens"]
        steps_log.append({"step": "intent", "model": MODEL_INTENT, "tokens_in": ic["prompt_tokens"],
                          "tokens_out": ic["output_tokens"], "cost_usd": ic["cost_usd"], "time_s": round(ic_time, 2)})
        print(f"           → {ic['prompt_tokens']}+{ic['output_tokens']} tokens, ${ic['cost_usd']:.6f}, {ic_time:.2f}s")
        print(f"           raw: {ic['answer'][:120]}...")

        # ─── Step 3: RAG (MongoDB — ฟรี) ──────────────────────
        print(f"  [Step 3] RAG (MongoDB)...")
        t0 = time.time()
        products = product_store.fetch_products(db, merged, shop_filter=SHOP, limit=10)
        rag_time = time.time() - t0
        print(f"           → {len(products)} products, {rag_time:.2f}s (ฟรี)")

        # ─── Step 4: LLM2 (answer) ────────────────────────────
        print(f"  [Step 4] LLM2 answer ({MODEL_LLM2})...")
        context = llm._build_context(products, shop_hint=SHOP, include_description=False)
        extra_ctx = f"=== รูปภาพที่ลูกค้าส่งมา ===\n{vision_desc}\n" if vision_desc else ""
        user_prompt = (
            f"{context}\n\n"
            f"{extra_ctx}"
            f"คำถามของลูกค้า: {merged}\n\n"
            f"สำคัญ: ตอบจากข้อมูลสินค้าใน context ด้านบนเป็นหลัก "
            f"สินค้าที่ตรงกับคำถามมากที่สุดอยู่ลำดับแรกของ context "
            f"ถ้า context มีสินค้าเดียวกับที่คุยใน history → ใช้ข้อมูลจาก context เป็นหลัก "
            f"แต่สามารถอ้างอิงคำตอบก่อนหน้าได้ถ้าเป็นสินค้าเดียวกันและ context ไม่มีข้อมูลนั้น\n\n"
            f"⚠️ ความยาวคำตอบ: ตอบให้ครบถ้วน ไม่สั้นเกินไป ไม่ยาวเกินไป "
            f"ประมาณ 2-3 บรรทัด (60-120 คำ)"
        )
        t0 = time.time()
        a1 = call_or(MODEL_LLM2, system_instruction, user_prompt, history, max_tokens=500, temperature=0.3,
                     source="test_full_cost:llm2", step="llm2")
        a1_time = time.time() - t0
        q_cost += a1["cost_usd"]
        q_prompt += a1["prompt_tokens"]
        q_output += a1["output_tokens"]
        steps_log.append({"step": "llm2", "model": MODEL_LLM2, "tokens_in": a1["prompt_tokens"],
                          "tokens_out": a1["output_tokens"], "cost_usd": a1["cost_usd"], "time_s": round(a1_time, 2)})
        print(f"           → {a1['prompt_tokens']}+{a1['output_tokens']} tokens, ${a1['cost_usd']:.6f}, {a1_time:.2f}s")
        print(f"           answer: {a1['answer'][:100]}...")

        # ─── Step 5: Web search fallback (จำลอง worst case) ───
        #    สมมติ LLM2 ตอบไม่ได้ → trigger web search
        #    (ใน bot จริง web_search.should_use_web_search() ตัดสินใจ)
        #    ที่นี่บังคับ trigger เพื่อวัด cost สูงสุด
        print(f"  [Step 5] Web search ({MODEL_SEARCH})...")
        search_system = "คุณเป็นผู้ช่วยขายของออนไลน์ ค้นหาข้อมูลสินค้าจากเว็บแล้วตอบเป็นภาษาไทย"
        search_user = f"ค้นหา: {merged}\nร้าน: {SHOP}\nตอบเป็นภาษาไทยสั้นๆ พร้อมแหล่งข้อมูล"
        t0 = time.time()
        ws = call_or(MODEL_SEARCH, search_system, search_user, history, max_tokens=300, temperature=0.3,
                     source="test_full_cost:web_search", step="web_search")
        ws_time = time.time() - t0
        q_cost += ws["cost_usd"]
        q_prompt += ws["prompt_tokens"]
        q_output += ws["output_tokens"]
        steps_log.append({"step": "web_search", "model": MODEL_SEARCH, "tokens_in": ws["prompt_tokens"],
                          "tokens_out": ws["output_tokens"], "cost_usd": ws["cost_usd"], "time_s": round(ws_time, 2)})
        print(f"           → {ws['prompt_tokens']}+{ws['output_tokens']} tokens, ${ws['cost_usd']:.6f}, {ws_time:.2f}s")
        print(f"           search answer: {ws['answer'][:100]}...")

        # ─── Step 6: RAG again (ค้นสินค้าจากผล search) ────────
        print(f"  [Step 6] RAG again (MongoDB)...")
        t0 = time.time()
        products2 = product_store.fetch_products(db, ws["answer"][:200], shop_filter=SHOP, limit=10)
        rag2_time = time.time() - t0
        print(f"           → {len(products2)} products, {rag2_time:.2f}s (ฟรี)")

        # ─── Step 7: LLM2 again (ตอบจาก search + RAG) ─────────
        print(f"  [Step 7] LLM2 answer again ({MODEL_LLM2})...")
        context2 = llm._build_context(products2, shop_hint=SHOP, include_description=False)
        user_prompt2 = (
            f"{context2}\n\n"
            f"=== ข้อมูลจากเว็บ ===\n{ws['answer']}\n\n"
            f"คำถามของลูกค้า: {merged}\n\n"
            f"ตอบจากข้อมูลสินค้าใน context + ข้อมูลจากเว็บ"
        )
        t0 = time.time()
        a2 = call_or(MODEL_LLM2, system_instruction, user_prompt2, history, max_tokens=500, temperature=0.3,
                     source="test_full_cost:llm2_again", step="llm2_again")
        a2_time = time.time() - t0
        q_cost += a2["cost_usd"]
        q_prompt += a2["prompt_tokens"]
        q_output += a2["output_tokens"]
        steps_log.append({"step": "llm2_again", "model": MODEL_LLM2, "tokens_in": a2["prompt_tokens"],
                          "tokens_out": a2["output_tokens"], "cost_usd": a2["cost_usd"], "time_s": round(a2_time, 2)})
        print(f"           → {a2['prompt_tokens']}+{a2['output_tokens']} tokens, ${a2['cost_usd']:.6f}, {a2_time:.2f}s")
        print(f"           final answer: {a2['answer'][:100]}...")

        # ─── สรุปคำถามนี้ ──────────────────────────────────────
        print(f"\n  ── Question {i} summary ──")
        print(f"  Total tokens: in={q_prompt}  out={q_output}  total={q_prompt + q_output}")
        print(f"  Total cost: ${q_cost:.6f} (฿{q_cost * 36:.4f})")
        for s in steps_log:
            print(f"    {s['step']:12s} {s['model']:35s} {s['tokens_in']:6d}+{s['tokens_out']:4d}  ${s['cost_usd']:.6f}")

        grand_total_cost += q_cost
        grand_total_prompt += q_prompt
        grand_total_output += q_output
        per_step_costs.append({"question": q, "cost": q_cost, "steps": steps_log})

        # สะสม history
        history.append({"role": "user", "text": q})
        history.append({"role": "model", "text": a2["answer"]})

    # ─── สรุปรวม ─────────────────────────────────────────────
    print(f"\n{'=' * 70}")
    print(f"=== สรุปรวม (FULL flow — worst case) ===")
    print(f"{'=' * 70}")
    print(f"Questions: {len(QUESTIONS)}")
    print(f"Total tokens: in={grand_total_prompt}  out={grand_total_output}  total={grand_total_prompt + grand_total_output}")
    print(f"Total cost: ${grand_total_cost:.6f} (฿{grand_total_cost * 36:.4f})")
    avg = grand_total_cost / len(QUESTIONS)
    print(f"Avg cost/question: ${avg:.6f} (฿{avg * 36:.4f})")
    print()

    # เทียบกับ Gemini ตรงๆ (จาก session log — ไม่มี web search)
    gemini_total = 0.007968 + 0.008566 + 0.003979 + 0.003730 + 0.003506 + 0.005912 + 0.004291 + 0.004592
    print(f"=== เทียบกับ Gemini ตรงๆ (session log — ไม่มี web search) ===")
    print(f"Gemini total: ${gemini_total:.6f} (฿{gemini_total * 36:.4f})")
    print(f"OpenRouter full flow: ${grand_total_cost:.6f} (฿{grand_total_cost * 36:.4f})")
    diff = grand_total_cost - gemini_total
    print(f"ส่วนต่าง: ${diff:+.6f} (฿{diff * 36:+.4f})")
    print()
    print(f"⚠️ หมายเหตุ: full flow นี้รวม web search + LLM2 รอบ 2 ที่ bot จริงไม่ได้ทำทุกคำถาม")
    print(f"   ถ้าไม่มี web search → ตัด Step 5-7 ออก → cost จะลดลงมาก")


if __name__ == "__main__":
    main()
