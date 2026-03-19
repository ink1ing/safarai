import Foundation

enum NativeCodexLoginRequestStore {
    static func markPending() throws {
        let url = requestURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let payload = ["pending": true, "createdAt": Date().timeIntervalSince1970] as [String: Any]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    private static func requestURL() -> URL {
        NativeSharedContainer.baseURL().appendingPathComponent("codex-login-request.json")
    }
}
