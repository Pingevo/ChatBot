# Customer Answer Quality, Zaapi KB, and Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำให้คำตอบลูกค้าตรงคำถาม อ้างหลักฐานและสินค้าเดียวกัน ใช้ Zaapi KB ผ่าน evidence pool ได้จริง และส่งต่อ workflow/handoff ตามผล persisted จริง โดยปิดปัญหาที่ตรวจพบจาก live QA ก่อนจบวันนี้

**Architecture:** รักษา owner เดิมของแต่ละชั้น: `turn_decision` ตัดสิน turn, intent classifier ให้ typed classification, retrieval/selection เลือก evidence และสินค้า, `answer_context` compose คำตอบ, Zaapi file-backed adapter เป็น KB source, workflow/handoff เป็น action owner. งานต้องเดินทีละ root cause พร้อม customer-boundary RED/GREEN; ห้ามเพิ่ม patch ดักข้อความหรือ owner คู่ขนาน.

**Tech Stack:** Python 3.12, FastAPI/Pydantic, pytest, Mongo-compatible test doubles, Next.js 16/TypeScript, tsx workflow tests, Gemini test seam, file-backed Zaapi KB.

**Spec:** `docs/plans/active/2026-11-12-full-system-chatbot-live-qa-report.md`

## Global Constraints

- Priority 1 คือ customer answer quality; ห้ามเริ่ม KB/workflow correction จน quality task ก่อนหน้าผ่าน review gate.
- แก้ business behavior ที่ typed owner เดิมเท่านั้น. ห้ามสร้าง decision owner ใหม่.
- ห้ามเพิ่ม helper, guard, regex, keyword table, heuristic, hardcoded answer หรือ duplicated fallback โดยไม่ได้รับอนุมัติเฉพาะจากผู้ใช้.
- Mechanism allowance ของแผนนี้มีเพียง typed parameter `has_visual_media: bool = False` ที่ `decide_turn`; mechanism อื่นต้อง STOP และขออนุมัติใหม่.
- `guard` ใช้ตรวจ schema/safety invariant เท่านั้น ห้ามใช้ตีความ intent, identity, product type, KB scope หรือ compatibility.
- ทุก correction ต้องมี executable RED ที่ customer boundary ก่อนแก้ และ GREEN ต้องตรวจ final answer, products, evidence/route และ action result ไม่ใช่ source-text assertion.
- ห้ามเปลี่ยน expected test เพื่อรับ behavior ใหม่ เว้นแต่ contract ใน spec ระบุชัดและรายงานเหตุผล.
- ห้ามอ่าน `.env` หรือ `มาแล้วจ้า.md`; Product DB read-only; live provider/Mongo ใช้เฉพาะ isolated QA ตาม authorization แยก.
- เปลี่ยน function ใน `chatbot/shopeechat/` ต้องอัปเดต `docs/SRS_SSD.md` section 6 พร้อม Calls/Called by/side effects/error path.
- รักษา UI dirty work ที่มีอยู่; stage เฉพาะไฟล์ task หลังผู้ใช้อนุมัติ commit. ห้าม stage/commit/push/PR/deploy ระหว่าง execution จนผ่าน pre-commit review.
- Raw QA history/ภาพ/LLM input อยู่ใน gitignored `docs/test/{logs,results}/task6-full-system-qa/`; ห้าม add/commit.
- หนึ่ง task = หนึ่ง root cause. หาก RED ชี้คนละ owner ให้หยุด task นั้นและรายงาน evidence; ห้าม patch ต่อหลายจุด.
- Test cadence บังคับ: ทุก production function ที่แตะต้องมี RED → minimal implementation → GREEN ของฟังก์ชันนั้นก่อนขยับไปฟังก์ชันถัดไป. รัน focused/full regression เพียงครั้งเดียวเมื่อทุกฟังก์ชันใน Task นั้น GREEN แล้ว; ห้ามรัน regression ซ้ำหลังแต่ละฟังก์ชัน. หาก GREEN ของฟังก์ชันหนึ่งเปิดเผยว่าต้องแก้อีก owner ให้ STOP และรายงาน missing contract แทนการขยาย patch.

### Per-Task Test Rhythm

```text
Function A: write targeted RED → run RED → edit A only → run same test GREEN
Function B: write targeted RED → run RED → edit B only → run same test GREEN
Task gate: run the Task regression set exactly once → report → continue
```

Task ที่แก้เพียงฟังก์ชันเดียวก็ใช้จังหวะเดียวกัน: targeted RED/GREEN ก่อน แล้วจึง regression หนึ่งครั้งตอนจบ Task. Task 1 เป็น baseline/fixture task จึงรัน baseline suite หนึ่งครั้งหลัง fixture gate โดยไม่มี production GREEN cycle.

## Review Focus

- Image-only turn ที่มี `req.images` จริงต้องไม่กลายเป็น blank `no_reply`; sticker/placeholder ที่ไม่มี binary image ต้องยัง `no_reply` โดยไม่เรียก Vision.
- Intent provider 429/503 ต้องไม่ถูกแปลงเป็น semantic intent `other`; shipping, thanks และ explicit human request ต้องรักษา route ที่มีหลักฐานจาก owner เดิม.
- Product text, product card, subject identity, shop และ sellable state ต้องสอดคล้อง; ห้ามแนะนำสินค้าต่างรุ่น/ต่างร้านหรือ `sellable=false`.
- Same-identity description/spec ที่ตอบคำถามได้ต้องถึง answer context; direct spec question ห้ามกลายเป็น “ไม่มีข้อมูลสินค้า” เพียงเพราะ field ไม่ถูกผูกกับ need.
- Recommendation ปกติต้องมีหนึ่งสินค้าหลัก/หนึ่ง card; หลายรายการอนุญาตเฉพาะ typed compare/options need. Follow-up ต้อง resolve สินค้าที่แนะนำล่าสุดและ target เดิมโดยไม่ข้าม conversation.
- Zaapi exact-row ที่ Mongo search พบต้อง trace ได้ถึง need/evidence/selection/prompt/final answer; wrong-shop และ conflicting rows ต้อง fail closed.
- ข้อความ “ส่งให้แอดมินแล้ว” ต้องมี persisted handoff outcome `assigned|queued`; failed/not-called ต้องไม่ใช้ success wording และ crash retry ต้องไม่ทำ side effect ซ้ำ.

