// ============================================================================
// createMcpHarness() — factory for renderer-side MCP automation harnesses.
//
// Centralizes the MCP request-handling boilerplate shared by games
// that have MCP automation:
//   - initialize / tools/list / tools/call / shutdown method dispatch
//   - downdraft.onMcpRequest wiring
//   - Error handling + logging
//
// Games provide only their tool definitions + handlers.
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
 *   serverName: "downdraft-mygame-automation",
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
    log.warn("MCP", "Host bridge or onMcpRequest not available; automation harness disabled");
    return;
  }

  downdraft.onMcpRequest(async (request) => handleRequest(request as McpRequest));
  log.info("MCP", `${serverName} registered; tools: ${tools.map((t) => t.def.name).join(", ")}`);
}

// ── Shared MCP tool helpers ──────────────────────────────────────────────────
// These utilities are used by multiple games' MCP automation harnesses.
// Games import them instead of duplicating the implementation.

/** Convert a Blob to a base64 string (without the data: prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      resolve(base64 ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Composite the WebGPU canvas screenshot with a DOM-overlay PNG into a single
 * PNG. The canvas is drawn first (bottom layer), then the overlay PNG on top.
 *
 * Browser/standalone fallback only — on the native host `downdraft.captureFrame()`
 * already returns the composited frame (game + overlay layers), so callers
 * should prefer it and only reach for this helper when no host exists.
 *
 *   1. Draw the WebGPU canvas onto an offscreen 2D canvas
 *   2. Load the overlay PNG as an ImageBitmap
 *   3. Draw the overlay ImageBitmap on top
 *   4. Export the composited canvas as PNG
 */
export async function compositeScreenshot(
  canvas: HTMLCanvasElement,
  overlayPng: ArrayBuffer,
  width: number,
  height: number,
): Promise<Blob | null> {
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext("2d");
  if (!ctx) return null;

  // Layer 1: WebGPU canvas (bottom)
  ctx.drawImage(canvas, 0, 0, width, height);

  // Layer 2: DOM overlay PNG (top)
  const overlayBlob = new Blob([overlayPng], { type: "image/png" });
  const overlayBitmap = await createImageBitmap(overlayBlob);
  ctx.drawImage(overlayBitmap, 0, 0, width, height);
  overlayBitmap.close();

  return new Promise((resolve) => {
    offscreen.toBlob((blob) => resolve(blob), "image/png");
  });
}

/** MCP result helper: wrap data as a JSON content array. */
export function jsonResult(data: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** MCP result helper: wrap an error message. */
export function errorResult(message: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }] };
}
