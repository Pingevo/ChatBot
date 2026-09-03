#!/usr/bin/env python3
"""
replay_compare.py — Replay bot เราเทียบกับ Zaapi/Admin จาก MongoDB

ลอก logic จาก ChatAdminWeb/src/app/api/test-assignment/route.ts action=replay_conversation:
  1. ดึง user messages (role=user, direction=in) จาก messages_shp
  2. parseRawMessage แบบเดียวกับ messageMediaParser.ts (placeholder + raw_payload)
  3. lookup products จาก dbWallet (ShpProducts) ด้วย item_id
  4. check trigger (triggers collection, enabled, keyword match)
     - ถ้า handoff_admin → หยุด replay (เหมือน route.ts)
  5. callBot เหมือน callBot() ใน route.ts (item_id, history, shop)
  6. หา zaapi/admin reply ถัดจาก user msg (เหมือน shadowReplyService.ts pairing)
  7. แสดงเปรียบเทียบ side-by-side + summary

Usage:
    python replay_compare.py --shop IMILabThailand --limit 5
    python replay_compare.py --conv <conversation_id>
    python replay_compare.py --limit 3
"""
import os
import sys
import re
import json
import argparse
import requests
from datetime import datetime
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '.env'))

# ─── Config ──────────────────────────────────────────────
ADMIN_MONGO_URI = os.environ.get('ADMIN_MONGO_URI', '')
ADMIN_MONGO_DB = os.environ.get('ADMIN_MONGO_DB', 'chatbot_admin')
CONV_COLL = os.environ.get('ADMIN_MONGO_COLLECTION_CONVERSATIONS', 'conversations_shp')
MSG_COLL = os.environ.get('ADMIN_MONGO_COLLECTION_MESSAGES', 'messages_shp')
TRIGGER_COLL = os.environ.get('ADMIN_MONGO_COLLECTION_TRIGGERS', 'triggers')

# product DB (dbWallet — ใช้สำหรับ lookup item_id ของ Shopee products)
PROD_MONGO_URI = os.environ.get('MONGO_URI', os.environ.get('MONGODB_URI', ''))
PROD_MONGO_DB = os.environ.get('MONGO_DB', 'dbWallet')
PROD_COLL = os.environ.get('MONGO_COLLECTION', 'ShpProducts')

BOT_URL = 'http://127.0.0.1:8010/chat'
INTERNAL_SECRET = os.environ.get('CHATBOT_INTERNAL_SECRET', '')


# ─── parseRawMessage (ลอกจาก messageMediaParser.ts) ─────
# คืน: {message_type, text, item_id?, order_sn?, ...}
# สำคัญ: ถ้าเป็น [faq_liveagent]/[bundle_message] → ไม่ถือเป็นคำถาม bot ต้องตอบ
SHOPEE_IMG_HOST = 'https://img.sp.mms.shopee.sg/'


def parse_raw_message(raw_payload, fallback_text: str) -> dict:
    """Python port ของ parseRawMessage (เน้นส่วนที่จำเป็นสำหรับ replay)."""
    raw = raw_payload if isinstance(raw_payload, dict) else None
    # ⚡ normalize item_id ให้เป็น canonical int string (ตัด .0 ที่ Shopee แนบมา)
    def _norm_item_id(id_val):
        if id_val is None or id_val == "":
            return ""
        if isinstance(id_val, float):
            return str(int(id_val))
        s = str(id_val).strip()
        if s == "":
            return ""
        # รูปแบบ "47615436122.0" → ตัด .0
        if re.match(r'^\d+\.\d+$', s):
            try:
                return str(int(float(s)))
            except ValueError:
                pass
        return s
    nested = (raw or {}).get('data', {}).get('content') if raw else None
    if not isinstance(nested, dict):
        nested = {}
    msg_type = (
        nested.get('message_type')
        or (raw or {}).get('message_type')
        or (raw or {}).get('msg_type')
        or 'unknown'
    )
    inner = nested.get('content') or (raw or {}).get('content') or {}

    ft = (fallback_text or '').strip()

    # placeholder detection (เหมือน messageMediaParser)
    if re.search(r'\[รูปภาพ\]|\[image\]', ft, re.I):
        if msg_type != 'image':
            return {'message_type': 'image', 'text': fallback_text or '(รูปภาพ)'}
    elif re.search(r'\[วิดิโอ\]|\[วิดีโอ\]|\[video\]', ft, re.I):
        if msg_type != 'video':
            return {'message_type': 'video', 'text': fallback_text or '(วิดีโอ)'}
    elif re.search(r'\[item\]|\[itemid\]|\[สินค้า\]', ft, re.I):
        m = re.search(r'(\d{6,})', ft)
        if msg_type not in ('item', 'variation_card'):
            return {
                'message_type': 'item',
                'text': fallback_text or '(สินค้า)',
                'item_id': m.group(1) if m else None,
            }
    elif re.search(r'\[order\]|\[คำสั่งซื้อ\]', ft, re.I):
        if msg_type != 'order':
            m = re.search(r'(\d{8,})', ft)
            return {'message_type': 'order', 'text': fallback_text or '(คำสั่งซื้อ)',
                    'order_sn': m.group(1) if m else ''}
    elif re.search(r'\[sticker\]|\[สติกเกอร์\]', ft, re.I):
        return {'message_type': 'sticker', 'text': fallback_text or '(สติกเกอร์)'}
    elif re.search(r'\[notification\]|\[แจ้งเตือน\]', ft, re.I):
        return {'message_type': 'notification', 'text': fallback_text or '',
                'notification_text': ''}
    elif re.search(r'\[variation_card\]|\[ตัวเลือกสินค้า\]', ft, re.I):
        if msg_type != 'variation_card':
            m = re.search(r'(\d{6,})', ft)
            return {'message_type': 'variation_card', 'text': fallback_text or '(สินค้าพร้อมตัวเลือก)',
                    'item_id': m.group(1) if m else None}

    if msg_type == 'unknown':
        return {'message_type': 'text', 'text': fallback_text}

    if msg_type == 'text':
        return {'message_type': 'text', 'text': str(inner.get('text') or fallback_text or '')}

    if msg_type == 'item':
        c = inner
        return {'message_type': 'item', 'text': fallback_text or '(สินค้า)',
                'item_id': _norm_item_id(c.get('item_id'))}

    if msg_type == 'variation_card':
        c = inner
        return {'message_type': 'variation_card', 'text': fallback_text or '(สินค้าพร้อมตัวเลือก)',
                'item_id': _norm_item_id(c.get('product_id') or c.get('item_id'))}

    if msg_type == 'order':
        c = inner
        return {'message_type': 'order', 'text': fallback_text or '(คำสั่งซื้อ)',
                'order_sn': str(c.get('order_sn') or '')}

    if msg_type == 'image':
        return {'message_type': 'image', 'text': fallback_text or '(รูปภาพ)'}

    if msg_type == 'video':
        return {'message_type': 'video', 'text': fallback_text or '(วิดีโอ)'}

    if msg_type == 'sticker':
        return {'message_type': 'sticker', 'text': f'(สติกเกอร์ {inner.get("sticker_id","")})'}

    if msg_type == 'notification':
        c = inner
        nt = str(c.get('notification_for_receiver') or c.get('notification_for_sender') or '')
        return {'message_type': 'notification', 'text': fallback_text or '',
                'notification_text': nt}

    if msg_type == 'faq_liveagent':
        c = inner
        faq_text = str(c.get('faq_text') or c.get('text') or c.get('message') or fallback_text or '')
        return {'message_type': 'faq_liveagent', 'text': faq_text or '(โอนไปยังเจ้าหน้าที่)',
                'notification_text': faq_text or 'โอนไปยังเจ้าหน้าที่'}

    if msg_type in ('bundle_message', 'bundle_deal'):
        # extract item_id จาก source_content (เหมือน TS)
        raw_any = raw or {}
        src = raw_any.get('source_content') or (raw_any.get('data') or {}).get('source_content') or {}
        item_id = _norm_item_id(src.get('item_id')) if src.get('item_id') else _norm_item_id(inner.get('item_id'))
        if item_id:
            return {'message_type': 'item', 'text': fallback_text or '(สินค้า)',
                    'item_id': item_id}
        return {'message_type': 'text', 'text': fallback_text or '(bundle)'}

    return {'message_type': msg_type, 'text': fallback_text or f'(ข้อความประเภท {msg_type})'}


