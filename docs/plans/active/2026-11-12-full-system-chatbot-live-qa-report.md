# Full-System Chatbot Live QA — Findings and Evidence

วันที่ตรวจ: 2026-11-11 ถึง 2026-11-12 (+07:00)
ประเภทงาน: read-only audit + bounded live QA; ไม่มี production/test-code fix

## สถานะ

เก็บหลักฐานจาก 57 คำขอจริงผ่าน API และรัน offline owner suites ที่เกี่ยวข้องแล้ว แต่ **ยังไม่ใช่การทดสอบทุกเส้นทางของระบบแบบครบทุกเงื่อนไข**: มี 21 จาก 32 ร้านที่มี conversation history ให้เลือก; 11 ร้านไม่มีประวัติที่ map ได้, workflow ปิดอยู่ใน runtime snapshot, debounce/buffer และการ assign ให้แอดมินไม่ได้ทดสอบบน live worker, และ handoff transport ใช้ stub เพื่อไม่ส่งงานจริง

ข้อสรุปที่หลักฐานรองรับ: ปัญหาคุณภาพไม่ได้ชี้ไปที่ Zaapi KB จุดเดียว มีปัญหาที่มองเห็นได้ใน image/no-reply ordering, intent quota fallback, product relevance, KB selection, cost reporting และช่องว่างระหว่าง handoff wording กับการยืนยันงานจริง

## ขอบเขตและวิธีทดสอบ

- ส่ง HTTP `POST /chat` โดยตรงไปยัง isolated local QA server ที่พอร์ต 8012; ไม่ใช้หน้าเว็บ Test Chat หรือ Shadow Inbox ตามคำสั่งให้ทดสอบ API โดยตรง
- ใช้ข้อมูล conversation history และภาพจริงจาก Mongo ใน request ที่เลือก ตามที่ผู้ใช้อนุมัติให้ส่งให้ Gemini; แต่ละ request มี history ที่มีอยู่ครบใน Mongo ไม่ตัดให้เหลือเฉพาะข้อความล่าสุด
- ทดสอบ 57 turns จาก 41 conversations, 21 shops, 5 requests พร้อมกัน; 18 turns มีภาพปัจจุบัน, 74 occurrences ของภาพใน history, 1,211 history-message occurrences รวม
- ทุกร้านหลักที่ระบุมีอยู่ในชุดนี้: BlackShark 3, CukTechThailand 3, KieslectThailand 3, KingGadgets 2
- API ทุกคำขอได้ HTTP 200. ทุก response ใช้ `chat_engine=legacy`; `web_search_used=false`; ไม่พบ OpenRouter calls
- ใช้ Gemini จริง 75 logical calls; มีการ retry ระดับ provider เพิ่มเติม 21 ครั้ง รวม 96 provider-attempt records. ไม่ได้ส่งข้อความให้ลูกค้า
- `AI_USAGE_LOG=0`; capture usage และ prompt เก็บในไฟล์ local ที่กำหนดสิทธิ์ ไม่เขียน usage ลง Mongo
- PyMongo Collection write methods ถูกครอบเพื่อบล็อกการเขียน: บันทึกความพยายาม 20 ครั้งของ `conversation_products.update_one`; ไม่พบ write ที่ผ่านไปยัง collection. Handoff ถูกส่งเข้า local stub 6 ครั้ง ไม่ได้ assign ให้แอดมินจริง
- grouped-selection / Modular Prompt config snapshot ที่อ่านได้ก่อนทดสอบ: `kb_source=zaapi`, grouped selection เปิด, Modular Prompt เปิด, pool sources `kb`, `mongo_catalog`, `units`, `image_text` เปิด, `workflow_enabled=false`. การอ่าน config ซ้ำช่วงท้ายติด DNS; จึงเป็น snapshot ก่อนทดสอบ ไม่ใช่การรับรองสถานะปัจจุบัน
- ไม่ได้หยุดหรือ restart service พอร์ต 8010. Health endpoint เคยตอบสำเร็จระหว่างงาน แต่ final health probe เชื่อมต่อไม่ได้ แม้ `lsof` จะแสดง Python listeners; สถานะพอร์ต 8010 จึงยังไม่ชัดและไม่ได้แตะ service นั้น

