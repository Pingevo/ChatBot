"""Test 200 ข้อ — ครอบคลุมทุก scenario

รัน: .venv/bin/python test/test_200.py
"""

import json
import time
import sys
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULT_FILE = ROOT / "testresult" / "test_200_results.json"

BASE = "http://127.0.0.1:8010"
SECRET = "dev-secret"

# ── ร้านทั้งหมด (33 ร้าน) ──
SHOPS = [
    "70MaiOfficialStore", "BearThailandOfficial", "BinnifaOfficialStore",
    "BlackShark", "CukTechThailand", "FreetieThailand", "GodungIT",
    "IMILabThailand", "IceShoppingMall", "KieslectThailand", "KingGadgets",
    "KospetThailand", "LagenioThailand", "LeravanOfficialStore", "LuckyHomeMart",
    "LydstoThailand", "MiLiThailand", "MibroThailandOfficial", "QCYThailand",
    "QKZOfficialStore", "SuperAudio", "SuperITMall", "ThaiSuperCam",
    "ThaiSuperPhone", "TicWatchThailand", "XiaoVVThailand", "XiaomiEcoSystem",
    "Yaber", "YoupinOfficialStore", "YunmaiThailand", "ZMIThailand", "Ztec", "iSuper",
]

# ── คำถาม 200 ข้อ ──
# (shop, message, history, category, expected_min_products)
TESTS = [

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 1: คำถามทั่วไป (general questions) — 20 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "มีสินค้าอะไรบ้าง", [], "general", 0),
    ("CukTechThailand", "ร้านนี้ขายอะไร", [], "general", 0),
    ("XiaomiEcoSystem", "มีแบรนด์อะไรบ้าง", [], "general", 0),
    ("ThaiSuperPhone", "มีหมวดหมู่อะไรบ้าง", [], "general", 0),
    ("IMILabThailand", "ส่งกี่วัน", [], "general", 0),
    ("CukTechThailand", "มีรับคืนไหม", [], "general", 0),
    ("XiaomiEcoSystem", "นโยบายรับประกันเป็นยังไง", [], "general", 0),
    ("SuperITMall", "ออกใบกำกับภาษีได้ไหม", [], "general", 0),
    ("CukTechThailand", "ส่งฟรีไหม", [], "general", 0),
    ("LagenioThailand", "เปิดทำการกี่โมง", [], "general", 0),
    ("QCYThailand", "มีสินค้าใหม่ๆ ไหม", [], "general", 0),
    ("Yaber", "ร้านนี้ขายอะไรเป็นหลัก", [], "general", 0),
    ("ZMIThailand", "มีโปรโมชันไหม", [], "general", 0),
    ("CukTechThailand", "จัดส่งกี่วัน", [], "general", 0),
    ("MiLiThailand", "มีของแถมไหม", [], "general", 0),
    ("KingGadgets", "รับประกันกี่ปี", [], "general", 0),
    ("YoupinOfficialStore", "มีสาขาไหม", [], "general", 0),
    ("CukTechThailand", "ติดต่อยังไง", [], "general", 0),
    ("ThaiSuperPhone", "ส่งไปต่างจังหวัดไหม", [], "general", 0),
    ("BlackShark", "มีส่วนลดไหม", [], "general", 0),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 2: พิมพ์ผิด (typos) — 20 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "มีสายชาร์จไหม", [], "typo", 1),
    ("CukTechThailand", "มีสายชาร์ตไหม", [], "typo", 1),
    ("CukTechThailand", "มีสายชาาร์จไหม", [], "typo", 1),
    ("CukTechThailand", "มีสายชาร์จจไหม", [], "typo", 1),
    ("CukTechThailand", "มีหัวชาจไหม", [], "typo", 1),
    ("CukTechThailand", "มีหัวชารไหม", [], "typo", 1),
    ("CukTechThailand", "มีหัวชาจะไหม", [], "typo", 1),
    ("ThaiSuperPhone", "มีโทสับไหม", [], "typo", 1),
    ("ThaiSuperPhone", "มีโทสัพท์ไหม", [], "typo", 1),
    ("ThaiSuperPhone", "มีมือถุบไหม", [], "typo", 1),
    ("QCYThailand", "มีหูฟังไหม", [], "typo", 1),
    ("QCYThailand", "มีหูฟัง TWS ไหม", [], "typo", 1),
    ("XiaomiEcoSystem", "มีพาวเวอร์แบงค์ไหม", [], "typo", 1),
    ("XiaomiEcoSystem", "มีพาวเวอร์แบงไหม", [], "typo", 1),
    ("IMILabThailand", "มีกล้องวงจรปิดไหม", [], "typo", 1),
    ("CukTechThailand", "มีสายชารตไหม", [], "typo", 1),
    ("CukTechThailand", "หัวชารจ 65w มีไหม", [], "typo", 1),
    ("CukTechThailand", "สายชารจ c to c มีไหม", [], "typo", 1),
    ("LagenioThailand", "มีนาฬิกาโทรศัพท์ไหม", [], "typo", 1),
    ("SuperITMall", "มีแท็บเล็ตไหม", [], "typo", 1),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 3: ไทยปนอังกฤษ (mixed language) — 20 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "มี cable type-c ไหม", [], "mixed", 1),
    ("CukTechThailand", "มี charger 65w ไหม", [], "mixed", 1),
    ("CukTechThailand", "มี adapter gan ไหม", [], "mixed", 1),
    ("CukTechThailand", "มี powerbank 10000mAh ไหม", [], "mixed", 1),
    ("QCYThailand", "มี earbuds ไหม", [], "mixed", 1),
    ("QCYThailand", "มี TWS earphone ไหม", [], "mixed", 1),
    ("XiaomiEcoSystem", "มี smartwatch ไหม", [], "mixed", 1),
    ("XiaomiEcoSystem", "มี power bank 20000mAh ไหม", [], "mixed", 1),
    ("ThaiSuperPhone", "มี phone ราคาถูกไหม", [], "mixed", 1),
    ("IMILabThailand", "มี camera ไหม", [], "mixed", 1),
    ("CukTechThailand", "มี USB-C to lightning cable ไหม", [], "mixed", 1),
    ("CukTechThailand", "มีสาย USB-C to USB-C ไหม", [], "mixed", 1),
    ("CukTechThailand", "หัวชาร์จ PD 100W มีไหม", [], "mixed", 1),
    ("Yaber", "มี projector ไหม", [], "mixed", 1),
    ("LeravanOfficialStore", "มี massage pillow ไหม", [], "mixed", 1),
    ("KospetThailand", "มี smart watch รองรับ 4G ไหม", [], "mixed", 1),
    ("TicWatchThailand", "มี smartwatch AMOLED ไหม", [], "mixed", 1),
    ("MibroThailandOfficial", "มี smart band ไหม", [], "mixed", 1),
    ("LydstoThailand", "มี robot vacuum ไหม", [], "mixed", 1),
    ("YunmaiThailand", "มี body fat scale ไหม", [], "mixed", 1),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 4: ถามระยะเวลารับประกัน (warranty duration) — 20 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "สาย C to C รับประกันกี่ปี", [], "warranty_duration", 0),
    ("CukTechThailand", "CL315P รับประกันกี่ปี", [], "warranty_duration", 0),
    ("CukTechThailand", "หัวชาร์จ 65W รับประกันกี่เดือน", [], "warranty_duration", 0),
    ("CukTechThailand", "CTC615W รับประกันนานเท่าไหร่", [], "warranty_duration", 0),
    ("CukTechThailand", "พาวเวอร์แบงค์รับประกันกี่ปี", [], "warranty_duration", 0),
    ("XiaomiEcoSystem", "Mi Band รับประกันกี่ปี", [], "warranty_duration", 0),
    ("QCYThailand", "หูฟัง QCY รับประกันกี่เดือน", [], "warranty_duration", 0),
    ("IMILabThailand", "กล้อง IMILAB รับประกันกี่ปี", [], "warranty_duration", 0),
    ("ThaiSuperPhone", "โทรศัพท์รับประกันกี่ปี", [], "warranty_duration", 0),
    ("SuperITMall", "แท็บเล็ตรับประกันกี่ปี", [], "warranty_duration", 0),
    ("CukTechThailand", "สายชาร์จรับประกันกี่ปี", [], "warranty_duration", 0),
    ("CukTechThailand", "หัวชาร์จรับประกันกี่ปี", [], "warranty_duration", 0),
    ("ZMIThailand", "พาวเวอร์แบงค์ ZMI รับประกันกี่ปี", [], "warranty_duration", 0),
    ("LagenioThailand", "นาฬิกาโทรศัพท์รับประกันกี่ปี", [], "warranty_duration", 0),
    ("KospetThailand", "สมาร์ทวอช KOSPET รับประกันกี่ปี", [], "warranty_duration", 0),
    ("TicWatchThailand", "TicWatch รับประกันกี่ปี", [], "warranty_duration", 0),
    ("Yaber", "โปรเจคเตอร์ Yaber รับประกันกี่ปี", [], "warranty_duration", 0),
    ("70MaiOfficialStore", "กล้อง 70mai รับประกันกี่ปี", [], "warranty_duration", 0),
    ("BearThailandOfficial", "เครื่องใช้ไฟฟ้า Bear รับประกันกี่ปี", [], "warranty_duration", 0),
    ("BinnifaOfficialStore", "ลำโพง Binnifa รับประกันกี่ปี", [], "warranty_duration", 0),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 5: แจ้งเคลม/สินค้าเสีย (warranty claim) — 20 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "สายชาร์จเสีย จะเคลมยังไง", [], "claim", 0),
    ("CukTechThailand", "หัวชาร์จพัง ทำเคลมได้ไหม", [], "claim", 0),
    ("CukTechThailand", "สินค้าเสีย อยากเปลี่ยนใหม่", [], "claim", 0),
    ("CukTechThailand", "พาวเวอร์แบงค์ไม่ทำงาน จะส่งเคลม", [], "claim", 0),
    ("XiaomiEcoSystem", "Mi Band หน้าจอแตก เคลมได้ไหม", [], "claim", 0),
    ("QCYThailand", "หูฟังเสียงข้างซ้ายไม่ดัง เคลมได้ไหม", [], "claim", 0),
    ("IMILabThailand", "กล้องไม่บันทึกวิดีโอ จะเคลม", [], "claim", 0),
    ("ThaiSuperPhone", "โทรศัพท์ชาร์จไม่เข้า ส่งซ่อมได้ไหม", [], "claim", 0),
    ("CukTechThailand", "สายชาร์จใช้ได้ไม่กี่เดือนพัง เคลมได้ไหม", [], "claim", 0),
    ("CukTechThailand", "ซื้อไป 3 เดือน หัวชาร์จเสีย เคลมได้ไหม", [], "claim", 0),
    ("LagenioThailand", "นาฬิกาเด็กเสีย จะส่งซ่อม", [], "claim", 0),
    ("KospetThailand", "สมาร์ทวอชเสีย ทำเคลมยังไง", [], "claim", 0),
    ("Yaber", "โปรเจคเตอร์ไมออน อยากส่งซ่อม", [], "claim", 0),
    ("70MaiOfficialStore", "กล้อง dashcam ไม่ทำงาน เคลมได้ไหม", [], "claim", 0),
    ("ZMIThailand", "พาวเวอร์แบงค์ไม่ชาร์จ เคลมได้ไหม", [], "claim", 0),
    ("CukTechThailand", "สินค้ามีตำหนิ อยากเปลี่ยนของใหม่", [], "claim", 0),
    ("CukTechThailand", "ขอเคลมสินค้า ซื้อวันที่ 1 ม.ค. หมายเลขคำสั่งซื้อ 123456789shp", [], "claim", 0),
    ("CukTechThailand", "ส่งของมาเคลมแล้ว ยังไม่ได้ข่าว", [], "claim", 0),
    ("SuperITMall", "แท็บเล็ตจอเสีย จะเคลม", [], "claim", 0),
    ("TicWatchThailand", "TicWatch แบตเสื่อม เคลมได้ไหม", [], "claim", 0),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 6: ถาม compatibility (รองรับอุปกรณ์เก่า/ใหม่) — 20 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "สายชาร์จรองรับ iPhone 17 ProMax ไหม", [], "compat", 1),
    ("CukTechThailand", "สาย C to C ใช้กับ Samsung S25 Ultra ได้ไหม", [], "compat", 1),
    ("CukTechThailand", "หัวชาร์จ 65W รองรับ iPhone 16 ไหม", [], "compat", 1),
    ("CukTechThailand", "สายชาร์จใช้กับ iPad ได้ไหม", [], "compat", 1),
    ("CukTechThailand", "สายชาร์จรองรับ iPhone 4s ไหม", [], "compat", 1),
    ("CukTechThailand", "สายชาร์จใช้กับโทรศัพท์รุ่นเก่าได้ไหม", [], "compat", 1),
    ("CukTechThailand", "หัวชาร์จรองรับ Samsung A05 ไหม", [], "compat", 1),
    ("CukTechThailand", "สาย C to Lightning ใช้กับ iPhone 14 ได้ไหม", [], "compat", 1),
    ("CukTechThailand", "พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม", [], "compat", 1),
    ("CukTechThailand", "หัวชาร์จ 100W รองรับโน้ตบุ๊กไหม", [], "compat", 1),
    ("XiaomiEcoSystem", "Mi Band 9 ใช้กับ iPhone ได้ไหม", [], "compat", 1),
    ("XiaomiEcoSystem", "สมาร์ทวอชใช้กับ Android ได้ไหม", [], "compat", 1),
    ("QCYThailand", "หูฟัง TWS ใช้กับ iPhone ได้ไหม", [], "compat", 1),
    ("QCYThailand", "หูฟังรองรับ Samsung ไหม", [], "compat", 1),
    ("IMILabThailand", "กล้องใช้กับ Android ได้ไหม", [], "compat", 1),
    ("IMILabThailand", "กล้องรองรับ iOS ไหม", [], "compat", 1),
    ("CukTechThailand", "สายชาร์จรองรับ Xiaomi 15 ไหม", [], "compat", 1),
    ("CukTechThailand", "หัวชาร์จใช้กับ Realme ได้ไหม", [], "compat", 1),
    ("CukTechThailand", "สาย C to C รองรับ OPPO ไหม", [], "compat", 1),
    ("CukTechThailand", "หัวชาร์จ PD ใช้กับ vivo ได้ไหม", [], "compat", 1),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 7: คำถามกำกวม (ambiguous) — 20 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "แบบไหนดี", [], "ambiguous", 0),
    ("CukTechThailand", "อันไหนแรงสุด", [], "ambiguous", 1),
    ("CukTechThailand", "อันไหนชาร์จไวสุด", [], "ambiguous", 1),
    ("CukTechThailand", "อันไหนจุเยอะสุด", [], "ambiguous", 1),
    ("CukTechThailand", "ตัวไหนคุ้มสุด", [], "ambiguous", 0),
    ("CukTechThailand", "หนักสุดกี่กรัม", [], "ambiguous", 0),
    ("CukTechThailand", "เบาสุดอันไหน", [], "ambiguous", 0),
    ("CukTechThailand", "ยาวสุดกี่เมตร", [], "ambiguous", 0),
    ("CukTechThailand", "สั้นสุดกี่เซนต์", [], "ambiguous", 0),
    ("CukTechThailand", "ราคาถูกสุด", [], "ambiguous", 0),
    ("XiaomiEcoSystem", "อันไหนขายดีสุด", [], "ambiguous", 0),
    ("QCYThailand", "อันไหนเสียงดีสุด", [], "ambiguous", 0),
    ("ThaiSuperPhone", "งบ 2000 มีอะไรให้เลือก", [], "ambiguous", 1),
    ("CukTechThailand", "งบ 500 มีอะไรไหม", [], "ambiguous", 1),
    ("CukTechThailand", "แนะนำหน่อย", [], "ambiguous", 0),
    ("CukTechThailand", "เอาที่ดีที่สุด", [], "ambiguous", 0),
    ("CukTechThailand", "มีแบบอื่นไหม", [], "ambiguous", 0),
    ("CukTechThailand", "เปลี่ยนรุ่นหน่อย", [], "ambiguous", 0),
    ("CukTechThailand", "มีใหม่กว่านี้ไหม", [], "ambiguous", 0),
    ("CukTechThailand", "เอาตัวเดิม", [], "ambiguous", 0),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 8: ถามต่อเนื่อง 20 คำถาม (follow-up chain) — 20 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "มีหัวชาร์จ 67W ไหม", [], "followup", 1),
    ("CukTechThailand", "แบบที่ใช้กับสาย c to c ด้วยนะ", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี CUKTECH A15C GaN3 67W และ BA651 Fusion"},
    ], "followup", 1),
    ("CukTechThailand", "เอาขึ้นเครื่องไปจีนด้วยได้อ่ะ", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี CUKTECH A15C GaN3 67W และ BA651 Fusion"},
        {"role": "user", "text": "แบบที่ใช้กับสาย c to c ด้วยนะ"},
        {"role": "model", "text": "BA651 Fusion 2-in-1 รองรับสาย C to C"},
    ], "followup", 1),
    ("CukTechThailand", "แบบนี้จุกี่ mAh", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี BA651 Fusion 2-in-1"},
    ], "followup", 1),
    ("CukTechThailand", "รับประกันกี่ปี", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี BA651 Fusion รับประกัน 2 ปี"},
    ], "followup", 0),
    ("CukTechThailand", "มีสีอื่นไหม", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี BA651 Fusion"},
    ], "followup", 0),
    ("CukTechThailand", "เอาตัวเดิมที่แนะนำนะ", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี CUKTECH A15C GaN3 67W"},
        {"role": "user", "text": "มีแบบ 2-in-1 ไหม"},
        {"role": "model", "text": "มี BA651 Fusion 2-in-1"},
    ], "followup", 1),
    ("CukTechThailand", "ขอรายละเอียดเพิ่ม", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี BA651 Fusion 67W 2-in-1"},
    ], "followup", 1),
    ("CukTechThailand", "ราคาเท่าไหร่", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี BA651 Fusion"},
    ], "followup", 0),
    ("CukTechThailand", "มีหัวอื่นอีกไหม", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C และ BA651"},
    ], "followup", 1),
    ("CukTechThailand", "ตัวนี้หนักกี่กรัม", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี BA651 Fusion"},
    ], "followup", 1),
    ("CukTechThailand", "ชาร์จ iPhone 17 ได้ไหม", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W"},
    ], "followup", 1),
    ("CukTechThailand", "ส่งกี่วัน", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W"},
    ], "followup", 0),
    ("CukTechThailand", "เคลมยังไง", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W รับประกัน 2 ปี"},
    ], "followup", 0),
    ("CukTechThailand", "มีชุดชาร์จไหม", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W"},
    ], "followup", 1),
    ("CukTechThailand", "แบบที่มีสายด้วย", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W"},
    ], "followup", 1),
    ("CukTechThailand", "เอาแค่หัวอย่างเดียว", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W และ BA651"},
    ], "followup", 1),
    ("CukTechThailand", "ตัวไหนเร็วกว่ากัน", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W และ BA651"},
    ], "followup", 1),
    ("CukTechThailand", "เปรียบเทียบให้หน่อย", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W และ BA651"},
    ], "followup", 1),
    ("CukTechThailand", "เอาอันแรกที่แนะนำ", [
        {"role": "user", "text": "มีหัวชาร์จ 67W ไหม"},
        {"role": "model", "text": "มี A15C 67W และ BA651"},
    ], "followup", 1),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 9: Lightning/ไลนิ่ง ลอยๆ (bug fix test) — 10 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "มีสายชาร์จไอแพดไหม", [], "lightning", 1),
    ("CukTechThailand", "แล้วมีที่เป็นไลนิ่งไหม", [
        {"role": "user", "text": "มีสายชาร์จไอแพดไหม"},
        {"role": "model", "text": "มีสาย C to C และ Lightning"},
    ], "lightning", 1),
    ("CukTechThailand", "แล้วสาย c to lightning ไม่มีหรอ", [
        {"role": "user", "text": "มีสายชาร์จไอแพดไหม"},
        {"role": "model", "text": "มีสาย C to C และ Lightning"},
        {"role": "user", "text": "แล้วมีที่เป็นไลนิ่งไหม"},
        {"role": "model", "text": "มีสาย USB-C to Lightning CL315P"},
    ], "lightning", 1),
    ("CukTechThailand", "a to lightning อะ", [
        {"role": "user", "text": "มีสายชาร์จไอแพดไหม"},
        {"role": "model", "text": "มี CL315P USB-C to Lightning"},
    ], "lightning", 1),
    ("CukTechThailand", "ไลนิ่ง", [], "lightning", 1),
    ("CukTechThailand", "lightning", [], "lightning", 1),
    ("CukTechThailand", "แบบไลนิ่ง", [], "lightning", 1),
    ("CukTechThailand", "มี lightning ไหม", [], "lightning", 1),
    ("CukTechThailand", "c to l มีไหม", [], "lightning", 1),
    ("CukTechThailand", "a to l มีไหม", [], "lightning", 1),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 10: ร้านอื่นๆ (อย่างน้อยร้านละ 1 ข้อ) — 33 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("70MaiOfficialStore", "มีกล้อง dashcam ไหม", [], "shop_variety", 1),
    ("BearThailandOfficial", "มีเครื่องใช้ไฟฟ้าอะไรบ้าง", [], "shop_variety", 0),
    ("BinnifaOfficialStore", "มีลำโพงบลูทูธไหม", [], "shop_variety", 1),
    ("BlackShark", "มีหูฟังเกมมิ่งไหม", [], "shop_variety", 1),
    ("CukTechThailand", "มีหัวชาร์จ GaN 240W ไหม", [], "shop_variety", 1),
    ("FreetieThailand", "มีสินค้าอะไรบ้าง", [], "shop_variety", 0),
    ("GodungIT", "มีอะไรขายบ้าง", [], "shop_variety", 0),
    ("IMILabThailand", "มีกล้องวงจรปิดไร้สายไหม", [], "shop_variety", 1),
    ("IceShoppingMall", "มีสินค้าอะไรบ้าง", [], "shop_variety", 0),
    ("KieslectThailand", "มีสมาร์ทวอชไหม", [], "shop_variety", 1),
    ("KingGadgets", "มีอุปกรณ์เสริมอะไรบ้าง", [], "shop_variety", 0),
    ("KospetThailand", "มีสมาร์ทวอชทนน้ำไหม", [], "shop_variety", 1),
    ("LagenioThailand", "มีนาฬิกาโทรศัพท์สำหรับเด็กไหม", [], "shop_variety", 1),
    ("LeravanOfficialStore", "มีเครื่องนวดไหม", [], "shop_variety", 1),
    ("LuckyHomeMart", "มีของใช้ในบ้านอะไรบ้าง", [], "shop_variety", 0),
    ("LydstoThailand", "มีเครื่องดูดฝุ่นไหม", [], "shop_variety", 1),
    ("MiLiThailand", "มีพาวเวอร์แบงค์ไหม", [], "shop_variety", 1),
    ("MibroThailandOfficial", "มีสมาร์ทวอชราคาถูกไหม", [], "shop_variety", 1),
    ("QCYThailand", "มีหูฟังบลูทูธไหม", [], "shop_variety", 1),
    ("QKZOfficialStore", "มีหูฟังมีสายไหม", [], "shop_variety", 1),
    ("SuperAudio", "มีลำโพงพกพาไหม", [], "shop_variety", 1),
    ("SuperITMall", "มีแท็บเล็ตไหม", [], "shop_variety", 1),
    ("ThaiSuperCam", "มีกล้องวงจรปิดไหม", [], "shop_variety", 1),
    ("ThaiSuperPhone", "มีโทรศัพท์มือถือไหม", [], "shop_variety", 1),
    ("TicWatchThailand", "มีสมาร์ทวอช GPS ไหม", [], "shop_variety", 1),
    ("XiaoVVThailand", "มีกล้องนิรภัยไหม", [], "shop_variety", 1),
    ("XiaomiEcoSystem", "มีนาฬิกา Xiaomi ไหม", [], "shop_variety", 1),
    ("Yaber", "มีโปรเจคเตอร์ไหม", [], "shop_variety", 1),
    ("YoupinOfficialStore", "มีสินค้า smart home ไหม", [], "shop_variety", 1),
    ("YunmaiThailand", "มีเครื่องชั่งไขมันไหม", [], "shop_variety", 1),
    ("ZMIThailand", "มีพาวเวอร์แบงค์ 10000mAh ไหม", [], "shop_variety", 1),
    ("Ztec", "มีหัวชาร์จ ZTEC ไหม", [], "shop_variety", 1),
    ("iSuper", "มีสินค้าอะไรบ้าง", [], "shop_variety", 0),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 11: สเปก/รายละเอียดสินค้า — 10 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "CTC615W สเปกอะไรบ้าง", [], "spec", 1),
    ("CukTechThailand", "BA651 รายละเอียดเต็ม", [], "spec", 1),
    ("CukTechThailand", "A15C กินไฟกี่วัตต์", [], "spec", 1),
    ("CukTechThailand", "CL315P ยาวกี่เมตร", [], "spec", 1),
    ("CukTechThailand", "พาวเวอร์แบงค์ 10000mAh มีกี่พอร์ต", [], "spec", 1),
    ("XiaomiEcoSystem", "Mi Band 9 สเปกหน้าจอ", [], "spec", 1),
    ("QCYThailand", "หูฟัง QCY แบตกี่ชั่วโมง", [], "spec", 1),
    ("IMILabThailand", "กล้อง IMILAB ความละเอียดกี่", [], "spec", 1),
    ("ThaiSuperPhone", "โทรศัพท์ RAM 8GB มีไหม", [], "spec", 1),
    ("KospetThailand", "สมาร์ทวอชแบตกี่ mAh", [], "spec", 1),

    # ═══════════════════════════════════════════════════════════════════
    # กลุ่ม 12: เปรียบเทียบสินค้า — 7 ข้อ
    # ═══════════════════════════════════════════════════════════════════
    ("CukTechThailand", "เปรียบเทียบ A15C กับ BA651", [], "compare", 1),
    ("CukTechThailand", "CTC615W กับ CTC610 ต่างกันยังไง", [], "compare", 1),
    ("CukTechThailand", "สาย C to C กับ C to Lightning ต่างกันไหม", [], "compare", 1),
    ("QCYThailand", "เปรียบเทียบหูฟัง TWS 2 รุ่น", [], "compare", 1),
    ("XiaomiEcoSystem", "Mi Band 8 กับ Mi Band 9 อันไหนดีกว่า", [], "compare", 1),
    ("ThaiSuperPhone", "เทียบโทรศัพท์ 2 รุ่น", [], "compare", 1),
    ("CukTechThailand", "หัวชาร์จ 65W กับ 100W อันไหนเหมาะกว่า", [], "compare", 1),
]


