#!/usr/bin/env python3
"""Comprehensive test suite for shopeechatbot.
Tests all shops, product types, follow-ups, context switching, reference questions,
long chat sequences, edge cases, and regression.

Rate limit: 15 reqs/min → 4s delay between requests
Quota: 450 reqs/day
"""
import requests, time, json, os, sys
from datetime import datetime

URL = "http://127.0.0.1:8010/chat"
CHAT_HEADERS = {"X-Internal-Secret": os.environ.get("CHATBOT_INTERNAL_SECRET", "")}
DELAY = 4.2  # seconds between requests (15 reqs/min)
RESULTS_FILE = "/tmp/test_comprehensive_results.json"
WRONG_FILE = "/tmp/test_comprehensive_wrong.json"

results = []
wrong_cases = []
req_count = 0
MAX_REQS = 445  # leave 5 for safety

def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)

def chat(msg, history=None, shop=None, limit=10):
    """Send a chat request. Returns (answer, products, source, raw_json)."""
    global req_count
    if req_count >= MAX_REQS:
        log(f"MAX_REQS reached ({MAX_REQS}), stopping.")
        return "", [], "", {}
    req_count += 1
    payload = {"message": msg, "limit": limit, "history": history or []}
    if shop:
        payload["shop"] = shop
    try:
        r = requests.post(URL, json=payload, headers=CHAT_HEADERS, timeout=180)
        j = r.json()
        return j.get("answer",""), j.get("products",[]), j.get("source","?"), j
    except Exception as e:
        log(f"  ERROR: {e}")
        return f"ERROR: {e}", [], "error", {}

def record(test_id, category, msg, expected, answer, products, source, is_correct, notes=""):
    """Record a test result."""
    product_names = [p.get("name","")[:50] for p in products[:5]]
    entry = {
        "test_id": test_id,
        "category": category,
        "message": msg,
        "expected": expected,
        "answer_preview": answer[:200],
        "products": product_names,
        "product_count": len(products),
        "source": source,
        "is_correct": is_correct,
        "notes": notes,
        "timestamp": datetime.now().isoformat(),
    }
    results.append(entry)
    if not is_correct:
        wrong_cases.append(entry)
    status = "✅" if is_correct else "❌"
    log(f"  {status} [{test_id}] {msg[:40]} → {source} prods={len(products)}")
    if not is_correct:
        log(f"     EXPECTED: {expected[:80]}")
        log(f"     GOT: {answer[:80]}")
        if notes:
            log(f"     NOTES: {notes}")

def check_shop_match(products, expected_shop):
    """Check if products are from the expected shop."""
    if not products:
        return False
    for p in products:
        shop = p.get("shopname","") or p.get("shop","")
        if expected_shop.lower() in shop.lower():
            return True
    return False

def check_product_type(products, type_keywords):
    """Check if products match the expected type keywords."""
    if not products:
        return False
    for p in products:
        name = (p.get("name","") + " " + p.get("item_name","")).lower()
        if any(kw in name for kw in type_keywords):
            return True
    return False

def check_no_accessories(products, bad_keywords):
    """Check that no products contain accessory keywords."""
    for p in products:
        name = (p.get("name","") + " " + p.get("item_name","")).lower()
        if any(kw in name for kw in bad_keywords):
            return False
    return True

def check_answer_mentions(answer, keywords):
    """Check if answer mentions any of the keywords."""
    ans_lower = answer.lower()
    return any(kw.lower() in ans_lower for kw in keywords)

# ============================================================
# TEST SUITE
# ============================================================

def test_a_shop_specific():
    """ชุด A: ทดสอบแต่ละร้าน 25 ร้าน × 3 คำถาม = 75 reqs"""
    log("\n" + "="*60)
    log("ชุด A: ทดสอบร้านเดียว 25 ร้าน × 3 คำถาม")
    log("="*60)

    shops = [
        ("YoupinOfficialStore", ["มีอะไรขายบ้าง", "พัดลม xiaomi", "เครื่องกรองอากาศ"]),
        ("ThaiSuperPhone", ["มีนาฬิกาขายไหม", "หูฟัง 1more", "กล้อง imilab"]),
        ("SuperITMall", ["หูฟัง fiil", "หูฟัง mpow", "หูฟังเล่นเกม"]),
        ("KingGadgets", ["หูฟัง nuheara", "กล้อง ticwatch", "70mai dashcam"]),
        ("LuckyHomeMart", ["เครื่องนวด leravan", "แฟลชไดร์ฟ netac", "ที่นวด"]),
        ("ZMIThailand", ["หัวชาร์จ zmi", "ลำโพง zmi", "สายชาร์จ"]),
        ("CukTechThailand", ["หัวชาร์จ cuktech", "เคส torras", "ชาร์จ gan"]),
        ("Ztec", ["สายชาร์จ ztec", "แบตสำรอง ztec", "hub ztec"]),
        ("XiaomiEcoSystem", ["พัดลม xiaomi", "ไส้กรอง air purifier", "เครื่องชั่ง xiaomi"]),
        ("iSuper", ["หูฟัง isuper", "เครื่องดูดไรฝุ่น", "ไส้กรอง hepa"]),
        ("BlackShark", ["นาฬิกา black shark", "สมาร์ทวอทช์ gs3", "หูฟังเกม"]),
        ("IMILabThailand", ["กล้องวงจรปิด imilab", "imilab ec6", "สมาร์ทวอทช์ imilab"]),
        ("LeravanOfficialStore", ["หมอนรองคอ leravan", "เครื่องนวด", "หมอนนวด"]),
        ("LydstoThailand", ["เครื่องดูดฝุ่น lydsto", "อินเวอร์เตอร์", "เครื่องดูด"]),
        ("MiLiThailand", ["gps tracker mili", "mitag duo", "micard duo"]),
        ("KospetThailand", ["นาฬิกา kospet", "kospet tank", "สมาร์ทวอทช์ kospet"]),
        ("Yaber", ["โปรเจคเตอร์ yaber", "จอโปรเจคเตอร์", "yaber k1"]),
        ("QKZOfficialStore", ["หูฟัง 1more", "หูฟัง qcc", "หูฟัง tws"]),
        ("LagenioThailand", ["นาฬิกาเด็ก lagenio", "lagenio k9", "smartwatch เด็ก"]),
        ("KieslectThailand", ["นาฬิกา kieslect", "kieslect ks3", "kieslect actor"]),
        ("XiaoVVThailand", ["กล้องวงจรปิด xiaovv", "xiaovv c1", "cctv wifi"]),
        ("70MaiOfficialStore", ["70mai air compressor", "70mai gps module", "dashcam 70mai"]),
        ("BinnifaOfficialStore", ["ลำโพง binnifa", "ซาวด์บาร์", "binnifa live"]),
        ("ThaiSuperCam", ["กล้องวงจรปิด xiaovv", "dashcam isuper", "กล้องติดรถยนต์"]),
        ("YunmaiThailand", ["เครื่องชั่ง yunmai", "เครื่องชั่งอัจฉริยะ", "smart scale"]),
    ]

    for shop, questions in shops:
        log(f"\n--- ร้าน: {shop} ---")
        for i, q in enumerate(questions):
            test_id = f"A-{shop}-{i+1}"
            ans, prods, src, _ = chat(q, shop=shop)
            # Check: products should be from this shop
            shop_ok = check_shop_match(prods, shop)
            has_prods = len(prods) > 0
            is_correct = shop_ok and has_prods
            notes = ""
            if not has_prods:
                notes = "ไม่มีสินค้า"
            elif not shop_ok:
                notes = f"สินค้าไม่ใช่ของร้าน {shop}"
            record(test_id, "shop_specific", q, f"สินค้าจาก {shop}", ans, prods, src, is_correct, notes)
            time.sleep(DELAY)

