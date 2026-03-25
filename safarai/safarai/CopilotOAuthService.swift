import Foundation

enum CopilotOAuthError: LocalizedError {
    case deviceFlowStartFailed(String)
    case deviceAuthorizationExpired
    case deviceAuthorizationFailed(String)
    case invalidTokenResponse
    case invalidUserResponse
    case authFilesUnreadable(String)

    var errorDescription: String? {
        switch self {
        case .deviceFlowStartFailed(let message):
            return "GitHub Copilot 设备授权启动失败：\(message)"
        case .deviceAuthorizationExpired:
            return "GitHub Copilot 设备授权已过期，请重新发起登录。"
        case .deviceAuthorizationFailed(let message):
            return "GitHub Copilot 登录失败：\(message)"
        case .invalidTokenResponse:
            return "GitHub Copilot token 响应无效。"
        case .invalidUserResponse:
            return "GitHub Copilot 用户信息响应无效。"
        case .authFilesUnreadable(let message):
            return "无法导入本地 GitHub Copilot 凭据：\(message)"
        }
    }
}

struct CopilotDeviceSession {
    var deviceCode: String
    var userCode: String
    var verificationURI: String
    var interval: Int
    var expiresAt: TimeInterval
}

private struct CopilotDeviceCodePayload: Decodable {
    var deviceCode: String?
    var userCode: String?
    var verificationURI: String?
    var interval: Int?
    var expiresIn: Int?
    var error: String?
    var errorDescription: String?

    enum CodingKeys: String, CodingKey {
        case deviceCode = "device_code"
        case userCode = "user_code"
        case verificationURI = "verification_uri"
        case interval
        case expiresIn = "expires_in"
        case error
        case errorDescription = "error_description"
    }
}

private struct CopilotAccessTokenPayload: Decodable {
    var accessToken: String?
    var error: String?
    var errorDescription: String?
    var interval: Int?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case error
        case errorDescription = "error_description"
        case interval
    }
}

private struct CopilotImportedAuthFile: Decodable {
    var accessToken: String?
    var oauthToken: String?
    var username: String?
    var login: String?
    var email: String?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case oauthToken = "oauth_token"
        case username
        case login
        case email
    }
}

private struct GitHubUserProfile: Decodable {
    var login: String?
    var email: String?
}

final class CopilotOAuthService {
    static let shared = CopilotOAuthService()

    private let clientId = "01ab8ac9400c4e429b23"
    private let deviceCodeURL = URL(string: "https://github.com/login/device/code")!
    private let tokenURL = URL(string: "https://github.com/login/oauth/access_token")!
    private let userURL = URL(string: "https://api.github.com/user")!

    private init() {}

