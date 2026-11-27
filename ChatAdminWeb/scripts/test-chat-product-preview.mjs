import assert from "node:assert/strict";
import Module from "node:module";
import React from "react";

let hookState = [];
let hookIndex = 0;
const beginRender = () => { hookIndex = 0; };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith("MessageContent.tsx") && request === "@/components/ui/ImageViewer") {
    return { imageViewer: { show() {} } };
  }
  if (parent?.filename?.endsWith("MessageContent.tsx") && request === "react") {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      useState(initial) {
        const index = hookIndex++;
        if (!(index in hookState)) hookState[index] = initial;
        return [hookState[index], (next) => { hookState[index] = typeof next === "function" ? next(hookState[index]) : next; }];
      },
    };
  }
  if (parent?.filename?.endsWith("InfoTab.tsx") && request === "react") {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      useState(initial) {
        const index = hookIndex++;
        if (!(index in hookState)) hookState[index] = initial;
        return [hookState[index], (next) => { hookState[index] = typeof next === "function" ? next(hookState[index]) : next; }];
      },
    };
  }
  if (parent?.filename?.endsWith("ProductsTab.tsx") && request === "react") {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      useState(initial) {
        const index = hookIndex++;
        if (!(index in hookState)) hookState[index] = initial;
        return [hookState[index], (next) => { hookState[index] = typeof next === "function" ? next(hookState[index]) : next; }];
      },
      useEffect() {},
      useCallback(callback) { return callback; },
    };
  }
  if (parent?.filename?.endsWith("InfoTab.tsx")) {
    const infoTabMocks = {
      "@/components/ui/PlatformIcon": { PlatformIcon: () => null },
      "@/components/ui/Badge": { Badge: () => null },
      "@/components/ui/Button": { Button: () => null },
      "@/components/ui/ConfirmDialog": { confirm: async () => true },
      "@/lib/bubbleColors": { ZAAPI_COLOR: "", BOT_COLOR: "", ADMIN_COLOR: "" },
    };
    if (infoTabMocks[request]) return infoTabMocks[request];
  }
  if (parent?.filename?.endsWith("ProductsTab.tsx")) {
    const productsTabMocks = {
      "@/components/ui/PlatformIcon": { PlatformIcon: () => null },
      "@/components/ui/Pagination": { Pagination: () => null },
      "@/lib/apiClient": { api: () => ({ get: async () => ({ data: { products: [], total: 0 } }) }) },
    };
    if (productsTabMocks[request]) return productsTabMocks[request];
  }
  if (parent?.filename?.endsWith("ProductDetailsModal.tsx") && request === "react") {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      useState(initial) {
        const index = hookIndex++;
        if (!(index in hookState)) hookState[index] = initial;
        return [hookState[index], (next) => { hookState[index] = typeof next === "function" ? next(hookState[index]) : next; }];
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { MessageContent } = await import("../src/components/chat/MessageContent.tsx");
const { InfoTab } = await import("../src/components/chat/InfoTab.tsx");
const { ProductsTab } = await import("../src/components/chat/ProductsTab.tsx");
const { ProductDetailsModalView } = await import("../src/components/chat/ProductDetailsModal.tsx");

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

function findAll(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, matches);
    return matches;
  }
  if (!React.isValidElement(node)) return matches;
  if (predicate(node)) matches.push(node);
  findAll(node.props?.children, predicate, matches);
  return matches;
}

const product = {
  item_id: "123456789",
  name: "ตัวอย่างสินค้า",
  price: 990,
  image: "https://cf.shopee.co.th/file/example",
  shop: "ร้านตัวอย่าง",
  url: "https://shopee.co.th/product/456/123456789",
  platform: "shopee",
};
const msg = { message_type: "item", text: "(สินค้า)", products: [product] };
const messageTree = MessageContent({ msg, variant: "user" });
const card = findElement(messageTree, (element) => typeof element.type === "function" && element.type.name === "ProductCardView");
assert.ok(card, "item messages render their real product card");
beginRender();
const cardTree = card.type(card.props);
const cardButton = findElement(cardTree, (element) => element.type === "button");
assert.ok(cardButton, "clicking an item card opens an in-page product modal");
cardButton.props.onClick();
beginRender();
const openedCardTree = card.type(card.props);
const chatModal = findElement(openedCardTree, (element) => typeof element.type === "function" && element.type.name === "ProductDetailsModal");
assert.equal(chatModal?.props.product.item_id, product.item_id);
assert.equal(chatModal?.props.platform, "shopee");
assert.equal(findElement(openedCardTree, (element) => element.type === "iframe"), null, "product details do not depend on Shopee iframe access");