---

## Same-Day Execution Contract

ทำตามลำดับ Task 1 → 10 เท่านั้น. Phase 1 (Tasks 1–7) ต้องจบหรือมี explicit STOP evidence ภายในวันนี้ก่อนเริ่ม Phase 2. Task 2–3 เป็น known-root corrections; Tasks 4–9 มี localization gate ก่อน implementation. ถ้า gate ใดชี้ว่าต้องเพิ่ม mechanism นอก budget ให้จบวันด้วย RED + root-cause report ของ gate นั้น ไม่สร้างกลไกเพิ่มเพื่อให้ตัวเลขดู GREEN.

Definition of Done วันนี้:

1. Image-only real-media และ intent-provider failure ผ่าน customer-boundary tests.
2. Same-product description/spec ที่มีหลักฐานตอบได้ต้องไม่ตกเป็น no-evidence; compatibility ที่หลักฐานครบต้องตอบ yes/no โดยไม่ใช้ generic cannot-confirm.
3. Recommendation ปกติมีหนึ่ง primary product/card; explicit compare/options เท่านั้นที่คืนหลายรายการ และ answer/card/shop/sellable identity ต้องตรงกัน.
4. Follow-up เช่น “หัวที่ส่งมาใช้กับสายที่แนะนำได้ไหม” ต้องผูก previous suggestion + current subject/target จาก conversation เดียวกัน; ห้ามหยิบสินค้าคนละ turn/ร้าน.
5. Zaapi exact-row canary แสดง chain retrieval → evidence → selected channel → final answer หรือระบุ choke point เดียวด้วย executable evidence.
6. Workflow isolated test พิสูจน์ answer/handoff outcome และ persistence; ไม่ส่ง Shopee จริง.
7. Focused regressions + full offline suite ผ่าน; live replay canary ไม่มี customer send/DB write.
8. รายงาน mechanism delta, remaining failures และข้อจำกัดตรงตามหลักฐาน.

## Phase 1 — Customer Answer Quality (Tasks 1–7)

### Task 1: Freeze the Customer-Answer Acceptance Matrix

**Files:**
- Create: `docs/test/fixtures/customer_answer_quality_v1.json`
- Modify: `docs/test/offline/test_task5_final_answer.py`
- Reference only: `docs/test/logs/task6-full-system-qa/case_index.csv`

**Interfaces:**
- Consumes: redacted case IDs and measured failures from A-211.
- Produces: fixture fields `case_id`, `message`, `history`, `images`, `expected_route`, `required_terms`, `forbidden_terms`, `max_products`, `handoff_expected`.

- [ ] **Step 1: Add a redacted behavioral fixture**

Create a fixture with no customer IDs, addresses, image bytes or conversation IDs. Include at least these input classes: image-only product, image-only sticker, shipping question, thanks, explicit human request, one exact product/spec, requested-feature recommendation, no-evidence spec, active post-handoff and Zaapi exact-row.

```json
[
  {
    "case_id": "image_product_has_media",
    "message": "[รูปภาพ]",
    "history": [],
    "images": ["https://example.invalid/product.jpg"],
    "expected_route": "bot_reply",
    "required_terms": [],
    "forbidden_terms": [],
    "max_products": 1,
    "handoff_expected": false
  },
  {
    "case_id": "shipping_provider_failure",
    "message": "ส่งวันนี้ไหม",
    "history": [],
    "images": [],
    "expected_route": "bot_reply",
    "required_terms": [],
    "forbidden_terms": ["ไม่พบข้อมูลสินค้า"],
    "max_products": 0,
    "handoff_expected": false
  }
]
```

- [ ] **Step 2: Extend the existing `_chat` boundary seam without importing another test module**

Modify `_chat` in `test_task5_final_answer.py` to accept `images=()` and `history=()` and pass them into `ChatRequest`. Preserve the existing body; make only these exact signature/request changes.

```diff
 def _chat(zaapi_recs, msg=_MSG, llm_reply="", shop="ShopA",
           catalog=None, units=None, intent_result=None,
-          patch=None, calls_out=None):
+          patch=None, calls_out=None, images=(), history=()):

             resp = app.chat(app.ChatRequest(
-                message=msg, shop=shop, platform="shopee", history=[],
+                message=msg, shop=shop, platform="shopee",
+                images=list(images), history=list(history),
                 conversation_id=cid, limit=5, simulate_assignment=True,
-                test_source="task5-final-answer"))
+                test_source="customer-answer-quality"))
```

- [ ] **Step 3: Run the unchanged baseline suites**

Run:

```bash
.venv/bin/python -m pytest docs/test/offline/test_turn_decision.py docs/test/offline/test_task5_final_answer.py -q
```

Expected: existing tests pass before new RED cases are added. Record exact counts; do not reuse A-211 counts.

- [ ] **Step 4: Review gate**

Confirm fixture contains no raw identifiers and `git check-ignore` still matches all raw QA artifacts. Do not commit fixture until it is independently reviewed with the implementation.

### Task 2: Make Real Visual Media a Typed Turn Input

**Files:**
- Modify: `chatbot/shopeechat/turn_decision.py:278`
- Modify: `chatbot/shopeechat/app.py:1644`
- Modify: `docs/test/offline/test_turn_decision.py`
- Modify: `docs/test/offline/test_task5_final_answer.py`
- Modify: `docs/SRS_SSD.md` section 6 entries for `decide_turn` and `_chat_impl`

**Interfaces:**
- Consumes: `req.images`, already-resolved text image URLs and existing `TurnPlan` inputs.
- Produces: `decide_turn(message, *, history, ticket_state, claim_state, intent_result, active_anchor, tag_item_ids, has_visual_media=False) -> TurnPlan`; no new TurnPlan field.

