// ============================================================================
// Overburden — renderer-side MCP automation harness
// Minimal JSON-RPC handler wired to the main-process MCP HTTP proxy via
// the Electron preload bridge. Exposes capture_screenshot for e2e tests.
// ============================================================================

import { downdraft } from "@downdraft/app/renderer";
import type { BlockheadsRenderer } from "../renderer/blockheads-renderer";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolRegistration {
  def: ToolDef;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

interface McpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

type McpResponse = { id: number; result?: unknown; error?: { code: number; message: string } };

function errorResult(msg: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:image/png;base64," prefix
      const base64 = result.split(",")[1] ?? result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function compositeScreenshot(
  canvas: HTMLCanvasElement,
  capturePagePng: ArrayBuffer,
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

  // Layer 2: DOM overlay from webContents.capturePage() (top)
  const overlayBlob = new Blob([capturePagePng], { type: "image/png" });
  const overlayBitmap = await createImageBitmap(overlayBlob);
  ctx.drawImage(overlayBitmap, 0, 0, width, height);
  overlayBitmap.close();

  return new Promise((resolve) => {
    offscreen.toBlob((blob) => resolve(blob), "image/png");
  });
}

function createAutomationTools(ctx: {
  renderer: () => BlockheadsRenderer | null;
}): ToolRegistration[] {
  return [
    {
      def: {
        name: "capture_screenshot",
        description:
          "Capture the current frame as a PNG image. By default composites the WebGPU canvas with the DOM/React overlay. Set fullPage=false to capture only the WebGPU canvas. Returns the image inline as base64.",
        inputSchema: {
          type: "object",
          properties: {
            fullPage: {
              type: "boolean",
              default: true,
              description: "If true, composite the WebGPU canvas + DOM overlay. If false, capture only the WebGPU canvas.",
            },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const fullPage = params.fullPage === true; // default: canvas-only
        const canvas = renderer.getCanvas();
        const width = canvas.width;
        const height = canvas.height;

        if (fullPage) {
          const bridge = downdraft as unknown as { capturePage?: () => Promise<ArrayBuffer> };
          if (typeof bridge?.capturePage === "function") {
            try {
              const overlayPng = await bridge.capturePage();
              if (overlayPng && overlayPng.byteLength > 0) {
                const blob = await compositeScreenshot(canvas, overlayPng, width, height);
                if (blob) {
                  const base64 = await blobToBase64(blob);
                  return {
                    content: [
                      { type: "text", text: JSON.stringify({ width, height, fullPage: true }, null, 2) },
                      { type: "image", data: base64, mimeType: "image/png" },
                    ],
                  };
                }
              }
            } catch (e) {
              console.warn(`[MCP] Composite screenshot failed, falling back to canvas-only: ${(e as Error).message}`);
            }
          }
        }

        // Canvas-only capture via renderer.captureScreenshot() (handles on-demand rendering)
        const blob = await renderer.captureScreenshot();
        if (!blob) return errorResult("Screenshot capture failed");
        const base64 = await blobToBase64(blob);
        return {
          content: [
            { type: "text", text: JSON.stringify({ width: canvas.width, height: canvas.height, fullPage: false }, null, 2) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      },
    },
  ];
}

export function setupBlockheadsMcp(renderer: () => BlockheadsRenderer | null): void {
  const tools = createAutomationTools({ renderer });

  const handleRequest = async (req: McpRequest): Promise<McpResponse> => {
    const { id, method, params = {} } = req;
    try {
      if (method === "initialize") {
        return {
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "downdraft-overburden-automation", version: "0.1.0" },
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
        return { id, result };
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
    downdraft?.log?.("warn", "[MCP] Electron bridge or onMcpRequest not available; automation harness disabled");
    return;
  }

  downdraft.onMcpRequest(async (request) => handleRequest(request as McpRequest));
  downdraft.log("info", `[MCP] Overburden automation harness registered; tools: ${tools.map((t) => t.def.name).join(", ")}`);
}
