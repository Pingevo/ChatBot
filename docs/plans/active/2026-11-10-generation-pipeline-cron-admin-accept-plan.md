# Plan: Generation Pipeline — Cron Daily/Weekly + Admin Accept UI + Progress

> สถานะ: รอ approve · เขียน 2026-11-10 · ต่อยอดจาก R1 publish `g20261109` สำเร็จ (manual CAS)

## 1. เป้าหมาย

- **Cron บน server (TZ=Asia/Bangkok):**
  - **Daily 09:00** — image_texts (2 scopes, Gemini เฉพาะรูปใหม่) + units + unit npz + product npz
  - **Weekly จันทร์ 09:00** — เหมือน daily แต่ build description npz **จริง** (ไม่ carry)
- **Build ก่อน live ใช้ของเก่าเสมอ** — pointer ไม่ขยับจน admin กด accept
- **Build เสร็จ → แจ้งเตือนใน admin console** → กดไปหน้า UI ดูรายละเอียด → **Accept = publish (CAS)** / Reject = discard
- **Progress UI** — แสดงสถานะ build สด: % ต่อ step + pixel-art cat เดินตาม pipeline (sprite + CSS, ไม่ใช้ three.js)
- **Retention/rollback** — เก็บ gen ไว้ rollback: **3 daily ล่าสุด** (ปัจจุบัน+เมื่อวาน+เมื่อวานก่อน) และ **2 weekly ล่าสุด** (สัปดาห์นี้+สัปดาห์ก่อน); rollback เลือก gen ใน keep-set ได้ ไม่จำเป็นทีละขั้น

## 2. ดีไซน์ที่ตกลงแล้ว (ล็อก)

| ประเด็น | ตัดสินใจ |
|---|---|
| description ข้าม gen (daily ไม่ build) | **วิธี 1 — carry + re-stamp:** copy desc npz ชุดล่าสุดเข้า gen ใหม่ + เขียน generation_id ใหม่; gate ไม่แก้, log ขั้น carry ระบุ source gid |
| publish จาก UI | **ผ่าน chatbot FastAPI endpoint ใหม่** `/admin/generations/publish` (admin auth) — .venv+exports อยู่ฝั่ง chatbot อยู่แล้ว; admin web ไม่ mount exports เพิ่ม |
| แจ้งเตือน | in-app: badge/notification ใน console → ลิงก์ไปหน้า generations |
| progress visual | pixel-art cat + per-step progress bars (component แยก เปลี่ยน skin ทีหลังได้) |
| run location | server (prod host) — TZ=Asia/Bangkok |

## 3. ส่วนประกอบ

### A. `build_generation.py` (ใหม่ — driver เดียวแทน r1_refresh.sh)

ขั้น (ทุกขั้น log `{step,status,started_at,ended_at,done,total,percent,error}` ลง `<gen_dir>/build_log.jsonl` + อัปเดต `generation_runs`):

1. mint gid → `exports/gen/<gid>/` + `generation_runs` doc `status=building`
2. export `ShpProducts` → `ShpProducts.export.json` (gen snapshot)
3. `build_image_texts.py --scope sellable` แล้ว `--scope nonsellable` (cache reuse; Gemini เฉพาะ new/changed; deferred = ข้ามโดยตั้งใจ)
4. `build_sellable_units.py` → `sellable_units.jsonl`
5. `build_embeddings.py --units` → `unit_embeddings.npz` (parse `N/total` → percent)
6. `build_embeddings.py` (product) → `product_embeddings.npz`
7. **description:**
   - daily → carry: ค้น gen ล่าสุดที่มี `description_embeddings.npz` (เดินจาก pointer→previous→gen dirs เก่าสุดไปใหม่สุด), copy → rewrite `generation_id` เป็น gid ใหม่ (npz resave ~105MB), log `description carried from <src_gid>`
   - weekly → `build_embeddings.py --description` build จริง
8. import `sellable_units_<gid>` + `image_texts_<gid>` (mongoimport/bulk)
9. `validate_generation(require_description=True)` + `finalize_manifest` (status `validated` — **ยังไม่ CAS**)
10. `generation_runs` → `status=pending`, counts, duration → notification ปรากฏใน console
- fail ขั้นใด → `status=failed` + error + step ที่พัง; process ซ้ำกันเองไม่ได้ (lock doc เดียวต่อวัน: `generation_runs {date, build_kind}` unique)

### B. Mongo `generation_runs` (collection ใหม่ — admin DB)

```
{_id, generation_id, build_kind: daily|weekly, status: building|pending|published|failed|discarded,
 current_step, steps: [{name,status,percent,started_at,ended_at,error}],
 counts, duration_s, created_at, updated_at, published_by, published_at,
 description_source_gid  /* เมื่อ carry */}
```

