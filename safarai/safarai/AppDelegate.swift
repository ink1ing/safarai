//
//  AppDelegate.swift
//  safarai
//
//  Created by silas on 3/13/26.
//

import Cocoa

extension Notification.Name {
    static let assistantPanelShouldRefresh = Notification.Name("assistantPanelShouldRefresh")
}

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private var loginRequestTimer: Timer?
    private lazy var floatingPanelController = FloatingPanelController()
    private var reopenedMainWindowController: NSWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
        startLoginRequestPolling()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    @objc private func handlePendingLoginRequest() {
        guard CodexLoginRequestStore.loadPendingRequest() else {
            return
        }
        CodexLoginRequestStore.clear()
        Task {
            _ = try? await CodexOAuthService.shared.startLogin()
        }
    }

    private func startLoginRequestPolling() {
        loginRequestTimer?.invalidate()
        loginRequestTimer = Timer.scheduledTimer(
            timeInterval: 1.0,
            target: self,
            selector: #selector(handlePendingLoginRequest),
            userInfo: nil,
            repeats: true
        )
        handlePendingLoginRequest()
    }

    @objc private func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent replyEvent: NSAppleEventDescriptor) {
        guard
            let rawURL = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
            let url = URL(string: rawURL)
        else {
            return
        }

        if url.scheme == "safarai", url.host == "start-codex-login" {
            Task {
                _ = try? await CodexOAuthService.shared.startLogin()
            }
        } else if url.scheme == "safarai", url.host == "show-panel" {
            DispatchQueue.main.async {
                self.presentAssistantWindow()
            }
        }
    }

    private func presentAssistantWindow() {
        if let mainWindow = NSApp.windows.first(where: { !($0 is NSPanel) }) {
            mainWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            NotificationCenter.default.post(name: .assistantPanelShouldRefresh, object: nil)
            return
        }

        let storyboard = NSStoryboard(name: "Main", bundle: nil)
        if let windowController = storyboard.instantiateInitialController() as? NSWindowController {
            reopenedMainWindowController = windowController
            windowController.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            NotificationCenter.default.post(name: .assistantPanelShouldRefresh, object: nil)
            return
        }

        floatingPanelController.showPanel()
    }
}
