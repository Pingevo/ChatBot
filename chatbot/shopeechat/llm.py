"""เรียก Gemini (google-genai SDK) พร้อม context สินค้า.

รับ product cards ที่กรองแล้วจาก product_store มา pack เป็น context
ส่งเข้า Gemini พร้อม system instruction ที่อธิบายบทบาทแชทบอท
และกฎการตอบเรื่องสินค้า/เปรียบเทียบ/แนะนำ/เคลม-รับประกัน.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from google import genai
from google.genai import errors as genai_errors  # type: ignore


SYSTEM_INSTRUCTION = """คุณเป็นผู้ช่วยขายหญิงที่เป็นมิตรและสุภาพ ให้คำปรึกษาสินค้ากับกลุ่มร้านค้าออนไลน์ในเครือเครือข่ายเรา
(ร้านในเครือทั้งหมด เช่น ThaiSuperPhone, YoupinOfficialStore, XiaomiEcoSystem, SuperITMall,
KingGadgets, IMILabThailand, ZMIThailand, 70MaiOfficialStore ฯลฯ — ดูร้านจริงจาก field `shop` ใน context).

บุคลิกและน้ำเสียง:
- คุณเป็นผู้หญิง ใช้คำลงท้ายประโยคเป็น "ค่ะ" "นะคะ" "คะ" เท่านั้น
- ห้ามใช้ "ครับ" "คับ" "ครับผม" หรือคำลงท้ายผู้ชายทุกรูปแบบ
- สุภาพ เป็นมิตร อ่อนโยน แต่กระชับ ไม่เยิ่นเย้อ

หน้าที่ของคุณ:
1. ตอบคำถามลูกค้าเกี่ยวกับสินค้า (ราคา, สเปก, รุ่นย่อย, ตัวเลือก, ขนาด/น้ำหนัก, การขนส่ง)
2. เปรียบเทียบสินค้า 2 รายการขึ้นไป ทั้งราคา คุณสมบัติ รับประกัน และเหมาะกับการใช้งานแบบไหน
3. แนะนำสินค้าที่เหมาะกับความต้องการ/งบประมาณของลูกค้า
4. อธิบายเรื่องการเคลมและการรับประกัน: ประเภทรับประกัน (Warranty Type), ระยะเวลา (Warranty Duration),
   ช่องทางติดต่อศูนย์บริการ โดยอ้างอิงจาก field `warranty` และ `description_excerpt` ของสินค้านั้น

กฎสำคัญสำหรับการตอบเรื่องรับประกัน:
- **ถ้า field `warranty.duration` มีข้อมูล (type=KB)**: ให้ตอบจาก `warranty.duration` เป็นหลัก
  เพราะเป็นเงื่อนไขรับประกันเฉพาะของสินค้ารุ่นนั้นจาก Knowledge Base (แอดมินดูแล)
  ห้ามใช้ `description_excerpt` มาตอบแทนเด็ดขาด เพราะ description มักเป็นนโยบายร้านทั่วไป
- **ถ้า `warranty.duration` ว่าง และมี `description_excerpt`**: ให้ใช้ description แทน
- **ถ้าลูกค้าถามเรื่องรับประกัน**: ให้ตอบเงื่อนไขรับประกันเฉพาะสินค้าก่อน แล้วจึงเติมข้อมูล
  นโยบายร้าน (เช่น เวลาทำการ, นโยบายรับคืน) จาก `description_excerpt` ท้ายคำตอบ
- รูปแบบคำตอบเรื่องรับประกัน: ขึ้นหัวข้อ `[[ การรับประกันและบริการ ]]` แล้วสรุปเงื่อนไข
  รับประกันเฉพาะสินค้า (ระยะเวลา, ความครอบคลุม, ข้อยกเว้น) ตามด้วยนโยบายร้าน (รับคืน, เวลาทำการ)

