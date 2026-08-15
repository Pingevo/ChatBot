# MEGAPLAN: Unified Chat Inbox (Zaapi Clone) — Phase 1: Shopee

> เป้าหมาย: ระบบรวมแชทสำหรับใช้เอง (self-hosted) เริ่มจาก Shopee → TikTok Shop → Lazada
> อ้างอิงแนวคิดจาก zaapi.com/th (unified inbox หลายแพลตฟอร์ม + ข้อมูลออเดอร์ในแชท)

---

## 0. Iron Rules (สำหรับ agent ทุกตัวที่ทำงานในโปรเจกต์นี้)

1. **ห้ามใช้ native Node.js binary modules เด็ดขาด** — deploy บน Plesk + Phusion Passenger (Thai shared hosting) ไม่รองรับ native compile
   - ห้าม: `bcrypt`, `better-sqlite3`, `sharp`, `canvas` ฯลฯ
   - ใช้แทน: `bcryptjs`, `node:sqlite` (built-in), pure-JS libs เท่านั้น
2. Stack หลัก: Node.js + Express + EJS (admin UI) + MongoDB (Mongoose)
3. ทุก webhook event / API call ออก-เข้า ต้อง log ลง `request_logs` ก่อนประมวลผล (audit trail แบบเดียวกับที่ทำใน Biokoop)
4. Strict file scope — agent แก้เฉพาะไฟล์ที่เกี่ยวกับ task ที่ได้รับมอบหมาย ห้ามแตะไฟล์นอกขอบเขต
5. ตรวจสอบจำนวนไฟล์ที่ diff ก่อน accept การเปลี่ยนแปลงทุกครั้ง
6. Design ทุก schema/module ให้เป็น **platform-agnostic** ตั้งแต่ Phase 1 เพื่อเสียบ TikTok/Lazada เข้ามาทีหลังโดยไม่ต้อง refactor ใหญ่
7. Environment variables ทั้งหมดเก็บใน `.env`, ห้าม hardcode secret ในโค้ด — รวมถึง `partner_key` และ connection string ของ MongoDB sellcenter ที่ใช้ร่วมกัน (ดูข้อ 2.3) ต้องเก็บใน env เท่านั้น
8. **ระบบนี้ไม่ทำ OAuth ของตัวเอง** — อ่าน `access_token`/`refresh_token` จาก MongoDB ของระบบ sellcenter ที่มีอยู่แล้วโดยตรง (read-only) ห้าม implement OAuth connect/callback flow ในโปรเจกต์นี้ (ดูข้อ 2.3 สำหรับสถาปัตยกรรมเต็ม)

---

## 1. Scope

### Phase 1 (รอบนี้) — Shopee เท่านั้น
- **ไม่ทำ OAuth เอง** — อ่าน token จากระบบ sellcenter เดิม (partner_id `2006107`, MongoDB `dbWallet.Shp2022Token`) ที่รีเฟรชให้อัตโนมัติอยู่แล้ว
- **ไม่ใช้ webhook/push** — ใช้ polling แทน (ดูเหตุผลในข้อ 2.3) เพื่อไม่ต้องแตะ push config ที่ sellcenter ใช้งานอยู่จริง
- แสดงรายการแชท + ประวัติข้อความใน admin UI
- ตอบแชทกลับผ่านระบบ (ไม่ต้องสลับไปแอป Shopee Seller)
- Audit log ครบทุก step

### Phase 2 (ทีหลัง) — TikTok Shop
### Phase 3 (ทีหลัง) — Lazada

> ทั้ง 2 phase หลังใช้ adapter interface เดียวกับ Shopee (ดูข้อ 4)

---

## 2. Shopee Open Platform — ข้อกำหนดทางเทคนิค (verified จากเอกสารทางการ Chat > v2.sellerchat)

> ✅ ส่วนนี้อัปเดตจากเอกสารทางการของ Shopee Open Platform ที่ยืนยันแล้ว (module: Chat, endpoint group: `sellerchat`) — ใช้แทนของเดิมที่เป็นการเดาจาก third-party wrapper

