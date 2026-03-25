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

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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
    const probedContext = await probePageContextDirectly(tabId, tab);
    if (probedContext) {
      return createSuccessResponse({
        context: probedContext,
        degraded: true,
      });
    }

    if (allowInjection) {
      const injected = await ensureContentScriptInjected(tabId);
      if (injected) {
        await delay(140);
        return requestPageContext(tabId, { allowInjection: false });
      }
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

async function probePageContextDirectly(tabId, tab) {
  if (!tabId) {
    return null;
  }

  try {
    if (browser.scripting?.executeScript) {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: directPageContextProbe,
      });
      const payload = results?.[0]?.result ?? null;
      return normalizeDirectProbePayload(payload, tab);
    }
  } catch {
    // Fall through to legacy executeScript path.
  }

  try {
    if (browser.tabs?.executeScript) {
      const code = `(${directPageContextProbe.toString()})()`;
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
    metadata: {
      domain: String(metadata.domain ?? ""),
      pageKind: String(metadata.pageKind ?? "page"),
      contentStrategy: "direct_visual_probe",
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
      hasIframes: "false",
      hasShadowHosts: "false",
    },
  };
}

function directPageContextProbe() {
  const hostname = window.location.hostname || "";
  const pathname = window.location.pathname || "";
  const title = document.title || "Untitled";
  const selection = String(window.getSelection?.()?.toString?.() ?? "").trim();
  const mainText =
    normalizeDirectText(document.querySelector("main")?.innerText) ||
    normalizeDirectText(document.querySelector("article")?.innerText) ||
    "";
  const visual = extractDirectVisualState();

  return {
    site: detectDirectSite(hostname),
    url: window.location.href,
    title,
    selection,
    articleText: mainText || `title: ${title}\nurl: ${window.location.href}`,
    metadata: {
      domain: hostname,
      pageKind: inferDirectPageKind(hostname, pathname),
      pageBackgroundColor: visual.backgroundColor,
      pageBackgroundImage: visual.backgroundImage,
      pageColorScheme: visual.colorScheme,
      pageBackgroundSource: visual.source,
    },
  };

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
    if (currentHostname === "x.com" || currentHostname.endsWith(".x.com") || currentHostname.includes("twitter.com")) {
      return "x";
    }
    if (currentHostname.includes("mail.yahoo.com")) return "yahoo_mail";
    return "unsupported";
  }

  function inferDirectPageKind(currentHostname, currentPathname) {
    const site = detectDirectSite(currentHostname);
    if (site === "x") {
      if (/\/status\/\d+/.test(currentPathname)) return "x_post";
      if (currentPathname === "/home") return "x_home";
    }
    return "page";
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

  const nextSelection = String(nextContext.selection ?? "").trim();

  return {
    ...nextContext,
    selection: nextSelection,
    debugSelection: {
      ...(nextContext.debugSelection ?? {}),
      backgroundPreviousSelection: truncateDebugValue(previousContext?.selection ?? ""),
      backgroundMergedSelection: truncateDebugValue(nextSelection),
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
