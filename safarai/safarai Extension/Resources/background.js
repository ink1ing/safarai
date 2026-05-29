import {
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isSupportedSite,
} from "./protocol.js";
import { appendLog, loadLogs } from "./log-store.js";
import { loadSession, saveSession } from "./session-store.js";

const TAB_STATE = new Map();
const TAB_RESYNC_TIMERS = new Map();
const TAB_SYNC_RETRY_DELAYS = [120, 420, 1000, 2200, 4200, 7000];
const SELECTION_CONTEXT_MENU_ID = "ask-selected-text";

browser.runtime.onInstalled.addListener(() => {
  console.log("Safari AI background ready");
  createSelectionContextMenu();
});

createSelectionContextMenu();

setInterval(() => {
  syncActiveTabSnapshot().catch(() => {});
}, 700);

if (browser.tabs?.onUpdated) {
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!tabId || (!changeInfo.url && changeInfo.status !== "complete")) {
      return;
    }

    if (changeInfo.url) {
      await syncTabFallbackContext(tabId, {
        ...tab,
        url: changeInfo.url,
      }, "tabs.onUpdated:url");
    }

    await syncTabContext(tabId, tab, "tabs.onUpdated");
    scheduleTabContextResync(tabId, "tabs.onUpdated");
  });
}

if (browser.tabs?.onActivated) {
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await browser.tabs.get(activeInfo.tabId).catch(() => null);
    if (!tab?.id) {
      return;
    }

    await syncTabContext(tab.id, tab, "tabs.onActivated");
    scheduleTabContextResync(tab.id, "tabs.onActivated");
  });
}

if (browser.windows?.onFocusChanged) {
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) {
      return;
    }

    const [tab] = await browser.tabs.query({ active: true, windowId }).catch(() => []);
    if (!tab?.id) {
      return;
    }

    await syncTabContext(tab.id, tab, "windows.onFocusChanged");
    scheduleTabContextResync(tab.id, "windows.onFocusChanged");
  });
}

if (browser.action?.onClicked) {
  browser.action.onClicked.addListener(async (tab) => {
    const tabId = tab?.id ?? null;
    const contextResult = tabId
      ? await requestPageContext(tabId)
      : await ensurePageContext(tabId);
    const context = contextResult.ok ? contextResult.payload?.context ?? {} : {};
    if (tabId && contextResult.ok) {
      TAB_STATE.set(tabId, mergeStableSelection(TAB_STATE.get(tabId), context, "action.onClicked"));
    }
    const stableContext = tabId ? TAB_STATE.get(tabId) ?? context : context;
    const messages = tabId ? await loadSession(tabId) : [];
    await sendNativeControlRequest("sync_panel_state", {
      context: stableContext,
      messages,
    });
    await sendNativeControlRequest("show_panel", {
      context: stableContext,
      messages,
    });
  });
}

if (browser.contextMenus?.onClicked) {
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== SELECTION_CONTEXT_MENU_ID) {
      return;
    }
    await handleSelectionContextMenu(info, tab);
  });
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") {
    return Promise.resolve(
      createErrorResponse("invalid_message", "消息格式无效")
    );
  }

  switch (message.type) {
    case "sidebar:get-page-context":
      return loadPageContextForActiveTab();
    case "sidebar:get-provider-status":
      return getProviderStatus();
    case "sidebar:start-codex-login":
      return startCodexLogin();
    case "sidebar:logout-codex":
      return logoutCodex();
    case "sidebar:refresh-codex-models":
      return refreshCodexModels();
    case "sidebar:save-selected-model":
      return saveSelectedModel(message.payload?.selectedModel);
    case "sidebar:summarize-page":
      return summarizePage(sender.tab?.id);
    case "sidebar:explain-selection":
      return explainSelection(sender.tab?.id);
    case "sidebar:extract-structured-info":
      return extractStructuredInfo(sender.tab?.id);
    case "sidebar:generate-draft":
      return generateDraftForFocusedInput(sender.tab?.id);
    case "sidebar:apply-draft":
      return applyDraftToFocusedInput(sender.tab?.id, message.payload?.draft);
    case "sidebar:highlight-target":
      return performTargetAction(sender.tab?.id, "highlight", message.payload?.targetId);
    case "sidebar:focus-target":
      return performTargetAction(sender.tab?.id, "focus", message.payload?.targetId);
    case "sidebar:scroll-to-target":
      return performTargetAction(sender.tab?.id, "scroll", message.payload?.targetId);
    case "sidebar:get-session":
      return getSession(sender.tab?.id);
    case "sidebar:ask-page":
      return askPage(sender.tab?.id, message.payload?.prompt, message.payload?.selection);
    case "sidebar:get-logs":
      return getLogs();
    case "native:sample-video-frames":
      return sampleVideoFramesForActiveTab();
    case "content:selection-updated":
      return syncSelectionFromContent(sender.tab?.id, message.payload);
    case "content:page-updated":
      return syncPanelStateFromContent(sender.tab?.id, message.payload?.context);
    case "content:fetch-transcript-url":
      return fetchTranscriptURL(message.payload?.url);
    case "content:youtube-transcript":
      return fetchYouTubeTranscriptInner(message.payload?.videoId);
    case "content:sample-video-frames":
      return sampleVideoFramesForTab(sender.tab?.id);
    default:
      return Promise.resolve(
        createErrorResponse("unsupported_message", `不支持的消息类型: ${message.type}`)
      );
  }
});