# ─── ตัดสินใจว่าจะส่งอะไรให้ bot ───────────────────────────
# เหมือน route.ts: ใช้ userText = msg.text (placeholder ดิบๆ) ส่งให้ bot
# bot เองมี _ITEM_TAG_RE รองรับ [item: xxx]
# แต่ถ้าเป็น system message (faq_liveagent, sticker, notification) → ข้ามเลย
#   เพราะ route.ts ก็ไม่ได้กรอง แต่ production จะไม่เข้า path นี้เพราะ trigger เป็น handoff
#   ใน replay เรากรองเองเพื่อไม่ให้เสีย context
SYSTEM_MSG_TYPES = {'faq_liveagent', 'sticker', 'notification', 'image', 'video'}
# item/variation_card/order/bundle → แปลงเป็น [item: xxx] ส่งให้ bot (เหมือน callBot ที่ส่ง itemId)


# ⚡ placeholder pattern เหมือน messageService.ts _PLACEHOLDER_RE
_PLACEHOLDER_RE = re.compile(r'^\s*\[(item|order|image|video|sticker|notification|variation_card|bundle_message|bundle_deal|bundle|สินค้า|ตัวเลือกสินค้า|คำสั่งซื้อ)\]\s*$', re.IGNORECASE)


def build_bot_message(parsed: dict, raw_doc: dict) -> tuple[str, str | None]:
    """คืน (message_to_bot, item_id) — เหมือน messageService.toBotText + callBot.

    วิธีการเหมือน shadowbot (messageService.toBotText):
    - ถ้าเป็น item/variation_card ที่มี item_id → แปลงเป็น tag [สินค้า: <item_id>]
      ฝังใน message (ไม่ส่ง item_id เป็น field แยก)
      เพราะ Python bot มี _ITEM_TAG_RE ที่ match [สินค้า: digits] และตัดออก
      ถ้าส่งเป็น [item] ธรรมดา → _ITEM_TAG_RE ไม่ match → LLM ได้รับ "[item]" เป็นคำถาม → สับสน
    - ถ้ามี extra text (ไม่ใช่ placeholder) → "[สินค้า: 123] extra text"
    """
    mt = parsed.get('message_type')
    text = parsed.get('text', '') or (raw_doc.get('text') or '')
    item_id = parsed.get('item_id')

    if mt in SYSTEM_MSG_TYPES:
        return '', None  # ข้าม system message

    if mt in ('item', 'variation_card') and item_id:
        # ⚡ เหมือน toBotText — แปลงเป็น [สินค้า: <item_id>] ฝังใน message
        # ไม่ส่ง item_id เป็น field แยก เพราะ Python bot มี _ITEM_TAG_RE รองรับ tag นี้โดยตรง
        is_placeholder = bool(_PLACEHOLDER_RE.match(text or ''))
        extra = '' if is_placeholder else (text or '').strip()
        bot_msg = f'[สินค้า: {item_id}] {extra}'.strip() if extra else f'[สินค้า: {item_id}]'
        return bot_msg, None  # ไม่ส่ง item_id แยก — ฝังใน message แล้ว

    if mt == 'order':
        return text, None

    # text ปกติ
    return text, item_id


# ─── Triggers (ลอกจาก triggerService.matchTrigger) ──────
# ⚡ Lookup product card จาก dbWallet (สำหรับแสดงในหน้าเว็บ)
def lookup_product_card(prod_db, item_id: str | None) -> dict | None:
    """Lookup product จาก dbWallet ด้วย item_id → คืน product card สำหรับ UI."""
    if prod_db is None or not item_id:
        return None
    try:
        coll = prod_db[PROD_COLL]
        # item_id ใน DB อาจเป็น int หรือ float — ลองทั้งสองแบบ
        id_values = []
        try:
            f = float(item_id)
            id_values.append(int(f))
            id_values.append(f)
        except (ValueError, TypeError):
            id_values.append(item_id)
        doc = coll.find_one({'item_id': {'$in': id_values}})
        if not doc:
            return None
        # แปลงเป็น card สำหรับ UI (เหมือน toProductCard ใน TS)
        # ⚡ Shopee schema: image.image_url_list = list ของ url, gen_price = ราคา
        img_field = doc.get('image') or {}
        img_urls = img_field.get('image_url_list') or [] if isinstance(img_field, dict) else []
        first_img = img_urls[0] if img_urls else None
        price = doc.get('gen_price') or doc.get('price') or doc.get('price_max')
        # ⚡ normalize item_id (Shopee เก็บเป็น float 47615436122.0 → 47615436122)
        raw_item_id = doc.get('item_id') or item_id
        if isinstance(raw_item_id, float):
            norm_id = str(int(raw_item_id))
        else:
            s_id = str(raw_item_id).strip()
            norm_id = str(int(float(s_id))) if re.match(r'^\d+\.\d+$', s_id) else s_id
        return {
            'item_id': norm_id,
            'name': doc.get('item_name') or '',
            'price': price,
            'image': first_img,
            'url': doc.get('short_link') or '',
            'shop': doc.get('shopname') or '',
        }
    except Exception as e:
        print(f'WARN: product lookup failed for item_id={item_id}: {e}', file=sys.stderr)
        return None


