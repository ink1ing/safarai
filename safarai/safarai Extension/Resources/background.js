import {
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isSupportedSite,
} from "./shared/protocol.js";
import { appendLog, loadLogs } from "./shared/log-store.js";
import { loadSession, saveSession } from "./shared/session-store.js";

const TAB_STATE = new Map();
const VIDEO_CONTEXT_CACHE = new Map();
const TAB_RESYNC_TIMERS = new Map();
const TAB_SYNC_RETRY_DELAYS = [120, 420, 1000, 2200, 4200, 7000];
const SELECTION_CONTEXT_MENU_ID = "ask-selected-text";

browser.runtime.onInstalled.addListener(() => {
  console.log("Safari AI background ready");
  createSelectionContextMenu();
  injectContentScriptIntoOpenTabs().catch(() => {});
});

createSelectionContextMenu();
injectContentScriptIntoOpenTabs().catch(() => {});

setInterval(() => {
  syncActiveTabSnapshot().catch(() => {});
}, 1200);

setInterval(() => {
  pollAgentToolRequests().catch(() => {});
}, 450);

if (browser.tabs?.onUpdated) {
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!tabId || (!changeInfo.url && changeInfo.status !== "complete")) {
      return;
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
    await sendNativeControlRequest("toggle_panel", {
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
    case "sidebar:resolve-video-context":
      return resolveVideoContextForTab(sender.tab?.id, {
        forceRefresh: message.payload?.forceRefresh === true,
      });
    case "sidebar:get-logs":
      return getLogs();
    case "content:selection-updated":
      return syncSelectionFromContent(sender.tab?.id, message.payload);
    case "content:page-updated":
      return syncPanelStateFromContent(sender.tab?.id, message.payload?.context);
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
  // currentWindow:true doesn't work reliably in service worker context.
  // Try lastFocusedWindow first, then fall back to any active tab.
  let tab = (await browser.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0];
  if (!tab?.id) {
    tab = (await browser.tabs.query({ active: true }).catch(() => []))[0];
  }
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
  const resolvedTabId = await resolveTabId(tabIdFromSender);
  if (!resolvedTabId) {
    return createErrorResponse("tab_not_found", "未找到当前标签页");
  }

  if (TAB_STATE.has(resolvedTabId)) {
    return createSuccessResponse({
      context: TAB_STATE.get(resolvedTabId),
      cached: true,
    });
  }

  const tab = await browser.tabs.get(resolvedTabId).catch(() => null);
  if (!tab?.id) {
    return createErrorResponse("tab_not_found", "未找到当前标签页");
  }

  const fresh = await requestPageContext(resolvedTabId);
  if (!fresh.ok) {
    const degraded = buildDegradedContextPayload(
      tab,
      TAB_STATE.get(resolvedTabId),
      "request_page_context_failed",
      fresh.error?.message ?? ""
    );
    TAB_STATE.set(resolvedTabId, mergeStableSelection(TAB_STATE.get(resolvedTabId), degraded.context, "ensurePageContext"));
    return createSuccessResponse({
      context: TAB_STATE.get(resolvedTabId),
      cached: false,
      degraded: true,
    });
  }

  TAB_STATE.set(
    resolvedTabId,
    mergeStableSelection(TAB_STATE.get(resolvedTabId), fresh.payload?.context ?? {}, "ensurePageContext")
  );

  return createSuccessResponse({
    context: TAB_STATE.get(resolvedTabId),
    cached: false,
  });
}

async function syncPanelState(tabId, context) {
  const messages = tabId ? await loadSession(tabId) : [];
  await sendNativeControlRequest("sync_panel_state", {
    context,
    messages,
  });
}

async function resolveVideoContextForTab(tabIdFromSender, options = {}) {
  const tabId = await resolveTabId(tabIdFromSender);
  if (!tabId) {
    return createErrorResponse("tab_not_found", "未找到当前标签页");
  }

  const tab = await browser.tabs.get(tabId).catch(() => null);

  const baseContextResult = await ensurePageContext(tabId);
  if (!baseContextResult.ok) {
    return baseContextResult;
  }

  const baseContext = baseContextResult.payload?.context ?? {};
  const cacheKey = videoContextCacheKey(baseContext);
  if (cacheKey && options.forceRefresh !== true) {
    const cachedContext = VIDEO_CONTEXT_CACHE.get(cacheKey);
    if (cachedContext) {
      TAB_STATE.set(tabId, mergeStableSelection(TAB_STATE.get(tabId), cachedContext, "resolveVideoContext:cache"));
      await syncPanelState(tabId, TAB_STATE.get(tabId));
      return createSuccessResponse({
        context: TAB_STATE.get(tabId),
        cached: true,
      });
    }
  }

  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: "content:resolve-video-context",
      payload: {
        forceRefresh: options.forceRefresh === true,
        currentVideoContext: baseContext.videoContext ?? null,
      },
    });

    if (!response?.ok || !response.payload?.context) {
      return createErrorResponse(
        response?.error?.code ?? "video_context_resolve_failed",
        response?.error?.message ?? "无法解析当前视频上下文。"
      );
    }

    const nextContext = mergeStableSelection(
      TAB_STATE.get(tabId),
      response.payload.context,
      "resolveVideoContext:content"
    );
    TAB_STATE.set(tabId, nextContext);
    const nextCacheKey = videoContextCacheKey(nextContext);
    if (nextCacheKey) {
      if (shouldCacheResolvedVideoContext(nextContext)) {
        VIDEO_CONTEXT_CACHE.set(nextCacheKey, nextContext);
      } else {
        VIDEO_CONTEXT_CACHE.delete(nextCacheKey);
      }
    }
    await syncPanelState(tabId, nextContext);
    return createSuccessResponse({
      context: nextContext,
      cached: false,
    });
  } catch (error) {
    const probedContext = await probePageContextDirectly(tabId, tab);
    if (probedContext) {
      const nextContext = mergeStableSelection(
        TAB_STATE.get(tabId),
        probedContext,
        "resolveVideoContext:direct_probe"
      );
      TAB_STATE.set(tabId, nextContext);
      const nextCacheKey = videoContextCacheKey(nextContext);
      if (nextCacheKey) {
        if (shouldCacheResolvedVideoContext(nextContext)) {
          VIDEO_CONTEXT_CACHE.set(nextCacheKey, nextContext);
        } else {
          VIDEO_CONTEXT_CACHE.delete(nextCacheKey);
        }
      }
      await syncPanelState(tabId, nextContext);
      return createSuccessResponse({
        context: nextContext,
        cached: false,
        degraded: true,
      });
    }

    return createErrorResponse("content_script_unreachable", `无法解析视频内容：${error.message}`);
  }
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

async function pollAgentToolRequests() {
  const response = await sendNativeControlRequest("agent_poll_request", {});
  if (!response?.ok) {
    return;
  }
  const request = response.payload?.request;
  if (!request?.requestId || !request?.toolName) {
    return;
  }

  const result = await executeAgentToolRequest(request);
  await sendNativeControlRequest("agent_submit_result", {
    requestId: request.requestId,
    result,
  });
}

