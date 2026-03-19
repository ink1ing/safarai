import { createRequest } from "./protocol.js";

const hostStatus = document.getElementById("host-status");
const siteName = document.getElementById("site-name");
const pageTitle = document.getElementById("page-title");
const pageSelection = document.getElementById("page-selection");
const citationHint = document.getElementById("citation-hint");
const conversationList = document.getElementById("conversation-list");
const conversationStatus = document.getElementById("conversation-status");
const questionEditor = document.getElementById("question-editor");
const summarizePageButton = document.getElementById("summarize-page");
const explainSelectionButton = document.getElementById("explain-selection");
const extractStructuredInfoButton = document.getElementById("extract-structured-info");
const askPageButton = document.getElementById("ask-page");
const accountPill = document.getElementById("account-pill");
const modelSelect = document.getElementById("model-select");
const authToggle = document.getElementById("auth-toggle");

let sessionMessages = [];
let currentSelection = "";
let isLoggedIn = false;
let loginPollTimer = null;
let didAutoRefreshModels = false;

summarizePageButton.addEventListener("click", () => runAction("sidebar:summarize-page"));
explainSelectionButton.addEventListener("click", () => runAction("sidebar:explain-selection"));
extractStructuredInfoButton.addEventListener("click", () => runAction("sidebar:extract-structured-info"));
askPageButton.addEventListener("click", sendQuestion);
authToggle.addEventListener("click", handleAuthToggle);
modelSelect.addEventListener("change", saveSelectedModel);
questionEditor.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendQuestion();
  }
});

loadContext();
loadSession();
loadProviderStatus();

async function loadContext() {
  const response = await browser.runtime.sendMessage({
    type: "sidebar:get-page-context",
  });

  if (!response?.ok) {
    siteName.textContent = "-";
    pageTitle.textContent = "页面读取失败";
    pageSelection.textContent = "无选中文本";
    citationHint.textContent = "无法读取当前页面内容";
    return;
  }

  const context = response.payload?.context ?? {};
  siteName.textContent = context.site || "-";
  pageTitle.textContent = context.title || "-";
  currentSelection = context.selection || "";
  pageSelection.textContent = currentSelection || "无选中文本";
  updateCitationHint();
}

async function loadProviderStatus() {
  const response = await sendNativeControlRequest("get_status");

  if (!response?.ok) {
    isLoggedIn = false;
    hostStatus.textContent = "离线";
    accountPill.textContent = "未登录";
    authToggle.textContent = "登录";
    authToggle.disabled = false;
    modelSelect.disabled = true;
    disableInferenceActions(true);
    stopLoginPoll();
    return;
  }

  isLoggedIn = response.payload?.authState === "logged_in";
  const loginInProgress = response.payload?.loginInProgress === true;
  const email = response.payload?.email || "";
  const availableModels = response.payload?.availableModels ?? [];
  const selectedModel = response.payload?.selectedModel || "gpt-5";

  hostStatus.textContent = loginInProgress ? "登录中" : isLoggedIn ? "已连接" : "未登录";
  accountPill.textContent = loginInProgress ? "登录中…" : email || (isLoggedIn ? "已登录" : "未登录");
  authToggle.textContent = isLoggedIn ? "退出" : loginInProgress ? "登录中" : "登录";
  authToggle.disabled = loginInProgress;
  modelSelect.disabled = !isLoggedIn;
  bindModelSelect(availableModels, selectedModel);
  disableInferenceActions(!isLoggedIn);

  if (loginInProgress) {
    scheduleLoginPoll();
  } else {
    stopLoginPoll();
  }

  if (isLoggedIn && !didAutoRefreshModels && (!availableModels.length || availableModels.length === 1 && availableModels[0].id === "gpt-5")) {
    didAutoRefreshModels = true;
    refreshCodexModels();
  }
}

async function handleAuthToggle() {
  if (isLoggedIn) {
    await logoutCodex();
    return;
  }

  await startCodexLogin();
}

async function startCodexLogin() {
  hostStatus.textContent = "登录中";
  conversationStatus.textContent = "正在拉起登录";
  const response = await sendNativeControlRequest("start_login");
  if (!response?.ok) {
    hostStatus.textContent = "失败";
    conversationStatus.textContent = "登录失败";
    return;
  }
  conversationStatus.textContent = response.payload?.loginDispatch || "请求已发送";
  scheduleLoginPoll();
}

async function logoutCodex() {
  const response = await sendNativeControlRequest("logout");
  if (!response?.ok) {
    hostStatus.textContent = "失败";
    conversationStatus.textContent = response?.error?.message ?? "登出失败";
    return;
  }

  didAutoRefreshModels = false;
  conversationStatus.textContent = response.payload?.answer ?? "已登出";
  await loadProviderStatus();
}