- [ ] **Step 1: Write owner-level RED tests**

```python
def test_real_visual_media_placeholder_executes_needs():
    p = decide_turn("[รูปภาพ]", has_visual_media=True)
    assert p.primary_action == "execute_needs"
    assert any(n.kind == "product" for n in p.needs)


def test_placeholder_without_real_media_stays_no_reply():
    p = decide_turn("[รูปภาพ]", has_visual_media=False)
    assert p.primary_action == "no_reply"
    assert p.needs == ()


def test_sticker_without_real_media_never_executes():
    p = decide_turn("[sticker]", has_visual_media=False)
    assert p.primary_action == "no_reply"
```

- [ ] **Step 2: Run owner RED, implement `decide_turn`, then run owner GREEN**

Run only the three owner tests. Confirm the real-media case fails before the edit, add only the approved parameter and existing-flag combination in `decide_turn`, then rerun those same three tests to GREEN. Do not edit the app call site in this cycle.

- [ ] **Step 3: Write customer-boundary RED for `_chat_impl`**

Patch `llm.describe_images` to return a deterministic product description and call `_chat([], msg="[รูปภาพ]", images=("https://example.invalid/p.jpg",))`.

```python
def test_image_with_successful_vision_never_returns_blank_no_reply():
    def patch(mp):
        mp.setattr(llm, "describe_images",
                   lambda *a, **k: ("ภาพสายชาร์จรุ่น CTC620P", {"prompt": 1, "output": 1, "total": 2}))
    resp, _ = _chat([], msg="[รูปภาพ]", images=("https://example.invalid/p.jpg",), patch=patch)
    assert resp.image_desc
    assert (resp.routing_decision or {}).get("path") != "no_reply"
    assert (resp.answer or "").strip()
```

- [ ] **Step 4: Run `_chat_impl` RED**

Run the three named tests. Expected before implementation: real-media tests fail because `decide_turn` sees only the placeholder text.

- [ ] **Step 5: Implement the `_chat_impl` call-site contract**

The `decide_turn` owner change is already GREEN from Step 2. At the single `app._chat_impl` call site pass truth from request/media resolution:

```python
has_visual_media=bool(req.images or _urls_to_read or _image_desc_out),
```

Do not move Vision, add media keywords, or add an output guard in this task.

- [ ] **Step 6: Run `_chat_impl` GREEN**

Run only the named customer-boundary image test and the no-media/sticker locks. They must pass before any regression command.

- [ ] **Step 7: Run the Task 2 regression gate once**

```bash
.venv/bin/python -m pytest docs/test/offline -q
python3 -m py_compile chatbot/shopeechat/turn_decision.py chatbot/shopeechat/app.py
```

Expected: new tests pass; sticker/no-media and claim-collecting locks remain unchanged.

- [ ] **Step 8: Update SRS and report delta**

Record `has_visual_media` input, app call site, no DB side effect, and error behavior. Mechanism delta for this task must be: params +1; helpers/guards/regex/keyword/heuristics/owners +0.

### Task 3: Separate Intent Provider Failure from Semantic `other`

**Files:**
- Modify: `chatbot/shopeechat/app.py:1497-1545`
- Modify: `docs/test/offline/test_task5_final_answer.py`
- Modify: `docs/SRS_SSD.md` `_chat_impl` entry

**Interfaces:**
- Consumes: exception from existing `intent_classifier.classify_intent`.
- Produces: empty/low-confidence semantic proposal plus existing deterministic detectors; trace output marks provider unavailable. No new intent enum or TurnPlan field.

- [ ] **Step 1: Write three customer-boundary RED tests**

Patch `classify_intent` to raise `RuntimeError("intent-provider-down")` and verify:

```python
def test_intent_provider_failure_shipping_does_not_become_product_no_info():
    resp, _ = _chat([], msg="ส่งวันนี้ไหม", patch=_raise_intent)
    assert resp.source == "general:shipping_policy"
    assert "ไม่พบข้อมูลสินค้า" not in (resp.answer or "")


def test_intent_provider_failure_explicit_human_request_handoffs():
    resp, _ = _chat([], msg="ขอคุยกับแอดมิน", patch=_raise_intent)
    assert resp.handoff_to_admin is True
    assert (resp.routing_decision or {}).get("path") == "handoff"


def test_intent_provider_failure_thanks_does_not_search_products():
    resp, _ = _chat([], msg="ขอบคุณค่ะ", patch=_raise_intent)
    assert not resp.products
    assert "ไม่พบข้อมูลสินค้า" not in (resp.answer or "")
```

Implement `_raise_intent(mp)` inside the same test file; it is a test seam, not production helper.

- [ ] **Step 2: Run RED**

Expected before implementation: at least shipping/thanks exposes the current `_DEFAULT_RESULT.intent="other"` degradation.

- [ ] **Step 3: Implement in the existing exception branch**

Replace semantic default `other` with an empty proposal; the existing Intent step already records `intent=None`, `confidence=None` and elapsed time. Provider-attempt errors remain in the existing LLM usage path/server log.

```python
except Exception as exc:
    _intent_result = {}
```

Do not add retries, keywords, regex, a fallback classifier, or a new function. Existing typed/deterministic owners must decide shipping/human/greeting behavior.

- [ ] **Step 4: Run targeted GREEN**

```bash
.venv/bin/python -m pytest docs/test/offline/test_task5_final_answer.py -k "intent_provider_failure" -q
```

- [ ] **Step 5: Run the Task 3 regression gate once**

```bash
.venv/bin/python -m pytest docs/test/offline/test_turn_decision.py docs/test/offline/test_retrieval_profile.py -q
```

- [ ] **Step 6: Update SRS and report delta**

Mechanism delta: helpers/guards/regex/keyword/heuristics/fields/owners +0. If any downstream code requires intent to be a string, fix that consumer only if it violates its existing optional contract; otherwise STOP and report the missing contract.

