import Foundation

struct PanelAttachment: Codable {
    var id: String
    var kind: String
    var filename: String
    var mimeType: String
    var dataURL: String
    var width: Int?
    var height: Int?
}

struct PanelConversationMessage: Codable {
    var role: String
    var kind: String
    var text: String
    var attachments: [PanelAttachment]? = nil
}

struct PanelContextSnapshot: Codable {
    var site: String
    var url: String
    var title: String
    var selection: String
    var articleText: String
    var structureSummary: String?
    var interactiveSummary: String?
    var metadata: [String: String]
    var debugSelection: [String: String]?
    var visualSummary: String?
}

struct PanelStateSnapshot: Codable {
    var context: PanelContextSnapshot?
    var currentThreadId: String?
    var messages: [PanelConversationMessage]
    var status: String?
    var updatedAt: TimeInterval
}

struct SelectionIntentSnapshot: Codable {
    var url: String
    var selection: String
    var updatedAt: TimeInterval
}

struct ChatHistoryThreadSummary: Codable {
    var id: String
    var title: String
    var isPinned: Bool
    var createdAt: TimeInterval
    var updatedAt: TimeInterval
    var sourcePageURL: String
    var sourcePageTitle: String
    var messageCount: Int
}

struct ChatHistoryThreadRecord: Codable {
    var id: String
    var title: String
    var isPinned: Bool
    var createdAt: TimeInterval
    var updatedAt: TimeInterval
    var sourcePageURL: String
    var sourcePageTitle: String
    var messages: [PanelConversationMessage]
}

struct ChatHistoryStorageState {
    var displayPath: String
    var status: String
    var usesDefault: Bool
}

private struct ChatHistoryIndex: Codable {
    var threads: [ChatHistoryThreadSummary]
}

private struct ChatHistoryStorageConfiguration {
    var usesDefault: Bool
    var path: String
    var bookmarkData: Data?
}

private struct ResolvedChatHistoryStorage {
    var rootURL: URL
    var displayPath: String
    var status: String
    var usesDefault: Bool
    var stopAccessing: (() -> Void)?
}

enum ChatHistoryStore {
    private static let defaultFolderName = "chat-history"
    private static let threadsFolderName = "threads"
    private static let indexFileName = "index.json"
    private static let uiSettingsFileName = "ui-settings.json"

    static func storageState() -> ChatHistoryStorageState {
        let storage = resolveStorage(forWrite: false)
        defer { storage.stopAccessing?() }
        return ChatHistoryStorageState(
            displayPath: storage.displayPath,
            status: storage.status,
            usesDefault: storage.usesDefault
        )
    }

    static func listThreads() -> [ChatHistoryThreadSummary] {
        let storage = resolveStorage(forWrite: false)
        defer { storage.stopAccessing?() }
        return loadIndex(in: storage.rootURL).threads
            .sorted { left, right in
                if left.isPinned != right.isPinned {
                    return left.isPinned && !right.isPinned
                }
                if left.updatedAt == right.updatedAt {
                    return left.createdAt > right.createdAt
                }
                return left.updatedAt > right.updatedAt
            }
    }

    static func loadThread(id: String) -> ChatHistoryThreadRecord? {
        let storage = resolveStorage(forWrite: false)
        defer { storage.stopAccessing?() }
        let url = threadFileURL(rootURL: storage.rootURL, threadID: id)
        guard
            let data = try? Data(contentsOf: url),
            let record = try? JSONDecoder().decode(ChatHistoryThreadRecord.self, from: data)
        else {
            return nil
        }
        return record
    }

    static func createThread(
        context: PanelContextSnapshot?,
        preferredTitle: String? = nil,
        messages: [PanelConversationMessage] = []
    ) throws -> ChatHistoryThreadRecord {
        let now = Date().timeIntervalSince1970
        let record = ChatHistoryThreadRecord(
            id: UUID().uuidString.lowercased(),
            title: deriveThreadTitle(context: context, messages: messages, preferredTitle: preferredTitle),
            isPinned: false,
            createdAt: now,
            updatedAt: now,
            sourcePageURL: context?.url ?? "",
            sourcePageTitle: context?.title ?? "",
            messages: messages
        )
        try saveThread(record)
        return record
    }

