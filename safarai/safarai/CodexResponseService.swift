import Foundation

private struct AgentResponseAccumulator {
    var responseID: String?
    var completedResponse: [String: Any]?
    var outputItems: [Int: [String: Any]] = [:]
    var orderedIndices: [Int] = []
    var functionArgumentBuffers: [String: String] = [:]

    mutating func registerOutputItem(index: Int, item: [String: Any]) {
        outputItems[index] = merge(item, into: outputItems[index] ?? [:])
        if !orderedIndices.contains(index) {
            orderedIndices.append(index)
            orderedIndices.sort()
        }
    }

    mutating func appendFunctionArguments(identifier: String, delta: String) {
        functionArgumentBuffers[identifier, default: ""] += delta
    }

    mutating func finalizeFunctionArguments(identifier: String, arguments: String) {
        functionArgumentBuffers[identifier] = arguments
    }

    func buildResponse() -> [String: Any]? {
        if let completedResponse {
            return completedResponse
        }
        guard !outputItems.isEmpty else {
            return nil
        }

        let normalizedOutput = orderedIndices.compactMap { index -> [String: Any]? in
            guard var item = outputItems[index] else {
                return nil
            }
            let identifier = String(describing: item["call_id"] ?? item["item_id"] ?? index)
            if item["type"] as? String == "function_call",
               let bufferedArguments = functionArgumentBuffers[identifier],
               !bufferedArguments.isEmpty {
                item["arguments"] = bufferedArguments
            }
            return item
        }

        return [
            "id": responseID as Any,
            "output": normalizedOutput,
        ]
    }

