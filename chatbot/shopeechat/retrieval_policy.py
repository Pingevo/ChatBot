"""retrieval_policy.py — evidence card contract (Task 3, observe-only).

ทำไม: product cards มาจากหลายแหล่ง (product_store/units/KB/anchor/order/compat/web)
      แต่ไม่มีภาษาเดียวกันบอกว่ามาจากไหน หลักฐานอะไร ถูกเลือกเพราะอะไร
      contract นี้คือ metadata ภายใน — Task 6/8/10 ใช้ต่อสำหรับ selection/proof

Contract (private — ห้ามหลุด public response):
    _evidence = {"sources": [...], "item_ids": [...], "model_ids": [...], "facts": {...}}
    _selection_reason = "short_machine_reason"
"""
from __future__ import annotations

PRIVATE_KEYS = ("_evidence", "_selection_reason")


def _norm_id(value) -> str:
    """normalize id เป็น string — float int-valued (mongo export) → int-str."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def make_evidence_card(product: dict, *, source: str,
                       evidence: dict | None = None,
                       selection_reason: str | None = None) -> dict:
    """card + evidence metadata — คืน copy ใหม่ ไม่ mutate input.

    Args:
        product: product card/doc
        source: "unit" | "legacy" | "kb" | "order" | "anchor" | "compat" | "web"
        evidence: facts เพิ่มเติม (เช่น {"spec": ["ShpProducts.description"]})
        selection_reason: short machine reason ว่าถูกเลือกเพราะอะไร

    Returns:
        card ที่เพิ่ม `_evidence` (merge กับของเดิม — sources ไม่ซ้ำ,
        item_ids/model_ids normalize เป็น str) + `_selection_reason` ถ้าส่งมา
    """
    card = dict(product or {})
    meta = dict(card.get("_evidence") or {})

    sources = list(meta.get("sources") or [])
    if source and source not in sources:
        sources.append(source)
    meta["sources"] = sources

    for key, field in (("item_ids", "item_id"), ("model_ids", "model_id")):
        ids = list(meta.get(key) or [])
        value = product.get(field) if product else None
        if value is not None:
            sv = _norm_id(value)
            if sv not in ids:
                ids.append(sv)
        meta[key] = ids

    facts = dict(meta.get("facts") or {})
    facts.update(evidence or {})
    meta["facts"] = facts

    card["_evidence"] = meta
    if selection_reason is not None:
        card["_selection_reason"] = selection_reason
    return card


def strip_private_evidence(product: dict | list[dict]) -> dict | list[dict]:
    """ลบ `_evidence`/`_selection_reason` ก่อน public response — ไม่ mutate input.

    รับ card เดียวหรือ list (Task 8 wire ครั้งเดียวที่ product-response boundary).
    """
    if isinstance(product, list):
        return [strip_private_evidence(p) for p in product]
    out = dict(product or {})
    for key in PRIVATE_KEYS:
        out.pop(key, None)
    return out