- Auth: `partner_id` + `partner_key`, เซ็น request ด้วย HMAC-SHA256 (`base_string = partner_id + api_path + timestamp [+ access_token + shop_id]` + `partner_key`) — รายละเอียดเต็มดูที่ signing doc ของ Shopee (module 87)
- Common request params ทุก endpoint: `partner_id`, `timestamp`, `access_token`, `shop_id`, `sign`
- `access_token` อายุ 4 ชั่วโมง (ใช้ซ้ำได้หลายครั้งในช่วงนี้), ต้อง refresh ด้วย `refresh_token` (อายุ 30 วัน) ก่อนหมดอายุ
- `timestamp` มีอายุใช้งานแค่ **5 นาที** ต่อ request — ต้อง sync เวลา server ให้แม่นยำ (NTP) ไม่งั้น sign จะ invalid
- Chat module endpoints จริง (namespace `v2.sellerchat.*`, path `/api/v2/sellerchat/...`) — verified field-by-field แล้วทั้งหมด:
  - **`send_message`** (POST) — `to_id` (required), `message_type` (required: `text`/`sticker`/`image`/`item`/`order`/`voucher`/`video`), `content` (object, field ต่างกันตาม type), `conversation_id` (required เฉพาะ business_type≠0), `source_content.order_sn` (**required ถ้าเป็นข้อความแรกของ conversation** — ดูข้อ 2.2), **TW region ไม่รองรับ**, text จำกัด 600 ตัวอักษร
  - **`get_conversation_list`** (GET) — พารามิเตอร์: `direction` ("older"/"latest", required), `type` ("all"/"pinned"/"unread", required), `next_timestamp_nano` (cursor, optional), `page_size` (default 25 max 60), `business_type`. Response ให้ `page_result.next_cursor.{next_message_time_nano, conversation_id}` + `page_result.more` (boolean) สำหรับ pagination — **ไม่ใช่ offset/page number แบบธรรมดา ต้องใช้ cursor**
  - **`get_message`** — ดึงประวัติข้อความในแชท (`conversation_id` required, cursor แบบ `offset`/`next_offset`)
  - **`get_one_conversation`** — ดึงแชทเดียวแบบละเอียด (`conversation_id` required)
  - **`get_unread_conversation_count`** — นับจำนวน **conversation** ที่ยังไม่อ่าน (ไม่ใช่นับ message)
  - **`pin_conversation`** / **`unpin_conversation`** (POST, body `{conversation_id}`)
  - **`read_conversation`** (POST, body `{conversation_id, last_read_message_id}`) / **`unread_conversation`** (POST, body `{conversation_id}`)
  - **`mute_conversation`** / **`unmute_conversation`** (POST, body `{conversation_id}`), **`delete_conversation`**
  - **`delete_message`** — ⚠️ มี**เวลาจำกัดการลบ/เรียกคืนข้อความตามภูมิภาค** ภูมิภาคไทย (TH) = **ลบได้ภายใน 3 นาทีเท่านั้น** (SG/ID/PH/BR = 10 นาที, MY/TW/VN = ปิดฟีเจอร์นี้)
  - **`upload_image`** — ต้องเรียกก่อนส่งข้อความรูปภาพ (2-step flow: upload ได้ `url` → เอาไปใส่ใน `send_message.content.image_url`) รองรับ jpg/jpeg/png/gif ไม่เกิน 10MB
  - **`upload_video`** + **`get_video_upload_result`** (status: reported/successful/failed) — 3-step flow สำหรับส่งวิดีโอ, duration จำกัด 1-180 วินาที
  - **`send_autoreply_message`** — auto-reply แบบ text อย่างเดียว, **TW region ไม่รองรับเช่นกัน**
  - `get_csat_msg_details` — ไม่ใช้ใน Phase 1
- Auth module: `get_access_token`, `refresh_access_token`
- ⚠️ **API Permissions ของทุก endpoint ใน Chat module จำกัดเฉพาะ App type: "Seller In House System" และ "Customer Service" เท่านั้น** — ต้องตรวจสอบ Partner App type ก่อนเริ่ม
- ✅ **หน่วยเวลา timestamp ยืนยันแล้ว (ไม่ต้องเดาอีกต่อไป)**: `send_message`/`send_autoreply_message`/`get_message` ใช้ `created_timestamp` เป็น**วินาที** (ตัวอย่างจริง: `1615260187` = 10 หลัก มาตรฐาน unix seconds) ส่วน `get_conversation_list` ใช้ `last_message_timestamp` เป็น**นาโนวินาที** (19 หลัก) — สองหน่วยต่างกันจริง ต้องแปลงแยกกันตามที่ระบุไว้ก่อนหน้า
- ⚠️ Push config เป็นแบบ 1 URL ต่อ 1 app ตั้งค่าผ่าน `v2.push.set_app_push_config` — verified แล้ว: parameter คือ `callback_url` (URL ที่จะรับ push, required เฉพาะครั้งแรกที่ยังไม่เคยตั้ง), `set_push_config_on`/`set_push_config_off` (array ของรหัสประเภท event ที่จะเปิด/ปิด), `blocked_shop_id_list` (บล็อกไม่ให้ shop ไหนได้รับ push ก็ได้ ไม่เกิน 500 shop) โดย **รหัส `10` = Webchat push** คือตัวที่โปรเจกต์นี้ต้องเปิด
- ⚠️ **จุดต่างจากที่คาดไว้: endpoint นี้เซ็น sign แบบไม่มี `access_token`/`shop_id`** (เพราะ push config เป็นการตั้งค่าระดับ app ไม่ใช่ระดับ shop) — Common Request Parameters ของ endpoint นี้มีแค่ `partner_id`, `timestamp`, `sign` เท่านั้น ต่างจาก endpoint อื่นในเอกสารก่อนหน้าที่ต้องมี `access_token`+`shop_id` ด้วย ถ้า sign แบบเดียวกันหมดทุก endpoint จะ error `Invalid sign` ทันที
- ⚠️ **Verification timeout ที่แน่นอน: ต้องตอบ HTTP 2xx ภายใน 3 วินาที** (ระบุชัดในเอกสาร error message: "Shopee have sent a test push to this call back url, but we didn't get any response in 3 seconds with 2xx code") — webhook handler ต้องตอบกลับเร็วมาก แนะนำให้ acknowledge (บันทึก log + ตอบ 200) ก่อน แล้วค่อยประมวลผลข้อมูลแบบ async ทีหลัง อย่ารอประมวลผลเสร็จก่อนตอบ ไม่งั้นเสี่ยง timeout
- ⚠️ App type ที่อนุญาตให้เรียก `set_app_push_config` กว้างกว่า Chat module มาก (ERP System, Product Management, Order Management ฯลฯ อีกหลายแบบ) — ไม่ได้จำกัดแค่ "Seller In House System"/"Customer Service" เหมือน endpoint แชท แต่การเรียก Chat endpoints จริงยังต้องเป็น app type ที่ถูกต้องอยู่ (ดูข้อจำกัดก่อนหน้า)
- **Verification handshake**: หลังตั้ง `callback_url` ครั้งแรก Shopee จะส่ง verification message มาที่ URL นั้นทันที **ต้องตอบกลับด้วย HTTP 2xx** ไม่งั้นจะตั้งค่าไม่สำเร็จ — webhook endpoint (`POST /webhooks/shopee`) ต้อง handle เคสนี้ตั้งแต่ deploy ครั้งแรก ก่อนจะเริ่มรับ event จริง
- ✅ **กลไก recovery กรณี webhook หลุด (ใหม่ ยังไม่เคยระบุในแผน)**: `v2.push.get_lost_push_message` ดึง event ที่ Shopee พยายามส่งแต่ไม่สำเร็จ (เก็บย้อนหลังได้ 3 วัน) + `v2.push.confirm_consumed_lost_push_message` ยืนยันว่าประมวลผลแล้ว — ควรมี background job รันเป็นระยะ (เช่นทุก 30 นาที) ดึง lost message มา insert เข้า pipeline เดียวกับ webhook ปกติ (ผ่าน idempotency check ในข้อ 12 อยู่แล้ว) เป็น safety net เสริมจากที่วางแผนไว้ ป้องกันข้อความหายกรณี server ล่มชั่วคราวหรือ deploy ระหว่างที่ Shopee พยายามยิง push
- ⚠️ **ยังขาดอยู่**: payload schema จริงของตัว push event เอง (field ที่ Shopee ส่งมาตอน webchat push) เอกสารอ้างถึงหน้า `webchat_push` แยกต่างหากที่ยังไม่ได้เห็น — ต้องดึงหน้านี้เพิ่ม หรือถ้าไม่มี ให้ Task 0 (verification-first) รับผิดชอบตรงนี้แทน: เปิด push config จริงแล้วจับ payload แรกที่เข้ามาเก็บเป็น ground truth ก่อนออกแบบ webhook parser
- Sandbox: `https://openplatform.sandbox.test-stable.shopee.sg/api/v2/sellerchat/...` / Production (Global): `https://partner.shopeemobile.com/api/v2/sellerchat/...`
- Business type ของแชท: `business_type=0` คือ seller-buyer chat (ที่ต้องใช้), `business_type=11` คือ seller-affiliate chat (ไม่เกี่ยวกับ scope โปรเจกต์นี้)