    static func syncSnapshot(_ snapshot: PanelStateSnapshot) throws -> PanelStateSnapshot {
        guard !snapshot.messages.isEmpty || snapshot.currentThreadId != nil else {
            return snapshot
        }

        if snapshot.currentThreadId != nil, snapshot.messages.isEmpty {
            return snapshot
        }

        var next = snapshot
        if next.currentThreadId == nil {
            let record = try createThread(
                context: next.context,
                preferredTitle: nil,
                messages: next.messages
            )
            next.currentThreadId = record.id
            return next
        }

        guard let currentThreadId = next.currentThreadId else {
            return next
        }

        var record = loadThread(id: currentThreadId) ?? ChatHistoryThreadRecord(
            id: currentThreadId,
            title: deriveThreadTitle(context: next.context, messages: next.messages, preferredTitle: nil),
            isPinned: false,
            createdAt: Date().timeIntervalSince1970,
            updatedAt: Date().timeIntervalSince1970,
            sourcePageURL: next.context?.url ?? "",
            sourcePageTitle: next.context?.title ?? "",
            messages: []
        )

        if record.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            record.title = deriveThreadTitle(context: next.context, messages: next.messages, preferredTitle: nil)
        }
        if record.sourcePageURL.isEmpty {
            record.sourcePageURL = next.context?.url ?? ""
        }
        if record.sourcePageTitle.isEmpty {
            record.sourcePageTitle = next.context?.title ?? ""
        }

