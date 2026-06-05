import Foundation

enum PanelStateWriter {
    private static let stateURL = NativeSharedContainer.baseURL().appendingPathComponent("panel-state.json")
    private static let selectionIntentURL = NativeSharedContainer.baseURL().appendingPathComponent("selection-intent.json")

    static func save(payload: [String: Any], status: String? = nil) throws {
        let current = loadRawSnapshot() ?? [:]
        let context = payload["context"] as? [String: Any]
        let normalizedIncomingContext = preserveSelection(
            currentContext: current["context"] as? [String: Any],
            incomingContext: normalizeContext(context)
        )
        if isDetachedContext(normalizedIncomingContext) {
            return
        }
        let incomingMessages = (payload["messages"] as? [[String: Any]] ?? []).map(normalizeMessage(_:))
        let preservedMessages = preserveMessages(
            current: current["messages"] as? [[String: Any]] ?? [],
            incoming: incomingMessages,
            currentContext: current["context"] as? [String: Any],
            incomingContext: normalizedIncomingContext
        )

        let snapshot: [String: Any] = [
            "context": normalizedIncomingContext as Any,
            "currentThreadId": current["currentThreadId"] as Any,
            "messages": preservedMessages,
            "status": status as Any,
            "updatedAt": Date().timeIntervalSince1970,
        ]

        persistSelectionIntent(from: normalizedIncomingContext)

        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
        try NativeSharedContainer.writePrivate(data, to: stateURL)
    }

    static func updatePage(title: String, url: String, status: String? = nil) throws {
        if isDetachedURL(url) {
            return
        }
        let current = loadRawSnapshot() ?? [:]
        var context = (current["context"] as? [String: Any]) ?? [:]
        if context.isEmpty {
            context = makeFallbackContext(title: title, url: url)
        }
        context["title"] = title
        context["url"] = url

        let snapshot: [String: Any] = [
            "context": context,
            "currentThreadId": current["currentThreadId"] as Any,
            "messages": current["messages"] as? [[String: Any]] ?? [],
            "status": status as Any,
            "updatedAt": Date().timeIntervalSince1970,
        ]

        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
        try NativeSharedContainer.writePrivate(data, to: stateURL)
    }

    private static func makeFallbackContext(title: String, url: String) -> [String: Any] {
        let domain = URL(string: url)?.host ?? ""
        return [
            "site": "unsupported",
            "url": url,
            "title": title,
            "selection": "",
            "articleText": title.isEmpty ? url : "title: \(title)\nurl: \(url)",
            "videoRAGSummary": "",
            "structureSummary": "",
            "interactiveSummary": "",
            "metadata": [
                "domain": domain,
                "pageKind": "fallback_tab_context",
                "contentStrategy": "fallback_tab_context",
                "pageContextTransport": "safari_page_properties",
                "pageContextUpdatedAt": ISO8601DateFormatter().string(from: Date()),
            ],
            "debugSelection": [:],
            "visualSummary": "",
        ]
    }

