import AppKit
import Foundation

enum NativeRouter {
    static func route(message: Any?) -> [String: Any] {
        guard
            let payload = message as? [String: Any],
            let type = payload["type"] as? String
        else {
            return MockNativeRouter.error(code: "invalid_request", message: "native message payload 无效")
        }

        let requestId = payload["id"] as? String ?? "req_missing"
        let context = ((payload["payload"] as? [String: Any])?["context"] as? [String: Any]) ?? [:]
        let config = ProviderConfig.load()

        switch type {
        case "get_status":
            let status = NativeCodexOAuthService.shared.currentStatus(reasoningEffort: config.reasoningEffort)
            return [
                "ok": true,
                "payload": [
                    "request_id": requestId,
                    "authState": status.authState,
                    "selectedModel": status.selectedModel,
                    "email": status.email as Any,
                    "accountId": status.accountId as Any,
                    "expiresAt": status.expiresAt as Any,
                    "availableModels": status.availableModels,
                    "loginInProgress": status.loginInProgress,
                ],
            ]
        case "start_login":
            do {
                try openCodexLoginURL()
                return [
                    "ok": true,
                    "payload": [
                        "request_id": requestId,
                        "answer": "已请求宿主 App 打开 Codex 登录流程。",
                        "loginDispatch": "native_url_opened",
                    ],
                ]
            } catch {
                return MockNativeRouter.error(code: "oauth_start_failed", message: error.localizedDescription)
            }
        case "logout":
            do {
                try NativeCodexOAuthService.shared.logout()
                return [
                    "ok": true,
                    "payload": [
                        "request_id": requestId,
                        "answer": "已登出 Codex。",
                    ],
                ]
            } catch {
                return MockNativeRouter.error(code: "logout_failed", message: error.localizedDescription)
            }
        case "refresh_models":
            let semaphore = DispatchSemaphore(value: 0)
            var result: [String: Any] = MockNativeRouter.error(code: "refresh_failed", message: "模型刷新失败")
            Task {
                defer { semaphore.signal() }
                do {
                    let configuration = try await NativeCodexOAuthService.shared.refreshModels()
                    result = statusPayload(requestId: requestId, configuration: configuration)
                } catch {
                    result = MockNativeRouter.error(code: "refresh_failed", message: error.localizedDescription)
                }
            }
            semaphore.wait()
            return result
        case "save_selected_model":
            let selectedModel = ((payload["payload"] as? [String: Any])?["selectedModel"] as? String) ?? ""
            do {
                let configuration = try NativeCodexOAuthService.shared.saveSelectedModel(selectedModel)
                return statusPayload(requestId: requestId, configuration: configuration, answer: "默认模型已保存。")
            } catch {
                return MockNativeRouter.error(code: "save_model_failed", message: error.localizedDescription)
            }
        default:
            let client = LocalProviderClient(config: config)
            do {
                return try client.run(requestType: type, context: context, requestId: requestId)
            } catch {
                return MockNativeRouter.error(code: "provider_failed", message: error.localizedDescription)
            }
        }
    }

    private static func statusPayload(
        requestId: String,
        configuration: NativeCodexAccountConfiguration? = NativeCodexAccountStore.load(),
        answer: String? = nil
    ) -> [String: Any] {
        let availableModels = (configuration?.model.available ?? []).map {
            ["id": $0.id, "label": $0.label]
        }
        return [
            "ok": true,
            "payload": [
                "request_id": requestId,
                "answer": answer as Any,
                "authState": configuration == nil ? "logged_out" : "logged_in",
                "selectedModel": configuration?.model.selected ?? "gpt-5",
                "email": configuration?.account.email as Any,
                "accountId": configuration?.account.accountId as Any,
                "expiresAt": configuration?.tokens.expiresAt as Any,
                "availableModels": availableModels,
                "loginInProgress": NativeCodexOAuthService.shared.currentStatus(reasoningEffort: "medium").loginInProgress,
            ],
        ]
    }

    private static func openCodexLoginURL() throws {
        guard let url = URL(string: "safarai://start-codex-login") else {
            throw NSError(
                domain: "ink.safarai.oauth",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "无法构造登录 URL"]
            )
        }
        if NSWorkspace.shared.open(url) == false {
            throw NSError(
                domain: "ink.safarai.oauth",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "无法唤起宿主 App 处理登录"]
            )
        }
    }
}
