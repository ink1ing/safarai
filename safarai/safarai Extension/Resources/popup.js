import { createRequest } from "./protocol.js";

const hostStatus = document.getElementById("host-status");
const siteName = document.getElementById("site-name");
const pageTitle = document.getElementById("page-title");
const pageUrl = document.getElementById("page-url");
const pageSelection = document.getElementById("page-selection");
const focusedInput = document.getElementById("focused-input");
const pageKind = document.getElementById("page-kind");
const pageRepository = document.getElementById("page-repository");
const answerOutput = document.getElementById("answer-output");
const applyDraftButton = document.getElementById("apply-draft");
const copyDraftButton = document.getElementById("copy-draft");
const copyLogsButton = document.getElementById("copy-logs");
const copyAnswerButton = document.getElementById("copy-answer");
const draftEditor = document.getElementById("draft-editor");
const draftTarget = document.getElementById("draft-target");
const questionEditor = document.getElementById("question-editor");
const conversationList = document.getElementById("conversation-list");
const conversationStatus = document.getElementById("conversation-status");
const startLoginButton = document.getElementById("start-login");
const logoutAccountButton = document.getElementById("logout-account");
const refreshModelsButton = document.getElementById("refresh-models");
const saveModelButton = document.getElementById("save-model");
const accountEmail = document.getElementById("account-email");
const modelSelect = document.getElementById("model-select");
const loginStage = document.getElementById("login-stage");
let pendingDraft = "";
let pendingTargetDescription = "";
let sessionMessages = [];
let isLoggedIn = false;
let loginPollTimer = null;

document
  .getElementById("refresh-context")
  .addEventListener("click", () => loadContext({ announce: true }));
document
  .getElementById("summarize-page")
  .addEventListener("click", () => runAction("sidebar:summarize-page"));
document
  .getElementById("explain-selection")
  .addEventListener("click", () => runAction("sidebar:explain-selection"));
document
  .getElementById("extract-structured-info")
  .addEventListener("click", () => runAction("sidebar:extract-structured-info"));
document
  .getElementById("generate-draft")
  .addEventListener("click", () => runAction("sidebar:generate-draft"));
document
  .getElementById("ask-page")
  .addEventListener("click", askPage);
applyDraftButton.addEventListener("click", applyDraft);
copyDraftButton.addEventListener("click", copyDraft);
copyLogsButton.addEventListener("click", copyLogs);
copyAnswerButton.addEventListener("click", copyAnswer);
startLoginButton.addEventListener("click", startCodexLogin);
logoutAccountButton.addEventListener("click", logoutCodex);
refreshModelsButton.addEventListener("click", refreshCodexModels);
saveModelButton.addEventListener("click", saveSelectedModel);
draftEditor.addEventListener("input", () => {
  pendingDraft = draftEditor.value;
  syncDraftActions();
});

loadContext();
loadSession();
loadProviderStatus();

async function loadContext({ announce = false } = {}) {
  renderPending("正在读取页面上下文...");

  const response = await browser.runtime.sendMessage({
    type: "sidebar:get-page-context",
  });

  if (!response?.ok) {
    renderError(response?.error?.message ?? "上下文读取失败");
    return;
  }

  const context = response.payload?.context ?? {};
  hostStatus.textContent = "可用";
  siteName.textContent = context.site || "-";
  pageTitle.textContent = context.title || "-";
  pageUrl.textContent = context.url || "-";
  pageSelection.textContent = context.selection || "无选中文本";
  focusedInput.textContent = formatFocusedInput(context.focusedInput);
  pageKind.textContent = context.metadata?.pageKind || "-";
  pageRepository.textContent = context.metadata?.repository || "-";
  if (!pendingTargetDescription) {
    draftTarget.textContent = context.focusedInput?.description || "尚未生成草稿";
  }
  answerOutput.textContent = announce ? "页面上下文已刷新。" : "等待操作";
}

