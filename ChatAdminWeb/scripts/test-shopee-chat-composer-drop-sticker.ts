import assert from "node:assert/strict";
import Module from "node:module";
import React from "react";
import type { ChatSendInput } from "../src/lib/types";

type Element = { type: unknown; props: Record<string, any> };
type ModuleLoader = (this: typeof Module, request: string, parent: any, isMain: boolean) => any;

const moduleRuntime = Module as typeof Module & { _load: ModuleLoader };
const originalLoad = moduleRuntime._load;
const originalHooks = { useState: React.useState, useRef: React.useRef, useEffect: React.useEffect };
let slots: unknown[] = [];
let hookIndex = 0;
let stickerApiCalls = 0;

Object.assign(React, {
  useState(initial: unknown) {
    const slot = hookIndex++;
    if (!(slot in slots)) slots[slot] = initial;
    return [slots[slot], (value: unknown) => {
      slots[slot] = typeof value === "function" ? (value as (old: unknown) => unknown)(slots[slot]) : value;
    }];
  },
  useRef(initial: unknown) {
    const slot = hookIndex++;
    if (!(slot in slots)) slots[slot] = { current: initial };
    return slots[slot];
  },
  useEffect() {},
});

moduleRuntime._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith("ShopeeChatComposer.tsx") && request === "@/lib/apiClient") {
    return {
      api: () => ({
        get: async (_path: string, options?: { params?: { pack_id?: string } }) => {
          stickerApiCalls++;
          return options?.params?.pack_id
            ? { data: { stickers: [{ sid: "sticker-1", url: "/sticker.png" }] } }
            : { data: { packs: [{ pid: "pack-1", name: "ชุดทดสอบ" }] } };
        },
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { ShopeeChatComposer } = require("../src/components/chat/ShopeeChatComposer") as typeof import("../src/components/chat/ShopeeChatComposer");

function render(onSend: (payload: ChatSendInput, mode?: boolean) => Promise<unknown>): Element {
  hookIndex = 0;
  return ShopeeChatComposer({ platform: "shopee", liveSendEnabled: true, onSend }) as Element;
}

function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function dropImagesStayQueuedUntilSubmit() {
  slots = [];
  const sent: ChatSendInput[] = [];
  const onSend = async (payload: ChatSendInput) => { sent.push(payload); };
  let tree = render(onSend);
  const form = find(tree, (element) => element.type === "form")!;
  assert.equal(typeof form.props.onDragOver, "function", "composer accepts image drag-over");
  assert.equal(typeof form.props.onDrop, "function", "composer accepts dropped images");

  const image = new File(["image"], "customer-photo.jpg", { type: "image/jpeg" });
  let dragPrevented = false;
  form.props.onDragOver({ dataTransfer: { types: ["Files"] }, preventDefault() { dragPrevented = true; } });
  assert.equal(dragPrevented, true, "file drag-over prevents the browser from opening the file");

  let dropPrevented = false;
  form.props.onDrop({ dataTransfer: { types: ["Files"], files: [image] }, preventDefault() { dropPrevented = true; } });
  assert.equal(dropPrevented, true, "drop is handled inside the composer");
  assert.equal(sent.length, 0, "dropping an image must never send it automatically");

  tree = render(onSend);
  assert.ok(find(tree, (element) => element.type === "span" && element.props.title === image.name), "dropped image appears in the attachment preview");
  const submit = find(tree, (element) => element.type === "button" && element.props.type === "submit")!;
  assert.equal(submit.props.disabled, false, "queued image can be sent with the existing send button");
  tree.props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "image");
  assert.equal((sent[0] as { file: File }).file, image);

  tree = render(onSend);
  const nextForm = find(tree, (element) => element.type === "form")!;
  const invalid = new File(["text"], "notes.txt", { type: "text/plain" });
  nextForm.props.onDrop({ dataTransfer: { types: ["Files"], files: [invalid] }, preventDefault() {} });
  tree = render(onSend);
  assert.ok(find(tree, (element) => element.props.role === "alert"), "unsupported dropped files show the existing validation error");
  assert.equal(sent.length, 1, "invalid dropped files are not sent");
}

async function enterSendsTheSelectedSticker() {
  slots = [];
  stickerApiCalls = 0;
  const sent: ChatSendInput[] = [];
  const onSend = async (payload: ChatSendInput) => { sent.push(payload); };
  let tree = render(onSend);
  find(tree, (element) => element.type === "button" && element.props["aria-label"] === "เลือกสติกเกอร์")!.props.onClick();
  await flush();
  tree = render(onSend);
  find(tree, (element) => element.type === "button" && element.props.children === "ชุดทดสอบ")!.props.onClick();
  await flush();
  tree = render(onSend);
  const sticker = find(tree, (element) => element.type === "button" && element.props["aria-label"] === "เลือกสติกเกอร์ sticker-1")!;
  sticker.props.onClick();
  assert.equal(sent.length, 0, "choosing a sticker only selects it; it does not send");

  tree = render(onSend);
  const selectedSticker = find(tree, (element) => element.type === "button" && element.props["aria-label"] === "เลือกสติกเกอร์ sticker-1")!;
  assert.ok(find(tree, (element) => element.type === "p" && String(element.props.children).includes("Enter")), "sticker hint explains the Enter shortcut");
  let prevented = false;
  let requested = 0;
  selectedSticker.props.onKeyDown({
    key: "Enter",
    currentTarget: { form: { requestSubmit() {
      requested++;
      render(onSend).props.onSubmit({ preventDefault() {} });
    } } },
    preventDefault() { prevented = true; },
  });
  await flush();
  assert.equal(prevented, true, "Enter on the selected sticker is handled as send");
  assert.equal(requested, 1, "selected sticker submits the existing composer form");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "sticker",
    sticker_id: "sticker-1",
    sticker_package_id: "pack-1",
    request_id: sent[0].request_id,
  });
  assert.equal(stickerApiCalls, 2, "test uses the existing sticker pack and sticker loading flow");
}

async function main() {
  const failures: string[] = [];
  for (const [name, run] of [
    ["dropped images stay queued until submit", dropImagesStayQueuedUntilSubmit],
    ["Enter sends the selected sticker", enterSendsTheSelectedSticker],
  ] as const) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  Object.assign(React, originalHooks);
  moduleRuntime._load = originalLoad;
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("ShopeeChatComposer drop/sticker behavior checks passed");
}

void main();
