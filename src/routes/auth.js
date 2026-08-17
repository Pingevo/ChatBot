const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');

// Staff login ผ่าน sellcenter (system81) SSO เท่านั้น — ไม่มี local password
router.get('/login', authController.showLogin);
router.get('/dev-login', authController.devLogin);
router.get('/redirect', authController.redirectToSellcenter);
router.get('/callback', authController.callback);
router.get('/logout', authController.logout);

module.exports = router;
