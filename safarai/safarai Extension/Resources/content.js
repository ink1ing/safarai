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
let interactiveTargetIndex = new Map();
let latestInteractiveTargets = [];
let lastStableSelection = "";
let lastStableSelectionURL = window.location.href;

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
    case "content:highlight-target":
      return handleInteractiveTargetCommand("highlight", message.payload);
    case "content:focus-target":
      return handleInteractiveTargetCommand("focus", message.payload);
    case "content:scroll-to-target":
      return handleInteractiveTargetCommand("scroll", message.payload);
    default:
      return undefined;
  }
});

document.addEventListener("selectionchange", () => {
  rememberCurrentSelection();
  syncStableSelection();
  queueContextSync();
});

document.addEventListener("mouseup", () => {
  rememberCurrentSelection();
  syncStableSelection();
});

document.addEventListener("keyup", () => {
  rememberCurrentSelection();
  syncStableSelection();
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
    lastStableSelection = "";
    lastStableSelectionURL = window.location.href;
    queueContextSync();
  }
}, 1000);

function handleGetPageContext() {
  try {
    const context = extractContextSnapshot();
    return Promise.resolve(
      createSuccessResponse({
        context,
      })
    );
  } catch (error) {
    return Promise.resolve(
      createErrorResponse("page_context_failed", `页面解析失败：${error.message}`)
    );
  }
}

function handlePrepareFocusedInput() {
  const pageContext = extractContextSnapshot();
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
  const pageContext = extractContextSnapshot();
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
        target: describeWriteTarget(target, extractContextSnapshot().metadata),
      })
  );
}

function handleInteractiveTargetCommand(action, payload = {}) {
  const target = resolveInteractiveTarget(payload.targetId, payload.selectorHint);
  if (!target) {
    return Promise.resolve(
      createErrorResponse("target_not_found", "目标元素不存在或已失效")
    );
  }

  if (action === "highlight") {
    highlightElement(target);
  } else if (action === "focus") {
    target.focus?.();
    highlightElement(target);
  } else if (action === "scroll") {
    target.scrollIntoView?.({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
    highlightElement(target);
  }

  return Promise.resolve(
    createSuccessResponse({
      target: {
        id: payload.targetId || "",
        description:
          payload.label ||
          describeWriteTarget(target, extractContextSnapshot().metadata)?.description ||
          "",
      },
    })
  );
}

function queueContextSync() {
  setTimeout(() => {
    try {
      lastKnownURL = window.location.href;
      const context = extractContextSnapshot();
      browser.runtime.sendMessage({
        type: "content:page-updated",
        payload: { context },
      }).catch(() => {});
    } catch {
      // Ignore transient DOM read failures during page bootstrap.
    }
  }, 0);
}

function syncStableSelection() {
  const selection = String(lastStableSelection || "").trim();
  if (!selection) {
    return;
  }

  browser.runtime.sendMessage({
    type: "content:selection-updated",
    payload: {
      url: window.location.href,
      selection,
    },
  }).catch(() => {});
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

function extractContextSnapshot() {
  const context = extractPageContext(window, document);
  const liveSelection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  const selection = String(context.selection || "").trim();
  if (selection) {
    lastStableSelection = selection;
    lastStableSelectionURL = window.location.href;
  } else if (
    lastStableSelection &&
    lastStableSelectionURL === window.location.href
  ) {
    context.selection = lastStableSelection;
  } else if (lastStableSelectionURL !== window.location.href) {
    lastStableSelection = "";
    lastStableSelectionURL = window.location.href;
  }
  interactiveTargetIndex = context.__interactiveTargetIndex ?? new Map();
  latestInteractiveTargets = Array.isArray(context.interactiveTargets)
    ? context.interactiveTargets
    : [];
  context.debugSelection = {
    contentLiveSelection: truncateDebugValue(liveSelection),
    contentStableSelection: truncateDebugValue(lastStableSelection),
    contentSelectionURL: truncateDebugValue(lastStableSelectionURL),
  };
  return context;
}

function rememberCurrentSelection() {
  const selection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  if (!selection) {
    return;
  }

  lastStableSelection = selection;
  lastStableSelectionURL = window.location.href;
}

function truncateDebugValue(value) {
  const text = String(value || "").trim();
  if (text.length <= 160) {
    return text;
  }
  return `${text.slice(0, 157)}...`;
}

function resolveInteractiveTarget(targetId, selectorHint) {
  if (targetId) {
    const direct = interactiveTargetIndex.get(targetId);
    if (direct && document.contains(direct)) {
      return direct;
    }

    const knownTarget = latestInteractiveTargets.find((item) => item.id === targetId);
    if (knownTarget?.selectorHint) {
      const resolved = queryInteractiveSelector(knownTarget.selectorHint);
      if (resolved) {
        interactiveTargetIndex.set(targetId, resolved);
        return resolved;
      }
    }
  }

  if (selectorHint) {
    return queryInteractiveSelector(selectorHint);
  }

  return null;
}

function queryInteractiveSelector(selectorHint) {
  if (!selectorHint) {
    return null;
  }

  try {
    return document.querySelector(selectorHint);
  } catch {
    return null;
  }
}