async function loadPageContextForActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return fail("tab_not_found", "未找到当前标签页", { action: "load_page_context" });
  }

  const pageContext = await requestPageContext(tab.id);
  if (!pageContext.ok) {
    return pageContext;
  }

  TAB_STATE.set(
    tab.id,
    mergeStableSelection(TAB_STATE.get(tab.id), pageContext.payload.context, "loadPageContextForActiveTab")
  );
  await syncPanelState(tab.id, TAB_STATE.get(tab.id));
  await appendLog({
    level: "info",
    action: "load_page_context",
    site: pageContext.payload.context.site,
    pageKind: pageContext.payload.context.metadata?.pageKind ?? null,
  });
  return pageContext;
}

async function syncActiveTabSnapshot() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return;
  }

  await syncTabContext(tab.id, tab, "syncActiveTabSnapshot");
}

async function syncPanelStateFromContent(tabId, context) {
  if (!context) {
    return createSuccessResponse({ synced: false });
  }

  const resolvedTabId = await resolveTabId(tabId);
  if (!resolvedTabId) {
    return createSuccessResponse({ synced: false });
  }
  if (!(await shouldSyncPanelForTab(resolvedTabId, context))) {
    return createSuccessResponse({ synced: false, skipped: "inactive_or_detached" });
  }

  TAB_STATE.set(
    resolvedTabId,
    mergeStableSelection(
      TAB_STATE.get(resolvedTabId),
      {
        ...context,
        metadata: {
          ...(context.metadata ?? {}),
          pageContextTransport: "content_event",
          pageContextUpdatedAt: new Date().toISOString(),
          pageContextFallbackReason: "",
          pageContextError: "",
        },
      },
      "content:page-updated"
    )
  );
  cancelScheduledTabResync(resolvedTabId);
  await syncPanelState(resolvedTabId, TAB_STATE.get(resolvedTabId));
  return createSuccessResponse({ synced: true });
}

async function syncSelectionFromContent(tabId, payload) {
  const resolvedTabId = await resolveTabId(tabId);
  if (!resolvedTabId) {
    return createSuccessResponse({ synced: false });
  }

  const nextSelection = String(payload?.selection ?? "").trim();
  if (!nextSelection) {
    return createSuccessResponse({ synced: false });
  }

  const currentContext = TAB_STATE.get(resolvedTabId) ?? {};
  const nextURL = String(payload?.url ?? currentContext.url ?? "");
  const nextContext = {
    ...currentContext,
    url: nextURL,
    selection: nextSelection,
    debugSelection: {
      ...(currentContext.debugSelection ?? {}),
      backgroundSelectionMessage: truncateDebugValue(nextSelection),
      backgroundSelectionURL: truncateDebugValue(nextURL),
    },
  };

  TAB_STATE.set(resolvedTabId, nextContext);
  await sendNativeControlRequest("sync_selection_intent", {
    url: nextURL,
    selection: nextSelection,
  });
  await syncPanelState(resolvedTabId, nextContext);
  return createSuccessResponse({ synced: true });
}

async function getProviderStatus() {
  return sendNativeControlRequest("get_status", {});
}

async function startCodexLogin() {
  return sendNativeControlRequest("start_login", {});
}

async function logoutCodex() {
  return sendNativeControlRequest("logout", {});
}

async function refreshCodexModels() {
  return sendNativeControlRequest("refresh_models", {});
}

async function saveSelectedModel(selectedModel) {
  return sendNativeControlRequest("save_selected_model", {
    selectedModel: String(selectedModel ?? ""),
  });
}

async function summarizePage(tabIdFromSender) {
  const contextResult = await ensurePageContext(tabIdFromSender);
  if (!contextResult.ok) {
    return contextResult;
  }

  const response = await sendNativeRequest("summarize_page", contextResult.payload.context);
  return withSession(
    tabIdFromSender,
    response,
    {
      role: "user",
      kind: "action",
      text: "总结当前页面",
    },
    response.ok
      ? {
          role: "assistant",
          kind: "answer",
          text: response.payload?.answer ?? "",
        }
      : null
  );
}

async function explainSelection(tabIdFromSender) {
  const contextResult = await ensurePageContext(tabIdFromSender);
  if (!contextResult.ok) {
    return contextResult;
  }

  const response = await sendNativeRequest("explain_selection", contextResult.payload.context);
  return withSession(
    tabIdFromSender,
    response,
    {
      role: "user",
      kind: "action",
      text: "解释选中文本",
    },
    response.ok
      ? {
          role: "assistant",
          kind: "answer",
          text: response.payload?.answer ?? "",
        }
      : null
  );
}

async function extractStructuredInfo(tabIdFromSender) {
  const contextResult = await ensurePageContext(tabIdFromSender);
  if (!contextResult.ok) {
    return contextResult;
  }

  const response = await sendNativeRequest("extract_structured_info", contextResult.payload.context);
  return withSession(
    tabIdFromSender,
    response,
    {
      role: "user",
      kind: "action",
      text: "提取结构化信息",
    },
    response.ok
      ? {
          role: "assistant",
          kind: "answer",
          text: response.payload?.answer ?? "",
        }
      : null
  );
}

