import assert from "node:assert/strict";
import Module from "node:module";

let observed;
const product = { item_id: 123, description: "รายละเอียด", embedding: [1, 2, 3] };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith("productService.ts") && request === "../db/dbWalletClient") {
    return {
      getDbWalletCollection: async () => ({
        find: (filter) => ({
          project: (projection) => ({
            limit: (limit) => ({
              next: async () => { observed = { filter, options: { projection, limit } }; return product; },
            }),
          }),
        }),
      }),
    };
  }
  if (parent?.filename?.endsWith("productService.ts") && request === "../lib/regexEscape") {
    return { safeRegexSearch: (value) => value };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { productService } = await import("../src/backend/service/productService.ts");
assert.equal(typeof productService.getProductDetails, "function", "product service provides a narrow detail lookup");
const result = await productService.getProductDetails({ platform: "shopee", itemId: "123" });
assert.equal(result, product, "product detail lookup returns the matched product record");
assert.deepEqual(observed.filter, {
  $or: [
    { itemid: { $in: ["123", 123] } },
    { item_id: { $in: ["123", 123] } },
  ],
});
assert.equal(observed.options.projection._id, 0, "product detail responses omit Mongo internal IDs");
assert.equal(observed.options.projection.description, 1, "product description is projected for the modal");
assert.equal(observed.options.projection["description_info.extended_description.field_list"], 1, "Shopee block descriptions are projected too");
assert.equal(observed.options.projection["model.model_name"], 1, "variant names are available to admins");
assert.equal(Object.hasOwn(observed.options.projection, "embedding"), false, "large embeddings are not fetched for product detail views");

console.log("Product detail service behavior: scoped lookup and projection passed");
