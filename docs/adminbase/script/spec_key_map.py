"""spec_key_map.py — mapping ชื่อ column Excel จริง → canonical spec key.

canonical key = ชื่อมาตรฐานภาษาอังกฤษที่ bot/LLM ใช้ตอบได้สม่ำเสมอ
คอลัมน์ที่ไม่มีใน map → specs_raw (ไม่ทิ้งข้อมูล)

match: normalize (lower+strip) → exact → prefix (alias ≥8 chars อยู่ต้น header)
"""
from __future__ import annotations

# canonical_key → list ของชื่อ column จริง (จะ normalize ตอน lookup)
SPEC_KEY_MAP: dict[str, list[str]] = {
    # ── powerbank/charger/cable ──
    "capacity_mah": ["ขนาดของแบตเตอรี่", "ความจุแบตเตอรี่"],
    "rated_capacity": ["ปริมาณแบตเตอรี่"],
    "capacity_wh": ["ค่า wh"],
    "max_power": ["กำลังไฟสูงสุด"],
    "builtin_cable": ["ประเภทของสาย"],
    "cable_length": ["ความยาวสาย"],
    "input_spec": ["สเปคกำลังไฟ input"],
    "output_spec": ["สเปคกำลังไฟ output"],
    "multiport_output": ["สเปคกำลังไฟ output พร้อมกัน"],
    "current_spec": ["สเปคกระแสไฟ"],
    "wireless_charging": ["ระบบชาร์จไรสาย", "ระบบชาร์จไร้สาย", "ชาร์จไร้สาย"],
    "plug_type": ["ประเภทขาปลั๊กไฟ"],
    "mfi": ["mfi"],
    "e_marker": ["e/marker"],
    "carplay": ["apple carplay"],
    "android_auto": ["android auto"],
    "max_video_res": ["ความละเอียดภาพที่รองรับสูงสุด"],
    "low_current_mode": ["โหมดจ่ายไฟด้วยกำลังไฟต่ำ"],
    "hub_mode": ["ใช้งานเป็นโหมด hub"],
    "flight_safe": ["รองรับการนำขึ้นเครื่องบิน"],
    "ccc_cert": ["รองรับมาตรฐาน 3c", "มาตรฐาน 3c", "ccc"],
    "fast_charge_tech": ["เทคโนโลยีชาร์จเร็วที่รองรับ", "เทคโนโลยีชาร์จเร็ว"],
    "supported_devices": ["อุปกรณ์ที่รองรับ"],
    # ── camera ──
    "resolution": ["ความละเอียด"],
    "lens": ["เลนส์/มุม", "เลนส์"],
    "video_codec": ["การเข้ารหัสวิดีโอ"],
    "connectivity": ["การเชื่อมต่อ"],
    "voltage": ["แรงดันไฟฟ้า"],
    "operating_temp": ["อุณหภูมิใช้งาน"],
    "os_support": ["รองรับ os"],
    "storage": ["พื้นที่จัดเก็บ"],
    "aperture": ["รูรับแสง"],
    # ── smartwatch ──
    "screen_size": ["ขนาดหน้าจอนาฬิกา"],
    "screen_type": ["ลักษณะของหน้าจอนาฬิกา"],
    "screen_hz": ["hz ของหน้าจอนาฬิกา"],
    "battery_life": ["ระยะเวลาการใช้งานสูงสุดต่อการชาร์จ"],
    "power_source": ["ประเภทของแหล่งเก็บพลังงาน"],
    "mic": ["ไมโครโฟน"],
    "health_metrics": ["การวัดค่าสุขภาพ"],
    "thai_menu": ["เมนูภาษาไทย"],
    "compat_bluetooth": ["เวอร์ชั่นบูลทูธของมือถือที่สามารถเชื่อมต่อได้"],
    "compat_android": ["เวอร์ชั่น android ของมือถือที่สามารถเชื่อมต่อได้"],
    "compat_ios": ["เวอร์ชั่น ios ของมือถือที่สามารถเชื่อมต่อได้"],
}


def _norm(s: str) -> str:
    return " ".join((s or "").strip().lower().split())


# alias (normalized) → canonical — สร้างครั้งเดียว
_ALIAS: dict[str, str] = {}
for _canon, _names in SPEC_KEY_MAP.items():
    for _n in _names:
        _ALIAS[_norm(_n)] = _canon


def canonical_of(header: str) -> str | None:
    """คืน canonical key ของ column header หรือ None ถ้าไม่รู้จัก."""
    h = _norm(header)
    if not h:
        return None
    if h in _ALIAS:
        return _ALIAS[h]
    # prefix match — header ยาวถูกตัด/มีหน่วยต่อท้าย เช่น "ค่า Wh (วัตต์ชั่วโมง)"
    for alias, canon in _ALIAS.items():
        if len(alias) >= 4 and h.startswith(alias):
            return canon
    return None
