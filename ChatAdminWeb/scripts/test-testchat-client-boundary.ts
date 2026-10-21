// test-testchat-client-boundary.ts — Phase 10B Test Chat failure-boundary contracts
//
// รัน: npx tsx scripts/test-testchat-client-boundary.ts
//
// ขับ REAL TestChatClient ผ่าน loader-hook stubs (react/jsx-runtime/ui/services
//   เท่านั้นที่ถูกแทน) — send/dispatchAndRender/historyRef/persistence ทำงานจริง
//   บน stubbed fetch; JSX output เป็น object tree (ไม่ mount DOM)
//
// ตรึง contracts (live canary defects ที่ต้อง fail ก่อนแก้):
//   A. send โดยไม่เลือก session → reject ก่อน mutation ใดๆ + toast ไทย
//   B. non-2xx dispatch → render detail/error จริง ไม่ใช่ "(ไม่มีคำตอบ)"
//   C. failed direct turn ต้องไม่เข้า historyRef/session persist
//   D. retry หลัง 500 ไม่ทำคำถามซ้ำใน history
//   E. terminal dispatch persist user+model ครั้งเดียว
//
// RED-honest: ทุกเคส fail บนโค้ดปัจจุบัน (ไม่มี session guard / res.ok ถูกเมิน /
//   direct user commit ก่อน dispatch)

import { register } from "node:module";
register(new URL("./test-testchat-client-hooks.mjs", import.meta.url));

// DOM globals เฉพาะที่ send path แตะ (text-only → window เท่านั้น)
(globalThis as any).window = { location: { origin: "http://test.local" } };

// ─── fetch stub ─────────────────────────────────────────────────────────
type FetchCall = { url: string; method: string; body: any };
const fetchLog: FetchCall[] = [];
type Res = { status: number; body: any };
let dispatchResponder: Res = { status: 200, body: { status: "bot_answered", answer: "ok" } };