async function generateDraftForFocusedInput(tabIdFromSender) {
  const contextResult = await ensurePageContext(tabIdFromSender);
  if (!contextResult.ok) {
    return contextResult;
  }

  const tabId = await resolveTabId(tabIdFromSender);
  if (!tabId) {
    return createErrorResponse("tab_not_found", "未找到当前标签页");
  }

  const prepared = await requestFocusedInputPreparation(tabId);
  if (!prepared.ok) {
    return prepared;
  }

  const enrichedContext = {
    ...contextResult.payload.context,
    writeTarget: prepared.payload.target,
  };

  const response = await sendNativeRequest("draft_for_input", enrichedContext);
  if (!response.ok) {
    return response;
  }

  TAB_STATE.set(tabId, enrichedContext);
  await appendLog({
    level: "info",
    action: "generate_draft",
    site: enrichedContext.site,
    pageKind: enrichedContext.metadata?.pageKind ?? null,
    target: prepared.payload.target?.description ?? null,
  });
  return createSuccessResponse({
    ...response.payload,
    target: prepared.payload.target,
  });
}

async function applyDraftToFocusedInput(tabIdFromSender, draft) {
  const tabId = await resolveTabId(tabIdFromSender);
  if (!tabId) {
    return fail("tab_not_found", "未找到当前标签页", { action: "apply_draft" });
  }

  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: "content:apply-draft",
      payload: { draft: String(draft ?? "") },
    });

    if (!response?.ok) {
      return fail(
        response?.error?.code ?? "write_failed",
        response?.error?.message ?? "写入页面失败",
        { action: "apply_draft", mode: "page" }
      );
    }

    await appendLog({
      level: "info",
      action: "apply_draft",
      mode: response.payload?.mode ?? "page",
      target: response.payload?.target?.description ?? null,
    });

    return createSuccessResponse({
      target: response.payload?.target ?? null,
      mode: response.payload?.mode ?? "page",
      answer: response.payload?.answer ?? "草稿已写入页面，未自动提交。",
    });
  } catch (error) {
    return fail(
      "content_script_unreachable",
      `无法执行页面写入：${error.message}`,
      { action: "apply_draft" }
    );
  }
}

async function performTargetAction(tabIdFromSender, action, targetId) {
  const tabId = await resolveTabId(tabIdFromSender);
  if (!tabId) {
    return fail("tab_not_found", "未找到当前标签页", { action: `${action}_target` });
  }

  const contextResult = await ensurePageContext(tabId);
  if (!contextResult.ok) {
    return contextResult;
  }

  const target = findInteractiveTarget(contextResult.payload?.context, targetId);
  if (!target) {
    return createErrorResponse("target_not_found", "目标元素不存在或已失效");
  }

  const typeMap = {
    highlight: "content:highlight-target",
    focus: "content:focus-target",
    scroll: "content:scroll-to-target",
  };

  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: typeMap[action],
      payload: {
        targetId: target.id,
        selectorHint: target.selectorHint,
        label: target.label,
      },
    });

    if (!response?.ok) {
      return fail(
        response?.error?.code ?? "target_action_failed",
        response?.error?.message ?? "执行目标操作失败",
        { action: `${action}_target`, targetId }
      );
    }

    await appendLog({
      level: "info",
      action: `${action}_target`,
      site: contextResult.payload?.context?.site ?? null,
      pageKind: contextResult.payload?.context?.metadata?.pageKind ?? null,
      target: target.label ?? target.id,
    });

    return createSuccessResponse({
      action,
      target,
    });
  } catch (error) {
    return fail(
      "content_script_unreachable",
      `无法执行目标操作：${error.message}`,
      { action: `${action}_target`, targetId }
    );
  }
}

async function ensurePageContext(tabIdFromSender) {
  if (tabIdFromSender && TAB_STATE.has(tabIdFromSender)) {
    return createSuccessResponse({
      context: TAB_STATE.get(tabIdFromSender),
      cached: true,
    });
  }

  const fresh = await loadPageContextForActiveTab();
  if (!fresh.ok) {
    return fresh;
  }

  return createSuccessResponse({
      context: fresh.payload.context,
      cached: false,
    });
}

async function syncPanelState(tabId, context) {
  if (!(await shouldSyncPanelForTab(tabId, context))) {
    return;
  }
  const messages = tabId ? await loadSession(tabId) : [];
  await sendNativeControlRequest("sync_panel_state", {
    context,
    messages,
  });
}

async function askPage(tabIdFromSender, prompt, selectionFromPopup) {
  const userPrompt = String(prompt ?? "").trim();
  if (!userPrompt) {
    return createErrorResponse("empty_prompt", "请输入你的问题。");
  }

  const contextResult = await ensurePageContext(tabIdFromSender);
  if (!contextResult.ok) {
    return contextResult;
  }

  const tabId = await resolveTabId(tabIdFromSender);
  if (!tabId) {
    return createErrorResponse("tab_not_found", "未找到当前标签页");
  }

  const history = await loadSession(tabId);
  const selection = String(selectionFromPopup ?? contextResult.payload.context.selection ?? "").trim();
  const response = await sendNativeRequest("ask_page", {
    ...contextResult.payload.context,
    selectedFocus: selection,
    userPrompt,
    conversationHistory: history,
  });

  return withSession(
    tabId,
    response,
    {
      role: "user",
      kind: "question",
      text: userPrompt,
    },
    response.ok
      ? {
          role: "assistant",
          kind: "answer",
          text: response.payload?.answer ?? "",
        }
      : null
  );
}

