import AppKit
import WebKit

final class FloatingPanelController: NSWindowController, WKScriptMessageHandler {
    private let webView: WKWebView
    private var safariWindowFollower: SafariWindowFollower?

    init() {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(FloatingPanelMessageProxy.shared, name: "controller")
        self.webView = WKWebView(frame: .zero, configuration: configuration)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 780),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 360, height: 560)
        panel.setFrameAutosaveName("FloatingChatPanel")
        panel.contentView = webView

        super.init(window: panel)

        FloatingPanelMessageProxy.shared.owner = self
        loadUI()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func showPanel() {
        WindowPlacementCoordinator.restoreOrSnap(
            window!,
            autosaveName: "FloatingChatPanel",
            placementMode: loadPlacementMode()
        )
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let window, safariWindowFollower == nil {
            safariWindowFollower = SafariWindowFollower(
                window: window,
                autosaveName: "FloatingChatPanel",
                placementModeProvider: { [weak self] in
                    self?.loadPlacementMode() ?? .remember
                },
                followEnabledProvider: { [weak self] in
                    self?.loadFollowSafariWindow() ?? true
                }
            )
        }
        safariWindowFollower?.start()
        pushState()
    }

    func pushState() {
        let payload = PanelStateStore.load()
        let context = payload?.context
        let messages = payload?.messages.map { ["role": $0.role, "kind": $0.kind, "text": $0.text] } ?? []

        evaluate(function: "renderPanelState", payload: [
            "context": [
                "site": context?.site as Any,
                "url": context?.url as Any,
                "title": context?.title as Any,
                "selection": context?.selection as Any,
                "articleText": context?.articleText as Any,
                "metadata": context?.metadata as Any,
            ],
            "messages": messages,
            "status": payload?.status as Any,
        ])
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            let body = message.body as? [String: Any],
            let command = body["command"] as? String
        else {
            return
        }

        if command == "reload-panel-state" {
            pushState()
        }
    }

    private func loadUI() {
        guard let url = Bundle.main.url(forResource: "Panel", withExtension: "html", subdirectory: "Resources/Base.lproj") ??
                Bundle.main.url(forResource: "Panel", withExtension: "html")
        else {
            return
        }

        let root = Bundle.main.resourceURL ?? url.deletingLastPathComponent()
        webView.loadFileURL(url, allowingReadAccessTo: root)
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

    private func loadPlacementMode() -> WindowPlacementCoordinator.PlacementMode {
        let url = SharedContainer.baseURL().appendingPathComponent("ui-settings.json")
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rawValue = payload["placement_mode"] as? String,
            let mode = WindowPlacementCoordinator.PlacementMode(rawValue: rawValue)
        else {
            return .remember
        }
        return mode
    }

    private func loadFollowSafariWindow() -> Bool {
        let url = SharedContainer.baseURL().appendingPathComponent("ui-settings.json")
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return true
        }
        return payload["follow_safari_window"] as? Bool ?? true
    }
}

private final class FloatingPanelMessageProxy: NSObject, WKScriptMessageHandler {
    static let shared = FloatingPanelMessageProxy()
    weak var owner: FloatingPanelController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.userContentController(userContentController, didReceive: message)
    }
}