def match_trigger(msg_coll_db, message: str, shop_id: str | None, platform: str) -> dict | None:
    """เหมือน triggerService.matchTrigger — keyword match (case-insensitive)."""
    coll = msg_coll_db[TRIGGER_COLL]
    q = {'enabled': True, 'is_deleted': {'$ne': True}}
    if platform:
        q['$or'] = [{'platforms': []}, {'platforms': platform}]
    triggers = list(coll.find(q))
    lower = (message or '').lower()
    for t in triggers:
        shop_ids = t.get('shop_ids', [])
        if shop_ids and shop_id and shop_id not in shop_ids:
            continue
        kws = t.get('keywords', []) or []
        for k in kws:
            if k and k.lower() in lower:
                return t
    return None


# ─── callBot (ลอกจาก route.ts callBot) ───────────────────
def call_bot(message: str, history: list, shop_name: str | None,
             shop_id: str | None, item_id: str | None = None,
             conversation_id: str | None = None,
             platform: str | None = None) -> dict:
    body = {'message': message, 'history': history, 'limit': 5}
    if shop_name:
        body['shop'] = shop_name
    elif shop_id:
        body['shop'] = shop_id
    if item_id:
        body['item_id'] = item_id
    # ⚡ ส่ง conversation_id + platform เพื่อให้ bot ใช้ conversation_products timeline
    if conversation_id:
        body['conversation_id'] = conversation_id
    if platform:
        body['platform'] = platform
    headers = {'Content-Type': 'application/json'}
    if INTERNAL_SECRET:
        headers['X-Internal-Secret'] = INTERNAL_SECRET

    # ⚡ capture log lines ระหว่างเรียก bot (จาก /tmp/chatbot.log)
    log_path = os.environ.get('CHATBOT_LOG_PATH', '/tmp/chatbot.log')
    log_before_size = 0
    try:
        log_before_size = os.path.getsize(log_path)
    except Exception:
        pass

    try:
        resp = requests.post(BOT_URL, json=body, headers=headers, timeout=120)
        # อ่าน log ส่วนที่เพิ่มขึ้นระหว่างเรียก
        bot_log = ''
        try:
            log_after_size = os.path.getsize(log_path)
            if log_after_size > log_before_size:
                with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
                    f.seek(log_before_size)
                    bot_log = f.read(log_after_size - log_before_size)
        except Exception:
            pass
        if resp.status_code == 429:
            return {'error': '429 rate limit', 'answer': '', 'bot_log': bot_log}
        if not resp.ok:
            return {'error': f'http {resp.status_code}', 'answer': '', 'bot_log': bot_log}
        data = resp.json()
        data['bot_log'] = bot_log
        return data
    except Exception as e:
        # อ่าน log แม้จะ error
        bot_log = ''
        try:
            log_after_size = os.path.getsize(log_path)
            if log_after_size > log_before_size:
                with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
                    f.seek(log_before_size)
                    bot_log = f.read(log_after_size - log_before_size)
        except Exception:
            pass
        return {'error': str(e), 'answer': '', 'bot_log': bot_log}


# ─── Zaapi/Admin reply pairing (เหมือน shadowReplyService.ts) ──
def find_zaapi_reply(all_msgs: list, user_msg: dict) -> dict | None:
    """หา outbound message ถัดจาก user_msg."""
    user_ts = user_msg.get('created_timestamp')
    for m in all_msgs:
        if m.get('direction') != 'out':
            continue
        if m.get('role') not in ('bot', 'admin'):
            continue
        m_ts = m.get('created_timestamp')
        if m_ts and user_ts and m_ts >= user_ts:
            return m
    return None


# ─── Helpers ─────────────────────────────────────────────
def short(s: str, n: int = 220) -> str:
    if not s:
        return ''
    s = s.replace('\n', ' ⏎ ')
    return s if len(s) <= n else s[:n] + '…'


def fmt_ts(d) -> str:
    if not d:
        return '?'
    if isinstance(d, datetime):
        return d.strftime('%H:%M:%S')
    return str(d)[:8]


