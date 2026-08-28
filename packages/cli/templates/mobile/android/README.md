# Android Embedded HTTP Server — Wiring Guide

The `EmbeddedServer.java` template serves the Capacitor web assets over
`http://127.0.0.1:{{PORT}}` with COOP/COEP headers for SharedArrayBuffer
cross-origin isolation.

## Why this is needed

The Downdraft engine uses `SharedArrayBuffer` for zero-copy renderer↔sim
communication. SAB requires cross-origin isolation (COOP `same-origin` +
COEP `require-corp`) on the top-level document. Capacitor's default custom
scheme loading doesn't reliably set these headers, so we run a tiny embedded
HTTP server that does.

## Prerequisites

1. Add NanoHTTPD to `android/app/build.gradle`:

   ```gradle
   dependencies {
       implementation "org.nanohttpd:nanohttpd:2.3.1"
   }
   ```

2. Ensure `draft mobile` has copied `EmbeddedServer.java` to:
   `android/app/src/main/java/com/downdraft/embeddedserver/EmbeddedServer.java`

## Wiring in MainActivity

Edit `android/app/src/main/java/<your-package>/MainActivity.java`:

```java
package com.downdraft.yourgame;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.downdraft.embeddedserver.EmbeddedServer;

public class MainActivity extends BridgeActivity {
    private EmbeddedServer server;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Start the embedded HTTP server with COOP/COEP headers
        server = new EmbeddedServer(this, {{PORT}});
        try {
            server.start();
        } catch (Exception e) {
            e.printStackTrace();
        }

        // Load the game from the embedded server (not the default Capacitor scheme)
        // The bridge's WebView will be available after super.onCreate()
        bridge.getWebView().loadUrl("http://127.0.0.1:{{PORT}}/index.html");
    }

    @Override
    protected void onDestroy() {
        if (server != null) {
            server.stop();
        }
        super.onDestroy();
    }
}
```

## Verifying cross-origin isolation

After launching the app, check the WebView console (via Chrome Remote Debug):
- `self.crossOriginIsolated` should be `true`
- `navigator.gpu` should be defined (Android WebView 121+)
- Workers should spawn without errors

If `crossOriginIsolated` is `false`, verify the COOP/COEP headers are being
sent (check the Network tab in Chrome Remote Debug).
