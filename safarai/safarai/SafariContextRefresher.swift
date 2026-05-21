import Foundation

enum SafariContextRefresher {
    struct Snapshot {
        let title: String
        let url: String
    }

    static func loadFrontmostPage(timeout: TimeInterval = 0.7) async -> Snapshot? {
        nil
    }
}
