//
//  SafariWebExtensionHandler.swift
//  safarai Extension
//
//  Created by silas on 3/13/26.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: SFSafariExtensionHandler {

    override func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)", String(describing: message), profile?.uuidString ?? "none")

        DispatchQueue.global(qos: .userInitiated).async {
            let responsePayload = NativeRouter.route(message: message)
            let response = NSExtensionItem()
            if #available(iOS 15.0, macOS 11.0, *) {
                response.userInfo = [SFExtensionMessageKey: responsePayload]
            } else {
                response.userInfo = ["message": responsePayload]
            }

            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }

    override func messageReceivedFromContainingApp(withName messageName: String, userInfo: [String : Any]? = nil) {
        if messageName == "sync-active-tab" {
            // Pull the current tab's URL/title and update the shared state file.
            // ViewController's 1-second timer will pick up the change and re-render.
            SFSafariApplication.getActiveWindow { window in
                guard let window else { return }
                window.getActiveTab { tab in
                    guard let tab else { return }
                    tab.getActivePage { page in
                        guard let page else { return }
                        page.getPropertiesWithCompletionHandler { properties in
                            guard let url = properties?.url?.absoluteString, !url.isEmpty else { return }
                            let title = properties?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                            try? PanelStateWriter.updatePage(title: title, url: url)
                        }
                    }
                }
            }
            return
        }

        guard messageName == "refresh-active-page" else {
            return
        }

        SFSafariApplication.getActiveWindow { window in
            guard let window else { return }
            window.getActiveTab { tab in
                guard let tab else {
                    return
                }

                tab.getActivePage { page in
                    guard let page else {
                        return
                    }

                    page.getPropertiesWithCompletionHandler { properties in
                        guard
                            let properties,
                            let url = properties.url?.absoluteString,
                            !url.isEmpty
                        else {
                            return
                        }

                        let title = properties.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "当前页面"
                        try? PanelStateWriter.updatePage(title: title, url: url, status: "页面已刷新")
                    }
                }
            }
        }
    }

    override func page(_ page: SFSafariPage, willNavigateTo url: URL?) {
        guard let absoluteURL = url?.absoluteString, !absoluteURL.isEmpty else {
            return
        }

        page.getPropertiesWithCompletionHandler { properties in
            let title = properties?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "当前页面"
            try? PanelStateWriter.updatePage(title: title, url: absoluteURL, status: "页面已同步")
        }
    }

}