def replay_one(admin_db, prod_db, conv_id: str, verbose: bool = True) -> dict:
    msg_coll = admin_db[MSG_COLL]
    conv_coll = admin_db[CONV_COLL]

    conv = conv_coll.find_one({'conversation_id': conv_id})
    shop_name = conv.get('shop_name') if conv else None
    shop_id = conv.get('shop_id') if conv else None
    platform = (conv.get('platform') if conv else None) or 'shopee'

    all_msgs = list(msg_coll.find({'conversation_id': conv_id}).sort('created_timestamp', 1))
    user_msgs = [m for m in all_msgs if m.get('direction') == 'in' and m.get('role') == 'user']
    out_msgs = [m for m in all_msgs if m.get('direction') == 'out' and m.get('role') in ('bot', 'admin')]

    if not user_msgs:
        return {'conv_id': conv_id, 'skipped': 'no user messages'}

    if verbose:
        print(f'\n{"="*78}')
        print(f'CONV: {conv_id}')
        print(f'shop: {shop_name} (id={shop_id}) | user msgs: {len(user_msgs)} | out msgs: {len(out_msgs)}')
        print(f'{"="*78}')

    # zaapi pairing
    zaapi_map = {}
    last_out_idx = -1
    for um in user_msgs:
        um_ts = um.get('created_timestamp')
        for i, om in enumerate(out_msgs):
            if i <= last_out_idx:
                continue
            om_ts = om.get('created_timestamp')
            if om_ts and um_ts and om_ts >= um_ts:
                zaapi_map[um['message_id']] = om
                last_out_idx = i
                break

    history = []
    qa = []
    skipped_system = 0
    handoff_stopped = False

    for i, um in enumerate(user_msgs):
        parsed = parse_raw_message(um.get('raw_payload'), um.get('text') or '')
        bot_msg, item_id = build_bot_message(parsed, um)

        # ข้าม system messages (เหมือนที่ trigger จะ handoff ใน production)
        if not bot_msg:
            skipped_system += 1
            if verbose:
                mt = parsed.get('message_type')
                print(f'\n── Q{i+1} [{fmt_ts(um.get("created_timestamp"))}] [SKIP {mt}] ──')
                print(f'  ข้าม: {short(parsed.get("text",""), 120)}')
            # ยังเก็บใน history? ไม่ — เพราะ bot จริงไม่เคยได้รับ
            continue

        zaapi = zaapi_map.get(um['message_id'])
        zaapi_text = (zaapi.get('text') or '') if zaapi else ''
        zaapi_source = zaapi.get('source') if zaapi else None
        zaapi_role = zaapi.get('role') if zaapi else None

        # check trigger (เหมือน route.ts)
        trigger = match_trigger(admin_db, bot_msg, shop_id, platform)
        trigger_name = trigger.get('name') if trigger else None
        trigger_action = trigger.get('action') if trigger else None

        if trigger and trigger_action == 'handoff_admin':
            qa.append({
                'i': i + 1, 'user_text': bot_msg, 'item_id': item_id,
                'trigger': trigger_name, 'trigger_action': 'handoff_admin',
                'zaapi_text': zaapi_text, 'zaapi_role': zaapi_role, 'zaapi_source': zaapi_source,
                'bot_answer': '', 'bot_source': '', 'bot_ws': False,
                'status': 'handed_off (trigger)',
            })
            handoff_stopped = True
            if verbose:
                print(f'\n── Q{i+1} [{fmt_ts(um.get("created_timestamp"))}] [TRIGGER→handoff] ──')
                print(f'ลูกค้า  : {short(bot_msg, 200)}')
                print(f'TRIGGER : "{trigger_name}" → handoff (หยุด replay)')
                print(f'Zaapi   : [{zaapi_role or "-"}] {short(zaapi_text, 200)}')
            break

        # call bot
        bot = call_bot(bot_msg, history, shop_name, shop_id, item_id,
                       conversation_id=conv_id, platform=platform)
        bot_answer = bot.get('answer', '')
        bot_source = bot.get('source', '')
        bot_ws = bot.get('web_search_used', False)
        bot_handoff = bot.get('handoff_to_admin', False)
        # ⚡ เก็บ debug info สำหรับ LLM judge
        bot_log = bot.get('bot_log', '')
        bot_intent = bot.get('intent', {})
        bot_retrieval_info = bot.get('retrieval_info', {})
        bot_timing = bot.get('timing', {})
        bot_routing = bot.get('routing_decision', {})
        bot_steps = bot.get('steps', [])
        bot_products = bot.get('products', [])
        bot_product_names = [p.get('name', '')[:60] for p in bot_products[:10]]

        # ⚡ lookup product card สำหรับ user message (item/variation_card/bundle)
        _user_products = []
        _parsed_item_id = parsed.get('item_id')
        if _parsed_item_id:
            _card = lookup_product_card(prod_db, _parsed_item_id)
            if _card:
                _user_products.append(_card)

        qa.append({
            'i': i + 1, 'user_text': bot_msg, 'item_id': item_id,
            'trigger': trigger_name, 'trigger_action': trigger_action,
            'zaapi_text': zaapi_text, 'zaapi_role': zaapi_role, 'zaapi_source': zaapi_source,
            'bot_answer': bot_answer, 'bot_source': bot_source, 'bot_ws': bot_ws,
            'bot_handoff': bot_handoff, 'bot_error': bot.get('error'),
            'status': 'bot_handoff' if bot_handoff else ('trigger_matched' if trigger else 'bot_answered'),
            # ⚡ user message rich media info (เพื่อให้หน้าเว็บแสดงว่าลูกค้าส่งอะไรมา)
            'user_message_type': parsed.get('message_type', 'text'),
            'user_parsed': {
                'message_type': parsed.get('message_type', 'text'),
                'text': parsed.get('text', ''),
                'item_id': parsed.get('item_id'),
                'order_sn': parsed.get('order_sn'),
                'notification_text': parsed.get('notification_text'),
            },
            # ⚡ product cards สำหรับแสดงในหน้าเว็บ (lookup จาก dbWallet)
            'user_products': _user_products if _user_products else None,
            # ⚡ debug info สำหรับ LLM judge
            'bot_log': bot_log[-3000:] if bot_log else '',  # จำกัด 3000 ตัวอักษร
            'bot_intent': bot_intent,
            'bot_retrieval_info': bot_retrieval_info,
            'bot_timing': bot_timing,
            'bot_routing': bot_routing,
            'bot_steps': bot_steps,
            'bot_product_names': bot_product_names,
            'bot_products_count': len(bot_products),
        })

        # update history (เหมือน route.ts)
        history.append({'role': 'user', 'text': bot_msg})
        history.append({'role': 'model', 'text': bot_answer or '(no answer)'})

        if verbose:
            print(f'\n── Q{i+1} [{fmt_ts(um.get("created_timestamp"))}] item_id={item_id or "-"} ──')
            print(f'ลูกค้า  : {short(bot_msg, 220)}')
            print(f'Zaapi   : [{zaapi_role or "-"}/{zaapi_source or "-"}] {short(zaapi_text, 220)}')
            if bot.get('error'):
                print(f'Bot ERR : {bot["error"]}')
            else:
                ws = ' 🔍ws' if bot_ws else ''
                ho = ' ⚠️handoff' if bot_handoff else ''
                tr = f' 🔧trigger:"{trigger_name}"' if trigger_name else ''
                print(f'Bot     : [{bot_source or "-"}{ws}{ho}{tr}] {short(bot_answer, 260)}')

        if bot_handoff:
            handoff_stopped = True
            if verbose:
                print('  → bot ขอ handoff → หยุด replay')
            break

    return {
        'conv_id': conv_id,
        'shop_name': shop_name,
        'shop_id': shop_id,
        'qa': qa,
        'n_user': len(user_msgs),
        'n_out': len(out_msgs),
        'skipped_system': skipped_system,
        'handoff_stopped': handoff_stopped,
    }