        record.messages = next.messages
        record.updatedAt = Date().timeIntervalSince1970
        try saveThread(record)
        return next
    }

    static func updateStorageLocation(to selectedFolderURL: URL) throws -> ChatHistoryStorageState {
        let oldStorage = resolveStorage(forWrite: true)
        defer { oldStorage.stopAccessing?() }

        let normalizedSelectedURL = selectedFolderURL.standardizedFileURL
        let bookmarkData = try normalizedSelectedURL.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )

        let newStorage = ResolvedChatHistoryStorage(
            rootURL: normalizedSelectedURL,
            displayPath: normalizedSelectedURL.path,
            status: "自定义位置",
            usesDefault: false,
            stopAccessing: nil
        )

        try migrateStorageContents(from: oldStorage.rootURL, to: newStorage.rootURL)
        try saveStorageConfiguration(
            ChatHistoryStorageConfiguration(
                usesDefault: false,
                path: normalizedSelectedURL.path,
                bookmarkData: bookmarkData
            )
        )

        return ChatHistoryStorageState(
            displayPath: normalizedSelectedURL.path,
            status: AppText.localized(en: "Custom location", zh: "自定义位置"),
            usesDefault: false
        )
    }

    static func resetStorageLocationToDefault() throws -> ChatHistoryStorageState {
        let oldStorage = resolveStorage(forWrite: true)
        defer { oldStorage.stopAccessing?() }

        let newRootURL = defaultRootURL()
        try migrateStorageContents(from: oldStorage.rootURL, to: newRootURL)
        try saveStorageConfiguration(
            ChatHistoryStorageConfiguration(
                usesDefault: true,
                path: "",
                bookmarkData: nil
            )
        )

        return ChatHistoryStorageState(
            displayPath: newRootURL.path,
            status: AppText.localized(en: "Default location", zh: "默认位置"),
            usesDefault: true
        )
    }

    static func renameThread(id: String, title: String) throws {
        guard var record = loadThread(id: id) else {
            throw NSError(
                domain: "ink.safarai.history",
                code: 404,
                userInfo: [NSLocalizedDescriptionKey: AppText.localized(en: "Chat record not found.", zh: "未找到对应的聊天记录。")]
            )
        }

        let nextTitle = clampTitle(title)
        guard !nextTitle.isEmpty else {
            throw NSError(
                domain: "ink.safarai.history",
                code: 400,
                userInfo: [NSLocalizedDescriptionKey: AppText.localized(en: "Title cannot be empty.", zh: "标题不能为空。")]
            )
        }

        record.title = nextTitle
        record.updatedAt = Date().timeIntervalSince1970
        try saveThread(record)
    }

    static func setPinned(id: String, isPinned: Bool) throws {
        guard var record = loadThread(id: id) else {
            throw NSError(
                domain: "ink.safarai.history",
                code: 404,
                userInfo: [NSLocalizedDescriptionKey: AppText.localized(en: "Chat record not found.", zh: "未找到对应的聊天记录。")]
            )
        }

        record.isPinned = isPinned
        record.updatedAt = Date().timeIntervalSince1970
        try saveThread(record)
    }

    static func deleteThread(id: String) throws {
        let storage = resolveStorage(forWrite: true)
        defer { storage.stopAccessing?() }

        let threadURL = threadFileURL(rootURL: storage.rootURL, threadID: id)
        if FileManager.default.fileExists(atPath: threadURL.path) {
            try FileManager.default.removeItem(at: threadURL)
        }

        var index = loadIndex(in: storage.rootURL)
        index.threads.removeAll { $0.id == id }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let indexData = try encoder.encode(index)
        try indexData.write(to: indexFileURL(rootURL: storage.rootURL), options: .atomic)
    }

    static func exportLibrary(to folderURL: URL) throws {
        let storage = resolveStorage(forWrite: false)
        defer { storage.stopAccessing?() }

        let exportRoot = folderURL.standardizedFileURL
            .appendingPathComponent("safarai-chat-history", isDirectory: true)

        if FileManager.default.fileExists(atPath: exportRoot.path) {
            try FileManager.default.removeItem(at: exportRoot)
        }
        try FileManager.default.createDirectory(at: exportRoot, withIntermediateDirectories: true)

        let contents = try FileManager.default.contentsOfDirectory(
            at: storage.rootURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )

        for sourceURL in contents {
            let destinationURL = exportRoot.appendingPathComponent(sourceURL.lastPathComponent, isDirectory: false)
            try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
        }
    }

    static func importLibrary(from folderURL: URL) throws {
        let preferredRoot = folderURL.standardizedFileURL
            .appendingPathComponent("safarai-chat-history", isDirectory: true)
        let sourceRoot = FileManager.default.fileExists(atPath: preferredRoot.path)
            ? preferredRoot
            : folderURL.standardizedFileURL

        let storage = resolveStorage(forWrite: true)
        defer { storage.stopAccessing?() }

        try FileManager.default.createDirectory(at: storage.rootURL, withIntermediateDirectories: true)

        let contents = try FileManager.default.contentsOfDirectory(
            at: sourceRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )

        for sourceURL in contents {
            let destinationURL = storage.rootURL.appendingPathComponent(sourceURL.lastPathComponent, isDirectory: false)
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
        }
    }

    private static func saveThread(_ record: ChatHistoryThreadRecord) throws {
        let storage = resolveStorage(forWrite: true)
        defer { storage.stopAccessing?() }

        let threadsURL = threadsDirectoryURL(rootURL: storage.rootURL)
        try FileManager.default.createDirectory(at: threadsURL, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        let recordURL = threadFileURL(rootURL: storage.rootURL, threadID: record.id)
        let recordData = try encoder.encode(record)
        try recordData.write(to: recordURL, options: .atomic)

        var index = loadIndex(in: storage.rootURL)
        let summary = makeSummary(from: record)
        if let existingIndex = index.threads.firstIndex(where: { $0.id == record.id }) {
            index.threads[existingIndex] = summary
        } else {
            index.threads.append(summary)
        }
        index.threads.sort { left, right in
            if left.updatedAt == right.updatedAt {
                return left.createdAt > right.createdAt
            }
            return left.updatedAt > right.updatedAt
        }

        let indexData = try encoder.encode(index)
        try indexData.write(to: indexFileURL(rootURL: storage.rootURL), options: .atomic)
    }

    private static func loadIndex(in rootURL: URL) -> ChatHistoryIndex {
        let indexURL = indexFileURL(rootURL: rootURL)
        if
            let data = try? Data(contentsOf: indexURL),
            let index = try? JSONDecoder().decode(ChatHistoryIndex.self, from: data)
        {
            return index
        }

        let scanned = scanThreadFiles(in: rootURL)
        return ChatHistoryIndex(threads: scanned)
    }

    private static func scanThreadFiles(in rootURL: URL) -> [ChatHistoryThreadSummary] {
        let threadsURL = threadsDirectoryURL(rootURL: rootURL)
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: threadsURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []

        return urls.compactMap { url in
            guard
                let data = try? Data(contentsOf: url),
                let record = try? JSONDecoder().decode(ChatHistoryThreadRecord.self, from: data)
            else {
                return nil
            }
            return makeSummary(from: record)
        }
        .sorted { left, right in
            if left.isPinned != right.isPinned {
                return left.isPinned && !right.isPinned
            }
            if left.updatedAt == right.updatedAt {
                return left.createdAt > right.createdAt
            }
            return left.updatedAt > right.updatedAt
        }
    }

    private static func makeSummary(from record: ChatHistoryThreadRecord) -> ChatHistoryThreadSummary {
        ChatHistoryThreadSummary(
            id: record.id,
            title: record.title,
            isPinned: record.isPinned,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            sourcePageURL: record.sourcePageURL,
            sourcePageTitle: record.sourcePageTitle,
            messageCount: record.messages.count
        )
    }

    private static func deriveThreadTitle(
        context: PanelContextSnapshot?,
        messages: [PanelConversationMessage],
        preferredTitle: String?
    ) -> String {
        let trimmedPreferredTitle = preferredTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedPreferredTitle.isEmpty {
            return clampTitle(trimmedPreferredTitle)
        }

        let pageTitle = context?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !pageTitle.isEmpty, pageTitle != "Untitled", pageTitle != "当前页面" {
            return clampTitle(pageTitle)
        }

        if let firstUserMessage = messages.first(where: { $0.role == "user" })?.text {
            return clampTitle(firstUserMessage)
        }

        return AppText.localized(en: "New Chat", zh: "新对话")
    }

    private static func clampTitle(_ value: String) -> String {
        let normalized = value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(normalized.prefix(80))
    }

    private static func migrateStorageContents(from oldRootURL: URL, to newRootURL: URL) throws {
        let oldPath = oldRootURL.standardizedFileURL.path
        let newPath = newRootURL.standardizedFileURL.path
        guard oldPath != newPath else {
            try FileManager.default.createDirectory(at: newRootURL, withIntermediateDirectories: true)
            return
        }

        try FileManager.default.createDirectory(at: newRootURL, withIntermediateDirectories: true)
        let oldExists = FileManager.default.fileExists(atPath: oldRootURL.path)
        guard oldExists else {
            return
        }

        let contents = try FileManager.default.contentsOfDirectory(
            at: oldRootURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )

        for sourceURL in contents {
            let destinationURL = newRootURL.appendingPathComponent(sourceURL.lastPathComponent, isDirectory: false)
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.moveItem(at: sourceURL, to: destinationURL)
        }
    }

    private static func resolveStorage(forWrite: Bool) -> ResolvedChatHistoryStorage {
        let configuration = loadStorageConfiguration()
        if configuration.usesDefault || configuration.path.isEmpty {
            return ResolvedChatHistoryStorage(
                rootURL: defaultRootURL(),
                displayPath: defaultRootURL().path,
                status: AppText.localized(en: "Default location", zh: "默认位置"),
                usesDefault: true,
                stopAccessing: nil
            )
        }

        guard let bookmarkData = configuration.bookmarkData else {
            return ResolvedChatHistoryStorage(
                rootURL: defaultRootURL(),
                displayPath: defaultRootURL().path,
                status: AppText.localized(en: "Custom location unavailable, using default.", zh: "自定义位置不可用，已回退默认位置"),
                usesDefault: true,
                stopAccessing: nil
            )
        }

        var bookmarkIsStale = false
        guard
            let url = try? URL(
                resolvingBookmarkData: bookmarkData,
                options: [.withSecurityScope],
                relativeTo: nil,
                bookmarkDataIsStale: &bookmarkIsStale
            )
        else {
            return ResolvedChatHistoryStorage(
                rootURL: defaultRootURL(),
                displayPath: defaultRootURL().path,
                status: AppText.localized(en: "Custom location unavailable, using default.", zh: "自定义位置不可用，已回退默认位置"),
                usesDefault: true,
                stopAccessing: nil
            )
        }

        let normalizedURL = url.standardizedFileURL
        let accessed = normalizedURL.startAccessingSecurityScopedResource()
        if forWrite && !accessed {
            return ResolvedChatHistoryStorage(
                rootURL: defaultRootURL(),
                displayPath: defaultRootURL().path,
                status: AppText.localized(en: "Custom location is not writable, using default.", zh: "自定义位置不可写，已回退默认位置"),
                usesDefault: true,
                stopAccessing: nil
            )
        }

        return ResolvedChatHistoryStorage(
            rootURL: normalizedURL,
            displayPath: normalizedURL.path,
            status: AppText.localized(en: "Custom location", zh: "自定义位置"),
            usesDefault: false,
            stopAccessing: accessed ? {
                normalizedURL.stopAccessingSecurityScopedResource()
            } : nil
        )
    }

    private static func loadStorageConfiguration() -> ChatHistoryStorageConfiguration {
        let payload = loadRawUISettings()
        let bookmarkBase64 = payload["history_storage_bookmark"] as? String ?? ""
        return ChatHistoryStorageConfiguration(
            usesDefault: payload["history_storage_uses_default"] as? Bool ?? true,
            path: payload["history_storage_path"] as? String ?? "",
            bookmarkData: bookmarkBase64.isEmpty ? nil : Data(base64Encoded: bookmarkBase64)
        )
    }

    private static func saveStorageConfiguration(_ configuration: ChatHistoryStorageConfiguration) throws {
        var payload = loadRawUISettings()
        payload["history_storage_uses_default"] = configuration.usesDefault
        payload["history_storage_path"] = configuration.path
        payload["history_storage_bookmark"] = configuration.bookmarkData?.base64EncodedString() ?? ""
        try writeRawUISettings(payload)
    }

    private static func loadRawUISettings() -> [String: Any] {
        let url = uiSettingsURL()
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return [:]
        }
        return payload
    }

    private static func writeRawUISettings(_ payload: [String: Any]) throws {
        let url = uiSettingsURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    private static func uiSettingsURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent(uiSettingsFileName)
    }

    private static func defaultRootURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent(defaultFolderName, isDirectory: true)
    }

    private static func indexFileURL(rootURL: URL) -> URL {
        rootURL.appendingPathComponent(indexFileName)
    }

    private static func threadsDirectoryURL(rootURL: URL) -> URL {
        rootURL.appendingPathComponent(threadsFolderName, isDirectory: true)
    }

    private static func threadFileURL(rootURL: URL, threadID: String) -> URL {
        threadsDirectoryURL(rootURL: rootURL).appendingPathComponent("\(threadID).json")
    }
}

