#if os(iOS)
import UIKit

/// The host app's entry point on iOS.
///
/// The app builds for iOS and for macOS from one target, so each platform's entry point is compiled
/// out of the other's build. The Mac half is App/MacAppDelegate.swift; only one of the two carries
/// `@main` for any given SDK.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {}

/// Owns the window. This app has one screen and never shows two at once, so it declares a single
/// scene (UIApplicationSupportsMultipleScenes is false in Info.plist), and the manifest is not
/// optional: without one UIKit traps during launch on newer systems, before any of this code runs.
/// See "Scene lifecycle" in docs/safari.md for what that looked like and what catches it.
///
/// Named by UISceneDelegateClassName in App/Info.plist, module prefix included.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
#endif