async function loadProviderStatus() {
  const response = await sendNativeControlRequest("get_status");

  if (!response?.ok) {
    accountEmail.textContent = "状态读取失败";
    loginStage.textContent = "状态读取失败";
    disableInferenceActions(true);
    return;
  }

  isLoggedIn = response.payload?.authState === "logged_in";
  const loginInProgress = response.payload?.loginInProgress === true;
  accountEmail.textContent = loginInProgress
    ? "登录中…"
    : response.payload?.email || (isLoggedIn ? "已登录" : "未登录");
  bindModelSelect(response.payload?.availableModels ?? [], response.payload?.selectedModel || "gpt-5");
  disableInferenceActions(!isLoggedIn);

  if (loginInProgress) {
    hostStatus.textContent = "登录中";
    loginStage.textContent = "宿主已进入登录流程";
    scheduleLoginPoll();
  } else if (!isLoggedIn) {
    answerOutput.textContent = "请先在宿主 App 中登录 Codex。";
    if (loginStage.textContent === "宿主已进入登录流程") {
      loginStage.textContent = "等待登录完成";
    }
    stopLoginPoll();
  } else {
    hostStatus.textContent = "已连接";
    loginStage.textContent = "登录完成";
    stopLoginPoll();
  }
}

async function startCodexLogin() {
  hostStatus.textContent = "登录中";
  loginStage.textContent = "正在发送登录请求";
  answerOutput.textContent = "正在发送登录请求...";
  const response = await sendNativeControlRequest("start_login");
  if (!response?.ok) {
    loginStage.textContent = "请求失败";
    renderError(response?.error?.message ?? "登录启动失败");
    return;
  }
  loginStage.textContent = response.payload?.loginDispatch || "请求已发送";
  answerOutput.textContent = response.payload?.answer ?? "正在拉起 Codex 登录…";
  scheduleLoginPoll();
}

async function logoutCodex() {
  const response = await sendNativeControlRequest("logout");
  if (!response?.ok) {
    renderError(response?.error?.message ?? "登出失败");
    return;
  }
  pendingDraft = "";
  draftEditor.value = "";
  loadProviderStatus();
  answerOutput.textContent = response.payload?.answer ?? "已登出";
}

async function refreshCodexModels() {
  const response = await sendNativeControlRequest("refresh_models");
  if (!response?.ok) {
    renderError(response?.error?.message ?? "模型刷新失败");
    return;
  }
  bindModelSelect(response.payload?.availableModels ?? [], response.payload?.selectedModel || "gpt-5");
  answerOutput.textContent = response.payload?.answer ?? "模型已刷新";
  loadProviderStatus();
}

async function saveSelectedModel() {
  const response = await sendNativeControlRequest("save_selected_model", {
    selectedModel: modelSelect.value,
  });
  if (!response?.ok) {
    renderError(response?.error?.message ?? "模型保存失败");
    return;
  }
  answerOutput.textContent = response.payload?.answer ?? "模型已保存";
  loadProviderStatus();
}

async function runAction(type) {
  if (!isLoggedIn) {
    renderError("请先在宿主 App 中登录 Codex。");
    return;
  }
  renderPending("正在请求宿主 App...");

  const response = await browser.runtime.sendMessage({ type });
  if (!response?.ok) {
    renderError(response?.error?.message ?? "请求失败");
    return;
  }

  const answer = response.payload?.answer ?? "未返回内容";
  const draft = response.payload?.draft;
  pendingDraft = typeof draft === "string" ? draft : pendingDraft;
  pendingTargetDescription =
    response.payload?.target?.description || pendingTargetDescription || "当前输入框";
  draftEditor.value = pendingDraft;
  draftTarget.textContent = pendingTargetDescription || "尚未生成草稿";
  syncSession(response.payload?.session);
  syncDraftActions();
  answerOutput.textContent = draft ? `${answer}\n\n草稿：${draft}` : answer;
  hostStatus.textContent = "已连接";
}

async function askPage() {
  if (!isLoggedIn) {
    renderError("请先在宿主 App 中登录 Codex。");
    return;
  }
  const prompt = questionEditor.value.trim();
  if (!prompt) {
    renderError("请先输入你的问题。");
    return;
  }

  renderPending("正在基于当前页面回答...");
  const response = await browser.runtime.sendMessage({
    type: "sidebar:ask-page",
    payload: { prompt },
  });

  if (!response?.ok) {
    renderError(response?.error?.message ?? "问答失败");
    return;
  }

  questionEditor.value = "";
  syncSession(response.payload?.session);
  answerOutput.textContent = response.payload?.answer ?? "已收到回答";
  hostStatus.textContent = "已连接";
}

