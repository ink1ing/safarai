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

    override func viewDidLoad() {
        super.viewDidLoad()

        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
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
        }
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
        let prompt = (body["prompt"] as? String)?
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

        pushPanelState(status: "正在回答")
        evaluateRaw("beginStreamMessage()")

        let activeProvider = resolvedActiveProvider()
        let contextSnapshot = snapshot.context
        let historySnapshot = snapshot.messages

        Task {
            do {
                let stream: AsyncThrowingStream<String, Error>
                if activeProvider == .zed {
                    stream = ZedResponseService.shared.streamQuestion(
                        prompt: prompt,
                        context: contextSnapshot,
                        history: historySnapshot
                    )
                } else {
                    stream = CodexResponseService.shared.streamQuestion(
                        prompt: prompt,
                        context: contextSnapshot,
                        history: historySnapshot
                    )
                }

                var accumulated = ""
                for try await chunk in stream {
                    accumulated += chunk
                    let escaped = chunk
                        .replacingOccurrences(of: "\\", with: "\\\\")
                        .replacingOccurrences(of: "`", with: "\\`")
                        .replacingOccurrences(of: "$", with: "\\$")
                    await MainActor.run {
                        self.evaluateRaw("appendStreamChunk(`\(escaped)`)")
                    }
                }

                var next = PanelStateStore.load() ?? snapshot
                next.messages.append(PanelConversationMessage(role: "assistant", kind: "answer", text: accumulated))
                next.status = "已回答"
                next.updatedAt = Date().timeIntervalSince1970
                try? PanelStateStore.save(next)
                await MainActor.run {
                    self.evaluateRaw("finalizeStreamMessage()")
                    self.pushPanelState(status: "已回答")
                }
            } catch {
                await MainActor.run {
                    self.pushError(error.localizedDescription)
                }
            }
        }
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

    private func pushPanelState(status: String? = nil, configuration: CodexAccountConfiguration? = nil) {
        let snapshot = PanelStateStore.load()
        let codexConfig = configuration ?? CodexAccountStore.load()
        let zedConfig = ZedAccountStore.load()
        let isLoggedIn = codexConfig != nil || zedConfig != nil
        let activeProvider = resolvedActiveProvider(codexConfig: codexConfig, zedConfig: zedConfig)
        let bothLoggedIn = codexConfig != nil && zedConfig != nil

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
            "settingsStatus": jsonValue(status ?? snapshot?.status)
        ]

        let settingsPayload: [String: Any] = [
            "isLoggedIn": isLoggedIn,
            "email": email,
            "selectedModel": selectedModel,
            "availableModels": availableModels,
            "activeProvider": activeProvider.rawValue,
            "drawerState": drawerState
        ]

        let payload: [String: Any] = [
            "settings": settingsPayload,
            "context": [
                "url": jsonValue(snapshot?.context?.url),
                "title": jsonValue(snapshot?.context?.title),
                "selection": jsonValue(snapshot?.context?.selection)
            ],
            "messages": snapshot?.messages.map { ["role": $0.role, "kind": $0.kind, "text": $0.text] } ?? [],
            "status": jsonValue(status ?? snapshot?.status)
        ]

        evaluate(function: "renderPanelState", payload: payload)
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
        let existing = loadUISettings()
        let url = uiSettingsURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let payload: [String: Any] = [
            "reasoning_effort": ["low", "medium", "high"].contains(reasoningEffort) ? reasoningEffort : "medium",
            "placement_mode": existing["placement_mode"] as? String ?? "remember"
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    func savePlacementMode(_ rawValue: String) throws {
        let url = uiSettingsURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var payload = loadUISettings()
        payload["placement_mode"] = ["left", "right", "remember"].contains(rawValue) ? rawValue : "remember"
        payload["reasoning_effort"] = payload["reasoning_effort"] as? String ?? "medium"
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)

        if let window = view.window {
            UserDefaults.standard.removeObject(forKey: "NSWindow Frame MainChatWindow")
            WindowPlacementCoordinator.restoreOrSnap(
                window,
                autosaveName: "MainChatWindow",
                placementMode: loadPlacementMode(),
                animated: true
            )
        }
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
        let rawValue = loadUISettings()["placement_mode"] as? String ?? "remember"
        return WindowPlacementCoordinator.PlacementMode(rawValue: rawValue) ?? .remember
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
}
