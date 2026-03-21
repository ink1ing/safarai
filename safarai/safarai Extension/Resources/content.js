import { createErrorResponse, createSuccessResponse } from "./protocol.js";
import { extractPageContext } from "./page-context.js";
import {
  applyDraftToElement,
  clearHighlight,
  copyDraftFallback,
  describeWriteTarget,
  highlightElement,
  isWritableElement,
  resolveWritableTarget,
} from "./write-target.js";

let activeWriteTarget = null;
let lastKnownURL = window.location.href;

patchHistoryMethods();

queueContextSync();

browser.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case "content:get-page-context":
      return handleGetPageContext();
    case "content:prepare-focused-input":
      return handlePrepareFocusedInput();
    case "content:apply-draft":
      return handleApplyDraft(message.payload?.draft);
    default:
      return undefined;
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    queueContextSync();
  }
});

window.addEventListener("focus", () => {
  queueContextSync();
});

window.addEventListener("popstate", () => {
  queueContextSync();
});

window.addEventListener("hashchange", () => {
  queueContextSync();
});

document.addEventListener("yt-navigate-finish", () => {
  queueContextSync();
});

setInterval(() => {
  if (window.location.href !== lastKnownURL) {
    lastKnownURL = window.location.href;
    queueContextSync();
  }
}, 1000);

function handleGetPageContext() {
  try {
    return Promise.resolve(
      createSuccessResponse({
        context: extractPageContext(window, document),
      })
    );
  } catch (error) {
    return Promise.resolve(
      createErrorResponse("page_context_failed", `页面解析失败：${error.message}`)
    );
  }
}

function handlePrepareFocusedInput() {
  const pageContext = extractPageContext(window, document);
  const target = resolveWritableTarget(document, document.activeElement, {
    site: pageContext.site,
    ...pageContext.metadata,
  });
  if (!isWritableElement(target)) {
    return Promise.resolve(
      createErrorResponse("focused_input_missing", "请先点击 GitHub 评论输入框")
    );
  }

  activeWriteTarget = target;
  highlightElement(target);

  return Promise.resolve(
    createSuccessResponse({
      target: describeWriteTarget(target, pageContext.metadata),
    })
  );
}

function handleApplyDraft(draft) {
  const pageContext = extractPageContext(window, document);
  const target = resolveWritableTarget(
    document,
    activeWriteTarget && document.contains(activeWriteTarget)
      ? activeWriteTarget
      : document.activeElement,
    {
      site: pageContext.site,
      ...pageContext.metadata,
    }
  );

  if (!isWritableElement(target)) {
    const copied = copyDraftFallback(window, document, draft);
    if (copied) {
      clearHighlight(document);
      activeWriteTarget = null;
      return Promise.resolve(
        createSuccessResponse({
          mode: "clipboard",
          answer: "输入目标已丢失，草稿已降级复制到剪贴板，未自动提交。",
        })
      );
    }

    return Promise.resolve(
      createErrorResponse("write_target_lost", "输入目标已丢失，请重新点击输入框并生成草稿")
    );
  }

  const applied = applyDraftToElement(target, draft ?? "");
  if (!applied) {
    const copied = copyDraftFallback(window, document, draft);
    if (copied) {
      clearHighlight(document);
      activeWriteTarget = null;
      return Promise.resolve(
        createSuccessResponse({
          mode: "clipboard",
          answer: "当前输入框写入失败，草稿已降级复制到剪贴板，未自动提交。",
        })
      );
    }

    return Promise.resolve(
      createErrorResponse("write_failed", "当前输入框写入失败")
    );
  }

  clearHighlight(document);
  activeWriteTarget = target;

  return Promise.resolve(
    createSuccessResponse({
      mode: "page",
      answer: "草稿已写入页面，未自动提交。",
      target: describeWriteTarget(target, extractPageContext(window, document).metadata),
    })
  );
}

function queueContextSync() {
  setTimeout(() => {
    try {
      lastKnownURL = window.location.href;
      const context = extractPageContext(window, document);
      browser.runtime.sendMessage({
        type: "content:page-updated",
        payload: { context },
      }).catch(() => {});
    } catch {
      // Ignore transient DOM read failures during page bootstrap.
    }
  }, 0);
}

function patchHistoryMethods() {
  const wrap = (methodName) => {
    const original = window.history[methodName];
    if (typeof original !== "function") {
      return;
    }

    window.history[methodName] = function (...args) {
      const result = original.apply(this, args);
      queueContextSync();
      return result;
    };
  };

  wrap("pushState");
  wrap("replaceState");
}