### 2.2 ⚠️ Business Rules ของ `send_message` ที่กระทบ logic การส่งข้อความโดยตรง (สำคัญมาก)

1. **ข้อความแรกของ conversation ใหม่ต้องแนบข้อมูลออเดอร์เสมอ** — error `first_chat_without_order_info`: ถ้า 2 ฝั่งยังไม่เคยมี conversation กันมาก่อน ข้อความแรกที่ส่งผ่าน Open API **ต้องมี** `source_content.order_sn` แนบไปด้วย ไม่งั้น API จะปฏิเสธ ทำให้ flow "แอดมินพิมพ์ตอบอิสระ" ใช้ไม่ได้กับแชทใหม่เอี่ยม ต้องมี fallback ให้แอดมินเลือก order ที่เกี่ยวข้องก่อนส่งข้อความแรก (หรือกันไว้แค่ reply แชทที่มี conversation อยู่แล้วซึ่งเป็น use case หลักของโปรเจกต์นี้อยู่แล้ว)
2. **ส่งได้เฉพาะกับ buyer ที่มีความสัมพันธ์อยู่** — error `user_is_forbidden`: ส่งข้อความหาผู้ซื้อได้ก็ต่อเมื่อ (ก) ผู้ซื้อเริ่มแชทมาก่อนภายใน 7 วัน หรือ (ข) ผู้ซื้อสั่งซื้อภายใน 30 วัน หรือ (ค) มี return/refund ที่ยังไม่จบ — ไม่ใช่ส่งหาใครก็ได้ตามใจ ต้อง handle error นี้ใน UI ให้ชัดเจน (ไม่ใช่ bug ฝั่งเรา)
3. **จำกัดจำนวนข้อความติดต่อกัน** — error `reach_5_message_limit`: ส่งได้สูงสุด **5 ข้อความติดกัน** ก่อนที่ buyer จะตอบกลับ สำคัญมากสำหรับ auto-reply/AI-reply ในอนาคต (ข้อ 11) ต้องมี guard กันไม่ให้ AI ยิงรัวเกิน 5 ครั้ง
4. **ข้อความ text ยาวไม่เกิน 600 ตัวอักษร** (`message_too_long`)
5. **TW region ไม่รองรับการส่งข้อความเลย** (ไม่กระทบ Digg เพราะร้านอยู่ไทย แต่ต้อง handle error นี้ไว้เผื่อ)
6. รูปภาพ/วิดีโอเป็น flow 2-3 ขั้นตอน (upload ก่อน → เอา url/vid ที่ได้มาใส่ใน send_message) **ไม่ใช่ attach file ตรงๆ ใน send_message เดียว**

### 2.3 สถาปัตยกรรม Token — อ่านจากระบบ sellcenter เดิม (ยืนยันจากโค้ดจริง)

> การตัดสินใจ: ระบบแชทนี้ใช้ `partner_id` เดียวกับระบบ Shopee integration เดิม (sellcenter, ไม่เกี่ยวกับ ITS Account) โดยตั้งใจแลก convenience กับความเสี่ยง shared push config — เป็นการตัดสินใจที่ทำร่วมกันแล้ว ไม่ใช่ default โดยไม่รู้ตัว

