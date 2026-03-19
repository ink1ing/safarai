import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDraftToElement,
  copyDraftFallback,
  describeWriteTarget,
  isWritableElement,
  resolveWritableTarget,
} from "../safarai/safarai Extension/Resources/shared/write-target.js";

test("describeWriteTarget 会组合仓库、页面类型和输入框说明", () => {
  const element = createElement({
    tagName: "TEXTAREA",
    attrs: {
      placeholder: "Leave a comment",
      "aria-label": "Comment",
    },
  });

  const result = describeWriteTarget(element, {
    repository: "ink1ing/safarai",
    pageKind: "github_pull_request",
  });

  assert.equal(result.type, "textarea");
  assert.equal(result.description, "ink1ing/safarai / github_pull_request / Comment");
});

test("isWritableElement 只接受安全输入目标", () => {
  assert.equal(isWritableElement(createElement({ tagName: "TEXTAREA" })), true);
  assert.equal(
    isWritableElement(createElement({ tagName: "INPUT", type: "password" })),
    false
  );
  assert.equal(
    isWritableElement(createElement({ tagName: "DIV", contentEditable: "true" })),
    true
  );
});

test("applyDraftToElement 会写入 textarea 并触发输入事件", () => {
  const dispatched = [];
  const element = createElement({ tagName: "TEXTAREA" });
  element.dispatchEvent = (event) => dispatched.push(event.type);

  const applied = applyDraftToElement(element, "hello draft");

  assert.equal(applied, true);
  assert.equal(element.value, "hello draft");
  assert.deepEqual(dispatched, ["input", "change"]);
});

test("resolveWritableTarget 会回退到 GitHub 评论框选择器", () => {
  const commentBox = createElement({
    tagName: "TEXTAREA",
    attrs: { placeholder: "Leave a comment" },
  });
  const doc = {
    querySelector(selector) {
      if (selector === "textarea[placeholder*='Leave a comment']") {
        return commentBox;
      }
      return null;
    },
  };

  const result = resolveWritableTarget(doc, null, { site: "github" });
  assert.equal(result, commentBox);
});

test("resolveWritableTarget 会识别 Gmail 回复框", () => {
  const editor = createElement({
    tagName: "DIV",
    contentEditable: "true",
  });
  const doc = {
    querySelector(selector) {
      if (selector === "[role='textbox'][g_editable='true']") {
        return editor;
      }
      return null;
    },
  };

  const result = resolveWritableTarget(doc, null, { site: "gmail" });
  assert.equal(result, editor);
});

test("resolveWritableTarget 会识别 X 回复框", () => {
  const editor = createElement({
    tagName: "DIV",
    contentEditable: "true",
  });
  const doc = {
    querySelector(selector) {
      if (selector === "[data-testid='tweetTextarea_0']") {
        return editor;
      }
      return null;
    },
  };

  const result = resolveWritableTarget(doc, null, { site: "x" });
  assert.equal(result, editor);
});

test("resolveWritableTarget 会回退到 contenteditable 祖先节点", () => {
  const parent = createElement({
    tagName: "DIV",
    contentEditable: "true",
  });
  const child = {
    tagName: "SPAN",
    parentElement: parent,
    closest(selector) {
      if (selector === "[contenteditable='true']") {
        return parent;
      }
      return null;
    },
  };
  const doc = {
    querySelector() {
      return null;
    },
  };

  const result = resolveWritableTarget(doc, child, { site: "unsupported" });
  assert.equal(result, parent);
});

test("copyDraftFallback 优先调用 clipboard API", () => {
  let copiedText = "";
  const win = {
    navigator: {
      clipboard: {
        writeText(value) {
          copiedText = value;
          return Promise.resolve();
        },
      },
    },
  };

  const copied = copyDraftFallback(win, null, "fallback draft");
  assert.equal(copied, true);
  assert.equal(copiedText, "fallback draft");
});

function createElement({
  tagName,
  attrs = {},
  type = "text",
  contentEditable = "inherit",
  disabled = false,
  readOnly = false,
}) {
  return {
    tagName,
    type,
    value: "",
    disabled,
    readOnly,
    contentEditable,
    isContentEditable: contentEditable === "true",
    getAttribute(key) {
      return attrs[key] ?? null;
    },
    focus() {},
    dispatchEvent() {},
  };
}
