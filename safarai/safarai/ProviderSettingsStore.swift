import Foundation

struct ProviderSettings: Codable {
    var baseURL: String
    var model: String
    var reasoningEffort: String
    var autoLogin: Bool
    var requestTimeout: Double
    var allowMockFallback: Bool

    static let `default` = ProviderSettings(
        baseURL: "http://127.0.0.1:8964",
        model: "gpt-5",
        reasoningEffort: "medium",
        autoLogin: true,
        requestTimeout: 30,
        allowMockFallback: true
    )

    enum CodingKeys: String, CodingKey {
        case baseURL
        case model
        case reasoningEffort = "reasoning_effort"
        case autoLogin
        case requestTimeout
        case allowMockFallback
    }
}

// MARK: - Active Provider

enum ActiveProvider: String, Codable {
    case codex
    case zed
}

enum ProviderSettingsStore {
    static func load() -> ProviderSettings {
        let url = configURL()
        guard
            let data = try? Data(contentsOf: url),
            let settings = try? JSONDecoder().decode(ProviderSettings.self, from: data)
        else {
            return .default
        }

        return settings
    }

    static func save(_ settings: ProviderSettings) throws {
        let url = configURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(settings)
        try data.write(to: url, options: .atomic)
    }

    static func configURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent("provider.json")
    }

    // MARK: - Active Provider (host app only)

    static func loadActiveProvider() -> ActiveProvider {
        let url = activeProviderURL()
        guard
            let data = try? Data(contentsOf: url),
            let raw = try? JSONDecoder().decode(String.self, from: data),
            let provider = ActiveProvider(rawValue: raw)
        else {
            return .codex
        }
        return provider
    }

    static func saveActiveProvider(_ provider: ActiveProvider) throws {
        let url = activeProviderURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(provider.rawValue)
        try data.write(to: url, options: .atomic)
    }

    private static func activeProviderURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent("active-provider.json")
    }
}