**การเชื่อมต่อ:**
- ต่อ MongoDB แยกอีก connection หนึ่ง (คนละ URI จาก MongoDB หลักของระบบแชท) ไปที่ `dbWallet.Shp2022Token` — **read-only เท่านั้น** ไม่เขียนทับ ยกเว้นกรณี fallback refresh (ดูด้านล่าง)
- Query token ด้วย `shop_id` หรือ `shopname`
- ก่อนใช้ `access_token` ทุกครั้ง เช็ค `access_token_time_unix + expire_in` ว่ายังไม่หมดอายุ — ถ้าใกล้หมด (เช่น sellcenter หลักไม่ได้รันอยู่ช่วงนั้น) ให้ fallback refresh เองตามสูตรที่ยืนยันแล้ว (`path = /api/v2/auth/access_token/get`, sign ไม่มี access_token/shop_id) แล้ว **upsert กลับเข้า `Shp2022Token`** (คีย์ด้วย `shopname`/`shop_id`) เพื่อไม่ให้ sellcenter หลักใช้ token เก่าซ้ำ
- **OAuth authorize/callback endpoint จริงที่ยืนยันจากโค้ด sellcenter (เผื่อใช้อ้างอิงหรือ Phase หลังต้องทำเอง)**:
  - Authorize redirect: `GET /api/v2/shop/auth_partner` — sign แบบ partner-level (ไม่มี access_token/shop_id), query params: `partner_id`, `timestamp`, `sign`, `redirect`
  - Token exchange มี **2 รูปแบบจริงที่ Shopee ใช้สลับกัน**: (ก) Shopee POST ข้อมูล `access_token`/`refresh_token` มาที่ callback โดยตรง (new format) หรือ (ข) callback ได้แค่ `code` แล้วต้องเรียก `POST /api/v2/auth/token/get` เองเพื่อแลก token (old format) — โค้ดต้อง handle ทั้งสองแบบเผื่อ Shopee เปลี่ยน
  - Refresh: `POST /api/v2/auth/access_token/get` (path ต่างจาก token exchange ครั้งแรก)

**⚠️ Credential ที่ต้องหมุน**: `partner_key` และรหัสผ่าน MongoDB (`system81`) ถูกส่งเป็น plaintext เข้ามาในแชทนี้ — แนะนำพิจารณาหมุน (rotate) credential เหล่านี้ตามรอบปกติของทีม โดยเฉพาะถ้าเคยแชร์ผ่านช่องทางที่ไม่ใช่ secret manager มาก่อน ไม่ใช่เรื่องเร่งด่วนฉุกเฉิน แต่เป็นสุขอนามัยความปลอดภัยที่ดี — ระบบใหม่นี้ต้องอ่านค่าจาก env variable เท่านั้น ห้าม hardcode ซ้ำตามที่เอกสารเดิมแนะนำไว้แล้ว

**⚠️ จุดเสี่ยงที่ต้อง handle เพิ่มจากการ share partner_id**: ถ้า sellcenter หมุนหรือ revoke token (เช่น shop ถูก deauthorize) token ในระบบแชทนี้จะพังตามไปด้วยทันทีโดยไม่มีการแจ้งเตือนล่วงหน้า ต้อง handle auth error แบบ graceful (แสดงสถานะ "token error" ใน UI หน้า `/shops` ไม่ crash ทั้งระบบ)

### 2.4 ⚠️ การตัดสินใจสำคัญ: ไม่ใช้ Push/Webhook — ใช้ Polling แทน

เนื่องจากใช้ `partner_id` ร่วมกับ sellcenter ซึ่งน่าจะมี `callback_url`/push config ของตัวเองอยู่แล้วสำหรับงานอื่น (order, tracking ฯลฯ) การเปิด webchat push (code 10) ผ่าน `set_app_push_config` จะไปเปลี่ยน config ระดับ partner app ที่ sellcenter ใช้งานจริงอยู่ —ตรงกับความเสี่ยง "กระทบระบบจริง" ที่อยากเลี่ยงมาตั้งแต่ต้น

**คำแนะนำ: Phase 1 ไม่แตะ push config เลย ใช้ polling แทน**
- Worker ดึง `get_conversation_list` (`direction: "latest"`, cursor เก็บต่อ shop) ทุก 15-30 วินาที ต่อร้าน
- ข้อดี: ไม่ต้องแก้ `callback_url`/push config ของ sellcenter แม้แต่นิดเดียว ไม่มีความเสี่ยงกระทบระบบจริงเลย ไม่ต้องกังวลเรื่อง webhook payload schema ที่ไม่มีเอกสาร (ข้อ 2 ก่อนหน้า) เพราะไม่ได้ใช้เลย
- ข้อเสีย: ไม่ real-time เป๊ะ (ดีเลย์ตาม interval polling), ใช้ API call มากกว่า webhook แต่ volume ระดับร้านค้าเดี่ยว/ไม่กี่ร้านไม่น่าเป็นปัญหา
- ถ้าอนาคตอยากได้ real-time จริงๆ ค่อยพิจารณาขอให้ sellcenter เพิ่ม forward logic เล็กๆ ใน webhook handler เดิม (ส่ง event code 10 มาที่ endpoint ใหม่ของเราแยกต่างหาก) แต่เป็นการเปลี่ยนแปลงระบบที่รันอยู่จริง ต้องขอความเห็นชอบก่อนเสมอ ไม่ใช่ default

