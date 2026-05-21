const modelSelect = document.getElementById("model-select");
const modelDisplay = document.getElementById("model-display");
const conversationList = document.getElementById("conversation-list");
const contextURL = document.getElementById("context-url");
const contextURLRow = document.getElementById("context-url-row");
const refreshContextURLButton = document.getElementById("refresh-context-url-button");
const detachContextButton = document.getElementById("detach-context-button");
const contextSelectionText = document.getElementById("context-selection-text");
const composerDivider = document.getElementById("composer-divider");
const questionEditor = document.getElementById("question-editor");
const askPageButton = document.getElementById("ask-page");
const historyButton = document.getElementById("refresh-context-button");
const settingsButton = document.getElementById("settings-button");
const summarizeVideoButton = document.getElementById("summarize-video-button");
const settingsCloseButton = document.getElementById("settings-close-button");
const historyCloseButton = document.getElementById("history-close-button");
const systemPromptEditor = document.getElementById("sd-system-prompt-editor");
const saveSystemPromptButton = document.getElementById("sd-save-system-prompt");
const resetSystemPromptButton = document.getElementById("sd-reset-system-prompt");
const openAICompatibleSection = document.getElementById("sd-openai-compatible-section");
const openAICompatibleEndpoint = document.getElementById("sd-openai-compatible-endpoint");
const openAICompatibleApiKey = document.getElementById("sd-openai-compatible-api-key");
const openAICompatibleStatus = document.getElementById("sd-openai-compatible-status");
const contextPreviewURL = document.getElementById("context-preview-url");
const historyThreadList = document.getElementById("history-thread-list");
const historyActionMenu = document.getElementById("history-action-menu");
const newChatButton = document.getElementById("new-chat-button");
const newChatFooterButton = document.getElementById("new-chat-footer-button");
const languageButtonEN = document.getElementById("sd-language-en");
const languageButtonZH = document.getElementById("sd-language-zh");
const LOCAL_MODEL_SELECTION_KEY = "safarai:last-selected-model";
let isStreamingResponse = false;
let isPreparingQuestion = false;
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
let systemPromptSavedValue = "";
let systemPromptDirty = false;
let openAICompatibleDraftDirty = false;
let latestHistoryThreads = [];
let latestPageVisualMetadata = {};
let latestPageVisualURL = "";
let detachedContextURL = "";
let deleteConfirmThreadId = "";