async function executeAgentToolRequest(request) {
  const toolName = String(request.toolName || "");
  const args = request.arguments ?? {};
  const explicitTabId = normalizeRequestedTabId(args.tabId);

  if (toolName === "list_safari_windows_tabs") {
    return listSafariWindowsTabs();
  }

  if (toolName === "get_frontmost_tab") {
    return getFrontmostTab();
  }

  if (toolName === "activate_tab") {
    return activateSafariTab(explicitTabId, normalizeRequestedWindowId(args.windowId));
  }

  if (toolName === "open_tab") {
    return openSafariTab({
      url: args.url,
      windowId: normalizeRequestedWindowId(args.windowId),
      active: args.active !== false,
    });
  }

  if (toolName === "close_tab") {
    return closeSafariTab(explicitTabId);
  }

  if (toolName === "navigate_tab") {
    return navigateSafariTab({
      tabId: explicitTabId,
      url: args.url,
      active: args.active !== false,
    });
  }

  const tabId = await resolveTabId(explicitTabId);
  if (!tabId) {
    return {
      ok: false,
      errorCode: "tab_not_found",
      humanSummary: "未找到当前标签页。",
    };
  }

  if (toolName === "get_page_context") {
    const contextResult = await ensurePageContext(tabId);
    if (!contextResult.ok) {
      return {
        ok: false,
        errorCode: contextResult.error?.code ?? "page_context_failed",
        humanSummary: contextResult.error?.message ?? "页面上下文读取失败。",
      };
    }
    return {
      ok: true,
      humanSummary: "已读取当前页面上下文。",
      data: contextResult.payload?.context ?? {},
    };
  }

  if (toolName === "list_interactive_targets") {
    const contextResult = await ensurePageContext(tabId);
    if (!contextResult.ok) {
      return {
        ok: false,
        errorCode: contextResult.error?.code ?? "list_targets_failed",
        humanSummary: contextResult.error?.message ?? "无法列出可交互目标。",
      };
    }
    return {
      ok: true,
      humanSummary: "已列出当前页面可交互目标。",
      data: {
        targets: contextResult.payload?.context?.interactiveTargets ?? [],
      },
    };
  }

  if (toolName === "extract_structured_data") {
    const contextResult = await ensurePageContext(tabId);
    const context = contextResult.payload?.context ?? {};
    return {
      ok: true,
      humanSummary: "已提取当前页面结构化摘要。",
      data: {
        title: context.title ?? "",
        url: context.url ?? "",
        site: context.site ?? "",
        pageKind: context.metadata?.pageKind ?? "",
        structureSummary: context.structureSummary ?? "",
        interactiveSummary: context.interactiveSummary ?? "",
        selection: context.selection ?? "",
      },
    };
  }

  if (toolName === "highlight_target" || toolName === "focus_target" || toolName === "scroll_to_target") {
    const actionMap = {
      highlight_target: "highlight",
      focus_target: "focus",
      scroll_to_target: "scroll",
    };
    const action = actionMap[toolName];
    const targetResult = await performTargetAction(tabId, action, args.targetId);
    if (!targetResult.ok) {
      return {
        ok: false,
        errorCode: targetResult.error?.code ?? "target_action_failed",
        humanSummary: targetResult.error?.message ?? "目标操作失败。",
      };
    }
    return {
      ok: true,
      humanSummary: `已执行 ${toolName}。`,
      data: targetResult.payload ?? {},
    };
  }

  const messageTypeMap = {
    click_target: "content:click-target",
    read_target: "content:read-target",
    fill_target: "content:fill-target",
    navigate_page: "content:navigate-page",
  };
  const messageType = messageTypeMap[toolName];
  if (!messageType) {
    return {
      ok: false,
      errorCode: "unsupported_agent_tool",
      humanSummary: `不支持的 agent 工具：${toolName}`,
    };
  }

  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: messageType,
      payload: args,
    });
    if (!response?.ok) {
      return {
        ok: false,
        errorCode: response?.error?.code ?? "agent_tool_failed",
        humanSummary: response?.error?.message ?? "页面动作执行失败。",
      };
    }
    return {
      ok: true,
      humanSummary: response.payload?.answer ?? `已执行 ${toolName}。`,
      data: response.payload ?? {},
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "content_script_unreachable",
      humanSummary: `无法执行页面动作：${error.message}`,
    };
  }
}

async function resolveTabId(tabIdFromSender) {
  const normalizedTabId = normalizeRequestedTabId(tabIdFromSender);
  if (normalizedTabId) {
    return normalizedTabId;
  }

  // currentWindow:true is unreliable in service worker context; try lastFocusedWindow first.
  let tab = (await browser.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0];
  if (!tab?.id) {
    tab = (await browser.tabs.query({ active: true }).catch(() => []))[0];
  }
  return tab?.id ?? null;
}

function normalizeRequestedTabId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeRequestedWindowId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

async function listSafariWindowsTabs() {
  try {
    const windows = await browser.windows.getAll({ populate: true });
    const normalizedWindows = windows.map((window) => ({
      windowId: window.id ?? null,
      focused: window.focused === true,
      state: String(window.state ?? ""),
      tabCount: Array.isArray(window.tabs) ? window.tabs.length : 0,
      tabs: (window.tabs ?? []).map((tab) => ({
        tabId: tab.id ?? null,
        windowId: tab.windowId ?? window.id ?? null,
        index: tab.index ?? 0,
        active: tab.active === true,
        pinned: tab.pinned === true,
        status: String(tab.status ?? ""),
        title: String(tab.title ?? ""),
        url: String(tab.url ?? ""),
      })),
    }));

    return {
      ok: true,
      humanSummary: `已列出 ${normalizedWindows.length} 个 Safari 窗口。`,
      data: {
        windows: normalizedWindows,
      },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "list_windows_failed",
      humanSummary: `无法列出 Safari 标签页：${error.message}`,
    };
  }
}

