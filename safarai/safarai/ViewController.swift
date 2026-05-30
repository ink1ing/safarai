//
//  ViewController.swift
//  safarai
//
//  Created by silas on 3/13/26.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "ink.safarai.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    private var panelRefreshTimer: Timer?
    private var responseTask: Task<Void, Never>?
    private var contextRefreshTask: Task<Void, Never>?
    private var safariWindowFollower: SafariWindowFollower?
    private var safariExtensionEnabled: Bool?

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
            configureWindowChrome(window)
            WindowPlacementCoordinator.restoreOrSnap(
                window,
                autosaveName: "MainChatWindow",
                placementMode: loadPlacementMode(),
                followSafariWindow: loadFollowSafariWindow()
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

    private func configureWindowChrome(_ window: NSWindow) {
        window.styleMask.insert([.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView])
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        safariWindowFollower?.stop()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { [weak self] in
            guard let self else { return }
            let isEnabled = await self.loadSafariExtensionEnabled()
            await MainActor.run {
                self.safariExtensionEnabled = isEnabled
                self.pushPanelState(
                    status: isEnabled
                        ? AppText.localized(en: "Safari extension connected.", zh: "已连接 Safari 扩展")
                        : AppText.localized(en: "Enable the Safari extension in Safari Settings > Extensions.", zh: "请在 Safari 设置 > 扩展 中启用 Safarai。")
                )
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let command = message.body as? String {
            if command == "open-preferences" {
                openSafariExtensionPreferences()
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
        case "send-question":
            sendQuestion(body)
        case "detach-page-context":
            detachPageContext(url: body["url"] as? String)
        case "set-detached-context-url":
            saveDetachedContextURL(body["url"] as? String)
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
        case "prompt-rename-thread":
            pushPanelState()
        case "toggle-pin-thread":
            if let threadID = body["threadId"] as? String {
                togglePinnedThread(threadID, isPinned: body["isPinned"] as? Bool)
            }
        case "delete-thread":
            if let threadID = body["threadId"] as? String {
                deleteThread(threadID)
            }
        case "confirm-delete-thread":
            if let threadID = body["threadId"] as? String {
                deleteThread(threadID)
            }
        case "list-threads":
            pushPanelState()
        case "stop-response":
            stopCurrentResponse()
        case "refresh-panel-context":
            refreshPanelContext()
        case "open-safari-extension-preferences":
            openSafariExtensionPreferences()
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
        case "check-for-updates":
            checkForUpdates()
        case "save-openai-compatible-settings":
            saveOpenAICompatibleSettings(body)
        case "refresh-openai-compatible-models":
            refreshOpenAICompatibleModels()
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
                next.model.selected = preserveSelectedModel(
                    current: next.model.selected,
                    refreshedModels: models,
                    fallback: "gpt-5"
                )
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

        case .openaiCompatible:
            var settings = OpenAICompatibleSettingsStore.load()
            guard settings.availableModels.contains(where: { $0.id == selection.modelID }) else {
                pushError(AppText.localized(en: "The selected model is not available in the OpenAI-compatible provider.", zh: "所选模型在 OpenAI 兼容提供商中不存在。"))
                return
            }
            settings.selectedModel = selection.modelID
            do {
                try OpenAICompatibleSettingsStore.save(settings)
                try ProviderSettingsStore.saveActiveProvider(.openaiCompatible)
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
                config.model.selected = preserveSelectedModel(
                    current: config.model.selected,
                    refreshedModels: models,
                    fallback: "gpt-4.1"
                )
                try ZedAccountStore.save(config)
                pushPanelState(status: AppText.localized(en: "Zed models refreshed: \(models.count).", zh: "Zed 模型列表已刷新，共 \(models.count) 个。"))
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func saveOpenAICompatibleSettings(_ body: [String: Any]) {
        let endpoint = (body["endpoint"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let apiKey = (body["apiKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var settings = OpenAICompatibleSettingsStore.load()

        settings.endpoint = endpoint
        settings.apiKey = apiKey
        do {
            try OpenAICompatibleSettingsStore.save(settings)
            try ProviderSettingsStore.saveActiveProvider(.openaiCompatible)
            clearOpenAICompatibleSetupErrorState()
            pushPanelState(status: AppText.localized(en: "OpenAI-compatible provider saved.", zh: "OpenAI 兼容提供商已保存。"))
            if settings.isConfigured {
                refreshOpenAICompatibleModels()
            }
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func refreshOpenAICompatibleModels() {
        var settings = OpenAICompatibleSettingsStore.load()
        guard settings.isConfigured else {
            pushPanelState(status: AppText.localized(en: "Configure endpoint and API Key first.", zh: "请先配置端点和 API Key。"))
            return
        }

        pushPanelState(status: AppText.localized(en: "Refreshing OpenAI-compatible models…", zh: "正在刷新 OpenAI 兼容模型列表…"))
        Task {
            do {
                let models = try await OpenAICompatibleResponseService.shared.fetchModels(settings: settings)
                settings.availableModels = models
                settings.lastSyncAt = Date().timeIntervalSince1970
                settings.selectedModel = preserveSelectedModel(
                    current: settings.selectedModel,
                    refreshedModels: models,
                    fallback: OpenAICompatibleSettings.default.selectedModel
                )
                try OpenAICompatibleSettingsStore.save(settings)
                try ProviderSettingsStore.saveActiveProvider(.openaiCompatible)
                pushPanelState(status: AppText.localized(en: "OpenAI-compatible models refreshed: \(models.count).", zh: "OpenAI 兼容模型列表已刷新，共 \(models.count) 个。"))
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
            let name: String
            switch provider {
            case .zed:
                name = "Zed"
            case .codex:
                name = "Codex"
            case .openaiCompatible:
                name = "OpenAI Compatible"
            }
            pushPanelState(status: AppText.localized(en: "Switched to \(name).", zh: "已切换到 \(name)。"))
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func sendQuestion(_ body: [String: Any]) {
        guard responseTask == nil, contextRefreshTask == nil else {
            stopCurrentResponse()
            return
        }

        let prompt = (body["prompt"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let selectedFocus = (body["selectedFocus"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let taskIntent = (body["taskIntent"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let shouldDetachPageContext = body["detachPageContext"] as? Bool ?? false
        let detachedContextURL = (body["detachedContextURL"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !prompt.isEmpty else {
            pushPanelState(status: AppText.localized(en: "Enter a question.", zh: "请输入问题。"))
            return
        }

        contextRefreshTask = Task { [weak self] in
            guard let self else { return }
            let refreshedSnapshot = taskIntent == "summarize_video"
                ? await self.refreshPageContextForVideoSummary()
                : await self.refreshPageContextForQuestion()
            await MainActor.run {
                self.contextRefreshTask = nil
                self.beginQuestion(
                    prompt: prompt,
                    selectedFocus: selectedFocus,
                    taskIntent: taskIntent,
                    initialSnapshot: refreshedSnapshot,
                    detachPageContext: shouldDetachPageContext,
                    detachedContextURL: detachedContextURL
                )
            }
        }
        pushPanelState(
            status: shouldDetachPageContext
                ? AppText.localized(en: "Asking without page context…", zh: "正在不带页面上下文提问…")
                : AppText.localized(en: "Reading current Safari page…", zh: "正在读取当前 Safari 页面…")
        )
    }

    private func beginQuestion(
        prompt: String,
        selectedFocus: String,
        taskIntent: String = "",
        initialSnapshot: PanelStateSnapshot?,
        detachPageContext: Bool = false,
        detachedContextURL: String = ""
    ) {
        guard responseTask == nil else {
            stopCurrentResponse()
            return
        }

        var snapshot = initialSnapshot ?? PanelStateStore.load()
            ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        if detachPageContext,
           detachedContextURL.isEmpty || snapshot.context?.url == detachedContextURL {
            snapshot.context = nil
        }
        if snapshot.currentThreadId == nil {
            let thread = try? ChatHistoryStore.createThread(context: snapshot.context)
            snapshot.currentThreadId = thread?.id
        }
        snapshot.messages.append(PanelConversationMessage(role: "user", kind: "question", text: prompt))
        snapshot.status = AppText.localized(en: "Answering", zh: "正在回答")
        snapshot.updatedAt = Date().timeIntervalSince1970
        if let synced = try? ChatHistoryStore.syncSnapshot(snapshot) {
            snapshot = synced
        }
        try? PanelStateStore.save(snapshot)

        evaluateRaw("clearQuestionEditor()")
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
                switch activeProvider {
                case .zed:
                    stream = ZedResponseService.shared.streamQuestion(
                        prompt: prompt,
                        context: contextSnapshot,
                        history: historySnapshot,
                        selectedFocus: selectedFocus,
                        taskIntent: taskIntent
                    )
                case .openaiCompatible:
                    stream = OpenAICompatibleResponseService.shared.streamQuestion(
                        prompt: prompt,
                        context: contextSnapshot,
                        history: historySnapshot,
                        selectedFocus: selectedFocus,
                        taskIntent: taskIntent
                    )
                case .codex:
                    stream = CodexResponseService.shared.streamQuestion(
                        prompt: prompt,
                        context: contextSnapshot,
                        history: historySnapshot,
                        selectedFocus: selectedFocus,
                        taskIntent: taskIntent
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
        if let contextRefreshTask {
            contextRefreshTask.cancel()
            self.contextRefreshTask = nil
            pushPanelState(status: AppText.localized(en: "Stopped", zh: "已停止"))
            return
        }
        guard let responseTask else { return }
        responseTask.cancel()
    }

    private func detachPageContext(url: String?) {
        guard var snapshot = PanelStateStore.load() else {
            pushPanelState()
            return
        }

        let normalizedURL = url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if normalizedURL.isEmpty || snapshot.context?.url == normalizedURL {
            snapshot.context = nil
            snapshot.updatedAt = Date().timeIntervalSince1970
            try? PanelStateStore.save(snapshot)
        }
        pushPanelState(status: AppText.localized(en: "Page context detached.", zh: "已移除当前页面上下文。"), snapshot: snapshot)
    }

    private func saveDetachedContextURL(_ url: String?) {
        let normalizedURL = url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let fileURL = SharedContainer.baseURL().appendingPathComponent("detached-context-url.json")
        let payload = ["url": normalizedURL]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
            try? SharedContainer.writePrivate(data, to: fileURL)
        }
    }

    private func refreshPageContextForQuestion() async -> PanelStateSnapshot? {
        let extensionEnabled = await loadSafariExtensionEnabled()
        safariExtensionEnabled = extensionEnabled
        guard extensionEnabled else {
            pushPanelState(status: AppText.localized(en: "Enable the Safari extension in Safari Settings > Extensions.", zh: "请在 Safari 设置 > 扩展 中启用 Safarai。"))
            return PanelStateStore.load()
        }

        requestActiveSafariPageContextRefresh()

        let initialUpdatedAt = PanelStateStore.load()?.updatedAt ?? 0
        let deadline = Date().addingTimeInterval(1.6)
        var bestSnapshot = PanelStateStore.load()
        while Date() < deadline {
            if Task.isCancelled { return bestSnapshot }
            guard let snapshot = PanelStateStore.load() else {
                try? await Task.sleep(nanoseconds: 120_000_000)
                continue
            }
            bestSnapshot = snapshot
            if snapshot.updatedAt > initialUpdatedAt,
               isUsablePageContext(snapshot.context, matching: nil) {
                return snapshot
            }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }

        return bestSnapshot
    }

    private func refreshPageContextForVideoSummary() async -> PanelStateSnapshot? {
        let baseline = await refreshPageContextForQuestion()
        let context = baseline?.context
        let transcriptCount = context?.videoTranscript?.count ?? 0
        let hasVideo = context?.metadata["hasPrimaryVideo"] == "true"
            || context?.metadata["pageKind"] == "youtube_video"
            || context?.metadata["pageKind"] == "bilibili_video"
        guard hasVideo, transcriptCount < 3 else {
            return baseline
        }

        // Prefer audio ASR when the page exposed an audio stream (no usable captions).
        if let audioURL = context?.metadata["audioStreamUrl"], !audioURL.isEmpty {
            await MainActor.run {
                pushPanelState(status: AppText.localized(en: "Transcribing audio…", zh: "正在转写视频音频…"))
            }
            if let segments = await VideoTranscriptionService.transcribe(
                audioURL: audioURL,
                referer: context?.metadata["audioStreamReferer"],
                filename: context?.metadata["audioStreamFilename"] ?? "audio.mp4"
            ), !segments.isEmpty, var snapshot = baseline {
                snapshot.context?.videoTranscript = segments
                snapshot.context?.metadata["videoTranscriptSource"] = "asr_whisper"
                snapshot.context?.metadata["videoTranscriptCount"] = String(segments.count)
                snapshot.context?.metadata["hasTranscript"] = "true"
                return snapshot
            }
        }

        await MainActor.run {
            pushPanelState(status: AppText.localized(en: "Sampling video frames…", zh: "正在慢速采样视频画面…"))
        }
        requestActiveSafariVideoFrameSampling()

        let initialUpdatedAt = PanelStateStore.load()?.updatedAt ?? 0
        let deadline = Date().addingTimeInterval(14)
        var bestSnapshot = PanelStateStore.load() ?? baseline
        while Date() < deadline {
            if Task.isCancelled { return bestSnapshot }
            guard let snapshot = PanelStateStore.load() else {
                try? await Task.sleep(nanoseconds: 300_000_000)
                continue
            }
            bestSnapshot = snapshot
            if snapshot.updatedAt > initialUpdatedAt,
               let count = Int(snapshot.context?.metadata["videoFrameSampleCount"] ?? "0"),
               count > 0 {
                return snapshot
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }

        return bestSnapshot
    }

    private func requestActiveSafariPageContextRefresh() {
        SFSafariApplication.dispatchMessage(
            withName: "refresh-active-page-context",
            toExtensionWithIdentifier: extensionBundleIdentifier,
            userInfo: nil
        ) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.pushPanelState(status: error.localizedDescription)
            }
        }
    }

    private func requestActiveSafariVideoFrameSampling() {
        SFSafariApplication.dispatchMessage(
            withName: "sample-active-video-frames",
            toExtensionWithIdentifier: extensionBundleIdentifier,
            userInfo: nil
        ) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.pushPanelState(status: error.localizedDescription)
            }
        }
    }

    private func isUsablePageContext(_ context: PanelContextSnapshot?, matching url: String?) -> Bool {
        guard let context else { return false }
        if let url, !url.isEmpty, context.url != url {
            return false
        }

        let articleText = context.articleText.trimmingCharacters(in: .whitespacesAndNewlines)
        let structureSummary = (context.structureSummary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let interactiveSummary = (context.interactiveSummary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let pageKind = context.metadata["pageKind"] ?? ""
        let transport = context.metadata["pageContextTransport"] ?? ""
        let strategy = context.metadata["contentStrategy"] ?? ""

        if pageKind == "fallback_tab_context" || pageKind == "pending_dom_context" {
            return false
        }
        if transport == "fallback_tab_context" || strategy == "fallback_tab_context" {
            return false
        }
        if !structureSummary.isEmpty || !interactiveSummary.isEmpty {
            return true
        }
        if articleText.count >= 160 {
            return true
        }
        if !articleText.isEmpty,
           !articleText.hasPrefix("title: \(context.title)\nurl:") {
            return true
        }
        return false
    }

    private func loadSafariExtensionEnabled() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
                guard error == nil, let state else {
                    continuation.resume(returning: false)
                    return
                }
                continuation.resume(returning: state.isEnabled)
            }
        }
    }

    private func openSafariExtensionPreferences() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { [weak self] error in
            DispatchQueue.main.async {
                if let error {
                    self?.pushPanelState(status: error.localizedDescription)
                } else {
                    self?.pushPanelState(status: AppText.localized(en: "Enable Safarai in Safari Extensions, then allow website access.", zh: "请在 Safari 扩展中启用 Safarai，并允许网站访问权限。"))
                }
            }
        }
    }

    private func refreshPanelContext() {
        pushPanelState(status: AppText.localized(en: "Refreshing page…", zh: "正在刷新页面…"))
        Task {
            let snapshot = await refreshPageContextForQuestion()
            await MainActor.run {
                let context = snapshot?.context
                let status = isUsablePageContext(context, matching: context?.url)
                    ? AppText.localized(en: "Page content refreshed.", zh: "页面内容已刷新。")
                    : AppText.localized(en: "Only page title and URL are available.", zh: "当前仅获取到页面标题和 URL。")
                pushPanelState(status: status, snapshot: snapshot)
            }
        }
    }

    private func checkForUpdates() {
        pushPanelState(status: AppText.localized(en: "Checking for updates…", zh: "正在检查更新…"))
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await AppUpdateService.checkForUpdates()
                await MainActor.run {
                    self.presentUpdateResult(result)
                }
            } catch {
                await MainActor.run {
                    self.pushError(error.localizedDescription)
                }
            }
        }
    }

    private func presentUpdateResult(_ result: AppUpdateCheckResult) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = result.hasUpdate
            ? AppText.localized(en: "A new Safarai version is available", zh: "发现 Safarai 新版本")
            : AppText.localized(en: "Safarai is up to date", zh: "Safarai 已是最新版本")

        if result.hasUpdate {
            let notes = result.releaseNotes.trimmingCharacters(in: .whitespacesAndNewlines)
            let preview = notes.isEmpty ? "" : "\n\n\(String(notes.prefix(800)))"
            alert.informativeText = AppText.localized(
                en: "Current version: \(result.currentVersion)\nLatest version: \(result.latestVersion)\nRelease: \(result.releaseName)\(preview)",
                zh: "当前版本：\(result.currentVersion)\n最新版本：\(result.latestVersion)\nRelease：\(result.releaseName)\(preview)"
            )
        } else {
            alert.informativeText = AppText.localized(
                en: "Current version \(result.currentVersion) is not older than the latest GitHub Release (\(result.latestVersion)).",
                zh: "当前版本 \(result.currentVersion) 不低于 GitHub Release 最新版本（\(result.latestVersion)）。"
            )
        }

        var buttonActions: [URL?] = []
        if result.hasUpdate {
            if let dmg = result.dmgAsset {
                alert.addButton(withTitle: AppText.localized(en: "Download DMG", zh: "下载 DMG"))
                buttonActions.append(dmg.downloadURL)
            }
            if let zip = result.zipAsset {
                alert.addButton(withTitle: AppText.localized(en: "Download ZIP", zh: "下载 ZIP"))
                buttonActions.append(zip.downloadURL)
            }
        }
        alert.addButton(withTitle: AppText.localized(en: "Open Release Page", zh: "打开 Release 页面"))
        buttonActions.append(result.releasePageURL)
        alert.addButton(withTitle: result.hasUpdate ? AppText.localized(en: "Later", zh: "稍后") : AppText.localized(en: "OK", zh: "好"))
        buttonActions.append(nil)

        let response = alert.runModal()
        let index = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if index >= 0, index < buttonActions.count, let url = buttonActions[index] {
            NSWorkspace.shared.open(url)
        }

        pushPanelState(
            status: result.hasUpdate
                ? AppText.localized(en: "Update check finished.", zh: "更新检查完成。")
                : AppText.localized(en: "Already up to date.", zh: "已是最新版本。")
        )
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
        let openAISettings = OpenAICompatibleSettingsStore.load()
        let openAIConfigured = openAISettings.isConfigured
        let isLoggedIn = codexConfig != nil || zedConfig != nil || openAIConfigured
        let activeProvider = resolvedActiveProvider(codexConfig: codexConfig, zedConfig: zedConfig, openAIConfigured: openAIConfigured)
        let providerCount = [codexConfig != nil, zedConfig != nil, openAIConfigured].filter { $0 }.count
        let showSource = providerCount > 1
        let historyThreads = ChatHistoryStore.listThreads()
        let historyStorageState = ChatHistoryStore.storageState()
        let visibleStatus = status ?? ((responseTask != nil || contextRefreshTask != nil) ? snapshot?.status : nil)
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
            openAISettings: openAISettings,
            showSource: showSource
        )

        let selectedModel: String
        switch activeProvider {
        case .zed:
            selectedModel = modelOptionID(provider: .zed, modelID: zedConfig?.model.selected ?? "")
        case .openaiCompatible:
            selectedModel = modelOptionID(provider: .openaiCompatible, modelID: openAISettings.selectedModel)
        case .codex:
            selectedModel = modelOptionID(provider: .codex, modelID: codexConfig?.model.selected ?? "")
        }

        let email: Any
        switch activeProvider {
        case .zed:
            email = jsonValue(zedConfig?.account.name)
        case .openaiCompatible:
            email = jsonValue(openAISettings.endpoint)
        case .codex:
            email = jsonValue(codexConfig?.account.email)
        }

        let drawerState: [String: Any] = [
            "codexEmail": jsonValue(codexConfig?.account.email),
            "codexLoggedIn": codexConfig != nil,
            "zedName": jsonValue(zedConfig?.account.name),
            "zedLoggedIn": zedConfig != nil,
            "openAICompatibleConfigured": openAIConfigured,
            "openAICompatibleEndpoint": openAISettings.endpoint,
            "openAICompatibleApiKey": openAISettings.apiKey,
            "openAICompatibleKeySaved": !openAISettings.apiKey.isEmpty,
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
            "settingsStatus": jsonValue(visibleStatus)
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
                "videoTranscript": snapshot?.context?.videoTranscript?.map(videoTranscriptPayload) ?? [],
                "metadata": snapshot?.context?.metadata ?? [:],
                "updatedAt": jsonValue(snapshot?.updatedAt)
            ],
            "messages": snapshot?.messages.map { ["role": $0.role, "kind": $0.kind, "text": $0.text] } ?? [],
            "status": jsonValue(visibleStatus),
            "updatedAt": jsonValue(snapshot?.updatedAt),
            "isStreaming": responseTask != nil,
            "isPreparingQuestion": contextRefreshTask != nil
        ]

        evaluate(function: "renderPanelState", payload: payload)
    }

    private func videoTranscriptPayload(_ segment: PanelVideoTranscriptSegment) -> [String: Any] {
        [
            "startSeconds": segment.startSeconds,
            "endSeconds": jsonValue(segment.endSeconds),
            "timestamp": segment.timestamp,
            "text": segment.text,
            "source": segment.source,
        ]
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
        if let synced = try? ChatHistoryStore.syncSnapshot(next) {
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
        if let synced = try? ChatHistoryStore.syncSnapshot(snapshot) {
            snapshot = synced
        }
        try? PanelStateStore.save(snapshot)
        pushPanelState()
    }

    private func clearOpenAICompatibleSetupErrorState() {
        guard var snapshot = PanelStateStore.load() else {
            return
        }

        let setupErrors = [
            "请同时填写端点和 API Key。",
            "Enter both endpoint and API Key.",
            "请先配置端点和 API Key。",
            "Configure endpoint and API Key first.",
            OpenAICompatibleResponseError.notConfigured.localizedDescription
        ]
        let originalCount = snapshot.messages.count
        let originalStatus = snapshot.status
        snapshot.messages.removeAll { message in
            message.role == "error" && setupErrors.contains(message.text)
        }
        if let status = snapshot.status, setupErrors.contains(status) {
            snapshot.status = nil
        }
        guard snapshot.messages.count != originalCount || snapshot.status != originalStatus else {
            return
        }

        snapshot.updatedAt = Date().timeIntervalSince1970
        if let synced = try? ChatHistoryStore.syncSnapshot(snapshot) {
            snapshot = synced
        }
        try? PanelStateStore.save(snapshot)
    }

    private func createThread() {
        if responseTask != nil {
            stopCurrentResponse()
        }

        do {
            let current = PanelStateStore.load()
                ?? PanelStateSnapshot(context: nil, currentThreadId: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
            let thread = try ChatHistoryStore.createThread(context: current.context)
            let snapshot = PanelStateSnapshot(
                context: current.context,
                currentThreadId: thread.id,
                messages: [],
                status: nil,
                updatedAt: Date().timeIntervalSince1970
            )
            try PanelStateStore.save(snapshot)
            pushPanelState(status: AppText.localized(en: "New chat created.", zh: "已创建新对话。"), snapshot: snapshot)
        } catch {
            pushError(error.localizedDescription)
        }
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
                followSafariWindow: loadFollowSafariWindow(),
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
        zedConfig: ZedAccountConfiguration? = ZedAccountStore.load(),
        openAIConfigured: Bool = OpenAICompatibleSettingsStore.load().isConfigured
    ) -> ActiveProvider {
        let storedProvider = ProviderSettingsStore.loadActiveProvider()

        switch storedProvider {
        case .codex where codexConfig != nil:
            return .codex
        case .zed where zedConfig != nil:
            return .zed
        case .openaiCompatible:
            return .openaiCompatible
        default:
            if zedConfig != nil, codexConfig == nil {
                return .zed
            }
            if openAIConfigured, codexConfig == nil, zedConfig == nil {
                return .openaiCompatible
            }
            return .codex
        }
    }

    private func buildAvailableModels(
        codexConfig: CodexAccountConfiguration?,
        zedConfig: ZedAccountConfiguration?,
        openAISettings: OpenAICompatibleSettings,
        showSource: Bool
    ) -> [[String: Any]] {
        var models: [[String: Any]] = []

        if let zedConfig {
            models += zedConfig.model.available.map { model in
                [
                    "id": modelOptionID(provider: .zed, modelID: model.id),
                    "label": showSource ? "\(model.label) from zed" : model.label
                ]
            }
        }

        if openAISettings.isConfigured {
            models += openAISettings.availableModels.map { model in
                [
                    "id": modelOptionID(provider: .openaiCompatible, modelID: model.id),
                    "label": showSource ? "\(model.label) from openai-compatible" : model.label
                ]
            }
        }

        if let codexConfig {
            models += codexConfig.model.available.map { model in
                [
                    "id": modelOptionID(provider: .codex, modelID: model.id),
                    "label": showSource ? "\(model.label) from codex" : model.label
                ]
            }
        }

        if models.isEmpty {
            return [[
                "id": modelOptionID(provider: .codex, modelID: "gpt-5.4-mini"),
                "label": "gpt-5.4-mini"
            ]]
        }

        return models
    }

    private func modelOptionID(provider: ActiveProvider, modelID: String) -> String {
        "\(provider.rawValue)::\(modelID)"
    }

    private func preserveSelectedModel<T>(
        current: String,
        refreshedModels: [T],
        fallback: String,
        id: (T) -> String
    ) -> String {
        let normalizedCurrent = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedCurrent.isEmpty {
            return normalizedCurrent
        }
        return refreshedModels.first.map(id) ?? fallback
    }

    private func preserveSelectedModel(
        current: String,
        refreshedModels: [OpenAICompatibleModel],
        fallback: String
    ) -> String {
        preserveSelectedModel(current: current, refreshedModels: refreshedModels, fallback: fallback) { $0.id }
    }

    private func preserveSelectedModel(
        current: String,
        refreshedModels: [CodexModelSummary],
        fallback: String
    ) -> String {
        preserveSelectedModel(current: current, refreshedModels: refreshedModels, fallback: fallback) { $0.id }
    }

    private func preserveSelectedModel(
        current: String,
        refreshedModels: [ZedModelSummary],
        fallback: String
    ) -> String {
        preserveSelectedModel(current: current, refreshedModels: refreshedModels, fallback: fallback) { $0.id }
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
        let data = try JSONSerialization.data(
            withJSONObject: normalizedUISettings(payload),
            options: [.prettyPrinted, .sortedKeys]
        )
        try SharedContainer.writePrivate(data, to: url)
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