async function resolveTabId(tabIdFromSender) {
  if (tabIdFromSender) {
    return tabIdFromSender;
  }

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function requestFocusedInputPreparation(tabId) {
  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: "content:prepare-focused-input",
    });

    if (!response?.ok) {
      return fail(
        response?.error?.code ?? "focused_input_missing",
        response?.error?.message ?? "当前没有可写输入框",
        { action: "prepare_input" }
      );
    }

    return response;
  } catch (error) {
    return fail(
      "content_script_unreachable",
      `无法定位输入框：${error.message}`,
      { action: "prepare_input" }
    );
  }
}

async function requestPageContext(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const cachedContext = TAB_STATE.get(tabId) ?? null;

  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: "content:get-page-context",
    });

    if (!response?.ok) {
      const directContext = await probePageContextDirectly(tabId, tab);
      if (directContext) {
        return createSuccessResponse({
          context: directContext,
          degraded: true,
        });
      }
      return createSuccessResponse(
        buildDegradedContextPayload(
          tab,
          cachedContext,
          response?.error?.code ?? "content_script_error",
          response?.error?.message ?? "content script returned a non-ok response"
        )
      );
    }

    const context = response.payload?.context;
    if (!context) {
      const directContext = await probePageContextDirectly(tabId, tab);
      if (directContext) {
        return createSuccessResponse({
          context: directContext,
          degraded: true,
        });
      }
      return createSuccessResponse(
        buildDegradedContextPayload(
          tab,
          cachedContext,
          "content_context_missing",
          "content script responded without context payload"
        )
      );
    }

    const normalizedSite = isSupportedSite(context.site) ? context.site : "unsupported";
    return createSuccessResponse({
      context: {
        ...context,
        site: normalizedSite,
        metadata: {
          ...(context.metadata ?? {}),
          pageContextTransport: "content_script",
          pageContextUpdatedAt: new Date().toISOString(),
          pageContextFallbackReason: "",
          pageContextError: "",
        },
      },
    });
  } catch (error) {
    const directContext = await probePageContextDirectly(tabId, tab);
    if (directContext) {
      return createSuccessResponse({
        context: directContext,
        degraded: true,
      });
    }
    return createSuccessResponse(
      buildDegradedContextPayload(
        tab,
        cachedContext,
        "content_script_unreachable",
        error?.message ?? String(error)
      )
    );
  }
}

async function syncTabContext(tabId, tab, source = "") {
  const effectiveTab = await resolveEffectiveTab(tabId, tab);
  if (!(await isFocusedActiveTab(tabId))) {
    return createSuccessResponse({
      context: TAB_STATE.get(tabId) ?? buildFallbackContext(effectiveTab),
      skipped: "inactive_tab",
    });
  }
  triggerContentSync(tabId).catch(() => {});
  const contextResult = await requestPageContext(tabId);
  const context = contextResult.ok
    ? contextResult.payload?.context ?? buildFallbackContext(effectiveTab)
    : buildFallbackContext(effectiveTab);

  TAB_STATE.set(tabId, mergeStableSelection(TAB_STATE.get(tabId), context, source));
  await syncPanelState(tabId, TAB_STATE.get(tabId));
  return contextResult;
}

async function syncTabFallbackContext(tabId, tab, source = "") {
  if (!tabId) {
    return;
  }
  if (!(await isFocusedActiveTab(tabId))) {
    return;
  }

  const effectiveTab = await resolveEffectiveTab(tabId, tab);
  const fallbackContext = buildFallbackContext(effectiveTab, {
    reason: source,
    errorMessage: "Waiting for the page content script to publish a fresh context.",
  });

  TAB_STATE.set(tabId, mergeStableSelection(TAB_STATE.get(tabId), fallbackContext, source));
  await syncPanelState(tabId, TAB_STATE.get(tabId));
}

async function shouldSyncPanelForTab(tabId, context) {
  if (!tabId || !(await isFocusedActiveTab(tabId))) {
    return false;
  }
  return true;
}

async function isFocusedActiveTab(tabId) {
  if (!tabId) {
    return false;
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return Number(tab?.id) === Number(tabId);
}

async function resolveEffectiveTab(tabId, tab) {
  if (tab?.url) {
    return tab;
  }
  return (await browser.tabs.get(tabId).catch(() => null)) ?? tab ?? {};
}

async function triggerContentSync(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await browser.tabs.sendMessage(tabId, {
      type: "content:trigger-sync",
    });
  } catch {
    // Ignore unreachable tabs; scheduled retries will handle late injections.
  }
}

