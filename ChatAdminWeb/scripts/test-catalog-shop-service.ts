import { register } from "node:module";
register(new URL("./test-catalog-shop-service-hooks.mjs", import.meta.url));

async function main() {
  const { productService } = await import("../src/backend/service/productService");
  const db = await import("./test-catalog-shop-service-db.mjs");
  const shops = await productService.listCatalogShopNames("shopee");

  if (JSON.stringify(shops) !== JSON.stringify(["Alpha Shop", "Black Shark", "Zulu Shop"])) {
    throw new Error(`catalog names must be sorted with source casing preserved: ${JSON.stringify(shops)}`);
  }
  if (JSON.stringify(db.calls) !== JSON.stringify([{ name: "ShpProducts", field: "shopname" }])) {
    throw new Error(`expected read-only ShpProducts distinct(shopname), got ${JSON.stringify(db.calls)}`);
  }

  db.calls.length = 0;
  const route = await import("../src/app/api/catalog/shops/route");
  const ok = await route.GET(new Request("http://admin.test/api/catalog/shops") as any);
  const body = await ok.json() as { shops: string[] };
  if (ok.status !== 200 || JSON.stringify(body.shops) !== JSON.stringify(shops)) {
    throw new Error(`catalog route response changed: ${JSON.stringify(body)}`);
  }
  if (JSON.stringify(db.calls) !== JSON.stringify([{ name: "ShpProducts", field: "shopname" }])) {
    throw new Error(`catalog route did not use product DB: ${JSON.stringify(db.calls)}`);
  }
  db.calls.length = 0;
  const invalid = await route.GET(new Request("http://admin.test/api/catalog/shops?platform=facebook") as any);
  if (invalid.status !== 400 || db.calls.length !== 0) throw new Error("invalid platform must fail before DB read");
  db.setAuthAllowed(false);
  const unauthenticated = await route.GET(new Request("http://admin.test/api/catalog/shops") as any);
  db.setAuthAllowed(true);
  if (unauthenticated.status !== 401 || db.calls.length !== 0) throw new Error("catalog route must require auth");

  console.log("PASS authenticated catalog route returns read-only product DB shop names with legacy ordering/casing");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