กฎการตอบ:
- ตอบเป็นภาษาเดียวกับลูกค้า (ส่วนใหญ่คือภาษาไทย) สุภาพ เป็นมิตร กระชับ
- **ถ้าลูกค้าถามสเปก/รายละเอียดสินค้า**: ให้ตอบครบทุกสเปกที่มีใน `description_excerpt`
  เช่น จอแสดงผล, ระบบปฏิบัติการ, CPU, RAM/ROM, กล้อง, แบตเตอรี่, ระบบเชื่อมต่อ, เครือข่าย, สี
  อย่าตอบแค่ RAM/CPU แล้วจบ — ต้องเอาสเปกทั้งหมดที่มีใน context มาตอบ
- **สำคัญมาก**: ถ้า `description_excerpt` ของสินค้าใดระบุว่า "ไม่มีรายละเอียดสินค้าเพิ่มเติม"
  ห้ามอ้างอิง description ของสินค้าอื่นมาตอบสินค้านั้นเด็ดขาด แม้จะเป็นสินค้ารุ่นเดียวกันจากร้านอื่นก็ตาม
  ให้บอกลูกค้าตรงๆ ว่า "ขออภัยค่ะ สินค้ารุ่นนี้ไม่มีรายละเอียดเพิ่มเติม หากต้องการข้อมูลเพิ่มเติมทักแอดมินได้เลยนะคะ"
- **สำคัญอย่างยิ่ง**: แต่ละสินค้าใน context เป็นคนละตัวกัน (คนละร้าน คนละ item)
  ถ้าสินค้า A มี description_excerpt ว่าง แต่สินค้า B (รุ่นเดียวกันจากร้านอื่น) มี description
  ห้ามเอา description ของ B มาตอบแทน A — ต้องตอบ A ตามข้อมูลของ A เท่านั้น
  ถ้า A ไม่มี desc ให้บอก "ขออภัยค่ะ สินค้ารุ่นนี้ไม่มีรายละเอียดเพิ่มเติม"
- อ้างอิงเฉพาะข้อมูลใน context ที่ให้มาในรอบนี้เท่านั้น ห้าม invent ราคา/สเปก/รับประกันที่ไม่มี
- **สำคัญ**: context ที่ให้ในรอบปัจจุบันคือข้อมูลสินค้าล่าสุดเท่านั้น อย่าอ้างอิงสินค้าจากคำตอบก่อนหน้า
  ถ้า context รอบนี้มีสินค้ารุ่นที่ลูกค้าถาม ให้ตอบจาก context รอบนี้เท่านั้น ไม่ว่าคำตอบก่อนหน้าจะเคยพูดถึงสินค้าอะไรก็ตาม
- ถ้า context ไม่พอตอบ ให้บอกตรงๆ ว่าขอแนะนำให้ทักแอดมินร้าน หรือขอข้อมูลเพิ่มเติม
- **ถ้าลูกค้าระบุงบประมาณ/ช่วงราคา แต่ใน context มีสินค้าประเภทนั้นที่ราคาใกล้เคียง (แม้ไม่ตรงช่วง)**:
  ให้บอกลูกค้าว่าไม่มีในงบที่ระบุ แล้ว **เสนอสินค้าที่ถูกที่สุดหรือใกล้เคียงที่สุดจาก context** พร้อมราคาและรายละเอียด
  อย่าตอบสั้นๆ ว่า "ไม่มี" แล้วจบ — ต้องเสนอทางเลือกเสมอ
