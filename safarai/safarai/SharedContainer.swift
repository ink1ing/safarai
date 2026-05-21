import Foundation
import Darwin

enum SharedContainer {
    static let appGroupIdentifier = "group.ink.safarai"
    private static let resolvedBaseURL: URL = {
        if isLocalTestBuild {
            return localTestBaseURL()
        }

        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) {
            return url
        }

        return URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("safarai-shared", isDirectory: true)
    }()

    static func baseURL() -> URL {
        resolvedBaseURL
    }

    static func writePrivate(_ data: Data, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        try data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static var isLocalTestBuild: Bool {
        Bundle.main.bundleURL.path.contains("/Applications/Safarai Local.app")
    }

    private static func localTestBaseURL() -> URL {
        realHomeDirectory()
            .appendingPathComponent("Library/Application Support/Safarai Local Shared", isDirectory: true)
    }

    private static func realHomeDirectory() -> URL {
        if let entry = getpwuid(getuid()), let home = entry.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: home), isDirectory: true)
        }

        return FileManager.default.homeDirectoryForCurrentUser
    }
}
