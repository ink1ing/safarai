import Foundation

enum PanelStateWriter {
    private static let stateURL = NativeSharedContainer.baseURL().appendingPathComponent("panel-state.json")
    private static let selectionIntentURL = NativeSharedContainer.baseURL().appendingPathComponent("selection-intent.json")

    static func save(payload: [String: Any], status: String? = nil) throws {
        let current = loadRawSnapshot() ?? [:]
        let context = payload["context"] as? [String: Any]
        let normalizedIncomingContext = preserveContext(
            currentContext: current["context"] as? [String: Any],
            incomingContext: normalizeContext(context)
        )
        let incomingMessages = (payload["messages"] as? [[String: Any]] ?? []).map(normalizeMessage(_:))
        let preservedMessages = preserveMessages(
            current: current["messages"] as? [[String: Any]] ?? [],
            incoming: incomingMessages,
            currentContext: current["context"] as? [String: Any],
            incomingContext: normalizedIncomingContext
        )

        let snapshot: [String: Any] = [
            "context": normalizedIncomingContext as Any,
            "currentThreadId": current["currentThreadId"] as Any,
            "messages": preservedMessages,
            "status": status as Any,
            "updatedAt": Date().timeIntervalSince1970,
        ]

        persistSelectionIntent(from: normalizedIncomingContext)

        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: stateURL, options: .atomic)
    }

    static func updatePage(title: String, url: String, status: String? = nil) throws {
        let current = loadRawSnapshot() ?? [:]
        var context = (current["context"] as? [String: Any]) ?? [:]
        context["title"] = title
        context["url"] = url

        let snapshot: [String: Any] = [
            "context": context,
            "currentThreadId": current["currentThreadId"] as Any,
            "messages": current["messages"] as? [[String: Any]] ?? [],
            "status": status as Any,
            "updatedAt": Date().timeIntervalSince1970,
        ]

        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: stateURL, options: .atomic)
    }

    static func saveSelectionIntent(url: String, selection: String) {
        let normalizedURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSelection = selection.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedURL.isEmpty else {
            clearSelectionIntent()
            return
        }

        guard !normalizedSelection.isEmpty else {
            clearSelectionIntent()
            return
        }

        let payload: [String: Any] = [
            "url": normalizedURL,
            "selection": normalizedSelection,
            "updatedAt": Date().timeIntervalSince1970,
        ]

        let directory = selectionIntentURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: selectionIntentURL, options: .atomic)
        }
    }

    private static func normalizeContext(_ context: [String: Any]?) -> [String: Any]? {
        guard let context else {
            return nil
        }

        let metadata = (context["metadata"] as? [String: Any] ?? [:]).reduce(into: [String: String]()) { result, item in
            result[item.key] = String(describing: item.value)
        }
        let debugSelection = (context["debugSelection"] as? [String: Any] ?? [:]).reduce(into: [String: String]()) { result, item in
            result[item.key] = String(describing: item.value)
        }

        return [
            "site": String(describing: context["site"] ?? "unsupported"),
            "url": String(describing: context["url"] ?? ""),
            "title": String(describing: context["title"] ?? "当前页面"),
            "selection": String(describing: context["selection"] ?? ""),
            "articleText": String(describing: context["articleText"] ?? ""),
            "structureSummary": context["structureSummary"] ?? NSNull(),
            "interactiveSummary": context["interactiveSummary"] ?? NSNull(),
            "metadata": metadata,
            "videoContext": normalizeVideoContext(context["videoContext"] as? [String: Any]) ?? NSNull(),
            "debugSelection": debugSelection,
            "visualSummary": buildVisualSummary(context, metadata: metadata) as Any,
        ]
    }

    private static func normalizeMessage(_ item: [String: Any]) -> [String: String] {
        [
            "role": String(describing: item["role"] ?? "system"),
            "kind": String(describing: item["kind"] ?? "message"),
            "text": String(describing: item["text"] ?? ""),
        ]
    }

    private static func preserveMessages(
        current: [[String: Any]],
        incoming: [[String: String]],
        currentContext: [String: Any]?,
        incomingContext: [String: Any]?
    ) -> [[String: Any]] {
        let currentURL = String(describing: currentContext?["url"] ?? "")
        let incomingURL = String(describing: incomingContext?["url"] ?? "")

        if incoming.isEmpty {
            return current
        }

        if current.isEmpty {
            return incoming.map { $0 }
        }

        if !currentURL.isEmpty, !incomingURL.isEmpty, currentURL != incomingURL {
            return incoming.map { $0 }
        }

        if incoming.count >= current.count {
            return incoming.map { $0 }
        }

        return current
    }

    private static func preserveContext(
        currentContext: [String: Any]?,
        incomingContext: [String: Any]?
    ) -> [String: Any]? {
        guard var incomingContext else {
            return nil
        }

        let currentURL = String(describing: currentContext?["url"] ?? "")
        let incomingURL = String(describing: incomingContext["url"] ?? "")
        let currentSelection = String(describing: currentContext?["selection"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingSelection = String(describing: incomingContext["selection"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if incomingSelection.isEmpty, !currentSelection.isEmpty, currentURL == incomingURL {
            incomingContext["selection"] = currentSelection
        }

        guard
            currentURL == incomingURL,
            !currentURL.isEmpty,
            var incomingMetadata = incomingContext["metadata"] as? [String: String]
        else {
            return incomingContext
        }

        let currentMetadata = currentContext?["metadata"] as? [String: String] ?? [:]
        let currentTranscriptAvailable = currentMetadata["transcriptAvailable"] == "true"
        let incomingTranscriptAvailable = incomingMetadata["transcriptAvailable"] == "true"
        let currentTranscriptStatus = currentMetadata["transcriptStatus"] ?? ""
        let incomingTranscriptStatus = incomingMetadata["transcriptStatus"] ?? ""
        let currentArticleText = String(describing: currentContext?["articleText"] ?? "")
        let incomingArticleText = String(describing: incomingContext["articleText"] ?? "")
        let currentVideoContext = currentContext?["videoContext"] as? [String: Any]
        let incomingVideoContext = incomingContext["videoContext"] as? [String: Any]
        let currentTranscriptText = String(describing: currentVideoContext?["transcriptText"] ?? "")
        let incomingTranscriptText = String(describing: incomingVideoContext?["transcriptText"] ?? "")
        let currentTranscriptAvailability = String(describing: currentVideoContext?["transcriptAvailability"] ?? "")
        let incomingTranscriptAvailability = String(describing: incomingVideoContext?["transcriptAvailability"] ?? "")
        let currentSummaryReady = String(describing: currentVideoContext?["summaryReady"] ?? "") == "true"
        let incomingSummaryReady = String(describing: incomingVideoContext?["summaryReady"] ?? "") == "true"
        let currentSummarySource = String(describing: currentVideoContext?["summaryInputSource"] ?? "")
        let incomingSummarySource = String(describing: incomingVideoContext?["summaryInputSource"] ?? "")
        let currentContentStrategy = currentMetadata["contentStrategy"] ?? ""
        let incomingContentStrategy = incomingMetadata["contentStrategy"] ?? ""

        if currentTranscriptAvailable && !incomingTranscriptAvailable {
            copyCurrentVideoState(
                currentContext: currentContext,
                currentMetadata: currentMetadata,
                currentVideoContext: currentVideoContext,
                currentArticleText: currentArticleText,
                incomingContext: &incomingContext,
                incomingMetadata: &incomingMetadata,
                metadataKeys: ["transcriptAvailable", "transcriptLanguage", "transcriptSource", "transcriptStatus", "transcriptDetail", "contentStrategy"]
            )
        } else if currentTranscriptStatus.hasPrefix("host_"), !incomingTranscriptAvailable {
            // Keep host-side fetch results stable for the same page even if extension refreshes
            // fall back to weaker direct/page probes.
            if currentSummaryReady || currentVideoContext != nil {
                copyCurrentVideoState(
                    currentContext: currentContext,
                    currentMetadata: currentMetadata,
                    currentVideoContext: currentVideoContext,
                    currentArticleText: currentArticleText,
                    incomingContext: &incomingContext,
                    incomingMetadata: &incomingMetadata,
                    metadataKeys: [
                        "transcriptAvailable",
                        "transcriptLanguage",
                        "transcriptSource",
                        "transcriptStatus",
                        "transcriptDetail",
                        "contentStrategy",
                        "summaryReady",
                        "summaryInputSource",
                        "fallbackDetail"
                    ]
                )
            } else {
                for key in ["transcriptStatus", "transcriptDetail"] {
                    if let value = currentMetadata[key], !value.isEmpty {
                        incomingMetadata[key] = value
                    }
                }
                if incomingTranscriptStatus.isEmpty, !currentArticleText.isEmpty, incomingArticleText.isEmpty {
                    incomingContext["articleText"] = currentArticleText
                }
            }
        } else if !currentTranscriptText.isEmpty, incomingTranscriptText.isEmpty, let currentVideoContext {
            incomingContext["videoContext"] = currentVideoContext
            if incomingArticleText.isEmpty, !currentArticleText.isEmpty {
                incomingContext["articleText"] = currentArticleText
            }
        } else if currentTranscriptAvailability != "partial",
                  (incomingTranscriptAvailability == "partial" || incomingTranscriptStatus == "pending" || incomingTranscriptStatus.isEmpty),
                  currentVideoContext != nil {
            copyCurrentVideoState(
                currentContext: currentContext,
                currentMetadata: currentMetadata,
                currentVideoContext: currentVideoContext,
                currentArticleText: currentArticleText,
                incomingContext: &incomingContext,
                incomingMetadata: &incomingMetadata,
                metadataKeys: ["transcriptAvailable", "transcriptLanguage", "transcriptSource", "transcriptStatus", "transcriptDetail", "contentStrategy"]
            )
        } else if currentSummaryReady,
                  shouldPreferCurrentSummary(
                    currentSummaryReady: currentSummaryReady,
                    incomingSummaryReady: incomingSummaryReady,
                    currentSummarySource: currentSummarySource,
                    incomingSummarySource: incomingSummarySource,
                    currentContentStrategy: currentContentStrategy,
                    incomingContentStrategy: incomingContentStrategy
                  ),
                  currentVideoContext != nil {
            copyCurrentVideoState(
                currentContext: currentContext,
                currentMetadata: currentMetadata,
                currentVideoContext: currentVideoContext,
                currentArticleText: currentArticleText,
                incomingContext: &incomingContext,
                incomingMetadata: &incomingMetadata,
                metadataKeys: ["contentStrategy", "fallbackDetail", "summaryInputSource", "summaryReady", "transcriptDetail"]
            )
        }

        incomingContext["metadata"] = incomingMetadata

        return incomingContext
    }

    private static func copyCurrentVideoState(
        currentContext: [String: Any]?,
        currentMetadata: [String: String],
        currentVideoContext: [String: Any]?,
        currentArticleText: String,
        incomingContext: inout [String: Any],
        incomingMetadata: inout [String: String],
        metadataKeys: [String]
    ) {
        if let currentVideoContext {
            incomingContext["videoContext"] = currentVideoContext
        }
        for key in metadataKeys {
            if let value = currentMetadata[key], !value.isEmpty {
                incomingMetadata[key] = value
            }
        }
        if !currentArticleText.isEmpty {
            incomingContext["articleText"] = currentArticleText
        }
        if let structureSummary = currentContext?["structureSummary"] {
            incomingContext["structureSummary"] = structureSummary
        }
    }

    private static func shouldPreferCurrentSummary(
        currentSummaryReady: Bool,
        incomingSummaryReady: Bool,
        currentSummarySource: String,
        incomingSummarySource: String,
        currentContentStrategy: String,
        incomingContentStrategy: String
    ) -> Bool {
        guard currentSummaryReady else {
            return false
        }
        let currentRank = summarySourceRank(currentSummarySource)
        let incomingRank = summarySourceRank(incomingSummarySource)
        if !incomingSummaryReady || currentRank > incomingRank {
            return true
        }
        if currentRank == incomingRank,
           !isHostFallbackStrategy(currentContentStrategy),
           isHostFallbackStrategy(incomingContentStrategy) {
            return true
        }
        return false
    }

    private static func isHostFallbackStrategy(_ value: String) -> Bool {
        value.contains("_host_fallback")
    }

    private static func buildVisualSummary(_ context: [String: Any], metadata: [String: String]) -> String {
        let focusedInput = context["focusedInput"] as? [String: Any]
        let focusedType = String(describing: focusedInput?["type"] ?? "none")
        let focusedLabel = String(describing: focusedInput?["label"] ?? focusedInput?["placeholder"] ?? "none")
        let pageKind = metadata["pageKind"] ?? "unknown"
        let repository = metadata["repository"] ?? "none"
        let domain = metadata["domain"] ?? "unknown"

        return [
            "domain: \(domain)",
            "page_kind: \(pageKind)",
            "repository: \(repository)",
            "focused_input_type: \(focusedType)",
            "focused_input_label: \(focusedLabel)",
        ].joined(separator: "\n")
    }

    private static func loadRawSnapshot() -> [String: Any]? {
        guard
            let data = try? Data(contentsOf: stateURL),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return payload
    }

    private static func persistSelectionIntent(from context: [String: Any]?) {
        guard
            let context,
            let url = context["url"] as? String,
            !url.isEmpty
        else {
            clearSelectionIntent()
            return
        }

        let selection = String(describing: context["selection"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !selection.isEmpty else {
            clearSelectionIntent()
            return
        }

        saveSelectionIntent(url: url, selection: selection)
    }

    private static func clearSelectionIntent() {
        if FileManager.default.fileExists(atPath: selectionIntentURL.path) {
            try? FileManager.default.removeItem(at: selectionIntentURL)
        }
    }

    private static func normalizeVideoContext(_ value: [String: Any]?) -> [String: Any]? {
        guard let value else {
            return nil
        }

        let keys = [
            "platform",
            "pageKind",
            "mediaId",
            "canonicalUrl",
            "title",
            "author",
            "duration",
            "description",
            "postText",
            "transcriptText",
            "transcriptLanguage",
            "transcriptAvailability",
            "transcriptReason",
            "transcriptSource",
            "summaryInputSource",
            "summaryText",
            "fallbackDetail",
            "summaryReady",
            "summaryMode",
            "detectedAt",
        ]

        var result: [String: Any] = [:]
        for key in keys {
            if key == "summaryReady" {
                if let boolValue = value[key] as? Bool {
                    result[key] = boolValue
                } else {
                    let normalized = String(describing: value[key] ?? "").lowercased()
                    result[key] = normalized == "true"
                }
            } else {
                result[key] = String(describing: value[key] ?? "")
            }
        }
        return result
    }

    private static func summarySourceRank(_ value: String) -> Int {
        switch value {
        case "transcript":
            return 4
        case "official_summary":
            return 3
        case "chapter_points":
            return 2
        case "page_text":
            return 1
        case "metadata_only":
            return 0
        default:
            return -1
        }
    }
}

enum NativeAgentBridgeStore {
    private static let requestURL = NativeSharedContainer.baseURL().appendingPathComponent("agent-bridge-request.json")
    private static let responseURL = NativeSharedContainer.baseURL().appendingPathComponent("agent-bridge-response.json")

    static func claimPendingRequest() -> [String: Any]? {
        guard var payload = readJSON(from: requestURL) else {
            return nil
        }
        guard String(describing: payload["status"] ?? "") == "pending" else {
            return nil
        }
        payload["status"] = "claimed"
        payload["claimedAt"] = Date().timeIntervalSince1970
        try? writeJSON(payload, to: requestURL)
        return payload
    }

    static func submitResult(requestId: String, result: [String: Any]) {
        let payload: [String: Any] = [
            "requestId": requestId,
            "result": result,
            "updatedAt": Date().timeIntervalSince1970,
        ]
        try? writeJSON(payload, to: responseURL)
        try? FileManager.default.removeItem(at: requestURL)
    }

    private static func readJSON(from url: URL) -> [String: Any]? {
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return payload
    }

    private static func writeJSON(_ payload: [String: Any], to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }
}
