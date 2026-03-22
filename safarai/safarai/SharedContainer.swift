import Foundation

enum SharedContainer {
    static let appGroupIdentifier = "group.ink.safarai"
    private static let resolvedBaseURL: URL = {
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) {
            return url
        }

        return URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("safarai-shared", isDirectory: true)
    }()

    static func baseURL() -> URL {
        resolvedBaseURL
    }
}
