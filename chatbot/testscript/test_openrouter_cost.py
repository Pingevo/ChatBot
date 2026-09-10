#!/usr/bin/env python3
"""
test_openrouter_cost.py — เทียบราคา bot ถ้า call OpenRouter แทน Gemini ตรงๆ

วิธีใช้:
  cd chatbot
  python test_openrouter_cost.py

ต้องมี env:
  - OPENROUTER_API_KEY
  - MONGO_* (product DB — เหมือน bot)
  - ADMIN_MONGO_* (ไม่จำเป็น — ใช้แค่ product DB)

สคริปต์นี้:
  1. ใช้ product_store.fetch_products() จริง (RAG เหมือน bot)
  2. ใช้ llm.SYSTEM_INSTRUCTION + _build_context() จริง (prompt เหมือน bot)
  3. call OpenRouter แทน Gemini (chat/completions API)
  4. รายงาน cost ต่อคำถาม + รวม

⚠️ ไม่ส่งคำถามจริงไป OpenRouter — ใช้คำถามจาก session log ที่ user ให้มา
"""
from __future__ import annotations
import os
import sys
import json
import time
import urllib.request
from pathlib import Path

# ─── เพิ่ม path ให้ import ได้ ─────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ─── โหลด .env (เหมือน app.py) ────────────────────────────────
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat import product_store, llm, persona

# ─── Config ───────────────────────────────────────────────────
SHOP = "CukTechThailand"
# ⚡ ใช้ model เดียวกับ bot จริง — gemini-3.5-flash-lite
#    ถ้า OpenRouter ไม่มีรุ่นนี้ → ลอง google/gemini-2.5-flash (ราคาเท่ากัน)
OPENROUTER_MODEL = os.environ.get("OPENROUTER_TEST_MODEL", "google/gemini-3.5-flash-lite")
OPENROUTER_BASE = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

# ราคา OpenRouter (USD per 1M tokens)
# gemini-3.5-flash-lite: $0.30/M input, $2.50/M output (เท่า Gemini ตรงๆ)
OPENROUTER_PRICING = {
    "google/gemini-3.5-flash-lite": {"input": 0.30, "output": 2.50},
    "google/gemini-2.5-flash": {"input": 0.30, "output": 2.50},
    "google/gemini-flash-1.5-8b": {"input": 0.075, "output": 0.30},
    "google/gemini-flash-1.5": {"input": 0.075, "output": 0.30},
    "meta-llama/llama-3.3-70b-instruct": {"input": 0.23, "output": 0.40},
    "qwen/qwen-2.5-72b-instruct": {"input": 0.23, "output": 0.40},
}

# ─── คำถามจาก session log (8 คำถามจริง — log แสดง 15 เพราะ 2 bubbles/answer) ──
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


def _get_openrouter_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        print("❌ ไม่พบ OPENROUTER_API_KEY — export OPENROUTER_API_KEY=sk-... ก่อนรัน", file=sys.stderr)
        sys.exit(1)
    return key


