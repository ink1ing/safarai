import AppKit
import WebKit

final class SettingsPanelController: NSWindowController, WKScriptMessageHandler {
    private let webView: WKWebView
    var onLogout: (() -> Void)?
    var onPlacementModeChange: ((String) -> Void)?
    var onLogin: (() -> Void)?

    init() {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(SettingsPanelMessageProxy.shared, name: "settings")
        self.webView = WKWebView(frame: .zero, configuration: configuration)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 340),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = "设置"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.contentView = webView

        super.init(window: panel)
        SettingsPanelMessageProxy.shared.owner = self
        loadUI()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func showPanel() {
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        pushState()
    }

    func pushState(status: String? = nil) {
        let codexConfig = CodexAccountStore.load()
        let zedConfig = ZedAccountStore.load()
        let activeProvider = ProviderSettingsStore.loadActiveProvider()
        evaluate(function: "renderSettingsState", payload: [
            "codexEmail": codexConfig?.account.email as Any,
            "codexLoggedIn": codexConfig != nil,
            "zedName": zedConfig?.account.name as Any,
            "zedLoggedIn": zedConfig != nil,
            "activeProvider": activeProvider.rawValue,
            "placementMode": loadPlacementMode(),
            "status": status as Any,
        ])
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            let body = message.body as? [String: Any],
            let command = body["command"] as? String
        else {
            return
        }

        if command == "logout" {
            do {
                try CodexAccountStore.clear()
                pushState(status: "已登出")
                onLogout?()
            } catch {
                pushState(status: error.localizedDescription)
            }
        } else if command == "login" {
            onLogin?()
            pushState(status: "正在拉起登录…")
        } else if command == "logout-zed" {
            do {
                try ZedAccountStore.clear()
                if ProviderSettingsStore.loadActiveProvider() == .zed {
                    try ProviderSettingsStore.saveActiveProvider(.codex)
                }
                pushState(status: "Zed 已登出")
                onLogout?()
            } catch {
                pushState(status: error.localizedDescription)
            }
        } else if command == "import-zed" {
            pushState(status: "正在导入 Zed 账户…")
            Task { @MainActor in
                do {
                    var config = try await ZedAccountStore.importFromKeychain()
                    let models = try await ZedResponseService.shared.fetchModels(configuration: config)
                    config.model.available = models
                    config.model.lastSyncAt = Date().timeIntervalSince1970
                    if !models.isEmpty { config.model.selected = models.first!.id }
                    try ZedAccountStore.save(config)
                    try ProviderSettingsStore.saveActiveProvider(.zed)
                    pushState(status: "Zed 已导入，共 \(models.count) 个模型。")
                    onLogout?()  // reuse to trigger panel refresh
                } catch {
                    pushState(status: error.localizedDescription)
                }
            }
        } else if command == "switch-provider" {
            let rawValue = (body["provider"] as? String) ?? "codex"
            if let provider = ActiveProvider(rawValue: rawValue) {
                do {
                    try ProviderSettingsStore.saveActiveProvider(provider)
                    let name = provider == .zed ? "Zed" : "Codex"
                    pushState(status: "已切换到 \(name)")
                    onLogout?()  // reuse to trigger panel refresh
                } catch {
                    pushState(status: error.localizedDescription)
                }
            }
        } else if command == "save-placement-mode" {
            let placementMode = (body["placementMode"] as? String) ?? "remember"
            onPlacementModeChange?(placementMode)
            pushState(status: "窗口位置策略已保存。")
        }
    }

