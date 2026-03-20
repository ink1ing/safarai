import Cocoa
import CryptoKit
@preconcurrency import Dispatch
import Foundation
import Network

enum CodexOAuthError: LocalizedError {
    case callbackServerUnavailable
    case callbackTimedOut
    case callbackRejected(String)
    case tokenExchangeFailed(String)
    case invalidTokenResponse
    case unableToOpenBrowser

    var errorDescription: String? {
        switch self {
        case .callbackServerUnavailable:
            return "无法启动本地 OAuth 回调服务。"
        case .callbackTimedOut:
            return "Codex 登录超时，请重新发起登录。"
        case .callbackRejected(let message):
            return "Codex 登录失败：\(message)"
        case .tokenExchangeFailed(let message):
            return "Codex token 交换失败：\(message)"
        case .invalidTokenResponse:
            return "Codex token 响应无效。"
        case .unableToOpenBrowser:
            return "无法拉起系统浏览器。"
        }
    }
}

struct CodexOAuthResult {
    var configuration: CodexAccountConfiguration
}

private struct CodexLoginStateSnapshot: Codable {
    var loginInProgress: Bool
    var stage: String
    var lastError: String?
    var updatedAt: TimeInterval

    enum CodingKeys: String, CodingKey {
        case loginInProgress = "login_in_progress"
        case stage
        case lastError = "last_error"
        case updatedAt = "updated_at"
    }
}

private final class CallbackResolutionState: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false

    func finish(_ action: () -> Void) {
        lock.lock()
        defer { lock.unlock() }

        guard !finished else {
            return
        }

        finished = true
        action()
    }
}

final class CodexOAuthService {
    static let shared = CodexOAuthService()

    private let clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
    private let authorizeURL = URL(string: "https://auth.openai.com/oauth/authorize")!
    private let tokenURL = URL(string: "https://auth.openai.com/oauth/token")!
    private let callbackPath = "/auth/callback"
    private let portRange = 1455...1465
    private let loginStateURL = SharedContainer.baseURL().appendingPathComponent("codex-login-state.json")

    private init() {}

