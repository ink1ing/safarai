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

        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: stateURL, options: .atomic)
    }

    static func updatePage(title: String, url: String, status: String? = nil) throws {
        let current = loadRawSnapshot() ?? [:]
        var context = (current["context"] as? [String: Any]) ?? [:]
        context["title"] = title
        context["url"] = url

        let snapshot: [String: Any] = [
            "context": context,
            "currentThreadId": current["currentThreadId"] as Any,
            "messages": current["messages"] as? [[String: Any]] ?? [],
            "status": status as Any,
            "updatedAt": Date().timeIntervalSince1970,
        ]

        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: stateURL, options: .atomic)
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

        let directory = selectionIntentURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: selectionIntentURL, options: .atomic)
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

enum NativeAgentBridgeStore {
    private static let requestURL = NativeSharedContainer.baseURL().appendingPathComponent("agent-bridge-request.json")
    private static let responseURL = NativeSharedContainer.baseURL().appendingPathComponent("agent-bridge-response.json")

    static func claimPendingRequest() -> [String: Any]? {
        guard var payload = readJSON(from: requestURL) else {
            return nil
        }
        guard String(describing: payload["status"] ?? "") == "pending" else {
            return nil
        }
        payload["status"] = "claimed"
        payload["claimedAt"] = Date().timeIntervalSince1970
        try? writeJSON(payload, to: requestURL)
        return payload
    }

    static func submitResult(requestId: String, result: [String: Any]) {
        let payload: [String: Any] = [
            "requestId": requestId,
            "result": result,
            "updatedAt": Date().timeIntervalSince1970,
        ]
        try? writeJSON(payload, to: responseURL)
        try? FileManager.default.removeItem(at: requestURL)
    }

    private static func readJSON(from url: URL) -> [String: Any]? {
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return payload
    }

    private static func writeJSON(_ payload: [String: Any], to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }
}
