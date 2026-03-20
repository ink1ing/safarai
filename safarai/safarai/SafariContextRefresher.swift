import Foundation
import SafariServices

enum SafariContextRefresher {
    struct Snapshot {
        let title: String
        let url: String
    }

    static func loadFrontmostPage() async -> Snapshot? {
        await withCheckedContinuation { continuation in
            SFSafariApplication.getAllWindows { windows in
                guard let window = windows.first else {
                    continuation.resume(returning: nil)
                    return
                }

                window.getActiveTab { tab in
                    guard let tab else {
                        continuation.resume(returning: nil)
                        return
                    }

                    tab.getActivePage { page in
                        guard let page else {
                            continuation.resume(returning: nil)
                            return
                        }

                        page.getPropertiesWithCompletionHandler { properties in
                            guard
                                let properties,
                                let pageURL = properties.url?.absoluteString,
                                !pageURL.isEmpty
                            else {
                                continuation.resume(returning: nil)
                                return
                            }

                            let title = properties.title?.trimmingCharacters(in: .whitespacesAndNewlines)
                            continuation.resume(
                                returning: Snapshot(
                                    title: (title?.isEmpty == false ? title! : "当前页面"),
                                    url: pageURL
                                )
                            )
                        }
                    }
                }
            }
        }
    }
}
