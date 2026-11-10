# docs/test — suite ทดสอบ (จัดหมวดตามสิ่งที่ต้องใช้จริง)

| โฟลเดอร์ | คือ | ต้องมีอะไร | จำนวน |
|---|---|---|---|
| `live/` | เทสที่ยิงของจริง — bot server (:8010/:8011), Mongo จริง, Gemini/OpenRouter จริง | server + .env + API keys | ~32 ไฟล์ |
| `offline/` | pytest logic ล้วน — conftest.py stub Mongo/dotenv/network ให้ | อย่างเดียว (ไม่ต้องมี server) | ~84 ไฟล์ |
| `tools/` | script ครั้งเดียว / diag / eval / corpus builder — รันเอง ไม่ใช่ pytest | ตามแต่ละตัว | ~30 ไฟล์ |

ที่ root: `conftest.py` (offline boundary — บังคับใช้กับทุก subdir), `run_fresh_tests.sh`, `fixtures/`, `logs/` (gitignore), `results/` (gitignore)

## live/ — รายการสำคัญ

- `testQA2.py` — suite หลัก: ยิงคำถามจริงทุกสินค้า (runners: `run_daily_tests.py` อยู่ที่นี่, `../run_fresh_tests.sh`)
- `test_200.py`, `test_comprehensive.py`, `test_all_conditions.py` — ชุดคำถามจริง 200+ ข้อ
- `test_pingevox_mistore.py`, `live_pingevox_mistore_inproc.py`, `test_unit_live_compare.py` — live regression เฉพาะร้าน/units
- `live_matrix_abc.py` — Phase 10B live A/B/C matrix (Mongo+Gemini จริง, read-only)
- `canary_*.py` — canary acceptance ตาม phase

## offline/ — pytest (รัน `pytest docs/test/offline`)

- `test_zaapi_kb_files.py` (52), `test_zaapi_kb_import.py`, `test_zaapi_kb_diff_*.py` — Zaapi KB suites
- `test_phase4*`, `test_phase5*`, `test_phase7*`, `test_phase8*`, `test_phase10*`, `test_phase11*` — Phase contracts
- `test_candidate_pool_union.py`, `test_grouped_retrieval_executor.py`, `test_turn_decision*.py` — retrieval/pool
- `test_car_charger_regression.py`, `test_warranty*`, `test_answer_boundary*` — domain regression
- helpers ที่ test ใช้ร่วม: `mongo_doubles.py`, `zaapi_phase4_helpers.py` อยู่ใน `tools/` (conftest เพิ่ม path ให้แล้ว)

## tools/ — script รันเอง (ชื่อ `check_*` = script-style มี sys.exit — pytest ไม่เก็บ)

- `check_flow.py` (เดิม test_flow.py), `check_compat_mode_filter.py`, `check_handoff_transport.py`, `check_pool_sources_admission.py` — live checks แบบ script
- `run_daily_tests.py` อยู่ใน `live/` (orchestrator ของ testQA2)
- `check_progress.py` — ดูความคืบหน้า testQA2
- `analyze_*.py`, `bench_*.py`, `diag_*.py`, `eval_*.py`, `canary_*` ที่เป็น offline, `build_unit_reg_corpus.py`, `push_unit_reg_to_admin.py`, `find_qa_conversations.py`, `mongo_doubles.py`, `zaapi_phase4_helpers.py`
- data: `gold_retrieval*.jsonl/.js`, `gold_review.html`, `index.html`

## วิธีรัน

```bash
# offline ทั้งหมด (ปลอดภัย สุด)
.venv/bin/python -m pytest docs/test/offline -q

# live suite (ต้องมี bot server + keys)
python docs/test/run_fresh_tests.sh        # หมุน key 2-7
python docs/test/live/run_daily_tests.py   # daily runner
python docs/test/tools/check_progress.py   # ดู progress
```

> หมายเหตุ: การแยกโฟลเดอร์ทำให้ `Path(__file__).parents[N]` ในไฟล์ย้ายถูก patch +1 แล้ว — ถ้าเพิ่ม test ใหม่ให้ใช้ pattern `parents[3]` สำหรับ repo root / `parents[1]` สำหรับ docs/test
