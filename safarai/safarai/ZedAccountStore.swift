import Foundation
import Security

struct ZedModelSummary: Codable {
    var id: String
    var label: String
    var provider: String
}

struct ZedAccountConfiguration: Codable {
    struct Account: Codable {
        var userId: String
        var login: String
        var name: String
    }

    struct Model: Codable {
        var selected: String
        var available: [ZedModelSummary]
        var lastSyncAt: TimeInterval?
    }

    var account: Account
    var accessToken: String
    var model: Model
}

enum ZedAccountStore {
    private static let zedServerURL = "https://zed.dev"

    static func load() -> ZedAccountConfiguration? {
        let url = configURL()
        guard
            let data = try? Data(contentsOf: url),
            let config = try? JSONDecoder().decode(ZedAccountConfiguration.self, from: data)
        else {
            return nil
        }
        return config
    }

    static func save(_ configuration: ZedAccountConfiguration) throws {
        let url = configURL()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(configuration)
        try data.write(to: url, options: .atomic)
    }

    static func clear() throws {
        let url = configURL()
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    static func configURL() -> URL {
        SharedContainer.baseURL().appendingPathComponent("zed-account.json")
    }

    static func importFromKeychain() async throws -> ZedAccountConfiguration {
        let zedAppPath = "/Applications/Zed.app"
        guard FileManager.default.fileExists(atPath: zedAppPath) else {
            throw ZedAccountError.zedNotInstalled
        }

        let userId = try readKeychainAccountId()
        let accessToken = try readKeychainAccessToken()
        let profile = try await fetchAuthenticatedUser(userId: userId, accessToken: accessToken)

        let config = ZedAccountConfiguration(
            account: .init(
                userId: userId,
                login: profile.login,
                name: profile.name ?? profile.login
            ),
            accessToken: accessToken,
            model: .init(selected: "", available: [], lastSyncAt: nil)
        )

        try save(config)
        return config
    }

    private static func readKeychainAccountId() throws -> String {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassInternetPassword,
            kSecAttrServer as String:  "zed.dev",
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let attrs = item as? [String: Any],
              let accountData = attrs[kSecAttrAccount as String] as? String,
              !accountData.isEmpty
        else {
            throw ZedAccountError.keychainReadFailed(
                "Could not locate Zed account id in macOS Keychain (status \(status))."
            )
        }
        return accountData
    }

    private static func readKeychainAccessToken() throws -> String {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassInternetPassword,
            kSecAttrServer as String:  "zed.dev",
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else {
            throw ZedAccountError.keychainReadFailed(
                "Could not read Zed access token from macOS Keychain (status \(status))."
            )
        }
        return token
    }

    private struct UserProfile {
        let login: String
        let name: String?
    }

    private static func fetchAuthenticatedUser(userId: String, accessToken: String) async throws -> UserProfile {
        let url = URL(string: "https://cloud.zed.dev/client/users/me")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("\(userId) \(accessToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 8

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw ZedAccountError.authFailed("Zed user request failed: \(body)")
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let user = json["user"] as? [String: Any],
              let login = user["github_login"] as? String else {
            throw ZedAccountError.authFailed("Invalid Zed user response.")
        }

        return UserProfile(login: login, name: user["name"] as? String)
    }
}

enum ZedAccountError: LocalizedError {
    case zedNotInstalled
    case keychainReadFailed(String)
    case authFailed(String)

    var errorDescription: String? {
        switch self {
        case .zedNotInstalled:
            return "Zed.app 未安装在 /Applications。"
        case .keychainReadFailed(let message):
            return "无法读取 Zed 凭据：\(message)"
        case .authFailed(let message):
            return "Zed 认证失败：\(message)"
        }
    }
}
