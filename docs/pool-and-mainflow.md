# Pool, Switch & ฟังก์ชันหลัก — อธิบายแบบง่ายๆ

อธิบาย "pool" (กลุ่มแหล่งข้อมูล) และสวิตช์เปิด/ปิด/สลับ ที่อยู่ใน `main_config` ของ `system_configs`
— ทั้งหมดอ่านโดย `chatbot/shopeechat/runtime_config.py` (source of truth ฝั่งบอท)

## 1. Pool คืออะไร

"Pool" = **กลุ่มแหล่ง evidence** ที่บอทดึงมาตอบคำถามแต่ละครั้ง แต่ละ source คือ "ก๊อก" ที่จ่ายข้อมูลเข้ามา
สวิตช์ pool คุมแค่ว่า "source นั้นถูก query หรือไม่" — ไม่ได้คุมว่า bot จะตอบหรือไม่

| key ใน `pool_sources` | source คือ | เก็บอะไร |
|---|---|---|
| `kb` | Knowledge Base | FAQ / product spec / zaapi KB rows |
| `mongo_catalog` | Product catalog | สินค้าจริงจาก `dbWallet` (ShpProducts ฯลฯ) |
| `units` | Sellable units | หน่วยขายย่อย (รุ่น/สี/แพ็ก) จาก generation pointer |
| `image_text` | OCR evidence | ข้อความที่อ่านจากรูปสินค้า (ผ่าน generation pointer) |

**Default:** field หายไปหรือไม่ใช่ bool → **ON** (ปิดต้องสั่ง `false` ชัดเจน)
**ผลของ OFF:** source นั้นไม่ถูก query เลย (zero reads) — evidence หายไปจากคำตอบ

## 2. Switch สำคัญ (นอกเหนือ pool_sources)

| config key | ค่า | ผล |
|---|---|---|
| `kb_source` | `"legacy"` \| `"zaapi"` | **KB backend ตัวไหนเสิร์ฟ** — ดู §3 |
| `web_search_enabled` | bool | เปิด/ปิด web search fallback (OpenRouter) |
| `bot_worker_enabled` | bool (per-shop) | บอทตอบแชทจริงของร้านนั้นไหม (อยู่ใน `shops` ไม่ใช่ system_configs) |
| `prompt_modular` | bool | แยก system prompt เป็นส่วนตาม intent (R0) |
| `use_unit_index` | bool | ใช้ sellable units เป็นหลักแทน catalog ดิบ |

## 3. `kb_source` — สวิตช์ KB ตัวเดียวที่สำคัญสุดตอนนี้

```
kb_source = "legacy"  →  knowledge_base.py อ่าน kb_products / kb_qa / knowledge_base (collection เดิม)
kb_source = "zaapi"   →  kb_zaapi_files.zaapi_search อ่าน zaapi_kb rows ตาม registry
```

**กฎเหล็ก (ไม่มีกลไก fallback):**
- `kb_enabled()==false` หรือ `kb_source=="zaapi"` → legacy KB **ห้ามอ่านเด็ดขาด** (zero reads)
- `kb_source=="legacy"` → zaapi collections ไม่ถูกแตะ
- ค่า invalid/missing → fallback `"legacy"` (พฤติกรรมเดิม)

**ผลข้างเคียงที่ต้องรู้:**
- `search_qa` (FAQ path) และ `get_general_faq` เปลี่ยน backend ตาม kb_source ด้วย — zaapi mode อ่านเฉพาะแถว `content_type` ที่ตรง (faq/troubleshooting/warranty) + manual docs
- flip `kb_source` มีผล**ทันทีทุก request** (อ่าน config สด — ไม่ต้อง restart) — rollback = set กลับ `"legacy"`

## 4. "Pool" อีกความหมาย — Candidate Pool (retrieval)

นอกจาก pool_sources ยังมี **candidate pool** ภายใน 1 turn (`candidate_pool.py` + `retrieval_runtime.py`):

```
1 turn → TurnPlan (turn_decision) แตกเป็น needs
  → แต่ละ need ขอ "channel": subject / compat / history / kb / description
  → แต่ละ channel = request 1 ตัว ดึง evidence → เข้า pool
  → pool → select_for_llm_context → เรียง+ตัดให้พอดี context → ส่ง LLM
```

- channel `kb` แตกเป็น `ch:kb:<i>` ต่อ productish need เมื่อ `kb_source=="zaapi"` — แต่ละ need ได้ evidence scope ของตัวเอง ไม่ broadcast ทั้ง turn
- product DB read-only เสมอ (`dbWallet`) — pool นี้คือ "ใครมีสิทธิ์ให้ข้อมูล" ไม่ใช่ "ใครเขียนข้อมูล"

## 5. ฟังก์ชันหลักที่ควรรู้จัก (ชื่อ → หน้าที่)

| ฟังก์ชัน | ไฟล์ | หน้าที่ |
|---|---|---|
| `chat()` | `app.py` | entry point หลัก — รับ request → เลือก engine → ตอบ |
| `pool_sources()` / `source_enabled()` | `runtime_config.py` | อ่าน pool switches (cache ตาม config) |
| `kb_source()` / `legacy_kb_reads_allowed()` | `runtime_config.py` | KB backend selector + legacy read gate |
| `zaapi_search()` | `kb_zaapi_files.py` | ค้น zaapi KB rows (scope + type + rank) |
| `zaapi_kb_evidence()` | `kb_zaapi.py` | adapter → typed evidence ให้ retrieval channels |
| `file_kb_ready()` | `kb_zaapi_files.py` | readiness = มี active file rows ไหม (ใช้ gate ก่อนเปิด zaapi) |
| `run_grouped_selection()` | `retrieval_runtime.py` | channels → pool → LLM context (flag-gated) |
| `fetch_products()` | `product_store.py` | ดึงสินค้า (catalog + units + OCR) |
| `search_qa()` / `get_general_faq()` | `knowledge_base.py` | FAQ/QA path — backend ตาม kb_source |

## 6. สรุป 1 บรรทัด

> Pool switches = "ก๊อกน้ำ" ของ evidence แต่ละ source · `kb_source` = "ก๊อกเลือกน้ำประปาหรือบ่อ" · candidate pool = "ถังรวมที่รอส่งให้ LLM" — ทุกตัวอ่านจาก `system_configs.main_config` สด ไม่มี restart
