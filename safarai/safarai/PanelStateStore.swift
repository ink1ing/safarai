import Foundation

struct PanelConversationMessage: Codable {
    var role: String
    var kind: String
    var text: String
}

struct PanelContextSnapshot: Codable {
    var site: String
    var url: String
    var title: String
    var selection: String
    var articleText: String
    var structureSummary: String?
    var interactiveSummary: String?
    var metadata: [String: String]
    var debugSelection: [String: String]?
    var visualSummary: String?
}

struct PanelStateSnapshot: Codable {
    var context: PanelContextSnapshot?
    var messages: [PanelConversationMessage]
    var status: String?
    var updatedAt: TimeInterval
}

struct SelectionIntentSnapshot: Codable {
    var url: String
    var selection: String
    var updatedAt: TimeInterval
}

enum PanelStateStore {
    private static let stateURL = SharedContainer.baseURL().appendingPathComponent("panel-state.json")
    private static let selectionIntentURL = SharedContainer.baseURL().appendingPathComponent("selection-intent.json")

    static func load() -> PanelStateSnapshot? {
        guard
            let data = try? Data(contentsOf: stateURL),
            let value = try? JSONDecoder().decode(PanelStateSnapshot.self, from: data)
        else {
            return nil
        }
        return value
    }

    static func save(_ snapshot: PanelStateSnapshot) throws {
        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(snapshot)
        try data.write(to: stateURL, options: .atomic)
    }

    static func updateStatus(_ status: String?) {
        let current = load()
        let snapshot = PanelStateSnapshot(
            context: current?.context,
            messages: current?.messages ?? [],
            status: status,
            updatedAt: Date().timeIntervalSince1970
        )
        try? save(snapshot)
    }

    static func loadSelectionIntent(matchingURL url: String?) -> SelectionIntentSnapshot? {
        guard
            let data = try? Data(contentsOf: selectionIntentURL),
            let value = try? JSONDecoder().decode(SelectionIntentSnapshot.self, from: data)
        else {
            return nil
        }

        let now = Date().timeIntervalSince1970
        guard now - value.updatedAt <= 120 else {
            return nil
        }

        guard !value.selection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        if let url, !url.isEmpty, value.url == url {
            return value
        }

        return value
    }
}