### Task 4: Carry Same-Product Description and Specs to the Owning Need

**Files:**
- Modify after localization only: one owner among `chatbot/shopeechat/retrieval_selection.py`, `candidate_pool.py`, `answer_context.py`, or `policy_resolver.py`
- Modify: `docs/test/offline/test_task5_final_answer.py`
- Modify: `docs/SRS_SSD.md` only for the function actually changed

**Interfaces:**
- Consumes: existing candidate identity/shop, `description_excerpt`, canonical spec fields, FieldEvidence and TurnNeed requested facts.
- Produces: evidence attributed to the same product/need; direct product-spec answers may use same-identity description evidence, while compatibility decisions continue to require the existing typed proof contract.

- [ ] **Step 1: Write same-identity evidence RED tests**

Add a direct-spec case where the selected CTC620P card has no unrelated candidates and its same-shop `description_excerpt` states `รองรับสูงสุด 240W`:

```python
def test_exact_product_description_spec_is_not_reported_missing():
    card = _item_doc("i-ct", "CTC620P", ("CTC620P",), "cable")
    card["description"] = "สาย CTC620P รองรับกำลังไฟสูงสุด 240W"
    resp, ctx = _chat(
        [], msg="CTC620P รองรับกี่วัตต์",
        llm_reply="CTC620P รองรับกำลังไฟสูงสุด 240W ค่ะ",
        catalog=[card],
        units=[_unit("u-ct", "i-ct", "m-ct", "CTC620P",
                     ("CTC620P",), "cable")],
        intent_result={"intent": "product_spec", "confidence": 0.99,
                       "requested_facts": ["charging_speed"]},
    )
    assert "240W" in (resp.answer or "")
    assert "ไม่มีข้อมูล" not in (resp.answer or "")
    assert any(str(p.get("item_id")) == "i-ct" and
               "240W" in str(p.get("description_excerpt") or "")
               for p in ctx.products)
    assert "240W" in ctx.context_text()
```

Add controls proving a description from another `item_id`, another shop or another model cannot answer the need. Assert the foreign value is absent from final answer and evidence attributed to the need.

- [ ] **Step 2: Run RED and trace the first drop**

Capture the exact identity at source card, pooled candidate, selected request, attributed FieldEvidence and AnswerContext. The first stage that loses a same-identity description/spec is the only permitted owner for this Task.

- [ ] **Step 3: Implement the existing-owner correction**

Use existing `item_id`, `model_id`, `shop`, `need_indices`, requested-fact keys and evidence source. Do not parse prose into a new fact, add a regex/keyword, or let arbitrary description prose prove compatibility. This Task admits already-present same-identity description/spec to a direct product fact need only.

- [ ] **Step 4: Run the named tests GREEN**

Run only the same-identity positive case and the three foreign-identity/scope controls.

- [ ] **Step 5: Run the Task 4 regression gate once**

```bash
.venv/bin/python -m pytest docs/test/offline/test_task5_final_answer.py docs/test/offline/test_phase7_answer_context.py docs/test/offline/test_phase10b_zaapi_primary_evidence.py -q
```

Mechanism target: +0 helpers/guards/regex/keyword tables/heuristics/fields/owners. If direct-spec description admission and compatibility proof cannot remain separate with existing typed state, leave RED and report the missing contract.

### Task 5: Select One Primary Product and Keep Answer/Card Identity Bound

**Files:**
- Modify after localization only: one owner among `chatbot/shopeechat/retrieval_selection.py`, `candidate_pool.py`, `answer_context.py`, or `product_store.py`
- Modify: `docs/test/offline/test_task5_final_answer.py`
- Modify: `docs/SRS_SSD.md` only for the function actually changed

**Interfaces:**
- Consumes: existing TurnNeed subject refs/requested features and selected candidate identities.
- Produces: final answer segments and `ChatResponse.products` that share subject/shop/sellable identity.

- [ ] **Step 1: Write high-confidence RED fixtures**

Create two adversarial cases using existing `_unit` and `_item_doc` fixtures:

