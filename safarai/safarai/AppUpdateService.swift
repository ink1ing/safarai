import AppKit
import Foundation

struct AppUpdateResult {
    var currentVersion: String
    var currentBuild: String
    var latestVersion: String
    var latestTag: String
    var assetName: String?
    var assetDownloadURL: URL?
    var releaseURL: URL?
    var isUpdateAvailable: Bool
    var statusText: String
}

enum AppUpdateError: LocalizedError {
    case invalidResponse
    case noReleaseFound
    case noInstallableAsset
    case downloadFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "更新信息响应无效。"
        case .noReleaseFound:
            return "未找到可用的发布版本。"
        case .noInstallableAsset:
            return "最新版本没有可安装的 DMG 或 ZIP 资源。"
        case .downloadFailed(let message):
            return "下载更新失败：\(message)"
        }
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

private struct GitHubRelease: Decodable {
    var tagName: String
    var htmlURL: String?
    var draft: Bool
    var prerelease: Bool
    var assets: [GitHubReleaseAsset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case htmlURL = "html_url"
        case draft
        case prerelease
        case assets
    }
}

final class AppUpdateService {
    static let shared = AppUpdateService()

    private let releasesURL = URL(string: "https://api.github.com/repos/ink1ing/safarai/releases")!
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 600
        self.session = URLSession(configuration: config)
    }

    func currentVersionInfo() -> (version: String, build: String) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        return (version, build)
    }

    func checkForUpdates() async throws -> AppUpdateResult {
        let current = currentVersionInfo()

        var request = URLRequest(url: releasesURL)
        request.httpMethod = "GET"
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("SafariAIUpdater/1.0", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw AppUpdateError.invalidResponse
        }

        guard let releases = try? JSONDecoder().decode([GitHubRelease].self, from: data) else {
            throw AppUpdateError.invalidResponse
        }

        guard let release = releases.first(where: { !$0.draft && !$0.prerelease }) else {
            throw AppUpdateError.noReleaseFound
        }

        let normalizedTag = normalizeVersionString(release.tagName)
        let asset = preferredInstallAsset(from: release.assets)
        let updateAvailable = isNewerVersion(normalizedTag, than: current.version) && asset != nil
        let statusText: String
        if updateAvailable {
            let assetLabel = asset?.name ?? "no asset"
            statusText = "发现新版本 \(release.tagName) (\(assetLabel))"
        } else if isNewerVersion(normalizedTag, than: current.version) && asset == nil {
            statusText = "发现新版本 \(release.tagName)，但没有可安装资源"
        } else {
            statusText = "当前已是最新版本"
        }

        return AppUpdateResult(
            currentVersion: current.version,
            currentBuild: current.build,
            latestVersion: normalizedTag,
            latestTag: release.tagName,
            assetName: asset?.name,
            assetDownloadURL: asset.flatMap { URL(string: $0.browserDownloadURL) },
            releaseURL: release.htmlURL.flatMap(URL.init(string:)),
            isUpdateAvailable: updateAvailable,
            statusText: statusText
        )
    }

    func installUpdate(using result: AppUpdateResult) async throws -> URL {
        guard let downloadURL = result.assetDownloadURL else {
            throw AppUpdateError.noInstallableAsset
        }

        let downloadsDirectory = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: downloadsDirectory, withIntermediateDirectories: true)

        let safeName = result.assetName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? result.assetName!
            : downloadURL.lastPathComponent
        let destinationURL = downloadsDirectory.appendingPathComponent(safeName)

        let (temporaryURL, response) = try await session.download(from: downloadURL)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw AppUpdateError.downloadFailed("HTTP \(String(describing: (response as? HTTPURLResponse)?.statusCode))")
        }

        if FileManager.default.fileExists(atPath: destinationURL.path) {
            try FileManager.default.removeItem(at: destinationURL)
        }
        try FileManager.default.moveItem(at: temporaryURL, to: destinationURL)
        NSWorkspace.shared.open(destinationURL)
        return destinationURL
    }

    private func preferredInstallAsset(from assets: [GitHubReleaseAsset]) -> GitHubReleaseAsset? {
        if let dmg = assets.first(where: {
            let name = $0.name.lowercased()
            return name.hasPrefix("safarai-v") && name.hasSuffix("-macos.dmg")
        }) {
            return dmg
        }
        if let fallbackDMG = assets.first(where: { $0.name.lowercased().hasSuffix(".dmg") }) {
            return fallbackDMG
        }
        return assets.first(where: { $0.name.lowercased().hasSuffix(".zip") })
    }

    private func normalizeVersionString(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("v") {
            return String(trimmed.dropFirst())
        }
        return trimmed
    }

    private func isNewerVersion(_ candidate: String, than current: String) -> Bool {
        let left = candidate.split(separator: ".").compactMap { Int($0) }
        let right = current.split(separator: ".").compactMap { Int($0) }
        if !left.isEmpty && !right.isEmpty {
            let maxCount = max(left.count, right.count)
            for index in 0..<maxCount {
                let lhs = index < left.count ? left[index] : 0
                let rhs = index < right.count ? right[index] : 0
                if lhs != rhs {
                    return lhs > rhs
                }
            }
            return false
        }
        return candidate != current
    }
}
