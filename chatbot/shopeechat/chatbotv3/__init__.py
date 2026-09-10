"""chatbotv3 — OpenRouter-first paradigm (v3).

ไม่นั่งปั้น RAG context แบบ legacy แต่ส่ง raw (message + history + images + shop link)
ให้ OpenRouter ตอบ → เอา list สินค้ามา match กับ ShpProducts.

Public API:
    chat_v3(req) → dict (compatible กับ ChatResponse ของ app.py)
"""
from __future__ import annotations

from .engine import chat_v3

__all__ = ["chat_v3"]