## Coverage matrix

| ระบบ/เส้นทาง | หลักฐานที่ได้ | ข้อจำกัด |
|---|---|---|
| `/chat`, intent, final response | 57 live requests; full available history; Gemini จริง | ตัวอย่างมี rate-limit errors ระหว่าง concurrency 5 |
| image/vision | 18 requests มีภาพ; vision calls เกิดจริง | ไม่มีการตรวจภาพทุกชนิด/ทุก format |
| product retrieval / product cards | response และ selected product cards จาก live API | ไม่มี adversarial cross-shop control ในชุดนี้; stock เป็น Mongo snapshot ไม่ใช่ Shopee storefront สด |
| grouped retrieval / Zaapi | 14 requests มี `GroupedRetrievalSelection` trace | ไม่ได้ไล่ทุกจุดใน pipeline เพื่อแยกว่า KB ถูก drop ตอน retrieval, attribution, admission หรือ selection |
| handoff | 6 responses มี `handoff_to_admin=true`; local stub รับ 6 events | ไม่ได้ส่งเข้าระบบ assign/คิวแอดมินจริง |
| worker/workflow/debounce/buffer | offline suites ด้านล่างผ่าน | runtime snapshot ปิด workflow; ไม่มี live worker/Mongo lifecycle test และไม่มี config switch |
| admin UI / Test Chat / Shadow Inbox | ไม่ทดสอบ UI | ตั้งใจใช้ API ตรงตามคำสั่ง |
| ร้านทั้งหมด | 21 ร้านมี turns ใน corpus ที่ map ได้ | 11/32 ร้านไม่มี mapped history จึงไม่มี real conversation ให้ replay; ไม่มีการแต่งข้อมูลแทน |

## ผลเชิงปริมาณ

### Routing และ static/fixed responses

| routing path | จำนวน |
|---|---:|
| `no_reply` | 16 |
| `bot_reply` | 16 |
| `human_wait` | 13 |
| `handoff` | 6 |
| route ว่าง | 6: greeting 3, subject clarification 3 |

คำตอบไม่ว่าง 41/57; 16 `no_reply` ว่างตาม route. Sources: product_store 14, warranty_claim_flow 14, warranty_claim_first_message 4, tax_invoice_handoff 2, general shipping policy 1, subject_clarify 3, greeting 3, no_reply 16.

จุดที่เป็นคำตอบ/การตัดสินแบบ deterministic หรือ static ที่เห็นในการรัน:

| trigger/owner | จำนวนที่พบ | พฤติกรรม |
|---|---:|---|
| active post-handoff state → `human_wait` | 13 | บอทหยุดตอบงานใหม่และแจ้งว่ารอแอดมิน; ไม่ใช่ handoff ใหม่ใน turn นี้ |
| placeholder/noise turn → `no_reply` | 16 | ส่ง answer ว่าง; 14 cases เป็นภาพปัจจุบัน และอีก 2 เป็น bundle/noise |
| greeting | 3 | canned greeting; ไม่เข้าค้นสินค้า |
| subject clarification | 3 | ขอให้ระบุรุ่น/สินค้า; ไม่ได้สร้าง product result |
| empty composition/context fallback | 7 | ข้อความ generic ว่าไม่พบข้อมูล/ติดต่อแอดมิน |
| warranty claim paths | 18 รวม | 14 claim flow + 4 first-message template; เป็น owner flow ไม่ใช่คำตอบ LLM ทั่วไป |
| tax invoice handoff | 2 | เส้นทาง handoff เฉพาะ |
| `LLM_ERROR_REPLY` | 0 | ไม่พบคำตอบ error template นี้ใน 57 response; แต่ intent errors ถูกแปลงเป็น default intent แทน |

