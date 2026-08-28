# iOS Embedded HTTP Server — Wiring Guide

The `EmbeddedServer.swift` template serves the Capacitor web assets over
`http://127.0.0.1:{{PORT}}` with COOP/COEP headers for SharedArrayBuffer
cross-origin isolation.

## Why this is needed

The Downdraft engine uses `SharedArrayBuffer` for zero-copy renderer↔sim
communication. SAB requires cross-origin isolation (COOP `same-origin` +
COEP `require-corp`) on the top-level document. Capacitor's default custom
scheme loading (`capacitor://localhost`) doesn't reliably set these headers
on iOS WKWebView, so we run a tiny embedded HTTP server that does.

## Prerequisites

- iOS 26+ / iPadOS 26+ (WKWebView WebGPU requires iOS 26, NOT iOS 18)
- Xcode 16+
- Ensure `draft mobile` has copied `EmbeddedServer.swift` to `ios/App/`

## Wiring in AppDelegate

Edit `ios/App/App/AppDelegate.swift`:

```swift
import UIKit
import Capacitor

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var embeddedServer: EmbeddedServer?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Start the embedded HTTP server with COOP/COEP headers
        embeddedServer = EmbeddedServer(port: {{PORT}})
        try? embeddedServer?.start()

        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
```

Then in `ios/App/App/SceneDelegate.swift`, override the WebView URL:

```swift
import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: windowScene)

        // Create the Capacitor bridge
        let capacitor = CAPBridgeApplication.sharedInstance()
        capacitor?.start()

        // Load from the embedded HTTP server (not the default capacitor:// scheme)
        if let webView = capacitor?.bridge?.webView {
            let url = URL(string: "http://127.0.0.1:{{PORT}}/index.html")!
            webView.load(URLRequest(url: url))
        }
    }
}
```

> **Note:** The exact wiring depends on your Capacitor version's app delegate
> structure. The key point is: start the `EmbeddedServer` early in app launch,
> then load `http://127.0.0.1:{{PORT}}/index.html` in the WKWebView instead of
> the default Capacitor scheme.

## App Transport Security (ATS)

Add an ATS exception for `127.0.0.1` in `ios/App/App/Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSExceptionDomains</key>
    <dict>
        <key>127.0.0.1</key>
        <dict>
            <key>NSExceptionAllowsInsecureHTTPLoads</key>
            <true/>
            <key>NSIncludesSubdomains</key>
            <false/>
        </dict>
    </dict>
</dict>
```

## Verifying cross-origin isolation

After launching the app, check the WKWebView console (via Safari Web Inspector):
- `self.crossOriginIsolated` should be `true`
- `navigator.gpu` should be defined (iOS 26+ only)
- Workers should spawn without errors

If `crossOriginIsolated` is `false`, verify the COOP/COEP headers are being
sent (check the Network tab in Safari Web Inspector).

## Important: iOS 26+ requirement

WebGPU in WKWebView requires **iOS 26 / iPadOS 26 (Tahoe)** or later.
Safari-the-browser got WebGPU at iOS 18, but the WKWebView component that
Capacitor uses only enabled it at iOS 26. Older iOS devices cannot run
Downdraft games via this path.
