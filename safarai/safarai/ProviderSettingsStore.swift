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
    case openaiCompatible = "openai_compatible"
}

struct OpenAICompatibleModel: Codable {
    var id: String
    var label: String
}

struct OpenAICompatibleSettings: Codable {
    var endpoint: String
    var apiKey: String
    var selectedModel: String
    var availableModels: [OpenAICompatibleModel]
    var lastSyncAt: TimeInterval?

    var isConfigured: Bool {
        !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static let `default` = OpenAICompatibleSettings(
        endpoint: "",
        apiKey: "",
        selectedModel: "gpt-4o-mini",
        availableModels: [OpenAICompatibleModel(id: "gpt-4o-mini", label: "gpt-4o-mini")],
        lastSyncAt: nil
    )

    enum CodingKeys: String, CodingKey {
        case endpoint
        case apiKey = "api_key"
        case selectedModel = "selected_model"
        case availableModels = "available_models"
        case lastSyncAt = "last_sync_at"
    }
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
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(settings)
        try SharedContainer.writePrivate(data, to: url)
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
        let data = try JSONEncoder().encode(provider.rawValue)
        try SharedContainer.writePrivate(data, to: url)
    }

    private static func activeProviderURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent("active-provider.json")
    }
}

enum OpenAICompatibleSettingsStore {
    static func load() -> OpenAICompatibleSettings {
        let url = configURL()
        guard
            let data = try? Data(contentsOf: url),
            let settings = try? JSONDecoder().decode(OpenAICompatibleSettings.self, from: data)
        else {
            return .default
        }

        if settings.availableModels.isEmpty {
            var next = settings
            next.availableModels = OpenAICompatibleSettings.default.availableModels
            if next.selectedModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                next.selectedModel = OpenAICompatibleSettings.default.selectedModel
            }
            return next
        }
        return settings
    }

    static func save(_ settings: OpenAICompatibleSettings) throws {
        let url = configURL()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(settings)
        try SharedContainer.writePrivate(data, to: url)
    }

    static func clearSecret() throws {
        var settings = load()
        settings.apiKey = ""
        try save(settings)
    }

    private static func configURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent("openai-compatible-provider.json")
    }
}
