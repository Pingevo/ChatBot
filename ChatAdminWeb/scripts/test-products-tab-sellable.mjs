import assert from "node:assert/strict";
import Module from "node:module";

const rows = [
  { itemid: "active", item_status: "NORMAL", total_stock: 4 },
  { itemid: "zero", item_status: "NORMAL", total_stock: 0 },
  { itemid: "unlisted", item_status: "UNLIST", total_stock: 12 },
  { itemid: "variant", item_status: "NORMAL", total_stock: 0, model: [
    { model_status: "MODEL_NORMAL", stock_info_v2: { summary_info: { total_available_stock: 3 } } },
    { model_status: "MODEL_UNLIST", stock_info_v2: { summary_info: { total_available_stock: 9 } } },
  ] },
  { itemid: "legacy", item_status: "NORMAL", stock: 2 },
  { itemid: "unknown", item_status: "NORMAL" },
  { itemid: "summary-zero", item_status: "NORMAL", stock: 8, stock_info_v2: { summary_info: { total_available_stock: 0 } } },
];

const fakeCollection = {
  find() {
    let skip = 0;
    let limit = rows.length;
    const cursor = {
      skip(value) { skip = value; return cursor; },
      limit(value) { limit = value; return cursor; },
      project() { return cursor; },
      async toArray() { return structuredClone(rows).slice(skip, skip + limit); },
    };
    return cursor;
  },
  async countDocuments() { return rows.length; },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith("productService.ts") && request === "../db/dbWalletClient") {
    return { getDbWalletCollection: async () => fakeCollection };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { productService } = await import("../src/backend/service/productService.ts");
const result = await productService.listProducts({ platform: "shopee", limit: 1, skip: 1 });
assert.equal(result.total, 3, "only active products with known positive stock count as sellable");
assert.deepEqual(result.products.map((product) => product.itemid), ["variant"], "filter sellable stock before pagination");

console.log("Products tab sellability: 1 pagination case passed");