hookState = [];
beginRender();
const infoTree = InfoTab({
  conversation: {
    id: "conv-1", platform: "shopee", shop_id: "456", shop_name: "ร้านตัวอย่าง",
    customer_id: "789", customer_name: "ลูกค้า", status: "open", last_timestamp: new Date().toISOString(),
  },
  messages: [{ ...msg, id: "msg-1", role: "user", timestamp: new Date().toISOString() }],
  closeHistory: [],
});
const infoCard = findElement(infoTree, (element) => element.type === "button" && element.props["aria-label"] === `ดูข้อมูลสินค้า ${product.name}`);
assert.ok(infoCard, "InfoTab product cards are clickable in the same page");
infoCard.props.onClick();
beginRender();
const openedInfoTree = InfoTab({
  conversation: {
    id: "conv-1", platform: "shopee", shop_id: "456", shop_name: "ร้านตัวอย่าง",
    customer_id: "789", customer_name: "ลูกค้า", status: "open", last_timestamp: new Date().toISOString(),
  },
  messages: [{ ...msg, id: "msg-1", role: "user", timestamp: new Date().toISOString() }],
  closeHistory: [],
});
const infoModal = findElement(openedInfoTree, (element) => typeof element.type === "function" && element.type.name === "ProductDetailsModal");
assert.equal(infoModal?.props.product.item_id, product.item_id);
assert.equal(infoModal?.props.platform, "shopee", "InfoTab uses the selected conversation platform");

const loadedModal = ProductDetailsModalView({
  product,
  platform: "shopee",
  details: {
    description: "รายละเอียดสินค้าแบบเลื่อนอ่านได้",
    brand: "แบรนด์ตัวอย่าง",
    cat_name: "อุปกรณ์เสริม",
    total_stock: 12,
    model: [{ model_id: 1, model_name: "สีดำ" }],
  },
  loading: false,
  error: null,
  onClose() {},
});
const dialog = findElement(loadedModal, (element) => element.props.role === "dialog");
assert.ok(dialog, "product information opens in an accessible dialog");
assert.ok(findElement(loadedModal, (element) => element.type === "div" && element.props.className?.includes("overflow-y-auto")), "product information body scrolls inside the modal");
assert.ok(findElement(loadedModal, (element) => element.type === "p" && element.props.children === "รายละเอียดสินค้าแบบเลื่อนอ่านได้"), "modal shows the catalog description");
assert.ok(findElement(loadedModal, (element) => element.type === "dd" && element.props.children === "แบรนด์ตัวอย่าง"), "modal shows product attributes");
assert.ok(findElement(loadedModal, (element) => element.type === "div" && element.props.children === "สีดำ"), "modal shows product variations");
const detailClose = findElement(loadedModal, (element) => element.type === "button" && element.props["aria-label"] === "ปิดรายละเอียดสินค้า");
assert.ok(detailClose, "modal exposes an accessible close button");

const catalogProduct = {
  itemid: "20716749362",
  name: "iSuper Evo Buds Gaming Edition",
  price: 1190,
  images: { image_url_list: ["https://cf.shopee.co.th/file/product-image"] },
  shopname: "SuperITMall",
};
const catalogConversation = {
  id: "conv-catalog", platform: "shopee", shop_id: "456", shop_name: "SuperITMall",
  customer_id: "789", customer_name: "ลูกค้า", status: "open",
  last_timestamp: new Date().toISOString(),
};
const sentProducts = [];
const catalogProps = { conversation: catalogConversation, onSendProduct: (item) => sentProducts.push(item) };
function renderCatalog() {
  beginRender();
  return ProductsTab(catalogProps);
}

hookState = [[catalogProduct], 1, 1, false, null, "", "products"];
const catalogTree = renderCatalog();
const catalogCard = findElement(catalogTree, (element) =>
  element.type === "button" && element.props["aria-label"] === `ดูข้อมูลสินค้า ${catalogProduct.name}`
);
assert.ok(catalogCard, "Info panel catalog cards open the same in-page details modal");
catalogCard.props.onClick();
const openedCatalog = renderCatalog();
const catalogModal = findElement(openedCatalog, (element) =>
  typeof element.type === "function" && element.type.name === "ProductDetailsModal"
);
assert.equal(catalogModal?.props.product.item_id, catalogProduct.itemid);
assert.equal(catalogModal?.props.platform, "shopee");
const sendButton = findElement(openedCatalog, (element) =>
  element.type === "button" && element.props["aria-label"] === "ส่งสินค้าเข้าแชท"
);
assert.ok(sendButton, "the send control remains separate from product preview");
sendButton.props.onClick();
assert.deepEqual(sentProducts, [catalogProduct], "the send control keeps its existing action");
assert.equal(findElement(renderCatalog(), (element) =>
  typeof element.type === "function" && element.type.name === "ProductDetailsModal"
)?.props.product.item_id, catalogProduct.itemid, "sending does not alter the selected product preview");

console.log("Product details behavior: message card, InfoTab, catalog card, modal content, and scrolling passed");
