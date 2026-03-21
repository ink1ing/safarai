const modelSelect = document.getElementById("model-select");
const modelDisplay = document.getElementById("model-display");
const conversationList = document.getElementById("conversation-list");
const conversationStatus = document.getElementById("conversation-status");
const contextURL = document.getElementById("context-url");
const questionEditor = document.getElementById("question-editor");
const askPageButton = document.getElementById("ask-page");
const refreshContextButton = document.getElementById("refresh-context-button");
const settingsButton = document.getElementById("settings-button");
const settingsCloseButton = document.getElementById("settings-close-button");
const contextPreviewURL = document.getElementById("context-preview-url");

modelSelect.addEventListener("change", () => {
  syncSelectedModelDisplay();
  webkit.messageHandlers.controller.postMessage({
    command: "save-selected-model",
    selectedModel: modelSelect.value,
    reasoningEffort: "medium",
  });
});
settingsButton.addEventListener("click", () => {
  toggleSettingsDrawer();
});
settingsCloseButton.addEventListener("click", () => {
  closeSettingsDrawer();
});
refreshContextButton.addEventListener("click", () => {
  webkit.messageHandlers.controller.postMessage({
    command: "refresh-panel-context",
  });
});

for (const pill of document.querySelectorAll(".suggestion-pill[data-prompt]")) {
  pill.addEventListener("click", () => {
    const prompt = pill.dataset.prompt;
    if (prompt) {
      sendQuestion(prompt);
    }
  });
}

askPageButton.addEventListener("click", () => sendQuestion());
questionEditor.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendQuestion();
  }
});

function sendQuestion(directPrompt) {
  const prompt = directPrompt || questionEditor.value.trim();
  if (!prompt) {
    return;
  }

  questionEditor.value = "";
  webkit.messageHandlers.controller.postMessage({
    command: "send-question",
    prompt,
  });
}

// MARK: - Settings Drawer

const settingsDrawer = document.getElementById("settings-drawer");

function toggleSettingsDrawer() {
  const isOpen = settingsDrawer.classList.contains("open");
  if (isOpen) {
    closeSettingsDrawer();
  } else {
    openSettingsDrawer();
  }
}

function openSettingsDrawer() {
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

/**
 * Called by Swift (via renderPanelState) to sync drawer UI state.
 * payload fields: codexEmail, codexLoggedIn, zedName, zedLoggedIn,
 *                 activeProvider, placementMode, settingsStatus
 */
function renderSettingsDrawerState(payload) {
  const el = (id) => document.getElementById(id);
  const anyLoggedIn = !!payload.codexLoggedIn || !!payload.zedLoggedIn;

  el("sd-codex-email").textContent =
    payload.codexEmail || (anyLoggedIn ? "可连接" : "未登录");
  el("sd-login-codex").disabled = !!payload.codexLoggedIn;
  el("sd-logout-codex").disabled = !payload.codexLoggedIn;

  el("sd-zed-name").textContent =
    payload.zedName || (anyLoggedIn ? "可连接" : "未登录");
  el("sd-import-zed").disabled = false;
  el("sd-logout-zed").disabled = !payload.zedLoggedIn;

  el("sd-provider-codex").dataset.active =
    payload.activeProvider === "codex" ? "true" : "false";
  el("sd-provider-zed").dataset.active =
    payload.activeProvider === "zed" ? "true" : "false";

  el("sd-placement-remember").dataset.active =
    payload.placementMode === "remember" ? "true" : "false";
  el("sd-placement-left").dataset.active =
    payload.placementMode === "left" ? "true" : "false";
  el("sd-placement-right").dataset.active =
    payload.placementMode === "right" ? "true" : "false";

  el("sd-status").textContent = payload.settingsStatus || "";
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

  questionEditor.disabled = !settings.isLoggedIn;
  askPageButton.disabled = !settings.isLoggedIn;
  refreshContextButton.disabled = false;
  settingsButton.disabled = false;

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
  conversationStatus.textContent =
    status || (messages.length ? `${messages.length} 条` : "Ready");

  // Sync settings drawer state if payload carries it
  if (settings.drawerState) {
    renderSettingsDrawerState(settings.drawerState);
  }
}

function bindModels(models, selectedModel) {
  modelSelect.innerHTML = "";
  const safeModels =
    Array.isArray(models) && models.length
      ? models
      : [{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" }];
  for (const model of safeModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label || model.id;
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
