#!/usr/bin/env python3
"""เปรียบเทียบ 3 แบบ: Legacy, chat_v2, Experimental flow.

Legacy + chat_v2: call /chat API ปกติ
Experimental: LLM1 (list products) → RAG (search DB) → LLM2 (answer + handoff)

Usage:
    cd <repo-root>
    PYTHONPATH=chatbot .venv/bin/python docs/test/test_compare_3way.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import re
import requests

# ── path setup ──
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_CHATBOT = os.path.join(_REPO_ROOT, "chatbot")
if _CHATBOT not in sys.path:
    sys.path.insert(0, _CHATBOT)

from shopeechat import knowledge_base, product_store, persona, llm

knowledge_base._load_env()

# ── config ──
BOT_URL = "http://127.0.0.1:8010"
SHOP = "KingGadgets"
PLATFORM = "shopee"
LIMIT = 5
OUTPUT_DIR = os.path.join(_REPO_ROOT, "docs", "test", "results")
os.makedirs(OUTPUT_DIR, exist_ok=True)

QUESTIONS = [
    "มีหัวชาร์จไหม",
    "มีสายชาร์จไหม",
    "มีหัวชาร์จพร้อมสายชาร์จไหม",
    "มีหัวชาร์จในรถไหม",
    "มีหัวชาร์จใช้กับ iphone 17 promaxไหม",
    "แล้วสายละ มีไหมแนะนำหน่อย",
    "แล้วถ้าใช้กับ mi 17 ultra ละมีไหม หัวอะ",
    "แล้วสายอะมีไหม",
    "แล้วถ้าผมเอาไปใช้กับ mac air m5 ใช้ได้ไหม",
    "พาวเวอร์แบงค์อะมีไหมใช้กับ mi 17 ultra กับ mac air m5",
    "แล้วมันใช้กับ iphone 4s ได้ไหมอะ",
    "ctc615",
    "สายมีปัญหา",
    "สายกาก",
    "ไม่ไหว ใช้ได้ไหมเยี่ย",
    "จะคุยกับคน",
    "ไม่โอเคเอาคนมาคุยดิ",
]

# ── test-chat session titles ──
SESSION_TITLES = {
    "legacy": "legacy เองฮ้าฟ",
    "v2": "botv2 /รวยไม่ไหวแล้ว",
    "exp": "exp search→rag→llm2",
}


# ── Experimental flow ──────────────────────────────────────────────────────

_EXP_SEARCH_SYSTEM = """\
คุณเป็น AI วิเคราะห์คำถามลูกค้าในแชทร้านค้าออนไลน์ (Shopee)
หน้าที่ของคุณคือวิเคราะห์คำถามลูกค้าให้ละเอียดที่สุด เพื่อใช้ค้นหาสินค้าในฐานข้อมูลร้าน

กฎสำคัญ:
- ตอบในรูปแบบที่กำหนดให้เท่านั้น ห้ามเพิ่ม section อื่น
- ลิสต์คำค้นหาที่เป็นไปได้มากที่สุด เอาให้ครอบคลุม
- ถ้าไม่แน่ใจ ให้ใส่คำที่ใกล้เคียงด้วย อย่าตอบมั่ว
- แยกแต่ละคำค้นหาเป็นบรรทัด พร้อมคำอธิบายสั้นๆ ว่าทำไมเลือกคำนี้
- คำอธิบายความเข้าใจต้องอ้างอิง history ถ้าจำเป็น
- ถ้าลูกค้าต้องการคุยกับคน/ไม่พอใจ/บ่น → บอก "ใช่" ใน section ต้องการแอดมิน
- ถ้าเป็นการทักทาย/คุยเล่น → คำค้นหาสินค้าเป็น list ว่างได้
"""

_EXP_SEARCH_PROMPT = """\
คุณคือ AI วิเคราะห์คำถามลูกค้าในแชท Shopee ร้าน {shop} (แพลตฟอร์ม {platform})
บุคลิกบอท: {persona}

ประวัติแชท:
{history}

คำถามลูกค้าตอนนี้: {message}

