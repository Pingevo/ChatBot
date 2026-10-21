// Node module customization hooks for test-testchat-client-boundary.ts
//
// ⚡ redirect เฉพาะ leaf dependencies:
//      react/jsx-runtime (component mount shim), next/link, lucide icons,
//      ui components (Toast/Button/...), services, apiClient
//    TestChatClient เองตั้งใจไม่ redirect — send/dispatchAndRender/
//    flushBuffer/historyRef/persistence logic ทำงานจริง ผ่าน stubbed fetch

const MOCK_URL = new URL("./test-testchat-client-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/node_modules/react/index.",
  "/react/jsx-runtime.",
  "/react/jsx-dev-runtime.",
  "/react/cjs/",
  "/node_modules/next/link.",
  "/lucide-react/",
  "/src/components/ui/PlatformIcon.",
  "/src/components/ui/Button.",
  "/src/components/ui/Loading.",
  "/src/components/ui/Badge.",
  "/src/components/ui/Toast.",
  "/src/components/ui/ConfirmDialog.",
  "/src/components/ui/ImageViewer.",
  "/src/components/shadow/RateBox.",
  "/src/components/shadow/DateBanner.",
  "/src/lib/services.",
  "/src/lib/apiClient.",
];

function isTarget(url) {
  return TARGETS.some((t) => url.includes(t));
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (isTarget(resolved.url)) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