    private func loadUI() {
        let html = """
        <!DOCTYPE html>
        <html class="dark" lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            :root {
                color-scheme: dark;
                --background: #1a1a1e;
                --surface: #1a1a1e;
                --surface-low: #242429;
                --surface-high: #3a3a3f;
                --surface-soft: #2c2c32;
                --text-primary: #e0e0e6;
                --text-muted: #8c8c96;
                --outline: #44444a;
                --primary: #4a90e2;
                --primary-strong: #357abd;
                --danger: #ff5f57;
            }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                font: 13px/1.5 "Inter", "SF Pro Text", "PingFang SC", -apple-system, sans-serif;
                background-color: var(--background);
                color: var(--text-primary);
                padding: 16px;
                -webkit-font-smoothing: antialiased;
            }
            .card {
                padding: 16px;
                border-radius: 18px;
                border: 1px solid rgba(255, 255, 255, 0.08);
                background: rgba(255, 255, 255, 0.04);
                backdrop-filter: blur(25px) saturate(180%);
                -webkit-backdrop-filter: blur(25px) saturate(180%);
            }
            .section { margin-bottom: 18px; }
            .section:last-child { margin-bottom: 0; }
            .label {
                font-size: 10px;
                font-weight: 800;
                letter-spacing: 0.12em;
                text-transform: uppercase;
                color: rgba(224, 224, 230, 0.35);
                margin-bottom: 8px;
            }
            .value {
                font-size: 13px;
                font-weight: 600;
                color: var(--text-primary);
                word-break: break-word;
            }
            .button-row {
                display: flex;
                gap: 6px;
                flex-wrap: wrap;
            }
            button {
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 999px;
                padding: 7px 14px;
                background: var(--surface-soft);
                color: var(--text-muted);
                font: inherit;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: color 0.15s, background 0.15s, border-color 0.15s;
            }
            button:hover {
                color: var(--text-primary);
                background: var(--surface-high);
            }
            button[data-active="true"] {
                color: #fff;
                background: var(--primary);
                border-color: var(--primary-strong);
            }
            #login-button {
                color: var(--primary);
                border-color: rgba(74, 144, 226, 0.25);
                background: rgba(74, 144, 226, 0.12);
            }
            #login-button:hover {
                background: rgba(74, 144, 226, 0.22);
            }
            #login-button:disabled {
                opacity: 0.35;
                pointer-events: none;
            }
            #logout-button {
                color: var(--danger);
                border-color: rgba(255, 95, 87, 0.2);
                background: rgba(255, 95, 87, 0.08);
            }
            #logout-button:hover {
                background: rgba(255, 95, 87, 0.18);
            }
            #logout-button:disabled {
                opacity: 0.35;
                pointer-events: none;
            }
            #status {
                margin-top: 14px;
                font-size: 11px;
                color: var(--text-muted);
                min-height: 1.5em;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="section">
              <div class="label">AI 提供商</div>
              <div class="button-row">
                <button id="provider-codex" type="button" onclick="switchProvider('codex')">Codex</button>
                <button id="provider-zed" type="button" onclick="switchProvider('zed')">Zed</button>
              </div>
            </div>
            <div class="section">
              <div class="label">Codex 账户</div>
              <div class="value" id="codex-email">未登录</div>
              <div class="button-row" style="margin-top:8px">
                <button id="login-button" type="button">登录</button>
                <button id="logout-button" type="button">退出</button>
              </div>
            </div>
            <div class="section">
              <div class="label">Zed 账户</div>
              <div class="value" id="zed-name">未登录</div>
              <div class="button-row" style="margin-top:8px">
                <button id="import-zed-button" type="button">导入 Zed</button>
                <button id="logout-zed-button" type="button">退出</button>
              </div>
            </div>
            <div class="section">
              <div class="label">窗口位置</div>
              <div class="button-row">
                <button id="placement-remember" type="button">记忆位置</button>
                <button id="placement-left" type="button">左吸附</button>
                <button id="placement-right" type="button">右吸附</button>
              </div>
            </div>
            <div id="status"></div>
          </div>
          <script>
            function savePlacementMode(mode) {
              webkit.messageHandlers.settings.postMessage({ command: 'save-placement-mode', placementMode: mode });
            }
            function switchProvider(provider) {
              webkit.messageHandlers.settings.postMessage({ command: 'switch-provider', provider: provider });
            }
            document.getElementById('placement-remember').addEventListener('click', () => savePlacementMode('remember'));
            document.getElementById('placement-left').addEventListener('click', () => savePlacementMode('left'));
            document.getElementById('placement-right').addEventListener('click', () => savePlacementMode('right'));
            document.getElementById('login-button').addEventListener('click', () => {
              webkit.messageHandlers.settings.postMessage({ command: 'login' });
            });
            document.getElementById('logout-button').addEventListener('click', () => {
              webkit.messageHandlers.settings.postMessage({ command: 'logout' });
            });
            document.getElementById('import-zed-button').addEventListener('click', () => {
              webkit.messageHandlers.settings.postMessage({ command: 'import-zed' });
            });
            document.getElementById('logout-zed-button').addEventListener('click', () => {
              webkit.messageHandlers.settings.postMessage({ command: 'logout-zed' });
            });
            function renderSettingsState(payload) {
              document.getElementById('codex-email').textContent = payload.codexEmail || '未登录';
              document.getElementById('login-button').disabled = payload.codexLoggedIn;
              document.getElementById('logout-button').disabled = !payload.codexLoggedIn;
              document.getElementById('zed-name').textContent = payload.zedName || '未登录';
              document.getElementById('import-zed-button').disabled = false;
              document.getElementById('logout-zed-button').disabled = !payload.zedLoggedIn;
              document.getElementById('provider-codex').dataset.active = payload.activeProvider === 'codex' ? 'true' : 'false';
              document.getElementById('provider-zed').dataset.active = payload.activeProvider === 'zed' ? 'true' : 'false';
              document.getElementById('placement-remember').dataset.active = payload.placementMode === 'remember' ? 'true' : 'false';
              document.getElementById('placement-left').dataset.active = payload.placementMode === 'left' ? 'true' : 'false';
              document.getElementById('placement-right').dataset.active = payload.placementMode === 'right' ? 'true' : 'false';
              document.getElementById('status').textContent = payload.status || '';
            }
          </script>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
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

    private func loadPlacementMode() -> String {
        let url = SharedContainer.baseURL().appendingPathComponent("ui-settings.json")
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rawValue = payload["placement_mode"] as? String
        else {
            return "remember"
        }
        return rawValue
    }
}

private final class SettingsPanelMessageProxy: NSObject, WKScriptMessageHandler {
    static let shared = SettingsPanelMessageProxy()
    weak var owner: SettingsPanelController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.userContentController(userContentController, didReceive: message)
    }
}
