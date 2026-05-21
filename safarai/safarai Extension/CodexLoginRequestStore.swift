import Foundation

enum NativeCodexLoginRequestStore {
    static func markPending() throws {
        let url = requestURL()
        let payload = ["pending": true, "createdAt": Date().timeIntervalSince1970] as [String: Any]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try NativeSharedContainer.writePrivate(data, to: url)
    }

    private static func requestURL() -> URL {
        NativeSharedContainer.baseURL().appendingPathComponent("codex-login-request.json")
    }
}
