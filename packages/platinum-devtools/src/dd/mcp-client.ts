// ============================================================================
// mcp-client.ts — client for a downdraft app's MCP HTTP transport.
//
// POST http://127.0.0.1:<port>/mcp {jsonrpc:"2.0", id, method, params}
// Auth: Bearer <token> from ~/.downdraft/port/<pid>.token (when required).
// Health: GET /mcp/health.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpClient {
  private nextId = 1;
  tools: McpToolDef[] = [];
  serverInfo: { name?: string; version?: string } = {};

  constructor(
    private port: number,
    private token: string | null = null,
  ) {}

  private url(path = "/mcp"): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.url("/mcp/health"));
      return res.ok;
    } catch {
      return false;
    }
  }

  async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const res = await fetch(this.url(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok) throw new Error(`mcp http ${res.status}`);
    const body = await res.json() as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "mcp error");
    return body.result as T;
  }

  async initialize(): Promise<void> {
    const res = await this.rpc<{ serverInfo?: { name?: string; version?: string } }>("initialize");
    this.serverInfo = res.serverInfo ?? {};
    try {
      const list = await this.rpc<{ tools?: McpToolDef[] }>("tools/list");
      this.tools = list.tools ?? [];
    } catch (e) {
      log.warn("mcp-client", `tools/list failed: ${(e as Error).message}`);
    }
  }

  hasTool(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  /** Call a tool; returns the parsed tool result content. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.rpc<{ content?: { type: string; text?: string; data?: string }[] }>(
      "tools/call", { name, arguments: args });
    // Standard MCP result envelope: {content:[{type:"text",text}]} — text is
    // usually JSON; unwrap generously.
    const text = res?.content?.find((c) => c.type === "text")?.text;
    if (text !== undefined) {
      try { return JSON.parse(text) as T; } catch { return text as T; }
    }
    return res as T;
  }
}
