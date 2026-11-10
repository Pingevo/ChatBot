"""วิเคราะห์ผล replay 12 conversation จาก QA notes — เช็ค bug เดิมหายไหม + มีเคสใหม่ไหม.

อ่านไฟล์ test/results/replay_conv_*.json (ใหม่สุดของแต่ละ conv)
เช็ค:
  BUG-10: answer มี "หมดสต็อก...ทุก/ทั้งร้าน" หรือ "ขาย...เป็นหลัก" จาก source product_store/web_search
  BUG-1:  การ์ดออเดอร์ ([order:/เลขออเดอร์) → source ควรเป็น order_lookup
  BUG-2:  answer มี "[[" หลุด
  BUG-3:  answer อ้าง "แอดมินมา(ดูแล|แล้ว)" โดย handoff=False
  BUG-6:  bot_error / 500
  BUG-11: bot_ws=True (ใช้ web search — แพง)
"""
from __future__ import annotations

import glob
import json
import os
import re
import sys

RESULTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test", "results")

# conv_id → ชื่อลูกค้า (ตาม QA notes)
CONV_NAMES = {
    "shp_458397960147048739": "m8iolenl0i",
    "shp_60418748263294927": "pornpansonsuwan",
    "shp_2512944112716742475": "taweep154",
    "shp_189458811488865924": "aroranuch2511",
    "shp_4706202213883068417": "0xgssknoa9",
    "shp_2234370743100585429": "thunderblackhousr",
    "shp_4243515972619489117": "takdanaikunasatittayakul",
    "shp_458397959910495383": "pornchita_24",
    "shp_1337984705527833202": "bloodymaryx",
    "shp_3440141253415424272": "peeslnwza007",
    "shp_3274132825964099029": "nt_sumittra",
    "shp_25168654584899535": "sirikanjanapintep",
}

BUG10_PATTERNS = [
    r"ทุกรายการ.{0,30}หมดสต็อก", r"ทั้งร้าน.{0,40}หมดสต็อก",
    r"หมดสต็อก.{0,20}(ทุก|ทั้งร้าน|บางรุ่น.{0,10}ปิดการขาย)",
    r"ขาย.{0,30}เป็นหลัก",
]
BUG3_PATTERN = r"แอดมิน(มาดูแล|ดูแลแล้ว|ได้รับเรื่อง.{0,10}เรียบร้อย)"
ORDER_MSG_PATTERN = r"\[order[^\]]*\]|[0-9]{8}[A-Z0-9]{6,}"


def analyze_file(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    convs = data.get("results") or data.get("conversations") or []
    if not convs:
        return {"file": os.path.basename(path), "error": "no results"}
    c = convs[0]
    conv_id = c.get("conv_id", "")
    out = {"file": os.path.basename(path), "conv": conv_id,
           "name": CONV_NAMES.get(conv_id, "?"), "shop": c.get("shop_name", "?"),
           "qa": [], "issues": []}
    for q in (c.get("qa") or []):
        ans = q.get("bot_answer", "") or ""
        user = q.get("user_text", "") or ""
        item = {
            "i": q.get("i"),
            "user": user[:70],
            "source": q.get("bot_source", ""),
            "handoff": bool(q.get("bot_handoff")),
            "ws": bool(q.get("bot_ws")),
            "err": bool(q.get("bot_error")),
            "answer": ans[:160].replace("\n", " "),
        }
        # เช็ค bug markers
        tags = []
        if q.get("bot_error"):
            tags.append("BUG6:ERROR")
        low = ans
        if any(re.search(p, low) for p in BUG10_PATTERNS):
            tags.append("BUG10:แต่งสต็อก/แคตตาล็อก")
        if "[[" in ans:
            tags.append("BUG2:KBหลุด")
        if re.search(BUG3_PATTERN, ans) and not q.get("bot_handoff"):
            tags.append("BUG3:โกหกแอดมินมาแล้ว(no-handoff)")
        is_order_msg = bool(re.search(ORDER_MSG_PATTERN, user))
        if is_order_msg and q.get("bot_source") != "order_lookup":
            tags.append(f"BUG1:การ์ด/เลขออเดอร์ไม่เข้าorder_lookup(={q.get('bot_source','')})")
        if q.get("bot_ws"):
            tags.append("BUG11:web_search(แพง)")
        item["tags"] = tags
        if tags:
            out["issues"].extend([f"Q{q.get('i')} {t}" for t in tags])
        out["qa"].append(item)
    return out


def main() -> None:
    # เลือกไฟล์ใหม่สุดต่อ conv
    by_conv: dict[str, str] = {}
    for p in sorted(glob.glob(os.path.join(RESULTS_DIR, "replay_conv_*.json"))):
        try:
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
            convs = d.get("results") or d.get("conversations") or []
            if convs:
                cid = convs[0].get("conv_id", "")
                if cid in CONV_NAMES:
                    by_conv[cid] = p  # sorted → ท้ายสุดคือใหม่สุด
        except Exception:
            pass

    total_issues = 0
    for cid, name in CONV_NAMES.items():
        path = by_conv.get(cid)
        if not path:
            print(f"\n{'='*78}\n[{name}] {cid} — ❌ ไม่พบไฟล์ replay")
            continue
        r = analyze_file(path)
        print(f"\n{'='*78}")
        print(f"[{r['name']}] {cid}  shop={r['shop']}  ({len(r['qa'])} turns)")
        print(f"{'='*78}")
        for item in r["qa"]:
            tag_str = ("  ⚠️ " + ", ".join(item["tags"])) if item["tags"] else ""
            print(f"  Q{item['i']:>2} [{item['source'] or '?':<28}] handoff={int(item['handoff'])} ws={int(item['ws'])} err={int(item['err'])}{tag_str}")
            print(f"      U: {item['user']}")
            print(f"      B: {item['answer']}")
        if r["issues"]:
            total_issues += len(r["issues"])
            print(f"  --> ISSUES: {r['issues']}")
        else:
            print(f"  --> ✅ ไม่มี marker ของ bug เดิม (BUG-10/1/2/3/6/11)")
    print(f"\n\n{'#'*78}")
    print(f"TOTAL issue markers ทั้งหมด: {total_issues}")
    print(f"{'#'*78}")


if __name__ == "__main__":
    main()
