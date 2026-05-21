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
        installStandardEditMenuIfNeeded()
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
        startLoginRequestPolling()
    }

    private func installStandardEditMenuIfNeeded() {
        guard let mainMenu = NSApp.mainMenu else {
            return
        }
        if mainMenu.items.contains(where: { $0.submenu?.title == "Edit" || $0.title == "Edit" }) {
            return
        }

        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu

        editMenu.addItem(
            NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        )
        let redoItem = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redoItem)
        editMenu.addItem(.separator())

        editMenu.addItem(
            NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        )
        editMenu.addItem(
            NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        )
        editMenu.addItem(
            NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        )
        editMenu.addItem(.separator())
        editMenu.addItem(
            NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        )

        let insertIndex = min(1, mainMenu.numberOfItems)
        mainMenu.insertItem(editItem, at: insertIndex)
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
