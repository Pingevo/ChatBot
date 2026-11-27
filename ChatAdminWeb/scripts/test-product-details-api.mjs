import assert from "node:assert/strict";
import Module from "node:module";
import { NextRequest } from "next/server";

let authAllowed = true;
const state = { calls: [], product: { item_id: 123, description: "รายละเอียดสินค้า" } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith("products/[platform]/[itemId]/route.ts")) {
    if (request === "@/backend/middleware/authorize") {
      return { requireAuth: async () => authAllowed ? { ok: true } : { ok: false, response: Response.json({ detail: "unauthorized" }, { status: 401 }) } };
    }
    if (request === "@/backend/lib/http") {
      return {
        json: (body, status = 200) => Response.json(body, { status }),
        error: (detail, status = 400) => Response.json({ detail }, { status }),
      };
    }
    if (request === "@/backend/service/productService") {
      return {
        productService: {
          getProductDetails: async (args) => { state.calls.push(args); return state.product; },
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { GET } = await import("../src/app/api/products/[platform]/[itemId]/route.ts");
const call = (platform, itemId) => GET(
  new NextRequest(`http://localhost/api/products/${platform}/${encodeURIComponent(itemId)}`),
  { params: Promise.resolve({ platform, itemId }) },
);

const ok = await call("shopee", "123");
assert.equal(ok.status, 200, "authenticated detail lookup succeeds");
assert.deepEqual(await ok.json(), { product: state.product });
assert.deepEqual(state.calls[0], { platform: "shopee", itemId: "123" });

const callsBeforeInvalid = state.calls.length;
const invalidPlatform = await call("unknown", "123");
assert.equal(invalidPlatform.status, 422, "unknown platforms are rejected");
assert.equal(state.calls.length, callsBeforeInvalid, "invalid platform never reaches the catalog service");

state.product = null;
const missingProduct = await call("shopee", "not-found");
assert.equal(missingProduct.status, 404, "missing catalog products return not found");
state.product = { item_id: 123, description: "รายละเอียดสินค้า" };

const callsBeforeUnauthorized = state.calls.length;
authAllowed = false;
const unauthorized = await call("shopee", "123");
assert.equal(unauthorized.status, 401, "product details require an authenticated admin");
assert.equal(state.calls.length, callsBeforeUnauthorized, "unauthenticated requests do not read the catalog");

console.log("Product detail API behavior: auth, validation, and read scope passed");
