"""Data structures for chat_v2 pipeline.

แยกจาก app.py เพื่อให้:
- ข้อมูลมี schema ชัดเจน (ไม่ใช่ dict ลอยๆ)
- ไม่ mutate shared state ระหว่าง stages
- แก้ง่าย อ่านง่าย เพราะรู้ว่าแต่ละ stage รับ/คืนอะไร
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class HistoryEntry:
    """Entry เดียวใน history — mark ว่าเป็น user_need หรือ bot_recommend."""
    role: str                          # "user" | "model"
    text: str
    images: list[str] = field(default_factory=list)
    image_desc: str = ""
    # ⚡ ข้อ 10 — mark anchor ใน history
    anchor: AnchorData | None = None   # ถ้า message นี้ส่งการ์ดสินค้า
    is_recommend: bool = False          # ถ้า bot แนะนำสินค้าใน message นี้


@dataclass
class AnchorData:
    """สินค้าที่ลูกค้าสนใจ — เก็บข้อมูลครบ ไม่ใช่แค่ item_id."""
    item_id: str
    name: str
    product_type: str = ""              # charger, cable, powerbank, earphone, ...
    charger_subtype: str = ""          # adapter, cable, set, car_charger, wireless, ...
    description: str = ""               # รายละเอียดสินค้า (จาก DB)
    card: dict = field(default_factory=dict)  # การ์ดสินค้าเต็ม (ส่งให้ LLM)
    source: str = "user_item_card"     # user_item_card | bot_recommend | history_carry
    is_sold_out: bool = False
    status: str = ""                    # NORMAL | UNLIST | SELLER_DELETE | ...


@dataclass
class IntentData:
    """ผลจาก intent classification — LLM เป็นหลัก ไม่ใช่ hardcode keyword."""
    intent: str = ""                   # product_recommend, compatibility_check, product_spec, warranty_claim, ...
    product_type: str = ""             # charger, cable, powerbank, ...
    charger_subtype: str = ""          # adapter, cable, set, ...
    target_device: str = ""            # xiaomi 17 ultra, iphone 15, ...
    confidence: float = 0.0
    needs_description: bool = False
    usage: dict = field(default_factory=dict)


@dataclass
class ContextData:
    """Context ที่ส่งผ่านทุก stages — ไม่ mutate แยกกันชัดเจน."""
    shop: str = ""
    platform: str = "shopee"
    conversation_id: str = ""
    history: list[HistoryEntry] = field(default_factory=list)
    persona_extra: str = ""
    bot_name: str = "เรา"
    vision_context: str = ""
    vision_usage: dict = field(default_factory=dict)
    image_desc_out: str = ""
    steps: list[dict] = field(default_factory=list)
    timing: dict = field(default_factory=dict)
    total_start: float = 0.0


@dataclass
class SearchData:
    """ผลจาก web search — keywords + spec + สินค้าที่ re-query ได้."""
    keywords: list[str] = field(default_factory=list)
    product_type: str = ""
    search_info: str = ""              # spec/ข้อมูลจาก search (strip URL แล้ว)
    products: list[dict] = field(default_factory=list)  # สินค้าจาก re-query DB
    usage: dict = field(default_factory=dict)
    cost_usd: float = 0.0
    elapsed: float = 0.0
    model: str = ""
    error: str = ""


@dataclass
class AnswerData:
    """ผลจาก LLM2 — answer + products + usage."""
    answer: str = ""
    products: list[dict] = field(default_factory=list)
    usage: dict = field(default_factory=dict)
    model: str = ""
    cost_usd: float = 0.0
    elapsed: float = 0.0
    source: str = ""
    web_search_used: bool = False
    web_search_reason: str = ""
    handoff_to_admin: bool = False
    handoff_reason: str = ""
    intent: IntentData | None = None