def test_b_all_shops_types():
    """ชุด B: รวมทุกร้าน ตามประเภทสินค้า 20 reqs"""
    log("\n" + "="*60)
    log("ชุด B: รวมทุกร้าน ตามประเภทสินค้า")
    log("="*60)

    type_tests = [
        ("มีนาฬิกาขายไหม", ["นาฬิกา","สมาร์ทวอทช์","watch","smartwatch"], ["สายนาฬิกา","strap","สาย นาฬิกา"]),
        ("มีโทรศัพท์มือถือไหม", ["โทรศัพท์","phone","smartphone","redmi"], ["ชาร์จ","สายชาร์จ","เคส","ฟิล์ม"]),
        ("มีหูฟังไหม", ["หูฟัง","earphone","earbuds","tws","หูฟังบลูทูธ"], ["เคสหูฟัง","case"]),
        ("มีแบตสำรองไหม", ["แบตสำรอง","powerbank","power bank"], ["สายชาร์จ","หัวชาร์จ"]),
        ("มีหัวชาร์จไหม", ["ชาร์จ","charger","หัวชาร์จ","gan"], ["สายชาร์จ","แบตสำรอง"]),
        ("มีกล้องวงจรปิดไหม", ["กล้องวงจรปิด","cctv","กล้อง","camera"], ["ไส้กรอง","ฟิล์ม"]),
        ("มีพัดลมไหม", ["พัดลม","fan"], ["ไส้กรอง","ฟิล์ม"]),
        ("มีเครื่องดูดฝุ่นไหม", ["เครื่องดูดฝุ่น","vacuum","ดูดฝุ่น"], ["ไส้กรอง","ฟิล์ม"]),
        ("มีโปรเจคเตอร์ไหม", ["โปรเจคเตอร์","projector"], ["จอ","ขาตั้ง"]),
        ("มีเครื่องนวดไหม", ["นวด","massage","หมอน"], ["ไส้กรอง","ฟิล์ม"]),
        ("มีลำโพงไหม", ["ลำโพง","speaker","ซาวด์บาร์"], ["สายชาร์จ","หัวชาร์จ"]),
        ("มีสายชาร์จไหม", ["สายชาร์จ","cable","สาย type c"], ["หัวชาร์จ","แบตสำรอง"]),
        ("มีเครื่องชั่งไหม", ["เครื่องชั่ง","scale","ชั่งน้ำหนัก"], ["ไส้กรอง","ฟิล์ม"]),
        ("มี gps tracker ไหม", ["gps","tracker","ติดตาม"], ["ไส้กรอง","ฟิล์ม"]),
        ("มี dashcam ไหม", ["dashcam","กล้องติดรถยนต์","dash cam"], ["ไส้กรอง","ฟิล์ม"]),
        ("มีไส้กรอง air purifier ไหม", ["ไส้กรอง","filter","air purifier"], ["พัดลม"]),
        ("มีอินเวอร์เตอร์ไหม", ["อินเวอร์เตอร์","inverter","แปลงไฟ"], ["เครื่องดูด"]),
        ("มีไมโครโฟนไหม", ["ไมโครโฟน","microphone","ไมค์"], ["หูฟัง"]),
        ("มีแฟลชไดร์ฟไหม", ["แฟลชไดร์ฟ","flash drive","usb"], ["sd card","memory card"]),
        ("มี sd card ไหม", ["sd card","memory card","การ์ดหน่วยความจำ"], ["แฟลชไดร์ฟ"]),
    ]

    for i, (q, good_kw, bad_kw) in enumerate(type_tests):
        test_id = f"B-{i+1}"
        ans, prods, src, _ = chat(q)
        has_prods = len(prods) > 0
        type_ok = check_product_type(prods, good_kw)
        no_acc = check_no_accessories(prods, bad_kw)
        is_correct = has_prods and type_ok and no_acc
        notes = ""
        if not has_prods:
            notes = "ไม่มีสินค้า"
        elif not type_ok:
            notes = f"สินค้าไม่ตรงประเภท (expected: {good_kw[:3]})"
        elif not no_acc:
            notes = f"มี accessories ปน (bad: {bad_kw[:3]})"
        record(test_id, "all_shops_type", q, f"สินค้าประเภท {good_kw[:2]}", ans, prods, src, is_correct, notes)
        time.sleep(DELAY)