งานของคุณ: วิเคราะห์คำถามนี้ให้ละเอียดที่สุด แล้วตอบในรูปแบบนี้เท่านั้น:

=== คำอธิบายความเข้าใจ ===
อธิบายว่าคุณเข้าใจว่าลูกค้าต้องการถามอะไร อ้างอิง history ถ้าจำเป็น
(เขียนเป็นบริบท 2-4 ประโยค)

=== คำค้นหาสินค้า ===
ลิสต์คำค้นหาสินค้าที่เป็นไปได้มากที่สุดที่จะใช้ค้นในฐานข้อมูลสินค้าร้าน
เอาให้มั่นใจ อย่าตอบมั่ว — ถ้าไม่แน่ใจให้ใส่คำที่ใกล้เคียงด้วย
แยกแต่ละคำเป็นบรรทัด พร้อมคำอธิบายสั้นๆ ว่าทำไมเลือกคำนี้

รูปแบบ:
- <คำค้น> : <เหตุผล>
- <คำค้น> : <เหตุผล>

=== ประเภทสินค้า ===
(บอกประเภท: charger|cable|set|car_charger|powerbank|earphone|phone|smartwatch|other)

=== อุปกรณ์เป้าหมาย ===
(ถ้าลูกค้าระบุอุปกรณ์ เช่น iPhone 17 ProMax, Xiaomi 17 Ultra — บอกชื่อเต็ม
ถ้าไม่ระบุ บอก "ไม่ระบุ")

