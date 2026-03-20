import Foundation

enum CodexResponseError: LocalizedError {
    case notLoggedIn
    case invalidResponse
    case upstreamStatus(Int, String)
    case emptyContent

    var errorDescription: String? {
        switch self {
        case .notLoggedIn:
            return "当前未登录 Codex。"
        case .invalidResponse:
            return "Codex 响应无效。"
        case .upstreamStatus(let status, let body):
            return "Codex 请求失败（\(status)）：\(body)"
        case .emptyContent:
            return "Codex 未返回可用内容。"
        }
    }
}

final class CodexResponseService {
    static let shared = CodexResponseService()

    private let baseURL = URL(string: "https://chatgpt.com/backend-api/codex")!
    private let session: URLSession
    private let retryStatuses: Set<Int> = [429, 500, 502, 503, 504, 521, 522, 524]

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: config)
    }

    func askQuestion(prompt: String, context: PanelContextSnapshot?, history: [PanelConversationMessage]) async throws -> String {
        guard var configuration = CodexAccountStore.load() else {
            throw CodexResponseError.notLoggedIn
        }

        configuration = try await CodexOAuthService.shared.refreshIfNeeded(configuration)

        let requestBody = buildRequestBody(
            prompt: prompt,
            context: context,
            history: history,
            model: configuration.model.selected
        )

        var request = URLRequest(url: baseURL.appendingPathComponent("responses"))
        request.httpMethod = "POST"
        request.allHTTPHeaderFields = [
            "Content-Type": "application/json",
            "Authorization": "Bearer \(configuration.tokens.accessToken)",
            "Accept": "text/event-stream",
            "Connection": "Keep-Alive",
            "Openai-Beta": "responses=experimental",
            "User-Agent": "codex_cli_rs/0.50.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
            "Originator": "codex_cli_rs",
            "Version": "0.21.0",
            "Chatgpt-Account-Id": configuration.account.accountId,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: requestBody)

        var lastError: Error?
        for attempt in 0...2 {
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw CodexResponseError.invalidResponse
                }

                guard (200..<300).contains(http.statusCode) else {
                    let message = String(data: data, encoding: .utf8) ?? "unknown"
                    if retryStatuses.contains(http.statusCode), attempt < 2 {
                        try await Task.sleep(nanoseconds: UInt64(pow(2.0, Double(attempt)) * 600_000_000))
                        continue
                    }
                    throw CodexResponseError.upstreamStatus(http.statusCode, message)
                }

                return try parseSSEText(String(data: data, encoding: .utf8) ?? "")
            } catch {
                lastError = error
                if attempt < 2 {
                    try? await Task.sleep(nanoseconds: UInt64(pow(2.0, Double(attempt)) * 600_000_000))
                    continue
                }
            }
        }

        throw lastError ?? CodexResponseError.invalidResponse
    }

    private func buildRequestBody(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        model: String
    ) -> [String: Any] {
        let instructions = "你是集成在 Safari 页面里的中文助理。回答必须简洁、准确、面向当前页面任务，不要编造页面中不存在的信息。若有页面选中内容，请优先解释选中内容，再结合整页内容回答。"
        var sections = [String]()

        if let context {
            sections.append("site: \(context.site)")
            sections.append("title: \(context.title)")
            if !context.url.isEmpty { sections.append("url: \(context.url)") }
            if !context.selection.isEmpty { sections.append("selected_focus: \(context.selection)") }
            if let pageKind = context.metadata["pageKind"], !pageKind.isEmpty { sections.append("page_kind: \(pageKind)") }
            if let visualSummary = context.visualSummary, !visualSummary.isEmpty {
                sections.append("visual_summary:\n\(visualSummary)")
            }
            if !context.articleText.isEmpty { sections.append("article_text:\n\(context.articleText)") }
        }

        if !history.isEmpty {
            let historyText = history.suffix(6).map { "[\($0.role)/\($0.kind)] \($0.text)" }.joined(separator: "\n")
            sections.append("recent_conversation:\n\(historyText)")
        }

        sections.append("user_prompt: \(prompt)")
        let finalPrompt = sections.joined(separator: "\n\n")

        return [
            "model": model,
            "input": [
                [
                    "type": "message",
                    "role": "user",
                    "content": [
                        [
                            "type": "input_text",
                            "text": finalPrompt,
                        ]
                    ],
                ]
            ],
            "instructions": instructions,
            "stream": true,
            "store": false,
            "parallel_tool_calls": true,
            "reasoning": [
                "effort": "medium",
                "summary": "auto",
            ],
            "include": ["reasoning.encrypted_content"],
        ]
    }

    private func parseSSEText(_ text: String) throws -> String {
        let lines = text.split(separator: "\n")
        var chunks: [String] = []

        for line in lines {
            guard line.hasPrefix("data:") else { continue }
            let value = line.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
            guard value != "[DONE]", let data = value.data(using: .utf8) else { continue }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }

            if let type = json["type"] as? String, type == "response.completed",
               let response = json["response"] as? [String: Any],
               let parsed = parseCompletedResponse(response) {
                return parsed
            }

            if let outputText = json["output_text"] as? String, !outputText.isEmpty {
                chunks.append(outputText)
            } else if let delta = json["delta"] as? String, let type = json["type"] as? String, type.contains("output_text") {
                chunks.append(delta)
            } else if let textValue = json["text"] as? String, let type = json["type"] as? String, type.contains("output_text") {
                chunks.append(textValue)
            }
        }

        let combined = chunks.joined()
        guard !combined.isEmpty else {
            throw CodexResponseError.emptyContent
        }
        return combined
    }

    private func parseCompletedResponse(_ response: [String: Any]) -> String? {
        guard let output = response["output"] as? [[String: Any]] else {
            return nil
        }

        var texts: [String] = []
        for item in output {
            if item["type"] as? String == "message",
               let content = item["content"] as? [[String: Any]] {
                for block in content {
                    if let type = block["type"] as? String,
                       (type == "output_text" || type == "text"),
                       let text = block["text"] as? String,
                       !text.isEmpty {
                        texts.append(text)
                    }
                }
            } else if item["type"] as? String == "output_text",
                      let text = item["text"] as? String,
                      !text.isEmpty {
                texts.append(text)
            }
        }

        let value = texts.joined()
        return value.isEmpty ? nil : value
    }
}
