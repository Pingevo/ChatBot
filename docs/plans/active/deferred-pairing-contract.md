# Deferred Product↔Product Pairing — Non-Executable Contract

สถานะ: **DEFERRED — NOT PRODUCTION READY** (Task 5 simplification, 2026-11-05)
เอกสารฉบับนี้เป็น specification เท่านั้น — ไม่ใช่ executable test suite

## 1. เหตุผล defer

Pairing subsystem (R7–R11D) เติบโตเกิน approved master plan scope
(Stage 2.6–10): 18 defs, ~700 LOC ข้าม 5 owners, +3 semantic regexes,
+1 guard tier, +1 dataclass field, +1 boundary param — ทั้งหมดเป็น
customer-answer feature ไม่ใช่ KB-core requirement. ลบทั้งหมดใน
simplification แทนด้วย typed decline เดียวใน `compile_answer_context`:
productish need ที่ขอ `compatibility` ผูก `subject_refs` แต่ไม่มี
authoritative typed relation result และไม่มี device target →
`UnansweredNeed(no_evidence)` + drop task (model ไม่ถูกถาม pairing).

## 2. Known failure modes (R7–R11D — source tests เดิมใน
   `docs/test/offline/test_task5_final_answer.py` ที่ถูกลบ)

- B1–B6: card-text/negated connector mention ถูกใช้เป็น port proof
  (`test_pairing_*`)
- sibling-variant leakage: spec ของ variant A รั่วไป variant B
  (`test_pairing_sibling_*`)
- cross-product authorization: verdict ของ product หนึ่ง authorize
  claim ของอีกตัว (`test_pair_verdict_*`)
- provider exception/malformed/extra-scope/name-spoof verdicts
  (`test_pair_provider_*`, `test_pair_scope_*`, `test_pair_name_*`)
- text/identity divergence: `target_name` spoofed render เป็น product
  อื่น (`test_pairing_paraphrase_*`)
- mixed/multi-ask pairing = open contract (จงใจไม่ปิด —
  `MIXED_MULTI_NEED_PAIRING_OWNERSHIP_OPEN`)

## 3. Executable gate ที่ยังอยู่

`docs/test/test_pairing_safety_canary.py` (4 tests) — negative safety
เท่านั้น: unsupported positive = 0 · wrong-item = 0 · unknown ≠
compatible · attachment ≠ endorsement. ไม่บังคับให้ตอบ pairing ได้

## 4. Re-entry criteria (ทุกข้อ)

1. structured `host_connector`/connector facts มีใน production
   units/Zaapi data จริง (ไม่ใช่ backfill spec)
2. typed owner เดียวสำหรับ pairing decision — ไม่ใช่ prose regex
3. mixed/multi-need pairing contract ออกแบบและอนุมัติแล้ว
4. user approval ชัดเจน — ไม่ใช่ resume เงียบ
5. baseline-vs-candidate QA replay พิสูจน์: unsupported positive = 0,
   wrong-item = 0, cannot-confirm ไม่แย่กว่า legacy
6. structured connector backfill ได้รับ authorization แยก
