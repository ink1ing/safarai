const conversationList = document.getElementById("conversation-list");
const conversationStatus = document.getElementById("conversation-status");
const questionEditor = document.getElementById("question-editor");
const askPageButton = document.getElementById("ask-page");
const accountPill = document.getElementById("account-pill");
const modelSelect = document.getElementById("model-select");
const authToggle = document.getElementById("auth-toggle");
const selectionToggle = document.getElementById("selection-toggle");

let sessionMessages = [];
let isLoggedIn = false;
let loginPollTimer = null;
let didAutoRefreshModels = false;
let currentSelection = "";
let pageContextReady = false;
const protocolModulePromise = loadProtocolModule();

askPageButton.addEventListener("click", sendQuestion);
authToggle.addEventListener("click", handleAuthToggle);
modelSelect.addEventListener("change", saveSelectedModel);
selectionToggle.addEventListener("click", toggleSelectionReference);
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
    pageContextReady = false;
    currentSelection = "";
    syncSelectionToggle();
    conversationStatus.textContent = "页面上下文提取失败";
    return null;
  }

  pageContextReady = true;
  currentSelection = String(response.payload?.context?.selection ?? "").trim();
  syncSelectionToggle();
  return response.payload?.context ?? null;
}

async function loadProviderStatus() {
  const response = await sendNativeControlRequest("get_status");

  if (!response?.ok) {
    isLoggedIn = false;
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

  if (isLoggedIn && !didAutoRefreshModels && (!availableModels.length || (availableModels.length === 1 && availableModels[0].id === "gpt-5"))) {
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
  conversationStatus.textContent = "正在登录";
  const response = await sendNativeControlRequest("start_login");
  if (!response?.ok) {
    conversationStatus.textContent = response?.error?.message ?? "登录失败";
    return;
  }

  conversationStatus.textContent = response.payload?.loginDispatch || "请求已发送";
  scheduleLoginPoll();
}

async function logoutCodex() {
  const response = await sendNativeControlRequest("logout");
  if (!response?.ok) {
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

  const context = await loadContext();
  if (!context || !pageContextReady) {
    conversationStatus.textContent = "页面上下文提取失败";
    return;
  }

  questionEditor.value = "";
  conversationStatus.textContent = "正在回答";
  const response = await browser.runtime.sendMessage({
    type: "sidebar:ask-page",
    payload: {
      prompt,
      selection: selectionToggle.dataset.active === "true" ? currentSelection : "",
    },
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
      <span class="conversation-role">system</span>
      <div>暂无对话</div>
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
      <span class="conversation-role">${escapeHtml(role)}</span>
      <div>${escapeHtml(item.text || "")}</div>
    `;
    conversationList.appendChild(entry);
  }
}

function disableInferenceActions(disabled) {
  askPageButton.disabled = disabled;
  questionEditor.disabled = disabled;
  selectionToggle.disabled = disabled;
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
    const { createRequest } = await protocolModulePromise;
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

async function loadProtocolModule() {
  const runtimeGetURL =
    typeof browser?.runtime?.getURL === "function"
      ? browser.runtime.getURL.bind(browser.runtime)
      : (path) => path;
  return import(runtimeGetURL("protocol.js"));
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

function toggleSelectionReference() {
  if (selectionToggle.hidden) {
    return;
  }

  const nextActive = selectionToggle.dataset.active !== "true";
  selectionToggle.dataset.active = nextActive ? "true" : "false";
}

function syncSelectionToggle() {
  if (!currentSelection) {
    selectionToggle.hidden = true;
    selectionToggle.dataset.active = "false";
    return;
  }

  selectionToggle.hidden = false;
  selectionToggle.dataset.active = "true";
  selectionToggle.textContent = `引用选中内容 (${truncate(currentSelection, 18)})`;
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
  return `${text.slice(0, limit - 1)}...`;
}
