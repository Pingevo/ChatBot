// Phase 0D — Shadow Generate-All Batch State Isolation test
// รันด้วย: npx tsx scripts/test-shadow-batch-isolation.ts
//
// พิสูจน์ว่า generateConversationShadowReplies() ส่ง batch-scoped bot state ID
// (`<conversationId>:<generation_batch_id>`) ให้ botCaller แทน conversationId เดิม
// → conversation_products state ไม่ปนข้าม generation batch
//
// เคส:
//   1. turn ทุกตัวใน batch เดียวกันใช้ state ID เดียวกัน + state ID = convId:batchId
//   2. Generate รอบที่สองได้ state ID ใหม่ ≠ รอบแรก (REQUIRED RED→GREEN)
//   3. ShadowReplyDoc ยัง conversation_id=original + generation_batch_id เดียวกันทั้ง batch
//   4. state ID ไม่ขึ้นต้น "shadow:" ที่ service layer (callOurBot เจ้าของ prefix)
//   5. route callOurBot → body.conversation_id มี "shadow:" ครั้งเดียว + simulate_assignment=true
//   6. ไม่มี delete/clear ใดๆ (fake collection ไม่มี delete methods — เรียกแล้ว throw)
//   7. single-message generateShadowReply() ส่ง conversationId เดิม (semantics ไม่เปลี่ยน)
//
// ⚠️ ไม่ต้องเชื่อม MongoDB — leaf modules ถูก redirect ไป mock ผ่าน Node loader hooks

import { register } from "node:module";

// ⚡ ต้อง register ก่อน import service/route — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-shadow-batch-isolation-hooks.mjs", import.meta.url));

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.error(`  ❌ ${label}`);
  }
}

// ── fake data ────────────────────────────────────────────────
const CONV_ID = "shp_testconv_1";
const T0 = new Date("2026-09-30T10:00:00Z").getTime();

const fakeMessages = [
  { message_id: "m1", role: "user", direction: "in", source: "customer", text: "คำถาม 1", created_timestamp: new Date(T0) },
  { message_id: "m2", role: "bot", direction: "out", source: "zaapi", text: "zaapi ตอบ 1", created_timestamp: new Date(T0 + 1000) },
  { message_id: "m3", role: "user", direction: "in", source: "customer", text: "คำถาม 2", created_timestamp: new Date(T0 + 2000) },
  { message_id: "m4", role: "bot", direction: "out", source: "zaapi", text: "zaapi ตอบ 2", created_timestamp: new Date(T0 + 3000) },
];

// ── fake Mongo boundary ──────────────────────────────────────
// insertOne/updateOne/find/aggregate เท่านั้น — ไม่มี delete/drop/updateMany
// ถ้า production เรียก delete/clear จะ throw → test จับได้ทันที
const BANNED_WRITES = new Set(["deleteOne", "deleteMany", "drop", "updateMany", "replaceOne", "bulkWrite", "findOneAndDelete"]);

const insertedDocs: Record<string, unknown>[] = [];
const adminEvents: Record<string, unknown>[] = [];

function fakeCollection(name: string) {
  const coll = {
    docs: [] as Record<string, unknown>[],
    async insertOne(doc: Record<string, unknown>) {
      this.docs.push(doc);
      if (name === "shadow_replies") insertedDocs.push(doc);
      return { insertedId: doc.shadow_reply_id ?? "x" };
    },
    async updateOne() {
      return { modifiedCount: 1 };
    },
    find() {
      const cursor = {
        sort() { return cursor; },
        limit() { return cursor; },
        project() { return cursor; },
        toArray: async () => [],
      };
      return cursor;
    },
    aggregate() {
      return { toArray: async () => [] as unknown[] };
    },
  };
  return new Proxy(coll, {
    get(target, prop) {
      if (typeof prop === "string" && BANNED_WRITES.has(prop)) {
        return () => {
          throw new Error(`BANNED mongo write "${prop}" on ${name} — ห้าม delete/clear ใน generate path`);
        };
      }
      return (target as Record<string, unknown>)[prop as string];
    },
  });
}