```python
def test_requested_camera_feature_never_returns_unrelated_doorbell():
    resp, ctx = _chat(
        [],
        msg="อยากได้อุปกรณ์ดูแลสิวที่มีกล้อง",
        llm_reply="แนะนำ Doorbell Lite ค่ะ",
        catalog=[
            _item_doc("i-door", "Doorbell Lite", ("DBL1",), "doorbell"),
            _item_doc("i-skin", "Skin Camera SC1", ("SC1",), "other"),
        ],
        units=[
            _unit("u-door", "i-door", "m-door", "Doorbell Lite",
                  ("DBL1",), "doorbell"),
            _unit("u-skin", "i-skin", "m-skin", "Skin Camera SC1",
                  ("SC1",), "other"),
        ],
        intent_result={"intent": "product_recommend", "confidence": 0.95,
                       "required_features": ["มีกล้อง"]},
    )
    assert all("doorbell" not in (p.get("name") or "").lower()
               for p in resp.products)
    assert "doorbell" not in (resp.answer or "").lower()


def test_single_product_question_keeps_answer_and_card_on_same_identity():
    resp, ctx = _chat(
        [],
        msg="CTC620P รองรับกี่วัตต์",
        llm_reply="สาย CTC620P รองรับสูงสุด 240W ค่ะ",
        catalog=[_item_doc("i-ct", "CTC620P", ("CTC620P",), "cable")],
        units=[_unit("u-ct", "i-ct", "m-ct", "CTC620P",
                     ("CTC620P",), "cable")],
        intent_result={"intent": "product_spec", "confidence": 0.95,
                       "requested_facts": ["charging_speed"]},
    )
    assert len(resp.products) <= 1
    selected_ids = {str(p.get("item_id")) for p in resp.products}
    context_ids = {str(p.get("item_id")) for p in (ctx.products or ())}
    assert selected_ids == context_ids


def test_general_recommendation_returns_one_primary_product_and_card():
    resp, ctx = _chat(
        [], msg="แนะนำสาย USB-C สำหรับ Xiaomi 17 Ultra",
        llm_reply="แนะนำ CTC620P ค่ะ",
        catalog=[
            _item_doc("i-620", "CTC620P", ("CTC620P",), "cable"),
            _item_doc("i-615", "CTC615P", ("CTC615P",), "cable"),
            _item_doc("i-cmc", "CMC615P", ("CMC615P",), "cable"),
        ],
        units=[
            _unit("u-620", "i-620", "m-620", "CTC620P",
                  ("CTC620P",), "cable"),
            _unit("u-615", "i-615", "m-615", "CTC615P",
                  ("CTC615P",), "cable"),
            _unit("u-cmc", "i-cmc", "m-cmc", "CMC615P",
                  ("CMC615P",), "cable"),
        ],
        intent_result={"intent": "product_recommend", "confidence": 0.99},
    )
    assert len(ctx.products) == 1
    assert len(resp.products) == 1
    assert str(ctx.products[0].get("item_id")) == str(resp.products[0].get("item_id"))


def test_explicit_compare_keeps_all_named_subjects():
    resp, ctx = _chat(
        [], msg="เทียบ CTC620P กับ CTC615P",
        llm_reply="CTC620P และ CTC615P ต่างกันดังนี้ค่ะ",
        catalog=[
            _item_doc("i-620", "CTC620P", ("CTC620P",), "cable"),
            _item_doc("i-615", "CTC615P", ("CTC615P",), "cable"),
        ],
        units=[
            _unit("u-620", "i-620", "m-620", "CTC620P",
                  ("CTC620P",), "cable"),
            _unit("u-615", "i-615", "m-615", "CTC615P",
                  ("CTC615P",), "cable"),
        ],
        intent_result={"intent": "product_compare", "confidence": 0.99},
    )
    assert {str(p.get("item_id")) for p in ctx.products} == {"i-620", "i-615"}


def test_recommendation_context_does_not_expose_price_to_answer_model():
    card = _item_doc("i-620", "CTC620P", ("CTC620P",), "cable")
    card["price"] = 1499
    resp, ctx = _chat(
        [], msg="แนะนำสาย USB-C",
        llm_reply="แนะนำ CTC620P ค่ะ",
        catalog=[card],
        units=[_unit("u-620", "i-620", "m-620", "CTC620P",
                     ("CTC620P",), "cable")],
        intent_result={"intent": "product_recommend", "confidence": 0.99},
    )
    assert "1499" not in ctx.context_text()
    assert "บาท" not in (resp.answer or "")
```

`ChatResponse.answer_segments` is text-only, so it cannot prove text-to-card identity. Use the explicit fixture product names for the adversarial prose assertion and `AnswerContext.products` for structured identity. If those disagree, fix composition. Do not add a production parser or name regex to infer identity from free text; if stronger segment provenance is required, STOP and request a typed-contract decision.

- [ ] **Step 2: Run RED and capture owner trace**

Record candidate identities at retrieval result, pool admission, selection, AnswerContext and final products. Identify the first stage where wrong identity enters or wins.

- [ ] **Step 3: STOP if more than one owner is required**

If wrong candidate enters at source query, fix only source query. If correct pool becomes wrong at selection, fix only selector. If selection is correct but answer/card diverges, fix only composition. No local patches in multiple layers.

- [ ] **Step 4: Implement the minimum owner correction**

Use existing typed fields: `item_id`, `model_id`, `unit_id`, `shop`, `need_indices`, `sellable`, `requested_variant_state` and typed need operation. A normal recommendation selects one primary result; compare/options keeps only explicitly requested subjects. Do not parse product names, add feature keywords, or add a final-answer guard. Ensure model-visible recommendation context and `ChatResponse.products` use the same selected set, so unselected product names and prices cannot be introduced from card context.

- [ ] **Step 5: Run targeted GREEN**

Run only the five named tests. Do not run the product regression files until all five are GREEN.

- [ ] **Step 6: Run the Task 5 regression gate once**

```bash
.venv/bin/python -m pytest docs/test/offline/test_task5_final_answer.py docs/test/offline/test_candidate_pool_union.py docs/test/offline/test_candidate_pool_sources_5d.py docs/test/offline/test_issue_5f_availability_anchor.py -q
```

Mechanism target: +0 all categories. If new field/helper is required, leave RED and request approval.

### Task 6: Preserve Product and Relation Context Across Follow-up Turns

**Files:**
- Modify after localization only: one owner among `chatbot/shopeechat/conversation_products.py`, `turn_decision.py`, or `route_context.py`
- Modify: `docs/test/offline/test_phase10b_typed_subject_target.py`
- Modify: `docs/test/offline/test_task5_final_answer.py`
- Modify: `docs/SRS_SSD.md` only for the function actually changed

**Interfaces:**
- Consumes: existing `ConversationSubjectSet`, timeline products with `source="bot_suggestion"`, typed subject refs, relation target and request history.
- Produces: a follow-up TurnNeed whose subject/target identities come from the same conversation and whose retrieval/compatibility evidence is scoped to those identities.

- [ ] **Step 1: Add owner-level context RED**

Import `ConversationSubjectSet` and `resolve_subjects` from `shopeechat.conversation_products` in `test_phase10b_typed_subject_target.py`. Use those existing owners; do not add reference keywords:

```python
def test_latest_single_suggestion_is_the_followup_subject():
    persisted = ConversationSubjectSet(
        subject_ids=("i-cable",), source_turn_id="turn-1",
        relation="single", requested_operations=("recommend",),
        confidence=1.0,
    )
    got = resolve_subjects(persisted, "อันที่แนะนำใช้ด้วยกันได้ไหม")
    assert got.status == "resolved"
    assert got.subject_set.subject_ids == ("i-cable",)


def test_followup_never_reuses_subject_set_from_another_conversation():
    got = resolve_subjects(None, "อันที่แนะนำใช้ด้วยกันได้ไหม")
    assert got.status == "clarify"
    assert got.subject_set is None
```

