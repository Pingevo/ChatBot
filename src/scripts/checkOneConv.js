require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const { signShopLevel, PARTNER_ID } = require('../services/shopeeSign');
const { getValidAccessToken } = require('../services/tokenReader');
const RequestLog = require('../models/RequestLog');
const JSONbig = require('json-bigint')({ storeAsString: true });

const SHOPEE_HOST_URL = process.env.SHOPEE_HOST_URL || 'https://partner.shopeemobile.com';

async function callApi(shop, apiName, { method = 'GET', query = {}, body = null } = {}) {
  const path = `/api/v2/sellerchat/${apiName}`;
  const { access_token, shop_id } = await getValidAccessToken({ shop_id: shop.shop_id, shopname: shop.shopname });
  const { timestamp, sign } = signShopLevel(path, access_token, shop_id);

  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token,
    shop_id: String(shop_id),
    sign,
    ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
  });

  const url = `${SHOPEE_HOST_URL}${path}?${params.toString()}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  const data = JSONbig.parse(text);
  return data;
}

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Time now:', new Date().toISOString());
  console.log('Shop:', shop.shop_id, shop.shop_name);

  // 1. get_unread_conversation_count
  console.log('\n=== get_unread_conversation_count ===');
  try {
    const data = await callApi(shop, 'get_unread_conversation_count');
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.log('Error:', err.message);
  }

  // 2. get_one_conversation สำหรับ conv ที่คุณคุยอยู่
  const convId = '80245417614920823';
  console.log('\n=== get_one_conversation:', convId, '===');
  try {
    const data = await callApi(shop, 'get_one_conversation', { query: { conversation_id: convId } });
    console.log('Response:', JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    if (data.response) {
      const ts = data.response.last_message_timestamp;
      const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
      console.log('last_message_timestamp:', d ? d.toISOString() : 'null');
      console.log('unread_count:', data.response.unread_count);
    }
  } catch (err) {
    console.log('Error:', err.message);
  }

  // 3. get_message สำหรับ conv เดิม ด้วย page_size=50
  console.log('\n=== get_message:', convId, '(page_size=50) ===');
  try {
    const data = await callApi(shop, 'get_message', { query: { conversation_id: convId, page_size: 50, business_type: 0 } });
    const msgs = data.messages || [];
    console.log('Messages:', msgs.length);
    for (const m of msgs.slice(-5)) {
      const text = (m.content && m.content.text) || '[' + m.message_type + ']';
      const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
      const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
      console.log('  ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70));
    }
  } catch (err) {
    console.log('Error:', err.message);
  }

  // 4. รอ 5 นาทีแล้วเช็คอีกครั้ง
  console.log('\n=== Waiting 5 minutes then re-checking... ===');
  console.log('(Shopee API may have 5-30 min delay for new messages)');
  await new Promise(r => setTimeout(r, 300000));
  console.log('Time after wait:', new Date().toISOString());

  // เช็ค unread count อีกครั้ง
  const data2 = await callApi(shop, 'get_unread_conversation_count');
  console.log('Unread count after wait:', JSON.stringify(data2));

  // เช็ค get_one_conversation อีกครั้ง
  const data3 = await callApi(shop, 'get_one_conversation', { query: { conversation_id: convId } });
  if (data3.response) {
    const ts = data3.response.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('get_one_conversation last_message:', d ? d.toISOString() : 'null');
    console.log('unread_count:', data3.response.unread_count);
  }

  // เช็ค get_message อีกครั้ง
  const data4 = await callApi(shop, 'get_message', { query: { conversation_id: convId, page_size: 50, business_type: 0 } });
  const msgs4 = data4.messages || [];
  console.log('Messages after wait:', msgs4.length);
  for (const m of msgs4.slice(-5)) {
    const text = (m.content && m.content.text) || '[' + m.message_type + ']';
    const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
    const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
    console.log('  ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70));
  }

  process.exit(0);
}

check();
