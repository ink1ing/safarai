import Foundation
import SQLite3

// MARK: - Token Cache Actor

private actor LLMTokenStore {
    private var cache: (token: String, fetchedAt: Date)?

    func get(forceRefresh: Bool) -> String? {
        guard !forceRefresh, let c = cache else { return nil }
        guard Date().timeIntervalSince(c.fetchedAt) < 15 * 60 else { return nil }
        return c.token
    }

    func set(token: String) {
        cache = (token: token, fetchedAt: Date())
    }

    func invalidate() {
        cache = nil
    }
}

// MARK: - Errors

enum ZedResponseError: LocalizedError {
    case notLoggedIn
    case invalidResponse
    case upstreamStatus(Int, String)
    case emptyContent

    var errorDescription: String? {
        switch self {
        case .notLoggedIn:
            return "当前未登录 Zed。"
        case .invalidResponse:
            return "Zed 响应无效。"
        case .upstreamStatus(let status, let body):
            return "Zed 请求失败（\(status)）：\(body)"
        case .emptyContent:
            return "Zed 未返回可用内容。"
        }
    }
}

// MARK: - Service

final class ZedResponseService {
    static let shared = ZedResponseService()

    private let session: URLSession
    private let tokenStore = LLMTokenStore()

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config)
    }

    // MARK: - Public API (streaming)

    /// Returns an AsyncThrowingStream that yields text chunks as they arrive.
    func streamQuestion(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String = ""
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    guard let configuration = ZedAccountStore.load() else {
                        throw ZedResponseError.notLoggedIn
                    }
                    let model = try resolveModel(configuration: configuration)
                    let llmToken = try await fetchLLMToken(configuration: configuration, forceRefresh: false)
                    try await streamCompletion(
                        prompt: prompt,
                        context: context,
                        history: history,
                        selectedFocus: selectedFocus,
                        model: model,
                        configuration: configuration,
                        llmToken: llmToken,
                        retryOnExpiry: true,
                        continuation: continuation
                    )
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Model Resolution

    private func resolveModel(configuration: ZedAccountConfiguration) throws -> ZedModelSummary {
        let selectedId = configuration.model.selected
        if let found = configuration.model.available.first(where: { $0.id == selectedId }) {
            return found
        }
        if let first = configuration.model.available.first {
            return first
        }
        throw ZedResponseError.invalidResponse
    }

    // MARK: - Fetch Models

    func fetchModels(configuration: ZedAccountConfiguration) async throws -> [ZedModelSummary] {
        let llmToken = try await fetchLLMToken(configuration: configuration, forceRefresh: false)

        var request = URLRequest(url: URL(string: "https://cloud.zed.dev/models")!)
        request.httpMethod = "GET"
        request.setValue("Bearer \(llmToken)", forHTTPHeaderField: "Authorization")
        request.setValue("true", forHTTPHeaderField: "x-zed-client-supports-x-ai")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ZedResponseError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw ZedResponseError.upstreamStatus(http.statusCode, body)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let modelsArray = json["models"] as? [[String: Any]] else {
            throw ZedResponseError.invalidResponse
        }

        return modelsArray.compactMap { dict -> ZedModelSummary? in
            guard let id = dict["id"] as? String,
                  let provider = dict["provider"] as? String else { return nil }
            let label = dict["display_name"] as? String ?? id
            return ZedModelSummary(id: id, label: label, provider: provider)
        }
    }

    // MARK: - LLM Token

    private func fetchLLMToken(
        configuration: ZedAccountConfiguration,
        forceRefresh: Bool
    ) async throws -> String {
        if let cached = await tokenStore.get(forceRefresh: forceRefresh) {
            return cached
        }

        let url = URL(string: "https://cloud.zed.dev/client/llm_tokens")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(
            "\(configuration.account.userId) \(configuration.accessToken)",
            forHTTPHeaderField: "Authorization"
        )

        if let systemId = readZedSystemId() {
            request.setValue(systemId, forHTTPHeaderField: "x-zed-system-id")
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: [:])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ZedResponseError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw ZedResponseError.upstreamStatus(http.statusCode, body)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String ?? json["llm_token"] as? String,
              !token.isEmpty else {
            throw ZedResponseError.invalidResponse
        }

        await tokenStore.set(token: token)
        return token
    }

    private func invalidateTokenCache() async {
        await tokenStore.invalidate()
    }

    // MARK: - SQLite System ID

    private func readZedSystemId() -> String? {
        let dbPath = NSHomeDirectory() + "/Library/Application Support/Zed/db/0-global/db.sqlite"
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_close(db) }

        var statement: OpaquePointer?
        let query = "SELECT value FROM key_value_store WHERE key = 'system_id' LIMIT 1"
        guard sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }

        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        if let cString = sqlite3_column_text(statement, 0) {
            return String(cString: cString)
        }
        return nil
    }

    // MARK: - Streaming Completion

    private func streamCompletion(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String,
        model: ZedModelSummary,
        configuration: ZedAccountConfiguration,
        llmToken: String,
        retryOnExpiry: Bool,
        continuation: AsyncThrowingStream<String, Error>.Continuation
    ) async throws {
        let systemPrompt = appendCustomSystemPrompt(
            basePrompt: "你是集成在 Safari 页面里的中文助理。回答必须简洁、准确、面向当前页面任务，不要编造页面中不存在的信息。若有页面选中内容，请优先解释选中内容，再结合整页内容回答。"
        )
        let finalPrompt = buildPrompt(prompt: prompt, context: context, history: history, selectedFocus: selectedFocus)

        let bodyDict: [String: Any] = [
            "provider": model.provider,
            "model": model.id,
            "provider_request": buildProviderRequest(model: model, prompt: finalPrompt, systemPrompt: systemPrompt)
        ]

        var request = URLRequest(url: URL(string: "https://cloud.zed.dev/completions")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(llmToken)", forHTTPHeaderField: "Authorization")
        request.setValue("true", forHTTPHeaderField: "x-zed-client-supports-status-messages")
        request.setValue("true", forHTTPHeaderField: "x-zed-client-supports-stream-ended-request-completion-status")
        request.httpBody = try JSONSerialization.data(withJSONObject: bodyDict)

        let (asyncBytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ZedResponseError.invalidResponse
        }

        // Token expiry: collect a small buffer to check headers, then retry
        let headers = http.allHeaderFields
        let expiredToken = headers["x-zed-expired-token"] != nil
        let outdatedToken = headers["x-zed-outdated-token"] != nil

        if (expiredToken || outdatedToken) && retryOnExpiry {
            await invalidateTokenCache()
            let freshToken = try await fetchLLMToken(configuration: configuration, forceRefresh: true)
            try await streamCompletion(
                prompt: prompt,
                context: context,
                history: history,
                selectedFocus: selectedFocus,
                model: model,
                configuration: configuration,
                llmToken: freshToken,
                retryOnExpiry: false,
                continuation: continuation
            )
            return
        }

        guard (200..<300).contains(http.statusCode) else {
            // Drain body for error message
            var bodyData = Data()
            for try await byte in asyncBytes {
                bodyData.append(byte)
            }
            let body = String(data: bodyData, encoding: .utf8) ?? "unknown"
            throw ZedResponseError.upstreamStatus(http.statusCode, body)
        }

        let supportsStatusMessages = headers["x-zed-server-supports-status-messages"] != nil
        var receivedAny = false

        // Read line by line from the byte stream.
        // Buffer raw bytes and decode as UTF-8 per line to avoid mojibake
        // that occurs when treating each byte as a Character (UnicodeScalar).
        var lineBuffer = Data()
        for try await byte in asyncBytes {
            if byte == UInt8(ascii: "\n") {
                if let line = String(data: lineBuffer, encoding: .utf8) {
                    if let chunk = parseLine(line, provider: model.provider, supportsStatusMessages: supportsStatusMessages) {
                        continuation.yield(chunk)
                        receivedAny = true
                    }
                }
                lineBuffer.removeAll(keepingCapacity: true)
            } else {
                lineBuffer.append(byte)
            }
        }
        // Handle any trailing line without newline
        if !lineBuffer.isEmpty {
            if let line = String(data: lineBuffer, encoding: .utf8),
               let chunk = parseLine(line, provider: model.provider, supportsStatusMessages: supportsStatusMessages) {
                continuation.yield(chunk)
                receivedAny = true
            }
        }

        if !receivedAny {
            throw ZedResponseError.emptyContent
        }
    }

    // MARK: - Line Parser

    private func parseLine(_ raw: String, provider: String, supportsStatusMessages: Bool) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let jsonString: String
        if supportsStatusMessages {
            jsonString = trimmed
        } else {
            guard trimmed.hasPrefix("data:") else { return nil }
            let value = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard value != "[DONE]" else { return nil }
            jsonString = value
        }

        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        if supportsStatusMessages {
            if let event = json["event"] as? [String: Any] {
                return extractChunk(from: event, provider: provider)
            }
            if json["status"] != nil { return nil }
        }

        return extractChunk(from: json, provider: provider)
    }

    // MARK: - Prompt Builder

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
                .map { "[\($0.role)/\($0.kind)] \($0.text)" }
                .joined(separator: "\n")
            sections.append("recent_conversation:\n\(historyText)")
        }

        sections.append("user_prompt: \(prompt)")
        return sections.joined(separator: "\n\n")
    }

    // MARK: - Provider Request Builder

    private func buildProviderRequest(
        model: ZedModelSummary,
        prompt: String,
        systemPrompt: String
    ) -> [String: Any] {
        switch model.provider {
        case "anthropic":
            return [
                "model": model.id,
                "max_tokens": 4096,
                "stream": true,
                "messages": [
                    [
                        "role": "user",
                        "content": [["type": "text", "text": prompt]]
                    ]
                ],
                "system": systemPrompt
            ]
        case "open_ai":
            return [
                "model": model.id,
                "stream": true,
                "store": false,
                "input": [
                    [
                        "type": "message",
                        "role": "user",
                        "content": [["type": "input_text", "text": prompt]]
                    ]
                ],
                "instructions": systemPrompt
            ]
        case "google":
            return [
                "model": model.id,
                "stream": true,
                "contents": [
                    ["role": "user", "parts": [["text": prompt]]]
                ],
                "systemInstruction": ["parts": [["text": systemPrompt]]],
                "generationConfig": ["maxOutputTokens": 4096]
            ]
        case "x_ai":
            return [
                "model": model.id,
                "stream": true,
                "messages": [
                    ["role": "system", "content": systemPrompt],
                    ["role": "user", "content": prompt]
                ]
            ]
        default:
            return [
                "model": model.id,
                "stream": true,
                "messages": [
                    ["role": "system", "content": systemPrompt],
                    ["role": "user", "content": prompt]
                ]
            ]
        }
    }

    // MARK: - Chunk Extractors

    private func extractChunk(from json: [String: Any], provider: String) -> String? {
        switch provider {
        case "anthropic": return extractAnthropicChunk(from: json)
        case "open_ai":   return extractOpenAIChunk(from: json)
        case "google":    return extractGoogleChunk(from: json)
        case "x_ai":      return extractXAIChunk(from: json)
        default:
            return extractXAIChunk(from: json)
                ?? extractAnthropicChunk(from: json)
                ?? extractOpenAIChunk(from: json)
                ?? extractGoogleChunk(from: json)
        }
    }

    private func extractAnthropicChunk(from json: [String: Any]) -> String? {
        guard let type = json["type"] as? String, type == "content_block_delta",
              let delta = json["delta"] as? [String: Any],
              delta["type"] as? String == "text_delta",
              let text = delta["text"] as? String, !text.isEmpty else { return nil }
        return text
    }

    private func extractOpenAIChunk(from json: [String: Any]) -> String? {
        if let type = json["type"] as? String, type == "response.output_text.delta",
           let delta = json["delta"] as? String, !delta.isEmpty { return delta }
        if let type = json["type"] as? String, type == "response.output_text.done",
           let text = json["text"] as? String, !text.isEmpty { return text }
        return nil
    }

    private func extractGoogleChunk(from json: [String: Any]) -> String? {
        guard let candidates = json["candidates"] as? [[String: Any]] else { return nil }
        var texts: [String] = []
        for candidate in candidates {
            if let content = candidate["content"] as? [String: Any],
               let parts = content["parts"] as? [[String: Any]] {
                for part in parts {
                    if let text = part["text"] as? String, !text.isEmpty { texts.append(text) }
                }
            }
        }
        let combined = texts.joined()
        return combined.isEmpty ? nil : combined
    }

    private func extractXAIChunk(from json: [String: Any]) -> String? {
        guard let choices = json["choices"] as? [[String: Any]],
              let first = choices.first,
              let delta = first["delta"] as? [String: Any],
              let content = delta["content"] as? String, !content.isEmpty else { return nil }
        return content
    }
}
