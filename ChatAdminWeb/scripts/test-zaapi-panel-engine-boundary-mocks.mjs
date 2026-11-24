const state = globalThis.__ZAAPI_PANEL_TEST;
let cursor = 0;
const slots = [];
let pendingEffects = [];

export function __beginRender() { cursor = 0; pendingEffects = []; }
export function __takeEffects() { return pendingEffects.splice(0); }
export function __resetHooks() { cursor = 0; slots.length = 0; pendingEffects = []; }

export function useState(initial) {
  const index = cursor++;
  if (!slots[index]) slots[index] = { kind: "state", value: typeof initial === "function" ? initial() : initial };
  const set = (value) => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; };
  return [slots[index].value, set];
}

export function useRef(initial) {
  const index = cursor++;
  if (!slots[index]) slots[index] = { kind: "ref", current: initial };
  return slots[index];
}

export function useCallback(fn, deps = []) {
  const index = cursor++;
  const slot = slots[index];
  if (!slot || !sameDeps(slot.deps, deps)) slots[index] = { kind: "callback", fn, deps };
  return slots[index].fn;
}

export function useEffect(fn, deps = []) {
  const index = cursor++;
  const slot = slots[index];
  if (!slot || !sameDeps(slot.deps, deps)) {
    slots[index] = { kind: "effect", deps };
    pendingEffects.push(fn);
  }
}

function sameDeps(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

export const Fragment = "fragment";
export function jsx(type, props, key) { return { type, props: props || {}, key: key ?? null }; }
export const jsxs = jsx;
export const SelectField = "SelectField";
export const Badge = "Badge";
export const Button = "Button";
export const EmptyState = "EmptyState";
export const Loading = "Loading";
export const Pagination = "Pagination";
export const ToggleSwitch = "ToggleSwitch";
export const ModalLayer = "ModalLayer";
export const MobileAddActions = "MobileAddActions";
export const Search = "Search";
export const ChevronDown = "ChevronDown";
export const Database = "Database";
export const Pencil = "Pencil";
export const Trash2 = "Trash2";
export const Plus = "Plus";
export const X = "X";
export const FileSpreadsheet = "FileSpreadsheet";
export const Upload = "Upload";
export const Download = "Download";
export const RotateCcw = "RotateCcw";
export const Eye = "Eye";
export const api = () => ({
  get: async (path) => {
    state.calls.push(path);
    if (path === "/system/chat-engine") {
      return { data: { python_tools_available: state.engine !== "v4" } };
    }
    if (path === "/zaapi-kb/files") return { data: { files: [] } };
    if (path === "/zaapi-kb/mapping") return { data: { shops: [] } };
    if (path === "/zaapi-kb") return { data: { sources: [] } };
    return { data: {} };
  },
  post: async () => ({ data: {} }),
  patch: async () => ({ data: {} }),
  delete: async () => ({ data: {} }),
});
export function useAuth() { return { user: { role: "superadmin" } }; }
export function canEditPage() { return true; }
export function useSearchShortcut() {}
export function useEscToClear() { return () => {}; }
export const toast = { success() {}, warning() {}, error() {} };
export const confirm = { ask: async () => true };