---

## 3. Data Model (MongoDB)

```
shops                       // ⚠️ ไม่เก็บ access_token/refresh_token เอง — อ่านจาก sellcenter's Shp2022Token แบบ real-time ทุกครั้งที่ใช้ (ดูข้อ 2.3)
  _id
  platform: "shopee" | "tiktok" | "lazada"   // เผื่ออนาคต
  shop_id: String          // shop_id จาก Shopee, ใช้ query ไปที่ Shp2022Token
  shopname: String         // ใช้ query แทน shop_id ได้เช่นกัน (ตรงกับ field จริงใน Shp2022Token)
  shop_name: String        // ชื่อร้านแสดงผลใน UI (คนละ field จาก shopname ซึ่งเป็น key อ้างอิง)
  enabled_for_chat: Boolean   // เปิด/ปิดร้านนี้สำหรับระบบแชท (ไม่ใช่ auth status เพราะ auth ควบคุมโดย sellcenter)
  last_polled_at: Date        // เผื่อ debug polling worker (ข้อ 2.4)
  poll_cursor: Mixed          // เก็บ next_timestamp_nano ต่อร้านสำหรับ get_conversation_list cursor
  status: "active" | "token_error" | "disabled"   // token_error = อ่าน token จาก sellcenter ไม่ได้/หมดอายุ ไม่ใช่ error ของระบบแชทเอง

conversations                // field names ตรงกับ response จริงของ get_conversation_list / get_one_conversation
  _id
  platform: String
  shop_id: String
  conversation_id: String    // ⚠️ String เสมอ (int64 precision — ดูข้อ 3.1)
  to_id: String              // user id ของอีกฝั่ง (buyer) — Shopee เรียก "to_id" ไม่ใช่ "buyer_id"
  to_name: String            // ชื่อ buyer — field จริงคือ "to_name" ไม่ใช่ "buyer_name"
  to_avatar: String          // field จริงคือ "to_avatar" ไม่ใช่ "buyer_avatar"
  unread_count: Number
  pinned: Boolean            // Shopee ส่งมาตรงๆ ไม่ต้องคำนวณเอง
  mute: Boolean
  last_read_message_id: String
  latest_message_id: String
  latest_message_type: String
  latest_message_content: Mixed   // เก็บ raw ตามที่ Shopee ส่ง (โครงสร้างต่างกันตาม type เหมือน messages.content)
  latest_message_from_id: String
  last_message_timestamp: Date    // ⚠️ ระวังหน่วย nanosecond ของ endpoint นี้ — ดูข้อ 2 (จุดเสี่ยงเรื่อง timestamp unit)
  status: "open" | "closed"        // field ที่เราเพิ่มเอง (Shopee ไม่มี field นี้ตรงๆ)

messages                     // field names ตรงกับ response จริงของ v2.sellerchat.get_message
  _id
  platform: String
  conversation_id: String   // ⚠️ เก็บเป็น String เสมอ (ดูหมายเหตุ int64 ด้านล่างข้อ 3.1)
  message_id: String        // ⚠️ เก็บเป็น String เสมอ เช่นกัน
  from_id: String           // Shopee user id ของผู้ส่ง (int64 → String)
  from_shop_id: String
  to_id: String
  to_shop_id: String
  message_type: String      // ชื่อ field จริงคือ "message_type" ไม่ใช่ "type" — ค่าที่เป็นไปได้เยอะมาก (text, image, sticker, order, item, offer, voucher, notification, faq_*, bundle_deal, flash_sale, ฯลฯ) ดู FAQ: open.shopee.com/faq/65
  direction: "in" | "out"    // field ที่เราเพิ่มเอง (Shopee ไม่ส่งมาตรงๆ ต้องคำนวณจาก from_shop_id/to_shop_id เทียบกับ shop_id ของเรา)
  content: Mixed            // โครงสร้างต่างกันมากตาม message_type (text.text, url สำหรับ image, order_sn สำหรับ order, sticker_id สำหรับ sticker ฯลฯ) — เก็บทั้งก้อนแบบ Mixed ตามที่ Shopee ส่งมา อย่า flatten
  status: String             // ค่าจาก Shopee: normal / auto_reply / blocked / user_chat / web_chat / censored_whitelist / censored_blacklist / offwork_autoreply
  source: String             // ช่องทางที่ส่ง: old_webchat / new_webchat / ios / android / push / crm / openapi / chatbot ฯลฯ
  created_timestamp: Date    // แปลงจาก Shopee timestamp (unix seconds)
  raw_payload: Mixed        // เก็บ payload ดิบทั้งก้อนไว้ debug — สำคัญมากเพราะ content schema ซับซ้อนและอาจมี field ใหม่ที่ยังไม่ได้ map
  reply_source: "manual" | "ai" | null       // เผื่ออนาคต: ใครเป็นคนตอบ (field ที่เราเพิ่มเอง ไม่ใช่ของ Shopee)
  linked_product_ids: [String]               // เผื่ออนาคต: สินค้าที่เกี่ยวข้องกับข้อความนี้ (ref -> product DB)
  ai_context_used: Mixed                     // เผื่ออนาคต: context/product data ที่ AI ใช้ประกอบการตอบ

request_logs                // audit trail — เก็บทุก step ของ pipeline
  _id
  platform: String
  direction: "webhook_in" | "api_out"
  event_type: String        // เช่น "new_message", "send_message", "refresh_token"
  shop_id: String
  request_payload: Mixed
  response_payload: Mixed
  status_code: Number
  error: String
  created_at: Date
```