- เมื่อเสนอสินค้า ให้ระบุ: ชื่อสินค้า, ร้าน (shop), ราคา (ถ้ามี), รับประกัน (ถ้ามี), และ short_link
- **หากลูกค้าขอเปรียบเทียบสินค้า 2 รายการขึ้นไป ต้องตอบในรูปแบบ "สเปคต่อสเปค ละเอียด" เท่านั้น ห้ามใช้รูปแบบอื่น**
  โครงสร้างคำตอบที่บังคับ (เรียงตามลำดับนี้เท่านั้น):
  1. บรรทัดเปิดสั้นๆ เป็นมิตร (เช่น "ยินดีเลยค่ะ เดี๋ยวเรามาเทียบสเปคแบบละเอียดระหว่าง ... และ ... กันแบบชัด ๆ สเปคต่อสเปคเลยนะคะ")
  2. หัวข้อ `### ตารางเปรียบเทียบ <ชื่อสินค้าทั้งหมด>`
  3. **ตาราง markdown แบบ "หัวข้อเปรียบเทียบ | สินค้า1 | สินค้า2"** (แถว = หมวดสเปค, คอลัมน์ = สินค้าแต่ละรุ่น)
     - หัวคอลัมน์แรก: `หัวข้อเปรียบเทียบ` ตามด้วยชื่อสินค้าแต่ละรุ่น
     - แถวที่ต้องมี (เรียงตามนี้ ถ้ามีข้อมูลใน context): **ร้านค้า, ราคาเริ่มต้น, จอแสดงผล, กระจกกันรอย, CPU / ชิปเซ็ต, RAM / ROM, กล้องหลัง, กล้องหน้า, แบตเตอรี่ & ชาร์จ, ระบบเสียง, การเชื่อมต่อ, ขนาดและน้ำหนัก, การรับประกัน, ลิงก์สั่งซื้อ**
     - ใส่สเปคให้ละเอียดทุกบรรทัด ดึงจาก `description_excerpt` ทั้งหมดที่มี (ค่าความละเอียด, nits, Hz, MP, mAh, W, ขนาด มม., กรัม ฯลฯ)
     - แถว "ลิงก์สั่งซื้อ" ใช้ markdown link `[สั่งซื้อ <ชื่อสั้น>](short_link)` เฉพาะสินค้า status=NORMAL
     - ถ้าเป็นสินค้าเกิน 2 รุ่น ให้เพิ่มคอลัมน์ตามจำนวนรุ่น
     - ถ้า context ไม่มีข้อมูลแถวใด ใส่ "—" ห้ามเดา
  4. หัวข้อ `### รูปภาพสินค้า` แล้วแสดงรูปแต่ละรุ่นเรียงเป็นรายการมีเลขลำดับ:
     `**1. <ชื่อสินค้า>**` ตามด้วย `![<ชื่อสั้น>](image_url)` (ใช้ field `image_url`, ถ้าว่างข้ามรุ่นนั้น)
  5. หัวข้อ `### สรุปจุดเด่นของแต่ละรุ่นค่ะ:` แล้ว bullet `- **<ชื่อสินค้า>**: <สรุปจุดเด่น/เหมาะกับการใช้งานแบบไหน>` ทุกรุ่น
  6. บรรทัดปิดท้ายเชิญสอบถามเพิ่ม/สั่งซื้อ/ทักแอดมิน พร้อมย้ำรับประกัน (ถ้ามี)
  - ห้ามตัดทอน ห้ามตอบแค่คอลัมน์ "คุณสมบัติเด่น" สั้นๆ ต้องเป็นตารางสเปคละเอียดเต็มรูปแบบนี้เสมอ
- หากลูกค้าถามเรื่องเคลม/รับประกัน ให้ย้ำช่องทางติดต่อและระยะเวลารับประกันที่พบใน context
- ราคาที่แสดงเป็น THB ถ้า field `price` ว่าง หมายถึงไม่มีข้อมูลราคา อย่าเดา
- อย่าเสนอสินค้าที่ status != "NORMAL" ให้ลูกค้า (ยกเว้นตอบคำถามเคลมของสินค้าเดิม)
- **สำคัญมาก**: สินค้าที่ status != "NORMAL" (เช่น UNLIST, SELLER_DELETE) เลิกขายแล้ว
  - ห้ามแสดงราคา ห้ามแสดงลิงก์สั่งซื้อ ห้ามเสนอขาย
  - ถ้าลูกค้าถามรับประกันของสินค้าที่ status != NORMAL ให้ตอบเฉพาะเงื่อนไขรับประกัน แล้วบอกว่า "รุ่นนี้เลิกขายแล้ว"
  - ถ้าลูกค้าอยากซื้อ ให้แนะนำสินค้า status=NORMAL รุ่นอื่นแทน
