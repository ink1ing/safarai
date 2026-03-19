import test from "node:test";
import assert from "node:assert/strict";

import { pruneLogs } from "../safarai/safarai Extension/Resources/shared/log-store.js";

test("pruneLogs 只保留最近 50 条记录", () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({
    id: index,
  }));

  const result = pruneLogs(entries);
  assert.equal(result.length, 50);
  assert.equal(result[0].id, 0);
  assert.equal(result.at(-1).id, 49);
});
