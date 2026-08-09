// ============================================================================
// To The Ocean — renderer-side MCP automation harness setup
// Lightweight JSON-RPC handler wired to the main-process MCP HTTP proxy via
// the Electron preload bridge. Only registers automation tools; avoids pulling
// in the Node-only @downdraft/mcp server bundle in the renderer.
// ============================================================================

import { downdraft } from "@downdraft/app/renderer";
import type { SimWebWorker } from "../engine/sim-web-worker";
import type { WebGPURenderer } from "../engine/webgpu-renderer";
import { createAutomationTools } from "./automation-tools";
import type { ToolRegistration } from "./mcp-types";

interface McpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

type McpResponse = { id: number; result?: unknown; error?: { code: number; message: string } };

class TtolMcpHarness {
  private tools = new Map<string, ToolRegistration>();

  register(tools: ToolRegistration[]): void {
    for (const tool of tools) {
      this.tools.set(tool.def.name, tool);
    }
  }

  private async handleRequest(req: McpRequest): Promise<McpResponse> {
    const { id, method, params = {} } = req;

    try {
      if (method === "initialize") {
        // The main-process MCP transport intercepts the initialize handshake,
        // so the renderer-side harness just acknowledges it.
        return {
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "downdraft-ttol-automation", version: "0.1.0" },
          },
        };
      }

      if (method === "tools/list") {
        return {
          id,
          result: {
            tools: Array.from(this.tools.values()).map((t) => ({
              name: t.def.name,
              description: t.def.description,
              inputSchema: t.def.inputSchema,
            })),
          },
        };
      }

      if (method === "tools/call") {
        const name = params.name as string;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const tool = this.tools.get(name);
        if (!tool) {
          return { id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        const result = await tool.handler(args);
        return { id, result };
      }

      if (method === "shutdown") {
        return { id, result: {} };
      }

      return { id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (e) {
      return { id, error: { code: -32603, message: (e as Error).message } };
    }
  }

  attach(): void {
    if (!downdraft?.isAvailable || typeof downdraft.onMcpRequest !== "function") {
      downdraft?.log?.("warn", "[MCP] Electron bridge or onMcpRequest not available; automation harness disabled");
      return;
    }
    downdraft.onMcpRequest(async (request) => this.handleRequest(request));
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

let harness: TtolMcpHarness | null = null;

export function setupTtolMcp(renderer: WebGPURenderer, worker: SimWebWorker): void {
  if (harness) return;

  harness = new TtolMcpHarness();
  harness.register(createAutomationTools({
    renderer: () => renderer,
    worker: () => worker,
  }));
  harness.attach();

  (window as any).__ttolMcp = harness;
  downdraft.log("info", `[MCP] To-the-ocean automation harness registered; tools: ${harness.getToolNames().join(", ")}`);
}