def test_c_followup_sequences():
    """ชุด C: follow-up sequences 10 sequences × 4 steps = 40 reqs"""
    log("\n" + "="*60)
    log("ชุด C: follow-up sequences")
    log("="*60)

    sequences = [
        # C1: นาฬิกา → เดินป่า → แบตอึด → รายละเอียด
        [("kospet มีนาฬิกาขายไหม", "นาฬิกา KOSPET"),
         ("เหมาะกับการเดินป่า", "KOSPET TANK สายลุย"),
         ("แบตอึดๆ", "KOSPET TANK ไม่ใช่ powerbank"),
         ("ขอรายละเอียดสินค้าได้ไหม", "รายละเอียด KOSPET")],
        # C2: หูฟัง → งบ → เปรียบเทียบ → รับประกัน
        [("มีหูฟังไหม", "หูฟัง"),
         ("งบ 500-1500", "หูฟังในงบ"),
         ("เปรียบเทียบให้หน่อย", "เปรียบเทียบหูฟัง"),
         ("รับประกันยังไง", "รับประกันหูฟัง")],
        # C3: กล้อง → นอกบ้าน → กันน้ำ → ราคา
        [("มีกล้องวงจรปิดไหม", "กล้อง CCTV"),
         ("เอาแบบตั้งนอกบ้าน", "กล้องนอกบ้าน"),
         ("กันน้ำไหม", "กล้องกันน้ำ"),
         ("ราคาเท่าไหร่", "ราคากล้อง")],
        # C4: โทรศัพท์ → งบ → รับประกัน → เปรียบเทียบ
        [("มีโทรศัพท์ขายไหม", "โทรศัพท์"),
         ("งบ 2000", "โทรศัพท์งบ 2000"),
         ("รับประกันยังไง", "รับประกันโทรศัพท์"),
         ("มีรุ่นอื่นแนะนำไหม", "โทรศัพท์รุ่นอื่น")],
        # C5: พัดลม → ประหยัดไฟ → รายละเอียด → จัดส่ง
        [("มีพัดลมไหม", "พัดลม"),
         ("แบบประหยัดไฟ", "พัดลมประหยัดไฟ"),
         ("ขอรายละเอียด", "รายละเอียดพัดลม"),
         ("จัดส่งยังไง", "นโยบายจัดส่ง")],
        # C6: แบตสำรอง → 10000mAh → เร็ว → รายละเอียด
        [("มีแบตสำรองไหม", "แบตสำรอง"),
         ("10000mAh", "แบต 10000mAh"),
         ("ชาร์จเร็ว", "แบตชาร์จเร็ว"),
         ("ขอรายละเอียด", "รายละเอียดแบต")],
        # C7: เครื่องดูดฝุ่น → ไร้สาย → ราคา → รับประกัน
        [("มีเครื่องดูดฝุ่นไหม", "เครื่องดูดฝุ่น"),
         ("แบบไร้สาย", "เครื่องดูดไร้สาย"),
         ("ราคาเท่าไหร่", "ราคาเครื่องดูด"),
         ("รับประกันยังไง", "รับประกันเครื่องดูด")],
        # C8: โปรเจคเตอร์ → 1080p → รายละเอียด → จัดส่ง
        [("มีโปรเจคเตอร์ไหม", "โปรเจคเตอร์"),
         ("1080p", "โปรเจคเตอร์ 1080p"),
         ("ขอรายละเอียด", "รายละเอียดโปรเจคเตอร์"),
         ("จัดส่งยังไง", "นโยบายจัดส่ง")],
        # C9: นาฬิกาเด็ก → โทรได้ → GPS → รายละเอียด
        [("มีนาฬิกาเด็กไหม", "นาฬิกาเด็ก"),
         ("โทรได้", "นาฬิกาเด็กโทรได้"),
         ("มีGPSไหม", "นาฬิกาเด็ก GPS"),
         ("ขอรายละเอียด", "รายละเอียดนาฬิกาเด็ก")],
        # C10: หัวชาร์จ → GaN → 65W → รายละเอียด
        [("มีหัวชาร์จไหม", "หัวชาร์จ"),
         ("GaN", "หัวชาร์จ GaN"),
         ("65W", "หัวชาร์จ 65W"),
         ("ขอรายละเอียด", "รายละเอียดหัวชาร์จ")],
    ]

    for seq_idx, sequence in enumerate(sequences):
        log(f"\n--- C{seq_idx+1} ---")
        history = []
        for step_idx, (msg, expected) in enumerate(sequence):
            test_id = f"C{seq_idx+1}-{step_idx+1}"
            ans, prods, src, _ = chat(msg, history=history.copy())
            has_prods = len(prods) > 0
            is_correct = has_prods or "จัดส่ง" in expected or "นโยบาย" in expected
            notes = ""
            if not has_prods and "นโยบาย" not in expected:
                notes = "ไม่มีสินค้าใน follow-up"
            record(test_id, "followup", msg, expected, ans, prods, src, is_correct, notes)
            history.append({"role":"user","text":msg})
            history.append({"role":"model","text":ans})
            time.sleep(DELAY)

