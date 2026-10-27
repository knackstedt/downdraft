// ============================================================================
// createMcpHarness() — factory for renderer-side MCP automation harnesses.
//
// Centralizes the MCP request-handling boilerplate shared by apps
// that have MCP automation:
//   - initialize / tools/list / tools/call / shutdown method dispatch
//   - downdraft.onMcpRequest wiring
//   - Error handling + logging
//
// Apps provide only their tool definitions + handlers.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { McpRequest, McpResponse } from "../shared/types";
import { downdraft } from "./index";

const log = createLogger();

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolRegistration {
  def: McpToolDef;
  handler: (params: Record<string, unknown>) => Promise<unknown> | unknown;
}

export type { McpRequest, McpResponse } from "../shared/types";

export interface McpHarnessOptions {
  /** Server name reported in the initialize response. */
  serverName: string;
  /** Server version reported in the initialize response. */
  serverVersion?: string;
  /** Tool definitions + handlers. */
  tools: McpToolRegistration[];
}

/**
 * Create and register an MCP automation harness.
 *
 * Wires `downdraft.onMcpRequest` to handle the standard MCP protocol
 * (initialize, tools/list, tools/call, shutdown) and dispatches tool calls
 * to the provided handlers.
 *
 * If no host bridge is installed (e.g. running standalone in a browser),
 * this is a no-op.
 *
 * @example
 * createMcpHarness({
 *   serverName: "downdraft-myapp-automation",
 *   tools: [
 *     {
 *       def: { name: "capture_screenshot", description: "...", inputSchema: {...} },
 *       handler: async (params) => { ... },
 *     },
 *   ],
 * });
 */
export function createMcpHarness(opts: McpHarnessOptions): void {
  const { serverName, serverVersion = "0.1.0", tools } = opts;

  const handleRequest = async (req: McpRequest): Promise<McpResponse> => {
    const { id, method, params = {} } = req;
    try {
      if (method === "initialize") {
        return {
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: serverName, version: serverVersion },
          },
        };
      }
      if (method === "tools/list") {
        return {
          id,
          result: {
            tools: tools.map((t) => ({
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
        const tool = tools.find((t) => t.def.name === name);
        if (!tool) {
          return { id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        const result = await tool.handler(args);
        return { id, result: result as unknown };
      }
      if (method === "shutdown") {
        return { id, result: {} };
      }
      return { id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (e) {
      return { id, error: { code: -32603, message: (e as Error).message } };
    }
  };

  if (!downdraft?.isAvailable || typeof downdraft.onMcpRequest !== "function") {
    log.warn("mcp", "Host bridge or onMcpRequest not available; automation harness disabled");
    return;
  }

  downdraft.onMcpRequest(async (request) => handleRequest(request as McpRequest));
  log.info("mcp", `${serverName} registered; tools: ${tools.map((t) => t.def.name).join(", ")}`);
}

// ── Shared MCP tool helpers ──────────────────────────────────────────────────
// These utilities are used by multiple apps' MCP automation harnesses.
// Apps import them instead of duplicating the implementation.

/** Convert a Blob to a base64 string (without the data: prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** MCP result helper: wrap data as a JSON content array. */
export function jsonResult(data: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** MCP result helper: wrap an error message. */
export function errorResult(message: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }] };
}