function scheduleTabContextResync(tabId, source = "") {
  cancelScheduledTabResync(tabId);

  const timers = TAB_SYNC_RETRY_DELAYS.map((delay) =>
    setTimeout(async () => {
      const activeTab = await browser.tabs.get(tabId).catch(() => null);
      if (!activeTab?.id) {
        cancelScheduledTabResync(tabId);
        return;
      }

      const result = await syncTabContext(tabId, activeTab, `${source}:retry_${delay}`);
      const transport = result.payload?.context?.metadata?.pageContextTransport ?? "";
      const pageKind = result.payload?.context?.metadata?.pageKind ?? "";
      if (transport === "content_script" || transport === "content_event" || pageKind !== "fallback_tab_context") {
        cancelScheduledTabResync(tabId);
      }
    }, delay)
  );

  TAB_RESYNC_TIMERS.set(tabId, timers);
}

function cancelScheduledTabResync(tabId) {
  const timers = TAB_RESYNC_TIMERS.get(tabId) ?? [];
  for (const timer of timers) {
    clearTimeout(timer);
  }
  TAB_RESYNC_TIMERS.delete(tabId);
}

function buildDegradedContextPayload(tab, cachedContext, reason, errorMessage) {
  const cachedURL = String(cachedContext?.url ?? "");
  const tabURL = String(tab?.url ?? "");
  const canReuseCachedContext =
    cachedContext &&
    cachedURL &&
    tabURL &&
    cachedURL === tabURL &&
    cachedContext.metadata?.pageKind !== "fallback_tab_context";

  if (canReuseCachedContext) {
    return {
      context: {
        ...cachedContext,
        metadata: {
          ...(cachedContext.metadata ?? {}),
          pageContextTransport: "cached_context",
          pageContextUpdatedAt:
            cachedContext.metadata?.pageContextUpdatedAt ?? new Date().toISOString(),
          pageContextFallbackReason: String(reason ?? ""),
          pageContextError: String(errorMessage ?? ""),
        },
      },
      degraded: true,
    };
  }

  return {
    context: buildFallbackContext(tab, {
      reason,
      errorMessage,
    }),
    degraded: true,
  };
}

function buildFallbackContext(tab, debug = {}) {
  const url = String(tab?.url ?? "");
  const title = String(tab?.title ?? "当前页面");

  let domain = "";
  let site = "unsupported";
  try {
    const parsed = new URL(url);
    domain = parsed.hostname;
    site = detectSiteFromHostname(domain);
  } catch {
    domain = "";
  }

  return {
    site,
    url,
    title,
    selection: "",
    articleText: title && url ? `title: ${title}\nurl: ${url}` : title || url,
    videoRAGSummary: "",
    structureSummary: "",
    interactiveSummary: "",
    interactiveTargets: [],
    focusedInput: null,
    metadata: {
      domain,
      pageKind: "fallback_tab_context",
      contentStrategy: "fallback_tab_context",
      pageContextTransport: "fallback_tab_context",
      pageContextUpdatedAt: new Date().toISOString(),
      pageContextFallbackReason: String(debug.reason ?? ""),
      pageContextError: String(debug.errorMessage ?? ""),
      headingCount: "0",
      interactiveCount: "0",
      tableCount: "0",
      codeBlockCount: "0",
      hasIframes: "false",
      hasShadowHosts: "false",
    },
  };
}

async function probePageContextDirectly(tabId, tab) {
  if (!tabId || typeof browser.scripting?.executeScript !== "function") {
    return null;
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: directPageContextProbe,
    });
    const context = results?.[0]?.result;
    if (!context || typeof context !== "object") {
      return null;
    }
    return {
      ...buildFallbackContext(tab),
      ...context,
      metadata: {
        ...(context.metadata ?? {}),
        pageContextTransport: "direct_execute_script",
        pageContextUpdatedAt: new Date().toISOString(),
        pageContextFallbackReason: "",
        pageContextError: "",
      },
    };
  } catch {
    return null;
  }
}

