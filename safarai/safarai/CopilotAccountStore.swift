import Foundation

struct CopilotModelSummary: Codable {
    var id: String
    var label: String
}

struct CopilotAccountConfiguration: Codable {
    struct Account: Codable {
        var login: String
        var email: String?
    }

    struct Model: Codable {
        var selected: String
        var available: [CopilotModelSummary]
        var lastSyncAt: TimeInterval?
    }

    var account: Account
    var accessToken: String
    var model: Model
}

enum CopilotAccountStore {
    static func load() -> CopilotAccountConfiguration? {
        let url = configURL()
        guard
            let data = try? Data(contentsOf: url),
            let config = try? JSONDecoder().decode(CopilotAccountConfiguration.self, from: data)
        else {
            return nil
        }
        return config
    }

    static func save(_ configuration: CopilotAccountConfiguration) throws {
        let url = configURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(configuration)
        try data.write(to: url, options: .atomic)
    }

    static func clear() throws {
        let url = configURL()
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    static func configURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent("copilot-account.json")
    }
}
