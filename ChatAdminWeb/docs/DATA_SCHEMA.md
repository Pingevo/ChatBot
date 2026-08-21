# Schema — ส่งให้ sellcenter เขียนลง MongoDB

## ภาพรวม

sellcenter เขียนข้อมูลแชทจาก Shopee (และ TikTok/Lazada ในอนาคต) ลง MongoDB ของเราตรงๆ

**Connection:** `mongodb://<user>:<pass>@<host>:27017/chatbot`

**Collections ที่ sellcenter เขียน:**
- `conversations`
- `messages`

**Collections ที่ห้ามแตะ** (เราเป็นเจ้าของ):
- `admins`, `auth_tokens`, `sessions`
- `admin_logs`, `system_configs`
- `shops`, `customers`, `triggers`
- `shadow_replies`, `quick_replies`, `close_history`

---

## Collection: `conversations`

### Fields ที่ sellcenter ต้องเขียน

| Field | Type | Required | ตัวอย่าง | หมายเหตุ |
|---|---|---|---|---|
| `conversation_id` | string | ✅ | `shp_123456789` | **prefix ด้วย platform**: `shp_` / `tt_` / `lz_` กันชน id ข้าม platform |
| `platform` | string | ✅ | `shopee` | ค่า: `shopee` \| `tiktok` \| `lazada` |
| `shop_id` | string | ✅ | `123456` | shop_id ของ platform นั้น |
| `shop_name` | string | optional | `IMILabThailand` | ชื่อร้าน |
| `customer_id` | string | ✅ | `user_abc123` | user id ของลูกค้าบน platform |
| `to_name` | string | ✅ | `คุณสมชาย` | ชื่อ display ของลูกค้า (ใช้ใน inbox UI) |
| `customer_avatar` | string | optional | `https://...` | URL รูปลูกค้า |
| `last_message_text` | string | ✅ | `สอบถามราคา` | preview ข้อความล่าสุด |
| `last_message_timestamp` | Date | ✅ | `2026-08-19T14:30:00Z` | เวลาข้อความล่าสุด |
| `last_message_id` | string | optional | `shp_msg_67890` | id ข้อความล่าสุด |
| `unread_count` | number | ✅ | `3` | จำนวนข้อความที่ยังไม่อ่าน (จาก platform) |
| `created_at` | Date | ✅ | `2026-08-19T14:00:00Z` | เวลาแชทเริ่มต้น |
| `updated_at` | Date | ✅ | `2026-08-19T14:30:00Z` | เวลาอัปเดตล่าสุด |
| `data_received_at` | Date | ✅ | `2026-08-19T14:30:01Z` | เวลาที่ sellcenter เขียนลง DB |
| `raw_payload` | object | optional | `{...}` | เก็บ payload ดิบไว้ debug |

### Fields ที่ห้าม sellcenter เขียน (admin-only)

| Field | เหตุผล |
|---|---|
| `status` | เราตั้งเอง (`open`/`closed`/`bot`/`handoff`) |
| `assigned_to` | เราตั้งเอง (admin_id) |
| `pinned` | เราตั้งเอง |
| `item_ids` | เราตั้งเอง (locked product context) |
| `topic` | เราตั้งเอง |
| `closed_at` | เราตั้งเอง |
| `closed_by` | เราตั้งเอง |
| `close_count` | เราตั้งเอง |

### ตัวอย่าง document

```json
{
  "conversation_id": "shp_123456789",
  "platform": "shopee",
  "shop_id": "123456",
  "shop_name": "IMILabThailand",
  "customer_id": "user_abc123",
  "to_name": "คุณสมชาย",
  "customer_avatar": "https://...",
  "last_message_text": "สอบถามราคา IMILAB Home Cam C200",
  "last_message_timestamp": "2026-08-19T14:30:00Z",
  "last_message_id": "shp_msg_67890",
  "unread_count": 3,
  "created_at": "2026-08-19T14:00:00Z",
  "updated_at": "2026-08-19T14:30:00Z",
  "data_received_at": "2026-08-19T14:30:01Z",
  "raw_payload": {
    "original_id": 123456789,
    "shopee_shop_id": 123456
  }
}
```

### Indexes (เราสร้างให้)

```
{ conversation_id: 1 }  unique
{ platform: 1, shop_id: 1, last_message_timestamp: -1 }
{ platform: 1, status: 1, unread_count: 1 }
{ shop_id: 1, to_name: 1 }
```

### Upsert pattern

ถ้ามี conversation_id อยู่แล้ว → update last_message_* + unread_count
ถ้ายังไม่มี → insert ใหม่ (status default เป็น `open`)

```js
db.conversations.updateOne(
  { conversation_id: "shp_123456789" },
  {
    $set: {
      platform: "shopee",
      shop_id: "123456",
      last_message_text: "...",
      last_message_timestamp: new Date(),
      unread_count: 3,
      updated_at: new Date(),
      data_received_at: new Date(),
      // ห้าม $set status, assigned_to, pinned, item_ids, topic, closed_*
    },
    $setOnInsert: {
      created_at: new Date(),
      customer_id: "user_abc123",
      to_name: "คุณสมชาย",
    }
  },
  { upsert: true }
);
```

---

## Collection: `messages`

### Fields ที่ sellcenter ต้องเขียน

