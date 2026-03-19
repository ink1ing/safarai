import Foundation

enum MockNativeRouter {
    static func route(message: Any?) -> [String: Any] {
        guard
            let payload = message as? [String: Any],
            let type = payload["type"] as? String
        else {
            return error(code: "invalid_request", message: "native message payload 无效")
        }

        let requestId = payload["id"] as? String ?? "req_missing"
        let context = ((payload["payload"] as? [String: Any])?["context"] as? [String: Any]) ?? [:]

        switch type {
        case "summarize_page":
            return success(requestId: requestId, answer: summarize(context: context), draft: nil)
        case "explain_selection":
            return success(requestId: requestId, answer: explainSelection(context: context), draft: nil)
        case "extract_structured_info":
            return success(requestId: requestId, answer: extractStructuredInfo(context: context), draft: nil)
        case "draft_for_input":
            return success(requestId: requestId, answer: "已生成当前输入框草稿，请确认后手动写入。", draft: draftForInput(context: context))
        default:
            return error(code: "unsupported_request", message: "不支持的 native request: \(type)")
        }
    }

    static func error(code: String, message: String) -> [String: Any] {
        return [
            "ok": false,
            "error": [
                "code": code,
                "message": message
            ]
        ]
    }

    private static func summarize(context: [String: Any]) -> String {
        let title = (context["title"] as? String)?.nonEmpty ?? "当前页面"
        let site = (context["site"] as? String)?.nonEmpty ?? "unknown"
        let articleText = (context["articleText"] as? String)?.nonEmpty ?? ""
        let metadata = context["metadata"] as? [String: Any]
        let pageKind = (metadata?["pageKind"] as? String)?.nonEmpty ?? "unknown_page"
        let repository = (metadata?["repository"] as? String)?.nonEmpty

        if articleText.isEmpty {
            let repoText = repository.map { "，仓库 \($0)" } ?? ""
            return "[Mock][\(site)][\(pageKind)] \(title)\(repoText)：页面正文尚未提取到足够内容，当前骨架已验证读取链路可用。"
        }

        let preview = articleText.prefix(180)
        let repoText = repository.map { "，仓库 \($0)" } ?? ""
        return "[Mock][\(site)][\(pageKind)] \(title)\(repoText)：\(preview)…"
    }

    private static func explainSelection(context: [String: Any]) -> String {
        let selection = (context["selection"] as? String)?.nonEmpty ?? ""
        let title = (context["title"] as? String)?.nonEmpty ?? "当前页面"

        if selection.isEmpty {
            return "[Mock] 当前页面《\(title)》没有选中文本，请先选择一段内容。"
        }

        return "[Mock] 选中文本解释：\(selection)"
    }

    private static func draftForInput(context: [String: Any]) -> String {
        let title = (context["title"] as? String)?.nonEmpty ?? "当前页面"
        let metadata = context["metadata"] as? [String: Any]
        let repository = (metadata?["repository"] as? String)?.nonEmpty
        let writeTarget = context["writeTarget"] as? [String: Any]
        let targetDescription = (writeTarget?["description"] as? String)?.nonEmpty ?? "当前输入框"

        var lines = [
            "基于《\(title)》生成的草稿：",
            "",
            "我已阅读当前页面内容，下面是建议回复。"
        ]

        if let repository {
            lines.append("")
            lines.append("仓库：\(repository)")
        }

        lines.append("")
        lines.append("目标：\(targetDescription)")
        lines.append("")
        lines.append("这是一条 mock 草稿，后续接入真实 Provider 后会替换为真实生成结果。")

        return lines.joined(separator: "\n")
    }

    private static func extractStructuredInfo(context: [String: Any]) -> String {
        let title = (context["title"] as? String)?.nonEmpty ?? "当前页面"
        let selection = (context["selection"] as? String)?.nonEmpty
        let metadata = context["metadata"] as? [String: Any]
        let site = (context["site"] as? String)?.nonEmpty ?? "unknown"
        let pageKind = (metadata?["pageKind"] as? String)?.nonEmpty ?? "unknown_page"
        let domain = (metadata?["domain"] as? String)?.nonEmpty ?? "unknown"

        var lines = [
            "主题",
            "- \(title)",
            "",
            "关键实体",
            "- 站点：\(site)",
            "- 域名：\(domain)",
            "- 页面类型：\(pageKind)",
            "",
            "关键信息",
            "- 当前为 mock 结构化提取，后续会由真实 Provider 生成更准确内容。",
        ]

        if let selection {
            lines.append("- 当前选中：\(selection)")
        }

        lines += [
            "",
            "后续动作",
            "- 如果内容不完整，可以先刷新上下文后再提取。",
            "- 如果需要精准答案，可以继续在页面问答里追问。"
        ]

        return lines.joined(separator: "\n")
    }

    private static func success(requestId: String, answer: String, draft: String?) -> [String: Any] {
        var payload: [String: Any] = [
            "request_id": requestId,
            "answer": answer
        ]

        if let draft {
            payload["draft"] = draft
        } else {
            payload["draft"] = NSNull()
        }

        return [
            "ok": true,
            "payload": payload
        ]
    }

}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
