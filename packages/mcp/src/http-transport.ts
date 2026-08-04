// ============================================================================
// MCP HTTP Transport — HTTP server that bridges JSON-RPC requests to MCPServer
// Supports direct mode (has MCPServer instance) or proxy mode (forwards via callback for IPC)
// ============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MCPServer } from "./server";

export type McpProxyHandler = (request: {
  method: string;
  params?: Record<string, unknown>;
}) => Promise<unknown>;

export class McpHttpTransport {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number;
  private mode: "direct" | "proxy";
  private mcpServer: MCPServer | null;
  private proxyHandler: McpProxyHandler | null;
  private initialized = false;

  constructor(opts: {
    port?: number;
    mcpServer?: MCPServer;
    proxyHandler?: McpProxyHandler;
  }) {
    this.port = opts.port ?? 9876;
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
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", (err: Error) => {
        this.server = null;
        reject(err);
      });
      this.server.listen(this.port, () => {
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

  getPort(): number {
    return this.port;
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
        port: this.port,
        initialized: this.initialized,
      });
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

    // POST /mcp
    if (req.method === "POST" && req.url === "/mcp") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const msg = JSON.parse(body);
          const result = await this.handleJsonRpc(msg.method, msg.params ?? {});
          this.sendJSON(res, 200, {
            jsonrpc: "2.0",
            id: msg.id ?? 0,
            result,
          });
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
