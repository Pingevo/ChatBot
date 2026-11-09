# R0 — ai_usage instrumentation + prompt distillation plan

## Verified baseline (checked before writing — no guessing)

- **Token usage exists** at ~7 call sites in `llm.py` (lines ~920, 1333, 1558, 1632, 1766, 1881) — extracted from `usage_metadata` (prompt/candidates/total)
- **NOT persisted anywhere** — `admin_logs`/`test_chat_logs` have no token/cost fields; only used transiently (quota tracker `_q_tok` deque)
- **`_gemini_cost` exists** (line 24, rates in `$/M`) but never called → cost math available but unused
- **Latency** — `bot_elapsed_ms` in shadow_replies p95=46.5s (39k samples) — this IS persisted ✓
- **Prompt size unknown** — SYSTEM_INSTRUCTION + product cards + history assembled per call; never measured

## Design (minimal, mirrors existing patterns)

New collection `ai_usage` (admin db) — one doc per LLM call:
```
{ts, model, path: "answer"|"vision"|"typed"|"description"|..., shop, conv_id,
 prompt_tokens, output_tokens, total_tokens, est_cost_usd, elapsed_ms,
 cache_hit?, request_id}
```
- Log via single helper `_log_usage(...)` in llm.py — called at each usage_metadata extraction site
- Fire-and-forget (match admin_logs pattern), no request-path blocking
- Env kill-switch `AI_USAGE_LOG=0`

## Steps

1. Add `_log_usage()` + wire the ~7 call sites (same commit, verify py_compile + one live call writes doc)
2. Wait 1-2 days production data → measure: tokens/call by path, cost/day, p50/p95 prompt size
3. THEN distill prompt — target biggest contributors only (never guess)

## Explicitly not doing

- No prompt changes until data exists (per spec: measure before reduce)
- No new external service — reuse admin Mongo + existing write pattern

## R0 step 2 — CORE_B modularization (user-approved design 2026-11-09)

**สถาปัตยกรรม**: system prompt = `_SYS_CORE_A` (บุคลิกทั่วไป — ส่งเสมอ)
+ `needs → sections` (ส่งเฉพาะกฎที่ match intent)

**Split map ของ _SYS_CORE_B (char offsets — ตัดที่นี่)**:
- 0–2340: กฎตอบทั่วไป (สั้นเจาะจง/กำกวม/ละเอียด) → `core_answer`
- 2340–3944: ตอบละเอียด+เสริมประโยชน์ → `core_answer`
- 3944–7164: upsell/context-ไม่ใช่แคตตาล็อก/ใช้ความรู้ทั่วไป → `recommend`
- 7164–8455: ห้ามบอกไม่มีข้อมูล+slang แอปสี → `core_answer`
- 8455–11667: กฎเหล็กจับคู่สายชาร์จ/รุ่น/2 ฝั่ง → `product_match`
- 11667–13763: MagSafe/แม่เหล็ก → `product_match` (เฉพาะถามเกี่ยว)
- 13763–17549: แยกประเภทสินค้า/กฎเหล็ก ≥2 รุ่น/แยก bubble → `recommend`
- 17549–18723: แยก bubble แนะนำสินค้า → `recommend`
- 18723–20816: ขอบเขตร้าน/ลิงก์-รูป/trust → `recommend`
- 20816–23457: โครงสร้างตารางเปรียบเทียบ spec-by-spec → `compare`
- 23457–23838: stock → `recommend`
- 23838–25402: การแสดงรูปสินค้า → `recommend`
- 25402–27216: กฎแบ่งข้อความ + กฎเหล็ก 3 ข้อ (ขายจริง/เลิกขาย/เคลมห้ามขาย) → `core_answer` (ส่งเสมอ — safety)
- 27216+: claim ห้ามเสนอขาย → `claim`

**กฎที่ผู้ใช้ย้ำต้องคงไว้**:
1. แนะนำสินค้า = text พูดถึง 1–3 ตัวเลือก แต่ส่ง **การ์ดสินค้าเดียว** (อยู่ใน `recommend`)
2. เปรียบเทียบ = ตาราง spec-by-spec + คำแนะนำเหมาะกับ use case ไหน (อยู่ใน `compare`)

**Implementation**: `prompt_sections.py` — `build_system(needs) -> str`;
flag `PROMPT_MODULAR=1` เปิดใช้; flag ปิด = prompt เดิม byte-identical (ปลอดภัย 100%)
**QA gate**: ยิง ~20 คำถามจริง compare before/after — คำตอบต้องยังถูก/ครบ ไม่ใช่แค่รันผ่าน
