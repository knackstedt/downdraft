// ============================================================================
// EmbeddedServer.swift — tiny HTTP server for Capacitor iOS (COOP/COEP)
// ============================================================================
//
// Serves the Capacitor web assets (dist/mobile/) over http://127.0.0.1:{{PORT}}
// with Cross-Origin-Opener-Policy: same-origin and
// Cross-Origin-Embedder-Policy: require-corp headers.
//
// This enables SharedArrayBuffer (cross-origin isolation) in the iOS WKWebView,
// which the Downdraft engine requires for zero-copy renderer↔sim communication.
//
// This implementation uses Swift's Network framework (NWListener) — no
// third-party dependencies required.
//
// Start the server in your AppDelegate or SceneDelegate:
//
//   let server = EmbeddedServer(port: {{PORT}})
//   try? server.start()
//   webView.load(URLRequest(url: URL(string: "http://127.0.0.1:{{PORT}}/index.html")!))
//
// See README.md for full wiring instructions.

import Foundation
import Network

/// Embedded HTTP server that serves Capacitor web assets with COOP/COEP headers.
///
/// Uses Swift's Network framework (NWListener) for a dependency-free TCP server.
/// Serves files from the app bundle's `public/` directory (where `npx cap copy`
/// places the web bundle).
class EmbeddedServer {
    private let port: NWEndpoint.Port
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.downdraft.embeddedserver")
    private var running = false

    init(port: Int) {
        self.port = NWEndpoint.Port(integerLiteral: UInt16(port))
    }

    /// Start listening for HTTP connections.
    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params, on: port)
        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }
        listener?.start(queue: queue)
        running = true
        print("[EmbeddedServer] Listening on http://127.0.0.1:\(port.rawValue)")
    }

    /// Stop the server.
    func stop() {
        listener?.cancel()
        listener = nil
        running = false
    }

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveRequest(connection)
    }

    private func receiveRequest(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self, let data = data, !data.isEmpty else {
                if isComplete { connection.cancel() }
                return
            }

            if let request = String(data: data, encoding: .utf8) {
                let path = self.parseRequestPath(request)
                let response = self.serveFile(path: path)
                self.sendResponse(connection, response)
            } else {
                connection.cancel()
            }
        }
    }

    /// Parse the HTTP request line to extract the path.
    private func parseRequestPath(_ request: String) -> String {
        let lines = request.components(separatedBy: "\r\n")
        guard let firstLine = lines.first else { return "/" }
        let parts = firstLine.components(separatedBy: " ")
        guard parts.count >= 2 else { return "/" }
        return parts[1]
    }

    /// Serve a file from the app bundle's `public/` directory.
    private func serveFile(path: String) -> Data {
        var cleanPath = path
        if cleanPath == "/" {
            cleanPath = "/index.html"
        }
        // Remove leading slash and prepend "public/" (Capacitor web assets dir)
        let assetPath = "public" + cleanPath

        // Try to load from the app bundle
        if let filePath = Bundle.main.path(forResource: assetPath, ofType: nil) {
            if let fileData = try? Data(contentsOf: URL(fileURLWithPath: filePath)) {
                return buildResponse(status: 200, mimeType: getMimeType(path: cleanPath), body: fileData)
            }
        }

        // 404
        let notFound = "Not found: \(cleanPath)".data(using: .utf8) ?? Data()
        return buildResponse(status: 404, mimeType: "text/plain", body: notFound)
    }

    /// Build an HTTP response with COOP/COEP headers.
    private func buildResponse(status: Int, mimeType: String, body: Data) -> Data {
        let statusText = status == 200 ? "OK" : "Not Found"
        let headers = [
            "HTTP/1.1 \(status) \(statusText)",
            "Content-Type: \(mimeType)",
            "Content-Length: \(body.count)",
            "Cross-Origin-Opener-Policy: same-origin",
            "Cross-Origin-Embedder-Policy: require-corp",
            "Cache-Control: no-cache",
            "Connection: close",
            "",
            "",
        ].joined(separator: "\r\n")

        var response = Data(headers.utf8)
        response.append(body)
        return response
    }

    /// Get MIME type from file extension.
    private func getMimeType(path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "html": return "text/html"
        case "js", "mjs": return "application/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "wgsl": return "text/wgsl"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "glb": return "model/gltf-binary"
        case "gltf": return "model/gltf+json"
        case "ktx2": return "image/ktx2"
        default: return "application/octet-stream"
        }
    }

    /// Send the HTTP response and close the connection.
    private func sendResponse(_ connection: NWConnection, _ response: Data) {
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