### 3.1 ⚠️ จุดเสี่ยงทางเทคนิคที่สำคัญมาก: int64 กับ JSON.parse ของ Node.js

เอกสารทางการระบุว่า `message_id`, `conversation_id`, `from_id`, `user_id` ฯลฯ เป็น type **int64** ในฝั่ง Shopee (ตัวอย่างจริงในเอกสาร: `4224948255757271305`) ตัวเลขระดับนี้ **เกิน `Number.MAX_SAFE_INTEGER` ของ JavaScript (2^53 ≈ 9 ล้านล้าน)** ไปหลายเท่า

ถ้าใช้ `JSON.parse()` ปกติของ Node.js กับ response ที่มี field พวกนี้ **ตัวเลขจะถูกปัดเพี้ยนแบบเงียบๆ (silent precision loss)** — ได้ id ผิดโดยไม่มี error ใดๆ เตือน แล้วจะไปสร้างปัญหาเช่น หา conversation ไม่เจอ, message ซ้ำซ้อนผิดตัว, หรือ merge บทสนทนาผิดคน

**ทางแก้ (ต้องทำตั้งแต่ต้น ไม่ใช่แก้ทีหลัง):**
- ใช้ library ที่รองรับ parse ตัวเลขใหญ่เป็น string ได้ เช่น `json-bigint` (pure JS ไม่มี native binding — ผ่าน iron rule ข้อ 1) แทน `JSON.parse` ปกติตอนอ่าน response จาก Shopee
- เก็บ `message_id`, `conversation_id`, `from_id`, `to_id`, `user_id` ทุกตัวเป็น **String type ใน MongoDB เสมอ** (ตามที่ปรับ schema ไว้ในข้อ 3 แล้ว) ห้ามแปลงเป็น Number/int เด็ดขาด
- ตอนสร้าง request ไปหา Shopee (เช่นส่ง `conversation_id` กลับไป) ก็ต้องส่งเป็น string ที่ตรงตัวเป๊ะ ไม่ผ่านการแปลงเป็น Number คืน

ควรใส่เป็น task แรกๆ ใน Task 0 (ข้อ 9) ให้ agent ทดสอบ parse response ตัวอย่างจริงแล้วเช็คว่า id ที่ได้ตรงกับที่ Shopee ส่งมาเป๊ะ ก่อนต่อยอด logic อื่น

---

## 4. Platform Adapter Interface (สำคัญ — ออกแบบเพื่อรองรับหลายแพลตฟอร์ม)

สร้าง interface กลางที่ทุกแพลตฟอร์มต้อง implement เหมือนกัน:

```js
// platforms/base-adapter.js (interface reference, ไม่ต้อง instantiate ตรงๆ)
class BaseChatAdapter {
  async getAccessToken(shop) {}
  async refreshAccessToken(shop) {}
  async fetchConversations(shop) {}
  async fetchMessages(shop, conversationId) {}
  async sendMessage(shop, conversationId, content) {}
  verifyWebhookSignature(req) {}   // return boolean
  parseWebhookPayload(rawBody) {}  // normalize เป็น internal message format
}
```

- `platforms/shopee-adapter.js` — implement ตาม Shopee Open API v2
- Phase 2/3: `platforms/tiktok-adapter.js`, `platforms/lazada-adapter.js` — implement interface เดียวกัน
- Core business logic (webhook handler, inbox controller) เรียกผ่าน adapter เท่านั้น ไม่ผูกกับ Shopee โดยตรง

---

## 5. Backend Endpoints (Phase 1)

| Method | Path | หน้าที่ | เรียก Shopee endpoint |
|---|---|---|---|
| GET | `/api/conversations` | list conversations (cursor-based, filter all/pinned/unread) | `get_conversation_list` |
| GET | `/api/conversations/:id` | รายละเอียดแชทเดียว (เผื่อ sync เดี่ยว) | `get_one_conversation` |
| GET | `/api/conversations/:id/messages` | ดึงประวัติข้อความ | `get_message` |
| POST | `/api/conversations/:id/reply` | ส่งข้อความออก | `send_message` |
| POST | `/api/conversations/:id/read` | mark อ่านแล้ว (sync กลับไป Shopee ด้วย ไม่ใช่แค่ local) | `read_conversation` |
| POST | `/api/conversations/:id/pin` \| `/unpin` | ปักหมุดแชท | `pin_conversation` / `unpin_conversation` |
| GET | `/api/unread-count` | badge ยอดรวม unread สำหรับ nav bar | `get_unread_conversation_count` |
| GET | `/api/shops` | list ร้านที่เปิดใช้แชท + สถานะ token (อ่านจาก sellcenter) | - |
| (cron/worker) | polling job | รันทุก 15-30 วินาที ต่อร้าน ดึงข้อความใหม่ (ข้อ 2.4) — **แทนที่ webhook ทั้งหมด** | `get_conversation_list` (direction: latest) |

---

## 6. Admin UI (EJS, UTILITY MODE ตาม design system ที่ใช้อยู่)

