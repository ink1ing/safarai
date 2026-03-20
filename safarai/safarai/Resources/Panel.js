const modelSelect = document.getElementById("model-select");
const conversationList = document.getElementById("conversation-list");
const conversationStatus = document.getElementById("conversation-status");
const contextURL = document.getElementById("context-url");
const questionEditor = document.getElementById("question-editor");
const askPageButton = document.getElementById("ask-page");
const refreshContextButton = document.getElementById("refresh-context-button");
const settingsButton = document.getElementById("settings-button");

modelSelect.addEventListener("change", () => {
    webkit.messageHandlers.controller.postMessage({
        command: "save-selected-model",
        selectedModel: modelSelect.value,
        reasoningEffort: "medium",
    });
});
settingsButton.addEventListener("click", () => {
    webkit.messageHandlers.controller.postMessage({
        command: "open-settings-panel",
    });
});
refreshContextButton.addEventListener("click", () => {
    webkit.messageHandlers.controller.postMessage({
        command: "refresh-panel-context",
    });
});

askPageButton.addEventListener("click", sendQuestion);
questionEditor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendQuestion();
    }
});

function sendQuestion() {
    const prompt = questionEditor.value.trim();
    if (!prompt) {
        return;
    }

    questionEditor.value = "";
    webkit.messageHandlers.controller.postMessage({
        command: "send-question",
        prompt,
    });
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

    bindModels(settings.availableModels || [], settings.selectedModel || "gpt-5.4-mini");
    renderMessages(messages);
    contextURL.textContent = context?.url || "";
    conversationStatus.textContent = status || (messages.length ? `${messages.length} 条` : "等待页面同步");
}

function bindModels(models, selectedModel) {
    modelSelect.innerHTML = "";
    const safeModels = Array.isArray(models) && models.length ? models : [{ id: "gpt-5.4-mini", label: "gpt-5.4-mini" }];
    for (const model of safeModels) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.label || model.id;
        modelSelect.appendChild(option);
    }
    modelSelect.value = selectedModel;
}

function renderMessages(messages) {
    conversationList.innerHTML = "";

    if (!messages.length) {
        const empty = document.createElement("div");
        empty.className = "conversation-item";
        empty.dataset.role = "system";
        empty.innerHTML = `
            <span class="conversation-role">system</span>
            <div>等待 Safari 页面同步上下文。</div>
        `;
        conversationList.appendChild(empty);
        return;
    }

    for (const item of messages) {
        const role = item.role || "system";
        const entry = document.createElement("div");
        entry.className = "conversation-item";
        entry.dataset.role = role;
        entry.innerHTML = `
            <span class="conversation-role">${escapeHtml(role === "user" ? "你" : role === "assistant" ? "AI" : "系统")}</span>
            <div class="message-markdown">${role === "assistant" ? renderMarkdown(item.text || "") : renderPlainText(item.text || "")}</div>
        `;
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
                html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
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
            html.push(`<blockquote>${renderInlineMarkdown(trimmed.replace(/^>\s?/, ""))}</blockquote>`);
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
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return text;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