const I18N = {
  en: {
    settings_title: "Settings",
    provider: "AI Provider",
    codex_account: "Codex Account",
    zed_account: "Zed Account",
    openai_compatible: "OpenAI Compatible",
    theme: "Theme",
    language: "Language",
    page_color: "Page Color",
    chat_history: "Chat History",
    display: "Display",
    system_prompt: "System Prompt",
    placement: "Window Placement",
    follow_safari: "Follow Safari",
    updates: "Updates",
    sign_in: "Sign In",
    sign_out: "Sign Out",
    import_zed: "Import Zed",
    refresh_models: "Refresh Models",
    api_key_saved: "API Key saved",
    api_key_missing: "API Key not saved",
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
    safari_extension: "Safari Extension",
    save: "Save",
    remember: "Remember",
    snap_left: "Snap Left",
    snap_right: "Snap Right",
    follow_safari_button: "Follow Safari",
    check_updates: "Check for Updates",
    history_title: "Chat History",
    explain_page: "Explain Page",
    translate_page: "Translate Page",
    give_suggestions: "Give Suggestions",
    summarize_video: "Summarize Video",
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
    cancel: "Cancel",
    aria_close_settings: "Close settings",
    aria_close_history: "Close chat history",
    aria_history: "Chat history",
    aria_settings: "Settings",
    aria_send: "Send",
    aria_stop: "Stop",
    system_prompt_placeholder: "Append a custom prompt after the built-in system prompt.",
  },
  zh: {
    settings_title: "设置",
    provider: "AI 提供商",
    codex_account: "Codex 账户",
    zed_account: "Zed 账户",
    openai_compatible: "OpenAI 兼容",
    theme: "颜色风格",
    language: "语言",
    page_color: "页面颜色",
    chat_history: "聊天记录",
    display: "信息显示",
    system_prompt: "System Prompt",
    placement: "窗口位置",
    follow_safari: "Safari 跟随吸附",
    updates: "自动更新",
    sign_in: "登录",
    sign_out: "退出",
    import_zed: "导入 Zed",
    refresh_models: "刷新模型",
    api_key_saved: "API Key 已保存",
    api_key_missing: "API Key 未保存",
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
    safari_extension: "Safari 扩展",
    save: "保存",
    remember: "记忆位置",
    snap_left: "左吸附",
    snap_right: "右吸附",
    follow_safari_button: "跟随 Safari",
    check_updates: "检查更新",
    history_title: "聊天记录",
    explain_page: "解释页面",
    translate_page: "翻译页面",
    give_suggestions: "给出建议",
    summarize_video: "视频总结",
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
    cancel: "取消",
    aria_close_settings: "收起设置",
    aria_close_history: "收起聊天记录",
    aria_history: "聊天记录",
    aria_settings: "设置",
    aria_send: "发送",
    aria_stop: "终止",
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

modelSelect.addEventListener("change", () => {
  syncSelectedModelDisplay();
  saveLocalModelSelection(modelSelect.value);
  webkit.messageHandlers.controller.postMessage({
    command: "save-selected-model",
    selectedModel: modelSelect.value,
    reasoningEffort: "medium",
  });
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
openAICompatibleEndpoint.addEventListener("input", () => {
  openAICompatibleDraftDirty = true;
});
openAICompatibleApiKey.addEventListener("input", () => {
  openAICompatibleDraftDirty = true;
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
      sendQuestion(prompt, {
        taskIntent: pill.dataset.taskIntent || "",
      });
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
refreshContextURLButton.addEventListener("click", () => {
  detachedContextURL = "";
  syncDetachedContextStorage();
  webkit.messageHandlers.controller.postMessage({
    command: "refresh-panel-context",
  });
  syncDetachedContextState();
});
detachContextButton.addEventListener("click", () => {
  detachedContextURL = String(currentContext?.url || "");
  syncDetachedContextStorage();
  webkit.messageHandlers.controller.postMessage({
    command: "detach-page-context",
    url: detachedContextURL,
  });
  syncDetachedContextState();
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

function sendQuestion(directPrompt, options = {}) {
  const prompt = directPrompt || questionEditor.value.trim();
  if (!prompt) {
    return;
  }

  const selectedFocus = resolveSelectedFocus(options);
  webkit.messageHandlers.controller.postMessage({
    command: "send-question",
    prompt,
    selectedFocus,
    taskIntent: options.taskIntent || "",
    detachPageContext:
      !!detachedContextURL &&
      (!String(currentContext?.url || "") || detachedContextURL === String(currentContext?.url || "")),
    detachedContextURL,
  });
}

function clearQuestionEditor() {
  questionEditor.value = "";
}

function stopCurrentResponse() {
  webkit.messageHandlers.controller.postMessage({
    command: "stop-response",
  });
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
  if (
    settingsDrawer.classList.contains("open") &&
    !settingsDrawer.contains(e.target) &&
    e.target !== settingsButton &&
    !settingsButton.contains(e.target)
  ) {
    closeSettingsDrawer();
  }
  if (
    historyDrawer.classList.contains("open") &&
    !historyDrawer.contains(e.target) &&
    e.target !== historyButton &&
    !historyButton.contains(e.target)
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

function sdCheckForUpdates() {
  sdPost("check-for-updates");
}

function sdOpenSafariExtensionSettings() {
  sdPost("open-safari-extension-preferences");
}

function sdSaveOpenAICompatibleSettings() {
  sdPost("save-openai-compatible-settings", {
    endpoint: openAICompatibleEndpoint.value,
    apiKey: openAICompatibleApiKey.value,
  });
  openAICompatibleDraftDirty = false;
}

function sdRefreshOpenAICompatibleModels() {
  sdPost("refresh-openai-compatible-models");
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
document
  .getElementById("sd-check-updates")
  .addEventListener("click", () => sdCheckForUpdates());
document
  .getElementById("sd-open-safari-extension-settings")
  .addEventListener("click", () => sdOpenSafariExtensionSettings());
document
  .getElementById("sd-save-openai-compatible")
  .addEventListener("click", () => sdSaveOpenAICompatibleSettings());
document
  .getElementById("sd-refresh-openai-compatible-models")
  .addEventListener("click", () => sdRefreshOpenAICompatibleModels());

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
  el("sd-provider-openai-compatible").dataset.active =
    payload.openAICompatibleConfigured ? "true" : "false";
  el("sd-provider-codex").dataset.selected =
    payload.activeProvider === "codex" ? "true" : "false";
  el("sd-provider-zed").dataset.selected =
    payload.activeProvider === "zed" ? "true" : "false";
  el("sd-provider-openai-compatible").dataset.selected =
    payload.activeProvider === "openai_compatible" ? "true" : "false";
  openAICompatibleSection.hidden = payload.activeProvider !== "openai_compatible";
  if (!isEditingOpenAICompatibleSettings()) {
    openAICompatibleEndpoint.value = payload.openAICompatibleEndpoint || "";
    openAICompatibleApiKey.value = payload.openAICompatibleApiKey || "";
  }
  openAICompatibleStatus.textContent = payload.openAICompatibleKeySaved
    ? t("api_key_saved")
    : t("api_key_missing");

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
  applyPageVisualState(latestPageVisualMetadata);
  syncSystemPromptEditor(currentDrawerState.customSystemPrompt);
}

function isEditingOpenAICompatibleSettings() {
  const activeElement = document.activeElement;
  return (
    openAICompatibleDraftDirty ||
    activeElement === openAICompatibleEndpoint ||
    activeElement === openAICompatibleApiKey
  );
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
 * Appends raw text to the bubble and renders the accumulated Markdown immediately.
 */
function appendStreamChunk(chunk) {
  if (!_streamingEntry) return;
  _streamingText += String(chunk || "");
  renderStreamingMarkdown();
}

function renderStreamingMarkdown() {
  if (!_streamingEntry) return;
  const inner = _streamingEntry.querySelector(".message-markdown");
  if (inner) {
    inner.innerHTML = renderMarkdown(_streamingText);
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
    renderStreamingMarkdown();
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
  currentContext = context;
  if (
    detachedContextURL &&
    String(context?.url || "") &&
    detachedContextURL !== String(context?.url || "")
  ) {
    detachedContextURL = "";
    syncDetachedContextStorage();
  }
  latestPageVisualMetadata = resolvePageVisualMetadata(context);
  currentThreadId = String(payload?.currentThreadId || "");
  isStreamingResponse = !!payload?.isStreaming;
  isPreparingQuestion = !!payload?.isPreparingQuestion;

  if (settings.drawerState) {
    renderSettingsDrawerState(settings.drawerState);
  } else {
    applyTranslations();
  }

  questionEditor.disabled = !settings.isLoggedIn || isStreamingResponse || isPreparingQuestion;
  askPageButton.disabled = !settings.isLoggedIn || isPreparingQuestion;
  historyButton.disabled = false;
  settingsButton.disabled = false;
  syncAskButton();

  bindModels(
    settings.availableModels || [],
    settings.selectedModel || "gpt-5.4-mini",
  );
  // Don't clobber a live stream with a full re-render
  if (!_streamingEntry) {
    renderMessages(messages);
  }
  contextURL.textContent = context?.url || "";
  contextPreviewURL.textContent = context?.url || "";
  syncDetachedContextState();
  syncVideoSummaryButton();
  const currentSelectionText = getCurrentSelectionText();
  contextSelectionText.textContent = currentSelectionText
    ? `"${currentSelectionText}"`
    : "";
  contextSelectionText.classList.toggle("is-hidden", !currentSelectionText);
  applyVisibility(settings);
  latestHistoryThreads = historyThreads;
  renderHistoryThreadList(historyThreads, currentThreadId);
  applyPageVisualState(latestPageVisualMetadata);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || "blue";
}

function resolvePageVisualMetadata(context) {
  const metadata = context?.metadata || {};
  const contextURLValue = String(context?.url || "");
  if (hasPageVisualMetadata(metadata)) {
    latestPageVisualURL = contextURLValue;
    return metadata;
  }

  if (contextURLValue && contextURLValue === latestPageVisualURL) {
    return latestPageVisualMetadata;
  }

  latestPageVisualURL = "";
  return metadata;
}

function hasPageVisualMetadata(metadata) {
  return !!(
    normalizeVisualValue(metadata?.pageBackgroundColor) ||
    normalizeVisualValue(metadata?.pageBackgroundImage) ||
    normalizeAppearance(metadata?.pageColorScheme)
  );
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

  contextURLRow.classList.toggle("is-hidden", !showPageInfo);
  composerDivider.classList.toggle("is-hidden", !showPageInfo);
}

function syncVideoSummaryButton() {
  const metadata = currentContext?.metadata || {};
  const pageKind = String(metadata.pageKind || "");
  const hasVideo =
    pageKind === "youtube_video" ||
    pageKind === "bilibili_video" ||
    String(metadata.hasPrimaryVideo || "") === "true";
  summarizeVideoButton.classList.toggle("is-hidden", !hasVideo);
  summarizeVideoButton.hidden = !hasVideo;
}

function syncDetachedContextState() {
  const contextURLValue = String(currentContext?.url || "");
  const detached = !!detachedContextURL && (!contextURLValue || detachedContextURL === contextURLValue);
  contextURLRow.dataset.detached = detached ? "true" : "false";
  contextURL.textContent = detached ? "" : contextURLValue;
  detachContextButton.hidden = !contextURLValue || detached;
  detachContextButton.disabled = !contextURLValue || detached;
  refreshContextURLButton.hidden = !contextURLValue && !detached;
  refreshContextURLButton.disabled = !contextURLValue && !detached;
}

function syncDetachedContextStorage() {
  webkit.messageHandlers.controller.postMessage({
    command: "set-detached-context-url",
    url: detachedContextURL,
  });
}

function syncAskButton() {
  askPageButton.dataset.mode = isStreamingResponse ? "stop" : "send";
  askPageButton.classList.toggle("icon-button-danger", isStreamingResponse);
  askPageButton.classList.toggle("icon-button-primary", !isStreamingResponse);
  askPageButton.setAttribute("aria-label", isStreamingResponse ? t("aria_stop") : t("aria_send"));
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
  document.getElementById("settings-label-openai-compatible").textContent = t("openai_compatible");
  document.getElementById("settings-label-theme").textContent = t("theme");
  document.getElementById("settings-label-language").textContent = t("language");
  document.getElementById("settings-label-page-color").textContent = t("page_color");
  document.getElementById("settings-label-history").textContent = t("chat_history");
  document.getElementById("settings-label-display").textContent = t("display");
  document.getElementById("settings-label-system-prompt").textContent = t("system_prompt");
  document.getElementById("settings-label-placement").textContent = t("placement");
  document.getElementById("settings-label-follow-safari").textContent = t("follow_safari");
  document.getElementById("settings-label-updates").textContent = t("updates");
  document.getElementById("history-header-title").textContent = t("history_title");

  document.getElementById("sd-login-codex").textContent = t("sign_in");
  document.getElementById("sd-logout-codex").textContent = t("sign_out");
  document.getElementById("sd-import-zed").textContent = t("import_zed");
  document.getElementById("sd-logout-zed").textContent = t("sign_out");
  document.getElementById("sd-provider-openai-compatible").textContent = t("openai_compatible");
  document.getElementById("sd-save-openai-compatible").textContent = t("save");
  document.getElementById("sd-refresh-openai-compatible-models").textContent = t("refresh_models");
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
  document.getElementById("sd-open-safari-extension-settings").textContent = t("safari_extension");
  document.getElementById("sd-save-system-prompt").textContent = t("save");
  document.getElementById("sd-reset-system-prompt").textContent = t("reset_default");
  document.getElementById("sd-placement-remember").textContent = t("remember");
  document.getElementById("sd-placement-left").textContent = t("snap_left");
  document.getElementById("sd-placement-right").textContent = t("snap_right");
  document.getElementById("sd-follow-safari-window").textContent = t("follow_safari_button");
  document.getElementById("sd-check-updates").textContent = t("check_updates");
  document.getElementById("sd-history-storage-path").textContent =
    currentDrawerState.historyStoragePath || t("default_location");
  document.getElementById("sd-history-storage-status").textContent =
    currentDrawerState.historyStorageStatus || t("default_location");
  systemPromptEditor.placeholder = t("system_prompt_placeholder");
  settingsCloseButton.setAttribute("aria-label", t("aria_close_settings"));
  historyCloseButton.setAttribute("aria-label", t("aria_close_history"));
  historyButton.setAttribute("aria-label", t("aria_history"));
  settingsButton.setAttribute("aria-label", t("aria_settings"));

  const newChatLabel = newChatButton.querySelector("span:last-child");
  if (newChatLabel) {
    newChatLabel.textContent = currentLanguage() === "zh" ? "新对话" : "New Chat";
  }
  newChatFooterButton.setAttribute("aria-label", currentLanguage() === "zh" ? "新对话" : "New Chat");

  const suggestionButtons = document.querySelectorAll(".suggestion-pill");
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
  summarizeVideoButton.textContent = t("summarize_video");
  summarizeVideoButton.dataset.prompt =
    currentLanguage() === "zh"
      ? "根据视频时间戳总结这个视频的主要内容。"
      : "Summarize the main content of this video using timestamps.";
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
      : [{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" }];
  const localSelection = loadLocalModelSelection();
  const matchingSelectedModel = findMatchingModelID(safeModels, selectedModel);
  const matchingLocalSelection = findMatchingModelID(safeModels, localSelection);
  const preferredSelection = safeModels.some((model) => model.id === selectedModel)
    ? selectedModel
    : matchingSelectedModel || matchingLocalSelection || selectedModel;
  for (const model of safeModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label || model.id;
    modelSelect.appendChild(option);
  }
  modelSelect.value = preferredSelection;
  if (modelSelect.value !== preferredSelection && modelSelect.options.length > 0) {
    modelSelect.selectedIndex = 0;
  }
  saveLocalModelSelection(modelSelect.value);
  syncSelectedModelDisplay();
}

function findMatchingModelID(models, modelID) {
  const normalized = String(modelID || "").trim();
  if (!normalized) {
    return "";
  }
  const parsed = parseModelOptionID(normalized);
  const match = models.find((model) => {
    if (model.id === normalized) {
      return true;
    }
    const candidate = parseModelOptionID(model.id);
    return candidate.modelID === parsed.modelID && candidate.provider === parsed.provider;
  });
  return match?.id || "";
}

function parseModelOptionID(value) {
  const marker = "::";
  const index = String(value || "").indexOf(marker);
  if (index >= 0) {
    return {
      provider: String(value).slice(0, index),
      modelID: String(value).slice(index + marker.length),
    };
  }
  return { provider: "", modelID: String(value || "") };
}

function loadLocalModelSelection() {
  try {
    return localStorage.getItem(LOCAL_MODEL_SELECTION_KEY) || "";
  } catch {
    return "";
  }
}

function saveLocalModelSelection(value) {
  try {
    localStorage.setItem(LOCAL_MODEL_SELECTION_KEY, String(value || ""));
  } catch {
    // Ignore local storage failures in WebKit private contexts.
  }
}

function syncSelectedModelDisplay() {
  const selectedOption = modelSelect.options[modelSelect.selectedIndex];
  modelDisplay.textContent = selectedOption?.textContent || "选择模型";
}

function renderMessages(messages) {
  conversationList.innerHTML = "";

  if (!messages.length) {
    return;
  }

  for (const item of messages) {
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
    const content =
      role === "assistant"
        ? renderMarkdown(item.text || "")
        : renderPlainText(item.text || "");
    entry.innerHTML = `<div class="${cssClass}">${content}</div>`;
    conversationList.appendChild(entry);
  }
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
    item.innerHTML = `
      <div class="history-thread-row">
        <button
          type="button"
          class="history-thread-open"
          data-history-open="true"
          data-thread-id="${escapeHtml(thread.id || "")}"
        >
          <div class="history-thread-title">${escapeHtml(thread.title || "新对话")}</div>
        </button>
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
  }
}

function openHistoryActionMenu(threadId, isPinned, anchor) {
  openHistoryMenuThreadId = threadId;
  openHistoryMenuPinned = isPinned;
  deleteConfirmThreadId = "";
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

function showHistoryRenameForm() {
  const thread = latestHistoryThreads.find(
    (item) => String(item.id || "") === String(openHistoryMenuThreadId),
  );
  const currentTitle = thread?.title || "";
  historyActionMenu.innerHTML = `
    <form class="history-action-rename-form" data-history-rename-form="true">
      <input
        class="history-action-rename-input"
        type="text"
        value="${escapeHtml(currentTitle)}"
        placeholder="${escapeHtml(t("rename_prompt"))}"
        aria-label="${escapeHtml(t("rename_prompt"))}"
      />
      <div class="history-action-rename-actions">
        <button type="button" class="history-action-menu-item" data-history-action="cancel-rename">${t("cancel")}</button>
        <button type="submit" class="history-action-menu-item history-action-menu-item-primary">${t("save")}</button>
      </div>
    </form>
  `;
  const input = historyActionMenu.querySelector(".history-action-rename-input");
  if (input) {
    input.focus();
    input.select();
  }
}

function closeHistoryActionMenu() {
  openHistoryMenuThreadId = "";
  openHistoryMenuPinned = false;
  deleteConfirmThreadId = "";
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
    showHistoryRenameForm();
    return;
  } else if (action === "cancel-rename") {
    closeHistoryActionMenu();
    return;
  } else if (action === "pin") {
    webkit.messageHandlers.controller.postMessage({
      command: "toggle-pin-thread",
      threadId: openHistoryMenuThreadId,
      isPinned: !openHistoryMenuPinned,
    });
  } else if (action === "delete") {
    if (deleteConfirmThreadId !== openHistoryMenuThreadId) {
      deleteConfirmThreadId = openHistoryMenuThreadId;
      actionButton.textContent = t("delete_confirm");
      actionButton.classList.add("history-action-menu-item-confirming");
      return;
    }
    webkit.messageHandlers.controller.postMessage({
      command: "delete-thread",
      threadId: openHistoryMenuThreadId,
    });
  }

  closeHistoryActionMenu();
});

historyActionMenu.addEventListener("submit", (event) => {
  event.stopPropagation();
  const form = event.target.closest?.("[data-history-rename-form]");
  if (!form || !openHistoryMenuThreadId) {
    return;
  }
  event.preventDefault();
  const input = form.querySelector(".history-action-rename-input");
  const title = String(input?.value || "").trim();
  if (!title) {
    input?.focus();
    return;
  }
  webkit.messageHandlers.controller.postMessage({
    command: "rename-thread",
    threadId: openHistoryMenuThreadId,
    title,
  });
  closeHistoryActionMenu();
});

historyActionMenu.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape") {
    closeHistoryActionMenu();
  }
});

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
    (_match, label, url) => {
      const safeURL = sanitizeMarkdownURL(url);
      if (!safeURL) {
        return label;
      }
      return `<a href="${safeURL}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  );
  return text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeMarkdownURL(value) {
  const url = String(value || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return "";
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "";
    }
    return escapeHtml(parsed.href);
  } catch {
    return "";
  }
}

function truncate(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}...`;
}
