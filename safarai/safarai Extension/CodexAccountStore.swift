import Foundation

struct NativeCodexModelSummary: Codable {
    let id: String
    let label: String
}

struct NativeCodexAccountConfiguration: Codable {
    struct Account: Codable {
        var email: String
        var accountId: String
    }

    struct Tokens: Codable {
        var accessToken: String
        var refreshToken: String
        var idToken: String?
        var expiresAt: TimeInterval?
    }

    struct Model: Codable {
        var selected: String
        var available: [NativeCodexModelSummary]
        var lastSyncAt: TimeInterval?
    }

    var account: Account
    var tokens: Tokens
    var model: Model
}

enum NativeCodexAccountStore {
    static func load() -> NativeCodexAccountConfiguration? {
        let url = configURL()
        guard
            let data = try? Data(contentsOf: url),
            let config = try? JSONDecoder().decode(NativeCodexAccountConfiguration.self, from: data)
        else {
            return nil
        }
        return config
    }

    static func save(_ configuration: NativeCodexAccountConfiguration) throws {
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
        NativeSharedContainer.baseURL().appendingPathComponent("codex-account.json")
    }
}
