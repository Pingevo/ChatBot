# -*- coding: utf-8 -*-
"""Behavioral tests — description/spec evidence gap fixes.

F1  description_excerpt fallback — doc ที่มีแค่ extended_description
    (field_list text blocks) ต้องได้ desc text เข้า card
F2  claimed wattage tier — verdict wattage: structured ก่อน, ถ้าไม่มี
    ค่อยใช้ seller-claimed watts (parse จาก name/desc/variants) พร้อม
    reason code เฉพาะ + segment ที่บอกแหล่ง "ตามข้อมูลสินค้า"
F3  unanswered ask wording — "ไม่มีระบุ" ตรงๆ แทน boilerplate กว้าง
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
for p in (ROOT / "chatbot", ROOT / "docs" / "test" / "offline"):
    sys.path.insert(0, str(p))

from shopeechat import product_store as ps          # noqa: E402
from shopeechat import policy_resolver as pr        # noqa: E402
from shopeechat import answer_context as ac         # noqa: E402


# ── F1 — extended_description fallback ──────────────────────────────────────

def _doc_ext_desc(*texts):
    fl = [{"field_type": "image",
           "image_info": {"image_id": f"img-{i}"}}
          for i in range(len(texts))]
    fl += [{"field_type": "text", "text": t} for t in texts]
    return {"description_info": {
        "extended_description": {"field_list": fl}}}


def test_flat_description_wins():
    doc = {"description": "flat desc 240W",
           **_doc_ext_desc("ext desc")}
    assert ps._doc_description_text(doc) == "flat desc 240W"


def test_extended_description_fallback_joins_text_blocks():
    doc = _doc_ext_desc("สเปค 240W PD3.1", "ยาว 1.5 เมตร")
    out = ps._doc_description_text(doc)
    assert "240W" in out and "1.5 เมตร" in out


def test_no_description_anywhere_returns_empty():
    assert ps._doc_description_text({}) == ""
    assert ps._doc_description_text(_doc_ext_desc()) == ""


# ── F2 — claimed wattage tier in _wattage_rc / _compat_segment ─────────────

def _fe(key, val, src="card"):
    return pr.FieldEvidence("i:1", key, pr._norm_val(val), "known",
                            src, "", f"test.{key}")


def _tgt_facts(min_watt=90.0):
    return (pr.FieldEvidence(
        "device:dev-x", "connector", "usb-c", "known", "spec-db", "", ""),
        pr.FieldEvidence(
        "device:dev-x", "min_watt", min_watt, "known", "spec-db", "", ""))


def _subject(**kw):
    facts = [
        _fe("product_type", kw.get("ptype", "cable")),
        _fe("connector", ("usb-c",)),
    ]
    if kw.get("structured"):
        facts.append(_fe("output_w_structured", tuple(kw["structured"])))
        facts.append(_fe("power_capacity_w", tuple(kw["structured"])))
    if kw.get("claimed"):
        facts.append(_fe("output_w", kw["claimed"]))
    return tuple(facts)


def test_claimed_watt_covers_target():
    dec = pr.resolve_compat(
        subject_id="i:1", target="device:dev-x", relation="charges",
        subject_facts=_subject(claimed=240.0), target_facts=_tgt_facts())
    assert dec.outcome == "compatible"
    assert "claimed_wattage_covers_target" in dec.reason_codes, dec


def test_claimed_watt_below_target():
    dec = pr.resolve_compat(
        subject_id="i:1", target="device:dev-x", relation="charges",
        subject_facts=_subject(claimed=65.0), target_facts=_tgt_facts())
    assert "claimed_insufficient_wattage" in dec.reason_codes, dec


def test_structured_watt_beats_claimed():
    dec = pr.resolve_compat(
        subject_id="i:1", target="device:dev-x", relation="charges",
        subject_facts=_subject(structured=(65.0,), claimed=240.0),
        target_facts=_tgt_facts())
    assert "insufficient_wattage" in dec.reason_codes, dec
    assert not any(r.startswith("claimed_") for r in dec.reason_codes)


def test_no_watt_anywhere_still_missing():
    dec = pr.resolve_compat(
        subject_id="i:1", target="device:dev-x", relation="charges",
        subject_facts=_subject(), target_facts=_tgt_facts())
    assert "missing_wattage_evidence" in dec.reason_codes, dec


def test_claimed_segment_names_source():
    v = ac.CompatVerdict(
        need_index=0, subject_id="i:1", subject_name="CMC615P",
        target="xiaomi 17 ultra", relation="charges",
        decision=pr.CompatDecision(
            "compatible", (), ("connector_match",
                               "claimed_wattage_covers_target")))
    seg = ac._compat_segment(v)
    assert "ใช้งานร่วมกับ" in seg and "ข้อมูลสินค้า" in seg, seg
    assert "ยืนยันไม่ได้" not in seg


def test_claimed_below_segment_warns():
    v = ac.CompatVerdict(
        need_index=0, subject_id="i:1", subject_name="หัวชาร์จ 20W",
        target="xiaomi 17 ultra", relation="charges",
        decision=pr.CompatDecision(
            "compatible", (), ("connector_match",
                               "claimed_insufficient_wattage")))
    seg = ac._compat_segment(v)
    assert "ต่ำกว่า" in seg or "ช้ากว่า" in seg, seg


# ── F3 — unanswered wording ─────────────────────────────────────────────────

def test_unanswered_ask_says_not_listed():
    u = ac.UnansweredNeed(0, "product", "compat", (), ("สตาวา",), None,
                          "no_evidence",
                          capability_asks=("เชื่อมเข้ากับแอปสตาวา",))
    seg = ac._unanswered_segment(u)
    assert "ไม่มีระบุ" in seg, seg
    assert "ไม่สามารถยืนยัน" in seg, seg  # outcome ต้องชัด ไม่หายเงียบ
    assert "ไม่มีข้อมูลยืนยันจากข้อมูลสินค้าที่มี" not in seg


# ── F4 — confirmed-alternatives ใน unanswered asks ───────────────────────────

def test_declared_apps_from_desc_text():
    card = {"name": "IMILAB W01 สมาร์ทวอทช์",
            "description_excerpt":
                "ตัวเรือนน้ำหนักเบา 38 กรัม\n"
                "- รองรับแอปฯ Imilab Fit , Glory Fit ตั้งค่า "
                "ดูข้อมูลเพิ่มเติมได้ละเอียดขึ้น\n"}
    assert pr.declared_compat_targets(card) == ("Imilab Fit", "Glory Fit")


def test_declared_apps_none_when_no_pattern():
    card = {"name": "สายชาร์จ USB-C",
            "description_excerpt": "สายชาร์จเร็ว 240W รองรับ PD3.1"}
    assert pr.declared_compat_targets(card) == ()


def test_declared_apps_ignore_thai_following_text():
    card = {"description_excerpt": "ใช้แอปนี้ตั้งค่าง่ายมาก แอปพลิเคชันนี้ฟรี"}
    assert pr.declared_compat_targets(card) == ()


def test_declared_device_targets_from_name():
    # spec-db key ที่ card text ประกาศตรง → declared target
    card = {"name": "สายชาร์จ ใช้ร่วมกับ iPhone 15 Pro Max",
            "description_excerpt": ""}
    tgts = pr.declared_compat_targets(card)
    assert any("iphone 15" in t for t in tgts), tgts


def test_unanswered_renders_confirmed_targets():
    u = ac.UnansweredNeed(0, "product", "compat", ("i:1",), ("W01",),
                          "สตาวา", "no_evidence",
                          capability_asks=("เชื่อมเข้ากับแอปสตาวา",),
                          confirmed_targets=("Imilab Fit", "Glory Fit"))
    seg = ac._unanswered_segment(u)
    assert "ไม่มีระบุ" in seg, seg          # ตอบตรงว่าไม่มีข้อมูลของ ask
    assert "Imilab Fit" in seg and "Glory Fit" in seg, seg
    assert "Strava" not in seg or "สตาวา" in seg  # ไม่สลับคำตอบ