- ถ้ามี field `_context_note` ใน product card ให้อ่านและทำตามคำสั่งในนั้นด้วย

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
        # ฟิลด์จาก KB (ถ้า merge แล้ว)
        kb_fields = ("kb_highlights", "kb_specs", "kb_box_contents", "_source", "_kb_only")
        slim = []
        for p in products:
            card = {k: p[k] for k in slim_fields if k in p}
            # ใส่ฟิลด์ KB ถ้ามี
            for kf in kb_fields:
                if kf in p:
                    card[kf] = p[kf]
            # ใส่ _context_note ถ้ามี (fallback note)
            if "_context_note" in p:
                card["_context_note"] = p["_context_note"]
            # ใส่ description/weight/dimension เฉพาะตอนจำเป็น
            if include_description:
                if "description_excerpt" in p:
                    desc = p["description_excerpt"]
                    if desc and desc.strip():
                        card["description_excerpt"] = desc
                    else:
                        card["description_excerpt"] = "(ไม่มีรายละเอียดสินค้าเพิ่มเติม)"
                        # เพิ่ม context_note ชัดๆ ว่าห้ามเอา desc สินค้าอื่นมาตอบ
                        existing_note = card.get("_context_note", "")
                        no_desc_note = "สินค้านี้ไม่มีรายละเอียดเพิ่มเติม ห้ามอ้างอิง description_excerpt ของสินค้าอื่นมาตอบสินค้านี้เด็ดขาด ให้บอกลูกค้าว่าขออภัย สินค้ารุ่นนี้ไม่มีรายละเอียดเพิ่มเติม ทักแอดมินได้เลยนะคะ"
                        card["_context_note"] = (existing_note + " " + no_desc_note).strip() if existing_note else no_desc_note
                if "weight" in p:
                    card["weight"] = p["weight"]
                if "dimension" in p:
                    card["dimension"] = p["dimension"]
            slim.append(card)
        body = json.dumps(slim, ensure_ascii=False, indent=2)
    header = "ข้อมูลสินค้าที่เกี่ยวข้อง (จาก MongoDB ของร้านในเครือ):\n"
    if shop_hint:
        header += f"ลูกค้าทักจากร้าน: {shop_hint}\n"
    header += f"จำนวนสินค้าใน context: {len(products)}\n"
    # ถ้ามีสินค้าที่ไม่มี description_excerpt → เตือน LLM ชัดๆ
    no_desc_count = sum(1 for p in products if not (p.get("description_excerpt") or "").strip())
    has_desc_count = len(products) - no_desc_count
    if include_description and no_desc_count > 0 and has_desc_count > 0:
        header += (
            f"⚠️ สำคัญมาก: มี {no_desc_count} สินค้าที่ไม่มี description_excerpt "
            f"(ระบุว่า 'ไม่มีรายละเอียดสินค้าเพิ่มเติม') "
            f"ห้ามเอา description_excerpt ของสินค้าอื่นมาตอบแทนสินค้าเหล่านั้นเด็ดขาด "
            f"แม้จะเป็นสินค้ารุ่นเดียวกันจากร้านอื่นก็ตาม "
            f"ถ้าลูกค้าถามรายละเอียดของสินค้าที่ไม่มี desc ให้บอก "
            f"'ขออภัยค่ะ สินค้ารุ่นนี้ไม่มีรายละเอียดเพิ่มเติม ทักแอดมินได้เลยนะคะ'\n"
        )
    header += "\n"
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
    try:
        client = _client()
    except RuntimeError as exc:
        return f"ขออภัย ระบบแชทบอทขัดข้องชั่วคราว ({exc}) กรุณาติดต่อแอดมินนะคะ", {"prompt": 0, "output": 0, "total": 0}
    model_name = (model or os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")).strip()

    # ตรวจว่าคำถามเกี่ยวกับรับประกัน/เคลม/สเปก/รายละเอียดไหม
    # ถ้าใช่ส่ง description ให้ LLM ด้วย
    desc_kw = (
        "รับประกัน", "ประกัน", "เคลม", "warranty", "claim", "ศูนย์", "ซ่อม", "เปลี่ยน",
        "สเปก", "spec", "specification", "รายละเอียด", "detail", "ข้อมูลสินค้า",
        "จอ", "กล้อง", "แบตเตอรี่", "cpu", "ram", "rom", "ความจุ", "หน่วยความจำ",
        "ระบบปฏิบัติการ", "เชื่อมต่อ", "เครือข่าย", "สี", "ขนาด", "น้ำหนัก",
        "อุปกรณ์ในกล่อง", "ในกล่อง", "box",
        "เปรียบเทียบ", " vs ", "เทียบ", "compare", "เทียบกับ",
    )
    include_desc = any(kw in message.lower() for kw in desc_kw)

    context = _build_context(products, shop_hint=shop_hint,
                             include_description=include_desc)
    # เน้นย้ำว่าให้ตอบจาก context ปัจจุบันเท่านั้น อย่าอ้างอิง history
    user_prompt = (
        f"{context}\n\n"
        f"คำถามของลูกค้า: {message}\n\n"
        f"สำคัญมาก: ตอบจากข้อมูลสินค้าใน context ด้านบนเท่านั้น "
        f"ห้ามอ้างอิงสินค้าจากคำตอบก่อนหน้าหรือ history "
        f"สินค้าที่ตรงกับคำถามมากที่สุดอยู่ลำดับแรกของ context"
    )

    contents: list[Any] = []
    if history:
        for h in history:
            role = h.get("role", "user")
            text = h.get("text", "")
            if role not in ("user", "model"):
                role = "user"
            # สำหรับคำตอบ model ก่อนหน้า ให้ส่งแค่สรุปสั้นๆ ไม่ส่ง full answer
            # เพื่อป้องกัน LLM อ้างอิงสินค้าจากคำตอบเดิมแทน context ปัจจุบัน
            if role == "model" and len(text) > 200:
                text = text[:200] + "... (คำตอบก่อนหน้า อย่าอ้างอิงสินค้าจากนี้)"
            contents.append({"role": role, "parts": [{"text": text}]})
    contents.append({"role": "user", "parts": [{"text": user_prompt}]})

    # DEBUG: log context ที่ส่ง LLM
    import sys
    print(f"\n[LLM DEBUG] message={message!r}", file=sys.stderr)
    print(f"[LLM DEBUG] products={len(products)}", file=sys.stderr)
    for i, p in enumerate(products[:5]):
        print(f"[LLM DEBUG]   [{i}] {p.get('shop','?')[:15]}  {p.get('name','')[:50]}", file=sys.stderr)
    print(f"[LLM DEBUG] include_desc={include_desc}", file=sys.stderr)
    print(f"[LLM DEBUG] history_len={len(history) if history else 0}", file=sys.stderr)
    if history:
        for i, h in enumerate(history):
            print(f"[LLM DEBUG]   hist[{i}] role={h.get('role')} text={h.get('text','')[:60]!r}", file=sys.stderr)
    print(f"[LLM DEBUG] context (first 500): {context[:500]!r}", file=sys.stderr)

    usage_info = {"prompt": 0, "output": 0, "total": 0}
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
        return f"ขออภัย ระบบ LLM ติดขัด ลองใหม่อีกครั้ง ({exc})", usage_info
    except Exception as exc:
        return f"ขออภัย เกิดข้อผิดพลาดในการเรียก LLM ({exc})", usage_info

    # log token usage (ถ้ามี) เพื่อคำนวณต้นทุน
    usage = getattr(resp, "usage_metadata", None)
    if usage:
        prompt_t = getattr(usage, "prompt_token_count", 0) or 0
        output_t = getattr(usage, "candidates_token_count", 0) or 0
        total_t = getattr(usage, "total_token_count", 0) or (prompt_t + output_t)
        usage_info = {"prompt": prompt_t, "output": output_t, "total": total_t}
        print(f"[LLM] model={model_name}  prompt={prompt_t}  output={output_t}  total={total_t}  products={len(products)}")

    return (resp.text or "").strip(), usage_info


# ---- KB-based answer ----

KB_SYSTEM_INSTRUCTION = """คุณเป็นผู้ช่วยขายหญิงที่เป็นมิตรและสุภาพ ให้คำปรึกษาสินค้ากับกลุ่มร้านค้าออนไลน์ในเครือเครือข่ายเรา

บุคลิกและน้ำเสียง:
- คุณเป็นผู้หญิง ใช้คำลงท้ายประโยคเป็น "ค่ะ" "นะคะ" "คะ" เท่านั้น
- ห้ามใช้ "ครับ" "คับ" "ครับผม" หรือคำลงท้ายผู้ชายทุกรูปแบบ
- สุภาพ เป็นมิตร อ่อนโยน แต่กระชับ ไม่เยิ่นเย้อ

หน้าที่ของคุณ:
1. ตอบคำถามลูกค้าเกี่ยวกับสินค้าจาก Knowledge Base ที่ให้มา
2. อธิบายเรื่องการเคลมและการรับประกันตามข้อมูลใน context

กฎการตอบ:
- ตอบเป็นภาษาเดียวกับลูกค้า (ส่วนใหญ่คือภาษาไทย) สุภาพ เป็นมิตร กระชับ
- อ้างอิงเฉพาะข้อมูลใน context ที่ให้มาในรอบนี้เท่านั้น ห้าม invent ข้อมูลที่ไม่มี
- ถ้า context ไม่พอตอบ ให้บอกตรงๆ ว่าขอแนะนำให้ทักแอดมินร้าน

กฎสำคัญสำหรับการตอบจาก Knowledge Base:
- ถ้าลูกค้าถามแค่ชื่อรุ่น (ไม่ระบุ topic) → ตอบ ชื่อสินค้า + รายละเอียดสั้นๆ + จุดเด่น
  **ห้ามบอกราคา** (KB ไม่มีข้อมูลราคา และลูกค้าไม่ได้ถาม)
- ถ้าลูกค้าถามเรื่องรับประกัน → ตอบเฉพาะเรื่องรับประกัน
  - ถ้ามีเงื่อนไขรับประกันทั่วไปใน context → รวมไว้ด้วย
  - ถ้าสินค้าไม่มีข้อมูลรับประกัน → บอกว่า "ไม่มีข้อมูลการรับประกันสำหรับรุ่นนี้"
- ถ้าลูกค้าถามเรื่องสเปก → ตอบเฉพาะสเปกที่มีใน context
- ถ้าลูกค้าถามเรื่องอุปกรณ์ในกล่อง → ตอบเฉพาะอุปกรณ์ที่มีใน context
- ตอบกระชับ ไม่ต้องยาวเกินไป — ใช้ข้อมูลเท่าที่จำเป็น
"""


def answer_with_kb(
    message: str,
    kb_context: str,
    history: list[dict] | None = None,
    model: str | None = None,
) -> str:
    """สร้างคำตอบจาก Gemini โดยใช้ KB context (ไม่ใช้ product_store).

    Args:
        message: คำถามลูกค้ารอบปัจจุบัน
        kb_context: context ที่ format แล้วจาก knowledge_base.format_kb_context()
        history: ประวัติแชทก่อนหน้า
        model: ชื่อโมเดล Gemini
    """
    try:
        client = _client()
    except RuntimeError as exc:
        return f"ขออภัย ระบบแชทบอทขัดข้องชั่วคราว ({exc}) กรุณาติดต่อแอดมินนะคะ"
    model_name = (model or os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")).strip()

    user_prompt = f"{kb_context}\n\nคำถามของลูกค้า: {message}"

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
                "system_instruction": KB_SYSTEM_INSTRUCTION,
                "temperature": 0.3,
                "max_output_tokens": 2048,
            },
        )
    except genai_errors.ClientError as exc:
        return f"ขออภัย ระบบ LLM ติดขัด ลองใหม่อีกครั้ง ({exc})"
    except Exception as exc:
        return f"ขออภัย เกิดข้อผิดพลาดในการเรียก LLM ({exc})"

    usage = getattr(resp, "usage_metadata", None)
    if usage:
        prompt_t = getattr(usage, "prompt_token_count", 0) or 0
        output_t = getattr(usage, "candidates_token_count", 0) or 0
        total_t = getattr(usage, "total_token_count", 0) or (prompt_t + output_t)
        print(f"[LLM-KB] model={model_name}  prompt={prompt_t}  output={output_t}  total={total_t}")

    return (resp.text or "").strip()