การค้นข้อความที่กล่าวถึงแอดมินพบ 24 responses ที่ `handoff_to_admin=false`; 13 รายการเป็นข้อความรอแอดมินจาก handoff เดิม ส่วนที่เหลือมีทั้งคำแนะนำ/การปฏิเสธ จึง **ห้ามใช้การนับวลีอย่างเดียวเป็นจำนวน handoff ล้มเหลว**.

Static path ที่ตรวจใน source: `turn_decision.py` สร้าง `no_reply` สำหรับ placeholder/noise; `app.py` ประมวลผล vision/intent ก่อน dispatch `human_wait`/`no_reply`/`clarify`/`greeting`/`handoff`; `answer_context.py` มี `EMPTY_CONTEXT_REPLY`; `llm.py` มี `LLM_ERROR_REPLY`; `warranty_flow.py` มี post-handoff และ first-message claim responses; `responses.py` มี handoff-failed response.

### Gemini, errors, tokens, cost, latency

| metric | measured |
|---|---:|
| logical `_generate` calls | 75 |
| logical calls สำเร็จ / ล้มเหลว | 53 / 22 |
| call role | intent 44 (22 success, 22 error), vision 23, answer 8 (1 general + 7 typed) |
| intent provider errors | 19 code 429, 3 code 503; เกิดระหว่าง concurrency 5 |
| provider attempts รวม retry | 96 (75 logical calls + 21 retry attempts) |
| successful prompt/output tokens | 251,113 / 6,388; รวม 257,501 |
| response `cost` sum | US$0.035680 |
| `steps[].cost_usd` sum | US$0.073109 |
| recalculated paid-tier estimate | ประมาณ US$0.078782 จาก successful tokens; ไม่ใช่ invoice และไม่รวม billing tier/ส่วนลดที่ตรวจไม่ได้ |
| service elapsed จาก `ChatResponse.elapsed` | median 4.34s, p95 20.17s, max 34.66s |
| batch wall time | ประมาณ 92.1s ที่ concurrency 5 |

อย่าใช้ `elapsed_client_ms` ใน runner เป็น API latency: timer เริ่มก่อนรอ semaphore จึงรวมเวลารอคิว. Intent errors 429/503 ทำให้ intent owner fallback เป็น `other`; ผล QA ที่เกี่ยวกับ intent จึงได้รับผลจากโหลดพร้อมกันและไม่ใช่ตัวแทน steady-state แบบ serial.

Cost มีความคลาดเคลื่อนที่ตรวจยืนยันได้: response-level cost ต่ำกว่า sum ของ steps; rate constants ของ intent/vision ใน code ใช้ output rate $0.50/1M ขณะที่หน้า pricing ปัจจุบันระบุ $1.50/1M สำหรับ Gemini 3.1 Flash-Lite. Estimate คำนวณจาก successful token counts และ rate ที่แสดงใน [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing); actual billing ต้องตรวจ provider console.

### Product, KB และคำตอบ