async function refreshCodexModels() {
  const response = await sendNativeControlRequest("refresh_models");
  if (!response?.ok) {
    return;
  }

  bindModelSelect(response.payload?.availableModels ?? [], response.payload?.selectedModel || "gpt-5");
  didAutoRefreshModels = true;
  await loadProviderStatus();
}

async function saveSelectedModel() {
  if (!isLoggedIn) {
    return;
  }

  const response = await sendNativeControlRequest("save_selected_model", {
    selectedModel: modelSelect.value,
  });
  if (!response?.ok) {
    return;
  }

  await loadProviderStatus();
}

async function runAction(type) {
  if (!isLoggedIn) {
    conversationStatus.textContent = "请先登录 Codex";
    return;
  }

  conversationStatus.textContent = "生成中";
  const response = await browser.runtime.sendMessage({ type });
  if (!response?.ok) {
    conversationStatus.textContent = response?.error?.message ?? "请求失败";
    return;
  }

  await loadSession();
  conversationStatus.textContent = "已更新";
}

async function sendQuestion() {
  if (!isLoggedIn) {
    conversationStatus.textContent = "请先登录 Codex";
    return;
  }

  const prompt = questionEditor.value.trim();
  if (!prompt) {
    conversationStatus.textContent = "请输入问题";
    return;
  }

  questionEditor.value = "";
  conversationStatus.textContent = "正在回答";
  const response = await browser.runtime.sendMessage({
    type: "sidebar:ask-page",
    payload: { prompt, selection: currentSelection },
  });

  if (!response?.ok) {
    conversationStatus.textContent = response?.error?.message ?? "问答失败";
    return;
  }

  await loadSession();
  conversationStatus.textContent = "已回答";
}

async function loadSession() {
  const response = await browser.runtime.sendMessage({
    type: "sidebar:get-session",
  });

  if (!response?.ok) {
    renderConversation([]);
    return;
  }

  syncSession(response.payload?.messages);
}

function syncSession(messages) {
  if (!Array.isArray(messages)) {
    renderConversation([]);
    return;
  }

  sessionMessages = messages;
  conversationStatus.textContent = messages.length ? `${messages.length} 条` : "空";
  renderConversation(messages);
}

function renderConversation(messages) {
  conversationList.innerHTML = "";

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "conversation-item conversation-item--system";
    empty.dataset.role = "system";
    empty.innerHTML = `
      <span class="conversation-role">system / hint</span>
      <div>把问题输入底部，回车发送。系统会默认结合当前页面上下文；如果有选中文本，会把它作为重点引用。</div>
    `;
    conversationList.appendChild(empty);
    return;
  }

  for (const item of messages) {
    const entry = document.createElement("div");
    const role = item.role || "system";
    entry.className = `conversation-item conversation-item--${role}`;
    entry.dataset.role = role;
    entry.innerHTML = `
      <span class="conversation-role">${escapeHtml(role)} / ${escapeHtml(item.kind || "message")}</span>
      <div>${escapeHtml(item.text || "")}</div>
    `;
    conversationList.appendChild(entry);
  }
}

function updateCitationHint() {
  if (currentSelection) {
    citationHint.textContent = `当前选区将自动纳入回答：${truncate(currentSelection, 48)}`;
    questionEditor.placeholder = "输入问题，回车发送，系统会结合选区与整页内容回答";
    return;
  }

  citationHint.textContent = "当前页面内容会自动纳入回答";
  questionEditor.placeholder = "输入问题，回车发送，Shift+回车换行";
}

function disableInferenceActions(disabled) {
  summarizePageButton.disabled = disabled;
  explainSelectionButton.disabled = disabled;
  extractStructuredInfoButton.disabled = disabled;
  askPageButton.disabled = disabled;
  questionEditor.disabled = disabled;
}

function bindModelSelect(models, selected) {
  modelSelect.innerHTML = "";
  const safeModels = Array.isArray(models) && models.length ? models : [{ id: "gpt-5", label: "gpt-5" }];
  for (const model of safeModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label || model.id;
    modelSelect.appendChild(option);
  }
  modelSelect.value = selected || "gpt-5";
}

async function sendNativeControlRequest(type, payload = {}) {
  try {
    const response = await browser.runtime.sendNativeMessage(createRequest(type, payload));
    if (!response?.ok) {
      return response;
    }
    return response;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "native_host_unavailable",
        message: `无法连接宿主 App：${error.message}`,
      },
    };
  }
}

function scheduleLoginPoll() {
  stopLoginPoll();
  loginPollTimer = setInterval(() => {
    loadProviderStatus();
  }, 2000);
}

function stopLoginPoll() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncate(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}
