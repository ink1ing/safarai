import Foundation

enum CodexLoginRequestStore {
    static func requestURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent("codex-login-request.json")
    }

    static func loadPendingRequest() -> Bool {
        let url = requestURL()
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return false
        }
        return payload["pending"] as? Bool == true
    }

    static func clear() {
        let url = requestURL()
        try? FileManager.default.removeItem(at: url)
    }
}
