import Foundation

enum NativeSharedContainer {
    static let appGroupIdentifier = "group.ink.safarai"
    private static let resolvedBaseURL: URL = {
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) {
            return url
        }

        let baseDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return baseDirectory
            .appendingPathComponent("ink.safarai", isDirectory: true)
            .appendingPathComponent("debug-shared", isDirectory: true)
    }()

    static func baseURL() -> URL {
        resolvedBaseURL
    }
}
