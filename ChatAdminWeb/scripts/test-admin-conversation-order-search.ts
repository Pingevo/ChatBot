import { register } from "node:module";

register(new URL("./test-admin-conversation-order-search-hooks.mjs", import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mocks: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let route: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let botworkerRoute: any;

const failures: string[] = [];
let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
  }
}

function reset(
  orderDocs: Record<string, unknown>[] = [],
  options: { omitTargetShopName?: boolean; legacyShopId?: boolean; ambiguousShopMapping?: boolean } = {},
) {
  mocks.resetState();
  const timestamp = new Date("2026-11-20T10:00:00.000Z");
  mocks.fakeColl("conversations").push(
    { conversation_id: "conv_order", platform: "shopee", shop_id: "shop_a", ...(options.omitTargetShopName ? {} : { shop_name: "Shop A" }), customer_id: "12345", to_name: "Nok", last_message_text: "[order]", last_message_timestamp: timestamp, created_at: timestamp, pinned: false },
    { conversation_id: "conv_wrong_shop", platform: "shopee", shop_id: "shop_b", shop_name: "Shop B", customer_id: "12345", to_name: "Nok", last_message_text: "[order]", last_message_timestamp: timestamp, created_at: timestamp, pinned: false },
    { conversation_id: "conv_wrong_buyer", platform: "shopee", shop_id: "shop_a", shop_name: "Shop A", customer_id: "67890", to_name: "Other", last_message_text: "ถามสินค้า", last_message_timestamp: timestamp, created_at: timestamp, pinned: false },
    { conversation_id: "conv_other_platform", platform: "tiktok", shop_id: "shop_a", shop_name: "Shop A", customer_id: "12345", to_name: "Nok", last_message_text: "[order]", last_message_timestamp: timestamp, created_at: timestamp, pinned: false },
  );
  if (options.legacyShopId) {
    mocks.fakeColl("conversations").push(
      { conversation_id: "conv_shop_evidence", platform: "shopee", shop_id: "shop_a", shop_name: "Shop A", customer_id: "99999", to_name: "Evidence", last_message_text: "อื่นๆ", last_message_timestamp: timestamp, created_at: timestamp, pinned: false },
    );
  }
  mocks.fakeColl("status_conversation").push(
    { conversation_id: "conv_order", status: "closed", assigned_to: null },
    { conversation_id: "conv_wrong_shop", status: "closed", assigned_to: null },
    { conversation_id: "conv_wrong_buyer", status: "closed", assigned_to: null },
    { conversation_id: "conv_other_platform", status: "closed", assigned_to: null },
  );
  mocks.fakeColl("shops").push({ platform: "shopee", shop_id: options.legacyShopId ? "Shop A" : "shop_a", shopname: "Shop A" });
  if (options.ambiguousShopMapping) {
    mocks.fakeColl("shops").push({ platform: "shopee", shop_id: "shop_a", shopname: "Shop A" });
  }
  mocks.fakeColl("admins").push({ admin_id: "admin1", name: "Inbox Test", username: "inbox-test" });
  mocks.setOrderDocs(orderDocs);
}

const request = (query: string) => new Request(`http://test.local/api/admin/conversations${query}`) as never;

