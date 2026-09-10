"""shop_link — สร้างลิงก์ร้านสำหรับ chatbotv3.

Format จริงที่ใช้ (ตามที่ user ยืนยัน):
  https://shopee.co.th/{shopname_lower}?entryPoint=ShopBySearch&searchKeyword={shopname_lower}

ตัวอย่าง:
  KingGadgets → https://shopee.co.th/kinggadgets?entryPoint=ShopBySearch&searchKeyword=kinggadgets
  ThaiSuperPhone → https://shopee.co.th/thaisuperphone?entryPoint=ShopBySearch&searchKeyword=thaisuperphone

⚠️ shops collection ใน admin DB มีแค่ shopname + shop_id (ไม่มี field shop_url)
   ดังนั้นใช้ shopname.lower() เป็น username ใน URL — เป็น default ที่ใช้ได้สำหรับ Shopee
   (Shopee shop URL ใช้ shopname ตัวเล็กทั้งหมด)
"""
from __future__ import annotations

import urllib.parse


def build_shop_url(shop_name: str | None, platform: str | None = None) -> str:
    """สร้างลิงก์ร้านจากชื่อร้าน + platform.

    Args:
        shop_name: ชื่อร้าน (เช่น "KingGadgets", "ThaiSuperPhone")
        platform: platform ("shopee" / "tiktok" / "lazada") — default "shopee"

    Returns:
        ลิงก์ร้าน full URL พร้อม query params
        ถ้าไม่มี shop_name → คืน ""
    """
    if not shop_name or not shop_name.strip():
        return ""

    shop_lower = shop_name.strip().lower()
    # ลบ space และอักขระพิเศษที่ไม่ใช้ใน URL (Shopee username มีแค่ตัวอักษร+ตัวเลข)
    shop_lower = "".join(c for c in shop_lower if c.isalnum() or c in ("-_",))

    if not shop_lower:
        return ""

    plat = (platform or "shopee").lower()

    if plat == "shopee":
        # Format จริงที่ user ยืนยัน
        keyword = urllib.parse.quote(shop_lower)
        return f"https://shopee.co.th/{shop_lower}?entryPoint=ShopBySearch&searchKeyword={keyword}"
    elif plat == "tiktok":
        # TikTok shop URL format (placeholder — ยังไม่ใช้จริง)
        return f"https://shop.tiktok.com/view/shop/{shop_lower}"
    elif plat == "lazada":
        # Lazada shop URL format (placeholder — ยังไม่ใช้จริง)
        return f"https://www.lazada.co.th/shop/{shop_lower}"
    else:
        # default: ใช้ Shopee format
        keyword = urllib.parse.quote(shop_lower)
        return f"https://shopee.co.th/{shop_lower}?entryPoint=ShopBySearch&searchKeyword={keyword}"


def build_shop_context_block(
    shop_name: str | None,
    platform: str | None = None,
) -> str:
    """สร้าง context block สำหรับแปะใน user prompt ส่งให้ OpenRouter.

    รูปแบบ:
        ---
        ข้อมูลร้าน:
        - แพลตฟอร์ม: Shopee
        - ชื่อร้าน: KingGadgets
        - ลิงก์ร้าน: https://shopee.co.th/kinggadgets?entryPoint=ShopBySearch&searchKeyword=kinggadgets
        ⚠️ สำคัญอย่างยิ่ง: ให้ตอบแค่สินค้าในลิงก์ร้านนี้เท่านั้น
        ห้ามเอาสินค้าจากลิงก์อื่น/ร้านอื่นมาตอบเด็ดขาด
        แนะนำตามคำถามและบริบทที่ส่งมาเท่านั้น
        ---

    Args:
        shop_name: ชื่อร้าน
        platform: platform

    Returns:
        context block text (ถ้าไม่มี shop_name → คืน "")
    """
    if not shop_name or not shop_name.strip():
        return ""

    shop_url = build_shop_url(shop_name, platform)
    plat_display = {
        "shopee": "Shopee",
        "tiktok": "TikTok",
        "lazada": "Lazada",
    }.get((platform or "shopee").lower(), platform or "Shopee")

    lines = [
        "---",
        "ข้อมูลร้าน:",
        f"- แพลตฟอร์ม: {plat_display}",
        f"- ชื่อร้าน: {shop_name}",
    ]
    if shop_url:
        lines.append(f"- ลิงก์ร้าน: {shop_url}")
        lines.append(
            "⚠️ สำคัญอย่างยิ่ง: ให้ตอบแค่สินค้าในลิงก์ร้านนี้เท่านั้น "
            "ห้ามเอาสินค้าจากลิงก์อื่น/ร้านอื่นมาตอบเด็ดขาด "
            "แนะนำตามคำถามและบริบทที่ส่งมาเท่านั้น"
        )
    lines.append("---")
    return "\n".join(lines)
