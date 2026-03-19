import Foundation

struct CodexModelSummaryConfig: Codable {
    let id: String
    let label: String
}

struct CodexAccountConfigurationFile: Codable {
    struct Account: Codable {
        let email: String
        let accountId: String
    }

    struct Tokens: Codable {
        var accessToken: String
        var refreshToken: String
        var idToken: String?
        var expiresAt: TimeInterval?
    }

    struct Model: Codable {
        var selected: String
        var available: [CodexModelSummaryConfig]
        var lastSyncAt: TimeInterval?
    }

    var account: Account
    var tokens: Tokens
    var model: Model
}

struct ProviderConfig {
    let account: CodexAccountConfigurationFile.Account?
    let tokens: CodexAccountConfigurationFile.Tokens?
    let selectedModel: String
    let availableModels: [CodexModelSummaryConfig]
    let reasoningEffort: String

    var authState: String {
        guard let tokens, !tokens.accessToken.isEmpty else {
            return "logged_out"
        }
        return "logged_in"
    }

    static func load() -> ProviderConfig {
        let reasoningEffort = loadReasoningEffort()
        let url = configFileURL()
        guard
            let data = try? Data(contentsOf: url),
            let decoded = try? JSONDecoder().decode(CodexAccountConfigurationFile.self, from: data)
        else {
            return ProviderConfig(
                account: nil,
                tokens: nil,
                selectedModel: "gpt-5",
                availableModels: [],
                reasoningEffort: reasoningEffort
            )
        }

        return ProviderConfig(
            account: decoded.account,
            tokens: decoded.tokens,
            selectedModel: decoded.model.selected,
            availableModels: decoded.model.available,
            reasoningEffort: reasoningEffort
        )
    }

    static func save(_ configuration: CodexAccountConfigurationFile) throws {
        let url = configFileURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(configuration)
        try data.write(to: url, options: .atomic)
    }

    static func clear() throws {
        let url = configFileURL()
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    static func configFileURL() -> URL {
        NativeSharedContainer.baseURL().appendingPathComponent("codex-account.json")
    }

    private static func loadReasoningEffort() -> String {
        let url = NativeSharedContainer.baseURL().appendingPathComponent("ui-settings.json")
        guard
            let data = try? Data(contentsOf: url),
            let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let reasoning = value["reasoning_effort"] as? String,
            ["low", "medium", "high"].contains(reasoning)
        else {
            return "medium"
        }
        return reasoning
    }
}
