import Foundation

enum CodexModelError: LocalizedError {
    case notLoggedIn
    case upstreamFailed(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .notLoggedIn:
            return "当前未登录 Codex。"
        case .upstreamFailed(let message):
            return "模型刷新失败：\(message)"
        case .invalidResponse:
            return "模型列表响应无效。"
        }
    }
}

final class CodexModelService {
    static let shared = CodexModelService()

    private let baseURL = URL(string: "https://chatgpt.com/backend-api/codex")!
    private let clientVersion = "1.0.0"

    private init() {}

    func fetchModels(configuration: CodexAccountConfiguration) async throws -> [CodexModelSummary] {
        guard !configuration.tokens.accessToken.isEmpty else {
            throw CodexModelError.notLoggedIn
        }

        let url = baseURL.appendingPathComponent("models")
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.queryItems = [.init(name: "client_version", value: clientVersion)]

        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        request.allHTTPHeaderFields = [
            "Authorization": "Bearer \(configuration.tokens.accessToken)",
            "Accept": "application/json",
            "User-Agent": "codex_cli_rs/0.50.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
            "Version": clientVersion,
            "Chatgpt-Account-Id": configuration.account.accountId,
        ]

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CodexModelError.invalidResponse
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "unknown"
            throw CodexModelError.upstreamFailed(message)
        }

        guard let payload = try? JSONDecoder().decode(CodexModelsPayload.self, from: data) else {
            throw CodexModelError.invalidResponse
        }

        let models = payload.models.compactMap { item -> CodexModelSummary? in
            guard
                let slug = item.slug?.trimmingCharacters(in: .whitespacesAndNewlines),
                !slug.isEmpty,
                item.disabled != true,
                item.modelPickerEnabled != false
            else {
                return nil
            }

            let label = item.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
            return CodexModelSummary(id: slug, label: label?.isEmpty == false ? label! : slug)
        }

        if models.isEmpty {
            return [CodexModelSummary(id: "gpt-5", label: "gpt-5")]
        }

        return models
    }
}

private struct CodexModelsPayload: Decodable {
    var models: [CodexModelItem]
}

private struct CodexModelItem: Decodable {
    var slug: String?
    var displayName: String?
    var disabled: Bool?
    var modelPickerEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case slug
        case displayName = "display_name"
        case disabled
        case modelPickerEnabled = "model_picker_enabled"
    }
}