def call_chat(shop, message, history):
    """เรียก /chat แล้วคืนผล"""
    payload = json.dumps({
        "shop": shop,
        "message": message,
        "history": history or [],
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/chat",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Secret": SECRET,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "detail": e.read().decode()[:200]}
    except Exception as e:
        return {"error": str(e)}


def main():
    total = len(TESTS)
    print(f"🧪 เริ่มเทส {total} ข้อ\n")
    print(f"{'#':>3} {'shop':25s} {'cat':12s} {'src':20s} {'ws':5s} {'prod':>4s} {'time':>6s} {'ok':3s} answer[:80]")
    print("-" * 160)

    results = []
    pass_count = 0
    fail_count = 0
    error_count = 0
    cat_stats = {}

    for i, (shop, msg, history, cat, min_prod) in enumerate(TESTS, 1):
        t0 = time.time()
        d = call_chat(shop, msg, history)
        elapsed = time.time() - t0

        if "error" in d:
            error_count += 1
            ok = "ERR"
            answer = d["error"][:80]
            src = "-"
            ws = "-"
            nprod = 0
        else:
            answer = (d.get("answer") or "")[:80].replace("\n", " ")
            src = d.get("source", "?")
            ws = "Y" if d.get("web_search_used") else "N"
            nprod = len(d.get("products") or [])
            # ผ่านเกณฑ์: ไม่ error + (ถ้า min_prod > 0 ต้องมีสินค้า >= min_prod)
            ok = "✅" if (nprod >= min_prod or min_prod == 0) else "❌"
            if ok == "✅":
                pass_count += 1
            else:
                fail_count += 1

        # สถิติตามหมวด
        if cat not in cat_stats:
            cat_stats[cat] = {"pass": 0, "fail": 0, "error": 0}
        if ok == "✅":
            cat_stats[cat]["pass"] += 1
        elif ok == "❌":
            cat_stats[cat]["fail"] += 1
        else:
            cat_stats[cat]["error"] += 1

        print(f"{i:>3} {shop:25s} {cat:12s} {src:20s} {ws:5s} {nprod:>4d} {elapsed:>5.1f}s {ok:3s} {answer}")
        results.append({
            "i": i, "shop": shop, "msg": msg, "cat": cat,
            "source": src, "web_search": ws, "products": nprod,
            "elapsed": elapsed, "ok": ok, "answer": answer,
        })

    # ── สรุป ──
    print("\n" + "=" * 80)
    print(f"📊 สรุปผล: {total} ข้อ")
    print(f"   ✅ ผ่าน: {pass_count}")
    print(f"   ❌ ไม่ผ่าน: {fail_count}")
    print(f"   ⚠️  Error: {error_count}")
    print(f"   เวลารวม: {sum(r['elapsed'] for r in results):.1f}s")
    print(f"   เวลาเฉลี่ย: {sum(r['elapsed'] for r in results)/total:.1f}s/ข้อ")

    print(f"\n📈 สถิติตามหมวด:")
    print(f"{'cat':20s} {'pass':>5s} {'fail':>5s} {'err':>5s} {'total':>5s}")
    for cat in sorted(cat_stats.keys()):
        s = cat_stats[cat]
        t = s["pass"] + s["fail"] + s["error"]
        print(f"{cat:20s} {s['pass']:>5d} {s['fail']:>5d} {s['error']:>5d} {t:>5d}")

    # ── ข้อที่ไม่ผ่าน ──
    failed = [r for r in results if r["ok"] != "✅"]
    if failed:
        print(f"\n❌ ข้อที่ไม่ผ่าน ({len(failed)} ข้อ):")
        for r in failed:
            print(f"  #{r['i']:>3} [{r['cat']}] {r['shop']:25s} {r['msg'][:50]!r}")
            print(f"       source={r['source']} products={r['products']} answer={r['answer'][:60]}")

    # ── บันทึกผล ──
    with open(RESULT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n💾 บันทึกผลที่ {RESULT_FILE}")


if __name__ == "__main__":
    main()
