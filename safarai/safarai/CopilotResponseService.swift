import Foundation

private actor CopilotRuntimeTokenStore {
    private var cache: [String: (token: String, expiresAt: TimeInterval)] = [:]

    func get(for key: String) -> String? {
        guard let entry = cache[key], entry.expiresAt > Date().timeIntervalSince1970 else {
            cache[key] = nil
            return nil
        }
        return entry.token
    }

    func set(_ token: String, expiresAt: TimeInterval, for key: String) {
        cache[key] = (token, expiresAt)
    }

    func invalidate(for key: String) {
        cache[key] = nil
    }
}

enum CopilotResponseError: LocalizedError {
    case notLoggedIn
    case invalidResponse
    case upstreamStatus(Int, String)
    case emptyContent

    var errorDescription: String? {
        switch self {
        case .notLoggedIn:
            return "当前未登录 GitHub Copilot。"
        case .invalidResponse:
            return "GitHub Copilot 响应无效。"
        case .upstreamStatus(let status, let body):
            return "GitHub Copilot 请求失败（\(status)）：\(body)"
        case .emptyContent:
            return "GitHub Copilot 未返回可用内容。"
        }
    }
}

private struct CopilotApiTokenResponse: Decodable {
    var token: String?
    var expiresAt: Int?

    enum CodingKeys: String, CodingKey {
        case token
        case expiresAt = "expires_at"
    }
}

private struct CopilotModelsResponse: Decodable {
    var data: [CopilotRemoteModel]?
}

private struct CopilotRemoteModel: Decodable {
    var id: String?
    var name: String?
    var modelPickerEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case modelPickerEnabled = "model_picker_enabled"
    }
}

final class CopilotResponseService {
    static let shared = CopilotResponseService()

