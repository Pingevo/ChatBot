const MOCK_URL = new URL("./test-catalog-shop-service-db.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("/backend/db/dbWalletClient.")
      || resolved.url.includes("/backend/middleware/authorize.")
      || resolved.url.includes("/backend/lib/http.")) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}

