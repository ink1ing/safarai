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
    private lazy var settingsPanelController = SettingsPanelController()
    private var panelRefreshTimer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")
        self.settingsPanelController.onLogout = { [weak self] in
            self?.pushPanelState(status: "已登出 Codex。")
        }
        self.settingsPanelController.onLogin = { [weak self] in
            self?.startCodexLogin()
        }
        self.settingsPanelController.onPlacementModeChange = { [weak self] rawValue in
            do {
                try self?.savePlacementMode(rawValue)
                self?.pushPanelState(status: "窗口位置策略已更新。")
            } catch {
                self?.pushError(error.localizedDescription)
            }
        }

        self.webView.loadFileURL(Bundle.main.url(forResource: "Panel", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
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
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
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
                SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
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
        case "save-selected-model":
            saveSelectedModel(body)
        case "send-question":
            sendQuestion(body)
        case "refresh-panel-context":
            refreshPanelContext()
        case "open-settings-panel":
            settingsPanelController.showPanel()
        case "reset-provider-settings":
            do {
                try CodexAccountStore.clear()
                pushPanelState(status: "已清除当前 Codex 登录状态。")
                settingsPanelController.pushState(status: "已清除当前 Codex 登录状态。")
            } catch {
                pushError(error.localizedDescription)
            }
        default:
            break
        }
    }

    private func startCodexLogin() {
        pushPanelState(status: "正在拉起 Codex 登录，请在系统浏览器中完成授权…")

        Task {
            do {
                let result = try await CodexOAuthService.shared.startLogin()
                pushPanelState(status: "Codex 登录成功，模型列表已同步。", configuration: result.configuration)
                settingsPanelController.pushState(status: "已登录")
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func logoutCodex() {
        do {
            try CodexAccountStore.clear()
            pushPanelState(status: "已登出 Codex。")
            settingsPanelController.pushState(status: "已登出")
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
        guard var configuration = CodexAccountStore.load() else {
            pushError("当前未登录 Codex。")
            return
        }
        let selectedModel = (body["selectedModel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let reasoningEffort = (body["reasoningEffort"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "medium"

        guard !selectedModel.isEmpty else {
            pushError("请选择一个模型。")
            return
        }

        configuration.model.selected = selectedModel
        do {
            try CodexAccountStore.save(configuration)
            try saveUISettings(reasoningEffort: reasoningEffort)
            pushPanelState(status: "模型已保存。", configuration: configuration)
            settingsPanelController.pushState()
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func sendQuestion(_ body: [String: Any]) {
        let prompt = (body["prompt"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !prompt.isEmpty else {
            pushPanelState(status: "请输入问题。")
            return
        }

        var snapshot = PanelStateStore.load() ?? PanelStateSnapshot(context: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        snapshot.messages.append(PanelConversationMessage(role: "user", kind: "question", text: prompt))
        snapshot.status = "正在回答"
        snapshot.updatedAt = Date().timeIntervalSince1970
        try? PanelStateStore.save(snapshot)
        pushPanelState(status: "正在回答")

        Task {
            do {
                let answer = try await CodexResponseService.shared.askQuestion(
                    prompt: prompt,
                    context: snapshot.context,
                    history: snapshot.messages
                )
                var next = PanelStateStore.load() ?? snapshot
                next.messages.append(PanelConversationMessage(role: "assistant", kind: "answer", text: answer))
                next.status = "已回答"
                next.updatedAt = Date().timeIntervalSince1970
                try? PanelStateStore.save(next)
                pushPanelState(status: "已回答")
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func refreshPanelContext() {
        pushPanelState(status: "正在刷新页面…")
        Task { [weak self] in
            if let latest = await SafariContextRefresher.loadFrontmostPage() {
                var snapshot = PanelStateStore.load() ?? PanelStateSnapshot(context: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
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
        let settings = configuration ?? CodexAccountStore.load()
        let snapshot = PanelStateStore.load()
        let payload: [String: Any] = [
            "settings": [
                "isLoggedIn": settings != nil,
                "email": settings?.account.email as Any,
                "selectedModel": settings?.model.selected ?? "gpt-5",
                "availableModels": settings?.model.available.map { ["id": $0.id, "label": $0.label] } ?? [],
            ],
            "context": [
                "url": snapshot?.context?.url as Any,
                "title": snapshot?.context?.title as Any,
                "selection": snapshot?.context?.selection as Any,
            ],
            "messages": snapshot?.messages.map { ["role": $0.role, "kind": $0.kind, "text": $0.text] } ?? [],
            "status": status ?? snapshot?.status as Any,
        ]

        evaluate(function: "renderPanelState", payload: payload)
    }

    private func pushError(_ message: String) {
        var snapshot = PanelStateStore.load() ?? PanelStateSnapshot(context: nil, messages: [], status: nil, updatedAt: Date().timeIntervalSince1970)
        snapshot.status = message
        snapshot.updatedAt = Date().timeIntervalSince1970
        try? PanelStateStore.save(snapshot)
        pushPanelState(status: message)
    }

    private func saveUISettings(reasoningEffort: String) throws {
        let existing = loadUISettings()
        let url = uiSettingsURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let payload: [String: Any] = [
            "reasoning_effort": ["low", "medium", "high"].contains(reasoningEffort) ? reasoningEffort : "medium",
            "placement_mode": existing["placement_mode"] as? String ?? "remember",
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
            WindowPlacementCoordinator.restoreOrSnap(
                window,
                autosaveName: "MainChatWindow",
                placementMode: loadPlacementMode()
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

    private func evaluate(function: String, payload: [String: Any]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else {
            return
        }

        self.webView.evaluateJavaScript("\(function)(\(json))")
    }

    private func startPanelRefreshTimer() {
        panelRefreshTimer?.invalidate()
        panelRefreshTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pushPanelState()
        }
    }
}
