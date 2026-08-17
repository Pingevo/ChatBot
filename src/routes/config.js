const express = require('express');
const router = express.Router();
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Customer = require('../models/Customer');
const { getSystemConfig, updateSystemConfig, testShopeeIntegration } = require('../services/configService');
const { handleNewMessage } = require('../services/chatEvents');

// GET /api/config/shopee — ดึงข้อมูลการตั้งค่า Shopee API ทั้งหมด
router.get('/shopee', async (req, res) => {
  try {
    const config = await getSystemConfig(true);
    const shops = await Shop.find({ platform: 'shopee' }).sort({ shop_name: 1 }).lean();

    const envInfo = {
      partner_id: process.env.SHOPEE_PARTNER_ID ? String(process.env.SHOPEE_PARTNER_ID) : '(not set)',
      host_url: process.env.SHOPEE_HOST_URL || 'https://partner.shopeemobile.com',
      push_callback_url: process.env.SHOPEE_PUSH_CALLBACK_URL || '(not set)',
      legacy_forward_url: process.env.SHOPEE_PUSH_LEGACY_FORWARD_URL || 'https://sales.digital.in.th/shp/push',
      has_partner_key: !!process.env.SHOPEE_PARTNER_KEY,
      has_internal_forward_secret: !!process.env.INTERNAL_FORWARD_SECRET,
      has_sellcenter_mongo: !!process.env.SELLCENTER_MONGO_URI,
    };

    res.json({
      ok: true,
      config,
      envInfo,
      shops,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/config/shopee — บันทึกการตั้งค่า Shopee API Switches
router.put('/shopee', async (req, res) => {
  try {
    const updatedBy = req.user ? (req.user.nickname || req.user.name || req.user.email) : 'admin';
    const updated = await updateSystemConfig(req.body, updatedBy);
    res.json({ ok: true, config: updated, message: 'บันทึกการตั้งค่าสำเร็จ' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/config/shopee/shop/:shop_id/toggle — เปิด/ปิดช่องแชทเฉพาะร้าน
router.patch('/shopee/shop/:shop_id/toggle', async (req, res) => {
  try {
    const { shop_id } = req.params;
    const { enabled_for_chat } = req.body;

    if (typeof enabled_for_chat !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'enabled_for_chat must be boolean' });
    }

    const shop = await Shop.findOneAndUpdate(
      { shop_id, platform: 'shopee' },
      { $set: { enabled_for_chat, disabled_by_user: !enabled_for_chat } },
      { new: true }
    );

    if (!shop) {
      return res.status(404).json({ ok: false, error: 'shop_not_found' });
    }

    res.json({ ok: true, shop, message: `อัปเดตสถานะร้าน ${shop.shop_name || shop_id} เรียบร้อยแล้ว` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/config/shopee/test-connection — ทดสอบการเชื่อมต่อ API และ Token
router.post('/shopee/test-connection', async (req, res) => {
  try {
    const results = await testShopeeIntegration();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/config/shopee/mock-message — สร้างข้อความจำลองเพื่อทดสอบระบบแชทโดยไม่ง้อ Shopee จริง
router.post('/shopee/mock-message', async (req, res) => {
  try {
    const {
      shop_id,
      buyer_name = 'ลูกค้าทดสอบ (Mock Buyer)',
      buyer_id = '99999' + Math.floor(1000 + Math.random() * 9000),
      message_text = 'สวัสดีครับ ขอสอบถามสินค้าทดสอบหน่อยครับ',
      direction = 'in',
    } = req.body;

    if (!shop_id) {
      return res.status(400).json({ ok: false, error: 'กรุณาระบุ shop_id' });
    }

    const shop = await Shop.findOne({ shop_id, platform: 'shopee' });
    if (!shop) {
      return res.status(404).json({ ok: false, error: 'ไม่พบร้านค้านี้ในระบบ' });
    }

    const conversation_id = `mock-conv-${shop.shop_id}-${buyer_id}`;
    const message_id = `mock-msg-${Date.now()}`;
    const now = new Date();

    // 1. บันทึก Customer
    await Customer.updateOne(
      { platform: 'shopee', platform_user_id: String(buyer_id) },
      {
        $set: {
          name: buyer_name,
          platform: 'shopee',
          platform_user_id: String(buyer_id),
          last_active_at: now,
        },
      },
      { upsert: true }
    );

    // 2. บันทึก Message
    const msgDoc = await Message.create({
      platform: 'shopee',
      shop_id: String(shop.shop_id),
      conversation_id,
      message_id,
      from_id: direction === 'in' ? String(buyer_id) : String(shop.shop_id),
      from_shop_id: direction === 'in' ? '' : String(shop.shop_id),
      to_id: direction === 'in' ? String(shop.shop_id) : String(buyer_id),
      to_shop_id: direction === 'in' ? String(shop.shop_id) : '',
      message_type: 'text',
      direction,
      content: { text: message_text },
      status: 'normal',
      source: 'mock_test',
      created_timestamp: now,
      raw_payload: { mock: true, note: 'Generated from Shopee API Config Simulator' },
    });

    // 3. Upsert Conversation
    const convUpdate = {
      $set: {
        platform: 'shopee',
        to_id: String(buyer_id),
        to_name: buyer_name,
        latest_message_id: message_id,
        latest_message_type: 'text',
        latest_message_content: { text: message_text },
        latest_message_from_id: direction === 'in' ? String(buyer_id) : String(shop.shop_id),
        last_message_timestamp: now,
      },
      $setOnInsert: {
        status: 'open',
      },
    };

    if (direction === 'in') {
      convUpdate.$inc = { unread_count: 1 };
    }

    const conv = await Conversation.findOneAndUpdate(
      { shop_id: String(shop.shop_id), conversation_id },
      convUpdate,
      { upsert: true, new: true }
    ).lean();

    // 4. Trigger chatEvents (Auto-assignment, metric turn, SLA)
    await handleNewMessage(conv, { message_id, created_timestamp: now }, direction);

    res.json({
      ok: true,
      message: 'สร้างข้อความทดสอบจำลองสำเร็จ',
      data: {
        conversation_id,
        message_id,
        conversation: conv,
        message: msgDoc,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