### C. Chatbot FastAPI (ฝั่ง chatbot service)

- `GET /admin/generations/status?gid=` → อ่าน `generation_runs` (poll จาก admin web)
- `POST /admin/generations/publish` `{gid, expected_active}` → รัน publish CAS (reuse `publish_generation` module — ไม่ใช่ subprocess) → อัปเดต `generation_runs.status=published` + `published_by`
- `POST /admin/generations/discard` `{gid}` → mark discarded (ไม่ลบไฟล์ — cleanup เป็นหน้าที่ retention)
- `POST /admin/generations/rollback` `{to_gid}` → CAS กลับไป gen ที่เลือกใน keep-set
- auth: admin token เดียวกับ middleware เดิมของ app (เช็กก่อน implement)
- **ห้าม concurrent publish** — CAS fence มีอยู่แล้ว + lock เพิ่มใน generation_runs (`publishing` flag)

### D. Admin web UI

- `GET /api/generations` (proxy → chatbot) — list + pending
- `POST /api/generations/[gid]/publish|discard|rollback` (proxy)
- หน้า `/admin/generations` (console layout เดิม):
  - **notification entry point:** badge บนเมนู/bell เมื่อมี `status=pending` (poll `/api/generations?status=pending` ~30s)
  - **progress view (กำลัง build):** หลอด progress ต่อ step + % รวม + **pixel-cat sprite เดิน**ไปตามขั้น ผ่าน step ไหนวางกล่อง (CSS sprite, component `BuildProgressCat.tsx`)
  - **pending view:** สรุป gen (counts, diff vs active ±units/new images, build duration, description_source_gid ถ้า carry) + ปุ่ม **Accept(เขียว)/Reject(แดง)** + confirm modal
  - **history:** gen เก่าใน keep-set + ปุ่ม Rollback
- role gate: admin เท่านั้น (ตาม `useAuth`/middleware เดิม)

### E. Retention + cleanup

- แก้ `cleanup_generations` → keep-set = union(**3 daily ล่าสุด**, **2 weekly ล่าสุด**, active, previous) — อ่าน `build_kind` จาก `generation_runs`/manifest (gen เก่าก่อนระบบนี้ = treat เป็น daily ยกเว้น pointer.previous)
- ลบเฉพาะ gen ที่อยู่นอก keep-set และอายุ > grace
- rollback picker = เลือกจาก keep-set (ไม่ใช่ previous เดียว)

### F. Cron install (ขั้นสุดท้าย — แยกอนุมัติ)

- crontab บน server:
  - `0 9 * * *  cd <repo> && .venv/bin/python chatbot/shopeechat/scripts/build_generation.py --mode daily`
  - `0 9 * * 1  cd <repo> && .venv/bin/python ... --mode weekly`  *(weekly ทำแทน daily ในวันจันทร์ — daily skip วันจันทร์ หรือ weekly รันเสริม? → ตัดสิน: **วันจันทร์รัน weekly เท่านั้น** กัน build ชนกัน)*
- หมายเหตุ deploy: prod bot อ่าน exports ผ่าน `exports_data` volume — ต้องมีขั้น sync gen dir เข้า volume (named volume copy-up ทำครั้งแรกเท่านั้น) — แก้ใน deploy step: รัน build ใน container ที่ mount volume เดียวกัน หรือ `docker cp` เข้า volume

## 4. ลำดับทำงาน (commit boundary)

1. `generation_runs` schema + `build_generation.py` skeleton + build_log writer (local, ไม่แตะ cron)
2. ขั้น carry+re-stamp description + tests (fake npz)
3. chatbot endpoints `/admin/generations/*` + tests (fake db/CAS)
4. admin API proxy routes + หน้า `/admin/generations` + notification badge
5. `BuildProgressCat` pixel sprite + progress bars
6. retention cleanup ใหม่ + tests
7. runbook + cron install (อนุมัติแยก) + deploy note (exports_data sync)

## 5. ความเสี่ยง / ข้อจำกัด

- **build บน prod host** — daily ~1-2 ชม. (unit embed 28k บน CPU ~ช้ากว่า MPS) ต้องกำหนด nice/priority ไม่ให้กระทบบอท; weekly description ~10-15 ชม. — พิจารณา maintenance window หรือ nice ต่ำสุด
- deferred OCR สะสม (รอบนี้ 59k deferred) — ไม่ใช่ error แต่ evidence จะไม่ครบรูปใหม่จนกว่างบพอ; ควรโชว์ deferred count ใน UI
- การลบ `exports_data` volume บน prod = หายทุก gen → reseed ใหม่ (ตาม comment compose)
- ข้อมูล npz รวม ~250MB/gen — 3+2 gen ≈ ~1.2GB ดิสก์ (โอเค)
- ไม่แตะ: live delivery path, shadow_replies, .env, security config
