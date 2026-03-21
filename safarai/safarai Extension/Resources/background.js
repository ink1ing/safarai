import {
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isSupportedSite,
} from "./protocol.js";
import { appendLog, loadLogs } from "./log-store.js";
import { loadSession, saveSession } from "./session-store.js";

const TAB_STATE = new Map();

browser.runtime.onInstalled.addListener(() => {
  console.log("Safari AI background ready");
});

setInterval(() => {
  syncActiveTabSnapshot().catch(() => {});
}, 1200);

if (browser.tabs?.onUpdated) {
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!tabId || (!changeInfo.url && changeInfo.status !== "complete")) {
      return;
    }

    const contextResult = await requestPageContext(tabId);
    const context = contextResult.ok
      ? contextResult.payload?.context ?? {}
      : buildFallbackContext(tab);

    TAB_STATE.set(tabId, context);
    await syncPanelState(tabId, context);
  });
}

if (browser.tabs?.onActivated) {
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await browser.tabs.get(activeInfo.tabId).catch(() => null);
    if (!tab?.id) {
      return;
    }

    const contextResult = await requestPageContext(tab.id);
    const context = contextResult.ok
      ? contextResult.payload?.context ?? {}
      : buildFallbackContext(tab);

    TAB_STATE.set(tab.id, context);
    await syncPanelState(tab.id, context);
  });
}

if (browser.action?.onClicked) {
  browser.action.onClicked.addListener(async (tab) => {
    const tabId = tab?.id ?? null;
    const contextResult = await ensurePageContext(tabId);
    const context = contextResult.ok ? contextResult.payload?.context ?? {} : {};
    const messages = tabId ? await loadSession(tabId) : [];
    await sendNativeControlRequest("sync_panel_state", {
      context,
      messages,
    });
    await sendNativeControlRequest("show_panel", {
      context,
      messages,
    });
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
    case "sidebar:get-session":
      return getSession(sender.tab?.id);
    case "sidebar:ask-page":
      return askPage(sender.tab?.id, message.payload?.prompt, message.payload?.selection);
    case "sidebar:get-logs":
      return getLogs();
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

  TAB_STATE.set(tab.id, pageContext.payload.context);
  await syncPanelState(tab.id, pageContext.payload.context);
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

  const contextResult = await requestPageContext(tab.id);
  const context = contextResult.ok
    ? contextResult.payload?.context ?? buildFallbackContext(tab)
    : buildFallbackContext(tab);

  TAB_STATE.set(tab.id, context);
  await syncPanelState(tab.id, context);
}

async function syncPanelStateFromContent(tabId, context) {
  if (!context) {
    return createSuccessResponse({ synced: false });
  }

  const resolvedTabId = await resolveTabId(tabId);
  if (!resolvedTabId) {
    return createSuccessResponse({ synced: false });
  }

  TAB_STATE.set(resolvedTabId, context);
  await syncPanelState(resolvedTabId, context);
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

  try {
    const response = await browser.tabs.sendMessage(tabId, {
      type: "content:get-page-context",
    });

    if (!response?.ok) {
      return createSuccessResponse({
        context: buildFallbackContext(tab),
        degraded: true,
      });
    }

    const context = response.payload?.context;
    if (!context) {
      return createSuccessResponse({
        context: buildFallbackContext(tab),
        degraded: true,
      });
    }

    const normalizedSite = isSupportedSite(context.site) ? context.site : "unsupported";
    return createSuccessResponse({
      context: {
        ...context,
        site: normalizedSite,
      },
    });
  } catch (error) {
    return createSuccessResponse({
      context: buildFallbackContext(tab),
      degraded: true,
    });
  }
}

function buildFallbackContext(tab) {
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
    focusedInput: null,
    metadata: {
      domain,
      pageKind: "fallback_tab_context",
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
