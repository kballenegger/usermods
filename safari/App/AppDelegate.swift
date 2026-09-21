#if os(iOS)
import UIKit

/// The host app's entry point on iOS.
///
/// The app builds for iOS and for macOS from one target, so each platform's entry point is compiled
/// out of the other's build. The Mac half is App/MacAppDelegate.swift; only one of the two carries
/// `@main` for any given SDK.
///
/// There is no scene manifest in Info.plist on purpose: this app has exactly one screen, it never
/// shows two at once, and the window path below is the whole of its lifecycle. Adding scenes would
/// be more code for the same single view.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
#endif
