import test from "node:test";
import assert from "node:assert/strict";

import {
  detectSite,
  extractPageContext,
} from "../safarai/safarai Extension/Resources/shared/page-context.js";

test("detectSite 能识别 GitHub 与 Gmail", () => {
  assert.equal(detectSite("github.com"), "github");
  assert.equal(detectSite("mail.google.com"), "gmail");
  assert.equal(detectSite("example.com"), "unsupported");
});

test("GitHub PR 页面优先提取 markdown-body 并识别仓库", () => {
  const markdownNode = createNode({
    textContent:
      "Pull request summary ".repeat(20),
  });
  const fallbackMain = createNode({
    textContent: "Fallback main content ".repeat(30),
  });
  const textarea = createNode({
    tagName: "TEXTAREA",
    attrs: {
      placeholder: "Leave a comment",
      "aria-label": "Comment",
    },
  });

  const doc = createDocument({
    title: "Improve sidebar extraction",
    activeElement: textarea,
    selectors: {
      ".markdown-body": markdownNode,
      "main": fallbackMain,
      "textarea[placeholder*='comment'], textarea[aria-label*='comment'], [contenteditable='true']":
        textarea,
    },
  });

  const win = {
    location: {
      href: "https://github.com/ink1ing/safarai/pull/12",
      hostname: "github.com",
      pathname: "/ink1ing/safarai/pull/12",
    },
    getSelection() {
      return {
        toString() {
          return "selected diff";
        },
      };
    },
  };

  const result = extractPageContext(win, doc);

  assert.equal(result.site, "github");
  assert.equal(result.metadata.pageKind, "github_pull_request");
  assert.equal(result.metadata.repository, "ink1ing/safarai");
  assert.equal(result.metadata.hasCommentEditor, true);
  assert.match(result.articleText, /^Pull request summary/);
  assert.equal(result.focusedInput.label, "Comment");
});

test("通用页面在无正文时返回空字符串与基础类型", () => {
  const doc = createDocument({
    title: "Example",
    selectors: {
      main: createNode({ textContent: "short text" }),
    },
  });

  const win = {
    location: {
      href: "https://example.com/docs",
      hostname: "example.com",
      pathname: "/docs",
    },
    getSelection() {
      return {
        toString() {
          return "";
        },
      };
    },
  };

  const result = extractPageContext(win, doc);
  assert.equal(result.site, "unsupported");
  assert.equal(result.articleText, "");
  assert.equal(result.metadata.pageKind, "page");
  assert.equal(result.focusedInput, null);
});

test("通用页面会回退到结构化正文抽取", () => {
  const paragraphOne = createNode({ textContent: "第一段内容，介绍页面的核心目标和背景信息。" });
  const paragraphTwo = createNode({ textContent: "第二段内容，补充了步骤、限制和预期结果，长度足够被提取。" });
  const heading = createNode({ textContent: "页面标题" });

  const doc = createDocument({
    title: "Generic Docs",
    selectors: {
      main: createNode({ textContent: "short text" }),
    },
    selectorAll: {
      "h1, h2, h3": [heading],
      "p, li, blockquote": [paragraphOne, paragraphTwo],
      "pre, code": [],
    },
  });

  const win = {
    location: {
      href: "https://docs.example.com/guide/start",
      hostname: "docs.example.com",
      pathname: "/guide/start",
    },
    getSelection() {
      return {
        toString() {
          return "";
        },
      };
    },
  };

  const result = extractPageContext(win, doc);
  assert.equal(result.metadata.domain, "docs.example.com");
  assert.equal(result.metadata.pageKind, "document");
  assert.match(result.articleText, /页面标题/);
  assert.match(result.articleText, /第二段内容/);
});

