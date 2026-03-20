import Foundation

enum PanelStateWriter {
    private static let stateURL = NativeSharedContainer.baseURL().appendingPathComponent("panel-state.json")

    static func save(payload: [String: Any], status: String? = nil) throws {
        let context = payload["context"] as? [String: Any]
        let session = payload["messages"] as? [[String: Any]] ?? []

        let snapshot: [String: Any] = [
            "context": normalizeContext(context) as Any,
            "messages": session.map(normalizeMessage(_:)),
            "status": status as Any,
            "updatedAt": Date().timeIntervalSince1970,
        ]

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
            "messages": current["messages"] as? [[String: Any]] ?? [],
            "status": status as Any,
            "updatedAt": Date().timeIntervalSince1970,
        ]

        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: stateURL, options: .atomic)
    }

    private static func normalizeContext(_ context: [String: Any]?) -> [String: Any]? {
        guard let context else {
            return nil
        }

        let metadata = (context["metadata"] as? [String: Any] ?? [:]).reduce(into: [String: String]()) { result, item in
            result[item.key] = String(describing: item.value)
        }

        return [
            "site": String(describing: context["site"] ?? "unsupported"),
            "url": String(describing: context["url"] ?? ""),
            "title": String(describing: context["title"] ?? "当前页面"),
            "selection": String(describing: context["selection"] ?? ""),
            "articleText": String(describing: context["articleText"] ?? ""),
            "metadata": metadata,
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
}