    private let session: URLSession
    private let tokenStore = CopilotRuntimeTokenStore()
    private let copilotTokenURL = URL(string: "https://api.github.com/copilot_internal/v2/token")!
    private let copilotModelsURL = URL(string: "https://api.githubcopilot.com/models")!
    private let copilotCompletionsURL = URL(string: "https://api.githubcopilot.com/chat/completions")!

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config)
    }

    func fetchModels(configuration: CopilotAccountConfiguration) async throws -> [CopilotModelSummary] {
        let apiToken = try await getCopilotApiToken(configuration: configuration)
        var request = URLRequest(url: copilotModelsURL)
        request.httpMethod = "GET"
        request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("GithubCopilot/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue("vscode/1.100.0", forHTTPHeaderField: "Editor-Version")
        request.setValue("copilot/1.300.0", forHTTPHeaderField: "Editor-Plugin-Version")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CopilotResponseError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw CopilotResponseError.upstreamStatus(http.statusCode, body)
        }

        let payload = try? JSONDecoder().decode(CopilotModelsResponse.self, from: data)
        let models = normalizeModels(payload?.data ?? [])
        if !models.isEmpty {
            return models
        }

        return [
            CopilotModelSummary(id: "gpt-4o", label: "gpt-4o"),
        ]
    }

    func streamQuestion(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String = "",
        attachments: [PanelAttachment] = []
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    guard let configuration = CopilotAccountStore.load() else {
                        throw CopilotResponseError.notLoggedIn
                    }

                    let selectedModel = resolveSelectedModel(configuration)
                    let apiToken = try await getCopilotApiToken(configuration: configuration)

                    try await streamCompletion(
                        configuration: configuration,
                        apiToken: apiToken,
                        model: selectedModel,
                        prompt: prompt,
                        context: context,
                        history: history,
                        selectedFocus: selectedFocus,
                        attachments: attachments,
                        continuation: continuation
                    )
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    private func resolveSelectedModel(_ configuration: CopilotAccountConfiguration) -> String {
        let selected = configuration.model.selected.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selected.isEmpty {
            return selected
        }
        return configuration.model.available.first?.id ?? "gpt-4o"
    }

    private func getCopilotApiToken(configuration: CopilotAccountConfiguration) async throws -> String {
        let key = configuration.account.login
        if let cached = await tokenStore.get(for: key) {
            return cached
        }

        var request = URLRequest(url: copilotTokenURL)
        request.httpMethod = "GET"
        request.setValue("Bearer \(configuration.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CopilotResponseError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode),
              let payload = try? JSONDecoder().decode(CopilotApiTokenResponse.self, from: data),
              let token = payload.token?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw CopilotResponseError.upstreamStatus(http.statusCode, body)
        }

        let expiresAt = payload.expiresAt.map { TimeInterval($0) } ?? (Date().timeIntervalSince1970 + 600)
        await tokenStore.set(token, expiresAt: expiresAt, for: key)
        return token
    }

    private func streamCompletion(
        configuration: CopilotAccountConfiguration,
        apiToken: String,
        model: String,
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String,
        attachments: [PanelAttachment],
        continuation: AsyncThrowingStream<String, Error>.Continuation
    ) async throws {
        let finalPrompt = buildPrompt(
            prompt: prompt,
            context: context,
            history: history,
            selectedFocus: selectedFocus
        )
        let systemPrompt = appendCustomSystemPrompt(
            basePrompt: "你是集成在 Safari 页面里的中文助理。回答必须简洁、准确、面向当前页面任务，不要编造页面中不存在的信息。若有页面选中内容，请优先解释选中内容，再结合整页内容回答。"
        )

        var request = URLRequest(url: copilotCompletionsURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
        request.setValue("anti-api/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue("vscode/1.95.0", forHTTPHeaderField: "Editor-Version")
        request.setValue("copilot/1.300.0", forHTTPHeaderField: "Editor-Plugin-Version")
        request.httpBody = try JSONSerialization.data(withJSONObject: buildRequestBody(
            model: model,
            systemPrompt: systemPrompt,
            prompt: finalPrompt,
            attachments: attachments
        ))

        let (asyncBytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CopilotResponseError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            var body = Data()
            for try await byte in asyncBytes {
                body.append(byte)
            }
            let text = String(data: body, encoding: .utf8) ?? "unknown"
            throw CopilotResponseError.upstreamStatus(http.statusCode, text)
        }

        var sawText = false
        var lineBuffer = Data()

        for try await byte in asyncBytes {
            if byte == UInt8(ascii: "\n") {
                if let line = String(data: lineBuffer, encoding: .utf8),
                   let chunk = parseStreamLine(line) {
                    continuation.yield(chunk)
                    sawText = true
                }
                lineBuffer.removeAll(keepingCapacity: true)
            } else {
                lineBuffer.append(byte)
            }
        }

        if !lineBuffer.isEmpty,
           let line = String(data: lineBuffer, encoding: .utf8),
           let chunk = parseStreamLine(line) {
            continuation.yield(chunk)
            sawText = true
        }

        if !sawText {
            await tokenStore.invalidate(for: configuration.account.login)
            throw CopilotResponseError.emptyContent
        }
    }

    private func buildRequestBody(
        model: String,
        systemPrompt: String,
        prompt: String,
        attachments: [PanelAttachment]
    ) -> [String: Any] {
        [
            "model": model,
            "stream": true,
            "temperature": 0.7,
            "messages": [
                [
                    "role": "system",
                    "content": systemPrompt,
                ],
                [
                    "role": "user",
                    "content": buildUserContent(prompt: prompt, attachments: attachments),
                ],
            ],
        ]
    }

    private func buildUserContent(prompt: String, attachments: [PanelAttachment]) -> Any {
        guard attachments.contains(where: { $0.kind == "image" && $0.mimeType.hasPrefix("image/") }) else {
            return prompt
        }

        var content: [[String: Any]] = [
            [
                "type": "text",
                "text": prompt,
            ]
        ]
        content += attachments.compactMap { attachment in
            guard attachment.kind == "image", attachment.mimeType.hasPrefix("image/") else {
                return nil
            }
            return [
                "type": "image_url",
                "image_url": [
                    "url": attachment.dataURL,
                ],
            ]
        }
        return content
    }

    private func buildPrompt(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String
    ) -> String {
        var sections = [String]()

        if let context {
            sections.append("site: \(context.site)")
            sections.append("title: \(context.title)")
            if !context.url.isEmpty { sections.append("url: \(context.url)") }
            if !context.selection.isEmpty { sections.append("selection: \(context.selection)") }
            if !selectedFocus.isEmpty { sections.append("selected_focus: \(selectedFocus)") }
            if let pageKind = context.metadata["pageKind"], !pageKind.isEmpty {
                sections.append("page_kind: \(pageKind)")
            }
            if let visualSummary = context.visualSummary, !visualSummary.isEmpty {
                sections.append("visual_summary:\n\(visualSummary)")
            }
            if let structureSummary = context.structureSummary, !structureSummary.isEmpty {
                sections.append("structure_summary:\n\(structureSummary)")
            }
            if let interactiveSummary = context.interactiveSummary, !interactiveSummary.isEmpty {
                sections.append("interactive_summary:\n\(interactiveSummary)")
            }
            if !context.articleText.isEmpty {
                sections.append("article_text:\n\(context.articleText)")
            }
        }

        if !history.isEmpty {
            let historyText = history.suffix(6)
                .map { message in
                    let attachmentSummary = summarizeAttachments(message.attachments)
                    return "[\(message.role)/\(message.kind)] \(message.text)\(attachmentSummary)"
                }
                .joined(separator: "\n")
            sections.append("recent_conversation:\n\(historyText)")
        }

        sections.append("user_prompt: \(prompt)")
        return sections.joined(separator: "\n\n")
    }

    private func summarizeAttachments(_ attachments: [PanelAttachment]?) -> String {
        let imageNames = (attachments ?? []).filter { $0.kind == "image" }.map(\.filename)
        guard !imageNames.isEmpty else {
            return ""
        }
        return " [attachments: \(imageNames.joined(separator: ", "))]"
    }

    private func normalizeModels(_ models: [CopilotRemoteModel]) -> [CopilotModelSummary] {
        var seen = Set<String>()
        var normalized: [CopilotModelSummary] = []

        for model in models {
            let id = model.id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !id.isEmpty, model.modelPickerEnabled != false, !seen.contains(id) else {
                continue
            }
            seen.insert(id)
            let label = model.name?.trimmingCharacters(in: .whitespacesAndNewlines)
            normalized.append(CopilotModelSummary(id: id, label: label?.isEmpty == false ? label! : id))
        }

        return normalized
    }

    private func parseStreamLine(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:") else {
            return nil
        }

        let payload = trimmed.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
        guard payload != "[DONE]", let data = payload.data(using: .utf8) else {
            return nil
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        if let choices = json["choices"] as? [[String: Any]],
           let first = choices.first {
            if let delta = first["delta"] as? [String: Any],
               let content = delta["content"] as? String,
               !content.isEmpty {
                return content
            }
            if let message = first["message"] as? [String: Any],
               let content = message["content"] as? String,
               !content.isEmpty {
                return content
            }
        }

        return nil
    }
}
