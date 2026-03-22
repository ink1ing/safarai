const modelSelect = document.getElementById("model-select");
const modelDisplay = document.getElementById("model-display");
const conversationList = document.getElementById("conversation-list");
const contextURL = document.getElementById("context-url");
const contextSelectionText = document.getElementById("context-selection-text");
const composerDivider = document.getElementById("composer-divider");
const questionEditor = document.getElementById("question-editor");
const askPageButton = document.getElementById("ask-page");
const agentModeButton = document.getElementById("agent-mode-button");
const agentCancelButton = document.getElementById("agent-cancel-button");
const agentApprovalCard = document.getElementById("agent-approval-card");
const agentApprovalPreview = document.getElementById("agent-approval-preview");
const agentApproveButton = document.getElementById("agent-approve-button");
const agentRejectButton = document.getElementById("agent-reject-button");
const agentRunCard = document.getElementById("agent-run-card");
const agentRunTitle = document.getElementById("agent-run-title");
const agentRunStatus = document.getElementById("agent-run-status");
const agentStepList = document.getElementById("agent-step-list");
const attachmentInput = document.getElementById("attachment-input");
const attachmentButton = document.getElementById("attachment-button");
const attachmentList = document.getElementById("attachment-list");
const attachmentDropzone = document.getElementById("attachment-dropzone");
const composerCard = document.querySelector(".composer-card");
const historyButton = document.getElementById("refresh-context-button");
const settingsButton = document.getElementById("settings-button");
const settingsCloseButton = document.getElementById("settings-close-button");
const historyCloseButton = document.getElementById("history-close-button");
const systemPromptEditor = document.getElementById("sd-system-prompt-editor");
const saveSystemPromptButton = document.getElementById("sd-save-system-prompt");
const resetSystemPromptButton = document.getElementById("sd-reset-system-prompt");
const contextPreviewURL = document.getElementById("context-preview-url");
const historyThreadList = document.getElementById("history-thread-list");
const historyActionMenu = document.getElementById("history-action-menu");
const newChatButton = document.getElementById("new-chat-button");
const newChatFooterButton = document.getElementById("new-chat-footer-button");
const languageButtonEN = document.getElementById("sd-language-en");
const languageButtonZH = document.getElementById("sd-language-zh");
let isStreamingResponse = false;
let currentDrawerState = {
  language: "en",
  theme: "blue",
  showPageInfo: true,
  followSafariWindow: true,
  followPageColor: true,
  customSystemPrompt: "",
};
let currentContext = null;
let currentThreadId = "";
let openHistoryMenuThreadId = "";
let openHistoryMenuPinned = false;
let editingHistoryThreadId = "";
let currentHistoryThreads = [];
let pendingAttachments = [];
let dragDepth = 0;
let agentModeEnabled = false;
let systemPromptSavedValue = "";
let systemPromptDirty = false;
let copyFeedbackTimer = null;
let copyFeedbackButton = null;

const I18N = {
  en: {
    settings_title: "Settings",
    provider: "AI Provider",
    codex_account: "Codex Account",
    zed_account: "Zed Account",
    theme: "Theme",
    language: "Language",
    page_color: "Page Color",
    chat_history: "Chat History",
    display: "Display",
    system_prompt: "System Prompt",
    placement: "Window Placement",
    follow_safari: "Follow Safari",
    sign_in: "Sign In",
    sign_out: "Sign Out",
    import_zed: "Import Zed",
    blue: "Blue",
    orange: "Orange",
    gray: "Gray",
    purple: "Purple",
    green: "Green",
    follow_page_color: "Follow Page Colors",
    change_location: "Change Location",
    reset_default: "Reset Default",
    import: "Import",
    export: "Export",
    current_page: "Current Page",
    save: "Save",
    remember: "Remember",
    snap_left: "Snap Left",
    snap_right: "Snap Right",
    follow_safari_button: "Follow Safari",
    history_title: "Chat History",
    explain_page: "Explain Page",
    translate_page: "Translate Page",
    give_suggestions: "Give Suggestions",
    add_image: "Add Image",
    agent_mode: "Agent",
    drop_images: "Drop images here",
    remove_image: "Remove image",
    new_chat: "New Chat",
    default_location: "Default location",
    no_history: "No chat history yet",
    unknown_page: "Unknown page",
    unknown_time: "Unknown time",
    rename: "Rename",
    pin: "Pin",
    unpin: "Unpin",
    delete: "Delete",
    rename_prompt: "Enter a new chat title",
    delete_confirm: "Delete this chat record?",
    aria_close_settings: "Close settings",
    aria_close_history: "Close chat history",
    aria_history: "Chat history",
    aria_settings: "Settings",
    aria_send: "Send",
    aria_stop: "Stop",
    aria_copy_message: "Copy message",
    copied: "Copied",
    system_prompt_placeholder: "Append a custom prompt after the built-in system prompt.",
  },
  zh: {
    settings_title: "设置",
    provider: "AI 提供商",
    codex_account: "Codex 账户",
    zed_account: "Zed 账户",
    theme: "颜色风格",
    language: "语言",
    page_color: "页面颜色",
    chat_history: "聊天记录",
    display: "信息显示",
    system_prompt: "System Prompt",
    placement: "窗口位置",
    follow_safari: "Safari 跟随吸附",
    sign_in: "登录",
    sign_out: "退出",
    import_zed: "导入 Zed",
    blue: "蓝色",
    orange: "橙色",
    gray: "灰色",
    purple: "紫色",
    green: "绿色",
    follow_page_color: "跟随页面颜色",
    change_location: "更改位置",
    reset_default: "恢复默认",
    import: "导入",
    export: "导出",
    current_page: "当前页面",
    save: "保存",
    remember: "记忆位置",
    snap_left: "左吸附",
    snap_right: "右吸附",
    follow_safari_button: "跟随 Safari",
    history_title: "聊天记录",
    explain_page: "解释页面",
    translate_page: "翻译页面",
    give_suggestions: "给出建议",
    add_image: "添加图片",
    agent_mode: "智能体",
    drop_images: "拖放图片到这里",
    remove_image: "移除图片",
    new_chat: "新对话",
    default_location: "默认位置",
    no_history: "暂无聊天记录",
    unknown_page: "未知页面",
    unknown_time: "未知时间",
    rename: "重命名",
    pin: "置顶",
    unpin: "取消置顶",
    delete: "删除",
    rename_prompt: "输入新的聊天记录标题",
    delete_confirm: "确定删除这条聊天记录？",
    aria_close_settings: "收起设置",
    aria_close_history: "收起聊天记录",
    aria_history: "聊天记录",
    aria_settings: "设置",
    aria_send: "发送",
    aria_stop: "终止",
    aria_copy_message: "复制消息",
    copied: "已复制",
    system_prompt_placeholder: "追加到内置 system prompt 后面的自定义提示。",
  },
};

const SEND_ICON = `
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22 11 13 2 9 22 2z" />
  </svg>
`;

const STOP_ICON = `
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="currentColor"
  >
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
`;

const COPY_ICON = `
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="9" y="9" width="10" height="10" rx="2"></rect>
    <path d="M5 15V7a2 2 0 0 1 2-2h8"></path>
  </svg>
`;

const COPIED_ICON = `
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="m5 12 4 4L19 6"></path>
  </svg>
`;