    private static func isDetachedContext(_ context: [String: Any]?) -> Bool {
        let detachedURL = loadDetachedContextURL()
        guard !detachedURL.isEmpty else {
            return false
        }
        let incomingURL = ((context?["url"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !incomingURL.isEmpty else {
            return true
        }
        if incomingURL == detachedURL {
            return true
        }
        clearDetachedContextURL()
        return false
    }

    private static func isDetachedURL(_ url: String) -> Bool {
        !loadDetachedContextURL().isEmpty
    }

    private static func loadDetachedContextURL() -> String {
        let url = NativeSharedContainer.baseURL().appendingPathComponent("detached-context-url.json")
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return ""
        }
        return (payload["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func clearDetachedContextURL() {
        let url = NativeSharedContainer.baseURL().appendingPathComponent("detached-context-url.json")
        let payload = ["url": ""]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
            try? NativeSharedContainer.writePrivate(data, to: url)
        }
    }

    static func saveSelectionIntent(url: String, selection: String) {
        let normalizedURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSelection = selection.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedURL.isEmpty, !normalizedSelection.isEmpty else {
            return
        }

        let payload: [String: Any] = [
            "url": normalizedURL,
            "selection": normalizedSelection,
            "updatedAt": Date().timeIntervalSince1970,
        ]

        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
            try? NativeSharedContainer.writePrivate(data, to: selectionIntentURL)
        }
    }

    private static func normalizeContext(_ context: [String: Any]?) -> [String: Any]? {
        guard let context else {
            return nil
        }

        let metadata = (context["metadata"] as? [String: Any] ?? [:]).reduce(into: [String: String]()) { result, item in
            result[item.key] = String(describing: item.value)
        }
        let debugSelection = (context["debugSelection"] as? [String: Any] ?? [:]).reduce(into: [String: String]()) { result, item in
            result[item.key] = String(describing: item.value)
        }

        return [
            "site": String(describing: context["site"] ?? "unsupported"),
            "url": String(describing: context["url"] ?? ""),
            "title": String(describing: context["title"] ?? "当前页面"),
            "selection": String(describing: context["selection"] ?? ""),
            "articleText": String(describing: context["articleText"] ?? ""),
            "videoRAGSummary": String(describing: context["videoRAGSummary"] ?? ""),
            "structureSummary": context["structureSummary"] ?? NSNull(),
            "interactiveSummary": context["interactiveSummary"] ?? NSNull(),
            "metadata": metadata,
            "debugSelection": debugSelection,
            "visualSummary": buildVisualSummary(context, metadata: metadata) as Any,
        ]
    }

    private static func normalizeMessage(_ item: [String: Any]) -> [String: String] {
        [
            "role": String(describing: item["role"] ?? "system"),
            "kind": String(describing: item["kind"] ?? "message"),
            "text": String(describing: item["text"] ?? ""),
        ]
    }

    private static func preserveMessages(
        current: [[String: Any]],
        incoming: [[String: String]],
        currentContext: [String: Any]?,
        incomingContext: [String: Any]?
    ) -> [[String: Any]] {
        let currentURL = String(describing: currentContext?["url"] ?? "")
        let incomingURL = String(describing: incomingContext?["url"] ?? "")

        if incoming.isEmpty {
            return current
        }

        if current.isEmpty {
            return incoming.map { $0 }
        }

        if !currentURL.isEmpty, !incomingURL.isEmpty, currentURL != incomingURL {
            return incoming.map { $0 }
        }

        if incoming.count >= current.count {
            return incoming.map { $0 }
        }

        return current
    }

    private static func preserveSelection(
        currentContext: [String: Any]?,
        incomingContext: [String: Any]?
    ) -> [String: Any]? {
        guard var incomingContext else {
            return nil
        }

        let currentURL = String(describing: currentContext?["url"] ?? "")
        let incomingURL = String(describing: incomingContext["url"] ?? "")
        let currentSelection = String(describing: currentContext?["selection"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingSelection = String(describing: incomingContext["selection"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if incomingSelection.isEmpty, !currentSelection.isEmpty, currentURL == incomingURL {
            incomingContext["selection"] = currentSelection
        }

        return incomingContext
    }

    private static func buildVisualSummary(_ context: [String: Any], metadata: [String: String]) -> String {
        let focusedInput = context["focusedInput"] as? [String: Any]
        let focusedType = String(describing: focusedInput?["type"] ?? "none")
        let focusedLabel = String(describing: focusedInput?["label"] ?? focusedInput?["placeholder"] ?? "none")
        let pageKind = metadata["pageKind"] ?? "unknown"
        let repository = metadata["repository"] ?? "none"
        let domain = metadata["domain"] ?? "unknown"

        return [
            "domain: \(domain)",
            "page_kind: \(pageKind)",
            "repository: \(repository)",
            "focused_input_type: \(focusedType)",
            "focused_input_label: \(focusedLabel)",
        ].joined(separator: "\n")
    }

    private static func loadRawSnapshot() -> [String: Any]? {
        guard
            let data = try? Data(contentsOf: stateURL),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return payload
    }

    private static func persistSelectionIntent(from context: [String: Any]?) {
        guard
            let context,
            let url = context["url"] as? String,
            !url.isEmpty
        else {
            return
        }

        let selection = String(describing: context["selection"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !selection.isEmpty else {
            return
        }

        saveSelectionIntent(url: url, selection: selection)
    }
}