- [ ] **Step 2: Add two-turn customer-boundary RED**

Extend the test seam with an explicit `conversation_id` only if the existing helper cannot preserve it. Turn 1 recommends exactly CTC620P and records that selected identity. Turn 2 asks `หัว AD1404T ที่ส่งมา ใช้กับสายที่แนะนำได้ไหม` with structured connector facts for both products. Assert:

```python
assert "CTC620P" in resp.answer
assert "AD1404T" in resp.answer
assert "ใช้งานร่วมกันได้" in resp.answer
assert {str(p.get("item_id")) for p in resp.products} <= {"i-cable", "i-head"}
assert "CMC615P" not in resp.answer
```

Add a target-continuity case matching the transcript: Turn 1 asks for a cable for `xiaomi 17 ultra`; Turn 2 asks `หัวชาร์จละ`. The typed retrieval profile must retain `target_device="xiaomi 17 ultra"` while changing requested product subtype from cable to charger. It must not reintroduce all cable suggestions.

- [ ] **Step 3: Run RED and localize one owner per failing function**

Trace persisted subject set, `resolve_subjects`, TurnPlan need, retrieval profile and final compat subject/target. If subject identity and target device fail at different owners, finish the first owner RED/GREEN cycle before beginning the second; do not patch both before either is GREEN.

- [ ] **Step 4: Implement with existing typed state only**

Use existing subject-set relation, `source="bot_suggestion"`, target device and pair/explicit ids. Do not add conversation keywords, history regex, a second memory collection or an LLM memory summary. If the relation requires a new persisted field, leave the customer-boundary RED and STOP for typed-contract approval.

- [ ] **Step 5: Run each changed function’s targeted GREEN**

Run the owner-level tests immediately after its owner edit, then run the two-turn boundary cases after the boundary consumer edit. Do not run regressions between these cycles.

- [ ] **Step 6: Run the Task 6 regression gate once**

```bash
.venv/bin/python -m pytest docs/test/offline/test_phase10b_typed_subject_target.py docs/test/offline/test_phase10b_answer_completeness.py docs/test/offline/test_retrieval_profile.py docs/test/offline/test_task5_final_answer.py -q
```

Mechanism target: +0 helpers/guards/regex/keyword tables/heuristics/fields/owners. Test-only `conversation_id` plumbing is not a production interface.

**Correction (approved 2026-11-14):** The Step 2 positive-verdict assert (`"ใช้งานร่วมกันได้"`) conflicts with the pre-existing `docs/plans/active/deferred-pairing-contract.md` — product↔product pairing is deferred/not production-ready, and a decided pair verdict has no evidence producer in the active typed path (canonical-zaapi declared proofs dormant; file-backed rows pinned non-verdict; product `canonical_specs` stamp `source="canonical_specs"` which fails the H6 device-side structured-source gate, and no owner materializes them as target-bound records). The approved contract is the honest one: the pair resolves to the correct typed identities (`AD1404T` ↔ persisted `CTC620P`) and the answer must be cannot-confirm (`UnansweredNeed(kind="compat", reason="no_evidence")`) — never positive, never negative (unknown ≠ incompatible). Extending H6 or adding a product-spec→target-record producer would reopen a deliberately removed feature and is out of scope; product-pair verdict production remains deferred work. Task 6's proven scope is context preservation (subject/target identity continuity), not verdict production.

### Task 7: Make Compatibility, “No Evidence,” and Handoff Wording Honest

**Files:**
- Modify after localization only: one owner among `chatbot/shopeechat/policy_resolver.py`, `device_compat.py`, `answer_context.py`, `responses.py`, or `warranty_flow.py`
- Test: `docs/test/offline/test_task5_final_answer.py`
- Test: existing warranty/handoff tests under `docs/test/offline/`
- Modify: `docs/SRS_SSD.md` for changed owner

**Interfaces:**
- Consumes: existing CompatDecision outcome/reason codes, `UnansweredNeed.reason`, `handoff_to_admin`, routing decision and persisted handoff outcome.
- Produces: direct compatible/incompatible conclusion when typed evidence is complete; specific missing-fact wording only for the unresolved dimension; success wording only when handoff outcome is accepted/queued.

- [ ] **Step 1: Add RED for compatibility truth and three unresolved outcomes**

```python
def test_complete_device_and_product_specs_do_not_render_generic_unknown():
    unit = _unit("u1", "i-ct", "m-ct", "CTC620P",
                 ("CTC620P",), "cable")
    unit["canonical_specs"] = {
        "connector": "usb-c", "power_capacity_w": 240,
        "max_current_a": 6,
    }
    resp, ctx = _chat(
        [],
        msg="CTC620P ใช้กับ xiaomi 17 ultra ได้ไหม",
        units=[unit],
        intent_result={"intent": "compatibility_check", "confidence": 0.99,
                       "target_device": "xiaomi 17 ultra"},
    )
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" in resp.answer
    assert "ยังยืนยันไม่ได้" not in resp.answer
    assert "ไม่สามารถยืนยัน" not in resp.answer


def test_typed_incompatible_verdict_answers_cannot_use_directly():
    unit = _unit("u1", "i-ct", "m-ct", "CTL301",
                 ("CTL301",), "cable")
    unit["canonical_specs"] = {"connector": "lightning"}
    resp, _ = _chat(
        [],
        msg="CTL301 ใช้กับ xiaomi 17 ultra ได้ไหม",
        catalog=[_item_doc("i-ct", "CTL301", ("CTL301",), "cable")],
        units=[unit],
        intent_result={"intent": "compatibility_check", "confidence": 0.99,
                       "target_device": "xiaomi 17 ultra"},
    )
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ไม่ได้" in resp.answer
    assert "ยังยืนยันไม่ได้" not in resp.answer


def test_product_found_spec_missing_names_missing_fact_not_missing_product():
    resp, _ = _chat(
        [], msg="CTC620P รับประกันกี่ปี",
        catalog=[_item_doc("i-ct", "CTC620P", ("CTC620P",), "cable")],
        units=[_unit("u-ct", "i-ct", "m-ct", "CTC620P",
                     ("CTC620P",), "cable")],
        intent_result={"intent": "warranty_duration", "confidence": 0.95,
                       "requested_facts": ["warranty"]},
    )
    assert "ไม่พบสินค้า" not in resp.answer
    assert "ยังไม่มีข้อมูล" in resp.answer


def test_handoff_success_wording_requires_handoff_true():
    resp, _ = _chat([], msg="ขอคุยกับแอดมิน",
                    intent_result={"intent": "human_request", "confidence": 1.0})
    if "ส่งให้แอดมินแล้ว" in resp.answer:
        assert resp.handoff_to_admin is True


def test_failed_handoff_never_claims_sent():
    resp, _ = _chat([], msg="ช่วยส่งให้แอดมินตรวจสอบ",
                    intent_result={"intent": "human_request", "confidence": 1.0})
    assert resp.handoff_to_admin is False
    assert "ส่งให้แอดมินแล้ว" not in resp.answer
```