def call_openrouter(
    system_instruction: str,
    user_prompt: str,
    history: list[dict] | None = None,
    model: str = OPENROUTER_MODEL,
) -> dict:
    """call OpenRouter chat/completions — คืน {answer, prompt_tokens, output_tokens, cost_usd}"""
    messages = []
    # system
    messages.append({"role": "system", "content": system_instruction})
    # history
    if history:
        for h in history:
            role = h.get("role", "user")
            text = h.get("text", "")
            # map "model" → "assistant"
            if role == "model":
                role = "assistant"
            messages.append({"role": role, "content": text})
    # user prompt
    messages.append({"role": "user", "content": user_prompt})

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 500,
    }

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{OPENROUTER_BASE.rstrip('/')}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_get_openrouter_key()}",
            "HTTP-Referer": "https://chatbot.local",
            "X-Title": "ShopeeChatbot-CostTest",
        },
        method="POST",
    )

    try:
        resp = urllib.request.urlopen(req, timeout=60)
        data = json.loads(resp.read().decode("utf-8"))
        answer = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = data.get("usage", {})
        prompt_t = usage.get("prompt_tokens", 0)
        output_t = usage.get("completion_tokens", 0)
        # cost จาก OpenRouter (รวม markup แล้ว)
        cost_from_or = float(usage.get("cost", 0.0))
        # คำนวณเองเผื่อ OpenRouter ไม่ส่ง cost
        pricing = OPENROUTER_PRICING.get(model, {"input": 0.30, "output": 2.50})
        cost_calc = (prompt_t * pricing["input"] + output_t * pricing["output"]) / 1_000_000
        cost_usd = cost_from_or if cost_from_or > 0 else cost_calc
        return {
            "answer": answer,
            "prompt_tokens": prompt_t,
            "output_tokens": output_t,
            "cost_usd": cost_usd,
            "cost_from_openrouter": cost_from_or,
        }
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")[:500]
        return {"answer": f"ERROR: {e.code} {err_body}", "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0}
    except Exception as e:
        return {"answer": f"ERROR: {e}", "prompt_tokens": 0, "output_tokens": 0, "cost_usd": 0}


def main():
    print(f"=== OpenRouter Cost Test ===")
    print(f"Shop: {SHOP}")
    print(f"Model: {OPENROUTER_MODEL}")
    print(f"Questions: {len(QUESTIONS)}")
    print()

    # ─── เชื่อม MongoDB (เหมือน bot) ─────────────────────────
    client = product_store.get_client()
    db = client[os.environ.get("MONGO_DB", "dbWallet")]

    # ─── ดึง persona (เหมือน bot) ────────────────────────────
    persona_doc = persona.get_persona(SHOP, platform="shopee")
    persona_extra = persona.build_persona_instruction(persona_doc, SHOP)
    system_instruction = llm.SYSTEM_INSTRUCTION + persona_extra if persona_extra else llm.SYSTEM_INSTRUCTION

    print(f"System instruction length: {len(system_instruction)} chars")
    print()

    # ─── รันแต่ละคำถาม ───────────────────────────────────────
    history: list[dict] = []
    total_cost = 0.0
    total_prompt = 0
    total_output = 0

    for i, q in enumerate(QUESTIONS, 1):
        print(f"--- [{i}/{len(QUESTIONS)}] {q!r} ---")

        # RAG — ดึงสินค้าเหมือน bot
        t0 = time.time()
        products = product_store.fetch_products(db, q, shop_filter=SHOP, limit=10)
        rag_time = time.time() - t0
        print(f"  RAG: {len(products)} products in {rag_time:.2f}s")

        # build context (เหมือน llm.answer)
        context = llm._build_context(products, shop_hint=SHOP, include_description=False)
        user_prompt = (
            f"{context}\n\n"
            f"คำถามของลูกค้า: {q}\n\n"
            f"สำคัญ: ตอบจากข้อมูลสินค้าใน context ด้านบนเป็นหลัก "
            f"สินค้าที่ตรงกับคำถามมากที่สุดอยู่ลำดับแรกของ context "
            f"ถ้า context มีสินค้าเดียวกับที่คุยใน history → ใช้ข้อมูลจาก context เป็นหลัก "
            f"แต่สามารถอ้างอิงคำตอบก่อนหน้าได้ถ้าเป็นสินค้าเดียวกันแและ context ไม่มีข้อมูลนั้น\n\n"
            f"⚠️ ความยาวคำตอบ: ตอบให้ครบถ้วน ไม่สั้นเกินไป ไม่ยาวเกินไป "
            f"ประมาณ 2-3 บรรทัด (60-120 คำ) — อย่าตอบแค่ 1 ประโยคสั้นๆ "
            f"ถ้ามีข้อมูลที่เป็นประโยชน์ให้ตอบครบ พร้อมรายละเอียดที่เกี่ยวข้อง "
            f"แต่ไม่ต้องยาวจนเกินไป เช่น ถ้าลูกค้าถาม 'สายนาฬิกาเปลี่ยนได้ไหม' "
            f"ให้ตอบว่าเปลี่ยนได้ไหม + ขนาดสาย + วิธีเปลี่ยนเบื้องต้น ไม่ใช่ตอบแค่ 'เปลี่ยนได้ค่ะ'"
        )

        # call OpenRouter
        t0 = time.time()
        result = call_openrouter(system_instruction, user_prompt, history, OPENROUTER_MODEL)
        llm_time = time.time() - t0

        prompt_t = result["prompt_tokens"]
        output_t = result["output_tokens"]
        cost = result["cost_usd"]
        cost_thb = cost * 36

        print(f"  LLM: {llm_time:.2f}s  tokens: in={prompt_t} out={output_t}")
        print(f"  Cost: ${cost:.6f} (฿{cost_thb:.4f})")
        print(f"  Answer: {result['answer'][:120]}...")
        print()

        # สะสม history (เหมือน bot)
        history.append({"role": "user", "text": q})
        history.append({"role": "model", "text": result["answer"]})

        total_cost += cost
        total_prompt += prompt_t
        total_output += output_t

    # ─── สรุป ────────────────────────────────────────────────
    print("=" * 60)
    print(f"=== สรุป ===")
    print(f"Model: {OPENROUTER_MODEL}")
    print(f"Questions: {len(QUESTIONS)}")
    print(f"Total tokens: in={total_prompt}  out={total_output}  total={total_prompt + total_output}")
    print(f"Total cost: ${total_cost:.6f} (฿{total_cost * 36:.4f})")
    print(f"Avg cost/question: ${total_cost / len(QUESTIONS):.6f} (฿{total_cost * 36 / len(QUESTIONS):.4f})")
    print()

    # เทียบกับ Gemini ตรงๆ (จาก session log)
    gemini_total = 0.007968 + 0.008566 + 0.003979 + 0.003730 + 0.003506 + 0.005912 + 0.004291 + 0.004592
    print(f"=== เทียบกับ Gemini ตรงๆ (จาก session log) ===")
    print(f"Gemini total: ${gemini_total:.6f} (฿{gemini_total * 36:.4f})")
    print(f"OpenRouter total: ${total_cost:.6f} (฿{total_cost * 36:.4f})")
    diff = total_cost - gemini_total
    print(f"ส่วนต่าง: ${diff:+.6f} (฿{diff * 36:+.4f})")
    if gemini_total > 0:
        pct = (diff / gemini_total) * 100
        print(f"เปลี่ยนแปลง: {pct:+.1f}%")


if __name__ == "__main__":
    main()