def test_d_context_switching():
    """ชุด D: context switching 10 sequences × 3 steps = 30 reqs"""
    log("\n" + "="*60)
    log("ชุด D: context switching (เปลี่ยนหัวข้อ)")
    log("="*60)

    sequences = [
        # D1: นาฬิกา → โทรศัพท์ → หูฟัง
        [("มีนาฬิกาขายไหม", "นาฬิกา"),
         ("มีโทรศัพท์ไหม", "โทรศัพท์ (ไม่ใช่นาฬิกา)"),
         ("มีหูฟังไหม", "หูฟัง (ไม่ใช่โทรศัพท์)")],
        # D2: กล้อง → พัดลม → แบตสำรอง
        [("มีกล้องวงจรปิดไหม", "กล้อง"),
         ("มีพัดลมไหม", "พัดลม (ไม่ใช่กล้อง)"),
         ("มีแบตสำรองไหม", "แบตสำรอง (ไม่ใช่พัดลม)")],
        # D3: imilab ec6 → lagenio k9 รับประกัน → kospet นาฬิกา
        [("imilab ec6", "IMILAB EC6"),
         ("lagenio k9 รับประกัน", "Lagenio K9 (ไม่ใช่ IMILAB)"),
         ("kospet มีนาฬิกาขายไหม", "KOSPET (ไม่ใช่ Lagenio)")],
        # D4: หูฟัง → นาฬิกา → กล้อง
        [("มีหูฟังไหม", "หูฟัง"),
         ("มีนาฬิกาขายไหม", "นาฬิกา (ไม่ใช่หูฟัง)"),
         ("มีกล้องวงจรปิดไหม", "กล้อง (ไม่ใช่นาฬิกา)")],
        # D5: เครื่องนวด → โปรเจคเตอร์ → ลำโพง
        [("มีเครื่องนวดไหม", "เครื่องนวด"),
         ("มีโปรเจคเตอร์ไหม", "โปรเจคเตอร์ (ไม่ใช่เครื่องนวด)"),
         ("มีลำโพงไหม", "ลำโพง (ไม่ใช่โปรเจคเตอร์)")],
        # D6: แบต → สายชาร์จ → หัวชาร์จ
        [("มีแบตสำรองไหม", "แบตสำรอง"),
         ("มีสายชาร์จไหม", "สายชาร์จ (ไม่ใช่แบต)"),
         ("มีหัวชาร์จไหม", "หัวชาร์จ (ไม่ใช่สาย)")],
        # D7: kospet → black shark → kieslect
        [("kospet นาฬิกา", "KOSPET"),
         ("black shark นาฬิกา", "Black Shark (ไม่ใช่ KOSPET)"),
         ("kieslect นาฬิกา", "Kieslect (ไม่ใช่ Black Shark)")],
        # D8: เครื่องดูด → เครื่องชั่ง → gps tracker
        [("มีเครื่องดูดฝุ่นไหม", "เครื่องดูดฝุ่น"),
         ("มีเครื่องชั่งไหม", "เครื่องชั่ง (ไม่ใช่เครื่องดูด)"),
         ("มี gps tracker ไหม", "GPS tracker (ไม่ใช่เครื่องชั่ง)")],
        # D9: dashcam → กล้องในบ้าน → กล้องนอกบ้าน
        [("มี dashcam ไหม", "dashcam"),
         ("มีกล้องในบ้านไหม", "กล้องในบ้าน"),
         ("มีกล้องนอกบ้านไหม", "กล้องนอกบ้าน")],
        # D10: โทรศัพท์ → นาฬิกา → หูฟัง → แบต
        [("มีโทรศัพท์ไหม", "โทรศัพท์"),
         ("มีนาฬิกาขายไหม", "นาฬิกา (ไม่ใช่โทรศัพท์)"),
         ("มีหูฟังไหม", "หูฟัง (ไม่ใช่นาฬิกา)")],
    ]

    for seq_idx, sequence in enumerate(sequences):
        log(f"\n--- D{seq_idx+1} ---")
        history = []
        for step_idx, (msg, expected) in enumerate(sequence):
            test_id = f"D{seq_idx+1}-{step_idx+1}"
            ans, prods, src, _ = chat(msg, history=history.copy())
            has_prods = len(prods) > 0
            is_correct = has_prods
            notes = ""
            if not has_prods:
                notes = "ไม่มีสินค้า"
            record(test_id, "context_switch", msg, expected, ans, prods, src, is_correct, notes)
            history.append({"role":"user","text":msg})
            history.append({"role":"model","text":ans})
            time.sleep(DELAY)

