# Conversation Scope Backfill — Migration Readiness Plan

Date: 2026-11-13 · Source: A-260 P1 activation prerequisite + A-242 residual
Status: **READINESS ONLY — ห้าม apply migration ในรอบนี้**
Session constraint: read-only census on admin DB completed on 2026-11-13;
no migration write was performed.

---

## 1. Exact collections / fields

| collection | DB | scope fields | content |
| --- | --- | --- | --- |
| `conversation_products` | admin (`_admin_db()` — `ADMIN_MONGO_*`) | `platform`, `shop` | timeline `products[]`, `active_item_id`, `subject_set`, `claim_state`, order anchors |

Scoped readers (A-242 — exact-or-unscoped per dim, legacy unscoped → fail
closed): `load_timeline`, `save_timeline`/`add_product`, `add_order_anchor`,
`load_claim_state`, `transition_claim_state`, `merge_claim_fields`,
`get_subject_set`, `record_subject_set` — ทั้งหมดใน
`chatbot/shopeechat/conversation_products.py` (`_coll()` → hardcoded
`"conversation_products"`)

Not migrated (verified): `order_store` reads external order DB (read-only,
unrelated); `_LIVE_CARD_CACHE` (conversation_products.py:348) = in-process
cache ไม่ใช่ persisted scope; `status_conversation`/`test_status_conversation`
= admin-owned, scope field `conversation_id`+`shop_id` อยู่แล้ว (admin writer
stamps เสมอ — ไม่ใช่ legacy unscoped surface ของ blocker นี้)

## 2. Deterministic source of truth

`conversations_shp` collection (env override:
`ADMIN_MONGO_COLLECTION_CONVERSATIONS`)

Mapping: `conversation_products.conversation_id` →
`conversations_shp.conversation_id` → `{platform, shop_name}`.
`conversationService.getConversation` queries `conversation_id`, not `_id`.
On the 2,361 matched unscoped docs, `conversation_products.shop` equals
`conversations_shp.shop_name` in every case and equals `shop_id` in none.
The earlier `_id`/`shop_id` mapping was wrong; a migration using it would
misclassify matched docs as orphans or write the wrong scope.

ห้าม derive จาก: ชื่อสินค้า/item name, shop แรกใน DB, regex/keyword, LLM —
ทุกกรณีไม่ใช่ durable relation

## 3. Dry-run command

```bash
.venv/bin/python docs/test/tools/conversation_scope_census.py
```

Read-only — `find` + `count_documents` เท่านั้น; output JSON:
`total_docs`, `scoped_docs`, `unscoped_docs`, `derivation.{derivable,
ambiguous, conflict, orphan}`, hashed conversation ids (sha256[:12])

## 4. Proposed write filter (ห้ามรันในรอบนี้)

```python
# เฉพาะ doc ที่ census จำแนก derivable — per-doc deterministic pair
coll.update_one(
    {"_id": doc._id,
     "$or": [{"platform": {"$in": [None, ""]}},
             {"shop": {"$in": [None, ""]}}]},
    {"$set": {"platform": conv.platform, "shop": conv.shop_name}})
```

- filter ล็อก `_id` + unscoped predicate → doc ที่มี scope อยู่แล้วไม่ถูกแตะ
- ambiguous/conflict/orphan → quarantine list (report only, ไม่เขียน)

## 5. Idempotency

Filter unscoped predicate → run ซ้ำ = no-op บน doc ที่ migrate แล้ว;
`update_one` per doc → partial run resume ได้โดยไม่ทำค่าซ้ำ

## 6. Conflict behavior

- doc partial scope ขัด authority (เช่น doc.platform=shopee แต่
  conv.platform=tiktok) → `conflict` bucket — report hashed id, ไม่เขียนทับ
- >1 conv doc ต่อ id / conv doc ขาด platform หรือ shop_name → `ambiguous`
- ไม่มี conv doc → `orphan` (ตรวจว่า conversation ถูกลบ/เก่ากว่าระบบ —
  report only, ห้าม stamp shop อื่น)

## 7. Rollback / backup

- ก่อน apply: `mongoexport` collection `conversation_products` ทั้งก้อน
  (canonical EJSON + sha256 digest เหมือน A-256 Zaapi protocol)
- backfill เขียนเฉพาะ `platform`/`shop` สอง field — rollback = restore
  export หรือ `$unset` สอง field บน migrated `_id` set ที่บันทึกไว้
- migration writer ต้อง log migrated `_id` list (hashed) ไว้ rollback ได้

## 8. Acceptance counts (gate ก่อน approve apply)

- `unscoped_docs` ลดเหลือเท่า `ambiguous + conflict + orphan` เท่านั้น
- `derivable` docs ทั้งหมด migrate เป็น scope ที่ authority กำหนด
- post-migration re-census: `scoped_docs == total_docs - (ambiguous +
  conflict + orphan)` และ `unscoped_docs == ambiguous + conflict + orphan`
- ห้ามมี doc ใดที่ scope ขัด authority หลัง migrate

## 9. Activation STOP gate

- `conflict > 0` → STOP — ต้อง manual adjudication ทีละ doc (ห้าม auto-pick)
- `ambiguous > 0` → STOP — authority ไม่ deterministic บน id เหล่านั้น
- `orphan > 0` → review เฉพาะ (ไม่ block derivable migration แต่ต้อง
  acknowledge ว่า legacy context ของ orphan หายถาวร)
- `unscoped_docs` ไม่ลดตาม 8 → STOP — partial migration ห้าม activate
- ไม่มี authority mapping เลย → `MIGRATION_BLOCKED_BY_MISSING_SCOPE_AUTHORITY`

## 10. ยังพิสูจน์ไม่ได้ (honest list)

- Read-only census on the admin DB: 3,261 timeline docs; 492 scoped;
  2,769 unscoped. Of the unscoped docs, 2,361 derive a matching
  `conversation_id` + `shop_name`, 408 are orphans, 0 ambiguous, 0 conflicts.
  No write was attempted; these counts may change before an apply run.
- Orphan authority and shop-name rename history remain unverified; the
  408 orphans must not be assigned a shop from a guessed mapping.
- ว่ามี scoped readers เพิ่มเติมนอก 8 owners ใน A-242 — inventory จาก
  grep ครอบ `_coll()` callers ใน conversation_products.py เท่านั้น
- timeline ของ legacy docs (สร้างก่อน scope contract หรือหลัง) —
  ไม่มี timestamp authority ใน doc shape ที่ตรวจ