function directPageContextProbe() {
  const normalizeText = (value, maxLength = 12000) =>
    String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  const isTransparent = (value) =>
    !value ||
    value === "transparent" ||
    /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(value) ||
    /^rgba?\(\s*0\s+0\s+0\s*\/\s*0\s*\)$/i.test(value);
  const normalizeScheme = (value) => {
    const parts = String(value || "").toLowerCase().split(/\s+/);
    if (parts.includes("dark")) return "dark";
    if (parts.includes("light")) return "light";
    return "";
  };
  const inferScheme = (value) => {
    const match = String(value || "").match(/rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)/i);
    if (!match) return "dark";
    const red = Number.parseFloat(match[1]);
    const green = Number.parseFloat(match[2]);
    const blue = Number.parseFloat(match[3]);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    return luminance >= 0.6 ? "light" : "dark";
  };
  const detectSite = (hostname) => {
    if (hostname.includes("github.com")) return "github";
    if (hostname.includes("mail.google.com")) return "gmail";
    if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter.com")) return "x";
    if (hostname.includes("mail.yahoo.com")) return "yahoo_mail";
    if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be") return "youtube";
    if (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com")) return "bilibili";
    return "unsupported";
  };
  const inferPageKind = (site, pathname) => {
    if (site === "x") {
      if (/\/status\/\d+/.test(pathname)) return "x_post";
      if (pathname === "/home") return "x_home";
    }
    if (site === "youtube") {
      if (pathname === "/watch" || pathname.startsWith("/shorts/") || pathname.startsWith("/live/")) return "youtube_video";
      return "youtube_page";
    }
    if (site === "bilibili") {
      if (/\/video\//.test(pathname) || /\/BV[a-zA-Z0-9]+/.test(pathname)) return "bilibili_video";
      return "bilibili_page";
    }
    if (site === "github") return "github_page";
    if (site === "gmail") return "gmail_page";
    if (site === "yahoo_mail") return "yahoo_mail_page";
    return "page";
  };
  const describeNode = (node) => {
    if (!node) return "unknown";
    const id = node.id ? `#${node.id}` : "";
    const className = String(node.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return `${String(node.tagName || "node").toLowerCase()}${id}${className ? `.${className}` : ""}`;
  };
  const extractVisual = () => {
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
        const style = getComputedStyle(current);
        const backgroundImage = String(style.backgroundImage || "").trim() || "none";
        const backgroundColor = String(style.backgroundColor || "").trim();
        const scheme = normalizeScheme(style.colorScheme);
        if (!fallbackScheme && scheme) fallbackScheme = scheme;
        if (fallbackImage === "none" && backgroundImage !== "none") fallbackImage = backgroundImage;
        if (backgroundColor && !isTransparent(backgroundColor)) {
          return {
            backgroundColor,
            backgroundImage: backgroundImage !== "none" ? backgroundImage : fallbackImage,
            colorScheme: scheme || fallbackScheme || inferScheme(backgroundColor),
            source: describeNode(current),
          };
        }
        current = current.parentElement;
      }
    }
    const backgroundColor = fallbackScheme === "light" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
    return {
      backgroundColor,
      backgroundImage: fallbackImage,
      colorScheme: fallbackScheme || inferScheme(backgroundColor),
      source: "direct_fallback",
    };
  };

  const visual = extractVisual();
  const hostname = window.location.hostname || "";
  const site = detectSite(hostname);
  const pageKind = inferPageKind(site, window.location.pathname || "");
  const title = document.title || "Untitled";
  const mainText =
    normalizeText(document.querySelector("main")?.innerText) ||
    normalizeText(document.querySelector("article")?.innerText) ||
    `title: ${title}\nurl: ${window.location.href}`;

  return {
    site,
    url: window.location.href,
    title,
    selection: String(window.getSelection?.()?.toString?.() ?? "").trim(),
    articleText: mainText,
    videoRAGSummary: "",
    structureSummary: "",
    interactiveSummary: "",
    interactiveTargets: [],
    focusedInput: null,
    videoTranscript: [],
    videoFrameSamples: [],
    metadata: {
      domain: hostname,
      pageKind,
      contentStrategy: "direct_visual_probe",
      pageBackgroundColor: visual.backgroundColor,
      pageBackgroundImage: visual.backgroundImage,
      pageBackgroundSource: visual.source,
      pageColorScheme: visual.colorScheme,
      headingCount: "0",
      interactiveCount: "0",
      tableCount: "0",
      codeBlockCount: "0",
      hasIframes: document.querySelector("iframe") ? "true" : "false",
      hasShadowHosts: "false",
    },
  };
}

function detectSiteFromHostname(hostname) {
  if (hostname.includes("github.com")) return "github";
  if (hostname.includes("mail.google.com")) return "gmail";
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter.com")) {
    return "x";
  }
  if (hostname.includes("mail.yahoo.com")) return "yahoo_mail";
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be") {
    return "youtube";
  }
  if (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com")) {
    return "bilibili";
  }
  return "unsupported";
}

function createSelectionContextMenu() {
  if (!browser.contextMenus?.create) {
    return;
  }

  browser.contextMenus.remove(SELECTION_CONTEXT_MENU_ID, () => {
    browser.contextMenus.create({
      id: SELECTION_CONTEXT_MENU_ID,
      title: "Ask Safarai about selected text",
      contexts: ["selection"],
      onclick: (info, tab) => {
        handleSelectionContextMenu(info, tab).catch(() => {});
      },
    });
  });
}

async function handleSelectionContextMenu(info, tab) {
  const selectedText = String(info?.selectionText ?? "").trim();
  if (!selectedText) {
    return;
  }

  const resolvedTab = tab?.id
    ? tab
    : (await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0] ?? null;
  const tabId = resolvedTab?.id ?? null;

  const baseContext = tabId
    ? await requestPageContext(tabId)
    : createSuccessResponse({
        context: buildFallbackContext({
          url: info?.pageUrl ?? "",
          title: "",
        }),
      });

  const context = baseContext.ok
    ? baseContext.payload?.context ?? buildFallbackContext(resolvedTab)
    : buildFallbackContext(resolvedTab);
  const mergedContext = mergeStableSelection(TAB_STATE.get(tabId), {
    ...context,
    url: String(resolvedTab?.url ?? info?.pageUrl ?? context.url ?? ""),
    selection: selectedText,
  }, "contextMenus.onClicked");

  if (tabId) {
    TAB_STATE.set(tabId, mergedContext);
  }

  await sendNativeControlRequest("sync_selection_intent", {
    url: String(resolvedTab?.url ?? info?.pageUrl ?? mergedContext.url ?? ""),
    selection: selectedText,
  });

  const messages = tabId ? await loadSession(tabId) : [];
  await sendNativeControlRequest("sync_panel_state", {
    context: mergedContext,
    messages,
  });
  await sendNativeControlRequest("show_panel", {
    context: mergedContext,
    messages,
  });
}

