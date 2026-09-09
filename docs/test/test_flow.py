#!/usr/bin/env python3
"""ทดสอบ flow ทั้งระบบ — อ่านคำตอบเต็ม วิเคราะห์ flow ที่เข้า"""
import requests
import json
import time
import sys

BASE = "http://127.0.0.1:8010"
SHOP = "CukTechThailand"
LIMIT = 10
TIMEOUT = 120


def send(message, history=None):
    """ส่งคำถามแล้วคืน response แบบเต็ม"""
    payload = {"message": message, "shop": SHOP, "limit": LIMIT}
    if history:
        payload["history"] = history
    r = requests.post(f"{BASE}/chat", json=payload, timeout=TIMEOUT)
    return r.json()


def analyze_flow(d):
    """วิเคราะห์ flow ที่เข้า"""
    steps = []
    intent = d.get("intent") or {}
    timing = d.get("timing") or {}
    ws_used = d.get("web_search_used", False)

    # Step 1: Intent
    if intent.get("intent"):
        steps.append(f"Intent({intent['intent']}, conf={intent.get('confidence', 0):.2f})")
    else:
        steps.append("⏭Intent(skip)")

    # Step 2: LLM1
    if timing.get("llm") is not None:
        steps.append(f"LLM1({timing['llm']}s)")
    else:
        steps.append("⏭LLM1(skip)")

    # Step 3: Search
    if ws_used:
        reason = d.get("web_search_reason", "?")
        ws_time = timing.get("web_search", "?")
        steps.append(f"Search({reason}, {ws_time}s)")
    else:
        steps.append("⏭Search(skip)")

    # Step 4: LLM2
    if timing.get("llm2") is not None:
        steps.append(f"LLM2({timing['llm2']}s)")
    else:
        steps.append("⏭LLM2(skip)")

    return " → ".join(steps)


def check_answer(d, question, expectations, history_ctx=""):
    """ตรวจคำตอบว่าตรงคาดหวังไหม"""
    ans = d.get("answer", "")
    source = d.get("source", "?")
    products = d.get("products", [])
    timing = d.get("timing") or {}
    flow = analyze_flow(d)

    print(f"\n{'='*80}")
    if history_ctx:
        print(f"📋 Context: {history_ctx}")
    print(f"❓ คำถาม: {question}")
    print(f"🔄 Flow: {flow}")
    print(f"📊 source={source}  products={len(products)}  total={timing.get('total', '?')}s")
    if d.get("web_search_used"):
        print(f"🔍 web_search_reason={d.get('web_search_reason')}")
    print(f"💬 คำตอบเต็ม:")
    print(ans)
    print(f"{'─'*80}")
    print("✅ ตรวจสอบ:")

    issues = []
    for label, check_fn, desc in expectations:
        result = check_fn(d)
        status = "✅" if result else "❌"
        print(f"  {status} {label}: {desc}")
        if not result:
            issues.append(label)

    if issues:
        print(f"\n⚠️ ปัญหา: {', '.join(issues)}")
    else:
        print(f"\n✅ ผ่านทั้งหมด")

    return issues


def has_no_info(d):
    ans = d["answer"].lower()
    return not any(p in ans for p in ["ไม่มีข้อมูล", "ไม่มีรายละเอียดเพิ่มเติม", "ไม่มีรายละเอียดสินค้า"])


def has_external_link(d):
    ans = d["answer"].lower()
    return any(p in ans for p in ["pchome", "iopenmall", "gsmchoice", "24h.pchome"])


def has_spec_info(d):
    """ตอบมีสเปก/รายละเอียดสินค้าจริง"""
    ans = d["answer"]
    # ต้องมีตัวเลขสเปกหรือคำว่า W/A/USB-C/PD ฯลฯ
    spec_indicators = ["w", "a", "usb-c", "type-c", "pd", "qc", "วัตต์",
                       "แอมป์", "ความยาว", "เมตร", "ไนลอน", "ถัก",
                       "gaan", "gan", "pd3", "qc3"]
    return any(s in ans.lower() for s in spec_indicators)


def products_count_ge(d, n):
    return len(d.get("products", [])) >= n


def is_web_search_flow(d):
    return d.get("web_search_used", False) and d.get("source", "").startswith("product_store+web_search")


def is_normal_flow(d):
    return not d.get("web_search_used", False)


