"""เรียก Gemini (google-genai SDK) พร้อม context สินค้า.

รับ product cards ที่กรองแล้วจาก product_store มา pack เป็น context
ส่งเข้า Gemini พร้อม system instruction ที่อธิบายบทบาทแชทบอท
และกฎการตอบเรื่องสินค้า/เปรียบเทียบ/แนะนำ/เคลม-รับประกัน.
"""

from __future__ import annotations

import json
import os
from typing import Any

from google import genai
from google.genai import errors as genai_errors  # type: ignore


SYSTEM_INSTRUCTION = """คุณเป็นผู้ช่วยขายและที่ปรึกษาสินค้าให้กับกลุ่มร้านค้าออนไลน์ในเครือเครือข่ายเรา
(ร้านในเครือทั้งหมด เช่น ThaiSuperPhone, YoupinOfficialStore, XiaomiEcoSystem, SuperITMall,
KingGadgets, IMILabThailand, ZMIThailand, 70MaiOfficialStore ฯลฯ — ดูร้านจริงจาก field `shop` ใน context).

หน้าที่ของคุณ:
1. ตอบคำถามลูกค้าเกี่ยวกับสินค้า (ราคา, สเปก, รุ่นย่อย, ตัวเลือก, ขนาด/น้ำหนัก, การขนส่ง)
2. เปรียบเทียบสินค้า 2 รายการขึ้นไป ทั้งราคา คุณสมบัติ รับประกัน และเหมาะกับการใช้งานแบบไหน
3. แนะนำสินค้าที่เหมาะกับความต้องการ/งบประมาณของลูกค้า
4. อธิบายเรื่องการเคลมและการรับประกัน: ประเภทรับประกัน (Warranty Type), ระยะเวลา (Warranty Duration),
   ช่องทางติดต่อศูนย์บริการ โดยอ้างอิงจาก field `warranty` และ `description_excerpt` ของสินค้านั้น

กฎการตอบ:
- ตอบเป็นภาษาเดียวกับลูกค้า (ส่วนใหญ่คือภาษาไทย) สุภาพ เป็นมิตร กระชับ
- อ้างอิงเฉพาะข้อมูลใน context ที่ให้มาในรอบนี้เท่านั้น ห้าม invent ราคา/สเปก/รับประกันที่ไม่มี
- **สำคัญ**: context ที่ให้ในรอบปัจจุบันคือข้อมูลสินค้าล่าสุดเท่านั้น อย่าอ้างอิงสินค้าจากคำตอบก่อนหน้า
  ถ้า context รอบนี้มีสินค้ารุ่นที่ลูกค้าถาม ให้ตอบจาก context รอบนี้เท่านั้น ไม่ว่าคำตอบก่อนหน้าจะเคยพูดถึงสินค้าอะไรก็ตาม
- ถ้า context ไม่พอตอบ ให้บอกตรงๆ ว่าขอแนะนำให้ทักแอดมินร้าน หรือขอข้อมูลเพิ่มเติม
- **ถ้าลูกค้าระบุงบประมาณ/ช่วงราคา แต่ใน context มีสินค้าประเภทนั้นที่ราคาใกล้เคียง (แม้ไม่ตรงช่วง)**:
  ให้บอกลูกค้าว่าไม่มีในงบที่ระบุ แล้ว **เสนอสินค้าที่ถูกที่สุดหรือใกล้เคียงที่สุดจาก context** พร้อมราคาและรายละเอียด
  อย่าตอบสั้นๆ ว่า "ไม่มี" แล้วจบ — ต้องเสนอทางเลือกเสมอ
- เมื่อเสนอสินค้า ให้ระบุ: ชื่อสินค้า, ร้าน (shop), ราคา (ถ้ามี), รับประกัน (ถ้ามี), และ short_link
- หากเปรียบเทียบสินค้า 2 รายการขึ้นไป ให้ทำเป็น **ตาราง markdown** (ใช้ syntax `| คอลัมน์ | คอลัมน์ |` พร้อม header separator) เทียบกันชัดเจน
  คอลัมน์ที่แนะนำ: ชื่อสินค้า, ร้าน, ราคา, คุณสมบัติเด่น, รับประกัน, ลิงก์ — เลือกให้เหมาะกับคำถาม
- หากลูกค้าถามเรื่องเคลม/รับประกัน ให้ย้ำช่องทางติดต่อและระยะเวลารับประกันที่พบใน context
- ราคาที่แสดงเป็น THB ถ้า field `price` ว่าง หมายถึงไม่มีข้อมูลราคา อย่าเดา
- อย่าเสนอสินค้าที่ status != "NORMAL" ให้ลูกค้า (ยกเว้นตอบคำถามเคลมของสินค้าเดิม)

การแสดงรูปสินค้า (สำคัญ):
- เมื่อแนะนำ/เสนอสินค้ารายใด ให้แทกรูปของสินค้านั้นด้วย markdown image syntax:
  `![ชื่อสั้น](image_url)`
  โดยใช้ค่าจาก field `image_url` ใน product card ของสินค้านั้น
- **สำคัญ**: alt text (ข้อความใน `[...]`) ต้องเป็นชื่อสินค้าสั้นๆ เช่น "Xiaomi Redmi 9" หรือ "Redmi Note 11"
  ห้ามใช้ชื่อสินค้าเต็มที่มีวงเล็บเหลี่ยม `[...]` ข้างใน เพราะจะทำให้รูปไม่ขึ้น
  ตัวอย่างที่ผิด: `![[ลดเหลือ 3,599 บ.] Xiaomi Redmi 9](url)`
  ตัวอย่างที่ถูก: `![Xiaomi Redmi 9](url)`
- ถ้า `image_url` ว่าง ข้ามการแทกรูปไปได้เลลย ห้ามเดา URL รูปเอง
- วางรูปไว้ใต้ชื่อสินค้านั้น (ก่อนรายละเอียด/ราคา) หรือหลังบรรทัดแนะนำของสินค้านั้น
- ถ้าเป็นการเปรียบเทียบแบบตาราง ไม่ต้องใส่รูปในตาราง แต่ใส่รูปแยกใต้ตารางเรียงต่อกันได้เลย
- อย่าแทกรูปเกิน 1 รูปต่อสินค้า
"""


