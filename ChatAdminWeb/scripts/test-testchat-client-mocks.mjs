// Leaf mocks for test-testchat-client-boundary.ts
//
// Mini-react shim: state/ref cells allocated by hook call order so the REAL
// component body runs unmodified — setters mutate cells, re-render is
// "reset cursor + invoke component fn again". useEffect fns are recorded,
// never auto-run (test invokes them explicitly = deterministic mount).
// JSX output is a plain object tree {type, props} — never executed.

// ─── react + jsx-runtime seam ───────────────────────────────────────────
const cells = [];
let cursor = 0;
export function __beginRender() { cursor = 0; }
export function __reset() { cells.length = 0; cursor = 0; }
export function __cells() { return cells; }

export function useState(init) {
  const i = cursor++;
  if (cells[i] === undefined) {
    cells[i] = { kind: "state", value: typeof init === "function" ? init() : init };
  }
  const set = (v) => {
    cells[i].value = typeof v === "function" ? v(cells[i].value) : v;
  };
  return [cells[i].value, set];
}
export function useRef(init) {
  const i = cursor++;
  if (cells[i] === undefined) cells[i] = { kind: "ref", current: init };
  return cells[i];
}
export function useEffect(fn) {
  const i = cursor++;
  if (cells[i] === undefined) cells[i] = { kind: "effect", fn };
}
export function useMemo(fn) { cursor++; return fn(); }
export function useCallback(fn) { cursor++; return fn; }
export const Fragment = "__fragment__";
const reactNs = { Fragment, useState, useRef, useEffect, useMemo, useCallback };
export default reactNs;          // shared default: react + next/link

// jsx-runtime / jsx-dev-runtime
export function jsx(type, props, key) { return { type, props: props || {}, key: key ?? null }; }
export const jsxs = jsx;
export const jsxDEV = jsx;

// ─── lucide-react icons (only used as JSX type, never invoked) ──────────
export const Send = "ic:Send";
export const Copy = "ic:Copy";
export const Check = "ic:Check";
export const ThumbsUp = "ic:ThumbsUp";
export const ThumbsDown = "ic:ThumbsDown";
export const Settings2 = "ic:Settings2";
export const X = "ic:X";
export const RotateCcw = "ic:RotateCcw";
export const Package = "ic:Package";
export const Plus = "ic:Plus";
export const Trash2 = "ic:Trash2";
export const Terminal = "ic:Terminal";
export const Pencil = "ic:Pencil";
export const Search = "ic:Search";
export const ArrowUpDown = "ic:ArrowUpDown";
export const Star = "ic:Star";
export const MessageCircle = "ic:MessageCircle";
export const Save = "ic:Save";
export const BarChart3 = "ic:BarChart3";
export const Paperclip = "ic:Paperclip";
export const Film = "ic:Film";
export const History = "ic:History";
export const Clock = "ic:Clock";

// ─── ui components (JSX type only) ──────────────────────────────────────
export const PlatformIcon = "ui:PlatformIcon";
export const Button = "ui:Button";
export const Loading = "ui:Loading";
export const Badge = "ui:Badge";
export const RateBox = "ui:RateBox";
export const DateBanner = "ui:DateBanner";
export const dayKey = () => "dk";

// ─── toast / confirm / imageViewer (leaf side-effects — recorded) ───────
export const __toastLog = [];
export const toast = {
  success: (m) => __toastLog.push(["success", String(m)]),
  info: (m) => __toastLog.push(["info", String(m)]),
  error: (m) => __toastLog.push(["error", String(m)]),
};
export const confirm = { ask: async () => true };
export const imageViewer = { show: () => {} };

// ─── services / apiClient ───────────────────────────────────────────────
export const quickReplyService = { list: async () => [] };
export const api = () => ({ get: async () => ({ data: {} }) });