enum AgentBridgeStore {
    private static let requestURL = SharedContainer.baseURL().appendingPathComponent("agent-bridge-request.json")
    private static let responseURL = SharedContainer.baseURL().appendingPathComponent("agent-bridge-response.json")

    static func enqueue(toolName: String, arguments: [String: Any]) throws -> String {
        let requestId = UUID().uuidString.lowercased()
        let payload: [String: Any] = [
            "requestId": requestId,
            "toolName": toolName,
            "arguments": arguments,
            "status": "pending",
            "createdAt": Date().timeIntervalSince1970,
        ]
        try writeJSON(payload, to: requestURL)
        try? FileManager.default.removeItem(at: responseURL)
        return requestId
    }

    static func loadResponse(requestId: String) -> [String: Any]? {
        guard
            let payload = readJSON(from: responseURL),
            String(describing: payload["requestId"] ?? "") == requestId
        else {
            return nil
        }
        return payload
    }

    static func clearResponse() {
        try? FileManager.default.removeItem(at: responseURL)
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

enum PanelStateStore {
    private static let stateURL = SharedContainer.baseURL().appendingPathComponent("panel-state.json")
    private static let selectionIntentURL = SharedContainer.baseURL().appendingPathComponent("selection-intent.json")

    static func load() -> PanelStateSnapshot? {
        guard
            let data = try? Data(contentsOf: stateURL),
            let value = try? JSONDecoder().decode(PanelStateSnapshot.self, from: data)
        else {
            return nil
        }
        return value
    }

    static func save(_ snapshot: PanelStateSnapshot) throws {
        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(snapshot)
        try data.write(to: stateURL, options: .atomic)
    }

    static func updateStatus(_ status: String?) {
        let current = load()
        let snapshot = PanelStateSnapshot(
            context: current?.context,
            currentThreadId: current?.currentThreadId,
            messages: current?.messages ?? [],
            status: status,
            updatedAt: Date().timeIntervalSince1970
        )
        try? save(snapshot)
    }

    static func loadSelectionIntent(matchingURL url: String?) -> SelectionIntentSnapshot? {
        guard
            let data = try? Data(contentsOf: selectionIntentURL),
            let value = try? JSONDecoder().decode(SelectionIntentSnapshot.self, from: data)
        else {
            return nil
        }

        let now = Date().timeIntervalSince1970
        guard now - value.updatedAt <= 120 else {
            return nil
        }

        guard !value.selection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        if let url, !url.isEmpty, value.url == url {
            return value
        }

        return value
    }
}
