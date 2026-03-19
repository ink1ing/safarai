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

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                self.pushCodexSettings()
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
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
        case "load-codex-settings":
            pushCodexSettings()
        case "start-codex-login":
            startCodexLogin()
        case "logout-codex":
            logoutCodex()
        case "refresh-codex-models":
            refreshCodexModels()
        case "save-selected-model":
            saveSelectedModel(body)
        case "reset-provider-settings":
            do {
                try CodexAccountStore.clear()
                pushCodexSettings(status: "已清除当前 Codex 登录状态。")
            } catch {
                pushError(error.localizedDescription)
            }
        default:
            break
        }
    }

    private func startCodexLogin() {
        evaluate(function: "renderCodexStatus", payload: ["message": "正在拉起 Codex 登录，请在系统浏览器中完成授权…"])

        Task {
            do {
                let result = try await CodexOAuthService.shared.startLogin()
                pushCodexSettings(status: "Codex 登录成功，模型列表已同步。", configuration: result.configuration)
            } catch {
                pushError(error.localizedDescription)
            }
        }
    }

    private func logoutCodex() {
        do {
            try CodexAccountStore.clear()
            pushCodexSettings(status: "已登出 Codex。")
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func refreshCodexModels() {
        guard let configuration = CodexAccountStore.load() else {
            pushError("当前未登录 Codex。")
            return
        }

        evaluate(function: "renderCodexStatus", payload: ["message": "正在刷新模型列表…"])
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
                pushCodexSettings(status: "模型列表已刷新。", configuration: next)
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
            pushCodexSettings(status: "模型与推理强度已保存。", configuration: configuration)
        } catch {
            pushError(error.localizedDescription)
        }
    }

    private func pushCodexSettings(status: String? = nil, configuration: CodexAccountConfiguration? = nil) {
        let settings = configuration ?? CodexAccountStore.load()
        let reasoningEffort = loadUISettings()["reasoning_effort"] as? String ?? "medium"
        let payload: [String: Any] = [
            "settings": [
                "isLoggedIn": settings != nil,
                "email": settings?.account.email as Any,
                "accountId": settings?.account.accountId as Any,
                "expiresAt": settings?.tokens.expiresAt as Any,
                "selectedModel": settings?.model.selected ?? "gpt-5",
                "availableModels": settings?.model.available.map { ["id": $0.id, "label": $0.label] } ?? [],
                "lastSyncAt": settings?.model.lastSyncAt as Any,
                "configPath": CodexAccountStore.configURL().path,
                "reasoningEffort": reasoningEffort,
            ],
            "status": status as Any,
        ]

        evaluate(function: "renderCodexSettings", payload: payload)
    }

    private func pushError(_ message: String) {
        evaluate(function: "renderCodexError", payload: ["message": message])
    }

    private func saveUISettings(reasoningEffort: String) throws {
        let url = uiSettingsURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let payload = [
            "reasoning_effort": ["low", "medium", "high"].contains(reasoningEffort) ? reasoningEffort : "medium",
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
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

    private func evaluate(function: String, payload: [String: Any]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else {
            return
        }

        self.webView.evaluateJavaScript("\(function)(\(json))")
    }
}
