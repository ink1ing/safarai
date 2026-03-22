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
    private var safariWindowFollower: SafariWindowFollower?

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
                self.pushPanelState(status: state.isEnabled ? "已连接 Safari 扩展" : "扩展未启用")
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
        case "send-question":
            sendQuestion(body)
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
                    pushPanelState(status: "颜色风格已更新。")
                } catch {
                    pushError(error.localizedDescription)
                }
            }
        case "save-panel-visibility-settings":
            do {
                try savePanelVisibilitySettings(
                    showPageInfo: body["showPageInfo"] as? Bool,
                    showStatusInfo: body["showStatusInfo"] as? Bool
                )
                pushPanelState(status: "显示选项已更新。")
            } catch {
                pushError(error.localizedDescription)
            }
        case "save-follow-safari-window-settings":
            do {
                try saveFollowSafariWindowSetting(body["followSafariWindow"] as? Bool)
                pushPanelState(status: "Safari 跟随吸附已更新。")
                safariWindowFollower?.refreshMode()
            } catch {
                pushError(error.localizedDescription)
            }
        case "save-follow-page-color-settings":
            do {
                try saveFollowPageColorSetting(body["followPageColor"] as? Bool)
                pushPanelState(status: "页面颜色跟随已更新。")
            } catch {
                pushError(error.localizedDescription)
            }
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
        pushPanelState(status: "正在拉起 Codex 登录…")
        Task {
            do {
                let result = try await CodexOAuthService.shared.startLogin()
                try? ProviderSettingsStore.saveActiveProvider(.codex)
                pushPanelState(status: "Codex 登录成功，模型列表已同步。", configuration: result.configuration)
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
            pushPanelState(status: "已登出 Codex。")
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func refreshCodexModels() {
        guard let configuration = CodexAccountStore.load() else {
            pushError("当前未登录 Codex。")
            return
        }

        pushPanelState(status: "正在刷新模型列表…")
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
                pushPanelState(status: "模型列表已刷新。", configuration: next)
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
            pushError("请选择一个模型。")
            return
        }

        let selection = parseModelSelection(
            selectedValue,
            fallback: resolvedActiveProvider()
        )

        switch selection.provider {
        case .zed:
            guard var configuration = ZedAccountStore.load() else {
                pushError("当前未登录 Zed。")
                return
            }
            guard configuration.model.available.contains(where: { $0.id == selection.modelID }) else {
                pushError("所选模型在 Zed 模型列表中不存在。")
                return
            }
            configuration.model.selected = selection.modelID
            do {
                try ZedAccountStore.save(configuration)
                try ProviderSettingsStore.saveActiveProvider(.zed)
                try saveUISettings(reasoningEffort: reasoningEffort)
                pushPanelState(status: "模型已保存。")
            } catch {
                pushError(error.localizedDescription)
            }

        case .codex:
            guard var configuration = CodexAccountStore.load() else {
                pushError("当前未登录 Codex。")
                return
            }
            guard configuration.model.available.contains(where: { $0.id == selection.modelID }) else {
                pushError("所选模型在 Codex 模型列表中不存在。")
                return
            }
            configuration.model.selected = selection.modelID
            do {
                try CodexAccountStore.save(configuration)
                try ProviderSettingsStore.saveActiveProvider(.codex)
                try saveUISettings(reasoningEffort: reasoningEffort)
                pushPanelState(status: "模型已保存。", configuration: configuration)
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func loginZed() {
        pushPanelState(status: "正在从 Keychain 导入 Zed 账户…")
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
                pushPanelState(status: "Zed 登录成功，共 \(models.count) 个模型。")
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
            pushPanelState(status: "已登出 Zed。")
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func refreshZedModels() {
        guard var config = ZedAccountStore.load() else {
            pushError("当前未登录 Zed。")
            return
        }
        pushPanelState(status: "正在刷新 Zed 模型列表…")
        Task {
            do {
                let models = try await ZedResponseService.shared.fetchModels(configuration: config)
                config.model.available = models
                config.model.lastSyncAt = Date().timeIntervalSince1970
                if !models.isEmpty && !models.contains(where: { $0.id == config.model.selected }) {
                    config.model.selected = models.first!.id
                }
                try ZedAccountStore.save(config)
                pushPanelState(status: "Zed 模型列表已刷新，共 \(models.count) 个。")
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
            pushPanelState(status: "已切换到 \(name)。")
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
        guard !prompt.isEmpty else {
            pushPanelState(status: "请输入问题。")
            return
        }

        var snapshot = PanelStateStore.load()
            ?? PanelStateSnapshot(context: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        snapshot.messages.append(PanelConversationMessage(role: "user", kind: "question", text: prompt))
        snapshot.status = "正在回答"
        snapshot.updatedAt = Date().timeIntervalSince1970
        try? PanelStateStore.save(snapshot)

        pushPanelState(status: "正在回答", snapshot: snapshot)
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
                        prompt: prompt,
                        context: contextSnapshot,
                        history: historySnapshot,
                        selectedFocus: selectedFocus
                    )
                } else {
                    stream = CodexResponseService.shared.streamQuestion(
                        prompt: prompt,
                        context: contextSnapshot,
                        history: historySnapshot,
                        selectedFocus: selectedFocus
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
                        status: "已回答"
                    )
                }
            } catch is CancellationError {
                await MainActor.run {
                    self.finishResponse(
                        baseSnapshot: snapshot,
                        assistantText: accumulated,
                        status: "已停止"
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

    private func refreshPanelContext() {
        pushPanelState(status: "正在刷新页面…")
        Task {
            if let latest = await SafariContextRefresher.loadFrontmostPage() {
                var snapshot = PanelStateStore.load()
                    ?? PanelStateSnapshot(context: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
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
                snapshot.status = "页面已刷新"
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
                self?.pushPanelState(status: "页面已刷新")
            }
        }
    }

    private func pushPanelState(
        status: String? = nil,
        configuration: CodexAccountConfiguration? = nil,
        snapshot: PanelStateSnapshot? = nil
    ) {
        let snapshot = snapshot ?? PanelStateStore.load()
        let codexConfig = configuration ?? CodexAccountStore.load()
        let zedConfig = ZedAccountStore.load()
        let isLoggedIn = codexConfig != nil || zedConfig != nil
        let activeProvider = resolvedActiveProvider(codexConfig: codexConfig, zedConfig: zedConfig)
        let bothLoggedIn = codexConfig != nil && zedConfig != nil
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
            "placementMode": loadPlacementMode().rawValue,
            "theme": loadTheme(),
            "showPageInfo": loadShowPageInfo(),
            "showStatusInfo": loadShowStatusInfo(),
            "followSafariWindow": loadFollowSafariWindow(),
            "followPageColor": loadFollowPageColor(),
            "customSystemPrompt": loadCustomSystemPrompt(),
            "settingsStatus": jsonValue(status ?? snapshot?.status)
        ]

        let settingsPayload: [String: Any] = [
            "isLoggedIn": isLoggedIn,
            "email": email,
            "selectedModel": selectedModel,
            "availableModels": availableModels,
            "activeProvider": activeProvider.rawValue,
            "showPageInfo": loadShowPageInfo(),
            "showStatusInfo": loadShowStatusInfo(),
            "drawerState": drawerState
        ]

        let payload: [String: Any] = [
            "settings": settingsPayload,
            "context": [
                "url": jsonValue(snapshot?.context?.url),
                "title": jsonValue(snapshot?.context?.title),
                "selection": jsonValue(snapshot?.context?.selection),
                "selectionFocusText": jsonValue(selectionIntent?.selection),
                "selectionDebug": debugSelection,
                "metadata": snapshot?.context?.metadata ?? [:],
                "updatedAt": jsonValue(snapshot?.updatedAt)
            ],
            "messages": snapshot?.messages.map { ["role": $0.role, "kind": $0.kind, "text": $0.text] } ?? [],
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
        try? PanelStateStore.save(next)
        evaluateRaw("finalizeStreamMessage()")
        responseTask = nil
        pushPanelState(status: status, snapshot: next)
    }

    private func pushError(_ message: String) {
        var snapshot = PanelStateStore.load()
            ?? PanelStateSnapshot(context: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        snapshot.messages.append(PanelConversationMessage(role: "error", kind: "error", text: message))
        snapshot.status = nil
        snapshot.updatedAt = Date().timeIntervalSince1970
        try? PanelStateStore.save(snapshot)
        pushPanelState()
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

    private func savePanelVisibilitySettings(
        showPageInfo: Bool?,
        showStatusInfo: Bool?
    ) throws {
        var payload = normalizedUISettings(loadUISettings())
        if let showPageInfo {
            payload["show_page_info"] = showPageInfo
        }
        if let showStatusInfo {
            payload["show_status_info"] = showStatusInfo
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

    private func loadShowPageInfo() -> Bool {
        normalizedUISettings(loadUISettings())["show_page_info"] as? Bool ?? true
    }

    private func loadShowStatusInfo() -> Bool {
        normalizedUISettings(loadUISettings())["show_status_info"] as? Bool ?? true
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
                    "label": showSource ? "\(model.label) from zed" : model.label
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
            "theme": normalizedTheme(payload["theme"] as? String),
            "show_page_info": payload["show_page_info"] as? Bool ?? true,
            "show_status_info": payload["show_status_info"] as? Bool ?? true,
            "follow_safari_window": payload["follow_safari_window"] as? Bool ?? true,
            "follow_page_color": payload["follow_page_color"] as? Bool ?? true,
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
