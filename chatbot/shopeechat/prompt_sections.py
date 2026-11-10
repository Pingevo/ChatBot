"""prompt_sections — modular split ของ _SYS_CORE_B ตาม intent (R0).

- ตัด literal ด้วย marker strings (ไม่แก้ prompt เดิม) — ผลรวมคง byte-identical
- marker ใดหาย → fallback ส่งทั้ง CORE_B (กัน prompt edit ทำ split พังเงียบ ๆ)
- PROMPT_MODULAR=1 เปิดใช้; ปิด = SYSTEM_INSTRUCTION เดิม

sections: core_answer (ส่งเสมอ) | recommend | product_match | compare | claim
"""
from __future__ import annotations

import os

# markers ตามลำดับใน _SYS_CORE_B (ตรวจ offset จาก plan doc 2026-11-09)
_MARKERS: list[tuple[str, str]] = [
    ("core_answer",   "- **สำคัญมาก — คำถามเฉพาะเจาะจง"),
    ("recommend",     "- **เสนอขาย/แนะนำสินค้า"),
    ("core_answer",   "- **ห้ามตอบว่า \"ไม่ระบุไว้\""),
    ("product_match", "- **สายชาร์จ (มี 2 หัว) ต้องตรวจทั้งสองฝั่ง"),
    ("product_match", "- **⚡ กฎสำคัญเกี่ยวกับ MagSafe"),
    ("recommend",     "- **แยกประเภทสินค้าใน context ให้ถูกต้อง"),
    ("recommend",     "- **บังคับแยก bubble เมื่อแนะนำ/เชียร์ขายสินค้า"),
    ("recommend",     "- **สำคัญอย่างยิ่งเรื่องขอบเขตร้าน"),
    ("compare",       "โครงสร้างคำตอบที่บังคับ (เรียงตามลำดับนี้เท่านั้น):"),
    ("recommend",     "- **สำคัญมากเรื่อง stock"),
    ("recommend",     "การแสดงรูปสินค้า (สำคัญมาก — บังคับ):"),
    ("core_answer",   "กฎการแบ่ง:"),
    ("claim",         "**กฎ 3 — ลูกค้าแจ้งเคลม/ปัญหา ห้ามเสนอขายเด็ดขาด:"),
]

_sections: dict[str, str] | None = None


def _split(core_b: str) -> dict[str, str]:
    global _sections
    if _sections is not None:
        return _sections
    # หา offset ของทุก marker — เรียงแล้วตัด; ส่วนก่อน marker แรกและส่วนว่าง→core_answer
    cuts: list[tuple[int, str]] = []
    pos = 0
    for name, marker in _MARKERS:
        i = core_b.find(marker, pos)
        if i < 0:
            _sections = {"core_answer": core_b}   # marker หาย → fallback เต็ม
            return _sections
        cuts.append((i, name))
        pos = i
    cuts.sort()
    out: dict[str, str] = {}
    # prefix ก่อน marker แรก (กฎ upsell NORMAL ฯลฯ) → core_answer เสมอ
    prefix = core_b[: cuts[0][0]]
    out["core_answer"] = prefix
    for idx, (start, name) in enumerate(cuts):
        end = cuts[idx + 1][0] if idx + 1 < len(cuts) else len(core_b)
        out[name] = out.get(name, "") + core_b[start:end]
    _sections = out
    return out


def modular_enabled() -> bool:
    """สวิตช์เปิด/ปิด — config `prompt_modular` (bool) ใน system_configs;
    env PROMPT_MODULAR=1 override เปิด (ใช้ test/dev); ค่าว่าง/อ่านไม่ได้ = ปิด"""
    try:
        from . import runtime_config as _rc
        v = _rc.get_runtime_config().get("prompt_modular")
        if isinstance(v, bool):
            return v
    except Exception:
        pass
    return os.environ.get("PROMPT_MODULAR", "") == "1"


def select_sections(intent_result: dict | None, message: str) -> set[str]:
    """needs/intent → section keys; core_answer ส่งเสมอ
    intent_result ว่าง = ไม่มีข้อมูลพอตัด → คืนทุก section (=พฤติกรรมเดิม ปลอดภัย)"""
    if intent_result is None:
        return set(_ALL)                      # ไม่มี intent info → prompt เต็ม (เดิม)
    low = (message or "").lower()
    needs = intent_result.get("needs") or []
    kinds = {n.get("kind") for n in needs if isinstance(n, dict)}
    keys = {"core_answer"}
    if any(k in low for k in ("เปรียบเทียบ", "เทียบ", "vs ", "ต่างกัน", "อันไหนดี")) or kinds & {"comparison", "compare"}:
        keys.update(("compare", "recommend", "product_match"))
    elif any(k in low for k in ("ประกัน", "เคลม", "claim", "ซ่อม", "เปลี่ยน", "พัง", "เสีย")) or kinds & {"warranty", "claim"}:
        keys.add("claim")
    else:
        keys.update(("recommend", "product_match"))
    if kinds and not (kinds & {"product", "recommendation", "upsell"}):
        keys.discard("recommend"); keys.discard("product_match")
    return keys


_ALL = {"core_answer", "recommend", "product_match", "compare", "claim"}


def select_sections_typed(task_kinds: set[str] | None) -> set[str]:
    """typed NeedTask kinds (product|compare|compat) → section keys;
    kinds ว่าง/None = ข้อมูลไม่พอ → ทุก section (พฤติกรรมเดิม ปลอดภัย)"""
    if not task_kinds:
        return set(_ALL)
    keys = {"core_answer"}
    if "compare" in task_kinds:
        keys.update(("compare", "recommend", "product_match"))
    else:
        keys.update(("recommend", "product_match"))
    return keys


def build_core_b_typed(core_b: str, task_kinds: set[str] | None) -> str:
    """build_core_b เวอร์ชัน typed path — input = NeedTask.kind set จาก AnswerContext"""
    if not modular_enabled():
        return core_b
    secs = _split(core_b)
    if set(secs) == {"core_answer"}:      # fallback path — marker หาย
        return core_b
    want = select_sections_typed(task_kinds)
    order = ["core_answer", "recommend", "product_match", "compare", "claim"]
    return "".join(secs.get(k, "") for k in order if k in want)


def build_core_b(core_b: str, intent_result: dict | None, message: str) -> str:
    """คืน CORE_B เต็ม (flag ปิด) หรือเฉพาะ sections ที่เลือก (flag เปิด)"""
    if not modular_enabled():
        return core_b
    secs = _split(core_b)
    if set(secs) == {"core_answer"}:      # fallback path — marker หาย
        return core_b
    want = select_sections(intent_result, message)
    # คงลำดับเดิมของ sections ตามที่ปรากฏใน CORE_B
    order = ["core_answer", "recommend", "product_match", "compare", "claim"]
    return "".join(secs.get(k, "") for k in order if k in want)
