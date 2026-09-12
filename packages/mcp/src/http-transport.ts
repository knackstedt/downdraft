// ============================================================================
// MCP HTTP Transport — HTTP server that bridges JSON-RPC requests to MCPServer
// Supports direct mode (has MCPServer instance) or proxy mode (forwards via callback for IPC)
// ============================================================================

import { createReadStream } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { sep as pathSep, resolve as resolvePath } from "node:path";
import type { MCPServer } from "./server";

export type McpProxyHandler = (request: {
  method: string;
  params?: Record<string, unknown>;
}) => Promise<unknown>;

export class McpHttpTransport {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number;
  /** Actual bound port (set after start()). Equals `port` when explicitly
   *  configured; differs when `port` was 0 (ephemeral OS-assigned port). */
  private boundPort: number | null = null;
  private mode: "direct" | "proxy";
  private mcpServer: MCPServer | null;
  private proxyHandler: McpProxyHandler | null;
  private initialized = false;
  private sessionId: string | null = null;
  private sseResponse: ServerResponse | null = null;
  /** Optional root directory for the GET /mcp/artifact/<path> download endpoint. */
  private artifactDir: string | null = null;

  constructor(opts: {
    /** Port to bind. `0` (default) = ephemeral OS-assigned port. */
    port?: number;
    mcpServer?: MCPServer;
    proxyHandler?: McpProxyHandler;
    /** Root directory for artifact downloads (GET /mcp/artifact/<path>). */
    artifactDir?: string;
  }) {
    this.port = opts.port ?? 0;
    if (opts.mcpServer) {
      this.mode = "direct";
      this.mcpServer = opts.mcpServer;
      this.proxyHandler = null;
    } else if (opts.proxyHandler) {
      this.mode = "proxy";
      this.mcpServer = null;
      this.proxyHandler = opts.proxyHandler;
    } else {
      throw new Error("McpHttpTransport requires either mcpServer or proxyHandler");
    }
    this.artifactDir = opts.artifactDir ?? null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", (err: Error) => {
        this.server = null;
        reject(err);
      });
      // Bind to loopback only — the MCP transport is for local clients
      // (Devin's stdio bridge, the e2e harness). Binding 0.0.0.0 would
      // expose the JSON-RPC endpoint to the local network.
      this.server.listen(this.port, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.boundPort = addr && typeof addr === "object" ? addr.port : this.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  /**
   * The actual bound port. After `start()` this is the OS-assigned port
   * when `port` was 0 (ephemeral); before `start()` (or after `stop()`)
   * it falls back to the configured `port`.
   */
  getPort(): number {
    return this.boundPort ?? this.port;
  }

  private setCORS(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  private sendJSON(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  /**
   * Stream a file from the artifact directory. Supports HTTP Range requests
   * for large trace files. Rejects paths that escape artifactDir.
   */
  private async handleArtifactDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.artifactDir) {
      this.sendJSON(res, 503, { error: "Artifact download not configured (no artifactDir)" });
      return;
    }
    // Decode the relative path from the URL (after /mcp/artifact/).
    const prefix = "/mcp/artifact/";
    const rawRel = decodeURIComponent(req.url!.slice(prefix.length));
    // Strip any query string.
    const relPath = rawRel.split("?")[0];
    // Resolve against artifactDir and verify the result stays inside it.
    const resolved = resolvePath(this.artifactDir, relPath);
    const root = resolvePath(this.artifactDir) + pathSep;
    if (!resolved.startsWith(root)) {
      this.sendJSON(res, 403, { error: "Path traversal rejected" });
      return;
    }

    let fileSize: number;
    try {
      const s = await statFile(resolved);
      if (!s.isFile()) {
        this.sendJSON(res, 404, { error: "Not a file" });
        return;
      }
      fileSize = s.size;
    } catch {
      this.sendJSON(res, 404, { error: "File not found" });
      return;
    }

    // Content-Type by extension.
    const lower = resolved.toLowerCase();
    let contentType = "application/octet-stream";
    if (lower.endsWith(".json")) contentType = "application/json";
    else if (lower.endsWith(".heapsnapshot")) contentType = "application/octet-stream";

    // Range support.
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        if (start >= fileSize || end >= fileSize || start > end) {
          res.writeHead(416, {
            "Content-Range": `bytes */${fileSize}`,
            "Content-Type": contentType,
          });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
        });
        createReadStream(resolved, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
    });
    createReadStream(resolved).pipe(res);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCORS(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /mcp/health
    if (req.method === "GET" && req.url === "/mcp/health") {
      this.sendJSON(res, 200, {
        status: "ok",
        mode: this.mode,
        port: this.getPort(),
        initialized: this.initialized,
      });
      return;
    }

    // GET /mcp/artifact/<path> — stream a generated trace/heap-snapshot file.
    // <path> is relative to the configured artifactDir. Path traversal is
    // rejected: the resolved path must start with artifactDir + sep.
    if (req.method === "GET" && req.url?.startsWith("/mcp/artifact/")) {
      await this.handleArtifactDownload(req, res);
      return;
    }

    // GET /mcp/tools
    if (req.method === "GET" && req.url === "/mcp/tools") {
      try {
        const tools = await this.handleJsonRpc("tools/list", {});
        this.sendJSON(res, 200, tools);
      } catch (e) {
        this.sendJSON(res, 500, { error: (e as Error).message });
      }
      return;
    }

    // GET /mcp or / — SSE stream (MCP HTTP+SSE transport)
    // The client opens an SSE connection; we send an `endpoint` event
    // telling it to POST JSON-RPC messages back to /mcp.
    if (req.method === "GET" && (req.url === "/mcp" || req.url === "/" || req.url === "/mcp/")) {
      if (!this.sessionId) this.sessionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Mcp-Session-Id": this.sessionId,
      });
      // Tell the client where to POST requests
      res.write(`event: endpoint\ndata: /mcp\n\n`);
      // Keep the connection open — the client will POST requests separately
      // and we'll stream responses back on this connection.
      // Store the response so we can write to it later.
      this.sseResponse = res;
      req.on("close", () => {
        if (this.sseResponse === res) this.sseResponse = null;
      });
      return;
    }

    // POST /mcp or POST / (root) — MCP Streamable HTTP transport
    // The MCP client POSTs JSON-RPC messages to the configured URL.
    // We accept both /mcp and / so the URL can be either
    // "http://localhost:PORT" or "http://localhost:PORT/mcp".
    if (req.method === "POST" && (req.url === "/mcp" || req.url === "/" || req.url === "/mcp/")) {
      // MCP Streamable HTTP: return session ID header on initialize
      if (!this.sessionId) this.sessionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      res.setHeader("Mcp-Session-Id", this.sessionId);

      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const msg = JSON.parse(body);
          const result = await this.handleJsonRpc(msg.method, msg.params ?? {});
          const response = { jsonrpc: "2.0" as const, id: msg.id ?? 0, result };

          // If there's an open SSE stream (HTTP+SSE transport), write the
          // response to it and respond to the POST with 202 Accepted.
          // Check writableEnded to avoid writing to a closed stream.
          if (this.sseResponse && !this.sseResponse.writableEnded && !this.sseResponse.destroyed) {
            this.sseResponse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
            res.writeHead(202);
            res.end();
            return;
          }

          // Streamable HTTP: check Accept header for SSE format
          const accept = req.headers.accept ?? "";
          if (accept.includes("text/event-stream")) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            });
            res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
            res.end();
          } else {
            this.sendJSON(res, 200, response);
          }
        } catch (e) {
          this.sendJSON(res, 400, {
            jsonrpc: "2.0",
            id: 0,
            error: { code: -32700, message: `Parse error: ${(e as Error).message}` },
          });
        }
      });
      return;
    }

    // DELETE /mcp or / — end session (MCP Streamable HTTP)
    if (req.method === "DELETE" && (req.url === "/mcp" || req.url === "/" || req.url === "/mcp/")) {
      this.initialized = false;
      this.sessionId = null;
      res.writeHead(204);
      res.end();
      return;
    }

    this.sendJSON(res, 404, { error: "Not found" });
  }

  private async handleJsonRpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "initialize") {
      this.initialized = true;
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "downdraft-mcp", version: "0.1.0" },
      };
    }

    if (!this.initialized) {
      throw new Error("Server not initialized");
    }

    if (this.mode === "direct" && this.mcpServer) {
      return this.handleDirect(method, params);
    } else if (this.mode === "proxy" && this.proxyHandler) {
      return this.proxyHandler({ method, params });
    }

    throw new Error("No handler available");
  }

  private async handleDirect(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const server = this.mcpServer!;

    switch (method) {
      case "tools/list":
        return {
          tools: server.listTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };

      case "tools/call": {
        const name = params.name as string;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        return await server.callTool(name, args);
      }

      case "resources/list":
        return {
          resources: server.listResources().map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          })),
        };

      case "resources/read": {
        const uri = params.uri as string;
        return await server.readResource(uri);
      }

      case "prompts/list":
        return {
          prompts: server.listPrompts().map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments,
          })),
        };

      case "prompts/get": {
        const name = params.name as string;
        const args = (params.arguments as Record<string, string>) ?? {};
        return await server.getPrompt(name, args);
      }

      case "shutdown":
        this.initialized = false;
        return {};

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }
}
