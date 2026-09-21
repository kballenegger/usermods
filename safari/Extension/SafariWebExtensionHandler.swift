import os.log
import SafariServices

/// The native half of the Safari web extension.
///
/// usermods is entirely web code: providers are reached with `fetch`, mods and chats live in
/// `browser.storage.local`, and nothing needs a native capability. This class exists because
/// `NSExtensionPrincipalClass` is required, and it answers rather than hangs.
///
/// It refuses instead of returning an empty success on purpose. If a future change adds a
/// `browser.runtime.sendNativeMessage` call by accident, the JavaScript side gets a named error it
/// can surface, and the reason shows up in the console, rather than a silent undefined that looks
/// like the message worked.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let log = OSLog(subsystem: "usermods", category: "native-messaging")

    func beginRequest(with context: NSExtensionContext) {
        os_log(
            .default,
            log: Self.log,
            "usermods received a native message it has no handler for; refusing it"
        )
        let response = NSExtensionItem()
        response.userInfo = [
            SFExtensionMessageKey: [
                "ok": false,
                "error": "usermods has no native messaging handler. Everything it does runs in the extension itself.",
            ]
        ]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