def list_conversations(admin_db, shop: str | None, platform: str, limit: int,
                       oldest: bool = False) -> list:
    msg_coll = admin_db[MSG_COLL]
    conv_coll = admin_db[CONV_COLL]

    conv_ids = list(conv_coll.distinct('conversation_id', {
        'platform': platform,
        **({'shop_name': shop} if shop else {}),
    }))

    match = {'conversation_id': {'$in': conv_ids}, 'direction': 'in', 'role': 'user'}
    pipeline = [
        {'$match': match},
        {'$group': {'_id': '$conversation_id', 'n': {'$sum': 1}}},
        {'$sort': {'n': -1}},
        {'$limit': limit * 4},
    ]
    convs = []
    for r in msg_coll.aggregate(pipeline):
        if r['n'] < 2:
            continue
        n_out = msg_coll.count_documents({
            'conversation_id': r['_id'],
            'direction': 'out',
            'role': {'$in': ['bot', 'admin']},
        })
        if n_out == 0:
            continue
        conv = conv_coll.find_one({'conversation_id': r['_id']})
        convs.append({
            'conversation_id': r['_id'],
            'shop_name': conv.get('shop_name') if conv else None,
            'n_user': r['n'],
            'n_out': n_out,
            'last_ts': conv.get('last_message_timestamp') if conv else None,
        })
    # oldest=True → เก่าสุดก่อน, oldest=False → ใหม่สุดก่อน
    convs.sort(key=lambda c: c['last_ts'] or datetime.min, reverse=not oldest)
    return convs[:limit]


def analyze_results(results: list) -> dict:
    """วิเคราะห์ผล replay ทั้งหมด สรุปปัญหา/จุดดี/จุดที่ต้องปรับทั่วไป.

    ใช้ 2 ขั้นตอน:
    1. rule-based stats (ความยาว/ลิงก์/error/source)
    2. LLM judge (เรียก Gemini ตรงๆ ผ่าน llm._client()) — วิเคราะห์เนื้อหา
       ว่า bot ตอบถูกต้องไหม ตรงประเด็นไหม มีข้อมูลเพียงพอไหม
    """
    total_convs = len(results)
    total_qa = 0
    bot_answered = 0
    bot_errors = 0
    bot_handoffs = 0
    web_search_used = 0
    zaapi_only = 0  # bot ไม่ตอบ แต่ zaapi ตอบ
    bot_only = 0    # bot ตอบ แต่ zaapi ไม่ตอบ
    both_answered = 0
    bot_short = 0   # bot ตอบสั้นเกินไป (<80 ตัวอักษร)
    bot_long = 0    # bot ตอบยาวเกินไป (>1500 ตัวอักษร)
    zaapi_short = 0
    zaapi_long = 0
    bot_has_link = 0
    zaapi_has_link = 0
    bot_external_link = 0  # bot มีลิงก์นอกร้าน
    bot_no_link = 0  # bot ตอบสินค้าแต่ไม่มีลิงก์สั่งซื้อ
    sources = {}
    triggers_matched = 0
    skipped_system = 0
    handoff_stopped = 0
    avg_bot_len = 0
    avg_zaapi_len = 0
    issues = []
    good = []

    bot_lens = []
    zaapi_lens = []

    # เก็บ QA ที่ bot และ zaapi ตอบทั้งคู่ เพื่อส่งให้ LLM judge
    judge_samples = []

    for r in results:
        if r.get('skipped'):
            continue
        skipped_system += r.get('skipped_system', 0)
        if r.get('handoff_stopped'):
            handoff_stopped += 1
        for q in r.get('qa', []):
            total_qa += 1
            z = q.get('zaapi_text', '') or ''
            b = q.get('bot_answer', '') or ''
            zlen = len(z)
            blen = len(b)
            status = q.get('status', '')

            if q.get('bot_error'):
                bot_errors += 1
                issues.append(f"[{r['conv_id'][:12]}] Q{q['i']}: bot error: {q['bot_error']}")
            if q.get('bot_handoff'):
                bot_handoffs += 1
            if q.get('bot_ws'):
                web_search_used += 1
            if q.get('trigger'):
                triggers_matched += 1
            if status.startswith('handed_off'):
                continue

            if blen > 0 and zlen == 0:
                bot_only += 1
            elif zlen > 0 and blen == 0:
                zaapi_only += 1
                issues.append(f"[{r['conv_id'][:12]}] Q{q['i']}: bot ไม่ตอบ แต่ zaapi ตอบ ({zlen}c)")
            elif blen > 0 and zlen > 0:
                both_answered += 1

            if blen > 0:
                bot_answered += 1
                bot_lens.append(blen)
                if blen < 80:
                    bot_short += 1
                    issues.append(f"[{r['conv_id'][:12]}] Q{q['i']}: bot ตอบสั้นเกินไป ({blen}c)")
                elif blen > 1500:
                    bot_long += 1
                    issues.append(f"[{r['conv_id'][:12]}] Q{q['i']}: bot ตอบยาวเกินไป ({blen}c)")
                # ลิงก์
                if 'http' in b or 'สั่งซื้อ' in b or 'shopee.co.th' in b:
                    bot_has_link += 1
                else:
                    bot_no_link += 1
                # ลิงก์นอกร้าน (ไม่ใช่ shopee)
                if 'http' in b and 'shopee.co.th' not in b and 'cf.shopee' not in b:
                    bot_external_link += 1
                    issues.append(f"[{r['conv_id'][:12]}] Q{q['i']}: bot มีลิงก์นอกร้าน (ไม่ใช่ shopee)")

            if zlen > 0:
                zaapi_lens.append(zlen)
                if zlen < 80:
                    zaapi_short += 1
                elif zlen > 1500:
                    zaapi_long += 1
                if 'http' in z or 'สั่งซื้อ' in z or 'shopee.co.th' in z:
                    zaapi_has_link += 1

            src = q.get('bot_source') or 'unknown'
            sources[src] = sources.get(src, 0) + 1

            # เก็บ sample สำหรับ LLM judge (เฉพาะที่ bot ตอบ)
            if blen > 0:
                judge_samples.append({
                    'conv_id': r['conv_id'],  # ⚡ เก็บเต็มไม่ตัด — กัน map ผิด
                    'q_i': q['i'],
                    'user': q.get('user_text', '')[:300],
                    'bot_answer': b[:800],
                    'zaapi_text': z[:800] if zlen > 0 else '',
                    'bot_source': q.get('bot_source', ''),
                    'shop': r.get('shop_name', ''),
                    # ⚡ debug info สำหรับ LLM judge
                    'bot_log': q.get('bot_log', '')[:2000],
                    'bot_intent': q.get('bot_intent', {}),
                    'bot_retrieval_info': q.get('bot_retrieval_info', {}),
                    'bot_routing': q.get('bot_routing', {}),
                    'bot_product_names': q.get('bot_product_names', []),
                    'bot_products_count': q.get('bot_products_count', 0),
                    'bot_timing': q.get('bot_timing', {}),
                })

    avg_bot_len = round(sum(bot_lens) / len(bot_lens), 1) if bot_lens else 0
    avg_zaapi_len = round(sum(zaapi_lens) / len(zaapi_lens), 1) if zaapi_lens else 0

    # สรุปจุดดี
    if bot_answered > 0 and bot_errors == 0:
        good.append(f"bot ตอบครบทุกคำถาม ({bot_answered} คำถาม) ไม่มี error")
    if bot_short == 0 and bot_answered > 0:
        good.append(f"bot ไม่ตอบสั้นเกินไป (ทั้งหมด {bot_answered} คำตอบ)")
    if bot_external_link == 0:
        good.append("bot ไม่ส่งลิงก์นอกร้าน (shopee only)")
    if both_answered > 0:
        good.append(f"bot และ zaapi ตอบพร้อมกัน {both_answered} คำถาม — เปรียบเทียบได้")

    # สรุปปัญหา
    if bot_short > 0:
        issues.insert(0, f"⚠️ bot ตอบสั้นเกินไป {bot_short} คำถาม")
    if bot_long > 0:
        issues.insert(0, f"⚠️ bot ตอบยาวเกินไป {bot_long} คำถาม")
    if zaapi_only > 0:
        issues.insert(0, f"⚠️ bot ไม่ตอบ {zaapi_only} คำถาม (zaapi ตอบ)")
    if bot_external_link > 0:
        issues.insert(0, f"⚠️ bot ส่งลิงก์นอกร้าน {bot_external_link} ครั้ง")
    if bot_errors > 0:
        issues.insert(0, f"❌ bot error {bot_errors} ครั้ง")

    # ── LLM judge: วิเคราะห์เนื้อหา QA samples ──
    llm_judgments = []
    if judge_samples:
        # ⚡ เอาทั้งหมด — ไม่จำกัด 30 (แชททุกตัวควรมี review)
        llm_judgments = llm_judge_batch(judge_samples)

    # รวม LLM judgments เข้า issues/good
    for j in llm_judgments:
        if j.get('verdict') == 'bot_better':
            good.append(f"[{j['conv_id']}] Q{j['q_i']}: LLM judge → bot ตอบดีกว่า — {j.get('reason','')[:80]}")
        elif j.get('verdict') == 'zaapi_better':
            issues.append(f"[{j['conv_id']}] Q{j['q_i']}: LLM judge → zaapi ดีกว่า — {j.get('reason','')[:100]}")
        elif j.get('verdict') == 'both_bad':
            issues.append(f"[{j['conv_id']}] Q{j['q_i']}: LLM judge → ตอบไม่ดีทั้งคู่ — {j.get('reason','')[:100]}")
        if j.get('bot_problems'):
            for p in j['bot_problems'][:2]:
                issues.append(f"[{j['conv_id']}] Q{j['q_i']}: bot problem → {p[:100]}")

    return {
        'total_conversations': total_convs,
        'total_qa': total_qa,
        'bot_answered': bot_answered,
        'bot_errors': bot_errors,
        'bot_handoffs': bot_handoffs,
        'web_search_used': web_search_used,
        'triggers_matched': triggers_matched,
        'skipped_system': skipped_system,
        'handoff_stopped': handoff_stopped,
        'both_answered': both_answered,
        'bot_only': bot_only,
        'zaapi_only': zaapi_only,
        'bot_short': bot_short,
        'bot_long': bot_long,
        'zaapi_short': zaapi_short,
        'zaapi_long': zaapi_long,
        'bot_has_link': bot_has_link,
        'bot_no_link': bot_no_link,
        'bot_external_link': bot_external_link,
        'zaapi_has_link': zaapi_has_link,
        'avg_bot_len': avg_bot_len,
        'avg_zaapi_len': avg_zaapi_len,
        'sources': sources,
        'issues': issues,
        'good': good,
        'llm_judgments': llm_judgments,
    }