async function getFrontmostTab() {
  try {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      return {
        ok: false,
        errorCode: "tab_not_found",
        humanSummary: "未找到前台标签页。",
      };
    }

    return {
      ok: true,
      humanSummary: "已获取前台标签页。",
      data: {
        tab: {
          tabId: tab.id,
          windowId: tab.windowId ?? null,
          index: tab.index ?? 0,
          active: true,
          pinned: tab.pinned === true,
          status: String(tab.status ?? ""),
          title: String(tab.title ?? ""),
          url: String(tab.url ?? ""),
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "frontmost_tab_failed",
      humanSummary: `无法获取前台标签页：${error.message}`,
    };
  }
}

async function activateSafariTab(tabId, windowId) {
  if (!tabId) {
    return {
      ok: false,
      errorCode: "missing_tab_id",
      humanSummary: "缺少 tabId。",
    };
  }

  try {
    const updated = await browser.tabs.update(tabId, { active: true });
    if (windowId) {
      await browser.windows.update(windowId, { focused: true }).catch(() => {});
    } else if (updated?.windowId) {
      await browser.windows.update(updated.windowId, { focused: true }).catch(() => {});
    }

    return {
      ok: true,
      humanSummary: "已切换到目标标签页。",
      data: {
        tabId: updated?.id ?? tabId,
        windowId: updated?.windowId ?? windowId ?? null,
        title: String(updated?.title ?? ""),
        url: String(updated?.url ?? ""),
      },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "activate_tab_failed",
      humanSummary: `无法切换标签页：${error.message}`,
    };
  }
}

async function openSafariTab({ url, windowId, active }) {
  const normalizedURL = String(url ?? "").trim();
  if (!normalizedURL) {
    return {
      ok: false,
      errorCode: "missing_url",
      humanSummary: "缺少 URL。",
    };
  }

  try {
    const tab = await browser.tabs.create({
      url: normalizedURL,
      active: active !== false,
      ...(windowId ? { windowId } : {}),
    });

    return {
      ok: true,
      humanSummary: "已打开新标签页。",
      data: {
        tabId: tab?.id ?? null,
        windowId: tab?.windowId ?? windowId ?? null,
        title: String(tab?.title ?? ""),
        url: String(tab?.url ?? normalizedURL),
      },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "open_tab_failed",
      humanSummary: `无法打开标签页：${error.message}`,
    };
  }
}

async function closeSafariTab(tabId) {
  if (!tabId) {
    return {
      ok: false,
      errorCode: "missing_tab_id",
      humanSummary: "缺少 tabId。",
    };
  }

  try {
    await browser.tabs.remove(tabId);
    return {
      ok: true,
      humanSummary: "已关闭目标标签页。",
      data: {
        tabId,
      },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "close_tab_failed",
      humanSummary: `无法关闭标签页：${error.message}`,
    };
  }
}

async function navigateSafariTab({ tabId, url, active }) {
  const normalizedURL = String(url ?? "").trim();
  if (!tabId) {
    return {
      ok: false,
      errorCode: "missing_tab_id",
      humanSummary: "缺少 tabId。",
    };
  }
  if (!normalizedURL) {
    return {
      ok: false,
      errorCode: "missing_url",
      humanSummary: "缺少 URL。",
    };
  }

  try {
    const updated = await browser.tabs.update(tabId, {
      url: normalizedURL,
      ...(active === false ? {} : { active: true }),
    });
    return {
      ok: true,
      humanSummary: "已请求目标标签页导航。",
      data: {
        tabId: updated?.id ?? tabId,
        windowId: updated?.windowId ?? null,
        title: String(updated?.title ?? ""),
        url: String(updated?.url ?? normalizedURL),
      },
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "navigate_tab_failed",
      humanSummary: `无法导航标签页：${error.message}`,
    };
  }
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

async function requestPageContext(tabId, options = {}) {
  const allowInjection = options.allowInjection !== false;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const cachedContext = TAB_STATE.get(tabId) ?? null;

  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: "content:get-page-context",
    });

    if (!response?.ok) {
      const probedContext = await probePageContextDirectly(tabId, tab);
      if (probedContext) {
        return createSuccessResponse({
          context: probedContext,
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
      const probedContext = await probePageContextDirectly(tabId, tab);
      if (probedContext) {
        return createSuccessResponse({
          context: probedContext,
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
    if (allowInjection) {
      const injected = await ensureContentScriptInjected(tabId);
      if (injected) {
        await delay(140);
        return requestPageContext(tabId, { allowInjection: false });
      }
    }

    const probedContext = await probePageContextDirectly(tabId, tab);
    if (probedContext) {
      return createSuccessResponse({
        context: {
          ...probedContext,
          metadata: {
            ...(probedContext.metadata ?? {}),
            pageContextFallbackReason: "content_script_unreachable",
            pageContextError: error?.message ?? String(error),
          },
        },
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

async function ensureContentScriptInjected(tabId) {
  if (!tabId) {
    return false;
  }

  try {
    if (browser.scripting?.executeScript) {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      return true;
    }
  } catch {
    // Fall through to legacy injection path.
  }

  try {
    if (browser.tabs?.executeScript) {
      await browser.tabs.executeScript(tabId, {
        file: "content.js",
      });
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function injectContentScriptIntoOpenTabs() {
  const tabs = await browser.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    const tabId = tab?.id ?? null;
    const url = String(tab?.url ?? "");
    if (!tabId || !isInjectableURL(url)) {
      continue;
    }
    ensureContentScriptInjected(tabId).catch(() => {});
  }
}

function isInjectableURL(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probePageContextDirectly(tabId, tab, options = {}) {
  if (!tabId) {
    return null;
  }

  try {
    if (browser.scripting?.executeScript) {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: directPageContextProbe,
        args: [options],
      });
      const payload = results?.[0]?.result ?? null;
      return normalizeDirectProbePayload(payload, tab);
    }
  } catch {
    // Fall through to legacy executeScript path.
  }

  try {
    if (browser.tabs?.executeScript) {
      const encodedOptions = JSON.stringify(options);
      const code = `(${directPageContextProbe.toString()})(${encodedOptions})`;
      const results = await browser.tabs.executeScript(tabId, {
        code,
      });
      const payload = Array.isArray(results) ? results[0] : null;
      return normalizeDirectProbePayload(payload, tab);
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeDirectProbePayload(payload, tab) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const metadata = payload.metadata ?? {};

  return {
    site: isSupportedSite(payload.site) ? payload.site : "unsupported",
    url: String(payload.url ?? tab?.url ?? ""),
    title: String(payload.title ?? tab?.title ?? "当前页面"),
    selection: String(payload.selection ?? ""),
    articleText: String(payload.articleText ?? ""),
    structureSummary: "",
    interactiveSummary: "",
    interactiveTargets: [],
    focusedInput: null,
    videoContext: payload.videoContext ?? null,
    metadata: {
      domain: String(metadata.domain ?? ""),
      pageKind: String(metadata.pageKind ?? "page"),
      contentStrategy: String(metadata.contentStrategy ?? "direct_visual_probe"),
      transcriptAvailable: String(metadata.transcriptAvailable ?? ""),
      transcriptLanguage: String(metadata.transcriptLanguage ?? ""),
      transcriptSource: String(metadata.transcriptSource ?? ""),
      transcriptStatus: String(metadata.transcriptStatus ?? ""),
      transcriptDetail: String(metadata.transcriptDetail ?? ""),
      summaryReady: String(metadata.summaryReady ?? ""),
      summaryInputSource: String(metadata.summaryInputSource ?? ""),
      fallbackDetail: String(metadata.fallbackDetail ?? ""),
      pageBackgroundColor: String(metadata.pageBackgroundColor ?? ""),
      pageBackgroundImage: String(metadata.pageBackgroundImage ?? "none"),
      pageColorScheme: String(metadata.pageColorScheme ?? ""),
      pageBackgroundSource: String(metadata.pageBackgroundSource ?? "direct_probe"),
      pageContextTransport: "direct_execute_script",
      pageContextUpdatedAt: new Date().toISOString(),
      pageContextFallbackReason: "",
      pageContextError: "",
      headingCount: "0",
      interactiveCount: "0",
      tableCount: "0",
      codeBlockCount: "0",
      hasIframes: String(metadata.hasIframes ?? "false"),
      hasShadowHosts: "false",
    },
  };
}

async function directPageContextProbe(options = {}) {
  const hostname = window.location.hostname || "";
  const pathname = window.location.pathname || "";
  const title = document.title || "Untitled";
  const selection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  const mainText =
    normalizeDirectText(document.querySelector("main")?.innerText) ||
    normalizeDirectText(document.querySelector("article")?.innerText) ||
    "";
  const visual = extractDirectVisualState();
  const site = detectDirectSite(hostname);
  const pageKind = inferDirectPageKind(hostname, pathname);
  // Resolve video details when on a video page
  const resolveVideo =
    options.resolveVideo === true ||
    pageKind === "youtube_video" ||
    pageKind === "bilibili_video" ||
    pageKind === "x_video_post";
  const videoDetails = await extractDirectVideoDetails({
    site,
    pageKind,
    hostname,
    pathname,
    title,
    mainText,
    resolveVideo,
  });

  return {
    site,
    url: window.location.href,
    title,
    selection,
    articleText:
      videoDetails.articleText ||
      mainText ||
      `title: ${title}\nurl: ${window.location.href}`,
    videoContext: videoDetails.videoContext || null,
    metadata: {
      domain: hostname,
      pageKind,
      contentStrategy: videoDetails.metadata.contentStrategy || "direct_visual_probe",
      transcriptAvailable: videoDetails.metadata.transcriptAvailable || "",
      transcriptLanguage: videoDetails.metadata.transcriptLanguage || "",
      transcriptSource: videoDetails.metadata.transcriptSource || "",
      transcriptStatus: videoDetails.metadata.transcriptStatus || "",
      transcriptDetail: videoDetails.metadata.transcriptDetail || "",
      pageBackgroundColor: visual.backgroundColor,
      pageBackgroundImage: visual.backgroundImage,
      pageColorScheme: visual.colorScheme,
      pageBackgroundSource: visual.source,
      hasIframes: document.querySelector("iframe") ? "true" : "false",
    },
  };

  async function extractDirectVideoDetails(params) {
    if (params.site === "youtube" && params.pageKind === "youtube_video") {
      return extractYouTubeVideoDetails(params.resolveVideo);
    }
    if (params.site === "bilibili" && params.pageKind === "bilibili_video") {
      return extractBilibiliVideoDetails(params.resolveVideo);
    }
    if (params.site === "x" && params.pageKind === "x_video_post") {
      return extractXVideoDetails();
    }
    return { articleText: "", metadata: {}, videoContext: null };
  }

  function extractDirectVisualState() {
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
        const colorScheme = normalizeColorScheme(computedStyle.colorScheme);

        if (!fallbackScheme && colorScheme) {
          fallbackScheme = colorScheme;
        }
        if (fallbackImage === "none" && backgroundImage !== "none") {
          fallbackImage = backgroundImage;
        }
        if (backgroundColor && !isTransparent(backgroundColor)) {
          return {
            backgroundColor,
            backgroundImage: backgroundImage !== "none" ? backgroundImage : fallbackImage,
            colorScheme: colorScheme || fallbackScheme || inferSchemeFromColor(backgroundColor),
            source: describeNode(current),
          };
        }
        current = current.parentElement;
      }
    }

    const fallbackColor = fallbackScheme === "light" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
    return {
      backgroundColor: fallbackColor,
      backgroundImage: fallbackImage,
      colorScheme: fallbackScheme || inferSchemeFromColor(fallbackColor),
      source: "direct_probe_fallback",
    };
  }

  function detectDirectSite(currentHostname) {
    if (currentHostname.includes("github.com")) return "github";
    if (currentHostname.includes("mail.google.com")) return "gmail";
    if (currentHostname === "www.youtube.com" || currentHostname === "youtube.com" || currentHostname === "m.youtube.com" || currentHostname === "youtu.be") {
      return "youtube";
    }
    if (currentHostname === "www.bilibili.com" || currentHostname === "bilibili.com" || currentHostname.endsWith(".bilibili.com") || currentHostname === "b23.tv") {
      return "bilibili";
    }
    if (currentHostname === "x.com" || currentHostname.endsWith(".x.com") || currentHostname.includes("twitter.com")) {
      return "x";
    }
    if (currentHostname.includes("mail.yahoo.com")) return "yahoo_mail";
    return "unsupported";
  }

  function inferDirectPageKind(currentHostname, currentPathname) {
    const site = detectDirectSite(currentHostname);
    if (site === "x") {
      if (/\/status\/\d+/.test(currentPathname) && hasXVideoSignals()) return "x_video_post";
      if (/\/status\/\d+/.test(currentPathname)) return "x_post";
      if (currentPathname === "/home") return "x_home";
    }
    if (site === "youtube") {
      if (currentPathname === "/watch" || currentPathname.startsWith("/shorts/") || currentPathname.startsWith("/live/")) return "youtube_video";
    }
    if (site === "bilibili") {
      if (currentPathname.startsWith("/video/") || currentPathname.startsWith("/bangumi/play/")) return "bilibili_video";
    }
    return "page";
  }

  function buildVideoArticle({
    pageTitle,
    author,
    duration = "",
    description = "",
    postText = "",
    transcriptText = "",
    summaryText = "",
    summaryInputSource = "",
    fallbackPageText = "",
  }) {
    return [
      pageTitle ? `video_title: ${pageTitle}` : "",
      author ? `video_author: ${author}` : "",
      duration ? `video_duration: ${duration}` : "",
      `video_url: ${window.location.href}`,
      description ? `video_description:\n${description.slice(0, 3000)}` : "",
      postText ? `video_post_text:\n${postText.slice(0, 3000)}` : "",
      transcriptText ? `video_transcript:\n${transcriptText}` : "",
      !transcriptText && summaryText ? `${summarySectionLabel(summaryInputSource)}:\n${summaryText}` : "",
      !transcriptText && fallbackPageText ? `video_page_text:\n${fallbackPageText.slice(0, 4000)}` : "",
    ].filter(Boolean).join("\n\n");
  }

  function buildVideoContext({
    platform,
    mediaId,
    pageTitle,
    author = "",
    duration = "",
    description = "",
    postText = "",
    transcriptText = "",
    transcriptLanguage = "",
    transcriptAvailability = "partial",
    transcriptReason = "not_requested",
    transcriptSource = "none",
    summaryInputSource = "",
    summaryText = "",
    fallbackDetail = "",
    summaryReady = false,
    summaryMode = "metadata_only",
  }) {
    return {
      platform,
      pageKind,
      mediaId,
      canonicalUrl: window.location.href,
      title: pageTitle || "",
      author,
      duration,
      description,
      postText,
      transcriptText,
      transcriptLanguage,
      transcriptAvailability,
      transcriptReason,
      transcriptSource,
      summaryInputSource,
      summaryText,
      fallbackDetail,
      summaryReady,
      summaryMode,
      detectedAt: new Date().toISOString(),
    };
  }

  function summarySectionLabel(summaryInputSource) {
    switch (summaryInputSource) {
      case "official_summary":
        return "video_official_summary";
      case "chapter_points":
        return "video_chapter_points";
      case "page_text":
        return "video_page_text";
      case "metadata_only":
        return "video_summary";
      default:
        return "video_summary";
    }
  }

  function resolveSummaryFallback(videoContext, options = {}) {
    const officialSummaryText = normalizeDirectText(options.officialSummaryText || "");
    if (officialSummaryText) {
      return {
        ...videoContext,
        summaryInputSource: "official_summary",
        summaryText: officialSummaryText.slice(0, 16000),
        fallbackDetail: `${options.fallbackDetailPrefix || "video"}_official_summary`,
        summaryReady: true,
        summaryMode: "fallback_summary",
      };
    }

    const chapterPointsText = normalizeDirectText(options.chapterPointsText || "");
    if (chapterPointsText) {
      return {
        ...videoContext,
        summaryInputSource: "chapter_points",
        summaryText: chapterPointsText.slice(0, 16000),
        fallbackDetail: `${options.fallbackDetailPrefix || "video"}_chapter_points`,
        summaryReady: true,
        summaryMode: "fallback_summary",
      };
    }

    const pageText = normalizeDirectText(options.pageText || "");
    if (pageText) {
      return {
        ...videoContext,
        summaryInputSource: "page_text",
        summaryText: pageText.slice(0, 16000),
        fallbackDetail: `${options.fallbackDetailPrefix || "video"}_page_text`,
        summaryReady: true,
        summaryMode: "fallback_summary",
      };
    }

    return {
      ...videoContext,
      summaryInputSource: "metadata_only",
      summaryText: buildMetadataOnlySummary(videoContext),
      fallbackDetail: options.officialSummaryReason || `${options.fallbackDetailPrefix || "video"}_metadata_only`,
      summaryReady: true,
      summaryMode: "metadata_only",
    };
  }

  function buildMetadataOnlySummary(videoContext) {
    return [
      videoContext.title ? `title: ${videoContext.title}` : "",
      videoContext.author ? `author: ${videoContext.author}` : "",
      videoContext.duration ? `duration: ${videoContext.duration}` : "",
      videoContext.description ? `description: ${videoContext.description}` : "",
      videoContext.postText ? `post_text: ${videoContext.postText}` : "",
    ].filter(Boolean).join("\n");
  }

  async function extractYouTubeVideoDetails(resolveTranscript = false) {
    const pageTitle = normalizeDirectText(
      document.querySelector("meta[property='og:title']")?.content ||
      document.querySelector("meta[name='title']")?.content ||
      document.title.replace(/\s*-\s*YouTube\s*$/i, "")
    );
    const author = normalizeDirectText(
      document.querySelector("#owner #channel-name a")?.innerText ||
      document.querySelector("ytd-channel-name a")?.innerText ||
      document.querySelector("link[itemprop='name']")?.getAttribute?.("content") ||
      ""
    );
    const description = normalizeDirectText(
      document.querySelector("#description-inline-expander")?.innerText ||
      document.querySelector("#description")?.innerText ||
      document.querySelector("meta[name='description']")?.content ||
      ""
    );
    const duration = normalizeDirectText(document.querySelector("meta[itemprop='duration']")?.content || "");
    const mediaId = (() => {
      const params = new URLSearchParams(window.location.search || "");
      if (params.get("v")) return params.get("v");
      const parts = window.location.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" || parts[0] === "live") return parts[1] || "";
      return "";
    })();

    const playerResponse =
      readPlayerResponseFromPage() ||
      readPlayerResponseFromScripts();
    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const preferredTrack = chooseCaptionTrack(tracks);
    let transcriptResult = { text: "", status: "pending", detail: "", availability: "partial", source: "none" };
    if (resolveTranscript) {
      const domTranscript = await ensureYouTubeTranscriptFromDOM();
      const transcriptURL = preferredTrack?.baseUrl
        ? decodeHtmlEntities(String(preferredTrack.baseUrl))
        : "";
      transcriptResult = domTranscript.text
        ? { ...domTranscript, availability: "available", source: "dom" }
        : transcriptURL
          ? await fetchYouTubeTranscript(transcriptURL)
          : {
              text: "",
              status: tracks.length ? "caption_track_missing_url" : "no_caption_tracks",
              detail: "",
              availability: "unavailable",
              source: "none",
            };
    }

    const videoContext = buildVideoContext({
      platform: "youtube",
      mediaId,
      pageTitle,
      author,
      duration,
      description,
      transcriptText: transcriptResult.text || "",
      transcriptLanguage: String(preferredTrack?.languageCode ?? ""),
      transcriptAvailability: transcriptResult.text ? "available" : (resolveTranscript ? (transcriptResult.availability || "unavailable") : "partial"),
      transcriptReason: resolveTranscript ? (transcriptResult.text ? "not_requested" : mapTranscriptReason(transcriptResult.status)) : "not_requested",
      transcriptSource: transcriptResult.text ? (transcriptResult.source || (transcriptResult.status === "ok_dom" || transcriptResult.status === "ok_dom_auto" ? "dom" : "caption_api")) : "none",
      summaryInputSource: transcriptResult.text ? "transcript" : "",
      summaryText: transcriptResult.text || "",
      fallbackDetail: "",
      summaryReady: transcriptResult.text ? true : false,
      summaryMode: transcriptResult.text ? "transcript_plus_metadata" : "metadata_only",
    });

    const resolvedVideoContext = transcriptResult.text
      ? videoContext
      : resolveSummaryFallback(videoContext, {
          officialSummaryText: "",
          chapterPointsText: extractYouTubeChapterPoints(),
          pageText: buildYouTubeFallbackText(),
          fallbackDetailPrefix: "youtube_no_subtitles",
        });

    return {
      articleText: buildVideoArticle({
        pageTitle,
        author,
        duration,
        description,
        transcriptText: resolvedVideoContext.transcriptText || "",
        summaryText: resolvedVideoContext.summaryText || "",
        summaryInputSource: resolvedVideoContext.summaryInputSource || "",
        fallbackPageText: resolvedVideoContext.summaryText ? "" : mainText,
      }),
      videoContext: resolvedVideoContext,
      metadata: {
        contentStrategy: transcriptResult.text ? "youtube_transcript_direct_probe" : `youtube_${resolvedVideoContext.summaryInputSource || "metadata"}_direct_probe`,
        transcriptAvailable: transcriptResult.text ? "true" : (resolveTranscript ? "false" : ""),
        transcriptLanguage: String(preferredTrack?.languageCode ?? ""),
        transcriptSource: transcriptResult.text
          ? (transcriptResult.status === "ok_dom" ? "youtube_transcript_dom" : "youtube_captions")
          : "",
        transcriptStatus: resolveTranscript ? (transcriptResult.status || "") : "pending",
        transcriptDetail: resolvedVideoContext.fallbackDetail || transcriptResult.detail || "",
        summaryReady: resolvedVideoContext.summaryReady ? "true" : "false",
        summaryInputSource: resolvedVideoContext.summaryInputSource || "",
        fallbackDetail: resolvedVideoContext.fallbackDetail || "",
      },
    };
  }

  async function extractBilibiliVideoDetails(resolveTranscript = false) {
    const pageTitle = normalizeDirectText(
      document.querySelector("h1.video-title")?.innerText ||
      document.querySelector("meta[property='og:title']")?.content ||
      document.title.replace(/\s*_[^_]*哔哩哔哩.*$/i, "")
    );
    const author = normalizeDirectText(
      document.querySelector(".up-name")?.innerText ||
      document.querySelector(".username")?.innerText ||
      document.querySelector("meta[name='author']")?.content ||
      ""
    );
    const description = normalizeDirectText(
      document.querySelector(".video-desc-container")?.innerText ||
      document.querySelector(".desc-info-text")?.innerText ||
      document.querySelector("meta[name='description']")?.content ||
      ""
    );
    const mediaId = (() => {
      const parts = window.location.pathname.split("/").filter(Boolean);
      if (parts[0] === "video") return parts[1] || "";
      if (parts[0] === "bangumi" && parts[1] === "play") return parts[2] || "";
      return "";
    })();

    let transcriptText = "";
    let transcriptLanguage = "";
    let transcriptStatus = resolveTranscript ? "no_subtitle_tracks" : "pending";
    let transcriptSource = "";

    const html = await fetch(window.location.href, { credentials: "include" })
      .then((response) => response?.ok ? response.text() : "")
      .catch(() => "");
    const playInfo = parseEmbeddedJson(html, "__playinfo__") || parseEmbeddedJson(html, "window.__playinfo__");
    const initialState = parseEmbeddedJson(html, "__INITIAL_STATE__") || parseEmbeddedJson(html, "window.__INITIAL_STATE__");
    const viewInfo = await fetchBilibiliViewInfo(mediaId);
    const bvid = String(viewInfo?.bvid ?? mediaId ?? "");
    const cid = String(viewInfo?.cid ?? extractBilibiliCID(initialState) ?? "");
    const playerInfo = await fetchBilibiliPlayerInfo(bvid, cid);
    const subtitleList =
      playerInfo?.subtitle?.subtitles ??
      playInfo?.data?.subtitle?.subtitles ??
      playInfo?.subtitle?.subtitles ??
      [];
    const preferredSubtitle = chooseBilibiliTrack(subtitleList);

    if (resolveTranscript && preferredSubtitle?.subtitle_url) {
      const subtitleURL = normalizeBilibiliSubtitleURL(String(preferredSubtitle.subtitle_url));
      const result = await fetchBilibiliTranscript(subtitleURL);
      transcriptText = result.text;
      transcriptLanguage = String(preferredSubtitle.lan_doc ?? preferredSubtitle.lan ?? "");
      transcriptStatus = result.text ? "ok" : result.status;
      transcriptSource = result.text ? "bilibili_subtitle" : "";
    }

    const videoContext = buildVideoContext({
      platform: "bilibili",
      mediaId,
      pageTitle: pageTitle || normalizeDirectText(viewInfo?.title || ""),
      author: author || normalizeDirectText(viewInfo?.owner?.name || ""),
      duration: formatDurationSeconds(viewInfo?.duration),
      description: description || normalizeDirectText(viewInfo?.desc || ""),
      transcriptText,
      transcriptLanguage,
      transcriptAvailability: transcriptText ? "available" : (resolveTranscript ? "unavailable" : "partial"),
      transcriptReason: resolveTranscript ? (transcriptText ? "not_requested" : mapTranscriptReason(transcriptStatus)) : "not_requested",
      transcriptSource: transcriptText ? "subtitle_api" : "none",
      summaryInputSource: transcriptText ? "transcript" : "",
      summaryText: transcriptText || "",
      fallbackDetail: "",
      summaryReady: transcriptText ? true : false,
      summaryMode: transcriptText ? "transcript_plus_metadata" : "metadata_only",
    });

    const officialSummary = resolveTranscript ? await fetchBilibiliOfficialSummary(bvid, cid) : { text: "", reason: "" };
    const chapterPoints = buildBilibiliChapterPoints(playerInfo?.view_points);
    const resolvedVideoContext = transcriptText
      ? videoContext
      : resolveSummaryFallback(videoContext, {
          officialSummaryText: officialSummary.text,
          chapterPointsText: chapterPoints,
          pageText: buildBilibiliFallbackText(viewInfo),
          fallbackDetailPrefix: "bilibili_no_subtitles",
          officialSummaryReason: officialSummary.reason,
        });

    return {
      articleText: buildVideoArticle({
        pageTitle: resolvedVideoContext.title,
        author: resolvedVideoContext.author,
        duration: resolvedVideoContext.duration,
        description: resolvedVideoContext.description,
        transcriptText: resolvedVideoContext.transcriptText,
        summaryText: resolvedVideoContext.summaryText || "",
        summaryInputSource: resolvedVideoContext.summaryInputSource || "",
        fallbackPageText: resolvedVideoContext.summaryText ? "" : mainText,
      }),
      videoContext: resolvedVideoContext,
      metadata: {
        contentStrategy: transcriptText ? "bilibili_transcript_direct_probe" : `bilibili_${resolvedVideoContext.summaryInputSource || "metadata"}_direct_probe`,
        transcriptAvailable: transcriptText ? "true" : (resolveTranscript ? "false" : ""),
        transcriptLanguage,
        transcriptSource,
        transcriptStatus,
        transcriptDetail: resolvedVideoContext.fallbackDetail || "",
        summaryReady: resolvedVideoContext.summaryReady ? "true" : "false",
        summaryInputSource: resolvedVideoContext.summaryInputSource || "",
        fallbackDetail: resolvedVideoContext.fallbackDetail || "",
      },
    };
  }

  function extractXVideoDetails() {
    const articleNode = document.querySelector("article");
    const pageTitle = normalizeDirectText(
      document.querySelector("meta[property='og:title']")?.content ||
      document.querySelector("meta[name='twitter:title']")?.content ||
      document.title.replace(/\s*\/\s*X\s*$/i, "")
    );
    const author = normalizeDirectText(
      articleNode?.querySelector?.("[data-testid='User-Name']")?.innerText ||
      ""
    );
    const postText = collectXPostText(articleNode);
    const description = normalizeDirectText(
      document.querySelector("meta[property='og:description']")?.content ||
      document.querySelector("meta[name='twitter:description']")?.content ||
      ""
    );
    const videoContext = buildVideoContext({
      platform: "x",
      mediaId: extractXStatusID(),
      pageTitle,
      author,
      description,
      postText,
      transcriptText: "",
      transcriptAvailability: "unavailable",
      transcriptReason: "not_exposed",
      transcriptSource: "none",
      summaryInputSource: "",
      summaryText: "",
      fallbackDetail: "",
      summaryReady: false,
      summaryMode: "metadata_only",
    });

    const resolvedVideoContext = resolveSummaryFallback(videoContext, {
      officialSummaryText: "",
      chapterPointsText: "",
      pageText: buildXFallbackText(postText, description),
      fallbackDetailPrefix: "x_no_captions",
    });

    return {
      articleText: buildVideoArticle({
        pageTitle: resolvedVideoContext.title,
        author: resolvedVideoContext.author,
        description: resolvedVideoContext.description,
        postText: resolvedVideoContext.postText,
        summaryText: resolvedVideoContext.summaryText || "",
        summaryInputSource: resolvedVideoContext.summaryInputSource || "",
        fallbackPageText: resolvedVideoContext.summaryText ? "" : mainText,
      }),
      videoContext: resolvedVideoContext,
      metadata: {
        contentStrategy: `x_${resolvedVideoContext.summaryInputSource || "metadata"}_direct_probe`,
        transcriptAvailable: "false",
        transcriptLanguage: "",
        transcriptSource: "",
        transcriptStatus: "not_exposed",
        transcriptDetail: resolvedVideoContext.fallbackDetail || "",
        summaryReady: resolvedVideoContext.summaryReady ? "true" : "false",
        summaryInputSource: resolvedVideoContext.summaryInputSource || "",
        fallbackDetail: resolvedVideoContext.fallbackDetail || "",
      },
    };
  }

  function hasXVideoSignals() {
    return Boolean(
      document.querySelector("[data-testid='videoPlayer']") ||
      document.querySelector("[data-testid='videoComponent']") ||
      document.querySelector("video")
    );
  }

  function extractXStatusID() {
    const match = window.location.pathname.match(/\/status\/(\d+)/);
    return match?.[1] || "";
  }

  function collectXPostText(articleNode) {
    const parts = [];
    const textNodes = articleNode?.querySelectorAll?.("[data-testid='tweetText']") || [];
    for (const node of textNodes) {
      const value = normalizeDirectText(node.innerText || node.textContent || "");
      if (value) {
        parts.push(value);
      }
    }
    if (!parts.length && articleNode) {
      const fallback = normalizeDirectText(articleNode.innerText || articleNode.textContent || "");
      if (fallback) {
        parts.push(fallback);
      }
    }
    return [...new Set(parts)].join("\n");
  }

  function extractYouTubeChapterPoints() {
    const selectors = [
      "ytd-macro-markers-list-item-renderer",
      "ytd-engagement-panel-section-list-renderer [data-testid='chapter']",
      "a[href*='t=']",
    ];
    const nodes = selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
    );
    return [...new Set(nodes.map((node) => normalizeDirectText(node.innerText || node.textContent || "")).filter(Boolean))]
      .slice(0, 24)
      .join("\n");
  }

  function buildYouTubeFallbackText() {
    return [
      normalizeDirectText(document.querySelector("#description-inline-expander")?.innerText || ""),
      normalizeDirectText(document.querySelector("#description")?.innerText || ""),
      normalizeDirectText(document.querySelector("#secondary")?.innerText || ""),
    ].filter(Boolean).join("\n");
  }

  async function fetchBilibiliViewInfo(bvid) {
    if (!bvid) return null;
    try {
      const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { credentials: "include" });
      if (!response?.ok) return null;
      const payload = await response.json();
      return payload?.data ?? null;
    } catch {
      return null;
    }
  }

  async function fetchBilibiliPlayerInfo(bvid, cid) {
    if (!bvid || !cid) return null;
    try {
      const response = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`, { credentials: "include" });
      if (!response?.ok) return null;
      const payload = await response.json();
      return payload?.data ?? null;
    } catch {
      return null;
    }
  }

  async function fetchBilibiliOfficialSummary(bvid, cid) {
    if (!bvid || !cid) {
      return { text: "", reason: "bilibili_summary_missing_identifiers" };
    }
    try {
      const response = await fetch(`https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`, { credentials: "include" });
      if (!response?.ok) {
        return { text: "", reason: `bilibili_summary_http_${response?.status || 0}` };
      }
      const payload = await response.json();
      if (Number(payload?.code ?? 0) !== 0) {
        return {
          text: "",
          reason: Number(payload?.code) === -403 ? "bilibili_summary_forbidden" : `bilibili_summary_code_${payload?.code}`,
        };
      }
      const modelResult = payload?.data?.model_result ?? payload?.data ?? {};
      const summary = normalizeDirectText(modelResult?.summary || "");
      const outlineGroups = Array.isArray(modelResult?.outline) ? modelResult.outline : [];
      const outlineLines = [];
      for (const group of outlineGroups) {
        const title = normalizeDirectText(group?.title || "");
        if (title) {
          outlineLines.push(title);
        }
        if (Array.isArray(group?.part_outline)) {
          for (const item of group.part_outline) {
            const timestamp = formatTimestamp(Number(item?.timestamp ?? item?.start ?? item?.from ?? 0) * 1000);
            const content = normalizeDirectText(item?.content || item?.title || "");
            const line = [timestamp ? `[${timestamp}]` : "", content].filter(Boolean).join(" ");
            if (line) {
              outlineLines.push(line);
            }
          }
        }
      }
      const text = [...new Set([summary, outlineLines.join("\n")].map((value) => normalizeDirectText(value)).filter(Boolean))].join("\n");
      return { text: text.slice(0, 16000), reason: text ? "" : "bilibili_summary_empty" };
    } catch {
      return { text: "", reason: "bilibili_summary_fetch_failed" };
    }
  }

  function buildBilibiliChapterPoints(viewPoints) {
    return (Array.isArray(viewPoints) ? viewPoints : [])
      .map((item) => {
        const timestamp = formatTimestamp(Number(item?.from ?? item?.start ?? 0) * 1000);
        const content = normalizeDirectText(item?.content || item?.title || "");
        return [timestamp ? `[${timestamp}]` : "", content].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("\n")
      .slice(0, 16000);
  }

  function buildBilibiliFallbackText(viewInfo) {
    return [
      normalizeDirectText(viewInfo?.desc || ""),
      normalizeDirectText(document.querySelector(".video-desc-container")?.innerText || ""),
      normalizeDirectText(document.querySelector(".desc-info-text")?.innerText || ""),
      normalizeDirectText(document.querySelector("#viewbox_report")?.innerText || ""),
    ].filter(Boolean).join("\n");
  }

  function extractBilibiliCID(initialState) {
    const pages = Array.isArray(initialState?.videoData?.pages) ? initialState.videoData.pages : [];
    return pages[0]?.cid ?? initialState?.videoData?.cid ?? initialState?.cid ?? "";
  }

  function buildXFallbackText(postText, description) {
    return [normalizeDirectText(postText || ""), normalizeDirectText(description || ""), normalizeDirectText(mainText || "")]
      .filter(Boolean)
      .join("\n");
  }

  function formatDurationSeconds(value) {
    const seconds = Number(value ?? 0);
    return seconds > 0 ? formatTimestamp(seconds * 1000) : "";
  }

  function chooseBilibiliTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) {
      return null;
    }
    return (
      tracks.find((track) => {
        const label = String(track?.lan_doc ?? track?.lan ?? "").toLowerCase();
        return !label.includes("auto") && (/^zh|^en/.test(label));
      }) ||
      tracks.find((track) => {
        const label = String(track?.lan_doc ?? track?.lan ?? "").toLowerCase();
        return !label.includes("auto");
      }) ||
      tracks[0]
    );
  }

  function normalizeBilibiliSubtitleURL(url) {
    if (!url) return "";
    if (url.startsWith("//")) return `https:${url}`;
    return url;
  }

  async function fetchBilibiliTranscript(url) {
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response?.ok) {
        return { text: "", status: "fetch_failed" };
      }
      const payload = await response.json();
      const body = Array.isArray(payload?.body) ? payload.body : [];
      const lines = body
        .map((item) => {
          const timestamp = formatTimestamp(Number(item?.from ?? 0) * 1000);
          const text = normalizeDirectText(String(item?.content ?? ""));
          return timestamp && text ? `[${timestamp}] ${text}` : text;
        })
        .filter(Boolean);
      const text = lines.join("\n").slice(0, 16000);
      return { text, status: text ? "ok" : "empty_transcript" };
    } catch {
      return { text: "", status: "fetch_failed" };
    }
  }

  function mapTranscriptReason(status) {
    switch (String(status || "")) {
      case "pending":
      case "":
        return "not_requested";
      case "caption_track_missing_url":
      case "no_caption_tracks":
      case "no_subtitle_tracks":
        return "no_tracks";
      case "not_exposed":
        return "not_exposed";
      case "parse_failed":
      case "html_response":
      case "ok_xml":
      case "ok_ttml":
        return "parse_failed";
      default:
        return "fetch_failed";
    }
  }

  function readVisibleYouTubeTranscriptFromDOM() {
    const segmentNodes = Array.from(
      document.querySelectorAll(
        [
          "ytd-transcript-segment-renderer",
          "ytd-transcript-search-panel-renderer ytd-transcript-segment-renderer",
          "ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer",
        ].join(", ")
      )
    );

    const lines = segmentNodes
      .map((node) => {
        const timestamp = normalizeDirectText(
          node.querySelector?.(".segment-timestamp")?.innerText ||
          node.querySelector?.("[class*='timestamp']")?.innerText ||
          ""
        );
        const text = normalizeDirectText(
          node.querySelector?.(".segment-text")?.innerText ||
          node.querySelector?.("[class*='segment-text']")?.innerText ||
          node.innerText ||
          ""
        );
        if (!text) {
          return "";
        }
        if (timestamp && text.startsWith(timestamp)) {
          const trimmed = normalizeDirectText(text.slice(timestamp.length));
          return trimmed ? `[${timestamp}] ${trimmed}` : "";
        }
        return timestamp ? `[${timestamp}] ${text}` : text;
      })
      .filter(Boolean);

    const text = lines.join("\n").slice(0, 16000);
    return {
      text,
      status: text ? "ok_dom" : "",
      detail: text ? `segments:${segmentNodes.length}` : "",
    };
  }

  async function ensureYouTubeTranscriptFromDOM() {
    const existing = readVisibleYouTubeTranscriptFromDOM();
    if (existing.text) {
      return existing;
    }

    const clickedTranscript = clickYouTubeTranscriptButton();
    if (!clickedTranscript) {
      clickYouTubeExpandButton();
      await wait(260);
      clickYouTubeTranscriptButton();
    }

    for (const delay of [180, 360, 720, 1200]) {
      await wait(delay);
      const next = readVisibleYouTubeTranscriptFromDOM();
      if (next.text) {
        return {
          ...next,
          status: "ok_dom_auto",
          detail: next.detail || "opened_transcript_panel",
        };
      }
    }

    return { text: "", status: "", detail: "" };
  }

  function clickYouTubeTranscriptButton() {
    const matcher = /(show transcript|open transcript|transcript|显示文字记录|显示转录|转录稿|文字记录)/i;
    for (const candidate of queryYouTubeActionCandidates()) {
      const text = normalizeDirectText(candidate.innerText || candidate.textContent || "");
      const label = normalizeDirectText(
        candidate.getAttribute?.("aria-label") ||
        candidate.getAttribute?.("title") ||
        ""
      );
      if (matcher.test(text) || matcher.test(label)) {
        clickActionNode(candidate);
        return true;
      }
    }
    return false;
  }

  function clickYouTubeExpandButton() {
    const matcher = /(^more$|show more|expand|更多|展开|显示更多)/i;
    for (const candidate of queryYouTubeActionCandidates()) {
      const text = normalizeDirectText(candidate.innerText || candidate.textContent || "");
      const label = normalizeDirectText(
        candidate.getAttribute?.("aria-label") ||
        candidate.getAttribute?.("title") ||
        ""
      );
      if (matcher.test(text) || matcher.test(label)) {
        clickActionNode(candidate);
        return true;
      }
    }
    return false;
  }

  function queryYouTubeActionCandidates() {
    const roots = [
      document.querySelector("ytd-watch-metadata"),
      document.querySelector("#description"),
      document.querySelector("#description-inline-expander"),
      document.querySelector("ytd-text-inline-expander"),
      document.body,
    ].filter(Boolean);

    const seen = new Set();
    const candidates = [];
    for (const root of roots) {
      const nodes = root.querySelectorAll?.("*") || [];
      for (const node of nodes) {
        const clickable = resolveYouTubeClickable(node);
        if (!clickable || seen.has(clickable)) {
          continue;
        }
        seen.add(clickable);
        candidates.push(clickable);
      }
    }
    return candidates;
  }

  function resolveYouTubeClickable(node) {
    return node?.closest?.(
      [
        "button",
        "[role='button']",
        "tp-yt-paper-button",
        "yt-button-shape",
        "yt-button-shape button",
        "ytd-button-renderer",
        "ytd-menu-service-item-renderer",
        "tp-yt-paper-item",
        "yt-formatted-string",
      ].join(", ")
    ) || null;
  }

  function wait(delayMs) {
    return new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }

  function readPlayerResponseFromPage() {
    const direct = window.ytInitialPlayerResponse;
    return direct && typeof direct === "object" ? direct : null;
  }

  function readPlayerResponseFromScripts() {
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const script of scripts) {
      const source = String(script.textContent || "");
      const parsed =
        parseEmbeddedJson(source, "ytInitialPlayerResponse") ||
        parseEmbeddedJson(source, "var ytInitialPlayerResponse");
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  async function fetchYouTubeTranscript(url) {
    try {
      const candidates = buildTranscriptCandidateURLs(url);
      let bestFailure = { status: "parse_failed", detail: "unrecognized_response" };
      for (const candidate of candidates) {
        const response = await fetch(candidate, { credentials: "include" });
        if (!response?.ok) {
          bestFailure = {
            status: "fetch_failed",
            detail: summarizeCandidateFailure(candidate, `http_${response?.status || "error"}`),
          };
          continue;
        }
        const raw = await response.text();
        const parsed = parseYouTubeTranscriptResponse(raw);
        if (parsed.text) {
          return {
            text: parsed.text,
            status: parsed.status,
            detail: parsed.detail || "",
          };
        }
        bestFailure = {
          status: parsed.status || "parse_failed",
          detail: summarizeCandidateFailure(candidate, parsed.detail || parsed.status || "unrecognized_response"),
        };
      }
      return { text: "", status: bestFailure.status, detail: bestFailure.detail };
    } catch {
      return { text: "", status: "fetch_failed", detail: "request_exception" };
    }
  }

  function buildTranscriptCandidateURLs(url) {
    const base = String(url || "");
    const candidates = [];
    if (base) {
      candidates.push(base.includes("fmt=json3") ? base : `${base}${base.includes("?") ? "&" : "?"}fmt=json3`);
      if (!base.includes("fmt=srv3")) {
        candidates.push(`${base}${base.includes("?") ? "&" : "?"}fmt=srv3`);
      }
      if (!base.includes("fmt=ttml")) {
        candidates.push(`${base}${base.includes("?") ? "&" : "?"}fmt=ttml`);
      }
      candidates.push(base);
    }
    return [...new Set(candidates)];
  }

  function parseYouTubeTranscriptResponse(raw) {
    const normalizedRaw = String(raw || "").trim();
    const jsonText = stripJsonSafetyPrefix(normalizedRaw);
    const jsonResult = parseYouTubeJsonTranscript(jsonText);
    if (jsonResult.text) {
      return jsonResult;
    }

    const xmlText = decodeHtmlEntities(normalizedRaw);
    const xmlResult = parseYouTubeXmlTranscript(xmlText);
    if (xmlResult) {
      return { text: xmlResult, status: "ok_xml" };
    }

    const ttmlResult = parseYouTubeTimedParagraphTranscript(xmlText);
    if (ttmlResult) {
      return { text: ttmlResult, status: "ok_ttml" };
    }

    if (/<html|<!doctype/i.test(normalizedRaw)) {
      return { text: "", status: "html_response", detail: buildResponsePreview(normalizedRaw) };
    }

    return {
      text: "",
      status: "parse_failed",
      detail: buildResponsePreview(normalizedRaw),
    };
  }

  function stripJsonSafetyPrefix(raw) {
    return String(raw || "").replace(/^\)\]\}'\s*/, "");
  }

  function parseYouTubeJsonTranscript(raw) {
    try {
      const payload = JSON.parse(raw);
      const events = Array.isArray(payload?.events) ? payload.events : [];
      const lines = events
        .map((event) => {
          const start = formatTimestamp(event?.tStartMs);
          const text = (event?.segs ?? [])
            .map((segment) => String(segment?.utf8 ?? ""))
            .join("")
            .replace(/\s+/g, " ")
            .trim();
          return start && text ? `[${start}] ${text}` : text;
        })
        .filter(Boolean);
      const text = lines.join("\n").slice(0, 16000);
      return { text, status: text ? "ok_json3" : "empty_transcript", detail: "" };
    } catch {
      return { text: "", status: "" };
    }
  }

  function buildResponsePreview(raw) {
    const sample = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!sample) {
      return "empty";
    }
    if (sample.startsWith("{") || sample.startsWith("[")) {
      return `json:${sample}`;
    }
    if (sample.startsWith("<")) {
      return `xml:${sample}`;
    }
    return `text:${sample}`;
  }

  function summarizeCandidateFailure(url, detail) {
    const format =
      url.includes("fmt=json3") ? "json3"
      : url.includes("fmt=srv3") ? "srv3"
      : url.includes("fmt=ttml") ? "ttml"
      : "base";
    return `${format}:${String(detail || "").slice(0, 160)}`;
  }

  function chooseCaptionTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) {
      return null;
    }
    return (
      tracks.find((track) => !track.kind && /^zh|^en/i.test(String(track.languageCode ?? ""))) ||
      tracks.find((track) => !track.kind) ||
      tracks[0]
    );
  }

  function parseEmbeddedJson(source, marker) {
    if (!source || !marker) {
      return null;
    }
    const index = source.indexOf(marker);
    if (index < 0) {
      return null;
    }
    const start = source.indexOf("{", index);
    if (start < 0) {
      return null;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  function parseYouTubeXmlTranscript(raw) {
    const matches = Array.from(String(raw || "").matchAll(/<text[^>]*start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g));
    return matches
      .map((match) => {
        const start = formatTimestamp(Number(match[1]) * 1000);
        const text = normalizeDirectText(
          decodeHtmlEntities(match[2])
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]+>/g, " ")
        );
        return start && text ? `[${start}] ${text}` : text;
      })
      .filter(Boolean)
      .join("\n")
      .slice(0, 16000);
  }

  function parseYouTubeTimedParagraphTranscript(raw) {
    const matches = Array.from(String(raw || "").matchAll(/<p[^>]*?\bt="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g));
    return matches
      .map((match) => {
        const start = formatTimestamp(Number(match[1] || 0));
        const text = normalizeDirectText(
          decodeHtmlEntities(match[2])
            .replace(/<s[^>]*>/g, " ")
            .replace(/<\/s>/g, " ")
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]+>/g, " ")
        );
        return start && text ? `[${start}] ${text}` : text;
      })
      .filter(Boolean)
      .join("\n")
      .slice(0, 16000);
  }

  function decodeHtmlEntities(value) {
    return String(value || "")
      .replace(/&amp;/g, "&")
      .replace(/\\u0026/g, "&")
      .replace(/&quot;/g, '"');
  }

  function formatTimestamp(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(milliseconds ?? 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function normalizeDirectText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 12000);
  }

  function describeNode(node) {
    if (!node) return "unknown";
    const tag = String(node.tagName || "").toLowerCase() || "unknown";
    const id = node.id ? `#${node.id}` : "";
    return `${tag}${id}`;
  }

  function normalizeColorScheme(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized.includes("dark") && !normalized.includes("light")) return "dark";
    if (normalized.includes("light") && !normalized.includes("dark")) return "light";
    return "";
  }

  function isTransparent(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return !normalized || normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)";
  }

  function inferSchemeFromColor(value) {
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
}

async function syncTabContext(tabId, tab, source = "") {
  triggerContentSync(tabId).catch(() => {});
  const contextResult = await requestPageContext(tabId);
  const context = contextResult.ok
    ? contextResult.payload?.context ?? buildFallbackContext(tab)
    : buildFallbackContext(tab);

  TAB_STATE.set(tabId, mergeStableSelection(TAB_STATE.get(tabId), context, source));
  await syncPanelState(tabId, TAB_STATE.get(tabId));
  return contextResult;
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

function detectSiteFromHostname(hostname) {
  if (hostname.includes("github.com")) return "github";
  if (hostname.includes("mail.google.com")) return "gmail";
  if (hostname === "www.youtube.com" || hostname === "youtube.com" || hostname === "m.youtube.com" || hostname === "youtu.be") {
    return "youtube";
  }
  if (hostname === "www.bilibili.com" || hostname === "bilibili.com" || hostname.endsWith(".bilibili.com") || hostname === "b23.tv") {
    return "bilibili";
  }
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter.com")) {
    return "x";
  }
  if (hostname.includes("mail.yahoo.com")) return "yahoo_mail";
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

  const preservePrevious = shouldPreservePreviousContext(previousContext, nextContext);
  const baseContext = preservePrevious && previousContext ? previousContext : nextContext;
  const nextSelection = String(nextContext.selection ?? "").trim();
  const mergedSelection = nextSelection || String(baseContext.selection ?? "").trim();

  return {
    ...baseContext,
    selection: mergedSelection,
    debugSelection: {
      ...(baseContext.debugSelection ?? {}),
      backgroundPreviousSelection: truncateDebugValue(previousContext?.selection ?? ""),
      backgroundMergedSelection: truncateDebugValue(mergedSelection),
      backgroundSource: source,
    },
  };
}

function shouldPreservePreviousContext(previousContext, nextContext) {
  if (!previousContext || typeof previousContext !== "object") {
    return false;
  }
  const previousURL = String(previousContext.url ?? "");
  const nextURL = String(nextContext.url ?? "");
  if (!previousURL || previousURL !== nextURL) {
    return false;
  }

  const previousResolvedRank = resolvedVideoStateRank(previousContext);
  const nextResolvedRank = resolvedVideoStateRank(nextContext);
  if (previousResolvedRank > nextResolvedRank) {
    return true;
  }
  if (previousResolvedRank < nextResolvedRank) {
    return false;
  }

  return pageContextTransportRank(previousContext) > pageContextTransportRank(nextContext);
}

function resolvedVideoStateRank(context) {
  const videoContext = context?.videoContext;
  if (!videoContext || typeof videoContext !== "object") {
    return 0;
  }
  if (videoContext.transcriptAvailability === "available") {
    return 5;
  }
  if (videoContext.summaryReady !== true) {
    return 0;
  }
  switch (String(videoContext.summaryInputSource ?? "")) {
    case "official_summary":
      return 4;
    case "chapter_points":
      return 3;
    case "page_text":
      return 2;
    case "metadata_only":
      return 1;
    default:
      return 1;
  }
}

function pageContextTransportRank(context) {
  const transport = String(context?.metadata?.pageContextTransport ?? "");
  switch (transport) {
    case "content_event":
      return 4;
    case "content_script":
      return 3;
    case "cached_context":
      return 2;
    case "direct_execute_script":
      return 1;
    default:
      return 0;
  }
}

function videoContextCacheKey(context) {
  const videoContext = context?.videoContext;
  if (!videoContext || typeof videoContext !== "object") {
    return "";
  }
  const platform = String(videoContext.platform ?? "");
  const mediaId = String(videoContext.mediaId ?? "");
  const language = String(videoContext.transcriptLanguage ?? "");
  if (!platform || !mediaId) {
    return "";
  }
  return `${platform}:${mediaId}:${language}`;
}

function shouldCacheResolvedVideoContext(context) {
  const videoContext = context?.videoContext;
  if (!videoContext || typeof videoContext !== "object") {
    return false;
  }
  if (videoContext.transcriptAvailability === "available") {
    return true;
  }
  return videoContext.summaryReady === true;
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