| Field | Type | Required | ตัวอย่าง | หมายเหตุ |
|---|---|---|---|---|
| `message_id` | string | ✅ | `shp_msg_67890` | **prefix ด้วย platform**: `shp_msg_` / `tt_msg_` / `lz_msg_` |
| `conversation_id` | string | ✅ | `shp_123456789` | ต้องตรงกับ conversations.conversation_id |
| `platform` | string | ✅ | `shopee` | ค่า: `shopee` \| `tiktok` \| `lazada` |
| `shop_id` | string | ✅ | `123456` | shop_id ของ platform นั้น |
| `role` | string | ✅ | `user` | ค่า: `user` (ลูกค้า) \| `admin` (ร้านตอบ) — sellcenter ใช้ค่านี้ |
| `direction` | string | ✅ | `in` | ค่า: `in` (ลูกค้าส่งเข้า) \| `out` (ร้าน/bot ตอบ) |
| `text` | string | ✅ | `สอบถามราคา` | เนื้อข้อความ |
| `products` | array | optional | `[{item_id, name, price}]` | สินค้าที่แนบ (ถ้ามี) |
| `source` | string | optional | `data_mirror` | ค่า default สำหรับ sellcenter: `data_mirror` |
| `created_timestamp` | Date | ✅ | `2026-08-19T14:30:00Z` | เวลาจริงที่ข้อความถูกสร้างใน platform |
| `data_received_at` | Date | ✅ | `2026-08-19T14:30:01Z` | เวลาที่ sellcenter เขียนลง DB |
| `raw_payload` | object | optional | `{...}` | เก็บ payload ดิบไว้ debug |

### Fields ที่ sellcenter ไม่ต้องเขียน (เราเติมเองถ้า bot ตอบ)

| Field | ใครเติม | เหตุผล |
|---|---|---|
| `topic` | เรา | หมวดหมู่ที่ bot ตั้ง |
| `tokens` | เรา | token usage ของ bot |
| `reply_to_message_id` | เรา | idempotency key สำหรับ bot reply |

### ตัวอย่าง document — ลูกค้าส่งเข้า (in)

```json
{
  "message_id": "shp_msg_67890",
  "conversation_id": "shp_123456789",
  "platform": "shopee",
  "shop_id": "123456",
  "role": "user",
  "direction": "in",
  "text": "สอบถามราคา IMILAB Home Cam C200 ครับ",
  "products": [],
  "source": "data_mirror",
  "created_timestamp": "2026-08-19T14:30:00Z",
  "data_received_at": "2026-08-19T14:30:01Z",
  "raw_payload": {
    "original_msg_id": 67890,
    "shopee_conversation_id": 123456789
  }
}
```

### ตัวอย่าง document — Zaapi/ร้าน ตอบกลับ (out)

```json
{
  "message_id": "shp_msg_67891",
  "conversation_id": "shp_123456789",
  "platform": "shopee",
  "shop_id": "123456",
  "role": "admin",
  "direction": "out",
  "text": "สวัสดีครับ ราคา 1,290 บาท ครับ",
  "products": [],
  "source": "data_mirror",
  "created_timestamp": "2026-08-19T14:30:30Z",
  "data_received_at": "2026-08-19T14:30:31Z"
}
```

### Indexes (เราสร้างให้)

```
{ message_id: 1 }  unique
{ conversation_id: 1, created_timestamp: 1 }
{ platform: 1, shop_id: 1, created_timestamp: -1 }
{ reply_to_message_id: 1 }  sparse  // idempotency check
```

### Insert pattern

```js
// ใช้ insertOne — ถ้า message_id ซ้ำจะ error (index unique)
// หรือใช้ upsert เพื่อกัน duplicate
db.messages.updateOne(
  { message_id: "shp_msg_67890" },
  {
    $set: {
      conversation_id: "shp_123456789",
      platform: "shopee",
      shop_id: "123456",
      role: "user",
      direction: "in",
      text: "...",
      source: "data_mirror",
      created_timestamp: new Date("2026-08-19T14:30:00Z"),
      data_received_at: new Date(),
      raw_payload: {...}
    }
  },
  { upsert: true }
);
```

---

## กฎสำคัญ — ห้ามผิด

### 1. conversation_id prefix ตาม platform

| Platform | Prefix | ตัวอย่าง |
|---|---|---|
| Shopee | `shp_` | `shp_123456789` |
| TikTok | `tt_` | `tt_987654321` |
| Lazada | `lz_` | `lz_555555555` |

### 2. message_id prefix ตาม platform

| Platform | Prefix | ตัวอย่าง |
|---|---|---|
| Shopee | `shp_msg_` | `shp_msg_67890` |
| TikTok | `tt_msg_` | `tt_msg_67890` |
| Lazada | `lz_msg_` | `lz_msg_67890` |

### 3. platform field ต้องตรง

- ทุก document ต้องมี `platform` field
- ค่าต้องเป็น `shopee` / `tiktok` / `lazada` (ตัวพิมพ์เล็ก)
- ห้ามใช้ค่าอื่น

### 4. direction field

- `in` = ลูกค้าส่งเข้ามา (role: `user`)
- `out` = ร้าน/bot ตอบกลับ (role: `admin` สำหรับ Zaapi, `bot` สำหรับ bot ของเรา)

### 5. data_received_at ต้องมีทุก document

- เพื่อ debug และ monitor ว่า data writer ทำงานปกติไหม

---

## ตรวจสอบ

หลัง sellcenter เริ่มเขียน สามารถตรวจได้:

```js
// ดูจำนวนแชทล่าสุดแต่ละ platform
db.conversations.aggregate([
  { $group: { _id: "$platform", count: { $sum: 1 } } }
]);

// ดูข้อความล่าสุด 10 ข้อความ
db.messages.find().sort({ created_timestamp: -1 }).limit(10);

// ดู data writer ล่าสุดทำงานปกติไหม
db.messages.find().sort({ data_received_at: -1 }).limit(1);
```
