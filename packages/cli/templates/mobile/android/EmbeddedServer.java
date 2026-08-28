// ============================================================================
// EmbeddedServer.java — tiny HTTP server for Capacitor Android (COOP/COEP)
// ============================================================================
//
// Serves the Capacitor web assets (dist/mobile/) over http://127.0.0.1:{{PORT}}
// with Cross-Origin-Opener-Policy: same-origin and
// Cross-Origin-Embedder-Policy: require-corp headers.
//
// This enables SharedArrayBuffer (cross-origin isolation) in the Android
// System WebView, which the Downdraft engine requires for zero-copy
// renderer↔sim communication.
//
// NanoHTTPD is a tiny single-file Java HTTP server. Add it to your
// app/build.gradle dependencies:
//
//   implementation("org.nanohttpd:nanohttpd:2.3.1")
//
// Then start the server in your MainActivity.onCreate():
//
//   EmbeddedServer server = new EmbeddedServer(this, {{PORT}});
//   server.start();
//   webView.loadUrl("http://127.0.0.1:{{PORT}}/index.html");
//
// See README.md for full wiring instructions.

package com.downdraft.embeddedserver;

import android.content.Context;
import android.content.res.AssetManager;
import fi.iki.elonen.NanoHTTPD;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Embedded HTTP server that serves Capacitor web assets with COOP/COEP headers.
 *
 * The assets are served from the app's assets directory (capacitor.assets/
 * by default, which is where `npx cap copy` places the web bundle).
 */
public class EmbeddedServer extends NanoHTTPD {

    private final Context context;
    private final AssetManager assetManager;
    private static final String ASSET_BASE = "public"; // Capacitor web assets dir

    // MIME type map for common web asset types
    private static final Map<String, String> MIME_TYPES = new HashMap<>();
    static {
        MIME_TYPES.put(".html", "text/html");
        MIME_TYPES.put(".js", "application/javascript");
        MIME_TYPES.put(".mjs", "application/javascript");
        MIME_TYPES.put(".css", "text/css");
        MIME_TYPES.put(".json", "application/json");
        MIME_TYPES.put(".wasm", "application/wasm");
        MIME_TYPES.put(".wgsl", "text/wgsl");
        MIME_TYPES.put(".png", "image/png");
        MIME_TYPES.put(".jpg", "image/jpeg");
        MIME_TYPES.put(".jpeg", "image/jpeg");
        MIME_TYPES.put(".svg", "image/svg+xml");
        MIME_TYPES.put(".ico", "image/x-icon");
        MIME_TYPES.put(".woff", "font/woff");
        MIME_TYPES.put(".woff2", "font/woff2");
        MIME_TYPES.put(".ttf", "font/ttf");
        MIME_TYPES.put(".glb", "model/gltf-binary");
        MIME_TYPES.put(".gltf", "model/gltf+json");
        MIME_TYPES.put(".ktx2", "image/ktx2");
    }

    public EmbeddedServer(Context context, int port) {
        super("127.0.0.1", port);
        this.context = context;
        this.assetManager = context.getAssets();
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        if (uri.equals("/")) {
            uri = "/index.html";
        }

        // Remove leading slash
        String assetPath = ASSET_BASE + uri;

        try {
            InputStream is = assetManager.open(assetPath);
            byte[] data = readAllBytes(is);
            is.close();

            String mimeType = getMimeType(uri);
            Response response = newFixedLengthResponse(Response.Status.OK, mimeType, new String(data));

            // COOP/COEP headers for SharedArrayBuffer cross-origin isolation
            response.addHeader("Cross-Origin-Opener-Policy", "same-origin");
            response.addHeader("Cross-Origin-Embedder-Policy", "require-corp");

            // Don't cache during development; allow caching in production
            response.addHeader("Cache-Control", "no-cache");

            return response;
        } catch (IOException e) {
            // Asset not found — return 404
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found: " + uri);
        }
    }

    private String getMimeType(String path) {
        int dotIdx = path.lastIndexOf('.');
        if (dotIdx >= 0) {
            String ext = path.substring(dotIdx).toLowerCase();
            String mime = MIME_TYPES.get(ext);
            if (mime != null) return mime;
        }
        return "application/octet-stream";
    }

    private byte[] readAllBytes(InputStream is) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[16384];
        int bytesRead;
        while ((bytesRead = is.read(chunk)) != -1) {
            buffer.write(chunk, 0, bytesRead);
        }
        return buffer.toByteArray();
    }
}