def mentions_warranty_years(d):
    ans = d["answer"]
    return any(p in ans for p in ["2 ปี", "2ปี", "ปีเต็ม", "รับประกัน 2", "รับประกัน2"])


def not_mentions_warranty_conditions(d):
    """ไม่แนบเงื่อนไขรับประกันเบื้องต้นยาวๆ"""
    ans = d["answer"]
    long_warranty = ["ต้องมีวิดีโอ", "กล่อง", "แพ็คเกจ", "unboxing", "แจ้งภายใน"]
    # นับถ้ามีเงื่อนไขยาวๆ เกิน 2 ข้อ
    count = sum(1 for p in long_warranty if p in ans.lower())
    return count <= 1


# ============================================================
print("=" * 80)
print("🧪 ทดสอบ flow ทั้งระบบ — อ่านคำตอบเต็ม วิเคราะห์ flow")
print(f"   Shop: {SHOP}  Limit: {LIMIT}")
print("=" * 80)

all_issues = []

# ── Q1: หัวชาร์จ 65w — ปัญหา 1+3 (description ส่งเสมอ) ──
d1 = send("หัวชาร์จ 65w รุ่นไหนดี")
issues = check_answer(d1, "หัวชาร์จ 65w รุ่นไหนดี", [
    ("ไม่บอกไม่มีข้อมูล", has_no_info, "ตอบมีสเปก ไม่บอก 'ไม่มีข้อมูล'"),
    ("มีสเปกจริง", has_spec_info, "ตอบมี W/A/USB-C/PD หรือสเปกอื่นๆ"),
    ("ไม่มีลิงก์นอก", lambda d: not has_external_link(d), "ไม่มีลิงก์จากเว็บอื่น"),
], "ปัญหา 1+3: description ส่งเสมอ")
all_issues.extend(issues)

# ── Q2: สายชาร์จ 100w ──
d2 = send("สายชาร์จ 100w มีไหม")
issues = check_answer(d2, "สายชาร์จ 100w มีไหม", [
    ("ไม่บอกไม่มีข้อมูล", has_no_info, "ตอบมีสเปก ไม่บอก 'ไม่มีข้อมูล'"),
    ("มีสเปกจริง", has_spec_info, "ตอบมี W/A/USB-C/PD หรือสเปกอื่นๆ"),
], "ปัญหา 1+3: description ส่งเสมอ")
all_issues.extend(issues)

# ── Q3: สายชาร์จที่ใช้กับ iphone 17 promax ──
d3 = send("สายชาร์จที่ใช้กับ iphone 17 promax ได้")
issues = check_answer(d3, "สายชาร์จที่ใช้กับ iphone 17 promax ได้", [
    ("ไม่บอกไม่มีข้อมูล", has_no_info, "ตอบมีสเปก ไม่บอก 'ไม่มีข้อมูล'"),
    ("ไม่มีลิงก์นอก", lambda d: not has_external_link(d), "ไม่มีลิงก์จากเว็บอื่น"),
], "ปัญหา 1+3+4: description + web search ตอบจาก DB")
all_issues.extend(issues)

# ── Q4: มีสายชาร์จอะไรบ้าง — ปัญหา 2 (frontend 10 ชิ้น) ──
d4 = send("มีสายชาร์จอะไรบ้าง")
issues = check_answer(d4, "มีสายชาร์จอะไรบ้าง", [
    ("สินค้า >= 5", lambda d: products_count_ge(d, 5), "frontend แสดง 5+ ชิ้น (ไม่ใช่ 3)"),
], "ปัญหา 2: frontend แสดง 10 ชิ้น")
all_issues.extend(issues)

# ── Q5: follow-up ขอรายละเอียด — ปัญหา 5 (ไม่ตัดสินค้าเดิม) ──
d5a = send("มีสายชาร์จอะไรบ้าง")
ans5a = d5a["answer"]
d5b = send("ขอรายละเอียดเพิ่มเติม", history=[
    {"role": "user", "text": "มีสายชาร์จอะไรบ้าง"},
    {"role": "model", "text": ans5a[:400]},
])
issues = check_answer(d5b, "ขอรายละเอียดเพิ่มเติม", [
    ("ไม่บอกไม่มีข้อมูล", has_no_info, "ตอบรายละเอียดสินค้าเดิม ไม่บอก 'ไม่มีข้อมูล'"),
    ("มีสเปกจริง", has_spec_info, "ตอบมีสเปกของสินค้าเดิม"),
], "ปัญหา 5: follow-up ไม่ตัดสินค้าเดิม (รอบ 1: มีสายชาร์จอะไรบ้าง)")
all_issues.extend(issues)