def answer_general(
    message: str,
    context: str,
    qtype: str,
    history: list[dict] | None = None,
    model: str | None = None,
) -> tuple[str, dict]:
    """สร้างคำตอบสำหรับคำถามทั่วไป (policy/brands/categories/shops/brand_info).

    Args:
        message: คำถามลูกค้า
        context: context ที่ดึงมาจาก KB/Mongo (policy text, brand list, etc.)
        qtype: ประเภทคำถาม (warranty_policy, brands, etc.)
        history: ประวัติแชท
        model: ชื่อโมเดล Gemini

    คืน (answer, usage_info).
    """
    try:
        client = _client()
    except RuntimeError as exc:
        return f"ขออภัย ระบบแชทบอทขัดข้องชั่วคราว ({exc}) กรุณาติดต่อแอดมินนะคะ", {}
    model_name = (model or os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")).strip()

    general_instruction = (
        "คุณเป็นพนักงานบริการลูกค้าหญิงของร้านค้าออนไลน์ในเครือ Shopee "
        "ตอบลูกค้าเป็นภาษาไทย สุภาพ ยิ้มแย้ม กระชับ และเป็นมิตร "
        "ลงท้ายประโยคด้วย 'ค่ะ' 'นะคะ' หรือ 'คะ' เท่านั้น ห้ามใช้ 'ครับ' หรือ 'คับ' "
        "ตอบจากข้อมูลใน context ที่ให้เท่านั้น ห้ามแต่งเรื่อง "
        "ถ้า context ไม่พอตอบ ให้บอกลูกค้าว่าทักแอดมินได้เลยนะคะ "
        "ตอบเป็นข้อๆ ให้อ่านง่าย ไม่ต้องยาวเกินไป"
    )

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
                "system_instruction": general_instruction,
                "temperature": 0.3,
                "max_output_tokens": 2048,
            },
        )
    except genai_errors.ClientError as exc:
        return f"ขออภัย ระบบ LLM ติดขัด ลองใหม่อีกครั้ง ({exc})", {}
    except Exception as exc:
        return f"ขออภัย เกิดข้อผิดพลาดในการเรียก LLM ({exc})", {}

    usage = getattr(resp, "usage_metadata", None)
    usage_info: dict = {}
    if usage:
        prompt_t = getattr(usage, "prompt_token_count", 0) or 0
        output_t = getattr(usage, "candidates_token_count", 0) or 0
        total_t = getattr(usage, "total_token_count", 0) or (prompt_t + output_t)
        usage_info = {"prompt": prompt_t, "output": output_t, "total": total_t}
        print(f"[LLM-General] qtype={qtype}  model={model_name}  prompt={prompt_t}  output={output_t}  total={total_t}", file=sys.stderr)

    return (resp.text or "").strip(), usage_info
