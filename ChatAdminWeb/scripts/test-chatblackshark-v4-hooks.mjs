const mongo = new URL("./test-chatblackshark-v4-mongo.mjs", import.meta.url).href;
const config = new URL("./test-chatblackshark-v4-config.mjs", import.meta.url).href;
const persona = new URL("./test-chatblackshark-v4-persona.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("/src/backend/db/mongoClient.")) return { url: mongo, shortCircuit: true };
  if (resolved.url.includes("/src/backend/service/systemConfigService.")) return { url: config, shortCircuit: true };
  if (resolved.url.includes("/src/backend/service/personaService.")) return { url: persona, shortCircuit: true };
  return resolved;
}
