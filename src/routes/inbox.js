const express = require('express');
const router = express.Router();
const Shop = require('../models/Shop');

router.get('/', (req, res) => res.redirect('/inbox'));

router.get('/inbox', async (req, res) => {
  const shops = await Shop.find({ enabled_for_chat: true });
  res.render('inbox', {
    shops,
    enableSendMessage: process.env.ENABLE_SEND_MESSAGE === 'true',
    enableMarkRead: process.env.ENABLE_MARK_READ === 'true',
  });
});

router.get('/shops', async (req, res) => {
  const shops = await Shop.find({}).sort({ shop_name: 1 });
  res.render('shops', { shops });
});

// Dashboard — render shell แล้วดึงข้อมูลจริงผ่าน /api/dashboard (ฝั่ง client)
router.get('/dashboard', (req, res) => res.render('dashboard'));

// Contacts — render shell แล้วดึงข้อมูลจริงผ่าน /api/contacts (ฝั่ง client)
router.get('/contacts', (req, res) => res.render('contacts'));

module.exports = router;