=== ต้องการแอดมิน ===
(ถ้าลูกค้าต้องการคุยกับคน/ไม่พอใจ/บ่น บอก "ใช่" มิฉะนั้น "ไม่")
"""

def _call_llm(prompt: str, system_instruction: str = "") -> str:
    """Call Gemini directly (สำหรับ LLM1 analysis step เท่านั้น)."""
    try:
        client = llm._client()
        model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite").strip()
        kwargs = {"model": model_name, "contents": prompt}
        if system_instruction:
            kwargs["config"] = {"system_instruction": system_instruction}
        resp = client.models.generate_content(**kwargs)
        return resp.text or ""
    except Exception as e:
        return f"ERROR: {e}"


def _format_history(history: list[dict]) -> str:
    """Format history สำหรับส่งให้ LLM — เอา 10 คู่ถามตอบล่าสุด (20 entries)."""
    if not history:
        return "(ยังไม่มีประวัติ)"
    lines = []
    # 10 ถามตอบ = 20 entries (ถาม 1 + ตอบ 1 = 1 คู่)
    for h in history[-20:]:
        role = "ลูกค้า" if h["role"] == "user" else "บอท"
        lines.append(f"{role}: {h['text'][:200]}")
    return "\n".join(lines)


def _get_persona_doc(shop: str) -> dict | None:
    """ดึง persona doc จริงจาก DB (เหมือนที่ app.py / chat_v2.py ทำ)."""
    return persona.get_persona(shop, "shopee")


def _build_persona_extra(persona_doc: dict | None, shop: str) -> str:
    """สร้าง persona_extra เหมือนที่ app.py / chat_v2.py ทำ."""
    return persona.build_persona_instruction(persona_doc, shop)


def _parse_search_output(raw: str) -> dict:
    """Parse output จาก step search (LLM1) ที่เป็น text ไม่ใช่ JSON.

    คืน: {
        "understanding": str,       # คำอธิบายความเข้าใจ
        "keywords": list[str],      # คำค้นหาสินค้า
        "product_type": str,        # ประเภทสินค้า
        "target_device": str,       # อุปกรณ์เป้าหมาย
        "needs_human": bool,        # ต้องการแอดมินไหม
    }
    """
    understanding = ""
    keywords: list[str] = []
    product_type = "other"
    target_device = "ไม่ระบุ"
    needs_human = False

    # แยก section ด้วย ===
    sections = re.split(r"===\s*(.+?)\s*===", raw)
    # sections = ["", "คำอธิบายความเข้าใจ", "...\n", "คำค้นหาสินค้า", "...\n", ...]
    section_map = {}
    for i in range(1, len(sections) - 1, 2):
        title = sections[i].strip()
        body = sections[i + 1].strip()
        section_map[title] = body

    if "คำอธิบายความเข้าใจ" in section_map:
        understanding = section_map["คำอธิบายความเข้าใจ"]

    if "คำค้นหาสินค้า" in section_map:
        # แยกแต่ละบรรทัดที่ขึ้นต้นด้วย - แล้วเอาคำก่อน :
        for line in section_map["คำค้นหาสินค้า"].split("\n"):
            line = line.strip()
            if line.startswith("-"):
                # "- <คำ> : <เหตุผล>"
                kw_part = line[1:].split(":")[0].strip()
                if kw_part:
                    keywords.append(kw_part)

    if "ประเภทสินค้า" in section_map:
        product_type = section_map["ประเภทสินค้า"].strip().lower()

    if "อุปกรณ์เป้าหมาย" in section_map:
        td = section_map["อุปกรณ์เป้าหมาย"].strip()
        if td and td != "ไม่ระบุ":
            target_device = td

    if "ต้องการแอดมิน" in section_map:
        needs_human = "ใช่" in section_map["ต้องการแอดมิน"].strip()

    return {
        "understanding": understanding,
        "keywords": keywords,
        "product_type": product_type,
        "target_device": target_device,
        "needs_human": needs_human,
    }


def experimental_flow(message: str, history: list[dict], shop: str, platform: str) -> dict:
    """Experimental: search (LLM1 วิเคราะห์) → RAG (ค้น DB) → LLM2 (llm.answer จริง).

    Step 1 "search": LLM รับ info เหมือน LLM2 (message + history + persona)
             สั่งให้ list คำตอบที่เป็นไปได้มากที่สุด + แยกคำ + เขียนคำอธิบายความเข้าใจ
    Step 2 "RAG": เอา keywords จาก search ไปค้นใน product collection
    Step 3 "LLM2": llm.answer() จริง (มี SYSTEM_INSTRUCTION เต็ม + persona_extra)
             พร้อม extra_context ที่ mark ว่า "อ่านทีหลังถ้าไม่มั่นใจ"
    handoff ตัดสินที่ LLM2 ไม่ใช่ LLM1
    """
    _t0 = time.time()

    # ── persona (เหมือนที่ app.py / chat_v2.py ทำ) ──
    persona_doc = _get_persona_doc(shop)
    persona_extra = _build_persona_extra(persona_doc, shop)
    persona_text = f"ชื่อบอท: {persona_doc['bot_name']}\nหมายเหตุ: {persona_doc.get('notes', '')}" if persona_doc and persona_doc.get("bot_name") else "ชื่อบอท: แอดมิน\nหมายเหตุ: (default)"

    # ── Step 1: search — LLM วิเคราะห์คำถาม + list keywords + อธิบายความเข้าใจ ──
    search_prompt = _EXP_SEARCH_PROMPT.format(
        shop=shop, platform=platform, persona=persona_text,
        history=_format_history(history), message=message,
    )
    search_raw = _call_llm(
        search_prompt,
        system_instruction=llm.SYSTEM_INSTRUCTION + "\n" + _EXP_SEARCH_SYSTEM,
    )
    search_parsed = _parse_search_output(search_raw)

    understanding = search_parsed["understanding"]
    keywords = search_parsed["keywords"]
    target_device = search_parsed["target_device"]
    needs_human = search_parsed["needs_human"]

    # ── Step 2: RAG — ค้น DB ด้วย keywords จาก search ──
    products: list[dict] = []

    if not needs_human and keywords:
        client = product_store.get_client()
        db_name = os.environ.get("MONGO_DB", "dbWallet")
        db = client[db_name]

        # Try MODEL-REGEX first (เหมือนที่ chat_v2 ทำ)
        for kw in keywords[:5]:
            model_kws = re.findall(r"[A-Za-z]+\d+[A-Za-z]*", kw)
            model_kws = [w for w in model_kws if len(w) >= 4]
            if model_kws:
                mkw = model_kws[0].lower()
                alpha = re.match(r"[A-Za-z]+", mkw).group(0)
                rest = mkw[len(alpha):]
                if rest:
                    pattern = re.escape(alpha) + r".?\s?" + re.escape(rest)
                else:
                    pattern = re.escape(mkw[:6])
                try:
                    coll = db[os.environ.get("MONGO_COLLECTION", "ShpProducts")]
                    docs = list(coll.find(
                        {"item_name": {"$regex": pattern, "$options": "i"},
                         "shopname": {"$regex": f"^{re.escape(shop)}$", "$options": "i"}},
                        product_store.PRODUCT_PROJECTION
                    ).limit(5))
                    if docs:
                        products = [product_store.to_product_card(d, message) for d in docs]
                        break
                except Exception:
                    pass

        # Fallback: fetch_products with keywords
        if not products:
            search_msg = " ".join(keywords[:5])
            if target_device and target_device != "ไม่ระบุ":
                search_msg = f"{search_msg} {target_device}"
            try:
                products = product_store.fetch_products(
                    db, message=search_msg, shop_filter=shop, limit=LIMIT,
                )
            except Exception:
                products = []

        # Filter: only NORMAL for recommendations
        products = [p for p in products if p.get("status") == "NORMAL"]

    # ── Step 3: LLM2 — llm.answer() จริง + extra_context จาก search ──
    # mark ว่า "อ่านทีหลังถ้าไม่มั่นใจ" ตามที่คุณบอก
    extra_context = ""
    if understanding:
        extra_context = (
            "=== บริบทจากการวิเคราะห์คำถาม (อ่านทีหลังถ้าไม่มั่นใจคำตอบ — ถ้ามั่นใจแล้วตอบเลย) ===\n"
            f"{understanding}\n"
        )
        if target_device and target_device != "ไม่ระบุ":
            extra_context += f"อุปกรณ์เป้าหมายที่ลูกค้าระบุ: {target_device}\n"

    answer_text, usage_info = llm.answer(
        message=message,
        products=products,
        shop_hint=shop,
        history=history,
        persona_extra=persona_extra,
        extra_context=extra_context,
    )

    # handoff detection — ตัดสินที่ LLM2 ไม่ใช่ LLM1
    # ตรวจคำตอบ LLM2 ว่าพูดเรื่องส่งแอดมินไหม
    handoff = False
    handoff_reason = ""
    _handoff_kw = ("ส่งต่อแอดมิน", "ส่งแอดมิน", "แอดมินดูแล", "แอดมินเข้ามา", "จะส่งเรื่องให้แอดมิน", "แอดมินมาดูแล")
    if any(kw in answer_text for kw in _handoff_kw):
        handoff = True
        handoff_reason = "LLM2 ตอบเกี่ยวกับส่งแอดมิน"

    elapsed = round(time.time() - _t0, 2)

    return {
        "answer": answer_text,
        "products": len(products),
        "product_names": [p.get("name", "?")[:50] for p in products[:5]],
        "source": "experimental",
        "elapsed": elapsed,
        "understanding": understanding[:200],
        "target_device": target_device,
        "keywords": keywords,
        "handoff": handoff,
        "handoff_reason": handoff_reason,
        "tokens": usage_info.get("total", 0),
        "search_raw": search_raw[:400],
    }


# ── Legacy + chat_v2 (call API) ────────────────────────────────────────────

def call_bot_api(message: str, history: list[dict], use_v2: bool) -> dict:
    """Call /chat API."""
    body = {
        "message": message,
        "history": history,
        "shop": SHOP,
        "limit": LIMIT,
    }
    # บังคับ legacy/v2 จริง ไม่อิง config — ส่ง use_v2 เสมอ
    body["use_v2"] = use_v2

    try:
        resp = requests.post(f"{BOT_URL}/chat", json=body, timeout=90)
        if resp.ok:
            d = resp.json()
            return {
                "answer": d.get("answer", ""),
                "products": len(d.get("products", [])),
                "product_names": [p.get("name", "?")[:50] for p in d.get("products", [])[:5]],
                "source": d.get("source", "?"),
                "elapsed": d.get("elapsed", 0),
                "chat_engine": d.get("chat_engine", "?"),
                "handoff": d.get("handoff_to_admin", False),
                "handoff_reason": d.get("handoff_reason", ""),
                "error": None,
            }
        else:
            return {"answer": f"HTTP {resp.status_code}", "products": 0, "product_names": [],
                    "source": "error", "elapsed": 0, "chat_engine": "?",
                    "handoff": False, "handoff_reason": "", "error": resp.text[:200]}
    except Exception as e:
        return {"answer": f"ERROR: {e}", "products": 0, "product_names": [],
                "source": "error", "elapsed": 0, "chat_engine": "?",
                "handoff": False, "handoff_reason": "", "error": str(e)}


# ── test-chat session helpers ──────────────────────────────────────────────

def create_testchat_session(title: str, shop: str = SHOP) -> str | None:
    """สร้าง test-chat session ผ่าน API แล้วคืน session_id.

    ตั้ง source=script_test ผ่าน field ใน body เพื่อให้ทุก admin เห็นได้
    (list_test_chat_sessions แสดง source=script_test ให้ทุกคน)
    """
    try:
        r = requests.post(
            f"{BOT_URL}/test-chat/sessions",
            json={"shop": shop, "title": title, "source": "script_test"},
            timeout=15,
        )
        if r.ok:
            return r.json().get("id")
        print(f"  [testchat] create session failed: {r.status_code} {r.text[:100]}")
    except Exception as e:
        print(f"  [testchat] create session error: {e}")
    return None


def add_testchat_message(session_id: str, role: str, text: str, stats: dict | None = None) -> bool:
    """เพิ่ม message ลง test-chat session ผ่าน API."""
    if not session_id:
        return False
    try:
        body = {
            "session_id": session_id,
            "message": {
                "role": role,
                "text": text,
                "stats": stats or {},
            },
        }
        r = requests.post(
            f"{BOT_URL}/test-chat/sessions/{session_id}/messages",
            json=body,
            timeout=15,
        )
        return r.ok
    except Exception as e:
        print(f"  [testchat] add message error: {e}")
        return False


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    print(f"=== 3-Way Compare Test ===")
    print(f"Shop: {SHOP} | Platform: {PLATFORM}")
    print(f"Questions: {len(QUESTIONS)}")
    print()

    # ── สร้าง test-chat sessions สำหรับ 3 โหมด ──
    print("Creating test-chat sessions...")
    sess_legacy = create_testchat_session(SESSION_TITLES["legacy"])
    sess_v2 = create_testchat_session(SESSION_TITLES["v2"])
    sess_exp = create_testchat_session(SESSION_TITLES["exp"])
    print(f"  legacy session: {sess_legacy}")
    print(f"  v2 session:     {sess_v2}")
    print(f"  exp session:     {sess_exp}")
    print()

    # 3 separate histories
    hist_legacy: list[dict] = []
    hist_v2: list[dict] = []
    hist_exp: list[dict] = []

    results = []

    for i, q in enumerate(QUESTIONS, 1):
        print(f"--- Q{i}/{len(QUESTIONS)}: {q} ---")

        # Legacy
        print(f"  [legacy] calling...", end=" ", flush=True)
        r_leg = call_bot_api(q, hist_legacy, use_v2=False)
        print(f"done ({r_leg['elapsed']}s, {r_leg['products']} products)")
        hist_legacy.append({"role": "user", "text": q})
        hist_legacy.append({"role": "model", "text": r_leg["answer"]})
        # save to test-chat session
        add_testchat_message(sess_legacy, "user", q)
        add_testchat_message(sess_legacy, "model", r_leg["answer"], stats={
            "source": r_leg.get("source"), "elapsed": r_leg.get("elapsed"),
            "products": r_leg.get("products"), "chat_engine": r_leg.get("chat_engine"),
            "handoff": r_leg.get("handoff"),
        })

        # chat_v2
        print(f"  [v2] calling...", end=" ", flush=True)
        r_v2 = call_bot_api(q, hist_v2, use_v2=True)
        print(f"done ({r_v2['elapsed']}s, {r_v2['products']} products)")
        hist_v2.append({"role": "user", "text": q})
        hist_v2.append({"role": "model", "text": r_v2["answer"]})
        # save to test-chat session
        add_testchat_message(sess_v2, "user", q)
        add_testchat_message(sess_v2, "model", r_v2["answer"], stats={
            "source": r_v2.get("source"), "elapsed": r_v2.get("elapsed"),
            "products": r_v2.get("products"), "chat_engine": r_v2.get("chat_engine"),
            "handoff": r_v2.get("handoff"),
        })

        # Experimental
        print(f"  [exp] calling...", end=" ", flush=True)
        r_exp = experimental_flow(q, hist_exp, SHOP, PLATFORM)
        print(f"done ({r_exp['elapsed']}s, {r_exp['products']}p, kw={r_exp.get('keywords', [])[:3]})")
        hist_exp.append({"role": "user", "text": q})
        hist_exp.append({"role": "model", "text": r_exp["answer"]})
        # save to test-chat session
        add_testchat_message(sess_exp, "user", q)
        add_testchat_message(sess_exp, "model", r_exp["answer"], stats={
            "source": "experimental", "elapsed": r_exp.get("elapsed"),
            "products": r_exp.get("products"), "tokens": r_exp.get("tokens"),
            "keywords": r_exp.get("keywords"), "target_device": r_exp.get("target_device"),
            "understanding": r_exp.get("understanding"),
            "handoff": r_exp.get("handoff"),
        })

        results.append({
            "i": i,
            "question": q,
            "legacy": r_leg,
            "v2": r_v2,
            "exp": r_exp,
        })

        # Print answers side by side
        print(f"\n  Q{i}: {q}")
        print(f"  [legacy] {r_leg['answer'][:150]}")
        print(f"  [v2]     {r_v2['answer'][:150]}")
        print(f"  [exp]    {r_exp['answer'][:150]}")
        if r_exp.get("understanding"):
            print(f"  [exp understanding] {r_exp['understanding'][:120]}")
        if r_exp.get("keywords"):
            print(f"  [exp keywords] {r_exp['keywords'][:5]}")
        if r_exp.get("handoff") or r_leg.get("handoff") or r_v2.get("handoff"):
            print(f"  [handoff] legacy={r_leg.get('handoff')} v2={r_v2.get('handoff')} exp={r_exp.get('handoff')}")
        print()

    # Save results
    out_file = os.path.join(OUTPUT_DIR, "test_compare_3way.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump({
            "sessions": {
                "legacy": {"id": sess_legacy, "title": SESSION_TITLES["legacy"]},
                "v2": {"id": sess_v2, "title": SESSION_TITLES["v2"]},
                "exp": {"id": sess_exp, "title": SESSION_TITLES["exp"]},
            },
            "shop": SHOP,
            "platform": PLATFORM,
            "questions": len(QUESTIONS),
            "results": results,
        }, f, ensure_ascii=False, indent=2)
    print(f"\nResults saved to: {out_file}")

    # Summary
    print(f"\n=== Summary ===")
    print(f"  Sessions (ดูได้ในหน้า test-chat/shopee):")
    print(f"    legacy: {sess_legacy} — {SESSION_TITLES['legacy']}")
    print(f"    v2:     {sess_v2} — {SESSION_TITLES['v2']}")
    print(f"    exp:    {sess_exp} — {SESSION_TITLES['exp']}")
    print()
    for r in results:
        q = r["question"][:30]
        print(f"  Q{r['i']:2d} {q:30s} | leg={r['legacy']['products']}p v2={r['v2']['products']}p exp={r['exp']['products']}p | "
              f"handoff: leg={r['legacy']['handoff']} v2={r['v2']['handoff']} exp={r['exp'].get('handoff')}")


if __name__ == "__main__":
    main()
