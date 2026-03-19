import test from "node:test";
import assert from "node:assert/strict";

import { pruneMessages } from "../safarai/safarai Extension/Resources/shared/session-store.js";

test("pruneMessages 只保留最近 20 条会话", () => {
  const messages = Array.from({ length: 25 }, (_, index) => ({
    text: `msg-${index}`,
  }));

  const result = pruneMessages(messages);
  assert.equal(result.length, 20);
  assert.equal(result[0].text, "msg-5");
  assert.equal(result.at(-1).text, "msg-24");
});
