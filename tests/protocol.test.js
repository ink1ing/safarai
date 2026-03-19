import test from "node:test";
import assert from "node:assert/strict";

import {
  SUPPORTED_SITES,
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isSupportedSite,
} from "../safarai/safarai Extension/Resources/shared/protocol.js";

test("createRequest 会生成带 id 的请求对象", () => {
  const request = createRequest("summarize_page", { hello: "world" });

  assert.equal(request.type, "summarize_page");
  assert.equal(request.payload.hello, "world");
  assert.match(request.id, /^req_/);
});

test("success 与 error 响应结构稳定", () => {
  const success = createSuccessResponse({ answer: "ok" });
  const failure = createErrorResponse("timeout", "请求超时");

  assert.deepEqual(success, {
    ok: true,
    payload: { answer: "ok" },
  });
  assert.deepEqual(failure, {
    ok: false,
    error: {
      code: "timeout",
      message: "请求超时",
    },
  });
});

test("站点识别白名单包含四个 MVP 站点", () => {
  assert.equal(SUPPORTED_SITES.length, 4);
  assert.equal(isSupportedSite("github"), true);
  assert.equal(isSupportedSite("gmail"), true);
  assert.equal(isSupportedSite("x"), true);
  assert.equal(isSupportedSite("yahoo_mail"), true);
  assert.equal(isSupportedSite("notion"), false);
});