def llm_judge_batch(samples: list) -> list:
    """เรียก Gemini ตรงๆ (ผ่าน llm._client()) เพื่อวิเคราะห์ QA แต่ละคู่.

    รับ QA samples (user, bot_answer, zaapi_text, bot_log, intent, retrieval_info, products)
    แล้วให้ LLM ตัดสิน:
    - verdict: bot_better / zaapi_better / both_good / both_bad
    - reason: เหตุผลสั้นๆ
    - bot_problems: list ของปัญหาในคำตอบ bot (พร้อมเหตุผลรายข้อ)
    - bot_fixes: list ของวิธีแก้
    - side_effects: ผลกระทบที่อาจเกิดจากการแก้
    """
    try:
        # lazy import (หลีกเลี่ยง circular import)
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'chatbot'))
        from shopeechat import llm
    except Exception as e:
        print(f'[LLM-JUDGE] import llm ไม่ได้: {e}', file=sys.stderr)
        return []

    judgments = []
    model = os.environ.get('ANALYSIS_MODEL', 'gemini-3.5-flash-lite')

    for s in samples:
        # ⚡ ใช้ _client() ทุกครั้งเพื่อ rotate API key (หลีกเลี่ยง 429)
        client = llm._client()
        # สร้าง debug info section สำหรับ LLM judge
        debug_section = ""
        if s.get('bot_log'):
            debug_section += f"\n📋 Bot log (input/output ระหว่างเรียก):\n{s['bot_log'][:1500]}\n"
        if s.get('bot_intent'):
            debug_section += f"\n🎯 Intent: {json.dumps(s['bot_intent'], ensure_ascii=False, default=str)[:300]}\n"
        if s.get('bot_retrieval_info'):
            debug_section += f"\n🔍 Retrieval: {json.dumps(s['bot_retrieval_info'], ensure_ascii=False, default=str)[:400]}\n"
        if s.get('bot_routing'):
            debug_section += f"\n🔀 Routing: {json.dumps(s['bot_routing'], ensure_ascii=False, default=str)[:200]}\n"
        if s.get('bot_product_names'):
            debug_section += f"\n📦 Products retrieved ({s.get('bot_products_count',0)}): {s['bot_product_names'][:5]}\n"
        if s.get('bot_timing'):
            debug_section += f"\n⏱️ Timing: {json.dumps(s['bot_timing'], ensure_ascii=False, default=str)[:200]}\n"

        prompt = f"""คุณเป็นผู้ตรวจสอบคุณภาพคำตอบของแชทบอทขายสินค้า Shopee ชื่อร้าน {s.get('shop','')}

คำถามลูกค้า:
{s.get('user','')}

คำตอบของ Bot เรา:
{s.get('bot_answer','')}

คำตอบของ Zaapi/Admin (คำตอบจริงที่ส่งให้ลูกค้า):
{s.get('zaapi_text','(ไม่มี)')}
{debug_section}
วิเคราะห์และตอบเป็น JSON เท่านั้น (ไม่ต้องมี markdown fence):

อ่าน log/retrieval/intent ด้านบนด้วยเพื่อเข้าใจว่า bot ทำงานถูกต้องไหม
ดึงสินค้าที่เกี่ยวข้องครบไหม ตอบตรงคำถามลูกค้าไหม

{{
  "verdict": "bot_better หรือ zaapi_better หรือ both_good หรือ both_bad",
  "reason": "เหตุผลสั้นๆ 1 ประโยค ว่าทำไมตัดสินแบบนี้",
  "bot_problems": [
    "ปัญหาที่พบในคำตอบ bot รายข้อ — พร้อมอธิบายเหตุผลเฉพาะข้อ (เช่น 'ดึงสินค้าผิดรุ่น: log แสดง retrieval=CTC620P ทั้งที่ลูกค้าถาม CTC615U')"
  ],
  "bot_fixes": [
    "วิธีแก้ปัญหาแต่ละข้อที่แนะนำ (เช่น 'เพิ่ม logic ตรวจ model token ใน message ก่อนใช้ reference extraction')"
  ],
  "side_effects": "ผลกระทบที่อาจเกิดจากการแก้ (ถ้ามี) — ระบุเป็น list ใน string ถ้ามีหลายข้อ",
  "bot_strengths": [
    "จุดแข็งของ bot ในคำตอบนี้ (ถ้ามี) — เช่น 'ตอบครบทั้ง 2 รุ่นที่ลูกค้าถาม', 'มีลิงก์สั่งซื้อถูกต้อง'"
  ]
}}"""

        try:
            # ⚡ retry สำหรับ 429 (rotate key + sleep)
            import time as _time
            resp = None
            for _attempt in range(3):
                try:
                    client = llm._client()  # rotate key
                    resp = client.models.generate_content(
                        model=model,
                        contents=prompt,
                    )
                    break
                except Exception as _e:
                    if '429' in str(_e) and _attempt < 2:
                        _time.sleep(5 * (_attempt + 1))
                        continue
                    raise
            if resp is None:
                raise Exception('no response after retries')
            text = (resp.text or '').strip()
            # ตัด markdown fence ถ้ามี
            if text.startswith('```'):
                text = re.sub(r'^```(?:json)?\s*', '', text)
                text = re.sub(r'\s*```$', '', text)
            j = json.loads(text)
            j['conv_id'] = s['conv_id']
            j['q_i'] = s['q_i']
            judgments.append(j)
            # log progress
            v = j.get('verdict', '?')
            print(f"  [JUDGE] {s['conv_id']} Q{s['q_i']}: {v}", file=sys.stderr)
        except Exception as e:
            judgments.append({
                'conv_id': s['conv_id'],
                'q_i': s['q_i'],
                'verdict': 'judge_error',
                'reason': str(e)[:120],
                'bot_problems': [],
                'bot_fixes': [],
            })
            print(f"  [JUDGE] {s['conv_id']} Q{s['q_i']}: ERROR {e}", file=sys.stderr)

    return judgments


