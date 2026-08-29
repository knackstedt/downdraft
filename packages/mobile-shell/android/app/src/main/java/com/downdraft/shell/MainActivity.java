package com.downdraft.shell;

import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
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
    private static final String TAG = "DowndraftShell";

    // Patched by `draft mobile` to the configured embedded server port.
    private static final int SERVER_PORT = __SERVER_PORT__;

    @Override
    protected void load() {
        // Start the embedded HTTP server BEFORE the bridge creates the WebView.
        server = new EmbeddedServer(this, SERVER_PORT);
        try {
            server.start();
            Log.i(TAG, "Embedded server started on port " + SERVER_PORT);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start embedded server", e);
        }

        // Call super.load() which creates the Bridge and loads appUrl.
        // The Bridge will set its own WebViewClient and call loadUrl(serverUrl).
        super.load();

        // After the bridge is created, replace the WebViewClient with one that
        // bypasses Capacitor's request interception for 127.0.0.1.
        //
        // Capacitor's handleProxyRequest intercepts HTML requests to inject its
        // bridge JS, but returns the response with DEFAULT headers — stripping
        // the COOP/COEP headers that the embedded server sets. Without these
        // headers, self.crossOriginIsolated is false and SharedArrayBuffer is
        // unavailable, breaking the engine's zero-copy renderer↔sim architecture.
        //
        // By returning null from shouldInterceptRequest for 127.0.0.1 requests,
        // the WebView makes direct HTTP requests to the embedded server,
        // preserving the COOP/COEP headers.
        if (bridge != null && bridge.getWebView() != null) {
            WebView webView = bridge.getWebView();
            final WebViewClient originalClient = webView.getWebViewClient();
            Log.i(TAG, "Overriding WebViewClient to bypass Capacitor interception for 127.0.0.1");

            webView.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    String host = request.getUrl().getHost();
                    String path = request.getUrl().getPath();
                    if (host != null && host.equals("127.0.0.1")) {
                        Log.d(TAG, "Bypassing interception for 127.0.0.1: " + path);
                        return null;
                    }
                    return originalClient.shouldInterceptRequest(view, request);
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return originalClient.shouldOverrideUrlLoading(view, request);
                }

                @Override
                public void onPageStarted(WebView view, String url, Bitmap favicon) {
                    Log.i(TAG, "onPageStarted: " + url);
                    originalClient.onPageStarted(view, url, favicon);
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    Log.i(TAG, "onPageFinished: " + url);
                    originalClient.onPageFinished(view, url);
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    originalClient.onReceivedError(view, request, error);
                }

                @Override
                public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                    originalClient.onReceivedHttpError(view, request, errorResponse);
                }

                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    return originalClient.onRenderProcessGone(view, detail);
                }

                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    originalClient.onPageCommitVisible(view, url);
                }
            });

            // Clear cache to prevent the WebView from using the cached response
            // from the first load (which had stripped COOP/COEP headers).
            webView.clearCache(true);

            // Reload from the embedded server with our custom WebViewClient.
            String url = "http://127.0.0.1:" + SERVER_PORT + "/index.html";
            Log.i(TAG, "Reloading from embedded server: " + url);
            webView.loadUrl(url);
        } else {
            Log.e(TAG, "Bridge or WebView is null after super.load()");
        }
    }

    @Override
    public void onDestroy() {
        if (server != null) {
            server.stop();
            server = null;
        }
        super.onDestroy();
    }
}
