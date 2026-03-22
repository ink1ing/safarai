//
//  ViewController.swift
//  safarai
//
//  Created by silas on 3/13/26.
//

import Cocoa
import SafariServices
import UniformTypeIdentifiers
import WebKit

let extensionBundleIdentifier = "ink.safarai.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    private var panelRefreshTimer: Timer?
    private var responseTask: Task<Void, Never>?
    private var agentTask: Task<Void, Never>?
    private var safariWindowFollower: SafariWindowFollower?
    private var agentSessionState: [String: Any]?
    private var agentApprovalContinuation: CheckedContinuation<Bool, Never>?

    override func viewDidLoad() {
        super.viewDidLoad()

        webView.setValue(false, forKey: "drawsBackground")
        webView.wantsLayer = true
        webView.layer?.backgroundColor = NSColor.clear.cgColor
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAssistantPanelRefresh),
            name: .assistantPanelShouldRefresh,
            object: nil
        )
        webView.loadFileURL(
            Bundle.main.url(forResource: "Panel", withExtension: "html")!,
            allowingReadAccessTo: Bundle.main.resourceURL!
        )
        startPanelRefreshTimer()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        if let window = view.window {
            WindowPlacementCoordinator.restoreOrSnap(
                window,
                autosaveName: "MainChatWindow",
                placementMode: loadPlacementMode()
            )
            if safariWindowFollower == nil {
                safariWindowFollower = SafariWindowFollower(
                    window: window,
                    autosaveName: "MainChatWindow",
                    placementModeProvider: { [weak self] in
                        self?.loadPlacementMode() ?? .remember
                    },
                    followEnabledProvider: { [weak self] in
                        self?.loadFollowSafariWindow() ?? true
                    }
                )
            }
            safariWindowFollower?.start()
        }
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        safariWindowFollower?.stop()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            guard let state = state, error == nil else {
                return
            }

            DispatchQueue.main.async {
                self.pushPanelState(
                    status: state.isEnabled
                        ? AppText.localized(en: "Safari extension connected.", zh: "已连接 Safari 扩展")
                        : AppText.localized(en: "Safari extension is disabled.", zh: "扩展未启用")
                )
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let command = message.body as? String {
            if command == "open-preferences" {
                SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in
                    DispatchQueue.main.async {
                        NSApplication.shared.terminate(nil)
                    }
                }
            }
            return
        }

        guard
            let body = message.body as? [String: Any],
            let command = body["command"] as? String
        else {
            return
        }

        switch command {
        case "load-codex-settings", "reload-panel-state":
            pushPanelState()
        case "start-codex-login":
            startCodexLogin()
        case "logout-codex":
            logoutCodex()
        case "refresh-codex-models":
            refreshCodexModels()
        case "login-zed":
            loginZed()
        case "logout-zed":
            logoutZed()
        case "refresh-zed-models":
            refreshZedModels()
        case "switch-provider":
            if let provider = body["provider"] as? String {
                switchProvider(provider)
            }
        case "save-selected-model":
            saveSelectedModel(body)
        case "start-agent":
            startAgent(body)
        case "approve-agent-action":
            resolveAgentApproval(true)
        case "reject-agent-action":
            resolveAgentApproval(false)
        case "cancel-agent":
            cancelAgent()
        case "pick-attachments":
            pickAttachments()
        case "send-question":
            sendQuestion(body)
        case "copy-message":
            copyMessage(body["text"] as? String)
        case "create-thread":
            createThread()
        case "load-thread":
            if let threadID = body["threadId"] as? String {
                loadThread(threadID)
            }
        case "rename-thread":
            if let threadID = body["threadId"] as? String {
                renameThread(threadID, title: body["title"] as? String)
            }
        case "toggle-pin-thread":
            if let threadID = body["threadId"] as? String {
                togglePinnedThread(threadID, isPinned: body["isPinned"] as? Bool)
            }
        case "delete-thread":
            if let threadID = body["threadId"] as? String {
                deleteThread(threadID)
            }
        case "list-threads":
            pushPanelState()
        case "stop-response":
            stopCurrentResponse()
        case "refresh-panel-context":
            refreshPanelContext()
        case "open-settings-panel":
            break
        case "save-placement-mode-settings":
            if let mode = body["placementMode"] as? String {
                do {
                    try savePlacementMode(mode)
                    pushPanelState(status: "窗口位置策略已更新。")
                } catch {
                    pushError(error.localizedDescription)
                }
            }
        case "save-theme-settings":
            if let theme = body["theme"] as? String {
                do {
                    try saveTheme(theme)
                    pushPanelState(status: AppText.localized(en: "Theme updated.", zh: "颜色风格已更新。"))
                } catch {
                    pushError(error.localizedDescription)
                }
            }
        case "save-language-settings":
            if let language = body["language"] as? String {
                do {
                    try saveLanguage(language)
                    pushPanelState(status: AppText.localized(en: "Language updated.", zh: "语言已更新。"))
                } catch {
                    pushError(error.localizedDescription)
                }
            }
        case "save-panel-visibility-settings":
            do {
                try savePanelVisibilitySettings(showPageInfo: body["showPageInfo"] as? Bool)
                pushPanelState(status: AppText.localized(en: "Display settings updated.", zh: "显示选项已更新。"))
            } catch {
                pushError(error.localizedDescription)
            }
        case "save-follow-safari-window-settings":
            do {
                try saveFollowSafariWindowSetting(body["followSafariWindow"] as? Bool)
                pushPanelState(status: AppText.localized(en: "Safari follow mode updated.", zh: "Safari 跟随吸附已更新。"))
                safariWindowFollower?.refreshMode()
            } catch {
                pushError(error.localizedDescription)
            }
        case "save-follow-page-color-settings":
            do {
                try saveFollowPageColorSetting(body["followPageColor"] as? Bool)
                pushPanelState(status: AppText.localized(en: "Page color sync updated.", zh: "页面颜色跟随已更新。"))
            } catch {
                pushError(error.localizedDescription)
            }
        case "change-history-storage-location":
            changeHistoryStorageLocation()
        case "reset-history-storage-location":
            resetHistoryStorageLocation()
        case "import-history-library":
            importHistoryLibrary()
        case "export-history-library":
            exportHistoryLibrary()
        case "save-custom-system-prompt":
            do {
                try saveCustomSystemPrompt(body["customSystemPrompt"] as? String)
                pushPanelState(status: "System prompt 已保存。")
            } catch {
                pushError(error.localizedDescription)
            }
        case "reset-custom-system-prompt":
            do {
                try resetCustomSystemPrompt()
                pushPanelState(status: "已恢复默认 system prompt。")
            } catch {
                pushError(error.localizedDescription)
            }
        case "reset-provider-settings":
            do {
                try CodexAccountStore.clear()
                pushPanelState(status: "已清除当前 Codex 登录状态。")
            } catch {
                pushError(error.localizedDescription)
            }
        default:
            break
        }
    }

    private func copyMessage(_ rawText: String?) {
        let text = (rawText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return
        }

        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    private func startCodexLogin() {
            pushPanelState(status: AppText.localized(en: "Starting Codex sign-in…", zh: "正在拉起 Codex 登录…"))
        Task {
            do {
                let result = try await CodexOAuthService.shared.startLogin()
                try? ProviderSettingsStore.saveActiveProvider(.codex)
                pushPanelState(status: AppText.localized(en: "Codex signed in. Models synced.", zh: "Codex 登录成功，模型列表已同步。"), configuration: result.configuration)
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func logoutCodex() {
        do {
            try CodexAccountStore.clear()
            if ProviderSettingsStore.loadActiveProvider() == .codex, ZedAccountStore.load() != nil {
                try? ProviderSettingsStore.saveActiveProvider(.zed)
            }
            pushPanelState(status: AppText.localized(en: "Signed out of Codex.", zh: "已登出 Codex。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func refreshCodexModels() {
        guard let configuration = CodexAccountStore.load() else {
            pushError(AppText.localized(en: "Not signed in to Codex.", zh: "当前未登录 Codex。"))
            return
        }

        pushPanelState(status: AppText.localized(en: "Refreshing model list…", zh: "正在刷新模型列表…"))
        Task {
            do {
                let refreshed = try await CodexOAuthService.shared.refreshIfNeeded(configuration)
                let models = try await CodexModelService.shared.fetchModels(configuration: refreshed)
                var next = refreshed
                next.model.available = models
                next.model.lastSyncAt = Date().timeIntervalSince1970
                if !models.contains(where: { $0.id == next.model.selected }) {
                    next.model.selected = models.first?.id ?? "gpt-5"
                }
                try CodexAccountStore.save(next)
                pushPanelState(status: AppText.localized(en: "Model list refreshed.", zh: "模型列表已刷新。"), configuration: next)
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func saveSelectedModel(_ body: [String: Any]) {
        let selectedValue = (body["selectedModel"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let reasoningEffort = (body["reasoningEffort"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "medium"

        guard !selectedValue.isEmpty else {
            pushError(AppText.localized(en: "Please choose a model.", zh: "请选择一个模型。"))
            return
        }

        let selection = parseModelSelection(
            selectedValue,
            fallback: resolvedActiveProvider()
        )

        switch selection.provider {
        case .zed:
            guard var configuration = ZedAccountStore.load() else {
                pushError(AppText.localized(en: "Not signed in to Zed.", zh: "当前未登录 Zed。"))
                return
            }
            guard configuration.model.available.contains(where: { $0.id == selection.modelID }) else {
                pushError(AppText.localized(en: "The selected model is not available in Zed.", zh: "所选模型在 Zed 模型列表中不存在。"))
                return
            }
            configuration.model.selected = selection.modelID
            do {
                try ZedAccountStore.save(configuration)
                try ProviderSettingsStore.saveActiveProvider(.zed)
                try saveUISettings(reasoningEffort: reasoningEffort)
                pushPanelState(status: AppText.localized(en: "Model saved.", zh: "模型已保存。"))
            } catch {
                pushError(error.localizedDescription)
            }

        case .codex:
            guard var configuration = CodexAccountStore.load() else {
                pushError(AppText.localized(en: "Not signed in to Codex.", zh: "当前未登录 Codex。"))
                return
            }
            guard configuration.model.available.contains(where: { $0.id == selection.modelID }) else {
                pushError(AppText.localized(en: "The selected model is not available in Codex.", zh: "所选模型在 Codex 模型列表中不存在。"))
                return
            }
            configuration.model.selected = selection.modelID
            do {
                try CodexAccountStore.save(configuration)
                try ProviderSettingsStore.saveActiveProvider(.codex)
                try saveUISettings(reasoningEffort: reasoningEffort)
                pushPanelState(status: AppText.localized(en: "Model saved.", zh: "模型已保存。"), configuration: configuration)
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func loginZed() {
        pushPanelState(status: AppText.localized(en: "Importing Zed account from Keychain…", zh: "正在从 Keychain 导入 Zed 账户…"))
        Task {
            do {
                var config = try await ZedAccountStore.importFromKeychain()
                let models = try await ZedResponseService.shared.fetchModels(configuration: config)
                config.model.available = models
                config.model.lastSyncAt = Date().timeIntervalSince1970
                if let firstModel = models.first {
                    config.model.selected = firstModel.id
                }
                try ZedAccountStore.save(config)
                try ProviderSettingsStore.saveActiveProvider(.zed)
                pushPanelState(status: AppText.localized(en: "Zed signed in. \(models.count) models available.", zh: "Zed 登录成功，共 \(models.count) 个模型。"))
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func logoutZed() {
        do {
            try ZedAccountStore.clear()
            if ProviderSettingsStore.loadActiveProvider() == .zed, CodexAccountStore.load() != nil {
                try? ProviderSettingsStore.saveActiveProvider(.codex)
            }
            pushPanelState(status: AppText.localized(en: "Signed out of Zed.", zh: "已登出 Zed。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func refreshZedModels() {
        guard var config = ZedAccountStore.load() else {
            pushError(AppText.localized(en: "Not signed in to Zed.", zh: "当前未登录 Zed。"))
            return
        }
        pushPanelState(status: AppText.localized(en: "Refreshing Zed models…", zh: "正在刷新 Zed 模型列表…"))
        Task {
            do {
                let models = try await ZedResponseService.shared.fetchModels(configuration: config)
                config.model.available = models
                config.model.lastSyncAt = Date().timeIntervalSince1970
                if !models.isEmpty && !models.contains(where: { $0.id == config.model.selected }) {
                    config.model.selected = models.first!.id
                }
                try ZedAccountStore.save(config)
                pushPanelState(status: AppText.localized(en: "Zed models refreshed: \(models.count).", zh: "Zed 模型列表已刷新，共 \(models.count) 个。"))
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func switchProvider(_ rawValue: String) {
        guard let provider = ActiveProvider(rawValue: rawValue) else {
            return
        }
        do {
            try ProviderSettingsStore.saveActiveProvider(provider)
            let name = provider == .zed ? "Zed" : "Codex"
            pushPanelState(status: AppText.localized(en: "Switched to \(name).", zh: "已切换到 \(name)。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func sendQuestion(_ body: [String: Any]) {
        guard responseTask == nil else {
            stopCurrentResponse()
            return
        }

        let prompt = (body["prompt"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let selectedFocus = (body["selectedFocus"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let attachments = parseAttachments(body["attachments"])
        let resolvedPrompt = prompt.isEmpty && !attachments.isEmpty
            ? AppText.localized(en: "Analyze the attached images.", zh: "请分析我附带的图片内容。")
            : prompt
        guard !resolvedPrompt.isEmpty else {
            pushPanelState(status: AppText.localized(en: "Enter a question.", zh: "请输入问题。"))
            return
        }

        var snapshot = PanelStateStore.load()
            ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        snapshot.messages.append(
            PanelConversationMessage(
                role: "user",
                kind: "question",
                text: prompt,
                attachments: attachments.isEmpty ? nil : attachments
            )
        )
        snapshot.status = AppText.localized(en: "Answering", zh: "正在回答")
        snapshot.updatedAt = Date().timeIntervalSince1970
        try? PanelStateStore.save(snapshot)

        pushPanelState(status: AppText.localized(en: "Answering", zh: "正在回答"), snapshot: snapshot)
        evaluateRaw("beginStreamMessage()")

        let activeProvider = resolvedActiveProvider()
        let contextSnapshot: PanelContextSnapshot? = {
            guard var context = snapshot.context else { return nil }
            if selectedFocus.isEmpty {
                context.selection = ""
            }
            return context
        }()
        let historySnapshot = snapshot.messages

        responseTask = Task { [weak self] in
            guard let self else { return }
            var accumulated = ""
            do {
                let stream: AsyncThrowingStream<String, Error>
                if activeProvider == .zed {
                    stream = ZedResponseService.shared.streamQuestion(
                        prompt: resolvedPrompt,
                        context: contextSnapshot,
                        history: historySnapshot,
                        selectedFocus: selectedFocus,
                        attachments: attachments
                    )
                } else {
                    stream = CodexResponseService.shared.streamQuestion(
                        prompt: resolvedPrompt,
                        context: contextSnapshot,
                        history: historySnapshot,
                        selectedFocus: selectedFocus,
                        attachments: attachments
                    )
                }

                for try await chunk in stream {
                    try Task.checkCancellation()
                    accumulated += chunk
                    let escaped = chunk
                        .replacingOccurrences(of: "\\", with: "\\\\")
                        .replacingOccurrences(of: "`", with: "\\`")
                        .replacingOccurrences(of: "$", with: "\\$")
                    await MainActor.run {
                        self.evaluateRaw("appendStreamChunk(`\(escaped)`)")
                    }
                }

                await MainActor.run {
                    self.finishResponse(
                        baseSnapshot: snapshot,
                        assistantText: accumulated,
                        status: AppText.localized(en: "Answered", zh: "已回答")
                    )
                }
            } catch is CancellationError {
                await MainActor.run {
                    self.finishResponse(
                        baseSnapshot: snapshot,
                        assistantText: accumulated,
                        status: AppText.localized(en: "Stopped", zh: "已停止")
                    )
                }
            } catch {
                await MainActor.run {
                    self.responseTask = nil
                    self.pushError(error.localizedDescription)
                }
            }
        }
    }

    private func stopCurrentResponse() {
        guard let responseTask else { return }
        responseTask.cancel()
    }

    private func startAgent(_ body: [String: Any]) {
        guard agentTask == nil else {
            pushPanelState(status: AppText.localized(en: "Agent is already running.", zh: "Agent 正在运行。"))
            return
        }

        let prompt = (body["prompt"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let attachments = parseAttachments(body["attachments"])
        let resolvedPrompt = prompt.isEmpty && !attachments.isEmpty
            ? AppText.localized(en: "Analyze the attached images and act on the current page.", zh: "请分析我附带的图片，并结合当前页面执行任务。")
            : prompt
        guard !resolvedPrompt.isEmpty else {
            pushPanelState(status: AppText.localized(en: "Enter an agent goal.", zh: "请输入 agent 目标。"))
            return
        }

        var snapshot = PanelStateStore.load()
            ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        snapshot.messages.append(
            PanelConversationMessage(
                role: "user",
                kind: "agent_goal",
                text: prompt,
                attachments: attachments.isEmpty ? nil : attachments
            )
        )
        snapshot.status = AppText.localized(en: "Agent planning", zh: "Agent 正在规划")
        snapshot.updatedAt = Date().timeIntervalSince1970
        try? PanelStateStore.save(snapshot)

        agentSessionState = buildAgentState(
            status: "planning",
            responseId: nil,
            steps: [
                buildAgentStep(
                    kind: "plan",
                    title: AppText.localized(en: "Planning", zh: "正在规划"),
                    detail: resolvedPrompt,
                    status: "running"
                )
            ],
            pendingApproval: nil,
            finalAnswer: nil,
            error: nil
        )
        pushPanelState(status: AppText.localized(en: "Agent planning", zh: "Agent 正在规划"), snapshot: snapshot)

        agentTask = Task { [weak self] in
            guard let self else { return }
            await self.runAgentLoop(prompt: resolvedPrompt, attachments: attachments, baseSnapshot: snapshot)
        }
    }

    private func cancelAgent() {
        agentTask?.cancel()
        agentTask = nil
        resolveAgentApproval(false)
        agentSessionState = buildAgentState(
            status: "canceled",
            responseId: agentSessionState?["responseId"] as? String,
            steps: (agentSessionState?["steps"] as? [[String: Any]]) ?? [],
            pendingApproval: nil,
            finalAnswer: nil,
            error: nil
        )
        pushPanelState(status: AppText.localized(en: "Agent canceled.", zh: "Agent 已取消。"))
    }

    private func resolveAgentApproval(_ approved: Bool) {
        let continuation = agentApprovalContinuation
        agentApprovalContinuation = nil
        continuation?.resume(returning: approved)
    }

    private func runAgentLoop(
        prompt: String,
        attachments: [PanelAttachment],
        baseSnapshot: PanelStateSnapshot
    ) async {
        var latestResponseId: String?
        var accumulatedSteps = (agentSessionState?["steps"] as? [[String: Any]]) ?? []
        do {
            var currentInput = [buildAgentUserInput(prompt: prompt, attachments: attachments)]
            var transcript = currentInput
            var finalAnswer = ""
            var lockedTabId = await loadInitialAgentLockedTabID()

            if let lockedTabId {
                accumulatedSteps.append(
                    buildAgentStep(
                        kind: "context",
                        title: AppText.localized(en: "Locked tab", zh: "锁定标签页"),
                        detail: "tabId=\(lockedTabId)",
                        status: "done",
                        toolName: "get_frontmost_tab",
                        tabId: lockedTabId,
                        durationMs: nil,
                        stdoutPreview: nil,
                        stderrPreview: nil
                    )
                )
            }

            for _ in 0..<12 {
                try Task.checkCancellation()

                let response = try await CodexResponseService.shared.createAgentResponse(
                    input: currentInput,
                    tools: buildAgentToolDefinitions(),
                    previousResponseId: latestResponseId,
                    fallbackInput: transcript
                )
                latestResponseId = response["id"] as? String ?? latestResponseId
                if let outputItems = response["output"] as? [[String: Any]], !outputItems.isEmpty {
                    transcript.append(contentsOf: outputItems)
                }

                let parsed = parseAgentResponse(response)
                if !parsed.steps.isEmpty {
                    accumulatedSteps.append(contentsOf: parsed.steps)
                }
                await MainActor.run {
                    self.agentSessionState = self.buildAgentState(
                        status: parsed.functionCalls.isEmpty ? "executing" : "executing",
                        responseId: latestResponseId,
                        steps: accumulatedSteps,
                        pendingApproval: nil,
                        finalAnswer: nil,
                        error: nil
                    )
                    self.pushPanelState(status: AppText.localized(en: "Agent executing", zh: "Agent 正在执行"), snapshot: baseSnapshot)
                }

                if !parsed.text.isEmpty, parsed.functionCalls.isEmpty {
                    finalAnswer = parsed.text
                    break
                }

                guard !parsed.functionCalls.isEmpty else {
                    break
                }

                var nextInput: [[String: Any]] = []
                for functionCall in parsed.functionCalls {
                    let toolName = functionCall["name"] as? String ?? ""
                    let callId = functionCall["callId"] as? String ?? ""
                    var toolArgs = functionCall["arguments"] as? [String: Any] ?? [:]
                    toolArgs = injectLockedTabIDIfNeeded(toolName: toolName, arguments: toolArgs, lockedTabId: lockedTabId)

                    let executionStatus = isScriptTool(toolName)
                        ? "running_script"
                        : "executing"
                    await MainActor.run {
                        self.agentSessionState = self.buildAgentState(
                            status: executionStatus,
                            responseId: latestResponseId,
                            steps: accumulatedSteps,
                            pendingApproval: nil,
                            finalAnswer: nil,
                            error: nil
                        )
                        self.pushPanelState(
                            status: isScriptTool(toolName)
                                ? AppText.localized(en: "Agent running script", zh: "Agent 正在执行脚本")
                                : AppText.localized(en: "Agent executing tool", zh: "Agent 正在执行工具"),
                            snapshot: baseSnapshot
                        )
                    }

                    let startedAt = Date()
                    let toolResult = try await executeAgentTool(toolName: toolName, arguments: toolArgs)
                    let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
                    if let nextLockedTabId = updatedLockedTabID(toolName: toolName, result: toolResult) {
                        lockedTabId = nextLockedTabId
                    }

                    accumulatedSteps.append(
                        buildAgentStep(
                            kind: isScriptTool(toolName) ? "script_result" : "tool_result",
                            title: toolName,
                            detail: String(describing: toolResult["humanSummary"] ?? toolName),
                            status: (toolResult["ok"] as? Bool) == false ? "failed" : "done",
                            toolName: toolName,
                            tabId: normalizedInt(from: toolArgs["tabId"]) ?? normalizedInt(from: toolResult["tabId"]) ?? normalizedInt(from: (toolResult["data"] as? [String: Any])?["tabId"]),
                            durationMs: durationMs,
                            stdoutPreview: previewText(toolResult["stdout"]),
                            stderrPreview: previewText(toolResult["stderr"])
                        )
                    )

                    let functionOutput: [String: Any] = [
                        "type": "function_call_output",
                        "call_id": callId,
                        "output": stringifyJSON(toolResult),
                    ]
                    nextInput.append(functionOutput)
                    transcript.append(functionOutput)

                    await MainActor.run {
                        self.agentSessionState = self.buildAgentState(
                            status: "executing",
                            responseId: latestResponseId,
                            steps: accumulatedSteps,
                            pendingApproval: nil,
                            finalAnswer: nil,
                            error: nil
                        )
                        self.pushPanelState(status: AppText.localized(en: "Agent executing", zh: "Agent 正在执行"), snapshot: baseSnapshot)
                    }
                }

                currentInput = nextInput
            }

            await MainActor.run {
                self.finishAgentRun(
                    baseSnapshot: baseSnapshot,
                    finalAnswer: finalAnswer,
                    responseId: latestResponseId,
                    steps: accumulatedSteps
                )
            }
        } catch is CancellationError {
            await MainActor.run {
                self.agentTask = nil
            }
        } catch {
            await MainActor.run {
                self.agentTask = nil
                self.agentSessionState = self.buildAgentState(
                    status: "failed",
                    responseId: latestResponseId,
                    steps: (self.agentSessionState?["steps"] as? [[String: Any]]) ?? [],
                    pendingApproval: nil,
                    finalAnswer: nil,
                    error: error.localizedDescription
                )
                self.pushError(error.localizedDescription)
            }
        }
    }

    private func waitForAgentApproval() async -> Bool {
        await withCheckedContinuation { continuation in
            agentApprovalContinuation = continuation
        }
    }

    private func executeAgentTool(toolName: String, arguments: [String: Any]) async throws -> [String: Any] {
        if toolName == "run_shell_command" {
            return await runAgentShellCommand(arguments: arguments)
        }
        if toolName == "run_applescript" {
            return await runAgentAppleScript(arguments: arguments)
        }

        let requestId = try AgentBridgeStore.enqueue(toolName: toolName, arguments: arguments)
        let start = Date()
        while Date().timeIntervalSince(start) < 20 {
            if let response = AgentBridgeStore.loadResponse(requestId: requestId),
               let result = response["result"] as? [String: Any] {
                AgentBridgeStore.clearResponse()
                return result
            }
            try await Task.sleep(nanoseconds: 150_000_000)
        }

        return [
            "ok": false,
            "errorCode": "tool_timeout",
            "humanSummary": AppText.localized(en: "Tool execution timed out.", zh: "工具执行超时。")
        ]
    }

    private func loadInitialAgentLockedTabID() async -> Int? {
        guard
            let result = try? await executeAgentTool(toolName: "get_frontmost_tab", arguments: [:]),
            let data = result["data"] as? [String: Any],
            let tab = data["tab"] as? [String: Any]
        else {
            return nil
        }
        return normalizedInt(from: tab["tabId"])
    }

    private func injectLockedTabIDIfNeeded(
        toolName: String,
        arguments: [String: Any],
        lockedTabId: Int?
    ) -> [String: Any] {
        guard isPageBoundTool(toolName), arguments["tabId"] == nil, let lockedTabId else {
            return arguments
        }

        var next = arguments
        next["tabId"] = lockedTabId
        return next
    }

    private func isPageBoundTool(_ toolName: String) -> Bool {
        switch toolName {
        case "get_page_context",
             "list_interactive_targets",
             "highlight_target",
             "focus_target",
             "scroll_to_target",
             "click_target",
             "read_target",
             "fill_target",
             "navigate_page",
             "extract_structured_data":
            return true
        default:
            return false
        }
    }

    private func isScriptTool(_ toolName: String) -> Bool {
        toolName == "run_shell_command" || toolName == "run_applescript"
    }

    private func updatedLockedTabID(toolName: String, result: [String: Any]) -> Int? {
        switch toolName {
        case "get_frontmost_tab":
            if let data = result["data"] as? [String: Any],
               let tab = data["tab"] as? [String: Any] {
                return normalizedInt(from: tab["tabId"])
            }
            return nil
        case "activate_tab", "open_tab", "navigate_tab":
            return normalizedInt(from: result["tabId"])
                ?? normalizedInt(from: (result["data"] as? [String: Any])?["tabId"])
        default:
            return nil
        }
    }

    private func normalizedInt(from value: Any?) -> Int? {
        if let intValue = value as? Int {
            return intValue
        }
        if let number = value as? NSNumber {
            return number.intValue
        }
        if let stringValue = value as? String,
           let parsed = Int(stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) {
            return parsed
        }
        return nil
    }

    private func previewText(_ value: Any?) -> String? {
        let normalized = String(describing: value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized != "nil" else {
            return nil
        }
        return String(normalized.prefix(280))
    }

    private func runAgentShellCommand(arguments: [String: Any]) async -> [String: Any] {
        let command = String(describing: arguments["command"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            return [
                "ok": false,
                "errorCode": "missing_command",
                "humanSummary": AppText.localized(en: "Shell command is required.", zh: "缺少 shell 命令。"),
            ]
        }

        let cwd = (arguments["cwd"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let timeoutMs = boundedTimeout(arguments["timeoutMs"], defaultValue: 15_000, maximum: 60_000)
        return await runHostProcess(
            executableURL: URL(fileURLWithPath: "/bin/zsh"),
            arguments: ["-lc", command],
            cwd: cwd,
            timeoutMs: timeoutMs,
            successSummary: AppText.localized(en: "Shell command completed.", zh: "Shell 命令执行完成。"),
            failurePrefix: AppText.localized(en: "Shell command failed", zh: "Shell 命令执行失败"),
            timeoutSummary: AppText.localized(en: "Shell command timed out.", zh: "Shell 命令执行超时。")
        )
    }

    private func runAgentAppleScript(arguments: [String: Any]) async -> [String: Any] {
        let script = String(describing: arguments["script"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !script.isEmpty else {
            return [
                "ok": false,
                "errorCode": "missing_script",
                "humanSummary": AppText.localized(en: "AppleScript text is required.", zh: "缺少 AppleScript 脚本文本。"),
            ]
        }

        let language = (arguments["language"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? "applescript"
        let timeoutMs = boundedTimeout(arguments["timeoutMs"], defaultValue: 20_000, maximum: 60_000)
        var processArguments: [String] = []
        if language == "javascript" {
            processArguments += ["-l", "JavaScript"]
        }
        processArguments += ["-e", script]

        return await runHostProcess(
            executableURL: URL(fileURLWithPath: "/usr/bin/osascript"),
            arguments: processArguments,
            cwd: nil,
            timeoutMs: timeoutMs,
            successSummary: AppText.localized(en: "AppleScript completed.", zh: "AppleScript 执行完成。"),
            failurePrefix: AppText.localized(en: "AppleScript failed", zh: "AppleScript 执行失败"),
            timeoutSummary: AppText.localized(en: "AppleScript timed out.", zh: "AppleScript 执行超时。")
        )
    }

    private func boundedTimeout(_ value: Any?, defaultValue: Int, maximum: Int) -> Int {
        let requested = normalizedInt(from: value) ?? defaultValue
        return min(max(requested, 1000), maximum)
    }

    private func runHostProcess(
        executableURL: URL,
        arguments: [String],
        cwd: String?,
        timeoutMs: Int,
        successSummary: String,
        failurePrefix: String,
        timeoutSummary: String
    ) async -> [String: Any] {
        if let cwd, !cwd.isEmpty {
            guard cwd.hasPrefix("/") else {
                return [
                    "ok": false,
                    "errorCode": "invalid_cwd",
                    "humanSummary": AppText.localized(en: "cwd must be an absolute path.", zh: "cwd 必须是绝对路径。"),
                ]
            }
        }

        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                let stdoutPipe = Pipe()
                let stderrPipe = Pipe()
                process.executableURL = executableURL
                process.arguments = arguments
                process.standardOutput = stdoutPipe
                process.standardError = stderrPipe
                if let cwd, !cwd.isEmpty {
                    process.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
                }

                let startedAt = Date()
                do {
                    try process.run()
                } catch {
                    continuation.resume(returning: [
                        "ok": false,
                        "errorCode": "process_start_failed",
                        "humanSummary": error.localizedDescription,
                        "stdout": "",
                        "stderr": error.localizedDescription,
                        "exitCode": -1,
                        "durationMs": 0,
                        "truncated": false,
                    ])
                    return
                }

                let deadline = startedAt.addingTimeInterval(Double(timeoutMs) / 1000.0)
                var timedOut = false
                while process.isRunning {
                    if Date() >= deadline {
                        timedOut = true
                        process.terminate()
                        break
                    }
                    usleep(50_000)
                }
                if process.isRunning {
                    process.waitUntilExit()
                }

                let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                let stdout = self.truncatedProcessOutput(stdoutData)
                let stderr = self.truncatedProcessOutput(stderrData)
                let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
                let exitCode = timedOut ? -9 : Int(process.terminationStatus)
                let ok = !timedOut && exitCode == 0
                let summary: String
                if timedOut {
                    summary = timeoutSummary
                } else if ok {
                    summary = successSummary
                } else {
                    summary = "\(failurePrefix) (\(exitCode))."
                }

                continuation.resume(returning: [
                    "ok": ok,
                    "errorCode": ok ? "" : (timedOut ? "process_timeout" : "process_failed"),
                    "humanSummary": summary,
                    "stdout": stdout.text,
                    "stderr": stderr.text,
                    "exitCode": exitCode,
                    "durationMs": durationMs,
                    "truncated": stdout.truncated || stderr.truncated,
                ])
            }
        }
    }

    private func truncatedProcessOutput(_ data: Data) -> (text: String, truncated: Bool) {
        let maxBytes = 32 * 1024
        let truncated = data.count > maxBytes
        let slice = truncated ? data.prefix(maxBytes) : data[...]
        let text = String(data: Data(slice), encoding: .utf8) ?? ""
        return (text, truncated)
    }

    private func finishAgentRun(
        baseSnapshot: PanelStateSnapshot,
        finalAnswer: String,
        responseId: String?,
        steps: [[String: Any]]
    ) {
        agentTask = nil
        var snapshot = PanelStateStore.load() ?? baseSnapshot
        if !finalAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            snapshot.messages.append(PanelConversationMessage(role: "assistant", kind: "agent_answer", text: finalAnswer))
            if let synced = try? ChatHistoryStore.syncSnapshot(snapshot) {
                snapshot = synced
            }
            try? PanelStateStore.save(snapshot)
        }
        agentSessionState = buildAgentState(
            status: "done",
            responseId: responseId,
            steps: steps,
            pendingApproval: nil,
            finalAnswer: finalAnswer,
            error: nil
        )
        pushPanelState(status: AppText.localized(en: "Agent finished.", zh: "Agent 已完成。"), snapshot: snapshot)
    }

    private func refreshPanelContext() {
        pushPanelState(status: AppText.localized(en: "Refreshing page…", zh: "正在刷新页面…"))
        Task {
            if let latest = await SafariContextRefresher.loadFrontmostPage() {
                var snapshot = PanelStateStore.load()
                    ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
                let currentContext = snapshot.context
                snapshot.context = PanelContextSnapshot(
                    site: currentContext?.site ?? "unsupported",
                    url: latest.url,
                    title: latest.title,
                    selection: currentContext?.selection ?? "",
                    articleText: currentContext?.articleText ?? latest.title,
                    structureSummary: currentContext?.structureSummary,
                    interactiveSummary: currentContext?.interactiveSummary,
                    metadata: currentContext?.metadata ?? [:],
                    visualSummary: currentContext?.visualSummary
                )
                snapshot.status = AppText.localized(en: "Page refreshed", zh: "页面已刷新")
                snapshot.updatedAt = Date().timeIntervalSince1970
                try? PanelStateStore.save(snapshot)
            }
        }

        SFSafariApplication.dispatchMessage(
            withName: "refresh-active-page",
            toExtensionWithIdentifier: extensionBundleIdentifier,
            userInfo: nil
        ) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                self?.pushPanelState(status: AppText.localized(en: "Page refreshed", zh: "页面已刷新"))
            }
        }
    }

    private func pushPanelState(
        status: String? = nil,
        configuration: CodexAccountConfiguration? = nil,
        snapshot: PanelStateSnapshot? = nil
    ) {
        let baseSnapshot = snapshot ?? PanelStateStore.load()
        let snapshot = ensureHistorySnapshot(baseSnapshot)
        let codexConfig = configuration ?? CodexAccountStore.load()
        let zedConfig = ZedAccountStore.load()
        let isLoggedIn = codexConfig != nil || zedConfig != nil
        let activeProvider = resolvedActiveProvider(codexConfig: codexConfig, zedConfig: zedConfig)
        let bothLoggedIn = codexConfig != nil && zedConfig != nil
        let historyThreads = ChatHistoryStore.listThreads()
        let historyStorageState = ChatHistoryStore.storageState()
        let selectionIntent = PanelStateStore.loadSelectionIntent(matchingURL: snapshot?.context?.url)
        let debugSelection = buildSelectionDebug(
            snapshotSelection: snapshot?.context?.selection,
            snapshotDebug: snapshot?.context?.debugSelection,
            selectionIntent: selectionIntent?.selection
        )

        if isLoggedIn, activeProvider != ProviderSettingsStore.loadActiveProvider() {
            try? ProviderSettingsStore.saveActiveProvider(activeProvider)
        }

        let availableModels = buildAvailableModels(
            codexConfig: codexConfig,
            zedConfig: zedConfig,
            showSource: bothLoggedIn
        )

        let selectedModel: String
        switch activeProvider {
        case .zed:
            selectedModel = modelOptionID(provider: .zed, modelID: zedConfig?.model.selected ?? "")
        case .codex:
            selectedModel = modelOptionID(provider: .codex, modelID: codexConfig?.model.selected ?? "")
        }

        let email: Any = activeProvider == .zed
            ? jsonValue(zedConfig?.account.name)
            : jsonValue(codexConfig?.account.email)

        let drawerState: [String: Any] = [
            "codexEmail": jsonValue(codexConfig?.account.email),
            "codexLoggedIn": codexConfig != nil,
            "zedName": jsonValue(zedConfig?.account.name),
            "zedLoggedIn": zedConfig != nil,
            "activeProvider": activeProvider.rawValue,
            "language": loadLanguage(),
            "placementMode": loadPlacementMode().rawValue,
            "theme": loadTheme(),
            "showPageInfo": loadShowPageInfo(),
            "followSafariWindow": loadFollowSafariWindow(),
            "followPageColor": loadFollowPageColor(),
            "historyStoragePath": historyStorageState.displayPath,
            "historyStorageStatus": historyStorageState.status,
            "historyStorageUsesDefault": historyStorageState.usesDefault,
            "customSystemPrompt": loadCustomSystemPrompt(),
            "settingsStatus": jsonValue(status ?? snapshot?.status)
        ]

        let settingsPayload: [String: Any] = [
            "isLoggedIn": isLoggedIn,
            "email": email,
            "selectedModel": selectedModel,
            "availableModels": availableModels,
            "activeProvider": activeProvider.rawValue,
            "language": loadLanguage(),
            "showPageInfo": loadShowPageInfo(),
            "historyStoragePath": historyStorageState.displayPath,
            "historyStorageStatus": historyStorageState.status,
            "drawerState": drawerState
        ]

        let payload: [String: Any] = [
            "settings": settingsPayload,
            "agent": agentSessionState ?? NSNull(),
            "currentThreadId": jsonValue(snapshot?.currentThreadId),
            "historyThreads": historyThreads.map {
                [
                    "id": $0.id,
                    "title": $0.title,
                    "isPinned": $0.isPinned,
                    "createdAt": $0.createdAt,
                    "updatedAt": $0.updatedAt,
                    "sourcePageURL": $0.sourcePageURL,
                    "sourcePageTitle": $0.sourcePageTitle,
                    "messageCount": $0.messageCount
                ]
            },
            "historyStoragePath": historyStorageState.displayPath,
            "historyStorageStatus": historyStorageState.status,
            "context": [
                "url": jsonValue(snapshot?.context?.url),
                "title": jsonValue(snapshot?.context?.title),
                "selection": jsonValue(snapshot?.context?.selection),
                "selectionFocusText": jsonValue(selectionIntent?.selection),
                "selectionDebug": debugSelection,
                "metadata": snapshot?.context?.metadata ?? [:],
                "updatedAt": jsonValue(snapshot?.updatedAt)
            ],
            "messages": snapshot?.messages.map {
                [
                    "role": $0.role,
                    "kind": $0.kind,
                    "text": $0.text,
                    "attachments": $0.attachments?.map {
                        [
                            "id": $0.id,
                            "kind": $0.kind,
                            "filename": $0.filename,
                            "mimeType": $0.mimeType,
                            "dataURL": $0.dataURL,
                            "width": jsonValue($0.width),
                            "height": jsonValue($0.height)
                        ]
                    } ?? []
                ]
            } ?? [],
            "status": jsonValue(status ?? snapshot?.status),
            "updatedAt": jsonValue(snapshot?.updatedAt),
            "isStreaming": responseTask != nil
        ]

        evaluate(function: "renderPanelState", payload: payload)
    }

    @objc private func handleAssistantPanelRefresh() {
        pushPanelState()
    }

    private func finishResponse(
        baseSnapshot: PanelStateSnapshot,
        assistantText: String?,
        status: String
    ) {
        var next = PanelStateStore.load() ?? baseSnapshot
        if let assistantText,
           !assistantText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            next.messages.append(PanelConversationMessage(role: "assistant", kind: "answer", text: assistantText))
        }
        next.status = status
        next.updatedAt = Date().timeIntervalSince1970
        let shouldPersistHistory = next.currentThreadId != nil || !(assistantText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        if shouldPersistHistory, let synced = try? ChatHistoryStore.syncSnapshot(next) {
            next = synced
        }
        try? PanelStateStore.save(next)
        evaluateRaw("finalizeStreamMessage()")
        responseTask = nil
        pushPanelState(status: status, snapshot: next)
    }

    private func pushError(_ message: String) {
        var snapshot = PanelStateStore.load()
            ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        snapshot.messages.append(PanelConversationMessage(role: "error", kind: "error", text: message))
        snapshot.status = nil
        snapshot.updatedAt = Date().timeIntervalSince1970
        if snapshot.currentThreadId != nil, let synced = try? ChatHistoryStore.syncSnapshot(snapshot) {
            snapshot = synced
        }
        try? PanelStateStore.save(snapshot)
        pushPanelState()
    }

    private func createThread() {
        if responseTask != nil {
            stopCurrentResponse()
        }

        let current = PanelStateStore.load()
            ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        let snapshot = PanelStateSnapshot(
            context: current.context,
            currentThreadId: nil,
            messages: [],
            status: nil,
            updatedAt: Date().timeIntervalSince1970
        )
        try? PanelStateStore.save(snapshot)
        pushPanelState(status: AppText.localized(en: "New chat created.", zh: "已创建新对话。"), snapshot: snapshot)
    }

    private func loadThread(_ threadID: String) {
        guard let record = ChatHistoryStore.loadThread(id: threadID) else {
            pushError(AppText.localized(en: "Chat record not found.", zh: "未找到对应的聊天记录。"))
            return
        }

        let current = PanelStateStore.load()
            ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        let snapshot = PanelStateSnapshot(
            context: current.context,
            currentThreadId: record.id,
            messages: record.messages,
            status: AppText.localized(en: "Chat history loaded", zh: "已载入聊天记录"),
            updatedAt: Date().timeIntervalSince1970
        )
        try? PanelStateStore.save(snapshot)
        pushPanelState(status: AppText.localized(en: "Chat history loaded.", zh: "已载入聊天记录。"), snapshot: snapshot)
    }

    private func renameThread(_ threadID: String, title: String?) {
        let normalizedTitle = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try ChatHistoryStore.renameThread(id: threadID, title: normalizedTitle)
            pushPanelState(status: AppText.localized(en: "Chat renamed.", zh: "聊天记录已重命名。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func togglePinnedThread(_ threadID: String, isPinned: Bool?) {
        do {
            try ChatHistoryStore.setPinned(id: threadID, isPinned: isPinned ?? false)
            pushPanelState(status: (isPinned ?? false) ? AppText.localized(en: "Chat pinned.", zh: "已置顶聊天记录。") : AppText.localized(en: "Chat unpinned.", zh: "已取消置顶。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func deleteThread(_ threadID: String) {
        do {
            try ChatHistoryStore.deleteThread(id: threadID)
            var snapshot = PanelStateStore.load()
                ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
            if snapshot.currentThreadId == threadID {
                snapshot.currentThreadId = nil
                snapshot.messages = []
                snapshot.status = nil
                snapshot.updatedAt = Date().timeIntervalSince1970
                try? PanelStateStore.save(snapshot)
            }
            pushPanelState(status: AppText.localized(en: "Chat deleted.", zh: "聊天记录已删除。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func changeHistoryStorageLocation() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = AppText.localized(en: "Choose", zh: "选择")
        panel.message = AppText.localized(en: "Choose a chat history storage location", zh: "选择聊天记录存储位置")

        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }

        do {
            _ = try ChatHistoryStore.updateStorageLocation(to: url)
            pushPanelState(status: AppText.localized(en: "Chat history location updated.", zh: "聊天记录位置已更新。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func resetHistoryStorageLocation() {
        do {
            _ = try ChatHistoryStore.resetStorageLocationToDefault()
            pushPanelState(status: AppText.localized(en: "Default chat history location restored.", zh: "已恢复默认聊天记录位置。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func importHistoryLibrary() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = AppText.localized(en: "Import", zh: "导入")
        panel.message = AppText.localized(en: "Choose a chat history folder to import", zh: "选择要导入的聊天记录目录")

        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }

        do {
            try ChatHistoryStore.importLibrary(from: url)
            pushPanelState(status: AppText.localized(en: "Chat history imported.", zh: "聊天记录已导入。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func exportHistoryLibrary() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = AppText.localized(en: "Export", zh: "导出")
        panel.message = AppText.localized(en: "Choose an export folder", zh: "选择导出目录")

        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }

        do {
            try ChatHistoryStore.exportLibrary(to: url)
            pushPanelState(status: AppText.localized(en: "Chat history exported.", zh: "聊天记录已导出。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func ensureHistorySnapshot(_ snapshot: PanelStateSnapshot?) -> PanelStateSnapshot? {
        guard var snapshot else {
            return nil
        }

        guard snapshot.currentThreadId != nil else {
            return snapshot
        }

        if let synced = try? ChatHistoryStore.syncSnapshot(snapshot), synced.currentThreadId != snapshot.currentThreadId {
            snapshot = synced
            try? PanelStateStore.save(snapshot)
        }

        return snapshot
    }

    private func saveUISettings(reasoningEffort: String) throws {
        var payload = normalizedUISettings(loadUISettings())
        payload["reasoning_effort"] = ["low", "medium", "high"].contains(reasoningEffort) ? reasoningEffort : "medium"
        try writeUISettings(payload)
    }

    func savePlacementMode(_ rawValue: String) throws {
        var payload = normalizedUISettings(loadUISettings())
        payload["placement_mode"] = ["left", "right", "remember"].contains(rawValue) ? rawValue : "remember"
        try writeUISettings(payload)

        if let window = view.window {
            UserDefaults.standard.removeObject(forKey: "NSWindow Frame MainChatWindow")
            WindowPlacementCoordinator.restoreOrSnap(
                window,
                autosaveName: "MainChatWindow",
                placementMode: loadPlacementMode(),
                animated: true
            )
            safariWindowFollower?.refreshMode()
        }
    }

    private func saveTheme(_ rawValue: String) throws {
        var payload = normalizedUISettings(loadUISettings())
        payload["theme"] = normalizedTheme(rawValue)
        try writeUISettings(payload)
    }

    private func saveLanguage(_ rawValue: String) throws {
        var payload = normalizedUISettings(loadUISettings())
        payload["language"] = normalizedLanguage(rawValue)
        try writeUISettings(payload)
    }

    private func savePanelVisibilitySettings(showPageInfo: Bool?) throws {
        var payload = normalizedUISettings(loadUISettings())
        if let showPageInfo {
            payload["show_page_info"] = showPageInfo
        }
        try writeUISettings(payload)
    }

    private func saveCustomSystemPrompt(_ rawValue: String?) throws {
        var payload = normalizedUISettings(loadUISettings())
        payload["custom_system_prompt"] = normalizeCustomSystemPrompt(rawValue)
        try writeUISettings(payload)
    }

    private func saveFollowSafariWindowSetting(_ rawValue: Bool?) throws {
        var payload = normalizedUISettings(loadUISettings())
        payload["follow_safari_window"] = rawValue ?? true
        try writeUISettings(payload)
    }

    private func saveFollowPageColorSetting(_ rawValue: Bool?) throws {
        var payload = normalizedUISettings(loadUISettings())
        payload["follow_page_color"] = rawValue ?? true
        try writeUISettings(payload)
    }

    private func resetCustomSystemPrompt() throws {
        try saveCustomSystemPrompt("")
    }

    private func loadUISettings() -> [String: Any] {
        let url = uiSettingsURL()
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return [:]
        }
        return payload
    }

    private func uiSettingsURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent("ui-settings.json")
    }

    func loadPlacementMode() -> WindowPlacementCoordinator.PlacementMode {
        let rawValue = normalizedUISettings(loadUISettings())["placement_mode"] as? String ?? "remember"
        return WindowPlacementCoordinator.PlacementMode(rawValue: rawValue) ?? .remember
    }

    private func loadTheme() -> String {
        normalizedUISettings(loadUISettings())["theme"] as? String ?? "blue"
    }

    private func loadLanguage() -> String {
        normalizedUISettings(loadUISettings())["language"] as? String ?? AppLanguage.default.rawValue
    }

    private func loadShowPageInfo() -> Bool {
        normalizedUISettings(loadUISettings())["show_page_info"] as? Bool ?? true
    }

    private func loadCustomSystemPrompt() -> String {
        normalizedUISettings(loadUISettings())["custom_system_prompt"] as? String ?? ""
    }

    private func loadFollowSafariWindow() -> Bool {
        normalizedUISettings(loadUISettings())["follow_safari_window"] as? Bool ?? true
    }

    private func loadFollowPageColor() -> Bool {
        normalizedUISettings(loadUISettings())["follow_page_color"] as? Bool ?? true
    }

    private func resolvedActiveProvider(
        codexConfig: CodexAccountConfiguration? = CodexAccountStore.load(),
        zedConfig: ZedAccountConfiguration? = ZedAccountStore.load()
    ) -> ActiveProvider {
        let storedProvider = ProviderSettingsStore.loadActiveProvider()

        switch storedProvider {
        case .codex where codexConfig != nil:
            return .codex
        case .zed where zedConfig != nil:
            return .zed
        default:
            if zedConfig != nil, codexConfig == nil {
                return .zed
            }
            return .codex
        }
    }

    private func buildAvailableModels(
        codexConfig: CodexAccountConfiguration?,
        zedConfig: ZedAccountConfiguration?,
        showSource: Bool
    ) -> [[String: Any]] {
        var models: [[String: Any]] = []

        if let zedConfig {
            models += zedConfig.model.available.map { model in
                [
                    "id": modelOptionID(provider: .zed, modelID: model.id),
                    "label": showSource ? "\(model.label) from zed" : model.label,
                    "displayLabel": model.label
                ]
            }
        }

        if let codexConfig {
            models += codexConfig.model.available.map { model in
                [
                    "id": modelOptionID(provider: .codex, modelID: model.id),
                    "label": showSource ? "\(model.label) from codex" : model.label,
                    "displayLabel": model.label
                ]
            }
        }

        if models.isEmpty {
            return [[
                "id": modelOptionID(provider: .codex, modelID: "gpt-5.4-mini"),
                "label": "gpt-5.4-mini",
                "displayLabel": "gpt-5.4-mini"
            ]]
        }

        return models
    }

    private func modelOptionID(provider: ActiveProvider, modelID: String) -> String {
        "\(provider.rawValue)::\(modelID)"
    }

    private func parseModelSelection(_ value: String, fallback: ActiveProvider) -> (provider: ActiveProvider, modelID: String) {
        let parts = value.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        if parts.count >= 3,
           let provider = ActiveProvider(rawValue: String(parts[0])) {
            return (provider, parts[2...].joined(separator: ":"))
        }
        return (fallback, value)
    }

    private func jsonValue(_ value: Any?) -> Any {
        value ?? NSNull()
    }

    private func normalizedTheme(_ rawValue: String?) -> String {
        let fallback = "blue"
        guard let rawValue else { return fallback }
        return ["blue", "orange", "gray", "purple", "green"].contains(rawValue) ? rawValue : fallback
    }

    private func normalizedLanguage(_ rawValue: String?) -> String {
        guard let rawValue, ["en", "zh"].contains(rawValue) else {
            return AppLanguage.default.rawValue
        }
        return rawValue
    }

    private func normalizeCustomSystemPrompt(_ rawValue: String?) -> String {
        String(rawValue ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(4000)
            .description
    }

    private func normalizedUISettings(_ payload: [String: Any]) -> [String: Any] {
        [
            "reasoning_effort": ["low", "medium", "high"].contains(payload["reasoning_effort"] as? String ?? "")
                ? (payload["reasoning_effort"] as? String ?? "medium")
                : "medium",
            "placement_mode": ["left", "right", "remember"].contains(payload["placement_mode"] as? String ?? "")
                ? (payload["placement_mode"] as? String ?? "remember")
                : "remember",
            "language": normalizedLanguage(payload["language"] as? String),
            "theme": normalizedTheme(payload["theme"] as? String),
            "show_page_info": payload["show_page_info"] as? Bool ?? true,
            "follow_safari_window": payload["follow_safari_window"] as? Bool ?? true,
            "follow_page_color": payload["follow_page_color"] as? Bool ?? true,
            "history_storage_path": payload["history_storage_path"] as? String ?? "",
            "history_storage_bookmark": payload["history_storage_bookmark"] as? String ?? "",
            "history_storage_uses_default": payload["history_storage_uses_default"] as? Bool ?? true,
            "custom_system_prompt": normalizeCustomSystemPrompt(payload["custom_system_prompt"] as? String)
        ]
    }

    private func writeUISettings(_ payload: [String: Any]) throws {
        let url = uiSettingsURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(
            withJSONObject: normalizedUISettings(payload),
            options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: url, options: .atomic)
    }

    private func evaluate(function: String, payload: [String: Any]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else {
            return
        }

        webView.evaluateJavaScript("\(function)(\(json))")
    }

    private func evaluateRaw(_ js: String) {
        webView.evaluateJavaScript(js)
    }

    private func startPanelRefreshTimer() {
        panelRefreshTimer?.invalidate()
        panelRefreshTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pushPanelState()
        }
    }

    private func buildSelectionDebug(
        snapshotSelection: String?,
        snapshotDebug: [String: String]?,
        selectionIntent: String?
    ) -> [String: Any] {
        [
            "snapshotSelection": jsonValue(snapshotSelection),
            "selectionIntent": jsonValue(selectionIntent),
            "contentLiveSelection": jsonValue(snapshotDebug?["contentLiveSelection"]),
            "contentStableSelection": jsonValue(snapshotDebug?["contentStableSelection"]),
            "backgroundPreviousSelection": jsonValue(snapshotDebug?["backgroundPreviousSelection"]),
            "backgroundMergedSelection": jsonValue(snapshotDebug?["backgroundMergedSelection"]),
            "backgroundSelectionMessage": jsonValue(snapshotDebug?["backgroundSelectionMessage"]),
            "backgroundSource": jsonValue(snapshotDebug?["backgroundSource"]),
        ]
    }

    private func parseAttachments(_ rawValue: Any?) -> [PanelAttachment] {
        guard let rawValue else {
            return []
        }
        guard JSONSerialization.isValidJSONObject(rawValue),
              let data = try? JSONSerialization.data(withJSONObject: rawValue),
              let attachments = try? JSONDecoder().decode([PanelAttachment].self, from: data) else {
            return []
        }
        return attachments.filter { attachment in
            attachment.kind == "image"
                && attachment.mimeType.hasPrefix("image/")
                && attachment.dataURL.hasPrefix("data:\(attachment.mimeType);base64,")
        }
    }

    private func buildAgentUserInput(prompt: String, attachments: [PanelAttachment]) -> [String: Any] {
        var content: [[String: Any]] = [["type": "input_text", "text": prompt]]
        content += attachments.compactMap { attachment in
            guard attachment.kind == "image", attachment.mimeType.hasPrefix("image/") else {
                return nil
            }
            return [
                "type": "input_image",
                "image_url": attachment.dataURL
            ]
        }

        return [
            "type": "message",
            "role": "user",
            "content": content
        ]
    }

    private func buildAgentToolDefinitions() -> [[String: Any]] {
        let noArgSchema: [String: Any] = [
            "type": "object",
            "properties": [:],
            "required": [],
            "additionalProperties": false
        ]
        let pageTabProperty: [String: Any] = [
            "type": "integer",
            "description": "Browser tab id. If omitted, use the agent's locked tab."
        ]
        let targetSchema: [String: Any] = [
            "type": "object",
            "properties": [
                "tabId": pageTabProperty,
                "targetId": ["type": "string", "description": "Interactive target id from list_interactive_targets"]
            ],
            "required": ["targetId"],
            "additionalProperties": false
        ]
        let pageOnlySchema: [String: Any] = [
            "type": "object",
            "properties": [
                "tabId": pageTabProperty
            ],
            "additionalProperties": false
        ]
        return [
            buildAgentTool(name: "list_safari_windows_tabs", description: "List all Safari windows and tabs with browser tab ids.", parameters: noArgSchema),
            buildAgentTool(name: "get_frontmost_tab", description: "Get the frontmost active Safari tab.", parameters: noArgSchema),
            buildAgentTool(
                name: "activate_tab",
                description: "Activate a Safari tab by tab id.",
                parameters: [
                    "type": "object",
                    "properties": [
                        "tabId": ["type": "integer"],
                        "windowId": ["type": "integer"]
                    ],
                    "required": ["tabId"],
                    "additionalProperties": false
                ]
            ),
            buildAgentTool(
                name: "open_tab",
                description: "Open a new Safari tab.",
                parameters: [
                    "type": "object",
                    "properties": [
                        "url": ["type": "string"],
                        "windowId": ["type": "integer"],
                        "active": ["type": "boolean"]
                    ],
                    "required": ["url"],
                    "additionalProperties": false
                ]
            ),
            buildAgentTool(
                name: "close_tab",
                description: "Close a Safari tab by tab id.",
                parameters: [
                    "type": "object",
                    "properties": [
                        "tabId": ["type": "integer"]
                    ],
                    "required": ["tabId"],
                    "additionalProperties": false
                ]
            ),
            buildAgentTool(
                name: "navigate_tab",
                description: "Navigate a Safari tab to a new URL.",
                parameters: [
                    "type": "object",
                    "properties": [
                        "tabId": ["type": "integer"],
                        "url": ["type": "string"],
                        "active": ["type": "boolean"]
                    ],
                    "required": ["tabId", "url"],
                    "additionalProperties": false
                ]
            ),
            buildAgentTool(name: "get_page_context", description: "Get the latest page context for a Safari page.", parameters: pageOnlySchema),
            buildAgentTool(name: "list_interactive_targets", description: "List interactive targets on a Safari page.", parameters: pageOnlySchema),
            buildAgentTool(name: "highlight_target", description: "Highlight a target without causing side effects.", parameters: targetSchema),
            buildAgentTool(name: "focus_target", description: "Focus a target element.", parameters: targetSchema),
            buildAgentTool(name: "scroll_to_target", description: "Scroll the page so the target is visible.", parameters: targetSchema),
            buildAgentTool(name: "click_target", description: "Click a target element.", parameters: targetSchema),
            buildAgentTool(name: "read_target", description: "Read the visible text for a target element.", parameters: targetSchema),
            buildAgentTool(
                name: "fill_target",
                description: "Fill text into a writable target without submitting.",
                parameters: [
                    "type": "object",
                    "properties": [
                        "tabId": pageTabProperty,
                        "targetId": ["type": "string"],
                        "text": ["type": "string"]
                    ],
                    "required": ["targetId", "text"],
                    "additionalProperties": false
                ]
            ),
            buildAgentTool(
                name: "navigate_page",
                description: "Navigate the current page to a new URL.",
                parameters: [
                    "type": "object",
                    "properties": [
                        "tabId": pageTabProperty,
                        "url": ["type": "string"]
                    ],
                    "required": ["url"],
                    "additionalProperties": false
                ]
            ),
            buildAgentTool(name: "extract_structured_data", description: "Return structured data from the current page context.", parameters: pageOnlySchema),
            buildAgentTool(
                name: "run_shell_command",
                description: "Run a shell command on the host macOS machine.",
                parameters: [
                    "type": "object",
                    "properties": [
                        "command": ["type": "string"],
                        "cwd": ["type": "string"],
                        "timeoutMs": ["type": "integer"]
                    ],
                    "required": ["command"],
                    "additionalProperties": false
                ]
            ),
            buildAgentTool(
                name: "run_applescript",
                description: "Run AppleScript or JXA on the host macOS machine.",
                parameters: [
                    "type": "object",
                    "properties": [
                        "script": ["type": "string"],
                        "language": ["type": "string", "enum": ["applescript", "javascript"]],
                        "timeoutMs": ["type": "integer"]
                    ],
                    "required": ["script"],
                    "additionalProperties": false
                ]
            )
        ]
    }

    private func buildAgentTool(name: String, description: String, parameters: [String: Any]) -> [String: Any] {
        [
            "type": "function",
            "name": name,
            "description": description,
            "parameters": parameters,
            "strict": true,
        ]
    }

    private func parseAgentResponse(_ response: [String: Any]) -> (text: String, functionCalls: [[String: Any]], steps: [[String: Any]]) {
        let output = response["output"] as? [[String: Any]] ?? []
        var textParts: [String] = []
        var calls: [[String: Any]] = []
        var steps: [[String: Any]] = []

        for item in output {
            let type = item["type"] as? String ?? ""
            if type == "message",
               let content = item["content"] as? [[String: Any]] {
                let texts = content.compactMap { block -> String? in
                    let blockType = block["type"] as? String ?? ""
                    if (blockType == "output_text" || blockType == "text"), let text = block["text"] as? String {
                        return text
                    }
                    return nil
                }
                if !texts.isEmpty {
                    let joined = texts.joined(separator: "\n")
                    textParts.append(joined)
                    steps.append(buildAgentStep(kind: "answer", title: AppText.localized(en: "Draft answer", zh: "草拟回答"), detail: joined, status: "done"))
                }
            } else if type == "function_call" {
                let argumentsText = item["arguments"] as? String ?? "{}"
                let callArguments = parseJSONStringDictionary(argumentsText)
                let name = item["name"] as? String ?? ""
                let callId = item["call_id"] as? String ?? ""
                calls.append([
                    "name": name,
                    "callId": callId,
                    "arguments": callArguments
                ])
                steps.append(buildAgentStep(kind: "tool_call", title: name, detail: argumentsText, status: "pending", toolName: name))
            } else if type == "computer_call" {
                steps.append(buildAgentStep(kind: "computer_call", title: "computer_call", detail: "stub", status: "pending"))
            }
        }

        if textParts.isEmpty, let outputText = response["output_text"] as? String, !outputText.isEmpty {
            textParts.append(outputText)
        }

        return (textParts.joined(separator: "\n\n"), calls, steps)
    }

    private func parseJSONStringDictionary(_ value: String) -> [String: Any] {
        guard let data = value.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return json
    }

    private func buildAgentState(
        status: String,
        responseId: String?,
        steps: [[String: Any]],
        pendingApproval: [String: Any]?,
        finalAnswer: String?,
        error: String?
    ) -> [String: Any] {
        [
            "id": agentSessionState?["id"] as? String ?? UUID().uuidString.lowercased(),
            "model": "gpt-5.4",
            "mode": "safari_tools",
            "responseId": jsonValue(responseId),
            "status": status,
            "steps": steps,
            "pendingApproval": jsonValue(pendingApproval),
            "finalAnswer": jsonValue(finalAnswer),
            "error": jsonValue(error),
        ]
    }

    private func buildAgentStep(
        kind: String,
        title: String,
        detail: String,
        status: String,
        toolName: String? = nil,
        tabId: Int? = nil,
        durationMs: Int? = nil,
        stdoutPreview: String? = nil,
        stderrPreview: String? = nil
    ) -> [String: Any] {
        [
            "id": UUID().uuidString.lowercased(),
            "kind": kind,
            "title": title,
            "detail": detail,
            "status": status,
            "toolName": jsonValue(toolName),
            "tabId": jsonValue(tabId),
            "durationMs": jsonValue(durationMs),
            "stdoutPreview": jsonValue(stdoutPreview),
            "stderrPreview": jsonValue(stderrPreview),
            "startedAt": Date().timeIntervalSince1970,
            "completedAt": (status == "done" || status == "failed") ? Date().timeIntervalSince1970 : NSNull(),
            "toolCallId": NSNull(),
        ]
    }

    private func buildApprovalPayload(toolName: String, arguments: [String: Any], riskLevel: String) -> [String: Any] {
        [
            "toolName": toolName,
            "targetId": jsonValue(arguments["targetId"]),
            "targetLabel": jsonValue(arguments["targetId"]),
            "proposedArgs": arguments,
            "riskLevel": riskLevel,
            "previewText": approvalPreviewText(toolName: toolName, arguments: arguments),
        ]
    }

    private func approvalPreviewText(toolName: String, arguments: [String: Any]) -> String {
        switch toolName {
        case "navigate_page":
            return String(describing: arguments["url"] ?? "")
        case "fill_target":
            return String(describing: arguments["text"] ?? "")
        default:
            return String(describing: arguments["targetId"] ?? toolName)
        }
    }

    private func requiresApproval(riskLevel: String) -> Bool {
        riskLevel != "read_only"
    }

    private func riskLevelForTool(_ toolName: String) -> String {
        switch toolName {
        case "focus_target":
            return "focus"
        case "click_target":
            return "click"
        case "fill_target":
            return "write"
        case "navigate_page":
            return "navigate"
        default:
            return "read_only"
        }
    }

    private func stringifyJSON(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    private func pickAttachments() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .tiff, .bmp, .heic]
        panel.prompt = AppText.localized(en: "Choose", zh: "选择")
        panel.message = AppText.localized(en: "Choose images to attach", zh: "选择要附带的图片")

        guard panel.runModal() == .OK else {
            return
        }

        let attachments = panel.urls.compactMap { buildAttachment(from: $0) }
        guard !attachments.isEmpty else {
            pushPanelState(status: AppText.localized(en: "No valid images were selected.", zh: "没有选择可用图片。"))
            return
        }

        let payload = attachments.map { attachment in
            [
                "id": attachment.id,
                "kind": attachment.kind,
                "filename": attachment.filename,
                "mimeType": attachment.mimeType,
                "dataURL": attachment.dataURL,
                "width": jsonValue(attachment.width),
                "height": jsonValue(attachment.height)
            ]
        }
        evaluate(function: "appendPickedAttachments", payload: ["attachments": payload])
    }

    private func buildAttachment(from url: URL) -> PanelAttachment? {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            return nil
        }

        let mimeType = mimeTypeForImage(at: url)
        guard mimeType.hasPrefix("image/") else {
            return nil
        }

        let dimensions = imageDimensions(from: data)
        return PanelAttachment(
            id: UUID().uuidString.lowercased(),
            kind: "image",
            filename: url.lastPathComponent,
            mimeType: mimeType,
            dataURL: "data:\(mimeType);base64,\(data.base64EncodedString())",
            width: dimensions?.width,
            height: dimensions?.height
        )
    }

    private func mimeTypeForImage(at url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "jpg", "jpeg":
            return "image/jpeg"
        case "gif":
            return "image/gif"
        case "webp":
            return "image/webp"
        case "tif", "tiff":
            return "image/tiff"
        case "bmp":
            return "image/bmp"
        case "heic":
            return "image/heic"
        default:
            return "image/png"
        }
    }

    private func imageDimensions(from data: Data) -> (width: Int, height: Int)? {
        guard let image = NSImage(data: data) else {
            return nil
        }
        guard let representation = image.representations.first else {
            return nil
        }
        return (representation.pixelsWide, representation.pixelsHigh)
    }
}

func loadCustomSystemPromptFromUISettings() -> String {
    let url = SharedContainer.baseURL().appendingPathComponent("ui-settings.json")
    guard
        let data = try? Data(contentsOf: url),
        let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return ""
    }

    return String(payload["custom_system_prompt"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .prefix(4000)
        .description
}

func appendCustomSystemPrompt(basePrompt: String) -> String {
    let customPrompt = loadCustomSystemPromptFromUISettings()
    guard !customPrompt.isEmpty else {
        return basePrompt
    }

    return """
\(basePrompt)

用户附加系统提示:
\(customPrompt)
"""
}