def test_e_reference_questions():
    """ชุด E: reference questions 10 sequences × 4 steps = 40 reqs"""
    log("\n" + "="*60)
    log("ชุด E: reference questions (เรือนนี้, ตัวนี้, รุ่นนี้)")
    log("="*60)

    sequences = [
        # E1: นาฬิกา → รุ่นอื่น → เรือนนี้ → รับประกัน
        [("หานาฬิกาเดินป่าสายลุยๆ", "นาฬิกาสายลุย"),
         ("มีรุ่นอื่นๆอีกแนะนำไหม", "นาฬิการุ่นอื่น"),
         ("ขอรายละเอียดเรือนนี้ได้ไหม", "รายละเอียดสินค้าล่าสุด"),
         ("รับประกันยังไง", "รับประกันสินค้าล่าสุด")],
        # E2: หูฟัง → รุ่นอื่น → ตัวนี้ → ราคา
        [("มีหูฟังแนะนำไหม", "หูฟัง"),
         ("มีรุ่นอื่นไหม", "หูฟังรุ่นอื่น"),
         ("ตัวนี้ราคาเท่าไหร่", "ราคาสินค้าล่าสุด"),
         ("ขอรายละเอียด", "รายละเอียดสินค้าล่าสุด")],
        # E3: กล้อง → รุ่นอื่น → รุ่นนี้ → สเปก
        [("มีกล้องวงจรปิดแนะนำไหม", "กล้อง CCTV"),
         ("มีรุ่นอื่นไหม", "กล้องรุ่นอื่น"),
         ("รุ่นนี้สเปกยังไง", "สเปกสินค้าล่าสุด"),
         ("รับประกันยังไง", "รับประกันสินค้าล่าสุด")],
        # E4: แบต → รุ่นอื่น → อันนี้ → รายละเอียด
        [("มีแบตสำรองแนะนำไหม", "แบตสำรอง"),
         ("มีรุ่นอื่นไหม", "แบตรุ่นอื่น"),
         ("อันนี้ขอรายละเอียด", "รายละเอียดสินค้าล่าสุด"),
         ("ราคาเท่าไหร่", "ราคาสินค้าล่าสุด")],
        # E5: โปรเจคเตอร์ → รุ่นอื่น → เรือนนี้ → จัดส่ง
        [("มีโปรเจคเตอร์แนะนำไหม", "โปรเจคเตอร์"),
         ("มีรุ่นอื่นไหม", "โปรเจคเตอร์รุ่นอื่น"),
         ("ขอรายละเอียดเรือนนี้", "รายละเอียดสินค้าล่าสุด"),
         ("จัดส่งยังไง", "นโยบายจัดส่ง")],
        # E6: พัดลม → รุ่นอื่น → ตัวนี้ → รับประกัน
        [("มีพัดลมแนะนำไหม", "พัดลม"),
         ("มีรุ่นอื่นไหม", "พัดลมรุ่นอื่น"),
         ("ตัวนี้รับประกันยังไง", "รับประกันสินค้าล่าสุด"),
         ("ขอรายละเอียด", "รายละเอียดสินค้าล่าสุด")],
        # E7: เครื่องนวด → รุ่นอื่น → รุ่นนี้ → ราคา
        [("มีเครื่องนวดแนะนำไหม", "เครื่องนวด"),
         ("มีรุ่นอื่นไหม", "เครื่องนวดรุ่นอื่น"),
         ("รุ่นนี้ราคาเท่าไหร่", "ราคาสินค้าล่าสุด"),
         ("ขอรายละเอียด", "รายละเอียดสินค้าล่าสุด")],
        # E8: หัวชาร์จ → รุ่นอื่น → เรือนนี้ → สเปก
        [("มีหัวชาร์จแนะนำไหม", "หัวชาร์จ"),
         ("มีรุ่นอื่นไหม", "หัวชาร์จรุ่นอื่น"),
         ("ขอรายละเอียดเรือนนี้", "รายละเอียดสินค้าล่าสุด"),
         ("สเปกยังไง", "สเปกสินค้าล่าสุด")],
        # E9: ลำโพง → รุ่นอื่น → ตัวนี้ → รับประกัน
        [("มีลำโพงแนะนำไหม", "ลำโพง"),
         ("มีรุ่นอื่นไหม", "ลำโพงรุ่นอื่น"),
         ("ตัวนี้รับประกันยังไง", "รับประกันสินค้าล่าสุด"),
         ("ขอรายละเอียด", "รายละเอียดสินค้าล่าสุด")],
        # E10: เครื่องดูด → รุ่นอื่น → รุ่นนี้ → ราคา
        [("มีเครื่องดูดฝุ่นแนะนำไหม", "เครื่องดูดฝุ่น"),
         ("มีรุ่นอื่นไหม", "เครื่องดูดรุ่นอื่น"),
         ("รุ่นนี้ราคาเท่าไหร่", "ราคาสินค้าล่าสุด"),
         ("ขอรายละเอียด", "รายละเอียดสินค้าล่าสุด")],
    ]

    for seq_idx, sequence in enumerate(sequences):
        log(f"\n--- E{seq_idx+1} ---")
        history = []
        for step_idx, (msg, expected) in enumerate(sequence):
            test_id = f"E{seq_idx+1}-{step_idx+1}"
            ans, prods, src, _ = chat(msg, history=history.copy())
            has_prods = len(prods) > 0 or "จัดส่ง" in expected or "นโยบาย" in expected
            is_correct = has_prods
            notes = ""
            if not has_prods and "นโยบาย" not in expected:
                notes = "ไม่มีสินค้า"
            record(test_id, "reference", msg, expected, ans, prods, src, is_correct, notes)
            history.append({"role":"user","text":msg})
            history.append({"role":"model","text":ans})
            time.sleep(DELAY)