- มี product cards 11 ใบ ใน 4 responses; ทุกใบมี `price` field และ positive numeric stock. 10 ใบเป็น `sellable=true`, 1 ใบ `sellable=false` ทั้งที่มี positive `total_stock`. ไม่มี card ที่ shop field ขัดกับร้านของ request ในตัวอย่าง 11 ใบนี้ แต่ไม่มี adversarial cross-shop test จึงยังสรุปว่าปิด leak ไม่ได้
- คำตอบข้อความมี price-marker 0 ครั้ง แต่ API ส่ง `price` ในทุก product card; การแสดงผล card ใน UI ไม่ได้ทดสอบ จึงยังรับรองข้อห้ามราคาใน customer UI ไม่ได้
- มี 7 คำตอบยาวเกิน 500 ตัวอักษร; median 97 ตัว, max 1,717 ตัว
- ตัวอย่าง high-confidence ที่ควรทำ RED: `LydstoThailand-64d13e1a30af` ถามหาอะไหล่ sensor แต่ตอบแนะนำ accessories ทั่วไปและแนบ 3 cards; `SuperITMall-81179024732f` ถามอุปกรณ์ดูแลสิวที่ต้องมีกล้อง แต่คำตอบโยงไป doorbell และ `products=[]` — prose กับ structured products ไม่สอดคล้อง
- ตัวอย่างตรวจ intent degradation: `KingGadgets-c3bb3c0c3ede` คำถามเรื่องส่งวันนี้ได้ไหมถูกจัด `other` และตอบ generic no-info; `YoupinOfficialStore-0699a5fdcdc9` เป็นบทสนทนาสั้นแต่ route เป็น `other`/generic response. ให้ตรวจ raw case และ error attribution ใน private case index ก่อนใช้เป็น regression fixture
- `CukTechThailand-04315c9f7b14` มีหลาย product cards และข้อความมี token แปลก “abubu”; เป็น quality candidate แต่ต้อง adjudicate history ก่อนกำหนด expected answer

Zaapi evidence: มี 14 requests ที่ trace grouped retrieval ได้. ใน 14 traces นั้น `ch:kb:0`/`ch:kb:1` ไม่ถูกเลือกเข้า final context; ไม่พบ Zaapi marker ใน captured model input. หลักฐานนี้ยืนยันได้เพียงว่า **sample นี้ไม่มี Zaapi evidence ถึง model**; ยังระบุ choke point ไม่ได้และไม่พิสูจน์ว่า KB ใช้ไม่ได้ทุก query. Mongo snapshot ที่อ่านก่อนหน้านี้พบ `zaapi_kb` 20,768 docs (20,758 xlsx rows + 10 text), `zaapi_kb_records` 0 และ legacy KB 1,040 docs; เป็น snapshot เดิม ไม่ได้ census ซ้ำในรอบ live test และยังไม่ได้ตรวจ duplicate เต็ม corpus.

### Image/no-reply finding

ใน 18 image turns มี `image_desc` ไม่ว่าง 15; 14 turns จบ `no_reply` และ answer ว่าง ทั้ง 14 ถูกส่งเข้า vision ก่อนตัดสิน no-reply. 23 vision logical calls ถูกบันทึกทั้งหมด; ส่วน 2 no-reply ที่ไม่มี current image ยังมี historical-image reads. เฉพาะกลุ่ม 16 no-reply ใช้ successful 64,004 input + 2,446 output tokens; paid-tier estimate ประมาณ US$0.019670. นี่เป็นต้นทุนที่จ่ายให้การอ่านภาพ/บริบทก่อนระบบคืนคำตอบว่าง.

## ตัวอย่างปัญหาและสถานะข้อพิสูจน์

| finding | หลักฐาน | สิ่งที่ยังไม่รู้ |
|---|---|---|
| ภาพถูกอ่านแล้วแต่ตอบว่าง | 14/18 image turns ได้ `image_desc`/vision แล้วจบ `no_reply` | ควรตอบจากภาพหรือรอข้อความเพิ่มเป็น product decision; trigger owner ordering เป็นจุดตรวจ RED แรก |
| intent rate limit ทำให้ intent กลายเป็น `other` | 22 logical intent failures (19×429, 3×503) ระหว่าง concurrency 5; fallback ทำงาน | serial baseline และ quota/key-level root cause ยังไม่ทดสอบเทียบ |
| สินค้าไม่ตรงเจตนา/คำตอบกับ cards ไม่ตรง | Lydsto accessories 3 ใบ; SuperIT doorbell prose แต่ไม่มี cards | ต้องไล่ source admission → identity/variant → selection → composition ต่อ request ก่อนแก้ |
| Zaapi ไม่ถึง prompt | 0 selected `ch:kb` ใน 14 grouped traces | ยังไม่แยก retrieval miss, attribution, admission, ranking หรือ selector |
| admin wording ไม่เท่ากับ handoff สำเร็จ | 6 handoff calls เข้า stub; 13 `human_wait` เป็นสถานะรอ handoff เดิม | การส่งจริง/การรับโดย admin owner ไม่ได้ทำใน QA นี้ |
| การห้ามราคายังไม่พิสูจน์ที่ UI | answer prose ไม่มีราคา แต่ 11 product cards มี price | ต้องทดสอบ renderer/customer payload path และตัดสิน policy ก่อนแก้ |
| cost dashboard/report ไม่ตรงกัน | response cost $0.035680 vs steps $0.073109 vs recalculation $0.078782 | ตรวจ aggregation owner, pricing table/model version และ provider invoice แยก |