test("Gmail 线程页会识别正文和可写回复框", () => {
  const replyBox = createNode({
    tagName: "DIV",
    attrs: {
      "aria-label": "Message Body",
    },
    contentEditable: "true",
  });
  const mailBody = createNode({
    textContent: "邮件正文 ".repeat(40),
  });

  const doc = createDocument({
    title: "Inbox - demo@gmail.com - Gmail",
    activeElement: replyBox,
    selectors: {
      ".a3s": mailBody,
      "[role='textbox'][g_editable='true'], div[aria-label*='Message Body']": replyBox,
    },
  });

  const win = {
    location: {
      href: "https://mail.google.com/mail/u/0/#inbox/abc123",
      hostname: "mail.google.com",
      pathname: "/mail/u/0/",
    },
    getSelection() {
      return {
        toString() {
          return "";
        },
      };
    },
  };

  const result = extractPageContext(win, doc);
  assert.equal(result.site, "gmail");
  assert.equal(result.metadata.pageKind, "gmail_thread");
  assert.equal(result.metadata.hasCommentEditor, true);
  assert.equal(result.focusedInput.isContentEditable, true);
  assert.match(result.articleText, /^邮件正文/);
});

test("X 帖文页会识别帖子正文和回复框", () => {
  const replyBox = createNode({
    tagName: "DIV",
    attrs: {
      "aria-label": "Reply text",
      "data-testid": "tweetTextarea_0",
    },
    contentEditable: "true",
  });
  const article = createNode({
    textContent: "This is a long X thread body ".repeat(20),
  });

  const doc = createDocument({
    title: "Post / X",
    activeElement: replyBox,
    selectors: {
      article,
      "[data-testid='tweetTextarea_0'], [role='textbox'][data-testid='tweetTextarea_0']":
        replyBox,
    },
  });

  const win = {
    location: {
      href: "https://x.com/demo/status/1234567890",
      hostname: "x.com",
      pathname: "/demo/status/1234567890",
    },
    getSelection() {
      return {
        toString() {
          return "";
        },
      };
    },
  };

  const result = extractPageContext(win, doc);
  assert.equal(result.site, "x");
  assert.equal(result.metadata.pageKind, "x_post");
  assert.equal(result.metadata.hasCommentEditor, true);
  assert.match(result.articleText, /^This is a long X thread body/);
});

test("Yahoo Mail 会识别邮件正文和编辑器", () => {
  const editor = createNode({
    tagName: "DIV",
    attrs: {
      "aria-label": "Message body",
    },
    contentEditable: "true",
  });
  const body = createNode({
    textContent: "Yahoo mail content ".repeat(30),
  });

  const doc = createDocument({
    title: "Yahoo Mail",
    activeElement: editor,
    selectors: {
      "[data-test-id='message-view-body-content']": body,
      "[data-test-id='compose-editor'], div[contenteditable='true'][aria-label*='Message body']":
        editor,
    },
  });

  const win = {
    location: {
      href: "https://mail.yahoo.com/d/folders/1/messages/abc",
      hostname: "mail.yahoo.com",
      pathname: "/d/folders/1/messages/abc",
    },
    getSelection() {
      return {
        toString() {
          return "";
        },
      };
    },
  };

  const result = extractPageContext(win, doc);
  assert.equal(result.site, "yahoo_mail");
  assert.equal(result.metadata.pageKind, "yahoo_mail_thread");
  assert.equal(result.metadata.hasCommentEditor, true);
  assert.match(result.articleText, /^Yahoo mail content/);
});

function createDocument({ title, activeElement = null, selectors = {}, selectorAll = {} }) {
  return {
    title,
    activeElement,
    body: selectors.body ?? null,
    querySelector(selector) {
      return selectors[selector] ?? null;
    },
    querySelectorAll(selector) {
      return selectorAll[selector] ?? [];
    },
  };
}

function createNode({ tagName = "DIV", textContent = "", attrs = {}, contentEditable = "inherit" }) {
  return {
    tagName,
    textContent,
    innerText: textContent,
    contentEditable,
    isContentEditable: contentEditable === "true",
    getAttribute(key) {
      return attrs[key] ?? null;
    },
  };
}
