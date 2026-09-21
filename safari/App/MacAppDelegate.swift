#if os(macOS)
import AppKit

/// The host app's entry point on macOS. The iOS half is App/AppDelegate.swift.
///
/// One window, built in code, with a menu bar assembled here rather than in a nib. A nib would be
/// the Xcode default, but it is a binary file in a repository where everything else about this app
/// is readable text, and the whole menu is four items.
@main
final class MacAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    /// `NSApplication.delegate` is a weak reference, so something has to hold the delegate. In a nib
    /// app that something is the nib. Here it is this.
    private static var shared: MacAppDelegate?

    /// The entry point, written out rather than left to the one `@main` supplies for an
    /// `NSApplicationDelegate`.
    ///
    /// The supplied one goes through `NSApplicationMain`, which takes the delegate from the main
    /// nib. This app has no nib, so nothing ever became the delegate: the app launched, drew no
    /// window, and sat there with nothing anywhere to say why. These few explicit lines are worth
    /// more than the attribute that hid that.
    static func main() {
        let app = NSApplication.shared
        let delegate = MacAppDelegate()
        Self.shared = delegate
        app.delegate = delegate
        // A regular app: a Dock icon, a menu bar, and a window it can bring to the front.
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = Self.mainMenu()

        let controller = MacViewController()
        let window = NSWindow(contentViewController: controller)
        window.title = "usermods"
        window.setContentSize(NSSize(width: 520, height: 560))
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.contentMinSize = NSSize(width: 420, height: 380)
        // The screen is dark on purpose (docs/branding.md), so the titlebar has to match or the
        // window reads as two halves under the light system appearance.
        window.appearance = NSAppearance(named: .darkAqua)
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window

        NSApp.activate(ignoringOtherApps: true)
    }

    /// Closing the one window means the app is done. It holds no state worth keeping alive.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private static func mainMenu() -> NSMenu {
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Hide usermods",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit usermods",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )

        let appItem = NSMenuItem()
        appItem.submenu = appMenu

        // Without an Edit menu, the standard text shortcuts do not reach the text fields, and the
        // window has selectable copy in it.
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )
        let editItem = NSMenuItem()
        editItem.title = "Edit"
        editItem.submenu = editMenu

        let menu = NSMenu()
        menu.addItem(appItem)
        menu.addItem(editItem)
        return menu
    }
}
#endif