- หน้า `/inbox` — 2-column layout: conversation list (ซ้าย) + message thread (ขวา) — pattern เดียวกับ inbox ทั่วไป
- Badge unread count ต่อ conversation + badge รวมที่ nav bar (จาก `get_unread_conversation_count`)
- ปุ่มปักหมุดแชท (pin/unpin) — Shopee รองรับ native เลย ไม่ต้องทำ logic เอง
- Filter แชท all / pinned / unread (ตรงกับ `type` param ของ `get_conversation_list`)
- แสดง platform icon (Shopee ก่อน เว้นที่ไว้สำหรับ TikTok/Lazada)
- Auto-refresh รายการ (short polling ทุก 5-10 วิ — เข้ากับ pattern ที่เคยใช้ใน Pixel Tale RPG เพราะ Passenger ฆ่า long-lived connection เช่น WebSocket)
- หน้า `/shops` — จัดการร้านที่เชื่อมต่อ, ปุ่ม reconnect ถ้า token error

---

## 7. Logging & Audit Requirements

- ทุกรอบ polling → insert `request_logs` (direction: `poll_in`) พร้อมผลลัพธ์ **แม้ไม่มีข้อความใหม่** (เพื่อเห็นว่า worker ยังรันอยู่จริง ไม่ใช่แค่ log ตอนเจอข้อความ)
- ทุก API call ออกไป Shopee (send message, fallback refresh token) → insert `request_logs` (direction: `api_out`) พร้อม response/status/error
- เก็บ `raw_payload` เต็มใน `messages` เผื่อ debug ย้อนหลัง
- ไม่ลบ log อัตโนมัติ (เก็บไว้ตรวจสอบปัญหาการส่ง/รับ)

---

## 8. Environment Variables ที่ต้องเตรียม

```
# ระบบแชท (MongoDB หลักของโปรเจกต์นี้)
MONGODB_URI=
PORT=

# อ่าน token จาก sellcenter (read-only)
SELLCENTER_MONGO_URI=mongodb://system81:<password>@digital.in.th:27017/dbWallet
SELLCENTER_TOKEN_COLLECTION=Shp2022Token

# ใช้เฉพาะตอน fallback refresh เอง (กรณี sellcenter หลักไม่ได้รันอยู่)
SHOPEE_PARTNER_ID=2006107
SHOPEE_PARTNER_KEY=
SHOPEE_HOST_URL=https://partner.shopeemobile.com
```

---

## 9. Task Breakdown สำหรับ Agent (ลำดับแนะนำ)

0. **[ทำก่อนเสมอ] Verification-first**: ต่อ `SELLCENTER_MONGO_URI` แบบ read-only จริง ดึง token ตัวอย่างจาก `Shp2022Token` มาดู field จริง (เทียบกับที่ระบุในข้อ 2.3) แล้วยิง `get_conversation_list` และ `get_message` จริงด้วย token นั้น เก็บ raw response ตัวอย่างไว้ที่ `docs/shopee-api-samples/` เป็น ground truth — ทดสอบ parse ด้วย `json-bigint` แล้วเทียบ id ให้ตรงกับที่ Shopee ส่งมาเป๊ะ (ดูข้อ 3.1) และตรวจสอบหน่วยของทุก timestamp field ที่เจอ (`last_message_timestamp`, `created_timestamp` ฯลฯ) แยกทีละ field ห้ามสมมติเอาเอง (ดูข้อ 2) ก่อนเริ่มเขียน model/adapter จริง
1. Scaffold project structure (Express + EJS + Mongoose, ไม่มี native deps)
2. สร้าง MongoDB models ตามข้อ 3 (MongoDB หลักของระบบแชท — คนละ instance จาก sellcenter)
3. Implement token-reader module — connect `SELLCENTER_MONGO_URI` แบบ read-only, ดึง/เช็คอายุ token, fallback refresh ตามข้อ 2.3 เมื่อจำเป็นเท่านั้น
4. Implement `shopee-adapter.js` ตาม interface ข้อ 4 (ใช้ token-reader แทนการทำ OAuth เอง)
5. Implement polling worker (ข้อ 2.4) — ดึงข้อความใหม่ทุก 15-30 วินาทีต่อร้าน แทน webhook ทั้งหมด, log เข้า `request_logs` ทุกครั้งที่ poll เหมือน API call ปกติ
6. Implement inbox API endpoints
7. สร้าง admin UI (EJS) — inbox + shop management (แสดงสถานะ token จาก sellcenter แบบ read-only)
8. ทดสอบ end-to-end กับร้านจริง (sandbox ก่อนถ้ามี, ไม่งั้น production กับร้านทดสอบ)
9. เอกสาร README + ตรวจ diff file count ก่อน commit

---

## 10. Roadmap หลัง Phase 1 สำเร็จ

- Phase 2: เพิ่ม `tiktok-adapter.js` — เสียบเข้า UI เดิมได้ทันทีถ้า adapter interface (ข้อ 4) ถูก implement ถูกต้อง
- Phase 3: เพิ่ม `lazada-adapter.js` เช่นกัน
- อนาคตไกลกว่านั้น: auto-reply ด้วย AI (pattern คล้าย Biokoop ที่ใช้ Gemini Vision), การ tag/assign แชทให้ทีม, sync ข้อมูลออเดอร์เข้าแชท

---

## 11. Future: AI Product DB Integration

> หมายเหตุ: ฐานข้อมูลสินค้าสำหรับใช้กับ AI กำลังพัฒนาแยกอยู่คนละระบบ ยังไม่เสร็จ — เมื่อเสร็จแล้วจะนำมาเชื่อมกับระบบแชทนี้ ยังไม่ต้อง implement ตอนนี้ แต่ต้องออกแบบให้เชื่อมได้ทีหลังโดยไม่รื้อ core

