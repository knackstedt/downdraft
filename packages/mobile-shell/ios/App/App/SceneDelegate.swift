import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    // Patched by `draft mobile` to the configured embedded server port.
    private let serverPort: Int = __SERVER_PORT__

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        // Override the WebView URL to load from the embedded HTTP server
        // instead of the default Capacitor scheme. The embedded server
        // serves assets with COOP/COEP headers for SharedArrayBuffer
        // cross-origin isolation.
        if let bridgeVC = window?.rootViewController as? CAPBridgeViewController,
           let webView = bridgeVC.webView {
            let url = URL(string: "http://127.0.0.1:\(serverPort)/index.html")!
            webView.load(URLRequest(url: url))
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
