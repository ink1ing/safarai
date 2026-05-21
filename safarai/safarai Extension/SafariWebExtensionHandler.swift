//
//  SafariWebExtensionHandler.swift
//  safarai Extension
//
//  Created by silas on 3/13/26.
//

import Foundation
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

        let messageType = (message as? [String: Any])?["type"] as? String ?? "unknown"
        os_log(.default, "Received native message type: %@ (profile: %@)", messageType, profile?.uuidString ?? "none")

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

    override func page(_ page: SFSafariPage, willNavigateTo url: URL?) {
        guard let absoluteURL = url?.absoluteString, !absoluteURL.isEmpty else {
            return
        }

        page.getPropertiesWithCompletionHandler { properties in
            let title = properties?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "当前页面"
            try? PanelStateWriter.updatePage(title: title, url: absoluteURL, status: "页面已同步")
        }
    }

    override func messageReceived(withName messageName: String, from page: SFSafariPage, userInfo: [String : Any]?) {
        guard messageName == "refresh-active-page-context" || messageName == "sample-active-video-frames" else {
            return
        }

        page.getPropertiesWithCompletionHandler { properties in
            let url = properties?.url?.absoluteString ?? ""
            let title = properties?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "当前页面"
            if !url.isEmpty {
                try? PanelStateWriter.updatePage(title: title, url: url, status: "页面地址已刷新")
            }
        }
        page.dispatchMessageToScript(withName: "refresh-active-page-context", userInfo: nil)
    }

    override func messageReceivedFromContainingApp(withName messageName: String, userInfo: [String : Any]?) {
        guard messageName == "refresh-active-page-context" else {
            return
        }

        SFSafariApplication.getActiveWindow { window in
            window?.getActiveTab { tab in
                tab?.getActivePage { page in
                    guard let page else {
                        return
                    }
                    page.getPropertiesWithCompletionHandler { properties in
                        let url = properties?.url?.absoluteString ?? ""
                        let title = properties?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "当前页面"
                        if !url.isEmpty {
                            try? PanelStateWriter.updatePage(title: title, url: url, status: "页面地址已刷新")
                        }
                    }
                    page.dispatchMessageToScript(withName: messageName, userInfo: nil)
                }
            }
        }
    }

}