async function applyDraft() {
  if (!pendingDraft) {
    return;
  }

  renderPending("正在写入页面...");
  const response = await browser.runtime.sendMessage({
    type: "sidebar:apply-draft",
    payload: { draft: draftEditor.value },
  });

  if (!response?.ok) {
    renderError(response?.error?.message ?? "写入失败");
    return;
  }

  pendingDraft = "";
  pendingTargetDescription = response.payload?.target?.description || pendingTargetDescription;
  draftTarget.textContent = pendingTargetDescription || "当前输入框";
  draftEditor.value = "";
  syncDraftActions();
  answerOutput.textContent = response.payload?.answer ?? "草稿已写入页面";
  hostStatus.textContent = "已连接";
}

async function copyDraft() {
  const text = draftEditor.value;
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    answerOutput.textContent = "草稿已复制到剪贴板。";
    hostStatus.textContent = "已连接";
  } catch (error) {
    renderError(`复制失败：${error.message}`);
  }
}

async function copyLogs() {
  try {
    const response = await browser.runtime.sendMessage({
      type: "sidebar:get-logs",
    });

    if (!response?.ok) {
      renderError(response?.error?.message ?? "日志读取失败");
      return;
    }

    const content = formatLogs(response.payload?.logs ?? []);
    await navigator.clipboard.writeText(content);
    answerOutput.textContent = "最近日志已复制到剪贴板。";
    hostStatus.textContent = "已连接";
  } catch (error) {
    renderError(`复制日志失败：${error.message}`);
  }
}

async function copyAnswer() {
  const text = answerOutput.textContent.trim();
  if (!text || text === "等待操作") {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    answerOutput.textContent = `${text}\n\n[已复制当前回答]`;
    hostStatus.textContent = "已连接";
  } catch (error) {
    renderError(`复制回答失败：${error.message}`);
  }
}

async function loadSession() {
  const response = await browser.runtime.sendMessage({
    type: "sidebar:get-session",
  });

  if (!response?.ok) {
    return;
  }

  syncSession(response.payload?.messages);
}

function renderPending(message) {
  answerOutput.textContent = message;
}

function renderError(message) {
  hostStatus.textContent = "失败";
  answerOutput.textContent = `错误：${message}`;
}

function syncDraftActions() {
  const enabled = Boolean(pendingDraft);
  applyDraftButton.disabled = !enabled || !isLoggedIn;
  copyDraftButton.disabled = !enabled;
}

function syncSession(messages) {
  if (!Array.isArray(messages)) {
    return;
  }

  sessionMessages = messages;
  conversationStatus.textContent = messages.length ? `${messages.length} 条` : "空";
  conversationList.innerHTML = "";

  if (!messages.length) {
    conversationList.innerHTML = `<div class="conversation-item"><span class="conversation-role">system</span>当前还没有会话记录。</div>`;
    return;
  }

  for (const item of messages) {
    const entry = document.createElement("div");
    entry.className = "conversation-item";
    entry.dataset.role = item.role || "system";
    entry.innerHTML = `
      <span class="conversation-role">${item.role || "system"} / ${item.kind || "message"}</span>
      <div>${escapeHtml(item.text || "")}</div>
    `;
    conversationList.appendChild(entry);
  }
}

function formatLogs(logs) {
  if (!logs.length) {
    return "暂无日志";
  }

  return logs
    .map((log) => JSON.stringify(log, null, 2))
    .join("\n\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatFocusedInput(input) {
  if (!input) {
    return "当前未聚焦可写输入框";
  }

  const label = input.label || input.placeholder || "未命名输入框";
  return `${input.type} / ${label}`;
}

function disableInferenceActions(disabled) {
  document.getElementById("summarize-page").disabled = disabled;
  document.getElementById("explain-selection").disabled = disabled;
  document.getElementById("extract-structured-info").disabled = disabled;
  document.getElementById("generate-draft").disabled = disabled;
  document.getElementById("ask-page").disabled = disabled;
  questionEditor.disabled = disabled;
  draftEditor.disabled = disabled && !pendingDraft;
  syncDraftActions();
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
