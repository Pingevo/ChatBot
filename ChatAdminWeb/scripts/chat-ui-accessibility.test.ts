import assert from "node:assert/strict";
import { test } from "node:test";
import { _getFilterDialogTabStops } from "../src/components/ui/FilterSelect";
import { adminBubbleStyle } from "../src/lib/bubbleColors";

test("admin bubble foreground stays readable with light and dark custom colors", () => {
  assert.equal(adminBubbleStyle("#ffffff").color, "#0b2340");
  assert.equal(adminBubbleStyle("#0b2340").color, "#ffffff");
});

test("filter dialog tab stops exclude roving listbox options", () => {
  const closeButton = { tabIndex: 0 } as HTMLButtonElement;
  const selectedOption = { tabIndex: 0 } as HTMLButtonElement;
  const otherOptions = [
    { tabIndex: -1 } as HTMLButtonElement,
    { tabIndex: -1 } as HTMLButtonElement,
  ];

  assert.deepEqual(
    _getFilterDialogTabStops([closeButton, selectedOption, ...otherOptions]),
    [closeButton, selectedOption]
  );
});