def print_analysis(a: dict) -> None:
    """แสดงผล analysis แบบ readable."""
    print(f"\n📊 Total conversations: {a['total_conversations']}")
    print(f"📊 Total Q&A turns: {a['total_qa']}")
    print(f"📊 Bot answered: {a['bot_answered']} | Errors: {a['bot_errors']} | Handoffs: {a['bot_handoffs']}")
    print(f"📊 Web search used: {a['web_search_used']} | Triggers matched: {a['triggers_matched']}")
    print(f"📊 Skipped system msgs: {a['skipped_system']} | Handoff stopped: {a['handoff_stopped']}")
    print(f"\n📈 Comparison:")
    print(f"   Both answered: {a['both_answered']}")
    print(f"   Bot only (zaapi ไม่ตอบ): {a['bot_only']}")
    print(f"   Zaapi only (bot ไม่ตอบ): {a['zaapi_only']}")
    print(f"\n📏 Length:")
    print(f"   Bot avg: {a['avg_bot_len']}c | short(<80): {a['bot_short']} | long(>1500): {a['bot_long']}")
    print(f"   Zaapi avg: {a['avg_zaapi_len']}c | short: {a['zaapi_short']} | long: {a['zaapi_long']}")
    print(f"\n🔗 Links:")
    print(f"   Bot has link: {a['bot_has_link']} | no link: {a['bot_no_link']} | external: {a['bot_external_link']}")
    print(f"   Zaapi has link: {a['zaapi_has_link']}")
    print(f"\n📦 Sources: {a['sources']}")

    # LLM judgments summary
    judgments = a.get('llm_judgments', [])
    if judgments:
        verdicts = {}
        for j in judgments:
            v = j.get('verdict', 'unknown')
            verdicts[v] = verdicts.get(v, 0) + 1
        print(f"\n🤖 LLM Judge ({len(judgments)} samples):")
        for v, n in sorted(verdicts.items(), key=lambda x: -x[1]):
            print(f"   {v}: {n}")

        # แสดงเหตุผลรายข้อความ
        print(f"\n📝 LLM Judge — เหตุผลรายข้อความ:")
        for j in judgments:
            v = j.get('verdict', '?')
            reason = j.get('reason', '')[:120]
            icon = {'bot_better': '🟢', 'zaapi_better': '🔴',
                    'both_good': '🟡', 'both_bad': '⚫',
                    'judge_error': '❌'}.get(v, '⚪')
            print(f"  {icon} [{j.get('conv_id','')}] Q{j.get('q_i','?')}: {v}")
            print(f"     เหตุผล: {reason}")
            if j.get('bot_problems'):
                for p in j['bot_problems'][:3]:
                    print(f"     ⚠️ ปัญหา: {p[:120]}")
            if j.get('bot_strengths'):
                for s in j['bot_strengths'][:2]:
                    print(f"     ✅ จุดแข็ง: {s[:120]}")
            if j.get('bot_fixes'):
                for f in j['bot_fixes'][:2]:
                    print(f"     🔧 แก้: {f[:120]}")

    if a['good']:
        print(f"\n✅ จุดดี:")
        for g in a['good']:
            print(f"   {g}")
    if a['issues']:
        print(f"\n⚠️ ปัญหาที่พบ ({len(a['issues'])} ข้อ):")
        for i, iss in enumerate(a['issues'][:30]):
            print(f"   {i+1}. {iss}")
        if len(a['issues']) > 30:
            print(f"   ... และอีก {len(a['issues'])-30} ข้อ")