## Offline verification ที่รัน

| command/suite | ผล |
|---|---|
| `.venv/bin/python -m pytest docs/test/offline -q` | 2,004 passed, 15 skipped, 1 xfailed; exit 0 |
| `npx tsx scripts/test-phase9-testchat-buffer.ts` | 16/16 |
| workflow canonical | 220/220 |
| workflow foundation | 163/163 |
| workflow persistence | 452/452 |
| workflow binding routes | 47/47 |
| botworker boundary | 22/22 |

TS suites รวม 920 assertions จาก offline/fake owners; ไม่มีชุดใดพิสูจน์ live worker, external assignment, Mongo write path, หรือ runtime debounce ใน session นี้.

## Artifacts และข้อมูลส่วนบุคคล

ไฟล์ raw อยู่ใน `.gitignore` และถูกตั้ง permission 0600; directory 0700. ห้าม add/commit หรือคัดลอก raw data ลงเอกสาร tracked.

- `docs/test/results/task6-full-system-qa/source_cases.jsonl` — selected source turns + full available history + image references
- `docs/test/results/task6-full-system-qa/source_summary.json` — corpus selection/count summary
- `docs/test/logs/task6-full-system-qa/chat_responses.jsonl` — request/response, full available history และ transcript
- `docs/test/logs/task6-full-system-qa/llm_input_and_usage.jsonl` — captured system instruction/model contents, model, usage, duration, errors; image bytes เก็บเป็น length + SHA-256 ไม่ได้เก็บ bytes
- `docs/test/logs/task6-full-system-qa/case_index.csv` — 57 rows; question, final answer, route, source, intent, products, latency, history count, image count, LLM tokens/errors
- `docs/test/logs/task6-full-system-qa/blocked_side_effects.jsonl` — blocked DB-write attempts และ stubbed handoff events
- `docs/test/logs/task6-full-system-qa/isolated_server.log`, `runner_progress.jsonl` — execution diagnostics

## งานต่อ — ลำดับที่แนะนำสำหรับ RED/GREEN

ไม่มี code fix ใน audit นี้. ตาม AGENTS.md ข้อ 9 ต้องนำเสนอ root cause/impact/plan และรออนุมัติก่อนแก้; ห้ามเพิ่ม helper, guard, regex, keyword, heuristic หรือ hardcoded business logic โดยไม่มีอนุมัติเฉพาะ.

### User-approved Phase 1 acceptance extension (2026-11-12)

Transcript `pingevox` เพิ่ม failure classes ที่ต้องอยู่ใน Phase 1:

- same-product description/spec มีข้อมูล แต่ evidence ไม่ถึง owning need แล้ว final answer กลายเป็น no-evidence;
- structured device + product facts ครบแต่ compatibility render generic “ยังยืนยันไม่ได้” แทน yes/no;
- recommendation ปกติคืน 3 products/cards และ prose ยาว ทั้งที่ไม่ได้ขอ compare/options;
- follow-up “หัวชาร์จละ” หรือ “หัวที่ส่งมาใช้กับสายที่แนะนำได้ไหม” ไม่รักษา target device และ previously selected product pair;
- answer/card กล่าวถึงสินค้าหรือร้านอื่น และ price เข้า recommendation prose/context.