# ── Q6: follow-up ถามรับประกัน — ปัญหา 5 (ไม่ตัดสินค้าเดิม) ──
d6a = send("หัวชาร์จ 65w มีไหม")
ans6a = d6a["answer"]
d6b = send("รุ่นนี้รับประกันกี่ปี", history=[
    {"role": "user", "text": "หัวชาร์จ 65w มีไหม"},
    {"role": "model", "text": ans6a[:400]},
])
issues = check_answer(d6b, "รุ่นนี้รับประกันกี่ปี", [
    ("ตอบรับประกัน 2 ปี", mentions_warranty_years, "ตอบ 'รับประกัน 2 ปี' จากสินค้าเดิม"),
    ("ไม่แนบเงื่อนไขยาว", not_mentions_warranty_conditions, "ไม่แนบเงื่อนไขรับประกันเบื้องต้นยาวๆ"),
], "ปัญหา 5: follow-up ถามรับประกัน (รอบ 1: หัวชาร์จ 65w มีไหม)")
all_issues.extend(issues)

# ── Q7: ขอรุ่นอื่น — ปัญหา 5 (ตัดสินค้าเดิม) ──
d7a = send("มีสายชาร์จอะไรบ้าง")
ans7a = d7a["answer"]
# ดึงชื่อสินค้าจากคำตอบรอบแรก
import re
first_products = re.findall(r"\*\*([^*]+)\*\*", ans7a)
first_names = [n.strip() for n in first_products if n.strip()][:3]
d7b = send("มีอีกไหม", history=[
    {"role": "user", "text": "มีสายชาร์จอะไรบ้าง"},
    {"role": "model", "text": ans7a[:400]},
])
# ตรวจว่าสินค้ารอบใหม่ไม่ซ้ำรอบเดิม
ans7b = d7b["answer"]
new_products = re.findall(r"\*\*([^*]+)\*\*", ans7b)
new_names = [n.strip() for n in new_products if n.strip()][:3]
overlap = [n for n in new_names if any(f in n or n in f for f in first_names)]

issues = check_answer(d7b, "มีอีกไหม", [
    ("ตัดสินค้าเดิม", lambda d: len(overlap) == 0, f"สินค้าใหม่ไม่ซ้ำของเดิม (เดิม: {first_names[:2]})"),
    ("ยังตอบได้", lambda d: len(d.get("products", [])) > 0, "ยังมีสินค้าแนะนำ"),
], "ปัญหา 5: ขอรุ่นอื่น ตัดสินค้าเดิม (รอบ 1: มีสายชาร์จอะไรบ้าง)")
if overlap:
    print(f"  ⚠️ สินค้าซ้ำ: {overlap}")
all_issues.extend(issues)

# ── Q8: web search flow — ปัญหา 4 ──
d8 = send("สายถัก iphone 17 promax มีไหม")
issues = check_answer(d8, "สายถัก iphone 17 promax มีไหม", [
    ("เข้า web search", is_web_search_flow, "source=product_store+web_search"),
    ("ไม่มีลิงก์นอก", lambda d: not has_external_link(d), "ไม่มีลิงก์จากเว็บอื่น"),
    ("ตอบสินค้า DB", lambda d: len(d.get("products", [])) > 0, "มีสินค้าจาก DB แนะนำ"),
    ("ไม่บอกไม่มีข้อมูล", has_no_info, "ตอบมีสเปก ไม่บอก 'ไม่มีข้อมูล'"),
], "ปัญหา 4: web search ตอบจาก DB เราเท่านั้น")
all_issues.extend(issues)

# ── สรุป ──
print(f"\n{'='*80}")
print(f"📋 สรุปผลการทดสอบ")
print(f"{'='*80}")
if all_issues:
    print(f"❌ มีปัญหา {len(all_issues)} จุด:")
    for iss in all_issues:
        print(f"   - {iss}")
else:
    print("✅ ผ่านทั้งหมด — ไม่มีปัญหา")
print(f"{'='*80}")
