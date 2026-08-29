package com.downdraft.shell;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.downdraft.embeddedserver.EmbeddedServer;

/**
 * Shell MainActivity — starts the embedded HTTP server (COOP/COEP for
 * SharedArrayBuffer) before the Capacitor bridge loads the WebView.
 *
 * The server serves web assets from http://127.0.0.1:SERVER_PORT with
 * Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers,
 * enabling cross-origin isolation required by the Downdraft engine's
 * zero-copy renderer↔sim SharedArrayBuffer architecture.
 *
 * `draft mobile` patches SERVER_PORT to the configured port and
 * applicationId to the game's package ID at build-scaffold time.
 */
public class MainActivity extends BridgeActivity {

    private EmbeddedServer server;

    // Patched by `draft mobile` to the configured embedded server port.
    private static final int SERVER_PORT = __SERVER_PORT__;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Start the embedded HTTP server BEFORE the bridge loads the WebView.
        // The server must be running before loadUrl() so the WebView can
        // immediately fetch index.html with COOP/COEP headers.
        server = new EmbeddedServer(this, SERVER_PORT);
        try {
            server.start();
            Log.i("DowndraftShell", "Embedded server started on port " + SERVER_PORT);
        } catch (Exception e) {
            Log.e("DowndraftShell", "Failed to start embedded server", e);
        }

        super.onCreate(savedInstanceState);

        // Override the WebView URL to load from the embedded server instead
        // of the default Capacitor scheme. The bridge's WebView is available
        // after super.onCreate().
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().loadUrl("http://127.0.0.1:" + SERVER_PORT + "/index.html");
        }
    }

    @Override
    protected void onDestroy() {
        if (server != null) {
            server.stop();
            server = null;
        }
        super.onDestroy();
    }
}
