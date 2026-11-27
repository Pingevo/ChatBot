import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InfoTab } from "../src/components/chat/InfoTab";
import type { Conversation } from "../src/lib/types";

const conversation = {
  id: "shp_1291688536173000149",
  customer_id: "customer-1",
  customer_name: "ลูกค้า",
  status: "open",
  assigned_to: "admin-1",
  assigned_to_name: "Bovonsan Lidjeen (Bank)",
  platform: "shopee",
  shop_id: "shop-1",
  shop_name: "BlackShark",
  item_ids: [],
} as unknown as Conversation;

const html = renderToStaticMarkup(createElement(InfoTab, {
  conversation,
  messages: [],
  closeHistory: [],
}));

if (!html.includes("แอดมินรับผิดชอบ")) {
  throw new Error("InfoTab should render the responsible-admin label correctly");
}
if (!html.includes("Bovonsan Lidjeen (Bank)")) {
  throw new Error("InfoTab should show the assigned admin name");
}

console.log("PASS InfoTab responsible-admin label and value");
