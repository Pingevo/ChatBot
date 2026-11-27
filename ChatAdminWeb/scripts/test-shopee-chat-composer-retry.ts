import assert from "node:assert/strict";
import React from "react";
import type { ChatSendInput } from "../src/lib/types";

type Element = { type: unknown; props: Record<string, any> };

const original = { useState: React.useState, useRef: React.useRef, useEffect: React.useEffect };
let slots: unknown[] = [];
let index = 0;

(React as any).useState = (initial: unknown) => {
  const slot = index++;
  if (!(slot in slots)) slots[slot] = initial;
  return [slots[slot], (value: unknown) => { slots[slot] = typeof value === "function" ? (value as (old: unknown) => unknown)(slots[slot]) : value; }];
};
(React as any).useRef = (initial: unknown) => {
  const slot = index++;
  if (!(slot in slots)) slots[slot] = { current: initial };
  return slots[slot];
};
(React as any).useEffect = () => {};

const { ShopeeChatComposer } = require("../src/components/chat/ShopeeChatComposer") as typeof import("../src/components/chat/ShopeeChatComposer");

function render(onSend: (payload: ChatSendInput, mode?: boolean) => Promise<unknown>, onRefreshSendMode?: () => Promise<boolean>, liveSendEnabled = true): Element {
  index = 0;
  return ShopeeChatComposer({ platform: "shopee", liveSendEnabled, onSend, onRefreshSendMode }) as Element;
}

function find(element: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(element)) return element.map((child) => find(child, predicate)).find(Boolean);
  if (!element || typeof element !== "object" || !("props" in element)) return undefined;
  const node = element as Element;
  return predicate(node) ? node : find(node.props.children, predicate);
}

function failed(code?: string): Error {
  return Object.assign(new Error("send failed"), { response: { data: code ? { code } : {} } });
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function textCase(code: string | undefined, expectedFreshId: boolean) {
  slots = [];
  const sent: { payload: ChatSendInput; mode?: boolean }[] = [];
  const onSend = async (payload: ChatSendInput, mode?: boolean) => {
    sent.push({ payload, mode });
    if (sent.length === 1) throw failed(code);
  };
  let tree = render(onSend);
  find(tree, (node) => node.type === "textarea")!.props.onChange({ target: { value: "same draft", style: {}, scrollHeight: 40 } });
  tree = render(onSend);
  tree.props.onSubmit({ preventDefault() {} });
  await flush();
  tree = render(onSend);
  assert(find(tree, (node) => node.props.role === "alertdialog"));
  find(tree, (node) => node.type === "button" && node.props.children === "ลองใหม่")!.props.onClick();
  await flush();
  tree = render(onSend);
  assert.equal(sent.length, 2);
  assert.equal((sent[1].payload as { text: string }).text, "same draft");
  assert.equal(sent[0].payload.request_id === sent[1].payload.request_id, !expectedFreshId);
  assert.equal(find(tree, (node) => node.type === "textarea")!.props.value, "");
}

async function modeCase() {
  slots = [];
  const sent: { id: string; mode?: boolean }[] = [];
  let refreshes = 0;
  const onSend = async (payload: ChatSendInput, mode?: boolean) => {
    sent.push({ id: payload.request_id, mode });
    if (sent.length === 1) throw failed("send_mode_changed");
  };
  const refresh = async () => {
    refreshes++;
    if (refreshes === 1) throw new Error("offline");
    return true;
  };
  let tree = render(onSend, refresh);
  find(tree, (node) => node.type === "textarea")!.props.onChange({ target: { value: "keep this", style: {}, scrollHeight: 40 } });
  tree = render(onSend, refresh);
  tree.props.onSubmit({ preventDefault() {} });
  await flush();
  tree = render(onSend, refresh);
  await find(tree, (node) => node.type === "button" && node.props.children === "ลองใหม่")!.props.onClick();
  tree = render(onSend, refresh);
  assert.equal(sent.length, 1);
  assert.equal(find(tree, (node) => node.type === "textarea")!.props.value, "keep this");
  await find(tree, (node) => node.type === "button" && node.props.children === "ลองใหม่")!.props.onClick();
  await flush();
  assert.deepEqual(sent, [{ id: sent[0].id, mode: undefined }, { id: sent[0].id, mode: true }]);
}

async function changedModeCase(initialMode: boolean) {
  slots = [];
  const sent: ChatSendInput[] = [];
  const onSend = async (payload: ChatSendInput) => {
    sent.push(payload);
    throw failed("send_mode_changed");
  };
  const refresh = async () => !initialMode;
  let tree = render(onSend, refresh, initialMode);
  find(tree, (node) => node.type === "textarea")!.props.onChange({ target: { value: "live reply", style: {}, scrollHeight: 40 } });
  tree = render(onSend, refresh, initialMode);
  tree.props.onSubmit({ preventDefault() {} });
  await flush();
  tree = render(onSend, refresh, initialMode);
  await find(tree, (node) => node.type === "button" && node.props.children === "ลองใหม่")!.props.onClick();
  tree = render(onSend, refresh, initialMode);
  assert.equal(sent.length, 1, "changed mode must not silently change delivery mode");
  assert.equal(find(tree, (node) => node.type === "textarea")!.props.value, "live reply");
  assert(find(tree, (node) => node.props.role === "alertdialog"));
}

async function imageCase() {
  slots = [];
  const sent: ChatSendInput[] = [];
  const onSend = async (payload: ChatSendInput) => {
    sent.push(payload);
    if (sent.length === 2) throw failed("shopee_error_sign");
  };
  let tree = render(onSend);
  const files = [new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.jpg", { type: "image/jpeg" })];
  find(tree, (node) => node.type === "input" && node.props.multiple)!.props.onChange({ target: { files }, currentTarget: { value: "images" } });
  tree = render(onSend);
  tree.props.onSubmit({ preventDefault() {} });
  await flush();
  tree = render(onSend);
  assert.equal(sent.length, 2);
  find(tree, (node) => node.type === "button" && node.props.children === "ลองใหม่")!.props.onClick();
  await flush();
  assert.equal(sent.length, 3);
  assert.equal((sent[2] as { file: File }).file, files[1]);
  assert.notEqual(sent[2].request_id, sent[1].request_id);
}

void (async () => {
  try {
    await textCase("shopee_error_sign", true);
    await textCase("delivery_unknown", false);
    await textCase(undefined, false);
    await modeCase();
    await changedModeCase(true);
    await changedModeCase(false);
    await imageCase();
    console.log("ShopeeChatComposer retry behavioral checks passed");
  } finally {
    Object.assign(React, original);
  }
})();