const MAX_ATTACHMENT_COUNT = 6;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

modelSelect.addEventListener("change", () => {
  syncSelectedModelDisplay();
  webkit.messageHandlers.controller.postMessage({
    command: "save-selected-model",
    selectedModel: modelSelect.value,
    reasoningEffort: "medium",
  });
});
conversationList.addEventListener("click", async (event) => {
  const copyButton = event.target.closest?.("[data-copy-message='true']");
  if (!copyButton) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const text = String(copyButton._copyText || "").trim();
  if (!text) {
    return;
  }

  const copied = await copyTextToClipboard(text);
  if (!copied) {
    return;
  }

  showCopyFeedback(copyButton);
});
settingsButton.addEventListener("click", () => {
  closeHistoryDrawer();
  toggleSettingsDrawer();
});
settingsCloseButton.addEventListener("click", () => {
  closeSettingsDrawer();
});
historyButton.addEventListener("click", () => {
  closeSettingsDrawer();
  toggleHistoryDrawer();
});
historyCloseButton.addEventListener("click", () => closeHistoryDrawer());
newChatButton.addEventListener("click", () => {
  closeHistoryDrawer();
  webkit.messageHandlers.controller.postMessage({
    command: "create-thread",
  });
});
newChatFooterButton.addEventListener("click", () => {
  closeHistoryDrawer();
  webkit.messageHandlers.controller.postMessage({
    command: "create-thread",
  });
});
systemPromptEditor.addEventListener("input", () => {
  systemPromptDirty = normalizeSystemPrompt(systemPromptEditor.value) !== systemPromptSavedValue;
  syncSystemPromptButtons();
});
saveSystemPromptButton.addEventListener("click", () => {
  sdPost("save-custom-system-prompt", {
    customSystemPrompt: systemPromptEditor.value,
  });
});
resetSystemPromptButton.addEventListener("click", () => {
  sdPost("reset-custom-system-prompt");
});

for (const pill of document.querySelectorAll(".suggestion-pill[data-prompt]")) {
  pill.addEventListener("click", () => {
    const prompt = pill.dataset.prompt;
    if (prompt) {
      sendQuestion(prompt);
    }
  });
}

askPageButton.addEventListener("click", () => {
  if (isStreamingResponse) {
    stopCurrentResponse();
    return;
  }
  sendQuestion();
});
attachmentButton.addEventListener("click", () => {
  webkit.messageHandlers.controller.postMessage({
    command: "pick-attachments",
  });
});
attachmentInput.addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const files = Array.from(input?.files || []);
  await addAttachmentFiles(files);
  if (input) {
    input.value = "";
  }
});
agentModeButton.addEventListener("click", () => {
  agentModeEnabled = !agentModeEnabled;
  syncAgentModeButton();
  renderAgentPanel(null);
});
agentCancelButton.addEventListener("click", () => {
  webkit.messageHandlers.controller.postMessage({
    command: "cancel-agent",
  });
});
agentApproveButton.addEventListener("click", () => {
  webkit.messageHandlers.controller.postMessage({
    command: "approve-agent-action",
  });
});
agentRejectButton.addEventListener("click", () => {
  webkit.messageHandlers.controller.postMessage({
    command: "reject-agent-action",
  });
});
questionEditor.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (isStreamingResponse) {
      stopCurrentResponse();
      return;
    }
    sendQuestion();
  }
});

document.addEventListener("keydown", (event) => {
  const isCopyShortcut =
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "c";
  if (!isCopyShortcut) {
    return;
  }

  const selection = String(window.getSelection?.()?.toString?.() ?? "");
  if (!selection.trim()) {
    return;
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  composerCard.addEventListener(eventName, (event) => {
    if (!containsFileData(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += eventName === "dragenter" ? 1 : 0;
    setComposerDragState(true);
  });
}

composerCard.addEventListener("dragleave", (event) => {
  if (!containsFileData(event)) {
    return;
  }
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    setComposerDragState(false);
  }
});

composerCard.addEventListener("drop", async (event) => {
  if (!containsFileData(event)) {
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  setComposerDragState(false);
  const files = Array.from(event.dataTransfer?.files || []);
  await addAttachmentFiles(files);
});

function sendQuestion(directPrompt, options = {}) {
  const prompt = (directPrompt || questionEditor.value).trim();
  if (!prompt && pendingAttachments.length === 0) {
    return;
  }

  questionEditor.value = "";
  const attachments = pendingAttachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    dataURL: attachment.dataURL,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
  }));
  pendingAttachments = [];
  renderPendingAttachments();
  const selectedFocus = resolveSelectedFocus(options);
  webkit.messageHandlers.controller.postMessage({
    command: agentModeEnabled ? "start-agent" : "send-question",
    prompt,
    selectedFocus,
    attachments,
  });
}

function stopCurrentResponse() {
  webkit.messageHandlers.controller.postMessage({
    command: "stop-response",
  });
}

async function addAttachmentFiles(files) {
  const imageFiles = files
    .filter((file) => file.type.startsWith("image/"))
    .slice(0, Math.max(0, MAX_ATTACHMENT_COUNT - pendingAttachments.length));
  if (!imageFiles.length) {
    return;
  }

  const nextAttachments = [];
  for (const file of imageFiles) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      continue;
    }
    const attachment = await readImageAttachment(file);
    if (attachment) {
      nextAttachments.push(attachment);
    }
  }

  if (!nextAttachments.length) {
    return;
  }

  pendingAttachments = [...pendingAttachments, ...nextAttachments].slice(0, MAX_ATTACHMENT_COUNT);
  renderPendingAttachments();
}

function appendPickedAttachments(attachments) {
  const rawAttachments = Array.isArray(attachments)
    ? attachments
    : Array.isArray(attachments?.attachments)
      ? attachments.attachments
      : [];
  const normalizedAttachments = rawAttachments
        .filter((attachment) => attachment?.kind === "image" && attachment?.dataURL)
        .map((attachment) => ({
          id: String(attachment.id || `att_${Date.now()}_${Math.random().toString(16).slice(2)}`),
          kind: "image",
          filename: String(attachment.filename || "image"),
          mimeType: String(attachment.mimeType || "image/png"),
          dataURL: String(attachment.dataURL || ""),
          width: Number.isFinite(Number(attachment.width)) ? Number(attachment.width) : null,
          height: Number.isFinite(Number(attachment.height)) ? Number(attachment.height) : null,
          sizeBytes: estimateDataURLBytes(String(attachment.dataURL || "")),
        }));

  if (!normalizedAttachments.length) {
    return;
  }

  pendingAttachments = [...pendingAttachments, ...normalizedAttachments].slice(0, MAX_ATTACHMENT_COUNT);
  renderPendingAttachments();
}

