import AppKit

enum WindowPlacementCoordinator {
    enum PlacementMode: String {
        case remember
        case left
        case right
    }

    static func restoreOrSnap(_ window: NSWindow, autosaveName: String, placementMode: PlacementMode) {
        window.setFrameAutosaveName(autosaveName)
        if placementMode == .remember, hasSavedFrame(for: autosaveName) {
            return
        }

        snapBesideSafari(window, preferredSide: placementMode)
    }

    static func snapBesideSafari(_ window: NSWindow, preferredSide: PlacementMode = .remember) {
        guard let safariFrame = safariWindowFrame() else {
            window.center()
            return
        }

        let screen = screenContaining(frame: safariFrame) ?? NSScreen.main
        let visibleFrame = screen?.visibleFrame ?? safariFrame
        let width = min(max(window.frame.width, 380), visibleFrame.width * 0.4)
        let height = min(max(window.frame.height, 620), visibleFrame.height)
        let attachToLeft: Bool
        switch preferredSide {
        case .left:
            attachToLeft = true
        case .right:
            attachToLeft = false
        case .remember:
            attachToLeft = safariFrame.midX >= visibleFrame.midX
        }
        let originX = attachToLeft
            ? max(visibleFrame.minX, safariFrame.minX - width - 12)
            : min(visibleFrame.maxX - width, safariFrame.maxX + 12)
        let originY = max(visibleFrame.minY, safariFrame.maxY - height)

        window.setFrame(NSRect(x: originX, y: originY, width: width, height: height), display: true)
    }

    private static func hasSavedFrame(for autosaveName: String) -> Bool {
        UserDefaults.standard.string(forKey: "NSWindow Frame \(autosaveName)") != nil
    }

    private static func screenContaining(frame: CGRect) -> NSScreen? {
        NSScreen.screens.first { screen in
            screen.frame.intersects(frame)
        }
    }

    private static func safariWindowFrame() -> CGRect? {
        guard let infoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        for item in infoList {
            guard
                let owner = item[kCGWindowOwnerName as String] as? String,
                owner == "Safari",
                let bounds = item[kCGWindowBounds as String] as? [String: CGFloat],
                let x = bounds["X"],
                let y = bounds["Y"],
                let width = bounds["Width"],
                let height = bounds["Height"],
                width > 400,
                height > 400
            else {
                continue
            }

            return CGRect(x: x, y: y, width: width, height: height)
        }

        return nil
    }
}