// ── globalThis mock state (อ่านโดย mock file) ────────────────
(globalThis as Record<string, unknown>).__SHADOW_TEST = {
  getCollection: async (name: string) => fakeCollection(name),
  listMessages: async () => fakeMessages,
  getHistoryForBot: async () => [] as unknown[],
  toBotText: (m: { text?: string }) => m.text ?? "",
  toBotImages: () => [] as string[],
  getConversation: async (id: string) => ({
    conversation_id: id,
    platform: "shopee",
    shop_id: "shop_test",
    shop_name: "TestShop",
  }),
  logAdminEvent: async (e: Record<string, unknown>) => {
    adminEvents.push(e);
  },
  serverConfig: {
    chatbotBaseUrls: { shopee: "http://127.0.0.1:8010", lazada: "", tiktok: "" },
    chatbotInternalSecret: "test-secret",
  },
  requireAuth: async () => ({ ok: true, ctx: { admin: { admin_id: "adm_test", role: "dev" } } }),
  readJson: async () => ({ conversation_id: CONV_ID }),
};

// ── injected botCaller — จับ conversationId ที่ service ส่ง ──
const botCalls: Record<string, unknown>[] = [];
const botCaller = async (p: Record<string, unknown>) => {
  botCalls.push(p);
  return { answer: `ans-${botCalls.length}`, source: "test" };
};

