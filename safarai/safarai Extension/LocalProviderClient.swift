import Foundation

struct LocalProviderClient {
    private let config: ProviderConfig
    private let session: URLSession
    private let baseURL = URL(string: "https://chatgpt.com/backend-api/codex")!
    private let authURL = URL(string: "https://auth.openai.com/oauth/token")!
    private let retryStatuses: Set<Int> = [429, 500, 502, 503, 504, 521, 522, 524]

    init(config: ProviderConfig) {
        self.config = config
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = 30
        sessionConfig.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: sessionConfig)
    }

    func run(requestType: String, context: [String: Any], requestId: String) throws -> [String: Any] {
        switch requestType {
        case "get_status":
            return statusPayload(requestId: requestId)
        default:
            return try runAction(requestType: requestType, context: context, requestId: requestId)
        }
    }

    private func runAction(requestType: String, context: [String: Any], requestId: String) throws -> [String: Any] {
        guard let account = config.account, var tokens = config.tokens, !tokens.accessToken.isEmpty else {
            throw ProviderError.notLoggedIn
        }

        if shouldRefresh(tokens.expiresAt) {
            tokens = try refreshTokens(tokens)
        }

        let responseText: String
        do {
            responseText = try requestResponse(
                requestType: requestType,
                context: context,
                accountId: account.accountId,
                accessToken: tokens.accessToken,
                model: config.selectedModel,
                reasoningEffort: config.reasoningEffort
            )
        } catch ProviderError.authRejected {
            tokens = try refreshTokens(tokens)
            responseText = try requestResponse(
                requestType: requestType,
                context: context,
                accountId: account.accountId,
                accessToken: tokens.accessToken,
                model: config.selectedModel,
                reasoningEffort: config.reasoningEffort
            )
        }

        let answer: String
        let draft: Any
        if requestType == "draft_for_input" {
            answer = "已通过 Codex 生成当前输入框草稿，请确认后再写入页面。"
            draft = responseText
        } else {
            answer = responseText
            draft = NSNull()
        }

        return [
            "ok": true,
            "payload": [
                "request_id": requestId,
                "answer": answer,
                "draft": draft,
                "authState": config.authState,
                "selectedModel": config.selectedModel,
            ],
        ]
    }

    private func statusPayload(requestId: String) -> [String: Any] {
        let payload: [String: Any] = [
            "request_id": requestId,
            "authState": config.authState,
            "selectedModel": config.selectedModel,
            "email": config.account?.email as Any,
            "availableModels": config.availableModels.map { ["id": $0.id, "label": $0.label] },
        ]

        return [
            "ok": true,
            "payload": payload,
        ]
    }

    private func shouldRefresh(_ expiresAt: TimeInterval?) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt - Date().timeIntervalSince1970 < 120
    }

    private func refreshTokens(_ tokens: CodexAccountConfigurationFile.Tokens) throws -> CodexAccountConfigurationFile.Tokens {
        guard !tokens.refreshToken.isEmpty else {
            throw ProviderError.notLoggedIn
        }

        var request = URLRequest(url: authURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = URLComponents.formURLEncoded([
            "grant_type": "refresh_token",
            "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
            "refresh_token": tokens.refreshToken,
        ]).data(using: .utf8)

        let (data, response) = try perform(request)
        guard (200..<300).contains(response.statusCode) else {
            throw ProviderError.refreshFailed(String(data: data, encoding: .utf8) ?? "unknown")
        }

        guard let decoded = try? JSONDecoder().decode(TokenResponse.self, from: data),
              let accessToken = decoded.accessToken else {
            throw ProviderError.invalidResponse
        }

        guard var file = loadConfigFile() else {
            throw ProviderError.invalidResponse
        }

        file.tokens.accessToken = accessToken
        file.tokens.refreshToken = decoded.refreshToken ?? file.tokens.refreshToken
        file.tokens.idToken = decoded.idToken ?? file.tokens.idToken
        file.tokens.expiresAt = decoded.expiresIn.map { Date().timeIntervalSince1970 + Double($0) }
        try ProviderConfig.save(file)
        return file.tokens
    }

    private func requestResponse(
        requestType: String,
        context: [String: Any],
        accountId: String,
        accessToken: String,
        model: String,
        reasoningEffort: String
    ) throws -> String {
        let requestBody = buildRequestBody(
            requestType: requestType,
            context: context,
            model: model,
            reasoningEffort: reasoningEffort
        )

        var request = URLRequest(url: baseURL.appendingPathComponent("responses"))
        request.httpMethod = "POST"
        request.allHTTPHeaderFields = [
            "Content-Type": "application/json",
            "Authorization": "Bearer \(accessToken)",
            "Accept": "text/event-stream",
            "Connection": "Keep-Alive",
            "Openai-Beta": "responses=experimental",
            "User-Agent": "codex_cli_rs/0.50.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
            "Originator": "codex_cli_rs",
            "Version": "0.21.0",
            "Chatgpt-Account-Id": accountId,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: requestBody)

        var lastError: Error?
        for attempt in 0...2 {
            do {
                let (data, response) = try perform(request)
                guard (200..<300).contains(response.statusCode) else {
                    let message = String(data: data, encoding: .utf8) ?? "unknown"
                    if retryStatuses.contains(response.statusCode), attempt < 2 {
                        Thread.sleep(forTimeInterval: pow(2.0, Double(attempt)) * 0.6)
                        continue
                    }
                    if response.statusCode == 401 || response.statusCode == 403 {
                        throw ProviderError.authRejected
                    }
                    throw ProviderError.upstreamStatus(response.statusCode, message)
                }

                let sse = String(data: data, encoding: .utf8) ?? ""
                return try parseSSEText(sse)
            } catch {
                lastError = error
                if attempt < 2 {
                    Thread.sleep(forTimeInterval: pow(2.0, Double(attempt)) * 0.6)
                    continue
                }
            }
        }

        throw lastError ?? ProviderError.invalidResponse
    }

    private func buildRequestBody(
        requestType: String,
        context: [String: Any],
        model: String,
        reasoningEffort: String
    ) -> [String: Any] {
        let instructions = buildSystemPrompt()
        let prompt = buildPrompt(requestType: requestType, context: context)

        return [
            "model": model,
            "input": [
                [
                    "type": "message",
                    "role": "user",
                    "content": [
                        [
                            "type": "input_text",
                            "text": prompt,
                        ]
                    ],
                ]
            ],
            "instructions": instructions,
            "stream": true,
            "store": false,
            "parallel_tool_calls": true,
            "reasoning": [
                "effort": ["low", "medium", "high"].contains(reasoningEffort) ? reasoningEffort : "medium",
                "summary": "auto",
            ],
            "include": ["reasoning.encrypted_content"],
        ]
    }

    private func buildPrompt(requestType: String, context: [String: Any]) -> String {
        let title = (context["title"] as? String)?.nonEmpty ?? "当前页面"
        let site = (context["site"] as? String)?.nonEmpty ?? "unknown"
        let url = (context["url"] as? String)?.nonEmpty ?? ""
        let article = (context["articleText"] as? String)?.nonEmpty ?? ""
        let selection = (context["selection"] as? String)?.nonEmpty ?? ""
        let selectedFocus = (context["selectedFocus"] as? String)?.nonEmpty ?? selection
        let metadata = context["metadata"] as? [String: Any]
        let pageKind = (metadata?["pageKind"] as? String)?.nonEmpty ?? "unknown_page"
        let repository = (metadata?["repository"] as? String)?.nonEmpty
        let target = ((context["writeTarget"] as? [String: Any])?["description"] as? String)?.nonEmpty
        let userPrompt = (context["userPrompt"] as? String)?.nonEmpty
        let structureSummary = (context["structureSummary"] as? String)?.nonEmpty
        let interactiveSummary = (context["interactiveSummary"] as? String)?.nonEmpty
        let history = context["conversationHistory"] as? [[String: Any]] ?? []

        var sections = [
            "site: \(site)",
            "page_kind: \(pageKind)",
            "title: \(title)",
        ]
        if let repository { sections.append("repository: \(repository)") }
        if !url.isEmpty { sections.append("url: \(url)") }
        if !selection.isEmpty { sections.append("selection: \(selection)") }
        if !selectedFocus.isEmpty { sections.append("selected_focus: \(selectedFocus)") }
        if let target { sections.append("write_target: \(target)") }
        if !history.isEmpty {
            let historyText = history.suffix(6).map { item in
                let role = (item["role"] as? String) ?? "unknown"
                let kind = (item["kind"] as? String) ?? "message"
                let text = (item["text"] as? String) ?? ""
                return "[\(role)/\(kind)] \(text)"
            }.joined(separator: "\n")
            sections.append("recent_conversation:\n\(historyText)")
        }
        if let structureSummary { sections.append("structure_summary:\n\(structureSummary)") }
        if let interactiveSummary { sections.append("interactive_summary:\n\(interactiveSummary)") }
        if !article.isEmpty { sections.append("article_text:\n\(article)") }

        let header: String
        switch requestType {
        case "summarize_page":
            header = selectedFocus.isEmpty
                ? "请用中文简洁总结下面页面，聚焦关键信息与结论。"
                : "请用中文简洁总结下面页面，聚焦关键信息与结论，并特别说明选中内容在页面中的意义。"
        case "explain_selection":
            header = "请用中文解释用户选中的文本，并结合页面上下文说明含义。若存在选中内容，请把它当成重点。"
        case "extract_structured_info":
            header = selectedFocus.isEmpty
                ? "请用中文把当前页面提取成结构化要点，输出格式固定为：主题、关键实体、关键信息、后续动作。每项使用简洁项目符号。"
                : "请用中文把当前页面提取成结构化要点，输出格式固定为：主题、关键实体、关键信息、后续动作。若存在选中内容，请单独补充其要点。每项使用简洁项目符号。"
        case "draft_for_input":
            header = "请用中文为当前输入框生成一份可直接粘贴的草稿，保持克制、清晰、可执行，不要添加解释。"
        case "ask_page":
            header = selectedFocus.isEmpty
                ? "请基于当前页面上下文和最近会话，用中文直接回答用户问题。"
                : "请基于当前页面上下文和最近会话，用中文直接回答用户问题。若存在选中内容，请先单独解释选中内容，再结合整页内容给出完整回答。"
        default:
            header = "请根据上下文回答。"
        }

        let promptSection = userPrompt.map { ["user_prompt: \($0)"] } ?? []
        return ([header] + promptSection + sections).joined(separator: "\n\n")
    }

    private func buildSystemPrompt() -> String {
        let basePrompt = "你是集成在 Safari 页面里的中文助理。回答必须简洁、准确、面向当前页面任务，不要编造页面中不存在的信息。"
        guard !config.customSystemPrompt.isEmpty else {
            return basePrompt
        }

        return """
\(basePrompt)

用户附加系统提示:
\(config.customSystemPrompt)
"""
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
            throw ProviderError.emptyContent
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

    private func perform(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<(Data, HTTPURLResponse), Error>?

        let task = session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error {
                result = .failure(error)
                return
            }
            guard let data, let http = response as? HTTPURLResponse else {
                result = .failure(ProviderError.invalidResponse)
                return
            }
            result = .success((data, http))
        }
        task.resume()
        semaphore.wait()

        switch result {
        case .success(let value):
            return value
        case .failure(let error):
            throw error
        case .none:
            throw ProviderError.invalidResponse
        }
    }

    private func loadConfigFile() -> CodexAccountConfigurationFile? {
        let url = ProviderConfig.configFileURL()
        guard
            let data = try? Data(contentsOf: url),
            let decoded = try? JSONDecoder().decode(CodexAccountConfigurationFile.self, from: data)
        else {
            return nil
        }
        return decoded
    }
}

enum ProviderError: LocalizedError {
    case notLoggedIn
    case authRejected
    case invalidResponse
    case upstreamStatus(Int, String)
    case emptyContent
    case refreshFailed(String)

    var errorDescription: String? {
        switch self {
        case .notLoggedIn:
            return "请先在宿主 App 中登录 Codex。"
        case .authRejected:
            return "Codex 认证已失效，请重新登录。"
        case .invalidResponse:
            return "Codex 响应无效。"
        case .upstreamStatus(let status, let body):
            return "Codex 请求失败（\(status)）：\(body)"
        case .emptyContent:
            return "Codex 未返回可用内容。"
        case .refreshFailed(let message):
            return "Codex token 刷新失败：\(message)"
        }
    }
}

private struct TokenResponse: Decodable {
    let accessToken: String?
    let refreshToken: String?
    let idToken: String?
    let expiresIn: Int?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case idToken = "id_token"
        case expiresIn = "expires_in"
    }
}

private extension URLComponents {
    static func formURLEncoded(_ items: [String: String]) -> String {
        var components = URLComponents()
        components.queryItems = items.map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.percentEncodedQuery ?? ""
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