def test_f_long_chat():
    """ชุด F: long chat 10 consecutive questions × 10 sequences = 100 reqs"""
    log("\n" + "="*60)
    log("ชุด F: long chat 10 คำถามติดต่อกัน")
    log("="*60)

    sequences = [
        # F1: นาฬิก้า → เดินป่า → แบต → รายละเอียด → รุ่นอื่น → เรือนนี้ → รับประกัน → จัดส่ง → เปรียบเทียบ → งบ
        ["มีนาฬิกาขายไหม", "เหมาะกับการเดินป่า", "แบตอึดๆ", "ขอรายละเอียดสินค้าได้ไหม",
         "มีรุ่นอื่นๆอีกแนะนำไหม", "ขอรายละเอียดเรือนนี้ได้ไหม", "รับประกันยังไง",
         "จัดส่งยังไง", "เปรียบเทียบรุ่นที่แนะนำให้หน่อย", "งบ 2000-5000 มีไหม"],
        # F2: หูฟัง → งบ → เปรียบเทียบ → รับประกัน → รุ่นอื่น → ตัวนี้ → ราคา → จัดส่ง → สเปก → เคลม
        ["มีหูฟังไหม", "งบ 500-1500", "เปรียบเทียบให้หน่อย", "รับประกันยังไง",
         "มีรุ่นอื่นไหม", "ตัวนี้ราคาเท่าไหร่", "จัดส่งยังไง", "สเปกยังไง",
         "เคลมยังไง", "มีแบบไร้สายไหม"],
        # F3: กล้อง → นอกบ้าน → กันน้ำ → ราคา → รุ่นอื่น → เรือนนี้ → รับประกัน → จัดส่ง → ในบ้าน → เปรียบเทียบ
        ["มีกล้องวงจรปิดไหม", "เอาแบบนอกบ้าน", "กันน้ำไหม", "ราคาเท่าไหร่",
         "มีรุ่นอื่นไหม", "ขอรายละเอียดเรือนนี้", "รับประกันยังไง", "จัดส่งยังไง",
         "มีแบบในบ้านไหม", "เปรียบเทียบให้หน่อย"],
        # F4: โทรศัพท์ → งบ → รับประกัน → รุ่นอื่น → ตัวนี้ → สเปก → จัดส่ง → เคลม → เปรียบเทียบ → สี
        ["มีโทรศัพท์ขายไหม", "งบ 2000", "รับประกันยังไง", "มีรุ่นอื่นไหม",
         "ตัวนี้สเปกยังไง", "จัดส่งยังไง", "เคลมยังไง", "เปรียบเทียบให้หน่อย",
         "มีสีอื่นไหม", "ราคาถูกสุดเท่าไหร่"],
        # F5: แบต → 10000 → เร็ว → รายละเอียด → รุ่นอื่น → เรือนนี้ → รับประกัน → จัดส่ง → เปรียบเทียบ → ราคา
        ["มีแบตสำรองไหม", "10000mAh", "ชาร์จเร็ว", "ขอรายละเอียด",
         "มีรุ่นอื่นไหม", "ขอรายละเอียดเรือนนี้", "รับประกันยังไง", "จัดส่งยังไง",
         "เปรียบเทียบให้หน่อย", "ราคาถูกสุดเท่าไหร่"],
        # F6: พัดลม → ประหยัดไฟ → รายละเอียด → รุ่นอื่น → ตัวนี้ → รับประกัน → จัดส่ง → ราคา → เปรียบเทียบ → สี
        ["มีพัดลมไหม", "ประหยัดไฟ", "ขอรายละเอียด", "มีรุ่นอื่นไหม",
         "ตัวนี้ราคาเท่าไหร่", "รับประกันยังไง", "จัดส่งยังไง", "เปรียบเทียบให้หน่อย",
         "มีสีอื่นไหม", "สเปกยังไง"],
        # F7: เครื่องดูด → ไร้สาย → ราคา → รับประกัน → รุ่นอื่น → เรือนนี้ → จัดส่ง → สเปก → เปรียบเทียบ → ขนาด
        ["มีเครื่องดูดฝุ่นไหม", "แบบไร้สาย", "ราคาเท่าไหร่", "รับประกันยังไง",
         "มีรุ่นอื่นไหม", "ขอรายละเอียดเรือนนี้", "จัดส่งยังไง", "สเปกยังไง",
         "เปรียบเทียบให้หน่อย", "ขนาดเท่าไหร่"],
        # F8: โปรเจคเตอร์ → 1080p → รายละเอียด → รุ่นอื่น → เรือนนี้ → รับประกัน → จัดส่ง → ราคา → เปรียบเทียบ → จอ
        ["มีโปรเจคเตอร์ไหม", "1080p", "ขอรายละเอียด", "มีรุ่นอื่นไหม",
         "ขอรายละเอียดเรือนนี้", "รับประกันยังไง", "จัดส่งยังไง", "ราคาเท่าไหร่",
         "เปรียบเทียบให้หน่อย", "มีจอขายไหม"],
        # F9: เครื่องนวด → คอ → ราคา → รับประกัน → รุ่นอื่น → ตัวนี้ → จัดส่ง → สเปก → เปรียบเทียบ → ขนาด
        ["มีเครื่องนวดไหม", "แบบนวดคอ", "ราคาเท่าไหร่", "รับประกันยังไง",
         "มีรุ่นอื่นไหม", "ตัวนี้สเปกยังไง", "จัดส่งยังไง", "ขนาดเท่าไหร่",
         "เปรียบเทียบให้หน่อย", "มีแบบอื่นไหม"],
        # F10: นาฬิกาเด็ก → โทรได้ → GPS → รายละเอียด → รุ่นอื่น → เรือนนี้ → รับประกัน → จัดส่ง → ราคา → เปรียบเทียบ
        ["มีนาฬิกาเด็กไหม", "โทรได้", "มีGPSไหม", "ขอรายละเอียด",
         "มีรุ่นอื่นไหม", "ขอรายละเอียดเรือนนี้", "รับประกันยังไง", "จัดส่งยังไง",
         "ราคาเท่าไหร่", "เปรียบเทียบให้หน่อย"],
    ]

    for seq_idx, questions in enumerate(sequences):
        log(f"\n--- F{seq_idx+1} (10 steps) ---")
        history = []
        for step_idx, msg in enumerate(questions):
            test_id = f"F{seq_idx+1}-{step_idx+1}"
            ans, prods, src, _ = chat(msg, history=history.copy())
            has_prods = len(prods) > 0
            # Policy questions don't need products
            if "จัดส่ง" in msg or "รับประกัน" in msg or "เคลม" in msg:
                is_correct = True  # policy questions are OK without products
                if "จัดส่ง" in msg:
                    is_correct = "shipping" in src or has_prods
                notes = "" if is_correct else f"source={src} expected shipping/policy"
            else:
                is_correct = has_prods
                notes = "" if has_prods else "ไม่มีสินค้า"
            record(test_id, "long_chat", msg, f"step {step_idx+1}", ans, prods, src, is_correct, notes)
            history.append({"role":"user","text":msg})
            history.append({"role":"model","text":ans})
            time.sleep(DELAY)