    func startLogin() async throws -> CodexOAuthResult {
        let listener = try startCallbackListener()
        updateLoginState(inProgress: true, stage: "listener_created")
        defer { listener.listener.cancel() }

        let verifier = generateCodeVerifier()
        let state = UUID().uuidString.lowercased()
        let redirectURI = "http://localhost:\(listener.port)\(callbackPath)"
        let fallbackRedirectURI = "http://127.0.0.1:\(listener.port)\(callbackPath)"
        let authURL = buildAuthorizeURL(state: state, redirectURI: redirectURI, codeVerifier: verifier)
        let fallbackURL = buildAuthorizeURL(state: state, redirectURI: fallbackRedirectURI, codeVerifier: verifier)
        let callbackTask = prepareCallbackWait(using: listener.listener, expectedState: state)
        updateLoginState(inProgress: true, stage: "listener_starting")
        listener.listener.start(queue: .global(qos: .userInitiated))
        try await waitForListenerReady(listener.listener)

        updateLoginState(inProgress: true, stage: "browser_open_requested")
        let browserOpened = await MainActor.run {
            NSWorkspace.shared.open(authURL)
        }
        if !browserOpened {
            let fallbackOpened = await MainActor.run {
                NSWorkspace.shared.open(fallbackURL)
            }
            guard fallbackOpened else {
                updateLoginState(inProgress: false, stage: "browser_open_failed", error: CodexOAuthError.unableToOpenBrowser.localizedDescription)
                throw CodexOAuthError.unableToOpenBrowser
            }
            updateLoginState(inProgress: true, stage: "browser_open_fallback")
        }
        updateLoginState(inProgress: true, stage: "callback_waiting")

        let callback: OAuthCallback
        do {
            callback = try await callbackTask.value
        } catch {
            updateLoginState(inProgress: false, stage: "callback_failed", error: error.localizedDescription)
            throw error
        }
        updateLoginState(inProgress: true, stage: "callback_received")

        let tokenResponse: TokenResponse
        do {
            updateLoginState(inProgress: true, stage: "token_exchange")
            tokenResponse = try await exchangeCode(
                code: callback.code,
                redirectURI: redirectURI,
                codeVerifier: verifier
            )
        } catch {
            updateLoginState(inProgress: false, stage: "token_exchange_failed", error: error.localizedDescription)
            throw error
        }

        guard
            let accessToken = tokenResponse.accessToken,
            let refreshToken = tokenResponse.refreshToken
        else {
            updateLoginState(inProgress: false, stage: "token_invalid", error: CodexOAuthError.invalidTokenResponse.localizedDescription)
            throw CodexOAuthError.invalidTokenResponse
        }

        let claims = decodeJWT(tokenResponse.idToken)
        let email = (claims?["email"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown"
        let accountId = (claims?["sub"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? email

        var configuration = CodexAccountConfiguration.make(
            email: email,
            accountId: accountId,
            accessToken: accessToken,
            refreshToken: refreshToken,
            idToken: tokenResponse.idToken,
            expiresAt: tokenResponse.expiresIn.map { Date().timeIntervalSince1970 + Double($0) },
            selectedModel: "gpt-5",
            availableModels: []
        )

        let models: [CodexModelSummary]
        do {
            updateLoginState(inProgress: true, stage: "models_fetch")
            models = try await CodexModelService.shared.fetchModels(configuration: configuration)
        } catch {
            updateLoginState(inProgress: false, stage: "models_fetch_failed", error: error.localizedDescription)
            throw error
        }
        configuration.model.available = models
        configuration.model.lastSyncAt = Date().timeIntervalSince1970
        if !models.contains(where: { $0.id == configuration.model.selected }) {
            configuration.model.selected = models.first?.id ?? "gpt-5"
        }

        try CodexAccountStore.save(configuration)
        updateLoginState(inProgress: false, stage: "completed")
        return CodexOAuthResult(configuration: configuration)
    }

    func refreshIfNeeded(_ configuration: CodexAccountConfiguration) async throws -> CodexAccountConfiguration {
        guard let expiresAt = configuration.tokens.expiresAt else {
            return configuration
        }

        if expiresAt - Date().timeIntervalSince1970 > 120 {
            return configuration
        }

        return try await refresh(configuration)
    }

    func refresh(_ configuration: CodexAccountConfiguration) async throws -> CodexAccountConfiguration {
        let refreshToken = configuration.tokens.refreshToken
        guard !refreshToken.isEmpty else {
            throw CodexOAuthError.tokenExchangeFailed("缺少 refresh token")
        }

        var request = URLRequest(url: tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let body = URLComponents.formURLEncoded([
            "grant_type": "refresh_token",
            "client_id": clientId,
            "refresh_token": refreshToken,
        ])
        request.httpBody = body.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CodexOAuthError.invalidTokenResponse
        }

        let tokenResponse = try decodeTokenResponse(from: data, statusCode: httpResponse.statusCode)

        var next = configuration
        next.tokens.accessToken = tokenResponse.accessToken ?? configuration.tokens.accessToken
        next.tokens.refreshToken = tokenResponse.refreshToken ?? configuration.tokens.refreshToken
        next.tokens.idToken = tokenResponse.idToken ?? configuration.tokens.idToken
        next.tokens.expiresAt = tokenResponse.expiresIn.map { Date().timeIntervalSince1970 + Double($0) }

        try CodexAccountStore.save(next)
        return next
    }

    private func updateLoginState(inProgress: Bool, stage: String, error: String? = nil) {
        let directory = loginStateURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let payload = CodexLoginStateSnapshot(
            loginInProgress: inProgress,
            stage: stage,
            lastError: error,
            updatedAt: Date().timeIntervalSince1970
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(payload) {
            try? data.write(to: loginStateURL, options: .atomic)
        }
    }

    private func buildAuthorizeURL(state: String, redirectURI: String, codeVerifier: String) -> URL {
        var components = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: "openid email profile offline_access"),
            .init(name: "state", value: state),
            .init(name: "prompt", value: "login"),
            .init(name: "id_token_add_organizations", value: "true"),
            .init(name: "codex_cli_simplified_flow", value: "true"),
            .init(name: "code_challenge", value: generateCodeChallenge(codeVerifier)),
            .init(name: "code_challenge_method", value: "S256"),
        ]
        return components.url!
    }

    private func exchangeCode(code: String, redirectURI: String, codeVerifier: String) async throws -> TokenResponse {
        var request = URLRequest(url: tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let body = URLComponents.formURLEncoded([
            "grant_type": "authorization_code",
            "client_id": clientId,
            "code": code,
            "redirect_uri": redirectURI,
            "code_verifier": codeVerifier,
        ])
        request.httpBody = body.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CodexOAuthError.invalidTokenResponse
        }

        return try decodeTokenResponse(from: data, statusCode: httpResponse.statusCode)
    }

    private func decodeTokenResponse(from data: Data, statusCode: Int) throws -> TokenResponse {
        if !(200..<300).contains(statusCode) {
            let message = String(data: data, encoding: .utf8) ?? "unknown"
            throw CodexOAuthError.tokenExchangeFailed(message)
        }

        guard let decoded = try? JSONDecoder().decode(TokenResponse.self, from: data) else {
            throw CodexOAuthError.invalidTokenResponse
        }
        return decoded
    }

    private func startCallbackListener() throws -> (listener: NWListener, port: UInt16) {
        for candidate in portRange {
            do {
                let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(integerLiteral: NWEndpoint.Port.IntegerLiteralType(candidate)))
                return (listener, UInt16(candidate))
            } catch {
                continue
            }
        }

        throw CodexOAuthError.callbackServerUnavailable
    }

    private func waitForListenerReady(_ listener: NWListener) async throws {
        try await withCheckedThrowingContinuation { continuation in
            let resolutionState = CallbackResolutionState()

            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    resolutionState.finish {
                        listener.stateUpdateHandler = nil
                        continuation.resume(returning: ())
                    }
                case .failed(let error):
                    resolutionState.finish {
                        listener.stateUpdateHandler = nil
                        continuation.resume(throwing: error)
                    }
                default:
                    break
                }
            }
        }
    }

