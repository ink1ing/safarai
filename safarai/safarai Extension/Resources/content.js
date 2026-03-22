let activeWriteTarget = null;
let lastKnownURL = window.location.href;
let interactiveTargetIndex = new Map();
let latestInteractiveTargets = [];
let lastStableSelection = "";
let lastStableSelectionURL = window.location.href;
let contextSyncTimer = null;
const sharedModulesPromise = loadSharedModules();

patchHistoryMethods();
observeVisualChanges();
observeSystemAppearance();

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
  return (async () => {
    try {
      const context = await extractContextSnapshot();
      return createSuccessResponseLite({
        context,
      });
    } catch (error) {
      return createSuccessResponseLite({
        context: buildLightweightPageContext(),
        degraded: true,
        warning: `页面解析已降级：${error.message}`,
      });
    }
  })();
}

function handlePrepareFocusedInput() {
  return (async () => {
    const {
      createErrorResponse,
      createSuccessResponse,
      describeWriteTarget,
      highlightElement,
      isWritableElement,
      resolveWritableTarget,
    } = await sharedModulesPromise;
    const pageContext = await extractContextSnapshot();
    const target = resolveWritableTarget(document, document.activeElement, {
      site: pageContext.site,
      ...pageContext.metadata,
    });
    if (!isWritableElement(target)) {
      return createErrorResponse("focused_input_missing", "请先点击 GitHub 评论输入框");
    }

    activeWriteTarget = target;
    highlightElement(target);

    return createSuccessResponse({
      target: describeWriteTarget(target, pageContext.metadata),
    });
  })();
}

function handleApplyDraft(draft) {
  return (async () => {
    const {
      applyDraftToElement,
      clearHighlight,
      copyDraftFallback,
      createErrorResponse,
      createSuccessResponse,
      describeWriteTarget,
      isWritableElement,
      resolveWritableTarget,
    } = await sharedModulesPromise;
    const pageContext = await extractContextSnapshot();
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
        return createSuccessResponse({
          mode: "clipboard",
          answer: "输入目标已丢失，草稿已降级复制到剪贴板，未自动提交。",
        });
      }

      return createErrorResponse("write_target_lost", "输入目标已丢失，请重新点击输入框并生成草稿");
    }

    const applied = applyDraftToElement(target, draft ?? "");
    if (!applied) {
      const copied = copyDraftFallback(window, document, draft);
      if (copied) {
        clearHighlight(document);
        activeWriteTarget = null;
        return createSuccessResponse({
          mode: "clipboard",
          answer: "当前输入框写入失败，草稿已降级复制到剪贴板，未自动提交。",
        });
      }

      return createErrorResponse("write_failed", "当前输入框写入失败");
    }

    clearHighlight(document);
    activeWriteTarget = target;
    const latestContext = await extractContextSnapshot();

    return createSuccessResponse({
      mode: "page",
      answer: "草稿已写入页面，未自动提交。",
      target: describeWriteTarget(target, latestContext.metadata),
    });
  })();
}

