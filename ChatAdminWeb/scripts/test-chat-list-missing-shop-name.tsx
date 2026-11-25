import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatList } from "../src/components/chat/ChatList";
import type { Conversation } from "../src/lib/types";

const conversation = {
  id: "conv_1",
  shop_id: "shop_1",
  shop_name: undefined,
  platform: "shopee",
  customer_name: "Customer",
  last_message: "Hello",
  last_timestamp: new Date().toISOString(),
  unread: 0,
  status: "bot",
} as unknown as Conversation;

const html = renderToStaticMarkup(createElement(ChatList, {
  conversations: [conversation],
  selectedId: null,
  onSelect: () => {},
}));
assert.match(html, /mobile-chat-shop[^>]*>shop_1<\/div>/);
const namedHtml = renderToStaticMarkup(createElement(ChatList, {
  conversations: [{ ...conversation, shop_name: "Known Shop" }],
  selectedId: null,
  onSelect: () => {},
}));
assert.match(namedHtml, /mobile-chat-shop[^>]*>Known Shop<\/div>/);
console.log("PASS ChatList renders mirrored conversation without shop_name");
