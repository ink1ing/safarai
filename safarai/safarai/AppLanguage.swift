import Foundation

enum AppLanguage: String, Codable {
    case en
    case zh

    static let `default`: AppLanguage = .en

    static func current() -> AppLanguage {
        let url = SharedContainer.baseURL().appendingPathComponent("ui-settings.json")
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rawValue = payload["language"] as? String,
            let language = AppLanguage(rawValue: rawValue)
        else {
            return .default
        }

        return language
    }

    var localeIdentifier: String {
        switch self {
        case .en:
            return "en"
        case .zh:
            return "zh-CN"
        }
    }
}

enum AppText {
    static func localized(en: String, zh: String) -> String {
        switch AppLanguage.current() {
        case .en:
            return en
        case .zh:
            return zh
        }
    }
}
