require('dotenv').config();
const express = require('express');
const path = require('path');
const { connectMainDB } = require('./config/db');

const apiRoutes = require('./routes/api');
const inboxRoutes = require('./routes/inbox');
const webhookRoutes = require('./routes/webhook');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// ⚠️ verify hook เก็บ raw body ไว้ก่อน parse — webhook route ต้องใช้ raw bytes
// สำหรับ signature verification (Shopee sign: callbackUrl + "|" + rawBody)
// ใช้ global เพราะ router-level express.json จะไม่ทำงานถ้า body ถูก parse ไปแล้ว
app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRoutes);
app.use('/webhook', webhookRoutes); // Shopee push callback (webchat_push Code 10)
app.use('/', inboxRoutes);

async function start() {
  await connectMainDB();
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`[server] listening on port ${port}`);
    console.log('[server] reminder: run "npm run poll" in a separate process to start the polling worker');
  });

  // Graceful shutdown — ปิด server + ปิด mongoose connection ให้สะอาด
  // กันปัญหา EADDRINUSE ตอนรันครั้งต่อไป (โดยเฉพาะบน Windows ที่ port ค้างนาน)
  async function shutdown(signal) {
    console.log(`[server] received ${signal}, shutting down...`);
    server.close(async () => {
      const mongoose = require('mongoose');
      try {
        await mongoose.connection.close();
        console.log('[server] closed cleanly');
        process.exit(0);
      } catch (err) {
        process.exit(1);
      }
    });
    // บังคับออกภายใน 5 วินาที กันค้าง
    setTimeout(() => {
      console.error('[server] forced exit after timeout');
      process.exit(1);
    }, 5000);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
