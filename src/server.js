require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const { connectMainDB } = require('./config/db');
const { loadUser, requireAuth } = require('./middlewares/authMiddleware');

const apiRoutes = require('./routes/api');
const teamRoutes = require('./routes/team');
const inboxRoutes = require('./routes/inbox');
const webhookRoutes = require('./routes/webhook');
const authRoutes = require('./routes/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
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

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set in .env');
}

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'sessions' }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 วัน
  },
}));
app.use(loadUser);

app.use('/auth', authRoutes);
app.use('/webhook', webhookRoutes); // Shopee push callback (webchat_push Code 10) — ไม่ต้อง login เพราะ Shopee เป็นคนยิงเข้ามา
app.use('/api', requireAuth, apiRoutes);
app.use('/api', requireAuth, teamRoutes);
app.use('/', requireAuth, inboxRoutes);

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