- [ ] **Step 2: Localize the first false semantic state**

Trace the CompatDecision before render. If complete typed product/device evidence still produces `missing_wattage_evidence`, repair only the existing extraction/materialization owner that dropped the fact. If the decision is already `compatible|incompatible` but prose is generic unknown, correct only `_compat_segment`. Separately use the existing `UnansweredNeed.reason` and handoff result. If reasons collapse missing fact/product, STOP and report the missing typed contract because adding a reason enum/field is outside this plan’s mechanism allowance.

- [ ] **Step 3: Implement only if existing typed state is sufficient**

No keyword scan of answer prose, no post-render replacement and no new canned variation pool. Compatibility text must come from existing typed outcome/reason codes; direct description prose alone must not become compatibility proof. Success wording must be selected from the existing action result, not inferred from text.

- [ ] **Step 4: Run targeted GREEN**

Run only the five named outcome tests and confirm final answer, compatibility decision and handoff state. Do not run owner regressions until all five are GREEN.

- [ ] **Step 5: Run the Task 7 regression gate once**

Run the focused task tests plus all files matching existing warranty/handoff owners. Record exact filenames and counts in the closeout; do not report a wildcard as if it were a command.

Mechanism target: +0 all categories. Missing typed state is a STOP outcome, not a reason to invent a new guard.

## Phase 2 — Zaapi KB Evidence Chain

### Task 8: Prove and Repair One Zaapi Exact-Row Chain

**Files:**
- Modify after localization only: one of `chatbot/shopeechat/kb_zaapi_files.py`, `kb_zaapi.py`, `retrieval_runtime.py`, `retrieval_selection.py`, `candidate_pool.py`, or `answer_context.py`
- Modify: `docs/test/offline/test_zaapi_kb_files.py`
- Modify: `docs/test/offline/test_task5_final_answer.py`
- Modify: `docs/SRS_SSD.md` for changed owner

**Interfaces:**
- Consumes: one file-backed row with exact model/fact, shop/platform scope and per-need `request_id="ch:kb:0"`.
- Produces: trace containing retrieved row ID, attributed need, admitted/selected channel and final grounded answer.

- [ ] **Step 1: Extend the existing file-backed e2e canary**

Use `test_zaapi_files_chat_e2e` and `_FILE_XLSX`; do not revive dormant canonical-generation tests.

```python
def test_zaapi_files_exact_row_reaches_selected_context_and_answer():
    mp = MonkeyPatch()
    resp, typed_ctx = _chat_files(
        mp,
        file_rows=_FILE_XLSX,
        msg="สาย CTC620P รองรับกี่วัตต์",
        intent_result={"intent": "product_recommend", "confidence": 0.9,
                       "requested_facts": ["charging_speed"]},
        llm_reply="สาย CTC620P รองรับสูงสุด 240W ยาว 2 เมตรค่ะ",
    )
    evidence = _file_evid(typed_ctx, "test-kb.xlsx")
    assert len(evidence) == 1
    assert evidence[0]["request_id"] == "ch:kb:0"
    assert "240W" in _ev_text(evidence[0])
    assert "240W" in (resp.answer or "")
```

Add a trace assertion using the existing `GroupedRetrievalSelection` step shape. Do not add production trace fields solely for this test; if the current trace cannot distinguish admission/selection, record that observability gap and use owner-level result objects.

- [ ] **Step 2: Add wrong-shop and conflict controls**

Keep `test_zaapi_files_wrong_shop_no_evidence`. Add two same-scope rows with conflicting values and assert the final answer does not silently choose one value. If current typed contract cannot represent conflict, STOP and report missing conflict contract; do not add a conflict guard.

- [ ] **Step 3: Run RED and identify the first zero/drop**

Check in order: `zaapi_search` hits → `zaapi_kb_evidence.supporting_evidence` → `req_needs` attribution → candidate attachments → selection result → `AnswerContext.evidence` → captured typed prompt → final answer.

- [ ] **Step 4: Correct one owner only**

Examples of valid single-owner corrections: query construction in `zaapi_search`, request/need mapping in `retrieval_selection`, or evidence coverage in `answer_context`. No score boosts, keywords or fallback source injection without separate approval.

- [ ] **Step 5: Run GREEN and Zaapi regressions**

```bash
.venv/bin/python -m pytest docs/test/offline/test_zaapi_kb_files.py docs/test/offline/test_phase4_zaapi_attribution.py docs/test/offline/test_task5_final_answer.py -q
```

Mechanism target: +0. The canary must report the exact row ID/channel and customer answer, not only readiness/counts.

## Phase 3 — Workflow and Handoff Integration

### Task 9: Verify Workflow, Handoff, Buffer, and Admin Review on Isolated State

