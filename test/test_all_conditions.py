"""เทสทุกเงื่อนไขของแชทบอทแบบครอบคลุม
รัน: .venv/bin/python test_all_conditions.py
"""
import requests
import json
import time
import sys

BASE = "http://127.0.0.1:8010/chat"
SHOP = "CukTechThailand"

def chat(message, history=None, shop=SHOP):
    payload = {"message": message, "shop": shop, "limit": 5}
    if history:
        payload["history"] = history
    t0 = time.time()
    r = requests.post(BASE, json=payload, timeout=60)
    elapsed = time.time() - t0
    d = r.json()
    return d, elapsed

def show(label, d, elapsed, show_products=True, show_intent=True):
    print(f"\n{'='*70}")
    print(f"📋 {label}")
    print(f"{'='*70}")
    ans = d.get("answer", "")
    # แสดงแค่ 3 บรรทัดแรกของ answer
    lines = ans.split("\n")
    for line in lines[:6]:
        print(f"  {line}")
    if len(lines) > 6:
        print(f"  ... ({len(lines)-6} บรรทัดเพิ่ม)")
    print(f"  ⏱ elapsed: {elapsed:.1f}s  source: {d.get('source','?')}")
    if show_intent and d.get("intent"):
        intent = d["intent"]
        print(f"  🎯 intent: {intent.get('intent','?')}  conf={intent.get('confidence','?')}  device={intent.get('target_device','?')}")
    if show_intent and d.get("timing"):
        print(f"  ⏱ timing: {json.dumps(d['timing'])}")
    if show_products:
        prods = d.get("products", [])
        if prods:
            print(f"  📦 products ({len(prods)}):")
            for p in prods[:3]:
                print(f"     - {p.get('name','?')[:55]}")
        else:
            print(f"  📦 products: (none)")
    if d.get("handoff_to_admin"):
        print(f"  🔔 HANDOFF: {d.get('handoff_reason','?')}")

results = []

# ============================================================
print("\n" + "🔴" * 35)
print("🔴  GROUP 1: ถามปกติ (ไม่มี history)")
print("🔴" * 35)
# ============================================================

tests_group1 = [
    ("1.1 ถามสายชาร์จทั่วไป", "มีสายชาร์จไหม", None),
    ("1.2 ถามหัวชาร์จ 65w", "หัวชาร์จ 65w รุ่นไหนดี", None),
    ("1.3 ถามชุดชาร์จ", "มีชุดชาร์จพร้อมสายไหม", None),
    ("1.4 ถามสเปกสินค้า", "cuktech ctc615w สเปกอะไรบ้าง", None),
    ("1.5 ถามราคา", "cuktech ctc615w ราคาเท่าไหร่", None),
    ("1.6 ถามรับประกันกี่ปี", "cuktech ctc615w รับประกันกี่ปี", None),
    ("1.7 ถามนโยบายรับประกัน", "นโยบายรับประกันเป็นยังไง", None),
    ("1.8 ถามนโยบายจัดส่ง", "ส่งกี่วันคะ", None),
    ("1.9 ถามนโยบายรับคืน", "มีรับคืนไหม", None),
    ("1.10 ถามหมวดหมู่สินค้า", "มีหมวดหมู่อะไรบ้าง", None),
    ("1.11 ถามแบรนด์", "มีแบรนด์อะไรบ้าง", None),
    ("1.12 ถามใบกำกับภาษี", "ออกใบกำกับภาษีได้ไหมคะ", None),
    ("1.13 ถามนอกเรื่อง", "อากาศวันนี้เป็นยังไง", None),
    ("1.14 ทักทาย", "สวัสดีค่ะ", None),
    ("1.15 ขอบคุณ", "ขอบคุณค่ะ", None),
]

for label, msg, hist in tests_group1:
    try:
        d, elapsed = chat(msg, hist)
        show(label, d, elapsed)
        results.append((label, True, d.get("source","?")))
    except Exception as e:
        print(f"\n{'='*70}")
        print(f"❌ {label} — ERROR: {e}")
        results.append((label, False, str(e)))

# ============================================================
print("\n" + "🟠" * 35)
print("🟠  GROUP 2: ถามต่อเนื่องเรื่องเดิม (follow-up)")
print("🟠" * 35)
# ============================================================

