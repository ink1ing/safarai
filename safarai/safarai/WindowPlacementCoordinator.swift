import AppKit

enum WindowPlacementCoordinator {
    enum PlacementMode: String {
        case remember
        case left
        case right
    }

    // MARK: - Public API

    /// 主入口：根据 placementMode 决定是恢复已存 frame 还是强制 snap。
    /// - `.remember`：有 autosave frame 就直接用，否则居中
    /// - `.left` / `.right`：每次都强制重新 snap（忽略 autosave，屏幕可能变了）
    static func restoreOrSnap(
        _ window: NSWindow,
        autosaveName: String,
        placementMode: PlacementMode,
        animated: Bool = false
    ) {
        window.setFrameAutosaveName(autosaveName)

        switch placementMode {
        case .remember:
            // 有记录就让系统自动恢复，不做任何调整
            if hasSavedFrame(for: autosaveName) { return }
            // 没有记录时居中
            window.center()

        case .left, .right:
            // 每次都强制重新计算吸附位置
            snapToSide(window, mode: placementMode, animated: animated)
        }
    }

    /// 保留的旧入口，供外部直接调用。内部委托给 snapToSide。
    static func snapBesideSafari(
        _ window: NSWindow,
        preferredSide: PlacementMode = .right,
        animated: Bool = false
    ) {
        snapToSide(window, mode: preferredSide, animated: animated)
    }

    // MARK: - Core Snap Logic

    /// 统一的吸附实现：
    /// 1. 尝试通过 CGWindowList 找到 Safari 窗口
    /// 2. 找到时，吸附到 Safari 旁边
    /// 3. 找不到时，fallback 到主屏幕边缘吸附
    private static func snapToSide(_ window: NSWindow, mode: PlacementMode, animated: Bool) {
        if let safariFrame = safariWindowFrame() {
            snapBesideSafariFrame(window, safariFrame: safariFrame, mode: mode, animated: animated)
        } else {
            snapToScreenEdge(window, mode: mode, animated: animated)
        }
    }

    /// 有 Safari 窗口时：吸附到 Safari 左侧或右侧
    private static func snapBesideSafariFrame(
        _ window: NSWindow,
        safariFrame: CGRect,
        mode: PlacementMode,
        animated: Bool
    ) {
        let screen = screenContaining(frame: safariFrame) ?? NSScreen.main
        let visibleFrame = screen?.visibleFrame ?? safariFrame
        let topEdge = min(safariFrame.maxY, visibleFrame.maxY)
        let bottomEdge = max(safariFrame.minY, visibleFrame.minY)
        let alignedHeight = max(topEdge - bottomEdge, 400)

        let width = min(max(window.frame.width, 380), visibleFrame.width * 0.4)
        let height = clamp(alignedHeight, min: 400, max: visibleFrame.height)

        let attachToLeft: Bool
        switch mode {
        case .left:
            attachToLeft = true
        case .right:
            attachToLeft = false
        case .remember:
            // Safari 在屏幕右半边时，我们吸附到它左侧；否则吸附到右侧
            attachToLeft = safariFrame.midX >= visibleFrame.midX
        }

        let gap: CGFloat = 8
        let rawOriginX = attachToLeft
            ? safariFrame.minX - width - gap
            : safariFrame.maxX + gap
        let rawOriginY = clamp(bottomEdge, min: visibleFrame.minY, max: visibleFrame.maxY - height)

        let originX = clamp(rawOriginX,
                            min: visibleFrame.minX,
                            max: visibleFrame.maxX - width)
        let originY = rawOriginY

        window.setFrame(
            NSRect(x: originX, y: originY, width: width, height: height),
            display: true,
            animate: animated
        )
    }

    /// 找不到 Safari 时的 fallback：吸附到主屏幕左/右边缘，高度铺满可用区
    private static func snapToScreenEdge(_ window: NSWindow, mode: PlacementMode, animated: Bool) {
        guard let screen = NSScreen.main else {
            window.center()
            return
        }
        let visibleFrame = screen.visibleFrame

        let width = min(420, visibleFrame.width * 0.38)
        // 高度铺满可用区
        let height = visibleFrame.height

        let originX: CGFloat
        switch mode {
        case .left, .remember:
            originX = visibleFrame.minX
        case .right:
            originX = visibleFrame.maxX - width
        }

        // Y：从可用区底部对齐
        let originY = visibleFrame.minY

        let safeX = clamp(originX, min: visibleFrame.minX, max: visibleFrame.maxX - width)
        let safeY = clamp(originY, min: visibleFrame.minY, max: visibleFrame.maxY - height)

        window.setFrame(
            NSRect(x: safeX, y: safeY, width: width, height: height),
            display: true,
            animate: animated
        )
    }

    // MARK: - Helpers

    /// 计算吸附窗口的目标宽度，在现有 frame 与最小值、可用区之间取合适值
    /// 注意：height 现在由调用方根据上下文（safariFrame 或 visibleFrame）单独计算
    private static func snapSize(window: NSWindow, visibleFrame: CGRect) -> (width: CGFloat, height: CGFloat) {
        let width  = min(max(window.frame.width, 380), visibleFrame.width * 0.4)
        let height = clamp(window.frame.height, min: 400, max: visibleFrame.height)
        return (width, height)
    }

    private static func clamp(_ value: CGFloat, min minVal: CGFloat, max maxVal: CGFloat) -> CGFloat {
        // 当屏幕极小导致 minVal > maxVal 时保护性返回 minVal
        guard minVal <= maxVal else { return minVal }
        return Swift.max(minVal, Swift.min(value, maxVal))
    }

    private static func hasSavedFrame(for autosaveName: String) -> Bool {
        UserDefaults.standard.string(forKey: "NSWindow Frame \(autosaveName)") != nil
    }

    private static func screenContaining(frame: CGRect) -> NSScreen? {
        NSScreen.screens.max {
            $0.frame.intersection(frame).area < $1.frame.intersection(frame).area
        }
    }

    /// 尝试通过 CGWindowList 获取 Safari 主窗口 frame，并转换到 AppKit 全局坐标系。
    private static func safariWindowFrame() -> CGRect? {
        guard
            let infoList = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly], kCGNullWindowID
            ) as? [[String: Any]]
        else {
            return nil
        }

        for item in infoList {
            guard
                let owner  = item[kCGWindowOwnerName as String] as? String,
                owner == "Safari",
                let bounds = item[kCGWindowBounds as String] as? [String: CGFloat],
                let x      = bounds["X"],
                let y      = bounds["Y"],
                let width  = bounds["Width"],
                let height = bounds["Height"],
                width  > 400,
                height > 400
            else { continue }

            let appKitY = appKitGlobalMaxY() - y - height
            return CGRect(x: x, y: appKitY, width: width, height: height)
        }

        return nil
    }

    private static func appKitGlobalMaxY() -> CGFloat {
        NSScreen.screens.map(\.frame.maxY).max() ?? 0
    }
}

// MARK: - CGRect helper

private extension CGRect {
    var area: CGFloat { width * height }
}