function findInteractiveTarget(context, targetId) {
  const targets = Array.isArray(context?.interactiveTargets)
    ? context.interactiveTargets
    : [];
  return targets.find((item) => item.id === String(targetId ?? "")) ?? null;
}

function mergeStableSelection(previousContext, nextContext, source = "") {
  if (!nextContext || typeof nextContext !== "object") {
    return nextContext;
  }

  const nextURL = String(nextContext.url ?? "");
  const nextSelection = String(nextContext.selection ?? "").trim();
  const previousURL = String(previousContext?.url ?? "");
  const previousSelection = String(previousContext?.selection ?? "").trim();
  const mergedSelection =
    !nextSelection && nextURL && previousURL === nextURL && previousSelection
      ? previousSelection
      : nextSelection;

  return {
    ...nextContext,
    selection: mergedSelection,
    debugSelection: {
      ...(nextContext.debugSelection ?? {}),
      backgroundPreviousSelection: truncateDebugValue(previousSelection),
      backgroundMergedSelection: truncateDebugValue(mergedSelection),
      backgroundSource: source,
    },
  };
}

function truncateDebugValue(value) {
  const text = String(value || "").trim();
  if (text.length <= 160) {
    return text;
  }
  return `${text.slice(0, 157)}...`;
}

async function sendNativeRequest(type, context) {
  const request = createRequest(type, { context });

  try {
    const response = await browser.runtime.sendNativeMessage(request);
    if (!response?.ok) {
      return fail(
        response?.error?.code ?? "native_request_failed",
        response?.error?.message ?? "宿主返回失败",
        { action: type, requestId: request.id }
      );
    }

    await appendLog({
      level: "info",
      action: type,
      requestId: request.id,
      site: context.site,
      pageKind: context.metadata?.pageKind ?? null,
    });
    return response;
  } catch (error) {
    return fail(
      "native_host_unavailable",
      `无法连接宿主 App：${error.message}`,
      { action: type, requestId: request.id }
    );
  }
}

async function getLogs() {
  const logs = await loadLogs();
  return createSuccessResponse({ logs });
}

async function sendNativeControlRequest(type, payload) {
  try {
    const request = createRequest(type, payload);
    const response = await browser.runtime.sendNativeMessage(request);
    if (!response?.ok) {
      return fail(
        response?.error?.code ?? "native_request_failed",
        response?.error?.message ?? "宿主返回失败",
        { action: type, requestId: request.id }
      );
    }
    return response;
  } catch (error) {
    return fail(
      "native_host_unavailable",
      `无法连接宿主 App：${error.message}`,
      { action: type }
    );
  }
}

async function fetchTranscriptURL(url) {
  const normalizedURL = String(url || "").trim();
  if (!isAllowedTranscriptURL(normalizedURL)) {
    return createErrorResponse("invalid_transcript_url", "字幕地址不受支持");
  }

  try {
    const response = await fetch(normalizedURL, { credentials: "include" });
    if (!response.ok) {
      return createErrorResponse("transcript_fetch_failed", `字幕请求失败：${response.status}`);
    }
    const text = await response.text();
    return createSuccessResponse({ text });
  } catch (error) {
    return createErrorResponse(
      "transcript_fetch_failed",
      `字幕请求失败：${error?.message ?? String(error)}`
    );
  }
}

const YOUTUBE_INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