async function main() {
  // dynamic import หลัง register — mock hooks มีผลกับ module graph นี้
  const svc = await import("../src/backend/service/shadowReplyService");

  console.log("\n=== 1. Generation 1 — batch state isolation ===");

  const docs1 = await svc.generateConversationShadowReplies({
    conversationId: CONV_ID,
    botCaller,
  });

  assert(botCalls.length === 2, `gen1: botCaller ถูกเรียก 2 ครั้ง (ได้ ${botCalls.length})`);

  const state1 = botCalls[0]?.conversationId as string | undefined;
  const batch1 = (docs1 as unknown as { batchId?: string }).batchId;

  assert(
    botCalls.every((c) => c.conversationId === state1),
    "gen1: turn ทุกตัวใน batch ใช้ state ID เดียวกัน",
  );
  assert(typeof batch1 === "string" && batch1.length > 0, `gen1: batchId attach ลง results (${batch1})`);
  assert(
    state1 === `${CONV_ID}:${batch1}`,
    `gen1: state ID = "<convId>:<batchId>" (ได้ "${state1}")`,
  );
  assert(
    !!state1 && !state1.startsWith("shadow:"),
    `gen1: state ID ไม่ขึ้นต้น "shadow:" ที่ service layer (ได้ "${state1}")`,
  );
  assert(
    docs1.length === 2 && docs1.every((d) => d.conversation_id === CONV_ID),
    `gen1: ShadowReplyDoc.conversation_id ยังเป็น original "${CONV_ID}"`,
  );
  assert(
    docs1.every((d) => d.generation_batch_id === batch1),
    "gen1: ShadowReplyDoc.generation_batch_id เดียวกันทั้ง batch",
  );

  console.log("\n=== 2. Generation 2 — fresh state ID (REQUIRED RED→GREEN) ===");

  botCalls.length = 0;
  const docs2 = await svc.generateConversationShadowReplies({
    conversationId: CONV_ID,
    botCaller,
  });

  const state2 = botCalls[0]?.conversationId as string | undefined;
  const batch2 = (docs2 as unknown as { batchId?: string }).batchId;

  assert(
    !!state2 && state2 !== state1,
    `gen2: state ID ใหม่ ≠ gen1 (gen1="${state1}", gen2="${state2}")`,
  );
  assert(
    state2 === `${CONV_ID}:${batch2}`,
    `gen2: state ID = "<convId>:<batchId>" (ได้ "${state2}")`,
  );
  assert(!!batch2 && batch2 !== batch1, `gen2: batchId ≠ gen1 ("${batch2}" vs "${batch1}")`);
  assert(
    docs2.length === 2 && docs2.every((d) => d.conversation_id === CONV_ID),
    "gen2: ShadowReplyDoc.conversation_id ยังเป็น original",
  );

  console.log("\n=== 3. Single-message generate — semantics ไม่เปลี่ยน ===");

  botCalls.length = 0;
  const single = await svc.generateShadowReply({
    conversationId: CONV_ID,
    botCaller,
  });

  assert(botCalls.length === 1, `single: botCaller ถูกเรียก 1 ครั้ง (ได้ ${botCalls.length})`);
  assert(
    botCalls[0]?.conversationId === CONV_ID,
    `single: conversationId ยังเป็น original "${CONV_ID}" (ได้ "${botCalls[0]?.conversationId}")`,
  );
  assert(
    single.conversation_id === CONV_ID && single.origin === "manual",
    "single: doc.conversation_id=original + origin=manual",
  );

  console.log("\n=== 4. Route-level — callOurBot เติม shadow: ครั้งเดียว ===");

  const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return new Response(JSON.stringify({ answer: "route-answer", source: "test" }), { status: 200 });
  }) as typeof fetch;

  try {
    const route = await import("../src/app/api/shadow-inbox/generate-conversation/route");
    const resp = await route.POST(
      new Request("http://localhost/api/shadow-inbox/generate-conversation", { method: "POST" }) as never,
    );
    await resp.text(); // drain SSE stream ให้จบ

    assert(fetchCalls.length === 2, `route: bot ถูกเรียก 2 ครั้งผ่าน callOurBot (ได้ ${fetchCalls.length})`);

    const body1 = fetchCalls[0]?.body ?? {};
    const convIdBody = String(body1.conversation_id ?? "");
    const lastBatch = insertedDocs.at(-1)?.generation_batch_id as string | undefined;

    assert(
      convIdBody.startsWith("shadow:") && convIdBody.indexOf("shadow:", 7) === -1,
      `route: "shadow:" prefix ครั้งเดียวเท่านั้น ไม่เกิด "shadow:shadow:" (ได้ "${convIdBody}")`,
    );
    assert(
      convIdBody === `shadow:${CONV_ID}:${lastBatch}`,
      `route: body.conversation_id = "shadow:<convId>:<batchId>" (ได้ "${convIdBody}")`,
    );
    assert(body1.simulate_assignment === true, "route: simulate_assignment=true คงเดิม");
    assert(body1.shop === "TestShop", `route: body.shop = shop_name (ได้ "${body1.shop}")`);
    assert(fetchCalls[0]?.url === "http://127.0.0.1:8010/chat", `route: url ชี้ bot /chat (ได้ "${fetchCalls[0]?.url}")`);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("\n=== 5. No delete/clear + log metadata ===");
  // ถ้า production เรียก delete/drop/updateMany บน fake collection จะ throw ก่อนถึงจุดนี้
  assert(true, "ไม่มี delete/clear ใน generate path (fake collection ไม่มี delete methods — ผ่านมาได้แปลว่าไม่ถูกเรียก)");
  const genConvLogs = adminEvents.filter((e) => e.action_type === "shadow_reply.generate_conversation");
  // service ใส่ conversation_id ใน metadata; route ใส่ที่ top-level — ทั้งคู่ต้องเป็น original
  assert(
    genConvLogs.length >= 3 &&
      genConvLogs.every(
        (e) => e.conversation_id === CONV_ID || (e.metadata as Record<string, unknown>)?.conversation_id === CONV_ID,
      ),
    `log metadata ใช้ original conversation_id (${genConvLogs.length} events)`,
  );

  console.log(`\n=== สรุป: ${pass} ผ่าน / ${fail} ไม่ผ่าน ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