(globalThis as any).fetch = async (url: string, init?: any): Promise<any> => {
  const u = String(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  fetchLog.push({ url: u, method: init?.method || "GET", body });

  let r: Res;
  if (u.endsWith("/api/test-chat/dispatch")) {
    r = dispatchResponder;
  } else if (u.includes("/test-chat/sessions?")) {
    r = { status: 200, body: { sessions: [{ id: "sess_1", shop: "SuperITMall", title: "canary", message_count: 0 }] } };
  } else if (u.endsWith("/test-chat/sessions/sess_1")) {
    r = { status: 200, body: { id: "sess_1", shop: "SuperITMall", status: "open", messages: [], assigned_to: null } };
  } else if (u.endsWith("/messages")) {
    r = { status: 200, body: { ok: true } };
  } else if (u.endsWith("/api/test-chat/buffer-status")) {
    r = { status: 200, body: { enabled: false, window_ms: 100, max_messages: 5 } };
  } else if (u.endsWith("/api/chatbot/shops")) {
    r = { status: 200, body: { shops: ["SuperITMall"] } };
  } else {
    r = { status: 200, body: {} };
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};

const dispatchCalls = () => fetchLog.filter((c) => c.url.endsWith("/api/test-chat/dispatch"));
const persistCalls = () => fetchLog.filter((c) => c.url.endsWith("/messages") && c.method === "POST");
const flush = () => new Promise((r) => setTimeout(r, 40));

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function main() {
// ─── harness ────────────────────────────────────────────────────────────
const mocks = await import("./test-testchat-client-mocks.mjs");
const { TestChatClient } = await import("../src/components/chat/TestChatClient");

function render() {
  (mocks as any).__beginRender();
  return (TestChatClient as any)({ platform: "shopee" });
}
function* walk(node: any): Generator<any> {
  if (!node || typeof node !== "object") return;
  yield node;
  const ch = node.props?.children;
  for (const c of Array.isArray(ch) ? ch : [ch]) yield* walk(c);
}
function findAll(root: any, pred: (n: any) => boolean): any[] {
  const out: any[] = [];
  for (const n of walk(root)) if (pred(n)) out.push(n);
  return out;
}
const cells = () => (mocks as any).__cells();
const historyRef = () => cells().filter((c: any) => c.kind === "ref")[0];
const messagesState = () => cells().filter((c: any) => c.kind === "state")[0].value;

async function mount() {
  (mocks as any).__reset();
  fetchLog.length = 0;
  (mocks as any).__toastLog.length = 0;
  render();
  // run mount effects (loadShops/loadSessions/buffer-status/etc.) — real fns
  for (const c of cells()) if (c.kind === "effect") await c.fn();
  await flush();
}
async function selectSession() {
  const tree = render();
  const row = findAll(tree, (n) => n.props?.role === "button" && n.props?.tabIndex === 0 && typeof n.props.onClick === "function")[0];
  row.props.onClick({});
  await flush();
}
async function typeAndSend(text: string) {
  let tree = render();
  findAll(tree, (n) => n.type === "textarea")[0]
    .props.onChange({ target: { value: text, style: {}, scrollHeight: 10 } });
  tree = render();
  findAll(tree, (n) => n.type === "textarea")[0]
    .props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault() {} });
  await flush();
}
const toasts = () => (mocks as any).__toastLog as [string, string][];

// ─── A. no-session send → zero mutation ─────────────────────────────────
console.log("\n[A] send โดยไม่เลือก session — reject ก่อน mutation ใดๆ");
await mount();                       // no session selected
await typeAndSend("คำถามทดสอบ");
check("dispatch request = 0", dispatchCalls().length === 0,
  `got ${dispatchCalls().length}`);
check("persist POST = 0", persistCalls().length === 0,
  `got ${persistCalls().length}`);
check("historyRef ว่าง", historyRef().current.length === 0,
  `got ${JSON.stringify(historyRef().current)}`);
check("ไม่มี user bubble ใน messages",
  messagesState().every((m: any) => m.role !== "user"));
check("toast เตือนให้สร้าง/เลือกแชท (ไทย)",
  toasts().some(([, m]) => /เลือกแชท|สร้างแชท|เลือก conversation/i.test(m)),
  `toasts=${JSON.stringify(toasts())}`);

// ─── B. non-2xx → render actual detail/error ────────────────────────────
console.log("\n[B] non-2xx dispatch → render detail/error จริง");
await mount();
await selectSession();
dispatchResponder = { status: 422, body: { detail: "session_id is required" } };
await typeAndSend("รุ่น IMILAB W01 เชื่อมต่อกับ Strava ได้ไหม");
const html422 = messagesState().map((m: any) => m.html || "").join("\n");
check("422 → แสดง detail จริง", html422.includes("session_id is required"),
  `html=${html422.slice(0, 200)}`);
check("422 → ไม่ render (ไม่มีคำตอบ)", !html422.includes("(ไม่มีคำตอบ)"));

await mount();
await selectSession();
dispatchResponder = { status: 500, body: { status: "bot_error", error: "NameError: snap" } };
await typeAndSend("คำถามที่สอง");
const html500 = messagesState().map((m: any) => m.html || "").join("\n");
check("500 → แสดง error จริง", html500.includes("NameError: snap"),
  `html=${html500.slice(0, 200)}`);
check("500 → ไม่ render (ไม่มีคำตอบ)", !html500.includes("(ไม่มีคำตอบ)"));

// ─── C. failed direct turn ต้องไม่เข้า history/persist ──────────────────
console.log("\n[C] failed direct turn → ไม่เข้า historyRef/session persist");
await mount();
await selectSession();
dispatchResponder = { status: 500, body: { status: "bot_error", error: "boom" } };
await typeAndSend("คำถามที่ล้มเหลว");
check("historyRef ว่างหลัง 500", historyRef().current.length === 0,
  `got ${JSON.stringify(historyRef().current)}`);
check("persist POST = 0 หลัง 500", persistCalls().length === 0,
  `got ${persistCalls().length}`);

// ─── D. retry หลัง 500 → คำถามไม่ซ้ำ ────────────────────────────────────
console.log("\n[D] retry หลัง 500 → dispatch body มีคำถามครั้งเดียว");
dispatchResponder = { status: 200, body: { status: "bot_answered", answer: "ตอบแล้ว" } };
await typeAndSend("คำถามที่ล้มเหลว");
const retryBody = dispatchCalls().at(-1)?.body;
const retryHist = (retryBody?.history || []).filter((h: any) => h.role === "user");
check("retry history ไม่มีคำถามซ้ำ", retryHist.length === 0,
  `history=${JSON.stringify(retryBody?.history)}`);
check("historyRef = [user,model] ครั้งเดียว",
  historyRef().current.length === 2
    && historyRef().current[0].role === "user"
    && historyRef().current[1].role === "model",
  `got ${JSON.stringify(historyRef().current)}`);

// ─── E. terminal dispatch persist user+model ครั้งเดียว ────────────────
console.log("\n[E] successful dispatch → persist user+model exactly once");
const per = persistCalls();
check("persist POST = 2 (user+model)", per.length === 2,
  `got ${per.length}`);
check("persist[0] = user turn", per[0]?.body?.message?.role === "user"
  && per[0]?.body?.message?.text === "คำถามที่ล้มเหลว");
check("persist[1] = model turn", per[1]?.body?.message?.role === "model"
  && per[1]?.body?.message?.text === "ตอบแล้ว");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
}
main();
