"""test_cert_context_5c.py — Task 5C-E: cert (มอก.) context carry.

pin:
- message ไม่มี product type → type_filter ตกมาจาก history/anchor
- subtype (adapter/cable) จาก context กรองผลเมื่อเป็นไปได้
- ถามลอยๆ ไม่มี context เลย → list จำกัด + ถามหมวด (ไม่ dump ทั้งร้าน)
- ผลที่ไม่ NORMAL ต้องมี availability label
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import handoffs, product_store  # noqa: E402


def _req(msg, hist=(), conv=None):
    return SimpleNamespace(message=msg, history=list(hist), shop="KingGadgets",
                           conversation_id=conv, platform="shopee")


def _ctx():
    return {"is_tax_invoice": False, "bot_name": "ทางร้าน", "steps": [],
            "timing_breakdown": {}, "total_start": 0.0, "image_desc_out": "",
            "model_name": "test"}


def _u(text):
    return SimpleNamespace(role="user", text=text)


def _hit(name, status="NORMAL", n=1):
    return [{"name": name, "status": status, "via": "desc"} for _ in range(n)]


def test_cert_type_filter_from_history(monkeypatch):
    """'รุ่นไหนมี มอก. บ้าง' หลังคุยหัวชาร์จ → type_filter={'charger'} ไม่ใช่ None"""
    captured = {}

    def fake_search(db, certs, **kw):
        if "type_filter" in kw:
            captured.setdefault("type_filter", kw["type_filter"])
        return _hit("CUKTECH AD653C หัวชาร์จ 65W มอก.")

    monkeypatch.setattr(product_store, "search_cert_products", fake_search)
    req = _req("รุ่นไหนมี มอก. บ้าง",
               hist=[_u("หัวชาร์จ iphone แนะนำหน่อย"), _u("ขอแบบ gan")])
    out = handoffs.post_intent_handoffs(req, _ctx(), db=None)
    assert captured.get("type_filter") == {"charger"}
    assert out and "มอก" in out["answer"]


def test_cert_message_type_wins_over_history(monkeypatch):
    captured = {}

    def fake_search(db, certs, **kw):
        captured["type_filter"] = kw.get("type_filter")
        return _hit("Eloop E12 powerbank มอก.")

    monkeypatch.setattr(product_store, "search_cert_products", fake_search)
    req = _req("พาวเวอร์แบงค์ มี มอก. ไหม",
               hist=[_u("หัวชาร์จ iphone แนะนำหน่อย")])
    out = handoffs.post_intent_handoffs(req, _ctx(), db=None)
    assert captured.get("type_filter") == {"powerbank"}


def test_cert_no_context_caps_list_and_clarifies(monkeypatch):
    """ถามลอยๆ ไม่มี context เลย → ไม่ dump ยาว + บอกให้ระบุหมวด"""
    monkeypatch.setattr(
        product_store, "search_cert_products",
        lambda db, certs, **kw: [
            {"name": f"สินค้า{i}", "status": "NORMAL", "via": "desc"}
            for i in range(30)])
    req = _req("รุ่นไหนมี มอก. บ้าง")     # ไม่มี history/conv
    out = handoffs.post_intent_handoffs(req, _ctx(), db=None)
    assert out
    bullets = out["answer"].count("•")
    assert bullets <= 12, f"dumped {bullets} items"
    assert "หมวด" in out["answer"]


def test_cert_subtype_filter_when_detected(monkeypatch):
    """context บอก subtype adapter → ผลสายชาร์จถูกกรองออก"""
    def fake_search(db, certs, **kw):
        return [
            {"name": "CUKTECH AD653C หัวชาร์จ 65W มอก.", "status": "NORMAL",
             "via": "desc"},
            {"name": "CUKTECH CTC615 สายชาร์จ มอก.", "status": "NORMAL",
             "via": "desc"},
        ]
    monkeypatch.setattr(product_store, "search_cert_products", fake_search)
    req = _req("รุ่นไหนมี มอก. บ้าง",
               hist=[_u("หัวชาร์จ iphone แนะนำหน่อย")])
    out = handoffs.post_intent_handoffs(req, _ctx(), db=None)
    assert out
    assert "CTC615" not in out["answer"]
    assert "AD653C" in out["answer"]


def test_cert_result_availability_label(monkeypatch):
    """ผลที่ไม่ใช่ NORMAL ต้องมี label (ห้ามดูเหมือนขายได้)"""
    def fake_search(db, certs, **kw):
        return [
            {"name": "AC65B หัวชาร์จ มอก.", "status": "SELLER_DELETE",
             "via": "desc"},
            {"name": "AD653C หัวชาร์จ มอก.", "status": "NORMAL",
             "via": "desc"},
        ]
    monkeypatch.setattr(product_store, "search_cert_products", fake_search)
    req = _req("รุ่นไหนมี มอก. บ้าง", hist=[_u("หัวชาร์จแนะนำหน่อย")])
    out = handoffs.post_intent_handoffs(req, _ctx(), db=None)
    ans = out["answer"]
    line = [l for l in ans.splitlines() if "AC65B" in l][0]
    assert "เลิกจำหน่าย" in line or "ไม่พร้อม" in line


def test_cert_availability_label_uses_stock(monkeypatch):
    """NORMAL + stock=0 → label หมดสต็อก (เดิม resolver ไม่ได้รับ stock → active)"""
    def fake_search(db, certs, **kw):
        return [{"name": "soldout tisi item", "status": "NORMAL", "stock": 0,
                 "via": "desc", "cert": "tisi", "cert_context": "มอก."}]

    monkeypatch.setattr(product_store, "search_cert_products", fake_search)
    req = _req("รุ่นไหนมี มอก. บ้าง", hist=[_u("หัวชาร์จแนะนำหน่อย")])
    out = handoffs.post_intent_handoffs(req, _ctx(), db=None)
    line = [l for l in out["answer"].splitlines() if "soldout" in l][0]
    assert "หมดสต็อก" in line


def _seen_type_filter(monkeypatch):
    seen: dict = {}

    def fake_search(db, certs, **kw):
        seen["type_filter"] = kw.get("type_filter")
        seen["model_keyword"] = kw.get("model_keyword")
        return _hit("cert item มอก.")

    monkeypatch.setattr(product_store, "search_cert_products", fake_search)
    return seen


def test_cert_type_ownership_provenance(monkeypatch):
    """type derivation ใช้ provenance: explicit type noun ชนะ device/model
    regex mention — ไม่มี phone/iPhone hardlogic; device token ที่ไม่ใช่
    product code ต้องไม่กลายเป็น model_keyword เมื่อ explicit type ชี้หมวดอื่น"""
    cases = [
        ("หัวชาร์จ iPhone 17 มี มอก. ไหม", {"charger"}),   # iPhone = compat target
        ("โทรศัพท์ iPhone 15 มี มอก. ไหม", {"phone"}),     # explicit type ชนะ
        ("ฟิล์ม iPhone 15 มี มอก. ไหม", {"screen_protector"}),
        ("เคส Mi Watch 8 มี CE ไหม", {"case"}),            # watch = compat target
    ]
    for message, expected in cases:
        seen = _seen_type_filter(monkeypatch)
        out = handoffs.post_intent_handoffs(_req(message), _ctx(), db=None)
        assert out
        assert seen["type_filter"] == expected, message
        assert seen["model_keyword"] in ("", None), message


def test_cert_device_only_message_keeps_model_keyword(monkeypatch):
    """ไม่มี explicit product type → code-shaped token คือ subject จริง"""
    seen = _seen_type_filter(monkeypatch)
    handoffs.post_intent_handoffs(_req("AC65B2 มี มอก. ไหม"), _ctx(), db=None)
    assert seen["model_keyword"] == "AC65B2"
