// Mocks สำหรับ bot-worker.ts enable-checkpoint test
//   BOTWORKER_TEST_SEQ env: {"seq":[0|1,...], "grace":N, "interval_ms":M}
//   - call#1 = bootConfig; ต่อมา cycle ละ 1 call; seq หมด → คืนค่าสุดท้าย
//     นับ grace calls เพิ่มแล้ว SIGINT ตัวเอง (จบ child process)
//   - rising edge (off→on) เพิ่ม synthetic messages: m_gap (created ก่อน enable)
//     + m_post (หลัง enable) — poll spy print found ตาม since จริง

const cfg = JSON.parse(process.env.BOTWORKER_TEST_SEQ || '{"seq":[1],"grace":2,"interval_ms":5}');
const msgs = [];
let callIdx = 0;
let graceSeen = 0;
let prevEnabled = false;
let edge = 0;
let sigintSent = false;

function iso(d) { return d.toISOString(); }

export async function getSystemConfig() {
  const idx = Math.min(callIdx++, cfg.seq.length - 1);
  const enabled = cfg.seq[idx] === 1;
  console.log(`EV CFG enabled=${enabled ? 1 : 0} at=${iso(new Date())}`);
  if (enabled && !prevEnabled) {
    edge++;
    const now = Date.now();
    msgs.push({ id: `m_gap_${edge}`, ts: new Date(now - 500) });
    msgs.push({ id: `m_post_${edge}`, ts: new Date(now + 200) });
    console.log(`EV ENABLE_AT ${iso(new Date(now))} edge=${edge}`);
  }
  prevEnabled = enabled;
  if (callIdx > cfg.seq.length && ++graceSeen === cfg.grace && !sigintSent) {
    sigintSent = true;
    setTimeout(() => process.kill(process.pid, "SIGINT"), 10);
  }
  return {
    bot_worker_enabled: enabled,
    bot_worker_interval_ms: cfg.interval_ms || 5,
    workflow_enabled: false,
  };
}

export const botWorkerService = {
  async pollNewMessages(since) {
    const found = msgs.filter((m) => m.ts > since).map((m) => m.id);
    console.log(`EV POLL since=${iso(since)} found=[${found.join(",")}]`);
    return { found: found.length, processed: 0, results: [] };
  },
  async recoverStaleBuffers() {
    console.log("EV RECOVERY");
    if (cfg.recovery_delay_ms) {
      await new Promise((r) => setTimeout(r, cfg.recovery_delay_ms));
      // inbound ที่เข้าระหว่าง startup recovery — boundary ที่ capture ก่อน recovery เท่านั้นที่จะเห็นมัน
      msgs.push({ id: `m_rec_${Math.max(edge, 1)}`, ts: new Date() });
      console.log(`EV REC_INJECTED at=${iso(new Date())}`);
    }
    return { recovered: 0, conversations: [] };
  },
  clearAllBufferTimers() {},
  clearPendingWork() { console.log("EV CANCEL_PENDING"); },
  async waitForInFlight() {},
};

export const workflowEngine = {
  async checkWaitTimeouts() {
    console.log("EV WAIT_TIMEOUT");
    return 0;
  },
};