### แนวคิด
เมื่อฐานข้อมูลสินค้าเสร็จ ระบบแชทจะดึงข้อมูลสินค้า (สต็อก/ราคา/spec) มาใช้ประกอบการตอบลูกค้าอัตโนมัติ หรือช่วยแอดมิน suggest คำตอบระหว่างแชท

### สิ่งที่เผื่อไว้แล้วในแผนนี้
- `messages.reply_source` — แยกว่าข้อความนี้แอดมินตอบเอง (`manual`) หรือ AI ตอบ (`ai`)
- `messages.linked_product_ids` — ผูกสินค้าที่เกี่ยวข้องกับข้อความ/บทสนทนา
- `messages.ai_context_used` — เก็บ context/ข้อมูลสินค้าที่ AI หยิบมาใช้ตอบ (เพื่อ audit ย้อนหลังว่าทำไม AI ตอบแบบนั้น)

### สิ่งที่ต้องออกแบบเพิ่มตอนเชื่อมจริง (ยังไม่ทำตอนนี้)
- Layer กลาง `reply-engine.js` — รับ conversation + message เข้ามา, ตัดสินใจว่าจะ manual หรือเรียก AI, ถ้าเรียก AI ให้ query product DB มาแนบเป็น context แล้วส่งให้โมเดลสร้างคำตอบ
- Reply-engine ต้องคุยกับ adapter (ข้อ 4) แบบเดียวกับตอนแอดมินตอบเอง เพื่อให้ webhook/inbox core ไม่ต้องรู้ว่าใครเป็นคนตอบ
- Connection ไปฐานข้อมูลสินค้า: ถ้าเป็นคนละ MongoDB instance ให้ทำเป็น read-only client แยก อย่าผูก schema ตรงกันเพื่อกัน breaking change ตอนฝั่งสินค้าอัปเดตโครงสร้าง
- Log ทุกครั้งที่ AI ตอบลง `request_logs` เหมือน event อื่นๆ (event_type: `"ai_reply"`) เพื่อ audit trail ครบตามข้อ 7

---

## 12. Safety / Non-disruptive Rollout

> **อัปเดตสถาปัตยกรรม**: ระบบแชทนี้ตัดสินใจใช้ `partner_id`/token ร่วมกับระบบ sellcenter เดิม (แลกความสะดวกกับความเสี่ยง shared config) แต่ **เลือกใช้ polling แทน push/webhook โดยเฉพาะ** (ข้อ 2.4) เพื่อไม่ต้องแตะ push config ของ sellcenter เลย — ความเสี่ยงหลักที่เหลือจึงเปลี่ยนจาก "ชน push config" ไปเป็นความเสี่ยงด้าน token/rate-limit sharing แทน

1. **Read-only ต่อ token store เสมอ** — ระบบแชทนี้ **ห้ามเขียนลง `Shp2022Token`** ยกเว้นกรณี fallback refresh ตามข้อ 2.3 เท่านั้น (และต้อง log ทุกครั้งที่ทำ) เพื่อไม่ให้ไปรบกวนการทำงานของ sellcenter หลัก
2. **Staged rollout — read-only ก่อนเสมอ**: Phase 1a ให้ polling worker แค่ดึงข้อมูล → log → แสดงผลใน UI แบบ read-only เท่านั้น (ห้ามเปิด sendMessage) ปล่อยรันคู่ขนานกับ Seller Center app ปกติสัก 1-2 วัน ตรวจว่า log ครบ ไม่มี error ก่อนเปิด Phase 1b (ตอบแชทออกจริง)
3. **Kill switch** — ใส่ env flag `ENABLE_SEND_MESSAGE=false` เป็นค่าเริ่มต้น ปิดการยิง `send_message` ได้ทันทีโดยไม่ต้อง deploy ใหม่
4. **Guard สำหรับ auto-reply/AI ในอนาคต** — Shopee จำกัดส่งได้สูงสุด 5 ข้อความติดกันก่อน buyer ตอบ (`reach_5_message_limit`, ดูข้อ 2.2) ต้อง block การส่งเพิ่มฝั่งเราเองก่อนโดน Shopee ปฏิเสธ
5. **Idempotency ที่ polling worker** — เช็ค `message_id` ซ้ำก่อน insert ทุกครั้ง (poll ซ้อนกันได้ถ้า interval สั้นกว่าเวลาประมวลผล) กัน log/แสดงผลซ้ำ
6. **Rate limit awareness** — polling ยิง `get_conversation_list` ถี่ (ทุก 15-30 วิ) ต่อร้าน ใช้ quota ร่วมกับ sellcenter หลักที่ยิง API อื่นๆ ด้วย `partner_id` เดียวกัน ถ้าเจอ `system_busy` ต้อง exponential backoff ไม่ใช่ retry รัว เพราะจะไปกระทบ quota ของ sellcenter ด้วย
7. **การเชื่อม API ไม่ทำให้ Seller Center app ใช้ตอบแชทไม่ได้** — เป็น conversation เดียวกัน เข้าถึงพร้อมกันได้หลายทาง ระหว่างทดสอบยังใช้แอป Shopee ปกติตอบลูกค้าคู่ขนานไปได้ตลอด
8. **แนะนำทดสอบกับร้าน/sandbox ที่ไม่กระทบยอดขายจริงก่อน** ถ้ามีร้านทดสอบหรือ sandbox environment รองรับ Chat API ให้ลองที่นั่นก่อนต่อร้านจริง