def test_g_edge_cases():
    """ชุด G: edge cases 50 reqs"""
    log("\n" + "="*60)
    log("ชุด G: edge cases (คำถามแปลก ถามวน)")
    log("="*60)

    edge_tests = [
        # G1-G10: คำถามสั้นๆ คำเดียว
        ("นาฬิกา", "นาฬิกา/สมาร์ทวอทช์"),
        ("หูฟัง", "หูฟัง"),
        ("แบต", "แบตสำรอง"),
        ("ชาร์จ", "หัวชาร์จ/สายชาร์จ"),
        ("กล้อง", "กล้อง"),
        ("พัดลม", "พัดลม"),
        ("นวด", "เครื่องนวด"),
        ("โปรเจคเตอร์", "โปรเจคเตอร์"),
        ("ลำโพง", "ลำโพง"),
        ("สาย", "สายชาร์จ/สาย"),
        # G11-G20: คำถามแปลก/วน
        ("อยากได้ของละม้างคล้ายๆ นาฬิกา", "นาฬิกา"),
        ("มีของแนะนำไหม", "สินค้าใดๆ"),
        ("แนะนำหน่อย", "สินค้าใดๆ"),
        ("มีอะไรขายบ้าง", "สินค้าใดๆ"),
        ("สินค้าขายดี", "สินค้าใดๆ"),
        ("โปรโมชั่น", "สินค้าใดๆ"),
        ("ลดราคา", "สินค้าใดๆ"),
        ("ของใหม่", "สินค้าใดๆ"),
        ("มีของใหม่ไหม", "สินค้าใดๆ"),
        ("สินค้าแนะนำ", "สินค้าใดๆ"),
        # G21-G30: คำถามผสมไทย-อังกฤษ
        ("smartwatch มีไหม", "สมาร์ทวอทช์"),
        ("earbuds tws", "หูฟัง TWS"),
        ("power bank 10000", "แบตสำรอง"),
        ("cctv camera", "กล้อง CCTV"),
        ("phone ราคาถูก", "โทรศัพท์"),
        ("charger type c", "หัวชาร์จ/สาย"),
        ("projector 1080p", "โปรเจคเตอร์"),
        ("vacuum cleaner", "เครื่องดูดฝุ่น"),
        ("speaker bluetooth", "ลำโพงบลูทูธ"),
        ("gps tracker", "GPS tracker"),
        # G31-G40: คำถามระบุร้าน
        ("kospet มีอะไรขาย", "KOSPET สินค้า"),
        ("imilab กล้อง", "IMILAB กล้อง"),
        ("xiaomi พัดลม", "Xiaomi พัดลม"),
        ("black shark นาฬิกา", "Black Shark นาฬิกา"),
        ("lagenio นาฬิกาเด็ก", "Lagenio นาฬิกาเด็ก"),
        ("kieslect สมาร์ทวอทช์", "Kieslect สมาร์ทวอทช์"),
        ("zmi หัวชาร์จ", "ZMI หัวชาร์จ"),
        ("cuktech ชาร์จ", "CUKTECH ชาร์จ"),
        ("yaber โปรเจคเตอร์", "Yaber โปรเจคเตอร์"),
        ("lydsto เครื่องดูด", "Lydsto เครื่องดูด"),
        # G41-G50: คำถามแบบไม่ระบุชัด
        ("อยากได้ของขวัญให้แฟน", "สินค้าใดๆ"),
        ("อยากได้ของขวัญให้เพื่อน", "สินค้าใดๆ"),
        ("ของใช้ในบ้าน", "สินค้าใดๆ"),
        ("ของใช้ในสำนักงาน", "สินค้าใดๆ"),
        ("อุปกรณ์กลางแจ้ง", "สินค้าใดๆ"),
        ("อุปกรณ์ออกกำลังกาย", "สินค้าใดๆ"),
        ("อุปกรณ์เดินทาง", "สินค้าใดๆ"),
        ("ของใช้สำหรับเด็ก", "สินค้าใดๆ"),
        ("อุปกรณ์ลงมือทำงาน", "สินค้าใดๆ"),
        ("ของฝากจากเมืองไทย", "สินค้าใดๆ"),
    ]

    for i, (msg, expected) in enumerate(edge_tests):
        test_id = f"G-{i+1}"
        ans, prods, src, _ = chat(msg)
        has_prods = len(prods) > 0
        is_correct = has_prods or "policy" in src
        notes = ""
        if not has_prods and "policy" not in src:
            notes = "ไม่มีสินค้า"
        record(test_id, "edge_case", msg, expected, ans, prods, src, is_correct, notes)
        time.sleep(DELAY)

def test_h_regression():
    """ชุด H: regression tests 30 reqs"""
    log("\n" + "="*60)
    log("ชุด H: regression tests")
    log("="*60)

    regression_tests = [
        # H1-H10: เคสเดิมที่เคยแก้
        ("จัดส่ง", "general:shipping_policy", lambda a,p,s: "shipping" in s),
        ("รับประกัน", "general:warranty_policy", lambda a,p,s: "warranty" in s),
        ("kospet มีนาฬิกาขายไหม", "KOSPET นาฬิกา ไม่มีสาย", lambda a,p,s: len(p)>0 and check_no_accessories(p, ["สายนาฬิกา","strap"])),
        ("มีนาฬิกาขายไหม", "นาฬิกา ไม่มีสาย", lambda a,p,s: len(p)>0 and check_no_accessories(p, ["สายนาฬิกา","strap"])),
        ("มีนาฬิกาสำหรับเดินป่าไหม", "นาฬิกาเดินป่า", lambda a,p,s: len(p)>0),
        ("imilab ec6", "IMILAB EC6", lambda a,p,s: len(p)>0 and check_product_type(p, ["imilab","ec6"])),
        ("lagenio k9 รับประกัน", "Lagenio K9 รับประกัน", lambda a,p,s: len(p)>0 or "warranty" in s),
        ("redmi 8a รับประกัน", "Redmi 8A รับประกัน", lambda a,p,s: len(p)>0 or "warranty" in s),
        ("kieslect ks3", "Kieslect KS3", lambda a,p,s: len(p)>0 and check_product_type(p, ["kieslect","ks3"])),
        ("เปรียบเทียบหูฟัง qkz กับ qcy", "เปรียบเทียบหูฟัง", lambda a,p,s: len(p)>0),
        # H11-H20: เคสตรวจสอบประเภท
        ("มีหูฟังไหม", "หูฟัง ไม่มีเคส", lambda a,p,s: len(p)>0 and check_no_accessories(p, ["เคสหูฟัง"])),
        ("มีแบตสำรองไหม", "แบต ไม่มีสายชาร์จ", lambda a,p,s: len(p)>0 and check_no_accessories(p, ["สายชาร์จ","หัวชาร์จ"]) or check_product_type(p, ["แบต","powerbank","power bank"])),
        ("มีหัวชาร์จไหม", "หัวชาร์จ ไม่มีสาย", lambda a,p,s: len(p)>0),
        ("มีกล้องวงจรปิดไหม", "กล้อง CCTV", lambda a,p,s: len(p)>0 and check_product_type(p, ["กล้อง","cctv","camera"])),
        ("มีพัดลมไหม", "พัดลม", lambda a,p,s: len(p)>0 and check_product_type(p, ["พัดลม","fan"])),
        ("มีเครื่องดูดฝุ่นไหม", "เครื่องดูดฝุ่น", lambda a,p,s: len(p)>0 and check_product_type(p, ["ดูดฝุ่น","vacuum"])),
        ("มีโปรเจคเตอร์ไหม", "โปรเจคเตอร์", lambda a,p,s: len(p)>0 and check_product_type(p, ["โปรเจคเตอร์","projector"])),
        ("มีเครื่องนวดไหม", "เครื่องนวด", lambda a,p,s: len(p)>0 and check_product_type(p, ["นวด","massage","หมอน"])),
        ("มีลำโพงไหม", "ลำโพง", lambda a,p,s: len(p)>0 and check_product_type(p, ["ลำโพง","speaker","ซาวด์บาร์"])),
        ("มีโทรศัพท์ไหม", "โทรศัพท์", lambda a,p,s: len(p)>0 and check_product_type(p, ["โทรศัพท์","phone","smartphone","redmi"])),
        # H21-H30: เคสตรวจสอบร้าน
        ("kospet นาฬิกา", "KOSPET", lambda a,p,s: len(p)>0 and check_product_type(p, ["kospet"])),
        ("imilab กล้อง", "IMILAB", lambda a,p,s: len(p)>0 and check_product_type(p, ["imilab"])),
        ("lagenio นาฬิกาเด็ก", "Lagenio", lambda a,p,s: len(p)>0 and check_product_type(p, ["lagenio"])),
        ("kieslect สมาร์ทวอทช์", "Kieslect", lambda a,p,s: len(p)>0 and check_product_type(p, ["kieslect"])),
        ("black shark นาฬิกา", "Black Shark", lambda a,p,s: len(p)>0 and check_product_type(p, ["black shark","blackshark"])),
        ("yaber โปรเจคเตอร์", "Yaber", lambda a,p,s: len(p)>0 and check_product_type(p, ["yaber"])),
        ("zmi หัวชาร์จ", "ZMI", lambda a,p,s: len(p)>0 and check_product_type(p, ["zmi"])),
        ("cuktech ชาร์จ", "CUKTECH", lambda a,p,s: len(p)>0 and check_product_type(p, ["cuktech"])),
        ("lydsto เครื่องดูด", "Lydsto", lambda a,p,s: len(p)>0 and check_product_type(p, ["lydsto"])),
        ("70mai dashcam", "70mai", lambda a,p,s: len(p)>0 and check_product_type(p, ["70mai"])),
    ]

    for i, (msg, expected, check_fn) in enumerate(regression_tests):
        test_id = f"H-{i+1}"
        ans, prods, src, _ = chat(msg)
        is_correct = check_fn(ans, prods, src)
        notes = "" if is_correct else f"check failed: src={src} prods={len(prods)}"
        record(test_id, "regression", msg, expected, ans, prods, src, is_correct, notes)
        time.sleep(DELAY)

