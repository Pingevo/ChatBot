#!/usr/bin/env python3
"""
test_timeline_card_refresh.py — timeline restore ต้องคืน card สด ไม่ใช่ snapshot เก่า

ที่มา (shadow gen thitirat.rac, 2026-09-18): หลัง fix variant image แล้ว
generate ใหม่ยังโชว์ desc banner th-11134208 — เพราะ card ที่เก็บใน
conversation_products เป็น snapshot จากโค้ดเก่า ถูก replay ผ่าน
CONV-ACTIVE/resolve_active_by_message โดยไม่ rebuild (ไม่มี TTL, self-perpetuate)

ตรวจ:
1. unit-level entry (variants ตัวเดียว) → card สด: image_url = variant image จริง
   + name/stock สดจาก DB (ไม่ใช่ค่าปลอมใน stored card)
2. listing-level entry (variants หลายตัว) → image_url = cover image_id_list[0]
3. item_id หายจาก DB → fallback stored card เดิม (ไม่ raise)
4. entry ไม่มี card → minimal dict เหมือนเดิม

ต้อง MongoDB จริง (admin + product DB) — เช่นเดียวกับ test อื่นใน repo
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chatbot"))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat import conversation_products as cp

# item จริง: listing รวมหลายรุ่น — variant "สายชาร์จ CTC315P ขาว" มีรูปตัวเอง
_ITEM_ID = 6359177007
_UNIT_MODEL = "สายชาร์จ CTC315P ขาว"
_UNIT_IMG = "https://cf.shopee.co.th/file/th-11134207-7rash-m8zynhw4wjrd0a"
# item 7620011591: listing สายชาร์จ AL870/CL315P — cover = image_id_list[0]
_LISTING_ID = 7620011591
_LISTING_COVER = "https://cf.shopee.co.th/file/sg-11134201-82586-mt6623k9jhftc9"

_CID = "test_card_refresh_conv"
_STALE_IMG = "https://cf.shopee.co.th/file/STALE_IMG_MARKER"


def _seed(products: list[dict], active_item_id) -> None:
    cp.save_timeline(_CID, "shopee", "ZMIThailand", products, active_item_id)


def _cleanup() -> None:
    try:
        cp._coll().delete_one({"conversation_id": _CID})
    except Exception:
        pass


def _check(label: str, actual, expected) -> bool:
    ok = actual == expected
    print(f"  {'✅' if ok else '❌'} {label}: actual={actual!r} expected={expected!r}")
    return ok


def main() -> int:
    passed = total = 0
    try:
        # ── 1) unit-level entry → ต้องได้ card สด (variant image + name/stock สด)
        _seed([{
            "item_id": _ITEM_ID, "model_id": None, "model_name": None,
            "name": "OLD NAME (stale)", "source": "bot_suggestion",
            "is_anchor": False,
            "card": {
                "item_id": _ITEM_ID, "name": "OLD NAME (stale)",
                "image_url": _STALE_IMG, "status": "NORMAL",
                "total_stock": 1, "sold_out": True,
                "variants": [{"name": _UNIT_MODEL}],
            },
        }], _ITEM_ID)
        card = cp.resolve_active_by_message(_CID, "ตัวนี้ยังมีไหม")
        total += 4
        passed += _check("unit entry → variant image สด",
                         (card or {}).get("image_url"), _UNIT_IMG)
        passed += _check("unit entry → name สด (ไม่ใช่ stale)",
                         "OLD NAME" in ((card or {}).get("name") or ""), False)
        passed += _check("unit entry → stock สด (ไม่ใช่ 1 ปลอม)",
                         (card or {}).get("total_stock") == 1, False)
        passed += _check("unit entry → sold_out สด",
                         (card or {}).get("sold_out"), False)

        # ── 2) listing-level entry → cover image สด
        _seed([{
            "item_id": _LISTING_ID, "model_id": None, "model_name": None,
            "name": "OLD LISTING NAME", "source": "bot_suggestion",
            "is_anchor": False,
            "card": {
                "item_id": _LISTING_ID, "name": "OLD LISTING NAME",
                "image_url": _STALE_IMG,
                "variants": [{"name": "CUKTECH AL870 (MFI)"},
                             {"name": "CUKTECH CL315P (MFI)"}],
            },
        }], _LISTING_ID)
        card = cp.get_active_product(_CID)
        total += 2
        passed += _check("listing entry → cover image สด",
                         (card or {}).get("image_url"), _LISTING_COVER)
        passed += _check("listing entry → name สด",
                         "CUKTECH" in ((card or {}).get("name") or ""), True)

        # ── 3) item หายจาก DB → fallback stored card (ไม่ raise)
        _seed([{
            "item_id": 999999999, "model_id": None, "model_name": None,
            "name": "GONE", "source": "bot_suggestion", "is_anchor": False,
            "card": {"item_id": 999999999, "name": "GONE",
                     "image_url": _STALE_IMG},
        }], 999999999)
        card = cp.get_active_product(_CID)
        total += 1
        passed += _check("missing doc → stored card fallback",
                         (card or {}).get("image_url"), _STALE_IMG)

        # ── 4) entry ไม่มี card → minimal dict (shape เดิม)
        _seed([{
            "item_id": 999999999, "model_id": None, "model_name": None,
            "name": "NO CARD", "source": "bot_suggestion", "is_anchor": False,
            "card": None,
        }], 999999999)
        card = cp.get_active_product(_CID)
        total += 1
        passed += _check("no card → minimal {item_id, name}",
                         (card or {}).get("name"), "NO CARD")
    finally:
        _cleanup()

    print(f"\n{passed}/{total} passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
