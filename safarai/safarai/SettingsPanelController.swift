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
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 220),
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
        let configuration = CodexAccountStore.load()
        evaluate(function: "renderSettingsState", payload: [
            "email": configuration?.account.email as Any,
            "isLoggedIn": configuration != nil,
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
        } else if command == "save-placement-mode" {
            let placementMode = (body["placementMode"] as? String) ?? "remember"
            onPlacementModeChange?(placementMode)
            pushState(status: "窗口位置策略已保存。")
        }
    }

    private func loadUI() {
        let html = """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { margin:0; padding:12px; font:13px/1.5 "Inter",-apple-system,BlinkMacSystemFont,sans-serif; background:
              radial-gradient(circle at top left, color-mix(in srgb, #8B5E3C 16%, transparent), transparent 42%),
              linear-gradient(180deg, color-mix(in srgb, #FFFFFDFA 36%, #F5F0EB) 0%, #F5F0EB 100%); color:#1A1A18; }
            .card { background:#FFFFFDFA; border:1px solid rgba(26,26,24,.12); border-radius:16px; box-shadow:0 18px 40px rgba(26,26,24,.09); padding:14px; }
            .label { color:#6B6B6B; font-size:11px; margin-bottom:4px; }
            .value { font-weight:600; margin-bottom:14px; word-break:break-word; }
            .button-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
            button { border:0; border-radius:999px; padding:8px 12px; background:#EDE5DD; color:#1A1A18; font:inherit; font-size:12px; font-weight:600; }
            button[data-active="true"] { background:#8B5E3C; }
            #logout-button { background:#8B5E3C; }
            #status { color:#6B6B6B; font-size:12px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="label">账户</div>
            <div class="value" id="email">未登录</div>
            <div class="label">窗口位置</div>
            <div class="button-row">
              <button id="placement-remember" type="button">记忆位置</button>
              <button id="placement-left" type="button">左吸附</button>
              <button id="placement-right" type="button">右吸附</button>
            </div>
            <div class="button-row">
              <button id="login-button" type="button">登录</button>
              <button id="logout-button" type="button">退出</button>
            </div>
            <div id="status"></div>
          </div>
          <script>
            function savePlacementMode(mode) {
              webkit.messageHandlers.settings.postMessage({ command: 'save-placement-mode', placementMode: mode });
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
            function renderSettingsState(payload) {
              document.getElementById('email').textContent = payload.email || '未登录';
              document.getElementById('login-button').disabled = payload.isLoggedIn;
              document.getElementById('logout-button').disabled = !payload.isLoggedIn;
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
