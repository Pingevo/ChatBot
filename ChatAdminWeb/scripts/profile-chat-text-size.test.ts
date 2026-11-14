import assert from "node:assert/strict";
import { test } from "node:test";

test("chat text size accepts supported presets and defaults unknown values to normal", async () => {
  const preferences = await import("../src/lib/chatTextSize").catch(() => null);
  assert.equal(preferences?.isChatTextSize("normal"), true);
  assert.equal(preferences?.isChatTextSize("large"), true);
  assert.equal(preferences?.isChatTextSize("larger"), true);
  assert.equal(preferences?.isChatTextSize("dark"), false);
  assert.equal(preferences?.normalizeChatTextSize(undefined), "normal");
  assert.equal(preferences?.normalizeChatTextSize("unknown"), "normal");
});
