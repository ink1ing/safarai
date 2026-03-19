import AppKit
import CryptoKit
import Foundation
import Network

enum NativeCodexOAuthError: LocalizedError {
    case callbackServerUnavailable
    case callbackTimedOut
    case loginAlreadyInProgress
    case callbackRejected(String)
    case tokenExchangeFailed(String)
    case invalidTokenResponse
    case unableToOpenBrowser
    case notLoggedIn

    var errorDescription: String? {
        switch self {
        case .callbackServerUnavailable:
            return "无法启动本地 OAuth 回调服务。"
        case .callbackTimedOut:
            return "Codex 登录超时，请重新发起登录。"
        case .loginAlreadyInProgress:
            return "Codex 登录已在进行中，请完成浏览器授权。"
        case .callbackRejected(let message):
            return "Codex 登录失败：\(message)"
        case .tokenExchangeFailed(let message):
            return "Codex token 交换失败：\(message)"
        case .invalidTokenResponse:
            return "Codex token 响应无效。"
        case .unableToOpenBrowser:
            return "无法拉起系统浏览器。"
        case .notLoggedIn:
            return "当前未登录 Codex。"
        }
    }
}

struct NativeCodexStatusPayload {
    let authState: String
    let email: String?
    let accountId: String?
    let selectedModel: String
    let availableModels: [[String: String]]
    let expiresAt: TimeInterval?
    let loginInProgress: Bool
}

final class NativeCodexOAuthService {
    static let shared = NativeCodexOAuthService()

    private let clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
    private let authorizeURL = URL(string: "https://auth.openai.com/oauth/authorize")!
    private let tokenURL = URL(string: "https://auth.openai.com/oauth/token")!
    private let callbackPath = "/auth/callback"
    private let portRange = 1455...1465
    private let stateQueue = DispatchQueue(label: "ink.safarai.codex.oauth")
    private let loginStateURL = NativeSharedContainer.baseURL().appendingPathComponent("codex-login-state.json")

    private var listener: NWListener?
    private var pendingState: String?
    private var pendingVerifier: String?
    private var pendingRedirectURI: String?
    private var loginInProgress = false

    private init() {}

    func currentStatus(reasoningEffort: String) -> NativeCodexStatusPayload {
        let configuration = NativeCodexAccountStore.load()
        return NativeCodexStatusPayload(
            authState: configuration == nil ? "logged_out" : "logged_in",
            email: configuration?.account.email,
            accountId: configuration?.account.accountId,
            selectedModel: configuration?.model.selected ?? "gpt-5",
            availableModels: (configuration?.model.available ?? []).map { ["id": $0.id, "label": $0.label] },
            expiresAt: configuration?.tokens.expiresAt,
            loginInProgress: readLoginState()
        )
    }