    private func merge(_ incoming: [String: Any], into existing: [String: Any]) -> [String: Any] {
        var merged = existing
        for (key, value) in incoming {
            if !(value is NSNull) {
                merged[key] = value
            }
        }
        return merged
    }
}

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
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config)
    }

    // MARK: - Public API (streaming)

    func createAgentResponse(
        input: [[String: Any]],
        tools: [[String: Any]],
        previousResponseId: String? = nil,
        fallbackInput: [[String: Any]]? = nil
    ) async throws -> [String: Any] {
        guard var configuration = CodexAccountStore.load() else {
            throw CodexResponseError.notLoggedIn
        }
        configuration = try await CodexOAuthService.shared.refreshIfNeeded(configuration)

        var body: [String: Any] = [
            "model": "gpt-5.4",
            "input": input,
            "tools": tools,
            "tool_choice": "auto",
            "stream": true,
            "store": false,
            "parallel_tool_calls": false,
            "reasoning": ["effort": "medium", "summary": "auto"],
            "instructions": """
你是 Safari 页内 agent。必须优先通过工具获取页面事实，再决定动作。
只能使用当前提供的白名单工具，不能假设工具之外的能力。
你可以自动执行已注册的工具与脚本，但绝不允许自动提交表单。
优先读取页面和标签页状态，再做点击、导航、写入或脚本动作。
当用户要求你打开邮箱、网站、标签页或读取某个站点内容时，除非涉及登录凭据输入，否则不要让用户手动打开 Safari；如果 Safari 没有窗口或当前不在目标站点，应优先自己使用 open_tab / navigate_tab 打开目标地址。
如果 list_safari_windows_tabs 返回空窗口数组，视为“Safari 还没打开页面”，不是失败；下一步应主动打开目标站点。
禁止编造页面状态、标签页状态或脚本执行结果。
""",
        ]
        _ = previousResponseId
        _ = fallbackInput
        return try await performAgentResponseRequest(body: body, configuration: configuration)
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
                    guard var configuration = CodexAccountStore.load() else {
                        throw CodexResponseError.notLoggedIn
                    }
                    configuration = try await CodexOAuthService.shared.refreshIfNeeded(configuration)
                    try await self.streamCompletion(
                        prompt: prompt,
                        context: context,
                        history: history,
                        selectedFocus: selectedFocus,
                        attachments: attachments,
                        configuration: configuration,
                        attempt: 0,
                        continuation: continuation
                    )
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Streaming Completion

    private func streamCompletion(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String,
        attachments: [PanelAttachment],
        configuration: CodexAccountConfiguration,
        attempt: Int,
        continuation: AsyncThrowingStream<String, Error>.Continuation
    ) async throws {
        let requestBody = buildRequestBody(
            prompt: prompt,
            context: context,
            history: history,
            selectedFocus: selectedFocus,
            attachments: attachments,
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

        let (asyncBytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CodexResponseError.invalidResponse
        }

        // Retryable status codes
        if retryStatuses.contains(http.statusCode) && attempt < 2 {
            // Drain to avoid resource leaks
            for try await _ in asyncBytes {}
            try await Task.sleep(nanoseconds: UInt64(pow(2.0, Double(attempt)) * 600_000_000))
            try await streamCompletion(
                prompt: prompt,
                context: context,
                history: history,
                selectedFocus: selectedFocus,
                attachments: attachments,
                configuration: configuration,
                attempt: attempt + 1,
                continuation: continuation
            )
            return
        }

        guard (200..<300).contains(http.statusCode) else {
            var bodyData = Data()
            for try await byte in asyncBytes { bodyData.append(byte) }
            let message = String(data: bodyData, encoding: .utf8) ?? "unknown"
            throw CodexResponseError.upstreamStatus(http.statusCode, message)
        }

        var receivedAny = false
        var sawTextDelta = false
        // Buffer raw bytes and decode as UTF-8 per line to avoid mojibake
        // that occurs when treating each byte as a Character (UnicodeScalar).
        var lineBuffer = Data()

        for try await byte in asyncBytes {
            if byte == UInt8(ascii: "\n") {
                if let line = String(data: lineBuffer, encoding: .utf8) {
                    if let chunk = parseLine(line, sawTextDelta: &sawTextDelta) {
                        continuation.yield(chunk)
                        receivedAny = true
                    }
                }
                lineBuffer.removeAll(keepingCapacity: true)
            } else {
                lineBuffer.append(byte)
            }
        }
        // Handle trailing line without newline
        if !lineBuffer.isEmpty,
           let line = String(data: lineBuffer, encoding: .utf8),
           let chunk = parseLine(line, sawTextDelta: &sawTextDelta) {
            continuation.yield(chunk)
            receivedAny = true
        }

        if !receivedAny {
            throw CodexResponseError.emptyContent
        }
    }

    // MARK: - Line Parser

    private func parseLine(_ raw: String, sawTextDelta: inout Bool) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:") else { return nil }
        let value = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard value != "[DONE]", !value.isEmpty else { return nil }
        guard let data = value.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        // response.output_text.delta (primary streaming event)
        if let type = json["type"] as? String {
            if type == "response.output_text.delta", let delta = json["delta"] as? String, !delta.isEmpty {
                sawTextDelta = true
                return delta
            }
            if type == "response.output_text.done", let text = json["text"] as? String, !text.isEmpty {
                return nil // already yielded via delta events
            }
            // response.completed fallback: extract full text if no deltas arrived
            if type == "response.completed",
               let response = json["response"] as? [String: Any],
               let text = parseCompletedResponse(response), !text.isEmpty,
               !sawTextDelta {
                return text
            }
            // Legacy delta format
            if type.contains("output_text") {
                if let delta = json["delta"] as? String, !delta.isEmpty {
                    sawTextDelta = true
                    return delta
                }
                if let text = json["text"] as? String, !text.isEmpty, !sawTextDelta { return text }
            }
        }

        // Fallback: top-level output_text
        if let outputText = json["output_text"] as? String, !outputText.isEmpty, !sawTextDelta {
            return outputText
        }

        return nil
    }

    private func parseCompletedResponse(_ response: [String: Any]) -> String? {
        guard let output = response["output"] as? [[String: Any]] else { return nil }
        var texts: [String] = []
        for item in output {
            if item["type"] as? String == "message",
               let content = item["content"] as? [[String: Any]] {
                for block in content {
                    if let type = block["type"] as? String,
                       (type == "output_text" || type == "text"),
                       let text = block["text"] as? String, !text.isEmpty {
                        texts.append(text)
                    }
                }
            } else if item["type"] as? String == "output_text",
                      let text = item["text"] as? String, !text.isEmpty {
                texts.append(text)
            }
        }
        let value = texts.joined()
        return value.isEmpty ? nil : value
    }

    private func parseCompletedAgentLine(_ raw: String) -> [String: Any]? {
        var accumulator = AgentResponseAccumulator()
        parseAgentEventLine(raw, accumulator: &accumulator)
        return accumulator.buildResponse()
    }

    private func performAgentResponseRequest(
        body: [String: Any],
        configuration: CodexAccountConfiguration
    ) async throws -> [String: Any] {
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
        request.httpBody = try JSONSerialization.data(withJSONObject: body.filterNilValues())

        let (asyncBytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CodexResponseError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            var bodyData = Data()
            for try await byte in asyncBytes { bodyData.append(byte) }
            let message = String(data: bodyData, encoding: .utf8) ?? "unknown"
            throw CodexResponseError.upstreamStatus(http.statusCode, message)
        }

        var lineBuffer = Data()
        var accumulator = AgentResponseAccumulator()
        for try await byte in asyncBytes {
            if byte == UInt8(ascii: "\n") {
                if let line = String(data: lineBuffer, encoding: .utf8) {
                    parseAgentEventLine(line, accumulator: &accumulator)
                }
                lineBuffer.removeAll(keepingCapacity: true)
            } else {
                lineBuffer.append(byte)
            }
        }

        if !lineBuffer.isEmpty, let line = String(data: lineBuffer, encoding: .utf8) {
            parseAgentEventLine(line, accumulator: &accumulator)
        }

        guard let responsePayload = accumulator.buildResponse() else {
            throw CodexResponseError.invalidResponse
        }
        return responsePayload
    }

    private func parseAgentEventLine(_ raw: String, accumulator: inout AgentResponseAccumulator) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:") else { return }
        let value = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard value != "[DONE]", !value.isEmpty else { return }
        guard let data = value.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        if let type = json["type"] as? String,
           type == "response.completed",
           let response = json["response"] as? [String: Any] {
            accumulator.responseID = response["id"] as? String ?? accumulator.responseID
            accumulator.completedResponse = response
            return
        }

        if let response = json["response"] as? [String: Any] {
            accumulator.responseID = response["id"] as? String ?? accumulator.responseID
        }

        let outputIndex = normalizedOutputIndex(json["output_index"])
            ?? normalizedOutputIndex(json["index"])
            ?? normalizedOutputIndex((json["item"] as? [String: Any])?["index"])
            ?? normalizedOutputIndex((json["output_item"] as? [String: Any])?["index"])

        let item = (json["item"] as? [String: Any]) ?? (json["output_item"] as? [String: Any])
        if let item, let outputIndex {
            accumulator.registerOutputItem(index: outputIndex, item: item)
        }

        let type = json["type"] as? String ?? ""
        if type == "response.function_call_arguments.delta" || type == "response.function_call_arguments.done" {
            let identifier = String(
                describing:
                    json["call_id"]
                    ?? json["item_id"]
                    ?? outputIndex
                    ?? UUID().uuidString.lowercased()
            )
            if let delta = json["delta"] as? String, !delta.isEmpty {
                accumulator.appendFunctionArguments(identifier: identifier, delta: delta)
            }
            if let arguments = json["arguments"] as? String, !arguments.isEmpty {
                accumulator.finalizeFunctionArguments(identifier: identifier, arguments: arguments)
            }
        }
    }

    private func normalizedOutputIndex(_ value: Any?) -> Int? {
        if let intValue = value as? Int {
            return intValue
        }
        if let number = value as? NSNumber {
            return number.intValue
        }
        if let stringValue = value as? String, let intValue = Int(stringValue) {
            return intValue
        }
        return nil
    }

    // MARK: - Request Builder

    private func buildRequestBody(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String,
        attachments: [PanelAttachment],
        model: String
    ) -> [String: Any] {
        let instructions = appendCustomSystemPrompt(
            basePrompt: "你是集成在 Safari 页面里的中文助理。回答必须简洁、准确、面向当前页面任务，不要编造页面中不存在的信息。若有页面选中内容，请优先解释选中内容，再结合整页内容回答。"
        )
        var sections = [String]()

        if let context {
            sections.append("site: \(context.site)")
            sections.append("title: \(context.title)")
            if !context.url.isEmpty { sections.append("url: \(context.url)") }
            if !context.selection.isEmpty { sections.append("selection: \(context.selection)") }
            if !selectedFocus.isEmpty { sections.append("selected_focus: \(selectedFocus)") }
            if let pageKind = context.metadata["pageKind"], !pageKind.isEmpty { sections.append("page_kind: \(pageKind)") }
            if let visualSummary = context.visualSummary, !visualSummary.isEmpty {
                sections.append("visual_summary:\n\(visualSummary)")
            }
            if let structureSummary = context.structureSummary, !structureSummary.isEmpty {
                sections.append("structure_summary:\n\(structureSummary)")
            }
            if let interactiveSummary = context.interactiveSummary, !interactiveSummary.isEmpty {
                sections.append("interactive_summary:\n\(interactiveSummary)")
            }
            if !context.articleText.isEmpty { sections.append("article_text:\n\(context.articleText)") }
        }

        if !history.isEmpty {
            let historyText = history.suffix(6).map { message in
                let attachmentSummary = summarizeAttachments(message.attachments)
                return "[\(message.role)/\(message.kind)] \(message.text)\(attachmentSummary)"
            }.joined(separator: "\n")
            sections.append("recent_conversation:\n\(historyText)")
        }

        sections.append("user_prompt: \(prompt)")
        let finalPrompt = sections.joined(separator: "\n\n")
        var content: [[String: Any]] = [["type": "input_text", "text": finalPrompt]]
        content += attachments.compactMap { attachment in
            guard attachment.kind == "image", attachment.mimeType.hasPrefix("image/") else {
                return nil
            }
            return [
                "type": "input_image",
                "image_url": attachment.dataURL
            ]
        }

        return [
            "model": model,
            "input": [
                [
                    "type": "message",
                    "role": "user",
                    "content": content,
                ]
            ],
            "instructions": instructions,
            "stream": true,
            "store": false,
            "parallel_tool_calls": true,
            "reasoning": ["effort": "medium", "summary": "auto"],
            "include": ["reasoning.encrypted_content"],
        ]
    }

    private func summarizeAttachments(_ attachments: [PanelAttachment]?) -> String {
        let imageNames = (attachments ?? []).filter { $0.kind == "image" }.map(\.filename)
        guard !imageNames.isEmpty else {
            return ""
        }
        return " [attachments: \(imageNames.joined(separator: ", "))]"
    }
}

private extension Dictionary where Key == String, Value == Any {
    func filterNilValues() -> [String: Any] {
        reduce(into: [String: Any]()) { result, item in
            if !(item.value is NSNull) {
                result[item.key] = item.value
            }
        }
    }
}
