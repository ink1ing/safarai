import Foundation

struct AppUpdateAsset {
    var name: String
    var downloadURL: URL
}

struct AppUpdateCheckResult {
    var currentVersion: String
    var latestVersion: String
    var releaseName: String
    var releaseNotes: String
    var releasePageURL: URL
    var dmgAsset: AppUpdateAsset?
    var zipAsset: AppUpdateAsset?
    var hasUpdate: Bool
}

enum AppUpdateError: LocalizedError {
    case invalidReleaseURL
    case releaseNotFound(Int)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidReleaseURL:
            return "更新源地址无效。"
        case .releaseNotFound(let status):
            return "无法读取 GitHub Release（HTTP \(status)）。"
        case .invalidResponse:
            return "GitHub Release 响应无效。"
        }
    }
}

enum AppUpdateService {
    private static let latestReleaseAPI = "https://api.github.com/repos/ink1ing/safarai/releases/latest"
    private static let releasesPage = "https://github.com/ink1ing/safarai/releases"

    static func checkForUpdates() async throws -> AppUpdateCheckResult {
        guard let url = URL(string: latestReleaseAPI) else {
            throw AppUpdateError.invalidReleaseURL
        }

        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Safarai", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AppUpdateError.invalidResponse
        }
        if http.statusCode == 404 {
            let currentVersion = currentAppVersion()
            return AppUpdateCheckResult(
                currentVersion: currentVersion,
                latestVersion: currentVersion,
                releaseName: "No published release",
                releaseNotes: "GitHub Releases is reachable, but no latest release is published yet.",
                releasePageURL: URL(string: releasesPage)!,
                dmgAsset: nil,
                zipAsset: nil,
                hasUpdate: false
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AppUpdateError.releaseNotFound(http.statusCode)
        }

        let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
        let currentVersion = currentAppVersion()
        let latestVersion = normalizedVersion(release.tagName)
        let fallbackReleasePageURL = URL(string: releasesPage)!
        let releasePageURL = trustedGitHubURL(from: release.htmlURL) ?? fallbackReleasePageURL
        let assets = release.assets.compactMap { asset -> AppUpdateAsset? in
            guard let downloadURL = trustedGitHubURL(from: asset.browserDownloadURL) else {
                return nil
            }
            return AppUpdateAsset(name: asset.name, downloadURL: downloadURL)
        }

        return AppUpdateCheckResult(
            currentVersion: currentVersion,
            latestVersion: latestVersion,
            releaseName: release.name?.isEmpty == false ? release.name! : release.tagName,
            releaseNotes: release.body ?? "",
            releasePageURL: releasePageURL,
            dmgAsset: assets.first { $0.name.lowercased().hasSuffix(".dmg") },
            zipAsset: assets.first { $0.name.lowercased().hasSuffix(".zip") },
            hasUpdate: compareVersions(latestVersion, currentVersion) == .orderedDescending
        )
    }

    private static func normalizedVersion(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("v") {
            return String(trimmed.dropFirst())
        }
        return trimmed
    }

    private static func currentAppVersion() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    private static func trustedGitHubURL(from value: String) -> URL? {
        guard
            let url = URL(string: value),
            url.scheme?.lowercased() == "https",
            let host = url.host?.lowercased(),
            host == "github.com" || host == "api.github.com" || host == "objects.githubusercontent.com"
        else {
            return nil
        }
        return url
    }

    private static func compareVersions(_ left: String, _ right: String) -> ComparisonResult {
        let leftParts = versionParts(left)
        let rightParts = versionParts(right)
        let count = max(leftParts.count, rightParts.count)

        for index in 0..<count {
            let leftValue = index < leftParts.count ? leftParts[index] : 0
            let rightValue = index < rightParts.count ? rightParts[index] : 0
            if leftValue > rightValue { return .orderedDescending }
            if leftValue < rightValue { return .orderedAscending }
        }

        return .orderedSame
    }

    private static func versionParts(_ value: String) -> [Int] {
        value
            .split(whereSeparator: { $0 == "." || $0 == "-" || $0 == "_" })
            .map { part in
                let digits = part.prefix { $0.isNumber }
                return Int(digits) ?? 0
            }
    }
}

private struct GitHubRelease: Decodable {
    var tagName: String
    var name: String?
    var body: String?
    var htmlURL: String
    var assets: [GitHubReleaseAsset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case name
        case body
        case htmlURL = "html_url"
        case assets
    }
}

private struct GitHubReleaseAsset: Decodable {
    var name: String
    var browserDownloadURL: String

    enum CodingKeys: String, CodingKey {
        case name
        case browserDownloadURL = "browser_download_url"
    }
}