**Files:**
- Modify only if RED localizes a defect: `ChatAdminWeb/src/backend/service/botWorkerService.ts`, `workflowEngine.ts`, `handoffService.ts`, `bufferService.ts`, or review service owner
- Modify: `ChatAdminWeb/scripts/test-botworker-boundary.ts`
- Modify: `ChatAdminWeb/scripts/test-botworker-review.ts`
- Use existing isolated/fake Mongo hooks; real disposable Mongo requires explicit environment approval

**Interfaces:**
- Consumes: bot response `{answer, products, request_id, handoff_to_admin}` and workflow `EngineResult`.
- Produces: stored proposed bubbles, persisted assignment outcome, mock delivery receipts and idempotent retry result.

- [ ] **Step 1: Add one end-to-end isolated scenario**

```ts
await test("buffer → workflow AI → admin review → persisted handoff outcome", async () => {
  seedUserMsg("conv-quality", "m1", "ขอให้แอดมินตรวจสอบรุ่นนี้");
  const result = await svc.pollNewMessages(SCOPE);
  assert(result.some((x) => x.status === "fired"), "worker did not claim input");
  const reply = mocks.fakeColl("shadow_replies").find((x) => x.conversation_id === "conv-quality");
  assert(reply?.review_bubbles?.length > 0, "proposed answer not reviewable");
  const status = mocks.fakeColl("test_status_conversation").find((x) => x.conversation_id === "conv-quality");
  assert(status?.status === "handoff" || status?.status === "open", "handoff not persisted");
});
```

- [ ] **Step 2: Add negative and retry controls**

Prove: failed assignment never emits success wording; same operation key produces one assignment/event; reject creates no mock send; edit-and-approve sends persisted approved text; `|||` produces one mock text event per bubble; product recommendation produces a mock card intent only for a card in `bot_products`.

- [ ] **Step 3: Run RED through production owners**

Mocks may replace network/Mongo leaves only. Do not replace `bufferOrProcess`, `let_ai_respond`, `settleWorkflowResult`, `storeWorkflowDelivered`, handoff CAS or review decision CAS.

- [ ] **Step 4: Correct the first failing owner only**

No live config change, no Shopee API, no real assignment. Preserve operation-key/idempotency contracts and do not change UI in this task.

- [ ] **Step 5: Run GREEN**

```bash
cd ChatAdminWeb
npx tsx scripts/test-botworker-boundary.ts
npx tsx scripts/test-botworker-review.ts
npx tsx scripts/test-phase9-testchat-buffer.ts
npx tsc --noEmit
```

Mechanism target: +0 all categories. If production workflow requires a new outcome field, STOP for contract approval.

## Phase 4 — Full Verification and Closeout

### Task 10: Full Verification, Live Canary, and Closeout

**Files:**
- Modify: `docs/SRS_SSD.md`
- Modify: `docs/plans/active/2026-11-12-full-system-chatbot-live-qa-report.md`
- Modify: `getoutofmywaybotkaikrook2.md`
- Modify: `docs/waythrough-ledger.md`
- Do not track: `docs/test/logs/task6-full-system-qa/*`, `docs/test/results/task6-full-system-qa/*`

**Interfaces:**
- Consumes: GREEN artifacts from Tasks 2–7.
- Produces: exact regression counts, before/after Q/A table, mechanism census, remaining risks and reviewable working tree.

- [ ] **Step 1: Run full offline verification**

```bash
.venv/bin/python -m pytest docs/test/offline -q
cd ChatAdminWeb && npx tsc --noEmit
```

Run each relevant TS script separately and report its own count/exit code. Do not combine historical counts.

- [ ] **Step 2: Run bounded live canaries**

Use isolated server and write-blocking setup from A-211. Run serially first, then concurrency 5 only for quota behavior. Required cases: image-only, shipping, explicit admin, exact product/spec, requested-feature recommendation, Zaapi exact-row and active post-handoff. No customer send, no real handoff, no config write.

- [ ] **Step 3: Compare before/after**

Report for each case: question class, route, evidence/channel, product IDs, answer, handoff result, model calls, successful tokens, errors and service elapsed. Required gates:

```text
image processed then blank no_reply = 0
provider error converted to semantic other = 0
wrong-shop product = 0
wrong-subject product/card mismatch = 0
handoff-success wording without persisted outcome = 0
Zaapi exact-row canary reaches final answer = PASS
price markers in prohibited answer/card payload = 0 after policy owner is proven
```

- [ ] **Step 4: Run hygiene and mechanism census**

```bash
git diff --check -- chatbot/shopeechat docs/test/offline docs/SRS_SSD.md ChatAdminWeb/src/backend ChatAdminWeb/scripts
git diff --cached --stat
```

Count net changes in helpers, guards, regex, keyword tables, heuristics, params/fields and decision owners. Any unapproved positive count blocks completion.

- [ ] **Step 5: Update SRS, report, active log and ledger**

Append exact active-log ranges, add ledger entries using enum categories/statuses, move active integrity prefix to EOF and verify SHA. Do not alter frozen log.

- [ ] **Step 6: Pre-commit review gate**

Summarize changed files, exact tests, live Q/A evidence, mechanism delta and residuals. Stop before stage/commit/push/PR/deploy and request the repository-required commit decision.

## Plan Self-Review

- Spec coverage: answer quality, image/no-reply, provider failure, product identity, missing evidence/handoff wording, Zaapi chain, workflow/buffer/review and final live QA each have an owning task.
- Placeholder scan: no incomplete implementation steps remain; every implementation task has a named RED command and owner gate.
- Type consistency: the only new production interface authorized by this plan is the `has_visual_media: bool = False` keyword-only input on `decide_turn`; no new TurnPlan, AnswerContext or workflow outcome field is assumed.
- Review focus: all five failure classes map to Tasks 2, 3, 4, 6 and 7 with executable boundary tests.
- Scope limit: complete production readiness for every unanswered reason/conflict may hit a typed-contract STOP. A STOP with RED/root cause is an honest plan outcome; it cannot be relabeled GREEN to satisfy the date.