def save_results():
    """Save all results to files."""
    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    with open(WRONG_FILE, "w", encoding="utf-8") as f:
        json.dump(wrong_cases, f, ensure_ascii=False, indent=2)
    log(f"\nResults saved: {RESULTS_FILE} ({len(results)} total)")
    log(f"Wrong cases: {WRONG_FILE} ({len(wrong_cases)} wrong)")

def print_summary():
    """Print summary of results."""
    log("\n" + "="*60)
    log("SUMMARY")
    log("="*60)
    categories = {}
    for r in results:
        cat = r["category"]
        if cat not in categories:
            categories[cat] = {"total": 0, "correct": 0, "wrong": 0}
        categories[cat]["total"] += 1
        if r["is_correct"]:
            categories[cat]["correct"] += 1
        else:
            categories[cat]["wrong"] += 1

    total_all = len(results)
    correct_all = sum(1 for r in results if r["is_correct"])
    wrong_all = total_all - correct_all

    for cat, counts in sorted(categories.items()):
        pct = (counts["correct"] / counts["total"] * 100) if counts["total"] > 0 else 0
        log(f"  {cat:20s}: {counts['correct']}/{counts['total']} ({pct:.0f}%)  wrong={counts['wrong']}")

    pct_all = (correct_all / total_all * 100) if total_all > 0 else 0
    log(f"\n  {'TOTAL':20s}: {correct_all}/{total_all} ({pct_all:.0f}%)  wrong={wrong_all}")
    log(f"  Requests used: {req_count}")

    if wrong_cases:
        log(f"\n--- WRONG CASES ({len(wrong_cases)}) ---")
        for w in wrong_cases:
            log(f"  [{w['test_id']}] {w['category']:15s} | {w['message'][:40]}")
            log(f"    expected: {w['expected'][:60]}")
            log(f"    notes: {w['notes'][:60]}")

# ============================================================
# MAIN
# ============================================================
if __name__ == "__main__":
    log("Starting comprehensive test suite...")
    log(f"Rate: {DELAY}s delay, max {MAX_REQS} requests")

    # Run all test suites
    test_a_shop_specific()      # ~75 reqs
    save_results()
    if req_count >= MAX_REQS:
        print_summary()
        sys.exit(0)

    test_b_all_shops_types()    # ~20 reqs
    save_results()
    if req_count >= MAX_REQS:
        print_summary()
        sys.exit(0)

    test_c_followup_sequences() # ~40 reqs
    save_results()
    if req_count >= MAX_REQS:
        print_summary()
        sys.exit(0)

    test_d_context_switching()  # ~30 reqs
    save_results()
    if req_count >= MAX_REQS:
        print_summary()
        sys.exit(0)

    test_e_reference_questions() # ~40 reqs
    save_results()
    if req_count >= MAX_REQS:
        print_summary()
        sys.exit(0)

    test_f_long_chat()          # ~100 reqs
    save_results()
    if req_count >= MAX_REQS:
        print_summary()
        sys.exit(0)

    test_g_edge_cases()         # ~50 reqs
    save_results()
    if req_count >= MAX_REQS:
        print_summary()
        sys.exit(0)

    test_h_regression()         # ~30 reqs
    save_results()

    print_summary()
    log("\nDone!")