async function youtubeInnerTubePost(endpoint, body) {
  return fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${YOUTUBE_INNERTUBE_KEY}&prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function findKeyDeep(value, targetKey, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (!Array.isArray(value) && value[targetKey] !== undefined) return value[targetKey];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findKeyDeep(child, targetKey, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

// InnerTube transcript runs here (not in the content script) so it uses the extension's
// youtube.com host permission and is not subject to page CORS. /next holds the transcript
// continuation params; /get_transcript returns the timed segments.
async function fetchYouTubeTranscriptInner(videoId) {
  const id = String(videoId || "").trim();
  if (!id) {
    return createSuccessResponse({ segments: [], debug: "no_video_id" });
  }
  const context = { client: { clientName: "WEB", clientVersion: "2.20240826.01.00", hl: "en", gl: "US" } };
  let debug = "";
  try {
    const nextRes = await youtubeInnerTubePost("next", { context, videoId: id });
    debug = `next=${nextRes.status}`;
    if (!nextRes.ok) return logYouTubeTranscript(debug, []);
    const params = findKeyDeep(await nextRes.json(), "getTranscriptEndpoint")?.params;
    debug += ` params=${params ? "yes" : "no"}`;
    if (!params) return logYouTubeTranscript(debug, []);
    const trRes = await youtubeInnerTubePost("get_transcript", { context, params });
    debug += ` get=${trRes.status}`;
    if (!trRes.ok) return logYouTubeTranscript(debug, []);
    const rawSegments = findKeyDeep(await trRes.json(), "initialSegments");
    const segments = (Array.isArray(rawSegments) ? rawSegments : [])
      .map((entry) => {
        const seg = entry?.transcriptSegmentRenderer;
        const startMs = Number(seg?.startMs);
        const text = Array.isArray(seg?.snippet?.runs)
          ? seg.snippet.runs.map((r) => r?.text || "").join("")
          : seg?.snippet?.simpleText || "";
        if (!text.trim() || !Number.isFinite(startMs)) return null;
        return {
          startSeconds: startMs / 1000,
          endSeconds: seg.endMs == null ? null : Number(seg.endMs) / 1000,
          timestamp: formatTimestampForFrame(startMs / 1000),
          text: text.trim(),
          source: "youtube_caption",
        };
      })
      .filter(Boolean);
    debug += ` segs=${segments.length}`;
    return logYouTubeTranscript(debug, segments);
  } catch (error) {
    return logYouTubeTranscript(`${debug} error=${error?.message || String(error)}`, []);
  }
}

function logYouTubeTranscript(debug, segments) {
  console.log("[safarai] youtube transcript", debug);
  return createSuccessResponse({ segments, debug });
}

async function sampleVideoFramesForActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return sampleVideoFramesForTab(tab?.id);
}

async function sampleVideoFramesForTab(tabId) {
  const tab = tabId ? await browser.tabs.get(tabId).catch(() => null) : null;
  if (!tab?.id) {
    return createSuccessResponse({ samples: [], reason: "tab_not_found" });
  }

  const contextResult = await requestPageContext(tab.id);
  const context = contextResult.payload?.context ?? {};
  const duration = Number(context.metadata?.videoDurationSeconds || 0);
  const sampleTimes = buildVideoSampleTimes(duration);
  const samples = [];

  for (const timeSeconds of sampleTimes) {
    const prepared = await browser.tabs.sendMessage(tab.id, {
      type: "content:prepare-video-frame-sample",
      payload: { timeSeconds },
    }).catch((error) => ({
      ok: false,
      error: { message: error?.message || String(error) },
    }));
    if (!prepared?.ok || prepared.payload?.prepared === false) {
      continue;
    }

    const image = await captureVisibleTabFrame(tab.windowId);
    if (!image) {
      continue;
    }
    samples.push({
      timestamp: prepared.payload?.timestamp || formatTimestampForFrame(timeSeconds),
      timeSeconds: prepared.payload?.timeSeconds ?? Math.round(timeSeconds),
      image,
    });
  }

  const enrichedContext = {
    ...context,
    videoFrameSamples: samples,
    metadata: {
      ...(context.metadata ?? {}),
      videoFrameSampleCount: String(samples.length),
      videoFrameSampleSource: samples.length ? "browser_visible_tab_capture" : "",
      pageContextTransport: "video_frame_sampling",
      pageContextUpdatedAt: new Date().toISOString(),
    },
  };
  TAB_STATE.set(tab.id, mergeStableSelection(TAB_STATE.get(tab.id), enrichedContext, "video_frame_sampling"));
  await syncPanelState(tab.id, TAB_STATE.get(tab.id));
  return createSuccessResponse({ samples: samples.length, context: enrichedContext });
}

function buildVideoSampleTimes(duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return [0, 8, 18, 32, 52, 75].slice(0, 6);
  }

  const count = Math.min(8, Math.max(4, Math.round(duration / 90) + 3));
  const start = Math.min(3, duration * 0.05);
  const end = Math.max(start, duration * 0.92);
  if (count === 1) {
    return [start];
  }
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    return start + (end - start) * ratio;
  });
}

async function captureVisibleTabFrame(windowId) {
  if (typeof browser.tabs?.captureVisibleTab !== "function") {
    return "";
  }
  try {
    return await browser.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 58,
    });
  } catch {
    return "";
  }
}

function formatTimestampForFrame(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const two = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(remainingSeconds)}`
    : `${two(minutes)}:${two(remainingSeconds)}`;
}

function isAllowedTranscriptURL(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "www.youtube.com" ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "api.bilibili.com" ||
      hostname.endsWith(".bilibili.com") ||
      hostname === "i0.hdslb.com" ||
      hostname === "i1.hdslb.com" ||
      hostname === "i2.hdslb.com" ||
      hostname.endsWith(".hdslb.com") ||
      hostname.endsWith(".bilivideo.com")
    );
  } catch {
    return false;
  }
}

async function getSession(tabIdFromSender) {
  const tabId = await resolveTabId(tabIdFromSender);
  if (!tabId) {
    return createErrorResponse("tab_not_found", "未找到当前标签页");
  }

  const messages = await loadSession(tabId);
  return createSuccessResponse({ messages });
}

async function withSession(tabIdOrSender, response, userMessage, assistantMessage) {
  if (!response?.ok) {
    return response;
  }

  const tabId = await resolveTabId(tabIdOrSender);
  if (!tabId) {
    return response;
  }

  const existing = await loadSession(tabId);
  const next = await saveSession(
    tabId,
    [
      ...existing,
      userMessage,
      ...(assistantMessage ? [assistantMessage] : []),
    ].filter(Boolean)
  );

  return createSuccessResponse({
    ...response.payload,
    session: next,
  });
}

function fail(code, message, metadata = {}) {
  appendLog({
    level: "error",
    code,
    message,
    ...metadata,
  }).catch(() => {});

  return createErrorResponse(code, message);
}
