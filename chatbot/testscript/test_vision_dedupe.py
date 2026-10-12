"""RED→GREEN — llm.describe_images ต้อง dedupe exact-string URL (preserve order) ก่อน max_images

run: cd chatbot && ../.venv/bin/python testscript/test_vision_dedupe.py

หลักฐาน defect: app.py `_urls_to_read` รวม history images (ที่ไม่มี image_desc)
+ req.images โดยไม่ dedupe ข้ามแหล่ง — URL เดียวกัน (ลูกค้าส่งรูปเดิมซ้ำ /
รูปเดิมใน history ที่ยังไม่เคยอ่าน) เข้าถึง describe_images ซ้ำ →
describe_image ถูกเรียกซ้ำ = เสีย Vision call + แถว max_images โดยเปล่าประโยชน์
"""

import os
import sys
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from shopeechat import llm  # noqa: E402

calls: list[str] = []


def fake_describe_image(url, shop_hint=None, history_context=""):
    calls.append(url)
    return f"desc:{url}", {"prompt": 1, "output": 1, "total": 2}


def run(image_urls, max_images=5):
    calls.clear()
    with mock.patch.object(llm, "describe_image", side_effect=fake_describe_image):
        return llm.describe_images(
            image_urls, shop_hint="t", max_images=max_images, history_context=""
        )


def check(name, cond, detail):
    if cond:
        print(f"PASS {name}")
        return True
    print(f"FAIL {name}\n     {detail}")
    return False


def main() -> int:
    ok = True

    # D1 — URL ซ้ำใน batch เดียวกัน → อ่านครั้งเดียว (preserve order)
    desc, usage = run(["u_a", "u_a", "u_b", "u_a"])
    ok &= check(
        "D1 duplicate URLs read once each, order preserved",
        calls == ["u_a", "u_b"],
        f"describe_image calls={calls}",
    )

    # D2 — dedupe ก่อน cap: dup ห้ามกิน quota max_images
    desc, usage = run(["u_a", "u_a", "u_b", "u_c"], max_images=2)
    ok &= check(
        "D2 dedupe before max_images cap",
        calls == ["u_a", "u_b"],
        f"calls={calls} (dup u_a wasted a slot, u_b unseen)",
    )

    # D3 — ไม่มี dup → behavior เดิมครบทุก URL
    desc, usage = run(["u_a", "u_b"], max_images=5)
    ok &= check(
        "D3 distinct URLs unchanged",
        calls == ["u_a", "u_b"] and usage["total"] == 4,
        f"calls={calls} usage={usage}",
    )

    # D4 — empty list → no calls, zero usage (เดิม)
    desc, usage = run([])
    ok &= check(
        "D4 empty input unchanged",
        desc == "" and usage["total"] == 0 and calls == [],
        f"desc={desc!r} usage={usage}",
    )

    print(f"\n{'ALL PASS' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
