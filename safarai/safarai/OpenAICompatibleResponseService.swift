import Foundation

enum OpenAICompatibleResponseError: LocalizedError {
    case notConfigured
    case invalidEndpoint
    case invalidResponse
    case upstreamStatus(Int, String)
    case emptyContent

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "请先配置 OpenAI 兼容提供商的端点和 API Key。"
        case .invalidEndpoint:
            return "OpenAI 兼容端点无效。"
        case .invalidResponse:
            return "OpenAI 兼容接口响应无效。"
        case .upstreamStatus(let status, let body):
            return "OpenAI 兼容接口请求失败（\(status)）：\(body)"
        case .emptyContent:
            return "OpenAI 兼容接口未返回可用内容。"
        }
    }
}

final class OpenAICompatibleResponseService {
    static let shared = OpenAICompatibleResponseService()

    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config)
    }

    func streamQuestion(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String = "",
        taskIntent: String = ""
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    let settings = OpenAICompatibleSettingsStore.load()
                    guard settings.isConfigured else {
                        throw OpenAICompatibleResponseError.notConfigured
                    }
                    try await streamCompletion(
                        prompt: prompt,
                        context: context,
                        history: history,
                        selectedFocus: selectedFocus,
                        taskIntent: taskIntent,
                        settings: settings,
                        continuation: continuation
                    )
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    func fetchModels(settings: OpenAICompatibleSettings) async throws -> [OpenAICompatibleModel] {
        guard settings.isConfigured else {
            throw OpenAICompatibleResponseError.notConfigured
        }
        guard let url = endpointURL(settings.endpoint, path: "models") else {
            throw OpenAICompatibleResponseError.invalidEndpoint
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(settings.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OpenAICompatibleResponseError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw OpenAICompatibleResponseError.upstreamStatus(http.statusCode, body)
        }

        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let items = json["data"] as? [[String: Any]]
        else {
            throw OpenAICompatibleResponseError.invalidResponse
        }

        let models = items.compactMap { item -> OpenAICompatibleModel? in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            return OpenAICompatibleModel(id: id, label: id)
        }

        return models.isEmpty ? OpenAICompatibleSettings.default.availableModels : models
    }

    private func streamCompletion(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String,
        taskIntent: String,
        settings: OpenAICompatibleSettings,
        continuation: AsyncThrowingStream<String, Error>.Continuation
    ) async throws {
        guard let url = endpointURL(settings.endpoint, path: "chat/completions") else {
            throw OpenAICompatibleResponseError.invalidEndpoint
        }

        let userContent = buildUserMessageContent(
            prompt: prompt,
            context: context,
            history: history,
            selectedFocus: selectedFocus,
            taskIntent: taskIntent
        )
        let requestBody: [String: Any] = [
            "model": settings.selectedModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? OpenAICompatibleSettings.default.selectedModel
                : settings.selectedModel,
            "stream": true,
            "messages": [
                ["role": "system", "content": buildSystemPrompt()],
                ["role": "user", "content": userContent],
            ],
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(settings.apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: requestBody)

        let (asyncBytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OpenAICompatibleResponseError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            var bodyData = Data()
            for try await byte in asyncBytes { bodyData.append(byte) }
            let body = String(data: bodyData, encoding: .utf8) ?? "unknown"
            throw OpenAICompatibleResponseError.upstreamStatus(http.statusCode, body)
        }

        var receivedAny = false
        var lineBuffer = Data()
        for try await byte in asyncBytes {
            if byte == UInt8(ascii: "\n") {
                if let line = String(data: lineBuffer, encoding: .utf8),
                   let chunk = parseStreamLine(line) {
                    continuation.yield(chunk)
                    receivedAny = true
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
            receivedAny = true
        }

        if !receivedAny {
            throw OpenAICompatibleResponseError.emptyContent
        }
    }

    private func parseStreamLine(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:") else { return nil }
        let value = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value != "[DONE]", let data = value.data(using: .utf8) else {
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
            if let text = first["text"] as? String, !text.isEmpty {
                return text
            }
        }

        return nil
    }

    private func endpointURL(_ endpoint: String, path: String) -> URL? {
        let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var components = URLComponents(string: trimmed) else {
            return nil
        }

        var basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if basePath.hasSuffix("chat/completions") {
            basePath = String(basePath.dropLast("chat/completions".count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        } else if basePath.hasSuffix("models") {
            basePath = String(basePath.dropLast("models".count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }

        components.path = "/" + ([basePath, path]
            .filter { !$0.isEmpty }
            .joined(separator: "/"))
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private func buildPrompt(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String,
        taskIntent: String
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
            if let videoRAGSummary = context.videoRAGSummary, !videoRAGSummary.isEmpty {
                sections.append("video_rag_signals:\n\(videoRAGSummary)")
            }
            appendVideoTranscript(context, to: &sections)
        }

        if !history.isEmpty {
            let historyText = history.suffix(6)
                .map { "[\($0.role)/\($0.kind)] \($0.text)" }
                .joined(separator: "\n")
            sections.append("recent_conversation:\n\(historyText)")
        }

        sections.append("user_prompt: \(prompt)")
        appendTaskIntent(taskIntent, context: context, to: &sections)
        return sections.joined(separator: "\n\n")
    }

    private func buildUserMessageContent(
        prompt: String,
        context: PanelContextSnapshot?,
        history: [PanelConversationMessage],
        selectedFocus: String,
        taskIntent: String
    ) -> Any {
        let text = buildPrompt(
            prompt: prompt,
            context: context,
            history: history,
            selectedFocus: selectedFocus,
            taskIntent: taskIntent
        )
        guard taskIntent == "summarize_video",
              let frameSamples = context?.videoFrameSamples,
              !frameSamples.isEmpty
        else {
            return text
        }

        var content: [[String: Any]] = [[
            "type": "text",
            "text": text + "\n\nvideo_frame_samples:\n" + frameSamples.prefix(8)
                .map { "- \($0.timestamp): sampled visible video frame attached." }
                .joined(separator: "\n")
        ]]
        for sample in frameSamples.prefix(8) {
            content.append([
                "type": "image_url",
                "image_url": [
                    "url": sample.image,
                    "detail": "low"
                ]
            ])
        }
        return content
    }

    private func appendVideoTranscript(_ context: PanelContextSnapshot, to sections: inout [String]) {
        guard let transcript = context.videoTranscript, !transcript.isEmpty else { return }
        let lines = transcript.prefix(240).map { segment in
            let end = segment.endSeconds.map { "-\(formatTimestamp($0))" } ?? ""
            return "[\(segment.timestamp)\(end)] \(segment.text)"
        }
        sections.append("video_transcript:\n\(lines.joined(separator: "\n"))")
    }

    private func appendTaskIntent(_ taskIntent: String, context: PanelContextSnapshot?, to sections: inout [String]) {
        guard taskIntent == "summarize_video" else { return }
        let transcriptCount = context?.videoTranscript?.count ?? 0
        sections.append("""
        task_intent: summarize_video
        output_requirements:
        - 用 Markdown 输出三个部分：## 整体概览、## 时间线要点、## 适合快速记住的结论。
        - 时间线要点必须引用可用时间戳，格式如 00:00-02:15：要点。
        - 融合页面结构、视频标题/描述、章节/重要时刻、评论高信号、字幕和采样画面；优先使用语义密度高的实体、事件、时间和地点。
        - 评论区只作为“集体注意力信号”，不要把评论当成视频事实，除非视频描述/字幕/画面也支持。
        - 如果提供了 video_frame_samples，也要结合画面 OCR、人物/场景/镜头变化总结可见信息；时间线可引用采样帧附近的时间戳。
        - 不要编造字幕或页面中没有的信息。
        - 如果 video_transcript 为空但 video_frame_samples 不为空，必须先写“未检测到可用时间戳字幕，以下基于采样画面和页面信息总结”。
        - 如果 video_transcript 与 video_frame_samples 都为空，必须先写“未检测到可用时间戳字幕”，再仅基于标题、简介、可见页面信息做简短总结。
        video_transcript_count: \(transcriptCount)
        video_frame_sample_count: \(context?.videoFrameSamples?.count ?? 0)
        """)
    }

    private func formatTimestamp(_ value: Double) -> String {
        let seconds = max(0, Int(value.rounded()))
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let remaining = seconds % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, remaining)
        }
        return String(format: "%02d:%02d", minutes, remaining)
    }

    private func buildSystemPrompt() -> String {
        let basePrompt = "你是集成在 Safari 页面里的中文助理。回答必须简洁、准确、面向当前页面任务，不要编造页面中不存在的信息。"
        let customPrompt = loadCustomSystemPromptFromUISettings()
        guard !customPrompt.isEmpty else { return basePrompt }
        return """
\(basePrompt)

用户附加系统提示:
\(customPrompt)
"""
    }
}
