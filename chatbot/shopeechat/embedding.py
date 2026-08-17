"""Embedding module สำหรับ RAG (Retrieval Augmented Generation).

ใช้ BAAI/bge-m3 (local, รองรับภาษาไทย) สำหรับ:
- embed สินค้าเป็น vector เก็บใน MongoDB field `embedding`
- embed คำถามลูกค้าเพื่อทำ similarity search

โมเดลโหลดครั้งเดียวตอน start server แล้ว reuse ตลอด session
กิน RAM ~2GB แต่เร็วกว่า API และไม่จำกัด quota
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

# โหลดแบบ lazy (เฉพาะตอนใช้งาน) เพื่อไม่ให้ import รอโมเดล
_model: Any = None
_model_load_time: float = 0.0

MODEL_NAME = "BAAI/bge-m3"
EMBEDDING_DIM = 1024  # bge-m3 ให้ vector 1024 มิติ
DEVICE = "mps"  # Apple Silicon GPU


def _get_model() -> Any:
    """โหลด bge-m3 ครั้งเดียว (lazy singleton)."""
    global _model, _model_load_time
    if _model is not None:
        return _model

    from sentence_transformers import SentenceTransformer

    t0 = time.time()
    logger.info("Loading embedding model %s on %s...", MODEL_NAME, DEVICE)
    _model = SentenceTransformer(MODEL_NAME, device=DEVICE)
    _model_load_time = time.time() - t0
    logger.info("Embedding model loaded in %.1fs", _model_load_time)
    return _model


def embed_texts(texts: list[str], batch_size: int = 32) -> np.ndarray:
    """Embed list ของข้อความ เป็น numpy array shape (n, 1024).

    คืน vector ที่ normalize แล้ว (L2 norm = 1) เพื่อใช้ cosine similarity
    ผ่าน dot product ได้โดยตรง.
    """
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

    model = _get_model()
    # normalize_embeddings=True เพื่อให้ dot product = cosine similarity
    emb = model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=False,
        convert_to_numpy=True,
    )
    return emb.astype(np.float32)


def embed_query(text: str) -> np.ndarray:
    """Embed คำถามลูกค้า 1 ประโยค เป็น vector shape (1024,).

    ใช้สำหรับ similarity search กับ vector สินค้าที่เก็บใน Mongo.
    """
    emb = embed_texts([text])
    return emb[0]


def clean_item_name(name: str) -> str:
    """ทำความสะอาดชื่อสินค้าก่อน embed.

    ตัด noise ที่ไม่ใช่เนื้อหาสินค้า:
    - โค้ดส่วนลด/ราคา ในวงเล็บก้ามปู [ราคาพิเศษ 199บ.]
    - วงเลบบที่มีคำว่า บ. หรือ โค้ด
    - เครื่องหมาย -3M, -30D ท้ายชื่อ (ระยะเวลาคืนของ)
    """
    if not name:
        return ""
    # ตัด [....]
    name = re.sub(r"\[.*?\]", "", name)
    # ตัด (....บ.....) หรือ (....โค้ด....)
    name = re.sub(r"\([^)]*บ\.[^)]*\)", "", name)
    name = re.sub(r"\([^)]*โค้ด[^)]*\)", "", name)
    # ตัด -3M, -30D, -1Y ท้ายชื่อ
    name = re.sub(r"-\d+[MYD]\b", "", name)
    # กรองวงเล็บเหลื่อมที่เหลือ
    name = re.sub(r"\(\s*\)", "", name)
    return name.strip()


def build_doc_text(doc: dict) -> str:
    """สร้างข้อความสำหรับ embed จาก document สินค้า.

    รวมข้อมูลหลาย field เพื่อให้ vector จับ semantic ได้ดีขึ้น:
    - ชื่อสินค้า (ทำความสะอาดแล้ว)
    - แบรนด์
    - หมวดหมู่
    - ร้าน

    ไม่รวม description เพราะยาวและมี noise มาก.
    """
    name = clean_item_name(doc.get("item_name") or "")
    brand = (doc.get("brand") or {}).get("original_brand_name", "")
    cat = doc.get("cat_name") or ""
    shop = doc.get("shopname") or ""

    parts = [p for p in (name, brand, cat, shop) if p]
    return " | ".join(parts)