    func startLogin() throws {
        let alreadyRunning = stateQueue.sync { loginInProgress }
        if alreadyRunning {
            throw NativeCodexOAuthError.loginAlreadyInProgress
        }

        let callback = try startCallbackListener()
        let verifier = generateCodeVerifier()
        let state = UUID().uuidString.lowercased()
        let redirectURI = "http://localhost:\(callback.port)\(callbackPath)"
        let authURL = buildAuthorizeURL(state: state, redirectURI: redirectURI, codeVerifier: verifier)

        stateQueue.sync {
            self.listener = callback.listener
            self.pendingState = state
            self.pendingVerifier = verifier
            self.pendingRedirectURI = redirectURI
            self.loginInProgress = true
        }

        callback.listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection)
        }
        callback.listener.start(queue: stateQueue)

        guard NSWorkspace.shared.open(authURL) else {
            clearPendingState()
            throw NativeCodexOAuthError.unableToOpenBrowser
        }

        stateQueue.asyncAfter(deadline: .now() + 600) { [weak self] in
            self?.timeoutLogin()
        }
    }

    func logout() throws {
        try NativeCodexAccountStore.clear()
        clearPendingState()
    }

    func refreshModels() async throws -> NativeCodexAccountConfiguration {
        guard let configuration = NativeCodexAccountStore.load() else {
            throw NativeCodexOAuthError.notLoggedIn
        }
        let refreshed = try await refreshIfNeeded(configuration)
        let models = try await NativeCodexModelService.shared.fetchModels(configuration: refreshed)
        var next = refreshed
        next.model.available = models
        next.model.lastSyncAt = Date().timeIntervalSince1970
        if !models.contains(where: { $0.id == next.model.selected }) {
            next.model.selected = models.first?.id ?? "gpt-5"
        }
        try NativeCodexAccountStore.save(next)
        return next
    }

    func saveSelectedModel(_ selectedModel: String) throws -> NativeCodexAccountConfiguration {
        guard var configuration = NativeCodexAccountStore.load() else {
            throw NativeCodexOAuthError.notLoggedIn
        }
        configuration.model.selected = selectedModel
        try NativeCodexAccountStore.save(configuration)
        return configuration
    }

    func refreshIfNeeded(_ configuration: NativeCodexAccountConfiguration) async throws -> NativeCodexAccountConfiguration {
        guard let expiresAt = configuration.tokens.expiresAt else {
            return configuration
        }
        if expiresAt - Date().timeIntervalSince1970 > 120 {
            return configuration
        }
        return try await refresh(configuration)
    }

    func refresh(_ configuration: NativeCodexAccountConfiguration) async throws -> NativeCodexAccountConfiguration {
        guard !configuration.tokens.refreshToken.isEmpty else {
            throw NativeCodexOAuthError.notLoggedIn
        }

        var request = URLRequest(url: tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = URLComponents.formURLEncoded([
            "grant_type": "refresh_token",
            "client_id": clientId,
            "refresh_token": configuration.tokens.refreshToken,
        ]).data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NativeCodexOAuthError.invalidTokenResponse
        }
        let token = try decodeTokenResponse(data: data, statusCode: httpResponse.statusCode)

        var next = configuration
        next.tokens.accessToken = token.accessToken ?? configuration.tokens.accessToken
        next.tokens.refreshToken = token.refreshToken ?? configuration.tokens.refreshToken
        next.tokens.idToken = token.idToken ?? configuration.tokens.idToken
        next.tokens.expiresAt = token.expiresIn.map { Date().timeIntervalSince1970 + Double($0) }
        try NativeCodexAccountStore.save(next)
        return next
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

    private func startCallbackListener() throws -> (listener: NWListener, port: UInt16) {
        for candidate in portRange {
            if let port = NWEndpoint.Port(rawValue: UInt16(candidate)),
               let listener = try? NWListener(using: .tcp, on: port) {
                return (listener, UInt16(candidate))
            }
        }
        throw NativeCodexOAuthError.callbackServerUnavailable
    }

    private func handle(connection: NWConnection) {
        connection.start(queue: stateQueue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, _, _ in
            guard let self else { return }
            defer { connection.cancel() }

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

            if errorValue != nil {
                self.respond(connection, body: "Codex login failed. You can close this window.")
                self.clearPendingState()
                return
            }

            let expectedState = self.stateQueue.sync { self.pendingState }
            guard state == expectedState, let code else {
                self.respond(connection, body: "Codex login state mismatch. You can close this window.")
                return
            }

            self.respond(connection, body: "Codex login succeeded. You can close this window.")
            Task {
                await self.completeLogin(code: code)
            }
        }
    }

    private func completeLogin(code: String) async {
        do {
            let redirectURI = stateQueue.sync { pendingRedirectURI ?? "" }
            let verifier = stateQueue.sync { pendingVerifier ?? "" }
            let token = try await exchangeCode(code: code, redirectURI: redirectURI, codeVerifier: verifier)
            guard
                let accessToken = token.accessToken,
                let refreshToken = token.refreshToken
            else {
                clearPendingState()
                return
            }

            let claims = decodeJWT(token.idToken)
            let email = (claims?["email"] as? String) ?? "unknown"
            let accountId = (claims?["sub"] as? String) ?? email
            let configuration = NativeCodexAccountConfiguration(
                account: .init(email: email, accountId: accountId),
                tokens: .init(
                    accessToken: accessToken,
                    refreshToken: refreshToken,
                    idToken: token.idToken,
                    expiresAt: token.expiresIn.map { Date().timeIntervalSince1970 + Double($0) }
                ),
                model: .init(selected: "gpt-5", available: [], lastSyncAt: nil)
            )
            var next = configuration
            let models = try await NativeCodexModelService.shared.fetchModels(configuration: configuration)
            next.model.available = models
            next.model.lastSyncAt = Date().timeIntervalSince1970
            next.model.selected = models.first?.id ?? "gpt-5"
            try NativeCodexAccountStore.save(next)
            clearPendingState()
        } catch {
            clearPendingState()
        }
    }

    private func exchangeCode(code: String, redirectURI: String, codeVerifier: String) async throws -> NativeTokenResponse {
        var request = URLRequest(url: tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = URLComponents.formURLEncoded([
            "grant_type": "authorization_code",
            "client_id": clientId,
            "code": code,
            "redirect_uri": redirectURI,
            "code_verifier": codeVerifier,
        ]).data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NativeCodexOAuthError.invalidTokenResponse
        }
        return try decodeTokenResponse(data: data, statusCode: httpResponse.statusCode)
    }

    private func decodeTokenResponse(data: Data, statusCode: Int) throws -> NativeTokenResponse {
        guard (200..<300).contains(statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "unknown"
            throw NativeCodexOAuthError.tokenExchangeFailed(message)
        }
        guard let decoded = try? JSONDecoder().decode(NativeTokenResponse.self, from: data) else {
            throw NativeCodexOAuthError.invalidTokenResponse
        }
        return decoded
    }

    private func respond(_ connection: NWConnection, body: String) {
        let html = """
        <html><body style="font-family:-apple-system;padding:24px;"><h2>\(body)</h2></body></html>
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

    private func timeoutLogin() {
        let shouldTimeout = stateQueue.sync { loginInProgress }
        if shouldTimeout {
            clearPendingState()
        }
    }

    private func clearPendingState() {
        stateQueue.sync {
            listener?.cancel()
            listener = nil
            pendingState = nil
            pendingVerifier = nil
            pendingRedirectURI = nil
            loginInProgress = false
        }
    }

    private func readLoginState() -> Bool {
        guard
            let data = try? Data(contentsOf: loginStateURL),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return false
        }
        return payload["login_in_progress"] as? Bool == true
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
        while value.count % 4 != 0 { value.append("=") }
        guard
            let data = Data(base64Encoded: value),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return json
    }
}

struct NativeTokenResponse: Decodable {
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
