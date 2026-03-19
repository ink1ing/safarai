import Foundation

enum NativeCodexModelError: LocalizedError {
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

final class NativeCodexModelService {
    static let shared = NativeCodexModelService()

    private let baseURL = URL(string: "https://chatgpt.com/backend-api/codex")!
    private let clientVersion = "1.0.0"

    private init() {}

    func fetchModels(configuration: NativeCodexAccountConfiguration) async throws -> [NativeCodexModelSummary] {
        guard !configuration.tokens.accessToken.isEmpty else {
            throw NativeCodexModelError.notLoggedIn
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
        guard let http = response as? HTTPURLResponse else {
            throw NativeCodexModelError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "unknown"
            throw NativeCodexModelError.upstreamFailed(message)
        }

        guard let payload = try? JSONDecoder().decode(NativeCodexModelsPayload.self, from: data) else {
            throw NativeCodexModelError.invalidResponse
        }

        let models = payload.models.compactMap { item -> NativeCodexModelSummary? in
            guard
                let slug = item.slug?.trimmingCharacters(in: .whitespacesAndNewlines),
                !slug.isEmpty,
                item.disabled != true,
                item.modelPickerEnabled != false
            else {
                return nil
            }
            let label = item.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
            return NativeCodexModelSummary(id: slug, label: label?.isEmpty == false ? label! : slug)
        }

        return models.isEmpty ? [NativeCodexModelSummary(id: "gpt-5", label: "gpt-5")] : models
    }
}

private struct NativeCodexModelsPayload: Decodable {
    let models: [NativeCodexModelItem]
}

private struct NativeCodexModelItem: Decodable {
    let slug: String?
    let displayName: String?
    let disabled: Bool?
    let modelPickerEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case slug
        case displayName = "display_name"
        case disabled
        case modelPickerEnabled = "model_picker_enabled"
    }
}
