import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { createFakeMongo, COLLECTIONS } from "./test-botworker-fakemongo.mjs";

async function main() {
  const state = { uniqueKeys: {} as Record<string, string[]> };
  const fm = createFakeMongo(state);
  const collections = new Proxy(COLLECTIONS as Record<string, string>, {
    get: (target, key: string) => target[key] ?? key,
  });
  const db = {
    collection(name: string) {
      return Object.assign(new fm.FakeCollection(name), {
        async indexes() { return []; },
        async dropIndex() {},
        async createIndex(spec: Record<string, number>, opts?: { unique?: boolean }) {
          if (opts?.unique) {
            (state.uniqueKeys[name] ??= []).push(Object.keys(spec).join("+"));
          }
          return Object.keys(spec).join("_");
        },
      });
    },
  };
  const messages = [
    { message_id: "inbound_1", role: "user", direction: "in", text: "question", created_timestamp: new Date(1000) },
  ];
  Object.assign(globalThis, {
    __R4_INDEX_TEST: db,
    __SHADOW_TEST: {
      serverConfig: { mongoUri: "unused", mongoDbName: "fake", collections },
      listMessages: async () => messages,
      getHistoryForBot: async () => [],
      toBotText: (m: { text: string }) => m.text,
      toBotImages: () => [],
      getConversation: async () => ({ conversation_id: "conv_1", platform: "shopee", shop_id: "shop_1" }),
      logAdminEvent: async () => {},
    },
  });
  const leafMock = new URL("./test-shadow-batch-isolation-mocks.mjs", import.meta.url).href;
  const driverMock = `data:text/javascript,${encodeURIComponent(`
    export class MongoClient {
      async connect() { return this; }
      db() { return globalThis.__R4_INDEX_TEST; }
    }
  `)}`;
  const hooks = Reflect.get(nodeModule, "registerHooks")({
    resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => { url: string }) {
      if (specifier === "mongodb" && context.parentURL?.includes("/db/mongoClient.")) {
        return { url: driverMock, shortCircuit: true };
      }
      const resolved = nextResolve(specifier, context);
      if (["/lib/config.", "/service/messageService.", "/service/conversationService.", "/service/adminLogService."]
        .some((path) => resolved.url.includes(path))) {
        return { url: leafMock, shortCircuit: true };
      }
      return resolved;
    },
    load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
      if (url === driverMock) {
        return { format: "module", source: decodeURIComponent(url.slice(url.indexOf(",") + 1)), shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in index contract test"); };
  try {
    const mongo = await import("../src/backend/db/mongoClient");
    const shadow = await import("../src/backend/service/shadowReplyService");
    await mongo.ensureIndexes();
    const opts = { conversationId: "conv_1", botCaller: async () => ({ answer: "same answer", source: "test" }) };
    const first = await shadow.generateConversationShadowReplies(opts);
    const second = await shadow.generateConversationShadowReplies(opts);
    assert.notEqual(first[0].generation_batch_id, second[0].generation_batch_id);
    assert.equal(fm.fakeColl("shadow_replies").length, 2);
    console.log("PASS actual ensureIndexes permits two manual generation batches for one inbound");

    await shadow.generateShadowReply(opts);
    await shadow.generateShadowReply(opts);
    assert.equal(fm.fakeColl("shadow_replies").length, 4);
    console.log("PASS repeated single-message generation preserves history");

    const replies = await mongo.getCollection("shadow_replies");
    const worker = { _id: "botworker:reply:batch_1", shadow_reply_id: "botworker:reply:batch_1", inbound_message_id: "inbound_1", origin: "worker" };
    await replies.insertOne(worker as never);
    await assert.rejects(replies.insertOne(worker as never), (e: unknown) => (e as { code: number }).code === 11000);
    assert.equal(fm.fakeColl("shadow_replies").length, 5);
    console.log("PASS worker and manual replies coexist; native _id still rejects replay");

    const buffer = await mongo.getCollection("buffer_messages");
    await buffer.insertOne({ message_id: "buffer_1" });
    await assert.rejects(buffer.insertOne({ message_id: "buffer_1" }), (e: unknown) => (e as { code: number }).code === 11000);
    console.log("PASS buffer message uniqueness remains enforced");
  } finally {
    globalThis.fetch = originalFetch;
    hooks.deregister();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