function handleInteractiveTargetCommand(action, payload = {}) {
  return (async () => {
    const {
      createErrorResponse,
      createSuccessResponse,
      describeWriteTarget,
      highlightElement,
    } = await sharedModulesPromise;
    const target = resolveInteractiveTarget(payload.targetId, payload.selectorHint);
    if (!target) {
      return createErrorResponse("target_not_found", "目标元素不存在或已失效");
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

    const latestContext = await extractContextSnapshot();
    return createSuccessResponse({
      target: {
        id: payload.targetId || "",
        description:
          payload.label ||
          describeWriteTarget(target, latestContext.metadata)?.description ||
          "",
      },
    });
  })();
}

function queueContextSync() {
  if (contextSyncTimer) {
    clearTimeout(contextSyncTimer);
  }

  contextSyncTimer = setTimeout(() => {
    contextSyncTimer = null;
    (async () => {
      try {
        lastKnownURL = window.location.href;
        const context = await extractContextSnapshot();
        browser.runtime.sendMessage({
          type: "content:page-updated",
          payload: { context },
        }).catch(() => {});
      } catch {
        // Ignore transient DOM read failures during page bootstrap.
      }
    })();
  }, 120);
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

async function extractContextSnapshot() {
  let context;
  try {
    const { extractPageContext } = await sharedModulesPromise;
    context = extractPageContext(window, document);
  } catch {
    context = buildLightweightPageContext();
  }
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

async function loadSharedModules() {
  const runtimeGetURL =
    typeof browser?.runtime?.getURL === "function"
      ? browser.runtime.getURL.bind(browser.runtime)
      : (path) => path;
  const [protocolModule, pageContextModule, writeTargetModule] = await Promise.all([
    import(runtimeGetURL("protocol.js")),
    import(runtimeGetURL("page-context.js")),
    import(runtimeGetURL("write-target.js")),
  ]);

  return {
    ...protocolModule,
    ...pageContextModule,
    ...writeTargetModule,
  };
}

function createSuccessResponseLite(payload = {}) {
  return {
    ok: true,
    payload,
  };
}

function buildLightweightPageContext() {
  const visual = extractVisualStateLite();
  const hostname = window.location.hostname || "";
  const pathname = window.location.pathname || "";
  const selection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  const title = document.title || "Untitled";
  const mainText =
    normalizeLiteText(document.querySelector("main")?.innerText) ||
    normalizeLiteText(document.querySelector("article")?.innerText) ||
    "";

  return {
    site: detectSiteLite(hostname),
    url: window.location.href,
    title,
    selection,
    articleText: mainText || `title: ${title}\nurl: ${window.location.href}`,
    structureSummary: "",
    interactiveSummary: "",
    interactiveTargets: [],
    focusedInput: null,
    metadata: {
      domain: hostname,
      pageKind: inferPageKindLite(hostname, pathname),
      contentStrategy: "lightweight_visual_probe",
      pageBackgroundColor: visual.backgroundColor,
      pageBackgroundImage: visual.backgroundImage,
      pageColorScheme: visual.colorScheme,
      pageBackgroundSource: visual.source,
      headingCount: "0",
      interactiveCount: "0",
      tableCount: "0",
      codeBlockCount: "0",
      hasIframes: document.querySelector("iframe") ? "true" : "false",
      hasShadowHosts: "false",
    },
  };
}

function extractVisualStateLite() {
  const candidates = [
    document.querySelector("[data-testid='primaryColumn']"),
    document.querySelector("main"),
    document.querySelector("article"),
    document.body,
    document.documentElement,
  ].filter(Boolean);

  let fallbackImage = "none";
  let fallbackScheme = "";

  for (const candidate of candidates) {
    let current = candidate;
    while (current) {
      const computedStyle = getComputedStyle(current);
      const backgroundImage = String(computedStyle.backgroundImage || "").trim() || "none";
      const backgroundColor = String(computedStyle.backgroundColor || "").trim();
      const colorScheme = normalizeColorSchemeLite(computedStyle.colorScheme);

      if (!fallbackScheme && colorScheme) {
        fallbackScheme = colorScheme;
      }
      if (fallbackImage === "none" && backgroundImage !== "none") {
        fallbackImage = backgroundImage;
      }
      if (backgroundColor && !isTransparentLite(backgroundColor)) {
        return {
          backgroundColor,
          backgroundImage: backgroundImage !== "none" ? backgroundImage : fallbackImage,
          colorScheme: colorScheme || fallbackScheme || inferSchemeFromColorLite(backgroundColor),
          source: describeNodeLite(current),
        };
      }
      current = current.parentElement;
    }
  }

  const fallbackColor = fallbackScheme === "light" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
  return {
    backgroundColor: fallbackColor,
    backgroundImage: fallbackImage,
    colorScheme: fallbackScheme || inferSchemeFromColorLite(fallbackColor),
    source: "lightweight_fallback",
  };
}

function detectSiteLite(hostname) {
  if (hostname.includes("github.com")) return "github";
  if (hostname.includes("mail.google.com")) return "gmail";
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter.com")) {
    return "x";
  }
  if (hostname.includes("mail.yahoo.com")) return "yahoo_mail";
  return "unsupported";
}

function inferPageKindLite(hostname, pathname) {
  const site = detectSiteLite(hostname);
  if (site === "x") {
    if (/\/status\/\d+/.test(pathname)) return "x_post";
    if (pathname === "/home") return "x_home";
  }
  if (site === "github") return "github_page";
  if (site === "gmail") return "gmail_page";
  if (site === "yahoo_mail") return "yahoo_mail_page";
  return "page";
}

function normalizeLiteText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 12000);
}

function describeNodeLite(node) {
  if (!node) return "unknown";
  const tag = String(node.tagName || "").toLowerCase() || "unknown";
  const id = node.id ? `#${node.id}` : "";
  return `${tag}${id}`;
}

function normalizeColorSchemeLite(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("dark") && !normalized.includes("light")) return "dark";
  if (normalized.includes("light") && !normalized.includes("dark")) return "light";
  return "";
}

function isTransparentLite(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)";
}

function inferSchemeFromColorLite(value) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)/);
  if (!match) {
    return "dark";
  }
  const red = Number.parseFloat(match[1]);
  const green = Number.parseFloat(match[2]);
  const blue = Number.parseFloat(match[3]);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance >= 0.6 ? "light" : "dark";
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

function observeVisualChanges() {
  const root = document.documentElement;
  if (!root || typeof MutationObserver !== "function") {
    return;
  }

  const observer = new MutationObserver(() => {
    queueContextSync();
  });

  observer.observe(root, {
    attributes: true,
    childList: true,
    subtree: true,
  });
}

function observeSystemAppearance() {
  if (typeof window.matchMedia !== "function") {
    return;
  }

  try {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", () => queueContextSync());
      return;
    }
    if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(() => queueContextSync());
    }
  } catch {
    // Ignore unsupported matchMedia environments.
  }
}