async function readImageAttachment(file) {
  try {
    const dataURL = await readFileAsDataURL(file);
    const size = await readImageSize(dataURL);
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : `att_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      kind: "image",
      filename: file.name || "image",
      mimeType: file.type || "image/png",
      dataURL,
      width: size?.width || null,
      height: size?.height || null,
      sizeBytes: file.size || 0,
    };
  } catch {
    return null;
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function readImageSize(dataURL) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = dataURL;
  });
}

function renderPendingAttachments() {
  attachmentList.innerHTML = "";
  attachmentList.classList.toggle("is-hidden", pendingAttachments.length === 0);

  for (const attachment of pendingAttachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.innerHTML = `
      <button type="button" class="attachment-chip-remove" data-remove-attachment="${escapeHtml(attachment.id)}" aria-label="${escapeAttribute(t("remove_image"))}">×</button>
      <img src="${escapeAttribute(attachment.dataURL)}" alt="${escapeAttribute(attachment.filename)}" />
      <div class="attachment-chip-meta">
        <span class="attachment-chip-name">${escapeHtml(attachment.filename)}</span>
        <span class="attachment-chip-size">${formatAttachmentSize(attachment.sizeBytes)}</span>
      </div>
    `;
    attachmentList.appendChild(chip);
  }
}

attachmentList.addEventListener("click", (event) => {
  const removeButton = event.target.closest?.("[data-remove-attachment]");
  if (!removeButton) {
    return;
  }
  const attachmentId = removeButton.dataset.removeAttachment || "";
  pendingAttachments = pendingAttachments.filter((attachment) => attachment.id !== attachmentId);
  renderPendingAttachments();
});

function setComposerDragState(isActive) {
  composerCard.dataset.dragActive = isActive ? "true" : "false";
  attachmentDropzone.classList.toggle("is-hidden", !isActive);
}

function containsFileData(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes("Files");
}

function formatAttachmentSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}

function estimateDataURLBytes(dataURL) {
  const commaIndex = dataURL.indexOf(",");
  if (commaIndex === -1) {
    return 0;
  }
  const base64 = dataURL.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

// MARK: - Settings Drawer

const settingsDrawer = document.getElementById("settings-drawer");
const historyDrawer = document.getElementById("history-drawer");

function toggleSettingsDrawer() {
  const isOpen = settingsDrawer.classList.contains("open");
  if (isOpen) {
    closeSettingsDrawer();
  } else {
    openSettingsDrawer();
  }
}

function openSettingsDrawer() {
  closeHistoryDrawer();
  settingsDrawer.classList.add("open");
  settingsDrawer.setAttribute("aria-hidden", "false");
  settingsButton.dataset.active = "true";
  settingsButton.setAttribute("aria-expanded", "true");
}

function closeSettingsDrawer() {
  settingsDrawer.classList.remove("open");
  settingsDrawer.setAttribute("aria-hidden", "true");
  settingsButton.dataset.active = "false";
  settingsButton.setAttribute("aria-expanded", "false");
}

function toggleHistoryDrawer() {
  const isOpen = historyDrawer.classList.contains("open");
  if (isOpen) {
    closeHistoryDrawer();
  } else {
    openHistoryDrawer();
  }
}

function openHistoryDrawer() {
  closeSettingsDrawer();
  historyDrawer.classList.add("open");
  historyDrawer.setAttribute("aria-hidden", "false");
  historyButton.dataset.active = "true";
}

function closeHistoryDrawer() {
  historyDrawer.classList.remove("open");
  historyDrawer.setAttribute("aria-hidden", "true");
  historyButton.dataset.active = "false";
}

// Close drawer when clicking outside of it
document.addEventListener("click", (e) => {
  const clickPath = typeof e.composedPath === "function" ? e.composedPath() : [];
  const clickedInsideSettings =
    clickPath.includes(settingsDrawer) || clickPath.includes(settingsButton);
  const clickedInsideHistory =
    clickPath.includes(historyDrawer) || clickPath.includes(historyButton);

  if (
    settingsDrawer.classList.contains("open") &&
    !clickedInsideSettings
  ) {
    closeSettingsDrawer();
  }
  if (
    historyDrawer.classList.contains("open") &&
    !clickedInsideHistory
  ) {
    closeHistoryDrawer();
  }
  if (!e.target.closest?.(".history-action-menu") && !e.target.closest?.(".history-thread-menu-button")) {
    closeHistoryActionMenu();
  }
});

function sdPost(command, extra) {
  webkit.messageHandlers.controller.postMessage(
    Object.assign({ command }, extra || {}),
  );
}

function sdSwitchProvider(provider) {
  sdPost("switch-provider", { provider });
}

function sdSavePlacementMode(mode) {
  sdPost("save-placement-mode-settings", { placementMode: mode });
}

function sdSaveTheme(theme) {
  sdPost("save-theme-settings", { theme });
}

function sdSaveLanguage(language) {
  sdPost("save-language-settings", { language });
}

function sdTogglePageInfo() {
  sdPost("save-panel-visibility-settings", {
    showPageInfo: !currentDrawerState.showPageInfo,
  });
}

function sdToggleFollowSafariWindow() {
  sdPost("save-follow-safari-window-settings", {
    followSafariWindow: !currentDrawerState.followSafariWindow,
  });
}

function sdToggleFollowPageColor() {
  sdPost("save-follow-page-color-settings", {
    followPageColor: !currentDrawerState.followPageColor,
  });
}

function sdChangeHistoryStorage() {
  sdPost("change-history-storage-location");
}

function sdResetHistoryStorage() {
  sdPost("reset-history-storage-location");
}

function sdImportHistory() {
  sdPost("import-history-library");
}

function sdExportHistory() {
  sdPost("export-history-library");
}

document
  .getElementById("sd-login-codex")
  .addEventListener("click", () => sdPost("start-codex-login"));
document
  .getElementById("sd-logout-codex")
  .addEventListener("click", () => sdPost("logout-codex"));
document
  .getElementById("sd-import-zed")
  .addEventListener("click", () => sdPost("login-zed"));
document
  .getElementById("sd-logout-zed")
  .addEventListener("click", () => sdPost("logout-zed"));
document
  .getElementById("sd-placement-remember")
  .addEventListener("click", () => sdSavePlacementMode("remember"));
document
  .getElementById("sd-placement-left")
  .addEventListener("click", () => sdSavePlacementMode("left"));
document
  .getElementById("sd-placement-right")
  .addEventListener("click", () => sdSavePlacementMode("right"));
document
  .getElementById("sd-theme-blue")
  .addEventListener("click", () => sdSaveTheme("blue"));
document
  .getElementById("sd-theme-orange")
  .addEventListener("click", () => sdSaveTheme("orange"));
document
  .getElementById("sd-theme-gray")
  .addEventListener("click", () => sdSaveTheme("gray"));
document
  .getElementById("sd-theme-purple")
  .addEventListener("click", () => sdSaveTheme("purple"));
document
  .getElementById("sd-theme-green")
  .addEventListener("click", () => sdSaveTheme("green"));
languageButtonEN.addEventListener("click", () => sdSaveLanguage("en"));
languageButtonZH.addEventListener("click", () => sdSaveLanguage("zh"));
document
  .getElementById("sd-toggle-page-info")
  .addEventListener("click", () => sdTogglePageInfo());
document
  .getElementById("sd-follow-safari-window")
  .addEventListener("click", () => sdToggleFollowSafariWindow());
document
  .getElementById("sd-follow-page-color")
  .addEventListener("click", () => sdToggleFollowPageColor());
document
  .getElementById("sd-change-history-storage")
  .addEventListener("click", () => sdChangeHistoryStorage());
document
  .getElementById("sd-reset-history-storage")
  .addEventListener("click", () => sdResetHistoryStorage());
document
  .getElementById("sd-import-history")
  .addEventListener("click", () => sdImportHistory());
document
  .getElementById("sd-export-history")
  .addEventListener("click", () => sdExportHistory());

syncSystemPromptButtons();

/**
 * Called by Swift (via renderPanelState) to sync drawer UI state.
 * payload fields: codexEmail, codexLoggedIn, zedName, zedLoggedIn,
 *                 activeProvider, placementMode, settingsStatus
 */
function renderSettingsDrawerState(payload) {
  const el = (id) => document.getElementById(id);
  currentDrawerState = {
    language: payload.language || "en",
    theme: payload.theme || "blue",
    showPageInfo: payload.showPageInfo !== false,
    followSafariWindow: payload.followSafariWindow !== false,
    followPageColor: payload.followPageColor !== false,
    historyStoragePath: payload.historyStoragePath || "",
    historyStorageStatus: payload.historyStorageStatus || "",
    historyStorageUsesDefault: payload.historyStorageUsesDefault !== false,
    customSystemPrompt: payload.customSystemPrompt || "",
  };
  el("sd-codex-email").textContent = payload.codexEmail || "未登录";
  el("sd-login-codex").disabled = !!payload.codexLoggedIn;
  el("sd-logout-codex").disabled = !payload.codexLoggedIn;

  el("sd-zed-name").textContent = payload.zedName || "未登录";
  el("sd-import-zed").disabled = false;
  el("sd-logout-zed").disabled = !payload.zedLoggedIn;

  el("sd-provider-codex").dataset.active =
    payload.codexLoggedIn ? "true" : "false";
  el("sd-provider-zed").dataset.active =
    payload.zedLoggedIn ? "true" : "false";
  el("sd-provider-codex").dataset.selected =
    payload.activeProvider === "codex" ? "true" : "false";
  el("sd-provider-zed").dataset.selected =
    payload.activeProvider === "zed" ? "true" : "false";

  el("sd-placement-remember").dataset.active =
    payload.placementMode === "remember" ? "true" : "false";
  el("sd-placement-left").dataset.active =
    payload.placementMode === "left" ? "true" : "false";
  el("sd-placement-right").dataset.active =
    payload.placementMode === "right" ? "true" : "false";

  for (const theme of ["blue", "orange", "gray", "purple", "green"]) {
    el(`sd-theme-${theme}`).dataset.active =
      currentDrawerState.theme === theme ? "true" : "false";
  }
  languageButtonEN.dataset.active = currentDrawerState.language === "en" ? "true" : "false";
  languageButtonZH.dataset.active = currentDrawerState.language === "zh" ? "true" : "false";
  el("sd-toggle-page-info").dataset.active =
    currentDrawerState.showPageInfo ? "true" : "false";
  el("sd-follow-safari-window").dataset.active =
    currentDrawerState.followSafariWindow ? "true" : "false";
  el("sd-follow-page-color").dataset.active =
    currentDrawerState.followPageColor ? "true" : "false";
  el("sd-history-storage-path").textContent =
    currentDrawerState.historyStoragePath || "默认位置";
  el("sd-history-storage-status").textContent =
    currentDrawerState.historyStorageStatus || "默认位置";
  el("sd-reset-history-storage").disabled =
    currentDrawerState.historyStorageUsesDefault === true;

  el("sd-status").textContent =
    payload.settingsStatus && payload.settingsStatus !== "Ready"
      ? payload.settingsStatus
      : "";

  applyTheme(currentDrawerState.theme);
  applyTranslations();
  syncSystemPromptEditor(currentDrawerState.customSystemPrompt);
}

// MARK: - Streaming state
let _streamingEntry = null; // the .conversation-item div being streamed into
let _streamingText = ""; // accumulated raw text for the current stream

/**
 * Called by Swift before the first chunk arrives.
 * Creates an empty assistant bubble and scrolls to it.
 */
function beginStreamMessage() {
  _streamingText = "";

  const entry = document.createElement("div");
  entry.className = "conversation-item";
  entry.dataset.role = "assistant";
  entry.dataset.streaming = "true";

  const inner = document.createElement("div");
  inner.className = "message-markdown message-streaming";
  inner.textContent = "";
  entry.appendChild(inner);

  conversationList.appendChild(entry);
  _streamingEntry = entry;
  entry.scrollIntoView({ block: "end", behavior: "smooth" });
}

/**
 * Called by Swift for each text chunk.
 * Appends raw text to the bubble as plain text (fast, no markdown parse per chunk).
 */
function appendStreamChunk(chunk) {
  if (!_streamingEntry) return;
  _streamingText += chunk;
  const inner = _streamingEntry.querySelector(".message-markdown");
  if (inner) {
    // Show raw text while streaming; markdown is rendered on finalize
    inner.textContent = _streamingText;
    _streamingEntry.scrollIntoView({ block: "end", behavior: "smooth" });
  }
}

/**
 * Called by Swift when the stream ends.
 * Re-renders the bubble with full markdown and removes the streaming indicator.
 */
function finalizeStreamMessage() {
  if (!_streamingEntry) return;
  const inner = _streamingEntry.querySelector(".message-markdown");
  if (inner) {
    inner.innerHTML = renderMarkdown(_streamingText);
    inner.classList.remove("message-streaming");
  }
  _streamingEntry.dataset.streaming = "false";
  _streamingEntry = null;
  _streamingText = "";
}

function renderPanelState(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const settings = payload?.settings || {};
  const status = payload?.status || null;
  const context = payload?.context || null;
  const historyThreads = Array.isArray(payload?.historyThreads)
    ? payload.historyThreads
    : [];
  const agent = payload?.agent && typeof payload.agent === "object" ? payload.agent : null;
  currentHistoryThreads = historyThreads;
  currentContext = context;
  currentThreadId = String(payload?.currentThreadId || "");
  isStreamingResponse = !!payload?.isStreaming;

  if (settings.drawerState) {
    renderSettingsDrawerState(settings.drawerState);
  } else {
    applyTranslations();
  }

  questionEditor.disabled = !settings.isLoggedIn || isStreamingResponse;
  askPageButton.disabled = !settings.isLoggedIn;
  attachmentButton.disabled = !settings.isLoggedIn || isStreamingResponse;
  attachmentInput.disabled = !settings.isLoggedIn || isStreamingResponse;
  historyButton.disabled = false;
  settingsButton.disabled = false;
  syncAskButton();

  bindModels(
    settings.availableModels || [],
    settings.selectedModel || "gpt-5.4-mini",
  );
  // Don't clobber a live stream with a full re-render
  if (!_streamingEntry) {
    renderMessages(messages, agent);
  }
  contextURL.textContent = context?.url || "";
  contextPreviewURL.textContent = context?.url || "";
  const currentSelectionText = getCurrentSelectionText();
  contextSelectionText.textContent = currentSelectionText
    ? `"${currentSelectionText}"`
    : "";
  contextSelectionText.classList.toggle("is-hidden", !currentSelectionText);
  applyVisibility(settings);
  renderHistoryThreadList(historyThreads, currentThreadId);
  renderAgentState(agent);
  applyPageVisualState(context?.metadata || {});
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || "blue";
}

function applyPageVisualState(metadata) {
  if (!currentDrawerState.followPageColor) {
    clearPageVisualState();
    return;
  }

  const backgroundColor = normalizeVisualValue(metadata?.pageBackgroundColor);
  const backgroundImage = normalizeVisualValue(metadata?.pageBackgroundImage);
  const schemeHint = normalizeAppearance(metadata?.pageColorScheme);
  const appearance =
    schemeHint || (backgroundColor ? inferAppearanceFromColor(backgroundColor) : "");

  if (appearance) {
    document.documentElement.dataset.pageAppearance = appearance;
    document.documentElement.style.colorScheme = appearance;
  } else {
    delete document.documentElement.dataset.pageAppearance;
    document.documentElement.style.removeProperty("color-scheme");
  }

  if (backgroundColor) {
    applySurfacePalette(backgroundColor, appearance || "dark");
    document.documentElement.style.setProperty(
      "--page-background-color",
      backgroundColor,
    );
  } else {
    clearSurfacePalette();
    document.documentElement.style.removeProperty("--page-background-color");
  }

  if (backgroundImage) {
    document.documentElement.style.setProperty(
      "--page-background-image",
      backgroundImage === "none" ? "none" : backgroundImage,
    );
  } else {
    document.documentElement.style.removeProperty("--page-background-image");
  }
}

function clearPageVisualState() {
  delete document.documentElement.dataset.pageAppearance;
  document.documentElement.style.removeProperty("color-scheme");
  clearSurfacePalette();
  document.documentElement.style.removeProperty("--page-background-color");
  document.documentElement.style.removeProperty("--page-background-image");
}

function applySurfacePalette(backgroundColor, appearance) {
  const channels = parseColorChannels(backgroundColor);
  if (!channels) {
    return;
  }

  if (appearance === "light") {
    const lowered = shiftColor(channels, -14);
    const loweredStrong = shiftColor(channels, -24);
    const raised = shiftColor(channels, 6);
    document.documentElement.style.setProperty("--surface", rgbaString(raised, 0.78));
    document.documentElement.style.setProperty("--surface-low", rgbaString(raised, 0.84));
    document.documentElement.style.setProperty("--surface-high", rgbaString(lowered, 0.9));
    document.documentElement.style.setProperty("--surface-soft", rgbaString(raised, 0.82));
    document.documentElement.style.setProperty("--outline", "rgba(15, 23, 42, 0.12)");
    document.documentElement.style.setProperty(
      "--assistant-bubble-background",
      `linear-gradient(135deg, ${rgbaString(raised, 0.94)} 0%, ${rgbaString(loweredStrong, 0.92)} 100%)`,
    );
    return;
  }

  const raisedSoft = shiftColor(channels, 10);
  const raised = shiftColor(channels, 18);
  const raisedStrong = shiftColor(channels, 26);
  document.documentElement.style.setProperty("--surface", rgbaString(channels, 0.88));
  document.documentElement.style.setProperty("--surface-low", rgbaString(raisedSoft, 0.86));
  document.documentElement.style.setProperty("--surface-high", rgbaString(raisedStrong, 0.92));
  document.documentElement.style.setProperty("--surface-soft", rgbaString(raised, 0.84));
  document.documentElement.style.setProperty("--outline", "rgba(255, 255, 255, 0.1)");
  document.documentElement.style.setProperty(
    "--assistant-bubble-background",
    `linear-gradient(135deg, ${rgbaString(raisedSoft, 0.94)} 0%, ${rgbaString(raisedStrong, 0.9)} 100%)`,
  );
}

function clearSurfacePalette() {
  document.documentElement.style.removeProperty("--surface");
  document.documentElement.style.removeProperty("--surface-low");
  document.documentElement.style.removeProperty("--surface-high");
  document.documentElement.style.removeProperty("--surface-soft");
  document.documentElement.style.removeProperty("--outline");
  document.documentElement.style.removeProperty("--assistant-bubble-background");
}

function applyVisibility(settings) {
  const showPageInfo = settings.showPageInfo !== false;

  contextURL.classList.toggle("is-hidden", !showPageInfo);
  composerDivider.classList.toggle("is-hidden", !showPageInfo);
}

function syncAskButton() {
  askPageButton.dataset.mode = isStreamingResponse ? "stop" : "send";
  askPageButton.classList.toggle("icon-button-danger", isStreamingResponse);
  askPageButton.classList.toggle("icon-button-primary", !isStreamingResponse);
  askPageButton.setAttribute("aria-label", isStreamingResponse ? t("aria_stop") : t("aria_send"));
  askPageButton.setAttribute("title", isStreamingResponse ? t("aria_stop") : t("aria_send"));
  askPageButton.innerHTML = isStreamingResponse ? STOP_ICON : SEND_ICON;
}

function getCurrentSelectionText() {
  return String(
    currentContext?.selectionFocusText || currentContext?.selection || "",
  ).trim();
}

function resolveSelectedFocus(options = {}) {
  if (typeof options.selectedFocus === "string") {
    return options.selectedFocus;
  }
  return getCurrentSelectionText();
}

function syncSystemPromptEditor(value) {
  const normalizedValue = normalizeSystemPrompt(value);
  if (!systemPromptDirty || normalizedValue !== systemPromptSavedValue) {
    systemPromptSavedValue = normalizedValue;
    systemPromptEditor.value = value || "";
    systemPromptDirty = false;
  }
  syncSystemPromptButtons();
}

function syncSystemPromptButtons() {
  saveSystemPromptButton.disabled = !systemPromptDirty;
  resetSystemPromptButton.disabled =
    !systemPromptDirty && systemPromptSavedValue.length === 0;
}

function normalizeSystemPrompt(value) {
  return String(value || "").trim().slice(0, 4000);
}

function currentLanguage() {
  return currentDrawerState.language === "zh" ? "zh" : "en";
}

function t(key) {
  const language = currentLanguage();
  return I18N[language][key] || I18N.en[key] || key;
}

function applyTranslations() {
  document.documentElement.lang = currentLanguage() === "zh" ? "zh-CN" : "en";
  document.getElementById("settings-header-title").textContent = t("settings_title");
  document.getElementById("settings-label-provider").textContent = t("provider");
  document.getElementById("settings-label-codex").textContent = t("codex_account");
  document.getElementById("settings-label-zed").textContent = t("zed_account");
  document.getElementById("settings-label-theme").textContent = t("theme");
  document.getElementById("settings-label-language").textContent = t("language");
  document.getElementById("settings-label-page-color").textContent = t("page_color");
  document.getElementById("settings-label-history").textContent = t("chat_history");
  document.getElementById("settings-label-display").textContent = t("display");
  document.getElementById("settings-label-system-prompt").textContent = t("system_prompt");
  document.getElementById("settings-label-placement").textContent = t("placement");
  document.getElementById("settings-label-follow-safari").textContent = t("follow_safari");
  document.getElementById("history-header-title").textContent = t("history_title");

  document.getElementById("sd-login-codex").textContent = t("sign_in");
  document.getElementById("sd-logout-codex").textContent = t("sign_out");
  document.getElementById("sd-import-zed").textContent = t("import_zed");
  document.getElementById("sd-logout-zed").textContent = t("sign_out");
  document.getElementById("sd-theme-blue").textContent = t("blue");
  document.getElementById("sd-theme-orange").textContent = t("orange");
  document.getElementById("sd-theme-gray").textContent = t("gray");
  document.getElementById("sd-theme-purple").textContent = t("purple");
  document.getElementById("sd-theme-green").textContent = t("green");
  document.getElementById("sd-follow-page-color").textContent = t("follow_page_color");
  document.getElementById("sd-change-history-storage").textContent = t("change_location");
  document.getElementById("sd-reset-history-storage").textContent = t("reset_default");
  document.getElementById("sd-import-history").textContent = t("import");
  document.getElementById("sd-export-history").textContent = t("export");
  document.getElementById("sd-toggle-page-info").textContent = t("current_page");
  document.getElementById("sd-save-system-prompt").textContent = t("save");
  document.getElementById("sd-reset-system-prompt").textContent = t("reset_default");
  document.getElementById("sd-placement-remember").textContent = t("remember");
  document.getElementById("sd-placement-left").textContent = t("snap_left");
  document.getElementById("sd-placement-right").textContent = t("snap_right");
  document.getElementById("sd-follow-safari-window").textContent = t("follow_safari_button");
  document.getElementById("sd-history-storage-path").textContent =
    currentDrawerState.historyStoragePath || t("default_location");
  document.getElementById("sd-history-storage-status").textContent =
    currentDrawerState.historyStorageStatus || t("default_location");
  systemPromptEditor.placeholder = t("system_prompt_placeholder");
  settingsCloseButton.setAttribute("aria-label", t("aria_close_settings"));
  historyCloseButton.setAttribute("aria-label", t("aria_close_history"));
  historyButton.setAttribute("aria-label", t("aria_history"));
  settingsButton.setAttribute("aria-label", t("aria_settings"));
  attachmentButton.setAttribute("aria-label", t("add_image"));
  agentModeButton.setAttribute("aria-label", t("agent_mode"));
  historyButton.setAttribute("title", t("aria_history"));
  settingsButton.setAttribute("title", t("aria_settings"));
  attachmentButton.setAttribute("title", t("add_image"));
  agentModeButton.setAttribute("title", t("agent_mode"));
  attachmentDropzone.textContent = t("drop_images");
  renderPendingAttachments();
  agentCancelButton.textContent = currentLanguage() === "zh" ? "取消" : "Cancel";
  agentApproveButton.textContent = currentLanguage() === "zh" ? "确认" : "Approve";
  agentRejectButton.textContent = currentLanguage() === "zh" ? "拒绝" : "Reject";

  const newChatLabel = newChatButton.querySelector("span:last-child");
  if (newChatLabel) {
    newChatLabel.textContent = t("new_chat");
  }
  newChatFooterButton.setAttribute("aria-label", t("new_chat"));
  newChatFooterButton.setAttribute("title", t("new_chat"));

  const suggestionButtons = document.querySelectorAll(".suggestion-pill[data-prompt]");
  if (suggestionButtons[0]) {
    suggestionButtons[0].textContent = t("explain_page");
    suggestionButtons[0].dataset.prompt =
      currentLanguage() === "zh" ? "解释当前页面" : "Explain the current page";
  }
  if (suggestionButtons[1]) {
    suggestionButtons[1].textContent = t("translate_page");
    suggestionButtons[1].dataset.prompt =
      currentLanguage() === "zh" ? "翻译当前页面为中文" : "Translate the current page";
  }
  if (suggestionButtons[2]) {
    suggestionButtons[2].textContent = t("give_suggestions");
    suggestionButtons[2].dataset.prompt =
      currentLanguage() === "zh" ? "针对当前页面给出建议" : "Give suggestions for the current page";
  }
}

function syncAgentModeButton() {
  agentModeButton.dataset.active = agentModeEnabled ? "true" : "false";
}

function renderAgentState(agent) {
  const agentStatus = agent?.status || "";
  syncAgentModeButton();

  const pendingApproval = agent?.pendingApproval;
  agentApprovalCard.classList.toggle("is-hidden", !pendingApproval);
  if (pendingApproval) {
    agentApprovalPreview.textContent = String(pendingApproval.previewText || pendingApproval.toolName || "");
  }
  agentCancelButton.classList.toggle("is-hidden", !(agentStatus === "planning" || agentStatus === "executing" || agentStatus === "awaiting_approval" || agentStatus === "running_script"));
  agentRunCard.classList.add("is-hidden");
  agentRunStatus.textContent = "";
  agentStepList.innerHTML = "";
}

function formatAgentStatus(status, error) {
  if (error) {
    return currentLanguage() === "zh" ? "失败" : "Failed";
  }

  switch (status) {
    case "planning":
      return currentLanguage() === "zh" ? "规划中" : "Planning";
    case "executing":
      return currentLanguage() === "zh" ? "执行中" : "Running";
    case "running_script":
      return currentLanguage() === "zh" ? "脚本中" : "Script";
    case "done":
      return currentLanguage() === "zh" ? "已完成" : "Done";
    case "failed":
      return currentLanguage() === "zh" ? "失败" : "Failed";
    case "canceled":
      return currentLanguage() === "zh" ? "已取消" : "Canceled";
    default:
      return status || "";
  }
}

function renderAgentSteps(steps, agent) {
  agentStepList.innerHTML = "";

  const recentSteps = steps.slice(-8);
  for (const step of recentSteps) {
    const item = document.createElement("div");
    item.className = "agent-step-item";
    item.dataset.status = String(step?.status || "");
    const metaParts = [];
    if (step?.toolName) {
      metaParts.push(step.toolName);
    }
    if (Number.isFinite(Number(step?.tabId))) {
      metaParts.push(`tab ${step.tabId}`);
    }
    if (Number.isFinite(Number(step?.durationMs))) {
      metaParts.push(`${step.durationMs}ms`);
    }

    const preview = [step?.stdoutPreview, step?.stderrPreview]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n");

    item.innerHTML = `
      <div class="agent-step-top">
        <div class="agent-step-title">${escapeHtml(step?.title || step?.toolName || "step")}</div>
        <div class="agent-step-meta">${escapeHtml(metaParts.join(" · "))}</div>
      </div>
      <div class="agent-step-detail">${escapeHtml(step?.detail || "")}</div>
      ${preview ? `<div class="agent-step-preview">${escapeHtml(preview)}</div>` : ""}
    `;
    agentStepList.appendChild(item);
  }

  if (agent?.error) {
    const errorItem = document.createElement("div");
    errorItem.className = "agent-step-item";
    errorItem.dataset.status = "failed";
    errorItem.innerHTML = `
      <div class="agent-step-top">
        <div class="agent-step-title">${currentLanguage() === "zh" ? "错误" : "Error"}</div>
      </div>
      <div class="agent-step-detail">${escapeHtml(String(agent.error || ""))}</div>
    `;
    agentStepList.appendChild(errorItem);
  }
}

function normalizeVisualValue(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized !== "null" && normalized !== "undefined"
    ? normalized
    : "";
}

function normalizeAppearance(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "light" || normalized === "dark") {
    return normalized;
  }
  return "";
}

function inferAppearanceFromColor(value) {
  const channels = parseColorChannels(value);
  if (!channels) {
    return "dark";
  }

  const luminance =
    (0.2126 * channels.red + 0.7152 * channels.green + 0.0722 * channels.blue) /
    255;
  return luminance >= 0.6 ? "light" : "dark";
}

function parseColorChannels(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const rgbMatch = normalized.match(
    /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[/,]\s*([0-9.]+))?\s*\)$/,
  );

  if (rgbMatch) {
    return {
      red: Number.parseFloat(rgbMatch[1]),
      green: Number.parseFloat(rgbMatch[2]),
      blue: Number.parseFloat(rgbMatch[3]),
    };
  }

  const hexMatch = normalized.match(/^#([0-9a-f]{6})$/i);
  if (!hexMatch) {
    return null;
  }

  const hex = hexMatch[1];
  return {
    red: Number.parseInt(hex.slice(0, 2), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    blue: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function shiftColor(channels, amount) {
  return {
    red: clampColor(channels.red + amount),
    green: clampColor(channels.green + amount),
    blue: clampColor(channels.blue + amount),
  };
}

function clampColor(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbaString(channels, alpha) {
  return `rgba(${channels.red}, ${channels.green}, ${channels.blue}, ${alpha})`;
}

function bindModels(models, selectedModel) {
  modelSelect.innerHTML = "";
  const safeModels =
    Array.isArray(models) && models.length
      ? models
      : [{ id: "gpt-5.4-mini", label: "gpt-5.4-mini", displayLabel: "gpt-5.4-mini" }];
  for (const model of safeModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label || model.id;
    option.dataset.displayLabel = model.displayLabel || model.label || model.id;
    modelSelect.appendChild(option);
  }
  modelSelect.value = selectedModel;
  if (modelSelect.value !== selectedModel && modelSelect.options.length > 0) {
    modelSelect.selectedIndex = 0;
  }
  syncSelectedModelDisplay();
}

function syncSelectedModelDisplay() {
  const selectedOption = modelSelect.options[modelSelect.selectedIndex];
  modelDisplay.textContent =
    selectedOption?.dataset.displayLabel || selectedOption?.textContent || "选择模型";
}

function renderMessages(messages, agent = null) {
  conversationList.innerHTML = "";
  const mergedMessages = [...messages, ...buildAgentTimelineMessages(agent)];

  if (!mergedMessages.length) {
    return;
  }

  for (const item of mergedMessages) {
    const role = item.role || "system";
    const entry = document.createElement("div");
    entry.className = "conversation-item";
    entry.dataset.role = role;

    const cssClass =
      role === "error"
        ? "message-error"
        : role === "assistant"
          ? "message-markdown"
          : "message-plain";
    const content = renderConversationMessageContent(item, role);
    entry.innerHTML = `<div class="${cssClass}">${content}</div>`;
    if (role === "assistant") {
      attachCopyButton(entry, item.text || "");
    }
    conversationList.appendChild(entry);
  }
}

function buildAgentTimelineMessages(agent) {
  if (!agent || typeof agent !== "object") {
    return [];
  }

  const result = [];
  const steps = Array.isArray(agent.steps) ? agent.steps : [];
  for (const step of steps) {
    const kind = String(step?.kind || "");
    if (!["plan", "context", "tool_call", "tool_result", "script_result"].includes(kind)) {
      continue;
    }

    const title = String(step?.title || step?.toolName || "Agent");
    const detail = String(step?.detail || "").trim();
    const metaParts = [];
    if (step?.toolName && step.toolName !== title) {
      metaParts.push(String(step.toolName));
    }
    if (Number.isFinite(Number(step?.tabId))) {
      metaParts.push(`tab ${step.tabId}`);
    }
    if (Number.isFinite(Number(step?.durationMs))) {
      metaParts.push(`${step.durationMs}ms`);
    }
    const preview = [step?.stdoutPreview, step?.stderrPreview]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n");

    const lines = [
      `**${escapeMarkdown(title)}**`,
      metaParts.length ? metaParts.join(" · ") : "",
      detail,
      preview,
    ].filter(Boolean);

    result.push({
      role: step?.status === "failed" ? "error" : "assistant",
      kind: "agent_timeline",
      text: lines.join("\n\n"),
    });
  }

  if (agent?.error) {
    result.push({
      role: "error",
      kind: "agent_error",
      text: String(agent.error),
    });
  }

  return result;
}

function renderConversationMessageContent(item, role) {
  const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
  const attachmentMarkup = attachments.length ? renderMessageAttachments(attachments) : "";
  const textMarkup =
    role === "assistant"
      ? `<div class="message-copy">${renderMarkdown(item.text || "")}</div>`
      : `<div class="message-copy">${renderPlainText(item.text || "")}</div>`;
  return `${attachmentMarkup}${textMarkup}`;
}

function renderMessageAttachments(attachments) {
  const images = attachments
    .filter((attachment) => attachment?.kind === "image" && attachment?.dataURL)
    .map((attachment) => `
      <img
        class="message-attachment-image"
        src="${escapeAttribute(attachment.dataURL)}"
        alt="${escapeAttribute(attachment.filename || "attachment")}"
      />
    `)
    .join("");
  return images ? `<div class="message-attachments">${images}</div>` : "";
}

function attachCopyButton(entry, text) {
  const messageNode = entry.querySelector(".message-markdown, .message-plain");
  if (!messageNode) {
    return;
  }

  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.innerHTML = `
    <button
      class="message-copy-button"
      type="button"
      data-copy-message="true"
      aria-label="${escapeAttribute(t("aria_copy_message"))}"
      title="${escapeAttribute(t("aria_copy_message"))}"
    >
      ${COPY_ICON}
    </button>
  `;

  const copyButton = actions.querySelector("[data-copy-message='true']");
  if (copyButton) {
    copyButton._copyText = text;
  }

  messageNode.appendChild(actions);
}

async function copyTextToClipboard(text) {
  if (webkit?.messageHandlers?.controller) {
    try {
      webkit.messageHandlers.controller.postMessage({
        command: "copy-message",
        text,
      });
      return true;
    } catch (_) {}
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.setAttribute("readonly", "true");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  fallback.style.pointerEvents = "none";
  fallback.style.inset = "0";
  document.body.appendChild(fallback);
  fallback.focus();
  fallback.select();

  let copied = false;
  try {
    copied = document.execCommand("copy") === true;
  } catch (_) {
    copied = false;
  }

  fallback.remove();
  return copied;
}

function showCopyFeedback(button) {
  if (copyFeedbackButton && copyFeedbackButton !== button) {
    copyFeedbackButton.dataset.copied = "false";
    copyFeedbackButton.setAttribute("aria-label", t("aria_copy_message"));
    copyFeedbackButton.setAttribute("title", t("aria_copy_message"));
    copyFeedbackButton.innerHTML = COPY_ICON;
  }

  if (copyFeedbackTimer) {
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = null;
  }

  const label = t("copied");
  copyFeedbackButton = button;
  button.dataset.copied = "true";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.innerHTML = COPIED_ICON;

  copyFeedbackTimer = setTimeout(() => {
    button.dataset.copied = "false";
    button.setAttribute("aria-label", t("aria_copy_message"));
    button.setAttribute("title", t("aria_copy_message"));
    button.innerHTML = COPY_ICON;
    if (copyFeedbackButton === button) {
      copyFeedbackButton = null;
    }
  }, 1600);
}

historyThreadList.addEventListener("click", (event) => {
  const menuButton = event.target.closest?.("[data-history-menu-button]");
  if (menuButton) {
    const threadId = menuButton.dataset.threadId || "";
    const isPinned = menuButton.dataset.pinned === "true";
    if (openHistoryMenuThreadId === threadId) {
      closeHistoryActionMenu();
      return;
    }
    openHistoryActionMenu(threadId, isPinned, menuButton);
    return;
  }

  const button = event.target.closest?.("[data-history-open]");
  if (!button) {
    return;
  }

  const threadId = button.dataset.threadId || "";
  if (!threadId) {
    return;
  }

  webkit.messageHandlers.controller.postMessage({
    command: "load-thread",
    threadId,
  });
  closeHistoryDrawer();
});

function renderHistoryThreadList(threads, activeThreadId) {
  historyThreadList.innerHTML = "";

  if (!threads.length) {
    const empty = document.createElement("div");
    empty.className = "history-thread-empty";
    empty.textContent = t("no_history");
    historyThreadList.appendChild(empty);
    return;
  }

  for (const thread of threads) {
    const item = document.createElement("div");
    item.className = "history-thread-item";
    item.dataset.threadId = thread.id || "";
    item.dataset.active = String(thread.id || "") === String(activeThreadId) ? "true" : "false";
    const sourceText =
      thread.sourcePageTitle ||
      thread.sourcePageURL ||
      t("unknown_page");
    const isEditing = String(thread.id || "") === editingHistoryThreadId;
    const titleMarkup = isEditing
      ? `<input
          type="text"
          class="history-thread-title-editor"
          data-history-title-editor="true"
          data-thread-id="${escapeHtml(thread.id || "")}"
          value="${escapeAttribute(thread.title || "")}"
        />`
      : `<button
          type="button"
          class="history-thread-open"
          data-history-open="true"
          data-thread-id="${escapeHtml(thread.id || "")}"
        >
          <div class="history-thread-title">${escapeHtml(thread.title || "新对话")}</div>
        </button>`;
    item.innerHTML = `
      <div class="history-thread-row">
        ${titleMarkup}
        <button
          type="button"
          class="history-thread-menu-button"
          data-history-menu-button="true"
          data-thread-id="${escapeHtml(thread.id || "")}"
          data-pinned="${thread.isPinned ? "true" : "false"}"
          aria-label="More actions"
        >...</button>
      </div>
      <button
        type="button"
        class="history-thread-open history-thread-open-meta"
        data-history-open="true"
        data-thread-id="${escapeHtml(thread.id || "")}"
      >
        <div class="history-thread-meta">
          <span>${escapeHtml(formatThreadTimestamp(thread.updatedAt))}</span>
          <span>${escapeHtml(sourceText)}</span>
        </div>
      </button>
    `;
    historyThreadList.appendChild(item);

    if (isEditing) {
      queueMicrotask(() => {
        const input = historyThreadList.querySelector(`[data-history-title-editor="true"][data-thread-id="${CSS.escape(String(thread.id || ""))}"]`);
        if (input) {
          input.focus();
          input.select();
        }
      });
    }
  }
}

function openHistoryActionMenu(threadId, isPinned, anchor) {
  openHistoryMenuThreadId = threadId;
  openHistoryMenuPinned = isPinned;
  historyActionMenu.innerHTML = `
    <button type="button" class="history-action-menu-item" data-history-action="rename">${t("rename")}</button>
    <button type="button" class="history-action-menu-item" data-history-action="pin">${isPinned ? t("unpin") : t("pin")}</button>
    <button type="button" class="history-action-menu-item history-action-menu-item-danger" data-history-action="delete">${t("delete")}</button>
  `;
  historyActionMenu.classList.add("open");
  historyActionMenu.setAttribute("aria-hidden", "false");

  const drawerRect = historyDrawer.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  historyActionMenu.style.top = `${anchorRect.bottom - drawerRect.top + 6}px`;
  historyActionMenu.style.left = `${Math.max(12, anchorRect.right - drawerRect.left - 152)}px`;
}

function closeHistoryActionMenu() {
  openHistoryMenuThreadId = "";
  openHistoryMenuPinned = false;
  historyActionMenu.classList.remove("open");
  historyActionMenu.setAttribute("aria-hidden", "true");
  historyActionMenu.innerHTML = "";
}

historyActionMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const actionButton = event.target.closest?.("[data-history-action]");
  if (!actionButton || !openHistoryMenuThreadId) {
    return;
  }

  const action = actionButton.dataset.historyAction || "";
  if (action === "rename") {
    editingHistoryThreadId = openHistoryMenuThreadId;
    renderHistoryThreadList(currentHistoryThreads, currentThreadId);
  } else if (action === "pin") {
    webkit.messageHandlers.controller.postMessage({
      command: "toggle-pin-thread",
      threadId: openHistoryMenuThreadId,
      isPinned: !openHistoryMenuPinned,
    });
  } else if (action === "delete") {
    webkit.messageHandlers.controller.postMessage({
      command: "delete-thread",
      threadId: openHistoryMenuThreadId,
    });
  }

  closeHistoryActionMenu();
});

historyThreadList.addEventListener("keydown", (event) => {
  const input = event.target.closest?.("[data-history-title-editor='true']");
  if (!input) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    commitInlineThreadRename(input);
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelInlineThreadRename();
  }
});

historyThreadList.addEventListener("focusout", (event) => {
  const input = event.target.closest?.("[data-history-title-editor='true']");
  if (!input) {
    return;
  }

  queueMicrotask(() => {
    if (document.activeElement === input) {
      return;
    }
    commitInlineThreadRename(input);
  });
});

historyThreadList.addEventListener("click", (event) => {
  const input = event.target.closest?.("[data-history-title-editor='true']");
  if (input) {
    event.stopPropagation();
  }
});

function commitInlineThreadRename(input) {
  const threadId = input.dataset.threadId || "";
  const title = String(input.value || "").trim();
  editingHistoryThreadId = "";
  if (!threadId) {
    renderHistoryThreadList(currentHistoryThreads, currentThreadId);
    return;
  }
  if (!title) {
    renderHistoryThreadList(currentHistoryThreads, currentThreadId);
    return;
  }
  webkit.messageHandlers.controller.postMessage({
    command: "rename-thread",
    threadId,
    title,
  });
}

function cancelInlineThreadRename() {
  editingHistoryThreadId = "";
  renderHistoryThreadList(currentHistoryThreads, currentThreadId);
}

function formatThreadTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return t("unknown_time");
  }

  const date =
    numeric > 10_000_000_000 ? new Date(numeric) : new Date(numeric * 1000);
  if (Number.isNaN(date.getTime())) {
    return t("unknown_time");
  }

  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function renderPlainText(value) {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function escapeAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeMarkdown(value) {
  return String(value || "").replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function renderMarkdown(value) {
  const source = String(value || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const html = [];
  let inCode = false;
  let codeLines = [];
  let listType = null;

  const closeList = () => {
    if (!listType) {
      return;
    }
    html.push(listType === "ol" ? "</ol>" : "</ul>");
    listType = null;
  };

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      closeList();
      if (inCode) {
        html.push(
          `<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
        );
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    const ordered = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderInlineMarkdown(ordered[2])}</li>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    closeList();

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (trimmed.startsWith(">")) {
      html.push(
        `<blockquote>${renderInlineMarkdown(trimmed.replace(/^>\s?/, ""))}</blockquote>`,
      );
      continue;
    }

    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  closeList();
  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }

  return html.join("");
}

function renderInlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return text;
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
