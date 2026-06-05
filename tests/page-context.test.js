import test from "node:test";
import assert from "node:assert/strict";

import {
  detectSite,
  extractPageContext,
} from "../safarai/safarai Extension/Resources/shared/page-context.js";

test("detectSite 能识别 GitHub 与 Gmail", () => {
  assert.equal(detectSite("github.com"), "github");
  assert.equal(detectSite("mail.google.com"), "gmail");
  assert.equal(detectSite("www.youtube.com"), "youtube");
  assert.equal(detectSite("www.bilibili.com"), "bilibili");
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
  const activeTab = createNode({ tagName: "A", textContent: "Conversation" });
  const statePill = createNode({ tagName: "SPAN", textContent: "Open" });
  const reviewButton = createNode({
    tagName: "BUTTON",
    textContent: "Review changes",
    rect: { top: 24, left: 320, width: 140, height: 32, right: 460, bottom: 56 },
  });

  const doc = createDocument({
    title: "Improve sidebar extraction",
    activeElement: textarea,
    selectors: {
      ".markdown-body": markdownNode,
      "main": fallbackMain,
      ".UnderlineNav-item.selected": activeTab,
      "textarea[placeholder*='comment'], textarea[aria-label*='comment'], [contenteditable='true']":
        textarea,
    },
    selectorAll: {
      ".State": [statePill],
      "main button": [reviewButton],
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
  assert.equal(result.metadata.mainTab, "Conversation");
  assert.equal(result.metadata.statePills, "Open");
  assert.equal(result.metadata.primaryActions, "Review changes");
  assert.match(result.articleText, /^Pull request summary/);
  assert.match(result.structureSummary, /repository=ink1ing\/safarai/);
  assert.match(result.structureSummary, /tab=Conversation/);
  assert.match(result.structureSummary, /actions=Review changes/);
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

test("页面视觉信息会提取非透明背景、渐变和配色模式", () => {
  const main = createNode({
    tagName: "MAIN",
    textContent: "Long-form content ".repeat(16),
    computedStyle: {
      display: "block",
      visibility: "visible",
      opacity: "1",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "none",
      colorScheme: "normal",
    },
  });
  const root = createNode({
    tagName: "DIV",
    attrs: { id: "root" },
    children: [main],
    computedStyle: {
      display: "block",
      visibility: "visible",
      opacity: "1",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "linear-gradient(rgb(245, 247, 250), rgb(255, 255, 255))",
      colorScheme: "light",
    },
  });
  const body = createNode({
    tagName: "BODY",
    children: [root],
    computedStyle: {
      display: "block",
      visibility: "visible",
      opacity: "1",
      backgroundColor: "rgb(245, 247, 250)",
      backgroundImage: "none",
      colorScheme: "light",
    },
  });

  const doc = createDocument({
    title: "Visual page",
    body,
    selectors: {
      "#root": root,
      main,
      body,
    },
  });

  const win = createWindow({
    href: "https://example.com/visual",
    hostname: "example.com",
    pathname: "/visual",
  });

  const result = extractPageContext(win, doc);
  assert.equal(result.metadata.pageBackgroundColor, "rgb(245, 247, 250)");
  assert.match(result.metadata.pageBackgroundImage, /linear-gradient/);
  assert.equal(result.metadata.pageColorScheme, "light");
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

test("YouTube 视频页会提取标题、频道、描述和页面线索", () => {
  const title = createNode({ tagName: "H1", textContent: "How Safari Extensions Work" });
  const channel = createNode({ tagName: "DIV", textContent: "WebKit Channel" });
  const description = createNode({
    textContent: "This video explains Safari extension architecture and message passing in detail.",
  });

  const doc = createDocument({
    title: "How Safari Extensions Work - YouTube",
    selectors: {
      "h1.ytd-watch-metadata": title,
      "#owner #channel-name": channel,
      "#description-inline-expander": description,
    },
  });

  const win = createWindow({
    href: "https://www.youtube.com/watch?v=abc123",
    hostname: "www.youtube.com",
    pathname: "/watch",
  });

  const result = extractPageContext(win, doc);
  assert.equal(result.site, "youtube");
  assert.equal(result.metadata.pageKind, "youtube_video");
  assert.equal(result.metadata.videoTitle, "How Safari Extensions Work");
  assert.equal(result.metadata.videoAuthor, "WebKit Channel");
  assert.equal(result.metadata.videoContentBasis, "page_metadata");
  assert.equal(result.videoTranscript, undefined);
  assert.equal(result.metadata.videoTranscriptCount, undefined);
  assert.match(result.articleText, /video_title: How Safari Extensions Work/);
  assert.match(result.articleText, /video_description:\nThis video explains Safari extension architecture/);
  assert.doesNotMatch(result.articleText, /video_transcript_or_visible_subtitles/);
  assert.doesNotMatch(result.structureSummary, /has_transcript=/);
});

test("YouTube 视频页会提取章节和评论注意力信号", () => {
  const title = createNode({ tagName: "H1", textContent: "1989 documentary timeline" });
  const description = createNode({
    textContent: "00:00 Background of the movement. 07:50 Zhao Ziyang appears in Tiananmen Square.",
  });
  const chapter = createNode({
    textContent: "07:50 Zhao Ziyang appears in Tiananmen Square",
  });
  const commentA = createNode({
    textContent: "7:50 这一段赵紫阳最后露面非常震撼，很多人反复回看。",
  });
  const commentB = createNode({
    textContent: "1:13 It's my duty 这一句是整个视频的情绪峰值。",
  });
  const doc = createDocument({
    title: "1989 documentary timeline - YouTube",
    selectors: {
      "h1.ytd-watch-metadata": title,
      "#description-inline-expander": description,
    },
    selectorAll: {
      "#description-inline-expander": [description],
      "ytd-macro-markers-list-item-renderer": [chapter],
      "ytd-comment-thread-renderer #content-text": [commentA, commentB],
    },
  });
  const win = createWindow({
    href: "https://www.youtube.com/watch?v=history123",
    hostname: "www.youtube.com",
    pathname: "/watch",
  });

  const result = extractPageContext(win, doc);
  assert.match(result.videoRAGSummary, /salient_timestamp_signals/);
  assert.match(result.videoRAGSummary, /07:50 Zhao Ziyang/);
  assert.match(result.videoRAGSummary, /collective_attention_signals/);
  assert.match(result.videoRAGSummary, /It's my duty/);
  assert.match(result.articleText, /video_chapters_or_moments/);
  assert.match(result.articleText, /comment_attention_signals/);
});

test("YouTube 视频页忽略 textTracks cues，仅保留视频 metadata", () => {
  const video = createNode({
    tagName: "VIDEO",
    rect: { top: 10, left: 10, width: 1280, height: 720, right: 1290, bottom: 730 },
    duration: 180,
    currentTime: 14,
    textTracks: [
      {
        cues: [
          { startTime: 0, endTime: 8, text: "Welcome to the video." },
          { startTime: 12, endTime: 24, text: "Now we explain timestamped context." },
        ],
      },
    ],
  });
  const doc = createDocument({
    title: "Captioned video - YouTube",
    selectors: {
      video,
    },
    selectorAll: {
      video: [video],
    },
  });
  const win = createWindow({
    href: "https://www.youtube.com/watch?v=track123",
    hostname: "www.youtube.com",
    pathname: "/watch",
  });

  const result = extractPageContext(win, doc);
  assert.equal(result.metadata.hasPrimaryVideo, "true");
  assert.equal(result.metadata.videoDurationSeconds, "180");
  assert.equal(result.metadata.videoCurrentTimeSeconds, "14");
  assert.equal(result.metadata.videoContentBasis, "page_metadata");
  assert.equal(result.metadata.videoTranscriptSource, undefined);
  assert.equal(result.videoTranscript, undefined);
});

test("Bilibili 视频页会提取标题、UP 主、简介和页面线索", () => {
  const title = createNode({ tagName: "H1", textContent: "Safari AI 轻量扩展开发记录" });
  const up = createNode({ tagName: "A", textContent: "前端实验室" });
  const description = createNode({
    textContent: "本期记录如何把页面内容和聊天面板连接起来。",
  });

  const doc = createDocument({
    title: "Safari AI 轻量扩展开发记录_bilibili",
    selectors: {
      ".video-title": title,
      ".up-name": up,
      ".video-desc": description,
    },
  });

  const win = createWindow({
    href: "https://www.bilibili.com/video/BV1abc123456/",
    hostname: "www.bilibili.com",
    pathname: "/video/BV1abc123456/",
  });

  const result = extractPageContext(win, doc);
  assert.equal(result.site, "bilibili");
  assert.equal(result.metadata.pageKind, "bilibili_video");
  assert.equal(result.metadata.videoTitle, "Safari AI 轻量扩展开发记录");
  assert.equal(result.metadata.videoAuthor, "前端实验室");
  assert.equal(result.metadata.videoContentBasis, "page_metadata");
  assert.equal(result.metadata.videoTranscriptSource, undefined);
  assert.equal(result.videoTranscript, undefined);
  assert.match(result.articleText, /video_description/);
  assert.match(result.articleText, /本期记录如何把页面内容和聊天面板连接起来/);
});

test("普通页面含主 video 时会标记可显示视频总结入口", () => {
  const video = createNode({
    tagName: "VIDEO",
    rect: { top: 20, left: 20, width: 960, height: 540, right: 980, bottom: 560 },
    duration: 64,
    currentTime: 7,
  });
  const doc = createDocument({
    title: "Embedded video",
    selectors: {
      main: createNode({ textContent: "A page with an embedded product walkthrough video.".repeat(6) }),
      video,
    },
    selectorAll: {
      video: [video],
    },
  });
  const win = createWindow({
    href: "https://example.com/video-demo",
    hostname: "example.com",
    pathname: "/video-demo",
  });

  const result = extractPageContext(win, doc);
  assert.equal(result.metadata.hasPrimaryVideo, "true");
  assert.equal(result.metadata.videoContentBasis, "page_metadata");
  assert.equal(result.metadata.videoTranscriptCount, undefined);
  assert.equal(result.videoTranscript, undefined);
});

test("DOM context v2 会跳过隐藏导航并产出结构与交互摘要", () => {
  const titleNode = createNode({
    tagName: "H1",
    textContent: "Guide to shipping a Safari AI sidebar",
  });
  const paragraphOne = createNode({
    tagName: "P",
    textContent: "This guide explains how to build a stable Safari AI sidebar with DOM-first extraction.",
  });
  const paragraphTwo = createNode({
    tagName: "P",
    textContent: "It covers candidate roots, visible block scoring, prompt shaping, and safe interaction design.",
  });
  const list = createNode({
    tagName: "UL",
    children: [
      createNode({ tagName: "LI", textContent: "Root selection" }),
      createNode({ tagName: "LI", textContent: "Visible block filtering" }),
    ],
  });
  const table = createNode({
    tagName: "TABLE",
    children: [
      createNode({ tagName: "TR", children: [createNode({ tagName: "TD", textContent: "GitHub" })] }),
    ],
  });
  const code = createNode({
    tagName: "PRE",
    textContent: "const context = extractPageContext(window, document);",
  });
  const visibleButton = createNode({
    tagName: "BUTTON",
    textContent: "Open settings",
    rect: { top: 80, left: 40, width: 120, height: 30, right: 160, bottom: 110 },
  });
  const visibleLink = createNode({
    tagName: "A",
    textContent: "Read docs",
    attrs: { href: "https://example.com/docs" },
    rect: { top: 140, left: 40, width: 90, height: 24, right: 130, bottom: 164 },
  });
  const iframeNode = createNode({ tagName: "IFRAME", attrs: { src: "https://example.com/embed" } });
  const shadowHost = createNode({
    tagName: "DIV",
    textContent: "Shadow host",
    shadowRoot: {},
  });
  const main = createNode({
    tagName: "MAIN",
    children: [
      titleNode,
      paragraphOne,
      paragraphTwo,
      list,
      table,
      code,
      visibleButton,
      visibleLink,
      iframeNode,
      shadowHost,
    ],
  });
  const hiddenNav = createNode({
    tagName: "NAV",
    textContent: "Pricing Docs Changelog",
    computedStyle: { display: "block", visibility: "visible", opacity: "1" },
  });
  const body = createNode({
    tagName: "BODY",
    children: [hiddenNav, main],
  });

  const doc = createDocument({
    title: "Safari Sidebar Guide",
    body,
    selectors: {
      main,
      body,
    },
  });

  const win = createWindow({
    href: "https://docs.example.com/guide/sidebar",
    hostname: "docs.example.com",
    pathname: "/guide/sidebar",
  });

  const result = extractPageContext(win, doc);

  assert.equal(result.metadata.contentStrategy, "generic_main");
  assert.equal(result.metadata.tableCount, "1");
  assert.equal(result.metadata.codeBlockCount, "1");
  assert.equal(result.metadata.hasIframes, "true");
  assert.equal(result.metadata.hasShadowHosts, "true");
  assert.match(result.articleText, /Guide to shipping a Safari AI sidebar/);
  assert.doesNotMatch(result.articleText, /Pricing Docs Changelog/);
  assert.match(result.structureSummary, /block_counts: headings=1, paragraphs=2, lists=1, tables=1, code_blocks=1/);
  assert.match(result.interactiveSummary, /label=Open settings/);
  assert.match(result.interactiveSummary, /label=Read docs/);
  assert.equal(Array.isArray(result.interactiveTargets), true);
  assert.equal(result.interactiveTargets.length, 2);
  assert.equal(result.interactiveTargets[0].id, "target_1");
  assert.equal(
    result.interactiveTargets[0].selectorHint,
    "body > main:nth-of-type(1) > button:nth-of-type(1)"
  );
  assert.deepEqual(result.interactiveTargets[0].rect, {
    top: 80,
    left: 40,
    width: 120,
    height: 30,
  });
});

test("interactiveSummary 会按页面位置稳定排序并过滤隐藏元素", () => {
  const hiddenButton = createNode({
    tagName: "BUTTON",
    textContent: "Hidden action",
    computedStyle: { display: "none", visibility: "visible", opacity: "1" },
    rect: { top: 20, left: 20, width: 120, height: 32, right: 140, bottom: 52 },
  });
  const firstButton = createNode({
    tagName: "BUTTON",
    textContent: "First visible",
    rect: { top: 40, left: 60, width: 120, height: 32, right: 180, bottom: 72 },
  });
  const secondButton = createNode({
    tagName: "BUTTON",
    textContent: "Second visible",
    rect: { top: 120, left: 60, width: 120, height: 32, right: 180, bottom: 152 },
  });
  const body = createNode({
    tagName: "BODY",
    children: [
      createNode({ tagName: "MAIN", textContent: "Useful content ".repeat(20) }),
      hiddenButton,
      secondButton,
      firstButton,
    ],
  });

  const doc = createDocument({
    title: "Interactive ordering",
    body,
    selectors: {
      main: body.children[0],
      body,
    },
  });

  const win = createWindow({
    href: "https://example.com/app",
    hostname: "example.com",
    pathname: "/app",
  });

  const result = extractPageContext(win, doc);
  const lines = result.interactiveSummary.split("\n");

  assert.match(lines[0], /First visible/);
  assert.match(lines[1], /Second visible/);
  assert.equal(result.interactiveSummary.includes("Hidden action"), false);
});

function createDocument({
  title,
  activeElement = null,
  body = null,
  documentElement = null,
  selectors = {},
  selectorAll = {},
}) {
  const resolvedBody = body ?? selectors.body ?? null;
  const resolvedDocumentElement =
    documentElement ??
    (resolvedBody
      ? createNode({
          tagName: "HTML",
        })
      : null);

  return {
    title,
    activeElement,
    body: resolvedBody,
    documentElement: resolvedDocumentElement,
    querySelector(selector) {
      return selectors[selector] ?? null;
    },
    querySelectorAll(selector) {
      return selectorAll[selector] ?? [];
    },
  };
}

function createNode({
  tagName = "DIV",
  textContent,
  attrs = {},
  contentEditable = "inherit",
  children = [],
  computedStyle = { display: "block", visibility: "visible", opacity: "1" },
  rect = { top: 0, left: 0, width: 120, height: 32, right: 120, bottom: 32 },
  type = "text",
  disabled = false,
  readOnly = false,
  shadowRoot = null,
  duration = undefined,
  currentTime = undefined,
  textTracks = [],
}) {
  const derivedText =
    textContent ??
    children
      .map((child) => child.textContent ?? child.innerText ?? "")
      .join(" ")
      .trim();

  const node = {
    tagName,
    type,
    disabled,
    readOnly,
    textContent: derivedText,
    innerText: derivedText,
    contentEditable,
    isContentEditable: contentEditable === "true",
    children,
    childNodes: children,
    computedStyle,
    rect,
    shadowRoot,
    duration,
    currentTime,
    textTracks,
    getAttribute(key) {
      return attrs[key] ?? null;
    },
    getBoundingClientRect() {
      return rect;
    },
  };

  for (const child of children) {
    child.parentElement = node;
  }

  return node;
}

function createWindow({ href, hostname, pathname, selection = "" }) {
  return {
    location: { href, hostname, pathname },
    innerWidth: 1440,
    innerHeight: 900,
    getSelection() {
      return {
        toString() {
          return selection;
        },
      };
    },
    getComputedStyle(node) {
      return node.computedStyle || {
        display: "block",
        visibility: "visible",
        opacity: "1",
        backgroundColor: "rgba(0, 0, 0, 0)",
        backgroundImage: "none",
        colorScheme: "normal",
      };
    },
  };
}