def _stream_save(save_path: str, results: list, args, status: str = "running",
                 current_idx: int = 0, total: int = 0):
    """เซฟ JSON ทีละแชท — ให้ frontend โหลดดู real-time ได้.

    โครงสร้างเหมือนเซฟตอนจบ แต่เพิ่ม:
    - status: "running" / "done" / "error"
    - progress: { current, total }
    - analysis: คำนวณจาก results ที่มีตอนนี้ (อาจไม่ครบ)
    """
    analysis = analyze_results(results) if results else {}
    output = {
        'generated_at': datetime.now().isoformat(),
        'bot_url': BOT_URL,
        'limit': args.limit,
        'oldest': args.oldest,
        'shop_filter': args.shop,
        'status': status,
        'progress': {'current': current_idx, 'total': total},
        'analysis': analysis,
        'conversations': results,
    }
    # เซฟลงไฟล์ชั่วคราวก่อนแล้ว rename (atomic — ป้องกัน frontend อ่านไฟล์ครึ่งจบ)
    tmp_path = save_path + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=str)
    os.replace(tmp_path, save_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shop', default=None, help='shop_name filter (e.g. IMILabThailand)')
    ap.add_argument('--conv', default=None, help='specific conversation_id')
    ap.add_argument('--limit', type=int, default=5)
    ap.add_argument('--platform', default='shopee')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--save', default=None)
    ap.add_argument('--oldest', action='store_true', help='เรียงจากเก่าสุดก่อน (default: ใหม่สุดก่อน)')
    args = ap.parse_args()

    if not ADMIN_MONGO_URI:
        print('ERROR: ADMIN_MONGO_URI not set')
        sys.exit(1)

    admin_client = MongoClient(ADMIN_MONGO_URI, serverSelectionTimeoutMS=5000)
    admin_db = admin_client[ADMIN_MONGO_DB]
    # ⚡ เปิด product DB (dbWallet) เพื่อ lookup product card สำหรับหน้าเว็บ
    prod_db = None
    if PROD_MONGO_URI:
        try:
            prod_client = MongoClient(PROD_MONGO_URI, serverSelectionTimeoutMS=5000)
            prod_db = prod_client[PROD_MONGO_DB]
            prod_client.admin.command('ping')
            print(f'Product DB: {PROD_MONGO_DB} / {PROD_COLL}')
        except Exception as e:
            print(f'WARN: product DB not available — {e}')
            prod_db = None

    print(f'Bot: {BOT_URL}')
    print(f'Admin DB: {ADMIN_MONGO_DB} / {MSG_COLL}')

    if args.conv:
        results = [replay_one(admin_db, prod_db, args.conv, verbose=not args.quiet)]
        if args.save:
            _stream_save(args.save, results, args, status="done", total=1, current_idx=1)
    else:
        convs = list_conversations(admin_db, args.shop, args.platform, args.limit,
                                   oldest=args.oldest)
        print(f'\nFound {len(convs)} conversations (with >=2 user msgs + >=1 out reply)')
        for c in convs:
            print(f"  {c['conversation_id']}  shop={c['shop_name']}  user={c['n_user']}  out={c['n_out']}")
        results = []
        total = len(convs)
        for idx, c in enumerate(convs):
            print(f'\n[{idx+1}/{total}] Replaying {c["conversation_id"]}...', file=sys.stderr)
            r = replay_one(admin_db, prod_db, c['conversation_id'], verbose=not args.quiet)
            results.append(r)
            # ⚡ stream save ทีละแชท — ให้ frontend ดู real-time ได้
            if args.save:
                _stream_save(args.save, results, args, status="running",
                             current_idx=idx + 1, total=total)

    # summary
    print(f'\n\n{"#"*78}')
    print('SUMMARY')
    print(f'{"#"*78}')
    for r in results:
        if r.get('skipped'):
            print(f"{r['conv_id']}: SKIPPED ({r['skipped']})")
            continue
        print(f"\n[{r['conv_id']}] shop={r['shop_name']}  turns={r['n_user']}  (skipped_system={r['skipped_system']}, handoff_stopped={r['handoff_stopped']})")
        for q in r['qa']:
            tag = ''
            if q.get('bot_error'):
                tag = f" ❌ERR"
            elif q.get('status', '').startswith('handed_off'):
                tag = ' ⚠️handoff'
            elif q.get('bot_ws'):
                tag = ' 🔍ws'
            z = len(q.get('zaapi_text', ''))
            b = len(q.get('bot_answer', ''))
            winner = ''
            if b > 0 and z == 0:
                winner = '← BOT only (zaapi ไม่มี)'
            elif z > 0 and b == 0:
                winner = '← ZAAPI only (bot ไม่ตอบ)'
            print(f"  Q{q['i']:>2} zaapi={z:>4}c  bot={b:>4}c  {q.get('status','?')}{tag} {winner}")

    if args.save:
        # ⚡ เซฟ status=done + analysis สุดท้าย
        _stream_save(args.save, results, args, status="done",
                     current_idx=len(results), total=len(results))
        print(f'\nSaved to {args.save}')
        print(f'\n{"="*78}')
        print('ANALYSIS')
        print(f'{"="*78}')
        analysis = analyze_results(results)
        print_analysis(analysis)


if __name__ == '__main__':
    main()