    func importLocalAccountIfAvailable() async throws -> CopilotAccountConfiguration? {
        let home = NSHomeDirectory()
        let authDirectory = URL(fileURLWithPath: home, isDirectory: true)
            .appendingPathComponent(".cli-proxy-api", isDirectory: true)

        guard FileManager.default.fileExists(atPath: authDirectory.path) else {
            return nil
        }

        let files: [URL]
        do {
            files = try FileManager.default.contentsOfDirectory(
                at: authDirectory,
                includingPropertiesForKeys: nil
            )
        } catch {
            throw CopilotOAuthError.authFilesUnreadable(error.localizedDescription)
        }

        let candidates = files
            .filter {
                $0.lastPathComponent.hasPrefix("github-copilot-") &&
                $0.pathExtension == "json"
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        for fileURL in candidates {
            guard
                let data = try? Data(contentsOf: fileURL),
                let raw = try? JSONDecoder().decode(CopilotImportedAuthFile.self, from: data)
            else {
                continue
            }

            let accessToken = (raw.accessToken ?? raw.oauthToken ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !accessToken.isEmpty else {
                continue
            }

            var login = (raw.username ?? raw.login ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            var email = raw.email?.trimmingCharacters(in: .whitespacesAndNewlines)

            if login.isEmpty || email == nil {
                let profile = try await fetchAuthenticatedUser(accessToken: accessToken)
                if login.isEmpty {
                    login = profile.login
                }
                if email == nil {
                    email = profile.email
                }
            }

            guard !login.isEmpty else {
                continue
            }

            let config = CopilotAccountConfiguration(
                account: .init(login: login, email: email),
                accessToken: accessToken,
                model: .init(selected: "", available: [], lastSyncAt: nil)
            )
            try CopilotAccountStore.save(config)
            return config
        }

        return nil
    }

    func startDeviceFlow() async throws -> CopilotDeviceSession {
        var request = URLRequest(url: deviceCodeURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = URLComponents.formURLEncoded([
            "client_id": clientId,
            "scope": "read:user",
        ]).data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CopilotOAuthError.invalidTokenResponse
        }

        guard let payload = try? JSONDecoder().decode(CopilotDeviceCodePayload.self, from: data) else {
            throw CopilotOAuthError.invalidTokenResponse
        }

        guard (200..<300).contains(http.statusCode) else {
            let message = payload.errorDescription ?? String(data: data, encoding: .utf8) ?? "unknown"
            throw CopilotOAuthError.deviceFlowStartFailed(message)
        }

        guard
            let deviceCode = payload.deviceCode?.trimmingCharacters(in: .whitespacesAndNewlines),
            let userCode = payload.userCode?.trimmingCharacters(in: .whitespacesAndNewlines),
            let verificationURI = payload.verificationURI?.trimmingCharacters(in: .whitespacesAndNewlines),
            !deviceCode.isEmpty,
            !userCode.isEmpty,
            !verificationURI.isEmpty
        else {
            throw CopilotOAuthError.invalidTokenResponse
        }

        return CopilotDeviceSession(
            deviceCode: deviceCode,
            userCode: userCode,
            verificationURI: verificationURI,
            interval: max(payload.interval ?? 5, 2),
            expiresAt: Date().timeIntervalSince1970 + Double(payload.expiresIn ?? 900)
        )
    }

    func completeDeviceFlow(session: CopilotDeviceSession) async throws -> CopilotAccountConfiguration {
        var pollInterval = max(session.interval, 2)

        while Date().timeIntervalSince1970 < session.expiresAt {
            try await Task.sleep(nanoseconds: UInt64(pollInterval) * 1_000_000_000)

            var request = URLRequest(url: tokenURL)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.httpBody = URLComponents.formURLEncoded([
                "client_id": clientId,
                "device_code": session.deviceCode,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            ]).data(using: .utf8)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw CopilotOAuthError.invalidTokenResponse
            }
            guard let payload = try? JSONDecoder().decode(CopilotAccessTokenPayload.self, from: data) else {
                throw CopilotOAuthError.invalidTokenResponse
            }

            if payload.error == "authorization_pending" {
                continue
            }

            if payload.error == "slow_down" {
                pollInterval = min(max(payload.interval ?? (pollInterval + 2), pollInterval + 2), 15)
                continue
            }

            if let error = payload.error, !error.isEmpty {
                let message = payload.errorDescription ?? error
                throw CopilotOAuthError.deviceAuthorizationFailed(message)
            }

            guard (200..<300).contains(http.statusCode),
                  let accessToken = payload.accessToken?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !accessToken.isEmpty
            else {
                let message = String(data: data, encoding: .utf8) ?? "unknown"
                throw CopilotOAuthError.deviceAuthorizationFailed(message)
            }

            let profile = try await fetchAuthenticatedUser(accessToken: accessToken)
            let config = CopilotAccountConfiguration(
                account: .init(login: profile.login, email: profile.email),
                accessToken: accessToken,
                model: .init(selected: "", available: [], lastSyncAt: nil)
            )
            try CopilotAccountStore.save(config)
            return config
        }

        throw CopilotOAuthError.deviceAuthorizationExpired
    }

    private func fetchAuthenticatedUser(accessToken: String) async throws -> (login: String, email: String?) {
        var request = URLRequest(url: userURL)
        request.httpMethod = "GET"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "unknown"
            throw CopilotOAuthError.deviceAuthorizationFailed(message)
        }

        guard
            let profile = try? JSONDecoder().decode(GitHubUserProfile.self, from: data),
            let login = profile.login?.trimmingCharacters(in: .whitespacesAndNewlines),
            !login.isEmpty
        else {
            throw CopilotOAuthError.invalidUserResponse
        }

        let email = profile.email?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (login, email?.isEmpty == true ? nil : email)
    }
}

private extension URLComponents {
    static func formURLEncoded(_ items: [String: String]) -> String {
        var components = URLComponents()
        components.queryItems = items.map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.percentEncodedQuery ?? ""
    }
}