Contract ที่อนุมัติ: direct product-spec need ใช้ description/spec ของ identity+shop เดียวกันได้; compatibility ยังคงต้องผ่าน typed proof owner. Recommendation ปกติคืนหนึ่ง primary product/card; หลายรายการเฉพาะ typed compare/options. Follow-up ใช้ existing conversation subject set, bot-suggestion timeline และ typed relation/target state; ห้ามเพิ่ม keyword/regex/LLM memory. Evidence ครบต้องตอบ compatible/incompatible ตรง ๆ; evidence ขาดต้องระบุ dimension ที่ขาดจาก typed state เดิม. Implementation plan แยกเรื่องเหล่านี้เป็น Tasks 4–7 เพื่อไม่รวมหลาย root cause ใน patch เดียว.

1. **Image/no-reply** — สร้าง RED ที่ `app.chat()` จาก image-only/placeholder พร้อม history; ยืนยัน intended user behavior แล้วแก้ที่ typed turn-action owner เดิม ไม่เสีย vision context และไม่คิดค่า vision ก่อนรู้ว่าจะตอบหรือไม่โดยไม่จำเป็น
2. **Intent quota degradation** — เทียบ serial กับ concurrency, ระบุ API key/model quota และการ fallback ใน `llm.py`/intent owner; RED ต้องยืนยันว่าความล้มเหลวชั่วคราวไม่ทำให้คำถาม shipping/thanks/opt-out กลายเป็น product query
3. **Zaapi exact-row trace** — เลือก FAQ/troubleshooting/spec cases ที่มี row ตรงใน Mongo; trace adapter → retrieval → attribution → pool admission → grouped selector → AnswerContext → prompt; test ต้องแยก zero retrieval กับ retrieved-but-dropped
4. **Product identity/relevance** — RED สำหรับ exact item/model, same-shop variants, requested feature, stock and card/prose consistency; ตรวจ source-specific query/filter ก่อนเปลี่ยน selector
5. **Price policy + stock semantics** — ทดสอบ API card และ UI customer renderer; ยืนยันว่าห้ามราคาใน prose อย่างเดียวพอหรือห้ามใน card ด้วย; เทียบ stock owner fields กับ sellable status
6. **Cost observability** — ทดสอบ request-correlated logical calls/provider retries/usage aggregation; ปรับ calculations ที่ owner เดิมหลังอนุมัติและเทียบ provider console
7. **Handoff/workflow/buffer** — ใช้ isolated Mongo และ mock transport; ทดสอบ real owner chain โดยไม่เปลี่ยน live `workflow_enabled`, ไม่ส่งจริง และไม่เขียน Product DB. แยก human handoff success จากคำตอบที่เพียงพูดว่า “ส่งแอดมิน”
8. **Cross-shop isolation + corpus census** — ทำ adversarial same item_id across shops, missing scope, platform mismatch; ทำ duplicate census บน snapshot ก่อนสรุปเรื่องการปะปน

หลังผู้ใช้อนุมัติแต่ละ correction ให้สร้าง RED ที่ boundary จริง, แก้ owner เดิม, รัน regression locks ที่เกี่ยว และเก็บ GREEN พร้อม Q/A ก่อนเริ่มหัวข้อถัดไป. ห้ามรวมหลาย root causes เป็น patch เดียว.

## Integrity

รายงานนี้ไม่รวมข้อมูลลูกค้าดิบ. รายละเอียด Q/A และ LLM input ทั้งหมดเก็บในไฟล์ ignored ข้างต้นเพื่อให้ตรวจรายเคสในเครื่องได้. สถานะ ledger/active log อ้างอิง A-211. Branch ณ ปิดงาน: `feature-set-branch-n-go` @ `f84a3fb`; UI working-tree changes เป็นงานอื่นและคงไว้; ไม่มี stage/commit/push/PR/deploy.