def _client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY ไม่ถูกตั้งใน .env")
    return genai.Client(api_key=api_key)


def _build_context(products: list[dict], shop_hint: str | None = None,
                    include_description: bool = False) -> str:
    """pack product cards เป็น context text สำหรับใส่ใน prompt.

    ตัด field ที่ไม่จำเป็นออกเพื่อลด token:
    - description_excerpt ส่งเฉพาะตอน include_description=True (เช่น ถามเรื่องรับประกัน)
    - weight/dimension ส่งเฉพาะตอน include_description=True
    """
    if not products:
        body = "ไม่พบสินค้าที่ตรงกับคำถามในฐานข้อมูล"
    else:
        slim_fields = (
            "name", "shop", "price", "warranty", "short_link", "image_url",
            "has_promotion", "is_flash_sale", "variants", "tier_variation",
            "brand", "category",
        )
        slim = []
        for p in products:
            card = {k: p[k] for k in slim_fields if k in p}
            # ใส่ _context_note ถ้ามี (fallback note)
            if "_context_note" in p:
                card["_context_note"] = p["_context_note"]
            # ใส่ description/weight/dimension เฉพาะตอนจำเป็น
            if include_description:
                if "description_excerpt" in p:
                    card["description_excerpt"] = p["description_excerpt"]
                if "weight" in p:
                    card["weight"] = p["weight"]
                if "dimension" in p:
                    card["dimension"] = p["dimension"]
            slim.append(card)
        body = json.dumps(slim, ensure_ascii=False, indent=2)
    header = "ข้อมูลสินค้าที่เกี่ยวข้อง (จาก MongoDB ของร้านในเครือ):\n"
    if shop_hint:
        header += f"ลูกค้าทักจากร้าน: {shop_hint}\n"
    header += f"จำนวนสินค้าใน context: {len(products)}\n\n"
    return header + body


def answer(
    message: str,
    products: list[dict],
    shop_hint: str | None = None,
    history: list[dict] | None = None,
    model: str | None = None,
) -> str:
    """สร้างคำตอบจาก Gemini โดยใช้ products เป็น context.

    Args:
        message: คำถามลูกค้ารอบปัจจุบัน
        products: product cards ที่กรองแล้ว
        shop_hint: ชื่อร้านที่ลูกค้าทักเข้ามา (ถ้ามี)
        history: ประวัติแชทก่อนหน้า [{"role":"user","text":"..."},{"role":"model","text":"..."}]
        model: ชื่อโมเดล Gemini (default จาก env GEMINI_MODEL หรือ gemini-2.0-flash)
    """
    client = _client()
    model_name = (model or os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")).strip()

    # ตรวจว่าคำถามเกี่ยวกับรับประกัน/เคลมไหม ถ้าใช่ส่ง description ให้ LLM ด้วย
    warranty_kw = ("รับประกัน", "ประกัน", "เคลม", "warranty", "claim", "ศูนย์", "ซ่อม", "เปลี่ยน")
    include_desc = any(kw in message.lower() for kw in warranty_kw)

    context = _build_context(products, shop_hint=shop_hint,
                             include_description=include_desc)
    user_prompt = f"{context}\n\nคำถามของลูกค้า: {message}"

    contents: list[Any] = []
    if history:
        for h in history:
            role = h.get("role", "user")
            text = h.get("text", "")
            if role not in ("user", "model"):
                role = "user"
            contents.append({"role": role, "parts": [{"text": text}]})
    contents.append({"role": "user", "parts": [{"text": user_prompt}]})

    try:
        resp = client.models.generate_content(
            model=model_name,
            contents=contents,
            config={
                "system_instruction": SYSTEM_INSTRUCTION,
                "temperature": 0.3,
                "max_output_tokens": 4096,
            },
        )
    except genai_errors.ClientError as exc:
        return f"ขออภัย ระบบ LLM ติดขัด ลองใหม่อีกครั้ง ({exc})"
    except Exception as exc:
        return f"ขออภัย เกิดข้อผิดพลาดในการเรียก LLM ({exc})"

    # log token usage (ถ้ามี) เพื่อคำนวณต้นทุน
    usage = getattr(resp, "usage_metadata", None)
    if usage:
        prompt_t = getattr(usage, "prompt_token_count", 0) or 0
        output_t = getattr(usage, "candidates_token_count", 0) or 0
        total_t = getattr(usage, "total_token_count", 0) or (prompt_t + output_t)
        print(f"[LLM] model={model_name}  prompt={prompt_t}  output={output_t}  total={total_t}  products={len(products)}")

    return (resp.text or "").strip()
