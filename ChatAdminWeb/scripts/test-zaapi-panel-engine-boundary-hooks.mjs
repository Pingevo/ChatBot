const MOCK_URL = new URL("./test-zaapi-panel-engine-boundary-mocks.mjs", import.meta.url).href;
const TARGETS = [
  "/node_modules/react/index.",
  "/react/jsx-runtime.",
  "/lucide-react/",
  "/src/components/ui/",
  "/src/components/mobile/",
  "/src/lib/apiClient.",
  "/src/lib/authStore.",
  "/src/lib/roles.",
  "/src/lib/useKeyboardShortcuts.",
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((target) => resolved.url.includes(target))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