async function main() {
  mocks = await import("./test-admin-conversation-order-search-mocks.mjs");
  route = await import("../src/app/api/admin/conversations/route");
  botworkerRoute = await import("../src/app/api/botworker/conversations/route");
  const orderSn = "261116FCSAVPNM";

  await test("order_sn resolves the buyer's conversation in the order's shop", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }]);
    route.invalidateConversationsCache();

    const response = await route.GET(request(`?q=${orderSn}&include_count=true&limit=10`));
    equal(response.__status, 200, "HTTP status");
    const ids = response.body.rows.map((row: { id: string }) => row.id);
    assert(ids.includes("conv_order"), "expected the order owner conversation");
    assert(!ids.includes("conv_wrong_shop"), "must exclude the same buyer's other shop");
    assert(!ids.includes("conv_wrong_buyer"), "must exclude another buyer in the same shop");
    assert(!ids.includes("conv_other_platform"), "must exclude a conversation on another platform");
    equal(response.body.total_count, 1, "count uses the same order lookup predicate");
    equal(mocks.state.orderFindOneCalls[0]?.filter.order_sn, orderSn, "order lookup uses exact order_sn");
  });

  await test("order_sn resolves a chat without shop_name through unique transport shop evidence", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }], {
      omitTargetShopName: true,
      legacyShopId: true,
    });
    route.invalidateConversationsCache();

    const response = await route.GET(request(`?q=${orderSn}&include_count=true&limit=10`));
    const ids = response.body.rows.map((row: { id: string }) => row.id);
    assert(ids.includes("conv_order"), "shopname evidence should resolve the target chat's shop_id");
    assert(!ids.includes("conv_wrong_shop"), "must exclude the buyer's other shop");
    assert(!ids.includes("conv_shop_evidence"), "evidence chat is not the order buyer's chat");
    equal(response.body.total_count, 1, "count includes only the order buyer chat");
  });

  await test("order_sn does not guess when shopname maps to multiple shop IDs", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }], {
      legacyShopId: true,
      ambiguousShopMapping: true,
    });
    route.invalidateConversationsCache();

    const response = await route.GET(request(`?q=${orderSn}&include_count=true&limit=10`));
    equal(response.body.rows.length, 0, "ambiguous shop identity fails closed");
  });

  await test("existing customer-name search still works when no order matches", async () => {
    reset([]);
    route.invalidateConversationsCache();

    const response = await route.GET(request("?q=Nok&include_count=true&limit=10"));
    const ids = response.body.rows.map((row: { id: string }) => row.id);
    assert(ids.includes("conv_order"), "existing customer-name search must still return the chat");
    equal(response.body.total_count, 2, "name search count remains consistent");
  });

  await test("Tickets search finds conversations by exact or partial conversation_id", async () => {
    reset([]);
    route.invalidateConversationsCache();

    const exact = await route.GET(request("?q=conv_order&include_count=true&limit=10"));
    const partial = await route.GET(request("?q=conv_ord&include_count=true&limit=10"));
    equal(exact.body.rows.map((row: { id: string }) => row.id).join(","), "conv_order", "full conversation ID match");
    equal(partial.body.rows.map((row: { id: string }) => row.id).join(","), "conv_order", "partial conversation ID match");
    equal(partial.body.total_count, 1, "count uses conversation ID search");
  });

  await test("Tickets search finds chats by exact or partial User ID", async () => {
    reset([]);
    route.invalidateConversationsCache();

    const exact = await route.GET(request("?q=12345&include_count=true&limit=10"));
    const partial = await route.GET(request("?q=2345&include_count=true&limit=10"));
    equal(exact.body.rows.map((row: { id: string }) => row.id).sort().join(","), "conv_order,conv_wrong_shop", "full User ID match respects channel access");
    equal(partial.body.rows.map((row: { id: string }) => row.id).sort().join(","), "conv_order,conv_wrong_shop", "partial User ID match respects channel access");
    equal(partial.body.total_count, 2, "count uses User ID search within channel access");
  });

  await test("existing inbox status filter and pagination apply to order matches", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }]);
    route.invalidateConversationsCache();

    const response = await route.GET(request(`?q=${orderSn}&status=closed&include_count=true&limit=1`));
    equal(response.body.rows.length, 1, "one matching chat is returned on the page");
    equal(response.body.rows[0].id, "conv_order", "status-filtered order match");
    equal(response.body.total_count, 1, "filtered count");
    equal(response.body.has_more, false, "no extra page");
  });

  await test("order lookup failure preserves ordinary text search", async () => {
    reset([]);
    mocks.state.orderError = new Error("order DB unavailable");
    route.invalidateConversationsCache();
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await route.GET(request("?q=Nok&include_count=true&limit=10"));
      assert(response.body.rows.some((row: { id: string }) => row.id === "conv_order"), "ordinary search survives order DB failure");
    } finally {
      console.error = originalError;
    }
  });

  await test("Botworker order_sn search resolves the matching chat within sandbox assignment scope", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }]);
    mocks.fakeColl("test_status_conversation").push(
      { conversation_id: "conv_order", source: "botworker", assigned_to: "admin1" },
      { conversation_id: "conv_wrong_shop", source: "botworker", assigned_to: "admin1" },
    );

    const response = await botworkerRoute.GET(request(`?q=${orderSn}&assigned_to=admin1&include_count=true&limit=10`));
    equal(response.__status, 200, "HTTP status");
    equal(response.body.rows.length, 1, "only matching order chat is returned");
    equal(response.body.rows[0].id, "conv_order", "order owner conversation");
    equal(response.body.total_count, 1, "count includes order match within assignment scope");
    equal(mocks.state.orderFindOneCalls[0]?.filter.order_sn, orderSn, "Botworker uses exact order_sn lookup");
  });

  await test("Botworker search finds conversations by exact or partial conversation_id", async () => {
    reset([]);

    const exact = await botworkerRoute.GET(request("?q=conv_order&include_count=true&limit=10"));
    const partial = await botworkerRoute.GET(request("?q=conv_ord&include_count=true&limit=10"));
    equal(exact.body.rows.map((row: { id: string }) => row.id).join(","), "conv_order", "full conversation ID match");
    equal(partial.body.rows.map((row: { id: string }) => row.id).join(","), "conv_order", "partial conversation ID match");
    equal(partial.body.total_count, 1, "count uses conversation ID search");
  });

  await test("Botworker search finds chats by exact or partial User ID", async () => {
    reset([]);

    const exact = await botworkerRoute.GET(request("?q=12345&include_count=true&limit=10"));
    const partial = await botworkerRoute.GET(request("?q=2345&include_count=true&limit=10"));
    equal(exact.body.rows.map((row: { id: string }) => row.id).sort().join(","), "conv_order,conv_wrong_shop", "full User ID match respects channel access");
    equal(partial.body.rows.map((row: { id: string }) => row.id).sort().join(","), "conv_order,conv_wrong_shop", "partial User ID match respects channel access");
    equal(partial.body.total_count, 2, "count uses User ID search within channel access");
  });

  await test("Botworker shop alias applies the same shop filter as Tickets", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }]);

    const response = await botworkerRoute.GET(request(`?q=${orderSn}&shop=shop_b&include_count=true&limit=10`));
    equal(response.body.rows.length, 0, "shop alias excludes an order conversation from another shop");
    equal(response.body.total_count, 0, "shop-filtered order count");
  });

  await test("Botworker status alias filters the same search and keeps cache results separate", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }]);
    const timestamp = new Date("2026-11-20T10:00:00.000Z");
    mocks.fakeColl("conversations").push({
      conversation_id: "conv_same_buyer_shop", platform: "shopee", shop_id: "shop_a", shop_name: "Shop A",
      customer_id: "12345", to_name: "Nok", last_message_text: "[order]", last_message_timestamp: timestamp,
      created_at: timestamp, pinned: false,
    });
    mocks.fakeColl("test_status_conversation").push(
      { conversation_id: "conv_order", source: "botworker", status: "closed", assigned_to: null },
      { conversation_id: "conv_same_buyer_shop", source: "botworker", status: "bot", assigned_to: null },
    );

    const closed = await botworkerRoute.GET(request(`?q=${orderSn}&status=closed&include_count=true&limit=10`));
    equal(closed.body.rows.length, 1, "status=closed narrows the order search");
    equal(closed.body.rows[0].id, "conv_order", "closed chat returned");
    const bot = await botworkerRoute.GET(request(`?q=${orderSn}&status=bot&include_count=true&limit=10`));
    equal(bot.body.rows.length, 1, "status=bot narrows the same order search");
    equal(bot.body.rows[0].id, "conv_same_buyer_shop", "bot chat returned separately from cached closed result");
  });

  await test("Botworker status filtering treats missing status like Tickets", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }]);
    const timestamp = new Date("2026-11-20T10:00:00.000Z");
    mocks.fakeColl("conversations").push({
      conversation_id: "conv_same_buyer_shop", platform: "shopee", shop_id: "shop_a", shop_name: "Shop A",
      customer_id: "12345", to_name: "Nok", last_message_text: "[order]", last_message_timestamp: timestamp,
      created_at: timestamp, pinned: false,
    });
    mocks.fakeColl("test_status_conversation").push(
      { conversation_id: "conv_order", source: "botworker", assigned_to: "admin1" },
      { conversation_id: "conv_same_buyer_shop", source: "botworker", status: "handoff", assigned_to: "admin1" },
    );

    const bot = await botworkerRoute.GET(request(`?q=${orderSn}&status=bot&include_count=true&limit=10`));
    equal(bot.body.rows.length, 1, "missing status remains Bot-owned even if assigned_to is present");
    equal(bot.body.rows[0].id, "conv_order", "missing-status conversation matches bot filter");
    equal(bot.body.rows[0].status, "bot", "display status uses the same missing-status fallback as Tickets");
    const handoff = await botworkerRoute.GET(request(`?q=${orderSn}&status=handoff&include_count=true&limit=10`));
    equal(handoff.body.rows.length, 1, "handoff requires the same explicit status as Tickets");
    equal(handoff.body.rows[0].id, "conv_same_buyer_shop", "explicit handoff conversation matches");
  });

  await test("Botworker unassigned filter includes conversations with no assigned_to field", async () => {
    reset([{ order_sn: orderSn, buyer_user_id: 12345, shopname: "Shop A" }]);
    mocks.fakeColl("test_status_conversation").push({
      conversation_id: "conv_order", source: "botworker", status: "bot",
    });

    const response = await botworkerRoute.GET(request(`?q=${orderSn}&assigned_to=unassigned&include_count=true&limit=10`));
    equal(response.body.rows.length, 1, "missing assigned_to is unassigned, not excluded");
    equal(response.body.rows[0].id, "conv_order", "unassigned order conversation");
  });

  await test("Botworker cache keeps include_count results separate", async () => {
    reset([]);
    const withoutCount = await botworkerRoute.GET(request("?q=Nok&limit=1"));
    equal(withoutCount.body.total_count, 1, "uncounted response uses page count");
    const withCount = await botworkerRoute.GET(request("?q=Nok&include_count=true&limit=1"));
    equal(withCount.body.total_count, 2, "counted response computes the full filtered count");
  });

  if (failures.length) {
    throw new Error(`${passed} passed, ${failures.length} failed\n${failures.join("\n")}`);
  }
  console.log(`PASS ${passed} inbox order-search behavior cases`);
}

void main();