    private func prepareCallbackWait(using listener: NWListener, expectedState: String) -> Task<OAuthCallback, Error> {
        let resolutionState = CallbackResolutionState()
        let stream = AsyncThrowingStream<OAuthCallback, Error> { continuation in
            Task {
                try? await Task.sleep(nanoseconds: 600_000_000_000)
                resolutionState.finish {
                    listener.cancel()
                    continuation.finish(throwing: CodexOAuthError.callbackTimedOut)
                }
            }

            listener.newConnectionHandler = { connection in
                connection.start(queue: .global(qos: .userInitiated))
                connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { data, _, _, _ in
                    defer {
                        connection.cancel()
                    }

                    let requestText = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    let firstLine = requestText.components(separatedBy: "\r\n").first ?? ""
                    let path = firstLine.components(separatedBy: " ").dropFirst().first ?? ""
                    guard let url = URL(string: "http://localhost\(path)") else {
                        self.respond(connection, body: "Invalid callback")
                        return
                    }

                    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
                    let state = components?.queryItems?.first(where: { $0.name == "state" })?.value
                    let code = components?.queryItems?.first(where: { $0.name == "code" })?.value
                    let errorValue = components?.queryItems?.first(where: { $0.name == "error" })?.value

                    if let errorValue {
                        resolutionState.finish {
                            self.respond(connection, body: "Codex login failed. You can close this window.")
                            continuation.finish(throwing: CodexOAuthError.callbackRejected(errorValue))
                            listener.cancel()
                        }
                        return
                    }

                    guard state == expectedState, let code else {
                        self.respond(connection, body: "Codex login state mismatch. You can close this window.")
                        return
                    }

                    resolutionState.finish {
                        self.respond(connection, body: "Codex login succeeded. You can close this window.")
                        continuation.yield(OAuthCallback(code: code))
                        continuation.finish()
                        listener.cancel()
                    }
                }
            }
        }

        return Task {
            var iterator = stream.makeAsyncIterator()
            guard let callback = try await iterator.next() else {
                throw CodexOAuthError.callbackTimedOut
            }
            return callback
        }
    }

    private func respond(_ connection: NWConnection, body: String) {
        let html = """
        <html><body style="font-family:-apple-system;padding:24px;">
        <h2>\(body)</h2>
        </body></html>
        """
        let response = """
        HTTP/1.1 200 OK\r
        Content-Type: text/html; charset=utf-8\r
        Content-Length: \(html.utf8.count)\r
        Connection: close\r
        \r
        \(html)
        """
        connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in })
    }

    private func generateCodeVerifier() -> String {
        let data = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        return base64URLEncode(data)
    }

    private func generateCodeChallenge(_ verifier: String) -> String {
        let hash = SHA256.hash(data: Data(verifier.utf8))
        return base64URLEncode(Data(hash))
    }

    private func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func decodeJWT(_ token: String?) -> [String: Any]? {
        guard
            let token,
            let payload = token.split(separator: ".").dropFirst().first
        else {
            return nil
        }

        var value = String(payload)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while value.count % 4 != 0 {
            value.append("=")
        }

        guard
            let data = Data(base64Encoded: value),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }

        return json
    }
}

private struct OAuthCallback {
    let code: String
}

private struct TokenResponse: Decodable {
    let accessToken: String?
    let refreshToken: String?
    let idToken: String?
    let expiresIn: Int?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case idToken = "id_token"
        case expiresIn = "expires_in"
    }
}

private extension URLComponents {
    static func formURLEncoded(_ items: [String: String]) -> String {
        var components = URLComponents()
        components.queryItems = items.map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.percentEncodedQuery ?? ""
    }
}
