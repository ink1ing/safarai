import Foundation

struct CodexModelSummary: Codable {
    var id: String
    var label: String
}

struct CodexStoredAccount: Codable {
    var email: String
    var accountId: String
}

struct CodexStoredTokens: Codable {
    var accessToken: String
    var refreshToken: String
    var idToken: String?
    var expiresAt: TimeInterval?
}

struct CodexStoredModelConfig: Codable {
    var selected: String
    var available: [CodexModelSummary]
    var lastSyncAt: TimeInterval?
}

struct CodexAccountConfiguration: Codable {
    var account: CodexStoredAccount
    var tokens: CodexStoredTokens
    var model: CodexStoredModelConfig

    static func make(
        email: String,
        accountId: String,
        accessToken: String,
        refreshToken: String,
        idToken: String?,
        expiresAt: TimeInterval?,
        selectedModel: String = "gpt-5",
        availableModels: [CodexModelSummary] = []
    ) -> CodexAccountConfiguration {
        CodexAccountConfiguration(
            account: CodexStoredAccount(email: email, accountId: accountId),
            tokens: CodexStoredTokens(
                accessToken: accessToken,
                refreshToken: refreshToken,
                idToken: idToken,
                expiresAt: expiresAt
            ),
            model: CodexStoredModelConfig(
                selected: selectedModel,
                available: availableModels,
                lastSyncAt: nil
            )
        )
    }
}

enum CodexAccountStore {
    static func load() -> CodexAccountConfiguration? {
        let url = configURL()
        guard
            let data = try? Data(contentsOf: url),
            let configuration = try? JSONDecoder().decode(CodexAccountConfiguration.self, from: data)
        else {
            return nil
        }

        return configuration
    }

    static func save(_ configuration: CodexAccountConfiguration) throws {
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
        SharedContainer.baseURL().appendingPathComponent("codex-account.json")
    }
}
