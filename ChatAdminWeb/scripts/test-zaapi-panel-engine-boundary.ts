import { register } from "node:module";
register(new URL("./test-zaapi-panel-engine-boundary-hooks.mjs", import.meta.url));

const state = { engine: "v4", calls: [] as string[] };
(globalThis as any).__ZAAPI_PANEL_TEST = state;

async function mount(engine: string) {
  state.engine = engine;
  state.calls.length = 0;
  const mocks = await import("./test-zaapi-panel-engine-boundary-mocks.mjs");
  (mocks as any).__resetHooks();
  const { ZaapiKbPanel } = await import("../src/components/knowledge/ZaapiKbPanel");
  const render = () => {
    (mocks as any).__beginRender();
    (ZaapiKbPanel as any)();
    return (mocks as any).__takeEffects() as (() => unknown)[];
  };
  const runEffects = async () => {
    for (const effect of render()) await effect();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await runEffects();
  await runEffects();
}

async function main() {
  await mount("v4");
  if (state.calls.includes("/zaapi-kb/files")) {
    throw new Error(`v4 page requested the Python file list: ${state.calls.join(", ")}`);
  }
  if (!state.calls.includes("/zaapi-kb") || !state.calls.includes("/zaapi-kb/mapping")) {
    throw new Error("v4 page should keep shared KB sources and shop mapping available");
  }

  await mount("legacy");
  if (!state.calls.includes("/zaapi-kb/files")) {
    throw new Error("Python engine should retain the file list feature");
  }

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (() => 1 as any) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    const mocks = await import("./test-zaapi-panel-engine-boundary-mocks.mjs");
    const { GenPendingDot } = await import("../src/components/layout/GenPendingDot");
    async function checkDot(engine: string) {
      state.engine = engine;
      state.calls.length = 0;
      (mocks as any).__resetHooks();
      (mocks as any).__beginRender();
      (GenPendingDot as any)({});
      for (const effect of (mocks as any).__takeEffects() as (() => unknown)[]) await effect();
      return [...state.calls];
    }
    const v4Calls = await checkDot("v4");
    if (v4Calls.includes("/generations/pending?status=pending")) {
      throw new Error("v4 global badge requested Python generation status");
    }
    const legacyCalls = await checkDot("legacy");
    if (!legacyCalls.includes("/generations/pending?status=pending")) {
      throw new Error("legacy global badge should continue polling generation status");
    }
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
  console.log("PASS v4 Zaapi and generation badge avoid Python; legacy retains file/generation requests");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
