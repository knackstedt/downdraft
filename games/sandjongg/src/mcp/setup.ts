// ============================================================================
// Sandjongg — renderer-side MCP automation harness.
// Exposes capture_screenshot + match_tiles tools for e2e tests.
// ============================================================================

import { downdraft } from "@downdraft/app/renderer";
import type { SandjonggRenderer } from "../renderer/sandjongg-renderer";

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

  // Layer 2: tile canvas overlay
  const tileCanvas = document.querySelector<HTMLCanvasElement>("#sandjongg-tile-canvas");
  if (tileCanvas) {
    ctx.drawImage(tileCanvas, 0, 0, width, height);
  }

  // Layer 3: DOM overlay from webContents.capturePage() (top)
  const overlayBlob = new Blob([capturePagePng], { type: "image/png" });
  const overlayBitmap = await createImageBitmap(overlayBlob);
  ctx.drawImage(overlayBitmap, 0, 0, width, height);
  overlayBitmap.close();

  return new Promise((resolve) => {
    offscreen.toBlob((blob) => resolve(blob), "image/png");
  });
}

function createAutomationTools(ctx: {
  renderer: () => SandjonggRenderer | null;
}): ToolRegistration[] {
  return [
    {
      def: {
        name: "capture_screenshot",
        description:
          "Capture the current frame as a PNG image. Composites the WebGPU sand canvas + tile canvas + DOM overlay. Returns the image inline as base64.",
        inputSchema: {
          type: "object",
          properties: {
            fullPage: {
              type: "boolean",
              default: true,
              description: "If true, composite all layers. If false, capture only the WebGPU canvas.",
            },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const fullPage = params.fullPage !== false;
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

        // Fallback: canvas-only capture
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob((b) => resolve(b), "image/png");
        });
        if (!blob) return errorResult("Screenshot capture failed");
        const base64 = await blobToBase64(blob);
        return {
          content: [
            { type: "text", text: JSON.stringify({ width, height, fullPage: false }, null, 2) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      },
    },
    {
      def: {
        name: "match_tiles",
        description:
          "Attempt to match two tiles by their board coordinates (col, row, layer). Returns the match result including score, combo, and whether the match succeeded.",
        inputSchema: {
          type: "object",
          properties: {
            aCol: { type: "number", description: "Column of the first tile (0-indexed)" },
            aRow: { type: "number", description: "Row of the first tile (0-indexed)" },
            aLayer: { type: "number", description: "Layer of the first tile (0-indexed, default 0)", default: 0 },
            bCol: { type: "number", description: "Column of the second tile (0-indexed)" },
            bRow: { type: "number", description: "Row of the second tile (0-indexed)" },
            bLayer: { type: "number", description: "Layer of the second tile (0-indexed, default 0)", default: 0 },
          },
          required: ["aCol", "aRow", "bCol", "bRow"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not initialized");
        const aCol = params.aCol as number;
        const aRow = params.aRow as number;
        const aLayer = (params.aLayer as number) ?? 0;
        const bCol = params.bCol as number;
        const bRow = params.bRow as number;
        const bLayer = (params.bLayer as number) ?? 0;
        host.requestMatch(aCol, aRow, aLayer, bCol, bRow, bLayer);
        // Wait a moment for the worker to process the match.
        await new Promise((r) => setTimeout(r, 200));
        const stats = await host.getStats();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                requested: { aCol, aRow, aLayer, bCol, bRow, bLayer },
                score: stats?.score ?? 0,
                level: stats?.level ?? 1,
              }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "get_game_state",
        description:
          "Get the current game state: level, score, combo, tiles remaining, and board layout.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not initialized");
        const stats = await host.getStats();
        const tilePass = renderer.getTilePass();
        const cols = tilePass?.state.boardCols ?? 0;
        const rows = tilePass?.state.boardRows ?? 0;
        const layers = tilePass?.state.boardLayers ?? 1;
        const boardElements = tilePass?.state.boardElements
          ? Array.from(tilePass.state.boardElements.slice(0, cols * rows * layers))
          : [];
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                score: stats?.score ?? 0,
                level: stats?.level ?? 1,
                combo: stats?.combo ?? 0,
                tilesLeft: stats?.tilesLeft ?? 0,
                boardCols: cols,
                boardRows: rows,
                boardLayers: layers,
                boardElements,
              }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "request_hint",
        description: "Request a hint from the solver. Returns the highlighted pair if a match exists.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not initialized");
        host.requestHint();
        await new Promise((r) => setTimeout(r, 200));
        const tilePass = renderer.getTilePass();
        const hint = tilePass?.state.hint;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ hint }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "new_game",
        description: "Start a new game at the specified level.",
        inputSchema: {
          type: "object",
          properties: {
            level: { type: "number", description: "Level number to start (default: 1)" },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not initialized");
        const level = (params.level as number) ?? 1;
        host.requestNewGame(level);
        await new Promise((r) => setTimeout(r, 500));
        return {
          content: [
            { type: "text", text: JSON.stringify({ started: true, level }, null, 2) },
          ],
        };
      },
    },
    {
      def: {
        name: "debug_tile_canvas",
        description: "Capture the tile canvas directly and return info about its DOM state and pixel content.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const tileCanvas = document.querySelector<HTMLCanvasElement>("#sandjongg-tile-canvas");
        if (!tileCanvas) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "tile canvas not found in DOM" }, null, 2) }] };
        }
        const rect = tileCanvas.getBoundingClientRect();
        const style = window.getComputedStyle(tileCanvas);
        // Sample some pixels from the tile canvas to check if it has content.
        const ctx2d = tileCanvas.getContext("2d");
        let nonTransparentPixels = 0;
        let sampleColors: string[] = [];
        if (ctx2d) {
          const imageData = ctx2d.getImageData(0, 0, tileCanvas.width, tileCanvas.height);
          const data = imageData.data;
          for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
            if (data[i + 3] > 0) { // alpha > 0
              nonTransparentPixels++;
              if (sampleColors.length < 10) {
                sampleColors.push(`rgb(${data[i]},${data[i+1]},${data[i+2]},${data[i+3]})`);
              }
            }
          }
        }
        const tilePass = ctx.renderer()?.getTilePass();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                canvasW: tileCanvas.width,
                canvasH: tileCanvas.height,
                rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                style: {
                  position: style.position,
                  zIndex: style.zIndex,
                  display: style.display,
                  visibility: style.visibility,
                  opacity: style.opacity,
                  pointerEvents: style.pointerEvents,
                  width: style.width,
                  height: style.height,
                  top: style.top,
                  left: style.left,
                },
                nonTransparentPixels,
                sampleColors,
                tilePassState: tilePass ? {
                  boardCols: tilePass.state.boardCols,
                  boardRows: tilePass.state.boardRows,
                  boardElementsLen: tilePass.state.boardElements.length,
                  tilesCount: Array.from(tilePass.state.boardElements).filter(e => e >= 0).length,
                } : null,
              }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "capture_tile_canvas",
        description: "Capture the tile canvas as a PNG image.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const tileCanvas = document.querySelector<HTMLCanvasElement>("#sandjongg-tile-canvas");
        if (!tileCanvas) return errorResult("Tile canvas not found");
        const blob = await new Promise<Blob | null>((resolve) => {
          tileCanvas.toBlob((b) => resolve(b), "image/png");
        });
        if (!blob) return errorResult("Screenshot capture failed");
        const base64 = await blobToBase64(blob);
        return {
          content: [
            { type: "text", text: JSON.stringify({ width: tileCanvas.width, height: tileCanvas.height }, null, 2) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      },
    },
  ];
}

export function setupSandjonggMcp(renderer: () => SandjonggRenderer | null): void {
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
            serverInfo: { name: "downdraft-sandjongg-automation", version: "0.1.0" },
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
  downdraft.log("info", `[MCP] Sandjongg automation harness registered; tools: ${tools.map((t) => t.def.name).join(", ")}`);
}