# 2.1 ถามสินค้า → ถามสเปกต่อ
hist_2_1 = [
    {"role": "user", "text": "หัวชาร์จ 65w รุ่นไหนดี"},
    {"role": "model", "text": "ทางร้านมี CUKTECH GaN3 AD653C 65W ราคา 590 บาทค่ะ"},
]
try:
    d, e = chat("รุ่นนี้รับประกันกี่ปี", hist_2_1)
    show("2.1 ถามหัวชาร์จ → ถามรับประกันต่อ", d, e)
    results.append(("2.1 follow-up warranty", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 2.1 ERROR: {ex}")
    results.append(("2.1 follow-up warranty", False, str(ex)))

# 2.2 ถามสินค้า → ถามราคาต่อ
hist_2_2 = [
    {"role": "user", "text": "มีสายชาร์จไหม"},
    {"role": "model", "text": "มี CUKTECH CTC315P สายชาร์จ USB-C 60W ราคา 199 บาทค่ะ"},
]
try:
    d, e = chat("ราคาเท่าไหร่คะ", hist_2_2)
    show("2.2 ถามสายชาร์จ → ถามราคาต่อ", d, e)
    results.append(("2.2 follow-up price", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 2.2 ERROR: {ex}")
    results.append(("2.2 follow-up price", False, str(ex)))

# 2.3 ถามสินค้า → ถาม compatibility ต่อ
hist_2_3 = [
    {"role": "user", "text": "หัวชาร์จ 65w รุ่นไหนดี"},
    {"role": "model", "text": "ทางร้านมี CUKTECH GaN3 AD653C 65W ค่ะ"},
]
try:
    d, e = chat("ใช้กับ samsung s25 ultra ได้ไหม", hist_2_3)
    show("2.3 ถามหัวชาร์จ → ถาม compatibility ต่อ", d, e)
    results.append(("2.3 follow-up compat", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 2.3 ERROR: {ex}")
    results.append(("2.3 follow-up compat", False, str(ex)))

# ============================================================
print("\n" + "🟡" * 35)
print("🟡  GROUP 3: ถามต่อเนื่องแล้วเปลี่ยนเรื่อง")
print("🟡" * 35)
# ============================================================

# 3.1 ถามสายชาร์จ → เปลี่ยนเป็นถามหัวชาร์จ
hist_3_1 = [
    {"role": "user", "text": "มีสายชาร์จไหม"},
    {"role": "model", "text": "มี CUKTECH CTC315P สายชาร์จ USB-C 60W ค่ะ"},
]
try:
    d, e = chat("แล้วมีหัวชาร์จ 65w ไหม", hist_3_1)
    show("3.1 ถามสายชาร์จ → เปลี่ยนเป็นหัวชาร์จ", d, e)
    results.append(("3.1 change topic charger", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 3.1 ERROR: {ex}")
    results.append(("3.1 change topic charger", False, str(ex)))

# 3.2 ถามสินค้า → เปลี่ยนเป็นถามนโยบาย
hist_3_2 = [
    {"role": "user", "text": "หัวชาร์จ 65w รุ่นไหนดี"},
    {"role": "model", "text": "ทางร้านมี CUKTECH GaN3 AD653C 65W ค่ะ"},
]
try:
    d, e = chat("ส่งกี่วันคะ", hist_3_2)
    show("3.2 ถามสินค้า → เปลี่ยนเป็นถามจัดส่ง", d, e)
    results.append(("3.2 change topic shipping", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 3.2 ERROR: {ex}")
    results.append(("3.2 change topic shipping", False, str(ex)))

# 3.3 ถาม warranty → เปลี่ยนเป็นถามสินค้า
hist_3_3 = [
    {"role": "user", "text": "cuktech ctc615w รับประกันกี่ปี"},
    {"role": "model", "text": "สินค้า CUKTECH CTC615W รับประกัน 2 ปีค่ะ"},
]
try:
    d, e = chat("มีสินค้าประเภทสายชาร์จไหม", hist_3_3)
    show("3.3 ถาม warranty → เปลี่ยนเป็นถามสินค้า (ไม่ถูก claim จับ)", d, e)
    results.append(("3.3 warranty→product", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 3.3 ERROR: {ex}")
    results.append(("3.3 warranty→product", False, str(ex)))

# ============================================================
print("\n" + "🟢" * 35)
print("🟢  GROUP 4: เปลี่ยนเรื่องแล้วกลับมาถามเรื่องเดิม")
print("🟢" * 35)
# ============================================================

# 4.1 ถามสายชาร์จ → ถามหัวชาร์จ → กลับไปถามสายชาร์จ
hist_4_1 = [
    {"role": "user", "text": "มีสายชาร์จไหม"},
    {"role": "model", "text": "มี CUKTECH CTC315P สายชาร์จ USB-C 60W ค่ะ"},
    {"role": "user", "text": "แล้วมีหัวชาร์จ 65w ไหม"},
    {"role": "model", "text": "ทางร้านมี CUKTECH GaN3 AD653C 65W ค่ะ"},
]
try:
    d, e = chat("สายชาร์จรุ่นแรกที่แนะนำใช้กับ iphone 17 ได้ไหม", hist_4_1)
    show("4.1 สาย→หัว→กลับถามสาย compatibility", d, e)
    results.append(("4.1 back to original", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 4.1 ERROR: {ex}")
    results.append(("4.1 back to original", False, str(ex)))

# ============================================================
print("\n" + "🔵" * 35)
print("🔵  GROUP 5: รายละเอียดสินค้า + ประกัน + เคลม")
print("🔵" * 35)
# ============================================================

tests_group5 = [
    ("5.1 ถามสเปกเต็ม", "cuktech ctc615w สเปคเต็มหน่อย", None),
    ("5.2 ถามอุปกรณ์ในกล่อง", "cuktech ctc615w ในกล่องมีอะไรบ้าง", None),
    ("5.3 ถามรับประกัน", "cuktech ctc615w รับประกันกี่ปี", None),
    ("5.4 ถามเคลมยังไง", "เคลมยังไงคะ", None),
    ("5.5 แจ้งสินค้าเสีย", "สินค้าเสีย อยากเคลม", None),
    ("5.6 แจ้งพัง", "หัวชาร์จพัง ไม่ทำงาน", None),
    ("5.7 ถามซ่อม", "ซ่อมยังไงคะ", None),
    ("5.8 สินค้าเสียหายทำยังไง", "สินค้าเสียหายทำยังไงได้บ้าง", None),
    ("5.9 ถามประกันสินค้าเสีย", "ถ้าสินค้าเสียหากประกันไหม", None),
]

for label, msg, hist in tests_group5:
    try:
        d, elapsed = chat(msg, hist)
        show(label, d, elapsed, show_products=False)
        results.append((label, True, d.get("source","?")))
    except Exception as e:
        print(f"\n{'='*70}")
        print(f"❌ {label} — ERROR: {e}")
        results.append((label, False, str(e)))

# ============================================================
print("\n" + "🟣" * 35)
print("🟣  GROUP 6: Warranty Claim State Machine (หลายรอบ)")
print("🟣" * 35)
# ============================================================

# 6.1 duration → claim → date → info → confirm
print("\n--- 6.1 Warranty claim full flow ---")
hist = []
steps = [
    ("6.1a ถามรับประกัน", "cuktech ctc615w รับประกันกี่ปี"),
    ("6.1b แจ้งเคลม", "สินค้าเสีย อยากเคลม"),
    ("6.1c ให้วันที่ซื้อ", "ซื้อมาวันที่ 15 มกราคม 2025"),
    ("6.1d ให้ข้อมูล", "ชื่อ สมชาย ใจดี เบอร์ 0812345678 เลขคำสั่งซื้อ 1234567890123"),
    ("6.1e ยืนยัน", "ถูกต้องค่ะ"),
]
for label, msg in steps:
    try:
        d, e = chat(msg, hist if hist else None)
        show(label, d, e, show_products=False)
        hist.append({"role": "user", "text": msg})
        hist.append({"role": "model", "text": d.get("answer", "")})
        results.append((label, True, d.get("source","?")))
    except Exception as ex:
        print(f"❌ {label} ERROR: {ex}")
        results.append((label, False, str(ex)))
        break

# 6.2 out of warranty flow
print("\n--- 6.2 Out of warranty flow ---")
hist2 = []
steps2 = [
    ("6.2a ถามรับประกัน", "cuktech ctc615w รับประกันกี่ปี"),
    ("6.2b แจ้งเคลม", "สินค้าเสีย อยากเคลม"),
    ("6.2c ให้วันที่ซื้อเก่า (นอกประกัน)", "ซื้อมาวันที่ 1 มกราคม 2020"),
    ("6.2d สนใจปรึกษาแอดมิน", "สนใจค่ะ"),
]
for label, msg in steps2:
    try:
        d, e = chat(msg, hist2 if hist2 else None)
        show(label, d, e, show_products=False)
        hist2.append({"role": "user", "text": msg})
        hist2.append({"role": "model", "text": d.get("answer", "")})
        results.append((label, True, d.get("source","?")))
    except Exception as ex:
        print(f"❌ {label} ERROR: {ex}")
        results.append((label, False, str(ex)))
        break

# ============================================================
print("\n" + "🟤" * 35)
print("🟤  GROUP 7: Compatibility — รุ่นเก่า + ของแปลก")
print("🟤" * 35)
# ============================================================

tests_group7 = [
    ("7.1 สายชาร์จ iphone 4s", "สายชาร์จใช้กับ iphone 4s ได้ไหม", None),
    ("7.2 สายชาร์จ iphone 7", "มีสายชาร์จไอโฟน7 ไหม", None),
    ("7.3 หัวชาร์จ iphone 8", "มีหัวชาร์จไอโฟน8 ไหม", None),
    ("7.4 สายชาร์จ iphone SE", "สายชาร์จใช้กับ iphone se ได้ไหม", None),
    ("7.5 สายชาร์จ iphone 17 promax", "สายชาร์จรุ่นไหนใช้กับ iphone 17 promax ได้บ้าง", None),
    ("7.6 หัวชาร์จ samsung s25 ultra", "หัวชาร์จใช้กับ samsung s25 ultra รุ่นไหนดี", None),
    ("7.7 สายชาร์จ macbook", "สายชาร์จเข้า macbook ได้ไหม", None),
    ("7.8 สายชาร์จ ipad", "สายชาร์จใช้กับ ipad ได้ไหม", None),
    ("7.9 หัวชาร์จ pixel 8", "หัวชาร์จใช้กับ google pixel 8 ได้ไหม", None),
    ("7.10 สายชาร์จ xiaomi play", "ลำโพง xiaomi play ใช้สายชาร์จอันนี้ด้วยได้ไหม", None),
]

for label, msg, hist in tests_group7:
    try:
        d, elapsed = chat(msg, hist)
        show(label, d, elapsed)
        results.append((label, True, d.get("source","?")))
    except Exception as e:
        print(f"\n{'='*70}")
        print(f"❌ {label} — ERROR: {e}")
        results.append((label, False, str(e)))

# ============================================================
print("\n" + "⚫" * 35)
print("⚫  GROUP 8: ใบกำกับภาษี + นอกเรื่อง")
print("⚫" * 35)
# ============================================================

# 8.1 ถามใบกำกับภาษีครั้งแรก
try:
    d, e = chat("ออกใบกำกับภาษีได้ไหมคะ")
    show("8.1 ถามใบกำกับภาษี (ครั้งแรก)", d, e, show_products=False)
    results.append(("8.1 tax invoice first", True, d.get("source","?")))
    tax_hist = [
        {"role": "user", "text": "ออกใบกำกับภาษีได้ไหมคะ"},
        {"role": "model", "text": d.get("answer", "")},
    ]
except Exception as ex:
    print(f"❌ 8.1 ERROR: {ex}")
    results.append(("8.1 tax invoice first", False, str(ex)))
    tax_hist = []

# 8.2 ลูกค้าตอบต้องการ → handoff
if tax_hist:
    try:
        d, e = chat("ต้องการค่ะ", tax_hist)
        show("8.2 ตอบต้องการใบกำกับภาษี → handoff", d, e, show_products=False)
        results.append(("8.2 tax invoice handoff", True, d.get("source","?")))
    except Exception as ex:
        print(f"❌ 8.2 ERROR: {ex}")
        results.append(("8.2 tax invoice handoff", False, str(ex)))

# 8.3 ถามนอกเรื่อง
try:
    d, e = chat("วันนี้ฝนตกไหม")
    show("8.3 ถามนอกเรื่อง (อากาศ)", d, e, show_products=False)
    results.append(("8.3 off-topic weather", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 8.3 ERROR: {ex}")
    results.append(("8.3 off-topic weather", False, str(ex)))

# 8.4 ถามเกี่ยวกับตัวบอท
try:
    d, e = chat("ชื่ออะไรคะ")
    show("8.4 ถามชื่อบอท", d, e, show_products=False)
    results.append(("8.4 ask bot name", True, d.get("source","?")))
except Exception as ex:
    print(f"❌ 8.4 ERROR: {ex}")
    results.append(("8.4 ask bot name", False, str(ex)))

# ============================================================
# สรุปผล
# ============================================================
print("\n\n" + "=" * 70)
print("📊 สรุปผลการเทสทั้งหมด")
print("=" * 70)
passed = sum(1 for _, ok, _ in results if ok)
failed = sum(1 for _, ok, _ in results if not ok)
print(f"✅ ผ่าน: {passed}  |  ❌ ไม่ผ่าน: {failed}  |  รวม: {len(results)}")
print()
if failed:
    print("❌ รายการที่ไม่ผ่าน:")
    for label, ok, src in results:
        if not ok:
            print(f"  - {label}: {src}")
print("\n✅ รายการที่ผ่าน (พร้อม source):")
for label, ok, src in results:
    if ok:
        print(f"  ✓ {label:45s} → {src}")
