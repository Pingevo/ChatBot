require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SAMPLE_VIDEO_URL = 'https://down-tx-sg.vod.susercontent.com/api/v4/11110133/mms/th-11110133-6v8gr-mnk5stpewv7pcc.default.mp4';
const CONV_ID = '829371534619069559';
const BASE_URL = process.env.BASE_URL || 'http://localhost:8123';

async function run() {
  console.log('downloading sample video...');
  const res = await fetch(SAMPLE_VIDEO_URL);
  const buffer = Buffer.from(await res.arrayBuffer());
  const b64 = `data:video/mp4;base64,${buffer.toString('base64')}`;
  console.log('downloaded', buffer.length, 'bytes, calling live endpoint...');

  const r = await fetch(`${BASE_URL}/api/conversations/${CONV_ID}/send-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_data: b64 }),
  });
  const data = await r.json();
  console.log('status:', r.status);
  console.log('response:', JSON.stringify(data, null, 2));
}

run();
